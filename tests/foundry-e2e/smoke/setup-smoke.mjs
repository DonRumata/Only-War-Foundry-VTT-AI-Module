import { chromium } from 'playwright-core';
import * as h from '../lib.mjs';

/**
 * Provisions the "Smoke Arena" world state for the manual AI smoke
 * scenario (docs in smoke/README.md):
 * - 3 Player users + 3 acolyte characters with OWNER permission;
 * - bot teams: alpha (assault, melee/ranged hybrids), beta (rangedCover),
 *   spec (specOps pair), solo hold NPC вЂ” AI config + fireteam flags;
 * - a square-grid arena: open field, central building with door, cover
 *   walls and a flank route;
 * - a staged combat with every token on the scene.
 *
 * Idempotent-ish: existing documents with the same names are reused
 * (users) or deleted and recreated (scene/actors/combat leftovers).
 * Run: node smoke/setup-smoke.mjs
 */

const NAMES = {
    scene: 'Smoke Arena',
    combat: 'Smoke Combat',
    players: ['Smoke Player 1', 'Smoke Player 2', 'Smoke Player 3'],
    pcs: ['Acolyte One', 'Acolyte Two', 'Acolyte Three']
};

const BOTS = [
    // Assault team вЂ” hybrid loadout so melee-vs-ranged selection shows.
    // Issue #19: `shock` team character + an explicit `fanatic` leader —
    // the alpha wedge should visibly over-extend toward contact.
    ...[1, 2, 3, 4].map(i => ({
        name: `Alpha Trooper ${i}`, preset: 'assault',
        team: 'alpha-smoke', leader: i === 1, cohesion: 5, character: 'shock',
        personality: i === 1 ? ['fanatic'] : null,
        // Issue #35: trooper 4 is a melee-only berserker staged in contact
        // with Acolyte One — guaranteed live melee/charge turns.
        weapons: i === 4
            ? [{ name: 'Chainsword', class: 'melee', damage: '1d10+4' }]
            : [
                { name: 'Lasgun', class: 'basic', range: 30, damage: '1d10+3', clip: { value: 30, max: 30 }, rateOfFire: { single: 1, burst: 3, full: 0 } },
                { name: 'Chainsword', class: 'melee', damage: '1d10+4' }
            ]
    })),
    // Ranged-cover team вЂ” keeps distance behind cover. `disciplined`
    // character + a `cowardly` rifleman: the team holds formation while
    // the coward drifts back from the front line.
    ...[1, 2, 3].map(i => ({
        name: `Beta Rifleman ${i}`, preset: 'rangedCover',
        team: 'beta-smoke', leader: i === 1, cohesion: 6, character: 'disciplined',
        personality: i === 1 ? ['cowardly'] : null,
        weapons: [
            { name: 'Lasgun', class: 'basic', range: 30, damage: '1d10+3', clip: { value: 30, max: 30 }, rateOfFire: { single: 1, burst: 3, full: 0 } }
        ]
    })),
    // Spec-ops pair for coordinated tactics — `elite` character,
    // `flanker` on the lead operative.
    ...[1, 2].map(i => ({
        name: `Spec Operative ${i}`, preset: 'specOps',
        team: 'spec-smoke', leader: i === 1, cohesion: 4, character: 'elite',
        personality: i === 1 ? ['flanker'] : null,
        weapons: [
            { name: 'Lasgun', class: 'basic', range: 30, damage: '1d10+3', clip: { value: 30, max: 30 }, rateOfFire: { single: 1, burst: 3, full: 0 } },
            { name: 'Combat Knife', class: 'melee', damage: '1d5+2' }
        ]
    })),
    // Solo hold-position NPC in the building — `sentinel` keeps him home.
    {
        name: 'Hold Gunner', preset: 'hold', team: null,
        personality: ['sentinel'],
        weapons: [
            { name: 'Lasgun', class: 'basic', range: 30, damage: '1d10+3', clip: { value: 30, max: 30 }, rateOfFire: { single: 1, burst: 3, full: 0 } }
        ]
    },
    // Grenade+door scenario (#66): sealed inside the central building.
    // His only intel is the comms net — relayed contacts pull him toward
    // the fight, but the closed door blocks his path until the driver
    // opens it; then he must navigate out and throw the frag (grenade
    // range is deliberately shorter than the spawn distances so he has
    // to move first).
    {
        name: 'Frag Grenadier', preset: 'rangedCover', team: null,
        personality: ['grenadier'],
        weapons: [
            // `special: "Blast (3)"` is the canonical OW blast field — the
            // system reads traits out of this string (`system.blastRadius`
            // stays empty on compendium items too).
            { name: 'Frag Grenade', class: 'thrown', range: 18, damage: '2d10',
                blastRadius: 3, special: 'Blast (3)', clip: { value: 5, max: 5 },
                rateOfFire: { single: 1, burst: 0, full: 0 } }
        ]
    }
];

const browser = await chromium.connectOverCDP(h.CDP_URL);
const page = await h.getGmPage(browser);
await h.ensureJoinedGame(page);
console.log('GM page connected as', await page.evaluate(() => game.user.name));

// --- Users + player characters -------------------------------------------

const userIds = await page.evaluate(async (names) => {
    const out = {};
    for (const name of names) {
        let user = game.users.find((u) => u.name === name);
        if (!user) user = await User.create({ name, role: CONST.USER_ROLES.PLAYER });
        else if (user.role !== CONST.USER_ROLES.PLAYER) {
            await user.update({ role: CONST.USER_ROLES.PLAYER });
        }
        out[name] = user.id;
    }
    return out;
}, NAMES.players);
console.log('users:', JSON.stringify(userIds));

// Old smoke actors are removed for a clean run.
await page.evaluate(async (data) => {
    for (const actor of game.actors.contents) {
        if (data.names.includes(actor.name)) await actor.delete();
    }
}, { names: [...NAMES.pcs, ...BOTS.map(b => b.name)] });

const pcIds = await page.evaluate(async (data) => {
    const out = {};
    for (let i = 0; i < data.names.length; i++) {
        const actor = await Actor.create({
            name: data.names[i],
            type: 'acolyte',
            system: {
                characteristics: {
                    agility: { base: 35 }, weaponSkill: { base: 35 },
                    ballisticSkill: { base: 35 }, toughness: { base: 35 },
                    strength: { base: 35 }, willpower: { base: 30 }
                },
                wounds: { max: 10, value: 0 },
                fate: { max: 2, value: 2 }
            },
            ownership: { [data.userIds[i]]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER }
        });
        await actor.createEmbeddedDocuments('Item', [
            { name: 'Lasgun', type: 'weapon',
                system: { class: 'basic', range: 30, damage: '1d10+3',
                    clip: { value: 30, max: 30 }, rateOfFire: { single: 1, burst: 3, full: 0 } } }
        ]);
        // Issue #35: the fire dialog requires an ammo source — give the
        // lasgun a loaded magazine plus one spare.
        const lasgun = actor.items.find((i) => i.name === 'Lasgun');
        const [loadedMag] = await actor.createEmbeddedDocuments('Item', [
            { name: 'Lasgun Magazine', type: 'magazine',
                system: { ammoType: 'laser', clip: { value: 30, max: 30 }, weapon: 'Lasgun' } },
            { name: 'Lasgun Magazine (spare)', type: 'magazine',
                system: { ammoType: 'laser', clip: { value: 30, max: 30 }, weapon: 'Lasgun' } }
        ]);
        await lasgun.update({ 'system.magazine': loadedMag.id });
        out[actor.name] = actor.id;
    }
    return out;
}, { names: NAMES.pcs, userIds: Object.values(userIds) });
console.log('player characters:', JSON.stringify(pcIds));

// --- Bot actors -----------------------------------------------------------

const botIds = await page.evaluate(async (data) => {
    const out = {};
    for (const spec of data) {
        const actor = await Actor.create({
            name: spec.name, type: 'npc',
            system: {
                characteristics: {
                    agility: { base: 40 }, weaponSkill: { base: 35 },
                    ballisticSkill: { base: 40 }, toughness: { base: 40 },
                    strength: { base: 35 }, willpower: { base: 30 }
                },
                wounds: { max: 12, value: 0 }
            }
        });
        const created = await actor.createEmbeddedDocuments('Item',
            spec.weapons.map((w) => ({ name: w.name, type: 'weapon', system: w })));
        // Issue #35: ranged weapons get a loaded + a spare magazine so the
        // bot can both fire through the system API and demo the reload
        // action when the clip runs dry.
        for (let w = 0; w < spec.weapons.length; w++) {
            const wspec = spec.weapons[w];
            if (wspec.class === 'melee' || !(wspec.clip?.max > 0)) continue;
            const [loadedMag] = await actor.createEmbeddedDocuments('Item', [
                { name: `${wspec.name} Magazine`, type: 'magazine',
                    system: { ammoType: 'laser', clip: { ...wspec.clip }, weapon: wspec.name } },
                { name: `${wspec.name} Magazine (spare)`, type: 'magazine',
                    system: { ammoType: 'laser', clip: { ...wspec.clip }, weapon: wspec.name } }
            ]);
            await created[w].update({ 'system.magazine': loadedMag.id });
        }
        await actor.setFlag('only-war-ai', 'config', { enabled: true, preset: spec.preset });
        // Bots share one comms net — relayed sightings reach the distant
        // squads with a one-round radio delay. `comms:false` marks a bot
        // deliberately off the net (the sealed grenadier keeps zero intel
        // until its door opens).
        if (spec.comms !== false) {
            await actor.setFlag('only-war-ai', 'commsNet', 'defense');
        }
        if (spec.personality) {
            await actor.setFlag('only-war-ai', 'personality', spec.personality);
        }
        if (spec.team) {
            await actor.setFlag('only-war-ai', 'fireteam', {
                teamId: spec.team,
                leaderId: spec.leader ? spec.name : null,
                teamPreset: spec.preset,
                preferredCohesion: spec.cohesion,
                character: spec.character ?? null
            });
        }
        out[spec.name] = actor.id;
    }
    return out;
}, BOTS);
console.log('bots:', Object.keys(botIds).length);

// --- Scene ----------------------------------------------------------------
// Players deploy along the west edge, bots hold the east half behind
// cover. A walled building with a door sits center; scattered cover
// rectangles break LOS; the south corridor allows flanking.

const sceneId = await page.evaluate(async (data) => {
    const old = game.scenes.find((s) => s.name === data.scene);
    if (old) await old.delete();
    const scene = await Scene.create({
        name: data.scene,
        active: true,
        width: 4000,
        height: 3000,
        grid: { size: 100, type: 1, distance: 1, units: 'm' },
        padding: 0.25
    });
    await scene.activate();
    const walls = [
        // Central building (300x400) with a door on the south wall.
        { c: [2000, 1200, 2000, 1600], move: 20, sight: 20, door: 0 },
        { c: [2000, 1200, 2300, 1200], move: 20, sight: 20, door: 0 },
        { c: [2300, 1200, 2300, 1600], move: 20, sight: 20, door: 0 },
        { c: [2000, 1600, 2050, 1600], move: 20, sight: 20, door: 0 },
        { c: [2250, 1600, 2300, 1600], move: 20, sight: 20, door: 0 },
        // Door on the south wall: 2 cells wide so a full-footprint token
        // (±0.45 corner probes) can actually pass the open leaf.
        { c: [2050, 1600, 2250, 1600], move: 20, sight: 20, door: 1, ds: 0 },
        // Cover rectangles west of the building.
        { c: [1500, 800, 1500, 1100], move: 20, sight: 20, door: 0 },
        { c: [1500, 1100, 1700, 1100], move: 20, sight: 20, door: 0 },
        { c: [1600, 1900, 1600, 2200], move: 20, sight: 20, door: 0 },
        { c: [1400, 1900, 1600, 1900], move: 20, sight: 20, door: 0 },
        // Cover east of the building for the hold NPC's fire lanes.
        { c: [2700, 900, 2900, 900], move: 20, sight: 20, door: 0 },
        { c: [2900, 900, 2900, 1200], move: 20, sight: 20, door: 0 },
        { c: [2700, 2000, 3000, 2000], move: 20, sight: 20, door: 0 },
        // South flank corridor walls.
        { c: [1000, 2600, 3400, 2600], move: 20, sight: 20, door: 0 },
        { c: [3400, 2600, 3400, 3000], move: 20, sight: 20, door: 0 }
    ];
    await scene.createEmbeddedDocuments('Wall', walls);
    return scene.id;
}, NAMES);
console.log('scene:', sceneId);
await page.waitForTimeout(1500);

// --- Tokens ---------------------------------------------------------------

const layout = [
    // Players: west edge, spread vertically.
    { actor: 'Acolyte One', x: 300, y: 900, disp: 1 },
    { actor: 'Acolyte Two', x: 300, y: 1400, disp: 1 },
    // Grenade bait: staged far south-west — the south wall cuts the
    // grenadier's inside LOS and the doorway exit cell is the closest
    // legal position to her, so the greedy approach scorer must walk
    // him out through the open door before the frag can reach.
    { actor: 'Acolyte Three', x: 1500, y: 2350, disp: 1 },
    // Alpha assault team: east, loose wedge behind the ridge cover.
    { actor: 'Alpha Trooper 1', x: 2800, y: 1200, disp: -1 },
    { actor: 'Alpha Trooper 2', x: 2900, y: 1400, disp: -1 },
    { actor: 'Alpha Trooper 3', x: 3000, y: 1100, disp: -1 },
    // Issue #35: staged in melee contact with Acolyte One.
    { actor: 'Alpha Trooper 4', x: 400, y: 900, disp: -1 },
    // Beta ranged-cover team: behind the south cover line.
    { actor: 'Beta Rifleman 1', x: 2800, y: 2100, disp: -1 },
    { actor: 'Beta Rifleman 2', x: 3200, y: 400, disp: -1 },
    { actor: 'Beta Rifleman 3', x: 3050, y: 2150, disp: -1 },
    // Spec pair: south corridor mouth, ready to flank.
    { actor: 'Spec Operative 1', x: 3300, y: 2700, disp: -1 },
    { actor: 'Spec Operative 2', x: 3450, y: 2750, disp: -1 },
    // Hold gunner inside the building.
    { actor: 'Hold Gunner', x: 2100, y: 1350, disp: -1 },
    // Grenadier sealed in the same building — the west wall cuts his
    // inside LOS to the bait, so the only firing position leads through
    // the doorway.
    { actor: 'Frag Grenadier', x: 2050, y: 1300, disp: -1 }
];

const tokenIds = await page.evaluate(async (data) => {
    const scene = game.scenes.get(data.sceneId);
    const docs = data.layout.map((t) => ({
        actorId: data.actors[t.actor],
        x: t.x, y: t.y, width: 1, height: 1,
        name: t.actor, disposition: t.disp,
        // Basic sight so core visibility APIs treat the token as a real
        // viewer; the AI's own LOS math is geometric and doesn't need it.
        sight: { enabled: true, range: 30, angle: 360, visionMode: 'basic' }
    }));
    const created = await scene.createEmbeddedDocuments('Token', docs);
    // Mirror the fireteam flag onto the token document so the token config
    // UI shows the team exactly like a GM-set token override would.
    for (const spec of data.bots) {
        if (!spec.team) continue;
        const token = created.find((t) => t.name === spec.name);
        await token.setFlag('only-war-ai', 'fireteam', {
            teamId: spec.team,
            leaderId: spec.leader ? spec.name : null,
            teamPreset: spec.preset,
            preferredCohesion: spec.cohesion,
            character: spec.character ?? null
        });
    }
    return Object.fromEntries(created.map((t) => [t.name, t.id]));
}, { sceneId, layout, actors: { ...pcIds, ...botIds }, bots: BOTS });
console.log('tokens:', Object.keys(tokenIds).length);

// --- Staged combat ---------------------------------------------------------

const order = await page.evaluate(async (data) => {
    const old = game.combats.find((c) => c.name === data.combat);
    if (old) await old.delete();
    const combat = await Combat.create({ name: data.combat, scene: data.sceneId });
    await combat.createEmbeddedDocuments('Combatant',
        Object.values(data.tokenIds).map((tokenId) => ({ tokenId })));
    // Issue #34: the smoke runs by rolled initiative like a real fight —
    // no unrolled combatants drifting at the top of the tracker.
    await combat.rollAll();
    return combat.turns.map((c) => ({ name: c.name ?? c.token?.name, initiative: c.initiative }));
}, { ...NAMES, sceneId, tokenIds });
console.log('initiative order:', JSON.stringify(order));
console.log('combat staged вЂ” GM hits "Begin Combat" to start');
console.log('DONE');
process.exit(0);
