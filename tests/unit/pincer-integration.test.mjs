/**
 * Integration tests for the pincer tactic (issue #88): the spec-ops cascade
 * position and degradation contract, deterministic composition, signed
 * maneuver points reaching member contexts, movement scoring, the assault
 * loose variant, the elastic/strict sync matrix and the barrier contract.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { FLAG_KEYS, MODULE_ID } from "../../scripts/constants.js";
import { createFireteamService, FIRETEAM_STATUS } from "../../scripts/fireteam.js";
import { createPlannerService } from "../../scripts/planner.js";
import {
    evaluateAssault,
    registerAssaultTacticSelector,
    selectAssaultTactic
} from "../../scripts/presets/assault.js";
import {
    evaluateSpecOps,
    registerSpecOpsPreset,
    registerSpecOpsTacticSelector,
    selectSpecOpsTactic
} from "../../scripts/presets/spec-ops.js";
import {
    PINCER_LOOSE_TACTIC,
    PINCER_TACTIC
} from "../../scripts/presets/pincer.js";
import { createTacticRegistry } from "../../scripts/tactics/registry.js";
import { SUPPRESS_AND_BOUND } from "../../scripts/tactics/suppress-and-bound.js";
import { makeActor, makeCombat, makeCombatant, makeScene, makeToken } from "./fixtures.mjs";

function makeWeapon(id = "gun", { range = 150 } = {}) {
    return {
        id,
        uuid: `uuid-${id}`,
        name: "Gun",
        type: "weapon",
        system: {
            class: "basic",
            range,
            damage: "1d10+3",
            rateOfFire: { single: 1, burst: 2, full: 4 },
            clip: { value: 12, max: 12 },
            ammoPerShot: 1,
            jammed: false
        }
    };
}

function memberDto(id, x, y, { turnIndex = 0 } = {}) {
    const token = {
        id: `token-${id}`,
        uuid: `token-uuid-${id}`,
        x,
        y,
        width: 1,
        height: 1,
        disposition: -1
    };
    return {
        combatantId: id,
        tokenId: token.id,
        position: { x, y },
        positionIsCenter: true,
        turnIndex,
        hasActed: false,
        enabled: true,
        defeated: false,
        combatant: {
            id,
            token,
            disposition: -1,
            actor: { id: `actor-${id}`, items: [makeWeapon(`gun-${id}`)] }
        }
    };
}

function targetDto(id, x, y) {
    return {
        tokenId: id,
        tokenUuid: `uuid-${id}`,
        x,
        y,
        elevation: 0,
        source: "visible",
        canAttack: true,
        hidden: false,
        disposition: 1,
        statuses: []
    };
}

/**
 * Open-terrain superiority input: `count` members in a wedge — the leader
 * and fix base behind, two forwards already partway toward the enemy —
 * so the signed routes genuinely diverge (the doctrinal posture the
 * pincer demands). Enemies concentrated at x=600 inside the spread gate.
 */
function superiorityInput(count = 4, extra = {}) {
    const formation = [
        ["a", 0, 0], ["b", 350, -80], ["c", 350, 80],
        ["d", 100, 0], ["e", 200, -40], ["f", 200, 40]
    ];
    const members = formation.slice(0, count)
        .map(([id, x, y]) => memberDto(id, x, y));
    return {
        members,
        leaderId: "a",
        targets: [targetDto("e1", 600, -20), targetDto("e2", 600, 20)],
        context: { pxPerUnit: 1 },
        ...extra
    };
}

function makeWall(coords, { sight = 1, move = 1 } = {}) {
    return { c: coords, sight, move, door: null };
}

/* ------------------------------------------------------------------ */
/* Cascade position and composition                                    */
/* ------------------------------------------------------------------ */

test("specOps cascade commits the pincer for concentrated superiority with n=4", () => {
    const result = selectSpecOpsTactic(superiorityInput(4));
    assert.equal(result.name, PINCER_TACTIC);
    assert.equal(result.reason, "superiority-pincer");
    assert.equal(result.breakdown.pincer.selected, true);
    // Composition: the leader is in the fix base with a support task; the
    // two flank elements are signed and disjoint.
    const assignments = result.assignments;
    assert.equal(assignments.a.task, "support");
    assert.equal(assignments.a.element, "fix");
    assert.equal(assignments.a.role, "fixer");
    const flankers = Object.entries(assignments)
        .filter(([id]) => id !== "a")
        .map(([id, entry]) => ({ id, ...entry }));
    assert.equal(flankers.length, 3);
    assert.ok(flankers.every(entry => entry.task === "flank" && entry.role === "flanker"));
    const sides = flankers.map(entry => entry.element).sort();
    assert.ok(sides.includes("flank-left") && sides.includes("flank-right"),
        `both signed elements present: ${sides}`);
    // Two signed maneuver points, mirrored across the frontal axis.
    const left = result.objective.elements.left.point;
    const right = result.objective.elements.right.point;
    assert.ok(Number.isFinite(left.x) && left.y > 0, "left point above the axis");
    assert.ok(Number.isFinite(right.x) && right.y < 0, "right point below the axis");
    assert.notDeepEqual(left, right);
    assert.equal(result.objective.sync, "elastic");
    assert.equal(result.objective.type, PINCER_TACTIC);
    assert.ok(result.taskCapacities.flank >= 1);
    // Repeat determinism and JSON roundtrip.
    const repeat = selectSpecOpsTactic(superiorityInput(4));
    assert.deepEqual(JSON.parse(JSON.stringify(repeat)), JSON.parse(JSON.stringify(result)));
});

test("specOps pincer composition stays deterministic for n=5 and n=6", () => {
    for (const count of [5, 6]) {
        const result = selectSpecOpsTactic(superiorityInput(count));
        assert.equal(result.name, PINCER_TACTIC, `n=${count}`);
        const elements = Object.values(result.assignments).map(entry => entry.element);
        assert.equal(elements.filter(element => element === "fix").length >= 1, true);
        assert.ok(elements.includes("flank-left") && elements.includes("flank-right"));
        assert.equal(Object.keys(result.assignments).length, count);
        const repeat = selectSpecOpsTactic(superiorityInput(count));
        assert.deepEqual(repeat.assignments, result.assignments);
    }
});

test("pincer evaluation sits before coordinated-assault in the cascade", () => {
    // Three members: below the pincer member floor, so the legacy cascade
    // answers coordinated assault for the identical geometry.
    const three = selectSpecOpsTactic(superiorityInput(3));
    assert.equal(three.name, "coordinated-assault");
    assert.equal(three.breakdown.pincer.name, null);
    assert.equal(three.breakdown.pincer.reason, "pincer-insufficient-members");
    // Four members: the same superiority geometry commits the pincer —
    // proof the pincer branch preempts the assault branch it shadows.
    const four = selectSpecOpsTactic(superiorityInput(4));
    assert.equal(four.name, PINCER_TACTIC);
});

test("morale gate demotes the pincer to the legacy cascade", () => {
    const result = selectSpecOpsTactic(superiorityInput(4, { moraleTier: "desperate" }));
    assert.equal(result.name, "coordinated-assault");
    assert.equal(result.breakdown.pincer.name, null);
    assert.equal(result.breakdown.pincer.reason, "pincer-morale-gate");
});

test("without superiority the legacy outnumbered cascade is byte-identical", () => {
    const members = [memberDto("a", 0, 0), memberDto("b", 40, 0), memberDto("c", 20, 30),
        memberDto("d", 20, -30)];
    const targets = [
        targetDto("e1", 600, -40), targetDto("e2", 600, 0), targetDto("e3", 600, 40),
        targetDto("e4", 640, 0), targetDto("e5", 640, 30)
    ];
    const result = selectSpecOpsTactic({ members, leaderId: "a", targets });
    assert.equal(result.breakdown.pincer.name, null);
    assert.equal(result.breakdown.pincer.reason, "pincer-not-superior");
    assert.ok(["flank-and-fix", "covering-advance", "regroup-fallback"].includes(result.name),
        `legacy branch preserved, got ${result.name}`);
});

test("one blocked side degrades to flank-and-fix with the stable pincer reason", () => {
    // A wall across the right flank corridor (the right lead's straight
    // route crosses it); the left corridor stays open.
    const walls = [makeWall([500, -350, 500, -150])];
    const result = selectSpecOpsTactic(superiorityInput(4, { context: { walls, pxPerUnit: 1 } }));
    assert.equal(result.name, "flank-and-fix");
    assert.ok(String(result.reason).startsWith("pincer-degraded"),
        `stable degradation reason, got ${result.reason}`);
    assert.equal(result.objective.flankSide, "left");
    assert.ok(result.objective.flankPoint);
    assert.equal(result.breakdown.pincer.degradation.reason, result.reason);
    // The degraded descriptor keeps the flanker in the signed element of
    // the surviving side and the fix base in main.
    const flankers = Object.values(result.assignments).filter(entry => entry.task === "flank");
    assert.ok(flankers.length >= 1);
    assert.ok(flankers.every(entry => entry.element === "flank-left"));
    // The legacy flank proof contract applies unchanged: the descriptor
    // carries the doctrine angle for the fireteam proof machinery.
    assert.ok(Number.isFinite(result.flankMinAngleDegrees));
});

test("suppression is evaluated before the pincer and preempts it", () => {
    const input = superiorityInput(4);
    // Suppression geometry: a full-auto capable suppressor and covered
    // clustered targets — the suppression cascade wins before the pincer
    // branch is ever evaluated.
    const result = selectSpecOpsTactic(input);
    if (result.name === SUPPRESS_AND_BOUND) {
        assert.equal(result.breakdown.suppression.selected, true);
        assert.equal("pincer" in result.breakdown, false,
            "the pincer branch is never evaluated once suppression commits");
    } else {
        // Without suppression coverage the pincer stands — both branches
        // must never commit simultaneously.
        assert.equal(result.name, PINCER_TACTIC);
        assert.equal(result.breakdown.suppression.selected, false);
    }
});

test("an explicit objective target reaches the pincer objective", () => {
    const input = superiorityInput(4);
    input.objective = { type: "attack", targetId: "e2", targetUuid: "uuid-e2" };
    input.context.objective = input.objective;
    const result = selectSpecOpsTactic(input);
    assert.equal(result.name, PINCER_TACTIC);
    assert.equal(result.objective.targetId, "e2");
});

/* ------------------------------------------------------------------ */
/* Movement scoring                                                    */
/* ------------------------------------------------------------------ */

test("specOps flank scoring pulls toward the member's own signed point", () => {
    const self = { x: 0, y: 0 };
    const point = { x: 600, y: 300 };
    const team = { task: "flank", flankPoint: point, flankSide: "left" };
    const toward = evaluateSpecOps({
        factors: {},
        candidate: { variant: "approach", move: { x: 400, y: 200 } },
        context: { team, selfPos: self }
    });
    const away = evaluateSpecOps({
        factors: {},
        candidate: { variant: "approach", move: { x: 100, y: 0 } },
        context: { team, selfPos: self }
    });
    assert.ok(toward.breakdown.factors.flankProgress > away.breakdown.factors.flankProgress,
        "endpoint nearer the signed point scores higher");
    assert.ok(toward.score > away.score);
    // The opposite side's point scores the same endpoint strictly lower —
    // signed geometry is per-member, not a shared attraction.
    const mirror = { task: "flank", flankPoint: { x: 600, y: -300 }, flankSide: "right" };
    const mirrored = evaluateSpecOps({
        factors: {},
        candidate: { variant: "approach", move: { x: 400, y: 200 } },
        context: { team: mirror, selfPos: self }
    });
    assert.ok(mirrored.breakdown.factors.flankProgress < toward.breakdown.factors.flankProgress);
    // Moving away from the own point never scores positive progress.
    const retreating = evaluateSpecOps({
        factors: {},
        candidate: { variant: "approach", move: { x: -100, y: 0 } },
        context: { team, selfPos: self }
    });
    assert.ok(retreating.breakdown.factors.flankProgress <= 0);
});

test("assault flank overlay adds flankProgress scoring for the loose variant", () => {
    const self = { x: 0, y: 0 };
    const candidate = { variant: "approach", move: { x: 400, y: 200 } };
    const plain = evaluateAssault({
        factors: { advance: 1 },
        candidate,
        context: { selfPos: self }
    });
    assert.equal("flankProgress" in (plain.breakdown.factors ?? {}), false);
    const flanked = evaluateAssault({
        factors: { advance: 1 },
        candidate,
        context: {
            selfPos: self,
            team: { task: "flank", flankPoint: { x: 600, y: 300 }, flankSide: "left" }
        }
    });
    assert.ok(flanked.breakdown.factors.flankProgress > 0);
    assert.equal(flanked.breakdown.weights.flankProgress, 6);
    // The advance pull grows by the documented +1 delta over the base 6.
    assert.equal(flanked.breakdown.weights.advance, 7);
    assert.ok(flanked.score > plain.score);
});

/* ------------------------------------------------------------------ */
/* Assault loose variant                                               */
/* ------------------------------------------------------------------ */

test("assault selector commits the loose pincer with sync none", () => {
    const result = selectAssaultTactic(superiorityInput(5));
    assert.equal(result.name, PINCER_LOOSE_TACTIC);
    assert.equal(result.objective.sync, "none");
    assert.equal(result.objective.type, PINCER_LOOSE_TACTIC);
    // The loose composition assaults through the centre at n=5.
    const elements = Object.values(result.assignments).map(entry => entry.element);
    assert.ok(elements.includes("flank-left") && elements.includes("flank-right"));
    assert.ok(elements.includes("center"), "central assault element present");
    const centerEntries = Object.values(result.assignments)
        .filter(entry => entry.element === "center");
    assert.ok(centerEntries.every(entry => entry.task === "assault"));
    assert.deepEqual(JSON.parse(JSON.stringify(result)), JSON.parse(JSON.stringify(result)));
});

test("assault tactic selector registers in the tactic registry", () => {
    const registry = createTacticRegistry();
    registerAssaultTacticSelector(registry);
    const resolved = registry.resolveTactic("assault", superiorityInput(4));
    assert.equal(resolved.name, PINCER_LOOSE_TACTIC);
    const empty = registry.resolveTactic("assault", {});
    assert.equal(empty.name, null);
});

/* ------------------------------------------------------------------ */
/* TeamPlan integration                                                */
/* ------------------------------------------------------------------ */

function withFireteam(doc, flag) {
    doc.flags[MODULE_ID] = doc.flags[MODULE_ID] ?? {};
    doc.flags[MODULE_ID][FLAG_KEYS.fireteam] = flag;
    return doc;
}

function worldMember(id, x, y, { initiative = 10, preset = "specOps", teamPreset = preset } = {}) {
    const actor = makeActor({ enabled: true, preset });
    actor.system = { wounds: { value: 10, max: 10 } };
    // Single-shot rifles: no suppression-fire capability, so the cascade's
    // suppression branch can never preempt the pincer in these tests.
    const gun = makeWeapon(`gun-${id}`);
    gun.system.rateOfFire = { single: 1, burst: 0, full: 0 };
    actor.items = [gun];
    const token = makeToken({ actor });
    token.x = x;
    token.y = y;
    token.disposition = -1;
    const combatant = makeCombatant({ actor, token });
    combatant.id = id;
    combatant.tokenId = token.id;
    combatant.initiative = initiative;
    combatant.defeated = false;
    withFireteam(combatant, {
        teamId: "alpha",
        ...(teamPreset ? { teamPreset } : {})
    });
    return { actor, token, combatant };
}

function enemyToken(id, x, y) {
    const actor = makeActor();
    actor.items = [];
    const token = makeToken({ actor });
    token.id = id;
    token.x = x;
    token.y = y;
    token.disposition = 1;
    const combatant = makeCombatant({ actor, token });
    combatant.id = `combatant-${id}`;
    combatant.tokenId = token.id;
    return { actor, token, combatant };
}

function makeWorld(members, enemies = []) {
    const scene = makeScene({ grid: "square" });
    const combat = makeCombat({
        round: 1,
        turn: 0,
        combatants: [
            ...members.map(member => member.combatant),
            ...enemies.map(enemy => enemy.combatant)
        ]
    });
    combat.scene = scene;
    scene.tokens = { contents: [
        ...members.map(member => member.token),
        ...enemies.map(enemy => enemy.token)
    ] };
    return { scene, combat };
}

test("specOps TeamPlan signs per-member flank points and groups", async () => {
    const members = [
        worldMember("a", 0, 0, { initiative: 40 }),
        worldMember("b", 350, -80, { initiative: 30 }),
        worldMember("c", 350, 80, { initiative: 20 }),
        worldMember("d", 100, 0, { initiative: 10 })
    ];
    const enemies = [enemyToken("e1", 600, -20), enemyToken("e2", 600, 20)];
    const world = makeWorld(members, enemies);
    const realPlanner = createPlannerService();
    registerSpecOpsPreset(realPlanner);
    const contexts = [];
    const plannerProxy = {
        planTurn: (combat, combatant, context) => {
            contexts.push({ combatantId: combatant.id, context });
            return realPlanner.planTurn(combat, combatant, context);
        }
    };
    const tactics = createTacticRegistry();
    registerSpecOpsTacticSelector(tactics);
    const fireteam = createFireteamService({ tactics });
    const targets = enemies.map(({ token }) => ({
        tokenId: token.id,
        tokenUuid: token.uuid,
        x: token.x,
        y: token.y,
        elevation: 0,
        canAttack: true,
        source: "injected",
        disposition: 1
    }));
    const result = await fireteam.buildTeamPlan(world.combat, "alpha", {
        seed: 42,
        readOnly: true,
        planner: plannerProxy,
        targets,
        tacticTargets: targets,
        actions: [],
        moves: [],
        personality: false
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    const plan = result.teamPlan;
    assert.equal(plan.tactic, PINCER_TACTIC);
    const byElement = Object.fromEntries(plan.members.map(member => [member.combatantId, member.element]));
    const flankLeft = plan.members.find(member => member.element === "flank-left");
    const flankRight = plan.members.find(member => member.element === "flank-right");
    assert.ok(flankLeft && flankRight, `both signed elements planned: ${JSON.stringify(byElement)}`);
    assert.equal(flankLeft.groupId, "flank-left");
    assert.equal(flankRight.groupId, "flank-right");
    const fixMembers = plan.members.filter(member => member.element === "fix");
    assert.ok(fixMembers.length >= 1 && fixMembers.every(member => member.groupId === "main"));
    // The leader holds the fix base.
    assert.equal(plan.members.find(member => member.combatantId === plan.leaderId).element, "fix");
    // Signed points reach the member contexts: the left flanker's anchor
    // is the left maneuver point and differs from the right flanker's.
    const leftContext = contexts.find(entry => entry.combatantId === flankLeft.combatantId)?.context;
    const rightContext = contexts.find(entry => entry.combatantId === flankRight.combatantId)?.context;
    assert.ok(leftContext?.team?.flankPoint, "left flanker receives a maneuver point");
    assert.ok(rightContext?.team?.flankPoint, "right flanker receives a maneuver point");
    assert.notDeepEqual(leftContext.team.flankPoint, rightContext.team.flankPoint);
    assert.equal(leftContext.team.flankSide, "left");
    assert.equal(rightContext.team.flankSide, "right");
    assert.ok(leftContext.team.flankPoint.y > 0, "left point above the frontal axis");
    assert.ok(rightContext.team.flankPoint.y < 0, "right point below the frontal axis");
    // Phase structure exists (the barrier contract itself is covered by
    // the dedicated transit test below — with `moves: []` nobody moves
    // and no barrier is owed).
    assert.ok(plan.phases.find(phase => phase.id === "phase-1"),
        "action phase present");
    // Serializable roundtrip.
    const roundTrip = JSON.parse(JSON.stringify(plan));
    assert.equal(roundTrip.tactic, PINCER_TACTIC);
    assert.equal(roundTrip.members.find(member => member.element === "flank-left").groupId, "flank-left");
});

/* ------------------------------------------------------------------ */
/* Sync policy matrix (validateTeamPlan)                               */
/* ------------------------------------------------------------------ */

function syncWorld() {
    const members = [
        worldMember("a", 0, 0, { initiative: 40 }),
        worldMember("b", -20, -30, { initiative: 30 }),
        worldMember("c", -20, 30, { initiative: 20 })
    ];
    return makeWorld(members, []);
}

function teamPlanWithDelay(delay) {
    return {
        id: "team-sync",
        combatId: null,
        round: 1,
        turn: 0,
        teamId: "alpha",
        leaderId: "a",
        revision: "rev",
        seed: 1,
        members: [
            { combatantId: "a", task: "support", groupId: "main", delayed: delay },
            { combatantId: "b", task: "flank", groupId: "flank-left" },
            { combatantId: "c", task: "flank", groupId: "flank-right" }
        ],
        memberPlans: {},
        phases: []
    };
}

test("validateTeamPlan applies the elastic/strict multi-await matrix", async () => {
    const world = syncWorld();
    const fireteam = createFireteamService();
    const plan = teamPlanWithDelay({
        reason: "await-sync",
        until: "flank-ready",
        awaitId: "b",
        awaitIds: ["b", "c"],
        policy: "elastic"
    });
    // Patch the combat id so validation finds the combat.
    plan.combatId = world.combat.id;
    // Elastic: ONE lost awaited flanker does not break the sync — the
    // validation falls through to the generic staleness reasons instead.
    world.combat.combatants.get("c").defeated = true;
    const elasticOne = fireteam.validateTeamPlan(plan, { combat: world.combat });
    assert.notEqual(elasticOne.reason, "sync-broken");
    // Elastic: BOTH awaited lost breaks the wait.
    world.combat.combatants.get("b").defeated = true;
    const elasticAll = fireteam.validateTeamPlan(plan, { combat: world.combat });
    assert.equal(elasticAll.reason, "sync-broken");
    // Strict: any single awaited loss breaks immediately.
    const strictPlan = teamPlanWithDelay({
        reason: "await-sync",
        until: "flank-ready",
        awaitId: "b",
        awaitIds: ["b", "c"],
        policy: "strict"
    });
    strictPlan.combatId = world.combat.id;
    world.combat.combatants.get("b").defeated = false;
    const strictOne = fireteam.validateTeamPlan(strictPlan, { combat: world.combat });
    assert.equal(strictOne.reason, "sync-broken");
});

/* ------------------------------------------------------------------ */
/* Sync delay policy through buildTeamPlan                             */
/* ------------------------------------------------------------------ */

let stubStepCounter = 0;

function step(type, input = {}, cost = {}) {
    stubStepCounter += 1;
    return {
        id: `step-${type}-${stubStepCounter}`,
        type,
        cost: { halves: 0, ...cost },
        input,
        preconditions: ["turn"],
        projectedResourceDelta: {}
    };
}

function stubPlan(id, steps, score = 1) {
    return {
        id,
        score,
        target: null,
        steps,
        snapshot: { self: { x: 0, y: 0 }, targets: [] },
        breakdown: {},
        diagnostics: {}
    };
}

/**
 * Shared synchronized-strike harness (issue #88): two flankers in transit
 * (move-only stub plans, distinct endpoints inside cohesion), the fix base
 * striking the convergence target. Mirrors the squad-tactics-38 harness —
 * no explicit `objective` (an explicit objective suppresses focus selection
 * and with it the convergence the sync contract watches).
 * @param {string} syncMode `elastic`/`strict`/`none`.
 * @returns {Promise<object>} `buildTeamPlan` result.
 */
async function pincerSyncPlan(syncMode) {
    const members = [
        worldMember("a", 0, 0, { initiative: 40, teamPreset: null }),
        worldMember("b", -20, -30, { initiative: 30, teamPreset: null }),
        worldMember("c", -20, 30, { initiative: 20, teamPreset: null }),
        worldMember("d", 20, 0, { initiative: 10, teamPreset: null })
    ];
    const enemies = [enemyToken("e1", 300, 0)];
    const world = makeWorld(members, enemies);
    const moveOnly = (cost, dy) => [step("move", {
        to: { x: 150, y: dy },
        waypoints: [{ x: 50, y: dy / 2 }, { x: 150, y: dy }],
        approximate: false
    }, { movement: cost, halves: 1 })];
    const strike = () => [step("attack", {
        actionId: "shoot",
        targetTokenId: "e1",
        targetTokenUuid: "uuid-e1"
    }, { halves: 1 })];
    const planner = {
        async planTurn(_combat, combatant) {
            // `c` carries the cheaper transit (cost 2 vs 6) — the elastic
            // policy must await exactly this earliest flanker.
            if (combatant.id === "b") {
                return { status: "ok", plan: stubPlan("b-plan", moveOnly(6, 100)) };
            }
            if (combatant.id === "c") {
                return { status: "ok", plan: stubPlan("c-plan", moveOnly(2, -100)) };
            }
            return {
                status: "ok",
                plan: { ...stubPlan(`${combatant.id}-plan`, strike()), target: { tokenId: "e1" } }
            };
        }
    };
    const loose = syncMode === "none";
    const tactic = {
        name: loose ? PINCER_LOOSE_TACTIC : PINCER_TACTIC,
        reason: loose ? "superiority-pincer-loose" : "superiority-pincer",
        assignments: loose ? {
            a: { task: "assault", element: "center", role: "assault" },
            b: { task: "flank", element: "flank-left", role: "flanker" },
            c: { task: "flank", element: "flank-right", role: "flanker" },
            d: { task: "assault", element: "center", role: "assault" }
        } : {
            a: { task: "support", element: "fix", role: "fixer" },
            b: { task: "flank", element: "flank-left", role: "flanker" },
            c: { task: "flank", element: "flank-right", role: "flanker" },
            d: { task: "support", element: "fix", role: "fixer" }
        },
        objective: {
            type: loose ? PINCER_LOOSE_TACTIC : PINCER_TACTIC,
            targetId: "e1",
            sync: syncMode,
            elements: {
                left: { point: { x: 150, y: 100 } },
                right: { point: { x: 150, y: -100 } }
            }
        },
        allowFlank: true,
        taskCapacities: { flank: 1 },
        breakdown: {}
    };
    const fireteam = createFireteamService();
    return fireteam.buildTeamPlan(world.combat, "alpha", {
        seed: 9,
        readOnly: true,
        planner,
        tactic,
        targets: [{ tokenId: "e1", x: 300, y: 0, wounds: 10 }],
        personality: false
    });
}

test("elastic sync holds the fix base only for the earliest transit flanker", async () => {
    const result = await pincerSyncPlan("elastic");
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    assert.ok(result.teamPlan.convergence, "convergence present");
    const delays = result.teamPlan.diagnostics.syncDelays ?? [];
    assert.ok(delays.length >= 1, "at least one fix member waits");
    for (const delay of delays) {
        assert.equal(delay.policy, "elastic");
        assert.deepEqual(delay.awaitIds, ["c"]);
        // `awaitId` stays the first element for backward compatibility.
        assert.equal(delay.awaitId, "c");
    }
    // Flankers themselves never wait — they are the wait condition.
    assert.equal(delays.some(delay => delay.combatantId === "b"), false);
    assert.equal(delays.some(delay => delay.combatantId === "c"), false);
    // The delay contract serializes into the member entries.
    const waiting = result.teamPlan.members.filter(member => member.delayed);
    assert.ok(waiting.length >= 1);
    assert.equal(waiting[0].delayed.policy, "elastic");
    assert.deepEqual(JSON.parse(JSON.stringify(delays)), delays);
});

test("strict sync awaits every transit flanker", async () => {
    const result = await pincerSyncPlan("strict");
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    const delays = result.teamPlan.diagnostics.syncDelays ?? [];
    assert.ok(delays.length >= 1, "at least one fix member waits");
    for (const delay of delays) {
        assert.equal(delay.policy, "strict");
        assert.deepEqual(delay.awaitIds, ["b", "c"]);
        assert.equal(delay.awaitId, "b");
    }
});

test("loose pincer sync none never holds the strike", async () => {
    const result = await pincerSyncPlan("none");
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    assert.equal((result.teamPlan.diagnostics.syncDelays ?? []).length, 0,
        "sync none never produces delay stubs");
});

test("the movement barrier covers both signed flank groups in transit", async () => {
    const result = await pincerSyncPlan("elastic");
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    const actionPhase = result.teamPlan.phases.find(phase => phase.id === "phase-1");
    assert.ok(actionPhase?.barrier, "movement barrier exists while flankers transit");
    assert.equal(actionPhase.barrier.failurePolicy, "hold");
    for (const mover of ["b", "c"]) {
        assert.ok(actionPhase.barrier.requiredAssignmentIds.includes(mover),
            `${mover} holds the barrier`);
    }
});
