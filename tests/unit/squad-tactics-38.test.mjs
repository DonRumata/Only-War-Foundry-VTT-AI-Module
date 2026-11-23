/**
 * Unit tests for issue #38 squad tactics: shared squad contacts
 * (`mergeTeamMemory`/`teamLastKnownPositions`/`team-contact` targets),
 * the synchronized-strike `delay` step (`_syncDelay` post-pass, system
 * `delayed` flag, `sync-broken`, `maxSyncRounds`) and leader orders
 * (`orderCandidate`, `ORDER_COOLDOWN_ROUNDS`, `lastOrder` post-success,
 * `sergeant_charge` speciality-perk alternative).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    DEFAULT_MAX_SYNC_ROUNDS,
    FLAG_KEYS,
    MODULE_ID,
    ORDER_COOLDOWN_ROUNDS
} from "../../scripts/constants.js";
import {
    buildPerceptionSnapshot,
    createPerceptionService,
    mergeTeamMemory
} from "../../scripts/perception.js";
import {
    PLANNER_STATUS,
    createPlannerService
} from "../../scripts/planner.js";
import { registerAssaultPreset } from "../../scripts/presets/assault.js";
import {
    FIRETEAM_STATUS,
    TEAM_PLAN_REASONS,
    createFireteamService
} from "../../scripts/fireteam.js";
import { createExecutorService } from "../../scripts/executor.js";
import { createModuleApi } from "../../scripts/api.js";
import {
    makeActor,
    makeCombatant,
    makeScene,
    makeToken
} from "./fixtures.mjs";

let _combatId = 0;

/**
 * Minimal Combat fixture matching the planner/fireteam tests.
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
 * Attach a fireteam flag to a fixture document.
 * @param {object} doc
 * @param {object} flag
 * @returns {object}
 */
function withFireteam(doc, flag) {
    doc.flags[MODULE_ID] = doc.flags[MODULE_ID] ?? {};
    doc.flags[MODULE_ID][FLAG_KEYS.fireteam] = flag;
    return doc;
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
 * Build an AI-enabled fireteam member with a lasgun (EV 8.5, range 100).
 * @param {object} [options]
 * @returns {object}
 */
function makeMember({
    fireteam,
    x = 0,
    y = 0,
    initiative = 10,
    wounds = 10,
    preset = "assault",
    defeated = false,
    skills = null,
    items = null,
    memory = null
} = {}) {
    const actor = makeActor({ enabled: true, preset });
    actor.system = {
        wounds: { value: wounds, max: 14 },
        ...(skills ? { skills } : {})
    };
    actor.items = items ?? [{
        id: "w1",
        uuid: `Actor.${actor.id}.Item.w1`,
        name: "Lasgun",
        type: "weapon",
        system: { class: "ranged", range: 100, damage: "1d10+3" }
    }];
    const token = makeToken({ actor });
    token.x = x;
    token.y = y;
    token.elevation = 0;
    token.disposition = -1;
    const combatant = makeCombatant({ actor, token });
    combatant.tokenId = token.id;
    combatant.initiative = initiative;
    combatant.defeated = defeated;
    if (fireteam) withFireteam(combatant, fireteam);
    if (memory) withMemory(combatant, memory);
    return { combatant, token, actor };
}

/**
 * Team world: members plus one hostile enemy on a square scene.
 * @param {object[]} members
 * @param {object} [options]
 * @returns {object}
 */
function makeTeamWorld(members, { enemyX = 2000, enemyY = 0, wounds = 10, round = 1 } = {}) {
    const scene = makeScene({ grid: "square" });
    const enemyActor = makeActor();
    enemyActor.system = { wounds: { value: wounds, max: wounds } };
    enemyActor.items = [];
    const enemyToken = makeToken({ actor: enemyActor });
    enemyToken.x = enemyX;
    enemyToken.y = enemyY;
    enemyToken.elevation = 0;
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
 * Injected target list matching {@link makeTeamWorld}.
 * @param {object} world
 * @returns {object[]}
 */
function targetsOf(world, { wounds = null } = {}) {
    return [{
        tokenId: world.enemyToken.id,
        tokenUuid: `Scene.${world.scene.id}.Token.${world.enemyToken.id}`,
        actorId: world.enemy.actor?.id ?? null,
        x: world.enemyToken.x,
        y: world.enemyToken.y,
        elevation: 0,
        wounds,
        canAttack: true,
        source: "injected"
    }];
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

/* ------------------------------------------------------------------ */
/* A. mergeTeamMemory (pure)                                           */
/* ------------------------------------------------------------------ */

test("mergeTeamMemory dedups by freshness and provenance", () => {
    const own = {
        "u-a": mem(1, 1, { lastSeenRound: 1, lastSeenTurn: 0 }),
        "u-own": mem(5, 5, { lastSeenRound: 2, lastSeenTurn: 1 })
    };
    const teammates = [
        {
            combatantId: "c-beta",
            memory: {
                // Fresher than own → the teammate wins.
                "u-a": mem(9, 9, { lastSeenRound: 2, lastSeenTurn: 0 }),
                "u-b": mem(3, 3, { lastSeenRound: 1, lastSeenTurn: 2 }),
                // Equal timestamp with own → own wins.
                "u-own": mem(7, 7, { lastSeenRound: 2, lastSeenTurn: 1 })
            }
        },
        {
            combatantId: "c-alpha",
            memory: {
                // Equal timestamp with c-beta → lexicographically smaller
                // combatantId ("c-alpha" < "c-beta") wins.
                "u-b": mem(4, 4, { lastSeenRound: 1, lastSeenTurn: 2 })
            }
        }
    ];
    const merged = mergeTeamMemory(own, teammates, 3);
    assert.equal(merged["u-a"].x, 9);
    assert.equal(merged["u-a"].sourceCombatantId, "c-beta");
    assert.equal(merged["u-b"].x, 4);
    assert.equal(merged["u-b"].sourceCombatantId, "c-alpha");
    assert.equal(merged["u-own"].x, 5);
    assert.equal(merged["u-own"].sourceCombatantId, null);
});

test("mergeTeamMemory is deterministic under input order and expires old entries", () => {
    const own = {};
    const teammatesA = [
        { combatantId: "c-2", memory: { "u-1": mem(2, 2, { lastSeenRound: 2 }) } },
        { combatantId: "c-1", memory: { "u-1": mem(1, 1, { lastSeenRound: 2 }), "u-old": mem(0, 0, { lastSeenRound: 0 }) } }
    ];
    const teammatesB = [...teammatesA].reverse();
    const a = mergeTeamMemory(own, teammatesA, 2);
    const b = mergeTeamMemory(own, teammatesB, 2);
    assert.deepEqual(a, b);
    // Equal ts → lexicographic combatantId wins regardless of order.
    assert.equal(a["u-1"].sourceCombatantId, "c-1");
    // Expired teammate entries (older than the 3-round memory age) never
    // surface — the same prune `expireMemoryEntries` applies.
    const stale = mergeTeamMemory(own, teammatesA, 10);
    assert.equal(stale["u-old"], undefined);
    assert.equal(stale["u-1"], undefined);
    const fresh = mergeTeamMemory(own, teammatesA, 5);
    assert.equal(fresh["u-old"], undefined);
    assert.ok(fresh["u-1"], "fresh entries survive the prune");
    // No own memory and no teammates → empty map.
    assert.deepEqual(mergeTeamMemory(null, [], 2), {});
});

/* ------------------------------------------------------------------ */
/* A. buildPerceptionSnapshot team contacts                            */
/* ------------------------------------------------------------------ */

test("buildPerceptionSnapshot marks shared contacts as team-contact", () => {
    const actor = makeActor({ enabled: true });
    const viewer = makeToken({ actor });
    viewer.x = 0;
    viewer.y = 0;
    const combatant = makeCombatant({ actor, token: viewer });
    // Own stale memory of the same token + nothing else.
    withMemory(combatant, {
        "Scene.scene-1.Token.e1": mem(1, 1, { lastSeenRound: 1, lastSeenTurn: 0 })
    });
    const combat = makeFight({ round: 2, combatants: [combatant] });
    // The snapshot requires `canvas.scene` — mock the minimal shape.
    const restoreCanvas = globalThis.canvas;
    globalThis.canvas = {
        scene: {
            id: "scene-1",
            tokens: new Map([["e1", { id: "e1" }], ["e2", { id: "e2" }]])
        },
        tokens: { contents: [] }
    };
    try {
        const snapshot = buildPerceptionSnapshot({
            combat,
            combatant,
            token: viewer,
            teamMemory: {
                "Scene.scene-1.Token.e1": mem(7, 7, { lastSeenRound: 2, lastSeenTurn: 1 }),
                "Scene.scene-1.Token.e2": mem(3, 3, { lastSeenRound: 2, lastSeenTurn: 0 })
            }
        });
        assert.equal(snapshot.status, "ok");
        const e1 = snapshot.lastKnownTargets.find(t => t.tokenUuid.endsWith("e1"));
        const e2 = snapshot.lastKnownTargets.find(t => t.tokenUuid.endsWith("e2"));
        // The strictly fresher team sighting replaces the stale own record.
        assert.equal(e1.source, "team-contact");
        assert.equal(e1.x, 7);
        // A contact only the teammate remembers joins marked the same way.
        assert.equal(e2.source, "team-contact");
        // Equal timestamp keeps the own record (own wins at equal ts).
        const equal = buildPerceptionSnapshot({
            combat,
            combatant,
            token: viewer,
            teamMemory: {
                "Scene.scene-1.Token.e1": mem(9, 9, { lastSeenRound: 1, lastSeenTurn: 0 })
            }
        });
        const ownE1 = equal.lastKnownTargets.find(t => t.tokenUuid.endsWith("e1"));
        assert.notEqual(ownE1.source, "team-contact");
        assert.equal(ownE1.x, 1);
    } finally {
        globalThis.canvas = restoreCanvas;
    }
});

/* ------------------------------------------------------------------ */
/* A. teamLastKnownPositions propagation gate                          */
/* ------------------------------------------------------------------ */

test("teamLastKnownPositions gates dead, disabled and off-scene sources", () => {
    // Members are created before the world so the scene id is patched in.
    const leader = makeMember({ fireteam: { teamId: "alpha" } });
    const alive = makeMember({ fireteam: { teamId: "alpha" } });
    const dead = makeMember({ fireteam: { teamId: "alpha" }, defeated: true });
    const disabled = makeMember({ fireteam: { teamId: "alpha" } });
    disabled.actor.flags[MODULE_ID].config.enabled = false;
    const outsider = makeMember({ fireteam: { teamId: "beta" } });
    const world = makeTeamWorld([leader, alive, dead, disabled, outsider]);
    const sceneId = world.scene.id;
    withMemory(alive.combatant, {
        [`Scene.${sceneId}.Token.e1`]: mem(3, 3, { sceneId, lastSeenRound: 1 })
    });
    withMemory(dead.combatant, {
        [`Scene.${sceneId}.Token.e2`]: mem(4, 4, { sceneId, lastSeenRound: 1 })
    });
    withMemory(disabled.combatant, {
        [`Scene.${sceneId}.Token.e3`]: mem(5, 5, { sceneId, lastSeenRound: 1 })
    });
    withMemory(outsider.combatant, {
        [`Scene.${sceneId}.Token.e4`]: mem(6, 6, { sceneId, lastSeenRound: 1 })
    });
    const perception = createPerceptionService();
    const shared = perception.teamLastKnownPositions(
        world.combat, leader.combatant, "alpha");
    const uuids = shared.map(entry => entry.tokenUuid);
    // Only the living, enabled alpha member shares — dead, disabled and
    // foreign-team sources never propagate.
    assert.deepEqual(uuids, [`Scene.${sceneId}.Token.e1`]);
    assert.equal(shared[0].sourceCombatantId, alive.combatant.id);
});

/* ------------------------------------------------------------------ */
/* A. planner team-contact targets                                     */
/* ------------------------------------------------------------------ */

test("planTurn treats team contacts as memory: approach, never direct attack", async () => {
    const member = makeMember({ fireteam: { teamId: "alpha" } });
    const world = makeTeamWorld([member], { enemyX: 300 });
    const planner = createPlannerService();
    registerAssaultPreset(planner);
    const teamContact = {
        tokenId: world.enemyToken.id,
        tokenUuid: `Scene.${world.scene.id}.Token.${world.enemyToken.id}`,
        x: world.enemyToken.x,
        y: world.enemyToken.y,
        elevation: 0,
        lastSeenRound: 1,
        lastSeenTurn: 0,
        sourceCombatantId: "c-teammate",
        source: "team-contact"
    };
    const result = await planner.planTurn(world.combat, member.combatant, {
        seed: 1,
        actions: [{
            id: "lasgun", type: "attack", name: "Lasgun",
            itemUuid: "Actor.x.Item.w1", itemId: "w1",
            class: "ranged", range: 100
        }],
        targets: [teamContact],
        moves: [{ x: 100, y: 0, distance: 1.5, cost: 2 }],
        team: { teamId: "alpha", contacts: [] }
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const target = result.plan.snapshot.targets.find(t => t.tokenUuid === teamContact.tokenUuid);
    assert.equal(target.source, "team-contact");
    assert.equal(target.canAttack, false);
    // A memory contact never yields a direct attack step — the bot
    // advances toward the last-known point instead.
    const types = result.plan.steps.map(step => step.type);
    assert.equal(types.includes("attack"), false);
    assert.equal(types[0], "move");
});

test("fresher team contact replaces a stale own last-known in the plan", async () => {
    const member = makeMember({
        fireteam: { teamId: "alpha" },
        memory: {
            "stale-uuid": mem(1, 1, { lastSeenRound: 1, lastSeenTurn: 0 })
        }
    });
    const world = makeTeamWorld([member]);
    const planner = createPlannerService();
    registerAssaultPreset(planner);
    // Perception stub: own stale record vs fresher team sighting.
    const perception = {
        buildPerceptionSnapshot: () => ({
            status: "ok",
            visibleTargets: [],
            lastKnownTargets: [
                { tokenUuid: "stale-uuid", ...mem(1, 1, { lastSeenRound: 1 }) }
            ],
            revision: "r"
        }),
        teamLastKnownPositions: () => ([
            { tokenUuid: "stale-uuid", ...mem(9, 9, { lastSeenRound: 3 }), sourceCombatantId: "c-t" }
        ])
    };
    // No injected `targets` — the perception path resolves the own stale
    // last-known entry, then the fresher team contact replaces it.
    const result = await planner.planTurn(world.combat, member.combatant, {
        seed: 1,
        perception,
        actions: [],
        moves: [{ x: 100, y: 0, distance: 1.5, cost: 2 }],
        team: { teamId: "alpha" }
    });
    const target = result.plan.snapshot.targets.find(t => t.tokenUuid === "stale-uuid");
    assert.equal(target.source, "team-contact");
    assert.equal(target.x, 9);
    // `shareContacts === false` keeps the own record instead.
    const sealed = await planner.planTurn(world.combat, member.combatant, {
        seed: 1,
        perception,
        actions: [],
        moves: [{ x: 100, y: 0, distance: 1.5, cost: 2 }],
        team: { teamId: "alpha", shareContacts: false }
    });
    const own = sealed.plan.snapshot.targets.find(t => t.tokenUuid === "stale-uuid");
    assert.equal(own.source, "last-known");
    assert.equal(own.x, 1);
});

test("buildTeamPlan passes the merged contact map into every member plan", async () => {
    const leader = makeMember({ fireteam: { teamId: "alpha" }, initiative: 20 });
    const scout = makeMember({
        fireteam: { teamId: "alpha" },
        initiative: 10,
        memory: { "contact-uuid": mem(4, 4, { lastSeenRound: 1 }) }
    });
    const world = makeTeamWorld([leader, scout]);
    const perception = {
        lastKnownPositions: combatant =>
            combatant === scout.combatant
                ? [{ tokenUuid: "contact-uuid", ...mem(4, 4, { lastSeenRound: 1 }) }]
                : []
    };
    const contexts = [];
    const spyPlanner = createPlannerService();
    registerAssaultPreset(spyPlanner);
    const inner = spyPlanner.planTurn.bind(spyPlanner);
    spyPlanner.planTurn = async (combat, combatant, context) => {
        contexts.push({ combatantId: combatant.id, team: context.team });
        return inner(combat, combatant, context);
    };
    const service = createFireteamService({ planner: spyPlanner });
    const result = await service.buildTeamPlan(world.combat, {
        teamId: "alpha",
        leaderId: leader.combatant.id
    }, { seed: 5, perception, targets: targetsOf(world) });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    // Both member contexts received the identical merged contact list.
    for (const entry of contexts) {
        assert.ok(Array.isArray(entry.team?.contacts));
        const contact = entry.team.contacts.find(c => c.tokenUuid === "contact-uuid");
        assert.ok(contact, `contacts shared with ${entry.combatantId}`);
        assert.equal(contact.sourceCombatantId, scout.combatant.id);
    }
});

/* ------------------------------------------------------------------ */
/* B. Synchronized-strike delay                                        */
/* ------------------------------------------------------------------ */

/**
 * Planner stub for the synchronized-strike tests: the flank-task member
 * receives a move-only transit plan (ETA ≥ 1 turn), everyone else a
 * direct attack on the shared target.
 * @param {object} input
 * @param {string} input.flankerId Combatant id of the transit flanker.
 * @param {string} input.targetId Shared convergence target id.
 * @param {string} [input.flankerPlan] Alternative flanker plan shape:
 *   `"attack"` gives the flanker an in-position strike instead.
 * @returns {object}
 */
function stubSyncPlanner({ flankerId, targetId, flankerPlan = "move" } = {}) {
    return {
        planTurn: async (combat, combatant) => {
            const isFlanker = combatant.id === flankerId;
            const strikes = !isFlanker || flankerPlan === "attack";
            const plan = {
                id: `plan-${combatant.id}`,
                score: 1,
                target: strikes ? { tokenId: targetId } : null,
                snapshot: { targets: [] },
                steps: isFlanker && flankerPlan !== "attack"
                    ? [
                        {
                            id: "step-move-1",
                            type: "move",
                            input: { to: { x: 100, y: 0 }, waypoints: [] }
                        },
                        { id: "step-end-turn-2", type: "end-turn", input: {} }
                    ]
                    : [
                        {
                            id: "step-attack-1",
                            type: "attack",
                            input: { targetTokenId: targetId }
                        },
                        { id: "step-end-turn-2", type: "end-turn", input: {} }
                    ]
            };
            return { status: "ok", plan, reason: null };
        }
    };
}

/**
 * Convergence world with an explicit flank assignment: the flanker is in
 * transit (move-only stub plan), main members strike the shared target.
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function syncWorld({ lastOrder = null, delaySync = null,
    morale = null, syncDelay = true, flankerPlan = "move",
    extraContext = {} } = {}) {
    const leader = makeMember({ fireteam: { teamId: "alpha" }, x: 0, initiative: 20 });
    const support = makeMember({ fireteam: { teamId: "alpha" }, x: 100, initiative: 15 });
    const flanker = makeMember({ fireteam: { teamId: "alpha" }, x: 20000, initiative: 5 });
    if (lastOrder) {
        leader.combatant.flags[MODULE_ID][FLAG_KEYS.lastOrder] = lastOrder;
    }
    if (delaySync) {
        support.combatant.flags[MODULE_ID][FLAG_KEYS.delaySync] = delaySync;
    }
    if (morale) {
        support.combatant.flags[MODULE_ID][FLAG_KEYS.morale] = morale;
    }
    const world = makeTeamWorld([leader, support, flanker], { wounds: 10, enemyX: 300 });
    const planner = stubSyncPlanner({
        flankerId: flanker.combatant.id,
        targetId: world.enemyToken.id,
        flankerPlan
    });
    const service = createFireteamService({ planner });
    const context = {
        seed: 5,
        allowFlank: true,
        syncDelay,
        // Pin every task: without explicit support/assault the default
        // flank group would steal the first non-leader member.
        assignments: {
            [leader.combatant.id]: "assault",
            [support.combatant.id]: "support",
            [flanker.combatant.id]: "flank"
        },
        targets: [{ tokenId: world.enemyToken.id, x: 300, y: 0, wounds: 10 }],
        ...extraContext
    };
    const result = await service.buildTeamPlan(world.combat, {
        teamId: "alpha",
        leaderId: leader.combatant.id
    }, context);
    return { world, result, leader, support, flanker };
}

test("sync delay: main members attacking the convergent target hold for the transit flanker", async () => {
    const { result, support, flanker } = await syncWorld();
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    const plan = result.teamPlan;
    assert.ok(plan.convergence, "convergent objective present");
    const delayedMembers = plan.members.filter(m => m.delayed);
    assert.ok(delayedMembers.length >= 1, "at least one delayed member");
    const supportEntry = plan.members.find(m => m.combatantId === support.combatant.id);
    assert.ok(supportEntry.delayed, "support waits for the sync");
    assert.equal(supportEntry.delayed.reason, "await-sync");
    assert.equal(supportEntry.delayed.until, "flank-ready");
    assert.equal(supportEntry.delayed.awaitId, flanker.combatant.id);
    // The flanker itself is never delayed — it is the wait condition.
    assert.equal(
        plan.members.find(m => m.combatantId === flanker.combatant.id).delayed,
        null);
    // The stub carries a serializable delay step plus end-turn.
    const steps = plan.memberPlans[support.combatant.id].steps;
    assert.equal(steps[0].type, "delay");
    assert.equal(steps[0].input.reason, "await-sync");
    assert.equal(steps[0].input.until, "flank-ready");
    assert.equal(steps[1].type, "end-turn");
    assert.equal(plan.diagnostics.syncDelays.length, delayedMembers.length);
    // Serializable.
    assert.deepEqual(
        JSON.parse(JSON.stringify(plan.diagnostics.syncDelays)),
        plan.diagnostics.syncDelays);
});

test("sync delay: an in-position flanker (attack plan) holds nobody", async () => {
    // The flanker's plan already strikes — no transit wait exists, so no
    // member may be delayed.
    const { result } = await syncWorld({ flankerPlan: "attack" });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    const plan = result.teamPlan;
    assert.equal(plan.members.every(m => !m.delayed), true);
    assert.equal(plan.diagnostics.syncDelays, undefined);
});

test("sync delay: maxSyncRounds exhausts the member's patience", async () => {
    const { result, support } = await syncWorld({
        delaySync: { until: "flank-ready", count: DEFAULT_MAX_SYNC_ROUNDS, round: 0 }
    });
    const plan = result.teamPlan;
    assert.ok(plan.convergence, "convergent objective present");
    const supportEntry = plan.members
        .find(m => m.combatantId === support.combatant.id);
    // The support member already spent DEFAULT_MAX_SYNC_ROUNDS delays for
    // the same `until` condition — no further delay is assigned to it.
    assert.equal(supportEntry.delayed, null);
});

test("sync delay: a different until condition resets the patience budget", async () => {
    const { result, support } = await syncWorld({
        delaySync: { until: "other-signal", count: DEFAULT_MAX_SYNC_ROUNDS, round: 0 }
    });
    const plan = result.teamPlan;
    const supportEntry = plan.members
        .find(m => m.combatantId === support.combatant.id);
    assert.ok(supportEntry.delayed,
        "a stale count for another signal does not block the delay");
});

test("sync delay: a desperate member never holds", async () => {
    const { result, support } = await syncWorld({
        morale: { state: "desperate" }
    });
    const plan = result.teamPlan;
    const supportEntry = plan.members
        .find(m => m.combatantId === support.combatant.id);
    assert.equal(supportEntry.delayed, null);
});

test("sync delay: validateTeamPlan reports sync-broken when the awaited flanker falls", async () => {
    const { result, flanker, world } = await syncWorld();
    const plan = result.teamPlan;
    assert.ok(plan.members.some(m => m.delayed), "fixture: someone delayed");
    const service = createFireteamService({ planner: createPlannerService() });
    // Flanker defeated between planning and execution → sync-broken.
    flanker.combatant.defeated = true;
    const verdict = service.validateTeamPlan(plan, { combat: world.combat });
    assert.equal(verdict.valid, false);
    assert.equal(verdict.reason, TEAM_PLAN_REASONS.syncBroken);
});

test("sync delay: context.syncDelay === false disables the pass", async () => {
    const { result } = await syncWorld({ syncDelay: false });
    assert.equal(result.teamPlan.members.every(m => !m.delayed), true);
});

test("executor: a delay step writes the system delayed flag and delaySync bookkeeping", async () => {
    const world = makeTeamWorld([makeMember({ fireteam: { teamId: "alpha" } })]);
    const combatant = world.combat.combatants.contents[0];
    const api = createModuleApi();
    const executor = createExecutorService({ api });
    const plan = {
        id: "plan-delay",
        operationId: "op-delay",
        steps: [
            {
                id: "step-delay-1",
                type: "delay",
                cost: { halves: 2 },
                input: { reason: "await-sync", until: "flank-ready", teamId: "alpha", round: 1 },
                preconditions: ["turn"],
                projectedResourceDelta: {}
            },
            {
                id: "step-end-turn-2",
                type: "end-turn",
                cost: {},
                input: { reason: "await-sync" },
                preconditions: ["turn"],
                projectedResourceDelta: {}
            }
        ]
    };
    const nextTurnCalls = { count: 0 };
    world.combat.nextTurn = async () => {
        nextTurnCalls.count++;
        world.combat.turn += 1;
        return world.combat;
    };
    const result = await executor.executePlan(plan, {
        combat: world.combat,
        combatant,
        operationId: "op-delay",
        operations: {
            completeTurn: async () => ({ ok: true }),
            transitionOperation: async () => ({ ok: true })
        }
    });
    assert.equal(result.status, "completed");
    // The system flag marks the combatant delayed for the tracker.
    assert.equal(
        combatant.flags["only-war-local"]?.delayed, true);
    // Module bookkeeping counts consecutive sync waits.
    const sync = combatant.flags[MODULE_ID][FLAG_KEYS.delaySync];
    assert.equal(sync.until, "flank-ready");
    assert.equal(sync.count, 1);
    assert.equal(nextTurnCalls.count, 1);
});

/* ------------------------------------------------------------------ */
/* C. Leader orders                                                    */
/* ------------------------------------------------------------------ */

/**
 * Fireteam service with a planTurn spy delegating to a real planner —
 * captures the `team` context every member plan received.
 * @returns {{service: object, contexts: Map}}
 */
function spyFireteam() {
    const planner = createPlannerService();
    registerAssaultPreset(planner);
    const contexts = new Map();
    const inner = planner.planTurn.bind(planner);
    planner.planTurn = async (combat, combatant, context) => {
        contexts.set(combatant.id, context.team ?? null);
        return inner(combat, combatant, context);
    };
    return { service: createFireteamService({ planner }), contexts };
}

test("leader with an order item and command skill receives an orderCandidate", async () => {
    const leader = makeMember({
        fireteam: { teamId: "alpha" },
        skills: { command: { advance: 0 } },
        items: [
            {
                id: "w1",
                uuid: "Actor.x.Item.w1",
                name: "Lasgun",
                type: "weapon",
                system: { class: "ranged", range: 100, damage: "1d10+3" }
            },
            {
                id: "o1",
                uuid: "Actor.x.Item.o1",
                name: "Fire on my target",
                type: "order",
                system: { orderType: "basic", benefit: "+10 BS" }
            }
        ]
    });
    const support = makeMember({ fireteam: { teamId: "alpha" } });
    const world = makeTeamWorld([leader, support]);
    const { service, contexts } = spyFireteam();
    const result = await service.buildTeamPlan(world.combat, {
        teamId: "alpha",
        leaderId: leader.combatant.id
    }, { seed: 5, targets: targetsOf(world) });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    const candidate = contexts.get(leader.combatant.id)?.orderCandidate;
    assert.ok(candidate, "leader context carries orderCandidate");
    assert.equal(candidate.orderId, "Actor.x.Item.o1");
    assert.equal(candidate.name, "Fire on my target");
    assert.equal(candidate.orderType, "basic");
    assert.equal(candidate.benefit, "+10 BS");
    assert.equal(candidate.skill, "command");
    assert.equal(candidate.advanced, false);
    // Non-leader members never receive the candidate.
    assert.equal(contexts.get(support.combatant.id)?.orderCandidate, undefined);
});

test("order cooldown, missing command and single-member squads gate the candidate", async () => {
    const makeLeader = () => makeMember({
        fireteam: { teamId: "alpha" },
        skills: { command: {} },
        items: [{
            id: "o1",
            uuid: "Actor.x.Item.o1",
            name: "Regroup",
            type: "order",
            system: { orderType: "basic", benefit: null }
        }]
    });
    // Cooldown active: lastOrder inside ORDER_COOLDOWN_ROUNDS.
    {
        const leader = makeLeader();
        const mate = makeMember({ fireteam: { teamId: "alpha" } });
        const world = makeTeamWorld([leader, mate]);
        leader.combatant.flags[MODULE_ID][FLAG_KEYS.lastOrder] = {
            round: world.combat.round - (ORDER_COOLDOWN_ROUNDS - 1),
            orderId: "Actor.x.Item.o1",
            result: "success"
        };
        const { service, contexts } = spyFireteam();
        const cooled = await service.buildTeamPlan(world.combat, {
            teamId: "alpha",
            leaderId: leader.combatant.id
        }, { seed: 5, targets: targetsOf(world) });
        assert.equal(contexts.get(leader.combatant.id)?.orderCandidate, undefined,
            "no orderCandidate while the cooldown runs");
    }
    // Cooldown expired → the candidate returns.
    {
        const leader = makeLeader();
        const mate = makeMember({ fireteam: { teamId: "alpha" } });
        const world = makeTeamWorld([leader, mate]);
        leader.combatant.flags[MODULE_ID][FLAG_KEYS.lastOrder] = {
            round: world.combat.round - ORDER_COOLDOWN_ROUNDS,
            orderId: "Actor.x.Item.o1",
            result: "success"
        };
        const { service, contexts } = spyFireteam();
        await service.buildTeamPlan(world.combat, {
            teamId: "alpha",
            leaderId: leader.combatant.id
        }, { seed: 5, targets: targetsOf(world) });
        assert.ok(contexts.get(leader.combatant.id)?.orderCandidate,
            "expired cooldown re-offers the order");
    }
    // No command skill → no candidate, nothing is silently issued.
    {
        const unskilled = makeMember({
            fireteam: { teamId: "alpha" },
            items: [{
                id: "o1",
                uuid: "Actor.y.Item.o1",
                name: "Hold",
                type: "order",
                system: { orderType: "basic" }
            }]
        });
        const mate = makeMember({ fireteam: { teamId: "alpha" } });
        const world = makeTeamWorld([unskilled, mate]);
        const { service, contexts } = spyFireteam();
        await service.buildTeamPlan(world.combat, {
            teamId: "alpha",
            leaderId: unskilled.combatant.id
        }, { seed: 5, targets: targetsOf(world) });
        assert.equal(contexts.get(unskilled.combatant.id)?.orderCandidate, undefined);
    }
    // A single-member squad has nobody to order.
    {
        const solo = makeLeader();
        const world = makeTeamWorld([solo]);
        const { service, contexts } = spyFireteam();
        await service.buildTeamPlan(world.combat, {
            teamId: "alpha",
            leaderId: solo.combatant.id
        }, { seed: 5, targets: targetsOf(world) });
        assert.equal(contexts.get(solo.combatant.id)?.orderCandidate, undefined);
    }
});

test("planner: order step serializes as a skill test and wins over an empty hold", async () => {
    const member = makeMember({
        fireteam: { teamId: "alpha" },
        skills: { command: {} }
    });
    const world = makeTeamWorld([member]);
    const planner = createPlannerService();
    registerAssaultPreset(planner);
    const result = await planner.planTurn(world.combat, member.combatant, {
        seed: 3,
        actions: [],
        targets: [],
        team: {
            teamId: "alpha",
            orderCandidate: {
                orderId: "order-sergeant",
                name: "Keep them pinned",
                orderType: "basic",
                benefit: "allies +10 BS",
                skill: "command",
                advanced: false
            }
        }
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const test = result.plan.steps.find(step => step.type === "test");
    assert.ok(test, "order serializes as a test step");
    assert.equal(test.input.type, "skill");
    assert.equal(test.input.key, "command");
    assert.equal(test.input.orderId, "order-sergeant");
    assert.equal(test.input.orderBenefit, "allies +10 BS");
    assert.equal(test.input.flags.isOrder, true);
    // Below a ready shot, above an empty hold — the factor marks it.
    assert.equal(result.plan.breakdown.contributions.order > 0, true);
    // Advanced orders cost the full action.
    const advanced = await planner.planTurn(world.combat, member.combatant, {
        seed: 3,
        actions: [],
        targets: [],
        team: {
            teamId: "alpha",
            orderCandidate: {
                orderId: "order-veteran",
                name: "Take no prisoners",
                advanced: true
            }
        }
    });
    const advTest = advanced.plan.steps.find(step => step.type === "test");
    assert.equal(advTest.cost.halves, 2);
    // A leader without the command skill never silently issues the order:
    // the candidate is rejected `order-unavailable` in diagnostics.
    const unskilled = makeMember({ fireteam: { teamId: "alpha" } });
    const world2 = makeTeamWorld([unskilled]);
    const rejected = await planner.planTurn(world2.combat, unskilled.combatant, {
        seed: 3,
        actions: [],
        targets: [],
        team: {
            teamId: "alpha",
            orderCandidate: {
                orderId: "order-sergeant",
                name: "Keep them pinned",
                advanced: false
            }
        }
    });
    assert.equal(rejected.plan.steps.some(step => step?.input?.orderId), false);
    assert.equal(
        rejected.plan.diagnostics.rejected.some(r => r.reason === "order-unavailable"),
        true);
});

test("speciality perk sergeant_charge is an alternative order source", async () => {
    const perkUuid = "Compendium.p.perks.Item.p1";
    const specUuid = "Compendium.p.specialities.Item.s1";
    const docs = {
        [specUuid]: {
            uuid: specUuid,
            type: "speciality",
            system: { perks: [perkUuid] }
        },
        [perkUuid]: {
            uuid: perkUuid,
            type: "specialityPerk",
            name: "Sergeant's Charge",
            system: {
                perkId: "sergeant_charge",
                activation: { type: "order", actionCost: "half" },
                benefit: "squad may charge"
            }
        }
    };
    const restore = globalThis.fromUuidSync;
    globalThis.fromUuidSync = uuid => docs[uuid] ?? null;
    try {
        const leader = makeMember({
            fireteam: { teamId: "alpha" },
            skills: { command: {} }
        });
        leader.actor.system.speciality = {
            uuid: specUuid,
            perks: { sergeant_charge: { enabled: true } }
        };
        const mate = makeMember({ fireteam: { teamId: "alpha" } });
        const world = makeTeamWorld([leader, mate]);
        const { service, contexts } = spyFireteam();
        await service.buildTeamPlan(world.combat, {
            teamId: "alpha",
            leaderId: leader.combatant.id
        }, { seed: 5, targets: targetsOf(world) });
        const candidate = contexts.get(leader.combatant.id)?.orderCandidate;
        assert.ok(candidate, "sergeant_charge offers an orderCandidate");
        assert.equal(candidate.orderId, "sergeant_charge");
        assert.equal(candidate.benefit, "squad may charge");
    } finally {
        globalThis.fromUuidSync = restore;
    }
});

test("executor: a successful order test stamps lastOrder", async () => {
    const member = makeMember({ fireteam: { teamId: "alpha" } });
    const world = makeTeamWorld([member]);
    const combatant = member.combatant;
    const api = createModuleApi();
    const executor = createExecutorService({ api });
    const prepared = { status: "ok", kind: "test" };
    const rolls = {
        prepareTest: async () => prepared,
        executeTest: async () => ({ status: "ok" })
    };
    const plan = {
        id: "plan-order",
        operationId: "op-order",
        steps: [
            {
                id: "step-test-1",
                type: "test",
                cost: { halves: 1 },
                input: {
                    type: "skill",
                    key: "command",
                    name: "Keep them pinned",
                    orderId: "order-sergeant",
                    flags: { isOrder: true }
                },
                preconditions: ["turn"],
                projectedResourceDelta: {}
            },
            {
                id: "step-end-turn-2",
                type: "end-turn",
                cost: {},
                input: { reason: "no-attack" },
                preconditions: ["turn"],
                projectedResourceDelta: {}
            }
        ]
    };
    world.combat.nextTurn = async () => {
        world.combat.turn += 1;
        return world.combat;
    };
    const result = await executor.executePlan(plan, {
        combat: world.combat,
        combatant,
        operationId: "op-order",
        rolls,
        planner: { validateSnapshot: () => ({ valid: true }) },
        operations: {
            completeTurn: async () => ({ ok: true }),
            transitionOperation: async () => ({ ok: true })
        }
    });
    assert.equal(result.status, "completed");
    const record = combatant.flags[MODULE_ID][FLAG_KEYS.lastOrder];
    assert.ok(record, "lastOrder flag stamped after success");
    assert.equal(record.orderId, "order-sergeant");
    assert.equal(record.round, world.combat.round);
    assert.equal(record.result, "success");
});

/* ------------------------------------------------------------------ */
/* E. Review: shared contacts steer overwatch; willfulness distrusts  */
/* ------------------------------------------------------------------ */

test("a shared team-contact steers the overwatch cone (review)", async () => {
    // Issue #38 review: a living teammate's fresh sighting is valid
    // intel for the watch cone — unlike the bot's stale own memory,
    // which the issue #30 rule still excludes.
    const member = makeMember({ fireteam: { teamId: "alpha" } });
    const world = makeTeamWorld([member], { enemyX: 2000 });
    const teamContact = {
        tokenId: world.enemyToken.id,
        tokenUuid: `Scene.${world.scene.id}.Token.${world.enemyToken.id}`,
        x: 2000,
        y: 0,
        elevation: 0,
        lastSeenRound: 1,
        lastSeenTurn: 0,
        sourceCombatantId: "c-teammate",
        source: "team-contact"
    };
    const planner = createPlannerService();
    planner.registerPreset("assault", {
        weights: { overwatch: 10, holdPosition: 1 },
        allowNoAction: true,
        alwaysOfferHold: true
    });
    const result = await planner.planTurn(world.combat, member.combatant, {
        seed: 1,
        targets: [teamContact],
        actions: [{
            id: "las", name: "Lasgun", type: "attack",
            itemUuid: "Actor.a.Item.w1", itemId: "w1",
            class: "ranged", range: 100, damage: 5,
            cost: "half", attackType: "standard", weaponId: "w1"
        }],
        moves: [],
        team: { teamId: "alpha", contacts: [] }
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const ow = result.plan.steps.find(step => step.type === "overwatch");
    assert.ok(ow, "a team-contact anchors a declaration");
    assert.equal(ow.input.direction, 0, "the cone faces the shared point");
    assert.equal(ow.input.targetTokenUuid, teamContact.tokenUuid);
});

test("an own last-known still never steers the overwatch cone (review)", async () => {
    const member = makeMember({ fireteam: { teamId: "alpha" } });
    const world = makeTeamWorld([member], { enemyX: 2000 });
    const lastKnown = {
        tokenId: world.enemyToken.id,
        tokenUuid: `Scene.${world.scene.id}.Token.${world.enemyToken.id}`,
        x: 2000,
        y: 0,
        elevation: 0,
        lastSeenRound: 1,
        lastSeenTurn: 0,
        source: "last-known"
    };
    const planner = createPlannerService();
    planner.registerPreset("assault", {
        weights: { overwatch: 10, holdPosition: 1 },
        allowNoAction: true,
        alwaysOfferHold: true
    });
    const result = await planner.planTurn(world.combat, member.combatant, {
        seed: 1,
        targets: [lastKnown],
        actions: [{
            id: "las", name: "Lasgun", type: "attack",
            itemUuid: "Actor.a.Item.w1", itemId: "w1",
            class: "ranged", range: 100, damage: 5,
            cost: "half", attackType: "standard", weaponId: "w1"
        }],
        moves: [],
        team: { teamId: "alpha", contacts: [] }
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.ok(result.plan.steps.every(step => step.type !== "overwatch"),
        "stale own memory is not a declaration anchor");
});

test("the loner trait ignores shared team contacts entirely (review)", async () => {
    const member = makeMember({ fireteam: { teamId: "alpha" } });
    const world = makeTeamWorld([member], { enemyX: 2000 });
    const teamContact = {
        tokenId: world.enemyToken.id,
        tokenUuid: `Scene.${world.scene.id}.Token.${world.enemyToken.id}`,
        x: 2000,
        y: 0,
        elevation: 0,
        lastSeenRound: 1,
        lastSeenTurn: 0,
        sourceCombatantId: "c-teammate",
        source: "team-contact"
    };
    const planner = createPlannerService();
    registerAssaultPreset(planner);
    const trusting = await planner.planTurn(world.combat, member.combatant, {
        seed: 1,
        actions: [],
        targets: [],
        moves: [{ x: 100, y: 0, distance: 1.5, cost: 2 }],
        team: { teamId: "alpha", contacts: [teamContact] }
    });
    assert.equal(trusting.status, PLANNER_STATUS.ok);
    assert.ok(trusting.plan.snapshot.targets.some(
        t => t.tokenUuid === teamContact.tokenUuid),
        "a trusting member sees the shared contact");
    const loner = await planner.planTurn(world.combat, member.combatant, {
        seed: 1,
        personality: ["loner"],
        actions: [],
        targets: [],
        moves: [{ x: 100, y: 0, distance: 1.5, cost: 2 }],
        team: { teamId: "alpha", contacts: [teamContact] }
    });
    assert.equal(loner.status, PLANNER_STATUS.ok);
    assert.ok(loner.plan.snapshot.targets.every(
        t => t.tokenUuid !== teamContact.tokenUuid),
        "the loner distrusts squad chatter — no shared contact");
});

test("a rabble squad character ignores shared team contacts (review)", async () => {
    const member = makeMember({ fireteam: { teamId: "alpha" } });
    const world = makeTeamWorld([member], { enemyX: 2000 });
    const teamContact = {
        tokenId: world.enemyToken.id,
        tokenUuid: `Scene.${world.scene.id}.Token.${world.enemyToken.id}`,
        x: 2000,
        y: 0,
        elevation: 0,
        lastSeenRound: 1,
        lastSeenTurn: 0,
        sourceCombatantId: "c-teammate",
        source: "team-contact"
    };
    const planner = createPlannerService();
    registerAssaultPreset(planner);
    const result = await planner.planTurn(world.combat, member.combatant, {
        seed: 1,
        personality: [],
        actions: [],
        targets: [],
        moves: [{ x: 100, y: 0, distance: 1.5, cost: 2 }],
        team: { teamId: "alpha", character: "rabble", contacts: [teamContact] }
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.ok(result.plan.snapshot.targets.every(
        t => t.tokenUuid !== teamContact.tokenUuid),
        "an undisciplined squad ignores shared intel");
});
