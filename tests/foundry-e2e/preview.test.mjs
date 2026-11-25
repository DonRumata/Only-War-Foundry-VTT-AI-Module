import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import * as h from './lib.mjs';

/**
 * E2E for the GM preview UI (issue #409): with executionMode=preview a
 * tracker turn parks the real operation and opens the preview dialog on the
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
let previousSettings;

async function setup() {
  browser = await chromium.connectOverCDP(h.CDP_URL);
  page = await h.getPage(browser);
  await h.ensureJoinedGame(page);

  console.log('Connected to Foundry game session');

  npcId = await h.createTestActor(page, 'npc', names.npc, async (actor) => {
    // Agility feeds `computeMovement` — without it the move budget is 0
    // and the planner legitimately picks attack-in-place.
    await actor.update({ 'system.characteristics.agility.base': 40 });
    await actor.createEmbeddedDocuments('Item', [
      {
        name: 'Chainsword',
        type: 'weapon',
        system: { class: 'melee', damage: '1d10+4' }
      }
    ]);
  });
  enemyId = await h.createTestActor(page, 'npc', names.enemy);
  sceneId = await h.createTestScene(page, { grid: 1, size: 100 });
  npcTokenId = await h.placeToken(page, sceneId, npcId, { x: 400, y: 500 });
  // Out of melee reach, within a charge.
  enemyTokenId = await h.placeToken(page, sceneId, enemyId, { x: 800, y: 500 });

  await page.evaluate(async (data) => {
    const scene = game.scenes.get(data.sceneId);
    await scene.tokens.get(data.npcTokenId).update({ disposition: -1 });
    await scene.tokens.get(data.enemyTokenId).update({ disposition: 1 });
  }, { sceneId, npcTokenId, enemyTokenId });

  combatId = await h.createCombat(page, [npcTokenId, enemyTokenId]);
  combatantId = await page.evaluate(async ({ combatId, npcTokenId }) => {
    const combat = game.combats.get(combatId);
    combat.getTimeDelta = () => 0;
    await combat.updateEmbeddedDocuments('Combatant', combat.combatants.map(c => ({
      _id: c.id, initiative: c.tokenId === npcTokenId ? 20 : 10
    })));
    return combat.combatants.find(c => c.tokenId === npcTokenId)?.id;
  }, { combatId, npcTokenId });
  assert.ok(combatantId, 'npc combatant exists');
  await h.setOverride(page, {
    kind: 'combatant', id: combatantId, override: { mode: 'enabled', preset: 'assault' }
  });

  // Force preview mode for the whole test.
  previousSettings = await page.evaluate(async () => {
    const settings = { executionMode: 'preview', previewTimeoutSeconds: 0,
      turnPacingMs: 0, damageWaitTimeoutSeconds: 1, damageWaitAutoAdvance: true };
    const previous = Object.fromEntries(Object.keys(settings).map(key =>
      [key, game.settings.get('only-war-ai', key)]));
    for (const [key, value] of Object.entries(settings)) {
      await game.settings.set('only-war-ai', key, value);
    }
    return previous;
  });
}

async function requestPreview() {
  await page.evaluate(async ({ combatId, combatantId }) => {
    const combat = game.combats.get(combatId);
    if (combat.round === 0) {
      await combat.update({ round: 1, turn: 0 });
    } else {
      // After cancellation the GM still owns that turn. Pass it and the
      // opponent's turn to request a fresh, authoritative preview.
      if (combat.combatant?.id === combatantId) await combat.nextTurn();
      await combat.nextTurn();
    }
  }, { combatId, combatantId });
  await page.waitForSelector(DIALOG, { state: 'visible', timeout: 15000 });
}

async function waitForCancellation() {
  await page.waitForSelector(DIALOG, { state: 'detached', timeout: 10000 });
  await page.waitForFunction(id =>
    game.combats.get(id)?.getFlag('only-war-ai', 'operation')?.phase === 'cancelled',
  combatId);
}

async function currentTurn() {
  return page.evaluate(id => {
    const combat = game.combats.get(id);
    return [combat.round, combat.turn, combat.combatant?.id];
  }, combatId);
}

async function npcPosition() {
  return page.evaluate((tid) => {
    const token = canvas.scene?.tokens?.get(tid);
    // `token.x` is the animated position — `_source` holds the applied
    // document coordinates even while the placeable is still moving.
    return token
      ? { x: token._source?.x ?? token.x, y: token._source?.y ?? token.y }
      : null;
  }, npcTokenId);
}

async function testDialogAppears() {
  await requestPreview();
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
      const x = token?._source?.x ?? token?.x;
      const y = token?._source?.y ?? token?.y;
      return token && (x !== data.x || y !== data.y);
    },
    { npcTokenId, x: before.x, y: before.y },
    { timeout: 15000 }
  );
  const after = await npcPosition();
  assert.notDeepEqual(after, before, 'confirmed plan moved the token');
  // Issue #32: document positions are grid-aligned — the move payload
  // converts serialized cell centres to top-left doc coordinates.
  assert.equal(after.x % 100, 0, `token x on-grid, got ${after.x}`);
  assert.equal(after.y % 100, 0, `token y on-grid, got ${after.y}`);
  console.log(`confirm executed: token moved ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

  await page.waitForSelector(DIALOG, { state: 'detached', timeout: 5000 });
  await page.waitForFunction(({ combatId, enemyTokenId }) =>
    game.combats.get(combatId)?.combatant?.tokenId === enemyTokenId,
  { combatId, enemyTokenId }, { timeout: 20000 });
}

async function testCancelDoesNothing() {
  await requestPreview();
  const before = await npcPosition();
  const turnBefore = await currentTurn();
  const messagesBefore = await page.evaluate(() => game.messages?.size ?? 0);

  await page.click(`${DIALOG} [data-action=cancel]`);
  await waitForCancellation();

  const after = await npcPosition();
  assert.deepEqual(after, before, 'cancel left the token in place');
  assert.deepEqual(await currentTurn(), turnBefore, 'cancel kept the NPC turn');
  const messagesAfter = await page.evaluate(() => game.messages?.size ?? 0);
  assert.equal(messagesAfter, messagesBefore, 'cancel produced no chat cards');
  console.log('cancel touched no documents');
}

async function testTimeoutCancels() {
  await page.evaluate(async () => {
    await game.settings.set('only-war-ai', 'previewTimeoutSeconds', 3);
  });
  try {
    await requestPreview();
    const before = await npcPosition();
    const turnBefore = await currentTurn();
    await waitForCancellation();
    assert.deepEqual(await npcPosition(), before, 'timed-out preview left the token in place');
    assert.deepEqual(await currentTurn(), turnBefore, 'timed-out preview kept the NPC turn');
    console.log('timeout auto-cancelled the preview');
  } finally {
    await page.evaluate(async () => {
      await game.settings.set('only-war-ai', 'previewTimeoutSeconds', 0);
    });
  }
}

async function cleanup() {
  try {
    if (previousSettings) {
      await page.evaluate(async settings => {
        for (const [key, value] of Object.entries(settings)) {
          await game.settings.set('only-war-ai', key, value);
        }
      }, previousSettings);
    }
  } catch { /* best-effort */ }
  await h.closeAllWindows(page);
  if (combatId) await h.deleteCombat(page, combatId);
  if (sceneId) await h.deleteScene(page, sceneId);
  if (npcId) await h.deleteActor(page, npcId);
  if (enemyId) await h.deleteActor(page, enemyId);
}

(async () => {
  let failed = false;
  try {
    await setup();
    await testDialogAppears();
    await testConfirmExecutes();
    await testCancelDoesNothing();
    await testTimeoutCancels();
    console.log('preview.test.mjs PASSED');
  } catch (err) {
    failed = true;
    console.error('preview.test.mjs FAILED:', err);
    try { await h.screenshot(page, 'preview-failure'); } catch { /* ignore */ }
  } finally {
    await cleanup().catch(() => {});
    await browser?.close();
  }
  process.exit(failed ? 1 : 0);
})();
