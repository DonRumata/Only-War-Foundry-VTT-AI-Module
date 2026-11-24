import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import * as h from './lib.mjs';

const names = {
  npc: 'AI Planner NPC',
  enemy: 'AI Planner Enemy'
};

let page;
let browser;
let npcId;
let enemyId;
let sceneId;
let npcTokenId;
let enemyTokenId;
let combatId;

async function setup() {
  browser = await chromium.connectOverCDP(h.CDP_URL);
  page = await h.getPage(browser);
  await h.ensureJoinedGame(page);

  console.log('Connected to Foundry game session');

  npcId = await h.createTestActor(page, 'npc', names.npc);
  enemyId = await h.createTestActor(page, 'npc', names.enemy);
  sceneId = await h.createTestScene(page);
  npcTokenId = await h.placeToken(page, sceneId, npcId, { x: 400, y: 400 });
  enemyTokenId = await h.placeToken(page, sceneId, enemyId, { x: 600, y: 400 });
}

async function testPlannerServiceRegistered() {
  const info = await page.evaluate(() => {
    const planner = game.modules.get('only-war-ai')?.api?.services?.get('planner');
    return {
      present: !!planner,
      hasPlanTurn: typeof planner?.planTurn === 'function',
      hasValidate: typeof planner?.validateSnapshot === 'function',
      hasReplan: typeof planner?.shouldReplan === 'function',
      presets: typeof planner?.listPresets === 'function' ? planner.listPresets() : null
    };
  });
  assert.equal(info.present, true, 'planner service should be registered');
  assert.equal(info.hasPlanTurn, true);
  assert.equal(info.hasValidate, true);
  assert.equal(info.hasReplan, true);
  assert.deepEqual(info.presets, ['assault', 'rangedCover', 'hold', 'specOps']);
}

async function testPlanTurnSmoke() {
  combatId = await h.createCombat(page, [npcTokenId, enemyTokenId]);

  // Enable AI for the npc combatant.
  const combatantId = await page.evaluate((tid) =>
    game.combat?.combatants?.find((c) => c.tokenId === tid)?.id ?? null, npcTokenId);
  assert.ok(combatantId, 'npc combatant exists');
  await h.setOverride(page, {
    kind: 'combatant', id: combatantId, override: { mode: 'enabled', preset: 'assault' }
  });

  const result = await page.evaluate(async (cid) => {
    const planner = game.modules.get('only-war-ai')?.api?.services?.get('planner');
    const combatant = game.combat?.combatants?.get(cid);
    const outcome = await planner.planTurn(game.combat, combatant, { seed: 1 });
    return JSON.parse(JSON.stringify(outcome));
  }, combatantId);

  assert.ok(
    ['ok', 'no-target', 'no-action', 'no-route', 'disabled', 'waiting-for-gm'].includes(result.status),
    `unexpected status ${result.status}`
  );
  if (result.status === 'ok') {
    assert.ok(result.plan.snapshot.revision, 'snapshot revision present');
    assert.equal(result.plan.snapshot.combatId, combatId);
    assert.ok(Array.isArray(result.plan.steps) && result.plan.steps.length >= 1);
    assert.equal(result.plan.steps.at(-1).type, 'end-turn');
    const verdict = await page.evaluate((p) =>
      game.modules.get('only-war-ai').api.services.get('planner').validateSnapshot(p, {}),
    result.plan);
    assert.equal(verdict.valid, true, 'fresh plan should validate');
  } else {
    console.log(`planTurn returned ${result.status} — acceptable for an unarmed npc`);
  }
}

async function cleanup() {
  await h.closeAllWindows(page);
  if (combatId) await h.deleteCombat(page, combatId);
  if (sceneId) await h.deleteScene(page, sceneId);
  if (npcId) await h.deleteActor(page, npcId);
  if (enemyId) await h.deleteActor(page, enemyId);
}

(async () => {
  try {
    await setup();
    await testPlannerServiceRegistered();
    await testPlanTurnSmoke();
    console.log('planner.test.mjs PASSED');
    process.exit(0);
  } catch (err) {
    console.error('planner.test.mjs FAILED:', err);
    try { await h.screenshot(page, 'planner-failure'); } catch { /* ignore */ }
    process.exit(1);
  } finally {
    await cleanup().catch(() => {});
  }
})();
