/**
 * Unit tests for the comms-net shared vision (smoke finding): combatants
 * flagged with a common `commsNet` id exchange last-known contacts with
 * a radio delay — distant squads advance on relayed intel instead of
 * holding position forever, without an instant whole-faction dogpile.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { FLAG_KEYS, MODULE_ID } from "../../scripts/constants.js";
import { createPerceptionService } from "../../scripts/perception.js";
import {
    PLANNER_STATUS,
    createPlannerService
} from "../../scripts/planner.js";
import { registerAssaultPreset } from "../../scripts/presets/assault.js";
import {
    makeActor,
    makeCombatant,
    makeScene,
    makeToken
} from "./fixtures.mjs";

let _combatId = 0;

/**
 * Minimal Combat fixture matching the planner tests.
 * @param {object} [options]
 * @returns {object}
 */
function makeFight({ round = 1, turn = 0, combatants = [] } = {}) {
    const collection = new Map(combatants.map(c => [c.id, c]));
    collection.contents = combatants;
    return {
        documentName: "Combat",
        id: `combat-${++_combatId}`,
        round,
        turn,
        combatants: collection,
        turns: combatants,
        scene: null,
        ended: false
    };
}

/**
 * Attach a memory record to a combatant fixture.
 * @param {object} combatant
 * @param {object} memory `{tokenUuid: entry}` map.
 * @returns {object}
 */
function withMemory(combatant, memory) {
    combatant.flags[MODULE_ID] = combatant.flags[MODULE_ID] ?? {};
    combatant.flags[MODULE_ID][FLAG_KEYS.memory] = memory;
    return combatant;
}

/**
 * Attach a comms-net flag to a combatant fixture.
 * @param {object} combatant
 * @param {string} netId
 * @returns {object}
 */
function withCommsNet(combatant, netId) {
    combatant.flags[MODULE_ID] = combatant.flags[MODULE_ID] ?? {};
    combatant.flags[MODULE_ID][FLAG_KEYS.commsNet] = netId;
    return combatant;
}

/** Memory entry helper. */
function mem(x, y, { sceneId = "scene-1", lastSeenRound = 1, lastSeenTurn = 0 } = {}) {
    return {
        sceneId,
        x,
        y,
        elevation: 0,
        lastSeenRound,
        lastSeenTurn,
        dispositionAtDetection: 1
    };
}

/**
 * Net world: AI members on a `commsNet` plus a hostile on a square scene.
 * @param {object[]} members
 * @param {object} [options]
 * @returns {object}
 */
function makeNetWorld(members, { round = 1 } = {}) {
    const scene = makeScene({ grid: "square" });
    const enemyActor = makeActor();
    enemyActor.system = { wounds: { value: 0, max: 10 } };
    enemyActor.items = [];
    const enemyToken = makeToken({ actor: enemyActor });
    enemyToken.disposition = 1;
    const enemy = makeCombatant({ actor: enemyActor, token: enemyToken });
    enemy.tokenId = enemyToken.id;
    const combat = makeFight({
        round,
        turn: 0,
        combatants: [...members.map(m => m.combatant), enemy]
    });
    combat.scene = scene;
    return { scene, combat, enemy, enemyToken };
}

/**
 * An AI-enabled combatant fixture on a net.
 * @param {object} [options]
 * @returns {object}
 */
function makeNetMember({ netId = null, defeated = false } = {}) {
    const actor = makeActor({ enabled: true, preset: "assault" });
    actor.system = { wounds: { value: 10, max: 14 } };
    actor.items = [];
    const token = makeToken({ actor });
    token.elevation = 0;
    token.disposition = -1;
    const combatant = makeCombatant({ actor, token });
    combatant.tokenId = token.id;
    combatant.defeated = defeated;
    if (netId) withCommsNet(combatant, netId);
    return { combatant, token, actor };
}

/* ------------------------------------------------------------------ */
/* netLastKnownPositions                                               */
/* ------------------------------------------------------------------ */

test("netLastKnownPositions shares only within the same net and marks relay", () => {
    const listener = makeNetMember({ netId: "defense" });
    const relay = makeNetMember({ netId: "defense" });
    const foreign = makeNetMember({ netId: "assault" });
    const dead = makeNetMember({ netId: "defense", defeated: true });
    const noNet = makeNetMember();
    const world = makeNetWorld([listener, relay, foreign, dead, noNet], { round: 5 });
    const sceneId = world.scene.id;
    withMemory(relay.combatant, {
        [`Scene.${sceneId}.Token.e1`]: mem(3, 3, { sceneId, lastSeenRound: 4 })
    });
    withMemory(foreign.combatant, {
        [`Scene.${sceneId}.Token.e2`]: mem(5, 5, { sceneId, lastSeenRound: 4 })
    });
    withMemory(dead.combatant, {
        [`Scene.${sceneId}.Token.e3`]: mem(7, 7, { sceneId, lastSeenRound: 4 })
    });
    withMemory(noNet.combatant, {
        [`Scene.${sceneId}.Token.e4`]: mem(9, 9, { sceneId, lastSeenRound: 4 })
    });
    const perception = createPerceptionService();
    const shared = perception.netLastKnownPositions(
        world.combat, listener.combatant, "defense", 1);
    const uuids = shared.map(entry => entry.tokenUuid);
    // Issue #69: a defeated member still relays its memory — the "last
    // transmission" decays only via the normal entry TTL. Foreign nets
    // and netless combatants never propagate.
    assert.deepEqual(uuids, [
        `Scene.${sceneId}.Token.e1`, `Scene.${sceneId}.Token.e3`]);
    assert.equal(shared[0].sourceCombatantId, relay.combatant.id);
    assert.equal(shared[0].relay, true);
    assert.equal(shared[1].sourceCombatantId, dead.combatant.id);
    assert.equal(shared[1].relay, true);
});

test("netLastKnownPositions delay withholds fresh sightings for one round", () => {
    const listener = makeNetMember({ netId: "defense" });
    const relay = makeNetMember({ netId: "defense" });
    const world = makeNetWorld([listener, relay], { round: 5 });
    const sceneId = world.scene.id;
    withMemory(relay.combatant, {
        [`Scene.${sceneId}.Token.fresh`]: mem(1, 1, { sceneId, lastSeenRound: 5 }),
        [`Scene.${sceneId}.Token.aged`]: mem(2, 2, { sceneId, lastSeenRound: 4 })
    });
    const perception = createPerceptionService();
    const shared = perception.netLastKnownPositions(
        world.combat, listener.combatant, "defense", 1);
    const uuids = shared.map(entry => entry.tokenUuid);
    // The round-5 sighting is still on the radio; the round-4 one has
    // already propagated — the net spreads contacts turn-by-turn.
    assert.deepEqual(uuids, [`Scene.${sceneId}.Token.aged`]);
    // Zero delay broadcasts everything immediately.
    const instant = perception.netLastKnownPositions(
        world.combat, listener.combatant, "defense", 0);
    assert.equal(instant.length, 2);
});

test("netLastKnownPositions keeps own sightings and merges by freshness", () => {
    const listener = makeNetMember({ netId: "defense" });
    const relay = makeNetMember({ netId: "defense" });
    const world = makeNetWorld([listener, relay], { round: 6 });
    const sceneId = world.scene.id;
    withMemory(listener.combatant, {
        [`Scene.${sceneId}.Token.e1`]: mem(1, 1, { sceneId, lastSeenRound: 4 })
    });
    withMemory(relay.combatant, {
        [`Scene.${sceneId}.Token.e1`]: mem(9, 9, { sceneId, lastSeenRound: 5 })
    });
    const perception = createPerceptionService();
    const shared = perception.netLastKnownPositions(
        world.combat, listener.combatant, "defense", 1);
    assert.equal(shared.length, 1);
    // The strictly fresher teammate sighting replaces the stale own one.
    assert.equal(shared[0].x, 9);
    assert.equal(shared[0].relay, true);
});

/* ------------------------------------------------------------------ */
/* planner: relayed contacts                                           */
/* ------------------------------------------------------------------ */

test("planTurn advances on a relayed net contact without attacking it", async () => {
    const member = makeNetMember({ netId: "defense" });
    const world = makeNetWorld([member]);
    const planner = createPlannerService();
    registerAssaultPreset(planner);
    const relayContact = {
        tokenId: "ghost-e1",
        tokenUuid: "Scene.x.Token.ghost-e1",
        x: 300,
        y: 0,
        elevation: 0,
        lastSeenRound: 2,
        lastSeenTurn: 0,
        sourceCombatantId: "c-relay",
        relay: true
    };
    const perception = {
        buildPerceptionSnapshot: () => ({
            status: "ok",
            visibleTargets: [],
            lastKnownTargets: [],
            revision: "r"
        }),
        netLastKnownPositions: () => [relayContact]
    };
    const result = await planner.planTurn(world.combat, member.combatant, {
        seed: 1,
        perception,
        commsNet: "defense",
        actions: [{
            id: "lasgun", type: "attack", name: "Lasgun",
            itemUuid: "Actor.x.Item.w1", itemId: "w1",
            class: "ranged", range: 100
        }],
        moves: [{ x: 100, y: 0, distance: 1.5, cost: 2 }]
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const target = result.plan.snapshot.targets
        .find(t => t.tokenUuid === relayContact.tokenUuid);
    // Relayed intel is a memory target: it steers the bot but never
    // yields a direct attack against it (a live fallback combatant may
    // still legitimately draw the attack).
    assert.equal(target.source, "relay");
    assert.equal(target.canAttack, false);
    assert.equal(result.plan.steps[0].type, "move");
});

test("planTurn without a commsNet flag never sees net contacts", async () => {
    const member = makeNetMember();
    const world = makeNetWorld([member]);
    const planner = createPlannerService();
    registerAssaultPreset(planner);
    const perception = {
        buildPerceptionSnapshot: () => ({
            status: "ok",
            visibleTargets: [],
            lastKnownTargets: [],
            revision: "r"
        }),
        netLastKnownPositions: () => [{
            tokenUuid: "relay-uuid", x: 5, y: 5, lastSeenRound: 1,
            sourceCombatantId: "c-relay", relay: true
        }]
    };
    const result = await planner.planTurn(world.combat, member.combatant, {
        seed: 1,
        perception,
        actions: [],
        moves: [{ x: 100, y: 0, distance: 1.5, cost: 2 }]
    });
    // Netless combatant: the relayed contact never surfaces.
    assert.equal(
        result.plan.snapshot.targets.find(t => t.tokenUuid === "relay-uuid"),
        undefined);
    // shareContacts:false seals the net for a flagged member too.
    const flagged = makeNetMember({ netId: "defense" });
    const sealed = await planner.planTurn(world.combat, flagged.combatant, {
        seed: 1,
        perception,
        actions: [],
        moves: [{ x: 100, y: 0, distance: 1.5, cost: 2 }],
        team: { shareContacts: false }
    });
    assert.equal(
        sealed.plan.snapshot.targets.find(t => t.tokenUuid === "relay-uuid"),
        undefined);
});
