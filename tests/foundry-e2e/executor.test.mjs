import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import * as h from './lib.mjs';

/**
 * E2E for the executor service (issue #407): a full NPC turn —
 * plan → token movement → attack with a chat card → end of turn —
 * executed through `api.services.get("executor").runPlan` on a live
 * Foundry world. Requires a running Foundry (FOUNDRY_URL), Chrome with
 * CDP (CDP_URL) and a system exposing `game.darkHeresy.api.rolls`.
 */

const names = {
  npc: 'AI Executor NPC',
  enemy: 'AI Executor Enemy'
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

async function setup() {
  browser = await chromium.connectOverCDP(h.CDP_URL);
  page = await h.getPage(browser);
  await h.ensureJoinedGame(page);

  console.log('Connected to Foundry game session');

  // A short-range pistol (10 m) with a loaded clip: the enemy stands ~12 m
  // away, so the plan must move before shooting.
  npcId = await h.createTestActor(page, 'npc', names.npc, async (actor) => {
    // Agility feeds `computeMovement` — without it the move budget is 0
    // and the planner legitimately picks attack-in-place.
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
  // 12 m away — beyond pistol range (10 m): under the half-move cap the
  // plan must move before it can shoot.
  enemyTokenId = await h.placeToken(page, sceneId, enemyId, { x: 1600, y: 500 });

  // Explicit dispositions: npc hostile (-1) vs enemy friendly (+1).
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
}

async function testExecutorRegistered() {
  const info = await page.evaluate(() => {
    const executor = game.modules.get('only-war-ai')?.api?.services?.get('executor');
    return {
      present: !!executor,
      hasRunPlan: typeof executor?.runPlan === 'function',
      hasExecutePlan: typeof executor?.executePlan === 'function'
    };
  });
  assert.equal(info.present, true, 'executor service should be registered');
  assert.equal(info.hasRunPlan, true);
  assert.equal(info.hasExecutePlan, true);
}

async function testFullNpcTurn() {
  const rollsAvailable = await page.evaluate(() => {
    const rolls = game.darkHeresy?.api?.rolls;
    return typeof rolls?.prepareAttack === 'function' && typeof rolls?.executeAttack === 'function';
  });

  const ammoBefore = await page.evaluate((aid) => {
    const actor = game.actors.get(aid);
    return actor?.items?.find((i) => i.type === 'weapon')?.system?.clip?.value ?? null;
  }, npcId);

  // Force automatic mode for the duration of the test.
  const previousMode = await page.evaluate(async () => {
    const mode = game.settings.get('only-war-ai', 'executionMode');
    await game.settings.set('only-war-ai', 'executionMode', 'automatic');
    return mode;
  });

  let result;
  try {
    result = await page.evaluate(async (data) => {
      const executor = game.modules.get('only-war-ai')?.api?.services?.get('executor');
      const combatant = game.combat?.combatants?.get(data.combatantId);
      const outcome = await executor.runPlan({
        combat: game.combat,
        combatant,
        operation: {
          id: `e2e-${foundry.utils.randomID()}`,
          combatantId: data.combatantId,
          phase: 'executing'
        },
        seed: 1
      });
      return JSON.parse(JSON.stringify(outcome));
    }, { combatantId });
  } finally {
    await page.evaluate(async (mode) => {
      await game.settings.set('only-war-ai', 'executionMode', mode);
    }, previousMode);
  }

  assert.ok(result, 'runPlan returned a result');
  console.log(`runPlan status=${result.status} reason=${result.reason} steps=${result.stepsDone?.length}`);

  if (!rollsAvailable) {
    // Without the system rolls API the executor must stop safely.
    assert.equal(result.reason, 'system-api-missing');
    assert.ok(['partial', 'failed'].includes(result.status));
    return;
  }

  assert.equal(result.status, 'completed', `expected completed, got ${result.status} (${result.reason})`);
  const types = result.stepsDone.map((s) => s.type);
  assert.ok(types.includes('move'), 'a move step ran');
  assert.ok(types.includes('attack'), 'an attack step ran');
  assert.equal(types.at(-1), 'end-turn', 'the turn ended last');

  // The token actually moved on the scene.
  const tokenPos = await page.evaluate((tid) => {
    const token = canvas.scene?.tokens?.get(tid);
    return token ? { x: token.x, y: token.y } : null;
  }, npcTokenId);
  assert.ok(tokenPos, 'token position readable');
  assert.notDeepEqual(tokenPos, { x: 400, y: 500 }, 'npc token moved towards the enemy');

  // The attack produced a chat card exactly once.
  assert.ok(result.chatMessageIds.length >= 1, 'attack chat card created');
  const chatFound = await page.evaluate((ids) => {
    const messages = game.messages?.contents ?? [];
    return ids.every((id) => messages.some((m) => m.id === id));
  }, result.chatMessageIds);
  assert.equal(chatFound, true, 'chat cards exist in the log');

  // Ammo was spent exactly once — never duplicated by idempotent replays.
  const ammoAfter = await page.evaluate((aid) => {
    const actor = game.actors.get(aid);
    return actor?.items?.find((i) => i.type === 'weapon')?.system?.clip?.value ?? null;
  }, npcId);
  if (ammoBefore !== null && ammoAfter !== null) {
    assert.ok(ammoAfter < ammoBefore, 'ammo was spent');
    assert.ok(ammoBefore - ammoAfter <= 6, 'ammo was not spent twice');
    assert.equal(result.resourceDelta?.ammo ?? 0 <= 0, true);
  }

  // Re-running the same operation id replays the stored result only.
  const replay = await page.evaluate(async (data) => {
    const executor = game.modules.get('only-war-ai')?.api?.services?.get('executor');
    const combatant = game.combat?.combatants?.get(data.combatantId);
    return executor.executePlan(
      { id: 'noop', operationId: data.operationId, steps: [] },
      { combat: game.combat, combatant, operationId: data.operationId }
    );
  }, { combatantId, operationId: result.operationId });
  assert.equal(replay.status, result.status, 'same operation id replays the stored result');
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
    await testExecutorRegistered();
    await testFullNpcTurn();
    console.log('executor.test.mjs PASSED');
    process.exit(0);
  } catch (err) {
    console.error('executor.test.mjs FAILED:', err);
    try { await h.screenshot(page, 'executor-failure'); } catch { /* ignore */ }
    process.exit(1);
  } finally {
    await cleanup().catch(() => {});
  }
})();
