/**
 * Pincer tactic pure core — двойной охват (issue #88, epic #84).
 *
 * This module is deliberately pure and Foundry-free. It contains the shared
 * geometry and composition rules later consumed by the spec-ops and assault
 * tactic selectors:
 *
 * - extraction of two signed (`left`/`right`) maneuver points from either
 *   flank-option candidates or bare team/objective geometry;
 * - the three-part false-envelopment test {@link routesDiverge} (route angle,
 *   trimmed non-intersection and corridor separation, with optional navigation
 *   probes);
 * - deterministic group composition for the full spec-ops variant and the
 *   loose assault variant;
 * - morale gate, degradation reasons and JSON-serializable tactic descriptor
 *   construction.
 *
 * No document, service or planner state is mutated here. All returned tactic
 * descriptors, assignments, objectives and diagnostics are plain JSON data.
 */

/** Canonical tactic id of the full spec-ops pincer. */
export const PINCER_TACTIC = "pincer";

/** Loose assault variant: two converging flanks without synchronization. */
export const PINCER_LOOSE_TACTIC = "pincer-loose";

/** Signed maneuver sides. */
export const PINCER_SIDES = Object.freeze(["left", "right"]);

/** Supported synchronization modes of the full pincer descriptor. */
export const PINCER_SYNC_MODES = Object.freeze(["elastic", "strict"]);

/** Stable degradation reason ids required by the pincer contract. */
export const PINCER_DEGRADATION_REASONS = Object.freeze({
    sideBlocked: "pincer-degraded-side-blocked",
    noDivergence: "pincer-degraded-no-divergence"
});

/** Stable pure-core refusal/fallthrough reason ids. */
export const PINCER_REASONS = Object.freeze({
    insufficientMembers: "pincer-insufficient-members",
    noAttackableTarget: "pincer-no-attackable-target",
    notSuperior: "pincer-not-superior",
    moraleGate: "pincer-morale-gate",
    enemySpread: "pincer-enemy-spread",
    noObjective: "pincer-no-objective",
    noFeasibleSide: "pincer-no-feasible-side",
    noRangedFix: "pincer-no-ranged-fix",
    compositionInfeasible: "pincer-composition-infeasible",
    ...PINCER_DEGRADATION_REASONS
});

/** Morale ranks used by the configurable pincer gate. */
export const PINCER_MORALE_RANKS = Object.freeze({
    desperate: 1,
    pressured: 2,
    confident: 3
});

/**
 * Experimental defaults from the issue #88 specification.
 *
 * `corridorSeparation`, `maxTravel` and `spread` are the no-scene fallbacks in
 * pixels. {@link resolvePincerConfig} recomputes them from grid data when a
 * scene is available: corridor `max(150, grid.size × 1.5)`, travel `12 m` in
 * pixels (fallback 1200 px) and enemy spread `max(300, 2 × preferredCohesion)`
 * after scene-unit conversion.
 */
export const PINCER_CONFIG = Object.freeze({
    minRouteAngleDeg: 60,
    flankMinAngleDegrees: 60,
    corridorSeparation: 150,
    corridorSeparationBasePx: 150,
    corridorSeparationGridMultiplier: 1.5,
    corridorSamples: 8,
    routeTrimFraction: 0.25,
    routeProbe: true,
    probeMaxVisited: 2048,
    minMembers: 4,
    maxTravel: 1200,
    maxTravelMeters: 12,
    maxTravelFallbackPx: 1200,
    spread: 300,
    enemySpread: 300,
    enemySpreadBasePx: 300,
    enemySpreadCohesionMultiplier: 2,
    preferredCohesion: 5,
    fixMinRange: 10,
    minMorale: "pressured",
    sync: "elastic",
    maxDetachedPhases: 2
});

const CONFIG_ALIASES = Object.freeze({
    pincerMinRouteAngleDeg: "minRouteAngleDeg",
    pincerFlankMinAngleDegrees: "flankMinAngleDegrees",
    pincerCorridorSeparation: "corridorSeparation",
    pincerCorridorSeparationBasePx: "corridorSeparationBasePx",
    pincerCorridorSeparationGridMultiplier: "corridorSeparationGridMultiplier",
    pincerCorridorSamples: "corridorSamples",
    pincerRouteTrimFraction: "routeTrimFraction",
    pincerRouteProbe: "routeProbe",
    pincerProbeMaxVisited: "probeMaxVisited",
    pincerMinMembers: "minMembers",
    pincerMaxTravel: "maxTravel",
    pincerMaxTravelMeters: "maxTravelMeters",
    pincerMaxTravelFallbackPx: "maxTravelFallbackPx",
    pincerEnemySpread: "spread",
    enemySpread: "spread",
    pincerEnemySpreadBasePx: "enemySpreadBasePx",
    pincerEnemySpreadCohesionMultiplier: "enemySpreadCohesionMultiplier",
    pincerPreferredCohesion: "preferredCohesion",
    pincerFixMinRange: "fixMinRange",
    pincerMinMorale: "minMorale",
    pincerSync: "sync",
    pincerMaxDetachedPhases: "maxDetachedPhases"
});

const EPSILON = 1e-9;

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
 * Round deterministic diagnostic numbers and normalize negative zero.
 * @param {*} value
 * @param {number} [digits] Decimal digits.
 * @returns {number|null}
 */
function _round(value, digits = 4) {
    if (!Number.isFinite(value)) return null;
    const factor = 10 ** digits;
    const rounded = Math.round(value * factor) / factor;
    return rounded === 0 ? 0 : rounded;
}

/**
 * Round a point for serialized descriptors.
 * @param {object|null} point
 * @returns {{x: number, y: number}|null}
 */
function _roundPoint(point) {
    return _isPoint(point)
        ? { x: _round(point.x, 2), y: _round(point.y, 2) }
        : null;
}

/**
 * Whether a point has finite x/y coordinates.
 * @param {object|null} point
 * @returns {boolean}
 */
function _isPoint(point) {
    return Number.isFinite(point?.x) && Number.isFinite(point?.y);
}

/**
 * Clone a point when valid.
 * @param {object|null} point
 * @returns {{x: number, y: number}|null}
 */
function _point(point) {
    const source = _isPoint(point) ? point
        : (_isPoint(point?.position) ? point.position : null);
    return source ? { x: source.x, y: source.y } : null;
}

/**
 * Euclidean distance between points, Infinity for incomplete input.
 * @param {object|null} a
 * @param {object|null} b
 * @returns {number}
 */
function _dist(a, b) {
    if (!_isPoint(a) || !_isPoint(b)) return Number.POSITIVE_INFINITY;
    return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Angle in degrees between two non-degenerate 2D vectors.
 * @param {{x: number, y: number}} v1
 * @param {{x: number, y: number}} v2
 * @returns {number|null}
 */
function _angleBetweenDeg(v1, v2) {
    if (!(Math.hypot(v1.x, v1.y) > 0) || !(Math.hypot(v2.x, v2.y) > 0)) return null;
    const dot = (v1.x * v2.x) + (v1.y * v2.y);
    const cross = (v1.x * v2.y) - (v1.y * v2.x);
    return (Math.atan2(Math.abs(cross), dot) * 180) / Math.PI;
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
    return p.x >= Math.min(a.x, b.x) - EPSILON && p.x <= Math.max(a.x, b.x) + EPSILON
        && p.y >= Math.min(a.y, b.y) - EPSILON && p.y <= Math.max(a.y, b.y) + EPSILON;
}

/**
 * Inclusive 2D segment intersection test, matching the spec-ops wall probe.
 * @param {{x: number, y: number}} p1
 * @param {{x: number, y: number}} p2
 * @param {{x: number, y: number}} p3
 * @param {{x: number, y: number}} p4
 * @returns {boolean}
 */
export function segmentsIntersect(p1, p2, p3, p4) {
    if (![_isPoint(p1), _isPoint(p2), _isPoint(p3), _isPoint(p4)].every(Boolean)) return false;
    const d1 = _cross(p3, p4, p1);
    const d2 = _cross(p3, p4, p2);
    const d3 = _cross(p1, p2, p3);
    const d4 = _cross(p1, p2, p4);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
        && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
        return true;
    }
    if (Math.abs(d1) <= EPSILON && _onSegment(p3, p4, p1)) return true;
    if (Math.abs(d2) <= EPSILON && _onSegment(p3, p4, p2)) return true;
    if (Math.abs(d3) <= EPSILON && _onSegment(p1, p2, p3)) return true;
    if (Math.abs(d4) <= EPSILON && _onSegment(p1, p2, p4)) return true;
    return false;
}

/**
 * Distance from a point to a segment.
 * @param {{x: number, y: number}} p
 * @param {{x: number, y: number}} a
 * @param {{x: number, y: number}} b
 * @returns {number}
 */
export function pointSegmentDistance(p, a, b) {
    if (!_isPoint(p) || !_isPoint(a) || !_isPoint(b)) return Number.POSITIVE_INFINITY;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = (dx * dx) + (dy * dy);
    if (!(lengthSquared > 0)) return _dist(p, a);
    const t = Math.max(0, Math.min(1,
        (((p.x - a.x) * dx) + ((p.y - a.y) * dy)) / lengthSquared));
    return _dist(p, { x: a.x + (t * dx), y: a.y + (t * dy) });
}

/**
 * Standard segment-segment distance: zero on intersection, otherwise the
 * minimum of the four endpoint-to-segment distances.
 * @param {{x: number, y: number}} a1
 * @param {{x: number, y: number}} a2
 * @param {{x: number, y: number}} b1
 * @param {{x: number, y: number}} b2
 * @returns {number}
 */
export function segmentDistance(a1, a2, b1, b2) {
    if (segmentsIntersect(a1, a2, b1, b2)) return 0;
    return Math.min(
        pointSegmentDistance(a1, b1, b2),
        pointSegmentDistance(a2, b1, b2),
        pointSegmentDistance(b1, a1, a2),
        pointSegmentDistance(b2, a1, a2)
    );
}

/**
 * Normalize a Foundry collection/Map/array/iterable into a plain array.
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
 * Read the first defined own property.
 * @param {object|null} object
 * @param {string[]} keys
 * @returns {*}
 */
function _firstKey(object, keys) {
    if (!object || typeof object !== "object") return undefined;
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(object, key) && object[key] !== undefined) {
            return object[key];
        }
    }
    return undefined;
}

/**
 * Read a config override, accepting the spec-ops `pincer*` aliases.
 * @param {string} key Canonical key.
 * @param {object|null} overrides Explicit overrides.
 * @param {object|null} stored Stored/secondary overrides.
 * @returns {*}
 */
function _configValue(key, overrides, stored) {
    const aliases = Object.entries(CONFIG_ALIASES)
        .filter(([, canonical]) => canonical === key)
        .map(([alias]) => alias);
    const keys = [key, ...aliases];
    for (const source of [overrides, stored]) {
        const value = _firstKey(source, keys);
        if (value !== undefined) return value;
    }
    return undefined;
}

/**
 * Resolve the planning scene from loose input/environment shapes.
 * @param {object|null} input
 * @returns {object|null}
 */
function _sceneOf(input = {}) {
    return input.scene ?? input.context?.scene ?? input.combat?.scene
        ?? input.context?.combat?.scene ?? null;
}

/**
 * Grid size/distance in a loose scene shape.
 * @param {object|null} input
 * @returns {{size: number|null, distance: number|null}}
 */
function _gridOf(input = {}) {
    const grid = input.grid ?? _sceneOf(input)?.grid ?? null;
    const size = Number.isFinite(grid?.size) && grid.size > 0 ? grid.size
        : (Number.isFinite(input.gridSize) && input.gridSize > 0 ? input.gridSize : null);
    const distance = Number.isFinite(grid?.distance) && grid.distance > 0 ? grid.distance
        : (Number.isFinite(input.gridDistance) && input.gridDistance > 0 ? input.gridDistance : null);
    return { size, distance };
}

/**
 * Preferred cohesion in scene units, with context/team awareness.
 * @param {object|null} input
 * @returns {number|null}
 */
function _preferredCohesionOf(input = {}) {
    const values = [
        input.preferredCohesion,
        input.context?.preferredCohesion,
        input.team?.preferredCohesion,
        input.context?.team?.preferredCohesion
    ];
    for (const value of values) {
        if (Number.isFinite(value) && value > 0) return value;
    }
    return null;
}

/**
 * Resolve pincer configuration. Canonical keys are unprefixed; all spec-ops
 * `pincer*` aliases are accepted. Explicit numeric thresholds are interpreted
 * as pixels because route geometry and selector travel are pixel-space.
 * @param {object|null} [overrides] Explicit planning/config overrides.
 * @param {object|null} [stored] Secondary stored overrides.
 * @param {object|null} [environment] Scene/grid/preferredCohesion input.
 * @returns {object} Plain resolved config.
 */
export function resolvePincerConfig(overrides = null, stored = null, environment = null) {
    const env = environment ?? overrides ?? {};
    const grid = _gridOf(env);
    const rawMeters = _configValue("maxTravelMeters", overrides, stored);
    const meters = Number.isFinite(rawMeters) && rawMeters > 0
        ? rawMeters : PINCER_CONFIG.maxTravelMeters;
    const rawFallbackTravel = _configValue("maxTravelFallbackPx", overrides, stored);
    const fallbackTravel = Number.isFinite(rawFallbackTravel) && rawFallbackTravel > 0
        ? rawFallbackTravel : PINCER_CONFIG.maxTravelFallbackPx;
    const rawCohesion = _configValue("preferredCohesion", overrides, stored);
    const cohesion = Number.isFinite(rawCohesion) && rawCohesion > 0
        ? rawCohesion
        : (_preferredCohesionOf(env) ?? PINCER_CONFIG.preferredCohesion);
    const rawSpreadBase = _configValue("enemySpreadBasePx", overrides, stored);
    const spreadBase = Number.isFinite(rawSpreadBase) && rawSpreadBase >= 0
        ? rawSpreadBase : PINCER_CONFIG.enemySpreadBasePx;
    const rawSpreadMultiplier = _configValue("enemySpreadCohesionMultiplier", overrides, stored);
    const spreadMultiplier = Number.isFinite(rawSpreadMultiplier) && rawSpreadMultiplier >= 0
        ? rawSpreadMultiplier : PINCER_CONFIG.enemySpreadCohesionMultiplier;
    const cohesionPx = grid.size && grid.distance
        ? cohesion * (grid.size / grid.distance)
        : cohesion;
    const dynamicSpread = Math.max(spreadBase, spreadMultiplier * cohesionPx);
    const rawCorridorBase = _configValue("corridorSeparationBasePx", overrides, stored);
    const corridorBase = Number.isFinite(rawCorridorBase) && rawCorridorBase >= 0
        ? rawCorridorBase : PINCER_CONFIG.corridorSeparationBasePx;
    const rawCorridorMultiplier = _configValue("corridorSeparationGridMultiplier", overrides, stored);
    const corridorMultiplier = Number.isFinite(rawCorridorMultiplier) && rawCorridorMultiplier >= 0
        ? rawCorridorMultiplier : PINCER_CONFIG.corridorSeparationGridMultiplier;
    const dynamicCorridor = Math.max(
        corridorBase,
        grid.size ? grid.size * corridorMultiplier : 0
    );
    const dynamicTravel = grid.size && grid.distance
        ? meters * (grid.size / grid.distance)
        : fallbackTravel;
    const result = {
        ...PINCER_CONFIG,
        maxTravelMeters: meters,
        maxTravelFallbackPx: fallbackTravel,
        preferredCohesion: cohesion,
        enemySpreadBasePx: spreadBase,
        enemySpreadCohesionMultiplier: spreadMultiplier,
        corridorSeparation: dynamicCorridor,
        maxTravel: dynamicTravel,
        spread: dynamicSpread,
        enemySpread: dynamicSpread
    };

    const numericRules = {
        minRouteAngleDeg: { min: 1, max: 180 },
        flankMinAngleDegrees: { min: 1, max: 180 },
        corridorSeparation: { min: 1 },
        corridorSeparationBasePx: { min: 0 },
        corridorSeparationGridMultiplier: { min: 0 },
        corridorSamples: { min: 2, integer: true },
        routeTrimFraction: { min: 0, max: 0.5 },
        probeMaxVisited: { min: 1, integer: true },
        minMembers: { min: 2, integer: true },
        maxTravel: { min: 1 },
        maxTravelMeters: { min: 0.1 },
        maxTravelFallbackPx: { min: 1 },
        spread: { min: 0 },
        enemySpreadBasePx: { min: 0 },
        enemySpreadCohesionMultiplier: { min: 0 },
        preferredCohesion: { min: 0.1 },
        fixMinRange: { min: 0 },
        maxDetachedPhases: { min: 0, integer: true }
    };
    for (const [key, rule] of Object.entries(numericRules)) {
        const value = _configValue(key, overrides, stored);
        if (!Number.isFinite(value)) continue;
        if (value < rule.min || (Number.isFinite(rule.max) && value > rule.max)) continue;
        if (rule.integer && !Number.isInteger(value)) continue;
        result[key] = value;
    }
    const routeProbe = _configValue("routeProbe", overrides, stored);
    if (typeof routeProbe === "boolean") result.routeProbe = routeProbe;
    const minMorale = _configValue("minMorale", overrides, stored);
    if (Object.prototype.hasOwnProperty.call(PINCER_MORALE_RANKS, minMorale)) result.minMorale = minMorale;
    const sync = _configValue("sync", overrides, stored);
    if (PINCER_SYNC_MODES.includes(sync)) result.sync = sync;
    result.enemySpread = result.spread;
    return result;
}

/**
 * Merge config-bearing input sources in increasing priority order.
 * @param {object} input Tactic input.
 * @param {object|null} direct Direct config argument.
 * @returns {object}
 */
function _configOverrides(input = {}, direct = null) {
    const merged = {};
    for (const source of [
        input.context?.specOpsConfig,
        input.context?.pincerConfig,
        input.pincerConfig,
        input.config,
        direct
    ]) {
        if (!source || typeof source !== "object") continue;
        for (const [key, value] of Object.entries(source)) merged[key] = value;
    }
    return merged;
}

/**
 * Resolve config for one pure input object.
 * @param {object} input
 * @param {object|null} [direct]
 * @returns {object}
 */
function _configForInput(input = {}, direct = null) {
    return resolvePincerConfig(_configOverrides(input, direct), null, input);
}

/**
 * Unwrap a Wall placeable to its document.
 * @param {*} wall
 * @returns {object|null}
 */
function _wallDoc(wall) {
    return wall?.document ?? wall ?? null;
}

/**
 * Whether a wall blocks a sense, accepting v13 object and legacy numeric schemas.
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
 * Wall endpoints as a segment.
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
 * Count blocking walls crossed by a direct segment.
 * @param {object|null} from
 * @param {object|null} to
 * @param {object[]} walls
 * @param {string} sense
 * @returns {number}
 */
function _wallsCrossed(from, to, walls, sense) {
    if (!_isPoint(from) || !_isPoint(to)) return 0;
    let count = 0;
    for (const wall of walls ?? []) {
        const doc = _wallDoc(wall);
        if (!_wallBlocks(doc, sense)) continue;
        const segment = _wallSegment(doc);
        if (segment && segmentsIntersect(from, to, segment.A, segment.B)) count += 1;
    }
    return count;
}

/**
 * Wall documents relevant to a pure geometry input.
 * @param {object} input
 * @returns {object[]}
 */
function _wallsOf(input = {}) {
    if (Array.isArray(input.walls)) return input.walls.map(_wallDoc).filter(Boolean);
    if (Array.isArray(input.context?.walls)) return input.context.walls.map(_wallDoc).filter(Boolean);
    return _list(_sceneOf(input)?.walls).map(_wallDoc).filter(Boolean);
}

/**
 * Loadout summary of one member: melee flag and best non-melee weapon range.
 * Explicit `bestRange`/`melee` or `loadout` fields win over actor item scanning.
 * @param {object} member
 * @returns {{melee: boolean, bestRange: number}}
 */
function _loadout(member) {
    const explicit = member?.loadout ?? {};
    let melee = member?.melee === true || explicit.melee === true;
    let bestRange = Number.isFinite(member?.bestRange) ? member.bestRange
        : (Number.isFinite(explicit.bestRange) ? explicit.bestRange : 0);
    const items = _list(member?.combatant?.actor?.items ?? member?.actor?.items ?? member?.items);
    for (const item of items) {
        if (item?.type !== "weapon") continue;
        const cls = item.system?.class ?? "";
        const range = _finiteOr(item.system?.range, 0);
        if (cls === "melee") melee = true;
        else bestRange = Math.max(bestRange, range);
    }
    return { melee, bestRange };
}

/**
 * Member position from the common pure/member fixture shapes.
 * @param {object|null} member
 * @returns {{x: number, y: number}|null}
 */
function _memberPosition(member) {
    const explicit = member?.position ?? member?.center ?? member?.selfPos ?? null;
    if (_isPoint(explicit)) return _point(explicit);
    if (_isPoint(member)) return _point(member);
    const token = member?.combatant?.token ?? member?.token ?? null;
    return _isPoint(token) ? _point(token) : null;
}

/**
 * Stable member id.
 * @param {object|null} member
 * @returns {string|null}
 */
function _memberId(member) {
    const id = member?.combatantId ?? member?.id ?? member?.combatant?.id ?? null;
    return id === null || id === undefined ? null : String(id);
}

/**
 * Normalize a raw id value without changing nullish absence.
 * @param {*} id
 * @returns {string|null}
 */
function _idString(id) {
    return id === null || id === undefined ? null : String(id);
}

/**
 * Sorted living/enabled member entries with normalized positions retained.
 * @param {object[]} members
 * @returns {object[]}
 */
function _availableMembers(members) {
    return (members ?? [])
        .filter(m => m && _memberId(m) && m.defeated !== true && m.enabled !== false)
        .map(m => ({ ...m, position: _memberPosition(m) }))
        .sort((a, b) => _memberId(a).localeCompare(_memberId(b)));
}

/**
 * Centroid of member positions.
 * @param {object[]} members
 * @returns {{x: number, y: number}|null}
 */
function _centroid(members) {
    let x = 0;
    let y = 0;
    let count = 0;
    for (const member of members ?? []) {
        if (!_isPoint(member?.position)) continue;
        x += member.position.x;
        y += member.position.y;
        count += 1;
    }
    return count ? { x: x / count, y: y / count } : null;
}

/**
 * Attack angle at a target between the frontal bearing and a firing point.
 * @param {object|null} center Front/team position.
 * @param {object|null} endpoint Firing/maneuver position.
 * @param {object|null} target Objective position.
 * @returns {number|null}
 */
function _attackAngle(center, endpoint, target) {
    if (!_isPoint(center) || !_isPoint(endpoint) || !_isPoint(target)) return null;
    return _angleBetweenDeg(
        { x: target.x - center.x, y: target.y - center.y },
        { x: target.x - endpoint.x, y: target.y - endpoint.y });
}

/**
 * Objective position from explicit point, target id or first hostile.
 * @param {object|null} objective
 * @param {object[]} hostiles
 * @returns {{x: number, y: number}|null}
 */
function _objectivePosition(objective, hostiles) {
    if (_isPoint(objective)) return _point(objective);
    if (_isPoint(objective?.targetPoint)) return _point(objective.targetPoint);
    if (_isPoint(objective?.point)) return _point(objective.point);
    if (objective?.targetId) {
        const hit = hostiles.find(t => t.tokenId === objective.targetId
            || t.tokenUuid === objective.targetId || t.id === objective.targetId);
        if (_isPoint(hit)) return _point(hit);
    }
    const first = hostiles[0];
    return _isPoint(first) ? _point(first) : null;
}

/**
 * Primary objective target id.
 * @param {object|null} objective
 * @param {object[]} hostiles
 * @returns {string|null}
 */
function _objectiveTargetId(objective, hostiles) {
    const id = objective?.targetId ?? objective?.flankTargetId ?? hostiles[0]?.tokenId ?? null;
    return id === null || id === undefined ? null : String(id);
}

/**
 * Normalize attackable hostiles used by the pure selector.
 * @param {object[]|null} targets
 * @returns {object[]}
 */
function _attackableHostiles(targets) {
    return (targets ?? []).filter(t => t
        && t.source !== "last-known"
        && t.source !== "team-contact"
        && t.canAttack !== false
        && t.hidden !== true);
}

/**
 * Convert loose flank-option input into candidate entries.
 * @param {*} flankOptions
 * @returns {object[]}
 */
function _candidateEntries(flankOptions) {
    if (!flankOptions) return [];
    if (Array.isArray(flankOptions)) return flankOptions;
    if (Array.isArray(flankOptions.options)) return flankOptions.options;
    const entries = [];
    for (const side of PINCER_SIDES) {
        const value = flankOptions[side];
        if (Array.isArray(value)) entries.push(...value.map(entry => ({ side, ...entry })));
        else if (value && typeof value === "object") entries.push({ side, ...value });
    }
    if (!entries.length && flankOptions.side) entries.push(flankOptions);
    return entries;
}

/**
 * Build one normalized lead candidate.
 * @param {object} input Geometry input.
 * @param {object} entry Raw flank-option entry.
 * @param {object|null} member Member record, when known.
 * @param {object} sidePoints Signed maneuver points.
 * @param {object|null} center Team/front position.
 * @param {object|null} objectivePos Objective position.
 * @param {object[]} walls Wall documents.
 * @returns {object|null}
 */
function _normalizeCandidate(input, entry, member, sidePoints, center, objectivePos, walls) {
    const side = PINCER_SIDES.includes(entry.side) ? entry.side : null;
    if (!side) return null;
    const leadId = entry.leadId ?? entry.flankerId ?? entry.combatantId
        ?? entry.memberId ?? _memberId(entry.flanker ?? entry.member) ?? _memberId(member);
    const start = _point(entry.start ?? entry.position ?? entry.route?.start
        ?? entry.waypoints?.[0] ?? member?.position);
    const point = _point(entry.point ?? entry.maneuverPoint ?? entry.flankPoint
        ?? entry.route?.end ?? sidePoints[side]);
    if (!point) return null;
    const loadout = _loadout(member ?? entry.flanker ?? entry.member ?? {});
    const rawTravel = Number.isFinite(entry.rawTravel) ? entry.rawTravel : _dist(start, point);
    const travel = Number.isFinite(entry.travel)
        ? entry.travel
        : rawTravel + (loadout.melee ? -50 : 0)
            + (loadout.bestRange > 0 && loadout.bestRange <= 5 ? -25 : 0);
    const maneuverAngle = Number.isFinite(entry.angle)
        ? entry.angle
        : _attackAngle(center, point, objectivePos);
    const leadAngle = Number.isFinite(entry.leadAngle) ? entry.leadAngle
        : (Number.isFinite(entry.currentAngle) ? entry.currentAngle
            : _attackAngle(center, start, objectivePos));
    const blocked = typeof entry.blocked === "boolean"
        ? entry.blocked
        : _wallsCrossed(start, point, walls, "move") > 0;
    const waypoints = Array.isArray(entry.waypoints) ? entry.waypoints.map(_point).filter(Boolean)
        : (Array.isArray(entry.route?.waypoints) ? entry.route.waypoints.map(_point).filter(Boolean) : null);
    return {
        side,
        point,
        start,
        leadId: leadId === null || leadId === undefined ? null : String(leadId),
        travel,
        rawTravel,
        angle: maneuverAngle,
        leadAngle,
        offAxis: Number.isFinite(leadAngle) && leadAngle + EPSILON >= input.cfg.flankMinAngleDegrees,
        blocked,
        waypoints,
        explicit: entry.explicit === true
    };
}

/**
 * Canonical generated flank candidates from center/objective geometry.
 * @param {object[]} members Sorted normalized members.
 * @param {string|null} leaderId
 * @param {object} sidePoints
 * @param {object|null} center
 * @param {object|null} objectivePos
 * @param {object[]} walls
 * @param {object} cfg
 * @returns {object[]}
 */
function _generatedCandidates(members, leaderId, sidePoints, center, objectivePos, walls, cfg) {
    const candidates = [];
    for (const side of PINCER_SIDES) {
        for (const member of members) {
            const id = _memberId(member);
            if (!id || id === leaderId || !_isPoint(member.position)) continue;
            const point = sidePoints[side];
            const loadout = _loadout(member);
            const rawTravel = _dist(member.position, point);
            candidates.push({
                side,
                point,
                start: _point(member.position),
                leadId: id,
                travel: rawTravel + (loadout.melee ? -50 : 0)
                    + (loadout.bestRange > 0 && loadout.bestRange <= 5 ? -25 : 0),
                rawTravel,
                angle: _attackAngle(center, point, objectivePos),
                leadAngle: _attackAngle(center, member.position, objectivePos),
                offAxis: Number.isFinite(_attackAngle(center, member.position, objectivePos))
                    && _attackAngle(center, member.position, objectivePos) + EPSILON >= cfg.flankMinAngleDegrees,
                blocked: _wallsCrossed(member.position, point, walls, "move") > 0,
                waypoints: null,
                explicit: false
            });
        }
    }
    return candidates;
}

/**
 * Deterministic candidate ordering inside one side: travel, then member id.
 * @param {object[]} candidates
 * @returns {object[]}
 */
function _sortCandidates(candidates) {
    return [...candidates].sort((a, b) => (a.travel - b.travel)
        || String(a.leadId).localeCompare(String(b.leadId)));
}

/**
 * Serializable side descriptor for one allocated lead candidate.
 * @param {object|null} candidate
 * @param {string} side
 * @param {object|null} point
 * @param {string|null} reason
 * @param {number} candidateCount
 * @param {object} cfg
 * @returns {object}
 */
function _sideResult(candidate, side, point, reason, candidateCount, cfg) {
    const valid = candidate && candidate.leadId && _isPoint(candidate.start) && _isPoint(candidate.point)
        && candidate.blocked !== true
        && Number.isFinite(candidate.angle)
        && candidate.angle + EPSILON >= cfg.flankMinAngleDegrees;
    const waypoints = valid
        ? (candidate.waypoints?.length >= 2
            ? candidate.waypoints.map(_point)
            : [_point(candidate.start), _point(candidate.point)])
        : null;
    return {
        side,
        point: _point(point ?? candidate?.point),
        leadId: valid ? candidate.leadId : null,
        travel: valid ? candidate.travel : null,
        rawTravel: valid ? candidate.rawTravel : null,
        angle: Number.isFinite(candidate?.angle) ? candidate.angle : null,
        leadAngle: Number.isFinite(candidate?.leadAngle) ? candidate.leadAngle : null,
        offAxis: candidate?.offAxis === true,
        blocked: candidate?.blocked === true,
        feasible: valid === true,
        reason: valid ? null : reason,
        candidateCount,
        route: waypoints
            ? { start: _point(waypoints[0]), end: _point(waypoints.at(-1)), waypoints }
            : null
    };
}

/**
 * Reason a side has no usable candidate.
 * @param {object[]} candidates
 * @param {object} cfg
 * @returns {string}
 */
function _missingSideReason(candidates, cfg) {
    if (!candidates.length) return "no-lead-flanker";
    if (candidates.some(c => c.blocked === true)) return "side-blocked";
    if (candidates.some(c => !Number.isFinite(c.angle)
        || c.angle + EPSILON < cfg.flankMinAngleDegrees)) {
        return "side-angle-unmet";
    }
    return "no-lead-flanker";
}

/**
 * Allocate distinct lead flankers with the conflict rule from issue #88: the
 * member stays on the smaller-travel side, ties go left and the loser takes
 * its next deterministic alternative.
 * @param {object[]} candidates
 * @param {object} sidePoints
 * @param {object} cfg
 * @returns {{left: object, right: object}}
 */
function _allocateSides(candidates, sidePoints, cfg) {
    const grouped = Object.fromEntries(PINCER_SIDES.map(side => [side, []]));
    for (const candidate of candidates) {
        if (!PINCER_SIDES.includes(candidate.side) || !candidate.leadId) continue;
        grouped[candidate.side].push(candidate);
    }
    const ordered = Object.fromEntries(PINCER_SIDES.map(side => {
        const usable = _sortCandidates(grouped[side].filter(c => c.blocked !== true
            && Number.isFinite(c.angle)
            && c.angle + EPSILON >= cfg.flankMinAngleDegrees
            && _isPoint(c.start)
            && _isPoint(c.point)));
        const seen = new Set();
        return [side, usable.filter(candidate => {
            if (seen.has(candidate.leadId)) return false;
            seen.add(candidate.leadId);
            return true;
        })];
    }));
    const reasons = Object.fromEntries(PINCER_SIDES.map(side => [
        side,
        ordered[side].length ? null : _missingSideReason(grouped[side], cfg)
    ]));
    const chosen = { left: ordered.left[0] ?? null, right: ordered.right[0] ?? null };
    if (chosen.left && chosen.right && chosen.left.leadId === chosen.right.leadId) {
        const leftTravel = chosen.left.travel;
        const rightTravel = chosen.right.travel;
        const winner = leftTravel < rightTravel - EPSILON ? "left"
            : (rightTravel < leftTravel - EPSILON ? "right" : "left");
        const loser = winner === "left" ? "right" : "left";
        const alternative = ordered[loser].find(c => c.leadId !== chosen[winner].leadId) ?? null;
        if (alternative) {
            chosen[loser] = alternative;
        } else {
            chosen[loser] = null;
            reasons[loser] = "no-distinct-lead-flanker";
        }
    }
    return {
        left: _sideResult(chosen.left, "left", sidePoints.left, reasons.left, grouped.left.length, cfg),
        right: _sideResult(chosen.right, "right", sidePoints.right, reasons.right, grouped.right.length, cfg)
    };
}

/**
 * Extract two signed pincer maneuver points and distinct lead flankers.
 *
 * Input may either supply flank-option candidates (`flankOptions`, `sides` or
 * `both`) or bare geometry (`members`, `leaderId`, `center`/`frontPos`,
 * `objective`/`objectivePos`, `targets`, `walls`). Generated geometry mirrors
 * `_flankOptions` in `spec-ops.js`: perpendicular points at
 * `max(100, distance/2)` px with the same capability travel bias. The output
 * itself is JSON-serializable.
 * @param {object} input
 * @param {object|null} [config] Pincer config overrides.
 * @returns {object} `{status, left, right, both, center, objectivePos, offset}`.
 */
export function extractPincerManeuverPoints(input = {}, config = null) {
    const cfg = _configForInput(input, config);
    const members = _availableMembers(input.members);
    const leader = input.leader ?? input.leaderMember ?? null;
    const leaderId = _idString(input.leaderId) ?? _memberId(leader) ?? null;
    const hostiles = _attackableHostiles(input.targets);
    const objectivePos = _point(input.objectivePos ?? input.objectivePosition)
        ?? _objectivePosition(input.objective, hostiles);
    const center = _point(input.center ?? input.frontPos ?? input.teamCenter)
        ?? _point(members.find(m => _memberId(m) === leaderId)?.position)
        ?? _centroid(members);
    const resultSides = {
        left: _sideResult(null, "left", null, "geometry-unavailable", 0, cfg),
        right: _sideResult(null, "right", null, "geometry-unavailable", 0, cfg)
    };
    if (!_isPoint(center) || !_isPoint(objectivePos)) {
        return {
            status: "unavailable",
            feasible: false,
            center: _point(center),
            objectivePos: _point(objectivePos),
            offset: null,
            left: resultSides.left,
            right: resultSides.right,
            both: null,
            coefficients: { flankMinAngleDegrees: cfg.flankMinAngleDegrees }
        };
    }

    const front = { x: objectivePos.x - center.x, y: objectivePos.y - center.y };
    const dist = Math.hypot(front.x, front.y);
    if (!(dist > 0)) {
        return {
            status: "unavailable",
            feasible: false,
            center: _point(center),
            objectivePos: _point(objectivePos),
            offset: null,
            left: resultSides.left,
            right: resultSides.right,
            both: null,
            coefficients: { flankMinAngleDegrees: cfg.flankMinAngleDegrees }
        };
    }
    const unit = { x: front.x / dist, y: front.y / dist };
    const perp = { x: -unit.y, y: unit.x };
    const offset = Math.max(100, dist * 0.5);
    const rad = (Math.max(90, cfg.flankMinAngleDegrees) * Math.PI) / 180;
    const forward = -Math.cos(rad) * offset;
    const lateral = Math.sin(rad) * offset;
    const sidePoints = {
        left: {
            x: objectivePos.x + (unit.x * forward) + (perp.x * lateral),
            y: objectivePos.y + (unit.y * forward) + (perp.y * lateral)
        },
        right: {
            x: objectivePos.x + (unit.x * forward) - (perp.x * lateral),
            y: objectivePos.y + (unit.y * forward) - (perp.y * lateral)
        }
    };

    const walls = _wallsOf(input);
    const entries = [];
    const suppliedSides = input.sides ?? input.flankSides ?? input.both ?? null;
    if (suppliedSides && typeof suppliedSides === "object" && !Array.isArray(suppliedSides)) {
        for (const side of PINCER_SIDES) {
            if (suppliedSides[side]) entries.push({ side, ...suppliedSides[side], explicit: true });
        }
    }
    const optionEntries = _candidateEntries(input.flankOptions);
    entries.push(...optionEntries.map(entry => ({ ...entry, explicit: true })));
    const byId = new Map(members.map(member => [_memberId(member), member]));
    const candidates = [];
    const inputSides = new Set();
    for (const entry of entries) {
        const member = entry.flanker ?? entry.member
            ?? byId.get(String(entry.leadId ?? entry.flankerId ?? entry.combatantId ?? entry.memberId));
        const normalized = _normalizeCandidate(
            { ...input, cfg }, entry, member, sidePoints, center, objectivePos, walls);
        if (normalized) {
            candidates.push(normalized);
            inputSides.add(normalized.side);
        }
    }
    const generated = _generatedCandidates(members, leaderId, sidePoints, center, objectivePos, walls, cfg);
    for (const candidate of generated) {
        if (!inputSides.has(candidate.side)) candidates.push(candidate);
    }
    const allocated = _allocateSides(candidates, sidePoints, cfg);
    const feasible = allocated.left.feasible === true && allocated.right.feasible === true;
    return {
        status: feasible ? "ok" : (allocated.left.feasible || allocated.right.feasible ? "partial" : "unavailable"),
        feasible,
        center: _point(center),
        objectivePos: _point(objectivePos),
        offset,
        left: allocated.left,
        right: allocated.right,
        both: feasible ? { left: allocated.left, right: allocated.right } : null,
        coefficients: { flankMinAngleDegrees: cfg.flankMinAngleDegrees }
    };
}

/**
 * Alias with the signed-point terminology used by the issue specification.
 * @param {object} input
 * @param {object|null} [config]
 * @returns {object}
 */
export function extractSignedManeuverPoints(input = {}, config = null) {
    return extractPincerManeuverPoints(input, config);
}

/**
 * Alias for integrations that call the extraction result simply "sides".
 * @param {object} input
 * @param {object|null} [config]
 * @returns {object}
 */
export function extractPincerSides(input = {}, config = null) {
    return extractPincerManeuverPoints(input, config);
}

/**
 * Remove consecutive duplicate points.
 * @param {object[]} points
 * @returns {object[]}
 */
function _dedupePoints(points) {
    const result = [];
    for (const point of points.map(_point).filter(Boolean)) {
        const last = result.at(-1);
        if (!last || _dist(last, point) > EPSILON) result.push(point);
    }
    return result;
}

/**
 * Total length of a polyline.
 * @param {object[]} points
 * @returns {number}
 */
export function polylineLength(points) {
    const normalized = _dedupePoints(points ?? []);
    let total = 0;
    for (let i = 0; i < normalized.length - 1; i++) {
        total += _dist(normalized[i], normalized[i + 1]);
    }
    return total;
}

/**
 * Trim the first length-fraction of a polyline, interpolating the cut point.
 * @param {object[]} points
 * @param {number} fraction
 * @returns {object[]}
 */
export function trimPolyline(points, fraction = PINCER_CONFIG.routeTrimFraction) {
    const normalized = _dedupePoints(points ?? []);
    if (normalized.length < 2) return normalized;
    const amount = Math.max(0, Math.min(1, _finiteOr(fraction, 0)));
    if (amount <= 0) return normalized;
    const total = polylineLength(normalized);
    const target = total * amount;
    if (!(target > 0)) return normalized;
    let travelled = 0;
    for (let i = 0; i < normalized.length - 1; i++) {
        const a = normalized[i];
        const b = normalized[i + 1];
        const length = _dist(a, b);
        if (travelled + length < target - EPSILON) {
            travelled += length;
            continue;
        }
        const remaining = Math.max(0, target - travelled);
        const t = length > 0 ? Math.min(1, remaining / length) : 0;
        const cut = { x: a.x + ((b.x - a.x) * t), y: a.y + ((b.y - a.y) * t) };
        return _dedupePoints([cut, ...normalized.slice(i + 1)]);
    }
    return [normalized.at(-1)];
}

/**
 * Uniformly sample a polyline, including both endpoints.
 * @param {object[]} points
 * @param {number} count
 * @returns {object[]}
 */
export function samplePolyline(points, count = PINCER_CONFIG.corridorSamples) {
    const normalized = _dedupePoints(points ?? []);
    const samples = Math.max(2, Math.floor(_finiteOr(count, PINCER_CONFIG.corridorSamples)));
    if (!normalized.length) return [];
    if (normalized.length === 1) return Array.from({ length: samples }, () => _point(normalized[0]));
    const total = polylineLength(normalized);
    if (!(total > 0)) return Array.from({ length: samples }, () => _point(normalized[0]));
    const result = [];
    let segmentIndex = 0;
    let segmentStartDistance = 0;
    const lengths = [];
    for (let i = 0; i < normalized.length - 1; i++) {
        lengths.push(_dist(normalized[i], normalized[i + 1]));
    }
    for (let sample = 0; sample < samples; sample++) {
        const target = total * (sample / (samples - 1));
        while (segmentIndex < lengths.length - 1
            && segmentStartDistance + lengths[segmentIndex] < target - EPSILON) {
            segmentStartDistance += lengths[segmentIndex];
            segmentIndex += 1;
        }
        const a = normalized[segmentIndex];
        const b = normalized[segmentIndex + 1];
        const length = lengths[segmentIndex] || 0;
        const t = length > 0 ? Math.max(0, Math.min(1, (target - segmentStartDistance) / length)) : 0;
        result.push({ x: a.x + ((b.x - a.x) * t), y: a.y + ((b.y - a.y) * t) });
    }
    return result;
}

/**
 * Normalize flexible route input to a polyline plus optional probe metadata.
 * Accepted forms are point arrays, `{start,end|point}`, `{waypoints}` and the
 * side descriptors returned by {@link extractPincerManeuverPoints}.
 * @param {*} route
 * @returns {object|null}
 */
export function normalizePincerRoute(route) {
    if (!route) return null;
    let points = null;
    if (Array.isArray(route)) points = route;
    if (!points && Array.isArray(route.points)) points = route.points;
    if (!points && Array.isArray(route.waypoints)) points = route.waypoints;
    if (!points && Array.isArray(route.path)) points = route.path;
    if (!points && Array.isArray(route.route?.waypoints)) points = route.route.waypoints;
    if (!points && Array.isArray(route.route?.points)) points = route.route.points;
    const start = _point(route.start ?? route.route?.start);
    const end = _point(route.end ?? route.point ?? route.maneuverPoint ?? route.route?.end);
    if (!points && start && end) points = [start, end];
    const normalized = _dedupePoints((points ?? []).map(p => (_isPoint(p) ? p : null)).filter(Boolean));
    if (normalized.length < 2) return null;
    return {
        points: normalized,
        start: _point(normalized[0]),
        end: _point(normalized.at(-1)),
        token: route.token ?? route.member?.combatant?.token ?? route.member?.token ?? null,
        member: route.member ?? route.flanker ?? null,
        probe: route.probe ?? null,
        side: PINCER_SIDES.includes(route.side) ? route.side : null
    };
}

/**
 * Extract usable waypoints from a navigation probe result.
 * @param {*} result
 * @returns {object[]|null}
 */
function _probeWaypoints(result) {
    if (!result) return null;
    if (Array.isArray(result)) return _dedupePoints(result);
    const points = result.waypoints ?? result.points ?? result.path ?? result.route ?? null;
    if (!Array.isArray(points)) return null;
    return _dedupePoints(points);
}

/**
 * Run one optional navigation probe. Fail-open to the straight route: probes
 * refine geometry but never mutate the maneuver decision by themselves.
 * @param {object} route Normalized route.
 * @param {string} side
 * @param {object} cfg Runtime config with optional navigation/probeRoute.
 * @returns {{waypoints: object[]|null, info: object}}
 */
function _probeRoute(route, side, cfg) {
    const baseInfo = {
        side,
        used: false,
        status: "unavailable",
        reason: null,
        visitedNodes: null
    };
    if (cfg.routeProbe === false) {
        return { waypoints: null, info: { ...baseInfo, status: "disabled" } };
    }
    const navigation = cfg.navigation ?? cfg.context?.navigation ?? null;
    const probeRoute = typeof cfg.probeRoute === "function" ? cfg.probeRoute : null;
    if (!navigation && !probeRoute && !route.probe) {
        return { waypoints: null, info: baseInfo };
    }
    let result = null;
    try {
        if (probeRoute) {
            result = probeRoute(route, side, cfg);
        } else if (route.probe) {
            result = typeof route.probe === "function" ? route.probe(route, side, cfg) : route.probe;
        } else if (typeof navigation?.searchRoute === "function") {
            result = navigation.searchRoute({
                start: route.start,
                goal: route.end,
                end: route.end,
                maxVisited: cfg.probeMaxVisited
            });
        } else if (typeof navigation?.planRoute === "function") {
            const subject = route.token ?? route.member ?? route.start;
            result = navigation.planRoute(subject, route.end, cfg.probeBudget ?? cfg.maxTravel, {
                maxVisited: cfg.probeMaxVisited
            });
        }
    } catch(_err) {
        return { waypoints: null, info: { ...baseInfo, status: "failed", reason: "probe-error" } };
    }
    if (result && typeof result.then === "function") {
        return { waypoints: null, info: { ...baseInfo, status: "failed", reason: "async-probe-unsupported" } };
    }
    const waypoints = _probeWaypoints(result);
    const failed = result?.status === "failed" || result?.exact === false;
    if (!failed && waypoints?.length >= 2) {
        return {
            waypoints,
            info: {
                side,
                used: true,
                status: result?.status ?? "ok",
                reason: null,
                visitedNodes: Number.isFinite(result?.visitedNodes) ? result.visitedNodes : null
            }
        };
    }
    return {
        waypoints: null,
        info: {
            ...baseInfo,
            status: result?.status ?? "failed",
            reason: result?.reason ?? "probe-unavailable",
            visitedNodes: Number.isFinite(result?.visitedNodes) ? result.visitedNodes : null
        }
    };
}

/**
 * Three-part false-envelopment test for two candidate routes.
 *
 * 1. endpoint vectors must differ by at least `minRouteAngleDeg`;
 * 2. trimmed polylines (first `routeTrimFraction`, default 25%, removed from
 *    each route) must not intersect;
 * 3. `corridorSamples` uniform samples (default K=8) of the trimmed polylines
 *    must keep at least `corridorSeparation` px pairwise separation.
 *
 * When `navigation`/`probeRoute` is supplied and `routeProbe` is true, exact
 * probe waypoints replace the straight polylines for checks 2–3. The result is
 * JSON-serializable and includes the specification breakdown coefficients.
 * @param {*} routeL Left route or side descriptor.
 * @param {*} routeR Right route or side descriptor.
 * @param {object} [cfg] Pincer config plus optional `navigation`/`probeRoute`.
 * @returns {object} `{angle, minSeparation, crossed, pass, reason, checks, probes}`.
 */
export function routesDiverge(routeL, routeR, cfg = {}) {
    const resolved = resolvePincerConfig(cfg, null, cfg);
    const runtime = {
        ...resolved,
        navigation: cfg.navigation ?? cfg.context?.navigation ?? null,
        context: cfg.context ?? null,
        probeRoute: cfg.probeRoute,
        probeBudget: cfg.probeBudget
    };
    const originalL = normalizePincerRoute(routeL);
    const originalR = normalizePincerRoute(routeR);
    const probeL = originalL ? _probeRoute(originalL, "left", runtime) : null;
    const probeR = originalR ? _probeRoute(originalR, "right", runtime) : null;
    const pointsL = probeL?.waypoints ?? originalL?.points ?? [];
    const pointsR = probeR?.waypoints ?? originalR?.points ?? [];
    const probes = {
        left: probeL?.info ?? { side: "left", used: false, status: "invalid", reason: "invalid-route", visitedNodes: null },
        right: probeR?.info ?? { side: "right", used: false, status: "invalid", reason: "invalid-route", visitedNodes: null }
    };
    const valid = pointsL.length >= 2 && pointsR.length >= 2;
    const vectorL = valid
        ? { x: pointsL.at(-1).x - pointsL[0].x, y: pointsL.at(-1).y - pointsL[0].y }
        : { x: 0, y: 0 };
    const vectorR = valid
        ? { x: pointsR.at(-1).x - pointsR[0].x, y: pointsR.at(-1).y - pointsR[0].y }
        : { x: 0, y: 0 };
    const angle = valid ? _angleBetweenDeg(vectorL, vectorR) : null;
    const trimmedL = valid ? trimPolyline(pointsL, resolved.routeTrimFraction) : [];
    const trimmedR = valid ? trimPolyline(pointsR, resolved.routeTrimFraction) : [];
    let crossed = false;
    for (let i = 0; i < trimmedL.length - 1 && !crossed; i++) {
        for (let j = 0; j < trimmedR.length - 1; j++) {
            if (segmentsIntersect(trimmedL[i], trimmedL[i + 1], trimmedR[j], trimmedR[j + 1])) {
                crossed = true;
                break;
            }
        }
    }
    const samplesL = valid ? samplePolyline(trimmedL, resolved.corridorSamples) : [];
    const samplesR = valid ? samplePolyline(trimmedR, resolved.corridorSamples) : [];
    let minSeparation = Number.POSITIVE_INFINITY;
    for (const left of samplesL) {
        for (const right of samplesR) {
            minSeparation = Math.min(minSeparation, _dist(left, right));
        }
    }
    if (!Number.isFinite(minSeparation)) minSeparation = null;
    let continuousSeparation = Number.POSITIVE_INFINITY;
    for (let i = 0; i < trimmedL.length - 1; i++) {
        for (let j = 0; j < trimmedR.length - 1; j++) {
            continuousSeparation = Math.min(continuousSeparation,
                segmentDistance(trimmedL[i], trimmedL[i + 1], trimmedR[j], trimmedR[j + 1]));
        }
    }
    if (!Number.isFinite(continuousSeparation)) continuousSeparation = null;
    const anglePass = Number.isFinite(angle) && angle + EPSILON >= resolved.minRouteAngleDeg;
    const separationPass = Number.isFinite(minSeparation)
        && minSeparation + EPSILON >= resolved.corridorSeparation;
    const pass = valid && anglePass && crossed !== true && separationPass;
    const reason = !valid ? "invalid-route"
        : (!anglePass ? "route-angle-insufficient"
            : (crossed ? "routes-cross"
                : (!separationPass ? "corridor-separation" : null)));
    return {
        angle: _round(angle),
        minSeparation: _round(minSeparation),
        continuousSeparation: _round(continuousSeparation),
        crossed,
        pass,
        reason,
        checks: {
            angle: {
                pass: anglePass,
                value: _round(angle),
                threshold: resolved.minRouteAngleDeg
            },
            intersection: {
                pass: !crossed,
                crossed,
                trimFraction: resolved.routeTrimFraction
            },
            corridor: {
                pass: separationPass,
                minSeparation: _round(minSeparation),
                continuousSeparation: _round(continuousSeparation),
                threshold: resolved.corridorSeparation,
                samples: resolved.corridorSamples
            }
        },
        probes
    };
}

/**
 * Deterministic side pick for residuals in full composition: smaller group,
 * then larger side travel, then left.
 * @param {object} sizes Current group sizes.
 * @param {object} sides Side descriptors.
 * @returns {string}
 */
function _residualSide(sizes, sides) {
    if (sizes.left < sizes.right) return "left";
    if (sizes.right < sizes.left) return "right";
    const leftTravel = _finiteOr(sides?.left?.travel, 0);
    const rightTravel = _finiteOr(sides?.right?.travel, 0);
    if (leftTravel > rightTravel + EPSILON) return "left";
    if (rightTravel > leftTravel + EPSILON) return "right";
    return "left";
}

/**
 * Side with smaller travel for loose assault leader placement; tie left.
 * @param {object} sides
 * @returns {string}
 */
function _smallerTravelSide(sides) {
    const leftTravel = _finiteOr(sides?.left?.travel, 0);
    const rightTravel = _finiteOr(sides?.right?.travel, 0);
    if (rightTravel < leftTravel - EPSILON) return "right";
    return "left";
}

/**
 * Leader-specific smaller-travel flank for the loose n=4 composition. When
 * side points are known the leader's own distance decides; sparse test/input
 * descriptors fall back to the side lead travel. Ties go left.
 * @param {object|null} leaderMember
 * @param {object} sides
 * @returns {string}
 */
function _leaderFlankSide(leaderMember, sides) {
    const position = _memberPosition(leaderMember);
    const leftTravel = _isPoint(position) && _isPoint(sides?.left?.point)
        ? _dist(position, sides.left.point)
        : _finiteOr(sides?.left?.travel, 0);
    const rightTravel = _isPoint(position) && _isPoint(sides?.right?.point)
        ? _dist(position, sides.right.point)
        : _finiteOr(sides?.right?.travel, 0);
    if (rightTravel < leftTravel - EPSILON) return "right";
    return "left";
}

/**
 * Whether a member can fix by fire at the configured minimum range.
 * @param {object} member
 * @param {object} cfg
 * @returns {boolean}
 */
function _rangedCapable(member, cfg) {
    const range = _loadout(member).bestRange;
    return range > 0 && range + EPSILON >= cfg.fixMinRange;
}

/**
 * Sort ids by loadout range, longest first, then id.
 * @param {string[]} ids
 * @param {Map} byId
 * @param {boolean} [ascending] Shortest first instead.
 * @returns {string[]}
 */
function _sortByRange(ids, byId, ascending = false) {
    return [...ids].sort((a, b) => {
        const rangeA = _loadout(byId.get(a)).bestRange;
        const rangeB = _loadout(byId.get(b)).bestRange;
        return (ascending ? rangeA - rangeB : rangeB - rangeA) || a.localeCompare(b);
    });
}

/**
 * Remove one id from an array when present.
 * @param {string[]} array
 * @param {string} id
 * @returns {boolean}
 */
function _removeId(array, id) {
    const index = array.indexOf(id);
    if (index < 0) return false;
    array.splice(index, 1);
    return true;
}

/**
 * Normalize compose arguments supporting both positional and object forms.
 * @param {*} members
 * @param {*} leader
 * @param {*} sides
 * @param {*} cfg
 * @returns {object}
 */
function _composeArgs(members, leader, sides, cfg) {
    if (members && !Array.isArray(members) && typeof members === "object") {
        const input = members;
        return {
            members: input.members ?? [],
            leader: input.leader ?? input.leaderId ?? null,
            sides: input.sides ?? input.extraction ?? input.both ?? input,
            cfg: input.config ?? input.pincerConfig ?? cfg ?? {},
            variant: input.variant ?? input.mode ?? null,
            loose: input.loose === true
        };
    }
    return {
        members,
        leader,
        sides,
        cfg: cfg ?? {},
        variant: cfg?.variant ?? cfg?.mode ?? null,
        loose: cfg?.loose === true
    };
}

/**
 * Build a serializable composition result.
 * @param {string} status
 * @param {string|null} reason
 * @param {object} groups
 * @param {object[]} members
 * @param {object} cfg
 * @param {boolean} loose
 * @param {object|null} rebalance
 * @returns {object}
 */
function _compositionResult(status, reason, groups, members, cfg, loose, rebalance = null) {
    const sortedIds = members.map(_memberId).sort((a, b) => a.localeCompare(b));
    const left = [...groups.left].sort((a, b) => a.localeCompare(b));
    const right = [...groups.right].sort((a, b) => a.localeCompare(b));
    const fix = [...groups.fix].sort((a, b) => a.localeCompare(b));
    const center = [...groups.center].sort((a, b) => a.localeCompare(b));
    const assignments = {};
    for (const id of sortedIds) {
        if (left.includes(id)) {
            assignments[id] = { task: "flank", element: "flank-left", role: "flanker" };
        } else if (right.includes(id)) {
            assignments[id] = { task: "flank", element: "flank-right", role: "flanker" };
        } else if (loose && center.includes(id)) {
            assignments[id] = { task: "assault", element: "center", role: "assault" };
        } else if (!loose && fix.includes(id)) {
            assignments[id] = { task: "support", element: "fix", role: "fixer" };
        }
    }
    const composition = loose ? { left, right, center } : { left, right, fix };
    return {
        status,
        reason,
        composition,
        assignments,
        sizes: {
            left: left.length,
            right: right.length,
            fix: loose ? 0 : fix.length,
            center: loose ? center.length : 0,
            total: left.length + right.length + (loose ? center.length : fix.length)
        },
        rebalance,
        coefficients: {
            minMembers: cfg.minMembers,
            fixMinRange: cfg.fixMinRange,
            fixCap: Math.max(1, Math.ceil((members.length - 2) / 2))
        }
    };
}

/**
 * Compose the loose assault groups: two flank elements plus an optional
 * central assault element. At the minimum four-member size the centre is
 * empty and the leader joins the smaller-travel flank (tie left).
 * @param {object[]} members
 * @param {string|null} leaderId
 * @param {object} sides
 * @param {object} cfg
 * @returns {object}
 */
function _composeLooseGroups(members, leaderId, sides, cfg) {
    const byId = new Map(members.map(member => [_memberId(member), member]));
    const leftLead = sides?.left?.leadId;
    const rightLead = sides?.right?.leadId;
    if (!leftLead || !rightLead || leftLead === rightLead || !byId.has(leftLead) || !byId.has(rightLead)) {
        return _compositionResult("unavailable", PINCER_REASONS.compositionInfeasible,
            { left: [], right: [], fix: [], center: [] }, members, cfg, true);
    }
    const groups = { left: [leftLead], right: [rightLead], fix: [], center: [] };
    const remaining = new Set([...byId.keys()].filter(id => id !== leftLead && id !== rightLead));
    const emptyCenter = members.length <= cfg.minMembers;
    if (emptyCenter) {
        if (leaderId && remaining.has(leaderId)) {
            const side = _leaderFlankSide(byId.get(leaderId), sides);
            groups[side].push(leaderId);
            remaining.delete(leaderId);
        }
        for (const id of [...remaining].sort((a, b) => a.localeCompare(b))) {
            const side = groups.left.length === groups.right.length
                ? _smallerTravelSide(sides)
                : (groups.left.length < groups.right.length ? "left" : "right");
            groups[side].push(id);
            remaining.delete(id);
        }
    } else {
        if (leaderId && remaining.has(leaderId)) {
            groups.center.push(leaderId);
            remaining.delete(leaderId);
        }
        const flankTarget = 2;
        for (const id of [...remaining].sort((a, b) => a.localeCompare(b))) {
            const deficient = PINCER_SIDES.filter(side => groups[side].length < flankTarget);
            if (deficient.length) {
                const side = deficient.length === 1 ? deficient[0] : _smallerTravelSide(sides);
                groups[side].push(id);
            } else {
                groups.center.push(id);
            }
            remaining.delete(id);
        }
    }
    const valid = groups.left.length >= 1 && groups.right.length >= 1;
    return _compositionResult(valid ? "ok" : "unavailable",
        valid ? null : PINCER_REASONS.compositionInfeasible,
        groups, members, cfg, true);
}

/**
 * Deterministically compose full pincer groups or loose assault groups.
 *
 * Full composition invariant: at least one member in each flank, at least one
 * in fix, and fix contains a ranged-capable member (`bestRange >= fixMinRange`).
 * The leader is always in fix. When no ranged member lands there, the
 * longest-range flanker is rebalanced into fix; if this is impossible the
 * result is `unavailable` with `pincer-no-ranged-fix` (melee-only degradation).
 * @param {object[]|object} members Member entries or object-form input.
 * @param {object|string|null} [leader] Leader entry or id.
 * @param {object|null} [sides] Extraction result or `{left,right}`.
 * @param {object} [cfg] Config overrides; `loose`/`variant` selects assault data.
 * @returns {object} `{status, reason, composition, assignments, sizes, coefficients}`.
 */
export function composePincerGroups(members = [], leader = null, sides = null, cfg = {}) {
    const args = _composeArgs(members, leader, sides, cfg);
    const input = Array.isArray(members) ? {} : members;
    const resolved = resolvePincerConfig(_configOverrides(input, args.cfg), null, input);
    const loose = args.loose || ["assault", "loose", PINCER_LOOSE_TACTIC].includes(args.variant);
    const normalizedMembers = _availableMembers(args.members);
    const extraction = args.sides?.left && args.sides?.right ? args.sides : null;
    const normalizedSides = extraction ? { left: extraction.left, right: extraction.right } : null;
    const leaderId = typeof args.leader === "string" || typeof args.leader === "number"
        ? String(args.leader)
        : (_memberId(args.leader) ?? _idString(input.leaderId) ?? null);
    if (normalizedMembers.length < resolved.minMembers) {
        return _compositionResult("unavailable", PINCER_REASONS.insufficientMembers,
            { left: [], right: [], fix: [], center: [] }, normalizedMembers, resolved, loose);
    }
    if (loose) return _composeLooseGroups(normalizedMembers, leaderId, normalizedSides, resolved);

    const byId = new Map(normalizedMembers.map(member => [_memberId(member), member]));
    const leftLead = normalizedSides?.left?.leadId;
    const rightLead = normalizedSides?.right?.leadId;
    if (!leftLead || !rightLead || leftLead === rightLead || !byId.has(leftLead) || !byId.has(rightLead)) {
        return _compositionResult("unavailable", PINCER_REASONS.compositionInfeasible,
            { left: [], right: [], fix: [], center: [] }, normalizedMembers, resolved, false);
    }
    const groups = { left: [leftLead], right: [rightLead], fix: [], center: [] };
    const remaining = new Set([...byId.keys()].filter(id => id !== leftLead && id !== rightLead));
    const fixCap = Math.max(1, Math.ceil((normalizedMembers.length - 2) / 2));
    if (leaderId && remaining.has(leaderId)) {
        groups.fix.push(leaderId);
        remaining.delete(leaderId);
    }
    const rankedFixers = _sortByRange([...remaining].filter(id => _rangedCapable(byId.get(id), resolved)), byId);
    while (groups.fix.length < fixCap && rankedFixers.length) {
        const id = rankedFixers.shift();
        if (!remaining.has(id)) continue;
        groups.fix.push(id);
        remaining.delete(id);
    }
    for (const id of [...remaining].sort((a, b) => a.localeCompare(b))) {
        if (groups.fix.length < fixCap && _rangedCapable(byId.get(id), resolved)) {
            groups.fix.push(id);
        } else {
            const side = _residualSide({ left: groups.left.length, right: groups.right.length }, normalizedSides);
            groups[side].push(id);
        }
        remaining.delete(id);
    }

    let rebalance = null;
    const fixHasRanged = () => groups.fix.some(id => _rangedCapable(byId.get(id), resolved));
    if (!fixHasRanged()) {
        const flankIds = [...groups.left, ...groups.right]
            .filter(id => _rangedCapable(byId.get(id), resolved));
        const donors = _sortByRange(flankIds, byId);
        const donor = donors[0] ?? null;
        if (donor) {
            const donorSide = groups.left.includes(donor) ? "left" : "right";
            _removeId(groups[donorSide], donor);
            groups.fix.push(donor);
            rebalance = { memberId: donor, from: donorSide, to: "fix", reason: "fix-requires-ranged" };
            if (!groups[donorSide].length) {
                const otherSide = donorSide === "left" ? "right" : "left";
                if (groups[otherSide].length > 1) {
                    const replacement = _sortByRange(groups[otherSide], byId, true)[0];
                    _removeId(groups[otherSide], replacement);
                    groups[donorSide].push(replacement);
                    rebalance.replacementId = replacement;
                }
            }
        }
    }
    const valid = groups.left.length >= 1 && groups.right.length >= 1 && groups.fix.length >= 1;
    if (!valid) {
        return _compositionResult("unavailable", PINCER_REASONS.compositionInfeasible,
            groups, normalizedMembers, resolved, false, rebalance);
    }
    if (!fixHasRanged()) {
        return _compositionResult("unavailable", PINCER_REASONS.noRangedFix,
            groups, normalizedMembers, resolved, false, rebalance);
    }
    return _compositionResult("ok", null, groups, normalizedMembers, resolved, false, rebalance);
}

/**
 * Loose assault composition convenience wrapper.
 * @param {object[]|object} members
 * @param {object|string|null} [leader]
 * @param {object|null} [sides]
 * @param {object} [cfg]
 * @returns {object}
 */
export function composePincerLooseGroups(members = [], leader = null, sides = null, cfg = {}) {
    if (members && !Array.isArray(members) && typeof members === "object") {
        return composePincerGroups({ ...members, loose: true, variant: "assault" }, leader, sides, cfg);
    }
    return composePincerGroups(members, leader, sides, { ...cfg, loose: true, variant: "assault" });
}

/**
 * Normalize a morale input (string, evaluated record or legacy booleans).
 * Absent/damaged morale reads as the baseline `pressured` tier.
 * @param {*} morale
 * @returns {string}
 */
export function normalizePincerMoraleTier(morale) {
    if (typeof morale === "string" && Object.prototype.hasOwnProperty.call(PINCER_MORALE_RANKS, morale)) return morale;
    if (morale && typeof morale === "object") {
        for (const key of ["effectiveTier", "tier", "state"]) {
            if (Object.prototype.hasOwnProperty.call(PINCER_MORALE_RANKS, morale[key])) return morale[key];
        }
        if (morale.desperate === true) return "desperate";
        if (morale.confident === true) return "confident";
        if (morale.pressured === true) return "pressured";
    }
    return "pressured";
}

/**
 * Evaluate the configurable pincer morale gate.
 * @param {*} moraleTier Tier string/record; absence reads as `pressured`.
 * @param {string} [minimum] Minimum tier (`desperate` < `pressured` < `confident`).
 * @returns {object} `{tier, minimum, rank, minimumRank, pass}`.
 */
export function evaluatePincerMoraleGate(moraleTier, minimum = PINCER_CONFIG.minMorale) {
    const tier = normalizePincerMoraleTier(moraleTier);
    const min = Object.prototype.hasOwnProperty.call(PINCER_MORALE_RANKS, minimum) ? minimum : PINCER_CONFIG.minMorale;
    const rank = PINCER_MORALE_RANKS[tier];
    const minimumRank = PINCER_MORALE_RANKS[min];
    return { tier, minimum: min, rank, minimumRank, pass: rank >= minimumRank };
}

/**
 * Boolean convenience wrapper for the morale gate.
 * @param {*} moraleTier
 * @param {string} [minimum]
 * @returns {boolean}
 */
export function pincerMoralePasses(moraleTier, minimum = PINCER_CONFIG.minMorale) {
    return evaluatePincerMoraleGate(moraleTier, minimum).pass;
}

/**
 * Serializable synchronization semantics of a pincer descriptor.
 * @param {string} mode `elastic`, `strict` or `none`.
 * @returns {object}
 */
export function pincerSyncPolicy(mode = PINCER_CONFIG.sync) {
    if (mode === "none") {
        return {
            mode: "none",
            readyWhen: "individual-initiative",
            awaitSelection: "none",
            validation: "none"
        };
    }
    if (mode === "strict") {
        return {
            mode: "strict",
            readyWhen: "all-transit-flankers",
            awaitSelection: "all-transit",
            validation: "any-awaited-lost-breaks-sync"
        };
    }
    return {
        mode: "elastic",
        readyWhen: "any-flank-member",
        awaitSelection: "earliest-transit",
        validation: "all-awaited-lost-breaks-sync"
    };
}

/**
 * Maximum pairwise spread of attackable enemies.
 * @param {object[]} hostiles
 * @param {object} [cfg] Resolved pincer config with `spread` in pixels.
 * @returns {{spread: number|null, pass: boolean, threshold: number}}
 */
export function measurePincerConcentration(hostiles = [], cfg = PINCER_CONFIG) {
    const points = (hostiles ?? []).map(_point).filter(Boolean);
    if ((hostiles ?? []).some(t => !_point(t))) {
        return { spread: null, pass: false, threshold: cfg.spread };
    }
    let spread = 0;
    for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
            spread = Math.max(spread, _dist(points[i], points[j]));
        }
    }
    return {
        spread: _round(spread),
        pass: points.length > 0 && spread + EPSILON <= cfg.spread,
        threshold: cfg.spread
    };
}

/**
 * Shared flank-progress factor: normalized progress of a candidate endpoint
 * toward `context.team.flankPoint` relative to the member's current position.
 * This mirrors the spec-ops helper and is exported here for the assault-loose
 * overlay without importing preset implementation details.
 * @param {object} candidate Scored candidate `{move?}`.
 * @param {object} context Planning context (`selfPos`, `team.flankPoint`).
 * @returns {number} 0..1.
 */
export function flankProgress(candidate = {}, context = {}) {
    const point = context.team?.flankPoint ?? null;
    const self = _point(context.selfPos ?? context.position ?? context.center);
    const endpoint = candidate.move && !candidate.move.stay ? _point(candidate.move) : self;
    if (!_isPoint(point) || !_isPoint(self) || !_isPoint(endpoint)) return 0;
    const base = _dist(self, point);
    if (!(base > 0) || !Number.isFinite(base)) return 0;
    const progress = Math.max(0, Math.min(1, (base - _dist(endpoint, point)) / base));
    return _round(progress) ?? 0;
}

/**
 * Alias clarifying that the helper belongs to the pincer shared core.
 * @param {object} candidate
 * @param {object} context
 * @returns {number}
 */
export function pincerFlankProgress(candidate = {}, context = {}) {
    return flankProgress(candidate, context);
}

/**
 * Serializable config coefficients for diagnostics/breakdown.
 * @param {object} cfg
 * @returns {object}
 */
function _coefficients(cfg) {
    return {
        minRouteAngleDeg: cfg.minRouteAngleDeg,
        flankMinAngleDegrees: cfg.flankMinAngleDegrees,
        corridorSeparation: _round(cfg.corridorSeparation),
        corridorSamples: cfg.corridorSamples,
        routeTrimFraction: cfg.routeTrimFraction,
        routeProbe: cfg.routeProbe === true,
        minMembers: cfg.minMembers,
        maxTravel: _round(cfg.maxTravel),
        spread: _round(cfg.spread),
        fixMinRange: cfg.fixMinRange,
        minMorale: cfg.minMorale,
        sync: cfg.sync
    };
}

/**
 * Compact side summary for breakdowns.
 * @param {object|null} side
 * @returns {object|null}
 */
function _sideBreakdown(side) {
    if (!side) return null;
    return {
        feasible: side.feasible === true,
        leadId: side.leadId ?? null,
        travel: _round(side.travel),
        rawTravel: _round(side.rawTravel),
        angle: _round(side.angle),
        blocked: side.blocked === true,
        reason: side.reason ?? null
    };
}

/**
 * Rounded serialized element entry of the polymorphic pincer objective.
 * @param {object} side
 * @returns {object}
 */
function _objectiveElement(side) {
    return {
        point: _roundPoint(side.point),
        travel: _round(side.travel),
        angle: _round(side.angle),
        leadId: side.leadId ?? null
    };
}

/**
 * Build the polymorphic objective of a successful pincer descriptor.
 * @param {object} input
 * @param {string|null} input.targetId
 * @param {object|null} input.objectivePos
 * @param {object} input.sides `{left,right}` side descriptors.
 * @param {string} input.sync `elastic`/`strict`/`none`.
 * @param {boolean} [input.loose] Loose assault variant.
 * @param {object|null} [input.center] Front/team centre.
 * @param {object|null} [input.composition] Composition result.
 * @param {string|null} [input.leaderId]
 * @returns {object}
 */
export function buildPincerObjective({
    targetId = null,
    objectivePos = null,
    sides = {},
    sync = PINCER_CONFIG.sync,
    loose = false,
    center = null,
    composition = null,
    leaderId = null
} = {}) {
    const mode = loose ? "none" : sync;
    const elements = {
        left: _objectiveElement(sides.left ?? {}),
        right: _objectiveElement(sides.right ?? {})
    };
    if (loose && composition?.composition?.center?.length) {
        elements.center = {
            point: _roundPoint(objectivePos ?? center),
            leadId: leaderId ?? composition.composition.center[0],
            members: composition.composition.center.length
        };
    }
    return {
        type: loose ? PINCER_LOOSE_TACTIC : PINCER_TACTIC,
        targetId: targetId ?? null,
        flankTargetId: targetId ?? null,
        targetPoint: _roundPoint(objectivePos),
        sync: mode,
        syncPolicy: pincerSyncPolicy(mode),
        elements
    };
}

/**
 * Compose a degraded one-side flank-and-fix fallback after a pincer rejection.
 * @param {object[]} members Available members.
 * @param {string|null} leaderId
 * @param {object} side Feasible side descriptor.
 * @param {string|null} targetId
 * @param {object|null} objectivePos
 * @param {string} reason Degradation reason.
 * @param {string|null} cause Detailed cause.
 * @returns {object}
 */
function _degradedFallback(members, leaderId, side, targetId, objectivePos, reason, cause) {
    const memberIds = members.map(_memberId).sort((a, b) => a.localeCompare(b));
    const flankCount = Math.max(1, Math.floor(memberIds.length / 3));
    const flankers = [];
    if (side.leadId && memberIds.includes(side.leadId)) flankers.push(side.leadId);
    if (flankers.length < flankCount) {
        const byId = new Map(members.map(member => [_memberId(member), member]));
        const candidates = memberIds
            .filter(id => id !== leaderId && !flankers.includes(id))
            .map(id => ({ id, travel: _dist(byId.get(id)?.position, side.point) }))
            .sort((a, b) => (a.travel - b.travel) || a.id.localeCompare(b.id));
        for (const entry of candidates.slice(0, flankCount - flankers.length)) flankers.push(entry.id);
    }
    const flankSet = new Set(flankers);
    const fix = memberIds.filter(id => !flankSet.has(id));
    const assignments = {};
    for (const id of memberIds) {
        assignments[id] = flankSet.has(id)
            ? { task: "flank", element: `flank-${side.side}`, role: "flanker" }
            : { task: "support", element: "fix", role: "fixer" };
    }
    return {
        assignments,
        composition: {
            left: side.side === "left" ? [...flankers].sort((a, b) => a.localeCompare(b)) : [],
            right: side.side === "right" ? [...flankers].sort((a, b) => a.localeCompare(b)) : [],
            fix: [...fix].sort((a, b) => a.localeCompare(b))
        },
        objective: {
            type: "flank-and-fix",
            targetId: targetId ?? null,
            flankTargetId: targetId ?? null,
            targetPoint: _roundPoint(objectivePos),
            flankSide: side.side,
            flankPoint: _roundPoint(side.point)
        },
        degradation: {
            reason,
            side: side.side,
            cause: cause ?? side.reason ?? null
        },
        taskCapacities: { flank: 1 }
    };
}

/**
 * Select/build a pincer tactic descriptor from pure situation input.
 *
 * This is the shared core only: `name: null` means the caller must fall through
 * to its preset's existing branches. A one-side/divergence failure returns the
 * specified degraded `flank-and-fix` descriptor with a stable
 * `pincer-degraded-*` reason. `variant: "assault"`/`loose: true` builds the
 * loose assault descriptor (`type`/`name` `pincer-loose`, `sync: "none"`).
 * @param {object} input
 * @param {object[]} [input.members] Fireteam member entries.
 * @param {string|null} [input.leaderId] Leader combatant id.
 * @param {object[]} [input.targets] Normalized targets.
 * @param {object|null} [input.objective] Shared objective.
 * @param {*} [input.moraleTier] Team morale tier or record.
 * @param {object} [input.context] Pure context (`walls`, `navigation`, config).
 * @param {object} [input.config] Pincer config overrides.
 * @param {boolean} [input.loose] Build the assault-loose variant.
 * @param {string} [input.variant] `"specOps"`/`"assault"`/`"loose"`.
 * @returns {object} JSON-serializable tactic descriptor/fallthrough record.
 */
export function selectPincerTactic(input = {}) {
    const context = input.context ?? {};
    const cfg = _configForInput(input);
    const loose = input.loose === true
        || ["assault", "loose", PINCER_LOOSE_TACTIC].includes(input.variant ?? input.teamPreset);
    const members = _availableMembers(input.members);
    const leaderId = _idString(input.leaderId) ?? _memberId(input.leader) ?? null;
    const hostiles = _attackableHostiles(input.targets);
    const memberCount = members.length;
    const enemyCount = hostiles.length;
    const morale = evaluatePincerMoraleGate(input.moraleTier ?? input.morale, cfg.minMorale);
    const concentration = measurePincerConcentration(hostiles, cfg);
    const coefficients = _coefficients(cfg);
    let divergence = null;
    let composition = null;
    let degradation = null;
    let sideSummary = null;
    const breakdown = {
        members: memberCount,
        enemies: enemyCount,
        superiority: {
            pass: memberCount > enemyCount,
            margin: memberCount - enemyCount
        },
        concentration,
        moraleTier: morale.tier,
        morale,
        divergence: null,
        sides: null,
        composition: null,
        degradation: null,
        coefficients
    };
    const finish = (name, reason, extra = {}) => {
        const descriptor = {
            name,
            reason,
            assignments: extra.assignments ?? {},
            allowFlank: extra.allowFlank === true,
            regroup: false,
            objective: extra.objective ?? null,
            maxDetachedPhases: cfg.maxDetachedPhases,
            taskCapacities: extra.taskCapacities ?? {},
            breakdown: {
                ...breakdown,
                divergence: divergence ?? null,
                sides: sideSummary,
                composition: extra.composition ?? composition?.composition ?? composition ?? null,
                degradation: degradation ?? extra.degradation ?? null,
                ...(extra.breakdown ?? {})
            },
            diagnostics: {
                decision: reason,
                coefficients,
                morale,
                degradation: degradation ?? extra.degradation ?? null
            }
        };
        if (descriptor.allowFlank) descriptor.flankMinAngleDegrees = cfg.flankMinAngleDegrees;
        return descriptor;
    };

    if (memberCount < cfg.minMembers) return finish(null, PINCER_REASONS.insufficientMembers);
    if (!enemyCount) return finish(null, PINCER_REASONS.noAttackableTarget);
    if (memberCount <= enemyCount) return finish(null, PINCER_REASONS.notSuperior);
    if (!morale.pass) return finish(null, PINCER_REASONS.moraleGate);
    if (!concentration.pass) return finish(null, PINCER_REASONS.enemySpread);

    const objectivePos = _point(input.objectivePos ?? input.objectivePosition)
        ?? _objectivePosition(input.objective, hostiles);
    if (!_isPoint(objectivePos)) return finish(null, PINCER_REASONS.noObjective);
    const targetId = _objectiveTargetId(input.objective, hostiles);
    const extraction = extractPincerManeuverPoints({
        ...input,
        members,
        leaderId,
        targets: hostiles,
        objectivePos,
        context,
        config: cfg
    }, cfg);
    let sides = {
        left: { ...extraction.left, route: extraction.left.route ? { ...extraction.left.route } : null },
        right: { ...extraction.right, route: extraction.right.route ? { ...extraction.right.route } : null }
    };
    sideSummary = {
        left: _sideBreakdown(sides.left),
        right: _sideBreakdown(sides.right)
    };
    const feasibleCount = PINCER_SIDES.filter(side => sides[side].feasible === true).length;
    if (!feasibleCount) return finish(null, PINCER_REASONS.noFeasibleSide);

    const degraded = (reason, cause = null) => {
        const feasibleSides = PINCER_SIDES.map(side => sides[side]).filter(side => side.feasible === true);
        const side = feasibleSides.sort((a, b) => (a.travel - b.travel) || a.side.localeCompare(b.side))[0];
        const fallback = _degradedFallback(members, leaderId, side, targetId, objectivePos, reason, cause);
        degradation = fallback.degradation;
        return finish("flank-and-fix", reason, {
            assignments: fallback.assignments,
            allowFlank: true,
            objective: fallback.objective,
            composition: fallback.composition,
            degradation: fallback.degradation,
            taskCapacities: fallback.taskCapacities
        });
    };

    if (feasibleCount === 1) {
        const missing = PINCER_SIDES.map(sideName => sides[sideName]).find(side => side.feasible !== true);
        return degraded(PINCER_DEGRADATION_REASONS.sideBlocked, missing?.reason ?? "side-infeasible");
    }

    const runtimeConfig = {
        ...cfg,
        navigation: input.navigation ?? context.navigation ?? null,
        context,
        probeRoute: input.probeRoute ?? context.probeRoute,
        probeBudget: input.probeBudget ?? context.probeBudget
    };
    divergence = routesDiverge(sides.left, sides.right, runtimeConfig);
    if (!divergence.pass) {
        return degraded(PINCER_DEGRADATION_REASONS.noDivergence, divergence.reason);
    }

    for (const sideName of PINCER_SIDES) {
        const side = sides[sideName];
        const travel = Number.isFinite(side.rawTravel) ? side.rawTravel : side.travel;
        const travelPass = Number.isFinite(travel) && travel <= cfg.maxTravel + EPSILON;
        sides[sideName] = { ...side, travelPass };
        if (side.feasible === true && !travelPass) {
            sides[sideName].feasible = false;
            sides[sideName].reason = "travel-exceeded";
        }
    }
    sideSummary = {
        left: _sideBreakdown(sides.left),
        right: _sideBreakdown(sides.right)
    };
    const travelFeasible = PINCER_SIDES.filter(side => sides[side].feasible === true).length;
    if (!travelFeasible) return finish(null, PINCER_REASONS.noFeasibleSide);
    if (travelFeasible === 1) return degraded(PINCER_DEGRADATION_REASONS.sideBlocked, "travel-exceeded");

    composition = loose
        ? composePincerLooseGroups(members, leaderId, { left: sides.left, right: sides.right }, cfg)
        : composePincerGroups(members, leaderId, { left: sides.left, right: sides.right }, cfg);
    if (composition.status !== "ok") {
        return finish(null, composition.reason ?? PINCER_REASONS.compositionInfeasible);
    }
    const center = extraction.center;
    const sync = loose ? "none" : cfg.sync;
    const objective = buildPincerObjective({
        targetId,
        objectivePos,
        sides,
        sync,
        loose,
        center,
        composition,
        leaderId
    });
    const maxFlankSize = Math.max(composition.sizes.left, composition.sizes.right, 1);
    return finish(loose ? PINCER_LOOSE_TACTIC : PINCER_TACTIC,
        loose ? "superiority-pincer-loose" : "superiority-pincer", {
            assignments: composition.assignments,
            allowFlank: true,
            objective,
            composition: composition.composition,
            taskCapacities: { flank: maxFlankSize },
            breakdown: {
                sync: pincerSyncPolicy(sync),
                rebalance: composition.rebalance ?? null
            }
        });
}

/**
 * Alias for integrations that prefer assessment terminology.
 * @param {object} input
 * @returns {object}
 */
export function assessPincer(input = {}) {
    return selectPincerTactic(input);
}

/**
 * Default pincer tactic factory compatible with the `context.tactic` hook.
 * @param {object} input
 * @returns {object}
 */
export function pincerTactic(input = {}) {
    return selectPincerTactic(input);
}

/**
 * Bind a pincer tactic factory with explicit config overrides.
 * @param {object} [config]
 * @returns {Function}
 */
export function createPincerTactic(config = {}) {
    return input => selectPincerTactic({ ...input, config });
}
