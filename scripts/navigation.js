/**
 * Navigation service (issue #402): grid-aware pathfinding, movement budget
 * validation and destination candidates for AI-controlled NPCs.
 *
 * Design contract (epic #363):
 * - The pathfinder is pure/read-only: it never calls `Token.update`, never
 *   mutates documents and returns only JSON-serializable waypoints (no
 *   canvas objects). Actual movement is performed by the active-GM
 *   executor in a follow-up subtask.
 * - Square and hex scenes are supported; gridless scenes are rejected with
 *   `gridless-unsupported` before any planning.
 * - The canonical movement budget comes from the system API
 *   `game.darkHeresy.api.movement.getRates(actor)` (issue #398 contract:
 *   `{status, half, full, charge, run}` in scene units). Without the system
 *   API the prepared `actor.system.movement` data is used as a fallback.
 * - Foundry 13/14 differences are hidden behind {@link createGridAdapter}:
 *   `canvas.walls.checkCollision` (v13) vs `CONFIG.Canvas.polygonBackends`
 *   / manual geometry (v12+), `measureDistance` (v13) vs `measurePath`
 *   (v14) and the `GridOffset` point conversion APIs.
 * - Difficult terrain: when the platform exposes a token movement-cost
 *   function (`TokenDocument#measureMovementPath`, v13+) the measured cost
 *   is authoritative for the budget check; the internal A* heuristic stays
 *   geometric. Without such an API the cost is approximated and the result
 *   is flagged via `approximations`.
 * - Results are deterministic for an identical scene snapshot: neighbour
 *   order, priority-queue tie-breaks and candidate sorting are fixed, and
 *   each result carries a `revision` fingerprint of the inputs.
 */
import { logDiagnostics } from "./settings.js";

/** Result status values for route planning. */
export const NAVIGATION_STATUS = Object.freeze({
    ok: "ok",
    partial: "partial",
    failed: "failed"
});

/** Stable reason codes for validation and planning failures. */
export const NAVIGATION_REASONS = Object.freeze({
    gridlessUnsupported: "gridless-unsupported",
    sceneUnavailable: "scene-unavailable",
    invalidInput: "invalid-input",
    ratesUnavailable: "movement-rates-unavailable",
    endpointOutOfBounds: "endpoint-out-of-bounds",
    endpointOccupied: "endpoint-occupied",
    pathNotFound: "path-not-found",
    budgetExceeded: "movement-budget-exceeded",
    searchLimit: "search-limit"
});

/** Movement modes matching the system API `getRates` fields. */
export const MOVEMENT_MODES = Object.freeze(["half", "full", "charge", "run"]);

/** Normalized grid kinds. */
export const GRID_KINDS = Object.freeze({
    square: "square",
    hex: "hex",
    gridless: "gridless"
});

/**
 * Foundry `CONST.GRID_TYPES` values mirrored so unit tests do not need a
 * live `CONST` global: 0 gridless, 1 square, 2-5 hex offset variants.
 */
export const GRID_TYPES = Object.freeze({
    gridless: 0,
    square: 1,
    hexOddR: 2,
    hexEvenR: 3,
    hexOddQ: 4,
    hexEvenQ: 5
});

/** Default bound for A* expansions / flood-fill visits. */
export const DEFAULT_SEARCH_LIMIT = 20000;

/** Default bound for returned reachable cells and candidates. */
export const DEFAULT_RESULT_LIMIT = 512;

/** Default number of destination candidates returned to presets. */
export const DEFAULT_CANDIDATE_COUNT = 8;

/** Default candidate scoring weights (higher score wins). */
export const DEFAULT_CANDIDATE_WEIGHTS = Object.freeze({
    distance: 1,
    los: 5,
    cover: 2
});

/** How occupied cells are treated while crossing the grid. */
export const OCCUPIED_POLICIES = Object.freeze({
    pass: "pass",
    block: "block"
});

/** Epsilon for float budget comparisons. */
const EPSILON = 1e-6;

/**
 * Deterministic 32-bit FNV-1a fingerprint used for `revision` fields.
 * @param {string} text
 * @returns {string}
 */
function _fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}

/**
 * Deep-freeze helper for immutable results.
 * @param {*} value
 * @returns {*}
 */
function _deepFreeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        for (const key of Object.keys(value)) _deepFreeze(value[key]);
        Object.freeze(value);
    }
    return value;
}

/**
 * High-resolution timestamp in milliseconds, Date fallback.
 * @returns {number}
 */
function _now() {
    return globalThis.performance?.now?.() ?? Date.now();
}

/**
 * Canonical cell key for an offset `{i, j}`.
 * @param {object} offset
 * @returns {string}
 */
export function offsetKey(offset) {
    return `${offset.i},${offset.j}`;
}

/**
 * Non-negative parity (0 even, 1 odd) that also works for negative offsets.
 * @param {number} value
 * @returns {number}
 */
function _parity(value) {
    return ((value % 2) + 2) % 2;
}

/* ------------------------------------------------------------------------- */
/* Grid description                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Normalize a Foundry grid type (number or string) to "square" | "hex" |
 * "gridless" | null.
 * @param {number|string|object|null} type `scene.grid.type` or a grid object.
 * @returns {string|null}
 */
export function gridKindOf(type) {
    if (type && typeof type === "object") {
        if (type.isHexagonal === true) return GRID_KINDS.hex;
        if (type.isSquare === true) return GRID_KINDS.square;
        if (type.isGridless === true) return GRID_KINDS.gridless;
        type = type.type;
    }
    if (type === GRID_TYPES.square || type === "square") return GRID_KINDS.square;
    if (type === GRID_TYPES.gridless || type === "gridless") return GRID_KINDS.gridless;
    if (type === GRID_TYPES.hexOddR || type === GRID_TYPES.hexEvenR
        || type === GRID_TYPES.hexOddQ || type === GRID_TYPES.hexEvenQ) {
        return GRID_KINDS.hex;
    }
    if (typeof type === "string" && type.startsWith("hex")) return GRID_KINDS.hex;
    return null;
}

/**
 * Offset-coordinate variant of a hex grid type: "odd-r" | "even-r" |
 * "odd-q" | "even-q" | null.
 * @param {number|string|object|null} type
 * @returns {string|null}
 */
export function hexVariantOf(type) {
    if (type && typeof type === "object") type = type.type;
    switch (type) {
        case GRID_TYPES.hexOddR:
        case "hexOddR":
        case "odd-r": return "odd-r";
        case GRID_TYPES.hexEvenR:
        case "hexEvenR":
        case "even-r": return "even-r";
        case GRID_TYPES.hexOddQ:
        case "hexOddQ":
        case "odd-q": return "odd-q";
        case GRID_TYPES.hexEvenQ:
        case "hexEvenQ":
        case "even-q": return "even-q";
        default: return null;
    }
}

/**
 * Normalized diagonal-movement rule of a square grid: "equidistant" |
 * "exact" | "approximate" | "rectilinear". Accepts both the numeric
 * `CONST.GRID_DIAGONALS` enum and string forms; defaults to the Foundry
 * default "equidistant" (a diagonal costs like an orthogonal step).
 * @param {object|null} scene
 * @param {object|null} [grid]
 * @returns {string}
 */
export function diagonalRuleOf(scene, grid = null) {
    const raw = scene?.grid?.diagonals ?? grid?.diagonals ?? null;
    const map = {
        1: "equidistant",
        2: "exact",
        3: "approximate",
        4: "rectilinear",
        equidistant: "equidistant",
        exact: "exact",
        approximate: "approximate",
        alternating: "approximate",
        rectilinear: "rectilinear"
    };
    return map[raw] ?? "equidistant";
}

/**
 * Cell-cost multiplier of a diagonal step for the given rule.
 * `approximate` models the 5/10 alternation with a flat 1.5 multiplier —
 * a documented slight overestimate, never underestimates the real cost.
 * @param {string} rule
 * @returns {number}
 */
export function diagonalCostOf(rule) {
    switch (rule) {
        case "exact": return Math.SQRT2;
        case "approximate": return 1.5;
        case "rectilinear": return 2;
        default: return 1;
    }
}

/* ------------------------------------------------------------------------- */
/* Neighbour generation (pure)                                                */
/* ------------------------------------------------------------------------- */

const SQUARE_DIRECTIONS = Object.freeze([
    Object.freeze({ di: -1, dj: -1, diagonal: true }),
    Object.freeze({ di: -1, dj: 0, diagonal: false }),
    Object.freeze({ di: -1, dj: 1, diagonal: true }),
    Object.freeze({ di: 0, dj: -1, diagonal: false }),
    Object.freeze({ di: 0, dj: 1, diagonal: false }),
    Object.freeze({ di: 1, dj: -1, diagonal: true }),
    Object.freeze({ di: 1, dj: 0, diagonal: false }),
    Object.freeze({ di: 1, dj: 1, diagonal: true })
]);

/**
 * Hex neighbour deltas in offset coordinates `{di, dj}` keyed by variant
 * and the parity of the shifting axis (row for R grids, column for Q).
 * Mirrors the standard offset-coordinate neighbour tables.
 */
const HEX_DIRECTIONS = Object.freeze({
    "odd-r": Object.freeze([
        Object.freeze([
            { di: -1, dj: -1 }, { di: -1, dj: 0 }, { di: 0, dj: -1 },
            { di: 0, dj: 1 }, { di: 1, dj: -1 }, { di: 1, dj: 0 }
        ]),
        Object.freeze([
            { di: -1, dj: 0 }, { di: -1, dj: 1 }, { di: 0, dj: -1 },
            { di: 0, dj: 1 }, { di: 1, dj: 0 }, { di: 1, dj: 1 }
        ])
    ]),
    "even-r": Object.freeze([
        Object.freeze([
            { di: -1, dj: 0 }, { di: -1, dj: 1 }, { di: 0, dj: -1 },
            { di: 0, dj: 1 }, { di: 1, dj: 0 }, { di: 1, dj: 1 }
        ]),
        Object.freeze([
            { di: -1, dj: -1 }, { di: -1, dj: 0 }, { di: 0, dj: -1 },
            { di: 0, dj: 1 }, { di: 1, dj: -1 }, { di: 1, dj: 0 }
        ])
    ]),
    "odd-q": Object.freeze([
        Object.freeze([
            { di: -1, dj: 0 }, { di: 1, dj: 0 }, { di: -1, dj: -1 },
            { di: 0, dj: -1 }, { di: -1, dj: 1 }, { di: 0, dj: 1 }
        ]),
        Object.freeze([
            { di: -1, dj: 0 }, { di: 1, dj: 0 }, { di: 0, dj: -1 },
            { di: 1, dj: -1 }, { di: 0, dj: 1 }, { di: 1, dj: 1 }
        ])
    ]),
    "even-q": Object.freeze([
        Object.freeze([
            { di: -1, dj: 0 }, { di: 1, dj: 0 }, { di: 0, dj: -1 },
            { di: 1, dj: -1 }, { di: 0, dj: 1 }, { di: 1, dj: 1 }
        ]),
        Object.freeze([
            { di: -1, dj: 0 }, { di: 1, dj: 0 }, { di: -1, dj: -1 },
            { di: 0, dj: -1 }, { di: -1, dj: 1 }, { di: 0, dj: 1 }
        ])
    ])
});

/**
 * Ordered neighbour descriptors `{i, j, diagonal}` of an offset cell on
 * the given grid descriptor `{kind, variant}`. The order is fixed so path
 * results are deterministic.
 * @param {object} offset `{i, j}` grid offset.
 * @param {object} grid `{kind, variant}` normalized grid descriptor.
 * @returns {object[]}
 */
export function neighborOffsets(offset, grid) {
    const { i, j } = offset;
    if (grid?.kind === GRID_KINDS.square) {
        return SQUARE_DIRECTIONS.map(d => ({ i: i + d.di, j: j + d.dj, diagonal: d.diagonal }));
    }
    if (grid?.kind === GRID_KINDS.hex) {
        const variant = grid.variant ?? "odd-r";
        const axis = variant.endsWith("-r") ? _parity(i) : _parity(j);
        const deltas = HEX_DIRECTIONS[variant]?.[axis] ?? [];
        return deltas.map(d => ({ i: i + d.di, j: j + d.dj, diagonal: false }));
    }
    return [];
}

/**
 * Convert a hex offset `{i, j}` to axial `{q, r}` coordinates for distance
 * heuristics.
 * @param {object} offset
 * @param {string} variant "odd-r" | "even-r" | "odd-q" | "even-q".
 * @returns {{q: number, r: number}}
 */
export function offsetToAxial(offset, variant) {
    const { i, j } = offset;
    const pi = _parity(i);
    const pj = _parity(j);
    switch (variant) {
        case "odd-r": return { q: j - ((i - pi) / 2), r: i };
        case "even-r": return { q: j - ((i + pi) / 2), r: i };
        case "odd-q": return { q: j, r: i - ((j - pj) / 2) };
        case "even-q": return { q: j, r: i - ((j + pj) / 2) };
        default: return { q: j, r: i };
    }
}

/**
 * Hex distance between two offset cells in steps.
 * @param {object} a
 * @param {object} b
 * @param {string} variant
 * @returns {number}
 */
export function hexDistance(a, b, variant) {
    const aa = offsetToAxial(a, variant);
    const bb = offsetToAxial(b, variant);
    const dq = aa.q - bb.q;
    const dr = aa.r - bb.r;
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

/**
 * Admissible A* heuristic in cell-cost units between two offsets.
 * Square grids use the Euclidean bound (never overestimates any supported
 * diagonal rule); hex grids use the exact hex distance.
 * @param {object} a
 * @param {object} b
 * @param {object} grid `{kind, variant}`.
 * @returns {number}
 */
export function heuristicCells(a, b, grid) {
    if (grid?.kind === GRID_KINDS.hex) return hexDistance(a, b, grid.variant ?? "odd-r");
    const di = Math.abs(a.i - b.i);
    const dj = Math.abs(a.j - b.j);
    return Math.hypot(di, dj);
}

/**
 * Step-model cell cost between two (not necessarily adjacent) offsets: the
 * cost of the cheapest monotone sequence of grid steps under the scene's
 * diagonal rule. Hex grids use the exact hex distance.
 * @param {object} a
 * @param {object} b
 * @param {object} grid `{kind, variant, diagonals}`.
 * @returns {number}
 */
export function cellPathCost(a, b, grid) {
    if (grid?.kind === GRID_KINDS.hex) return hexDistance(a, b, grid.variant ?? "odd-r");
    const di = Math.abs(a.i - b.i);
    const dj = Math.abs(a.j - b.j);
    return (Math.min(di, dj) * diagonalCostOf(diagonalRuleOf(null, grid)))
        + Math.abs(di - dj);
}

/* ------------------------------------------------------------------------- */
/* A* / Dijkstra core (pure)                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Minimal deterministic binary min-heap ordered by (f, h, serial).
 */
class _MinHeap {
    /**
     * Create an empty heap.
     */
    constructor() {
        this.items = [];
    }

    /**
     * Number of queued entries.
     * @returns {number}
     */
    get size() {
        return this.items.length;
    }

    /**
     * Whether `a` sorts strictly before `b`.
     * @param {object} a
     * @param {object} b
     * @returns {boolean}
     */
    _before(a, b) {
        if (a.f !== b.f) return a.f < b.f;
        if (a.h !== b.h) return a.h < b.h;
        return a.serial < b.serial;
    }

    /**
     * Push an entry `{f, h, serial, offset, g}`.
     * @param {object} item
     */
    push(item) {
        const items = this.items;
        items.push(item);
        let index = items.length - 1;
        while (index > 0) {
            const parent = (index - 1) >> 1;
            if (!this._before(items[index], items[parent])) break;
            [items[index], items[parent]] = [items[parent], items[index]];
            index = parent;
        }
    }

    /**
     * Pop the minimal entry.
     * @returns {object|undefined}
     */
    pop() {
        const items = this.items;
        const top = items[0];
        const last = items.pop();
        if (items.length && last) {
            items[0] = last;
            let index = 0;
            for (;;) {
                const left = (2 * index) + 1;
                const right = left + 1;
                let smallest = index;
                if (left < items.length && this._before(items[left], items[smallest])) smallest = left;
                if (right < items.length && this._before(items[right], items[smallest])) smallest = right;
                if (smallest === index) break;
                [items[index], items[smallest]] = [items[smallest], items[index]];
                index = smallest;
            }
        }
        return top;
    }
}

/**
 * Reconstruct the offset path back to `node` via the came-from map.
 * @param {Map} cameFrom
 * @param {object} node `{key, offset}`
 * @returns {object[]} Offsets from start to node (inclusive).
 */
function _reconstruct(cameFrom, node) {
    const path = [node.offset];
    let current = node;
    while (cameFrom.has(current.key)) {
        current = cameFrom.get(current.key);
        path.unshift(current.offset);
    }
    return path;
}

/**
 * Bounded A* search over grid offsets. Everything is expressed in
 * cell-cost units; the caller converts to scene units.
 *
 * @param {object} input
 * @param {object} input.start Start offset `{i, j}` (footprint top-left).
 * @param {object} input.goal Goal offset `{i, j}`.
 * @param {Function} input.getNeighbors `(offset) => [{i, j, diagonal}]`.
 * @param {Function} input.edgeCost `(from, to, diagonal) => number` cell
 *   cost of one step.
 * @param {Function} input.isOpen `(from, to) => boolean` wall/edge check.
 * @param {Function} input.canStand `(offset) => boolean` transit check:
 *   footprint fits in bounds and (policy permitting) is not reserved.
 * @param {Function} input.canStop `(offset) => boolean` endpoint check:
 *   transit check plus reservations.
 * @param {Function} input.heuristic `(offset) => number` cost estimate to goal.
 * @param {number} [input.budget] Maximum accumulated cost (Infinity).
 * @param {number} [input.maxVisited] Expansion bound.
 * @returns {object} `{status, path, cost, visited, best, limited}` where
 *   `best` is the standable node closest to the goal for partial results.
 */
export function searchRoute(input) {
    const {
        start,
        goal,
        getNeighbors,
        edgeCost,
        isOpen,
        canStand,
        canStop,
        heuristic,
        budget = Infinity,
        maxVisited = DEFAULT_SEARCH_LIMIT
    } = input;

    const startKey = offsetKey(start);
    const goalKey = offsetKey(goal);
    const heap = new _MinHeap();
    const gScore = new Map([[startKey, 0]]);
    const cameFrom = new Map();
    let serial = 0;
    let visited = 0;
    let best = { key: startKey, offset: start, g: 0, h: heuristic(start) };

    heap.push({ f: heuristic(start), h: heuristic(start), serial: serial++, offset: start, g: 0 });

    while (heap.size) {
        const node = heap.pop();
        const key = offsetKey(node.offset);
        if (node.g > (gScore.get(key) ?? Infinity) + EPSILON) continue;
        visited++;
        if (visited > maxVisited) {
            return { status: "limit", path: null, cost: null, visited, best, limited: true };
        }

        if (canStop(node.offset)) {
            if (node.h < best.h - EPSILON
                || (Math.abs(node.h - best.h) <= EPSILON && node.g < best.g - EPSILON)) {
                best = { key, offset: node.offset, g: node.g, h: node.h };
            }
            if (key === goalKey) {
                return {
                    status: "found",
                    path: _reconstruct(cameFrom, { key, offset: node.offset }),
                    cost: node.g,
                    visited,
                    best: { key, offset: node.offset, g: node.g, h: 0 },
                    limited: false
                };
            }
        }

        for (const next of getNeighbors(node.offset)) {
            const nextKey = offsetKey(next);
            if (!canStand(next)) continue;
            if (!isOpen(node.offset, next)) continue;
            const cost = edgeCost(node.offset, next, next.diagonal === true);
            const g = node.g + cost;
            if (g > budget + EPSILON) continue;
            if (g < (gScore.get(nextKey) ?? Infinity) - EPSILON) {
                gScore.set(nextKey, g);
                cameFrom.set(nextKey, { key, offset: node.offset });
                const h = heuristic(next);
                heap.push({ f: g + h, h, serial: serial++, offset: { i: next.i, j: next.j }, g });
            }
        }
    }

    const bestPath = best ? _reconstruct(cameFrom, best) : null;
    return {
        status: bestPath && bestPath.length ? "partial" : "not-found",
        path: bestPath,
        cost: best?.g ?? 0,
        visited,
        best,
        limited: false
    };
}

/**
 * Bounded Dijkstra flood fill: every standable cell reachable from `start`
 * within `budget` cell-cost units. Deterministic order: cost, then i, j.
 * @param {object} input Same primitives as {@link searchRoute} minus goal.
 * @param {number} [input.limit] Maximum number of returned cells.
 * @returns {object} `{status, cells, visited, limited}`.
 */
export function floodReachable(input) {
    const {
        start,
        getNeighbors,
        edgeCost,
        isOpen,
        canStand,
        canStop,
        budget = Infinity,
        maxVisited = DEFAULT_SEARCH_LIMIT,
        limit = DEFAULT_RESULT_LIMIT
    } = input;

    const startKey = offsetKey(start);
    const heap = new _MinHeap();
    const gScore = new Map([[startKey, 0]]);
    let serial = 0;
    let visited = 0;
    let limited = false;
    const cells = [];

    heap.push({ f: 0, h: 0, serial: serial++, offset: start, g: 0 });
    while (heap.size) {
        const node = heap.pop();
        const key = offsetKey(node.offset);
        if (node.g > (gScore.get(key) ?? Infinity) + EPSILON) continue;
        visited++;
        if (visited > maxVisited) {
            limited = true;
            break;
        }
        if (canStop(node.offset)) {
            if (cells.length >= limit) {
                // Keep visiting for the counter but stop collecting.
            } else {
                cells.push({ i: node.offset.i, j: node.offset.j, cost: node.g });
            }
        }
        for (const next of getNeighbors(node.offset)) {
            const nextKey = offsetKey(next);
            if (!canStand(next)) continue;
            if (!isOpen(node.offset, next)) continue;
            const g = node.g + edgeCost(node.offset, next, next.diagonal === true);
            if (g > budget + EPSILON) continue;
            if (g < (gScore.get(nextKey) ?? Infinity) - EPSILON) {
                gScore.set(nextKey, g);
                heap.push({ f: g, h: 0, serial: serial++, offset: { i: next.i, j: next.j }, g });
            }
        }
    }
    cells.sort((a, b) => (a.cost - b.cost) || (a.i - b.i) || (a.j - b.j));
    return { status: "ok", cells, visited, limited };
}

/* ------------------------------------------------------------------------- */
/* Foundry 13/14 adapter                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Scene wall documents (placeables or plain documents) as an array.
 * @param {object} canvasLike
 * @returns {object[]}
 */
function _wallDocs(canvasLike) {
    const docs = [];
    const seen = new Set();
    const push = wall => {
        const doc = wall?.document ?? wall;
        if (doc && !seen.has(doc)) {
            seen.add(doc);
            docs.push(doc);
        }
    };
    for (const wall of canvasLike?.walls?.placeables ?? canvasLike?.walls?.contents ?? []) push(wall);
    if (!docs.length) {
        const collection = canvasLike?.scene?.walls;
        const list = collection?.contents
            ?? (collection && typeof collection[Symbol.iterator] === "function" ? [...collection] : []);
        for (const wall of list) push(wall);
    }
    return docs;
}

/**
 * Wall segment endpoints `{A, B}` from `c`/`coords` or `A`/`B` fields.
 * @param {object} doc
 * @returns {{A: object, B: object}|null}
 */
function _wallSegment(doc) {
    const c = doc?.c ?? doc?.coords;
    if (Array.isArray(c) && c.length >= 4) {
        return { A: { x: c[0], y: c[1] }, B: { x: c[2], y: c[3] } };
    }
    const a = doc?.A ?? doc?.a;
    const b = doc?.B ?? doc?.b;
    if (a && b && Number.isFinite(a.x) && Number.isFinite(b.x)) return { A: a, B: b };
    return null;
}

/**
 * Whether a wall document currently blocks the given sense ("move" or
 * "sight"), accepting the v13 numeric schema (`move`, `sight`, `door`,
 * `ds`) and the v14 object schema (`move.enabled`, `sight.type`,
 * `door.state`). Open doors never block.
 * @param {object} doc
 * @param {string} sense "move" | "sight".
 * @returns {boolean}
 */
export function wallBlocks(doc, sense = "move") {
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
 * 2D segment intersection test (proper crossings plus endpoint touches
 * when `inclusive` is set).
 * @param {object} p1
 * @param {object} p2
 * @param {object} p3
 * @param {object} p4
 * @param {boolean} [inclusive]
 * @returns {boolean}
 */
function _segmentsIntersect(p1, p2, p3, p4, inclusive = true) {
    const cross = (a, b, p) => ((b.x - a.x) * (p.y - a.y)) - ((b.y - a.y) * (p.x - a.x));
    const d1 = cross(p3, p4, p1);
    const d2 = cross(p3, p4, p2);
    const d3 = cross(p1, p2, p3);
    const d4 = cross(p1, p2, p4);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
        && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    if (!inclusive) return false;
    const on = (a, b, p) => Math.abs(cross(a, b, p)) < EPSILON
        && p.x >= Math.min(a.x, b.x) - EPSILON && p.x <= Math.max(a.x, b.x) + EPSILON
        && p.y >= Math.min(a.y, b.y) - EPSILON && p.y <= Math.max(a.y, b.y) + EPSILON;
    return on(p3, p4, p1) || on(p3, p4, p2) || on(p1, p2, p3) || on(p1, p2, p4);
}

/**
 * Create the Foundry-version adapter hiding 13/14 API differences.
 * @param {object} [env]
 * @param {object} [env.canvas] Canvas override for tests.
 * @param {object} [env.game] Game override for tests.
 * @returns {object} Grid adapter.
 */
export function createGridAdapter(env = {}) {
    const _canvas = () => env.canvas ?? globalThis.canvas ?? null;
    const _game = () => env.game ?? globalThis.game ?? null;

    /**
     * The viewed scene or null.
     * @returns {object|null}
     */
    function scene() {
        return _canvas()?.scene ?? _game()?.scenes?.viewed ?? null;
    }

    /**
     * The active grid implementation (`BaseGrid` in v12+, GridLayer or a
     * scene-grid plain object in tests).
     * @returns {object|null}
     */
    function grid() {
        return _canvas()?.grid ?? scene()?.grid ?? null;
    }

    /**
     * Normalized grid descriptor `{kind, variant, type, size, distance,
     * units, diagonals, supported}` or null without a scene.
     * @returns {object|null}
     */
    function describe() {
        const sc = scene();
        if (!sc) return null;
        const g = grid();
        const type = sc.grid?.type ?? g?.type ?? null;
        const kind = gridKindOf(type) ?? gridKindOf(g);
        const variant = kind === GRID_KINDS.hex ? (hexVariantOf(type) ?? "odd-r") : null;
        const info = {
            sceneId: sc.id ?? null,
            type,
            kind,
            variant,
            size: sc.grid?.size ?? g?.size ?? _canvas()?.dimensions?.size ?? 100,
            distance: sc.grid?.distance ?? g?.distance ?? _canvas()?.dimensions?.distance ?? 1,
            units: sc.grid?.units ?? g?.units ?? "m",
            diagonals: diagonalRuleOf(sc, g),
            supported: kind === GRID_KINDS.square || kind === GRID_KINDS.hex
        };
        return info;
    }

    /**
     * Pixel point `{x, y}` to grid offset `{i, j}`. Uses
     * `canvas.grid.getOffset` (v12+) with a square-grid math fallback.
     * @param {object} point
     * @returns {{i: number, j: number}|null}
     */
    function toOffset(point) {
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
        if (Number.isFinite(point.i) && Number.isFinite(point.j)) return { i: point.i, j: point.j };
        const g = grid();
        try {
            if (typeof g?.getOffset === "function") {
                const offset = g.getOffset({ x: point.x, y: point.y });
                if (offset && Number.isFinite(offset.i) && Number.isFinite(offset.j)) {
                    return { i: Math.round(offset.i), j: Math.round(offset.j) };
                }
            }
        } catch(_err) {
            // Fall through to the square fallback.
        }
        const info = describe();
        if (info?.kind === GRID_KINDS.square) {
            return { i: Math.floor(point.y / info.size), j: Math.floor(point.x / info.size) };
        }
        return null;
    }

    /**
     * Grid offset to its top-left pixel point.
     * @param {object} offset
     * @returns {{x: number, y: number}|null}
     */
    function toTopLeft(offset) {
        if (!offset) return null;
        const g = grid();
        try {
            if (typeof g?.getTopLeftPoint === "function") {
                const point = g.getTopLeftPoint({ i: offset.i, j: offset.j });
                if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) return { x: point.x, y: point.y };
            }
        } catch(_err) {
            // Fall through to the square fallback.
        }
        const info = describe();
        if (info?.kind === GRID_KINDS.square) {
            return { x: offset.j * info.size, y: offset.i * info.size };
        }
        return null;
    }

    /**
     * Grid offset to its centre pixel point.
     * @param {object} offset
     * @returns {{x: number, y: number}|null}
     */
    function toCenter(offset) {
        const g = grid();
        try {
            if (typeof g?.getCenterPoint === "function") {
                const point = g.getCenterPoint({ i: offset.i, j: offset.j });
                if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) return { x: point.x, y: point.y };
            }
        } catch(_err) {
            // Fall through to the top-left fallback.
        }
        const topLeft = toTopLeft(offset);
        if (!topLeft) return null;
        const info = describe();
        const size = info?.size ?? 100;
        return { x: topLeft.x + (size / 2), y: topLeft.y + (size / 2) };
    }

    /**
     * Offset bounds `{iMin, jMin, iMax, jMax}` of the visible scene rect.
     * Derived through `toOffset` so scene padding is handled correctly.
     * @returns {object|null}
     */
    function bounds() {
        const sc = scene();
        if (!sc) return null;
        const dims = sc.dimensions ?? _canvas()?.dimensions ?? {};
        const size = describe()?.size ?? 100;
        // `toOffset` resolves scene-space coordinates (token x/y start at
        // 0,0 on the scene rect), so the bounds must come from the scene
        // rect in scene space. sceneX/sceneY/width/height on dimensions
        // describe the padded canvas rect instead — using them would
        // shift the playable area by the padding and mark tokens near
        // the scene edge out of bounds (issue #410).
        const width = Number.isFinite(sc.width) ? sc.width
            : (Number.isFinite(dims.sceneWidth) ? dims.sceneWidth
                : (Number.isFinite(dims.width) ? dims.width : 0));
        const height = Number.isFinite(sc.height) ? sc.height
            : (Number.isFinite(dims.sceneHeight) ? dims.sceneHeight
                : (Number.isFinite(dims.height) ? dims.height : 0));
        if (width <= 0 || height <= 0) {
            return { iMin: 0, jMin: 0, iMax: 0, jMax: 0 };
        }
        const min = toOffset({ x: 1, y: 1 }) ?? { i: 0, j: 0 };
        const max = toOffset({ x: width - 1, y: height - 1 })
            ?? { i: Math.ceil(height / size) - 1, j: Math.ceil(width / size) - 1 };
        return { iMin: min.i, jMin: min.j, iMax: max.i, jMax: max.j };
    }

    /**
     * Whether a wall-collision check reports the segment blocked.
     * Resolution order: `CONFIG.Canvas.polygonBackends` (v12+/v14),
     * `canvas.walls.checkCollision` (v13), manual wall-segment fallback.
     * @param {object} origin `{x, y}`.
     * @param {object} destination `{x, y}`.
     * @param {string} [sense] "move" | "sight".
     * @returns {boolean}
     */
    function checkCollision(origin, destination, sense = "move") {
        if (!origin || !destination) return true;
        const cv = _canvas();
        try {
            const backend = globalThis.CONFIG?.Canvas?.polygonBackends?.[sense];
            if (typeof backend?.testCollision === "function") {
                const hit = backend.testCollision(
                    { x: origin.x, y: origin.y },
                    { x: destination.x, y: destination.y },
                    { type: sense, mode: "any" }
                );
                if (typeof hit === "boolean") return hit;
            }
        } catch(_err) {
            // Fall through to the legacy layer below.
        }
        try {
            if (typeof cv?.walls?.checkCollision === "function") {
                const ray = { A: { x: origin.x, y: origin.y }, B: { x: destination.x, y: destination.y } };
                const options = sense === "move" ? { type: "move", mode: "any" } : { type: "sight", mode: "any" };
                return cv.walls.checkCollision(ray, options) === true;
            }
        } catch(_err) {
            // Fall through to the manual segment test.
        }
        for (const doc of _wallDocs(cv)) {
            if (!wallBlocks(doc, sense)) continue;
            const segment = _wallSegment(doc);
            if (segment && _segmentsIntersect(origin, destination, segment.A, segment.B)) return true;
        }
        return false;
    }

    /**
     * Sight-line test between two pixel points (negated sight collision).
     * @param {object} origin
     * @param {object} destination
     * @returns {boolean}
     */
    function hasLineOfSight(origin, destination) {
        return !checkCollision(origin, destination, "sight");
    }

    /**
     * Scene token documents other than `exclude` as an array.
     * @param {object|null} exclude Token document/placeable to skip.
     * @returns {object[]}
     */
    function tokens(exclude = null) {
        const cv = _canvas();
        const excluded = exclude?.document ?? exclude;
        const out = [];
        const seen = new Set();
        const push = token => {
            const doc = token?.document ?? token;
            if (!doc || doc === excluded || seen.has(doc)) return;
            seen.add(doc);
            out.push(doc);
        };
        for (const t of cv?.tokens?.placeables ?? cv?.tokens?.contents ?? []) push(t);
        if (!out.length) {
            const collection = cv?.scene?.tokens;
            const list = collection?.contents
                ?? (collection && typeof collection[Symbol.iterator] === "function" ? [...collection] : []);
            for (const t of list) push(t);
        }
        return out;
    }

    /**
     * Authoritative movement-cost measurement of a serialized waypoint
     * list: `TokenDocument#measureMovementPath` (v13+, honours difficult
     * terrain configured through region behaviours), `canvas.grid.
     * measurePath` (v12+/v14), then `measureDistance` per segment (v13).
     * Returns null when no API answered — callers fall back to the
     * geometric edge-cost sum.
     * @param {object|null} tokenDoc
     * @param {object[]} points `[{x, y}]` pixel waypoints.
     * @returns {number|null}
     */
    function measurePathCost(tokenDoc, points) {
        if (!Array.isArray(points) || points.length < 2) return 0;
        const input = points.map(p => ({ x: p.x, y: p.y }));
        try {
            if (typeof tokenDoc?.measureMovementPath === "function") {
                const result = tokenDoc.measureMovementPath(input);
                const cost = result?.cost ?? result?.distance;
                if (Number.isFinite(cost)) return cost;
            }
        } catch(_err) {
            // Fall through to the grid measurement.
        }
        const g = grid();
        try {
            if (typeof g?.measurePath === "function") {
                const result = g.measurePath(input);
                const cost = result?.cost ?? result?.distance;
                if (Number.isFinite(cost)) return cost;
            }
        } catch(_err) {
            // Fall through to per-segment measureDistance.
        }
        try {
            if (typeof g?.measureDistance === "function") {
                let total = 0;
                for (let index = 1; index < input.length; index++) {
                    const result = g.measureDistance(input[index - 1], input[index]);
                    const segment = result?.distance ?? result;
                    if (!Number.isFinite(segment)) return null;
                    total += segment;
                }
                return total;
            }
        } catch(_err) {
            // No measurement API available.
        }
        return null;
    }

    /**
     * Whether the platform can account for difficult terrain: a v13+ token
     * movement-cost path (`measureMovementPath` on token documents plus a
     * modify-movement-cost region behaviour) or a known terrain module.
     * @param {object|null} tokenDoc
     * @returns {boolean}
     */
    function supportsTerrain(tokenDoc = null) {
        try {
            if (typeof tokenDoc?.measureMovementPath === "function"
                && globalThis.foundry?.data?.regionBehaviors?.ModifyMovementCostRegionBehaviorType) {
                return true;
            }
        } catch(_err) {
            // Continue with module detection below.
        }
        const modules = _game()?.modules;
        for (const id of ["routinglib", "terrain-ruler", "terrain-randomizer", "enhanced-terrain-layer"]) {
            try {
                if (modules?.get?.(id)?.active === true) return true;
            } catch(_err) {
                // Detection is best-effort only.
            }
        }
        return false;
    }

    return {
        scene,
        grid,
        describe,
        toOffset,
        toTopLeft,
        toCenter,
        bounds,
        checkCollision,
        hasLineOfSight,
        tokens,
        measurePathCost,
        supportsTerrain
    };
}

/* ------------------------------------------------------------------------- */
/* Navigation context (snapshot → search primitives)                          */
/* ------------------------------------------------------------------------- */

/**
 * Unwrap a token placeable/document to its document-level fields.
 * @param {object} token
 * @returns {object|null}
 */
function _tokenDoc(token) {
    if (!token || typeof token !== "object") return null;
    const doc = token.document;
    if (doc && typeof doc === "object" && doc.documentName === "Token") return doc;
    return token;
}

/**
 * Cell-size footprint `{w, h}` of a token.
 * @param {object} token
 * @param {object} adapter
 * @returns {{w: number, h: number}}
 */
function _footprintOf(token, adapter) {
    const doc = _tokenDoc(token);
    const obj = token?.object ?? null;
    const size = adapter.describe()?.size ?? 100;
    const w = doc?.width ?? (Number.isFinite(obj?.w) ? obj.w / size : null);
    const h = doc?.height ?? (Number.isFinite(obj?.h) ? obj.h / size : null);
    return {
        w: Math.max(1, Math.round(Number.isFinite(w) ? w : 1)),
        h: Math.max(1, Math.round(Number.isFinite(h) ? h : 1))
    };
}

/**
 * All cells covered by a `w`x`h` footprint with top-left `offset`.
 * @param {object} offset
 * @param {object} footprint `{w, h}`
 * @returns {object[]}
 */
export function footprintCells(offset, footprint) {
    const cells = [];
    for (let i = offset.i; i < offset.i + footprint.h; i++) {
        for (let j = offset.j; j < offset.j + footprint.w; j++) {
            cells.push({ i, j });
        }
    }
    return cells;
}

/**
 * Build the search context for a token on the active scene: grid
 * descriptor, footprint, origin offset, bounds, reservations and the
 * primitive callbacks the pure search operates on.
 * @param {object} token Token placeable or document.
 * @param {object} [options]
 * @param {object} [options.adapter] Adapter override (tests/fixtures).
 * @param {string} [options.occupiedPolicy] "pass" (default, tokens can be
 *   crossed but not stood on) or "block" (treat as walls).
 * @param {Array} [options.reservations] Extra blocked cells: offsets
 *   `{i, j}` or `"i,j"` keys.
 * @returns {object} `{status, reason?, ...context}`.
 */
export function buildNavigationContext(token, options = {}) {
    const adapter = options.adapter ?? createGridAdapter();
    const grid = adapter.describe();
    if (!grid) {
        return { status: NAVIGATION_STATUS.failed, reason: NAVIGATION_REASONS.sceneUnavailable };
    }
    if (!grid.supported) {
        return {
            status: NAVIGATION_STATUS.failed,
            reason: NAVIGATION_REASONS.gridlessUnsupported,
            sceneId: grid.sceneId,
            grid: { kind: grid.kind, type: grid.type }
        };
    }
    const doc = _tokenDoc(token);
    const origin = doc
        ? adapter.toOffset({
            x: doc._source?.x ?? doc.x ?? token?.object?.x,
            y: doc._source?.y ?? doc.y ?? token?.object?.y
        })
        : null;
    if (!doc || !origin) {
        return {
            status: NAVIGATION_STATUS.failed,
            reason: NAVIGATION_REASONS.invalidInput,
            sceneId: grid.sceneId,
            grid: { kind: grid.kind, type: grid.type }
        };
    }
    const footprint = _footprintOf(token, adapter);
    const bounds = adapter.bounds() ?? { iMin: -1e9, jMin: -1e9, iMax: 1e9, jMax: 1e9 };
    const occupiedPolicy = options.occupiedPolicy === OCCUPIED_POLICIES.block
        ? OCCUPIED_POLICIES.block
        : OCCUPIED_POLICIES.pass;

    // Reservations: footprints of every other scene token plus explicit
    // caller reservations (waypoint locks, hazard cells).
    const reservations = new Set();
    for (const other of adapter.tokens(token)) {
        const o = adapter.toOffset({ x: other.x, y: other.y });
        if (!o) continue;
        const fp = _footprintOf(other, adapter);
        for (const cell of footprintCells(o, fp)) reservations.add(offsetKey(cell));
    }
    for (const entry of options.reservations ?? []) {
        if (typeof entry === "string") reservations.add(entry);
        else if (Number.isFinite(entry?.i) && Number.isFinite(entry?.j)) reservations.add(offsetKey(entry));
    }

    const size = grid.size;
    const fw = footprint.w * size;
    const fh = footprint.h * size;
    // Corner offsets (slightly inside the footprint edges) used to test
    // that a large token does not clip walls mid-step.
    const cornerOffsets = [
        { x: 0, y: 0 },
        { x: -0.45 * fw, y: -0.45 * fh },
        { x: 0.45 * fw, y: -0.45 * fh },
        { x: -0.45 * fw, y: 0.45 * fh },
        { x: 0.45 * fw, y: 0.45 * fh }
    ];
    const footprintCenter = offset => {
        const topLeft = adapter.toTopLeft(offset);
        return topLeft ? { x: topLeft.x + (fw / 2), y: topLeft.y + (fh / 2) } : null;
    };

    /**
     * All footprint cells inside the scene bounds.
     * @param {object} offset
     * @returns {boolean}
     */
    function fitsInside(offset) {
        return offset.i >= bounds.iMin && offset.j >= bounds.jMin
            && offset.i + footprint.h - 1 <= bounds.iMax
            && offset.j + footprint.w - 1 <= bounds.jMax;
    }

    /**
     * Whether any footprint cell is reserved (occupied by another token).
     * @param {object} offset
     * @returns {boolean}
     */
    function isReserved(offset) {
        for (const cell of footprintCells(offset, footprint)) {
            if (reservations.has(offsetKey(cell))) return true;
        }
        return false;
    }

    /**
     * Transit check: footprint fits and, under the "block" policy, is not
     * reserved. Occupied cells may always be crossed under "pass".
     * @param {object} offset
     * @returns {boolean}
     */
    function canStand(offset) {
        if (!fitsInside(offset)) return false;
        if (occupiedPolicy === OCCUPIED_POLICIES.block && isReserved(offset)) return false;
        return true;
    }

    /**
     * Endpoint check: transit plus "not occupied by another token".
     * @param {object} offset
     * @returns {boolean}
     */
    function canStop(offset) {
        return fitsInside(offset) && !isReserved(offset);
    }

    /**
     * Wall check of one step: the footprint centre segment plus the four
     * corner segments must all be collision-free.
     * @param {object} from
     * @param {object} to
     * @returns {boolean}
     */
    function isOpen(from, to) {
        const a = footprintCenter(from);
        const b = footprintCenter(to);
        if (!a || !b) return false;
        for (const corner of cornerOffsets) {
            const o = { x: a.x + corner.x, y: a.y + corner.y };
            const d = { x: b.x + corner.x, y: b.y + corner.y };
            if (adapter.checkCollision(o, d, "move")) return false;
        }
        return true;
    }

    const diagCost = diagonalCostOf(grid.diagonals);

    /**
     * Cell cost of a single step.
     * @param {object} from
     * @param {object} to
     * @param {boolean} diagonal
     * @returns {number}
     */
    function edgeCost(from, to, diagonal) {
        return diagonal ? diagCost : 1;
    }

    const center = {
        x: (doc._source?.x ?? doc.x) + (fw / 2),
        y: (doc._source?.y ?? doc.y) + (fh / 2)
    };

    return {
        status: NAVIGATION_STATUS.ok,
        sceneId: grid.sceneId,
        grid,
        adapter,
        bounds,
        footprint,
        occupiedPolicy,
        reservations,
        origin: { offset: origin, point: center },
        tokenDoc: doc,
        terrainSupported: adapter.supportsTerrain(doc),
        neighbors: offset => neighborOffsets(offset, grid),
        edgeCost,
        isOpen,
        canStand,
        canStop,
        fitsInside,
        isReserved,
        toOffset: point => adapter.toOffset(point),
        toPoint: offset => footprintCenter(offset),
        los: (a, b) => adapter.hasLineOfSight(a, b),
        moveBlocked: (a, b) => adapter.checkCollision(a, b, "move"),
        measureCost: points => adapter.measurePathCost(doc, points)
    };
}

/* ------------------------------------------------------------------------- */
/* Route planning on a context                                                */
/* ------------------------------------------------------------------------- */

/**
 * Normalize a destination argument (`{x, y}` pixels, `{i, j}` offset or a
 * token-like object) to a grid offset.
 * @param {*} destination
 * @param {object} context
 * @returns {{i: number, j: number}|null}
 */
function _destinationOffset(destination, context) {
    if (!destination) return null;
    if (Number.isFinite(destination.i) && Number.isFinite(destination.j)) {
        return { i: destination.i, j: destination.j };
    }
    if (Number.isFinite(destination.x) && Number.isFinite(destination.y)) {
        return context.toOffset(destination);
    }
    const doc = _tokenDoc(destination);
    const docX = doc?._source?.x ?? doc?.x;
    const docY = doc?._source?.y ?? doc?.y;
    if (doc && Number.isFinite(docX) && Number.isFinite(docY)) {
        return context.toOffset({ x: docX, y: docY });
    }
    return null;
}

/**
 * Failure result helper (frozen, serializable).
 * @param {string} reason
 * @param {object} [extra]
 * @returns {object}
 */
function _failure(reason, extra = {}) {
    return _deepFreeze({
        status: NAVIGATION_STATUS.failed,
        reason,
        path: [],
        waypoints: [],
        cost: 0,
        budget: null,
        endpoint: null,
        exact: false,
        partial: false,
        visitedNodes: 0,
        revision: null,
        ...extra
    });
}

/**
 * Serialize an offset path to pixel waypoints `{x, y, i, j}` — no canvas
 * objects, safe to persist or send over the wire.
 * @param {object[]} path
 * @param {object} context
 * @returns {object[]}
 */
function _serializePath(path, context) {
    return (path ?? []).map(offset => {
        const point = context.toPoint(offset) ?? { x: null, y: null };
        return { x: point.x, y: point.y, i: offset.i, j: offset.j };
    });
}

/**
 * Deterministic revision fingerprint of the inputs that define a route.
 * @param {object} parts
 * @returns {string}
 */
function _revision(parts) {
    return _fnv1a(JSON.stringify(parts));
}

/**
 * Plan a route on a prepared context. Core of `planRoute`, split out so
 * unit tests can run it on injected contexts without a canvas.
 * @param {object} context Result of {@link buildNavigationContext}.
 * @param {*} destination `{x, y}` | `{i, j}` | token-like.
 * @param {number} budgetCells Maximum path cost in cell units.
 * @param {object} [options]
 * @param {number} [options.maxVisited] A* expansion bound.
 * @returns {object} PathResult `{status, reason?, path/waypoints, cost,
 *   costCells, budget, budgetCells, endpoint, exact, partial,
 *   visitedNodes, ms, revision, approximations}`.
 */
export function planRouteOnContext(context, destination, budgetCells, options = {}) {
    const started = _now();
    if (context?.status !== NAVIGATION_STATUS.ok) {
        return _failure(context?.reason ?? NAVIGATION_REASONS.sceneUnavailable);
    }
    const goal = _destinationOffset(destination, context);
    if (!goal || !Number.isFinite(budgetCells) || budgetCells < 0) {
        return _failure(NAVIGATION_REASONS.invalidInput, { sceneId: context.sceneId });
    }

    const start = context.origin.offset;
    const result = searchRoute({
        start,
        goal,
        getNeighbors: context.neighbors,
        edgeCost: context.edgeCost,
        isOpen: context.isOpen,
        canStand: context.canStand,
        canStop: context.canStop,
        heuristic: offset => heuristicCells(offset, goal, context.grid),
        budget: budgetCells,
        maxVisited: options.maxVisited ?? DEFAULT_SEARCH_LIMIT
    });

    const distance = context.grid.distance;
    const budgetMeters = budgetCells * distance;
    const approximations = [];
    if (!context.terrainSupported) approximations.push("difficult-terrain-not-modelled");

    const revision = _revision({
        scene: context.sceneId,
        grid: [context.grid.type, context.grid.size, context.grid.distance, context.grid.diagonals],
        origin: [start.i, start.j],
        goal: [goal.i, goal.j],
        budget: Math.round(budgetCells * 1000),
        footprint: [context.footprint.w, context.footprint.h],
        reservations: [...context.reservations].sort()
    });

    /**
     * Assemble the serializable result for a chosen offset path.
     * @param {object[]} path
     * @param {number} costCells
     * @param {object} meta `{status, reason, exact}`
     * @returns {object}
     */
    function _result(path, costCells, meta) {
        const waypoints = _serializePath(path, context);
        const points = waypoints.map(w => ({ x: w.x, y: w.y }));
        const measured = context.measureCost?.(points);
        const costMeters = Number.isFinite(measured) ? measured : costCells * distance;
        const endpoint = waypoints.length ? waypoints[waypoints.length - 1] : null;
        return _deepFreeze({
            status: meta.status,
            reason: meta.reason ?? null,
            path: waypoints,
            waypoints,
            cost: Math.round(costMeters * 1000) / 1000,
            costCells: Math.round(costCells * 1000) / 1000,
            budget: Math.round(budgetMeters * 1000) / 1000,
            budgetCells: Math.round(budgetCells * 1000) / 1000,
            endpoint,
            exact: meta.exact === true,
            partial: meta.status === NAVIGATION_STATUS.partial,
            visitedNodes: result.visited,
            ms: Math.round((_now() - started) * 100) / 100,
            revision,
            approximations,
            sceneId: context.sceneId
        });
    }

    if (result.status === "found") {
        let path = result.path;
        let costCells = result.cost;
        // Authoritative re-measure (difficult terrain when supported): if
        // the measured cost exceeds the budget, truncate to the longest
        // prefix that still fits — a conservative partial route.
        const waypoints = _serializePath(path, context);
        const measured = context.measureCost?.(waypoints.map(w => ({ x: w.x, y: w.y })));
        if (Number.isFinite(measured) && measured > budgetMeters + EPSILON) {
            // The platform-measured cost (e.g. difficult terrain) exceeds the
            // budget even though the geometric cost fits. Keep the longest
            // prefix whose measured cost still fits.
            let used = 0;
            let keep = 1;
            for (let index = 1; index < path.length; index++) {
                const prefix = _serializePath(path.slice(0, index + 1), context)
                    .map(w => ({ x: w.x, y: w.y }));
                const prefixCost = context.measureCost?.(prefix);
                if (!Number.isFinite(prefixCost) || prefixCost > budgetMeters + EPSILON) break;
                used += context.edgeCost(path[index - 1], path[index],
                    path[index].i !== path[index - 1].i && path[index].j !== path[index - 1].j);
                keep = index + 1;
            }
            path = path.slice(0, keep);
            costCells = used;
            if (path.length <= 1) {
                return _result(path, 0, {
                    status: NAVIGATION_STATUS.failed,
                    reason: NAVIGATION_REASONS.budgetExceeded
                });
            }
            return _result(path, costCells, {
                status: NAVIGATION_STATUS.partial,
                reason: NAVIGATION_REASONS.budgetExceeded
            });
        }
        return _result(path, costCells, { status: NAVIGATION_STATUS.ok, exact: true });
    }

    if (result.status === "limit") {
        return _result(result.path ?? [start], result.cost ?? 0, {
            status: NAVIGATION_STATUS.failed,
            reason: NAVIGATION_REASONS.searchLimit
        });
    }

    // No exact route: return the best standable cell as a partial route.
    let reason = NAVIGATION_REASONS.pathNotFound;
    if (!context.fitsInside(goal)) {
        reason = NAVIGATION_REASONS.endpointOutOfBounds;
    } else if (!context.canStop(goal)) {
        reason = NAVIGATION_REASONS.endpointOccupied;
    } else if (result.best && (result.best.g + result.best.h) > budgetCells + EPSILON) {
        reason = NAVIGATION_REASONS.budgetExceeded;
    }
    const path = result.path ?? [start];
    return _result(path, result.cost ?? 0, { status: NAVIGATION_STATUS.partial, reason });
}

/**
 * Validate a destination for a token: reachable endpoint shape (bounds,
 * reservations). Wall reachability is covered by {@link planRouteOnContext}.
 * @param {object} context
 * @param {*} destination
 * @returns {object} `{status, valid, reason?, endpoint}`.
 */
export function validateEndpointOnContext(context, destination) {
    if (context?.status !== NAVIGATION_STATUS.ok) {
        return _failure(context?.reason ?? NAVIGATION_REASONS.sceneUnavailable);
    }
    const goal = _destinationOffset(destination, context);
    if (!goal) return _failure(NAVIGATION_REASONS.invalidInput);
    const point = context.toPoint(goal) ?? { x: null, y: null };
    const endpoint = { x: point.x, y: point.y, i: goal.i, j: goal.j };
    if (!context.fitsInside(goal)) {
        return _deepFreeze({
            status: NAVIGATION_STATUS.ok,
            valid: false,
            reason: NAVIGATION_REASONS.endpointOutOfBounds,
            endpoint
        });
    }
    if (!context.canStop(goal)) {
        return _deepFreeze({
            status: NAVIGATION_STATUS.ok,
            valid: false,
            reason: NAVIGATION_REASONS.endpointOccupied,
            endpoint
        });
    }
    return _deepFreeze({
        status: NAVIGATION_STATUS.ok,
        valid: true,
        reason: null,
        endpoint
    });
}

/**
 * All standable cells reachable within the budget, deterministically
 * ordered by (cost, i, j).
 * @param {object} context
 * @param {number} budgetCells
 * @param {object} [options]
 * @param {number} [options.limit] Maximum returned cells.
 * @param {number} [options.maxVisited] Flood-fill expansion bound.
 * @returns {object} `{status, reason?, cells, visitedNodes, limited}`.
 */
export function findReachableOnContext(context, budgetCells, options = {}) {
    if (context?.status !== NAVIGATION_STATUS.ok) {
        return _failure(context?.reason ?? NAVIGATION_REASONS.sceneUnavailable);
    }
    if (!Number.isFinite(budgetCells) || budgetCells < 0) {
        return _failure(NAVIGATION_REASONS.invalidInput);
    }
    const result = floodReachable({
        start: context.origin.offset,
        getNeighbors: context.neighbors,
        edgeCost: context.edgeCost,
        isOpen: context.isOpen,
        canStand: context.canStand,
        canStop: context.canStop,
        budget: budgetCells,
        maxVisited: options.maxVisited ?? DEFAULT_SEARCH_LIMIT,
        limit: options.limit ?? DEFAULT_RESULT_LIMIT
    });
    const cells = result.cells.map(cell => {
        const point = context.toPoint(cell) ?? { x: null, y: null };
        return {
            i: cell.i,
            j: cell.j,
            x: point.x,
            y: point.y,
            costCells: Math.round(cell.cost * 1000) / 1000,
            cost: Math.round(cell.cost * context.grid.distance * 1000) / 1000
        };
    });
    return _deepFreeze({
        status: NAVIGATION_STATUS.ok,
        reason: null,
        cells,
        visitedNodes: result.visited,
        limited: result.limited,
        sceneId: context.sceneId
    });
}

/**
 * Destination candidates for presets: reachable cells scored by proximity
 * to `options.target` plus optional line-of-sight and cover terms. LOS
 * prefers the `perception` service when one is supplied via
 * `options.perception`, otherwise uses the geometric wall test. Cover is
 * estimated as the fraction of sight lines (centre + four corners) from
 * the candidate to the target that walls block.
 * @param {object} context
 * @param {number} budgetCells
 * @param {object} [options]
 * @param {*} [options.target] Pixel point or token-like the NPC approaches.
 * @param {number} [options.count] Max candidates (default 8).
 * @param {boolean} [options.requireLOS] Drop candidates without LOS.
 * @param {boolean} [options.includeCover] Compute the cover estimate.
 * @param {object} [options.weights] Score weight overrides.
 * @param {object|null} [options.perception] Perception service (optional).
 * @param {number} [options.limit] Reachable-cell bound.
 * @returns {object} `{status, reason?, candidates, visitedNodes}`.
 */
export function findCandidatesOnContext(context, budgetCells, options = {}) {
    if (context?.status !== NAVIGATION_STATUS.ok) {
        return _failure(context?.reason ?? NAVIGATION_REASONS.sceneUnavailable);
    }
    if (!Number.isFinite(budgetCells) || budgetCells < 0) {
        return _failure(NAVIGATION_REASONS.invalidInput);
    }
    const weights = { ...DEFAULT_CANDIDATE_WEIGHTS, ...(options.weights ?? {}) };
    const targetDoc = _tokenDoc(options.target);
    const targetPoint = targetDoc && Number.isFinite(targetDoc.x)
        ? {
            x: targetDoc.x + ((targetDoc.width ?? 1) * context.grid.size / 2),
            y: targetDoc.y + ((targetDoc.height ?? 1) * context.grid.size / 2)
        }
        : (Number.isFinite(options.target?.x) && Number.isFinite(options.target?.y)
            ? { x: options.target.x, y: options.target.y }
            : null);

    const reachable = findReachableOnContext(context, budgetCells, { limit: options.limit });
    if (reachable.status !== NAVIGATION_STATUS.ok) return reachable;

    const size = context.grid.size;
    const candidates = [];
    for (const cell of reachable.cells) {
        const point = { x: cell.x, y: cell.y };
        const distance = targetPoint
            ? Math.hypot(point.x - targetPoint.x, point.y - targetPoint.y) / size * context.grid.distance
            : null;
        let los = null;
        if (targetPoint) {
            const viaPerception = options.perception
                && typeof options.perception.hasLineOfSight === "function"
                && targetDoc
                ? options.perception.hasLineOfSight({ center: point, document: null }, targetDoc)
                : null;
            los = typeof viaPerception === "boolean" ? viaPerception : context.los(point, targetPoint);
            if (options.requireLOS === true && !los) continue;
        }
        let cover = null;
        if (targetPoint && options.includeCover === true) {
            cover = estimateCover(point, targetPoint, context);
        }
        const score = (weights.distance * -(distance ?? 0))
            + (weights.los * (los === true ? 1 : 0))
            + (weights.cover * (cover ?? 0));
        candidates.push({ x: cell.x, y: cell.y, i: cell.i, j: cell.j, cost: cell.cost, distance, los, cover, score });
    }
    candidates.sort((a, b) => (b.score - a.score) || (a.i - b.i) || (a.j - b.j));
    const count = Number.isFinite(options.count) ? options.count : DEFAULT_CANDIDATE_COUNT;
    const selected = candidates.slice(0, Math.max(0, count));
    // Attach wall-aware waypoints so consumers (planner move steps,
    // preview routes, fireteam reservations) can serialize an executable
    // path instead of straight-lining into a wall. Only the selected
    // destinations get an A* pass — scoring stays flood-fill cheap.
    for (const candidate of selected) {
        const route = planRouteOnContext(context, { i: candidate.i, j: candidate.j },
            budgetCells, options);
        if (route.status === NAVIGATION_STATUS.ok && Array.isArray(route.waypoints)) {
            candidate.waypoints = route.waypoints;
        }
    }
    return _deepFreeze({
        status: NAVIGATION_STATUS.ok,
        reason: null,
        candidates: selected,
        evaluated: candidates.length,
        visitedNodes: reachable.visitedNodes,
        sceneId: context.sceneId
    });
}

/* ------------------------------------------------------------------------- */
/* Movement budget (system API contract #398)                                 */
/* ------------------------------------------------------------------------- */

/**
 * Unwrap an actor reference: actor document, token placeable/document or
 * combatant.
 * @param {*} ref
 * @returns {object|null}
 */
function _actorOf(ref) {
    if (!ref || typeof ref !== "object") return null;
    if (ref.documentName === "Actor" || ref.type === "npc" || ref.type === "acolyte") return ref;
    const doc = _tokenDoc(ref);
    return doc?.actor ?? ref.actor ?? null;
}

/**
 * Normalized movement rates `{half, full, charge, run}` in scene units.
 * Primary source: `game.darkHeresy.api.movement.getRates(actor)` (async,
 * issue #398). Fallback: prepared `actor.system.movement`.
 * @param {*} actorRef Actor, token or combatant.
 * @returns {Promise<object>} `{status, rates?, source?, reason?}`.
 */
export async function getMovementRates(actorRef) {
    const actor = _actorOf(actorRef);
    if (!actor) {
        return { status: NAVIGATION_STATUS.failed, reason: NAVIGATION_REASONS.invalidInput };
    }
    const normalize = value => {
        if (!value || typeof value !== "object") return null;
        const rates = {
            half: Number(value.half) || 0,
            full: Number(value.full) || 0,
            charge: Number(value.charge) || 0,
            run: Number(value.run) || 0
        };
        return rates;
    };
    try {
        const api = globalThis.game?.darkHeresy?.api;
        if (typeof api?.movement?.getRates === "function") {
            const result = await api.movement.getRates(actor);
            const rates = normalize(result);
            if (rates) return { status: NAVIGATION_STATUS.ok, rates, source: "system-api" };
        }
    } catch(_err) {
        // Fall back to prepared actor data below.
    }
    const rates = normalize(actor.system?.movement);
    if (rates) return { status: NAVIGATION_STATUS.ok, rates, source: "actor-data" };
    return { status: NAVIGATION_STATUS.failed, reason: NAVIGATION_REASONS.ratesUnavailable };
}

/**
 * Normalize a budget argument to `{meters, cells, mode}`.
 * Accepts: number (scene units), `{meters}`, `{cells}` or `{mode}` (one of
 * `half|full|charge|run`, resolved against `rates`).
 * @param {*} budget
 * @param {object|null} [rates] `{half, full, charge, run}` in scene units.
 * @param {number} gridDistance Scene units per cell.
 * @returns {object} `{status, meters?, cells?, mode?, reason?}`.
 */
export function resolveBudget(budget, rates = null, gridDistance = 1) {
    const distance = Number.isFinite(gridDistance) && gridDistance > 0 ? gridDistance : 1;
    let meters = null;
    let mode = null;
    if (Number.isFinite(budget)) {
        meters = budget;
    } else if (budget && typeof budget === "object") {
        if (Number.isFinite(budget.meters)) meters = budget.meters;
        else if (Number.isFinite(budget.cells)) meters = budget.cells * distance;
        else if (typeof budget.mode === "string") {
            mode = budget.mode;
            if (!MOVEMENT_MODES.includes(mode)) {
                return { status: NAVIGATION_STATUS.failed, reason: NAVIGATION_REASONS.invalidInput };
            }
            const value = rates?.[mode];
            if (!Number.isFinite(value)) {
                return { status: NAVIGATION_STATUS.failed, reason: NAVIGATION_REASONS.ratesUnavailable };
            }
            meters = value;
        }
    }
    if (!Number.isFinite(meters) || meters < 0) {
        return { status: NAVIGATION_STATUS.failed, reason: NAVIGATION_REASONS.invalidInput };
    }
    return {
        status: NAVIGATION_STATUS.ok,
        meters,
        cells: meters / distance,
        mode
    };
}

/**
 * Fraction of footprint probe points blocked from the target point by
 * walls — the same estimate {@link findCandidates} attaches to move
 * candidates. Shared so callers injecting their own moves (planner
 * tests, presets) get identical cover semantics.
 * @param {{x: number, y: number}} point Cell centre in pixels.
 * @param {{x: number, y: number}} targetPoint Target point in pixels.
 * @param {object} context Navigation context from
 *   {@link buildNavigationContext}.
 * @returns {number} 0..1 cover fraction.
 */
export function estimateCover(point, targetPoint, context) {
    if (typeof context?.los !== "function" || !point || !targetPoint) return 0;
    const size = context?.grid?.size ?? 100;
    const fw = (context?.footprint?.w ?? 1) * size;
    const fh = (context?.footprint?.h ?? 1) * size;
    const probes = [
        point,
        { x: point.x - (0.45 * fw), y: point.y - (0.45 * fh) },
        { x: point.x + (0.45 * fw), y: point.y - (0.45 * fh) },
        { x: point.x - (0.45 * fw), y: point.y + (0.45 * fh) },
        { x: point.x + (0.45 * fw), y: point.y + (0.45 * fh) }
    ];
    // A probe counts as covered when the line crosses a wall in any sense:
    // sight walls give full concealment, move-only walls (barricades) give
    // partial cover without breaking line of sight.
    const covered = p => context.los(p, targetPoint) !== true
        || context.moveBlocked?.(p, targetPoint) === true;
    return probes.filter(covered).length / probes.length;
}

/* ------------------------------------------------------------------------- */
/* Public service                                                             */
/* ------------------------------------------------------------------------- */

/**
 * Create the `navigation` service published as
 * `api.services.get("navigation")`. Pure route planning — read-only, never
 * moves tokens, never writes flags.
 * @param {object} [deps]
 * @param {object} [deps.api] Module API (optional `perception` lookup).
 * @param {object} [deps.adapter] Grid adapter override (tests/fixtures).
 * @returns {object} Navigation service.
 */
export function createNavigationService({ api = null, adapter = null } = {}) {
    const _adapter = () => adapter ?? createGridAdapter();

    /** Resolved movement rates per actor id — lets `{mode}` budgets work
     *  synchronously after the first async `getMovementRates` call. */
    const _ratesCache = new Map();

    /**
     * `getMovementRates` with per-actor caching for subsequent
     * `{mode}` budgets.
     * @param {*} ref Actor, token or combatant.
     * @returns {Promise<object>}
     */
    async function movementRates(ref) {
        const result = await getMovementRates(ref);
        const actor = _actorOf(ref);
        const key = actor?.id ?? actor?.uuid;
        if (result.status === NAVIGATION_STATUS.ok && result.rates && key) {
            _ratesCache.set(key, result.rates);
        }
        return result;
    }

    /**
     * Rates for a token from `options`, then the per-actor cache.
     * @param {*} token
     * @param {object} options
     * @returns {object|null}
     */
    function _rates(token, options = {}) {
        if (options.rates) return options.rates;
        const actor = _actorOf(token);
        const key = actor?.id ?? actor?.uuid;
        return (key && _ratesCache.get(key)) || null;
    }

    /**
     * Prepared context for a token or a frozen failure result.
     * @param {object} token
     * @param {object} options
     * @returns {object}
     */
    function _context(token, options = {}) {
        if (options.context) return options.context;
        return buildNavigationContext(token, { adapter: _adapter(), ...options });
    }

    /**
     * Budget in cell units from any accepted budget form. When `budget`
     * requests a movement mode, rates come from `options.rates` or the
     * per-actor cache filled by {@link getMovementRates}.
     * @param {*} budget
     * @param {object} context
     * @param {object} options
     * @param {*} token
     * @returns {object}
     */
    function _cells(budget, context, options = {}, token = null) {
        return resolveBudget(budget, _rates(token, options), context?.grid?.distance ?? 1);
    }

    /**
     * Optional perception service for LOS-aware candidates. Resolved
     * lazily so a missing #401 service never breaks navigation.
     * @returns {object|null}
     */
    function _perception() {
        try {
            return api?.services?.get?.("perception") ?? null;
        } catch(_err) {
            return null;
        }
    }

    /**
     * Grid info of the active scene.
     * @returns {object}
     */
    function gridInfo() {
        const grid = _adapter().describe();
        return grid ?? { supported: false, kind: null };
    }

    /**
     * Plan a route: `{status, reason?, path, cost, endpoint, exact,
     * partial, budget, visitedNodes, ms, revision, approximations}`.
     * Unreachable endpoints return the best standable waypoint with
     * `status: "partial"` for "move toward last known position" presets.
     * @param {object} token
     * @param {*} destination `{x, y}` | `{i, j}` | token-like.
     * @param {*} budget Scene units or `{meters|cells|mode}`.
     * @param {object} [options] Forwarded to the context builder plus
     *   `{rates, maxVisited, context}`.
     * @returns {object}
     */
    function planRoute(token, destination, budget, options = {}) {
        const context = _context(token, options);
        if (context.status !== NAVIGATION_STATUS.ok) {
            return _failure(context.reason);
        }
        const resolved = _cells(budget, context, options, token);
        if (resolved.status !== NAVIGATION_STATUS.ok) {
            return _failure(resolved.reason);
        }
        const result = planRouteOnContext(context, destination, resolved.cells, options);
        logDiagnostics("navigation: planRoute", {
            status: result.status,
            reason: result.reason,
            cost: result.cost,
            visited: result.visitedNodes,
            ms: result.ms
        });
        return result;
    }

    /**
     * Whether the destination is reachable within the budget with an
     * exact (non-partial) route.
     * @param {object} token
     * @param {*} destination
     * @param {*} budget
     * @param {object} [options]
     * @returns {object} `{status, reachable, reason?, cost?}`.
     */
    function canReach(token, destination, budget, options = {}) {
        const result = planRoute(token, destination, budget, options);
        return _deepFreeze({
            status: result.status === NAVIGATION_STATUS.failed ? NAVIGATION_STATUS.failed : NAVIGATION_STATUS.ok,
            reachable: result.status === NAVIGATION_STATUS.ok && result.exact === true,
            reason: result.reason,
            cost: result.cost,
            endpoint: result.endpoint
        });
    }

    /**
     * One-call mode-based planning: resolves the token's movement rates
     * through the system API (async), then plans a route for
     * `{mode}` — `half|full|charge|run`.
     * @param {object} token
     * @param {*} destination
     * @param {string} mode `half|full|charge|run`.
     * @param {object} [options]
     * @returns {Promise<object>} Same shape as {@link planRoute}.
     */
    async function planRouteForMode(token, destination, mode, options = {}) {
        if (!MOVEMENT_MODES.includes(mode)) {
            return _failure(NAVIGATION_REASONS.invalidInput);
        }
        const ratesResult = await movementRates(token);
        if (ratesResult.status !== NAVIGATION_STATUS.ok) {
            return _failure(ratesResult.reason);
        }
        return planRoute(token, destination, { mode }, { ...options, rates: ratesResult.rates });
    }

    /**
     * Endpoint validation: bounds, footprint fit, occupied cells.
     * @param {object} token
     * @param {*} destination
     * @param {object} [options]
     * @returns {object}
     */
    function validateEndpoint(token, destination, options = {}) {
        const context = _context(token, options);
        return validateEndpointOnContext(context, destination);
    }

    /**
     * All standable cells reachable within the budget.
     * @param {object} token
     * @param {*} budget
     * @param {object} [options]
     * @returns {object}
     */
    function findReachable(token, budget, options = {}) {
        const context = _context(token, options);
        if (context.status !== NAVIGATION_STATUS.ok) {
            return _failure(context.reason);
        }
        const resolved = _cells(budget, context, options, token);
        if (resolved.status !== NAVIGATION_STATUS.ok) {
            return _failure(resolved.reason);
        }
        return findReachableOnContext(context, resolved.cells, options);
    }

    /**
     * Destination candidates for presets: reachable cells scored by
     * target proximity, LOS (perception service preferred, geometric
     * fallback) and optional cover estimate.
     * @param {object} token
     * @param {*} budget
     * @param {object} [options] `{target, count, requireLOS, includeCover,
     *   weights, rates, limit}`.
     * @returns {object}
     */
    function findCandidates(token, budget, options = {}) {
        const context = _context(token, options);
        if (context.status !== NAVIGATION_STATUS.ok) {
            return _failure(context.reason);
        }
        const resolved = _cells(budget, context, options, token);
        if (resolved.status !== NAVIGATION_STATUS.ok) {
            return _failure(resolved.reason);
        }
        return findCandidatesOnContext(context, resolved.cells, {
            ...options,
            perception: options.perception === undefined ? _perception() : options.perception
        });
    }

    /**
     * Measure a serialized waypoint list in scene units (authoritative
     * platform measurement when available, geometric sum otherwise).
     * @param {object} token
     * @param {object[]} waypoints `[{x, y}]` or `[{i, j}]`.
     * @param {object} [options]
     * @returns {object} `{status, cost, waypoints}`.
     */
    function measurePath(token, waypoints, options = {}) {
        const context = _context(token, options);
        if (context.status !== NAVIGATION_STATUS.ok) {
            return _failure(context.reason);
        }
        const offsets = (waypoints ?? [])
            .map(w => _destinationOffset(w, context))
            .filter(Boolean);
        if (offsets.length < 2) {
            return _failure(NAVIGATION_REASONS.invalidInput);
        }
        let cells = 0;
        for (let index = 1; index < offsets.length; index++) {
            cells += cellPathCost(offsets[index - 1], offsets[index], context.grid);
        }
        const points = offsets.map(o => context.toPoint(o));
        const measured = context.measureCost?.(points);
        return _deepFreeze({
            status: NAVIGATION_STATUS.ok,
            cost: Number.isFinite(measured) ? measured : cells * context.grid.distance,
            costCells: Math.round(cells * 1000) / 1000,
            waypoints: _serializePath(offsets, context)
        });
    }

    return {
        gridInfo,
        getMovementRates: movementRates,
        resolveBudget,
        /**
         * Cover fraction of a candidate cell against a target point.
         * Builds the navigation context internally.
         * @param {*} token Token document used for the footprint context.
         * @param {{x: number, y: number}} point Candidate centre in pixels.
         * @param {{x: number, y: number}} targetPoint Target point.
         * @param {object} [options] Context overrides.
         * @returns {number}
         */
        coverEstimate(token, point, targetPoint, options = {}) {
            try {
                return estimateCover(point, targetPoint, _context(token, options));
            } catch(_err) {
                return 0;
            }
        },
        planRoute,
        planRouteForMode,
        canReach,
        validateEndpoint,
        findReachable,
        findCandidates,
        measurePath,
        createGridAdapter,
        buildNavigationContext
    };
}
