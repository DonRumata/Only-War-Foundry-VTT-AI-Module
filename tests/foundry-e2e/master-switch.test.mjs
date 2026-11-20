import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import * as h from './lib.mjs';

/**
 * E2E for the global master switch (user requirement): with
 * `masterEnabled = false` the whole module is inert вЂ” `runPlan` returns
 * `module-disabled`, the preview service refuses to open, authority does
 * not claim turns and no AI UI is injected. Restoring the flag makes the
 * executor work again. Requires a running Foundry (FOUNDRY_URL), Chrome
 * with CDP (CDP_URL) and the only-war-ai module.
 */

const names = {
  npc: 'AI Switch NPC',
  enemy: 'AI Switch Enemy'
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
  enemyTokenId = await h.placeToken(page, sceneId, enemyId, { x: 1200, y: 500 });
  combatId = await h.createCombat(page, [npcTokenId, enemyTokenId]);
  combatantId = await page.evaluate((tid) =>
    game.combat?.combatants?.find((c) => c.tokenId === tid)?.id ?? null, npcTokenId);
  assert.ok(combatantId, 'npc combatant exists');
  await h.setOverride(page, {
    kind: 'combatant', id: combatantId, override: { mode: 'enabled', preset: 'assault' }
  });
}

async function runPlan() {
  return page.evaluate(async (data) => {
    const executor = game.modules.get('only-war-ai')?.api?.services?.get('executor');
    const combatant = game.combat?.combatants?.get(data.combatantId);
    const outcome = await executor.runPlan({
      combat: game.combat,
      combatant,
      operation: {
        id: `e2e-switch-${foundry.utils.randomID()}`,
        combatantId: data.combatantId,
        phase: 'executing'
      },
      seed: 1
    });
    return JSON.parse(JSON.stringify(outcome));
  }, { combatantId });
}

async function testDisabledBlocksEverything() {
  await page.evaluate(async () => {
    await game.settings.set('only-war-ai', 'executionMode', 'automatic');
    await game.settings.set('only-war-ai', 'masterEnabled', false);
  });

  // The kill switch is visible through the public module flag too.
  const enabled = await page.evaluate(() => game.modules.get('only-war-ai')?.api?.enabled);
  assert.equal(enabled, true, 'module itself is enabled; only the switch is off');

  // Executor refuses.
  const result = await runPlan();
  assert.equal(result.reason, 'module-disabled', `expected module-disabled, got ${result.reason}`);

  // The preview service refuses even when called directly.
  const previewResult = await page.evaluate(() =>
    game.modules.get('only-war-ai')?.api?.services?.get('preview')
      ?.openPreview?.({ plan: { id: 'fake' }, operation: { id: 'fake-op' } }) ?? null);
  assert.equal(previewResult?.ok, false);
  assert.equal(previewResult?.reason, 'module-disabled', `preview gave ${previewResult?.reason}`);

  // The combat tracker injects no AI context menu while disabled.
  const menuLength = await page.evaluate(() => {
    const menu = [];
    Hooks.callAll('getCombatTrackerEntryContext', null, menu);
    return menu.length;
  });
  assert.equal(menuLength, 0, 'no AI entries in the combat tracker menu while disabled');
  console.log('masterEnabled=false blocks executor, preview and UI');
}

async function testEnabledRestores() {
  await page.evaluate(async () => {
    await game.settings.set('only-war-ai', 'masterEnabled', true);
    await game.settings.set('only-war-ai', 'executionMode', 'automatic');
  });
  const result = await runPlan();
  assert.equal(result.status, 'completed', `expected completed, got ${result.status} (${result.reason})`);
  console.log('masterEnabled=true restores automatic execution');
}

async function cleanup() {
  await page.evaluate(async () => {
    await game.settings.set('only-war-ai', 'masterEnabled', true);
    await game.settings.set('only-war-ai', 'executionMode', 'preview');
  }).catch(() => {});
  await h.closeAllWindows(page);
  if (combatId) await h.deleteCombat(page, combatId);
  if (sceneId) await h.deleteScene(page, sceneId);
  if (npcId) await h.deleteActor(page, npcId);
  if (enemyId) await h.deleteActor(page, enemyId);
}

(async () => {
  try {
    await setup();
    await testDisabledBlocksEverything();
    await testEnabledRestores();
    console.log('master-switch.test.mjs PASSED');
    process.exit(0);
  } catch (err) {
    console.error('master-switch.test.mjs FAILED:', err);
    try { await h.screenshot(page, 'master-switch-failure'); } catch { /* ignore */ }
    process.exit(1);
  } finally {
    await cleanup().catch(() => {});
    // CDP: browser.close() would tear down the shared context — the connection ends with the process.
  }
})();
