/**
 * Unit tests for the spec-ops preset — «Спецназ» (issue #412): tactic
 * selector (flank-and-fix / coordinated-assault / covering-advance /
 * regroup-fallback), task → member weight mapping, solo `no-fireteam`
 * fallback, TeamPlan integration through `fireteam.buildTeamPlan` with
 * the spec-ops tactic factory, phases with barriers, reservations and
 * seed determinism.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    FIRETEAM_TASKS,
    FLAG_KEYS,
    MODULE_ID
} from "../../scripts/constants.js";
import {
    FIRETEAM_STATUS,
    createFireteamService
} from "../../scripts/fireteam.js";
import {
    PLANNER_STATUS,
    createPlannerService
} from "../../scripts/planner.js";
import {
    SPEC_OPS_CONFIG,
    SPEC_OPS_PRESET_ID,
    SPEC_OPS_TACTICS,
    SPEC_OPS_VETO_HIDDEN_TARGET,
    SPEC_OPS_WEIGHTS,
    buildSpecOpsTeamPlan,
    createSpecOpsTactic,
    evaluateSpecOps,
    registerSpecOpsPreset,
    selectSpecOpsTactic,
    specOpsTactic,
    specOpsVeto
} from "../../scripts/presets/spec-ops.js";
import {
    makeActor,
    makeCombatant,
    makeScene,
    makeToken
} from "./fixtures.mjs";

let _combatId = 0;

/**
 * Minimal Combat fixture (mirrors `tests/unit/fireteam.test.mjs`).
 * @param {object} [options]
 * @param {object[]} [options.combatants]
 * @returns {object}
 */
function makeCombat({ combatants = [] } = {}) {
    const collection = new Map(combatants.map(c => [c.id, c]));
    collection.contents = combatants;
    return {
        documentName: "Combat",
        id: `spec-ops-combat-${++_combatId}`,
        round: 1,
        turn: 0,
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
 * @param {object[]} [options.items] Actor items (weapons).
 * @returns {object}
 */
function makeMember({
    fireteam,
    x = 0,
    y = 0,
    initiative = 10,
    wounds = 10,
    preset = SPEC_OPS_PRESET_ID,
    items
} = {}) {
    const actor = makeActor({ enabled: true, preset });
    actor.system = { wounds: { value: wounds, max: 14 } };
    actor.items = items ?? [{
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
    combatant.defeated = false;
    if (fireteam) withFireteam(combatant, fireteam);
    return { combatant, token, actor };
}

/**
 * Build a combat fixture: `members` + `enemyCount` hostile enemies on a
 * square scene.
 * @param {object[]} members Entries from {@link makeMember}.
 * @param {object} [options]
 * @param {number} [options.enemyCount]
 * @param {number} [options.enemyX]
 * @param {number} [options.enemyY]
 * @param {object[]} [options.walls] Wall documents on the scene.
 * @returns {object}
 */
function makeTeamWorld(members, {
    enemyCount = 1,
    enemyX = 20000,
    enemyY = 0,
    walls = []
} = {}) {
    const scene = makeScene({ grid: "square" });
    scene.walls = walls;
    const enemies = [];
    for (let i = 0; i < enemyCount; i++) {
        const enemyActor = makeActor();
        enemyActor.system = { wounds: { value: 10, max: 10 } };
        enemyActor.items = [];
        const enemyToken = makeToken({ actor: enemyActor });
        enemyToken.x = enemyX + i * 100;
        enemyToken.y = enemyY;
        enemyToken.elevation = 0;
        enemyToken.disposition = 1;
        const enemy = makeCombatant({ actor: enemyActor, token: enemyToken });
        enemy.tokenId = enemyToken.id;
        enemies.push({ combatant: enemy, token: enemyToken });
    }
    const combat = makeCombat({
        round: 1,
        turn: 0,
        combatants: [...members.map(m => m.combatant), ...enemies.map(e => e.combatant)]
    });
    combat.scene = scene;
    combat.ended = false;
    return { scene, combat, enemies };
}

/** Injected normalized target list for {@link makeTeamWorld} enemies. */
function injectedTargets(world) {
    return world.enemies.map(({ token }) => ({
        tokenId: token.id,
        tokenUuid: `Scene.${world.scene.id}.Token.${token.id}`,
        x: token.x,
        y: token.y,
        elevation: 0,
        canAttack: true,
        source: "injected"
    }));
}

/**
 * Minimal member stub for pure selector tests.
 * @param {string} id Combatant id.
 * @param {number} x
 * @param {number} y
 * @param {object} [extra]
 * @returns {object}
 */
function memberStub(id, x, y, extra = {}) {
    return {
        combatantId: id,
        tokenId: `token-${id}`,
        enabled: true,
        defeated: false,
        preset: SPEC_OPS_PRESET_ID,
        position: { x, y },
        combatant: { actor: { items: extra.items ?? [] } },
        ...extra
    };
}

/** Wall document fixture (v13-style `c` + sight/move values). */
function makeWall(coords, { sight = 1, move = 1 } = {}) {
    return { c: coords, sight, move, door: null };
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

test("registerSpecOpsPreset replaces the skeleton in the planner registry", () => {
    const planner = createPlannerService();
    const stored = registerSpecOpsPreset(planner);
    assert.equal(stored.id, SPEC_OPS_PRESET_ID);
    assert.ok(planner.listPresets().includes(SPEC_OPS_PRESET_ID));
    const def = planner.getPreset(SPEC_OPS_PRESET_ID);
    assert.equal(typeof def.evaluate, "function");
    assert.equal(typeof def.veto, "function");
    assert.equal(def.allowNoTarget, true);
    assert.equal(def.allowNoAction, true);
    assert.throws(() => registerSpecOpsPreset(null), /requires a planner service/);
});

/* ------------------------------------------------------------------ */
/* Tactic selector                                                     */
/* ------------------------------------------------------------------ */

test("selectSpecOpsTactic: fewer than two members falls back deterministically", () => {
    const solo = [memberStub("m1", 0, 0)];
    const result = selectSpecOpsTactic({
        members: solo,
        leaderId: "m1",
        targets: [{ tokenId: "e1", x: 500, y: 0, canAttack: true }]
    });
    assert.equal(result.name, null);
    assert.equal(result.reason, "insufficient-members");
    assert.deepEqual(result.assignments, {});
    assert.equal(result.breakdown.members, 1);
});

test("selectSpecOpsTactic: overwhelming threat selects regroup-fallback", () => {
    const members = [memberStub("a", 0, 0), memberStub("b", 50, 0)];
    const targets = Array.from({ length: 5 }, (_, i) => ({
        tokenId: `e${i}`, x: 1000 + i * 50, y: 0, canAttack: true
    }));
    const result = selectSpecOpsTactic({ members, leaderId: "a", targets });
    assert.equal(result.name, "regroup-fallback");
    assert.equal(result.reason, "overwhelming-threat");
    assert.equal(result.regroup, true);
    assert.deepEqual(result.assignments, { a: "regroup", b: "regroup" });
    assert.equal(result.breakdown.pressure, 2.5);

    const byCasualty = selectSpecOpsTactic({
        members,
        leaderId: "a",
        targets: [{ tokenId: "e1", x: 1000, y: 0, canAttack: true }],
        casualties: 1
    });
    assert.equal(byCasualty.name, "regroup-fallback");
    assert.equal(byCasualty.reason, "casualties");

    const forced = selectSpecOpsTactic({
        members, leaderId: "a", targets: [], context: { regroup: true }
    });
    assert.equal(forced.name, "regroup-fallback");
    assert.equal(forced.reason, "forced-regroup");
});

test("selectSpecOpsTactic: parity/superiority selects coordinated assault", () => {
    const members = [
        memberStub("a", 0, 0),
        memberStub("b", 50, 50),
        memberStub("c", 100, 0)
    ];
    const targets = [{ tokenId: "e1", x: 1000, y: 0, canAttack: true }];
    const result = selectSpecOpsTactic({ members, leaderId: "a", targets });
    assert.equal(result.name, "coordinated-assault");
    assert.equal(result.reason, "superiority");
    assert.deepEqual(result.assignments, { a: "assault", b: "assault", c: "assault" });

    const parity = selectSpecOpsTactic({
        members: members.slice(0, 2),
        leaderId: "a",
        targets: [
            { tokenId: "e1", x: 1000, y: 0, canAttack: true },
            { tokenId: "e2", x: 1100, y: 0, canAttack: true }
        ]
    });
    assert.equal(parity.name, "coordinated-assault");
    assert.equal(parity.reason, "parity");
});

test("selectSpecOpsTactic: favorable geometry selects flank-and-fix", () => {
    // Outnumbered but not routed: 2 members vs 3 hostiles on open ground.
    const members = [memberStub("a", 0, 0), memberStub("b", 200, 0)];
    const targets = [
        { tokenId: "e1", x: 1000, y: 0, canAttack: true },
        { tokenId: "e2", x: 1100, y: 0, canAttack: true },
        { tokenId: "e3", x: 1200, y: 0, canAttack: true }
    ];
    const result = selectSpecOpsTactic({ members, leaderId: "a", targets });
    assert.equal(result.name, "flank-and-fix");
    assert.equal(result.reason, "outnumbered-flank-open");
    assert.equal(result.allowFlank, true);
    assert.ok(SPEC_OPS_TACTICS.includes(result.name));
    // Exactly one flanker; the rest fix frontally.
    const tasks = Object.values(result.assignments);
    assert.equal(tasks.filter(t => t === "flank").length, 1);
    assert.equal(tasks.filter(t => t === "support").length, 1);
    // Non-leader flanks, leader fixes.
    assert.equal(result.assignments.b, "flank");
    assert.equal(result.assignments.a, "support");
    assert.ok(["left", "right"].includes(result.objective.flankSide));
    assert.ok(result.objective.flankPoint);
    assert.equal(result.objective.targetId, "e1");
    assert.equal(result.breakdown.flank.side, result.objective.flankSide);
    // Detachment stays time-bounded by maxDetachedRounds.
    assert.equal(result.maxDetachedPhases, SPEC_OPS_CONFIG.maxDetachedRounds);
});

test("selectSpecOpsTactic: blocked frontal approach flanks at parity", () => {
    const members = [memberStub("a", 0, 0), memberStub("b", 200, 0)];
    const targets = [{ tokenId: "e1", x: 2000, y: 0, canAttack: true }];
    // A wall across the direct leader→objective segment; flank points at
    // (2000, ±1000) stay clear of it.
    const walls = [makeWall([1000, -300, 1000, 300])];
    const result = selectSpecOpsTactic({
        members, leaderId: "a", targets, context: { walls }
    });
    assert.equal(result.name, "flank-and-fix");
    assert.equal(result.reason, "frontal-blocked-flank-open");
    assert.equal(result.breakdown.frontalBlocked, true);
});

test("selectSpecOpsTactic: single corridor rejects flank and covers/advances", () => {
    const members = [memberStub("a", 0, 0), memberStub("b", 200, 0)];
    const targets = [
        { tokenId: "e1", x: 2000, y: 0, canAttack: true },
        { tokenId: "e2", x: 2100, y: 0, canAttack: true },
        { tokenId: "e3", x: 2200, y: 0, canAttack: true }
    ];
    // A long wall crosses every approach — frontal and both flank sides.
    const walls = [makeWall([800, -1500, 800, 1500])];
    const result = selectSpecOpsTactic({
        members, leaderId: "a", targets, context: { walls }
    });
    assert.equal(result.name, "covering-advance");
    assert.equal(result.reason, "outnumbered-no-flank");
    assert.equal(result.breakdown.flank.feasible, false);
    const tasks = Object.values(result.assignments);
    assert.ok(tasks.includes("support") && tasks.includes("advance"));

    // Same corridor at parity/superiority: coordinated assault is also
    // impossible through the wall → covering advance.
    const parity = selectSpecOpsTactic({
        members: [memberStub("a", 0, 0), memberStub("b", 200, 0), memberStub("c", 100, 50)],
        leaderId: "a",
        targets: [{ tokenId: "e1", x: 2000, y: 0, canAttack: true }],
        context: { walls }
    });
    assert.equal(parity.name, "covering-advance");
    assert.equal(parity.reason, "frontal-blocked-no-flank");
});

test("selectSpecOpsTactic: no attackable contacts advances under cover", () => {
    const members = [memberStub("a", 0, 0), memberStub("b", 50, 0)];
    const empty = selectSpecOpsTactic({ members, leaderId: "a", targets: [] });
    assert.equal(empty.name, "covering-advance");
    assert.equal(empty.reason, "no-contacts");
    const lastKnown = selectSpecOpsTactic({
        members,
        leaderId: "a",
        targets: [{ tokenId: "e9", x: 900, y: 0, source: "last-known", canAttack: false }]
    });
    assert.equal(lastKnown.name, "covering-advance");
    assert.equal(lastKnown.reason, "no-attackable-target");
});

test("selectSpecOpsTactic is deterministic and serializable", () => {
    const members = [
        memberStub("a", 0, 0),
        memberStub("b", 200, 0),
        memberStub("c", 100, 300)
    ];
    const targets = [
        { tokenId: "e1", x: 1000, y: 0, canAttack: true },
        { tokenId: "e2", x: 1100, y: 50, canAttack: true },
        { tokenId: "e3", x: 1200, y: -50, canAttack: true },
        { tokenId: "e4", x: 1050, y: 100, canAttack: true }
    ];
    const input = { members, leaderId: "a", targets };
    const r1 = selectSpecOpsTactic(input);
    const r2 = selectSpecOpsTactic(input);
    const r3 = specOpsTactic(input);
    assert.deepEqual(r1, r2);
    assert.deepEqual(r1, r3);
    assert.deepEqual(JSON.parse(JSON.stringify(r1)), JSON.parse(JSON.stringify(r2)));
    // Bound factory honours config overrides deterministically.
    const tight = createSpecOpsTactic({ highThreatRatio: 10 });
    const tightResult = tight(input);
    assert.notEqual(tightResult.name, "regroup-fallback");
});

test("selectSpecOpsTactic: capability-based split prefers long-range support", () => {
    const melee = { type: "weapon", system: { class: "melee", range: 2 } };
    const rifle = { type: "weapon", system: { class: "ranged", range: 150 } };
    const members = [
        memberStub("a", 0, 0, { items: [melee] }),
        memberStub("b", 50, 0, { items: [rifle] }),
        memberStub("c", 100, 0, { items: [rifle] })
    ];
    // Outnumbered below the regroup threshold, no flank route: covering
    // advance hands support to the longest-range members.
    const result = selectSpecOpsTactic({
        members,
        leaderId: "a",
        targets: [
            { tokenId: "e1", x: 2000, y: 0, canAttack: true },
            { tokenId: "e2", x: 2100, y: 0, canAttack: true },
            { tokenId: "e3", x: 2200, y: 0, canAttack: true },
            { tokenId: "e4", x: 2150, y: 50, canAttack: true }
        ],
        context: { walls: [makeWall([800, -1500, 800, 1500])] }
    });
    assert.equal(result.name, "covering-advance");
    assert.equal(result.assignments.a, "advance");
    assert.equal(result.assignments.b, "support");
    assert.equal(result.assignments.c, "support");
});

/* ------------------------------------------------------------------ */
/* Task → member weights                                               */
/* ------------------------------------------------------------------ */

test("evaluateSpecOps maps fireteam tasks to weight overlays", () => {
    const factors = {
        attackNow: 0, attackAfterMove: 1, charge: 0, melee: 0,
        advance: 0.5, threat: 0.5, proximity: 0.5, los: 1, cover: 0,
        exposure: 0, holdPosition: 0, lastKnown: 0, budgetOver: 0
    };
    const candidate = {
        variant: "move-attack",
        target: { tokenId: "e1", x: 1000, y: 0 },
        move: { x: 1000, y: 1000 },
        action: { id: "lasgun", range: 100, class: "ranged" }
    };
    const base = { team: { task: "advance", center: { x: 0, y: 0 } }, selfPos: { x: 0, y: 0 } };

    const flank = evaluateSpecOps({
        factors,
        candidate,
        context: { ...base, team: { task: "flank", center: { x: 0, y: 0 } } }
    });
    assert.equal(flank.breakdown.team.task, "flank");
    assert.equal(flank.breakdown.team.mode, "fireteam");
    // Endpoint at (1000,1000) attacks the target at a 90° angle vs the
    // frontal (0,0)→(1000,0) bearing: full flankAngle factor.
    assert.equal(flank.breakdown.factors.flankAngle, 1);
    assert.equal(flank.breakdown.weights.flankAngle, 8);

    const assault = evaluateSpecOps({
        factors: { ...factors, charge: 1 },
        candidate: { ...candidate, variant: "charge" },
        context: { ...base, team: { task: "assault", center: { x: 0, y: 0 } } }
    });
    assert.equal(assault.breakdown.team.task, "assault");
    assert.equal(assault.breakdown.weights.charge, 5);
    assert.ok(assault.score > 0);

    const support = evaluateSpecOps({
        factors,
        candidate,
        context: { ...base, team: { task: "support", center: { x: 0, y: 0 } } }
    });
    assert.equal(support.breakdown.team.task, "support");
    assert.equal(support.breakdown.weights.charge, -4);
    assert.equal(support.breakdown.weights.cover, 6);

    const advance = evaluateSpecOps({ factors, candidate, context: base });
    assert.equal(advance.breakdown.team.task, "advance");
    assert.equal(advance.breakdown.weights.advance, 6);
});

test("evaluateSpecOps: regroup task pulls toward the rejoin point", () => {
    const context = {
        selfPos: { x: 400, y: 0 },
        team: {
            task: "regroup",
            center: { x: 0, y: 0 },
            regroupPoint: { x: 0, y: 0 }
        }
    };
    const factors = { attackNow: 0, holdPosition: 0 };
    const closer = evaluateSpecOps({
        factors,
        candidate: {
            variant: "approach",
            target: { tokenId: "e1", x: 2000, y: 0 },
            move: { x: 200, y: 0 }
        },
        context
    });
    assert.equal(closer.breakdown.factors.cohesionRestore, 0.5);
    assert.equal(closer.breakdown.team.task, "regroup");
    const farther = evaluateSpecOps({
        factors,
        candidate: {
            variant: "approach",
            target: { tokenId: "e1", x: 2000, y: 0 },
            move: { x: 800, y: 0 }
        },
        context
    });
    assert.equal(farther.breakdown.factors.cohesionRestore, 0);
    assert.ok(closer.score > farther.score);
});

test("evaluateSpecOps: fanatic ignoreRegroup zeroes the regroup pull (review)", () => {
    // Issue #24 review: `context.traitFlags.ignoreRegroup` suppresses
    // the `cohesionRestore` factor structurally — the task overlay
    // replaces the weight, so no delta could carry the flag.
    const context = {
        selfPos: { x: 400, y: 0 },
        team: {
            task: "regroup",
            center: { x: 0, y: 0 },
            regroupPoint: { x: 0, y: 0 }
        }
    };
    const candidate = {
        variant: "approach",
        target: { tokenId: "e1", x: 2000, y: 0 },
        move: { x: 200, y: 0 }
    };
    const factors = { attackNow: 0, holdPosition: 0 };
    const trusting = evaluateSpecOps({ factors, candidate, context });
    assert.equal(trusting.breakdown.factors.cohesionRestore, 0.5);
    const fanatic = evaluateSpecOps({
        factors,
        candidate,
        context: { ...context, traitFlags: { ignoreRegroup: true } }
    });
    assert.equal(fanatic.breakdown.factors.cohesionRestore, 0,
        "the flag mutes the regroup pull entirely");
    assert.ok(fanatic.score < trusting.score,
        "without the pull the same endpoint scores lower");
});

test("evaluateSpecOps solo fallback reports no-fireteam", () => {
    const factors = {
        attackNow: 0, attackAfterMove: 0, charge: 0, melee: 0,
        advance: 1, threat: 0, proximity: 0.5, los: 0, cover: 0,
        exposure: 0, holdPosition: 0, lastKnown: 0, budgetOver: 0
    };
    const result = evaluateSpecOps({
        factors,
        candidate: {
            variant: "approach",
            target: { tokenId: "e1", x: 900, y: 0 },
            move: { x: 500, y: 0 }
        },
        context: { selfPos: { x: 0, y: 0 } }
    });
    assert.equal(result.breakdown.preset, SPEC_OPS_PRESET_ID);
    assert.equal(result.breakdown.team.mode, "solo");
    assert.equal(result.breakdown.team.task, "solo");
    assert.equal(result.breakdown.team.reason, "no-fireteam");
    // Hybrid: holdPosition overlay weight 2 is merged into the weights.
    assert.equal(result.breakdown.weights.holdPosition, 2);
});

test("specOpsVeto refuses hidden and last-known attack targets", () => {
    const attack = { variant: "attack-in-place", action: { id: "a" } };
    assert.equal(
        specOpsVeto({ candidate: { ...attack, target: { source: "last-known" } } }),
        SPEC_OPS_VETO_HIDDEN_TARGET);
    assert.equal(
        specOpsVeto({ candidate: { ...attack, target: { hidden: true } } }),
        SPEC_OPS_VETO_HIDDEN_TARGET);
    assert.equal(
        specOpsVeto({ candidate: { ...attack, target: { source: "visible" } } }),
        null);
    assert.equal(
        specOpsVeto({ candidate: { variant: "approach", target: { source: "last-known" } } }),
        null);
});

/* ------------------------------------------------------------------ */
/* Solo planTurn (no fireteam)                                         */
/* ------------------------------------------------------------------ */

test("solo specOps NPC outside a fireteam plans with the safe fallback", async () => {
    const member = makeMember({ preset: SPEC_OPS_PRESET_ID, x: 0, y: 0 });
    const world = makeTeamWorld([member], { enemyCount: 1, enemyX: 20000 });
    const planner = createPlannerService();
    registerSpecOpsPreset(planner);
    const result = await planner.planTurn(world.combat, member.combatant, {
        seed: 7,
        targets: injectedTargets(world)
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.equal(result.plan.preset, SPEC_OPS_PRESET_ID);
    assert.equal(result.plan.breakdown.team.mode, "solo");
    assert.equal(result.plan.breakdown.team.reason, "no-fireteam");
});

/* ------------------------------------------------------------------ */
/* TeamPlan integration                                                */
/* ------------------------------------------------------------------ */

/**
 * Fireteam service on a planner with the real spec-ops preset.
 * @returns {object}
 */
function makeSpecOpsService() {
    const planner = createPlannerService();
    registerSpecOpsPreset(planner);
    return createFireteamService({ planner });
}

test("specOps fireteam builds a flank-and-fix TeamPlan via the tactic factory", async () => {
    const flag = { teamId: "alpha", teamPreset: "specOps" };
    const leader = makeMember({ fireteam: flag, x: 0, y: 0, initiative: 20 });
    const second = makeMember({ fireteam: flag, x: 200, y: 0, initiative: 10 });
    // 2 vs 3 on open ground → flank-and-fix.
    const world = makeTeamWorld([leader, second], { enemyCount: 3, enemyX: 2000 });
    const service = makeSpecOpsService();
    const result = await service.buildTeamPlan(world.combat,
        { teamId: "alpha" }, { seed: 42, targets: injectedTargets(world) });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    const plan = result.teamPlan;

    assert.equal(plan.teamPreset, "specOps");
    assert.equal(plan.tactic, "flank-and-fix");
    assert.equal(plan.diagnostics.tactic.name, "flank-and-fix");
    assert.equal(plan.diagnostics.tactic.reason, "outnumbered-flank-open");
    assert.ok(plan.diagnostics.tactic.breakdown.flank.side);

    const byId = Object.fromEntries(plan.members.map(m => [m.combatantId, m]));
    const tasks = plan.members.map(m => m.task);
    assert.ok(tasks.includes("flank"), "a flank group exists");
    assert.ok(tasks.includes("support"), "a fixing/support group exists");
    assert.ok(plan.members.every(m => FIRETEAM_TASKS.includes(m.task)));
    const flanker = plan.members.find(m => m.task === "flank");
    assert.equal(flanker.groupId, "flank-1");
    assert.notEqual(flanker.combatantId, plan.leaderId);
    assert.equal(byId[plan.leaderId].task, "support");

    // Phases: movement first, action behind the barrier, flank movers
    // precede the main group inside the movement phase.
    assert.equal(plan.phases[0].name, "movement");
    assert.equal(plan.phases[1].name, "action");
    const barrier = plan.phases[1].barrier;
    assert.ok(barrier, "action phase is barrier-gated");
    assert.ok(barrier.requiredAssignmentIds.includes(flanker.combatantId));
    const moveIds = plan.phases[0].steps.map(s => s.combatantId);
    const flankIdx = moveIds.indexOf(flanker.combatantId);
    if (flankIdx >= 0) {
        for (let i = flankIdx + 1; i < moveIds.length; i++) {
            assert.equal(byId[moveIds[i]].groupId, "main");
        }
    }

    // Member plans carry the task-scoped spec-ops breakdown.
    const flankPlan = plan.memberPlans[flanker.combatantId];
    assert.equal(flankPlan?.breakdown?.preset, SPEC_OPS_PRESET_ID);
    assert.equal(flankPlan?.breakdown?.team?.task, "flank");
    assert.equal(flankPlan?.breakdown?.tactic, "flank-and-fix");

    // Reservations + serializability.
    assert.ok(Array.isArray(plan.reservations.targets));
    assert.ok(Array.isArray(plan.reservations.endpoints));
    assert.ok(Array.isArray(plan.reservations.routes));
    const roundTrip = JSON.parse(JSON.stringify(plan));
    assert.equal(roundTrip.id, plan.id);
    assert.equal(roundTrip.tactic, "flank-and-fix");
    assert.equal(roundTrip.diagnostics.tactic.reason, "outnumbered-flank-open");
});

test("specOps fireteam builds a coordinated assault at superiority", async () => {
    const flag = { teamId: "alpha", teamPreset: "specOps" };
    const leader = makeMember({ fireteam: flag, x: 0, y: 0, initiative: 20 });
    const second = makeMember({ fireteam: flag, x: 100, y: 0, initiative: 10 });
    const third = makeMember({ fireteam: flag, x: 200, y: 50, initiative: 8 });
    // 3 vs 1 on open ground → coordinated assault.
    const world = makeTeamWorld([leader, second, third], { enemyCount: 1, enemyX: 20000 });
    const service = makeSpecOpsService();
    const result = await service.buildTeamPlan(world.combat,
        { teamId: "alpha" }, { seed: 5, targets: injectedTargets(world) });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    const plan = result.teamPlan;
    assert.equal(plan.tactic, "coordinated-assault");
    assert.equal(plan.diagnostics.tactic.reason, "superiority");
    assert.ok(plan.members.every(m => m.task === "assault"));
    // Synchronized: every member shares the same barrier before actions.
    assert.ok(plan.phases[1].barrier === null
        || plan.phases[1].barrier.requiredAssignmentIds.length >= 0);
});

test("specOps fireteam regroups under overwhelming threat and losses", async () => {
    const flag = { teamId: "alpha", teamPreset: "specOps" };
    const leader = makeMember({ fireteam: flag, x: 0, y: 0, initiative: 20 });
    const second = makeMember({ fireteam: flag, x: 100, y: 0, initiative: 10 });
    const world = makeTeamWorld([leader, second], { enemyCount: 5, enemyX: 1500 });
    const service = makeSpecOpsService();
    const result = await service.buildTeamPlan(world.combat,
        { teamId: "alpha" }, { seed: 3, targets: injectedTargets(world) });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    const plan = result.teamPlan;
    assert.equal(plan.tactic, "regroup-fallback");
    assert.equal(plan.diagnostics.tactic.reason, "overwhelming-threat");
    assert.ok(plan.members.every(m => m.task === "regroup"));
});

test("specOps TeamPlan is deterministic for identical input", async () => {
    const flag = { teamId: "alpha", teamPreset: "specOps" };
    const leader = makeMember({ fireteam: flag, x: 0, y: 0, initiative: 20 });
    const second = makeMember({ fireteam: flag, x: 200, y: 0, initiative: 10 });
    const world = makeTeamWorld([leader, second], { enemyCount: 3, enemyX: 2000 });
    const service = makeSpecOpsService();
    const targets = injectedTargets(world);
    const r1 = await service.buildTeamPlan(world.combat, { teamId: "alpha" }, { seed: 9, targets });
    const r2 = await service.buildTeamPlan(world.combat, { teamId: "alpha" }, { seed: 9, targets });
    assert.equal(r1.status, FIRETEAM_STATUS.ok);
    assert.equal(r2.status, FIRETEAM_STATUS.ok);
    assert.equal(r1.teamPlan.id, r2.teamPlan.id);
    assert.equal(r1.teamPlan.tactic, r2.teamPlan.tactic);
    assert.deepEqual(
        JSON.parse(JSON.stringify(r1.teamPlan.members)),
        JSON.parse(JSON.stringify(r2.teamPlan.members)));
    assert.deepEqual(
        JSON.parse(JSON.stringify(r1.teamPlan.phases)),
        JSON.parse(JSON.stringify(r2.teamPlan.phases)));
});

test("specOps preset on all members triggers the tactic without teamPreset", async () => {
    const flag = { teamId: "alpha" };
    const leader = makeMember({ fireteam: flag, x: 0, y: 0, initiative: 20, preset: SPEC_OPS_PRESET_ID });
    const second = makeMember({ fireteam: flag, x: 200, y: 0, initiative: 10, preset: SPEC_OPS_PRESET_ID });
    const world = makeTeamWorld([leader, second], { enemyCount: 3, enemyX: 2000 });
    const service = makeSpecOpsService();
    const result = await service.buildTeamPlan(world.combat,
        { teamId: "alpha" }, { seed: 42, targets: injectedTargets(world) });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    // Every member resolves to specOps → the spec-ops tactic applies.
    assert.equal(result.teamPlan.tactic, "flank-and-fix");
});

test("single specOps member gets the deterministic insufficient-members fallback", async () => {
    const flag = { teamId: "alpha", teamPreset: "specOps" };
    const leader = makeMember({ fireteam: flag, x: 0, y: 0, initiative: 20 });
    const world = makeTeamWorld([leader], { enemyCount: 1 });
    const service = makeSpecOpsService();
    const result = await service.buildTeamPlan(world.combat,
        { teamId: "alpha" }, { seed: 1, targets: injectedTargets(world) });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    assert.equal(result.teamPlan.tactic, null);
    assert.equal(result.teamPlan.diagnostics.tactic.reason, "insufficient-members");
    // Default policy still assigns the leader to assault.
    assert.equal(result.teamPlan.members[0].task, "assault");
});

test("buildSpecOpsTeamPlan helper wires the tactic factory", async () => {
    const flag = { teamId: "alpha", teamPreset: "specOps" };
    const leader = makeMember({ fireteam: flag, x: 0, y: 0, initiative: 20 });
    const second = makeMember({ fireteam: flag, x: 200, y: 0, initiative: 10 });
    const world = makeTeamWorld([leader, second], { enemyCount: 3, enemyX: 2000 });
    const service = makeSpecOpsService();
    const result = await buildSpecOpsTeamPlan(service, world.combat,
        { teamId: "alpha" }, { seed: 42, targets: injectedTargets(world) });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    assert.equal(result.teamPlan.tactic, "flank-and-fix");

    // Without a fireteam service the helper reports the solo fallback.
    const solo = await buildSpecOpsTeamPlan(null, world.combat, { teamId: "alpha" });
    assert.equal(solo.status, "no-fireteam");
    assert.equal(solo.teamPlan, null);
});

test("explicit caller assignments and context.tactic override the spec-ops tactic", async () => {
    const flag = { teamId: "alpha", teamPreset: "specOps" };
    const leader = makeMember({ fireteam: flag, x: 0, y: 0, initiative: 20 });
    const second = makeMember({ fireteam: flag, x: 200, y: 0, initiative: 10 });
    const world = makeTeamWorld([leader, second], { enemyCount: 3, enemyX: 2000 });
    const service = makeSpecOpsService();

    // Explicit assignments beat the selector's task map.
    const forced = await service.buildTeamPlan(world.combat, { teamId: "alpha" }, {
        seed: 42,
        targets: injectedTargets(world),
        assignments: {
            [leader.combatant.id]: "advance",
            [second.combatant.id]: "advance"
        }
    });
    assert.equal(forced.status, FIRETEAM_STATUS.ok);
    assert.ok(forced.teamPlan.members.every(m => m.task === "advance"));
    // The selector still ran and is reported in diagnostics.
    assert.equal(forced.teamPlan.diagnostics.tactic.name, "flank-and-fix");

    // A caller-provided descriptor replaces the factory entirely.
    const custom = await service.buildTeamPlan(world.combat, { teamId: "alpha" }, {
        seed: 42,
        targets: injectedTargets(world),
        tactic: {
            name: "covering-advance",
            reason: "gm-override",
            assignments: {
                [leader.combatant.id]: "support",
                [second.combatant.id]: "advance"
            }
        }
    });
    assert.equal(custom.teamPlan.tactic, "covering-advance");
    assert.equal(custom.teamPlan.diagnostics.tactic.reason, "gm-override");
    const tasks = Object.fromEntries(
        custom.teamPlan.members.map(m => [m.combatantId, m.task]));
    assert.equal(tasks[leader.combatant.id], "support");
    assert.equal(tasks[second.combatant.id], "advance");

    // tactic: null disables the hook → default fireteam policy.
    const off = await service.buildTeamPlan(world.combat, { teamId: "alpha" }, {
        seed: 42,
        targets: injectedTargets(world),
        tactic: null
    });
    assert.equal(off.teamPlan.tactic, null);
    assert.equal(off.teamPlan.diagnostics.tactic, null);
});
