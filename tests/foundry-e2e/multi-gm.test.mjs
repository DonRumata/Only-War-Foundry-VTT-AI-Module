import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import * as h from './lib.mjs';

/**
 * Multi-GM acceptance coverage (issue #410, epic #363):
 * - Two connected GM clients elect the SAME deterministic controller and
 *   only that client executes AI plans — a second GM never creates
 *   duplicate document updates.
 * - Controller handoff: a live operation recorded under a foreign
 *   controller is cancelled `controller-changed` when the elected
 *   controller sweeps combats (the mechanism behind GM handoffs).
 * - With no active GM the AI waits: election reports `waiting-for-gm`
 *   and the planner/executor gates return the same controlled reason.
 *
 * A true zero-GM world cannot exist while the test client itself needs a
 * GM session, so the no-GM case is verified through the same live service
 * objects (`elect` + injected waiting authority), never by faking calls.
 */

const names = {
    npc: 'AI MultiGM NPC',
    enemy: 'AI MultiGM Enemy',
    gm: 'AI E2E GM Two'
};

let page;
let gmPage;
let browser;
let gmUserId;
let npcId;
let enemyId;
let sceneId;
let npcTokenId;
let enemyTokenId;
let combatId;
let combatantId;

/** Join a second page as the second GM user. */
async function joinAsSecondGm() {
    gmPage = await (browser.contexts()[0] || await browser.newContext()).newPage();
    await gmPage.setViewportSize({ width: 1400, height: 900 });
    await gmPage.goto(`${h.FOUNDRY_URL}/join`, { waitUntil: 'load' });
    await gmPage.waitForFunction(() =>
        document.querySelectorAll('select[name="userid"] option').length > 0, { timeout: 10000 });
    await gmPage.locator('select[name="userid"]').selectOption(gmUserId, { force: true });
    const passwordInput = await gmPage.$('input[name="password"]');
    if (passwordInput) await passwordInput.fill('');
    await Promise.all([
        gmPage.waitForURL(`${h.FOUNDRY_URL}/game`, { waitUntil: 'load' }),
        gmPage.click('button[name="join"]')
    ]);
    await gmPage.waitForFunction(() =>
        typeof game !== 'undefined' && game?.ready && game?.user, { timeout: 30000 });
    await gmPage.waitForTimeout(1500);
}

async function setup() {
    browser = await chromium.connectOverCDP(h.CDP_URL);
    page = await h.getGmPage(browser);
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
    await page.evaluate(async (data) => {
        const scene = game.scenes.get(data.sceneId);
        await scene.tokens.get(data.npcTokenId).update({ disposition: -1 });
        await scene.tokens.get(data.enemyTokenId).update({ disposition: 1 });
    }, { sceneId, npcTokenId, enemyTokenId });
    combatId = await h.createCombat(page, [npcTokenId, enemyTokenId]);
    combatantId = await page.evaluate((tid) =>
        game.combat?.combatants?.find((c) => c.tokenId === tid)?.id ?? null, npcTokenId);
    assert.ok(combatantId, 'npc combatant exists');
    await h.setOverride(page, {
        kind: 'combatant', id: combatantId, override: { mode: 'enabled', preset: 'assault' }
    });

    // A dedicated second GM user for the two-client scenario.
    gmUserId = await page.evaluate(async (name) => {
        const existing = game.users.find((u) => u.name === name);
        if (existing) {
            await existing.update({ role: CONST.USER_ROLES.GAMEMASTER });
            return existing.id;
        }
        const created = await User.create({ name, role: CONST.USER_ROLES.GAMEMASTER });
        return created.id;
    }, names.gm);
    assert.ok(gmUserId, 'second GM user created');
    await joinAsSecondGm();
}

let electedControllerId;
let controllerPage;
let otherPage;

async function testDeterministicElectionAcrossClients() {
    const [electA, electB] = await Promise.all([
        page.evaluate(() => {
            const authority = game.modules.get('only-war-ai').api.services.get('authority');
            return { elect: authority.elect(game.users), self: game.user.id, isController: authority.isController() };
        }),
        gmPage.evaluate(() => {
            const authority = game.modules.get('only-war-ai').api.services.get('authority');
            return { elect: authority.elect(game.users), self: game.user.id, isController: authority.isController() };
        })
    ]);
    assert.equal(electA.elect.controllerId, electB.elect.controllerId,
        'both GM clients elect the identical controller');
    assert.equal(electA.elect.status, 'ready', 'two active GMs keep the module ready');
    electedControllerId = electA.elect.controllerId;
    controllerPage = electA.isController ? page : gmPage;
    otherPage = electA.isController ? gmPage : page;
    console.log(`elected controller ${electedControllerId} `
        + `(page1=${electA.self} ctrl=${electA.isController}, page2=${electB.self} ctrl=${electB.isController})`);
    // Exactly one of the two clients may report itself controller.
    assert.notEqual(electA.isController, electB.isController,
        'exactly one GM client is the controller');
}

/** Run executor.runPlan for the npc on the given page. */
async function runPlanOn(target, operationId) {
    return target.evaluate(async (data) => {
        const executor = game.modules.get('only-war-ai').api.services.get('executor');
        const combatant = game.combat?.combatants?.get(data.cid);
        const outcome = await executor.runPlan({
            combat: game.combat,
            combatant,
            operation: {
                id: data.operationId,
                combatantId: data.cid,
                phase: 'executing'
            },
            seed: 1
        });
        return JSON.parse(JSON.stringify(outcome));
    }, { cid: combatantId, operationId });
}

async function testNoDuplicateUpdates() {
    const operationId = `e2e-multigm-${Math.random().toString(36).slice(2, 10)}`;
    const previousMode = await page.evaluate(async () => {
        const mode = game.settings.get('only-war-ai', 'executionMode');
        await game.settings.set('only-war-ai', 'executionMode', 'automatic');
        return mode;
    });
    try {
        // The non-controller client must refuse without touching documents.
        const before = await otherPage.evaluate((data) => ({
            pos: { ...canvas.scene.tokens.get(data.tid)?._source },
            messages: game.messages?.size ?? 0,
            operation: game.combat?.getFlag('only-war-ai', 'operation') ?? null
        }), { tid: npcTokenId });
        const denied = await runPlanOn(otherPage, `denied-${operationId}`);
        assert.equal(denied.status, 'cancelled',
            `non-controller must not execute, got ${denied.status}`);
        assert.equal(denied.reason, 'not-controller',
            `expected not-controller, got ${denied.reason}`);
        await otherPage.waitForTimeout(500);
        const after = await otherPage.evaluate((data) => ({
            pos: { ...canvas.scene.tokens.get(data.tid)?._source },
            messages: game.messages?.size ?? 0,
            operation: game.combat?.getFlag('only-war-ai', 'operation') ?? null
        }), { tid: npcTokenId });
        assert.deepEqual(after.pos, before.pos, 'non-controller moved nothing');
        assert.equal(after.messages, before.messages, 'non-controller wrote no chat cards');
        assert.equal(after.operation, before.operation, 'non-controller wrote no operation flag');

        // The controller executes the same turn exactly once; a second call
        // with the same operation id replays the stored result.
        const first = await runPlanOn(controllerPage, operationId);
        assert.equal(first.status, 'completed',
            `controller execution should complete, got ${first.status} (${first.reason})`);
        const again = await runPlanOn(controllerPage, operationId);
        assert.equal(again.operationId, first.operationId, 'operation id is stable');
        assert.equal(again.status, first.status, 'same operation id replays the stored result');
        assert.ok(again.stepsDone.length <= first.stepsDone.length,
            'replay does not add steps');

        // Chat cards for the attack were produced exactly once.
        const cards = await controllerPage.evaluate((ids) =>
            ids.filter((id) => game.messages?.get(id)).length, first.chatMessageIds);
        assert.equal(cards, first.chatMessageIds.length, 'attack chat cards exist once');
        console.log(`controller ran once (${first.stepsDone.length} steps, `
            + `${first.chatMessageIds.length} chat cards); duplicate attempts were no-ops`);
    } finally {
        await page.evaluate(async (mode) => {
            await game.settings.set('only-war-ai', 'executionMode', mode);
        }, previousMode);
    }
}

async function testControllerHandoff() {
    // A live operation recorded under a foreign controller must be
    // cancelled `controller-changed` when the elected controller sweeps.
    const outcome = await controllerPage.evaluate(async (data) => {
        const api = game.modules.get('only-war-ai').api;
        const operations = api.services.get('operations');
        const authority = api.services.get('authority');
        const combat = game.combats.get(data.combatId);
        const combatant = combat.combatants.get(data.cid);
        const foreignId = 'zz-foreign-controller';
        const elected = authority.elect(game.users).controllerId;
        const claim = await operations.claimTurn(combat, combatant, { controllerId: foreignId });
        const before = combat.getFlag('only-war-ai', 'operation')?.phase ?? null;
        const abort = await authority.abortCombatIfControllerChanged(combat);
        const after = combat.getFlag('only-war-ai', 'operation') ?? null;
        return { claimOk: claim.ok, elected, before, abort, after };
    }, { combatId, cid: combatantId });
    assert.equal(outcome.claimOk, true, 'foreign-controller operation claimed');
    assert.equal(outcome.before, 'planning');
    assert.equal(outcome.abort.aborted, true, 'handoff sweep aborts the foreign operation');
    assert.equal(outcome.after.phase, 'cancelled');
    assert.equal(outcome.after.reason, 'controller-changed',
        `expected controller-changed, got ${outcome.after.reason}`);
    console.log('controller handoff cancels foreign live operations');
}

async function testNoActiveGmWaits() {
    // No active GM: election reports waiting-for-gm and every gate answers
    // the same controlled reason — the AI never acts on its own.
    const waiting = await page.evaluate(() => {
        const authority = game.modules.get('only-war-ai').api.services.get('authority');
        const playersOnly = [{ id: 'pl-1', isGM: false, active: true },
            { id: 'pl-2', isGM: false, active: true, role: 1 }];
        return authority.elect(playersOnly);
    });
    assert.equal(waiting.controllerId, null);
    assert.equal(waiting.status, 'waiting-for-gm', 'no active GM elects nobody');

    const planner = await page.evaluate(async (cid) => {
        const svc = game.modules.get('only-war-ai').api.services.get('planner');
        const combatant = game.combat?.combatants?.get(cid);
        const outcome = await svc.planTurn(game.combat, combatant, {
            seed: 1,
            authority: { status: 'waiting-for-gm' }
        });
        return JSON.parse(JSON.stringify(outcome));
    }, combatantId);
    assert.equal(planner.status, 'waiting-for-gm',
        `planner waits without an active GM, got ${planner.status}`);
    assert.equal(planner.reason, 'not-controller');

    const before = await page.evaluate((tid) => ({
        pos: { ...canvas.scene.tokens.get(tid)?._source },
        messages: game.messages?.size ?? 0
    }), npcTokenId);
    const exec = await page.evaluate(async (cid) => {
        const executor = game.modules.get('only-war-ai').api.services.get('executor');
        const combatant = game.combat?.combatants?.get(cid);
        const outcome = await executor.runPlan({
            combat: game.combat,
            combatant,
            operation: { id: `e2e-nogm-${foundry.utils.randomID()}`, combatantId: cid, phase: 'executing' },
            seed: 1,
            authority: { isController: () => false }
        });
        return JSON.parse(JSON.stringify(outcome));
    }, combatantId);
    assert.equal(exec.status, 'cancelled', `executor waits without an active GM, got ${exec.status}`);
    assert.equal(exec.reason, 'not-controller');
    const after = await page.evaluate((tid) => ({
        pos: { ...canvas.scene.tokens.get(tid)?._source },
        messages: game.messages?.size ?? 0
    }), npcTokenId);
    assert.deepEqual(after, before, 'no automation ran without an active GM');
    console.log('no active GM: authority waits, planner/executor return not-controller');
}

async function cleanup() {
    try {
        if (gmPage && !gmPage.isClosed()) await gmPage.close();
    } catch { /* best-effort */ }
    await h.closeAllWindows(page);
    if (combatId) await h.deleteCombat(page, combatId);
    if (sceneId) await h.deleteScene(page, sceneId);
    if (npcId) await h.deleteActor(page, npcId);
    if (enemyId) await h.deleteActor(page, enemyId);
    if (gmUserId) {
        // The second GM's socket may need a moment to release the user.
        await page.waitForTimeout(1000);
        await page.evaluate(async (id) => {
            const user = game.users.get(id);
            if (user && user.id !== game.user.id) await user.delete();
        }, gmUserId).catch(async () => {
            await page.waitForTimeout(1500);
            await page.evaluate(async (id) => {
                const user = game.users.get(id);
                if (user && user.id !== game.user.id) await user.delete();
            }, gmUserId).catch(() => {});
        });
    }
}

(async () => {
    let failed = false;
    try {
        await setup();
        await testDeterministicElectionAcrossClients();
        await testNoDuplicateUpdates();
        await testControllerHandoff();
        await testNoActiveGmWaits();
        console.log('multi-gm.test.mjs PASSED');
    } catch (err) {
        failed = true;
        console.error('multi-gm.test.mjs FAILED:', err);
        try { await h.screenshot(page, 'multi-gm-failure'); } catch { /* ignore */ }
    }
    await cleanup().catch(() => {});
    process.exit(failed ? 1 : 0);
})();
