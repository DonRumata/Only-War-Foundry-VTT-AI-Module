/**
 * Spec-ops preset — «Спецназ» (issue #412, epic #363).
 *
 * Behaviour contract:
 * - The preset is *team tactics on top of the fireteam service* (#408):
 *   inside a fireteam (`context.team` injected by `buildTeamPlan`) each
 *   member's individual evaluation is biased by its temporary task
 *   (`support`/`advance`/`flank`/`assault`/`regroup`); the shared TeamPlan
 *   itself is assembled by `fireteam.buildTeamPlan`; the deterministic
 *   {@link specOpsTactic} factory is registered as the preset maneuver in
 *   the per-preset tactic registry (explicit `context.tactic` still wins).
 * - The tactic selector is a pure, deterministic situation assessment:
 *   member count, attackable contacts, casualties, threat pressure and
 *   flank geometry (maneuver hints). It proposes a serializable tactic;
 *   the fireteam only commits to flank-and-fix once its member plans
 *   prove the required attack angle and any movement to the firing cell.
 * - Bounded maneuvers: `flank-and-fix` (one group pins frontally, a flank
 *   group takes an alternative attack vector), `coordinated-assault` (all
 *   subgroups assault behind the shared barrier), `covering-advance`
 *   (longest-range half supports while the rest advances) and
 *   `regroup-fallback` (everyone falls back to the regroup point inside
 *   cohesion when casualties mount or threat is overwhelming).
 * - Task → individual weights: `support` drifts toward the ranged-cover
 *   profile, `advance` keeps balanced movement bias, `flank` adds the
 *   `flankAngle` factor rewarding endpoints off the team's frontal
 *   bearing, `assault` uses the assault profile, `regroup` adds the
 *   `cohesionRestore` factor pulling the endpoint toward the rejoin
 *   point (`context.team.regroupPoint`/`center`).
 * - Solo mode: a specOps NPC outside a fireteam (`context.team` absent)
 *   falls back to a safe assault+hold hybrid; the breakdown reports
 *   `team.mode: "solo"` and `team.reason: "no-fireteam"`.
 * - `specOpsVeto` refuses attacks on hidden/last-known contacts —
 *   the preset never fires blind (`hidden-target`).
 */
import { evaluateFactors } from "../planner.js";
import { _findToken, _tokenDoc, _tokenPosition } from "../planner/documents.js";
import { DEFAULT_TACTIC_PRIORITY } from "../tactics/registry.js";
import {
    SPEC_OPS_CONFIG,
    SPEC_OPS_PRESET_ID,
    resolveSpecOpsConfig
} from "./spec-ops-config.js";

export { SPEC_OPS_CONFIG, SPEC_OPS_PRESET_ID };

/** Rejection reason produced by {@link specOpsVeto}. */
export const SPEC_OPS_VETO_HIDDEN_TARGET = "hidden-target";

/** Bounded team maneuvers the tactic selector may commit to. */
export const SPEC_OPS_TACTICS = Object.freeze([
    "flank-and-fix",
    "coordinated-assault",
    "covering-advance",
    "regroup-fallback"
]);

/**
 * Data-driven weights for the spec-ops preset — the solo/balanced base.
 * Names match `SCORE_FACTORS` in `scripts/planner.js` plus the
 * preset-only factors `flankAngle` and `cohesionRestore`; missing
 * factors contribute 0.
 */
export const SPEC_OPS_WEIGHTS = Object.freeze({
    attackNow: 9,
    attackAfterMove: 7,
    // Smoke: a lasgun-armed operative has no doctrine for knife charges —
    // melee is the fallback when nothing fires, never a plan.
    charge: -3,
    melee: -4,
    advance: 3,
    threat: 3,
    proximity: 1.5,
    los: 3,
    cover: 3,
    exposure: -2,
    holdPosition: 1,
    lastKnown: 1,
    budgetOver: -6,
    flankAngle: 0,
    cohesionRestore: 0,
    attackType: 0.15,
    vulnerable: 1,
    meleeEngage: 3,
    area: 5,
    aim: 2,
    aimAlone: 1.5,
    reload: 3,
    overwatch: 2,
    // Issue #16: spec-ops reads the threat map like rangedCover does.
    danger: -2,
    // Issue #37: spec-ops takes cover under fire but keeps moving when it
    // can; signature weapons and backup weapons score as elsewhere.
    weaponAffinity: 1,
    weaponInertia: 0.15,
    dropProne: 1,
    readyWeapon: 2,
    // Issue #39: spec-ops is disciplined fire — real shooting-into-
    // melee avoidance (−6, roughly the −20 rules penalty), mild engage
    // pull and a real grudge memory.
    alliedEngagement: -6,
    leaveMeleeEngage: -6,
    engageDenial: 1,
    unpin: 4,
    grudge: 3,
    ev: 1,
    stickyTarget: 4,
    outnumber: 2,
    // Spec-ops doctrine (smoke): melee is a *denial* tool, not a damage
    // tool — an operative ties up a known pure shooter (high ranged EV,
    // no melee emitter) so it cannot fire. `melee` stays negative so the
    // pull only ever wins against a genuinely dangerous gun.
    tieUp: 6,
    // Seek doctrine (smoke): a hidden endpoint on a hearsay contact beats
    // the identical approach step — peering around cover is the spec-ops
    // way of closing in.
    seek: 3,
    // Run mechanic (smoke): sprinting between cover is acceptable when
    // the next hide lies past a full move — a modest pull.
    run: 1

});

/**
 * Per-task weight overlays merged over {@link SPEC_OPS_WEIGHTS} when the
 * fireteam injects `context.team.task`. They are a *temporary* bias —
 * no permanent roles are created.
 */
export const SPEC_OPS_TASK_WEIGHTS = Object.freeze({
    support: Object.freeze({
        attackNow: 10,
        attackAfterMove: 4,
        charge: -4,
        melee: -8,
        advance: 0.5,
        los: 6,
        cover: 6,
        exposure: -3,
        holdPosition: 2
    }),
    advance: Object.freeze({
        attackAfterMove: 5,
        charge: 1,
        advance: 6,
        proximity: 2,
        exposure: -3,
        holdPosition: -1
    }),
    flank: Object.freeze({
        attackAfterMove: 8,
        charge: 2,
        advance: 4,
        proximity: 2,
        cover: 2,
        exposure: -1,
        holdPosition: -2,
        flankAngle: 8,
        flankProgress: 6
    }),
    assault: Object.freeze({
        attackNow: 8,
        attackAfterMove: 8,
        charge: 5,
        melee: 2,
        advance: 4,
        proximity: 3,
        los: 1,
        cover: 1,
        holdPosition: -2,
        attackType: 0.2,
        meleeEngage: 4,
        tieUp: 4
    }),
    regroup: Object.freeze({
        attackNow: 4,
        attackAfterMove: 2,
        charge: -2,
        advance: 1,
        proximity: 0.5,
        threat: 3,
        holdPosition: 0,
        cohesionRestore: 10
    })
});

/**
 * Solo fallback overlay — a safe assault+hold hybrid for a specOps NPC
 * that is not part of a fireteam.
 */
export const SPEC_OPS_SOLO_WEIGHTS = Object.freeze({
    attackNow: 8,
    attackAfterMove: 6,
    charge: 2,
    advance: 3,
    threat: 3,
    los: 2,
    cover: 2,
    holdPosition: 2,
    attackType: 0.1,
    vulnerable: 0.5,
    meleeEngage: 2,
    tieUp: 3
});

/** Candidate variants whose action produces an attack/test step. */
const ATTACK_VARIANTS = new Set([
    "attack-in-place", "move-attack", "charge", "aim-attack"
]);

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
 * Clamp a number into `[0, 1]`.
 * @param {*} value
 * @returns {number}
 */
function _clamp01(value) {
    return Math.max(0, Math.min(1, _finiteOr(value, 0)));
}

/**
 * Whether a point has both coordinates.
 * @param {object|null} point Point in scene pixels.
 * @returns {boolean}
 */
function _isPoint(point) {
    return Number.isFinite(point?.x) && Number.isFinite(point?.y);
}

/**
 * Convert document-space coordinates to the footprint centre used by
 * vision and serialized route waypoints.
 * @param {object|null} token Token document, absent for pure geometry inputs.
 * @param {object|null} scene Planning scene.
 * @param {object} [position] Token top-left (may come from a snapshot).
 * @returns {{x: number, y: number}|null}
 */
export function specOpsTokenCenter(token, scene, position = _tokenPosition(token)) {
    if (!_isPoint(position)) return null;
    const size = scene?.grid?.size;
    if (!token || !Number.isFinite(size) || size <= 0) return position;
    return {
        x: position.x + (_finiteOr(token.width, 1) * size / 2),
        y: position.y + (_finiteOr(token.height, 1) * size / 2)
    };
}

/**
 * Perception supplies centres; combat fallback and older injected target
 * records can carry a TokenDocument's top-left instead.
 * @param {object|null} target Normalized target record.
 * @param {object} context Planning scene and combat for token lookup.
 * @returns {{x: number, y: number}|null}
 */
function _targetCenter(target, context) {
    if (!_isPoint(target)) return null;
    if (target.source === "visible" || target.canAttack === false) return target;
    const id = target.tokenId ?? (typeof target.tokenUuid === "string" ? target.tokenUuid.split(".").pop() : null);
    const token = _findToken(id, { combat: context.combat, scene: context.scene ?? { tokens: [] } });
    const topLeft = _tokenPosition(token);
    return target.source === "fallback" || (target.x === topLeft.x && target.y === topLeft.y)
        ? specOpsTokenCenter(token, context.scene, target) : target;
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
 * Euclidean distance between two `{x, y}` points (Infinity when
 * incomplete).
 * @param {object|null} a
 * @param {object|null} b
 * @returns {number}
 */
function _dist(a, b) {
    if (!_isPoint(a) || !_isPoint(b)) {
        return Number.POSITIVE_INFINITY;
    }
    return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Angle in degrees between two 2D vectors (null when degenerate).
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
 * Centroid of member positions (null when no member has coordinates).
 * @param {object[]} members
 * @returns {{x: number, y: number}|null}
 */
function _centroid(members) {
    let x = 0;
    let y = 0;
    let count = 0;
    for (const member of members ?? []) {
        const pos = member?.position;
        if (!Number.isFinite(pos?.x) || !Number.isFinite(pos?.y)) continue;
        x += pos.x;
        y += pos.y;
        count += 1;
    }
    return count ? { x: x / count, y: y / count } : null;
}

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
 * Open doors never block. Mirrors the ranged-cover preset's probe.
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
 * Wall documents relevant for the flank/frontal probes: injected
 * `context.walls` first, then the planning scene's wall collection.
 * @param {object} context Tactic/planning context.
 * @returns {object[]}
 */
function _wallsOf(context = {}) {
    if (Array.isArray(context.walls)) {
        return context.walls.map(_wallDoc).filter(Boolean);
    }
    const scene = context.scene ?? context.combat?.scene
        ?? globalThis.canvas?.scene ?? null;
    return _list(scene?.walls).map(_wallDoc).filter(Boolean);
}

/**
 * Count blocking walls of `sense` ("sight" or "move") crossed by
 * `from → to`.
 * @param {object|null} from
 * @param {object|null} to
 * @param {object[]} walls
 * @param {string} sense
 * @returns {number}
 */
function _wallsCrossed(from, to, walls, sense) {
    if (!Number.isFinite(from?.x) || !Number.isFinite(from?.y)
        || !Number.isFinite(to?.x) || !Number.isFinite(to?.y)) return 0;
    let count = 0;
    for (const doc of walls ?? []) {
        if (!_wallBlocks(doc, sense)) continue;
        const segment = _wallSegment(doc);
        if (segment && _segmentsIntersect(from, to, segment.A, segment.B)) count += 1;
    }
    return count;
}

/**
 * Weapon capability summary of one member: melee flag and the longest
 * non-melee reach (scene units). Capability-based assignments prefer
 * short-range/melee members for the detached flank and long-range
 * members for support overwatch — never a permanent role.
 * @param {object} member Fireteam member entry.
 * @returns {{melee: boolean, bestRange: number}}
 */
function _loadout(member) {
    const items = _list(member?.combatant?.actor?.items);
    let melee = false;
    let bestRange = 0;
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
 * Candidate endpoint in pixels: the move destination, otherwise the
 * caller's own position (`context.selfPos`).
 * @param {object} candidate
 * @param {object} context
 * @returns {{x: number, y: number}|null}
 */
function _candidateEndpoint(candidate, context = {}) {
    const move = candidate?.move;
    if (move && !move.stay && Number.isFinite(move.x) && Number.isFinite(move.y)) {
        return { x: move.x, y: move.y };
    }
    return context.selfPos ?? null;
}

/**
 * Actual attack angle at the target relative to the team's frontal
 * bearing. All points are footprint centres (or an explicit blast aim).
 * @param {object|null} center Front position.
 * @param {object|null} endpoint Firing position.
 * @param {object|null} target Attack point.
 * @returns {number|null}
 */
function _attackAngle(center, endpoint, target) {
    if (!_isPoint(center) || !_isPoint(endpoint) || !_isPoint(target)) return null;
    return _angleBetweenDeg(
        { x: target.x - center.x, y: target.y - center.y },
        { x: target.x - endpoint.x, y: target.y - endpoint.y });
}

/**
 * Resolve one candidate's actual firing geometry, not its maneuver hint.
 * The same geometry drives the hard gate and the preset's soft score.
 * @param {object} candidate
 * @param {object} context
 * @returns {object}
 */
function _flankGeometry(candidate, context) {
    const center = context.team?.flankCenter ?? context.team?.center ?? context.teamCenter;
    const move = candidate.move && !candidate.move.stay ? candidate.move : null;
    const endpoint = move ?? specOpsTokenCenter(context.token, context.scene, context.selfPos);
    const target = candidate.aim ?? _targetCenter(candidate.target, context);
    const angle = _attackAngle(center, endpoint, target);
    const cross = angle === null ? 0 : _cross(center, target, endpoint);
    return { angle, side: cross > 0 ? "left" : cross < 0 ? "right" : null };
}

/**
 * Check the attack of a proposed flank against the doctrine threshold.
 * Native navigation certifies movement through its measured waypoints;
 * a speculative endpoint, partial path or missing route is not proof.
 * @param {object} candidate Attack target/aim and optional move.
 * @param {object} context Member planning context with flank centre and cutoff.
 * @returns {{angle: number|null, side: string|null, reason: string|null}}
 */
export function checkSpecOpsFlank(candidate, context) {
    if (candidate.target?.canAttack !== true || candidate.target.hidden === true
        || ["last-known", "team-contact"].includes(candidate.target.source)) {
        return { angle: null, side: null, reason: "flank-attack-unavailable" };
    }
    const geometry = _flankGeometry(candidate, context);
    if (!Number.isFinite(geometry.angle) || geometry.angle + 1e-9 < context.team.flankMinAngleDegrees) {
        return { ...geometry, reason: "flank-angle-unmet" };
    }
    const move = candidate.move;
    if (move && !move.stay) {
        const route = move.waypoints;
        const start = specOpsTokenCenter(context.token, context.scene, context.selfPos);
        // Native routing starts at the snapped cell; an off-grid token
        // can differ from that first waypoint by less than a grid cell.
        const size = _finiteOr(context.scene?.grid?.size, 100);
        if (move.approximate || !Number.isFinite(move.cost) || move.cost < 0
            || !Array.isArray(route) || route.length < 2 || !route.every(_isPoint)
            || !start || Math.abs(start.x - route[0].x) >= size || Math.abs(start.y - route[0].y) >= size
            || _dist(route[0], move) <= 1e-6 || _dist(route.at(-1), move) > 1e-6) {
            return { ...geometry, reason: "flank-route-unproven" };
        }
    }
    return { ...geometry, reason: null };
}

/**
 * `flankProgress` factor: how much closer the candidate endpoint lands
 * to the team's flank maneuver point (`context.team.flankPoint`)
 * relative to the current position — the move that actually runs the
 * maneuver, not just the firing angle `flankAngle` rewards.
 * @param {object} candidate
 * @param {object} context
 * @returns {number}
 */
function _flankProgress(candidate, context) {
    const point = context.team?.flankPoint ?? null;
    const self = specOpsTokenCenter(context.token, context.scene, context.selfPos);
    const endpoint = candidate.move && !candidate.move.stay ? candidate.move : self;
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)
        || !Number.isFinite(self?.x) || !Number.isFinite(self?.y) || !endpoint) {
        return 0;
    }
    const base = _dist(self, point);
    if (!(base > 0)) return 0;
    return Math.round(_clamp01((base - _dist(endpoint, point)) / base) * 1e4) / 1e4;
}

/**
 * Cohesion-restoration progress of the candidate endpoint toward the
 * team's regroup point (or centre): 1 when the endpoint lands on it,
 * 0 when it keeps or extends the distance. Feeds the
 * `cohesionRestore` factor for `regroup`/`support` tasks (issue #56).
 * @param {object} candidate Scored candidate `{variant, move?}`.
 * @param {object} context Evaluation context (`selfPos`, `team`).
 * @returns {number} 0..1.
 */
function _cohesionRestore(candidate, context) {
    const regroupPoint = context.team?.regroupPoint ?? context.team?.center
        ?? context.regroupPoint ?? null;
    const self = context.selfPos;
    const endpoint = _candidateEndpoint(candidate, context);
    if (!Number.isFinite(regroupPoint?.x) || !Number.isFinite(regroupPoint?.y)
        || !Number.isFinite(self?.x) || !Number.isFinite(self?.y) || !endpoint) {
        return 0;
    }
    const base = _dist(self, regroupPoint);
    if (!(base > 0) || !Number.isFinite(base)) return 0;
    return Math.round(_clamp01((base - _dist(endpoint, regroupPoint)) / base) * 1e4) / 1e4;
}

/**
 * Objective position for flank geometry: an explicit objective point,
 * then the objective's target, then the first attackable contact.
 * @param {object|null} objective
 * @param {object[]} hostiles Attackable normalized targets.
 * @returns {{x: number, y: number}|null}
 */
function _objectivePosition(objective, hostiles) {
    if (Number.isFinite(objective?.x) && Number.isFinite(objective?.y)) {
        return { x: objective.x, y: objective.y };
    }
    if (objective?.targetId) {
        const hit = hostiles.find(t => t.tokenId === objective.targetId
            || t.tokenUuid === objective.targetId);
        if (Number.isFinite(hit?.x) && Number.isFinite(hit?.y)) {
            return { x: hit.x, y: hit.y };
        }
    }
    const first = hostiles[0];
    return Number.isFinite(first?.x) && Number.isFinite(first?.y)
        ? { x: first.x, y: first.y } : null;
}

/**
 * Primary objective id for assignments: the explicit objective target,
 * else the first attackable contact (targets arrive sorted by tokenUuid).
 * @param {object|null} objective
 * @param {object[]} hostiles
 * @returns {string|null}
 */
function _objectiveTargetId(objective, hostiles) {
    return objective?.targetId ?? hostiles[0]?.tokenId ?? null;
}

/**
 * Rank two search anchors around the objective, not actual endpoints.
 * Prefer a member already off-axis, then an unobstructed hint, short
 * travel and close-range loadout. A wall on the direct segment to a hint
 * says nothing about legal firing cells or routes around the obstruction.
 * @param {object[]} members
 * @param {string|null} leaderId
 * @param {{x: number, y: number}|null} center Frontal position.
 * @param {{x: number, y: number}} objectivePos
 * @param {object[]} walls
 * @param {object} cfg Resolved spec-ops config.
 * @returns {object|null} Preferred search anchor and first flanker.
 */
function _flankOptions(members, leaderId, center, objectivePos, walls, cfg) {
    if (!center) return null;
    const front = { x: objectivePos.x - center.x, y: objectivePos.y - center.y };
    const dist = Math.hypot(front.x, front.y);
    if (!(dist > 0)) return null;
    const unit = { x: front.x / dist, y: front.y / dist };
    const perp = { x: -unit.y, y: unit.x };
    const offset = Math.max(100, dist * 0.5);
    const minAngle = cfg.flankMinAngleDegrees;
    const rad = (Math.max(90, minAngle) * Math.PI) / 180;
    const forward = -Math.cos(rad) * offset;
    const lateral = Math.sin(rad) * offset;
    const options = [];
    for (const [side, sign] of [["left", 1], ["right", -1]]) {
        const point = {
            x: objectivePos.x + (unit.x * forward) + (perp.x * lateral * sign),
            y: objectivePos.y + (unit.y * forward) + (perp.y * lateral * sign)
        };
        for (const member of members) {
            const pos = member.position;
            if (member.combatantId === leaderId || !_isPoint(pos)) continue;
            const loadout = _loadout(member);
            const travel = _dist(pos, point)
                + (loadout.melee ? -50 : 0)
                + (loadout.bestRange > 0 && loadout.bestRange <= 5 ? -25 : 0);
            const angle = _attackAngle(center, pos, objectivePos);
            options.push({
                side, point, travel, flanker: member,
                offAxis: Number.isFinite(angle) && angle + 1e-9 >= minAngle,
                blocked: _wallsCrossed(pos, point, walls, "move") > 0
            });
        }
    }
    options.sort((a, b) => Number(b.offAxis) - Number(a.offAxis)
        || Number(a.blocked) - Number(b.blocked) || (a.travel - b.travel)
        || a.side.localeCompare(b.side)
        || String(a.flanker.combatantId).localeCompare(String(b.flanker.combatantId)));
    return options[0] ?? null;
}

/**
 * Flank-and-fix assignments: `max(1, floor(n/3))` non-leader members
 * nearest the chosen flank point take `flank`; the leader and everyone
 * else hold the front on `support` (fix).
 * @param {object[]} members Sorted member entries.
 * @param {object|null} leader Leader member entry.
 * @param {object} flankBest Winning flank option from `_flankOptions`.
 * @returns {object} `combatantId → task` map.
 */
function _flankAssignments(members, leader, flankBest) {
    const flankCount = Math.max(1, Math.floor(members.length / 3));
    const flankers = [flankBest.flanker.combatantId];
    if (flankCount > 1) {
        const rest = members
            .filter(m => m.combatantId !== leader?.combatantId
                && !flankers.includes(m.combatantId))
            .map(m => ({ m, travel: _dist(m.position, flankBest.point) }))
            .sort((a, b) => (a.travel - b.travel)
                || String(a.m.combatantId).localeCompare(String(b.m.combatantId)));
        for (const entry of rest.slice(0, flankCount - 1)) {
            flankers.push(entry.m.combatantId);
        }
    }
    const detached = new Set(flankers);
    return Object.fromEntries(members.map(m => [
        m.combatantId,
        detached.has(m.combatantId) ? "flank" : "support"
    ]));
}

/**
 * Covering-advance assignments: capability split — the members with the
 * longest weapon reach take `support` (overwatch), the rest `advance`.
 * At least one member lands in each role.
 * @param {object[]} members Sorted member entries.
 * @returns {object} `combatantId → task` map.
 */
function _coveringAssignments(members) {
    const ranked = [...members].sort((a, b) =>
        (_loadout(b).bestRange - _loadout(a).bestRange)
        || String(a.combatantId).localeCompare(String(b.combatantId)));
    const supportCount = Math.max(1, Math.ceil(ranked.length / 2));
    return Object.fromEntries(ranked.map((m, i) => [
        m.combatantId,
        i < supportCount ? "support" : "advance"
    ]));
}

/**
 * Replace a rejected flank with covering advance, reporting the failed
 * requirement to preview/executor rather than the tentative tactic.
 * @param {object[]} members Living members.
 * @param {object} tactic Original draft tactic.
 * @param {object} failure Invalid flank evidence.
 * @returns {object} Non-flank tactic descriptor.
 */
export function specOpsFlankFallback(members, tactic, failure) {
    return {
        name: "covering-advance",
        reason: failure.reason,
        assignments: _coveringAssignments(members),
        allowFlank: false,
        maxDetachedPhases: tactic.maxDetachedPhases,
        breakdown: { ...tactic.breakdown, flank: { ...failure, feasible: false } }
    };
}

/**
 * Deterministic spec-ops tactic selector (issue #412): assesses the
 * situation — member count, attackable contacts, casualties, threat
 * pressure and flank geometry — and returns a serializable descriptor
 * consumed by `fireteam.buildTeamPlan` (`context.tactic`). The same
 * input always yields the same maneuver, groups and assignments.
 * @param {object} input
 * @param {object[]} input.members Fireteam member entries (`collectMembers`).
 * @param {string|null} [input.leaderId] Elected leader combatant id.
 * @param {object[]|null} [input.targets] Normalized shared target list.
 * @param {object|null} [input.objective] Shared objective `{targetId, x, y}`.
 * @param {number} [input.casualties] Defeated teammates this round.
 * @param {object|null} [input.scene] Planning scene.
 * @param {object|null} [input.combat] Combat document for geometry lookup.
 * @param {object} [input.context] Planning context (`walls`, `scene`,
 *   `regroup`, `specOpsConfig`, `seed`).
 * @param {object} [input.config] `SpecOpsConfig` overrides.
 * @returns {object} `{name, reason, assignments, allowFlank, regroup,
 *   objective, maxDetachedPhases, breakdown}`; `name: null` means the
 *   default fireteam policy applies (`insufficient-members`).
 */
export function selectSpecOpsTactic({
    members = [],
    leaderId = null,
    targets = null,
    objective = null,
    casualties = 0,
    scene = null,
    combat = null,
    context = {},
    config = null
} = {}) {
    const cfg = resolveSpecOpsConfig(config, context.specOpsConfig);
    const available = (members ?? [])
        .filter(m => m && m.combatantId && m.defeated !== true && m.enabled !== false)
        .sort((a, b) => String(a.combatantId).localeCompare(String(b.combatantId)));
    const memberCount = available.length;
    const casualtyCount = Math.max(0, _finiteOr(casualties, 0))
        + (members ?? []).filter(m => m?.defeated === true).length;
    const hostiles = (targets ?? []).filter(t => t
        && t.source !== "last-known" && t.canAttack !== false && t.hidden !== true);
    const enemyCount = hostiles.length;
    const pressure = memberCount > 0 ? enemyCount / memberCount : Number.POSITIVE_INFINITY;
    const breakdown = {
        members: memberCount,
        enemies: enemyCount,
        casualties: casualtyCount,
        pressure: Number.isFinite(pressure) ? Math.round(pressure * 1e4) / 1e4 : null
    };
    const all = task => Object.fromEntries(available.map(m => [m.combatantId, task]));
    const finish = (name, reason, extra = {}) => ({
        name,
        reason,
        assignments: extra.assignments ?? {},
        allowFlank: extra.allowFlank === true,
        regroup: extra.regroup === true,
        objective: extra.objective ?? null,
        maxDetachedPhases: cfg.maxDetachedRounds,
        ...(extra.allowFlank ? { flankMinAngleDegrees: cfg.flankMinAngleDegrees } : {}),
        breakdown: { ...breakdown, ...(extra.breakdown ?? {}) }
    });

    if (memberCount < 2) {
        // Deterministic individual fallback (issue: fewer than two
        // members ⇒ the configured individual preset handles the plan).
        return finish(null, "insufficient-members");
    }
    if (context.regroup === true) {
        return finish("regroup-fallback", "forced-regroup",
            { regroup: true, assignments: all("regroup") });
    }
    if (casualtyCount > 0) {
        return finish("regroup-fallback", "casualties",
            { regroup: true, assignments: all("regroup") });
    }
    if (pressure >= cfg.highThreatRatio) {
        return finish("regroup-fallback", "overwhelming-threat",
            { regroup: true, assignments: all("regroup") });
    }
    if (!enemyCount) {
        // No attackable contact: last-known/search objective or a bare
        // advance — covering advance keeps overwatch while moving.
        return finish("covering-advance",
            (targets ?? []).length ? "no-attackable-target" : "no-contacts",
            { assignments: _coveringAssignments(available) });
    }

    const planningCombat = combat ?? context.combat ?? null;
    const geometryContext = {
        ...context, scene: context.scene ?? scene ?? planningCombat?.scene, combat: planningCombat
    };
    const positioned = available.map(member => ({
        ...member,
        position: specOpsTokenCenter(_tokenDoc(member.combatant?.token),
            geometryContext.scene, member.position)
    }));
    const leader = positioned.find(m => m.combatantId === leaderId) ?? positioned[0];
    const objectivePos = _objectivePosition(objective, hostiles.map(target => ({
        ...target, ..._targetCenter(target, geometryContext)
    })));
    const walls = _wallsOf(geometryContext);
    const frontPos = leader.position ?? _centroid(positioned);
    const frontalBlocked = objectivePos && frontPos
        ? _wallsCrossed(frontPos, objectivePos, walls, "move") > 0
        : false;
    breakdown.frontalBlocked = frontalBlocked;
    breakdown.flank = { feasible: false };

    // Only propose flanking when there is a reason to maneuver. Actual
    // reachability and angle are checked against selected attack plans.
    const flank = context.allowFlank !== false && objectivePos
        && (enemyCount > memberCount || frontalBlocked)
        ? _flankOptions(positioned, leader.combatantId, frontPos, objectivePos, walls, cfg) : null;
    if (flank) {
        breakdown.flank = { side: flank.side, flankerId: flank.flanker.combatantId };
        const targetId = _objectiveTargetId(objective, hostiles);
        return finish("flank-and-fix",
            frontalBlocked ? "frontal-blocked-flank-open" : "outnumbered-flank-open",
            {
                allowFlank: true,
                assignments: _flankAssignments(positioned, leader, flank),
                objective: {
                    targetId,
                    flankTargetId: targetId,
                    flankSide: flank.side,
                    flankPoint: {
                        x: Math.round(flank.point.x * 1e2) / 1e2,
                        y: Math.round(flank.point.y * 1e2) / 1e2
                    }
                }
            });
    }
    if (enemyCount <= memberCount) {
        // Parity or superiority: a synchronized assault — unless the only
        // corridor is blocked and no flank route exists.
        if (frontalBlocked) {
            return finish("covering-advance", "frontal-blocked-no-flank",
                { assignments: _coveringAssignments(available) });
        }
        return finish("coordinated-assault",
            enemyCount < memberCount ? "superiority" : "parity",
            { assignments: all("assault") });
    }
    // Outnumbered below the regroup threshold with no flank route.
    return finish("covering-advance", "outnumbered-no-flank",
        { assignments: _coveringAssignments(available) });
}

/**
 * Default tactic factory passed to `fireteam.buildTeamPlan` as
 * `context.tactic` (auto-applied for `teamPreset === "specOps"`).
 * @param {object} input Selector input (see {@link selectSpecOpsTactic}).
 * @returns {object} Tactic descriptor.
 */
export function specOpsTactic(input = {}) {
    return selectSpecOpsTactic(input);
}

/**
 * Bind a tactic factory with explicit overrides for tests and macros.
 * @param {object} [config] `SpecOpsConfig` overrides.
 * @returns {Function} Tactic factory `(input) => descriptor`.
 */
export function createSpecOpsTactic(config = {}) {
    return input => selectSpecOpsTactic({ ...input, config });
}

/**
 * Preset veto: reject hidden targets, and for proposed flank assignments
 * rank only actual attacks that meet the angle and route requirements.
 * @param {object} input
 * @param {object} [input.candidate] Normalized candidate.
 * @param {object} [input.context] Member planning context.
 * @returns {string|null} Rejection reason or null when acceptable.
 */
export function specOpsVeto({ candidate = {}, context = {} } = {}) {
    const attack = ATTACK_VARIANTS.has(candidate.variant);
    if (context.team?.task === "flank" && Number.isFinite(context.team.flankMinAngleDegrees)) {
        return attack ? checkSpecOpsFlank(candidate, context).reason : "flank-attack-unavailable";
    }
    if (!attack) return null;
    const target = candidate.target;
    // A blast aim point on a last-known position is the deliberate
    // "room clearing" memory-strike — the planner only offers it when
    // every covered square stays clear of friendlies, so it survives
    // the hidden-target veto the preset otherwise demands.
    if (candidate.aim && target?.source === "last-known") return null;
    if (target?.source === "last-known" || target?.hidden === true) {
        return SPEC_OPS_VETO_HIDDEN_TARGET;
    }
    return null;
}

/**
 * Evaluate one planner candidate for the spec-ops preset. Inside a
 * fireteam the member's temporary task picks a weight overlay and may
 * add the `flankAngle`/`cohesionRestore` factors; outside a fireteam the
 * safe assault+hold hybrid applies (`team.reason: "no-fireteam"`).
 * @param {object} input Evaluation input from the planner.
 * @param {object} [input.factors] Factor vector (`SCORE_FACTORS`).
 * @param {object} [input.candidate] Scored candidate `{variant, target, move, action}`.
 * @param {object} [input.weights] Effective merged weights.
 * @param {object} [input.context] Planning context (`team`, `tactic`,
 *   `selfPos`, `specOpsConfig`).
 * @returns {{score: number, breakdown: object}}
 */
export function evaluateSpecOps({
    factors = {},
    candidate = {},
    weights = SPEC_OPS_WEIGHTS,
    context = {}
} = {}) {
    const task = typeof context.team?.task === "string"
        && SPEC_OPS_TASK_WEIGHTS[context.team.task]
        ? context.team.task
        : null;
    const cfg = task && context.specOpsConfig
        ? resolveSpecOpsConfig(context.specOpsConfig) : SPEC_OPS_CONFIG;
    const enriched = { ...factors };
    if (task === "flank") {
        const { angle } = _flankGeometry(candidate, context);
        const minAngle = context.team.flankMinAngleDegrees ?? cfg.flankMinAngleDegrees;
        enriched.flankAngle = Math.round(_clamp01(angle / minAngle) * 1e4) / 1e4;
        enriched.flankProgress = _flankProgress(candidate, context);
    }
    if (task === "regroup") {
        // Issue #24 review: `fanatic.ignoreRegroup` zeroes the regroup
        // pull structurally. The declared delta alone cannot do it —
        // the task overlay *replaces* the weight and the L3 bound
        // clamps any delta, so the flag is enforced on the factor.
        enriched.cohesionRestore = context.traitFlags?.ignoreRegroup === true
            ? 0
            : _cohesionRestore(candidate, context);
    }
    const overlay = task ? SPEC_OPS_TASK_WEIGHTS[task] : SPEC_OPS_SOLO_WEIGHTS;
    const effective = { ...weights, ...overlay };
    if (task === "support") effective.cover = cfg.supportWeight;
    if (task === "flank") effective.flankAngle = cfg.flankWeight;
    if (task === "assault") {
        effective.attackAfterMove = (cfg.assaultWeight / SPEC_OPS_CONFIG.assaultWeight) * overlay.attackAfterMove;
    }
    if (task === "regroup") effective.cohesionRestore = cfg.cohesionWeight;
    const evaluation = evaluateFactors(enriched, effective);
    return {
        score: evaluation.score,
        breakdown: {
            ...evaluation.breakdown,
            preset: SPEC_OPS_PRESET_ID,
            variant: candidate.variant ?? null,
            tactic: context.tactic ?? null,
            team: {
                mode: task ? "fireteam" : "solo",
                task: task ?? "solo",
                reason: task ? null : "no-fireteam",
                flankAngle: task === "flank" ? (enriched.flankAngle ?? 0) : null,
                flankProgress: task === "flank" ? (enriched.flankProgress ?? 0) : null,
                cohesionRestore: task === "regroup" ? (enriched.cohesionRestore ?? 0) : null
            }
        }
    };
}

/**
 * Build the planner `registerPreset` definition for the spec-ops preset.
 * `allowNoTarget`/`allowNoAction` let the preset hold or keep searching
 * instead of failing when contacts or weapons are missing.
 * @returns {object} Preset definition for `planner.registerPreset`.
 */
export function specOpsPresetDefinition() {
    return {
        weights: { ...SPEC_OPS_WEIGHTS },
        evaluate: evaluateSpecOps,
        veto: specOpsVeto,
        allowNoTarget: true,
        allowNoAction: true,
        // Smoke finding: spec-ops doctrine seeks contact — with zero
        // intel (no LOS, memory or relay) the squad's radio puts rough
        // unattackable approach markers on the nearest hostiles so the
        // operatives advance instead of idling.
        seekContacts: true
    };
}

/**
 * Register/replace the spec-ops preset on a planner service instance.
 * Called once on `init` after the planner service is created.
 * @param {object} planner Planner service (`api.services.get("planner")`).
 * @returns {object} The stored preset definition.
 */
export function registerSpecOpsPreset(planner) {
    if (!planner || typeof planner.registerPreset !== "function") {
        throw new Error("[only-war-ai] Spec-ops preset requires a planner service");
    }
    return planner.registerPreset(SPEC_OPS_PRESET_ID, specOpsPresetDefinition());
}

/**
 * Register the baseline spec-ops maneuver selector on a tactic registry
 * (issue #92). The selector remains the exact {@link specOpsTactic} factory:
 * the registry only supplies the deterministic per-preset dispatch point.
 * @param {object} tactics Tactic registry service.
 * @returns {object} The frozen registration record.
 */
export function registerSpecOpsTacticSelector(tactics) {
    if (!tactics || typeof tactics.registerTacticSelector !== "function") {
        throw new Error("[only-war-ai] Spec-ops tactic requires a tactic registry");
    }
    return tactics.registerTacticSelector({
        presetId: SPEC_OPS_PRESET_ID,
        kind: "maneuver",
        priority: DEFAULT_TACTIC_PRIORITY,
        select: specOpsTactic
    });
}

/**
 * Convenience wrapper (issue #412): build the shared TeamPlan for a
 * spec-ops fireteam through `fireteam.buildTeamPlan`. The default maneuver
 * comes from the tactic registry; explicit `context.tactic` keeps its
 * caller-override meaning. Without a fireteam service the caller should fall
 * back to an individual `planner.planTurn` — the solo preset behaviour keeps
 * the NPC functional (`no-fireteam` diagnostics).
 * @param {object|null} fireteam Fireteam service.
 * @param {object} combat Combat document.
 * @param {object|string} team Team reference (see `buildTeamPlan`).
 * @param {object} [context] `buildTeamPlan` context; `tactic` may
 *   override the registered spec-ops selector.
 * @returns {Promise<object>} `buildTeamPlan` result.
 */
export async function buildSpecOpsTeamPlan(fireteam, combat, team, context = {}) {
    if (!fireteam || typeof fireteam.buildTeamPlan !== "function") {
        return { status: "no-fireteam", reason: "no-fireteam", teamPlan: null };
    }
    return fireteam.buildTeamPlan(combat, team, {
        teamPreset: SPEC_OPS_PRESET_ID,
        ...context
    });
}
