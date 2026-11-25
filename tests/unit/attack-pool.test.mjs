/**
 * Unit tests for the epic #84 minimal split awareness/attack pools:
 * `context.attackTargetIds` (allow-list) and `context.excludedAttackTargetIds`
 * (deny-list) narrow only the direct-attack candidate generation while the
 * FULL perception pool keeps feeding movement, threat reads, melee
 * engagement, nearest-threat, overwatch anchors, the commitment threat
 * fingerprint and snapshot/diagnostics. Without the new inputs every plan
 * is bit-for-bit identical to the legacy behaviour.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PLANNER_STATUS, createPlannerService } from "../../scripts/planner.js";
import {
    _attackPoolAllows,
    _attackPoolDiagnostics,
    _attackPoolSpec,
    _targetIdentityKeys
} from "../../scripts/planner/targets.js";
import {
    makeActor,
    makeCombat,
    makeCombatant,
    makeScene,
    makeToken
} from "./fixtures.mjs";

/**
 * Small world: AI-enabled NPC at the origin plus hostile combatants on a
 * square-grid scene.
 * @param {object} [options]
 * @param {object[]} [options.enemies] `{x, y, threat?}` placements.
 * @param {string} [options.preset] Actor AI preset.
 * @returns {object}
 */
function makeWorld({ enemies = [{ x: 300, y: 0 }, { x: 600, y: 0 }], preset = "assault" } = {}) {
    const scene = makeScene({ grid: "square" });
    const actor = makeActor({ enabled: true, preset });
    actor.system = { wounds: { value: 12, max: 14 } };
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
        enemyActor.system = { wounds: { value: 0, max: 10 } };
        enemyActor.items = [];
        const enemyToken = makeToken({ actor: enemyActor });
        enemyToken.x = enemy.x;
        enemyToken.y = enemy.y;
        enemyToken.elevation = 0;
        enemyToken.disposition = 1;
        const enemyCombatant = makeCombatant({ actor: enemyActor, token: enemyToken });
        enemyCombatant.tokenId = enemyToken.id;
        return { combatant: enemyCombatant, token: enemyToken, actor: enemyActor, threat: enemy.threat ?? 0 };
    });

    const combat = makeCombat({ round: 1, turn: 0, combatants: [combatant, ...enemyCombatants.map(e => e.combatant)] });
    combat.scene = scene;
    return { scene, actor, token, combatant, enemies: enemyCombatants, combat };
}

/**
 * Injected target list matching {@link makeWorld} enemies.
 * @param {object} world
 * @param {object[]} [extra] Per-index overrides merged into the records.
 * @returns {object[]}
 */
function injectedTargets(world, extra = []) {
    return world.enemies.map((enemy, index) => ({
        tokenId: enemy.token.id,
        tokenUuid: `Scene.${world.scene.id}.Token.${enemy.token.id}`,
        actorId: enemy.actor.id,
        x: enemy.token.x,
        y: enemy.token.y,
        elevation: 0,
        threat: enemy.threat,
        canAttack: true,
        source: "injected",
        ...(extra[index] ?? {})
    }));
}

/** Plain ranged lasgun attack — half cost, generous range. */
function lasgunAction() {
    return {
        id: "las", type: "attack", name: "Lasgun",
        itemUuid: "Actor.npc.Item.las", itemId: "las",
        attackType: "standard", class: "ranged", range: 100,
        cost: "half", available: true
    };
}

/** Frag grenade — half-cost blast attack. */
function fragAction() {
    return {
        id: "frag", type: "attack", name: "Frag Grenade",
        itemUuid: "Actor.npc.Item.frag", itemId: "frag",
        attackType: "standard", class: "ranged", range: 10, blastRadius: 2,
        cost: "half", available: true
    };
}

/** Melee sword attack. */
function swordAction() {
    return {
        id: "sword", type: "attack", name: "Sword",
        itemUuid: "Actor.npc.Item.sword", itemId: "sword",
        attackType: "standard", class: "melee", range: 2,
        cost: "half", available: true
    };
}

/** Flamer-style spray action (30° template cone). */
function sprayAction() {
    return {
        id: "flamer", type: "attack", name: "Flamer",
        itemUuid: "Actor.npc.Item.flamer", itemId: "flamer",
        attackType: "standard", class: "ranged", range: 8,
        requirements: ["template"], spray: true,
        cost: "half", available: true
    };
}

/**
 * Coverage scan matching the injected targets so cone/blast friendly
 * vetoes see the same world.
 * @param {object} world
 * @returns {object[]}
 */
function blastTokensOf(world) {
    return world.enemies.map(enemy => ({
        tokenId: enemy.token.id,
        tokenUuid: `Scene.${world.scene.id}.Token.${enemy.token.id}`,
        x: enemy.token.x,
        y: enemy.token.y,
        disposition: 1
    }));
}

/**
 * JSON round-trip clone for bit-for-bit plan comparison.
 * @param {object} value
 * @returns {object}
 */
function jsonClone(value) {
    return JSON.parse(JSON.stringify(value));
}

/* ------------------------------------------------------------------ */
/* Pure helper contract                                               */
/* ------------------------------------------------------------------ */

test("identity keys cover tokenId, tokenUuid and actorId in priority order", () => {
    assert.deepEqual(_targetIdentityKeys({
        tokenId: "t1", tokenUuid: "Scene.s.Token.t1", actorId: "a1"
    }), ["t1", "Scene.s.Token.t1", "a1"]);
    assert.deepEqual(_targetIdentityKeys({ tokenId: 42, tokenUuid: null, actorId: null }), ["42"]);
    assert.deepEqual(_targetIdentityKeys(null), []);
    assert.deepEqual(_targetIdentityKeys({ tokenId: "t1", tokenUuid: "t1" }), ["t1"]);
});

test("the pool spec is inactive without arrays or with an empty deny-list alone", () => {
    assert.equal(_attackPoolSpec({}).active, false);
    assert.equal(_attackPoolSpec({ attackTargetIds: "garbage" }).active, false);
    assert.equal(_attackPoolSpec({ excludedAttackTargetIds: [] }).active, false);
    assert.equal(_attackPoolSpec({ attackTargetIds: [] }).active, true,
        "an empty allow-list is active and excludes everything");
    assert.equal(_attackPoolSpec({ excludedAttackTargetIds: ["t1"] }).active, true);
    // Entries dedupe and sort for deterministic diagnostics.
    const spec = _attackPoolSpec({ attackTargetIds: ["b", "a", "b", 7, null, {}] });
    assert.deepEqual(spec.allow, ["7", "a", "b"]);
});

test("pool matching is exact string equality against the identity keys", () => {
    const target = { tokenId: "t1", tokenUuid: "Scene.s.Token.t1", actorId: "a1" };
    const byTokenId = _attackPoolSpec({ attackTargetIds: ["t1"] });
    const byUuid = _attackPoolSpec({ attackTargetIds: ["Scene.s.Token.t1"] });
    const byActor = _attackPoolSpec({ attackTargetIds: ["a1"] });
    for (const spec of [byTokenId, byUuid, byActor]) {
        assert.equal(_attackPoolAllows(spec, target), true);
    }
    const miss = _attackPoolSpec({ attackTargetIds: ["t2"] });
    assert.equal(_attackPoolAllows(miss, target), false);
    // Deny always filters, even when the allow-list matches.
    const both = _attackPoolSpec({ attackTargetIds: ["t1"], excludedAttackTargetIds: ["a1"] });
    assert.equal(_attackPoolAllows(both, target), false);
    // Inactive spec allows everything.
    assert.equal(_attackPoolAllows(_attackPoolSpec({}), null), true);
});

test("pool diagnostics are null when inactive and JSON-safe when active", () => {
    const targets = [
        { tokenId: "t1", tokenUuid: "u1" },
        { tokenId: "t2", tokenUuid: "u2" }
    ];
    assert.equal(_attackPoolDiagnostics(_attackPoolSpec({}), targets), null);
    const spec = _attackPoolSpec({ attackTargetIds: ["t2"] });
    const diagnostics = _attackPoolDiagnostics(spec, targets);
    assert.equal(diagnostics.mode, "allow-list");
    assert.deepEqual(diagnostics.allow, ["t2"]);
    assert.deepEqual(diagnostics.deny, []);
    assert.equal(diagnostics.eligibleCount, 1);
    assert.equal(diagnostics.excludedCount, 1);
    assert.deepEqual(diagnostics.excludedTargets, ["t1"]);
    assert.deepEqual(jsonClone(diagnostics), diagnostics, "JSON round-trip is lossless");
});

/* ------------------------------------------------------------------ */
/* Regression: no new fields → bit-for-bit identical behaviour        */
/* ------------------------------------------------------------------ */

test("absent or inert narrowing inputs reproduce the legacy plan bit-for-bit", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    const base = {
        seed: 7,
        targets: injectedTargets(world),
        actions: [lasgunAction()],
        moves: []
    };
    const reference = await planner.planTurn(world.combat, world.combatant, base);
    assert.equal(reference.status, PLANNER_STATUS.ok);
    for (const [label, extra] of [
        ["empty deny-list", { excludedAttackTargetIds: [] }],
        ["garbage allow-list", { attackTargetIds: "not-an-array" }],
        ["garbage deny-list", { excludedAttackTargetIds: 42 }],
        ["null allow-list", { attackTargetIds: null }]
    ]) {
        const result = await planner.planTurn(world.combat, world.combatant, {
            ...base, ...extra
        });
        assert.equal(result.status, PLANNER_STATUS.ok, label);
        assert.deepEqual(jsonClone(result.plan), jsonClone(reference.plan),
            `${label}: plan identical to the no-fields reference`);
        assert.equal(result.plan.diagnostics.attackPool, undefined,
            `${label}: no attack-pool diagnostics surface`);
    }
});

/* ------------------------------------------------------------------ */
/* Allow-list narrowing                                               */
/* ------------------------------------------------------------------ */

test("allow-list excludes direct attacks on non-listed targets but keeps the full pool", async () => {
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }, { x: 600, y: 0 }] });
    const [near, far] = world.enemies;
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: injectedTargets(world),
        actions: [lasgunAction()],
        moves: [],
        attackTargetIds: [far.token.id]
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const attack = result.plan.steps.find(step => step.type === "attack");
    assert.ok(attack, "an attack step exists — the listed target is in range");
    assert.equal(attack.input.targetTokenId, far.token.id,
        "the attack aims at the allow-listed target");
    // The excluded target produced no attack candidates at all.
    const ranking = result.plan.diagnostics.ranking.map(entry => entry.candidate);
    assert.ok(!ranking.some(id => id.startsWith("attack-in-place") && id.includes(near.token.id)),
        "no attack candidate is keyed on the excluded target");
    assert.ok(result.plan.diagnostics.rejected.some(entry =>
        entry.reason === "attack-pool-excluded" && String(entry.candidate).includes(near.token.id)
            || entry.reason === "attack-pool-excluded"),
        "the exclusion is recorded as a rejection reason");
    // …but the FULL pool still feeds awareness: the overwatch candidate
    // orients on the nearest threat — the excluded near enemy.
    assert.ok(ranking.some(id => id.startsWith("overwatch") && id.includes(near.token.id)),
        "overwatch still anchors on the excluded nearest threat");
    // The snapshot target list is the full pool, unchanged.
    assert.deepEqual(
        result.plan.snapshot.targets.map(target => target.tokenId).sort(),
        [near.token.id, far.token.id].sort()
    );
    // Diagnostics surface.
    const pool = result.plan.diagnostics.attackPool;
    assert.equal(pool.mode, "allow-list");
    assert.equal(pool.eligibleCount, 1);
    assert.equal(pool.excludedCount, 1);
    assert.deepEqual(pool.excludedTargets, [near.token.id]);
});

test("allow-list matching works by tokenUuid and actorId too", async () => {
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }, { x: 600, y: 0 }] });
    const [near, far] = world.enemies;
    const planner = createPlannerService();
    const farUuid = `Scene.${world.scene.id}.Token.${far.token.id}`;
    for (const [label, ids] of [
        ["tokenUuid", [farUuid]],
        ["actorId", [far.actor.id]]
    ]) {
        const result = await planner.planTurn(world.combat, world.combatant, {
            seed: 1,
            targets: injectedTargets(world),
            actions: [lasgunAction()],
            moves: [],
            attackTargetIds: ids
        });
        const attack = result.plan.steps.find(step => step.type === "attack");
        assert.equal(attack?.input.targetTokenId, far.token.id,
            `${label}: the allow-list entry matches the far target`);
        assert.ok(!(result.plan.diagnostics.ranking ?? []).some(entry =>
            entry.candidate.startsWith("attack-in-place") && entry.candidate.includes(near.token.id)),
            `${label}: the near target stays excluded`);
    }
});

test("an empty allow-list suppresses every direct attack but movement still plans", async () => {
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }] });
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: injectedTargets(world),
        actions: [lasgunAction()],
        moves: [{ x: 100, y: 0, cost: 1, distance: 3, los: true }],
        attackTargetIds: []
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.ok(!result.plan.steps.some(step => step.type === "attack"),
        "no attack step at all");
    assert.ok(result.plan.diagnostics.rejected.some(entry => entry.reason === "attack-pool-excluded"));
    // The approach move toward the excluded target is still generated —
    // movement reads the full pool.
    assert.ok(result.plan.steps.some(step => step.type === "move")
        || result.plan.diagnostics.ranking.some(entry => entry.candidate.startsWith("approach")),
        "movement toward the excluded target is unaffected");
});

/* ------------------------------------------------------------------ */
/* Deny-list narrowing                                                */
/* ------------------------------------------------------------------ */

test("deny-list excludes direct attacks on listed targets only", async () => {
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }, { x: 600, y: 0 }] });
    const [near, far] = world.enemies;
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: injectedTargets(world),
        actions: [lasgunAction()],
        moves: [],
        excludedAttackTargetIds: [near.token.id]
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const attack = result.plan.steps.find(step => step.type === "attack");
    assert.equal(attack?.input.targetTokenId, far.token.id,
        "the attack shifts to the non-excluded target");
    const pool = result.plan.diagnostics.attackPool;
    assert.equal(pool.mode, "deny-list");
    assert.equal(pool.allow, null);
    assert.deepEqual(pool.deny, [near.token.id]);
    assert.equal(pool.excludedCount, 1);
    // Control: without the deny-list the near target is attackable.
    const control = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: injectedTargets(world),
        actions: [lasgunAction()],
        moves: []
    });
    assert.ok(control.plan.diagnostics.ranking.some(entry =>
        entry.candidate.startsWith("attack-in-place") && entry.candidate.includes(near.token.id)),
        "control: the near target is attackable without the deny-list");
});

/* ------------------------------------------------------------------ */
/* Memory/team-contact targets never become attackable                */
/* ------------------------------------------------------------------ */

test("an allow-listed memory contact still cannot be attacked directly", async () => {
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }] });
    const planner = createPlannerService();
    for (const source of ["last-known", "team-contact"]) {
        const targets = injectedTargets(world, [{ canAttack: false, source }]);
        const result = await planner.planTurn(world.combat, world.combatant, {
            seed: 1,
            targets,
            actions: [lasgunAction()],
            // A legal approach move keeps the plan `ok` so the assertion
            // is about missing attack steps, not a failure status.
            moves: [{ x: 100, y: 0, cost: 1, distance: 3, los: true }],
            attackTargetIds: [world.enemies[0].token.id]
        });
        assert.equal(result.status, PLANNER_STATUS.ok, `${source}: plan forms on movement`);
        assert.ok(!result.plan.steps.some(step => step.type === "attack"),
            `${source}: no direct attack on a memory-class contact`);
        assert.ok(result.plan.diagnostics.rejected.some(entry =>
            entry.reason === "target-not-attackable"),
            `${source}: the canAttack gate still rejects — the pool never widens`);
        assert.ok(!result.plan.diagnostics.rejected.some(entry =>
            entry.reason === "attack-pool-excluded"),
            `${source}: the pool itself did not exclude the listed target`);
    }
});

test("blast memory-strike follows the pool: allowed inside, suppressed outside", async () => {
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }] });
    const enemy = world.enemies[0];
    const planner = createPlannerService();
    const memoryTargets = injectedTargets(world, [{ canAttack: false, source: "last-known" }]);
    const base = {
        seed: 1,
        targets: memoryTargets,
        actions: [fragAction()],
        // A legal approach move keeps even the suppressed plan `ok` so
        // the assertions read steps rather than a failure status.
        moves: [{ x: 100, y: 0, cost: 1, distance: 3, los: true }],
        blastTokens: []
    };
    // Control: inside the pool the memory-strike fires (legacy behaviour).
    const allowed = await planner.planTurn(world.combat, world.combatant, base);
    const strike = allowed.plan.steps.find(step => step.type === "attack");
    assert.equal(strike?.input.actionId, "frag", "control memory-strike exists");
    // Excluded by the deny-list: the memory-strike is suppressed too.
    const denied = await planner.planTurn(world.combat, world.combatant, {
        ...base,
        excludedAttackTargetIds: [enemy.token.id]
    });
    assert.equal(denied.status, PLANNER_STATUS.ok);
    assert.ok(!denied.plan.steps.some(step => step.type === "attack"),
        "the excluded memory contact is not memory-struck either");
    assert.ok(denied.plan.diagnostics.rejected.some(entry =>
        entry.reason === "attack-pool-excluded"));
});

/* ------------------------------------------------------------------ */
/* Full-pool awareness: engagement and commitment threats             */
/* ------------------------------------------------------------------ */

test("an excluded adjacent enemy still vetoes charging a different target", async () => {
    // Enemy A adjacent (1.5 units — inside melee reach) but excluded;
    // enemy B in the pool at charge distance. The bot's melee engage
    // awareness reads the FULL pool, so charging B would still earn the
    // adjacent excluded enemy a free attack: `already-engaged` must fire.
    const world = makeWorld({ enemies: [{ x: 100, y: 0 }, { x: 800, y: 0 }] });
    const [adjacent, far] = world.enemies;
    const planner = createPlannerService();
    const context = {
        seed: 1,
        targets: injectedTargets(world),
        actions: [swordAction()],
        // Injected moves replace navigation; the endpoint lands in melee
        // reach of the far target on a straight line toward it.
        moves: [{ x: 700, y: 0, cost: 5, distance: 1.5, los: true }],
        attackTargetIds: [far.token.id]
    };
    const result = await planner.planTurn(world.combat, world.combatant, context);
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.ok(result.plan.diagnostics.rejected.some(entry =>
        entry.reason === "already-engaged"),
        "the excluded adjacent enemy still counts as melee engagement");
    // No attack targets the excluded adjacent enemy either.
    assert.ok(!result.plan.steps.some(step =>
        step.type === "attack" && step.input.targetTokenId === adjacent.token.id));
});

test("commitment expectedState threats keep the full pool", async () => {
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }, { x: 600, y: 0 }] });
    const [near, far] = world.enemies;
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: injectedTargets(world),
        actions: [lasgunAction()],
        moves: [],
        attackTargetIds: [far.token.id]
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const threats = result.plan.commitment?.expectedState?.threats ?? [];
    assert.ok(threats.length >= 2, "the commitment fingerprint keeps both threats");
    assert.ok(threats.some(entry => entry.tokenId === near.token.id),
        "the excluded target is still a tracked commitment threat");
    assert.ok(threats.some(entry => entry.tokenId === far.token.id));
});

/* ------------------------------------------------------------------ */
/* Cone attack anchors vs overwatch anchors                           */
/* ------------------------------------------------------------------ */

test("attack cone anchors follow the narrowed pool", async () => {
    // Two hostiles at bearings 0° (east) and 90° (south), both inside the
    // flamer template. Unnarrowed, the tie breaks to the smaller bearing —
    // 0° east. With the eastern target excluded, the cone must swing to
    // the southern one (90°).
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }, { x: 0, y: 300 }] });
    const [east, south] = world.enemies;
    const planner = createPlannerService();
    const base = {
        seed: 1,
        targets: injectedTargets(world),
        actions: [sprayAction()],
        moves: [],
        blastTokens: blastTokensOf(world)
    };
    const control = await planner.planTurn(world.combat, world.combatant, base);
    const controlAttack = control.plan.steps.find(step => step.type === "attack");
    assert.ok(controlAttack, "control cone attack exists");
    assert.ok(Math.abs(controlAttack.input.template.direction) < 1e-6
        || Math.abs(controlAttack.input.template.direction - 360) < 1e-6,
        `control: cone steers east (got ${controlAttack.input.template.direction})`);

    const narrowed = await planner.planTurn(world.combat, world.combatant, {
        ...base,
        excludedAttackTargetIds: [east.token.id]
    });
    const attack = narrowed.plan.steps.find(step => step.type === "attack");
    assert.ok(attack, "narrowed cone attack still exists — the southern target remains");
    assert.ok(Math.abs(attack.input.template.direction - 90) < 1e-6,
        `excluded east target no longer steers the cone (got ${attack.input.template.direction})`);
    assert.ok((attack.input.covered ?? []).every(entry => entry.tokenId !== east.token.id),
        "the excluded target is not a covered attack objective");
    assert.ok(south.token.id, "sanity: southern target fixture exists");
});

test("overwatch anchors keep reading the full pool when the nearest threat is excluded", async () => {
    // The excluded enemy is the nearest threat — overwatch orientation
    // and declaration gating still read the full perception pool, so the
    // zone aims at it exactly as before.
    const world = makeWorld({
        enemies: [{ x: 200, y: 0 }, { x: 0, y: 900 }],
        preset: "hold"
    });
    const [near] = world.enemies;
    const planner = createPlannerService();
    planner.registerPreset("hold", {
        weights: {
            overwatch: 10, holdPosition: 1,
            attackNow: -50, attackAfterMove: -50, charge: -50,
            aim: -50, aimAlone: -50, reload: -50,
            readyWeapon: -50, unpin: -50, order: -50
        },
        allowNoAction: true,
        alwaysOfferHold: true
    });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: injectedTargets(world),
        actions: [lasgunAction()],
        moves: [],
        excludedAttackTargetIds: [near.token.id]
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const overwatch = result.plan.steps.find(step => step.type === "overwatch");
    assert.ok(overwatch, "the overwatch declaration still wins");
    assert.ok(Math.abs(overwatch.input.direction) < 1e-6
        || Math.abs(overwatch.input.direction - 360) < 1e-6,
        `the zone orients on the excluded nearest threat east (got ${overwatch.input.direction})`);
});

/* ------------------------------------------------------------------ */
/* Snapshot/validate independence                                     */
/* ------------------------------------------------------------------ */

test("narrowing never enters the snapshot or stale validation", async () => {
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }, { x: 600, y: 0 }] });
    const planner = createPlannerService();
    const context = {
        seed: 1,
        targets: injectedTargets(world),
        actions: [lasgunAction()],
        moves: [],
        attackTargetIds: [world.enemies[1].token.id]
    };
    const narrowed = await planner.planTurn(world.combat, world.combatant, context);
    assert.equal(narrowed.status, PLANNER_STATUS.ok);
    const serialized = JSON.stringify(narrowed.plan.snapshot);
    assert.ok(!serialized.includes("attackTargetIds"), "snapshot carries no narrowing inputs");
    // Validation of the narrowed plan against the unchanged world passes
    // exactly like an unnarrowed one — the input is planning doctrine,
    // not document state.
    const validation = planner.validateSnapshot(narrowed.plan, {
        combat: world.combat,
        combatant: world.combatant,
        scene: world.scene
    });
    assert.equal(validation.valid, true, `narrowed plan validates (${validation.reason})`);
    // …and a plan narrowed differently produces the same snapshot
    // revision inputs — the snapshot targets list is the full pool.
    const unnarrowed = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: injectedTargets(world),
        actions: [lasgunAction()],
        moves: []
    });
    assert.deepEqual(
        jsonClone(narrowed.plan.snapshot.targets),
        jsonClone(unnarrowed.plan.snapshot.targets),
        "snapshot targets are identical with and without narrowing"
    );
});

test("the whole plan JSON round-trips with active narrowing", async () => {
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }, { x: 600, y: 0 }] });
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: injectedTargets(world),
        actions: [lasgunAction()],
        moves: [],
        attackTargetIds: [world.enemies[1].token.id],
        excludedAttackTargetIds: ["nonexistent"]
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.deepEqual(jsonClone(result.plan), jsonClone(jsonClone(result.plan)),
        "double JSON round-trip is stable");
    const pool = result.plan.diagnostics.attackPool;
    assert.equal(pool.mode, "allow+deny");
    assert.deepEqual(pool.deny, ["nonexistent"]);
});
