/**
 * Unit tests for the fireteam service (issue #408): flag model, deterministic
 * leader election and leader-lost invalidation, task assignments, soft
 * cohesion, reservations, phased barriers, TeamPlan serializability and
 * diagnostics.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    DEFAULT_PREFERRED_COHESION,
    FIRETEAM_TASKS,
    FLAG_KEYS,
    MODULE_ID
} from "../../scripts/constants.js";
import {
    FIRETEAM_STATUS,
    TEAM_PLAN_REASONS,
    createFireteamService,
    resolveTeamConfig
} from "../../scripts/fireteam.js";
import { createPlannerService } from "../../scripts/planner.js";
import {
    makeActor,
    makeCombatant,
    makeScene,
    makeToken
} from "./fixtures.mjs";

let _combatId = 0;

/**
 * Minimal Combat fixture matching the planner tests: `id`, `round`, `turn`,
 * the `combatants` collection, `turns` and a `scene` reference.
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
        ended: false
    };
}

/**
 * Attach a fireteam flag to a fixture document.
 * @param {object} doc
 * @param {object} flag `{teamId, leaderId?, teamPreset?, preferredCohesion?}`.
 * @returns {object}
 */
function withFireteam(doc, flag) {
    doc.flags[MODULE_ID] = doc.flags[MODULE_ID] ?? {};
    doc.flags[MODULE_ID][FLAG_KEYS.fireteam] = flag;
    return doc;
}

/**
 * Build an AI-enabled NPC combatant with a fireteam flag and a weapon.
 * @param {object} [options]
 * @param {object} [options.fireteam] Fireteam flag value.
 * @param {number} [options.x] Token x position (px).
 * @param {number} [options.y] Token y position (px).
 * @param {number} [options.initiative]
 * @param {number} [options.wounds] Actor wounds value.
 * @param {string} [options.preset] Actor AI preset.
 * @param {boolean} [options.defeated]
 * @returns {object}
 */
function makeMember({
    fireteam,
    x = 0,
    y = 0,
    initiative = 10,
    wounds = 10,
    preset = "assault",
    defeated = false
} = {}) {
    const actor = makeActor({ enabled: true, preset });
    actor.system = { wounds: { value: wounds, max: 14 } };
    actor.items = [{
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
    return { combatant, token, actor };
}

/**
 * Build a combat fixture: `members` + one hostile enemy on a square scene.
 * @param {object[]} members Entries from {@link makeMember}.
 * @param {object} [options]
 * @param {number} [options.enemyX]
 * @param {number} [options.enemyY]
 * @returns {object}
 */
function makeTeamWorld(members, { enemyX = 2000, enemyY = 0 } = {}) {
    const scene = makeScene({ grid: "square" });
    const enemyActor = makeActor();
    enemyActor.system = { wounds: { value: 10, max: 10 } };
    enemyActor.items = [];
    const enemyToken = makeToken({ actor: enemyActor });
    enemyToken.x = enemyX;
    enemyToken.y = enemyY;
    enemyToken.elevation = 0;
    enemyToken.disposition = 1;
    const enemy = makeCombatant({ actor: enemyActor, token: enemyToken });
    enemy.tokenId = enemyToken.id;
    const combat = makeCombat({
        round: 1,
        turn: 0,
        combatants: [...members.map(m => m.combatant), enemy]
    });
    combat.scene = scene;
    combat.ended = false;
    return { scene, combat, enemy, enemyToken };
}

/** Injected normalized target list for {@link makeTeamWorld} enemies. */
function injectedTargets(world) {
    return [{
        tokenId: world.enemyToken.id,
        tokenUuid: `Scene.${world.scene.id}.Token.${world.enemyToken.id}`,
        x: world.enemyToken.x,
        y: world.enemyToken.y,
        elevation: 0,
        canAttack: true,
        source: "injected"
    }];
}

test("resolveTeamConfig reads actor/token/combatant layers with per-field priority", () => {
    const actor = withFireteam(makeActor(), {
        teamId: "alpha",
        leaderId: "actor-1",
        teamPreset: "assault",
        preferredCohesion: 7
    });
    const fromActor = resolveTeamConfig(actor);
    assert.equal(fromActor.teamId, "alpha");
    assert.equal(fromActor.leaderId, "actor-1");
    assert.equal(fromActor.teamPreset, "assault");
    assert.equal(fromActor.preferredCohesion, 7);
    assert.equal(fromActor.source, "actor");

    // Token layer supplies teamId only; the rest inherits from the actor.
    const token = withFireteam(makeToken({ actor }), { teamId: "beta" });
    const fromToken = resolveTeamConfig(token);
    assert.equal(fromToken.teamId, "beta");
    assert.equal(fromToken.leaderId, "actor-1");
    assert.equal(fromToken.teamPreset, "assault");
    assert.equal(fromToken.source, "token");

    // Combatant layer wins over token and actor.
    const combatant = withFireteam(makeCombatant({ actor, token }), {
        teamId: "gamma",
        leaderId: "c-9"
    });
    const fromCombatant = resolveTeamConfig(combatant);
    assert.equal(fromCombatant.teamId, "gamma");
    assert.equal(fromCombatant.leaderId, "c-9");
    assert.equal(fromCombatant.teamPreset, "assault");
    assert.equal(fromCombatant.preferredCohesion, 7);
    assert.equal(fromCombatant.source, "combatant");

    // Damaged data resolves to an empty config.
    const damaged = withFireteam(makeActor(), "not-an-object");
    assert.equal(resolveTeamConfig(damaged).teamId, null);
    assert.equal(resolveTeamConfig(damaged).source, "none");
    assert.equal(resolveTeamConfig(makeActor()).teamId, null);
});

test("collectMembers keeps only enabled combatants of the team", () => {
    const a = makeMember({ fireteam: { teamId: "alpha" } });
    const b = makeMember({ fireteam: { teamId: "alpha" } });
    const outsider = makeMember({ fireteam: { teamId: "beta" } });
    const noFlag = makeMember({});
    const disabled = makeMember({ fireteam: { teamId: "alpha" } });
    disabled.actor.flags[MODULE_ID].config.enabled = false;
    const world = makeTeamWorld([a, b, outsider, noFlag, disabled]);
    const service = createFireteamService();
    const members = service.collectMembers(world.combat, "alpha");
    const ids = members.map(m => m.combatantId);
    assert.deepEqual(ids.sort(), [a.combatant.id, b.combatant.id, disabled.combatant.id].sort());
    assert.equal(members.find(m => m.combatantId === disabled.combatant.id).enabled, false);
    assert.equal(members.find(m => m.combatantId === a.combatant.id).enabled, true);
});

test("electLeader retains a valid flagged leader and elects deterministically", () => {
    const a = makeMember({ fireteam: { teamId: "alpha" }, initiative: 5 });
    const b = makeMember({ fireteam: { teamId: "alpha" }, initiative: 15 });
    const c = makeMember({ fireteam: { teamId: "alpha" }, initiative: 12 });
    const world = makeTeamWorld([a, b, c]);
    const service = createFireteamService();
    const members = service.collectMembers(world.combat, "alpha");

    const retained = service.electLeader(members, { seed: 1, leaderId: a.token.id });
    assert.equal(retained.combatantId, a.combatant.id);
    assert.equal(retained.reason, "retained");

    // Deterministic: identical members + seed elect the identical leader.
    const first = service.electLeader(members, { seed: 7 });
    const second = service.electLeader(members, { seed: 7 });
    assert.equal(first.combatantId, second.combatantId);
    assert.equal(first.reason, "elected");
    // Highest initiative wins.
    assert.equal(first.combatantId, b.combatant.id);

    // Equal initiative/hp → seed hash tie-break, still deterministic.
    const d = makeMember({ fireteam: { teamId: "alpha" }, initiative: 10, wounds: 8 });
    const e = makeMember({ fireteam: { teamId: "alpha" }, initiative: 10, wounds: 8 });
    const world2 = makeTeamWorld([d, e]);
    const members2 = service.collectMembers(world2.combat, "alpha");
    const tie1 = service.electLeader(members2, { seed: 3 });
    const tie2 = service.electLeader(members2, { seed: 3 });
    assert.equal(tie1.combatantId, tie2.combatantId);

    // Defeated and disabled members are ineligible.
    const dead = service.electLeader(
        members.map(m => m.combatantId === b.combatant.id
            ? { ...m, defeated: true } : m),
        { seed: 7 });
    assert.notEqual(dead.combatantId, b.combatant.id);
    assert.equal(service.electLeader([], { seed: 1 }).reason, "leader-unavailable");
});

test("assignTasks gives the leader assault, one flanker and the rest support", () => {
    const members = ["c1", "c2", "c3"].map(id => ({
        combatantId: id,
        tokenId: `t-${id}`,
        defeated: false,
        enabled: true,
        position: { x: 0, y: 0 }
    }));
    const service = createFireteamService();
    const assignments = service.assignTasks(members, { leaderId: "c2" });
    const byId = Object.fromEntries(assignments.map(a => [a.combatantId, a]));
    assert.equal(byId.c2.task, "assault");
    assert.equal(byId.c2.groupId, "main");
    assert.equal(byId.c2.leader, true);
    // First non-leader in stable id order takes the flank group.
    assert.equal(byId.c1.task, "flank");
    assert.equal(byId.c1.groupId, "flank-1");
    assert.equal(byId.c3.task, "support");
    assert.ok(assignments.every(a => FIRETEAM_TASKS.includes(a.task)));

    // Explicit assignments win; regroup forces everyone.
    const forced = service.assignTasks(members, {
        leaderId: "c2",
        assignments: { c1: "advance", c3: "assault" }
    });
    assert.equal(forced.find(a => a.combatantId === "c1").task, "advance");
    assert.equal(forced.find(a => a.combatantId === "c3").task, "assault");
    const regroup = service.assignTasks(members, { leaderId: "c2", regroup: true });
    assert.ok(regroup.every(a => a.task === "regroup"));

    // allowFlank=false keeps everyone on main group tasks.
    const noFlank = service.assignTasks(members, { leaderId: "c2", allowFlank: false });
    assert.ok(noFlank.every(a => a.groupId === "main"));
});

test("evaluateCohesion is a soft constraint with legal detached maneuvers", () => {
    const service = createFireteamService();
    const center = { x: 0, y: 0 };

    // Within preferred cohesion — no penalty.
    const inside = service.evaluateCohesion({
        endpoint: { x: 2, y: 0 },
        center,
        preferredCohesion: 5,
        task: "support"
    });
    assert.equal(inside.within, true);
    assert.equal(inside.penalty, 0);

    // Ordinary step beyond cohesion — allowed but penalized.
    const outside = service.evaluateCohesion({
        endpoint: { x: 9, y: 0 },
        center,
        preferredCohesion: 5,
        task: "support"
    });
    assert.equal(outside.within, false);
    assert.equal(outside.allowed, true);
    assert.equal(outside.detached, false);
    assert.ok(outside.penalty > 0);
    assert.equal(outside.reason, "beyond-cohesion");

    // Detached flank maneuver is legal with bounded separation + rejoin.
    const detached = service.evaluateCohesion({
        endpoint: { x: 12, y: 0 },
        center,
        preferredCohesion: 5,
        task: "flank",
        detachedUntilPhase: 1,
        maxDetachedPhases: 2,
        rejoinAvailable: true,
        reachable: true
    });
    assert.equal(detached.allowed, true);
    assert.equal(detached.detached, true);
    assert.equal(detached.reason, "detached-maneuver");

    // Same maneuver without a rejoin point or with unbounded separation
    // is rejected.
    const noRejoin = service.evaluateCohesion({
        endpoint: { x: 12, y: 0 },
        center,
        preferredCohesion: 5,
        task: "flank",
        detachedUntilPhase: 1,
        rejoinAvailable: false
    });
    assert.equal(noRejoin.allowed, false);
    assert.equal(noRejoin.reason, "no-rejoin");
    const unbounded = service.evaluateCohesion({
        endpoint: { x: 12, y: 0 },
        center,
        preferredCohesion: 5,
        task: "flank",
        detachedUntilPhase: 5,
        maxDetachedPhases: 2,
        rejoinAvailable: true
    });
    assert.equal(unbounded.allowed, false);
    assert.equal(unbounded.reason, "separation-unbounded");

    // An equal endpoint inside cohesion always scores better than the same
    // endpoint outside it for ordinary tasks.
    assert.ok(inside.penalty < outside.penalty);
    assert.equal(DEFAULT_PREFERRED_COHESION, 5);
});

test("reserveResources never assigns one target twice beyond task capacity", () => {
    const service = createFireteamService();
    const assignments = [
        { combatantId: "a", task: "flank", groupId: "flank-1", assignedTargetId: "T1" },
        { combatantId: "b", task: "flank", groupId: "flank-1", assignedTargetId: "T1" },
        { combatantId: "c", task: "assault", groupId: "main", assignedTargetId: "T1" }
    ];
    const plans = new Map([
        ["a", { plan: { target: { tokenId: "T1" }, steps: [{ type: "move", input: { to: { x: 10, y: 10 } } }] } }],
        ["b", { plan: { target: { tokenId: "T1" }, steps: [{ type: "move", input: { to: { x: 10, y: 10 } } }] } }],
        ["c", { plan: { target: { tokenId: "T1" }, steps: [] } }]
    ]);
    const result = service.reserveResources(assignments, plans, {
        taskCapacities: { flank: 1, assault: 2 }
    });
    const flankReservations = result.targets.filter(t => t.task === "flank");
    // flank capacity 1: only the first flanker keeps the target.
    assert.equal(flankReservations.length, 1);
    assert.equal(flankReservations[0].memberId, "a");
    const targetConflicts = result.conflicts.filter(c => c.type === "target");
    assert.equal(targetConflicts.length, 1);
    assert.equal(targetConflicts[0].loserId, "b");
    assert.equal(targetConflicts[0].winnerId, "a");
    // Endpoint collision: identical endpoint reserved once.
    const endpointConflicts = result.conflicts.filter(c => c.type === "endpoint");
    assert.equal(endpointConflicts.length, 1);
    assert.equal(endpointConflicts[0].loserId, "b");
    assert.equal(result.endpoints.length, 1);
    // assault capacity 2: no conflict for the third member.
    assert.equal(result.targets.filter(t => t.task === "assault").length, 1);
});

test("reservations reject swept path intersections and overlapping large endpoints", () => {
    const service = createFireteamService();
    const assignments = ["wide", "crossing", "overlap", "clear"].map(combatantId => ({
        combatantId, task: "advance"
    }));
    const point = (i, j) => ({ i, j, x: j * 100, y: i * 100 });
    const move = (...waypoints) => ({
        steps: [{ type: "move", input: { waypoints, to: waypoints.at(-1) } }]
    });
    const plans = {
        wide: move(point(1, 0), point(1, 1), point(1, 2)),
        crossing: move(point(0, 1), point(1, 1), point(2, 1), point(3, 1)),
        overlap: move(point(3, 3), point(2, 3)),
        clear: move(point(4, 4), point(4, 3))
    };
    const result = service.reserveResources(assignments, plans, {
        tokens: new Map([["wide", { width: 2, height: 2 }]])
    });
    assert.deepEqual(result.endpoints.map(entry => entry.memberId), ["wide", "clear"]);
    assert.deepEqual(result.conflicts.map(c => [c.type, c.loserId, c.winnerId]), [
        ["route", "crossing", "wide"], ["endpoint", "overlap", "wide"]
    ]);
});

test("TeamPlan measures cohesion in scene units, not canvas pixels", async () => {
    const leader = makeMember({ fireteam: { teamId: "alpha" }, initiative: 20 });
    const wing = makeMember({ fireteam: { teamId: "alpha" }, x: 300 });
    const world = makeTeamWorld([leader, wing]);
    const service = createFireteamService({ planner: createPlannerService() });
    const ctx = { targets: injectedTargets(world), moves: [], seed: 42 };
    const plan = async () => (await service.buildTeamPlan(world.combat, "alpha", ctx)).teamPlan;
    const cohesion = t => t.breakdown.cohesion.find(row => row.combatantId === wing.combatant.id);
    const nearby = await plan();
    assert.equal(cohesion(nearby).distance, 4.5);
    assert.equal(cohesion(nearby).within, true);
    wing.token.x = 400;
    const farther = await plan();
    assert.equal(cohesion(farther).distance, 6);
    assert.equal(cohesion(farther).within, false);
    assert.ok(farther.breakdown.cohesionPenalty > nearby.breakdown.cohesionPenalty);
});

test("buildTeamPlan produces a phased TeamPlan with barrier and assignments", async () => {
    const leader = makeMember({ fireteam: { teamId: "alpha" }, x: 0, y: 0, initiative: 20 });
    const flanker = makeMember({ fireteam: { teamId: "alpha" }, x: 50, y: 150, initiative: 10 });
    const support = makeMember({ fireteam: { teamId: "alpha" }, x: 100, y: 300, initiative: 8 });
    // Enemy far beyond weapon range: members must move, the detached
    // flanker leaves preferred cohesion for a legal maneuver.
    const world = makeTeamWorld([leader, flanker, support], { enemyX: 20000 });
    const service = createFireteamService({ planner: createPlannerService() });
    const result = await service.buildTeamPlan(world.combat, {
        teamId: "alpha",
        leaderId: leader.combatant.id
    }, { seed: 42, targets: injectedTargets(world) });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    const plan = result.teamPlan;

    assert.equal(plan.teamId, "alpha");
    assert.equal(plan.leaderId, leader.combatant.id);
    assert.equal(plan.combatId, world.combat.id);
    assert.equal(plan.round, 1);
    assert.equal(plan.seed, 42);
    assert.ok(typeof plan.revision === "string" && plan.revision.startsWith("t"));
    assert.equal(plan.members.length, 3);

    const byId = Object.fromEntries(plan.members.map(m => [m.combatantId, m]));
    assert.equal(byId[leader.combatant.id].task, "assault");
    assert.equal(byId[leader.combatant.id].leader, true);
    // First non-leader by stable id order takes the flank task.
    const flankMembers = plan.members.filter(m => m.task === "flank");
    assert.equal(flankMembers.length, 1);
    assert.equal(flankMembers[0].groupId, "flank-1");
    // Detached flank maneuver beyond cohesion keeps a rejoin point.
    if (flankMembers[0].detached) {
        assert.ok(flankMembers[0].rejoinPoint);
        assert.ok(flankMembers[0].detachedUntilPhase <= 2);
    }

    // Phases: movement → action (behind barrier) → regroup.
    assert.equal(plan.phases.length, 3);
    assert.equal(plan.phases[0].name, "movement");
    assert.equal(plan.phases[1].name, "action");
    assert.equal(plan.phases[2].name, "regroup");
    const barrier = plan.phases[1].barrier;
    assert.ok(barrier, "action phase is barrier-gated");
    assert.equal(barrier.afterPhase, "phase-0");
    assert.ok(barrier.requiredAssignmentIds.includes(flankMembers[0].combatantId));
    assert.ok(["hold", "abort", "continue"].includes(barrier.failurePolicy));
    // Flank move steps precede main-group steps inside the movement phase.
    const moveCombatants = plan.phases[0].steps.map(s => s.combatantId);
    const flankIdx = moveCombatants.indexOf(flankMembers[0].combatantId);
    if (flankIdx >= 0) {
        for (let i = flankIdx + 1; i < moveCombatants.length; i++) {
            const other = byId[moveCombatants[i]];
            assert.equal(other.groupId, "main");
        }
    }
    // Steps reference member plans, never Documents.
    for (const phase of plan.phases) {
        for (const step of phase.steps) {
            assert.equal(plan.memberPlans[step.combatantId]?.id, step.planId);
            if (step.type === "rejoin") {
                assert.ok(byId[step.combatantId].rejoinRoute.length);
                continue;
            }
            assert.equal(
                plan.memberPlans[step.combatantId]?.steps?.[step.stepIndex]?.type,
                step.type);
        }
    }

    // Serializable JSON round-trip + diagnostics.
    const roundTrip = JSON.parse(JSON.stringify(plan));
    assert.deepEqual(roundTrip, JSON.parse(JSON.stringify(roundTrip)));
    assert.equal(roundTrip.id, plan.id);
    assert.equal(roundTrip.members.length, 3);
    assert.equal(plan.diagnostics.seed, 42);
    assert.equal(plan.diagnostics.teamId, "alpha");
    assert.equal(plan.diagnostics.leaderId, leader.combatant.id);
    assert.ok(Array.isArray(plan.diagnostics.assignments));
    assert.ok(Array.isArray(plan.diagnostics.cohesion));
    assert.ok(plan.diagnostics.reservations);
});

test("buildTeamPlan is deterministic for identical input", async () => {
    const leader = makeMember({ fireteam: { teamId: "alpha" }, x: 0, initiative: 20 });
    const flanker = makeMember({ fireteam: { teamId: "alpha" }, x: 50, y: 150, initiative: 10 });
    const world = makeTeamWorld([leader, flanker], { enemyX: 20000 });
    const service = createFireteamService({ planner: createPlannerService() });
    const targets = injectedTargets(world);
    const r1 = await service.buildTeamPlan(world.combat,
        { teamId: "alpha" }, { seed: 9, targets });
    const r2 = await service.buildTeamPlan(world.combat,
        { teamId: "alpha" }, { seed: 9, targets });
    assert.equal(r1.status, FIRETEAM_STATUS.ok);
    assert.equal(r2.status, FIRETEAM_STATUS.ok);
    assert.equal(r1.teamPlan.id, r2.teamPlan.id);
    assert.deepEqual(
        JSON.parse(JSON.stringify(r1.teamPlan.members)),
        JSON.parse(JSON.stringify(r2.teamPlan.members)));
    assert.deepEqual(
        JSON.parse(JSON.stringify(r1.teamPlan.phases)),
        JSON.parse(JSON.stringify(r2.teamPlan.phases)));
});

test("buildTeamPlan reports no-members and leader-unavailable", async () => {
    const member = makeMember({ fireteam: { teamId: "alpha" } });
    const world = makeTeamWorld([member]);
    const service = createFireteamService();
    const empty = await service.buildTeamPlan(world.combat, { teamId: "ghost" }, { seed: 1 });
    assert.equal(empty.status, FIRETEAM_STATUS.noMembers);
    const ended = { ...world.combat, ended: true };
    const over = await service.buildTeamPlan(ended, { teamId: "alpha" }, { seed: 1 });
    assert.equal(over.status, FIRETEAM_STATUS.disabled);
    const waiting = await service.buildTeamPlan(world.combat, { teamId: "alpha" }, {
        seed: 1,
        authority: { status: "waiting-for-gm" }
    });
    assert.equal(waiting.status, FIRETEAM_STATUS.waitingForGm);
});

test("validateTeamPlan: fresh plan valid, leader loss elects a deterministic successor", async () => {
    const leader = makeMember({ fireteam: { teamId: "alpha" }, initiative: 20 });
    const second = makeMember({ fireteam: { teamId: "alpha" }, initiative: 15 });
    const third = makeMember({ fireteam: { teamId: "alpha" }, initiative: 5 });
    const world = makeTeamWorld([leader, second, third]);
    const service = createFireteamService({ planner: createPlannerService() });
    const built = await service.buildTeamPlan(world.combat, {
        teamId: "alpha",
        leaderId: leader.combatant.id
    }, { seed: 11, targets: injectedTargets(world) });
    assert.equal(built.status, FIRETEAM_STATUS.ok);
    const plan = built.teamPlan;

    const fresh = service.validateTeamPlan(plan, { combat: world.combat });
    assert.equal(fresh.valid, true);

    // Leader defeated → leader-lost + deterministic successor (highest
    // initiative among the survivors).
    leader.combatant.defeated = true;
    const lost = service.validateTeamPlan(plan, { combat: world.combat });
    assert.equal(lost.valid, false);
    assert.equal(lost.reason, TEAM_PLAN_REASONS.leaderLost);
    assert.ok(lost.successor);
    assert.equal(lost.successor.combatantId, second.combatant.id);
    const again = service.validateTeamPlan(plan, { combat: world.combat });
    assert.equal(again.successor.combatantId, second.combatant.id);

    // The stale plan is invalidated, never re-executed.
    const invalidated = service.invalidateTeamPlan(plan, TEAM_PLAN_REASONS.leaderLost);
    assert.equal(invalidated.invalidated, true);
    assert.equal(invalidated.invalidReason, "leader-lost");
    assert.deepEqual(JSON.parse(JSON.stringify(invalidated)).invalidReason, "leader-lost");

    // Non-leader member loss → member-unavailable.
    leader.combatant.defeated = false;
    third.combatant.defeated = true;
    const missing = service.validateTeamPlan(plan, { combat: world.combat });
    assert.equal(missing.valid, false);
    assert.equal(missing.reason, TEAM_PLAN_REASONS.memberUnavailable);

    // Round advance → turn-stale. Combat ended → combat-ended.
    third.combatant.defeated = false;
    const stale = service.validateTeamPlan(plan, {
        combat: { ...world.combat, round: 2 }
    });
    assert.equal(stale.reason, TEAM_PLAN_REASONS.turnStale);
    const over = service.validateTeamPlan(plan, {
        combat: { ...world.combat, ended: true }
    });
    assert.equal(over.reason, TEAM_PLAN_REASONS.combatEnded);
    assert.equal(service.validateTeamPlan(null, { combat: world.combat }).reason,
        TEAM_PLAN_REASONS.invalidPlan);
});

test("regroupPoints returns the leader point then the centroid", () => {
    const service = createFireteamService();
    const members = [
        { combatantId: "l", position: { x: 100, y: 100 } },
        { combatantId: "a", position: { x: 200, y: 100 } },
        { combatantId: "b", position: { x: 100, y: 200 } }
    ];
    const points = service.regroupPoints(members, { leaderId: "l" });
    assert.equal(points[0].source, "leader");
    assert.deepEqual({ x: points[0].x, y: points[0].y }, { x: 100, y: 100 });
    const centroid = points.find(p => p.source === "centroid");
    assert.ok(centroid);
    assert.ok(Math.abs(centroid.x - 400 / 3) < 1e-3);
    assert.ok(Math.abs(centroid.y - 400 / 3) < 1e-3);
});
