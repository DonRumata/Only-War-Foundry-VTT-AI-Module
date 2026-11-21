/**
 * Unit tests for the hold preset «Удержание позиции» (issue #406):
 * stay-and-fire priority, modest move-to-LOS, radius constraint vetoes,
 * melee-contact responses, return-to-zone, last-known search limits,
 * invalid-anchor safe hold, determinism and diagnostics — all through
 * `planner.planTurn` with mocked perception/navigation services.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    PLANNER_STATUS,
    createPlannerService
} from "../../scripts/planner.js";
import {
    HOLD_PRESET_ID,
    HOLD_VETO_INVALID_ANCHOR,
    HOLD_VETO_NO_LOS,
    HOLD_VETO_OUTSIDE_RADIUS,
    HOLD_WEIGHTS,
    registerHoldPreset
} from "../../scripts/presets/hold.js";
import {
    makeActor,
    makeCombatant,
    makeScene,
    makeToken
} from "./fixtures.mjs";

let _combatId = 0;

/**
 * Minimal Combat fixture (mirrors `tests/unit/preset-ranged-cover.test.mjs`):
 * `id`, `round`, `turn`, the `combatants` collection and a `scene`
 * reference.
 * @param {object} [options]
 * @param {object[]} [options.combatants]
 * @returns {object}
 */
function makeCombat({ combatants = [] } = {}) {
    const collection = new Map(combatants.map(c => [c.id, c]));
    collection.contents = combatants;
    return {
        documentName: "Combat",
        id: `hold-combat-${++_combatId}`,
        round: 1,
        turn: 0,
        combatants: collection,
        turns: combatants,
        scene: null,
        ended: false
    };
}

/** Melee action fixture: chainsword-equivalent, 2 scene units reach. */
const MELEE_ACTION = {
    id: "sword",
    type: "attack",
    name: "Chainsword",
    itemUuid: "Actor.npc.Item.sword",
    class: "melee",
    range: 2,
    damage: 9
};

/** Ranged action fixture: lasgun-equivalent, 30 scene units reach. */
const RANGED_ACTION = {
    id: "lasgun",
    type: "attack",
    name: "Lasgun",
    itemUuid: "Actor.npc.Item.lasgun",
    class: "basic",
    range: 30,
    damage: 6
};

/**
 * Hold-enabled planner for tests.
 * @returns {object} Planner service with the real hold preset.
 */
function makePlanner() {
    const planner = createPlannerService();
    registerHoldPreset(planner);
    return planner;
}

/**
 * Perception service stub: returns fixed visible/last-known contacts.
 * @param {object} [options]
 * @param {object[]} [options.visible] `visibleTargets` entries.
 * @param {object[]} [options.lastKnown] `lastKnownTargets` entries.
 * @returns {object}
 */
function makePerception({ visible = [], lastKnown = [] } = {}) {
    return {
        buildPerceptionSnapshot: () => ({
            status: "ok",
            visibleTargets: visible,
            lastKnownTargets: lastKnown
        }),
        measureDistance: () => null
    };
}

/**
 * Navigation service stub: returns fixed movement candidates.
 * @param {object[]} [candidates] `{x, y, cost, distance, los, cover}` cells.
 * @param {string} [status] Result status ("ok" or "no-route").
 * @returns {object}
 */
function makeNavigation(candidates = [], status = "ok") {
    return { findCandidates: () => ({ status, candidates }) };
}

/**
 * Wall document fixture: segment `c` plus v13-style `sight`/`move`
 * blocking values.
 * @param {number[]} coords `[x1, y1, x2, y2]` in pixels.
 * @param {object} [options]
 * @param {number} [options.sight] Sight blocking (0 = transparent).
 * @param {number} [options.move] Move blocking (0 = passable).
 * @returns {object}
 */
function makeWall(coords, { sight = 20, move = 20 } = {}) {
    return { documentName: "Wall", id: `wall-${coords.join("-")}`, c: coords, sight, move, door: 0 };
}

/**
 * Build a small combat world: a hold-enabled NPC at the origin on a
 * square grid (size 100, 1.5 units per cell) plus hostile enemies.
 * @param {object} [options]
 * @param {object[]} [options.enemies] `{x, y, threat?}` enemy placements.
 * @param {object[]} [options.walls] Wall fixtures on the scene.
 * @param {{x: number, y: number}} [options.selfPos] NPC token position.
 * @returns {object}
 */
function makeWorld({ enemies = [{ x: 300, y: 0 }], walls = [], selfPos = { x: 0, y: 0 } } = {}) {
    const scene = makeScene({ grid: "square" });
    scene.walls = walls;
    const actor = makeActor({ enabled: true, preset: HOLD_PRESET_ID });
    actor.system = { wounds: { value: 12, max: 14 } };
    const token = makeToken({ actor });
    token.x = selfPos.x;
    token.y = selfPos.y;
    token.elevation = 0;
    token.disposition = -1;
    const combatant = makeCombatant({ actor, token });
    combatant.tokenId = token.id;
    combatant.initiative = 10;

    const enemyCombatants = enemies.map(enemy => {
        const enemyActor = makeActor();
        enemyActor.system = { wounds: { value: 10, max: 10 } };
        const enemyToken = makeToken({ actor: enemyActor });
        enemyToken.x = enemy.x;
        enemyToken.y = enemy.y;
        enemyToken.elevation = 0;
        enemyToken.disposition = 1;
        const enemyCombatant = makeCombatant({ actor: enemyActor, token: enemyToken });
        enemyCombatant.tokenId = enemyToken.id;
        return { combatant: enemyCombatant, token: enemyToken, threat: enemy.threat ?? 0 };
    });

    const combat = makeCombat({ combatants: [combatant, ...enemyCombatants.map(e => e.combatant)] });
    combat.scene = scene;
    combat.ended = false;
    return { scene, actor, token, combatant, enemies: enemyCombatants, combat };
}

/**
 * Visible-target entries matching {@link makeWorld} enemies.
 * @param {object} world
 * @returns {object[]}
 */
function visibleTargets(world) {
    return world.enemies.map(enemy => ({
        tokenId: enemy.token.id,
        tokenUuid: `Scene.${world.scene.id}.Token.${enemy.token.id}`,
        x: enemy.token.x,
        y: enemy.token.y,
        elevation: 0,
        threat: enemy.threat,
        canAttack: true
    }));
}

test("registerHoldPreset installs the preset with data-driven weights", () => {
    const planner = createPlannerService();
    const stored = registerHoldPreset(planner);
    assert.equal(stored.id, HOLD_PRESET_ID);
    const registered = planner.getPreset(HOLD_PRESET_ID);
    assert.equal(registered.weights.holdPosition, HOLD_WEIGHTS.holdPosition);
    assert.equal(registered.weights.returnToZone, HOLD_WEIGHTS.returnToZone);
    assert.equal(typeof registered.evaluate, "function");
    assert.equal(typeof registered.veto, "function");
    assert.equal(stored.allowNoTarget, true);
    assert.equal(stored.allowNoAction, true);
    assert.equal(stored.alwaysOfferHold, true);
    assert.ok(HOLD_WEIGHTS.holdPosition > 0, "staying weighted very high");
    assert.ok(HOLD_WEIGHTS.attackNow > HOLD_WEIGHTS.attackAfterMove,
        "attacking from the current position beats repositioning");
    assert.ok(HOLD_WEIGHTS.charge < 0, "charges nearly disallowed");
    assert.throws(() => registerHoldPreset(null));
});

test("a legal attack from the current position beats any movement", async () => {
    // Enemy at 9u inside lasgun range and LOS: the plan must not move.
    const world = makeWorld({ enemies: [{ x: 600, y: 0 }] });
    const planner = makePlanner();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 7,
        perception: makePerception({ visible: visibleTargets(world) }),
        navigation: makeNavigation([
            { x: 300, y: 0, i: 3, j: 0, cost: 3, distance: 4.5, los: true, cover: 1 },
            { x: -200, y: 0, i: -2, j: 0, cost: 2, distance: 12, los: true, cover: 0 }
        ]),
        actions: [RANGED_ACTION, MELEE_ACTION]
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    const plan = result.plan;
    assert.equal(plan.preset, HOLD_PRESET_ID);
    // Issue #15: aim+attack is a stationary attack too — either the plain
    // shot or the aimed shot is a legal "attack from position" plan.
    assert.ok(["attack-in-place", "aim-attack"].includes(plan.breakdown.variant));
    const attack = plan.steps.find(step => step.type === "attack");
    assert.ok(attack, "attack step exists");
    assert.equal(attack.input.actionId, "lasgun");
    assert.ok(plan.steps.every(step => step.type !== "move"));
    assert.equal(plan.breakdown.zone.insideRadius, true);
    assert.ok(plan.breakdown.contributions.attackNow > 0);
    assert.ok(plan.breakdown.contributions.holdPosition > 0);
});

test("blocked LOS repositions to a modest endpoint with line of sight", async () => {
    // A tall wall blocks the standing shot; the flanking endpoint inside
    // the radius sees the target and wins over holding.
    const wall = makeWall([450, -200, 450, 200]);
    const world = makeWorld({ enemies: [{ x: 900, y: 0 }], walls: [wall] });
    const planner = makePlanner();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 5,
        hold: { anchor: { x: 0, y: 0 }, radiusMeters: 20 },
        perception: makePerception({ visible: visibleTargets(world) }),
        navigation: makeNavigation([
            { x: 900, y: 600, i: 9, j: 6, cost: 11, distance: 9, los: true, cover: 0 },
            { x: 300, y: 0, i: 3, j: 0, cost: 3, distance: 9, cover: 0 }
        ]),
        actions: [RANGED_ACTION, MELEE_ACTION]
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    const plan = result.plan;
    assert.equal(plan.breakdown.variant, "move-attack");
    assert.equal(plan.breakdown.factors.moveToLos, 1);
    assert.equal(plan.steps[0].type, "move");
    assert.deepEqual(plan.steps[0].input.to, { x: 900, y: 600, i: 9, j: 6 });
    assert.ok(plan.steps.some(step => step.type === "attack"));
    // The blocked standing shot and the still-blocked endpoint are vetoed.
    const vetoed = plan.diagnostics.rejected.filter(entry => entry.reason === HOLD_VETO_NO_LOS);
    assert.ok(vetoed.length >= 2);
    assert.ok(vetoed.some(entry => entry.candidate.startsWith("attack-in-place|")));
});

test("no useful action keeps the position with a hold reason", async () => {
    // Enemy visible but far beyond weapon range; endpoints inside the
    // radius reach nothing, so the guard simply holds.
    const world = makeWorld({ enemies: [{ x: 3000, y: 0 }] });
    const planner = makePlanner();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 5,
        perception: makePerception({ visible: visibleTargets(world) }),
        navigation: makeNavigation([
            { x: 300, y: 0, i: 3, j: 0, cost: 3, distance: 40.5, los: true },
            { x: 200, y: 200, i: 2, j: 2, cost: 3, distance: 42, los: true }
        ]),
        actions: [RANGED_ACTION]
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    const plan = result.plan;
    // Issue #15: declaring an overwatch cone on the threat bearing or
    // aiming down it is a stationary "hold" too — passive hold, aim and
    // overwatch are the legal outcomes; nothing moves.
    assert.ok(["hold", "aim", "overwatch"].includes(plan.breakdown.variant));
    assert.ok(plan.steps.every(step => step.type !== "move"));
    assert.ok(plan.steps.every(step => step.type !== "attack"));
});

test("movement outside the hold radius is vetoed", async () => {
    // Explicit anchor on the actor config: every offered endpoint leaves
    // the radius, so the NPC holds and the veto is recorded.
    const world = makeWorld({ enemies: [{ x: 3000, y: 0 }] });
    world.actor.flags["only-war-ai"].config.hold = {
        anchor: { x: 0, y: 0 },
        radiusMeters: 6
    };
    const planner = makePlanner();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 5,
        perception: makePerception({ visible: visibleTargets(world) }),
        navigation: makeNavigation([
            { x: 900, y: 0, i: 9, j: 0, cost: 9, distance: 31.5, los: true }
        ]),
        actions: [RANGED_ACTION]
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    const plan = result.plan;
    // The NPC stays inside the radius — hold, aim or a watch cone;
    // every offered move is vetoed and recorded.
    assert.ok(["hold", "aim", "overwatch"].includes(plan.breakdown.variant));
    assert.equal(plan.breakdown.zone.configured, true);
    assert.ok(plan.steps.every(step => step.type !== "move"));
    assert.ok(plan.diagnostics.rejected.some(entry =>
        entry.reason === HOLD_VETO_OUTSIDE_RADIUS));
});

test("a hostile in melee contact is answered, not ignored", async () => {
    // Enemy adjacent (1.5u): attacking it in place is the useful action;
    // the breakdown records the melee contact either way.
    const world = makeWorld({ enemies: [{ x: 100, y: 0, threat: 0.8 }] });
    const planner = makePlanner();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 9,
        perception: makePerception({ visible: visibleTargets(world) }),
        navigation: makeNavigation([
            { x: -100, y: 0, i: -1, j: 0, cost: 1, distance: 3, los: true }
        ]),
        actions: [MELEE_ACTION, RANGED_ACTION]
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    const plan = result.plan;
    assert.ok(["attack-in-place", "aim-attack"].includes(plan.breakdown.variant));
    assert.equal(plan.breakdown.position.meleeContact, true);
    const meleeAttack = plan.steps.find(step => step.type === "attack");
    assert.ok(meleeAttack, "attack step exists");
    assert.equal(meleeAttack.input.actionId, "sword");
    // A retreating move-attack candidate was scored with the escape
    // factor instead of being the plan.
    assert.ok(plan.diagnostics.ranking.length >= 1);
});

test("a token outside its radius returns to the nearest legal cell", async () => {
    // NPC drifted to 18u from the anchor (radius 6): the inside-radius
    // endpoint that keeps the shot beats staying and firing.
    const world = makeWorld({
        enemies: [{ x: -600, y: 0 }],
        selfPos: { x: 1200, y: 0 }
    });
    const planner = makePlanner();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 3,
        hold: { anchor: { x: 0, y: 0 }, radiusMeters: 6 },
        perception: makePerception({ visible: visibleTargets(world) }),
        navigation: makeNavigation([
            { x: 300, y: 0, i: 3, j: 0, cost: 9, distance: 13.5, los: true },
            { x: 900, y: 0, i: 9, j: 0, cost: 3, distance: 22.5, los: true }
        ]),
        actions: [RANGED_ACTION]
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    const plan = result.plan;
    assert.equal(plan.breakdown.variant, "move-attack");
    assert.equal(plan.breakdown.factors.returnToZone, 1);
    assert.equal(plan.breakdown.zone.insideRadius, true);
    const move = plan.steps.find(step => step.type === "move");
    assert.deepEqual(move.input.to, { x: 300, y: 0, i: 3, j: 0 });
    assert.ok(plan.steps.some(step => step.type === "attack"));
    // The endpoint outside the radius was vetoed outright.
    assert.ok(plan.diagnostics.rejected.some(entry =>
        entry.reason === HOLD_VETO_OUTSIDE_RADIUS));
});

test("a last-known contact inside the radius is a low-weight search move", async () => {
    const world = makeWorld({ enemies: [] });
    const planner = makePlanner();
    const lastKnown = {
        tokenId: "lost-enemy",
        tokenUuid: `Scene.${world.scene.id}.Token.lost-enemy`,
        x: 300,
        y: 0,
        elevation: 0
    };
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 5,
        hold: { anchor: { x: 0, y: 0 }, radiusMeters: 9 },
        perception: makePerception({ lastKnown: [lastKnown] }),
        navigation: makeNavigation([
            { x: 200, y: 0, i: 2, j: 0, cost: 2, distance: 1.5, los: true }
        ]),
        actions: [RANGED_ACTION]
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    const plan = result.plan;
    assert.equal(plan.breakdown.variant, "approach");
    assert.equal(plan.breakdown.factors.searchMove, 1);
    assert.ok(plan.steps.every(step => step.type !== "attack"));
    assert.equal(plan.steps.at(-1).input.reason, "no-attack");
});

test("a last-known contact outside the radius is never pursued", async () => {
    const world = makeWorld({ enemies: [] });
    const planner = makePlanner();
    const lastKnown = {
        tokenId: "lost-enemy",
        tokenUuid: `Scene.${world.scene.id}.Token.lost-enemy`,
        x: 3000,
        y: 0,
        elevation: 0
    };
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 5,
        hold: { anchor: { x: 0, y: 0 }, radiusMeters: 9 },
        perception: makePerception({ lastKnown: [lastKnown] }),
        navigation: makeNavigation([
            { x: 200, y: 0, i: 2, j: 0, cost: 2, distance: 42, los: true }
        ]),
        actions: [RANGED_ACTION]
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    const plan = result.plan;
    // No move toward the remembered contact — the NPC holds or watches.
    assert.ok(plan.steps.every(step => step.type !== "move"));
    assert.ok(plan.diagnostics.rejected.some(entry =>
        entry.reason === HOLD_VETO_OUTSIDE_RADIUS));
});

test("an unusable configured anchor vetoes movement into a safe hold", async () => {
    // The anchor points at another scene: every move is rejected with
    // `invalid-anchor` and the NPC holds its current position.
    const world = makeWorld({ enemies: [{ x: 3000, y: 0 }] });
    const planner = makePlanner();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 5,
        hold: { anchor: { sceneId: "other-scene", x: 0, y: 0 }, radiusMeters: 9 },
        perception: makePerception({ visible: visibleTargets(world) }),
        navigation: makeNavigation([
            { x: 300, y: 0, i: 3, j: 0, cost: 3, distance: 40.5, los: true }
        ]),
        actions: [RANGED_ACTION]
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    const plan = result.plan;
    assert.equal(plan.breakdown.zone.status, HOLD_VETO_INVALID_ANCHOR);
    assert.ok(plan.steps.every(step => step.type !== "move"));
    assert.ok(plan.diagnostics.rejected.some(entry =>
        entry.reason === HOLD_VETO_INVALID_ANCHOR));
});

test("no contacts produce a safe hold plan with a reason", async () => {
    const world = makeWorld({ enemies: [] });
    const planner = makePlanner();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 5,
        targets: [],
        actions: [RANGED_ACTION]
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    const plan = result.plan;
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].type, "end-turn");
    assert.equal(plan.steps[0].input.reason, "hold-position");
});

test("aim availability marks attack-in-place plans", async () => {
    const world = makeWorld({ enemies: [{ x: 600, y: 0 }] });
    const planner = makePlanner();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 7,
        perception: makePerception({ visible: visibleTargets(world) }),
        navigation: makeNavigation([]),
        actions: [
            RANGED_ACTION,
            { id: "aim", type: "test", name: "Aim", aim: true }
        ]
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    const plan = result.plan;
    assert.ok(["attack-in-place", "aim-attack"].includes(plan.breakdown.variant));
    assert.equal(plan.breakdown.aimAvailable, true);
    assert.ok(plan.steps.some(step => step.type === "attack"));
});

test("planTurn is deterministic for identical input and seed", async () => {
    const wall = makeWall([450, -200, 450, 200]);
    const world = makeWorld({ enemies: [{ x: 900, y: 0 }], walls: [wall] });
    const context = () => ({
        seed: 42,
        hold: { anchor: { x: 0, y: 0 }, radiusMeters: 20 },
        perception: makePerception({ visible: visibleTargets(world) }),
        navigation: makeNavigation([
            { x: 900, y: 600, i: 9, j: 6, cost: 11, distance: 9, los: true, cover: 0.5 },
            { x: 200, y: 0, i: 2, j: 0, cost: 2, distance: 10.5, cover: 0 }
        ]),
        actions: [RANGED_ACTION, MELEE_ACTION]
    });
    const first = await makePlanner().planTurn(world.combat, world.combatant, context());
    const second = await makePlanner().planTurn(world.combat, world.combatant, context());
    assert.equal(first.status, PLANNER_STATUS.ok);
    assert.equal(JSON.stringify(first.plan), JSON.stringify(second.plan));
    // The full plan (breakdown included) survives a JSON round-trip.
    assert.deepEqual(JSON.parse(JSON.stringify(first.plan)), first.plan);
});

test("score breakdown explains the zone constraint per candidate", async () => {
    const world = makeWorld({ enemies: [{ x: 600, y: 0 }] });
    const planner = makePlanner();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 5,
        hold: { anchor: { x: 0, y: 0 }, radiusMeters: 9 },
        perception: makePerception({ visible: visibleTargets(world) }),
        navigation: makeNavigation([
            { x: 300, y: 0, i: 3, j: 0, cost: 3, distance: 4.5, los: true }
        ]),
        actions: [RANGED_ACTION]
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    const plan = result.plan;
    assert.equal(plan.breakdown.preset, HOLD_PRESET_ID);
    assert.ok(plan.breakdown.factors);
    assert.equal(plan.breakdown.zone.status, "ok");
    assert.equal(plan.breakdown.zone.radius, 9);
    assert.equal(plan.breakdown.zone.anchorDistance, 0);
    assert.equal(plan.breakdown.zone.insideRadius, true);
    assert.equal(plan.diagnostics.weights.holdPosition, HOLD_WEIGHTS.holdPosition);
    assert.ok(plan.diagnostics.metrics.targetsEvaluated >= 1);
    assert.ok(plan.diagnostics.ranking.length >= 1);
    assert.equal(plan.diagnostics.candidatesCount, plan.diagnostics.ranking.length);
});
