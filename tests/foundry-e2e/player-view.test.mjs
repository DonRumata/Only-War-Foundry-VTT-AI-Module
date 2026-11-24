import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import * as h from './lib.mjs';

/**
 * E2E for the player-view security requirement (issue #409 + user
 * direction): the AI preview is GM-only. A second client joined as a
 * Player must not see the preview dialog, must not be able to execute or
 * preview plans itself and must not receive AI UI. Requires a running
 * Foundry (FOUNDRY_URL), Chrome with CDP (CDP_URL) and the only-war-ai
 * module.
 */

const names = {
  npc: 'AI PlayerView NPC',
  enemy: 'AI PlayerView Enemy',
  player: 'AI E2E Player'
};

const DIALOG = '#ow-ai-preview';

let page;
let playerPage;
let browser;
let playerUserId;
let npcId;
let enemyId;
let sceneId;
let npcTokenId;
let enemyTokenId;
let combatId;
let combatantId;

/** Join a second page as a Player-role user. */
async function joinAsPlayer() {
  playerPage = await (browser.contexts()[0] || await browser.newContext()).newPage();
  await playerPage.setViewportSize({ width: 1400, height: 900 });
  await playerPage.goto(`${h.FOUNDRY_URL}/join`, { waitUntil: 'load' });
  await playerPage.waitForFunction(() =>
    document.querySelectorAll('select[name="userid"] option').length > 0, { timeout: 10000 });
  await playerPage.locator('select[name="userid"]').selectOption(playerUserId, { force: true });
  const passwordInput = await playerPage.$('input[name="password"]');
  if (passwordInput) await passwordInput.fill('');
  await Promise.all([
    playerPage.waitForURL(`${h.FOUNDRY_URL}/game`, { waitUntil: 'load' }),
    playerPage.click('button[name="join"]')
  ]);
  await playerPage.waitForFunction(() =>
    typeof game !== 'undefined' && game?.ready && game?.user, { timeout: 30000 });
  await playerPage.waitForTimeout(1500);
}

async function setup() {
  browser = await chromium.connectOverCDP(h.CDP_URL);
  // A stale player tab may outrank `pages()[0]` вЂ” pick the GM client.
  for (const candidate of (browser.contexts()[0] || await browser.newContext()).pages()) {
    try {
      const isGM = await candidate.evaluate(() => globalThis.game?.user?.isGM === true);
      if (isGM) { page = candidate; break; }
    } catch { /* tab without a game session */ }
  }
  page = page ?? await h.getPage(browser);
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

  // A dedicated Player-role user; the GM page drives the world, the
  // second page proves what a player client sees.
  playerUserId = await page.evaluate(async (name) => {
    const existing = game.users.find((u) => u.name === name);
    if (existing) {
      await existing.update({ role: CONST.USER_ROLES.PLAYER });
      return existing.id;
    }
    const created = await User.create({ name, role: CONST.USER_ROLES.PLAYER });
    return created.id;
  }, names.player);
  assert.ok(playerUserId, 'player user created');

  await page.evaluate(async () => {
    await game.settings.set('only-war-ai', 'executionMode', 'preview');
    await game.settings.set('only-war-ai', 'previewTimeoutSeconds', 0);
  });
}

async function testPlayerSeesNoPreview() {
  await joinAsPlayer();

  const roles = await Promise.all([
    page.evaluate(() => game.user?.role),
    playerPage.evaluate(() => game.user?.role)
  ]);
  assert.notEqual(roles[0], roles[1], 'GM and player pages use different roles');
  assert.ok(roles[0] >= 3, `first page must be GM-ish, got role ${roles[0]}`);
  assert.equal(roles[1], 1, `second page must be a player, got role ${roles[1]}`);

  // GM runs the plan in preview mode вЂ” the dialog opens for the GM.
  const result = await page.evaluate(async (data) => {
    const executor = game.modules.get('only-war-ai')?.api?.services?.get('executor');
    const combatant = game.combat?.combatants?.get(data.combatantId);
    const outcome = await executor.runPlan({
      combat: game.combat,
      combatant,
      operation: {
        id: `e2e-player-${foundry.utils.randomID()}`,
        combatantId: data.combatantId,
        phase: 'awaiting-preview'
      },
      seed: 1
    });
    return JSON.parse(JSON.stringify(outcome));
  }, { combatantId });
  assert.equal(result.status, 'preview', `expected preview, got ${result.status}`);
  await page.waitForSelector(DIALOG, { state: 'visible', timeout: 5000 });

  // Give sockets/hooks a beat to reach the player client, then check.
  await playerPage.waitForTimeout(2000);
  const playerState = await playerPage.evaluate(() => ({
    dialog: !!document.querySelector('#ow-ai-preview'),
    isGM: game.user?.isGM,
    moduleEnabled: game.modules.get('only-war-ai')?.api?.enabled ?? null
  }));
  assert.equal(playerState.dialog, false, 'player client must not render the AI preview');
  assert.equal(playerState.isGM, false, 'joined user is not a GM');
  console.log('player client renders no preview dialog');
}

async function testPlayerCannotDrive() {
  // The player client cannot open the preview or execute plans itself.
  const denied = await playerPage.evaluate(async (data) => {
    const api = game.modules.get('only-war-ai')?.api;
    const out = {};
    const preview = api?.services?.get('preview');
    out.preview = await Promise.resolve(preview?.openPreview?.({
      plan: { id: 'x' }, operation: { id: 'x-op' }
    }) ?? null);
    const executor = api?.services?.get('executor');
    const combatant = game.combat?.combatants?.get(data.combatantId);
    if (executor && combatant) {
      out.exec = await executor.runPlan({
        combat: game.combat,
        combatant,
        operation: {
          id: `e2e-player-exec-${foundry.utils.randomID()}`,
          combatantId: data.combatantId,
          phase: 'executing'
        },
        seed: 1
      });
      out.exec = JSON.parse(JSON.stringify(out.exec));
    }
    return out;
  }, { combatantId });
  assert.ok(denied.preview, 'player preview call returns a result');
  assert.equal(denied.preview.ok, false, 'player cannot open the preview');
  assert.ok(['not-controller', 'module-disabled', 'automatic-mode'].includes(denied.preview.reason),
    `unexpected preview reason ${denied.preview.reason}`);
  assert.ok(denied.exec, 'player executor call returns a result');
  assert.ok(['not-controller', 'module-disabled', 'permission-denied'].includes(denied.exec.reason)
    || denied.exec.status === 'failed' || denied.exec.status === 'cancelled',
    `player must not execute plans, got ${denied.exec.status} ${denied.exec.reason}`);
  console.log(`player client refused: preview=${denied.preview.reason}, exec=${denied.exec.reason ?? denied.exec.status}`);

  // The player sees no AI combat-tracker entries either.
  const menuLength = await playerPage.evaluate(() => {
    const menu = [];
    Hooks.callAll('getCombatTrackerEntryContext', null, menu);
    return menu.length;
  });
  assert.equal(menuLength, 0, 'no AI entries in the player combat tracker menu');
}

async function cleanup() {
  try {
    if (playerPage && !playerPage.isClosed()) await playerPage.close();
  } catch { /* best-effort */ }
  await page.evaluate(async () => {
    await game.settings.set('only-war-ai', 'executionMode', 'preview');
    await game.settings.set('only-war-ai', 'previewTimeoutSeconds', 0);
  }).catch(() => {});
  await h.closeAllWindows(page);
  if (combatId) await h.deleteCombat(page, combatId);
  if (sceneId) await h.deleteScene(page, sceneId);
  if (npcId) await h.deleteActor(page, npcId);
  if (enemyId) await h.deleteActor(page, enemyId);
  if (playerUserId) {
    await page.evaluate(async (id) => {
      const user = game.users.get(id);
      if (user && !user.isGM) await user.delete();
    }, playerUserId).catch(() => {});
  }
}

(async () => {
  try {
    await setup();
    await testPlayerSeesNoPreview();
    await testPlayerCannotDrive();
    console.log('player-view.test.mjs PASSED');
    process.exit(0);
  } catch (err) {
    console.error('player-view.test.mjs FAILED:', err);
    try { await h.screenshot(page, 'player-view-failure'); } catch { /* ignore */ }
    process.exit(1);
  } finally {
    await cleanup().catch(() => {});
    // CDP: browser.close() would tear down the shared context — the connection ends with the process.
  }
})();
