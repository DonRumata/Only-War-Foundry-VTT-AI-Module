/**
 * Unit tests for the GM preview controller (issue #409): serializable
 * view-model derivation, confirm → execute wiring, cancel → cancelled
 * operation, the auto-cancel timeout, stale-during-preview handling and
 * the automatic-mode / non-controller gates. The dialog itself is injected
 * through a `present` spy — no Foundry Application is needed.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createModuleApi } from "../../scripts/api.js";
import { createPlannerService } from "../../scripts/planner.js";
import {
    buildPreviewViewModel,
    createPreviewController,
    localizePreviewViewModel,
    PREVIEW_DECISIONS,
    PREVIEW_REASONS
} from "../../scripts/ui/preview-dialog.js";
import {
    makeActor,
    makeCombatant,
    makeScene,
    makeToken
} from "./fixtures.mjs";

let _opId = 0;
let _combatId = 0;

/**
 * Minimal Combat fixture.
 * @param {object} [options]
 * @param {number} [options.round]
 * @param {number} [options.turn]
 * @param {object[]} [options.combatants]
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
        get combatant() {
            return this.turns[this.turn] ?? null;
        }
    };
}

/**
 * Small combat world: an AI-enabled NPC at (0, 0) and a hostile enemy.
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
    const combatant = makeCombatant({ actor, token });
    combatant.tokenId = token.id;
    combatant.initiative = 10;

    const enemyActor = makeActor();
    enemyActor.system = { wounds: { value: 0, max: 10 } };
    enemyActor.items = [];
    const enemyToken = makeToken({ actor: enemyActor });
    enemyToken.x = enemy.x;
    enemyToken.y = enemy.y;
    enemyToken.elevation = 0;
    enemyToken.disposition = 1;
    const enemyCombatant = makeCombatant({ actor: enemyActor, token: enemyToken });
    enemyCombatant.tokenId = enemyToken.id;
    enemyCombatant.name = "Enemy Soldier";

    const combat = makeCombat({ round: 1, turn: 0, combatants: [combatant, enemyCombatant] });
    combat.scene = scene;
    return {
        scene,
        actor,
        token,
        combatant,
        enemy: { actor: enemyActor, token: enemyToken, combatant: enemyCombatant },
        combat
    };
}

/**
 * Deterministic planTurn inputs producing a `move → attack → end-turn`
 * plan for {@link makeWorld}.
 * @param {object} world
 * @returns {object} planContext for planner calls.
 */
function planContext(world) {
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
            name: "Knife strike",
            itemUuid: `Actor.${world.actor.id}.Item.w1`,
            itemId: "w1",
            class: "melee",
            range: 2,
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
 * Preview controller test rig: real api + planner, mocked executor,
 * operations and authority, a `present` spy and a manual timer queue.
 * @param {object} [options]
 * @param {string} [options.mode] Execution mode ("preview"|"automatic").
 * @param {boolean} [options.controller] `isController` verdict.
 * @param {number} [options.timeout] Preview timeout seconds.
 * @param {object} [options.planner] Planner override (defaults to real).
 * @returns {object}
 */
function makeController({ mode = "preview", controller = true, timeout = 30, planner = null } = {}) {
    const api = createModuleApi();
    // The `ready` compatibility check flips this in production.
    api._state.enabled = true;
    const realPlanner = planner ?? createPlannerService({ api });
    api.services.register("planner", realPlanner);
    const completed = [];
    const transitions = [];
    const operations = {
        completeTurn: async (combat, id, result) => {
            completed.push({ id, result });
            return { ok: true };
        },
        transitionOperation: async (combat, id, from, to) => {
            transitions.push({ id, from, to });
            return { ok: true };
        }
    };
    api.services.register("authority", { isController: () => controller, operations });
    const executeCalls = [];
    const cleared = [];
    const executor = {
        executePlan: async (plan, ctx) => {
            executeCalls.push({ plan, ctx });
            return { status: "completed", planId: plan?.id ?? null };
        },
        clearExecutions: id => cleared.push(id)
    };
    api.services.register("executor", executor);

    const presented = [];
    const rendered = [];
    const closedHandles = [];
    const present = (session, vm) => {
        presented.push(vm);
        const handle = {
            render: vm => rendered.push(vm),
            close: () => closedHandles.push(session.operationId)
        };
        return handle;
    };
    const timers = [];
    const setTimer = (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
    };

    const preview = createPreviewController({
        api,
        getMode: () => mode,
        getTimeout: () => timeout,
        diagnostics: () => true,
        present,
        setTimer,
        clearTimer: () => {}
    });
    return {
        api,
        planner: realPlanner,
        operations,
        completed,
        transitions,
        executeCalls,
        cleared,
        presented,
        rendered,
        closedHandles,
        timers,
        preview
    };
}

/**
 * Produce a real serialized plan for a world.
 * @param {object} rig `makeController` output.
 * @param {object} world `makeWorld` output.
 * @returns {Promise<object>}
 */
async function makePlan(rig, world) {
    const planned = await rig.planner.planTurn(world.combat, world.combatant, planContext(world));
    assert.equal(planned.status, "ok");
    return planned.plan;
}

/**
 * Open a preview session for a world's combatant.
 * @param {object} rig `makeController` output.
 * @param {object} world `makeWorld` output.
 * @param {object} [extra] Extra `openPreview` payload fields.
 * @returns {Promise<object>} `{opened, session, plan}`.
 */
async function openSession(rig, world, extra = {}) {
    const plan = extra.plan ?? await makePlan(rig, world);
    const operation = { id: `op-${++_opId}`, combatantId: world.combatant.id, phase: "awaiting-preview" };
    const opened = rig.preview.openPreview({
        combat: world.combat,
        combatant: world.combatant,
        operation,
        plan,
        planContext: planContext(world)
    });
    return { opened, plan, operation };
}

test("buildPreviewViewModel produces a serializable summary of the plan", async () => {
    const world = makeWorld();
    const rig = makeController();
    const plan = await makePlan(rig, world);

    const vm = buildPreviewViewModel(plan, {
        combat: world.combat,
        combatant: world.combatant,
        diagnosticsEnabled: true,
        maxReplans: 1,
        timeoutSeconds: 60
    });

    // Fully serializable — a JSON round-trip preserves the model.
    assert.deepEqual(JSON.parse(JSON.stringify(vm)), vm);

    assert.equal(vm.planId, plan.id);
    assert.equal(vm.npc.name, world.combatant.name);
    assert.equal(vm.npc.preset, "assault");
    assert.equal(vm.target.tokenId, world.enemy.token.id);
    assert.equal(vm.target.name, "Enemy Soldier");
    assert.equal(vm.action.type, "attack");
    assert.equal(vm.action.name, "Knife strike");
    assert.deepEqual(vm.route.points, [{ x: 100, y: 0 }, { x: 200, y: 0 }]);
    assert.equal(vm.route.cost, 2);
    assert.deepEqual(vm.steps.map(s => s.type), ["move", "attack", "end-turn"]);
    const resourceMap = Object.fromEntries(vm.resources.map(r => [r.key, r.value]));
    assert.equal(resourceMap.movement, -2);
    assert.equal(resourceMap.ammo, -1);
    assert.equal(vm.diagnostics.enabled, true);
    assert.ok(Array.isArray(vm.diagnostics.rejected));
    assert.equal(vm.replan.allowed, true);
    assert.equal(vm.timeoutSeconds, 60);
    assert.equal(vm.stale, null);

    const i18nStub = {
        localize: key => ({ "OWAI.Preview.Step.move": "Move" }[key] ?? key),
        format: (key, data) => `${key}:${JSON.stringify(data)}`
    };
    const localized = localizePreviewViewModel(vm, i18nStub);
    assert.equal(localized.steps[0].label, "Move");
    assert.ok(localized.resources.every(r => typeof r.label === "string"));
});

test("openPreview opens a session, renders the dialog and arms the timeout", async () => {
    const world = makeWorld();
    const rig = makeController({ timeout: 45 });
    const { opened, operation, plan } = await openSession(rig, world);

    assert.equal(opened.ok, true);
    assert.equal(opened.operationId, operation.id);
    assert.equal(rig.preview.hasSession(operation.id), true);
    assert.equal(rig.presented.length, 1);
    assert.equal(rig.presented[0].planId, plan.id);
    assert.equal(rig.timers.length, 1);
    assert.equal(rig.timers[0].ms, 45000);

    // Duplicate payloads reuse the same session.
    const again = rig.preview.openPreview({
        combat: world.combat,
        combatant: world.combatant,
        operation,
        plan
    });
    assert.equal(again.duplicate, true);
    assert.equal(rig.presented.length, 1);
});

test("automatic mode never opens a preview dialog", async () => {
    const world = makeWorld();
    const rig = makeController({ mode: "automatic" });
    const { opened, operation } = await openSession(rig, world);

    assert.equal(opened.ok, false);
    assert.equal(opened.reason, PREVIEW_REASONS.automaticMode);
    assert.equal(rig.preview.hasSession(operation.id), false);
    assert.equal(rig.presented.length, 0);
});

test("a non-controller client cannot open or decide a preview", async () => {
    const world = makeWorld();
    // The planner itself refuses non-controllers; plan on the controller
    // rig, then hand the serialized plan to the non-controller one.
    const plan = await makePlan(makeController(), world);
    const rig = makeController({ controller: false });
    const opened = rig.preview.openPreview({
        combat: world.combat,
        combatant: world.combatant,
        operation: { id: `op-${++_opId}`, phase: "awaiting-preview" },
        plan
    });

    assert.equal(opened.ok, false);
    assert.equal(opened.reason, PREVIEW_REASONS.notController);
    const outcome = await rig.preview.resolvePreview("op-missing", { decision: "confirm" });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, PREVIEW_REASONS.noPreview);
});

test("confirm transitions the operation and executes the plan", async () => {
    const world = makeWorld();
    const rig = makeController();
    const { opened, operation, plan } = await openSession(rig, world);
    assert.equal(opened.ok, true);

    const outcome = await rig.preview.resolvePreview(operation.id, { decision: "confirm" });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.decision, PREVIEW_DECISIONS.confirm);
    assert.equal(outcome.result.status, "completed");

    // Authority transition: awaiting-preview → executing.
    assert.equal(rig.transitions.length, 1);
    assert.deepEqual(rig.transitions[0], {
        id: operation.id,
        from: "awaiting-preview",
        to: "executing"
    });

    // The recorded preview result is dropped before the real execution.
    assert.deepEqual(rig.cleared, [operation.id]);
    assert.equal(rig.executeCalls.length, 1);
    assert.strictEqual(rig.executeCalls[0].plan, plan);
    assert.equal(rig.executeCalls[0].ctx.operationId, operation.id);

    // Session is gone; the dialog was closed.
    assert.equal(rig.preview.hasSession(operation.id), false);
    assert.deepEqual(rig.closedHandles, [operation.id]);
});

test("a stale confirm never launches the plan and marks the session", async () => {
    const world = makeWorld();
    const rig = makeController();
    const { opened, operation } = await openSession(rig, world);
    assert.equal(opened.ok, true);

    // Manual intervention: the NPC token is dragged mid-preview.
    world.token.x = 500;

    const outcome = await rig.preview.resolvePreview(operation.id, { decision: "confirm" });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.stale, true);
    assert.equal(outcome.reason, "token-moved");
    assert.equal(rig.executeCalls.length, 0);
    assert.equal(rig.transitions.length, 0);
    assert.equal(rig.preview.hasSession(operation.id), true);
    assert.equal(rig.preview.getSession(operation.id).stale, "token-moved");
    // The dialog re-rendered with the stale banner.
    assert.equal(rig.rendered.length >= 1, true);
    assert.equal(rig.rendered.at(-1).stale, "token-moved");
});

test("cancel closes the operation as cancelled without advancing the turn", async () => {
    const world = makeWorld();
    const rig = makeController();
    const { opened, operation } = await openSession(rig, world);
    assert.equal(opened.ok, true);

    const outcome = await rig.preview.resolvePreview(operation.id, { decision: "cancel" });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.decision, PREVIEW_DECISIONS.cancel);
    assert.equal(outcome.reason, PREVIEW_REASONS.gmCancelled);

    assert.equal(rig.executeCalls.length, 0);
    assert.equal(rig.completed.length, 1);
    assert.equal(rig.completed[0].id, operation.id);
    assert.equal(rig.completed[0].result.cancelled, true);
    assert.equal(rig.completed[0].result.advanceTurn, false);
    assert.equal(rig.preview.hasSession(operation.id), false);
    assert.deepEqual(rig.closedHandles, [operation.id]);
});

test("the auto-cancel timeout resolves the preview as preview-timeout", async () => {
    const world = makeWorld();
    const rig = makeController({ timeout: 2 });
    const { opened, operation } = await openSession(rig, world);
    assert.equal(opened.ok, true);
    assert.equal(rig.timers.length, 1);
    assert.equal(rig.timers[0].ms, 2000);

    // Fire the captured timer callback.
    await rig.timers[0].fn();

    assert.equal(rig.executeCalls.length, 0);
    assert.equal(rig.completed.length, 1);
    assert.equal(rig.completed[0].result.reason, PREVIEW_REASONS.timeout);
    assert.equal(rig.preview.hasSession(operation.id), false);
});

test("stale-during-preview marks the session; a turn change auto-cancels", async () => {
    const world = makeWorld();
    const rig = makeController();
    const { opened, operation } = await openSession(rig, world);
    assert.equal(opened.ok, true);

    // Recoverable stale: token moved — session marked, dialog re-rendered.
    world.token.x = 50;
    rig.preview.checkStale();
    await new Promise(resolve => setTimeout(resolve, 0));
    const session = rig.preview.getSession(operation.id);
    assert.ok(session, "session still pending after recoverable stale");
    assert.equal(session.stale, "token-moved");

    // Terminal stale: the combat turn advanced — the preview auto-cancels.
    world.combat.turn = 1;
    world.token.x = 0;
    // Restore the position so only the turn drives the stale reason.
    rig.preview.checkStale();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(rig.preview.hasSession(operation.id), false);
    assert.equal(rig.completed.length, 1);
    assert.equal(rig.completed[0].result.advanceTurn, false);
});

test("replan asks the planner for a fresh plan and re-renders", async () => {
    const world = makeWorld();
    const rig = makeController();
    const { opened, operation, plan } = await openSession(rig, world);
    assert.equal(opened.ok, true);
    assert.equal(rig.timers.length, 1);

    const outcome = await rig.preview.resolvePreview(operation.id, { decision: "replan" });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.decision, PREVIEW_DECISIONS.replan);
    assert.ok(outcome.plan);
    assert.equal(outcome.plan.replanCount, 1);
    assert.notEqual(outcome.plan.id, plan.id);

    const session = rig.preview.getSession(operation.id);
    assert.equal(session.plan, outcome.plan);
    // The dialog re-rendered with the new plan and a re-armed timeout.
    assert.equal(rig.rendered.length >= 1, true);
    assert.equal(rig.timers.length, 2);

    // The replan budget is spent — a second replan is refused.
    const again = await rig.preview.resolvePreview(operation.id, { decision: "replan" });
    assert.equal(again.ok, false);
    assert.equal(again.reason, PREVIEW_REASONS.replanLimit);
});

test("phaseChanged drops a session resolved outside the dialog", async () => {
    const world = makeWorld();
    const rig = makeController();
    const { opened, operation } = await openSession(rig, world);
    assert.equal(opened.ok, true);

    rig.preview.handlePhaseChange(world.combat, { ...operation, phase: "executing" });
    assert.equal(rig.preview.hasSession(operation.id), false);
    assert.deepEqual(rig.closedHandles, [operation.id]);
    assert.equal(rig.completed.length, 0, "no operation bookkeeping for external resolution");
});
