import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import * as h from './lib.mjs';

const names = {
  leader: 'AI SpecOps Leader',
  flanker: 'AI SpecOps Flanker',
  enemies: ['AI SpecOps Enemy 1', 'AI SpecOps Enemy 2', 'AI SpecOps Enemy 3']
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

  actorIds.push(await h.createTestActor(page, 'npc', names.leader));
  actorIds.push(await h.createTestActor(page, 'npc', names.flanker));
  await page.evaluate(async (ids) => {
    for (const id of ids.slice(0, 2)) {
      await game.actors.get(id).update({ 'system.characteristics.agility.base': 40 });
    }
  }, actorIds);
  for (const name of names.enemies) {
    actorIds.push(await h.createTestActor(page, 'npc', name));
  }
  sceneId = await h.createTestScene(page);
  tokenIds.leader = await h.placeToken(page, sceneId, actorIds[0], { x: 400, y: 400 });
  tokenIds.flanker = await h.placeToken(page, sceneId, actorIds[1], { x: 500, y: 400 });
  tokenIds.enemies = [];
  for (let i = 0; i < names.enemies.length; i++) {
    tokenIds.enemies.push(await h.placeToken(page, sceneId, actorIds[2 + i], { x: 1600 + i * 100, y: 400 }));
  }
}

async function testSpecOpsFlankAndFix() {
  const npcTokenIds = [tokenIds.leader, tokenIds.flanker];
  combatId = await h.createCombat(page, [...npcTokenIds, ...tokenIds.enemies]);

  // Enable AI (specOps preset) for both npc combatants and join them to
  // fireteam "alpha" with the specOps team preset.
  const combatantIds = await page.evaluate(async (tids) => {
    const ids = [];
    for (const tid of tids) {
      const combatant = game.combat?.combatants?.find((c) => c.tokenId === tid);
      if (!combatant) return null;
      await combatant.setFlag('only-war-ai', 'override', { mode: 'enabled', preset: 'specOps' });
      await combatant.setFlag('only-war-ai', 'fireteam', { teamId: 'alpha', teamPreset: 'specOps' });
      ids.push(combatant.id);
    }
    return ids;
  }, npcTokenIds);
  assert.ok(combatantIds && combatantIds.length === 2, 'two npc combatants in team alpha');

  // Injected shared targets: the three enemy tokens (outnumbered в†’ the
  // spec-ops selector should commit to flank-and-fix on open ground).
  const targets = await page.evaluate((tids) => tids.map((tid) => {
    const doc = canvas.scene?.tokens?.get(tid);
    return {
      tokenId: tid,
      tokenUuid: doc?.uuid ?? null,
      x: doc?.x ?? 0,
      y: doc?.y ?? 0,
      elevation: 0,
      canAttack: true,
      source: 'injected'
    };
  }), tokenIds.enemies);

  const built = await page.evaluate(async (injectedTargets) => {
    const api = game.modules.get('only-war-ai')?.api;
    const fireteam = api?.services?.get('fireteam');
    const result = await fireteam.buildTeamPlan(game.combat, { teamId: 'alpha' }, {
      seed: 21,
      targets: injectedTargets
    });
    return JSON.parse(JSON.stringify(result));
  }, targets);

  assert.equal(built.status, 'ok', `buildTeamPlan status ${built.status}`);
  const plan = built.teamPlan;
  assert.equal(plan.teamId, 'alpha');
  assert.equal(plan.teamPreset, 'specOps');
  assert.equal(plan.tactic, 'flank-and-fix', `tactic ${plan.tactic}`);
  assert.equal(plan.diagnostics?.tactic?.name, 'flank-and-fix');
  assert.equal(plan.diagnostics?.tactic?.reason, 'outnumbered-flank-open');
  assert.equal(plan.members.length, 2);
  // Flank-and-fix observably splits the team: one flanker, one fixer.
  const tasks = plan.members.map((m) => m.task);
  assert.ok(tasks.includes('flank'), `no flank task in ${tasks}`);
  assert.ok(tasks.includes('support'), `no support task in ${tasks}`);
  const flanker = plan.members.find((m) => m.task === 'flank');
  assert.equal(flanker.groupId, 'flank-1');
  assert.notEqual(flanker.combatantId, plan.leaderId, 'leader holds the front');
  // Flank move steps precede the main group; the action phase is gated.
  assert.ok(plan.phases?.[1]?.barrier, 'action phase barrier');
  // Serializable round-trip.
  assert.equal(JSON.parse(JSON.stringify(plan)).id, plan.id);

  // Determinism: identical input builds the identical TeamPlan.
  const again = await page.evaluate(async (injectedTargets) => {
    const fireteam = game.modules.get('only-war-ai')?.api?.services?.get('fireteam');
    const result = await fireteam.buildTeamPlan(game.combat, { teamId: 'alpha' }, {
      seed: 21,
      targets: injectedTargets
    });
    return JSON.parse(JSON.stringify(result));
  }, targets);
  assert.equal(again.teamPlan.id, plan.id, 'identical input yields identical plan');

  return { combatantIds, plan };
}

async function testLeaderLossDeterministicSuccessor(state) {
  const { combatantIds, plan } = state;
  const fresh = await page.evaluate((p) => game.modules
    .get('only-war-ai').api.services.get('fireteam').validateTeamPlan(p, { combat: game.combat }), plan);
  assert.equal(fresh.valid, true, 'fresh spec-ops plan validates');

  // Leader defeated в†’ leader-lost + deterministic successor election.
  await page.evaluate(async (cid) => {
    await game.combat.combatants.get(cid).update({ defeated: true });
  }, plan.leaderId);
  const lost = await page.evaluate((p) => game.modules
    .get('only-war-ai').api.services.get('fireteam').validateTeamPlan(p, { combat: game.combat }), plan);
  assert.equal(lost.valid, false);
  assert.equal(lost.reason, 'leader-lost');
  assert.ok(lost.successor?.combatantId, 'deterministic successor elected');
  assert.notEqual(lost.successor.combatantId, plan.leaderId);
  assert.equal(lost.successor.combatantId, combatantIds.find((id) => id !== plan.leaderId));

  // Rebuild for the survivors: the successor leads, the plan stays legal.
  const rebuilt = await page.evaluate(async () => {
    const fireteam = game.modules.get('only-war-ai')?.api?.services?.get('fireteam');
    const result = await fireteam.buildTeamPlan(game.combat, { teamId: 'alpha' }, { seed: 21 });
    return JSON.parse(JSON.stringify(result));
  });
  assert.equal(rebuilt.status, 'ok');
  assert.equal(rebuilt.teamPlan.members.length, 1);
  assert.equal(rebuilt.teamPlan.leaderId, lost.successor.combatantId);
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
    const state = await testSpecOpsFlankAndFix();
    await testLeaderLossDeterministicSuccessor(state);
    console.log('preset-spec-ops.test.mjs PASSED');
    process.exit(0);
  } catch (err) {
    console.error('preset-spec-ops.test.mjs FAILED:', err);
    try { await h.screenshot(page, 'preset-spec-ops-failure'); } catch { /* ignore */ }
    process.exit(1);
  } finally {
    try { await cleanup(); } catch { /* ignore */ }
    // CDP: browser.close() would tear down the shared context — the connection ends with the process.
  }
})();
