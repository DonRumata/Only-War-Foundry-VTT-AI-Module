/**
 * Planner service (issue #403): immutable planning snapshots, deterministic
 * candidate scoring, serializable plans and the stale-plan/replan policy.
 *
 * Design contract (epic #363):
 * - Planning works on an immutable DTO snapshot вЂ” a plain, JSON-serializable
 *   object captured at planning time. Plans never hold Document instances.
 * - `planTurn(combat, combatant, context)` is deterministic: identical
 *   snapshot + preset weights + seed always produce the identical plan.
 *   Tie-breaking between equal-score candidates uses a mulberry32 PRNG fed
 *   by the recorded `plan.seed`.
 * - Sibling services are resolved lazily through the registry
 *   (`api.services.get("authority" | "perception" | "navigation")`) or
 *   injected via `context` вЂ” every lookup degrades to a safe fallback so
 *   the planner works before/without the other stacked branches.
 * - `validateSnapshot(plan, currentContext)` runs before every
 *   state-changing step: a cheap revision fingerprint is compared first,
 *   and only a mismatch triggers the ordered checks that produce a stable
 *   stale reason code.
 * - `shouldReplan(failure)` allows at most `maxReplans` (default 1) full
 *   replans per turn; after the budget is spent the AI holds and reports
 *   a diagnostic reason for the GM instead of acting on stale state.
 */
import {
    AI_DIFFICULTIES,
    COMMITMENT_THREAT_MAX,
    COMMITMENT_TTL_ROUNDS,
    FALLBACK_PRESET,
    FLAG_KEYS,
    MODULE_ID
} from "./constants.js";
import { resolveEffectiveConfig } from "./config-resolver.js";
import {
    applyCommitmentLayer,
    applyMoraleLayer,
    applyMoraleWeightShift,
    boundedPersonalityOverlay,
    moralePostureOf,
    moraleTierOf,
    recordLayerReason,
    resolveLayerFlags
} from "./layers.js";
import {
    personalityBehaviorFlags,
    personalityIdentity,
    personalityJitter,
    personalityJitterFactor,
    personalityWeaponAffinity,
    resolvePersonality
} from "./personalities.js";
import { grudgeActive } from "./grudges.js";
import { reactionUsed } from "./reactions.js";
import { buildLayerTrace, factorDelta } from "./trace.js";
import { getAIDifficulty, logDiagnostics } from "./settings.js";
import {
    buildThreatMap,
    expectedCounterDamage,
    threatSourcesOf
} from "./threat-map.js";

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
    "outnumber"
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
const EASY_PICK_SEED_XOR = 0x9e3779b9;

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
    // Issue #39: firing into an ally's melee is a real penalty (−20 by
    // the rules); the grudge and unpin pulls are the documented defaults,
    // while disengage/engage awareness stays neutral for skeleton bots.
    alliedEngagement: -2,
    leaveMeleeEngage: 0,
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
    outnumber: 0
});

/**
 * Skeleton preset definitions registered by default. Real preset behaviour
 * lands in follow-up issues; these weights only need to produce a sane
 * trivial plan (move toward the target, attack when in range).
 * `allowNoTarget`/`allowNoAction` let defensive presets still produce a
 * hold plan instead of a failure status.
 */
export const PRESET_SKELETONS = Object.freeze({
    assault: Object.freeze({
        weights: Object.freeze({ ...DEFAULT_PRESET_WEIGHTS })
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
            overwatch: 1
        }),
        allowNoAction: true
    })
});

/** Actor `system` keys summarized into the snapshot resource block. */
const RESOURCE_KEYS = Object.freeze([
    "wounds",
    "fate",
    "insanity",
    "corruption",
    "fatigue"
]);

/** Cap on item summaries stored in a snapshot. */
const MAX_SNAPSHOT_ITEMS = 16;

/**
 * Desire value of each system-API attack type (issue #413) — the
 * `attackType` factor presets weight. Unknown/custom types score the
 * neutral default.
 */
const ATTACK_TYPE_DESIRE = Object.freeze({
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
const ATTACK_TYPE_DESIRE_DEFAULT = 0.5;

/**
 * Per-weapon cap of attack-type candidates kept by the curation in
 * {@link _resolveActions} so one weapon cannot crowd out others under
 * `DEFAULT_MAX_ACTIONS`.
 */
const MAX_ATTACK_TYPES_PER_WEAPON = 3;

/** Curated preference order of melee attack types (best first). */
const MELEE_ATTACK_TYPE_ORDER = Object.freeze([
    "allOut",
    "charge",
    "standard",
    "lightning",
    "swift",
    "called_shot"
]);

/** Curated preference order of ranged attack types (best first). */
const RANGED_ATTACK_TYPE_ORDER = Object.freeze([
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
const EXCLUDED_ATTACK_TYPES = Object.freeze(new Set());

/** Cone angle (degrees) the system places for spray weapons. */
const SPRAY_CONE_DEG = 30;

/** Cone angle (degrees) the system places for suppressing fire. */
const SUPPRESSION_CONE_DEG = 45;

/**
 * Watch-cone angle (degrees) of a plain ranged overwatch declaration
 * (issue #54): spray weapons declare their own template arc instead,
 * blast weapons a trigger circle — neither reads this default.
 */
const OVERWATCH_CONE_DEG = 45;

/** Status ids that mark a target as vulnerable to attack. */
const VULNERABLE_STATUSES = Object.freeze(new Set(["pinned", "prone", "stunned"]));

/**
 * Default dodge TN of a target when neither its profile nor the plan
 * context carries one (issue #37 counter-EV): a rough Only War Dodge ~30.
 * Precision is not the goal — the model only needs target sorting.
 */
export const DEFAULT_DODGE_TN = 30;

/** Hard cap of the dodge probability applied to attack EV. */
const MAX_DODGE_CHANCE = 0.95;

/** Minimum aggregated danger that justifies a free drop-prone turn. */
const DROP_PRONE_DANGER = 0.5;

/**
 * Deterministic 32-bit FNV-1a fingerprint, identical on every client.
 * @param {string} text
 * @returns {string} Hex string, zero-padded to 8 chars.
 */
export function fnv1a(text) {
    let hash = 0x811c9dc5;
    const str = String(text);
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}

/**
 * JSON serialization with recursively sorted object keys so equal inputs
 * hash identically regardless of property insertion order.
 * @param {*} value
 * @returns {string}
 */
export function stableStringify(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) {
        return `[${value.map(entry => stableStringify(entry)).join(",")}]`;
    }
    const keys = Object.keys(value).sort();
    const parts = keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${parts.join(",")}}`;
}

/**
 * Mulberry32 PRNG вЂ” small, fast and fully deterministic for a given seed.
 * @param {number} seed 32-bit integer seed.
 * @returns {Function} `() => number` in `[0, 1)`.
 */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function() {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Deep-freeze helper for immutable snapshots and plans.
 * @param {*} value
 * @returns {*}
 */
function _deepFreeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        for (const key of Object.keys(value)) _deepFreeze(value[key]);
        Object.freeze(value);
    }
    return value;
}

/**
 * Strip anything non-serializable via a JSON round-trip. Guarantees the
 * plan holds no Document instances, functions or undefined properties.
 * @param {*} value
 * @returns {*}
 */
function _jsonClone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * Normalize a Foundry collection/Map/array/iterable into a plain array.
 * @param {*} collection
 * @returns {object[]}
 */
function _list(collection) {
    if (!collection) return [];
    if (Array.isArray(collection)) return collection;
    if (Array.isArray(collection.contents)) return collection.contents;
    if (typeof collection.values === "function") return [...collection.values()];
    if (typeof collection[Symbol.iterator] === "function") return [...collection];
    return [];
}

/**
 * Unwrap a Token placeable to its TokenDocument; documents pass through.
 * @param {*} token
 * @returns {object|null}
 */
function _tokenDoc(token) {
    if (!token || typeof token !== "object") return null;
    const doc = token.document;
    if (doc && typeof doc === "object" && doc.documentName === "Token") return doc;
    return token;
}

/**
 * Actor linked to a combatant or token.
 * @param {*} ref
 * @returns {object|null}
 */
function _actorOf(ref) {
    if (!ref || typeof ref !== "object") return null;
    if (ref.actor && typeof ref.actor === "object") return ref.actor;
    if (ref.documentName === "Actor") return ref;
    if ("system" in ref && !("token" in ref)) return ref;
    return null;
}

/**
 * Top-left position of a token document.
 * @param {object} doc
 * @returns {{x: number|null, y: number|null}}
 */
function _tokenPosition(doc) {
    const x = doc?._source?.x ?? doc?.x ?? doc?.object?.x;
    const y = doc?._source?.y ?? doc?.y ?? doc?.object?.y;
    return {
        x: Number.isFinite(x) ? x : null,
        y: Number.isFinite(y) ? y : null
    };
}

/**
 * Scene-scoped token UUID, reconstructing one for fixtures without `uuid`.
 * @param {object} doc
 * @param {string|null} sceneId
 * @returns {string|null}
 */
function _tokenUuid(doc, sceneId) {
    if (typeof doc?.uuid === "string" && doc.uuid) return doc.uuid;
    if (doc?.id) return `Scene.${sceneId ?? "scene"}.Token.${doc.id}`;
    return null;
}

/**
 * Actor UUID, reconstructing a world-scoped id for fixtures.
 * @param {object} actor
 * @returns {string|null}
 */
function _actorUuid(actor) {
    if (typeof actor?.uuid === "string" && actor.uuid) return actor.uuid;
    return actor?.id ? `Actor.${actor.id}` : null;
}

/**
 * Scene the combat runs on: explicit override, `combat.scene`, then the
 * active canvas scene.
 * @param {object} context
 * @param {object} combat
 * @returns {object|null}
 */
function _sceneOf(context, combat) {
    return context.scene ?? combat?.scene ?? globalThis.canvas?.scene ?? null;
}

/**
 * Grid description of a scene in a normalized, serializable shape.
 * @param {object|null} scene
 * @returns {{type: *, size: *, distance: *}}
 */
function _gridInfo(scene) {
    const grid = scene?.grid ?? {};
    return {
        type: grid.type ?? null,
        size: Number.isFinite(grid.size) ? grid.size : null,
        distance: Number.isFinite(grid.distance) ? grid.distance : 1
    };
}

/**
 * Cheap collision fingerprint of a scene: sorted wall ids + geometry +
 * door state. Recomputed at validation time without touching navigation.
 * @param {object|null} scene
 * @returns {string|null} FNV-1a fingerprint or null when walls are
 *   unavailable on both sides (treated as "unchanged").
 */
function _collisionRevision(scene) {
    const walls = _list(scene?.walls);
    if (!walls.length) return null;
    const parts = walls
        .map(wall => {
            const doc = wall?.document ?? wall;
            const coords = doc?.c ?? doc?.coords ?? null;
            const door = doc?.door?.state ?? doc?.doorState ?? doc?.ds ?? null;
            const move = doc?.move ?? doc?.movement ?? null;
            return `${doc?.id ?? "?"}|${Array.isArray(coords) ? coords.join(",") : ""}|${door}|${move}`;
        })
        .sort();
    return fnv1a(parts.join(";"));
}

/**
 * Serialized resource summary of an actor: only numeric `{value[, max]}`
 * pairs and plain numbers from the allow-list keys.
 * @param {object|null} actor
 * @returns {object}
 */
function _resourcesOf(actor) {
    const resources = {};
    const system = actor?.system ?? {};
    for (const key of RESOURCE_KEYS) {
        const raw = system[key];
        if (Number.isFinite(raw)) {
            resources[key] = { value: raw };
        } else if (raw && typeof raw === "object" && Number.isFinite(raw.value)) {
            const entry = { value: raw.value };
            if (Number.isFinite(raw.max)) entry.max = raw.max;
            if (Number.isFinite(raw.min)) entry.min = raw.min;
            resources[key] = entry;
        }
    }
    return resources;
}

/**
 * Fingerprint of the actor resource summary вЂ” compared by the
 * `resources-changed` stale check.
 * @param {object|null} actor
 * @returns {string}
 */
function _resourcesFingerprint(actor) {
    return fnv1a(stableStringify(_resourcesOf(actor)));
}

/**
 * Minimal serializable item summaries (weapons first, then the rest up to
 * the cap). Never carries Document references.
 * @param {object|null} actor
 * @returns {object[]}
 */
function _itemSummaries(actor) {
    const items = _list(actor?.items)
        .filter(item => item && typeof item === "object")
        .map(item => {
            const system = item.system ?? {};
            const clip = system.clip?.value ?? system.ammo?.value;
            const blast = system.blastRadius ?? system.traits?.blast;
            return {
                id: item.id ?? null,
                uuid: typeof item.uuid === "string" ? item.uuid : null,
                name: item.name ?? null,
                type: item.type ?? null,
                class: system.class ?? null,
                range: Number.isFinite(system.range) ? system.range
                    : (Number.isFinite(system.range?.value) ? system.range.value : null),
                ammo: Number.isFinite(clip) ? clip : null,
                // Weapon stats the action normalization reads back when a
                // replay rebuilds the actor items — without them the
                // `ev`/spray/blast factors evaluate to 0 on a replay.
                damage: typeof system.damage === "string" ? system.damage
                    : (Number.isFinite(system.damage) ? system.damage : null),
                blastRadius: Number.isFinite(blast) ? blast : null,
                special: typeof system.special === "string" ? system.special : null,
                rateOfFire: system.rateOfFire ?? null
            };
        })
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .slice(0, MAX_SNAPSHOT_ITEMS);
    return items;
}

/**
 * Sorted, deduplicated status ids collected from Foundry-style status
 * sources (Set/array/iterable of ids, or a `{id: truthy}` map). Mirrors
 * `statusIdsOf` in `perception.js`, kept local so the planner stays
 * self-contained for unit fixtures.
 * @param {...*} sources Status collections (`actor.statuses`,
 *   `token.statuses`, injected arrays).
 * @returns {string[]}
 */
function _statusIds(...sources) {
    const ids = new Set();
    for (const source of sources) {
        if (!source) continue;
        if (typeof source[Symbol.iterator] === "function") {
            for (const id of source) ids.add(String(id));
        } else if (typeof source === "object") {
            for (const key of Object.keys(source)) {
                if (source[key]) ids.add(String(key));
            }
        }
    }
    return [...ids].sort();
}

/**
 * Self status ids for the snapshot: `actor.statuses` merged with the
 * statuses carried by the token documents, plus the injected
 * `context.selfStatuses` array used by unit-test fixtures.
 * @param {object|null} actor Self actor document.
 * @param {object|null} tokenDoc Self token document.
 * @param {string[]|null} [injected] `context.selfStatuses` fixture array.
 * @returns {string[]} Sorted status ids.
 */
function _selfStatuses(actor, tokenDoc, injected = null) {
    return _statusIds(
        injected,
        actor?.statuses,
        tokenDoc?.statuses,
        tokenDoc?.actor?.statuses
    );
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

/**
 * Halve a movement budget for a prone (crawling) combatant: numeric
 * budgets are floored to half, `{mode}` budgets degrade to the `half`
 * movement mode, other shapes pass through untouched.
 * @param {*} budget Numeric, `{meters|cells|budget|limit|mode}` budget.
 * @returns {*}
 */
function _halveMoveBudget(budget) {
    if (Number.isFinite(budget)) return Math.floor(budget / 2);
    if (budget && typeof budget === "object") {
        const copy = { ...budget };
        for (const key of ["meters", "cells", "budget", "limit"]) {
            if (Number.isFinite(copy[key])) copy[key] = Math.floor(copy[key] / 2);
        }
        if (typeof copy.mode === "string") copy.mode = "half";
        return copy;
    }
    return budget;
}

/**
 * Expected damage of a damage spec: numbers pass through, dice strings
 * (`1d10+3`) evaluate deterministically to their mean.
 * @param {*} value
 * @returns {number}
 */
function _expectedDamage(value) {
    if (Number.isFinite(value)) return value;
    const formula = typeof value === "object" && value !== null ? value.formula : value;
    if (typeof formula !== "string") return 0;
    const trimmed = formula.trim();
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return numeric;
    const match = /^(\d*)d(\d+)\s*([+-]\s*\d+)?$/i.exec(trimmed);
    if (!match) return 0;
    const count = parseInt(match[1] || "1", 10);
    const faces = parseInt(match[2], 10);
    const bonus = match[3] ? parseInt(match[3].replace(/\s+/g, ""), 10) : 0;
    return ((count * (faces + 1)) / 2) + bonus;
}

/**
 * Attack range of an action spec in scene units; melee defaults to
 * {@link DEFAULT_MELEE_RANGE}.
 * @param {object} action Normalized action candidate.
 * @returns {number}
 */
function _actionRange(action) {
    const raw = action?.range;
    const value = Number.isFinite(raw) ? raw : _finiteOr(raw?.value, NaN);
    if (Number.isFinite(value) && value > 0) return value;
    return _isMeleeAction(action) ? DEFAULT_MELEE_RANGE : 0;
}

/**
 * Whether an action candidate is a melee attack.
 * @param {object|null} action Normalized action candidate.
 * @returns {boolean}
 */
function _isMeleeAction(action) {
    return action?.melee === true
        || _isChargeAction(action)
        || String(action?.class ?? "").toLowerCase() === "melee";
}

/**
 * Whether an action candidate is an explicit charge attack mode.
 * @param {object|null} action Normalized action candidate.
 * @returns {boolean}
 */
function _isChargeAction(action) {
    return action?.charge === true || String(action?.mode ?? "").toLowerCase() === "charge";
}

/**
 * Action-economy cost of an action candidate in half-action units
 * (issue #15): `"half"` → 1, `"full"` → 2, `"free"` → 0, numbers and
 * `{halves|actions}` objects pass through, default is one half action.
 * @param {object|null} action Normalized action candidate.
 * @returns {number}
 */
function _actionCost(action) {
    const cost = action?.cost;
    if (cost === "half") return 1;
    if (cost === "full") return 2;
    if (cost === "free") return 0;
    if (Number.isFinite(cost)) return cost;
    if (cost && typeof cost === "object") {
        if (Number.isFinite(cost.halves)) return cost.halves;
        if (Number.isFinite(cost.actions)) return cost.actions;
    }
    return 1;
}

/**
 * Blast radius of an action in scene units (metres); `0` for regular attacks.
 * @param {object|null} action Normalized action candidate.
 * @returns {number}
 */
function _actionBlastRadius(action) {
    return _finiteOr(action?.blastRadius, 0);
}

/**
 * Pixels per scene unit derived from the normalized grid info.
 * @param {object|null} grid Grid info `{size, distance}`.
 * @returns {number}
 */
function _pxPerUnit(grid) {
    const size = _finiteOr(grid?.size, 0);
    const distance = _finiteOr(grid?.distance, 0);
    return size > 0 && distance > 0 ? size / distance : 0;
}

/**
 * Euclidean distance between two pixel points.
 * @param {object|null} a `{x, y}`
 * @param {object|null} b `{x, y}`
 * @returns {number}
 */
function _distPx(a, b) {
    if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(b.x)) return Infinity;
    return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Token list evaluated for blast coverage. Injected `context.blastTokens`
 * (unit tests) wins; live runs scan the canvas placeables and flag the
 * combat-defeated tokens via the combat combatant index; the last resort
 * is the combat's own combatant tokens.
 * @param {object} context Planning context.
 * @param {object} combat Combat document.
 * @param {string|null} sceneId Scene id for token uuid derivation.
 * @returns {object[]} `{tokenUuid, x, y, disposition}` entries (pixels).
 */
function _blastTokens(context, combat, sceneId) {
    if (Array.isArray(context.blastTokens)) return context.blastTokens;
    const defeated = new Set();
    const index = new Map();
    for (const other of _list(combat?.combatants)) {
        const doc = _tokenDoc(other?.token);
        if (doc?.id) index.set(doc.id, other);
        if (other?.defeated === true && doc?.id) defeated.add(doc.id);
    }
    const placeables = _list(globalThis.canvas?.tokens?.placeables);
    const fromCanvas = placeables.map(token => {
        const doc = _tokenDoc(token);
        if (!doc || doc.destroyed === true || doc.hidden === true || !doc.actor) return null;
        const combatant = index.get(doc.id);
        if (combatant?.defeated === true) return null;
        const pos = _tokenPosition(doc);
        if (!pos) return null;
        return {
            tokenUuid: _tokenUuid(doc, sceneId) ?? doc.uuid ?? null,
            tokenId: doc.id ?? null,
            x: pos.x,
            y: pos.y,
            disposition: doc.disposition ?? combatant?.disposition ?? 0
        };
    }).filter(Boolean);
    if (fromCanvas.length) return fromCanvas;
    const fallback = [];
    for (const other of _list(combat?.combatants)) {
        const doc = _tokenDoc(other?.token);
        if (!doc || doc.destroyed === true || doc.hidden === true || other?.defeated === true) continue;
        const pos = _tokenPosition(doc);
        if (!pos) continue;
        fallback.push({
            tokenUuid: _tokenUuid(doc, sceneId) ?? doc.uuid ?? null,
            tokenId: doc.id ?? null,
            x: pos.x,
            y: pos.y,
            disposition: doc.disposition ?? other?.disposition ?? 0
        });
    }
    return fallback;
}

/**
 * Aim-point candidates around a blast target: the target centre plus
 * eight offsets at half the blast radius so the template can clip the
 * target instead of landing dead-centre.
 * @param {object} target Normalized target `{x, y}` (pixels).
 * @param {number} radiusPx Blast radius in pixels.
 * @returns {object[]}
 */
function _blastAimPoints(target, radiusPx) {
    const cx = target?.x ?? 0;
    const cy = target?.y ?? 0;
    const r = radiusPx / 2;
    const points = [{ x: cx, y: cy }];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (const [dx, dy] of dirs) {
        const scale = dx !== 0 && dy !== 0 ? r * Math.SQRT1_2 : r;
        points.push({ x: cx + (dx * scale), y: cy + (dy * scale) });
    }
    return points;
}

/**
 * Pick the blast aim point covering the most hostile tokens while keeping
 * friendlies — and neutrals unless `options.includeNeutral` — outside the
 * template. `presumedUuid` marks a last-known strike point whose
 * remembered token is not locatable and counts as one presumed hostile.
 * @param {object} input
 * @param {object} input.tokenDoc Viewer token document.
 * @param {object} input.origin Throw origin `{x, y}` (pixels).
 * @param {object} input.target Normalized target (pixels; last-known ok).
 * @param {number} input.rangePx Weapon range in pixels.
 * @param {number} input.radiusPx Blast radius in pixels.
 * @param {object[]} input.tokens Blast-coverage scan entries.
 * @param {number} input.viewerDisposition Self disposition.
 * @param {object} input.options `{includeNeutral, dispositions}`.
 * @param {object|null} input.perception Perception service (LOS probes).
 * @param {string|null} [input.presumedUuid] Remembered target uuid.
 * @param {boolean} [input.requireLos] LOS from origin to the aim point.
 * @returns {{point: object, hits: number}|null}
 */
function _bestBlastAim({
    tokenDoc, origin, target, rangePx, radiusPx, tokens,
    viewerDisposition, options, perception,
    presumedUuid = null, requireLos = true
}) {
    if (!origin || radiusPx <= 0) return null;
    const points = presumedUuid
        ? [{ x: target?.x ?? 0, y: target?.y ?? 0 }]
        : _blastAimPoints(target, radiusPx);
    let best = null;
    for (const point of points) {
        if (_distPx(origin, point) > rangePx + 1e-9) continue;
        if (requireLos && perception && typeof perception.hasLineOfSight === "function") {
            let los = true;
            try {
                los = perception.hasLineOfSight(tokenDoc, point) === true;
            } catch(err) {
                los = true;
            }
            if (!los) continue;
        }
        let hits = presumedUuid ? 1 : 0;
        let blocked = false;
        for (const token of tokens) {
            if (presumedUuid && token.tokenUuid === presumedUuid) continue;
            // Issue #54: the firing token itself is never a friendly-fire
            // veto — a template always covers its own origin.
            if ((token.tokenId ?? token.id) === tokenDoc?.id) continue;
            if (_distPx(point, token) > radiusPx + 1e-9) continue;
            const disp = Math.sign(_finiteOr(token.disposition, 0));
            if (_hostileTo(viewerDisposition, disp, options)) hits++;
            else blocked = true;
        }
        if (blocked || hits <= 0) continue;
        if (!best || hits > best.hits
            || (hits === best.hits
                && _distPx(point, { x: target?.x, y: target?.y })
                    < _distPx(best.point, { x: target?.x, y: target?.y }))) {
            best = { point, hits };
        }
    }
    return best;
}

/**
 * Shortest absolute difference between two bearings in degrees (0..180).
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function _angleDiffDeg(a, b) {
    return Math.abs(((((a - b) % 360) + 540) % 360) - 180);
}

/**
 * Short-arc midpoint between two bearings, normalized to [0, 360).
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function _bearingMidpoint(a, b) {
    const diff = ((((b - a) % 360) + 540) % 360) - 180;
    return (a + (diff / 2) + 360) % 360;
}

/**
 * Whether a token centre sits inside a directed cone: within `rangePx`
 * and no further than `angleDeg/2` off-axis.
 * @param {object} origin `{x, y}` pixels.
 * @param {number} directionDeg Cone axis direction (degrees).
 * @param {number} angleDeg Full cone angle (degrees).
 * @param {number} rangePx Cone length (pixels).
 * @param {object} token `{x, y}` pixels.
 * @returns {boolean}
 */
function _tokenInCone(origin, directionDeg, angleDeg, rangePx, token) {
    const dx = _finiteOr(token?.x, NaN) - _finiteOr(origin?.x, NaN);
    const dy = _finiteOr(token?.y, NaN) - _finiteOr(origin?.y, NaN);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    const dist = Math.hypot(dx, dy);
    if (dist > rangePx + 1e-9) return false;
    if (dist < 1e-9) return true;
    const bearing = ((Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360;
    return _angleDiffDeg(bearing, directionDeg) <= (angleDeg / 2) + 1e-9;
}

/**
 * Cone spec of a template action: `suppressing_fire` fires a 45°
 * suppression cone; spray weapons (`traits.spray` / a `template`
 * requirement) fire a 30° cone. Regular attacks return null.
 * @param {object} action Normalized action.
 * @returns {{angle: number, spray?: boolean, suppression?: boolean, burstMode?: string}|null}
 */
function _coneSpecOf(action) {
    if (!action) return null;
    if (action.attackType === "suppressing_fire") {
        const rof = action.rateOfFire ?? {};
        const burstMode = Number(rof.burst) > 0
            ? "semi_auto"
            : (Number(rof.full) > 0 ? "full_auto" : "semi_auto");
        return { angle: SUPPRESSION_CONE_DEG, suppression: true, burstMode };
    }
    if (action.spray === true || action.requirements?.includes("template")) {
        return { angle: SPRAY_CONE_DEG, spray: true };
    }
    return null;
}

/**
 * Pick the cone direction covering the most hostile tokens while keeping
 * friendlies — and neutrals unless `options.includeNeutral` — outside the
 * cone. Directions are searched over each hostile bearing plus the
 * short-arc midpoint of every hostile pair that fits inside one cone, so
 * clustered targets yield cluster-centred directions instead of a
 * single-token lock.
 * @param {object} input
 * @param {object} input.tokenDoc Viewer token document (LOS probes).
 * @param {object} input.origin Cone origin `{x, y}` (pixels).
 * @param {number} input.rangePx Cone length in pixels.
 * @param {number} input.angleDeg Full cone angle (degrees).
 * @param {object[]} input.tokens Coverage scan entries (blastTokens shape).
 * @param {object[]} [input.anchors] Perceived orientation anchors (issue
 *   #30): when provided, only these `{x, y, tokenUuid?, tokenId?}` points
 *   steer the cone — visible targets aim their live position, last-known
 *   contacts the remembered point; `tokens` still vetoes friendlies but
 *   hostiles the bot cannot perceive are ignored instead of counted.
 * @param {number} input.viewerDisposition Self disposition.
 * @param {object} input.options `{includeNeutral, dispositions}`.
 * @param {object|null} input.perception Perception service (LOS probes).
 * @param {boolean} [input.requireLos] Require LOS to ≥1 covered hostile.
 * @returns {{direction: number, hits: number, covered: object[]}|null}
 */
function _bestConeAim({
    tokenDoc, origin, rangePx, angleDeg, tokens,
    anchors = null, viewerDisposition, options, perception, requireLos = true
}) {
    if (!origin || rangePx <= 0 || !(angleDeg > 0)) return null;
    const hostiles = (tokens ?? []).filter(token =>
        _hostileTo(viewerDisposition, Math.sign(_finiteOr(token.disposition, 0)), options));
    // Issue #30: without an explicit anchor list the hostile coverage
    // scan steers the cone (legacy behaviour); with one, only perceived
    // anchors do — a hostile the bot cannot see never aims the template.
    const anchorList = Array.isArray(anchors)
        ? anchors.filter(anchor => Number.isFinite(anchor?.x) && Number.isFinite(anchor?.y))
        : hostiles;
    if (!anchorList.length) return null;
    const bearings = anchorList.map(anchor =>
        ((Math.atan2(anchor.y - origin.y, anchor.x - origin.x) * 180 / Math.PI) + 360) % 360);
    const directions = new Set(bearings);
    for (let i = 0; i < bearings.length; i++) {
        for (let j = i + 1; j < bearings.length; j++) {
            if (_angleDiffDeg(bearings[i], bearings[j]) <= angleDeg - 1e-9) {
                directions.add(_bearingMidpoint(bearings[i], bearings[j]));
            }
        }
    }
    let best = null;
    for (const direction of directions) {
        let hits = 0;
        let blocked = false;
        const covered = [];
        for (const anchor of anchorList) {
            if (!_tokenInCone(origin, direction, angleDeg, rangePx, anchor)) continue;
            hits++;
            covered.push({
                tokenUuid: anchor.tokenUuid ?? null,
                tokenId: anchor.tokenId ?? anchor.id ?? null,
                x: anchor.x,
                y: anchor.y,
                elevation: anchor.elevation ?? null
            });
        }
        if (hits <= 0) continue;
        // Friendly/neutral veto still scans every scene token: the bot
        // must not blanket allies just because it aimed by perception.
        for (const token of tokens) {
            // Issue #54: the firing token itself always sits at the cone
            // origin — it is not a friendly-fire veto.
            if ((token.tokenId ?? token.id) === tokenDoc?.id) continue;
            if (!_tokenInCone(origin, direction, angleDeg, rangePx, token)) continue;
            const disp = Math.sign(_finiteOr(token.disposition, 0));
            if (!_hostileTo(viewerDisposition, disp, options)) {
                blocked = true;
                break;
            }
        }
        if (blocked) continue;
        if (requireLos && perception && typeof perception.hasLineOfSight === "function") {
            let anyLos = false;
            for (const entry of covered) {
                let los = true;
                try {
                    los = perception.hasLineOfSight(tokenDoc, { x: entry.x, y: entry.y }) === true;
                } catch(err) {
                    los = true;
                }
                if (los) {
                    anyLos = true;
                    break;
                }
            }
            if (!anyLos) continue;
        }
        if (!best || hits > best.hits
            || (hits === best.hits && direction < best.direction)) {
            best = { direction, hits, covered };
        }
    }
    if (best) best.covered.sort((a, b) => String(a.tokenUuid).localeCompare(String(b.tokenUuid)));
    return best;
}

/**
 * Factor-facing target entry of a cone candidate: the covered token that
 * maps to a normalized target wins (real target data), otherwise the
 * first covered token is synthesized into a minimal visible-target
 * record so factors like `proximity`/`vulnerable` stay meaningful.
 * @param {object|null} aim `_bestConeAim` result.
 * @param {object[]} targets Normalized targets.
 * @param {object} selfPos Self position `{x, y}` (pixels).
 * @param {object} grid `_gridInfo` result.
 * @returns {object|null}
 */
function _coneTargetOf(aim, targets, selfPos, grid) {
    for (const covered of aim?.covered ?? []) {
        const match = targets.find(target => target.tokenUuid === covered.tokenUuid);
        if (match) return match;
    }
    const first = aim?.covered?.[0] ?? null;
    if (!first) return null;
    return {
        tokenUuid: first.tokenUuid,
        tokenId: first.tokenId,
        x: first.x,
        y: first.y,
        elevation: first.elevation,
        distance: _pixelDistance(selfPos, first, grid),
        canAttack: true,
        source: "visible",
        statuses: [],
        threat: 0
    };
}

/**
 * Deterministic turn revision: delegates to the authority service's
 * `operations.computeRevision` (#400) when it is available so plan and
 * operation revisions agree, and falls back to an equivalent local
 * FNV-1a fingerprint otherwise.
 * @param {object} combat
 * @param {object} combatant
 * @param {object|null} authority Authority service or null.
 * @returns {string}
 */
function _turnRevision(combat, combatant, authority) {
    const compute = authority?.operations?.computeRevision;
    if (typeof compute === "function") {
        try {
            const revision = compute(combat, combatant);
            if (typeof revision === "string" && revision) return revision;
        } catch(err) {
            // Fall through to the local fingerprint below.
        }
    }
    const tokenDoc = _tokenDoc(combatant?.token);
    const fingerprint = {
        combatId: combat?.id ?? null,
        combatantId: combatant?.id ?? null,
        round: combat?.round ?? null,
        turn: combat?.turn ?? null,
        tokenId: combatant?.tokenId ?? tokenDoc?.id ?? null,
        x: tokenDoc?._source?.x ?? tokenDoc?.x ?? null,
        y: tokenDoc?._source?.y ?? tokenDoc?.y ?? null,
        elevation: tokenDoc?.elevation ?? null,
        hidden: tokenDoc?.hidden === true,
        defeated: combatant?.defeated === true,
        initiative: combatant?.initiative ?? null
    };
    return `r${fnv1a(stableStringify(fingerprint))}`;
}

/**
 * Fingerprint of exactly the fields the stale checks inspect. Compared
 * first in `validateSnapshot` вЂ” equal fingerprints mean the plan is still
 * valid without running the detailed checks.
 * @param {object} input Fingerprint input.
 * @param {object|null} input.combat Live combat document.
 * @param {object|null} input.combatant Live combatant document.
 * @param {object|null} input.token Live self token document.
 * @param {object|null} input.actor Live self actor document.
 * @param {object|null} input.targetToken Live target token document.
 * @param {string|null} input.collision Live collision revision.
 * @param {string[]|null} [input.selfStatuses] Injected fixture statuses
 *   (`context.selfStatuses`) that must merge into the live computation.
 * @param {object} input.snapshot Stored plan snapshot.
 * @returns {string}
 */
function _staleFingerprint(input) {
    const { combat, combatant, token, actor, targetToken, collision,
        selfStatuses, snapshot } = input;
    const position = _tokenPosition(token);
    const targetPosition = _tokenPosition(targetToken);
    const targetCombatant = _findCombatantByToken(combat, snapshot?.target?.tokenId ?? null);
    return fnv1a(stableStringify({
        round: combat?.round ?? null,
        turn: combat?.turn ?? null,
        self: [
            token?.id ?? null,
            position.x,
            position.y,
            token?.elevation ?? null,
            token?.hidden === true,
            combatant?.defeated === true,
            _selfStatuses(actor, token, selfStatuses)
        ],
        target: snapshot?.target
            ? (targetToken
                ? [snapshot.target.tokenId ?? targetToken.id ?? null,
                    targetPosition.x,
                    targetPosition.y,
                    targetToken?.elevation ?? null,
                    _targetAlive(targetToken, targetCombatant)]
                : "missing")
            : null,
        resources: _resourcesFingerprint(actor),
        collision: collision ?? null
    }));
}

/**
 * Whether a target token still exists and can be attacked: alive actor,
 * not defeated in combat, not hidden.
 * @param {object|null} targetToken
 * @param {object|null} combatant Combatant for the target token, if any.
 * @returns {boolean}
 */
function _targetAlive(targetToken, combatant) {
    const doc = _tokenDoc(targetToken);
    if (!doc || doc.destroyed === true) return false;
    if (doc.hidden === true) return false;
    if (combatant?.defeated === true || combatant?.destroyed === true) return false;
    const actor = doc.actor ?? combatant?.actor;
    if (!actor || actor.destroyed === true) return false;
    return true;
}

/**
 * Find a combatant of the combat by its own id.
 * @param {object} combat
 * @param {string|null} combatantId
 * @returns {object|null}
 */
function _findCombatant(combat, combatantId) {
    if (!combatantId) return null;
    const collection = combat?.combatants;
    if (collection && typeof collection.get === "function") {
        const hit = collection.get(combatantId);
        if (hit) return hit;
    }
    for (const entry of _list(collection)) {
        if (entry?.id === combatantId) return entry;
    }
    return null;
}

/**
 * Find a combatant of the combat by its token id.
 * @param {object} combat
 * @param {string|null} tokenId
 * @returns {object|null}
 */
function _findCombatantByToken(combat, tokenId) {
    if (!tokenId) return null;
    for (const entry of _list(combat?.combatants)) {
        const doc = _tokenDoc(entry?.token);
        if ((entry?.tokenId ?? doc?.id) === tokenId) return entry;
    }
    return null;
}

/**
 * Find a token document by id: combat combatants first, then the scene
 * token collection.
 * @param {string|null} tokenId
 * @param {object} input Lookup context.
 * @param {object|null} [input.combat] Combat providing combatant tokens.
 * @param {object|null} [input.scene] Scene providing the token collection.
 * @returns {object|null}
 */
function _findToken(tokenId, { combat = null, scene = null } = {}) {
    if (!tokenId) return null;
    const combatant = _findCombatantByToken(combat, tokenId);
    if (combatant?.token) return _tokenDoc(combatant.token);
    const collection = scene?.tokens ?? globalThis.canvas?.tokens;
    if (collection && typeof collection.get === "function") {
        const hit = collection.get(tokenId);
        if (hit) return _tokenDoc(hit);
    }
    for (const entry of _list(collection)) {
        const doc = _tokenDoc(entry);
        if (doc?.id === tokenId) return doc;
    }
    return null;
}

/**
 * Whether two dispositions are hostile to each other (hostile в†” friendly).
 * Neutral tokens fight no one unless `options.includeNeutral` allows
 * targeting them; `options.dispositions` overrides the rule entirely.
 * @param {*} a
 * @param {*} b
 * @param {object} [options]
 * @param {boolean} [options.includeNeutral] Accept neutral targets.
 * @param {number[]|null} [options.dispositions] Explicit disposition allow-list.
 * @returns {boolean}
 */
function _hostileTo(a, b, { includeNeutral = false, dispositions = null } = {}) {
    const sa = Math.sign(_finiteOr(a, 0));
    const sb = Math.sign(_finiteOr(b, 0));
    if (Array.isArray(dispositions)) return dispositions.includes(sb);
    if (sb === 0) return includeNeutral === true && sa !== 0;
    return sa !== 0 && sa !== sb;
}

/**
 * Whether a token is "on the viewer's side" for shooting-into-melee
 * purposes (issue #39): same non-zero disposition, or a neutral token —
 * but only when `includeNeutral` marks neutrals as tracked at all. An
 * explicit `dispositions` allow-list treats everything outside the
 * hostile list as a friendly the bot should not risk hitting.
 * @param {*} viewer Viewer disposition.
 * @param {*} disp Candidate token disposition.
 * @param {object} [options] Same options as {@link _hostileTo}.
 * @param {boolean} [options.includeNeutral] Track neutral tokens as allies.
 * @param {number[]|null} [options.dispositions] Explicit hostile allow-list.
 * @returns {boolean}
 */
function _isAllyDisposition(viewer, disp, { includeNeutral = false, dispositions = null } = {}) {
    const sa = Math.sign(_finiteOr(viewer, 0));
    const sb = Math.sign(_finiteOr(disp, 0));
    if (sb === 0) return includeNeutral === true;
    if (Array.isArray(dispositions)) return !dispositions.includes(sb);
    return sa !== 0 && sb === sa;
}

/**
 * Set of hostile token uuids currently engaged in melee with an ally
 * (issue #39): every token hostile to the viewer that stands within
 * `reachPx` of a same-side token. The viewer token itself and the
 * evaluated token never count as their own ally. Only the uuid set is
 * built — the candidate factor then checks membership per target.
 * @param {object} input
 * @param {object[]} input.tokens Scene token scan (`_blastTokens` shape).
 * @param {number} input.viewerDisposition Viewer disposition.
 * @param {string|null} input.selfTokenUuid Viewer token uuid — excluded.
 * @param {number} input.reachPx Melee reach in pixels (fallback).
 * @param {Function} [input.resolveReachPx] `(target, ally) => px|null` —
 *   per-pair melee reach (issue #39 review: long-reach weapons reach a
 *   cell further than `DEFAULT_MELEE_RANGE`); `null` uses `reachPx`.
 * @param {object} input.options `{includeNeutral, dispositions}`.
 * @returns {Map<string, number>} Hostile uuid → count of allies in melee
 *   reach of it. `.has()` keeps the Set semantics callers already use;
 *   the count feeds the `outnumber` factor (ganging up, OW +10/+20).
 */
function _allyEngagedTargets({ tokens, viewerDisposition, selfTokenUuid, reachPx,
    resolveReachPx = null, options }) {
    const engaged = new Map();
    for (const target of tokens ?? []) {
        if (!target || target.tokenUuid == null) continue;
        const disp = Math.sign(_finiteOr(target.disposition, 0));
        if (!_hostileTo(viewerDisposition, disp, options)) continue;
        for (const token of tokens) {
            if (!token || token === target) continue;
            if (selfTokenUuid != null && token.tokenUuid === selfTokenUuid) continue;
            if (token.tokenUuid != null && token.tokenUuid === target.tokenUuid) continue;
            if (!_isAllyDisposition(viewerDisposition, token.disposition, options)) continue;
            const pairReach = typeof resolveReachPx === "function"
                ? resolveReachPx(target, token) : null;
            const limit = Number.isFinite(pairReach) && pairReach > 0 ? pairReach : reachPx;
            if (_distPx(target, token) <= limit + 1e-9) {
                engaged.set(target.tokenUuid, (engaged.get(target.tokenUuid) ?? 0) + 1);
            }
        }
    }
    return engaged;
}

/**
 * Enemy contact entries for the disengage/engage-denial factors (issue
 * #39): every perceived enemy position plus the melee reach it
 * threatens. The reach comes from the target's threat emitters — the
 * longest melee emitter range — with a {@link DEFAULT_MELEE_RANGE}
 * fallback (any combatant can swing unarmed). Pure: only snapshot data
 * is read, so the factors stay deterministic functions of the plan
 * inputs (issue #24).
 * @param {object[]} targets Normalized planner targets (pixels).
 * @param {object[]} threats Resolved threat sources with `emitters`.
 * @param {number} pxPerUnit Pixels per scene unit (`_pxPerUnit`).
 * @returns {object[]} `{x, y, reachPx, tokenUuid}` entries.
 */
function _enemyContacts(targets, threats, pxPerUnit) {
    const emittersOf = new Map();
    for (const source of threats ?? []) {
        const key = source?.tokenUuid ?? source?.id ?? null;
        if (key != null) emittersOf.set(key, source.emitters ?? []);
    }
    const scale = pxPerUnit > 0 ? pxPerUnit : 1;
    const contacts = [];
    for (const target of targets ?? []) {
        if (!Number.isFinite(target?.x) || !Number.isFinite(target?.y)) continue;
        const emitters = emittersOf.get(target.tokenUuid) ?? target.emitters ?? [];
        const meleeRanges = emitters
            .filter(emitter => emitter && emitter.melee === true)
            .map(emitter => _finiteOr(emitter.range, DEFAULT_MELEE_RANGE))
            .filter(range => range > 0);
        // A target that carries a melee reach itself (injected profile)
        // uses it when no emitter list survives.
        if (!meleeRanges.length && target.melee === true
            && Number.isFinite(target.range) && target.range > 0) {
            meleeRanges.push(target.range);
        }
        const reach = meleeRanges.length
            ? Math.max(...meleeRanges)
            : DEFAULT_MELEE_RANGE;
        contacts.push({ x: target.x, y: target.y, reachPx: reach * scale,
            tokenUuid: target.tokenUuid ?? null });
    }
    return contacts;
}

/**
 * Melee reach of a token's actor in pixels (issue #39 review): the
 * longest `range`/`reach` of its melee-class weapon items — a spear
 * armed ally engages a cell further than the unarmed default. `null`
 * when the token or its loadout cannot be resolved (the caller falls
 * back to {@link DEFAULT_MELEE_RANGE}).
 * @param {string|null} tokenId Token id to resolve.
 * @param {object} input Lookup context.
 * @param {object|null} [input.combat] Combat searched first.
 * @param {object|null} [input.scene] Scene for the token collection.
 * @param {number} [input.pxPerUnit] Pixels per scene unit.
 * @returns {number|null}
 */
function _tokenMeleeReachPx(tokenId, { combat = null, scene = null, pxPerUnit = 1 } = {}) {
    const doc = _findToken(tokenId, { combat, scene });
    const actor = _actorOf(doc);
    const scale = pxPerUnit > 0 ? pxPerUnit : 1;
    const ranges = _list(actor?.items)
        .filter(item => item?.type === "weapon"
            && String(item.system?.class ?? "").toLowerCase() === "melee")
        .map(item => _finiteOr(item.system?.range ?? item.system?.reach, 0))
        .filter(range => range > 0);
    return ranges.length ? Math.max(...ranges) * scale : null;
}

/**
 * Synthesized `unpin` action entry (issue #39): the DH2e full-action
 * Willpower test that clears pinning. The candidate only exists when the
 * actor actually has a `willpower` characteristic — `null` otherwise, so
 * the planner can record a `unpin-unavailable` rejection instead.
 * @param {object|null} actor Actor document.
 * @returns {object|null}
 */
function _unpinAction(actor) {
    const characteristics = actor?.system?.characteristics ?? actor?.characteristics ?? null;
    if (!characteristics || characteristics.willpower == null) return null;
    return {
        id: "unpin",
        type: "test",
        name: "Unpin",
        characteristic: "willpower",
        testKind: "characteristic",
        cost: "full",
        synthesized: true
    };
}

/**
 * Synthesized order action entry (issue #38): a fireteam leader's Command
 * skill test that delivers the order named by the team-supplied
 * `orderCandidate` record `{orderId, name, orderType, benefit, skill?,
 * advanced?}`. The candidate only exists when the actor actually carries
 * the `command` skill — `null` otherwise, so the planner can record an
 * `order-unavailable` rejection instead. Orders cost a half action; an
 * `advanced` order (veteran-tier) is a full action.
 * @param {object|null} actor Actor document.
 * @param {object|null} candidate `context.team.orderCandidate`.
 * @returns {object|null}
 */
function _orderAction(actor, candidate) {
    if (!candidate || typeof candidate !== "object") return null;
    const skills = actor?.system?.skills ?? actor?.skills ?? null;
    if (!skills || skills.command == null) return null;
    const orderId = candidate.orderId ?? candidate.id ?? null;
    if (orderId == null) return null;
    return {
        id: `order-${orderId}`,
        type: "test",
        name: candidate.name ?? `Order ${orderId}`,
        kind: "skill",
        skill: candidate.skill ?? "command",
        skillKey: candidate.skill ?? "command",
        testKind: "skill",
        key: candidate.skill ?? "command",
        characteristic: candidate.characteristic ?? null,
        orderId,
        orderType: candidate.orderType ?? null,
        benefit: candidate.benefit ?? null,
        flags: { isOrder: true },
        cost: candidate.advanced === true ? "full" : "half",
        synthesized: true
    };
}

/**
 * Morale state of a combatant for issue #38 gating/boosts (graceful
 * #26 integration): reads `context.morale` first (tests/integrations),
 * then the optional module flag `flags["only-war-ai"].morale`
 * `{state, pressured?, desperate?}`. No flag or unrecognized payload —
 * normal state, the caller keeps planning as usual.
 * @param {object|null} combatant Combatant document.
 * @param {object} [context] Planning context.
 * @returns {{pressured: boolean, desperate: boolean}}
 */
function _moraleOf(combatant, context = {}) {
    const injected = context.morale;
    const record = injected !== undefined ? injected
        : (combatant?.getFlag?.(MODULE_ID, FLAG_KEYS.morale)
            ?? combatant?.flags?.[MODULE_ID]?.[FLAG_KEYS.morale]);
    return moralePostureOf(record);
}

/**
 * The `lastAttacker` record usable for scoring this turn (issue #39):
 * the flag value filtered by the round-expiry of {@link grudgeActive}
 * and by attacker liveness — a matching defeated combatant or destroyed
 * token proves the attacker dead, which mutes the grudge. An attacker
 * missing from the combat cannot disprove the record and keeps it.
 * @param {object|null} record Raw `lastAttacker` flag/context value.
 * @param {object|null} combat Live combat document.
 * @returns {object|null}
 */
function _activeGrudge(record, combat) {
    if (!record || typeof record !== "object") return null;
    if (!grudgeActive(record, Number.isFinite(combat?.round) ? combat.round : null)) {
        return null;
    }
    let attacker = record.tokenId != null
        ? _findCombatantByToken(combat, record.tokenId)
        : null;
    if (!attacker && record.actorId != null) {
        attacker = _list(combat?.combatants).find(other => {
            const actor = _actorOf(other) ?? _actorOf(_tokenDoc(other?.token));
            return actor?.id === record.actorId || other?.actorId === record.actorId;
        }) ?? null;
    }
    if (attacker) {
        const doc = _tokenDoc(attacker.token);
        if (attacker.defeated === true || attacker.destroyed === true
            || doc?.destroyed === true) {
            return null;
        }
    }
    return record;
}

/**
 * Build the immutable `PlanningSnapshot` for an AI combatant. Plain,
 * JSON-serializable data only вЂ” never Document references.
 * @param {object} input Builder input.
 * @param {object|null} [input.combat] Combat document.
 * @param {object|null} [input.combatant] Active combatant document.
 * @param {object} [input.context] Planning context overrides.
 * @param {object|null} [input.authority] Authority service or null.
 * @returns {object} Frozen snapshot (targets/actions filled by the caller
 *   before `revision`/`staleFingerprint` are finalized).
 */
export function buildPlanSnapshot({ combat = null, combatant = null, context = {}, authority = null } = {}) {
    const tokenDoc = _tokenDoc(context.token ?? combatant?.token);
    const actor = _actorOf(combatant) ?? _actorOf(tokenDoc);
    const scene = _sceneOf(context, combat);
    const sceneId = scene?.id ?? null;
    const position = _tokenPosition(tokenDoc);
    const grid = _gridInfo(scene);
    const collision = context.collisionRevision !== undefined
        ? context.collisionRevision
        : _collisionRevision(scene);
    return _deepFreeze({
        combatId: combat?.id ?? null,
        combatantId: combatant?.id ?? null,
        round: _finiteOr(combat?.round, 0),
        turn: _finiteOr(combat?.turn, 0),
        scene: {
            id: sceneId,
            grid,
            collisionRevision: collision
        },
        self: {
            tokenId: combatant?.tokenId ?? tokenDoc?.id ?? null,
            tokenUuid: _tokenUuid(tokenDoc, sceneId),
            actorId: actor?.id ?? null,
            actorUuid: _actorUuid(actor),
            x: position.x,
            y: position.y,
            elevation: _finiteOr(tokenDoc?.elevation, 0),
            hidden: tokenDoc?.hidden === true,
            defeated: combatant?.defeated === true,
            initiative: combatant?.initiative ?? null,
            disposition: _finiteOr(tokenDoc?.disposition ?? combatant?.disposition, 0),
            statuses: _selfStatuses(actor, tokenDoc, context?.selfStatuses),
            resources: _resourcesOf(actor),
            resourcesHash: _resourcesFingerprint(actor),
            items: _itemSummaries(actor)
        },
        targets: [],
        actions: [],
        target: null,
        turnRevision: _turnRevision(combat, combatant, authority),
        staleFingerprint: null,
        revision: null
    });
}

/**
 * Distance between a token-like point and the viewer in scene units.
 * @param {{x: number|null, y: number|null}} from Self position (pixels).
 * @param {{x: number|null, y: number|null}} to Target position (pixels).
 * @param {object} grid `_gridInfo` result.
 * @returns {number|null}
 */
function _pixelDistance(from, to, grid) {
    if (!Number.isFinite(from?.x) || !Number.isFinite(to?.x)
        || !Number.isFinite(from?.y) || !Number.isFinite(to?.y)) return null;
    const size = Number.isFinite(grid?.size) && grid.size > 0 ? grid.size : 100;
    const unit = Number.isFinite(grid?.distance) && grid.distance > 0 ? grid.distance : 1;
    return Math.hypot(from.x - to.x, from.y - to.y) / size * unit;
}

/**
/**
 * Whether a target provenance is a memory record (issue #38): the bot's
 * own `last-known` entry or a shared `team-contact` sighting. Memory
 * targets are never directly attackable but may steer approach moves,
 * cones and blast memory-strikes.
 * @param {string|null} source
 * @returns {boolean}
 */
function _isMemorySource(source) {
    return source === "last-known" || source === "team-contact" || source === "relay";
}

/**
 * Normalize a raw target record (perception entry, combatant fallback or
 * injected fixture) to the snapshot target shape.
 * @param {object} raw
 * @param {object} input Normalization context.
 * @param {string} input.source Target provenance label.
 * @param {string|null} input.sceneId Owning scene id for UUID fallback.
 * @param {object} input.selfPos Self position `{x, y}` in pixels.
 * @param {object} input.grid Normalized grid info.
 * @param {Function} input.measure Distance probe `(raw) => number|null`.
 * @returns {object|null}
 */
function _normalizeTarget(raw, { source, sceneId, selfPos, grid, measure }) {
    if (!raw || typeof raw !== "object") return null;
    const tokenId = raw.tokenId ?? (typeof raw.tokenUuid === "string"
        ? raw.tokenUuid.split(".").pop()
        : null);
    const tokenUuid = typeof raw.tokenUuid === "string" && raw.tokenUuid
        ? raw.tokenUuid
        : (tokenId ? `Scene.${sceneId ?? "scene"}.Token.${tokenId}` : null);
    if (!tokenUuid && !tokenId) return null;
    const x = _finiteOr(raw.x, null);
    const y = _finiteOr(raw.y, null);
    let distance = Number.isFinite(raw.distance) ? raw.distance : null;
    if (distance === null && typeof measure === "function") {
        try {
            distance = measure(raw) ?? null;
        } catch(err) {
            distance = null;
        }
    }
    if (distance === null) {
        distance = _pixelDistance(selfPos, { x, y }, grid);
    }
    return {
        tokenId,
        tokenUuid,
        // Issue #39: the target's actor id feeds the `grudge` factor —
        // the `lastAttacker` flag identifies the attacker by actor too.
        actorId: raw.actorId ?? null,
        x,
        y,
        elevation: _finiteOr(raw.elevation, 0),
        distance,
        threat: _finiteOr(raw.threat, 0),
        canAttack: _isMemorySource(source) ? false : raw.canAttack !== false,
        hidden: raw.hidden === true,
        statuses: _statusIds(raw.statuses),
        source,
        // Issue #38: memory entries carry their sighting timestamps so a
        // fresher shared contact may replace a stale own record inside
        // `_resolveTargets`; `sourceCombatantId` names the teammate that
        // shared the contact (null for own sightings).
        lastSeenRound: _isMemorySource(source)
            ? _finiteOr(raw.lastSeenRound, null) : null,
        lastSeenTurn: _isMemorySource(source)
            ? _finiteOr(raw.lastSeenTurn, null) : null,
        sourceCombatantId: _isMemorySource(source)
            ? (raw.sourceCombatantId ?? null) : null,
        // Issue #16 threat-profile passthrough: explicit weapon emitters
        // (`emitters`/`damage`+`range`/`melee`/`threatProfile`) feeding
        // the danger field and the lookahead counter model.
        threatProfile: raw.threatProfile ?? null,
        emitters: Array.isArray(raw.emitters) ? raw.emitters : null,
        damage: raw.damage ?? null,
        range: Number.isFinite(raw.range) ? raw.range : null,
        melee: raw.melee === true,
        // Issue #37: dodge/reaction data feeding the counter-EV model —
        // `reactionUsed` marks a combatant that already spent its
        // reaction this round, `dodge`/`dodgeTN` is a rough dodge TN
        // (0..100), `halfMove` the target's half-move rate used to judge
        // whether a blast target can still escape the zone.
        reactionUsed: raw.reactionUsed === true,
        dodge: _finiteOr(raw.dodgeTN ?? raw.dodge, null),
        halfMove: _finiteOr(raw.halfMove, null)
    };
}

/**
 * Fallback target list when no perception service is registered: hostile,
 * living, visible-enough combatants of the same combat.
 * @param {object} combat
 * @param {object} combatant
 * @param {object} input Normalization context.
 * @param {string|null} input.sceneId Owning scene id.
 * @param {object} input.selfPos Self position `{x, y}` in pixels.
 * @param {object} input.grid Normalized grid info.
 * @param {Function} input.measure Distance probe `(raw) => number|null`.
 * @returns {object[]}
 */
function _fallbackTargets(combat, combatant, input) {
    const selfDoc = _tokenDoc(combatant?.token);
    const selfDisposition = _finiteOr(selfDoc?.disposition ?? combatant?.disposition, 0);
    const targets = [];
    for (const other of _list(combat?.combatants)) {
        if (!other || other === combatant) continue;
        const doc = _tokenDoc(other.token);
        const id = other.tokenId ?? doc?.id;
        if (!doc || !id || id === selfDoc?.id) continue;
        if (doc.destroyed === true || doc.hidden === true) continue;
        if (other.defeated === true) continue;
        if (!_actorOf(other) && !_actorOf(doc)) continue;
        if (!_hostileTo(selfDisposition, doc.disposition, input.options ?? {})) continue;
        // The fallback scans combatants directly, so it must apply the
        // same LOS gate the perception snapshot used — otherwise a
        // wall-blind NPC still fires at a hostile it cannot see.
        const losProbe = input.perception?.hasLineOfSight;
        if (selfDoc && typeof losProbe === "function") {
            try {
                if (losProbe.call(input.perception, selfDoc, doc) !== true) continue;
            } catch(err) {
                // An undetermined probe keeps the candidate — a broken
                // LOS check is safer than a blind veto.
            }
        }
        const position = _tokenPosition(doc);
        const target = _normalizeTarget({
            tokenId: id,
            tokenUuid: _tokenUuid(doc, input.sceneId),
            x: position.x,
            y: position.y,
            elevation: doc.elevation,
            canAttack: true,
            hidden: false,
            statuses: _statusIds(doc.actor?.statuses, doc.statuses)
        }, { ...input, source: "fallback" });
        if (target) targets.push(target);
    }
    return targets;
}

/**
 * Resolve target candidates: injected `context.targets`, the perception
 * service snapshot, or the combatant fallback scan. Sorted by tokenUuid
 * for determinism and deduplicated.
 * @param {object} input Resolution context.
 * @param {object} input.combat Combat document.
 * @param {object} input.combatant Active combatant document.
 * @param {object|null} input.tokenDoc Viewer token document.
 * @param {object} input.selfPos Self position `{x, y}` in pixels.
 * @param {string|null} input.sceneId Owning scene id.
 * @param {object} input.grid Normalized grid info.
 * @param {object|null} input.perception Perception service or null.
 * @param {object} input.context Planning context overrides.
 * @param {boolean} [input.distrustsContacts] Ignore shared team contacts
 *   (issue #38 review: `distrustsContacts` trait flag or `rabble` squad
 *   character).
 * @returns {object[]}
 */
function _resolveTargets({ combat, combatant, tokenDoc, selfPos, sceneId, grid, perception, context,
    distrustsContacts = false }) {
    const measure = raw => {
        const doc = _tokenDoc(raw) ?? raw;
        if (typeof perception?.measureDistance === "function" && doc) {
            const dist = perception.measureDistance(tokenDoc, doc);
            if (Number.isFinite(dist)) return dist;
        }
        return null;
    };
    const input = {
        source: "fallback",
        sceneId,
        selfPos,
        grid,
        measure,
        perception,
        options: {
            includeNeutral: context.includeNeutral === true,
            dispositions: Array.isArray(context.dispositions) ? context.dispositions : null
        }
    };
    let targets = [];
    if (Array.isArray(context.targets)) {
        targets = context.targets
            .map(raw => _normalizeTarget(raw, { ...input, source: raw?.source ?? "injected" }))
            .filter(Boolean);
    } else if (perception && typeof perception.buildPerceptionSnapshot === "function") {
        let snapshot = null;
        try {
            snapshot = perception.buildPerceptionSnapshot({
                combat,
                combatant,
                token: tokenDoc,
                includeNeutral: context.includeNeutral === true,
                dispositions: Array.isArray(context.dispositions) ? context.dispositions : null
            });
        } catch(err) {
            snapshot = null;
        }
        if (snapshot && snapshot.status !== "perception-unavailable") {
            const visible = (snapshot.visibleTargets ?? [])
                .map(raw => _normalizeTarget(raw, { ...input, source: "visible" }));
            const remembered = (snapshot.lastKnownTargets ?? [])
                .map(raw => _normalizeTarget(raw, {
                    ...input,
                    // Issue #38: the snapshot marks shared squad contacts
                    // `team-contact`; everything else stays a last-known.
                    source: raw?.source ?? "last-known"
                }));
            targets = visible.concat(remembered).filter(Boolean);
        }
    }
    if (!targets.length && !Array.isArray(context.targets)) {
        targets = _fallbackTargets(combat, combatant, input);
    }
    // Issue #38 shared squad contacts: teammates' merged memory joins the
    // target list marked `team-contact`. Live/injected records always win;
    // between two memory records the fresher sighting wins, and an equal
    // timestamp keeps the existing (own) entry.
    for (const raw of _teamContactRaws({ combat, combatant, perception, context, distrustsContacts })
        .concat(_netContactRaws({ combat, combatant, perception, context, distrustsContacts }))) {
        const shared = _normalizeTarget(raw, {
            ...input,
            source: raw?.relay === true || raw?.source === "relay"
                ? "relay"
                : (raw?.sourceCombatantId != null || raw?.source === "team-contact"
                    ? "team-contact"
                    : "last-known")
        });
        if (!shared) continue;
        const key = shared.tokenUuid ?? shared.tokenId;
        const index = targets.findIndex(target =>
            (target.tokenUuid ?? target.tokenId) === key);
        if (index < 0) {
            targets.push(shared);
            continue;
        }
        const existing = targets[index];
        if (!_isMemorySource(existing.source) || !_isMemorySource(shared.source)) {
            continue;
        }
        const sharedTs = (_finiteOr(shared.lastSeenRound, 0) * 1e6)
            + _finiteOr(shared.lastSeenTurn, 0);
        const existingTs = (_finiteOr(existing.lastSeenRound, 0) * 1e6)
            + _finiteOr(existing.lastSeenTurn, 0);
        if (sharedTs > existingTs) targets[index] = shared;
    }
    // Issue #37: read the `reactionUsed` flag off each target's own
    // combatant — a spent-reaction enemy cannot dodge, which raises the
    // attack EV against it ("finish the dodged target"). Injected
    // `reactionUsed` entries win; the flag only fills blanks.
    const round = Number.isFinite(combat?.round) ? combat.round : null;
    for (const target of targets) {
        if (target.reactionUsed === true) continue;
        const other = _findCombatantByToken(combat, target.tokenId);
        const record = other?.getFlag?.(MODULE_ID, FLAG_KEYS.reactionUsed)
            ?? other?.flags?.[MODULE_ID]?.[FLAG_KEYS.reactionUsed];
        if (reactionUsed(record, round)) target.reactionUsed = true;
    }
    const seen = new Set();
    return targets
        .filter(target => {
            const key = target.tokenUuid ?? target.tokenId;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .sort((a, b) => String(a.tokenUuid ?? a.tokenId)
            .localeCompare(String(b.tokenUuid ?? b.tokenId)));
}

/**
 * Raw shared-contact records for `_resolveTargets` (issue #38). Injection
 * order: `context.teamContacts` (entry array), then `context.team.contacts`
 * — the merged map/entry list the fireteam service builds once per
 * TeamPlan — and finally the live `perception.teamLastKnownPositions`
 * lookup when the combatant carries a `team.teamId`. `shareContacts ===
 * false` on `context` or `context.team` disables the merge entirely.
 * @param {object} input
 * @param {object} input.combat Combat document.
 * @param {object} input.combatant Active combatant document.
 * @param {object|null} input.perception Perception service or null.
 * @param {object} input.context Planning context.
 * @param {boolean} [input.distrustsContacts] Personality gate (issue #38
 *   review): a `distrustsContacts` trait flag or a `rabble` squad
 *   character makes the bot ignore shared contacts entirely — its own
 *   memory still works.
 * @returns {object[]}
 */
function _teamContactRaws({ combat, combatant, perception, context,
    distrustsContacts = false }) {
    if (distrustsContacts === true) return [];
    if (context?.shareContacts === false || context?.team?.shareContacts === false) {
        return [];
    }
    if (Array.isArray(context?.teamContacts)) return context.teamContacts;
    const contacts = context?.team?.contacts;
    if (Array.isArray(contacts)) return contacts;
    if (contacts && typeof contacts === "object") {
        return Object.entries(contacts)
            .map(([tokenUuid, entry]) => ({ tokenUuid, ...entry }));
    }
    const teamId = context?.team?.teamId ?? _teamIdOf(combatant);
    if (teamId && typeof perception?.teamLastKnownPositions === "function") {
        try {
            const shared = perception.teamLastKnownPositions(combat, combatant, teamId);
            return Array.isArray(shared) ? shared : [];
        } catch(err) {
            return [];
        }
    }
    return [];
}

/**
 * Comms-net contacts (smoke finding): combatants sharing a `commsNet`
 * flag id exchange last-known contacts with a radio delay — distant
 * squads advance toward reported contacts instead of holding forever,
 * without the instant dogpile a zero-latency merge would produce.
 * `context.commsNet` injects the id in tests; `context.commsDelay`
 * overrides the default one-round lag; entries arrive `source: "relay"`.
 * @param {object} input
 * @param {object} input.combat Combat document.
 * @param {object} input.combatant Active combatant document.
 * @param {object|null} input.perception Perception service or null.
 * @param {object} input.context Planning context.
 * @param {boolean} [input.distrustsContacts] Same personality gate as
 *   `_teamContactRaws` — a distrusting bot believes no hearsay either.
 * @returns {object[]}
 */
function _netContactRaws({ combat, combatant, perception, context,
    distrustsContacts = false }) {
    if (distrustsContacts === true) return [];
    if (context?.shareContacts === false || context?.team?.shareContacts === false) {
        return [];
    }
    const netId = context?.commsNet ?? _commsNetOf(combatant);
    if (!netId || typeof perception?.netLastKnownPositions !== "function") return [];
    const delay = _finiteOr(context?.commsDelay, 1);
    try {
        const shared = perception.netLastKnownPositions(combat, combatant, netId, delay);
        return Array.isArray(shared) ? shared : [];
    } catch(err) {
        return [];
    }
}

/**
 * Resolved `commsNet` id of a combatant without a context injection:
 * combatant flag wins, then the linked token, then the actor — matching
 * `perception._commsNetOf` (duplicated to keep services cycle-free).
 * @param {object} combatant
 * @returns {string|null}
 */
function _commsNetOf(combatant) {
    const read = doc => {
        if (!doc) return null;
        try {
            if (typeof doc.getFlag === "function") {
                const flag = doc.getFlag(MODULE_ID, FLAG_KEYS.commsNet);
                if (typeof flag === "string" && flag) return flag;
                if (typeof flag?.netId === "string" && flag.netId) return flag.netId;
            }
        } catch(_err) {
            // Fall back to the raw flags object below.
        }
        const flag = doc?.flags?.[MODULE_ID]?.[FLAG_KEYS.commsNet];
        if (typeof flag === "string" && flag) return flag;
        return typeof flag?.netId === "string" && flag.netId ? flag.netId : null;
    };
    const tokenDoc = _tokenDoc(combatant?.token);
    return read(combatant)
        ?? read(tokenDoc)
        ?? read(combatant?.actor ?? tokenDoc?.actor)
        ?? null;
}

/**
 * Resolved fireteam `teamId` of a combatant without a TeamPlan context:
 * combatant flag wins, then the linked token, then the actor — the same
 * field-priority chain `resolveTeamConfig`/`perception._teamIdOf` apply
 * (duplicated here because planner ↔ fireteam would be an import cycle).
 * @param {object} combatant
 * @returns {string|null}
 */
function _teamIdOf(combatant) {
    const read = doc => {
        if (!doc) return null;
        try {
            if (typeof doc.getFlag === "function") {
                const flag = doc.getFlag(MODULE_ID, FLAG_KEYS.fireteam);
                if (typeof flag?.teamId === "string" && flag.teamId) {
                    return flag.teamId;
                }
            }
        } catch(_err) {
            // Fall back to the raw flags object below.
        }
        const flag = doc?.flags?.[MODULE_ID]?.[FLAG_KEYS.fireteam];
        return typeof flag?.teamId === "string" && flag.teamId
            ? flag.teamId : null;
    };
    const tokenDoc = _tokenDoc(combatant?.token);
    return read(combatant)
        ?? read(tokenDoc)
        ?? read(combatant?.actor ?? tokenDoc?.actor)
        ?? null;
}

/**
 * Normalize one raw action entry to the action-candidate shape.
 * @param {object} raw
 * @param {number} index Fallback id index.
 * @returns {object|null}
 */
function _normalizeAction(raw, index) {
    if (!raw || typeof raw !== "object") return null;
    if (raw.available === false) return null;
    const kind = raw.kind ?? raw.type ?? null;
    // Non-attack action kinds (aim/reload) are kept as auxiliary entries —
    // they never become attack candidates (issue #15).
    let type;
    if (kind === "aim" || raw.aim === true) type = "aim";
    else if (kind === "reload") type = "reload";
    // Issue #37 free actions: the system may emit explicit ready/draw
    // entries — their `cost` passes through unchanged (e.g. free under
    // Quick Draw) and lands in the step cost as-is.
    else if (kind === "ready-weapon" || kind === "ready" || kind === "draw"
        || kind === "equip" || raw.ready === true) type = "ready-weapon";
    else if (kind === "attack" || raw.attack === true || raw.itemUuid != null
        || raw.weapon != null || raw.weaponId != null || raw.attackType != null) {
        type = "attack";
    } else if (kind === "test" || kind === null || raw.test === true) type = "test";
    else return null;
    const id = typeof raw.id === "string" && raw.id ? raw.id : `action-${index}`;
    const cls = raw.class ?? raw.system?.class ?? null;
    const attackType = typeof raw.attackType === "string" ? raw.attackType : null;
    return {
        id,
        type,
        attackType,
        name: raw.name ?? raw.weaponName ?? id,
        itemUuid: raw.itemUuid ?? raw.weaponUuid ?? raw.item?.uuid ?? null,
        itemId: raw.itemId ?? raw.weaponId ?? raw.item?.id ?? null,
        class: cls,
        melee: raw.melee === true || String(cls ?? "").toLowerCase() === "melee",
        charge: raw.charge === true || attackType === "charge"
            || String(raw.mode ?? "").toLowerCase() === "charge",
        range: Number.isFinite(raw.range) ? raw.range
            : (Number.isFinite(raw.range?.value) ? raw.range.value
                : (Number.isFinite(raw.system?.range) ? raw.system.range : null)),
        blastRadius: _finiteOr(raw.blastRadius ?? raw.system?.blastRadius
            ?? raw.traits?.blast ?? raw.system?.traits?.blast, 0),
        damage: _expectedDamage(raw.damage ?? raw.system?.damage ?? 0),
        requirements: Array.isArray(raw.requirements) ? raw.requirements.slice() : [],
        spray: raw.spray === true || raw.traits?.spray === true,
        rateOfFire: raw.rateOfFire ?? raw.system?.rateOfFire ?? null,
        aim: Number.isFinite(raw.aim) ? raw.aim
            : (Number.isFinite(raw.modifier) ? raw.modifier : null),
        reload: raw.reload ?? null,
        spans: Number.isFinite(raw.spans) ? raw.spans : null,
        cost: raw.cost ?? null
    };
}

/**
 * Fallback action candidates when the system API is unavailable: one
 * attack per weapon item of the actor.
 * @param {object|null} actor
 * @returns {object[]}
 */
function _fallbackActions(actor) {
    return _list(actor?.items)
        .filter(item => item?.type === "weapon")
        .map((item, index) => _normalizeAction({
            id: `weapon-${item.id ?? index}`,
            type: "attack",
            name: item.name,
            itemUuid: item.uuid ?? null,
            itemId: item.id ?? null,
            class: item.system?.class ?? null,
            range: item.system?.range ?? null,
            blastRadius: item.system?.blastRadius ?? item.system?.traits?.blast ?? 0,
            damage: item.system?.damage ?? 0
        }, index))
        .filter(Boolean);
}

/**
 * Resolve action candidates: injected `context.actions`, the system API
 * `game.darkHeresy.api.actions.list(actor)` (sync or async), or the
 * weapon-item fallback.
 * @param {object|null} actor
 * @param {object} context
 * @returns {Promise<object[]>}
 */
async function _resolveActions(actor, context) {
    let raw = null;
    if (Array.isArray(context.actions)) {
        raw = context.actions;
    } else {
        const source = context.actionsApi
            ?? context.actionsProvider
            ?? globalThis.game?.darkHeresy?.api?.actions
            ?? null;
        if (source && typeof source.list === "function") {
            try {
                raw = await Promise.resolve(source.list(actor));
            } catch(err) {
                raw = null;
            }
        }
    }
    if (raw && !Array.isArray(raw) && Array.isArray(raw.actions)) raw = raw.actions;
    let actions = Array.isArray(raw)
        ? raw.map((entry, index) => _normalizeAction(entry, index)).filter(Boolean)
        : [];
    if (!actions.length) actions = _fallbackActions(actor);
    // Enrich normalized entries with the referenced weapon item: the system
    // API action shape carries only weaponId/weaponName, not class/range/
    // damage/uuid вЂ” melee detection and range depend on the item data.
    const itemById = new Map();
    for (const item of _list(actor?.items)) {
        if (item?.id) itemById.set(item.id, item);
    }
    actions = actions.map(action => {
        const item = action.itemId ? itemById.get(action.itemId) : null;
        if (!item) return action;
        const cls = action.class ?? item.system?.class ?? null;
        return {
            ...action,
            itemUuid: action.itemUuid ?? item.uuid ?? null,
            class: cls,
            melee: action.melee || String(cls ?? "").toLowerCase() === "melee",
            range: action.range ?? (Number.isFinite(item.system?.range) ? item.system.range : null),
            blastRadius: action.blastRadius > 0 ? action.blastRadius
                : _finiteOr(item.system?.blastRadius ?? item.system?.traits?.blast, 0),
            spray: action.spray || /spray/i.test(String(item.system?.special ?? "")),
            rateOfFire: action.rateOfFire ?? item.system?.rateOfFire ?? null,
            damage: action.damage > 0 ? action.damage : _expectedDamage(item.system?.damage ?? 0)
        };
    });
    actions = actions
        .sort((a, b) => (b.damage - a.damage)
            || ((_actionRange(b) - _actionRange(a)))
            || String(a.id).localeCompare(String(b.id)));
    // The system API exposes one entry per attack type per weapon
    // (standard/charge/allOut/…) — curate per weapon: keep all available
    // attack types but cap each weapon to MAX_ATTACK_TYPES_PER_WEAPON
    // picks in curated preference order so a multi-type weapon cannot
    // crowd others out under DEFAULT_MAX_ACTIONS. `suppressing_fire` is
    // excluded outright (it needs a targetPoint/template).
    // Injected/custom actions (no attackType) always pass through.
    const apiGroups = new Map();
    const passthrough = [];
    for (const action of actions) {
        if (action.attackType == null) {
            passthrough.push(action);
            continue;
        }
        const key = action.itemUuid ?? action.itemId ?? action.id;
        let group = apiGroups.get(key);
        if (!group) {
            group = [];
            apiGroups.set(key, group);
        }
        group.push(action);
    }
    for (const group of apiGroups.values()) {
        passthrough.push(..._curateAttackTypes(group));
    }
    return passthrough;
}

/**
 * Pick the best attack-type candidates of a single weapon: drop excluded
 * types, order by the curated melee/ranged preference list (unknown types
 * last, stable) and keep at most {@link MAX_ATTACK_TYPES_PER_WEAPON}.
 * @param {object[]} group Normalized actions sharing one weapon.
 * @returns {object[]}
 */
function _curateAttackTypes(group) {
    const melee = group.some(action => _isMeleeAction(action));
    const order = melee ? MELEE_ATTACK_TYPE_ORDER : RANGED_ATTACK_TYPE_ORDER;
    const rank = new Map(order.map((type, index) => [type, index]));
    return group
        .map((action, index) => ({
            action,
            index,
            rank: rank.has(action.attackType) ? rank.get(action.attackType) : order.length
        }))
        .filter(entry => !EXCLUDED_ATTACK_TYPES.has(entry.action.attackType))
        .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
        // `suppressing_fire` is a distinct role (area denial), not another
        // damage attack type — it always survives the per-weapon cap.
        .filter((entry, position) => position < MAX_ATTACK_TYPES_PER_WEAPON
            || entry.action.attackType === "suppressing_fire")
        .map(entry => entry.action);
}

/**
 * Aim action entries for the action economy (issue #15). When the system
 * API or injected list exposes `kind:"aim"` records they pass through
 * with their own modifier; otherwise the universal Only War defaults are
 * synthesized — half aim (+10, one half action) and full aim (+20, a
 * full action).
 * @param {object[]} actions Normalized action entries.
 * @returns {object[]}
 */
function _aimActions(actions) {
    const found = (actions ?? []).filter(action => action.type === "aim");
    if (found.length) return found;
    return [
        { id: "aim.half", type: "aim", aim: 10, name: "Aim",
            cost: "half", synthesized: true },
        { id: "aim.full", type: "aim", aim: 20, name: "Aim",
            cost: "full", synthesized: true }
    ];
}

/**
 * Overwatch weapons of the action list (issue #54): at most one pick per
 * zone geometry — the longest-range plain ranged attack (a 45° watch
 * cone), the longest-range spray weapon (its own template cone) and the
 * longest-range blast weapon (a trigger circle). `suppressing_fire`
 * entries are a firing mode of the same gun, not a watch weapon; melee
 * reach circles stay a niche and are deliberately skipped. Deterministic
 * tiebreak by action id inside each geometry pool.
 * @param {object[]} actions Normalized attack actions.
 * @returns {{action: object, kind: "cone"|"spray"|"blast"}[]}
 */
function _overwatchWeapons(actions) {
    const pools = { cone: [], spray: [], blast: [] };
    for (const action of actions ?? []) {
        if (action.type !== "attack" || _isMeleeAction(action)
            || _actionRange(action) <= 0) continue;
        const spec = _coneSpecOf(action);
        if (spec?.suppression === true) continue;
        if (spec?.spray === true) {
            pools.spray.push(action);
        } else if (_actionBlastRadius(action) > 0) {
            pools.blast.push(action);
        } else {
            pools.cone.push(action);
        }
    }
    const pick = pool => [...pool].sort((a, b) => (_actionRange(b) - _actionRange(a))
        || String(a.id).localeCompare(String(b.id)))[0] ?? null;
    return ["cone", "spray", "blast"]
        .map(kind => (pools[kind].length ? { action: pick(pools[kind]), kind } : null))
        .filter(Boolean);
}

/**
 * Whether a normalized action belongs to a referenced weapon. The
 * reference may be a plain string (item uuid, item id or weapon name —
 * `config.preferredWeapon` and the sheet store whichever the GM picked)
 * or a record carrying those fields (`flags["only-war-ai"].lastUsedWeapon`).
 * @param {object|null} action Normalized action.
 * @param {object|string|null} ref Weapon reference.
 * @returns {boolean}
 */
function _weaponMatches(action, ref) {
    if (!action || !ref) return false;
    if (typeof ref === "string") {
        const needle = ref.trim();
        if (!needle) return false;
        return [action.itemUuid, action.itemId, action.name]
            .some(entry => String(entry ?? "") === needle);
    }
    if (typeof ref === "object") {
        return [ref.itemUuid, ref.weaponUuid, ref.itemId, ref.weaponId, ref.name]
            .filter(entry => entry != null)
            .some(entry => _weaponMatches(action, entry));
    }
    return false;
}

/**
 * Current clip fill of a weapon item; `null` when the item tracks no
 * clip (melee and simple weapons — they never run dry).
 * @param {object|null} item
 * @returns {number|null}
 */
function _itemAmmo(item) {
    const clip = item?.system?.clip;
    if (!clip || typeof clip !== "object") return null;
    return _finiteOr(clip.value, null);
}

/**
 * Clip fill of the weapon backing a normalized action; `null` when the
 * weapon item is unreadable or has no clip.
 * @param {object|null} actor
 * @param {object} action Normalized action.
 * @returns {number|null}
 */
function _weaponClipOf(actor, action) {
    const item = _list(actor?.items).find(entry => entry
        && (entry.id === action?.itemId
            || (action?.itemUuid != null && entry.uuid === action.itemUuid)));
    return _itemAmmo(item);
}

/**
 * Ready-weapon entries for the action economy (issue #37): explicit
 * `kind:"ready"|"draw"|"equip"` records from the system `actions.list`
 * pass through with their own `cost` (free under Quick Draw — the module
 * deliberately does not parse talents, the system prices the entry).
 * Otherwise, when the live attack list is dry — no usable attack/test
 * actions at all, or every usable attack's weapon is out of ammo —
 * inventory weapons backing no usable action become synthesized
 * half-cost ready candidates. A dry or clip-less weapon is always a
 * legal ready target; only weapons whose clip reads `0` are skipped.
 * @param {object} input
 * @param {object[]} input.allActions Every normalized action entry.
 * @param {object|null} input.actor Actor document for the inventory scan.
 * @param {object[]} input.usableActions Usable attack/test actions.
 * @param {boolean} [input.readyCapable] Whether the system actions API
 *   can execute a ready/draw call (issue #53 — synthesized candidates
 *   are not offered when the endpoint is missing; explicit system
 *   entries still pass, the system emitted them).
 * @returns {object[]} Normalized `ready-weapon` entries.
 */
function _readyWeaponActions({ allActions, actor, usableActions, readyCapable = true }) {
    const explicit = (allActions ?? []).filter(action => action.type === "ready-weapon");
    if (explicit.length) return explicit;
    if (!readyCapable) return [];
    const dry = !(usableActions ?? []).length
        || usableActions.every(action => _weaponClipOf(actor, action) === 0);
    if (!dry) return [];
    const backing = new Set((usableActions ?? []).map(action =>
        action.itemUuid ?? action.itemId ?? action.name ?? action.id));
    return _list(actor?.items)
        .filter(item => item?.type === "weapon"
            && !backing.has(item.uuid ?? item.id ?? item.name))
        .filter(item => {
            const ammo = _itemAmmo(item);
            return ammo === null || ammo > 0;
        })
        .map((item, index) => _normalizeAction({
            id: `ready-${item.id ?? index}`,
            kind: "ready-weapon",
            name: item.name,
            itemUuid: item.uuid ?? null,
            itemId: item.id ?? null,
            class: item.system?.class ?? null,
            damage: item.system?.damage ?? 0,
            cost: "half",
            synthesized: true
        }, index))
        .filter(Boolean)
        .sort((a, b) => (b.damage - a.damage) || String(a.id).localeCompare(String(b.id)))
        .slice(0, DEFAULT_MAX_ACTIONS);
}

/**
 * Dodge model of one (target, action) pair (issue #37 counter-EV):
 * `{dodgeable, chance}` — `chance` is the rough `dodgeTN/100` of the
 * target, capped at {@link MAX_DODGE_CHANCE}. Cone/spray/suppression
 * attacks cannot be dodged; blast attacks only dodge when the target's
 * half-move provably reaches outside the zone (unknown half-move counts
 * as undodgeable — conservative); a target that already spent its
 * reaction this round is defenseless (`chance` 0).
 * @param {object|null} target Normalized target.
 * @param {object|null} action Normalized action.
 * @param {number|null} [dodgeTN] Default dodge TN override
 *   (`context.defaultDodgeTN`).
 * @returns {{dodgeable: boolean, chance: number}}
 */
export function dodgeChanceOf(target, action, dodgeTN = null) {
    if (!action || action.type !== "attack") return { dodgeable: false, chance: 0 };
    if (target?.reactionUsed === true) return { dodgeable: true, chance: 0 };
    if (_coneSpecOf(action)) return { dodgeable: false, chance: 0 };
    const blast = _actionBlastRadius(action);
    if (blast > 0) {
        const escape = _finiteOr(target?.halfMove ?? target?.threatProfile?.halfMove, null);
        if (!(escape > 0 && escape >= blast)) return { dodgeable: false, chance: 0 };
    }
    const tn = _finiteOr(
        target?.dodge ?? target?.threatProfile?.dodge ?? dodgeTN, DEFAULT_DODGE_TN);
    return {
        dodgeable: true,
        chance: Math.max(0, Math.min(MAX_DODGE_CHANCE, tn / 100))
    };
}

/**
 * Nearest known threat: visible attackable targets win; when nothing is
 * visible the nearest last-known contact gives the overwatch bearing.
 * @param {object[]} targets Normalized targets.
 * @param {{x: number|null, y: number|null}} selfPos
 * @param {object} grid Normalized grid info.
 * @returns {object|null}
 */
function _nearestThreat(targets, selfPos, grid) {
    const list = (targets ?? []).filter(target => Number.isFinite(target?.x)
        && Number.isFinite(target?.y));
    if (!list.length) return null;
    const key = target => Number.isFinite(target.distance) ? target.distance
        : (_pixelDistance(selfPos, target, grid) ?? Infinity);
    const visible = list.filter(target => target.canAttack === true);
    const pool = visible.length ? visible : list;
    return pool.reduce((best, target) => (key(target) < key(best) ? target : best), pool[0]);
}

/**
 * Compass bearing (0-360, degrees) from self to a target point.
 * @param {{x: number|null, y: number|null}} from
 * @param {{x: number|null, y: number|null}} to
 * @returns {number|null}
 */
function _bearingTo(from, to) {
    if (!Number.isFinite(from?.x) || !Number.isFinite(from?.y)
        || !Number.isFinite(to?.x) || !Number.isFinite(to?.y)) return null;
    return (((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI) + 360) % 360;
}

/**
 * Half-move rate of a target in scene units: the normalized `halfMove`
 * field wins, the threat-profile copy is the fallback (same precedence
 * as the dodge-escape model in {@link dodgeChanceOf}).
 * @param {object|null} target Normalized target.
 * @returns {number|null}
 */
function _targetHalfMove(target) {
    return _finiteOr(target?.halfMove ?? target?.threatProfile?.halfMove, null);
}

/**
 * Lead point of a target ("на опережение", issue #54): where the enemy
 * arrives next turn walking its shortest straight line toward the bot —
 * `threatPos + dir(threat → self) × min(halfMove, distToSelf)`.
 * @param {object} target Normalized target `{x, y}` (pixels).
 * @param {object} selfPos Self position `{x, y}` (pixels).
 * @param {number} pxPerUnit Pixels per scene unit.
 * @returns {{x: number, y: number}|null}
 */
function _leadPointOf(target, selfPos, pxPerUnit) {
    const halfMove = _targetHalfMove(target);
    if (!(halfMove > 0)) return null;
    const dist = _distPx(target, selfPos);
    if (!Number.isFinite(dist) || dist < 1e-9) return null;
    const step = Math.min(halfMove * pxPerUnit, dist);
    return {
        x: target.x + (((selfPos.x - target.x) / dist) * step),
        y: target.y + (((selfPos.y - target.y) / dist) * step)
    };
}

/**
 * Route waypoint of the nearest threat ("в проход", issue #54): the
 * enemy's own `planRoute(threat → self)` — the same deterministic
 * pathfind the planner uses for its own moves — walked to the point
 * ~half a half-move along it. The shortest approach route threads the
 * doors and corridors itself, so a cone steered at this anchor covers
 * the real chokepoint instead of open ground. Without a rate the route
 * midpoint is taken; a missing service/token/route yields `null` and the
 * caller falls back to lead points. Partial routes are accepted — the
 * anchor sits close to the threat end either way.
 * @param {object} input
 * @param {object} input.threat Normalized nearest threat.
 * @param {object} input.selfPos Self position `{x, y}` (pixels).
 * @param {number} input.pxPerUnit Pixels per scene unit.
 * @param {object|null} input.navigation Navigation service.
 * @param {object|null} input.combat Active combat (token lookup).
 * @param {object|null} input.scene Active scene (token lookup).
 * @returns {{x: number, y: number}|null}
 */
function _overwatchRoutePoint({ threat, selfPos, pxPerUnit,
    navigation, combat, scene }) {
    if (!navigation || typeof navigation.planRoute !== "function") return null;
    const threatDoc = _findToken(threat?.tokenId, { combat, scene });
    if (!threatDoc || !Number.isFinite(selfPos?.x)) return null;
    const distUnits = _finiteOr(threat?.distance, null);
    // A generous numeric budget keeps the search deterministic while
    // still bounding it — a route winding past the straight distance is
    // truncated to a partial path, whose first leg anchors just as well.
    const budget = Number.isFinite(distUnits) && distUnits > 0
        ? Math.max(distUnits * 4, 1) : 64;
    let route = null;
    try {
        route = navigation.planRoute(threatDoc, { x: selfPos.x, y: selfPos.y }, budget);
    } catch(err) {
        route = null;
    }
    const waypoints = (route?.waypoints ?? route?.path ?? [])
        .filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y));
    if (waypoints.length < 2) return null;
    const px = pxPerUnit > 0 ? pxPerUnit : 1;
    const halfMove = _targetHalfMove(threat);
    const total = waypoints.slice(1).reduce(
        (sum, point, index) => sum + _distPx(waypoints[index], point), 0);
    if (!(total > 0)) return null;
    const wanted = halfMove > 0
        ? Math.min(halfMove * px / 2, total)
        : total / 2;
    let walked = 0;
    for (let index = 1; index < waypoints.length; index++) {
        walked += _distPx(waypoints[index - 1], waypoints[index]);
        if (walked + 1e-9 >= wanted) {
            return { x: waypoints[index].x, y: waypoints[index].y };
        }
    }
    const last = waypoints[waypoints.length - 1];
    return { x: last.x, y: last.y };
}

/**
 * Predicted orientation anchors of an overwatch declaration (issue #54).
 * The zone controls ground the enemy is about to cross, not the square
 * it already stands on: the route waypoint of the nearest threat first
 * (one bounded pathfind per plan, only while an overwatch candidate is
 * being built), a lead point per live threat, and the remembered
 * positions of memory contacts (`last-known`/`team-contact` — their
 * recorded point IS the prediction, issue #45 anchor). Anchors the bot
 * cannot see are dropped — a watch zone behind a wall can never fire.
 * @param {object} input
 * @param {object[]} input.targets Normalized targets.
 * @param {object} input.threatTarget Nearest threat (route anchor).
 * @param {object} input.selfPos Self position `{x, y}` (pixels).
 * @param {number} input.pxPerUnit Pixels per scene unit.
 * @param {object|null} input.navigation Navigation service.
 * @param {object|null} input.combat Active combat.
 * @param {object|null} input.scene Active scene.
 * @param {object|null} input.tokenDoc Viewer token document (LOS probes).
 * @param {object|null} input.perception Perception service (LOS probes).
 * @returns {object[]} `{x, y, kind, tokenUuid, tokenId}` anchors.
 */
function _overwatchAnchors({ targets, threatTarget, selfPos, pxPerUnit,
    navigation, combat, scene, tokenDoc, perception }) {
    const anchors = [];
    const seen = new Set();
    const push = (point, kind, target) => {
        if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
        // Equal predictions (a lead point landing on the route waypoint)
        // must not count double — the aim coverage score stays honest.
        const key = `${Math.round(point.x)},${Math.round(point.y)}`;
        if (seen.has(key)) return;
        seen.add(key);
        anchors.push({
            x: point.x,
            y: point.y,
            kind,
            tokenUuid: target?.tokenUuid ?? null,
            tokenId: target?.tokenId ?? null
        });
    };
    push(_overwatchRoutePoint({
        threat: threatTarget, selfPos, pxPerUnit, navigation, combat, scene
    }), "route", threatTarget);
    for (const target of targets ?? []) {
        if (target?.canAttack !== true || target?.hidden === true) continue;
        push(_leadPointOf(target, selfPos, pxPerUnit), "lead", target);
    }
    for (const target of targets ?? []) {
        if (!_isMemorySource(target?.source) || target?.hidden === true) continue;
        push({ x: target.x, y: target.y }, "memory", target);
    }
    if (!perception || typeof perception.hasLineOfSight !== "function") {
        return anchors;
    }
    return anchors.filter(anchor => {
        try {
            return perception.hasLineOfSight(tokenDoc, anchor) === true;
        } catch(err) {
            return true;
        }
    });
}

/**
 * Trigger circle of a blast overwatch (issue #54): the predicted anchor
 * covering the most other anchors within the blast radius wins — the
 * grenade lands where converging approach routes intersect. Candidate
 * centres must sit inside the throw range and must not blanket a
 * friendly (the same `blastTokens` veto as `_bestBlastAim`); the visible
 * threat's live position is the last-resort centre, so an empty
 * prediction set degrades to the old straight-at-threat zone.
 * @param {object} input
 * @param {object[]} input.anchors Predicted anchors (`_overwatchAnchors`).
 * @param {object} input.threatTarget Nearest live threat (fallback centre).
 * @param {object} input.selfPos Self position `{x, y}` (pixels).
 * @param {object|null} input.tokenDoc Viewer token document (self veto
 *   exemption).
 * @param {number} input.rangePx Weapon range in pixels.
 * @param {number} input.radiusPx Blast radius in pixels.
 * @param {object[]} input.tokens Coverage scan (`_blastTokens` shape).
 * @param {number} input.viewerDisposition Self disposition.
 * @param {object} input.options `{includeNeutral, dispositions}`.
 * @returns {{shape: "blast", targetPoint: {x: number, y: number}}|null}
 */
function _overwatchBlastZone({ anchors, threatTarget, selfPos, tokenDoc,
    rangePx, radiusPx, tokens, viewerDisposition, options }) {
    if (!(rangePx > 0) || !(radiusPx > 0)) return null;
    const centres = [...(anchors ?? [])];
    if (Number.isFinite(threatTarget?.x) && Number.isFinite(threatTarget?.y)) {
        centres.push({ x: threatTarget.x, y: threatTarget.y, kind: "live" });
    }
    let best = null;
    centres.forEach(centre => {
        if (_distPx(selfPos, centre) > rangePx + 1e-9) return;
        let hits = 0;
        let blocked = false;
        for (const token of tokens ?? []) {
            if ((token.tokenId ?? token.id) === tokenDoc?.id) continue;
            if (_distPx(centre, token) > radiusPx + 1e-9) continue;
            const disp = Math.sign(_finiteOr(token.disposition, 0));
            if (!_hostileTo(viewerDisposition, disp, options)) {
                blocked = true;
                break;
            }
        }
        if (blocked) return;
        for (const anchor of anchors ?? []) {
            if (_distPx(centre, anchor) <= radiusPx + 1e-9) hits++;
        }
        // The threat's own square always counts — a trigger circle over
        // the live enemy fires the moment it acts.
        if (_distPx(centre, threatTarget) <= radiusPx + 1e-9) hits++;
        if (hits <= 0) return;
        // First-listed centre wins ties: route > lead > memory > live —
        // the deterministic preference order of issue #54.
        if (!best || hits > best.hits) best = { centre, hits };
    });
    if (!best) return null;
    return {
        shape: "blast",
        targetPoint: { x: best.centre.x, y: best.centre.y }
    };
}

/**
 * Watch zone of one overwatch weapon (issue #54). Cone geometries steer
 * `_bestConeAim` by the predicted anchors — the existing coverage sweep
 * already maximizes the number of covered predictions with the friendly
 * veto, so converging approach routes land the cone on the shared
 * chokepoint naturally (all-anchors variant of the issue). A raw bearing
 * on the nearest threat stays the last-resort fallback when nothing was
 * predictable, preserving the issue #15 behaviour.
 * @param {object} input
 * @param {"cone"|"spray"|"blast"} input.kind Zone geometry of the weapon.
 * @param {object} input.action Overwatch weapon action.
 * @param {object[]} input.anchors Predicted anchors.
 * @param {object} input.threatTarget Nearest live threat (fallback).
 * @param {object} input.selfPos Self position `{x, y}` (pixels).
 * @param {number} input.pxPerUnit Pixels per scene unit.
 * @param {object|null} input.tokenDoc Viewer token document.
 * @param {object[]} input.tokens Coverage scan (`_blastTokens` shape).
 * @param {number} input.viewerDisposition Self disposition.
 * @param {object} input.options `{includeNeutral, dispositions}`.
 * @returns {object|null} `{shape, direction?, arc?, range?, targetPoint?,
 *   blastRadius?}`.
 */
function _overwatchZone({ kind, action, anchors, threatTarget, selfPos,
    pxPerUnit, tokenDoc, tokens, viewerDisposition, options }) {
    const range = _actionRange(action);
    const rangePx = range * pxPerUnit;
    if (kind === "blast") {
        const zone = _overwatchBlastZone({
            anchors, threatTarget, selfPos, tokenDoc, rangePx,
            radiusPx: _actionBlastRadius(action) * pxPerUnit,
            tokens, viewerDisposition, options
        });
        return zone ? { ...zone, blastRadius: _actionBlastRadius(action), range } : null;
    }
    const spec = _coneSpecOf(action);
    const arc = spec?.angle ?? OVERWATCH_CONE_DEG;
    const aim = _bestConeAim({
        tokenDoc,
        origin: selfPos,
        rangePx,
        angleDeg: arc,
        tokens,
        anchors,
        viewerDisposition,
        options,
        perception: null,
        requireLos: false
    });
    if (aim) return { shape: "cone", direction: aim.direction, arc, range };
    const direction = _bearingTo(selfPos, threatTarget);
    return Number.isFinite(direction)
        ? { shape: "cone", direction, arc, range }
        : null;
}

/**
 * Danger value at the bot's own position for the drop-prone check —
 * `dangerAt` may throw; a broken probe counts as no cover urgency.
 * @param {Function} dangerAt Threat-map probe.
 * @param {object} selfPos Self position `{x, y}` (pixels).
 * @returns {number} 0..1.
 */
function _dangerAtSelf(dangerAt, selfPos) {
    try {
        return _finiteOr(dangerAt(selfPos), 0);
    } catch(err) {
        return 0;
    }
}

/**
 * Normalize a movement candidate to the internal move shape.
 * @param {object} raw
 * @param {object} input Normalization context.
 * @param {object} input.selfPos Self position `{x, y}` in pixels.
 * @param {object} input.targetPos Target position `{x, y}` in pixels.
 * @param {object} input.grid Normalized grid info.
 * @param {boolean} [input.stay] Force the stay-in-place flag.
 * @returns {object|null}
 */
function _normalizeMove(raw, { selfPos, targetPos, grid, stay = false }) {
    if (!raw || typeof raw !== "object") return null;
    const x = _finiteOr(raw.x, null);
    const y = _finiteOr(raw.y, null);
    if (x === null || y === null) return null;
    const distance = Number.isFinite(raw.distance)
        ? raw.distance
        : _pixelDistance({ x, y }, targetPos, grid);
    const moved = !(x === selfPos.x && y === selfPos.y);
    return {
        key: raw.key ?? `${_finiteOr(raw.i, "?")},${_finiteOr(raw.j, "?")}@${x},${y}`,
        x,
        y,
        i: _finiteOr(raw.i, null),
        j: _finiteOr(raw.j, null),
        cost: _finiteOr(raw.cost, 0),
        costCells: _finiteOr(raw.costCells, null),
        distance,
        los: raw.los === true ? true : null,
        cover: Number.isFinite(raw.cover) ? raw.cover : 0,
        approximate: raw.approximate === true,
        stay: stay || !moved,
        waypoints: Array.isArray(raw.waypoints) ? _jsonClone(raw.waypoints) : null
    };
}

/**
 * Straight-line approach point used when no navigation service can route:
 * the position at `range` scene units from the target toward the viewer.
 * @param {object} selfPos
 * @param {object} target
 * @param {number} range Scene units.
 * @param {object} grid
 * @returns {object|null}
 */
function _approachPoint(selfPos, target, range, grid) {
    if (!Number.isFinite(selfPos?.x) || !Number.isFinite(target?.x)) return null;
    const size = Number.isFinite(grid?.size) && grid.size > 0 ? grid.size : 100;
    const unit = Number.isFinite(grid?.distance) && grid.distance > 0 ? grid.distance : 1;
    const dx = selfPos.x - target.x;
    const dy = selfPos.y - target.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= 0) return null;
    const desired = Math.max(range * (size / unit) * 0.9, 1);
    return {
        x: target.x + ((dx / dist) * desired),
        y: target.y + ((dy / dist) * desired)
    };
}

/**
 * Resolve movement candidates for one target: injected `context.moves`,
 * the navigation service `findCandidates`, or the stay-in-place +
 * straight-approach fallback.
 * @param {object} input Resolution context.
 * @param {object|null} input.tokenDoc Viewer token document.
 * @param {object} input.target Normalized target entry.
 * @param {number} input.range Attack range in scene units.
 * @param {number|null} [input.bandRange] Farthest weapon range in scene
 *   units — drives the edge probe; falls back to `range` when unset.
 * @param {object} input.selfPos Self position `{x, y}` in pixels.
 * @param {object} input.targetPos Target position `{x, y}` in pixels.
 * @param {object} input.grid Normalized grid info.
 * @param {object|null} input.navigation Navigation service or null.
 * @param {object|null} input.perception Perception service or null.
 * @param {object} input.context Planning context overrides.
 * @returns {object[]}
 */
function _resolveMoves({ tokenDoc, target, range, bandRange = null,
    selfPos, targetPos, grid, navigation, perception, context }) {
    const input = { selfPos, targetPos, grid };
    let raw = null;
    if (Array.isArray(context.moves)) {
        raw = context.moves;
    } else if (navigation && typeof navigation.findCandidates === "function") {
        const find = options => {
            try {
                const result = navigation.findCandidates(tokenDoc,
                    context.moveBudget ?? { mode: "full" },
                    {
                        count: _finiteOr(context.moveCandidateCount, DEFAULT_MOVE_CANDIDATES),
                        includeCover: true,
                        perception,
                        rates: context.rates,
                        ...options
                    });
                return result && result.status === "ok" && Array.isArray(result.candidates)
                    ? result.candidates : [];
            } catch(err) {
                return [];
            }
        };
        // Copy — the navigation result is deep-frozen and the band merge
        // below pushes extra candidates.
        raw = [...find({ target: targetPos })];
        // Issue #31: move-attack is capped at the half-move rate, so the
        // candidate set also needs cheap cells at the weapon's range edge —
        // the proximity-ranked top-N only ever holds the cells nearest the
        // target, which all cost more than a half move on long approaches.
        // Probe a point `0.9 × range` from the target toward the viewer:
        // cells close to it are both reachable on a half move and already
        // inside firing distance.
        const band = Number.isFinite(bandRange) && bandRange > 0 ? bandRange : range;
        if (Number.isFinite(band) && band > 0
            && Number.isFinite(target?.distance) && target.distance > band) {
            const edge = _approachPoint(selfPos, target, band, grid);
            if (edge) {
                const seen = new Set(raw.map(entry =>
                    `${_finiteOr(entry?.i, null)}|${_finiteOr(entry?.j, null)}`));
                for (const entry of find({ target: edge })) {
                    const key = `${_finiteOr(entry?.i, null)}|${_finiteOr(entry?.j, null)}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    // `distance` was scored against the edge probe —
                    // `_normalizeMove` must recompute it against the real
                    // target so the range filter sees the true value.
                    raw.push({ ...entry, distance: null });
                }
            }
        }
    }
    if (raw === null) {
        // Fallback without navigation: staying put plus a straight-line
        // approach point when the target is out of reach.
        raw = [{ x: selfPos.x, y: selfPos.y, i: null, j: null, cost: 0 }];
        if (context.approximateMoves !== false && Number.isFinite(range) && range > 0) {
            const approach = _approachPoint(selfPos, target, range, grid);
            if (approach && Number.isFinite(target.distance) && target.distance > range) {
                raw.push({ ...approach, approximate: true });
            }
        }
    }
    const stay = _normalizeMove({ x: selfPos.x, y: selfPos.y, cost: 0, key: "stay" },
        { ...input, stay: true });
    const moves = raw
        .map(entry => {
            const move = _normalizeMove(entry, input);
            // Injected moves may arrive without a cover estimate; compute
            // it through the navigation service so scoring sees the same
            // data findCandidates would have produced.
            if (move && !Number.isFinite(entry?.cover)
                && navigation && typeof navigation.coverEstimate === "function") {
                try {
                    const estimate = navigation.coverEstimate(tokenDoc,
                        { x: move.x, y: move.y }, targetPos);
                    if (Number.isFinite(estimate)) move.cover = estimate;
                } catch(_err) {
                    // Cover stays 0.
                }
            }
            return move;
        })
        .filter(Boolean);
    if (stay && !moves.some(move => move.stay)) moves.unshift(stay);
    return moves
        .sort((a, b) => (_finiteOr(a.distance, Infinity) - _finiteOr(b.distance, Infinity))
            || String(a.key).localeCompare(String(b.key)));
}

/**
 * Factor vector of a candidate variant вЂ” the shared, data-driven scoring
 * input presets weight.
 * @param {object} input Factor input.
 * @param {string} input.variant Candidate variant kind.
 * @param {object|null} input.target Normalized target entry.
 * @param {object|null} input.move Normalized move candidate.
 * @param {object|null} input.action Normalized action candidate.
 * @param {number|null} [input.moveBudget] Numeric movement budget for the
 *   `budgetOver` penalty factor (null/unknown disables it).
 * @param {Function|null} [input.dangerAt] Threat-map probe
 *   `(point) => 0..1` evaluated on the candidate endpoint (issue #16).
 * @param {object|null} [input.selfPos] Self position `{x, y}` in pixels —
 *   the endpoint of stationary variants.
 * @param {number} [input.blastHits] Hostiles covered by a blast aim point.
 * @param {object|null} [input.dodge] `{dodgeable, chance}` of the
 *   (target, action) pair (issue #37); recomputed when absent.
 * @param {object|string|null} [input.preferredWeapon] Resolved
 *   `preferredWeapon` config value (issue #37).
 * @param {object|string|null} [input.lastUsedWeapon] `lastUsedWeapon`
 *   flag/context value feeding the `weaponInertia` factor (issue #37).
 * @param {string[]} [input.traits] Resolved personality trait ids —
 *   their `weaponAffinity` specs feed the `weaponAffinity` factor.
 * @param {number|null} [input.dodgeTN] Default dodge TN override.
 * @param {Set<string>|null} [input.allyEngagedTargets] Hostile token
 *   uuids currently engaged in melee with an ally (issue #39) — feeds
 *   the `alliedEngagement` factor on point-target attacks.
 * @param {object[]} [input.enemies] Enemy contacts `{x, y, reachPx}` —
 *   feeds the `leaveMeleeEngage`/`engageDenial` free-attack factors.
 * @param {object|null} [input.lastAttacker] Active `lastAttacker` flag
 *   record (`{tokenUuid, actorId, ...}`) — feeds the `grudge` factor.
 * @param {object|null} [input.lastTarget] `lastTarget` flag/context
 *   record (`{tokenUuid, tokenId, actorId, round}`) — feeds the
 *   `stickyTarget` factor while fresh.
 * @param {object|null} [input.orderBoost] `{character, pressured}` — the
 *   `order` factor grows +0.5 in `disciplined`/`elite` teams and +0.5
 *   under morale pressure (issue #38, graceful #26 hook).
 * @returns {object}
 */
function _factorsOf({ variant, target, move, action, moveBudget = null, blastHits = 0,
    dangerAt = null, selfPos = null, dodge = null, preferredWeapon = null,
    lastUsedWeapon = null, traits = [], dodgeTN = null,
    allyEngagedTargets = null, enemies = null, lastAttacker = null,
    orderBoost = null, lastTarget = null }) {
    const targetDistance = _finiteOr(target?.distance, null);
    const postDistance = _finiteOr(move?.distance, targetDistance);
    const canAttack = target?.canAttack === true;
    const attackNow = (variant === "attack-in-place" || variant === "aim-attack")
        && canAttack ? 1 : 0;
    const attackAfterMove = (variant === "move-attack" || variant === "charge") && canAttack ? 1 : 0;
    let advance = 0;
    if (move && !move.stay && Number.isFinite(targetDistance) && targetDistance > 0
        && Number.isFinite(postDistance)) {
        advance = Math.max(0, Math.min(1, (targetDistance - postDistance) / targetDistance));
    }
    const proximity = Number.isFinite(postDistance)
        ? 1 / (1 + (postDistance / 10))
        : 0;
    const los = target?.source === "visible" || move?.los === true ? 1 : 0;
    const cover = Math.max(0, Math.min(1, _finiteOr(move?.cover, 0)));
    const stationary = variant === "hold" || variant === "attack-in-place"
        || variant === "aim-attack" || variant === "aim"
        || variant === "reload" || variant === "overwatch"
        || variant === "ready-weapon" || variant === "drop-prone"
        || variant === "unpin" || variant === "order";
    const holdPosition = stationary || move?.stay === true ? 1 : 0;
    const budget = Number.isFinite(moveBudget) && moveBudget > 0 ? moveBudget : null;
    const budgetOver = budget !== null && move
        ? Math.max(0, (_finiteOr(move.cost, 0) - budget) / budget)
        : 0;
    const melee = _isMeleeAction(action) ? 1 : 0;
    // Melee reach of the evaluated endpoint: the melee action's own
    // range when the candidate carries one, the default reach otherwise
    // — a ranged candidate still counts as engaged in close contact.
    const meleeReach = melee ? _actionRange(action) : DEFAULT_MELEE_RANGE;
    const engaged = Number.isFinite(postDistance) && postDistance <= meleeReach + 1e-9 ? 1 : 0;
    // Issue #37: an enemy that already spent its reaction is defenceless
    // against the next shot — scored through the same `vulnerable` door
    // as pinned/prone/stunned targets.
    const vulnerable = target?.reactionUsed === true
        || (target?.statuses ?? []).some(status => VULNERABLE_STATUSES.has(status)) ? 1 : 0;
    // Issue #37 counter-EV: `EV = hitsEV × (1 − P(dodge))` folded into
    // the attack-type desire — dodgeable attacks lose expected value
    // against evasive targets; undodgeable ones (spray/cone, unescapable
    // blast, reaction-spent targets) keep the full desire.
    const dodgeInfo = dodge ?? dodgeChanceOf(target, action, dodgeTN);
    const attackDesire = action
        ? (ATTACK_TYPE_DESIRE[action.attackType] ?? ATTACK_TYPE_DESIRE_DEFAULT)
        : 0;
    // Weapon affinity and inertia (issue #37): the GM-marked signature
    // weapon wins outright; a matching personality `weaponAffinity` spec
    // (sniper → long-las, grenadier → blast) contributes half strength;
    // the weapon used on the previous turn gets a small hysteresis.
    let weaponAffinity = 0;
    if (action && preferredWeapon && _weaponMatches(action, preferredWeapon)) {
        weaponAffinity = 1;
    } else if (action && personalityWeaponAffinity(traits, action)) {
        weaponAffinity = 0.5;
    }
    // Issue #16 threat map: aggregated danger of the candidate endpoint —
    // the move destination, the stay cell or the actor position for
    // stationary variants. It complements `cover`/`exposure`: those only
    // measure walls against the *planned* target, `danger` sums every
    // known enemy's effective weapon range over the cell — a spot safe
    // from the current target may still be a kill lane for a second
    // shooter.
    const endpoint = move && Number.isFinite(move.x) && Number.isFinite(move.y)
        ? { x: move.x, y: move.y }
        : (Number.isFinite(selfPos?.x) && Number.isFinite(selfPos?.y) ? selfPos : null);
    let danger = 0;
    if (endpoint && typeof dangerAt === "function") {
        try {
            danger = Math.max(0, Math.min(1, _finiteOr(dangerAt(endpoint), 0)));
        } catch(err) {
            danger = 0;
        }
    }
    // Issue #39: firing at a target standing in melee with an ally draws
    // the −20 shooting-into-melee penalty — only point-target attacks
    // suffer it. Melee actions and blast/cone templates are exempt: the
    // template candidates already veto any aim point covering an ally.
    // Issue #39 review: the `heretic` trait fires into an ally's melee
    // without compunction — the factor never engages for it.
    const firesIntoMelee = personalityBehaviorFlags(traits).firesIntoMelee === true;
    const alliedEngaged = !firesIntoMelee
        && allyEngagedTargets != null && typeof allyEngagedTargets.has === "function"
        && target?.tokenUuid != null
        && allyEngagedTargets.has(target.tokenUuid)
        && action && melee !== 1
        && _actionBlastRadius(action) <= 0
        && !_coneSpecOf(action) ? 1 : 0;
    // Issue #39 free-attack awareness (DH2e Disengage): leaving an
    // enemy's melee reach without a Disengage action provokes a free
    // swing — compared per enemy, so walking out of A's reach into B's
    // still counts. `engageDenial` marks the inverse transition: ending
    // inside an enemy's reach while starting outside all of them.
    let engagedAtStart = false;
    let engagedAtEnd = false;
    let leaveMeleeEngage = 0;
    for (const enemy of enemies ?? []) {
        if (!enemy || !Number.isFinite(enemy.reachPx)) continue;
        const startIn = _distPx(selfPos, enemy) <= enemy.reachPx + 1e-9;
        const endIn = _distPx(endpoint, enemy) <= enemy.reachPx + 1e-9;
        if (startIn && !endIn) leaveMeleeEngage = 1;
        engagedAtStart = engagedAtStart || startIn;
        engagedAtEnd = engagedAtEnd || endIn;
    }
    const engageDenial = !engagedAtStart && engagedAtEnd ? 1 : 0;
    // Issue #39 review: `grudge` marks candidates whose target is the
    // recorded last attacker — scaled by the wounds actually lost so a
    // scratch barely registers while a near-kill pulls hard (default 5
    // when the record carries no wound count).
    const grudge = lastAttacker && target
        && ((lastAttacker.tokenUuid != null
                && target.tokenUuid === lastAttacker.tokenUuid)
            || (lastAttacker.tokenId != null
                && target.tokenId === lastAttacker.tokenId)
            || (lastAttacker.actorId != null
                && target.actorId === lastAttacker.actorId))
        ? Math.min(Math.max(_finiteOr(lastAttacker.woundsLost, 5), 0) / 10, 1)
        : 0;
    // Smoke finding: target inertia — a bot keeps pressing the target it
    // already engaged/attacked instead of switching between near-equal
    // options every round. Applies to any attack variant on that target,
    // so a charge on the *same* target still earns it.
    const stickyTarget = lastTarget && target
        && ((lastTarget.tokenUuid != null
                && target.tokenUuid === lastTarget.tokenUuid)
            || (lastTarget.tokenId != null
                && target.tokenId === lastTarget.tokenId)
            || (lastTarget.actorId != null
                && target.actorId === lastTarget.actorId))
        ? 1 : 0;
    // Ganging up (OW numerical superiority in melee): melee candidates
    // against a target already engaged by allies earn up to the full
    // factor at two-plus allies — only melee enjoys the rule bonus.
    const allyCount = melee === 1 && target?.tokenUuid != null
        && allyEngagedTargets != null && typeof allyEngagedTargets.get === "function"
        ? (allyEngagedTargets.get(target.tokenUuid) ?? 0) : 0;
    const outnumber = Math.min(allyCount, 2) / 2;
    return {
        attackNow,
        attackAfterMove,
        charge: variant === "charge" ? 1 : 0,
        melee,
        advance,
        threat: Math.max(0, Math.min(1, _finiteOr(target?.threat, 0))),
        proximity,
        los,
        cover,
        exposure: move && move.stay !== true ? Math.max(0, 1 - cover) : 0,
        holdPosition,
        // Comms-net hearsay weighs half of a direct memory: the squad
        // still advances on it, but a fresher own sighting always wins.
        lastKnown: _isMemorySource(target?.source)
            ? (target?.source === "relay" ? 0.5 : 1) : 0,
        budgetOver,
        attackType: attackDesire,
        // Issue #37 counter-EV (review): the dodge discount scaled by
        // expected weapon damage — `ev = damageNorm × attackDesire ×
        // (1 − P(dodge))`. Undodgeable attacks (spray, unescapable
        // blast, reaction-spent target) keep `chance` 0 → full value.
        ev: action?.type === "attack"
            ? Math.round(
                Math.max(0, Math.min(1, _finiteOr(action.damage, 0) / 20))
                * attackDesire
                * (1 - dodgeInfo.chance) * 1e6) / 1e6
            : 0,
        vulnerable,
        engaged,
        meleeEngage: melee * engaged,
        // Blast coverage: 1+ hostiles under the template; a presumed
        // last-known strike counts 0.5 of a confirmed two-target hit.
        area: Math.min(_finiteOr(blastHits, 0) / 2, 1),
        // Action-economy markers (issue #15): an aimed attack spends the
        // whole budget for a +10/+20 bonus; reload/overwatch are the
        // utility turns of a dry clip or a held position.
        // `aim` marks the aimed shot; `aimAlone` the standalone full-aim
        // turn — presets weight it low so aiming never beats a legal shot.
        aim: variant === "aim-attack" ? 1 : 0,
        aimAlone: variant === "aim" ? 1 : 0,
        reload: (variant === "reload" || variant === "move-reload") ? 1 : 0,
        overwatch: variant === "overwatch" ? 1 : 0,
        danger,
        weaponAffinity,
        weaponInertia: action && _weaponMatches(action, lastUsedWeapon) ? 1 : 0,
        dropProne: variant === "drop-prone" ? 1 : 0,
        readyWeapon: variant === "ready-weapon" ? 1 : 0,
        alliedEngagement: alliedEngaged,
        leaveMeleeEngage,
        engageDenial,
        unpin: variant === "unpin" ? 1 : 0,
        grudge,
        // Issue #38 leader order: a plain order is the moderate utility
        // turn (1); disciplined/elite teams obey better (+0.5) and an
        // order matters more while the squad is under pressure (+0.5,
        // graceful #26 morale hook — absent flags read as calm).
        order: variant === "order"
            ? 1 + (orderBoost?.character === true ? 0.5 : 0)
                + (orderBoost?.pressured === true ? 0.5 : 0)
            : 0,
        stickyTarget,
        outnumber
    };
}

/**
 * Default utility evaluation: `ОЈ weight_i Г— factor_i` with an explainable
 * per-factor breakdown.
 * @param {object} factors
 * @param {object} weights
 * @returns {{score: number, breakdown: object}}
 */
export function evaluateFactors(factors, weights) {
    const contributions = {};
    let total = 0;
    for (const [key, weight] of Object.entries(weights ?? {})) {
        if (!Number.isFinite(weight) || weight === 0) continue;
        const contribution = (_finiteOr(factors?.[key], 0)) * weight;
        // `+ 0` normalizes -0 so plans stay JSON-round-trip stable.
        contributions[key] = (Math.round(contribution * 1e4) / 1e4) + 0;
        total += contribution;
    }
    return {
        score: (Math.round(total * 1e6) / 1e6) + 0,
        breakdown: { factors: { ...factors }, contributions, weights: { ...weights } }
    };
}

/**
 * Seeded FisherвЂ“Yates pick inside the equal-score tie group. The same
 * seed always selects the same candidate; different seeds may differ.
 * @param {object[]} tied Candidates sharing the top score (pre-sorted).
 * @param {number} seed
 * @returns {object}
 */
function _seededPick(tied, seed) {
    const shuffled = [...tied];
    const next = mulberry32(seed);
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled[0];
}

/**
 * Resolved AI difficulty for one plan: validated `context.difficulty`
 * wins, otherwise the `aiDifficulty` world setting (issue #16).
 * @param {object} context Planning context.
 * @returns {string} One of `easy|normal|hard`.
 */
function _difficultyOf(context) {
    return AI_DIFFICULTIES.includes(context?.difficulty)
        ? context.difficulty
        : getAIDifficulty();
}

/**
 * Threat sources for the plan's danger field and counter model:
 * injected `context.threats` win; otherwise the resolved targets provide
 * positions while `threatSourcesOf` derives weapon emitters from
 * explicit target profiles or the enemy token's actor loadout.
 * @param {object} input
 * @param {object[]} input.targets Normalized targets.
 * @param {object} input.combat Combat document.
 * @param {object|null} input.scene Scene for token lookup.
 * @param {object} input.context Planning context.
 * @returns {object[]} Raw/normalized threat sources.
 */
function _enemyThreats({ targets, combat, scene, context }) {
    if (Array.isArray(context?.threats)) return context.threats;
    return threatSourcesOf(targets, {
        combat,
        scene,
        findToken: tokenId => _findToken(tokenId, { combat, scene })
    });
}

/**
 * Resolve the threat map for one plan. `context.threatMap` may be a
 * ready map (`dangerAt`), a threat-map service (`refresh` builds and
 * returns it) or `false` to disable the factor; absent an injection the
 * map is built locally from the resolved threat sources — but only on
 * `normal`/`hard`: easy bots deliberately do not read the danger field.
 * @param {object} input
 * @param {string} input.difficulty Resolved AI difficulty.
 * @param {object[]} input.threats Threat sources.
 * @param {object} input.grid Normalized grid info.
 * @param {Function|boolean|undefined} input.los Sight probe override.
 * @param {object|null} input.service Registered `threatMap` service.
 * @param {object} input.context Planning context.
 * @returns {object|null} Map exposing `dangerAt(point)` or null.
 */
function _resolveThreatMap({ difficulty, threats, grid, los, service, context }) {
    const injected = context?.threatMap;
    if (injected === false) return null;
    if (injected && typeof injected === "object") {
        if (typeof injected.refresh === "function") {
            try {
                const map = injected.refresh({ threats, grid, los, context });
                if (map && typeof map.dangerAt === "function") return map;
            } catch(err) {
                // Fall back to the local build below.
            }
        }
        if (typeof injected.dangerAt === "function") return injected;
    }
    // Easy bots skip the derived danger field; an explicit source list
    // still applies because caller-injected context always wins.
    if (difficulty === "easy" && !Array.isArray(context?.threats)) return null;
    if (!threats.length) return null;
    if (service && typeof service.refresh === "function") {
        try {
            const map = service.refresh({ threats, grid, los, context });
            if (map && typeof map.dangerAt === "function") return map;
        } catch(err) {
            // Fall back to the local build below.
        }
    }
    try {
        return buildThreatMap({ threats, los, grid });
    } catch(err) {
        return null;
    }
}

/**
 * Whether the 2-ply lookahead pass runs for this plan: `hard`
 * difficulty enables it by default, `context.lookahead` force-enables
 * or force-disables it; `context.lookaheadLambda`/`lookaheadTopK` tune
 * the penalty weight and the top-K bound.
 * @param {object} context Planning context.
 * @param {string} difficulty Resolved AI difficulty.
 * @returns {{enabled: boolean, lambda: number, topK: number}}
 */
function _lookaheadConfig(context, difficulty) {
    const enabled = context?.lookahead === true
        || (context?.lookahead !== false && difficulty === "hard");
    if (!enabled) return { enabled: false, lambda: 0, topK: 0 };
    const lambda = Number.isFinite(context?.lookaheadLambda)
        ? context.lookaheadLambda : DEFAULT_LOOKAHEAD_LAMBDA;
    const topK = Math.max(1, Math.min(8,
        Math.floor(_finiteOr(context?.lookaheadTopK, DEFAULT_LOOKAHEAD_TOP_K))));
    return { enabled: true, lambda, topK };
}

/**
 * Lookahead pass over the top-K scored candidates: each candidate's
 * endpoint is charged the expected counter damage of the strongest
 * enemy emitter able to respond (`adjusted = score − λ × EV`). The
 * returned pool is re-sorted by adjusted score with candidate-id
 * tie-breaks — deterministic for identical input.
 * @param {object[]} scored Scored candidates (score-sorted).
 * @param {object} input
 * @param {object[]} input.threats Threat sources of the plan.
 * @param {object} input.grid Normalized grid info.
 * @param {Function|boolean|undefined} input.los Sight probe override.
 * @param {number} input.lambda Penalty weight.
 * @param {number} input.topK Candidates re-scored.
 * @param {object} input.selfPos Self position `{x, y}` in pixels.
 * @returns {object[]} The adjusted top-K pool (sorted).
 */
function _applyLookahead(scored, { threats, grid, los, lambda, topK, selfPos }) {
    const pool = scored.slice(0, Math.max(1, topK));
    for (const entry of pool) {
        const endpoint = entry.move && Number.isFinite(entry.move.x)
            && Number.isFinite(entry.move.y)
            ? { x: entry.move.x, y: entry.move.y }
            : selfPos;
        const counter = expectedCounterDamage(endpoint, threats, { grid, los });
        const adjusted = Math.round((entry.score - (lambda * counter)) * 1e6) / 1e6;
        entry.lookahead = { counterDamage: counter, adjusted };
    }
    pool.sort((a, b) => (b.lookahead.adjusted - a.lookahead.adjusted)
        || String(a.id).localeCompare(String(b.id)));
    return pool;
}

/** Candidate variants that produce an attack/test step. */
const ATTACK_VARIANTS = Object.freeze(new Set([
    "attack-in-place", "move-attack", "charge", "aim-attack"
]));

/**
 * Serialize a plan candidate variant into executable action steps.
 * @param {object} input Step input.
 * @param {object} input.candidate Winning scored candidate.
 * @param {number|null} [input.carriedAim] Aim bonus carried by the
 *   combatant `aim` flag from a previous turn; attached to attack steps.
 * @param {number|null} [input.halfMoveLimit] Half-move rate in scene
 *   units — standalone moves past it cost a full action (issue #31).
 * @returns {object[]}
 */
function _stepsFor({ candidate, carriedAim = null, halfMoveLimit = null }) {
    const steps = [];
    const { target, move, action, variant } = candidate;
    // Issue #15: an `aim` step books the aim bonus — for `aim-attack`
    // plans it is consumed by the attack step of the same turn, for a
    // standalone `aim` variant the executor persists it on the combatant
    // flag until the next attack (aimedUntil).
    if (variant === "aim-attack" || variant === "aim") {
        steps.push({
            id: `step-aim-${steps.length + 1}`,
            type: "aim",
            cost: { halves: variant === "aim" ? _actionCost(action) : 1 },
            input: {
                actionId: action?.id ?? null,
                name: action?.name ?? "Aim",
                aim: candidate.aimBonus ?? action?.aim ?? 10
            },
            preconditions: ["turn"],
            projectedResourceDelta: {}
        });
    }
    if (move && !move.stay) {
        // Issue #31: charge folds its movement into the attack's full
        // action (0 here); a bundled move costs one half; a standalone
        // move beyond the half-move rate costs a full action.
        const moveHalves = variant === "charge" ? 0
            : (candidate.action === null || candidate.action === undefined)
                ? (halfMoveLimit !== null && _finiteOr(move.cost, 0) > halfMoveLimit ? 2 : 1)
                : 1;
        steps.push({
            id: `step-move-${steps.length + 1}`,
            type: "move",
            cost: { movement: _finiteOr(move.cost, 0), halves: moveHalves },
            input: {
                to: { x: move.x, y: move.y, i: move.i, j: move.j },
                waypoints: move.waypoints ?? [],
                approximate: move.approximate === true
            },
            preconditions: ["turn", "self-position", "collision"],
            projectedResourceDelta: { movement: -(_finiteOr(move.cost, 0)) }
        });
    }
    const attacks = action && target && ATTACK_VARIANTS.has(variant);
    if (attacks) {
        steps.push({
            id: `step-${action.type === "attack" ? "attack" : "test"}-${steps.length + 1}`,
            type: action.type === "attack" ? "attack" : "test",
            cost: { halves: _actionCost(action) },
            input: {
                actionId: action.id,
                name: action.name,
                itemUuid: action.itemUuid,
                targetTokenUuid: target.tokenUuid,
                targetTokenId: target.tokenId,
                range: _actionRange(action),
                ...(action.attackType ? { attackType: action.attackType } : {}),
                ...(variant === "charge" ? { mode: "charge" } : {}),
                ...(candidate.aimBonus != null
                    ? { aim: candidate.aimBonus }
                    : (Number.isFinite(carriedAim) ? { aim: carriedAim } : {})),
                ...(candidate.aim
                    ? {
                        targetPoint: { x: candidate.aim.x, y: candidate.aim.y },
                        // Issue #29: the blast radius rides along so the
                        // GM overlay (and the system template layer) can
                        // draw the strike zone without re-resolving the
                        // weapon profile.
                        blastRadius: _actionBlastRadius(action)
                    }
                    : {}),
                ...(candidate.cone
                    ? {
                        template: {
                            direction: candidate.cone.direction,
                            angle: candidate.cone.spec?.angle ?? null,
                            range: _actionRange(action)
                        },
                        covered: candidate.cone.covered.map(entry => entry.tokenUuid),
                        ...(candidate.cone.spec?.suppression
                            ? {
                                suppressionFire: true,
                                burstMode: candidate.cone.spec.burstMode
                            }
                            : {})
                    }
                    : {})
            },
            preconditions: ["turn", "target", "resources"],
            projectedResourceDelta: action.type === "attack" ? { ammo: -1 } : {}
        });
    }
    // Issue #15: `reload` executes through `api.actions.reload`; the step
    // carries the weapon reference — the system picks the magazine swap
    // when `magazineItemId` is left unset.
    if (variant === "reload" || variant === "move-reload") {
        steps.push({
            id: `step-reload-${steps.length + 1}`,
            type: "reload",
            cost: { halves: _actionCost(action) },
            input: {
                actionId: action.id,
                name: action.name,
                weaponId: action.itemId ?? null,
                itemUuid: action.itemUuid ?? null,
                spans: action.spans ?? null
            },
            preconditions: ["turn", "resources"],
            projectedResourceDelta: {}
        });
    }
    // Issue #15: `overwatch` declares a GM-rendered zone through the
    // overwatch service (issue #14); no roll is made. Issue #54: the
    // zone descriptor follows the weapon geometry — a watch cone
    // (`direction`/`arc`/`range`, arc from `_coneSpecOf` for spray) or a
    // blast trigger circle (`shape:"blast"` + `targetPoint`/
    // `blastRadius`, matching the attack-step contract so the plan
    // overlay draws it without a new reader).
    if (variant === "overwatch") {
        const zone = candidate.zone ?? null;
        steps.push({
            id: `step-overwatch-${steps.length + 1}`,
            type: "overwatch",
            cost: { halves: ACTION_BUDGET_HALVES },
            input: {
                actionId: action.id,
                name: action.name,
                weaponId: action.itemId ?? null,
                itemUuid: action.itemUuid ?? null,
                attackType: action.attackType ?? "standard",
                ...(zone?.shape === "blast"
                    ? {
                        shape: "blast",
                        targetPoint: { x: zone.targetPoint.x, y: zone.targetPoint.y },
                        blastRadius: zone.blastRadius,
                        range: _actionRange(action)
                    }
                    : {
                        direction: zone?.direction ?? candidate.direction,
                        arc: zone?.arc ?? OVERWATCH_CONE_DEG,
                        range: _actionRange(action)
                    }),
                targetTokenUuid: target?.tokenUuid ?? null
            },
            preconditions: ["turn"],
            projectedResourceDelta: {}
        });
    }
    // Issue #37: `ready-weapon` draws/equips the alternative weapon —
    // free action when the system prices it so (Quick Draw), a half
    // action otherwise. Execution goes through
    // `api.actions.readyWeapon` when the system exposes it.
    if (variant === "ready-weapon") {
        steps.push({
            id: `step-ready-weapon-${steps.length + 1}`,
            type: "ready-weapon",
            cost: { halves: _actionCost(action) },
            input: {
                actionId: action.id,
                name: action.name,
                weaponId: action.itemId ?? null,
                itemUuid: action.itemUuid ?? null
            },
            preconditions: ["turn", "resources"],
            projectedResourceDelta: {}
        });
    }
    // Issue #39: `unpin` is the DH2e full-action Willpower test clearing
    // the pinned status. The verified `prepareTest` contract takes
    // `type` + `key`; the step also carries the descriptive
    // `characteristic`/`testKind` pair so the plan stays readable.
    if (variant === "unpin") {
        steps.push({
            id: `step-test-${steps.length + 1}`,
            type: "test",
            cost: { halves: _actionCost(action) },
            input: {
                actionId: action?.id ?? "unpin",
                name: action?.name ?? "Unpin",
                type: "characteristic",
                key: "willpower",
                characteristic: action?.characteristic ?? "willpower",
                testKind: action?.testKind ?? "characteristic"
            },
            preconditions: ["turn"],
            projectedResourceDelta: {}
        });
    }
    // Issue #37: `drop-prone` is the free-action cover answer to pinning
    // and suppression fire — executor toggles the prone status.
    if (variant === "drop-prone") {
        steps.push({
            id: `step-drop-prone-${steps.length + 1}`,
            type: "drop-prone",
            cost: { halves: 0 },
            input: { statusId: "prone" },
            preconditions: ["turn"],
            projectedResourceDelta: {}
        });
    }
    // Issue #38: `order` serializes as a regular `test` step —
    // `type:"skill"`, `key:"command"` — carrying the order identity
    // (`orderId`/`orderType`/`orderBenefit`) so the executor can
    // post-stamp `lastOrder` after a successful roll and `flags.isOrder`
    // reaches the roll card.
    if (variant === "order") {
        steps.push({
            id: `step-test-${steps.length + 1}`,
            type: "test",
            cost: { halves: _actionCost(action) },
            input: {
                actionId: action?.id ?? null,
                name: action?.name ?? null,
                type: "skill",
                key: action?.key ?? "command",
                skill: action?.skill ?? "command",
                characteristic: action?.characteristic ?? null,
                orderId: action?.orderId ?? null,
                orderType: action?.orderType ?? null,
                orderBenefit: action?.benefit ?? null,
                flags: { ...(action?.flags ?? {}), isOrder: true }
            },
            preconditions: ["turn"],
            projectedResourceDelta: {}
        });
    }
    steps.push({
        id: `step-end-turn-${steps.length + 1}`,
        type: "end-turn",
        cost: {},
        input: attacks ? {} : { reason: variant === "hold" ? "hold-position" : "no-attack" },
        preconditions: ["turn"],
        projectedResourceDelta: {}
    });
    return steps;
}

/**
 * Create the `planner` service published as `api.services.get("planner")`.
 * Pure/deterministic: never mutates documents; sibling services are looked
 * up lazily through `api.services` or injected via `context`.
 * @param {object} [deps]
 * @param {object} [deps.api] Module API for lazy service lookups.
 * @param {number} [deps.maxReplans] Replan budget per turn (default 1).
 * @param {Function} [deps.resolveConfig] Effective-config resolver.
 * @param {Function} [deps.log] Diagnostic logger.
 * @returns {object} Planner service.
 */
export function createPlannerService({
    api = null,
    maxReplans = DEFAULT_MAX_REPLANS,
    resolveConfig = resolveEffectiveConfig,
    log = (...args) => logDiagnostics(...args)
} = {}) {
    const presets = new Map();
    for (const [id, def] of Object.entries(PRESET_SKELETONS)) {
        presets.set(id, {
            id,
            weights: { ...DEFAULT_PRESET_WEIGHTS, ...(def.weights ?? {}) },
            evaluate: typeof def.evaluate === "function" ? def.evaluate : null,
            veto: typeof def.veto === "function" ? def.veto : null,
            allowNoTarget: def.allowNoTarget === true,
            allowNoAction: def.allowNoAction === true,
            alwaysOfferHold: def.alwaysOfferHold === true
        });
    }

    /**
     * Lazy service lookup: `context[name]` first, then the registry.
     * @param {string} name
     * @param {*} override Injected service (undefined = registry).
     * @returns {object|null}
     */
    function _service(name, override) {
        if (override !== undefined) return override;
        try {
            return api?.services?.get?.(name) ?? null;
        } catch(err) {
            return null;
        }
    }

    /**
     * Deterministic plan seed: injected `context.seed` wins, otherwise the
     * turn identity is hashed so identical world state re-plans identically.
     * @param {object} context
     * @param {object} combat
     * @param {object} combatant
     * @returns {number}
     */
    function _seedFor(context, combat, combatant) {
        if (Number.isFinite(context.seed)) return context.seed >>> 0;
        const key = `${combat?.id}|${combatant?.id}|${combat?.round}|${combat?.turn}`;
        return parseInt(fnv1a(key), 16) >>> 0;
    }

    /**
     * Plan a full AI turn. Async because the system actions API may be
     * async; everything else is synchronous and deterministic.
     * @param {object} combat Combat document.
     * @param {object} combatant Active combatant document.
     * @param {object} [context] Optional overrides/services:
     *   `seed`, `operation`, `replanCount`, `targets`, `actions`,
     *   `actionsApi`, `moves`, `moveBudget`, `actionBudget`, `rates`,
     *   `perception`, `navigation`, `authority`, `scene`, `token`,
     *   `collisionRevision`, `maxTargets`, `maxActions`,
     *   `approximateMoves`, `selfStatuses`, `difficulty`,
     *   `personality` (trait list or `false` to disable, issue #19),
     *   `team` (`{task, character, center, regroupPoint, ...}`).
     * @returns {Promise<object>} `{status, plan?, reason?, diagnostics?}`.
     */
    async function planTurn(combat, combatant, context = {}) {
        const authority = _service("authority", context.authority);
        if (authority) {
            if (authority.status === "waiting-for-gm"
                || (typeof authority.isController === "function"
                    && authority.isController() === false)) {
                return { status: PLANNER_STATUS.waitingForGm, reason: "not-controller", plan: null };
            }
        }
        if (!combat || combat.ended === true) {
            return { status: PLANNER_STATUS.disabled, reason: STALE_REASONS.combatEnded, plan: null };
        }
        const config = resolveConfig(combatant);
        if (!config?.enabled) {
            return { status: PLANNER_STATUS.disabled, reason: "config-disabled", plan: null };
        }
        const presetId = presets.has(config.preset) ? config.preset : FALLBACK_PRESET;
        const preset = presets.get(presetId) ?? presets.get(FALLBACK_PRESET);
        const seed = _seedFor(context, combat, combatant);
        // Issue #16 difficulty: `context.difficulty` (validated) overrides
        // the world setting; it gates threat-map reads, the lookahead
        // pass and the deliberate slip of easy mode.
        const difficulty = _difficultyOf(context);
        const diagnostics = {
            seed,
            difficulty,
            weights: { ...preset.weights },
            preset: presetId,
            candidatesCount: 0,
            rejected: [],
            ranking: [],
            chosenStep: null,
            metrics: { targetsEvaluated: 0, movesEvaluated: 0 },
            // Issue #24 funnel: unified `{layer, code, detail}` reason
            // trace (#27 plumbing) plus the effective layer toggles.
            layers: [],
            layerFlags: null
        };
        // `context.layers` boolean overrides win over the world settings;
        // a disabled layer degrades to the previous funnel level.
        const layerFlags = resolveLayerFlags(context);
        diagnostics.layerFlags = { ...layerFlags };

        const tokenDoc = _tokenDoc(context.token ?? combatant?.token);
        const actor = _actorOf(combatant) ?? _actorOf(tokenDoc);
        const scene = _sceneOf(context, combat);
        const sceneId = scene?.id ?? null;
        const grid = _gridInfo(scene);
        // Gridless scenes are rejected before planning: movement
        // candidates and route scoring need a square/hex grid (issue
        // #410). Navigation answers `gridless-unsupported` the same way.
        if (grid.type === 0) {
            recordLayerReason(diagnostics, "L0", "gridless-unsupported");
            diagnostics.trace = buildLayerTrace(diagnostics);
            return {
                status: PLANNER_STATUS.unsupported,
                reason: "gridless-unsupported",
                plan: null,
                diagnostics
            };
        }
        const selfPos = _tokenPosition(tokenDoc);
        // Issue #19 personalities live at L3 of the funnel (issue #24):
        // explicit `context.personality` or the resolved
        // `flags["only-war-ai"].personality` list wins, otherwise 1–2
        // traits are generated seeded from the stable document identity.
        // The profile is resolved lazily so the L0 stunned short-circuit
        // below and the main scoring path share the same resolution —
        // and issue #26 hoists the pure resolution above the funnel so
        // L2 morale reads the trait exceptions (`fanatic`/`cowardly`)
        // without reordering the L3 trace entry.
        const _resolvePersonality = () => resolvePersonality({
            // A disabled L3 layer degrades to `source:"disabled"` —
            // same as `context.personality === false`: no traits, no
            // jitter, a fully deterministic pick.
            explicit: layerFlags.personality === false
                ? false
                : context.personality,
            flagged: config.personality,
            character: context.team?.character,
            difficulty,
            identity: personalityIdentity({ combatant, token: tokenDoc, actor })
        });
        const _runPersonalityLayer = (resolved = _resolvePersonality()) => {
            const amp = resolved.source === "disabled"
                ? 0
                : personalityJitter({
                    traits: resolved.traits,
                    character: resolved.character,
                    difficulty
                });
            diagnostics.personality = {
                traits: [...resolved.traits],
                character: resolved.character,
                source: resolved.source,
                jitter: amp,
                flags: personalityBehaviorFlags(resolved.traits)
            };
            // L3 bound (issue #24): additive deltas merge over the preset
            // weights but every applied delta is braced to ±30% of the
            // base weight — scripts/layers.js documents the zero-base
            // floor and reports the clamped factors.
            const overlay = boundedPersonalityOverlay(preset.weights, {
                traits: resolved.traits,
                character: resolved.character
            });
            if (Object.keys(overlay.clamped).length) {
                diagnostics.personality.clamped = overlay.clamped;
            }
            diagnostics.weights = { ...overlay.weights };
            // Issue #27 explainability: the applied per-factor deltas of
            // the trait overlay ride the L3 reason record (and the
            // diagnostics personality block) so the trace can name the
            // factors the personality bent ("−proximity, −attackNow").
            const appliedDeltas = {};
            for (const [factor, weight] of Object.entries(overlay.weights)) {
                const base = Number.isFinite(preset.weights[factor])
                    ? preset.weights[factor] : 0;
                const delta = Math.round((weight - base) * 1e6) / 1e6;
                if (delta !== 0) appliedDeltas[factor] = delta + 0;
            }
            if (Object.keys(appliedDeltas).length) {
                diagnostics.personality.deltas = appliedDeltas;
            }
            recordLayerReason(diagnostics, "L3",
                layerFlags.personality === false
                    ? "personality-layer-disabled"
                    : "personality-overlay",
                layerFlags.personality === false ? undefined : {
                    traits: [...resolved.traits],
                    character: resolved.character,
                    deltas: appliedDeltas,
                    clamped: Object.keys(overlay.clamped)
                });
            return {
                personality: resolved,
                personalityAmp: amp,
                effectiveWeights: overlay.weights
            };
        };
        // Self status constraints (issue #413): deterministic rules read
        // from actor/token statuses merged with the injected
        // `context.selfStatuses` fixture array. These are L0 hard vetoes —
        // they run ahead of every other funnel entry point so nothing
        // below may override them.
        // - `stunned`: OW combatants take no actions — short-circuit to an
        //   ok plan whose only step is `end-turn` stamped `stunned`.
        // - `pinned`: no charge and no move that ends closer to the
        //   target; attack-in-place and distance-keeping moves stay legal.
        // - `prone`: the movement budget halves (floor; crawl) and charge
        //   is vetoed.
        const selfStatuses = _selfStatuses(actor, tokenDoc, context.selfStatuses);
        diagnostics.selfStatuses = selfStatuses;
        if (selfStatuses.includes("stunned")) {
            recordLayerReason(diagnostics, "L0", "stunned");
            const l3 = _runPersonalityLayer();
            const steps = [{
                id: "step-end-turn-1",
                type: "end-turn",
                cost: {},
                input: { reason: "stunned" },
                preconditions: ["turn"],
                projectedResourceDelta: {}
            }];
            diagnostics.chosenStep = steps[0].id;
            const plan = _assemblePlan({
                combat, combatant, context, authority, seed, presetId,
                diagnostics, steps, personality: l3.personality,
                winner: { score: 0, breakdown: { reason: "stunned" }, target: null },
                targets: [],
                actions: []
            });
            log(`plan ${plan.id} preset=${presetId} stunned hold`);
            return { status: PLANNER_STATUS.ok, plan, reason: null };
        }
        const isPinned = selfStatuses.includes("pinned");
        const isProne = selfStatuses.includes("prone");
        // Issue #24/#25 L1 commitment: a valid committed plan (flag
        // record or injected `context.commitment`) short-circuits the
        // funnel — its serialized steps execute verbatim and no scoring
        // runs. The layer validates the record's `expectedState` against
        // live state (ttl, own-move journal, gm-intervention, target,
        // morale tier, threat drift, cheap L0) and reports the stable
        // invalidator codes on the trace.
        const commitment = applyCommitmentLayer({
            combat, combatant, context, flags: layerFlags, diagnostics,
            selfStatuses
        });
        // Bookkeeping for the executor and the #27 trace: which record
        // was evaluated, why it was dropped and whether the world is in
        // reactive mode (>threshold same-team gm-interventions squeeze
        // every new commitment's ttl to one round).
        diagnostics.commitment = {
            recordId: commitment.record?.id ?? null,
            invalidated: commitment.invalidated ?? null,
            reactive: commitment.reactive === true,
            interventions: _finiteOr(commitment.interventions, 0)
        };
        if (commitment.decision) {
            const steps = commitment.decision.steps;
            diagnostics.chosenStep = steps.find(step => step.type !== "end-turn")?.id
                ?? steps[0]?.id ?? null;
            const plan = _assemblePlan({
                combat, combatant, context, authority, seed, presetId,
                diagnostics, steps, personality: null,
                winner: {
                    score: 0,
                    breakdown: {
                        reason: "commitment",
                        source: commitment.decision.source
                    },
                    target: null
                },
                targets: [],
                actions: []
            });
            log(`plan ${plan.id} preset=${presetId} commitment hit`);
            return { status: PLANNER_STATUS.ok, plan, reason: null };
        }
        // Issue #26 L2 morale: the layer resolves the team tier from the
        // combatant's `morale` record, derives the member-effective tier
        // through the trait exceptions (`fanatic`/`cowardly`) and
        // reports both on the trace. The bounded posture weight deltas
        // below narrow the scoring pass; the fireteam remaps the task
        // assignments. The team tier alone feeds `expectedState.morale`
        // (a tier change invalidates the commitment); the legacy #38
        // graceful morale reads stay unconditional.
        const personalityProfile = _resolvePersonality();
        const moralePosture = applyMoraleLayer({
            combatant, context, flags: layerFlags, diagnostics,
            traits: personalityProfile.traits
        });
        diagnostics.morale = {
            enabled: moralePosture.enabled,
            state: moralePosture.state,
            tier: moralePosture.tier,
            effectiveTier: moralePosture.effectiveTier,
            pressured: moralePosture.pressured,
            desperate: moralePosture.desperate,
            confident: moralePosture.confident
        };
        const l3 = _runPersonalityLayer(personalityProfile);
        const personality = l3.personality;
        const personalityAmp = l3.personalityAmp;
        let effectiveWeights = l3.effectiveWeights;
        // L2 narrowing (issue #26): the member-effective tier shifts the
        // scoring weights inside a bounded delta map — desperate
        // postpones charges and pulls toward cover/regroup, confident
        // pushes the assault. The baseline `pressured` tier shifts
        // nothing.
        if (moralePosture.enabled === true && moralePosture.effectiveTier) {
            const shifted = applyMoraleWeightShift(
                effectiveWeights, moralePosture.effectiveTier);
            if (Object.keys(shifted.deltas).length) {
                effectiveWeights = shifted.weights;
                diagnostics.weights = { ...effectiveWeights };
                diagnostics.morale.shift = { ...shifted.deltas };
                recordLayerReason(diagnostics, "L2", "morale-weight-shift", {
                    tier: moralePosture.tier,
                    effectiveTier: moralePosture.effectiveTier,
                    deltas: shifted.deltas
                });
            }
        }
        // Prone halves the numeric movement budget (floor; crawl) — both
        // the navigation findCandidates input and the `budgetOver`
        // factor see the reduced value.
        const planContext = isProne
            ? { ...context, moveBudget: _halveMoveBudget(context.moveBudget ?? { mode: "full" }) }
            : context;
        const perception = _service("perception", context.perception);
        const navigation = _service("navigation", context.navigation);
        // Prime the per-actor movement-rate cache: findCandidates is
        // synchronous and resolves {mode} budgets only against prefetched
        // rates (issue #398 system API or actor.system.movement).
        let moveRates = null;
        if (navigation && context.rates == null
            && typeof navigation.getMovementRates === "function") {
            try {
                moveRates = (await navigation.getMovementRates(tokenDoc))?.rates ?? null;
            } catch(_err) {
                // Rates stay unresolved; findCandidates degrades to stay.
            }
        }
        // Issue #31: a move bundled with a half action is a half move —
        // only endpoints within the half-move rate may combine; anything
        // further is a standalone full move. Prone crawls at half speed.
        const halfMoveRate = _finiteOr(
            context.halfMove ?? context.rates?.half ?? moveRates?.half, null);
        const halfMoveLimit = halfMoveRate !== null && isProne
            ? Math.floor(halfMoveRate / 2)
            : halfMoveRate;

        const targets = _resolveTargets({
            combat, combatant, tokenDoc, selfPos, sceneId, grid, perception, context,
            // Issue #38 review: a `distrustsContacts` trait (loner) or a
            // `rabble` squad character makes the bot ignore shared
            // contacts — willfulness over shared intel.
            distrustsContacts:
                personalityBehaviorFlags(personality.traits).distrustsContacts === true
                || personality.character === "rabble"
        });
        diagnostics.metrics.targetsEvaluated = targets.length;
        // Issue #16 threat map: one aggregated danger field built once per
        // plan from the resolved enemies' weapon loadouts (weapon EV +
        // range emitters). `context.threatMap` injects a ready map or a
        // service (`refresh` runs here), `context.threats` injects raw
        // sources; derived sources only engage on normal+hard — easy bots
        // never read the field.
        const threats = _enemyThreats({ targets, combat, scene, context: planContext });
        const losProbe = typeof planContext.los === "function" ? planContext.los : undefined;
        const threatMap = _resolveThreatMap({
            difficulty, threats, grid, los: losProbe,
            service: _service("threatMap"), context: planContext
        });
        const dangerAt = threatMap ? point => threatMap.dangerAt(point) : null;
        if (threatMap) {
            diagnostics.threatMap = {
                threats: Array.isArray(threatMap.threats) ? threatMap.threats.length : threats.length
            };
        }
        if (!targets.length && !preset.allowNoTarget) {
            diagnostics.trace = buildLayerTrace(diagnostics);
            return {
                status: PLANNER_STATUS.noTarget,
                reason: "no-target",
                plan: null,
                diagnostics
            };
        }

        const allActions = await _resolveActions(actor, context);
        // Issue #15: aim and reload entries are auxiliary actions — they
        // join the budget economy but never become attack candidates.
        const aimActions = _aimActions(allActions);
        const aimHalfAction = aimActions.find(action => _actionCost(action) === 1) ?? null;
        const aimFullAction = aimActions.find(action => _actionCost(action) >= 2)
            ?? aimHalfAction;
        const reloadActions = allActions.filter(action => action.type === "reload");
        const actions = allActions.filter(action => action.type === "attack"
            || action.type === "test");
        // AimedUntil: a combatant `aim` flag left by a previous full-aim
        // turn is consumed by this turn's attack step. Re-aiming only
        // makes sense when it raises the booked bonus.
        const carriedAim = _finiteOr(
            planContext.carriedAim,
            combatant?.getFlag?.(MODULE_ID, FLAG_KEYS.aim)?.bonus ?? null
        );
        // `maxActions` bounds weapons, not action rows: curated attack
        // types of one weapon must not crowd other weapons out.
        const actionGroups = new Map();
        for (const action of actions) {
            const key = action.itemUuid ?? action.itemId ?? action.name ?? action.id;
            if (!actionGroups.has(key)) actionGroups.set(key, []);
            actionGroups.get(key).push(action);
        }
        const usableActions = [...actionGroups.values()]
            .slice(0, _finiteOr(context.maxActions, DEFAULT_MAX_ACTIONS))
            .flat();
        // Issue #37: ready-weapon candidates rescue a bot whose attack
        // list is dry (empty clip, unreadied weapon) — they keep it out
        // of the `no-action` failure when the system or the inventory
        // still offers a live weapon to draw. Issue #53: synthesized
        // inventory candidates only when the system can actually run
        // the draw — a missing endpoint produces failed turns.
        const readyApi = context.actionsApi
            ?? globalThis.game?.darkHeresy?.api?.actions
            ?? null;
        const readyCapable = typeof readyApi?.readyWeapon === "function"
            || typeof readyApi?.ready === "function"
            || typeof readyApi?.equip === "function";
        const readyActions = _readyWeaponActions({
            allActions, actor, usableActions, readyCapable
        });
        if (!usableActions.length && !readyActions.length
            && !preset.allowNoAction && targets.length) {
            diagnostics.trace = buildLayerTrace(diagnostics);
            return {
                status: PLANNER_STATUS.noAction,
                reason: "no-action",
                plan: null,
                diagnostics
            };
        }

        // Numeric movement budget used by the `budgetOver` factor; injected
        // budgets may be a number or `{budget|limit}` objects from callers
        // like the executor. `planContext` already carries the halved
        // prone budget.
        const moveBudget = Number.isFinite(planContext.moveBudget)
            ? planContext.moveBudget
            : _finiteOr(planContext.moveBudget?.budget ?? planContext.moveBudget?.limit, null);
        // Issue #33: `context.spent` subtracts budget already consumed
        // this turn — GM manual actions or a partial execution before a
        // replan. Movement endpoints past the remainder are filtered out;
        // a spent-up action budget leaves only free actions.
        const spentMove = _finiteOr(context.spent?.movement, 0);
        const spentHalves = _finiteOr(context.spent?.halves, 0);
        const totalMoveBudget = Number.isFinite(moveBudget) ? moveBudget
            : _finiteOr(
                moveRates?.[planContext.moveBudget?.mode ?? "full"]
                    ?? context.rates?.[planContext.moveBudget?.mode ?? "full"],
                null);
        const remainingMove = spentMove > 0 && totalMoveBudget !== null
            ? Math.max(0, totalMoveBudget - spentMove)
            : null;
        const _withinRemaining = move => move?.stay === true
            || !Number.isFinite(move?.cost)
            || remainingMove === null
            || move.cost <= remainingMove + 1e-9;
        const actionBudget = Math.max(0,
            _finiteOr(context.actionBudget, ACTION_BUDGET_HALVES) - spentHalves);
        // Issue #37 weapon affinity/inertia inputs: `context` injections
        // win over the resolved config `preferredWeapon` and the
        // combatant `lastUsedWeapon` flag the executor wrote after the
        // previous successful attack.
        const preferredWeapon = context.preferredWeapon
            ?? config.preferredWeapon ?? null;
        const lastUsedWeapon = context.lastUsedWeapon
            ?? combatant?.getFlag?.(MODULE_ID, FLAG_KEYS.lastUsedWeapon)
            ?? combatant?.flags?.[MODULE_ID]?.[FLAG_KEYS.lastUsedWeapon]
            ?? null;
        const dodgeTN = _finiteOr(context.defaultDodgeTN, DEFAULT_DODGE_TN);
        // Issue #39: the combatant `lastAttacker` flag feeds the `grudge`
        // factor. It is deliberately kept out of the stale fingerprint —
        // a fresh hit must not force a replan. `context.lastAttacker`
        // injects the record in tests; `null` disables the factor.
        const lastAttackerRecord = context.lastAttacker !== undefined
            ? context.lastAttacker
            : (combatant?.getFlag?.(MODULE_ID, FLAG_KEYS.lastAttacker)
                ?? combatant?.flags?.[MODULE_ID]?.[FLAG_KEYS.lastAttacker]);
        const lastAttacker = _activeGrudge(lastAttackerRecord, combat);
        // Sticky-target memory: the combatant `lastTarget` flag the
        // executor wrote after the previous attack — valid while the
        // record is from this or the previous round, stale records read
        // as "no favourite" so a long-gone target never locks the bot.
        const lastTargetRecord = context.lastTarget !== undefined
            ? context.lastTarget
            : (combatant?.getFlag?.(MODULE_ID, FLAG_KEYS.lastTarget)
                ?? combatant?.flags?.[MODULE_ID]?.[FLAG_KEYS.lastTarget]);
        const lastTarget = lastTargetRecord && (lastTargetRecord.round == null
            || !Number.isFinite(combat?.round)
            || lastTargetRecord.round >= combat.round - 1)
            ? lastTargetRecord : null;
        // Issue #37 reaction slot: a bot that already spent its reaction
        // this round cannot bank another one — overwatch declarations
        // drop out of the candidate set.
        const selfReactionRecord = context.reactionUsed !== undefined
            ? context.reactionUsed
            : (combatant?.getFlag?.(MODULE_ID, FLAG_KEYS.reactionUsed)
                ?? combatant?.flags?.[MODULE_ID]?.[FLAG_KEYS.reactionUsed]);
        const selfReactionUsed = reactionUsed(selfReactionRecord, combat?.round);
        // Fallback approach points aim for the shortest usable range so a
        // melee-capable NPC keeps closing instead of stopping at gun range.
        const positiveRanges = usableActions
            .map(action => _actionRange(action))
            .filter(value => value > 0);
        const approachRange = positiveRanges.length ? Math.min(...positiveRanges) : 0;
        // The edge band is probed at the *farthest* weapon's reach —
        // `approachRange` is the shortest (a melee bot keeps closing), but
        // move-attack endpoints should exist for the longest-ranged gun.
        const bandRange = positiveRanges.length ? Math.max(...positiveRanges) : 0;
        const targetPosOf = target => ({ x: target?.x ?? null, y: target?.y ?? null });

        const candidates = [];
        let routesMissing = false;
        // L0 hard vetoes (issue #24): every candidate rejection is
        // absolute — no personality or morale layer may revive it, and
        // each is mirrored into the unified layer reason trace.
        const rejectL0 = (candidate, reason) => {
            diagnostics.rejected.push({ candidate, reason });
            recordLayerReason(diagnostics, "L0", reason, candidate);
        };
        // Dedup guard so a status veto logs one diagnostics entry per
        // candidate/reason instead of one per enumerated move.
        const rejectedOnce = new Set();
        const rejectOnce = (candidate, reason) => {
            const key = `${candidate}|${reason}`;
            if (rejectedOnce.has(key)) return;
            rejectedOnce.add(key);
            rejectL0(candidate, reason);
        };
        // Blast-awareness context: aim points are searched once per
        // action/target over this coverage set; friendlies always veto a
        // point, neutrals veto it unless `includeNeutral` marks them as
        // legitimate targets (hostage-execution scenes).
        const blastOptions = {
            includeNeutral: context.includeNeutral === true,
            dispositions: Array.isArray(context.dispositions) ? context.dispositions : null
        };
        const blastTokens = _blastTokens(context, combat, sceneId);
        const viewerDisposition = _finiteOr(
            _tokenDoc(combatant?.token)?.disposition ?? combatant?.disposition, 0);
        const pxPerUnit = _pxPerUnit(grid);
        // Issue #39: the same scene token scan backs two pure factor
        // inputs — hostiles engaged in melee with an ally
        // (`alliedEngagement`) and enemy contact reaches for the
        // free-attack factors (`leaveMeleeEngage`/`engageDenial`).
        const enemyContacts = _enemyContacts(targets, threats, pxPerUnit);
        const contactReachPx = new Map();
        for (const contact of enemyContacts) {
            if (contact.tokenUuid != null) contactReachPx.set(contact.tokenUuid, contact.reachPx);
        }
        const allyEngagedTargets = _allyEngagedTargets({
            tokens: blastTokens,
            viewerDisposition,
            selfTokenUuid: _tokenUuid(tokenDoc, sceneId)
                ?? tokenDoc?.uuid ?? tokenDoc?.id ?? null,
            reachPx: DEFAULT_MELEE_RANGE * (pxPerUnit > 0 ? pxPerUnit : 1),
            // Review: engagement reach is the pair's max — a spear-armed
            // ally or a long-limbed hostile engages a cell further.
            resolveReachPx: (target, ally) => {
                const hostile = contactReachPx.get(target.tokenUuid) ?? null;
                const friendly = _tokenMeleeReachPx(ally.tokenId, { combat, scene, pxPerUnit });
                const best = Math.max(hostile ?? 0, friendly ?? 0);
                return best > 0 ? best : null;
            },
            options: blastOptions
        });
        for (const target of targets.slice(0, _finiteOr(context.maxTargets, DEFAULT_MAX_TARGETS))) {
            const distance = _finiteOr(target.distance, Infinity);
            const moves = _resolveMoves({
                tokenDoc, target, range: approachRange, bandRange,
                selfPos, targetPos: targetPosOf(target),
                grid, navigation, perception, context: planContext
            }).filter(_withinRemaining);
            diagnostics.metrics.movesEvaluated += moves.length;

            let approachMove = null;
            for (const move of moves) {
                if (move.stay) continue;
                if (!approachMove || (_finiteOr(move.distance, Infinity)
                    < _finiteOr(approachMove.distance, Infinity))) {
                    approachMove = move;
                }
            }

            let attackFound = false;
            // Blast weapons may strike a last-known position (room
            // clearing) even when the remembered target is not attackable.
            // Issue #38: shared team contacts count as memory too.
            const memoryStrike = _isMemorySource(target.source)
                && usableActions.some(action => _actionBlastRadius(action) > 0
                    && !_isMeleeAction(action));
            if (target.canAttack !== true && !memoryStrike) {
                rejectL0(`attack|${target.tokenUuid}`, "target-not-attackable");
            } else if (!usableActions.length) {
                rejectL0(`attack|${target.tokenUuid}`, "no-action");
            } else {
                // One attack variant per legal action so presets can prefer
                // melee charge plans over a higher-damage ranged option.
                for (const action of usableActions) {
                    const tag = `${action.id}|${target.tokenUuid}`;
                    if (_actionCost(action) > actionBudget) {
                        rejectL0(`action|${tag}`, "over-budget");
                        continue;
                    }
                    // Cone weapons aim a direction, not a token — their
                    // candidates are generated once after the target loop.
                    if (_coneSpecOf(action)) continue;
                    const range = _actionRange(action);
                    const melee = _isMeleeAction(action);
                    // Blast weapons do not attack the target token itself:
                    // they aim at a point whose template covers hostiles
                    // and never friendlies (`blastTokens` scan). Aiming at
                    // a last-known memory position is allowed too — the
                    // LOS gate drops for remembered strikes.
                    if (_actionBlastRadius(action) > 0 && !melee) {
                        const presumed = _isMemorySource(target.source)
                            ? (target.tokenUuid ?? null) : null;
                        const aimInput = {
                            tokenDoc,
                            target,
                            rangePx: range * pxPerUnit,
                            radiusPx: _actionBlastRadius(action) * pxPerUnit,
                            tokens: blastTokens,
                            viewerDisposition,
                            options: blastOptions,
                            perception
                        };
                        const aim = _bestBlastAim({
                            ...aimInput,
                            origin: selfPos,
                            presumedUuid: presumed,
                            requireLos: presumed === null
                        });
                        if (aim) {
                            candidates.push({
                                target, action, move: null,
                                variant: "attack-in-place",
                                aim: aim.point,
                                blastHits: aim.hits
                            });
                            attackFound = true;
                            // Half aim (+10) + a half-cost blast throw
                            // fills the turn budget exactly. Skipped when
                            // a carried aimedUntil bonus already matches
                            // or beats the half-aim value, or when the
                            // remaining budget cannot pay both halves.
                            if (aimHalfAction && _actionCost(action) === 1
                                && 1 + 1 <= actionBudget
                                && _finiteOr(aimHalfAction.aim, 10) > _finiteOr(carriedAim, 0)) {
                                candidates.push({
                                    target, action, move: null,
                                    variant: "aim-attack",
                                    aim: aim.point,
                                    blastHits: aim.hits,
                                    aimBonus: aimHalfAction.aim
                                });
                            }
                        } else {
                            rejectOnce(`blast|${tag}`, presumed === null
                                ? "blast-no-safe-aim" : "blast-unclear-position");
                        }
                        if (!presumed && !isPinned) {
                            for (const move of moves) {
                                if (move.stay) continue;
                                // Issue #31: blast thrown after a move is
                                // a half move — beyond half rate it is a
                                // standalone relocation instead. Issue #33:
                                // the combo also needs a free half action.
                                if (_actionCost(action) + 1 > actionBudget
                                    || (halfMoveLimit !== null
                                        && Number.isFinite(move.cost)
                                        && move.cost > halfMoveLimit + 1e-9)) continue;
                                const aimFromMove = _bestBlastAim({
                                    ...aimInput,
                                    origin: { x: move.x, y: move.y },
                                    presumedUuid: null,
                                    requireLos: true
                                });
                                if (!aimFromMove) continue;
                                candidates.push({
                                    target, action, move,
                                    variant: "move-attack",
                                    aim: aimFromMove.point,
                                    blastHits: aimFromMove.hits
                                });
                                attackFound = true;
                            }
                        }
                        continue;
                    }
                    // The weapon's own `charge` attack type — when the
                    // system API exposes one — is the canonical action
                    // for move-into-reach candidates; sibling attack
                    // types of the same weapon defer to it instead of
                    // duplicating the charge variant.
                    const weaponKey = action.itemUuid ?? action.itemId
                        ?? action.name ?? action.id;
                    const chargePeer = action.attackType === "charge" ? null
                        : usableActions.find(other => other !== action
                            && other.attackType === "charge"
                            && (other.itemUuid ?? other.itemId ?? other.name ?? other.id)
                                === weaponKey);
                    // Status constraints: pinned and prone combatants
                    // cannot charge at all; a pinned combatant may still
                    // reposition while keeping or increasing the distance
                    // to the target.
                    const chargeVeto = isPinned ? "pinned" : (isProne ? "prone" : null);
                    let inPlace = false;
                    if (distance <= range + 1e-9) {
                        candidates.push({ target, action, move: null, variant: "attack-in-place" });
                        inPlace = true;
                        attackFound = true;
                        // Issue #15: aim.half (+10) + a half-cost attack
                        // consumes the whole two-half budget — only
                        // half-cost attack types qualify. Skipped when a
                        // carried aimedUntil bonus is already as good or
                        // the remaining budget cannot pay both halves.
                        if (aimHalfAction && _actionCost(action) === 1
                            && 1 + 1 <= actionBudget
                            && _finiteOr(aimHalfAction.aim, 10) > _finiteOr(carriedAim, 0)) {
                            candidates.push({
                                target, action, move: null,
                                variant: "aim-attack",
                                aimBonus: aimHalfAction.aim
                            });
                        }
                    } else {
                        rejectL0(`attack-in-place|${tag}`, "out-of-range");
                    }
                    let attackMoveFound = false;
                    // A charge exists to close distance вЂ” when a melee
                    // attack is already possible in place, repositioning
                    // move-attacks are only generated for ranged actions.
                    if (!melee || !inPlace) {
                        for (const move of moves) {
                            if (move.stay) continue;
                            if (!Number.isFinite(move.distance) || move.distance > range + 1e-9) continue;
                            // Moving into melee reach is a charge; any
                            // other move inside weapon range is move+attack.
                            const variant = melee ? "charge" : "move-attack";
                            // Issue #15 action budget: a full-cost action
                            // cannot follow a half move — move+full_auto
                            // or move+allOut are illegal. The `charge`
                            // attack type is the exception: its full
                            // action already includes the move.
                            if (_actionCost(action) >= 2
                                && action.attackType !== "charge") {
                                rejectOnce(`${variant}|${tag}`, "full-after-move");
                                continue;
                            }
                            // Issue #31: a move bundled with a half-cost
                            // attack is a half move — endpoints beyond
                            // the half-move rate belong to standalone
                            // approach/full-move candidates instead.
                            // Issue #33: the combo also needs a free half
                            // action on top of the attack's own cost.
                            if (variant === "move-attack") {
                                if (_actionCost(action) + 1 > actionBudget) {
                                    rejectOnce(`${variant}|${tag}`, "over-budget");
                                    continue;
                                }
                                if (halfMoveLimit !== null
                                    && Number.isFinite(move.cost)
                                    && move.cost > halfMoveLimit + 1e-9) {
                                    rejectOnce(`${variant}|${tag}`, "beyond-half-move");
                                    continue;
                                }
                            }
                            // Pinned/prone veto charges outright; a
                            // sibling `charge` attack type owns the
                            // variant so other types skip it (dedup, not
                            // a rejection).
                            if (variant === "charge" && chargeVeto) {
                                rejectOnce(`charge|${tag}`, chargeVeto);
                                continue;
                            }
                            if (variant === "charge" && chargePeer) continue;
                            // Pinned: a move-attack that ends closer to
                            // the target is vetoed; distance-keeping
                            // moves stay legal.
                            if (variant === "move-attack" && isPinned
                                && move.distance < distance) {
                                rejectOnce(`move-attack|${tag}`, "pinned");
                                continue;
                            }
                            candidates.push({ target, action, move, variant });
                            attackMoveFound = true;
                            attackFound = true;
                        }
                    }
                    if (!inPlace && !attackMoveFound) {
                        rejectL0(`${melee ? "charge" : "move-attack"}|${tag}`,
                            moves.some(move => !move.stay) ? "out-of-range" : "no-route");
                    }
                }
            }

            // A closing approach is a relocation that ends nearer the
            // target — pinned combatants may only move while keeping or
            // increasing the distance, exactly like move-attack.
            const approachVetoed = approachMove !== null && isPinned
                && Number.isFinite(approachMove.distance)
                && approachMove.distance < distance;
            // Issue #33: a standalone move still costs an action — a
            // full move needs both halves, a ≤half move needs one.
            const approachHalves = approachMove
                ? (halfMoveLimit !== null
                    && _finiteOr(approachMove.cost, 0) > halfMoveLimit ? 2 : 1)
                : 0;
            if (approachMove && !approachVetoed && approachHalves <= actionBudget) {
                candidates.push({ target, action: null, move: approachMove, variant: "approach" });
            } else if (approachVetoed) {
                rejectL0(`approach|${target.tokenUuid}`, "pinned");
            } else if (!attackFound) {
                routesMissing = true;
                rejectL0(`approach|${target.tokenUuid}`, "no-route");
            }
        }

        // Directed-cone weapons (spray, suppressing fire) cover a sector
        // rather than a token: `_bestConeAim` sweeps firing directions for
        // maximum hostile coverage under a strict friendly/neutral veto.
        // One attack-in-place candidate per template action; spray may
        // also reposition — suppression is a sustained area attack and
        // never combines with movement.
        // Issue #30: cone orientation anchors are only perceived contacts —
        // visible targets aim their live position, last-known contacts the
        // remembered point. Hostiles present on the scene but unknown to
        // the bot (no LOS, no memory) never steer the template; the
        // friendly/neutral veto still scans every scene token for safety.
        const coneAnchors = targets
            .filter(target => target?.hidden !== true
                && Number.isFinite(target?.x) && Number.isFinite(target?.y))
            .map(target => ({
                tokenUuid: target.tokenUuid ?? null,
                tokenId: target.tokenId ?? null,
                x: target.x,
                y: target.y,
                elevation: target.elevation ?? null,
                source: target.source ?? null
            }));
        for (const action of usableActions) {
            const spec = _coneSpecOf(action);
            if (!spec) continue;
            const range = _actionRange(action);
            const aimInput = {
                tokenDoc,
                rangePx: range * pxPerUnit,
                angleDeg: spec.angle,
                tokens: blastTokens,
                anchors: coneAnchors,
                viewerDisposition,
                options: blastOptions,
                perception
            };
            const aim = _bestConeAim({ ...aimInput, origin: selfPos });
            if (!aim) {
                rejectL0(`cone|${action.id}`, "cone-no-safe-aim");
                continue;
            }
            const coneTarget = _coneTargetOf(aim, targets, selfPos, grid);
            candidates.push({
                target: coneTarget, action, move: null,
                variant: "attack-in-place",
                cone: { ...aim, spec }
            });
            if (!spec.spray || isPinned) continue;
            // Spray move-attack: aim is recomputed from each route
            // endpoint so a repositioned cone still clears all friendlies.
            const coneMoves = _resolveMoves({
                tokenDoc, target: coneTarget, range,
                selfPos, targetPos: { x: coneTarget?.x ?? null, y: coneTarget?.y ?? null },
                grid, navigation, perception, context: planContext
            }).filter(_withinRemaining);
            diagnostics.metrics.movesEvaluated += coneMoves.length;
            for (const move of coneMoves) {
                if (move.stay) continue;
                // Issue #31: spray + reposition is a half move combo.
                // Issue #33: it also needs a free half action.
                if (_actionCost(action) + 1 > actionBudget
                    || (halfMoveLimit !== null
                        && Number.isFinite(move.cost)
                        && move.cost > halfMoveLimit + 1e-9)) continue;
                const aimFromMove = _bestConeAim({
                    ...aimInput,
                    origin: { x: move.x, y: move.y }
                });
                if (!aimFromMove) continue;
                candidates.push({
                    target: coneTarget, action, move,
                    variant: "move-attack",
                    cone: { ...aimFromMove, spec }
                });
            }
        }

        // ---- Issue #15 action-economy candidates ----------------------

        // Full aim (+20 on the next attack): a full action whose bonus
        // persists on the combatant `aim` flag until the shot is taken
        // (aimedUntil). Worth planning when no shot is available now or
        // the preset explicitly prefers it.
        const threatTarget = _nearestThreat(targets, selfPos, grid);
        // Standalone aim only makes sense for a ranged loadout facing a
        // live contact — for last-known memories a search move or an
        // overwatch declaration is the meaningful turn instead.
        const hasRangedAction = usableActions.some(action => action.type === "attack"
            && !_isMeleeAction(action) && _actionRange(action) > 0);
        if (!isPinned && aimFullAction && threatTarget?.canAttack === true
            && hasRangedAction
            && _actionCost(aimFullAction) <= actionBudget
            && _finiteOr(aimFullAction.aim, 20) > _finiteOr(carriedAim, 0)) {
            candidates.push({
                variant: "aim",
                action: aimFullAction,
                aimBonus: aimFullAction.aim ?? 20,
                target: threatTarget,
                move: null
            });
        }

        // Reload candidates for clip-fed weapons (`kind:"reload"` entries
        // from the system `actions.list`). A half-cost reload may follow
        // a half move (half+half budget); a full-cost reload stands alone.
        if (reloadActions.length) {
            let auxMoves = null;
            for (const reload of reloadActions) {
                const halves = _actionCost(reload);
                if (halves > actionBudget) {
                    rejectL0(`reload|${reload.id}`, "over-budget");
                    continue;
                }
                candidates.push({
                    variant: "reload",
                    action: reload,
                    target: threatTarget,
                    move: null
                });
                if (halves > 1 || isPinned) continue;
                if (auxMoves === null) {
                    auxMoves = threatTarget
                        ? _resolveMoves({
                            tokenDoc, target: threatTarget, range: approachRange,
                            selfPos,
                            targetPos: { x: threatTarget.x, y: threatTarget.y },
                            grid, navigation, perception, context: planContext
                        }).filter(_withinRemaining)
                        : [];
                }
                for (const move of auxMoves) {
                    if (move.stay) continue;
                    // Issue #31: reload bundled with a move is a half move.
                    // Issue #33: it also needs a free half action.
                    if (halves + 1 > actionBudget
                        || (halfMoveLimit !== null
                            && Number.isFinite(move.cost)
                            && move.cost > halfMoveLimit + 1e-9)) continue;
                    candidates.push({
                        variant: "move-reload",
                        action: reload,
                        target: threatTarget,
                        move
                    });
                }
            }
        }

        // Overwatch: declare a watch zone toward the nearest visible
        // threat. The step only registers the declaration — the reaction
        // shot itself stays under manual GM control (issue #14 service,
        // #15 candidate). Issue #30: only a live visible target is a
        // valid orientation anchor — for own-memory contacts a search
        // move or a spray/memory-strike is the documented turn, and a
        // hidden or entirely unknown position never steers a declaration.
        // Issue #54: the zone aims at predicted positions (route
        // waypoint, lead points, remembered contacts), not the square the
        // enemy already occupies; spray and blast weapons declare their
        // own geometry (template cone, trigger circle).
        // Issue #38 review merge: a `team-contact` shared by a living
        // teammate DOES gate the declaration — fresh squad intel, not the
        // bot's stale own memory (own `last-known` stays excluded).
        if (!isPinned) {
            const owWeapons = _overwatchWeapons(usableActions);
            const owGate = threatTarget
                && (threatTarget.canAttack === true
                    || threatTarget.source === "team-contact")
                && threatTarget.hidden !== true;
            // Anchors are computed once — only while an overwatch
            // candidate is actually built, and the route probe stays
            // limited to the single nearest threat (issue #54 bound).
            const owAnchors = owWeapons.length && owGate
                ? _overwatchAnchors({
                    targets, threatTarget, selfPos, pxPerUnit,
                    navigation, combat, scene, tokenDoc, perception
                })
                : [];
            for (const { action: owAction, kind } of owWeapons) {
                if (selfReactionUsed) {
                    // Issue #37: the reaction slot is spent — a
                    // declaration could never fire this round, so the
                    // zone is not offered.
                    rejectL0(`overwatch|${owAction.id}`, "reaction-used");
                    continue;
                }
                if (!owGate || ACTION_BUDGET_HALVES > actionBudget) continue;
                const zone = _overwatchZone({
                    kind, action: owAction, anchors: owAnchors,
                    threatTarget, selfPos, pxPerUnit, tokenDoc,
                    tokens: blastTokens, viewerDisposition,
                    options: blastOptions
                });
                if (!zone) continue;
                candidates.push({
                    variant: "overwatch",
                    action: owAction,
                    target: threatTarget,
                    move: null,
                    direction: zone.direction ?? null,
                    zone
                });
            }
        }

        // ---- Issue #37 free-action candidates -------------------------

        // `ready-weapon`: draw/equip an alternative weapon — the only
        // meaningful turn of a bot whose attack list is dry. Costs come
        // straight from the system entry (free under Quick Draw); the
        // inventory fallback synthesizes a half action.
        for (const ready of readyActions) {
            if (_actionCost(ready) > actionBudget) {
                rejectL0(`ready-weapon|${ready.id}`, "over-budget");
                continue;
            }
            candidates.push({
                variant: "ready-weapon",
                action: ready,
                target: threatTarget,
                move: null
            });
        }

        // `drop-prone`: a free-action cover answer — offered under fire
        // (pinned, or standing inside a real kill lane the threat map
        // reads ≥ DROP_PRONE_DANGER), never when already prone. Landing
        // prone engages the existing prone rules next turn (halved move
        // budget, no charge) instead of bypassing them.
        if (!isProne && threatTarget
            && (isPinned || (dangerAt && selfPos
                && _dangerAtSelf(dangerAt, selfPos) >= DROP_PRONE_DANGER))) {
            candidates.push({
                variant: "drop-prone",
                action: null,
                target: threatTarget,
                move: null
            });
        }

        // Issue #39 `unpin`: a pinned combatant may spend a full action
        // on the Willpower test that clears pinning — the recovery
        // alternative to the drop-prone cover answer. Actors without a
        // `willpower` characteristic never get the candidate; a pinned
        // bot that cannot even try logs `unpin-unavailable`.
        if (isPinned) {
            const unpin = _unpinAction(actor);
            if (!unpin) {
                rejectL0("unpin", "unpin-unavailable");
            } else if (_actionCost(unpin) > actionBudget) {
                rejectL0(`unpin|${unpin.id}`, "over-budget");
            } else {
                candidates.push({
                    variant: "unpin",
                    action: unpin,
                    target: threatTarget,
                    move: null
                });
            }
        }

        // Issue #38 orders: a fireteam leader may spend the turn giving an
        // order — a synthesized Command test carrying the order id/benefit
        // so the roll card records it (`flags.isOrder`). The fireteam
        // service supplies `context.team.orderCandidate`; a leader without
        // the Command skill is rejected `order-unavailable` upfront.
        const orderCandidate = context.team?.orderCandidate ?? null;
        if (orderCandidate) {
            const order = _orderAction(actor, orderCandidate);
            if (!order) {
                rejectL0(`order|${orderCandidate.orderId ?? "unknown"}`, "order-unavailable");
            } else if (_actionCost(order) > actionBudget) {
                rejectL0(`order|${order.orderId}`, "over-budget");
            } else {
                candidates.push({
                    variant: "order",
                    action: order,
                    target: threatTarget,
                    move: null
                });
            }
        }

        if (preset.alwaysOfferHold === true) {
            candidates.push({ variant: "hold", target: targets[0] ?? null, action: null, move: null });
        }
        if (!candidates.length && preset.allowNoTarget && !targets.length) {
            candidates.push({ variant: "hold", target: null, action: null, move: null });
        }
        if (!candidates.length && preset.allowNoAction && !usableActions.length) {
            candidates.push({ variant: "hold", target: targets[0] ?? null, action: null, move: null });
        }

        if (!candidates.length) {
            diagnostics.trace = buildLayerTrace(diagnostics);
            return {
                status: routesMissing ? PLANNER_STATUS.noRoute : PLANNER_STATUS.noAction,
                reason: routesMissing ? "no-route" : "no-valid-plan",
                plan: null,
                diagnostics
            };
        }

        // Preset hooks see the caller context enriched with the resolved
        // runtime facts вЂ” service lookups, scene, token and normalized
        // targets вЂ” so evaluators can run LOS/cover probes without their
        // own registry access. Caller-injected keys always win.
        const evalContext = {
            combat,
            combatant,
            scene,
            token: tokenDoc,
            selfPos,
            perception,
            navigation,
            resolvedTargets: targets,
            usableActions,
            // Issue #15: presets check `aimAvailable`/`aimActions` to
            // decide whether an aimed attack is an option this turn.
            // `aimAvailable` keeps its original meaning — the API lists
            // an explicit aim action — synthesized aim stays invisible.
            aimActions,
            aimAvailable: aimActions.some(action => action.synthesized !== true),
            // Issue #24 review: merged trait flags reach preset
            // evaluators (`context.traitFlags`) — behaviour flags like
            // `ignoreRegroup` are enforced structurally, not through
            // bounded deltas the task overlay would mask.
            traitFlags: personalityBehaviorFlags(personality.traits),
            ...planContext
        };
        const scored = [];
        candidates.forEach((candidate, index) => {
            const dodge = dodgeChanceOf(candidate.target, candidate.action, dodgeTN);
            const factors = _factorsOf({
                ...candidate, moveBudget, dangerAt, selfPos, dodge,
                preferredWeapon, lastUsedWeapon,
                traits: personality.traits, dodgeTN,
                allyEngagedTargets, enemies: enemyContacts, lastAttacker,
                lastTarget,
                // Issue #38: disciplined/elite squads and pressured morale
                // (graceful #26 hook) raise the leader's order utility.
                orderBoost: {
                    character: personality.character === "disciplined"
                        || personality.character === "elite",
                    pressured: _moraleOf(combatant, context).pressured
                }
            });
            // Presets may veto candidates outright (e.g. a ranged preset
            // refusing attacks without a resolved line of sight); vetoed
            // entries land in `rejected` diagnostics instead of ranking.
            if (typeof preset.veto === "function") {
                let vetoReason = null;
                try {
                    vetoReason = preset.veto({ factors, candidate, context: evalContext }) ?? null;
                } catch(err) {
                    vetoReason = null;
                }
                if (vetoReason) {
                    rejectL0(_candidateId(candidate, index),
                        typeof vetoReason === "string" ? vetoReason : "preset-veto");
                    return;
                }
            }
            let evaluation;
            if (typeof preset.evaluate === "function") {
                const custom = preset.evaluate({
                    factors, candidate, weights: effectiveWeights, context: evalContext
                });
                evaluation = Number.isFinite(custom)
                    ? { score: custom, breakdown: { factors, custom: true } }
                    : {
                        score: _finiteOr(custom?.score, 0),
                        breakdown: custom?.breakdown ?? { factors, custom: true }
                    };
            } else {
                evaluation = evaluateFactors(factors, effectiveWeights);
            }
            // Issue #19: seeded per-candidate jitter — a deterministic
            // multiplier keyed by the stable candidate id that lets
            // unsteady personalities pick off the argmax while identical
            // input + seed still reproduces the identical plan.
            const candidateId = _candidateId(candidate, index);
            const jitterFactor = personalityJitterFactor({
                seed, candidateId, amp: personalityAmp
            });
            const score = jitterFactor === 1
                ? evaluation.score
                : (Math.round(evaluation.score * jitterFactor * 1e6) / 1e6) + 0;
            scored.push({
                ...candidate,
                id: candidateId,
                factors,
                dodge,
                score,
                breakdown: jitterFactor !== 1
                    ? {
                        ...evaluation.breakdown,
                        jitter: {
                            amp: personalityAmp,
                            factor: Math.round(jitterFactor * 1e6) / 1e6
                        }
                    }
                    : evaluation.breakdown
            });
        });
        scored.sort((a, b) => (b.score - a.score) || String(a.id).localeCompare(String(b.id)));

        diagnostics.candidatesCount = scored.length;
        diagnostics.ranking = scored.map(entry => ({
            candidate: entry.id,
            score: entry.score
        }));
        recordLayerReason(diagnostics, "L4", "scored", {
            candidates: scored.length
        });

        if (!scored.length) {
            diagnostics.trace = buildLayerTrace(diagnostics);
            return {
                status: PLANNER_STATUS.noAction,
                reason: "no-valid-plan",
                plan: null,
                diagnostics
            };
        }

        // Issue #16 lookahead (2-ply, model-level): the top-K candidates
        // are re-scored by the expected counter damage of the strongest
        // responding enemy emitter —
        // `adjusted = score − λ × expectedCounterDamage`. No world
        // simulation: the counter model only reads the same snapshot data
        // (enemy emitters, distances, the sight probe) the threat map
        // uses, so the pass stays deterministic. Enabled on hard
        // difficulty or through `context.lookahead`.
        const lookahead = _lookaheadConfig(planContext, difficulty);
        // Issue #24: the L4 lookahead flag is the master gate — off
        // degrades to plain base-utility scoring even on hard difficulty
        // and even with a `context.lookahead` force-enable.
        if (layerFlags.lookahead === false && lookahead.enabled) {
            lookahead.enabled = false;
            recordLayerReason(diagnostics, "L4", "lookahead-layer-disabled");
        }
        let pickPool = scored;
        let scoreOf = entry => entry.score;
        if (lookahead.enabled) {
            recordLayerReason(diagnostics, "L4", "lookahead", {
                lambda: lookahead.lambda,
                topK: lookahead.topK
            });
            pickPool = _applyLookahead(scored, {
                threats, grid, los: losProbe,
                lambda: lookahead.lambda,
                topK: lookahead.topK,
                selfPos
            });
            scoreOf = entry => _finiteOr(entry.lookahead?.adjusted, entry.score);
            diagnostics.lookahead = {
                lambda: lookahead.lambda,
                topK: lookahead.topK,
                entries: pickPool.map(entry => ({
                    candidate: entry.id,
                    score: entry.score,
                    counterDamage: entry.lookahead.counterDamage,
                    adjusted: entry.lookahead.adjusted
                }))
            };
        }

        const topScore = scoreOf(pickPool[0]);
        const top = pickPool.filter(entry => scoreOf(entry) === topScore);
        let winner = top.length > 1 ? _seededPick(top, seed) : top[0];

        // Issue #16 difficulty: on easy the bot deliberately slips — with
        // `EASY_MISTAKE_CHANCE` probability the winner is a seeded pick
        // among the next-best candidates instead of the argmax. The slip
        // roll uses its own XOR-masked seed stream; identical seed
        // reproduces the identical plan.
        if (difficulty === "easy" && pickPool.length > 1) {
            const chance = _finiteOr(planContext.easyMistakeChance, EASY_MISTAKE_CHANCE);
            const mistake = mulberry32((seed ^ EASY_PICK_SEED_XOR) >>> 0)() < chance;
            diagnostics.easyPick = { chance, mistake };
            recordLayerReason(diagnostics, "L4", "easy-slip", { chance, mistake });
            if (mistake) {
                const rest = pickPool.filter(entry => entry !== winner)
                    .slice(0, EASY_PICK_TOP_K);
                if (rest.length) winner = _seededPick(rest, seed);
            }
        }
        if (winner.lookahead) {
            winner.breakdown = {
                ...winner.breakdown,
                lookahead: { ...winner.lookahead, lambda: lookahead.lambda }
            };
        }
        // Issue #37: the dodge verdict of the winning attack rides the
        // breakdown so the preview/diagnostics can explain the EV cut.
        if (winner.dodge) {
            winner.breakdown = { ...winner.breakdown, dodge: winner.dodge };
        }
        // Issue #27 explainability: the winner record carries the top-3
        // ranking, the runner-up score delta and the per-factor
        // contribution differences that decided the pick — the trace
        // renders "attack-in-place beats hold by +0.09 (attackNow +0.10,
        // exposure −0.03)" straight from this record. An easy-slip
        // winner may score below its runner-up — the margin stays
        // signed and shows it.
        const runnerUp = pickPool.find(entry => entry !== winner) ?? null;
        recordLayerReason(diagnostics, "L4", "winner", {
            candidate: winner.id ?? null,
            score: winner.score,
            top: pickPool.slice(0, 3).map(entry => ({
                candidate: entry.id ?? null,
                score: Math.round(scoreOf(entry) * 1e6) / 1e6
            })),
            runnerUp: runnerUp
                ? {
                    candidate: runnerUp.id ?? null,
                    score: Math.round(scoreOf(runnerUp) * 1e6) / 1e6
                }
                : null,
            margin: runnerUp
                ? Math.round((scoreOf(winner) - scoreOf(runnerUp)) * 1e6) / 1e6
                : null,
            factors: factorDelta(winner, runnerUp, effectiveWeights)
        });
        diagnostics.chosenStep = null;
        // AimedUntil (issue #15): the booked flag bonus rides into the
        // attack step — the executor clears the flag once the shot lands.
        const steps = _stepsFor({ candidate: winner, carriedAim, halfMoveLimit });
        diagnostics.chosenStep = steps.find(step => step.type !== "end-turn")?.id ?? steps[0].id;

        // Issue #25 L1: when the commitment layer is on, the scored plan
        // carries a serializable `commitment` payload — the same steps
        // plus the `expectedState` fingerprint (self endpoint, committed
        // target, morale tier, threat list). The executor persists it on
        // the combatant `committedPlan` flag after the turn; the next
        // planTurn then short-circuits while the expectation holds.
        // Reactive mode (interventions above the threshold) writes the
        // squeezed ttl=1 — the per-turn baseline during manual chaos.
        const commitmentPayload = layerFlags.commitment === true && steps.length
            ? {
                source: "planner",
                ttl: commitment.reactive === true
                    ? 1
                    : _finiteOr(context.commitmentTtl, COMMITMENT_TTL_ROUNDS),
                steps: _jsonClone(steps),
                expectedState: {
                    self: _committedSelfPosition(steps, selfPos, tokenDoc, scene),
                    target: winner.target
                        ? {
                            tokenId: winner.target.tokenId ?? null,
                            tokenUuid: winner.target.tokenUuid ?? null,
                            x: _finiteOr(winner.target.x, null),
                            y: _finiteOr(winner.target.y, null)
                        }
                        : null,
                    morale: moraleTierOf(moralePosture),
                    threats: _commitmentThreats(targets, winner.target)
                }
            }
            : null;

        const plan = _assemblePlan({
            combat, combatant, context, authority, seed, presetId,
            diagnostics, steps, winner, targets, personality,
            actions: usableActions, commitment: commitmentPayload
        });
        log(`plan ${plan.id} preset=${presetId} score=${winner.score} steps=${steps.length}`);
        return { status: PLANNER_STATUS.ok, plan, reason: null };
    }

    /**
     * Assemble the serialized plan: finalized snapshot (self, targets,
     * actions, chosen target), stale/revision fingerprints and the frozen
     * plan document shared by the normal scoring path and the stunned
     * short-circuit.
     * @param {object} input
     * @param {object} input.combat Combat document.
     * @param {object} input.combatant Active combatant document.
     * @param {object} input.context Planning context overrides.
     * @param {object|null} input.authority Authority service or null.
     * @param {number} input.seed Deterministic plan seed.
     * @param {string} input.presetId Resolved preset id.
     * @param {object} input.diagnostics Diagnostics record.
     * @param {object[]} input.steps Serialized plan steps.
     * @param {object} input.winner `{score, breakdown, target}` triple.
     * @param {object[]} input.targets Normalized targets for the snapshot.
     * @param {object[]} input.actions Usable actions for the snapshot.
     * @param {object|null} [input.personality] Issue #19 profile
     *   `{traits, character, source}` recorded on the plan.
     * @param {object|null} [input.commitment] Issue #25 persistence
     *   payload `{source, ttl, steps, expectedState}` the executor writes
     *   on the combatant `committedPlan` flag after the turn.
     * @returns {object} Frozen plan.
     */
    function _assemblePlan({ combat, combatant, context, authority, seed,
        presetId, diagnostics, steps, winner, targets, actions, personality = null,
        commitment = null }) {
        const tokenDoc = _tokenDoc(context.token ?? combatant?.token);
        const actor = _actorOf(combatant) ?? _actorOf(tokenDoc);
        const scene = _sceneOf(context, combat);
        const base = buildPlanSnapshot({ combat, combatant, context, authority });
        const snapshot = _jsonClone({
            ...base,
            self: { ...base.self },
            targets: targets.map(target => ({
                tokenId: target.tokenId,
                tokenUuid: target.tokenUuid,
                x: target.x,
                y: target.y,
                elevation: target.elevation,
                distance: target.distance,
                canAttack: target.canAttack,
                statuses: Array.isArray(target.statuses) ? [...target.statuses] : [],
                source: target.source
            })),
            actions: actions.map(action => ({
                id: action.id,
                type: action.type,
                name: action.name,
                itemUuid: action.itemUuid,
                range: _actionRange(action)
            })),
            target: winner.target
                ? {
                    tokenId: winner.target.tokenId,
                    tokenUuid: winner.target.tokenUuid,
                    x: winner.target.x,
                    y: winner.target.y,
                    elevation: winner.target.elevation,
                    statuses: Array.isArray(winner.target.statuses)
                        ? [...winner.target.statuses]
                        : []
                }
                : null,
            seed
        });
        // Rebuild stale/revision fingerprints over the finalized snapshot.
        const staleFingerprint = _staleFingerprint({
            combat,
            combatant,
            token: tokenDoc,
            actor,
            targetToken: snapshot.target ? _findToken(snapshot.target.tokenId, { combat, scene }) : null,
            collision: snapshot.scene.collisionRevision,
            selfStatuses: context.selfStatuses,
            snapshot
        });
        snapshot.staleFingerprint = staleFingerprint;
        snapshot.revision = `s${fnv1a(stableStringify({ ...snapshot, revision: null }))}`;

        const replanCount = _finiteOr(context.replanCount, 0);
        const planId = `plan-${fnv1a(`${snapshot.revision}|${presetId}|${seed}|${replanCount}`)}`;
        // Issue #27: materialize the per-layer trace entries — one
        // serializable `{layer, kind, ...}` entry per reason record —
        // so a serialized plan explains itself offline (preview block,
        // GM whisper, replay fixtures).
        diagnostics.trace = buildLayerTrace(diagnostics);
        return _deepFreeze({
            id: planId,
            operationId: context.operation?.id ?? context.operationId ?? null,
            actorUuid: snapshot.self.actorUuid,
            tokenUuid: snapshot.self.tokenUuid,
            preset: presetId,
            seed,
            replanCount,
            difficulty: _difficultyOf(context),
            // Issue #19: the resolved personality rides on the plan so the
            // GM preview and executor diagnostics can show it.
            personality: personality
                ? {
                    traits: [...personality.traits],
                    character: personality.character ?? null,
                    source: personality.source ?? "generated"
                }
                : null,
            score: winner.score,
            breakdown: winner.breakdown,
            target: snapshot.target,
            snapshot: _deepFreeze(snapshot),
            steps,
            // Issue #25: the L1 persistence payload the executor writes
            // on the `committedPlan` flag — null for commitment hits
            // (the existing record is refreshed, not rewritten) and
            // when the layer is off.
            commitment: commitment ? _jsonClone(commitment) : null,
            diagnostics,
            debug: { seed }
        });
    }

    /**
     * Projected end-of-turn self position for a committed plan
     * (issue #25): the document-space endpoint of the last move step
     * (the serialized `to` is a footprint centre — the token document
     * stores top-left, mirroring the executor's `_docPoint`), or the
     * live position when the plan keeps the bot in place.
     * @param {object[]} steps Serialized plan steps.
     * @param {{x: number|null, y: number|null}} selfPos Live position.
     * @param {object|null} tokenDoc Self token document.
     * @param {object|null} scene Scene for the grid size.
     * @returns {{x: number|null, y: number|null, elevation: number}}
     */
    function _committedSelfPosition(steps, selfPos, tokenDoc, scene) {
        const size = Number.isFinite(scene?.grid?.size) && scene.grid.size > 0
            ? scene.grid.size : 100;
        let last = null;
        for (const step of steps ?? []) {
            const to = step?.input?.to;
            if (step?.type === "move" && Number.isFinite(to?.x) && Number.isFinite(to?.y)) {
                last = to;
            }
        }
        if (!last) {
            return {
                x: selfPos?.x ?? null,
                y: selfPos?.y ?? null,
                elevation: _finiteOr(tokenDoc?.elevation, 0)
            };
        }
        const fw = _finiteOr(tokenDoc?.width, 1) * size;
        const fh = _finiteOr(tokenDoc?.height, 1) * size;
        return {
            x: last.x - (fw / 2),
            y: last.y - (fh / 2),
            elevation: Number.isFinite(last.elevation)
                ? last.elevation : _finiteOr(tokenDoc?.elevation, 0)
        };
    }

    /**
     * Compact threat fingerprint of a committed plan's expectedState
     * (issue #25): `{tokenId, x, y}` of every evaluated target, the
     * committed target deduped in, bounded at
     * {@link COMMITMENT_THREAT_MAX}. Validation re-resolves the same ids
     * and counts drifts beyond one grid cell.
     * @param {object[]} targets Normalized snapshot targets.
     * @param {object|null} winnerTarget Chosen target.
     * @returns {object[]}
     */
    function _commitmentThreats(targets, winnerTarget) {
        const seen = new Set();
        const list = [];
        const push = entry => {
            const id = entry?.tokenId ?? entry?.tokenUuid ?? null;
            if (!id || seen.has(id)) return;
            if (!Number.isFinite(entry.x) || !Number.isFinite(entry.y)) return;
            seen.add(id);
            list.push({ tokenId: id, x: entry.x, y: entry.y });
        };
        push(winnerTarget);
        for (const target of targets ?? []) {
            if (list.length >= COMMITMENT_THREAT_MAX) break;
            push(target);
        }
        return list;
    }

    /**
     * Stable candidate id for diagnostics.
     * @param {object} candidate
     * @param {number} index
     * @returns {string}
     */
    function _candidateId(candidate, index) {
        const targetKey = candidate.target?.tokenId ?? candidate.target?.tokenUuid ?? "none";
        const moveKey = candidate.move?.key ?? "stay";
        const actionKey = candidate.action?.id ?? "none";
        return `${candidate.variant}|${targetKey}|${moveKey}|${actionKey}|${index}`;
    }

    /**
     * Validate a plan's snapshot against live state. Called by the
     * executor immediately before every state-changing step. The cheap
     * stale fingerprint is compared first вЂ” an equal fingerprint returns
     * `valid` without running any detailed checks.
     * @param {object} plan Serialized plan with `snapshot`.
     * @param {object} [currentContext] Live overrides: `combat`,
     *   `combatant`, `token`, `target`, `scene`, `collisionRevision`.
     * @returns {{valid: boolean, reason: string|null}}
     */
    function validateSnapshot(plan, currentContext = {}) {
        const snapshot = plan?.snapshot;
        if (!snapshot || typeof snapshot !== "object") {
            return { valid: false, reason: STALE_REASONS.invalidPlan };
        }
        const combat = currentContext.combat ?? _findCombat(snapshot.combatId);
        if (!combat || combat.id !== snapshot.combatId || combat.ended === true) {
            return { valid: false, reason: STALE_REASONS.combatEnded };
        }
        const combatant = currentContext.combatant !== undefined
            ? currentContext.combatant
            : _findCombatant(combat, snapshot.combatantId);
        const tokenDoc = currentContext.token !== undefined
            ? currentContext.token
            : _tokenDoc(combatant?.token);
        const actor = _actorOf(combatant) ?? _actorOf(tokenDoc);
        const scene = _sceneOf(currentContext, combat);
        const collision = currentContext.collisionRevision !== undefined
            ? currentContext.collisionRevision
            : _collisionRevision(scene);
        const targetToken = "target" in currentContext
            ? currentContext.target
            : (snapshot.target ? _findToken(snapshot.target.tokenId, { combat, scene }) : null);

        // Fast path: the fingerprint covers every field the checks below
        // inspect, so an equal fingerprint means the plan is still valid.
        const live = _staleFingerprint({
            combat, combatant, token: tokenDoc, actor, targetToken, collision,
            selfStatuses: currentContext.selfStatuses, snapshot
        });
        if (live === snapshot.staleFingerprint) {
            return { valid: true, reason: null };
        }

        // Turn index stays null until the first advance; snapshots
        // normalize both fields to 0, so the comparison must too.
        if (_finiteOr(combat.round, 0) !== _finiteOr(snapshot.round, 0)
            || _finiteOr(combat.turn, 0) !== _finiteOr(snapshot.turn, 0)) {
            return { valid: false, reason: STALE_REASONS.turnStale };
        }
        const position = _tokenPosition(tokenDoc);
        const self = snapshot.self ?? {};
        if (!tokenDoc || tokenDoc.destroyed === true
            || tokenDoc.id !== self.tokenId
            || position.x !== self.x || position.y !== self.y
            || _finiteOr(tokenDoc.elevation, 0) !== _finiteOr(self.elevation, 0)
            || (tokenDoc.hidden === true) !== (self.hidden === true)
            || (combatant?.defeated === true) !== (self.defeated === true)) {
            return { valid: false, reason: STALE_REASONS.tokenMoved };
        }
        if (snapshot.target) {
            const targetCombatant = _findCombatantByToken(combat, snapshot.target.tokenId);
            // Perception stores token centres, injected targets may carry
            // top-left positions вЂ” accept either coordinate basis so a
            // standing target does not look "moved".
            const targetPos = _tokenPosition(targetToken);
            const targetDoc = _tokenDoc(targetToken);
            const gridSize = snapshot.scene?.grid?.size ?? scene?.grid?.size ?? 100;
            const halfW = (_finiteOr(targetDoc?.width, 1) * gridSize) / 2;
            const halfH = (_finiteOr(targetDoc?.height, 1) * gridSize) / 2;
            const unmoved = [
                { x: targetPos.x, y: targetPos.y },
                { x: targetPos.x + halfW, y: targetPos.y + halfH }
            ].some(point => point.x === snapshot.target.x
                && point.y === snapshot.target.y);
            if (!_targetAlive(targetToken, targetCombatant) || !unmoved) {
                return { valid: false, reason: STALE_REASONS.targetGone };
            }
        }
        if (_resourcesFingerprint(actor) !== self.resourcesHash) {
            return { valid: false, reason: STALE_REASONS.resourcesChanged };
        }
        // Self statuses (pinned/prone/stunned/…) gate which candidates are
        // legal, so any drift invalidates the plan with its own reason.
        const liveStatuses = _selfStatuses(actor, tokenDoc, currentContext.selfStatuses);
        const plannedStatuses = Array.isArray(self.statuses) ? self.statuses : [];
        if (liveStatuses.join("|") !== plannedStatuses.join("|")) {
            return { valid: false, reason: STALE_REASONS.statusesChanged };
        }
        if ((collision ?? null) !== (snapshot.scene?.collisionRevision ?? null)) {
            return { valid: false, reason: STALE_REASONS.collisionChanged };
        }
        // Fingerprint covered a field no check owns вЂ” defensive fallback.
        return { valid: false, reason: STALE_REASONS.stale };
    }

    /**
     * Combat lookup for validation: injected first, then the world.
     * @param {string|null} combatId
     * @returns {object|null}
     */
    function _findCombat(combatId) {
        const collection = globalThis.game?.combats;
        if (collection && combatId) {
            if (typeof collection.get === "function") {
                const hit = collection.get(combatId);
                if (hit) return hit;
            }
            for (const entry of _list(collection)) {
                if (entry?.id === combatId) return entry;
            }
        }
        const active = globalThis.game?.combat;
        return active?.id === combatId ? active : null;
    }

    /**
     * Replan policy hook consulted by the executor after a failed or stale
     * step. At most `maxReplans` replans are granted per turn; afterwards
     * the AI holds and reports a diagnostic reason for the GM.
     * @param {object|string} failure `{reason, plan?, replanCount?,
     *   maxReplans?}` or a bare reason string.
     * @returns {object} `{replan, action, reason, originalReason,
     *   replanCount, report}` вЂ” `action` is `"replan"` or
     *   `"hold-and-report"`.
     */
    function shouldReplan(failure = {}) {
        const input = typeof failure === "string" ? { reason: failure } : (failure ?? {});
        const reason = input.reason ?? null;
        const plan = input.plan ?? null;
        const used = Number.isFinite(input.replanCount)
            ? input.replanCount
            : _finiteOr(plan?.replanCount, 0);
        const limit = Number.isFinite(input.maxReplans) ? input.maxReplans : maxReplans;
        const replannable = REPLAN_REASONS.has(reason);
        const report = {
            planId: plan?.id ?? null,
            reason,
            replanCount: used,
            maxReplans: limit
        };
        if (replannable && used < limit) {
            return _deepFreeze({
                replan: true,
                action: REPLAN_ACTIONS.replan,
                reason,
                originalReason: reason,
                replanCount: used + 1,
                report
            });
        }
        const holdReason = replannable
            ? "replan-limit-exceeded"
            : (reason ?? "unknown-failure");
        return _deepFreeze({
            replan: false,
            action: REPLAN_ACTIONS.holdAndReport,
            reason: holdReason,
            originalReason: reason,
            replanCount: used,
            report
        });
    }

    /**
     * Register or replace a preset definition. `weights` merge over the
     * defaults; `evaluate(context)` may return a score number or
     * `{score, breakdown}`; `veto({factors, candidate, context})` may
     * return a reason string to exclude a candidate from ranking.
     * @param {string} id Preset id.
     * @param {object} def `{weights?, evaluate?, veto?, allowNoTarget?, allowNoAction?}`.
     * @returns {object} The stored preset.
     */
    function registerPreset(id, def = {}) {
        if (typeof id !== "string" || id.trim() === "") {
            throw new Error("[only-war-ai] Preset id must be a non-empty string");
        }
        if (!def || typeof def !== "object") {
            throw new Error(`[only-war-ai] Preset "${id}" requires a definition object`);
        }
        const stored = {
            id,
            weights: { ...DEFAULT_PRESET_WEIGHTS, ...(def.weights ?? {}) },
            evaluate: typeof def.evaluate === "function" ? def.evaluate : null,
            veto: typeof def.veto === "function" ? def.veto : null,
            allowNoTarget: def.allowNoTarget === true,
            allowNoAction: def.allowNoAction === true,
            alwaysOfferHold: def.alwaysOfferHold === true
        };
        presets.set(id, stored);
        return stored;
    }

    /**
     * Look up a registered preset definition.
     * @param {string} id
     * @returns {object|null}
     */
    function getPreset(id) {
        return presets.get(id) ?? null;
    }

    /**
     * Registered preset ids in registration order.
     * @returns {string[]}
     */
    function listPresets() {
        return [...presets.keys()];
    }

    return {
        planTurn,
        validateSnapshot,
        shouldReplan,
        registerPreset,
        getPreset,
        listPresets,
        buildPlanSnapshot,
        statuses: PLANNER_STATUS,
        staleReasons: STALE_REASONS,
        stepTypes: STEP_TYPES,
        get maxReplans() {
            return maxReplans;
        }
    };
}
