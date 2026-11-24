/**
 * Executor decomposition (issue #407 follow-up): extracted verbatim from
 * scripts/executor.js — see that file for the design contract. Sub-factory
 * env objects destructure to the identifiers the moved code already used.
 */
import {
    MODULE_ID
} from "../constants.js";
import {
    ADVANCE_VERIFY_RETRIES,
    ADVANCE_VERIFY_WINDOWS
} from "./contract.js";
import {
    _sleep
} from "./util.js";

/**
 * The createTurnAdvance sub-factory — an extracted block of
 * createExecutorService (issue #407). The env object carries the closure
 * identifiers the moved code referenced: shared state maps, service
 * lookups and sibling helpers wired in executor.js.
 * @param {object} [env]
 * @param {*} [env._isController] Closure dependency.
 * @param {*} [env.log] Closure dependency.
 * @param {*} [env.pacing] Closure dependency.
 * @returns {object} Block handlers.
 */
export function createTurnAdvance({
    _isController,
    log,
    pacing
} = {}) {

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
        if (!combat || combat.ended === true || combat.destroyed === true) return false;
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
                // Combat deleted mid-verify: the op's turn can never
                // advance — bail instead of spamming nextTurn errors.
                if (combat.destroyed === true || combat.ended === true) return true;
                const before = key();
                // Pacing before the advance keeps each bot's turn visible.
                if (attempt === 0 && pacing() > 0) await _sleep(pacing());
                try {
                    await combat.nextTurn();
                } catch(err) {
                    // `endCombat()` can land mid-verify — in v13 the doc's
                    // `destroyed` flag may not be set when the throw hits,
                    // so membership in the collection is the honest check.
                    const gone = combat.destroyed === true || combat.ended === true
                        || (globalThis.game?.combats && !globalThis.game.combats.get(combat.id));
                    if (!gone) {
                        console.error(`${MODULE_ID} | nextTurn failed`, err);
                    }
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
        if (context.combat?.ended === true || context.combat?.destroyed === true) return;
        if (!_isController(context)) return;
        if (typeof context.combat?.nextTurn !== "function") return;
        // Direct runPlan/executePlan callers carry no `operation` — the
        // plan snapshot's round/turn still scopes the advance so a
        // manually-moved turn is not advanced a second time.
        await _advanceForOperation(context.combat,
            context.operation ?? run.operation ?? run.plan?.snapshot ?? null, context);
    }

    return {
        _advanceForOperation,
        _advanceTurn
    };
}
