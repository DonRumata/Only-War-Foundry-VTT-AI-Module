import test from "node:test";
import assert from "node:assert/strict";

import { createModuleApi } from "../../scripts/api.js";
import { FLAG_KEYS, MODULE_ID, SETTING_KEYS } from "../../scripts/constants.js";
import { createExecutorService } from "../../scripts/executor.js";
import { createFireteamService } from "../../scripts/fireteam.js";
import { createGridAdapter, createNavigationService } from "../../scripts/navigation.js";
import { createOperationService, readOperation } from "../../scripts/operations.js";
import { createPlannerService } from "../../scripts/planner.js";
import { registerRangedCoverPreset } from "../../scripts/presets/ranged-cover.js";
import { buildPreviewViewModel, createPreviewController } from "../../scripts/ui/preview-dialog.js";
import { makeActor, makeCombat, makeCombatant, makeScene, makeToken } from "./fixtures.mjs";

async function fixture({
    mode = "automatic", detached = false, blockedRejoin = false,
    maxDetachedRounds, flankerArmed = true, alternateDraftRejoin = false
} = {}) {
    const api = createModuleApi();
    const scene = makeScene();
    Object.assign(scene, { walls: [], width: 1000, height: 600 });
    const moves = [];
    const attacks = [];
    const member = async (x, y, initiative) => {
        const actor = makeActor({ enabled: true, preset: "rangedCover" });
        const token = makeToken({ actor });
        Object.assign(token, { x, y, disposition: -1, elevation: 0 });
        token.move = async points => {
            Object.assign(token, points.at(-1));
            moves.push(token.id);
        };
        const combatant = makeCombatant({ actor, token });
        Object.assign(combatant, { tokenId: token.id, initiative });
        await combatant.setFlag(MODULE_ID, FLAG_KEYS.fireteam, {
            teamId: "alpha", ...(detached ? { preferredCohesion: 2 } : {})
        });
        return combatant;
    };
    const shooter = await member(600, 100, 20);
    const flanker = await member(200, 300, 10);
    const actor = makeActor();
    const token = makeToken({ actor });
    Object.assign(token, { x: 800, y: 300, disposition: 1, elevation: 0 });
    const target = makeCombatant({ actor, token });
    Object.assign(target, { tokenId: token.id, initiative: 5 });
    const combat = makeCombat({ round: 1, combatants: [shooter, flanker, target] });
    combat.scene = scene;
    scene.tokens = new Map(combat.turns.map(c => [c.tokenId, c.token]));
    combat.nextTurn = async () => {
        combat.turn++;
        if (combat.turn === combat.turns.length) {
            combat.turn = 0;
            combat.round++;
        }
    };
    let visibleTo = () => true;
    const visibleTargets = viewer => !token.hidden && visibleTo(viewer)
        ? [{ tokenId: token.id, x: 850, y: 350, canAttack: true }] : [];
    api.services.register("perception", {
        visibleTargets,
        buildPerceptionSnapshot: ({ token: viewer }) =>
            ({ status: "ok", visibleTargets: visibleTargets(viewer), lastKnownTargets: [] })
    });
    const to = { x: 550, y: 350, i: 3, j: 5 };
    const waypoints = [{ x: 250, y: 350, i: 3, j: 2 }, to];
    const route = { exact: true, cost: 4.5, endpoint: to, waypoints };
    const home = { x: 650, y: 250, i: 2, j: 6 };
    const rejoin = { ...home, cost: 1.5, waypoints: [to, home], exact: true, endpoint: home };
    const draftHome = { x: 750, y: 150, i: 1, j: 7 };
    const draftRejoin = { ...draftHome, cost: 3, waypoints: [to, home, draftHome] };
    const adapter = createGridAdapter({
        canvas: { scene, tokens: { get placeables() { return [...scene.tokens.values()]; } } }
    });
    api.services.register("navigation", {
        ...createNavigationService({ adapter }),
        findCandidates: (viewer, budget, options) => ({
            status: "ok",
            candidates: detached && options.target?.x === 650
                ? (blockedRejoin ? [] : [options.origin && alternateDraftRejoin ? draftRejoin : rejoin])
                : viewer.x === 200 ? [{ ...to, waypoints, cost: 4.5, los: true }] : []
        }),
        planRoute: (_viewer, destination) => destination.i === home.i && destination.j === home.j ? rejoin : route
    });
    let controller = true;
    const operations = createOperationService({ hooks: {} });
    api.services.register("authority", { isController: () => controller, operations });
    const planner = createPlannerService({ api });
    registerRangedCoverPreset(planner);
    api.services.register("planner", planner);
    const fireteam = createFireteamService({ api, planner });
    let builds = 0;
    let draft = null;
    api.services.register("fireteam", {
        ...fireteam,
        async buildTeamPlan(...args) {
            builds++;
            const result = await fireteam.buildTeamPlan(...args);
            draft = result.teamPlan;
            return result;
        }
    });
    const calls = [];
    const executor = createExecutorService({
        api, isEnabled: () => true, getMode: () => mode, pacing: () => 0,
        getAdjudication: () => "auto", hooks: { callAll: (name, data) => calls.push({ name, data }) }
    });
    api.services.register("executor", executor);
    const shot = { id: "shot", type: "attack", class: "basic", range: 6, cost: 1 };
    const planContext = {
        actionsApi: { list: actor => actor === flanker.actor && !flankerArmed ? [] : [shot] },
        rates: { half: 5, full: 8 }, seed: 7, threatMap: false, personality: false,
        ...(maxDetachedRounds === undefined ? {} : { maxDetachedPhases: maxDetachedRounds })
    };
    let onPrepare = null;
    let onRoll = null;
    globalThis.game.darkHeresy.api.rolls = {
        prepareAttack: async input => { onPrepare?.(); return input; },
        executeAttack: async prepared => {
            attacks.push([combat.round, combat.combatant.id, prepared.tokenUuid]);
            await onRoll?.();
            return { status: "ok", roll: { hits: 0 } };
        }
    };
    async function turn(controllerId = "gm") {
        const claim = await operations.claimTurn(combat, combat.combatant, { controllerId });
        assert.ok(claim.ok);
        const transitioned = await operations.transitionOperation(combat, claim.operation.id, "planning",
            mode === "preview" ? "awaiting-preview" : "executing");
        assert.ok(transitioned.ok);
        return executor.runPlan({ combat, operation: transitioned.operation, operations, planContext });
    }
    return {
        api, combat, shooter, flanker, target, moves, attacks, turn, calls, route, executor, operations,
        planContext,
        records: () => combat.getFlag(MODULE_ID, FLAG_KEYS.teamManeuvers),
        setMode: value => { mode = value; },
        setVisible: callback => { visibleTo = callback; },
        setController: value => { controller = value; },
        prepare: callback => { onPrepare = callback; },
        afterRoll: callback => { onRoll = callback; },
        builds: () => builds,
        draft: () => draft
    };
}

async function previewReturn(world) {
    await world.turn(); // shooter waits
    await world.turn(); // flanker moves
    await world.combat.nextTurn(); // target passes
    await world.turn(); // shooter attacks
    await world.turn(); // flanker attacks
    await world.combat.nextTurn(); // target passes
    await world.turn(); // shooter waits
    assert.equal(world.combat.round, 3);
    assert.equal(world.combat.combatant, world.flanker);
    world.setMode("preview");
    const result = await world.turn();
    assert.equal(result.plan?.teamTurn?.phase, "regroup");
    return world.calls.at(-1).data;
}

async function confirmDirectly(world, payload) {
    const { combat, executor, operations } = world;
    const { operationId, plan } = payload;
    const transition = await operations.transitionOperation(combat, operationId, "awaiting-preview", "executing");
    assert.ok(transition.ok);
    executor.clearExecutions(operationId);
    return executor.executePlan(plan, { ...payload, operations, operation: transition.operation });
}

function blockReturnEndpoint(world, plan) {
    const { to } = plan.steps.find(step => step.type === "move").input;
    const flanker = plan.teamTurn.state.members.find(member => member.id === world.flanker.id);
    assert.notDeepEqual(to, flanker.rejoin.point, "the new endpoint differs from the draft reservation");
    const outsider = makeToken();
    Object.assign(outsider, { x: 600, y: 200 });
    world.combat.scene.tokens.set(outsider.id, outsider);
    assert.equal(world.api.services.get("navigation").validateEndpoint(world.flanker.token, to).valid, false);
}

test("TeamPlan waits without blocking initiative, then fires only on each member's next turn", async () => {
    const world = await fixture();
    assert.equal((await world.turn()).reason, "team-waiting");
    assert.deepEqual(world.attacks, []);
    assert.deepEqual(world.moves, []);
    assert.equal(world.combat.combatant, world.flanker);
    assert.deepEqual(world.records()[0].required, [world.flanker.id]);

    await world.turn();
    assert.deepEqual(world.moves, [world.flanker.token.id]);
    assert.deepEqual(world.attacks, []);
    assert.equal(world.combat.combatant, world.target);
    assert.equal(world.records()[0].members.find(m => m.id === world.flanker.id).move, null);
    await world.combat.nextTurn();
    await world.turn();
    await world.turn();
    assert.deepEqual(world.attacks.map(([round, id]) => [round, id]), [
        [2, world.shooter.id], [2, world.flanker.id]
    ]);
    assert.equal(world.builds(), 1, "the draft does not replay across turns");
    assert.deepEqual(world.records(), []);
});

test("object assignment metadata survives team-turn compile and execution contexts", async () => {
    const world = await fixture();
    const objective = { type: "screen", targetId: world.target.tokenId, lane: "left" };
    world.planContext.objective = { targetId: world.target.tokenId };
    world.planContext.assignments = {
        [world.shooter.id]: { task: "support", role: "suppressor", element: "fire" },
        [world.flanker.id]: {
            task: "flank", role: "interdictor", element: "screen", objective
        }
    };
    const planner = world.api.services.get("planner");
    const originalPlanTurn = planner.planTurn.bind(planner);
    const contexts = [];
    planner.planTurn = async (combat, combatant, context) => {
        contexts.push({
            combatantId: combatant.id,
            phase: context?.teamTurn?.phase ?? null,
            team: context?.team ?? null
        });
        return originalPlanTurn(combat, combatant, context);
    };

    assert.equal((await world.turn()).reason, "team-waiting");
    const state = world.records()[0];
    assert.equal(state.objective, world.target.tokenId,
        "compiled maneuver state keeps the shared target on the legacy scalar channel");
    const flankerState = state.members.find(member => member.id === world.flanker.id);
    assert.equal(flankerState.role, "interdictor");
    assert.equal(flankerState.element, "screen");
    assert.deepEqual(flankerState.objective, objective);
    assert.notEqual(flankerState.objective, objective, "compiled state stores a JSON copy");
    const shooterState = state.members.find(member => member.id === world.shooter.id);
    assert.equal(shooterState.role, "suppressor");
    assert.equal(shooterState.element, "fire");
    assert.equal("objective" in shooterState, false);

    contexts.length = 0;
    await world.turn(); // the flanker performs its compiled movement
    const execution = contexts.find(entry => entry.combatantId === world.flanker.id
        && entry.phase === "movement");
    assert.ok(execution, "the compiled movement is re-planned with a team context");
    assert.equal(execution.team.role, "interdictor");
    assert.equal(execution.team.element, "screen");
    assert.equal(execution.team.objective, world.target.tokenId,
        "execution team.objective remains the legacy scalar target id");
    assert.deepEqual(execution.team.memberObjective, objective);
    assert.deepEqual(execution.team.assignment, {
        task: "flank",
        role: "interdictor",
        element: "screen",
        objective
    });
});

test("an undersized Spec Ops fireteam previews the world's individual fallback without assigning roles", async () => {
    const world = await fixture({ mode: "preview" });
    const key = SETTING_KEYS.specOpsFallbackPreset;
    const previous = game.settings.get(MODULE_ID, key);
    game.settings.set(MODULE_ID, key, "assault");
    try {
        await world.shooter.setFlag(MODULE_ID, FLAG_KEYS.fireteam, {
            teamId: "alpha", teamPreset: "specOps"
        });
        world.flanker.defeated = true;
        const result = await world.turn();
        assert.equal(result.status, "preview");
        assert.equal(result.plan.preset, "assault");
        assert.equal(result.plan.teamTurn, undefined);
        assert.equal(world.builds(), 0);
        assert.deepEqual(world.moves, []);
        assert.equal(world.combat.combatant, world.shooter);
    } finally {
        game.settings.set(MODULE_ID, key, previous);
    }
});

test("a route blocked after the wait cancels the maneuver without moving or attacking", async () => {
    const world = await fixture();
    await world.turn();
    world.route.exact = false;
    assert.equal((await world.turn()).reason, "team-route-unavailable");
    assert.deepEqual(world.attacks, []);
    assert.deepEqual(world.moves, []);
    assert.deepEqual(world.records(), []);
    assert.equal(world.combat.combatant, world.target);
});

test("the return to cohesion consumes the detached member's normal turn", async () => {
    const world = await fixture({ detached: true });
    await world.turn(); // shooter waits
    await world.turn(); // flanker moves
    assert.ok(world.records()[0].members.find(m => m.id === world.flanker.id).rejoin.untilRound > 1);
    await world.combat.nextTurn();
    await world.turn();
    await world.turn();
    assert.equal(world.attacks.length, 2);
    assert.deepEqual(world.moves, [world.flanker.tokenId], "no extra move is granted on an attack turn");
    await world.combat.nextTurn();
    await world.turn(); // shooter passes while the flanker has the return assignment
    assert.equal(world.combat.combatant, world.flanker);
    await world.turn();
    assert.deepEqual(world.moves, [world.flanker.tokenId, world.flanker.tokenId]);
    assert.deepEqual([world.flanker.token.x, world.flanker.token.y], [600, 200]);
    assert.equal(world.combat.combatant, world.target);
    assert.deepEqual(world.records(), []);
});

test("a non-member on the fresh return endpoint makes the regroup preview stale", async () => {
    const world = await fixture({ detached: true, alternateDraftRejoin: true });
    const payload = await previewReturn(world);
    world.api._state.enabled = true;
    game.modules.set(MODULE_ID, { api: world.api });
    const preview = createPreviewController({
        api: world.api, getMode: () => "preview", getTimeout: () => 0
    });
    preview.openPreview(payload);

    blockReturnEndpoint(world, payload.plan);
    const confirm = await preview.resolvePreview(payload.operationId, { decision: "confirm" });
    assert.equal(confirm.ok, false);
    assert.equal(confirm.stale, true);
    assert.equal(confirm.reason, "team-rejoin-unavailable");
    assert.equal(readOperation(world.combat).phase, "awaiting-preview");
    assert.equal(world.combat.combatant, world.flanker);
    assert.deepEqual(world.moves, [world.flanker.tokenId]);
});

test("the executor also refuses an occupied return endpoint without relying on the preview UI", async () => {
    const world = await fixture({ detached: true, alternateDraftRejoin: true });
    const payload = await previewReturn(world);
    blockReturnEndpoint(world, payload.plan);

    const result = await confirmDirectly(world, payload);
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "team-rejoin-unavailable");
    assert.deepEqual(world.moves, [world.flanker.tokenId]);
    assert.deepEqual([world.flanker.token.x, world.flanker.token.y], [500, 300]);
    assert.equal(world.attacks.length, 2, "resolved actions are not rolled back");
});

test("regroup rechecks the serialized path cost immediately before movement", async () => {
    const world = await fixture({ detached: true });
    const payload = await previewReturn(world);
    const setFlag = world.combat.setFlag.bind(world.combat);
    world.combat.setFlag = async (scope, key, value) => {
        const result = await setFlag(scope, key, value);
        if (key === FLAG_KEYS.teamManeuvers && value[0]?.inFlight === payload.operationId) {
            world.flanker.token.object = { measureMovementPath: () => ({ cost: Infinity }) };
        }
        return result;
    };
    const result = await confirmDirectly(world, payload);
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "team-rejoin-unavailable");
    assert.ok(result.failedStep, "invalidation occurred after the claim was committed, before the move");
    assert.deepEqual(world.moves, [world.flanker.tokenId]);
});

test("an attack on the flanker’s only return turn rules out a one-round detachment", async () => {
    const world = await fixture({ detached: true, maxDetachedRounds: 1 });
    const result = await world.turn();
    assert.equal(world.draft().members.find(member => member.combatantId === world.flanker.id).maxDetachedRounds, 1);
    assert.ok(world.draft().phases.find(phase => phase.name === "action")
        .steps.some(step => step.combatantId === world.flanker.id));
    assert.equal(result.status, "completed");
    assert.equal(world.records(), undefined, "decline before committing the draft");
    assert.deepEqual(world.moves, []);
    assert.equal(world.combat.combatant, world.flanker, "use normal initiative for the fallback");
});

test("a draft that no longer fits initiative is rejected at confirmation, before any departure", async () => {
    const world = await fixture({ mode: "preview", detached: true });
    world.target.initiative = 30;
    world.combat.turns = [world.target, world.shooter, world.flanker];
    await world.combat.nextTurn();
    const preview = await world.turn();
    assert.equal(preview.plan?.teamTurn?.phase, "wait");

    // The active turn remains the same; the new first mover now needs to
    // wait until round 2 to depart, and cannot also attack in that round.
    world.flanker.initiative = 30;
    world.target.initiative = 5;
    world.combat.turns = [world.flanker, world.shooter, world.target];
    const payload = world.calls.at(-1).data;
    assert.deepEqual(world.executor.validateTeamTurn(preview.plan, payload), { valid: false, reason: "team-timeout" });
    const result = await confirmDirectly(world, payload);
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "team-timeout");
    assert.equal(world.records(), undefined);
    assert.deepEqual(world.moves, []);
    assert.deepEqual(world.attacks, []);
    assert.equal(world.combat.combatant, world.target);
});

test("a mover without an attack can return at the end of a legal one-round detachment", async () => {
    const world = await fixture({ detached: true, maxDetachedRounds: 1, flankerArmed: false });
    assert.equal((await world.turn()).reason, "team-waiting");
    await world.turn(); // flanker departs on its own turn
    const member = world.records()[0].members.find(entry => entry.id === world.flanker.id);
    assert.equal(member.action, null);
    assert.equal(member.rejoin.untilRound, 2);
    await world.combat.nextTurn(); // target passes
    await world.turn(); // shooter acts before the flanker’s return slot
    await world.turn();
    assert.deepEqual(world.attacks.map(([round, id]) => [round, id]), [[2, world.shooter.id]]);
    assert.deepEqual(world.moves, [world.flanker.tokenId, world.flanker.tokenId]);
    assert.deepEqual(world.records(), []);
    assert.equal(world.combat.combatant, world.target);
});

test("initiative changes after departure prioritize a legal return over the pending attack", async () => {
    const world = await fixture({ detached: true, maxDetachedRounds: 1, flankerArmed: false });
    await world.turn(); // shooter waits
    await world.turn(); // flanker departs
    await world.combat.nextTurn(); // target passes into the deadline round
    world.flanker.initiative = world.shooter.initiative + 1;
    world.combat.turns = [world.flanker, world.shooter, world.target];

    const result = await world.turn(); // flanker now acts before the shooter
    assert.equal(result.status, "completed");
    assert.deepEqual(world.attacks, []);
    assert.deepEqual(world.moves, [world.flanker.tokenId, world.flanker.tokenId]);
    assert.deepEqual([world.flanker.token.x, world.flanker.token.y], [600, 200]);
    assert.deepEqual(world.records(), []);
    assert.equal(world.combat.combatant, world.shooter);
});

test("a missed action turn relinquishes the barrier while another member still has time to return", async () => {
    const world = await fixture({ detached: true, maxDetachedRounds: 2 });
    await world.turn(); // shooter waits
    await world.turn(); // flanker departs
    await world.combat.nextTurn(); // target passes
    await world.turn(); // shooter attacks
    await world.combat.nextTurn(); // GM skips the flanker’s action
    await world.combat.nextTurn(); // target passes into the deadline round
    assert.equal(world.combat.round, 3);
    assert.equal(world.combat.combatant, world.shooter);

    assert.equal((await world.turn()).reason, "team-timeout");
    assert.ok(world.records()[0].members.every(member => !member.action && !member.move));
    assert.equal(world.combat.combatant, world.flanker);
    await world.turn();
    assert.deepEqual(world.attacks.map(([round, id]) => [round, id]), [[2, world.shooter.id]]);
    assert.deepEqual(world.moves, [world.flanker.tokenId, world.flanker.tokenId]);
    assert.deepEqual(world.records(), []);
});

test("a draft without an affordable return route does not start the detached maneuver", async () => {
    const world = await fixture({ detached: true, blockedRejoin: true });
    const result = await world.turn();
    assert.notEqual(result.reason, "team-waiting");
    assert.deepEqual(world.moves, []);
    assert.ok(!world.records()?.some(state => state.members.some(m => m.task === "flank")));
});

test("first coordinated attack checks a waiting ally's LOS with no rollback of movement", async () => {
    const world = await fixture();
    await world.turn();
    await world.turn();
    await world.combat.nextTurn();
    world.setVisible(viewer => viewer.id !== world.flanker.tokenId);
    await world.turn();
    assert.deepEqual(world.attacks, []);
    assert.equal(world.flanker.token.x, 500);
    assert.deepEqual(world.records(), []);
});

test("a defeat during roll preparation prevents the coordinated attack", async () => {
    const world = await fixture();
    await world.turn();
    await world.turn();
    await world.combat.nextTurn();
    world.prepare(() => { world.flanker.defeated = true; });
    await world.turn();
    assert.deepEqual(world.attacks, []);
    assert.deepEqual(world.records(), []);
    assert.equal(world.flanker.token.x, 500);
});

test("a manual handoff mid-roll cannot replay that assignment or skip the next member", async () => {
    const world = await fixture();
    await world.turn();
    await world.turn();
    await world.combat.nextTurn();
    world.afterRoll(() => world.combat.nextTurn());
    await world.turn();
    assert.equal(world.attacks.length, 1, "the finished roll is not undone");
    assert.equal(world.combat.combatant, world.flanker);
    const interrupted = await world.turn();
    assert.equal(interrupted.reason, "team-turn-interrupted");
    assert.equal(world.attacks.length, 1, "the remaining attack is cancelled");
    assert.equal(world.flanker.token.x, 500);
    assert.equal(world.combat.combatant, world.target);
    assert.deepEqual(world.records(), []);
});

test("only the new controller may discard a maneuver after GM handoff", async () => {
    const world = await fixture();
    await world.turn();
    assert.ok(world.records().length);
    world.setController(false);
    assert.equal((await world.turn()).status, "cancelled");
    assert.equal(world.combat.combatant, world.flanker);
    assert.deepEqual(world.moves, []);
    assert.ok(world.records().length, "a non-controller cannot clear the shared state");
    await world.api.services.get("authority").operations.abortIfControllerChanged(world.combat, "new-gm");
    world.setController(true);
    assert.equal((await world.turn("new-gm")).reason, "controller-changed");
    assert.deepEqual(world.records(), []);
    assert.equal(world.combat.combatant, world.target);
});

test("preview does not commit progress; confirming a wait passes and cancelling aborts", async () => {
    const world = await fixture({ mode: "preview", detached: true });
    world.api._state.enabled = true;
    game.modules.set(MODULE_ID, { api: world.api });
    const preview = createPreviewController({
        api: world.api, getMode: () => "preview", getTimeout: () => 0
    });
    let result = await world.turn();
    assert.equal(result.plan?.teamTurn?.phase, "wait");
    const view = buildPreviewViewModel(result.plan, { combat: world.combat });
    assert.equal(view.team.members.length, 2);
    const flank = view.team.members.find(member => !member.active);
    assert.equal(flank.waitsForMovement, true);
    assert.ok(flank.move.route.length && flank.rejoin.route.length);
    assert.deepEqual(flank.action.resources, { ammo: -1 });
    assert.equal(world.records(), undefined);
    preview.openPreview(world.calls.at(-1).data);
    const accepted = await preview.resolvePreview(result.operationId, { decision: "confirm" });
    assert.equal(accepted.ok, true);
    assert.equal(world.combat.combatant, world.flanker);
    assert.ok(world.records().length);

    result = await world.turn();
    assert.equal(result.plan?.teamTurn?.phase, "movement");
    preview.openPreview(world.calls.at(-1).data);
    const cancelled = await preview.resolvePreview(result.operationId, { decision: "cancel" });
    assert.equal(cancelled.ok, true);
    assert.deepEqual(world.records(), []);
    assert.deepEqual(world.moves, []);
    assert.equal(world.combat.combatant, world.flanker);
    assert.equal(readOperation(world.combat).phase, "cancelled");
});
