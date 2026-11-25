/**
 * Shared chokepoint-defense lane helpers (issue #91).
 *
 * The functions in this module are pure DTO helpers: they read the
 * serializable TeamPlan/member-context contract, never documents, never
 * mutate their inputs and never persist state. The lane object is the
 * compact lane descriptor emitted by `presets/chokepoint-defense.js`.
 */
import {
    _actionRange,
    _isMeleeAction
} from "../planner/actions.js";
import {
    _distPx,
    _finiteOr
} from "../planner/util.js";

/**
 * Normalize a finite point to the compact `{x,y}` channel used in plans.
 * @param {object|null} point
 * @returns {{x:number,y:number}|null}
 */
export function lanePointOf(point) {
    return Number.isFinite(point?.x) && Number.isFinite(point?.y)
        ? { x: point.x, y: point.y }
        : null;
}

/**
 * Compact serializable lane metadata riding an overwatch step/commitment.
 * Threat ids are part of the deterministic lane identity inputs but are
 * deliberately not copied into every step — the step only needs geometry
 * for sticky replay and GM diagnostics.
 * @param {object|null} lane
 * @returns {object|null}
 */
export function compactLaneMetadata(lane) {
    if (!lane || typeof lane !== "object") return null;
    const chokepoint = lanePointOf(lane.chokepoint ?? lane.lanePoint);
    if (!chokepoint) return null;
    const post = lanePointOf(lane.post);
    return {
        id: lane.id ?? lane.laneId ?? null,
        bearingDeg: Number.isFinite(lane.bearingDeg) ? lane.bearingDeg : null,
        chokepoint,
        ...(post ? { post } : {})
    };
}

/**
 * Resolve the member's assigned defense lane from the TeamPlan context.
 * Precedence: explicit `team.defense.lane`, then the lane matching the
 * member objective inside the shared defense objective, then the compact
 * member objective itself. Foreign/non-defense objectives return null.
 * @param {object} context Planner context.
 * @returns {object|null} Normalized lane `{id,chokepoint,post,threatIds,...}`.
 */
export function defenseLaneOf(context = {}) {
    const team = context.team ?? {};
    const memberObjective = team.memberObjective ?? null;
    if (memberObjective && memberObjective.type !== "defend") return null;
    const defenseObjective = team.defenseObjective ?? context.defenseObjective ?? null;
    if (defenseObjective && defenseObjective.type !== "defend") return null;
    const laneId = memberObjective?.laneId ?? team.defense?.laneId ?? null;
    let lane = lanePointOf(team.defense?.lane?.chokepoint ?? team.defense?.lane?.lanePoint)
        ? team.defense.lane : null;
    if (!lane && laneId != null && Array.isArray(defenseObjective?.lanes)) {
        lane = defenseObjective.lanes.find(entry =>
            entry && String(entry.id) === String(laneId)) ?? null;
    }
    if (!lane && memberObjective?.lanePoint) {
        lane = {
            id: laneId,
            chokepoint: memberObjective.lanePoint,
            post: memberObjective.post ?? null,
            threatIds: []
        };
    }
    const chokepoint = lanePointOf(lane?.chokepoint ?? lane?.lanePoint);
    if (!chokepoint) return null;
    return {
        ...lane,
        id: lane?.id ?? laneId ?? null,
        chokepoint,
        post: lanePointOf(lane?.post) ?? chokepoint,
        threatIds: Array.isArray(lane?.threatIds) ? [...lane.threatIds] : [],
        anchor: lane?.anchor ?? defenseObjective?.anchor ?? team.defense?.anchor ?? null
    };
}

/**
 * Whether a normalized target belongs to the lane threat filter. An
 * empty/unknown lane threat list is open — the lane geometry itself is
 * then the only orientation evidence.
 * @param {object|null} target
 * @param {object|null} lane
 * @returns {boolean}
 */
export function laneIncludesTarget(target, lane) {
    const ids = new Set((lane?.threatIds ?? []).map(String));
    if (!ids.size) return true;
    return [target?.tokenId, target?.tokenUuid, target?.actorId]
        .filter(id => id !== null && id !== undefined)
        .some(id => ids.has(String(id)));
}

/**
 * Scene-unit distance between two pixel points.
 * @param {object|null} a
 * @param {object|null} b
 * @param {object|null} grid `{size,distance}`.
 * @returns {number}
 */
export function distanceUnits(a, b, grid) {
    const px = _distPx(a, b);
    const size = _finiteOr(grid?.size, 0);
    const unit = _finiteOr(grid?.distance, 0);
    return size > 0 && unit > 0 ? px / size * unit : px;
}

/**
 * Lane-coverage score of one candidate endpoint (issue #91):
 * `clamp(0.75 × coverScore + 0.25 × postScore, 0, 1)`, where coverScore is
 * 1 for a proven lane LOS inside the best overwatch/ranged weapon range,
 * 0.5 when LOS is unknown and 0 when impossible/out of range; postScore
 * falls linearly to zero three metres away from the assigned post.
 *
 * This is deliberately a soft positioning factor: overwatch is a full
 * action, so the planner cannot honestly reposition and declare in the
 * same turn. Candidates move toward good future posts while stationary
 * overwatch remains the declare-only action.
 * @param {object} input
 * @param {object|null} input.move Candidate move (`null` = stationary).
 * @param {object|null} input.selfPos Current self position in pixels.
 * @param {object} input.context Planner context.
 * @param {object[]} [input.actions] Normalized usable actions.
 * @param {object|null} input.tokenDoc Viewer token document for LOS.
 * @param {object|null} input.perception Perception service.
 * @param {object|null} input.grid Grid metadata `{size,distance}`.
 * @returns {number} 0..1.
 */
export function laneCoverageScore({ move = null, selfPos = null, context = {},
    actions = [], tokenDoc = null, perception = null, grid = null } = {}) {
    const lane = defenseLaneOf(context);
    if (!lane) return 0;
    const endpoint = lanePointOf(move) ?? lanePointOf(selfPos);
    if (!endpoint) return 0;
    const effectiveGrid = grid ?? context.grid ?? context.scene?.grid ?? null;
    const rangeM = (actions ?? []).reduce((best, action) => {
        if (action?.type !== "attack" || _isMeleeAction(action)) return best;
        return Math.max(best, _actionRange(action));
    }, 0);
    const chokepointDistance = distanceUnits(endpoint, lane.chokepoint, effectiveGrid);
    let los = null;
    if (perception && typeof perception.hasLineOfSight === "function" && tokenDoc) {
        try {
            los = perception.hasLineOfSight(tokenDoc, lane.chokepoint) === true;
        } catch(err) {
            los = null;
        }
    }
    let coverScore;
    if (los === false) coverScore = 0;
    else if (rangeM > 0 && chokepointDistance <= rangeM + 1e-9) {
        // Unknown LOS stays the honest middle value; proven LOS earns the
        // full value. In-range geometry without a usable ranged weapon is
        // impossible rather than useful.
        coverScore = los === true ? 1 : 0.5;
    } else {
        coverScore = 0;
    }
    const postDistance = distanceUnits(endpoint, lane.post, effectiveGrid);
    const postScore = Math.max(0, 1 - (postDistance / 3));
    return Math.max(0, Math.min(1, (0.75 * coverScore) + (0.25 * postScore)));
}
