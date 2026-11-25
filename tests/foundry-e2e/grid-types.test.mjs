import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import * as h from './lib.mjs';

/**
 * Grid-mode acceptance coverage (issue #410, epic #363):
 * - Hex golden paths: every registered preset produces a valid plan on a
 *   hex grid, and the assault preset executes a full turn (move + attack +
 *   end-turn) through the executor.
 * - Gridless scenes (grid.type = 0) are rejected by the planner with a
 *   controlled `unsupported` / `gridless-unsupported` result instead of
 *   producing unrouteable plans; the executor surfaces the same reason.
 *
 * Requires a running Foundry (FOUNDRY_URL), Chrome with CDP (CDP_URL) and
 * the only-war-ai module.
 */

const names = {
    npc: 'AI GridModes NPC',
    enemy: 'AI GridModes Enemy'
};

const PRESETS = ['assault', 'rangedCover', 'hold', 'specOps'];

let page;
let browser;
let npcId;
let enemyId;
let hexSceneId;
let gridlessSceneId;
let gridlessCombatId;
let npcTokenId;
let enemyTokenId;
let combatId;
let combatantId;
let previousMode;

async function setup() {
    browser = await chromium.connectOverCDP(h.CDP_URL);
    page = await h.getGmPage(browser);
    await h.ensureJoinedGame(page);

    console.log('Connected to Foundry game session');

    npcId = await h.createTestActor(page, 'npc', names.npc, async (actor) => {
        // Agility feeds `computeMovement` — without it the move budget is 0
        // and the planner legitimately picks attack-in-place.
        await actor.update({ 'system.characteristics.agility.base': 40 });
        await actor.createEmbeddedDocuments('Item', [
            { name: 'Chainsword', type: 'weapon', system: { class: 'melee', damage: '1d10+4' } },
            {
                name: 'Lasgun',
                type: 'weapon',
                system: {
                    class: 'basic',
                    range: 30,
                    damage: '1d10+3',
                    clip: { value: 30, max: 30 },
                    rateOfFire: { single: 1, semi: 0, full: 0 }
                }
            }
        ]);
    });
    enemyId = await h.createTestActor(page, 'npc', names.enemy);

    // Hex scene: any type >= 2 is a hex variant (navigation.test.mjs uses 3).
    const hexType = await page.evaluate(() => {
        const types = CONST?.GRID_TYPES ?? {};
        const hex = Object.entries(types)
            .find(([key, value]) => key.toUpperCase().includes('HEX') && value >= 2);
        return hex ? hex[1] : 3;
    });
    hexSceneId = await h.createTestScene(page, { grid: hexType, size: 100 });
    npcTokenId = await h.placeToken(page, hexSceneId, npcId, { x: 400, y: 500 });
    enemyTokenId = await h.placeToken(page, hexSceneId, enemyId, { x: 900, y: 500 });
    await page.evaluate(async (data) => {
        const scene = game.scenes.get(data.sceneId);
        await scene.tokens.get(data.npcTokenId).update({ disposition: -1 });
        await scene.tokens.get(data.enemyTokenId).update({ disposition: 1 });
    }, { sceneId: hexSceneId, npcTokenId, enemyTokenId });
}

async function testHexGridDetected() {
    const grid = await page.evaluate(() => ({
        type: canvas.grid?.type ?? canvas.scene?.grid?.type,
        isHex: canvas.grid?.isHex === true
    }));
    assert.ok(grid.type >= 2, `expected a hex grid type, got ${grid.type}`);
    console.log(`hex grid active (type ${grid.type})`);
}

async function testHexPresetGoldenPaths() {
    combatId = await h.createCombat(page, [npcTokenId, enemyTokenId]);
    combatantId = await page.evaluate((tid) =>
        game.combat?.combatants?.find((c) => c.tokenId === tid)?.id ?? null, npcTokenId);
    assert.ok(combatantId, 'npc combatant exists');

    for (const preset of PRESETS) {
        await h.setOverride(page, {
            kind: 'combatant', id: combatantId, override: { mode: 'enabled', preset }
        });
        const result = await page.evaluate(async (data) => {
            const planner = game.modules.get('only-war-ai').api.services.get('planner');
            const combatant = game.combat?.combatants?.get(data.cid);
            const outcome = await planner.planTurn(game.combat, combatant, { seed: 11 });
            return JSON.parse(JSON.stringify(outcome));
        }, { cid: combatantId });
        assert.equal(result.status, 'ok',
            `preset ${preset} should produce an ok plan on hex, got ${result.status}: ${result.reason}`);
        const plan = result.plan;
        assert.equal(plan.preset, preset, `plan preset should be ${preset}`);
        assert.equal(plan.snapshot.scene.grid.type >= 2, true, 'snapshot records the hex grid');
        assert.equal(plan.steps.at(-1).type, 'end-turn', 'plan ends the turn');
        console.log(`hex plan ${preset}: steps=${plan.steps.map((s) => s.type).join(',')}`);
    }
}

async function testHexExecutedTurn() {
    await h.setOverride(page, {
        kind: 'combatant', id: combatantId, override: { mode: 'enabled', preset: 'assault' }
    });
    const posBefore = await page.evaluate((tid) => {
        const token = canvas.scene?.tokens?.get(tid);
        return token ? { x: token._source?.x ?? token.x, y: token._source?.y ?? token.y } : null;
    }, npcTokenId);
    previousMode = await page.evaluate(async () => {
        const mode = game.settings.get('only-war-ai', 'executionMode');
        await game.settings.set('only-war-ai', 'executionMode', 'automatic');
        return mode;
    });
    try {
        const result = await page.evaluate(async (cid) => {
            const executor = game.modules.get('only-war-ai').api.services.get('executor');
            const combatant = game.combat?.combatants?.get(cid);
            const outcome = await executor.runPlan({
                combat: game.combat,
                combatant,
                operation: {
                    id: `e2e-hex-${foundry.utils.randomID()}`,
                    combatantId: cid,
                    phase: 'executing'
                },
                seed: 3
            });
            return JSON.parse(JSON.stringify(outcome));
        }, combatantId);
        console.log(`hex runPlan: status=${result.status} reason=${result.reason} steps=${result.stepsDone?.map((s) => s.type).join(',')}`);
        assert.equal(result.status, 'completed',
            `hex golden path should complete, got ${result.status} (${result.reason})`);
        assert.equal(result.stepsDone.at(-1)?.type ?? null, 'end-turn');
        const types = result.stepsDone.map((s) => s.type);
        assert.ok(types.includes('move') || types.includes('attack'),
            'the executed hex turn did something (move and/or attack)');
    } finally {
        await page.evaluate(async (mode) => {
            await game.settings.set('only-war-ai', 'executionMode', mode);
        }, previousMode);
    }
    const posAfter = await page.evaluate((tid) => {
        const token = canvas.scene?.tokens?.get(tid);
        return token ? { x: token._source?.x ?? token.x, y: token._source?.y ?? token.y } : null;
    }, npcTokenId);
    assert.ok(posAfter, 'token position readable after execution');
}

async function testGridlessRejected() {
    // Fresh gridless scene (grid.type = 0): the planner must answer with a
    // controlled unsupported result, not a crash and not an unrouteable
    // plan.
    gridlessSceneId = await h.createTestScene(page, { grid: 0, size: 100 });
    const gNpcToken = await h.placeToken(page, gridlessSceneId, npcId, { x: 400, y: 500 });
    const gEnemyToken = await h.placeToken(page, gridlessSceneId, enemyId, { x: 900, y: 500 });
    gridlessCombatId = await h.createCombat(page, [gNpcToken, gEnemyToken]);
    const gCombatantId = await page.evaluate((tid) =>
        game.combat?.combatants?.find((c) => c.tokenId === tid)?.id ?? null, gNpcToken);
    assert.ok(gCombatantId, 'npc combatant exists on gridless scene');
    await h.setOverride(page, {
        kind: 'combatant', id: gCombatantId, override: { mode: 'enabled', preset: 'assault' }
    });

    const outcome = await page.evaluate(async (data) => {
        const api = game.modules.get('only-war-ai').api;
        const combatant = game.combat?.combatants?.get(data.cid);
        const tokenBefore = { ...canvas.scene.tokens.get(data.tid)?._source };
        const messagesBefore = game.messages?.size ?? 0;
        const turnBefore = [game.combat.round, game.combat.turn];
        let planned;
        let planError = null;
        try {
            planned = await api.services.get('planner').planTurn(game.combat, combatant, { seed: 1 });
        } catch (err) {
            planError = String(err?.message ?? err);
        }
        let executed;
        let execError = null;
        try {
            const mode = game.settings.get('only-war-ai', 'executionMode');
            const diagnostics = game.settings.get('only-war-ai', 'diagnosticsEnabled');
            await game.settings.set('only-war-ai', 'executionMode', 'automatic');
            await game.settings.set('only-war-ai', 'diagnosticsEnabled', false);
            try {
                executed = await api.services.get('executor').runPlan({
                    combat: game.combat,
                    combatant,
                    operation: {
                        id: `e2e-gridless-${foundry.utils.randomID()}`,
                        combatantId: data.cid,
                        phase: 'executing'
                    },
                    seed: 1
                });
            } finally {
                await game.settings.set('only-war-ai', 'executionMode', mode);
                await game.settings.set('only-war-ai', 'diagnosticsEnabled', diagnostics);
            }
        } catch (err) {
            execError = String(err?.message ?? err);
        }
        const tokenAfter = { ...canvas.scene.tokens.get(data.tid)?._source };
        return JSON.parse(JSON.stringify({
            planned, planError, executed, execError,
            moved: tokenBefore.x !== tokenAfter.x || tokenBefore.y !== tokenAfter.y,
            advanced: turnBefore[0] !== game.combat.round || turnBefore[1] !== game.combat.turn,
            newMessages: (game.messages?.size ?? 0) - messagesBefore
        }));
    }, { cid: gCombatantId, tid: gNpcToken });

    assert.equal(outcome.planError, null, 'planner must not throw on gridless scenes');
    assert.equal(outcome.planned.status, 'unsupported',
        `expected unsupported status, got ${outcome.planned?.status}`);
    assert.equal(outcome.planned.reason, 'gridless-unsupported');
    assert.equal(outcome.planned.plan, null, 'no plan is produced on gridless scenes');

    assert.equal(outcome.execError, null, 'executor must not throw on gridless scenes');
    assert.equal(outcome.executed.reason, 'gridless-unsupported',
        `executor should surface gridless-unsupported, got ${outcome.executed?.reason}`);
    assert.equal(outcome.moved, false, 'nothing moved on the gridless scene');
    assert.equal(outcome.advanced, false, 'gridless refusal does not advance initiative');
    assert.equal(outcome.newMessages, 0, 'no chat cards were produced');
    console.log('gridless scene rejected with a controlled unsupported result');
}

async function cleanup() {
    try {
        if (previousMode !== undefined) {
            await page.evaluate(async (mode) => {
                await game.settings.set('only-war-ai', 'executionMode', mode);
            }, previousMode);
        }
    } catch { /* best-effort */ }
    await h.closeAllWindows(page);
    if (combatId) await h.deleteCombat(page, combatId);
    if (gridlessCombatId) await h.deleteCombat(page, gridlessCombatId);
    for (const sid of [hexSceneId, gridlessSceneId]) {
        if (sid) await h.deleteScene(page, sid);
    }
    if (npcId) await h.deleteActor(page, npcId);
    if (enemyId) await h.deleteActor(page, enemyId);
}

(async () => {
    let failed = false;
    try {
        await setup();
        await testHexGridDetected();
        await testHexPresetGoldenPaths();
        await testHexExecutedTurn();
        await testGridlessRejected();
        console.log('grid-types.test.mjs PASSED');
    } catch (err) {
        failed = true;
        console.error('grid-types.test.mjs FAILED:', err);
        try { await h.screenshot(page, 'grid-types-failure'); } catch { /* ignore */ }
    }
    await cleanup().catch(() => {});
    process.exit(failed ? 1 : 0);
})();
