import { chromium } from 'playwright-core';
import * as h from '../lib.mjs';

/**
 * Opens one browser tab per Smoke Player user and joins the world as
 * that player. The GM keeps its existing tab; this script only adds
 * player views so the manual smoke run has real player clients.
 *
 * Run: node smoke/open-players.mjs
 * Close: node smoke/close-players.mjs (or just close the tabs).
 */

const PLAYERS = ['Smoke Player 1', 'Smoke Player 2', 'Smoke Player 3'];

const browser = await chromium.connectOverCDP(h.CDP_URL);
const context = browser.contexts()[0];

for (const name of PLAYERS) {
    const already = [];
    for (const p of context.pages()) {
        try {
            const user = await p.evaluate(() => globalThis.game?.user?.name);
            if (user === name) already.push(p);
        } catch { /* not a game tab */ }
    }
    if (already.length) { console.log(`${name}: tab already open`); continue; }

    const page = await context.newPage();
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`${h.FOUNDRY_URL}/join`, { waitUntil: 'load' });
    await page.waitForFunction((wanted) =>
        Array.from(document.querySelectorAll('select[name="userid"] option'))
            .some((o) => o.value && o.textContent === wanted),
        name, { timeout: 10000 });
    const userId = await page.evaluate((wanted) =>
        Array.from(document.querySelectorAll('select[name="userid"] option'))
            .find((o) => o.value && o.textContent === wanted)?.value ?? null,
        name);
    if (!userId) { console.log(`${name}: user missing — run setup-smoke.mjs first`); continue; }
    await page.locator('select[name="userid"]').selectOption(userId, { force: true });
    const pw = await page.$('input[name="password"]');
    if (pw) await pw.fill('');
    await Promise.all([
        page.waitForURL(`${h.FOUNDRY_URL}/game`, { waitUntil: 'load', timeout: 30000 }),
        page.click('button[name="join"]')
    ]);
    await page.waitForFunction(() => globalThis.game?.ready === true, { timeout: 30000 });
    console.log(`${name}: joined (gm=${await page.evaluate(() => game.user.isGM)})`);
}
process.exit(0);
