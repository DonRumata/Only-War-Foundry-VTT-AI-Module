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
import { ATTACK_ADJUDICATION_MODES, FLAG_KEYS, MODULE_ID } from "./constants.js";
import { resolveEffectiveConfig } from "./config-resolver.js";
import { STALE_REASONS } from "./planner.js";
import { isModuleEnabled } from "./module-state.js";
import {
    getAttackAdjudication,
    getExecutionMode,
    getPreviewTimeoutSeconds,
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
    actionBudgetSpent: "action-budget-spent",
    // Issue #37 adjudication outcomes recorded on steps/results.
    adjudicationCancelled: "adjudication-cancelled",
    adjudicationManual: "adjudicated-manual",
    adjudicationSkillTest: "adjudicated-skill-test"
});

/** Step types that spend irreversible resources through the system API. */
const IRREVERSIBLE_STEP_TYPES = Object.freeze(new Set(["attack", "test"]));

/** System roll API entry points per step type (system PR #440). */
const ROLL_API = Object.freeze({
    attack: Object.freeze({ prepare: "prepareAttack", execute: "executeAttack" }),
    test: Object.freeze({ prepare: "prepareTest", execute: "executeTest" })
});

/**
 * GM decisions accepted by the issue #37 adjudication gate:
 * `execute` — run the step through the system roll API;
 * `manual` — the GM rolls it manually and the step counts as spent;
 * `skill-test` — substitute the attack with a `test` step (legally
 * resolves "two identical half actions"/Use Skill situations);
 * `cancel` — stop the turn, hand it back to manual GM control.
 */
export const ADJUDICATION_ACTIONS = Object.freeze([
    "execute",
    "manual",
    "skill-test",
    "cancel"
]);

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
 * @param {Function} [deps.getAdjudication] Attack adjudication mode
 *   getter (`"auto"|"gm-confirm"`, issue #37).
 * @param {Function} [deps.adjudicationTimeout] GM decision timeout
 *   getter in seconds — reuses `previewTimeoutSeconds`, `0` waits
 *   forever (issue #52).
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
    pacing = getTurnPacingMs,
    getAdjudication = getAttackAdjudication,
    adjudicationTimeout = getPreviewTimeoutSeconds
} = {}) {
    /** Operation id → {promise, hookAdvanced}: dedup of repeated executions. */
    const executions = new Map();
    /** Adjudication request id → pending `{resolve, request}` pair (#37). */
    const pendingAdjudications = new Map();
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
    /**
     * Resolved attack-adjudication mode for this execution
     * (issue #37): a validated `context.adjudicationMode` injection wins,
     * otherwise the `attackAdjudication` world setting answers.
     * @param {object} context
     * @returns {string} `"auto"|"gm-confirm"`.
     */
    function _adjudicationMode(context) {
        const injected = context?.adjudicationMode;
        return ATTACK_ADJUDICATION_MODES.includes(injected)
            ? injected
            : getAdjudication();
    }

    /**
     * Subscribe the module hooks once: the operation-completed turn
     * handoff, the `updateCombat` adjudication auto-cancel and the
     * `renderChatMessage` adjudication button binding (issue #37).
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
        // Issue #37: a pending adjudication belongs to the claimed turn —
        // when the combat moves on (manual advance, turn stole) the gate
        // resolves itself instead of parking the executor promise.
        hooks.on("updateCombat", (combat, change) => {
            try {
                if (!change || (change.turn === undefined && change.round === undefined)) {
                    return;
                }
                for (const [requestId, pending] of pendingAdjudications) {
                    clearTimeout(pending.timer);
                    pendingAdjudications.delete(requestId);
                    pending.resolve({ action: "cancel", reason: "turn-stale" });
                }
            } catch(err) {
                console.error(`${MODULE_ID} | adjudication cancel failed`, err);
            }
        });
        // Issue #52: the combat going away resolves every pending gate —
        // without it a deleted combat would park the executor forever.
        hooks.on("deleteCombat", () => {
            try {
                for (const [requestId, pending] of pendingAdjudications) {
                    clearTimeout(pending.timer);
                    pendingAdjudications.delete(requestId);
                    pending.resolve({ action: "cancel", reason: "combat-ended" });
                }
            } catch(err) {
                console.error(`${MODULE_ID} | adjudication cancel failed`, err);
            }
        });
        // Issue #37: adjudication card buttons resolve the pending gate —
        // only the authority controller may click through, so a player
        // reading the whispered card cannot drive the executor.
        hooks.on("renderChatMessage", (message, html) => {
            try {
                const root = html instanceof HTMLElement
                    ? html
                    : (html?.[0] ?? null);
                const card = root?.querySelector?.("[data-ow-ai-adjudication]");
                if (!card) return;
                const requestId = card.dataset.owAiAdjudication;
                for (const button of card.querySelectorAll("[data-ow-ai-adjudicate]")) {
                    button.addEventListener("click", () => {
                        if (!_isController({})) return;
                        resolveAdjudication(requestId, button.dataset.owAiAdjudicate);
                    });
                }
            } catch(err) {
                console.error(`${MODULE_ID} | adjudication card binding failed`, err);
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
            // Issue #33: the replanned turn is budgeted against what was
            // already spent — GM manual inputs (context.spent) plus steps
            // this run already executed.
            ...(run?.spent && (run.spent.movement > 0 || run.spent.halves > 0)
                ? { spent: { ...run.spent } }
                : {}),
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
     * Grid size in pixels used for waypoint→document conversion.
     * @param {object} context
     * @returns {number}
     */
    function _gridSizeOf(context) {
        const size = context?.scene?.grid?.size
            ?? globalThis.canvas?.grid?.size;
        return Number.isFinite(size) && size > 0 ? size : 100;
    }

    /**
     * Document-space point of a serialized waypoint. Plans carry cell
     * *centres* (navigation `toPoint` = footprint centre), but Foundry 13
     * `TokenMovementWaypoint` expects the document position — the top-left
     * corner for a 1×1 token — so every point shifts by half the footprint.
     * Without this shift each move drifts the token half a cell off-grid,
     * the measured walk overshoots the planned budget and segments can
     * clip walls (issue #32).
     * @param {{x: number, y: number}} point Serialized waypoint/`to`.
     * @param {object|null} tokenDoc
     * @param {object} context
     * @returns {{x: number, y: number}}
     */
    function _docPoint(point, tokenDoc, context) {
        const size = _gridSizeOf(context);
        const fw = _finiteOr(tokenDoc?.width, 1) * size;
        const fh = _finiteOr(tokenDoc?.height, 1) * size;
        return { x: point.x - (fw / 2), y: point.y - (fh / 2) };
    }

    /**
     * Waypoint payload for `TokenDocument#move` (Foundry 13+): the
     * serialized navigation `planRoute` waypoints stored in the plan,
     * normalized to document-space `{x, y, elevation?}` with the step
     * endpoint appended. The path itself is never recomputed here.
     * @param {object} step Move step.
     * @param {{x: number, y: number}} to Destination (centre point).
     * @param {object|null} tokenDoc
     * @param {object} context
     * @returns {object[]}
     */
    function _movePayload(step, to, tokenDoc, context) {
        const raw = Array.isArray(step?.input?.waypoints) ? step.input.waypoints : [];
        const points = raw
            .filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))
            .map(point => ({
                ..._docPoint(point, tokenDoc, context),
                ...(Number.isFinite(point.elevation) ? { elevation: point.elevation } : {})
            }));
        const docTo = _docPoint(to, tokenDoc, context);
        const last = points[points.length - 1];
        if (!last || last.x !== docTo.x || last.y !== docTo.y) {
            points.push(docTo);
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
        // The serialized `to` is a footprint centre; document positions
        // are top-left — compare in document space (issue #32).
        const docTo = _docPoint(to, tokenDoc, context);
        // Hex grids snap the token to the cell — the plan's fractional `to`
        // and the stored integer position differ by <0.5px.
        const curX = tokenDoc._source?.x ?? tokenDoc.x;
        const curY = tokenDoc._source?.y ?? tokenDoc.y;
        if (Math.abs(curX - docTo.x) < 0.5 && Math.abs(curY - docTo.y) < 0.5) {
            return {
                ok: true,
                skipped: true,
                reason: EXECUTOR_REASONS.alreadyAtEndpoint,
                position: docTo
            };
        }
        try {
            if (typeof tokenDoc.move === "function") {
                const moved = await tokenDoc.move(_movePayload(step, to, tokenDoc, context), {
                    method: "api",
                    showRuler: false
                });
                if (moved === false) return { ok: false, reason: EXECUTOR_REASONS.moveFailed };
            } else if (typeof tokenDoc.update === "function") {
                await tokenDoc.update({ x: docTo.x, y: docTo.y });
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
            position: { x: docTo.x, y: docTo.y, elevation: to.elevation },
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
     * Execute an `aim` step (issue #15): books the aim bonus on the
     * combatant `aim` flag. For `aim-attack` plans the following attack
     * step carries `input.aim` and consumes the flag; a standalone `aim`
     * plan leaves the record until the next attack (aimedUntil).
     * @param {object} step
     * @param {object} context
     * @param {object} run Shared execution state.
     * @returns {Promise<object>} Step outcome.
     */
    async function _stepAim(step, context, run) {
        const input = step?.input ?? {};
        const bonus = _finiteOr(input.aim, 10);
        const record = {
            bonus,
            declaredRound: context.combat?.round ?? null
        };
        const combatant = run.combatant;
        if (typeof combatant?.setFlag === "function") {
            try {
                await combatant.setFlag(MODULE_ID, FLAG_KEYS.aim, record);
            } catch(err) {
                return {
                    ok: false,
                    reason: "flag-write-failed",
                    error: String(err?.message ?? err)
                };
            }
        }
        return { ok: true };
    }

    /**
     * Execute a `reload` step (issue #15) through
     * `game.darkHeresy.api.actions.reload` — magazine swap or clip refill,
     * idempotent through the step-scoped operation id.
     * @param {object} step
     * @param {object} context
     * @param {object} run Shared execution state.
     * @returns {Promise<object>} Step outcome.
     */
    async function _stepReload(step, context, run) {
        const api = context.actionsApi
            ?? globalThis.game?.darkHeresy?.api?.actions
            ?? null;
        if (typeof api?.reload !== "function") {
            return { ok: false, reason: EXECUTOR_REASONS.systemApiMissing, terminal: true };
        }
        const input = step?.input ?? {};
        const plan = run.plan;
        const operationId = `${run.operationId}.${step.id}`;
        let outcome;
        try {
            outcome = await api.reload({
                actorUuid: plan?.snapshot?.self?.actorUuid ?? null,
                actorId: plan?.snapshot?.self?.actorId ?? null,
                weaponId: input.weaponId ?? input.itemUuid ?? null,
                magazineItemId: input.magazineItemId ?? null
            }, { operationId });
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
     * Execute a `ready-weapon` step (issue #37): draws/equips the weapon
     * the planner picked. Routed through the system actions API when it
     * exposes one of `readyWeapon`/`ready`/`equip` — the module keeps no
     * weapon-draw rules of its own (Quick Draw pricing lives in the
     * system `cost` the planner already consumed). A missing endpoint is
     * a controlled `system-api-missing`.
     * @param {object} step
     * @param {object} context
     * @param {object} run Shared execution state.
     * @returns {Promise<object>} Step outcome.
     */
    async function _stepReadyWeapon(step, context, run) {
        const api = context.actionsApi
            ?? globalThis.game?.darkHeresy?.api?.actions
            ?? null;
        const entry = typeof api?.readyWeapon === "function" ? api.readyWeapon
            : (typeof api?.ready === "function" ? api.ready
                : (typeof api?.equip === "function" ? api.equip : null));
        if (!entry) {
            return { ok: false, reason: EXECUTOR_REASONS.systemApiMissing, terminal: true };
        }
        const input = step?.input ?? {};
        const plan = run.plan;
        const operationId = `${run.operationId}.${step.id}`;
        let outcome;
        try {
            outcome = await entry.call(api, {
                actorUuid: plan?.snapshot?.self?.actorUuid ?? null,
                actorId: plan?.snapshot?.self?.actorId ?? null,
                weaponId: input.weaponId ?? input.itemUuid ?? null
            }, { operationId });
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
     * Execute a `drop-prone` step (issue #37): the free-action cover
     * answer toggles the `prone` status on the actor. The system actions
     * API (`api.actions.dropProne`) wins when present; otherwise the
     * Foundry `actor.toggleStatusEffect("prone", {active: true})` channel
     * applies the status through the standard effect pipeline.
     * @param {object} step
     * @param {object} context
     * @param {object} run Shared execution state.
     * @returns {Promise<object>} Step outcome.
     */
    async function _stepDropProne(step, context, run) {
        const statusId = step?.input?.statusId ?? "prone";
        const api = context.actionsApi
            ?? globalThis.game?.darkHeresy?.api?.actions
            ?? null;
        if (typeof api?.dropProne === "function") {
            const plan = run.plan;
            const operationId = `${run.operationId}.${step.id}`;
            let outcome;
            try {
                outcome = await api.dropProne({
                    actorUuid: plan?.snapshot?.self?.actorUuid ?? null,
                    actorId: plan?.snapshot?.self?.actorId ?? null
                }, { operationId });
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
                chatMessageIds: Array.isArray(outcome.chatMessageIds)
                    ? outcome.chatMessageIds : []
            };
        }
        // Status-toggle fallback: the combatant's actor applies prone
        // through the standard effect channel.
        const actor = run.combatant?.actor
            ?? _tokenDoc(run.combatant?.token)?.actor
            ?? null;
        if (typeof actor?.toggleStatusEffect === "function") {
            try {
                await actor.toggleStatusEffect(statusId, { active: true });
                return { ok: true };
            } catch(err) {
                return {
                    ok: false,
                    reason: EXECUTOR_REASONS.rollFailed,
                    error: String(err?.message ?? err)
                };
            }
        }
        return { ok: false, reason: EXECUTOR_REASONS.systemApiMissing, terminal: true };
    }

    /**
     * Resolve a pending adjudication request — the single decision entry
     * point called by the GM card buttons and integrations. Unknown
     * request ids and unsupported actions are ignored; the resolve is
     * idempotent (the pending entry is deleted on first resolve).
     * @param {string} requestId Pending request id.
     * @param {string|object} action One of {@link ADJUDICATION_ACTIONS}
     *   or a `{action, reason?}` record.
     * @returns {boolean} Whether a pending request was resolved.
     */
    function resolveAdjudication(requestId, action) {
        const pending = pendingAdjudications.get(requestId);
        if (!pending) return false;
        const verdict = typeof action === "object" && action !== null
            ? { action: action.action, reason: action.reason ?? null }
            : { action, reason: null };
        if (!ADJUDICATION_ACTIONS.includes(verdict.action)) return false;
        clearTimeout(pending.timer);
        pendingAdjudications.delete(requestId);
        pending.resolve(verdict);
        return true;
    }

    /**
     * GM whisper recipients for the adjudication card.
     * @returns {string[]} User ids.
     */
    function _gmWhisper() {
        return _list(globalThis.game?.users)
            .filter(user => user?.isGM)
            .map(user => user.id);
    }

    /**
     * Localize helper tolerating early init states.
     * @param {string} key
     * @param {object} [data] Format data.
     * @returns {string}
     */
    function _localize(key, data = null) {
        const i18n = globalThis.game?.i18n;
        if (data && typeof i18n?.format === "function") return i18n.format(key, data);
        return i18n?.localize?.(key) ?? key;
    }

    /**
     * HTML content of the GM adjudication card: the step summary plus the
     * four decision buttons (`data-ow-ai-adjudicate` marks them for the
     * `renderChatMessage` binding).
     * @param {object} request Pending request `{id, stepId, step, plan}`.
     * @param {object} context Execution context.
     * @returns {string}
     */
    function _adjudicationCard(request, context) {
        const step = request.step ?? {};
        const input = step.input ?? {};
        const title = _localize("OWAI.Adjudication.Title");
        const detail = _localize("OWAI.Adjudication.Detail", {
            name: request.combatant?.name ?? "NPC",
            action: input.name ?? input.actionId ?? step.id ?? "—"
        });
        const button = key =>
            `<button type="button" data-ow-ai-adjudicate="${key}">`
            + `${_localize(`OWAI.Adjudication.${key}`)}</button>`;
        const buttons = ADJUDICATION_ACTIONS.map(button).join("");
        return `<div class="ow-ai-adjudication" data-ow-ai-adjudication="${request.id}">`
            + `<p><strong>${title}</strong> ${detail}</p>`
            + `<div class="ow-ai-adjudication-buttons">${buttons}</div></div>`;
    }

    /**
     * Ask the GM how to resolve an irreversible step (issue #37). An
     * injected `context.adjudication` resolver wins (tests, integrations);
     * otherwise a whispered `ChatMessage` card with decision buttons is
     * posted and the gate waits for {@link resolveAdjudication} — a turn
     * transition auto-cancels the pending gate via `updateCombat`. When
     * the chat channel is unavailable the step executes (the documented
     * safe default: adjudication cannot park the combat).
     * @param {object} step Irreversible step (`attack`/`test`).
     * @param {object} context Execution context.
     * @param {object} run Shared execution state.
     * @returns {Promise<object>} `{action, reason?}` decision.
     */
    async function _adjudicate(step, context, run) {
        const request = {
            id: `${run.operationId}.${step.id}.adjudication`,
            operationId: run.operationId,
            stepId: step.id,
            step,
            planId: run.plan?.id ?? null,
            combatant: run.combatant
        };
        if (typeof context.adjudication === "function") {
            try {
                const verdict = await context.adjudication(request);
                const action = typeof verdict === "object" && verdict !== null
                    ? verdict.action : verdict;
                return ADJUDICATION_ACTIONS.includes(action)
                    ? { action, reason: verdict?.reason ?? null }
                    : { action: "execute" };
            } catch(err) {
                return { action: "cancel", reason: String(err?.message ?? err) };
            }
        }
        if (typeof globalThis.ChatMessage?.create !== "function") {
            // No chat channel (headless/test harness): fail closed —
            // a `gm-confirm` world asked for a decision and cannot be
            // asked, so the turn goes back to manual GM control rather
            // than executing irreversible rolls unattended (issue #52).
            return { action: "cancel", reason: "adjudication-unavailable" };
        }
        const requestId = request.id;
        const pending = new Promise(resolve => {
            const entry = { resolve, request, timer: null };
            const seconds = Number(adjudicationTimeout());
            if (Number.isFinite(seconds) && seconds > 0) {
                // Issue #52: a GM who never answers cannot park the
                // combat — the gate resolves itself as a cancel, handing
                // the turn back to manual control.
                entry.timer = setTimeout(() => {
                    pendingAdjudications.delete(requestId);
                    resolve({ action: "cancel", reason: "adjudication-timeout" });
                }, seconds * 1000);
            }
            pendingAdjudications.set(requestId, entry);
        });
        try {
            await globalThis.ChatMessage.create({
                content: _adjudicationCard(request, context),
                whisper: _gmWhisper(),
                speaker: { alias: "Only War AI" },
                flags: { [MODULE_ID]: { adjudication: requestId } }
            });
        } catch(err) {
            const entry = pendingAdjudications.get(requestId);
            clearTimeout(entry?.timer);
            pendingAdjudications.delete(requestId);
            return { action: "cancel", reason: "adjudication-unavailable" };
        }
        return pending;
    }

    /**
     * Record the weapon of a successful attack on the combatant
     * `lastUsedWeapon` flag (issue #37): the planner's `weaponInertia`
     * factor reads it next turn. Controller-only writes — the executor
     * only reaches this point after the controller gate.
     * @param {object} step Attack step.
     * @param {object} context
     * @param {object} run Shared execution state.
     * @returns {Promise<void>}
     */
    async function _recordLastUsedWeapon(step, context, run) {
        if (typeof run.combatant?.setFlag !== "function") return;
        const input = step?.input ?? {};
        const record = {
            itemUuid: input.itemUuid ?? null,
            itemId: input.itemId ?? input.weaponId ?? null,
            name: input.name ?? null,
            actionId: input.actionId ?? null,
            round: context.combat?.round ?? null
        };
        if (!record.itemUuid && !record.itemId && !record.name) return;
        try {
            await run.combatant.setFlag(MODULE_ID, FLAG_KEYS.lastUsedWeapon, record);
        } catch(err) {
            // Inertia bookkeeping is best-effort — the shot already landed.
        }
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
            case "test": {
                const outcome = await _stepRoll(step.type, step, context,
                    run.plan, run.operationId);
                // AimedUntil: a taken shot consumes the combatant `aim`
                // flag so the bonus never applies twice (issue #15).
                if (outcome.ok && step.type === "attack"
                    && typeof run.combatant?.unsetFlag === "function") {
                    try {
                        await run.combatant.unsetFlag(MODULE_ID, FLAG_KEYS.aim);
                    } catch(err) {
                        // Flag cleanup is best-effort — the shot already landed.
                    }
                }
                // Issue #37: the taken shot also refreshes the weapon
                // inertia marker the planner scores next turn.
                if (outcome.ok && step.type === "attack") {
                    await _recordLastUsedWeapon(step, context, run);
                }
                return outcome;
            }
            case "aim":
                return _stepAim(step, context, run);
            case "reload":
                return _stepReload(step, context, run);
            case "overwatch":
                return _stepOverwatch(step, context, run);
            case "ready-weapon":
                return _stepReadyWeapon(step, context, run);
            case "drop-prone":
                return _stepDropProne(step, context, run);
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
            // Issue #33: a GM drag spends movement too — the drift
            // between the last expected position and where the token
            // sits now joins the accumulated spend, so the replanned
            // turn only budgets the remainder.
            const staleDoc = _tokenDoc(context.token ?? run.combatant?.token);
            const liveX = staleDoc?._source?.x ?? staleDoc?.x;
            const liveY = staleDoc?._source?.y ?? staleDoc?.y;
            const expected = run.expectedPosition ?? _selfPosition(run.plan);
            if (run.spent && Number.isFinite(liveX) && Number.isFinite(liveY)
                && Number.isFinite(expected?.x) && Number.isFinite(expected?.y)) {
                const drift = Math.hypot(liveX - expected.x, liveY - expected.y)
                    / _gridSizeOf(context);
                // Sub-cell drift is grid-snap noise (hex rounds to the
                // cell) — a real drag is at least half a cell.
                if (drift > 0.5) run.spent.movement += drift;
            }
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

                // Issue #37 adjudication gate: a `gm-confirm` world pauses
                // before every irreversible step and lets the GM decide —
                // execute, roll manually, substitute a skill test or take
                // the turn back. The gate only runs on `automatic`: the
                // preview mode already carries its own confirmation point,
                // so the GM is never asked twice for the same plan.
                let adjudicated = null;
                if (irreversible && getMode() === "automatic"
                    && _adjudicationMode(context) === "gm-confirm") {
                    const decision = await _adjudicate(step, context, run);
                    if (decision.action === "cancel") {
                        status = EXECUTOR_STATUS.cancelled;
                        reason = EXECUTOR_REASONS.adjudicationCancelled;
                        failedStep = step.id;
                        break;
                    }
                    if (decision.action === "manual") {
                        stepsDone.push({
                            stepId: step.id,
                            type: step.type,
                            status: STEP_STATUS.done,
                            reason: EXECUTOR_REASONS.adjudicationManual
                        });
                        irreversibleSpent = true;
                        run.stepIndex++;
                        if (run.stepIndex < steps.length) await _sleep(pacing());
                        continue;
                    }
                    // "skill-test" substitutes the roll channel below;
                    // "execute" falls through to the normal path.
                    if (decision.action === "skill-test") adjudicated = "skill-test";
                }

                const outcome = adjudicated === "skill-test" && step.type === "attack"
                    ? await _stepRoll("test", step, context, run.plan, run.operationId)
                    : await _runStep(step, context, run);
                if (outcome.ok) {
                    stepsDone.push({
                        stepId: step.id,
                        type: step.type,
                        status: outcome.skipped ? STEP_STATUS.skipped : STEP_STATUS.done,
                        reason: adjudicated === "skill-test"
                            ? EXECUTOR_REASONS.adjudicationSkillTest
                            : (outcome.reason ?? null),
                        duplicate: outcome.duplicate === true
                    });
                    _mergeDelta(resourceDelta, outcome.delta);
                    if (outcome.chatMessageIds) chatMessageIds.push(...outcome.chatMessageIds);
                    if (irreversible && !outcome.skipped) irreversibleSpent = true;
                    // Issue #33: accumulate this turn's spent budget so a
                    // later replan only offers the remainder.
                    if (!outcome.skipped && run.spent) {
                        run.spent.halves += _finiteOr(step?.cost?.halves, 0);
                        run.spent.movement += Math.max(0,
                            -_finiteOr(outcome.delta?.movement, 0));
                    }
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
            // Issue #37: an adjudication cancel hands the turn back to
            // manual GM control — the operation closes but the turn is
            // not advanced. Controller/module cancellations leave the
            // operation to its real owner and stay silent.
            if (reason === EXECUTOR_REASONS.adjudicationCancelled) {
                await _finish(context, run, result, false);
            }
            return result;
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
            // Issue #33: budget already consumed this turn (GM manual
            // actions via context.spent / planContext.spent + executed
            // steps) — feeds replan planContext.
            spent: {
                movement: _finiteOr(
                    context.spent?.movement ?? context.planContext?.spent?.movement, 0),
                halves: _finiteOr(
                    context.spent?.halves ?? context.planContext?.spent?.halves, 0)
            },
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
            spent: {
                movement: _finiteOr(
                    context.spent?.movement ?? context.planContext?.spent?.movement, 0),
                halves: _finiteOr(
                    context.spent?.halves ?? context.planContext?.spent?.halves, 0)
            },
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
        resolveAdjudication,
        /**
         * Whether an adjudication request is still pending a GM decision.
         * @param {string} requestId
         * @returns {boolean}
         */
        adjudicationPending(requestId) {
            return pendingAdjudications.has(requestId);
        },
        statuses: EXECUTOR_STATUS,
        reasons: EXECUTOR_REASONS,
        stepStatuses: STEP_STATUS,
        adjudicationActions: ADJUDICATION_ACTIONS,
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
