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
 *   "authority")`) or injected via `context`; every lookup degrades safely
 *   so the service works before/without the other stacked branches.
 */
import {
    AI_PRESETS,
    DEFAULT_PREFERRED_COHESION,
    FIRETEAM_CHARACTERS,
    FIRETEAM_TASKS,
    FLAG_KEYS,
    MODULE_ID
} from "./constants.js";
import { resolveEffectiveConfig } from "./config-resolver.js";
import { isHostileDisposition } from "./perception.js";
import {
    createPlannerService,
    fnv1a,
    stableStringify
} from "./planner.js";
import { getPreferredCohesion, logDiagnostics } from "./settings.js";
import { weaponEmitters } from "./threat-map.js";
import {
    SPEC_OPS_PRESET_ID,
    specOpsTactic
} from "./presets/spec-ops.js";

/** Result statuses of {@link createFireteamService.buildTeamPlan}. */
export const FIRETEAM_STATUS = Object.freeze({
    ok: "ok",
    noMembers: "no-members",
    leaderUnavailable: "leader-unavailable",
    disabled: "disabled",
    waitingForGm: "waiting-for-gm"
});

/**
 * Stable invalidation reason codes returned by `validateTeamPlan`.
 * `leader-lost` triggers a deterministic re-election; `member-unavailable`
 * allows one shared replan before the first state change.
 */
export const TEAM_PLAN_REASONS = Object.freeze({
    leaderLost: "leader-lost",
    memberUnavailable: "member-unavailable",
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
 * @param {Function} [deps.resolveConfig] Effective AI config resolver.
 * @param {Function} [deps.log] Diagnostic logger.
 * @returns {object} Fireteam service.
 */
export function createFireteamService({
    api = null,
    planner = null,
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
        const wrapped = createPlannerService({
            api,
            resolveConfig: doc => {
                const cfg = resolveConfig(doc);
                return cfg?.enabled ? { ...cfg, preset: teamPreset } : cfg;
            }
        });
        if (typeof base?.listPresets === "function"
            && typeof base?.getPreset === "function") {
            for (const id of base.listPresets()) {
                const def = base.getPreset(id);
                if (def) wrapped.registerPreset(id, def);
            }
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
     *   actorId, ids, initiative, hp, defeated, enabled, position}`.
     */
    function collectMembers(combat, teamId) {
        if (!combat || !teamId) return [];
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
     * `combatantId → task` to force specific assignments;
     * `context.regroup === true` puts everyone on `regroup`.
     * @param {object[]} members Entries from {@link collectMembers}.
     * @param {object} [context]
     * @param {string|null} [context.leaderId] Elected/retained leader id.
     * @param {object} [context.assignments] Explicit `combatantId → task`.
     * @param {boolean} [context.allowFlank] `false` disables the default
     *   flank group.
     * @param {boolean} [context.regroup] Force every member to `regroup`.
     * @param {object} [context.objective] `{targetId, flankTargetId}` shared
     *   team objective.
     * @returns {object[]} Assignments `{combatantId, tokenId, task, groupId,
     *   leader, assignedTargetId}` in deterministic order.
     */
    function assignTasks(members, context = {}) {
        const sorted = [...(members ?? [])].sort((a, b) =>
            String(a.combatantId).localeCompare(String(b.combatantId)));
        const explicit = context.assignments && typeof context.assignments === "object"
            ? context.assignments : null;
        const allowFlank = context.allowFlank !== false && sorted.length >= 2;
        let flankAssigned = false;
        return sorted.map(member => {
            let task = null;
            const forced = explicit?.[member.combatantId];
            if (typeof forced === "string") task = forced;
            else if (context.regroup === true) task = "regroup";
            else if (member.combatantId === context.leaderId) task = "assault";
            else if (allowFlank && !flankAssigned) {
                task = "flank";
                flankAssigned = true;
            } else {
                task = "support";
            }
            if (!FIRETEAM_TASKS.includes(task)) task = "support";
            if (task === "flank") flankAssigned = true;
            const groupId = task === "flank" ? "flank-1" : "main";
            // Issue #16: a convergent objective may restrict the shared
            // target to the members that actually contribute kill-EV
            // (`capableMembers`); without that list the objective goes to
            // every non-flank member as before.
            const objectiveRestricted = Array.isArray(context.objective?.capableMembers)
                && !context.objective.capableMembers.includes(member.combatantId);
            const assignedTargetId = task === "flank"
                ? (context.objective?.flankTargetId ?? context.objective?.targetId ?? null)
                : (objectiveRestricted ? null : (context.objective?.targetId ?? null));
            return {
                combatantId: member.combatantId,
                tokenId: member.tokenId ?? null,
                task,
                groupId,
                leader: member.combatantId === context.leaderId,
                assignedTargetId
            };
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
            ? Math.hypot(endpoint.x - center.x, endpoint.y - center.y)
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
     * Reservation table for movement endpoints and targets (issue #408).
     * Entries reserve in assignment order; a conflict records the winner and
     * the loser instead of assigning one resource twice.
     * @param {object[]} assignments Entries from {@link assignTasks}.
     * @param {Map|object} memberPlans `combatantId → plan` (or `{status, plan}`).
     * @param {object} [context]
     * @param {object} [context.taskCapacities] Override
     *   {@link TARGET_TASK_CAPACITY} per task.
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
                const key = `${assignment.task}|${targetId}`;
                const capacity = _finiteOr(capacities[assignment.task], 1);
                const used = targetCount.get(key) ?? 0;
                if (used < capacity) {
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
                const key = `${to.x},${to.y}`;
                if (!endpointOwner.has(key)) {
                    endpointOwner.set(key, assignment.combatantId);
                    endpoints.push({
                        key,
                        x: to.x,
                        y: to.y,
                        memberId: assignment.combatantId
                    });
                    for (const wp of move.input?.waypoints ?? []) {
                        const wpKey = Number.isFinite(wp?.x) && Number.isFinite(wp?.y)
                            ? `${wp.x},${wp.y}` : null;
                        if (wpKey && !routeOwner.has(wpKey)) {
                            routeOwner.set(wpKey, assignment.combatantId);
                            routes.push({
                                key: wpKey,
                                x: wp.x,
                                y: wp.y,
                                memberId: assignment.combatantId
                            });
                        }
                    }
                } else {
                    conflicts.push({
                        type: "endpoint",
                        key,
                        loserId: assignment.combatantId,
                        winnerId: endpointOwner.get(key),
                        reason: "endpoint-reserved"
                    });
                }
            }
        }
        return { targets, endpoints, routes, conflicts };
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
     * Whether a task/target key already reached its reservation capacity.
     * @param {Map} counts `key → used` map.
     * @param {object} capacities Task capacities.
     * @param {string} task
     * @param {string|null} targetId
     * @returns {boolean}
     */
    function _targetAtCapacity(counts, capacities, task, targetId) {
        if (!targetId) return false;
        const key = `${task}|${targetId}`;
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
     * @returns {object[]}
     */
    function _availableTargets(targets, counts, capacities, assignment) {
        return (targets ?? []).filter(target => {
            const id = target?.tokenId
                ?? (typeof target?.tokenUuid === "string"
                    ? target.tokenUuid.split(".").pop() : null);
            return !_targetAtCapacity(counts, capacities, assignment.task, id);
        });
    }

    /**
     * Member target list for one `planTurn` call: the assignment's explicit
     * target wins, then the reservation-filtered shared/injected list.
     * @param {object} input
     * @param {object[]} input.base Shared/injected normalized targets.
     * @param {Map} input.counts Reservation counts.
     * @param {object} input.capacities Task capacities.
     * @param {object} input.assignment Member assignment.
     * @returns {object[]|undefined} Undefined lets the planner resolve.
     */
    function _memberTargets({ base, counts, capacities, assignment }) {
        if (!Array.isArray(base)) return undefined;
        const targets = _availableTargets(base, counts, capacities, assignment);
        if (assignment.assignedTargetId) {
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
     * Build the phased execution layout. Flank-group members always precede
     * the main group inside every phase; the action phase is gated by a
     * synchronization barrier that requires the detached/mover assignments
     * to be satisfied first.
     * @param {object} input
     * @param {object[]} input.ordered Ordered member entries.
     * @param {Map} input.assignMap `combatantId → assignment`.
     * @param {Map} input.plans `combatantId → planTurn result`.
     * @param {Set} input.endpointLosers Members whose move step lost an
     *   endpoint reservation and is therefore excluded from the phases.
     * @returns {object[]} Phase descriptors `{id, name, barrier, steps}`.
     */
    function _buildPhases({ ordered, assignMap, plans, endpointLosers }) {
        const sortKey = member => {
            const group = assignMap.get(member.combatantId)?.groupId ?? "main";
            const rank = group === "main" ? 1 : 0;
            return `${rank}|${member.combatantId}`;
        };
        const sorted = [...ordered].sort((a, b) =>
            sortKey(a).localeCompare(sortKey(b)));
        const movement = [];
        const action = [];
        const regroup = [];
        for (const member of sorted) {
            const result = plans.get(member.combatantId);
            const plan = result?.plan;
            if (!plan) continue;
            const steps = plan.steps ?? [];
            const skippedMove = endpointLosers.has(member.combatantId);
            let moveSkipped = false;
            steps.forEach((step, index) => {
                const ref = {
                    combatantId: member.combatantId,
                    planId: plan.id,
                    stepIndex: index,
                    type: step?.type ?? null
                };
                if (step?.type === "move") {
                    if (skippedMove && !moveSkipped) {
                        moveSkipped = true;
                        return;
                    }
                    movement.push(ref);
                } else if (step?.type === "attack" || step?.type === "test") {
                    action.push(ref);
                } else {
                    regroup.push(ref);
                }
            });
        }
        const moverIds = movement.map(step => step.combatantId);
        const flankIds = sorted
            .filter(member => assignMap.get(member.combatantId)?.groupId === "flank-1")
            .map(member => member.combatantId);
        const required = flankIds.length ? flankIds : [...new Set(moverIds)];
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
            { id: "phase-2", name: "regroup", barrier: null, steps: regroup }
        ];
    }

    /**
     * Normalize a wounds spec: plain number or `{value}` object.
     * @param {*} raw
     * @returns {number|null}
     */
    function _woundsValue(raw) {
        if (Number.isFinite(raw)) return raw;
        if (Number.isFinite(raw?.value)) return raw.value;
        return null;
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
     * Convergence target list: injected `context.targets` win (they may
     * carry `wounds` directly); otherwise the combat scan returns every
     * living non-hidden combatant hostile to the team's shared
     * disposition.
     * @param {object} input
     * @param {object[]} input.members Team member entries.
     * @param {object} input.combat Combat document.
     * @param {object} input.context `buildTeamPlan` context.
     * @returns {object[]} `{tokenId, tokenUuid, x, y, wounds}` entries.
     */
    function _convergentTargets({ members, combat, context }) {
        if (Array.isArray(context.targets) && context.targets.length) {
            return context.targets.map(target => ({
                tokenId: target?.tokenId ?? null,
                tokenUuid: target?.tokenUuid ?? null,
                x: _finiteOr(target?.x, null),
                y: _finiteOr(target?.y, null),
                wounds: _woundsValue(target?.wounds)
            })).filter(entry => entry.tokenId || entry.tokenUuid);
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
            targets.push({
                tokenId: other.tokenId ?? doc.id ?? null,
                tokenUuid: typeof doc.uuid === "string" ? doc.uuid : null,
                x: pos.x,
                y: pos.y,
                wounds: _woundsValue(actor?.system?.wounds)
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
     * Kill-EV convergence objective (issue #16): when the summed expected
     * damage of the members that can actually engage a target reaches its
     * wounds total, the whole team converges on that target instead of
     * distributing. Explicit `context.objective.targetId` orders win;
     * `context.convergence === false`/`context.killEV === false` disable
     * the pass. Deterministic: ties resolve on margin, then target id.
     * @param {object} input
     * @param {object[]} input.members Filtered team members.
     * @param {object} input.combat Combat document.
     * @param {object} input.context `buildTeamPlan` context.
     * @returns {object|null} Descriptor `{targetId, targetUuid, killEV,
     *   wounds, margin, capableMembers}` or null.
     */
    function _convergentObjective({ members, combat, context }) {
        if (context.convergence === false || context.killEV === false) return null;
        if (context.objective?.targetId) return null;
        const targets = _convergentTargets({ members, combat, context });
        if (!targets.length) return null;
        const grid = _convergenceGrid(combat, context);
        const capable = (members ?? [])
            .filter(member => member.enabled !== false && member.defeated !== true);
        const profiles = capable.map(member => ({
            member,
            emitters: weaponEmitters(member.combatant?.actor
                ?? _tokenDoc(member.combatant?.token)?.actor ?? null)
        }));
        let best = null;
        for (const target of targets) {
            // A target whose wounds cannot be read is never converged on:
            // committing a focus-fire on an enemy of unknown toughness is
            // exactly the premature commitment the feature avoids.
            const wounds = _woundsValue(target.wounds);
            if (!(wounds > 0)) continue;
            let killEV = 0;
            const capableMembers = [];
            for (const { member, emitters } of profiles) {
                const ev = _memberKillEV(member, emitters, target, grid);
                if (ev > 0) {
                    killEV += ev;
                    capableMembers.push(member.combatantId);
                }
            }
            killEV = Math.round(killEV * 1e4) / 1e4;
            const margin = Math.round((killEV - wounds) * 1e4) / 1e4;
            if (margin < 0) continue;
            const candidate = {
                targetId: target.tokenId ?? target.tokenUuid,
                targetUuid: target.tokenUuid ?? null,
                killEV,
                wounds,
                margin,
                capableMembers
            };
            if (!best || margin > best.margin + 1e-9
                || (Math.abs(margin - best.margin) <= 1e-9
                    && String(candidate.targetId) < String(best.targetId))) {
                best = candidate;
            }
        }
        return best;
    }

    /**
     * Resolve the bounded team tactic for this plan (issue #412).
     * `context.tactic` may be a tactic factory `(input) => descriptor` or
     * a ready serializable descriptor `{name, reason, assignments,
     * allowFlank, regroup, objective, maxDetachedPhases, breakdown}`; it
     * defaults to the spec-ops selector when the team runs on
     * `teamPreset === "specOps"` or every member resolves to `specOps`.
     * `context.tactic === null`/`false` explicitly disables the hook.
     * @param {object} input
     * @param {object[]} input.members Filtered member entries.
     * @param {string|null} input.leaderId Elected leader combatant id.
     * @param {string} input.teamId
     * @param {string|null} input.teamPreset Resolved shared team preset.
     * @param {number} input.seed Plan seed.
     * @param {object} input.combat Combat document.
     * @param {object} input.context `buildTeamPlan` context.
     * @returns {object|null} Tactic descriptor or null (default policy).
     */
    function _resolveTactic({ members, leaderId, teamId, teamPreset, seed, combat, context }) {
        let source = context.tactic;
        if (source === undefined) {
            const specOpsTeam = teamPreset === SPEC_OPS_PRESET_ID
                || (teamPreset === null && members.length > 0
                    && members.every(m => m.preset === SPEC_OPS_PRESET_ID));
            if (specOpsTeam) source = specOpsTactic;
        }
        if (source === undefined || source === null || source === false) return null;
        if (typeof source === "function") {
            try {
                return source({
                    members,
                    leaderId,
                    teamId,
                    seed,
                    targets: Array.isArray(context.targets) ? context.targets : null,
                    objective: context.objective ?? null,
                    casualties: _finiteOr(context.casualties, 0),
                    scene: context.scene ?? combat?.scene ?? null,
                    combat,
                    context
                }) ?? null;
            } catch(err) {
                return { name: null, reason: "tactic-error" };
            }
        }
        return typeof source === "object" ? source : null;
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
     *   `preferredCohesion`, `targets`, `actions`, `moves`, `perception`,
     *   `navigation`, `authority`, `planner`, `taskCapacities`,
     *   `replanCount`.
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
        let members = collectMembers(combat, teamId)
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
            rejected: []
        };
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
            ?? null;
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

        // Team tactic (issue #412): a preset tactic factory may bind the
        // maneuver — assignments, flank policy, regroup and the shared
        // objective. Explicit caller context fields always win.
        const tactic = _resolveTactic({
            members,
            leaderId: election.combatantId,
            teamId,
            teamPreset,
            seed,
            combat,
            context
        });
        diagnostics.tactic = tactic
            ? _jsonClone({
                name: tactic.name ?? tactic.tactic ?? null,
                reason: tactic.reason ?? null,
                breakdown: tactic.breakdown ?? null
            })
            : null;
        const maxDetachedPhases = _finiteOr(
            context.maxDetachedPhases ?? tactic?.maxDetachedPhases,
            DEFAULT_MAX_DETACHED_PHASES);

        // Issue #16 kill-EV convergence: when the summed expected damage
        // of the members able to engage a target reaches its wounds
        // total, the team converges — every capable member shares the
        // convergent objective and no flank group detaches. Explicit
        // `context.objective`/`context.assignments`/a tactic-bound
        // objective keep precedence; `context.convergence === false`
        // disables the pass.
        const convergence = _convergentObjective({ members, combat, context });
        diagnostics.convergence = convergence ? _jsonClone(convergence) : null;

        const assignments = assignTasks(members, {
            leaderId: election.combatantId,
            assignments: context.assignments ?? tactic?.assignments,
            allowFlank: context.allowFlank ?? tactic?.allowFlank
                ?? (convergence ? false : undefined),
            regroup: context.regroup ?? tactic?.regroup,
            objective: context.objective ?? tactic?.objective
                ?? (convergence
                    ? {
                        targetId: convergence.targetId,
                        capableMembers: convergence.capableMembers
                    }
                    : undefined)
        });
        const assignMap = new Map(assignments.map(a => [a.combatantId, a]));
        diagnostics.assignments = _jsonClone(assignments);

        // Team anchor for task-scoped member evaluation (issue #412):
        // the leader position is the cohesion centre and the first
        // rejoin/regroup point of detached maneuvers.
        const leaderPos = members
            .find(m => m.combatantId === election.combatantId)?.position ?? null;
        const rejoinPoints = regroupPoints(members, { leaderId: election.combatantId });

        // Planning order: leader first, then flank group, then the rest —
        // reservation priority follows maneuver priority.
        const orderOf = member => {
            if (member.combatantId === election.combatantId) return 0;
            return assignMap.get(member.combatantId)?.groupId === "flank-1" ? 1 : 2;
        };
        const ordered = [...members].sort((a, b) =>
            (orderOf(a) - orderOf(b))
            || String(a.combatantId).localeCompare(String(b.combatantId)));

        const capacities = {
            ...TARGET_TASK_CAPACITY,
            ...(context.taskCapacities ?? {})
        };
        const reservedTargets = new Map();
        const plans = new Map();
        let baseTargets = Array.isArray(context.targets) ? context.targets : null;
        for (const member of ordered) {
            const assignment = assignMap.get(member.combatantId);
            const memberContext = {
                ...context,
                seed,
                replanCount: _finiteOr(context.replanCount, 0),
                tactic: tactic?.name ?? tactic?.tactic ?? null,
                team: {
                    teamId,
                    task: assignment.task,
                    groupId: assignment.groupId,
                    leaderId: election.combatantId,
                    center: leaderPos,
                    character,
                    regroupPoint: assignment.task === "regroup"
                        ? (rejoinPoints[0] ?? null) : null
                }
            };
            const memberTargets = _memberTargets({
                base: baseTargets,
                counts: reservedTargets,
                capacities,
                assignment
            });
            if (memberTargets !== undefined) memberContext.targets = memberTargets;
            let result;
            try {
                result = await memberPlanner.planTurn(
                    combat, member.combatant, memberContext);
            } catch(err) {
                result = { status: "error", plan: null, reason: "plan-error" };
            }
            plans.set(member.combatantId, result);
            diagnostics.memberStatuses[member.combatantId] = result?.status ?? "error";
            // Reserve the chosen target immediately so later members cannot
            // double-book the same target for the same task type.
            const targetId = result?.plan?.target?.tokenId
                ?? assignment.assignedTargetId ?? null;
            if (targetId && result?.plan) {
                const key = `${assignment.task}|${targetId}`;
                reservedTargets.set(key, (reservedTargets.get(key) ?? 0) + 1);
            }
            if (!baseTargets && result?.plan) {
                const shared = _sharedTargets(result.plan);
                if (shared) baseTargets = shared;
            }
        }

        // Post-pass: reservation table + conflict detection. Endpoint
        // losers keep their plan but their move step is excluded from the
        // phases (first reservation wins, deterministic order).
        const reservations = reserveResources(assignments, plans, {
            taskCapacities: context.taskCapacities
        });
        diagnostics.reservations = _jsonClone({
            targets: reservations.targets,
            endpoints: reservations.endpoints,
            conflicts: reservations.conflicts
        });
        const targetLosers = new Set(
            reservations.conflicts.filter(c => c.type === "target")
                .map(c => c.loserId));
        const endpointLosers = new Set(
            reservations.conflicts.filter(c => c.type === "endpoint")
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
            const retry = await memberPlanner.planTurn(combat, member.combatant, {
                ...context,
                seed,
                replanCount: _finiteOr(context.replanCount, 0) + 1,
                targets: retryTargets,
                team: {
                    teamId,
                    task: assignment.task,
                    groupId: assignment.groupId,
                    leaderId: election.combatantId,
                    character
                }
            });
            plans.set(member.combatantId, retry);
            const previousStatus = diagnostics.memberStatuses[member.combatantId];
            diagnostics.memberStatuses[member.combatantId] =
                `${previousStatus}->${retry?.status ?? "error"}`;
            const retryTarget = retry?.plan?.target?.tokenId ?? null;
            if (retryTarget) {
                const key = `${assignment.task}|${retryTarget}`;
                reservedTargets.set(key, (reservedTargets.get(key) ?? 0) + 1);
            }
        }

        // Cohesion evaluation: leader position is the team centre; detached
        // maneuvers need a reachable endpoint, a bounded separation and a
        // legal rejoin point.
        const center = leaderPos;
        const memberEntries = [];
        let cohesionPenalty = 0;
        let score = 0;
        const breakdown = { members: {}, cohesion: [] };
        for (const member of ordered) {
            const assignment = assignMap.get(member.combatantId);
            const plan = plans.get(member.combatantId)?.plan ?? null;
            const move = (plan?.steps ?? []).find(step => step?.type === "move");
            const endpoint = move?.input?.to
                ? { x: move.input.to.x, y: move.input.to.y }
                : (member.position ?? null);
            const cohesion = evaluateCohesion({
                endpoint,
                center,
                preferredCohesion,
                task: assignment.task,
                detachedUntilPhase: _finiteOr(context.detachedUntilPhase, 1),
                maxDetachedPhases,
                rejoinAvailable: rejoinPoints.length > 0,
                reachable: move ? endpointLosers.has(member.combatantId) === false : true
            });
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
                diagnostics.rejected.push({
                    member: member.combatantId,
                    reason: `detached-${cohesion.reason}`
                });
            }
            score += _finiteOr(plan?.score, 0);
            breakdown.members[member.combatantId] = _finiteOr(plan?.score, 0);
            memberEntries.push({
                combatantId: member.combatantId,
                tokenId: member.tokenId,
                task: assignment.task,
                groupId: assignment.groupId,
                leader: assignment.leader,
                detached: cohesion.detached,
                detachedUntilPhase: cohesion.detached
                    ? _finiteOr(context.detachedUntilPhase, 1) : null,
                rejoinPoint: cohesion.detached ? (rejoinPoints[0] ?? null) : null,
                assignedTargetId: plan?.target?.tokenId ?? assignment.assignedTargetId,
                assignedTargetUuid: plan?.target?.tokenUuid ?? null,
                assignedEndpoint: move?.input?.to
                    ? { x: move.input.to.x, y: move.input.to.y }
                    : null,
                assignedRoute: Array.isArray(move?.input?.waypoints)
                    ? _jsonClone(move.input.waypoints) : null,
                planId: plan?.id ?? null,
                status: plans.get(member.combatantId)?.status ?? "error"
            });
        }
        score = Math.round((score - cohesionPenalty) * 1e6) / 1e6;
        breakdown.cohesionPenalty = Math.round(cohesionPenalty * 1e6) / 1e6;
        diagnostics.membersPlanned = memberEntries.length;

        const phases = _buildPhases({
            ordered,
            assignMap,
            plans,
            endpointLosers
        });
        const memberPlans = {};
        for (const member of ordered) {
            const plan = plans.get(member.combatantId)?.plan ?? null;
            memberPlans[member.combatantId] = plan ? _jsonClone(plan) : null;
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
            character,
            tactic: diagnostics.tactic?.name ?? null,
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
        evaluateCohesion,
        collectMembers,
        resolveTeamConfig,
        tasks: FIRETEAM_TASKS,
        statuses: FIRETEAM_STATUS,
        reasons: TEAM_PLAN_REASONS,
        barrierFailurePolicies: BARRIER_FAILURE_POLICIES
    };
}
