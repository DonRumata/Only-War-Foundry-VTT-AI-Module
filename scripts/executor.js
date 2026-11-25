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
import {
    resolveEffectiveConfig
} from "./config-resolver.js";
import {
    ATTACK_ADJUDICATION_MODES,
    FLAG_KEYS,
    MODULE_ID
} from "./constants.js";
import {
    isModuleEnabled
} from "./module-state.js";
import {
    STALE_REASONS
} from "./planner.js";
import {
    getAttackAdjudication,
    getCenterOnBot,
    getExecutionMode,
    getPreviewTimeoutSeconds,
    getTurnPacingMs,
    isDiagnosticsEnabled,
    logDiagnostics
} from "./settings.js";
import {
    centerOnToken
} from "./ui/plan-overlay.js";
import {
    createAdjudication
} from "./executor/adjudication.js";
import {
    createTurnAdvance
} from "./executor/advance.js";
import {
    createBookkeeping
} from "./executor/bookkeeping.js";
import {
    ADJUDICATION_ACTIONS,
    EXECUTOR_REASONS,
    EXECUTOR_STATUS,
    IRREVERSIBLE_STEP_TYPES,
    STEP_STATUS
} from "./executor/contract.js";
import {
    createDamageWait
} from "./executor/damage-wait.js";
import {
    createStepHandlers
} from "./executor/steps.js";
import {
    createTeamTurns
} from "./executor/team-turn.js";
import {
    _findCombatant,
    _finiteOr,
    _gridSizeOf,
    _mergeDelta,
    _selfPosition,
    _sleep,
    _tokenDoc
} from "./executor/util.js";


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
    /**
     * Record an execution with a bounded dedup window (smoke review):
     * the map is keyed per operation id and would otherwise grow for the
     * session's lifetime. Insertion-ordered eviction keeps the newest
     * 256 records — an evicted record only loses the idempotent-replay
     * guarantee, which matters for at most the last few turns anyway.
     * @param {string|null} operationId
     * @param {object} record
     */
    const _recordExecution = (operationId, record) => {
        while (executions.size >= 256) {
            executions.delete(executions.keys().next().value);
        }
        executions.set(operationId, record);
    };
    /** Adjudication request id → pending `{resolve, request}` pair (#37). */
    const pendingAdjudications = new Map();
    /**
     * Deferred turn advances waiting on GM damage adjudication (issue
     * #56): operationId → `{combat, combatId, operation, watch, expect,
     * timer, context}` — `watch` holds unsettled damage-card message
     * ids, `expect` marks a landed attack whose damage card the GM has
     * not rolled yet.
     */
    const pendingDamage = new Map();
    let hookSubscribed = false;

    const turnAdvance = createTurnAdvance({ _isController, log, pacing });
    const {
        _advanceForOperation,
        _advanceTurn
    } = turnAdvance;
    const damageWait = createDamageWait({ _advanceForOperation, _isController, log, pendingDamage });
    const {
        _registerDamageWait,
        _onDamageMessage,
        _releaseDamageWait
    } = damageWait;
    const adjudication = createAdjudication({ adjudicationTimeout, pendingAdjudications });
    const {
        resolveAdjudication,
        _adjudicate
    } = adjudication;
    const bookkeeping = createBookkeeping({ _advanceTurn, _isController, _operations, diagnostics, log });
    const {
        _noteMove,
        _capturePlanContext,
        _finish,
        _report
    } = bookkeeping;
    const stepHandlers = createStepHandlers({ _rolls, _service, api });
    const teamTurns = createTeamTurns({ service: _service, isController: _isController,
        isEnabled, resolveConfig, log });
    const {
        _stepRoll,
        _runStep
    } = stepHandlers;

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
     * Release a record's canvas marks (selected bot + targeted token).
     * Called on the combat's turn change and on combat end — never on
     * operation close, so the marks outlive the damage-adjudication
     * wait (smoke finding: the target dropped off the card mid-apply).
     * @param {object|null} record Execution record carrying marks.
     */
    function _releaseMarks(record) {
        try {
            record?._targeted?.setTarget?.(false);
            record?._controlled?.release?.();
        } catch(_err) {
            // Best-effort cleanup.
        }
        if (record) {
            record._targeted = null;
            record._controlled = null;
        }
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
                    // Issue #37 follow-up: a turn advance in ANOTHER combat
                    // must not cancel this combat's pending gate.
                    if (pending.combatId && combat?.id
                        && pending.combatId !== combat.id) continue;
                    clearTimeout(pending.timer);
                    pendingAdjudications.delete(requestId);
                    pending.resolve({ action: "cancel", reason: "turn-stale" });
                }
                // Issue #56: a manual turn advance releases the damage
                // wait — the GM moved the combat on without the card.
                for (const [opId, entry] of pendingDamage) {
                    if (entry.combatId && combat?.id
                        && entry.combatId !== combat.id) continue;
                    _releaseDamageWait(opId, "turn-advanced");
                }
                // The turn moved on — every record's selection/target
                // marks for this combat die with it.
                for (const record of executions.values()) {
                    if (record?.combatId && combat?.id
                        && record.combatId !== combat.id) continue;
                    _releaseMarks(record);
                }
                // Run mechanic: the +20-evasion window ends at the start
                // of the runner's next turn — the flag on the combatant
                // now acting expires.
                try {
                    const currentActor = combat?.combatant?.actor;
                    if (currentActor?.getFlag?.(MODULE_ID, FLAG_KEYS.running)) {
                        currentActor.unsetFlag(MODULE_ID, FLAG_KEYS.running)
                            ?.catch?.(() => {});
                    }
                } catch(_err) {
                    // Marker cleanup is best-effort.
                }
            } catch(err) {
                console.error(`${MODULE_ID} | adjudication cancel failed`, err);
            }
        });
        // Issue #52: the combat going away resolves every pending gate —
        // without it a deleted combat would park the executor forever.
        hooks.on("deleteCombat", combat => {
            try {
                for (const [requestId, pending] of pendingAdjudications) {
                    clearTimeout(pending.timer);
                    pendingAdjudications.delete(requestId);
                    pending.resolve({ action: "cancel", reason: "combat-ended" });
                }
                for (const opId of [...pendingDamage.keys()]) {
                    _releaseDamageWait(opId, "combat-ended");
                }
                for (const record of executions.values()) {
                    _releaseMarks(record);
                }
                // Run mechanic: combat end wipes every leftover evasion
                // marker on its combatants.
                try {
                    for (const c of combat?.combatants ?? []) {
                        if (c?.actor?.getFlag?.(MODULE_ID, FLAG_KEYS.running)) {
                            c.actor.unsetFlag(MODULE_ID, FLAG_KEYS.running)
                                ?.catch?.(() => {});
                        }
                    }
                } catch(_err) {
                    // Marker cleanup is best-effort.
                }
            } catch(err) {
                console.error(`${MODULE_ID} | adjudication cancel failed`, err);
            }
        });
        // Issue #56: damage cards are created (GM clicks "Damage" on the
        // attack card) and updated (each applied hit rewrites the
        // message) outside the executor — feed both events into the
        // pending waits.
        hooks.on("createChatMessage", message => {
            try {
                _onDamageMessage(message);
            } catch(err) {
                console.error(`${MODULE_ID} | damage-wait create hook failed`, err);
            }
        });
        hooks.on("updateChatMessage", message => {
            try {
                _onDamageMessage(message);
            } catch(err) {
                console.error(`${MODULE_ID} | damage-wait update hook failed`, err);
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
            ...(run?.plan?.fallbackPreset ? {
                fallbackPreset: run.plan.fallbackPreset,
                layers: { ...context.planContext?.layers, commitment: false }
            } : {}),
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
     * Shared planning entry for claimed turns and GM preview replans.
     * @param {object} context Executor context.
     * @param {object} [run] Current execution state, when available.
     * @returns {Promise<object|null>} Fresh plan result.
     */
    async function planCurrentTurn(context, run = null) {
        const planner = _planner(context);
        const combatant = run?.combatant ?? _combatantOf(context, context.combat);
        const plannedContext = _planContext(context, context.operation, run?.replanCount
            ?? _finiteOr(context.planContext?.replanCount, 0), run);
        if (!isEnabled() || !_isController(context) || typeof planner?.planTurn !== "function") return null;
        if (context.operation?.controllerId && !teamTurns.ownsTurn(context, combatant)) {
            return { status: "failed", reason: STALE_REASONS.turnStale, plan: null };
        }
        const coordinated = await teamTurns.plan(context, combatant, planner, plannedContext);
        if (context.operation?.controllerId && !teamTurns.ownsTurn(context, combatant)) {
            return { status: "failed", reason: STALE_REASONS.turnStale, plan: null };
        }
        return coordinated ?? planner.planTurn(context.combat, combatant, plannedContext);
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
                // Issue #93: statuses the plan's own steps added/removed
                // mid-execution (unpin/drop-prone) reconcile inside the
                // planner instead of reading as external drift.
                selfStatusAdjust: run.selfStatusAdjust ?? null,
                ...(context.validation ?? {})
            });
        } catch(err) {
            return { valid: false, reason: STALE_REASONS.stale };
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
        // Replanning into a solo attack would bypass a failed team barrier.
        // The next claimed turn starts fresh after discarding this maneuver.
        if (run.plan?.teamTurn) return { action: "stop", reason: failReason };
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
            const replanContext = _planContext(context, context.operation, run.replanCount, run);
            // Issue #85: a fireteam-derived focus allow-list is a heuristic
            // commitment, not a permanent hard constraint. When the focus
            // target is gone the replan must reopen the legal target pool;
            // a caller-supplied hard allow-list is restored unchanged.
            if (failReason === STALE_REASONS.targetGone
                && replanContext.focusAttackPool?.allow === true) {
                const fallback = replanContext.focusAttackPool.fallbackAttackTargetIds;
                if (Array.isArray(fallback)) replanContext.attackTargetIds = [...fallback];
                else delete replanContext.attackTargetIds;
                delete replanContext.focusAttackPool;
            }
            try {
                replanned = await planner.planTurn(
                    context.combat,
                    run.combatant,
                    replanContext
                );
            } catch(err) {
                replanned = null;
            }
            if (replanned?.status === "ok" && replanned.plan) {
                run.plan = replanned.plan;
                run.stepIndex = 0;
                // Issue #93: the fresh snapshot already carries the live
                // statuses — prior self-inflicted adjustments would
                // reconcile against the wrong baseline.
                run.selfStatusAdjust = { added: [], removed: [] };
                run.expectedPosition = _selfPosition(run.plan) ?? run.expectedPosition;
                // Issue #27: the swapped plan carries its own trace.
                run.trace = run.plan?.diagnostics?.trace ?? [];
                _capturePlanContext(context, run, replanContext);
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
        const coordinated = !!run.plan?.teamTurn;
        const teamCheck = () => {
            const check = teamTurns.validate(run.plan, context, run.combatant, _planner(context));
            return check.valid ? _validate(run, context) : check;
        };
        if (coordinated) {
            const verdict = await teamTurns.begin(run.plan, context, run.combatant, _planner(context));
            if (!verdict.valid) {
                const result = _result({
                    status: EXECUTOR_STATUS.failed, reason: verdict.reason, operationId: run.operationId,
                    planId: run.plan.id
                });
                await teamTurns.finish(run.plan, context, run.combatant, result);
                await _finish(context, run, result, teamTurns.ownsTurn(context, run.combatant, true));
                return result;
            }
        }
        const stepsDone = [];
        const resourceDelta = {};
        const chatMessageIds = [];
        let failedStep = null;
        let reason = null;
        let status = EXECUTOR_STATUS.completed;
        let irreversibleSpent = false;
        let skippedIrreversible = false;

        // Issue #32: pan the GM view onto the acting bot before its
        // first step so automated turns stay watchable.
        const botDoc = _tokenDoc(context.token ?? run.combatant?.token);
        if (getCenterOnBot()) centerOnToken(botDoc);
        // Smoke request: mark the turn like a player's — the acting bot
        // is selected and its attack target joins the GM's target set.
        // The marks live on the execution record and die with the
        // combat's turn change (updateCombat hook) so the damage card
        // keeps its target while the GM adjudicates.
        if (globalThis.game?.user?.isGM === true) {
            try {
                const marks = run.record ?? run;
                const tokens = globalThis.canvas?.tokens;
                const bot = botDoc?.id ? tokens?.get?.(botDoc.id) : null;
                if (bot && !bot.controlled) {
                    bot.control?.({ releaseOthers: true });
                    marks._controlled = bot;
                }
                const attackStep = (run.plan?.steps ?? [])
                    .find(s => s?.type === "attack" || s?.type === "test");
                const tRef = attackStep?.input?.targetTokenId
                    ?? attackStep?.input?.targetTokenUuid;
                const tId = tRef ? String(tRef).split(".").pop() : null;
                const target = tId ? tokens?.get?.(tId) : null;
                if (target) {
                    target.setTarget?.(true, { releaseOthers: true });
                    marks._targeted = target;
                }
            } catch(_err) {
                // Canvas marking is best-effort.
            }
        }

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
                // turn — replans keep the remaining budget only. A
                // zero-cost step (issue #93: the free end-of-turn unpin
                // test) sits outside the action economy: it neither is
                // blocked by a spent irreversible budget nor spends it.
                const irreversible = IRREVERSIBLE_STEP_TYPES.has(step.type)
                    && _finiteOr(step?.cost?.halves, 1) > 0;
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
                const verdict = !coordinated ? _validate(run, context)
                    : step.type === "end-turn"
                        ? { valid: teamTurns.ownsTurn(context, run.combatant, true), reason: STALE_REASONS.turnStale }
                        : teamCheck();
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
                    if (coordinated) {
                        const afterDecision = teamCheck();
                        if (!afterDecision.valid) {
                            status = EXECUTOR_STATUS.failed;
                            reason = afterDecision.reason;
                            failedStep = step.id;
                            break;
                        }
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

                const stepContext = coordinated && irreversible ? { ...context, teamCheck } : context;
                const outcome = adjudicated === "skill-test" && step.type === "attack"
                    ? await _stepRoll("test", step, stepContext, run.plan, run.operationId)
                    : await _runStep(step, stepContext, run);
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
                    // A landed attack expects the GM to roll and apply a
                    // damage card before the turn advances — the bot
                    // never applies damage itself (damage-wait below).
                    if (Number.isFinite(outcome.hits) && outcome.hits > 0) {
                        run.expectDamage = true;
                    }
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
                    // Issue #93: the plan's own end-of-turn steps mutate
                    // self statuses — a successful unpin test cleared
                    // `pinned`, a drop-prone step applied `prone`. Track
                    // those self-inflicted changes so the validation of
                    // the remaining steps (end-turn) does not read them
                    // as external drift and trigger a spurious replan.
                    if (outcome.unpinCleared === true && run.selfStatusAdjust) {
                        run.selfStatusAdjust.removed.push("pinned");
                    }
                    if (step.type === "drop-prone" && !outcome.skipped
                        && run.selfStatusAdjust) {
                        run.selfStatusAdjust.added.push(
                            step?.input?.statusId ?? "prone");
                    }
                    // Issue #25: every own move lands in the bounded
                    // `moveJournal` flag — the source of truth the L1
                    // layer uses to tell the bot's own motion apart from
                    // a GM drag when validating `expectedState.self`.
                    if (step.type === "move" && outcome.position) {
                        _noteMove(context, run, outcome.position);
                    }
                    // Run mechanic: a sprint stamps the actor `running`
                    // — the system reads the flag as the +20-evasion
                    // window vs ranged fire until the bot's next turn
                    // (cleared in the updateCombat/deleteCombat hooks).
                    if (step.type === "move" && step.input?.mode === "run"
                        && outcome.position && !outcome.skipped
                        && _isController(context)) {
                        try {
                            const flagActor = run.combatant?.actor;
                            if (flagActor && typeof flagActor.setFlag === "function") {
                                await flagActor.setFlag(MODULE_ID, FLAG_KEYS.running, {
                                    combatId: context.combat?.id ?? null,
                                    round: context.combat?.round ?? null,
                                    operationId: run.operationId ?? null
                                });
                            }
                        } catch(_err) {
                            // The evasion marker is best-effort — never fatal.
                        }
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
            if (coordinated) await teamTurns.finish(run.plan, context, run.combatant, result);
            if (reason === EXECUTOR_REASONS.adjudicationCancelled) {
                await _finish(context, run, result, false);
            }
            return result;
        }
        const result = _result({
            status,
            reason: reason ?? run.plan?.teamTurn?.reason ?? null,
            operationId: run.operationId,
            planId: run.plan?.id ?? null,
            stepsDone,
            failedStep,
            replanCount: run.replanCount,
            resourceDelta,
            chatMessageIds,
            diagnostics: run.report ?? run.plan?.diagnostics
        });
        // Damage-wait: when the turn produced a landed attack the GM
        // still has to roll the damage card and apply its hits — the
        // operation completes but `nextTurn` waits for that adjudication
        // (manual turn advance or the timeout releases the wait).
        const waiting = _registerDamageWait(context, run, result);
        if (coordinated) await teamTurns.finish(run.plan, context, run.combatant, result);
        await _finish(context, run, result, !waiting);
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
            // Issue #93: self-inflicted status changes of the plan's own
            // steps (unpin clears `pinned`, drop-prone applies `prone`) —
            // validation reconciles them instead of reading external
            // drift. Reset on every replan: the fresh snapshot already
            // carries the live statuses.
            selfStatusAdjust: { added: [], removed: [] },
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
            record: null,
            // Issue #27: the per-layer reason trace of the active plan.
            trace: plan?.diagnostics?.trace ?? []
        };
        const record = {
            promise: null,
            hookAdvanced: false,
            combatId: context.combat?.id ?? null
        };
        run.record = record;
        record.promise = (async () => {
            const early = await _preflight(context, run);
            if (early) return early;
            return _execute(context, run);
        })();
        _recordExecution(operationId, record);
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
            // Issue #93: see `executePlan` — self-inflicted status
            // changes the validation reconciles.
            selfStatusAdjust: { added: [], removed: [] },
            spent: {
                movement: _finiteOr(
                    context.spent?.movement ?? context.planContext?.spent?.movement, 0),
                halves: _finiteOr(
                    context.spent?.halves ?? context.planContext?.spent?.halves, 0)
            },
            report: null,
            record: null,
            // Issue #27: the per-layer reason trace of the active plan.
            trace: context.plan?.diagnostics?.trace ?? []
        };
        const record = {
            promise: null,
            hookAdvanced: false,
            combatId: context.combat?.id ?? null
        };
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
                    planned = await planCurrentTurn(context, run);
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
                    // Unsupported scenes remain under manual GM control.
                    await _finish(context, run, result, planned?.status !== "unsupported");
                    _report(context, run, result);
                    return result;
                }
                run.plan = planned.plan;
                run.expectedPosition = _selfPosition(run.plan);
                run.trace = run.plan?.diagnostics?.trace ?? [];
                // Issue #27: the replay capture rides the plan journal
                // when `aiCaptureContext` is on — fire-and-forget, the
                // flag write never delays the turn.
                if (!run.plan.teamTurn) {
                    _capturePlanContext(context, run, _planContext(context, context.operation, 0, run));
                }
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
        _recordExecution(operationId, record);
        return record.promise;
    }

    return {
        executePlan,
        runPlan,
        planCurrentTurn,
        /**
         * Validate a coordinated preview before the GM confirms it.
         * @param {object} plan
         * @param {object} context
         * @returns {object} Freshness verdict.
         */
        validateTeamTurn(plan, context = {}) {
            return teamTurns.validate(plan, context, _combatantOf(context, context.combat),
                _planner(context), { before: true });
        },
        /**
         * A GM taking the turn back also cancels any unfinished maneuver.
         * @param {object} plan
         * @param {object} context
         * @returns {Promise<void>}
         */
        cancelTeamTurn(plan, context = {}) {
            return teamTurns.finish(plan, context, _combatantOf(context, context.combat),
                { status: EXECUTOR_STATUS.cancelled });
        },
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
// Public surface — re-exported consts moved to executor/contract.js.
export {
    ADJUDICATION_ACTIONS,
    EXECUTOR_REASONS,
    EXECUTOR_STATUS,
    STEP_STATUS
};
