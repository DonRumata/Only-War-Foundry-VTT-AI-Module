import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import * as h from './lib.mjs';

// Issue #16/#19: live verification of the tactical layer — threat-map
// service, aiDifficulty world setting, lookahead diagnostics, seeded
// personalities and the fireteam character plumbing.

const names = {
  npc: 'AI Tactical NPC',
  enemy: 'AI Tactical Enemy'
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

  npcId = await h.createTestActor(page, 'npc', names.npc, async (actor) => {
    await actor.update({ 'system.characteristics.agility.base': 40 });
    await actor.createEmbeddedDocuments('Item', [
      { name: 'Chainsword', type: 'weapon', system: { class: 'melee', damage: '1d10+4' } },
      { name: 'Lasgun', type: 'weapon', system: { class: 'basic', range: 8, damage: '1d10+3' } }
    ]);
  });
  enemyId = await h.createTestActor(page, 'npc', names.enemy, async (actor) => {
    await actor.createEmbeddedDocuments('Item', [
      { name: 'Lasgun', type: 'weapon', system: { class: 'basic', range: 30, damage: '1d10+3' } }
    ]);
  });
  sceneId = await h.createTestScene(page, { grid: 1, size: 100 });
  npcTokenId = await h.placeToken(page, sceneId, npcId, { x: 400, y: 400 });
  enemyTokenId = await h.placeToken(page, sceneId, enemyId, { x: 900, y: 400 });

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

async function plan(ctx = {}) {
  return page.evaluate(async (data) => {
    const planner = game.modules.get('only-war-ai').api.services.get('planner');
    const combatant = game.combat?.combatants?.get(data.cid);
    const outcome = await planner.planTurn(game.combat, combatant, data.ctx);
    return JSON.parse(JSON.stringify(outcome));
  }, { cid: combatantId, ctx });
}

async function testThreatMapService() {
  const info = await page.evaluate(() => {
    const service = game.modules.get('only-war-ai')?.api?.services?.get('threatMap');
    return {
      present: !!service,
      hasRefresh: typeof service?.refresh === 'function',
      hasDangerAt: typeof service?.dangerAt === 'function',
      hasMap: typeof service?.map === 'function'
    };
  });
  assert.equal(info.present, true, 'threatMap service should be registered');
  assert.equal(info.hasRefresh, true);
  assert.equal(info.hasDangerAt, true);
  assert.equal(info.hasMap, true);
}

async function testDifficultySettingAndApi() {
  const info = await page.evaluate(() => {
    const api = game.modules.get('only-war-ai')?.api;
    const setting = game.settings.settings.get('only-war-ai.aiDifficulty');
    return {
      registered: !!setting,
      default: setting?.default ?? null,
      choices: setting?.choices ? Object.keys(setting.choices) : null,
      personalities: Array.isArray(api?.personalities) ? api.personalities.length : null,
      characters: Array.isArray(api?.fireteamCharacters) ? [...api.fireteamCharacters] : null
    };
  });
  assert.equal(info.registered, true, 'aiDifficulty world setting should be registered');
  assert.equal(info.default, 'normal');
  assert.deepEqual([...(info.choices ?? [])].sort(), ['easy', 'hard', 'normal']);
  assert.ok(info.personalities >= 20, `expected ~24 personality traits, got ${info.personalities}`);
  assert.deepEqual(info.characters, ['disciplined', 'shock', 'elite', 'rabble']);
}

async function testTacticalPlanFields() {
  const result = await plan({ seed: 7 });
  assert.equal(result.status, 'ok', `expected ok plan, got ${result.status}`);
  const p = result.plan;
  assert.equal(p.difficulty, 'normal', 'default difficulty rides on the plan');
  assert.ok(p.personality, 'plan.personality resolved');
  assert.ok(Array.isArray(p.personality.traits), 'traits is an array');
  assert.ok(p.personality.traits.length >= 1 && p.personality.traits.length <= 2,
    `expected 1-2 generated traits, got ${p.personality.traits.length}`);
  assert.equal(p.personality.source, 'generated');
  assert.ok(p.diagnostics?.threatMap?.threats >= 1, 'threat map built from the armed enemy');
  assert.equal(typeof p.diagnostics?.weights?.danger, 'number',
    'danger factor participates in effective weights');
  assert.ok(p.diagnostics?.personality, 'personality diagnostics present');
}

async function testLookahead() {
  const result = await plan({ seed: 7, lookahead: true });
  assert.equal(result.status, 'ok');
  const entries = result.plan.diagnostics?.lookahead?.entries;
  assert.ok(Array.isArray(entries) && entries.length >= 1,
    'lookahead pass should produce re-scored entries');
  assert.equal(typeof entries[0].counterDamage, 'number');
  assert.equal(typeof entries[0].adjusted, 'number');
}

async function testEasyDifficulty() {
  const result = await plan({ seed: 7, difficulty: 'easy' });
  assert.equal(result.status, 'ok');
  assert.equal(result.plan.difficulty, 'easy');
  assert.ok(result.plan.diagnostics?.easyPick, 'easy pick diagnostics present');
  assert.equal(typeof result.plan.diagnostics.easyPick.chance, 'number');
  // Easy bots never read the derived threat field.
  assert.equal(result.plan.diagnostics?.threatMap ?? null, null,
    'derived threat map should be gated off on easy');
}

async function testPersonalityFlagOverride() {
  await page.evaluate(async (aid) => {
    await game.actors.get(aid).setFlag('only-war-ai', 'personality', ['flanker']);
  }, npcId);
  const result = await plan({ seed: 7 });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.plan.personality.traits, ['flanker'],
    'flag personality should win over seeded generation');
  assert.equal(result.plan.personality.source, 'flag');
}

async function testFireteamCharacterPlumbing() {
  const result = await plan({ seed: 7, team: { character: 'shock' } });
  assert.equal(result.status, 'ok');
  assert.equal(result.plan.personality.character, 'shock',
    'context.team.character should surface on the plan');
}

async function testDeterminism() {
  const a = await plan({ seed: 42 });
  const b = await plan({ seed: 42 });
  assert.equal(a.status, 'ok');
  assert.equal(b.status, 'ok');
  assert.equal(a.plan.id, b.plan.id, 'same seed + same world → same plan id');
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
    await testThreatMapService();
    await testDifficultySettingAndApi();
    await testTacticalPlanFields();
    await testLookahead();
    await testEasyDifficulty();
    await testPersonalityFlagOverride();
    await testFireteamCharacterPlumbing();
    await testDeterminism();
    console.log('tactical.test.mjs PASSED');
    process.exit(0);
  } catch (err) {
    console.error('tactical.test.mjs FAILED:', err);
    try { await h.screenshot(page, 'tactical-failure'); } catch { /* ignore */ }
    process.exit(1);
  } finally {
    await cleanup().catch(() => {});
  }
})();
