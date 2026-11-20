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
import { FALLBACK_PRESET } from "./constants.js";
import { resolveEffectiveConfig } from "./config-resolver.js";
import { logDiagnostics } from "./settings.js";

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
export const STEP_TYPES = Object.freeze(["move", "attack", "test", "end-turn"]);

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
    "meleeEngage"
]);

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
    meleeEngage: 0
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
            advance: 0.5
        })
    }),
    hold: Object.freeze({
        weights: Object.freeze({
            ...DEFAULT_PRESET_WEIGHTS,
            attackAfterMove: 4,
            holdPosition: 4,
            threat: 1,
            proximity: 0.5,
            advance: -1
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
            lastKnown: 1
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
    called_shot: 0.4
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
    "called_shot"
]);

/**
 * Attack types never kept as candidates: `suppressing_fire` needs a
 * targetPoint/template the plan-step contract cannot express yet.
 */
const EXCLUDED_ATTACK_TYPES = Object.freeze(new Set(["suppressing_fire"]));

/** Status ids that mark a target as vulnerable to attack. */
const VULNERABLE_STATUSES = Object.freeze(new Set(["pinned", "prone", "stunned"]));

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
            return {
                id: item.id ?? null,
                uuid: typeof item.uuid === "string" ? item.uuid : null,
                name: item.name ?? null,
                type: item.type ?? null,
                class: system.class ?? null,
                range: Number.isFinite(system.range) ? system.range
                    : (Number.isFinite(system.range?.value) ? system.range.value : null),
                ammo: Number.isFinite(clip) ? clip : null
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
 * Action-economy cost of an action candidate: a bare number, an object
 * with an `actions` field, or the default single action.
 * @param {object|null} action Normalized action candidate.
 * @returns {number}
 */
function _actionCost(action) {
    const cost = action?.cost;
    if (Number.isFinite(cost)) return cost;
    if (cost && typeof cost === "object") return _finiteOr(cost.actions, 1);
    return 1;
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
 * Neutral tokens fight no one.
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function _hostileTo(a, b) {
    const sa = Math.sign(_finiteOr(a, 0));
    const sb = Math.sign(_finiteOr(b, 0));
    return sa !== 0 && sb !== 0 && sa !== sb;
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
        x,
        y,
        elevation: _finiteOr(raw.elevation, 0),
        distance,
        threat: _finiteOr(raw.threat, 0),
        canAttack: source === "last-known" ? false : raw.canAttack !== false,
        hidden: raw.hidden === true,
        statuses: _statusIds(raw.statuses),
        source
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
        if (!_hostileTo(selfDisposition, doc.disposition)) continue;
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
 * @returns {object[]}
 */
function _resolveTargets({ combat, combatant, tokenDoc, selfPos, sceneId, grid, perception, context }) {
    const measure = raw => {
        const doc = _tokenDoc(raw) ?? raw;
        if (typeof perception?.measureDistance === "function" && doc) {
            const dist = perception.measureDistance(tokenDoc, doc);
            if (Number.isFinite(dist)) return dist;
        }
        return null;
    };
    const input = { source: "fallback", sceneId, selfPos, grid, measure };
    let targets = [];
    if (Array.isArray(context.targets)) {
        targets = context.targets
            .map(raw => _normalizeTarget(raw, { ...input, source: raw?.source ?? "injected" }))
            .filter(Boolean);
    } else if (perception && typeof perception.buildPerceptionSnapshot === "function") {
        let snapshot = null;
        try {
            snapshot = perception.buildPerceptionSnapshot({ combat, combatant, token: tokenDoc });
        } catch(err) {
            snapshot = null;
        }
        if (snapshot && snapshot.status !== "perception-unavailable") {
            const visible = (snapshot.visibleTargets ?? [])
                .map(raw => _normalizeTarget(raw, { ...input, source: "visible" }));
            const remembered = (snapshot.lastKnownTargets ?? [])
                .map(raw => _normalizeTarget(raw, { ...input, source: "last-known" }));
            targets = visible.concat(remembered).filter(Boolean);
        }
    }
    if (!targets.length && !Array.isArray(context.targets)) {
        targets = _fallbackTargets(combat, combatant, input);
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
 * Normalize one raw action entry to the action-candidate shape.
 * @param {object} raw
 * @param {number} index Fallback id index.
 * @returns {object|null}
 */
function _normalizeAction(raw, index) {
    if (!raw || typeof raw !== "object") return null;
    if (raw.available === false) return null;
    const kind = raw.kind ?? raw.type ?? null;
    const attackLike = kind === "attack" || raw.attack === true || raw.itemUuid != null
        || raw.weapon != null || raw.weaponId != null || raw.attackType != null;
    let type;
    if (attackLike) type = "attack";
    else if (kind === "test" || kind === null || raw.test === true) type = "test";
    else return null; // Movement/aim/etc are not attack/test candidates.
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
        damage: _expectedDamage(raw.damage ?? raw.system?.damage ?? 0),
        cost: typeof raw.cost === "string"
            ? { actions: raw.cost === "free" ? 0 : 1 }
            : (raw.cost ?? null)
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
        .slice(0, MAX_ATTACK_TYPES_PER_WEAPON)
        .map(entry => entry.action);
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
 * @param {object} input.selfPos Self position `{x, y}` in pixels.
 * @param {object} input.targetPos Target position `{x, y}` in pixels.
 * @param {object} input.grid Normalized grid info.
 * @param {object|null} input.navigation Navigation service or null.
 * @param {object|null} input.perception Perception service or null.
 * @param {object} input.context Planning context overrides.
 * @returns {object[]}
 */
function _resolveMoves({ tokenDoc, target, range, selfPos, targetPos, grid, navigation, perception, context }) {
    const input = { selfPos, targetPos, grid };
    let raw = null;
    if (Array.isArray(context.moves)) {
        raw = context.moves;
    } else if (navigation && typeof navigation.findCandidates === "function") {
        try {
            const result = navigation.findCandidates(tokenDoc,
                context.moveBudget ?? { mode: "full" },
                {
                    target: targetPos,
                    count: _finiteOr(context.moveCandidateCount, DEFAULT_MOVE_CANDIDATES),
                    includeCover: true,
                    perception,
                    rates: context.rates
                });
            if (result && result.status === "ok" && Array.isArray(result.candidates)) {
                raw = result.candidates;
            } else {
                raw = [];
            }
        } catch(err) {
            raw = [];
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
 * @returns {object}
 */
function _factorsOf({ variant, target, move, action, moveBudget = null }) {
    const targetDistance = _finiteOr(target?.distance, null);
    const postDistance = _finiteOr(move?.distance, targetDistance);
    const canAttack = target?.canAttack === true;
    const attackNow = variant === "attack-in-place" && canAttack ? 1 : 0;
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
    const holdPosition = variant === "hold" || variant === "attack-in-place" || move?.stay === true ? 1 : 0;
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
    const vulnerable = (target?.statuses ?? [])
        .some(status => VULNERABLE_STATUSES.has(status)) ? 1 : 0;
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
        lastKnown: target?.source === "last-known" ? 1 : 0,
        budgetOver,
        attackType: action
            ? (ATTACK_TYPE_DESIRE[action.attackType] ?? ATTACK_TYPE_DESIRE_DEFAULT)
            : 0,
        vulnerable,
        engaged,
        meleeEngage: melee * engaged
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

/** Candidate variants that produce an attack/test step. */
const ATTACK_VARIANTS = Object.freeze(new Set(["attack-in-place", "move-attack", "charge"]));

/**
 * Serialize a plan candidate variant into executable action steps.
 * @param {object} input Step input.
 * @param {object} input.candidate Winning scored candidate.
 * @returns {object[]}
 */
function _stepsFor({ candidate }) {
    const steps = [];
    const { target, move, action, variant } = candidate;
    if (move && !move.stay) {
        steps.push({
            id: `step-move-${steps.length + 1}`,
            type: "move",
            cost: { movement: _finiteOr(move.cost, 0) },
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
            cost: { actions: 1 },
            input: {
                actionId: action.id,
                name: action.name,
                itemUuid: action.itemUuid,
                targetTokenUuid: target.tokenUuid,
                targetTokenId: target.tokenId,
                range: _actionRange(action),
                ...(action.attackType ? { attackType: action.attackType } : {}),
                ...(variant === "charge" ? { mode: "charge" } : {})
            },
            preconditions: ["turn", "target", "resources"],
            projectedResourceDelta: action.type === "attack" ? { ammo: -1 } : {}
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
     *   `approximateMoves`, `selfStatuses`.
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
        const diagnostics = {
            seed,
            weights: { ...preset.weights },
            preset: presetId,
            candidatesCount: 0,
            rejected: [],
            ranking: [],
            chosenStep: null,
            metrics: { targetsEvaluated: 0, movesEvaluated: 0 }
        };

        const tokenDoc = _tokenDoc(context.token ?? combatant?.token);
        const actor = _actorOf(combatant) ?? _actorOf(tokenDoc);
        const scene = _sceneOf(context, combat);
        const sceneId = scene?.id ?? null;
        const grid = _gridInfo(scene);
        // Gridless scenes are rejected before planning: movement
        // candidates and route scoring need a square/hex grid (issue
        // #410). Navigation answers `gridless-unsupported` the same way.
        if (grid.type === 0) {
            return {
                status: PLANNER_STATUS.unsupported,
                reason: "gridless-unsupported",
                plan: null,
                diagnostics
            };
        }
        const selfPos = _tokenPosition(tokenDoc);
        // Self status constraints (issue #413): deterministic rules read
        // from actor/token statuses merged with the injected
        // `context.selfStatuses` fixture array.
        // - `stunned`: OW combatants take no actions — short-circuit to an
        //   ok plan whose only step is `end-turn` stamped `stunned`.
        // - `pinned`: no charge and no move that ends closer to the
        //   target; attack-in-place and distance-keeping moves stay legal.
        // - `prone`: the movement budget halves (floor; crawl) and charge
        //   is vetoed.
        const selfStatuses = _selfStatuses(actor, tokenDoc, context.selfStatuses);
        diagnostics.selfStatuses = selfStatuses;
        if (selfStatuses.includes("stunned")) {
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
                diagnostics, steps,
                winner: { score: 0, breakdown: { reason: "stunned" }, target: null },
                targets: [],
                actions: []
            });
            log(`plan ${plan.id} preset=${presetId} stunned hold`);
            return { status: PLANNER_STATUS.ok, plan, reason: null };
        }
        const isPinned = selfStatuses.includes("pinned");
        const isProne = selfStatuses.includes("prone");
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
        if (navigation && context.rates == null
            && typeof navigation.getMovementRates === "function") {
            try { await navigation.getMovementRates(tokenDoc); } catch(_err) {
                // Rates stay unresolved; findCandidates degrades to stay.
            }
        }

        const targets = _resolveTargets({
            combat, combatant, tokenDoc, selfPos, sceneId, grid, perception, context
        });
        diagnostics.metrics.targetsEvaluated = targets.length;
        if (!targets.length && !preset.allowNoTarget) {
            return {
                status: PLANNER_STATUS.noTarget,
                reason: "no-target",
                plan: null,
                diagnostics
            };
        }

        const actions = await _resolveActions(actor, context);
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
        if (!usableActions.length && !preset.allowNoAction && targets.length) {
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
        const actionBudget = _finiteOr(context.actionBudget, 1);
        // Fallback approach points aim for the shortest usable range so a
        // melee-capable NPC keeps closing instead of stopping at gun range.
        const positiveRanges = usableActions
            .map(action => _actionRange(action))
            .filter(value => value > 0);
        const approachRange = positiveRanges.length ? Math.min(...positiveRanges) : 0;
        const targetPosOf = target => ({ x: target?.x ?? null, y: target?.y ?? null });

        const candidates = [];
        let routesMissing = false;
        // Dedup guard so a status veto logs one diagnostics entry per
        // candidate/reason instead of one per enumerated move.
        const rejectedOnce = new Set();
        const rejectOnce = (candidate, reason) => {
            const key = `${candidate}|${reason}`;
            if (rejectedOnce.has(key)) return;
            rejectedOnce.add(key);
            diagnostics.rejected.push({ candidate, reason });
        };
        for (const target of targets.slice(0, _finiteOr(context.maxTargets, DEFAULT_MAX_TARGETS))) {
            const distance = _finiteOr(target.distance, Infinity);
            const moves = _resolveMoves({
                tokenDoc, target, range: approachRange,
                selfPos, targetPos: targetPosOf(target),
                grid, navigation, perception, context: planContext
            });
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
            if (target.canAttack !== true) {
                diagnostics.rejected.push({
                    candidate: `attack|${target.tokenUuid}`,
                    reason: "target-not-attackable"
                });
            } else if (!usableActions.length) {
                diagnostics.rejected.push({
                    candidate: `attack|${target.tokenUuid}`,
                    reason: "no-action"
                });
            } else {
                // One attack variant per legal action so presets can prefer
                // melee charge plans over a higher-damage ranged option.
                for (const action of usableActions) {
                    const tag = `${action.id}|${target.tokenUuid}`;
                    if (_actionCost(action) > actionBudget) {
                        diagnostics.rejected.push({
                            candidate: `action|${tag}`,
                            reason: "over-budget"
                        });
                        continue;
                    }
                    const range = _actionRange(action);
                    const melee = _isMeleeAction(action);
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
                    } else {
                        diagnostics.rejected.push({
                            candidate: `attack-in-place|${tag}`,
                            reason: "out-of-range"
                        });
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
                        diagnostics.rejected.push({
                            candidate: `${melee ? "charge" : "move-attack"}|${tag}`,
                            reason: moves.some(move => !move.stay) ? "out-of-range" : "no-route"
                        });
                    }
                }
            }

            // A closing approach is a relocation that ends nearer the
            // target — pinned combatants may only move while keeping or
            // increasing the distance, exactly like move-attack.
            const approachVetoed = approachMove !== null && isPinned
                && Number.isFinite(approachMove.distance)
                && approachMove.distance < distance;
            if (approachMove && !approachVetoed) {
                candidates.push({ target, action: null, move: approachMove, variant: "approach" });
            } else if (approachVetoed) {
                diagnostics.rejected.push({
                    candidate: `approach|${target.tokenUuid}`,
                    reason: "pinned"
                });
            } else if (!attackFound) {
                routesMissing = true;
                diagnostics.rejected.push({
                    candidate: `approach|${target.tokenUuid}`,
                    reason: "no-route"
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
            ...planContext
        };
        const scored = [];
        candidates.forEach((candidate, index) => {
            const factors = _factorsOf({ ...candidate, moveBudget });
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
                    diagnostics.rejected.push({
                        candidate: _candidateId(candidate, index),
                        reason: typeof vetoReason === "string" ? vetoReason : "preset-veto"
                    });
                    return;
                }
            }
            let evaluation;
            if (typeof preset.evaluate === "function") {
                const custom = preset.evaluate({
                    factors, candidate, weights: preset.weights, context: evalContext
                });
                evaluation = Number.isFinite(custom)
                    ? { score: custom, breakdown: { factors, custom: true } }
                    : {
                        score: _finiteOr(custom?.score, 0),
                        breakdown: custom?.breakdown ?? { factors, custom: true }
                    };
            } else {
                evaluation = evaluateFactors(factors, preset.weights);
            }
            scored.push({
                ...candidate,
                id: _candidateId(candidate, index),
                factors,
                score: evaluation.score,
                breakdown: evaluation.breakdown
            });
        });
        scored.sort((a, b) => (b.score - a.score) || String(a.id).localeCompare(String(b.id)));

        diagnostics.candidatesCount = scored.length;
        diagnostics.ranking = scored.map(entry => ({
            candidate: entry.id,
            score: entry.score
        }));

        if (!scored.length) {
            return {
                status: PLANNER_STATUS.noAction,
                reason: "no-valid-plan",
                plan: null,
                diagnostics
            };
        }

        const top = scored.filter(entry => entry.score === scored[0].score);
        const winner = top.length > 1 ? _seededPick(top, seed) : top[0];
        diagnostics.chosenStep = null;
        const steps = _stepsFor({ candidate: winner });
        diagnostics.chosenStep = steps.find(step => step.type !== "end-turn")?.id ?? steps[0].id;

        const plan = _assemblePlan({
            combat, combatant, context, authority, seed, presetId,
            diagnostics, steps, winner, targets, actions: usableActions
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
     * @returns {object} Frozen plan.
     */
    function _assemblePlan({ combat, combatant, context, authority, seed,
        presetId, diagnostics, steps, winner, targets, actions }) {
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
        return _deepFreeze({
            id: planId,
            operationId: context.operation?.id ?? context.operationId ?? null,
            actorUuid: snapshot.self.actorUuid,
            tokenUuid: snapshot.self.tokenUuid,
            preset: presetId,
            seed,
            replanCount,
            score: winner.score,
            breakdown: winner.breakdown,
            target: snapshot.target,
            snapshot: _deepFreeze(snapshot),
            steps,
            diagnostics,
            debug: { seed }
        });
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
