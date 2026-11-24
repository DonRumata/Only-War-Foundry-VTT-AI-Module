/**
 * Unit tests for the issue #37 action economy (second half):
 * `ready-weapon`/`drop-prone` free-action candidates, the `reactionUsed`
 * combatant flag and reset service, attack adjudication (`gm-confirm`),
 * dodge-aware counter-EV (`EV × (1 − P(dodge))`, undodgeable attacks,
 * spent-reaction bonus) and the weapon preference/inertia factors.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createModuleApi } from "../../scripts/api.js";
import { resolveEffectiveConfig } from "../../scripts/config-resolver.js";
import { createExecutorService, EXECUTOR_STATUS } from "../../scripts/executor.js";
import { personalityWeaponAffinity } from "../../scripts/personalities.js";
import {
    createPlannerService,
    dodgeChanceOf,
    PLANNER_STATUS
} from "../../scripts/planner.js";
import {
    createReactionsService,
    reactionUsed
} from "../../scripts/reactions.js";
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
        id: `combat-37-${++_combatId}`,
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
 * @param {object} [extra] Extra normalized fields for every target.
 * @returns {object[]}
 */
function targetsOf(world, extra = {}) {
    return world.enemies.map(enemy => ({
        tokenId: enemy.token.id,
        tokenUuid: `Scene.${world.scene.id}.Token.${enemy.token.id}`,
        x: enemy.token.x,
        y: enemy.token.y,
        elevation: 0,
        canAttack: true,
        source: "injected",
        ...extra
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

/** Explicit ready entry as the system `actions.list` would emit it. */
function readyAction({ id = "ready-knife", cost = "free" } = {}) {
    return {
        id,
        kind: "ready-weapon",
        name: "Ready Knife",
        weaponId: "w2",
        itemUuid: "a.k",
        cost,
        available: true
    };
}

/** Module API shell with planner + authority stubs for runPlan tests. */
function makeApi({ controller = true } = {}) {
    const api = createModuleApi();
    api.services.register("planner", createPlannerService({ api }));
    api.services.register("authority", {
        isController: () => controller,
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

/** Rolls stub counting executed roll types. */
function stubRolls(state = {}) {
    state.prepares = [];
    state.executes = [];
    const make = kind => ({
        [`prepare${kind}`]: async input => {
            state.prepares.push({ kind, input });
            return { fingerprint: "fp", rollData: {}, input };
        },
        [`execute${kind}`]: async (prepared, options) => {
            state.executes.push({ kind, prepared, options });
            return { status: "ok", operationId: options?.operationId, resourceDelta: { ammo: -1 } };
        }
    });
    return { ...make("Attack"), ...make("Test") };
}

/**
 * Serialized plan carrying a single `attack` step (+ end-turn) for
 * adjudication/executor tests — mirrors `_stepsFor` output.
 * @param {object} world
 * @param {object} [options]
 * @returns {object}
 */
function attackPlan(world, { operationId = "op-attack" } = {}) {
    return {
        id: "plan-attack-37",
        operationId,
        steps: [
            {
                id: "step-attack-1",
                type: "attack",
                cost: { halves: 1 },
                preconditions: ["turn", "target", "resources"],
                input: {
                    actionId: "las",
                    name: "Lasgun",
                    itemUuid: `Actor.${world.actor.id}.Item.w1`,
                    targetTokenUuid: `Scene.${world.scene.id}.Token.${world.enemies[0].token.id}`,
                    range: 30,
                    attackType: "standard"
                }
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
            revision: "attack-rev"
        }
    };
}

/**
 * Serialized plan with one step of a custom type — used by the
 * `ready-weapon`/`drop-prone` executor tests.
 * @param {object} world
 * @param {string} type Step type.
 * @param {object} input Step input.
 * @param {object} [options]
 * @returns {object}
 */
function stepPlan(world, type, input, { operationId = `op-${type}` } = {}) {
    return {
        id: `plan-${type}`,
        operationId,
        steps: [
            {
                id: `step-${type}-1`,
                type,
                cost: { halves: 0 },
                preconditions: ["turn"],
                input
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
            revision: `${type}-rev`
        }
    };
}

// ---- Free actions -----------------------------------------------------

test("a system ready-weapon entry produces a ready-weapon step with its own cost", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    planner.registerPreset("assault", {
        weights: { readyWeapon: 10 },
        allowNoAction: true
    });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world),
        actions: [readyAction({ cost: "free" })],
        moves: []
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const types = result.plan.steps.map(step => step.type);
    assert.deepEqual(types, ["ready-weapon", "end-turn"]);
    const step = result.plan.steps[0];
    assert.equal(step.input.weaponId, "w2");
    assert.equal(step.input.itemUuid, "a.k");
    assert.equal(step.cost.halves, 0, "system-provided free cost passes through");
});

test("a half-cost system ready entry consumes the half budget", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    planner.registerPreset("assault", {
        weights: { readyWeapon: 10 },
        allowNoAction: true
    });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world),
        actions: [readyAction({ cost: "half" })],
        moves: []
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const step = result.plan.steps.find(entry => entry.type === "ready-weapon");
    assert.ok(step, "ready-weapon step exists");
    assert.equal(step.cost.halves, 1);
});

test("a dry action list still plans a ready-weapon turn instead of no-action", async () => {
    // No usable attack entries at all — before #37 this ended in
    // `no-action`; the ready entry keeps a legal plan alive.
    const world = makeWorld();
    const planner = createPlannerService();
    planner.registerPreset("assault", {
        weights: { readyWeapon: 10 },
        allowNoAction: false
    });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world),
        actions: [readyAction()],
        moves: []
    });
    assert.equal(result.status, PLANNER_STATUS.ok, JSON.stringify(result));
    assert.ok(result.plan.steps.some(step => step.type === "ready-weapon"));
});

test("an inventory weapon becomes a synthesized ready candidate when the clip is dry", async () => {
    // The lasgun's action entry exists but its clip reads 0 — the
    // inventory knife backing no usable attack becomes a half-cost
    // ready candidate (draw/equip the alternative weapon).
    const world = makeWorld();
    world.actor.items = [
        {
            id: "w1", uuid: "a.l", type: "weapon", name: "Lasgun",
            system: { class: "basic", range: 30, clip: { value: 0, max: 30 } }
        },
        { id: "w9", uuid: "a.k9", type: "weapon", name: "Knife", system: { class: "melee" } }
    ];
    const planner = createPlannerService();
    planner.registerPreset("assault", {
        weights: { readyWeapon: 10 },
        allowNoAction: true
    });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world),
        actions: [lasgunAction()],
        moves: [],
        // Issue #53: the synthesized candidate is only offered when the
        // system exposes a ready/draw endpoint to run it through.
        actionsApi: { readyWeapon: async () => ({ ok: true }) }
    });
    assert.equal(result.status, PLANNER_STATUS.ok, JSON.stringify(result));
    const step = result.plan.steps.find(entry => entry.type === "ready-weapon");
    assert.ok(step, "ready-weapon step exists");
    assert.equal(step.input.weaponId, "w9");
    assert.equal(step.cost.halves, 1, "synthesized entries cost a half action");
});

test("a dry inventory without a ready API offers no synthesized candidates (issue #53)", async () => {
    const world = makeWorld();
    world.actor.items = [
        {
            id: "w1", uuid: "a.l", type: "weapon", name: "Lasgun",
            system: { class: "basic", range: 30, clip: { value: 0, max: 30 } }
        },
        { id: "w9", uuid: "a.k9", type: "weapon", name: "Knife", system: { class: "melee" } }
    ];
    const planner = createPlannerService();
    planner.registerPreset("assault", {
        weights: { readyWeapon: 100 },
        allowNoAction: true,
        alwaysOfferHold: true
    });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world),
        actions: [lasgunAction()],
        moves: []
        // No actionsApi and no game.darkHeresy.api.actions endpoint —
        // the bot quietly holds instead of planning a step it cannot run.
    });
    assert.equal(result.status, PLANNER_STATUS.ok, JSON.stringify(result));
    assert.ok(result.plan.steps.every(step => step.type !== "ready-weapon"),
        "no executable endpoint → no ready-weapon step");
});

test("a fully loaded loadout never offers ready-weapon candidates", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    planner.registerPreset("assault", { weights: { attackNow: 10, readyWeapon: 100 } });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world),
        actions: [lasgunAction()],
        moves: []
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.ok(result.plan.steps.some(step => step.type === "attack"));
    assert.ok(!result.plan.diagnostics.ranking.some(entry =>
        String(entry.candidate).startsWith("ready-weapon|")),
        "no ready candidates while a weapon still fires");
});

test("a pinned bot may drop prone as its free-action turn", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    planner.registerPreset("assault", {
        weights: { dropProne: 50 },
        alwaysOfferHold: true
    });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world),
        actions: [lasgunAction()],
        moves: [],
        selfStatuses: ["pinned"]
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const types = result.plan.steps.map(step => step.type);
    assert.deepEqual(types, ["drop-prone", "end-turn"]);
    assert.equal(result.plan.steps[0].input.statusId, "prone");
});

test("an already prone bot gets no drop-prone candidate", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    planner.registerPreset("assault", { weights: { attackNow: 10, dropProne: 100 } });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world),
        actions: [lasgunAction()],
        moves: [],
        selfStatuses: ["prone"]
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.ok(result.plan.steps.every(step => step.type !== "drop-prone"));
    assert.ok(!result.plan.diagnostics.ranking.some(entry =>
        String(entry.candidate).startsWith("drop-prone|")));
});

test("a healthy calm bot never offers drop-prone", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    planner.registerPreset("assault", { weights: { attackNow: 10, dropProne: 100 } });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world),
        actions: [lasgunAction()],
        moves: []
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.ok(!result.plan.diagnostics.ranking.some(entry =>
        String(entry.candidate).startsWith("drop-prone|")),
        "drop-prone requires pinning or a real kill lane");
});

// ---- Executor steps ---------------------------------------------------

test("a ready-weapon step executes through api.actions.readyWeapon", async () => {
    const world = makeWorld();
    const { api } = makeApi();
    const calls = [];
    const actionsApi = {
        readyWeapon: async (input, options) => {
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
        plan: stepPlan(world, "ready-weapon",
            { weaponId: "w2", itemUuid: "a.k" }, { operationId: operation.id }),
        planner: stubPlanner(),
        actionsApi
    });
    assert.equal(result.status, EXECUTOR_STATUS.completed);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input.weaponId, "w2");
    assert.equal(calls[0].input.actorUuid, `Actor.${world.actor.id}`);
    assert.equal(calls[0].options.operationId, `${operation.id}.step-ready-weapon-1`);
});

test("a missing actions.readyWeapon endpoint fails the step with system-api-missing", async () => {
    const world = makeWorld();
    const { api } = makeApi();
    const executor = createExecutorService({ api, getMode: () => "automatic" });
    const operation = { id: `op-${++_opId}`, combatantId: world.combatant.id, phase: "executing" };
    const result = await executor.runPlan({
        combat: world.combat,
        combatant: world.combatant,
        operation,
        plan: stepPlan(world, "ready-weapon", { weaponId: "w2" }),
        planner: stubPlanner(),
        actionsApi: {}
    });
    assert.equal(result.failedStep, "step-ready-weapon-1");
    assert.equal(result.reason, "system-api-missing");
    assert.equal(result.status, EXECUTOR_STATUS.failed);
});

test("a drop-prone step toggles the prone status through the actions API", async () => {
    const world = makeWorld();
    const { api } = makeApi();
    const calls = [];
    const actionsApi = {
        dropProne: async (input, options) => {
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
        plan: stepPlan(world, "drop-prone", { statusId: "prone" }),
        planner: stubPlanner(),
        actionsApi
    });
    assert.equal(result.status, EXECUTOR_STATUS.completed);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input.actorUuid, `Actor.${world.actor.id}`);
});

test("a drop-prone step falls back to actor.toggleStatusEffect without the API", async () => {
    const world = makeWorld();
    const { api } = makeApi();
    const toggles = [];
    world.actor.toggleStatusEffect = async (id, options) => {
        toggles.push({ id, options });
        return true;
    };
    const executor = createExecutorService({ api, getMode: () => "automatic" });
    const operation = { id: `op-${++_opId}`, combatantId: world.combatant.id, phase: "executing" };
    const result = await executor.runPlan({
        combat: world.combat,
        combatant: world.combatant,
        operation,
        plan: stepPlan(world, "drop-prone", { statusId: "prone" }),
        planner: stubPlanner(),
        actionsApi: {}
    });
    assert.equal(result.status, EXECUTOR_STATUS.completed);
    assert.deepEqual(toggles, [{ id: "prone", options: { active: true } }]);
});

// ---- Reaction flag ----------------------------------------------------

test("reactionUsed() truthiness follows the recorded round", () => {
    assert.equal(reactionUsed(null, 1), false);
    assert.equal(reactionUsed(true, 1), true);
    assert.equal(reactionUsed({ round: 1 }, 1), true);
    // A record without a usable round counts conservatively as spent.
    assert.equal(reactionUsed({ round: null }, 1), true);
    assert.equal(reactionUsed({}, 1), true);
    // A mark from an older round is already expired state.
    assert.equal(reactionUsed({ round: 1 }, 2), false);
});

test("markUsed writes the flag on the controller client only", async () => {
    const world = makeWorld();
    const { api } = makeApi({ controller: true });
    const service = createReactionsService({ api });
    const outcome = await service.markUsed({
        combat: world.combat,
        combatant: world.combatant,
        reason: "dodge"
    });
    assert.equal(outcome.ok, true);
    const record = world.combatant.getFlag(MODULE_ID, "reactionUsed");
    assert.equal(record.round, 1);
    assert.equal(record.reason, "dodge");

    const { api: playerApi } = makeApi({ controller: false });
    const other = createReactionsService({ api: playerApi });
    const refused = await other.markUsed({
        combat: world.combat,
        combatant: world.enemies[0]
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "not-controller");
    assert.equal(world.enemies[0].getFlag(MODULE_ID, "reactionUsed"), undefined,
        "a non-controller never writes the flag");
});

test("the owner's turn start refreshes the reaction flag", async () => {
    const world = makeWorld();
    const { api } = makeApi();
    const service = createReactionsService({ api });
    await world.combatant.setFlag(MODULE_ID, "reactionUsed", { round: 1, reason: "dodge" });
    // A turn change to this combatant clears the current-round flag.
    service.handleUpdateCombat(world.combat, { turn: 0 });
    assert.equal(world.combatant.getFlag(MODULE_ID, "reactionUsed"), undefined);
    // A non-turn diff (e.g. a flag write) never refreshes anything.
    await world.combatant.setFlag(MODULE_ID, "reactionUsed", { round: 1, reason: "dodge" });
    service.handleUpdateCombat(world.combat, { current: true });
    assert.equal(world.combatant.getFlag(MODULE_ID, "reactionUsed")?.round, 1);
});

test("a spent-reaction target scores as vulnerable with a zero dodge", async () => {
    const world = makeWorld();
    // The *target's own* combatant flag drives the counter-EV — not an
    // injected convenience field.
    await world.enemies[0].setFlag(MODULE_ID, "reactionUsed", { usedRound: 1 });
    const planner = createPlannerService();
    planner.registerPreset("assault", { weights: { attackNow: 10 } });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world),
        actions: [lasgunAction()],
        moves: []
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.equal(result.plan.breakdown.factors.vulnerable, 1,
        "spent reaction reads as vulnerable");
    assert.deepEqual(result.plan.breakdown.dodge, { dodgeable: true, chance: 0 });
});

test("a spent reaction vetoes new overwatch declarations", async () => {
    // Enemy beyond weapon range: overwatch would normally be the plan —
    // with the reaction slot already spent it drops out of candidates.
    const world = makeWorld({ enemies: [{ x: 90000, y: 0 }], preset: "hold" });
    await world.combatant.setFlag(MODULE_ID, "reactionUsed", { usedRound: 1 });
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
    assert.ok(result.plan.steps.every(step => step.type !== "overwatch"));
    assert.ok(result.plan.diagnostics.rejected.some(entry =>
        entry.reason === "reaction-used"),
        JSON.stringify(result.plan.diagnostics.rejected));
});

// ---- Counter-EV / dodge ----------------------------------------------

test("dodgeChanceOf models dodgeable, undodgeable and reaction-spent cases", () => {
    const attack = { type: "attack", attackType: "standard" };
    assert.deepEqual(dodgeChanceOf({}, attack), { dodgeable: true, chance: 0.3 });
    assert.deepEqual(dodgeChanceOf({ dodge: 80 }, attack), { dodgeable: true, chance: 0.8 });
    // Spray/cone attacks are never dodged.
    assert.deepEqual(
        dodgeChanceOf({}, { type: "attack", attackType: "suppressing_fire" }),
        { dodgeable: false, chance: 0 }
    );
    assert.deepEqual(
        dodgeChanceOf({}, { type: "attack", spray: true }),
        { dodgeable: false, chance: 0 }
    );
    // A spent reaction means a defenseless target.
    assert.deepEqual(
        dodgeChanceOf({ reactionUsed: true, dodge: 80 }, attack),
        { dodgeable: true, chance: 0 }
    );
    // Blast attacks dodge only when the half-move provably clears the zone.
    const blast = { type: "attack", blastRadius: 5 };
    assert.deepEqual(dodgeChanceOf({}, blast), { dodgeable: false, chance: 0 });
    assert.deepEqual(
        dodgeChanceOf({ halfMove: 6 }, blast),
        { dodgeable: true, chance: 0.3 }
    );
    // Non-attack entries are never dodgeable.
    assert.deepEqual(dodgeChanceOf({}, { type: "reload" }), { dodgeable: false, chance: 0 });
});

test("dodge reduces the damage-scaled EV of dodgeable attacks", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    planner.registerPreset("assault", { weights: { attackNow: 10, attackType: 1, ev: 1 } });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world, { dodge: 60 }),
        actions: [{ ...lasgunAction(), damage: 10 }],
        moves: []
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    // attackType keeps the raw desire; the EV = damageNorm×desire×(1−P)
    // rides its own factor: 0.5 × 0.5 × (1 − 0.6) = 0.1.
    assert.equal(result.plan.breakdown.factors.attackType, 0.5,
        "attackType stays the raw desire — the dodge cut lives on ev");
    assert.ok(Math.abs(result.plan.breakdown.factors.ev - 0.1) < 1e-9,
        JSON.stringify(result.plan.breakdown.factors));
    assert.deepEqual(result.plan.breakdown.dodge, { dodgeable: true, chance: 0.6 });
});

test("undodgeable attacks keep their full attack-type EV", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    planner.registerPreset("assault", { weights: { attackNow: 10, attackType: 1 } });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world, { dodge: 90 }),
        // Suppression cones sweep the friendly/neutral veto — the enemy
        // coverage scan is injected (self never lists itself).
        blastTokens: world.enemies.map(enemy => ({
            tokenId: enemy.token.id,
            tokenUuid: `Scene.${world.scene.id}.Token.${enemy.token.id}`,
            x: enemy.token.x,
            y: enemy.token.y,
            disposition: 1
        })),
        actions: [{
            ...lasgunAction(),
            attackType: "suppressing_fire",
            requirements: ["template"],
            damage: 10
        }],
        moves: []
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.equal(result.plan.breakdown.factors.attackType, 0.55,
        "suppression desire is never cut by dodge");
    assert.equal(result.plan.breakdown.factors.ev, 0.275,
        "undodgeable keeps the full damage-scaled EV (0.5 × 0.55)");
    assert.deepEqual(result.plan.breakdown.dodge, { dodgeable: false, chance: 0 });
});

// ---- Adjudication -----------------------------------------------------

test("gm-confirm executes the attack when the GM picks execute", async () => {
    const world = makeWorld();
    const { api } = makeApi();
    const state = {};
    const asked = [];
    const executor = createExecutorService({ api, getMode: () => "automatic" });
    const operation = { id: `op-${++_opId}`, combatantId: world.combatant.id, phase: "executing" };
    const result = await executor.runPlan({
        combat: world.combat,
        combatant: world.combatant,
        operation,
        plan: attackPlan(world, { operationId: operation.id }),
        planner: stubPlanner(),
        rolls: stubRolls(state),
        adjudicationMode: "gm-confirm",
        adjudication: async request => {
            asked.push(request);
            return "execute";
        }
    });
    assert.equal(result.status, EXECUTOR_STATUS.completed);
    assert.equal(asked.length, 1, "the GM was consulted once");
    assert.equal(asked[0].stepId, "step-attack-1");
    assert.equal(state.executes.length, 1);
    assert.equal(state.executes[0].kind, "Attack");
});

test("gm-confirm manual marks the step done without a system roll", async () => {
    const world = makeWorld();
    const { api } = makeApi();
    const state = {};
    const executor = createExecutorService({ api, getMode: () => "automatic" });
    const operation = { id: `op-${++_opId}`, combatantId: world.combatant.id, phase: "executing" };
    const result = await executor.runPlan({
        combat: world.combat,
        combatant: world.combatant,
        operation,
        plan: attackPlan(world, { operationId: operation.id }),
        planner: stubPlanner(),
        rolls: stubRolls(state),
        adjudicationMode: "gm-confirm",
        adjudication: async () => "manual"
    });
    assert.equal(result.status, EXECUTOR_STATUS.completed);
    assert.equal(state.executes.length, 0, "no system roll was made");
    const step = result.stepsDone.find(entry => entry.stepId === "step-attack-1");
    assert.equal(step.status, "done");
    assert.equal(step.reason, "adjudicated-manual");
});

test("gm-confirm cancel stops the turn and hands it back to the GM", async () => {
    const world = makeWorld();
    const { api } = makeApi();
    const state = {};
    const completes = [];
    const executor = createExecutorService({ api, getMode: () => "automatic" });
    const operation = { id: `op-${++_opId}`, combatantId: world.combatant.id, phase: "executing" };
    const result = await executor.runPlan({
        combat: world.combat,
        combatant: world.combatant,
        operation,
        operations: {
            completeTurn: async (combat, id, payload) => {
                completes.push({ id, payload });
                return { ok: true };
            }
        },
        plan: attackPlan(world, { operationId: operation.id }),
        planner: stubPlanner(),
        rolls: stubRolls(state),
        adjudicationMode: "gm-confirm",
        adjudication: async () => "cancel"
    });
    assert.equal(result.status, EXECUTOR_STATUS.cancelled);
    assert.equal(result.reason, "adjudication-cancelled");
    assert.equal(state.executes.length, 0);
    // The operation closes with advanceTurn:false — the GM drives the
    // turn manually from here.
    assert.equal(completes.length, 1);
    assert.equal(completes[0].payload.advanceTurn, false);
});

test("gm-confirm skill-test substitutes the attack for a test roll", async () => {
    const world = makeWorld();
    const { api } = makeApi();
    const state = {};
    const executor = createExecutorService({ api, getMode: () => "automatic" });
    const operation = { id: `op-${++_opId}`, combatantId: world.combatant.id, phase: "executing" };
    const result = await executor.runPlan({
        combat: world.combat,
        combatant: world.combatant,
        operation,
        plan: attackPlan(world, { operationId: operation.id }),
        planner: stubPlanner(),
        rolls: stubRolls(state),
        adjudicationMode: "gm-confirm",
        adjudication: async () => "skill-test"
    });
    assert.equal(result.status, EXECUTOR_STATUS.completed);
    assert.equal(state.executes.length, 1);
    assert.equal(state.executes[0].kind, "Test", "the test roll channel was used");
    const step = result.stepsDone.find(entry => entry.stepId === "step-attack-1");
    assert.equal(step.reason, "adjudicated-skill-test");
});

test("auto adjudication never consults the GM", async () => {
    const world = makeWorld();
    const { api } = makeApi();
    const state = {};
    const asked = [];
    const executor = createExecutorService({ api, getMode: () => "automatic" });
    const operation = { id: `op-${++_opId}`, combatantId: world.combatant.id, phase: "executing" };
    const result = await executor.runPlan({
        combat: world.combat,
        combatant: world.combatant,
        operation,
        plan: attackPlan(world, { operationId: operation.id }),
        planner: stubPlanner(),
        rolls: stubRolls(state),
        adjudicationMode: "auto",
        adjudication: async request => {
            asked.push(request);
            return "cancel";
        }
    });
    assert.equal(result.status, EXECUTOR_STATUS.completed);
    assert.equal(asked.length, 0, "auto mode rolls straight through");
    assert.equal(state.executes.length, 1);
});

test("preview mode asks the GM once for the plan, never per step", async () => {
    // The preview dialog is the single confirmation point — the
    // adjudication gate deliberately does not engage outside
    // `automatic`, so the GM is never asked twice for the same plan.
    const world = makeWorld();
    const { api } = makeApi();
    const state = {};
    const asked = [];
    const executor = createExecutorService({ api, getMode: () => "preview" });
    const result = await executor.executePlan(attackPlan(world), {
        combat: world.combat,
        combatant: world.combatant,
        planner: stubPlanner(),
        rolls: stubRolls(state),
        adjudicationMode: "gm-confirm",
        adjudication: async request => {
            asked.push(request);
            return "execute";
        }
    });
    assert.equal(result.status, EXECUTOR_STATUS.completed);
    assert.equal(asked.length, 0, "preview mode skips the per-step gate");
    assert.equal(state.executes.length, 1);
});

// ---- Weapon preference / inertia --------------------------------------

test("resolveEffectiveConfig surfaces the actor preferredWeapon", () => {
    const actor = makeActor({
        rawConfig: {
            enabled: true,
            preset: "assault",
            preferredWeapon: "Weapon.w7"
        }
    });
    assert.equal(resolveEffectiveConfig(actor).preferredWeapon, "Weapon.w7");
    const blank = makeActor({
        rawConfig: { enabled: true, preset: "assault", preferredWeapon: "  " }
    });
    assert.equal(resolveEffectiveConfig(blank).preferredWeapon, undefined);
});

test("preferredWeapon scores its weapon's attacks with weaponAffinity", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    planner.registerPreset("assault", { weights: { attackNow: 10, weaponAffinity: 5 } });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world),
        actions: [lasgunAction()],
        moves: [],
        preferredWeapon: "a.l"
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.equal(result.plan.breakdown.factors.weaponAffinity, 1);

    const other = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world),
        actions: [lasgunAction()],
        moves: [],
        preferredWeapon: "a.missing"
    });
    assert.equal(other.plan.breakdown.factors.weaponAffinity, 0);
});

test("the lastUsedWeapon flag feeds the weaponInertia factor", async () => {
    const world = makeWorld();
    await world.combatant.setFlag(MODULE_ID, "lastUsedWeapon",
        { itemUuid: "a.l", name: "Lasgun" });
    const planner = createPlannerService();
    planner.registerPreset("assault", { weights: { attackNow: 10, weaponInertia: 5 } });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world),
        actions: [lasgunAction()],
        moves: []
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.equal(result.plan.breakdown.factors.weaponInertia, 1);
});

test("a successful attack records lastUsedWeapon on the combatant flag", async () => {
    const world = makeWorld();
    const { api } = makeApi();
    const executor = createExecutorService({ api, getMode: () => "automatic" });
    const operation = { id: `op-${++_opId}`, combatantId: world.combatant.id, phase: "executing" };
    const result = await executor.runPlan({
        combat: world.combat,
        combatant: world.combatant,
        operation,
        plan: attackPlan(world, { operationId: operation.id }),
        planner: stubPlanner(),
        rolls: stubRolls({})
    });
    assert.equal(result.status, EXECUTOR_STATUS.completed);
    const record = world.combatant.getFlag(MODULE_ID, "lastUsedWeapon");
    assert.ok(record, "lastUsedWeapon flag written");
    assert.equal(record.itemUuid, `Actor.${world.actor.id}.Item.w1`);
    assert.equal(record.name, "Lasgun");
    assert.equal(record.round, 1);
});

// ---- Personality weapon affinity --------------------------------------

test("personalityWeaponAffinity matches trait weapon affinity specs", () => {
    // Sniper: long-las / needle / stalker weapon names.
    assert.equal(personalityWeaponAffinity(["sniper"], { name: "Long-Las" }), true);
    assert.equal(personalityWeaponAffinity(["sniper"], { name: "Needle Rifle" }), true);
    assert.equal(personalityWeaponAffinity(["sniper"], { name: "Lasgun" }), false);
    // Heavy-handed: heavy class and flame weapons.
    assert.equal(personalityWeaponAffinity(["heavyHanded"], { class: "heavy" }), true);
    assert.equal(personalityWeaponAffinity(["heavyHanded"], { name: "Flamer" }), true);
    // Grenadier: blast weapons.
    assert.equal(personalityWeaponAffinity(["grenadier"], { blastRadius: 5 }), true);
    assert.equal(personalityWeaponAffinity(["grenadier"], { name: "Frag Grenade" }), true);
    // Duelist: melee weapons.
    assert.equal(personalityWeaponAffinity(["duelist"], { class: "melee" }), true);
    // No traits or a non-affinity trait → no match.
    assert.equal(personalityWeaponAffinity(["brave"], { name: "Long-Las" }), false);
    assert.equal(personalityWeaponAffinity([], { name: "Long-Las" }), false);
});

test("a matching personality trait adds half weaponAffinity on attacks", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    planner.registerPreset("assault", { weights: { attackNow: 10, weaponAffinity: 4 } });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world),
        actions: [{ ...lasgunAction(), range: 60, name: "Long-Las" }],
        moves: [],
        personality: ["sniper"]
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.equal(result.plan.breakdown.factors.weaponAffinity, 0.5);
});

// ---- Move-attack half-move regression ---------------------------------

test("move-attack beyond the half-move rate is rejected (regression)", async () => {
    const world = makeWorld({ enemies: [{ x: 600, y: 0 }] });
    const planner = createPlannerService();
    planner.registerPreset("assault", { weights: { attackNow: 10, attackAfterMove: 6 } });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world),
        actions: [lasgunAction()],
        halfMove: 2,
        moves: [{ x: 300, y: 0, i: 3, j: 0, cost: 3, distance: 4.5, los: true }]
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.ok(result.plan.diagnostics.rejected.some(entry =>
        String(entry.candidate).startsWith("move-attack|")
        && entry.reason === "beyond-half-move"),
        JSON.stringify(result.plan.diagnostics.rejected));
    assert.ok(result.plan.steps.every(step =>
        step.type !== "move" || step.cost.halves === 2),
        "a full move is the only legal relocation past the half rate");
});

// ---- Adjudication lifecycle (issue #52) -------------------------------

test("an unanswered adjudication card times out and hands the turn back", async () => {
    const world = makeWorld();
    const { api } = makeApi();
    const state = {};
    globalThis.ChatMessage = { create: async () => ({ id: "cm-1" }) };
    try {
        const executor = createExecutorService({
            api,
            getMode: () => "automatic",
            adjudicationTimeout: () => 0.01
        });
        const operation = { id: `op-${++_opId}`, combatantId: world.combatant.id, phase: "executing" };
        const result = await executor.runPlan({
            combat: world.combat,
            combatant: world.combatant,
            operation,
            plan: attackPlan(world, { operationId: operation.id }),
            planner: stubPlanner(),
            rolls: stubRolls(state),
            adjudicationMode: "gm-confirm"
            // No injected resolver — the real chat-card gate times out.
        });
        assert.equal(result.status, EXECUTOR_STATUS.cancelled);
        assert.equal(result.reason, "adjudication-cancelled");
        assert.equal((state.executes ?? []).length, 0, "no unattended roll ran");
    } finally {
        delete globalThis.ChatMessage;
    }
});

test("a deleted combat resolves a pending adjudication as cancel", async () => {
    const world = makeWorld();
    const { api } = makeApi();
    const state = {};
    const fns = {};
    const fakeHooks = { on: (name, fn) => { fns[name] = fn; return 1; }, off: () => {} };
    globalThis.ChatMessage = { create: async () => ({ id: "cm-1" }) };
    try {
        const executor = createExecutorService({
            api,
            getMode: () => "automatic",
            hooks: fakeHooks,
            adjudicationTimeout: () => 0
        });
        const operation = { id: `op-${++_opId}`, combatantId: world.combatant.id, phase: "executing" };
        const runP = executor.runPlan({
            combat: world.combat,
            combatant: world.combatant,
            operation,
            plan: attackPlan(world, { operationId: operation.id }),
            planner: stubPlanner(),
            rolls: stubRolls(state),
            adjudicationMode: "gm-confirm"
        });
        // Let the run reach the chat-card gate, then drop the combat.
        await new Promise(resolve => setTimeout(resolve, 10));
        fns.deleteCombat();
        const result = await runP;
        assert.equal(result.status, EXECUTOR_STATUS.cancelled);
        assert.equal((state.executes ?? []).length, 0);
    } finally {
        delete globalThis.ChatMessage;
    }
});

// ---- API surface ------------------------------------------------------

test("the module API advertises the issue #37 capabilities", () => {
    const api = createModuleApi();
    assert.equal(api.hasCapability("planner.freeActions"), true);
    assert.equal(api.hasCapability("reactions.flags"), true);
    assert.equal(api.hasCapability("executor.adjudication"), true);
    assert.deepEqual(api.attackAdjudicationModes, ["auto", "gm-confirm"]);
});

test("a clip-0 ranged attack leaves the usable pool — ready-weapon beats the dead trigger pull", async () => {
    // П.33 smoke finding: an empty-clip attack used to stay in the
    // candidate pool and outbid the ready-weapon fallback on attackNow
    // weight alone — the bot spent the turn pulling a dead trigger.
    // The clip gate drops it like `weapon-jammed`, so the synthesized
    // draw of a loaded sidearm wins the turn instead.
    const world = makeWorld();
    world.actor.items = [
        {
            id: "w1", uuid: "a.l", type: "weapon", name: "Lasgun",
            system: { class: "basic", range: 30, clip: { value: 0, max: 30 } }
        },
        {
            id: "w9", uuid: "a.p", type: "weapon", name: "Autopistol",
            system: { class: "pistol", range: 20, clip: { value: 9, max: 9 } }
        }
    ];
    const planner = createPlannerService();
    planner.registerPreset("assault", {
        weights: { attackNow: 12, attackAfterMove: 10, readyWeapon: 2 },
        allowNoAction: true
    });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world),
        actions: [lasgunAction()],
        moves: [],
        actionsApi: { readyWeapon: async () => ({ ok: true }) }
    });
    assert.equal(result.status, PLANNER_STATUS.ok, JSON.stringify(result));
    assert.ok(
        result.plan.diagnostics.rejected.some(entry => entry.reason === "no-ammo"),
        "clip-0 attack rejected as no-ammo"
    );
    assert.equal(
        result.plan.steps.some(step => step.type === "attack"), false,
        "no attack step on an empty weapon"
    );
    const step = result.plan.steps.find(entry => entry.type === "ready-weapon");
    assert.ok(step, "ready-weapon step exists");
    assert.equal(step.input.weaponId, "w9");
});
