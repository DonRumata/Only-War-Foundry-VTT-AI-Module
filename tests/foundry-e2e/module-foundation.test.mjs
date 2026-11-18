import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import * as h from './lib.mjs';

const names = {
  npc: 'AI Foundation NPC'
};

let page;
let browser;
let npcId;
let sceneId;
let tokenId;
let combatId;
let combatantId;

async function setup() {
  browser = await chromium.connectOverCDP(h.CDP_URL);
  page = await h.getPage(browser);
  await h.ensureJoinedGame(page);

  console.log('Connected to Foundry game session');

  npcId = await h.createTestActor(page, 'npc', names.npc);
  sceneId = await h.createTestScene(page);
  tokenId = await h.placeToken(page, sceneId, npcId);
}

async function testModuleLoadedAndApiPresent() {
  const info = await page.evaluate(() => {
    const mod = game.modules.get('only-war-ai');
    return {
      active: mod?.active === true,
      hasApi: !!mod?.api,
      version: mod?.api?.version ?? null,
      enabled: mod?.api?.enabled ?? null,
      incompatibleReason: mod?.api?.incompatibleReason ?? null,
      capabilities: mod?.api?.capabilities ?? null,
      presets: mod?.api?.presets ?? null,
      hasResolver: typeof mod?.api?.config?.resolveEffectiveConfig === 'function',
      hasServices: typeof mod?.api?.services?.register === 'function',
      systemId: game.system?.id ?? null,
      systemApiVersion: game.darkHeresy?.api?.version ?? null
    };
  });

  assert.equal(info.active, true, 'module should be active');
  assert.equal(info.hasApi, true, 'module api should be published');
  assert.equal(info.version, '1.0', 'module api version');
  assert.equal(info.systemId, 'only-war-local', 'host system id');
  assert.equal(info.hasResolver, true, 'resolver exposed');
  assert.equal(info.hasServices, true, 'service registry exposed');
  assert.deepEqual(info.presets, ['assault', 'rangedCover', 'hold', 'specOps']);
  assert.ok(info.capabilities['config.resolveEffectiveConfig'], 'resolver capability');

  // If the running system already ships the public API (PR #440), the module
  // must be enabled; otherwise it must report a stable disabled reason.
  if (info.systemApiVersion) {
    assert.equal(info.enabled, true, 'module should be enabled with a compatible system api');
    assert.equal(info.incompatibleReason, null);
  } else {
    assert.equal(info.enabled, false, 'module should stay disabled without system api');
    assert.equal(info.incompatibleReason, 'api-missing');
  }
}

async function testWorldSettings() {
  const settings = await page.evaluate(() => ({
    executionMode: game.settings.get('only-war-ai', 'executionMode'),
    diagnosticsEnabled: game.settings.get('only-war-ai', 'diagnosticsEnabled')
  }));
  assert.ok(['automatic', 'preview'].includes(settings.executionMode), 'executionMode registered');
  assert.equal(typeof settings.diagnosticsEnabled, 'boolean', 'diagnosticsEnabled registered');
}

async function testActorFlagsRoundTrip() {
  const config = { enabled: true, preset: 'assault' };
  const stored = await h.setActorAiConfig(page, npcId, config);
  assert.deepEqual(stored, config, 'actor config flag round-trips');

  const resolved = await h.resolveAiConfig(page, { kind: 'actor', id: npcId });
  assert.deepEqual(resolved, { enabled: true, preset: 'assault', source: 'actor' });
}

async function testTokenOverride() {
  const stored = await h.setOverride(page, {
    kind: 'token', id: tokenId, override: { mode: 'enabled', preset: 'specOps' }
  });
  assert.deepEqual(stored, { mode: 'enabled', preset: 'specOps' });

  const resolved = await h.resolveAiConfig(page, { kind: 'token', id: tokenId });
  assert.deepEqual(resolved, { enabled: true, preset: 'specOps', source: 'token' });

  await h.setOverride(page, { kind: 'token', id: tokenId, override: { mode: 'inherit', preset: null } });
}

async function testCombatantOverride() {
  combatId = await h.createCombat(page, [tokenId]);
  combatantId = await page.evaluate((tid) =>
    game.combat?.combatants?.find((c) => c.tokenId === tid)?.id ?? null, tokenId);
  assert.ok(combatantId, 'combatant created for the npc token');

  await h.setOverride(page, {
    kind: 'combatant', id: combatantId, override: { mode: 'disabled', preset: null }
  });
  const resolved = await h.resolveAiConfig(page, { kind: 'combatant', id: combatantId });
  assert.deepEqual(resolved, { enabled: false, preset: null, source: 'combatant' },
    'combatant override wins over token and actor');
}

async function testNpcSheetSection() {
  // Sheet injection is gated on `api.enabled`; without a compatible system api
  // the section must not render.
  const apiEnabled = await page.evaluate(() => game.modules.get('only-war-ai')?.api?.enabled === true);
  await h.openActorSheet(page, npcId);
  const hasSection = await page.evaluate(() =>
    !!document.querySelector('[data-ow-ai-config]'));
  if (apiEnabled) {
    assert.equal(hasSection, true, 'NPC sheet should contain the Only War AI section');
  } else {
    console.log('Skipping NPC sheet section assertion: module disabled (no system api)');
  }
}

async function cleanup() {
  await h.closeAllWindows(page);
  if (combatId) await h.deleteCombat(page, combatId);
  if (sceneId) await h.deleteScene(page, sceneId);
  if (npcId) await h.deleteActor(page, npcId);
}

(async () => {
  try {
    await setup();
    await testModuleLoadedAndApiPresent();
    await testWorldSettings();
    await testActorFlagsRoundTrip();
    await testTokenOverride();
    await testCombatantOverride();
    await testNpcSheetSection();
    console.log('module-foundation.test.mjs PASSED');
    process.exit(0);
  } catch (err) {
    console.error('module-foundation.test.mjs FAILED:', err);
    try { await h.screenshot(page, 'module-foundation-failure'); } catch { /* ignore */ }
    process.exit(1);
  } finally {
    await cleanup().catch(() => {});
  }
})();
