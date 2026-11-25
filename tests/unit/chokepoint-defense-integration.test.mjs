/**
 * End-to-end integration tests of chokepoint-defense (issue #91): registry
 * participation, fireteam object assignments, lane overwatch/scoring,
 * counterattack gates, degradation precedence and deterministic plans.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    FLAG_KEYS,
    MODULE_ID
} from "../../scripts/constants.js";
import {
    createFireteamService,
    FIRETEAM_STATUS
} from "../../scripts/fireteam.js";
import {
    createPlannerService
} from "../../scripts/planner.js";
import {
    holdVeto,
    HOLD_VETO_OUTSIDE_RADIUS,
    registerHoldPreset
} from "../../scripts/presets/hold.js";
import {
    CHOKEPOINT_TACTIC_NAME,
    evaluateChokepointCascade,
    registerHoldTacticSelector
} from "../../scripts/presets/chokepoint-defense.js";
import {
    createTacticRegistry
} from "../../scripts/tactics/registry.js";
import {
    makeActor,
    makeCombat,
    makeCombatant,
    makeScene,
    makeToken
} from "./fixtures.mjs";

const GRID = { size: 100, distance: 1 };
const SCENE = { id: "scene-1", grid: GRID };

function weapon(id = "gun") {
    return {
        id,
        uuid: `uuid-${id}`,
        type: "weapon",
        name: "Test gun",
        system: {
            class: "basic",
            range: 30,
            damage: "1d10+3",
            rateOfFire: { single: 1, burst: 2 }
        }
    };
}

function rifleActions() {
    return [{
        id: "shoot",
        type: "attack",
        attackType: "standard",
        itemId: "gun",
        itemUuid: "uuid-gun",
        name: "Test gun",
        range: 30,
        damage: 8,
        cost: "half",
        rateOfFire: { single: 1, burst: 2 }
    }];
}

function suppressionActions() {
    return [
        ...rifleActions(),
        {
            ...rifleActions()[0],
            id: "suppress",
            attackType: "suppressing_fire",
            cost: "full"
        }
    ];
}

function member(id, x, y, { initiative = 10, preset = "hold", character = "disciplined" } = {}) {
    const actor = makeActor({ enabled: true, preset });
    actor.system = { wounds: { value: 10, max: 10 }, movement: { half: 4, full: 8 } };
    actor.items = [weapon(`gun-${id}`)];
    actor.items[0].id = "gun";
    actor.items[0].uuid = "uuid-gun";
    const token = makeToken({ actor });
    token.x = x;
    token.y = y;
    token.disposition = -1;
    const combatant = makeCombatant({ actor, token });
    combatant.id = id;
    combatant.tokenId = token.id;
    combatant.initiative = initiative;
    combatant.flags[MODULE_ID] = combatant.flags[MODULE_ID] ?? {};
    combatant.flags[MODULE_ID][FLAG_KEYS.fireteam] = {
        teamId: "alpha", teamPreset: preset, character
    };
    return { actor, token, combatant };
}

function makeWorld(members) {
    const scene = makeScene({ grid: "square" });
    scene.id = "scene-1";
    scene.grid.distance = 1;
    const combat = makeCombat({
        round: 1,
        turn: 0,
        combatants: members.map(entry => entry.combatant)
    });
    combat.scene = scene;
    scene.tokens = { contents: members.map(entry => entry.token) };
    return { scene, combat };
}

function threat(id, x, y, overrides = {}) {
    return {
        tokenId: id,
        tokenUuid: `Scene.scene-1.Token.${id}`,
        x,
        y,
        elevation: 0,
        canAttack: true,
        source: "visible",
        disposition: 1,
        halfMove: 4,
        statuses: [],
        ...overrides
    };
}

function memoryThreat(id, x, y, overrides = {}) {
    return threat(id, x, y, {
        canAttack: false,
        source: "team-contact",
        ...overrides
    });
}

function defenseContext(targets, actions = rifleActions(), overrides = {}) {
    return {
        seed: 42,
        readOnly: true,
        targets,
        tacticTargets: targets,
        actions,
        moves: [],
        personality: false,
        hold: { anchor: { x: 0, y: 0, sceneId: "scene-1" }, radiusMeters: 6 },
        ...overrides
    };
}

async function buildPlan({ members, world = null, targets, actions = rifleActions(),
    context = {}, plannerHook = null } = {}) {
    const actualWorld = world ?? makeWorld(members);
    const planner = createPlannerService();
    registerHoldPreset(planner);
    const contexts = [];
    const plannerProxy = {
        planTurn: (combat, combatant, memberContext) => {
            contexts.push({ combatantId: combatant.id, context: memberContext });
            const result = planner.planTurn(combat, combatant, memberContext);
            return plannerHook ? plannerHook(result) : result;
        }
    };
    const tactics = createTacticRegistry();
    registerHoldTacticSelector(tactics);
    const fireteam = createFireteamService({ tactics });
    const planContext = defenseContext(targets, actions, context);
    planContext.planner = plannerProxy;
    const result = await fireteam.buildTeamPlan(
        actualWorld.combat, "alpha", planContext);
    return { result, contexts, world: actualWorld };
}

function selectorInput(overrides = {}) {
    const members = overrides.members ?? [
        { combatantId: "m1", tokenId: "t-m1", ids: ["m1"], position: { x: 0, y: 0 }, enabled: true, defeated: false },
        { combatantId: "m2", tokenId: "t-m2", ids: ["m2"], position: { x: 100, y: 0 }, enabled: true, defeated: false }
    ];
    return {
        members,
        leaderId: "m1",
        targets: [threat("e1", 1500, 0)],
        memberProfiles: {
            m1: { bestRangeM: 30, suppressionCapable: false, suppressionRangeM: 0, meleeOnly: false, reactionUsed: false },
            m2: { bestRangeM: 30, suppressionCapable: false, suppressionRangeM: 0, meleeOnly: false, reactionUsed: false }
        },
        scene: SCENE,
        context: {
            hold: { anchor: { x: 0, y: 0 }, radiusMeters: 6 },
            scene: SCENE,
            round: 1
        },
        character: "disciplined",
        ...overrides
    };
}

function memoryLaneSetup() {
    const members = [member("m1", 0, 0, { initiative: 20 }), member("m2", 0, 100, { initiative: 10 })];
    const targets = [
        memoryThreat("e1", 1500, 0),
        memoryThreat("e2", 1550, 30)
    ];
    return { members, targets };
}

test("registry and preset participation gates are conservative and explainable", () => {
    const input = selectorInput();
    const hold = evaluateChokepointCascade(input, { presetId: "hold" });
    assert.equal(hold.active, true, hold.reason);

    const noHoldInput = selectorInput({
        context: { scene: SCENE, round: 1 }
    });
    assert.equal(evaluateChokepointCascade(noHoldInput, { presetId: "hold" }).active, true);
    for (const presetId of ["rangedCover", "specOps"]) {
        const gated = evaluateChokepointCascade(noHoldInput, { presetId });
        assert.equal(gated.active, false);
        assert.equal(gated.reason, "preset-anchor-gate");
        assert.equal(gated.breakdown.anchorSource, "centroid");
    }
    const explicitDefense = selectorInput({
        objective: { type: "defend", anchor: { x: 0, y: 0 }, radiusMeters: 6 },
        context: {
            scene: SCENE,
            round: 1,
            objective: { type: "defend", anchor: { x: 0, y: 0 }, radiusMeters: 6 }
        }
    });
    assert.equal(evaluateChokepointCascade(explicitDefense, { presetId: "specOps" }).active, true);
    assert.equal(evaluateChokepointCascade(explicitDefense, { presetId: "rangedCover" }).active, true);

    const tactics = createTacticRegistry();
    registerHoldTacticSelector(tactics);
    const selected = tactics.resolveTactic("hold", input);
    assert.equal(selected.name, CHOKEPOINT_TACTIC_NAME);
    assert.equal(selected.allowFlank, false);
    assert.equal(selected.regroup, false);
});

test("memory lane assignment reaches member contexts and declares lane overwatch", async () => {
    const { members, targets } = memoryLaneSetup();
    const { result, contexts } = await buildPlan({ members, targets });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    const plan = result.teamPlan;
    assert.equal(plan.tactic, CHOKEPOINT_TACTIC_NAME);
    const lane = plan.diagnostics.tactic.breakdown.lanes[0];
    assert.equal(lane.sourceBreakdown.memory, 2);
    assert.ok(lane.threatIds.includes("Scene.scene-1.Token.e1"));

    const laneMember = plan.members.find(entry => entry.role === "overwatch-lane");
    assert.ok(laneMember, "one member watches the inferred lane");
    assert.equal(laneMember.task, "support");
    assert.equal(laneMember.element, lane.id);
    assert.equal(laneMember.objective.type, "defend");
    assert.equal(laneMember.objective.laneId, lane.id);
    const reserve = plan.members.find(entry => entry.role === "reserve");
    assert.ok(reserve, "watcher cap leaves a reserve");
    assert.equal(reserve.task, "support");

    const laneContext = contexts.find(entry => entry.combatantId === laneMember.combatantId)?.context;
    assert.equal(laneContext.objective.type, "defend");
    assert.equal(laneContext.team.defenseObjective.type, "defend");
    assert.equal(laneContext.team.defense.lane.id, lane.id);
    assert.equal(laneContext.team.memberObjective.laneId, lane.id);
    assert.equal(laneContext.team.assignment.role, "overwatch-lane");

    const memberPlan = plan.memberPlans[laneMember.combatantId];
    const overwatch = memberPlan.steps.find(step => step.type === "overwatch");
    assert.ok(overwatch, "memory lane steers a declare-only overwatch plan");
    assert.equal(overwatch.input.lane.id, lane.id);
    assert.deepEqual(overwatch.input.lane.chokepoint, lane.chokepoint);
    assert.equal(overwatch.input.direction, lane.bearingDeg);
    assert.equal(memberPlan.diagnostics.laneOverwatch.anchors[0].kind, "lane");
    assert.equal(memberPlan.diagnostics.laneOverwatch.laneAnchorKept, true);
    assert.ok(memberPlan.breakdown.factors.laneCoverage > 0);
    assert.equal(memberPlan.breakdown.weights.laneCoverage, 5);
    assert.ok(memberPlan.breakdown.weights.overwatch >= 3);
    assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan, "TeamPlan is JSON-round-trip stable");
});

test("lane suppression is preferred on real lane-threat anchors but never fired at an empty synthetic lane", async () => {
    const { members, targets } = memoryLaneSetup();
    const { result } = await buildPlan({ members, targets, actions: suppressionActions() });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    const laneMember = result.teamPlan.members.find(entry => entry.role === "overwatch-lane");
    const lanePlan = result.teamPlan.memberPlans[laneMember.combatantId];
    const suppression = lanePlan.steps.find(step => step.input?.suppressionFire === true);
    assert.ok(suppression, "the lane watcher prefers legal suppression over bare overwatch");
    assert.equal(suppression.input.attackType, "suppressing_fire");

    // Negative control: the lane names a threat id absent from the perceived
    // target pool. The synthetic chokepoint may steer overwatch, but it is
    // never a suppression target.
    const world = makeWorld([member("solo", 0, 0)]);
    const planner = createPlannerService();
    registerHoldPreset(planner);
    const lane = {
        id: "lane-empty",
        bearingDeg: 0,
        chokepoint: { x: 800, y: 0 },
        post: { x: 450, y: 0 },
        threatIds: ["missing-threat"]
    };
    const solo = await planner.planTurn(world.combat, world.combat.combatants.contents[0], {
        seed: 7,
        actions: suppressionActions(),
        targets: [memoryThreat("e9", 1500, 300)],
        moves: [],
        tactic: CHOKEPOINT_TACTIC_NAME,
        team: {
            role: "overwatch-lane",
            memberObjective: {
                type: "defend", laneId: lane.id, lanePoint: lane.chokepoint, post: lane.post
            },
            defenseObjective: { type: "defend", lanes: [lane] }
        },
        hold: { anchor: { x: 0, y: 0, sceneId: "scene-1" }, radiusMeters: 6 },
        scene: world.scene,
        personality: false
    });
    assert.equal(solo.status, "ok");
    assert.equal(solo.plan.steps.some(step => step.input?.suppressionFire === true), false);
    assert.ok((solo.plan.diagnostics?.rejected ?? []).some(entry =>
        entry.reason === "lane-threat-anchor-missing"));
});

test("counterattack flips only the reserve onto a vulnerable live intruder", async () => {
    const members = [
        member("m1", 0, 0, { initiative: 20 }),
        member("m2", 0, 100, { initiative: 10 }),
        member("m3", 100, 0, { initiative: 5 })
    ];
    const inside = [threat("e1", 500, 0, { statuses: ["pinned"] })];
    const { result, contexts } = await buildPlan({ members, targets: inside });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    const counter = result.teamPlan.diagnostics.tactic.breakdown.counterattack;
    assert.equal(counter.active, true);
    assert.equal(counter.targetId, "e1");
    const reserve = result.teamPlan.members.find(entry => entry.role === "reserve");
    assert.equal(reserve.task, "assault");
    assert.equal(reserve.objective.targetId, "e1");
    assert.equal(reserve.assignedTargetId, "e1");
    const reserveContext = contexts.find(entry => entry.combatantId === reserve.combatantId)?.context;
    assert.equal(reserveContext.team.task, "assault");
    assert.equal(reserveContext.team.memberObjective.targetId, "e1");
    const attack = result.teamPlan.memberPlans[reserve.combatantId].steps
        .find(step => step.type === "attack");
    assert.equal(attack.input.targetTokenId, "e1");
    assert.equal(result.teamPlan.members.filter(entry => entry.role === "overwatch-lane")
        .every(entry => entry.task === "support"), true);
});

test("counterattack gates reject outside and memory-only intruders", async () => {
    const members = [
        member("m1", 0, 0, { initiative: 20 }),
        member("m2", 0, 100, { initiative: 10 })
    ];
    for (const [label, target] of [
        ["outside", threat("e1", 1500, 0, { statuses: ["pinned"] })],
        ["memory", memoryThreat("e1", 500, 0, { statuses: ["pinned"] })]
    ]) {
        const { result } = await buildPlan({ members, targets: [target] });
        assert.equal(result.status, FIRETEAM_STATUS.ok, label);
        assert.equal(result.teamPlan.diagnostics.tactic.breakdown.counterattack.active, false, label);
        const reserve = result.teamPlan.members.find(entry => entry.role === "reserve");
        assert.equal(reserve.task, "support", label);
        assert.equal(reserve.objective.targetId ?? null, null, label);
    }
});

test("focus remains compatible while explicit regroup and explicit tactic precedence disable the defense", async () => {
    const { members } = memoryLaneSetup();
    const visible = [threat("e1", 1500, 0), threat("e2", 1550, 30)];
    const focused = await buildPlan({ members, targets: visible });
    assert.equal(focused.result.teamPlan.tactic, CHOKEPOINT_TACTIC_NAME);
    assert.ok(focused.result.teamPlan.diagnostics.focus, "focus pre-pass remains visible in diagnostics");

    const regrouped = await buildPlan({
        members,
        targets: visible,
        context: { regroup: true }
    });
    assert.equal(regrouped.result.teamPlan.tactic ?? null, null);
    assert.equal(regrouped.result.teamPlan.diagnostics.tactic.breakdown.chokepoint.reason, "regroup-active");
    assert.equal(regrouped.result.teamPlan.members.every(entry => entry.task === "regroup"), true);
    assert.equal(regrouped.result.teamPlan.members.some(entry => entry.role === "overwatch-lane"), false);

    const explicitPeel = await buildPlan({
        members,
        targets: visible,
        context: {
            tactic: {
                name: "peel-withdrawal",
                reason: "explicit-test",
                assignments: { m1: "support", m2: "support" }
            }
        }
    });
    assert.equal(explicitPeel.result.teamPlan.tactic, "peel-withdrawal");
});

test("holdVeto conflict matrix stays hard outside the radius and never throws", () => {
    const context = {
        tactic: CHOKEPOINT_TACTIC_NAME,
        hold: { anchor: { x: 0, y: 0 }, radiusMeters: 6 },
        scene: SCENE,
        selfPos: { x: 0, y: 0 },
        team: {
            role: "reserve",
            memberObjective: { type: "defend", targetId: "e1" }
        }
    };
    assert.equal(holdVeto({
        candidate: {
            variant: "move-attack",
            target: threat("e1", 500, 0),
            move: { x: 300, y: 0, stay: false }
        },
        context
    }), null, "counterattack movement inside the hold radius is legal");
    assert.equal(holdVeto({
        candidate: {
            variant: "move-attack",
            target: threat("e1", 500, 0),
            move: { x: 700, y: 0, stay: false }
        },
        context
    }), HOLD_VETO_OUTSIDE_RADIUS, "the defense never leaves the hold radius");
    assert.doesNotThrow(() => holdVeto({ candidate: null, context: null }));
    assert.doesNotThrow(() => holdVeto());
});

test("degradation reasons surface through the hold cascade", async () => {
    const { members } = memoryLaneSetup();
    const noThreat = await buildPlan({ members, targets: [] });
    assert.equal(noThreat.result.status, FIRETEAM_STATUS.ok);
    assert.equal(noThreat.result.teamPlan.tactic ?? null, null);
    assert.equal(noThreat.result.teamPlan.diagnostics.tactic.breakdown.chokepoint.reason,
        "no-perceived-threat");

    const bypassInput = selectorInput({
        character: "shock",
        targets: [threat("e1", 300, 0), threat("e2", 350, 20)]
    });
    assert.equal(evaluateChokepointCascade(bypassInput, { presetId: "hold" }).reason,
        "defense-bypassed");

    const spreadTargets = [0, 55, 110, 165, 220, 275, 330].map((bearing, index) => {
        const radians = bearing * Math.PI / 180;
        return threat(`e${index}`, Math.round(Math.cos(radians) * 2000),
            Math.round(Math.sin(radians) * 2000));
    });
    const outflanked = evaluateChokepointCascade(selectorInput({ targets: spreadTargets }), { presetId: "hold" });
    assert.equal(outflanked.reason, "defense-outflanked");
});

test("committed lane metadata and repeated TeamPlans remain deterministic", async () => {
    const { members, targets } = memoryLaneSetup();
    const world = makeWorld(members);
    const first = await buildPlan({ members, world, targets });
    const second = await buildPlan({ members, world, targets });
    assert.equal(first.result.status, FIRETEAM_STATUS.ok);
    assert.equal(second.result.status, FIRETEAM_STATUS.ok);
    assert.equal(JSON.stringify(first.result.teamPlan), JSON.stringify(second.result.teamPlan));

    const lane = first.result.teamPlan.diagnostics.tactic.breakdown.lanes[0];
    assert.ok(/^lane-/.test(lane.id));
    const overwatch = first.result.teamPlan.memberPlans[
        first.result.teamPlan.members.find(entry => entry.role === "overwatch-lane").combatantId
    ].steps.find(step => step.type === "overwatch");
    assert.equal(overwatch.input.lane.id, lane.id,
        "serialized overwatch input carries the lane id used by sticky commitments");
});
