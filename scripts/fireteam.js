/**
 * Fireteam service (issue #408): team membership flags, deterministic leader
 * election, serializable TeamPlans with temporary tactical assignments, soft
 * cohesion scoring, resource reservations and phased execution with
 * synchronization barriers.
 *
 * Design contract (epic #363, issue #408):
 * - Fireteam membership lives in `flags["only-war-ai"].fireteam` on the
 *   Actor, TokenDocument and Combatant layers:
 *   `{teamId, leaderId, teamPreset, preferredCohesion, character}`. The
 *   Combatant layer
 *   wins, then Token, then Actor — mirroring the override resolver.
 * - A `TeamPlan` is a plain, JSON-serializable DTO — never a Document — that
 *   describes one bounded team maneuver for the current round:
 *   `{id, combatId, round, turn, teamId, leaderId, revision, seed, members,
 *   memberPlans, phases, reservations, score, breakdown, diagnostics}`.
 * - Tasks (`support`/`advance`/`flank`/`assault`/`regroup`) and tactical
 *   groups exist only inside the current TeamPlan. They are never stored as
 *   permanent Actor roles.
 * - `preferredCohesion` (default 5 scene units, configurable through the
 *   `preferredCohesion` world setting or a fireteam flag) is a *soft*
 *   scoring constraint: ordinary endpoints beyond it are penalized, and a
 *   member may legally detach for a valid flank/assault maneuver when the
 *   endpoint is reachable, the separation is time-bounded
 *   (`detachedUntilPhase <= maxDetachedPhases`) and a legal rejoin point
 *   exists.
 * - Leader loss invalidates the plan (`leader-lost`) and a successor is
 *   elected deterministically by initiative, then hit points, then a
 *   seed-scoped hash tie-break — identical input elects the identical leader.
 * - Sibling services are resolved lazily (`api.services.get("planner" |
 *   "authority" | "tactics")`) or injected via `context`; every lookup degrades safely
 *   so the service works before/without the other stacked branches.
 */
import {
    AI_DIFFICULTIES,
    AI_PRESETS,
    DEFAULT_MAX_SYNC_ROUNDS,
    DEFAULT_PREFERRED_COHESION,
    FIRETEAM_CHARACTERS,
    FIRETEAM_TASKS,
    FLAG_KEYS,
    MODULE_ID,
    MORALE_DEFAULT_TIER,
    ORDER_COOLDOWN_ROUNDS
} from "./constants.js";
import { resolveEffectiveConfig } from "./config-resolver.js";
import {
    effectiveMoraleTier,
    evaluateMoraleRecord,
    isEvaluatedMoraleRecord,
    isGmControlled,
    moraleSpaceControl,
    resolveLayerFlags,
    sanitizeMoraleRecord
} from "./layers.js";
import { movementCells, offsetKey } from "./navigation.js";
import { personalityIdentity, resolvePersonality } from "./personalities.js";
import { isHostileDisposition, mergeTeamMemory } from "./perception.js";
import {
    createPlannerService,
    fnv1a,
    stableStringify
} from "./planner.js";
import { emitBarkOnce } from "./barks.js";
import {
    getAIDifficulty,
    getMoraleDesperateRatio,
    getPeelThresholds,
    getPreferredCohesion,
    getSpecOpsConfig,
    logDiagnostics
} from "./settings.js";
import {
    DEFAULT_MELEE_REACH,
    expectedDamageOf,
    weaponEmitters
} from "./threat-map.js";
import { createTacticRegistry } from "./tactics/registry.js";
import {
    normalizeFocusWounds,
    selectFocusTarget
} from "./presets/concentrate-fire.js";
import {
    SPEC_OPS_PRESET_ID,
    checkSpecOpsFlank,
    registerSpecOpsTacticSelector,
    specOpsFlankFallback,
    specOpsTokenCenter
} from "./presets/spec-ops.js";
import {
    PEEL_WITHDRAWAL_NAME
} from "./tactics/peel-withdrawal.js";
import {
    INTERDICTION_TACTIC,
    INTERDICT_OBJECTIVE_TYPE,
    INTERDICT_ROLE
} from "./presets/interdiction.js";
import {
    PINCER_LOOSE_TACTIC,
    PINCER_TACTIC
} from "./presets/pincer.js";
import {
    SUPPRESS_AND_BOUND,
    pointInSuppressionZone
} from "./tactics/suppress-and-bound.js";
import {
    buildRecoverPinnedOverlay,
    RECOVER_PINNED_ROLES
} from "./tactics/recover-pinned.js";

/** Result statuses of {@link createFireteamService.buildTeamPlan}. */
export const FIRETEAM_STATUS = Object.freeze({
    ok: "ok",
    noMembers: "no-members",
    leaderUnavailable: "leader-unavailable",
    disabled: "disabled",
    waitingForGm: "waiting-for-gm",
    invalid: "invalid-plan"
});

/**
 * Stable invalidation reason codes returned by `validateTeamPlan`.
 * `leader-lost` triggers a deterministic re-election; `member-unavailable`
 * allows one shared replan before the first state change; `sync-broken`
 * (issue #38) marks a synchronized-strike wait whose awaited member
 * (usually the transit flanker) was defeated or disabled.
 */
export const TEAM_PLAN_REASONS = Object.freeze({
    leaderLost: "leader-lost",
    memberUnavailable: "member-unavailable",
    syncBroken: "sync-broken",
    turnStale: "turn-stale",
    combatEnded: "combat-ended",
    invalidPlan: "invalid-plan",
    stale: "stale"
});

/** Failure policies a synchronization barrier may declare. */
export const BARRIER_FAILURE_POLICIES = Object.freeze([
    "hold",
    "abort",
    "continue"
]);

/** Default bound on the phases a member may stay detached from cohesion. */
export const DEFAULT_MAX_DETACHED_PHASES = 2;

/** Charge band beyond melee reach in which melee members count for kill-EV. */
const MELEE_KILL_ALLOWANCE = 6;

/**
 * How many members of one task may reserve the same target. `flank` keeps a
 * single reserver so two members never plan mutually exclusive actions on
 * one target; `regroup` is unbounded because it aims at the team itself.
 */
export const TARGET_TASK_CAPACITY = Object.freeze({
    support: 2,
    advance: 2,
    flank: 1,
    assault: 2,
    regroup: Number.POSITIVE_INFINITY
});

/** Tasks eligible for a detached maneuver beyond preferred cohesion. */
const DETACHED_TASKS = Object.freeze(new Set(["flank", "assault"]));

/**
 * Tasks a `gm-controlled` member is demoted from (issue #25): the manual
 * move voids complex maneuvers — the member replans as `support` while
 * the rest of the team plan degrades instead of collapsing.
 */
const GM_DEMOTABLE_TASKS = Object.freeze(new Set(["flank", "assault", "advance"]));

/**
 * Issue #26 L2 morale: the task remap each member-effective tier applies
 * after the default assignment — a `desperate` bot pulls out of the
 * assault column into covering `support` and turns `flank`/`advance`
 * orders into a `regroup` back to the fallback point, while
 * `confident`/`pressured` keep their assignments (`confident` widens
 * the assault/flank caps inside `assignTasks` instead). Same precedence
 * as the `gm-controlled` demotion: the remap also rewrites explicit
 * `context.assignments`.
 */
const MORALE_TASK_REMAP = Object.freeze({
    desperate: Object.freeze({ assault: "support", advance: "regroup", flank: "regroup" }),
    pressured: Object.freeze({}),
    confident: Object.freeze({})
});

/**
 * Issue #26: assignment caps a `confident` team gets — a second assault
 * column and a wider flank group (the `pressured`/`desperate` default
 * is the historical one-assault-leader plus at most one flanker).
 */
const MORALE_CONFIDENT_ASSAULT_CAP = 2;
const MORALE_CONFIDENT_FLANK_CAP = 2;

/**
 * Targeted suppress-and-bound demotion policy (issue #86): once a bound or
 * suppressor assignment is demoted by GM intervention/morale, the geometric
 * fire/maneuver role no longer exists and must not keep steering scoring or
 * zone ownership. The member objective is deliberately preserved — it is
 * serializable tactical metadata and the shared-objective precedence rules
 * decide whether it still narrows targets. Generic roles such as `focus`
 * are untouched.
 * @param {object} assignment Mutable assignment entry during demotion.
 */
function _clearSuppressionGeometry(assignment) {
    if (!assignment || !["suppressor", "bound"].includes(assignment.role)) return;
    delete assignment.role;
    delete assignment.element;
}

/**
 * Targeted interdiction demotion policy (issue #87): once an interdictor
 * assignment is demoted by GM intervention/morale, the screen role no
 * longer exists and its geometry must not keep steering the member. The
 * whole member objective goes with the role — unlike the suppression
 * cone metadata it is not inert: its `targetId` both pins
 * `assignedTargetId` onto an enemy the demoted member is now
 * command-denied and feeds `screenPoint` movement scoring. The target
 * pin is cleared with it so the demoted member rejoins the shared focus
 * pool as ordinary support. The gate deliberately requires genuine
 * interdiction geometry (`objective.type === "interdict"`): object-form
 * assignments are a public caller contract, so an arbitrary injected
 * role label with foreign objective metadata passes through untouched.
 * @param {object} assignment Mutable assignment entry during demotion.
 */
function _clearInterdictionGeometry(assignment) {
    if (!assignment || assignment.role !== INTERDICT_ROLE) return;
    if (assignment.objective?.type !== INTERDICT_OBJECTIVE_TYPE) return;
    delete assignment.role;
    delete assignment.objective;
    assignment.assignedTargetId = null;
}

/**
 * Targeted pincer demotion policy (issue #88): once a flanker/fixer
 * assignment is demoted by GM intervention/morale, its signed element no
 * longer exists and must not keep resolving the per-member flank point.
 * Only genuine pincer markers are cleared — the gate requires both a
 * pincer role (`flanker`/`fixer`) and a pincer element
 * (`flank-left`/`flank-right`/`fix`/`center`), so an arbitrary injected
 * object-form assignment with foreign metadata passes through untouched.
 * The member objective is preserved: it is serializable tactical metadata
 * and the shared-objective precedence rules decide whether it still
 * narrows targets.
 * @param {object} assignment Mutable assignment entry during demotion.
 */
function _clearPincerGeometry(assignment) {
    if (!assignment || !["flanker", "fixer"].includes(assignment.role)) return;
    if (!["flank-left", "flank-right", "fix", "center"].includes(assignment.element)) return;
    delete assignment.role;
    delete assignment.element;
}

/**
 * Targeted peel-withdrawal demotion policy (issue #89): once a withdraw or
 * cover assignment is demoted by GM intervention/morale, the peel role and
 * its cost/geometry channel must not keep steering the member. Peel has no
 * latch — clearing the object-form role is sufficient; the next round's
 * selector re-evaluates the whole team statelessly.
 * @param {object} assignment Mutable assignment entry during demotion.
 */
function _clearPeelGeometry(assignment) {
    if (!assignment || !["withdraw", "cover"].includes(assignment.role)) return;
    // `withdraw` remains meaningful on the regroup task and `cover` on
    // support. Morale's flank→regroup/assault→support remap therefore does
    // not destroy explicit peel-shaped assignments; a demotion that leaves
    // the role/task pair invalid (notably GM→support for a withdrawer)
    // clears both the role and the peel objective geometry.
    if ((assignment.role === "withdraw" && assignment.task === "regroup")
        || (assignment.role === "cover" && assignment.task === "support")) {
        return;
    }
    delete assignment.role;
    if (assignment.objective?.type === "peel-withdrawal") delete assignment.objective;
}

/**
 * Pincer maneuver test (issue #88): the strict/loose tactic itself or the
 * interdiction composite over a pincer base. Drives the multi-await sync
 * policy and the reservation geometry downstream.
 * @param {string|null} tacticName Committed tactic name.
 * @param {object|null} [tactic] Tactic descriptor.
 * @returns {boolean}
 */
function _isPincerManeuver(tacticName, tactic = null) {
    if (tacticName === PINCER_TACTIC || tacticName === PINCER_LOOSE_TACTIC) return true;
    const base = tactic?.breakdown?.baseTactic ?? null;
    return tacticName === INTERDICTION_TACTIC
        && (base === PINCER_TACTIC || base === PINCER_LOOSE_TACTIC);
}

/**
 * Per-member flank maneuver anchor (issue #88): a pincer objective
 * carries two signed maneuver points under `elements.left/right.point`;
 * the member's own element selects its side's point. Members without a
 * flank element — fix base, legacy single flank group — keep the legacy
 * shared `objective.flankPoint` (absent on a true pincer objective).
 * @param {object|null} assignment Member assignment (`element`).
 * @param {object|null} objective Shared/member objective.
 * @returns {{point: object|null, side: string|null}}
 */
function _memberFlankAnchor(assignment, objective) {
    const side = assignment?.element === "flank-left" ? "left"
        : assignment?.element === "flank-right" ? "right" : null;
    if (side) {
        const point = objective?.elements?.[side]?.point ?? null;
        if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) {
            return { point: { x: point.x, y: point.y }, side };
        }
    }
    const legacy = objective?.flankPoint ?? null;
    if (Number.isFinite(legacy?.x) && Number.isFinite(legacy?.y)) {
        return { point: legacy, side: objective?.flankSide ?? side };
    }
    return { point: null, side };
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
 * Numeric helper: value when finite, otherwise fallback.
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function _finiteOr(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}

/**
 * Read a module flag without mutating the document. Uses `getFlag` when the
 * document provides it, otherwise reads the raw `flags` object.
 * @param {object} doc
 * @param {string} key
 * @returns {*}
 */
function _readFlag(doc, key) {
    if (typeof doc?.getFlag === "function") {
        try {
            return doc.getFlag(MODULE_ID, key);
        } catch(_err) {
            return undefined;
        }
    }
    return doc?.flags?.[MODULE_ID]?.[key];
}

/**
 * Whether the document is absent or marked as deleted.
 * @param {object} doc
 * @returns {boolean}
 */
function _isMissing(doc) {
    if (!doc || typeof doc !== "object") return true;
    if (doc.destroyed === true || doc._destroyed === true) return true;
    return false;
}

/**
 * Detect the document kind from `documentName`, falling back to the same
 * structural heuristic the config resolver uses for plain fixtures.
 * @param {object} doc
 * @returns {string|null} "combatant" | "token" | "actor" | null
 */
function _kindOf(doc) {
    const name = doc?.documentName ?? doc?.constructor?.documentName ?? "";
    if (name === "Combatant") return "combatant";
    if (name === "Token") return "token";
    if (name === "Actor") return "actor";
    if (name) return null;
    if ("actor" in doc && "token" in doc) return "combatant";
    if ("actor" in doc) return "token";
    if ("flags" in doc || "system" in doc || "type" in doc) return "actor";
    return null;
}

/**
 * Deep-freeze helper for immutable team plans.
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
 * Strip anything non-serializable via a JSON round-trip.
 * @param {*} value
 * @returns {*}
 */
function _jsonClone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * Whether a value is a plain object (not an array, class instance or
 * Document). Assignment objectives must remain JSON-only data.
 * @param {*} value
 * @returns {boolean}
 */
function _isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/**
 * JSON-round-trip a plain object, rejecting payloads that cannot serialize
 * (circular references, BigInt and the like). The clone never shares object
 * identity with the caller's input, so TeamPlan freezing cannot freeze a
 * tactic author's working draft.
 * @param {*} value
 * @returns {object|null}
 */
function _jsonObject(value) {
    if (!_isPlainObject(value)) return null;
    try {
        const clone = _jsonClone(value);
        return _isPlainObject(clone) ? clone : null;
    } catch(err) {
        return null;
    }
}

/**
 * Non-empty normalized marker string (`role`/`element`), or null.
 * @param {*} value
 * @returns {string|null}
 */
function _markerString(value) {
    return typeof value === "string" && value.trim()
        ? value.trim() : null;
}

/**
 * Normalize one explicit fireteam assignment value. The legacy form is a
 * bare task string and means `{task: string}`; the object form is
 * `{task, role?, element?, objective?}`. The task itself is deliberately
 * not validated here — `assignTasks` keeps the historical fallback of an
 * unknown task to `support` — while `objective` is cloned into plain
 * JSON-only data or dropped when it cannot serialize.
 * @param {*} value Raw `combatantId → assignment` value.
 * @returns {object|null} `{task, role?, element?, objective?}` or null.
 */
export function normalizeFireteamAssignment(value) {
    let source = null;
    if (typeof value === "string") source = { task: value };
    else if (_isPlainObject(value)) source = value;
    if (!source) return null;
    const normalized = {
        task: typeof source.task === "string" ? source.task : null
    };
    const role = _markerString(source.role);
    const element = _markerString(source.element);
    if (role) normalized.role = role;
    if (element) normalized.element = element;
    const objective = _jsonObject(source.objective);
    if (objective) normalized.objective = objective;
    return normalized;
}

/**
 * Canonical serializable assignment descriptor exposed to member planner
 * contexts. `objective` is the member-scoped polymorphic objective; the
 * legacy shared target id remains the separate `team.objective` channel.
 * @param {object} assignment Assignment produced by `assignTasks`.
 * @returns {{task: string|null, role?: string, element?: string,
 *   objective?: object}}
 */
function _assignmentDescriptor(assignment) {
    const descriptor = { task: assignment?.task ?? null };
    if (assignment?.role) descriptor.role = assignment.role;
    if (assignment?.element) descriptor.element = assignment.element;
    if (assignment?.objective) descriptor.objective = _jsonClone(assignment.objective);
    return descriptor;
}

/**
 * Morale state of a combatant for issue #38 gating (graceful #26
 * integration): reads `context.morale` first (tests/integrations), then
 * the reserved module flag `flags["only-war-ai"].morale`
 * `{state, pressured?, desperate?}`. No flag or unrecognized payload —
 * normal morale, the caller keeps planning as usual.
 * @param {object|null} combatant Combatant document.
 * @param {object} [context] `buildTeamPlan` context.
 * @returns {{pressured: boolean, desperate: boolean}}
 */
function _moraleOf(combatant, context = {}) {
    const injected = context.morale;
    const record = injected !== undefined ? injected
        : _readFlag(combatant, FLAG_KEYS.morale);
    const state = typeof record?.state === "string" ? record.state : null;
    return {
        pressured: record?.pressured === true || state === "pressured",
        desperate: record?.desperate === true || state === "desperate"
    };
}

/**
 * Order options of an actor (issue #38): owned `order` items, then
 * speciality perks whose `activation.type` is `order`/`generalOrder`
 * (e.g. the sergeant's `sergeant_charge`). Perk documents are resolved
 * best-effort through `fromUuidSync` — a missing compendium or resolver
 * simply yields no perk options, never an error.
 * @param {object} actor Actor document.
 * @returns {object[]} `{orderId, name, orderType, benefit, advanced}`
 *   sorted deterministically by `orderId`.
 */
function _orderOptionsOf(actor) {
    const options = [];
    for (const item of _list(actor?.items)) {
        if (!item || item.type !== "order") continue;
        const system = item.system ?? {};
        options.push({
            orderId: item.uuid ?? item.id ?? item.name,
            name: item.name ?? null,
            orderType: system.orderType ?? null,
            benefit: system.benefit ?? null,
            advanced: system.orderType === "veteran"
        });
    }
    const speciality = actor?.system?.speciality;
    if (speciality?.uuid && typeof globalThis.fromUuidSync === "function") {
        const resolve = uuid => {
            try {
                return globalThis.fromUuidSync(uuid) ?? null;
            } catch(_err) {
                return null;
            }
        };
        const specialityDoc = resolve(speciality.uuid);
        const perkUuids = Array.isArray(specialityDoc?.system?.perks)
            ? specialityDoc.system.perks : [];
        const states = speciality.perks ?? {};
        for (const uuid of perkUuids) {
            const doc = resolve(uuid);
            if (!doc || doc.type !== "specialityPerk") continue;
            const activation = doc.system?.activation ?? {};
            if (activation.type !== "order" && activation.type !== "generalOrder") {
                continue;
            }
            const perkId = doc.system?.perkId ?? doc.id ?? uuid;
            if (states[perkId]?.enabled === false) continue;
            options.push({
                orderId: perkId,
                name: doc.name ?? perkId,
                orderType: activation.type === "generalOrder"
                    ? "general" : "speciality",
                benefit: doc.system?.benefit ?? doc.system?.manualNote ?? null,
                advanced: false
            });
        }
    }
    return options.sort((a, b) => String(a.orderId).localeCompare(String(b.orderId)));
}

/**
 * The order candidate of a team leader (issue #38): a single-member squad
 * has nobody to order, a leader without the `command` skill cannot issue
 * orders (`prepareTest` would answer `action-unavailable` anyway — the
 * upfront check keeps the candidate honest) and `ORDER_COOLDOWN_ROUNDS`
 * must have elapsed since the executor's `lastOrder` post-success stamp.
 * @param {object} input
 * @param {object} input.member Leader member entry.
 * @param {number} input.memberCount Living team size.
 * @param {object} input.combat Combat document.
 * @param {object} input.context `buildTeamPlan` context.
 * @returns {object|null} `{orderId, name, orderType, benefit, skill, advanced}`.
 */
function _orderCandidateOf({ member, memberCount, combat, context }) {
    if (!member || _finiteOr(memberCount, 0) < 2) return null;
    const actor = member.combatant?.actor
        ?? _tokenDoc(member.combatant?.token)?.actor ?? null;
    if (!actor) return null;
    const skills = actor.system?.skills ?? actor.skills ?? {};
    if (skills.command == null) return null;
    const record = _readFlag(member.combatant, FLAG_KEYS.lastOrder);
    const round = _finiteOr(combat?.round, 0);
    const cooldown = _finiteOr(context?.orderCooldownRounds, ORDER_COOLDOWN_ROUNDS);
    if (record && Number.isFinite(record.round)
        && round - record.round < cooldown) {
        return null;
    }
    const pick = _orderOptionsOf(actor)[0] ?? null;
    if (!pick) return null;
    return { ...pick, skill: "command" };
}

/**
 * Merged shared contacts of the whole team (issue #38): built once per
 * `buildTeamPlan` — each member's `lastKnownPositions` is merged through
 * `mergeTeamMemory`, so every member context carries the identical,
 * deterministically deduped contact list. `context.shareContacts ===
 * false` or a missing perception service leaves contacts unset.
 * @param {object} input
 * @param {object[]} input.members Living members (dead/disabled never
 *   reach this list — `buildTeamPlan` filters them first).
 * @param {object} input.combat Combat document.
 * @param {object} input.context `buildTeamPlan` context.
 * @param {object|null} input.perception Perception service.
 * @returns {object[]|null} Sorted `{tokenUuid, ...entry}` records.
 */
function _teamContacts({ members, combat, context, perception }) {
    if (context?.shareContacts === false) return null;
    if (typeof perception?.lastKnownPositions !== "function") return null;
    const memories = [];
    for (const member of members ?? []) {
        let entries = [];
        try {
            entries = perception.lastKnownPositions(member.combatant) ?? [];
        } catch(err) {
            entries = [];
        }
        if (!Array.isArray(entries) || !entries.length) continue;
        memories.push({
            combatantId: member.combatantId,
            memory: Object.fromEntries(
                entries.map(entry => [entry.tokenUuid, entry]))
        });
    }
    if (!memories.length) return null;
    const merged = mergeTeamMemory(null, memories, _finiteOr(combat?.round, null));
    const contacts = Object.entries(merged)
        .map(([tokenUuid, entry]) => ({ tokenUuid, ...entry }))
        .sort((a, b) => String(a.tokenUuid).localeCompare(String(b.tokenUuid)));
    return contacts.length ? contacts : null;
}

/**
 * Delay-stub member plan for a synchronized strike (issue #38): the
 * member's chosen plan is replaced by a serializable `delay` step plus
 * `end-turn`. The stub rides on the plan DTO (same id/revision) and marks
 * `plan.delay` for executors/overlays; `memberEntries[].delayed` records
 * the wait condition separately.
 * @param {object} plan Original member plan.
 * @param {object} input
 * @param {object} input.delay `{reason, until, syncRound, awaitId}`.
 * @param {string} input.teamId Team id.
 * @param {number|null} input.round Current combat round.
 * @returns {object} New plan DTO (the input is never mutated).
 */
function _delayStubPlan(plan, { delay, teamId, round }) {
    const clone = _jsonClone(plan) ?? {};
    // Issue #93: the pinned member's free end-of-turn recovery test
    // survives the stub — delaying the strike never costs the test.
    const unpinStep = (plan?.steps ?? []).find(step => step?.input?.unpin === true);
    clone.steps = [
        {
            id: "step-delay-1",
            type: "delay",
            cost: { halves: 2 },
            input: {
                reason: delay.reason,
                until: delay.until,
                teamId: teamId ?? null,
                round: round ?? null
            },
            preconditions: ["turn"],
            projectedResourceDelta: {}
        },
        ...(unpinStep ? [_jsonClone(unpinStep)] : []),
        {
            id: "step-end-turn-2",
            type: "end-turn",
            cost: {},
            input: { reason: "await-sync" },
            preconditions: ["turn"],
            projectedResourceDelta: {}
        }
    ];
    clone.delay = { ...delay };
    return clone;
}

/**
 * Synchronized-strike post-pass (issue #38): when a convergence target is
 * shared but the transit flanker still needs a round to get there — a
 * flank-task member with a move-only plan (ETA ≥ 1 turn) — main members
 * whose plan already strikes `convergence.targetId` hold position
 * instead: their plan is replaced by a delay-stub, so the squad strikes
 * together once the flank is in position. Guards: the flanker itself is
 * never delayed, a morale-`desperate` member (issue #26 effective tier —
 * a `fanatic` in a desperate team still waits, a `coward` in a merely
 * pressured one does not; the legacy flag read is the fallback) keeps
 * fighting and `maxSyncRounds` bounds consecutive
 * delays through the `delaySync` flag record the executor's delay step
 * writes. `context.syncDelay === false` disables the pass.
 * @param {object} input
 * @param {object[]} input.ordered Members in planning order.
 * @param {Map} input.assignMap `combatantId → assignment`.
 * @param {Map} input.plans `combatantId → planTurn result`.
 * @param {object|null} input.convergence Shared objective descriptor.
 * @param {object} input.combat Combat document.
 * @param {object} input.context `buildTeamPlan` context.
 * @param {object} input.diagnostics Diagnostics sink (`syncDelays`).
 * @param {string} input.teamId Team id.
 * @param {Map<string,string>} [input.memberMorale]
 *   `combatantId → effective tier` from the team evaluation.
 * @param {string|null} [input.sync] Pincer sync policy of the committed
 *   objective (`elastic`/`strict`/`none`); null keeps the legacy
 *   single-flanker semantics.
 * @returns {Map} `combatantId → {reason, until, syncRound, awaitId}`.
 */
function _syncDelay({ ordered, assignMap, plans, convergence, combat, context,
    diagnostics, teamId, memberMorale = null, sync = null }) {
    const result = new Map();
    if (context?.syncDelay === false) return result;
    if (!convergence?.targetId) return result;
    // Issue #88: the loose assault pincer carries `sync: "none"` — its
    // flank pressure is scoring-only and the squad never holds a strike
    // for it. Legacy flank-and-fix passes no policy at all.
    if (sync === "none") return result;
    const strikesTargetOf = plan => plan?.target?.tokenId === convergence.targetId
        || (plan?.steps ?? []).some(step =>
            (step?.type === "attack" || step?.type === "test")
            && (step?.input?.targetTokenId === convergence.targetId
                || step?.input?.targetTokenUuid
                    === (convergence.targetUuid ?? convergence.targetId)));
    // Transit cost proxy of one member plan: the summed movement cost of
    // its move steps — the remaining-route approximation the elastic
    // policy sorts on (issue #88). Ties resolve by combatant id.
    const transitCostOf = member => {
        const steps = plans?.get(member.combatantId)?.plan?.steps ?? [];
        let total = 0;
        for (const step of steps) {
            if (step?.type !== "move") continue;
            total += _finiteOr(step?.cost?.movement, 0);
        }
        return total;
    };
    const transitFlankers = [];
    for (const member of ordered ?? []) {
        if (assignMap?.get(member.combatantId)?.task !== "flank") continue;
        const steps = plans?.get(member.combatantId)?.plan?.steps ?? [];
        const moves = steps.some(step => step?.type === "move");
        const strikes = steps.some(step => step?.type === "attack" || step?.type === "test");
        if (moves && !strikes) transitFlankers.push(member);
    }
    if (!transitFlankers.length) return result;
    // Issue #88 pincer sync policies. `elastic` releases the strike as
    // soon as one flank side is ready: when any flank member already
    // attacks the target this round nobody waits at all, and the fix
    // base otherwise awaits only the earliest transit flanker. `strict`
    // awaits every transit flanker. Without a pincer policy the legacy
    // single-flanker behavior stands: the first transit flanker in
    // maneuver order is the one awaited member.
    let awaitIds;
    let policy = null;
    if (sync === "elastic" || sync === "strict") {
        policy = sync;
        if (sync === "elastic") {
            const flankerStrikes = (ordered ?? []).some(member => {
                if (assignMap?.get(member.combatantId)?.task !== "flank") return false;
                return strikesTargetOf(plans?.get(member.combatantId)?.plan);
            });
            if (flankerStrikes) return result;
            const earliest = [...transitFlankers].sort((a, b) =>
                (transitCostOf(a) - transitCostOf(b))
                || String(a.combatantId).localeCompare(String(b.combatantId)))[0];
            awaitIds = [earliest.combatantId];
        } else {
            awaitIds = transitFlankers
                .map(member => member.combatantId)
                .sort((a, b) => String(a).localeCompare(String(b)));
        }
    } else {
        awaitIds = [transitFlankers[0].combatantId];
    }
    const awaitSet = new Set(awaitIds);
    const maxSyncRounds = _finiteOr(context?.maxSyncRounds, DEFAULT_MAX_SYNC_ROUNDS);
    const round = Number.isFinite(combat?.round) ? combat.round : null;
    for (const member of ordered ?? []) {
        if (awaitSet.has(member.combatantId)) continue;
        // Flankers are never delayed — they are the wait condition.
        if (assignMap?.get(member.combatantId)?.task === "flank") continue;
        const entry = plans?.get(member.combatantId);
        const plan = entry?.plan;
        if (!plan) continue;
        const strikesTarget = strikesTargetOf(plan);
        if (!strikesTarget) continue;
        // Issue #26: a member whose *effective* morale tier is `desperate`
        // cannot be trusted to hold position for the synchronized
        // strike — it fights on. The effective map carries the team
        // evaluation; the legacy flag read is the fallback.
        const effectiveTier = memberMorale?.get?.(member.combatantId);
        const desperate = effectiveTier != null
            ? effectiveTier === "desperate"
            : _moraleOf(member.combatant, context).desperate;
        if (desperate) continue;
        // The `delaySync` flag counts consecutive delays for the same
        // `until` condition — beyond `maxSyncRounds` the member stops
        // waiting and attacks anyway.
        const sync = _readFlag(member.combatant, FLAG_KEYS.delaySync);
        if (sync?.until === "flank-ready" && Number.isFinite(sync.count)
            && sync.count >= maxSyncRounds) {
            continue;
        }
        const delay = {
            reason: "await-sync",
            until: "flank-ready",
            syncRound: round,
            // `awaitId` stays the first awaited id for backward
            // compatibility; the full multi-await list and the pincer
            // policy ride along (issue #88).
            awaitId: awaitIds[0],
            ...(policy ? { awaitIds: [...awaitIds], policy } : {})
        };
        plans.set(member.combatantId, {
            ...entry,
            plan: _delayStubPlan(plan, { delay, teamId, round })
        });
        result.set(member.combatantId, delay);
    }
    if (result.size && diagnostics) {
        diagnostics.syncDelays = [...result.entries()]
            .map(([combatantId, delay]) => ({ combatantId, ...delay }));
    }
    return result;
}

/**
 * Normalize the raw `fireteam` flag of one document into a per-field map.
 * @param {object|null} doc
 * @returns {{teamId: string|null, leaderId: string|null,
 *   teamPreset: string|null, preferredCohesion: number|null,
 *   character: string|null}}
 */
function _normalizeFireteamFlag(doc) {
    const flag = _readFlag(doc, FLAG_KEYS.fireteam);
    const empty = {
        teamId: null,
        leaderId: null,
        teamPreset: null,
        preferredCohesion: null,
        character: null
    };
    if (!flag || typeof flag !== "object") return empty;
    return {
        teamId: typeof flag.teamId === "string" && flag.teamId.trim()
            ? flag.teamId.trim() : null,
        leaderId: (typeof flag.leaderId === "string" && flag.leaderId)
            || (typeof flag.leaderId === "number")
            ? flag.leaderId : null,
        teamPreset: AI_PRESETS.includes(flag.teamPreset) ? flag.teamPreset : null,
        preferredCohesion: Number.isFinite(flag.preferredCohesion)
            && flag.preferredCohesion > 0
            ? flag.preferredCohesion : null,
        // Issue #19: the team's shared temperament — one of
        // `disciplined|shock|elite|rabble`.
        character: FIRETEAM_CHARACTERS.includes(flag.character)
            ? flag.character : null
    };
}

/**
 * Resolve the effective fireteam configuration of an Actor, Token or
 * Combatant document (issue #408). Each field is resolved independently
 * down the Combatant → Token → Actor chain, so a combatant may set only
 * `teamId` while the actor default supplies `teamPreset`/`preferredCohesion`.
 * @param {object} document Actor, TokenDocument, Token placeable or Combatant.
 * @returns {{teamId: string|null, leaderId: string|null,
 *   teamPreset: string|null, preferredCohesion: number|null,
 *   character: string|null, source: string}}
 */
export function resolveTeamConfig(document) {
    const none = {
        teamId: null,
        leaderId: null,
        teamPreset: null,
        preferredCohesion: null,
        character: null,
        source: "none"
    };
    const doc = document?.document?.documentName === "Token"
        ? document.document
        : document;
    if (_isMissing(doc)) return none;

    const kind = _kindOf(doc);
    if (!kind) return none;

    const layers = [];
    if (kind === "combatant") {
        layers.push({ doc, source: "combatant" });
        const token = _tokenDoc(doc.token);
        if (token) layers.push({ doc: token, source: "token" });
        if (doc.actor) layers.push({ doc: doc.actor, source: "actor" });
    } else if (kind === "token") {
        layers.push({ doc, source: "token" });
        if (doc.actor) layers.push({ doc: doc.actor, source: "actor" });
    } else {
        layers.push({ doc, source: "actor" });
    }

    const result = { ...none };
    const fields = ["teamId", "leaderId", "teamPreset", "preferredCohesion", "character"];
    const remaining = new Set(fields);
    for (const layer of layers) {
        if (_isMissing(layer.doc)) continue;
        const flag = _normalizeFireteamFlag(layer.doc);
        for (const field of [...remaining]) {
            if (flag[field] !== null && flag[field] !== undefined) {
                result[field] = flag[field];
                if (result.source === "none") result.source = layer.source;
                remaining.delete(field);
            }
        }
        if (!remaining.size) break;
    }
    return result;
}

/**
 * Create the `fireteam` service published as
 * `api.services.get("fireteam")` (issue #408). Deterministic and read-only
 * with respect to Foundry documents: it never mutates documents and holds
 * no Document references in its serializable outputs.
 * @param {object} [deps]
 * @param {object} [deps.api] Module API for lazy service lookups.
 * @param {object} [deps.planner] Injected planner service.
 * @param {object} [deps.tactics] Injected tactic registry service.
 * @param {Function} [deps.resolveConfig] Effective AI config resolver.
 * @param {Function} [deps.log] Diagnostic logger.
 * @returns {object} Fireteam service.
 */
export function createFireteamService({
    api = null,
    planner = null,
    tactics = null,
    resolveConfig = resolveEffectiveConfig,
    log = (...args) => logDiagnostics(...args)
} = {}) {
    /**
     * Lazy service lookup: explicit dependency first, then the registry.
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

    // Headless/direct-use fallback mirroring `_fallbackPlanner`: the canonical
    // registry lives in `api.services`, but a standalone fireteam service must
    // keep the historical specOps behaviour without introducing module-global
    // mutable state.
    const _fallbackTactics = createTacticRegistry();
    registerSpecOpsTacticSelector(_fallbackTactics);

    /**
     * Tactic registry used for preset maneuvers: explicit dependency first,
     * then the module service registry, then the private specOps fallback.
     * @param {*} override Injected registry (undefined = registry/fallback).
     * @returns {object}
     */
    function _tactics(override) {
        if (override !== undefined) return override;
        if (tactics !== null && tactics !== undefined) return tactics;
        return _service("tactics") ?? _service("tacticRegistry") ?? _fallbackTactics;
    }

    /**
     * Planner used for member plans: injected dependency, the registered
     * service, or a private fallback instance.
     * @param {*} override Injected planner (undefined = registry/fallback).
     * @returns {object}
     */
    function _planner(override) {
        const found = _service("planner", override ?? planner);
        return found ?? _fallbackPlanner;
    }

    const _fallbackPlanner = createPlannerService({ api, resolveConfig });

    /**
     * Build a planner that forces `teamPreset` on every enabled member. The
     * shared planner resolves the preset from document flags only, so a
     * team-scoped override needs a derived instance seeded with the same
     * preset registry (issue #408: "общий пресет команды").
     * @param {string|null} teamPreset Shared team preset id.
     * @param {*} plannerOverride Injected planner for this call.
     * @returns {object}
     */
    function _memberPlanner(teamPreset, plannerOverride) {
        const base = _planner(plannerOverride);
        if (!teamPreset || !AI_PRESETS.includes(teamPreset)) return base;
        // A bare injected planner (`{planTurn}` in tests/integrations) is an
        // explicit service override, not a preset-registry donor. Replacing it
        // with a freshly constructed real planner would silently discard the
        // caller's injection whenever a shared team preset is active.
        if (typeof base?.listPresets !== "function"
            || typeof base?.getPreset !== "function") {
            return base;
        }
        const wrapped = createPlannerService({
            api,
            resolveConfig: doc => {
                const cfg = resolveConfig(doc);
                return cfg?.enabled ? { ...cfg, preset: teamPreset } : cfg;
            }
        });
        for (const id of base.listPresets()) {
            const def = base.getPreset(id);
            if (def) wrapped.registerPreset(id, def);
        }
        return wrapped;
    }

    /**
     * Collect the fireteam members of a combat: non-defeated combatants whose
     * resolved fireteam `teamId` matches and whose effective AI config is
     * enabled. Sorted by combatant id for deterministic iteration.
     * @param {object} combat Combat document.
     * @param {string} teamId
     * @returns {object[]} Member entries `{combatant, combatantId, tokenId,
     *   actorId, ids, initiative, hp, defeated, enabled, position, turnIndex,
     *   hasActed}`.
     */
    function collectMembers(combat, teamId) {
        if (!combat || !teamId) return [];
        const turns = _list(combat.turns);
        const turnIndexes = new Map();
        turns.forEach((entry, index) => {
            const id = typeof entry === "string" ? entry : entry?.id;
            if (id === null || id === undefined) return;
            const key = String(id);
            if (!turnIndexes.has(key)) turnIndexes.set(key, index);
        });
        const currentTurn = Number.isFinite(combat.turn) ? combat.turn : null;
        const members = [];
        for (const combatant of _list(combat.combatants)) {
            if (!combatant || _isMissing(combatant)) continue;
            const team = resolveTeamConfig(combatant);
            if (team.teamId !== teamId) continue;
            const config = resolveConfig(combatant);
            const token = _tokenDoc(combatant.token);
            const actor = combatant.actor ?? token?.actor ?? null;
            const tokenId = combatant.tokenId ?? token?.id ?? null;
            const tokenUuid = typeof token?.uuid === "string" && token.uuid
                ? token.uuid : null;
            const actorUuid = typeof actor?.uuid === "string" && actor.uuid
                ? actor.uuid : (actor?.id ? `Actor.${actor.id}` : null);
            const turnKey = combatant.id === null || combatant.id === undefined
                ? null : String(combatant.id);
            const turnIndex = turnKey !== null && turnIndexes.has(turnKey)
                ? turnIndexes.get(turnKey) : null;
            members.push({
                combatant,
                combatantId: combatant.id ?? null,
                tokenId,
                actorId: actor?.id ?? null,
                ids: [combatant.id, combatant.uuid, tokenId, tokenUuid,
                    actor?.id, actorUuid].filter(v => v !== null && v !== undefined),
                initiative: _finiteOr(combatant.initiative, null),
                hp: _finiteOr(actor?.system?.wounds?.value, 0),
                defeated: combatant.defeated === true,
                enabled: config?.enabled === true,
                preset: config?.preset ?? null,
                team,
                turnIndex,
                hasActed: turnIndex !== null && currentTurn !== null && turnIndex < currentTurn,
                position: _tokenPosition(token)
            });
        }
        return members.sort((a, b) =>
            String(a.combatantId).localeCompare(String(b.combatantId)));
    }

    /**
     * Deterministic leader election. A flagged `leaderId` that still matches
     * an eligible member is retained; otherwise the member with the highest
     * stable score wins: initiative desc, hit points desc, then a
     * seed-scoped FNV-1a tie-break — identical input always elects the
     * identical leader on every client.
     * @param {object[]} members Entries from {@link collectMembers}.
     * @param {object} [options]
     * @param {number} [options.seed] Plan seed for the hash tie-break.
     * @param {string|number|null} [options.leaderId] Flagged leader id to
     *   retain when still valid.
     * @returns {{combatantId: string|null, leaderId: string|number|null,
     *   reason: string, score: object|null}}
     */
    function electLeader(members, { seed = 0, leaderId = null } = {}) {
        const eligible = (members ?? []).filter(member =>
            member && member.combatantId && member.defeated !== true
            && member.enabled !== false);
        if (!eligible.length) {
            return {
                combatantId: null,
                leaderId: null,
                reason: "leader-unavailable",
                score: null
            };
        }
        if (leaderId !== null && leaderId !== undefined) {
            const retained = eligible.find(member => member.ids.includes(leaderId));
            if (retained) {
                return {
                    combatantId: retained.combatantId,
                    leaderId,
                    reason: "retained",
                    score: null
                };
            }
        }
        const scored = eligible.map(member => ({
            member,
            initiative: _finiteOr(member.initiative, -Infinity),
            hp: _finiteOr(member.hp, 0),
            tie: parseInt(fnv1a(`${seed >>> 0}|${member.combatantId}`), 16)
        }));
        scored.sort((a, b) => (b.initiative - a.initiative)
            || (b.hp - a.hp)
            || (a.tie - b.tie)
            || String(a.member.combatantId).localeCompare(String(b.member.combatantId)));
        const winner = scored[0];
        return {
            combatantId: winner.member.combatantId,
            leaderId: winner.member.combatantId,
            reason: "elected",
            score: {
                initiative: winner.initiative,
                hp: winner.hp,
                tie: winner.tie
            }
        };
    }

    /**
     * Assign temporary tasks and tactical groups for one TeamPlan. Tasks are
     * never permanent roles: they only live inside the current plan.
     * Default policy — leader assaults with group `main`, the first
     * non-leader member (stable id order) flanks with group `flank-1` when
     * flanking is allowed, the rest support. `context.assignments` maps
     * `combatantId` either to a legacy task string or to
     * `{task, role?, element?, objective?}`; `context.regroup === true`
     * puts every member without an explicit assignment on `regroup`.
     * A member objective's `targetId` is more specific than the shared
     * objective and wins `assignedTargetId`; role/element remain metadata.
     * @param {object[]} members Entries from {@link collectMembers}.
     * @param {object} [context]
     * @param {string|null} [context.leaderId] Elected/retained leader id.
     * @param {object} [context.assignments] Explicit `combatantId → task`
     *   or `combatantId → {task, role?, element?, objective?}`.
     * @param {boolean} [context.allowFlank] `false` disables the default
     *   flank group.
     * @param {boolean} [context.regroup] Force every member to `regroup`.
     * @param {object} [context.objective] `{targetId, flankTargetId}` shared
     *   team objective.
     * @param {string|null} [context.explicitTargetId] Hard caller-ordered
     *   shared target; suppress-and-bound cone metadata may not redirect it.
     * @returns {object[]} Assignments `{combatantId, tokenId, task, groupId,
     *   leader, assignedTargetId, role?, element?, objective?}` in
     *   deterministic order.
     */
    function assignTasks(members, context = {}) {
        const sorted = [...(members ?? [])].sort((a, b) =>
            String(a.combatantId).localeCompare(String(b.combatantId)));
        const explicit = context.assignments && typeof context.assignments === "object"
            ? context.assignments : null;
        const allowFlank = context.allowFlank !== false && sorted.length >= 2;
        const assaultCap = Math.max(1, _finiteOr(context.assaultCap, 1));
        const flankCap = Math.max(0, _finiteOr(context.flankCap, 1));
        // `assaultCap` counts the leader's own assault slot: the
        // non-leader quota is what remains once the leader is placed
        // (a leaderless call lets the first member lead the push).
        const leaderPresent = sorted.some(
            member => member.combatantId === context.leaderId);
        const assaultQuota = Math.max(0, assaultCap - (leaderPresent ? 1 : 0));
        let assaultAssigned = 0;
        let flankAssigned = 0;
        return sorted.map(member => {
            let task = null;
            const forced = normalizeFireteamAssignment(explicit?.[member.combatantId]);
            if (forced) task = forced.task;
            else if (context.regroup === true) task = "regroup";
            else if (member.combatantId === context.leaderId) task = "assault";
            else if (assaultAssigned < assaultQuota) task = "assault";
            else if (allowFlank && flankAssigned < flankCap) task = "flank";
            else {
                task = "support";
            }
            if (!FIRETEAM_TASKS.includes(task)) task = "support";
            // The quota counts non-leader assaults only — the leader's
            // own slot is separate (`assaultQuota` already excludes it).
            if (task === "assault" && member.combatantId !== context.leaderId) {
                assaultAssigned++;
            }
            if (task === "flank") flankAssigned++;
            // Issue #88: the pincer composition signs its flank elements
            // (`flank-left`/`flank-right`) and the element is the group
            // identity — the barrier, reservation keys and planning order
            // follow it. Legacy assignments without an element keep the
            // historical single `flank-1` group.
            const groupId = task === "flank"
                ? (/^flank-.+/.test(forced?.element ?? "") ? forced.element : "flank-1")
                : "main";
            // Issue #16/#85: a shared objective may restrict its target to
            // the members that actually contribute kill-EV. Scored focus is
            // stricter: `assignedMembers` is the capacity-limited assignment
            // set and overflow members receive no `assignedTargetId` even
            // though they remain in informational `capableMembers`. Issue #91:
            // a member-scoped objective target is more specific than every
            // shared target channel and therefore wins `assignedTargetId`;
            // role/element remain metadata and never enter the reservation key.
            const assignedList = context.objective?.assignedMembers;
            const objectiveRestricted = Array.isArray(assignedList)
                ? !assignedList.includes(member.combatantId)
                : (Array.isArray(context.objective?.capableMembers)
                    && !context.objective.capableMembers.includes(member.combatantId));
            const sharedTargetId = objectiveRestricted ? null : (task === "flank"
                ? (context.objective?.flankTargetId ?? context.objective?.targetId ?? null)
                : (context.objective?.targetId ?? null));
            const suppressionConeMetadata = forced?.objective?.type === SUPPRESS_AND_BOUND;
            const assignedTargetId = suppressionConeMetadata && context.explicitTargetId != null
                ? context.explicitTargetId
                : (forced?.objective?.targetId ?? sharedTargetId);
            const assignment = {
                combatantId: member.combatantId,
                tokenId: member.tokenId ?? null,
                task,
                groupId,
                leader: member.combatantId === context.leaderId,
                assignedTargetId
            };
            if (forced?.role) assignment.role = forced.role;
            if (forced?.element) assignment.element = forced.element;
            if (forced?.objective) assignment.objective = _jsonClone(forced.objective);
            // Focus is additive metadata, never a rewrite of an explicit or
            // tactic-authored role/element/objective. Only an otherwise
            // unroled member actually assigned to the focus target receives
            // the marker; kill mode stays the legacy unmarked convergence.
            if (!assignment.role && context.objective?.mode === "focus"
                && Array.isArray(assignedList)
                && assignedList.includes(member.combatantId)
                && assignedTargetId != null
                && String(assignedTargetId) === String(context.objective.targetId)) {
                assignment.role = "focus";
            }
            return assignment;
        });
    }

    /**
     * Preferred cohesion distance for a team: explicit context value, then
     * any member flag, then the world setting, then the module default.
     * @param {object[]} members Entries from {@link collectMembers}.
     * @param {object} context
     * @returns {number}
     */
    function _preferredCohesion(members, context = {}) {
        if (Number.isFinite(context.preferredCohesion)
            && context.preferredCohesion > 0) {
            return context.preferredCohesion;
        }
        for (const member of members ?? []) {
            const flagged = member?.team?.preferredCohesion;
            if (Number.isFinite(flagged) && flagged > 0) return flagged;
        }
        return getPreferredCohesion();
    }

    /**
     * Evaluate a member endpoint against the soft cohesion rule. The result
     * never forbids movement outright — it reports whether the endpoint is
     * within preferred cohesion, whether the member performs a legal
     * detached maneuver and the utility penalty applied to the team score.
     * @param {object} input
     * @param {{x: number|null, y: number|null}} input.endpoint Candidate
     *   endpoint in the same coordinate space as `center`.
     * @param {{x: number|null, y: number|null}} input.center Team centre
     *   (leader position or centroid).
     * @param {number} [input.unitsPerPixel] Convert canvas distances to scene units.
     * @param {number} input.preferredCohesion Distance in scene units.
     * @param {string} input.task Member task.
     * @param {number|null} [input.detachedUntilPhase] Phase index bounding
     *   the separation.
     * @param {number} [input.maxDetachedPhases] Separation bound
     *   (default {@link DEFAULT_MAX_DETACHED_PHASES}).
     * @param {boolean} [input.rejoinAvailable] Whether a legal rejoin point
     *   or regroup condition exists.
     * @param {boolean} [input.reachable] Whether the endpoint is reachable.
     * @returns {{within: boolean, distance: number|null, detached: boolean,
     *   allowed: boolean, penalty: number, reason: string}}
     */
    function evaluateCohesion({
        endpoint = null,
        center = null,
        unitsPerPixel = 1,
        preferredCohesion = DEFAULT_PREFERRED_COHESION,
        task = "support",
        detachedUntilPhase = null,
        maxDetachedPhases = DEFAULT_MAX_DETACHED_PHASES,
        rejoinAvailable = false,
        reachable = true
    } = {}) {
        const cohesion = Number.isFinite(preferredCohesion) && preferredCohesion > 0
            ? preferredCohesion : DEFAULT_PREFERRED_COHESION;
        const distance = Number.isFinite(endpoint?.x) && Number.isFinite(endpoint?.y)
            && Number.isFinite(center?.x) && Number.isFinite(center?.y)
            ? Math.hypot(endpoint.x - center.x, endpoint.y - center.y) * unitsPerPixel
            : null;
        if (distance === null) {
            return {
                within: true,
                distance: null,
                detached: false,
                allowed: true,
                penalty: 0,
                reason: "cohesion-unknown"
            };
        }
        const overshoot = distance - cohesion;
        if (overshoot <= 1e-9) {
            return {
                within: true,
                distance,
                detached: false,
                allowed: true,
                penalty: 0,
                reason: "within-cohesion"
            };
        }
        // Beyond preferred cohesion: a detached maneuver is legal only for
        // flank/assault tasks with a reachable endpoint, a bounded
        // separation and a legal rejoin condition.
        if (DETACHED_TASKS.has(task)) {
            if (reachable !== true) {
                return {
                    within: false, distance, detached: false, allowed: false,
                    penalty: overshoot, reason: "endpoint-unreachable"
                };
            }
            if (!Number.isFinite(detachedUntilPhase)
                || detachedUntilPhase > maxDetachedPhases) {
                return {
                    within: false, distance, detached: false, allowed: false,
                    penalty: overshoot, reason: "separation-unbounded"
                };
            }
            if (rejoinAvailable !== true) {
                return {
                    within: false, distance, detached: false, allowed: false,
                    penalty: overshoot, reason: "no-rejoin"
                };
            }
            return {
                within: false,
                distance,
                detached: true,
                allowed: true,
                penalty: Math.round((overshoot * 0.25) * 1e6) / 1e6,
                reason: "detached-maneuver"
            };
        }
        // Ordinary tasks may still leave cohesion — it is a soft scoring
        // penalty, never a hard prohibition.
        return {
            within: false,
            distance,
            detached: false,
            allowed: true,
            penalty: Math.round(overshoot * 1e6) / 1e6,
            reason: "beyond-cohesion"
        };
    }

    /**
     * Deterministic rejoin/regroup points for a team: the leader position
     * first, then the centroid of the non-detached members. Accepts a
     * member list or a TeamPlan/team object exposing `members`.
     * @param {object[]|object} membersOrTeam Member entries (with
     *   `position`) or `{members}`.
     * @param {object} [context]
     * @param {string|null} [context.leaderId] Leader combatant id whose
     *   position leads the rejoin candidates.
     * @returns {object[]} Frozen points `{x, y, source}`.
     */
    function regroupPoints(membersOrTeam, context = {}) {
        const members = Array.isArray(membersOrTeam)
            ? membersOrTeam
            : (membersOrTeam?.members ?? []);
        const positions = new Map();
        for (const member of members) {
            const pos = member?.position ?? member?.assignedEndpoint ?? null;
            if (Number.isFinite(pos?.x) && Number.isFinite(pos?.y)) {
                positions.set(member.combatantId ?? member.tokenId, pos);
            }
        }
        const points = [];
        const leaderId = context.leaderId
            ?? (Array.isArray(membersOrTeam) ? null : membersOrTeam?.leaderId);
        const leader = leaderId
            ? members.find(member => member.combatantId === leaderId)
            : null;
        const leaderPos = leader?.position ?? leader?.assignedEndpoint ?? null;
        if (Number.isFinite(leaderPos?.x) && Number.isFinite(leaderPos?.y)) {
            points.push({ x: leaderPos.x, y: leaderPos.y, source: "leader" });
        }
        if (positions.size) {
            let cx = 0;
            let cy = 0;
            for (const pos of positions.values()) {
                cx += pos.x;
                cy += pos.y;
            }
            cx = Math.round((cx / positions.size) * 1e4) / 1e4;
            cy = Math.round((cy / positions.size) * 1e4) / 1e4;
            if (!points.some(p => p.x === cx && p.y === cy)) {
                points.push({ x: cx, y: cy, source: "centroid" });
            }
        }
        return _deepFreeze(points);
    }

    /**
     * Reservation table for target capacity and swept movement footprints.
     * Entries reserve in assignment order; a conflict records the winner and
     * the loser instead of assigning one resource twice.
     * @param {object[]} assignments Entries from {@link assignTasks}.
     * @param {Map|object} memberPlans `combatantId → plan` (or `{status, plan}`).
     * @param {object} [context]
     * @param {object} [context.taskCapacities] Override
     *   {@link TARGET_TASK_CAPACITY} per task.
     * @param {Map} [context.tokens] Token documents keyed by combatant id.
     * @returns {{targets: object[], endpoints: object[], routes: object[],
     *   conflicts: object[]}}
     */
    function reserveResources(assignments, memberPlans, context = {}) {
        const capacities = { ...TARGET_TASK_CAPACITY, ...(context.taskCapacities ?? {}) };
        const planOf = id => {
            const entry = memberPlans instanceof Map
                ? memberPlans.get(id)
                : memberPlans?.[id];
            return entry?.plan ?? entry ?? null;
        };
        const targets = [];
        const endpoints = [];
        const routes = [];
        const conflicts = [];
        const targetCount = new Map();
        const endpointOwner = new Map();
        const routeOwner = new Map();
        for (const assignment of assignments ?? []) {
            const plan = planOf(assignment.combatantId);
            const targetId = plan?.target?.tokenId ?? assignment.assignedTargetId ?? null;
            if (targetId) {
                const key = `${assignment.task}|${assignment.groupId ?? "main"}|${targetId}`;
                const capacity = _finiteOr(capacities[assignment.task], 1);
                const used = targetCount.get(key) ?? 0;
                const focusExempt = _focusAssigned(assignment, context.focus)
                    && _idListsOverlap([targetId], _focusIdentityIds(context.focus));
                if (used < capacity || focusExempt) {
                    targetCount.set(key, used + 1);
                    targets.push({
                        key,
                        task: assignment.task,
                        targetId,
                        memberId: assignment.combatantId
                    });
                } else {
                    conflicts.push({
                        type: "target",
                        key,
                        task: assignment.task,
                        targetId,
                        loserId: assignment.combatantId,
                        winnerId: targets.find(t => t.key === key)?.memberId ?? null,
                        reason: "target-capacity"
                    });
                }
            }
            const move = (plan?.steps ?? []).find(step => step?.type === "move");
            const to = move?.input?.to ?? null;
            if (to && Number.isFinite(to.x) && Number.isFinite(to.y)) {
                const memberId = assignment.combatantId;
                const token = context.tokens?.get(memberId);
                const end = movementCells(token, [to]);
                const swept = movementCells(token, [...(move.input.waypoints ?? []), to]);
                const key = `${to.x},${to.y}`;
                const endKeys = end.length ? end.map(offsetKey) : [`pixel:${key}`];
                const endpointConflict = endKeys.find(cell => endpointOwner.has(cell));
                const routeConflict = swept.map(offsetKey).find(cell => routeOwner.has(cell));
                if (endpointConflict || routeConflict) {
                    conflicts.push({
                        type: endpointConflict ? "endpoint" : "route",
                        key: endpointConflict ?? routeConflict,
                        loserId: memberId,
                        winnerId: endpointOwner.get(endpointConflict) ?? routeOwner.get(routeConflict),
                        reason: endpointConflict ? "endpoint-reserved" : "route-reserved"
                    });
                    continue;
                }
                for (const cell of endKeys) endpointOwner.set(cell, memberId);
                endpoints.push({ key, x: to.x, y: to.y, memberId, cells: end });
                for (const cell of swept) {
                    const cellKey = offsetKey(cell);
                    routeOwner.set(cellKey, memberId);
                    routes.push({ key: cellKey, ...cell, memberId });
                }
            }
        }
        return { targets, endpoints, routes, conflicts };
    }

    /**
     * Find a legal stopping cell within cohesion, not the leader's occupied
     * cell. A single full move is a conservative, bounded return budget.
     * @param {object} token Token document.
     * @param {object} center Projected leader centre in pixels.
     * @param {object} context Navigation, budget and optional projected origin.
     * @returns {Promise<object|null>} Verified route, or null if unavailable.
     */
    async function planRejoin(token, center, context = {}) {
        const navigation = _service("navigation", context.navigation);
        const size = context.grid?.size;
        const distance = context.grid?.distance;
        if (!navigation?.findCandidates || !center || !(size > 0) || !(distance > 0)) return null;
        const rates = context.rates ?? (await navigation.getMovementRates?.(token))?.rates;
        if (!(rates?.full > 0)) return null;
        const { candidates } = navigation.findCandidates(token, rates.full, {
            target: { x: center.x, y: center.y }, count: 6,
            weights: { distance: 1, los: 0, cover: 0 },
            origin: context.origin, reservations: context.reservations
        });
        const within = point => Math.hypot(point.x - center.x, point.y - center.y) / size * distance
            <= context.preferredCohesion + 1e-9;
        const best = candidates?.find(c => within(c) && c.waypoints?.length
            && Number.isInteger(c.i) && Number.isInteger(c.j));
        return best ? { point: { x: best.x, y: best.y, i: best.i, j: best.j },
            route: best.waypoints, cost: best.cost } : null;
    }

    /**
     * Combat lookup for validation: injected first, then the world.
     * @param {string|null} combatId
     * @param {object} [context]
     * @returns {object|null}
     */
    function _findCombat(combatId, context = {}) {
        if (context.combat) return context.combat;
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
     * Revision fingerprint of the live team state covered by
     * `validateTeamPlan`: combat identity, round, team id, leader id and
     * each member's position/defeated flag.
     * @param {object} combat
     * @param {object[]} members Live member entries.
     * @param {object} plan TeamPlan whose ids shape the fingerprint.
     * @returns {string}
     */
    function _teamRevision(combat, members, plan) {
        const parts = (plan?.members ?? []).map(entry => {
            const live = members.find(m => m.combatantId === entry.combatantId);
            const pos = live?.position ?? {};
            return [
                entry.combatantId,
                live ? pos.x ?? null : "missing",
                live ? pos.y ?? null : "missing",
                live?.defeated === true
            ];
        });
        return `t${fnv1a(stableStringify({
            combatId: combat?.id ?? null,
            round: combat?.round ?? null,
            teamId: plan?.teamId ?? null,
            leaderId: plan?.leaderId ?? null,
            members: parts
        }))}`;
    }

    /**
     * Team seed: injected `context.seed` wins, otherwise the team identity
     * is hashed so identical world state re-plans identically.
     * @param {object} context
     * @param {object} combat
     * @param {string} teamId
     * @returns {number}
     */
    function _seedFor(context, combat, teamId) {
        if (Number.isFinite(context.seed)) return context.seed >>> 0;
        const key = `${combat?.id}|${teamId}|${combat?.round}`;
        return parseInt(fnv1a(key), 16) >>> 0;
    }

    /**
     * Normalize the `team` argument of `buildTeamPlan`: a plain config
     * object, a bare team id string, or a document carrying the flag.
     * @param {*} team
     * @returns {{teamId: string|null, leaderId: string|null,
     *   teamPreset: string|null, preferredCohesion: number|null}}
     */
    function _normalizeTeamRef(team) {
        if (typeof team === "string") {
            return {
                teamId: team || null,
                leaderId: null,
                teamPreset: null,
                preferredCohesion: null,
                character: null
            };
        }
        if (team && typeof team === "object") {
            if (typeof team.getFlag === "function" || team.documentName
                || team.flags) {
                const resolved = resolveTeamConfig(team);
                return {
                    teamId: resolved.teamId,
                    leaderId: resolved.leaderId,
                    teamPreset: resolved.teamPreset,
                    preferredCohesion: resolved.preferredCohesion,
                    character: resolved.character
                };
            }
            return {
                teamId: team.teamId ?? null,
                leaderId: team.leaderId ?? null,
                teamPreset: team.teamPreset ?? null,
                preferredCohesion: Number.isFinite(team.preferredCohesion)
                    ? team.preferredCohesion : null,
                character: FIRETEAM_CHARACTERS.includes(team.character)
                    ? team.character : null,
                members: team.members
            };
        }
        return {
            teamId: null,
            leaderId: null,
            teamPreset: null,
            preferredCohesion: null,
            character: null
        };
    }

    /**
     * Shared normalized target list reused across member plans: the first
     * successful member plan's `snapshot.targets` re-normalized per member
     * (the `distance` field is stripped so each member measures its own).
     * @param {object|null} plan
     * @returns {object[]|null}
     */
    function _sharedTargets(plan) {
        const targets = plan?.snapshot?.targets;
        if (!Array.isArray(targets) || !targets.length) return null;
        return targets.map(({ distance, ...rest }) => ({ ...rest }));
    }

    /**
     * Unique string id list, preserving first-seen order.
     * @param {*} values
     * @returns {string[]}
     */
    function _uniqueIdList(values) {
        const seen = new Set();
        const out = [];
        for (const value of Array.isArray(values) ? values : []) {
            if (value == null) continue;
            const id = String(value);
            if (!id || seen.has(id)) continue;
            seen.add(id);
            out.push(id);
        }
        return out;
    }

    /**
     * Every planner identity key of the focus target. The planner matches
     * token ids, token uuid tails and actor ids; carrying all three keeps an
     * allow-list usable even when a caller used a different identity form.
     * @param {object|null} focus Focus descriptor.
     * @returns {string[]}
     */
    function _focusIdentityIds(focus) {
        return _uniqueIdList([focus?.targetId, focus?.targetUuid, focus?.actorId]);
    }

    /**
     * Whether two id lists overlap exactly or through a token-uuid tail.
     * @param {string[]} left
     * @param {string[]} right
     * @returns {boolean}
     */
    function _idListsOverlap(left, right) {
        const forms = id => {
            const text = String(id);
            const tail = text.includes(".") ? text.split(".").pop() : text;
            return [text, tail];
        };
        const wanted = new Set((right ?? []).flatMap(forms));
        return (left ?? []).some(id => wanted.has(String(id))
            || wanted.has(String(id).split(".").pop()));
    }

    /**
     * Whether the assignment belongs to the focus target's assigned set.
     * @param {object} assignment Assignment entry.
     * @param {object|null} focus Focus descriptor.
     * @returns {boolean}
     */
    function _focusAssigned(assignment, focus) {
        return Boolean(focus?.targetId != null
            && Array.isArray(focus?.assignedMembers)
            && focus.assignedMembers.includes(assignment?.combatantId)
            && assignment?.assignedTargetId != null
            && _idListsOverlap([assignment.assignedTargetId], _focusIdentityIds(focus)));
    }

    /**
     * Focus allow-list with hard caller constraints preserved: without a
     * caller allow-list the focus identities become the allow-list; with one,
     * the result is the semantic intersection. An empty intersection stays an
     * active empty list — the caller's stricter pool wins over the heuristic
     * focus rather than being silently widened.
     * @param {*} existing Caller `attackTargetIds`.
     * @param {object} focus Focus descriptor.
     * @returns {string[]}
     */
    function _focusAllowList(existing, focus) {
        const focusIds = _focusIdentityIds(focus);
        if (!Array.isArray(existing)) return focusIds;
        const caller = _uniqueIdList(existing);
        return _idListsOverlap(caller, focusIds) ? focusIds : [];
    }

    /**
     * Merge a focus deny-list into the caller's deny-list without dropping
     * any existing exclusions.
     * @param {*} existing Caller `excludedAttackTargetIds`.
     * @param {object} focus Focus descriptor.
     * @returns {string[]}
     */
    function _focusDenyList(existing, focus) {
        return _uniqueIdList([
            ...(Array.isArray(existing) ? existing : []),
            ..._focusIdentityIds(focus)
        ]);
    }

    /**
     * Attack-pool overrides of one member for the minimal split-awareness
     * focus contract. Assigned members keep full awareness and receive a
     * direct-attack allow-list; capable overflow keeps full awareness and
     * receives the focus target as a deny-list entry.
     * @param {string} combatantId
     * @param {object|null} focus Focus descriptor.
     * @param {object} context Original build context (caller pools win ties).
     * @param {object|null} [assignment] Resolved member assignment. A
     *   member-scoped objective target is an explicit order: when it redirects
     *   the member away from the focus it wins over both focus allow and
     *   overflow deny narrowing; when it names the focus target it simply
     *   aligns with the normal focus pool.
     * @returns {object}
     */
    function _focusAttackPoolOverrides(combatantId, focus, context, assignment = null) {
        if (!focus?.targetId) return {};
        const focusIds = _focusIdentityIds(focus);
        const memberObjectiveTarget = assignment?.objective?.targetId ?? null;
        const redirected = memberObjectiveTarget != null
            && !_idListsOverlap([memberObjectiveTarget], focusIds);
        if (redirected) return {};
        if (Array.isArray(focus.assignedMembers) && focus.assignedMembers.includes(combatantId)) {
            return { attackTargetIds: _focusAllowList(context.attackTargetIds, focus) };
        }
        if (!redirected && memberObjectiveTarget != null
            && Array.isArray(focus.excludedMembers) && focus.excludedMembers.includes(combatantId)
            && _idListsOverlap([memberObjectiveTarget], focusIds)) {
            return {};
        }
        if (Array.isArray(focus.excludedMembers) && focus.excludedMembers.includes(combatantId)) {
            return {
                excludedAttackTargetIds: _focusDenyList(context.excludedAttackTargetIds, focus)
            };
        }
        return {};
    }

    /**
     * Whether a task/target key already reached its reservation capacity.
     * @param {Map} counts `key → used` map.
     * @param {object} capacities Task capacities.
     * @param {string} task
     * @param {string|null} targetId
     * @param {string} [groupId] Maneuver group of the reservation key
     *   (issue #88 — the two signed pincer elements hold independent
     *   per-element capacities).
     * @returns {boolean}
     */
    function _targetAtCapacity(counts, capacities, task, targetId, groupId = "main") {
        if (!targetId) return false;
        // Issue #88: the reservation key carries the maneuver group so the
        // two signed pincer flank elements hold independent per-element
        // capacities instead of competing for one shared flank slot.
        const key = `${task}|${groupId ?? "main"}|${targetId}`;
        const used = counts.get(key) ?? 0;
        return used >= _finiteOr(capacities[task], 1);
    }

    /**
     * Reserve the targets a member may still plan against: injected/shared
     * targets minus entries already at capacity for the member's task.
     * @param {object[]} targets Candidate targets (normalized shape).
     * @param {Map} counts Reservation counts.
     * @param {object} capacities Task capacities.
     * @param {object} assignment Member assignment.
     * @param {object|null} [focus] Active concentrate-fire descriptor.
     * @returns {object[]}
     */
    function _availableTargets(targets, counts, capacities, assignment, focus = null) {
        const focusIds = _focusIdentityIds(focus);
        return (targets ?? []).filter(target => {
            const id = target?.tokenId
                ?? (typeof target?.tokenUuid === "string"
                    ? target.tokenUuid.split(".").pop() : null);
            const targetIds = _uniqueIdList([target?.tokenId, target?.tokenUuid, target?.actorId, id]);
            // Focus assignment capacity is already enforced by the selector's
            // focusCap. The ordinary per-task reservation cap must not evict
            // members the selector deliberately concentrated on the target.
            if (_focusAssigned(assignment, focus)
                && _idListsOverlap(targetIds, focusIds)) {
                return true;
            }
            return !_targetAtCapacity(counts, capacities, assignment.task, id, assignment.groupId);
        });
    }

    /**
     * Member target list for one `planTurn` call: a legacy non-focus explicit
     * target keeps the historical singleton narrowing, while a focus-assigned
     * member deliberately keeps the full reservation-filtered awareness pool —
     * its direct attacks are narrowed separately through `attackTargetIds`.
     * @param {object} input
     * @param {object[]} input.base Shared/injected normalized targets.
     * @param {Map} input.counts Reservation counts.
     * @param {object} input.capacities Task capacities.
     * @param {object} input.assignment Member assignment.
     * @param {object|null} [input.focus] Concentrate-fire descriptor.
     * @returns {object[]|undefined} Undefined lets the planner resolve.
     */
    function _memberTargets({ base, counts, capacities, assignment, focus = null }) {
        if (!Array.isArray(base)) return undefined;
        const targets = _availableTargets(base, counts, capacities, assignment, focus);
        if (assignment.assignedTargetId && !_focusAssigned(assignment, focus)) {
            const assigned = targets.filter(target => {
                const id = target?.tokenId
                    ?? (typeof target?.tokenUuid === "string"
                        ? target.tokenUuid.split(".").pop() : null);
                return id === assignment.assignedTargetId
                    || target?.tokenUuid === assignment.assignedTargetId;
            });
            if (assigned.length) return assigned;
        }
        return targets;
    }

    /**
     * Verify the serialized plan, not a score or the proposed anchor.
     * Commitment and reservation retries can change the actual attack.
     * @param {object} result Member planner result.
     * @param {object} context Attack geometry and cutoff.
     * @returns {object} Flank evidence or rejection reason.
     */
    function _flankProof(result, context) {
        const plan = result?.plan;
        const steps = plan?.steps ?? [];
        const index = steps.findIndex(step => step?.type === "attack" || step?.type === "test");
        if (index < 0) {
            const reasons = result?.diagnostics?.rejected?.map(entry => entry.reason) ?? [];
            const reason = ["flank-route-unproven", "flank-angle-unmet"]
                .find(code => reasons.includes(code)) ?? "flank-attack-unavailable";
            return { reason };
        }
        const attack = steps[index].input;
        const target = plan.snapshot?.targets?.find(entry => attack?.targetTokenId
            ? entry.tokenId === attack.targetTokenId
            : entry.tokenUuid && entry.tokenUuid === attack?.targetTokenUuid);
        const move = steps.find(step => step?.type === "move");
        if (move && steps.indexOf(move) > index) return { reason: "flank-route-unproven" };
        return checkSpecOpsFlank({
            target,
            aim: attack?.targetPoint,
            move: move ? {
                ...move.input?.to,
                waypoints: move.input?.waypoints,
                approximate: move.input?.approximate,
                cost: move.cost?.movement
            } : null
        }, { ...context, selfPos: plan.snapshot?.self });
    }

    /**
     * Authoritative suppression cone of the selected suppressor plan. The
     * executable attack step carries direction/angle/range but not an origin;
     * the origin is therefore the endpoint of the move preceding that attack,
     * or the suppressor token footprint centre when the shot is in place.
     * Range is serialized in scene units by the planner step contract and is
     * converted to pixels with the scene grid.
     * @param {object} input
     * @param {object} input.member Suppressor member entry.
     * @param {object} input.result Member planner result.
     * @param {object} input.tactic Suppress-and-bound descriptor.
     * @param {object|null} input.scene Planning scene.
     * @returns {object|null} Serialized zone `{x,y,direction,angleDeg,rangePx}`.
     */
    function _authoritativeSuppressionCone({ member, result, tactic, scene }) {
        const steps = result?.plan?.steps ?? [];
        const index = steps.findIndex(step =>
            (step?.type === "attack" || step?.type === "test")
            && step.input?.suppressionFire === true
            && step.input?.template);
        if (index < 0) return null;
        const input = steps[index].input;
        const priorMove = steps.slice(0, index).reverse()
            .find(step => step?.type === "move" && step.input?.to);
        let origin = null;
        if (priorMove && Number.isFinite(priorMove.input.to?.x) && Number.isFinite(priorMove.input.to?.y)) {
            origin = { x: priorMove.input.to.x, y: priorMove.input.to.y };
        } else {
            const token = _tokenDoc(member?.combatant?.token);
            origin = specOpsTokenCenter(token, scene, member?.position);
        }
        if (!Number.isFinite(origin?.x) || !Number.isFinite(origin?.y)) return null;
        const grid = scene?.grid ?? {};
        const size = _finiteOr(grid.size, 0);
        const distance = _finiteOr(grid.distance, 0);
        const pxPerUnit = size > 0 && distance > 0 ? size / distance : 1;
        const fallbackCone = tactic?.cone ?? tactic?.objective?.suppressionCone ?? {};
        const direction = _finiteOr(input.template.direction, fallbackCone.direction);
        const angleDeg = _finiteOr(input.template.angle ?? input.template.angleDeg,
            fallbackCone.angleDeg ?? fallbackCone.angle);
        const rangePx = Number.isFinite(input.template.range)
            ? input.template.range * pxPerUnit
            : _finiteOr(fallbackCone.rangePx, NaN);
        if (!Number.isFinite(direction) || !(angleDeg > 0) || !(rangePx > 0)) return null;
        return {
            x: Math.round(origin.x * 1e4) / 1e4,
            y: Math.round(origin.y * 1e4) / 1e4,
            direction,
            angleDeg,
            rangePx: Math.round(rangePx * 1e4) / 1e4,
            ownerId: member?.combatantId ?? tactic?.suppressorId ?? null,
            kind: "suppression"
        };
    }

    /**
     * First point of a member move entering a suppression zone. Both the
     * serialized endpoint and every route waypoint are checked; stay plans
     * and attack-in-place plans have no move step and are legal by contract.
     * @param {object} result Member planner result.
     * @param {object} zone Authoritative serialized suppression zone.
     * @returns {object|null} `{point, stepId}` or null.
     */
    function _suppressionMoveViolation(result, zone) {
        if (!zone) return null;
        for (const step of result?.plan?.steps ?? []) {
            if (step?.type !== "move") continue;
            const points = [
                ...(Array.isArray(step.input?.waypoints) ? step.input.waypoints : []),
                step.input?.to
            ].filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y));
            for (const point of points) {
                if (pointInSuppressionZone(point, zone)) {
                    return { point: { x: point.x, y: point.y }, stepId: step.id ?? null };
                }
            }
        }
        return null;
    }

    /**
     * Build the phased execution layout. Flank-group members always precede
     * the main group inside every phase; the action phase is gated by a
     * synchronization barrier that requires the detached/mover assignments
     * to be satisfied first.
     * @param {object} input
     * @param {object[]} input.ordered Ordered member entries.
     * @param {Map} input.assignMap `combatantId → assignment`.
     * @param {Map} input.plans `combatantId → planTurn result`.
     * @param {object[]} input.members Assignments with verified rejoin routes.
     * @param {boolean} [input.flankProven] Stationary flankers are already at their firing cells.
     * @returns {object[]} Phase descriptors `{id, name, barrier, steps}`.
     */
    function _buildPhases({ ordered, assignMap, plans, members, flankProven = false }) {
        const sortKey = member => {
            const group = assignMap.get(member.combatantId)?.groupId ?? "main";
            const rank = group === "main" ? 1 : 0;
            return `${rank}|${member.combatantId}`;
        };
        const sorted = [...ordered].sort((a, b) =>
            sortKey(a).localeCompare(sortKey(b)));
        const movement = [];
        const action = [];
        for (const member of sorted) {
            const result = plans.get(member.combatantId);
            const plan = result?.plan;
            if (!plan) continue;
            const steps = plan.steps ?? [];
            steps.forEach((step, index) => {
                const ref = {
                    combatantId: member.combatantId,
                    planId: plan.id,
                    stepIndex: index,
                    type: step?.type ?? null
                };
                if (step?.type === "move") {
                    movement.push(ref);
                } else if (step?.type === "attack" || step?.type === "test") {
                    action.push(ref);
                }
            });
        }
        const moverIds = movement.map(step => step.combatantId);
        // Issue #88: every signed flank group (`flank-` prefix), not only
        // the legacy `flank-1`, joins the barrier requirement while the
        // maneuver is unproven.
        const flankIds = flankProven ? [] : sorted
            .filter(member => {
                const group = assignMap.get(member.combatantId)?.groupId ?? "main";
                return typeof group === "string" && group.startsWith("flank-");
            })
            .map(member => member.combatantId);
        const required = [...new Set([...flankIds, ...moverIds])];
        const barrier = required.length
            ? {
                id: "barrier-movement",
                afterPhase: "phase-0",
                requiredAssignmentIds: required,
                failurePolicy: "hold"
            }
            : null;
        return [
            { id: "phase-0", name: "movement", barrier: null, steps: movement },
            { id: "phase-1", name: "action", barrier, steps: action },
            { id: "phase-2", name: "regroup", barrier: null,
                steps: members.filter(member => member.rejoinPoint).map(member => ({
                    combatantId: member.combatantId, planId: member.planId, type: "rejoin"
                })) }
        ];
    }


    /**
     * Grid info `{size, distance}` for pixel→scene-unit conversion inside
     * the kill-EV model; injected `context.grid`, then the combat scene.
     * @param {object} combat
     * @param {object} context
     * @returns {object|null}
     */
    function _convergenceGrid(combat, context) {
        const grid = context.grid ?? context.scene?.grid ?? combat?.scene?.grid ?? null;
        const size = _finiteOr(grid?.size, 0);
        const distance = _finiteOr(grid?.distance, 0);
        return size > 0 && distance > 0 ? { size, distance } : null;
    }

    /**
     * Scene-unit distance between two pixel points (1:1 without grid).
     * @param {{x: number, y: number}} a
     * @param {{x: number, y: number}} b
     * @param {object|null} grid
     * @returns {number|null}
     */
    function _convergenceDistance(a, b, grid) {
        if (!Number.isFinite(a?.x) || !Number.isFinite(a?.y)
            || !Number.isFinite(b?.x) || !Number.isFinite(b?.y)) return null;
        const px = Math.hypot(b.x - a.x, b.y - a.y);
        return grid ? px / grid.size * grid.distance : px;
    }

    /**
     * Merge status id views (`Set`/array/iterable or truthy-map) into a
     * sorted deterministic list. Used for the focus selector's normalized
     * vulnerability input.
     * @param {...*} sources Status collections.
     * @returns {string[]}
     */
    function _mergeStatusIds(...sources) {
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
     * Combatant lookup for a target identity. Matches token id against the
     * combatant/token document id, token uuid exactly and actor id when the
     * injection carries it.
     * @param {object} combat Combat document.
     * @param {object} target `{tokenId, tokenUuid, actorId}`.
     * @returns {object|null}
     */
    function _combatantForTarget(combat, target) {
        for (const other of _list(combat?.combatants)) {
            const doc = _tokenDoc(other?.token);
            if (!doc && !other?.actor) continue;
            if (target?.tokenId != null && (other?.tokenId === target.tokenId
                || doc?.id === target.tokenId
                || String(other?.tokenId ?? "") === String(target.tokenId)
                || String(doc?.id ?? "") === String(target.tokenId))) {
                return other;
            }
            if (target?.tokenUuid && doc?.uuid === target.tokenUuid) return other;
            if (target?.actorId != null
                && String((other?.actor ?? doc?.actor)?.id ?? "") === String(target.actorId)) {
                return other;
            }
        }
        return null;
    }

    /**
     * Expected damage output of a target for focus scoring. Explicit
     * normalized `threatEv` wins, then injected emitter/profile shorthand,
     * then the live actor loadout. Unknown loadouts contribute 0 (the pure
     * selector still applies its small unknown-threat floor in exposure).
     * @param {object|null} raw Injected target or profile carrier.
     * @param {object|null} actor Live actor document.
     * @returns {number}
     */
    function _threatEvOf(raw = null, actor = null) {
        const profile = raw?.threatProfile ?? raw ?? null;
        for (const value of [raw?.threatEv, profile?.threatEv, raw?.ev, profile?.ev]) {
            if (Number.isFinite(value)) return Math.max(0, value);
        }
        let best = 0;
        const emitters = Array.isArray(profile?.emitters) ? profile.emitters : [];
        for (const emitter of emitters) {
            const ev = Number.isFinite(emitter?.ev)
                ? emitter.ev : expectedDamageOf(emitter?.damage ?? 0);
            if (ev > best) best = ev;
        }
        if (!(best > 0)) {
            const damage = expectedDamageOf(profile?.damage ?? 0);
            if (damage > best) best = damage;
        }
        if (!(best > 0) && actor) {
            for (const emitter of weaponEmitters(actor)) {
                if (emitter.ev > best) best = emitter.ev;
            }
        }
        return Math.max(0, best);
    }

    /**
     * Convergence/focus target list: injected `context.targets` win as the
     * caller's perceived contact list; otherwise the combat scan returns
     * every living non-hidden combatant hostile to the team's shared
     * disposition. Both paths normalize the inputs the pure concentrate-fire
     * selector needs (corrected effective wounds, statuses, reaction record,
     * threat EV and allied melee engagement). Injected wounds stay
     * authoritative — a missing wounds field means unknown, even when a
     * matching live document happens to exist.
     * @param {object} input
     * @param {object[]} input.members Team member entries.
     * @param {object} input.combat Combat document.
     * @param {object} input.context `buildTeamPlan` context.
     * @returns {object[]} Normalized target entries.
     */
    function _convergentTargets({ members, combat, context }) {
        if (Array.isArray(context.targets) && context.targets.length) {
            return context.targets.map(target => {
                const other = _combatantForTarget(combat, target);
                const doc = _tokenDoc(other?.token);
                const actor = other?.actor ?? doc?.actor ?? null;
                const wounds = normalizeFocusWounds(target?.wounds, target?.woundsKnown);
                return {
                    tokenId: target?.tokenId ?? null,
                    tokenUuid: target?.tokenUuid ?? null,
                    actorId: target?.actorId ?? actor?.id ?? null,
                    x: _finiteOr(target?.x, null),
                    y: _finiteOr(target?.y, null),
                    wounds: wounds.effective,
                    woundsKnown: wounds.known,
                    statuses: _mergeStatusIds(target?.statuses, other?.actor?.statuses,
                        doc?.statuses, doc?.actor?.statuses),
                    reactionUsed: target?.reactionUsed
                        ?? _readFlag(other, FLAG_KEYS.reactionUsed) ?? null,
                    threatEv: _threatEvOf(target, actor),
                    allyEngaged: target?.allyEngaged === true ? true
                        : (target?.allyEngaged === false ? false : null),
                    source: target?.source ?? "injected",
                    hidden: target?.hidden === true,
                    visible: target?.visible,
                    seen: target?.seen,
                    los: target?.los,
                    canAttack: target?.canAttack,
                    attackable: target?.attackable,
                    // Issue #87: the interdiction shooter projection reads
                    // per-class EVs and the charge rate. Explicitly
                    // injected fields win; otherwise derive them from the
                    // live actor so visible contacts carry the profile
                    // the trigger gates need. Extra keys are inert for
                    // the concentrate-fire selector.
                    ...(target?.emitters !== undefined ? { emitters: target.emitters }
                        : actor ? { emitters: weaponEmitters(actor) } : {}),
                    ...(Number.isFinite(target?.rangedEV) ? { rangedEV: target.rangedEV } : {}),
                    ...(Number.isFinite(target?.meleeEV) ? { meleeEV: target.meleeEV } : {}),
                    chargeRate: _finiteOr(target?.chargeRate,
                        _finiteOr(actor?.system?.movement?.charge, null))
                };
            }).filter(entry => entry.tokenId || entry.tokenUuid);
        }
        const memberIds = new Set(members.map(m => m.combatantId));
        const leaderDoc = _tokenDoc(members[0]?.combatant?.token);
        const selfDisposition = _finiteOr(
            leaderDoc?.disposition ?? members[0]?.combatant?.disposition, 0);
        const hostileOptions = {
            includeNeutral: context.includeNeutral === true,
            dispositions: Array.isArray(context.dispositions) ? context.dispositions : null
        };
        const targets = [];
        for (const other of _list(combat?.combatants)) {
            if (!other || _isMissing(other) || memberIds.has(other.id)) continue;
            const doc = _tokenDoc(other.token);
            if (!doc || _isMissing(doc) || doc.hidden === true) continue;
            if (other.defeated === true) continue;
            if (!isHostileDisposition(selfDisposition,
                _finiteOr(doc.disposition ?? other.disposition, 0), hostileOptions)) {
                continue;
            }
            const pos = _tokenPosition(doc);
            const actor = other.actor ?? doc.actor ?? null;
            const wounds = normalizeFocusWounds(actor?.system?.wounds);
            // The live scan treats non-positive remaining wounds as an
            // already-down corpse and never offers it as a fresh focus
            // candidate. Injected callers may still deliberately inject such
            // a critical-but-valid target; the pure selector then applies its
            // finishable-zero semantics.
            if (wounds.known && Number.isFinite(wounds.effective)
                && wounds.effective <= 0) continue;
            targets.push({
                tokenId: other.tokenId ?? doc.id ?? null,
                tokenUuid: typeof doc.uuid === "string" ? doc.uuid : null,
                actorId: actor?.id ?? null,
                x: pos.x,
                y: pos.y,
                wounds: wounds.effective,
                woundsKnown: wounds.known,
                statuses: _mergeStatusIds(other.actor?.statuses, doc.statuses, doc.actor?.statuses),
                reactionUsed: _readFlag(other, FLAG_KEYS.reactionUsed) ?? null,
                threatEv: _threatEvOf(null, actor),
                allyEngaged: null,
                // Issue #87: visible live hostiles carry their shooter
                // projection for the interdiction trigger gates.
                ...(actor ? { emitters: weaponEmitters(actor) } : {}),
                chargeRate: _finiteOr(actor?.system?.movement?.charge, null)
            });
        }
        return targets;
    }

    /**
     * One member's kill-EV contribution against a target: the best
     * emitter it can actually bring to bear — a ranged emitter counts
     * when the target is inside its range, a melee emitter inside reach
     * plus the charge band. Members with no weapon data or no usable
     * emitter contribute 0; an unknown distance counts conservatively
     * (the member is assumed able to engage).
     * @param {object} member Member entry (`position`, `combatant`).
     * @param {object[]} emitters Entries from `weaponEmitters`.
     * @param {object} target Convergence target.
     * @param {object|null} grid Grid info for the px→unit conversion.
     * @returns {number}
     */
    function _memberKillEV(member, emitters, target, grid) {
        const distance = _convergenceDistance(member?.position, target, grid);
        let best = 0;
        for (const emitter of emitters ?? []) {
            if (!(emitter?.ev > 0)) continue;
            if (distance !== null) {
                const reach = emitter.melee === true
                    ? _finiteOr(emitter.range, 2) + MELEE_KILL_ALLOWANCE
                    : _finiteOr(emitter.range, 0);
                if (distance > reach + 1e-9) continue;
            }
            best = Math.max(best, emitter.ev);
        }
        return best;
    }

    /**
     * Melee reach used for the concentrate-fire gang-up input. A member's
     * best melee emitter wins; any combatant can otherwise swing unarmed at
     * the standard melee reach. Distance unknown means not engaged.
     * @param {object[]} emitters Member weapon emitters.
     * @returns {number} Reach in scene units.
     */
    function _memberMeleeReach(emitters) {
        let best = 0;
        for (const emitter of emitters ?? []) {
            if (emitter?.melee === true && Number.isFinite(emitter.range)) {
                best = Math.max(best, emitter.range);
            }
        }
        return best > 0 ? best : DEFAULT_MELEE_REACH;
    }

    /**
     * Whether any living enabled team member is in melee reach of the
     * target. This is deliberately team-local (not a full scene scan): it
     * feeds both the ranged-cover friendly-fire penalty and the assault
     * gang-up bonus of the pure selector.
     * @param {object[]} profiles `{member, emitters}` entries.
     * @param {object} target Normalized target.
     * @param {object|null} grid Grid info.
     * @returns {boolean}
     */
    function _teamAllyEngaged(profiles, target, grid) {
        for (const { member, emitters } of profiles ?? []) {
            const distance = _convergenceDistance(member?.position, target, grid);
            if (distance !== null
                && distance <= _memberMeleeReach(emitters) + 1e-9) {
                return true;
            }
        }
        return false;
    }

    /**
     * Injected-contact visibility gate. An injected list is the caller's
     * perceived contact list, but memory/relay entries and entries explicitly
     * marked invisible/unattackable still cannot become the live focus. A
     * missing `canAttack` flag is neutral for backward compatibility with the
     * legacy minimal convergence fixtures.
     * @param {object} target Normalized injected target.
     * @returns {boolean}
     */
    function _injectedFocusEligible(target) {
        if (!target || target.hidden === true) return false;
        if (target.visible === false || target.seen === false || target.los === false) return false;
        if (target.canAttack === false || target.attackable === false) return false;
        return !["last-known", "team-contact", "relay", "intel", "memory"]
            .includes(target.source);
    }

    /**
     * Honest per-member LOS capability for deterministic focus assignment
     * ordering. The perception service's token-to-token probe is authoritative;
     * an explicit point probe (`context.los`, already used by planner tests and
     * integrations) is the fallback. Unknown/unproven LOS is simply not marked
     * capable — it never zeroes the member's kill-EV contribution.
     * @param {object} member Team member entry.
     * @param {object} target Normalized target.
     * @param {object|null} perception Perception service.
     * @param {object} combat Combat document.
     * @param {object} context Build context.
     * @returns {boolean}
     */
    function _memberLosCapable(member, target, perception, combat, context) {
        const memberDoc = _tokenDoc(member?.combatant?.token) ?? _tokenDoc(member?.token);
        const targetDoc = _combatTokenDoc(combat, target);
        if (memberDoc && targetDoc && typeof perception?.hasLineOfSight === "function") {
            try {
                return perception.hasLineOfSight(memberDoc, targetDoc) === true;
            } catch(_err) {
                // Fall through to the explicit point probe.
            }
        }
        if (typeof context?.los === "function"
            && Number.isFinite(member?.position?.x) && Number.isFinite(member?.position?.y)
            && Number.isFinite(target?.x) && Number.isFinite(target?.y)) {
            try {
                return context.los(member.position, target) === true;
            } catch(_err) {
                return false;
            }
        }
        return false;
    }

    /**
     * Concentrate-fire adapter (issue #85): enrich the fireteam scan into
     * normalized pure-selector inputs, apply the live visibility gate, compute
     * per-member kill-EV capabilities and invoke `selectFocusTarget`. The
     * selector stays document-free; this function is the only place that reads
     * actor loadouts/statuses/reaction flags. Its return object keeps the full
     * pure result for diagnostics while augmenting the descriptor with
     * `actorId` for planner attack-pool identity matching.
     * @param {object} input
     * @param {object[]} input.members Filtered living/enabled team members.
     * @param {object} input.combat Combat document.
     * @param {object} input.context `buildTeamPlan` context.
     * @param {string|null} input.teamPreset Resolved shared preset.
     * @param {number} [input.casualties] Defeated team members this combat.
     * @returns {{focus: object|null, result: object, targets: object[],
     *   allTargets: object[]}}
     */
    function _focusSelection({ members, combat, context, teamPreset, casualties = null }) {
        const allTargets = _convergentTargets({ members, combat, context });
        const injected = Array.isArray(context.targets) && context.targets.length > 0;
        const perception = injected ? null : _service("perception", context.perception);
        const live = (members ?? [])
            .filter(member => member.enabled !== false && member.defeated !== true);
        const profiles = live.map(member => ({
            member,
            emitters: weaponEmitters(member.combatant?.actor
                ?? _tokenDoc(member.combatant?.token)?.actor ?? null)
        }));
        const grid = _convergenceGrid(combat, context);
        const visible = allTargets.filter(target => injected
            ? _injectedFocusEligible(target)
            : _memberSees(live, target, perception, combat));
        const unseenTargetIds = allTargets
            .filter(target => !visible.includes(target))
            .map(target => target.tokenId ?? target.tokenUuid)
            .filter(id => id != null)
            .map(String)
            .sort();
        const targets = visible.map(target => ({
            ...target,
            allyEngaged: target.allyEngaged == null
                ? _teamAllyEngaged(profiles, target, grid)
                : target.allyEngaged === true
        }));
        const selectorMembers = profiles.map(({ member, emitters }) => {
            const capability = {};
            for (const target of targets) {
                const killEV = _memberKillEV(member, emitters, target, grid);
                if (!(killEV > 0)) continue;
                const entry = {
                    killEV,
                    losCapable: _memberLosCapable(member, target, perception, combat, context)
                };
                if (target.tokenId != null) capability[String(target.tokenId)] = entry;
                if (target.tokenUuid != null) capability[String(target.tokenUuid)] = entry;
            }
            return {
                combatantId: member.combatantId,
                enabled: member.enabled,
                defeated: member.defeated,
                capability,
                lastTarget: _readFlag(member.combatant, FLAG_KEYS.lastTarget) ?? null
            };
        });
        const result = selectFocusTarget({
            targets,
            members: selectorMembers,
            casualties: _finiteOr(context.casualties, casualties ?? 0),
            round: _finiteOr(combat?.round, context.round),
            preset: teamPreset,
            context,
            config: context.focusConfig ?? context.concentrateFire ?? null
        });
        const winner = result.focus
            ? targets.find(target => String(target.tokenId ?? target.tokenUuid ?? "")
                === String(result.focus.targetId)
                || String(target.tokenUuid ?? "") === String(result.focus.targetId))
            : null;
        const focus = result.focus
            ? { ...result.focus, actorId: winner?.actorId ?? null }
            : null;
        return {
            focus,
            result: {
                ...result,
                focus,
                diagnostics: {
                    ...result.diagnostics,
                    visibility: injected ? "injected" : "perception",
                    inputTargets: allTargets.length,
                    visibleTargets: targets.length,
                    unseenTargetIds,
                    attackPoolPolicy: {
                        callerAllowList: "intersect-focus",
                        callerDenyList: "preserved",
                        overflow: "append-focus-deny"
                    }
                }
            },
            targets,
            allTargets
        };
    }

    /**
     * Resolve the bounded team tactic for this plan (issues #412/#92).
     * Explicit `context.tactic` keeps the legacy caller-override contract: a
     * tactic factory `(input) => descriptor` or a ready serializable
     * descriptor `{name, reason, assignments, allowFlank, regroup, objective,
     * maxDetachedPhases, breakdown}`; `null`/`false` explicitly disables the
     * hook. Without an explicit override the per-preset tactic registry is
     * consulted — specOps is just the registered baseline maneuver, while
     * assault/rangedCover/hold currently have no selectors and fall back to
     * the default fireteam policy.
     * @param {object} input
     * @param {object[]} input.members Filtered member entries.
     * @param {string|null} input.leaderId Elected leader combatant id.
     * @param {string} input.teamId
     * @param {string|null} input.teamPreset Resolved shared team preset.
     * @param {number} input.seed Plan seed.
     * @param {object} input.combat Combat document.
     * @param {object} input.context `buildTeamPlan` context.
     * @param {object|null} [input.character] Party character reference
     *   forwarded to tactic selectors (interdiction memory rejection).
     * @param {object|null} [input.focusObjective] Concentrate-fire objective
     *   selected before the maneuver registry.
     * @param {*} [input.moraleTier] Committed team morale tier forwarded to
     *   the tactic selectors (issue #88 pincer morale gate).
     * @param {object|null} [input.moraleInfo] Full morale evaluation forwarded
     *   to stateless tactics (peel reads tier/counters without re-deriving them).
     * @param {object|null} [input.casualtyDetail] Total/recent/initial casualty
     *   counts for peel-withdrawal trigger evaluation.
     * @returns {object|null} Tactic descriptor or null (default policy).
     */
    function _resolveTactic({ members, leaderId, teamId, teamPreset, seed, combat, context,
        focusObjective = null, character = null, moraleTier = null, moraleInfo = null,
        casualtyDetail = null }) {
        const targets = context.tacticTargets ?? (Array.isArray(context.targets)
            ? context.targets
            : _convergentTargets({ members, combat, context }));
        // Issue #89 peel inputs: adaptation happens here, once, before the
        // preset cascades. Selectors remain pure — this block only reads
        // documents/services and builds plain data. In particular it does
        // not narrow `context.targets`; attack-pool narrowing stays in the
        // focus/interdiction channels.
        const scene = context.scene ?? combat?.scene ?? null;
        const navigation = context.navigation ?? _service("navigation");
        const threatMapService = context.threatMap ?? _service("threatMap");
        let threatMap = threatMapService;
        let dangerAt = typeof context.dangerAt === "function" ? context.dangerAt : null;
        if (!dangerAt && threatMapService) {
            try {
                const current = typeof threatMapService.map === "function"
                    ? threatMapService.map() : null;
                if (typeof current?.dangerAt === "function") {
                    threatMap = current;
                    dangerAt = point => current.dangerAt(point);
                } else if (typeof threatMapService.buildMap === "function") {
                    const built = threatMapService.buildMap({
                        targets,
                        combat,
                        scene,
                        grid: context.grid ?? scene?.grid ?? null
                    });
                    if (typeof built?.dangerAt === "function") {
                        threatMap = built;
                        dangerAt = point => built.dangerAt(point);
                    }
                }
            } catch(err) {
                dangerAt = null;
            }
        }
        const defeatedCount = _finiteOr(casualtyDetail?.total, 0);
        const casualtyOverride = context.casualties;
        const casualties = casualtyOverride && typeof casualtyOverride === "object"
            ? casualtyOverride
            : {
                // Legacy `context.casualties` means recent defeats (the
                // specOps fallback adds live defeated members itself); the
                // peel core needs total/recent/initialStrength explicitly.
                total: defeatedCount,
                recent: Math.max(0, _finiteOr(casualtyOverride,
                    _finiteOr(context.casualtiesRecent, 0))),
                initialStrength: Math.max(1, _finiteOr(context.initialStrength,
                    members.length + defeatedCount))
            };
        const selectorContext = {
            ...context,
            navigation,
            threatMap,
            ...(dangerAt ? { dangerAt } : {}),
            scene,
            grid: context.grid ?? scene?.grid ?? null,
            casualties,
            peel: { ...getPeelThresholds(), ...(context.peel ?? {}) },
            moraleInfo: moraleInfo ? {
                tier: moraleInfo.tier ?? moraleTier ?? null,
                effectiveTeamTier: moraleInfo.tier ?? moraleTier ?? null,
                record: moraleInfo.record ?? null,
                counters: moraleInfo.record?.counters ?? null,
                diagnostics: moraleInfo.diagnostics ?? null
            } : (moraleTier ? { tier: moraleTier, effectiveTeamTier: moraleTier } : null)
        };
        const selectorInput = {
            members,
            leaderId,
            teamId,
            seed,
            // Issue #88: the pincer morale gate reads the committed team
            // tier — the selector never re-derives morale itself.
            moraleTier,
            moraleInfo: selectorContext.moraleInfo,
            targets,
            objective: context.objective ?? focusObjective ?? null,
            casualties,
            scene,
            combat,
            context: selectorContext,
            character
        };
        const source = context.tactic;
        if (source !== undefined) {
            if (source === null || source === false) return null;
            if (typeof source === "function") {
                try {
                    return source(selectorInput) ?? null;
                } catch(err) {
                    return { name: null, reason: "tactic-error" };
                }
            }
            return typeof source === "object" ? source : null;
        }
        if (!teamPreset) return null;
        const tactics = _tactics(context.tactics ?? context.tacticRegistry);
        if (!tactics || typeof tactics.resolveTactic !== "function") return null;
        try {
            return tactics.resolveTactic(teamPreset, selectorInput) ?? null;
        } catch(err) {
            return { name: null, reason: "tactic-error" };
        }
    }

    // --- L2 morale (issue #26) ------------------------------------------------

    /** Dedup keys of already-emitted morale barks (`combat|team|round|tier`). */
    const _barkSeen = new Set();

    /**
     * Status ids of one member for the morale counters: merged
     * `actor.statuses`/`token.statuses` views, mirroring the planner's
     * `_selfStatuses` sources (Set/array/{id: truthy} map).
     * @param {object} member Member entry of {@link collectMembers}.
     * @returns {string[]}
     */
    function _memberStatusIds(member) {
        const ids = new Set();
        const push = source => {
            if (!source) return;
            if (typeof source[Symbol.iterator] === "function") {
                for (const id of source) ids.add(String(id));
            } else if (typeof source === "object") {
                for (const key of Object.keys(source)) {
                    if (source[key]) ids.add(String(key));
                }
            }
        };
        const doc = _tokenDoc(member.combatant?.token)
            ?? _tokenDoc(member.token);
        push(member.combatant?.actor?.statuses);
        push(doc?.statuses);
        push(doc?.actor?.statuses);
        push(member.statuses);
        return [...ids];
    }

    /**
     * Resolved personality trait ids of one member — the same inputs the
     * member's own `planTurn` will see (explicit context override,
     * flagged list, team character, difficulty, seeded generation), so
     * the effective-tier map here matches the L2 view inside every
     * member plan.
     * @param {object} member Member entry of {@link collectMembers}.
     * @param {string|null} character Team character.
     * @param {object} context `buildTeamPlan` context.
     * @returns {string[]}
     */
    function _memberTraits(member, character, context = {}) {
        try {
            const config = resolveConfig(member.combatant);
            const difficulty = AI_DIFFICULTIES.includes(context.difficulty)
                ? context.difficulty : getAIDifficulty();
            return resolvePersonality({
                explicit: context.personality,
                flagged: config?.personality,
                character,
                difficulty,
                identity: personalityIdentity({
                    combatant: member.combatant,
                    token: _tokenDoc(member.combatant?.token)
                        ?? _tokenDoc(member.token),
                    actor: member.combatant?.actor
                })
            }).traits;
        } catch(err) {
            return [];
        }
    }

    /**
     * Space-control counter (issue #26): `context.spaceControl`
     * injection wins; otherwise the share of member cells whose
     * aggregated enemy danger stays under the safe ceiling — measured
     * on the threat-map service's current map, or a fresh map built
     * over the visible hostiles. `null` when nothing is measurable.
     * @param {object} input
     * @param {object[]} input.members Living member entries.
     * @param {object} input.combat Combat document.
     * @param {object} input.context `buildTeamPlan` context.
     * @param {object|null} input.scene Scene for token/grid lookup.
     * @returns {number|null}
     */
    function _spaceControlOf({ members, combat, context, scene }) {
        if (Number.isFinite(context?.spaceControl)) {
            return Math.max(0, Math.min(1, context.spaceControl));
        }
        const points = members
            .map(member => member.position)
            .filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
        if (!points.length) return null;
        const service = _service("threatMap", context?.threatMap);
        if (!service) return null;
        const current = typeof service.map === "function" ? service.map() : null;
        if (current && typeof current.dangerAt === "function") {
            return moraleSpaceControl(points, point => current.dangerAt(point));
        }
        if (typeof service.buildMap === "function") {
            try {
                const targets = _convergentTargets({ members, combat, context });
                const map = service.buildMap({
                    targets,
                    combat,
                    scene: scene ?? combat?.scene ?? null,
                    grid: context?.grid ?? combat?.scene?.grid ?? null
                });
                if (map && typeof map.dangerAt === "function") {
                    return moraleSpaceControl(points, point => map.dangerAt(point));
                }
            } catch(err) {
                // Space control is one counter — never block the plan on it.
            }
        }
        return null;
    }

    /**
     * TokenDocument lookup of a convergent target inside the combat
     * (issue #26 review): matches `tokenId` against both the combatant's
     * `tokenId` and the doc id, `tokenUuid` against the doc uuid.
     * @param {object} combat Combat document.
     * @param {object} target Convergent target `{tokenId, tokenUuid}`.
     * @returns {object|null}
     */
    function _combatTokenDoc(combat, target) {
        for (const other of _list(combat?.combatants)) {
            const doc = _tokenDoc(other?.token);
            if (!doc) continue;
            if (target?.tokenId && (other.tokenId === target.tokenId
                || doc.id === target.tokenId)) {
                return doc;
            }
            if (target?.tokenUuid && doc.uuid === target.tokenUuid) return doc;
        }
        return null;
    }

    /**
     * Whether any living member currently has LOS to the target —
     * the live probe of {@link _seenEnemyIds}: a first-contact hostile
     * counts this round even though its memory write lags one
     * activation. Without a perception service every unchecked target
     * stays unseen.
     * @param {object[]} members Living member entries.
     * @param {object} target Convergent target.
     * @param {object|null} perception Perception service.
     * @param {object} combat Combat document.
     * @returns {boolean}
     */
    function _memberSees(members, target, perception, combat) {
        if (typeof perception?.hasLineOfSight !== "function") return false;
        const targetDoc = _combatTokenDoc(combat, target);
        if (!targetDoc) return false;
        for (const member of members) {
            const doc = _tokenDoc(member.combatant?.token)
                ?? _tokenDoc(member.token);
            if (!doc) continue;
            try {
                if (perception.hasLineOfSight(doc, targetDoc)) return true;
            } catch(_err) {
                // No usable vision probe — treated as unseen.
            }
        }
        return false;
    }

    /**
     * The squad's "ever seen" hostile set for the morale headcount
     * (issue #26 review): `previous.seenEnemies` persists across rounds,
     * every member's `memory` flag keys merge in (a last-known record is
     * proof the member once had LOS), and a live LOS probe adds a
     * first-contact hostile immediately. Injected `context.targets` are
     * the caller's contact list — every offered contact is perceived by
     * definition.
     * @param {object} input
     * @param {object[]} input.members Living member entries.
     * @param {object} input.combat Combat document.
     * @param {object} input.context Build context.
     * @param {object|null} input.previous Sanitized previous record.
     * @param {object[]} input.targets Convergent hostile targets.
     * @returns {Set<string>} tokenUuid (or tokenId fallback) ids.
     */
    function _seenEnemyIds({ members, combat, context, previous, targets }) {
        const seen = new Set(previous?.seenEnemies ?? []);
        for (const member of members) {
            const memory = _readFlag(member.combatant, FLAG_KEYS.memory);
            if (memory && typeof memory === "object") {
                for (const key of Object.keys(memory)) seen.add(key);
            }
        }
        const injected = Array.isArray(context?.targets)
            && context.targets.length;
        const perception = injected ? null
            : _service("perception", context?.perception);
        for (const target of targets ?? []) {
            const key = target?.tokenUuid ?? target?.tokenId;
            if (!key || seen.has(key)) continue;
            if (injected || _memberSees(members, target, perception, combat)) {
                seen.add(key);
            }
        }
        return seen;
    }

    /**
     * Persist the evaluated morale record on every living member's
     * `morale` flag (controller-only — `buildTeamPlan` already passed
     * the authority gate). Members carrying a *manual* posture stub
     * (a record without the evaluated shape) keep it as their
     * member-level override; identical rewrites are skipped.
     * @param {object[]} members Living member entries.
     * @param {object} record Sanitized evaluated record.
     * @returns {Promise<boolean>} Whether any flag was written.
     */
    async function _writeMoraleRecords(members, record) {
        let wrote = false;
        const wanted = stableStringify(record);
        for (const member of members) {
            const existing = _readFlag(member.combatant, FLAG_KEYS.morale);
            if (existing != null && !isEvaluatedMoraleRecord(existing)) continue;
            if (existing != null && stableStringify(existing) === wanted) continue;
            try {
                await member.combatant?.setFlag?.(
                    MODULE_ID, FLAG_KEYS.morale, record);
                wrote = true;
            } catch(err) {
                // Flag bookkeeping is best-effort — the context-side
                // record still drives this plan.
            }
        }
        return wrote;
    }

    /**
     * Chat bark for a committed morale-tier transition (issue #26): the
     * phrase is emitted at most once per `combat|team|round|tier` so a
     * same-round rebuild never repeats it. GM whisper by default —
     * `barksToPlayers` opens it to the table.
     * @param {object|null} previous Previous sanitized record.
     * @param {object} record Committed record.
     * @param {object} input
     * @param {object|null} input.combat Combat document (round + id).
     * @param {string} input.teamId Team id for the localized phrase.
     * @param {object} input.context Build context (bark kill switches).
     * @returns {Promise<boolean>}
     */
    async function _barkMoraleChange(previous, record, { combat, teamId, context }) {
        const from = previous?.tier ?? null;
        const to = record?.tier ?? null;
        if (!to || from === to) return false;
        // The very first evaluation writing the baseline record is not
        // news — only an actual posture change telegraphs.
        if (from === null && to === MORALE_DEFAULT_TIER) return false;
        const round = _finiteOr(combat?.round, 0);
        return emitBarkOnce(_barkSeen,
            `${combat?.id ?? "combat"}|${teamId}|${round}|${to}`, {
                key: `OWAI.Bark.Morale.${to}`,
                data: { team: teamId, from, to },
                speaker: `AI ${teamId}`,
                context,
                flags: { morale: { teamId, from, to, round } }
            });
    }

    /**
     * Evaluate the team's L2 morale for this round (issue #26): read the
     * previous evaluated record (first member carrying one), count the
     * battlefield picture, run the hysteresis gate, persist the record
     * on the members and bark a committed transition. An injected
     * `context.morale` skips evaluation/writes entirely (the caller
     * owns the posture) and `layers.morale === false` disables the
     * whole pass — legacy manual flags keep working through the
     * unconditional reads either way.
     * @param {object} input
     * @param {object} input.combat Combat document.
     * @param {string} input.teamId Team id.
     * @param {object[]} input.members Living enabled members.
     * @param {object[]} input.allMembers Every team combatant
     *   (defeated included — the casualty counters).
     * @param {object} input.context `buildTeamPlan` context.
     * @param {object} input.teamRef Normalized team reference.
     * @param {string} input.leaderId Elected leader this round.
     * @param {object|null} input.scene Scene for the space probe.
     * @param {string|null} input.character Team character.
     * @returns {Promise<{record: object|null, tier: string|null,
     *   effective: Map<string,string|null>, wrote: boolean,
     *   barked: boolean, diagnostics: object}>}
     */
    async function _teamMorale({ combat, teamId, members, allMembers,
        context, teamRef, leaderId, scene, character }) {
        const result = {
            record: null,
            tier: null,
            effective: new Map(),
            wrote: false,
            barked: false,
            diagnostics: { enabled: false, tier: null }
        };
        if (resolveLayerFlags(context).morale !== true) return result;
        result.diagnostics = { enabled: true, tier: null };
        const round = _finiteOr(combat?.round, 0);
        const combatId = combat?.id ?? null;
        let record = null;
        if (context?.morale !== undefined) {
            record = sanitizeMoraleRecord(context.morale);
        } else {
            const previous = sanitizeMoraleRecord(
                members.map(member => _readFlag(member.combatant, FLAG_KEYS.morale))
                    .find(raw => isEvaluatedMoraleRecord(raw)));
            if (previous && previous.combatId === combatId
                && previous.round === round) {
                // Already evaluated this round — a rebuild replays the
                // committed posture, it does not re-run the hysteresis.
                record = previous;
            } else {
                const wantedLeader = context.leaderId ?? teamRef.leaderId;
                const flaggedLeader = wantedLeader != null
                    ? (allMembers ?? members).find(member =>
                        (member.ids ?? []).includes(wantedLeader))
                    : null;
                // Issue #26 review: the headcount reads only enemies the
                // squad has *seen* — `previous.seenEnemies` persists,
                // every member's memory keys merge in, and a live LOS
                // probe reveals a first-contact hostile this round.
                // An unseen enemy never panics the team.
                const targets = _convergentTargets({ members, combat, context });
                const seen = _seenEnemyIds({
                    members, combat, context, previous, targets });
                const counters = {
                    members: members.length,
                    defeated: (allMembers ?? members)
                        .filter(member => member.defeated === true).length,
                    pinned: members.filter(member =>
                        _memberStatusIds(member).includes("pinned")).length,
                    enemies: targets.filter(target =>
                        seen.has(target.tokenUuid ?? target.tokenId)).length,
                    seenEnemies: [...seen].sort(),
                    spaceControl: _spaceControlOf({ members, combat, context, scene }),
                    // A pinned/flagged leader whose combatant is defeated
                    // or gone counts as a leader loss even before the
                    // previous-record comparison catches the swap.
                    leaderDead: wantedLeader != null
                        && (!flaggedLeader || flaggedLeader.defeated === true)
                };
                record = evaluateMoraleRecord(previous, counters, {
                    round,
                    combatId,
                    teamId,
                    leaderId,
                    hysteresis: context.moraleHysteresis,
                    // Issue #26 review: GM-tunable desperation threshold
                    // (world setting `moraleDesperateRatio`, default 2 —
                    // a 2:1 deficit; `context.moraleOutnumberRatio`
                    // overrides per plan).
                    outnumberRatio: Number.isFinite(context.moraleOutnumberRatio)
                        ? context.moraleOutnumberRatio
                        : getMoraleDesperateRatio()
                });
                if (!context.readOnly) {
                    result.wrote = await _writeMoraleRecords(members, record);
                    result.barked = await _barkMoraleChange(previous, record, {
                        combat, teamId, context });
                }
            }
        }
        result.record = record;
        result.tier = record?.tier ?? null;
        // Member-effective tiers: a manual stub on a member's own flag is
        // that member's base posture; everyone else shares the team tier.
        for (const member of members) {
            const own = _readFlag(member.combatant, FLAG_KEYS.morale);
            const base = context?.morale !== undefined || own == null
                || isEvaluatedMoraleRecord(own)
                ? result.tier
                : (sanitizeMoraleRecord(own)?.tier ?? result.tier);
            result.effective.set(member.combatantId, effectiveMoraleTier(
                base, _memberTraits(member, character, context)));
        }
        result.diagnostics = {
            enabled: true,
            tier: result.tier,
            pending: record?.pending ?? null,
            counters: record?.counters ?? null,
            wrote: result.wrote,
            barked: result.barked,
            effective: Object.fromEntries(result.effective)
        };
        return result;
    }

    // --- Recover-pinned overlay (issue #90) ---------------------------------

    /**
     * Assignment roles authored by a maneuver tactic whose capture would
     * break that maneuver's critical mass (epic #84 priority rule R3):
     * the suppression suppressor and its bounding element, the pincer
     * flanker/fix roles, the interdiction screen and both peel roles are
     * never reassigned by the recovery overlay — recovery is solved by the
     * fire of free members, not by recalling the maneuver. The `focus`
     * marker joins them under priority rule R7: concentrate-fire is the
     * team's deliberate fire concentration and outranks the recover
     * redirect, so a focus executor is never pulled onto cover duty —
     * when the pin source IS the focus target the merged redirect branch
     * already points every free member at it, making a hard assignment
     * unnecessary.
     */
    const RECOVER_CRITICAL_ROLES = new Set([
        "suppressor", "bound", "flanker", "fixer", INTERDICT_ROLE, "withdraw", "cover", "focus"
    ]);

    /**
     * Whether a member's loadout carries a suppression-capable ranged
     * weapon: burst or full-auto rate of fire, the modified rate winning
     * over the base one exactly like the suppress-and-bound capability
     * probe reads it.
     * @param {object|null} actor Actor document.
     * @returns {boolean}
     */
    function _suppressionCapableActor(actor) {
        for (const item of _list(actor?.items)) {
            if (item?.type !== "weapon") continue;
            if (String(item?.system?.class ?? "").toLowerCase() === "melee") continue;
            const rof = item?.system?.modified?.rateOfFire ?? item?.system?.rateOfFire ?? {};
            if (_finiteOr(rof?.burst, 0) > 0 || _finiteOr(rof?.full, 0) > 0) return true;
        }
        return false;
    }

    /**
     * Build the document-free input of the recover-pinned pure overlay and
     * evaluate it (issue #90, epic #84 integration). The adapter reads
     * documents/services exactly once per TeamPlan and converts them into
     * plain DTOs: member capabilities and control facts (GM control,
     * commitments, morale tier, turn order), the hostile contact list,
     * every combat token for the same-side resolution, the chat log for
     * the recorded attribution leg and LOS/cover/danger probes bound back
     * to token documents. The pure core stays document-free; anything it
     * cannot prove degrades to the conservative branch instead of guessing.
     *
     * The overlay is a one-round stateless evaluation: it never writes
     * flags, never mutates assignments itself and never narrows the
     * awareness pool. `null` means "no overlay this round" — either no
     * pinned member exists (the cheap common path) or the pure evaluation
     * itself failed, in which case team planning must continue unaffected.
     * @param {object} input
     * @param {object[]} input.members Living enabled member entries.
     * @param {object} input.combat Combat document.
     * @param {object} input.context `buildTeamPlan` context.
     * @param {object[]} input.assignments Current (post-demotion) assignments.
     * @param {object|null} input.moraleInfo Morale evaluation with the
     *   member-effective tier map.
     * @param {Set<string>} input.gmControlledIds Members GM-moved this round.
     * @param {string|null} input.leaderId Elected leader combatant id.
     * @returns {object|null} Pure overlay descriptor or null.
     */
    function _recoverPinnedOverlay({ members, combat, context, assignments,
        moraleInfo = null, gmControlledIds = new Set(), leaderId = null }) {
        const pinnedMembers = members.filter(member =>
            _memberStatusIds(member).includes("pinned"));
        if (!pinnedMembers.length) return null;
        try {
            const scene = context.scene ?? combat?.scene ?? null;
            const grid = _convergenceGrid(combat, context);
            // The hostile picture mirrors the maneuver selector's
            // precedence exactly: draft `tacticTargets` win, then the
            // caller's injected contact list, then the live combat scan —
            // all normalized through the same `_convergentTargets`
            // adaptation. Injected entries with missing positions are
            // completed from their live token documents so distance/LOS
            // legs never degrade just because the caller injected a lean
            // record.
            const injectedTargets = context.tacticTargets
                ?? (Array.isArray(context.targets) && context.targets.length
                    ? context.targets : null);
            const hostiles = _convergentTargets({
                members,
                combat,
                context: injectedTargets ? { ...context, targets: injectedTargets } : context
            }).map(hostile => {
                if (Number.isFinite(hostile?.x) && Number.isFinite(hostile?.y)) return hostile;
                const other = _combatantForTarget(combat, hostile);
                const pos = _tokenPosition(_tokenDoc(other?.token));
                if (!Number.isFinite(pos?.x) || !Number.isFinite(pos?.y)) return hostile;
                return { ...hostile, x: pos.x, y: pos.y };
            });
            // Every combat token — both sides — feeds the same-side
            // resolution of the attribution chain: a friendly suppressor
            // that accidentally pinned its own member must never become
            // the cover-fire target, and only explicit dispositions can
            // prove that relation.
            const tokens = [];
            for (const other of _list(combat?.combatants)) {
                if (!other || _isMissing(other)) continue;
                const doc = _tokenDoc(other?.token);
                if (!doc) continue;
                const pos = _tokenPosition(doc);
                const actor = other.actor ?? doc.actor ?? null;
                tokens.push({
                    combatantId: other.id ?? null,
                    tokenId: other.tokenId ?? doc.id ?? null,
                    tokenUuid: typeof doc.uuid === "string" ? doc.uuid : null,
                    actorId: actor?.id ?? null,
                    x: pos.x,
                    y: pos.y,
                    position: pos.x !== null && pos.y !== null ? { x: pos.x, y: pos.y } : null,
                    disposition: _finiteOr(doc.disposition ?? other.disposition, 0),
                    defeated: other.defeated === true,
                    dead: other.defeated === true,
                    destroyed: doc.destroyed === true,
                    hidden: doc.hidden === true,
                    statuses: _mergeStatusIds(other.actor?.statuses, doc.statuses, doc.actor?.statuses)
                });
            }
            const assignById = new Map((assignments ?? []).map(entry =>
                [entry.combatantId, entry]));
            const round = _finiteOr(combat?.round, 0);
            const memberDtos = members.map(member => {
                const combatant = member.combatant;
                const actor = combatant?.actor ?? null;
                const doc = _tokenDoc(combatant?.token);
                const assignment = assignById.get(member.combatantId) ?? null;
                const emitters = actor ? weaponEmitters(actor) : [];
                const pos = member.position ?? _tokenPosition(doc);
                const inMelee = hostiles.some(hostile => {
                    const distance = _convergenceDistance(pos, hostile, grid);
                    return distance !== null && distance <= DEFAULT_MELEE_REACH + 1e-9;
                });
                const role = typeof assignment?.role === "string" ? assignment.role : null;
                const movement = actor?.system?.movement ?? {};
                return {
                    combatantId: member.combatantId,
                    tokenId: member.tokenId,
                    tokenUuid: typeof doc?.uuid === "string" ? doc.uuid : null,
                    actorId: member.actorId ?? actor?.id ?? null,
                    position: Number.isFinite(pos?.x) && Number.isFinite(pos?.y)
                        ? { x: pos.x, y: pos.y } : null,
                    x: Number.isFinite(pos?.x) ? pos.x : null,
                    y: Number.isFinite(pos?.y) ? pos.y : null,
                    disposition: _finiteOr(doc?.disposition ?? combatant?.disposition, 0),
                    statuses: _memberStatusIds(member),
                    enabled: member.enabled !== false,
                    defeated: member.defeated === true,
                    initiative: Number.isFinite(member.initiative) ? member.initiative : null,
                    turnIndex: Number.isFinite(member.turnIndex) ? member.turnIndex : null,
                    hasActed: member.hasActed === true,
                    leader: member.combatantId === leaderId,
                    assignment: assignment ? {
                        task: assignment.task ?? null,
                        role,
                        element: assignment.element ?? null,
                        groupId: assignment.groupId ?? null
                    } : null,
                    groupId: assignment?.groupId ?? null,
                    gmControlled: gmControlledIds.has(member.combatantId),
                    commitment: _readFlag(combatant, FLAG_KEYS.committedPlan) ?? null,
                    inMelee,
                    attackCapable: emitters.length > 0,
                    rangedCapable: emitters.some(emitter => emitter?.melee !== true),
                    suppressionCapable: _suppressionCapableActor(actor),
                    // Conservative v1 reachability heuristic: a member that
                    // can move at all may find cover — the recoverCover
                    // factor only materializes when a real endpoint
                    // improves cover, so a false positive never misleads
                    // the plan, it merely keeps the individual leg eligible.
                    canReachCover: _finiteOr(movement.full, 0) > 0
                        || _finiteOr(movement.half, 0) > 0,
                    effectiveTier: moraleInfo?.effective?.get(member.combatantId)
                        ?? moraleInfo?.tier ?? null,
                    lastTarget: _readFlag(combatant, FLAG_KEYS.lastTarget) ?? null,
                    lastAttacker: _readFlag(combatant, FLAG_KEYS.lastAttacker) ?? null,
                    criticalAssignment: role !== null && RECOVER_CRITICAL_ROLES.has(role)
                };
            });
            // LOS probes receive the pure core's plain DTOs, so the adapter
            // closure resolves them back to token documents inside this
            // combat; unresolvable identities answer "unknown" (null), never
            // a guess.
            const perception = _service("perception", context.perception);
            const navigation = context.navigation ?? _service("navigation");
            const resolveDoc = ref => {
                if (!ref) return null;
                if (typeof ref === "object" && (ref.documentName === "Token" || ref.x !== undefined)
                    && typeof ref !== "string") {
                    // A token document passed straight through is valid input.
                    if (ref.documentName === "Token") return ref;
                }
                for (const other of _list(combat?.combatants)) {
                    const doc = _tokenDoc(other?.token);
                    if (!doc) continue;
                    const ids = [other.tokenId, doc.id, doc.uuid, other.actor?.id,
                        doc.actor?.id, other.id].filter(v => v != null).map(String);
                    const wanted = [ref?.tokenId, ref?.tokenUuid, ref?.actorId,
                        ref?.combatantId, ref?.id]
                        .filter(v => v != null).map(String);
                    if (typeof ref === "string") wanted.push(ref);
                    if (wanted.some(id => ids.includes(id))) return doc;
                }
                return null;
            };
            const losProbe = (fromRef, toRef) => {
                if (typeof perception?.hasLineOfSight !== "function") return null;
                const from = resolveDoc(fromRef);
                const to = resolveDoc(toRef);
                if (!from || !to) return null;
                try {
                    return perception.hasLineOfSight(from, to) === true;
                } catch(_err) {
                    return null;
                }
            };
            const coverProbe = (position, threatPosition, memberRef) => {
                if (typeof navigation?.coverEstimate !== "function") return null;
                const doc = resolveDoc(memberRef);
                if (!doc || !Number.isFinite(position?.x) || !Number.isFinite(position?.y)
                    || !Number.isFinite(threatPosition?.x) || !Number.isFinite(threatPosition?.y)) {
                    return null;
                }
                try {
                    const estimate = navigation.coverEstimate(doc,
                        { x: position.x, y: position.y },
                        { x: threatPosition.x, y: threatPosition.y });
                    return Number.isFinite(estimate) ? estimate : null;
                } catch(_err) {
                    return null;
                }
            };
            // Threat-map danger probe, mirroring the selector adaptation of
            // `_resolveTactic`: the service's current map wins, a fresh build
            // over the hostile contacts is the fallback, and everything
            // unprobed reads as zero exposure.
            let dangerProbe = null;
            const threatMapService = _service("threatMap", context.threatMap);
            if (threatMapService) {
                try {
                    const current = typeof threatMapService.map === "function"
                        ? threatMapService.map() : null;
                    if (typeof current?.dangerAt === "function") {
                        dangerProbe = point => current.dangerAt(point);
                    } else if (typeof threatMapService.buildMap === "function") {
                        const built = threatMapService.buildMap({
                            targets: hostiles,
                            combat,
                            scene,
                            grid: context.grid ?? scene?.grid ?? null
                        });
                        if (typeof built?.dangerAt === "function") {
                            dangerProbe = point => built.dangerAt(point);
                        }
                    }
                } catch(_err) {
                    dangerProbe = null;
                }
            }
            const overlay = buildRecoverPinnedOverlay({
                members: memberDtos,
                hostiles,
                tokens,
                messages: context.messages ?? globalThis.game?.messages ?? [],
                round,
                turnOrder: _list(combat?.turns).map(entry =>
                    typeof entry === "string" ? entry : (entry?.id ?? entry?.combatantId ?? null)),
                currentTurnIndex: Number.isFinite(combat?.turn) ? combat.turn : null,
                hasLineOfSight: losProbe,
                losToSource: losProbe,
                coverEstimate: coverProbe,
                ...(dangerProbe ? { dangerAt: point => {
                    try {
                        return _finiteOr(dangerProbe(point), 0);
                    } catch(_err) {
                        return 0;
                    }
                } } : {})
            });
            return overlay ?? null;
        } catch(err) {
            // The overlay is advisory: a broken adaptation must never break
            // the team plan itself.
            return null;
        }
    }

    /**
     * Build the serializable TeamPlan for one team of a combat. Only
     * AI-enabled combatants with a matching fireteam `teamId` participate;
     * each member plan is produced by `planner.planTurn` with the shared
     * team seed and task-scoped context (issue #408).
     * @param {object} combat Combat document.
     * @param {object|string} team `{teamId, leaderId?, teamPreset?,
     *   preferredCohesion?}`, a bare team id, or a document carrying the
     *   fireteam flag.
     * @param {object} [context] Optional overrides/services: `seed`,
     *   `objective`, `assignments`, `allowFlank`, `regroup`, `tactic`,
     *   `casualties`, `detachedUntilPhase`, `maxDetachedPhases`,
     *   `preferredCohesion`, `specOpsConfig`, `targets`, `actions`, `moves`, `perception`,
     *   `navigation`, `authority`, `planner`, `tactics`, `taskCapacities`,
     *   `replanCount`, `messages` (chat scan of the issue #90 recover
     *   attribution), `threatMap`. Runtime drafts use `readOnly` (no morale/GM flags,
     *   independent member LOS) and pass `tacticTargets` only to the
     *   maneuver selector, not as attackable targets for each member.
     * @returns {Promise<object>} `{status, teamPlan?, reason?, diagnostics?}`.
     */
    async function buildTeamPlan(combat, team, context = {}) {
        const authority = _service("authority", context.authority);
        if (authority) {
            if (authority.status === "waiting-for-gm"
                || (typeof authority.isController === "function"
                    && authority.isController() === false)) {
                return {
                    status: FIRETEAM_STATUS.waitingForGm,
                    reason: "not-controller",
                    teamPlan: null
                };
            }
        }
        if (!combat || combat.ended === true) {
            return {
                status: FIRETEAM_STATUS.disabled,
                reason: TEAM_PLAN_REASONS.combatEnded,
                teamPlan: null
            };
        }
        const teamRef = _normalizeTeamRef(team);
        const teamId = context.teamId ?? teamRef.teamId;
        if (!teamId) {
            return {
                status: FIRETEAM_STATUS.noMembers,
                reason: "no-team-id",
                teamPlan: null
            };
        }
        const seed = _seedFor(context, combat, teamId);
        // Issue #26: the unfiltered list feeds the morale casualty
        // counters — defeated members still count for the team record.
        const allMembers = collectMembers(combat, teamId);
        let members = allMembers
            .filter(member => member.enabled && !member.defeated);
        if (Array.isArray(teamRef.members)) {
            const allowed = new Set(teamRef.members);
            members = members.filter(member =>
                allowed.has(member.combatantId) || allowed.has(member.tokenId));
        }
        const diagnostics = {
            seed,
            teamId,
            leaderId: null,
            preferredCohesion: _preferredCohesion(members, context),
            assignments: [],
            cohesion: [],
            reservations: { targets: [], endpoints: [], conflicts: [] },
            memberStatuses: {},
            // Issue #25: members marked `gmControlled` this round (and
            // demotions applied) — the team degrades, it does not break.
            gmControlled: [],
            gmDemotions: [],
            rejected: []
        };
        // Issue #25: combatants the GM moved this round without an
        // executor journal entry are flagged `gmControlled`; flagged
        // members cannot be trusted with detached/complex tasks — they
        // are demoted to `support` before planning.
        const round = _finiteOr(combat.round, 0);
        const gmControlledIds = new Set(
            members.filter(member => isGmControlled(member.combatant, round))
                .map(member => member.combatantId));
        if (!members.length) {
            return {
                status: FIRETEAM_STATUS.noMembers,
                reason: "no-members",
                teamPlan: null,
                diagnostics
            };
        }

        const election = electLeader(members, {
            seed,
            leaderId: context.leaderId ?? teamRef.leaderId
        });
        diagnostics.leaderId = election.combatantId;
        diagnostics.leaderReason = election.reason;
        if (!election.combatantId) {
            return {
                status: FIRETEAM_STATUS.leaderUnavailable,
                reason: "leader-unavailable",
                teamPlan: null,
                diagnostics
            };
        }

        // Shared team preset: explicit context, then the team reference,
        // then the members' own fireteam flags (deterministic order —
        // members arrive sorted by combatant id).
        const teamPreset = context.teamPreset ?? teamRef.teamPreset
            ?? members.map(m => m.team?.teamPreset)
                .find(p => AI_PRESETS.includes(p))
            ?? (members.every(m => m.preset === SPEC_OPS_PRESET_ID) ? SPEC_OPS_PRESET_ID : null);
        if (teamPreset === SPEC_OPS_PRESET_ID) {
            context = { ...context, specOpsConfig: getSpecOpsConfig(context.specOpsConfig) };
        }
        // Issue #19: the shared team character — explicit context, then
        // the team reference, then the first member flag in the
        // deterministic member order.
        const character = FIRETEAM_CHARACTERS.includes(context.character)
            ? context.character
            : (teamRef.character
                ?? members.map(m => m.team?.character)
                    .find(c => FIRETEAM_CHARACTERS.includes(c))
                ?? null);
        diagnostics.character = character;
        const memberPlanner = _memberPlanner(teamPreset, context.planner);
        const preferredCohesion = diagnostics.preferredCohesion;

        // Issue #26 L2 morale: evaluate the team posture (counters →
        // tier proposal → hysteresis-gated record persisted on the
        // members' `morale` flags), compute the member-effective tiers
        // used by the task remap/delay gate and bark the committed
        // transition to the GM. Disabled layers leave `tier: null` —
        // the historical assignment policy stands.
        const moraleInfo = await _teamMorale({
            combat,
            teamId,
            members,
            allMembers,
            context,
            teamRef,
            leaderId: election.combatantId,
            scene: context.scene ?? combat?.scene ?? null,
            character
        });
        diagnostics.morale = moraleInfo.diagnostics;

        // Concentrate-fire pre-pass (issue #85): focus selection is an
        // objective overlay, not a maneuver. It must run before the preset
        // tactic registry so specOps `flank-and-fix`/coordinated assault sees
        // the identical target instead of independently picking another one.
        // The pure selector receives only visible live hostiles (or explicitly
        // perceived injected contacts) plus normalized member capabilities.
        const focusSelection = _focusSelection({
            members,
            combat,
            context,
            teamPreset,
            casualties: allMembers.filter(member => member.defeated === true).length
        });
        const selectedFocus = focusSelection.focus;
        let convergence = selectedFocus;
        diagnostics.focus = _jsonClone({
            ...focusSelection.result.diagnostics,
            focus: selectedFocus,
            candidates: focusSelection.result.candidates
        });

        // Team tactic (issue #412): a preset tactic factory may bind the
        // maneuver — assignments, flank policy, regroup and the shared
        // objective. Explicit caller context fields always win; the focus
        // descriptor is only the registry input objective when the caller did
        // not order one explicitly.
        const tactic = _resolveTactic({
            members,
            leaderId: election.combatantId,
            teamId,
            teamPreset,
            seed,
            combat,
            context,
            focusObjective: selectedFocus,
            character,
            moraleTier: moraleInfo.tier,
            moraleInfo,
            casualtyDetail: {
                total: allMembers.filter(member => member.defeated === true).length,
                initialStrength: allMembers.length
            }
        });
        const tacticName = tactic?.name ?? tactic?.tactic ?? null;
        // Issue #87: the interdiction screen is a composite maneuver — its
        // breakdown records the base attack maneuver it screens, and the
        // flank doctrine/proof machinery applies when that base is a
        // flank-and-fix.
        const baseTacticName = tactic?.breakdown?.baseTactic ?? null;
        const isFlankManeuver = tacticName === "flank-and-fix"
            || (tacticName === INTERDICTION_TACTIC && baseTacticName === "flank-and-fix");
        if (teamPreset === SPEC_OPS_PRESET_ID && isFlankManeuver
            && Number.isFinite(tactic.flankMinAngleDegrees)) {
            // Factories can bind a stricter doctrine than the saved
            // setting; publish precisely the cutoff used by the draft.
            context = {
                ...context,
                specOpsConfig: getSpecOpsConfig({
                    ...context.specOpsConfig, flankMinAngleDegrees: tactic.flankMinAngleDegrees
                })
            };
        }
        diagnostics.tactic = tactic
            ? _jsonClone({
                name: tacticName,
                reason: tactic.reason ?? null,
                breakdown: tactic.breakdown ?? null
            })
            : null;
        const maxDetachedPhases = _finiteOr(
            context.maxDetachedPhases ?? tactic?.maxDetachedPhases,
            DEFAULT_MAX_DETACHED_PHASES);

        // Issue #87: interdiction exclusions are objective constraints,
        // not scoring weights. The concentrate-fire focus is recomputed
        // with the interception targets removed from candidacy whenever
        // the tactic carries exclusions — a screened target can never
        // stay the team's focus, and only the exclusion channels (never
        // target-pool narrowing) carry the ban into every member's
        // attack pool below.
        const tacticExclusions = Array.isArray(tactic?.excludedTargets)
            ? tactic.excludedTargets.filter(entry =>
                entry && ((entry.targetId !== null && entry.targetId !== undefined)
                    || (typeof entry.tokenUuid === "string" && entry.tokenUuid)))
            : [];
        const exclusionIds = _uniqueIdList(tacticExclusions.flatMap(entry =>
            [entry.targetId, entry.tokenUuid]));
        if (convergence && exclusionIds.length) {
            const refocus = _focusSelection({
                members,
                combat,
                context: {
                    ...context,
                    excludeTargetIds: _uniqueIdList([
                        ...(Array.isArray(context.excludeTargetIds) ? context.excludeTargetIds : []),
                        ...exclusionIds
                    ])
                },
                teamPreset,
                casualties: allMembers.filter(member => member.defeated === true).length
            });
            convergence = refocus.focus;
            diagnostics.focus = _jsonClone({
                ...refocus.result.diagnostics,
                focus: convergence,
                candidates: refocus.result.candidates,
                interdictionExclusions: exclusionIds
            });
        }

        // Objective precedence is explicit caller order → independent tactic
        // objective → focus. A tactic that merely inherits the focus target
        // (specOps does) keeps the focus assignment metadata; a tactic that
        // deliberately binds another target wins and the focus overlay stays
        // diagnostic-only for this draft. The interdiction objective is
        // role-scoped (issue #87): its `targetId` is the interception target
        // of the interdictor alone, so the shared focus channel must not
        // collapse onto it — non-interdictor members keep engaging the
        // recomputed focus or the remaining enemies.
        const interdictObjective = tactic?.objective?.type === INTERDICT_OBJECTIVE_TYPE
            ? tactic.objective : null;
        const tacticTargetId = interdictObjective ? null : (tactic?.objective?.targetId ?? null);
        const tacticInheritsFocus = Boolean(convergence && tacticTargetId
            && _idListsOverlap([tacticTargetId], _focusIdentityIds(convergence)));
        if (convergence && tacticTargetId && !tacticInheritsFocus) convergence = null;
        const focusObjectiveFields = convergence
            ? {
                capableMembers: [...(convergence.capableMembers ?? [])],
                assignedMembers: [...(convergence.assignedMembers ?? [])],
                mode: convergence.mode
            }
            : null;
        const sharedObjective = context.objective
            ?? (tactic?.objective
                ? (interdictObjective
                    ? {
                        ...tactic.objective,
                        targetId: convergence?.targetId ?? null,
                        ...(focusObjectiveFields ?? {})
                    }
                    : (tacticInheritsFocus && focusObjectiveFields
                        ? { ...tactic.objective, ...focusObjectiveFields }
                        : tactic.objective))
                : (convergence
                    ? {
                        targetId: convergence.targetId,
                        ...focusObjectiveFields
                    }
                    : undefined));
        // `teamPlan.convergence` remains the backward-compatible descriptor
        // channel in both modes. `diagnostics.convergence` is narrower by
        // design: only kill mode is the legacy binary convergence alias;
        // scored-focus details live in `diagnostics.focus`.
        diagnostics.convergence = convergence?.mode === "kill"
            ? _jsonClone(convergence) : null;

        const assignments = assignTasks(members, {
            leaderId: election.combatantId,
            assignments: context.assignments ?? tactic?.assignments,
            allowFlank: context.allowFlank ?? tactic?.allowFlank
                ?? (convergence?.mode === "kill" ? false : undefined),
            regroup: context.regroup ?? tactic?.regroup,
            // Issue #26: a confident team pushes a second assault column
            // and a wider flank group.
            assaultCap: moraleInfo.tier === "confident"
                ? MORALE_CONFIDENT_ASSAULT_CAP : undefined,
            flankCap: moraleInfo.tier === "confident"
                ? MORALE_CONFIDENT_FLANK_CAP : undefined,
            objective: sharedObjective,
            explicitTargetId: context.objective?.targetId ?? null
        });
        // Issue #25 gm-controlled degradation: members the GM moved this
        // round are demoted from detached/complex tasks to `support`
        // before planning — the flanker the GM grabbed does not try to
        // finish its maneuver; the team plan degrades, it does not
        // break. Explicit `context.assignments` demotes the same way.
        const gmDemotions = [];
        for (const assignment of assignments) {
            if (gmControlledIds.has(assignment.combatantId)
                && GM_DEMOTABLE_TASKS.has(assignment.task)) {
                gmDemotions.push({
                    combatantId: assignment.combatantId,
                    from: assignment.task,
                    to: "support",
                    reason: "gm-controlled"
                });
                assignment.task = "support";
                assignment.groupId = "main";
                _clearSuppressionGeometry(assignment);
                _clearInterdictionGeometry(assignment);
                _clearPincerGeometry(assignment);
                _clearPeelGeometry(assignment);
            }
        }
        diagnostics.gmControlled = [...gmControlledIds];
        diagnostics.gmDemotions = gmDemotions;
        // Issue #26 L2: member-effective tier remap — a `desperate`
        // member pulls out of detached/complex tasks into `support`/
        // `regroup` while the rest of the team keeps its assignments
        // (the team tier stays one; the remap reads the member's
        // *effective* tier after the trait exceptions). Explicit
        // assignments demote the same way, mirroring the gm-controlled
        // pass.
        const moraleDemotions = [];
        for (const assignment of assignments) {
            const effectiveTier = moraleInfo.effective.get(assignment.combatantId)
                ?? moraleInfo.tier;
            const to = MORALE_TASK_REMAP[effectiveTier]?.[assignment.task];
            if (to && to !== assignment.task) {
                moraleDemotions.push({
                    combatantId: assignment.combatantId,
                    from: assignment.task,
                    to,
                    reason: `morale-${effectiveTier}`,
                    effectiveTier: effectiveTier ?? null
                });
                assignment.task = to;
                assignment.groupId = "main";
                _clearSuppressionGeometry(assignment);
                _clearInterdictionGeometry(assignment);
                _clearPincerGeometry(assignment);
                _clearPeelGeometry(assignment);
            }
        }
        diagnostics.moraleDemotions = moraleDemotions;

        // Issue #90 recover-pinned overlay (epic #84): evaluated once per
        // TeamPlan after every demotion pass and before the planning loop.
        // The overlay never rewrites the maneuver itself — pinned members
        // are demoted to `support`+`recovering` exactly like the GM/morale
        // demotions above (corebook: a pinned fighter cannot execute a
        // flank/assault push anyway), at most one free member receives the
        // `cover-fire` role with its soft `assignedTargetId` narrowing, and
        // every member context carries the `team.recover` injection the
        // planner prices through `recoverCover`/`recoverRedirect` weights.
        // Priority rules R1/R3 are structural: the donor pool of the pure
        // core already excludes valid commitments, detached flank/assault
        // tasks, desperate regrouping members, GM-controlled members and
        // every maneuver-critical role, so peel/regroup/suppression/
        // pincer/interdiction geometry is never hijacked.
        const recoverOverlay = _recoverPinnedOverlay({
            members,
            combat,
            context,
            assignments,
            moraleInfo,
            gmControlledIds,
            leaderId: election.combatantId
        });
        const recoverContexts = {};
        const recoverDemotions = [];
        if (recoverOverlay?.active === true) {
            for (const [combatantId, overlayAssignment] of Object.entries(recoverOverlay.assignments ?? {})) {
                const assignment = assignments.find(entry => entry.combatantId === combatantId);
                if (!assignment || !overlayAssignment) continue;
                if (overlayAssignment.role === RECOVER_PINNED_ROLES.recovering) {
                    if (assignment.task !== "support") {
                        recoverDemotions.push({
                            combatantId,
                            from: assignment.task,
                            to: "support",
                            reason: "recover-pinned"
                        });
                    }
                    assignment.task = "support";
                    assignment.groupId = "main";
                    delete assignment.element;
                    _clearSuppressionGeometry(assignment);
                    _clearInterdictionGeometry(assignment);
                    _clearPincerGeometry(assignment);
                    _clearPeelGeometry(assignment);
                    assignment.role = RECOVER_PINNED_ROLES.recovering;
                    assignment.objective = overlayAssignment.objective
                        ? _jsonClone(overlayAssignment.objective) : null;
                } else if (overlayAssignment.role === RECOVER_PINNED_ROLES.coverFire) {
                    // The cover donor keeps its place in the maneuver order
                    // but becomes fire support: the role marker, the pin
                    // objective and the soft target narrowing ride on the
                    // existing assignment contract — no new task types.
                    assignment.task = "support";
                    assignment.groupId = "main";
                    assignment.role = RECOVER_PINNED_ROLES.coverFire;
                    assignment.objective = overlayAssignment.objective
                        ? _jsonClone(overlayAssignment.objective) : null;
                    assignment.assignedTargetId = overlayAssignment.assignedTargetId ?? null;
                }
            }
            for (const [combatantId, injection] of Object.entries(recoverOverlay.memberContexts ?? {})) {
                recoverContexts[combatantId] = _jsonClone(injection);
            }
        }
        diagnostics.recover = recoverOverlay ? _jsonClone({
            active: recoverOverlay.active === true,
            gate: recoverOverlay.gate ?? null,
            mode: recoverOverlay.mode ?? null,
            pinned: recoverOverlay.pinned ?? [],
            coverAssignment: recoverOverlay.coverAssignment ?? null,
            coverReason: recoverOverlay.coverReason ?? null,
            redirectTargetId: recoverOverlay.redirectTargetId ?? null,
            demotions: recoverDemotions,
            breakdown: recoverOverlay.breakdown ?? null,
            diagnostics: recoverOverlay.diagnostics ?? null
        }) : null;
        // Issue #90 T5: the activation bark telegraphs the recovery branch
        // to the table exactly like the morale transitions do — deduped
        // per `combat|team|round`, live evaluations only (a readOnly draft
        // never speaks), and silent when the chat channel is unavailable.
        if (recoverOverlay?.active === true && !context.readOnly) {
            await emitBarkOnce(_barkSeen,
                `${combat?.id ?? "combat"}|${teamId}|${_finiteOr(combat?.round, 0)}|recover`, {
                    key: recoverOverlay.coverAssignment ? "OWAI.Bark.Recover.Cover" : "OWAI.Bark.Recover.Active",
                    data: { team: teamId },
                    speaker: `AI ${teamId}`,
                    context,
                    flags: {
                        recover: {
                            teamId,
                            round: _finiteOr(combat?.round, 0),
                            cover: recoverOverlay.coverAssignment?.combatantId ?? null
                        }
                    }
                });
        }
        const assignMap = new Map(assignments.map(a => [a.combatantId, a]));
        diagnostics.assignments = _jsonClone(assignments);

        // Team anchor for task-scoped member evaluation (issue #412):
        // the leader position is the cohesion centre and the first
        // rejoin/regroup point of detached maneuvers.
        const leader = members.find(m => m.combatantId === election.combatantId);
        const leaderPos = leader?.position ?? null;
        const scene = context.scene ?? combat.scene ?? null;
        const flankRules = teamPreset === SPEC_OPS_PRESET_ID && isFlankManeuver
            ? {
                flankCenter: specOpsTokenCenter(_tokenDoc(leader?.combatant?.token), scene, leaderPos),
                flankMinAngleDegrees: context.specOpsConfig.flankMinAngleDegrees
            } : null;
        const rejoinPoints = regroupPoints(members, { leaderId: election.combatantId });

        // Planning order: leader first, then flank group, then the rest —
        // reservation priority follows maneuver priority.
        const orderOf = member => {
            if (member.combatantId === election.combatantId) return 0;
            // Issue #88: every signed flank group (`flank-left`/
            // `flank-right` and the legacy `flank-1`) plans before the
            // fix base — reservation priority follows maneuver priority.
            const group = assignMap.get(member.combatantId)?.groupId ?? "main";
            return typeof group === "string" && group.startsWith("flank-") ? 1 : 2;
        };
        const ordered = [...members].sort((a, b) =>
            (orderOf(a) - orderOf(b))
            || String(a.combatantId).localeCompare(String(b.combatantId)));

        const capacities = {
            ...TARGET_TASK_CAPACITY,
            // Issue #88: the pincer composition caps its flank elements
            // (`taskCapacities.flank = maxFlankSize`); explicit caller
            // overrides still win over the tactic-authored capacities.
            ...(tactic?.taskCapacities ?? {}),
            ...(context.taskCapacities ?? {})
        };

        // Issue #38 shared squad contacts: the merged memory of every
        // living member is collected once per TeamPlan — each member
        // context carries the identical `team.contacts` list, so a
        // contact one member saw propagates to the whole squad. The
        // planner dedups freshness against the member's own last-known
        // entries (fresher wins, own wins at equal ts).
        const perception = _service("perception", context.perception);
        const teamContacts = _teamContacts({ members, combat, context, perception });

        const reservedTargets = new Map();
        const routeLocks = [...(context.reservations ?? [])];
        const plans = new Map();
        // Issue #93: every member's planner context is kept so the
        // target-conflict retry below replans with the identical team
        // metadata (`center`, `objective`, `flankPoint`, `regroupPoint`,
        // the leader's `orderCandidate`) instead of a partial rebuild.
        const memberContexts = new Map();
        const tokens = new Map(ordered.map(member => [member.combatantId, _tokenDoc(member.combatant.token)]));
        // Backward-compatible legacy channel: `team.objective` is always
        // the shared target id, never the member-scoped objective object.
        const sharedTargetId = sharedObjective?.targetId ?? null;
        const suppressionZones = tacticName === SUPPRESS_AND_BOUND
            && Array.isArray(tactic?.exclusionZones)
            ? _jsonClone(tactic.exclusionZones) ?? [] : [];
        const suppressionCone = tacticName === SUPPRESS_AND_BOUND
            ? (_jsonClone(tactic?.objective?.suppressionCone ?? tactic?.cone ?? null))
            : null;
        const peelObjective = tacticName === PEEL_WITHDRAWAL_NAME
            ? _jsonClone(tactic?.objective ?? null) : null;
        const peelCosts = new Map((tacticName === PEEL_WITHDRAWAL_NAME
            ? (tactic?.breakdown?.costs ?? []) : [])
            .map(cost => [String(cost.combatantId), cost]));
        const peelStranded = new Set((tacticName === PEEL_WITHDRAWAL_NAME
            ? (tactic?.breakdown?.stranded ?? []) : [])
            .map(entry => String(entry.combatantId ?? entry)));
        let baseTargets = Array.isArray(context.targets) ? context.targets : null;
        for (const member of ordered) {
            const assignment = assignMap.get(member.combatantId);
            // Issue #88: the maneuver anchor is per-member — a pincer
            // objective signs two maneuver points and the member's own
            // flank element selects its side's point; legacy single-point
            // objectives resolve exactly as before.
            const flankAnchor = _memberFlankAnchor(assignment, tactic?.objective ?? null);
            const memberContext = {
                ...context,
                seed,
                reservations: routeLocks.slice(),
                replanCount: _finiteOr(context.replanCount, 0),
                ...(context.readOnly ? {
                    includeNeutral: resolveConfig(member.combatant)?.includeNeutral === true
                } : {}),
                tactic: tacticName,
                team: {
                    teamId,
                    task: assignment.task,
                    groupId: assignment.groupId,
                    role: assignment.role ?? null,
                    element: assignment.element ?? null,
                    ...(assignment.role === "suppressor" && suppressionCone
                        ? { suppressionCone: _jsonClone(suppressionCone) } : {}),
                    ...(assignment.role !== "suppressor" && suppressionZones.length
                        ? { exclusionZones: _jsonClone(suppressionZones) } : {}),
                    objective: sharedTargetId,
                    ...(tacticName === PEEL_WITHDRAWAL_NAME ? {
                        peel: {
                            objective: _jsonClone(peelObjective),
                            regroupPoint: _jsonClone(peelObjective?.regroupPoint ?? null),
                            threatCentroid: _jsonClone(peelObjective?.threatCentroid ?? null),
                            lane: _jsonClone(peelObjective?.lane ?? null),
                            coverMode: tactic?.cover?.mode ?? null,
                            coverTargetId: tactic?.cover?.target?.tokenId
                                ?? tactic?.cover?.target?.targetId ?? null,
                            coverTargetUuid: tactic?.cover?.target?.tokenUuid
                                ?? tactic?.cover?.target?.targetUuid ?? null,
                            cost: peelCosts.has(String(member.combatantId))
                                ? _jsonClone(peelCosts.get(String(member.combatantId))) : null,
                            stranded: peelStranded.has(String(member.combatantId))
                        }
                    } : {}),
                    memberObjective: assignment.objective
                        ? _jsonClone(assignment.objective) : null,
                    // Issue #90: the recover-pinned overlay injection of
                    // this member — `recovering` members read the pin-threat
                    // position for their cover-seeking weight, the cover
                    // donor reads the attributed source, everyone else at
                    // most carries the soft redirect id. Absent when the
                    // overlay is inactive (no stale channel survives).
                    ...(recoverContexts[member.combatantId]
                        ? { recover: _jsonClone(recoverContexts[member.combatantId]) } : {}),
                    assignment: _assignmentDescriptor(assignment),
                    leaderId: election.combatantId,
                    center: leaderPos,
                    ...flankRules,
                    character,
                    contacts: teamContacts,
                    // The tactic's maneuver anchor: a flanker advances on
                    // `flankPoint` (perpendicular strike position), not
                    // the target itself — without it the task was a dead
                    // label and the member wandered (smoke finding).
                    // Issue #88: per-member signed point/side of the
                    // pincer elements (see `_memberFlankAnchor`).
                    flankPoint: flankAnchor.point,
                    ...(flankAnchor.side ? { flankSide: flankAnchor.side } : {}),
                    // Issue #87: the interdictor's screen anchor travels
                    // with the team context so the movement generator can
                    // merge screen-point candidates and `screenProgress`
                    // can score the approach.
                    screenPoint: assignment.role === INTERDICT_ROLE
                        ? (assignment.objective?.screenPoint ?? null) : null,
                    regroupPoint: assignment.task === "regroup"
                        ? (peelObjective?.regroupPoint ?? rejoinPoints[0] ?? null) : null
                }
            };
            // Issue #85 minimal split awareness: `targets` remains the full
            // threat/engagement pool. Focus narrowing is expressed only in
            // the planner's additive direct-attack pools; caller allow-lists
            // are hard constraints and are intersected, caller deny-lists are
            // preserved verbatim and appended for overflow members.
            const focusPoolOverrides = _focusAttackPoolOverrides(
                member.combatantId, convergence, context, assignment);
            Object.assign(memberContext, focusPoolOverrides);
            // Issue #87: interdiction exclusions join the attack-pool
            // deny-list additively — caller exclusions stay preserved and
            // the threat pool is never narrowed. The interdictor's own
            // interception target is the one exclusion that does not apply
            // to them: they exist to charge and tie up exactly that enemy.
            if (exclusionIds.length) {
                const ownInterception = assignment?.role === INTERDICT_ROLE
                    ? _uniqueIdList([assignment?.objective?.targetId, assignment?.objective?.targetUuid])
                    : [];
                const denyIds = ownInterception.length
                    ? exclusionIds.filter(id => !_idListsOverlap([id], ownInterception))
                    : exclusionIds;
                if (denyIds.length) {
                    memberContext.excludedAttackTargetIds = _uniqueIdList([
                        ...(Array.isArray(memberContext.excludedAttackTargetIds)
                            ? memberContext.excludedAttackTargetIds : []),
                        ...denyIds
                    ]);
                }
            }
            if (Object.hasOwn(focusPoolOverrides, "attackTargetIds")) {
                // Provenance for executor target-gone replans: the derived
                // focus allow-list must not strand the member on a dead
                // target, while a caller-supplied hard allow-list is restored
                // rather than widened.
                memberContext.focusAttackPool = {
                    allow: true,
                    fallbackAttackTargetIds: Array.isArray(context.attackTargetIds)
                        ? [...context.attackTargetIds] : null
                };
            }
            // Issue #38 orders: the elected leader receives the team's
            // `orderCandidate` (Command test of the best order option);
            // absent options/cooldown simply leave the field unset.
            if (member.combatantId === election.combatantId) {
                const orderCandidate = _orderCandidateOf({
                    member,
                    memberCount: members.length,
                    combat,
                    context
                });
                if (orderCandidate) {
                    memberContext.team.orderCandidate = orderCandidate;
                }
            }
            const memberTargets = _memberTargets({
                base: baseTargets,
                counts: reservedTargets,
                capacities,
                assignment,
                focus: convergence
            });
            if (memberTargets !== undefined) memberContext.targets = memberTargets;
            memberContexts.set(member.combatantId, memberContext);
            let result;
            try {
                result = await memberPlanner.planTurn(
                    combat, member.combatant, memberContext);
            } catch(err) {
                result = { status: "error", plan: null, reason: "plan-error" };
            }
            // Issue #25: a fresh `gm-intervention` in the member's L1
            // trace means the GM moved the token since its last turn —
            // mark the combatant `gmControlled` for the round (feeds
            // reactive mode) and replan once as `support` when the
            // demoted task allowed a complex maneuver.
            const layerTrace = result?.plan?.diagnostics?.layers
                ?? result?.diagnostics?.layers ?? [];
            const intervened = layerTrace.some(entry =>
                entry?.layer === "L1" && entry?.code === "gm-intervention");
            if (intervened && !gmControlledIds.has(member.combatantId)) {
                gmControlledIds.add(member.combatantId);
                diagnostics.gmControlled = [...gmControlledIds];
                try {
                    if (!context.readOnly) {
                        await member.combatant?.setFlag?.(MODULE_ID, FLAG_KEYS.gmControlled, {
                            round,
                            turn: _finiteOr(combat.turn, 0),
                            reason: "gm-intervention"
                        });
                    }
                } catch(err) {
                    // Flag bookkeeping is best-effort.
                }
                const assignment = assignMap.get(member.combatantId);
                if (assignment && GM_DEMOTABLE_TASKS.has(assignment.task)) {
                    gmDemotions.push({
                        combatantId: member.combatantId,
                        from: assignment.task,
                        to: "support",
                        reason: "gm-intervention"
                    });
                    diagnostics.gmDemotions = gmDemotions;
                    // Issue #87: capture the interception ids before the
                    // geometry clear — a demoted interdictor becomes an
                    // ordinary member and the command denial now applies
                    // to them as well.
                    const lostInterception = assignment.role === INTERDICT_ROLE
                        ? _uniqueIdList([assignment.objective?.targetId, assignment.objective?.targetUuid])
                            .filter(id => exclusionIds.some(ex => String(ex) === String(id)))
                        : [];
                    assignment.task = "support";
                    assignment.groupId = "main";
                    _clearSuppressionGeometry(assignment);
                    _clearInterdictionGeometry(assignment);
                    _clearPincerGeometry(assignment);
                    _clearPeelGeometry(assignment);
                    try {
                        const retry = await memberPlanner.planTurn(combat,
                            member.combatant, {
                                ...memberContext,
                                replanCount: _finiteOr(context.replanCount, 0) + 1,
                                ...(lostInterception.length ? {
                                    excludedAttackTargetIds: _uniqueIdList([
                                        ...(Array.isArray(memberContext.excludedAttackTargetIds)
                                            ? memberContext.excludedAttackTargetIds : []),
                                        ...lostInterception
                                    ])
                                } : {}),
                                team: {
                                    ...memberContext.team,
                                    task: "support",
                                    groupId: "main",
                                    role: assignment.role ?? null,
                                    element: assignment.element ?? null,
                                    memberObjective: assignment.objective
                                        ? _jsonClone(assignment.objective) : null,
                                    screenPoint: null,
                                    assignment: _assignmentDescriptor(assignment)
                                }
                            });
                        const previous = diagnostics.memberStatuses[member.combatantId]
                            ?? result?.status ?? "error";
                        result = retry;
                        diagnostics.memberStatuses[member.combatantId] =
                            `${previous}->${retry?.status ?? "error"}`;
                    } catch(err) {
                        // The first plan stands — demotion is best-effort.
                    }
                }
            }
            plans.set(member.combatantId, result);
            const move = result?.plan?.steps?.find(step => step.type === "move");
            if (move) routeLocks.push(...movementCells(tokens.get(member.combatantId),
                [...(move.input?.waypoints ?? []), move.input?.to]));
            if (diagnostics.memberStatuses[member.combatantId] === undefined) {
                diagnostics.memberStatuses[member.combatantId] = result?.status ?? "error";
            }
            // Reserve the chosen target immediately so later members cannot
            // double-book the same target for the same task type.
            const targetId = result?.plan?.target?.tokenId
                ?? assignment.assignedTargetId ?? null;
            if (targetId && result?.plan) {
                const key = `${assignment.task}|${assignment.groupId ?? "main"}|${targetId}`;
                reservedTargets.set(key, (reservedTargets.get(key) ?? 0) + 1);
            }
            // One member's LOS is not another member's permission to fire.
            if (!context.readOnly && !baseTargets && result?.plan) {
                const shared = _sharedTargets(result.plan);
                if (shared) baseTargets = shared;
            }
        }

        const reservationContext = {
            // Issue #88: already merged with the tactic-authored
            // capacities above — `reserveResources` merges them over the
            // defaults idempotently.
            taskCapacities: capacities,
            tokens,
            focus: convergence
        };
        const orderedAssignments = ordered.map(member => assignMap.get(member.combatantId));
        const initialReservations = reserveResources(orderedAssignments, plans, reservationContext);
        const targetLosers = new Set(
            initialReservations.conflicts.filter(c => c.type === "target")
                .map(c => c.loserId));
        // Target losers get one retarget retry against the remaining pool.
        for (const member of ordered) {
            if (!targetLosers.has(member.combatantId)) continue;
            const assignment = assignMap.get(member.combatantId);
            const base = baseTargets ?? plans.get(member.combatantId)?.plan?.snapshot?.targets;
            if (!Array.isArray(base) || !base.length) continue;
            const retryTargets = _availableTargets(
                base.map(({ distance, ...rest }) => ({ ...rest })),
                reservedTargets,
                capacities,
                { ...assignment, assignedTargetId: null });
            // Issue #93: replan from the member's original context so the
            // retry keeps the team metadata the first pass assembled —
            // `center`/`objective`/`flankPoint`/`regroupPoint` drive the
            // flank geometry and cohesion of spec-ops presets and were
            // silently dropped by the partial rebuild. Only the inputs
            // that legitimately change (reservations, target pool, replan
            // count, a demoted task/group) are overridden.
            const stored = memberContexts.get(member.combatantId);
            const retry = await memberPlanner.planTurn(combat, member.combatant, {
                ...(stored ?? { ...context, seed }),
                reservations: [...(context.reservations ?? []), ...initialReservations.routes
                    .filter(cell => cell.memberId !== member.combatantId)],
                replanCount: _finiteOr(context.replanCount, 0) + 1,
                targets: retryTargets,
                // A target-conflict retry is intentionally no longer
                // assigned-narrowed. Restore the caller's original allow-list
                // (usually none) instead of inheriting the focus-derived one
                // from the stored first-pass context; focus/caller deny-lists
                // remain in force through the spread.
                attackTargetIds: Array.isArray(context.attackTargetIds)
                    ? [...context.attackTargetIds] : undefined,
                team: {
                    ...(stored?.team ?? {
                        teamId,
                        leaderId: election.combatantId,
                        character,
                        contacts: teamContacts
                    }),
                    task: assignment.task,
                    groupId: assignment.groupId,
                    role: assignment.role ?? null,
                    element: assignment.element ?? null,
                    ...(assignment.role === "suppressor" && suppressionCone
                        ? { suppressionCone: _jsonClone(suppressionCone) } : {}),
                    ...(assignment.role !== "suppressor" && suppressionZones.length
                        ? { exclusionZones: _jsonClone(suppressionZones) } : {}),
                    objective: sharedTargetId,
                    memberObjective: assignment.objective
                        ? _jsonClone(assignment.objective) : null,
                    assignment: _assignmentDescriptor(assignment)
                }
            });
            plans.set(member.combatantId, retry);
            const previousStatus = diagnostics.memberStatuses[member.combatantId];
            diagnostics.memberStatuses[member.combatantId] =
                `${previousStatus}->${retry?.status ?? "error"}`;
            const retryTarget = retry?.plan?.target?.tokenId ?? null;
            if (retryTarget) {
                const key = `${assignment.task}|${assignment.groupId ?? "main"}|${retryTarget}`;
                reservedTargets.set(key, (reservedTargets.get(key) ?? 0) + 1);
            }
        }

        // Issue #86 post-plan verification: the pre-plan exclusion zones are
        // only the selector's proposal. Once the suppressor has actually
        // chosen (or honestly fallen back from) a suppression attack, the
        // serialized attack step defines the authoritative cone. Other
        // members get one context-preserving replan against that cone; a
        // repeat violation is recorded as a zone conflict and the move is
        // excluded by a final no-movement degradation.
        const suppressionZoneDiagnostics = {
            checked: false,
            cone: null,
            violations: [],
            replans: [],
            conflicts: []
        };
        if (tacticName === SUPPRESS_AND_BOUND) {
            const suppressorId = tactic?.suppressorId
                ?? assignments.find(entry => entry.role === "suppressor")?.combatantId
                ?? null;
            const suppressorMember = ordered.find(member => member.combatantId === suppressorId) ?? null;
            const authoritativeCone = suppressorMember
                ? _authoritativeSuppressionCone({
                    member: suppressorMember,
                    result: plans.get(suppressorId),
                    tactic,
                    scene
                })
                : null;
            suppressionZoneDiagnostics.checked = authoritativeCone !== null;
            suppressionZoneDiagnostics.cone = authoritativeCone;
            if (authoritativeCone) {
                for (const member of ordered) {
                    if (member.combatantId === authoritativeCone.ownerId) continue;
                    let violation = _suppressionMoveViolation(
                        plans.get(member.combatantId), authoritativeCone);
                    if (!violation) continue;
                    suppressionZoneDiagnostics.violations.push({
                        combatantId: member.combatantId,
                        point: violation.point,
                        stepId: violation.stepId,
                        attempt: "initial"
                    });
                    const stored = memberContexts.get(member.combatantId);
                    const preZoneReservations = reserveResources(
                        orderedAssignments, plans, reservationContext);
                    const retryContext = {
                        ...(stored ?? { ...context, seed }),
                        reservations: [
                            ...(context.reservations ?? []),
                            ...preZoneReservations.routes
                                .filter(cell => cell.memberId !== member.combatantId)
                        ],
                        replanCount: _finiteOr(context.replanCount, 0) + 1,
                        team: {
                            ...(stored?.team ?? {
                                teamId,
                                leaderId: election.combatantId,
                                character,
                                contacts: teamContacts
                            }),
                            exclusionZones: [authoritativeCone]
                        }
                    };
                    let retry = null;
                    try {
                        retry = await memberPlanner.planTurn(
                            combat, member.combatant, retryContext);
                    } catch(err) {
                        retry = null;
                    }
                    suppressionZoneDiagnostics.replans.push({
                        combatantId: member.combatantId,
                        attempt: "zone-replan",
                        status: retry?.status ?? "error"
                    });
                    if (retry?.plan) {
                        plans.set(member.combatantId, retry);
                        const previousStatus = diagnostics.memberStatuses[member.combatantId];
                        diagnostics.memberStatuses[member.combatantId] =
                            `${previousStatus}->${retry?.status ?? "error"}`;
                        violation = _suppressionMoveViolation(retry, authoritativeCone);
                    }
                    if (!violation) continue;
                    const conflict = {
                        type: "zone",
                        reason: "suppression-zone",
                        loserId: member.combatantId,
                        winnerId: authoritativeCone.ownerId,
                        point: violation.point
                    };
                    suppressionZoneDiagnostics.conflicts.push(conflict);
                    suppressionZoneDiagnostics.violations.push({
                        combatantId: member.combatantId,
                        point: violation.point,
                        stepId: violation.stepId,
                        attempt: "zone-replan"
                    });
                    // The one maneuver replan failed to clear the cone. Do
                    // not loop indefinitely: degrade this member to the
                    // planner's ordinary stay/attack-in-place candidates by
                    // injecting an empty movement set. This is the safe
                    // “move excluded” fallback, not another tactical replan.
                    let holdRetry = null;
                    try {
                        holdRetry = await memberPlanner.planTurn(combat, member.combatant, {
                            ...retryContext,
                            moves: [],
                            replanCount: _finiteOr(context.replanCount, 0) + 2
                        });
                    } catch(err) {
                        holdRetry = null;
                    }
                    suppressionZoneDiagnostics.replans.push({
                        combatantId: member.combatantId,
                        attempt: "move-excluded",
                        status: holdRetry?.status ?? "error"
                    });
                    if (holdRetry?.plan) {
                        plans.set(member.combatantId, holdRetry);
                        const previousStatus = diagnostics.memberStatuses[member.combatantId];
                        diagnostics.memberStatuses[member.combatantId] =
                            `${previousStatus}->${holdRetry?.status ?? "error"}`;
                    }
                }
            }
        }
        diagnostics.suppressionZones = _jsonClone(suppressionZoneDiagnostics);

        if (flankRules) {
            // Check every assigned flanker after all demotions/retargets.
            // Support is not required to shoot from the flank (or to move).
            const leaderMove = plans.get(election.combatantId)?.plan?.steps.find(step => step.type === "move");
            const finalRules = { ...flankRules, flankCenter: leaderMove?.input?.to ?? flankRules.flankCenter };
            const flankers = ordered.filter(member => assignMap.get(member.combatantId).task === "flank");
            const attacks = flankers.map(member => {
                const proof = _flankProof(plans.get(member.combatantId), {
                    scene, combat, token: tokens.get(member.combatantId), team: finalRules
                });
                return { flankerId: member.combatantId, ...proof };
            });
            const split = attacks.length > 0 && orderedAssignments.some(a => a.task === "support");
            const failure = split ? attacks.find(evidence => evidence.reason)
                : { reason: "flank-roles-unavailable" };
            if (failure) {
                const fallback = specOpsFlankFallback(members, tactic, failure);
                const explicit = Object.entries(context.assignments ?? {})
                    .filter(([, assignment]) =>
                        normalizeFireteamAssignment(assignment)?.task !== "flank");
                return buildTeamPlan(combat, team, {
                    ...context,
                    readOnly: true,
                    tactic: fallback,
                    allowFlank: false,
                    assignments: explicit.length > 0
                        ? { ...fallback.assignments, ...Object.fromEntries(explicit) } : undefined
                });
            }
            const weakest = attacks.reduce((a, b) => a.angle <= b.angle ? a : b);
            diagnostics.tactic.breakdown = {
                ...diagnostics.tactic.breakdown,
                flank: { ...weakest, feasible: true, minAngle: flankRules.flankMinAngleDegrees }
            };
        }

        // Issue #38 synchronized strike: when the shared convergence target
        // is already engaged by main members but the transit flanker needs
        // another round, main members hold position on a `delay` plan so
        // the squad strikes together. A retry above never resurrects a
        // delay — the pass runs after every replan.
        const delayed = _syncDelay({
            ordered,
            assignMap,
            plans,
            convergence,
            combat,
            context,
            diagnostics,
            teamId,
            memberMorale: moraleInfo.effective,
            // Issue #88: the pincer objective carries the committed sync
            // mode (`elastic`/`strict`/`none`); legacy flank-and-fix
            // objectives carry none and keep single-flanker semantics.
            sync: tactic?.objective?.sync ?? null
        });
        // Fresh gm-intervention demotions can happen during member
        // planning, after the first diagnostic snapshot. Publish the final
        // assignment records (including role/element/objective metadata).
        diagnostics.assignments = _jsonClone(assignments);
        const reservations = reserveResources(orderedAssignments, plans, reservationContext);
        for (const conflict of suppressionZoneDiagnostics.conflicts) {
            reservations.conflicts.push(_jsonClone(conflict));
        }
        diagnostics.reservations = _jsonClone(reservations);
        const routeConflict = reservations.conflicts.find(conflict =>
            conflict.type === "endpoint" || conflict.type === "route");
        const reject = reason => {
            if (!context.teamFallback && tactic?.name !== "regroup-fallback") {
                return buildTeamPlan(combat, team, {
                    ...context, readOnly: true, teamFallback: true, assignments: undefined,
                    allowFlank: false, regroup: true, convergence: false,
                    tactic: { name: "regroup-fallback", reason, regroup: true }
                });
            }
            return { status: FIRETEAM_STATUS.invalid, teamPlan: null, reason, diagnostics };
        };
        if (routeConflict) return reject(routeConflict.reason);

        // Cohesion evaluation: occupied cell centres are in pixels, but
        // the configured preferred distance is in scene units. Detached
        // maneuvers need a reachable endpoint, a bounded separation and a
        // legal rejoin point.
        const grid = scene?.grid;
        const size = _finiteOr(grid?.size, 0);
        const unitsPerPixel = size > 0 ? _finiteOr(grid?.distance, 1) / size : 1;
        const projectedCenter = member => {
            const planned = plans.get(member?.combatantId)?.plan?.steps
                ?.find(step => step?.type === "move")?.input?.to;
            if (planned) return planned;
            if (!Number.isFinite(member?.position?.x) || !Number.isFinite(member?.position?.y)) return null;
            const token = _tokenDoc(member.combatant?.token);
            return {
                x: member.position.x + (_finiteOr(token?.width, 1) * size / 2),
                y: member.position.y + (_finiteOr(token?.height, 1) * size / 2)
            };
        };
        const center = projectedCenter(ordered.find(member => member.combatantId === election.combatantId));
        const memberEntries = [];
        const rejoinLocks = [...(context.reservations ?? [])];
        let cohesionPenalty = 0;
        let score = 0;
        const breakdown = { members: {}, cohesion: [] };
        for (const member of ordered) {
            const assignment = assignMap.get(member.combatantId);
            const plan = plans.get(member.combatantId)?.plan ?? null;
            const move = (plan?.steps ?? []).find(step => step?.type === "move");
            const separation = {
                endpoint: projectedCenter(member),
                center,
                unitsPerPixel,
                preferredCohesion,
                task: move ? assignment.task : "support",
                detachedUntilPhase: _finiteOr(context.detachedUntilPhase, 1),
                maxDetachedPhases,
                rejoinAvailable: true
            };
            let cohesion = evaluateCohesion(separation);
            let rejoin = null;
            if (cohesion.detached) {
                rejoin = await planRejoin(tokens.get(member.combatantId), center, {
                    grid, preferredCohesion, rates: context.rates, navigation: context.navigation,
                    origin: move.input.to,
                    reservations: [...rejoinLocks, ...reservations.endpoints
                        .filter(endpoint => endpoint.memberId !== member.combatantId)
                        .flatMap(endpoint => endpoint.cells)]
                });
                if (!rejoin) cohesion = evaluateCohesion({ ...separation, rejoinAvailable: false });
                else rejoinLocks.push(...movementCells(tokens.get(member.combatantId), rejoin.route));
            }
            cohesionPenalty += cohesion.penalty;
            breakdown.cohesion.push({
                combatantId: member.combatantId,
                ...cohesion
            });
            diagnostics.cohesion.push({
                combatantId: member.combatantId,
                distance: cohesion.distance,
                within: cohesion.within,
                detached: cohesion.detached,
                penalty: cohesion.penalty,
                reason: cohesion.reason
            });
            if (!cohesion.allowed && DETACHED_TASKS.has(assignment.task)) {
                const reason = `detached-${cohesion.reason}`;
                diagnostics.rejected.push({ member: member.combatantId, reason });
                return reject(reason);
            }
            score += _finiteOr(plan?.score, 0);
            breakdown.members[member.combatantId] = _finiteOr(plan?.score, 0);
            memberEntries.push({
                combatantId: member.combatantId,
                tokenId: member.tokenId,
                task: assignment.task,
                groupId: assignment.groupId,
                leader: assignment.leader,
                ...(assignment.role ? { role: assignment.role } : {}),
                ...(assignment.element ? { element: assignment.element } : {}),
                ...(assignment.objective
                    ? { objective: _jsonClone(assignment.objective) } : {}),
                ...(peelStranded.has(String(member.combatantId)) ? { stranded: true } : {}),
                detached: cohesion.detached,
                detachedUntilPhase: cohesion.detached
                    ? _finiteOr(context.detachedUntilPhase, 1) : null,
                maxDetachedRounds: cohesion.detached ? maxDetachedPhases : null,
                separation: cohesion.distance,
                rejoinPoint: rejoin?.point ?? null,
                rejoinRoute: rejoin?.route ?? null,
                rejoinCost: rejoin?.cost ?? null,
                assignedTargetId: plan?.target?.tokenId ?? assignment.assignedTargetId,
                assignedTargetUuid: plan?.target?.tokenUuid ?? null,
                assignedEndpoint: move?.input?.to
                    ? { x: move.input.to.x, y: move.input.to.y }
                    : null,
                assignedRoute: Array.isArray(move?.input?.waypoints)
                    ? _jsonClone(move.input.waypoints) : null,
                planId: plan?.id ?? null,
                status: plans.get(member.combatantId)?.status ?? "error",
                // Issue #38: `{reason, until, syncRound, awaitId}` when the
                // member waits for the synchronized strike.
                delayed: delayed.get(member.combatantId) ?? null
            });
        }
        score = Math.round((score - cohesionPenalty) * 1e6) / 1e6;
        breakdown.cohesionPenalty = Math.round(cohesionPenalty * 1e6) / 1e6;
        // Issue #90: the overlay's explainable branch — attribution method
        // and confidence, gate reason, triage rows and the donor selection
        // — travels in the team breakdown exactly like the maneuver
        // breakdowns of the tactic layer.
        if (diagnostics.recover?.breakdown) {
            breakdown.recover = _jsonClone(diagnostics.recover.breakdown);
        }
        diagnostics.membersPlanned = memberEntries.length;

        const phases = _buildPhases({
            ordered,
            assignMap,
            plans,
            members: memberEntries,
            // Issue #88 barrier decision: a pincer's flank geometry is
            // proven at selection time (corridor/divergence checks of the
            // pure core), exactly like the spec-ops angle proof — so only
            // genuinely moving members hold the movement barrier. A
            // stationary in-position flanker must not break the compile;
            // its side's readiness is what the sync-delay pass watches.
            flankProven: flankRules !== null || _isPincerManeuver(tacticName, tactic)
        });
        const memberPlans = {};
        for (const member of ordered) {
            const plan = plans.get(member.combatantId)?.plan ?? null;
            if (!plan) {
                memberPlans[member.combatantId] = null;
                continue;
            }
            const serialized = _jsonClone(plan);
            // Issue #89 descriptor contract: every member plan explains the
            // team tactic compactly without duplicating the pure breakdown.
            serialized.breakdown = {
                ...(serialized.breakdown ?? {}),
                tactic: {
                    name: tacticName ?? null,
                    role: assignMap.get(member.combatantId)?.role ?? null,
                    reason: tactic?.reason ?? null
                }
            };
            memberPlans[member.combatantId] = serialized;
        }

        const revision = _teamRevision(combat, members, {
            teamId,
            leaderId: election.combatantId,
            members: memberEntries
        });
        const planId = `team-${fnv1a(`${revision}|${teamId}|${seed}`)}`;
        const teamPlan = _deepFreeze({
            id: planId,
            combatId: combat.id ?? null,
            round: _finiteOr(combat.round, 0),
            turn: _finiteOr(combat.turn, 0),
            teamId,
            leaderId: election.combatantId,
            teamPreset: teamPreset && AI_PRESETS.includes(teamPreset)
                ? teamPreset : null,
            ...(teamPreset === SPEC_OPS_PRESET_ID ? { specOpsConfig: context.specOpsConfig } : {}),
            character,
            tactic: diagnostics.tactic?.name ?? null,
            objective: sharedObjective?.targetId ?? null,
            // Issue #90: first-class compact recover-pinned overlay
            // section — consumers (executor, GM preview) read the
            // activation verdict and the single cover donor without
            // digging into diagnostics; the full attribution/triage
            // breakdown stays in `diagnostics.recover`.
            recover: diagnostics.recover ? {
                active: diagnostics.recover.active,
                mode: diagnostics.recover.mode ?? null,
                gate: diagnostics.recover.gate ?? null,
                pinned: (diagnostics.recover.pinned ?? []).map(entry => ({
                    combatantId: entry.combatantId ?? null,
                    exposure: entry.exposure ?? null,
                    value: entry.value ?? null,
                    maneuverCritical: entry.maneuverCritical === true,
                    attribution: entry.attribution
                        ? {
                            method: entry.attribution.method ?? null,
                            confidence: entry.attribution.confidence ?? null,
                            tokenId: entry.attribution.tokenId ?? null,
                            tokenUuid: entry.attribution.tokenUuid ?? null
                        }
                        : null
                })),
                coverAssignment: diagnostics.recover.coverAssignment ?? null,
                redirectTargetId: diagnostics.recover.redirectTargetId ?? null
            } : null,
            convergence,
            revision,
            seed,
            members: memberEntries,
            memberPlans,
            phases,
            reservations: {
                targets: reservations.targets,
                endpoints: reservations.endpoints,
                routes: reservations.routes
            },
            score,
            breakdown,
            diagnostics
        });
        log(`team plan ${teamPlan.id} team=${teamId} members=${memberEntries.length} score=${score}`);
        return { status: FIRETEAM_STATUS.ok, teamPlan, reason: null };
    }

    /**
     * Validate a TeamPlan against live state — the team-level analogue of
     * `planner.validateSnapshot`. The cheap revision fingerprint is compared
     * first; a mismatch runs the ordered checks that produce a stable
     * reason code. On `leader-lost` a deterministic successor is elected
     * and reported so the caller can rebuild the plan.
     * @param {object} teamPlan Serialized TeamPlan.
     * @param {object} [currentContext] Live overrides: `combat`,
     *   `combatants` (`combatantId → combatant`), `seed`.
     * @returns {{valid: boolean, reason: string|null,
     *   successor: object|null}}
     */
    function validateTeamPlan(teamPlan, currentContext = {}) {
        const fail = (reason, successor = null) =>
            ({ valid: false, reason, successor });
        if (!teamPlan || typeof teamPlan !== "object" || !teamPlan.teamId) {
            return fail(TEAM_PLAN_REASONS.invalidPlan);
        }
        const combat = _findCombat(teamPlan.combatId, currentContext);
        if (!combat || combat.id !== teamPlan.combatId || combat.ended === true) {
            return fail(TEAM_PLAN_REASONS.combatEnded);
        }
        const members = collectMembers(combat, teamPlan.teamId)
            .map(member => {
                const override = currentContext.combatants?.[member.combatantId];
                if (!override) return member;
                const token = _tokenDoc(override.token);
                return {
                    ...member,
                    combatant: override,
                    defeated: override.defeated === true,
                    position: _tokenPosition(token),
                    enabled: resolveConfig(override).enabled === true
                        ? member.enabled : false
                };
            });
        // Fast path: identical revision means nothing the checks below
        // inspect has changed.
        const liveRevision = _teamRevision(combat, members, teamPlan);
        if (liveRevision === teamPlan.revision) {
            return { valid: true, reason: null, successor: null };
        }
        // Foundry reports `combat.turn` as `null` until the first turn
        // advances; plans normalize the missing value to 0 at build time.
        if (_finiteOr(combat.round, 0) !== _finiteOr(teamPlan.round, 0)
            || _finiteOr(combat.turn, 0) !== _finiteOr(teamPlan.turn, 0)) {
            return fail(TEAM_PLAN_REASONS.turnStale);
        }
        const seed = _finiteOr(teamPlan.seed, 0);
        const leader = members.find(m => m.combatantId === teamPlan.leaderId);
        if (!leader || leader.defeated === true) {
            const successor = electLeader(
                members.filter(m => m.combatantId !== teamPlan.leaderId),
                { seed });
            return fail(TEAM_PLAN_REASONS.leaderLost, successor);
        }
        // Issue #38: a delayed member waits on `delayed.awaitId` — the
        // transit flanker the synchronized strike holds for. When that
        // awaited member is gone or defeated/disabled the wait is broken:
        // report `sync-broken` before the generic member check so the
        // caller sees the actual reason.
        // Issue #88 multi-await matrix: a strict pincer wait breaks when
        // ANY awaited flanker is lost, an elastic wait only when ALL of
        // them are (the strike releases on the first ready side). The
        // legacy single-`awaitId` record is both at once — conservative
        // strict is the default for policy-less records.
        for (const entry of teamPlan.members ?? []) {
            const delayed = entry?.delayed ?? null;
            const awaitedIds = Array.isArray(delayed?.awaitIds) && delayed.awaitIds.length
                ? delayed.awaitIds
                : (delayed?.awaitId ? [delayed.awaitId] : []);
            if (!awaitedIds.length) continue;
            const lost = id => {
                const awaited = members.find(m => m.combatantId === id);
                return !awaited || awaited.defeated === true || awaited.enabled === false;
            };
            const broken = delayed?.policy === "elastic"
                ? awaitedIds.every(lost)
                : awaitedIds.some(lost);
            if (broken) return fail(TEAM_PLAN_REASONS.syncBroken);
        }
        for (const entry of teamPlan.members ?? []) {
            const live = members.find(m => m.combatantId === entry.combatantId);
            if (!live || live.defeated === true || live.enabled === false) {
                return fail(TEAM_PLAN_REASONS.memberUnavailable);
            }
        }
        return fail(TEAM_PLAN_REASONS.stale);
    }

    /**
     * Mark a TeamPlan as invalidated: returns a new frozen serializable
     * copy carrying `invalidated`/`invalidReason`. Used after
     * `leader-lost` so stale plans never execute.
     * @param {object} teamPlan
     * @param {string} reason One of {@link TEAM_PLAN_REASONS}.
     * @returns {object}
     */
    function invalidateTeamPlan(teamPlan, reason = TEAM_PLAN_REASONS.stale) {
        const clone = _jsonClone(teamPlan) ?? {};
        clone.invalidated = true;
        clone.invalidReason = reason;
        return _deepFreeze(clone);
    }

    return {
        buildTeamPlan,
        assignTasks,
        reserveResources,
        electLeader,
        validateTeamPlan,
        invalidateTeamPlan,
        regroupPoints,
        planRejoin,
        evaluateCohesion,
        collectMembers,
        resolveTeamConfig,
        tasks: FIRETEAM_TASKS,
        statuses: FIRETEAM_STATUS,
        reasons: TEAM_PLAN_REASONS,
        barrierFailurePolicies: BARRIER_FAILURE_POLICIES
    };
}
