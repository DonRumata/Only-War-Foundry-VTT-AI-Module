import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import * as h from './lib.mjs';

const names = {
  npc: 'AI Assault NPC',
  enemy: 'AI Assault Enemy'
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

  // NPC with a melee weapon and a short-range lasgun so the assault
  // preset can express charge vs move+ranged choices deterministically.
  npcId = await h.createTestActor(page, 'npc', names.npc, async (actor) => {
    await actor.createEmbeddedDocuments('Item', [
      { name: 'Chainsword', type: 'weapon', system: { class: 'melee', damage: '1d10+4' } },
      { name: 'Lasgun', type: 'weapon', system: { class: 'basic', range: 8, damage: '1d10+3' } }
    ]);
  });
  enemyId = await h.createTestActor(page, 'npc', names.enemy);
  sceneId = await h.createTestScene(page, { grid: 1, size: 100 });
  npcTokenId = await h.placeToken(page, sceneId, npcId, { x: 400, y: 400 });
  enemyTokenId = await h.placeToken(page, sceneId, enemyId, { x: 700, y: 400 });

  // Explicit dispositions: npc hostile (-1) vs enemy friendly (+1).
  await page.evaluate(async (data) => {
    const scene = game.scenes.get(data.sceneId);
    await scene.tokens.get(data.npcTokenId).update({ disposition: -1 });
    await scene.tokens.get(data.enemyTokenId).update({ disposition: 1 });
  }, { sceneId, npcTokenId, enemyTokenId });

  combatId = await h.createCombat(page, [npcTokenId, enemyTokenId]);
  const combatantId = await page.evaluate((tid) =>
    game.combat?.combatants?.find((c) => c.tokenId === tid)?.id ?? null, npcTokenId);
  assert.ok(combatantId, 'npc combatant exists');
  await h.setOverride(page, {
    kind: 'combatant', id: combatantId, override: { mode: 'enabled', preset: 'assault' }
  });
  page._owaiCombatantId = combatantId;
}

async function testAssaultPresetRegistered() {
  const info = await page.evaluate(() => {
    const planner = game.modules.get('only-war-ai')?.api?.services?.get('planner');
    const preset = planner?.getPreset?.('assault');
    return {
      weightCharge: preset?.weights?.charge ?? null,
      weightMelee: preset?.weights?.melee ?? null,
      hasEvaluate: typeof preset?.evaluate === 'function',
      allowNoTarget: preset?.allowNoTarget === true
    };
  });
  assert.ok(info.weightCharge > 0, 'real assault preset should weight charge');
  assert.ok(info.weightMelee > 0, 'real assault preset should weight melee');
  assert.equal(info.hasEvaluate, true);
  assert.equal(info.allowNoTarget, true);
}

async function testChargeToMelee() {
  const result = await page.evaluate(async (cid) => {
    const planner = game.modules.get('only-war-ai').api.services.get('planner');
    const combatant = game.combat?.combatants?.get(cid);
    const outcome = await planner.planTurn(game.combat, combatant, { seed: 11 });
    return JSON.parse(JSON.stringify(outcome));
  }, page._owaiCombatantId);

  assert.equal(result.status, 'ok', `expected ok plan, got ${result.status}`);
  const plan = result.plan;
  assert.equal(plan.preset, 'assault');
  assert.equal(plan.breakdown?.variant, 'charge', 'close target should plan a charge');
  const attack = plan.steps.find((s) => s.type === 'attack');
  assert.ok(attack, 'attack step exists');
  assert.equal(attack.input.mode, 'charge');
  const swordUuid = await page.evaluate((aid) =>
    game.actors.get(aid).items.find((i) => i.name === 'Chainsword')?.uuid ?? null, npcId);
  assert.equal(attack.input.itemUuid, swordUuid, 'charge should use the melee weapon');
  assert.equal(plan.steps.at(-1).type, 'end-turn');
  console.log('charge plan:', JSON.stringify(plan.steps.map((s) => s.type)));
}

async function testMovePlusRanged() {
  // Push the enemy beyond standing weapon range; inject a legal route
  // that lands inside lasgun range (navigation service stand-in).
  await page.evaluate(async (data) => {
    await game.scenes.get(data.sceneId).tokens.get(data.enemyTokenId)
      .update({ x: 1900, y: 400 });
  }, { sceneId, enemyTokenId });

  const result = await page.evaluate(async (cid) => {
    const planner = game.modules.get('only-war-ai').api.services.get('planner');
    const combatant = game.combat?.combatants?.get(cid);
    const scene = canvas.scene;
    const size = scene.grid.size || 100;
    const unit = scene.grid.distance || 1;
    const pxPerUnit = size / unit;
    const target = Array.from(scene.tokens.values())
      .find((t) => t.id !== combatant.tokenId);
    const landing = {
      x: target.x - 6 * pxPerUnit,
      y: target.y,
      cost: 8,
      distance: 6,
      los: true
    };
    const outcome = await planner.planTurn(game.combat, combatant, {
      seed: 7,
      moves: [landing]
    });
    return JSON.parse(JSON.stringify(outcome));
  }, page._owaiCombatantId);

  assert.equal(result.status, 'ok', `expected ok plan, got ${result.status}`);
  const plan = result.plan;
  assert.equal(plan.breakdown?.variant, 'move-attack', 'far target should plan move + ranged attack');
  const move = plan.steps.find((s) => s.type === 'move');
  const attack = plan.steps.find((s) => s.type === 'attack');
  assert.ok(move && attack, 'move + attack steps exist');
  assert.notEqual(attack.input.mode, 'charge');
  const lasgunUuid = await page.evaluate((aid) =>
    game.actors.get(aid).items.find((i) => i.name === 'Lasgun')?.uuid ?? null, npcId);
  assert.equal(attack.input.itemUuid, lasgunUuid, 'fallback attack should use the ranged weapon');
}

async function testLastKnownSearch() {
  // Enemy breaks line of sight (hidden): the AI may only move toward the
  // last-known contact, never attack it.
  await page.evaluate(async (data) => {
    await game.scenes.get(data.sceneId).tokens.get(data.enemyTokenId)
      .update({ hidden: true });
  }, { sceneId, enemyTokenId });

  const result = await page.evaluate(async (data) => {
    const planner = game.modules.get('only-war-ai').api.services.get('planner');
    const combatant = game.combat?.combatants?.get(data.cid);
    const token = canvas.scene.tokens.get(data.enemyTokenId);
    const outcome = await planner.planTurn(game.combat, combatant, {
      seed: 5,
      targets: [{
        tokenId: token.id,
        tokenUuid: token.document?.uuid ?? token.uuid,
        x: token.x,
        y: token.y,
        source: 'last-known'
      }]
    });
    return JSON.parse(JSON.stringify(outcome));
  }, { cid: page._owaiCombatantId, enemyTokenId });

  assert.equal(result.status, 'ok', `expected ok plan, got ${result.status}`);
  const plan = result.plan;
  assert.ok(plan.steps.every((s) => s.type !== 'attack'), 'last-known must not be attacked');
  assert.ok(plan.steps.some((s) => s.type === 'move'), 'search move expected');
  assert.equal(plan.steps.at(-1).input.reason, 'no-attack');
}

async function testLocalizedPresetName() {
  const label = await h.getLocalized(page, 'OWAI.Preset.assault');
  assert.ok(label && label !== 'OWAI.Preset.assault', 'assault preset is localized');
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
    await testAssaultPresetRegistered();
    await testLocalizedPresetName();
    await testChargeToMelee();
    await testMovePlusRanged();
    await testLastKnownSearch();
    console.log('preset-assault.test.mjs PASSED');
    process.exit(0);
  } catch (err) {
    console.error('preset-assault.test.mjs FAILED:', err);
    try { await h.screenshot(page, 'preset-assault-failure'); } catch { /* ignore */ }
    process.exit(1);
  } finally {
    await cleanup().catch(() => {});
  }
})();
