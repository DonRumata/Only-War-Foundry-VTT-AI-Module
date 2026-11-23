/**
 * Unit tests for the ranged-cover preset «Дальний бой с поиском укрытия»
 * (issue #405): covered LOS endpoint beats an exposed one, stay-and-fire
 * on a sufficient position, repositioning when LOS is blocked, weapon
 * range bands, last-known search, melee-less fallback, aim opportunity,
 * determinism and diagnostics — all through `planner.planTurn` with
 * mocked perception/navigation services.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    PLANNER_STATUS,
    createPlannerService
} from "../../scripts/planner.js";
import {
    RANGED_COVER_PRESET_ID,
    RANGED_COVER_VETO_NO_LOS,
    RANGED_COVER_WEIGHTS,
    registerRangedCoverPreset
} from "../../scripts/presets/ranged-cover.js";
import {
    makeActor,
    makeCombatant,
    makeScene,
    makeToken
} from "./fixtures.mjs";

let _combatId = 0;

/**
 * Minimal Combat fixture (mirrors `tests/unit/preset-assault.test.mjs`):
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
        id: `ranged-cover-combat-${++_combatId}`,
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
 * Ranged-cover planner for tests.
 * @returns {object} Planner service with the real ranged-cover preset.
 */
function makePlanner() {
    const planner = createPlannerService();
    registerRangedCoverPreset(planner);
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
 * blocking values. `sight: 0` makes a low wall that grants cover without
 * blocking line of sight.
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
 * Build a small combat world: a rangedCover-enabled NPC at the origin on
 * a square grid (size 100, 1.5 units per cell) plus hostile enemies.
 * @param {object} [options]
 * @param {object[]} [options.enemies] `{x, y, threat?}` enemy placements.
 * @param {object[]} [options.walls] Wall fixtures on the scene.
 * @returns {object}
 */
function makeWorld({ enemies = [{ x: 300, y: 0 }], walls = [] } = {}) {
    const scene = makeScene({ grid: "square" });
    scene.walls = walls;
    const actor = makeActor({ enabled: true, preset: RANGED_COVER_PRESET_ID });
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

    const combat = makeCombat({ round: 1, turn: 0, combatants: [combatant, ...enemyCombatants.map(e => e.combatant)] });
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

test("registerRangedCoverPreset installs the preset with data-driven weights", () => {
    const planner = createPlannerService();
    const stored = registerRangedCoverPreset(planner);
    assert.equal(stored.id, RANGED_COVER_PRESET_ID);
    const registered = planner.getPreset(RANGED_COVER_PRESET_ID);
    assert.equal(registered.weights.cover, RANGED_COVER_WEIGHTS.cover);
    assert.equal(registered.weights.rangeBand, RANGED_COVER_WEIGHTS.rangeBand);
    assert.equal(typeof registered.evaluate, "function");
    assert.equal(typeof registered.veto, "function");
    assert.equal(stored.allowNoTarget, true);
    assert.equal(stored.allowNoAction, true);
    assert.ok(RANGED_COVER_WEIGHTS.cover > 0, "cover weighted positively");
    assert.ok(RANGED_COVER_WEIGHTS.los > 0, "LOS weighted positively");
    assert.ok(RANGED_COVER_WEIGHTS.melee < 0, "melee nearly disallowed");
    assert.throws(() => registerRangedCoverPreset(null));
});

test("covered endpoint with LOS beats an exposed endpoint", async () => {
    // Enemy at 31.5u — just outside lasgun range, so both firing
    // positions require a move; the covered one must win.
    const world = makeWorld({ enemies: [{ x: 2100, y: 0 }] });
    const planner = makePlanner();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 11,
        perception: makePerception({ visible: visibleTargets(world) }),
        navigation: makeNavigation([
            { x: 1500, y: 0, i: 15, j: 0, cost: 15, distance: 9, los: true, cover: 0 },
            { x: 1200, y: 700, i: 12, j: 7, cost: 16, distance: 14.5, los: true, cover: 1 }
        ]),
        actions: [RANGED_ACTION, MELEE_ACTION]
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    const plan = result.plan;
    assert.equal(plan.preset, RANGED_COVER_PRESET_ID);
    assert.equal(plan.breakdown.variant, "move-attack");
    assert.equal(plan.breakdown.position.cover, 1);
    assert.equal(plan.steps[0].type, "move");
    assert.deepEqual(plan.steps[0].input.to, { x: 1200, y: 700, i: 12, j: 7 });
    const attack = plan.steps.find(step => step.type === "attack");
    assert.equal(attack.input.actionId, "lasgun");
    assert.equal(plan.steps.at(-1).type, "end-turn");
    // The in-place shot is out of range and lands in rejected diagnostics.
    assert.ok(plan.diagnostics.rejected.some(entry =>
        entry.candidate.startsWith("attack-in-place|") && entry.reason === "out-of-range"));
});

test("covered endpoint beats staying exposed in the open", async () => {
    // Enemy inside weapon range (9u): firing from the open current cell
    // is legal, but relocating to a covered endpoint is worth more.
    const world = makeWorld({ enemies: [{ x: 600, y: 0 }] });
    const planner = makePlanner();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 7,
        perception: makePerception({ visible: visibleTargets(world) }),
        navigation: makeNavigation([
            { x: 300, y: 400, i: 3, j: 4, cost: 5, distance: 7.5, los: true, cover: 0.8 }
        ]),
        actions: [RANGED_ACTION]
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    const plan = result.plan;
    assert.equal(plan.breakdown.variant, "move-attack");
    assert.equal(plan.steps[0].type, "move");
    assert.equal(plan.steps[0].input.to.x, 300);
    assert.ok(plan.steps.some(step => step.type === "attack"));
});

test("sufficient current position attacks without moving", async () => {
    // Enemy at 9u inside the optimal band; every alternative endpoint is
    // uncovered and offers no positional gain — stay and fire.
    const world = makeWorld({ enemies: [{ x: 600, y: 0 }] });
    const planner = makePlanner();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 7,
        perception: makePerception({ visible: visibleTargets(world) }),
        navigation: makeNavigation([
            { x: 400, y: 300, i: 4, j: 3, cost: 5, distance: 7.5, los: true, cover: 0 },
            { x: -200, y: 0, i: -2, j: 0, cost: 2, distance: 12, los: true, cover: 0 }
        ]),
        actions: [RANGED_ACTION, MELEE_ACTION]
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    const plan = result.plan;
    // A sufficient position attacks in place — plain or aimed (issue #15).
    assert.ok(["attack-in-place", "aim-attack"].includes(plan.breakdown.variant));
    const attack = plan.steps.find(step => step.type === "attack");
    assert.ok(attack, "attack step exists");
    assert.equal(attack.input.actionId, "lasgun");
    assert.ok(plan.steps.every(step => step.type !== "move"));
});

test("blocked LOS repositions to an endpoint with line of sight", async () => {
    // A tall wall sits between the NPC and the enemy 13.5u away: the
    // standing shot is geometrically blocked and vetoed, the flanking
    // endpoint sees the target and wins.
    const wall = makeWall([450, -200, 450, 200]);
    const world = makeWorld({ enemies: [{ x: 900, y: 0 }], walls: [wall] });
    const planner = makePlanner();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 5,
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
    assert.equal(plan.breakdown.position.los, 1);
    assert.equal(plan.steps[0].type, "move");
    assert.deepEqual(plan.steps[0].input.to, { x: 900, y: 600, i: 9, j: 6 });
    assert.ok(plan.steps.some(step => step.type === "attack"));
    // The blocked standing shot and the blocked flank endpoint are both
    // vetoed with the stable no-line-of-sight reason.
    const vetoed = plan.diagnostics.rejected.filter(entry => entry.reason === RANGED_COVER_VETO_NO_LOS);
    assert.ok(vetoed.length >= 2);
    assert.ok(vetoed.some(entry => entry.candidate.startsWith("attack-in-place|")));
});

test("blocked shot with no firing endpoint falls back, never fires blind", async () => {
    // Same wall, but navigation offers nothing with LOS: the only attack
    // is vetoed, so the planner reports no valid plan instead of a shot
    // through the wall.
    const wall = makeWall([450, -200, 450, 200]);
    const world = makeWorld({ enemies: [{ x: 900, y: 0 }], walls: [wall] });
    const planner = makePlanner();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 5,
        perception: makePerception({ visible: visibleTargets(world) }),
        navigation: makeNavigation([], "ok"),
        actions: [RANGED_ACTION]
    });

    // Issue #15: instead of firing blind or ending bare, the NPC aims
    // down the corridor — the blocked shot stays vetoed and recorded.
    assert.equal(result.status, PLANNER_STATUS.ok);
    const plan = result.plan;
    assert.ok(plan.steps.every(step => step.type !== "attack"), "no blind shot");
    assert.ok(plan.diagnostics.rejected.some(entry =>
        entry.reason === RANGED_COVER_VETO_NO_LOS));
});

test("weapon range bands change the firing-position choice", async () => {
    // Enemy at 67.5u with a 30u lasgun: the point-blank endpoint (1.5u)
    // and the extreme edge (30u) both discount versus the optimal
    // middle band (15u).
    const world = makeWorld({ enemies: [{ x: 4500, y: 0 }] });
    const planner = makePlanner();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 3,
        // Personality off: the range-band assertion measures preset
        // weights; a growing trait pool shifts seeded draws and changes
        // the endpoint pick (issue #39 review: `heretic`).
        personality: false,
        perception: makePerception({ visible: visibleTargets(world) }),
        navigation: makeNavigation([
            { x: 4400, y: 0, i: 44, j: 0, cost: 44, distance: 1.5, los: true, cover: 0 },
            { x: 3500, y: 0, i: 35, j: 0, cost: 35, distance: 15, los: true, cover: 0 },
            { x: 2500, y: 0, i: 25, j: 0, cost: 25, distance: 30, los: true, cover: 0 }
        ]),
        actions: [RANGED_ACTION]
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    const plan = result.plan;
    assert.equal(plan.breakdown.variant, "move-attack");
    assert.equal(plan.steps[0].input.to.x, 3500);
    assert.equal(plan.breakdown.position.rangeBand, 1);
    const attack = plan.steps.find(step => step.type === "attack");
    assert.equal(attack.input.actionId, "lasgun");
});

test("last-known contact is a search destination, never an attack target", async () => {
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }] });
    const planner = makePlanner();
    const lastKnown = {
        tokenId: "lost-enemy",
        tokenUuid: `Scene.${world.scene.id}.Token.lost-enemy`,
        x: 1500,
        y: 0,
        elevation: 0
    };
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 5,
        perception: makePerception({ lastKnown: [lastKnown] }),
        navigation: makeNavigation([
            { x: 1000, y: 0, i: 10, j: 0, cost: 10, distance: 7.5, los: true }
        ]),
        actions: [RANGED_ACTION, MELEE_ACTION]
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    const plan = result.plan;
    assert.equal(plan.breakdown.variant, "approach");
    assert.ok(plan.steps.every(step => step.type !== "attack"));
    assert.equal(plan.steps.at(-1).input.reason, "no-attack");
    assert.equal(plan.snapshot.targets[0].source, "last-known");
    assert.ok(plan.diagnostics.rejected.some(entry => entry.reason === "target-not-attackable"));
});

test("no contacts produce a safe hold plan with a reason", async () => {
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }] });
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

test("melee-only loadout falls back to approach instead of brawling", async () => {
    // Enemy 45u out: no ranged weapon means no firing position exists;
    // the preset advances toward the contact and reports no-attack
    // rather than spending a melee charge it cannot land.
    const world = makeWorld({ enemies: [{ x: 3000, y: 0 }] });
    const planner = makePlanner();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 5,
        perception: makePerception({ visible: visibleTargets(world) }),
        navigation: makeNavigation([
            { x: 2500, y: 0, i: 25, j: 0, cost: 25, distance: 7.5, los: true }
        ]),
        actions: [MELEE_ACTION]
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    const plan = result.plan;
    assert.equal(plan.breakdown.variant, "approach");
    assert.equal(plan.steps[0].type, "move");
    assert.ok(plan.steps.every(step => step.type !== "attack"));
    assert.equal(plan.steps.at(-1).input.reason, "no-attack");
});

test("no actions at all produce a safe hold plan", async () => {
    const world = makeWorld({ enemies: [{ x: 3000, y: 0 }] });
    const planner = makePlanner();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 5,
        perception: makePerception({ visible: visibleTargets(world) }),
        navigation: makeNavigation([], "ok"),
        actions: []
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    const plan = result.plan;
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].type, "end-turn");
    assert.equal(plan.steps[0].input.reason, "hold-position");
});

test("aim action availability marks attack-in-place plans", async () => {
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
    const world = makeWorld({ enemies: [{ x: 900, y: 0 }, { x: -2100, y: 0 }], walls: [wall] });
    const context = () => ({
        seed: 42,
        perception: makePerception({ visible: visibleTargets(world) }),
        navigation: makeNavigation([
            { x: 900, y: 600, i: 9, j: 6, cost: 11, distance: 9, los: true, cover: 0.5 },
            { x: -1500, y: 0, i: -15, j: 0, cost: 15, distance: 9, los: true, cover: 0.5 }
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

test("score breakdown explains the position pick per factor", async () => {
    const world = makeWorld({ enemies: [{ x: 600, y: 0 }] });
    const planner = makePlanner();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 5,
        perception: makePerception({ visible: visibleTargets(world) }),
        navigation: makeNavigation([
            { x: 400, y: 300, i: 4, j: 3, cost: 5, distance: 7.5, los: true, cover: 0 }
        ]),
        actions: [RANGED_ACTION]
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    const breakdown = result.plan.breakdown;
    assert.equal(breakdown.preset, RANGED_COVER_PRESET_ID);
    assert.ok(breakdown.factors);
    assert.equal(breakdown.position.los, 1);
    assert.equal(breakdown.position.rangeBand, 1);
    assert.ok(breakdown.contributions.attackNow > 0);
    assert.equal(result.plan.diagnostics.weights.cover, RANGED_COVER_WEIGHTS.cover);
    assert.ok(result.plan.diagnostics.metrics.targetsEvaluated >= 1);
    assert.ok(result.plan.diagnostics.ranking.length >= 1);
    assert.equal(result.plan.diagnostics.candidatesCount,
        result.plan.diagnostics.ranking.length);
});
