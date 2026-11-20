/**
 * Unit tests for the planner service (issue #403): snapshot immutability,
 * deterministic scoring/tie-breaking, serializable plans, stale reasons,
 * replan policy and preset registry.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    PLANNER_STATUS,
    STALE_REASONS,
    buildPlanSnapshot,
    createPlannerService,
    evaluateFactors,
    mulberry32
} from "../../scripts/planner.js";
import {
    freezeDeep,
    makeActor,
    makeCombatant,
    makeScene,
    makeToken
} from "./fixtures.mjs";

let _combatId = 0;

/**
 * Minimal Combat fixture: the planner only needs `id`, `round`, `turn`,
 * the `combatants` collection and a `scene` reference.
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
 * Build a small combat world: an AI-enabled NPC combatant plus hostile
 * enemy combatants placed on a square-grid scene.
 * @param {object} [options]
 * @param {object[]} [options.enemies] `{x, y, threat?}` enemy placements.
 * @param {string} [options.preset] Actor AI preset.
 * @param {boolean} [options.weapon] Give the NPC a ranged weapon item.
 * @returns {object}
 */
function makeWorld({ enemies = [{ x: 200, y: 0 }], preset = "assault", weapon = true } = {}) {
    const scene = makeScene({ grid: "square" });
    const actor = makeActor({ enabled: true, preset });
    actor.system = {
        wounds: { value: 12, max: 14 },
        fate: { value: 2, max: 3 }
    };
    if (weapon) {
        actor.items = [{
            id: "w1",
            uuid: `Actor.${actor.id}.Item.w1`,
            name: "Lasgun",
            type: "weapon",
            system: { class: "ranged", range: 100, damage: "1d10+3" }
        }];
    } else {
        actor.items = [];
    }
    const token = makeToken({ actor });
    token.x = 0;
    token.y = 0;
    token.elevation = 0;
    token.disposition = -1;
    const combatant = makeCombatant({ actor, token });
    combatant.tokenId = token.id;
    combatant.initiative = 10;

    const enemyCombatants = enemies.map((enemy, index) => {
        const enemyActor = makeActor();
        enemyActor.system = { wounds: { value: 10, max: 10 } };
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

    const combat = makeCombat({
        round: 1,
        turn: 0,
        combatants: [combatant, ...enemyCombatants.map(e => e.combatant)]
    });
    combat.scene = scene;
    return { scene, actor, token, combatant, enemies: enemyCombatants, combat };
}

/**
 * Injected target list matching {@link makeWorld} enemies.
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
        threat: enemy.threat,
        canAttack: true,
        source: "injected"
    }));
}

test("planTurn returns disabled for a non-enabled combatant", async () => {
    const world = makeWorld();
    world.actor.flags["only-war-ai"].config.enabled = false;
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, { seed: 1 });
    assert.equal(result.status, PLANNER_STATUS.disabled);
    assert.equal(result.plan, null);
});

test("planTurn returns waiting-for-gm when authority denies control", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    const byStatus = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        authority: { status: "waiting-for-gm" }
    });
    assert.equal(byStatus.status, PLANNER_STATUS.waitingForGm);
    const notController = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        authority: { status: "ready", isController: () => false }
    });
    assert.equal(notController.status, PLANNER_STATUS.waitingForGm);
});

test("planTurn produces an ok plan with move/attack/end-turn serializable steps", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, { seed: 42 });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const plan = result.plan;
    assert.equal(plan.preset, "assault");
    assert.equal(plan.seed, 42);
    assert.equal(plan.snapshot.combatId, world.combat.id);
    assert.equal(plan.snapshot.combatantId, world.combatant.id);
    assert.equal(plan.snapshot.round, 1);
    assert.equal(plan.snapshot.turn, 0);
    assert.equal(plan.snapshot.self.tokenId, world.token.id);
    assert.ok(plan.snapshot.target);
    assert.equal(plan.snapshot.target.tokenId, world.enemies[0].token.id);
    assert.ok(typeof plan.snapshot.revision === "string" && plan.snapshot.revision.length > 0);
    assert.ok(plan.steps.every(step => ["move", "attack", "test", "end-turn"].includes(step.type)));
    assert.equal(plan.steps.at(-1).type, "end-turn");
    assert.ok(plan.steps.some(step => step.type === "attack"));
});

test("snapshot is immutable and input fixtures are not mutated", async () => {
    const world = makeWorld();
    const snapshot = buildPlanSnapshot({
        combat: world.combat,
        combatant: world.combatant
    });
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.self), true);
    assert.equal(Object.isFrozen(snapshot.scene), true);

    // Frozen inputs must survive a full planTurn without writes.
    freezeDeep(world.combat);
    freezeDeep(world.combatant);
    freezeDeep(world.token);
    freezeDeep(world.actor);
    freezeDeep(world.scene);
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, { seed: 7 });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.equal(Object.isFrozen(result.plan), true);
    assert.equal(Object.isFrozen(result.plan.steps), true);
});

test("plan contains no Document references and survives JSON round-trip", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, { seed: 42 });
    const plan = result.plan;
    const roundTrip = JSON.parse(JSON.stringify(plan));
    assert.deepEqual(roundTrip, plan, "plan must be fully JSON-serializable");
    assert.equal(typeof plan.snapshot.self.getFlag, "undefined");
    assert.equal(typeof plan.snapshot.self.document, "undefined");
    assert.ok(!("actor" in plan.snapshot.self) || typeof plan.snapshot.self.actor !== "object");
});

test("planTurn is deterministic for identical input and seed", async () => {
    const world = makeWorld({ enemies: [{ x: 200, y: 0 }, { x: 9000, y: 0 }] });
    const first = createPlannerService();
    const second = createPlannerService();
    const a = await first.planTurn(world.combat, world.combatant, { seed: 5 });
    const b = await second.planTurn(world.combat, world.combatant, { seed: 5 });
    assert.equal(a.status, PLANNER_STATUS.ok);
    // A fresh service instance on identical input yields an identical plan.
    assert.equal(JSON.stringify(a.plan), JSON.stringify(b.plan));
    const again = await first.planTurn(world.combat, world.combatant, { seed: 5 });
    assert.equal(JSON.stringify(again.plan), JSON.stringify(a.plan));
    // Different seed still plans, but may resolve ties differently.
    const other = await first.planTurn(world.combat, world.combatant, { seed: 6 });
    assert.equal(other.status, PLANNER_STATUS.ok);
});

test("different preset weights produce different plans", async () => {
    const world = makeWorld({
        enemies: [
            { x: 3000, y: 0, threat: 0.9 },
            { x: 300, y: 0, threat: 0.1 }
        ]
    });
    const planner = createPlannerService();
    const context = () => ({ seed: 3, targets: injectedTargets(world) });
    const first = await planner.planTurn(world.combat, world.combatant, context());
    assert.equal(first.status, PLANNER_STATUS.ok);
    // Default assault weights include threat — the far, dangerous target wins.
    assert.equal(first.plan.target.tokenId, world.enemies[0].token.id);

    planner.registerPreset("assault", { weights: { threat: 0, proximity: 10 } });
    const second = await planner.planTurn(world.combat, world.combatant, context());
    assert.equal(second.status, PLANNER_STATUS.ok);
    assert.equal(second.plan.target.tokenId, world.enemies[1].token.id);
    assert.notEqual(JSON.stringify(second.plan), JSON.stringify(first.plan));
});

test("tie-break is seeded: same seed reproduces the winner, seeds vary", async () => {
    const world = makeWorld({
        enemies: [{ x: 300, y: 0 }, { x: -300, y: 0 }]
    });
    const planner = createPlannerService();
    const context = seed => ({ seed, targets: injectedTargets(world) });

    const first = await planner.planTurn(world.combat, world.combatant, context(11));
    const repeat = await planner.planTurn(world.combat, world.combatant, context(11));
    assert.equal(first.status, PLANNER_STATUS.ok);
    assert.equal(repeat.plan.target.tokenId, first.plan.target.tokenId);
    assert.equal(JSON.stringify(repeat.plan), JSON.stringify(first.plan));

    const winners = new Set();
    for (let seed = 0; seed < 20; seed++) {
        const result = await planner.planTurn(world.combat, world.combatant, context(seed));
        winners.add(result.plan.target.tokenId);
    }
    assert.equal(winners.size, 2, "both tied targets should win under some seed");
});

test("planTurn returns no-target when nothing hostile exists", async () => {
    const combatantOnly = makeCombat({ round: 1, turn: 0, combatants: [] });
    const world = makeWorld();
    const planner = createPlannerService();
    const injected = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: []
    });
    assert.equal(injected.status, PLANNER_STATUS.noTarget);
    // A combat with no enemy combatants hits the fallback scan as well.
    const combat = makeCombat({ round: 1, turn: 0, combatants: [world.combatant] });
    combat.scene = world.scene;
    const fallback = await planner.planTurn(combat, world.combatant, { seed: 1 });
    assert.equal(fallback.status, PLANNER_STATUS.noTarget);
    assert.ok(combatantOnly.id);
});

test("planTurn returns no-action when no usable action exists", async () => {
    const world = makeWorld({ weapon: false });
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        actions: []
    });
    assert.equal(result.status, PLANNER_STATUS.noAction);
});

test("planTurn returns no-route when a far target cannot be reached", async () => {
    const world = makeWorld({ enemies: [{ x: 90000, y: 0 }] });
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        moves: []
    });
    assert.equal(result.status, PLANNER_STATUS.noRoute);
    assert.equal(result.reason, "no-route");
});

test("planTurn rejects gridless scenes with a controlled unsupported result", async () => {
    const world = makeWorld();
    world.combat.scene = {
        ...world.scene,
        grid: { type: 0, size: world.scene.grid.size, distance: world.scene.grid.distance }
    };
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, { seed: 1 });
    assert.equal(result.status, PLANNER_STATUS.unsupported);
    assert.equal(result.reason, "gridless-unsupported");
    assert.equal(result.plan, null);
    assert.ok(result.diagnostics, "diagnostics still returned for the report");
});

test("validateSnapshot accepts an unchanged world (revision fast-path)", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    const { plan } = await planner.planTurn(world.combat, world.combatant, { seed: 42 });
    const verdict = planner.validateSnapshot(plan, {
        combat: world.combat,
        combatant: world.combatant,
        token: world.token,
        scene: world.scene
    });
    assert.deepEqual(verdict, { valid: true, reason: null });
});

test("validateSnapshot reports combat-ended", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    const { plan } = await planner.planTurn(world.combat, world.combatant, { seed: 42 });
    const ended = { ...world.combat, ended: true };
    assert.equal(planner.validateSnapshot(plan, {
        combat: ended,
        combatant: world.combatant,
        token: world.token,
        scene: world.scene
    }).reason, STALE_REASONS.combatEnded);
    assert.equal(planner.validateSnapshot(plan, { combat: null }).reason, STALE_REASONS.combatEnded);
});

test("validateSnapshot reports turn-stale on round/turn changes", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    const { plan } = await planner.planTurn(world.combat, world.combatant, { seed: 42 });
    for (const [key, value] of [["round", 2], ["turn", 1]]) {
        const shifted = { ...world.combat, [key]: value };
        const verdict = planner.validateSnapshot(plan, {
            combat: shifted,
            combatant: world.combatant,
            token: world.token,
            scene: world.scene
        });
        assert.equal(verdict.valid, false);
        assert.equal(verdict.reason, STALE_REASONS.turnStale, `${key} change`);
    }
});

test("validateSnapshot reports token-moved on token changes", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    const { plan } = await planner.planTurn(world.combat, world.combatant, { seed: 42 });
    const moved = { ...world.token, x: world.token.x + 100 };
    assert.equal(planner.validateSnapshot(plan, {
        combat: world.combat,
        combatant: world.combatant,
        token: moved,
        scene: world.scene
    }).reason, STALE_REASONS.tokenMoved);
    const hidden = { ...world.token, hidden: true };
    assert.equal(planner.validateSnapshot(plan, {
        combat: world.combat,
        combatant: world.combatant,
        token: hidden,
        scene: world.scene
    }).reason, STALE_REASONS.tokenMoved);
});

test("validateSnapshot reports target-gone on missing/dead/moved target", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    const { plan } = await planner.planTurn(world.combat, world.combatant, { seed: 42 });
    // Target explicitly absent.
    assert.equal(planner.validateSnapshot(plan, {
        combat: world.combat,
        combatant: world.combatant,
        token: world.token,
        target: null,
        scene: world.scene
    }).reason, STALE_REASONS.targetGone);
    // Target defeated in combat.
    const enemyCombatant = world.enemies[0].combatant;
    const defeatedCombat = {
        ...world.combat,
        combatants: new Map(world.combat.combatants)
    };
    defeatedCombat.combatants.set(enemyCombatant.id, { ...enemyCombatant, defeated: true });
    assert.equal(planner.validateSnapshot(plan, {
        combat: defeatedCombat,
        combatant: world.combatant,
        token: world.token,
        scene: world.scene
    }).reason, STALE_REASONS.targetGone);
    // Target moved away from its planned position.
    const movedTarget = { ...world.enemies[0].token, x: world.enemies[0].token.x + 400 };
    assert.equal(planner.validateSnapshot(plan, {
        combat: world.combat,
        combatant: world.combatant,
        token: world.token,
        target: movedTarget,
        scene: world.scene
    }).reason, STALE_REASONS.targetGone);
});

test("validateSnapshot reports resources-changed on actor resource drift", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    const { plan } = await planner.planTurn(world.combat, world.combatant, { seed: 42 });
    const drainedActor = {
        ...world.actor,
        system: { ...world.actor.system, wounds: { value: 4, max: 14 } }
    };
    const combatant = { ...world.combatant, actor: drainedActor };
    assert.equal(planner.validateSnapshot(plan, {
        combat: world.combat,
        combatant,
        token: world.token,
        scene: world.scene
    }).reason, STALE_REASONS.resourcesChanged);
});

test("validateSnapshot reports collision-changed on scene collision drift", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    const { plan } = await planner.planTurn(world.combat, world.combatant, { seed: 42 });
    assert.equal(planner.validateSnapshot(plan, {
        combat: world.combat,
        combatant: world.combatant,
        token: world.token,
        scene: world.scene,
        collisionRevision: "deadbeef"
    }).reason, STALE_REASONS.collisionChanged);
});

test("shouldReplan allows at most one replan then holds and reports", () => {
    const planner = createPlannerService();
    const first = planner.shouldReplan({ reason: STALE_REASONS.tokenMoved, plan: { id: "p1", replanCount: 0 } });
    assert.equal(first.replan, true);
    assert.equal(first.action, "replan");
    assert.equal(first.replanCount, 1);

    const second = planner.shouldReplan({ reason: STALE_REASONS.tokenMoved, plan: { id: "p2", replanCount: 1 } });
    assert.equal(second.replan, false);
    assert.equal(second.action, "hold-and-report");
    assert.equal(second.reason, "replan-limit-exceeded");
    assert.equal(second.report.reason, STALE_REASONS.tokenMoved);

    // Terminal failures never replan.
    const ended = planner.shouldReplan({ reason: STALE_REASONS.combatEnded, plan: { replanCount: 0 } });
    assert.equal(ended.replan, false);
    assert.equal(ended.action, "hold-and-report");
    assert.equal(ended.reason, STALE_REASONS.combatEnded);
});

test("replan count is capped by the configured maxReplans", () => {
    const planner = createPlannerService({ maxReplans: 2 });
    assert.equal(planner.shouldReplan({ reason: "step-failed", replanCount: 0 }).replan, true);
    assert.equal(planner.shouldReplan({ reason: "step-failed", replanCount: 1 }).replan, true);
    assert.equal(planner.shouldReplan({ reason: "step-failed", replanCount: 2 }).replan, false);
});

test("plan.diagnostics is fully populated for debugging", async () => {
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }, { x: 90000, y: 0 }] });
    const planner = createPlannerService();
    const { plan } = await planner.planTurn(world.combat, world.combatant, { seed: 9 });
    const diag = plan.diagnostics;
    assert.equal(diag.seed, 9);
    assert.equal(plan.debug.seed, 9);
    assert.ok(diag.candidatesCount >= 1);
    assert.ok(Array.isArray(diag.rejected));
    assert.ok(diag.rejected.length >= 1, "out-of-range/far variants should be rejected");
    assert.ok(diag.rejected.every(entry => entry.candidate && entry.reason));
    assert.ok(typeof diag.chosenStep === "string" && diag.chosenStep.length > 0);
    assert.ok(diag.weights && typeof diag.weights === "object");
    assert.ok(diag.ranking.length === diag.candidatesCount);
    assert.ok(diag.metrics.targetsEvaluated >= 1);
});

test("preset registry lists skeletons and accepts custom presets", async () => {
    const planner = createPlannerService();
    assert.deepEqual(planner.listPresets(), ["assault", "rangedCover", "hold", "specOps"]);
    const stored = planner.registerPreset("sniper", {
        weights: { attackNow: 20 },
        evaluate: ({ factors }) => factors.attackNow * 100 + factors.proximity
    });
    assert.equal(stored.weights.attackNow, 20);
    assert.ok(planner.listPresets().includes("sniper"));
    assert.equal(planner.getPreset("sniper").weights.attackNow, 20);
    assert.equal(planner.getPreset("missing"), null);
    assert.throws(() => planner.registerPreset("", {}));
});

test("hold preset plans a trivial hold when nothing can be done", async () => {
    const world = makeWorld({ preset: "hold", weapon: false });
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: [],
        actions: []
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.equal(result.plan.steps.at(-1).type, "end-turn");
    assert.equal(result.plan.steps.length, 1);
});

test("evaluateFactors produces an explainable weighted breakdown", () => {
    const { score, breakdown } = evaluateFactors(
        { attackNow: 1, proximity: 0.5, threat: 0.5 },
        { attackNow: 10, proximity: 2, threat: 4, unused: 99 }
    );
    assert.equal(score, 10 + 1 + 2);
    assert.equal(breakdown.contributions.attackNow, 10);
    assert.equal(breakdown.contributions.proximity, 1);
    assert.equal(breakdown.weights.threat, 4);
});

test("mulberry32 is deterministic per seed", () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    assert.deepEqual(seqA, seqB);
    for (const value of seqA) {
        assert.ok(value >= 0 && value < 1);
    }
});
