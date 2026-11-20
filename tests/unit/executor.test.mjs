/**
 * Unit tests for the executor service (issue #407): step-by-step plan
 * execution through mocked Foundry/system APIs — happy path, per-step
 * snapshot validation, the single-replan policy, operation-id idempotency,
 * controller/config gating and terminal turn advancement.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createModuleApi } from "../../scripts/api.js";
import { createExecutorService, EXECUTOR_STATUS } from "../../scripts/executor.js";
import { createPlannerService } from "../../scripts/planner.js";
import {
    makeActor,
    makeCombatant,
    makeScene,
    makeToken
} from "./fixtures.mjs";

let _opId = 0;
let _combatId = 0;

/**
 * Minimal Combat fixture: `id`, `round`, `turn`, the `combatants`
 * collection, a `scene` reference and a `combatant` getter.
 * @param {object} [options]
 * @param {number} [options.round]
 * @param {number} [options.turn]
 * @param {object[]} [options.combatants]
 * @returns {object}
 */
function makeCombat({ round = 1, turn = 0, combatants = [] } = {}) {
    const collection = new Map(combatants.map(c => [c.id, c]));
    collection.contents = combatants;
    const combat = {
        documentName: "Combat",
        id: `combat-${++_combatId}`,
        round,
        turn,
        combatants: collection,
        turns: combatants,
        scene: null,
        ended: false,
        get combatant() {
            return this.turns[this.turn] ?? null;
        }
    };
    return combat;
}

/**
 * Build a small combat world: an AI-enabled NPC at (0, 0) and a hostile
 * enemy combatant. The NPC token gets `move`/`update` spies; the combat
 * gets a `nextTurn` spy.
 * @param {object} [options]
 * @param {{x: number, y: number}} [options.enemy] Enemy placement.
 * @param {string} [options.preset] Actor AI preset.
 * @param {boolean} [options.enabled] Actor AI config flag.
 * @returns {object}
 */
function makeWorld({ enemy = { x: 300, y: 0 }, preset = "assault", enabled = true } = {}) {
    const scene = makeScene({ grid: "square" });
    const actor = makeActor({ enabled, preset });
    actor.system = { wounds: { value: 12, max: 14 } };
    actor.items = [{
        id: "w1",
        uuid: `Actor.${actor.id}.Item.w1`,
        name: "Lasgun",
        type: "weapon",
        system: { class: "ranged", range: 30, damage: "1d10+3" }
    }];
    const token = makeToken({ actor });
    token.x = 0;
    token.y = 0;
    token.elevation = 0;
    token.disposition = -1;
    const moveCalls = [];
    const updateCalls = [];
    token.move = async (waypoints, options) => {
        moveCalls.push({ waypoints, options });
        const last = waypoints.at(-1);
        token.x = last.x;
        token.y = last.y;
        return true;
    };
    token.update = async data => {
        updateCalls.push(data);
        if (Number.isFinite(data.x)) token.x = data.x;
        if (Number.isFinite(data.y)) token.y = data.y;
        return token;
    };
    const combatant = makeCombatant({ actor, token });
    combatant.tokenId = token.id;
    combatant.initiative = 10;

    const enemyActor = makeActor();
    enemyActor.system = { wounds: { value: 10, max: 10 } };
    enemyActor.items = [];
    const enemyToken = makeToken({ actor: enemyActor });
    enemyToken.x = enemy.x;
    enemyToken.y = enemy.y;
    enemyToken.elevation = 0;
    enemyToken.disposition = 1;
    const enemyCombatant = makeCombatant({ actor: enemyActor, token: enemyToken });
    enemyCombatant.tokenId = enemyToken.id;

    const nextTurnCalls = { count: 0 };
    const combat = makeCombat({ round: 1, turn: 0, combatants: [combatant, enemyCombatant] });
    combat.scene = scene;
    combat.nextTurn = async () => {
        nextTurnCalls.count++;
        // Mirror Foundry semantics: nextTurn mutates (round, turn) so the
        // executor's advance verification sees a real transition.
        combat.turn += 1;
        return combat;
    };
    return {
        scene,
        actor,
        token,
        combatant,
        enemy: { actor: enemyActor, token: enemyToken, combatant: enemyCombatant },
        combat,
        moveCalls,
        updateCalls,
        nextTurnCalls
    };
}

/**
 * Module API with a real planner and an injectable authority mock.
 * @param {object} [options]
 * @param {boolean} [options.controller] `authority.isController` result.
 * @returns {object}
 */
function makeApi({ controller = true } = {}) {
    const api = createModuleApi();
    const planner = createPlannerService({ api });
    api.services.register("planner", planner);
    const completed = [];
    const operations = {
        completeTurn: async (combat, id, result) => {
            completed.push({ id, result });
            return { ok: true };
        },
        transitionOperation: async () => ({ ok: true })
    };
    const authority = {
        isController: () => controller,
        operations
    };
    api.services.register("authority", authority);
    return { api, planner, operations, authority, completed };
}

/**
 * Deterministic planTurn inputs: injected target/action/move lists that
 * produce a `move → attack → end-turn` plan for {@link makeWorld} (melee
 * range 2, injected move lands 1.5 units from the enemy).
 * @param {object} world
 * @param {object} [options]
 * @param {boolean} [options.melee] Melee weapon forcing a move-attack.
 * @returns {object} planContext for executor calls.
 */
function planContext(world, { melee = true } = {}) {
    return {
        seed: 7,
        targets: [{
            tokenId: world.enemy.token.id,
            tokenUuid: `Scene.${world.scene.id}.Token.${world.enemy.token.id}`,
            x: world.enemy.token.x,
            y: world.enemy.token.y,
            elevation: 0,
            canAttack: true,
            source: "injected"
        }],
        actions: [{
            id: "attack-1",
            type: "attack",
            name: melee ? "Knife strike" : "Lasgun shot",
            itemUuid: `Actor.${world.actor.id}.Item.w1`,
            itemId: "w1",
            class: melee ? "melee" : "ranged",
            range: melee ? 2 : 30,
            damage: 5,
            cost: 1
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
        }]
    };
}

/**
 * Install a mocked `game.darkHeresy.api.rolls` recording calls.
 * @returns {object} Spy state.
 */
function mockRolls() {
    const state = {
        prepareCalls: [],
        executeCalls: [],
        outcome: null,
        onExecute: null
    };
    game.darkHeresy.api.rolls = {
        prepareAttack: async input => {
            state.prepareCalls.push(input);
            return { fingerprint: "fp1", rollData: {}, input };
        },
        executeAttack: async (prepared, options) => {
            state.executeCalls.push({ prepared, options });
            if (typeof state.onExecute === "function") state.onExecute();
            return state.outcome ?? {
                status: "ok",
                operationId: options?.operationId,
                chatMessageIds: ["chat-msg-1"],
                resourceDelta: { ammo: -1 }
            };
        }
    };
    return state;
}

/** Remove the mocked rolls API after a test. */
function clearRolls() {
    delete game.darkHeresy.api.rolls;
}

test("happy path: move + attack + end-turn executes and advances the turn", async () => {
    const world = makeWorld();
    const { api, completed } = makeApi();
    const rolls = mockRolls();
    try {
        const executor = createExecutorService({ api, getMode: () => "automatic" });
        const operation = { id: `op-${++_opId}`, combatantId: world.combatant.id, phase: "executing" };
        const result = await executor.runPlan({
            combat: world.combat,
            combatant: world.combatant,
            operation,
            planContext: planContext(world)
        });

        assert.equal(result.status, EXECUTOR_STATUS.completed);
        assert.equal(result.operationId, operation.id);
        assert.equal(result.stepsDone.length, 3);
        assert.deepEqual(result.stepsDone.map(s => s.type), ["move", "attack", "end-turn"]);

        // Token moved through the serialized waypoints to the endpoint.
        assert.equal(world.moveCalls.length, 1);
        assert.equal(world.token.x, 200);
        assert.equal(world.token.y, 0);
        const last = world.moveCalls[0].waypoints.at(-1);
        assert.deepEqual({ x: last.x, y: last.y }, { x: 200, y: 0 });

        // Attack executed exactly once with a step-scoped operation id.
        assert.equal(rolls.executeCalls.length, 1);
        assert.equal(rolls.executeCalls[0].options.operationId, `${operation.id}.step-attack-2`);

        // Resources were spent exactly once: movement cost + ammo delta.
        assert.equal(result.resourceDelta.movement, -2);
        assert.equal(result.resourceDelta.ammo, -1);
        assert.deepEqual(result.chatMessageIds, ["chat-msg-1"]);

        // Operation closed and the turn advanced exactly once.
        assert.equal(completed.length, 1);
        assert.equal(completed[0].id, operation.id);
        assert.equal(world.nextTurnCalls.count, 1);
    } finally {
        clearRolls();
    }
});

test("a stale state mid-plan triggers exactly one replan", async () => {
    const world = makeWorld();
    const { api, planner } = makeApi();
    const rolls = mockRolls();
    let planTurnCalls = 0;
    const countingPlanner = {
        ...planner,
        planTurn: async (...args) => {
            planTurnCalls++;
            return planner.planTurn(...args);
        }
    };
    try {
        const executor = createExecutorService({ api, getMode: () => "automatic" });
        // Manual intervention: the token is dragged elsewhere right after
        // the executor's own move — validation before the attack sees
        // `token-moved` and replans once on the new snapshot.
        const baseMove = world.token.move;
        world.token.move = async (...args) => {
            const result = await baseMove(...args);
            world.token.x = 250;
            return result;
        };
        const result = await executor.runPlan({
            combat: world.combat,
            combatant: world.combatant,
            operation: { id: `op-${++_opId}`, combatantId: world.combatant.id, phase: "executing" },
            planner: countingPlanner,
            planContext: planContext(world)
        });

        assert.equal(planTurnCalls, 2, "expected one original plan + one replan");
        assert.equal(result.status, EXECUTOR_STATUS.completed);
        assert.equal(result.replanCount, 1);
        assert.equal(rolls.executeCalls.length, 1);
        assert.equal(world.nextTurnCalls.count, 1);
    } finally {
        clearRolls();
    }
});

test("a second stale stops the turn with hold-and-report diagnostics", async () => {
    // The enemy is far away so every (re)plan keeps a move step whose mock
    // re-triggers the external drag — each follow-up validation is stale.
    const world = makeWorld({ enemy: { x: 3000, y: 0 } });
    const { api } = makeApi();
    const rolls = mockRolls();
    const warnings = [];
    const originalWarn = ui.notifications.warn;
    ui.notifications.warn = msg => warnings.push(msg);
    try {
        const executor = createExecutorService({ api, getMode: () => "automatic" });
        const baseMove = world.token.move;
        world.token.move = async (...args) => {
            const result = await baseMove(...args);
            // Drag the token after every executor move so each follow-up
            // validation reports `token-moved`.
            world.token.x += 50;
            return result;
        };
        const result = await executor.runPlan({
            combat: world.combat,
            combatant: world.combatant,
            operation: { id: `op-${++_opId}`, combatantId: world.combatant.id, phase: "executing" },
            planContext: planContext(world)
        });

        assert.equal(result.status, EXECUTOR_STATUS.partial);
        assert.equal(result.reason, "replan-limit-exceeded");
        assert.equal(result.replanCount, 1);
        assert.ok(result.stepsDone.some(s => s.type === "move" && s.status === "done"));
        assert.equal(rolls.executeCalls.length, 0, "attack never ran");
        assert.equal(world.nextTurnCalls.count, 1, "terminal status still ends the turn");
        assert.ok(warnings.length >= 1, "GM warning was emitted");
    } finally {
        ui.notifications.warn = originalWarn;
        clearRolls();
    }
});

test("a non-controller client returns not-controller without touching documents", async () => {
    const world = makeWorld();
    const { api, completed } = makeApi({ controller: false });
    const rolls = mockRolls();
    try {
        const executor = createExecutorService({ api, getMode: () => "automatic" });
        const result = await executor.runPlan({
            combat: world.combat,
            combatant: world.combatant,
            operation: { id: `op-${++_opId}`, combatantId: world.combatant.id, phase: "executing" },
            planContext: planContext(world)
        });

        assert.equal(result.status, EXECUTOR_STATUS.cancelled);
        assert.equal(result.reason, "not-controller");
        assert.equal(world.moveCalls.length, 0);
        assert.equal(world.updateCalls.length, 0);
        assert.equal(rolls.executeCalls.length, 0);
        assert.equal(completed.length, 0);
        assert.equal(world.nextTurnCalls.count, 0);
    } finally {
        clearRolls();
    }
});

test("repeated executePlan with the same operationId returns the stored result", async () => {
    const world = makeWorld();
    const { api, planner } = makeApi();
    const rolls = mockRolls();
    try {
        const executor = createExecutorService({ api, getMode: () => "automatic" });
        const planning = await planner.planTurn(world.combat, world.combatant, {
            ...planContext(world, { melee: false })
        });
        assert.equal(planning.status, "ok");
        const context = {
            combat: world.combat,
            combatant: world.combatant,
            operationId: `op-${++_opId}`
        };
        const first = await executor.executePlan(planning.plan, context);
        const second = await executor.executePlan(planning.plan, context);

        assert.equal(first.status, EXECUTOR_STATUS.completed);
        assert.strictEqual(second, first, "same stored result is returned");
        assert.equal(rolls.executeCalls.length, 1, "system API deduped too");
        assert.equal(world.nextTurnCalls.count, 1);
    } finally {
        clearRolls();
    }
});

test("a move step is skipped when the token already sits on the endpoint", async () => {
    const world = makeWorld();
    const { api, planner } = makeApi();
    mockRolls();
    try {
        const executor = createExecutorService({ api, getMode: () => "automatic" });
        // A real plan snapshot with a hand-picked move step back to the
        // current position — the executor must short-circuit it.
        const planning = await planner.planTurn(world.combat, world.combatant, planContext(world));
        assert.equal(planning.status, "ok");
        const plan = {
            ...planning.plan,
            steps: [
                { id: "step-move-1", type: "move", input: { to: { x: 0, y: 0 } }, projectedResourceDelta: {} },
                { id: "step-end-turn-2", type: "end-turn", input: {}, projectedResourceDelta: {} }
            ]
        };
        const result = await executor.executePlan(plan, {
            combat: world.combat,
            combatant: world.combatant,
            operationId: `op-${++_opId}`
        });

        assert.equal(result.status, EXECUTOR_STATUS.completed);
        const moveStep = result.stepsDone.find(s => s.type === "move");
        assert.equal(moveStep.status, "skipped");
        assert.equal(moveStep.reason, "already-at-endpoint");
        assert.equal(world.moveCalls.length, 0);
        assert.equal(world.updateCalls.length, 0);
        assert.equal(world.nextTurnCalls.count, 1);
    } finally {
        clearRolls();
    }
});

test("partial failure after a spent attack never spends resources twice", async () => {
    const world = makeWorld();
    const { api } = makeApi();
    const rolls = mockRolls();
    try {
        const executor = createExecutorService({ api, getMode: () => "automatic" });
        // After the successful attack an external token move makes the
        // follow-up validation stale; the replanned attack is skipped
        // because the action budget was already spent.
        rolls.onExecute = () => {
            world.token.x = 50;
        };
        const result = await executor.runPlan({
            combat: world.combat,
            combatant: world.combatant,
            operation: { id: `op-${++_opId}`, combatantId: world.combatant.id, phase: "executing" },
            planContext: planContext(world, { melee: false })
        });

        assert.equal(result.status, EXECUTOR_STATUS.partial);
        assert.equal(rolls.executeCalls.length, 1, "attack ran exactly once");
        assert.equal(result.resourceDelta.ammo, -1, "ammo spent once");
        const skipped = result.stepsDone.filter(s => s.status === "skipped");
        assert.ok(skipped.some(s => s.reason === "action-budget-spent"));
        assert.equal(world.nextTurnCalls.count, 1);
    } finally {
        clearRolls();
    }
});

test("a disabled effective config refuses execution without advancing", async () => {
    const world = makeWorld({ enabled: false });
    const { api, completed } = makeApi();
    const rolls = mockRolls();
    try {
        const executor = createExecutorService({ api, getMode: () => "automatic" });
        const result = await executor.runPlan({
            combat: world.combat,
            combatant: world.combatant,
            operation: { id: `op-${++_opId}`, combatantId: world.combatant.id, phase: "executing" },
            planContext: planContext(world)
        });

        assert.equal(result.status, EXECUTOR_STATUS.cancelled);
        assert.equal(result.reason, "config-disabled");
        assert.equal(world.moveCalls.length, 0);
        assert.equal(rolls.executeCalls.length, 0);
        // The operation is closed but the turn stays under manual control.
        assert.equal(completed.length, 1);
        assert.equal(completed[0].result.advanceTurn, false);
        assert.equal(world.nextTurnCalls.count, 0);
    } finally {
        clearRolls();
    }
});

test("the master switch refuses execution without advancing", async () => {
    const world = makeWorld();
    const { api, completed } = makeApi();
    const rolls = mockRolls();
    try {
        const executor = createExecutorService({
            api,
            getMode: () => "automatic",
            isEnabled: () => false
        });
        const result = await executor.runPlan({
            combat: world.combat,
            combatant: world.combatant,
            operation: { id: `op-${++_opId}`, combatantId: world.combatant.id, phase: "executing" },
            planContext: planContext(world)
        });

        assert.equal(result.status, EXECUTOR_STATUS.cancelled);
        assert.equal(result.reason, "module-disabled");
        assert.equal(world.moveCalls.length, 0);
        assert.equal(rolls.executeCalls.length, 0);
        // The operation is closed but the turn stays under manual control.
        assert.equal(completed.length, 1);
        assert.equal(completed[0].result.advanceTurn, false);
        assert.equal(world.nextTurnCalls.count, 0);
    } finally {
        clearRolls();
    }
});

test("a missing system rolls API stops safely with system-api-missing", async () => {
    const world = makeWorld();
    const { api, completed } = makeApi();
    clearRolls();
    const executor = createExecutorService({ api, getMode: () => "automatic" });
    const result = await executor.runPlan({
        combat: world.combat,
        combatant: world.combatant,
        operation: { id: `op-${++_opId}`, combatantId: world.combatant.id, phase: "executing" },
        planContext: planContext(world)
    });

    assert.equal(result.status, EXECUTOR_STATUS.partial);
    assert.equal(result.reason, "system-api-missing");
    assert.equal(completed.length, 1);
    assert.equal(world.nextTurnCalls.count, 1, "terminal failure still ends the turn");
});

test("preview mode plans and validates without any state changes", async () => {
    const world = makeWorld();
    const { api, completed } = makeApi();
    const rolls = mockRolls();
    try {
        const executor = createExecutorService({ api, getMode: () => "preview" });
        const result = await executor.runPlan({
            combat: world.combat,
            combatant: world.combatant,
            operation: { id: `op-${++_opId}`, combatantId: world.combatant.id, phase: "awaiting-preview" },
            planContext: planContext(world)
        });

        assert.equal(result.status, EXECUTOR_STATUS.preview);
        assert.equal(result.reason, "preview-mode");
        assert.ok(result.plan, "computed plan is returned for the GM");
        assert.equal(world.moveCalls.length, 0);
        assert.equal(world.updateCalls.length, 0);
        assert.equal(rolls.executeCalls.length, 0);
        assert.equal(completed.length, 0);
        assert.equal(world.nextTurnCalls.count, 0);
    } finally {
        clearRolls();
    }
});

test("an aborted authority signal cancels execution without writes", async () => {
    const world = makeWorld();
    const { api, completed } = makeApi();
    const rolls = mockRolls();
    try {
        const executor = createExecutorService({ api, getMode: () => "automatic" });
        const signal = { aborted: false };
        const baseMove = world.token.move;
        world.token.move = async (...args) => {
            const result = await baseMove(...args);
            signal.aborted = true;
            return result;
        };
        const result = await executor.runPlan({
            combat: world.combat,
            combatant: world.combatant,
            operation: { id: `op-${++_opId}`, combatantId: world.combatant.id, phase: "executing" },
            signal,
            planContext: planContext(world)
        });

        assert.equal(result.status, EXECUTOR_STATUS.cancelled);
        assert.equal(result.reason, "controller-changed");
        assert.equal(rolls.executeCalls.length, 0);
        assert.equal(completed.length, 0);
        assert.equal(world.nextTurnCalls.count, 0);
    } finally {
        clearRolls();
    }
});
