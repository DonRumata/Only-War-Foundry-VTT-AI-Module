/**
 * Integration tests for interdiction-screen (issue #87): the spec-ops
 * cascade composition, object-form assignments and attack-pool exclusion
 * propagation in `fireteam.buildTeamPlan`, the screen-progress movement
 * scoring and deterministic serialization.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { FLAG_KEYS, MODULE_ID } from "../../scripts/constants.js";
import { createFireteamService, FIRETEAM_STATUS } from "../../scripts/fireteam.js";
import { createPlannerService } from "../../scripts/planner.js";
import {
    INTERDICTION_TACTIC,
    INTERDICT_OBJECTIVE_TYPE,
    INTERDICT_ROLE
} from "../../scripts/presets/interdiction.js";
import {
    SPEC_OPS_ROLE_WEIGHTS,
    evaluateSpecOps,
    registerSpecOpsPreset,
    registerSpecOpsTacticSelector,
    selectSpecOpsTactic
} from "../../scripts/presets/spec-ops.js";
import { SUPPRESS_AND_BOUND } from "../../scripts/tactics/suppress-and-bound.js";
import { createTacticRegistry } from "../../scripts/tactics/registry.js";
import { createGridAdapter, createNavigationService } from "../../scripts/navigation.js";
import { makeActor, makeCombat, makeCombatant, makeScene, makeToken } from "./fixtures.mjs";

/* ------------------------------------------------------------------ */
/* Selector-level fixtures (gridless 1:1 px-per-unit mode)             */
/* ------------------------------------------------------------------ */

/** Melee-capable fighter: knife EV 5, charge 30, 20 remaining wounds. */
function fighterDto(id, x, y, extra = {}) {
    return {
        combatantId: id,
        tokenId: `token-${id}`,
        enabled: true,
        defeated: false,
        position: { x, y },
        positionIsCenter: true,
        meleeEV: 5,
        rangedEV: 0,
        chargeRate: 30,
        fullMove: 20,
        hp: 20,
        combatant: { id, actor: { id: `actor-${id}`, items: [] } },
        ...extra
    };
}

/** Ranged-only shooter: no melee capability — never an interdictor. */
function shooterDto(id, x, y, extra = {}) {
    return fighterDto(id, x, y, {
        meleeEV: 0,
        rangedEV: 8.5,
        bestRange: 100,
        ...extra
    });
}

function targetDto(id, x, y, extra = {}) {
    return {
        tokenId: id,
        tokenUuid: `Scene.s.Token.${id}`,
        x,
        y,
        statuses: [],
        canAttack: true,
        hidden: false,
        source: "visible",
        ...extra
    };
}

function selectorInput() {
    return {
        members: [
            fighterDto("m1", 0, 0),
            fighterDto("m2", 0, -10),
            // A team shooter: the protectee trigger B screens and a
            // non-interdictor member of the base maneuver.
            shooterDto("m3", 0, 10)
        ],
        leaderId: "m1",
        targets: [targetDto("e1", 30, 0, { rangedEV: 6, meleeEV: 0 })]
    };
}

test("trigger A: a pure shooter redirects the cascade into interdiction-screen", () => {
    const result = selectSpecOpsTactic(selectorInput());
    assert.equal(result.name, INTERDICTION_TACTIC);
    assert.equal(result.reason, "pure-shooter");
    assert.equal(result.breakdown.baseTactic, "coordinated-assault");
    assert.equal(result.breakdown.interdiction.trigger, "A");
    assert.equal(result.breakdown.interdiction.targetId, "e1");
    assert.equal(result.breakdown.interdiction.confidence, 1);

    // Composition: exactly one interdictor override, the rest keep the
    // base coordinated-assault task.
    const entries = Object.entries(result.assignments);
    const interdictors = entries.filter(([, a]) => a.role === INTERDICT_ROLE);
    assert.equal(interdictors.length, 1);
    const [interdictorId, assignment] = interdictors[0];
    assert.equal(assignment.task, "assault");
    assert.equal(assignment.objective.type, INTERDICT_OBJECTIVE_TYPE);
    assert.equal(assignment.objective.targetId, "e1");
    assert.ok(assignment.objective.screenPoint, "screen geometry rides the member objective");
    assert.ok("protectId" in assignment.objective);
    assert.ok("mode" in assignment.objective || "trigger" in assignment.objective);
    for (const [id, other] of entries.filter(([id]) => id !== interdictorId)) {
        assert.equal(other.task, "assault");
        assert.equal(other.role, undefined, `${id} keeps the unroled base assignment`);
    }

    // Command exclusion of the interception target.
    assert.deepEqual(result.excludedTargets, [{
        targetId: "e1",
        tokenUuid: "Scene.s.Token.e1",
        reason: "interdiction"
    }]);
    assert.equal(result.regroup, false);

    // Serializable, deterministic.
    const roundTrip = JSON.parse(JSON.stringify(result));
    assert.equal(roundTrip.name, INTERDICTION_TACTIC);
    assert.equal(roundTrip.breakdown.interdiction.trigger, "A");
    const repeat = selectSpecOpsTactic(selectorInput());
    assert.deepEqual(JSON.parse(JSON.stringify(repeat)), roundTrip);
});

test("trigger B: a melee charger is interdicted with charger-threat reason", () => {
    const input = selectorInput();
    input.targets = [targetDto("e1", 25, 0, { rangedEV: 2, meleeEV: 8, chargeRate: 30 })];
    const result = selectSpecOpsTactic(input);
    assert.equal(result.name, INTERDICTION_TACTIC);
    assert.equal(result.reason, "charger-threat");
    assert.equal(result.breakdown.interdiction.trigger, "B");
});

test("trigger B wins over trigger A when both threats are visible", () => {
    const input = selectorInput();
    input.targets = [
        targetDto("shooter", 30, -10, { rangedEV: 6, meleeEV: 0 }),
        targetDto("charger", 25, 10, { rangedEV: 2, meleeEV: 8, chargeRate: 30 })
    ];
    const result = selectSpecOpsTactic(input);
    assert.equal(result.name, INTERDICTION_TACTIC);
    assert.equal(result.objective.targetId, "charger", "the charger is the primary threat");
    assert.equal(result.breakdown.interdiction.trigger, "B");
    const skippedOrCandidates = result.breakdown.interdiction.candidates
        .map(c => [c.targetId, c.trigger]);
    assert.ok(skippedOrCandidates.some(([id, trigger]) => id === "shooter" && trigger === "A"),
        "the pure shooter remains a visible evaluated candidate");
});

test("degradation: no melee-capable member continues the base cascade honestly", () => {
    const input = selectorInput();
    input.members = [shooterDto("m1", 0, 0), shooterDto("m2", 0, -10), shooterDto("m3", 0, 10)];
    const result = selectSpecOpsTactic(input);
    assert.equal(result.name, "coordinated-assault");
    assert.equal(result.breakdown.interdiction.rejected, "no-interdictor");
    assert.equal(result.breakdown.interdiction.candidates[0]?.trigger, "A",
        "the trigger evaluation stays visible in the degradation breakdown");
    assert.equal(result.excludedTargets, undefined,
        "a degraded cascade never emits command exclusions");
});

test("degradation: memory and hidden contacts never trigger interdiction", () => {
    const input = selectorInput();
    // A plain attackable decoy keeps the cascade on the attack-maneuver
    // path so the interdiction pass actually evaluates the contact list.
    const decoy = targetDto("e2", 40, 20, { rangedEV: 0, meleeEV: 0 });
    input.targets = [
        targetDto("e1", 30, 0, { rangedEV: 6, meleeEV: 0, source: "last-known" }),
        decoy
    ];
    const result = selectSpecOpsTactic(input);
    assert.notEqual(result.name, INTERDICTION_TACTIC);
    const candidate = result.breakdown.interdiction.candidates.find(c => c.targetId === "e1");
    assert.equal(candidate?.rejected, "memory-source");

    input.targets = [
        targetDto("e1", 30, 0, { rangedEV: 6, meleeEV: 0, hidden: true }),
        decoy
    ];
    const hidden = selectSpecOpsTactic(input);
    assert.notEqual(hidden.name, INTERDICTION_TACTIC);
    const hiddenCandidate = hidden.breakdown.interdiction.candidates.find(c => c.targetId === "e1");
    assert.equal(hiddenCandidate?.rejected, "hidden");
});

test("suppression keeps its cascade slot before the attack maneuvers", () => {
    // Mirror the suppress-and-bound integration fixture exactly — member
    // tokens carry width/disposition and the cone geometry is safe — but
    // both targets are textbook pure shooters. Fire-based denial still
    // wins the cascade slot and the interdiction pass is never evaluated.
    const gun = id => ({
        id,
        uuid: "uuid-" + id,
        name: "Suppression gun",
        type: "weapon",
        system: {
            class: "basic", range: 150, damage: "1d10+3",
            rateOfFire: { single: 1, burst: 2, full: 4 },
            clip: { value: 12, max: 12 }
        }
    });
    const memberDto = (id, x, y, turnIndex) => ({
        combatantId: id,
        tokenId: "token-" + id,
        position: { x, y },
        positionIsCenter: true,
        turnIndex,
        hasActed: false,
        enabled: true,
        defeated: false,
        combatant: {
            id,
            token: {
                id: "token-" + id,
                uuid: "token-uuid-" + id,
                x, y, width: 1, height: 1, disposition: -1
            },
            disposition: -1,
            actor: { id: "actor-" + id, items: [gun("gun-" + id)] }
        }
    });
    const members = [memberDto("m1", 0, 0, 1), memberDto("m2", 0, -30, 0), memberDto("m3", 0, 30, 2)];
    const input = {
        members,
        leaderId: "m1",
        targets: [
            targetDto("e1", 100, -5, { rangedEV: 8, meleeEV: 0 }),
            targetDto("e2", 100, 5, { rangedEV: 8, meleeEV: 0 })
        ],
        context: {
            pxPerUnit: 1,
            sceneTokens: [
                ...members.map(member => ({
                    tokenId: member.tokenId, x: member.position.x, y: member.position.y, disposition: -1
                })),
                { tokenId: "e1", tokenUuid: "Scene.s.Token.e1", x: 100, y: -5, disposition: 1 },
                { tokenId: "e2", tokenUuid: "Scene.s.Token.e2", x: 100, y: 5, disposition: 1 }
            ]
        }
    };
    const result = selectSpecOpsTactic(input);
    assert.equal(result.name, SUPPRESS_AND_BOUND);
    assert.equal(result.breakdown.suppression.selected, true);
    assert.equal(result.breakdown.interdiction, undefined,
        "interdiction is not evaluated once suppression commits");
});

test("shuffle-invariance: member input order does not change the selection", () => {
    const input = selectorInput();
    const first = selectSpecOpsTactic(input);
    input.members = [input.members[2], input.members[0], input.members[1]];
    const second = selectSpecOpsTactic(input);
    assert.equal(second.name, first.name);
    const rolesOf = result => Object.fromEntries(Object.entries(result.assignments)
        .map(([id, a]) => [id, a.role ?? null]));
    assert.deepEqual(rolesOf(second), rolesOf(first));
    assert.equal(second.objective.targetId, first.objective.targetId);
});

/* ------------------------------------------------------------------ */
/* screenProgress factor                                               */
/* ------------------------------------------------------------------ */

test("screenProgress scores endpoint progress toward the screen point", () => {
    const team = {
        task: "assault",
        role: INTERDICT_ROLE,
        screenPoint: { x: 100, y: 0 }
    };
    const context = { team, selfPos: { x: 0, y: 0 }, scene: null, token: null };
    const approaching = evaluateSpecOps({
        factors: {},
        candidate: { variant: "charge", move: { x: 80, y: 0 } },
        context
    });
    assert.ok(approaching.breakdown.team.screenProgress > 0.7,
        "an endpoint next to the screen point scores high progress");
    // Role overlay: charge 5 → 8, tieUp 4 → 8, screenProgress +8,
    // holdPosition negative.
    assert.equal(approaching.breakdown.weights.screenProgress,
        (SPEC_OPS_ROLE_WEIGHTS.interdictor.screenProgress ?? 0) + 0);
    assert.equal(approaching.breakdown.weights.charge, 8);
    assert.equal(approaching.breakdown.weights.tieUp, 8);
    assert.ok(approaching.breakdown.weights.holdPosition < 0);

    const retreating = evaluateSpecOps({
        factors: {},
        candidate: { variant: "move", move: { x: -50, y: 0 } },
        context
    });
    assert.equal(retreating.breakdown.team.screenProgress, 0,
        "backing away scores zero, never a hard-veto negative — the factor"
        + " only rewards progress, mirroring flankProgress");

    const noRole = evaluateSpecOps({
        factors: {},
        candidate: { variant: "charge", move: { x: 80, y: 0 } },
        context: { team: { task: "assault" }, selfPos: { x: 0, y: 0 } }
    });
    assert.equal(noRole.breakdown.team.screenProgress, null,
        "non-interdictors never carry the factor");
});

test("screenPoint falls back to the serialized member objective", () => {
    const result = evaluateSpecOps({
        factors: {},
        candidate: { variant: "move", move: { x: 90, y: 0 } },
        context: {
            team: {
                task: "assault",
                role: INTERDICT_ROLE,
                memberObjective: { type: INTERDICT_OBJECTIVE_TYPE, screenPoint: { x: 100, y: 0 } }
            },
            selfPos: { x: 0, y: 0 }
        }
    });
    assert.ok(result.breakdown.team.screenProgress > 0.8);
});

/* ------------------------------------------------------------------ */
/* TeamPlan integration                                                */
/* ------------------------------------------------------------------ */

function withFireteam(doc, flag) {
    doc.flags[MODULE_ID] = doc.flags[MODULE_ID] ?? {};
    doc.flags[MODULE_ID][FLAG_KEYS.fireteam] = flag;
    return doc;
}

function meleeWeapon(id = "knife") {
    return { id, uuid: `uuid-${id}`, name: "Knife", type: "weapon", system: { class: "melee", damage: "1d5+2" } };
}

function worldMember(id, x, y, { initiative = 10 } = {}) {
    const actor = makeActor({ enabled: true, preset: "specOps" });
    actor.system = {
        wounds: { value: 0, max: 20 },
        movement: { half: 3, full: 6, charge: 9, run: 18 }
    };
    actor.items = [meleeWeapon(`knife-${id}`)];
    const token = makeToken({ actor });
    token.x = x;
    token.y = y;
    token.disposition = -1;
    const combatant = makeCombatant({ actor, token });
    combatant.id = id;
    combatant.tokenId = token.id;
    combatant.initiative = initiative;
    combatant.defeated = false;
    withFireteam(combatant, { teamId: "alpha", teamPreset: "specOps" });
    return { actor, token, combatant };
}

function enemyToken(id, x, y) {
    const actor = makeActor();
    actor.system = { wounds: { value: 0, max: 10 }, movement: { charge: 9, full: 6 } };
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
    Object.assign(scene, {
        width: 2000,
        height: 2000,
        tokens: { contents: [
            ...members.map(member => member.token),
            ...enemies.map(enemy => enemy.token)
        ] }
    });
    const combat = makeCombat({
        round: 1,
        turn: 0,
        combatants: [
            ...members.map(member => member.combatant),
            ...enemies.map(enemy => enemy.combatant)
        ]
    });
    combat.scene = scene;
    return { scene, combat };
}

function interdictionWorld() {
    const members = [
        worldMember("m1", 100, 500, { initiative: 20 }),
        worldMember("m2", 100, 400, { initiative: 10 }),
        worldMember("m3", 100, 600, { initiative: 5 })
    ];
    // 300 px = 4.5 m on the fixture grid — inside the 9 m charge band.
    const shooter = enemyToken("e1", 400, 500);
    const second = enemyToken("e2", 400, 700);
    const world = makeWorld(members, [shooter, second]);
    const targets = [
        {
            tokenId: "e1",
            tokenUuid: shooter.token.uuid,
            x: 400, y: 500, elevation: 0,
            canAttack: true, source: "injected",
            rangedEV: 6, meleeEV: 0
        },
        {
            tokenId: "e2",
            tokenUuid: second.token.uuid,
            x: 400, y: 700, elevation: 0,
            canAttack: true, source: "injected",
            rangedEV: 0, meleeEV: 0
        }
    ];
    return { world, members, shooter, second, targets };
}

function makeService(contexts) {
    const realPlanner = createPlannerService();
    registerSpecOpsPreset(realPlanner);
    const plannerProxy = {
        planTurn: (combat, combatant, context) => {
            contexts.push({ combatantId: combatant.id, context });
            return realPlanner.planTurn(combat, combatant, context);
        }
    };
    const tactics = createTacticRegistry();
    registerSpecOpsTacticSelector(tactics);
    return { fireteam: createFireteamService({ tactics }), plannerProxy };
}

test("specOps TeamPlan composes interdiction roles, exclusions and screen geometry", async () => {
    const { world, targets } = interdictionWorld();
    const contexts = [];
    const { fireteam, plannerProxy } = makeService(contexts);
    const result = await fireteam.buildTeamPlan(world.combat, "alpha", {
        seed: 42,
        readOnly: true,
        planner: plannerProxy,
        targets,
        tacticTargets: targets,
        moves: [],
        personality: false,
        navigation: createNavigationService({ adapter: createGridAdapter({ canvas: { scene: world.scene } }) }),
        rates: { half: 1.5, full: 3, charge: 4.5, run: 9 }
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    const plan = result.teamPlan;
    assert.equal(plan.tactic, INTERDICTION_TACTIC);
    assert.equal(plan.diagnostics.tactic.breakdown.baseTactic, "coordinated-assault");
    assert.equal(plan.diagnostics.tactic.breakdown.interdiction.trigger, "A");

    const interdictors = plan.members.filter(member => member.role === INTERDICT_ROLE);
    assert.equal(interdictors.length, 1);
    const interdictor = interdictors[0];
    assert.equal(interdictor.task, "assault");
    assert.equal(interdictor.objective.type, INTERDICT_OBJECTIVE_TYPE);
    assert.equal(interdictor.objective.targetId, "e1");
    assert.ok(interdictor.objective.screenPoint);

    // The focus channel never collapses onto the interception target.
    const focusTarget = plan.diagnostics.focus?.focus?.targetId ?? null;
    assert.notEqual(focusTarget, "e1",
        "the interception target is excluded from concentrate-fire candidacy");

    // Attack-pool propagation: every non-interdictor carries the
    // interception ids in the deny-list while the threat pool itself
    // stays complete; the interdictor keeps its own target legal.
    for (const entry of contexts) {
        const isInterdictor = entry.combatantId === interdictor.combatantId;
        const deny = entry.context.excludedAttackTargetIds ?? [];
        if (isInterdictor) {
            assert.ok(!deny.includes("e1"), "the interdictor is not denied its own target");
            assert.ok(entry.context.team.screenPoint, "screen geometry reaches the team context");
            assert.equal(entry.context.team.role, INTERDICT_ROLE);
        } else {
            assert.ok(deny.includes("e1"),
                `member ${entry.combatantId} carries the command denial`);
        }
        assert.ok(!Array.isArray(entry.context.attackTargetIds)
            || !entry.context.attackTargetIds.includes("e1")
            || isInterdictor, "no allow-list sneaks the excluded target back in");
    }

    // The interdictor's own member plan evaluates with the screen factor.
    const interdictorPlan = plan.memberPlans[interdictor.combatantId];
    assert.equal(interdictorPlan?.breakdown?.team?.task, "assault");
    assert.ok(interdictorPlan?.breakdown?.team?.screenProgress !== null
        && interdictorPlan?.breakdown?.team?.screenProgress !== undefined,
        "screenProgress is scored end-to-end");

    // Serializable determinism.
    const roundTrip = JSON.parse(JSON.stringify(plan));
    assert.equal(roundTrip.tactic, INTERDICTION_TACTIC);
    assert.equal(roundTrip.members.find(m => m.role === INTERDICT_ROLE).objective.targetId, "e1");
    const repeat = await fireteam.buildTeamPlan(world.combat, "alpha", {
        seed: 42,
        readOnly: true,
        planner: plannerProxy,
        targets,
        tacticTargets: targets,
        moves: [],
        personality: false,
        navigation: createNavigationService({ adapter: createGridAdapter({ canvas: { scene: world.scene } }) }),
        rates: { half: 1.5, full: 3, charge: 4.5, run: 9 }
    });
    assert.equal(repeat.teamPlan.id, plan.id);
});

test("interdiction degradation leaves the ordinary spec-ops cascade intact", async () => {
    const { world, targets } = interdictionWorld();
    // Strip every melee weapon — no member can interdict.
    for (const combatant of world.combat.combatants.contents ?? world.combat.combatants) {
        if (combatant.id?.startsWith?.("m")) combatant.actor.items = [];
    }
    const contexts = [];
    const { fireteam, plannerProxy } = makeService(contexts);
    const result = await fireteam.buildTeamPlan(world.combat, "alpha", {
        seed: 42,
        readOnly: true,
        planner: plannerProxy,
        targets,
        tacticTargets: targets,
        moves: [],
        personality: false,
        navigation: createNavigationService({ adapter: createGridAdapter({ canvas: { scene: world.scene } }) }),
        rates: { half: 1.5, full: 3, charge: 4.5, run: 9 }
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    assert.notEqual(result.teamPlan.tactic, INTERDICTION_TACTIC);
    assert.ok(result.teamPlan.diagnostics.tactic.breakdown.interdiction.rejected,
        "the degradation reason is visible in the plan diagnostics");
    assert.ok(result.teamPlan.members.every(member => member.role !== INTERDICT_ROLE));
    for (const entry of contexts) {
        assert.ok(!(entry.context.excludedAttackTargetIds ?? []).includes("e1"),
            "a degraded interdiction emits no command exclusions");
    }
});
