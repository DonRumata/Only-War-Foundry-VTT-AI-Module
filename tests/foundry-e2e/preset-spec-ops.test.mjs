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

  for (const name of [names.leader, names.flanker]) {
    actorIds.push(await h.createTestActor(page, 'npc', name, async actor => {
      await actor.update({ 'system.characteristics.agility.base': actor.name === 'AI SpecOps Leader' ? 10 : 40 });
      await actor.createEmbeddedDocuments('Item', [{
        name: 'Lasgun', type: 'weapon', system: {
          class: 'basic', range: 100, damage: '1d10+3',
          clip: { value: 6, max: 9 }, rateOfFire: { single: 1, semi: 0, full: 0 }
        }
      }]);
    }));
  }
  for (const name of names.enemies) {
    actorIds.push(await h.createTestActor(page, 'npc', name));
  }
  // A half move covers one square. The flanker starts off-axis, but no
  // firing position within that budget reaches 150 degrees.
  sceneId = await page.evaluate(async () => {
    const scene = await Scene.create({
      name: 'E2E Spec Ops', active: false, width: 1600, height: 1200, padding: 0, tokenVision: false,
      grid: { type: 1, size: 100, distance: 4 }
    });
    await scene.view();
    return scene.id;
  });
  await page.waitForFunction(id => canvas.ready && canvas.scene?.id === id, sceneId);
  tokenIds.leader = await h.placeToken(page, sceneId, actorIds[0], { x: 400, y: 400 });
  tokenIds.flanker = await h.placeToken(page, sceneId, actorIds[1], { x: 600, y: 500 });
  tokenIds.enemies = [];
  for (let i = 0; i < names.enemies.length; i++) {
    tokenIds.enemies.push(await h.placeToken(page, sceneId, actorIds[2 + i], { x: 600 + i * 100, y: 400 }));
  }
}

async function testSpecOpsFlankAndFix() {
  const npcTokenIds = [tokenIds.leader, tokenIds.flanker];
  combatId = await h.createCombat(page, [...npcTokenIds, ...tokenIds.enemies]);

  // Enable AI (specOps preset) for both npc combatants and join them to
  // fireteam "alpha" with the specOps team preset.
  const combatantIds = await page.evaluate(async (tids) => {
    const ids = [];
    for (const [index, tid] of tids.entries()) {
      const combatant = game.combat?.combatants?.find((c) => c.tokenId === tid);
      if (!combatant) return null;
      await combatant.update({ initiative: 20 - index });
      await combatant.setFlag('only-war-ai', 'override', { mode: 'enabled', preset: 'specOps' });
      await combatant.setFlag('only-war-ai', 'fireteam', {
        teamId: 'alpha', teamPreset: 'specOps', preferredCohesion: 12
      });
      ids.push(combatant.id);
    }
    return ids;
  }, npcTokenIds);
  assert.ok(combatantIds && combatantIds.length === 2, 'two npc combatants in team alpha');

  // Inject the three visible contacts in known order, independently of
  // token vision configuration in the test world.
  const targets = await page.evaluate((tids) => tids.map((tid) => {
    const doc = canvas.scene?.tokens?.get(tid);
    const size = canvas.scene.grid.size;
    return {
      tokenId: tid,
      tokenUuid: doc?.uuid ?? null,
      x: doc._source.x + doc.width * size / 2,
      y: doc._source.y + doc.height * size / 2,
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
      targets: injectedTargets,
      readOnly: true
    });
    const plan = result.teamPlan;
    const flanker = plan?.members.find(member => member.task === 'flank');
    const steps = plan?.memberPlans[flanker?.combatantId]?.steps ?? [];
    const move = steps.find(step => step.type === 'move');
    const attack = steps.find(step => step.type === 'attack');
    if (!attack) return JSON.parse(JSON.stringify(result));
    const leader = game.combat.combatants.get(plan.leaderId).token;
    const token = game.combat.combatants.get(flanker.combatantId).token;
    const size = canvas.scene.grid.size;
    const center = { x: leader._source.x + leader.width * size / 2, y: leader._source.y + leader.height * size / 2 };
    const target = injectedTargets.find(entry => entry.tokenId === attack.input.targetTokenId);
    const endpoint = move?.input.to
      ?? { x: token._source.x + token.width * size / 2, y: token._source.y + token.height * size / 2 };
    const front = Math.atan2(target.y - center.y, target.x - center.x);
    const strike = Math.atan2(target.y - endpoint.y, target.x - endpoint.x);
    const angle = Math.acos(Math.cos(front - strike)) * 180 / Math.PI;
    const route = move && await api.services.get('navigation').planRouteForMode(token, endpoint, 'half');
    return JSON.parse(JSON.stringify({
      ...result, proof: { angle, exact: route?.exact, waypoints: route?.waypoints, planned: move?.input.waypoints }
    }));
  }, targets);

  assert.equal(built.status, 'ok', `buildTeamPlan status ${built.status}`);
  const plan = built.teamPlan;
  assert.equal(plan.teamId, 'alpha');
  assert.equal(plan.teamPreset, 'specOps');
  assert.equal(plan.tactic, 'flank-and-fix',
    `tactic ${plan.tactic}: ${JSON.stringify(plan.diagnostics?.tactic)}`);
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
  assert.ok(built.proof?.angle >= plan.specOpsConfig.flankMinAngleDegrees, 'the actual shot meets the saved cutoff');
  const waitsForFlanker = plan.phases[1].barrier?.requiredAssignmentIds.includes(flanker.combatantId) ?? false;
  assert.equal(waitsForFlanker, Boolean(built.proof.planned), 'only a moving flank gates the action phase');
  if (built.proof.planned) {
    assert.equal(built.proof.exact, true, 'native half-move reaches the planned attack centre');
    assert.deepEqual(built.proof.planned, built.proof.waypoints, 'TeamPlan carries the native route');
  }
  // Serializable round-trip.
  assert.equal(JSON.parse(JSON.stringify(plan)).id, plan.id);

  // Determinism: identical input builds the identical TeamPlan.
  const again = await page.evaluate(async (injectedTargets) => {
    const fireteam = game.modules.get('only-war-ai')?.api?.services?.get('fireteam');
    const result = await fireteam.buildTeamPlan(game.combat, { teamId: 'alpha' }, {
      seed: 21,
      targets: injectedTargets,
      readOnly: true
    });
    return JSON.parse(JSON.stringify(result));
  }, targets);
  assert.equal(again.teamPlan.id, plan.id, 'identical input yields identical plan');

  return { combatantIds, plan, targets };
}

async function testWorldSettings({ targets }) {
  const field = 'specOpsFlankMinAngleDegrees';
  const previous = await page.evaluate(async key => {
    await game.settings.sheet.render({ force: true });
    return game.settings.get('only-war-ai', key);
  }, field);
  const angle = previous === 150 ? 180 : 150;
  const settings = page.locator('#settings-config');
  try {
    await settings.locator('button[data-tab="only-war-ai"]').click();
    await settings.locator(`[name="only-war-ai.${field}"]`).evaluate((input, value) => {
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, angle);
    await settings.locator('button[type="submit"]').click();
    await page.waitForFunction(({ field, angle }) => game.settings.get('only-war-ai', field) === angle,
      { field, angle });
    await page.reload();
    await page.waitForFunction(() => globalThis.game?.ready);
    await page.evaluate(id => game.scenes.get(id).view(), sceneId);
    await page.waitForFunction(id => canvas.ready && canvas.scene?.id === id, sceneId);
    const tactic = await page.evaluate(async ({ combatId, targets }) => {
      const fireteam = game.modules.get('only-war-ai').api.services.get('fireteam');
      const result = await fireteam.buildTeamPlan(game.combats.get(combatId), 'alpha',
        { seed: 21, targets, readOnly: true });
      return result.teamPlan?.diagnostics?.tactic;
    }, { combatId, targets });
    assert.equal(tactic?.name, 'covering-advance', 'the saved angle rejects the previous flank');
    assert.equal(tactic.reason, 'flank-angle-unmet');
    console.log('world settings UI saved the flank angle, which changed TeamPlan after reload');
  } finally {
    await page.evaluate(({ field, previous }) => game.settings.set('only-war-ai', field, previous),
      { field, previous });
  }
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
  let failed = false;
  try {
    await setup();
    const state = await testSpecOpsFlankAndFix();
    await testWorldSettings(state);
    await testLeaderLossDeterministicSuccessor(state);
    console.log('preset-spec-ops.test.mjs PASSED');
  } catch (err) {
    failed = true;
    console.error('preset-spec-ops.test.mjs FAILED:', err);
    try { await h.screenshot(page, 'preset-spec-ops-failure'); } catch { /* ignore */ }
  } finally {
    try { await cleanup(); } catch { /* ignore */ }
    // CDP: browser.close() would tear down the shared context — the connection ends with the process.
  }
  process.exit(failed ? 1 : 0);
})();
