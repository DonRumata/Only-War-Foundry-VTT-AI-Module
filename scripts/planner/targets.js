/**
 * Planner decomposition (issue #403 follow-up): this module was extracted
 * verbatim from scripts/planner.js — see that file for the design contract.
 * The planner service re-exports the public surface so existing importers
 * and tests keep working.
 */
import {
    FLAG_KEYS,
    MODULE_ID
} from "../constants.js";
import {
    reactionUsed
} from "../reactions.js";
import {
    DEFAULT_MELEE_RANGE
} from "./contract.js";
import {
    _actorOf,
    _findCombatantByToken,
    _statusIds,
    _tokenDoc,
    _tokenPosition,
    _tokenUuid
} from "./documents.js";
import {
    _distPx,
    _finiteOr,
    _list,
    _pixelDistance
} from "./util.js";


/**
 * Bounded count of excluded target ids the attack-pool diagnostics
 * list — enough to explain a focus assignment, small enough to keep a
 * serialized plan lean.
 */
export const ATTACK_POOL_DIAGNOSTICS_CAP = 8;


/**
 * Identity keys of a normalized target for attack-pool matching (epic
 * #84): the exact string forms of `tokenId`, `tokenUuid` and `actorId`,
 * deduplicated in that priority order. `_normalizeTarget`
 * cross-populates `tokenId` from the uuid tail (and vice versa), so a
 * bare token id and the full `Scene.<id>.Token.<tokenId>` uuid both
 * match the same token; `targetId` in the concentrate-fire sense
 * (`tokenId ?? tokenUuid`) is covered by construction. Numeric inputs
 * are stringified — fixture ids are not always strings.
 * @param {object|null} target Normalized target.
 * @returns {string[]}
 */
export function _targetIdentityKeys(target) {
    const keys = [];
    const push = value => {
        if (value == null) return;
        const string = typeof value === "string" ? value
            : (typeof value === "number" && Number.isFinite(value) ? String(value) : null);
        if (string && !keys.includes(string)) keys.push(string);
    };
    push(target?.tokenId);
    push(target?.tokenUuid);
    push(target?.actorId);
    return keys;
}


/**
 * Normalize one attack-pool id list: strings pass through, finite
 * numbers stringify, everything else drops out. Entries are
 * deduplicated and sorted so equal inputs diagnose and compare
 * identically regardless of caller ordering.
 * @param {*} raw `context.attackTargetIds`/`context.excludedAttackTargetIds`.
 * @returns {string[]|null} Null when the input is not an array at all.
 */
export function _attackPoolIdList(raw) {
    if (!Array.isArray(raw)) return null;
    const ids = new Set();
    for (const entry of raw) {
        if (typeof entry === "string" && entry) ids.add(entry);
        else if (typeof entry === "number" && Number.isFinite(entry)) ids.add(String(entry));
    }
    return [...ids].sort();
}


/**
 * Attack-pool narrowing spec of a plan context (epic #84 minimal split
 * awareness/attack pools). `context.attackTargetIds` is an allow-list:
 * when present as an array — even empty — only matching targets stay
 * eligible direct-attack objectives. `context.excludedAttackTargetIds`
 * is a deny-list that always filters. The spec is ACTIVE when an
 * allow-list array is present or the deny-list carries at least one
 * valid entry; missing keys, non-array garbage and an empty deny-list
 * alone are the legacy behaviour, bit-for-bit.
 *
 * The pool only gates direct attack candidate generation
 * (attack-in-place, aim-attack, move-attack, charge, blast
 * memory-strikes and attack-cone orientation anchors). Movement,
 * approach/seek/run, threat-map reads, melee engagement, nearest
 * threat, overwatch anchors, lookahead, the commitment threat
 * fingerprint and snapshot/diagnostics keep using the FULL perception
 * pool. The narrowing never widens anything: `canAttack`/hidden/
 * intel/memory rules still apply on top — an allow-listed memory or
 * team-contact target never becomes directly attackable.
 * @param {object|null} context Planning context.
 * @returns {{active: boolean, allow: string[]|null, deny: string[],
 *   allowSet: Set<string>|null, denySet: Set<string>}}
 */
export function _attackPoolSpec(context) {
    const allow = _attackPoolIdList(context?.attackTargetIds);
    const deny = _attackPoolIdList(context?.excludedAttackTargetIds) ?? [];
    return {
        active: allow !== null || deny.length > 0,
        allow,
        deny,
        allowSet: allow !== null ? new Set(allow) : null,
        denySet: new Set(deny)
    };
}


/**
 * Whether a normalized target stays eligible as a direct-attack
 * objective under the attack-pool spec. Matching is exact string
 * equality against the target's identity keys
 * ({@link _targetIdentityKeys}): with an allow-list present a non-match
 * excludes, and a deny hit always excludes. An inactive spec allows
 * everything — identical to the legacy behaviour.
 * @param {object|null} spec `_attackPoolSpec` result.
 * @param {object|null} target Normalized target.
 * @returns {boolean}
 */
export function _attackPoolAllows(spec, target) {
    if (!spec?.active) return true;
    const keys = _targetIdentityKeys(target);
    if (spec.allowSet !== null && !keys.some(key => spec.allowSet.has(key))) {
        return false;
    }
    if (keys.some(key => spec.denySet.has(key))) return false;
    return true;
}


/**
 * Serialization-safe diagnostics of the attack-pool narrowing (epic
 * #84), or null when the spec is inactive — absent narrowing inputs
 * keep legacy plans bit-for-bit identical, diagnostics included.
 * `excludedTargets` names the pool entries the narrowing filtered out
 * of attack generation (`tokenId` falling back to `tokenUuid`, sorted,
 * bounded at {@link ATTACK_POOL_DIAGNOSTICS_CAP}).
 * @param {object|null} spec `_attackPoolSpec` result.
 * @param {object[]} targets Normalized FULL-pool targets.
 * @returns {object|null}
 */
export function _attackPoolDiagnostics(spec, targets) {
    if (!spec?.active) return null;
    const excluded = [];
    let eligible = 0;
    for (const target of targets ?? []) {
        if (_attackPoolAllows(spec, target)) {
            eligible++;
        } else {
            excluded.push(String(target?.tokenId ?? target?.tokenUuid ?? "?"));
        }
    }
    excluded.sort();
    return {
        mode: spec.allow !== null
            ? (spec.deny.length ? "allow+deny" : "allow-list")
            : "deny-list",
        allow: spec.allow !== null ? [...spec.allow] : null,
        deny: [...spec.deny],
        eligibleCount: eligible,
        excludedCount: excluded.length,
        excludedTargets: excluded.slice(0, ATTACK_POOL_DIAGNOSTICS_CAP)
    };
}


/**
 * Whether a target provenance is a memory record (issue #38): the bot's
 * own `last-known` entry or a shared `team-contact` sighting. Memory
 * targets are never directly attackable but may steer approach moves,
 * cones and blast memory-strikes.
 * @param {string|null} source
 * @returns {boolean}
 */
export function _isMemorySource(source) {
    // `intel` — a rough radio marker from the combat tracker (smoke
    // finding): memory-class for movement and targeting rules — never a
    // direct attack — but carrying no sighting provenance.
    return source === "last-known" || source === "team-contact"
        || source === "relay" || source === "intel";
}


/**
 * Normalize a raw target record (perception entry, combatant fallback or
 * injected fixture) to the snapshot target shape.
 * @param {object} raw
 * @param {object} input Normalization context.
 * @param {string} input.source Target provenance label.
 * @param {string|null} input.sceneId Owning scene id for UUID fallback.
 * @param {object} input.selfPos Self position `{x, y}` in pixels.
 * @param {object} input.grid Normalized grid info.
 * @param {Function} input.measure Distance probe `(raw) => number|null`.
 * @returns {object|null}
 */
export function _normalizeTarget(raw, { source, sceneId, selfPos, grid, measure }) {
    if (!raw || typeof raw !== "object") return null;
    const tokenId = raw.tokenId ?? (typeof raw.tokenUuid === "string"
        ? raw.tokenUuid.split(".").pop()
        : null);
    const tokenUuid = typeof raw.tokenUuid === "string" && raw.tokenUuid
        ? raw.tokenUuid
        : (tokenId ? `Scene.${sceneId ?? "scene"}.Token.${tokenId}` : null);
    if (!tokenUuid && !tokenId) return null;
    const x = _finiteOr(raw.x, null);
    const y = _finiteOr(raw.y, null);
    let distance = Number.isFinite(raw.distance) ? raw.distance : null;
    if (distance === null && typeof measure === "function") {
        try {
            distance = measure(raw) ?? null;
        } catch(err) {
            distance = null;
        }
    }
    if (distance === null) {
        distance = _pixelDistance(selfPos, { x, y }, grid);
    }
    return {
        tokenId,
        tokenUuid,
        // Issue #39: the target's actor id feeds the `grudge` factor —
        // the `lastAttacker` flag identifies the attacker by actor too.
        actorId: raw.actorId ?? null,
        x,
        y,
        elevation: _finiteOr(raw.elevation, 0),
        distance,
        threat: _finiteOr(raw.threat, 0),
        canAttack: _isMemorySource(source) ? false : raw.canAttack !== false,
        hidden: raw.hidden === true,
        statuses: _statusIds(raw.statuses),
        source,
        // Issue #38: memory entries carry their sighting timestamps so a
        // fresher shared contact may replace a stale own record inside
        // `_resolveTargets`; `sourceCombatantId` names the teammate that
        // shared the contact (null for own sightings).
        lastSeenRound: _isMemorySource(source)
            ? _finiteOr(raw.lastSeenRound, null) : null,
        lastSeenTurn: _isMemorySource(source)
            ? _finiteOr(raw.lastSeenTurn, null) : null,
        sourceCombatantId: _isMemorySource(source)
            ? (raw.sourceCombatantId ?? null) : null,
        // Issue #16 threat-profile passthrough: explicit weapon emitters
        // (`emitters`/`damage`+`range`/`melee`/`threatProfile`) feeding
        // the danger field and the lookahead counter model.
        threatProfile: raw.threatProfile ?? null,
        emitters: Array.isArray(raw.emitters) ? raw.emitters : null,
        damage: raw.damage ?? null,
        range: Number.isFinite(raw.range) ? raw.range : null,
        melee: raw.melee === true,
        // Issue #37: dodge/reaction data feeding the counter-EV model —
        // `reactionUsed` marks a combatant that already spent its
        // reaction this round, `dodge`/`dodgeTN` is a rough dodge TN
        // (0..100), `halfMove` the target's half-move rate used to judge
        // whether a blast target can still escape the zone.
        reactionUsed: raw.reactionUsed === true,
        dodge: _finiteOr(raw.dodgeTN ?? raw.dodge, null),
        halfMove: _finiteOr(raw.halfMove, null)
    };
}


/**
 * Fallback target list when no perception service is registered: hostile,
 * living, visible-enough combatants of the same combat.
 * @param {object} combat
 * @param {object} combatant
 * @param {object} input Normalization context.
 * @param {string|null} input.sceneId Owning scene id.
 * @param {object} input.selfPos Self position `{x, y}` in pixels.
 * @param {object} input.grid Normalized grid info.
 * @param {Function} input.measure Distance probe `(raw) => number|null`.
 * @returns {object[]}
 */
export function _fallbackTargets(combat, combatant, input) {
    const selfDoc = _tokenDoc(combatant?.token);
    const selfDisposition = _finiteOr(selfDoc?.disposition ?? combatant?.disposition, 0);
    const targets = [];
    for (const other of _list(combat?.combatants)) {
        if (!other || other === combatant) continue;
        const doc = _tokenDoc(other.token);
        const id = other.tokenId ?? doc?.id;
        if (!doc || !id || id === selfDoc?.id) continue;
        if (doc.destroyed === true || doc.hidden === true) continue;
        if (other.defeated === true) continue;
        if (!_actorOf(other) && !_actorOf(doc)) continue;
        if (!_hostileTo(selfDisposition, doc.disposition, input.options ?? {})) continue;
        // The fallback scans combatants directly, so it must apply the
        // same LOS gate the perception snapshot used — otherwise a
        // wall-blind NPC still fires at a hostile it cannot see.
        const losProbe = input.perception?.hasLineOfSight;
        if (selfDoc && typeof losProbe === "function") {
            try {
                if (losProbe.call(input.perception, selfDoc, doc) !== true) continue;
            } catch(err) {
                // An undetermined probe keeps the candidate — a broken
                // LOS check is safer than a blind veto.
            }
        }
        const position = _tokenPosition(doc);
        const target = _normalizeTarget({
            tokenId: id,
            tokenUuid: _tokenUuid(doc, input.sceneId),
            x: position.x,
            y: position.y,
            elevation: doc.elevation,
            canAttack: true,
            hidden: false,
            statuses: _statusIds(doc.actor?.statuses, doc.statuses)
        }, { ...input, source: "fallback" });
        if (target) targets.push(target);
    }
    return targets;
}


/**
 * Rough radio-intel contacts (smoke finding): presets opting into
 * `context.seekContacts` get a destination even at zero intel — the
 * nearest living hostile combatants are marked unattackable `intel`
 * targets so the bot advances toward the fight instead of idling.
 * Positions come straight from the combat tracker (no LOS gate); they
 * steer approach moves and never attacks. Hidden or defeated hostiles
 * leak no position.
 * @param {object} combat
 * @param {object} combatant Active combatant.
 * @param {object} input Normalization context (selfPos/grid/options).
 * @param {number} [limit] Contact cap — deterministic nearest-first.
 * @returns {object[]} Raw target records for `_normalizeTarget`.
 */
export function _intelContacts(combat, combatant, input, limit = 2) {
    const selfDoc = _tokenDoc(combatant?.token);
    const selfDisposition = _finiteOr(selfDoc?.disposition ?? combatant?.disposition, 0);
    const raws = [];
    for (const other of _list(combat?.combatants)) {
        if (!other || other === combatant) continue;
        const doc = _tokenDoc(other.token);
        const id = other.tokenId ?? doc?.id;
        if (!doc || !id || id === selfDoc?.id) continue;
        if (doc.destroyed === true || doc.hidden === true) continue;
        if (other.defeated === true) continue;
        if (!_actorOf(other) && !_actorOf(doc)) continue;
        if (!_hostileTo(selfDisposition, doc.disposition, input.options ?? {})) continue;
        const position = _tokenPosition(doc);
        if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y)) continue;
        raws.push({
            tokenId: id,
            tokenUuid: _tokenUuid(doc, input.sceneId),
            x: position.x,
            y: position.y,
            elevation: doc.elevation ?? 0,
            canAttack: false,
            distance: _pixelDistance(input.selfPos, position, input.grid),
            statuses: _statusIds(doc.actor?.statuses, doc.statuses)
        });
    }
    raws.sort((a, b) => (a.distance - b.distance)
        || String(a.tokenUuid).localeCompare(String(b.tokenUuid)));
    return raws.slice(0, Math.max(0, limit));
}


/**
 * Resolve target candidates: injected `context.targets`, the perception
 * service snapshot, or the combatant fallback scan. Sorted by tokenUuid
 * for determinism and deduplicated.
 * @param {object} input Resolution context.
 * @param {object} input.combat Combat document.
 * @param {object} input.combatant Active combatant document.
 * @param {object|null} input.tokenDoc Viewer token document.
 * @param {object} input.selfPos Self position `{x, y}` in pixels.
 * @param {string|null} input.sceneId Owning scene id.
 * @param {object} input.grid Normalized grid info.
 * @param {object|null} input.perception Perception service or null.
 * @param {object} input.context Planning context overrides.
 * @param {boolean} [input.distrustsContacts] Ignore shared team contacts
 *   (issue #38 review: `distrustsContacts` trait flag or `rabble` squad
 *   character).
 * @returns {object[]}
 */
export function _resolveTargets({ combat, combatant, tokenDoc, selfPos, sceneId, grid, perception, context,
    distrustsContacts = false }) {
    const measure = raw => {
        const doc = _tokenDoc(raw) ?? raw;
        if (typeof perception?.measureDistance === "function" && doc) {
            const dist = perception.measureDistance(tokenDoc, doc);
            if (Number.isFinite(dist)) return dist;
        }
        return null;
    };
    const input = {
        source: "fallback",
        sceneId,
        selfPos,
        grid,
        measure,
        perception,
        options: {
            includeNeutral: context.includeNeutral === true,
            dispositions: Array.isArray(context.dispositions) ? context.dispositions : null
        }
    };
    let targets = [];
    if (Array.isArray(context.targets)) {
        targets = context.targets
            .map(raw => _normalizeTarget(raw, { ...input, source: raw?.source ?? "injected" }))
            .filter(Boolean);
    } else if (perception && typeof perception.buildPerceptionSnapshot === "function") {
        let snapshot = null;
        try {
            snapshot = perception.buildPerceptionSnapshot({
                combat,
                combatant,
                token: tokenDoc,
                includeNeutral: context.includeNeutral === true,
                dispositions: Array.isArray(context.dispositions) ? context.dispositions : null
            });
        } catch(err) {
            snapshot = null;
        }
        if (snapshot && snapshot.status !== "perception-unavailable") {
            const visible = (snapshot.visibleTargets ?? [])
                .map(raw => _normalizeTarget(raw, { ...input, source: "visible" }));
            const remembered = (snapshot.lastKnownTargets ?? [])
                .map(raw => _normalizeTarget(raw, {
                    ...input,
                    // Issue #38: the snapshot marks shared squad contacts
                    // `team-contact`; everything else stays a last-known.
                    source: raw?.source ?? "last-known"
                }));
            targets = visible.concat(remembered).filter(Boolean);
        }
    }
    if (!targets.length && !Array.isArray(context.targets)) {
        targets = _fallbackTargets(combat, combatant, input);
    }
    // Issue #38 shared squad contacts: teammates' merged memory joins the
    // target list marked `team-contact`. Live/injected records always win;
    // between two memory records the fresher sighting wins, and an equal
    // timestamp keeps the existing (own) entry.
    for (const raw of _teamContactRaws({ combat, combatant, perception, context, distrustsContacts })
        .concat(_netContactRaws({ combat, combatant, perception, context, distrustsContacts }))) {
        const shared = _normalizeTarget(raw, {
            ...input,
            source: raw?.relay === true || raw?.source === "relay"
                ? "relay"
                : (raw?.sourceCombatantId != null || raw?.source === "team-contact"
                    ? "team-contact"
                    : "last-known")
        });
        if (!shared) continue;
        const key = shared.tokenUuid ?? shared.tokenId;
        const index = targets.findIndex(target =>
            (target.tokenUuid ?? target.tokenId) === key);
        if (index < 0) {
            targets.push(shared);
            continue;
        }
        const existing = targets[index];
        if (!_isMemorySource(existing.source) || !_isMemorySource(shared.source)) {
            continue;
        }
        const sharedTs = (_finiteOr(shared.lastSeenRound, 0) * 1e6)
            + _finiteOr(shared.lastSeenTurn, 0);
        const existingTs = (_finiteOr(existing.lastSeenRound, 0) * 1e6)
            + _finiteOr(existing.lastSeenTurn, 0);
        if (sharedTs > existingTs) targets[index] = shared;
    }
    // Smoke finding: spec-ops/assault presets with zero intel (no LOS,
    // no memory, no relay) still need a destination — the squad's radio
    // intel puts unattackable approach markers on the nearest hostiles.
    if (!targets.length && context.seekContacts === true) {
        targets = _intelContacts(combat, combatant, input)
            .map(raw => _normalizeTarget(raw, { ...input, source: "intel" }))
            .filter(Boolean);
    }
    // Issue #37: read the `reactionUsed` flag off each target's own
    // combatant — a spent-reaction enemy cannot dodge, which raises the
    // attack EV against it ("finish the dodged target"). Injected
    // `reactionUsed` entries win; the flag only fills blanks.
    const round = Number.isFinite(combat?.round) ? combat.round : null;
    for (const target of targets) {
        if (target.reactionUsed === true) continue;
        const other = _findCombatantByToken(combat, target.tokenId);
        const record = other?.getFlag?.(MODULE_ID, FLAG_KEYS.reactionUsed)
            ?? other?.flags?.[MODULE_ID]?.[FLAG_KEYS.reactionUsed];
        if (reactionUsed(record, round)) target.reactionUsed = true;
    }
    const seen = new Set();
    return targets
        .filter(target => {
            const key = target.tokenUuid ?? target.tokenId;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .sort((a, b) => String(a.tokenUuid ?? a.tokenId)
            .localeCompare(String(b.tokenUuid ?? b.tokenId)));
}


/**
 * Raw shared-contact records for `_resolveTargets` (issue #38). Injection
 * order: `context.teamContacts` (entry array), then `context.team.contacts`
 * — the merged map/entry list the fireteam service builds once per
 * TeamPlan — and finally the live `perception.teamLastKnownPositions`
 * lookup when the combatant carries a `team.teamId`. `shareContacts ===
 * false` on `context` or `context.team` disables the merge entirely.
 * @param {object} input
 * @param {object} input.combat Combat document.
 * @param {object} input.combatant Active combatant document.
 * @param {object|null} input.perception Perception service or null.
 * @param {object} input.context Planning context.
 * @param {boolean} [input.distrustsContacts] Personality gate (issue #38
 *   review): a `distrustsContacts` trait flag or a `rabble` squad
 *   character makes the bot ignore shared contacts entirely — its own
 *   memory still works.
 * @returns {object[]}
 */
export function _teamContactRaws({ combat, combatant, perception, context,
    distrustsContacts = false }) {
    if (distrustsContacts === true) return [];
    if (context?.shareContacts === false || context?.team?.shareContacts === false) {
        return [];
    }
    if (Array.isArray(context?.teamContacts)) return context.teamContacts;
    const contacts = context?.team?.contacts;
    if (Array.isArray(contacts)) return contacts;
    if (contacts && typeof contacts === "object") {
        return Object.entries(contacts)
            .map(([tokenUuid, entry]) => ({ tokenUuid, ...entry }));
    }
    const teamId = context?.team?.teamId ?? _teamIdOf(combatant);
    if (teamId && typeof perception?.teamLastKnownPositions === "function") {
        try {
            const shared = perception.teamLastKnownPositions(combat, combatant, teamId);
            return Array.isArray(shared) ? shared : [];
        } catch(err) {
            return [];
        }
    }
    return [];
}


/**
 * Comms-net contacts (smoke finding): combatants sharing a `commsNet`
 * flag id exchange last-known contacts with a radio delay — distant
 * squads advance toward reported contacts instead of holding forever,
 * without the instant dogpile a zero-latency merge would produce.
 * `context.commsNet` injects the id in tests; `context.commsDelay`
 * overrides the default one-round lag; entries arrive `source: "relay"`.
 * @param {object} input
 * @param {object} input.combat Combat document.
 * @param {object} input.combatant Active combatant document.
 * @param {object|null} input.perception Perception service or null.
 * @param {object} input.context Planning context.
 * @param {boolean} [input.distrustsContacts] Same personality gate as
 *   `_teamContactRaws` — a distrusting bot believes no hearsay either.
 * @returns {object[]}
 */
export function _netContactRaws({ combat, combatant, perception, context,
    distrustsContacts = false }) {
    if (distrustsContacts === true) return [];
    if (context?.shareContacts === false || context?.team?.shareContacts === false) {
        return [];
    }
    const netId = context?.commsNet ?? _commsNetOf(combatant);
    if (!netId || typeof perception?.netLastKnownPositions !== "function") return [];
    const delay = _finiteOr(context?.commsDelay, 1);
    try {
        const shared = perception.netLastKnownPositions(combat, combatant, netId, delay);
        return Array.isArray(shared) ? shared : [];
    } catch(err) {
        return [];
    }
}


/**
 * Resolved `commsNet` id of a combatant without a context injection:
 * combatant flag wins, then the linked token, then the actor — matching
 * `perception._commsNetOf` (duplicated to keep services cycle-free).
 * @param {object} combatant
 * @returns {string|null}
 */
export function _commsNetOf(combatant) {
    const read = doc => {
        if (!doc) return null;
        try {
            if (typeof doc.getFlag === "function") {
                const flag = doc.getFlag(MODULE_ID, FLAG_KEYS.commsNet);
                if (typeof flag === "string" && flag) return flag;
                if (typeof flag?.netId === "string" && flag.netId) return flag.netId;
            }
        } catch(_err) {
            // Fall back to the raw flags object below.
        }
        const flag = doc?.flags?.[MODULE_ID]?.[FLAG_KEYS.commsNet];
        if (typeof flag === "string" && flag) return flag;
        return typeof flag?.netId === "string" && flag.netId ? flag.netId : null;
    };
    const tokenDoc = _tokenDoc(combatant?.token);
    return read(combatant)
        ?? read(tokenDoc)
        ?? read(combatant?.actor ?? tokenDoc?.actor)
        ?? null;
}


/**
 * Resolved fireteam `teamId` of a combatant without a TeamPlan context:
 * combatant flag wins, then the linked token, then the actor — the same
 * field-priority chain `resolveTeamConfig`/`perception._teamIdOf` apply
 * (duplicated here because planner ↔ fireteam would be an import cycle).
 * @param {object} combatant
 * @returns {string|null}
 */
export function _teamIdOf(combatant) {
    const read = doc => {
        if (!doc) return null;
        try {
            if (typeof doc.getFlag === "function") {
                const flag = doc.getFlag(MODULE_ID, FLAG_KEYS.fireteam);
                if (typeof flag?.teamId === "string" && flag.teamId) {
                    return flag.teamId;
                }
            }
        } catch(_err) {
            // Fall back to the raw flags object below.
        }
        const flag = doc?.flags?.[MODULE_ID]?.[FLAG_KEYS.fireteam];
        return typeof flag?.teamId === "string" && flag.teamId
            ? flag.teamId : null;
    };
    const tokenDoc = _tokenDoc(combatant?.token);
    return read(combatant)
        ?? read(tokenDoc)
        ?? read(combatant?.actor ?? tokenDoc?.actor)
        ?? null;
}


/**
 * Whether two dispositions are hostile to each other (hostile в†” friendly).
 * Neutral tokens fight no one unless `options.includeNeutral` allows
 * targeting them; `options.dispositions` overrides the rule entirely.
 * @param {*} a
 * @param {*} b
 * @param {object} [options]
 * @param {boolean} [options.includeNeutral] Accept neutral targets.
 * @param {number[]|null} [options.dispositions] Explicit disposition allow-list.
 * @returns {boolean}
 */
export function _hostileTo(a, b, { includeNeutral = false, dispositions = null } = {}) {
    const sa = Math.sign(_finiteOr(a, 0));
    const sb = Math.sign(_finiteOr(b, 0));
    if (Array.isArray(dispositions)) return dispositions.includes(sb);
    if (sb === 0) return includeNeutral === true && sa !== 0;
    return sa !== 0 && sa !== sb;
}


/**
 * Whether a token is "on the viewer's side" for shooting-into-melee
 * purposes (issue #39): same non-zero disposition, or a neutral token —
 * but only when `includeNeutral` marks neutrals as tracked at all. An
 * explicit `dispositions` allow-list treats everything outside the
 * hostile list as a friendly the bot should not risk hitting.
 * @param {*} viewer Viewer disposition.
 * @param {*} disp Candidate token disposition.
 * @param {object} [options] Same options as {@link _hostileTo}.
 * @param {boolean} [options.includeNeutral] Track neutral tokens as allies.
 * @param {number[]|null} [options.dispositions] Explicit hostile allow-list.
 * @returns {boolean}
 */
export function _isAllyDisposition(viewer, disp, { includeNeutral = false, dispositions = null } = {}) {
    const sa = Math.sign(_finiteOr(viewer, 0));
    const sb = Math.sign(_finiteOr(disp, 0));
    if (sb === 0) return includeNeutral === true;
    if (Array.isArray(dispositions)) return !dispositions.includes(sb);
    return sa !== 0 && sb === sa;
}


/**
 * Set of hostile token uuids currently engaged in melee with an ally
 * (issue #39): every token hostile to the viewer that stands within
 * `reachPx` of a same-side token. The viewer token itself and the
 * evaluated token never count as their own ally. Only the uuid set is
 * built — the candidate factor then checks membership per target.
 * @param {object} input
 * @param {object[]} input.tokens Scene token scan (`_blastTokens` shape).
 * @param {number} input.viewerDisposition Viewer disposition.
 * @param {string|null} input.selfTokenUuid Viewer token uuid — excluded.
 * @param {number} input.reachPx Melee reach in pixels (fallback).
 * @param {Function} [input.resolveReachPx] `(target, ally) => px|null` —
 *   per-pair melee reach (issue #39 review: long-reach weapons reach a
 *   cell further than `DEFAULT_MELEE_RANGE`); `null` uses `reachPx`.
 * @param {object} input.options `{includeNeutral, dispositions}`.
 * @returns {Map<string, number>} Hostile uuid → count of allies in melee
 *   reach of it. `.has()` keeps the Set semantics callers already use;
 *   the count feeds the `outnumber` factor (ganging up, OW +10/+20).
 */
export function _allyEngagedTargets({ tokens, viewerDisposition, selfTokenUuid, reachPx,
    resolveReachPx = null, options }) {
    const engaged = new Map();
    for (const target of tokens ?? []) {
        if (!target || target.tokenUuid == null) continue;
        const disp = Math.sign(_finiteOr(target.disposition, 0));
        if (!_hostileTo(viewerDisposition, disp, options)) continue;
        for (const token of tokens) {
            if (!token || token === target) continue;
            if (selfTokenUuid != null && token.tokenUuid === selfTokenUuid) continue;
            if (token.tokenUuid != null && token.tokenUuid === target.tokenUuid) continue;
            if (!_isAllyDisposition(viewerDisposition, token.disposition, options)) continue;
            const pairReach = typeof resolveReachPx === "function"
                ? resolveReachPx(target, token) : null;
            const limit = Number.isFinite(pairReach) && pairReach > 0 ? pairReach : reachPx;
            if (_distPx(target, token) <= limit + 1e-9) {
                engaged.set(target.tokenUuid, (engaged.get(target.tokenUuid) ?? 0) + 1);
            }
        }
    }
    return engaged;
}


/**
 * Enemy contact entries for the disengage/engage-denial factors (issue
 * #39): every perceived enemy position plus the melee reach it
 * threatens. The reach comes from the target's threat emitters — the
 * longest melee emitter range — with a {@link DEFAULT_MELEE_RANGE}
 * fallback (any combatant can swing unarmed). Pure: only snapshot data
 * is read, so the factors stay deterministic functions of the plan
 * inputs (issue #24).
 * @param {object[]} targets Normalized planner targets (pixels).
 * @param {object[]} threats Resolved threat sources with `emitters`.
 * @param {number} pxPerUnit Pixels per scene unit (`_pxPerUnit`).
 * @returns {object[]} `{x, y, reachPx, tokenUuid}` entries.
 */
export function _enemyContacts(targets, threats, pxPerUnit) {
    const emittersOf = new Map();
    for (const source of threats ?? []) {
        const key = source?.tokenUuid ?? source?.id ?? null;
        if (key != null) emittersOf.set(key, source.emitters ?? []);
    }
    const scale = pxPerUnit > 0 ? pxPerUnit : 1;
    const contacts = [];
    for (const target of targets ?? []) {
        if (!Number.isFinite(target?.x) || !Number.isFinite(target?.y)) continue;
        const emitters = emittersOf.get(target.tokenUuid) ?? target.emitters ?? [];
        const meleeRanges = emitters
            .filter(emitter => emitter && emitter.melee === true)
            .map(emitter => _finiteOr(emitter.range, DEFAULT_MELEE_RANGE))
            .filter(range => range > 0);
        // A target that carries a melee reach itself (injected profile)
        // uses it when no emitter list survives.
        if (!meleeRanges.length && target.melee === true
            && Number.isFinite(target.range) && target.range > 0) {
            meleeRanges.push(target.range);
        }
        const reach = meleeRanges.length
            ? Math.max(...meleeRanges)
            : DEFAULT_MELEE_RANGE;
        contacts.push({ x: target.x, y: target.y, reachPx: reach * scale,
            tokenUuid: target.tokenUuid ?? null });
    }
    return contacts;
}


/**
 * Nearest known threat: visible attackable targets win; when nothing is
 * visible the nearest last-known contact gives the overwatch bearing.
 * @param {object[]} targets Normalized targets.
 * @param {{x: number|null, y: number|null}} selfPos
 * @param {object} grid Normalized grid info.
 * @returns {object|null}
 */
export function _nearestThreat(targets, selfPos, grid) {
    const list = (targets ?? []).filter(target => Number.isFinite(target?.x)
        && Number.isFinite(target?.y));
    if (!list.length) return null;
    const key = target => Number.isFinite(target.distance) ? target.distance
        : (_pixelDistance(selfPos, target, grid) ?? Infinity);
    const visible = list.filter(target => target.canAttack === true);
    const pool = visible.length ? visible : list;
    return pool.reduce((best, target) => (key(target) < key(best) ? target : best), pool[0]);
}
