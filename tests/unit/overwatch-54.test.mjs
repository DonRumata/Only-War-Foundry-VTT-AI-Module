/**
 * Unit tests for issue #54: overwatch zones aim at predicted positions
 * (route waypoint of the nearest threat, lead points of live threats,
 * remembered contacts) instead of the square the enemy already occupies,
 * and template weapons declare their own geometry — a spray cone with
 * the weapon's own arc, a blast trigger circle. The declare gate still
 * requires a live visible threat (issue #15).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createModuleApi } from "../../scripts/api.js";
import { createExecutorService, EXECUTOR_STATUS } from "../../scripts/executor.js";
import { createOverwatchService, OVERWATCH_REASONS } from "../../scripts/overwatch.js";
import { buildPlanOverlayModel } from "../../scripts/ui/plan-overlay.js";
import { createPlannerService, PLANNER_STATUS } from "../../scripts/planner.js";
import { FLAG_KEYS, MODULE_ID } from "../../scripts/constants.js";
import {
    makeActor,
    makeCombat,
    makeCombatant,
    makeScene,
    makeToken
} from "./fixtures.mjs";

/**
 * Small world: AI-enabled NPC at the origin plus hostile combatants.
 * @param {object} [options]
 * @param {object[]} [options.enemies] `{x, y}` placements.
 * @param {string} [options.preset]
 * @returns {object}
 */
function makeWorld({ enemies = [{ x: 300, y: 0 }], preset = "hold" } = {}) {
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
        const enemyToken = makeToken({ actor: makeActor() });
        enemyToken.x = enemy.x;
        enemyToken.y = enemy.y;
        enemyToken.elevation = 0;
        enemyToken.disposition = 1;
        const enemyCombatant = makeCombatant({ actor: enemyToken.actor, token: enemyToken });
        enemyCombatant.tokenId = enemyToken.id;
        return enemyCombatant;
    });
    const combat = makeCombat({ round: 1, turn: 0, combatants: [combatant, ...enemyCombatants] });
    combat.scene = scene;
    return { scene, actor, token, combatant, enemies: enemyCombatants, combat };
}

/**
 * Injected targets matching {@link makeWorld} enemies; extra fields
 * (`halfMove`, `source`, `hidden`) pass through normalization.
 * @param {object} world
 * @param {object[]} [extra] Extra target records merged in order.
 * @returns {object[]}
 */
function targetsOf(world, extra = []) {
    return [
        ...world.enemies.map((enemy, index) => {
            const token = enemy.token ?? enemy.combatant?.token;
            const doc = token?.document ?? token;
            return {
                tokenId: doc.id,
                tokenUuid: `Scene.${world.scene.id}.Token.${doc.id}`,
                x: doc.x,
                y: doc.y,
                elevation: 0,
                canAttack: true,
                source: "injected",
                ...(extra[index] ?? {})
            };
        }),
        ...extra.filter(entry => entry?.tokenId && !world.enemies.some(
            enemy => (enemy.token?.document ?? enemy.token)?.id === entry.tokenId))
    ];
}

/** Ranged lasgun attack (plain watch cone, 45° arc). */
function lasgunAction({ range = 30 } = {}) {
    return {
        id: "las", kind: "attack", type: "attack", name: "Lasgun",
        itemUuid: "a.l", itemId: "w1", weaponId: "w1",
        attackType: "standard", class: "ranged", range,
        cost: "half", available: true
    };
}

/** Flamer-style spray action — its own 30° template cone. */
function sprayAction() {
    return {
        id: "flamer", kind: "attack", type: "attack", name: "Flamer",
        itemUuid: "a.f", itemId: "flamer", weaponId: "flamer",
        attackType: "standard", class: "ranged", range: 8,
        requirements: ["template"], spray: true,
        cost: "half", available: true
    };
}

/** Grenade-launcher blast action — a trigger circle, not a cone. */
function blastAction({ range = 60, blastRadius = 5 } = {}) {
    return {
        id: "gl", kind: "attack", type: "attack", name: "Grenade Launcher",
        itemUuid: "a.g", itemId: "gl", weaponId: "gl",
        attackType: "standard", class: "ranged", range, blastRadius,
        cost: "half", available: true
    };
}

/**
 * Preset forcing the overwatch win: every attack/economy pull is
 * suppressed so the declaration is the only positive-scored turn.
 * @returns {object}
 */
function owPreset() {
    return {
        weights: {
            overwatch: 10, holdPosition: 1,
            attackNow: -50, attackAfterMove: -50, charge: -50,
            aim: -50, aimAlone: -50, reload: -50,
            readyWeapon: -50, unpin: -50, order: -50
        },
        allowNoAction: true,
        alwaysOfferHold: true
    };
}

/**
 * Find the overwatch step of a plan result.
 * @param {object} result `planTurn` result.
 * @returns {object|null}
 */
function owStep(result) {
    return result.plan?.steps.find(step => step.type === "overwatch") ?? null;
}

test("overwatch aims the route waypoint of the nearest threat", async () => {
    // The enemy's approach route threads a southern corridor: the
    // waypoint ~half its move in sits at (0, 300) — bearing 90°, while
    // the live threat bears 0° east.
    const world = makeWorld({ enemies: [{ x: 600, y: 0 }] });
    const calls = [];
    const navigation = {
        planRoute: (token, destination, budget) => {
            calls.push({ token, destination, budget });
            return {
                status: "ok",
                waypoints: [
                    { x: 600, y: 0 }, { x: 600, y: 300 },
                    { x: 0, y: 300 }, { x: 0, y: 0 }
                ]
            };
        }
    };
    const planner = createPlannerService();
    planner.registerPreset("hold", owPreset());
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world),
        actions: [lasgunAction()],
        moves: [],
        navigation
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const ow = owStep(result);
    assert.ok(ow, "overwatch step exists");
    assert.equal(calls.length, 1, "one bounded route probe per plan");
    assert.equal(calls[0].token.id, world.enemies[0].token.id,
        "the route plans from the threat token toward the bot");
    assert.ok(Math.abs(ow.input.direction - 90) < 1e-6,
        `cone steered at the route waypoint (got ${ow.input.direction})`);
});

test("lead anchors of two threats share one midpoint cone", async () => {
    // Two enemies at bearings ±20°, both closing — their lead points fit
    // one 45° cone, so the aim centres between them (~0°) instead of
    // bearing-locking the nearest one (~20°).
    const world = makeWorld({
        enemies: [{ x: 300, y: 110 }, { x: 300, y: -110 }]
    });
    const planner = createPlannerService();
    planner.registerPreset("hold", owPreset());
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world, [{ halfMove: 1.5 }, { halfMove: 1.5 }]),
        actions: [lasgunAction()],
        moves: []
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const ow = owStep(result);
    assert.ok(ow, "overwatch step exists");
    assert.ok(Math.abs(ow.input.direction) < 5
        || Math.abs(ow.input.direction - 360) < 5,
        `cone centred between the two leads (got ${ow.input.direction})`);
});

test("overwatch falls back to the threat bearing without predictions", async () => {
    // No navigation, no half-move data, no memory contacts — the zone
    // degenerates to the legacy bearing on the nearest visible threat.
    const world = makeWorld({
        enemies: [{ x: 300, y: 0 }, { x: 300, y: 300 }]
    });
    const planner = createPlannerService();
    planner.registerPreset("hold", owPreset());
    const context = {
        seed: 1,
        targets: targetsOf(world),
        actions: [lasgunAction()],
        moves: []
    };
    const first = await planner.planTurn(world.combat, world.combatant, context);
    const second = await planner.planTurn(world.combat, world.combatant, context);
    assert.equal(first.status, PLANNER_STATUS.ok);
    const ow = owStep(first);
    assert.ok(ow, "overwatch step exists");
    assert.ok(Math.abs(ow.input.direction) < 1e-6
        || Math.abs(ow.input.direction - 360) < 1e-6,
        `bearing aims the nearest threat east (got ${ow.input.direction})`);
    // Determinism: identical inputs reproduce the identical zone.
    assert.equal(owStep(second)?.input.direction, ow.input.direction);
});

test("a spray weapon declares its own template cone", async () => {
    // Enemy far beyond the 8m flamer template: no attack is legal, so the
    // declaration wins — and it carries the weapon's own 30° arc/8 range
    // instead of the hardcoded 45° watch cone.
    const world = makeWorld({ enemies: [{ x: 90000, y: 0 }] });
    const planner = createPlannerService();
    planner.registerPreset("hold", owPreset());
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world),
        actions: [sprayAction()],
        moves: []
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const ow = owStep(result);
    assert.ok(ow, "overwatch step exists");
    assert.equal(ow.input.weaponId, "flamer");
    assert.equal(ow.input.arc, 30, "spray overwatch uses the weapon arc");
    assert.equal(ow.input.range, 8, "spray overwatch uses the weapon range");
    assert.notEqual(ow.input.shape, "blast");
    assert.ok(Number.isFinite(ow.input.direction));
});

test("a blast weapon declares a trigger circle on the predicted point", async () => {
    // Enemy at 4500px is out of the 60m (~4000px) throw — but its
    // predicted approach (half-move 30 ⇒ 2000px of lead) lands at
    // (2500, 0), inside the throw: the circle waits there.
    const world = makeWorld({ enemies: [{ x: 4500, y: 0 }] });
    const planner = createPlannerService();
    planner.registerPreset("hold", owPreset());
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: targetsOf(world, [{ halfMove: 30 }]),
        actions: [blastAction()],
        moves: []
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const ow = owStep(result);
    assert.ok(ow, "overwatch step exists");
    assert.equal(ow.input.shape, "blast");
    assert.ok(Math.abs(ow.input.targetPoint.x - 2500) < 1e-6,
        `circle sits on the lead point (got x=${ow.input.targetPoint.x})`);
    assert.ok(Math.abs(ow.input.targetPoint.y) < 1e-6);
    assert.equal(ow.input.blastRadius, 5);
    assert.equal(ow.input.range, 60);
    assert.ok(!("direction" in ow.input) || ow.input.direction == null,
        "a blast zone carries no cone direction");
    // JSON round-trip keeps the zone descriptor serializable.
    const clone = JSON.parse(JSON.stringify(result.plan));
    assert.equal(clone.steps.find(s => s.type === "overwatch").input.shape, "blast");
});

test("a shared team contact anchors the zone at its remembered point", async () => {
    // A live threat bears east (0°) while the teammate's shared contact
    // was seen south-east at (300, 300) — the remembered position is a
    // valid zone anchor (issue #45), so the cone covers it (~45°).
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }] });
    const shared = {
        tokenId: "shared-1",
        tokenUuid: `Scene.${world.scene.id}.Token.shared-1`,
        x: 300,
        y: 300,
        elevation: 0,
        canAttack: false,
        source: "team-contact"
    };
    const planner = createPlannerService();
    planner.registerPreset("hold", owPreset());
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: [...targetsOf(world), shared],
        actions: [lasgunAction()],
        moves: []
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const ow = owStep(result);
    assert.ok(ow, "overwatch step exists");
    assert.ok(Math.abs(ow.input.direction - 45) < 1e-6,
        `cone covers the remembered contact (got ${ow.input.direction})`);
});

test("memory-only and hidden contacts still never get a declaration", async () => {
    // Issue #15/#54 contract: prediction steers the zone, it never widens
    // the target gate — a last-known or hidden contact alone yields none.
    const world = makeWorld({ enemies: [{ x: 90000, y: 0 }] });
    const planner = createPlannerService();
    planner.registerPreset("hold", owPreset());
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: [
            {
                tokenId: "lost-1",
                tokenUuid: `Scene.${world.scene.id}.Token.lost-1`,
                x: 1500, y: 0, source: "last-known"
            },
            {
                tokenId: "sneaky-1",
                tokenUuid: `Scene.${world.scene.id}.Token.sneaky-1`,
                x: 200, y: 0, hidden: true, source: "team-contact"
            }
        ],
        actions: [lasgunAction()],
        moves: []
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.ok(result.plan.steps.every(step => step.type !== "overwatch"),
        "no overwatch without a live visible threat");
});

// --- Service: the second zone shape in `overwatch.declare` -----------------

function makeOwWorld() {
    const actor = makeActor({ enabled: true, preset: "hold" });
    const token = makeToken({ actor });
    token.x = 0;
    token.y = 0;
    token.disposition = -1;
    const combatant = makeCombatant({ actor, token });
    combatant.tokenId = token.id;
    const combat = makeCombat({ round: 1, turn: 0, combatants: [combatant] });
    return { combat, combatant };
}

function owApi() {
    const api = createModuleApi();
    api.services.register("authority", { isController: () => true });
    return api;
}

test("declare stores a blast trigger circle on the combatant flag", async () => {
    const { combat, combatant } = makeOwWorld();
    const service = createOverwatchService({ api: owApi() });
    const result = await service.declare({
        combat,
        combatant,
        spec: {
            shape: "blast",
            targetPoint: { x: 2500, y: 0 },
            blastRadius: 5,
            range: 60,
            weaponId: "gl",
            name: "Grenade Launcher"
        }
    });
    assert.equal(result.ok, true);
    const record = combatant.getFlag(MODULE_ID, FLAG_KEYS.overwatch);
    assert.equal(record.shape, "blast");
    assert.deepEqual(record.targetPoint, { x: 2500, y: 0 });
    assert.equal(record.blastRadius, 5);
    assert.equal(record.range, 60);
    assert.equal(record.weaponId, "gl");
});

test("declare rejects malformed blast zones and tags cones as cones", async () => {
    const { combat, combatant } = makeOwWorld();
    const service = createOverwatchService({ api: owApi() });
    const noPoint = await service.declare({
        combat, combatant,
        spec: { shape: "blast", blastRadius: 5 }
    });
    assert.equal(noPoint.ok, false);
    assert.equal(noPoint.reason, OVERWATCH_REASONS.invalidSpec);
    const noRadius = await service.declare({
        combat, combatant,
        spec: { shape: "blast", targetPoint: { x: 1, y: 2 }, blastRadius: 0 }
    });
    assert.equal(noRadius.ok, false);
    assert.equal(noRadius.reason, OVERWATCH_REASONS.invalidSpec);
    const cone = await service.declare({
        combat, combatant,
        spec: { direction: 45, arc: 45, range: 30 }
    });
    assert.equal(cone.ok, true);
    assert.equal(cone.record.shape, "cone");
});

// --- Overlay + executor: the circle end-to-end ------------------------------

test("the overlay model maps a blast overwatch step to an overwatch circle", () => {
    const plan = {
        id: "plan-ow-blast",
        snapshot: { self: { tokenId: "npc1", x: 0, y: 0 }, target: null },
        steps: [
            {
                id: "s1",
                type: "overwatch",
                input: {
                    shape: "blast",
                    targetPoint: { x: 2500, y: 0 },
                    blastRadius: 5,
                    range: 60
                }
            },
            { id: "s2", type: "end-turn", input: {} }
        ]
    };
    const model = buildPlanOverlayModel(plan, {
        self: { x: 0, y: 0, w: 100, h: 100 },
        pxPerUnit: 100
    });
    assert.equal(model.blasts.length, 1);
    assert.equal(model.blasts[0].kind, "overwatch");
    assert.equal(model.blasts[0].radiusPx, 500);
    assert.equal(model.cones.length, 0, "a blast zone draws no cone");
});

test("an executor overwatch step forwards the blast zone to declare", async () => {
    const actor = makeActor({ enabled: true, preset: "hold" });
    const token = makeToken({ actor });
    token.x = 0;
    token.y = 0;
    token.disposition = -1;
    const combatant = makeCombatant({ actor, token });
    combatant.tokenId = token.id;
    const combat = makeCombat({ round: 1, turn: 0, combatants: [combatant] });
    combat.nextTurn = async () => {
        combat.turn += 1;
        return combat;
    };
    const api = createModuleApi();
    api.services.register("authority", { isController: () => true });
    api.services.register("planner", {
        validateSnapshot: () => ({ valid: true, reason: null }),
        shouldReplan: () => ({ replan: false })
    });
    const declarations = [];
    const overwatch = {
        declare: async ({ spec }) => {
            declarations.push(spec);
            return { ok: true, record: spec };
        }
    };
    const executor = createExecutorService({ api, getMode: () => "automatic" });
    const operation = { id: "op-ow-blast", combatantId: combatant.id, phase: "executing" };
    const result = await executor.runPlan({
        combat,
        combatant,
        operation,
        planner: api.services.get("planner"),
        overwatch,
        plan: {
            id: "plan-ow-blast",
            operationId: operation.id,
            steps: [
                {
                    id: "step-ow-1",
                    type: "overwatch",
                    cost: { halves: 2 },
                    preconditions: ["turn"],
                    input: {
                        shape: "blast",
                        targetPoint: { x: 2500, y: 0 },
                        blastRadius: 5,
                        range: 60,
                        weaponId: "gl",
                        name: "Grenade Launcher",
                        attackType: "standard"
                    }
                },
                { id: "step-end-2", type: "end-turn", input: {} }
            ],
            snapshot: {
                self: {
                    tokenId: token.id,
                    tokenUuid: `Scene.scene.Token.${token.id}`,
                    actorUuid: `Actor.${actor.id}`,
                    x: 0,
                    y: 0
                },
                revision: "ow-blast-rev"
            }
        }
    });
    assert.equal(result.status, EXECUTOR_STATUS.completed);
    assert.equal(declarations.length, 1);
    assert.equal(declarations[0].shape, "blast");
    assert.deepEqual(declarations[0].targetPoint, { x: 2500, y: 0 });
    assert.equal(declarations[0].blastRadius, 5);
});
