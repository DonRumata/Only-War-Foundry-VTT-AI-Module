/**
 * Assault preset «Штурм» (issue #404, epic #363).
 *
 * Behaviour contract:
 * - The best visible hostile target wins; `threat`/`proximity` weights make
 *   the priority explainable through the score breakdown.
 * - A legal charge (a move candidate that lands inside melee reach while a
 *   melee action is available and within the action budget) is the
 *   preferred plan: `charge` + `melee` + `attackAfterMove` weights dominate
 *   every lesser approach.
 * - Otherwise the NPC advances at full budget toward the target and uses
 *   the best available attack — a ranged `move-attack` when the candidate
 *   lands inside weapon range, or a pure `approach` move that ends the turn
 *   with `no-attack` when nothing can fire.
 * - A `last-known` contact is only a movement destination (`canAttack` is
 *   always false for it); with no contacts at all `allowNoTarget` produces
 *   a safe hold plan, and unreachable routes fall back to the planner's
 *   `no-route` diagnostic instead of a forced move.
 * - `budgetOver` penalizes candidates that exceed the numeric movement
 *   budget, `exposure` mildly prefers covered approach lanes.
 *
 * The preset is pure data (weights) plus a thin evaluator that annotates
 * the shared factor breakdown — candidate legality lives in the planner.
 */
import { evaluateFactors } from "../planner.js";

/** Preset id registered in the planner preset registry. */
export const ASSAULT_PRESET_ID = "assault";

/**
 * Data-driven weights for the assault preset. Factor names match
 * `SCORE_FACTORS` in `scripts/planner.js`; missing factors contribute 0.
 */
export const ASSAULT_WEIGHTS = Object.freeze({
    attackNow: 10,
    attackAfterMove: 8,
    charge: 14,
    melee: 5,
    advance: 6,
    threat: 3,
    proximity: 2,
    los: 2,
    cover: 0,
    exposure: -1,
    holdPosition: -4,
    lastKnown: 0.5,
    budgetOver: -8,
    attackType: 0.2,
    vulnerable: 1,
    meleeEngage: 6,
    area: 4,
    aim: 0,
    aimAlone: 0.5,
    reload: 3,
    overwatch: 0,
    // Issue #16: assault accepts risky lanes — danger only mildly deters.
    danger: -0.5,
    // Issue #37: signature weapons and a ready alternative are worth a
    // real pull; lying down mid-charge is not the assault answer.
    weaponAffinity: 1,
    weaponInertia: 0.15,
    dropProne: 0,
    readyWeapon: 2,
    // Issue #39: assault shrugs off shooting into a friendly melee more
    // than other presets, but still avoids free attacks on the way out;
    // closing into contact and avenging hits are core doctrine.
    alliedEngagement: -2,
    // Smoke: a re-charge away from a live engagement provokes a free
    // attack and ping-pongs the bot between targets — price the exit
    // like the free swing it draws, not like a casual reposition.
    leaveMeleeEngage: -10,
    engageDenial: 4,
    unpin: 4,
    grudge: 4,
    ev: 1,
    // Smoke finding: assault keeps swinging at the target it already
    // attacks — the sticky pull must outbid the charge differential that
    // otherwise ping-pongs it between near-equal hostiles; ganging up on
    // an ally-engaged target is core melee doctrine.
    stickyTarget: 8,
    outnumber: 4,
    // Smoke: closing on a known pure shooter denies its fire too — a
    // modest tie-up pull, secondary to the charge doctrine itself.
    tieUp: 2
});

/**
 * Evaluate one planner candidate for the assault preset. Delegates to the
 * shared weighted-factor evaluator and annotates the breakdown with the
 * preset/variant so diagnostics explain *why* a charge or approach won.
 * @param {object} input Evaluation input from the planner.
 * @param {object} [input.factors] Factor vector (`SCORE_FACTORS`).
 * @param {object} [input.candidate] Scored candidate `{variant, target, move, action}`.
 * @param {object} [input.weights] Effective merged weights.
 * @returns {{score: number, breakdown: object}}
 */
export function evaluateAssault({ factors = {}, candidate = {}, weights = ASSAULT_WEIGHTS } = {}) {
    const evaluation = evaluateFactors(factors, weights);
    return {
        score: evaluation.score,
        breakdown: {
            ...evaluation.breakdown,
            preset: ASSAULT_PRESET_ID,
            variant: candidate.variant ?? null,
            charge: candidate.variant === "charge"
        }
    };
}

/**
 * Build the planner `registerPreset` definition for the assault preset.
 * `allowNoTarget`/`allowNoAction` let the preset hold or keep advancing
 * instead of failing when contacts or weapons are missing.
 * @returns {object} Preset definition for `planner.registerPreset`.
 */
export function assaultPresetDefinition() {
    return {
        weights: { ...ASSAULT_WEIGHTS },
        evaluate: evaluateAssault,
        allowNoTarget: true,
        allowNoAction: true
    };
}

/**
 * Register/replace the assault preset on a planner service instance.
 * Called once on `init` after the planner service is created.
 * @param {object} planner Planner service (`api.services.get("planner")`).
 * @returns {object} The stored preset definition.
 */
export function registerAssaultPreset(planner) {
    if (!planner || typeof planner.registerPreset !== "function") {
        throw new Error("[only-war-ai] Assault preset requires a planner service");
    }
    return planner.registerPreset(ASSAULT_PRESET_ID, assaultPresetDefinition());
}
