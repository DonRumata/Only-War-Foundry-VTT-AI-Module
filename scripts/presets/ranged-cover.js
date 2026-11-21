/**
 * Ranged-with-cover preset «Дальний бой с поиском укрытия»
 * (issue #405, epic #363).
 *
 * Behaviour contract:
 * - The plan is a firing-position problem, not a chase: for every planner
 *   candidate the evaluator resolves LOS, cover and a weapon range band
 *   for the candidate's endpoint (or the current position for
 *   `attack-in-place`) and lets the data-driven weights pick the maximum.
 * - LOS is layered: the navigation adapter verdict (`move.los`, from
 *   `findCandidates(..., {includeCover, perception})`) wins, then
 *   `perception.hasLineOfSight`, then a geometric fallback that tests
 *   whether the segment endpoint → target crosses a sight-blocking wall.
 *   When nothing can decide, the planner's own `los` factor stands and a
 *   non-last-known contact is presumed observable.
 * - Cover is `max(move.cover, geometric)` where the geometric fallback
 *   counts sight- or move-blocking walls crossed by the segment
 *   endpoint → nearest hostile (`0.5` per wall, capped at `1`). It is an
 *   approximation of the adapter contract — true partial cover needs the
 *   navigation service's multi-probe sampling.
 * - `rangeBand` rewards landing inside the effective zone of the active
 *   weapon: point-blank-ish distances and the outer third of the range
 *   are discounted (`weapon.range` from the normalized action).
 * - `rangedCoverVeto` rejects attack candidates with positively blocked
 *   LOS (`no-line-of-sight`), so the preset never produces a shot it
 *   cannot take: it repositions to an endpoint with LOS or, failing
 *   that, advances/holds instead of firing blind.
 * - A sufficient current position (LOS + workable band) wins through
 *   `attackNow`/`holdPosition`; a covered endpoint can still beat an
 *   exposed stay because `cover`/`exposure` dominate the move cost.
 *   Melee and charges are nearly disallowed, so a ranged-only NPC falls
 *   back to approach/hold with a reason instead of brawling, and
 *   last-known contacts stay search moves.
 * - `aimOpportunity` gives a small bonus to attack-in-place when an aim
 *   action exists in the action list (staying grants the aim action;
 *   moving spends it). The planner step contract has no composite
 *   aim+attack step, so the bonus is advisory — flagged in the breakdown.
 *
 * The preset is pure data (weights) plus a deterministic evaluator and a
 * veto predicate; candidate legality, bounded enumeration and seed
 * tie-breaking live in the planner.
 */
import { evaluateFactors } from "../planner.js";

/** Preset id registered in the planner preset registry. */
export const RANGED_COVER_PRESET_ID = "rangedCover";

/** Rejection reason produced by {@link rangedCoverVeto}. */
export const RANGED_COVER_VETO_NO_LOS = "no-line-of-sight";

/**
 * Data-driven weights for the ranged-cover preset. Names match
 * `SCORE_FACTORS` in `scripts/planner.js` plus the preset-only factors
 * `rangeBand` and `aimOpportunity` computed by
 * {@link evaluateRangedCover}; missing factors contribute 0.
 */
export const RANGED_COVER_WEIGHTS = Object.freeze({
    attackNow: 10,
    attackAfterMove: 7,
    charge: -6,
    melee: -12,
    advance: 0.5,
    threat: 3,
    proximity: 0.5,
    los: 6,
    cover: 8,
    exposure: -3,
    holdPosition: 2,
    lastKnown: 1,
    budgetOver: -8,
    rangeBand: 6,
    aimOpportunity: 1.5,
    attackType: 0.1,
    vulnerable: 0.5,
    meleeEngage: 2,
    area: 3,
    aim: 0.5,
    aimAlone: 1.5,
    reload: 3,
    overwatch: 2,
    // Issue #16: the preset's whole doctrine is staying out of kill lanes.
    danger: -3,
    // Issue #37: dropping prone is this doctrine's free-action answer to
    // suppression fire; signature weapons and readying a backup still pay.
    weaponAffinity: 1,
    weaponInertia: 0.15,
    dropProne: 1.5,
    readyWeapon: 2
});

/** Candidate variants whose action produces an attack/test step. */
const ATTACK_VARIANTS = new Set([
    "attack-in-place", "move-attack", "charge", "aim-attack"
]);

/** Cover granted per blocking wall crossed, capped at {@link MAX_COVER}. */
const COVER_PER_WALL = 0.5;

/** Maximum geometric cover score. */
const MAX_COVER = 1;

/** Share of weapon range below which a shot counts as "too close". */
const POINT_BLANK_SHARE = 0.1;

/** Share of weapon range up to which a shot counts as optimal. */
const OPTIMAL_SHARE = 0.6;

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
 * Whether an action candidate is a melee attack (mirrors the planner's
 * normalization: `melee` flag, charge mode or `class: "melee"`).
 * @param {object|null} action
 * @returns {boolean}
 */
function _isMeleeAction(action) {
    return action?.melee === true
        || action?.charge === true
        || String(action?.mode ?? "").toLowerCase() === "charge"
        || String(action?.class ?? "").toLowerCase() === "melee";
}

/**
 * Attack range of an action spec in scene units; melee falls back to the
 * planner's reach default.
 * @param {object|null} action
 * @returns {number}
 */
function _actionRange(action) {
    const raw = action?.range;
    const value = Number.isFinite(raw) ? raw : _finiteOr(raw?.value, NaN);
    if (Number.isFinite(value) && value > 0) return value;
    return _isMeleeAction(action) ? 2 : 0;
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
 * Open doors never block. Mirrors the navigation service's `wallBlocks`.
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
 * Wall documents relevant for LOS/cover probes: injected `context.walls`
 * first, then the planning scene's wall collection (`context.scene`,
 * falling back to the active canvas scene).
 * @param {object} context Planning context.
 * @returns {object[]}
 */
function _wallsOf(context = {}) {
    if (Array.isArray(context.walls)) {
        return context.walls.map(_wallDoc).filter(Boolean);
    }
    const scene = context.scene ?? globalThis.canvas?.scene ?? null;
    return _list(scene?.walls).map(_wallDoc).filter(Boolean);
}

/**
 * Count walls of `senses` ("sight", "move") crossed by `from → to`.
 * @param {{x: number, y: number}|null} from
 * @param {{x: number, y: number}|null} to
 * @param {object[]} walls Wall documents.
 * @param {string[]} senses
 * @returns {number} Crossed blocking-wall count (0 when endpoints are
 *   incomplete).
 */
function _crossingCount(from, to, walls, senses) {
    if (!Number.isFinite(from?.x) || !Number.isFinite(from?.y)
        || !Number.isFinite(to?.x) || !Number.isFinite(to?.y)) return 0;
    let count = 0;
    for (const doc of walls) {
        if (!senses.some(sense => _wallBlocks(doc, sense))) continue;
        const segment = _wallSegment(doc);
        if (segment && _segmentsIntersect(from, to, segment.A, segment.B)) count += 1;
    }
    return count;
}

/**
 * Current position of the AI token in pixels: `context.selfPos` or the
 * injected `context.token` document.
 * @param {object} context
 * @returns {{x: number, y: number}|null}
 */
function _selfPos(context = {}) {
    const raw = context.selfPos ?? context.position ?? null;
    if (Number.isFinite(raw?.x) && Number.isFinite(raw?.y)) return { x: raw.x, y: raw.y };
    const doc = context.token?.document ?? context.token ?? null;
    const docX = doc?._source?.x ?? doc?.x;
    const docY = doc?._source?.y ?? doc?.y;
    if (Number.isFinite(docX) && Number.isFinite(docY)) {
        return _centerOf({ ...doc, x: docX, y: docY }, context);
    }
    return null;
}

/**
 * Endpoint evaluated for a candidate: the move destination, or the
 * current position for stay/attack-in-place variants.
 * @param {object} candidate
 * @param {object} context
 * @returns {{x: number, y: number}|null}
 */
function _candidatePoint(candidate = {}, context = {}) {
    const move = candidate.move;
    if (move && Number.isFinite(move.x) && Number.isFinite(move.y)) {
        return { x: move.x, y: move.y };
    }
    return _selfPos(context);
}

/**
 * Centre point of a token-like target entry. Planner targets carry the
 * top-left document position; LOS/cover probes must aim at the token
 * centre, not its corner.
 * @param {object|null} entry
 * @param {object} context
 * @returns {{x: number, y: number}|null}
 */
function _centerOf(entry = {}, context = {}) {
    if (Number.isFinite(entry?.center?.x) && Number.isFinite(entry?.center?.y)) {
        return { x: entry.center.x, y: entry.center.y };
    }
    const x = _finiteOr(entry?.x, NaN);
    const y = _finiteOr(entry?.y, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const size = _finiteOr(context?.grid?.size,
        _finiteOr(globalThis.canvas?.scene?.grid?.size, 100));
    const halfW = (size * _finiteOr(entry?.width ?? entry?.w, 1)) / 2;
    const halfH = (size * _finiteOr(entry?.height ?? entry?.h, 1)) / 2;
    return { x: x + halfW, y: y + halfH };
}

/**
 * The nearest hostile threat to a point: the closest entry of the
 * context's target list — injected `context.targets`, else the planner's
 * resolved `context.resolvedTargets` (stable first-wins order) — or the
 * candidate's own target when no list is available.
 * @param {object} candidate
 * @param {object} context
 * @param {{x: number, y: number}|null} from
 * @returns {{x: number, y: number}|null}
 */
function _threatPoint(candidate = {}, context = {}, from = null) {
    const pool = Array.isArray(context.targets) && context.targets.length
        ? context.targets
        : (Array.isArray(context.resolvedTargets) ? context.resolvedTargets : []);
    let best = null;
    let bestDistance = Infinity;
    for (const entry of pool) {
        const center = _centerOf(entry, context);
        if (!center) continue;
        const distance = from ? Math.hypot(center.x - from.x, center.y - from.y) : 0;
        if (distance < bestDistance) {
            bestDistance = distance;
            best = center;
        }
    }
    if (best) return best;
    return _centerOf(candidate.target ?? null, context);
}

/**
 * Resolve LOS from a point to the candidate target.
 * `null` means "undetermined" — the caller keeps the planner's factor.
 * @param {object} input
 * @param {{x: number, y: number}|null} input.from
 * @param {{x: number, y: number}|null} input.to
 * @param {object|null} input.move Normalized move candidate, if any.
 * @param {object} input.context Planning context.
 * @param {object[]} input.walls Wall documents.
 * @returns {boolean|null}
 */
function _losAt({ from, to, move, context, walls }) {
    if (move?.los === true) return true;
    const perception = context?.perception;
    if (typeof perception?.hasLineOfSight === "function"
        && Number.isFinite(from?.x) && Number.isFinite(to?.x)) {
        try {
            const verdict = perception.hasLineOfSight(
                { center: { x: from.x, y: from.y }, x: from.x, y: from.y, document: null },
                { center: { x: to.x, y: to.y }, x: to.x, y: to.y, document: null }
            );
            if (verdict === true || verdict === false) return verdict;
        } catch(err) {
            // Fall through to the geometric probe.
        }
    }
    if (walls.length && Number.isFinite(from?.x) && Number.isFinite(to?.x)) {
        return _crossingCount(from, to, walls, ["sight"]) === 0;
    }
    return null;
}

/**
 * Shared geometric probe for the evaluator and the veto predicate: the
 * evaluated endpoint, the tri-state LOS verdict and the cover score of a
 * candidate against its nearest threat.
 * @param {object} candidate Normalized planner candidate.
 * @param {object} context Planning context.
 * @returns {{point: {x: number, y: number}|null, to: {x: number, y: number}|null,
 *   los: boolean|null, cover: number}}
 */
function _probeCandidate(candidate = {}, context = {}) {
    const walls = _wallsOf(context);
    const point = _candidatePoint(candidate, context);
    const target = candidate.target ?? null;
    const to = _centerOf(target, context);
    const threat = _threatPoint(candidate, context, point) ?? to;
    const los = _losAt({ from: point, to, move: candidate.move, context, walls });
    const crossed = _crossingCount(point, threat, walls, ["sight", "move"]);
    const cover = Math.max(
        candidate.move ? _clamp01(candidate.move.cover) : 0,
        Math.min(MAX_COVER, crossed * COVER_PER_WALL)
    );
    return { point, to, los, cover };
}

/**
 * Weapon range-band factor in `[0, 1]` for an attack candidate: shots at
 * point-blank-ish distances and in the outer range share are discounted,
 * the effective middle band scores `1`. Non-attack candidates and melee
 * actions score `0` (melee choice is priced by the `melee`/`charge`
 * weights instead).
 * @param {object} candidate
 * @returns {number}
 */
function _rangeBand(candidate = {}) {
    if (!ATTACK_VARIANTS.has(candidate.variant) || _isMeleeAction(candidate.action)) return 0;
    const range = _actionRange(candidate.action);
    if (range <= 0) return 0;
    const distance = _finiteOr(candidate.move?.distance, _finiteOr(candidate.target?.distance, NaN));
    if (!Number.isFinite(distance) || distance < 0) return 0;
    const ratio = distance / range;
    let band;
    if (ratio <= 0) {
        band = 0.5;
    } else if (ratio < POINT_BLANK_SHARE) {
        band = 0.5 + (5 * ratio);
    } else if (ratio <= OPTIMAL_SHARE) {
        band = 1;
    } else if (ratio <= 1) {
        band = 1 - (0.6 * (ratio - OPTIMAL_SHARE) / (1 - OPTIMAL_SHARE));
    } else {
        band = 0;
    }
    return Math.round(band * 1e4) / 1e4;
}

/**
 * Whether an aim action is available for the turn: explicit context flag
 * or an aim-like entry (`aim` flag, `id`/`mode` "aim", "aim" in the name)
 * of the action list — the planner's resolved `usableActions` first,
 * then raw injected `context.actions`.
 * @param {object} context
 * @returns {boolean}
 */
function _aimAvailable(context = {}) {
    if (context.aim === true || context.aimAvailable === true) return true;
    const list = Array.isArray(context.usableActions) && context.usableActions.length
        ? context.usableActions
        : (Array.isArray(context.actions) ? context.actions : []);
    return list.some(entry => entry?.aim === true
        || String(entry?.mode ?? "").toLowerCase() === "aim"
        || String(entry?.id ?? "").toLowerCase() === "aim"
        || /\baim\b/i.test(String(entry?.name ?? "")));
}

/**
 * Preset veto predicate (planner contract, issue #405): an attack
 * candidate whose LOS is positively blocked — adapter verdict, perception
 * probe or the geometric wall fallback — is rejected with
 * `no-line-of-sight` so the planner never emits a shot that cannot be
 * taken. Undetermined LOS is not vetoed.
 * @param {object} input
 * @param {object} [input.candidate] Normalized candidate.
 * @param {object} [input.context] Planning context.
 * @returns {string|null} Rejection reason or null when acceptable.
 */
export function rangedCoverVeto({ candidate = {}, context = {} } = {}) {
    if (!ATTACK_VARIANTS.has(candidate.variant)) return null;
    // Blast memory strikes need no live LOS — the throw lands on a
    // remembered position (room clearing); friendlies were already
    // vetoed by the aim-point search in the planner.
    if (candidate.aim && candidate.target?.source === "last-known") return null;
    const probe = _probeCandidate(candidate, context);
    return probe.los === false ? RANGED_COVER_VETO_NO_LOS : null;
}

/**
 * Evaluate one planner candidate for the ranged-cover preset. Enriches
 * the shared factor vector with the resolved LOS verdict, the merged
 * adapter/geometric cover score, the weapon range band and the aim
 * opportunity marker, then delegates to the weighted-factor evaluator so
 * the breakdown stays explainable per factor.
 * @param {object} input Evaluation input from the planner.
 * @param {object} [input.factors] Factor vector (`SCORE_FACTORS`).
 * @param {object} [input.candidate] Scored candidate `{variant, target, move, action}`.
 * @param {object} [input.weights] Effective merged weights.
 * @param {object} [input.context] Planning context (`scene`, `walls`,
 *   `perception`, `token`/`selfPos`, `targets`, `actions`, `aim`).
 * @returns {{score: number, breakdown: object}}
 */
export function evaluateRangedCover({
    factors = {},
    candidate = {},
    weights = RANGED_COVER_WEIGHTS,
    context = {}
} = {}) {
    const probe = _probeCandidate(candidate, context);
    const target = candidate.target ?? null;
    const rangeBand = _rangeBand(candidate);
    const aimAvailable = _aimAvailable(context);
    // Undetermined LOS inherits the planner factor; a contact that is not
    // a last-known memory is presumed observable rather than blocked.
    const rawLos = probe.los ?? (_finiteOr(factors.los, 0)
        || (target && target.source !== "last-known" ? 1 : 0));
    const effectiveLos = rawLos ? 1 : 0;
    const enriched = {
        ...factors,
        los: effectiveLos,
        cover: probe.cover,
        rangeBand,
        aimOpportunity: aimAvailable && candidate.variant === "attack-in-place"
            && effectiveLos === 1 ? 1 : 0
    };
    const evaluation = evaluateFactors(enriched, weights);
    return {
        score: evaluation.score,
        breakdown: {
            ...evaluation.breakdown,
            preset: RANGED_COVER_PRESET_ID,
            variant: candidate.variant ?? null,
            position: {
                los: effectiveLos,
                cover: probe.cover,
                rangeBand
            },
            aimAvailable
        }
    };
}

/**
 * Build the planner `registerPreset` definition for the ranged-cover
 * preset. `allowNoTarget`/`allowNoAction` let the preset hold or keep
 * repositioning (e.g. with a melee-only loadout) instead of failing.
 * @returns {object} Preset definition for `planner.registerPreset`.
 */
export function rangedCoverPresetDefinition() {
    return {
        weights: { ...RANGED_COVER_WEIGHTS },
        evaluate: evaluateRangedCover,
        veto: rangedCoverVeto,
        allowNoTarget: true,
        allowNoAction: true
    };
}

/**
 * Register/replace the ranged-cover preset on a planner service instance.
 * Called once on `init` after the planner service is created.
 * @param {object} planner Planner service (`api.services.get("planner")`).
 * @returns {object} The stored preset definition.
 */
export function registerRangedCoverPreset(planner) {
    if (!planner || typeof planner.registerPreset !== "function") {
        throw new Error("[only-war-ai] Ranged-cover preset requires a planner service");
    }
    return planner.registerPreset(RANGED_COVER_PRESET_ID, rangedCoverPresetDefinition());
}
