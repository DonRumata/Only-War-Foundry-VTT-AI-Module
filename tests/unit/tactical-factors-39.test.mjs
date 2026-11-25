/**
 * Unit tests for issue #39 tactical factors: `alliedEngagement`
 * (shooting into an ally's melee), `leaveMeleeEngage`/`engageDenial`
 * (free-attack awareness), the `unpin` Willpower candidate and the
 * `grudge` factor fed by the `lastAttacker` combatant flag.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    PLANNER_STATUS,
    createPlannerService,
    evaluateFactors
} from "../../scripts/planner.js";
import { registerAssaultPreset } from "../../scripts/presets/assault.js";
import { registerRangedCoverPreset } from "../../scripts/presets/ranged-cover.js";
import {
    GRUDGE_MAX_AGE_ROUNDS,
    attributeLastAttacker,
    createGrudgesService,
    grudgeActive
} from "../../scripts/grudges.js";
import { FLAG_KEYS, MODULE_ID } from "../../scripts/constants.js";
import {
    makeActor,
    makeCombat,
    makeCombatant,
    makeScene,
    makeToken
} from "./fixtures.mjs";

let _combatId = 0;

/**
 * Minimal Combat fixture: the planner needs `id`, `round`, `turn`, the
 * `combatants` collection and a `scene` reference.
 * @param {object} [options]
 * @returns {object}
 */
function makeFight({ round = 1, turn = 0, combatants = [] } = {}) {
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
 * Build a small combat world: an AI-enabled hostile NPC at (0,0) plus
 * enemy combatants placed on a square-grid scene (100 px per cell,
 * 1.5 scene units per cell → DEFAULT_MELEE_RANGE 2 units = ~133 px).
 * @param {object} [options]
 * @param {object[]} [options.enemies] `{x, y, disposition?}` placements.
 * @param {object[]} [options.actions] Injected action records.
 * @param {object} [options.system] Extra actor `system` fields.
 * @returns {object}
 */
function makeWorld({
    enemies = [{ x: 300, y: 0 }],
    actions = null,
    system = {}
} = {}) {
    const scene = makeScene({ grid: "square" });
    const actor = makeActor({ enabled: true, preset: "assault" });
    actor.system = {
        wounds: { value: 5, max: 14 },
        ...system
    };
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
    token.uuid = `Scene.${scene.id}.Token.${token.id}`;
    const combatant = makeCombatant({ actor, token });
    combatant.tokenId = token.id;
    combatant.initiative = 10;

    const enemyCombatants = enemies.map((enemy) => {
        const enemyActor = makeActor();
        enemyActor.system = { wounds: { value: 0, max: 10 } };
        enemyActor.items = [];
        const enemyToken = makeToken({ actor: enemyActor });
        enemyToken.x = enemy.x;
        enemyToken.y = enemy.y;
        enemyToken.elevation = 0;
        enemyToken.disposition = enemy.disposition ?? 1;
        enemyToken.uuid = `Scene.${scene.id}.Token.${enemyToken.id}`;
        const enemyCombatant = makeCombatant({ actor: enemyActor, token: enemyToken });
        enemyCombatant.tokenId = enemyToken.id;
        return { combatant: enemyCombatant, token: enemyToken, actor: enemyActor };
    });

    const combat = makeFight({
        round: 1,
        turn: 0,
        combatants: [combatant, ...enemyCombatants.map(e => e.combatant)]
    });
    combat.scene = scene;
    const defaultActions = actions ?? [{
        id: "lasgun", type: "attack", name: "Lasgun",
        itemUuid: "Actor.npc.Item.w1", itemId: "w1",
        class: "ranged", range: 100
    }];
    return { scene, actor, token, combatant, enemies: enemyCombatants, combat, actions: defaultActions };
}

/**
 * Injected target list matching {@link makeWorld} enemies.
 * @param {object} world
 * @returns {object[]}
 */
function targetsOf(world) {
    return world.enemies.map(enemy => ({
        tokenId: enemy.token.id,
        tokenUuid: enemy.token.uuid,
        actorId: enemy.actor.id,
        x: enemy.token.x,
        y: enemy.token.y,
        elevation: 0,
        canAttack: true,
        source: "injected"
    }));
}

/**
 * Scene token scan entries (`_blastTokens` shape) for world enemies plus
 * extra tokens.
 * @param {object} world
 * @param {object[]} extras `{tokenUuid, x, y, disposition}`.
 * @returns {object[]}
 */
function scanOf(world, extras = []) {
    return [
        ...world.enemies.map(enemy => ({
            tokenUuid: enemy.token.uuid,
            tokenId: enemy.token.id,
            x: enemy.token.x,
            y: enemy.token.y,
            disposition: enemy.token.disposition
        })),
        ...extras
    ];
}

/**
 * Planner with a capture-evaluate preset: every scored candidate's
 * factor vector lands in `captured` while real weighted scoring keeps
 * the winner deterministic.
 * @param {object[]} captured Output array of `{candidate, factors}`.
 * @param {object} [weights] Extra preset weight overrides.
 * @returns {object} Planner service.
 */
function capturingPlanner(captured, weights = {}) {
    const planner = createPlannerService();
    planner.registerPreset("assault", {
        weights: { attackNow: 10, advance: 1, ...weights },
        evaluate({ factors, candidate, weights: w }) {
            captured.push({ candidate, factors });
            return evaluateFactors(factors, w);
        }
    });
    return planner;
}

/**
 * Find the captured factors of a candidate matching `predicate`.
 * @param {object[]} captured
 * @param {Function} predicate
 * @returns {object|null}
 */
function factorsOf(captured, predicate) {
    const hit = captured.find(entry => predicate(entry.candidate));
    return hit ? hit.factors : null;
}

const isAttackOn = enemy => candidate =>
    (candidate.variant === "attack-in-place" || candidate.variant === "aim-attack")
    && candidate.target?.tokenUuid === enemy.token.uuid
    && candidate.action?.id === "lasgun";

/* -------------------------------------------- */
/*  alliedEngagement                             */
/* -------------------------------------------- */

test("ranged attack on a target engaged with an ally is penalized", async () => {
    const engaged = makeWorld({ enemies: [{ x: 300, y: 0 }] });
    const engagedTokens = scanOf(engaged, [
        { tokenUuid: "ally-uuid", x: 360, y: 0, disposition: -1 }
    ]);
    const captured = [];
    const planner = capturingPlanner(captured, { alliedEngagement: -5 });
    const result = await planner.planTurn(engaged.combat, engaged.combatant, {
        seed: 1,
        actions: engaged.actions,
        targets: targetsOf(engaged),
        blastTokens: engagedTokens
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const factors = factorsOf(captured, isAttackOn(engaged.enemies[0]));
    assert.ok(factors, "ranged attack candidate exists");
    assert.equal(factors.alliedEngagement, 1);

    // Same world without the adjacent ally: no engagement factor.
    const clean = makeWorld({ enemies: [{ x: 300, y: 0 }] });
    const cleanCaptured = [];
    const cleanPlanner = capturingPlanner(cleanCaptured);
    const cleanResult = await cleanPlanner.planTurn(clean.combat, clean.combatant, {
        seed: 1,
        actions: clean.actions,
        targets: targetsOf(clean),
        blastTokens: scanOf(clean)
    });
    assert.equal(cleanResult.status, PLANNER_STATUS.ok);
    assert.equal(factorsOf(cleanCaptured, isAttackOn(clean.enemies[0])).alliedEngagement, 0);

    // Real assault preset: the engaged attack scores exactly the −2
    // weight lower than the identical free shot (same candidate set).
    const a = createPlannerService();
    registerAssaultPreset(a);
    const withAlly = await a.planTurn(engaged.combat, engaged.combatant, {
        seed: 3, actions: engaged.actions, targets: targetsOf(engaged),
        blastTokens: engagedTokens
    });
    const b = createPlannerService();
    registerAssaultPreset(b);
    const without = await b.planTurn(clean.combat, clean.combatant, {
        seed: 3, actions: clean.actions, targets: targetsOf(clean),
        blastTokens: scanOf(clean)
    });
    assert.equal(withAlly.plan.breakdown.factors.alliedEngagement, 1);
    assert.equal(without.plan.breakdown.factors.alliedEngagement, 0);
    // The engaged shot carries the full −2 preset contribution.
    assert.equal(withAlly.plan.breakdown.contributions.alliedEngagement, -2,
        "engaged shot is penalized by the preset weight");
    assert.equal(without.plan.breakdown.contributions.alliedEngagement, 0);
});

test("the heretic trait fires into an ally's melee freely (review)", async () => {
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }] });
    const tokens = scanOf(world, [
        { tokenUuid: "ally-uuid", x: 360, y: 0, disposition: -1 }
    ]);
    const captured = [];
    const planner = capturingPlanner(captured, { alliedEngagement: -5 });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        actions: world.actions,
        targets: targetsOf(world),
        blastTokens: tokens,
        personality: ["heretic"]
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.equal(factorsOf(captured, isAttackOn(world.enemies[0])).alliedEngagement, 0,
        "firesIntoMelee zeroes the factor outright");
});

test("a long-reach ally engages beyond the default melee range (review)", async () => {
    // "Ally" = a same-disposition combatant carrying a spear (melee
    // range 3 units ≈ 200px); the enemy stands 140px away — inside the
    // spear reach but outside the default 2-unit reach.
    const world = makeWorld({ enemies: [
        { x: 300, y: 0 },
        { x: 160, y: 0, disposition: -1 }
    ] });
    const ally = world.enemies[1];
    ally.actor.items = [{
        id: "spear", uuid: `Actor.${ally.actor.id}.Item.spear`,
        name: "Spear", type: "weapon",
        system: { class: "melee", range: 3 }
    }];
    const captured = [];
    const planner = capturingPlanner(captured, { alliedEngagement: -5 });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        actions: world.actions,
        targets: targetsOf(world),
        blastTokens: scanOf(world)
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.equal(factorsOf(captured, isAttackOn(world.enemies[0])).alliedEngagement, 1,
        "the spear reach marks the engagement");
});

test("melee, blast and cone attacks are exempt from alliedEngagement", async () => {
    // Enemy in melee reach of both the bot and an adjacent ally.
    const melee = makeWorld({
        enemies: [{ x: 100, y: 0 }],
        actions: [
            { id: "sword", type: "attack", name: "Sword", class: "melee", range: 2 },
            { id: "lasgun", type: "attack", name: "Lasgun", class: "ranged", range: 100 }
        ]
    });
    const tokens = scanOf(melee, [
        { tokenUuid: "ally-uuid", x: 160, y: 0, disposition: -1 }
    ]);
    const captured = [];
    const planner = capturingPlanner(captured);
    const result = await planner.planTurn(melee.combat, melee.combatant, {
        seed: 1,
        actions: melee.actions,
        targets: targetsOf(melee),
        blastTokens: tokens
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const meleeFactors = factorsOf(captured, candidate =>
        candidate.action?.id === "sword" && candidate.target?.tokenUuid === melee.enemies[0].token.uuid);
    assert.ok(meleeFactors, "melee attack candidate exists");
    assert.equal(meleeFactors.alliedEngagement, 0,
        "melee attack is not a point-target ranged attack");

    // Blast: the ally stands inside melee reach of the enemy but outside
    // every safe aim point → the blast candidate exists and is exempt.
    const blast = makeWorld({
        enemies: [{ x: 300, y: 0 }],
        actions: [
            { id: "frag", type: "attack", name: "Frag", class: "ranged", range: 10, blastRadius: 2 },
            { id: "lasgun", type: "attack", name: "Lasgun", class: "ranged", range: 100 }
        ]
    });
    const blastTokens = scanOf(blast, [
        { tokenUuid: "ally-uuid", x: 410, y: 0, disposition: -1 }
    ]);
    const blastCaptured = [];
    const blastPlanner = capturingPlanner(blastCaptured);
    const blastResult = await blastPlanner.planTurn(blast.combat, blast.combatant, {
        seed: 1,
        actions: blast.actions,
        targets: targetsOf(blast),
        blastTokens
    });
    assert.equal(blastResult.status, PLANNER_STATUS.ok);
    const blastFactors = factorsOf(blastCaptured, candidate =>
        candidate.action?.id === "frag" && candidate.aim);
    assert.ok(blastFactors, "blast aim candidate exists");
    assert.equal(blastFactors.alliedEngagement, 0, "blast template is exempt");

    // Cone: flamer sprays the engaged enemy; the ally sits inside melee
    // reach but outside the 30° cone arc.
    const cone = makeWorld({
        enemies: [{ x: 300, y: 0 }],
        actions: [
            { id: "flamer", type: "attack", name: "Flamer", class: "ranged", range: 20, spray: true },
            { id: "lasgun", type: "attack", name: "Lasgun", class: "ranged", range: 100 }
        ]
    });
    const coneTokens = scanOf(cone, [
        { tokenUuid: "ally-uuid", x: 300, y: 100, disposition: -1 }
    ]);
    const coneCaptured = [];
    const conePlanner = capturingPlanner(coneCaptured);
    const coneResult = await conePlanner.planTurn(cone.combat, cone.combatant, {
        seed: 1,
        actions: cone.actions,
        targets: targetsOf(cone),
        blastTokens: coneTokens
    });
    assert.equal(coneResult.status, PLANNER_STATUS.ok);
    const coneFactors = factorsOf(coneCaptured, candidate => candidate.cone);
    assert.ok(coneFactors, "cone candidate exists");
    assert.equal(coneFactors.alliedEngagement, 0, "cone template is exempt");
});

test("neutral allies and the viewer/target themselves do not count", async () => {
    // A neutral token beside the enemy: without includeNeutral it is not
    // an "ally"; with includeNeutral it is tracked and counts.
    const strict = makeWorld({ enemies: [{ x: 300, y: 0 }] });
    const strictTokens = scanOf(strict, [
        { tokenUuid: "neutral-uuid", x: 360, y: 0, disposition: 0 }
    ]);
    const strictCaptured = [];
    const strictPlanner = capturingPlanner(strictCaptured);
    await strictPlanner.planTurn(strict.combat, strict.combatant, {
        seed: 1,
        actions: strict.actions,
        targets: targetsOf(strict),
        blastTokens: strictTokens
    });
    assert.equal(factorsOf(strictCaptured, isAttackOn(strict.enemies[0])).alliedEngagement, 0,
        "neutral without includeNeutral does not mark engagement");

    const allowed = makeWorld({ enemies: [{ x: 300, y: 0 }] });
    const allowedTokens = scanOf(allowed, [
        { tokenUuid: "neutral-uuid", x: 360, y: 0, disposition: 0 }
    ]);
    const allowedCaptured = [];
    const allowedPlanner = capturingPlanner(allowedCaptured);
    await allowedPlanner.planTurn(allowed.combat, allowed.combatant, {
        seed: 1,
        actions: allowed.actions,
        targets: targetsOf(allowed),
        blastTokens: allowedTokens,
        includeNeutral: true
    });
    assert.equal(factorsOf(allowedCaptured, isAttackOn(allowed.enemies[0])).alliedEngagement, 1,
        "neutral with includeNeutral marks engagement");

    // The viewer token and the target token itself never count as the
    // ally: an enemy standing inside the bot's own melee reach and an
    // adjacent hostile token keep alliedEngagement at 0.
    const self = makeWorld({ enemies: [{ x: 100, y: 0 }, { x: 500, y: 0 }] });
    const selfTokens = [
        { tokenUuid: self.token.uuid, tokenId: self.token.id, x: 0, y: 0, disposition: -1 },
        ...scanOf(self, [
            { tokenUuid: "hostile-neighbour", x: 160, y: 0, disposition: 1 }
        ])
    ];
    const selfCaptured = [];
    const selfPlanner = capturingPlanner(selfCaptured);
    await selfPlanner.planTurn(self.combat, self.combatant, {
        seed: 1,
        actions: self.actions,
        targets: targetsOf(self),
        blastTokens: selfTokens
    });
    assert.equal(factorsOf(selfCaptured, isAttackOn(self.enemies[0])).alliedEngagement, 0,
        "the viewer token is not its own ally");
    assert.equal(factorsOf(selfCaptured, isAttackOn(self.enemies[1])).alliedEngagement, 0,
        "a hostile neighbour is not an ally either");
});

/* -------------------------------------------- */
/*  leaveMeleeEngage / engageDenial              */
/* -------------------------------------------- */

test("leaving an enemy's reach marks leaveMeleeEngage on the move", async () => {
    // Enemy A stands inside the bot's melee reach (130 px < 133 px).
    const world = makeWorld({ enemies: [{ x: 130, y: 0 }] });
    const captured = [];
    const planner = capturingPlanner(captured, { leaveMeleeEngage: -4 });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        actions: world.actions,
        targets: targetsOf(world),
        blastTokens: scanOf(world),
        moves: [{ x: -200, y: 0, cost: 1 }]
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const moving = factorsOf(captured, candidate =>
        candidate.variant === "move-attack" && candidate.move && !candidate.move.stay);
    assert.ok(moving, "move-attack candidate exists");
    assert.equal(moving.leaveMeleeEngage, 1, "walking out of reach provokes");
    assert.equal(moving.engageDenial, 0, "already engaged at start");

    const stationary = factorsOf(captured, candidate =>
        candidate.variant === "attack-in-place");
    assert.ok(stationary);
    assert.equal(stationary.leaveMeleeEngage, 0);
    assert.equal(stationary.engageDenial, 0);
});

test("leaving A's reach into B's contact still provokes A (per-enemy)", async () => {
    // A at 130 px (engaged), B at -200 px (out of reach). A candidate
    // ending at -90 px stands inside B's reach but outside A's — the
    // disengage penalty must still fire for enemy A.
    const world = makeWorld({ enemies: [{ x: 130, y: 0 }, { x: -200, y: 0 }] });
    const captured = [];
    const planner = capturingPlanner(captured, { leaveMeleeEngage: -4 });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        actions: world.actions,
        targets: targetsOf(world),
        blastTokens: scanOf(world),
        moves: [{ x: -90, y: 0, cost: 1 }]
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const moving = factorsOf(captured, candidate =>
        candidate.variant === "move-attack"
        && candidate.move && !candidate.move.stay
        && candidate.target?.tokenUuid === world.enemies[0].token.uuid);
    assert.ok(moving, "move-attack candidate on enemy A exists");
    assert.equal(moving.leaveMeleeEngage, 1,
        "ending in B's reach does not cancel the free attack from A");
    assert.equal(moving.engageDenial, 0, "the bot was already engaged");
});

test("ending inside an enemy's reach marks engageDenial", async () => {
    // The bot starts outside every enemy's reach; the move ends inside.
    const world = makeWorld({ enemies: [{ x: -300, y: 0 }] });
    const captured = [];
    const planner = capturingPlanner(captured, { engageDenial: 4 });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        actions: world.actions,
        targets: targetsOf(world),
        blastTokens: scanOf(world),
        moves: [{ x: -190, y: 0, cost: 1 }]
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const moving = factorsOf(captured, candidate =>
        candidate.variant === "move-attack" && candidate.move && !candidate.move.stay);
    assert.ok(moving, "move-attack candidate exists");
    assert.equal(moving.engageDenial, 1, "stepping into contact flags the factor");
    assert.equal(moving.leaveMeleeEngage, 0, "nothing was left behind");
});

/* -------------------------------------------- */
/*  unpin                                        */
/* -------------------------------------------- */

test("a pinned combatant's plan carries the free end-of-turn unpin step", async () => {
    const world = makeWorld({
        enemies: [{ x: 300, y: 0 }],
        system: { characteristics: { willpower: { base: 35 } } }
    });
    const captured = [];
    const planner = capturingPlanner(captured, { unpin: 20 });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        actions: world.actions,
        targets: targetsOf(world),
        blastTokens: scanOf(world),
        selfStatuses: ["pinned"]
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    // Issue #93: unpin never competes as an action candidate — the free
    // end-of-turn test rides every plan instead.
    assert.equal(factorsOf(captured, candidate => candidate.variant === "unpin"), null,
        "no unpin candidate is generated anymore");

    const test = result.plan.steps.find(step => step.type === "test");
    assert.ok(test, "the chosen plan serializes the unpin test step");
    assert.equal(test.input.type, "characteristic");
    assert.equal(test.input.key, "willpower");
    assert.equal(test.input.characteristic, "willpower");
    assert.equal(test.input.actionId, "unpin");
    assert.equal(test.input.unpin, true);
    assert.equal(test.input.endOfTurn, true);
    assert.equal(test.cost.halves, 0, "unpin is a free end-of-turn test, not an action");
    // The step rides ahead of the end-turn step, after the paid actions.
    const endIndex = result.plan.steps.findIndex(step => step.type === "end-turn");
    const testIndex = result.plan.steps.indexOf(test);
    assert.ok(endIndex >= 0 && testIndex >= 0 && testIndex < endIndex,
        "the unpin test is serialized ahead of the end-turn step");
    // Exactly one unpin step per plan, with a stable id (idempotent
    // across mid-plan replans through the system operation journal).
    assert.equal(result.plan.steps.filter(step => step.input?.unpin === true).length, 1);
    assert.equal(test.id, "step-test-unpin");
});

test("the unpin modifier reads cover against the nearest known threat", async () => {
    const world = makeWorld({
        enemies: [{ x: 300, y: 0 }],
        system: { characteristics: { willpower: { base: 35 } } }
    });
    const inputs = {
        seed: 1,
        actions: world.actions,
        targets: targetsOf(world),
        blastTokens: scanOf(world),
        selfStatuses: ["pinned"]
    };
    const planner = createPlannerService();
    registerAssaultPreset(planner);
    // In cover (estimate ≥ 0.5): the +30 in-cover test.
    const covered = await planner.planTurn(world.combat, world.combatant, {
        ...inputs,
        navigation: { coverEstimate: () => 0.8 }
    });
    const coveredStep = covered.plan.steps.find(step => step.input?.unpin === true);
    assert.equal(coveredStep.input.modifier, 30);
    assert.equal(coveredStep.input.modifierBasis, "in-cover");
    // Below the cover threshold and without a navigation service the
    // conservative base test stands.
    const exposed = await planner.planTurn(world.combat, world.combatant, {
        ...inputs,
        navigation: { coverEstimate: () => 0.2 }
    });
    const exposedStep = exposed.plan.steps.find(step => step.input?.unpin === true);
    assert.equal(exposedStep.input.modifier, 0);
    assert.equal(exposedStep.input.modifierBasis, "base");
    const bare = await planner.planTurn(world.combat, world.combatant, inputs);
    const bareStep = bare.plan.steps.find(step => step.input?.unpin === true);
    assert.equal(bareStep.input.modifier, 0);
    assert.equal(bareStep.input.modifierBasis, "base");
});

/**
 * Planner whose scoring always prefers a moving candidate — the unpin
 * probe tests need a deterministic winner carrying a move step.
 * @returns {object} Planner service.
 */
function moveForcingPlanner() {
    const planner = createPlannerService();
    planner.registerPreset("assault", {
        weights: { attackNow: 10, advance: 1 },
        evaluate({ factors, candidate, weights: w }) {
            const base = evaluateFactors(factors, w).score;
            return candidate.move && !candidate.move.stay ? base + 1000 : base;
        }
    });
    return planner;
}

test("the unpin cover probe reads the planned move endpoint, not the start position", async () => {
    const world = makeWorld({
        enemies: [{ x: 300, y: 0 }],
        system: { characteristics: { willpower: { base: 35 } } }
    });
    // A lateral endpoint far from the enemy: distance-keeping moves stay
    // legal for a pinned bot (closing ones are vetoed).
    const endpoint = { x: 500, y: 400 };
    const inputs = {
        seed: 1,
        actions: world.actions,
        targets: targetsOf(world),
        blastTokens: scanOf(world),
        selfStatuses: ["pinned"],
        moves: [{ x: endpoint.x, y: endpoint.y, i: 5, j: 4, cost: 2, distance: 10, los: true }]
    };
    const planner = moveForcingPlanner();

    // Endpoint in cover, the turn-start spot in the open → the +30 test:
    // the bot crawls behind the wall this turn and tests from there.
    const probes = [];
    const covered = await planner.planTurn(world.combat, world.combatant, {
        ...inputs,
        navigation: {
            coverEstimate: (_token, point) => {
                probes.push({ x: point.x, y: point.y });
                return point.x === endpoint.x && point.y === endpoint.y ? 0.8 : 0;
            }
        }
    });
    assert.equal(covered.status, PLANNER_STATUS.ok);
    assert.ok(covered.plan.steps.some(step => step.type === "move"),
        "the forced move-attack plan won");
    const coveredStep = covered.plan.steps.find(step => step.input?.unpin === true);
    assert.equal(coveredStep.input.modifier, 30);
    assert.equal(coveredStep.input.modifierBasis, "in-cover");
    // Scoring probes cover for the injected moves first; the unpin probe
    // runs after `_stepsFor`, so it is always the last call — and it must
    // carry the serialized move endpoint verbatim (a footprint centre).
    assert.deepEqual(probes.at(-1), endpoint,
        "the last probe point is the serialized move endpoint verbatim");

    // Regression: the covered START no longer decides — the endpoint out
    // in the open means the base +0 test even though the bot began its
    // turn behind the wall.
    const exposed = await planner.planTurn(world.combat, world.combatant, {
        ...inputs,
        navigation: {
            coverEstimate: (_token, point) =>
                (point.x === endpoint.x && point.y === endpoint.y ? 0 : 0.8)
        }
    });
    const exposedStep = exposed.plan.steps.find(step => step.input?.unpin === true);
    assert.equal(exposedStep.input.modifier, 0);
    assert.equal(exposedStep.input.modifierBasis, "base");
});

test("the unpin probe of a moveless plan reads the current footprint centre", async () => {
    const world = makeWorld({
        enemies: [{ x: 300, y: 0 }],
        system: { characteristics: { willpower: { base: 35 } } }
    });
    const probes = [];
    const planner = createPlannerService();
    registerAssaultPreset(planner);
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        actions: world.actions,
        targets: targetsOf(world),
        blastTokens: scanOf(world),
        selfStatuses: ["pinned"],
        navigation: {
            coverEstimate: (_token, point) => {
                probes.push({ x: point.x, y: point.y });
                return 0;
            }
        }
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.ok(result.plan.steps.every(step => step.type !== "move"),
        "no move without injected candidates");
    // Token at top-left (0,0) on a 100px grid, width/height 1 — the
    // no-move fallback probes the footprint centre in pixels. Earlier
    // probes are the scoring-time cover reads of the stay candidate.
    assert.deepEqual(probes.at(-1), { x: 50, y: 50 });
});

test("a replayed commitment probes the committed move endpoint for the unpin modifier", async () => {
    const world = makeWorld({
        enemies: [{ x: 300, y: 0 }],
        system: { characteristics: { willpower: { base: 35 } } }
    });
    const endpoint = { x: 500, y: 400 };
    const enemy = world.enemies[0];
    const record = {
        id: "c-unpin-endpoint",
        status: "active",
        combatId: world.combat.id,
        combatantId: world.combatant.id,
        createdRound: world.combat.round,
        createdTurn: world.combat.turn,
        ttl: 2,
        source: "test",
        steps: [
            {
                id: "step-move-1", type: "move", cost: { movement: 2, halves: 1 },
                input: { to: { x: endpoint.x, y: endpoint.y, i: 5, j: 4 } },
                preconditions: ["turn"], projectedResourceDelta: {}
            },
            {
                id: "step-attack-2", type: "attack", cost: { halves: 1 },
                input: {
                    actionId: "lasgun", name: "Lasgun",
                    itemUuid: `Actor.${world.actor.id}.Item.w1`,
                    targetTokenUuid: enemy.token.uuid,
                    targetTokenId: enemy.token.id, range: 100
                },
                preconditions: ["turn"], projectedResourceDelta: {}
            },
            {
                id: "step-end-turn-3", type: "end-turn", cost: {},
                input: { reason: "committed" },
                preconditions: ["turn"], projectedResourceDelta: {}
            }
        ],
        expectedState: {
            self: { x: world.token.x, y: world.token.y, elevation: 0 },
            target: {
                tokenId: enemy.token.id,
                tokenUuid: enemy.token.uuid,
                x: enemy.token.x,
                y: enemy.token.y
            },
            morale: null,
            threats: [{ tokenId: enemy.token.id, x: enemy.token.x, y: enemy.token.y }]
        }
    };
    const probes = [];
    const planner = createPlannerService();
    registerAssaultPreset(planner);
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        actions: world.actions,
        targets: targetsOf(world),
        blastTokens: scanOf(world),
        selfStatuses: ["pinned"],
        layers: { commitment: true },
        commitment: record,
        navigation: {
            coverEstimate: (_token, point) => {
                probes.push({ x: point.x, y: point.y });
                return point.x === endpoint.x && point.y === endpoint.y ? 0.8 : 0;
            }
        }
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.equal(result.plan.breakdown.reason, "commitment");
    const step = result.plan.steps.find(entry => entry.input?.unpin === true);
    assert.ok(step, "the replayed commitment carries the unpin step");
    assert.equal(step.input.modifier, 30);
    assert.equal(step.input.modifierBasis, "in-cover");
    assert.deepEqual(probes, [endpoint],
        "cover is probed from the committed endpoint, not the live position");
});

test("a pinned combatant without willpower logs unpin-unavailable", async () => {
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }] });
    const captured = [];
    const planner = capturingPlanner(captured);
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        actions: world.actions,
        targets: targetsOf(world),
        blastTokens: scanOf(world),
        selfStatuses: ["pinned"]
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.ok(result.plan.diagnostics.rejected.some(entry => entry.reason === "unpin-unavailable"),
        "missing characteristic records why no recovery step appears");
    assert.ok(!result.plan.steps.some(step => step.input?.unpin === true),
        "no unpin step is serialized without the characteristic");
});

test("a non-pinned combatant gets no unpin step", async () => {
    const world = makeWorld({
        enemies: [{ x: 300, y: 0 }],
        system: { characteristics: { willpower: { base: 35 } } }
    });
    const captured = [];
    const planner = capturingPlanner(captured);
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        actions: world.actions,
        targets: targetsOf(world),
        blastTokens: scanOf(world)
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.equal(factorsOf(captured, candidate => candidate.variant === "unpin"), null);
    assert.ok(!result.plan.steps.some(step => step.input?.unpin === true),
        "no unpin step without the pinned status");
    assert.ok(!result.plan.diagnostics.rejected.some(entry => entry.reason === "unpin-unavailable"));
});

test("a stunned combatant never receives the unpin step", async () => {
    const world = makeWorld({
        enemies: [{ x: 300, y: 0 }],
        system: { characteristics: { willpower: { base: 35 } } }
    });
    const planner = createPlannerService();
    registerAssaultPreset(planner);
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        actions: world.actions,
        targets: targetsOf(world),
        blastTokens: scanOf(world),
        selfStatuses: ["pinned", "stunned"]
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.deepEqual(result.plan.steps.map(step => step.type), ["end-turn"],
        "stunned still short-circuits to the bare end-turn plan");
});

/* -------------------------------------------- */
/*  grudge factor                                */
/* -------------------------------------------- */

test("the grudge factor marks the recorded last attacker", async () => {
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }, { x: 600, y: 0 }] });
    const captured = [];
    const planner = capturingPlanner(captured, { grudge: 4 });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        actions: world.actions,
        targets: targetsOf(world),
        blastTokens: scanOf(world),
        lastAttacker: {
            tokenUuid: world.enemies[0].token.uuid,
            tokenId: world.enemies[0].token.id,
            actorId: world.enemies[0].actor.id,
            round: 1
        }
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const marked = factorsOf(captured, isAttackOn(world.enemies[0]));
    assert.equal(marked.grudge, 0.5,
        "no woundsLost on the record — the default moderate pull (5/10)");
    const other = factorsOf(captured, isAttackOn(world.enemies[1]));
    assert.equal(other.grudge, 0, "bystanders are not marked");
});

test("the grudge factor scales with wounds actually lost (review)", async () => {
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }] });
    const captured = [];
    const planner = capturingPlanner(captured, { grudge: 4 });
    const base = {
        tokenUuid: world.enemies[0].token.uuid,
        tokenId: world.enemies[0].token.id,
        actorId: world.enemies[0].actor.id,
        round: 1
    };
    const light = await planner.planTurn(world.combat, world.combatant, {
        seed: 1, actions: world.actions, targets: targetsOf(world),
        blastTokens: scanOf(world),
        lastAttacker: { ...base, woundsLost: 2 }
    });
    assert.equal(light.status, PLANNER_STATUS.ok);
    assert.equal(factorsOf(captured, isAttackOn(world.enemies[0])).grudge, 0.2,
        "a scratch barely registers");
    const heavyCaptured = [];
    const heavyPlanner = capturingPlanner(heavyCaptured, { grudge: 4 });
    const heavy = await heavyPlanner.planTurn(world.combat, world.combatant, {
        seed: 1, actions: world.actions, targets: targetsOf(world),
        blastTokens: scanOf(world),
        lastAttacker: { ...base, woundsLost: 14 }
    });
    assert.equal(heavy.status, PLANNER_STATUS.ok);
    assert.equal(factorsOf(heavyCaptured, isAttackOn(world.enemies[0])).grudge,
        1, "a near-kill pulls the full factor");
});

test("the combatant lastAttacker flag drives grudge with expiry rules", async () => {
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }] });
    const flag = { [FLAG_KEYS.lastAttacker]: {
        tokenUuid: world.enemies[0].token.uuid,
        tokenId: world.enemies[0].token.id,
        actorId: world.enemies[0].actor.id,
        round: 1,
        turn: 0,
        woundsLost: 4,
        attribution: "damage-operation"
    } };
    world.combatant.flags[MODULE_ID] = {
        ...world.combatant.flags[MODULE_ID],
        ...flag
    };
    const captured = [];
    const planner = capturingPlanner(captured, { grudge: 4 });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        actions: world.actions,
        targets: targetsOf(world),
        blastTokens: scanOf(world)
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.equal(factorsOf(captured, isAttackOn(world.enemies[0])).grudge, 0.4,
        "the live flag feeds the factor, scaled by woundsLost");

    // The same flag in a combat already 4 rounds later is expired.
    world.combat.round = 1 + GRUDGE_MAX_AGE_ROUNDS + 1;
    const staleCaptured = [];
    const stalePlanner = capturingPlanner(staleCaptured, { grudge: 4 });
    const stale = await stalePlanner.planTurn(world.combat, world.combatant, {
        seed: 1,
        actions: world.actions,
        targets: targetsOf(world),
        blastTokens: scanOf(world)
    });
    assert.equal(stale.status, PLANNER_STATUS.ok);
    assert.equal(factorsOf(staleCaptured, isAttackOn(world.enemies[0])).grudge, 0,
        "an expired record carries no grudge");
});

test("a dead attacker carries no grudge", async () => {
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }] });
    world.combatant.flags[MODULE_ID] = {
        ...world.combatant.flags[MODULE_ID],
        [FLAG_KEYS.lastAttacker]: {
            tokenId: world.enemies[0].token.id,
            actorId: world.enemies[0].actor.id,
            round: 1
        }
    };
    world.enemies[0].combatant.defeated = true;
    const captured = [];
    const planner = capturingPlanner(captured, { grudge: 4 });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        actions: world.actions,
        targets: targetsOf(world),
        blastTokens: scanOf(world)
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.equal(factorsOf(captured, isAttackOn(world.enemies[0])).grudge, 0,
        "defeated attacker disables the factor");
});

test("the lastAttacker flag never enters the stale fingerprint", async () => {
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }] });
    world.combatant.flags[MODULE_ID] = {
        ...world.combatant.flags[MODULE_ID],
        [FLAG_KEYS.lastAttacker]: {
            tokenId: world.enemies[0].token.id,
            actorId: world.enemies[0].actor.id,
            round: 1
        }
    };
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        actions: world.actions,
        targets: targetsOf(world),
        blastTokens: scanOf(world)
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    // A fresh hit updating the flag must not stale the live plan.
    await world.combatant.setFlag(MODULE_ID, FLAG_KEYS.lastAttacker, {
        tokenId: "someone-else", actorId: "someone-else", round: 1
    });
    const validation = planner.validateSnapshot(result.plan, {
        combat: world.combat,
        combatant: world.combatant
    });
    assert.equal(validation.valid, true, "flag churn does not invalidate the plan");
});

/* -------------------------------------------- */
/*  grudges service + attribution extractor      */
/* -------------------------------------------- */

test("grudgeActive bounds the record by round window", () => {
    const record = { tokenId: "t1", round: 2 };
    assert.equal(grudgeActive(record, 2), true);
    assert.equal(grudgeActive(record, 2 + GRUDGE_MAX_AGE_ROUNDS), true);
    assert.equal(grudgeActive(record, 2 + GRUDGE_MAX_AGE_ROUNDS + 1), false);
    assert.equal(grudgeActive({ tokenId: "t1" }, 5), true, "no round — conservatively active");
    assert.equal(grudgeActive(null, 1), false);
    assert.equal(grudgeActive({ round: 1 }, 1), false, "an identity-less record is inactive");
});

test("attributeLastAttacker follows the damageOperation source card", () => {
    const damageCard = {
        id: "m-dmg",
        flags: { "only-war-local": { rollData: {
            ownerId: "attacker-actor",
            tokenId: "attacker-token",
            damages: [{ targetActorId: "bot-actor", targetTokenId: "bot-token" }]
        } } }
    };
    const summary = {
        id: "m-sum",
        flags: { "only-war-local": { damageOperation: {
            target: { actorId: "bot-actor", tokenId: "bot-token" },
            source: { messageId: "m-dmg", damageIndexes: [0] }
        } } }
    };
    const found = attributeLastAttacker({
        messages: [damageCard, summary],
        actorId: "bot-actor",
        tokenId: "bot-token",
        findToken: id => (id === "attacker-token"
            ? { id, uuid: "Scene.s.Token.attacker-token", disposition: 1, actor: { id: "attacker-actor" } }
            : null),
        disposition: -1
    });
    assert.ok(found, "targeted card attributes the attacker");
    assert.equal(found.actorId, "attacker-actor");
    assert.equal(found.tokenId, "attacker-token");
    assert.equal(found.tokenUuid, "Scene.s.Token.attacker-token");
    assert.equal(found.attribution, "damage-operation");
});

test("attributeLastAttacker falls back to per-hit target records", () => {
    const damageCard = {
        id: "m-dmg",
        speaker: { scene: "s1", actor: "attacker-actor", token: "attacker-token" },
        flags: { "only-war-local": { rollData: {
            damages: [{ targetActorId: "bot-actor" }]
        } } }
    };
    const found = attributeLastAttacker({
        messages: [damageCard],
        actorId: "bot-actor",
        tokenId: "bot-token"
    });
    assert.ok(found);
    assert.equal(found.attribution, "applied-damage");
    assert.equal(found.tokenUuid, "Scene.s1.Token.attacker-token");
});

test("attributeLastAttacker rejects self-damage and same-side cards", () => {
    const messages = [{
        id: "m-self",
        flags: { "only-war-local": { rollData: {
            ownerId: "bot-actor",
            tokenId: "bot-token",
            damages: [{ targetActorId: "bot-actor" }]
        } } }
    }, {
        id: "m-friendly",
        flags: { "only-war-local": { rollData: {
            ownerId: "friendly-actor",
            tokenId: "friendly-token",
            damages: [{ targetActorId: "bot-actor" }]
        } } }
    }, {
        id: "m-untargeted",
        flags: { "only-war-local": { rollData: {
            ownerId: "attacker-actor",
            tokenId: "attacker-token",
            damages: [{ targetActorId: "someone-else" }]
        } } }
    }];
    const base = {
        messages,
        actorId: "bot-actor",
        tokenId: "bot-token",
        findToken: () => ({ disposition: -1, actor: { id: "friendly-actor" } }),
        disposition: -1
    };
    // Self-damage alone: no grudge.
    assert.equal(attributeLastAttacker({ ...base, messages: [messages[0]] }), null);
    // Friendly-fire card (same-side token): no grudge.
    assert.equal(attributeLastAttacker({ ...base, messages: [messages[1]] }), null);
    // A card that never named the bot: no heuristic attribution.
    assert.equal(attributeLastAttacker({ ...base, messages: [messages[2]], findToken: () => null }), null);
});

test("grudges service writes lastAttacker on a wound loss", async () => {
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }] });
    world.actor.system.wounds = { value: 5, critical: 0, max: 14 };
    const damageCard = {
        id: "m-dmg",
        flags: { "only-war-local": { rollData: {
            ownerId: world.enemies[0].actor.id,
            tokenId: world.enemies[0].token.id,
            damages: [{ targetActorId: world.actor.id, targetTokenId: world.token.id }]
        } } }
    };
    const summary = {
        id: "m-sum",
        flags: { "only-war-local": { damageOperation: {
            target: { actorId: world.actor.id, tokenId: world.token.id },
            source: { messageId: "m-dmg" }
        } } }
    };
    const service = createGrudgesService({
        getCombat: () => world.combat,
        getCombats: () => [world.combat],
        getMessages: () => [damageCard, summary],
        log: () => {}
    });
    const seed = await service.handleUpdateActor(world.actor, {});
    assert.equal(seed.reason, "seeded", "first observation only caches wounds");

    world.actor.system.wounds.value = 8;
    const result = await service.handleUpdateActor(world.actor, {});
    assert.equal(result.ok, true);
    const record = world.combatant.flags[MODULE_ID][FLAG_KEYS.lastAttacker];
    assert.ok(record, "the flag was written on the combatant");
    assert.equal(record.actorId, world.enemies[0].actor.id);
    assert.equal(record.tokenId, world.enemies[0].token.id);
    assert.equal(record.woundsLost, 3);
    assert.equal(record.round, 1);
    assert.equal(record.attribution, "damage-operation");
});

test("grudges service is controller-gated and heals do not attribute", async () => {
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }] });
    world.actor.system.wounds = { value: 5, critical: 0, max: 14 };
    const denied = createGrudgesService({
        api: { services: { get: () => ({ isController: () => false }) } },
        getCombat: () => world.combat,
        getCombats: () => [world.combat],
        getMessages: () => [],
        log: () => {}
    });
    await denied.handleUpdateActor(world.actor, {});
    world.actor.system.wounds.value = 9;
    const loss = await denied.handleUpdateActor(world.actor, {});
    assert.equal(loss.reason, "not-controller");
    assert.equal(world.combatant.flags[MODULE_ID]?.[FLAG_KEYS.lastAttacker], undefined);

    // Healing (wound total drops) is not an attack.
    const service = createGrudgesService({
        getCombat: () => world.combat,
        getCombats: () => [world.combat],
        getMessages: () => [],
        log: () => {}
    });
    await service.handleUpdateActor(world.actor, {});
    world.actor.system.wounds.value = 4;
    const heal = await service.handleUpdateActor(world.actor, {});
    assert.equal(heal.reason, "no-loss");
    assert.equal(world.combatant.flags[MODULE_ID]?.[FLAG_KEYS.lastAttacker], undefined);
});

test("start() seeds the wound cache so the first loss attributes (review)", async () => {
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }] });
    world.actor.system.wounds = { value: 5, critical: 0, max: 14 };
    const damageCard = {
        id: "m-dmg",
        flags: { "only-war-local": { rollData: {
            ownerId: world.enemies[0].actor.id,
            tokenId: world.enemies[0].token.id,
            damages: [{ targetActorId: world.actor.id, targetTokenId: world.token.id }]
        } } }
    };
    globalThis.game.actors = [world.actor];
    try {
        const service = createGrudgesService({
            getCombat: () => world.combat,
            getCombats: () => [world.combat],
            getMessages: () => [damageCard],
            log: () => {}
        });
        service.start();
        // No baseline updateActor needed: the very first wound loss
        // after start() already attributes — the join-mid-combat gap
        // of the lazy seed is closed.
        world.actor.system.wounds.value = 8;
        const result = await service.handleUpdateActor(world.actor, {});
        service.stop();
        assert.equal(result.ok, true);
        assert.equal(result.attributed, true);
        const record = world.combatant.flags[MODULE_ID][FLAG_KEYS.lastAttacker];
        assert.equal(record.woundsLost, 3);
    } finally {
        delete globalThis.game.actors;
    }
});
