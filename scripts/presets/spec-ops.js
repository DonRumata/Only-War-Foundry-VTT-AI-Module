/**
 * Spec-ops preset — «Спецназ» (issue #412, epic #363).
 *
 * Behaviour contract:
 * - The preset is *team tactics on top of the fireteam service* (#408):
 *   inside a fireteam (`context.team` injected by `buildTeamPlan`) each
 *   member's individual evaluation is biased by its temporary task
 *   (`support`/`advance`/`flank`/`assault`/`regroup`); the shared TeamPlan
 *   itself is assembled by `fireteam.buildTeamPlan` fed with the
 *   deterministic tactic factory {@link specOpsTactic} (or
 *   {@link selectSpecOpsTactic} via `context.tactic`).
 * - The tactic selector is a pure, deterministic situation assessment:
 *   member count, attackable contacts, casualties, threat pressure and
 *   flank geometry (perpendicular maneuver points, wall-blocked sides,
 *   minimum attack angle `flankMinAngleDegrees`). It returns a
 *   serializable descriptor `{name, reason, assignments, allowFlank,
 *   regroup, objective, maxDetachedPhases, breakdown}`.
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
    if (!Number.isFinite(a?.x) || !Number.isFinite(a?.y)
        || !Number.isFinite(b?.x) || !Number.isFinite(b?.y)) {
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
    const m1 = Math.hypot(v1.x, v1.y);
    const m2 = Math.hypot(v2.x, v2.y);
    if (!(m1 > 0) || !(m2 > 0)) return null;
    const dot = ((v1.x * v2.x) + (v1.y * v2.y)) / (m1 * m2);
    return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
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
 * `flankAngle` factor: the angle at the target between the team's
 * frontal approach (`context.team.center → target`) and the candidate's
 * attack vector (`endpoint → target`), normalized by
 * `flankMinAngleDegrees`. 1 = fully off-axis flank shot.
 * @param {object} candidate
 * @param {object} context
 * @param {number} minAngleDeg
 * @returns {number}
 */
function _flankAngle(candidate, context, minAngleDeg) {
    const center = context.team?.center ?? context.teamCenter ?? null;
    const target = candidate?.target ?? null;
    const endpoint = _candidateEndpoint(candidate, context);
    const min = Number.isFinite(minAngleDeg) && minAngleDeg > 0 ? minAngleDeg : 60;
    if (!center || !target || !endpoint) return 0;
    const deg = _angleBetweenDeg(
        { x: target.x - center.x, y: target.y - center.y },
        { x: target.x - endpoint.x, y: target.y - endpoint.y });
    if (!Number.isFinite(deg)) return 0;
    return Math.round(_clamp01(deg / min) * 1e4) / 1e4;
}

/**
 * `cohesionRestore` factor: how much closer the candidate endpoint lands
 * to the regroup/rejoin point (`context.team.regroupPoint`, falling back
 * to the team centre) relative to the current position.
 * @param {object} candidate
 * @param {object} context
 * @returns {number}
 */
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
    const self = context.selfPos;
    const endpoint = _candidateEndpoint(candidate, context);
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
 * Evaluate the two perpendicular flank options around the objective.
 * Each side gets a maneuver point at `max(100, dist/2)` px off the
 * frontal bearing; a side is usable when its maneuver point keeps a
 * `flankMinAngleDegrees` attack angle and the nearest non-leader flanker
 * can reach it without crossing a move-blocking wall ("one corridor"
 * maps reject both sides).
 * @param {object[]} members
 * @param {string|null} leaderId
 * @param {{x: number, y: number}} objectivePos
 * @param {object[]} walls
 * @param {object} cfg Resolved spec-ops config.
 * @returns {{feasible: boolean, options: object[], best: object|null}}
 */
function _flankOptions(members, leaderId, objectivePos, walls, cfg) {
    const none = { feasible: false, options: [], best: null };
    const centroid = _centroid(members);
    if (!centroid) return none;
    const front = { x: objectivePos.x - centroid.x, y: objectivePos.y - centroid.y };
    const dist = Math.hypot(front.x, front.y);
    if (!(dist > 0)) return none;
    const unit = { x: front.x / dist, y: front.y / dist };
    const perp = { x: -unit.y, y: unit.x };
    const offset = Math.max(100, dist * 0.5);
    const sides = [
        { side: "left", point: { x: objectivePos.x + (perp.x * offset), y: objectivePos.y + (perp.y * offset) } },
        { side: "right", point: { x: objectivePos.x - (perp.x * offset), y: objectivePos.y - (perp.y * offset) } }
    ];
    const pool = members.filter(m => m.combatantId !== leaderId);
    const options = [];
    for (const entry of sides) {
        let best = null;
        for (const member of pool) {
            const pos = member.position;
            if (!Number.isFinite(pos?.x) || !Number.isFinite(pos?.y)) continue;
            const loadout = _loadout(member);
            // Capability bias: melee/short-range members flank; travel
            // distance decides otherwise, combatant id breaks ties.
            const travel = _dist(pos, entry.point)
                + (loadout.melee ? -50 : 0)
                + (loadout.bestRange > 0 && loadout.bestRange <= 5 ? -25 : 0);
            if (!best || travel < best.travel
                || (travel === best.travel
                    && String(member.combatantId) < String(best.member.combatantId))) {
                best = { member, travel };
            }
        }
        if (!best) continue;
        const blocked = _wallsCrossed(best.member.position, entry.point, walls, "move") > 0;
        const angle = _angleBetweenDeg(
            { x: objectivePos.x - centroid.x, y: objectivePos.y - centroid.y },
            { x: objectivePos.x - entry.point.x, y: objectivePos.y - entry.point.y });
        options.push({
            side: entry.side,
            point: entry.point,
            flanker: best.member,
            travel: Math.round(best.travel * 1e4) / 1e4,
            blocked,
            angle: Number.isFinite(angle) ? Math.round(angle * 10) / 10 : null
        });
    }
    const minAngle = Number.isFinite(cfg.flankMinAngleDegrees)
        ? cfg.flankMinAngleDegrees : 60;
    const open = options
        .filter(o => !o.blocked && Number.isFinite(o.angle) && o.angle >= minAngle)
        .sort((a, b) => (a.travel - b.travel) || a.side.localeCompare(b.side));
    return { feasible: open.length > 0, options, best: open[0] ?? null };
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

    const leader = available.find(m => m.combatantId === leaderId) ?? available[0];
    const objectivePos = _objectivePosition(objective, hostiles);
    const walls = _wallsOf(context);
    const frontPos = leader?.position ?? _centroid(available);
    const frontalBlocked = objectivePos && frontPos
        ? _wallsCrossed(frontPos, objectivePos, walls, "move") > 0
        : false;
    const flank = objectivePos
        ? _flankOptions(available, leader?.combatantId ?? null, objectivePos, walls, cfg)
        : { feasible: false, options: [], best: null };
    breakdown.frontalBlocked = frontalBlocked;
    breakdown.flank = flank.feasible
        ? {
            side: flank.best.side,
            angle: flank.best.angle,
            flankerId: flank.best.flanker.combatantId
        }
        : { feasible: false };

    // Flank-and-fix needs an open side *and* a reason to maneuver: the
    // frontal approach is blocked or the team is outnumbered.
    if (flank.feasible && (enemyCount > memberCount || frontalBlocked)) {
        const targetId = _objectiveTargetId(objective, hostiles);
        return finish("flank-and-fix",
            frontalBlocked ? "frontal-blocked-flank-open" : "outnumbered-flank-open",
            {
                allowFlank: true,
                assignments: _flankAssignments(available, leader, flank.best),
                objective: {
                    targetId,
                    flankTargetId: targetId,
                    flankSide: flank.best.side,
                    flankPoint: {
                        x: Math.round(flank.best.point.x * 1e2) / 1e2,
                        y: Math.round(flank.best.point.y * 1e2) / 1e2
                    }
                }
            });
    }
    if (enemyCount <= memberCount) {
        // Parity or superiority: a synchronized assault — unless the only
        // corridor is blocked and no flank route exists.
        if (frontalBlocked && !flank.feasible) {
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
 * Preset veto predicate (planner contract, issue #412): attack variants
 * aimed at a hidden or last-known contact are rejected — spec ops never
 * fires on a target it cannot legally attack.
 * @param {object} input
 * @param {object} [input.candidate] Normalized candidate.
 * @returns {string|null} Rejection reason or null when acceptable.
 */
export function specOpsVeto({ candidate = {} } = {}) {
    if (!ATTACK_VARIANTS.has(candidate.variant)) return null;
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
        enriched.flankAngle = _flankAngle(candidate, context, cfg.flankMinAngleDegrees);
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
 * Convenience wrapper (issue #412): build the shared TeamPlan for a
 * spec-ops fireteam through `fireteam.buildTeamPlan` with the spec-ops
 * tactic factory. Without a fireteam service the caller should fall back
 * to an individual `planner.planTurn` — the solo preset behaviour keeps
 * the NPC functional (`no-fireteam` diagnostics).
 * @param {object|null} fireteam Fireteam service.
 * @param {object} combat Combat document.
 * @param {object|string} team Team reference (see `buildTeamPlan`).
 * @param {object} [context] `buildTeamPlan` context; `tactic` may
 *   override the default spec-ops factory.
 * @returns {Promise<object>} `buildTeamPlan` result.
 */
export async function buildSpecOpsTeamPlan(fireteam, combat, team, context = {}) {
    if (!fireteam || typeof fireteam.buildTeamPlan !== "function") {
        return { status: "no-fireteam", reason: "no-fireteam", teamPlan: null };
    }
    return fireteam.buildTeamPlan(combat, team, {
        teamPreset: SPEC_OPS_PRESET_ID,
        ...context,
        tactic: context.tactic !== undefined ? context.tactic : specOpsTactic
    });
}
