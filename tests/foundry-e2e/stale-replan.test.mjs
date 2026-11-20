import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import * as h from './lib.mjs';

/**
 * Stale-plan and replan acceptance coverage (issue #410, epic #363):
 * - Manually moving the NPC token after planning makes the plan stale
 *   (`token-moved`); the executor replans exactly once and completes on
 *   the rebuilt plan.
 * - The one-replan limit is enforced: a plan that already spent its
 *   replan (replanCount >= 1) stops with `replan-limit-exceeded` /
 *   hold-and-report instead of replanning forever.
 *
 * Requires a running Foundry (FOUNDRY_URL), Chrome with CDP (CDP_URL) and
 * the only-war-ai module.
 */

const names = {
    npc: 'AI StalePlan NPC',
    enemy: 'AI StalePlan Enemy'
};

let page;
let browser;
let npcId;
let enemyId;
let sceneId;
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
        await actor.update({ 'system.characteristics.agility.base': 40 });
        await actor.createEmbeddedDocuments('Item', [
            {
                name: 'Auto Pistol',
                type: 'weapon',
                system: {
                    class: 'pistol',
                    range: 10,
                    damage: '1d10+2',
                    clip: { value: 6, max: 9 },
                    rateOfFire: { single: 1, semi: 0, full: 0 }
                }
            }
        ]);
    });
    enemyId = await h.createTestActor(page, 'npc', names.enemy);
    sceneId = await h.createTestScene(page, { grid: 1, size: 100 });
    npcTokenId = await h.placeToken(page, sceneId, npcId, { x: 400, y: 500 });
    enemyTokenId = await h.placeToken(page, sceneId, enemyId, { x: 1400, y: 500 });
    await page.evaluate(async (data) => {
        const scene = game.scenes.get(data.sceneId);
        await scene.tokens.get(data.npcTokenId).update({ disposition: -1 });
        await scene.tokens.get(data.enemyTokenId).update({ disposition: 1 });
    }, { sceneId, npcTokenId, enemyTokenId });
    combatId = await h.createCombat(page, [npcTokenId, enemyTokenId]);
    combatantId = await page.evaluate((tid) =>
        game.combat?.combatants?.find((c) => c.tokenId === tid)?.id ?? null, npcTokenId);
    assert.ok(combatantId, 'npc combatant exists');
    await h.setOverride(page, {
        kind: 'combatant', id: combatantId, override: { mode: 'enabled', preset: 'assault' }
    });
    previousMode = await page.evaluate(async () => {
        const mode = game.settings.get('only-war-ai', 'executionMode');
        await game.settings.set('only-war-ai', 'executionMode', 'automatic');
        return mode;
    });
}

/** Move the NPC token one grid cell to invalidate the plan snapshot. */
async function nudgeToken() {
    await page.evaluate(async (tid) => {
        const token = canvas.scene.tokens.get(tid);
        await token.update({ x: (token._source?.x ?? token.x) + 100 });
    }, npcTokenId);
}

async function testStalePlanTriggersSingleReplan() {
    const outcome = await page.evaluate(async (data) => {
        const api = game.modules.get('only-war-ai').api;
        const planner = api.services.get('planner');
        const executor = api.services.get('executor');
        const combatant = game.combat?.combatants?.get(data.cid);
        const planned = await planner.planTurn(game.combat, combatant, { seed: 5 });
        return { plan: JSON.parse(JSON.stringify(planned.plan ?? null)), status: planned.status };
    }, { cid: combatantId });
    assert.equal(outcome.status, 'ok', `initial plan should be ok, got ${outcome.status}`);
    const plan = outcome.plan;
    assert.ok(plan, 'plan produced');

    // The NPC was moved by hand after planning — the snapshot is stale.
    await nudgeToken();

    const result = await page.evaluate(async (data) => {
        const executor = game.modules.get('only-war-ai').api.services.get('executor');
        const combatant = game.combat?.combatants?.get(data.cid);
        const outcome = await executor.executePlan(data.plan, {
            combat: game.combat,
            combatant,
            operation: {
                id: `e2e-stale-${foundry.utils.randomID()}`,
                combatantId: data.cid,
                phase: 'executing'
            }
        });
        return JSON.parse(JSON.stringify(outcome));
    }, { cid: combatantId, plan });
    console.log(`stale execution: status=${result.status} replanCount=${result.replanCount} `
        + `steps=${result.stepsDone?.map((s) => s.type).join(',')} planId=${result.planId}`);
    assert.equal(result.replanCount, 1,
        `exactly one replan is expected after token-moved, got ${result.replanCount}`);
    assert.equal(result.status, 'completed',
        `replan should rebuild a working plan, got ${result.status} (${result.reason})`);
    assert.equal(result.stepsDone.at(-1)?.type, 'end-turn');
}

async function testReplanLimitEnforced() {
    // Fresh plan, then spend its replan budget before executing: the next
    // token-moved must hold-and-report, not replan forever.
    const outcome = await page.evaluate(async (data) => {
        const api = game.modules.get('only-war-ai').api;
        const planner = api.services.get('planner');
        const combatant = game.combat?.combatants?.get(data.cid);
        const planned = await planner.planTurn(game.combat, combatant, { seed: 6 });
        const plan = JSON.parse(JSON.stringify(planned.plan ?? null));
        if (plan) plan.replanCount = 1; // replan budget already spent
        const decision = planner.shouldReplan({
            reason: 'token-moved',
            plan,
            replanCount: 1
        });
        return { plan, decision, status: planned.status };
    }, { cid: combatantId });
    assert.equal(outcome.status, 'ok', `plan should be ok, got ${outcome.status}`);
    assert.equal(outcome.decision.action, 'hold-and-report',
        'a spent replan budget must hold-and-report');
    assert.equal(outcome.decision.reason, 'replan-limit-exceeded');

    await nudgeToken();

    const messagesBefore = await page.evaluate(() => game.messages?.size ?? 0);
    const result = await page.evaluate(async (data) => {
        const executor = game.modules.get('only-war-ai').api.services.get('executor');
        const combatant = game.combat?.combatants?.get(data.cid);
        const outcome = await executor.executePlan(data.plan, {
            combat: game.combat,
            combatant,
            operation: {
                id: `e2e-limit-${foundry.utils.randomID()}`,
                combatantId: data.cid,
                phase: 'executing'
            }
        });
        return JSON.parse(JSON.stringify(outcome));
    }, { cid: combatantId, plan: outcome.plan });
    console.log(`replan-limit execution: status=${result.status} reason=${result.reason} `
        + `replanCount=${result.replanCount}`);
    assert.equal(result.status, 'failed',
        `replan-limit must fail the turn, got ${result.status}`);
    assert.equal(result.reason, 'replan-limit-exceeded',
        `expected replan-limit-exceeded, got ${result.reason}`);
    const newMessages = await page.evaluate(() => game.messages?.size ?? 0) - messagesBefore;
    assert.equal(newMessages, 0, 'a held turn writes no attack chat cards');
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
    if (sceneId) await h.deleteScene(page, sceneId);
    if (npcId) await h.deleteActor(page, npcId);
    if (enemyId) await h.deleteActor(page, enemyId);
}

(async () => {
    let failed = false;
    try {
        await setup();
        await testStalePlanTriggersSingleReplan();
        await testReplanLimitEnforced();
        console.log('stale-replan.test.mjs PASSED');
    } catch (err) {
        failed = true;
        console.error('stale-replan.test.mjs FAILED:', err);
        try { await h.screenshot(page, 'stale-replan-failure'); } catch { /* ignore */ }
    }
    await cleanup().catch(() => {});
    process.exit(failed ? 1 : 0);
})();
