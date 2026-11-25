/**
 * Integration tests for suppress-and-bound (issue #86): preset cascades,
 * registry wiring, suppression scoring, exclusion-zone vetoes, object-form
 * assignments in TeamPlans and post-plan authoritative-cone verification.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { FLAG_KEYS, MODULE_ID } from "../../scripts/constants.js";
import { createFireteamService, FIRETEAM_STATUS } from "../../scripts/fireteam.js";
import { createPlannerService } from "../../scripts/planner.js";
import {
    evaluateSpecOps,
    registerSpecOpsPreset,
    registerSpecOpsTacticSelector,
    selectSpecOpsTactic,
    specOpsVeto
} from "../../scripts/presets/spec-ops.js";
import {
    RANGED_COVER_WEIGHTS,
    evaluateRangedCover,
    rangedCoverVeto,
    registerRangedCoverTacticSelector,
    selectRangedCoverTactic
} from "../../scripts/presets/ranged-cover.js";
import { createTacticRegistry } from "../../scripts/tactics/registry.js";
import { SUPPRESS_AND_BOUND } from "../../scripts/tactics/suppress-and-bound.js";
import { makeActor, makeCombat, makeCombatant, makeScene, makeToken } from "./fixtures.mjs";

function makeWeapon(id = "gun", { range = 150, clip = 12 } = {}) {
    return {
        id,
        uuid: `uuid-${id}`,
        name: "Suppression gun",
        type: "weapon",
        system: {
            class: "basic",
            range,
            damage: "1d10+3",
            rateOfFire: { single: 1, burst: 2, full: 4 },
            clip: { value: clip, max: 12 },
            ammoPerShot: 1,
            jammed: false
        }
    };
}

function memberDto(id, x, y, { turnIndex = 0, hasActed = false, items = null } = {}) {
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
        hasActed,
        enabled: true,
        defeated: false,
        combatant: {
            id,
            token,
            disposition: -1,
            actor: { id: `actor-${id}`, items: items ?? [makeWeapon(`gun-${id}`)] }
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

function selectorInput() {
    const members = [
        memberDto("m1", 0, 0, { turnIndex: 1 }),
        memberDto("m2", 0, -30, { turnIndex: 0 }),
        memberDto("m3", 0, 30, { turnIndex: 2 })
    ];
    const targets = [targetDto("e1", 100, -5), targetDto("e2", 100, 5)];
    return {
        members,
        leaderId: "m1",
        targets,
        context: {
            pxPerUnit: 1,
            sceneTokens: [
                ...members.map(member => ({
                    tokenId: member.tokenId,
                    x: member.position.x,
                    y: member.position.y,
                    disposition: -1
                })),
                ...targets.map(target => ({
                    tokenId: target.tokenId,
                    tokenUuid: target.tokenUuid,
                    x: target.x,
                    y: target.y,
                    disposition: 1
                }))
            ]
        }
    };
}

test("specOps cascade selects suppress-and-bound before flank/assault with object assignments", () => {
    const result = selectSpecOpsTactic(selectorInput());
    assert.equal(result.name, SUPPRESS_AND_BOUND);
    assert.equal(result.suppressorId, "m2", "equal coverage picks the earlier turnIndex");
    assert.equal(result.assignments.m2.task, "support");
    assert.equal(result.assignments.m2.role, "suppressor");
    assert.equal(result.assignments.m2.element, "fire");
    assert.equal(result.assignments.m1.role, "bound");
    assert.equal(result.assignments.m1.element, "maneuver");
    assert.equal(result.assignments.m1.objective.type, SUPPRESS_AND_BOUND);
    assert.ok(Array.isArray(result.exclusionZones));
    assert.equal(result.maxDetachedPhases, 2);
    assert.equal(result.breakdown.suppression.selected, true);
    assert.ok(Array.isArray(result.breakdown.suppression.candidates));
    assert.deepEqual(JSON.parse(JSON.stringify(result)), JSON.parse(JSON.stringify(result)));
});

test("a covered focus target remains the suppress-and-bound objective target", () => {
    const input = selectorInput();
    input.objective = { type: "attack", targetId: "e2", targetUuid: "uuid-e2" };
    input.context.objective = input.objective;
    const result = selectSpecOpsTactic(input);
    assert.equal(result.name, SUPPRESS_AND_BOUND);
    assert.equal(result.objective.targetId, "e2");
    assert.equal(result.assignments.m2.objective.targetId, "e2");
    assert.equal(result.cone.covered[0].tokenId, "e2");
});

test("specOps suppression degradation continues the cascade with diagnostics", () => {
    const input = selectorInput();
    for (const member of input.members) member.combatant.actor.items = [];
    input.targets = [targetDto("e1", 100, 0)];
    const result = selectSpecOpsTactic(input);
    assert.equal(result.name, "coordinated-assault");
    assert.equal(result.breakdown.suppression.selected, false);
    assert.equal(result.breakdown.suppression.reason, "no-suppressor");
    assert.ok(Array.isArray(result.breakdown.suppression.capability));
});

test("rangedCover selector registers and implements the suppress-or-null cascade", () => {
    const registry = createTacticRegistry();
    const record = registerRangedCoverTacticSelector(registry);
    assert.equal(record.presetId, "rangedCover");
    assert.equal(record.kind, "maneuver");
    const selected = selectRangedCoverTactic(selectorInput());
    assert.equal(selected.name, SUPPRESS_AND_BOUND);
    assert.equal(selected.assignments.m2.role, "suppressor");

    const degradedInput = selectorInput();
    for (const member of degradedInput.members) member.combatant.actor.items = [];
    const degraded = registry.resolveTactic("rangedCover", degradedInput);
    assert.equal(degraded.name, null);
    assert.equal(degraded.reason, "no-suppressor");
    assert.equal(degraded.breakdown.suppression.reason, "no-suppressor");
    assert.equal("allowFlank" in degraded, false,
        "a null cascade result must not disable the default fireteam policy");
});

test("suppression scoring is a strong suppressor factor, never a direct-fire veto", () => {
    const coneCandidate = {
        variant: "attack-in-place",
        cone: { spec: { suppression: true }, covered: [{}, {}] },
        blastHits: 2,
        target: targetDto("e1", 100, 0),
        action: { range: 6, class: "basic" }
    };
    const context = { team: { task: "support", role: "suppressor" }, selfPos: { x: 0, y: 0 } };
    const specOps = evaluateSpecOps({ factors: {}, candidate: coneCandidate, context });
    assert.equal(specOps.breakdown.factors.suppression, 1);
    assert.equal(specOps.breakdown.weights.suppression, 8);
    const ranged = evaluateRangedCover({ factors: {}, candidate: coneCandidate, context });
    assert.equal(ranged.breakdown.factors.suppression, 1);
    assert.equal(ranged.breakdown.weights.suppression, 8);

    const direct = evaluateSpecOps({
        factors: {},
        candidate: { ...coneCandidate, cone: null, blastHits: 0 },
        context
    });
    assert.equal(direct.breakdown.factors.suppression, 0,
        "ordinary direct fire receives no suppression bonus but remains legal");
});

test("rangedCover solo evaluation remains free of team overlays", () => {
    const candidate = {
        variant: "attack-in-place",
        target: targetDto("e1", 100, 0),
        action: { range: 100, class: "basic" }
    };
    const result = evaluateRangedCover({
        factors: { attackNow: 1, los: 1 },
        candidate,
        context: { selfPos: { x: 0, y: 0 } }
    });
    assert.deepEqual(Object.keys(result.breakdown.weights), Object.keys(RANGED_COVER_WEIGHTS));
    assert.equal("suppression" in result.breakdown.weights, false);
    assert.equal("team" in result.breakdown, false);
});

test("exclusion-zone veto rejects move endpoints but not stay or attack-in-place", () => {
    const zones = [{ x: 0, y: 0, direction: 0, angleDeg: 45, rangePx: 100, kind: "suppression" }];
    const team = { exclusionZones: zones };
    for (const veto of [specOpsVeto, rangedCoverVeto]) {
        assert.equal(veto({
            candidate: { variant: "approach", move: { x: 50, y: 0 } },
            context: { team }
        }), "suppression-zone");
        assert.equal(veto({
            candidate: { variant: "attack-in-place", target: { source: "visible" } },
            context: { team }
        }), null);
        assert.equal(veto({
            candidate: { variant: "approach", move: { x: 0, y: 0, stay: true } },
            context: { team }
        }), null);
        assert.equal(veto({
            candidate: { variant: "approach", move: { x: -50, y: 0 } },
            context: { team }
        }), null);
    }
});

/* ------------------------------------------------------------------ */
/* TeamPlan integration                                                */
/* ------------------------------------------------------------------ */

function withFireteam(doc, flag) {
    doc.flags[MODULE_ID] = doc.flags[MODULE_ID] ?? {};
    doc.flags[MODULE_ID][FLAG_KEYS.fireteam] = flag;
    return doc;
}

function worldMember(id, x, y, { initiative = 10, preset = "specOps" } = {}) {
    const actor = makeActor({ enabled: true, preset });
    actor.system = { wounds: { value: 10, max: 10 } };
    actor.items = [makeWeapon("gun", { range: 6 })];
    const token = makeToken({ actor });
    token.x = x;
    token.y = y;
    token.disposition = -1;
    const combatant = makeCombatant({ actor, token });
    combatant.id = id;
    combatant.tokenId = token.id;
    combatant.initiative = initiative;
    combatant.defeated = false;
    withFireteam(combatant, { teamId: "alpha", teamPreset: preset });
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

function suppressionActions() {
    return [
        {
            id: "standard",
            type: "attack",
            attackType: "standard",
            itemId: "gun",
            itemUuid: "uuid-gun",
            name: "Suppression gun",
            range: 6,
            damage: 5,
            cost: "half",
            rateOfFire: { single: 1, burst: 2, full: 4 }
        },
        {
            id: "suppress",
            type: "attack",
            attackType: "suppressing_fire",
            itemId: "gun",
            itemUuid: "uuid-gun",
            name: "Suppression gun",
            range: 6,
            damage: 5,
            cost: "full",
            rateOfFire: { single: 1, burst: 2, full: 4 }
        }
    ];
}

test("specOps TeamPlan carries suppression roles, zones and a serialized suppression attack", async () => {
    const members = [
        worldMember("m1", 0, 0, { initiative: 20 }),
        worldMember("m2", 0, -30, { initiative: 10 }),
        worldMember("m3", 0, 30, { initiative: 5 })
    ];
    const enemies = [enemyToken("e1", 250, 40), enemyToken("e2", 250, 60)];
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
        actions: suppressionActions(),
        moves: [],
        personality: false
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    const plan = result.teamPlan;
    assert.equal(plan.tactic, SUPPRESS_AND_BOUND);
    assert.equal(plan.diagnostics.tactic.breakdown.suppression.selected, true);
    const roles = Object.fromEntries(plan.members.map(member => [member.combatantId, member.role]));
    assert.deepEqual(Object.values(roles).sort(), ["bound", "bound", "suppressor"]);
    const suppressor = plan.members.find(member => member.role === "suppressor");
    assert.equal(suppressor.element, "fire");
    assert.equal(suppressor.task, "support");
    assert.equal(suppressor.objective.type, SUPPRESS_AND_BOUND);
    for (const bound of plan.members.filter(member => member.role === "bound")) {
        assert.equal(bound.element, "maneuver");
        assert.ok(["advance", "flank"].includes(bound.task));
    }
    const suppressorContext = contexts.find(entry => entry.combatantId === suppressor.combatantId)?.context;
    assert.ok(suppressorContext.team.suppressionCone);
    assert.equal("exclusionZones" in suppressorContext.team, false);
    for (const entry of contexts.filter(entry => entry.combatantId !== suppressor.combatantId)) {
        assert.ok(Array.isArray(entry.context.team.exclusionZones),
            "non-suppressors receive the selection-time exclusion zone");
        assert.equal(entry.context.team.exclusionZones[0].kind, "suppression");
    }
    const suppressorPlan = plan.memberPlans[suppressor.combatantId];
    const suppressionStep = suppressorPlan.steps.find(step => step.input?.suppressionFire === true);
    assert.ok(suppressionStep, "the suppressor plan should choose the suppression cone attack");
    assert.ok(Number.isFinite(suppressionStep.input.template.direction));
    assert.equal(suppressionStep.input.template.angle, 45);
    assert.equal(plan.diagnostics.suppressionZones.checked, true);
    assert.equal(plan.diagnostics.suppressionZones.conflicts.length, 0);
    const roundTrip = JSON.parse(JSON.stringify(plan));
    assert.equal(roundTrip.tactic, SUPPRESS_AND_BOUND);
    assert.equal(roundTrip.members.find(member => member.role === "suppressor").element, "fire");
});

/* ------------------------------------------------------------------ */
/* Post-plan verification with a controlled planner                    */
/* ------------------------------------------------------------------ */

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

test("post-plan verification replans a zone violator once, then excludes the move", async () => {
    const suppressor = worldMember("s1", 0, 0, { initiative: 20 });
    const violator = worldMember("b1", 0, 100, { initiative: 10 });
    const world = makeWorld([suppressor, violator], []);
    const calls = [];
    const coneStep = step("attack", {
        actionId: "suppress",
        targetTokenId: "e1",
        targetTokenUuid: "uuid-e1",
        template: { direction: 0, angle: 45, range: 3 },
        covered: ["uuid-e1"],
        suppressionFire: true
    }, { halves: 2 });
    const violationMove = step("move", {
        // The endpoint itself is outside the cone; the middle waypoint enters it.
        to: { x: 150, y: 150 },
        waypoints: [{ x: 50, y: 150 }, { x: 100, y: 60 }, { x: 150, y: 150 }],
        approximate: false
    }, { movement: 2, halves: 1 });
    const planner = {
        async planTurn(_combat, combatant, context) {
            calls.push({ combatantId: combatant.id, context });
            if (combatant.id === "s1") {
                return { status: "ok", plan: stubPlan(`s1-${calls.length}`, [coneStep]) };
            }
            if (Array.isArray(context.moves) && context.moves.length === 0) {
                return { status: "ok", plan: stubPlan(`b1-hold-${calls.length}`, [step("end-turn")], 0) };
            }
            return { status: "ok", plan: stubPlan(`b1-move-${calls.length}`, [violationMove]) };
        }
    };
    const zone = { x: 50, y: 50, direction: 0, angleDeg: 45, rangePx: 200, ownerId: "s1", kind: "suppression" };
    const objective = {
        type: SUPPRESS_AND_BOUND,
        targetId: "e1",
        targetPoint: { x: 250, y: 50 },
        suppressionCone: zone
    };
    const tactic = {
        name: SUPPRESS_AND_BOUND,
        reason: "coverage-threshold",
        suppressorId: "s1",
        assignments: {
            s1: { task: "support", role: "suppressor", element: "fire", objective },
            b1: { task: "advance", role: "bound", element: "maneuver", objective }
        },
        objective,
        cone: zone,
        exclusionZones: [zone],
        maxDetachedPhases: 2,
        breakdown: {}
    };
    const fireteam = createFireteamService();
    const result = await fireteam.buildTeamPlan(world.combat, "alpha", {
        seed: 9,
        readOnly: true,
        planner,
        tactic,
        targets: [],
        objective: { targetId: "gm-ordered-target" },
        personality: false
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    assert.ok(result.teamPlan.diagnostics.assignments.every(assignment =>
        assignment.assignedTargetId === "gm-ordered-target"),
        `explicit order should win: ${JSON.stringify(result.teamPlan.diagnostics.assignments)}`);
    const violatorCalls = calls.filter(entry => entry.combatantId === "b1");
    assert.equal(violatorCalls.length, 3, "initial plan + one zone replan + move-excluded fallback");
    assert.ok(Array.isArray(violatorCalls[0].context.team.exclusionZones));
    assert.equal(violatorCalls[1].context.team.exclusionZones[0].kind, "suppression");
    assert.deepEqual(violatorCalls[2].context.moves, []);
    const plan = result.teamPlan;
    assert.equal(plan.memberPlans.b1.steps.some(stepEntry => stepEntry.type === "move"), false,
        "the repeated violation is degraded by excluding movement");
    assert.ok(plan.reservations && plan.diagnostics.reservations.conflicts.some(conflict =>
        conflict.type === "zone" && conflict.reason === "suppression-zone"
        && conflict.loserId === "b1" && conflict.winnerId === "s1"));
    assert.equal(plan.diagnostics.suppressionZones.replans.length, 2);
});
