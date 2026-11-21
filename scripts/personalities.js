/**
 * Bot personalities (issue #19, epic #363): a data-driven pool of ~24
 * traits that bias the deterministic planner per combatant, plus the
 * fireteam `character` shared by a whole team.
 *
 * Design contract:
 * - Each trait is a pure-data record `{category, deltas, jitter, weight,
 *   bias, flags}`. `deltas` are *additive* weight offsets merged over the
 *   resolved preset weights before scoring — the same overlay pattern
 *   the spec-ops task weights use (`{...base, ...overlay}`), except
 *   personality deltas add up instead of replacing the base value.
 * - Generation is seeded from the stable document identity
 *   (`actor.id` → `token.uuid` → `token.id` → `combatant.id`) through
 *   `fnv1a` + `mulberry32`: 1–2 traits drawn without replacement from a
 *   weighted pool, so every client derives the identical personality for
 *   the identical document — stable across clients, turns and combats.
 * - `flags["only-war-ai"].personality` is an explicit GM override: an
 *   array of trait ids (or a comma-separated string) resolved by
 *   `resolveEffectiveConfig`; damaged values are ignored safely and the
 *   bot falls back to seeded generation.
 * - Difficulty biases the pool (`bias.easy|normal|hard` multipliers):
 *   easy bots drift toward cowardly/rookie/unsteady/reckless (and the
 *   strong jitter those traits carry), hard bots toward
 *   veteran/marksman/flanker/cunning, normal draws the full pool.
 * - Jitter is a seeded per-candidate score multiplier in
 *   `1 ± amplitude`; the amplitude is the difficulty baseline plus the
 *   per-trait and per-character biases, clamped to
 *   {@link PERSONALITY_JITTER_MAX}. The multiplier stream is keyed by
 *   candidate id so candidate-list changes keep it stable.
 * - Behavioural flags (e.g. `ignoreRegroup` of `fanatic`) are declared
 *   on the trait and enforced through weight deltas — no separate
 *   candidate-generation branches are needed at this cost level.
 * - `flankAngle`/`cohesionRestore` are preset-only factors of the
 *   spec-ops preset; deltas on them are inert for other presets.
 */
import { FIRETEAM_CHARACTERS } from "./constants.js";
import { fnv1a, mulberry32 } from "./planner.js";

/** Trait categories of the personality pool (display/grouping only). */
export const PERSONALITY_CATEGORIES = Object.freeze([
    "courage",
    "skill",
    "maneuver",
    "command"
]);

/** Maximum number of traits generated for one bot. */
export const PERSONALITY_MAX_GENERATED_TRAITS = 2;

/** Seeded probability a generated personality carries a second trait. */
export const PERSONALITY_DOUBLE_TRAIT_CHANCE = 0.5;

/** Hard cap of the per-turn jitter amplitude (±fraction of the score). */
export const PERSONALITY_JITTER_MAX = 0.15;

/**
 * Baseline jitter amplitude per difficulty (issue #19): easy bots wobble
 * the most even before trait biases, hard bots are steady.
 */
export const DIFFICULTY_JITTER = Object.freeze({
    easy: 0.04,
    normal: 0.02,
    hard: 0
});

/** Seed XOR mask for the per-candidate jitter stream. */
const PERSONALITY_JITTER_SEED_XOR = 0x85ebca6b;

/**
 * The personality pool: `traitId → {category, deltas, jitter, weight,
 * bias, flags?}`.
 *
 * - `deltas`: additive offsets on `SCORE_FACTORS` weights (plus the
 *   spec-ops-only `flankAngle`/`cohesionRestore` factors); applied on top
 *   of the resolved preset weights before scoring.
 * - `jitter`: signed amplitude bias of the seeded per-turn score noise —
 *   positive values destabilize the pick, negative values steady it.
 * - `weight`: base frequency in the generation pool.
 * - `bias`: per-difficulty multipliers on `weight`.
 */
export const PERSONALITIES = Object.freeze({
    // --- Агрессия / смелость -----------------------------------------
    brave: Object.freeze({
        category: "courage",
        deltas: Object.freeze({ charge: 2, attackNow: 2, exposure: -1 }),
        jitter: -0.01,
        weight: 10,
        bias: Object.freeze({ easy: 1, normal: 1, hard: 1 })
    }),
    reckless: Object.freeze({
        category: "courage",
        deltas: Object.freeze({ attackNow: 4, charge: 3, threat: -3, cover: -3 }),
        jitter: 0.04,
        weight: 6,
        bias: Object.freeze({ easy: 2.5, normal: 1, hard: 0.3 })
    }),
    fanatic: Object.freeze({
        category: "courage",
        // `ignoreRegroup` is enforced through the strong negative
        // `cohesionRestore`/`holdPosition` deltas — even on a `regroup`
        // team task the cohesion pull is suppressed.
        deltas: Object.freeze({
            advance: 3, charge: 2, cohesionRestore: -12, holdPosition: -4
        }),
        jitter: 0.02,
        weight: 5,
        bias: Object.freeze({ easy: 1.5, normal: 1, hard: 0.8 }),
        flags: Object.freeze({ ignoreRegroup: true })
    }),
    bloodthirsty: Object.freeze({
        category: "courage",
        deltas: Object.freeze({ vulnerable: 6, attackNow: 2 }),
        jitter: 0.01,
        weight: 7,
        bias: Object.freeze({ easy: 1, normal: 1, hard: 1 })
    }),
    cunning: Object.freeze({
        category: "courage",
        deltas: Object.freeze({ attackType: 0.15, los: 3, exposure: -2 }),
        jitter: -0.03,
        weight: 8,
        bias: Object.freeze({ easy: 0.5, normal: 1, hard: 1.8 })
    }),
    cautious: Object.freeze({
        category: "courage",
        deltas: Object.freeze({ cover: 4, holdPosition: 3, charge: -2 }),
        jitter: -0.01,
        weight: 8,
        bias: Object.freeze({ easy: 1, normal: 1, hard: 1 })
    }),
    cowardly: Object.freeze({
        category: "courage",
        // The positive `cohesionRestore` delta is the pull toward
        // regrouping with the team under pressure.
        deltas: Object.freeze({
            proximity: -3, attackNow: -3, cohesionRestore: 6, holdPosition: 2
        }),
        jitter: 0.02,
        weight: 5,
        bias: Object.freeze({ easy: 2.5, normal: 1, hard: 0.3 })
    }),
    // --- Навык / опыт --------------------------------------------------
    veteran: Object.freeze({
        category: "skill",
        deltas: Object.freeze({ threat: 2, exposure: -1, attackType: 0.05 }),
        jitter: -0.06,
        weight: 7,
        bias: Object.freeze({ easy: 0.3, normal: 1, hard: 2 })
    }),
    marksman: Object.freeze({
        category: "skill",
        deltas: Object.freeze({ attackType: 0.1, los: 3, aim: 3 }),
        jitter: -0.02,
        weight: 7,
        bias: Object.freeze({ easy: 0.5, normal: 1, hard: 1.8 })
    }),
    rookie: Object.freeze({
        category: "skill",
        deltas: Object.freeze({ area: -3, attackType: -0.08, los: -1 }),
        jitter: 0.06,
        weight: 6,
        bias: Object.freeze({ easy: 2.5, normal: 1, hard: 0.3 })
    }),
    heavyHanded: Object.freeze({
        category: "skill",
        deltas: Object.freeze({ attackType: 0.15, area: 3, melee: 2 }),
        jitter: 0.01,
        weight: 5,
        bias: Object.freeze({ easy: 1, normal: 1, hard: 1 })
    }),
    grenadier: Object.freeze({
        category: "skill",
        deltas: Object.freeze({ area: 6 }),
        jitter: 0,
        weight: 5,
        bias: Object.freeze({ easy: 1, normal: 1, hard: 1 })
    }),
    duelist: Object.freeze({
        category: "skill",
        deltas: Object.freeze({ melee: 4, meleeEngage: 4, charge: 3 }),
        jitter: 0,
        weight: 6,
        bias: Object.freeze({ easy: 1, normal: 1, hard: 1.2 })
    }),
    sniper: Object.freeze({
        category: "skill",
        deltas: Object.freeze({ los: 4, proximity: -3, aim: 3, aimAlone: 1 }),
        jitter: -0.02,
        weight: 6,
        bias: Object.freeze({ easy: 0.5, normal: 1, hard: 1.5 })
    }),
    // --- Позиция / манёвр ---------------------------------------------
    flanker: Object.freeze({
        category: "maneuver",
        // `flankAngle` is a spec-ops-only factor; the generic mobility
        // deltas keep the trait meaningful on every other preset.
        deltas: Object.freeze({ flankAngle: 6, attackAfterMove: 2, cover: 1 }),
        jitter: 0,
        weight: 6,
        bias: Object.freeze({ easy: 0.5, normal: 1, hard: 1.5 })
    }),
    sentinel: Object.freeze({
        category: "maneuver",
        deltas: Object.freeze({ holdPosition: 4, overwatch: 3 }),
        jitter: -0.01,
        weight: 7,
        bias: Object.freeze({ easy: 1, normal: 1, hard: 1 })
    }),
    pursuer: Object.freeze({
        category: "maneuver",
        deltas: Object.freeze({ advance: 4, proximity: 3 }),
        jitter: 0.01,
        weight: 6,
        bias: Object.freeze({ easy: 1, normal: 1, hard: 1 })
    }),
    wanderer: Object.freeze({
        category: "maneuver",
        deltas: Object.freeze({ attackAfterMove: 3, holdPosition: -3 }),
        jitter: 0.02,
        weight: 5,
        bias: Object.freeze({ easy: 1, normal: 1, hard: 1 })
    }),
    liaison: Object.freeze({
        category: "maneuver",
        // `cohesionRestore` only exists as a spec-ops regroup factor;
        // `lastKnown` keeps the liaison valuable on other presets.
        deltas: Object.freeze({ cohesionRestore: 6, lastKnown: 1 }),
        jitter: -0.01,
        weight: 5,
        bias: Object.freeze({ easy: 1, normal: 1, hard: 1 })
    }),
    loner: Object.freeze({
        category: "maneuver",
        deltas: Object.freeze({ cohesionRestore: -8, aimAlone: 1 }),
        jitter: 0.01,
        weight: 5,
        bias: Object.freeze({ easy: 1, normal: 1, hard: 1 })
    }),
    // --- Командность ---------------------------------------------------
    leader: Object.freeze({
        category: "command",
        deltas: Object.freeze({ holdPosition: 2, threat: 1, cohesionRestore: 2 }),
        jitter: -0.03,
        weight: 6,
        bias: Object.freeze({ easy: 0.5, normal: 1, hard: 1.5 })
    }),
    executor: Object.freeze({
        category: "command",
        // Support-task analogue: keeps the member in a disciplined
        // fire-and-cover posture.
        deltas: Object.freeze({ los: 2, cover: 2, holdPosition: 1 }),
        jitter: -0.02,
        weight: 6,
        bias: Object.freeze({ easy: 1, normal: 1, hard: 1.2 })
    }),
    thrifty: Object.freeze({
        category: "command",
        // Lower `attackType` desire: expensive attack types (full_auto)
        // lose their edge, the bot favours standard shots.
        deltas: Object.freeze({ attackType: -0.12 }),
        jitter: -0.01,
        weight: 5,
        bias: Object.freeze({ easy: 1, normal: 1, hard: 1 })
    }),
    unsteady: Object.freeze({
        category: "command",
        deltas: Object.freeze({}),
        jitter: 0.12,
        weight: 4,
        bias: Object.freeze({ easy: 2, normal: 1, hard: 0.3 })
    })
});

/** Sorted list of every trait id in the pool (fixed draw order). */
export const PERSONALITY_IDS = Object.freeze(Object.keys(PERSONALITIES).sort());

/**
 * Fireteam `character` overlays (issue #19): one shared temperament per
 * team, applied to every member's effective weights before the personal
 * trait deltas. Personal traits win per-factor conflicts.
 */
export const FIRETEAM_CHARACTER_OVERLAYS = Object.freeze({
    disciplined: Object.freeze({
        deltas: Object.freeze({ cohesionRestore: 4, holdPosition: 1, threat: 1 }),
        jitter: -0.02
    }),
    shock: Object.freeze({
        deltas: Object.freeze({
            charge: 4, meleeEngage: 3, attackAfterMove: 2, attackType: 0.1
        }),
        jitter: 0.01
    }),
    elite: Object.freeze({
        deltas: Object.freeze({ attackType: 0.1, los: 1, threat: 1 }),
        jitter: -0.05
    }),
    rabble: Object.freeze({
        deltas: Object.freeze({ cohesionRestore: -4, holdPosition: -2, proximity: 1 }),
        jitter: 0.08
    })
});

/**
 * Sanitize a raw personality value into a deduplicated list of known
 * trait ids. Accepts an array or a comma/space-separated string; unknown
 * ids and damaged values are dropped silently.
 * @param {*} value Raw flag/context value.
 * @returns {string[]} Valid trait ids (empty when nothing valid).
 */
export function normalizePersonalityTraits(value) {
    const list = Array.isArray(value) ? value
        : (typeof value === "string" ? value.split(/[\s,;]+/) : []);
    const traits = [];
    for (const entry of list) {
        if (typeof entry !== "string") continue;
        const id = entry.trim();
        if (PERSONALITY_IDS.includes(id) && !traits.includes(id)) {
            traits.push(id);
        }
    }
    return traits;
}

/**
 * Stable personality identity of a document: `actor.id` first (per the
 * issue #19 contract), then token uuid/id, then combatant ids.
 * @param {object} input
 * @param {object|null} [input.combatant]
 * @param {object|null} [input.token] TokenDocument.
 * @param {object|null} [input.actor]
 * @returns {string}
 */
export function personalityIdentity({ combatant = null, token = null, actor = null } = {}) {
    return actor?.id
        ?? token?.uuid
        ?? token?.id
        ?? combatant?.actor?.id
        ?? combatant?.id
        ?? "anonymous";
}

/**
 * Seeded generation of 1–2 traits from the weighted pool (issue #19).
 * The seed stream is keyed only by the stable document identity — never
 * by combat id or round — so the personality is identical on every
 * client and persists across combats.
 * @param {object} input
 * @param {string} input.identity Stable document identity.
 * @param {string} [input.difficulty] Pool bias (`easy|normal|hard`).
 * @param {Function} [input.rng] Injected `() => [0,1)` stream (tests).
 * @returns {string[]} 1–2 trait ids in draw order.
 */
export function generatePersonalityTraits({ identity, difficulty = "normal", rng = null } = {}) {
    const next = typeof rng === "function"
        ? rng
        : mulberry32(parseInt(fnv1a(`personality|${identity ?? "anonymous"}`), 16) >>> 0);
    const biasOf = id => {
        const trait = PERSONALITIES[id];
        const multiplier = trait?.bias?.[difficulty];
        return _finiteOr(trait?.weight, 0) * (Number.isFinite(multiplier) ? multiplier : 1);
    };
    const count = next() < PERSONALITY_DOUBLE_TRAIT_CHANCE
        ? PERSONALITY_MAX_GENERATED_TRAITS : 1;
    const pool = [...PERSONALITY_IDS];
    const traits = [];
    while (traits.length < count && pool.length) {
        const total = pool.reduce((sum, id) => sum + biasOf(id), 0);
        if (!(total > 0)) break;
        let roll = next() * total;
        let picked = pool[pool.length - 1];
        for (const id of pool) {
            roll -= biasOf(id);
            if (roll < 0) {
                picked = id;
                break;
            }
        }
        traits.push(picked);
        pool.splice(pool.indexOf(picked), 1);
    }
    return traits;
}

/**
 * Resolve the effective personality of one combatant for one plan.
 * Priority: `explicit` (planning context) → `flagged` (resolved
 * `flags["only-war-ai"].personality` list) → seeded generation.
 * `explicit === false` disables the personality entirely; damaged
 * explicit/flag values are ignored and fall through to generation.
 * @param {object} input
 * @param {*} [input.explicit] `context.personality` override.
 * @param {*} [input.flagged] Trait list resolved from document flags.
 * @param {*} [input.character] `context.team.character` team temperament.
 * @param {string} [input.difficulty] Resolved AI difficulty.
 * @param {string|null} [input.identity] Stable document identity.
 * @returns {{traits: string[], character: string|null, source: string}}
 *   `source` is `"context" | "flag" | "generated" | "disabled"`.
 */
export function resolvePersonality({
    explicit = undefined,
    flagged = undefined,
    character = null,
    difficulty = "normal",
    identity = null
} = {}) {
    let traits = null;
    let source = "generated";
    if (explicit === false) {
        traits = [];
        source = "disabled";
    } else {
        const fromContext = normalizePersonalityTraits(explicit);
        if (fromContext.length) {
            traits = fromContext;
            source = "context";
        }
    }
    if (traits === null) {
        const fromFlag = normalizePersonalityTraits(flagged);
        if (fromFlag.length) {
            traits = fromFlag;
            source = "flag";
        }
    }
    if (traits === null) {
        traits = generatePersonalityTraits({ identity, difficulty });
    }
    return {
        traits,
        // `explicit === false` neutralizes the team character too —
        // "no personality" means a fully deterministic plan.
        character: source === "disabled"
            ? null
            : (FIRETEAM_CHARACTERS.includes(character) ? character : null),
        source
    };
}

/**
 * Merged additive weight delta of a personality profile: personal trait
 * deltas sum together and override the team-character delta on
 * conflicting factors.
 * @param {object} input
 * @param {string[]} [input.traits] Resolved trait ids.
 * @param {string|null} [input.character] Resolved fireteam character.
 * @returns {object} `factor → delta` map.
 */
export function personalityWeightDelta({ traits = [], character = null } = {}) {
    const traitDelta = {};
    for (const id of traits ?? []) {
        const deltas = PERSONALITIES[id]?.deltas ?? {};
        for (const [key, value] of Object.entries(deltas)) {
            if (Number.isFinite(value)) {
                traitDelta[key] = (traitDelta[key] ?? 0) + value;
            }
        }
    }
    const characterDelta = FIRETEAM_CHARACTER_OVERLAYS[character]?.deltas ?? {};
    // Personal override: a trait delta replaces the team delta on the
    // same factor instead of stacking with it.
    return { ...characterDelta, ...traitDelta };
}

/**
 * Apply the personality overlay to resolved preset weights.
 * @param {object} weights Base weight map.
 * @param {object} profile `{traits, character}` resolution result.
 * @param {string[]} [profile.traits] Resolved trait ids.
 * @param {string|null} [profile.character] Resolved fireteam character.
 * @returns {object} Effective weight map (copy — the base is untouched).
 */
export function applyPersonalityOverlay(weights, { traits = [], character = null } = {}) {
    const delta = personalityWeightDelta({ traits, character });
    const effective = { ...(weights ?? {}) };
    for (const [key, value] of Object.entries(delta)) {
        effective[key] = (Number.isFinite(effective[key]) ? effective[key] : 0) + value;
    }
    return effective;
}

/**
 * Jitter amplitude for one plan: the difficulty baseline plus per-trait
 * and per-character biases, clamped to `[0, PERSONALITY_JITTER_MAX]`.
 * @param {object} input
 * @param {string[]} [input.traits]
 * @param {string|null} [input.character]
 * @param {string} [input.difficulty]
 * @returns {number} Amplitude in `[0, 0.15]`.
 */
export function personalityJitter({ traits = [], character = null, difficulty = "normal" } = {}) {
    let amp = DIFFICULTY_JITTER[difficulty] ?? DIFFICULTY_JITTER.normal;
    for (const id of traits ?? []) {
        amp += _finiteOr(PERSONALITIES[id]?.jitter, 0);
    }
    amp += _finiteOr(FIRETEAM_CHARACTER_OVERLAYS[character]?.jitter, 0);
    return Math.max(0, Math.min(PERSONALITY_JITTER_MAX, amp));
}

/**
 * Merged behavioural flags declared by the resolved traits
 * (e.g. `{ignoreRegroup: true}` of `fanatic`). Informational: the flags
 * are enforced through the weight deltas, not separate code paths.
 * @param {string[]} traits Resolved trait ids.
 * @returns {object}
 */
export function personalityBehaviorFlags(traits = []) {
    const flags = {};
    for (const id of traits ?? []) {
        for (const [key, value] of Object.entries(PERSONALITIES[id]?.flags ?? {})) {
            flags[key] = value;
        }
    }
    return flags;
}

/**
 * Deterministic per-candidate jitter multiplier `1 ± amplitude`, seeded
 * by the plan seed and the stable candidate id — independent of the
 * candidate's index in the scored list so re-orderings keep it stable.
 * @param {object} input
 * @param {number} input.seed Plan seed.
 * @param {string} input.candidateId Stable candidate id.
 * @param {number} input.amp Jitter amplitude (`personalityJitter`).
 * @returns {number} Multiplier in `[1-amp, 1+amp]` (`1` when `amp <= 0`).
 */
export function personalityJitterFactor({ seed = 0, candidateId = "", amp = 0 } = {}) {
    if (!(amp > 0)) return 1;
    const hash = parseInt(fnv1a(String(candidateId)), 16) >>> 0;
    const roll = mulberry32(((seed >>> 0) ^ PERSONALITY_JITTER_SEED_XOR ^ hash) >>> 0)();
    return 1 + (((roll * 2) - 1) * amp);
}

/**
 * Numeric helper: value when finite, otherwise fallback.
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function _finiteOr(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}
