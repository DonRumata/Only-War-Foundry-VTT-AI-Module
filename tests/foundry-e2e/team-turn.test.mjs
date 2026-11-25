import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import * as h from './lib.mjs';

const browser = await chromium.connectOverCDP(h.CDP_URL);
const page = await h.getGmPage(browser);
const scriptRoot = '/modules/only-war-ai/scripts/';

try {
    await h.ensureJoinedGame(page);
    const report = await page.evaluate(async scriptRoot => {
        const imp = name => import(`${scriptRoot}${name}.js`);
        const [
            { createModuleApi }, { createAuthorityService }, { createExecutorService },
            { createFireteamService }, { createNavigationService }, { createOperationService },
            { createPerceptionService }, { createPlannerService }, { registerRangedCoverPreset },
            { buildPreviewViewModel, localizePreviewViewModel }
        ] = await Promise.all([
            'api', 'authority', 'executor', 'fireteam', 'navigation', 'operations',
            'perception', 'planner', 'presets/ranged-cover', 'ui/preview-dialog'
        ].map(imp));
        const check = (value, message) => { if (!value) throw new Error(message); };
        const waitFor = async (predicate, label) => {
            for (let i = 0; i < 200; i++) {
                if (predicate()) return;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            throw new Error(`Timed out: ${label}`);
        };
        check(game.user.isGM && game.system.id === 'only-war-local', 'Expected a GM in Only War');
        const initialScene = canvas.scene;
        const initialCombat = game.combat;
        const snapshot = () => [
            ['scene', JSON.stringify(initialScene?.toObject())],
            ['combats', JSON.stringify(game.combats.contents.map(combat => combat.toObject()))],
            ['tracker', game.combat?.id ?? null],
            ['worldTime', JSON.stringify(game.time.worldTime)]
        ];
        const before = snapshot();
        const cases = [];
        for (const [interrupt, detached] of [[false, false], [true, false], [false, true]]) {
            const cleanup = [];
            let authority;
            let combatHook;
            try {
                const actor = await Actor.create({ name: 'E2E TeamPlan', type: 'npc' });
                cleanup.push(actor);
                const scene = await Scene.create({
                    name: 'E2E TeamPlan', width: 1200, height: 900, padding: 0,
                    grid: { type: 1, size: 100, distance: 1 },
                    active: false, navigation: false, tokenVision: false
                });
                cleanup.push(scene);
                await scene.view();
                await waitFor(() => canvas.ready && canvas.scene?.id === scene.id, 'canvas');
                const tokens = await scene.createEmbeddedDocuments('Token', [
                    [600, 100, -1], [200, 300, -1], [800, 300, 1]
                ].map(([x, y, disposition]) => ({
                    actorId: actor.id, actorLink: false, width: 1, height: 1, x, y, disposition
                })));
                const [a, b, enemy] = [600, 200, 800].map(x => tokens.find(token => token._source.x === x));
                const combat = await Combat.create({ scene: scene.id, active: false });
                cleanup.push(combat);
                await combat.createEmbeddedDocuments('Combatant',
                    [a, b, enemy].map((token, i) => ({ tokenId: token.id, sceneId: scene.id, initiative: 20 - i })));
                const [lead, flank, other] = [a, b, enemy].map(token =>
                    combat.combatants.find(c => c.tokenId === token.id));
                for (const member of [lead, flank]) {
                    await member.setFlag('only-war-ai', 'fireteam', {
                        teamId: 'teamplan-e2e', leaderId: lead.id,
                        ...(detached ? { preferredCohesion: 2 } : {})
                    });
                }
                // Exercise Foundry's real nextTurn() without ticking timers in the user's world.
                combat.getTimeDelta = () => 0;
                const api = createModuleApi();
                const resolveConfig = doc => ({
                    enabled: doc?.id === lead.id || doc?.id === flank.id, preset: 'rangedCover'
                });
                const handlers = new Map();
                const hooks = {
                    on: (event, fn) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
                    off: (event, fn) => handlers.set(event, handlers.get(event)?.filter(cb => cb !== fn) ?? []),
                    callAll: (event, ...args) => {
                        for (const fn of handlers.get(event) ?? []) fn(...args);
                    }
                };
                const operations = createOperationService({ hooks });
                const planner = createPlannerService({ api, resolveConfig });
                registerRangedCoverPreset(planner);
                const perception = createPerceptionService({ api });
                const navigation = createNavigationService({ api });
                api.services.register('planner', planner);
                api.services.register('fireteam', createFireteamService({ api, resolveConfig }));
                api.services.register('perception', perception);
                api.services.register('navigation', {
                    ...navigation,
                    // One deterministic candidate for the mover; waypoints,
                    // cost, endpoint and token movement are all native.
                    findCandidates(token, budget, options) {
                        if (options.origin || options.target?.x === 650) {
                            return navigation.findCandidates(token, budget, options);
                        }
                        if (token.id !== b.id || token._source.x !== 200) return { status: 'ok', candidates: [] };
                        const route = navigation.planRoute(token, { x: 550, y: 350 }, budget, options);
                        return { status: 'ok', candidates: route.exact
                            ? [{ ...route.endpoint, waypoints: route.waypoints, cost: route.cost, los: true }] : [] };
                    }
                });
                const rolls = [];
                const results = [];
                const executor = createExecutorService({
                    api, hooks, resolveConfig, isEnabled: () => true,
                    getMode: () => 'automatic', pacing: () => 0, getAdjudication: () => 'auto'
                });
                check(executor.planCurrentTurn, 'Deploy the TeamPlan runtime before running this suite');
                const planContext = {
                    actions: [{ id: 'shot', type: 'attack', class: 'basic', range: 5, cost: 1 }],
                    rates: { half: 4, full: 8 }, seed: 7, threatMap: false, personality: false
                };
                authority = createAuthorityService({
                    api, hooks, operations, resolveConfig, isEnabled: () => true,
                    getCombats: () => [combat], getCombat: () => combat, getSocket: () => null,
                    getMode: () => 'automatic', debounceMs: 5,
                    runAIPlan: async context => results.push(await executor.runPlan({
                        ...context, planContext,
                        rolls: {
                            prepareAttack: async input => input,
                            executeAttack: async ({ tokenUuid }) => {
                                rolls.push([combat.round, combat.combatant.id, tokenUuid]);
                                return { status: 'ok', roll: { hits: 0 } };
                            }
                        }
                    }))
                });
                check(game.users.filter(u => u.active && u.isGM).length === 1,
                    'Run this isolated acceptance suite with one active GM');
                api.services.register('authority', authority);
                authority.start();
                combatHook = Hooks.on('updateCombat', (doc, diff) => {
                    if (doc.id === combat.id) hooks.callAll('updateCombat', doc, diff);
                });
                const progress = () => combat.getFlag('only-war-ai', 'teamManeuvers') ?? [];
                const details = () => JSON.stringify({
                    rolls, results: results.map(({ status, reason, stepsDone }) => ({ status, reason, stepsDone })),
                    progress: progress(), x: b._source.x, turn: combat.turn, round: combat.round
                });
                await combat.update({ round: 1, turn: 0 });
                await waitFor(() => combat.combatant?.id === other.id, 'handoff to non-AI member');
                check(!rolls.length && b._source.x === 500 && progress().length === 1,
                    `The shooter must pass, then the flanker must move: ${details()}`);
                const returnPlan = progress()[0].members.find(member => member.id === flank.id).rejoin;
                if (detached) {
                    check(returnPlan?.route?.length > 1 && returnPlan.cost <= 8,
                        `The detached assignment needs a verified return: ${details()}`);
                    const model = localizePreviewViewModel(buildPreviewViewModel({
                        snapshot: { combatantId: lead.id },
                        teamTurn: { phase: 'wait', state: progress()[0] }
                    }, { combat }));
                    const html = await foundry.applications.handlebars.renderTemplate(
                        'modules/only-war-ai/templates/ai-preview.hbs', model);
                    const dom = new DOMParser().parseFromString(html, 'text/html');
                    const team = dom.querySelector('.ow-ai-preview-team');
                    check(team?.querySelectorAll('li').length === 2
                        && team.textContent.includes(game.i18n.localize('OWAI.Preview.Team.Rejoin'))
                        && dom.querySelectorAll('[data-action="confirm"]').length === 1,
                    'Expected a team preview with the return route and one confirmation control');
                }
                if (interrupt) await flank.update({ defeated: true });
                await combat.nextTurn(); // the non-AI combatant plays their turn
                await waitFor(() => combat.combatant?.id === other.id && combat.round === 2, 'next round handoff');
                const expected = interrupt ? [] : [[2, lead.id, a.uuid], [2, flank.id, b.uuid]];
                check(JSON.stringify(rolls) === JSON.stringify(expected) && progress().length === (detached ? 1 : 0)
                    && b._source.x === 500, `Invalid action phase or rollback: ${details()}`);
                if (detached) {
                    await combat.nextTurn();
                    await waitFor(() => combat.combatant?.id === other.id && combat.round === 3, 'regroup handoff');
                    const distance = Math.hypot(a._source.x - b._source.x, a._source.y - b._source.y) / 100;
                    check(distance <= 2 && distance > 0 && !progress().length && rolls.length === 2,
                        `Regroup did not return to a free cell in cohesion: ${details()}`);
                }
                cases.push({ interrupt, moves: detached ? 2 : 1, attacks: rolls.length });
            } finally {
                authority?.stop();
                if (combatHook) Hooks.off('updateCombat', combatHook);
                // Foundry 13 activates the viewed combat after a deletion.
                // Delete before switching scenes and suppress that activation
                // even if the tracker falls back to another combat.
                const tempCombat = cleanup.find(doc => doc.documentName === 'Combat');
                if (tempCombat) {
                    const combats = game.combats;
                    const viewed = Object.getOwnPropertyDescriptor(combats, 'viewed');
                    Object.defineProperty(combats, 'viewed', { configurable: true, value: undefined });
                    try {
                        await tempCombat.delete();
                    } finally {
                        if (viewed) Object.defineProperty(combats, 'viewed', viewed);
                        else delete combats.viewed;
                    }
                    cleanup.splice(cleanup.indexOf(tempCombat), 1);
                }
                if (initialScene && canvas.scene?.id !== initialScene.id) {
                    await initialScene.view();
                    await waitFor(() => canvas.ready && canvas.scene?.id === initialScene.id, 'restore canvas');
                }
                for (const doc of cleanup.reverse()) await doc.delete();
                if (game.combat !== initialCombat) await ui.combat.render({ combat: initialCombat });
            }
        }
        const after = snapshot();
        const changed = before.filter(([, value], i) => after[i][1] !== value).map(([name]) => name);
        return { cases, unchanged: changed.length === 0, changed };
    }, scriptRoot);
    assert.deepEqual(report.cases, [
        { interrupt: false, moves: 1, attacks: 2 },
        { interrupt: true, moves: 1, attacks: 0 },
        { interrupt: false, moves: 2, attacks: 2 }
    ]);
    assert.equal(report.unchanged, true,
        `existing scene, combat and world time stay unchanged; changed: ${report.changed}`);
    console.log('team-turn.test.mjs PASSED:', report);
} finally {
    await browser.close();
}
