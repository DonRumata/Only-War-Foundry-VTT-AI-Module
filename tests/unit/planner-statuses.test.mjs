/**
 * Unit tests for status-aware and attack-type-aware turn planning
 * (issue #413): `snapshot.self.statuses` normalization, the
 * `statuses-changed` stale reason, pinned/prone/stunned candidate
 * constraints, per-weapon attack-type curation and the
 * `attackType`/`vulnerable`/`engaged`/`meleeEngage` factors — all through
 * `planner.planTurn`/`validateSnapshot` with injected context fixtures.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    PLANNER_STATUS,
    STALE_REASONS,
    buildPlanSnapshot,
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
 * Minimal Combat fixture (mirrors `tests/unit/planner.test.mjs`): `id`,
 * `round`, `turn`, the `combatants` collection and a `scene` reference.
 * @param {object} [options]
 * @param {object[]} [options.combatants]
 * @returns {object}
 */
function makeCombat({ combatants = [] } = {}) {
    const collection = new Map(combatants.map(c => [c.id, c]));
    collection.contents = combatants;
    return {
        documentName: "Combat",
        id: `status-combat-${++_combatId}`,
        round: 1,
        turn: 0,
        combatants: collection,
        turns: combatants,
        scene: null,
        ended: false
    };
}

/** Chainsword-equivalent melee weapon item. */
const MELEE_WEAPON = {
    id: "w2",
    uuid: "Actor.npc.Item.w2",
    name: "Chainsword",
    type: "weapon",
    system: { class: "melee", range: 2, damage: "1d10+5" }
};

/** Lasgun-equivalent ranged weapon item. */
const RANGED_WEAPON = {
    id: "w1",
    uuid: "Actor.npc.Item.w1",
    name: "Lasgun",
    type: "weapon",
    system: { class: "ranged", range: 100, damage: "1d10+3" }
};

/**
 * Build a small combat world: an AI-enabled NPC at the origin on a
 * square grid plus hostile enemies; `weapons` lists the actor items.
 * @param {object} [options]
 * @param {object[]} [options.enemies] `{x, y, threat?, statuses?}`.
 * @param {string} [options.preset] Actor AI preset.
 * @param {object[]} [options.weapons] Weapon item fixtures.
 * @returns {object}
 */
function makeWorld({ enemies = [{ x: 500, y: 0 }], preset = "assault", weapons = [RANGED_WEAPON] } = {}) {
    const scene = makeScene({ grid: "square" });
    const actor = makeActor({ enabled: true, preset });
    actor.system = { wounds: { value: 12, max: 14 } };
    actor.items = weapons;
    const token = makeToken({ actor });
    token.x = 0;
    token.y = 0;
    token.elevation = 0;
    token.disposition = -1;
    const combatant = makeCombatant({ actor, token });
    combatant.tokenId = token.id;
    combatant.initiative = 10;

    const enemyCombatants = enemies.map(enemy => {
        const enemyActor = makeActor();
        enemyActor.system = { wounds: { value: 10, max: 10 } };
        enemyActor.items = [];
        enemyActor.statuses = new Set(enemy.statuses ?? []);
        const enemyToken = makeToken({ actor: enemyActor });
        enemyToken.x = enemy.x;
        enemyToken.y = enemy.y;
        enemyToken.elevation = 0;
        enemyToken.disposition = 1;
        const enemyCombatant = makeCombatant({ actor: enemyActor, token: enemyToken });
        enemyCombatant.tokenId = enemyToken.id;
        return { combatant: enemyCombatant, token: enemyToken, actor: enemyActor, threat: enemy.threat ?? 0 };
    });

    const combat = makeCombat({ combatants: [combatant, ...enemyCombatants.map(e => e.combatant)] });
    combat.scene = scene;
    return { scene, actor, token, combatant, enemies: enemyCombatants, combat };
}

/**
 * Injected target list matching {@link makeWorld} enemies; `distance` is
 * taken from the entry or derived from the pixel position (1.5 units
 * per 100 px cell on the square grid stub).
 * @param {object} world
 * @returns {object[]}
 */
function injectedTargets(world) {
    return world.enemies.map(enemy => ({
        tokenId: enemy.token.id,
        tokenUuid: `Scene.${world.scene.id}.Token.${enemy.token.id}`,
        x: enemy.token.x,
        y: enemy.token.y,
        elevation: 0,
        distance: Math.hypot(enemy.token.x, enemy.token.y) / 100 * 1.5,
        threat: enemy.threat,
        statuses: [...(enemy.actor.statuses ?? [])],
        canAttack: true,
        source: "injected"
    }));
}

/**
 * System-API style action entries for {@link RANGED_WEAPON}.
 * @param {object} [options]
 * @param {object[]} [options.extra] Extra entries appended to the list.
 * @returns {object[]}
 */
function rangedApiActions({ extra = [] } = {}) {
    return [
        { id: "w1-std", kind: "attack", weaponId: "w1", weaponName: "Lasgun",
            attackType: "standard", cost: "half", available: true },
        { id: "w1-semi", kind: "attack", weaponId: "w1", weaponName: "Lasgun",
            attackType: "semi_auto", cost: "full", available: true },
        { id: "w1-full", kind: "attack", weaponId: "w1", weaponName: "Lasgun",
            attackType: "full_auto", cost: "full", available: true },
        { id: "w1-ripper", kind: "attack", weaponId: "w1", weaponName: "Lasgun",
            attackType: "ripper_charge", cost: "full", available: true },
        { id: "w1-called", kind: "attack", weaponId: "w1", weaponName: "Lasgun",
            attackType: "called_shot", cost: "full", available: false },
        { id: "w1-supp", kind: "attack", weaponId: "w1", weaponName: "Lasgun",
            attackType: "suppressing_fire", cost: "full", available: true },
        ...extra
    ];
}

/**
 * System-API style action entries for {@link MELEE_WEAPON}.
 * @returns {object[]}
 */
function meleeApiActions() {
    return [
        { id: "w2-std", kind: "attack", weaponId: "w2", weaponName: "Chainsword",
            attackType: "standard", cost: "half", available: true },
        { id: "w2-allout", kind: "attack", weaponId: "w2", weaponName: "Chainsword",
            attackType: "allOut", cost: "full", available: true },
        { id: "w2-charge", kind: "attack", weaponId: "w2", weaponName: "Chainsword",
            attackType: "charge", cost: "full", available: true }
    ];
}

test("snapshot normalizes self statuses sorted from actor, token and context", () => {
    const world = makeWorld();
    world.actor.statuses = new Set(["stunned", "pinned"]);
    world.token.statuses = new Set(["prone"]);
    const snapshot = buildPlanSnapshot({
        combat: world.combat,
        combatant: world.combatant,
        context: { selfStatuses: ["blinded", "pinned"] }
    });
    assert.deepEqual(snapshot.self.statuses, ["blinded", "pinned", "prone", "stunned"]);

    const bare = buildPlanSnapshot({
        combat: world.combat,
        combatant: makeCombatant({ actor: makeActor(), token: makeToken() })
    });
    assert.deepEqual(bare.self.statuses, []);
});

test("planTurn records selfStatuses in diagnostics and snapshot", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: injectedTargets(world),
        selfStatuses: ["pinned"]
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.deepEqual(result.plan.diagnostics.selfStatuses, ["pinned"]);
    assert.deepEqual(result.plan.snapshot.self.statuses, ["pinned"]);
});

test("validateSnapshot reports statuses-changed on self status drift", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    const { plan } = await planner.planTurn(world.combat, world.combatant, {
        seed: 42,
        targets: injectedTargets(world),
        selfStatuses: ["pinned"]
    });
    // Same statuses stay valid (fingerprint fast-path).
    const ok = planner.validateSnapshot(plan, {
        combat: world.combat,
        combatant: world.combatant,
        token: world.token,
        scene: world.scene,
        selfStatuses: ["pinned"]
    });
    assert.deepEqual(ok, { valid: true, reason: null });

    // A status appearing on the token document invalidates the plan.
    const mutated = { ...world.token, statuses: new Set(["prone"]) };
    const drift = planner.validateSnapshot(plan, {
        combat: world.combat,
        combatant: world.combatant,
        token: mutated,
        scene: world.scene,
        selfStatuses: ["pinned"]
    });
    assert.equal(drift.valid, false);
    assert.equal(drift.reason, STALE_REASONS.statusesChanged);

    // Injected statuses differing from the plan also stale it.
    const injected = planner.validateSnapshot(plan, {
        combat: world.combat,
        combatant: world.combatant,
        token: world.token,
        scene: world.scene,
        selfStatuses: ["stunned"]
    });
    assert.equal(injected.reason, STALE_REASONS.statusesChanged);
});

test("pinned vetoes charge and closing approaches for a melee NPC", async () => {
    const world = makeWorld({ weapons: [MELEE_WEAPON] });
    const planner = createPlannerService();
    registerAssaultPreset(planner);
    const context = () => ({
        seed: 7,
        targets: injectedTargets(world),
        actions: meleeApiActions(),
        moves: [{ x: 400, y: 0, i: 4, j: 0, cost: 4, distance: 1.5, los: true }]
    });
    // Baseline: an unpinned melee NPC charges the move-into-reach cell.
    const baseline = await planner.planTurn(world.combat, world.combatant, context());
    assert.equal(baseline.status, PLANNER_STATUS.ok);
    assert.equal(baseline.plan.breakdown.variant, "charge");

    const pinned = await planner.planTurn(world.combat, world.combatant, {
        ...context(),
        selfStatuses: ["pinned"]
    });
    assert.equal(pinned.status, PLANNER_STATUS.noAction);
    const reasons = pinned.diagnostics.rejected.map(r => r.reason);
    assert.ok(reasons.includes("pinned"), `expected pinned vetoes, got ${JSON.stringify(pinned.diagnostics.rejected)}`);
    assert.ok(pinned.diagnostics.rejected.some(r => r.candidate.startsWith("charge|") && r.reason === "pinned"));
    assert.ok(pinned.diagnostics.rejected.some(r => r.candidate.startsWith("approach|") && r.reason === "pinned"));
});

test("pinned vetoes a closing move-attack but keeps attack-in-place", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    registerAssaultPreset(planner);
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 3,
        targets: injectedTargets(world),
        actions: rangedApiActions(),
        moves: [{ x: 100, y: 0, i: 1, j: 0, cost: 1, distance: 6, los: true }],
        selfStatuses: ["pinned"]
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    // Attack-in-place stays legal — no move step is emitted; the
    // issue-#15 aim+attack pair is an equally legal pinned plan.
    const types = result.plan.steps.map(step => step.type);
    assert.ok(!types.includes("move"), "no move step for pinned");
    assert.ok(types.includes("attack"), "attack step kept");
    assert.ok(result.plan.diagnostics.rejected.some(
        r => r.candidate.startsWith("move-attack|") && r.reason === "pinned"
    ));
});

test("prone halves the movement budget and vetoes charge", async () => {
    const world = makeWorld({ weapons: [MELEE_WEAPON] });
    const planner = createPlannerService();
    registerAssaultPreset(planner);

    const budgets = [];
    const navigation = {
        findCandidates: (_token, budget) => {
            budgets.push(budget);
            return { status: "ok", candidates: [] };
        }
    };
    await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: injectedTargets(world),
        actions: meleeApiActions(),
        navigation,
        moveBudget: 8,
        selfStatuses: ["prone"]
    });
    assert.equal(budgets[0], 4, "prone halves a numeric budget (floor)");

    budgets.length = 0;
    await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: injectedTargets(world),
        actions: meleeApiActions(),
        navigation,
        selfStatuses: ["prone"]
    });
    assert.deepEqual(budgets[0], { mode: "half" }, "mode budgets degrade to the half mode");

    // Charge is vetoed outright: the closing move degenerates to a plain
    // approach — prone keeps relocating, it just cannot charge.
    const prone = await planner.planTurn(world.combat, world.combatant, {
        seed: 7,
        targets: injectedTargets(world),
        actions: meleeApiActions(),
        moves: [{ x: 400, y: 0, i: 4, j: 0, cost: 4, distance: 1.5, los: true }],
        selfStatuses: ["prone"]
    });
    assert.equal(prone.status, PLANNER_STATUS.ok);
    assert.equal(prone.plan.breakdown.variant, "approach");
    assert.ok(prone.plan.steps.every(step => step.type !== "attack"));
    assert.ok(prone.plan.diagnostics.rejected.some(
        r => r.candidate.startsWith("charge|") && r.reason === "prone"
    ));
});

test("stunned short-circuits to an end-turn-only plan", async () => {
    const world = makeWorld({ weapons: [MELEE_WEAPON] });
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 9,
        targets: injectedTargets(world),
        actions: meleeApiActions(),
        moves: [{ x: 400, y: 0, i: 4, j: 0, cost: 4, distance: 1.5, los: true }],
        selfStatuses: ["stunned"]
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.equal(result.plan.steps.length, 1);
    assert.equal(result.plan.steps[0].type, "end-turn");
    assert.equal(result.plan.steps[0].input.reason, "stunned");
    assert.equal(result.plan.target, null);
    assert.deepEqual(result.plan.diagnostics.selfStatuses, ["stunned"]);
    assert.deepEqual(result.plan.snapshot.self.statuses, ["stunned"]);

    // The plan stays valid while the status persists.
    const verdict = planner.validateSnapshot(result.plan, {
        combat: world.combat,
        combatant: world.combatant,
        token: world.token,
        scene: world.scene,
        selfStatuses: ["stunned"]
    });
    assert.deepEqual(verdict, { valid: true, reason: null });
});

test("attack-type curation keeps preferred types, drops unavailable; suppression survives the cap", async () => {
    const world = makeWorld({ weapons: [RANGED_WEAPON, MELEE_WEAPON] });
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: injectedTargets(world),
        actions: [...rangedApiActions(), ...meleeApiActions()],
        maxActions: 10
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const ids = result.plan.snapshot.actions.map(action => action.id).sort();
    assert.deepEqual(ids, [
        "w1-full", "w1-semi", "w1-std", "w1-supp",
        "w2-allout", "w2-charge", "w2-std"
    ]);
});

test("charge variant pairs with the weapon's charge attack type", async () => {
    const world = makeWorld({ weapons: [MELEE_WEAPON] });
    const planner = createPlannerService();
    registerAssaultPreset(planner);
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 7,
        targets: injectedTargets(world),
        actions: meleeApiActions(),
        moves: [{ x: 400, y: 0, i: 4, j: 0, cost: 4, distance: 1.5, los: true }]
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const attack = result.plan.steps.find(step => step.type === "attack");
    assert.equal(attack.input.actionId, "w2-charge");
    assert.equal(attack.input.attackType, "charge");
    assert.equal(attack.input.mode, "charge");
});

test("attackType factor prefers full_auto for a ranged attack-in-place", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    registerAssaultPreset(planner);
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        personality: false,
        targets: injectedTargets(world),
        actions: rangedApiActions(),
        maxActions: 10
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const attack = result.plan.steps.find(step => step.type === "attack");
    assert.equal(attack.input.actionId, "w1-full");
    assert.equal(result.plan.breakdown.factors.attackType, 0.9);
});

test("vulnerable and engaged factors appear in the score breakdown", async () => {
    const world = makeWorld({
        enemies: [{ x: 100, y: 0, statuses: ["prone"] }],
        weapons: [MELEE_WEAPON]
    });
    const planner = createPlannerService();
    registerAssaultPreset(planner);
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 5,
        targets: injectedTargets(world),
        actions: meleeApiActions()
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.equal(result.plan.breakdown.factors.vulnerable, 1);
    assert.equal(result.plan.breakdown.factors.engaged, 1);
    assert.equal(result.plan.breakdown.factors.meleeEngage, 1);
});
