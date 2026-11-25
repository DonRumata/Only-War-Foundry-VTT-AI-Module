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
    normalizeFireteamAssignment,
    resolveTeamConfig
} from "../../scripts/fireteam.js";
import { createPlannerService } from "../../scripts/planner.js";
import { createTacticRegistry } from "../../scripts/tactics/registry.js";
import { selectSpecOpsTactic } from "../../scripts/presets/spec-ops.js";
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
    enemyActor.system = { wounds: { value: 0, max: 10 } };
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

test("assignTasks normalizes legacy strings and object assignments", () => {
    const members = ["c1", "c2", "c3"].map(id => ({
        combatantId: id,
        tokenId: `t-${id}`,
        defeated: false,
        enabled: true,
        position: { x: 0, y: 0 }
    }));
    const service = createFireteamService();
    const objective = {
        type: "suppress-zone",
        targetId: "member-target",
        lane: { id: "left", arc: 45, points: [{ x: 1, y: 2 }] }
    };
    const assignments = service.assignTasks(members, {
        leaderId: "c2",
        objective: { targetId: "shared-target", flankTargetId: "flank-target" },
        assignments: {
            c1: "advance",
            c2: { task: "flank", role: "suppressor", element: "fire", objective },
            c3: { task: "not-a-task", role: "cover" }
        }
    });
    const byId = Object.fromEntries(assignments.map(a => [a.combatantId, a]));

    assert.equal(byId.c1.task, "advance", "legacy string form remains explicit");
    assert.equal("role" in byId.c1, false);
    assert.equal("objective" in byId.c1, false);
    assert.equal(byId.c1.assignedTargetId, "shared-target");

    assert.equal(byId.c2.task, "flank");
    assert.equal(byId.c2.role, "suppressor");
    assert.equal(byId.c2.element, "fire");
    assert.deepEqual(byId.c2.objective, objective);
    assert.notEqual(byId.c2.objective, objective, "objective is cloned before freezing");
    assert.equal(byId.c2.assignedTargetId, "member-target",
        "a member objective target id wins over the shared objective and flank target");

    assert.equal(byId.c3.task, "support", "unknown tasks keep the legacy support fallback");
    assert.equal(byId.c3.role, "cover", "validation does not erase serialized metadata");

    objective.lane.id = "mutated";
    assert.equal(byId.c2.objective.lane.id, "left");
    const circular = { type: "bad" };
    circular.self = circular;
    assert.equal(normalizeFireteamAssignment({ task: "support", objective: circular }).objective,
        undefined);
    assert.deepEqual(normalizeFireteamAssignment("support"), { task: "support" });
});

test("buildTeamPlan carries object assignments to members, diagnostics and member contexts", async () => {
    const leader = makeMember({ fireteam: { teamId: "alpha" }, x: 0, y: 0, initiative: 20 });
    const flanker = makeMember({ fireteam: { teamId: "alpha" }, x: 100, y: 0, initiative: 10 });
    const world = makeTeamWorld([leader, flanker]);
    const objective = { type: "screen", targetId: world.enemyToken.id, lane: { id: "left" } };
    const contexts = [];
    const fakePlanner = {
        planTurn: async (combat, combatant, context) => {
            contexts.push({ combatantId: combatant.id, team: context.team });
            const moving = combatant.id === flanker.combatant.id;
            return {
                status: "ok",
                plan: {
                    id: `plan-${combatant.id}`,
                    score: 1,
                    target: null,
                    snapshot: { targets: [] },
                    steps: [
                        ...(moving ? [{
                            id: "move-1", type: "move",
                            input: { to: { x: 200, y: 0 }, waypoints: [{ x: 200, y: 0 }] },
                            cost: { halves: 1, movement: 1 }
                        }] : []),
                        { id: "end-1", type: "end-turn", input: {}, cost: {} }
                    ],
                    diagnostics: { layers: [] }
                }
            };
        }
    };
    const service = createFireteamService({ planner: fakePlanner });
    const result = await service.buildTeamPlan(world.combat, {
        teamId: "alpha",
        leaderId: leader.combatant.id
    }, {
        seed: 42,
        objective: { targetId: "shared-target" },
        targets: [],
        assignments: {
            [leader.combatant.id]: { task: "support", role: "suppressor", element: "fire" },
            [flanker.combatant.id]: {
                task: "flank", role: "interdictor", element: "screen", objective
            }
        }
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    const plan = result.teamPlan;
    const leaderEntry = plan.members.find(m => m.combatantId === leader.combatant.id);
    const flankerEntry = plan.members.find(m => m.combatantId === flanker.combatant.id);
    assert.equal(leaderEntry.role, "suppressor");
    assert.equal(leaderEntry.element, "fire");
    assert.equal("objective" in leaderEntry, false);
    assert.equal(flankerEntry.role, "interdictor");
    assert.equal(flankerEntry.element, "screen");
    assert.deepEqual(flankerEntry.objective, objective);
    assert.equal(flankerEntry.assignedTargetId, objective.targetId,
        "the member objective target id wins assignedTargetId over the shared objective");
    assert.equal(plan.objective, "shared-target",
        "the TeamPlan shared objective remains the legacy scalar channel");
    assert.equal(Object.isFrozen(flankerEntry.objective), true);
    assert.equal(Object.isFrozen(flankerEntry.objective.lane), true);

    const diagnostic = plan.diagnostics.assignments
        .find(a => a.combatantId === flanker.combatant.id);
    assert.equal(diagnostic.role, "interdictor");
    assert.deepEqual(diagnostic.objective, objective);
    const roundTrip = JSON.parse(JSON.stringify(plan));
    assert.deepEqual(roundTrip.members.find(m => m.combatantId === flanker.combatant.id).objective,
        objective);
    assert.deepEqual(roundTrip.diagnostics.assignments.find(
        a => a.combatantId === flanker.combatant.id).objective, objective);

    const flankContext = contexts.find(c => c.combatantId === flanker.combatant.id).team;
    assert.equal(flankContext.role, "interdictor");
    assert.equal(flankContext.element, "screen");
    assert.equal(flankContext.objective, "shared-target",
        "legacy team.objective remains the scalar shared target id");
    assert.equal(flankContext.sharedObjective, undefined,
        "the redundant sharedObjective alias is not part of the clean contract");
    assert.deepEqual(flankContext.memberObjective, objective);
    assert.deepEqual(flankContext.assignment, {
        task: "flank",
        role: "interdictor",
        element: "screen",
        objective
    });
    const leaderContext = contexts.find(c => c.combatantId === leader.combatant.id).team;
    assert.equal(leaderContext.role, "suppressor");
    assert.equal(leaderContext.objective, "shared-target");
    assert.equal(leaderContext.memberObjective, null);
    assert.deepEqual(leaderContext.assignment, {
        task: "support",
        role: "suppressor",
        element: "fire"
    });

    const barrier = plan.phases.find(phase => phase.name === "action").barrier;
    assert.deepEqual(barrier.requiredAssignmentIds, [flanker.combatant.id],
        "roles do not widen or alter synchronization barriers");
});

test("target-conflict retry keeps object assignment metadata in the member context", async () => {
    const leader = makeMember({ fireteam: { teamId: "alpha" }, initiative: 20 });
    const flanker = makeMember({ fireteam: { teamId: "alpha" }, x: 100, initiative: 10 });
    const world = makeTeamWorld([leader, flanker]);
    const primary = world.enemyToken.id;
    const secondary = "target-secondary";
    const objective = { type: "screen", targetId: primary, lane: "left" };
    const calls = [];
    const fakePlanner = {
        planTurn: async (combat, combatant, context) => {
            calls.push({
                combatantId: combatant.id,
                replanCount: context.replanCount,
                team: context.team
            });
            const targetId = context.replanCount
                ? (context.targets?.[0]?.tokenId ?? secondary)
                : primary;
            return {
                status: "ok",
                plan: {
                    id: `plan-${combatant.id}-${calls.length}`,
                    score: 1,
                    target: { tokenId: targetId },
                    snapshot: { targets: context.targets ?? [] },
                    steps: [{ id: "end-1", type: "end-turn", input: {}, cost: {} }],
                    diagnostics: { layers: [] }
                }
            };
        }
    };
    const service = createFireteamService({ planner: fakePlanner });
    const result = await service.buildTeamPlan(world.combat, {
        teamId: "alpha",
        leaderId: leader.combatant.id
    }, {
        seed: 5,
        personality: false,
        objective: { targetId: "shared-target" },
        targets: [
            { tokenId: primary, x: 2000, y: 0, canAttack: true },
            { tokenId: secondary, x: 2100, y: 0, canAttack: true }
        ],
        assignments: {
            [leader.combatant.id]: { task: "flank", role: "cover" },
            [flanker.combatant.id]: {
                task: "flank", role: "interdictor", element: "screen", objective
            }
        }
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    const flankCalls = calls.filter(call => call.combatantId === flanker.combatant.id);
    assert.equal(flankCalls.length, 2, "the capacity loser is retargeted once");
    assert.equal(flankCalls[1].replanCount, 1);
    assert.equal(flankCalls[1].team.role, "interdictor");
    assert.equal(flankCalls[1].team.element, "screen");
    assert.equal(flankCalls[1].team.objective, "shared-target",
        "target-conflict replans keep the legacy scalar shared objective");
    assert.deepEqual(flankCalls[1].team.memberObjective, objective);
    assert.deepEqual(flankCalls[1].team.assignment, {
        task: "flank",
        role: "interdictor",
        element: "screen",
        objective
    });
    const entry = result.teamPlan.members.find(m => m.combatantId === flanker.combatant.id);
    assert.equal(entry.role, "interdictor");
    assert.deepEqual(entry.objective, objective);
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
        { combatantId: "a", task: "flank", groupId: "flank-1", assignedTargetId: "T1",
            role: "flank-left", element: "left", objective: { type: "screen" } },
        { combatantId: "b", task: "flank", groupId: "flank-1", assignedTargetId: "T1",
            role: "flank-right", element: "right", objective: { type: "interdict" } },
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
    assert.deepEqual(flankReservations.map(t => t.key), ["flank|flank-1|T1"],
        "reservation keys are task|groupId|targetId (issue #88) and never include role/element");
    const targetConflicts = result.conflicts.filter(c => c.type === "target");
    assert.equal(targetConflicts.length, 1);
    assert.equal(targetConflicts[0].key, "flank|flank-1|T1");
    assert.equal(targetConflicts[0].loserId, "b");
    assert.equal(targetConflicts[0].winnerId, "a");
    const plainAssignments = assignments.map(({ role, element, objective, ...rest }) => rest);
    const plainResult = service.reserveResources(plainAssignments, plans, {
        taskCapacities: { flank: 1, assault: 2 }
    });
    assert.deepEqual(
        result.targets.map(({ key, task, targetId, memberId }) => ({ key, task, targetId, memberId })),
        plainResult.targets.map(({ key, task, targetId, memberId }) => ({ key, task, targetId, memberId })),
        "role/element metadata does not change target reservations");
    assert.deepEqual(result.conflicts, plainResult.conflicts,
        "role/element metadata does not change reservation conflicts");
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
    }, { seed: 42, personality: false, targets: injectedTargets(world) });
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

test("target-conflict retry replans keep the full team context (issue #93)", async () => {
    const leader = makeMember({ fireteam: { teamId: "alpha" }, x: 0, initiative: 20 });
    const second = makeMember({ fireteam: { teamId: "alpha" }, x: 100, initiative: 15 });
    const world = makeTeamWorld([leader, second]);
    // Stub planner: both members engage the same target, so the
    // capacity-1 reservation conflicts and the loser replans once.
    const contexts = new Map();
    const stubPlanner = {
        planTurn: async (combat, combatant, context) => {
            const list = contexts.get(combatant.id) ?? [];
            list.push(context);
            contexts.set(combatant.id, list);
            return {
                status: "ok",
                reason: null,
                plan: {
                    id: `plan-${combatant.id}-${list.length}`,
                    target: { tokenId: world.enemyToken.id },
                    steps: [{
                        id: "step-end-turn-1",
                        type: "end-turn",
                        cost: {},
                        input: {},
                        preconditions: ["turn"],
                        projectedResourceDelta: {}
                    }],
                    snapshot: { targets: [] },
                    diagnostics: { layers: [] }
                }
            };
        }
    };
    const service = createFireteamService({ planner: stubPlanner });
    const result = await service.buildTeamPlan(world.combat, {
        teamId: "alpha",
        leaderId: leader.combatant.id
    }, {
        seed: 5,
        targets: injectedTargets(world),
        assignments: {
            [leader.combatant.id]: "assault",
            [second.combatant.id]: "assault"
        },
        taskCapacities: { assault: 1 },
        tactic: {
            name: "test-tactic",
            objective: { targetId: "obj-1", flankPoint: { x: 50, y: 60 } }
        }
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    // Exactly one member lost the target reservation and replanned.
    const retried = [...contexts.entries()].filter(([, list]) => list.length > 1);
    assert.equal(retried.length, 1, "one member replans after losing the target");
    const [[, list]] = retried;
    assert.equal(list.length, 2, "the loser replans exactly once");
    const [first, retry] = list;
    assert.equal(retry.replanCount, first.replanCount + 1);
    // The team metadata of the first pass survives the retry verbatim —
    // the partial rebuild used to drop every field below.
    assert.deepEqual(retry.team.center, first.team.center, "center preserved");
    assert.equal(retry.team.objective, "obj-1", "tactic objective preserved");
    assert.deepEqual(retry.team.flankPoint, { x: 50, y: 60 }, "flankPoint preserved");
    assert.equal(retry.team.leaderId, first.team.leaderId);
    assert.equal(retry.team.teamId, first.team.teamId);
    assert.deepEqual(retry.team.contacts, first.team.contacts);
    assert.equal(retry.team.task, first.team.task);
    assert.equal(retry.tactic, first.tactic, "tactic name preserved");
});

test("buildTeamPlan resolves a registered preset tactic and empty presets fall back", async () => {
    const flag = { teamId: "alpha", teamPreset: "assault" };
    const leader = makeMember({ fireteam: flag, x: 0, y: 0, initiative: 20 });
    const wing = makeMember({ fireteam: flag, x: 100, y: 0, initiative: 10 });
    const world = makeTeamWorld([leader, wing], { enemyX: 400 });
    const tactics = createTacticRegistry();
    let selectorInput = null;
    tactics.registerTacticSelector({
        presetId: "assault",
        kind: "maneuver",
        priority: 10,
        select: input => {
            selectorInput = input;
            return {
                name: "registered-test-maneuver",
                reason: "registered",
                assignments: {
                    [leader.combatant.id]: "support",
                    [wing.combatant.id]: "support"
                },
                allowFlank: false,
                breakdown: { source: "test" }
            };
        }
    });
    const service = createFireteamService({ planner: createPlannerService(), tactics });
    const result = await service.buildTeamPlan(world.combat, "alpha", {
        seed: 42,
        targets: injectedTargets(world)
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    assert.equal(result.teamPlan.tactic, "registered-test-maneuver");
    assert.equal(result.teamPlan.diagnostics.tactic.reason, "registered");
    assert.ok(result.teamPlan.members.every(member => member.task === "support"));
    assert.equal(selectorInput.teamId, "alpha");
    assert.equal(selectorInput.members.length, 2);
    const inputTurns = Object.fromEntries(
        selectorInput.members.map(member => [member.combatantId, member.turnIndex]));
    assert.equal(inputTurns[leader.combatant.id], 0);
    assert.equal(inputTurns[wing.combatant.id], 1);
    assert.ok(selectorInput.members.every(member => member.hasActed === false));

    // assault/rangedCover/hold have the same registry hook; without a
    // registered selector the historical default assignment policy applies.
    const unregistered = await service.buildTeamPlan(world.combat, "alpha", {
        seed: 42,
        targets: injectedTargets(world),
        teamPreset: "rangedCover"
    });
    assert.equal(unregistered.status, FIRETEAM_STATUS.ok);
    assert.equal(unregistered.teamPlan.tactic, null);
    assert.equal(unregistered.teamPlan.diagnostics.tactic, null);
});

test("registry selector errors degrade to the legacy tactic-error diagnostic", async () => {
    const flag = { teamId: "alpha", teamPreset: "assault" };
    const leader = makeMember({ fireteam: flag, x: 0, y: 0, initiative: 20 });
    const wing = makeMember({ fireteam: flag, x: 100, y: 0, initiative: 10 });
    const world = makeTeamWorld([leader, wing], { enemyX: 400 });
    const tactics = createTacticRegistry();
    tactics.registerTacticSelector("assault", () => {
        throw new Error("broken selector");
    });
    const service = createFireteamService({ planner: createPlannerService(), tactics });
    const result = await service.buildTeamPlan(world.combat, "alpha", {
        seed: 42,
        targets: injectedTargets(world)
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    assert.equal(result.teamPlan.tactic, null);
    assert.equal(result.teamPlan.diagnostics.tactic.reason, "tactic-error");
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

test("collectMembers exposes combat turnIndex and hasActed without changing order", () => {
    const a = makeMember({ fireteam: { teamId: "alpha" } });
    const b = makeMember({ fireteam: { teamId: "alpha" } });
    const world = makeTeamWorld([a, b]);
    // Deliberately use a turn order different from combatant-id order.
    world.combat.turns = [b.combatant, a.combatant, world.enemy];
    world.combat.turn = 1;
    const service = createFireteamService();
    const members = service.collectMembers(world.combat, "alpha");
    const byId = Object.fromEntries(members.map(member => [member.combatantId, member]));
    assert.equal(byId[a.combatant.id].turnIndex, 1);
    assert.equal(byId[a.combatant.id].hasActed, false);
    assert.equal(byId[b.combatant.id].turnIndex, 0);
    assert.equal(byId[b.combatant.id].hasActed, true);

    // Foundry reports `turn: null` before the first activation: nobody has
    // acted, but the indexes remain available to tactics.
    world.combat.turn = null;
    for (const member of service.collectMembers(world.combat, "alpha")) {
        assert.equal(member.hasActed, false);
        assert.notEqual(member.turnIndex, null);
    }

    // Older/headless combat fixtures without `turns` degrade to null/false.
    const withoutTurns = { ...world.combat, turns: undefined, turn: 0 };
    for (const member of service.collectMembers(withoutTurns, "alpha")) {
        assert.equal(member.turnIndex, null);
        assert.equal(member.hasActed, false);
    }
});

/* ------------------------------------------------------------------ */
/* Concentrate-fire integration (issue #85)                           */
/* ------------------------------------------------------------------ */

/**
 * Build a team world with several injected-focus hostiles.
 * @param {number} memberCount Living team size.
 * @param {object[]} specs Enemy extras (`x`, `y`, `wounds`, `items`).
 * @returns {object}
 */
function makeFocusWorld(memberCount, specs) {
    const members = Array.from({ length: memberCount }, (_, index) => makeMember({
        fireteam: { teamId: "alpha" },
        x: index * 100,
        y: 0,
        initiative: 20 - index
    }));
    const scene = makeScene({ grid: "square" });
    const enemies = specs.map((spec, index) => {
        const actor = makeActor();
        actor.system = { wounds: { value: 0, max: spec.wounds ?? 100 } };
        actor.items = spec.items ?? [];
        const token = makeToken({ actor });
        token.x = spec.x ?? 2000;
        token.y = spec.y ?? index * 200;
        token.elevation = 0;
        token.disposition = 1;
        const combatant = makeCombatant({ actor, token });
        combatant.tokenId = token.id;
        return { actor, token, combatant };
    });
    const combat = makeCombat({
        round: 2,
        turn: 0,
        combatants: [...members.map(member => member.combatant),
            ...enemies.map(enemy => enemy.combatant)]
    });
    combat.scene = scene;
    combat.ended = false;
    return { scene, combat, members, enemies };
}

/**
 * Injected visible target entries matching {@link makeFocusWorld} enemies.
 * @param {object} world
 * @param {object[]} [overrides] Per-enemy target overrides.
 * @returns {object[]}
 */
function focusTargets(world, overrides = []) {
    return world.enemies.map((enemy, index) => ({
        tokenId: enemy.token.id,
        tokenUuid: `Scene.${world.scene.id}.Token.${enemy.token.id}`,
        actorId: enemy.actor.id,
        x: enemy.token.x,
        y: enemy.token.y,
        wounds: 100,
        threatEv: 5,
        statuses: [],
        reactionUsed: null,
        allyEngaged: false,
        source: "visible",
        canAttack: true,
        ...(overrides[index] ?? {})
    }));
}

/**
 * Capture member planner contexts while returning minimal valid plans.
 * @returns {{planner: object, calls: object[]}}
 */
function captureFireteamPlanner() {
    const calls = [];
    return {
        calls,
        planner: {
            planTurn: async (combat, combatant, context) => {
                calls.push({
                    combatantId: combatant.id,
                    context,
                    attackTargetIds: Array.isArray(context.attackTargetIds)
                        ? [...context.attackTargetIds] : context.attackTargetIds,
                    excludedAttackTargetIds: Array.isArray(context.excludedAttackTargetIds)
                        ? [...context.excludedAttackTargetIds] : context.excludedAttackTargetIds,
                    targetCount: Array.isArray(context.targets) ? context.targets.length : null,
                    replanCount: context.replanCount
                });
                const attackId = Array.isArray(context.attackTargetIds)
                    && context.attackTargetIds.length
                    ? context.attackTargetIds[0] : null;
                return {
                    status: "ok",
                    plan: {
                        id: `plan-${combatant.id}-${calls.length}`,
                        score: 1,
                        target: attackId ? { tokenId: attackId } : null,
                        snapshot: { targets: context.targets ?? [] },
                        steps: [{ id: "end-1", type: "end-turn", input: {}, cost: {} }],
                        diagnostics: { layers: [] }
                    }
                };
            }
        }
    };
}

test("concentrate-fire: scored focus assigns capacity, roles and split attack pools", async () => {
    const world = makeFocusWorld(3, [{}, {}, {}].map((_, index) => ({ y: index * 200 })));
    const focusId = world.enemies[0].token.id;
    const otherId = world.enemies[1].token.id;
    const targets = focusTargets(world, [
        { threatEv: 20, statuses: ["pinned"], reactionUsed: true },
        { threatEv: 5 },
        { threatEv: 2 }
    ]);
    const capture = captureFireteamPlanner();
    const service = createFireteamService({ planner: capture.planner });
    const result = await service.buildTeamPlan(world.combat, {
        teamId: "alpha",
        leaderId: world.members[0].combatant.id
    }, {
        seed: 17,
        teamPreset: "rangedCover",
        targets
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    const focus = result.teamPlan.convergence;
    assert.ok(focus, "a positive scored focus is selected");
    assert.equal(focus.mode, "focus");
    assert.equal(focus.targetId, focusId);
    assert.equal(focus.wounds, 100);
    assert.ok(focus.focusScore > 0);
    assert.equal(focus.capableMembers.length, 3);
    assert.equal(focus.focusCap, 2, "rangedCover keeps one capable member outside the focus");
    assert.equal(focus.assignedMembers.length, 2);
    assert.equal(focus.excludedMembers.length, 1);
    assert.equal(result.teamPlan.diagnostics.convergence, null,
        "the legacy convergence diagnostic alias remains kill-mode-only");
    assert.equal(result.teamPlan.diagnostics.focus.coefficients.focusCapShare, 0.75);
    assert.ok(result.teamPlan.diagnostics.focus.candidates.some(c => c.targetId === focusId));
    assert.deepEqual(JSON.parse(JSON.stringify(focus)), focus);

    const assigned = new Set(focus.assignedMembers);
    const excluded = new Set(focus.excludedMembers);
    for (const entry of result.teamPlan.members) {
        if (assigned.has(entry.combatantId)) {
            assert.equal(entry.assignedTargetId, focusId);
            assert.equal(entry.role, "focus");
        } else if (excluded.has(entry.combatantId)) {
            assert.equal(entry.assignedTargetId, null,
                "capable overflow receives no focus assignedTargetId");
            assert.notEqual(entry.role, "focus");
        }
    }
    for (const call of capture.calls) {
        assert.equal(call.targetCount, 3,
            "every member keeps the full threat/awareness pool");
        if (assigned.has(call.combatantId)) {
            assert.ok(call.attackTargetIds.includes(focusId));
            assert.ok(!call.attackTargetIds.includes(otherId),
                "the focus allow-list narrows only direct attacks");
        } else if (excluded.has(call.combatantId)) {
            assert.equal(call.attackTargetIds, undefined);
            assert.ok(call.excludedAttackTargetIds.includes(focusId),
                "overflow receives the focus target as a deny-list entry");
        }
    }
});

test("concentrate-fire: injected visibility gate rejects hidden and memory-only hostiles", async () => {
    const world = makeFocusWorld(3, [{}, {}, {}, {}].map((_, index) => ({ y: index * 200 })));
    const hiddenId = world.enemies[0].token.id;
    const visibleId = world.enemies[1].token.id;
    const memoryId = world.enemies[3].token.id;
    const targets = focusTargets(world, [
        { threatEv: 30, statuses: ["pinned", "stunned"], reactionUsed: true, visible: false },
        { threatEv: 10 },
        { threatEv: 5 },
        { threatEv: 30, statuses: ["pinned"], reactionUsed: true, source: "last-known" }
    ]);
    const capture = captureFireteamPlanner();
    const service = createFireteamService({ planner: capture.planner });
    const result = await service.buildTeamPlan(world.combat, "alpha", {
        seed: 3,
        teamPreset: "rangedCover",
        targets
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    assert.equal(result.teamPlan.convergence?.targetId, visibleId,
        "the strongest hostiles are ignored when no living member currently sees them");
    assert.ok(result.teamPlan.diagnostics.focus.unseenTargetIds.includes(hiddenId));
    assert.ok(result.teamPlan.diagnostics.focus.unseenTargetIds.includes(memoryId));
    assert.ok(!result.teamPlan.diagnostics.focus.candidates.some(c => c.targetId === hiddenId));
    assert.ok(!result.teamPlan.diagnostics.focus.candidates.some(c => c.targetId === memoryId));
});

test("concentrate-fire: live scan without perception visibility selects no focus", async () => {
    const leader = makeMember({ fireteam: { teamId: "alpha" }, initiative: 20 });
    const second = makeMember({ fireteam: { teamId: "alpha" }, x: 100, initiative: 15 });
    const world = makeTeamWorld([leader, second]);
    const service = createFireteamService({ planner: captureFireteamPlanner().planner });
    const result = await service.buildTeamPlan(world.combat, "alpha", {
        seed: 5,
        perception: { hasLineOfSight: () => false }
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    assert.equal(result.teamPlan.convergence, null);
    assert.equal(result.teamPlan.diagnostics.focus.visibleTargets, 0);
    assert.equal(result.teamPlan.diagnostics.focus.reason, "no-candidates");
});

test("concentrate-fire: kill mode remains the legacy whole-team convergence", async () => {
    const world = makeFocusWorld(3, [{}]);
    const targetId = world.enemies[0].token.id;
    const capture = captureFireteamPlanner();
    const service = createFireteamService({ planner: capture.planner });
    const result = await service.buildTeamPlan(world.combat, "alpha", {
        seed: 5,
        teamPreset: "assault",
        targets: focusTargets(world, [{ wounds: 10, threatEv: 8 }])
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    const focus = result.teamPlan.convergence;
    assert.equal(focus.mode, "kill");
    assert.equal(focus.targetId, targetId);
    assert.equal(focus.assignedMembers.length, 3);
    assert.deepEqual(focus.excludedMembers, []);
    assert.equal(result.teamPlan.diagnostics.convergence.targetId, targetId,
        "kill mode keeps the backward-compatible diagnostics alias");
    assert.equal(result.teamPlan.members.every(m => m.assignedTargetId === targetId), true);
    assert.equal(result.teamPlan.members.every(m => m.role !== "focus"), true,
        "legacy kill convergence does not invent focus roles");
    for (const call of capture.calls) {
        assert.ok(call.attackTargetIds.includes(targetId));
    }
});

test("concentrate-fire: caller attack pools are hard constraints and deny-lists survive", async () => {
    const world = makeFocusWorld(3, [{}, {}, {}].map((_, index) => ({ y: index * 200 })));
    const focusId = world.enemies[0].token.id;
    const otherId = world.enemies[1].token.id;
    const targets = focusTargets(world, [
        { threatEv: 20, statuses: ["pinned"], reactionUsed: true },
        { threatEv: 5 },
        { threatEv: 2 }
    ]);
    const positive = captureFireteamPlanner();
    const service = createFireteamService({ planner: positive.planner });
    const allowed = await service.buildTeamPlan(world.combat, "alpha", {
        seed: 17,
        teamPreset: "rangedCover",
        targets,
        attackTargetIds: [focusId, "caller-other"],
        excludedAttackTargetIds: ["caller-denied"]
    });
    assert.equal(allowed.status, FIRETEAM_STATUS.ok);
    const focus = allowed.teamPlan.convergence;
    for (const call of positive.calls) {
        if (focus.assignedMembers.includes(call.combatantId)) {
            assert.ok(call.attackTargetIds.includes(focusId));
            assert.ok(!call.attackTargetIds.includes("caller-other"),
                "focus intersection narrows the caller allow-list to the focus target");
        }
        if (focus.excludedMembers.includes(call.combatantId)) {
            assert.ok(call.excludedAttackTargetIds.includes("caller-denied"),
                "the caller deny-list is preserved");
            assert.ok(call.excludedAttackTargetIds.includes(focusId));
        }
    }

    const negative = captureFireteamPlanner();
    const negativeService = createFireteamService({ planner: negative.planner });
    const blocked = await negativeService.buildTeamPlan(world.combat, "alpha", {
        seed: 17,
        teamPreset: "rangedCover",
        targets,
        attackTargetIds: [otherId]
    });
    assert.equal(blocked.status, FIRETEAM_STATUS.ok);
    const blockedFocus = blocked.teamPlan.convergence;
    for (const call of negative.calls) {
        if (blockedFocus.assignedMembers.includes(call.combatantId)) {
            assert.deepEqual(call.attackTargetIds, [],
                "a caller allow-list outside the focus stays an active empty intersection");
        }
    }
});

test("concentrate-fire: assault doctrine treats an engaged ally as gang-up", async () => {
    const world = makeFocusWorld(3, [{}, {}].map((_, index) => ({ y: index * 200 })));
    const gangUpId = world.enemies[0].token.id;
    const capture = captureFireteamPlanner();
    const service = createFireteamService({ planner: capture.planner });
    const result = await service.buildTeamPlan(world.combat, "alpha", {
        seed: 11,
        teamPreset: "assault",
        targets: focusTargets(world, [
            { threatEv: 10, allyEngaged: true },
            { threatEv: 10 }
        ])
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    assert.equal(result.teamPlan.convergence?.targetId, gangUpId);
    assert.equal(result.teamPlan.diagnostics.focus.coefficients.gangUp, true);
    assert.equal(result.teamPlan.diagnostics.focus.coefficients.focusCapShare, 1);
    assert.equal(result.teamPlan.convergence.breakdown.friendlyFireTerm, 0.75);
});

test("concentrate-fire: specOps registry receives the selected focus objective", async () => {
    const world = makeFocusWorld(3, [{}, {}].map((_, index) => ({ y: index * 200 })));
    const focusId = world.enemies[0].token.id;
    const targets = focusTargets(world, [
        { threatEv: 20, statuses: ["pinned"], reactionUsed: true },
        { threatEv: 5 }
    ]);
    const capture = captureFireteamPlanner();
    const registry = createTacticRegistry();
    let selectorInput = null;
    registry.registerTacticSelector({
        presetId: "specOps",
        select: input => {
            selectorInput = input;
            return selectSpecOpsTactic(input);
        }
    });
    const service = createFireteamService({ planner: capture.planner, tactics: registry });
    const result = await service.buildTeamPlan(world.combat, "alpha", {
        seed: 19,
        teamPreset: "specOps",
        targets
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    assert.equal(result.teamPlan.convergence?.targetId, focusId);
    assert.equal(selectorInput?.objective?.targetId, focusId,
        "focus selection happens before the preset maneuver selector");
    assert.equal(result.teamPlan.tactic, "coordinated-assault");
    assert.equal(result.teamPlan.objective, focusId,
        "the fallback objective chain keeps coordinated assault on the same target");
});

test("concentrate-fire: selection is deterministic across target-list shuffles", async () => {
    const world = makeFocusWorld(3, [{}, {}, {}].map((_, index) => ({ y: index * 200 })));
    const targets = focusTargets(world, [
        { threatEv: 20, statuses: ["pinned"], reactionUsed: true },
        { threatEv: 5 },
        { threatEv: 2 }
    ]);
    const run = async list => {
        const capture = captureFireteamPlanner();
        const service = createFireteamService({ planner: capture.planner });
        const result = await service.buildTeamPlan(world.combat, "alpha", {
            seed: 23,
            teamPreset: "rangedCover",
            targets: list
        });
        assert.equal(result.status, FIRETEAM_STATUS.ok);
        return JSON.parse(JSON.stringify(result.teamPlan.convergence));
    };
    const forward = await run(targets);
    const repeated = await run([...targets]);
    const shuffled = await run([...targets].reverse());
    assert.deepEqual(repeated, forward);
    assert.deepEqual(shuffled, forward);
});

test("concentrate-fire: target-conflict retry drops the derived focus allow-list", async () => {
    const world = makeFocusWorld(2, [{}, {}].map((_, index) => ({ y: index * 200 })));
    const focusId = world.enemies[0].token.id;
    const otherId = world.enemies[1].token.id;
    const calls = new Map();
    const planner = {
        planTurn: async (combat, combatant, context) => {
            const list = calls.get(combatant.id) ?? [];
            list.push({
                attackTargetIds: Array.isArray(context.attackTargetIds)
                    ? [...context.attackTargetIds] : context.attackTargetIds,
                role: context.team?.role ?? null,
                replanCount: context.replanCount
            });
            calls.set(combatant.id, list);
            // The stub deliberately ignores the focus allow-list on the first
            // pass so both assault members collide on the non-focus target.
            const targetId = context.replanCount
                ? (context.targets?.[0]?.tokenId ?? focusId)
                : otherId;
            return {
                status: "ok",
                plan: {
                    id: `plan-${combatant.id}-${list.length}`,
                    score: 1,
                    target: { tokenId: targetId },
                    snapshot: { targets: context.targets ?? [] },
                    steps: [{ id: "end-1", type: "end-turn", input: {}, cost: {} }],
                    diagnostics: { layers: [] }
                }
            };
        }
    };
    const service = createFireteamService({ planner });
    const assignments = Object.fromEntries(world.members.map(member => [
        member.combatant.id, "assault"
    ]));
    const result = await service.buildTeamPlan(world.combat, "alpha", {
        seed: 29,
        teamPreset: "assault",
        targets: focusTargets(world, [
            { threatEv: 20, statuses: ["pinned"], reactionUsed: true },
            { threatEv: 5 }
        ]),
        assignments,
        taskCapacities: { assault: 1 }
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    assert.equal(result.teamPlan.convergence?.targetId, focusId);
    const retried = [...calls.values()].filter(list => list.length > 1);
    assert.equal(retried.length, 1, "the non-focus target collision replans once");
    const [first, retry] = retried[0];
    assert.ok(first.attackTargetIds.includes(focusId),
        "the first pass carries the derived focus allow-list");
    assert.equal(retry.attackTargetIds, undefined,
        "target-conflict retry is no longer assigned-narrowed");
    assert.equal(retry.role, "focus", "focus metadata survives the retry");
    assert.equal(retry.replanCount, first.replanCount + 1);
});

test("concentrate-fire: a redirecting member objective wins over focus pools", async () => {
    const world = makeFocusWorld(3, [{}, {}, {}].map((_, index) => ({ y: index * 200 })));
    const focusId = world.enemies[0].token.id;
    const otherId = world.enemies[1].token.id;
    const leaderId = world.members[0].combatant.id;
    const targets = focusTargets(world, [
        { threatEv: 20, statuses: ["pinned"], reactionUsed: true },
        { threatEv: 5 },
        { threatEv: 2 }
    ]);
    const capture = captureFireteamPlanner();
    const service = createFireteamService({ planner: capture.planner });
    const result = await service.buildTeamPlan(world.combat, "alpha", {
        seed: 31,
        teamPreset: "rangedCover",
        targets,
        assignments: {
            [leaderId]: {
                task: "assault",
                objective: { type: "screen", targetId: otherId }
            }
        }
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    assert.equal(result.teamPlan.convergence?.targetId, focusId);
    const leaderCall = capture.calls.find(call => call.combatantId === leaderId);
    assert.equal(leaderCall.attackTargetIds, undefined,
        "the explicit member objective is not narrowed back to the focus target");
    assert.equal(result.teamPlan.members.find(m => m.combatantId === leaderId).assignedTargetId,
        otherId, "member objective precedence over the shared focus is preserved");
});
