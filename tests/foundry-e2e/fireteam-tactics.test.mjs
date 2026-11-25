import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import * as h from './lib.mjs';

/**
 * Fireteam tactics acceptance coverage (issue #410, epic #363):
 * - flank-and-fix on square AND hex grids (spec-ops team outnumbered,
 *   flank open) with a flank group and a synchronization barrier;
 * - coordinated-assault with the movement preflight barrier that blocks
 *   a partial start (`barrier-movement`, `failurePolicy: "hold"`);
 * - covering-advance and forced regroup without conflicting target
 *   reservations;
 * - soft cohesion checks and temporary assignments living only inside
 *   the TeamPlan — nothing permanent is written to documents.
 *
 * Requires a running Foundry (FOUNDRY_URL), Chrome with CDP (CDP_URL) and
 * the only-war-ai module.
 */

const TEAM_ID = 'alpha-tactics';
const names = {
    members: ['AI Tactics Leader', 'AI Tactics Flanker', 'AI Tactics Support'],
    enemies: ['AI Tactics Enemy 1', 'AI Tactics Enemy 2', 'AI Tactics Enemy 3', 'AI Tactics Enemy 4']
};

let page;
let browser;
const memberActorIds = [];
const enemyActorIds = [];
const scenes = [];
const combats = [];

async function setup() {
    browser = await chromium.connectOverCDP(h.CDP_URL);
    page = await h.getGmPage(browser);
    await h.ensureJoinedGame(page);

    console.log('Connected to Foundry game session');

    for (const name of names.members) {
        const id = await h.createTestActor(page, 'npc', name, async (actor) => {
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
        memberActorIds.push(id);
    }
    for (const name of names.enemies) {
        enemyActorIds.push(await h.createTestActor(page, 'npc', name));
    }
}

/**
 * Place the 3 members + 4 enemies on a fresh scene of the given grid type
 * and build the combat with fireteam + preset flags on the members.
 * @param {number} gridType Foundry grid type (1 = square, >= 2 = hex).
 * @returns {Promise<object>} `{sceneId, combatId, memberCids, enemyTids}`.
 */
async function setupTeamCombat(gridType) {
    const sceneId = await h.createTestScene(page, { grid: gridType, size: 100 });
    scenes.push(sceneId);
    const memberTids = [];
    const enemyTids = [];
    const memberPos = [{ x: 300, y: 300 }, { x: 300, y: 500 }, { x: 300, y: 700 }];
    const enemyPos = [
        { x: 1400, y: 300 }, { x: 1500, y: 500 }, { x: 1400, y: 700 }, { x: 1600, y: 500 }
    ];
    for (const [i, actorId] of memberActorIds.entries()) {
        memberTids.push(await h.placeToken(page, sceneId, actorId, memberPos[i]));
    }
    for (const [i, actorId] of enemyActorIds.entries()) {
        enemyTids.push(await h.placeToken(page, sceneId, actorId, enemyPos[i]));
    }
    await page.evaluate(async (data) => {
        const scene = game.scenes.get(data.sceneId);
        for (const tid of data.memberTids) await scene.tokens.get(tid).update({ disposition: -1 });
        for (const tid of data.enemyTids) await scene.tokens.get(tid).update({ disposition: 1 });
    }, { sceneId, memberTids, enemyTids });
    const combatId = await h.createCombat(page, [...memberTids, ...enemyTids]);
    combats.push(combatId);
    const memberCids = await page.evaluate(async (data) => {
        const combat = game.combats.get(data.combatId);
        const ids = [];
        for (const tid of data.memberTids) {
            const combatant = combat.combatants.find((c) => c.tokenId === tid);
            await combatant.setFlag('only-war-ai', 'override', { mode: 'enabled', preset: 'specOps' });
            await combatant.setFlag('only-war-ai', 'fireteam', {
                teamId: 'alpha-tactics',
                teamPreset: 'specOps'
            });
            ids.push(combatant.id);
        }
        return ids;
    }, { combatId, memberTids });
    return { sceneId, combatId, memberCids, enemyTids };
}

/** Injected normalized target list from live enemy token docs. */
async function injectedTargets(sceneId, enemyTids, count) {
    return page.evaluate(({ sceneId, enemyTids, count }) => {
        const scene = game.scenes.get(sceneId);
        return enemyTids.slice(0, count ?? enemyTids.length).map((tid) => {
            const token = scene.tokens.get(tid);
            return {
                tokenId: token.id,
                tokenUuid: token.uuid,
                x: token._source?.x ?? token.x,
                y: token._source?.y ?? token.y,
                elevation: token.elevation ?? 0,
                canAttack: true
            };
        });
    }, { sceneId, enemyTids, count });
}

async function buildPlan(combatId, context = {}) {
    return page.evaluate(async (data) => {
        const fireteam = game.modules.get('only-war-ai').api.services.get('fireteam');
        const combat = game.combats.get(data.combatId);
        const result = await fireteam.buildTeamPlan(combat, { teamId: 'alpha-tactics' }, data.context);
        return JSON.parse(JSON.stringify(result));
    }, { combatId, context });
}

async function testFlankAndFix(gridType, label) {
    const env = await setupTeamCombat(gridType);
    const targets = await injectedTargets(env.sceneId, env.enemyTids);
    const result = await buildPlan(env.combatId, { seed: 7, targets });
    assert.equal(result.status, 'ok', `buildTeamPlan failed: ${result.reason}`);
    const plan = result.teamPlan;
    assert.equal(plan.tactic, 'flank-and-fix',
        `outnumbered open-field team should flank-and-fix, got ${plan.tactic}`);
    const tasks = new Map(plan.members.map((m) => [m.combatantId, m.task]));
    const flanks = plan.members.filter((m) => m.task === 'flank');
    assert.equal(flanks.length, 1, 'exactly one flanker in flank-and-fix');
    assert.equal(flanks[0].groupId, 'flank-1', 'flanker is the detached flank group');
    const supports = plan.members.filter((m) => m.task === 'support' || m.task === 'assault');
    assert.equal(supports.length, 2, 'the rest fix the enemy frontally');
    assert.equal(plan.phases.length, 3, 'movement/action/regroup phases exist');
    const barrier = plan.phases[1]?.barrier;
    assert.ok(barrier, 'flank-and-fix gates actions behind a barrier');
    assert.ok(barrier.requiredAssignmentIds.includes(flanks[0].combatantId),
        'barrier requires the flanker to be in place first');
    const verdict = await page.evaluate((p) =>
        game.modules.get('only-war-ai').api.services.get('fireteam').validateTeamPlan(p), plan);
    assert.equal(verdict.valid, true, `team plan should validate: ${verdict.reason}`);
    console.log(`${label}: flank-and-fix with flanker ${flanks[0].combatantId}, `
        + `tasks=${[...tasks.values()].join('/')}`);
}

async function testCoordinatedAssaultBarrier() {
    const env = await setupTeamCombat(1);
    // Parity/superiority: 3 members vs 2 contacts -> coordinated-assault.
    const targets = await injectedTargets(env.sceneId, env.enemyTids, 2);
    const result = await buildPlan(env.combatId, { seed: 7, targets });
    assert.equal(result.status, 'ok', `buildTeamPlan failed: ${result.reason}`);
    const plan = result.teamPlan;
    assert.equal(plan.tactic, 'coordinated-assault',
        `parity team should coordinate the assault, got ${plan.tactic}`);
    assert.ok(plan.members.every((m) => m.task === 'assault'),
        'coordinated-assault assaults with the whole team');

    // Preflight barrier: the action phase may not start partially — every
    // member that still has to move must be satisfied first, and a failed
    // mover makes the team hold instead of starting a half assault.
    const movement = plan.phases[0];
    const action = plan.phases[1];
    const barrier = action.barrier;
    assert.ok(barrier, 'coordinated-assault needs a preflight barrier');
    assert.equal(barrier.afterPhase, 'phase-0');
    assert.equal(barrier.failurePolicy, 'hold', 'a failed mover holds the assault');
    const movers = [...new Set(movement.steps.map((s) => s.combatantId))];
    assert.ok(movers.length > 0, 'members plan real movement');
    for (const id of movers) {
        assert.ok(barrier.requiredAssignmentIds.includes(id),
            `mover ${id} must be satisfied before the action phase`);
    }
    assert.ok(action.steps.length > 0, 'assault steps are planned behind the barrier');
    console.log(`coordinated-assault: barrier requires ${barrier.requiredAssignmentIds.length} `
        + `assignments before ${action.steps.length} action steps (hold on failure)`);
}

async function testCoveringAdvanceAndRegroup() {
    const env = await setupTeamCombat(1);

    // No contacts: the team bounds forward in a covering advance.
    const advance = await buildPlan(env.combatId, { seed: 7, targets: [] });
    assert.equal(advance.status, 'ok', `buildTeamPlan failed: ${advance.reason}`);
    assert.equal(advance.teamPlan.tactic, 'covering-advance',
        `no contacts should bound forward, got ${advance.teamPlan.tactic}`);
    const advanceTasks = advance.teamPlan.members.map((m) => m.task);
    assert.ok(advanceTasks.includes('support') && advanceTasks.includes('advance'),
        `covering advance splits support+advance, got ${advanceTasks.join(',')}`);
    const targetConflicts = (advance.teamPlan.reservations?.conflicts ?? [])
        .filter((c) => c.type === 'target');
    assert.equal(targetConflicts.length, 0,
        `no target reservations may conflict, got ${JSON.stringify(targetConflicts)}`);

    // Forced regroup: everyone falls back with unbounded capacity — no
    // conflicting reservations may arise.
    const regroup = await buildPlan(env.combatId, { seed: 7, regroup: true });
    assert.equal(regroup.status, 'ok', `buildTeamPlan failed: ${regroup.reason}`);
    assert.equal(regroup.teamPlan.tactic, 'regroup-fallback',
        `forced regroup should produce regroup-fallback, got ${regroup.teamPlan.tactic}`);
    assert.ok(regroup.teamPlan.members.every((m) => m.task === 'regroup'),
        'forced regroup assigns regroup to every member');
    const regroupConflicts = (regroup.teamPlan.reservations?.conflicts ?? [])
        .filter((c) => c.type === 'target');
    assert.equal(regroupConflicts.length, 0,
        'unbounded regroup capacity produces no target conflicts');
    console.log(`covering-advance (${advanceTasks.join('/')}) and forced regroup `
        + 'reserve without conflicts');
}

async function testSoftCohesion() {
    const cohesion = await page.evaluate(() => {
        const fireteam = game.modules.get('only-war-ai').api.services.get('fireteam');
        const center = { x: 0, y: 0 };
        return {
            within: fireteam.evaluateCohesion({
                endpoint: { x: 4, y: 0 }, center, preferredCohesion: 5, task: 'support'
            }),
            beyond: fireteam.evaluateCohesion({
                endpoint: { x: 5000, y: 0 }, center, preferredCohesion: 5, task: 'support'
            }),
            detached: fireteam.evaluateCohesion({
                endpoint: { x: 5000, y: 0 }, center, preferredCohesion: 5, task: 'flank',
                detachedUntilPhase: 1, rejoinAvailable: true, reachable: true
            }),
            unbounded: fireteam.evaluateCohesion({
                endpoint: { x: 5000, y: 0 }, center, preferredCohesion: 5, task: 'flank',
                reachable: true
            })
        };
    });
    assert.equal(cohesion.within.reason, 'within-cohesion');
    assert.equal(cohesion.within.penalty, 0);
    assert.equal(cohesion.beyond.reason, 'beyond-cohesion',
        'support leaving cohesion pays a soft penalty only');
    assert.equal(cohesion.beyond.allowed, true, 'cohesion never forbids movement outright');
    assert.ok(cohesion.beyond.penalty > 0);
    assert.equal(cohesion.detached.reason, 'detached-maneuver',
        'a bounded, reachable flanker detachment is a legal maneuver');
    assert.equal(cohesion.detached.allowed, true);
    assert.ok(cohesion.detached.penalty < cohesion.beyond.penalty,
        'the detached flanker pays a reduced penalty');
    assert.equal(cohesion.unbounded.allowed, false,
        'an unbounded detached separation is refused');
    console.log('soft cohesion: within/beyond/detached-maneuver checks all behave');
}

async function testTemporaryAssignments() {
    const env = await setupTeamCombat(1);
    const targets = await injectedTargets(env.sceneId, env.enemyTids);
    const result = await buildPlan(env.combatId, { seed: 7, targets });
    assert.equal(result.status, 'ok');

    // Assignments are temporary: they exist only inside the TeamPlan and
    // end with it — no task/role is ever persisted to documents.
    for (const member of result.teamPlan.members) {
        assert.ok(typeof member.task === 'string' && member.task.length > 0,
            'member tasks live inside the plan');
    }
    const flags = await page.evaluate((data) =>
        data.cids.map((cid) => {
            const combatant = game.combats.get(data.combatId).combatants.get(cid);
            return combatant?.flags?.['only-war-ai'] ?? {};
        }), { cids: env.memberCids, combatId: env.combatId });
    for (const flag of flags) {
        const persistent = ['fireteam', 'override', 'memory', 'morale'];
        assert.deepEqual(Object.keys(flag).filter(key => !persistent.includes(key)), [],
            `planning may record memory and morale but not assignments: ${JSON.stringify(flag)}`);
        assert.deepEqual(flag.fireteam, { teamId: 'alpha-tactics', teamPreset: 'specOps' },
            'no task or role is persisted on the combatant');
    }
    const invalidated = await page.evaluate((p) =>
        game.modules.get('only-war-ai').api.services.get('fireteam').invalidateTeamPlan(p),
        result.teamPlan);
    assert.equal(invalidated.invalidated, true, 'terminal TeamPlan is marked invalidated');
    console.log('assignments are plan-local only; no permanent roles are persisted');
}

async function cleanup() {
    await h.closeAllWindows(page);
    for (const id of combats) await h.deleteCombat(page, id);
    for (const id of scenes) await h.deleteScene(page, id);
    for (const id of memberActorIds) await h.deleteActor(page, id);
    for (const id of enemyActorIds) await h.deleteActor(page, id);
}

(async () => {
    let failed = false;
    try {
        await setup();
        await testFlankAndFix(1, 'square');
        await testFlankAndFix(3, 'hex');
        await testCoordinatedAssaultBarrier();
        await testCoveringAdvanceAndRegroup();
        await testSoftCohesion();
        await testTemporaryAssignments();
        console.log('fireteam-tactics.test.mjs PASSED');
    } catch (err) {
        failed = true;
        console.error('fireteam-tactics.test.mjs FAILED:', err);
        try { await h.screenshot(page, 'fireteam-tactics-failure'); } catch { /* ignore */ }
    }
    await cleanup().catch(() => {});
    process.exit(failed ? 1 : 0);
})();
