import test from "node:test";
import assert from "node:assert/strict";

import { createModuleApi } from "../../scripts/api.js";
import { FLAG_KEYS, MODULE_ID, SETTING_KEYS } from "../../scripts/constants.js";
import { createExecutorService } from "../../scripts/executor.js";
import { createFireteamService } from "../../scripts/fireteam.js";
import { createOperationService, readOperation } from "../../scripts/operations.js";
import { createPlannerService } from "../../scripts/planner.js";
import { registerRangedCoverPreset } from "../../scripts/presets/ranged-cover.js";
import { buildPreviewViewModel, createPreviewController } from "../../scripts/ui/preview-dialog.js";
import { makeActor, makeCombat, makeCombatant, makeScene, makeToken } from "./fixtures.mjs";

async function fixture({ mode = "automatic", detached = false, blockedRejoin = false } = {}) {
    const api = createModuleApi();
    const scene = makeScene();
    scene.walls = [];
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
    api.services.register("navigation", {
        findCandidates: (viewer, budget, options) => ({
            status: "ok",
            candidates: detached && options.target?.x === 650
                ? (blockedRejoin ? [] : [rejoin])
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
    const fireteam = createFireteamService({ api });
    let builds = 0;
    api.services.register("fireteam", {
        ...fireteam,
        buildTeamPlan(...args) {
            builds++;
            return fireteam.buildTeamPlan(...args);
        }
    });
    const calls = [];
    const executor = createExecutorService({
        api, isEnabled: () => true, getMode: () => mode, pacing: () => 0,
        getAdjudication: () => "auto", hooks: { callAll: (name, data) => calls.push({ name, data }) }
    });
    api.services.register("executor", executor);
    const planContext = {
        actions: [{ id: "shot", type: "attack", class: "basic", range: 6, cost: 1 }],
        rates: { half: 5, full: 8 }, seed: 7, threatMap: false, personality: false
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
        api, combat, shooter, flanker, target, moves, attacks, turn, calls, route,
        records: () => combat.getFlag(MODULE_ID, FLAG_KEYS.teamManeuvers),
        setVisible: callback => { visibleTo = callback; },
        setController: value => { controller = value; },
        prepare: callback => { onPrepare = callback; },
        afterRoll: callback => { onRoll = callback; },
        builds: () => builds
    };
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
