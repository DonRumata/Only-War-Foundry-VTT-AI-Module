/**
 * Unit tests for the assault preset «Штурм» (issue #404): legal charge
 * selection, blocked charge exclusion, move+ranged fallback, hold on
 * missing contacts, last-known search, over-budget actions, determinism
 * and diagnostics — all through `planner.planTurn` with mocked
 * perception/navigation services.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    PLANNER_STATUS,
    createPlannerService
} from "../../scripts/planner.js";
import {
    ASSAULT_PRESET_ID,
    ASSAULT_WEIGHTS,
    registerAssaultPreset
} from "../../scripts/presets/assault.js";
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
        id: `assault-combat-${++_combatId}`,
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
    class: "ranged",
    range: 30,
    damage: 6
};

/**
 * Assault-enabled planner for tests.
 * @returns {object} Planner service with the real assault preset.
 */
function makePlanner() {
    const planner = createPlannerService();
    registerAssaultPreset(planner);
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
 * Build a small combat world: an assault-enabled NPC at the origin on a
 * square grid (size 100, 1.5 units per cell) plus hostile enemies.
 * @param {object} [options]
 * @param {object[]} [options.enemies] `{x, y, threat?}` enemy placements.
 * @returns {object}
 */
function makeWorld({ enemies = [{ x: 300, y: 0 }] } = {}) {
    const scene = makeScene({ grid: "square" });
    const actor = makeActor({ enabled: true, preset: "assault" });
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

test("registerAssaultPreset installs the preset with data-driven weights", () => {
    const planner = createPlannerService();
    const stored = registerAssaultPreset(planner);
    assert.equal(stored.id, ASSAULT_PRESET_ID);
    assert.equal(planner.getPreset(ASSAULT_PRESET_ID).weights.charge, ASSAULT_WEIGHTS.charge);
    assert.equal(stored.allowNoTarget, true);
    assert.equal(stored.allowNoAction, true);
    assert.throws(() => registerAssaultPreset(null));
});

test("legal charge beats approach and ranged attack-in-place", async () => {
    // Enemy at 4.5u — inside lasgun range but out of melee; the route to
    // x=200 lands 1.5u from the target, inside chainsword reach.
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }] });
    const planner = makePlanner();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 11,
        perception: makePerception({ visible: visibleTargets(world) }),
        navigation: makeNavigation([
            { x: 200, y: 0, i: 2, j: 0, cost: 2, distance: 1.5, los: true },
            { x: 100, y: 0, i: 1, j: 0, cost: 1, distance: 3, los: true }
        ]),
        actions: [MELEE_ACTION, RANGED_ACTION]
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    const plan = result.plan;
    assert.equal(plan.preset, "assault");
    assert.equal(plan.breakdown.variant, "charge");
    assert.equal(plan.breakdown.factors.charge, 1);
    assert.equal(plan.steps.length, 3);
    assert.equal(plan.steps[0].type, "move");
    assert.deepEqual(plan.steps[0].input.to, { x: 200, y: 0, i: 2, j: 0 });
    assert.equal(plan.steps[1].type, "attack");
    assert.equal(plan.steps[1].input.actionId, "sword");
    assert.equal(plan.steps[1].input.mode, "charge");
    assert.equal(plan.steps[2].type, "end-turn");
    // Charge outranks both the approach move and the in-place lasgun shot.
    const ranking = plan.diagnostics.ranking.map(entry => entry.candidate);
    assert.ok(ranking.some(id => id.startsWith("charge|")));
    assert.ok(ranking.some(id => id.startsWith("attack-in-place|")));
    assert.ok(ranking.some(id => id.startsWith("approach|")));
    assert.ok(ranking[0].startsWith("charge|"));
});

test("blocked charge is excluded — falls back to the best available attack", async () => {
    // Same enemy but the only routes end outside melee reach (a wall
    // blocks the charge lane): no charge candidate may be produced.
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }] });
    const planner = makePlanner();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 11,
        perception: makePerception({ visible: visibleTargets(world) }),
        navigation: makeNavigation([
            { x: -100, y: 0, i: -1, j: 0, cost: 1, distance: 6, los: true }
        ]),
        actions: [MELEE_ACTION, RANGED_ACTION]
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    const plan = result.plan;
    assert.ok(plan.steps.every(step => step.input.mode !== "charge"));
    const attack = plan.steps.find(step => step.type === "attack");
    assert.ok(attack, "an attack step exists");
    assert.equal(attack.input.actionId, "lasgun");
    const rejected = plan.diagnostics.rejected.map(entry => entry.candidate);
    assert.ok(rejected.some(id => id.startsWith("charge|")));
    assert.ok(plan.diagnostics.rejected.some(entry =>
        entry.candidate.startsWith("charge|") && entry.reason === "out-of-range"));
});

test("far target falls back to move + ranged attack", async () => {
    // Enemy at 45u — beyond lasgun range from the start, reachable inside
    // 13.5u after the move; melee charge is out of scope for the budget.
    const world = makeWorld({ enemies: [{ x: 3000, y: 0 }] });
    const planner = makePlanner();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 5,
        perception: makePerception({ visible: visibleTargets(world) }),
        navigation: makeNavigation([
            { x: 2100, y: 0, i: 21, j: 0, cost: 21, distance: 13.5, los: true },
            { x: 1500, y: 0, i: 15, j: 0, cost: 15, distance: 22.5, los: true }
        ]),
        actions: [MELEE_ACTION, RANGED_ACTION]
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    const plan = result.plan;
    assert.equal(plan.breakdown.variant, "move-attack");
    assert.equal(plan.steps[0].type, "move");
    assert.equal(plan.steps[0].input.to.x, 2100);
    const attack = plan.steps.find(step => step.type === "attack");
    assert.equal(attack.input.actionId, "lasgun");
    assert.equal(attack.input.mode, undefined);
    assert.equal(plan.steps.at(-1).type, "end-turn");
});

test("range-edge probe supplies half-move move-attack endpoints for far targets", async () => {
    // Enemy at 45u — outside lasgun range. The proximity top-N only holds
    // cells nearest the target (cost 27 — beyond the half-move cap), so a
    // legal move+attack needs the range-edge probe: it returns the cheap
    // cell at ~0.9×range that is reachable on a half move.
    const world = makeWorld({ enemies: [{ x: 3000, y: 0 }] });
    const planner = makePlanner();
    const findCalls = [];
    const navigation = {
        findCandidates: (_token, _budget, options = {}) => {
            findCalls.push(options.target);
            // The edge probe point sits ~1800 px from the target toward
            // the viewer — only that call gets the cheap firing cell
            // (tolerance for float math in the probe computation).
            if (options.target && Math.abs(options.target.x - 1200) < 1) {
                return {
                    status: "ok",
                    candidates: [
                        { x: 1200, y: 0, i: 12, j: 0, cost: 12, distance: null, los: true }
                    ]
                };
            }
            return {
                status: "ok",
                candidates: [
                    { x: 2700, y: 0, i: 27, j: 0, cost: 27, distance: 13.5, los: true }
                ]
            };
        }
    };
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 5,
        halfMove: 12,
        rates: { half: 12, full: 24 },
        perception: makePerception({ visible: visibleTargets(world) }),
        navigation,
        actions: [MELEE_ACTION, RANGED_ACTION]
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.equal(result.plan.breakdown.variant, "move-attack");
    assert.equal(result.plan.steps[0].type, "move");
    assert.equal(result.plan.steps[0].input.to.x, 1200);
    const attack = result.plan.steps.find(step => step.type === "attack");
    assert.equal(attack.input.actionId, "lasgun");
    // The edge probe really fired: one findCandidates call targets a
    // point between viewer and target, not the target position itself.
    assert.ok(findCalls.some(target => target && Math.abs(target.x - 1200) < 1));
});

test("advance-only plan ends with no-attack when nothing can fire", async () => {
    // Enemy visible but far beyond every weapon and beyond charge reach:
    // the NPC closes distance and ends the turn without a forced attack.
    const world = makeWorld({ enemies: [{ x: 9000, y: 0 }] });
    const planner = makePlanner();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 5,
        personality: false,
        perception: makePerception({ visible: visibleTargets(world) }),
        navigation: makeNavigation([
            { x: 800, y: 0, i: 8, j: 0, cost: 8, distance: 123, los: true }
        ]),
        actions: [MELEE_ACTION, RANGED_ACTION]
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    const plan = result.plan;
    assert.equal(plan.breakdown.variant, "approach");
    assert.equal(plan.steps[0].type, "move");
    assert.ok(plan.steps.every(step => step.type !== "attack"));
    assert.equal(plan.steps.at(-1).input.reason, "no-attack");
});

test("unreachable target yields no-route with rejected diagnostics", async () => {
    const world = makeWorld({ enemies: [{ x: 9000, y: 0 }] });
    const planner = makePlanner();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 5,
        perception: makePerception({ visible: visibleTargets(world) }),
        navigation: makeNavigation([], "no-route"),
        actions: [MELEE_ACTION]
    });

    // Melee-only loadout: no utility fallback applies to a ranged-less
    // NPC (aim/overwatch need a ranged action), so no-route stands.
    assert.equal(result.status, PLANNER_STATUS.noRoute);
    assert.equal(result.reason, "no-route");
    assert.equal(result.plan, null);
    assert.ok(result.diagnostics.rejected.length >= 1);
    assert.ok(result.diagnostics.rejected.every(entry => entry.candidate && entry.reason));
    assert.ok(result.diagnostics.rejected.some(entry => entry.reason === "no-route"));
});

test("no contacts produce a safe hold plan with a reason", async () => {
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }] });
    const planner = makePlanner();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 5,
        targets: [],
        actions: [MELEE_ACTION, RANGED_ACTION]
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    const plan = result.plan;
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].type, "end-turn");
    assert.equal(plan.steps[0].input.reason, "hold-position");
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
        actions: [MELEE_ACTION, RANGED_ACTION]
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    const plan = result.plan;
    assert.equal(plan.breakdown.variant, "approach");
    assert.ok(plan.steps.every(step => step.type !== "attack"));
    assert.equal(plan.steps.at(-1).input.reason, "no-attack");
    assert.equal(plan.snapshot.targets[0].source, "last-known");
    assert.ok(plan.diagnostics.rejected.some(entry => entry.reason === "target-not-attackable"));
});

test("actions over the action budget are rejected, not charged", async () => {
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }] });
    const planner = makePlanner();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 5,
        perception: makePerception({ visible: visibleTargets(world) }),
        navigation: makeNavigation([
            { x: 200, y: 0, i: 2, j: 0, cost: 2, distance: 1.5, los: true }
        ]),
        actions: [
            { ...MELEE_ACTION, id: "cleaver", name: "Heavy Cleaver", damage: 12, cost: 3 },
            MELEE_ACTION
        ]
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    const plan = result.plan;
    assert.ok(plan.diagnostics.rejected.some(entry =>
        entry.reason === "over-budget" && entry.candidate.includes("cleaver")));
    // The affordable melee action still produces the charge plan.
    assert.equal(plan.breakdown.variant, "charge");
    assert.equal(plan.steps[1].input.actionId, "sword");
});

test("planTurn is deterministic for identical input and seed", async () => {
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }, { x: -300, y: 0 }] });
    const context = () => ({
        seed: 42,
        perception: makePerception({ visible: visibleTargets(world) }),
        navigation: makeNavigation([
            { x: 200, y: 0, i: 2, j: 0, cost: 2, distance: 1.5, los: true },
            { x: -200, y: 0, i: -2, j: 0, cost: 2, distance: 1.5, los: true }
        ]),
        actions: [MELEE_ACTION, RANGED_ACTION]
    });
    const first = await makePlanner().planTurn(world.combat, world.combatant, context());
    const second = await makePlanner().planTurn(world.combat, world.combatant, context());
    assert.equal(first.status, PLANNER_STATUS.ok);
    assert.equal(JSON.stringify(first.plan), JSON.stringify(second.plan));
    // The full plan (breakdown included) survives a JSON round-trip.
    assert.deepEqual(JSON.parse(JSON.stringify(first.plan)), first.plan);
});

test("score breakdown explains the charge pick per factor", async () => {
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }] });
    const planner = makePlanner();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 5,
        personality: false,
        perception: makePerception({ visible: visibleTargets(world) }),
        navigation: makeNavigation([
            { x: 200, y: 0, i: 2, j: 0, cost: 2, distance: 1.5, los: true }
        ]),
        actions: [MELEE_ACTION, RANGED_ACTION]
    });

    assert.equal(result.status, PLANNER_STATUS.ok);
    const breakdown = result.plan.breakdown;
    assert.equal(breakdown.preset, "assault");
    assert.ok(breakdown.factors);
    assert.equal(breakdown.factors.charge, 1);
    assert.equal(breakdown.factors.melee, 1);
    assert.ok(breakdown.contributions.charge > 0);
    assert.equal(result.plan.diagnostics.weights.charge, ASSAULT_WEIGHTS.charge);
    assert.ok(result.plan.diagnostics.metrics.targetsEvaluated >= 1);
});
