import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CDP_URL = process.env.CDP_URL || 'http://localhost:9222';
export const FOUNDRY_URL = process.env.FOUNDRY_URL || 'http://localhost:30000';
export const SCREENSHOT_DIR = path.resolve(process.env.SCREENSHOT_DIR || path.join(__dirname, 'screenshots'));

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

export async function getPage(browser) {
  const context = browser.contexts()[0] || await browser.newContext();
  const pages = context.pages();
  // A stale player tab can outrank `pages()[0]` after multi-client tests —
  // prefer the page joined as a GM when one is already in the world.
  for (const candidate of pages) {
    try {
      const isGM = await candidate.evaluate(() => globalThis.game?.user?.isGM === true);
      if (isGM) return candidate;
    } catch { /* tab without a game session */ }
  }
  return pages[0] || await context.newPage();
}

export async function getGmPage(browser) {
  const context = browser.contexts()[0] || await browser.newContext();
  // A stale player tab may outrank `pages()[0]` — pick the GM client.
  for (const candidate of context.pages()) {
    try {
      const isGM = await candidate.evaluate(() => globalThis.game?.user?.isGM === true);
      if (isGM) return candidate;
    } catch { /* tab without a game session */ }
  }
  return getPage(browser);
}

export async function ensureJoinedGame(page, { preferGM = true } = {}) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.setExtraHTTPHeaders({
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache'
  });
  const url = page.url();

  if (url.includes('/game')) {
    if (process.env.FOUNDRY_RELOAD) {
      await page.evaluate(() => window.location.reload(true));
      await page.waitForLoadState('load');
    }
    await page.waitForFunction(
      () => typeof game !== 'undefined' && game?.ready && game?.user,
      { timeout: 30000 }).catch(() => {});
    // The browser profile auto-joins the last-used user — a stale player
    // session must be logged out before joining as GM.
    const isGM = await page.evaluate(() => globalThis.game?.user?.isGM === true)
        .catch(() => false);
    if (!preferGM || isGM) {
      await page.waitForTimeout(500);
      return;
    }
    try {
      await Promise.all([
        page.waitForURL(`${FOUNDRY_URL}/join`, { timeout: 15000 }),
        page.evaluate(() => game.logOut())
      ]);
    } catch {
      await page.goto(`${FOUNDRY_URL}/join`, { waitUntil: 'load' });
    }
  } else {
    await page.goto(`${FOUNDRY_URL}/game`, { waitUntil: 'load' });
  }

  if (page.url().includes('/game')) {
    await page.waitForFunction(() => typeof game !== 'undefined' && game?.ready && game?.user, { timeout: 30000 });
    await page.waitForTimeout(1000);
    return;
  }

  await page.goto(`${FOUNDRY_URL}/join`, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const options = Array.from(document.querySelectorAll('select[name="userid"] option'));
    return options.some((o) => o.value);
  }, { timeout: 10000 });
  const userId = await page.evaluate(() => {
    const options = Array.from(document.querySelectorAll('select[name="userid"] option'))
        .filter((o) => o.value);
    // Prefer a GM-looking user — a fresh page must never join as an
    // E2E player account left over from multi-client tests.
    const gm = options.find((o) => /gamemaster|\bgm\b/i.test(o.textContent ?? ''));
    return (gm ?? options[0])?.value ?? null;
  });
  if (!userId) throw new Error('No selectable user on /join page');
  await page.locator('select[name="userid"]').selectOption(userId, { force: true });
  const passwordInput = await page.$('input[name="password"]');
  if (passwordInput) await passwordInput.fill('');
  await Promise.all([
    page.waitForURL(`${FOUNDRY_URL}/game`, { waitUntil: 'load' }),
    page.click('button[name="join"]')
  ]);
  await page.waitForFunction(() => typeof game !== 'undefined' && game?.ready && game?.user, { timeout: 30000 });
  await page.waitForTimeout(500);
}

export async function createTestActor(page, type, name, setupFn) {
  return page.evaluate(async (data) => {
    const actor = await Actor.create({ name: data.name, type: data.type });
    if (data.setupSource) {
      const setup = new Function('actor', `return (${data.setupSource})(actor)`);
      await setup(actor);
    }
    return actor.id;
  }, { type, name, setupSource: setupFn ? setupFn.toString() : null });
}

export async function deleteActor(page, actorId) {
  try {
    await page.evaluate(async (id) => {
      const actor = game.actors.get(id);
      if (actor) await actor.delete();
    }, actorId);
  } catch {
    // Best-effort cleanup
  }
}

export async function closeAllWindows(page) {
  await page.evaluate(async () => {
    const apps = new Set([
      ...Object.values(ui.windows || {}),
      ...Array.from(foundry.applications?.instances?.values() || [])
    ]);
    await Promise.all(Array.from(apps).map((a) => {
      try { return a.close(); } catch { return Promise.resolve(); }
    }));
  });
  await page.waitForTimeout(300);
}

export async function openActorSheet(page, actorId) {
  await closeAllWindows(page);
  await page.evaluate((id) => { game.actors.get(id).sheet.render(true); }, actorId);
  await page.waitForTimeout(800);
}

export async function createTestScene(page, { grid = 1, size = 100 } = {}) {
  const sceneId = await page.evaluate(async (data) => {
    const scene = await Scene.create({
      name: `E2E Scene ${Date.now()}`,
      active: true,
      width: 2000,
      height: 2000,
      grid: { size: data.size, type: data.grid }
    });
    if (canvas.scene?.id !== scene.id) await scene.activate();
    return scene.id;
  }, { grid, size });
  // Scene activation re-draws the canvas asynchronously; dependent-token
  // updates (actor flags) crash while RenderFlags queues are unavailable.
  await page.waitForFunction((sid) =>
    canvas.scene?.id === sid && !!canvas.pendingRenderFlags && !!canvas.tokens,
    sceneId, { timeout: 15000 });
  await page.waitForTimeout(300);
  return sceneId;
}

export async function deleteScene(page, sceneId) {
  try {
    await page.evaluate(async (id) => {
      const scene = game.scenes.get(id);
      if (scene) await scene.delete();
    }, sceneId);
  } catch {
    // Best-effort cleanup
  }
}

export async function placeToken(page, sceneId, actorId, { x = 500, y = 500 } = {}) {
  return page.evaluate(async (data) => {
    const scene = game.scenes.get(data.sceneId);
    const actor = game.actors.get(data.actorId);
    const proto = actor.prototypeToken.toObject();
    delete proto._id;
    const [token] = await scene.createEmbeddedDocuments('Token', [
      { ...proto, actorId: actor.id, x: data.x, y: data.y, actorLink: true }
    ]);
    return token.id;
  }, { sceneId, actorId, x, y });
}

export async function createCombat(page, tokenIds) {
  return page.evaluate(async (ids) => {
    const combat = await Combat.create({ scene: canvas.scene?.id ?? null });
    await combat.createEmbeddedDocuments('Combatant', ids.map((tokenId) => ({ tokenId })));
    await combat.activate();
    // v13: game.combat resolves to the tracker's viewed combat, not the
    // active one — pin the created encounter so tests see it via game.combat.
    try { if (ui.combat) ui.combat.viewed = combat; } catch { /* headless */ }
    return combat.id;
  }, tokenIds);
}

export async function deleteCombat(page, combatId) {
  try {
    await page.evaluate(async (id) => {
      const combat = game.combats.get(id);
      if (combat) await combat.delete();
    }, combatId);
  } catch {
    // Best-effort cleanup
  }
}

export async function setActorAiConfig(page, actorId, config) {
  return page.evaluate(async (data) => {
    const actor = game.actors.get(data.actorId);
    await actor.setFlag('only-war-ai', 'config', data.config);
    return actor.getFlag('only-war-ai', 'config');
  }, { actorId, config });
}

export async function setOverride(page, { kind, id, override }) {
  return page.evaluate(async (data) => {
    let doc = null;
    if (data.kind === 'combatant') {
      doc = game.combat?.combatants?.get(data.id);
    } else if (data.kind === 'token') {
      doc = canvas.scene?.tokens?.get(data.id);
    }
    if (!doc) return null;
    await doc.setFlag('only-war-ai', 'override', data.override);
    return doc.getFlag('only-war-ai', 'override');
  }, { kind, id, override });
}

export async function resolveAiConfig(page, ref) {
  return page.evaluate((data) => {
    const api = game.modules.get('only-war-ai')?.api;
    let doc = null;
    if (data.kind === 'actor') doc = game.actors.get(data.id);
    if (data.kind === 'token') doc = canvas.scene?.tokens?.get(data.id);
    if (data.kind === 'combatant') doc = game.combat?.combatants?.get(data.id);
    return api?.config?.resolveEffectiveConfig?.(doc) ?? null;
  }, ref);
}

export async function getLocalized(page, key) {
  return page.evaluate((k) => game.i18n.localize(k), key);
}

export async function getLastChatHtml(page) {
  return page.evaluate(() => {
    const msg = game.messages.contents.slice(-1)[0];
    return msg ? msg.content : '';
  });
}

export async function screenshot(page, name) {
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`) });
}
