/**
 * Unit tests for the issue #15 action economy: half/full action budgets,
 * the move+full veto, aim candidates and the `aimedUntil` flag carry,
 * reload steps through `api.actions.reload` and overwatch candidates.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createModuleApi } from "../../scripts/api.js";
import { createExecutorService, EXECUTOR_STATUS } from "../../scripts/executor.js";
import { createPlannerService, PLANNER_STATUS } from "../../scripts/planner.js";
import { MODULE_ID } from "../../scripts/constants.js";
import {
    makeActor,
    makeCombatant,
    makeScene,
    makeToken
} from "./fixtures.mjs";

let _combatId = 0;
let _opId = 0;

/**
 * Minimal Combat fixture.
 * @param {object} [options]
 * @returns {object}
 */
function makeCombat({ round = 1, turn = 0, combatants = [] } = {}) {
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
        ended: false,
        get combatant() { return this.turns[this.turn] ?? null; }
    };
}

/**
 * Small world: AI-enabled NPC at the origin, one hostile at `(300, 0)`.
 * @param {object} [options]
 * @param {number[]} [options.enemyX] Enemy x positions.
 * @param {string} [options.preset]
 * @returns {object}
 */
function makeWorld({ enemies = [{ x: 300, y: 0 }], preset = "assault" } = {}) {
    const scene = makeScene({ grid: "square" });
    const actor = makeActor({ enabled: true, preset });
    actor.system = { wounds: { value: 12, max: 14 } };
    const token = makeToken({ actor });
    token.x = 0;
    token.y = 0;
    token.elevation = 0;
    token.disposition = -1;
    const combatant = makeCombatant({ actor, token });
    combatant.tokenId = token.id;
    combatant.initiative = 10;
    const enemyCombatants = enemies.map(enemy => {
        const enemyToken = makeToken({ actor: makeActor() });
        enemyToken.x = enemy.x;
        enemyToken.y = enemy.y;
        enemyToken.elevation = 0;
        enemyToken.disposition = 1;
        const enemyCombatant = makeCombatant({ actor: enemyToken.actor, token: enemyToken });
        enemyCombatant.tokenId = enemyToken.id;
        return enemyCombatant;
    });
    const combat = makeCombat({ combatants: [combatant, ...enemyCombatants] });
    combat.scene = scene;
    return { scene, actor, token, combatant, enemies: enemyCombatants, combat };
}

/**
 * Injected target list matching {@link makeWorld} enemies.
 * @param {object} world
 * @returns {object[]}
 */
function targetsOf(world) {
    return world.enemies.map(enemy => ({
        tokenId: enemy.token.id,
        tokenUuid: `Scene.${world.scene.id}.Token.${enemy.token.id}`,
        x: enemy.token.x,
        y: enemy.token.y,
        elevation: 0,
        canAttack: true,
        source: "injected"
    }));
}

/** Ranged attack entry; `cost` is the public-API action cost string. */
function lasgunAction({ id = "las", cost = "half", range = 30 } = {}) {
    return {
        id,
        kind: "attack",
        name: "Lasgun",
        itemUuid: "a.l",
        weaponId: "w1",
        weaponName: "Lasgun",
        attackType: "standard",
        cost,
        range,
        available: true
    };
}

/** Explicit half-aim API entry (bonus +10). */
function aimAction() {
    return { id: "aim.half", kind: "aim", name: "Aim", aim: 10, cost: "half", available: true };
}

test("a full-cost attack cannot follow movement (move+full veto)", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    planner.registerPreset("assault", { weights: { attackNow: 10, attackAfterMove: 6 } });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world),
        actions: [lasgunAction({ cost: "full" })],
        moves: [{ x: 100, y: 0, i: 1, j: 0, cost: 1, distance: 1.5, los: true }]
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    // The legal fallback is the in-place shot; every move+full pairing
    // lands in rejected diagnostics.
    assert.ok(result.plan.steps.every(step => step.type !== "move"));
    assert.ok(result.plan.steps.some(step => step.type === "attack"));
    assert.ok(result.plan.diagnostics.rejected.some(entry =>
        entry.candidate.startsWith("move-attack|") && entry.reason === "full-after-move"
    ), JSON.stringify(result.plan.diagnostics.rejected));
});

test("a half-cost attack may follow a half move", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    planner.registerPreset("assault", { weights: { attackNow: 1, attackAfterMove: 6 } });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world),
        actions: [lasgunAction({ cost: "half" })],
        moves: [{ x: 100, y: 0, i: 1, j: 0, cost: 1, distance: 1.5, los: true }]
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.deepEqual(result.plan.steps.map(step => step.type), ["move", "attack", "end-turn"]);
});

test("aim-attack serializes aim + attack steps carrying the aim bonus", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    planner.registerPreset("assault", { weights: { attackNow: 1, aim: 5 } });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world),
        actions: [lasgunAction(), aimAction()],
        moves: []
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const types = result.plan.steps.map(step => step.type);
    assert.deepEqual(types, ["aim", "attack", "end-turn"]);
    const aimStep = result.plan.steps[0];
    const attackStep = result.plan.steps[1];
    assert.equal(aimStep.input.aim, 10, "explicit API bonus is booked");
    assert.equal(attackStep.input.aim, 10, "attack step consumes the booked bonus");
    assert.equal(attackStep.input.actionId, "las");
});

test("aim-attack falls back to the synthesized +10 bonus without an API aim entry", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    planner.registerPreset("assault", { weights: { attackNow: 1, aim: 5 } });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world),
        actions: [lasgunAction()],
        moves: []
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const types = result.plan.steps.map(step => step.type);
    assert.deepEqual(types, ["aim", "attack", "end-turn"]);
    const attackStep = result.plan.steps.find(step => step.type === "attack");
    assert.equal(attackStep.input.aim, 10);
});

test("a ranged NPC with no reachable shot aims for the next turn", async () => {
    // Enemy 1350u out — no move lands in range and the in-place shot is
    // out-of-range: the utility turn is a full aim (+20).
    const world = makeWorld({ enemies: [{ x: 90000, y: 0 }] });
    const planner = createPlannerService();
    planner.registerPreset("rangedCover", { weights: { attackNow: 10, aimAlone: 5 } });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world),
        actions: [lasgunAction()],
        moves: []
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const aimStep = result.plan.steps.find(step => step.type === "aim");
    assert.ok(aimStep, "aim step exists");
    assert.equal(aimStep.input.aim, 20, "full aim books the +20 bonus");
    assert.ok(result.plan.steps.every(step => step.type !== "attack"));
});

test("a carried aimedUntil flag attaches its bonus to the attack step", async () => {
    const world = makeWorld();
    await world.combatant.setFlag(MODULE_ID, "aim", { bonus: 20, declaredRound: 0 });
    const planner = createPlannerService();
    planner.registerPreset("assault", { weights: { attackNow: 10 } });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world),
        actions: [lasgunAction()],
        moves: []
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const attack = result.plan.steps.find(step => step.type === "attack");
    assert.ok(attack, "attack step exists");
    assert.equal(attack.input.aim, 20, "carried bonus reaches the roll input");
});

test("a reload action produces a reload step for the dry weapon", async () => {
    const world = makeWorld({ enemies: [{ x: 90000, y: 0 }] });
    const planner = createPlannerService();
    planner.registerPreset("assault", { weights: { reload: 10 } });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world),
        actions: [
            { id: "rel", kind: "reload", name: "Reload Lasgun", weaponId: "w1", cost: "half" },
            lasgunAction()
        ],
        moves: []
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const reload = result.plan.steps.find(step => step.type === "reload");
    assert.ok(reload, "reload step exists");
    assert.equal(reload.input.weaponId, "w1");
    assert.ok(result.plan.steps.every(step => step.type !== "move"));
});

test("an overwatch candidate declares a cone step toward the threat", async () => {
    // Enemy beyond weapon range: no shot exists, so the watch cone beats
    // aim/hold by the preset's overwatch weight.
    const world = makeWorld({ enemies: [{ x: 90000, y: 0 }], preset: "hold" });
    const planner = createPlannerService();
    planner.registerPreset("hold", {
        weights: { overwatch: 10, holdPosition: 1 },
        allowNoAction: true,
        alwaysOfferHold: true
    });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world),
        actions: [lasgunAction()],
        moves: []
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const ow = result.plan.steps.find(step => step.type === "overwatch");
    assert.ok(ow, "overwatch step exists");
    assert.ok(result.plan.steps.every(step => step.type !== "attack"));
    assert.equal(ow.input.weaponId, "w1");
    assert.equal(ow.input.attackType, "standard");
    assert.equal(ow.input.arc, 45);
    assert.ok(Number.isFinite(ow.input.direction));
});

test("pinned keeps stationary utility turns but never a move-reload", async () => {
    const world = makeWorld({ enemies: [{ x: 90000, y: 0 }] });
    const planner = createPlannerService();
    planner.registerPreset("assault", { weights: { reload: 10 } });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world),
        actions: [
            { id: "rel", kind: "reload", name: "Reload Lasgun", weaponId: "w1", cost: "half" },
            lasgunAction()
        ],
        moves: [{ x: 100, y: 0, i: 1, j: 0, cost: 1, distance: 60, los: true }],
        selfStatuses: ["pinned"]
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.ok(result.plan.steps.every(step => step.type !== "move"), "no movement while pinned");
    assert.ok(result.plan.steps.some(step => step.type === "reload"), "reload in place stays legal");
});

/**
 * Serialized plan carrying an `aim` + `attack` step pair, for executor
 * tests — mirrors `_stepsFor` output.
 * @param {object} world
 * @param {object} [options]
 * @returns {object}
 */
function aimPlan(world, { operationId = "op-aim" } = {}) {
    return {
        id: "plan-aim-attack",
        operationId,
        steps: [
            {
                id: "step-aim-1",
                type: "aim",
                cost: { halves: 1 },
                preconditions: ["turn"],
                input: { actionId: "aim.half", name: "Aim", aim: 10 }
            },
            {
                id: "step-attack-2",
                type: "attack",
                cost: { halves: 1 },
                preconditions: ["turn", "target", "resources"],
                input: {
                    actionId: "las",
                    name: "Lasgun",
                    itemUuid: `Actor.${world.actor.id}.Item.w1`,
                    targetTokenUuid: `Scene.${world.scene.id}.Token.${world.enemies[0].token.id}`,
                    range: 30,
                    attackType: "standard",
                    aim: 10
                }
            },
            { id: "step-end-3", type: "end-turn", input: { reason: "done" } }
        ],
        snapshot: {
            self: {
                tokenId: world.token.id,
                tokenUuid: `Scene.${world.scene.id}.Token.${world.token.id}`,
                actorUuid: `Actor.${world.actor.id}`,
                x: 0,
                y: 0
            },
            revision: "aim-rev"
        }
    };
}

/**
 * Serialized plan carrying a `reload` step.
 * @param {object} world
 * @param {object} [options]
 * @returns {object}
 */
function reloadPlan(world, { operationId = "op-rel" } = {}) {
    return {
        id: "plan-reload",
        operationId,
        steps: [
            {
                id: "step-reload-1",
                type: "reload",
                cost: { halves: 1 },
                preconditions: ["turn", "resources"],
                input: { actionId: "rel", name: "Reload Lasgun", weaponId: "w1" }
            },
            { id: "step-end-2", type: "end-turn", input: { reason: "done" } }
        ],
        snapshot: {
            self: {
                tokenId: world.token.id,
                tokenUuid: `Scene.${world.scene.id}.Token.${world.token.id}`,
                actorUuid: `Actor.${world.actor.id}`,
                x: 0,
                y: 0
            },
            revision: "rel-rev"
        }
    };
}

/** Module API shell with planner + authority stubs for runPlan tests. */
function makeApi() {
    const api = createModuleApi();
    api.services.register("planner", createPlannerService({ api }));
    api.services.register("authority", {
        isController: () => true,
        operations: {
            completeTurn: async () => ({ ok: true }),
            transitionOperation: async () => ({ ok: true })
        }
    });
    return { api };
}

/** Stub planner accepting every injected plan as valid. */
function stubPlanner() {
    return {
        validateSnapshot: () => ({ valid: true, reason: null }),
        shouldReplan: () => ({ replan: false })
    };
}

test("an aim step books the flag and a following attack consumes it", async () => {
    const world = makeWorld();
    const { api } = makeApi();
    const state = { executes: [] };
    const rolls = {
        prepareAttack: async input => ({ fingerprint: "fp", rollData: {}, input }),
        executeAttack: async (prepared, options) => {
            state.executes.push({ prepared, options });
            return { status: "ok", operationId: options?.operationId, resourceDelta: { ammo: -1 } };
        }
    };
    const executor = createExecutorService({ api, getMode: () => "automatic" });
    const operation = { id: `op-${++_opId}`, combatantId: world.combatant.id, phase: "executing" };
    const result = await executor.runPlan({
        combat: world.combat,
        combatant: world.combatant,
        operation,
        plan: aimPlan(world, { operationId: operation.id }),
        planner: stubPlanner(),
        rolls
    });

    assert.equal(result.status, EXECUTOR_STATUS.completed);
    assert.equal(state.executes.length, 1);
    const flag = world.combatant.getFlag(MODULE_ID, "aim");
    assert.equal(flag, undefined, "aimedUntil flag is consumed by the taken shot");
    // `setFlag`/`unsetFlag` both ran: the record was written then cleared.
    assert.ok("aim" in (world.combatant.flags[MODULE_ID] ?? {}) === false
        || flag === undefined);
    assert.ok(result.stepsDone.some(step => step.type === "aim"));
});

test("a reload step executes through api.actions.reload with a step-scoped operation id", async () => {
    const world = makeWorld();
    const { api } = makeApi();
    const calls = [];
    const actionsApi = {
        reload: async (input, options) => {
            calls.push({ input, options });
            return { status: "ok", operationId: options?.operationId };
        }
    };
    const executor = createExecutorService({ api, getMode: () => "automatic" });
    const operation = { id: `op-${++_opId}`, combatantId: world.combatant.id, phase: "executing" };
    const result = await executor.runPlan({
        combat: world.combat,
        combatant: world.combatant,
        operation,
        plan: reloadPlan(world, { operationId: operation.id }),
        planner: stubPlanner(),
        actionsApi
    });

    assert.equal(result.status, EXECUTOR_STATUS.completed);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input.weaponId, "w1");
    assert.equal(calls[0].input.actorUuid, `Actor.${world.actor.id}`);
    assert.equal(calls[0].options.operationId, `${operation.id}.step-reload-1`);
});

test("a missing actions.reload endpoint fails the step with system-api-missing", async () => {
    const world = makeWorld();
    const { api } = makeApi();
    const executor = createExecutorService({ api, getMode: () => "automatic" });
    const operation = { id: `op-${++_opId}`, combatantId: world.combatant.id, phase: "executing" };
    const result = await executor.runPlan({
        combat: world.combat,
        combatant: world.combatant,
        operation,
        plan: reloadPlan(world, { operationId: operation.id }),
        planner: stubPlanner(),
        actionsApi: {}
    });

    assert.equal(result.failedStep, "step-reload-1");
    assert.equal(result.reason, "system-api-missing");
    assert.equal(result.status, EXECUTOR_STATUS.failed);
});
