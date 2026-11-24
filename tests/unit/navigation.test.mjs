/**
 * Unit tests for the navigation service (issue #402): grid-type detection,
 * square/hex neighbour generation, budget validation, token footprint,
 * occupied-cell reservations, partial routes and the Foundry 13/14
 * collision adapter fallbacks. All tests run on injected adapters — no
 * canvas required.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    DEFAULT_SEARCH_LIMIT,
    GRID_KINDS,
    NAVIGATION_REASONS,
    NAVIGATION_STATUS,
    buildNavigationContext,
    createGridAdapter,
    createNavigationService,
    diagonalCostOf,
    diagonalRuleOf,
    findCandidatesOnContext,
    findReachableOnContext,
    floodReachable,
    footprintCells,
    getMovementRates,
    gridKindOf,
    heuristicCells,
    hexDistance,
    hexVariantOf,
    neighborOffsets,
    offsetToAxial,
    planRouteOnContext,
    resolveBudget,
    searchRoute,
    validateEndpointOnContext,
    wallBlocks
} from "../../scripts/navigation.js";
import { createPlannerService } from "../../scripts/planner.js";
import { registerRangedCoverPreset } from "../../scripts/presets/ranged-cover.js";
import { makeActor, makeCombat, makeCombatant } from "./fixtures.mjs";

/* ------------------------------------------------------------------------- */
/* Mocks                                                                      */
/* ------------------------------------------------------------------------- */

let _id = 0;

/**
 * Next deterministic mock id.
 * @returns {string}
 */
function _nextId() {
    return `nav-${++_id}`;
}

/**
 * Segment intersection including endpoint touches (test-local mirror of
 * the adapter's manual fallback).
 * @param {object} p1
 * @param {object} p2
 * @param {object} p3
 * @param {object} p4
 * @returns {boolean}
 */
function _intersect(p1, p2, p3, p4) {
    const cross = (a, b, p) => ((b.x - a.x) * (p.y - a.y)) - ((b.y - a.y) * (p.x - a.x));
    const d1 = cross(p3, p4, p1);
    const d2 = cross(p3, p4, p2);
    const d3 = cross(p1, p2, p3);
    const d4 = cross(p1, p2, p4);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
        && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    const eps = 1e-9;
    const on = (a, b, p) => Math.abs(cross(a, b, p)) < eps
        && p.x >= Math.min(a.x, b.x) - eps && p.x <= Math.max(a.x, b.x) + eps
        && p.y >= Math.min(a.y, b.y) - eps && p.y <= Math.max(a.y, b.y) + eps;
    return on(p3, p4, p1) || on(p3, p4, p2) || on(p1, p2, p3) || on(p1, p2, p4);
}

/**
 * Wall document fixture.
 * @param {number[]} c `[x1, y1, x2, y2]`.
 * @param {object} [extra]
 * @returns {object}
 */
function mockWall(c, extra = {}) {
    return { documentName: "Wall", c, move: 1, sight: 1, door: 0, ds: 0, ...extra };
}

/**
 * Token document fixture.
 * @param {object} [options]
 * @returns {object}
 */
function mockToken({ id, x = 0, y = 0, width = 1, height = 1, actor = null } = {}) {
    return {
        documentName: "Token",
        id: id ?? _nextId(),
        x,
        y,
        width,
        height,
        actor: actor ?? {
            documentName: "Actor",
            id: `actor-${_id}`,
            type: "npc",
            system: { movement: { half: 3, full: 6, charge: 9, run: 18 } }
        }
    };
}

/**
 * Adapter fixture implementing the contract used by
 * {@link buildNavigationContext}: describe/toOffset/toTopLeft/toCenter/
 * bounds/checkCollision/hasLineOfSight/tokens/measurePathCost/
 * supportsTerrain.
 * @param {object} [options]
 * @returns {object}
 */
function mockAdapter({
    type = 1,
    size = 100,
    distance = 1.5,
    cols = 5,
    rows = 5,
    walls = [],
    others = [],
    diagonals = "equidistant",
    terrain = false,
    measureCost = null
} = {}) {
    const kind = type === 0 ? GRID_KINDS.gridless
        : type === 1 ? GRID_KINDS.square
            : GRID_KINDS.hex;
    const variant = { 2: "odd-r", 3: "even-r", 4: "odd-q", 5: "even-q" }[type] ?? null;
    const scene = {
        id: "scene-1",
        grid: { type, size, distance, units: "m", diagonals },
        width: cols * size,
        height: rows * size,
        tokens: { contents: others },
        walls: { contents: walls }
    };
    return {
        scene: () => scene,
        describe: () => ({
            sceneId: scene.id,
            type,
            kind,
            variant,
            size,
            distance,
            units: "m",
            diagonals,
            supported: kind === GRID_KINDS.square || kind === GRID_KINDS.hex
        }),
        toOffset: point => ({ i: Math.floor(point.y / size), j: Math.floor(point.x / size) }),
        toTopLeft: offset => ({ x: offset.j * size, y: offset.i * size }),
        toCenter: offset => ({ x: offset.j * size + size / 2, y: offset.i * size + size / 2 }),
        bounds: () => ({ iMin: 0, jMin: 0, iMax: rows - 1, jMax: cols - 1 }),
        checkCollision: (origin, destination, sense = "move") => walls.some(doc => {
            if (!wallBlocks(doc, sense)) return false;
            const c = doc.c;
            return _intersect(origin, destination, { x: c[0], y: c[1] }, { x: c[2], y: c[3] });
        }),
        hasLineOfSight(origin, destination) {
            return !this.checkCollision(origin, destination, "sight");
        },
        tokens: exclude => others.filter(doc => doc !== exclude && doc !== exclude?.document),
        measurePathCost: (tokenDoc, points) => (measureCost ? measureCost(points) : null),
        supportsTerrain: () => terrain
    };
}

/**
 * Build a navigation context directly (the buildNavigationContext path).
 * @param {object} token
 * @param {object} adapterOptions
 * @param {object} [contextOptions]
 * @returns {object}
 */
function contextFor(token, adapterOptions = {}, contextOptions = {}) {
    return buildNavigationContext(token, {
        adapter: mockAdapter(adapterOptions),
        ...contextOptions
    });
}

/**
 * Navigation service bound to a mock adapter.
 * @param {object} adapterOptions
 * @param {object} [serviceOptions]
 * @returns {object}
 */
function serviceFor(adapterOptions = {}, serviceOptions = {}) {
    return createNavigationService({
        adapter: mockAdapter(adapterOptions),
        ...serviceOptions
    });
}

/**
 * Result without the non-deterministic timing field.
 * @param {object} result
 * @returns {object}
 */
function _sansTiming(result) {
    const { ms, ...rest } = result;
    return rest;
}

/* ------------------------------------------------------------------------- */
/* Grid description                                                           */
/* ------------------------------------------------------------------------- */

test("gridKindOf/hexVariantOf normalize Foundry grid types", () => {
    assert.equal(gridKindOf(0), "gridless");
    assert.equal(gridKindOf(1), "square");
    assert.equal(gridKindOf(2), "hex");
    assert.equal(gridKindOf(5), "hex");
    assert.equal(gridKindOf("square"), "square");
    assert.equal(gridKindOf({ isHexagonal: true }), "hex");
    assert.equal(gridKindOf(null), null);
    assert.equal(hexVariantOf(2), "odd-r");
    assert.equal(hexVariantOf(3), "even-r");
    assert.equal(hexVariantOf(4), "odd-q");
    assert.equal(hexVariantOf(5), "even-q");
    assert.equal(hexVariantOf(1), null);
});

test("diagonalRuleOf accepts numeric and string forms", () => {
    // Foundry 13 CONST.GRID_DIAGONALS enum (issue #32).
    assert.equal(diagonalRuleOf({ grid: { diagonals: 0 } }), "equidistant");
    assert.equal(diagonalRuleOf({ grid: { diagonals: 1 } }), "exact");
    assert.equal(diagonalRuleOf({ grid: { diagonals: 2 } }), "approximate");
    assert.equal(diagonalRuleOf({ grid: { diagonals: 3 } }), "rectilinear");
    assert.equal(diagonalRuleOf({ grid: { diagonals: 4 } }), "approximate");
    assert.equal(diagonalRuleOf({ grid: { diagonals: 5 } }), "approximate");
    assert.equal(diagonalRuleOf({ grid: { diagonals: 6 } }), "illegal");
    assert.equal(diagonalRuleOf({ grid: {} }), "equidistant");
    assert.equal(diagonalRuleOf(null), "equidistant");
    assert.equal(diagonalRuleOf({ grid: { diagonals: "exact" } }), "exact");
    assert.equal(diagonalCostOf("exact"), Math.SQRT2);
    assert.equal(diagonalCostOf("rectilinear"), 2);
    assert.equal(diagonalCostOf("equidistant"), 1);
    assert.equal(diagonalCostOf("illegal"), Number.POSITIVE_INFINITY);
});

test("wallBlocks covers numeric and object wall schemas", () => {
    assert.equal(wallBlocks({ move: 1 }), true);
    assert.equal(wallBlocks({ move: 0 }), false);
    assert.equal(wallBlocks({ move: { enabled: true, type: "normal" } }), true);
    assert.equal(wallBlocks({ move: { enabled: false, type: "normal" } }), false);
    assert.equal(wallBlocks({ move: { type: "none" } }), false);
    assert.equal(wallBlocks({ sight: 20 }, "sight"), true);
    assert.equal(wallBlocks({ move: 1, door: 1, ds: 1 }), false, "open door never blocks");
    assert.equal(wallBlocks({ move: 1, door: { state: "open" } }), false);
    assert.equal(wallBlocks({ move: 1, door: { state: "closed" } }), true);
});

/* ------------------------------------------------------------------------- */
/* Neighbour generation                                                       */
/* ------------------------------------------------------------------------- */

test("square neighbours: 8 directions with diagonal flags", () => {
    const grid = { kind: "square" };
    const neighbors = neighborOffsets({ i: 2, j: 2 }, grid);
    assert.equal(neighbors.length, 8);
    assert.equal(neighbors.filter(n => n.diagonal).length, 4);
    assert.ok(neighbors.some(n => n.i === 2 && n.j === 3 && !n.diagonal));
    assert.ok(neighbors.some(n => n.i === 3 && n.j === 3 && n.diagonal));
});

test("hex neighbours: 6 cells, symmetric for every variant", () => {
    for (const variant of ["odd-r", "even-r", "odd-q", "even-q"]) {
        const grid = { kind: "hex", variant };
        for (const cell of [{ i: 0, j: 0 }, { i: 1, j: 1 }, { i: 2, j: 3 }, { i: -1, j: 2 }]) {
            const neighbors = neighborOffsets(cell, grid);
            assert.equal(neighbors.length, 6, `${variant} @${cell.i},${cell.j}`);
            for (const n of neighbors) {
                const back = neighborOffsets(n, grid);
                assert.ok(back.some(b => b.i === cell.i && b.j === cell.j),
                    `${variant}: ${cell.i},${cell.j} <-> ${n.i},${n.j} asymmetric`);
            }
        }
    }
});

test("hex distance via axial conversion", () => {
    for (const variant of ["odd-r", "even-r", "odd-q", "even-q"]) {
        const grid = { kind: "hex", variant };
        const a = { i: 3, j: 3 };
        assert.equal(hexDistance(a, a, variant), 0);
        for (const n of neighborOffsets(a, grid)) {
            assert.equal(hexDistance(a, n, variant), 1, `${variant} neighbour distance`);
        }
        // BFS distance equals hexDistance for open grids.
        const target = { i: 0, j: 0 };
        const seen = new Map([[`${a.i},${a.j}`, 0]]);
        const queue = [a];
        while (queue.length) {
            const cur = queue.shift();
            const d = seen.get(`${cur.i},${cur.j}`);
            if (cur.i === target.i && cur.j === target.j) {
                assert.equal(d, hexDistance(a, target, variant), variant);
                break;
            }
            for (const n of neighborOffsets(cur, grid)) {
                const key = `${n.i},${n.j}`;
                if (!seen.has(key)) {
                    seen.set(key, d + 1);
                    queue.push(n);
                }
            }
        }
    }
    assert.deepEqual(offsetToAxial({ i: 0, j: 0 }, "even-r"), { q: 0, r: 0 });
    assert.ok(Number.isFinite(heuristicCells({ i: 0, j: 0 }, { i: 2, j: 2 }, { kind: "hex", variant: "odd-r" })));
});

/* ------------------------------------------------------------------------- */
/* Route planning                                                             */
/* ------------------------------------------------------------------------- */

test("square grid: direct route within budget", () => {
    const token = mockToken({ x: 0, y: 0 });
    const context = contextFor(token);
    const result = planRouteOnContext(context, { i: 2, j: 3 }, 10);
    assert.equal(result.status, "ok");
    assert.equal(result.exact, true);
    assert.equal(result.partial, false);
    assert.deepEqual([result.path[0].i, result.path[0].j], [0, 0]);
    assert.deepEqual([result.endpoint.i, result.endpoint.j], [2, 3]);
    // Equidistant diagonals: max(2,3)=3 steps x 1.5m.
    assert.equal(result.costCells, 3);
    assert.equal(result.cost, 4.5);
    assert.equal(result.budget, 15);
    assert.ok(result.visitedNodes > 0);
    assert.ok(result.revision);
});

test("square grid: route detours around a wall", () => {
    // Vertical wall x=200 covering rows 0-3; only row 4 is open.
    const walls = [mockWall([200, 0, 200, 400])];
    const token = mockToken({ x: 0, y: 0 });
    const context = contextFor(token, { walls });
    const result = planRouteOnContext(context, { i: 0, j: 4 }, 20);
    assert.equal(result.status, "ok", `expected exact route, got ${result.reason}`);
    assert.equal(result.costCells, 9);
    // Every crossing between j=1 and j=2 must happen on the open row 4.
    for (let index = 1; index < result.path.length; index++) {
        const prev = result.path[index - 1];
        const next = result.path[index];
        if ((prev.j <= 1 && next.j >= 2) || (prev.j >= 2 && next.j <= 1)) {
            assert.equal(Math.max(prev.i, next.i), 4, "wall crossing only on row 4");
        }
    }
    // Deterministic: identical inputs produce an identical route.
    const again = planRouteOnContext(contextFor(token, { walls }), { i: 0, j: 4 }, 20);
    assert.deepEqual(_sansTiming(again), _sansTiming(result));
});

test("planner approaches a remembered contact through a door even when the first move leads away", async () => {
    const actor = makeActor({ enabled: true, preset: "rangedCover" });
    const token = mockToken({ id: "bot", x: 200, y: 300, actor });
    const enemy = mockToken({ id: "outside", x: 100, y: 300 });
    const door = mockWall([600, 300, 600, 500], { door: 1 });
    const adapter = mockAdapter({
        rows: 9, cols: 9, distance: 1, diagonals: "illegal", others: [enemy],
        walls: [
            mockWall([200, 200, 600, 200]),
            mockWall([200, 600, 600, 600]),
            mockWall([200, 200, 200, 600]),
            mockWall([600, 200, 600, 300]),
            door,
            mockWall([600, 500, 600, 600])
        ]
    });
    const combatant = makeCombatant({ token });
    const combat = makeCombat({ round: 1, combatants: [combatant] });
    combat.scene = adapter.scene();
    const planner = createPlannerService();
    registerRangedCoverPreset(planner);
    const context = {
        seed: 7, personality: false, threatMap: false,
        navigation: createNavigationService({ adapter }),
        actions: [{ id: "shot", type: "attack", class: "basic", range: 3, damage: 6 }],
        rates: { half: 1, full: 2, charge: 3, run: 6 },
        targets: [{
            tokenId: enemy.id, x: 150, y: 350, source: "last-known", canAttack: false
        }]
    };
    const closed = context.navigation.planRoute(token, context.targets[0], 2, { followDetour: true });
    assert.equal(closed.reason, NAVIGATION_REASONS.pathNotFound);
    door.ds = 1;
    for (const x of [450, 650]) {
        const { plan } = await planner.planTurn(combat, combatant, context);
        const move = plan.steps.find(step => step.type === "move");
        assert.equal(move?.input.to.x, x, "follow the legal detour instead of hugging the west wall");
        assert.ok(move.input.waypoints.length > 1);
        assert.ok(move.cost.movement <= context.rates.full);
        token.x = x - 50;
        token.y = move.input.to.y - 50;
        combat.round++;
    }
});

test("square grid: budget exceeded returns best partial waypoint", () => {
    const token = mockToken({ x: 0, y: 0 });
    const context = contextFor(token);
    const result = planRouteOnContext(context, { i: 4, j: 4 }, 3);
    assert.equal(result.status, "partial");
    assert.equal(result.partial, true);
    assert.equal(result.exact, false);
    assert.equal(result.reason, NAVIGATION_REASONS.budgetExceeded);
    assert.deepEqual([result.endpoint.i, result.endpoint.j], [3, 3]);
    assert.ok(result.cost <= result.budget);
});

test("occupied endpoint: partial route to a standable neighbour", () => {
    const blocker = mockToken({ id: "blocker", x: 400, y: 0 });
    const token = mockToken({ x: 0, y: 0 });
    const context = contextFor(token, { others: [blocker] });
    const endpoint = validateEndpointOnContext(context, { i: 0, j: 4 });
    assert.equal(endpoint.valid, false);
    assert.equal(endpoint.reason, NAVIGATION_REASONS.endpointOccupied);
    const result = planRouteOnContext(context, { i: 0, j: 4 }, 20);
    assert.equal(result.status, "partial");
    assert.equal(result.reason, NAVIGATION_REASONS.endpointOccupied);
    assert.notDeepEqual([result.endpoint.i, result.endpoint.j], [0, 4]);
    // The partial endpoint is a valid standable cell next to the blocker.
    assert.ok(Math.abs(result.endpoint.i - 0) <= 1 && Math.abs(result.endpoint.j - 4) <= 1);
});

test("occupied cells may be crossed but not stopped on (policy pass)", () => {
    const blocker = mockToken({ id: "mid", x: 200, y: 0 });
    const token = mockToken({ x: 0, y: 0 });
    const context = contextFor(token, { others: [blocker] });
    assert.equal(context.canStand({ i: 0, j: 2 }), true, "occupied cell passable under pass");
    assert.equal(context.canStop({ i: 0, j: 2 }), false, "occupied cell not standable");
    const result = planRouteOnContext(context, { i: 0, j: 4 }, 20);
    assert.equal(result.status, "ok");
    const blocked = contextFor(token, { others: [blocker] }, { occupiedPolicy: "block" });
    assert.equal(blocked.canStand({ i: 0, j: 2 }), false, "occupied cell blocked under block");
});

test("token footprint: 2x2 endpoint must fully fit and be free", () => {
    const token = mockToken({ x: 0, y: 0, width: 2, height: 2 });
    const context = contextFor(token);
    assert.deepEqual([context.footprint.w, context.footprint.h], [2, 2]);
    // Top-left (0,4) would hang out of the 5-column grid.
    const endpoint = validateEndpointOnContext(context, { i: 0, j: 4 });
    assert.equal(endpoint.valid, false);
    assert.equal(endpoint.reason, NAVIGATION_REASONS.endpointOutOfBounds);
    // A 1x1 blocker on (0,4) invalidates the 2x2 stand at (0,3).
    const blocker = mockToken({ id: "blk", x: 400, y: 0 });
    const crowded = contextFor(token, { others: [blocker] });
    const blockedEndpoint = validateEndpointOnContext(crowded, { i: 0, j: 3 });
    assert.equal(blockedEndpoint.valid, false);
    assert.equal(blockedEndpoint.reason, NAVIGATION_REASONS.endpointOccupied);
    const result = planRouteOnContext(crowded, { i: 0, j: 3 }, 20);
    assert.equal(result.status, "partial");
    assert.equal(result.reason, NAVIGATION_REASONS.endpointOccupied);
    assert.notDeepEqual([result.endpoint.i, result.endpoint.j], [0, 3]);
});

test("footprintCells covers the w x h block", () => {
    assert.deepEqual(footprintCells({ i: 1, j: 1 }, { w: 2, h: 2 }), [
        { i: 1, j: 1 }, { i: 1, j: 2 }, { i: 2, j: 1 }, { i: 2, j: 2 }
    ]);
});

test("gridless scenes are rejected before planning", () => {
    const token = mockToken({ x: 0, y: 0 });
    const context = contextFor(token, { type: 0 });
    assert.equal(context.status, "failed");
    assert.equal(context.reason, NAVIGATION_REASONS.gridlessUnsupported);
    const service = serviceFor({ type: 0 });
    const result = service.planRoute(token, { x: 200, y: 200 }, 6);
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "gridless-unsupported");
    assert.equal(service.canReach(token, { x: 200, y: 200 }, 6).reachable, false);
});

test("hex grid: path uses 1-cost hex steps", () => {
    const token = mockToken({ x: 0, y: 0 });
    const context = contextFor(token, { type: 3, distance: 2 });
    assert.equal(context.status, "ok");
    assert.equal(context.grid.kind, "hex");
    assert.equal(context.grid.variant, "even-r");
    const result = planRouteOnContext(context, { i: 0, j: 4 }, 10);
    assert.equal(result.status, "ok");
    assert.equal(result.costCells, 4, "four hex steps");
    assert.equal(result.cost, 8);
});

test("search limit produces a bounded failure, never a hang", () => {
    const token = mockToken({ x: 0, y: 0 });
    const context = contextFor(token, { cols: 50, rows: 50 });
    const result = planRouteOnContext(context, { i: 49, j: 49 }, 200, { maxVisited: 5 });
    assert.equal(result.status, "failed");
    assert.equal(result.reason, NAVIGATION_REASONS.searchLimit);
    assert.ok(result.visitedNodes <= 5 + 1);
});

test("unreachable endpoint behind sealed walls returns path-not-found", () => {
    // Goal cell (0,4) sealed by walls on all four sides.
    const walls = [
        mockWall([400, -50, 500, 50]),   // Top of (0,4) segment area.
        mockWall([400, 50, 500, 150]),   // Below.
        mockWall([350, 0, 350, 100])     // Left edge of goal cell.
    ];
    const token = mockToken({ x: 0, y: 0 });
    const context = contextFor(token, { walls });
    const result = planRouteOnContext(context, { i: 0, j: 4 }, 50);
    assert.equal(result.status, "partial");
    assert.ok([NAVIGATION_REASONS.pathNotFound, NAVIGATION_REASONS.endpointOccupied].includes(result.reason));
    assert.notDeepEqual([result.endpoint.i, result.endpoint.j], [0, 4]);
});

/* ------------------------------------------------------------------------- */
/* Reachable cells and candidates                                             */
/* ------------------------------------------------------------------------- */

test("findReachable: equidistant square ball of radius 2", () => {
    const token = mockToken({ x: 0, y: 0 });
    const context = contextFor(token);
    const result = findReachableOnContext(context, 2);
    assert.equal(result.status, "ok");
    // Token sits in the corner, so the ball is a 3x3 block, not 5x5.
    assert.equal(result.cells.length, 9, "Chebyshev ball clipped by the grid corner");
    // Sorted by (cost, i, j); origin first.
    assert.deepEqual([result.cells[0].i, result.cells[0].j, result.cells[0].cost], [0, 0, 0]);
    for (let index = 1; index < result.cells.length; index++) {
        assert.ok(result.cells[index].cost >= result.cells[index - 1].cost);
    }
});

test("findReachable: budget boundary is respected exactly", () => {
    const token = mockToken({ x: 0, y: 0 });
    const context = contextFor(token);
    const withinOne = findReachableOnContext(context, 1);
    assert.equal(withinOne.cells.length, 4, "2x2 block at the corner");
    const zero = findReachableOnContext(context, 0);
    assert.equal(zero.cells.length, 1, "only the origin");
});

test("findCandidates: scored by proximity and LOS", () => {
    const token = mockToken({ x: 0, y: 0 });
    const context = contextFor(token, { cols: 8, rows: 8 });
    const result = findCandidatesOnContext(context, 4, {
        target: { x: 750, y: 50 },
        count: 5
    });
    assert.equal(result.status, "ok");
    assert.equal(result.candidates.length, 5);
    // The candidate closest to the target ranks first.
    const first = result.candidates[0];
    assert.equal(first.los, true);
    for (let index = 1; index < result.candidates.length; index++) {
        assert.ok(result.candidates[index].score <= result.candidates[index - 1].score + 1e-9);
    }
});

test("findCandidates: requireLOS drops sight-blocked cells", () => {
    const walls = [mockWall([250, 0, 250, 500])];
    const token = mockToken({ x: 0, y: 0 });
    const context = contextFor(token, { walls, cols: 5, rows: 5 });
    const result = findCandidatesOnContext(context, 6, {
        target: { x: 450, y: 250 },
        requireLOS: true,
        count: 50
    });
    assert.equal(result.status, "ok");
    for (const candidate of result.candidates) {
        assert.equal(candidate.los, true);
    }
});

/* ------------------------------------------------------------------------- */
/* Budget / rates                                                             */
/* ------------------------------------------------------------------------- */

test("resolveBudget: numbers, cells and movement modes", () => {
    assert.equal(resolveBudget(6, null, 1.5).cells, 4);
    assert.equal(resolveBudget({ meters: 6 }, null, 1.5).cells, 4);
    assert.equal(resolveBudget({ cells: 4 }, null, 1.5).meters, 6);
    const rates = { half: 3, full: 6, charge: 9, run: 18 };
    assert.equal(resolveBudget({ mode: "charge" }, rates, 1.5).meters, 9);
    assert.equal(resolveBudget({ mode: "run" }, rates, 1.5).cells, 12);
    assert.equal(resolveBudget({ mode: "run" }, null, 1.5).reason, NAVIGATION_REASONS.ratesUnavailable);
    assert.equal(resolveBudget({ mode: "fly" }, rates, 1.5).reason, NAVIGATION_REASONS.invalidInput);
    assert.equal(resolveBudget(-1, null, 1.5).reason, NAVIGATION_REASONS.invalidInput);
    assert.equal(resolveBudget(null, null, 1.5).reason, NAVIGATION_REASONS.invalidInput);
});

test("getMovementRates: system API first, actor fallback", async () => {
    const token = mockToken();
    const previous = globalThis.game?.darkHeresy?.api?.movement;
    try {
        game.darkHeresy.api.movement = {
            getRates: async actor => ({ status: "ok", half: 2, full: 4, charge: 6, run: 12 })
        };
        const viaApi = await getMovementRates(token);
        assert.equal(viaApi.status, "ok");
        assert.equal(viaApi.source, "system-api");
        assert.deepEqual(viaApi.rates, { half: 2, full: 4, charge: 6, run: 12 });
        game.darkHeresy.api.movement = undefined;
        const fallback = await getMovementRates(token);
        assert.equal(fallback.status, "ok");
        assert.equal(fallback.source, "actor-data");
        assert.deepEqual(fallback.rates, { half: 3, full: 6, charge: 9, run: 18 });
        const noRates = await getMovementRates(mockToken({ actor: { type: "npc", system: {} } }));
        assert.equal(noRates.status, "failed");
        assert.equal(noRates.reason, NAVIGATION_REASONS.ratesUnavailable);
    } finally {
        if (previous === undefined) delete game.darkHeresy.api.movement;
        else game.darkHeresy.api.movement = previous;
    }
});

/* ------------------------------------------------------------------------- */
/* Service surface                                                            */
/* ------------------------------------------------------------------------- */

test("service.planRoute/canReach/validateEndpoint/measurePath", () => {
    const service = serviceFor();
    const token = mockToken({ x: 0, y: 0 });
    const route = service.planRoute(token, { i: 2, j: 2 }, 6);
    assert.equal(route.status, "ok");
    assert.equal(route.path === route.waypoints, true, "path aliases waypoints");
    assert.ok(route.path.every(w => Number.isFinite(w.x) && Number.isFinite(w.i)));

    const reach = service.canReach(token, { i: 4, j: 4 }, 4);
    assert.equal(reach.status, "ok");
    assert.equal(reach.reachable, false, "4 steps = 6m exceeds a 4m budget");
    const closer = service.canReach(token, { i: 3, j: 3 }, 6);
    assert.equal(closer.reachable, true);

    const endpoint = service.validateEndpoint(token, { i: 1, j: 1 });
    assert.equal(endpoint.valid, true);

    const measured = service.measurePath(token, [{ i: 0, j: 0 }, { i: 0, j: 2 }]);
    assert.equal(measured.status, "ok");
    assert.equal(measured.cost, 3, "2 cells x 1.5m");
});

test("measurePath fallback prices orthogonal travel when diagonals are forbidden", () => {
    const service = serviceFor({ diagonals: "illegal", distance: 2 });
    const token = mockToken();
    const start = { i: 0, j: 0 };
    const straight = service.measurePath(token, [start, { i: 0, j: 2 }]);
    const offset = service.measurePath(token, [start, { i: 2, j: 1 }]);
    assert.equal(straight.cost, 4);
    assert.equal(offset.cost, 6);

    const route = service.planRoute(token, { i: 2, j: 1 }, 6);
    assert.equal(route.status, "ok");
    assert.equal(route.cost, offset.cost);
    assert.equal(route.path.length, 4, "no diagonal edges");
});

test("Foundry token measurement prices the same document waypoints the executor uses", () => {
    const scene = { grid: { type: 1, size: 100, distance: 1 }, width: 600, height: 600 };
    const adapter = createGridAdapter({ canvas: { scene } });
    const token = mockToken({ width: 2 });
    token.measureMovementPath = points => {
        assert.deepEqual(points, [{ x: 0, y: 0 }, { x: 100, y: 0 }]);
        return { cost: 2 };
    };
    // Use a non-default native cost to distinguish it from the fallback.
    const route = createNavigationService({ adapter }).planRoute(token, { i: 0, j: 1 }, 2);
    assert.equal(route.status, "ok");
    assert.equal(route.cost, 2);
});

test("service.planRoute accepts mode budgets via options.rates", () => {
    const service = serviceFor();
    const token = mockToken({ x: 0, y: 0 });
    const rates = { half: 3, full: 6, charge: 9, run: 18 };
    const ok = service.planRoute(token, { i: 2, j: 2 }, { mode: "half" }, { rates });
    assert.equal(ok.status, "ok");
    const missing = service.planRoute(token, { i: 2, j: 2 }, { mode: "half" });
    assert.equal(missing.status, "failed");
    assert.equal(missing.reason, NAVIGATION_REASONS.ratesUnavailable);
});

test("service.planRouteForMode resolves rates and caches them", async () => {
    const service = serviceFor();
    const token = mockToken({ x: 0, y: 0 });
    // Actor fallback rates: half 3m / full 6m / charge 9m / run 18m.
    const half = await service.planRouteForMode(token, { i: 2, j: 2 }, "half");
    assert.equal(half.status, "ok");
    assert.equal(half.budget, 3);
    const tight = await service.planRouteForMode(token, { i: 4, j: 4 }, "half");
    assert.equal(tight.status, "partial", "half move cannot reach (4,4)");
    assert.equal(tight.reason, NAVIGATION_REASONS.budgetExceeded);
    // Cached rates: a bare {mode} budget now works without options.rates.
    const cached = service.planRoute(token, { i: 2, j: 2 }, { mode: "full" });
    assert.equal(cached.status, "ok");
    assert.equal(cached.budget, 6);
    const bad = await service.planRouteForMode(token, { i: 1, j: 1 }, "fly");
    assert.equal(bad.status, "failed");
    assert.equal(bad.reason, NAVIGATION_REASONS.invalidInput);
});

test("service.findReachable/findCandidates honour budgets", () => {
    const service = serviceFor();
    const token = mockToken({ x: 0, y: 0 });
    const reachable = service.findReachable(token, 3);
    assert.equal(reachable.status, "ok");
    assert.equal(reachable.cells.length, 9, "3m budget = 2 cells = 3x3 corner block");
    const candidates = service.findCandidates(token, 3, { count: 3 });
    assert.equal(candidates.status, "ok");
    assert.equal(candidates.candidates.length, 3);
});

test("difficult terrain: measured cost is authoritative for budget", () => {
    const token = mockToken({ x: 0, y: 0 });
    // Measured cost doubles the geometric estimate (3m per step): the
    // exact route to (0,2) fits a 2-cell budget geometrically but the
    // platform reports 6m — it must degrade to a partial route.
    const context = contextFor(token, {
        measureCost: points => (points.length - 1) * 3
    });
    const result = planRouteOnContext(context, { i: 0, j: 2 }, 2);
    assert.equal(result.status, "partial");
    assert.equal(result.reason, NAVIGATION_REASONS.budgetExceeded);
    assert.ok(result.path.length < 3, "route truncated to the affordable prefix");
    const flat = contextFor(token);
    assert.equal(flat.terrainSupported, false);
    const approximation = planRouteOnContext(flat, { i: 0, j: 2 }, 5);
    assert.ok(approximation.approximations.includes("difficult-terrain-not-modelled"));
});

test("difficult terrain also limits partial routes and never stops on an occupied prefix", () => {
    const token = mockToken();
    const context = contextFor(token, {
        rows: 1,
        cols: 6,
        distance: 1,
        others: [mockToken({ x: 200 })],
        measureCost: points => (points.length - 1) * 2
    });
    const route = planRouteOnContext(context, { i: 0, j: 5 }, 4);
    assert.equal(route.status, "partial");
    assert.deepEqual([route.endpoint.i, route.endpoint.j], [0, 1]);
    assert.equal(route.cost, 2);
});

test("movement candidates carry measured costs and only executable routes", () => {
    const context = contextFor(mockToken(), {
        rows: 1,
        distance: 1,
        measureCost: points => (points.length - 1) * 2
    });
    const result = findCandidatesOnContext(context, 3, {
        target: { x: 350, y: 50 }, count: 4
    });
    assert.deepEqual(result.candidates.map(move => [move.j, move.cost]), [[1, 2], [0, 0]]);
    assert.ok(result.candidates.every(move => move.waypoints.at(-1).j === move.j));
});

test("A* core: deterministic order and visited bound", () => {
    const grid = { kind: "square" };
    const input = {
        start: { i: 0, j: 0 },
        goal: { i: 4, j: 4 },
        getNeighbors: offset => neighborOffsets(offset, grid)
            .filter(n => n.i >= 0 && n.j >= 0 && n.i <= 4 && n.j <= 4),
        edgeCost: (a, b, diagonal) => (diagonal ? 1 : 1),
        isOpen: () => true,
        canStand: () => true,
        canStop: () => true,
        heuristic: offset => heuristicCells(offset, { i: 4, j: 4 }, grid),
        budget: Infinity,
        maxVisited: DEFAULT_SEARCH_LIMIT
    };
    const first = searchRoute(input);
    const second = searchRoute(input);
    assert.equal(first.status, "found");
    assert.equal(first.cost, 4);
    assert.deepEqual(first.path, second.path);
    const limited = searchRoute({ ...input, maxVisited: 1 });
    assert.equal(limited.status, "limit");
    const flooded = floodReachable({
        start: { i: 0, j: 0 },
        getNeighbors: input.getNeighbors,
        edgeCost: input.edgeCost,
        isOpen: input.isOpen,
        canStand: input.canStand,
        canStop: input.canStop,
        budget: 1,
        limit: 100
    });
    assert.equal(flooded.cells.length, 4, "corner ball of radius 1");
});
