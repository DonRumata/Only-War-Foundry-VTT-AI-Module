/**
 * Interdiction-screen pure core (issue #87, epic #84) — «перехват стрелков
 * и чарджеров».
 *
 * This module is the deterministic, side-effect-free heart of the
 * interdiction-screen tactic. It deliberately knows nothing about the
 * fireteam service, the spec-ops selector or the planner: every input is
 * injected (members, targets, geometry probes, thresholds) and the output
 * is a JSON-serializable tactic fragment the integration layer merges
 * into a full spec-ops tactic descriptor.
 *
 * Design contract (design spec, task #87):
 * - Trigger A ("pure shooter shutdown"): an enemy whose ranged EV both
 *   dominates its total EV (`confidence >= confidenceMin`, default 0.7)
 *   and clears an absolute floor (`rangedEV >= minRangedEV`, default 6 ≈
 *   0.6 × the lasgun reference damage) is worth tying up in melee.
 * - Trigger B ("charger screen"): an enemy melee charger (`meleeEV > 0`
 *   and inverse confidence `>= chargerConfidenceMin`, default 0.5) whose
 *   charge reach covers a team shooter is screened by interposing a body
 *   on the enemy → protected-ally segment. Priority is strictly B > A —
 *   a charge kills faster than a firing lane.
 * - Target eligibility: visible/attackable contacts only — memory,
 *   relay and intel contacts never qualify; pinned/stunned targets are
 *   already neutralized; a target already in melee with a team member
 *   needs no interception.
 * - Interdictor scoring is fully deterministic: melee EV, charge rate,
 *   wounds and a deliberately pessimistic survival model (`rtd` — rounds
 *   to death against the target's best melee emitter) gated per team
 *   character (elite/shock 1.5, disciplined/default 2, rabble 3). The
 *   leader carries a −3 penalty, never a veto.
 * - `chargeExpected` is a cheap geometric precheck (distance inside
 *   `[chargeMinDistance, chargeRate]`, no move-blocking wall on the
 *   straight segment) — conservative by design; the screen-point role
 *   fallback makes a wrong positive harmless.
 * - The screen point is a contact/mid/deep fallback chain quantized to
 *   grid cell centres; a degenerate segment degrades the role to a plain
 *   assault on the target.
 * - One interdictor is mandatory for the tactic; a second is only ever
 *   fielded with ≥ 5 team members, two independent threats and ≥ 3
 *   members left for the base maneuver — `rabble` never fields two.
 * - The interdiction target is excluded from the team fire lists via
 *   `excludedTargets` — a command rule, not a weight compromise.
 *
 * The module never touches documents, `game` or canvas state and
 * reproduces identical output for identical input.
 */
import {
    DEFAULT_MELEE_ALLOWANCE,
    DEFAULT_MELEE_REACH,
    weaponEmitters
} from "../threat-map.js";
import { CHARGE_MIN_DISTANCE } from "../planner/contract.js";
import { _statusIds, _tokenDoc } from "../planner/documents.js";
import { _isMemorySource } from "../planner/targets.js";
import { isGmControlled } from "../layers.js";

/** Tactic name recorded in the descriptor (spec-ops integration scope). */
export const INTERDICTION_TACTIC = "interdiction-screen";

/** Role marker carried by object-form interdictor assignments. */
export const INTERDICT_ROLE = "interdictor";

/** Objective type of the interdiction objective record. */
export const INTERDICT_OBJECTIVE_TYPE = "interdict";

/** Exclusion reason stamped on `excludedTargets` entries. */
export const INTERDICT_EXCLUSION_REASON = "interdiction";

/** Trigger labels used across the descriptor and breakdown. */
export const INTERDICT_TRIGGERS = Object.freeze(["A", "B", "both"]);

/** Stable degradation/rejection reason codes (breakdown contract). */
export const INTERDICT_REJECTIONS = Object.freeze({
    insufficientMembers: "insufficient-members",
    noTarget: "no-interdiction-target",
    noInterdictor: "no-interdictor",
    noSurvivableInterdictor: "no-survivable-interdictor",
    memorySource: "memory-source",
    notAttackable: "not-attackable",
    hidden: "hidden",
    noPosition: "no-position",
    targetPinned: "target-pinned",
    targetStunned: "target-stunned",
    alreadyEngaged: "already-engaged",
    confidenceBelowMin: "confidence-below-min",
    rangedEvBelowFloor: "ranged-ev-below-floor",
    notMeleeOriented: "not-melee-oriented",
    noThreatenedShooter: "no-threatened-shooter",
    disabled: "disabled",
    defeated: "defeated",
    gmControlled: "gm-controlled",
    statusStunned: "status-stunned",
    statusPinned: "status-pinned",
    statusProne: "status-prone",
    notMeleeCapable: "not-melee-capable",
    chargeRateUnavailable: "charge-rate-unavailable",
    survivalBelowThreshold: "survival-below-threshold",
    screenDegenerate: "screen-degenerate",
    noProtectMember: "no-protect-member"
});

/**
 * Experimental default thresholds (first-pass calibration against the
 * lasgun profile; the integration layer re-exports them through the
 * spec-ops config — every value is overridable per call).
 */
export const INTERDICTION_DEFAULTS = Object.freeze({
    confidenceMin: 0.7,
    minRangedEV: 6,
    chargerConfidenceMin: 0.5,
    survivalThresholds: Object.freeze({
        elite: 1.5,
        shock: 1.5,
        disciplined: 2,
        rabble: 3,
        default: 2
    }),
    chargeMinDistance: CHARGE_MIN_DISTANCE,
    meleeReach: DEFAULT_MELEE_REACH,
    meleeAllowance: DEFAULT_MELEE_ALLOWANCE,
    contactOffset: 1.5,
    deepOffset: 4,
    degenerateSegment: 2,
    rtdCap: 4,
    leaderPenalty: 3,
    threatZoneBuffer: 1,
    minMembersForSecond: 5,
    minBaseMembersAfterSecond: 3,
    maxDetachedPhases: 2
});

/** Screen-point candidate kinds in fallback-chain order. */
export const SCREEN_KINDS = Object.freeze(["contact", "mid", "deep"]);

/** Small geometric epsilon for inclusive range checks. */
const EPS = 1e-9;

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
 * Round to 1e-4 for stable serialization; non-finite becomes null.
 * @param {*} value
 * @returns {number|null}
 */
function _round(value) {
    return Number.isFinite(value) ? Math.round(value * 1e4) / 1e4 : null;
}

/**
 * Whether a point has both coordinates.
 * @param {object|null} point
 * @returns {boolean}
 */
function _isPoint(point) {
    return Number.isFinite(point?.x) && Number.isFinite(point?.y);
}

/**
 * Euclidean distance between two `{x, y}` pixel points (Infinity when
 * incomplete).
 * @param {object|null} a
 * @param {object|null} b
 * @returns {number}
 */
function _dist(a, b) {
    if (!_isPoint(a) || !_isPoint(b)) return Number.POSITIVE_INFINITY;
    return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Normalize the grid conversion info; null means pixel inputs are
 * already scene units (1:1 conversion).
 * @param {object|null} grid `{size, distance}`.
 * @returns {{size: number, distance: number}|null}
 */
function _gridOf(grid) {
    const size = _finiteOr(grid?.size, 0);
    const distance = _finiteOr(grid?.distance, 0);
    return size > 0 && distance > 0 ? { size, distance } : null;
}

/**
 * Convert a pixel length to scene units (1:1 without grid info).
 * @param {number} px
 * @param {object|null} grid
 * @returns {number}
 */
function _units(px, grid) {
    const info = _gridOf(grid);
    return info ? (px / info.size) * info.distance : px;
}

/**
 * Scene-unit distance between two pixel points.
 * @param {object|null} a
 * @param {object|null} b
 * @param {object|null} grid
 * @returns {number}
 */
function _distUnits(a, b, grid) {
    return _units(_dist(a, b), grid);
}

/* ------------------------------------------------------------------ */
/* Wall geometry (duplicated pure helpers — the spec-ops copies are    */
/* module-private and shared files stay untouched in this task).       */
/* ------------------------------------------------------------------ */

/**
 * Unwrap a Wall placeable to its WallDocument; documents pass through.
 * @param {*} wall
 * @returns {object|null}
 */
function _wallDoc(wall) {
    return wall?.document ?? wall ?? null;
}

/**
 * Whether a wall document blocks the given sense ("sight" or "move"),
 * accepting both the v13 object schema and the legacy numeric schema.
 * Open doors never block.
 * @param {object} doc
 * @param {string} sense
 * @returns {boolean}
 */
function _wallBlocks(doc, sense) {
    if (!doc || typeof doc !== "object") return false;
    const doorState = doc.door?.state ?? doc.doorState ?? doc.ds;
    if (doorState === "open" || doorState === 1) return false;
    const field = doc[sense];
    if (field === null || field === undefined) return false;
    if (typeof field === "number") return field > 0;
    if (typeof field === "object") {
        if (field.enabled === false) return false;
        return field.type !== "none" && field.type !== 0;
    }
    return false;
}

/**
 * Wall endpoints as a segment, from the `c`/`coords` coordinate array or
 * `A`/`B` point fields.
 * @param {object} doc
 * @returns {{A: {x: number, y: number}, B: {x: number, y: number}}|null}
 */
function _wallSegment(doc) {
    const coords = doc?.c ?? doc?.coords ?? null;
    if (Array.isArray(coords) && coords.length >= 4
        && coords.slice(0, 4).every(Number.isFinite)) {
        return {
            A: { x: coords[0], y: coords[1] },
            B: { x: coords[2], y: coords[3] }
        };
    }
    const a = doc?.A;
    const b = doc?.B;
    if (Number.isFinite(a?.x) && Number.isFinite(a?.y)
        && Number.isFinite(b?.x) && Number.isFinite(b?.y)) {
        return { A: { x: a.x, y: a.y }, B: { x: b.x, y: b.y } };
    }
    return null;
}

/**
 * Cross-product direction of segment `a → b` toward point `p`.
 * @param {{x: number, y: number}} a
 * @param {{x: number, y: number}} b
 * @param {{x: number, y: number}} p
 * @returns {number}
 */
function _cross(a, b, p) {
    return ((b.x - a.x) * (p.y - a.y)) - ((b.y - a.y) * (p.x - a.x));
}

/**
 * Whether point `p` lies on segment `a → b` (assumes collinearity).
 * @param {{x: number, y: number}} a
 * @param {{x: number, y: number}} b
 * @param {{x: number, y: number}} p
 * @returns {boolean}
 */
function _onSegment(a, b, p) {
    return p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x)
        && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
}

/**
 * Inclusive 2D segment intersection test: proper crossings plus endpoint
 * touches, matching the navigation adapter's collision semantics.
 * @param {{x: number, y: number}} p1
 * @param {{x: number, y: number}} p2
 * @param {{x: number, y: number}} p3
 * @param {{x: number, y: number}} p4
 * @returns {boolean}
 */
function _segmentsIntersect(p1, p2, p3, p4) {
    const d1 = _cross(p3, p4, p1);
    const d2 = _cross(p3, p4, p2);
    const d3 = _cross(p1, p2, p3);
    const d4 = _cross(p1, p2, p4);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
        && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
        return true;
    }
    if (d1 === 0 && _onSegment(p3, p4, p1)) return true;
    if (d2 === 0 && _onSegment(p3, p4, p2)) return true;
    if (d3 === 0 && _onSegment(p1, p2, p3)) return true;
    if (d4 === 0 && _onSegment(p1, p2, p4)) return true;
    return false;
}

/**
 * Count move-blocking walls of the injected list crossed by `from → to`.
 * @param {object|null} from
 * @param {object|null} to
 * @param {object[]} walls Wall documents/segments.
 * @returns {number}
 */
function _moveWallsCrossed(from, to, walls) {
    if (!_isPoint(from) || !_isPoint(to)) return 0;
    let count = 0;
    for (const raw of walls ?? []) {
        const doc = _wallDoc(raw);
        if (!_wallBlocks(doc, "move")) continue;
        const segment = _wallSegment(doc);
        if (segment && _segmentsIntersect(from, to, segment.A, segment.B)) count += 1;
    }
    return count;
}

/**
 * Resolve the move-blocking wall probe: an explicit `wallProbe(from, to)`
 * wins (returns true when the straight segment is blocked), otherwise a
 * probe is built from the injected `walls` list; without either the
 * battlefield reads as open ground.
 * @param {Function|null|undefined} wallProbe
 * @param {object[]|null|undefined} walls
 * @returns {Function} `(fromPx, toPx) => boolean` blocked.
 */
function _resolveWallProbe(wallProbe, walls) {
    if (typeof wallProbe === "function") {
        return (from, to) => {
            try {
                return wallProbe(from, to) === true;
            } catch(_err) {
                return false;
            }
        };
    }
    const list = Array.isArray(walls) ? walls : [];
    return (from, to) => _moveWallsCrossed(from, to, list) > 0;
}

/* ------------------------------------------------------------------ */
/* Profiles                                                            */
/* ------------------------------------------------------------------ */

/**
 * Extended shooter profile of an enemy target (seed correction 1):
 * `{melee, rangedEV, meleeEV, chargeRate}` — ranged/melee EV of the best
 * emitter of each class plus the charge movement rate (null when
 * unreadable). Resolution order: an explicit `shooterProfile`/`profile`
 * object, flat fields (`rangedEV`/`meleeEV`/`meleeDamage`/`chargeRate`),
 * a raw `emitters` list, then the target actor's weapon items through
 * the same `weaponEmitters` projection that feeds the danger field.
 * @param {object|null} target Target record.
 * @returns {{melee: boolean, rangedEV: number, meleeEV: number,
 *   chargeRate: number|null}}
 */
export function shooterProfileOf(target) {
    const explicit = target?.shooterProfile ?? target?.profile ?? null;
    const emitters = Array.isArray(target?.emitters) ? target.emitters : null;
    const actor = target?.actor ?? null;
    const projected = emitters ?? (actor ? weaponEmitters(actor) : []);
    let rangedEV = 0;
    let meleeEV = 0;
    for (const emitter of projected ?? []) {
        const ev = _finiteOr(emitter?.ev ?? emitter?.damage, 0);
        if (!(ev > 0)) continue;
        if (emitter?.melee === true) meleeEV = Math.max(meleeEV, ev);
        else rangedEV = Math.max(rangedEV, ev);
    }
    rangedEV = _finiteOr(explicit?.rangedEV ?? explicit?.rangedDamage,
        _finiteOr(target?.rangedEV ?? target?.rangedDamage, rangedEV));
    meleeEV = _finiteOr(explicit?.meleeEV ?? explicit?.meleeDamage,
        _finiteOr(target?.meleeEV ?? target?.meleeDamage, meleeEV));
    const movementCharge = target?.movement?.charge
        ?? actor?.system?.movement?.charge ?? null;
    const chargeRate = _finiteOr(explicit?.chargeRate,
        _finiteOr(target?.chargeRate, _finiteOr(movementCharge, null)));
    return {
        melee: meleeEV > 0,
        rangedEV,
        meleeEV,
        chargeRate: Number.isFinite(chargeRate) ? chargeRate : null
    };
}

/**
 * Median armour soak of an actor (survival model): the median `total`
 * across the prepared hit locations of `actor.system.armour`; fallback —
 * the toughness bonus characteristic, otherwise 0.
 * @param {object|null} actor
 * @returns {number}
 */
export function soakOfActor(actor) {
    const armour = actor?.system?.armour ?? null;
    const totals = [];
    if (armour && typeof armour === "object") {
        for (const key of Object.keys(armour)) {
            const total = armour[key]?.total;
            if (Number.isFinite(total)) totals.push(total);
        }
    }
    if (totals.length) {
        totals.sort((a, b) => a - b);
        const mid = Math.floor(totals.length / 2);
        return totals.length % 2
            ? totals[mid]
            : (totals[mid - 1] + totals[mid]) / 2;
    }
    return _finiteOr(actor?.system?.characteristics?.toughness?.bonus, 0);
}

/**
 * Weapon capability projection of one team member: melee/ranged EV of
 * the best emitter per class, the longest non-melee reach, movement
 * rates, current wounds and armour soak. Explicit member fields win over
 * the actor-derived values so tests can inject a loadout summary without
 * a full document tree.
 * @param {object|null} member Fireteam member entry.
 * @returns {object} `{meleeEV, rangedEV, bestRange, chargeRate, fullMove,
 *   wounds, soak}`.
 */
export function memberCombatProfile(member) {
    const actor = member?.combatant?.actor ?? member?.actor ?? null;
    const emitters = Array.isArray(member?.emitters)
        ? member.emitters
        : weaponEmitters(actor);
    let meleeEV = 0;
    let rangedEV = 0;
    let bestRange = 0;
    for (const emitter of emitters ?? []) {
        const ev = _finiteOr(emitter?.ev ?? emitter?.damage, 0);
        if (!(ev > 0)) continue;
        if (emitter?.melee === true) meleeEV = Math.max(meleeEV, ev);
        else {
            rangedEV = Math.max(rangedEV, ev);
            bestRange = Math.max(bestRange, _finiteOr(emitter?.range, 0));
        }
    }
    meleeEV = _finiteOr(member?.meleeEV, meleeEV);
    rangedEV = _finiteOr(member?.rangedEV, rangedEV);
    bestRange = _finiteOr(member?.bestRange, bestRange);
    const movement = actor?.system?.movement ?? member?.movement ?? null;
    const chargeRate = _finiteOr(member?.chargeRate, _finiteOr(movement?.charge, null));
    // The system derives full = 2×base and charge = 3×base from the same
    // agility base, so the ratio holds exactly when only the charge rate
    // is readable (actor-preparation: computeMovement).
    const fullMove = _finiteOr(member?.fullMove,
        _finiteOr(movement?.full,
            Number.isFinite(chargeRate) ? (chargeRate * 2) / 3 : null));
    const wounds = _finiteOr(member?.hp,
        _finiteOr(member?.wounds,
            _finiteOr(actor?.system?.wounds?.value, 0)));
    return {
        meleeEV,
        rangedEV,
        bestRange,
        chargeRate: Number.isFinite(chargeRate) ? chargeRate : null,
        fullMove: Number.isFinite(fullMove) ? fullMove : null,
        wounds,
        soak: soakOfActor(actor)
    };
}

/**
 * Resolve the survival threshold for a team character.
 * @param {string|null} character `disciplined|shock|elite|rabble`.
 * @param {object} cfg Resolved interdiction config.
 * @returns {number}
 */
export function survivalThresholdOf(character, cfg = INTERDICTION_DEFAULTS) {
    const thresholds = cfg.survivalThresholds ?? INTERDICTION_DEFAULTS.survivalThresholds;
    return _finiteOr(thresholds?.[character], _finiteOr(thresholds?.default, 2));
}

/**
 * Merge threshold overrides over the experimental defaults — every key
 * validates as a finite positive number (or a thresholds object), junk
 * input falls back to the default.
 * @param {object|null} [overrides]
 * @returns {object}
 */
export function resolveInterdictionConfig(overrides = null) {
    const cfg = { ...INTERDICTION_DEFAULTS, survivalThresholds: { ...INTERDICTION_DEFAULTS.survivalThresholds } };
    if (!overrides || typeof overrides !== "object") return cfg;
    for (const key of [
        "confidenceMin", "minRangedEV", "chargerConfidenceMin", "chargeMinDistance",
        "meleeReach", "meleeAllowance", "contactOffset", "deepOffset", "degenerateSegment",
        "rtdCap", "leaderPenalty", "threatZoneBuffer", "minMembersForSecond",
        "minBaseMembersAfterSecond", "maxDetachedPhases"
    ]) {
        if (Number.isFinite(overrides[key])) cfg[key] = overrides[key];
    }
    if (overrides.survivalThresholds && typeof overrides.survivalThresholds === "object") {
        for (const key of Object.keys(overrides.survivalThresholds)) {
            if (Number.isFinite(overrides.survivalThresholds[key])) {
                cfg.survivalThresholds[key] = overrides.survivalThresholds[key];
            }
        }
    }
    return cfg;
}

/* ------------------------------------------------------------------ */
/* Normalization                                                       */
/* ------------------------------------------------------------------ */

/**
 * Normalize one enemy target record for the selector: identity,
 * position, statuses and the extended shooter profile. Memory-class
 * sources are kept (the eligibility pass rejects them) so the breakdown
 * can report the exact rejection.
 * @param {object} raw
 * @returns {object|null}
 */
function _normalizeTarget(raw) {
    if (!raw || typeof raw !== "object") return null;
    const tokenId = raw.tokenId ?? (typeof raw.tokenUuid === "string"
        ? raw.tokenUuid.split(".").pop()
        : null);
    const tokenUuid = typeof raw.tokenUuid === "string" && raw.tokenUuid
        ? raw.tokenUuid
        : (tokenId ? `Token.${tokenId}` : null);
    if (!tokenId && !tokenUuid) return null;
    return {
        tokenId,
        tokenUuid,
        x: _finiteOr(raw.x, null),
        y: _finiteOr(raw.y, null),
        statuses: _statusIds(raw.statuses),
        canAttack: raw.canAttack !== false,
        hidden: raw.hidden === true,
        source: typeof raw.source === "string" ? raw.source : "injected",
        profile: shooterProfileOf(raw)
    };
}

/**
 * Member position in pixels: the injected `position` first, then the
 * linked token document's coordinates.
 * @param {object} member
 * @returns {{x: number, y: number}|null}
 */
function _memberPosition(member) {
    if (_isPoint(member?.position)) return member.position;
    const token = _tokenDoc(member?.combatant?.token) ?? _tokenDoc(member?.token);
    const x = _finiteOr(token?.x, null);
    const y = _finiteOr(token?.y, null);
    return x !== null && y !== null ? { x, y } : null;
}

/**
 * Status id list of one member — the `_memberStatusIds` projection
 * duplicated here because the fireteam copy is service-private and the
 * selector core is pure (spec note, integration task 4).
 * @param {object} member
 * @returns {string[]}
 */
function _memberStatusIds(member) {
    const doc = _tokenDoc(member?.combatant?.token) ?? _tokenDoc(member?.token);
    return _statusIds(
        member?.combatant?.actor?.statuses,
        doc?.statuses,
        doc?.actor?.statuses,
        member?.statuses
    );
}

/**
 * Normalize one team member for the selector.
 * @param {object} raw Fireteam member entry.
 * @param {number|null} round Live combat round for the gm-controlled gate.
 * @returns {object|null}
 */
function _normalizeMember(raw, round) {
    if (!raw || typeof raw !== "object" || !raw.combatantId) return null;
    const statuses = _memberStatusIds(raw);
    return {
        combatantId: raw.combatantId,
        position: _memberPosition(raw),
        statuses,
        enabled: raw.enabled !== false,
        defeated: raw.defeated === true,
        gmControlled: raw.gmControlled === true
            || (Number.isFinite(round) && isGmControlled(raw.combatant, round)),
        profile: memberCombatProfile(raw)
    };
}

/**
 * Normalize an object-form assignment entry: a bare string reads as
 * `{task}` (epic backward-compatibility contract); objects keep their
 * defined `task`/`role`/`element`/`objective` fields.
 * @param {string|object|null} entry
 * @returns {object|null}
 */
export function normalizeAssignment(entry) {
    if (typeof entry === "string" && entry) return { task: entry };
    if (!entry || typeof entry !== "object") return null;
    const normalized = {};
    if (typeof entry.task === "string" && entry.task) normalized.task = entry.task;
    if (typeof entry.role === "string" && entry.role) normalized.role = entry.role;
    if (typeof entry.element === "string" && entry.element) normalized.element = entry.element;
    if (entry.objective !== null && entry.objective !== undefined) {
        normalized.objective = entry.objective;
    }
    return normalized.task ? normalized : null;
}

/* ------------------------------------------------------------------ */
/* Eligibility                                                         */
/* ------------------------------------------------------------------ */

/**
 * Target identity key used for dedupe/engagement lookups.
 * @param {object} target Normalized target.
 * @returns {string|null}
 */
function _targetKey(target) {
    return target?.tokenUuid ?? target?.tokenId ?? null;
}

/**
 * Whether the target counts as already engaged in melee with any team
 * member: an injected `engagements` list of target keys wins; otherwise
 * a living member standing inside melee reach of the target proves the
 * engagement geometrically.
 * @param {object} target Normalized target.
 * @param {object[]} members Normalized members.
 * @param {object} input `{engagements, grid, cfg}`.
 * @param {Array|null} [input.engagements] Injected engagement keys.
 * @param {object|null} [input.grid] Grid conversion info.
 * @param {object} input.cfg Resolved interdiction config.
 * @returns {boolean}
 */
function _targetEngaged(target, members, { engagements = null, grid = null, cfg }) {
    const key = _targetKey(target);
    if (Array.isArray(engagements)) {
        return engagements.some(entry => entry === key || entry === target.tokenId
            || entry?.targetId === target.tokenId || entry?.targetUuid === target.tokenUuid);
    }
    if (!_isPoint(target)) return false;
    for (const member of members) {
        if (member.defeated || !_isPoint(member.position)) continue;
        if (_distUnits(member.position, target, grid) <= cfg.meleeReach + EPS) return true;
    }
    return false;
}

/**
 * Whether a team member already stands in melee with any enemy: a
 * non-memory target inside melee reach proves it geometrically.
 * @param {object} member Normalized member.
 * @param {object[]} targets Normalized targets.
 * @param {object} input `{grid, cfg}`.
 * @param {object|null} [input.grid] Grid conversion info.
 * @param {object} input.cfg Resolved interdiction config.
 * @returns {boolean}
 */
function _memberEngaged(member, targets, { grid = null, cfg }) {
    if (!_isPoint(member?.position)) return false;
    for (const target of targets ?? []) {
        if (_isMemorySource(target.source) || !_isPoint(target)) continue;
        if (_distUnits(member.position, target, grid) <= cfg.meleeReach + EPS) return true;
    }
    return false;
}

/**
 * Shared target eligibility gate (both triggers): visible/attackable,
 * never memory-class, not hidden, not pinned/stunned, not already in
 * melee with the team. Returns the stable rejection reason or null.
 * @param {object} target Normalized target.
 * @param {object[]} members Normalized members.
 * @param {object} input Engagement/grid/config context.
 * @returns {string|null}
 */
function _targetRejection(target, members, input) {
    if (_isMemorySource(target.source)) return INTERDICT_REJECTIONS.memorySource;
    if (target.hidden === true) return INTERDICT_REJECTIONS.hidden;
    if (target.canAttack !== true) return INTERDICT_REJECTIONS.notAttackable;
    if (!_isPoint(target)) return INTERDICT_REJECTIONS.noPosition;
    if (target.statuses.includes("pinned")) return INTERDICT_REJECTIONS.targetPinned;
    if (target.statuses.includes("stunned")) return INTERDICT_REJECTIONS.targetStunned;
    if (_targetEngaged(target, members, input)) return INTERDICT_REJECTIONS.alreadyEngaged;
    return null;
}

/* ------------------------------------------------------------------ */
/* Triggers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Shooter confidence of a profile: ranged EV over the total EV.
 * @param {number} rangedEV
 * @param {number} meleeEV
 * @returns {number}
 */
function _confidence(rangedEV, meleeEV) {
    return rangedEV / Math.max(rangedEV + meleeEV, 1e-9);
}

/**
 * Whether a normalized member counts as a team shooter worth screening:
 * positive ranged reach, own ranged EV at least its melee EV, living and
 * not already in melee (a member in melee cannot be saved by a screen).
 * @param {object} member Normalized member.
 * @param {object[]} targets Normalized enemy targets.
 * @param {object} input `{grid, cfg}`.
 * @returns {boolean}
 */
function _isTeamShooter(member, targets, input) {
    if (member.defeated) return false;
    if (!(member.profile.bestRange > 0)) return false;
    if (!(member.profile.rangedEV >= member.profile.meleeEV)) return false;
    return !_memberEngaged(member, targets, input);
}

/**
 * Evaluate both triggers over the normalized target list. Every target
 * yields a candidate record carrying its measurements and the stable
 * rejection reason (null for targets passing at least one trigger).
 * @param {object[]} targets Normalized targets.
 * @param {object[]} members Normalized members.
 * @param {object} input `{grid, cfg, engagements}`.
 * @returns {object[]} Candidate records in deterministic order.
 */
function _evaluateTargets(targets, members, input) {
    const { grid = null, cfg } = input;
    const records = [];
    for (const target of targets) {
        const { rangedEV, meleeEV } = target.profile;
        const confidence = _confidence(rangedEV, meleeEV);
        const inverseConfidence = _confidence(meleeEV, rangedEV);
        const baseRejection = _targetRejection(target, members, input);
        const record = {
            target,
            targetId: target.tokenId,
            tokenUuid: target.tokenUuid,
            rangedEV: _round(rangedEV),
            meleeEV: _round(meleeEV),
            confidence: _round(confidence),
            inverseConfidence: _round(inverseConfidence),
            chargeRate: target.profile.chargeRate,
            triggerA: false,
            triggerB: false,
            threatenedCount: 0,
            threatened: [],
            rejected: baseRejection
        };
        if (baseRejection) {
            records.push(record);
            continue;
        }
        // Trigger A: pure-shooter shutdown — confidence gate first, then
        // the absolute ranged-EV floor (pistoleros are not worth a life).
        let triggerARejection = null;
        if (confidence + EPS < cfg.confidenceMin) {
            triggerARejection = INTERDICT_REJECTIONS.confidenceBelowMin;
        } else if (rangedEV + EPS < cfg.minRangedEV) {
            triggerARejection = INTERDICT_REJECTIONS.rangedEvBelowFloor;
        } else {
            record.triggerA = true;
        }
        // Trigger B: melee charger whose charge reach covers a team
        // shooter. The fallback reach is the pessimistic threat-map band
        // (melee reach + charge allowance) when movement is unreadable.
        const meleeOriented = meleeEV > 0 && inverseConfidence + EPS >= cfg.chargerConfidenceMin;
        if (meleeOriented) {
            const reach = Number.isFinite(target.profile.chargeRate) && target.profile.chargeRate > 0
                ? target.profile.chargeRate
                : cfg.meleeReach + cfg.meleeAllowance;
            record.chargeReach = _round(reach);
            const zone = reach + cfg.threatZoneBuffer;
            record.threatened = members
                .filter(member => _isTeamShooter(member, targets, input)
                    && _isPoint(member.position)
                    && _distUnits(target, member.position, grid) <= zone + EPS)
                .map(member => member.combatantId)
                .sort((a, b) => String(a).localeCompare(String(b)));
            record.threatenedCount = record.threatened.length;
            if (record.threatenedCount > 0) record.triggerB = true;
        }
        if (!record.triggerA && !record.triggerB) {
            // The breakdown reports the most informative failure: a
            // melee-oriented enemy failed only the threat-zone check,
            // everyone else failed the shooter attribution first.
            record.rejected = meleeOriented
                ? INTERDICT_REJECTIONS.noThreatenedShooter
                : (triggerARejection ?? INTERDICT_REJECTIONS.notMeleeOriented);
        }
        records.push(record);
    }
    return records;
}

/**
 * Merge trigger candidates into the priority threat queue: B-candidates
 * first (threatened count desc, melee EV desc, tokenUuid asc), then
 * A-only candidates (ranged EV desc, tokenUuid asc); a target qualifying
 * for both triggers keeps its B slot and is stamped `both`.
 * @param {object[]} records Candidate records of `_evaluateTargets`.
 * @returns {object[]} Ordered unique threat queue entries.
 */
function _threatQueue(records) {
    const keyOf = record => _targetKey(record.target);
    const bList = records.filter(record => record.triggerB)
        .sort((a, b) => (b.threatenedCount - a.threatenedCount)
            || (b.meleeEV - a.meleeEV)
            || String(a.tokenUuid ?? a.targetId).localeCompare(String(b.tokenUuid ?? b.targetId)));
    const aList = records.filter(record => record.triggerA)
        .sort((a, b) => (b.rangedEV - a.rangedEV)
            || String(a.tokenUuid ?? a.targetId).localeCompare(String(b.tokenUuid ?? b.targetId)));
    const queue = [];
    const seen = new Set();
    for (const record of bList) {
        seen.add(keyOf(record));
        queue.push({
            record,
            trigger: record.triggerA ? "both" : "B"
        });
    }
    for (const record of aList) {
        if (seen.has(keyOf(record))) continue;
        seen.add(keyOf(record));
        queue.push({ record, trigger: "A" });
    }
    return queue;
}

/* ------------------------------------------------------------------ */
/* Interdictor evaluation                                              */
/* ------------------------------------------------------------------ */

/**
 * Gate rejection of one member as an interdictor candidate (before the
 * survival model): enabled/living/uncontrolled, free of charge-vetoing
 * statuses, melee-capable and carrying a readable positive charge rate.
 * @param {object} member Normalized member.
 * @returns {string|null}
 */
function _interdictorGate(member) {
    if (!member.enabled) return INTERDICT_REJECTIONS.disabled;
    if (member.defeated) return INTERDICT_REJECTIONS.defeated;
    if (member.gmControlled) return INTERDICT_REJECTIONS.gmControlled;
    if (member.statuses.includes("stunned")) return INTERDICT_REJECTIONS.statusStunned;
    if (member.statuses.includes("pinned")) return INTERDICT_REJECTIONS.statusPinned;
    if (member.statuses.includes("prone")) return INTERDICT_REJECTIONS.statusProne;
    if (!(member.profile.meleeEV > 0)) return INTERDICT_REJECTIONS.notMeleeCapable;
    if (!Number.isFinite(member.profile.chargeRate) || member.profile.chargeRate <= 0) {
        return INTERDICT_REJECTIONS.chargeRateUnavailable;
    }
    if (!_isPoint(member.position)) return INTERDICT_REJECTIONS.noPosition;
    return null;
}

/**
 * Deliberately pessimistic survival model of one candidate against the
 * target's best melee emitter: the enemy is assumed to land its full
 * melee EV every round, soaked by the median armour total.
 * @param {object} member Normalized member.
 * @param {number} targetMeleeEV Target melee EV.
 * @param {object} cfg Resolved config.
 * @returns {object} `{hitEV, rtd, margin}`.
 */
function _survival(member, targetMeleeEV, cfg) {
    const hitEV = Math.max(targetMeleeEV - member.profile.soak, 1);
    const rtd = hitEV > 0 ? member.profile.wounds / hitEV : 0;
    return { hitEV, rtd };
}

/**
 * Score one interdictor candidate against one target — deterministic,
 * tie-broken by combatant id ascending.
 * @param {object} member Normalized member.
 * @param {object} record Target candidate record.
 * @param {object} input `{character, leaderId, cfg}`.
 * @param {string|null} [input.character] Team character overlay.
 * @param {string|null} [input.leaderId] Leader combatant id.
 * @param {object} input.cfg Resolved interdiction config.
 * @returns {object} `{score, rtd, hitEV, soak, margin, threshold, pass}`.
 */
function _scoreInterdictor(member, record, { character = null, leaderId = null, cfg }) {
    const threshold = survivalThresholdOf(character, cfg);
    const { hitEV, rtd } = _survival(member, record.meleeEV ?? 0, cfg);
    const margin = Math.min(rtd, cfg.rtdCap) - threshold;
    const leader = leaderId !== null && member.combatantId === leaderId;
    const score = (2 * member.profile.meleeEV)
        + (0.5 * member.profile.chargeRate)
        + (0.2 * member.profile.wounds)
        + margin
        - (leader ? cfg.leaderPenalty : 0);
    return {
        score,
        rtd,
        hitEV,
        soak: member.profile.soak,
        margin,
        threshold,
        pass: rtd + EPS >= threshold
    };
}

/**
 * Cheap geometric charge precheck: the straight-line distance must sit
 * inside `[chargeMinDistance, chargeRate]` and no move-blocking wall may
 * cross the direct segment. Conservative by design — stricter than the
 * corebook "last 4 m straight" rule — because the screen-point fallback
 * absorbs false negatives.
 * @param {object} memberPos Interdictor position in pixels.
 * @param {object} targetPos Target position in pixels.
 * @param {number} chargeRate Charge rate in scene units.
 * @param {object} input `{grid, wallProbe, cfg}`.
 * @param {object|null} [input.grid] Grid conversion info.
 * @param {Function|null} [input.wallProbe] `(from, to) => boolean` blocked.
 * @param {object} [input.cfg] Resolved interdiction config.
 * @returns {boolean}
 */
export function chargeExpectedOf(memberPos, targetPos, chargeRate, {
    grid = null,
    wallProbe = null,
    cfg = INTERDICTION_DEFAULTS
} = {}) {
    if (!_isPoint(memberPos) || !_isPoint(targetPos) || !(chargeRate > 0)) return false;
    const distance = _distUnits(memberPos, targetPos, grid);
    if (!(distance + EPS >= cfg.chargeMinDistance && distance <= chargeRate + EPS)) return false;
    const probe = typeof wallProbe === "function" ? wallProbe : () => false;
    return probe(memberPos, targetPos) !== true;
}

/* ------------------------------------------------------------------ */
/* Screen point                                                        */
/* ------------------------------------------------------------------ */

/**
 * Quantize a pixel point to the centre of its grid cell; without grid
 * info the point is rounded to 1e-2 for serialization stability.
 * @param {{x: number, y: number}} point
 * @param {object|null} grid
 * @returns {{x: number, y: number}}
 */
function _quantize(point, grid) {
    const info = _gridOf(grid);
    if (!info) {
        return { x: Math.round(point.x * 1e2) / 1e2, y: Math.round(point.y * 1e2) / 1e2 };
    }
    return {
        x: (Math.floor(point.x / info.size) * info.size) + (info.size / 2),
        y: (Math.floor(point.y / info.size) * info.size) + (info.size / 2)
    };
}

/**
 * Screen-point fallback chain on the enemy → protect segment: `contact`
 * (1.5 units off the enemy, inside its melee reach — the charge lane is
 * occupied), `mid` (segment midpoint), `deep` (4 units off the protected
 * ally, inside the mandatory straight run-up zone). Reachable points
 * (straight-line within the interdictor's full move) compete by distance
 * to the enemy; the deepest valid point is the direction fallback when
 * nothing is reachable this round. A degenerate segment (< 2 units)
 * builds no screen at all.
 * @param {object} input
 * @param {{x: number, y: number}} input.enemy Enemy position in pixels.
 * @param {{x: number, y: number}} input.protect Protected ally position.
 * @param {{x: number, y: number}} input.interdictor Interdictor position.
 * @param {number} input.fullMove Interdictor full move in scene units.
 * @param {object|null} [input.grid] Grid conversion info.
 * @param {object} [input.cfg] Resolved config.
 * @returns {object} `{point, kind, reachable, degenerate, candidates}`.
 */
export function screenPointOf({ enemy, protect, interdictor, fullMove, grid = null, cfg = INTERDICTION_DEFAULTS }) {
    const lengthUnits = _distUnits(enemy, protect, grid);
    const result = {
        point: null,
        kind: null,
        reachable: false,
        degenerate: false,
        candidates: []
    };
    if (!_isPoint(enemy) || !_isPoint(protect)
        || !(lengthUnits + EPS >= cfg.degenerateSegment)) {
        result.degenerate = true;
        return result;
    }
    const specs = [
        { kind: "contact", t: cfg.contactOffset / lengthUnits },
        { kind: "mid", t: 0.5 },
        { kind: "deep", t: 1 - (cfg.deepOffset / lengthUnits) }
    ];
    const candidates = [];
    for (const spec of specs) {
        // Points must stay strictly inside the segment: a screen beyond
        // either endpoint covers nothing (deep drops out of short lanes).
        if (!(spec.t > EPS) || spec.t >= 1) continue;
        const raw = {
            x: enemy.x + ((protect.x - enemy.x) * spec.t),
            y: enemy.y + ((protect.y - enemy.y) * spec.t)
        };
        const point = _quantize(raw, grid);
        const fromInterdictor = _isPoint(interdictor) && Number.isFinite(fullMove)
            ? _distUnits(interdictor, point, grid)
            : Number.POSITIVE_INFINITY;
        candidates.push({
            kind: spec.kind,
            point,
            t: spec.t,
            distToEnemy: _round(_distUnits(point, enemy, grid)),
            distFromInterdictor: _round(fromInterdictor),
            reachable: fromInterdictor <= fullMove + EPS
        });
    }
    result.candidates = candidates.map(entry => ({
        kind: entry.kind,
        point: entry.point,
        distToEnemy: entry.distToEnemy,
        distFromInterdictor: entry.distFromInterdictor,
        reachable: entry.reachable
    }));
    if (!candidates.length) {
        result.degenerate = true;
        return result;
    }
    const kindOrder = kind => SCREEN_KINDS.indexOf(kind);
    const reachable = candidates
        .filter(entry => entry.reachable)
        .sort((a, b) => (a.distToEnemy - b.distToEnemy) || (kindOrder(a.kind) - kindOrder(b.kind)));
    if (reachable.length) {
        const chosen = reachable[0];
        result.point = chosen.point;
        result.kind = chosen.kind;
        result.reachable = true;
        return result;
    }
    // Nothing reachable this round: walk the deepest point as a
    // direction — next round's screen beats no screen (spec, камень c).
    const fallback = [...candidates].sort((a, b) => kindOrder(b.kind) - kindOrder(a.kind))[0];
    result.point = fallback.point;
    result.kind = fallback.kind;
    result.reachable = false;
    return result;
}

/* ------------------------------------------------------------------ */
/* Selector                                                            */
/* ------------------------------------------------------------------ */

/**
 * Resolve the protected ally for the screen geometry: trigger B protects
 * the threatened shooter nearest the enemy; trigger A protects the team
 * member nearest the enemy (they catch the target's fire the longest).
 * The interdictor itself never counts — the screen interposes a second
 * body. Ties break by combatant id ascending.
 * @param {object} entry Threat queue entry.
 * @param {object[]} members Normalized members.
 * @param {object[]} targets Normalized targets.
 * @param {string} interdictorId Chosen interdictor combatant id.
 * @param {object} input `{grid, cfg}`.
 * @returns {object|null} `{combatantId, position}` or null.
 */
function _protecteeOf(entry, members, targets, interdictorId, input) {
    const { grid = null } = input;
    const enemy = entry.record.target;
    const pool = entry.trigger === "A"
        ? members.filter(member => !member.defeated)
        : members.filter(member => !member.defeated
            && entry.record.threatened.includes(member.combatantId));
    const ranked = pool
        .filter(member => member.combatantId !== interdictorId && _isPoint(member.position))
        .map(member => ({
            combatantId: member.combatantId,
            position: member.position,
            distance: _distUnits(enemy, member.position, grid)
        }))
        .sort((a, b) => (a.distance - b.distance)
            || String(a.combatantId).localeCompare(String(b.combatantId)));
    return ranked[0] ?? null;
}

/**
 * Build the serializable objective record of one interdiction.
 * @param {object} input
 * @param {object} input.entry Threat queue entry.
 * @param {string} input.interdictorId Chosen interdictor combatant id.
 * @param {object|null} input.protectee Protected ally record.
 * @param {object|null} input.screen Screen-point resolution.
 * @param {boolean} input.chargeExpected Charge precheck outcome.
 * @returns {object}
 */
function _objectiveOf({ entry, interdictorId, protectee, screen, chargeExpected }) {
    return {
        type: INTERDICT_OBJECTIVE_TYPE,
        targetId: entry.record.targetId,
        targetUuid: entry.record.tokenUuid,
        interdictorId,
        protectId: protectee?.combatantId ?? null,
        screenPoint: screen?.point ? { x: screen.point.x, y: screen.point.y } : null,
        screenKind: screen?.kind ?? null,
        screenReachable: screen?.reachable === true,
        chargeExpected: chargeExpected === true,
        trigger: entry.trigger
    };
}

/**
 * Evaluate the interdictor pool for one target: gate every member,
 * score the survivors against the target and pick the deterministic
 * best. Per-member rejection detail lands in the breakdown either way.
 * @param {object[]} members Normalized members.
 * @param {object} record Target candidate record.
 * @param {object} input `{character, leaderId, cfg, grid, probe}`.
 * @param {Set<string>} [excluded] Already-assigned combatant ids.
 * @returns {object} `{interdictor, scoring, candidates}`.
 */
function _pickInterdictor(members, record, input, excluded = new Set()) {
    const { character = null, leaderId = null, cfg, grid = null, probe } = input;
    const candidates = [];
    const eligible = [];
    let gatedCount = 0;
    for (const member of members) {
        if (excluded.has(member.combatantId)) continue;
        const rejection = _interdictorGate(member);
        if (rejection) {
            gatedCount += 1;
            candidates.push({
                combatantId: member.combatantId,
                meleeEV: _round(member.profile.meleeEV),
                chargeRate: member.profile.chargeRate,
                wounds: _round(member.profile.wounds),
                score: null,
                rtd: null,
                rejected: rejection
            });
            continue;
        }
        const scoring = _scoreInterdictor(member, record, { character, leaderId, cfg });
        const chargeExpected = chargeExpectedOf(member.position, record.target,
            member.profile.chargeRate, { grid, wallProbe: probe, cfg });
        candidates.push({
            combatantId: member.combatantId,
            meleeEV: _round(member.profile.meleeEV),
            chargeRate: member.profile.chargeRate,
            wounds: _round(member.profile.wounds),
            score: _round(scoring.score),
            rtd: _round(scoring.rtd),
            soak: _round(scoring.soak),
            hitEV: _round(scoring.hitEV),
            margin: _round(scoring.margin),
            threshold: scoring.threshold,
            chargeExpected,
            rejected: scoring.pass ? null : INTERDICT_REJECTIONS.survivalBelowThreshold
        });
        if (scoring.pass) eligible.push({ member, scoring, chargeExpected });
    }
    eligible.sort((a, b) => (b.scoring.score - a.scoring.score)
        || String(a.member.combatantId).localeCompare(String(b.member.combatantId)));
    const best = eligible[0] ?? null;
    return {
        interdictor: best,
        candidates,
        gatedCount,
        poolSize: candidates.length - gatedCount
    };
}

/**
 * Pure interdiction-screen selector (issue #87): evaluate both triggers
 * over the injected situation, pick the priority threat (B > A), assign
 * one deterministic interdictor (two when the team is large enough and
 * the threats independent) and compose the serializable tactic fragment.
 * Returns `name: null` with a stable reason when no honest interception
 * exists — the integration layer then falls through to the ordinary
 * tactic branches.
 * @param {object} input
 * @param {object[]} input.members Fireteam member entries.
 * @param {object[]} input.targets Enemy target records.
 * @param {string|null} [input.leaderId] Elected leader combatant id.
 * @param {string|null} [input.character] Team character overlay.
 * @param {number|null} [input.round] Live combat round (gm-control gate).
 * @param {object|null} [input.grid] Grid `{size, distance}` conversion.
 * @param {object[]} [input.walls] Wall documents for the default probe.
 * @param {Function} [input.wallProbe] `(fromPx, toPx) => boolean` blocked.
 * @param {Array} [input.engagements] Injected melee-engagement keys.
 * @param {object|null} [input.base] Base maneuver `{name, assignments}`
 *   the interdictor assignments merge over.
 * @param {object|null} [input.config] Threshold overrides.
 * @returns {object} Serializable descriptor or null-named rejection.
 */
export function selectInterdiction({
    members = [],
    targets = [],
    leaderId = null,
    character = null,
    round = null,
    grid = null,
    walls = null,
    wallProbe = null,
    engagements = null,
    base = null,
    config = null
} = {}) {
    const cfg = resolveInterdictionConfig(config);
    const probe = _resolveWallProbe(wallProbe, walls);
    const normalizedTargets = (targets ?? []).map(_normalizeTarget).filter(Boolean)
        .sort((a, b) => String(a.tokenUuid ?? a.tokenId)
            .localeCompare(String(b.tokenUuid ?? b.tokenId)));
    const normalizedMembers = (members ?? []).map(member => _normalizeMember(member, round))
        .filter(Boolean)
        .sort((a, b) => String(a.combatantId).localeCompare(String(b.combatantId)));
    const input2 = { grid, cfg, engagements };
    const breakdown = {
        baseTactic: typeof base?.name === "string" ? base.name : null,
        interdiction: {
            trigger: null,
            targetId: null,
            tokenUuid: null,
            confidence: null,
            candidates: [],
            interdictors: [],
            interdictorCandidates: [],
            rejected: null,
            secondInterdictor: false,
            skipped: [],
            thresholds: {
                confidenceMin: cfg.confidenceMin,
                minRangedEV: cfg.minRangedEV,
                chargerConfidenceMin: cfg.chargerConfidenceMin,
                survivalThreshold: survivalThresholdOf(character, cfg),
                character: character ?? "default"
            }
        }
    };

    /**
     * Compose the null-named rejection descriptor.
     * @param {string} reason Stable rejection reason.
     * @returns {object}
     */
    function reject(reason) {
        breakdown.interdiction.rejected = reason;
        return {
            name: null,
            reason,
            assignments: {},
            objective: null,
            excludedTargets: [],
            allowFlank: false,
            regroup: false,
            maxDetachedPhases: cfg.maxDetachedPhases,
            breakdown
        };
    }

    const eligibleMembers = normalizedMembers
        .filter(member => member.enabled && !member.defeated);
    if (eligibleMembers.length < 2) {
        return reject(INTERDICT_REJECTIONS.insufficientMembers);
    }

    const records = _evaluateTargets(normalizedTargets, normalizedMembers, input2);
    breakdown.interdiction.candidates = records.map(record => ({
        targetId: record.targetId,
        tokenUuid: record.tokenUuid,
        trigger: record.triggerA && record.triggerB ? "both"
            : record.triggerA ? "A"
                : record.triggerB ? "B" : null,
        confidence: record.confidence,
        inverseConfidence: record.inverseConfidence,
        rangedEV: record.rangedEV,
        meleeEV: record.meleeEV,
        chargeRate: record.chargeRate,
        chargeReach: record.chargeReach ?? null,
        threatenedCount: record.threatenedCount,
        threatened: record.threatened,
        rejected: record.rejected
    }));
    const queue = _threatQueue(records);
    if (!queue.length) {
        return reject(INTERDICT_REJECTIONS.noTarget);
    }

    /**
     * Compose the full assignment/objective/breakdown block of one
     * interdiction threat.
     * @param {object} entry Threat queue entry.
     * @param {object} pick `_pickInterdictor` result.
     * @returns {object}
     */
    function resolveThreat(entry, pick) {
        const member = pick.interdictor.member;
        const protectee = _protecteeOf(entry, normalizedMembers, normalizedTargets,
            member.combatantId, input2);
        const screen = screenPointOf({
            enemy: entry.record.target,
            protect: protectee?.position ?? null,
            interdictor: member.position,
            fullMove: member.profile.fullMove,
            grid,
            cfg
        });
        const screenFailed = !screen.point;
        const chargeExpected = pick.interdictor.chargeExpected;
        const objective = _objectiveOf({
            entry,
            interdictorId: member.combatantId,
            protectee,
            screen: screenFailed ? null : screen,
            chargeExpected
        });
        const score = pick.interdictor.scoring;
        return {
            objective,
            assignment: {
                task: "assault",
                role: INTERDICT_ROLE,
                objective
            },
            detail: {
                combatantId: member.combatantId,
                score: _round(score.score),
                chargeExpected,
                rtd: _round(score.rtd),
                soak: _round(score.soak),
                hitEV: _round(score.hitEV),
                margin: _round(score.margin),
                threshold: score.threshold,
                protectId: protectee?.combatantId ?? null,
                screenPoint: screen.point ? { x: screen.point.x, y: screen.point.y } : null,
                screenKind: screen.kind,
                screenReachable: screen.reachable,
                screenDegenerate: screen.degenerate === true,
                // Degradation chain: illegal charge → screen point;
                // degenerate/missing screen → plain assault on the target.
                mode: chargeExpected
                    ? "charge"
                    : screen.point ? "screen" : "assault",
                degradeReason: chargeExpected
                    ? null
                    : screen.point
                        ? "charge-unavailable"
                        : (protectee ? INTERDICT_REJECTIONS.screenDegenerate
                            : INTERDICT_REJECTIONS.noProtectMember)
            }
        };
    }

    // One deterministic pass over the priority threat queue: a threat
    // without a viable interdictor is skipped honestly (the breakdown
    // names the reason) rather than blocking useful work downstream —
    // the team cannot charge what would only kill its fighter. The first
    // viable threat becomes the primary interception.
    const secondAllowed = queue.length > 1
        && character !== "rabble"
        && eligibleMembers.length >= cfg.minMembersForSecond
        && (eligibleMembers.length - 2) >= cfg.minBaseMembersAfterSecond;
    const threats = [];
    const skipped = [];
    const assignedIds = new Set();
    let anyPool = false;
    for (const entry of queue) {
        if (threats.length >= 2 || (threats.length === 1 && !secondAllowed)) break;
        const pick = _pickInterdictor(normalizedMembers, entry.record,
            { character, leaderId, cfg, grid, probe }, assignedIds);
        if (!threats.length && !breakdown.interdiction.interdictorCandidates.length) {
            breakdown.interdiction.interdictorCandidates = pick.candidates;
        }
        if (!pick.interdictor) {
            anyPool = anyPool || pick.poolSize > 0;
            skipped.push({
                targetId: entry.record.targetId,
                tokenUuid: entry.record.tokenUuid,
                trigger: entry.trigger,
                interdictorCandidates: pick.candidates,
                rejected: pick.poolSize === 0
                    ? INTERDICT_REJECTIONS.noInterdictor
                    : INTERDICT_REJECTIONS.noSurvivableInterdictor
            });
            continue;
        }
        const resolved = resolveThreat(entry, pick);
        threats.push({ entry, ...resolved });
        assignedIds.add(resolved.detail.combatantId);
    }
    breakdown.interdiction.skipped = skipped;
    if (!threats.length) {
        return reject(anyPool
            ? INTERDICT_REJECTIONS.noSurvivableInterdictor
            : INTERDICT_REJECTIONS.noInterdictor);
    }

    const primaryThreat = threats[0];
    breakdown.interdiction.secondInterdictor = threats.length > 1;

    // Compose assignments: the base maneuver (normalized object form)
    // first, interdictor entries overriding in deterministic id order.
    const assignments = {};
    const baseAssignments = base?.assignments && typeof base.assignments === "object"
        ? base.assignments : {};
    for (const id of Object.keys(baseAssignments).sort((a, b) => a.localeCompare(b))) {
        const normalized = normalizeAssignment(baseAssignments[id]);
        if (normalized) assignments[id] = normalized;
    }
    for (const threat of [...threats].sort((a, b) =>
        String(a.detail.combatantId).localeCompare(String(b.detail.combatantId)))) {
        assignments[threat.detail.combatantId] = threat.assignment;
    }

    const excludedTargets = threats.map(threat => ({
        targetId: threat.objective.targetId,
        tokenUuid: threat.objective.targetUuid,
        reason: INTERDICT_EXCLUSION_REASON
    }));

    breakdown.interdiction.trigger = primaryThreat.entry.trigger;
    breakdown.interdiction.targetId = primaryThreat.entry.record.targetId;
    breakdown.interdiction.tokenUuid = primaryThreat.entry.record.tokenUuid;
    breakdown.interdiction.confidence = primaryThreat.entry.record.confidence;
    breakdown.interdiction.interdictors = threats.map(threat => threat.detail);

    return {
        name: INTERDICTION_TACTIC,
        reason: primaryThreat.entry.trigger === "both" ? "both"
            : primaryThreat.entry.trigger === "B" ? "charger-threat" : "pure-shooter",
        assignments,
        objective: primaryThreat.objective,
        objectives: threats.map(threat => threat.objective),
        excludedTargets,
        allowFlank: false,
        regroup: false,
        maxDetachedPhases: cfg.maxDetachedPhases,
        breakdown
    };
}
