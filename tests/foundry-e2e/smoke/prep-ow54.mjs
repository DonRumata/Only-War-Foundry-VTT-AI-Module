import { chromium } from 'playwright-core';
import * as h from '../lib.mjs';

/**
 * Smoke-plan "Подготовка мира" additions for the integration/ai-stack run:
 * - world settings per .smoke-plan.md;
 * - Alpha Trooper 3 gets a spray weapon (OW54-2);
 * - Spec Operative 2 gets a blast weapon (OW54-3);
 * - combatant-level fireteam flags on the alpha team (SQ cases).
 * Run after smoke/setup-smoke.mjs.
 */

const browser = await chromium.connectOverCDP(h.CDP_URL);
const page = await h.getGmPage(browser);
await h.ensureJoinedGame(page);
console.log('GM page connected as', await page.evaluate(() => game.user.name));

const settings = await page.evaluate(async () => {
    const pairs = [
        ['masterEnabled', true],
        ['executionMode', 'preview'],
        ['diagnosticsEnabled', true],
        ['aiBarks', true],
        ['barksToPlayers', false],
        ['aiCaptureContext', true],
        ['aiTraceVerbose', 'compact'],
        ['previewTimeoutSeconds', 0],
        ['turnPacingMs', 800],
        ['manualOverrideGrace', false],
        ['moraleDesperateRatio', 2],
        ['aiDifficulty', 'normal'],
        ['attackAdjudication', 'auto']
    ];
    const out = {};
    for (const [key, value] of pairs) {
        try {
            await game.settings.set('only-war-ai', key, value);
            out[key] = game.settings.get('only-war-ai', key);
        } catch (e) {
            out[key] = `ERR ${e.message}`;
        }
    }
    return out;
});
console.log('settings:', JSON.stringify(settings));

const gear = await page.evaluate(async () => {
    const out = {};
    const alpha3 = game.actors.find((a) => a.name === 'Alpha Trooper 3');
    if (alpha3 && !alpha3.items.find((i) => i.name === 'Flamer')) {
        const [flamer] = await alpha3.createEmbeddedDocuments('Item', [{
            name: 'Flamer', type: 'weapon',
            system: {
                class: 'basic', range: 8, damage: '1d10+4', pen: 2,
                clip: { value: 3, max: 3 },
                rateOfFire: { single: 1, burst: 0, full: 0 },
                traits: { spray: true, flame: true }
            }
        }]);
        out.flamer = flamer.id;
    } else {
        out.flamer = alpha3 ? 'already present' : 'NO Alpha Trooper 3';
    }
    const spec2 = game.actors.find((a) => a.name === 'Spec Operative 2');
    if (spec2 && !spec2.items.find((i) => i.name === 'Frag Grenade')) {
        const [grenade] = await spec2.createEmbeddedDocuments('Item', [{
            name: 'Frag Grenade', type: 'weapon',
            system: {
                class: 'basic', range: 10, damage: '2d10', pen: 0,
                blastRadius: 3,
                rateOfFire: { single: 1, burst: 0, full: 0 },
                traits: { blast: 3 }
            }
        }]);
        out.grenade = grenade.id;
    } else {
        out.grenade = spec2 ? 'already present' : 'NO Spec Operative 2';
    }
    return out;
});
console.log('gear:', JSON.stringify(gear));

// Combatant-level fireteam flags for the alpha team (SQ cases per plan).
const fireteam = await page.evaluate(async () => {
    const combat = game.combats.find((c) => c.name === 'Smoke Combat') ?? game.combat;
    if (!combat) return 'no combat';
    const alpha = combat.combatants.filter((c) => (c.name ?? '').startsWith('Alpha'));
    const leader = alpha.find((c) => c.name === 'Alpha Trooper 1') ?? alpha[0];
    if (!leader) return 'no alpha combatants';
    for (const c of alpha) {
        await c.setFlag('only-war-ai', 'fireteam', {
            teamId: 'alpha-smoke',
            leaderId: leader.id,
            teamPreset: 'assault',
            preferredCohesion: 5,
            character: 'shock'
        });
    }
    return alpha.map((c) => c.name);
});
console.log('combatant fireteam flags:', JSON.stringify(fireteam));
console.log('DONE');
process.exit(0);
