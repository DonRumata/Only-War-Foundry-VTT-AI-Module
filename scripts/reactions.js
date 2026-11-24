/**
 * Reaction bookkeeping (issue #37): the `flags["only-war-ai"].reactionUsed`
 * Combatant flag recording that a combatant already spent its single
 * reaction this round.
 *
 * Design contract:
 * - One reaction per round (Only War): the flag means "this combatant's
 *   reaction is spent for the current combat round". The writer records
 *   `{round, reason}` so readers can tell a stale record — a flag whose
 *   `round` differs from the live combat round is treated as cleared.
 * - Only the authority controller writes the flag (`authority.isController()`
 *   when the service is registered, else `game.user.isGM`); reading is
 *   always free. The flag is also readable off *other* combatants — the
 *   planner checks target combatants to score "finish the enemy who spent
 *   his reaction" attacks.
 * - The flag refreshes at the start of the owner's turn: the service
 *   listens to `updateCombat` (round/turn diffs) and clears
 *   `reactionUsed` on the new `combat.combatant`.
 * - Writers: this module never auto-spends the reaction yet — overwatch
 *   stays declare-only (GM adjudicates the shot, see `scripts/overwatch.js`)
 *   — so the intended writers are the system side (a future `evasionTest`
 *   flow), GM macros (`api.services.get("reactions").markUsed`) and any
 *   integration that resolves an NPC reaction manually. Keeping the flag
 *   is cheap insurance: when a writer appears, the readers here and in the
 *   planner already honour it.
 */
import { FLAG_KEYS, MODULE_ID } from "./constants.js";

/** Stable machine-readable reasons returned by reaction operations. */
export const REACTION_REASONS = Object.freeze({
    notController: "not-controller",
    noCombatant: "no-combatant",
    flagWriteFailed: "flag-write-failed"
});

/**
 * Whether a sanitized `reactionUsed` flag record counts as spent during
 * `round`. A record without a usable `round` number counts conservatively
 * as spent (writers may omit it); a finite `round` must match the live
 * combat round exactly.
 * @param {object|boolean|null} record Flag payload.
 * @param {number|null|undefined} round Live combat round (null = unknown).
 * @returns {boolean}
 */
export function reactionUsed(record, round) {
    if (record === true) return true;
    if (!record || typeof record !== "object") return false;
    const flagged = Number.isFinite(record.round) ? record.round : null;
    if (flagged === null) return true;
    return !Number.isFinite(round) || flagged === round;
}

/**
 * Read a module flag without mutating the document: `getFlag` first, then
 * the raw `flags` object for plain fixtures.
 * @param {object} doc
 * @param {string} key
 * @returns {*}
 */
function _readFlag(doc, key) {
    if (!doc || typeof doc !== "object") return undefined;
    if (typeof doc.getFlag === "function") {
        try {
            return doc.getFlag(MODULE_ID, key);
        } catch(_err) {
            return undefined;
        }
    }
    return doc.flags?.[MODULE_ID]?.[key];
}

/**
 * Iterate a Foundry Collection/array/iterable uniformly.
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
 * Whether an `updateCombat` diff describes a turn/round transition —
 * mirrors the authority service's relevance filter.
 * @param {object} change
 * @returns {boolean}
 */
function _isTurnChange(change) {
    return Boolean(change)
        && (change.turn !== undefined || change.round !== undefined);
}

/**
 * Create the `reactions` service published as `api.services.get("reactions")`.
 * Flag writes go through the authority controller check; reads are free.
 * @param {object} [deps]
 * @param {object} [deps.api] Module API for lazy service lookups.
 * @param {object} [deps.hooks] Hooks registry (Foundry `Hooks` in tests).
 * @returns {object} Reactions service.
 */
export function createReactionsService({ api = null, hooks = null } = {}) {
    const H = hooks ?? globalThis.Hooks ?? null;
    let _started = false;
    const _registered = [];

    /**
     * Lazy authority service lookup (safe when the service is absent).
     * @returns {object|null}
     */
    function _authority() {
        try {
            return api?.services?.get?.("authority") ?? null;
        } catch(err) {
            return null;
        }
    }

    /**
     * Whether this client is allowed to write reaction flags.
     * @returns {boolean}
     */
    function _isController() {
        const authority = _authority();
        if (authority && typeof authority.isController === "function") {
            try {
                return authority.isController() === true;
            } catch(err) {
                return false;
            }
        }
        return globalThis.game?.user?.isGM === true;
    }

    /**
     * Read the spent-reaction verdict of a combatant, tolerant of a stale
     * `round` recorded on the flag.
     * @param {object|null} combatant
     * @param {object|null} [combat] Live combat for the round check.
     * @returns {boolean}
     */
    function reactionUsedOf(combatant, combat = null) {
        const record = _readFlag(combatant, FLAG_KEYS.reactionUsed);
        const round = Number.isFinite(combat?.round) ? combat.round : null;
        return reactionUsed(record, round);
    }

    /**
     * Mark a combatant's reaction as spent for the current round. Only the
     * authority controller writes; the call is a no-op elsewhere.
     * @param {object} input
     * @param {object|null} input.combat Active combat (provides the round).
     * @param {object|null} input.combatant Combatant spending its reaction.
     * @param {string|null} [input.reason] Free-form reason (audit trail).
     * @returns {Promise<object>} `{ok, record?|reason}`.
     */
    async function markUsed({ combat = null, combatant = null, reason = null } = {}) {
        if (!_isController()) return { ok: false, reason: REACTION_REASONS.notController };
        if (typeof combatant?.setFlag !== "function") {
            return { ok: false, reason: REACTION_REASONS.noCombatant };
        }
        const record = {
            round: combat?.round ?? null,
            reason: typeof reason === "string" ? reason : null
        };
        try {
            await combatant.setFlag(MODULE_ID, FLAG_KEYS.reactionUsed, record);
        } catch(err) {
            return {
                ok: false,
                reason: REACTION_REASONS.flagWriteFailed,
                error: String(err?.message ?? err)
            };
        }
        return { ok: true, record };
    }

    /**
     * Mark the combatant owning `tokenId` as reaction-spent — the
     * convenient entry point for the system side or GM macros working off
     * tokens rather than combatants.
     * @param {object|null} combat Active combat.
     * @param {string|null} tokenId Token id of the reacting combatant.
     * @param {object} [options]
     * @param {string|null} [options.reason] Free-form reason.
     * @returns {Promise<object>} `{ok, record?|reason}`.
     */
    async function markUsedByToken(combat, tokenId, { reason = null } = {}) {
        const combatant = _list(combat?.combatants)
            .find(entry => (entry?.tokenId ?? entry?.token?.id) === tokenId) ?? null;
        if (!combatant) return { ok: false, reason: REACTION_REASONS.noCombatant };
        return markUsed({ combat, combatant, reason });
    }

    /**
     * Clear a combatant's reaction flag (round refresh, manual reset).
     * Only the controller writes; a missing flag is a silent no-op.
     * @param {object|null} combatant
     * @returns {Promise<object>} `{ok}`.
     */
    async function clear(combatant) {
        if (!_isController()) return { ok: false };
        if (typeof combatant?.unsetFlag !== "function") return { ok: false };
        try {
            await combatant.unsetFlag(MODULE_ID, FLAG_KEYS.reactionUsed);
        } catch(err) {
            return { ok: false };
        }
        return { ok: true };
    }

    /**
     * `updateCombat` handler: on a turn/round transition the combatant
     * whose turn just started gets its reaction back (Only War: the
     * reaction refreshes at the start of your turn).
     * @param {object} combat
     * @param {object} change
     */
    function _onUpdateCombat(combat, change) {
        if (!_isTurnChange(change)) return;
        const current = combat?.combatant ?? null;
        if (!current || !reactionUsedOf(current, combat)) return;
        if (!_isController()) return;
        Promise.resolve(clear(current)).catch(() => {});
    }

    /**
     * Register the watcher hooks driving the per-turn refresh.
     * @returns {void}
     */
    function _subscribe() {
        if (!H || _registered.length) return;
        if (typeof H.on === "function") {
            _registered.push(["updateCombat", H.on("updateCombat", _onUpdateCombat)]);
        }
    }

    /**
     * Remove every previously registered watcher hook.
     * @returns {void}
     */
    function _unsubscribe() {
        while (_registered.length) {
            const [name, id] = _registered.pop();
            try {
                if (typeof H?.off === "function") H.off(name, id);
            } catch(err) {
                // Hook teardown is best effort.
            }
        }
    }

    return {
        /** Register watcher hooks (called on `ready`). */
        start() {
            if (_started) return;
            _started = true;
            _subscribe();
        },
        /** Remove watcher hooks. */
        stop() {
            _started = false;
            _unsubscribe();
        },
        get started() { return _started; },
        reactionUsedOf,
        markUsed,
        markUsedByToken,
        clear,
        /**
         * The `updateCombat` handler — also callable directly by
         * integrations/tests driving their own combat diffs.
         * @param {object} combat
         * @param {object} change
         */
        handleUpdateCombat(combat, change) {
            _onUpdateCombat(combat, change);
        },
        reasons: REACTION_REASONS
    };
}
