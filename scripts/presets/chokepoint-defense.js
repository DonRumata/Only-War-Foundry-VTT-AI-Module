/**
 * Chokepoint-defense tactic — «оборона сектора по подходам» (issue #91,
 * epic #84).
 *
 * Pure core contract (no planner/fireteam integration in this module):
 * - The selector is a pure, synchronous, deterministic situation
 *   assessment. It never mutates documents, never writes flags and holds
 *   no Document references in its serializable outputs — identical input
 *   yields the identical descriptor on every client.
 * - `resolveDefenseAnchor` picks the first *valid* anchor source in the
 *   priority chain: explicit `objective.type === "defend"` anchor →
 *   `context.hold` → the leader's configured hold → the first member's
 *   configured hold in stable id order → an explicit objective position
 *   (`x/y`, `targetPoint`, `lanePoint`, `regroupPoint` — a position,
 *   never an enemy `targetId`) → the centroid of living members.
 *   Sources with broken coordinates or a foreign `sceneId` are skipped;
 *   when nothing valid remains the tactic degrades with
 *   `no-defense-anchor`.
 * - Lane inference is a bounded multi-route probe: only the
 *   {@link MAX_ROUTE_THREATS} most urgent threats (lowest ETA to the
 *   anchor) receive a real `navigation.planRoute` pathfind capped by
 *   `ROUTE_BUDGET_M`/`ROUTE_MAX_VISITED`; the rest degrade to honest
 *   straight-line samples so the cap never erases whole directions.
 *   Sample weights — exact route 1.0, partial route 0.65, straight line
 *   0.35 — are halved for memory contacts: memory marks an old position,
 *   not an intention. A threat already inside the lead distance samples
 *   its own exact position ("close").
 * - Clustering is exactly the deterministic algorithm of the
 *   specification: bearings from the anchor, cut at the largest circular
 *   gap (ties resolve to the smaller start bearing), greedy angular
 *   clusters bounded by {@link LANE_SPREAD_DEG}, lateral split of
 *   parallel corridors beyond {@link LANE_SPLIT_M} and a weighted
 *   medoid representative chokepoint per lane.
 * - Sticky identity without new state: lanes inherit the id of a
 *   committed overwatch lane hint (read from the existing L1
 *   `committedPlan` flag's serialized `input.lane`) when bearing and
 *   chokepoint drift stay within {@link LANE_MATCH_DEG}/
 *   {@link LANE_MATCH_M}; every other lane gets a deterministic
 *   quantized-geometry id `lane-<fnv1a>` — no multi-round state machine,
 *   no new flags.
 * - Member→lane assignment is an exhaustive injective search over the
 *   expanded lane slots with an additive suitability score; ties resolve
 *   to the lexicographically smaller `memberId|laneId|slot` key chain.
 *   The watcher cap `max(1, memberCount - 1)` keeps at least one member
 *   off the lanes; the primary lane may carry a second overwatcher only
 *   when `memberCount > laneCount + 1`.
 * - The reserve counterattack is re-evaluated every round against live
 *   visible targets inside the kill zone only — memory never triggers
 *   it — with a vulnerability score (statuses, spent reaction, focus of
 *   fire) gated by the team's discipline character. `rabble` teams never
 *   coordinate a counterattack.
 * - Degradation is honest: the selector returns `null` with a machine
 *   reason (`no-defense-anchor`, `no-perceived-threat`, `no-overwatcher`,
 *   `defense-bypassed`, `defense-outflanked`, `objective-complete`,
 *   `insufficient-members`, `regroup-active`, `objective-mismatch`)
 *   instead of keeping a dead scheme alive.
 *
 * Integration boundaries (out of scope here): the fireteam registry,
 * `assignTasks` object-form normalization, planner overwatch lane
 * anchors, preset `laneCoverage` scoring overlays and per-member profile
 * probing are wired in the integration tasks of the epic. This module
 * only ships the pure decision core and its serializable contract.
 */
import {
    DEFAULT_PREFERRED_COHESION,
    FLAG_KEYS,
    MODULE_ID
} from "../constants.js";
import {
    DEFAULT_HOLD_RADIUS
} from "./hold.js";
import {
    _findToken,
    _tokenDoc
} from "../planner/documents.js";
import {
    VULNERABLE_STATUSES
} from "../planner/contract.js";
import {
    _isMemorySource
} from "../planner/targets.js";
import {
    _angleDiffDeg,
    _bearingTo,
    _distPx,
    _finiteOr,
    _list,
    fnv1a
} from "../planner/util.js";

/** Tactic name reported in the descriptor and used for registry gating. */
export const CHOKEPOINT_TACTIC_NAME = "chokepoint-defense";

/** Full pathfind is budgeted only for this many most urgent threats. */
export const MAX_ROUTE_THREATS = 4;

/** A* expansion bound of one threat route probe. */
export const ROUTE_MAX_VISITED = 4000;

/** Floor of the route budget in scene units (metres). */
export const ROUTE_MIN_BUDGET_M = 12;

/** Clamp bounds of the approach-lead distance before the anchor. */
export const APPROACH_LEAD_MIN_M = 3;
export const APPROACH_LEAD_MAX_M = 8;

/** Engagement horizon clamp bounds and the pad over the best team range. */
export const HORIZON_MIN_M = 18;
export const HORIZON_MAX_M = 30;
export const HORIZON_RANGE_PAD_M = 8;

/** Maximum angular spread of one lane in degrees. */
export const LANE_SPREAD_DEG = 35;

/** Lateral gap in metres after which parallel corridors split into lanes. */
export const LANE_SPLIT_M = 4;

/** Maximum lanes the defense covers; the tail degrades consciously. */
export const MAX_LANES = 3;

/** Sticky identity match tolerances against committed lane hints. */
export const LANE_MATCH_DEG = 20;
export const LANE_MATCH_M = 4;

/** Suitability bonus when a member's committed lane hint names the lane. */
export const STICKY_ASSIGNMENT_BONUS = 2;

/** ETA penalty (rounds) of memory contacts and their weight multiplier. */
export const MEMORY_ETA_PENALTY_ROUNDS = 1.5;
export const MEMORY_WEIGHT_FACTOR = 0.5;

/** Base sample weights per approach-source kind. */
export const EXACT_SAMPLE_WEIGHT = 1.0;
export const PARTIAL_SAMPLE_WEIGHT = 0.65;
export const STRAIGHT_SAMPLE_WEIGHT = 0.35;

/**
 * Live-weight floor at which memory-only lanes stop opening: a stale
 * memory never opens a new lane on its own while the team perceives a
 * sufficient live threat picture.
 */
export const MEMORY_LANE_LIVE_FLOOR = 1.0;

/** Suitability terms of the member→lane assignment. */
export const SUITABILITY_IN_RANGE = 4;
export const SUITABILITY_SUPPRESSION = 3;
export const SUITABILITY_POST_DISTANCE_MALUS = 0.25;
export const SUITABILITY_REACTION_USED_MALUS = 6;
export const SUITABILITY_NO_RANGED_MALUS = 8;

/** Kill-zone geometry: radius pad and required depth past the chokepoint. */
export const KILL_ZONE_RADIUS_PAD_M = 0.5;
export const KILL_ZONE_DEPTH_M = 1;

/**
 * Minimum half-width of a lane's kill-zone angular sector in degrees: a
 * single-sample lane has zero measured spread yet still watches a real
 * corridor direction.
 */
export const KILL_ZONE_MIN_SECTOR_HALF_DEG = 10;

/** Quantization step (metres) of the deterministic lane-id geometry hash. */
export const LANE_ID_QUANTUM_M = 2;

/** Centroid-anchor radius clamp bounds in scene units (metres). */
export const CENTROID_RADIUS_MIN_M = 6;
export const CENTROID_RADIUS_MAX_M = 10;

/**
 * Status ids making a breakthrough target vulnerable (not cumulative) —
 * the canonical planner `VULNERABLE_STATUSES` list, re-exported for the
 * tactic contract.
 */
export const COUNTERATTACK_VULNERABLE_STATUSES = Object.freeze([...VULNERABLE_STATUSES]);

/** Vulnerability points per contributing factor. */
export const VULNERABILITY_STATUS_SCORE = 2;
export const VULNERABILITY_REACTION_SCORE = 2;
export const VULNERABILITY_FOCUS_SCORE = 2;
export const FOCUS_COUNT_MIN = 2;

/**
 * Discipline gate of the coordinated counterattack by team character:
 * `disciplined`/`elite` strike at the lightest vulnerability, `shock`
 * needs proof, `rabble` never coordinates (individual plans remain) and
 * an unknown/absent character falls back to the conservative threshold.
 */
export const COUNTERATTACK_DISCIPLINE_THRESHOLDS = Object.freeze({
    disciplined: 2,
    elite: 2,
    shock: 3,
    default: 3
});

/** Machine degradation/invalidation reasons of the selector. */
export const CHOKEPOINT_DEACTIVATION_REASONS = Object.freeze([
    "insufficient-members",
    "regroup-active",
    "objective-mismatch",
    "objective-complete",
    "no-defense-anchor",
    "no-perceived-threat",
    "no-overwatcher",
    "defense-bypassed",
    "defense-outflanked"
]);

/** Assignment roles produced by the tactic. */
export const CHOKEPOINT_ROLES = Object.freeze({
    overwatchLane: "overwatch-lane",
    reserve: "reserve",
    leader: "leader"
});

/**
 * Frozen echo of every experimental constant, embedded into the
 * descriptor breakdown so a GM/preview can audit the exact tuning the
 * decision was made with.
 */
export const CHOKEPOINT_CONSTANTS = Object.freeze({
    MAX_ROUTE_THREATS,
    ROUTE_MAX_VISITED,
    ROUTE_MIN_BUDGET_M,
    APPROACH_LEAD_MIN_M,
    APPROACH_LEAD_MAX_M,
    HORIZON_MIN_M,
    HORIZON_MAX_M,
    HORIZON_RANGE_PAD_M,
    LANE_SPREAD_DEG,
    LANE_SPLIT_M,
    MAX_LANES,
    LANE_MATCH_DEG,
    LANE_MATCH_M,
    STICKY_ASSIGNMENT_BONUS,
    MEMORY_ETA_PENALTY_ROUNDS,
    MEMORY_WEIGHT_FACTOR,
    EXACT_SAMPLE_WEIGHT,
    PARTIAL_SAMPLE_WEIGHT,
    STRAIGHT_SAMPLE_WEIGHT,
    MEMORY_LANE_LIVE_FLOOR,
    SUITABILITY_IN_RANGE,
    SUITABILITY_SUPPRESSION,
    SUITABILITY_POST_DISTANCE_MALUS,
    SUITABILITY_REACTION_USED_MALUS,
    SUITABILITY_NO_RANGED_MALUS,
    KILL_ZONE_RADIUS_PAD_M,
    KILL_ZONE_DEPTH_M,
    KILL_ZONE_MIN_SECTOR_HALF_DEG,
    LANE_ID_QUANTUM_M,
    CENTROID_RADIUS_MIN_M,
    CENTROID_RADIUS_MAX_M,
    VULNERABILITY_STATUS_SCORE,
    VULNERABILITY_REACTION_SCORE,
    VULNERABILITY_FOCUS_SCORE,
    FOCUS_COUNT_MIN,
    COUNTERATTACK_DISCIPLINE_THRESHOLDS
});

/** Small floating-point slack for geometric comparisons. */
const EPSILON = 1e-9;

/** Anchor source labels in priority order. */
const ANCHOR_SOURCES = Object.freeze({
    defendObjective: "defend-objective",
    hold: "hold",
    leaderHold: "leader-hold",
    memberHold: "member-hold",
    objectivePoint: "objective-point",
    centroid: "centroid"
});

/**
 * Clamp a number into `[min, max]`.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function _clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/**
 * Round to 4 decimals for stable, readable serialized aggregates.
 * @param {number} value
 * @returns {number}
 */
function _round4(value) {
    return Math.round(value * 1e4) / 1e4;
}

/**
 * Whether a point has both finite coordinates.
 * @param {object|null} point
 * @returns {boolean}
 */
function _isPoint(point) {
    return Number.isFinite(point?.x) && Number.isFinite(point?.y);
}

/**
 * Read a module flag without mutating the document: `getFlag` first,
 * then the raw `flags` object for plain fixtures.
 * @param {object} doc
 * @param {string} key
 * @returns {*}
 */
function _readFlag(doc, key) {
    if (!doc || typeof doc !== "object") return undefined;
    if (typeof doc.getFlag === "function") {
        try {
            const value = doc.getFlag(MODULE_ID, key);
            if (value !== undefined) return value;
        } catch(err) {
            // Fall through to the raw flags object.
        }
    }
    return doc.flags?.[MODULE_ID]?.[key];
}

/**
 * Normalized grid info of the defense scene.
 * @param {object|null} scene
 * @returns {{size: number, distance: number}}
 */
function _gridOf(scene) {
    const grid = scene?.grid ?? {};
    return {
        size: Number.isFinite(grid.size) && grid.size > 0 ? grid.size : 100,
        distance: Number.isFinite(grid.distance) && grid.distance > 0 ? grid.distance : 1
    };
}

/**
 * Convert a pixel distance to scene units under the given grid.
 * @param {number} px Distance in pixels.
 * @param {{size: number, distance: number}} grid
 * @returns {number}
 */
function _pxToMeters(px, grid) {
    const per = grid.size / grid.distance;
    return per > 0 ? px / per : px;
}

/**
 * Convert scene units to pixels under the given grid.
 * @param {number} meters
 * @param {{size: number, distance: number}} grid
 * @returns {number}
 */
function _metersToPx(meters, grid) {
    return meters * (grid.size / grid.distance);
}

/**
 * Distance between two pixel points in scene units (Infinity when
 * either point is incomplete).
 * @param {object|null} a
 * @param {object|null} b
 * @param {{size: number, distance: number}} grid
 * @returns {number}
 */
function _distM(a, b, grid) {
    const px = _distPx(a, b);
    if (!Number.isFinite(px)) return Number.POSITIVE_INFINITY;
    return _pxToMeters(px, grid);
}

/**
 * Whether an anchor candidate is usable on the active scene: finite
 * coordinates and no foreign `sceneId`. A missing scene reference on
 * either side cannot disprove the match.
 * @param {object|null} raw
 * @param {string|null} sceneId
 * @returns {boolean}
 */
function _anchorSceneValid(raw, sceneId) {
    if (!_isPoint(raw)) return false;
    if (!raw.sceneId || !sceneId) return true;
    return raw.sceneId === sceneId;
}

/**
 * Positive finite radius of a hold-like config, falling back to the hold
 * preset default.
 * @param {object|null} cfg
 * @returns {number}
 */
function _radiusOf(cfg) {
    for (const value of [cfg?.radiusMeters, cfg?.radius]) {
        if (Number.isFinite(value) && value > 0) return value;
    }
    return DEFAULT_HOLD_RADIUS;
}

/**
 * Normalize a validated anchor candidate into the serialized shape.
 * @param {object} raw `{x, y, elevation?, sceneId?}`.
 * @param {string|null} sceneId Active scene id.
 * @param {number} radius Radius in scene units.
 * @param {string} source Anchor source label.
 * @returns {object}
 */
function _anchorRecord(raw, sceneId, radius, source) {
    return {
        x: raw.x,
        y: raw.y,
        elevation: _finiteOr(raw.elevation, 0),
        sceneId: raw.sceneId ?? sceneId ?? null,
        radiusMeters: radius,
        source
    };
}

/**
 * Configured hold zone of one fireteam member, mirroring the hold
 * preset's resolution chain without duplicating its evaluator: the actor
 * `config.hold` first, then the token `override.hold`, then the
 * combatant `override.hold` (shallow merge — the more specific layer
 * wins); each layer may also nest the options under `options.hold`.
 * @param {object} member Fireteam member entry.
 * @returns {object|null} Merged hold config or null.
 */
function _memberHoldConfig(member) {
    const combatant = member?.combatant;
    if (!combatant) return null;
    const token = _tokenDoc(combatant.token) ?? _tokenDoc(member?.token);
    const actor = combatant.actor ?? token?.actor ?? null;
    const layers = [
        _readFlag(actor, FLAG_KEYS.actorConfig),
        _readFlag(token, FLAG_KEYS.override),
        _readFlag(combatant, FLAG_KEYS.override)
    ];
    const merged = {};
    for (const layer of layers) {
        const opts = layer?.hold ?? layer?.options?.hold;
        if (opts && typeof opts === "object") Object.assign(merged, opts);
    }
    return Object.keys(merged).length ? merged : null;
}

/**
 * Coordinate holder of a hold-like config: the nested `anchor` first,
 * then the config itself when it carries direct coordinates.
 * @param {object|null} cfg
 * @returns {object|null}
 */
function _holdAnchorPoint(cfg) {
    if (!cfg || typeof cfg !== "object") return null;
    if (_isPoint(cfg.anchor)) return cfg.anchor;
    if (_isPoint(cfg)) return cfg;
    return null;
}

/**
 * Resolve the defense anchor — the first valid source of the priority
 * chain. Never quantized to the grid: determinism comes from the input
 * positions and the stable ordering, not from snapping.
 * @param {object} input
 * @param {object[]} [input.members] Fireteam member entries.
 * @param {string|number|null} [input.leaderId] Elected/flagged leader id.
 * @param {object|null} [input.objective] Shared objective.
 * @param {object} [input.context] Planning context (`hold`, `objective`,
 *   `scene`, `preferredCohesion`).
 * @param {object|null} [input.scene] Active scene.
 * @param {number} [input.preferredCohesion] Cohesion hint for the
 *   centroid radius.
 * @returns {object|null} `{x, y, elevation, sceneId, radiusMeters,
 *   source}` or null when no valid source exists.
 */
export function resolveDefenseAnchor({
    members = [],
    leaderId = null,
    objective = null,
    context = {},
    scene = null,
    preferredCohesion = null
} = {}) {
    const planningScene = scene ?? context.scene ?? context.combat?.scene ?? null;
    const sceneId = planningScene?.id ?? context.sceneId ?? null;
    const cohesion = Number.isFinite(preferredCohesion) && preferredCohesion > 0
        ? preferredCohesion
        : (Number.isFinite(context.preferredCohesion) && context.preferredCohesion > 0
            ? context.preferredCohesion : null);
    const obj = objective ?? context.objective ?? null;

    // 1. Explicit defense objective with a finite anchor.
    if (obj?.type === "defend" && _anchorSceneValid(obj.anchor, sceneId)) {
        return _anchorRecord(obj.anchor, sceneId,
            _radiusOf({ radiusMeters: obj.anchor.radiusMeters ?? obj.radiusMeters }),
            ANCHOR_SOURCES.defendObjective);
    }

    // 2. Explicit hold zone of the planning context.
    const contextHold = context.hold && typeof context.hold === "object" ? context.hold : null;
    const contextHoldPoint = _holdAnchorPoint(contextHold);
    if (_anchorSceneValid(contextHoldPoint, sceneId)) {
        return _anchorRecord(contextHoldPoint, sceneId,
            _radiusOf(contextHold), ANCHOR_SOURCES.hold);
    }

    // 3./4. Configured hold of the leader, then of the first member in
    // stable id order.
    const sorted = [...(members ?? [])].sort((a, b) =>
        String(a?.combatantId).localeCompare(String(b?.combatantId)));
    const leader = sorted.find(member => member
        && (member.combatantId === leaderId
            || (Array.isArray(member.ids) && member.ids.includes(leaderId))));
    const ordered = leader ? [leader, ...sorted.filter(member => member !== leader)] : sorted;
    for (const [index, member] of ordered.entries()) {
        if (!member) continue;
        const cfg = _memberHoldConfig(member);
        const point = _holdAnchorPoint(cfg);
        if (_anchorSceneValid(point, sceneId)) {
            const source = index === 0 && leader
                ? ANCHOR_SOURCES.leaderHold : ANCHOR_SOURCES.memberHold;
            return _anchorRecord(point, sceneId, _radiusOf(cfg), source);
        }
    }

    // 5. Explicit objective position — a place, never an enemy target.
    if (obj) {
        const candidates = [
            _isPoint(obj) ? obj : null,
            obj.targetPoint,
            obj.lanePoint,
            obj.regroupPoint
        ];
        for (const point of candidates) {
            if (_anchorSceneValid(point, sceneId)) {
                return _anchorRecord(point, sceneId,
                    _radiusOf({ radiusMeters: obj.radiusMeters }),
                    ANCHOR_SOURCES.objectivePoint);
            }
        }
    }

    // 6. Centroid of the living members with positions.
    const positions = sorted
        .filter(member => member && member.defeated !== true && member.enabled !== false)
        .map(member => member.position)
        .filter(_isPoint);
    if (positions.length) {
        const cx = positions.reduce((sum, pos) => sum + pos.x, 0) / positions.length;
        const cy = positions.reduce((sum, pos) => sum + pos.y, 0) / positions.length;
        const radius = _clamp(_finiteOr(cohesion, DEFAULT_PREFERRED_COHESION) + 1,
            CENTROID_RADIUS_MIN_M, CENTROID_RADIUS_MAX_M);
        return _anchorRecord({ x: cx, y: cy, elevation: 0 }, sceneId, radius,
            ANCHOR_SOURCES.centroid);
    }
    return null;
}

/**
 * Best-effort member profile derivation from the member entry alone —
 * the convenience fallback when the fireteam did not probe normalized
 * actions/perception. Weapon items give the ranged reach; a positive
 * semi/full rate of fire marks suppression capability; the combatant
 * `reactionUsed` flag marks the spent reaction (a record without
 * `round` counts as spent, a past round's record does not). The
 * authoritative profile is the read-only DTO the fireteam assembles —
 * pass `memberProfiles` explicitly whenever available.
 * @param {object} member Fireteam member entry.
 * @param {object} [context]
 * @param {number|null} [context.round] Current combat round.
 * @returns {object} `{bestRangeM, suppressionCapable, suppressionRangeM,
 *   meleeOnly, reactionUsed, visibleTargetIds}`.
 */
export function buildMemberProfile(member, context = {}) {
    const combatant = member?.combatant;
    const token = _tokenDoc(combatant?.token) ?? _tokenDoc(member?.token);
    const actor = combatant?.actor ?? token?.actor ?? null;
    let bestRangeM = 0;
    let suppressionRangeM = 0;
    for (const item of _list(actor?.items)) {
        if (item?.type !== "weapon") continue;
        const cls = String(item.system?.class ?? "").toLowerCase();
        if (cls === "melee") continue;
        const range = _finiteOr(item.system?.range, 0);
        if (!(range > 0)) continue;
        bestRangeM = Math.max(bestRangeM, range);
        const rof = item.system?.rateOfFire ?? item.system?.rof ?? null;
        const auto = _finiteOr(rof?.full ?? rof?.fullAuto, 0) > 0
            || _finiteOr(rof?.burst ?? rof?.semi ?? rof?.semiAuto, 0) > 0;
        if (auto) suppressionRangeM = Math.max(suppressionRangeM, range);
    }
    const record = _readFlag(combatant, FLAG_KEYS.reactionUsed);
    const round = _finiteOr(context.round, null);
    const reactionUsed = Boolean(record && typeof record === "object"
        && (!Number.isFinite(record.round) || round === null || record.round >= round));
    return {
        bestRangeM,
        suppressionCapable: suppressionRangeM > 0,
        suppressionRangeM,
        meleeOnly: bestRangeM <= 0,
        reactionUsed,
        visibleTargetIds: null
    };
}

/**
 * Normalize the raw threat pool — live targets plus merged team memory —
 * into deterministic defense threat records. Hidden contacts drop out;
 * memory duplicates of live tokens collapse (the live entry wins);
 * everything is measured against the anchor and sorted by ETA with the
 * memory penalty, then by stable id.
 * @param {object} input
 * @param {object[]} [input.targets] Normalized shared target list.
 * @param {object[]} [input.teamContacts] Merged team memory contacts.
 * @param {object} input.anchor Defense anchor (pixels).
 * @param {{size: number, distance: number}} input.grid Normalized grid.
 * @returns {object[]} Sorted threat records.
 */
export function collectDefenseThreats({ targets = [], teamContacts = [], anchor, grid } = {}) {
    const groups = new Map();
    const push = (raw, memory) => {
        if (!raw || !_isPoint(raw)) return;
        const tokenId = raw.tokenId ?? (typeof raw.tokenUuid === "string"
            ? raw.tokenUuid.split(".").pop() : null);
        const tokenUuid = typeof raw.tokenUuid === "string" && raw.tokenUuid
            ? raw.tokenUuid : (tokenId ? `Scene.scene.Token.${tokenId}` : null);
        const key = tokenUuid ?? tokenId;
        if (!key) return;
        const memorySource = memory || _isMemorySource(raw.source) || raw.memory === true;
        const entry = {
            tokenId: tokenId ?? null,
            tokenUuid,
            x: raw.x,
            y: raw.y,
            elevation: _finiteOr(raw.elevation, 0),
            memory: memorySource,
            hidden: raw.hidden === true,
            canAttack: raw.canAttack !== false,
            statuses: Array.isArray(raw.statuses) ? raw.statuses.map(String) : [],
            reactionUsed: raw.reactionUsed === true,
            halfMove: _finiteOr(raw.halfMove, null),
            source: raw.source ?? (memorySource ? "team-contact" : "visible"),
            lastSeenRound: _finiteOr(raw.lastSeenRound, null),
            tokenDoc: raw.tokenDoc ?? raw.token ?? null
        };
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(entry);
    };
    for (const raw of targets ?? []) push(raw, false);
    for (const raw of teamContacts ?? []) push(raw, true);

    const threats = [];
    for (const entries of groups.values()) {
        entries.sort((a, b) => (Number(a.memory) - Number(b.memory))
            || (Number(b.canAttack) - Number(a.canAttack))
            || String(a.tokenUuid).localeCompare(String(b.tokenUuid)));
        const threat = entries[0];
        if (threat.hidden) continue;
        const distanceM = _distM(threat, anchor, grid);
        if (!Number.isFinite(distanceM)) continue;
        const halfMove = Number.isFinite(threat.halfMove) && threat.halfMove > 0
            ? threat.halfMove : 3;
        threats.push({
            ...threat,
            distanceM,
            etaRounds: (distanceM / Math.max(halfMove, 3))
                + (threat.memory ? MEMORY_ETA_PENALTY_ROUNDS : 0)
        });
    }
    return threats.sort((a, b) => (a.etaRounds - b.etaRounds)
        || String(a.tokenUuid).localeCompare(String(b.tokenUuid)));
}

/**
 * Walk a route back from its endpoint by `leadPx` pixels, interpolating
 * inside the crossing segment. Returns the first waypoint when the lead
 * exceeds the whole path length.
 * @param {object[]} waypoints Pixel waypoints of the route.
 * @param {number} leadPx Lead distance in pixels.
 * @returns {{x: number, y: number}}
 */
function _pointBeforeEnd(waypoints, leadPx) {
    const first = waypoints[0];
    let total = 0;
    for (let index = 1; index < waypoints.length; index++) {
        total += _distPx(waypoints[index - 1], waypoints[index]);
    }
    if (!(total > 0) || leadPx >= total) return { x: first.x, y: first.y };
    const target = total - leadPx;
    let walked = 0;
    for (let index = 1; index < waypoints.length; index++) {
        const a = waypoints[index - 1];
        const b = waypoints[index];
        const segment = _distPx(a, b);
        if (walked + segment + EPSILON >= target && segment > 0) {
            const t = (target - walked) / segment;
            return {
                x: a.x + ((b.x - a.x) * t),
                y: a.y + ((b.y - a.y) * t)
            };
        }
        walked += segment;
    }
    const last = waypoints[waypoints.length - 1];
    return { x: last.x, y: last.y };
}

/**
 * Straight-line approach sample: the point on the threat→anchor ray at
 * the lead distance before the anchor.
 * @param {object} threat Threat record (pixels).
 * @param {object} anchor Defense anchor (pixels).
 * @param {number} leadPx Lead distance in pixels.
 * @returns {{x: number, y: number}}
 */
function _straightApproachPoint(threat, anchor, leadPx) {
    const dx = threat.x - anchor.x;
    const dy = threat.y - anchor.y;
    const dist = Math.hypot(dx, dy);
    if (!(dist > 0)) return { x: anchor.x, y: anchor.y };
    return {
        x: anchor.x + ((dx / dist) * leadPx),
        y: anchor.y + ((dy / dist) * leadPx)
    };
}

/**
 * Build the approach sample of one threat: a bounded pathfind for the
 * most urgent ones, the honest straight-line fallback otherwise. The
 * sample weight reflects the route fidelity and is halved for memory
 * contacts.
 * @param {object} threat Threat record from {@link collectDefenseThreats}.
 * @param {object} input
 * @param {object} input.anchor Defense anchor (pixels).
 * @param {{size: number, distance: number}} input.grid Normalized grid.
 * @param {number} input.leadM Approach-lead distance in scene units.
 * @param {number} input.routeBudgetM Route budget in scene units.
 * @param {boolean} input.routeAllowed Whether a pathfind probe is
 *   budgeted for this threat.
 * @param {object|null} input.navigation Navigation service.
 * @param {object|null} input.combat Active combat (token lookup).
 * @param {object|null} input.scene Active scene (token lookup).
 * @returns {object} Sample `{x, y, kind, weight, liveWeight, memory,
 *   etaRounds, tokenId, tokenUuid}`.
 */
export function sampleThreatApproach(threat, {
    anchor,
    grid,
    leadM,
    routeBudgetM,
    routeAllowed,
    navigation = null,
    combat = null,
    scene = null
} = {}) {
    const leadPx = _metersToPx(leadM, grid);
    let kind = "straight";
    let point = null;
    if (threat.distanceM <= leadM + EPSILON) {
        // Already at the doorstep: the current position is the exact
        // approach marker — no routing needed or meaningful.
        kind = "close";
        point = { x: threat.x, y: threat.y };
    } else {
        let route = null;
        const doc = threat.tokenDoc ?? _findToken(threat.tokenId, { combat, scene });
        if (routeAllowed && doc && typeof navigation?.planRoute === "function") {
            try {
                route = navigation.planRoute(doc, { x: anchor.x, y: anchor.y }, routeBudgetM,
                    { maxVisited: ROUTE_MAX_VISITED });
            } catch(err) {
                route = null;
            }
        }
        const waypoints = (route?.waypoints ?? route?.path ?? [])
            .filter(p => _isPoint(p));
        if (route?.exact === true && waypoints.length >= 2) {
            kind = "exact";
            point = _pointBeforeEnd(waypoints, leadPx);
        } else if (waypoints.length >= 2) {
            // A truncated route proves the first leg but not the entry
            // into the defense zone — the endpoint stands with reduced
            // weight.
            kind = "partial";
            const last = waypoints[waypoints.length - 1];
            point = { x: last.x, y: last.y };
        } else {
            kind = "straight";
            point = _straightApproachPoint(threat, anchor, leadPx);
        }
    }
    const base = kind === "exact" || kind === "close" ? EXACT_SAMPLE_WEIGHT
        : kind === "partial" ? PARTIAL_SAMPLE_WEIGHT
            : STRAIGHT_SAMPLE_WEIGHT;
    const weight = base * (threat.memory ? MEMORY_WEIGHT_FACTOR : 1);
    return {
        x: point.x,
        y: point.y,
        kind,
        weight,
        liveWeight: threat.memory ? 0 : weight,
        memory: threat.memory,
        etaRounds: threat.etaRounds,
        tokenId: threat.tokenId ?? null,
        tokenUuid: threat.tokenUuid ?? null
    };
}

/**
 * Assemble one lane record from its angular/lateral sample group:
 * weighted medoid chokepoint, aggregated weight/ETA/width/quality and
 * the source breakdown.
 * @param {object[]} group Samples of one lane.
 * @returns {object} Lane record without identity.
 */
function _laneRecord(group) {
    // Weighted medoid: minimize the normalized angular+lateral distance
    // to every other sample; ties resolve to the heavier sample, then
    // the smaller tokenUuid.
    let medoid = null;
    let medoidCost = Number.POSITIVE_INFINITY;
    for (const candidate of group) {
        let cost = 0;
        for (const other of group) {
            if (other === candidate) continue;
            const angular = Math.abs(candidate.unwrapped - other.unwrapped) / LANE_SPREAD_DEG;
            const lateral = Math.abs(candidate.lateralM - other.lateralM) / LANE_SPLIT_M;
            cost += other.weight * (angular + lateral);
        }
        const better = cost < medoidCost - EPSILON
            || (Math.abs(cost - medoidCost) <= EPSILON && medoid
                && (candidate.weight > medoid.weight + EPSILON
                    || (Math.abs(candidate.weight - medoid.weight) <= EPSILON
                        && String(candidate.tokenUuid).localeCompare(String(medoid.tokenUuid)) < 0)));
        if (!medoid || better) {
            medoid = candidate;
            medoidCost = cost;
        }
    }
    const bearings = group.map(sample => sample.unwrapped);
    const laterals = group.map(sample => sample.lateralM);
    const threatWeight = group.reduce((sum, sample) => sum + sample.weight, 0);
    // The breakdown mirrors the spec contract: exact-knowledge samples
    // (full routes and doorstep positions alike) count as `route`,
    // `memory` is a cross-cutting flag on any fidelity kind.
    const breakdown = { route: 0, partial: 0, straight: 0, memory: 0 };
    for (const sample of group) {
        if (sample.kind === "exact" || sample.kind === "close") breakdown.route += 1;
        else if (sample.kind === "partial") breakdown.partial += 1;
        else breakdown.straight += 1;
        if (sample.memory) breakdown.memory += 1;
    }
    const threatIds = [...new Set(group.map(sample => sample.tokenUuid ?? sample.tokenId))]
        .filter(Boolean).sort((a, b) => String(a).localeCompare(String(b)));
    const bearingDeg = (((medoid.bearing % 360) + 360) % 360);
    return {
        bearingDeg: _round4(bearingDeg),
        widthDeg: _round4(Math.max(...bearings) - Math.min(...bearings)),
        widthMeters: _round4(Math.max(...laterals) - Math.min(...laterals)),
        chokepoint: { x: medoid.x, y: medoid.y },
        threatIds,
        threatWeight: _round4(threatWeight),
        liveWeight: _round4(group.reduce((sum, sample) => sum + sample.liveWeight, 0)),
        etaRounds: _round4(Math.min(...group.map(sample => sample.etaRounds))),
        quality: _round4(threatWeight / Math.max(1, group.length)),
        sourceBreakdown: breakdown
    };
}

/**
 * Deterministic lane clustering of the approach samples: cut the circle
 * of bearings at the largest gap, greedy angular clustering bounded by
 * {@link LANE_SPREAD_DEG}, lateral corridor split beyond
 * {@link LANE_SPLIT_M}, weighted medoid representative. Pure geometry —
 * lane ids are assigned separately by {@link assignLaneIdentities}.
 * @param {object[]} samples Approach samples of
 *   {@link sampleThreatApproach}.
 * @param {object} input
 * @param {object} input.anchor Defense anchor (pixels).
 * @param {{size: number, distance: number}} input.grid Normalized grid.
 * @returns {object[]} Lane records in clustering order.
 */
export function clusterApproachLanes(samples, { anchor, grid } = {}) {
    const keyed = (samples ?? []).filter(sample => _isPoint(sample)).map(sample => ({
        ...sample,
        bearing: _finiteOr(_bearingTo(anchor, sample), 0)
    }));
    if (!keyed.length) return [];
    keyed.sort((a, b) => (a.bearing - b.bearing)
        || String(a.tokenUuid).localeCompare(String(b.tokenUuid)));

    // Cut the bearing circle at the largest gap; ties resolve to the
    // gap with the smaller start bearing — the scan evaluates internal
    // gaps in ascending bearing order with a strict-greater comparison
    // and the wrap gap (the largest possible start bearing) last, so
    // the earliest maximum always wins. The wrap gap closes the circle
    // back to the first bearing so the total always sums to 360.
    let gapIndex = -1;
    let gapSize = -1;
    for (let index = 0; index < keyed.length - 1; index++) {
        const gap = keyed[index + 1].bearing - keyed[index].bearing;
        if (gap > gapSize + EPSILON) {
            gapSize = gap;
            gapIndex = index;
        }
    }
    const wrapGap = 360 - (keyed[keyed.length - 1].bearing - keyed[0].bearing);
    if (wrapGap > gapSize + EPSILON) {
        gapIndex = keyed.length - 1;
    }
    const start = (gapIndex + 1) % keyed.length;
    const rotated = [];
    for (let offset = 0; offset < keyed.length; offset++) {
        rotated.push({ ...keyed[(start + offset) % keyed.length] });
    }
    // Unwrap the rotation into a monotonically non-decreasing bearing
    // line so the 0/360 transition never splits a corridor.
    let previous = rotated[0].bearing;
    rotated[0].unwrapped = previous;
    for (let index = 1; index < rotated.length; index++) {
        let bearing = rotated[index].bearing;
        if (bearing < previous - EPSILON) bearing += 360;
        rotated[index].unwrapped = bearing;
        previous = bearing;
    }

    // Greedy angular clustering over the unwrapped line.
    const angular = [];
    let current = null;
    for (const sample of rotated) {
        if (current && sample.unwrapped - current.minBearing <= LANE_SPREAD_DEG + EPSILON) {
            current.samples.push(sample);
            current.maxBearing = sample.unwrapped;
        } else {
            current = {
                samples: [sample],
                minBearing: sample.unwrapped,
                maxBearing: sample.unwrapped
            };
            angular.push(current);
        }
    }

    // Lateral split inside each angular cluster: project on the normal
    // of the mean bearing and cut parallel corridors at wide gaps.
    const lanes = [];
    for (const cluster of angular) {
        const meanBearing = cluster.samples.reduce((sum, s) => sum + s.unwrapped, 0)
            / cluster.samples.length;
        const normalRad = ((meanBearing + 90) * Math.PI) / 180;
        const normal = { x: Math.cos(normalRad), y: Math.sin(normalRad) };
        for (const sample of cluster.samples) {
            sample.lateralM = _pxToMeters(
                ((sample.x - anchor.x) * normal.x) + ((sample.y - anchor.y) * normal.y), grid);
        }
        const lateralOrdered = [...cluster.samples].sort((a, b) => (a.lateralM - b.lateralM)
            || String(a.tokenUuid).localeCompare(String(b.tokenUuid)));
        let group = null;
        const groups = [];
        for (const sample of lateralOrdered) {
            if (group && sample.lateralM - group.maxLateral > LANE_SPLIT_M + EPSILON) {
                group = null;
            }
            if (!group) {
                group = { samples: [], maxLateral: sample.lateralM };
                groups.push(group);
            }
            group.samples.push(sample);
            group.maxLateral = sample.lateralM;
        }
        for (const laneGroup of groups) {
            lanes.push(_laneRecord(laneGroup.samples));
        }
    }
    return lanes;
}

/**
 * Soft preferred observer post of a lane: a point inside the defense
 * zone on the anchor→chokepoint ray — never the chokepoint itself and
 * never a hard destination.
 * @param {object} anchor Defense anchor `{x, y, radiusMeters}`.
 * @param {object} chokepoint Lane chokepoint (pixels).
 * @param {{size: number, distance: number}} grid Normalized grid.
 * @returns {{x: number, y: number}}
 */
export function lanePost(anchor, chokepoint, grid) {
    const dx = chokepoint.x - anchor.x;
    const dy = chokepoint.y - anchor.y;
    const distPx = Math.hypot(dx, dy);
    if (!(distPx > 0)) return { x: anchor.x, y: anchor.y };
    const distM = _pxToMeters(distPx, grid);
    const postM = Math.min(anchor.radiusMeters * 0.75, Math.max(0, distM - 2));
    const postPx = _metersToPx(postM, grid);
    return {
        x: anchor.x + ((dx / distPx) * postPx),
        y: anchor.y + ((dy / distPx) * postPx)
    };
}

/**
 * Quantized deterministic lane id base: the chokepoint offset from the
 * anchor quantized to {@link LANE_ID_QUANTUM_M} metres, hashed with
 * FNV-1a. Small geometry drift inside the quantum keeps the identity.
 * @param {object} anchor Defense anchor.
 * @param {object} chokepoint Lane chokepoint.
 * @param {{size: number, distance: number}} grid Normalized grid.
 * @returns {string}
 */
export function laneBaseId(anchor, chokepoint, grid) {
    const dxM = _pxToMeters(chokepoint.x - anchor.x, grid);
    const dyM = _pxToMeters(chokepoint.y - anchor.y, grid);
    const qdx = Math.round(dxM / LANE_ID_QUANTUM_M);
    const qdy = Math.round(dyM / LANE_ID_QUANTUM_M);
    return `lane-${fnv1a(`${qdx}|${qdy}`).slice(0, 4)}`;
}

/**
 * Assign lane identities without any new state: lanes matching a
 * committed overwatch lane hint within {@link LANE_MATCH_DEG}/
 * {@link LANE_MATCH_M} inherit its id (conflicts resolve by the minimal
 * normalized match score, then stable ids); every other lane takes the
 * quantized-geometry base id, collisions pick `-2`/`-3` suffixes in lane
 * sort order.
 * @param {object[]} lanes Lane records of {@link clusterApproachLanes},
 *   already sorted.
 * @param {object[]} hints `[{memberId, laneId, bearingDeg, chokepoint}]`.
 * @param {object} input
 * @param {object} input.anchor Defense anchor.
 * @param {{size: number, distance: number}} input.grid Normalized grid.
 * @returns {object[]} Lane records with `id` and `post`.
 */
export function assignLaneIdentities(lanes, hints = [], { anchor, grid } = {}) {
    const baseIds = (lanes ?? []).map(lane => laneBaseId(anchor, lane.chokepoint, grid));
    const scored = [];
    for (let laneIndex = 0; laneIndex < (lanes ?? []).length; laneIndex++) {
        const lane = lanes[laneIndex];
        for (const hint of hints ?? []) {
            if (!_isPoint(hint?.chokepoint) || typeof hint.laneId !== "string") continue;
            const bearingDiff = Number.isFinite(hint.bearingDeg)
                ? _angleDiffDeg(hint.bearingDeg, lane.bearingDeg) : 180;
            const distM = _distM(hint.chokepoint, lane.chokepoint, grid);
            if (bearingDiff <= LANE_MATCH_DEG + EPSILON && distM <= LANE_MATCH_M + EPSILON) {
                scored.push({
                    laneIndex,
                    hint,
                    score: (bearingDiff / LANE_MATCH_DEG) + (distM / LANE_MATCH_M)
                });
            }
        }
    }
    scored.sort((a, b) => (a.score - b.score)
        || String(baseIds[a.laneIndex]).localeCompare(String(baseIds[b.laneIndex]))
        || String(a.hint.laneId).localeCompare(String(b.hint.laneId))
        || String(a.hint.memberId).localeCompare(String(b.hint.memberId)));
    const matchedLane = new Map();
    const usedHint = new Set();
    for (const pair of scored) {
        if (matchedLane.has(pair.laneIndex) || usedHint.has(pair.hint.laneId)) continue;
        matchedLane.set(pair.laneIndex, pair.hint.laneId);
        usedHint.add(pair.hint.laneId);
    }
    const finalIds = new Set();
    return (lanes ?? []).map((lane, laneIndex) => {
        const preferred = matchedLane.get(laneIndex) ?? baseIds[laneIndex];
        let id = preferred;
        for (let suffix = 2; finalIds.has(id); suffix += 1) {
            id = `${preferred}-${suffix}`;
        }
        finalIds.add(id);
        return {
            ...lane,
            id,
            baseId: baseIds[laneIndex],
            post: lanePost(anchor, lane.chokepoint, grid),
            matchedHint: matchedLane.get(laneIndex) ?? null
        };
    });
}

/**
 * Extract the committed overwatch lane hints of the members — the
 * serialized `input.lane` of the first overwatch step of a valid L1
 * `committedPlan` record. Validity mirrors the commitment contract: an
 * active (non-cancelled) record inside its TTL. No new state is read or
 * written — this is the exact hint mechanism the specification allows.
 * @param {object[]} members Fireteam member entries.
 * @param {object} [input]
 * @param {number|null} [input.round] Current combat round for TTL.
 * @returns {object[]} `[{memberId, laneId, bearingDeg, chokepoint}]`.
 */
export function committedLaneHints(members, { round = null } = {}) {
    const hints = [];
    const sorted = [...(members ?? [])].sort((a, b) =>
        String(a?.combatantId).localeCompare(String(b?.combatantId)));
    for (const member of sorted) {
        if (!member?.combatantId) continue;
        const record = _readFlag(member.combatant, FLAG_KEYS.committedPlan);
        if (!record || typeof record !== "object") continue;
        if (record.status === "cancelled") continue;
        if (round !== null && Number.isFinite(record.createdRound)
            && Number.isFinite(record.ttl) && record.ttl > 0
            && round - record.createdRound >= record.ttl) {
            continue;
        }
        const steps = Array.isArray(record.steps) ? record.steps : [];
        for (const step of steps) {
            const lane = step?.input?.lane;
            if (step?.type !== "overwatch" || !lane || typeof lane !== "object") continue;
            if (typeof lane.id !== "string" || !_isPoint(lane.chokepoint)) continue;
            hints.push({
                memberId: member.combatantId,
                laneId: lane.id,
                bearingDeg: _finiteOr(lane.bearingDeg, null),
                chokepoint: { x: lane.chokepoint.x, y: lane.chokepoint.y }
            });
            break;
        }
    }
    return hints;
}

/**
 * Suitability of one member for one lane: range coverage, suppression
 * capability, sticky hint, post proximity, reaction state and the
 * ranged-means penalty. Pure arithmetic over the read-only profile DTO.
 * @param {object} member Fireteam member entry.
 * @param {object} lane Lane record with `chokepoint`/`post`.
 * @param {object} profile Member profile of {@link buildMemberProfile}.
 * @param {object} input
 * @param {{size: number, distance: number}} input.grid Normalized grid.
 * @param {Set<string>} [input.hintedLaneIds] Lane ids the member's own
 *   committed hint names.
 * @returns {number} Suitability score.
 */
export function laneSuitability(member, lane, profile, { grid, hintedLaneIds = null } = {}) {
    let score = 0;
    const position = member?.position;
    const chokeDist = _distM(position, lane.chokepoint, grid);
    const bestRange = _finiteOr(profile?.bestRangeM, 0);
    const suppressionRange = _finiteOr(profile?.suppressionRangeM, 0);
    if (bestRange > 0 && chokeDist <= bestRange + EPSILON) score += SUITABILITY_IN_RANGE;
    if (profile?.suppressionCapable === true && suppressionRange > 0
        && chokeDist <= suppressionRange + EPSILON) {
        score += SUITABILITY_SUPPRESSION;
    }
    if (hintedLaneIds?.has?.(lane.id)) score += STICKY_ASSIGNMENT_BONUS;
    const postDist = _distM(position, lane.post, grid);
    if (Number.isFinite(postDist)) score -= SUITABILITY_POST_DISTANCE_MALUS * postDist;
    if (profile?.reactionUsed === true) score -= SUITABILITY_REACTION_USED_MALUS;
    const noRangedMeans = !(bestRange > 0) && profile?.suppressionCapable !== true;
    if (noRangedMeans || profile?.meleeOnly === true) score -= SUITABILITY_NO_RANGED_MALUS;
    return score;
}

/**
 * Injective member→lane assignment: exhaustive search over the expanded
 * lane slots maximizing total suitability. Slots — one per lane, the
 * primary lane duplicated only when `memberCount > laneCount + 1`; the
 * watcher cap `max(1, memberCount - 1)` keeps at least one member off
 * the lanes. Ties resolve to the lexicographically smaller sorted
 * `memberId|laneId|slot` key chain.
 * @param {object} input
 * @param {object[]} input.members Eligible members (living, enabled).
 * @param {object[]} input.lanes Sorted lane records with ids.
 * @param {object} input.profiles `combatantId → member profile`.
 * @param {object[]} [input.hints] Committed lane hints.
 * @param {{size: number, distance: number}} input.grid Normalized grid.
 * @returns {{assignments: Map<string, object>, uncoveredLaneIds: string[],
 *   score: number, key: string}}
 */
export function assignMembersToLanes({
    members = [],
    lanes = [],
    profiles = {},
    hints = [],
    grid
} = {}) {
    const sortedMembers = [...members].sort((a, b) =>
        String(a.combatantId).localeCompare(String(b.combatantId)));
    const memberCount = sortedMembers.length;
    const laneCount = lanes.length;
    const hintByMember = new Map();
    for (const hint of hints ?? []) {
        if (!hintByMember.has(hint.memberId)) hintByMember.set(hint.memberId, new Set());
        hintByMember.get(hint.memberId).add(hint.laneId);
    }
    const slots = lanes.map(lane => ({ lane, slot: 0 }));
    if (laneCount > 0 && memberCount > laneCount + 1) {
        slots.push({ lane: lanes[0], slot: 1 });
    }
    const watcherCap = Math.max(1, memberCount - 1);
    const assignCount = Math.min(watcherCap, slots.length, memberCount);
    const matrix = new Map();
    for (const member of sortedMembers) {
        const profile = profiles?.[member.combatantId] ?? {};
        for (const slot of slots) {
            const key = `${member.combatantId}|${slot.lane.id}|${slot.slot}`;
            matrix.set(key, laneSuitability(member, slot.lane, profile, {
                grid,
                hintedLaneIds: hintByMember.get(member.combatantId) ?? null
            }));
        }
    }

    let best = null;
    const consider = assignment => {
        let score = 0;
        const keys = [];
        for (const entry of assignment) {
            const key = `${entry.member.combatantId}|${entry.slot.lane.id}|${entry.slot.slot}`;
            score += matrix.get(key) ?? 0;
            keys.push(key);
        }
        keys.sort();
        const key = keys.join(";");
        if (!best || score > best.score + EPSILON
            || (Math.abs(score - best.score) <= EPSILON && key.localeCompare(best.key) < 0)) {
            best = { score, key, assignment: assignment.slice() };
        }
    };

    /**
     * Depth-first enumeration over the slots: skip or assign one unused
     * member, pruning branches that can no longer reach the assignment
     * count.
     * @param {number} slotIndex Current slot cursor.
     * @param {Set<string>} used Assigned member ids.
     * @param {object[]} assignment Accumulated entries.
     */
    function search(slotIndex, used, assignment) {
        if (assignment.length === assignCount) {
            consider(assignment);
            return;
        }
        if (slotIndex >= slots.length) return;
        if (assignment.length + (slots.length - slotIndex) < assignCount) return;
        search(slotIndex + 1, used, assignment);
        const slot = slots[slotIndex];
        for (const member of sortedMembers) {
            if (used.has(member.combatantId)) continue;
            used.add(member.combatantId);
            assignment.push({ member, slot });
            search(slotIndex + 1, used, assignment);
            assignment.pop();
            used.delete(member.combatantId);
        }
    }
    if (assignCount > 0 && slots.length) search(0, new Set(), []);

    const assignments = new Map();
    const coveredLanes = new Set();
    for (const entry of best?.assignment ?? []) {
        assignments.set(entry.member.combatantId, entry.slot);
        coveredLanes.add(entry.slot.lane.id);
    }
    const uncoveredLaneIds = lanes
        .filter(lane => !coveredLanes.has(lane.id))
        .map(lane => lane.id);
    return {
        assignments,
        uncoveredLaneIds,
        score: best?.score ?? 0,
        key: best?.key ?? ""
    };
}

/**
 * Whether a live target sits inside the kill zone: within the padded
 * anchor radius, or inside a lane's angular sector already at least
 * {@link KILL_ZONE_DEPTH_M} closer to the anchor than that lane's
 * chokepoint.
 * @param {object} target Threat record with `x/y` (pixels).
 * @param {object} input
 * @param {object} input.anchor Defense anchor.
 * @param {object[]} input.lanes Lane records.
 * @param {{size: number, distance: number}} input.grid Normalized grid.
 * @returns {boolean}
 */
export function insideKillZone(target, { anchor, lanes = [], grid } = {}) {
    if (!_isPoint(target)) return false;
    const distM = _distM(target, anchor, grid);
    if (distM <= anchor.radiusMeters + KILL_ZONE_RADIUS_PAD_M + EPSILON) return true;
    const bearing = _bearingTo(anchor, target);
    if (!Number.isFinite(bearing)) return false;
    for (const lane of lanes ?? []) {
        const half = Math.max(_finiteOr(lane.widthDeg, 0) / 2, KILL_ZONE_MIN_SECTOR_HALF_DEG);
        if (_angleDiffDeg(bearing, lane.bearingDeg) > half + EPSILON) continue;
        const chokeDist = _distM(lane.chokepoint, anchor, grid);
        if (distM <= chokeDist - KILL_ZONE_DEPTH_M + EPSILON) return true;
    }
    return false;
}

/**
 * Resolve the team discipline character: explicit input first, then the
 * first non-null member team character in stable id order.
 * @param {object[]} members
 * @param {object} context
 * @returns {string|null}
 */
function _characterOf(members, context = {}) {
    if (typeof context.character === "string" && context.character) return context.character;
    const sorted = [...(members ?? [])].sort((a, b) =>
        String(a?.combatantId).localeCompare(String(b?.combatantId)));
    for (const member of sorted) {
        if (typeof member?.team?.character === "string" && member.team.character) {
            return member.team.character;
        }
    }
    return null;
}

/**
 * Focus-of-fire count for a target: members whose best ranged reach
 * covers it and — when the profile carries perception data — that
 * actually see it.
 * @param {object} target Threat record.
 * @param {object[]} members Eligible members.
 * @param {object} profiles `combatantId → profile`.
 * @param {{size: number, distance: number}} grid Normalized grid.
 * @returns {number}
 */
function _focusCount(target, members, profiles, grid) {
    let count = 0;
    for (const member of members ?? []) {
        const profile = profiles?.[member.combatantId] ?? {};
        const bestRange = _finiteOr(profile.bestRangeM, 0);
        if (!(bestRange > 0)) continue;
        if (_distM(member.position, target, grid) > bestRange + EPSILON) continue;
        const visibleIds = Array.isArray(profile.visibleTargetIds)
            ? new Set(profile.visibleTargetIds.map(String)) : null;
        const visible = visibleIds
            ? [target.tokenId, target.tokenUuid, target.actorId]
                .filter(id => id !== null && id !== undefined)
                .some(id => visibleIds.has(String(id)))
            : true;
        if (visible) count += 1;
    }
    return count;
}

/**
 * Counterattack evaluation of the reserve: pick the most vulnerable
 * live visible target inside the kill zone and gate the coordinated
 * strike by the team discipline. Memory contacts never qualify; the
 * choice is re-evaluated from scratch every round.
 * @param {object} input
 * @param {object[]} input.threats Defense threat records.
 * @param {object[]} input.members Eligible members.
 * @param {object} input.profiles `combatantId → profile`.
 * @param {object} input.anchor Defense anchor.
 * @param {object[]} input.lanes Lane records.
 * @param {{size: number, distance: number}} input.grid Normalized grid.
 * @param {string|null} [input.character] Team character override.
 * @returns {object} `{active, targetId, targetTokenUuid,
 *   vulnerabilityScore, reason, character, threshold, evaluated}`.
 */
export function evaluateCounterattack({
    threats = [],
    members = [],
    profiles = {},
    anchor,
    lanes = [],
    grid,
    character = null
} = {}) {
    const resolvedCharacter = character ?? _characterOf(members, {});
    const threshold = COUNTERATTACK_DISCIPLINE_THRESHOLDS[resolvedCharacter]
        ?? COUNTERATTACK_DISCIPLINE_THRESHOLDS.default;
    const none = (reason, evaluated = 0) => ({
        active: false,
        targetId: null,
        targetTokenUuid: null,
        vulnerabilityScore: 0,
        reason,
        character: resolvedCharacter,
        threshold,
        evaluated
    });
    if (resolvedCharacter === "rabble") return none("rabble-undisciplined");
    const candidates = [];
    for (const threat of threats ?? []) {
        if (threat.memory || threat.hidden === true) continue;
        if (!insideKillZone(threat, { anchor, lanes, grid })) continue;
        const statusVulnerable = Array.isArray(threat.statuses)
            && threat.statuses.some(id => COUNTERATTACK_VULNERABLE_STATUSES.includes(id));
        let vulnerability = 0;
        if (statusVulnerable) vulnerability += VULNERABILITY_STATUS_SCORE;
        if (threat.reactionUsed === true) vulnerability += VULNERABILITY_REACTION_SCORE;
        const focus = _focusCount(threat, members, profiles, grid);
        if (focus >= FOCUS_COUNT_MIN) vulnerability += VULNERABILITY_FOCUS_SCORE;
        candidates.push({
            threat,
            vulnerability,
            focus,
            distM: _distM(threat, anchor, grid)
        });
    }
    if (!candidates.length) return none("no-kill-zone-target");
    candidates.sort((a, b) => (b.vulnerability - a.vulnerability)
        || (a.threat.etaRounds - b.threat.etaRounds)
        || (a.distM - b.distM)
        || String(a.threat.tokenUuid).localeCompare(String(b.threat.tokenUuid)));
    const best = candidates[0];
    if (best.vulnerability < threshold) {
        return none("threshold-unmet", candidates.length);
    }
    return {
        active: true,
        targetId: best.threat.tokenId ?? null,
        targetTokenUuid: best.threat.tokenUuid ?? null,
        vulnerabilityScore: best.vulnerability,
        reason: null,
        character: resolvedCharacter,
        threshold,
        evaluated: candidates.length
    };
}

/**
 * Whether the objective forbids the defensive posture: an explicit
 * non-defense objective type, or a bare enemy-target legacy objective.
 * @param {object|null} objective
 * @returns {boolean}
 */
function _isNonDefenseObjective(objective) {
    if (!objective || typeof objective !== "object") return false;
    if (typeof objective.type === "string" && objective.type) {
        return objective.type !== "defend";
    }
    return Boolean(objective.targetId);
}

/**
 * Whether an explicit defense objective externally reports completion
 * (v1 accepts the signal, it does not assess goal achievement itself).
 * @param {object|null} objective
 * @returns {boolean}
 */
function _isObjectiveComplete(objective) {
    if (!objective || typeof objective !== "object") return false;
    if (objective.type !== "defend") return false;
    return objective.complete === true || objective.completed === true;
}

/**
 * Full diagnostic evaluation of the chokepoint-defense tactic. Pure and
 * deterministic: same input — same output; no document mutation, no
 * `setFlag`, no async work. Returns the serializable descriptor plus the
 * machine reason and the audit breakdown; `descriptor` is null whenever
 * the tactic degrades.
 * @param {object} input
 * @param {object[]} [input.members] Fireteam member entries.
 * @param {string|number|null} [input.leaderId] Leader id.
 * @param {object[]|null} [input.targets] Normalized shared target list.
 * @param {object[]|null} [input.teamContacts] Merged team memory.
 * @param {object|null} [input.memberProfiles] `combatantId → profile`.
 * @param {object|null} [input.objective] Shared objective.
 * @param {object|null} [input.combat] Active combat.
 * @param {object|null} [input.scene] Active scene.
 * @param {object|null} [input.navigation] Navigation service.
 * @param {object[]} [input.laneHints] Injected sticky hints override.
 * @param {string|null} [input.character] Team character override.
 * @param {number} [input.seed] Plan seed (last-resort tie-break only).
 * @param {object} [input.context] Planning context (`hold`, `objective`,
 *   `scene`, `regroup`, `preferredCohesion`, `character`, `round`).
 * @returns {{active: boolean, reason: string|null, descriptor: object|null,
 *   breakdown: object}}
 */
export function evaluateChokepointDefense({
    members = [],
    leaderId = null,
    targets = null,
    teamContacts = null,
    memberProfiles = null,
    objective = null,
    combat = null,
    scene = null,
    navigation = null,
    laneHints = null,
    character = null,
    seed = 0,
    context = {}
} = {}) {
    const planningScene = scene ?? context.scene ?? combat?.scene ?? null;
    const grid = _gridOf(planningScene);
    const round = _finiteOr(context.round ?? combat?.round, null);
    const nav = navigation ?? context.navigation ?? null;
    const obj = objective ?? context.objective ?? null;
    const eligible = (members ?? [])
        .filter(member => member && member.combatantId
            && member.defeated !== true && member.enabled !== false)
        .sort((a, b) => String(a.combatantId).localeCompare(String(b.combatantId)));

    // Progressive diagnostics: every degradation path carries the partial
    // audit assembled so far instead of a bare reason.
    const activation = {
        memberCount: eligible.length,
        seed: _finiteOr(seed, 0)
    };
    const partial = {
        anchorSource: null,
        lanes: [],
        uncoveredLaneIds: [],
        droppedThreatIds: [],
        counterattack: null
    };
    const fail = reason => ({
        active: false,
        reason,
        descriptor: null,
        breakdown: {
            ...partial,
            activation,
            constants: CHOKEPOINT_CONSTANTS
        }
    });

    if (eligible.length < 2) return fail("insufficient-members");
    if (context.regroup === true) return fail("regroup-active");
    if (_isNonDefenseObjective(obj)) return fail("objective-mismatch");
    if (_isObjectiveComplete(obj)) return fail("objective-complete");

    const anchor = resolveDefenseAnchor({
        members: eligible,
        leaderId,
        objective: obj,
        context,
        scene: planningScene,
        preferredCohesion: context.preferredCohesion
    });
    if (!anchor) return fail("no-defense-anchor");
    partial.anchorSource = anchor.source;
    activation.anchorSource = anchor.source;

    // Read-only member profiles: injected DTOs win, the fallback derives
    // a best-effort profile from the member entry itself.
    const profiles = {};
    for (const member of eligible) {
        profiles[member.combatantId] = memberProfiles?.[member.combatantId]
            ?? context.memberProfiles?.[member.combatantId]
            ?? buildMemberProfile(member, { round });
    }

    const ranges = eligible.map(member => _finiteOr(profiles[member.combatantId]?.bestRangeM, 0));
    const bestRangedRangeM = ranges.length ? Math.max(...ranges) : 0;
    const positiveRanges = ranges.filter(range => range > 0);
    const minRangedRangeM = positiveRanges.length ? Math.min(...positiveRanges) : 0;
    const leadM = _clamp(minRangedRangeM - 1, APPROACH_LEAD_MIN_M, APPROACH_LEAD_MAX_M);
    const horizonM = _clamp(bestRangedRangeM + HORIZON_RANGE_PAD_M, HORIZON_MIN_M, HORIZON_MAX_M);
    const routeBudgetM = Math.max(ROUTE_MIN_BUDGET_M, leadM * 3);
    activation.leadM = leadM;
    activation.horizonM = horizonM;
    activation.routeBudgetM = routeBudgetM;

    const threatPool = collectDefenseThreats({
        targets: targets ?? context.targets ?? [],
        teamContacts: teamContacts ?? context.teamContacts ?? [],
        anchor,
        grid
    }).filter(threat => threat.distanceM <= horizonM + EPSILON);
    activation.threatCount = threatPool.length;
    if (!threatPool.length) return fail("no-perceived-threat");

    const overwatchCapable = eligible.some(member => {
        const profile = profiles[member.combatantId] ?? {};
        const ranged = _finiteOr(profile.bestRangeM, 0) > 0;
        return (ranged && profile.reactionUsed !== true) || profile.suppressionCapable === true;
    });
    activation.overwatchCapable = overwatchCapable;
    if (!overwatchCapable) return fail("no-overwatcher");

    // Lane inference: full pathfind only for the most urgent threats.
    const samples = threatPool.map((threat, index) => sampleThreatApproach(threat, {
        anchor,
        grid,
        leadM,
        routeBudgetM,
        routeAllowed: index < MAX_ROUTE_THREATS,
        navigation: nav,
        combat,
        scene: planningScene
    }));
    const clustered = clusterApproachLanes(samples, { anchor, grid });
    const hints = Array.isArray(laneHints)
        ? laneHints
        : committedLaneHints(eligible, { round });
    activation.laneHints = hints.map(hint => ({
        memberId: hint.memberId,
        laneId: hint.laneId
    }));

    // Stale memory never opens a lane on its own once the live picture
    // is strong enough.
    const totalLiveWeight = clustered.reduce((sum, lane) => sum + lane.liveWeight, 0);
    const memoryFloorOpen = totalLiveWeight < MEMORY_LANE_LIVE_FLOOR;
    const kept = [];
    const memoryDropped = [];
    for (const lane of clustered) {
        if (!memoryFloorOpen && lane.liveWeight <= EPSILON) memoryDropped.push(lane);
        else kept.push(lane);
    }
    activation.memoryLanesDropped = memoryDropped.length;

    // Lane ordering: weight, urgency, bearing, quantized base id — the
    // spec's deterministic chain (base id stands in for the final id,
    // which only sticky matching can override afterwards).
    const baseIdOf = lane => laneBaseId(anchor, lane.chokepoint, grid);
    kept.sort((a, b) => (b.threatWeight - a.threatWeight)
        || (a.etaRounds - b.etaRounds)
        || (a.bearingDeg - b.bearingDeg)
        || String(baseIdOf(a)).localeCompare(String(baseIdOf(b))));
    const covered = kept.slice(0, MAX_LANES);
    const tail = kept.slice(MAX_LANES);
    const droppedThreatIds = [];
    let droppedLiveWeight = 0;
    for (const lane of [...tail, ...memoryDropped]) {
        droppedLiveWeight += lane.liveWeight;
        droppedThreatIds.push(...lane.threatIds);
    }
    droppedThreatIds.sort((a, b) => String(a).localeCompare(String(b)));
    partial.droppedThreatIds = droppedThreatIds;

    const lanes = assignLaneIdentities(covered, hints, { anchor, grid });

    // Counterattack first — a proven vulnerable breakthrough keeps the
    // defense meaningful even when most enemies are already inside.
    const resolvedCharacter = character ?? context.character ?? _characterOf(eligible, context);
    const counterattack = evaluateCounterattack({
        threats: threatPool,
        members: eligible,
        profiles,
        anchor,
        lanes,
        grid,
        character: resolvedCharacter
    });
    partial.counterattack = counterattack;

    // Degradation: the majority of the live weight already bypassed the
    // zone and no legal vulnerable counterattack target exists — the
    // posture is pointless. Live weight is measured through the samples
    // (a close-range intruder weighs a full exact sample).
    const liveWeightOf = new Map();
    for (const sample of samples) {
        liveWeightOf.set(sample.tokenUuid ?? sample.tokenId, sample.liveWeight);
    }
    const weightOf = threat => liveWeightOf.get(threat.tokenUuid ?? threat.tokenId) ?? 0;
    const insideLiveWeight = threatPool
        .filter(threat => !threat.memory
            && threat.distanceM <= anchor.radiusMeters + KILL_ZONE_RADIUS_PAD_M + EPSILON)
        .reduce((sum, threat) => sum + weightOf(threat), 0);
    activation.insideLiveWeight = _round4(insideLiveWeight);
    activation.totalLiveWeight = _round4(totalLiveWeight);
    if (!counterattack.active && totalLiveWeight > EPSILON
        && insideLiveWeight * 2 > totalLiveWeight + EPSILON) {
        return fail("defense-bypassed");
    }

    // Degradation: threats spread wider than the lane budget can cover
    // without losing most of the live weight.
    if (tail.length && droppedLiveWeight * 2 > totalLiveWeight + EPSILON) {
        return fail("defense-outflanked");
    }

    const { assignments, uncoveredLaneIds, score, key } = assignMembersToLanes({
        members: eligible,
        lanes,
        profiles,
        hints,
        grid
    });
    activation.assignmentScore = _round4(score);
    activation.assignmentKey = key;

    // Object-form assignments: overwatch-lane / reserve / leader; the
    // reserve flips to `assault` with the shared target only while the
    // counterattack is active. The leader marker is not a role mutex:
    // a leader assigned to a lane keeps `leader: true` next to its
    // `overwatch-lane` role; a leader off the lanes holds the anchor as
    // the last defensive point and never joins the counterattack in v1.
    const assignmentMap = {};
    const laneById = new Map(lanes.map(lane => [lane.id, lane]));
    for (const member of eligible) {
        const slot = assignments.get(member.combatantId);
        const isLeader = member.combatantId === leaderId
            || (Array.isArray(member.ids) && member.ids.includes(leaderId));
        const leaderMark = isLeader ? { leader: true } : {};
        if (slot) {
            const lane = laneById.get(slot.lane.id) ?? slot.lane;
            assignmentMap[member.combatantId] = {
                task: "support",
                role: CHOKEPOINT_ROLES.overwatchLane,
                element: lane.id,
                ...leaderMark,
                objective: {
                    type: "defend",
                    laneId: lane.id,
                    lanePoint: { x: lane.chokepoint.x, y: lane.chokepoint.y },
                    post: { x: lane.post.x, y: lane.post.y }
                }
            };
        } else if (isLeader) {
            assignmentMap[member.combatantId] = {
                task: "support",
                role: CHOKEPOINT_ROLES.leader,
                element: "main",
                ...leaderMark,
                objective: { type: "defend" }
            };
        } else {
            assignmentMap[member.combatantId] = {
                task: counterattack.active ? "assault" : "support",
                role: CHOKEPOINT_ROLES.reserve,
                element: "main",
                objective: {
                    type: "defend",
                    ...(counterattack.active ? {
                        targetId: counterattack.targetId,
                        targetTokenUuid: counterattack.targetTokenUuid
                    } : {})
                }
            };
        }
    }

    const laneOutput = lanes.map(({ matchedHint, ...lane }) => lane);
    partial.lanes = laneOutput;
    partial.uncoveredLaneIds = uncoveredLaneIds;
    const sharedObjective = {
        type: "defend",
        anchor: {
            x: anchor.x,
            y: anchor.y,
            elevation: anchor.elevation,
            sceneId: anchor.sceneId,
            radiusMeters: anchor.radiusMeters,
            source: anchor.source
        },
        lanePoint: lanes.length
            ? { x: lanes[0].chokepoint.x, y: lanes[0].chokepoint.y }
            : null,
        lanes: laneOutput,
        counterattack: {
            active: counterattack.active,
            targetId: counterattack.targetId,
            targetTokenUuid: counterattack.targetTokenUuid,
            vulnerabilityScore: counterattack.vulnerabilityScore,
            reason: counterattack.reason
        }
    };
    const descriptor = {
        name: CHOKEPOINT_TACTIC_NAME,
        reason: `${anchor.source}-anchor-approach-lanes`,
        assignments: assignmentMap,
        allowFlank: false,
        regroup: false,
        objective: sharedObjective,
        maxDetachedPhases: 0,
        breakdown: {
            anchorSource: anchor.source,
            lanes: laneOutput,
            uncoveredLaneIds,
            droppedThreatIds,
            counterattack,
            activation,
            constants: CHOKEPOINT_CONSTANTS
        }
    };
    return {
        active: true,
        reason: null,
        descriptor,
        breakdown: descriptor.breakdown
    };
}

/**
 * Deterministic chokepoint-defense tactic selector: the fireteam-facing
 * entry point mirroring `selectSpecOpsTactic`. Returns the serializable
 * tactic descriptor, or `null` when the posture degrades — use
 * {@link evaluateChokepointDefense} where the machine reason matters.
 * @param {object} input Selector input (see {@link evaluateChokepointDefense}).
 * @returns {object|null} Tactic descriptor or null.
 */
export function selectChokepointDefense(input = {}) {
    return evaluateChokepointDefense(input).descriptor;
}

/**
 * Bind a tactic factory for tests, macros and the future registry.
 * @param {object} [config] Reserved constant overrides (experimental —
 *   v1 evaluates with the frozen constants only; the overrides are
 *   passed through for forward compatibility).
 * @returns {Function} Tactic factory `(input) => descriptor|null`.
 */
export function createChokepointDefenseTactic(config = {}) {
    return input => selectChokepointDefense({ ...input, config });
}

/**
 * Prepare the registry input for chokepoint evaluation. A concentrate-fire
 * objective inherited only as the selector fallback is an overlay target,
 * not an explicit non-defense order: it must not produce
 * `objective-mismatch` while a configured hold anchor exists. Explicit
 * caller objectives keep their full precedence and still gate the tactic.
 * @param {object} input Fireteam selector input.
 * @returns {object} Pure-core input.
 */
export function prepareChokepointInput(input = {}) {
    const context = input.context ?? {};
    const inheritedFocus = input.focusObjective
        && input.objective === input.focusObjective
        && (context.objective === null || context.objective === undefined);
    if (!inheritedFocus) return input;
    return {
        ...input,
        objective: null,
        context: { ...context, objective: null }
    };
}

/**
 * Preset-specific anchor gate. `hold` is the defensive core preset and may
 * use the honest centroid fallback; ranged-cover additionally accepts an
 * explicit positional objective, while spec-ops participates only in an
 * explicit defensive posture/anchor and never lets the centroid turn an
 * open battle into a defense scheme.
 * @param {string|null} presetId
 * @param {string|null} anchorSource
 * @returns {boolean}
 */
export function chokepointAnchorAllowed(presetId, anchorSource) {
    if (!anchorSource) return false;
    if (presetId === "hold") return true;
    const explicit = new Set([
        "defend-objective", "hold", "leader-hold", "member-hold"
    ]);
    if (presetId === "rangedCover") {
        return explicit.has(anchorSource) || anchorSource === "objective-point";
    }
    if (presetId === "specOps") return explicit.has(anchorSource);
    return false;
}

/**
 * Evaluate chokepoint-defense through the preset participation gate.
 * The returned shape mirrors {@link evaluateChokepointDefense}; a pure-core
 * activation rejected by the preset gate degrades to the stable integration
 * reason `preset-anchor-gate` with the original anchor source preserved in
 * the breakdown.
 * @param {object} input Fireteam selector input.
 * @param {object} [options]
 * @param {string} [options.presetId]
 * @returns {object} `{active, reason, descriptor, breakdown}`.
 */
export function evaluateChokepointCascade(input = {}, { presetId = "hold" } = {}) {
    const evaluation = evaluateChokepointDefense(prepareChokepointInput(input));
    if (!evaluation.active) return evaluation;
    const source = evaluation.breakdown?.anchorSource
        ?? evaluation.descriptor?.breakdown?.anchorSource ?? null;
    if (chokepointAnchorAllowed(presetId, source)) return evaluation;
    return {
        active: false,
        reason: "preset-anchor-gate",
        descriptor: null,
        breakdown: {
            ...(evaluation.breakdown ?? {}),
            anchorSource: source,
            presetId,
            selected: false,
            reason: "preset-anchor-gate"
        }
    };
}

/**
 * Hold-preset maneuver cascade (issue #91). Chokepoint-defense is the only
 * hold maneuver of the first iteration: peel-withdrawal deliberately does
 * NOT auto-activate for hold teams (issue #89 preset distribution — a hold
 * order is a stand-your-ground doctrine, withdrawal stays an explicit
 * caller tactic or the individual disengage/withdraw candidate of the
 * planner). When the defense gates do not open the cascade returns the
 * explainable `name:null` record instead of throwing or silently hiding
 * the degradation reason — assignment construction then remains the
 * ordinary default-support path.
 * @param {object} input Fireteam selector input.
 * @returns {object} Serializable tactic/cascade record.
 */
export function selectHoldTactic(input = {}) {
    const defense = evaluateChokepointCascade(input, { presetId: "hold" });
    if (defense.descriptor) return defense.descriptor;
    return {
        name: null,
        reason: defense.reason ?? "no-maneuver",
        assignments: {},
        breakdown: {
            chokepoint: {
                selected: false,
                reason: defense.reason ?? null,
                ...(defense.breakdown ?? {})
            }
        }
    };
}

/**
 * Register the hold cascade in the tactic registry. The selector occupies
 * the ordinary maneuver slot with the same default priority as the other
 * preset cascades; explicit `context.tactic` still bypasses the registry.
 * @param {object} tactics Tactic registry service.
 * @returns {object} Registry record.
 */
export function registerHoldTacticSelector(tactics) {
    if (!tactics || typeof tactics.registerTacticSelector !== "function") {
        throw new Error("[only-war-ai] Hold tactic requires a tactic registry");
    }
    return tactics.registerTacticSelector({
        presetId: "hold",
        kind: "maneuver",
        priority: 100,
        select: selectHoldTactic
    });
}
