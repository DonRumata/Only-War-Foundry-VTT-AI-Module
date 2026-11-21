import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import * as h from './lib.mjs';

/**
 * E2E for the GM-only plan and danger overlays (issues #29/#36): in
 * preview mode a parked `runPlan` draws the route/template/target
 * visualization on the controller GM's canvas, every decision clears it,
 * a replan draws the new plan, and the `threatMapOverlay` toggle
 * (service API) renders and cleans the danger heat layer. The overlay
 * never writes documents and never reaches player clients (the service
 * renders only while `game.user.isGM`). Requires a running Foundry
 * (FOUNDRY_URL), Chrome with CDP (CDP_URL) and the only-war-ai module.
 */

const names = {
  npc: 'AI Overlay NPC',
  enemy: 'AI Overlay Enemy'
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
let previousOverlay;

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
  enemyTokenId = await h.placeToken(page, sceneId, enemyId, { x: 1600, y: 500 });

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

  // Force preview mode and keep overlays toggled off for a clean start.
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
  previousOverlay = await page.evaluate(async () => {
    const value = game.settings.get('only-war-ai', 'threatMapOverlay');
    await game.settings.set('only-war-ai', 'threatMapOverlay', false);
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
        id: `e2e-overlay-${foundry.utils.randomID()}`,
        combatantId: data.combatantId,
        phase: 'awaiting-preview'
      },
      seed: 1
    });
    return JSON.parse(JSON.stringify(outcome));
  }, { combatantId });
}

/** Serializable `describe()` snapshot of the planOverlay service. */
async function overlayState() {
  return page.evaluate(() => {
    const overlay = game.modules.get('only-war-ai')?.api?.services?.get('planOverlay');
    return overlay?.describe?.() ?? null;
  });
}

/** The current plan-overlay model (route/cones/blasts/target). */
async function overlayModel() {
  return page.evaluate(() => {
    const overlay = game.modules.get('only-war-ai')?.api?.services?.get('planOverlay');
    return overlay?.model?.() ?? null;
  });
}

async function testOverlayDrawsOnPreview() {
  const result = await runPlan();
  assert.equal(result.status, 'preview', `expected preview, got ${result.status}`);
  await page.waitForSelector(DIALOG, { state: 'visible', timeout: 5000 });

  const state = await overlayState();
  assert.ok(state, 'planOverlay service reachable');
  assert.equal(state.gm, true, 'GM client may draw');
  assert.equal(state.plan.active, true, 'plan overlay active while preview pending');
  assert.ok(state.plan.drawn >= 1, 'overlay children drawn on canvas');

  const model = await overlayModel();
  assert.ok(model, 'plan model stored');
  assert.equal(model.planId, result.plan.id, 'model matches the previewed plan');
  // Assault preset on a 12 m pistol NPC → move route + target highlight.
  assert.ok(model.route, 'route model present (NPC must move into range)');
  assert.ok(model.route.points.length >= 2, 'route polyline carries ≥2 points');
  assert.ok(model.target, 'target highlight model present');
  console.log(`plan overlay drawn: ${JSON.stringify(state.plan)}`);
}

async function testCancelClearsOverlay() {
  await page.click(`${DIALOG} [data-action=cancel]`);
  await page.waitForSelector(DIALOG, { state: 'detached', timeout: 5000 });
  await page.waitForTimeout(300);

  const state = await overlayState();
  assert.equal(state.plan.active, false, 'cancel cleared the plan overlay');
  assert.equal(state.plan.drawn, 0, 'plan layer emptied');
  console.log('cancel cleared the plan overlay');
}

async function testReplanRedraws() {
  const result = await runPlan();
  assert.equal(result.status, 'preview');
  await page.waitForSelector(DIALOG, { state: 'visible', timeout: 5000 });
  const first = await overlayModel();
  assert.equal(first?.planId, result.plan.id);

  const replanButton = await page.$(`${DIALOG} [data-action=replan]`);
  if (!replanButton) {
    console.log('replan button absent — skipping replan redraw check');
    await page.click(`${DIALOG} [data-action=cancel]`);
    await page.waitForSelector(DIALOG, { state: 'detached', timeout: 5000 });
    return;
  }
  await replanButton.click();
  await page.waitForTimeout(1500);

  const state = await overlayState();
  assert.equal(state.plan.active, true, 'overlay stays active after replan');
  const model = await overlayModel();
  assert.ok(model?.planId && model.planId !== first.planId,
    'overlay model holds the replanned plan');

  await page.click(`${DIALOG} [data-action=cancel]`);
  await page.waitForSelector(DIALOG, { state: 'detached', timeout: 5000 });
  const cleared = await overlayState();
  assert.equal(cleared.plan.active, false);
  console.log('replan redrew and cancel cleared the overlay');
}

async function testConfirmClearsOverlay() {
  const result = await runPlan();
  assert.equal(result.status, 'preview');
  await page.waitForSelector(DIALOG, { state: 'visible', timeout: 5000 });
  assert.equal((await overlayState()).plan.active, true);

  await page.click(`${DIALOG} [data-action=confirm]`);
  await page.waitForSelector(DIALOG, { state: 'detached', timeout: 15000 });
  await page.waitForTimeout(500);

  const state = await overlayState();
  assert.equal(state.plan.active, false, 'confirm cleared the plan overlay');
  console.log('confirm cleared the plan overlay');
}

async function testDangerOverlayToggle() {
  const enabled = await page.evaluate(() => {
    const overlay = game.modules.get('only-war-ai')?.api?.services?.get('planOverlay');
    overlay?.setDangerEnabled?.(true, { persist: false });
    return overlay?.describe?.()?.danger ?? null;
  });
  assert.ok(enabled, 'danger state readable');
  assert.equal(enabled.enabled, true, 'danger overlay toggled on');

  const disabled = await page.evaluate(() => {
    const overlay = game.modules.get('only-war-ai')?.api?.services?.get('planOverlay');
    overlay?.setDangerEnabled?.(false, { persist: false });
    return overlay?.describe?.()?.danger ?? null;
  });
  assert.equal(disabled.enabled, false, 'danger overlay toggled off');
  assert.equal(disabled.drawn, 0, 'danger layer emptied on disable');
  console.log('danger overlay toggles and cleans the heat layer');
}

async function cleanup() {
  try {
    await page.evaluate(() => {
      const overlay = game.modules.get('only-war-ai')?.api?.services?.get('planOverlay');
      overlay?.clearAll?.();
    });
    if (previousOverlay !== undefined) {
      await page.evaluate(async (value) => {
        await game.settings.set('only-war-ai', 'threatMapOverlay', value);
      }, previousOverlay);
    }
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
    await h.deleteCombat(page, combatId);
    await h.deleteActor(page, npcId);
    await h.deleteActor(page, enemyId);
    if (sceneId) await h.deleteScene(page, sceneId);
  } catch (err) {
    console.error('cleanup failed', err);
  }
  await browser?.close();
}

async function main() {
  try {
    await setup();
    await testOverlayDrawsOnPreview();
    await testCancelClearsOverlay();
    await testReplanRedraws();
    await testConfirmClearsOverlay();
    await testDangerOverlayToggle();
    console.log('ALL OVERLAY TESTS PASSED');
  } catch (err) {
    console.error('TEST FAILED:', err);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

await main();
