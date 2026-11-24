/**
 * Executor decomposition (issue #407 follow-up): extracted verbatim from
 * scripts/executor.js — see that file for the design contract. Sub-factory
 * env objects destructure to the identifiers the moved code already used.
 */
import {
    FLAG_KEYS,
    MODULE_ID,
    REQUIRED_SYSTEM_ID
} from "../constants.js";
import {
    STALE_REASONS
} from "../planner.js";
import {
    EXECUTOR_REASONS,
    ROLL_API
} from "./contract.js";
import {
    _docPoint,
    _finiteOr,
    _movePayload,
    _rollInput,
    _tokenDoc
} from "./util.js";

/**
 * The createStepHandlers sub-factory — an extracted block of
 * createExecutorService (issue #407). The env object carries the closure
 * identifiers the moved code referenced: shared state maps, service
 * lookups and sibling helpers wired in executor.js.
 * @param {object} [env]
 * @param {*} [env._rolls] Closure dependency.
 * @param {*} [env._service] Closure dependency.
 * @param {*} [env.api] Closure dependency.
 * @returns {object} Block handlers.
 */
export function createStepHandlers({
    _rolls,
    _service,
    api
} = {}) {

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
        const team = context.teamCheck?.();
        if (team?.valid === false) return { ok: false, reason: team.reason };
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
            duplicate: outcome.duplicate === true,
            hits: Number.isFinite(outcome.roll?.hits) ? outcome.roll.hits : null
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
     * Execute a `delay` step (issue #38): the combatant delays its turn
     * until the synchronized strike — it writes the *system* flag
     * `flags["only-war-local"].delayed` (the Only War tracker state that
     * `clearExpiredStates` clears when the next turn begins), not the
     * module namespace — plus the module bookkeeping record `delaySync`
     * `{round, until, count}` the fireteam `maxSyncRounds` guard counts.
     * Controller-gated exactly like `_stepAim`: the executor only reaches
     * this point after the per-step controller check. A combatant that is
     * already delayed is idempotent — the step still succeeds and only
     * refreshes `delaySync`.
     * @param {object} step
     * @param {object} context
     * @param {object} run Shared execution state.
     * @returns {Promise<object>} Step outcome.
     */
    async function _stepDelay(step, context, run) {
        const input = step?.input ?? {};
        const combatant = run.combatant;
        if (typeof combatant?.setFlag !== "function") return { ok: true };
        try {
            await combatant.setFlag(REQUIRED_SYSTEM_ID, "delayed", true);
            const prev = combatant.getFlag?.(MODULE_ID, FLAG_KEYS.delaySync)
                ?? combatant.flags?.[MODULE_ID]?.[FLAG_KEYS.delaySync]
                ?? null;
            const count = prev && prev.until === (input.until ?? null)
                && Number.isFinite(prev.count) ? prev.count + 1 : 1;
            await combatant.setFlag(MODULE_ID, FLAG_KEYS.delaySync, {
                round: Number.isFinite(input.round)
                    ? input.round
                    : (context.combat?.round ?? null),
                until: input.until ?? null,
                count
            });
        } catch(err) {
            return {
                ok: false,
                reason: "flag-write-failed",
                error: String(err?.message ?? err)
            };
        }
        return { ok: true };
    }


    /**
     * Post-stamp `flags["only-war-ai"].lastOrder` after a successful order
     * test (issue #38): `{round, orderId, result}` — the fireteam
     * `ORDER_COOLDOWN_ROUNDS` gate reads `round`. Flag writes fail silent:
     * the order already landed, the cooldown record is bookkeeping.
     * @param {object} step
     * @param {object} context
     * @param {object} run Shared execution state.
     * @returns {Promise<void>}
     */
    async function _recordLastOrder(step, context, run) {
        const combatant = run.combatant;
        if (typeof combatant?.setFlag !== "function") return;
        try {
            await combatant.setFlag(MODULE_ID, FLAG_KEYS.lastOrder, {
                round: context.combat?.round ?? null,
                orderId: step?.input?.orderId ?? null,
                result: "success"
            });
        } catch(err) {
            // Cooldown bookkeeping is best-effort — the roll already landed.
        }
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
        // Issue #54: a `shape:"blast"` input carries the trigger-circle
        // fields (`targetPoint`/`blastRadius`); cone inputs keep the
        // legacy flat `direction`/`arc`/`range`.
        const outcome = await overwatch.declare({
            combat: context.combat,
            combatant: run.combatant,
            spec: {
                direction: input.direction,
                arc: input.arc,
                range: input.range,
                shape: input.shape ?? null,
                targetPoint: input.targetPoint ?? null,
                blastRadius: input.blastRadius ?? null,
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
        if (record.itemUuid || record.itemId || record.name) {
            try {
                await run.combatant.setFlag(MODULE_ID, FLAG_KEYS.lastUsedWeapon, record);
            } catch(err) {
                // Inertia bookkeeping is best-effort — the shot already landed.
            }
        }
        // Sticky-target memory (smoke finding): the planner's
        // `stickyTarget` factor keeps a bot on the target it already
        // engaged instead of ping-ponging between charge options.
        const target = {
            tokenUuid: input.targetTokenUuid ?? input.targetUuid ?? null,
            tokenId: input.targetTokenId ?? null,
            actorId: input.targetActorId ?? null,
            round: context.combat?.round ?? null,
            turn: context.combat?.turn ?? null
        };
        if (!target.tokenUuid && !target.tokenId && !target.actorId) return;
        try {
            await run.combatant.setFlag(MODULE_ID, FLAG_KEYS.lastTarget, target);
        } catch(err) {
            // Target bookkeeping is best-effort — the shot already landed.
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
                // Issue #38: a successful order test post-stamps
                // `lastOrder` — the fireteam cooldown gate reads it.
                if (outcome.ok && step.type === "test" && step?.input?.orderId) {
                    await _recordLastOrder(step, context, run);
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
            case "delay":
                return _stepDelay(step, context, run);
            case "end-turn":
                return { ok: true };
            default:
                return { ok: false, reason: EXECUTOR_REASONS.invalidStep };
        }
    }

    return {
        _stepMove,
        _stepRoll,
        _stepAim,
        _stepDelay,
        _recordLastOrder,
        _stepReload,
        _stepOverwatch,
        _stepReadyWeapon,
        _stepDropProne,
        _recordLastUsedWeapon,
        _runStep
    };
}
