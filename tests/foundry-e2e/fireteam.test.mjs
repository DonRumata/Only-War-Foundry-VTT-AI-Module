import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import * as h from './lib.mjs';

const names = {
  leader: 'AI Fireteam Leader',
  flanker: 'AI Fireteam Flanker',
  support: 'AI Fireteam Support',
  enemy: 'AI Fireteam Enemy'
};

let page;
let browser;
let actorIds = [];
let sceneId;
let tokenIds = {};
let combatId;

async function setup() {
  browser = await chromium.connectOverCDP(h.CDP_URL);
  page = await h.getPage(browser);
  await h.ensureJoinedGame(page);

  console.log('Connected to Foundry game session');

  for (const name of [names.leader, names.flanker, names.support, names.enemy]) {
    actorIds.push(await h.createTestActor(page, 'npc', name));
  }
  sceneId = await h.createTestScene(page);
  tokenIds.leader = await h.placeToken(page, sceneId, actorIds[0], { x: 400, y: 400 });
  tokenIds.flanker = await h.placeToken(page, sceneId, actorIds[1], { x: 450, y: 500 });
  tokenIds.support = await h.placeToken(page, sceneId, actorIds[2], { x: 500, y: 600 });
  tokenIds.enemy = await h.placeToken(page, sceneId, actorIds[3], { x: 1800, y: 400 });
}

async function testFireteamServiceRegistered() {
  const info = await page.evaluate(() => {
    const fireteam = game.modules.get('only-war-ai')?.api?.services?.get('fireteam');
    return {
      present: !!fireteam,
      methods: ['buildTeamPlan', 'assignTasks', 'reserveResources', 'electLeader',
        'validateTeamPlan', 'regroupPoints']
        .filter((m) => typeof fireteam?.[m] === 'function')
    };
  });
  assert.equal(info.present, true, 'fireteam service should be registered');
  assert.equal(info.methods.length, 6, `missing methods: ${info.methods}`);
}

async function testTeamPlanBuildAndLeaderLoss() {
  const npcTokenIds = [tokenIds.leader, tokenIds.flanker, tokenIds.support];
  combatId = await h.createCombat(page, [...npcTokenIds, tokenIds.enemy]);

  // Enable AI for all three npc combatants and join them to fireteam "alpha".
  const combatantIds = await page.evaluate(async (tids) => {
    const ids = [];
    for (const tid of tids) {
      const combatant = game.combat?.combatants?.find((c) => c.tokenId === tid);
      if (!combatant) return null;
      await combatant.setFlag('only-war-ai', 'override', { mode: 'enabled', preset: 'assault' });
      await combatant.setFlag('only-war-ai', 'fireteam', { teamId: 'alpha' });
      ids.push(combatant.id);
    }
    return ids;
  }, npcTokenIds);
  assert.ok(combatantIds && combatantIds.length === 3, 'three npc combatants in team alpha');

  const built = await page.evaluate(async (leaderCid) => {
    const api = game.modules.get('only-war-ai')?.api;
    const fireteam = api?.services?.get('fireteam');
    const result = await fireteam.buildTeamPlan(game.combat, {
      teamId: 'alpha',
      leaderId: leaderCid
    }, { seed: 21 });
    return JSON.parse(JSON.stringify(result));
  }, combatantIds[0]);

  assert.equal(built.status, 'ok', `buildTeamPlan status ${built.status}`);
  const plan = built.teamPlan;
  assert.equal(plan.teamId, 'alpha');
  assert.equal(plan.leaderId, combatantIds[0]);
  assert.equal(plan.members.length, 3);
  assert.ok(plan.members.every((m) => typeof m.task === 'string' && m.task));
  // One shared plan: flank + main-group tasks assigned temporarily.
  assert.ok(plan.members.some((m) => m.task === 'flank'), 'flank assignment exists');
  assert.ok(plan.members.some((m) => m.groupId === 'main'), 'main group exists');
  assert.ok(Array.isArray(plan.phases) && plan.phases.length >= 2);
  // Serializable: a JSON round-trip yields the identical plan id.
  assert.equal(JSON.parse(JSON.stringify(plan)).id, plan.id);

  const fresh = await page.evaluate((p) => game.modules
    .get('only-war-ai').api.services.get('fireteam').validateTeamPlan(p, { combat: game.combat }), plan);
  assert.equal(fresh.valid, true, 'fresh team plan validates');

  // Leader defeated → leader-lost + deterministic successor.
  await page.evaluate(async (cid) => {
    await game.combat.combatants.get(cid).update({ defeated: true });
  }, combatantIds[0]);
  const lost = await page.evaluate((p) => game.modules
    .get('only-war-ai').api.services.get('fireteam').validateTeamPlan(p, { combat: game.combat }), plan);
  assert.equal(lost.valid, false);
  assert.equal(lost.reason, 'leader-lost');
  assert.ok(lost.successor?.combatantId, 'deterministic successor elected');
  assert.notEqual(lost.successor.combatantId, combatantIds[0]);

  // The invalidated plan is marked and never re-executed.
  const invalidated = await page.evaluate((p) => game.modules
    .get('only-war-ai').api.services.get('fireteam')
    .invalidateTeamPlan(p, 'leader-lost'), plan);
  assert.equal(invalidated.invalidated, true);
  assert.equal(invalidated.invalidReason, 'leader-lost');

  // Re-elect a live leader and rebuild a valid plan for the survivors.
  const rebuilt = await page.evaluate(async () => {
    const fireteam = game.modules.get('only-war-ai')?.api?.services?.get('fireteam');
    const result = await fireteam.buildTeamPlan(game.combat, { teamId: 'alpha' }, { seed: 21 });
    return JSON.parse(JSON.stringify(result));
  });
  assert.equal(rebuilt.status, 'ok');
  assert.equal(rebuilt.teamPlan.members.length, 2);
  assert.notEqual(rebuilt.teamPlan.leaderId, combatantIds[0]);
}

async function cleanup() {
  await h.closeAllWindows(page);
  if (combatId) await h.deleteCombat(page, combatId);
  if (sceneId) await h.deleteScene(page, sceneId);
  for (const id of actorIds) await h.deleteActor(page, id);
}

(async () => {
  try {
    await setup();
    await testFireteamServiceRegistered();
    await testTeamPlanBuildAndLeaderLoss();
    console.log('fireteam.test.mjs PASSED');
    process.exit(0);
  } catch (err) {
    console.error('fireteam.test.mjs FAILED:', err);
    try { await h.screenshot(page, 'fireteam-failure'); } catch { /* ignore */ }
    process.exit(1);
  } finally {
    await cleanup().catch(() => {});
  }
})();
