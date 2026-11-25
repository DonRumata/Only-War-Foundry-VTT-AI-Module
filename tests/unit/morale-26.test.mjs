/**
 * Unit tests for the L2 morale layer (issue #26): fireteam counters and
 * the evaluated morale record, hysteresis and the forced leader-loss
 * transition, member-effective tiers via the `fanatic`/`cowardly` trait
 * exceptions, task remapping and posture weight shifts, commitment
 * invalidation on a tier change, intent telegraphing (preview view-model,
 * overlay marker) and the chat barks.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    DEFAULT_PREFERRED_COHESION,
    FLAG_KEYS,
    MODULE_ID,
    MORALE_DEFAULT_TIER,
    MORALE_HYSTERESIS_ROUNDS,
    SETTING_KEYS
} from "../../scripts/constants.js";
import {
    applyMoraleLayer,
    applyMoraleWeightShift,
    COMMITMENT_REASONS,
    effectiveMoraleTier,
    evaluateMoraleRecord,
    isEvaluatedMoraleRecord,
    moralePostureOf,
    moraleSpaceControl,
    moraleTierOf,
    planIntentOf,
    proposeMoraleTier,
    readMoraleRecord,
    sanitizeMoraleRecord,
    validateCommitment
} from "../../scripts/layers.js";
import {
    DEFAULT_PRESET_WEIGHTS,
    PLANNER_STATUS,
    createPlannerService
} from "../../scripts/planner.js";
import {
    FIRETEAM_STATUS,
    createFireteamService
} from "../../scripts/fireteam.js";
import { EXECUTOR_STATUS, createExecutorService } from "../../scripts/executor.js";
import { createModuleApi } from "../../scripts/api.js";
import { registerSettings } from "../../scripts/settings.js";
import {
    buildPreviewViewModel,
    localizePreviewViewModel
} from "../../scripts/ui/preview-dialog.js";
import { buildPlanOverlayModel } from "../../scripts/ui/plan-overlay.js";
import {
    makeActor,
    makeCombatant,
    makeScene,
    makeToken
} from "./fixtures.mjs";

let _combatId = 0;

/** Minimal Combat fixture (mirrors the fireteam tests). */
function makeCombat({ round = 1, turn = 0, combatants = [] } = {}) {
    const collection = new Map(combatants.map(c => [c.id, c]));
    collection.contents = combatants;
    return {
        documentName: "Combat",
        id: `morale-combat-${++_combatId}`,
        round,
        turn,
        combatants: collection,
        turns: combatants,
        scene: null,
        ended: false
    };
}

/** Attach a fireteam flag to a fixture document. */
function withFireteam(doc, flag) {
    doc.flags[MODULE_ID] = doc.flags[MODULE_ID] ?? {};
    doc.flags[MODULE_ID][FLAG_KEYS.fireteam] = flag;
    return doc;
}

/** AI-enabled NPC combatant carrying a fireteam flag (mirrors #408 tests). */
function makeMember({
    fireteam,
    x = 0,
    y = 0,
    initiative = 10,
    wounds = 10,
    preset = "assault",
    defeated = false,
    statuses = null
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
    if (statuses) actor.statuses = statuses;
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
 * Team world: `members` plus `enemyCount` hostiles on a square scene.
 * @param {object[]} members Entries from {@link makeMember}.
 * @param {object} [options]
 * @param {number} [options.enemyCount]
 * @param {number} [options.round]
 * @returns {object}
 */
function makeTeamWorld(members, { enemyCount = 1, round = 1 } = {}) {
    const scene = makeScene({ grid: "square" });
    const enemies = [];
    for (let i = 0; i < enemyCount; i++) {
        const enemyActor = makeActor();
        enemyActor.system = { wounds: { value: 0, max: 10 } };
        enemyActor.items = [];
        const enemyToken = makeToken({ actor: enemyActor });
        enemyToken.x = 2000 + (i * 100);
        enemyToken.y = 0;
        enemyToken.elevation = 0;
        enemyToken.disposition = 1;
        const enemy = makeCombatant({ actor: enemyActor, token: enemyToken });
        enemy.tokenId = enemyToken.id;
        enemies.push({ combatant: enemy, token: enemyToken });
    }
    const combat = makeCombat({
        round,
        turn: 0,
        combatants: [...members.map(m => m.combatant), ...enemies.map(e => e.combatant)]
    });
    combat.scene = scene;
    return { scene, combat, enemies };
}

/** Injected target list for {@link makeTeamWorld} enemies. */
function injectedTargets(world) {
    return world.enemies.map(e => ({
        tokenId: e.token.id,
        tokenUuid: `Scene.${world.scene.id}.Token.${e.token.id}`,
        x: e.token.x,
        y: e.token.y,
        elevation: 0,
        canAttack: true,
        source: "injected"
    }));
}

/** Morale flag of a member combatant. */
function moraleFlag(combatant) {
    return combatant.flags[MODULE_ID]?.[FLAG_KEYS.morale] ?? null;
}

/** Stub `ChatMessage` capture; returns the messages array. */
function captureChat() {
    const messages = [];
    globalThis.ChatMessage = {
        create: async data => { messages.push(data); return data; }
    };
    return messages;
}

/* ------------------------------------------------------------------ */
/* Counters → tier proposal                                            */
/* ------------------------------------------------------------------ */

test("proposeMoraleTier: headcount, losses, pinned and space drive the tier", () => {
    // Confident: numeric edge, no fresh losses, space held.
    assert.equal(proposeMoraleTier({ members: 3, enemies: 1 }), "confident");
    assert.equal(proposeMoraleTier({
        members: 3, enemies: 1, spaceControl: 0.8
    }), "confident");
    // Pressured: parity is the baseline.
    assert.equal(proposeMoraleTier({ members: 3, enemies: 3 }), "pressured");
    assert.equal(proposeMoraleTier({ members: 0, enemies: 0 }), "pressured");
    // Confident is blocked by fresh losses or a collapsing front.
    assert.equal(proposeMoraleTier({
        members: 3, enemies: 1, casualtiesRecent: 1
    }), "pressured");
    assert.equal(proposeMoraleTier({
        members: 3, enemies: 1, spaceControl: 0.4
    }), "pressured");
    // Desperate: outnumbered at the default 2:1 ratio — a smaller
    // numerical edge stays pressured (5v6 is the squad's normal war).
    assert.equal(proposeMoraleTier({ members: 5, enemies: 6 }), "pressured");
    assert.equal(proposeMoraleTier({ members: 5, enemies: 9 }), "pressured");
    assert.equal(proposeMoraleTier({ members: 5, enemies: 10 }), "desperate");
    assert.equal(proposeMoraleTier({ members: 2, enemies: 4 }), "desperate");
    // GM-tunable: ratio 1 restores "any deficit is desperate", a
    // looser 3 needs a 3:1 deficit.
    assert.equal(proposeMoraleTier({ members: 5, enemies: 6 },
        { outnumberRatio: 1 }), "desperate");
    assert.equal(proposeMoraleTier({ members: 5, enemies: 10 },
        { outnumberRatio: 3 }), "pressured");
    // …half the starting strength gone…
    assert.equal(proposeMoraleTier({
        members: 3, enemies: 1, casualties: 2, initialStrength: 4
    }), "desperate");
    // …repeated recent losses…
    assert.equal(proposeMoraleTier({
        members: 3, enemies: 1, casualtiesRecent: 2
    }), "desperate");
    // …everyone pinned…
    assert.equal(proposeMoraleTier({
        members: 2, enemies: 1, pinned: 2
    }), "desperate");
    // …or the ground is lost.
    assert.equal(proposeMoraleTier({
        members: 3, enemies: 1, spaceControl: 0.2
    }), "desperate");
});

test("moraleSpaceControl shares the safe cells of the sampled points", () => {
    const points = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    const dangerAt = p => (p.x === 0 ? 0.1 : 0.9);
    assert.equal(moraleSpaceControl(points, dangerAt), 0.5);
    assert.equal(moraleSpaceControl(points, () => 0.1), 1);
    assert.equal(moraleSpaceControl([], dangerAt), null);
    assert.equal(moraleSpaceControl(points, null), null);
});

/* ------------------------------------------------------------------ */
/* Record + hysteresis                                                 */
/* ------------------------------------------------------------------ */

test("evaluateMoraleRecord: hysteresis — one round holds the tier, two commit", () => {
    // Round 1: the proposal flips to desperate but the tier holds.
    const first = evaluateMoraleRecord(null, {
        members: 2, enemies: 4
    }, { round: 1, combatId: "c1", teamId: "alpha", leaderId: "lead" });
    assert.equal(first.tier, MORALE_DEFAULT_TIER);
    assert.deepEqual(first.pending, { tier: "desperate", count: 1 });
    assert.equal(first.counters.enemies, 4);
    // Round 2: the same proposal commits.
    const second = evaluateMoraleRecord(first, {
        members: 2, enemies: 4
    }, { round: 2, combatId: "c1", teamId: "alpha", leaderId: "lead" });
    assert.equal(second.tier, "desperate");
    assert.equal(second.pending, null);
    // Recovery needs the same two-round confirmation.
    const third = evaluateMoraleRecord(second, {
        members: 3, enemies: 1
    }, { round: 3, combatId: "c1", teamId: "alpha", leaderId: "lead" });
    assert.equal(third.tier, "desperate");
    assert.deepEqual(third.pending, { tier: "confident", count: 1 });
    const fourth = evaluateMoraleRecord(third, {
        members: 3, enemies: 1
    }, { round: 4, combatId: "c1", teamId: "alpha", leaderId: "lead" });
    assert.equal(fourth.tier, "confident");
    // A one-round blip never moves the tier.
    const blip = evaluateMoraleRecord(fourth, {
        members: 1, enemies: 5
    }, { round: 5, combatId: "c1", teamId: "alpha", leaderId: "lead" });
    assert.equal(blip.tier, "confident");
    const settled = evaluateMoraleRecord(blip, {
        members: 3, enemies: 1
    }, { round: 6, combatId: "c1", teamId: "alpha", leaderId: "lead" });
    assert.equal(settled.tier, "confident");
    assert.equal(settled.pending, null);
    assert.equal(MORALE_HYSTERESIS_ROUNDS, 2);
});

test("evaluateMoraleRecord: a leader loss forces the transition immediately", () => {
    const prev = evaluateMoraleRecord(null, {
        members: 3, enemies: 3
    }, { round: 1, combatId: "c1", teamId: "alpha", leaderId: "old-lead" });
    assert.equal(prev.tier, "pressured");
    // The previous leader is gone (new elected id) — one round is enough
    // even though the proposal needs hysteresis everywhere else.
    const next = evaluateMoraleRecord(prev, {
        members: 2, enemies: 4
    }, { round: 2, combatId: "c1", teamId: "alpha", leaderId: "new-lead" });
    assert.equal(next.tier, "desperate");
    assert.equal(next.counters.leaderDead, true);
    // A leader loss also caps the proposal — never confident.
    const capped = evaluateMoraleRecord(prev, {
        members: 4, enemies: 0, leaderDead: true
    }, { round: 2, combatId: "c1", teamId: "alpha", leaderId: "new-lead" });
    assert.equal(capped.tier, "pressured");
});

test("evaluateMoraleRecord: the loss log feeds casualtiesRecent", () => {
    const first = evaluateMoraleRecord(null, {
        members: 3, defeated: 1
    }, { round: 1, combatId: "c1", teamId: "alpha", leaderId: "lead" });
    assert.equal(first.counters.casualties, 1);
    assert.equal(first.counters.casualtiesRecent, 1);
    // One more member falls — two losses inside the window propose
    // desperate (counter read, hysteresis still gates the tier).
    const second = evaluateMoraleRecord(first, {
        members: 2, defeated: 2
    }, { round: 2, combatId: "c1", teamId: "alpha", leaderId: "lead" });
    assert.equal(second.counters.casualtiesRecent, 2);
    assert.deepEqual(second.pending, { tier: "desperate", count: 1 });
});

test("sanitizeMoraleRecord keeps legacy stubs and full records readable", () => {
    assert.equal(sanitizeMoraleRecord(null), null);
    assert.equal(sanitizeMoraleRecord({ state: "desperate" }).tier, "desperate");
    assert.equal(sanitizeMoraleRecord({ pressured: true }).tier, "pressured");
    const full = evaluateMoraleRecord(null, { members: 3, enemies: 1 },
        { round: 1, combatId: "c1", teamId: "alpha", leaderId: "lead" });
    const sanitized = sanitizeMoraleRecord(full);
    assert.equal(sanitized.tier, full.tier);
    assert.equal(sanitized.combatId, "c1");
    assert.equal(isEvaluatedMoraleRecord(full), true);
    assert.equal(isEvaluatedMoraleRecord({ state: "desperate" }), false);
    assert.equal(moralePostureOf({ tier: "confident" }).state, "confident");
    assert.equal(moraleTierOf({ tier: "confident" }), "confident");
    assert.equal(moraleTierOf({ state: "confident" }), "confident");
    assert.equal(moraleTierOf(null), null);
});

/* ------------------------------------------------------------------ */
/* Member-effective tier (trait exceptions)                            */
/* ------------------------------------------------------------------ */

test("effectiveMoraleTier: fanatic ignores desperate, cowardly escalates pressured", () => {
    assert.equal(effectiveMoraleTier("desperate", ["fanatic"]), "pressured");
    assert.equal(effectiveMoraleTier("pressured", ["cowardly"]), "desperate");
    assert.equal(effectiveMoraleTier("desperate", ["cowardly"]), "desperate");
    assert.equal(effectiveMoraleTier("confident", ["cowardly"]), "confident");
    assert.equal(effectiveMoraleTier("pressured", []), "pressured");
    assert.equal(effectiveMoraleTier(null, ["fanatic"]), null);
    // The fanatic exception wins ties.
    assert.equal(effectiveMoraleTier("desperate", ["cowardly", "fanatic"]), "pressured");
});

test("applyMoraleLayer reports team tier plus member-effective tier", () => {
    const diagnostics = {};
    const combatant = makeCombatant();
    combatant.flags[MODULE_ID] = { [FLAG_KEYS.morale]: { state: "desperate" } };
    const fanatic = applyMoraleLayer({
        combatant, flags: { morale: true }, diagnostics, traits: ["fanatic"]
    });
    assert.equal(fanatic.tier, "desperate");
    assert.equal(fanatic.effectiveTier, "pressured");
    assert.equal(fanatic.desperate, true);
    assert.equal(fanatic.effective.desperate, false);
    const coward = applyMoraleLayer({
        combatant, flags: { morale: true }, diagnostics, traits: ["cowardly"]
    });
    assert.equal(coward.effectiveTier, "desperate");
    const record = diagnostics.layers.filter(r => r.code === "morale-posture").at(-1);
    assert.equal(record.detail.tier, "desperate");
    assert.equal(record.detail.effectiveTier, "desperate");
    // The flagged `personality` list is the traits fallback.
    combatant.flags[MODULE_ID][FLAG_KEYS.personality] = ["cowardly"];
    const flagged = applyMoraleLayer({
        combatant: makeCombatant({
            actor: makeActor(),
            token: makeToken()
        }),
        flags: { morale: true }, diagnostics
    });
    assert.equal(flagged.tier, null);
    const fromFlag = applyMoraleLayer({
        combatant, flags: { morale: true }, diagnostics
    });
    assert.equal(fromFlag.effectiveTier, "desperate");
    // context.morale injection wins over the flag.
    const injected = applyMoraleLayer({
        combatant, context: { morale: { tier: "confident" } },
        flags: { morale: true }, diagnostics
    });
    assert.equal(injected.tier, "confident");
    assert.equal(injected.confident, true);
});

/* ------------------------------------------------------------------ */
/* Posture weight shift (L2 narrowing of scoring)                      */
/* ------------------------------------------------------------------ */

test("applyMoraleWeightShift shifts bounded deltas by effective tier", () => {
    const base = { charge: 10, advance: 2, cohesionRestore: 0 };
    const desperate = applyMoraleWeightShift(base, "desperate");
    assert.equal(desperate.weights.charge, 2);
    assert.equal(desperate.weights.cohesionRestore, 8);
    assert.equal(desperate.deltas.charge, -8);
    // The base map is never mutated; pressured shifts nothing.
    assert.equal(base.charge, 10);
    const baseline = applyMoraleWeightShift(base, "pressured");
    assert.deepEqual(baseline.deltas, {});
    assert.deepEqual(baseline.weights, base);
    const confident = applyMoraleWeightShift(base, "confident");
    assert.equal(confident.weights.charge, 16);
    assert.equal(applyMoraleWeightShift(base, null).weights.charge, 10);
});

test("planTurn: a desperate record shifts the scoring weights (L2 narrowing)", async () => {
    _resetMocks();
    registerSettings();
    const scene = makeScene({ grid: "square" });
    const actor = makeActor({ enabled: true, preset: "assault" });
    actor.system = { wounds: { value: 12, max: 14 } };
    actor.items = [];
    const token = makeToken({ actor });
    token.x = 0;
    token.y = 0;
    token.disposition = -1;
    const combatant = makeCombatant({ actor, token });
    combatant.tokenId = token.id;
    const enemyActor = makeActor();
    enemyActor.system = { wounds: { value: 0, max: 10 } };
    enemyActor.items = [];
    const enemyToken = makeToken({ actor: enemyActor });
    enemyToken.x = 300;
    enemyToken.y = 0;
    enemyToken.disposition = 1;
    const enemy = makeCombatant({ actor: enemyActor, token: enemyToken });
    enemy.tokenId = enemyToken.id;
    const combat = makeCombat({ combatants: [combatant, enemy] });
    combat.scene = scene;
    const context = {
        seed: 7,
        targets: [{
            tokenId: enemyToken.id,
            tokenUuid: `Scene.${scene.id}.Token.${enemyToken.id}`,
            x: 300, y: 0, elevation: 0, canAttack: true, source: "injected"
        }],
        actions: [{
            id: "lasgun", type: "attack", name: "Lasgun",
            itemUuid: "Actor.npc.Item.las", itemId: "las",
            class: "ranged", range: 100, cost: "half"
        }],
        personality: false
    };
    const planner = createPlannerService();
    // Neutral baseline: the same plan with the L2 layer off.
    const baseline = await planner.planTurn(combat, combatant, {
        ...context,
        layers: { morale: false }
    });
    assert.equal(baseline.status, PLANNER_STATUS.ok);
    const desperate = await planner.planTurn(combat, combatant, {
        ...context,
        morale: { state: "desperate" }
    });
    assert.equal(desperate.status, PLANNER_STATUS.ok);
    assert.equal(desperate.plan.diagnostics.morale.tier, "desperate");
    assert.equal(desperate.plan.diagnostics.morale.effectiveTier, "desperate");
    assert.equal(
        desperate.plan.diagnostics.weights.charge,
        baseline.plan.diagnostics.weights.charge - 8);
    assert.equal(
        desperate.plan.diagnostics.weights.cohesionRestore,
        (baseline.plan.diagnostics.weights.cohesionRestore ?? 0) + 8);
    // A fanatic keeps the pressured posture — no desperate shift.
    const fanatic = await planner.planTurn(combat, combatant, {
        ...context,
        personality: ["fanatic"],
        morale: { state: "desperate" }
    });
    assert.equal(fanatic.plan.diagnostics.morale.tier, "desperate");
    assert.equal(fanatic.plan.diagnostics.morale.effectiveTier, "pressured");
    assert.equal(fanatic.plan.diagnostics.morale.shift, undefined);
    // A coward escalates pressured → desperate and shifts anyway.
    const coward = await planner.planTurn(combat, combatant, {
        ...context,
        personality: ["cowardly"],
        morale: { state: "pressured" }
    });
    assert.equal(coward.plan.diagnostics.morale.tier, "pressured");
    assert.equal(coward.plan.diagnostics.morale.effectiveTier, "desperate");
    assert.equal(coward.plan.diagnostics.morale.shift.charge, -8);
});

/* ------------------------------------------------------------------ */
/* Commitment invalidation on a tier change                            */
/* ------------------------------------------------------------------ */

test("validateCommitment: a morale tier change invalidates (morale-changed)", () => {
    const record = {
        id: "c-1", status: "active", combatId: "c1", combatantId: "bot",
        createdRound: 1, createdTurn: 0, ttl: 2,
        steps: [{ id: "s1", type: "end-turn" }],
        expectedState: {
            self: { x: 0, y: 0, elevation: 0 },
            morale: "pressured",
            threats: []
        }
    };
    const live = {
        combatId: "c1", round: 2, turn: 0,
        self: { x: 0, y: 0, elevation: 0 },
        journal: [], selfStatuses: [],
        moraleTier: "desperate",
        interventions: 0, reactive: false,
        threatTolerance: 0,
        resolveToken: () => null,
        isTokenAlive: () => false
    };
    const verdict = validateCommitment(record, live);
    assert.equal(verdict.valid, false);
    assert.equal(verdict.reason, COMMITMENT_REASONS.moraleChanged);
    // Confident travels through sanitize + the tier check too.
    live.moraleTier = "confident";
    assert.equal(validateCommitment(record, live).reason,
        COMMITMENT_REASONS.moraleChanged);
    live.moraleTier = "pressured";
    assert.equal(validateCommitment(record, live).valid, true);
    // The live view derives the tier from the evaluated record shape.
    const combatant = makeCombatant();
    combatant.flags[MODULE_ID] = { [FLAG_KEYS.morale]: { tier: "desperate" } };
    assert.equal(
        moraleTierOf(moralePostureOf(readMoraleRecord(combatant, {}))),
        "desperate");
});

/* ------------------------------------------------------------------ */
/* buildTeamPlan: record, hysteresis, remap, barks                     */
/* ------------------------------------------------------------------ */

test("buildTeamPlan: writes the evaluated record and commits after hysteresis", async () => {
    const members = [
        makeMember({ fireteam: { teamId: "alpha" }, x: 0, initiative: 20 }),
        makeMember({ fireteam: { teamId: "alpha" }, x: 100, initiative: 15 }),
        makeMember({ fireteam: { teamId: "alpha" }, x: 200, initiative: 10 })
    ];
    const world = makeTeamWorld(members, { enemyCount: 1 });
    const service = createFireteamService({ planner: createPlannerService() });
    const context = {
        seed: 5,
        // Deterministic effective tiers — trait exceptions get their own
        // tests.
        personality: false,
        targets: injectedTargets(world)
    };
    // Round 1: confident proposal — the tier holds at pressured.
    const first = await service.buildTeamPlan(world.combat, "alpha", context);
    assert.equal(first.status, FIRETEAM_STATUS.ok);
    assert.equal(first.teamPlan.diagnostics.morale.tier, "pressured");
    assert.deepEqual(first.teamPlan.diagnostics.morale.pending,
        { tier: "confident", count: 1 });
    for (const member of members) {
        const flag = moraleFlag(member.combatant);
        assert.ok(flag, "morale record written on the member flag");
        assert.equal(flag.tier, "pressured");
        assert.equal(flag.combatId, world.combat.id);
        assert.equal(flag.counters.members, 3);
        assert.equal(flag.counters.enemies, 1);
    }
    // Round 2: the same picture commits confident — wider assignments:
    // a second assault column plus the flank group.
    world.combat.round = 2;
    const second = await service.buildTeamPlan(world.combat, "alpha", context);
    assert.equal(second.status, FIRETEAM_STATUS.ok);
    assert.equal(second.teamPlan.diagnostics.morale.tier, "confident");
    const tasks = Object.fromEntries(second.teamPlan.members
        .map(m => [m.combatantId, m.task]));
    const sorted = [...members]
        .sort((a, b) => String(a.combatant.id).localeCompare(String(b.combatant.id)))
        .map(m => m.combatant.id);
    assert.equal(tasks[sorted[0]], "assault");
    assert.equal(tasks[sorted[1]], "assault");
    assert.equal(tasks[sorted[2]], "flank");
});

test("buildTeamPlan: desperate team remaps assault/flank to support/regroup", async () => {
    const members = [
        makeMember({ fireteam: { teamId: "alpha" }, x: 0, initiative: 20 }),
        makeMember({ fireteam: { teamId: "alpha" }, x: 100, initiative: 15 }),
        makeMember({ fireteam: { teamId: "alpha" }, x: 200, initiative: 10 })
    ];
    // 3 members vs 6 enemies — the 2:1 desperation ratio is met.
    const world = makeTeamWorld(members, { enemyCount: 6 });
    const service = createFireteamService({ planner: createPlannerService() });
    const objective = { type: "peel-withdrawal", lane: "left" };
    const context = {
        seed: 5,
        personality: false,
        allowFlank: true,
        targets: injectedTargets(world),
        assignments: {
            [members[0].combatant.id]: { task: "assault", role: "cover" },
            [members[1].combatant.id]: { task: "assault", role: "cover" },
            [members[2].combatant.id]: {
                task: "flank", role: "withdraw", element: "maneuver", objective
            }
        }
    };
    await service.buildTeamPlan(world.combat, "alpha", context);
    world.combat.round = 2;
    const result = await service.buildTeamPlan(world.combat, "alpha", context);
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    assert.equal(result.teamPlan.diagnostics.morale.tier, "desperate");
    const demotions = result.teamPlan.diagnostics.moraleDemotions;
    assert.ok(demotions.length >= 2, "assault+flank remapped");
    assert.ok(demotions.every(d => d.reason === "morale-desperate"));
    // assault→support, flank→regroup, support stays.
    const tasks = result.teamPlan.members.map(m => m.task).sort();
    assert.deepEqual(tasks, ["regroup", "support", "support"]);
    const flanker = result.teamPlan.members
        .find(m => m.combatantId === members[2].combatant.id);
    assert.equal(flanker.task, "regroup");
    assert.equal(flanker.role, "withdraw");
    assert.equal(flanker.element, "maneuver");
    assert.deepEqual(flanker.objective, objective);
    const diagnostic = result.teamPlan.diagnostics.assignments
        .find(a => a.combatantId === members[2].combatant.id);
    assert.equal(diagnostic.task, "regroup");
    assert.equal(diagnostic.role, "withdraw");
    assert.deepEqual(diagnostic.objective, objective);
});

test("buildTeamPlan: leader death forces the transition without hysteresis", async () => {
    const deadLeader = makeMember({
        fireteam: { teamId: "alpha" }, x: 0, initiative: 30, defeated: true
    });
    const members = [
        deadLeader,
        makeMember({ fireteam: { teamId: "alpha" }, x: 100, initiative: 15 }),
        makeMember({ fireteam: { teamId: "alpha" }, x: 200, initiative: 10 })
    ];
    // 2 living members vs 4 enemies — the 2:1 ratio proposes
    // `desperate` on its own; the dead flagged leader forces the
    // transition on the spot, no pending round.
    const world = makeTeamWorld(members, { enemyCount: 4 });
    const service = createFireteamService({ planner: createPlannerService() });
    const result = await service.buildTeamPlan(world.combat, {
        teamId: "alpha",
        leaderId: deadLeader.combatant.id
    }, {
        seed: 5,
        personality: false,
        targets: injectedTargets(world)
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    assert.equal(result.teamPlan.diagnostics.morale.tier, "desperate");
    assert.equal(result.teamPlan.diagnostics.morale.counters.leaderDead, true);
    assert.equal(result.teamPlan.diagnostics.morale.pending, null);
});

test("buildTeamPlan: manual morale stubs survive the team evaluation", async () => {
    const members = [
        makeMember({ fireteam: { teamId: "alpha" }, x: 0, initiative: 20 }),
        makeMember({ fireteam: { teamId: "alpha" }, x: 100, initiative: 15 })
    ];
    members[1].combatant.flags[MODULE_ID][FLAG_KEYS.morale] = { state: "desperate" };
    const world = makeTeamWorld(members, { enemyCount: 1 });
    const service = createFireteamService({ planner: createPlannerService() });
    const result = await service.buildTeamPlan(world.combat, "alpha", {
        seed: 5, personality: false, targets: injectedTargets(world)
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    // The manual stub is a member-level override — not clobbered, and
    // it feeds that member's effective tier.
    assert.equal(moraleFlag(members[1].combatant).state, "desperate");
    assert.equal(moraleFlag(members[0].combatant).tier, "pressured");
    assert.equal(
        result.teamPlan.diagnostics.morale.effective[members[1].combatant.id],
        "desperate");
});

test("buildTeamPlan: layers.morale=false disables evaluation, writes and remap", async () => {
    const members = [
        makeMember({ fireteam: { teamId: "alpha" }, x: 0, initiative: 20 }),
        makeMember({ fireteam: { teamId: "alpha" }, x: 100, initiative: 15 }),
        makeMember({ fireteam: { teamId: "alpha" }, x: 200, initiative: 10 })
    ];
    const world = makeTeamWorld(members, { enemyCount: 4 });
    const service = createFireteamService({ planner: createPlannerService() });
    const result = await service.buildTeamPlan(world.combat, "alpha", {
        seed: 5,
        layers: { morale: false },
        targets: injectedTargets(world)
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    assert.equal(result.teamPlan.diagnostics.morale.enabled, false);
    assert.equal(result.teamPlan.diagnostics.moraleDemotions.length, 0);
    for (const member of members) {
        assert.equal(moraleFlag(member.combatant), null);
    }
    const tasks = result.teamPlan.members.map(m => m.task).sort();
    assert.deepEqual(tasks, ["assault", "flank", "support"]);
});

test("buildTeamPlan: context.morale injection drives the team posture", async () => {
    const members = [
        makeMember({ fireteam: { teamId: "alpha" }, x: 0, initiative: 20 }),
        makeMember({ fireteam: { teamId: "alpha" }, x: 100, initiative: 15 }),
        makeMember({ fireteam: { teamId: "alpha" }, x: 200, initiative: 10 })
    ];
    const world = makeTeamWorld(members, { enemyCount: 1 });
    const service = createFireteamService({ planner: createPlannerService() });
    const result = await service.buildTeamPlan(world.combat, "alpha", {
        seed: 5,
        personality: false,
        allowFlank: true,
        morale: { state: "desperate" },
        targets: injectedTargets(world)
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    assert.equal(result.teamPlan.diagnostics.morale.tier, "desperate");
    // assault→support, flank→regroup, support stays.
    const tasks = result.teamPlan.members.map(m => m.task).sort();
    assert.deepEqual(tasks, ["regroup", "support", "support"]);
    // No evaluation writes ride an injected posture.
    for (const member of members) {
        assert.equal(moraleFlag(member.combatant), null);
    }
});

test("buildTeamPlan: unseen enemies never panic the team — memory and LOS reveal them", async () => {
    const members = [
        makeMember({ fireteam: { teamId: "alpha" }, x: 0, initiative: 20 }),
        makeMember({ fireteam: { teamId: "alpha" }, x: 100, initiative: 15 })
    ];
    // 2 members vs 4 hostiles the squad has never spotted: the natural
    // combat scan finds them, but nothing proves the team knows — the
    // headcount reads 0 and the posture stays pressured.
    const world = makeTeamWorld(members, { enemyCount: 4 });
    const service = createFireteamService({ planner: createPlannerService() });
    const context = { seed: 5, personality: false };
    const first = await service.buildTeamPlan(world.combat, "alpha", context);
    assert.equal(first.status, FIRETEAM_STATUS.ok);
    assert.equal(first.teamPlan.diagnostics.morale.counters.enemies, 0);
    assert.equal(first.teamPlan.diagnostics.morale.tier, "pressured");

    // A memory record proves a hostile was once seen — it joins the
    // headcount and persists on the evaluated record.
    members[0].combatant.flags[MODULE_ID][FLAG_KEYS.memory] = {
        [world.enemies[0].token.id]: { x: 2000, y: 0, lastSeenRound: 1 }
    };
    world.combat.round = 2;
    const second = await service.buildTeamPlan(world.combat, "alpha", context);
    assert.equal(second.teamPlan.diagnostics.morale.counters.enemies, 1);
    assert.ok(moraleFlag(members[0].combatant).seenEnemies
        .includes(world.enemies[0].token.id));

    // A live LOS probe reveals a first-contact hostile immediately —
    // no memory write needed; the earlier sighting persists.
    context.perception = {
        hasLineOfSight: (_from, to) => to.id === world.enemies[1].token.id
    };
    world.combat.round = 3;
    const third = await service.buildTeamPlan(world.combat, "alpha", context);
    const counters = third.teamPlan.diagnostics.morale.counters;
    assert.equal(counters.enemies, 2);
    const seen = moraleFlag(members[0].combatant).seenEnemies;
    assert.ok(seen.includes(world.enemies[0].token.id)
        && seen.includes(world.enemies[1].token.id));

    // Once both members remember all four, the 2:1 ratio flips the
    // proposal to desperate (after hysteresis).
    const memory = Object.fromEntries(
        world.enemies.map(e => [e.token.id, { x: e.token.x, y: e.token.y }]));
    for (const member of members) {
        member.combatant.flags[MODULE_ID][FLAG_KEYS.memory] = memory;
    }
    world.combat.round = 4;
    await service.buildTeamPlan(world.combat, "alpha", context);
    world.combat.round = 5;
    const fifth = await service.buildTeamPlan(world.combat, "alpha", context);
    assert.equal(fifth.teamPlan.diagnostics.morale.counters.enemies, 4);
    assert.equal(fifth.teamPlan.diagnostics.morale.tier, "desperate");
});

/* ------------------------------------------------------------------ */
/* Barks                                                               */
/* ------------------------------------------------------------------ */

test("barks: morale-tier change emits once per round, aiBarks=false silences", async () => {
    _resetMocks();
    registerSettings();
    game.users = new Map([["gm-1", { id: "gm-1", isGM: true }]]);
    const messages = captureChat();
    try {
        const members = [
            makeMember({ fireteam: { teamId: "alpha" }, x: 0, initiative: 20 }),
            makeMember({ fireteam: { teamId: "alpha" }, x: 100, initiative: 15 })
        ];
        const world = makeTeamWorld(members, { enemyCount: 4 });
        const service = createFireteamService({ planner: createPlannerService() });
        const context = { seed: 5, personality: false, targets: injectedTargets(world) };
        // Round 1: pending — no transition, no bark.
        await service.buildTeamPlan(world.combat, "alpha", context);
        assert.equal(messages.length, 0);
        // Round 2: committed desperate transition → one GM-whispered bark.
        world.combat.round = 2;
        await service.buildTeamPlan(world.combat, "alpha", context);
        assert.equal(messages.length, 1);
        const bark = messages[0];
        assert.equal(bark.flags[MODULE_ID].bark, "OWAI.Bark.Morale.desperate");
        assert.deepEqual(bark.whisper, ["gm-1"]);
        // A same-round rebuild stays quiet.
        await service.buildTeamPlan(world.combat, "alpha", context);
        assert.equal(messages.length, 1);
        // `barksToPlayers` opens the channel to the table.
        game.settings.set(MODULE_ID, SETTING_KEYS.barksToPlayers, true);
        world.combat.round = 3;
        await service.buildTeamPlan(world.combat, "alpha", context);
        // No transition — still one message; flip the tier to force one.
        const wide = makeTeamWorld(
            members.slice(0, 1).map(() => makeMember({ fireteam: { teamId: "alpha" }, x: 0 })),
            { enemyCount: 0 });
        wide.combat.round = 4;
        await service.buildTeamPlan(wide.combat, "alpha", {
            seed: 5, personality: false, targets: []
        });
        // confident pending only — no bark yet.
        wide.combat.round = 5;
        await service.buildTeamPlan(wide.combat, "alpha", {
            seed: 5, personality: false, targets: []
        });
        const publicBark = messages.find(m =>
            m.flags[MODULE_ID].bark === "OWAI.Bark.Morale.confident");
        assert.ok(publicBark, "confident transition barked");
        assert.deepEqual(publicBark.whisper, []);
        // aiBarks=false silences everything.
        game.settings.set(MODULE_ID, SETTING_KEYS.aiBarks, false);
        messages.length = 0;
        wide.combat.round = 6;
        members[1].combatant.defeated = true;
        const drop = makeTeamWorld(members.slice(0, 2), { enemyCount: 4 });
        drop.combat.round = 6;
        await service.buildTeamPlan(drop.combat, "alpha", {
            seed: 5, personality: false, targets: injectedTargets(drop)
        });
        assert.equal(messages.length, 0);
        // context.barks === false is the per-call kill switch.
        game.settings.set(MODULE_ID, SETTING_KEYS.aiBarks, true);
        const killWorld = makeTeamWorld(members.slice(0, 2), { enemyCount: 4 });
        killWorld.combat.round = 7;
        await service.buildTeamPlan(killWorld.combat, "alpha", {
            seed: 5, personality: false, barks: false,
            targets: injectedTargets(killWorld)
        });
        assert.equal(messages.length, 0);
    } finally {
        delete globalThis.ChatMessage;
        delete game.users;
    }
});

test("executor: a fresh committed plan barks once per round", async () => {
    _resetMocks();
    registerSettings();
    game.users = new Map([["gm-1", { id: "gm-1", isGM: true }]]);
    const messages = captureChat();
    const scene = makeScene({ grid: "square" });
    const actor = makeActor({ enabled: true, preset: "assault" });
    actor.system = { wounds: { value: 12, max: 14 } };
    actor.items = [];
    const token = makeToken({ actor });
    token.x = 0;
    token.y = 0;
    token.disposition = -1;
    token.move = async waypoints => {
        const last = waypoints.at(-1);
        token.x = last.x;
        token.y = last.y;
        return true;
    };
    const combatant = makeCombatant({ actor, token });
    combatant.tokenId = token.id;
    const enemyActor = makeActor();
    enemyActor.system = { wounds: { value: 0, max: 10 } };
    enemyActor.items = [];
    const enemyToken = makeToken({ actor: enemyActor });
    enemyToken.x = 300;
    enemyToken.y = 0;
    enemyToken.disposition = 1;
    const enemy = makeCombatant({ actor: enemyActor, token: enemyToken });
    enemy.tokenId = enemyToken.id;
    const combat = makeCombat({ combatants: [combatant, enemy] });
    combat.scene = scene;
    const api = createModuleApi();
    const planner = createPlannerService({ api });
    api.services.register("planner", planner);
    api.services.register("authority", {
        isController: () => true,
        operations: { completeTurn: async () => ({ ok: true }) }
    });
    const executor = createExecutorService({ api, getMode: () => "automatic" });
    game.darkHeresy.api.rolls = {
        prepareAttack: async input => ({ fingerprint: "fp", input }),
        executeAttack: async () => ({ status: "ok" })
    };
    try {
        const planned = await planner.planTurn(combat, combatant, {
            seed: 7,
            targets: [{
                tokenId: enemyToken.id,
                tokenUuid: `Scene.${scene.id}.Token.${enemyToken.id}`,
                x: 300, y: 0, elevation: 0, canAttack: true, source: "injected"
            }],
            actions: [{
                id: "lasgun", type: "attack", name: "Lasgun",
                itemUuid: "Actor.npc.Item.las", itemId: "las",
                class: "ranged", range: 100, cost: "half"
            }]
        });
        assert.equal(planned.status, "ok");
        // A multi-step plan (move → real attack → end-turn) telegraphs
        // intent — the attack step rides the planner's real input so the
        // executor's attack path executes it.
        const realSteps = planned.plan.steps.filter(s => s.type !== "end-turn");
        const plan = {
            ...planned.plan,
            steps: [
                { id: "step-move-1", type: "move",
                    input: { to: { x: 250, y: 0 } },
                    projectedResourceDelta: { movement: -2 } },
                ...realSteps,
                { id: "step-end-9", type: "end-turn", input: {},
                    projectedResourceDelta: {} }
            ]
        };
        const result = await executor.executePlan(plan, {
            combat, combatant, operationId: "op-bark-1"
        });
        assert.equal(result.status, EXECUTOR_STATUS.completed);
        const bark = messages.find(m =>
            m.flags[MODULE_ID]?.bark === "OWAI.Bark.Plan.Start");
        assert.ok(bark, "plan-start bark emitted");
        assert.deepEqual(bark.whisper, ["gm-1"]);
        // Same round + same combatant → deduped.
        const again = await executor.executePlan(
            { ...plan, id: "plan-bark-2", commitment: plan.commitment },
            { combat, combatant, operationId: "op-bark-2" });
        assert.equal(again.status, EXECUTOR_STATUS.completed);
        assert.equal(messages.filter(m =>
            m.flags[MODULE_ID]?.bark === "OWAI.Bark.Plan.Start").length, 1);
        // aiBarks=false silences the start bark too.
        game.settings.set(MODULE_ID, SETTING_KEYS.aiBarks, false);
        combat.round = 2;
        await executor.executePlan(
            { ...plan, id: "plan-bark-3" },
            { combat, combatant, operationId: "op-bark-3" });
        assert.equal(messages.filter(m =>
            m.flags[MODULE_ID]?.bark === "OWAI.Bark.Plan.Start").length, 1);
    } finally {
        delete game.darkHeresy.api.rolls;
        delete globalThis.ChatMessage;
        delete game.users;
    }
});

/* ------------------------------------------------------------------ */
/* Intent telegraphing: view-model + overlay marker                    */
/* ------------------------------------------------------------------ */

test("planIntentOf summarizes the step chain without end-turn", () => {
    assert.deepEqual(planIntentOf({
        steps: [
            { type: "move" }, { type: "attack" }, { type: "end-turn" }
        ]
    }), { steps: ["move", "attack"], total: 3 });
    assert.deepEqual(planIntentOf(null), { steps: [], total: 0 });
});

test("buildPreviewViewModel exposes intent and the morale tier", () => {
    const plan = {
        id: "plan-1",
        steps: [
            { id: "s1", type: "move", input: {}, cost: {} },
            { id: "s2", type: "attack", input: { name: "Lasgun" }, cost: {} },
            { id: "s3", type: "end-turn", input: {}, cost: {} }
        ],
        diagnostics: {
            morale: {
                enabled: true,
                tier: "desperate",
                effectiveTier: "pressured"
            }
        }
    };
    const vm = buildPreviewViewModel(plan, {});
    assert.deepEqual(vm.intent.steps, ["move", "attack"]);
    assert.equal(vm.morale.tier, "desperate");
    assert.equal(vm.morale.effectiveTier, "pressured");
    const localized = localizePreviewViewModel(vm, {
        localize: key => key,
        format: (key, data) => `${key} ${JSON.stringify(data)}`
    });
    // The echoing localize mock falls back to the raw ids — the chain
    // separator still proves the render.
    assert.ok(localized.intentLabel.includes("→"),
        "intent chain rendered");
    assert.equal(localized.morale.tierLabel, "desperate");
    assert.equal(localized.morale.effectiveTierLabel, "pressured");
    // No morale diagnostics → no morale block.
    const bare = buildPreviewViewModel({ steps: [], diagnostics: {} }, {});
    assert.equal(bare.morale, null);
});

test("buildPlanOverlayModel carries the intent marker", () => {
    const plan = {
        id: "plan-1",
        steps: [
            { id: "s1", type: "move", input: {}, cost: {} },
            { id: "s2", type: "attack", input: {}, cost: {} },
            { id: "s3", type: "end-turn", input: {}, cost: {} }
        ],
        diagnostics: {
            chosenStep: "s2",
            morale: { tier: "desperate", effectiveTier: "pressured" }
        }
    };
    const model = buildPlanOverlayModel(plan, {
        self: { x: 0, y: 0, w: 100, h: 100 }
    });
    assert.ok(model.intent, "intent marker present");
    assert.equal(model.intent.total, 2);
    assert.equal(model.intent.stepIndex, 2);
    assert.equal(model.intent.moraleTier, "pressured");
    assert.equal(model.intent.x, 50);
    // Explicit progress wins over the chosen-step default.
    const later = buildPlanOverlayModel(plan, {
        self: { x: 0, y: 0, w: 100, h: 100 },
        stepIndex: 1
    });
    assert.equal(later.intent.stepIndex, 1);
    // No self bounds → no marker.
    const bare = buildPlanOverlayModel(plan, {});
    assert.equal(bare.intent, null);
});

/* ------------------------------------------------------------------ */
/* readMoraleRecord: context wins, then flag                           */
/* ------------------------------------------------------------------ */

test("readMoraleRecord: context.morale wins over the flag", () => {
    const combatant = makeCombatant();
    combatant.flags[MODULE_ID] = { [FLAG_KEYS.morale]: { state: "desperate" } };
    assert.equal(readMoraleRecord(combatant, {}).state, "desperate");
    assert.equal(readMoraleRecord(combatant, { morale: null }), null);
    assert.equal(
        readMoraleRecord(combatant, { morale: { tier: "confident" } }).tier,
        "confident");
});
