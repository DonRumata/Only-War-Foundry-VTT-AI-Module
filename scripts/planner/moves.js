/**
 * Planner decomposition (issue #403 follow-up): this module was extracted
 * verbatim from scripts/planner.js — see that file for the design contract.
 * The planner service re-exports the public surface so existing importers
 * and tests keep working.
 */
import {
    DEFAULT_MOVE_CANDIDATES
} from "./contract.js";
import {
    _finiteOr,
    _jsonClone,
    _pixelDistance
} from "./util.js";


/**
 * Normalize a movement candidate to the internal move shape.
 * @param {object} raw
 * @param {object} input Normalization context.
 * @param {object} input.selfPos Self position `{x, y}` in pixels.
 * @param {object} input.targetPos Target position `{x, y}` in pixels.
 * @param {object} input.grid Normalized grid info.
 * @param {boolean} [input.stay] Force the stay-in-place flag.
 * @returns {object|null}
 */
export function _normalizeMove(raw, { selfPos, targetPos, grid, stay = false }) {
    if (!raw || typeof raw !== "object") return null;
    const x = _finiteOr(raw.x, null);
    const y = _finiteOr(raw.y, null);
    if (x === null || y === null) return null;
    const distance = Number.isFinite(raw.distance)
        ? raw.distance
        : _pixelDistance({ x, y }, targetPos, grid);
    const moved = !(x === selfPos.x && y === selfPos.y);
    return {
        key: raw.key ?? `${_finiteOr(raw.i, "?")},${_finiteOr(raw.j, "?")}@${x},${y}`,
        x,
        y,
        i: _finiteOr(raw.i, null),
        j: _finiteOr(raw.j, null),
        cost: _finiteOr(raw.cost, 0),
        costCells: _finiteOr(raw.costCells, null),
        distance,
        pathProgress: _finiteOr(raw.pathProgress, null),
        // `los` keeps tri-state: `true` the endpoint sees the target,
        // `false` a wall check proved it hidden, `null` unprobed — the
        // seek variant filters on an explicit `false`.
        los: raw.los === true ? true : (raw.los === false ? false : null),
        cover: Number.isFinite(raw.cover) ? raw.cover : 0,
        approximate: raw.approximate === true,
        stay: stay || !moved,
        waypoints: Array.isArray(raw.waypoints) ? _jsonClone(raw.waypoints) : null
    };
}

/**
 * Get the affordable prefix of a known wall detour, not a speculative
 * move toward an endpoint that merely looks closer across the wall.
 * @param {object} input
 * @param {object} input.navigation
 * @param {object} input.tokenDoc
 * @param {object} input.selfPos
 * @param {object} input.targetPos
 * @param {object} input.grid
 * @param {number} input.budget Scene units.
 * @returns {object|null}
 */
export function _resolveDetour({ navigation, tokenDoc, selfPos, targetPos, grid, budget }) {
    try {
        const route = navigation?.planRoute?.(tokenDoc, targetPos, budget, { followDetour: true });
        if (!(route?.pathProgress > 0) || !(route.waypoints?.length > 1)) return null;
        return _normalizeMove({
            ...route.endpoint,
            cost: route.cost,
            costCells: route.costCells,
            los: route.los,
            cover: route.cover,
            pathProgress: route.pathProgress,
            waypoints: route.waypoints
        }, { selfPos, targetPos, grid });
    } catch(_err) {
        return null;
    }
}


/**
 * Straight-line approach point used when no navigation service can route:
 * the position at `range` scene units from the target toward the viewer.
 * @param {object} selfPos
 * @param {object} target
 * @param {number} range Scene units.
 * @param {object} grid
 * @returns {object|null}
 */
export function _approachPoint(selfPos, target, range, grid) {
    if (!Number.isFinite(selfPos?.x) || !Number.isFinite(target?.x)) return null;
    const size = Number.isFinite(grid?.size) && grid.size > 0 ? grid.size : 100;
    const unit = Number.isFinite(grid?.distance) && grid.distance > 0 ? grid.distance : 1;
    const dx = selfPos.x - target.x;
    const dy = selfPos.y - target.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= 0) return null;
    const desired = Math.max(range * (size / unit) * 0.9, 1);
    return {
        x: target.x + ((dx / dist) * desired),
        y: target.y + ((dy / dist) * desired)
    };
}


/**
 * Resolve movement candidates for one target: injected `context.moves`,
 * the navigation service `findCandidates`, or the stay-in-place +
 * straight-approach fallback.
 * @param {object} input Resolution context.
 * @param {object|null} input.tokenDoc Viewer token document.
 * @param {object} input.target Normalized target entry.
 * @param {number} input.range Attack range in scene units.
 * @param {number|null} [input.bandRange] Farthest weapon range in scene
 *   units — drives the edge probe; falls back to `range` when unset.
 * @param {object} input.selfPos Self position `{x, y}` in pixels.
 * @param {object} input.targetPos Target position `{x, y}` in pixels.
 * @param {object} input.grid Normalized grid info.
 * @param {object|null} input.navigation Navigation service or null.
 * @param {object|null} input.perception Perception service or null.
 * @param {object} input.context Planning context overrides.
 * @returns {object[]}
 */
export function _resolveMoves({ tokenDoc, target, range, bandRange = null,
    selfPos, targetPos, grid, navigation, perception, context }) {
    const input = { selfPos, targetPos, grid };
    let raw = null;
    if (Array.isArray(context.moves)) {
        raw = context.moves;
    } else if (navigation && typeof navigation.findCandidates === "function") {
        const find = options => {
            try {
                const result = navigation.findCandidates(tokenDoc,
                    context.moveBudget ?? { mode: "full" },
                    {
                        count: _finiteOr(context.moveCandidateCount, DEFAULT_MOVE_CANDIDATES),
                        includeCover: true,
                        perception,
                        rates: context.rates,
                        ...options
                    });
                return result && result.status === "ok" && Array.isArray(result.candidates)
                    ? result.candidates : [];
            } catch(err) {
                return [];
            }
        };
        // Copy — the navigation result is deep-frozen and the band merge
        // below pushes extra candidates.
        raw = [...find({ target: targetPos })];
        // Issue #31: move-attack is capped at the half-move rate, so the
        // candidate set also needs cheap cells at the weapon's range edge —
        // the proximity-ranked top-N only ever holds the cells nearest the
        // target, which all cost more than a half move on long approaches.
        // Probe a point `0.9 × range` from the target toward the viewer:
        // cells close to it are both reachable on a half move and already
        // inside firing distance.
        const band = Number.isFinite(bandRange) && bandRange > 0 ? bandRange : range;
        if (Number.isFinite(band) && band > 0
            && Number.isFinite(target?.distance) && target.distance > band) {
            const edge = _approachPoint(selfPos, target, band, grid);
            if (edge) {
                const seen = new Set(raw.map(entry =>
                    `${_finiteOr(entry?.i, null)}|${_finiteOr(entry?.j, null)}`));
                for (const entry of find({ target: edge })) {
                    const key = `${_finiteOr(entry?.i, null)}|${_finiteOr(entry?.j, null)}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    // `distance` was scored against the edge probe —
                    // `_normalizeMove` must recompute it against the real
                    // target so the range filter sees the true value.
                    raw.push({ ...entry, distance: null });
                }
            }
        }
        // Spec-ops flank task: the maneuver anchor is the team's
        // `flankPoint`, not the attack target — merge cells on the way
        // to it or the flanker never sees a route off the frontal axis.
        const flankPoint = context.team?.task === "flank"
            ? context.team?.flankPoint : null;
        if (Number.isFinite(flankPoint?.x) && Number.isFinite(flankPoint?.y)) {
            const seen = new Set(raw.map(entry =>
                `${_finiteOr(entry?.i, null)}|${_finiteOr(entry?.j, null)}`));
            for (const entry of find({ target: flankPoint })) {
                const key = `${_finiteOr(entry?.i, null)}|${_finiteOr(entry?.j, null)}`;
                if (seen.has(key)) continue;
                seen.add(key);
                raw.push({ ...entry, distance: null });
            }
        }
    }
    if (raw === null) {
        // Fallback without navigation: staying put plus a straight-line
        // approach point when the target is out of reach.
        raw = [{ x: selfPos.x, y: selfPos.y, i: null, j: null, cost: 0 }];
        if (context.approximateMoves !== false && Number.isFinite(range) && range > 0) {
            const approach = _approachPoint(selfPos, target, range, grid);
            if (approach && Number.isFinite(target.distance) && target.distance > range) {
                raw.push({ ...approach, approximate: true });
            }
        }
    }
    const stay = _normalizeMove({ x: selfPos.x, y: selfPos.y, cost: 0, key: "stay" },
        { ...input, stay: true });
    const moves = raw
        .map(entry => {
            const move = _normalizeMove(entry, input);
            // Injected moves may arrive without a cover estimate; compute
            // it through the navigation service so scoring sees the same
            // data findCandidates would have produced.
            if (move && !Number.isFinite(entry?.cover)
                && navigation && typeof navigation.coverEstimate === "function") {
                try {
                    const estimate = navigation.coverEstimate(tokenDoc,
                        { x: move.x, y: move.y }, targetPos);
                    if (Number.isFinite(estimate)) move.cover = estimate;
                } catch(_err) {
                    // Cover stays 0.
                }
            }
            return move;
        })
        .filter(Boolean);
    if (stay && !moves.some(move => move.stay)) moves.unshift(stay);
    return moves
        .sort((a, b) => (_finiteOr(a.distance, Infinity) - _finiteOr(b.distance, Infinity))
            || String(a.key).localeCompare(String(b.key)));
}
