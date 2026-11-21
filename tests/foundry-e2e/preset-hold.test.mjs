import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import * as h from './lib.mjs';

const names = {
  npc: 'AI Hold NPC',
  enemy: 'AI Hold Enemy'
};

let page;
let browser;
let npcId;
let enemyId;
let sceneId;
let npcTokenId;
let enemyTokenId;
let combatId;
let tallWallId;

async function setup() {
  browser = await chromium.connectOverCDP(h.CDP_URL);
  page = await h.getPage(browser);
  await h.ensureJoinedGame(page);

  console.log('Connected to Foundry game session');

  // NPC carries a single lasgun (30u range) so the hold preset keeps a
  // firing position; the enemy is a plain hostile.
  npcId = await h.createTestActor(page, 'npc', names.npc, async (actor) => {
    await actor.update({ 'system.characteristics.agility.base': 40 });
    await actor.createEmbeddedDocuments('Item', [
      { name: 'Lasgun', type: 'weapon', system: { class: 'basic', range: 30, damage: '1d10+3' } }
    ]);
  });
  enemyId = await h.createTestActor(page, 'npc', names.enemy);
  sceneId = await h.createTestScene(page, { grid: 1, size: 100 });
  npcTokenId = await h.placeToken(page, sceneId, npcId, { x: 400, y: 500 });
  enemyTokenId = await h.placeToken(page, sceneId, enemyId, { x: 900, y: 500 });

  // Explicit dispositions: npc hostile (-1) vs enemy friendly (+1).
  await page.evaluate(async (data) => {
    const scene = game.scenes.get(data.sceneId);
    await scene.tokens.get(data.npcTokenId).update({ disposition: -1 });
    await scene.tokens.get(data.enemyTokenId).update({ disposition: 1 });
  }, { sceneId, npcTokenId, enemyTokenId });

  // A tall wall between the tokens blocks sight and movement.
  const wallIds = await page.evaluate(async (data) => {
    const scene = game.scenes.get(data.sceneId);
    const walls = await scene.createEmbeddedDocuments('Wall', [
      { c: [650, 200, 650, 800], sight: 20, move: 20, door: 0 }
    ]);
    return walls.map((w) => w.id);
  }, { sceneId });
  tallWallId = wallIds[0];

  combatId = await h.createCombat(page, [npcTokenId, enemyTokenId]);
  const combatantId = await page.evaluate((tid) =>
    game.combat?.combatants?.find((c) => c.tokenId === tid)?.id ?? null, npcTokenId);
  assert.ok(combatantId, 'npc combatant exists');
  await h.setOverride(page, {
    kind: 'combatant', id: combatantId, override: { mode: 'enabled', preset: 'hold' }
  });
  page._owaiCombatantId = combatantId;
}

async function testHoldPresetRegistered() {
  const info = await page.evaluate(() => {
    const planner = game.modules.get('only-war-ai')?.api?.services?.get('planner');
    const preset = planner?.getPreset?.('hold');
    return {
      weightHold: preset?.weights?.holdPosition ?? null,
      weightAttackNow: preset?.weights?.attackNow ?? null,
      weightAttackAfterMove: preset?.weights?.attackAfterMove ?? null,
      weightCharge: preset?.weights?.charge ?? null,
      hasEvaluate: typeof preset?.evaluate === 'function',
      hasVeto: typeof preset?.veto === 'function',
      allowNoTarget: preset?.allowNoTarget === true,
      alwaysOfferHold: preset?.alwaysOfferHold === true
    };
  });
  assert.ok(info.weightHold > 0, 'real hold preset should weight staying very high');
  assert.ok(info.weightAttackNow > info.weightAttackAfterMove,
    'attacking from the current position should beat repositioning');
  assert.ok(info.weightCharge < 0, 'real hold preset should nearly disallow charges');
  assert.equal(info.hasEvaluate, true);
  assert.equal(info.hasVeto, true);
  assert.equal(info.allowNoTarget, true);
  assert.equal(info.alwaysOfferHold, true);
}

async function testLocalizedPresetName() {
  const label = await h.getLocalized(page, 'OWAI.Preset.hold');
  assert.ok(label && label !== 'OWAI.Preset.hold', 'hold preset is localized');
}

async function testBehindWallExitsToLosAndAttacks() {
  // The NPC stands behind the tall wall: the standing shot is vetoed and
  // the plan relocates inside the hold radius to an endpoint with LOS.
  const result = await page.evaluate(async (cid) => {
    const planner = game.modules.get('only-war-ai').api.services.get('planner');
    const combatant = game.combat?.combatants?.get(cid);
    const outcome = await planner.planTurn(game.combat, combatant, {
      seed: 11,
      hold: { radiusMeters: 30 },
      moves: [
        { x: 700, y: 800, cost: 6, distance: 5.4, los: true },
        { x: 500, y: 500, cost: 1, distance: 4 }
      ]
    });
    return JSON.parse(JSON.stringify(outcome));
  }, page._owaiCombatantId);

  assert.equal(result.status, 'ok', `expected ok plan, got ${result.status}`);
  const plan = result.plan;
  assert.equal(plan.preset, 'hold');
  assert.equal(plan.breakdown?.variant, 'move-attack', 'blocked shot should plan move + attack');
  assert.equal(plan.breakdown?.factors?.moveToLos, 1, 'endpoint should restore LOS');
  const move = plan.steps.find((s) => s.type === 'move');
  assert.ok(move, 'move step exists');
  assert.equal(move.input.to.x, 700);
  assert.equal(move.input.to.y, 800);
  const attack = plan.steps.find((s) => s.type === 'attack');
  assert.ok(attack, 'attack step exists');
  assert.ok(plan.diagnostics.rejected.some((e) => e.reason === 'no-line-of-sight'),
    'blocked attack should be rejected with no-line-of-sight');
  console.log('hold plan:', JSON.stringify(plan.steps.map((s) => s.type)));
}

async function testHoldsPositionWithAttack() {
  // Remove the tall wall: the current position now offers a legal attack,
  // so the preset must not move at all.
  await page.evaluate(async (data) => {
    const scene = game.scenes.get(data.sceneId);
    await scene.deleteEmbeddedDocuments('Wall', [data.tallWallId]);
  }, { sceneId, tallWallId });
  tallWallId = null;

  const result = await page.evaluate(async (cid) => {
    const planner = game.modules.get('only-war-ai').api.services.get('planner');
    const combatant = game.combat?.combatants?.get(cid);
    const outcome = await planner.planTurn(game.combat, combatant, {
      seed: 7,
      moves: [
        { x: 700, y: 800, cost: 6, distance: 5.4, los: true, cover: 0.8 }
      ]
    });
    return JSON.parse(JSON.stringify(outcome));
  }, page._owaiCombatantId);

  assert.equal(result.status, 'ok', `expected ok plan, got ${result.status}`);
  const plan = result.plan;
  // Issue #15: the aim-attack variant also holds position — it fires
  // from the current cell with a half-action aim folded in.
  assert.ok(['attack-in-place', 'aim-attack'].includes(plan.breakdown?.variant),
    `a legal attack from the position must not move, got ${plan.breakdown?.variant}`);
  assert.ok(plan.steps.every((s) => s.type !== 'move'), 'no move step while holding');
  const attack = plan.steps.find((s) => s.type === 'attack');
  assert.ok(attack, 'attack step exists');
  const lasgunUuid = await page.evaluate((aid) =>
    game.actors.get(aid).items.find((i) => i.name === 'Lasgun')?.uuid ?? null, npcId);
  assert.equal(attack.input.itemUuid, lasgunUuid, 'attack should use the lasgun');
}

async function testMeleeContactIsAnswered() {
  // Drag the enemy onto the NPC: the melee contact is recorded and the
  // NPC responds with an attack instead of abandoning the position.
  await page.evaluate(async (data) => {
    const scene = game.scenes.get(data.sceneId);
    await scene.tokens.get(data.enemyTokenId).update({ x: 420, y: 500 });
  }, { sceneId, enemyTokenId });

  const result = await page.evaluate(async (cid) => {
    const planner = game.modules.get('only-war-ai').api.services.get('planner');
    const combatant = game.combat?.combatants?.get(cid);
    const outcome = await planner.planTurn(game.combat, combatant, {
      seed: 9,
      moves: [
        { x: 300, y: 500, cost: 1, distance: 2.4, los: true }
      ]
    });
    return JSON.parse(JSON.stringify(outcome));
  }, page._owaiCombatantId);

  assert.equal(result.status, 'ok', `expected ok plan, got ${result.status}`);
  const plan = result.plan;
  assert.equal(plan.breakdown?.position?.meleeContact, true, 'melee contact should be recorded');
  assert.ok(['attack-in-place', 'move-attack'].includes(plan.breakdown?.variant),
    `expected attack or retreat-attack, got ${plan.breakdown?.variant}`);
  assert.ok(plan.steps.some((s) => s.type === 'attack'), 'attack step exists');
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
    await testHoldPresetRegistered();
    await testLocalizedPresetName();
    await testBehindWallExitsToLosAndAttacks();
    await testHoldsPositionWithAttack();
    await testMeleeContactIsAnswered();
    console.log('preset-hold.test.mjs PASSED');
    process.exit(0);
  } catch (err) {
    console.error('preset-hold.test.mjs FAILED:', err);
    try { await h.screenshot(page, 'preset-hold-failure'); } catch { /* ignore */ }
    process.exit(1);
  } finally {
    await cleanup().catch(() => {});
  }
})();
