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
import { _tokenDoc } from "../planner/documents.js";
import { DEFAULT_TACTIC_PRIORITY } from "../tactics/registry.js";
import {
    pincerFlankProgress,
    selectPincerTactic
} from "./pincer.js";
import { specOpsTokenCenter } from "./spec-ops.js";
import {
    evaluatePeelCascade
} from "../tactics/peel-withdrawal.js";

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
    tieUp: 2,
    // Smoke: assault still prefers a covered approach over a naked
    // sprint when intel is thin — a mild pull, far below charge doctrine.
    seek: 1.5,
    // Run mechanic (smoke): burning the whole turn on a sprint to close
    // on the enemy fits assault doctrine — a mild pull below charge.
    run: 1.5,
    // Recover-pinned overlay (issue #90): cover-seeking of a pinned
    // member is real but secondary for the assault doctrine; the team
    // redirect of fire onto the suppression source is a soft pull.
    recoverCover: 3,
    recoverRedirect: 2
});

/**
 * Team-task weight overlays of the assault preset (issue #88). The only
 * overlay is the loose-pincer flank pressure: `flankProgress` enters the
 * vector at weight 6 (the mirror of the spec-ops flank pull) and the
 * advance pull grows by +1 over the base doctrine — an additive delta,
 * not a replacement, so the flank element of an assault team out-advances
 * the centre instead of turning cautious.
 */
export const ASSAULT_TASK_WEIGHTS = Object.freeze({
    flank: Object.freeze({ flankProgress: 6, advance: 1 }),
    regroup: Object.freeze({
        withdrawal: 12, freeAttackCost: -8, disengage: 4, charge: -10
    })
});

/** Peel role overlays of the assault preset (issue #89). */
export const ASSAULT_ROLE_WEIGHTS = Object.freeze({
    withdraw: Object.freeze({
        withdrawal: 5, freeAttackCost: -4, attackNow: -5, attackAfterMove: -6, holdPosition: -5
    }),
    cover: Object.freeze({
        coveringWithdrawal: 8, attackNow: 3, melee: 2, overwatch: -1, withdrawal: -4
    })
});

/**
 * Evaluate one planner candidate for the assault preset. Delegates to the
 * shared weighted-factor evaluator and annotates the breakdown with the
 * preset/variant so diagnostics explain *why* a charge or approach won.
 * Inside a fireteam (`context.team.task`) the `flank` overlay applies the
 * loose-pincer pressure of issue #88: the per-member signed `flankPoint`
 * injected by the fireteam pulls the element toward its own maneuver
 * point — scoring only, never a hard veto.
 * @param {object} input Evaluation input from the planner.
 * @param {object} [input.factors] Factor vector (`SCORE_FACTORS`).
 * @param {object} [input.candidate] Scored candidate `{variant, target, move, action}`.
 * @param {object} [input.weights] Effective merged weights.
 * @param {object} [input.context] Planning context (`team`, `selfPos`).
 * @returns {{score: number, breakdown: object}}
 */
export function evaluateAssault({ factors = {}, candidate = {}, weights = ASSAULT_WEIGHTS,
    context = {} } = {}) {
    const flank = context.team?.task === "flank";
    const enriched = { ...factors };
    let effective = weights;
    if (flank) {
        enriched.flankProgress = pincerFlankProgress(candidate, context);
        effective = {
            ...weights,
            flankProgress: ASSAULT_TASK_WEIGHTS.flank.flankProgress,
            advance: (weights.advance ?? 0) + ASSAULT_TASK_WEIGHTS.flank.advance
        };
    }
    const role = typeof context.team?.role === "string" ? context.team.role : null;
    if (context.team?.task === "regroup") {
        effective = { ...effective, ...ASSAULT_TASK_WEIGHTS.regroup };
    }
    if (ASSAULT_ROLE_WEIGHTS[role]) {
        effective = { ...effective };
        for (const [key, delta] of Object.entries(ASSAULT_ROLE_WEIGHTS[role])) {
            effective[key] = (effective[key] ?? 0) + delta;
        }
        if (role === "cover") {
            const mode = context.team?.peel?.coverMode ?? null;
            enriched.coveringWithdrawal = mode === "overwatch"
                ? (candidate.variant === "overwatch" ? 1 : 0)
                : (candidate.variant === "attack-in-place" || candidate.variant === "move-attack"
                    || candidate.variant === "charge" ? 1 : 0);
        }
    }
    const evaluation = evaluateFactors(enriched, effective);
    return {
        score: evaluation.score,
        breakdown: {
            ...evaluation.breakdown,
            preset: ASSAULT_PRESET_ID,
            variant: candidate.variant ?? null,
            charge: candidate.variant === "charge",
            ...(flank ? { team: { task: "flank", flankProgress: enriched.flankProgress } } : {})
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
        allowNoAction: true,
        // Smoke finding: assault doctrine closes with the enemy — with
        // zero intel (no LOS, memory or relay) the squad's radio puts
        // rough unattackable approach markers on the nearest hostiles.
        seekContacts: true
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

/**
 * Assault team tactic selector (issue #88): the loose pincer variant is
 * the preset's only maneuver — a pure-melee assault squad has no fix base
 * worth pinning with, so the centre element assaults through the middle
 * while the two flank elements pressure the signed maneuver points. The
 * contract is deliberately thinner than the spec-ops pincer: `sync:
 * "none"` (nobody holds a strike), no angle proof, no hard veto — the
 * flank pull lives entirely in the `flankProgress` scoring overlay. A
 * `null` name means the default fireteam policy applies unchanged.
 *
 * Positions are center-normalized exactly like the spec-ops adapter so
 * the pure geometry sees token centres, not top-left corners.
 * @param {object} input
 * @param {object[]} [input.members] Fireteam member entries.
 * @param {string|null} [input.leaderId] Leader combatant id.
 * @param {object[]|null} [input.targets] Normalized targets.
 * @param {object|null} [input.objective] Shared objective.
 * @param {*} [input.moraleTier] Team morale tier.
 * @param {object|null} [input.scene] Planning scene.
 * @param {object|null} [input.combat] Combat document.
 * @param {object} [input.context] Planning context (`walls`, `navigation`).
 * @param {object} [input.config] Pincer config overrides.
 * @param {number|object} [input.casualties] Casualty count/detail forwarded
 *   to peel-withdrawal.
 * @param {object|null} [input.moraleInfo] Full morale evaluation forwarded
 *   to peel-withdrawal.
 * @returns {object} Serializable tactic descriptor (`pincer-loose`,
 *   degraded `flank-and-fix`) or a `name: null` fallthrough record.
 */
export function selectAssaultTactic({
    members = [],
    leaderId = null,
    targets = null,
    objective = null,
    moraleTier = null,
    scene = null,
    combat = null,
    context = {},
    config = null,
    casualties = 0,
    moraleInfo = null
} = {}) {
    const planningScene = context.scene ?? scene ?? combat?.scene ?? context.combat?.scene ?? null;
    const planningCombat = combat ?? context.combat ?? null;
    const positioned = (members ?? [])
        .filter(m => m && m.combatantId && m.defeated !== true && m.enabled !== false)
        .sort((a, b) => String(a.combatantId).localeCompare(String(b.combatantId)))
        .map(member => ({
            ...member,
            position: specOpsTokenCenter(_tokenDoc(member.combatant?.token),
                planningScene, member.position),
            positionIsCenter: true
        }));
    // Issue #89: a triggered peel outranks the loose pincer — survival
    // doctrine beats committing the assault. Rejection is diagnostic-only
    // and the ordinary pincer cascade continues unchanged.
    const peel = evaluatePeelCascade({
        members,
        leaderId,
        targets,
        casualties,
        moraleInfo: moraleInfo ?? context.moraleInfo
            ?? (moraleTier ?? context.moraleTier
                ? { tier: moraleTier ?? context.moraleTier }
                : null),
        moraleTier: moraleTier ?? context.moraleTier ?? null,
        scene: planningScene,
        combat: planningCombat,
        context
    });
    if (peel.descriptor) return peel.descriptor;
    const base = selectPincerTactic({
        members: positioned,
        leaderId,
        targets,
        objective,
        moraleTier: moraleTier ?? context.moraleTier ?? null,
        loose: true,
        variant: "assault",
        scene: planningScene,
        combat: planningCombat,
        navigation: context.navigation ?? null,
        context,
        config
    });
    return {
        ...base,
        breakdown: {
            ...(base.breakdown ?? {}),
            peel: {
                selected: false,
                reason: peel.reason ?? null,
                rejections: [...(peel.rejections ?? [])]
            }
        }
    };
}

/**
 * Default tactic factory passed to `fireteam.buildTeamPlan` as
 * `context.tactic` (auto-applied for `teamPreset === "assault"`).
 * @param {object} input Selector input (see {@link selectAssaultTactic}).
 * @returns {object} Tactic descriptor.
 */
export function assaultTactic(input = {}) {
    return selectAssaultTactic(input);
}

/**
 * Register/replace the assault maneuver selector on a tactic registry
 * (issue #88). Mirrors the spec-ops registration: explicit
 * `context.tactic` still wins over the registered selector.
 * @param {object} tactics Tactic registry (`api.services.get("tactics")`).
 * @returns {object} The stored selector record.
 */
export function registerAssaultTacticSelector(tactics) {
    if (!tactics || typeof tactics.registerTacticSelector !== "function") {
        throw new Error("[only-war-ai] Assault tactic requires a tactic registry");
    }
    return tactics.registerTacticSelector({
        presetId: ASSAULT_PRESET_ID,
        kind: "maneuver",
        priority: DEFAULT_TACTIC_PRIORITY,
        select: assaultTactic
    });
}
