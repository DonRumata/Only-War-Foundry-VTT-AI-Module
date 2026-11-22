/**
 * Unit tests for the L0–L4 behaviour-layer funnel (issue #24): layer
 * toggle resolution, the unified `{layer, code, detail}` reason trace,
 * the ±30% L3 delta bound, the L1 commitment entry contract (#25 stub),
 * the L2 morale pass-through (#26 stub) and flag-driven degradation.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    DEFAULT_LAYER_FLAGS,
    FLAG_KEYS,
    MODULE_ID,
    SETTING_KEYS
} from "../../scripts/constants.js";
import {
    L3_DELTA_BASE_FLOOR,
    L3_DELTA_MAX_RATIO,
    LAYER_FLAG_KEYS,
    LAYER_IDS,
    applyCommitmentLayer,
    applyMoraleLayer,
    boundedPersonalityOverlay,
    makeLayerReason,
    moralePostureOf,
    recordLayerReason,
    resolveLayerFlags
} from "../../scripts/layers.js";
import {
    DEFAULT_PRESET_WEIGHTS,
    PLANNER_STATUS,
    createPlannerService
} from "../../scripts/planner.js";
import { registerAssaultPreset } from "../../scripts/presets/assault.js";
import {
    makeActor,
    makeCombatant,
    makeScene,
    makeToken
} from "./fixtures.mjs";

let _combatId = 0;

/**
 * Minimal Combat fixture (mirrors the planner tests).
 * @param {object} [options]
 * @returns {object}
 */
function makeCombat({ combatants = [] } = {}) {
    const collection = new Map(combatants.map(c => [c.id, c]));
    collection.contents = combatants;
    return {
        documentName: "Combat",
        id: `layers-combat-${++_combatId}`,
        round: 1,
        turn: 0,
        combatants: collection,
        turns: combatants,
        scene: null,
        ended: false
    };
}

/** Lasgun-equivalent ranged weapon item. */
const RANGED_WEAPON = {
    id: "w1",
    uuid: "Actor.npc.Item.w1",
    name: "Lasgun",
    type: "weapon",
    system: { class: "ranged", range: 100, damage: "1d10+3" }
};

/** Chainsword-equivalent melee weapon item. */
const MELEE_WEAPON = {
    id: "w2",
    uuid: "Actor.npc.Item.w2",
    name: "Chainsword",
    type: "weapon",
    system: { class: "melee", range: 2, damage: "1d10+5" }
};

/**
 * Small AI world: one assault NPC plus a hostile at `(300, 0)`.
 * @param {object} [options]
 * @param {object[]} [options.weapons]
 * @returns {object}
 */
function makeWorld({ weapons = [RANGED_WEAPON] } = {}) {
    const scene = makeScene({ grid: "square" });
    const actor = makeActor({ enabled: true, preset: "assault" });
    actor.system = { wounds: { value: 12, max: 14 } };
    actor.items = weapons;
    const token = makeToken({ actor });
    token.x = 0;
    token.y = 0;
    token.elevation = 0;
    token.disposition = -1;
    const combatant = makeCombatant({ actor, token });
    combatant.tokenId = token.id;

    const enemyActor = makeActor();
    enemyActor.system = { wounds: { value: 10, max: 10 } };
    enemyActor.items = [];
    const enemyToken = makeToken({ actor: enemyActor });
    enemyToken.x = 300;
    enemyToken.y = 0;
    enemyToken.elevation = 0;
    enemyToken.disposition = 1;
    const enemy = makeCombatant({ actor: enemyActor, token: enemyToken });
    enemy.tokenId = enemyToken.id;

    const combat = makeCombat({ combatants: [combatant, enemy] });
    combat.scene = scene;
    return { scene, actor, token, combatant, enemy, enemyToken, combat };
}

/**
 * Injected target + ranged action context for {@link makeWorld}.
 * @param {object} world
 * @returns {object}
 */
function planContext(world) {
    return {
        seed: 7,
        targets: [{
            tokenId: world.enemyToken.id,
            tokenUuid: `Scene.${world.scene.id}.Token.${world.enemyToken.id}`,
            x: 300,
            y: 0,
            elevation: 0,
            distance: 4.5,
            canAttack: true,
            source: "injected"
        }],
        actions: [{
            id: "lasgun", type: "attack", name: "Lasgun",
            itemUuid: "Actor.npc.Item.las", itemId: "las",
            class: "ranged", range: 100, cost: "half"
        }]
    };
}

/** Layer ids of the trace records of a plan, in recorded order. */
function traceOf(plan) {
    return plan.diagnostics.layers ?? [];
}

/* ------------------------------------------------------------------ */
/* Layer flags and reason records                                      */
/* ------------------------------------------------------------------ */

test("resolveLayerFlags returns the issue #24 defaults", () => {
    _resetMocks();
    const flags = resolveLayerFlags({});
    assert.deepEqual(flags, { ...DEFAULT_LAYER_FLAGS });
    assert.equal(flags.commitment, false);
    assert.equal(flags.morale, false);
    assert.equal(flags.personality, true);
    assert.equal(flags.lookahead, true);
});

test("resolveLayerFlags: context.layers overrides the world settings", () => {
    _resetMocks();
    game.settings.set(MODULE_ID, SETTING_KEYS.layersMorale, true);
    assert.equal(resolveLayerFlags({}).morale, true);
    // A per-plan override wins over the stored setting.
    const flags = resolveLayerFlags({ layers: { morale: false, commitment: true } });
    assert.equal(flags.morale, false);
    assert.equal(flags.commitment, true);
    // Non-boolean overrides and unknown keys are ignored.
    const damaged = resolveLayerFlags({ layers: { morale: "yes", bogus: true } });
    assert.equal(damaged.morale, true);
    assert.equal("bogus" in damaged, false);
    assert.deepEqual(Object.keys(flags).sort(), [...LAYER_FLAG_KEYS].sort());
});

test("makeLayerReason/recordLayerReason produce the unified {layer, code, detail} shape", () => {
    const bare = makeLayerReason("L1", "commitment-miss");
    assert.deepEqual(bare, { layer: "L1", code: "commitment-miss" });
    const full = makeLayerReason("L0", "pinned", "charge|t1");
    assert.deepEqual(full, { layer: "L0", code: "pinned", detail: "charge|t1" });
    const diagnostics = {};
    recordLayerReason(diagnostics, "L4", "scored", { candidates: 3 });
    recordLayerReason(diagnostics, "L0", "out-of-range", "attack|t1");
    assert.deepEqual(diagnostics.layers.map(r => r.layer), ["L4", "L0"]);
    assert.equal(recordLayerReason(null, "L1", "x"), null);
    assert.deepEqual([...LAYER_IDS], ["L0", "L1", "L2", "L3", "L4"]);
});

/* ------------------------------------------------------------------ */
/* L1 commitment (contract stub for #25)                               */
/* ------------------------------------------------------------------ */

test("applyCommitmentLayer: disabled → null decision with a disabled reason", () => {
    const diagnostics = {};
    const result = applyCommitmentLayer({ context: {}, flags: { commitment: false }, diagnostics });
    assert.equal(result.enabled, false);
    assert.equal(result.decision, null);
    assert.deepEqual(diagnostics.layers[0], { layer: "L1", code: "commitment-layer-disabled" });
});

test("applyCommitmentLayer: enabled with no/invalid record → miss, valid record → hit", () => {
    const diagnostics = {};
    let result = applyCommitmentLayer({ context: {}, flags: { commitment: true }, diagnostics });
    assert.equal(result.enabled, true);
    assert.equal(result.decision, null);
    assert.equal(diagnostics.layers.at(-1).code, "commitment-miss");
    assert.equal(diagnostics.layers.at(-1).detail.reason, "no-commitment");

    result = applyCommitmentLayer({
        context: { commitment: { valid: false, steps: [{ id: "s1" }] } },
        flags: { commitment: true },
        diagnostics
    });
    assert.equal(result.decision, null);
    assert.equal(diagnostics.layers.at(-1).detail.reason, "invalid-commitment");

    const steps = [
        { id: "step-end-turn-1", type: "end-turn", cost: {}, input: { reason: "hold" }, preconditions: ["turn"], projectedResourceDelta: {} }
    ];
    result = applyCommitmentLayer({
        context: { commitment: { steps, source: "test-plan" } },
        flags: { commitment: true },
        diagnostics
    });
    assert.equal(result.decision.source, "test-plan");
    assert.equal(result.decision.steps.length, 1);
    assert.equal(diagnostics.layers.at(-1).code, "commitment-hit");
});

test("planTurn: an enabled+valid L1 commitment short-circuits before scoring", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    const steps = [
        {
            id: "step-end-turn-1", type: "end-turn", cost: {},
            input: { reason: "committed-hold" },
            preconditions: ["turn"], projectedResourceDelta: {}
        }
    ];
    const result = await planner.planTurn(world.combat, world.combatant, {
        ...planContext(world),
        layers: { commitment: true },
        commitment: { steps, source: "injected-commitment" }
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.equal(result.plan.steps.length, 1);
    assert.equal(result.plan.steps[0].input.reason, "committed-hold");
    assert.equal(result.plan.breakdown.reason, "commitment");
    assert.equal(result.plan.breakdown.source, "injected-commitment");
    // Scoring never ran: no candidates, no ranking, no L4 records.
    const diagnostics = result.plan.diagnostics;
    assert.equal(diagnostics.candidatesCount, 0);
    assert.equal(diagnostics.ranking.length, 0);
    assert.equal(diagnostics.metrics.targetsEvaluated, 0);
    const trace = diagnostics.layers;
    assert.equal(trace.length, 1);
    assert.equal(trace[0].layer, "L1");
    assert.equal(trace[0].code, "commitment-hit");
    // Serializable plan.
    assert.deepEqual(JSON.parse(JSON.stringify(result.plan)), result.plan);
});

test("planTurn: commitment enabled with no record degrades to normal planning", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, {
        ...planContext(world),
        layers: { commitment: true }
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const codes = result.plan.diagnostics.layers.map(r => r.code);
    assert.ok(codes.includes("commitment-miss"), "L1 miss reported");
    assert.ok(codes.includes("scored"), "L4 scoring ran after the miss");
});

/* ------------------------------------------------------------------ */
/* L2 morale (pass-through stub for #26)                               */
/* ------------------------------------------------------------------ */

test("moralePostureOf normalizes the reserved morale record", () => {
    assert.deepEqual(moralePostureOf(null), { state: null, pressured: false, desperate: false });
    assert.deepEqual(moralePostureOf({ state: "desperate" }),
        { state: "desperate", pressured: false, desperate: true });
    assert.deepEqual(moralePostureOf({ pressured: true }),
        { state: null, pressured: true, desperate: false });
});

test("applyMoraleLayer: disabled → neutral posture, enabled → reported posture", () => {
    const diagnostics = {};
    let result = applyMoraleLayer({ flags: { morale: false }, diagnostics });
    assert.equal(result.enabled, false);
    assert.equal(result.pressured, false);
    assert.equal(diagnostics.layers.at(-1).code, "morale-layer-disabled");

    const combatant = makeCombatant();
    combatant.flags[MODULE_ID] = { [FLAG_KEYS.morale]: { state: "pressured" } };
    result = applyMoraleLayer({ combatant, flags: { morale: true }, diagnostics });
    assert.equal(result.enabled, true);
    assert.equal(result.pressured, true);
    const record = diagnostics.layers.at(-1);
    assert.equal(record.layer, "L2");
    assert.equal(record.code, "morale-posture");
    assert.equal(record.detail.pressured, true);
});

test("planTurn: the L2 entry reports the posture when the layer is enabled", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, {
        ...planContext(world),
        layers: { morale: true },
        morale: { state: "desperate" }
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const posture = result.plan.diagnostics.layers.find(r => r.layer === "L2");
    assert.equal(posture.code, "morale-posture");
    assert.equal(posture.detail.desperate, true);
    assert.equal(result.plan.diagnostics.morale.desperate, true);
});

/* ------------------------------------------------------------------ */
/* L3 personality bound (±30%)                                         */
/* ------------------------------------------------------------------ */

test("boundedPersonalityOverlay keeps deltas inside ±30% of the base", () => {
    // Inside the bound: brave charge +2 on base 14 (bound 4.2).
    const inside = boundedPersonalityOverlay({ charge: 14 }, { traits: ["brave"] });
    assert.equal(inside.weights.charge, 16);
    assert.deepEqual(inside.clamped, {});
    // At the bound: reckless attackNow +4 on base 10 clamps to +3.
    const atBound = boundedPersonalityOverlay({ attackNow: 10 }, { traits: ["reckless"] });
    assert.equal(atBound.weights.attackNow, 13);
    assert.equal(atBound.clamped.attackNow.applied, 3);
    assert.equal(atBound.clamped.attackNow.raw, 4);
    // Negative base: ranged-cover charge −6, brave +2 → bound 1.8.
    const negative = boundedPersonalityOverlay({ charge: -6 }, { traits: ["brave"] });
    assert.ok(Math.abs(negative.weights.charge - (-4.2)) < 1e-9);
    // Zero base uses the reference floor (bound = 0.3 × 20 = 6):
    // fanatic cohesionRestore −12 clamps to −6.
    const zeroBase = boundedPersonalityOverlay({ cohesionRestore: 0 }, { traits: ["fanatic"] });
    assert.equal(zeroBase.weights.cohesionRestore, -6);
    assert.equal(zeroBase.clamped.cohesionRestore.applied, -6);
    assert.equal(L3_DELTA_MAX_RATIO * L3_DELTA_BASE_FLOOR, 6);
    // The base map is never mutated.
    const base = { charge: 14 };
    boundedPersonalityOverlay(base, { traits: ["duelist"] });
    assert.deepEqual(base, { charge: 14 });
});

test("planTurn: L3 deltas clamp to ±30% with a clamped report", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, {
        ...planContext(world),
        personality: ["fanatic"]
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    // assault skeleton: cohesionRestore base 0 → bound 6, applied −6.
    assert.equal(result.plan.diagnostics.weights.cohesionRestore, -6);
    assert.equal(result.plan.diagnostics.personality.clamped.cohesionRestore.applied, -6);
    // holdPosition base 0 → fanatic −4 fits inside the bound 6.
    assert.equal(result.plan.diagnostics.weights.holdPosition, -4);
});

test("planTurn: layers.personality=false degrades to the base overlay", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, {
        ...planContext(world),
        personality: ["cowardly"],
        layers: { personality: false }
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    // Explicit traits are ignored: the layer is off → disabled source,
    // untouched base weights and no jitter.
    assert.equal(result.plan.personality.source, "disabled");
    assert.equal(result.plan.diagnostics.weights.attackNow,
        DEFAULT_PRESET_WEIGHTS.attackNow);
    assert.equal(result.plan.diagnostics.personality.jitter, 0);
    assert.equal(result.plan.breakdown.jitter, undefined);
    assert.ok(result.plan.diagnostics.layers.some(
        r => r.layer === "L3" && r.code === "personality-layer-disabled"));
});

/* ------------------------------------------------------------------ */
/* L0 absolute vetoes                                                  */
/* ------------------------------------------------------------------ */

test("planTurn: L0 vetoes are absolute — L3 traits cannot revive a charge", async () => {
    const world = makeWorld({ weapons: [MELEE_WEAPON] });
    const planner = createPlannerService();
    registerAssaultPreset(planner);
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 3,
        targets: planContext(world).targets,
        actions: [
            { id: "w2-std", kind: "attack", weaponId: "w2", weaponName: "Chainsword",
                attackType: "standard", cost: "half", available: true },
            { id: "w2-charge", kind: "attack", weaponId: "w2", weaponName: "Chainsword",
                attackType: "charge", cost: "full", available: true }
        ],
        moves: [{ x: 200, y: 0, i: 2, j: 0, cost: 2, distance: 3, los: true }],
        selfStatuses: ["pinned"],
        // Duelist (+3 charge) and brave (+2 charge) bias toward charging —
        // the L0 pinned veto must still win.
        personality: ["duelist", "brave"]
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const trace = result.plan.diagnostics.layers;
    assert.ok(trace.some(r => r.layer === "L0" && r.code === "pinned"),
        `expected an L0/pinned reason, got ${JSON.stringify(trace)}`);
    // The vetoed charge never reaches the scored ranking.
    assert.ok(!result.plan.diagnostics.ranking.some(
        r => r.candidate.startsWith("charge|")));
    assert.ok(!result.plan.steps.some(step => step.type === "move"),
        "no closing move for a pinned bot");
});

/* ------------------------------------------------------------------ */
/* L4 lookahead flag                                                   */
/* ------------------------------------------------------------------ */

test("planTurn: layers.lookahead=false disables the counter pass even on hard", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    const on = await planner.planTurn(world.combat, world.combatant, {
        ...planContext(world),
        difficulty: "hard",
        lookahead: true
    });
    assert.ok(on.plan.diagnostics.lookahead, "fixture: lookahead runs on hard");
    assert.ok(on.plan.diagnostics.layers.some(
        r => r.layer === "L4" && r.code === "lookahead"));

    const off = await planner.planTurn(world.combat, world.combatant, {
        ...planContext(world),
        difficulty: "hard",
        lookahead: true,            // force-enable loses to the layer flag
        layers: { lookahead: false }
    });
    assert.equal(off.status, PLANNER_STATUS.ok);
    assert.equal(off.plan.diagnostics.lookahead, undefined);
    assert.equal(off.plan.breakdown.lookahead, undefined);
    assert.ok(off.plan.diagnostics.layers.some(
        r => r.layer === "L4" && r.code === "lookahead-layer-disabled"));
});

/* ------------------------------------------------------------------ */
/* Funnel order and determinism                                        */
/* ------------------------------------------------------------------ */

test("planTurn: the reason trace follows the funnel order L1 → L2 → L3 → L4", async () => {
    _resetMocks();
    const world = makeWorld();
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, planContext(world));
    assert.equal(result.status, PLANNER_STATUS.ok);
    const trace = traceOf(result.plan);
    assert.ok(trace.length >= 5, `trace populated, got ${JSON.stringify(trace)}`);
    // The funnel entry points report in order; L0 generation vetoes may
    // interleave below them, and L4 always closes the trace.
    assert.equal(trace[0].layer, "L1");
    assert.equal(trace[1].layer, "L2");
    assert.equal(trace[2].layer, "L3");
    assert.equal(trace.at(-1).layer, "L4");
    assert.equal(trace.at(-1).code, "winner");
    assert.ok(trace.every(r => LAYER_IDS.includes(r.layer)),
        "every reason carries a known layer id");
    // Layer flags ride the diagnostics for inspection.
    assert.deepEqual(result.plan.diagnostics.layerFlags, { ...DEFAULT_LAYER_FLAGS });
});

test("planTurn: identical seed reproduces the identical trace", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    const first = await planner.planTurn(world.combat, world.combatant, planContext(world));
    const second = await planner.planTurn(world.combat, world.combatant, planContext(world));
    assert.equal(first.status, PLANNER_STATUS.ok);
    assert.deepEqual(traceOf(second.plan), traceOf(first.plan));
    assert.equal(JSON.stringify(second.plan), JSON.stringify(first.plan));
});
