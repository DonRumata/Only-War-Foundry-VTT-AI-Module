/**
 * Executor decomposition (issue #407 follow-up): extracted verbatim from
 * scripts/executor.js — see that file for the design contract. Sub-factory
 * env objects destructure to the identifiers the moved code already used.
 */
import {
    MODULE_ID
} from "../constants.js";
import {
    getDamageWaitTimeoutSeconds
} from "../settings.js";

/**
 * The createDamageWait sub-factory — an extracted block of
 * createExecutorService (issue #407). The env object carries the closure
 * identifiers the moved code referenced: shared state maps, service
 * lookups and sibling helpers wired in executor.js.
 * @param {object} [env]
 * @param {*} [env._advanceForOperation] Closure dependency.
 * @param {*} [env._isController] Closure dependency.
 * @param {*} [env.log] Closure dependency.
 * @param {*} [env.pendingDamage] Closure dependency.
 * @returns {object} Block handlers.
 */
export function createDamageWait({
    _advanceForOperation,
    _isController,
    log,
    pendingDamage
} = {}) {

    /**
     * Read the damage-roll descriptor of a chat message — `null` for
     * anything that is not an `isDamageRoll` card. The system stores the
     * whole `rollData` (including the step's `apiOperationId`) under
     * `flags["only-war-local"].rollData`.
     * @param {string} id Chat message id.
     * @returns {object|null}
     */
    function _damageRollOf(id) {
        try {
            const message = globalThis.game?.messages?.get?.(id);
            const rollData = message?.getRollData?.() ?? null;
            return rollData?.flags?.isDamageRoll === true ? rollData : null;
        } catch(err) {
            return null;
        }
    }


    /**
     * Whether every hit on a damage card is already applied
     * (`damage.applied === true`) — the state the system's
     * `onApplyDamageHitClick` writes back through a message update. A
     * card without hits settles immediately.
     * @param {object} rollData Damage-roll descriptor.
     * @returns {boolean}
     */
    function _damageCardSettled(rollData) {
        const damages = Array.isArray(rollData?.damages) ? rollData.damages : [];
        return damages.every(damage => damage?.applied === true);
    }


    /**
     * Damage-wait registration (issue #56): a landed bot attack defers
     * `nextTurn` while the GM rolls the damage card and applies its
     * hits — the bot never applies damage itself. Damage cards already
     * produced by the step (grenade `skipAttackRoll`, suppression hits)
     * join the watch directly; an ordinary hit only sets `expect` so the
     * first card carrying the step's `apiOperationId` links itself in.
     * Release paths: every watched card applied, a manual turn advance
     * (`updateCombat`), combat end, or the `damageWaitTimeoutSeconds`
     * timeout.
     * @param {object} context
     * @param {object} run Shared execution state.
     * @param {object} result Public result summary.
     * @returns {boolean} `true` when the turn advance is deferred.
     */
    function _registerDamageWait(context, run, result) {
        const watch = new Set();
        for (const id of result.chatMessageIds ?? []) {
            const rollData = _damageRollOf(id);
            if (rollData && !_damageCardSettled(rollData)) watch.add(id);
        }
        const expect = run.expectDamage === true && watch.size === 0;
        if (!watch.size && !expect) return false;
        const timeout = getDamageWaitTimeoutSeconds();
        pendingDamage.set(run.operationId, {
            combat: context.combat ?? null,
            combatId: context.combat?.id ?? null,
            operation: context.operation ?? run.operation ?? run.plan?.snapshot ?? null,
            watch,
            expect,
            context,
            timer: timeout > 0
                ? setTimeout(
                    () => _releaseDamageWait(run.operationId, "damage-wait-timeout"),
                    timeout * 1000)
                : null
        });
        return true;
    }


    /**
     * Feed a created/updated chat message into the pending damage waits.
     * A damage card carrying the step's `apiOperationId`
     * (`<operationId>.<stepId>`) links itself to the operation's watch;
     * watched cards settle as their hits get applied. When the entry is
     * complete — nothing expected and nothing unsettled — the deferred
     * turn advance fires.
     * @param {object} message ChatMessage document.
     * @returns {void}
     */
    function _onDamageMessage(message) {
        if (!pendingDamage.size) return;
        const rollData = message?.getRollData?.() ?? null;
        if (rollData?.flags?.isDamageRoll !== true) return;
        const messageId = message?.id ?? null;
        if (!messageId) return;
        const apiOp = typeof rollData.apiOperationId === "string"
            ? rollData.apiOperationId : null;
        for (const [opId, entry] of [...pendingDamage]) {
            const linked = apiOp !== null && apiOp.startsWith(`${opId}.`);
            if (linked) {
                entry.expect = false;
                if (!_damageCardSettled(rollData)) entry.watch.add(messageId);
            }
            if (entry.watch.has(messageId) && _damageCardSettled(rollData)) {
                entry.watch.delete(messageId);
            }
            if (entry.expect !== true && entry.watch.size === 0) {
                _releaseDamageWait(opId, "damage-applied");
            }
        }
    }


    /**
     * Close a pending damage wait and, unless the combat already moved
     * on, drive the deferred `nextTurn` through the same serialized
     * path the operation-completed hook uses.
     * @param {string} opId Executor operation id.
     * @param {string} reason Release cause for diagnostics.
     * @returns {void}
     */
    function _releaseDamageWait(opId, reason) {
        const entry = pendingDamage.get(opId);
        if (!entry) return;
        pendingDamage.delete(opId);
        if (entry.timer) clearTimeout(entry.timer);
        const combat = entry.combat;
        if (!combat || combat.ended === true || combat.destroyed === true) return;
        if (!_isController(entry.context)) return;
        if (typeof combat.nextTurn !== "function") return;
        log(`damage wait ${opId} resolved (${reason}); advancing`);
        _advanceForOperation(combat, entry.operation, entry.context ?? {})
            .catch(err => console.error(`${MODULE_ID} | damage-wait advance failed`, err));
    }

    return {
        _damageRollOf,
        _damageCardSettled,
        _registerDamageWait,
        _onDamageMessage,
        _releaseDamageWait
    };
}
