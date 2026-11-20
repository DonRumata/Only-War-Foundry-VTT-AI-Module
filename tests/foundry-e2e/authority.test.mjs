import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import * as h from './lib.mjs';

const names = {
  npc: 'AI Authority NPC'
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
  combatId = await h.createCombat(page, [tokenId]);
  combatantId = await page.evaluate((tid) =>
    game.combat?.combatants?.find((c) => c.tokenId === tid)?.id ?? null, tokenId);
  assert.ok(combatantId, 'combatant created for the npc token');
}

async function testAuthorityServicesRegistered() {
  const info = await page.evaluate(() => {
    const api = game.modules.get('only-war-ai')?.api;
    return {
      enabled: api?.enabled ?? null,
      hasAuthority: api?.services?.has?.('authority') === true,
      hasOperations: api?.services?.has?.('operations') === true,
      hasElect: typeof api?.services?.get?.('authority')?.elect === 'function',
      capabilities: api?.capabilities ?? null
    };
  });

  assert.equal(info.hasAuthority, true, 'authority service registered');
  assert.equal(info.hasOperations, true, 'operations service registered');
  assert.equal(info.hasElect, true, 'electController exposed on the authority service');
  assert.equal(info.capabilities['authority.election'], true, 'election capability');
  assert.equal(info.capabilities['operations.lifecycle'], true, 'lifecycle capability');
}

async function testElectionDeterminism() {
  const result = await page.evaluate(() => {
    const authority = game.modules.get('only-war-ai')?.api?.services?.get('authority');
    const real = authority.elect(game.users);
    const self = game.user.id;
    // Two simulated GM users: the lower id must always win, on every client.
    const fakeA = { id: 'zz-fake-gm', isGM: true, active: true, role: 4 };
    const fakeB = { id: self, isGM: true, active: true, role: 4 };
    const first = authority.elect([fakeA, fakeB, { id: 'pl', isGM: false, active: true }]);
    const shuffled = authority.elect([fakeB, fakeA]);
    return { real, self, first, shuffled };
  });

  assert.equal(result.real.controllerId, result.self, 'single active GM elects self');
  assert.equal(result.real.status, 'ready');
  assert.deepEqual(result.first, result.shuffled, 'election is deterministic across clients');
  const expected = result.self < 'zz-fake-gm' ? result.self : 'zz-fake-gm';
  assert.equal(result.first.controllerId, expected, 'lowest user id wins');

  const noGm = await page.evaluate(() =>
    game.modules.get('only-war-ai').api.services.get('authority')
      .elect([{ id: 'pl-1', isGM: false, active: true }]));
  assert.equal(noGm.controllerId, null);
  assert.equal(noGm.status, 'waiting-for-gm');
}

async function testClaimTransitionComplete() {
  const outcome = await page.evaluate(async (cid) => {
    const ops = game.modules.get('only-war-ai').api.services.get('operations');
    const combat = game.combats.get(cid);
    const combatant = combat.combatants.contents[0];
    const self = game.user.id;

    const first = await ops.claimTurn(combat, combatant, { controllerId: self });
    const second = await ops.claimTurn(combat, combatant, { controllerId: self });
    const badPhase = await ops.transitionOperation(combat, first.operation.id, 'executing', 'completed');
    const toExecuting = await ops.transitionOperation(combat, first.operation.id, 'planning', 'executing');
    const done = await ops.completeTurn(combat, first.operation.id, { completed: true });
    const repeat = await ops.completeTurn(combat, first.operation.id, { completed: true });
    const stored = combat.getFlag('only-war-ai', 'operation');
    return {
      firstOk: first.ok,
      secondReason: second.reason,
      badPhaseReason: badPhase.reason,
      executingPhase: toExecuting.operation?.phase ?? null,
      donePhase: done.operation?.phase ?? null,
      repeatNoop: repeat.noop === true && repeat.reason === 'already-completed',
      stored
    };
  }, combatId);

  assert.equal(outcome.firstOk, true, 'first claim wins');
  assert.equal(outcome.secondReason, 'operation-exists', 'duplicate claim rejected');
  assert.equal(outcome.badPhaseReason, 'phase-mismatch', 'wrong phase rejected');
  assert.equal(outcome.executingPhase, 'executing');
  assert.equal(outcome.donePhase, 'completed');
  assert.equal(outcome.repeatNoop, true, 'repeat completion is a no-op');

  const op = outcome.stored;
  for (const field of ['id', 'combatId', 'combatantId', 'round', 'turn', 'controllerId', 'phase', 'revision', 'startedAt', 'completedAt']) {
    assert.ok(field in op, `operation flag carries ${field}`);
  }
  assert.equal(op.combatId, combatId);
  assert.equal(op.combatantId, combatantId);
  assert.equal(op.result.completed, true);
}

async function testAutoClaimOnTurnStart() {
  const apiEnabled = await page.evaluate(() => game.modules.get('only-war-ai')?.api?.enabled === true);
  if (!apiEnabled) {
    console.log('Skipping auto-claim assertion: module disabled (no compatible system api)');
    return;
  }

  // Enable AI on the actor, then start the combat: the authority service must
  // claim the turn, run the integrated plan pipeline and park in
  // `awaiting-preview` (preview is the default execution mode).
  await h.setActorAiConfig(page, npcId, { enabled: true, preset: 'assault' });
  await page.evaluate(async (cid) => {
    const combat = game.combats.get(cid);
    await combat.unsetFlag('only-war-ai', 'operation').catch(() => {});
    await combat.startCombat();
  }, combatId);

  await page.waitForFunction((cid) => {
    const op = game.combats.get(cid)?.getFlag('only-war-ai', 'operation');
    return !!op;
  }, combatId, { timeout: 10000 });
  await page.waitForFunction((cid) => {
    const op = game.combats.get(cid)?.getFlag('only-war-ai', 'operation');
    return op && ['awaiting-preview', 'executing', 'completed', 'failed', 'cancelled'].includes(op.phase);
  }, combatId, { timeout: 15000 });

  const op = await page.evaluate((cid) =>
    game.combats.get(cid)?.getFlag('only-war-ai', 'operation') ?? null, combatId);

  assert.ok(op, 'authority service wrote the operation flag on turn start');
  assert.equal(op.controllerId, await page.evaluate(() => game.user.id), 'controller is self');
  assert.equal(op.combatantId, combatantId);

  // With the executor integrated the operation is previewed, not
  // auto-completed. Close it through the operations service — the terminal
  // phase must persist (the full preview flow is covered by preview.test.mjs).
  const terminal = await page.evaluate(async (cid) => {
    const api = game.modules.get('only-war-ai')?.api;
    const combat = game.combats.get(cid);
    const current = combat?.getFlag('only-war-ai', 'operation');
    if (!current) return null;
    if (['completed', 'failed', 'cancelled'].includes(current.phase)) return current;
    const preview = api?.services?.get?.('preview');
    const out = { preview: !!preview, decision: null, complete: null };
    out.decision = await preview?.resolvePreview?.(current.id, 'cancel').catch((e) => ({ err: e.message }));
    if (out.decision?.ok !== true) {
      out.complete = await api?.services?.get?.('operations')?.completeTurn?.(combat, current.id,
        { cancelled: true, reason: 'e2e-close', advanceTurn: false }).catch((e) => ({ err: e.message }));
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    out.op = game.combats.get(cid)?.getFlag('only-war-ai', 'operation') ?? null;
    return out;
  }, combatId);
  if (terminal?.op) terminal.op._debug = terminal;
  const finalOp = terminal?.op ?? null;
  console.log('terminal debug:', JSON.stringify({ decision: terminal?.decision, complete: terminal?.complete, phase: finalOp?.phase }));

  assert.ok(finalOp, 'operation reached a terminal or preview phase');
  assert.ok(['cancelled', 'completed', 'failed'].includes(finalOp.phase),
    `terminal phase persisted (got ${finalOp.phase})`);
}

async function testSocketProtocol() {
  const result = await page.evaluate(() => {
    const authority = game.modules.get('only-war-ai')?.api?.services?.get('authority');
    return {
      hasSocket: typeof game.socket?.emit === 'function',
      sent: authority.sendRequest({ kind: 'e2e-probe' }),
      broadcast: authority.broadcastStatus(),
      status: authority.status(),
      statusText: authority.statusText(),
      isController: authority.isController()
    };
  });
  assert.equal(result.hasSocket, true, 'game.socket available (module.json socket:true)');
  assert.equal(result.sent, true, 'ai-request emitted');
  assert.equal(result.broadcast, true, 'ai-status emitted');
  assert.equal(typeof result.statusText, 'string');
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
    await testAuthorityServicesRegistered();
    await testElectionDeterminism();
    await testClaimTransitionComplete();
    await testAutoClaimOnTurnStart();
    await testSocketProtocol();
    console.log('authority.test.mjs PASSED');
    process.exit(0);
  } catch (err) {
    console.error('authority.test.mjs FAILED:', err);
    try { await h.screenshot(page, 'authority-failure'); } catch { /* ignore */ }
    process.exit(1);
  } finally {
    await cleanup().catch(() => {});
  }
})();
