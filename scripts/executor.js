/**
 * Executor service (issue #407): executes a serialized planner plan step by
 * step — movement, attack/test rolls and the end-of-turn handoff — with
 * snapshot validation before every state-changing step, at most one replan
 * and operation-id idempotency.
 *
 * Design contract (epic #363, issues #398/#400/#403):
 * - Only the elected controller executes: `api.services.get("authority")
 *   ?.isController?.() ?? game.user.isGM`. Non-controller calls return
 *   `not-controller` and never touch documents.
 * - Steps `{type:"move"|"attack"|"test"|"end-turn"}` run sequentially.
 *   `move` uses `TokenDocument#move` (Foundry 13+) with the serialized
 *   planRoute waypoints from the plan — the path is never recomputed —
 *   falling back to `TokenDocument#update({x, y})`. `attack`/`test` go
 *   through `game.darkHeresy.api.rolls` (system PR #440): `prepareAttack`
 *   + `executeAttack(prepared, {operationId})`. Missing system API stops
 *   safely with `system-api-missing`.
 * - `planner.validateSnapshot(plan)` runs before every state-changing
 *   step; invalid snapshots stop execution or trigger the single replan
 *   granted by `planner.shouldReplan(failure)`. A manual token move, a
 *   deleted target or externally spent resources surface through the same
 *   check (`token-moved`/`target-gone`/`resources-changed`).
 * - Each execution is keyed by `operationId` (the authority operation id
 *   when available). Repeating `executePlan`/`runPlan` with the same
 *   operation id returns the previous result; roll steps proxy a
 *   step-scoped operation id into the system API which deduplicates on
 *   its side; a move step whose endpoint is already reached is skipped.
 * - Terminal statuses (`completed`, `partial`, `failed`) close the
 *   authority operation via `operations.completeTurn` and advance the
 *   combat turn exactly once — through the `only-war-ai.operationCompleted`
 *   hook (#400) when the operations service emits it, or via a direct
 *   `combat.nextTurn()` fallback. `cancelled` and `preview` write nothing.
 * - Preview mode emits `only-war-ai.previewRequested` (issue #409) with the
 *   serialized plan so the GM preview dialog can confirm/cancel/replan.
 */
import { MODULE_ID } from "./constants.js";
import { resolveEffectiveConfig } from "./config-resolver.js";
import { STALE_REASONS } from "./planner.js";
import { isModuleEnabled } from "./module-state.js";
import {
    getExecutionMode,
    getTurnPacingMs,
    isDiagnosticsEnabled,
    logDiagnostics
} from "./settings.js";

/** Terminal/interim statuses of an execution result. */
export const EXECUTOR_STATUS = Object.freeze({
    completed: "completed",
    partial: "partial",
    failed: "failed",
    cancelled: "cancelled",
    preview: "preview"
});

/** Stable reason codes produced by the executor itself. */
export const EXECUTOR_REASONS = Object.freeze({
    notController: "not-controller",
    controllerChanged: "controller-changed",
    configDisabled: "config-disabled",
    moduleDisabled: "module-disabled",
    previewMode: "preview-mode",
    systemApiMissing: "system-api-missing",
    noPlanner: "no-planner",
    noCombatant: "no-combatant",
    planFailed: "plan-failed",
    moveFailed: "move-failed",
    rollFailed: "roll-failed",
    invalidStep: "invalid-step",
    alreadyAtEndpoint: "already-at-endpoint",
    actionBudgetSpent: "action-budget-spent"
});

/** Step types that spend irreversible resources through the system API. */
const IRREVERSIBLE_STEP_TYPES = Object.freeze(new Set(["attack", "test"]));

/** System roll API entry points per step type (system PR #440). */
const ROLL_API = Object.freeze({
    attack: Object.freeze({ prepare: "prepareAttack", execute: "executeAttack" }),
    test: Object.freeze({ prepare: "prepareTest", execute: "executeTest" })
});

/** Step statuses recorded inside {@link ExecutionResult.stepsDone}. */
export const STEP_STATUS = Object.freeze({
    done: "done",
    skipped: "skipped",
    failed: "failed"
});

/** Settle windows checked after each turn advance (cumulative ~4.5 s). */
const ADVANCE_VERIFY_WINDOWS = Object.freeze([600, 1200, 2400]);

/** Retry budget for a silently reverted turn advance. */
const ADVANCE_VERIFY_RETRIES = 2;

/**
 * Sleep helper for the advance-verification window.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function _sleep(ms) {
    return new Promise(resolve => {
        globalThis.setTimeout(resolve, ms);
    });
}

/**
 * Normalize a Foundry collection/Map/array into a plain array.
 * @param {*} collection
 * @returns {object[]}
 */
function _list(collection) {
    if (!collection) return [];
    if (Array.isArray(collection)) return collection;
    if (Array.isArray(collection.contents)) return collection.contents;
    if (typeof collection.values === "function") return [...collection.values()];
    if (typeof collection[Symbol.iterator] === "function") return [...collection];
    return [];
}

/**
 * Unwrap a Token placeable to its TokenDocument; documents pass through.
 * @param {*} token
 * @returns {object|null}
 */
function _tokenDoc(token) {
    if (!token || typeof token !== "object") return null;
    const doc = token.document;
    if (doc && typeof doc === "object" && doc.documentName === "Token") return doc;
    return token;
}

/**
 * Find a combatant of the combat by its own id.
 * @param {object} combat
 * @param {string|null} combatantId
 * @returns {object|null}
 */
function _findCombatant(combat, combatantId) {
    if (!combatantId) return null;
    const collection = combat?.combatants;
    if (collection && typeof collection.get === "function") {
        const hit = collection.get(combatantId);
        if (hit) return hit;
    }
    for (const entry of _list(collection)) {
        if (entry?.id === combatantId) return entry;
    }
    return null;
}

/**
 * Numeric helper: value when finite, otherwise fallback.
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function _finiteOr(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}

/**
 * Merge a resource-delta object into the ledger: numeric fields add up,
 * everything else is stored as the latest value.
 * @param {object} ledger
 * @param {object|null} delta
 */
function _mergeDelta(ledger, delta) {
    if (!delta || typeof delta !== "object") return;
    for (const [key, value] of Object.entries(delta)) {
        if (Number.isFinite(value) && Number.isFinite(ledger[key])) {
            ledger[key] += value;
        } else if (Number.isFinite(value)) {
            ledger[key] = value;
        } else {
            ledger[key] = value;
        }
    }
}

/**
 * Create the `executor` service published as `api.services.get("executor")`.
 * Sibling services (`authority`, `planner`, `operations`) are resolved
 * lazily through the registry or injected via `context`, so the executor
 * degrades safely when the stacked branches are absent.
 * @param {object} [deps]
 * @param {object} [deps.api] Module API for lazy service lookups.
 * @param {Function} [deps.resolveConfig] Effective-config resolver.
 * @param {Function} [deps.isEnabled] Module-enabled predicate
 *   (compatibility + master switch).
 * @param {Function} [deps.getMode] `() => "automatic"|"preview"`.
 * @param {object} [deps.hooks] Hooks implementation (`on`/`callAll`).
 * @param {Function} [deps.idGen] Operation id fallback generator.
 * @param {Function} [deps.diagnostics] Diagnostics-enabled predicate.
 * @param {Function} [deps.log] Diagnostic logger.
 * @param {Function} [deps.pacing] Step/turn pacing delay getter (ms).
 * @returns {object} Executor service.
 */
export function createExecutorService({
    api = null,
    resolveConfig = resolveEffectiveConfig,
    isEnabled = isModuleEnabled,
    getMode = getExecutionMode,
    hooks = globalThis.Hooks ?? null,
    idGen = null,
    diagnostics = isDiagnosticsEnabled,
    log = (...args) => logDiagnostics(...args),
    pacing = getTurnPacingMs
} = {}) {
    /** Operation id → {promise, hookAdvanced}: dedup of repeated executions. */
    const executions = new Map();
    let hookSubscribed = false;

    const _idGen = typeof idGen === "function"
        ? idGen
        : () => globalThis.foundry?.utils?.randomID?.()
            ?? `op-${Math.random().toString(36).slice(2, 12)}`;

    /**
     * Lazy service lookup: `context[name]` first, then the registry.
     * @param {string} name
     * @param {*} override Injected service (undefined = registry).
     * @returns {object|null}
     */
    function _service(name, override) {
        if (override !== undefined) return override;
        try {
            return api?.services?.get?.(name) ?? null;
        } catch(err) {
            return null;
        }
    }

    /**
     * Whether this client may write AI state. The authority service (#400)
     * wins when it can answer; otherwise any GM client may execute.
     * @param {object} [context]
     * @returns {boolean}
     */
    function _isController(context = {}) {
        const authority = _service("authority", context.authority);
        const verdict = authority?.isController?.();
        if (typeof verdict === "boolean") return verdict;
        return globalThis.game?.user?.isGM === true;
    }

    /**
     * Subscribe to the operation-completed hook once (#400): a terminal
     * operation advances the combat turn exactly once. Results carrying
     * `advanceTurn: false` (e.g. config-disabled refusals) are skipped so a
     * GM keeps manual control of the turn.
     */
    function _subscribeHook() {
        if (hookSubscribed || typeof hooks?.on !== "function") return;
        hookSubscribed = true;
        hooks.on(`${MODULE_ID}.operationCompleted`, (combat, operation) => {
            try {
                const record = operation?.id ? executions.get(operation.id) : null;
                if (record) record.hookAdvanced = true;
                if (operation?.result?.advanceTurn === false) return;
                if (combat?.ended === true) return;
                if (!_isController({}) || typeof combat?.nextTurn !== "function") return;
                _advanceForOperation(combat, operation, {});
            } catch(err) {
                console.error(`${MODULE_ID} | operationCompleted handler failed`, err);
            }
        });
    }
    _subscribeHook();

    /**
     * Resolve the operation id for this execution.
     * @param {object} context
     * @returns {string}
     */
    function _operationId(context) {
        return context.operation?.id ?? context.operationId ?? _idGen();
    }

    /**
     * Resolve the combatant under execution.
     * @param {object} context
     * @param {object|null} combat
     * @returns {object|null}
     */
    function _combatantOf(context, combat) {
        if (context.combatant) return context.combatant;
        if (combat?.combatant) return combat.combatant;
        const wanted = context.operation?.combatantId ?? context.combatantId ?? null;
        return _findCombatant(combat, wanted);
    }

    /**
     * Planner service (registry or injected).
     * @param {object} context
     * @returns {object|null}
     */
    function _planner(context) {
        return _service("planner", context.planner);
    }

    /**
     * Operations service: injected `context.operations`, then the authority
     * service, then a directly registered `operations` service.
     * @param {object} context
     * @returns {object|null}
     */
    function _operations(context) {
        if (context.operations) return context.operations;
        const authority = _service("authority", context.authority);
        return authority?.operations ?? _service("operations") ?? null;
    }

    /**
     * System rolls API (`game.darkHeresy.api.rolls`) or injected override.
     * @param {object} context
     * @returns {object|null}
     */
    function _rolls(context) {
        return context.rolls ?? globalThis.game?.darkHeresy?.api?.rolls ?? null;
    }

    /**
     * Planner context forwarded to `planTurn` for planning and replanning.
     * @param {object} context
     * @param {object|null} operation
     * @param {number} replanCount
     * @param {object|null} [run] Shared execution state (config source).
     * @returns {object}
     */
    function _planContext(context, operation, replanCount, run = null) {
        return {
            ...(context.planContext ?? {}),
            operation: operation ?? context.operation ?? null,
            operationId: context.operationId ?? operation?.id ?? null,
            replanCount,
            includeNeutral: (run?.config ?? resolveConfig(run?.combatant ?? context.combatant))?.includeNeutral === true
        };
    }

    /**
     * Plan-time self position of the active plan's snapshot.
     * @param {object|null} plan
     * @returns {{x: number, y: number}|null}
     */
    function _selfPosition(plan) {
        const self = plan?.snapshot?.self;
        return self && Number.isFinite(self.x) && Number.isFinite(self.y)
            ? { x: self.x, y: self.y }
            : null;
    }

    /**
     * Pre-step snapshot validation via the planner. The self-position check
     * is split in two: the executor first compares the live token position
     * with the *expected* position (the plan-time spot or the endpoint of
     * its own last move — a drift means manual intervention, `token-moved`),
     * then calls `planner.validateSnapshot` with a token view pinned to the
     * plan-time position so the stale fingerprint fast-path still applies.
     * Every other snapshot field (turn, target, resources, collision,
     * hidden, elevation, defeated) is checked against live data as usual.
     * Without a planner the check degrades to "valid".
     * @param {object} run Shared execution state.
     * @param {object} context
     * @returns {{valid: boolean, reason: string|null}}
     */
    function _validate(run, context) {
        const plan = run.plan;
        const combatant = _combatantOf(context, context.combat);
        const tokenDoc = _tokenDoc(context.token ?? combatant?.token);
        const expected = run.expectedPosition ?? _selfPosition(plan);
        // _source carries the applied position; doc.x lags behind while
        // the placeable finishes its movement animation.
        const liveX = tokenDoc?._source?.x ?? tokenDoc?.x;
        const liveY = tokenDoc?._source?.y ?? tokenDoc?.y;
        // Hex grids snap the stored position to the cell — a fractional
        // plan endpoint lands <0.5px off; a manual drag is at least a
        // full cell, so a sub-pixel tolerance keeps token-moved real.
        if (tokenDoc && expected
            && (Math.abs(liveX - expected.x) >= 0.5 || Math.abs(liveY - expected.y) >= 0.5)) {
            return { valid: false, reason: STALE_REASONS.tokenMoved };
        }
        const planner = _planner(context);
        if (typeof planner?.validateSnapshot !== "function") {
            return { valid: true, reason: null };
        }
        try {
            const self = plan?.snapshot?.self;
            // Spreading a Document drops prototype getters (id,
            // documentName) — restore them plus a patched _source so the
            // snapshot fingerprint keeps matching.
            const tokenView = tokenDoc && self && Number.isFinite(self.x)
                ? {
                    ...tokenDoc,
                    _source: { ...tokenDoc._source, x: self.x, y: self.y },
                    x: self.x,
                    y: self.y,
                    id: tokenDoc.id,
                    documentName: tokenDoc.documentName
                }
                : tokenDoc;
            return planner.validateSnapshot(plan, {
                combat: context.combat ?? null,
                combatant,
                token: tokenView,
                scene: context.scene,
                ...(context.validation ?? {})
            });
        } catch(err) {
            return { valid: false, reason: STALE_REASONS.stale };
        }
    }

    /**
     * Waypoint payload for `TokenDocument#move` (Foundry 13+): the
     * serialized navigation `planRoute` waypoints stored in the plan,
     * normalized to `{x, y, elevation?}` with the step endpoint appended.
     * The path itself is never recomputed here.
     * @param {object} step Move step.
     * @param {{x: number, y: number}} to Destination.
     * @returns {object[]}
     */
    function _movePayload(step, to) {
        const raw = Array.isArray(step?.input?.waypoints) ? step.input.waypoints : [];
        const points = raw
            .filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))
            .map(point => ({
                x: point.x,
                y: point.y,
                ...(Number.isFinite(point.elevation) ? { elevation: point.elevation } : {})
            }));
        const last = points[points.length - 1];
        if (!last || last.x !== to.x || last.y !== to.y) {
            points.push({ x: to.x, y: to.y });
        }
        return points;
    }

    /**
     * Execute a `move` step: idempotent when the token already sits on the
     * endpoint; uses `TokenDocument#move` (v13+) or an `update({x, y})`
     * fallback.
     * @param {object} step
     * @param {object} context
     * @param {object} combatant
     * @returns {Promise<object>} Step outcome.
     */
    async function _stepMove(step, context, combatant) {
        const tokenDoc = _tokenDoc(context.token ?? combatant?.token);
        if (!tokenDoc || tokenDoc.destroyed === true) {
            return { ok: false, reason: STALE_REASONS.tokenMoved };
        }
        const to = step?.input?.to ?? step?.input?.destination ?? null;
        if (!Number.isFinite(to?.x) || !Number.isFinite(to?.y)) {
            return { ok: false, reason: EXECUTOR_REASONS.invalidStep };
        }
        // Hex grids snap the token to the cell — the plan's fractional `to`
        // and the stored integer position differ by <0.5px.
        const curX = tokenDoc._source?.x ?? tokenDoc.x;
        const curY = tokenDoc._source?.y ?? tokenDoc.y;
        if (Math.abs(curX - to.x) < 0.5 && Math.abs(curY - to.y) < 0.5) {
            return {
                ok: true,
                skipped: true,
                reason: EXECUTOR_REASONS.alreadyAtEndpoint,
                position: { x: to.x, y: to.y }
            };
        }
        try {
            if (typeof tokenDoc.move === "function") {
                const moved = await tokenDoc.move(_movePayload(step, to), {
                    method: "api",
                    showRuler: false
                });
                if (moved === false) return { ok: false, reason: EXECUTOR_REASONS.moveFailed };
            } else if (typeof tokenDoc.update === "function") {
                await tokenDoc.update({ x: to.x, y: to.y });
            } else {
                return { ok: false, reason: EXECUTOR_REASONS.moveFailed };
            }
        } catch(err) {
            return {
                ok: false,
                reason: EXECUTOR_REASONS.moveFailed,
                error: String(err?.message ?? err)
            };
        }
        return {
            ok: true,
            position: { x: to.x, y: to.y, elevation: to.elevation },
            delta: step?.projectedResourceDelta ?? {}
        };
    }

    /**
     * Input for `prepareAttack`/`prepareTest`: the serialized step input
     * enriched with actor/token references and traceability flags. Extra
     * keys are ignored by the system API.
     * @param {object} step
     * @param {object} plan Active plan.
     * @param {string} operationId
     * @returns {object}
     */
    function _rollInput(step, plan, operationId) {
        const input = { ...(step?.input ?? {}) };
        // Steps serialize `itemUuid`; the rolls API expects `weaponId` —
        // an owned item id or UUID both resolve through `_findActorItem`.
        input.weaponId = input.weaponId ?? input.weaponItemId ?? input.itemUuid ?? null;
        input.actorUuid = input.actorUuid ?? plan?.actorUuid ?? plan?.snapshot?.self?.actorUuid ?? null;
        input.actorId = input.actorId ?? plan?.snapshot?.self?.actorId ?? null;
        input.tokenUuid = input.tokenUuid ?? plan?.tokenUuid ?? plan?.snapshot?.self?.tokenUuid ?? null;
        input.targetUuid = input.targetUuid ?? input.targetTokenUuid ?? null;
        // The step contract keeps the canonical `suppressing_fire` attack
        // type; the system API expects the underlying burst mode plus the
        // `suppressionFire` flag (`resolveSuppressionBurstMode` keeps it).
        if (input.attackType === "suppressing_fire") {
            input.suppressionFire = true;
            input.attackType = input.burstMode ?? "semi_auto";
        }
        input.flags = {
            ...(input.flags ?? {}),
            aiOperationId: operationId,
            aiStepId: step?.id ?? null
        };
        return input;
    }

    /**
     * Execute an `attack`/`test` step through the system rolls API. The
     * operation id is scoped per step so system-side idempotency replays
     * this exact step only.
     * @param {"attack"|"test"} kind
     * @param {object} step
     * @param {object} context
     * @param {object} plan Active plan.
     * @param {string} operationId
     * @returns {Promise<object>} Step outcome.
     */
    async function _stepRoll(kind, step, context, plan, operationId) {
        const rolls = _rolls(context);
        const names = ROLL_API[kind];
        const prepare = rolls?.[names.prepare];
        const execute = rolls?.[names.execute];
        if (typeof prepare !== "function" || typeof execute !== "function") {
            return { ok: false, reason: EXECUTOR_REASONS.systemApiMissing, terminal: true };
        }
        let prepared;
        try {
            prepared = await prepare(_rollInput(step, plan, operationId));
        } catch(err) {
            return {
                ok: false,
                reason: EXECUTOR_REASONS.rollFailed,
                error: String(err?.message ?? err)
            };
        }
        if (!prepared || prepared.status === "failed" || prepared.status === "error"
            || prepared.ok === false) {
            return {
                ok: false,
                reason: prepared?.reason ?? EXECUTOR_REASONS.rollFailed,
                stale: prepared?.reason === "stale-state"
            };
        }
        let outcome;
        try {
            outcome = await execute(prepared, { operationId: `${operationId}.${step.id}` });
        } catch(err) {
            return {
                ok: false,
                reason: EXECUTOR_REASONS.rollFailed,
                error: String(err?.message ?? err)
            };
        }
        if (!outcome || outcome.status === "failed" || outcome.status === "error"
            || outcome.ok === false) {
            return {
                ok: false,
                reason: outcome?.reason ?? EXECUTOR_REASONS.rollFailed,
                stale: outcome?.reason === "stale-state"
            };
        }
        return {
            ok: true,
            delta: outcome.resourceDelta ?? {},
            chatMessageIds: Array.isArray(outcome.chatMessageIds) ? outcome.chatMessageIds : [],
            duplicate: outcome.duplicate === true
        };
    }

    /**
     * Execute an `overwatch` step: declare a watch cone on the combatant
     * flag through the overwatch service (issue #14). Declare-only — the
     * reaction shot itself stays with the GM.
     * @param {object} step
     * @param {object} context
     * @param {object} run Shared execution state.
     * @returns {Promise<object>} Step outcome.
     */
    async function _stepOverwatch(step, context, run) {
        const overwatch = _service("overwatch", context.overwatch);
        if (!overwatch || typeof overwatch.declare !== "function") {
            return { ok: false, reason: EXECUTOR_REASONS.systemApiMissing, terminal: true };
        }
        const input = step?.input ?? {};
        const outcome = await overwatch.declare({
            combat: context.combat,
            combatant: run.combatant,
            spec: {
                direction: input.direction,
                arc: input.arc,
                range: input.range,
                weaponId: input.weaponId ?? input.itemUuid ?? null,
                weaponName: input.name ?? input.weaponName ?? null,
                attackType: input.attackType ?? null
            }
        });
        if (!outcome?.ok) {
            return { ok: false, reason: outcome?.reason ?? EXECUTOR_REASONS.rollFailed };
        }
        return { ok: true, record: outcome.record };
    }

    /**
     * Run one plan step.
     * @param {object} step
     * @param {object} context
     * @param {object} run Shared execution state.
     * @returns {Promise<object>} Step outcome.
     */
    async function _runStep(step, context, run) {
        switch (step?.type) {
            case "move":
                return _stepMove(step, context, run.combatant);
            case "attack":
            case "test":
                return _stepRoll(step.type, step, context, run.plan, run.operationId);
            case "overwatch":
                return _stepOverwatch(step, context, run);
            case "end-turn":
                return { ok: true };
            default:
                return { ok: false, reason: EXECUTOR_REASONS.invalidStep };
        }
    }

    /**
     * Stale/failure policy: ask the planner whether a replan is granted
     * (at most one per turn) and rebuild the plan on the fresh snapshot.
     * @param {string} failReason
     * @param {object} context
     * @param {object} run Shared execution state.
     * @returns {Promise<object>} `{action: "replan"|"stop", reason?}`.
     */
    async function _handleFailure(failReason, context, run) {
        const planner = _planner(context);
        const decision = typeof planner?.shouldReplan === "function"
            ? planner.shouldReplan({
                reason: failReason,
                plan: run.plan,
                replanCount: run.replanCount
            })
            : { action: "hold-and-report", reason: failReason };
        run.report = decision.report ?? run.report ?? null;
        if (decision?.action === "replan" && typeof planner?.planTurn === "function") {
            run.replanCount = decision.replanCount ?? (run.replanCount + 1);
            let replanned = null;
            try {
                replanned = await planner.planTurn(
                    context.combat,
                    run.combatant,
                    _planContext(context, context.operation, run.replanCount, run)
                );
            } catch(err) {
                replanned = null;
            }
            if (replanned?.status === "ok" && replanned.plan) {
                run.plan = replanned.plan;
                run.stepIndex = 0;
                run.expectedPosition = _selfPosition(run.plan) ?? run.expectedPosition;
                log(`replan ${run.replanCount}: ${failReason} -> ${replanned.plan.id}`);
                return { action: "replan" };
            }
            run.report = replanned?.diagnostics ?? run.report;
            return {
                action: "stop",
                reason: replanned?.reason ?? EXECUTOR_REASONS.planFailed
            };
        }
        return { action: "stop", reason: decision?.reason ?? failReason };
    }

    /**
     * Classify a step failure for the replan policy: a system-side
     * `stale-state` is re-validated against the live snapshot so the
     * specific stale reason (`token-moved`, `target-gone`, ...) drives the
     * decision; everything else stays a plain step failure.
     * @param {object} outcome Step outcome.
     * @param {object} context
     * @param {object} run Shared execution state.
     * @returns {string}
     */
    function _failureReason(outcome, context, run) {
        if (outcome?.stale === true) {
            const verdict = _validate(run, context);
            return verdict.valid ? "step-failed" : (verdict.reason ?? "step-failed");
        }
        return outcome?.reason ?? "step-failed";
    }

    /** In-flight turn advances per combat — serializes `nextTurn` calls. */
    const advanceChains = new Map();

    /**
     * Advance the combat turn once for one operation — turn-keyed, chained
     * and verified. Two advances for the same operation can never race:
     * requests queue behind the in-flight one, and a caller whose turn is
     * already past `operation.{round,turn}` is a no-op. This matters
     * because two overlapping `nextTurn` calls can land out of order and
     * restore an older turn — observed in live sessions as a parked combat.
     * After a short settle window the pair is re-read and the call retries
     * a bounded number of times before reporting a controlled diagnostic.
     * @param {object} combat Combat document.
     * @param {object} operation Operation record carrying `round`/`turn`.
     * @param {object} context
     * @returns {Promise<boolean>} true when the turn moved past the op.
     */
    async function _advanceForOperation(combat, operation, context) {
        if (!combat || combat.ended === true) return false;
        if (!_isController(context)) return false;
        if (typeof combat.nextTurn !== "function") return false;
        const onTurn = () => {
            // Operations without turn coordinates (direct runPlan callers)
            // keep the legacy always-advance semantics.
            if (!Number.isFinite(operation?.round) || !Number.isFinite(operation?.turn)) return true;
            return combat.round === operation.round && combat.turn === operation.turn;
        };
        if (!onTurn()) return true;
        const id = combat.id ?? "combat";
        const prior = advanceChains.get(id) ?? Promise.resolve();
        const next = prior.then(async () => {
            if (!onTurn()) return true;
            const key = () => `${combat.round}:${combat.turn}`;
            // A resolved `nextTurn` can be silently reverted well after it
            // resolves (out-of-order document writes); keep verifying for a
            // few seconds and re-drive while the op's turn is still held.
            for (let attempt = 0; attempt <= ADVANCE_VERIFY_RETRIES; attempt++) {
                const before = key();
                // Pacing before the advance keeps each bot's turn visible.
                if (attempt === 0 && pacing() > 0) await _sleep(pacing());
                try {
                    await combat.nextTurn();
                } catch(err) {
                    console.error(`${MODULE_ID} | nextTurn failed`, err);
                }
                for (const window of ADVANCE_VERIFY_WINDOWS) {
                    await _sleep(window);
                    if (key() !== before) return true;
                }
            }
            log(`advance stalled: ${key()} unchanged after ${ADVANCE_VERIFY_RETRIES + 1} attempts`);
            return false;
        });
        advanceChains.set(id, next);
        try {
            return await next;
        } finally {
            if (advanceChains.get(id) === next) advanceChains.delete(id);
        }
    }

    /**
     * Advance the combat turn once. The `operationCompleted` hook emitted
     * by `completeTurn` (#400) is the primary handoff; when no operations
     * service or hook fired, the controller advances directly (plain-GM
     * fallback).
     * @param {object} context
     * @param {object} run Shared execution state.
     * @returns {Promise<void>}
     */
    async function _advanceTurn(context, run) {
        if (run.record.hookAdvanced === true) return;
        if (context.combat?.ended === true) return;
        if (!_isController(context)) return;
        if (typeof context.combat?.nextTurn !== "function") return;
        await _advanceForOperation(context.combat, context.operation ?? run.operation, context);
    }

    /**
     * Close the authority operation for a terminal execution and advance
     * the combat turn. Best-effort: flag failures never crash the result.
     * @param {object} context
     * @param {object} run Shared execution state.
     * @param {object} result Public result summary.
     * @param {boolean} advanceTurn Whether the hook/fallback may advance.
     * @returns {Promise<void>}
     */
    async function _finish(context, run, result, advanceTurn = true) {
        const operations = _operations(context);
        const payload = {
            completed: result.status === EXECUTOR_STATUS.completed,
            failed: result.status === EXECUTOR_STATUS.failed,
            cancelled: result.status === EXECUTOR_STATUS.cancelled,
            reason: result.reason,
            advanceTurn,
            result: {
                status: result.status,
                planId: result.planId,
                reason: result.reason,
                replanCount: result.replanCount,
                stepsDone: result.stepsDone,
                resourceDelta: result.resourceDelta,
                chatMessageIds: result.chatMessageIds
            }
        };
        if (operations && typeof operations.completeTurn === "function") {
            try {
                await operations.completeTurn(context.combat, run.operationId, payload);
            } catch(err) {
                console.error(`${MODULE_ID} | completeTurn failed`, err);
            }
        }
        if (advanceTurn) await _advanceTurn(context, run);
    }

    /**
     * Compact summary of the planner's rejected candidates for GM-facing
     * diagnostics ("pinned ×3, no-los ×2"). Returns `null` when the report
     * carries no rejection list.
     * @param {*} report Planner diagnostics or a replan report.
     * @returns {string|null}
     */
    function _rejectedSummary(report) {
        const rejected = Array.isArray(report?.rejected) ? report.rejected : [];
        if (!rejected.length) return null;
        const counts = new Map();
        for (const entry of rejected) {
            const reason = entry?.reason ?? "unknown";
            counts.set(reason, (counts.get(reason) ?? 0) + 1);
        }
        return [...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([reason, count]) => (count > 1 ? `${reason} ×${count}` : reason))
            .join(", ");
    }

    /**
     * GM-facing diagnostics for stopped turns: a warning notification plus
     * a whispered chat card with the plan diagnostics when diagnostics are
     * enabled.
     * @param {object} context
     * @param {object} run Shared execution state.
     * @param {object} result Terminal result.
     */
    function _report(context, run, result) {
        const i18n = globalThis.game?.i18n;
        const name = run.combatant?.name ?? "NPC";
        const message = i18n?.format?.("OWAI.Notifications.ExecutorStopped", {
            name,
            reason: result.reason ?? "unknown"
        }) ?? `Only War AI: ${name} stopped (${result.reason})`;
        try {
            globalThis.ui?.notifications?.warn?.(message);
        } catch(err) {
            // Notifications are best-effort diagnostics.
        }
        log(`execution ${run.operationId} stopped: ${result.reason}`, run.report ?? "");
        if (diagnostics() && typeof globalThis.ChatMessage !== "undefined") {
            const rejected = _rejectedSummary(run.report);
            const detail = rejected
                ? (i18n?.format?.("OWAI.Chat.ExecutorDiagnosticsDetail", { list: rejected })
                    ?? ` rejected: ${rejected}`)
                : "";
            const content = i18n?.format?.("OWAI.Chat.ExecutorDiagnostics", {
                name,
                reason: result.reason ?? "unknown",
                plan: result.planId ?? "—",
                detail
            }) ?? message;
            const whisper = _list(globalThis.game?.users)
                .filter(user => user?.isGM)
                .map(user => user.id);
            try {
                Promise.resolve(globalThis.ChatMessage.create({
                    content: `<p>${content}</p>`,
                    whisper,
                    speaker: { alias: "Only War AI" }
                })).catch(() => {});
            } catch(err) {
                // Chat diagnostics are optional.
            }
        }
    }

    /**
     * Build the public execution result object.
     * @param {object} fields
     * @returns {object}
     */
    function _result(fields) {
        return {
            status: fields.status,
            reason: fields.reason ?? null,
            operationId: fields.operationId ?? null,
            planId: fields.planId ?? null,
            stepsDone: fields.stepsDone ?? [],
            failedStep: fields.failedStep ?? null,
            replanCount: fields.replanCount ?? 0,
            resourceDelta: fields.resourceDelta ?? {},
            chatMessageIds: fields.chatMessageIds ?? [],
            ...(fields.plan !== undefined ? { plan: fields.plan } : {}),
            ...(fields.diagnostics !== undefined ? { diagnostics: fields.diagnostics } : {})
        };
    }

    /**
     * Guarded start shared by `runPlan`/`executePlan`: controller check,
     * combatant resolution and the enabled-config gate. Returns a result
     * to short-circuit with, or null when execution may proceed.
     * @param {object} context
     * @param {object} run Shared execution state.
     * @returns {Promise<object|null>} Early result or null.
     */
    async function _preflight(context, run) {
        if (!isEnabled()) {
            const result = _result({
                status: EXECUTOR_STATUS.cancelled,
                reason: EXECUTOR_REASONS.moduleDisabled,
                operationId: run.operationId
            });
            // Master switch off: close the operation but keep the turn
            // under manual GM control.
            await _finish(context, run, result, false);
            return result;
        }
        if (!_isController(context)) {
            return _result({
                status: EXECUTOR_STATUS.cancelled,
                reason: EXECUTOR_REASONS.notController,
                operationId: run.operationId
            });
        }
        run.combatant = _combatantOf(context, context.combat);
        if (!run.combatant) {
            const result = _result({
                status: EXECUTOR_STATUS.failed,
                reason: EXECUTOR_REASONS.noCombatant,
                operationId: run.operationId
            });
            await _finish(context, run, result, false);
            return result;
        }
        const config = resolveConfig(run.combatant);
        run.config = config;
        if (!config?.enabled) {
            const result = _result({
                status: EXECUTOR_STATUS.cancelled,
                reason: EXECUTOR_REASONS.configDisabled,
                operationId: run.operationId
            });
            // Refused execution keeps the turn under manual GM control —
            // the operation is closed but the turn is not advanced.
            await _finish(context, run, result, false);
            return result;
        }
        return null;
    }

    /**
     * Step-runner loop. Executes `run.plan` step by step, validating the
     * snapshot before every state-changing step and applying the
     * one-replan policy on stale/failed steps.
     * @param {object} context
     * @param {object} run Shared execution state.
     * @returns {Promise<object>} Terminal result.
     */
    async function _execute(context, run) {
        const stepsDone = [];
        const resourceDelta = {};
        const chatMessageIds = [];
        let failedStep = null;
        let reason = null;
        let status = EXECUTOR_STATUS.completed;
        let irreversibleSpent = false;
        let skippedIrreversible = false;

        for (;;) {
            const steps = Array.isArray(run.plan?.steps) ? run.plan.steps : [];
            while (run.stepIndex < steps.length) {
                const step = steps[run.stepIndex];

                if (run.signal?.aborted === true) {
                    status = EXECUTOR_STATUS.cancelled;
                    reason = EXECUTOR_REASONS.controllerChanged;
                    failedStep = step.id;
                    break;
                }
                if (!isEnabled()) {
                    status = EXECUTOR_STATUS.cancelled;
                    reason = EXECUTOR_REASONS.moduleDisabled;
                    failedStep = step.id;
                    break;
                }
                if (!_isController(context)) {
                    status = EXECUTOR_STATUS.cancelled;
                    reason = EXECUTOR_REASONS.notController;
                    failedStep = step.id;
                    break;
                }

                // Irreversible roll/resource steps never repeat within a
                // turn — replans keep the remaining budget only.
                const irreversible = IRREVERSIBLE_STEP_TYPES.has(step.type);
                if (irreversible && irreversibleSpent) {
                    stepsDone.push({
                        stepId: step.id,
                        type: step.type,
                        status: STEP_STATUS.skipped,
                        reason: EXECUTOR_REASONS.actionBudgetSpent
                    });
                    skippedIrreversible = true;
                    run.stepIndex++;
                    continue;
                }

                // Snapshot validation before every state-changing step —
                // manual intervention (external moves, deleted targets,
                // spent resources) surfaces here as a stale reason.
                const verdict = _validate(run, context);
                if (!verdict.valid) {
                    const outcome = await _handleFailure(verdict.reason, context, run);
                    if (outcome.action === "replan") {
                        failedStep = null;
                        break;
                    }
                    failedStep = step.id;
                    status = stepsDone.some(s => s.status === STEP_STATUS.done)
                        ? EXECUTOR_STATUS.partial
                        : EXECUTOR_STATUS.failed;
                    reason = outcome.reason ?? verdict.reason;
                    break;
                }

                const outcome = await _runStep(step, context, run);
                if (outcome.ok) {
                    stepsDone.push({
                        stepId: step.id,
                        type: step.type,
                        status: outcome.skipped ? STEP_STATUS.skipped : STEP_STATUS.done,
                        reason: outcome.reason ?? null,
                        duplicate: outcome.duplicate === true
                    });
                    _mergeDelta(resourceDelta, outcome.delta);
                    if (outcome.chatMessageIds) chatMessageIds.push(...outcome.chatMessageIds);
                    if (irreversible && !outcome.skipped) irreversibleSpent = true;
                    if (step.type === "move" && !outcome.skipped && outcome.position) {
                        run.expectedPosition = {
                            x: outcome.position.x,
                            y: outcome.position.y
                        };
                    }
                    run.stepIndex++;
                    // Pacing: let the move animation/roll card breathe so
                    // automated turns stay watchable (world setting).
                    if (run.stepIndex < steps.length) await _sleep(pacing());
                    continue;
                }

                const decision = await _handleFailure(
                    _failureReason(outcome, context, run), context, run
                );
                if (decision.action === "replan") {
                    failedStep = null;
                    break;
                }
                failedStep = step.id;
                status = stepsDone.some(s => s.status === STEP_STATUS.done)
                    ? EXECUTOR_STATUS.partial
                    : EXECUTOR_STATUS.failed;
                reason = decision.reason ?? outcome.reason ?? "step-failed";
                break;
            }

            if (run.stepIndex < steps.length) {
                // Broke out of the step loop: either a replan swapped
                // `run.plan` (and reset stepIndex) or a terminal reason is set.
                if (reason === null && status === EXECUTOR_STATUS.completed) continue;
                break;
            }
            break;
        }

        if (status === EXECUTOR_STATUS.completed && skippedIrreversible) {
            status = EXECUTOR_STATUS.partial;
            reason = reason ?? EXECUTOR_REASONS.actionBudgetSpent;
        }
        if (status === EXECUTOR_STATUS.cancelled) {
            return _result({
                status,
                reason,
                operationId: run.operationId,
                planId: run.plan?.id ?? null,
                stepsDone,
                failedStep,
                replanCount: run.replanCount,
                resourceDelta,
                chatMessageIds,
                diagnostics: run.report ?? run.plan?.diagnostics
            });
        }
        const result = _result({
            status,
            reason,
            operationId: run.operationId,
            planId: run.plan?.id ?? null,
            stepsDone,
            failedStep,
            replanCount: run.replanCount,
            resourceDelta,
            chatMessageIds,
            diagnostics: run.report ?? run.plan?.diagnostics
        });
        await _finish(context, run, result, true);
        if (status !== EXECUTOR_STATUS.completed) _report(context, run, result);
        log(`execution ${run.operationId}: ${status} reason=${reason} steps=${stepsDone.length}`);
        return result;
    }

    /**
     * Execute a serialized plan (`planner.planTurn` output or an injected
     * equivalent). Repeated calls with the same operation id return the
     * previous result.
     * @param {object} plan Serialized plan.
     * @param {object} [context] `{combat, combatant?, operation?, operationId?,
     *   operations?, signal?, authority?, planner?, rolls?, token?, scene?,
     *   planContext?, validation?}`.
     * @returns {Promise<object>} ExecutionResult.
     */
    async function executePlan(plan, context = {}) {
        const operationId = _operationId(context);
        const existing = executions.get(operationId);
        if (existing) return existing.promise;
        const run = {
            operationId,
            plan,
            signal: context.signal ?? null,
            combatant: null,
            expectedPosition: _selfPosition(plan),
            replanCount: _finiteOr(plan?.replanCount, 0),
            stepIndex: 0,
            report: null,
            record: null
        };
        const record = { promise: null, hookAdvanced: false };
        run.record = record;
        record.promise = (async () => {
            const early = await _preflight(context, run);
            if (early) return early;
            return _execute(context, run);
        })();
        executions.set(operationId, record);
        return record.promise;
    }

    /**
     * Authority integration point (#400): plans through the planner service
     * (or uses `context.plan`) and executes the result. Called by the
     * authority service as `api.services.get("executor").runPlan({combat,
     *   operation, operations, signal})`.
     * @param {object} context `{combat, operation?, operations?, signal?,
     *   plan?, planContext?, combatant?, seed?}`.
     * @returns {Promise<object>} ExecutionResult.
     */
    async function runPlan(context = {}) {
        const operationId = _operationId(context);
        const existing = executions.get(operationId);
        if (existing) return existing.promise;

        const run = {
            operationId,
            plan: context.plan ?? null,
            signal: context.signal ?? null,
            combatant: null,
            expectedPosition: _selfPosition(context.plan),
            replanCount: _finiteOr(context.plan?.replanCount, 0),
            stepIndex: 0,
            report: null,
            record: null
        };
        const record = { promise: null, hookAdvanced: false };
        run.record = record;
        record.promise = (async () => {
            const early = await _preflight(context, run);
            if (early) return early;

            if (!run.plan) {
                const planner = _planner(context);
                if (typeof planner?.planTurn !== "function") {
                    const result = _result({
                        status: EXECUTOR_STATUS.failed,
                        reason: EXECUTOR_REASONS.noPlanner,
                        operationId
                    });
                    await _finish(context, run, result, true);
                    return result;
                }
                let planned = null;
                try {
                    planned = await planner.planTurn(
                        context.combat,
                        run.combatant,
                        _planContext(context, context.operation, 0, run)
                    );
                } catch(err) {
                    planned = null;
                }
                if (planned?.status !== "ok" || !planned.plan) {
                    run.report = planned?.diagnostics ?? null;
                    const result = _result({
                        status: EXECUTOR_STATUS.failed,
                        reason: planned?.reason ?? EXECUTOR_REASONS.planFailed,
                        operationId
                    });
                    await _finish(context, run, result, true);
                    _report(context, run, result);
                    return result;
                }
                run.plan = planned.plan;
                run.expectedPosition = _selfPosition(run.plan);
            }

            // Preview mode: preflight only — the operation stays in
            // `awaiting-preview` and no document is touched. The
            // `previewRequested` hook hands the serialized plan to the GM
            // preview UI (issue #409); Confirm launches `executePlan`
            // separately, so nothing here mutates state.
            if (getMode() !== "automatic") {
                const verdict = _validate(run, context);
                if (typeof hooks?.callAll === "function") {
                    try {
                        hooks.callAll(`${MODULE_ID}.previewRequested`, {
                            combat: context.combat ?? null,
                            combatant: run.combatant,
                            operation: context.operation ?? null,
                            operationId,
                            plan: run.plan,
                            planContext: context.planContext ?? null
                        });
                    } catch(err) {
                        console.error(`${MODULE_ID} | previewRequested hook failed`, err);
                    }
                }
                return _result({
                    status: EXECUTOR_STATUS.preview,
                    reason: verdict.valid
                        ? EXECUTOR_REASONS.previewMode
                        : (verdict.reason ?? EXECUTOR_REASONS.previewMode),
                    operationId,
                    planId: run.plan?.id ?? null,
                    plan: run.plan
                });
            }

            // Best-effort phase advance when the operation is not already
            // in `executing` (authority normally transitions beforehand).
            const operations = _operations(context);
            const phase = context.operation?.phase;
            if (operations && phase && phase !== "executing"
                && typeof operations.transitionOperation === "function") {
                try {
                    await operations.transitionOperation(
                        context.combat, operationId, phase, "executing"
                    );
                } catch(err) {
                    // Non-fatal: execution continues under the same id.
                }
            }
            return _execute(context, run);
        })();
        executions.set(operationId, record);
        return record.promise;
    }

    return {
        executePlan,
        runPlan,
        statuses: EXECUTOR_STATUS,
        reasons: EXECUTOR_REASONS,
        stepStatuses: STEP_STATUS,
        /**
         * Whether an execution result already exists for an operation id.
         * @param {string} operationId
         * @returns {boolean}
         */
        hasExecution(operationId) {
            return executions.has(operationId);
        },
        /**
         * Forget recorded executions (test/maintenance helper).
         * @param {string} [operationId] Specific id or all when omitted.
         */
        clearExecutions(operationId) {
            if (operationId === undefined) executions.clear();
            else executions.delete(operationId);
        }
    };
}
