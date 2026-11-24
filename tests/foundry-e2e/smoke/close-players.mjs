import { chromium } from 'playwright-core';
import * as h from '../lib.mjs';

/** Closes all tabs joined as Smoke Player users. */
const PLAYERS = ['Smoke Player 1', 'Smoke Player 2', 'Smoke Player 3', 'AI E2E Player'];

const browser = await chromium.connectOverCDP(h.CDP_URL);
for (const p of browser.contexts()[0].pages()) {
    try {
        const user = await p.evaluate(() => globalThis.game?.user?.name);
        if (PLAYERS.includes(user)) { await p.close(); console.log('closed', user); }
    } catch { /* not a game tab */ }
}
process.exit(0);
