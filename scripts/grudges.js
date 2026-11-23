/**
 * Grudge bookkeeping (issue #39): the `flags["only-war-ai"].lastAttacker`
 * Combatant flag recording who last hurt a combatant, read by the
 * planner's `grudge` factor.
 *
 * Design contract:
 * - The flag record `{tokenUuid, tokenId, actorId, round, turn,
 *   woundsLost, attribution}` identifies the last attacker. Only the
 *   authority controller writes it (`authority.isController()` when the
 *   service is registered, else `game.user.isGM`); reading is free.
 * - Attribution is conservative: the service listens to `updateActor`
 *   and reacts to *lost* wounds (the system's `system.wounds` track
 *   counts up — the watched total is `wounds.value + wounds.critical`).
 *   Because the Foundry hook only carries new values, a per-actor
 *   in-memory cache holds the last observed total. The attacker is
 *   resolved from targeted chat cards only — the system's
 *   `damageOperation` summary card ("Applied Damage To") naming the
 *   victim plus its source damage card, or a damage card whose recorded
 *   per-hit `targetActorId`/`targetTokenId` marks the bot. No
 *   heuristics: an untargeted card never writes a grudge and self-damage
 *   is always ignored.
 * - Expiry: a record older than {@link GRUDGE_MAX_AGE_ROUNDS} combat
 *   rounds is inactive; a dead (defeated/destroyed) attacker carries no
 *   grudge either. The flag never enters the planner stale fingerprint —
 *   a fresh hit must not force a replan.
 */
import { FLAG_KEYS, MODULE_ID } from "./constants.js";

/**
 * Rounds a `lastAttacker` record stays active after the round it was
 * written (issue #39 spec allows 2–3): a record of round `r` scores
 * through `r + 2` and expires at `r + 3`.
 */
export const GRUDGE_MAX_AGE_ROUNDS = 2;

/** Stable machine-readable reasons returned by grudge operations. */
export const GRUDGE_REASONS = Object.freeze({
    notController: "not-controller",
    noCombatant: "no-combatant",
    noAttribution: "no-attribution",
    flagWriteFailed: "flag-write-failed"
});

/** Chat-flag scope of the host system. */
const SYSTEM_SCOPE = "only-war-local";

/**
 * Whether a `lastAttacker` record is still live for `round`: a record
 * without a usable `round` counts conservatively as active (writers may
 * omit it); a finite `round` must sit within
 * {@link GRUDGE_MAX_AGE_ROUNDS} of the live combat round.
 * @param {object|null} record Flag payload.
 * @param {number|null|undefined} round Live combat round (null = unknown).
 * @returns {boolean}
 */
export function grudgeActive(record, round) {
    if (!record || typeof record !== "object") return false;
    if (record.tokenUuid == null && record.tokenId == null && record.actorId == null) {
        return false;
    }
    const flagged = Number.isFinite(record.round) ? record.round : null;
    if (flagged === null || !Number.isFinite(round)) return true;
    return flagged <= round && (round - flagged) <= GRUDGE_MAX_AGE_ROUNDS;
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
 * Read a system-namespaced flag payload off a chat message.
 * @param {object} message Chat message.
 * @param {string} key Flag key inside `flags["only-war-local"]`.
 * @returns {*}
 */
function _systemFlag(message, key) {
    if (!message || typeof message !== "object") return undefined;
    if (typeof message.getFlag === "function") {
        try {
            return message.getFlag(SYSTEM_SCOPE, key);
        } catch(_err) {
            return undefined;
        }
    }
    return message.flags?.[SYSTEM_SCOPE]?.[key];
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
 * Watched wound total of an actor — `wounds.value + wounds.critical` of
 * the system's wounds track (`actor.wounds` proxy first, then the
 * `system.wounds` record of plain fixtures).
 * @param {object|null} actor
 * @returns {number|null}
 */
function _woundTotal(actor) {
    const wounds = actor?.wounds ?? actor?.system?.wounds ?? null;
    if (!wounds || typeof wounds !== "object") return null;
    const value = Number(wounds.value) || 0;
    const critical = Number(wounds.critical) || 0;
    return value + critical;
}

/**
 * Attacker identity of a roll card: the recorded owner/token ids first,
 * then the chat speaker references. `tokenId`/`actorId` may be null when
 * the card does not name them.
 * @param {object|null} rollData `flags["only-war-local"].rollData`.
 * @param {object|null} message Owning chat message.
 * @returns {{tokenId: string|null, actorId: string|null, sceneId: string|null}}
 */
function _attackerOf(rollData, message) {
    const speaker = message?.speaker ?? rollData?.speaker ?? {};
    return {
        tokenId: rollData?.tokenId ?? speaker.token ?? null,
        actorId: rollData?.ownerId ?? speaker.actor ?? null,
        sceneId: speaker.scene ?? null
    };
}

/**
 * Whether the damage-operation summary card names the damaged actor as
 * its target.
 * @param {object} operation `flags["only-war-local"].damageOperation`.
 * @param {object} input Damaged-actor identity.
 * @param {string|null} input.actorId Damaged actor id.
 * @param {string|null} input.actorUuid Damaged actor uuid.
 * @param {string|null} input.tokenId Damaged actor's token id.
 * @returns {boolean}
 */
function _operationTargetsActor(operation, { actorId, actorUuid, tokenId }) {
    const target = operation?.target ?? {};
    if (actorId && target.actorId === actorId) return true;
    if (actorUuid && target.actorUuid === actorUuid) return true;
    return Boolean(tokenId) && (target.tokenId === tokenId || target.tokenUuid === tokenId);
}

/**
 * Finalize an attribution candidate: reject entries without an attacker
 * identity, self-damage and — when the attacker token resolves —
 * non-hostile speakers. An unresolvable token keeps the candidate: a
 * targeted card is already strong evidence and hostility cannot be
 * disproved.
 * @param {object} candidate `{tokenId, actorId, sceneId}` attacker refs.
 * @param {object} input Extraction input.
 * @returns {object|null} `{tokenUuid, tokenId, actorId, sceneId}`.
 */
function _acceptAttacker(candidate, input) {
    if (!candidate || (candidate.tokenId == null && candidate.actorId == null)) return null;
    if (candidate.actorId != null && candidate.actorId === input.actorId) return null;
    if (candidate.tokenId != null && candidate.tokenId === input.selfTokenId) return null;
    const doc = typeof input.findToken === "function"
        ? input.findToken(candidate.tokenId ?? candidate.actorId)
        : null;
    if (doc && Number.isFinite(input.disposition)) {
        const sa = Math.sign(Number.isFinite(input.disposition) ? input.disposition : 0);
        const sb = Math.sign(Number.isFinite(doc.disposition) ? doc.disposition : 0);
        // A resolved same-side token cannot be the hostile attacker —
        // friendly fire is not a grudge (issue #39 conservative rule).
        if (sa !== 0 && sa === sb) return null;
    }
    return {
        tokenUuid: doc?.uuid ?? (candidate.tokenId && candidate.sceneId
            ? `Scene.${candidate.sceneId}.Token.${candidate.tokenId}` : null),
        tokenId: candidate.tokenId ?? null,
        actorId: candidate.actorId ?? doc?.actor?.id ?? null
    };
}

/**
 * Attribute the attacker of the most recent damage event against an
 * actor from the chat log — pure/extractable for tests. Scans the newest
 * messages first and accepts only *targeted* evidence (issue #39):
 *
 * 1. A `damageOperation` summary card (`"Applied Damage To"`) whose
 *    `target` names the actor; its `source.messageId` points at the
 *    damage card that names the attacker. Attribution
 *    `"damage-operation"`.
 * 2. A damage card whose recorded `rollData.damages[]` entries carry
 *    `targetActorId`/`targetTokenId` of the actor (applied hits and
 *    suppression assignments). Attribution `"applied-damage"`.
 *
 * Self-damage never produces a grudge; untargeted cards (the attacker
 * swung at nothing the log can prove) return `null` instead of a guess.
 * @param {object} input
 * @param {object[]} input.messages Chat messages (any iterable; the last
 *   entries win — the collection is scanned newest-first).
 * @param {string|null} input.actorId Damaged actor id.
 * @param {string|null} [input.actorUuid] Damaged actor uuid.
 * @param {string|null} [input.tokenId] Damaged actor's token id.
 * @param {string|null} [input.selfTokenId] Same as `tokenId` — kept a
 *   separate name so the self-exclusion reads explicitly.
 * @param {Function|null} [input.findToken] `(tokenId) => tokenDoc|null`
 *   for disposition/uuid resolution.
 * @param {number|null} [input.disposition] Damaged token's disposition
 *   for the same-side exclusion.
 * @param {number} [input.maxScan] Scan bound (default 50 messages).
 * @returns {object|null} `{tokenUuid, tokenId, actorId, attribution,
 *   sourceMessageId}` or null.
 */
export function attributeLastAttacker({
    messages = [],
    actorId = null,
    actorUuid = null,
    tokenId = null,
    selfTokenId = null,
    findToken = null,
    disposition = null,
    maxScan = 50
} = {}) {
    const list = _list(messages);
    const byId = new Map(list.map(message => [message?.id, message]));
    const scoped = { actorId, actorUuid, tokenId, selfTokenId: selfTokenId ?? tokenId,
        findToken, disposition };
    const seen = new Set();
    // Newest-first scan over the last `maxScan` messages.
    for (let i = list.length - 1, scanned = 0; i >= 0 && scanned < maxScan; i--, scanned++) {
        const message = list[i];
        if (!message || seen.has(message.id)) continue;
        seen.add(message.id);
        const operation = _systemFlag(message, "damageOperation");
        if (operation && _operationTargetsActor(operation, { actorId, actorUuid, tokenId })) {
            const source = byId.get(operation?.source?.messageId) ?? null;
            const rollData = _systemFlag(source, "rollData") ?? source?.rollData ?? null;
            const candidate = _acceptAttacker(_attackerOf(rollData, source), scoped);
            if (candidate) {
                return { ...candidate, attribution: "damage-operation",
                    sourceMessageId: source?.id ?? operation?.source?.messageId ?? null };
            }
        }
        const rollData = _systemFlag(message, "rollData") ?? null;
        const damages = Array.isArray(rollData?.damages) ? rollData.damages : [];
        const targeted = damages.some(damage => damage
            && ((actorId && damage.targetActorId === actorId)
                || (tokenId && damage.targetTokenId === tokenId)));
        if (!targeted) continue;
        const candidate = _acceptAttacker(_attackerOf(rollData, message), scoped);
        if (candidate) {
            return { ...candidate, attribution: "applied-damage",
                sourceMessageId: message.id ?? null };
        }
    }
    return null;
}

/**
 * Create the `grudges` service published as `api.services.get("grudges")`.
 * Writes go through the authority controller check; reads are free.
 * @param {object} [deps]
 * @param {object} [deps.api] Module API for lazy service lookups.
 * @param {object} [deps.hooks] Hooks registry (Foundry `Hooks` in tests).
 * @param {Function} [deps.getCombat] `() => game.combat`.
 * @param {Function} [deps.getCombats] `() => game.combats`.
 * @param {Function} [deps.getMessages] `() => game.messages`.
 * @param {Function} [deps.log] Diagnostic logger.
 * @returns {object} Grudges service.
 */
export function createGrudgesService({
    api = null,
    hooks = null,
    getCombat = () => globalThis.game?.combat ?? null,
    getCombats = () => globalThis.game?.combats ?? null,
    getMessages = () => globalThis.game?.messages ?? null,
    log = (...args) => console.log(...args)
} = {}) {
    const H = hooks ?? globalThis.Hooks ?? null;
    let _started = false;
    const _registered = [];
    /** Last observed wound totals per actor id (hook carries no old value). */
    const _woundCache = new Map();

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
     * Whether this client is allowed to write grudge flags.
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
     * Token document lookup for attacker resolution: combat combatants
     * first, then the live canvas, then the current scene's collection.
     * @param {string|null} tokenId
     * @param {object|null} combat Combat hint (searched first).
     * @returns {object|null}
     */
    function _findToken(tokenId, combat = null) {
        if (!tokenId) return null;
        const combats = combat ? [combat] : _list(getCombats());
        for (const fight of combats) {
            for (const combatant of _list(fight?.combatants)) {
                const doc = combatant?.token?.document ?? combatant?.token ?? null;
                if (doc && (doc.id === tokenId || combatant.tokenId === tokenId)) return doc;
            }
        }
        const placeables = _list(globalThis.canvas?.tokens?.placeables);
        for (const token of placeables) {
            const doc = token?.document ?? token;
            if (doc?.id === tokenId) return doc;
        }
        const sceneTokens = _list(globalThis.canvas?.scene?.tokens ?? globalThis.game?.scenes?.current?.tokens);
        for (const token of sceneTokens) {
            const doc = token?.document ?? token;
            if (doc?.id === tokenId) return doc;
        }
        return null;
    }

    /**
     * Find the combatant of `actorId` inside a combat.
     * @param {object|null} combat
     * @param {string} actorId
     * @returns {object|null}
     */
    function _combatantOfActor(combat, actorId) {
        for (const combatant of _list(combat?.combatants)) {
            const actor = combatant?.actor ?? combatant?.token?.actor ?? null;
            if (actor && actor.id === actorId) return combatant;
            if (combatant?.actorId === actorId) return combatant;
            const doc = combatant?.token?.document ?? combatant?.token ?? null;
            if (doc?.actor?.id === actorId) return combatant;
        }
        return null;
    }

    /**
     * Read the active `lastAttacker` record of a combatant: `null` when
     * the flag is absent, expired ({@link GRUDGE_MAX_AGE_ROUNDS}) or the
     * attacker can be proven dead inside `combat` (defeated combatant or
     * destroyed token). An attacker missing from the combat keeps the
     * record — absence cannot disprove a grudge.
     * @param {object|null} combatant
     * @param {object|null} [combat] Live combat for the round/liveness check.
     * @returns {object|null}
     */
    function grudgeOf(combatant, combat = null) {
        const record = _readFlag(combatant, FLAG_KEYS.lastAttacker);
        const round = Number.isFinite(combat?.round) ? combat.round : null;
        if (!grudgeActive(record, round)) return null;
        if (combat) {
            const attacker = (record.tokenId && _combatantOfToken(combat, record.tokenId))
                ?? (record.actorId ? _combatantOfActor(combat, record.actorId) : null);
            if (attacker) {
                const doc = attacker.token?.document ?? attacker.token ?? null;
                if (attacker.defeated === true || attacker.destroyed === true
                    || doc?.destroyed === true) return null;
            }
        }
        return record;
    }

    /**
     * Combatant lookup by token id inside a combat.
     * @param {object|null} combat
     * @param {string} tokenId
     * @returns {object|null}
     */
    function _combatantOfToken(combat, tokenId) {
        for (const combatant of _list(combat?.combatants)) {
            const doc = combatant?.token?.document ?? combatant?.token ?? null;
            if (doc?.id === tokenId || combatant?.tokenId === tokenId) return combatant;
        }
        return null;
    }

    /**
     * `updateActor` handler: track the wound cache and, on a loss,
     * attribute the attacker through targeted chat cards and record
     * `lastAttacker` on the matching combatant. Controller-only writes;
     * the cache tracks on every client so a later election stays sane.
     * @param {object} actor Actor document (post-update).
     * @param {object} [_change] Update diff (unused — the cache compares).
     * @returns {Promise<object>} `{ok, record?|reason}`.
     */
    async function _onUpdateActor(actor, _change) {
        if (!actor?.id) return { ok: false, reason: "no-actor" };
        const total = _woundTotal(actor);
        if (total === null) return { ok: false, reason: "no-wounds" };
        const previous = _woundCache.get(actor.id);
        _woundCache.set(actor.id, total);
        if (previous === undefined) return { ok: true, attributed: false, reason: "seeded" };
        const woundsLost = total - previous;
        if (woundsLost <= 0) return { ok: true, attributed: false, reason: "no-loss" };
        if (!_isController()) {
            return { ok: false, reason: GRUDGE_REASONS.notController };
        }
        const combats = _list(getCombats());
        const active = getCombat();
        if (active && !combats.includes(active)) combats.unshift(active);
        let combat = null;
        let combatant = null;
        for (const fight of combats) {
            const found = _combatantOfActor(fight, actor.id);
            if (found) {
                combat = fight;
                combatant = found;
                break;
            }
        }
        if (!combatant || typeof combatant.setFlag !== "function") {
            return { ok: false, reason: GRUDGE_REASONS.noCombatant };
        }
        const botToken = combatant.token?.document ?? combatant.token ?? null;
        const attacker = attributeLastAttacker({
            messages: _list(getMessages()),
            actorId: actor.id,
            actorUuid: actor.uuid ?? null,
            tokenId: botToken?.id ?? combatant.tokenId ?? null,
            findToken: tokenId => _findToken(tokenId, combat),
            disposition: Number.isFinite(botToken?.disposition)
                ? botToken.disposition
                : (Number.isFinite(combatant.disposition) ? combatant.disposition : null)
        });
        if (!attacker) {
            return { ok: false, reason: GRUDGE_REASONS.noAttribution };
        }
        const record = {
            tokenUuid: attacker.tokenUuid ?? null,
            tokenId: attacker.tokenId ?? null,
            actorId: attacker.actorId ?? null,
            round: Number.isFinite(combat?.round) ? combat.round : null,
            turn: Number.isFinite(combat?.turn) ? combat.turn : null,
            woundsLost,
            attribution: attacker.attribution ?? "targeted-card"
        };
        try {
            await combatant.setFlag(MODULE_ID, FLAG_KEYS.lastAttacker, record);
        } catch(err) {
            return {
                ok: false,
                reason: GRUDGE_REASONS.flagWriteFailed,
                error: String(err?.message ?? err)
            };
        }
        log("grudge recorded", { combatant: combatant.id, attacker: record.actorId });
        return { ok: true, attributed: true, record };
    }

    /**
     * Seed the wound cache from live actor documents (issue #39 review):
     * without a baseline the first `updateActor` only seeds and the first
     * wound loss after `ready` goes unattributed. Combatant actors get a
     * dedicated pass so a client joining mid-combat still tracks them.
     * @param {object|null} [combat] When given, seed only its actors.
     * @returns {void}
     */
    function _seedWoundCache(combat = null) {
        if (combat) {
            for (const combatant of _list(combat?.combatants)) {
                const actor = combatant?.actor ?? combatant?.token?.actor ?? null;
                const total = _woundTotal(actor);
                if (actor?.id && total !== null) _woundCache.set(actor.id, total);
            }
            return;
        }
        for (const actor of _list(globalThis.game?.actors)) {
            const total = _woundTotal(actor);
            if (actor?.id && total !== null) _woundCache.set(actor.id, total);
        }
    }

    /**
     * Register the watcher hook driving the wound tracker.
     * @returns {void}
     */
    function _subscribe() {
        if (!H || _registered.length) return;
        if (typeof H.on === "function") {
            _registered.push(["updateActor", H.on("updateActor", _onUpdateActor)]);
            // A combat created after `ready` seeds its combatants'
            // baselines so its very first wound loss can attribute.
            _registered.push(["createCombat", H.on("createCombat", combat => {
                try {
                    _seedWoundCache(combat);
                } catch(err) {
                    console.error(`${MODULE_ID} | grudges seed failed`, err);
                }
            })]);
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
            _seedWoundCache();
        },
        /** Remove watcher hooks and drop the wound cache. */
        stop() {
            _started = false;
            _unsubscribe();
            _woundCache.clear();
        },
        get started() { return _started; },
        grudgeOf,
        /**
         * The `updateActor` handler — also callable directly by
         * integrations/tests driving their own actor diffs.
         * @param {object} actor
         * @param {object} [change]
         * @returns {Promise<object>}
         */
        handleUpdateActor(actor, change) {
            return _onUpdateActor(actor, change);
        },
        /**
         * Test/inspection helper: seed or reset the wound cache.
         * @param {string|null} [actorId] Single actor id or all when null.
         * @param {number|null} [total] Wound total to seed (omit to clear).
         */
        seedWounds(actorId = null, total = null) {
            if (actorId === null) {
                _woundCache.clear();
                return;
            }
            if (total === null) _woundCache.delete(actorId);
            else _woundCache.set(actorId, total);
        },
        reasons: GRUDGE_REASONS,
        maxAgeRounds: GRUDGE_MAX_AGE_ROUNDS
    };
}
