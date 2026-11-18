import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import * as h from './lib.mjs';

/**
 * E2E for the GM preview UI (issue #409): with executionMode=preview a
 * `runPlan` call parks the operation and opens the preview dialog on the
 * controller GM client; Confirm executes the plan (move + attack), Cancel
 * touches nothing and the timeout auto-cancels. Requires a running Foundry
 * (FOUNDRY_URL), Chrome with CDP (CDP_URL) and the only-war-ai module.
 */

const names = {
  npc: 'AI Preview NPC',
  enemy: 'AI Preview Enemy'
};

const DIALOG = '#ow-ai-preview';

let page;
let browser;
let npcId;
let enemyId;
let sceneId;
let npcTokenId;
let enemyTokenId;
let combatId;
let combatantId;
let previousMode;
let previousTimeout;

async function setup() {
  browser = await chromium.connectOverCDP(h.CDP_URL);
  page = await h.getPage(browser);
  await h.ensureJoinedGame(page);

  console.log('Connected to Foundry game session');

  npcId = await h.createTestActor(page, 'npc', names.npc, async (actor) => {
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

  // Force preview mode for the whole test.
  previousMode = await page.evaluate(async () => {
    const mode = game.settings.get('only-war-ai', 'executionMode');
    await game.settings.set('only-war-ai', 'executionMode', 'preview');
    return mode;
  });
  previousTimeout = await page.evaluate(async () => {
    const value = game.settings.get('only-war-ai', 'previewTimeoutSeconds');
    await game.settings.set('only-war-ai', 'previewTimeoutSeconds', 0);
    return value;
  });
}

/** Call executor.runPlan and return the serializable result. */
async function runPlan() {
  return page.evaluate(async (data) => {
    const executor = game.modules.get('only-war-ai')?.api?.services?.get('executor');
    const combatant = game.combat?.combatants?.get(data.combatantId);
    const outcome = await executor.runPlan({
      combat: game.combat,
      combatant,
      operation: {
        id: `e2e-preview-${foundry.utils.randomID()}`,
        combatantId: data.combatantId,
        phase: 'awaiting-preview'
      },
      seed: 1
    });
    return JSON.parse(JSON.stringify(outcome));
  }, { combatantId });
}

async function npcPosition() {
  return page.evaluate((tid) => {
    const token = canvas.scene?.tokens?.get(tid);
    return token ? { x: token.x, y: token.y } : null;
  }, npcTokenId);
}

async function testDialogAppears() {
  const result = await runPlan();
  assert.equal(result.status, 'preview', `expected preview, got ${result.status}`);
  assert.ok(result.plan, 'plan returned for the GM');

  await page.waitForSelector(DIALOG, { state: 'visible', timeout: 5000 });
  const content = await page.evaluate(() => {
    const dialog = document.querySelector('#ow-ai-preview');
    return {
      npc: dialog?.querySelector('.ow-ai-preview-summary')?.textContent ?? '',
      hasConfirm: !!dialog?.querySelector('[data-action=confirm]'),
      hasCancel: !!dialog?.querySelector('[data-action=cancel]'),
      hasReplan: !!dialog?.querySelector('[data-action=replan]'),
      steps: dialog?.querySelectorAll('.ow-ai-steps li')?.length ?? 0
    };
  });
  assert.ok(content.npc.includes(names.npc), 'dialog shows the NPC name');
  assert.equal(content.hasConfirm, true, 'confirm button present');
  assert.equal(content.hasCancel, true, 'cancel button present');
  assert.equal(content.hasReplan, true, 'replan button present');
  assert.ok(content.steps >= 2, 'planned steps listed');
  console.log('preview dialog rendered with plan data');
}

async function testConfirmExecutes() {
  const before = await npcPosition();
  await page.click(`${DIALOG} [data-action=confirm]`);

  await page.waitForFunction(
    (data) => {
      const token = canvas.scene?.tokens?.get(data.npcTokenId);
      return token && (token.x !== data.x || token.y !== data.y);
    },
    { npcTokenId, x: before.x, y: before.y },
    { timeout: 15000 }
  );
  const after = await npcPosition();
  assert.notDeepEqual(after, before, 'confirmed plan moved the token');
  console.log(`confirm executed: token moved ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

  await page.waitForSelector(DIALOG, { state: 'detached', timeout: 5000 });
}

async function testCancelDoesNothing() {
  const before = await npcPosition();
  const messagesBefore = await page.evaluate(() => game.messages?.size ?? 0);

  const result = await runPlan();
  assert.equal(result.status, 'preview');
  await page.waitForSelector(DIALOG, { state: 'visible', timeout: 5000 });
  await page.click(`${DIALOG} [data-action=cancel]`);
  await page.waitForSelector(DIALOG, { state: 'detached', timeout: 5000 });
  await page.waitForTimeout(1000);

  const after = await npcPosition();
  assert.deepEqual(after, before, 'cancel left the token in place');
  const messagesAfter = await page.evaluate(() => game.messages?.size ?? 0);
  assert.equal(messagesAfter, messagesBefore, 'cancel produced no chat cards');
  console.log('cancel touched no documents');
}

async function testTimeoutCancels() {
  await page.evaluate(async () => {
    await game.settings.set('only-war-ai', 'previewTimeoutSeconds', 3);
  });
  try {
    const before = await npcPosition();
    const result = await runPlan();
    assert.equal(result.status, 'preview');
    await page.waitForSelector(DIALOG, { state: 'visible', timeout: 5000 });
    // The 3 s timeout auto-cancels the preview.
    await page.waitForSelector(DIALOG, { state: 'detached', timeout: 10000 });
    await page.waitForTimeout(500);
    const after = await npcPosition();
    assert.deepEqual(after, before, 'timed-out preview left the token in place');
    console.log('timeout auto-cancelled the preview');
  } finally {
    await page.evaluate(async () => {
      await game.settings.set('only-war-ai', 'previewTimeoutSeconds', 0);
    });
  }
}

async function cleanup() {
  try {
    if (previousMode !== undefined) {
      await page.evaluate(async (mode) => {
        await game.settings.set('only-war-ai', 'executionMode', mode);
      }, previousMode);
    }
    if (previousTimeout !== undefined) {
      await page.evaluate(async (value) => {
        await game.settings.set('only-war-ai', 'previewTimeoutSeconds', value);
      }, previousTimeout);
    }
  } catch { /* best-effort */ }
  await h.closeAllWindows(page);
  if (combatId) await h.deleteCombat(page, combatId);
  if (sceneId) await h.deleteScene(page, sceneId);
  if (npcId) await h.deleteActor(page, npcId);
  if (enemyId) await h.deleteActor(page, enemyId);
}

(async () => {
  try {
    await setup();
    await testDialogAppears();
    await testConfirmExecutes();
    await testCancelDoesNothing();
    await testTimeoutCancels();
    console.log('preview.test.mjs PASSED');
    process.exit(0);
  } catch (err) {
    console.error('preview.test.mjs FAILED:', err);
    try { await h.screenshot(page, 'preview-failure'); } catch { /* ignore */ }
    process.exit(1);
  } finally {
    await cleanup().catch(() => {});
  }
})();
