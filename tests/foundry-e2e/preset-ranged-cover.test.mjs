import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import * as h from './lib.mjs';

const names = {
  npc: 'AI Ranged NPC',
  enemy: 'AI Ranged Enemy'
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

  // NPC carries a single lasgun (10u range) so the ranged-cover preset
  // picks firing positions; the enemy is a plain hostile.
  npcId = await h.createTestActor(page, 'npc', names.npc, async (actor) => {
    await actor.update({ 'system.characteristics.agility.base': 40 });
    await actor.createEmbeddedDocuments('Item', [
      { name: 'Lasgun', type: 'weapon', system: { class: 'basic', range: 10, damage: '1d10+3' } }
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

  // A tall wall between the tokens blocks sight and movement; a low wall
  // south-east blocks movement only — cover without losing LOS.
  const wallIds = await page.evaluate(async (data) => {
    const scene = game.scenes.get(data.sceneId);
    const walls = await scene.createEmbeddedDocuments('Wall', [
      { c: [650, 200, 650, 800], sight: 20, move: 20, door: 0 },
      { c: [800, 600, 800, 680], sight: 0, move: 20, door: 0 }
    ]);
    return walls.map((w) => w.id);
  }, { sceneId });
  tallWallId = wallIds[0];

  combatId = await h.createCombat(page, [npcTokenId, enemyTokenId]);
  const combatantId = await page.evaluate((tid) =>
    game.combat?.combatants?.find((c) => c.tokenId === tid)?.id ?? null, npcTokenId);
  assert.ok(combatantId, 'npc combatant exists');
  await h.setOverride(page, {
    kind: 'combatant', id: combatantId, override: { mode: 'enabled', preset: 'rangedCover' }
  });
  page._owaiCombatantId = combatantId;
}

async function testRangedCoverPresetRegistered() {
  const info = await page.evaluate(() => {
    const planner = game.modules.get('only-war-ai')?.api?.services?.get('planner');
    const preset = planner?.getPreset?.('rangedCover');
    return {
      weightCover: preset?.weights?.cover ?? null,
      weightLos: preset?.weights?.los ?? null,
      weightRangeBand: preset?.weights?.rangeBand ?? null,
      weightMelee: preset?.weights?.melee ?? null,
      hasEvaluate: typeof preset?.evaluate === 'function',
      hasVeto: typeof preset?.veto === 'function',
      allowNoTarget: preset?.allowNoTarget === true
    };
  });
  assert.ok(info.weightCover > 0, 'real ranged-cover preset should weight cover');
  assert.ok(info.weightLos > 0, 'real ranged-cover preset should weight LOS');
  assert.ok(info.weightRangeBand > 0, 'real ranged-cover preset should weight the range band');
  assert.ok(info.weightMelee < 0, 'real ranged-cover preset should nearly disallow melee');
  assert.equal(info.hasEvaluate, true);
  assert.equal(info.hasVeto, true);
  assert.equal(info.allowNoTarget, true);
}

async function testBehindWallToFiringPosition() {
  // The NPC stands behind the tall wall: the standing shot is vetoed and
  // the plan relocates to the flank endpoint that has LOS plus cover
  // from the low wall.
  const result = await page.evaluate(async (cid) => {
    const planner = game.modules.get('only-war-ai').api.services.get('planner');
    const combatant = game.combat?.combatants?.get(cid);
    const outcome = await planner.planTurn(game.combat, combatant, {
      seed: 11,
      moves: [
        { x: 700, y: 800, cost: 6, distance: 5.4 },
        { x: 700, y: 300, cost: 6, distance: 5.4 }
      ]
    });
    return JSON.parse(JSON.stringify(outcome));
  }, page._owaiCombatantId);

  assert.equal(result.status, 'ok', `expected ok plan, got ${result.status}`);
  const plan = result.plan;
  assert.equal(plan.preset, 'rangedCover');
  assert.equal(plan.breakdown?.variant, 'move-attack', 'blocked shot should plan move + attack');
  assert.equal(plan.breakdown?.position?.los, 1, 'chosen endpoint must have LOS');
  assert.ok(plan.breakdown?.position?.cover > 0, 'chosen endpoint should be covered');
  const move = plan.steps.find((s) => s.type === 'move');
  assert.ok(move, 'move step exists');
  assert.equal(move.input.to.x, 700);
  assert.equal(move.input.to.y, 800);
  const attack = plan.steps.find((s) => s.type === 'attack');
  assert.ok(attack, 'attack step exists');
  const lasgunUuid = await page.evaluate((aid) =>
    game.actors.get(aid).items.find((i) => i.name === 'Lasgun')?.uuid ?? null, npcId);
  assert.equal(attack.input.itemUuid, lasgunUuid, 'attack should use the lasgun');
  assert.ok(plan.diagnostics.rejected.some((e) => e.reason === 'no-line-of-sight'),
    'blocked attack should be rejected with no-line-of-sight');
  console.log('ranged-cover plan:', JSON.stringify(plan.steps.map((s) => s.type)));
}

async function testBlockedShotNeverFiresBlind() {
  // Still behind the tall wall but with no reachable endpoint: the only
  // attack is vetoed, so the planner reports no-valid-plan instead of a
  // shot through the wall.
  const result = await page.evaluate(async (cid) => {
    const planner = game.modules.get('only-war-ai').api.services.get('planner');
    const combatant = game.combat?.combatants?.get(cid);
    const outcome = await planner.planTurn(game.combat, combatant, { seed: 5, moves: [] });
    return JSON.parse(JSON.stringify(outcome));
  }, page._owaiCombatantId);

  assert.equal(result.status, 'no-action', `expected no-action, got ${result.status}`);
  assert.equal(result.plan, null);
  assert.ok(result.diagnostics.rejected.some((e) => e.reason === 'no-line-of-sight'));
}

async function testOpenPositionMovesToCover() {
  // Remove the tall wall: the current cell now has clear LOS but no
  // cover. Relocating behind the low wall is worth more than firing from
  // the open.
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
        { x: 700, y: 800, cost: 6, distance: 5.4, cover: 0.8 }
      ]
    });
    return JSON.parse(JSON.stringify(outcome));
  }, page._owaiCombatantId);

  assert.equal(result.status, 'ok', `expected ok plan, got ${result.status}`);
  const plan = result.plan;
  assert.equal(plan.breakdown?.variant, 'move-attack', 'open position should relocate to cover');
  const move = plan.steps.find((s) => s.type === 'move');
  assert.ok(move, 'move step exists');
  assert.equal(move.input.to.x, 700);
  assert.equal(move.input.to.y, 800);
  assert.ok(plan.steps.some((s) => s.type === 'attack'), 'attack step exists');
}

async function testLocalizedPresetName() {
  const label = await h.getLocalized(page, 'OWAI.Preset.rangedCover');
  assert.ok(label && label !== 'OWAI.Preset.rangedCover', 'rangedCover preset is localized');
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
    await testRangedCoverPresetRegistered();
    await testLocalizedPresetName();
    await testBehindWallToFiringPosition();
    await testBlockedShotNeverFiresBlind();
    await testOpenPositionMovesToCover();
    console.log('preset-ranged-cover.test.mjs PASSED');
    process.exit(0);
  } catch (err) {
    console.error('preset-ranged-cover.test.mjs FAILED:', err);
    try { await h.screenshot(page, 'preset-ranged-cover-failure'); } catch { /* ignore */ }
    process.exit(1);
  } finally {
    await cleanup().catch(() => {});
  }
})();
