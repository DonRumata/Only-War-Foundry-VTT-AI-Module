import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import * as h from './lib.mjs';

const names = {
  npc: 'AI Perception NPC',
  openTarget: 'AI Perception Open Target',
  walledTarget: 'AI Perception Walled Target',
  hiddenTarget: 'AI Perception Hidden Target'
};

let page;
let browser;
let npcId;
let openId;
let walledId;
let hiddenId;
let sceneId;
let npcTokenId;
let openTokenId;
let walledTokenId;
let hiddenTokenId;
let combatId;
let npcCombatantId;

async function setup() {
  browser = await chromium.connectOverCDP(h.CDP_URL);
  page = await h.getPage(browser);
  await h.ensureJoinedGame(page);
  console.log('Connected to Foundry game session');

  npcId = await h.createTestActor(page, 'npc', names.npc);
  openId = await h.createTestActor(page, 'npc', names.openTarget);
  walledId = await h.createTestActor(page, 'npc', names.walledTarget);
  hiddenId = await h.createTestActor(page, 'npc', names.hiddenTarget);
  sceneId = await h.createTestScene(page);

  const ids = await page.evaluate(async (data) => {
    const scene = game.scenes.get(data.sceneId);
    const mk = async (actorId, x, y, disposition, extra = {}) => {
      const actor = game.actors.get(actorId);
      const proto = actor.prototypeToken.toObject();
      delete proto._id;
      const [token] = await scene.createEmbeddedDocuments('Token', [{
        ...proto,
        actorId: actor.id,
        actorLink: false,
        x, y,
        disposition,
        sight: { enabled: true, range: 200, visionMode: 'basic' },
        ...extra
      }]);
      return token.id;
    };
    const npc = await mk(data.npcId, 500, 500, -1);
    const open = await mk(data.openId, 1100, 500, 1);
    const walled = await mk(data.walledId, 1700, 500, 1);
    const hidden = await mk(data.hiddenId, 700, 500, 1, { hidden: true });
    // A full-height wall segment between the open/walled columns.
    await scene.createEmbeddedDocuments('Wall', [{ c: [1400, 300, 1400, 700] }]);
    return { npc, open, walled, hidden };
  }, { sceneId, npcId, openId, walledId, hiddenId });
  npcTokenId = ids.npc;
  openTokenId = ids.open;
  walledTokenId = ids.walled;
  hiddenTokenId = ids.hidden;

  combatId = await h.createCombat(page, [npcTokenId, openTokenId, walledTokenId, hiddenTokenId]);
  npcCombatantId = await page.evaluate((tid) =>
    game.combat?.combatants?.find((c) => c.tokenId === tid)?.id ?? null, npcTokenId);
  assert.ok(npcCombatantId, 'combatant created for the NPC token');
}

async function testServiceRegistered() {
  const info = await page.evaluate(() => {
    const api = game.modules.get('only-war-ai')?.api;
    const perception = api?.services?.get?.('perception');
    return {
      registered: !!perception,
      capabilities: api?.capabilities ?? {},
      methods: perception ? {
        los: typeof perception.hasLineOfSight,
        targets: typeof perception.visibleTargets,
        snapshot: typeof perception.buildPerceptionSnapshot,
        remember: typeof perception.rememberPositions,
        lastKnown: typeof perception.lastKnownPositions,
        expire: typeof perception.expireMemory,
        score: typeof perception.scoreTarget
      } : null
    };
  });
  assert.equal(info.registered, true, 'perception service registered on api.services');
  assert.equal(info.capabilities['perception.snapshot'], true);
  assert.equal(info.capabilities['perception.memory'], true);
  assert.equal(info.capabilities['perception.targets'], true);
  for (const [name, type] of Object.entries(info.methods)) {
    assert.equal(type, 'function', `perception.${name} exposed`);
  }
}

async function testLineOfSightAndTargets() {
  const result = await page.evaluate((data) => {
    const perception = game.modules.get('only-war-ai')?.api?.services?.get?.('perception');
    const npc = canvas.tokens.get(data.npcTokenId);
    const open = canvas.tokens.get(data.openTokenId);
    const walled = canvas.tokens.get(data.walledTokenId);
    const hidden = canvas.tokens.get(data.hiddenTokenId);
    const targets = perception.visibleTargets(npc);
    return {
      losOpen: perception.hasLineOfSight(npc, open),
      losWalled: perception.hasLineOfSight(npc, walled),
      ids: targets.map((t) => t.tokenId),
      hiddenInTargets: targets.some((t) => t.tokenId === data.hiddenTokenId),
      targetFields: targets[0] ? Object.keys(targets[0]).sort() : [],
      hiddenDoc: hidden?.document?.hidden === true
    };
  }, { npcTokenId, openTokenId, walledTokenId, hiddenTokenId });

  assert.equal(result.losOpen, true, 'open target has line of sight');
  assert.equal(result.losWalled, false, 'wall blocks line of sight');
  assert.deepEqual(result.ids, [openTokenId], 'only the visible hostile target is listed');
  assert.equal(result.hiddenInTargets, false, 'hidden token never leaks to targets');
  assert.equal(result.hiddenDoc, true);
  for (const field of ['tokenId', 'tokenUuid', 'distance', 'disposition', 'canAttack']) {
    assert.ok(result.targetFields.includes(field), `target entry carries ${field}`);
  }
}

async function testMemoryLifecycle() {
  // Record the open target, then move it behind the wall: the position must
  // survive only as a sanitized last-known entry.
  const first = await page.evaluate(async (data) => {
    const perception = game.modules.get('only-war-ai')?.api?.services?.get?.('perception');
    const combat = game.combats.get(data.combatId);
    const combatant = combat.combatants.get(data.combatantId);
    await combat.update({ round: 1, turn: 0 });
    const memory = await perception.rememberPositions(combat, combatant);
    const rawStored = combatant.getFlag('only-war-ai', 'memory');
    // Storage shape is an array of {tokenUuid, ...} (uuid keys with dots
    // cannot be stored as a bare flag object).
    const stored = Array.isArray(rawStored)
      ? rawStored.map((e) => e?.tokenUuid)
      : Object.keys(rawStored ?? {});
    const npc = canvas.tokens.get(data.npcTokenId);
    const snapshot = perception.buildPerceptionSnapshot({ combat, combatant, token: npc });
    return {
      memoryKeys: Object.keys(memory),
      storedKeys: stored,
      snapshotVisible: snapshot.visibleTargets.map((t) => t.tokenId),
      snapshotKnown: snapshot.lastKnownTargets.map((t) => t.tokenUuid),
      snapshotStatus: snapshot.status,
      isGM: game.user.isGM === true
    };
  }, { combatId, combatantId: npcCombatantId, npcTokenId });

  assert.equal(first.snapshotStatus, 'ok');
  assert.deepEqual(first.snapshotVisible, [openTokenId]);
  const openUuid = `Scene.${sceneId}.Token.${openTokenId}`;
  assert.ok(first.memoryKeys.includes(openUuid), 'visible contact remembered');
  if (first.isGM) {
    assert.deepEqual(first.storedKeys, first.memoryKeys, 'memory persisted by GM controller');
  }

  // Target relocates behind the wall: no LOS → last-known only, no attack.
  const second = await page.evaluate(async (data) => {
    const perception = game.modules.get('only-war-ai')?.api?.services?.get?.('perception');
    const tokenDoc = canvas.scene.tokens.get(data.openTokenId);
    await tokenDoc.update({ x: 1700, y: 400 }, { animate: false });
    const combat = game.combats.get(data.combatId);
    const combatant = combat.combatants.get(data.combatantId);
    const npc = canvas.tokens.get(data.npcTokenId);
    const snapshot = perception.buildPerceptionSnapshot({ combat, combatant, token: npc });
    const known = perception.lastKnownPositions(combatant);
    return {
      visible: snapshot.visibleTargets.map((t) => t.tokenId),
      lastKnown: snapshot.lastKnownTargets,
      knownFields: known[0] ? Object.keys(known[0]).sort() : []
    };
  }, { combatId, combatantId: npcCombatantId, npcTokenId, openTokenId });

  assert.deepEqual(second.visible, [], 'relocated hidden target is not visible');
  assert.equal(second.lastKnown.length, 1, 'last-known contact survives');
  assert.equal(second.lastKnown[0].tokenUuid, openUuid);
  // Sanitized contract: no actor stats, no current hidden coordinates.
  const expectedKeys = [
    'dispositionAtDetection', 'elevation', 'firstSeenRound', 'lastSeenRound',
    'lastSeenTurn', 'sceneId', 'tokenUuid', 'x', 'y'
  ];
  assert.deepEqual(Object.keys(second.lastKnown[0]).sort(), expectedKeys);
  assert.deepEqual(second.knownFields, expectedKeys);
  assert.equal(second.lastKnown[0].firstSeenRound, 1, 'initial sighting is preserved');
  assert.notEqual(second.lastKnown[0].x, 1750, 'stale position, not the live one');

  // Expiry: entry seen in round 1 survives rounds ≤4, forgotten at round 5.
  const third = await page.evaluate(async (data) => {
    const perception = game.modules.get('only-war-ai')?.api?.services?.get?.('perception');
    const combat = game.combats.get(data.combatId);
    const combatant = combat.combatants.get(data.combatantId);
    await combat.update({ round: 4 });
    const kept = await perception.expireMemory(combat, 4);
    const afterFour = combatant.getFlag('only-war-ai', 'memory') ?? {};
    await combat.update({ round: 5 });
    const dropped = await perception.expireMemory(combat, 5);
    const afterFive = combatant.getFlag('only-war-ai', 'memory') ?? {};
    return { kept, dropped, afterFour: Object.keys(afterFour), afterFive: Object.keys(afterFive) };
  }, { combatId, combatantId: npcCombatantId });

  assert.equal(third.kept, 0, 'entry survives through three full rounds');
  assert.equal(third.afterFour.length, 1);
  assert.equal(third.dropped, 1, 'entry forgotten after three full rounds');
  assert.deepEqual(third.afterFive, []);
}

async function testScoreDeterminism() {
  const result = await page.evaluate(() => {
    const perception = game.modules.get('only-war-ai')?.api?.services?.get?.('perception');
    const npc = { range: 30, damage: 10, penetration: 5 };
    const target = { tokenId: 't1', distance: 15, threat: 8, armour: 4, canAttack: true };
    const a = perception.scoreTarget(npc, target);
    const b = perception.scoreTarget(npc, target);
    const blocked = perception.scoreTarget(npc, { ...target, canAttack: false });
    return { a: a.score, b: b.score, blocked: blocked.score };
  });
  assert.equal(result.a, result.b, 'scoreTarget is deterministic');
  assert.ok(result.blocked < result.a, 'non-attackable target ranks lower');
}

async function cleanup() {
  await h.closeAllWindows(page);
  if (combatId) await h.deleteCombat(page, combatId);
  if (sceneId) await h.deleteScene(page, sceneId);
  for (const actorId of [npcId, openId, walledId, hiddenId]) {
    if (actorId) await h.deleteActor(page, actorId);
  }
}

(async () => {
  try {
    await setup();
    await testServiceRegistered();
    await testLineOfSightAndTargets();
    await testMemoryLifecycle();
    await testScoreDeterminism();
    console.log('perception.test.mjs PASSED');
  } catch (err) {
    console.error('perception.test.mjs FAILED:', err);
    try { await h.screenshot(page, 'perception-failure'); } catch { /* ignore */ }
    process.exitCode = 1;
  } finally {
    await cleanup().catch(() => {});
  }
  process.exit(process.exitCode ?? 0);
})();
