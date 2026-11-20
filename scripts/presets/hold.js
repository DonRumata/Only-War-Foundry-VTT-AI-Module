/**
 * Hold preset «Удержание позиции» (issue #406, epic #363).
 *
 * Behaviour contract:
 * - The preset guards an anchor zone: preset options
 *   `{anchor: {sceneId?, x, y, elevation?}, radiusMeters}` resolve from
 *   `context.hold` first, then the combatant/token `override.hold` flag,
 *   then the actor `config.hold` flag (shallow merge, more specific wins).
 *   Without an explicit anchor the zone defaults to the token's current
 *   position and `radiusMeters`/`context.moveBudget`/a small default.
 * - Staying wins whenever the current position offers a useful action:
 *   `attackNow` + `holdPosition` dominate every repositioning candidate,
 *   and an `aim` action in the action list adds an advisory
 *   `aimOpportunity` bonus to `attack-in-place`.
 * - Movement happens only when it buys something the position lacks:
 *   `moveToLos` rewards endpoints that restore a positively blocked line
 *   of sight, `attackAfterMove` a modest move into range, `escapeMelee`
 *   a step away from a hostile in melee contact, and `returnToZone`
 *   dominates everything when the token stands outside its radius.
 * - `holdVeto` enforces the hard zone constraint: non-stay moves ending
 *   outside the radius are rejected (`outside-hold-radius`), approaches
 *   toward a last-known contact outside the radius are rejected too, a
 *   configured-but-unusable anchor (bad coordinates or a foreign scene)
 *   vetoes every move (`invalid-anchor`) so the NPC holds safely, and
 *   attacks with positively blocked LOS are rejected
 *   (`no-line-of-sight`) — the preset never fires blind.
 * - `anchorDrift` normalizes the endpoint distance-to-anchor into the
 *   score breakdown so the return pick lands on the nearest legal cell
 *   inside the radius; every candidate breakdown exposes
 *   `zone.anchorDistance`, `insideRadius` and the constraint status.
 * - Withdraw/disengage rules are not mechanized: `escapeMelee` only makes
 *   stepping out of melee contact *legal and attractive* — the plan
 *   stays a regular move + attack, and attacking the adjacent enemy in
 *   place remains a valid outcome.
 *
 * The preset is pure data (weights) plus a deterministic evaluator and a
 * veto predicate; candidate legality, bounded enumeration and seed
 * tie-breaking live in the planner.
 */
import { evaluateFactors } from "../planner.js";
import { MODULE_ID } from "../constants.js";

/** Preset id registered in the planner preset registry. */
export const HOLD_PRESET_ID = "hold";

/** Rejection reason produced by {@link holdVeto} for blocked attacks. */
export const HOLD_VETO_NO_LOS = "no-line-of-sight";

/** Rejection reason for candidates ending/pursuing outside the radius. */
export const HOLD_VETO_OUTSIDE_RADIUS = "outside-hold-radius";

/** Rejection reason for moves while a configured anchor is unusable. */
export const HOLD_VETO_INVALID_ANCHOR = "invalid-anchor";

/**
 * Default hold radius in scene units (≈ metres) when neither preset
 * options nor the context provide one.
 */
export const DEFAULT_HOLD_RADIUS = 6;

/** Distance in scene units that counts as melee contact with a hostile. */
export const HOLD_MELEE_CONTACT = 2;

/**
 * Data-driven weights for the hold preset. Names match `SCORE_FACTORS`
 * in `scripts/planner.js` plus the preset-only factors `insideZone`,
 * `returnToZone`, `moveToLos`, `escapeMelee`, `searchMove`,
 * `anchorDrift` and `aimOpportunity` computed by {@link evaluateHold};
 * missing factors contribute 0.
 */
export const HOLD_WEIGHTS = Object.freeze({
    attackNow: 12,
    attackAfterMove: 5,
    charge: -8,
    melee: 0,
    advance: 0,
    threat: 2,
    proximity: 0.5,
    los: 4,
    cover: 1,
    exposure: -1,
    holdPosition: 10,
    lastKnown: 0.5,
    budgetOver: -8,
    insideZone: 3,
    returnToZone: 26,
    moveToLos: 6,
    escapeMelee: 10,
    searchMove: 14,
    anchorDrift: -4,
    aimOpportunity: 1.5,
    attackType: 0.05,
    vulnerable: 0.5,
    meleeEngage: 2,
    area: 2
});

/** Candidate variants whose action produces an attack/test step. */
const ATTACK_VARIANTS = new Set(["attack-in-place", "move-attack", "charge"]);

/** Floating-point slack for radius comparisons. */
const RADIUS_EPSILON = 1e-6;

/** Cap on the normalized anchor-drift factor. */
const MAX_ANCHOR_DRIFT = 2;

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
 * Read a module flag without mutating the document: `getFlag` first,
 * then the raw `flags` object for plain fixtures.
 * @param {object} doc
 * @param {string} key
 * @returns {*}
 */
function _flag(doc, key) {
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
 * Token document of the planning context (placeables unwrap).
 * @param {object} context
 * @returns {object|null}
 */
function _contextToken(context = {}) {
    const token = context.token ?? context.combatant?.token ?? null;
    return token?.document ?? token ?? null;
}

/**
 * Actor document of the planning context.
 * @param {object} context
 * @returns {object|null}
 */
function _contextActor(context = {}) {
    return context.combatant?.actor
        ?? _contextToken(context)?.actor
        ?? context.actor
        ?? null;
}

/**
 * Preset options for the hold zone: `context.hold` wins, then the
 * combatant `override.hold` flag, the token `override.hold` flag and the
 * actor `config.hold` flag; each layer may also nest the options under
 * `options.hold`. Top-level `context.anchor`/`context.radiusMeters`
 * merge last for direct injection.
 * @param {object} context
 * @returns {object|null}
 */
function _holdOptions(context = {}) {
    const layers = [
        _flag(_contextActor(context), "config"),
        _flag(_contextToken(context), "override"),
        _flag(context.combatant, "override")
    ];
    const merged = {};
    for (const layer of layers) {
        const opts = layer?.hold ?? layer?.options?.hold;
        if (opts && typeof opts === "object") Object.assign(merged, opts);
    }
    if (context.hold && typeof context.hold === "object") Object.assign(merged, context.hold);
    if (context.anchor && typeof context.anchor === "object") merged.anchor = context.anchor;
    if (Number.isFinite(context.radiusMeters)) merged.radiusMeters = context.radiusMeters;
    return Object.keys(merged).length ? merged : null;
}

/**
 * Effective hold radius in scene units: preset options first, then
 * context hints and the numeric movement budget, then the default.
 * @param {object|null} opts Preset options.
 * @param {object} context
 * @returns {number}
 */
function _radiusOf(opts, context = {}) {
    const budget = context.moveBudget;
    const candidates = [
        opts?.radiusMeters,
        opts?.radius,
        Number.isFinite(budget) ? budget : _finiteOr(budget?.budget ?? budget?.limit, NaN)
    ];
    for (const value of candidates) {
        if (Number.isFinite(value) && value > 0) return value;
    }
    return DEFAULT_HOLD_RADIUS;
}

/**
 * Normalized grid info for pixel → scene-unit conversion.
 * @param {object} context
 * @returns {{size: number, distance: number}}
 */
function _gridOf(context = {}) {
    const grid = context.grid ?? context.scene?.grid ?? {};
    return {
        size: Number.isFinite(grid.size) && grid.size > 0 ? grid.size : 100,
        distance: Number.isFinite(grid.distance) && grid.distance > 0 ? grid.distance : 1
    };
}

/**
 * Current position of the AI token in pixels: `context.selfPos` or the
 * injected `context.token`/`combatant.token` document.
 * @param {object} context
 * @returns {{x: number, y: number}|null}
 */
function _selfPos(context = {}) {
    const raw = context.selfPos ?? context.position ?? null;
    if (Number.isFinite(raw?.x) && Number.isFinite(raw?.y)) return { x: raw.x, y: raw.y };
    const doc = _contextToken(context);
    const docX = doc?._source?.x ?? doc?.x;
    const docY = doc?._source?.y ?? doc?.y;
    if (Number.isFinite(docX) && Number.isFinite(docY)) return { x: docX, y: docY };
    return null;
}

/**
 * Distance between two pixel-space points in scene units.
 * @param {{x: number, y: number}|null} from
 * @param {{x: number, y: number}|null} to
 * @param {{size: number, distance: number}} grid
 * @returns {number|null}
 */
function _units(from, to, grid) {
    if (!Number.isFinite(from?.x) || !Number.isFinite(from?.y)
        || !Number.isFinite(to?.x) || !Number.isFinite(to?.y)) return null;
    return Math.hypot(from.x - to.x, from.y - to.y) / grid.size * grid.distance;
}

/**
 * Effective hold zone for the evaluation context.
 * `status` is `"ok"` (explicit anchor), `"default"` (implicit zone
 * around the current position), `"unanchored"` (nothing usable — no
 * radius constraint applies) or `"invalid-anchor"` (a configured anchor
 * with bad coordinates or a foreign `sceneId`).
 * @param {object} context
 * @returns {{status: string, configured: boolean,
 *   anchor: {x: number, y: number, elevation: number}|null,
 *   radius: number, grid: {size: number, distance: number}}}
 */
function _holdZone(context = {}) {
    const grid = _gridOf(context);
    const selfPos = _selfPos(context);
    const opts = _holdOptions(context) ?? {};
    const radius = _radiusOf(opts, context);
    const raw = opts.anchor ?? null;
    if (raw === null || raw === undefined) {
        const anchor = selfPos ? { x: selfPos.x, y: selfPos.y, elevation: 0 } : null;
        return {
            status: anchor ? "default" : "unanchored",
            configured: false,
            anchor,
            radius,
            grid
        };
    }
    const sceneId = context.scene?.id ?? null;
    const coordsOk = Number.isFinite(raw.x) && Number.isFinite(raw.y);
    const sceneOk = !raw.sceneId || !sceneId || raw.sceneId === sceneId;
    if (!coordsOk || !sceneOk) {
        return { status: "invalid-anchor", configured: true, anchor: null, radius, grid };
    }
    return {
        status: "ok",
        configured: true,
        anchor: { x: raw.x, y: raw.y, elevation: _finiteOr(raw.elevation, 0) },
        radius,
        grid
    };
}

/**
 * Endpoint evaluated for a candidate: the move destination, or the
 * current position for stay/hold/attack-in-place variants.
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
 * Whether the candidate actually relocates the token.
 * @param {object} candidate
 * @returns {boolean}
 */
function _moves(candidate = {}) {
    return Boolean(candidate.move) && candidate.move.stay !== true;
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
 * Wall documents relevant for LOS probes: injected `context.walls`
 * first, then the planning scene's wall collection.
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
 * Count sight-blocking walls crossed by `from → to`.
 * @param {{x: number, y: number}|null} from
 * @param {{x: number, y: number}|null} to
 * @param {object[]} walls Wall documents.
 * @returns {number}
 */
function _sightCrossings(from, to, walls) {
    if (!Number.isFinite(from?.x) || !Number.isFinite(from?.y)
        || !Number.isFinite(to?.x) || !Number.isFinite(to?.y)) return 0;
    let count = 0;
    for (const doc of walls) {
        if (!_wallBlocks(doc, "sight")) continue;
        const segment = _wallSegment(doc);
        if (segment && _segmentsIntersect(from, to, segment.A, segment.B)) count += 1;
    }
    return count;
}

/**
 * Resolve LOS from a point to the candidate target, layered like the
 * ranged-cover preset: the navigation adapter verdict (`move.los`)
 * wins, then `perception.hasLineOfSight`, then a geometric probe against
 * sight-blocking walls. `null` means "undetermined".
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
        return _sightCrossings(from, to, walls) === 0;
    }
    return null;
}

/**
 * Shared probe for the evaluator and the veto predicate: the evaluated
 * endpoint plus the tri-state LOS verdict toward the candidate target.
 * @param {object} candidate Normalized planner candidate.
 * @param {object} context Planning context.
 * @returns {{point: {x: number, y: number}|null,
 *   to: {x: number, y: number}|null, los: boolean|null}}
 */
function _probeCandidate(candidate = {}, context = {}) {
    const walls = _wallsOf(context);
    const point = _candidatePoint(candidate, context);
    const target = candidate.target ?? null;
    const to = Number.isFinite(target?.x) && Number.isFinite(target?.y)
        ? { x: target.x, y: target.y }
        : null;
    return { point, to, los: _losAt({ from: point, to, move: candidate.move, context, walls }) };
}

/**
 * The nearest hostile in melee contact with the token: a non-last-known
 * resolved target inside {@link HOLD_MELEE_CONTACT} scene units (or the
 * injected `context.meleeContactRange`). Returns the contact point and
 * the distance from the current position, or null.
 * @param {object} context
 * @returns {{x: number, y: number, distance: number}|null}
 */
function _contactThreat(context = {}) {
    const reach = Number.isFinite(context.meleeContactRange) && context.meleeContactRange > 0
        ? context.meleeContactRange
        : HOLD_MELEE_CONTACT;
    const pool = Array.isArray(context.resolvedTargets) && context.resolvedTargets.length
        ? context.resolvedTargets
        : (Array.isArray(context.targets) ? context.targets : []);
    let best = null;
    for (const entry of pool) {
        if (entry?.source === "last-known") continue;
        const distance = _finiteOr(entry?.distance, null);
        if (distance === null || distance > reach + RADIUS_EPSILON) continue;
        if (!best || distance < best.distance) {
            best = { x: entry.x, y: entry.y, distance };
        }
    }
    return best;
}

/**
 * Whether a candidate's endpoint increases the distance to the melee
 * contact compared to the current position.
 * @param {object} candidate
 * @param {{x: number, y: number, distance: number}|null} contact
 * @param {{x: number, y: number}|null} endpoint
 * @param {{x: number, y: number}|null} selfPos
 * @param {{size: number, distance: number}} grid
 * @returns {boolean}
 */
function _escapesContact(candidate, contact, endpoint, selfPos, grid) {
    if (!contact || !_moves(candidate) || !endpoint || !selfPos) return false;
    const after = _units(endpoint, contact, grid);
    const before = _units(selfPos, contact, grid);
    return after !== null && before !== null && after > before + RADIUS_EPSILON;
}

/**
 * Whether an aim action is available for the turn: explicit context flag
 * or an aim-like entry (`aim` flag, `id`/`mode` "aim", "aim" in the
 * name) of the planner's resolved `usableActions`, then raw injected
 * `context.actions`.
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
 * Preset veto predicate (planner contract, issue #406):
 * - while a configured anchor is unusable every relocating candidate is
 *   rejected with `invalid-anchor` so the NPC holds safely;
 * - a non-stay move ending outside the hold radius, or an approach
 *   toward a last-known contact outside the radius, is rejected with
 *   `outside-hold-radius`;
 * - an attack whose LOS is positively blocked is rejected with
 *   `no-line-of-sight`.
 * Undetermined LOS and unanchored contexts are never vetoed.
 * @param {object} input
 * @param {object} [input.candidate] Normalized candidate.
 * @param {object} [input.context] Planning context.
 * @returns {string|null} Rejection reason or null when acceptable.
 */
export function holdVeto({ candidate = {}, context = {} } = {}) {
    const zone = _holdZone(context);
    const moving = _moves(candidate);
    if (zone.status === "invalid-anchor") {
        return moving ? HOLD_VETO_INVALID_ANCHOR : null;
    }
    if (moving && zone.anchor && Number.isFinite(zone.radius)) {
        const anchorDistance = _units(candidate.move, zone.anchor, zone.grid);
        if (anchorDistance !== null && anchorDistance > zone.radius + RADIUS_EPSILON) {
            return HOLD_VETO_OUTSIDE_RADIUS;
        }
    }
    const target = candidate.target;
    if (moving && target?.source === "last-known" && zone.anchor) {
        const targetDistance = _units(target, zone.anchor, zone.grid);
        if (targetDistance !== null && targetDistance > zone.radius + RADIUS_EPSILON) {
            return HOLD_VETO_OUTSIDE_RADIUS;
        }
    }
    if (ATTACK_VARIANTS.has(candidate.variant)) {
        const probe = _probeCandidate(candidate, context);
        if (probe.los === false) return HOLD_VETO_NO_LOS;
    }
    return null;
}

/**
 * Evaluate one planner candidate for the hold preset. Enriches the
 * shared factor vector with the resolved LOS verdict and the zone
 * factors — endpoint inside radius, return-to-zone, LOS gained by the
 * move, melee-contact escape, last-known search and the normalized
 * anchor drift — then delegates to the weighted-factor evaluator so the
 * breakdown stays explainable per factor.
 * @param {object} input Evaluation input from the planner.
 * @param {object} [input.factors] Factor vector (`SCORE_FACTORS`).
 * @param {object} [input.candidate] Scored candidate `{variant, target, move, action}`.
 * @param {object} [input.weights] Effective merged weights.
 * @param {object} [input.context] Planning context (`scene`, `walls`,
 *   `perception`, `token`/`selfPos`, `resolvedTargets`, `usableActions`,
 *   `hold`/`anchor`/`radiusMeters`, `moveBudget`).
 * @returns {{score: number, breakdown: object}}
 */
export function evaluateHold({
    factors = {},
    candidate = {},
    weights = HOLD_WEIGHTS,
    context = {}
} = {}) {
    const zone = _holdZone(context);
    const walls = _wallsOf(context);
    const probe = _probeCandidate(candidate, context);
    const endpoint = _candidatePoint(candidate, context);
    const selfPos = _selfPos(context);
    const contact = _contactThreat(context);
    const target = candidate.target ?? null;
    const moving = _moves(candidate);

    const anchorDistance = zone.anchor && endpoint
        ? _units(endpoint, zone.anchor, zone.grid)
        : null;
    const selfAnchorDistance = zone.anchor && selfPos
        ? _units(selfPos, zone.anchor, zone.grid)
        : null;
    const insideRadius = anchorDistance !== null
        ? anchorDistance <= zone.radius + RADIUS_EPSILON
        : null;
    const selfInside = selfAnchorDistance !== null
        ? selfAnchorDistance <= zone.radius + RADIUS_EPSILON
        : null;
    const selfLos = selfPos && probe.to
        ? _losAt({ from: selfPos, to: probe.to, move: null, context, walls })
        : null;
    // Undetermined LOS inherits the planner factor; a contact that is not
    // a last-known memory is presumed observable rather than blocked.
    const rawLos = probe.los ?? (_finiteOr(factors.los, 0)
        || (target && target.source !== "last-known" ? 1 : 0));
    const effectiveLos = rawLos ? 1 : 0;
    const aimAvailable = _aimAvailable(context);

    const enriched = {
        ...factors,
        los: effectiveLos,
        insideZone: insideRadius === true ? 1 : 0,
        returnToZone: moving && selfInside === false && insideRadius === true ? 1 : 0,
        moveToLos: moving && selfLos === false && probe.los === true ? 1 : 0,
        escapeMelee: _escapesContact(candidate, contact, endpoint, selfPos, zone.grid) ? 1 : 0,
        searchMove: candidate.variant === "approach" && target?.source === "last-known" ? 1 : 0,
        anchorDrift: anchorDistance !== null
            ? Math.min(MAX_ANCHOR_DRIFT, anchorDistance / Math.max(zone.radius, RADIUS_EPSILON))
            : 0,
        aimOpportunity: aimAvailable && candidate.variant === "attack-in-place"
            && effectiveLos === 1 ? 1 : 0
    };
    const evaluation = evaluateFactors(enriched, weights);
    return {
        score: evaluation.score,
        breakdown: {
            ...evaluation.breakdown,
            preset: HOLD_PRESET_ID,
            variant: candidate.variant ?? null,
            position: {
                los: effectiveLos,
                meleeContact: contact !== null
            },
            zone: {
                status: zone.status,
                configured: zone.configured,
                anchor: zone.anchor ? { ...zone.anchor } : null,
                radius: zone.radius,
                anchorDistance: anchorDistance !== null
                    ? Math.round(anchorDistance * 1e4) / 1e4
                    : null,
                insideRadius
            },
            aimAvailable
        }
    };
}

/**
 * Build the planner `registerPreset` definition for the hold preset.
 * `allowNoTarget`/`allowNoAction` keep a safe hold plan available, and
 * `alwaysOfferHold` guarantees the stay candidate competes in every
 * ranking.
 * @returns {object} Preset definition for `planner.registerPreset`.
 */
export function holdPresetDefinition() {
    return {
        weights: { ...HOLD_WEIGHTS },
        evaluate: evaluateHold,
        veto: holdVeto,
        allowNoTarget: true,
        allowNoAction: true,
        alwaysOfferHold: true
    };
}

/**
 * Register/replace the hold preset on a planner service instance.
 * Called once on `init` after the planner service is created.
 * @param {object} planner Planner service (`api.services.get("planner")`).
 * @returns {object} The stored preset definition.
 */
export function registerHoldPreset(planner) {
    if (!planner || typeof planner.registerPreset !== "function") {
        throw new Error("[only-war-ai] Hold preset requires a planner service");
    }
    return planner.registerPreset(HOLD_PRESET_ID, holdPresetDefinition());
}
