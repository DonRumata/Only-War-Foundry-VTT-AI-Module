/**
 * Recover-pinned pure tactics core (issue #90, epic #84).
 *
 * This module is deliberately document-free: every world fact is supplied as
 * a plain serializable DTO or an injected probe. It implements only the pure
 * overlay kernel — attribution of the pinning source, triage between several
 * pinned members, the marginal-value gate and selection of the single
 * cover-fire donor. Fireteam/planner/executor integration is intentionally
 * outside this file.
 *
 * Design contract:
 * - Pin-source attribution is confidence ordered: a recorded suppression
 *   chat card (3), the victim's fresh `lastAttacker` grudge (2), the nearest
 *   hostile with line of sight on the victim (1), then `unknown` (0).
 * - Pointed cover-fire assignments are legal only at confidence >= 2. A
 *   confidence-1 hypothesis may become a soft redirect; `unknown` never
 *   creates fire into empty space.
 * - At most one cover-fire donor is selected. Valid L1 commitments,
 *   detached flank/assault assignments, GM-controlled members, melee
 *   participants, desperate regrouping members and members that already
 *   acted in the round are never sacrificed for recovery.
 * - Every output is plain JSON-compatible data. Diagnostics carry the
 *   experimental thresholds explicitly so tuning remains explainable.
 */

/** System chat-flag scope read by the recorded-attribution scan. */
const SYSTEM_SCOPE = "only-war-local";

/** Role markers used by the recover-pinned overlay. */
export const RECOVER_PINNED_ROLES = Object.freeze({
    coverFire: "cover-fire",
    recovering: "recovering"
});

/** Cover-fire mode variants described by the pure overlay. */
export const RECOVER_COVER_MODES = Object.freeze([
    "suppression",
    "direct",
    "overwatch"
]);

/** Stable gate reasons of {@link evaluateRecoverGate}. */
export const RECOVER_GATE_REASONS = Object.freeze({
    active: "active",
    noPinned: "no-pinned",
    noDonors: "no-donors",
    allPinned: "all-pinned",
    safeInCoverUnreachable: "safe-in-cover-unreachable",
    sourceDead: "source-dead",
    pinnedInMelee: "pinned-in-melee"
});

/** Stable cover-donor selection reasons of {@link selectCoverMember}. */
export const RECOVER_COVER_REASONS = Object.freeze({
    selected: "selected",
    unknownSource: "unknown-source",
    lowConfidence: "low-confidence",
    sourceDead: "source-dead",
    sourceUnreachable: "source-unreachable",
    noDonors: "no-donors"
});

/** Stable reasons for which a donor is excluded from the pool. */
export const RECOVER_DONOR_EXCLUSIONS = Object.freeze({
    pinned: "pinned",
    defeated: "defeated",
    disabled: "disabled",
    gmControlled: "gm-controlled",
    inMelee: "in-melee",
    detachedAssignment: "detached-assignment",
    commitmentProtected: "commitment-protected",
    regroupDesperate: "regroup-desperate",
    hasActed: "has-acted",
    notAttackCapable: "not-attack-capable",
    criticalAssignment: "critical-assignment"
});

/**
 * Experimental numeric constants of the v1 overlay. They are exported and
 * echoed into diagnostics rather than hidden inside the scoring branches.
 */
export const RECOVER_PINNED_THRESHOLDS = Object.freeze({
    attribution: Object.freeze({
        recorded: 3,
        grudge: 2,
        losNearest: 1,
        minPinpointConfidence: 2
    }),
    chat: Object.freeze({
        maxScan: 50
    }),
    grudge: Object.freeze({
        maxRoundAge: 1
    }),
    cover: Object.freeze({
        safeEstimate: 0.5
    }),
    melee: Object.freeze({
        defaultReach: 2
    }),
    triage: Object.freeze({
        leaderValue: 4,
        supportWeaponValue: 2,
        maneuverCriticalBonus: 2
    }),
    donor: Object.freeze({
        suppressionCapable: 4,
        lineOfSight: 3,
        lastTarget: 2,
        naturalTarget: 1,
        soleObjective: -3
    })
});

/** Explicit alias making the experimental status clear at call sites. */
export const RECOVER_PINNED_EXPERIMENTAL_THRESHOLDS = RECOVER_PINNED_THRESHOLDS;

/** Overlay modes produced by the gate/builder. */
export const RECOVER_OVERLAY_MODES = Object.freeze({
    inactive: "inactive",
    full: "full",
    redirectOnly: "redirect-only",
    individualOnly: "individual-only"
});

/**
 * Normalize a Foundry collection/Map/array/iterable into a plain array.
 * @param {*} collection Collection-like input.
 * @returns {object[]}
 */
function _list(collection) {
    if (!collection) return [];
    if (Array.isArray(collection)) return collection;
    if (Array.isArray(collection.contents)) return collection.contents;
    if (typeof collection.values === "function") return [...collection.values()];
    if (typeof collection[Symbol.iterator] === "function") return [...collection];
    if (typeof collection === "object") {
        // A single DTO is valid input in the pure API. Without this guard its
        // property values would be mistaken for a keyed collection's entries.
        const recordKeys = ["combatantId", "tokenId", "tokenUuid", "actorId", "id",
            "statuses", "pinned", "position"];
        if (recordKeys.some(key => Object.prototype.hasOwnProperty.call(collection, key))) {
            return [collection];
        }
        return Object.values(collection);
    }
    return [];
}

/**
 * Numeric helper: value when finite, otherwise fallback.
 * @param {*} value Candidate number.
 * @param {number} fallback Fallback number.
 * @returns {number}
 */
function _finiteOr(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}

/**
 * Clamp a number into `[0, 1]`.
 * @param {*} value Candidate number.
 * @returns {number}
 */
function _clamp01(value) {
    return Math.max(0, Math.min(1, _finiteOr(value, 0)));
}

/**
 * Deterministic ascending id comparison independent of locale collation.
 * @param {*} a First id.
 * @param {*} b Second id.
 * @returns {number}
 */
function _compareIds(a, b) {
    const left = String(a ?? "");
    const right = String(b ?? "");
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

/**
 * Return a plain JSON clone, dropping `undefined` leaves exactly as JSON
 * serialization would. Inputs are already acyclic plain DTOs by contract.
 * @param {*} value Serializable value.
 * @returns {*}
 */
function _jsonClone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

/**
 * Read a system-namespaced flag payload from either a plain fixture or a
 * document-like object with `getFlag`.
 * @param {object} message Chat-message-like object.
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
 * Position DTO of a token/member/contact record. `position` wins over raw
 * `x`/`y`; absent coordinates become nulls rather than throwing.
 * @param {object|null} entity Plain entity DTO.
 * @returns {{x: number|null, y: number|null}|null}
 */
function _positionOf(entity) {
    if (!entity || typeof entity !== "object") return null;
    const source = entity.position ?? entity.center ?? entity;
    const x = source?.x;
    const y = source?.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
}

/**
 * Euclidean distance between two position DTOs.
 * @param {object|null} a First position.
 * @param {object|null} b Second position.
 * @returns {number}
 */
function _distance(a, b) {
    if (!Number.isFinite(a?.x) || !Number.isFinite(a?.y)
        || !Number.isFinite(b?.x) || !Number.isFinite(b?.y)) {
        return Number.POSITIVE_INFINITY;
    }
    return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Normalize status input (Set/array/object map) into a string Set.
 * @param {*} source Status collection.
 * @returns {Set<string>}
 */
function _statusSet(source) {
    const ids = new Set();
    if (!source) return ids;
    if (typeof source[Symbol.iterator] === "function") {
        for (const id of source) ids.add(String(id));
    } else if (typeof source === "object") {
        for (const key of Object.keys(source)) {
            if (source[key]) ids.add(String(key));
        }
    }
    return ids;
}

/**
 * Status ids of a member DTO, merged from the common plain-fixture shapes.
 * @param {object|null} member Member DTO.
 * @returns {Set<string>}
 */
function _memberStatuses(member) {
    const ids = new Set();
    for (const source of [member?.statuses, member?.statusIds, member?.token?.statuses,
        member?.actor?.statuses]) {
        for (const id of _statusSet(source)) ids.add(id);
    }
    return ids;
}

/**
 * Whether a plain member/token record is pinned.
 * @param {object|null} member Member DTO.
 * @returns {boolean}
 */
function _isPinned(member) {
    return member?.pinned === true || _memberStatuses(member).has("pinned");
}

/**
 * Whether a plain record is dead for tactical purposes. Absence of the
 * record is not proof of death; this predicate only reads explicit data.
 * @param {object|null} entity Entity DTO.
 * @returns {boolean}
 */
function _isDead(entity) {
    if (!entity || typeof entity !== "object") return false;
    const statuses = _statusSet(entity.statuses ?? entity.token?.statuses);
    return entity.dead === true || entity.defeated === true || entity.destroyed === true
        || entity.token?.destroyed === true || statuses.has("dead") || statuses.has("defeated");
}

/**
 * Whether a member is enabled for AI planning. Missing data means enabled;
 * only explicit `false` disables a pure DTO.
 * @param {object|null} member Member DTO.
 * @returns {boolean}
 */
function _isEnabled(member) {
    return member?.enabled !== false && member?.aiEnabled !== false;
}

/**
 * Best combatant-like id of a member DTO.
 * @param {object|null} member Member DTO.
 * @returns {string|null}
 */
function _memberId(member) {
    const id = member?.combatantId ?? member?.id ?? member?.tokenId ?? member?.tokenUuid ?? null;
    return id == null ? null : String(id);
}

/**
 * Whether two references can identity-match through token, actor or
 * combatant ids. A string reference is compared against every known id.
 * @param {object|null} entity Entity DTO.
 * @param {*} reference Identity reference object or id string.
 * @returns {boolean}
 */
function _matchesIdentity(entity, reference) {
    if (!entity || reference == null) return false;
    if (typeof reference === "string" || typeof reference === "number") {
        const wanted = String(reference);
        return [entity.combatantId, entity.tokenId, entity.tokenUuid, entity.actorId, entity.id]
            .some(id => id != null && String(id) === wanted);
    }
    const left = [entity.tokenId, entity.id].filter(id => id != null).map(String);
    const right = [reference.tokenId, reference.id].filter(id => id != null).map(String);
    if (left.some(id => right.includes(id))) return true;
    if (entity.tokenUuid != null && reference.tokenUuid != null
        && String(entity.tokenUuid) === String(reference.tokenUuid)) return true;
    if (entity.actorId != null && reference.actorId != null
        && String(entity.actorId) === String(reference.actorId)) return true;
    if (entity.combatantId != null && reference.combatantId != null
        && String(entity.combatantId) === String(reference.combatantId)) return true;
    return false;
}

/**
 * Whether the source is the pinned member itself.
 * @param {object} source Source identity.
 * @param {object} pinned Pinned member DTO.
 * @returns {boolean}
 */
function _isSelfPin(source, pinned) {
    return _matchesIdentity(pinned, source) || _matchesIdentity(source, pinned);
}

/**
 * Sign of a Foundry disposition-like number; non-numbers count as unknown.
 * @param {*} disposition Disposition value.
 * @returns {number}
 */
function _dispositionSign(disposition) {
    return Number.isFinite(disposition) ? Math.sign(disposition) : 0;
}

/**
 * Proven same-side relation. Unresolvable dispositions never disprove an
 * attribution; only positive evidence rejects it.
 * @param {object|null} sourceEntity Resolved source entity.
 * @param {object|null} pinned Pinned member DTO.
 * @returns {boolean}
 */
function _provenSameSide(sourceEntity, pinned) {
    const own = _dispositionSign(pinned?.disposition ?? pinned?.token?.disposition);
    const other = _dispositionSign(sourceEntity?.disposition ?? sourceEntity?.token?.disposition);
    return own !== 0 && other !== 0 && own === other;
}

/**
 * All injected entity/contact arrays in their resolution precedence.
 * @param {object} input Pure input object.
 * @returns {object[]}
 */
function _entities(input = {}) {
    return [
        ..._list(input.hostiles),
        ..._list(input.threats),
        ..._list(input.targets),
        ..._list(input.tokens),
        ..._list(input.contacts)
    ];
}

/**
 * Resolve an identity in the injected plain entity arrays, optionally using
 * an injected `resolveToken` probe as a last resort.
 * @param {object|null} identity Identity DTO.
 * @param {object} input Pure input object.
 * @returns {object|null}
 */
function _resolveEntity(identity, input = {}) {
    if (!identity) return null;
    for (const entity of _entities(input)) {
        if (_matchesIdentity(entity, identity)) return entity;
    }
    if (typeof input.resolveToken === "function") {
        for (const key of [identity.tokenId, identity.tokenUuid, identity.actorId]) {
            if (key == null) continue;
            try {
                const found = input.resolveToken(key);
                if (found) return found;
            } catch(_err) {
                // Resolution probes are best-effort pure inputs.
            }
        }
    }
    return null;
}

/**
 * Read a keyed value from either a Map or a plain object using all known
 * identities of the member.
 * @param {*} keyed Map/plain object.
 * @param {object} member Member DTO.
 * @returns {*}
 */
function _keyedValue(keyed, member) {
    if (!keyed) return undefined;
    const keys = [member?.combatantId, member?.id, member?.tokenId, member?.tokenUuid, member?.actorId]
        .filter(key => key != null).map(String);
    if (keyed instanceof Map) {
        for (const key of keys) {
            if (keyed.has(key)) return keyed.get(key);
        }
        return undefined;
    }
    if (Array.isArray(keyed)) {
        return keyed.find(entry => _matchesIdentity(member, entry) || _matchesIdentity(entry, member));
    }
    if (typeof keyed === "object") {
        for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(keyed, key)) return keyed[key];
        }
    }
    return undefined;
}

/**
 * Extract the attacker identity of a suppression roll card.
 * @param {object|null} rollData System roll data.
 * @param {object|null} message Owning chat message.
 * @returns {{tokenId: string|null, actorId: string|null, sceneId: string|null}}
 */
function _attackerOf(rollData, message) {
    const speaker = message?.speaker ?? rollData?.speaker ?? {};
    return {
        tokenId: rollData?.tokenId ?? rollData?.attackerTokenId ?? speaker.token ?? null,
        actorId: rollData?.ownerId ?? rollData?.attackerId ?? speaker.actor ?? null,
        sceneId: speaker.scene ?? rollData?.sceneId ?? null
    };
}

/**
 * Whether one `pinnedResults` entry proves that the input victim was pinned.
 * @param {object} result Pin result entry.
 * @param {object} pinned Pinned victim DTO.
 * @returns {boolean}
 */
function _pinResultMatches(result, pinned) {
    if (!result || result.pinned !== true) return false;
    const target = {
        tokenId: result.tokenId ?? result.targetTokenId ?? null,
        tokenUuid: result.tokenUuid ?? result.targetTokenUuid ?? null,
        actorId: result.actorId ?? result.targetActorId ?? null
    };
    return _matchesIdentity(pinned, target);
}

/**
 * Finalize an attribution candidate into the serializable contract shape.
 * @param {string} method Attribution method.
 * @param {number} confidence Confidence level.
 * @param {object} candidate Candidate identity.
 * @param {object} input Pure input object.
 * @returns {object|null}
 */
function _finalizeAttribution(method, confidence, candidate, input) {
    if (!candidate || (candidate.tokenId == null && candidate.actorId == null
        && candidate.tokenUuid == null)) return null;
    const entity = _resolveEntity(candidate, input);
    if (_isSelfPin(candidate, input.pinned ?? {})) return null;
    if (_provenSameSide(entity, input.pinned)) return null;
    const position = _positionOf(entity) ?? _positionOf(candidate) ?? null;
    const tokenUuid = candidate.tokenUuid ?? entity?.tokenUuid ?? entity?.uuid
        ?? (candidate.tokenId && candidate.sceneId
            ? `Scene.${candidate.sceneId}.Token.${candidate.tokenId}` : null);
    return _jsonClone({
        method,
        confidence,
        tokenId: candidate.tokenId ?? entity?.tokenId ?? entity?.id ?? null,
        tokenUuid,
        actorId: candidate.actorId ?? entity?.actorId ?? null,
        position
    });
}

/**
 * Newest-first scan of suppression-fire chat cards. Only cards whose system
 * `rollData` carries `flags.isSuppressingFire` and a positive pinned result
 * for the victim are evidence; self-pinning and proven same-side cards are
 * rejected. The scan is bounded exactly like grudge attribution.
 * @param {object} input Pure attribution input.
 * @returns {object|null} Confidence-3 attribution or null.
 */
function _recordedPinSource(input) {
    const list = _list(input.messages ?? input.chatMessages ?? input.chat);
    const maxScan = Math.max(0, _finiteOr(input.maxScan, RECOVER_PINNED_THRESHOLDS.chat.maxScan));
    const seen = new Set();
    for (let index = list.length - 1, scanned = 0; index >= 0 && scanned < maxScan; index--, scanned++) {
        const message = list[index];
        if (!message) continue;
        const key = message.id ?? message._id ?? index;
        if (seen.has(key)) continue;
        seen.add(key);
        const rollData = _systemFlag(message, "rollData") ?? message.rollData ?? null;
        const suppressing = rollData?.flags?.isSuppressingFire === true
            || rollData?.isSuppressingFire === true;
        if (!suppressing) continue;
        const results = Array.isArray(rollData?.pinnedResults) ? rollData.pinnedResults : [];
        if (!results.some(result => _pinResultMatches(result, input.pinned))) continue;
        const attribution = _finalizeAttribution(
            "recorded",
            RECOVER_PINNED_THRESHOLDS.attribution.recorded,
            _attackerOf(rollData, message),
            input
        );
        if (attribution) return attribution;
    }
    return null;
}

/**
 * Whether the grudge record is fresh enough for pin attribution. The
 * recover overlay deliberately uses the tighter issue-90 window (current or
 * previous round), not the longer damage-grudge scoring window.
 * @param {object|null} record `lastAttacker` record.
 * @param {number|null} round Current combat round.
 * @returns {boolean}
 */
function _freshPinGrudge(record, round) {
    if (!record || typeof record !== "object") return false;
    if (record.tokenUuid == null && record.tokenId == null && record.actorId == null) return false;
    if (!Number.isFinite(record?.round) || !Number.isFinite(round)) return true;
    const age = round - record.round;
    return age >= 0 && age <= RECOVER_PINNED_THRESHOLDS.grudge.maxRoundAge;
}

/**
 * Confidence-2 attribution through the victim's fresh `lastAttacker` record.
 * @param {object} input Pure attribution input.
 * @returns {object|null}
 */
function _grudgePinSource(input) {
    const pinned = input.pinned ?? {};
    const record = input.grudge ?? input.lastAttacker ?? pinned.grudge ?? pinned.lastAttacker ?? null;
    const round = Number.isFinite(input.round) ? input.round
        : (Number.isFinite(input.currentRound) ? input.currentRound : null);
    if (!_freshPinGrudge(record, round)) return null;
    const candidate = {
        tokenUuid: record.tokenUuid ?? null,
        tokenId: record.tokenId ?? null,
        actorId: record.actorId ?? null,
        sceneId: record.sceneId ?? null
    };
    const entity = _resolveEntity(candidate, input);
    if (entity && _isDead(entity)) return null;
    return _finalizeAttribution(
        "grudge",
        RECOVER_PINNED_THRESHOLDS.attribution.grudge,
        candidate,
        input
    );
}

/**
 * Threat value used only for deterministic los-nearest tie breaks.
 * @param {object} entity Hostile contact DTO.
 * @returns {number}
 */
function _threatValue(entity) {
    return _finiteOr(entity?.threat ?? entity?.threatEv ?? entity?.danger ?? entity?.score, 0);
}

/**
 * Probe boolean values while treating probe exceptions as "not proven".
 * @param {Function|null} probe Injected probe.
 * @param {...*} args Probe arguments.
 * @returns {boolean|null} Boolean result, or null when no probe/answer exists.
 */
function _probeBoolean(probe, ...args) {
    if (typeof probe !== "function") return null;
    try {
        const value = probe(...args);
        return typeof value === "boolean" ? value : null;
    } catch(_err) {
        return false;
    }
}

/**
 * Resolve the injected LOS probe under its documented alias spellings.
 * @param {object} input Pure input object.
 * @returns {Function|null}
 */
function _losProbe(input = {}) {
    return input.hasLineOfSight ?? input.hasLOS ?? input.losProbe ?? null;
}

/**
 * Confidence-1 nearest-hostile hypothesis. The caller injects both the
 * hostile contact set and the LOS probe; no canvas/document lookup happens
 * here. Distance ties go to the larger threat value, then tokenUuid/id asc.
 * @param {object} input Pure attribution input.
 * @returns {object|null}
 */
function _losNearestPinSource(input) {
    const pinned = input.pinned ?? {};
    const pinnedPosition = _positionOf(pinned);
    const hostiles = _list(input.hostiles ?? input.threats ?? input.targets);
    let best = null;
    for (const hostile of hostiles) {
        if (!hostile || _isDead(hostile) || hostile.hidden === true) continue;
        if (_isSelfPin(hostile, pinned) || _provenSameSide(hostile, pinned)) continue;
        const explicit = typeof hostile.losToPinned === "boolean" ? hostile.losToPinned : null;
        const probed = explicit ?? _probeBoolean(_losProbe(input), hostile, pinned);
        if (probed !== true) continue;
        const position = _positionOf(hostile);
        if (!position || !pinnedPosition) continue;
        const candidate = {
            entity: hostile,
            distance: _distance(position, pinnedPosition),
            threat: _threatValue(hostile)
        };
        if (!best || candidate.distance < best.distance - 1e-9
            || (Math.abs(candidate.distance - best.distance) <= 1e-9
                && (candidate.threat > best.threat
                    || (candidate.threat === best.threat
                        && _compareIds(hostile.tokenUuid ?? hostile.tokenId ?? hostile.actorId,
                            best.entity.tokenUuid ?? best.entity.tokenId ?? best.entity.actorId) < 0)))) {
            best = candidate;
        }
    }
    if (!best) return null;
    const entity = best.entity;
    return _finalizeAttribution(
        "los-nearest",
        RECOVER_PINNED_THRESHOLDS.attribution.losNearest,
        {
            tokenId: entity.tokenId ?? entity.id ?? null,
            tokenUuid: entity.tokenUuid ?? entity.uuid ?? null,
            actorId: entity.actorId ?? null,
            sceneId: entity.sceneId ?? null
        },
        input
    );
}

/**
 * Attribute the likely source of a pinned member's suppression. The result
 * is confidence ordered and stateless; every probe/entity is injected.
 *
 * Canonical input:
 * `{pinned, messages, round, grudge, hostiles, tokens, hasLineOfSight,
 * maxScan}`. `hostiles`/`tokens` are plain DTOs with ids, optional
 * `position`/`x`/`y`, `disposition`, `dead`/`defeated`/`destroyed`.
 * @param {object} input Pure attribution input.
 * @returns {object} `{method, confidence, tokenId, tokenUuid, actorId,
 *   position}` or `{method:"unknown", confidence:0}`.
 */
export function attributePinSource(input = {}) {
    const scoped = { ...input, pinned: input.pinned ?? input.member ?? {} };
    return _recordedPinSource(scoped)
        ?? _grudgePinSource(scoped)
        ?? _losNearestPinSource(scoped)
        ?? { method: "unknown", confidence: 0 };
}

/**
 * Call or read a numeric member property. Function probes receive
 * `(position, threatPosition, member)`; keyed objects use member ids.
 * @param {*} source Number/function/map source.
 * @param {object} member Member DTO.
 * @param {object|null} threatPosition Threat position.
 * @returns {number|null}
 */
function _numericMemberValue(source, member, threatPosition = null) {
    if (Number.isFinite(source)) return source;
    if (source && typeof source === "object") {
        const keyed = _keyedValue(source, member);
        return Number.isFinite(keyed) ? keyed : null;
    }
    if (typeof source === "function") {
        try {
            const value = source(_positionOf(member), threatPosition, member);
            return Number.isFinite(value) ? value : null;
        } catch(_err) {
            return null;
        }
    }
    return null;
}

/**
 * Nearest living hostile by plain geometry, without an LOS requirement.
 * @param {object} member Member DTO.
 * @param {object[]} hostiles Hostile contact DTOs.
 * @returns {object|null}
 */
function _nearestHostile(member, hostiles = []) {
    const position = _positionOf(member);
    if (!position) return null;
    let best = null;
    for (const hostile of hostiles) {
        if (!hostile || _isDead(hostile) || _isSelfPin(hostile, member) || _provenSameSide(hostile, member)) {
            continue;
        }
        const hostilePosition = _positionOf(hostile);
        if (!hostilePosition) continue;
        const distance = _distance(position, hostilePosition);
        if (!best || distance < best.distance - 1e-9
            || (Math.abs(distance - best.distance) <= 1e-9
                && _compareIds(hostile.tokenUuid ?? hostile.tokenId,
                    best.entity.tokenUuid ?? best.entity.tokenId) < 0)) {
            best = { entity: hostile, distance };
        }
    }
    return best?.entity ?? null;
}

/**
 * Normalize a legacy string/object assignment into the object assignment
 * contract of epic #84. Unknown additional fields are not preserved here;
 * recovery outputs construct their own serializable superset.
 * @param {*} raw Assignment string/object.
 * @returns {object}
 */
export function normalizeAssignment(raw = null) {
    if (typeof raw === "string") return { task: raw };
    if (!raw || typeof raw !== "object") return {};
    const normalized = {
        task: typeof raw.task === "string" ? raw.task : undefined,
        role: typeof raw.role === "string" ? raw.role : undefined,
        element: raw.element ?? raw.groupId ?? undefined,
        objective: raw.objective ?? undefined
    };
    return _jsonClone(normalized) ?? {};
}

/**
 * Assignment belonging to a member inside the input DTO. Explicit member
 * data wins, then an assignment map/object/array supplied to the pure core.
 * @param {object} member Member DTO.
 * @param {object} input Pure input object.
 * @returns {object}
 */
function _assignmentFor(member, input = {}) {
    const direct = member?.assignment ?? (typeof member?.task === "string" ? member.task : null);
    if (direct) return normalizeAssignment(direct);
    const keyed = _keyedValue(input.assignments, member);
    if (keyed) return normalizeAssignment(keyed);
    for (const assignment of _list(input.assignmentList)) {
        if (_matchesIdentity(member, assignment)) return normalizeAssignment(assignment);
    }
    return {};
}

/**
 * Whether a boolean member/injection value is explicitly true.
 * @param {object} member Member DTO.
 * @param {object} input Pure input object.
 * @param {string} key Member key.
 * @param {string} injection Input injection key.
 * @returns {boolean}
 */
function _injectedMemberFlag(member, input, key, injection) {
    if (typeof member?.[key] === "boolean") return member[key];
    const keyed = _keyedValue(input?.[injection], member);
    if (typeof keyed === "boolean") return keyed;
    if (typeof input?.[injection] === "function") {
        try {
            return input[injection](member) === true;
        } catch(_err) {
            return false;
        }
    }
    return false;
}

/**
 * Whether a member can reach protective cover according to explicit pure
 * input. Missing information is conservative (`false`) for gate activation.
 * @param {object} member Member DTO.
 * @param {object} input Pure input object.
 * @returns {boolean}
 */
function _canReachCover(member, input = {}) {
    if (typeof member?.canReachCover === "boolean") return member.canReachCover;
    if (typeof member?.coverReachable === "boolean") return member.coverReachable;
    return _injectedMemberFlag(member, input, "canReachCover", "canReachCover");
}

/**
 * Whether a member is in melee for the recovery gate. Explicit booleans win;
 * proximity inference is opt-in because the pure core does not know the
 * caller's coordinate units.
 * @param {object} member Member DTO.
 * @param {object} input Pure input object.
 * @returns {boolean}
 */
function _inMelee(member, input = {}) {
    if (typeof member?.inMelee === "boolean") return member.inMelee;
    if (typeof member?.meleeEngaged === "boolean") return member.meleeEngaged;
    if (typeof member?.engaged === "boolean") return member.engaged;
    if (_injectedMemberFlag(member, input, "inMelee", "inMelee")) return true;
    const reach = _finiteOr(input.meleeReach, Number.NaN);
    if (!Number.isFinite(reach)) return false;
    const nearest = _nearestHostile(member, _list(input.hostiles ?? input.threats));
    const distance = _distance(_positionOf(member), _positionOf(nearest));
    return distance <= reach;
}

/**
 * Active-commitment predicate. Both compact booleans and serializable
 * commitment records are accepted; only active/valid records protect a
 * donor under priority rule R1.
 * @param {object} member Member DTO.
 * @returns {boolean}
 */
function _hasActiveCommitment(member) {
    if (typeof member?.activeCommitment === "boolean") return member.activeCommitment;
    if (typeof member?.hasCommitment === "boolean") return member.hasCommitment;
    const record = member?.commitment ?? member?.committedPlan ?? null;
    if (!record) return false;
    if (record === true) return true;
    if (typeof record.active === "boolean") return record.active;
    if (typeof record.valid === "boolean") return record.valid;
    return ["active", "valid", "committed"].includes(record.status);
}

/**
 * Whether a member carries suppression-capable equipment/actions.
 * @param {object} member Member DTO.
 * @returns {boolean}
 */
function _suppressionCapable(member) {
    if (typeof member?.suppressionCapable === "boolean") return member.suppressionCapable;
    if (member?.loadout?.suppression === true || member?.loadout?.suppressionCapable === true) return true;
    for (const action of _list(member?.actions)) {
        const type = action?.attackType ?? action?.type ?? action?.id;
        if (type === "suppressing_fire" && action?.available !== false) return true;
    }
    for (const weapon of _list(member?.weapons)) {
        const rate = weapon?.rateOfFire ?? weapon?.system?.rateOfFire ?? {};
        const modes = weapon?.modes ?? weapon?.system?.modes ?? {};
        if (weapon?.suppressionCapable === true || rate?.fullAuto || rate?.semiAuto
            || modes.fullAuto || modes.semiAuto || modes.full || modes.semi) return true;
    }
    return false;
}

/**
 * Whether a member has any attack-capable action. Missing action details are
 * conservative; integration should normalize this flag explicitly.
 * @param {object} member Member DTO.
 * @returns {boolean}
 */
function _attackCapable(member) {
    if (typeof member?.attackCapable === "boolean") return member.attackCapable;
    if (typeof member?.canAttack === "boolean") return member.canAttack;
    for (const action of _list(member?.actions)) {
        const type = action?.type ?? action?.actionType ?? null;
        if ((type === "attack" || action?.attackType) && action?.available !== false) return true;
    }
    if (_list(member?.weapons).some(weapon => weapon?.usable !== false)) return true;
    return false;
}

/**
 * Whether a member is ranged-capable enough for the declare-only overwatch
 * fallback. An explicit attack capability is treated as ranged only when no
 * finer weapon data exists — the caller owns normalization.
 * @param {object} member Member DTO.
 * @returns {boolean}
 */
function _rangedCapable(member) {
    if (typeof member?.rangedCapable === "boolean") return member.rangedCapable;
    if (_suppressionCapable(member)) return true;
    for (const action of _list(member?.actions)) {
        const kind = action?.class ?? action?.weaponClass ?? action?.system?.class;
        if (kind === "ranged" && action?.available !== false) return true;
    }
    for (const weapon of _list(member?.weapons)) {
        const kind = weapon?.class ?? weapon?.system?.class;
        if (kind === "ranged" && weapon?.usable !== false) return true;
    }
    return _attackCapable(member);
}

/**
 * Score several pinned members for recovery triage. Ordering is exactly the
 * issue-90 lexicographic order: exposure desc, member value desc, active
 * maneuver-critical commitment bonus desc, combatant id asc.
 *
 * `exposure = dangerAt(position) - coverEstimate(position, nearestThreat)`.
 * Explicit per-member `danger`/`coverEstimate` numbers win over injected
 * probes. Accessibility (`canReachCover`) is reported for the gate but does
 * not alter the specified triage order.
 * @param {object|object[]} input Pure input `{pinned, dangerAt,
 *   coverEstimate, hostiles, attributions}` or the pinned array itself.
 * @returns {object[]} Sorted serializable triage entries with `rank`.
 */
export function scorePinnedTriage(input = {}) {
    const scoped = Array.isArray(input) ? { pinned: input } : (input ?? {});
    const pinned = scoped.pinned
        ? (Array.isArray(scoped.pinned) ? _list(scoped.pinned) : [scoped.pinned])
        : _list(scoped.members).filter(member => _isPinned(member));
    const hostiles = _list(scoped.hostiles ?? scoped.threats);
    const entries = pinned.map(member => {
        const nearest = _nearestHostile(member, hostiles);
        const threatPosition = _positionOf(member?.threat) ?? _positionOf(nearest);
        const explicitExposure = Number.isFinite(member?.exposure) ? member.exposure : null;
        const danger = Number.isFinite(member?.danger)
            ? member.danger
            : (_numericMemberValue(scoped.dangerAt, member, threatPosition) ?? 0);
        const cover = Number.isFinite(member?.coverEstimate)
            ? member.coverEstimate
            : (Number.isFinite(member?.cover)
                ? member.cover
                : (_clamp01(_numericMemberValue(scoped.coverEstimate, member, threatPosition) ?? 0)));
        const exposure = explicitExposure ?? (danger - cover);
        const assignment = _assignmentFor(member, scoped);
        const activeCommitment = _hasActiveCommitment(member);
        const maneuverCritical = typeof member?.maneuverCritical === "boolean"
            ? member.maneuverCritical
            : (["flank", "assault"].includes(assignment.task) && activeCommitment);
        const leader = member?.leader === true || member?.isLeader === true;
        const supportWeapon = _suppressionCapable(member) || member?.heavyWeapon === true
            || member?.loadout?.heavy === true || member?.loadout?.heavyWeapon === true;
        const value = Number.isFinite(member?.triageValue)
            ? member.triageValue
            : (leader
                ? RECOVER_PINNED_THRESHOLDS.triage.leaderValue
                : (supportWeapon ? RECOVER_PINNED_THRESHOLDS.triage.supportWeaponValue : 0));
        const attribution = member?.attribution ?? _keyedValue(scoped.attributions, member) ?? null;
        return _jsonClone({
            combatantId: _memberId(member),
            tokenId: member?.tokenId ?? null,
            tokenUuid: member?.tokenUuid ?? null,
            actorId: member?.actorId ?? null,
            position: _positionOf(member),
            danger,
            coverEstimate: cover,
            exposure,
            value,
            leader,
            supportWeapon,
            maneuverCritical,
            maneuverBonus: maneuverCritical
                ? RECOVER_PINNED_THRESHOLDS.triage.maneuverCriticalBonus : 0,
            activeCommitment,
            inMelee: _inMelee(member, scoped),
            accessibility: {
                canReachCover: _canReachCover(member, scoped)
            },
            threatPosition,
            attribution
        });
    });
    entries.sort((a, b) => (b.exposure - a.exposure)
        || (b.value - a.value)
        || (b.maneuverBonus - a.maneuverBonus)
        || _compareIds(a.combatantId, b.combatantId));
    return entries.map((entry, index) => ({ ...entry, rank: index + 1 }));
}

/**
 * Whether the entity identified by an attribution is proven dead. Missing
 * entities are not proof; explicit input/member/map flags are.
 * @param {object|null} attribution Attribution DTO.
 * @param {object} input Pure input object.
 * @param {object|null} member Member the attribution belongs to.
 * @returns {boolean}
 */
function _attributionSourceDead(attribution, input = {}, member = null) {
    if (!attribution || attribution.confidence <= 0) return false;
    if (attribution.dead === true) return true;
    if (typeof member?.sourceDead === "boolean") return member.sourceDead;
    const keyed = _keyedValue(input.sourceDead, member ?? attribution);
    if (typeof keyed === "boolean") return keyed;
    const keyedSource = _keyedValue(input.sourceDead, attribution);
    if (typeof keyedSource === "boolean") return keyedSource;
    if (input.sourceDead === true) return true;
    const entity = _resolveEntity(attribution, input);
    return entity ? _isDead(entity) : false;
}

/**
 * Whether the attributed source is currently reachable/known enough for the
 * team to act on it. A los-nearest hypothesis is reachable by construction;
 * otherwise explicit DTO/probe evidence is required.
 * @param {object|null} attribution Attribution DTO.
 * @param {object} input Pure input object.
 * @param {object|null} member Pinned member DTO.
 * @returns {boolean}
 */
function _sourceReachable(attribution, input = {}, member = null) {
    if (!attribution || attribution.confidence <= 0) return false;
    if (attribution.method === "los-nearest") return true;
    if (typeof attribution.reachable === "boolean") return attribution.reachable;
    const injected = input.sourceReachable;
    if (typeof injected === "boolean") return injected;
    if (typeof injected === "function") {
        try {
            return injected(attribution, member) === true;
        } catch(_err) {
            return false;
        }
    }
    const keyed = _keyedValue(injected, attribution);
    if (typeof keyed === "boolean") return keyed;
    const entity = _resolveEntity(attribution, input);
    return entity?.reachable === true || entity?.visible === true || entity?.canAttack === true
        || entity?.los === true || entity?.lastKnown === true || entity?.source === "last-known";
}

/**
 * Turn index of a member, either explicit or derived from the injected
 * serializable turn order.
 * @param {object} member Member DTO.
 * @param {object} input Pure input object.
 * @returns {number|null}
 */
function _turnIndexOf(member, input = {}) {
    if (Number.isFinite(member?.turnIndex)) return member.turnIndex;
    const order = _list(input.turnOrder ?? input.turns);
    for (let index = 0; index < order.length; index++) {
        const entry = order[index];
        const id = typeof entry === "string" ? entry : (entry?.combatantId ?? entry?.id ?? entry?.tokenId);
        if (id != null && _matchesIdentity(member, String(id))) return index;
    }
    return null;
}

/**
 * Whether a member already acted in this round. Explicit `hasActed` wins;
 * otherwise an index lower than the current combat turn means acted, while
 * the current index and later indexes are still usable donors.
 * @param {object} member Member DTO.
 * @param {object} input Pure input object.
 * @returns {boolean}
 */
function _hasActed(member, input = {}) {
    if (typeof member?.hasActed === "boolean") return member.hasActed;
    if (typeof member?.acted === "boolean") return member.acted;
    const current = [input.currentTurnIndex, input.turnIndex, input.combatTurn, input.turn]
        .find(Number.isFinite);
    const own = _turnIndexOf(member, input);
    if (!Number.isFinite(current) || !Number.isFinite(own)) return false;
    return own < current;
}

/**
 * Whether a living enabled member is a broad donor for the activation gate:
 * non-pinned, attack-capable and not already acted. Stricter donor-pool
 * exclusions are applied only by `selectCoverMember`.
 * @param {object} member Member DTO.
 * @param {object} input Pure input object.
 * @returns {boolean}
 */
function _basicDonor(member, input = {}) {
    return !_isPinned(member) && !_isDead(member) && _isEnabled(member)
        && _attackCapable(member) && !_hasActed(member, input);
}

/**
 * Look up an attribution keyed by member or call the pure attributor when no
 * precomputed record exists.
 * @param {object} member Pinned member DTO.
 * @param {object} input Pure input object.
 * @returns {object}
 */
function _attributionFor(member, input = {}) {
    const supplied = member?.attribution ?? _keyedValue(input.attributions, member);
    if (supplied) return supplied;
    return attributePinSource({ ...input, pinned: member });
}

/**
 * Evaluate the marginal-value activation gate of the recover-pinned overlay.
 * The result always carries a stable snake-case reason from
 * {@link RECOVER_GATE_REASONS}; `active: false` means the team maneuver must
 * not be disrupted. Several pinned members already saved by melee or whose
 * source is dead are excluded from the effective triage and reported in
 * diagnostics rather than silently driving the overlay.
 * @param {object} input Pure input: `members` (or explicit `pinned`),
 *   optional precomputed `attributions`, turn-order fields and probes.
 * @returns {object} Serializable gate result `{active, reason, gate, mode,
 *   pinnedCount, donorCount, primary, redirectTargetId, diagnostics}`.
 */
export function evaluateRecoverGate(input = {}) {
    const members = _list(input.members);
    const pinnedInput = input.pinned ?? input.pinnedMembers
        ?? (Array.isArray(input.allPinned) || typeof input.allPinned === "object" ? input.allPinned : null);
    const explicitPinned = pinnedInput
        ? (Array.isArray(pinnedInput) ? _list(pinnedInput) : [pinnedInput])
        : null;
    const living = members.length ? members.filter(member => _isEnabled(member) && !_isDead(member)) : [];
    let pinned = explicitPinned ?? living.filter(member => _isPinned(member));
    pinned = pinned.filter(member => _isEnabled(member) && !_isDead(member));
    const baseMembers = living.length ? living : pinned;
    const pinnedKeys = new Set(pinned.map(member => _memberId(member)).filter(Boolean));
    const nonPinned = baseMembers.filter(member => !_isPinned(member) && !pinnedKeys.has(_memberId(member)));
    const donorCount = baseMembers.filter(member => !pinnedKeys.has(_memberId(member))
        && _basicDonor(member, input)).length;

    const diagnostics = {
        thresholds: _jsonClone(RECOVER_PINNED_THRESHOLDS),
        experimental: true,
        excluded: {
            melee: [],
            sourceDead: []
        },
        donorCount,
        marginalValue: {
            zero: true,
            teamEffect: false,
            individualEffect: false
        }
    };
    const finish = (active, reason, extra = {}) => _jsonClone({
        active,
        reason,
        gate: active ? RECOVER_GATE_REASONS.active : reason,
        mode: active ? (extra.mode ?? RECOVER_OVERLAY_MODES.full) : RECOVER_OVERLAY_MODES.inactive,
        pinnedCount: pinned.length,
        donorCount,
        primary: extra.primary ?? null,
        attribution: extra.attribution ?? null,
        redirectTargetId: extra.redirectTargetId ?? null,
        triage: extra.triage ?? [],
        diagnostics
    });

    if (!pinned.length) return finish(false, RECOVER_GATE_REASONS.noPinned);
    if (!nonPinned.length) return finish(false, RECOVER_GATE_REASONS.allPinned);

    const meleeExcluded = pinned.filter(member => _inMelee(member, input));
    diagnostics.excluded.melee = meleeExcluded.map(member => _memberId(member)).filter(Boolean);
    let eligible = pinned.filter(member => !_inMelee(member, input));
    if (!eligible.length) return finish(false, RECOVER_GATE_REASONS.pinnedInMelee);

    const attributions = new Map(eligible.map(member => [_memberId(member), _attributionFor(member, input)]));
    const deadExcluded = eligible.filter(member =>
        _attributionSourceDead(attributions.get(_memberId(member)), input, member));
    diagnostics.excluded.sourceDead = deadExcluded.map(member => _memberId(member)).filter(Boolean);
    eligible = eligible.filter(member => !deadExcluded.includes(member));
    if (!eligible.length) return finish(false, RECOVER_GATE_REASONS.sourceDead);

    const triageInput = {
        ...input,
        pinned: eligible,
        attributions: Object.fromEntries(attributions)
    };
    const triage = scorePinnedTriage(triageInput);
    const primary = triage[0] ?? null;
    const primaryMember = eligible.find(member => _memberId(member) === primary?.combatantId) ?? eligible[0];
    const attribution = primary ? attributions.get(primary.combatantId) ?? { method: "unknown", confidence: 0 }
        : { method: "unknown", confidence: 0 };

    if (pinned.length === 1 && eligible.length === 1 && primary) {
        const threatPosition = attribution.position ?? primary.threatPosition ?? null;
        const coverAgainstThreat = Number.isFinite(primaryMember?.coverVsSource)
            ? primaryMember.coverVsSource
            : _clamp01(_numericMemberValue(input.coverEstimate, primaryMember, threatPosition)
                ?? primary.coverEstimate ?? 0);
        const safe = coverAgainstThreat >= RECOVER_PINNED_THRESHOLDS.cover.safeEstimate;
        const reachable = _sourceReachable(attribution, input, primaryMember);
        diagnostics.safeInCover = {
            coverEstimate: coverAgainstThreat,
            sourceReachable: reachable,
            threshold: RECOVER_PINNED_THRESHOLDS.cover.safeEstimate
        };
        if (safe && !reachable) {
            diagnostics.marginalValue.individualEffect = true;
            return finish(false, RECOVER_GATE_REASONS.safeInCoverUnreachable, {
                primary,
                attribution,
                triage
            });
        }
    }

    const selfRecover = eligible.some(member => _canReachCover(member, input));
    if (!donorCount && !selfRecover) {
        return finish(false, RECOVER_GATE_REASONS.noDonors, { primary, attribution, triage });
    }

    let mode = RECOVER_OVERLAY_MODES.individualOnly;
    if (donorCount > 0 && attribution.confidence >= RECOVER_PINNED_THRESHOLDS.attribution.minPinpointConfidence) {
        mode = RECOVER_OVERLAY_MODES.full;
    } else if (donorCount > 0 && attribution.confidence === RECOVER_PINNED_THRESHOLDS.attribution.losNearest) {
        mode = RECOVER_OVERLAY_MODES.redirectOnly;
    }
    diagnostics.marginalValue = {
        zero: false,
        teamEffect: donorCount > 0 && attribution.confidence > 0,
        individualEffect: selfRecover || attribution.confidence === 0
    };
    const redirectTargetId = attribution.confidence > 0
        ? (attribution.tokenId ?? attribution.tokenUuid ?? null) : null;
    return finish(true, RECOVER_GATE_REASONS.active, {
        mode,
        primary,
        attribution,
        triage,
        redirectTargetId
    });
}

/**
 * Valid commitment/critical-assignment protection under priority rules R1
 * and R3. Inputs may be compact booleans or id-keyed maps.
 * @param {object} member Member DTO.
 * @param {object} input Pure input object.
 * @returns {boolean}
 */
function _criticalAssignment(member, input = {}) {
    if (member?.criticalAssignment === true || member?.soleCriticalAssignment === true) return true;
    const keyed = _keyedValue(input.criticalAssignments, member);
    if (keyed === true || typeof keyed === "string") return true;
    if (Array.isArray(input.criticalAssignmentIds)) {
        return input.criticalAssignmentIds.some(id => _matchesIdentity(member, String(id)));
    }
    return false;
}

/**
 * Whether the member is the sole holder of the shared objective and thus
 * receives the −3 donor-score penalty.
 * @param {object} member Member DTO.
 * @param {object} input Pure input object.
 * @returns {boolean}
 */
function _soleObjectiveHolder(member, input = {}) {
    if (member?.soleObjectiveHolder === true) return true;
    const holders = _list(input.sharedObjectiveHolders ?? input.objectiveHolders);
    if (holders.length === 1 && _matchesIdentity(member, holders[0])) return true;
    const holder = input.sharedObjective?.holderId ?? input.objective?.holderId ?? null;
    return holder != null && _matchesIdentity(member, String(holder));
}

/**
 * Whether a reference target matches the attributed source.
 * @param {*} reference Target id/object.
 * @param {object} attribution Attribution DTO.
 * @returns {boolean}
 */
function _targetMatchesSource(reference, attribution) {
    if (reference == null || !attribution) return false;
    const target = typeof reference === "object"
        ? {
            tokenId: reference.tokenId ?? reference.targetId ?? reference.id ?? null,
            tokenUuid: reference.tokenUuid ?? reference.targetUuid ?? null,
            actorId: reference.actorId ?? null
        }
        : reference;
    return _matchesIdentity(attribution, target) || _matchesIdentity(target, attribution);
}

/**
 * Explicit or injected line-of-sight answer for donor scoring.
 * @param {object} member Donor member DTO.
 * @param {object} attribution Attribution DTO.
 * @param {object} input Pure input object.
 * @returns {boolean|null}
 */
function _donorLos(member, attribution, input = {}) {
    for (const key of ["losToSource", "hasLineOfSightToSource", "sourceLos"]) {
        if (typeof member?.[key] === "boolean") return member[key];
    }
    const keyed = _keyedValue(input.losToSource, member);
    if (typeof keyed === "boolean") return keyed;
    const source = _resolveEntity(attribution, input) ?? attribution;
    if (typeof input.losToSource === "function") {
        const direct = _probeBoolean(input.losToSource, member, source);
        if (direct !== null) return direct;
    }
    const probed = _probeBoolean(_losProbe(input), member, source);
    if (probed !== null) return probed;
    return null;
}

/**
 * Explicit or injected same-round reachability answer. Missing information
 * is not proof of reachability; callers that deliberately want optimistic
 * scoring fixtures can set `assumeUnknownAccess: true`.
 * @param {object} member Donor member DTO.
 * @param {object} attribution Attribution DTO.
 * @param {object} input Pure input object.
 * @returns {{reachable: boolean, proven: boolean}}
 */
function _donorReach(member, attribution, input = {}) {
    for (const key of ["canReachSource", "canEngageSource", "sourceReachable"]) {
        if (typeof member?.[key] === "boolean") return { reachable: member[key], proven: true };
    }
    const keyed = _keyedValue(input.canReachSource, member);
    if (typeof keyed === "boolean") return { reachable: keyed, proven: true };
    if (typeof input.canReachSource === "function") {
        try {
            return { reachable: input.canReachSource(member, attribution) === true, proven: true };
        } catch(_err) {
            return { reachable: false, proven: true };
        }
    }
    return { reachable: false, proven: false };
}

/**
 * First exclusion reason of a donor under the strict cover pool. Evaluation
 * order follows the spec: pinned/defeated/disabled, GM control, melee,
 * detached assignments, L1 commitment, desperate regroup, turn order,
 * attack capability, then critical mass.
 * @param {object} member Member DTO.
 * @param {object} input Pure input object.
 * @returns {string|null}
 */
function _donorExclusion(member, input = {}) {
    const explicitPinned = input.pinnedMembers ?? input.allPinned
        ?? (Array.isArray(input.pinned) ? input.pinned : null);
    const markedPinned = _isPinned(member) || _list(explicitPinned)
        .some(pinned => _matchesIdentity(member, pinned) || _matchesIdentity(pinned, member));
    if (markedPinned) return RECOVER_DONOR_EXCLUSIONS.pinned;
    if (_isDead(member)) return RECOVER_DONOR_EXCLUSIONS.defeated;
    if (!_isEnabled(member)) return RECOVER_DONOR_EXCLUSIONS.disabled;
    const gmControlled = member?.gmControlled;
    const gmControlledActive = gmControlled === true
        || (gmControlled && typeof gmControlled === "object"
            && (!Number.isFinite(gmControlled.round) || gmControlled.round === input.round));
    if (gmControlledActive) {
        return RECOVER_DONOR_EXCLUSIONS.gmControlled;
    }
    if (_inMelee(member, input)) return RECOVER_DONOR_EXCLUSIONS.inMelee;
    const assignment = _assignmentFor(member, input);
    if (["flank", "assault"].includes(assignment.task)) {
        return RECOVER_DONOR_EXCLUSIONS.detachedAssignment;
    }
    if (_hasActiveCommitment(member)) return RECOVER_DONOR_EXCLUSIONS.commitmentProtected;
    const tier = member?.effectiveTier ?? member?.moraleTier ?? _keyedValue(input.memberMorale, member);
    if (assignment.task === "regroup" && tier === "desperate") {
        return RECOVER_DONOR_EXCLUSIONS.regroupDesperate;
    }
    if (_hasActed(member, input)) return RECOVER_DONOR_EXCLUSIONS.hasActed;
    if (!_attackCapable(member)) return RECOVER_DONOR_EXCLUSIONS.notAttackCapable;
    if (_criticalAssignment(member, input)) return RECOVER_DONOR_EXCLUSIONS.criticalAssignment;
    return null;
}

/**
 * Resolve the member's sticky `lastTarget` reference from compact booleans,
 * direct fields or an id-keyed injection.
 * @param {object} member Member DTO.
 * @param {object} input Pure input object.
 * @returns {*}
 */
function _lastTargetOf(member, input = {}) {
    return member?.lastTarget ?? member?.lastTargetId ?? _keyedValue(input.lastTargets, member) ?? null;
}

/**
 * Resolve the member's natural/previous target reference.
 * @param {object} member Member DTO.
 * @param {object} input Pure input object.
 * @returns {*}
 */
function _naturalTargetOf(member, input = {}) {
    return member?.naturalTarget ?? member?.naturalTargetId ?? member?.plannedTargetId
        ?? member?.previousTargetId ?? member?.targetId ?? _keyedValue(input.naturalTargets, member) ?? null;
}

/**
 * Score one donor candidate. Component names and values mirror the spec and
 * are echoed into diagnostics.
 * @param {object} member Member DTO.
 * @param {object} attribution Attribution DTO.
 * @param {object} input Pure input object.
 * @returns {object}
 */
function _scoreDonor(member, attribution, input = {}) {
    const suppression = _suppressionCapable(member);
    const losAnswer = _donorLos(member, attribution, input);
    const los = losAnswer === true;
    const reach = _donorReach(member, attribution, input);
    const losKnown = losAnswer !== null;
    const assumedAccess = input.assumeUnknownAccess === true && !losKnown && !reach.proven;
    const access = los || reach.reachable || assumedAccess;
    const components = {
        suppressionCapable: suppression ? RECOVER_PINNED_THRESHOLDS.donor.suppressionCapable : 0,
        lineOfSight: los ? RECOVER_PINNED_THRESHOLDS.donor.lineOfSight : 0,
        lastTarget: _targetMatchesSource(_lastTargetOf(member, input), attribution)
            ? RECOVER_PINNED_THRESHOLDS.donor.lastTarget : 0,
        naturalTarget: _targetMatchesSource(_naturalTargetOf(member, input), attribution)
            ? RECOVER_PINNED_THRESHOLDS.donor.naturalTarget : 0,
        soleObjective: _soleObjectiveHolder(member, input)
            ? RECOVER_PINNED_THRESHOLDS.donor.soleObjective : 0
    };
    const score = components.suppressionCapable + components.lineOfSight
        + components.lastTarget + components.naturalTarget + components.soleObjective;
    return {
        suppressionCapable: suppression,
        rangedCapable: _rangedCapable(member),
        attackCapable: _attackCapable(member),
        los,
        canReachSource: reach.reachable,
        accessProven: losKnown || reach.proven,
        access,
        components,
        score
    };
}

/**
 * Compare donor candidates: score desc, initiative desc, combatant id asc.
 * @param {object} a First candidate.
 * @param {object} b Second candidate.
 * @returns {number}
 */
function _compareDonors(a, b) {
    return (b.score - a.score)
        || (_finiteOr(b.initiative, Number.NEGATIVE_INFINITY)
            - _finiteOr(a.initiative, Number.NEGATIVE_INFINITY))
        || _compareIds(a.combatantId, b.combatantId);
}

/**
 * Choose the soft cover mode. This is a recommendation, not a forced attack
 * type: the planner remains free to prefer direct fire when suppression is
 * not useful. Low-confidence or unreachable cases degrade to declare-only
 * overwatch for ranged members.
 * @param {object} member Member DTO.
 * @param {object} attribution Attribution DTO.
 * @param {object} options Mode context.
 * @returns {string}
 */
function _coverMode(member, attribution, options = {}) {
    if (RECOVER_COVER_MODES.includes(options.explicitMode)) return options.explicitMode;
    const pinpoint = attribution.confidence >= RECOVER_PINNED_THRESHOLDS.attribution.minPinpointConfidence
        && options.access === true;
    if (!pinpoint) {
        return _rangedCapable(member) ? "overwatch" : "direct";
    }
    if (_suppressionCapable(member) && options.preferSuppression !== false
        && options.suppressionOpportunity !== false) {
        return "suppression";
    }
    return "direct";
}

/**
 * Serializable objective DTO of a cover assignment/descriptor.
 * @param {string} mode Cover mode.
 * @param {object} pinned Protected pinned member DTO.
 * @param {object} attribution Attribution DTO.
 * @returns {object}
 */
function _coverObjective(mode, pinned, attribution) {
    return _jsonClone({
        type: mode === "overwatch"
            ? "overwatch-pin-recovery"
            : (mode === "suppression" ? "suppress-pin-source" : "attack-pin-source"),
        targetId: attribution.tokenId ?? null,
        targetUuid: attribution.tokenUuid ?? null,
        targetPosition: attribution.position ?? null,
        for: _memberId(pinned),
        method: attribution.method,
        confidence: attribution.confidence,
        preferSuppression: mode === "suppression"
    });
}

/**
 * Build the object-form assignment of the selected cover donor. Existing
 * element/group identity is preserved when present, while task stays the
 * existing `support` vocabulary and the role carries the overlay meaning.
 * @param {object} member Donor member DTO.
 * @param {object} pinned Protected pinned member DTO.
 * @param {object} attribution Attribution DTO.
 * @param {string} mode Cover mode.
 * @param {object} input Pure input object.
 * @returns {object}
 */
function _coverAssignment(member, pinned, attribution, mode, input = {}) {
    const base = _assignmentFor(member, input);
    const element = base.element ?? base.groupId ?? member?.element ?? member?.groupId;
    return _jsonClone({
        combatantId: _memberId(member),
        tokenId: member?.tokenId ?? null,
        task: "support",
        role: RECOVER_PINNED_ROLES.coverFire,
        ...(element ? { element } : {}),
        groupId: member?.groupId ?? element ?? "main",
        leader: member?.leader === true || member?.isLeader === true,
        objective: _coverObjective(mode, pinned, attribution),
        assignedTargetId: attribution.tokenId ?? attribution.tokenUuid ?? null,
        recover: {
            for: _memberId(pinned),
            confidence: attribution.confidence,
            method: attribution.method
        }
    });
}

/**
 * Build the object-form assignment of a pinned member. The overlay always
 * demotes maneuver tasks to `support` because pinned movement is constrained
 * by the corebook rules; `recovering` is the temporary role marker.
 * @param {object} member Pinned member/triage DTO.
 * @param {object} input Pure input object.
 * @returns {object}
 */
export function buildRecoveringAssignment(member, input = {}) {
    const base = _assignmentFor(member, input);
    const element = base.element ?? base.groupId ?? member?.element ?? member?.groupId;
    return _jsonClone({
        combatantId: _memberId(member),
        tokenId: member?.tokenId ?? null,
        task: "support",
        role: RECOVER_PINNED_ROLES.recovering,
        ...(element ? { element } : {}),
        groupId: member?.groupId ?? element ?? "main",
        objective: {
            type: "recover-pinning",
            threatPosition: member?.threatPosition ?? member?.attribution?.position ?? null
        }
    });
}

/**
 * Select at most one cover-fire donor for the top-priority pinned member.
 * The function scores every strict-pool candidate with the exact spec
 * components (`+4/+3/+2/+1/−3`) and reports both eligible and excluded
 * donors. A non-null `assignment` is created only for confidence >= 2 and a
 * live, same-round accessible source. Low-confidence input can still produce
 * a non-assignment overwatch descriptor plus diagnostics; this is deliberate
 * and keeps fire into empty space illegal.
 * @param {object} input Pure input `{members, pinned, attribution,
 *   assignments, turnOrder, currentTurnIndex, hasLineOfSight,
 *   canReachSource}`.
 * @returns {object} Serializable result `{selected, combatantId, reason,
 *   mode, assignment, descriptor, coverAssignment, redirectTargetId,
 *   candidates, diagnostics}`.
 */
export function selectCoverMember(input = {}) {
    const pinned = input.pinned ?? input.protect ?? null;
    const attribution = input.attribution
        ?? (pinned ? attributePinSource({ ...input, pinned }) : { method: "unknown", confidence: 0 });
    const members = _list(input.members ?? input.donors);
    const candidates = members.map(member => {
        const scored = _scoreDonor(member, attribution, input);
        const exclusion = _donorExclusion(member, input);
        return _jsonClone({
            combatantId: _memberId(member),
            tokenId: member?.tokenId ?? null,
            initiative: Number.isFinite(member?.initiative) ? member.initiative : null,
            eligible: exclusion === null,
            reason: exclusion,
            turnIndex: _turnIndexOf(member, input),
            hasActed: _hasActed(member, input),
            ...scored
        });
    });
    candidates.sort(_compareDonors);
    const eligible = candidates.filter(candidate => candidate.eligible);
    const accessCandidates = eligible.filter(candidate => candidate.access);
    const pinpoint = attribution.confidence >= RECOVER_PINNED_THRESHOLDS.attribution.minPinpointConfidence;
    const sourceDead = _attributionSourceDead(attribution, input, pinned);
    const selected = accessCandidates[0] ?? eligible[0] ?? null;
    const selectedMember = members.find(member => _memberId(member) === selected?.combatantId) ?? null;

    let reason = RECOVER_COVER_REASONS.selected;
    if (!attribution || attribution.confidence <= 0) reason = RECOVER_COVER_REASONS.unknownSource;
    else if (sourceDead) reason = RECOVER_COVER_REASONS.sourceDead;
    else if (!pinpoint) reason = RECOVER_COVER_REASONS.lowConfidence;
    else if (!eligible.length) reason = RECOVER_COVER_REASONS.noDonors;
    else if (!accessCandidates.length) reason = RECOVER_COVER_REASONS.sourceUnreachable;

    const selectedScore = selected ? {
        ...selected,
        access: selected.access
    } : null;
    const mode = selectedMember && pinned
        ? _coverMode(selectedMember, attribution, {
            explicitMode: input.attackMode,
            access: pinpoint && selected?.access === true,
            preferSuppression: input.preferSuppression,
            suppressionOpportunity: input.suppressionOpportunity
        })
        : null;
    const assignmentAllowed = pinpoint && !sourceDead && selectedMember
        && selected?.access === true && reason === RECOVER_COVER_REASONS.selected;
    const assignment = assignmentAllowed
        ? _coverAssignment(selectedMember, pinned, attribution, mode, input) : null;
    const descriptor = selectedMember && pinned && mode
        ? _coverAssignment(selectedMember, pinned, attribution, mode, input) : null;
    if (descriptor && !assignment) {
        descriptor.assignedTargetId = attribution.confidence > 0
            ? (attribution.tokenId ?? attribution.tokenUuid ?? null) : null;
        descriptor.softOnly = true;
    }
    const coverAssignment = assignment ? {
        combatantId: assignment.combatantId,
        for: _memberId(pinned),
        score: selected?.score ?? 0,
        mode
    } : null;
    const redirectTargetId = attribution.confidence > 0
        ? (attribution.tokenId ?? attribution.tokenUuid ?? null) : null;

    return _jsonClone({
        selected: selectedScore,
        combatantId: selected?.combatantId ?? null,
        reason,
        mode,
        assignment,
        descriptor,
        coverAssignment,
        redirectTargetId,
        candidates,
        diagnostics: {
            thresholds: _jsonClone(RECOVER_PINNED_THRESHOLDS),
            experimental: true,
            donorCount: eligible.length,
            accessibleDonorCount: accessCandidates.length,
            pinpoint,
            confidence: attribution.confidence ?? 0,
            attributionMethod: attribution.method ?? "unknown"
        }
    });
}

/**
 * Build the complete serializable recover-pinned overlay descriptor. This
 * pure convenience composition is what the later fireteam integration can
 * place under `teamPlan.recover`/`breakdown.recover`; it does not mutate or
 * read documents.
 *
 * Assignment values follow the epic object form `{task, role, element?,
 * objective?}` while preserving the existing `combatantId/tokenId/groupId`
 * metadata as a backward-compatible superset. Pinned members are always
 * demoted to `support`+`recovering`; at most one donor receives
 * `support`+`cover-fire`; all other living non-pinned members receive only a
 * soft `redirectTargetId` in `memberContexts`.
 * @param {object} input Pure input accepted by the four kernel functions.
 * @returns {object} JSON-serializable overlay descriptor.
 */
export function buildRecoverPinnedOverlay(input = {}) {
    const gate = evaluateRecoverGate(input);
    const base = {
        active: gate.active,
        gate: gate.reason,
        mode: gate.mode,
        pinned: gate.triage,
        coverAssignment: null,
        coverReason: null,
        redirectTargetId: gate.redirectTargetId,
        assignments: {},
        memberContexts: {},
        breakdown: {
            attribution: gate.attribution
                ? {
                    method: gate.attribution.method,
                    confidence: gate.attribution.confidence
                }
                : { method: "unknown", confidence: 0 },
            gate: gate.reason,
            donor: null,
            triage: gate.triage.map(entry => ({
                combatantId: entry.combatantId,
                exposure: entry.exposure,
                value: entry.value,
                maneuverCritical: entry.maneuverCritical,
                rank: entry.rank
            })),
            thresholds: _jsonClone(RECOVER_PINNED_THRESHOLDS),
            experimental: true
        },
        diagnostics: {
            gate: gate.diagnostics,
            attribution: gate.attribution,
            thresholds: _jsonClone(RECOVER_PINNED_THRESHOLDS),
            experimental: true
        }
    };
    if (!gate.active) return _jsonClone(base);

    const members = _list(input.members);
    const pinnedIds = new Set(members.filter(member => _isPinned(member))
        .map(member => _memberId(member)).filter(Boolean));
    for (const entry of gate.triage) {
        const original = members.find(member => _memberId(member) === entry.combatantId) ?? entry;
        const withAttribution = {
            ...original,
            attribution: entry.attribution ?? gate.attribution,
            threatPosition: entry.threatPosition ?? gate.attribution?.position ?? null
        };
        base.assignments[entry.combatantId] = buildRecoveringAssignment(withAttribution, input);
        base.memberContexts[entry.combatantId] = {
            role: RECOVER_PINNED_ROLES.recovering,
            threatPosition: withAttribution.threatPosition ?? null
        };
    }

    const cover = selectCoverMember({
        ...input,
        pinned: gate.primary,
        pinnedMembers: input.pinnedMembers ?? input.allPinned
            ?? (Array.isArray(input.pinned) ? input.pinned : members.filter(member => _isPinned(member))),
        attribution: gate.attribution
    });
    base.coverAssignment = cover.coverAssignment;
    base.coverReason = cover.reason;
    base.redirectTargetId = cover.redirectTargetId ?? gate.redirectTargetId;
    base.breakdown.donor = cover.coverAssignment;
    base.diagnostics.donorSelection = {
        reason: cover.reason,
        selected: cover.selected,
        candidates: cover.candidates,
        donorCount: cover.diagnostics.donorCount,
        accessibleDonorCount: cover.diagnostics.accessibleDonorCount
    };
    if (cover.assignment) {
        base.assignments[cover.assignment.combatantId] = cover.assignment;
        base.memberContexts[cover.assignment.combatantId] = {
            role: RECOVER_PINNED_ROLES.coverFire,
            sourceTargetId: gate.attribution?.tokenId ?? null,
            sourceTokenUuid: gate.attribution?.tokenUuid ?? null,
            sourcePosition: gate.attribution?.position ?? null,
            protect: {
                combatantId: gate.primary?.combatantId ?? null,
                tokenId: gate.primary?.tokenId ?? null,
                position: gate.primary?.position ?? null
            },
            confidence: gate.attribution?.confidence ?? 0,
            method: gate.attribution?.method ?? "unknown",
            preferSuppression: cover.mode === "suppression",
            mode: cover.mode
        };
    } else if (cover.descriptor && ["overwatch"].includes(cover.mode)) {
        // Unknown/low-confidence help is deliberately not an assignment: the
        // context carries the declare-only overwatch preference instead.
        base.memberContexts[cover.descriptor.combatantId] = {
            role: null,
            mode: cover.mode,
            objective: cover.descriptor.objective,
            redirectTargetId: cover.redirectTargetId
        };
    }
    if (gate.mode === RECOVER_OVERLAY_MODES.full && !cover.assignment) {
        base.mode = RECOVER_OVERLAY_MODES.redirectOnly;
    }

    for (const member of members) {
        const id = _memberId(member);
        if (!id || pinnedIds.has(id) || base.memberContexts[id]) continue;
        if (!_isEnabled(member) || _isDead(member)) continue;
        base.memberContexts[id] = {
            role: null,
            redirectTargetId: base.redirectTargetId
        };
    }
    return _jsonClone(base);
}
