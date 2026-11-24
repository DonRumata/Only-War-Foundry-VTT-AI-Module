import { chromium } from 'playwright-core';
import * as h from '../lib.mjs';

const browser = await chromium.connectOverCDP(h.CDP_URL);
const page = await h.getGmPage(browser);
await h.ensureJoinedGame(page);

const r = await page.evaluate(async () => {
    const api = game.modules.get('only-war-ai').api;
    const combat = game.combats.find((c) => c.scene?.name === 'Smoke Arena' && c.combatants.size >= 10);
    if (!combat) return { error: 'smoke combat not found' };
    const stale = game.combats.filter((c) => c.id !== combat.id);
    for (const c of stale) await c.delete();
    const rows = combat.combatants.map((c) => {
        const cfg = api.config.resolveEffectiveConfig(c);
        const team = api.services.get('fireteam').resolveTeamConfig?.(c)
            ?? c.getFlag('only-war-ai', 'fireteam') ?? null;
        return { name: c.name ?? c.token?.name, initiative: c.initiative,
            enabled: cfg?.enabled, preset: cfg?.preset,
            team: team?.teamId ?? null, leader: team?.leaderId ?? null };
    });
    return {
        deletedStaleCombats: stale.size,
        combatants: combat.combatants.size,
        walls: combat.scene.walls.contents.length,
        players: game.users.filter((u) => u.name.startsWith('Smoke')).map((u) => u.name),
        bots: rows.filter((row) => row.enabled === true)
    };
});
console.log(JSON.stringify(r, null, 1));
process.exit(0);
