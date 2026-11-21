/**
 * Unit tests for bot personalities (issue #19): the trait pool, seeded
 * generation, flag overrides, weight overlays, per-candidate jitter and
 * the fireteam `character` shared overlay.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { FLAG_KEYS, MODULE_ID } from "../../scripts/constants.js";
import { resolveEffectiveConfig } from "../../scripts/config-resolver.js";
import {
    FIRETEAM_CHARACTERS
} from "../../scripts/constants.js";
import {
    DIFFICULTY_JITTER,
    FIRETEAM_CHARACTER_OVERLAYS,
    PERSONALITIES,
    PERSONALITY_CATEGORIES,
    PERSONALITY_IDS,
    PERSONALITY_JITTER_MAX,
    applyPersonalityOverlay,
    generatePersonalityTraits,
    normalizePersonalityTraits,
    personalityBehaviorFlags,
    personalityIdentity,
    personalityJitter,
    personalityJitterFactor,
    personalityWeightDelta,
    resolvePersonality
} from "../../scripts/personalities.js";
import { FIRETEAM_STATUS, createFireteamService, resolveTeamConfig }
    from "../../scripts/fireteam.js";
import {
    DEFAULT_PRESET_WEIGHTS,
    PLANNER_STATUS,
    createPlannerService
} from "../../scripts/planner.js";
import {
    makeActor,
    makeCombatant,
    makeScene,
    makeToken
} from "./fixtures.mjs";

let _combatId = 0;

/**
 * Minimal Combat fixture matching the planner tests.
 * @param {object} [options]
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
 * Attach a flag map under the module namespace.
 * @param {object} doc
 * @param {object} flags `flagKey → value`.
 * @returns {object}
 */
function withFlags(doc, flags) {
    doc.flags[MODULE_ID] = { ...(doc.flags[MODULE_ID] ?? {}), ...flags };
    return doc;
}

/**
 * Small AI world: one assault NPC plus a hostile at `(300, 0)`.
 * @param {object} [options]
 * @param {object} [options.actorFlags] Extra module flags on the actor.
 * @returns {object}
 */
function makeWorld({ actorFlags = {} } = {}) {
    const scene = makeScene({ grid: "square" });
    const actor = withFlags(makeActor({ enabled: true, preset: "assault" }), actorFlags);
    actor.system = { wounds: { value: 12, max: 14 } };
    actor.items = [];
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

    const combat = makeCombat({ round: 1, turn: 0, combatants: [combatant, enemy] });
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
            canAttack: true,
            source: "injected"
        }],
        actions: [{
            id: "lasgun", type: "attack", name: "Lasgun",
            itemUuid: "Actor.npc.Item.las", itemId: "las",
            class: "ranged", range: 100
        }]
    };
}

/* ------------------------------------------------------------------ */
/* Pool integrity                                                      */
/* ------------------------------------------------------------------ */

test("personality pool: ~24 traits with valid categories and data", () => {
    assert.equal(PERSONALITY_IDS.length, 24);
    for (const id of PERSONALITY_IDS) {
        const trait = PERSONALITIES[id];
        assert.ok(PERSONALITY_CATEGORIES.includes(trait.category), `${id} category`);
        assert.ok(Number.isFinite(trait.weight) && trait.weight > 0, `${id} weight`);
        assert.ok(Number.isFinite(trait.jitter), `${id} jitter`);
        assert.ok(trait.deltas && typeof trait.deltas === "object", `${id} deltas`);
        for (const value of Object.values(trait.deltas)) {
            assert.ok(Number.isFinite(value), `${id} delta value`);
        }
    }
    assert.deepEqual([...PERSONALITY_IDS], [...PERSONALITY_IDS].sort());
});

/* ------------------------------------------------------------------ */
/* Normalization and resolution                                        */
/* ------------------------------------------------------------------ */

test("normalizePersonalityTraits keeps known ids, drops damaged data", () => {
    assert.deepEqual(normalizePersonalityTraits(["brave", "sniper"]), ["brave", "sniper"]);
    assert.deepEqual(normalizePersonalityTraits("reckless, marksman"), ["reckless", "marksman"]);
    assert.deepEqual(normalizePersonalityTraits(["brave", "bogus", "brave"]), ["brave"]);
    assert.deepEqual(normalizePersonalityTraits(42), []);
    assert.deepEqual(normalizePersonalityTraits([{ x: 1 }, null, "veteran"]), ["veteran"]);
    assert.deepEqual(normalizePersonalityTraits(undefined), []);
});

test("resolvePersonality: explicit > flag > generated, false disables", () => {
    const flagged = resolvePersonality({ flagged: ["sniper"], identity: "npc-1" });
    assert.deepEqual(flagged.traits, ["sniper"]);
    assert.equal(flagged.source, "flag");

    const explicit = resolvePersonality({
        explicit: ["cowardly"], flagged: ["sniper"], identity: "npc-1"
    });
    assert.deepEqual(explicit.traits, ["cowardly"]);
    assert.equal(explicit.source, "context");

    // A damaged explicit value falls through to the flag; a damaged flag
    // falls through to seeded generation.
    const damaged = resolvePersonality({
        explicit: ["bogus"], flagged: ["sniper"], identity: "npc-1"
    });
    assert.deepEqual(damaged.traits, ["sniper"]);
    const generated = resolvePersonality({ flagged: "not-a-trait", identity: "npc-1" });
    assert.equal(generated.source, "generated");
    assert.ok(generated.traits.length >= 1);

    const disabled = resolvePersonality({
        explicit: false, flagged: ["sniper"], character: "elite", identity: "npc-1"
    });
    assert.deepEqual(disabled.traits, []);
    assert.equal(disabled.character, null);
    assert.equal(disabled.source, "disabled");
});

/* ------------------------------------------------------------------ */
/* Seeded generation                                                   */
/* ------------------------------------------------------------------ */

test("generatePersonalityTraits is deterministic and identity-seeded", () => {
    const first = generatePersonalityTraits({ identity: "npc-42", difficulty: "normal" });
    const second = generatePersonalityTraits({ identity: "npc-42", difficulty: "normal" });
    assert.deepEqual(first, second);
    assert.ok(first.length >= 1 && first.length <= 2);
    assert.ok(first.every(id => PERSONALITY_IDS.includes(id)));

    // Different identities produce varied traits over a series.
    const signatures = new Set(
        Array.from({ length: 40 }, (_, i) =>
            generatePersonalityTraits({ identity: `npc-${i}` }).join("+")));
    assert.ok(signatures.size > 10, "generation varies across identities");
});

test("generation biases the pool by difficulty", () => {
    const easyFavoured = new Set(["cowardly", "rookie", "unsteady", "reckless"]);
    const hardFavoured = new Set(["veteran", "marksman", "flanker", "cunning"]);
    let easyOnEasy = 0;
    let easyOnHard = 0;
    let hardOnHard = 0;
    let hardOnEasy = 0;
    const identities = 400;
    for (let i = 0; i < identities; i++) {
        const identity = `bias-${i}`;
        for (const id of generatePersonalityTraits({ identity, difficulty: "easy" })) {
            if (easyFavoured.has(id)) easyOnEasy += 1;
            if (hardFavoured.has(id)) hardOnEasy += 1;
        }
        for (const id of generatePersonalityTraits({ identity, difficulty: "hard" })) {
            if (easyFavoured.has(id)) easyOnHard += 1;
            if (hardFavoured.has(id)) hardOnHard += 1;
        }
    }
    // The bias multipliers make both inequalities statistically certain:
    // easy draws the fragile/reckless pool ~8x more often than hard, and
    // hard draws the veteran pool ~4x more often than easy.
    assert.ok(easyOnEasy > easyOnHard,
        `easy draws weak traits more often (${easyOnEasy} vs ${easyOnHard})`);
    assert.ok(hardOnHard > hardOnEasy,
        `hard draws veteran traits more often (${hardOnHard} vs ${hardOnEasy})`);
});

/* ------------------------------------------------------------------ */
/* Overlays and jitter                                                 */
/* ------------------------------------------------------------------ */

test("personalityWeightDelta sums traits; personal deltas override the character", () => {
    const sum = personalityWeightDelta({ traits: ["brave", "duelist"] });
    assert.equal(sum.charge, 2 + 3);
    assert.equal(sum.attackNow, 2);

    // rabble (-4 cohesionRestore) vs cowardly (+6): the personal delta
    // replaces the team delta on the conflicting factor.
    const merged = personalityWeightDelta({ traits: ["cowardly"], character: "rabble" });
    assert.equal(merged.cohesionRestore, 6);
    // holdPosition conflicts too: cowardly's +2 replaces rabble's -2.
    assert.equal(merged.holdPosition, 2);
    // proximity also conflicts: cowardly's -3 replaces rabble's +1.
    assert.equal(merged.proximity, -3);
});

test("applyPersonalityOverlay adds deltas without mutating the base", () => {
    const base = { attackNow: 10, cover: 4 };
    const effective = applyPersonalityOverlay(base, { traits: ["reckless"] });
    assert.equal(effective.attackNow, 14);
    assert.equal(effective.cover, 1);
    assert.equal(effective.threat, -3);
    assert.equal(base.attackNow, 10);
    assert.equal(base.cover, 4);
});

test("personalityJitter: trait/character amps against the difficulty baseline", () => {
    // Unsteady alone nearly saturates the cap on normal.
    const unsteady = personalityJitter({ traits: ["unsteady"], difficulty: "normal" });
    assert.equal(unsteady, DIFFICULTY_JITTER.normal + 0.12);
    // Veteran bottoms out at zero.
    assert.equal(personalityJitter({ traits: ["veteran"], difficulty: "normal" }), 0);
    // Stacked positive amps clamp at the hard cap.
    const stacked = personalityJitter({
        traits: ["unsteady", "reckless", "rookie"], difficulty: "easy"
    });
    assert.equal(stacked, PERSONALITY_JITTER_MAX);
    // Characters bias the amplitude: rabble raises, elite lowers.
    const rabble = personalityJitter({ traits: [], character: "rabble", difficulty: "normal" });
    assert.equal(rabble, DIFFICULTY_JITTER.normal
        + FIRETEAM_CHARACTER_OVERLAYS.rabble.jitter);
    const elite = personalityJitter({ traits: [], character: "elite", difficulty: "normal" });
    assert.equal(elite, 0);
});

test("personalityJitterFactor is seeded, deterministic and bounded", () => {
    const a = personalityJitterFactor({ seed: 7, candidateId: "cand-1", amp: 0.15 });
    const b = personalityJitterFactor({ seed: 7, candidateId: "cand-1", amp: 0.15 });
    assert.equal(a, b);
    assert.ok(a >= 0.85 && a <= 1.15);
    // amp 0 → neutral factor; different candidates get independent rolls.
    assert.equal(personalityJitterFactor({ seed: 7, candidateId: "cand-1", amp: 0 }), 1);
    const factors = new Set(
        Array.from({ length: 20 }, (_, i) =>
            personalityJitterFactor({ seed: 7, candidateId: `c-${i}`, amp: 0.1 })));
    assert.ok(factors.size > 5, "jitter varies per candidate");
});

test("personalityBehaviorFlags merges trait flags (fanatic ignores regroup)", () => {
    assert.equal(personalityBehaviorFlags(["fanatic"]).ignoreRegroup, true);
    assert.deepEqual(personalityBehaviorFlags(["brave"]), {});
    assert.deepEqual(personalityBehaviorFlags([]), {});
});

test("personalityIdentity prefers actor.id, then token uuid", () => {
    assert.equal(personalityIdentity({ actor: { id: "a-1" }, token: { uuid: "u" } }), "a-1");
    assert.equal(personalityIdentity({ token: { uuid: "u-2" } }), "u-2");
    assert.equal(personalityIdentity({ token: { id: "t-3" } }), "t-3");
    assert.equal(personalityIdentity({ combatant: { id: "c-4" } }), "c-4");
    assert.equal(personalityIdentity({}), "anonymous");
});

/* ------------------------------------------------------------------ */
/* Flag override through resolveEffectiveConfig                        */
/* ------------------------------------------------------------------ */

test("resolveEffectiveConfig resolves the personality flag down the chain", () => {
    // Actor-level flag.
    const actor = withFlags(makeActor({ enabled: true, preset: "assault" }), {
        [FLAG_KEYS.personality]: ["sniper", "veteran"]
    });
    const resolved = resolveEffectiveConfig(actor);
    assert.deepEqual(resolved.personality, ["sniper", "veteran"]);

    // Combatant flag wins over the actor flag.
    const combatant = withFlags(makeCombatant({ actor }), {
        [FLAG_KEYS.personality]: "brave, marksman"
    });
    const resolvedCombatant = resolveEffectiveConfig(combatant);
    assert.deepEqual(resolvedCombatant.personality, ["brave", "marksman"]);

    // Token flag fills in when the combatant carries none.
    const token = withFlags(makeToken({ actor }), {
        [FLAG_KEYS.personality]: ["cowardly"]
    });
    const plainCombatant = makeCombatant({ actor, token });
    assert.deepEqual(resolveEffectiveConfig(plainCombatant).personality, ["cowardly"]);

    // Damaged values are ignored safely.
    const damaged = withFlags(makeActor({ enabled: true }), {
        [FLAG_KEYS.personality]: 42
    });
    assert.equal(resolveEffectiveConfig(damaged).personality, undefined);
    assert.equal(resolveEffectiveConfig(makeActor()).personality, undefined);
});

/* ------------------------------------------------------------------ */
/* Planner integration                                                 */
/* ------------------------------------------------------------------ */

test("planTurn applies explicit personality traits to weights and plan metadata", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, {
        ...planContext(world),
        personality: ["cowardly"]
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.deepEqual(result.plan.personality.traits, ["cowardly"]);
    assert.equal(result.plan.personality.source, "context");
    // Cowardly: -3 attackNow over the default assault skeleton.
    assert.equal(result.plan.diagnostics.weights.attackNow,
        DEFAULT_PRESET_WEIGHTS.attackNow - 3);
    assert.equal(result.plan.diagnostics.personality.traits[0], "cowardly");
    // normal baseline 0.02 + cowardly 0.02.
    assert.equal(result.plan.diagnostics.personality.jitter, 0.04);
    const jitter = result.plan.breakdown.jitter;
    if (jitter) {
        assert.ok(jitter.factor >= 1 - jitter.amp && jitter.factor <= 1 + jitter.amp);
    }
});

test("planTurn reads the personality flag via the effective config", async () => {
    const world = makeWorld({
        actorFlags: { [FLAG_KEYS.personality]: ["sniper"] }
    });
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, planContext(world));
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.deepEqual(result.plan.personality.traits, ["sniper"]);
    assert.equal(result.plan.personality.source, "flag");
});

test("generated personalities are stable across plans and turns", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    const r1 = await planner.planTurn(world.combat, world.combatant, planContext(world));
    const r2 = await planner.planTurn(world.combat, world.combatant, planContext(world));
    assert.equal(r1.status, PLANNER_STATUS.ok);
    // Same input + same seed → byte-identical plan, personality included.
    assert.equal(JSON.stringify(r1.plan), JSON.stringify(r2.plan));
    assert.ok(r1.plan.personality.traits.length >= 1);
    assert.equal(r1.plan.personality.source, "generated");

    // A different combat/round still generates the same trait pool —
    // the personality seed is the document identity, not the turn seed.
    const otherWorld = makeWorld();
    otherWorld.combat.round = 9;
    otherWorld.combat.id = "combat-later";
    const r3 = await planner.planTurn(
        otherWorld.combat, otherWorld.combatant, planContext(otherWorld));
    assert.ok(r3.plan.personality.traits.length >= 1);
});

test("personality: false disables traits, overlays and jitter", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, {
        ...planContext(world),
        personality: false
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.deepEqual(result.plan.personality.traits, []);
    assert.equal(result.plan.personality.source, "disabled");
    assert.equal(result.plan.diagnostics.personality.jitter, 0);
    assert.equal(result.plan.breakdown.jitter, undefined);
    // Untouched skeleton weights.
    assert.equal(result.plan.diagnostics.weights.attackNow,
        DEFAULT_PRESET_WEIGHTS.attackNow);
});

/* ------------------------------------------------------------------ */
/* Fireteam character                                                  */
/* ------------------------------------------------------------------ */

test("resolveTeamConfig resolves the fireteam character per layer", () => {
    const actor = withFlags(makeActor(), {
        [FLAG_KEYS.fireteam]: { teamId: "alpha", character: "elite" }
    });
    assert.equal(resolveTeamConfig(actor).character, "elite");

    // Combatant character overrides the actor one; damaged data ignored.
    const combatant = withFlags(makeCombatant({ actor }), {
        [FLAG_KEYS.fireteam]: { teamId: "alpha", character: "bogus" }
    });
    const resolved = resolveTeamConfig(combatant);
    assert.equal(resolved.character, "elite");
    assert.equal(resolveTeamConfig(makeActor()).character, null);
});

test("buildTeamPlan applies the character overlay to every member", async () => {
    const mkMember = x => {
        const actor = withFlags(makeActor({ enabled: true, preset: "assault" }), {});
        actor.system = { wounds: { value: 10, max: 14 } };
        actor.items = [];
        const token = makeToken({ actor });
        token.x = x;
        token.y = 0;
        token.elevation = 0;
        token.disposition = -1;
        const combatant = withFlags(makeCombatant({ actor, token }), {
            [FLAG_KEYS.fireteam]: { teamId: "alpha", character: "rabble" }
        });
        combatant.tokenId = token.id;
        return { combatant, token, actor };
    };
    const members = [mkMember(0), mkMember(50), mkMember(100)];
    const world = makeWorld();
    const combat = makeCombat({
        round: 1, turn: 0,
        combatants: [...members.map(m => m.combatant), world.enemy]
    });
    combat.scene = world.scene;
    const service = createFireteamService({ planner: createPlannerService() });
    const result = await service.buildTeamPlan(combat, { teamId: "alpha" }, {
        seed: 11,
        targets: planContext(world).targets,
        actions: planContext(world).actions,
        // Pin the personal trait so the overlay math is exact: cowardly
        // (+6 cohesionRestore) overrides the rabble (-4) team delta.
        personality: ["cowardly"]
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    assert.equal(result.teamPlan.character, "rabble");
    assert.equal(result.teamPlan.diagnostics.character, "rabble");
    for (const plan of Object.values(result.teamPlan.memberPlans)) {
        if (!plan) continue;
        assert.equal(plan.personality.character, "rabble");
        assert.equal(plan.diagnostics.personality.character, "rabble");
        assert.equal(plan.diagnostics.weights.cohesionRestore,
            (DEFAULT_PRESET_WEIGHTS.cohesionRestore ?? 0) + 6);
    }
});
