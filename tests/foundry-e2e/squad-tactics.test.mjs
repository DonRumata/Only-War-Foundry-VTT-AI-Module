import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import * as h from './lib.mjs';

const names = {
  leader: 'AI Squad Leader',
  support: 'AI Squad Support',
  flanker: 'AI Squad Flanker',
  enemy: 'AI Squad Enemy'
};

let page;
let browser;
let actorIds = [];
let sceneId;
let tokenIds = {};
let combatId;
let combatantIds = [];

async function setup() {
  browser = await chromium.connectOverCDP(h.CDP_URL);
  page = await h.getPage(browser);
  await h.ensureJoinedGame(page);

  console.log('Connected to Foundry game session');

  for (const name of [names.leader, names.support, names.flanker, names.enemy]) {
    actorIds.push(await h.createTestActor(page, 'npc', name));
  }
  sceneId = await h.createTestScene(page);
  tokenIds.leader = await h.placeToken(page, sceneId, actorIds[0], { x: 400, y: 400 });
  tokenIds.support = await h.placeToken(page, sceneId, actorIds[1], { x: 500, y: 400 });
  tokenIds.flanker = await h.placeToken(page, sceneId, actorIds[2], { x: 400, y: 500 });
  tokenIds.enemy = await h.placeToken(page, sceneId, actorIds[3], { x: 1500, y: 400 });

  combatId = await h.createCombat(
    page, [tokenIds.leader, tokenIds.support, tokenIds.flanker, tokenIds.enemy]);

  // Enable AI + fireteam alpha on the three squad members.
  combatantIds = await page.evaluate(async (tids) => {
    const ids = [];
    for (const tid of tids) {
      const combatant = game.combat?.combatants?.find((c) => c.tokenId === tid);
      if (!combatant) return null;
      await combatant.setFlag('only-war-ai', 'override', { mode: 'enabled', preset: 'assault' });
      await combatant.setFlag('only-war-ai', 'fireteam', { teamId: 'alpha' });
      ids.push(combatant.id);
    }
    return ids;
  }, [tokenIds.leader, tokenIds.support, tokenIds.flanker]);
  assert.ok(combatantIds && combatantIds.length === 3, 'three npc combatants in team alpha');
}

async function testSharedContacts() {
  // The support member remembers the enemy token; the leader does not.
  const shared = await page.evaluate(async ({ sceneId, enemyTokenId, supportCid, leaderCid }) => {
    const api = game.modules.get('only-war-ai')?.api;
    const perception = api?.services?.get('perception');
    const support = game.combat.combatants.get(supportCid);
    const leader = game.combat.combatants.get(leaderCid);
    const tokenUuid = `Scene.${sceneId}.Token.${enemyTokenId}`;
    await support.setFlag('only-war-ai', 'memory', [{
      tokenUuid,
      sceneId,
      x: 1500,
      y: 400,
      elevation: 0,
      lastSeenRound: game.combat.round,
      lastSeenTurn: game.combat.turn ?? 0,
      dispositionAtDetection: -1
    }]);
    const contacts = perception.teamLastKnownPositions(game.combat, leader, 'alpha');
    // Member contexts see the merged list during buildTeamPlan — spy the
    // planner to capture what every member actually received.
    const planner = api.services.get('planner');
    const fireteam = api.services.get('fireteam');
    const seen = {};
    const inner = planner.planTurn.bind(planner);
    planner.planTurn = async (combat, combatant, context) => {
      seen[combatant.id] = (context.team?.contacts ?? [])
        .map((c) => c.tokenUuid);
      return inner(combat, combatant, context);
    };
    try {
      await fireteam.buildTeamPlan(game.combat, { teamId: 'alpha' }, { seed: 7 });
    } finally {
      planner.planTurn = inner;
    }
    return {
      contacts: JSON.parse(JSON.stringify(contacts)),
      seen,
      tokenUuid
    };
  }, {
    sceneId,
    enemyTokenId: tokenIds.enemy,
    supportCid: combatantIds[1],
    leaderCid: combatantIds[0]
  });

  const contact = shared.contacts.find((c) => c.tokenUuid === shared.tokenUuid);
  assert.ok(contact, 'shared contact propagates through teamLastKnownPositions');
  assert.equal(contact.sourceCombatantId, combatantIds[1],
    'provenance marks the support member as the source');
  // Every member context received the identical merged contact list.
  for (const cid of combatantIds) {
    assert.ok(shared.seen[cid]?.includes(shared.tokenUuid),
      `member ${cid} received the shared contact`);
  }
}

async function testSyncDelay() {
  // A stubbed member planner makes the flank plan move-only (transit,
  // ETA ≥ 1 turn) and main members strike the shared target — the
  // post-pass must delay them until the flank is in position.
  const delayed = await page.evaluate(async ({ enemyTokenId, flankerCid, leaderCid, supportCid }) => {
    const api = game.modules.get('only-war-ai')?.api;
    const fireteam = api?.services?.get('fireteam');
    const stubPlanner = {
      planTurn: async (combat, combatant) => {
        const isFlanker = combatant.id === flankerCid;
        const plan = {
          id: `plan-${combatant.id}`,
          score: 1,
          target: isFlanker ? null : { tokenId: enemyTokenId },
          snapshot: { targets: [] },
          steps: isFlanker
            ? [
              { id: 'step-move-1', type: 'move', input: { to: { x: 500, y: 500 }, waypoints: [] } },
              { id: 'step-end-turn-2', type: 'end-turn', input: {} }
            ]
            : [
              { id: 'step-attack-1', type: 'attack', input: { targetTokenId: enemyTokenId } },
              { id: 'step-end-turn-2', type: 'end-turn', input: {} }
            ]
        };
        return { status: 'ok', plan, reason: null };
      }
    };
    const result = await fireteam.buildTeamPlan(game.combat, {
      teamId: 'alpha',
      leaderId: leaderCid
    }, {
      seed: 9,
      planner: stubPlanner,
      allowFlank: true,
      assignments: {
        [leaderCid]: 'assault',
        [supportCid]: 'support',
        [flankerCid]: 'flank'
      },
      targets: [{ tokenId: enemyTokenId, x: 1500, y: 400, wounds: 5 }]
    });
    return JSON.parse(JSON.stringify(result));
  }, {
    enemyTokenId: tokenIds.enemy,
    flankerCid: combatantIds[2],
    leaderCid: combatantIds[0],
    supportCid: combatantIds[1]
  });

  assert.equal(delayed.status, 'ok', `buildTeamPlan status ${delayed.status}`);
  const plan = delayed.teamPlan;
  assert.ok(plan.convergence, 'convergent objective present');
  const delayedMembers = plan.members.filter((m) => m.delayed);
  assert.ok(delayedMembers.length >= 1, 'main members delayed for the sync');
  for (const entry of delayedMembers) {
    assert.equal(entry.delayed.reason, 'await-sync');
    assert.equal(entry.delayed.until, 'flank-ready');
    assert.equal(entry.delayed.awaitId, combatantIds[2]);
    const steps = plan.memberPlans[entry.combatantId].steps;
    assert.equal(steps[0].type, 'delay', 'delay step heads the stub plan');
    assert.equal(steps[0].input.until, 'flank-ready');
    assert.equal(steps.at(-1).type, 'end-turn');
  }
  // The transit flanker itself is never delayed.
  assert.equal(
    plan.members.find((m) => m.combatantId === combatantIds[2]).delayed, null);

  // Executor: a delay step writes the system `delayed` flag (the tracker
  // state that expires on the combatant's next turn) plus the module
  // `delaySync` bookkeeping record.
  const executed = await page.evaluate(async (supportCid) => {
    const api = game.modules.get('only-war-ai')?.api;
    const executor = api?.services?.get('executor');
    const planner = api?.services?.get('planner');
    const combatant = game.combat.combatants.get(supportCid);
    const planned = await planner.planTurn(game.combat, combatant, { seed: 3 });
    const plan = JSON.parse(JSON.stringify(planned.plan ?? { id: 'p', snapshot: null }));
    plan.steps = [
      {
        id: 'step-delay-1',
        type: 'delay',
        cost: { halves: 2 },
        input: {
          reason: 'await-sync',
          until: 'flank-ready',
          teamId: 'alpha',
          round: game.combat.round
        },
        preconditions: ['turn'],
        projectedResourceDelta: {}
      },
      {
        id: 'step-end-turn-2',
        type: 'end-turn',
        cost: {},
        input: { reason: 'await-sync' },
        preconditions: ['turn'],
        projectedResourceDelta: {}
      }
    ];
    const result = await executor.executePlan(plan, {
      combat: game.combat,
      combatant,
      operationId: 'e2e-squad-delay-1'
    });
    return {
      status: result.status,
      delayed: combatant.getFlag('only-war-local', 'delayed') ?? null,
      delaySync: JSON.parse(JSON.stringify(
        combatant.getFlag('only-war-ai', 'delaySync') ?? null))
    };
  }, combatantIds[1]);

  assert.equal(executed.status, 'completed', `delay plan executed: ${executed.status}`);
  assert.equal(executed.delayed, true,
    'system delayed flag written through the system namespace');
  assert.equal(executed.delaySync?.until, 'flank-ready');
  assert.equal(executed.delaySync?.count, 1);

  // The system tracker clears `delayed` when the combatant's next turn
  // begins — replicate the system's clearExpiredStates contract so the
  // flag never lingers across turns.
  await page.evaluate(async (supportCid) => {
    const combatant = game.combat.combatants.get(supportCid);
    await combatant.unsetFlag('only-war-local', 'delayed');
    await combatant.unsetFlag('only-war-ai', 'delaySync');
  }, combatantIds[1]);
}

async function testLeaderOrder() {
  // The leader owns an order and the command skill — buildTeamPlan must
  // offer it the orderCandidate, and the executor must stamp lastOrder
  // after the order test lands.
  const ordered = await page.evaluate(async ({ leaderCid, supportCid, flankerCid, leaderActorId }) => {
    const api = game.modules.get('only-war-ai')?.api;
    const fireteam = api?.services?.get('fireteam');
    const actor = game.actors.get(leaderActorId);
    await actor.createEmbeddedDocuments('Item', [{
      name: 'Fire on my target',
      type: 'order',
      system: { orderType: 'basic', benefit: '+10 BS' }
    }]);
    const hasCommand = actor.system?.skills?.command != null;
    const result = await fireteam.buildTeamPlan(game.combat, {
      teamId: 'alpha',
      leaderId: leaderCid
    }, {
      seed: 11,
      // No targets injected: the order competes against an empty hold,
      // which it always outranks for a leader.
      targets: []
    });
    return {
      hasCommand,
      leaderPlan: JSON.parse(JSON.stringify(
        result.teamPlan?.memberPlans?.[leaderCid] ?? null)),
      status: result.status
    };
  }, {
    leaderCid: combatantIds[0],
    supportCid: combatantIds[1],
    flankerCid: combatantIds[2],
    leaderActorId: actorIds[0]
  });

  assert.equal(ordered.status, 'ok');
  assert.equal(ordered.hasCommand, true, 'npc actor exposes the command skill');
  const orderStep = (ordered.leaderPlan?.steps ?? [])
    .find((step) => step?.input?.orderId);
  assert.ok(orderStep, 'leader plan carries an order test step');
  assert.equal(orderStep.type, 'test');
  assert.equal(orderStep.input.key, 'command');
  assert.equal(orderStep.input.flags?.isOrder, true);
  assert.equal(orderStep.input.name, 'Fire on my target');

  // Execute the order step through the real system roll pipeline —
  // `lastOrder` lands only on success.
  const executed = await page.evaluate(async (leaderCid) => {
    const api = game.modules.get('only-war-ai')?.api;
    const executor = api?.services?.get('executor');
    const planner = api?.services?.get('planner');
    const combatant = game.combat.combatants.get(leaderCid);
    const planned = await planner.planTurn(game.combat, combatant, {
      seed: 4,
      targets: [],
      team: {
        teamId: 'alpha',
        orderCandidate: {
          orderId: 'e2e-order-1',
          name: 'Fire on my target',
          orderType: 'basic',
          benefit: '+10 BS',
          skill: 'command',
          advanced: false
        }
      }
    });
    const plan = JSON.parse(JSON.stringify(planned.plan));
    const result = await executor.executePlan(plan, {
      combat: game.combat,
      combatant,
      operationId: 'e2e-squad-order-1'
    });
    return {
      status: result.status,
      lastOrder: JSON.parse(JSON.stringify(
        combatant.getFlag('only-war-ai', 'lastOrder') ?? null)),
      plannedSteps: plan.steps.map((s) => s.type)
    };
  }, combatantIds[0]);

  assert.equal(executed.plannedSteps.includes('test'), true,
    'planned order serializes as a test step');
  assert.equal(executed.status, 'completed', `order plan executed: ${executed.status}`);
  assert.ok(executed.lastOrder, 'lastOrder stamped after a successful order');
  assert.equal(executed.lastOrder.round, await page.evaluate(() => game.combat.round));
  assert.equal(executed.lastOrder.result, 'success');

  // Cooldown: a fresh lastOrder suppresses a new orderCandidate.
  const cooled = await page.evaluate(async ({ leaderCid }) => {
    const api = game.modules.get('only-war-ai')?.api;
    const fireteam = api?.services?.get('fireteam');
    const planner = api?.services?.get('planner');
    const seen = {};
    const inner = planner.planTurn.bind(planner);
    planner.planTurn = async (combat, combatant, context) => {
      seen[combatant.id] = context.team?.orderCandidate ?? null;
      return inner(combat, combatant, context);
    };
    try {
      await fireteam.buildTeamPlan(game.combat, { teamId: 'alpha' }, { seed: 12 });
    } finally {
      planner.planTurn = inner;
    }
    return seen;
  }, { leaderCid: combatantIds[0] });
  assert.equal(cooled[combatantIds[0]] ?? null, null,
    'ORDER_COOLDOWN_ROUNDS suppresses a new orderCandidate');
}

async function cleanup() {
  await h.closeAllWindows(page);
  if (combatId) await h.deleteCombat(page, combatId);
  if (sceneId) await h.deleteScene(page, sceneId);
  for (const id of actorIds) await h.deleteActor(page, id);
}

(async () => {
  try {
    await setup();
    await testSharedContacts();
    await testSyncDelay();
    await testLeaderOrder();
    console.log('squad-tactics.test.mjs PASSED');
    process.exit(0);
  } catch (err) {
    console.error('squad-tactics.test.mjs FAILED:', err);
    try { await h.screenshot(page, 'squad-tactics-failure'); } catch { /* ignore */ }
    try { await cleanup(); } catch { /* ignore */ }
    process.exit(1);
  }
})();
