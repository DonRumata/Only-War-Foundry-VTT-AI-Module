/**
 * Replay tests (issue #27): capture → JSON → `replayPlan` reproduces the
 * identical `planTurn` plan and reason trace. The capture-journal entry
 * written by the executor (combatant `captureJournal` flag,
 * `aiCaptureContext`) is a self-contained offline fixture — this file
 * proves determinism end to end.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { FLAG_KEYS, MODULE_ID } from "../../scripts/constants.js";
import { createExecutorService, EXECUTOR_STATUS } from "../../scripts/executor.js";
import { createModuleApi } from "../../scripts/api.js";
import {
    PLANNER_STATUS,
    createPlannerService
} from "../../scripts/planner.js";
import { buildCaptureEntry } from "../../scripts/trace.js";
import { replayPlan } from "./replay-helpers.mjs";
import {
    makeActor,
    makeCombatant,
    makeScene,
    makeToken
} from "./fixtures.mjs";

let _combatId = 0;
let _opId = 0;

/** Minimal Combat fixture. */
function makeCombat({ combatants = [] } = {}) {
    const collection = new Map(combatants.map(c => [c.id, c]));
    collection.contents = combatants;
    return {
        documentName: "Combat",
        id: `replay-combat-${++_combatId}`,
        round: 1,
        turn: 0,
        combatants: collection,
        turns: combatants,
        scene: null,
        ended: false,
        get combatant() {
            return this.turns[this.turn] ?? null;
        }
    };
}

/** Small AI world: an assault NPC at (0, 0) plus a hostile at (300, 0). */
function makeWorld() {
    const scene = makeScene({ grid: "square" });
    const actor = makeActor({ enabled: true, preset: "assault" });
    actor.system = { wounds: { value: 12, max: 14 } };
    actor.items = [{
        id: "w1",
        uuid: `Actor.${actor.id}.Item.w1`,
        name: "Lasgun",
        type: "weapon",
        system: { class: "ranged", range: 100, damage: "1d10+3" }
    }];
    const token = makeToken({ actor });
    token.x = 0;
    token.y = 0;
    token.elevation = 0;
    token.disposition = -1;
    token.move = async waypoints => {
        const last = waypoints.at(-1);
        token.x = last.x;
        token.y = last.y;
        return true;
    };
    const combatant = makeCombatant({ actor, token });
    combatant.tokenId = token.id;

    const enemyActor = makeActor();
    enemyActor.system = { wounds: { value: 0, max: 10 } };
    enemyActor.items = [];
    const enemyToken = makeToken({ actor: enemyActor });
    enemyToken.x = 300;
    enemyToken.y = 0;
    enemyToken.elevation = 0;
    enemyToken.disposition = 1;
    const enemy = makeCombatant({ actor: enemyActor, token: enemyToken });
    enemy.tokenId = enemyToken.id;

    const combat = makeCombat({ combatants: [combatant, enemy] });
    combat.scene = scene;
    combat.nextTurn = async () => {
        combat.turn += 1;
        return combat;
    };
    return { scene, actor, token, combatant, enemy, enemyToken, combat };
}

/** Deterministic planTurn inputs — one attackable target, one action. */
function planContext(world) {
    return {
        seed: 7,
        targets: [{
            tokenId: world.enemyToken.id,
            tokenUuid: `Scene.${world.scene.id}.Token.${world.enemyToken.id}`,
            x: 300,
            y: 0,
            elevation: 0,
            distance: 4.5,
            canAttack: true,
            source: "injected"
        }],
        actions: [{
            id: "lasgun", type: "attack", name: "Lasgun",
            itemUuid: `Actor.${world.actor.id}.Item.w1`, itemId: "w1",
            class: "ranged", range: 100, cost: "half"
        }],
        moves: [{
            key: "m1",
            x: 200,
            y: 0,
            i: 2,
            j: 0,
            cost: 2,
            distance: 1.5,
            waypoints: [{ x: 100, y: 0 }, { x: 200, y: 0 }]
        }],
        morale: { state: "pressured" },
        personality: ["marksman"]
    };
}

/** The serializable core of a plan — what a replay must reproduce. */
function _planCore(plan) {
    return {
        steps: plan.steps,
        score: plan.score,
        breakdown: plan.breakdown,
        trace: plan.diagnostics?.trace,
        layers: plan.diagnostics?.layers
    };
}

test("capture → replayPlan reproduces the identical plan and trace", async () => {
    _resetMocks();
    const world = makeWorld();
    const planner = createPlannerService();
    const context = planContext(world);
    const original = await planner.planTurn(world.combat, world.combatant, context);
    assert.equal(original.status, PLANNER_STATUS.ok);

    // Build the same entry the executor journals, then round-trip it
    // through JSON — the wire form is the replay input.
    const entry = buildCaptureEntry({
        combat: world.combat,
        combatant: world.combatant,
        context,
        plan: original.plan,
        config: { enabled: true, preset: "assault" },
        operationId: "op-replay"
    });
    const replayed = await replayPlan(JSON.stringify(entry));
    assert.equal(replayed.result.status, PLANNER_STATUS.ok);
    assert.deepEqual(_planCore(replayed.result.plan), _planCore(original.plan),
        "replay reproduces steps, score, breakdown, layers and trace");
});

test("executor-captured journal entry replays to the same plan", async () => {
    _resetMocks();
    // The attack step needs a rolls API; the capture is journaled right
    // after planning regardless of the execution outcome.
    game.darkHeresy.api.rolls = {
        prepareAttack: async input => ({ fingerprint: "fp", rollData: {}, input }),
        executeAttack: async (_prepared, options) => ({
            status: "ok",
            operationId: options?.operationId,
            chatMessageIds: ["chat-msg"],
            resourceDelta: { ammo: -1 }
        })
    };
    try {
        const world = makeWorld();
        const api = createModuleApi();
        api.services.register("planner", createPlannerService({ api }));
        api.services.register("authority", { isController: () => true });
        const executor = createExecutorService({
            api,
            getMode: () => "automatic",
            pacing: () => 0
        });
        const result = await executor.runPlan({
            combat: world.combat,
            combatant: world.combatant,
            operation: { id: `op-replay-${++_opId}`, combatantId: world.combatant.id },
            planContext: planContext(world),
            capture: true
        });
        assert.equal(result.status, EXECUTOR_STATUS.completed);
        await new Promise(resolve => globalThis.setTimeout(resolve, 20));
        const journal = world.combatant.getFlag(MODULE_ID, FLAG_KEYS.captureJournal);
        assert.ok(Array.isArray(journal) && journal.length === 1);

        const replayed = await replayPlan(JSON.stringify(journal[0]));
        assert.equal(replayed.result.status, PLANNER_STATUS.ok);
        const entry = journal[0];
        // The replay reproduces the journaled fingerprint.
        assert.deepEqual(replayed.result.plan.steps, entry.result.steps);
        assert.equal(replayed.result.plan.score, entry.result.score);
        assert.deepEqual(replayed.result.plan.diagnostics.trace,
            entry.result.trace);
        // And the winner id matches the captured L4 verdict.
        const winner = replayed.result.plan.diagnostics.layers.find(
            r => r.layer === "L4" && r.code === "winner");
        assert.equal(winner.detail.candidate, entry.result.winner);
    } finally {
        delete game.darkHeresy.api.rolls;
    }
});

test("replayPlan rejects a malformed capture", async () => {
    await assert.rejects(() => replayPlan("null"), /capture entry/);
    await assert.rejects(() => replayPlan(42), /capture entry/);
});
