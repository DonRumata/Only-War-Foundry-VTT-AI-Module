import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import * as h from './lib.mjs';

const names = {
    npc: 'AI Navigation NPC',
    blocker: 'AI Navigation Blocker'
};

let page;
let browser;
let npcId;
let blockerId;
const sceneIds = [];

async function probeEnvironment() {
    try {
        const res = await fetch(h.FOUNDRY_URL, { signal: AbortSignal.timeout(5000) });
        if (!res.ok && res.status >= 500) return false;
    } catch {
        return false;
    }
    try {
        browser = await chromium.connectOverCDP(h.CDP_URL);
        return true;
    } catch {
        return false;
    }
}

async function createScene(grid) {
    const id = await h.createTestScene(page, { grid });
    sceneIds.push(id);
    return id;
}

async function createWalls(sceneId, walls) {
    return page.evaluate(async (data) => {
        const scene = game.scenes.get(data.sceneId);
        await scene.createEmbeddedDocuments('Wall', data.walls);
        return true;
    }, { sceneId, walls });
}

async function planRoute(sceneId, tokenId, destination, budget) {
    return page.evaluate(async (data) => {
        const nav = game.modules.get('only-war-ai')?.api?.services?.get('navigation');
        if (!nav) return { status: 'failed', reason: 'service-missing' };
        const scene = game.scenes.get(data.sceneId);
        if (canvas.scene?.id !== scene.id) await scene.activate();
        await new Promise(r => setTimeout(r, 300));
        const token = scene.tokens.get(data.tokenId);
        return nav.planRoute(token, data.destination, data.budget);
    }, { sceneId, tokenId, destination, budget });
}

async function testServiceRegistered() {
    const info = await page.evaluate(() => {
        const api = game.modules.get('only-war-ai')?.api;
        const nav = api?.services?.get?.('navigation');
        return {
            registered: !!nav,
            capability: api?.capabilities?.['navigation.planRoute'] === true,
            methods: nav ? ['planRoute', 'canReach', 'findCandidates', 'validateEndpoint']
                .map(m => typeof nav[m]) : []
        };
    });
    assert.equal(info.registered, true, 'navigation service registered');
    assert.equal(info.capability, true, 'navigation capability published');
    assert.ok(info.methods.every(m => m === 'function'), 'service methods present');
}

async function testSquareRouteAroundWall() {
    const sceneId = await createScene(1);
    const tokenId = await h.placeToken(page, sceneId, npcId, { x: 500, y: 500 });
    // Vertical wall at x=1000 covering y=400..1600 вЂ” the route from
    // (5,5) to (5,15) must detour to rows 0-3 or 16-19.
    await createWalls(sceneId, [
        { c: [1000, 400, 1000, 1600], move: 20, sight: 20, door: 0 }
    ]);
    const result = await planRoute(sceneId, tokenId, { x: 1550, y: 550 }, 30);
    assert.equal(result.status, 'ok', `expected exact route, got ${result.status}:${result.reason}`);
    assert.equal(result.exact, true);
    // Equidistant diagonals cost 1 step, so the detour can equal the
    // straight-line cell cost вЂ” assert the *pixel* length instead.
    let length = 0;
    for (let i = 1; i < result.path.length; i++) {
        length += Math.hypot(result.path[i].x - result.path[i - 1].x,
            result.path[i].y - result.path[i - 1].y);
    }
    assert.ok(length > 1000, `detour length ${length} exceeds straight 1000px`);
    assert.ok(Array.isArray(result.path) && result.path.length >= 2);
    assert.ok(result.path.every(w => Number.isFinite(w.x) && Number.isFinite(w.y)
        && Number.isFinite(w.i) && Number.isFinite(w.j)), 'path is serializable');
    // No step may cross the wall segment x=1000, y in [400,1600].
    for (let index = 1; index < result.path.length; index++) {
        const a = result.path[index - 1];
        const b = result.path[index];
        const crosses = (a.x < 1000 && b.x > 1000) || (a.x > 1000 && b.x < 1000);
        if (crosses) {
            const t = (1000 - a.x) / (b.x - a.x);
            const yAt = a.y + (b.y - a.y) * t;
            assert.ok(yAt < 400 || yAt > 1600, `step ${index} crosses the wall at y=${yAt}`);
        }
    }
}

async function testMeasuredTerrainBudget() {
    const sceneId = await createScene(1);
    const tokenId = await h.placeToken(page, sceneId, npcId, { x: 500, y: 500 });
    const costs = await page.evaluate(async ({ sceneId, tokenId }) => {
        const scene = game.scenes.get(sceneId);
        const nav = game.modules.get('only-war-ai').api.services.get('navigation');
        const token = scene.tokens.get(tokenId);
        const destination = { i: 5, j: 7 };
        const budget = 2 * scene.grid.distance;
        const clear = nav.planRoute(token, destination, budget);
        await scene.createEmbeddedDocuments('Region', [{
            name: 'E2E Difficult Terrain',
            shapes: [{ type: 'rectangle', x: 300, y: 300, width: 800, height: 800 }],
            behaviors: [{ type: 'modifyMovementCost', system: { difficulties: { walk: 2 } } }]
        }]);
        const tight = nav.planRoute(token, destination, budget);
        const exact = nav.planRoute(token, destination, 2 * budget);
        const reachable = nav.findReachable(token, budget);
        return {
            budget, clear, tight, exact,
            reachable: reachable.cells?.some(cell => cell.i === destination.i && cell.j === destination.j)
        };
    }, { sceneId, tokenId });
    assert.equal(costs.clear.exact, true, 'open ground fits a two-step budget');
    assert.equal(costs.tight.status, 'partial', 'terrain doubles the route cost');
    assert.equal(costs.tight.cost, costs.budget, 'only one step fits in the terrain');
    assert.equal(costs.reachable, false, 'reachable cells respect the same budget');
    assert.equal(costs.exact.exact, true, 'double the budget reaches the destination');
    assert.equal(costs.exact.cost, 2 * costs.budget);
    console.log('native difficult terrain limits measured movement on square grid');
}

async function testMeasuredTerrainDetour() {
    const sceneId = await createScene(1);
    const tokenId = await h.placeToken(page, sceneId, npcId, { x: 500, y: 500 });
    const result = await page.evaluate(async ({ sceneId, tokenId }) => {
        const scene = game.scenes.get(sceneId);
        const nav = game.modules.get('only-war-ai').api.services.get('navigation');
        const token = scene.tokens.get(tokenId);
        await scene.createEmbeddedDocuments('Region', [{
            name: 'E2E Terrain Detour',
            // The middle two cells of the straight path are inside; the
            // next row is clear. Five steps suffice even with no diagonals.
            shapes: [{ type: 'rectangle', x: 590, y: 490, width: 230, height: 120 }],
            behaviors: [{ type: 'modifyMovementCost', system: { difficulties: { walk: 5 } } }]
        }]);
        const direct = [5, 6, 7, 8].map(j => ({ i: 5, j }));
        const goal = direct.at(-1);
        const budget = 5 * scene.grid.distance;
        const straightCost = nav.measurePath(token, direct).cost;
        const route = nav.planRoute(token, goal, budget);
        const checked = nav.measurePath(token, route.waypoints).cost;
        const cell = nav.findReachable(token, budget).cells.find(({ i, j }) => i === goal.i && j === goal.j);
        const candidate = nav.findCandidates(token, budget, {
            target: { x: 850, y: 550 }, count: 1
        }).candidates[0];
        return { budget, straightCost, route, checked, cell, candidate };
    }, { sceneId, tokenId });
    const { budget, straightCost, route, checked, cell, candidate } = result;
    assert.ok(straightCost > budget, 'native Region makes the straight route unaffordable');
    assert.equal(route.exact, true, `affordable terrain detour required: ${route.status}:${route.reason}`);
    assert.ok(route.waypoints.some(point => point.i !== 5), 'the route leaves the straight row');
    assert.ok(checked <= budget + 1e-6, 'native measurement verifies the complete detour');
    assert.ok(Math.abs(checked - route.cost) < 0.001, 'the route reports the measured cost');
    assert.equal(cell?.cost, route.cost, 'reachable cells carry the same verified cost');
    assert.equal(candidate?.cost, route.cost);
    assert.deepEqual(candidate?.waypoints, route.waypoints);
    console.log('native difficult terrain detours preserve exact reachability and candidate routes');
}

async function testUnreachableEndpoint() {
    const sceneId = await createScene(1);
    const tokenId = await h.placeToken(page, sceneId, npcId, { x: 500, y: 500 });
    // Seal cell (5,15) вЂ” walls on all four sides.
    await createWalls(sceneId, [
        { c: [1500, 500, 1500, 600], move: 20, sight: 20, door: 0 },
        { c: [1600, 500, 1600, 600], move: 20, sight: 20, door: 0 },
        { c: [1500, 500, 1600, 500], move: 20, sight: 20, door: 0 },
        { c: [1500, 600, 1600, 600], move: 20, sight: 20, door: 0 }
    ]);
    const result = await planRoute(sceneId, tokenId, { x: 1550, y: 550 }, 60);
    assert.ok(['partial', 'failed'].includes(result.status),
        `expected partial/failed, got ${result.status}:${result.reason}`);
    assert.equal(result.exact, false);
    assert.ok(['path-not-found', 'endpoint-occupied', 'movement-budget-exceeded',
        'endpoint-out-of-bounds', 'search-limit']
        .includes(result.reason), `stable reason, got ${result.reason}`);
    if (result.status === 'partial') {
        assert.ok(result.path.length >= 1, 'partial route returns a usable waypoint list');
    }
}

async function testOccupiedEndpoint() {
    const sceneId = await createScene(1);
    const tokenId = await h.placeToken(page, sceneId, npcId, { x: 500, y: 500 });
    await h.placeToken(page, sceneId, blockerId, { x: 1500, y: 500 });
    const result = await planRoute(sceneId, tokenId, { x: 1550, y: 550 }, 30);
    assert.equal(result.exact, false, 'occupied endpoint cannot be exact');
    assert.ok(['partial', 'failed'].includes(result.status));
    if (result.status === 'partial') {
        assert.equal(result.reason, 'endpoint-occupied');
        const end = result.path[result.path.length - 1];
        const notGoal = !(end.i === 5 && end.j === 15);
        assert.ok(notGoal, 'partial endpoint is not the occupied cell');
    }
}

async function testHexScene() {
    const sceneId = await createScene(3);
    const tokenId = await h.placeToken(page, sceneId, npcId, { x: 500, y: 500 });
    const result = await planRoute(sceneId, tokenId, { x: 1200, y: 1200 }, 30);
    assert.equal(result.status, 'ok', `hex route failed: ${result.status}:${result.reason}`);
    assert.ok(result.path.length >= 2);
    const info = await page.evaluate(() =>
        game.modules.get('only-war-ai')?.api?.services?.get('navigation')?.gridInfo() ?? null);
    assert.equal(info?.kind, 'hex', 'gridInfo reports hex');
}

async function testGridlessRejected() {
    const sceneId = await createScene(0);
    const tokenId = await h.placeToken(page, sceneId, npcId, { x: 500, y: 500 });
    const result = await planRoute(sceneId, tokenId, { x: 1200, y: 1200 }, 30);
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'gridless-unsupported');
}

async function testMovementBudgetFromSystem() {
    const sceneId = await createScene(1);
    const tokenId = await h.placeToken(page, sceneId, npcId, { x: 500, y: 500 });
    const budget = await page.evaluate(async (data) => {
        const nav = game.modules.get('only-war-ai')?.api?.services?.get('navigation');
        const scene = game.scenes.get(data.sceneId);
        if (canvas.scene?.id !== scene.id) await scene.activate();
        const token = scene.tokens.get(data.tokenId);
        return nav.getMovementRates(token);
    }, { sceneId, tokenId });
    // The system API may not be merged yet вЂ” both contract paths are valid.
    assert.ok(['ok', 'failed'].includes(budget.status));
    if (budget.status === 'ok') {
        for (const key of ['half', 'full', 'charge', 'run']) {
            assert.ok(Number.isFinite(budget.rates[key]), `rate ${key} numeric`);
        }
    } else {
        assert.equal(budget.reason, 'movement-rates-unavailable');
    }
}

async function cleanup() {
    await h.closeAllWindows(page);
    for (const id of sceneIds) await h.deleteScene(page, id);
    if (npcId) await h.deleteActor(page, npcId);
    if (blockerId) await h.deleteActor(page, blockerId);
}

(async () => {
    const available = await probeEnvironment();
    if (!available) {
        console.log('navigation.test.mjs SKIPPED: Foundry (localhost:30000) '
            + 'or CDP (localhost:9222) not available');
        process.exit(0);
    }
    try {
        await h.getPage(browser).then(p => { page = p; });
        await h.ensureJoinedGame(page);
        console.log('Connected to Foundry game session');
        npcId = await h.createTestActor(page, 'npc', names.npc);
        blockerId = await h.createTestActor(page, 'npc', names.blocker);
        await testServiceRegistered();
        await testSquareRouteAroundWall();
        await testMeasuredTerrainBudget();
        await testMeasuredTerrainDetour();
        await testUnreachableEndpoint();
        await testOccupiedEndpoint();
        await testHexScene();
        await testGridlessRejected();
        await testMovementBudgetFromSystem();
        console.log('navigation.test.mjs PASSED');
        process.exit(0);
    } catch (err) {
        console.error('navigation.test.mjs FAILED:', err);
        try { await h.screenshot(page, 'navigation-failure'); } catch { /* ignore */ }
        process.exit(1);
    } finally {
        await cleanup().catch(() => {});
        // CDP: browser.close() would tear down the shared context — the connection ends with the process.
    }
})();
