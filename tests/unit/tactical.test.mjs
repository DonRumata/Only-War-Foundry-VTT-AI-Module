/**
 * Unit tests for the tactical layer (issue #16): the threat-map danger
 * field and its `danger` scoring factor, the 2-ply lookahead counter
 * model, `aiDifficulty` gating plus the easy-mode deliberate slip, and
 * the TeamPlan kill-EV convergence.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { FLAG_KEYS, MODULE_ID } from "../../scripts/constants.js";
import {
    FIRETEAM_STATUS,
    createFireteamService
} from "../../scripts/fireteam.js";
import {
    PLANNER_STATUS,
    createPlannerService
} from "../../scripts/planner.js";
import {
    DEFAULT_MELEE_REACH,
    buildThreatMap,
    createThreatMapService,
    expectedCounterDamage,
    expectedDamageOf,
    threatSourcesOf,
    weaponEmitters
} from "../../scripts/threat-map.js";
import {
    makeActor,
    makeCombatant,
    makeScene,
    makeToken
} from "./fixtures.mjs";

let _combatId = 0;

/** Square grid matching the fixture scenes: 100 px cells = 1.5 m. */
const GRID = { size: 100, distance: 1.5 };

/**
 * Minimal Combat fixture matching the planner tests.
 * @param {object} [options]
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
 * A small combat world: an AI-enabled NPC at the origin plus hostile
 * enemy combatants on a square-grid scene.
 * @param {object} [options]
 * @param {object[]} [options.enemies] `{x, y, threat?, items?}`.
 * @returns {object}
 */
function makeWorld({ enemies = [{ x: 3000, y: 0 }] } = {}) {
    const scene = makeScene({ grid: "square" });
    const actor = makeActor({ enabled: true, preset: "hold" });
    actor.system = { wounds: { value: 12, max: 14 } };
    actor.items = [{
        id: "w1",
        uuid: `Actor.${actor.id}.Item.w1`,
        name: "Lasgun",
        type: "weapon",
        system: { class: "ranged", range: 100, damage: "1d10+3" }
    }];
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
        enemyActor.items = enemy.items ?? [];
        const enemyToken = makeToken({ actor: enemyActor });
        enemyToken.x = enemy.x;
        enemyToken.y = enemy.y;
        enemyToken.elevation = 0;
        enemyToken.disposition = 1;
        const enemyCombatant = makeCombatant({ actor: enemyActor, token: enemyToken });
        enemyCombatant.tokenId = enemyToken.id;
        return { combatant: enemyCombatant, token: enemyToken, actor: enemyActor };
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
 * @param {object[]} [extras] Per-enemy extra target fields
 *   (`damage`/`range`/`melee`/`wounds`).
 * @returns {object[]}
 */
function injectedTargets(world, extras = []) {
    return world.enemies.map((enemy, index) => ({
        tokenId: enemy.token.id,
        tokenUuid: `Scene.${world.scene.id}.Token.${enemy.token.id}`,
        x: enemy.token.x,
        y: enemy.token.y,
        elevation: 0,
        canAttack: true,
        source: "injected",
        ...(extras[index] ?? {})
    }));
}

/** Ranged lasgun action for injected `context.actions`. */
const LASGUN = {
    id: "las",
    type: "attack",
    name: "Lasgun",
    itemUuid: "Actor.npc.Item.w1",
    itemId: "w1",
    class: "ranged",
    range: 100
};

/**
 * Planner with a `tactical-test` preset registered: move-attacks win,
 * proximity nudges, `danger` is the dominating penalty.
 * @param {object} weights Weight overrides merged over the defaults.
 * @returns {object}
 */
function _plannerWith(weights) {
    const planner = createPlannerService();
    // `hold` is a valid AI_PRESETS id, so the config resolver selects it;
    // re-registering replaces the skeleton's weights for this test.
    planner.registerPreset("hold", {
        weights: {
            // Neutralize everything unrelated to the tested mechanic:
            // synthesized aim/overwatch turns, utility markers and the
            // geometric factors that would otherwise dominate.
            proximity: 0,
            advance: 0,
            threat: 0,
            los: 0,
            cover: 0,
            exposure: 0,
            holdPosition: 0,
            attackType: 0,
            vulnerable: 0,
            budgetOver: 0,
            aim: -50,
            aimAlone: -50,
            overwatch: -50,
            reload: 0,
            ...weights
        }
    });
    return planner;
}

/* ------------------------------------------------------------------ */
/* Threat map                                                          */
/* ------------------------------------------------------------------ */

test("expectedDamageOf evaluates dice formulas to their deterministic mean", () => {
    assert.equal(expectedDamageOf(8), 8);
    assert.equal(expectedDamageOf("1d10+3"), 8.5);
    assert.equal(expectedDamageOf("2d5-1"), 5);
    assert.equal(expectedDamageOf({ formula: "1d5" }), 3);
    assert.equal(expectedDamageOf("garbage"), 0);
    assert.equal(expectedDamageOf(null), 0);
});

test("weaponEmitters derives ranged and melee emitters from actor items", () => {
    const actor = {
        items: [
            { type: "weapon", system: { class: "ranged", range: 100, damage: "1d10+3" } },
            { type: "weapon", system: { class: "melee", damage: "1d10+5" } },
            { type: "talent", system: {} },
            { type: "weapon", system: { class: "ranged", range: 50, damage: "0" } }
        ]
    };
    const emitters = weaponEmitters(actor);
    assert.equal(emitters.length, 2);
    // Best EV first: the melee weapon (10.5) beats the lasgun (8.5).
    assert.equal(emitters[0].melee, true);
    assert.equal(emitters[0].range, DEFAULT_MELEE_REACH);
    assert.equal(emitters[1].ev, 8.5);
    assert.equal(emitters[1].range, 100);
    assert.deepEqual(weaponEmitters(null), []);
});

test("buildThreatMap dangerAt covers ranged emitters with a range falloff", () => {
    const map = buildThreatMap({
        threats: [{ x: 3000, y: 0, ev: 10, range: 30 }],
        grid: GRID,
        los: false
    });
    // 1000 px = 15 m — inside the full-strength half of the 30 m reach.
    assert.equal(map.dangerAt({ x: 2000, y: 0 }), 1);
    // 25 m — the far band decays linearly to zero at the reach edge.
    const far = map.dangerAt({ x: 1340, y: 0 });
    assert.ok(far > 0.2 && far < 0.5, `expected ~0.33, got ${far}`);
    // 3300 px away = 49.5 m — beyond the 30 m reach.
    assert.equal(map.dangerAt({ x: -300, y: 0 }), 0);
    assert.equal(map.dangerAt({ x: 3000, y: 0 }), 1);
    assert.equal(map.dangerAt(null), 0);
});

test("threat sources: memory/relay contacts shade at reduced weight (smoke)", () => {
    // Smoke finding: a hearsay contact printed full-strength heat. The
    // weight ladder mirrors the scoring convention — direct sighting 1,
    // own memory 0.5, squad relay 0.25.
    const targets = [
        { tokenId: "a", tokenUuid: "u-a", x: 3000, y: 0, name: "Vis",
            source: "visible", damage: 10, range: 30 },
        { tokenId: "b", tokenUuid: "u-b", x: 3000, y: 0, name: "Mem",
            source: "last-known", damage: 10, range: 30 },
        { tokenId: "c", tokenUuid: "u-c", x: 3000, y: 0, name: "Rel",
            source: "relay", damage: 10, range: 30 }
    ];
    const sources = threatSourcesOf(targets, {});
    assert.equal(sources.length, 3);
    const map = buildThreatMap({ threats: sources, grid: GRID, los: false });
    const byId = Object.fromEntries(
        map.explain({ x: 3000, y: 0 }).map(e => [e.id, e.contribution]));
    assert.equal(byId["u-a"], 1);
    assert.equal(byId["u-b"], 0.5);
    assert.equal(byId["u-c"], 0.25);
    // An explicit profile weight still wins over the source default.
    const custom = threatSourcesOf([{ tokenId: "d", tokenUuid: "u-d",
        x: 3000, y: 0, source: "relay", weight: 0.8, damage: 10, range: 30 }], {});
    assert.equal(custom[0].weight, 0.8);
});

test("buildThreatMap: a sight-blocking probe zeroes contributions", () => {
    const threats = [{ x: 3000, y: 0, ev: 10, range: 30 }];
    const open = buildThreatMap({ threats, grid: GRID, los: () => true });
    const walled = buildThreatMap({ threats, grid: GRID, los: () => false });
    assert.equal(open.dangerAt({ x: 2000, y: 0 }), 1);
    assert.equal(walled.dangerAt({ x: 2000, y: 0 }), 0);
});

test("buildThreatMap: contributions saturate at 1 and melee falls off", () => {
    const two = buildThreatMap({
        threats: [
            { x: 3000, y: 0, ev: 5, range: 30 },
            { x: 2500, y: 0, ev: 8, range: 30 }
        ],
        grid: GRID,
        los: false
    });
    // Both sources cover the point at full strength: 0.5 + 0.8 = 1.3 →
    // capped at 1.
    assert.equal(two.dangerAt({ x: 2500, y: 0 }), 1);
    const explain = two.explain({ x: 2500, y: 0 });
    assert.equal(explain.length, 2);

    const melee = buildThreatMap({
        threats: [{ x: 0, y: 0, ev: 10, melee: true }],
        grid: GRID,
        los: false
    });
    // 100 px = 1.5 m ≤ 2 m reach → full strength.
    assert.equal(melee.dangerAt({ x: 100, y: 0 }), 1);
    // 5 m → inside the charge band: 1 − (5 − 2)/6 = 0.5.
    const mid = melee.dangerAt({ x: 333, y: 0 });
    assert.ok(mid > 0.4 && mid < 0.6, `expected ~0.5, got ${mid}`);
    // 20 m → beyond reach + allowance.
    assert.equal(melee.dangerAt({ x: 1333, y: 0 }), 0);
});

test("threat-map service: refresh builds the field once per plan", () => {
    const service = createThreatMapService();
    assert.equal(service.dangerAt({ x: 0, y: 0 }), 0);
    const map = service.refresh({
        threats: [{ x: 3000, y: 0, ev: 10, range: 30 }],
        grid: GRID,
        los: false
    });
    assert.equal(service.map(), map);
    assert.equal(service.dangerAt({ x: 2000, y: 0 }), 1);
    assert.equal(service.dangerAt({ x: -300, y: 0 }), 0);
    // A second refresh swaps the field — one map per plan.
    service.refresh({ threats: [], grid: GRID });
    assert.equal(service.dangerAt({ x: 1000, y: 0 }), 0);
});

test("expectedCounterDamage picks the strongest responding emitter", () => {
    const threats = [
        { x: 3000, y: 0, ev: 20, range: 30 },
        { x: 3000, y: 3000, ev: 50, range: 5 }
    ];
    // The far threat cannot reach; only the 20-EV emitter responds.
    assert.equal(expectedCounterDamage({ x: 1000, y: 0 }, threats,
        { grid: GRID, los: false }), 20);
    // Out of reach of both → no counter.
    assert.equal(expectedCounterDamage({ x: -1000, y: 0 }, threats,
        { grid: GRID, los: false }), 0);
    // A wall between the responder and the point zeroes the counter.
    assert.equal(expectedCounterDamage({ x: 1000, y: 0 }, threats,
        { grid: GRID, los: () => false }), 0);
    // Melee counters inside reach + charge band.
    assert.equal(expectedCounterDamage({ x: 500, y: 0 }, [
        { x: 0, y: 0, ev: 12, melee: true }
    ], { grid: GRID, los: false }), 12);
});

/* ------------------------------------------------------------------ */
/* Planner: danger factor + difficulty gating                          */
/* ------------------------------------------------------------------ */

test("planner: the threat map adds the danger factor to move scoring", async () => {
    const world = makeWorld({ enemies: [{ x: 3000, y: 0 }] });
    const planner = _plannerWith({
        attackNow: 0,
        attackAfterMove: 10,
        proximity: 2,
        danger: -20
    });
    const moves = [
        // Dangerous: 6 m from the enemy, inside its 30 m reach.
        { x: 2600, y: 0, distance: 6, cost: 4, los: true },
        // Safe: 60 m away, beyond the reach.
        { x: -1000, y: 0, distance: 60, cost: 4, los: true }
    ];
    const context = {
        seed: 7,
        actions: [LASGUN],
        targets: injectedTargets(world),
        moves,
        threats: [{ x: 3000, y: 0, ev: 10, range: 30 }],
        los: () => true
    };
    const withMap = await planner.planTurn(world.combat, world.combatant, context);
    assert.equal(withMap.status, PLANNER_STATUS.ok);
    assert.equal(withMap.plan.diagnostics.threatMap.threats, 1);
    const moveStep = withMap.plan.steps.find(step => step.type === "move");
    assert.equal(moveStep.input.to.x, -1000, "danger routes the bot out of the kill lane");
    assert.equal(withMap.plan.breakdown.factors.danger, 0);

    // Same world without the threat map → the closer move wins on proximity.
    const bare = await planner.planTurn(world.combat, world.combatant, {
        ...context,
        threats: undefined,
        threatMap: false
    });
    const bareStep = bare.plan.steps.find(step => step.type === "move");
    assert.equal(bareStep.input.to.x, 2600);
});

test("planner: danger is reported on a covered endpoint", async () => {
    // Enemy only 15 m away — the stay cell is inside the full-strength
    // half of the threat's reach.
    const world = makeWorld({ enemies: [{ x: 1000, y: 0 }] });
    const planner = _plannerWith({ attackNow: 30 });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 3,
        actions: [LASGUN],
        targets: injectedTargets(world),
        moves: [{ x: 0, y: 0, distance: 15, cost: 0, los: true }],
        threats: [{ x: 1000, y: 0, ev: 10, range: 30 }],
        los: () => true
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.equal(result.plan.breakdown.factors.danger, 1);
    assert.equal(result.plan.breakdown.contributions.danger, -1);
});

test("planner: easy difficulty ignores the derived threat field", async () => {
    const world = makeWorld({ enemies: [{ x: 3000, y: 0 }] });
    const planner = _plannerWith({
        attackNow: 0,
        attackAfterMove: 10,
        proximity: 2,
        danger: -20
    });
    const context = {
        seed: 7,
        actions: [LASGUN],
        // Derived threat source via the target's own weapon profile.
        targets: injectedTargets(world, [{ damage: 10, range: 30 }]),
        moves: [
            { x: 2600, y: 0, distance: 6, cost: 4, los: true },
            { x: -1000, y: 0, distance: 60, cost: 4, los: true }
        ],
        los: () => true,
        // No slips: isolate the danger-field gate, not the pick roll.
        easyMistakeChance: 0
    };
    const easy = await planner.planTurn(world.combat, world.combatant, {
        ...context,
        difficulty: "easy"
    });
    assert.equal(easy.status, PLANNER_STATUS.ok);
    assert.equal(easy.plan.diagnostics.difficulty, "easy");
    assert.equal(easy.plan.diagnostics.threatMap, undefined);
    const easyStep = easy.plan.steps.find(step => step.type === "move");
    assert.equal(easyStep.input.to.x, 2600, "easy bots walk into covered lanes");

    const normal = await planner.planTurn(world.combat, world.combatant, {
        ...context,
        difficulty: "normal"
    });
    assert.equal(normal.plan.diagnostics.threatMap.threats, 1);
    const normalStep = normal.plan.steps.find(step => step.type === "move");
    assert.equal(normalStep.input.to.x, -1000);
});

/* ------------------------------------------------------------------ */
/* Lookahead                                                           */
/* ------------------------------------------------------------------ */

/**
 * World + context for the lookahead tests: a move-attack into an enemy's
 * 30 m reach (counter EV 20) vs attacking in place outside the reach.
 * @returns {object}
 */
function _lookaheadSetup() {
    const world = makeWorld({ enemies: [{ x: 3000, y: 0 }] });
    const planner = _plannerWith({
        attackNow: 10,
        attackAfterMove: 11,
        proximity: 0,
        // Isolate the lookahead penalty from the danger factor.
        danger: 0
    });
    const context = {
        seed: 11,
        actions: [LASGUN],
        targets: injectedTargets(world),
        moves: [{ x: 2200, y: 0, distance: 12, cost: 4, los: true }],
        threats: [{ x: 3000, y: 0, ev: 20, range: 30 }],
        los: () => true
    };
    return { world, planner, context };
}

test("planner: lookahead re-scores the top candidates against the counter model", async () => {
    const { world, planner, context } = _lookaheadSetup();
    const result = await planner.planTurn(world.combat, world.combatant, {
        ...context,
        lookahead: true
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.equal(result.plan.steps.find(step => step.type === "move"), undefined,
        "the counter model steers the bot off the exposed move");
    const lookahead = result.plan.diagnostics.lookahead;
    assert.ok(lookahead, "lookahead diagnostics present");
    assert.equal(lookahead.lambda, 0.5);
    const charged = lookahead.entries.find(entry => entry.counterDamage === 20);
    assert.ok(charged, "the covered move is charged the enemy EV");
    assert.ok(charged.adjusted < charged.score);
});

test("planner: lookahead is deterministic and hard enables it by default", async () => {
    const { world, planner, context } = _lookaheadSetup();
    const hard = await planner.planTurn(world.combat, world.combatant, {
        ...context,
        difficulty: "hard"
    });
    assert.equal(hard.plan.steps.find(step => step.type === "move"), undefined);
    const repeat = await planner.planTurn(world.combat, world.combatant, {
        ...context,
        difficulty: "hard"
    });
    assert.equal(JSON.stringify(repeat.plan.steps), JSON.stringify(hard.plan.steps));
    // Normal difficulty leaves the pass off: base scoring wins.
    const normal = await planner.planTurn(world.combat, world.combatant, {
        ...context,
        difficulty: "normal"
    });
    assert.ok(normal.plan.steps.find(step => step.type === "move"));
    assert.equal(normal.plan.diagnostics.lookahead, undefined);
    // An explicit off-switch beats even the hard default.
    const forced = await planner.planTurn(world.combat, world.combatant, {
        ...context,
        difficulty: "hard",
        lookahead: false
    });
    assert.ok(forced.plan.steps.find(step => step.type === "move"));
});

/* ------------------------------------------------------------------ */
/* Difficulty: the easy-mode deliberate slip                           */
/* ------------------------------------------------------------------ */

test("difficulty: easy slips off the argmax with ~30% over a seed series", async () => {
    const world = makeWorld({ enemies: [{ x: 3000, y: 0 }] });
    const planner = _plannerWith({
        attackNow: 10,
        attackAfterMove: 12,
        proximity: 0,
        danger: 0
    });
    const base = {
        actions: [LASGUN],
        targets: injectedTargets(world),
        moves: [{ x: 2200, y: 0, distance: 12, cost: 4, los: true }],
        los: () => true,
        // Personality off: the test measures slip mechanics — a growing
        // trait pool (issue #39 review: `heretic`) shifts seeded picks
        // and makes previously tied candidates score distinctly.
        personality: false
    };
    const serial = plan => JSON.stringify(plan.steps);
    let slips = 0;
    const RUNS = 120;
    for (let seed = 0; seed < RUNS; seed++) {
        const argmax = await planner.planTurn(world.combat, world.combatant, {
            ...base,
            seed,
            difficulty: "normal",
            easyMistakeChance: 0
        });
        const easy = await planner.planTurn(world.combat, world.combatant, {
            ...base,
            seed,
            difficulty: "easy"
        });
        assert.equal(easy.status, PLANNER_STATUS.ok);
        assert.equal(easy.plan.diagnostics.difficulty, "easy");
        // The slip roll is recorded and deterministic per seed.
        const again = await planner.planTurn(world.combat, world.combatant, {
            ...base,
            seed,
            difficulty: "easy"
        });
        assert.equal(serial(again.plan), serial(easy.plan));
        assert.equal(again.plan.diagnostics.easyPick.mistake,
            easy.plan.diagnostics.easyPick.mistake);
        if (serial(easy.plan) !== serial(argmax.plan)) slips++;
    }
    const rate = slips / RUNS;
    assert.ok(rate > 0.15 && rate < 0.5,
        `expected ~30% non-argmax picks, got ${(rate * 100).toFixed(1)}%`);
    // A zeroed chance never slips — pure argmax.
    const never = await planner.planTurn(world.combat, world.combatant, {
        ...base,
        seed: 0,
        difficulty: "easy",
        easyMistakeChance: 0
    });
    assert.equal(never.plan.diagnostics.easyPick.mistake, false);
});

/* ------------------------------------------------------------------ */
/* Fireteam: kill-EV convergence                                       */
/* ------------------------------------------------------------------ */

/**
 * Attach a fireteam flag to a fixture document.
 * @param {object} doc
 * @param {object} flag
 * @returns {object}
 */
function withFireteam(doc, flag) {
    doc.flags[MODULE_ID] = doc.flags[MODULE_ID] ?? {};
    doc.flags[MODULE_ID][FLAG_KEYS.fireteam] = flag;
    return doc;
}

/**
 * Build an AI-enabled fireteam member with a lasgun (EV 8.5, range 100).
 * @param {object} [options]
 * @returns {object}
 */
function makeMember({ fireteam, x = 0, y = 0, initiative = 10, items } = {}) {
    const actor = makeActor({ enabled: true, preset: "assault" });
    actor.system = { wounds: { value: 10, max: 14 } };
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
    token.disposition = -1;
    const combatant = makeCombatant({ actor, token });
    combatant.tokenId = token.id;
    combatant.initiative = initiative;
    if (fireteam) withFireteam(combatant, fireteam);
    return { combatant, token, actor };
}

/**
 * Team world: three members plus one hostile enemy inside weapon reach.
 * @param {object[]} members
 * @param {object} [options]
 * @param {number} [options.wounds] Enemy wounds total.
 * @returns {object}
 */
function makeTeamWorld(members, { wounds = 10, enemyX = 2000 } = {}) {
    const scene = makeScene({ grid: "square" });
    const enemyActor = makeActor();
    enemyActor.system = { wounds: { value: wounds, max: wounds } };
    enemyActor.items = [];
    const enemyToken = makeToken({ actor: enemyActor });
    enemyToken.x = enemyX;
    enemyToken.y = 0;
    enemyToken.disposition = 1;
    const enemy = makeCombatant({ actor: enemyActor, token: enemyToken });
    enemy.tokenId = enemyToken.id;
    const combat = makeCombat({
        combatants: [...members.map(m => m.combatant), enemy]
    });
    combat.scene = scene;
    return { scene, combat, enemy, enemyToken };
}

test("fireteam: kill-EV convergence assigns every capable member the target", async () => {
    const leader = makeMember({ fireteam: { teamId: "alpha" }, x: 0, initiative: 20 });
    const second = makeMember({ fireteam: { teamId: "alpha" }, x: 100, initiative: 15 });
    const third = makeMember({ fireteam: { teamId: "alpha" }, x: 200, initiative: 5 });
    // Three lasguns × 8.5 EV = 25.5 ≥ 10 wounds → convergent objective.
    const world = makeTeamWorld([leader, second, third], { wounds: 10 });
    const service = createFireteamService({ planner: createPlannerService() });
    const result = await service.buildTeamPlan(world.combat, {
        teamId: "alpha",
        leaderId: leader.combatant.id
    }, {
        seed: 5,
        targets: [{ tokenId: world.enemyToken.id, x: 2000, y: 0, wounds: 10 }]
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    const plan = result.teamPlan;
    assert.ok(plan.convergence, "convergence descriptor present");
    assert.equal(plan.convergence.targetId, world.enemyToken.id);
    assert.equal(plan.convergence.wounds, 10);
    assert.ok(plan.convergence.killEV >= 10);
    assert.equal(plan.convergence.capableMembers.length, 3);
    // No flank detachment — the whole team shares the convergent target.
    assert.equal(plan.members.every(m => m.groupId === "main"), true);
    for (const member of plan.members) {
        assert.equal(member.assignedTargetId, world.enemyToken.id);
    }
    assert.equal(plan.diagnostics.convergence.targetId, world.enemyToken.id);
    // Serializable.
    assert.deepEqual(JSON.parse(JSON.stringify(plan.convergence)), plan.convergence);
});

test("fireteam: without a readable kill-EV the team keeps distributing", async () => {
    const leader = makeMember({ fireteam: { teamId: "alpha" }, x: 0, initiative: 20 });
    const second = makeMember({ fireteam: { teamId: "alpha" }, x: 100, initiative: 15 });
    const third = makeMember({ fireteam: { teamId: "alpha" }, x: 200, initiative: 5 });
    const world = makeTeamWorld([leader, second, third], { wounds: 10 });
    const service = createFireteamService({ planner: createPlannerService() });
    // Injected targets without wounds are never converged on.
    const unknown = await service.buildTeamPlan(world.combat, {
        teamId: "alpha"
    }, {
        seed: 5,
        targets: [{ tokenId: world.enemyToken.id, x: 2000, y: 0 }]
    });
    assert.equal(unknown.teamPlan.convergence, null);
    assert.equal(unknown.teamPlan.members.filter(m => m.task === "flank").length, 1);

    // 3 × 8.5 = 25.5 < 40 wounds → no convergence either.
    const tough = await service.buildTeamPlan(world.combat, {
        teamId: "alpha"
    }, {
        seed: 5,
        targets: [{ tokenId: world.enemyToken.id, x: 2000, y: 0, wounds: 40 }]
    });
    assert.equal(tough.teamPlan.convergence, null);
    assert.equal(tough.teamPlan.members.filter(m => m.task === "flank").length, 1);

    // An explicit objective keeps precedence over auto-convergence.
    const ordered = await service.buildTeamPlan(world.combat, {
        teamId: "alpha"
    }, {
        seed: 5,
        targets: [{ tokenId: world.enemyToken.id, x: 2000, y: 0, wounds: 10 }],
        objective: { targetId: "other-target" }
    });
    assert.equal(ordered.teamPlan.convergence, null);
});
