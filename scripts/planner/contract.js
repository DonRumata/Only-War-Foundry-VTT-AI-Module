/**
 * Planner decomposition (issue #403 follow-up): this module was extracted
 * verbatim from scripts/planner.js — see that file for the design contract.
 * The planner service re-exports the public surface so existing importers
 * and tests keep working.
 */
/** Result statuses of {@link createPlannerService.planTurn}. */
export const PLANNER_STATUS = Object.freeze({
    ok: "ok",
    noTarget: "no-target",
    noAction: "no-action",
    noRoute: "no-route",
    disabled: "disabled",
    unsupported: "unsupported",
    waitingForGm: "waiting-for-gm"
});


/**
 * Stable stale reason codes returned by `validateSnapshot`. The executor
 * maps them to the replan policy; `combat-ended` is terminal.
 */
export const STALE_REASONS = Object.freeze({
    turnStale: "turn-stale",
    tokenMoved: "token-moved",
    targetGone: "target-gone",
    resourcesChanged: "resources-changed",
    collisionChanged: "collision-changed",
    statusesChanged: "statuses-changed",
    combatEnded: "combat-ended",
    invalidPlan: "invalid-plan",
    stale: "stale"
});


/** Serializable action step types allowed inside a plan. */
export const STEP_TYPES = Object.freeze([
    "move", "attack", "test", "aim", "reload", "overwatch",
    "ready-weapon", "drop-prone", "delay", "end-turn"
]);


/** Half-action units available to a combatant per turn (issue #15). */
export const ACTION_BUDGET_HALVES = 2;


/** Reasons that justify rebuilding the snapshot and replanning once. */
export const REPLAN_REASONS = Object.freeze(new Set([
    STALE_REASONS.turnStale,
    STALE_REASONS.tokenMoved,
    STALE_REASONS.targetGone,
    STALE_REASONS.resourcesChanged,
    STALE_REASONS.collisionChanged,
    STALE_REASONS.statusesChanged,
    "step-failed",
    "operation-conflict"
]));


/** Decision actions of {@link createPlannerService.shouldReplan}. */
export const REPLAN_ACTIONS = Object.freeze({
    replan: "replan",
    holdAndReport: "hold-and-report"
});


/** Default replan budget for a single AI turn. */
export const DEFAULT_MAX_REPLANS = 1;


/** Bound on target candidates evaluated per turn. */
export const DEFAULT_MAX_TARGETS = 8;


/** Bound on movement candidates requested per target. */
export const DEFAULT_MOVE_CANDIDATES = 8;


/** Bound on attack action candidates evaluated per target. */
export const DEFAULT_MAX_ACTIONS = 3;


/** Melee reach fallback (scene units) when an action carries no range. */
export const DEFAULT_MELEE_RANGE = 2;


/**
 * Factor names the default evaluator understands. Preset `weights` map a
 * subset of these names to numbers; missing weights mean a 0 contribution.
 */
export const SCORE_FACTORS = Object.freeze([
    "attackNow",
    "attackAfterMove",
    "charge",
    "melee",
    "advance",
    "threat",
    "proximity",
    "los",
    "cover",
    "exposure",
    "holdPosition",
    "lastKnown",
    "budgetOver",
    "attackType",
    "vulnerable",
    "engaged",
    "meleeEngage",
    "area",
    "aim",
    "aimAlone",
    "reload",
    "overwatch",
    "danger",
    "weaponAffinity",
    "weaponInertia",
    "dropProne",
    "readyWeapon",
    "alliedEngagement",
    "leaveMeleeEngage",
    "engageDenial",
    "unpin",
    "grudge",
    "order",
    "ev",
    "stickyTarget",
    "outnumber",
    "tieUp",
    "seek",
    "run",
    "withdrawal",
    "coveringWithdrawal",
    "freeAttackCost",
    "disengage",
    "recoverCover",
    "recoverRedirect"
]);


/**
 * Tactical-layer tuning constants (issue #16): the lookahead penalty
 * weight `λ`, how many top candidates the 2-ply counter model re-scores,
 * the deliberate-slip probability of easy difficulty and how many
 * next-best candidates that slip may pick from.
 */
export const DEFAULT_LOOKAHEAD_LAMBDA = 0.5;

export const DEFAULT_LOOKAHEAD_TOP_K = 4;

export const EASY_MISTAKE_CHANCE = 0.3;

export const EASY_PICK_TOP_K = 3;


/**
 * Seed XOR mask for the easy-mode slip roll — a stream independent of
 * the tie-break shuffle so the two never correlate.
 */
export const EASY_PICK_SEED_XOR = 0x9e3779b9;


/**
 * Default weight set вЂ” the merge base for every registered preset. Combat
 * presets (issue #404+) override these values; the `0` entries simply keep
 * the new factors visible in score breakdowns without changing skeleton
 * behaviour.
 */
export const DEFAULT_PRESET_WEIGHTS = Object.freeze({
    attackNow: 10,
    attackAfterMove: 6,
    charge: 0,
    melee: 0,
    advance: 2,
    threat: 2,
    proximity: 1,
    los: 1,
    cover: 0,
    exposure: 0,
    holdPosition: 0,
    lastKnown: 0.5,
    budgetOver: 0,
    attackType: 0,
    vulnerable: 0,
    engaged: 0,
    meleeEngage: 0,
    area: 0,
    aim: 0,
    aimAlone: 0.5,
    reload: 3,
    overwatch: 0,
    danger: -1,
    // Issue #37: weapon inertia is a small hysteresis on the last-used
    // weapon (factor × weight ≈ +0.15); preferred/trait affinity and the
    // free-action candidates carry no default pull.
    weaponAffinity: 0,
    weaponInertia: 0.15,
    dropProne: 0,
    readyWeapon: 0,
    // Issue #39 + smoke: firing into an ally's melee is a real penalty
    // (−20 by the rules); walking out of an enemy's reach provokes a free
    // attack, so even a skeleton bot pays a modest price for the exit.
    alliedEngagement: -4,
    leaveMeleeEngage: -3,
    engageDenial: 0,
    unpin: 4,
    grudge: 2,
    // Issue #38: a leader's order is the moderate utility turn — it must
    // never outbid a ready attack, but always beats an empty hold.
    order: 5,
    ev: 1,
    // Smoke finding: a bot should keep pressing the target it already
    // attacks instead of ping-ponging between near-equal charge options;
    // ganging up on an ally-engaged hostile is the melee doctrine bonus.
    stickyTarget: 4,
    outnumber: 0,
    // Spec-ops doctrine: binding a known pure shooter in melee switches
    // its gun off — a doctrine bonus, not a universal default.
    tieUp: 0,
    // Seek mechanic (smoke request): closing on a non-visible contact
    // through wall-blocked endpoints is a doctrine preference, not a
    // universal default.
    seek: 0,
    // Run mechanic (smoke request): a full-action sprint at the run rate.
    // Distance closed is already paid by `advance` — the factor only
    // carries preset taste for burning the whole turn on movement.
    run: 0,
    // Peel-withdrawal (issue #89): doctrine factors are zero in the
    // skeleton — only team-role overlays of combat presets price an
    // organized withdrawal, cover fire and the explicit free-attack cost.
    withdrawal: 0,
    coveringWithdrawal: 0,
    freeAttackCost: 0,
    disengage: 0,
    // Recover-pinned overlay (issue #90): both factors are zero without an
    // active fireteam `team.recover` injection, so solo behaviour is
    // bit-for-bit unchanged. The defaults keep the experimental channel
    // visible in skeleton breakdowns without pricing doctrine.
    recoverCover: 3,
    recoverRedirect: 1
});


/**
 * How many distinct hidden endpoints the seek variant may propose per
 * memory-source target.
 */
export const SEEK_MAX_CANDIDATES = 3;


/**
 * Skeleton preset definitions registered by default. Real preset behaviour
 * lands in follow-up issues; these weights only need to produce a sane
 * trivial plan (move toward the target, attack when in range).
 * `allowNoTarget`/`allowNoAction` let defensive presets still produce a
 * hold plan instead of a failure status.
 */
export const PRESET_SKELETONS = Object.freeze({
    assault: Object.freeze({
        weights: Object.freeze({
            ...DEFAULT_PRESET_WEIGHTS,
            seek: 1.5,
            run: 1.5
        }),
        // Smoke finding: assault closes with the enemy — radio-intel
        // approach markers kick in at zero intel.
        seekContacts: true
    }),
    rangedCover: Object.freeze({
        weights: Object.freeze({
            ...DEFAULT_PRESET_WEIGHTS,
            cover: 4,
            los: 3,
            holdPosition: 1,
            advance: 0.5,
            aim: 2,
            overwatch: 2
        })
    }),
    hold: Object.freeze({
        weights: Object.freeze({
            ...DEFAULT_PRESET_WEIGHTS,
            attackAfterMove: 4,
            holdPosition: 4,
            threat: 1,
            proximity: 0.5,
            advance: -1,
            aim: 3,
            overwatch: 2
        }),
        allowNoTarget: true,
        allowNoAction: true,
        alwaysOfferHold: true
    }),
    specOps: Object.freeze({
        weights: Object.freeze({
            ...DEFAULT_PRESET_WEIGHTS,
            attackAfterMove: 6,
            threat: 3,
            proximity: 1.5,
            los: 2,
            cover: 1,
            lastKnown: 1,
            aim: 2,
            overwatch: 1,
            // Doctrine: cautious wall-hugging advance on hearsay beats
            // sprinting into the presumed firing lane.
            seek: 3,
            run: 1
        }),
        allowNoAction: true,
        // Smoke finding: spec-ops seek contact — radio-intel approach
        // markers kick in at zero intel.
        seekContacts: true
    })
});


/** Actor `system` keys summarized into the snapshot resource block. */
export const RESOURCE_KEYS = Object.freeze([
    "wounds",
    "fate",
    "insanity",
    "corruption",
    "fatigue"
]);


/** Cap on item summaries stored in a snapshot. */
export const MAX_SNAPSHOT_ITEMS = 16;


/**
 * Desire value of each system-API attack type (issue #413) — the
 * `attackType` factor presets weight. Unknown/custom types score the
 * neutral default.
 */
export const ATTACK_TYPE_DESIRE = Object.freeze({
    allOut: 0.8,
    lightning: 0.9,
    swift: 0.6,
    charge: 0.6,
    standard: 0.5,
    semi_auto: 0.7,
    full_auto: 0.9,
    ripper_charge: 0.6,
    called_shot: 0.4,
    suppressing_fire: 0.55
});


/** Neutral `attackType` factor for null/custom attack types. */
export const ATTACK_TYPE_DESIRE_DEFAULT = 0.5;


/**
 * Per-weapon cap of attack-type candidates kept by the curation in
 * {@link _resolveActions} so one weapon cannot crowd out others under
 * `DEFAULT_MAX_ACTIONS`.
 */
export const MAX_ATTACK_TYPES_PER_WEAPON = 3;


/** Curated preference order of melee attack types (best first). */
export const MELEE_ATTACK_TYPE_ORDER = Object.freeze([
    "allOut",
    "charge",
    "standard",
    "lightning",
    "swift",
    "called_shot"
]);


/** Curated preference order of ranged attack types (best first). */
export const RANGED_ATTACK_TYPE_ORDER = Object.freeze([
    "full_auto",
    "semi_auto",
    "standard",
    "ripper_charge",
    "called_shot",
    "suppressing_fire"
]);


/**
 * Attack types never kept as candidates. Currently empty: the step
 * contract carries `targetPoint`/`template` geometry, so even
 * `suppressing_fire` is reachable (issue #14).
 */
export const EXCLUDED_ATTACK_TYPES = Object.freeze(new Set());


/** Cone angle (degrees) the system places for spray weapons. */
export const SPRAY_CONE_DEG = 30;


/** Cone angle (degrees) the system places for suppressing fire. */
export const SUPPRESSION_CONE_DEG = 45;


/**
 * Watch-cone angle (degrees) of a plain ranged overwatch declaration
 * (issue #54): spray weapons declare their own template arc instead,
 * blast weapons a trigger circle — neither reads this default.
 */
export const OVERWATCH_CONE_DEG = 45;


/** Status ids that mark a target as vulnerable to attack. */
export const VULNERABLE_STATUSES = Object.freeze(new Set(["pinned", "prone", "stunned"]));


/**
 * Default dodge TN of a target when neither its profile nor the plan
 * context carries one (issue #37 counter-EV): a rough Only War Dodge ~30.
 * Precision is not the goal — the model only needs target sorting.
 */
export const DEFAULT_DODGE_TN = 30;


/** Hard cap of the dodge probability applied to attack EV. */
export const MAX_DODGE_CHANCE = 0.95;


/** Minimum aggregated danger that justifies a free drop-prone turn. */
export const DROP_PRONE_DANGER = 0.5;


/**
 * Threat margin (0..1) a different charge target must clear over the
 * enemy already in melee reach before an engaged bot may disengage and
 * charge it instead (smoke finding).
 */
export const CHARGE_SWITCH_MARGIN = 0.25;


/**
 * Minimum straight-line distance (scene units) a charge must cover
 * before contact — OW requires a running start; a bot already close
 * cannot charge.
 */
export const CHARGE_MIN_DISTANCE = 4;


/**
 * Fraction of one grid cell a charge route's waypoint may deviate from
 * the straight self→endpoint segment before the route counts as bent
 * (OW: a charge moves in a straight line).
 */
export const CHARGE_STRAIGHT_TOLERANCE = 0.75;


/** Candidate variants that produce an attack/test step. */
export const ATTACK_VARIANTS = Object.freeze(new Set([
    "attack-in-place", "move-attack", "charge", "aim-attack"
]));
