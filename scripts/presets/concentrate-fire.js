/**
 * Concentrate-fire tactic — концентрация огня на приоритетной цели
 * (issue #85, epic #84).
 *
 * Pure, deterministic, document-free selector by the spec-ops preset
 * pattern: every input arrives normalized (fireteam enriches document
 * data in the integration increment), the same input always yields the
 * same focus target, assignments and diagnostics.
 *
 * Behaviour contract (spec f1-concentrate-fire):
 * - Scored focus selection generalizes the legacy binary kill-EV
 *   convergence: a guaranteed kill stays the special `mode: "kill"`
 *   case (whole capable team, no cap, no exclusions); the scored pass
 *   yields `mode: "focus"` with capacity-limited assignment.
 * - Wounds semantics follow the system truth: `system.wounds.value` is
 *   damage TAKEN, `system.wounds.max` the health capacity — effective
 *   health is `max − value`. Plain-number and `{value}`-only injections
 *   are treated as effective directly (unit-fixture back-compat).
 * - focusScore(t) = W_KILL×killRatio + W_THREAT×threatNorm
 *   + W_VULN×vuln + W_REACT×reactSpent ± friendly-fire term
 *   − W_EXPOSE×exposure + hysteresis. The friendly-fire sign is preset
 *   doctrine: ranged presets penalize shooting into melee (−W_FF),
 *   assault treats an engaged ally as a gang-up bonus (+W_GANG).
 * - Exposure guards situational awareness: concentrating members on one
 *   target while other visible threats stay uncovered makes the
 *   concentration costlier. Targets with unknown loadout (threatEv 0)
 *   count as slightly dangerous (UNKNOWN_THREAT_FLOOR) when summed as
 *   other threats, but their own threatNorm is 0 — concentration on a
 *   helpless pinned enemy loses to a live gunner ("не бить лежачего").
 * - Hysteresis: members' fresh `lastTarget` records (round ≥ current − 1,
 *   the planner.js freshness convention) add incumbency mass to the
 *   target the team already engages; round 1 has no hysteresis. All
 *   stickiness data arrives as input — the module never reads documents.
 * - Trivial case: exactly one candidate never triggers the scored pass
 *   (`single-target`) — only the legacy kill condition still produces a
 *   kill-mode descriptor. An explicit `context.objective.targetId`
 *   (GM order) suppresses the pass entirely.
 * - Grudge/stickyTarget conflict resolution is structural, not weighted:
 *   assigned members receive a narrowed target pool in the fireteam
 *   integration, so per-member factors simply never fire for them;
 *   non-assigned members plan on the remaining pool where grudge and
 *   personal stickiness act as tiebreakers among non-focus targets.
 */
import { reactionUsed } from "../reactions.js";

/**
 * Experimental baseline coefficients (spec f1): starting tuning points,
 * overridable per-plan through `context.focus` or the `config` argument.
 * `focusCapShare`/`gangUp` are the fallback doctrine values used when the
 * preset has no entry in {@link CONCENTRATE_FIRE_PRESET_OVERRIDES}.
 */
export const CONCENTRATE_FIRE_CONFIG = Object.freeze({
    W_KILL: 2.0,
    W_THREAT: 1.5,
    W_VULN: 1.0,
    W_REACT: 0.75,
    W_FF: 1.5,
    W_GANG: 0.75,
    W_EXPOSE: 1.0,
    W_STICKY: 0.5,
    K_OVERKILL: 1.5,
    REF_THREAT: 15,
    STICKY_CAP: 3,
    UNKNOWN_THREAT_FLOOR: 0.25,
    EXPOSURE_COVER_RATE: 0.5,
    focusCapShare: 0.75,
    gangUp: false,
    vulnerableStatuses: Object.freeze(["pinned", "prone", "stunned"]),
    diagnosticsCap: 8
});

/**
 * Per-preset doctrine overlay (spec table): `focusCapShare` caps how much
 * of the capable team may concentrate on the focus target; `gangUp`
 * inverts the friendly-fire sign — assault treats an ally engaged in
 * melee with the target as a bonus, not a shooting-into-melee penalty.
 */
export const CONCENTRATE_FIRE_PRESET_OVERRIDES = Object.freeze({
    assault: Object.freeze({ focusCapShare: 1.0, gangUp: true }),
    rangedCover: Object.freeze({ focusCapShare: 0.75 }),
    hold: Object.freeze({ focusCapShare: 0.5 }),
    specOps: Object.freeze({ focusCapShare: 1.0 })
});

/** Stable machine-readable reasons for an empty focus result. */
export const FOCUS_REASONS = Object.freeze({
    disabled: "disabled",
    explicitObjective: "explicit-objective",
    noCandidates: "no-candidates",
    singleTarget: "single-target",
    belowThreshold: "below-threshold",
    noCapableMembers: "no-capable-members"
});

/** Focus descriptor modes: legacy guaranteed kill vs scored focus. */
export const FOCUS_MODES = Object.freeze([
    "kill",
    "focus"
]);

/** Comparison epsilon mirroring the fireteam/planner float discipline. */
const EPS = 1e-9;

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
 * Clamp a number into `[0, 1]`; non-finite input reads as 0.
 * @param {*} value
 * @returns {number}
 */
function _clamp01(value) {
    return Math.max(0, Math.min(1, _finiteOr(value, 0)));
}

/**
 * Round to 4 decimals for stable serialization and test comparisons.
 * Negative zero is normalized away — it breaks `deepStrictEqual` and
 * JSON round-trips for zero-valued terms like the friendly-fire one.
 * @param {*} value
 * @returns {number|null}
 */
function _round4(value) {
    if (!Number.isFinite(value)) return null;
    const rounded = Math.round(value * 1e4) / 1e4;
    return rounded === 0 ? 0 : rounded;
}

/**
 * Normalize a wounds spec to effective health `{effective, known}`.
 * Corrected semantics (spec fix): `{value, max}` means damage taken vs
 * capacity, so effective health is `max − value` (negative — deep in
 * criticals). A missing `value` defaults to 0 (fresh enemy); plain
 * numbers and `{value}`-only objects are legacy test injections read as
 * effective directly. An explicit `known === false` forces unknown.
 * @param {*} raw Number, `{value, max}` object or null.
 * @param {boolean|*} [known] Explicit `woundsKnown` override.
 * @returns {{effective: number|null, known: boolean}}
 */
export function normalizeFocusWounds(raw, known = undefined) {
    if (known === false) return { effective: null, known: false };
    if (Number.isFinite(raw)) return { effective: raw, known: true };
    if (raw && typeof raw === "object") {
        const value = Number.isFinite(raw.value) ? raw.value : null;
        const max = Number.isFinite(raw.max) ? raw.max : null;
        if (max !== null && value !== null) {
            return { effective: max - value, known: true };
        }
        if (max !== null) return { effective: max, known: true };
        if (value !== null) return { effective: value, known: true };
    }
    return { effective: null, known: false };
}

/**
 * Resolve the effective concentrate-fire config: baseline, then the
 * preset doctrine overlay, then explicit `config` overrides, then the
 * per-plan `context.focus` overrides (which the spec lets override
 * everything). Invalid values fall through to the previous layer.
 * @param {object|null} [overrides] Explicit selector overrides.
 * @param {string|null} [preset] Team preset id.
 * @param {object|null} [planOverrides] `context.focus` per-plan overrides.
 * @returns {object}
 */
export function resolveConcentrateFireConfig(overrides = null, preset = null, planOverrides = null) {
    const result = {
        ...CONCENTRATE_FIRE_CONFIG,
        vulnerableStatuses: [...CONCENTRATE_FIRE_CONFIG.vulnerableStatuses]
    };
    const layers = [
        CONCENTRATE_FIRE_PRESET_OVERRIDES[preset] ?? null,
        overrides,
        planOverrides
    ];
    for (const layer of layers) {
        if (!layer || typeof layer !== "object") continue;
        for (const key of Object.keys(result)) {
            if (key === "gangUp") {
                if (typeof layer[key] === "boolean") result[key] = layer[key];
            } else if (key === "vulnerableStatuses") {
                if (Array.isArray(layer[key]) && layer[key].every(id => typeof id === "string")) {
                    result[key] = [...layer[key]];
                }
            } else if (key === "diagnosticsCap") {
                if (Number.isInteger(layer[key]) && layer[key] >= 0) result[key] = layer[key];
            } else if (Number.isFinite(layer[key])) {
                result[key] = layer[key];
            }
        }
    }
    return result;
}

/**
 * Capacity of the focus assignment (spec): the share-based cap keeps at
 * least two capable members on the target (one capable — just the one),
 * never exceeds the capable count and is overridden wholesale when no
 * other threats remain on the field. An explicit positive override wins.
 * @param {object} input
 * @param {number} input.capableCount Members with killEV > 0 vs the target.
 * @param {number} input.share `focusCapShare` doctrine fraction.
 * @param {number} input.otherThreats Summed threat mass of other targets.
 * @param {number} [input.override] Explicit `context.focus.focusCap`.
 * @returns {number}
 */
export function computeFocusCap({ capableCount = 0, share = 0.75, otherThreats = 0, override = null } = {}) {
    if (!(capableCount > 0)) return 0;
    if (Number.isFinite(override) && override > 0) {
        return Math.max(1, Math.min(Math.round(override), capableCount));
    }
    if (!(otherThreats > EPS)) return capableCount;
    if (capableCount === 1) return 1;
    return Math.max(2, Math.min(Math.round(capableCount * share), capableCount));
}

/**
 * Exposure guard (spec): threat mass left uncovered once `focusCap`
 * members concentrate on the focus target. Each unassigned member covers
 * `EXPOSURE_COVER_RATE` of normalized threat; the result saturates at 1.
 * @param {object} input
 * @param {number} input.otherThreats Summed threat mass of other targets.
 * @param {number} input.memberCount Living enabled team members.
 * @param {number} input.focusCap Members assigned to the focus target.
 * @param {number} [input.coverRate] Coverage per unassigned member.
 * @returns {number} 0..1 exposure penalty factor.
 */
export function computeExposure({ otherThreats = 0, memberCount = 0, focusCap = 0, coverRate = 0.5 } = {}) {
    const residual = Math.max(0, memberCount - focusCap);
    const uncovered = Math.max(0, _finiteOr(otherThreats, 0) - (residual * coverRate));
    return _clamp01(uncovered);
}

/**
 * Normalize one status id collection (array/Set/iterable or truthy-map,
 * mirroring the member status merge in fireteam).
 * @param {*} source
 * @returns {string[]}
 */
function _statusIds(source) {
    const ids = new Set();
    if (source) {
        if (typeof source[Symbol.iterator] === "function") {
            for (const id of source) {
                if (typeof id === "string") ids.add(id);
            }
        } else if (typeof source === "object") {
            for (const key of Object.keys(source)) {
                if (source[key]) ids.add(String(key));
            }
        }
    }
    return [...ids].sort();
}

/**
 * Normalize one raw target input; entries without any id are dropped.
 * @param {*} raw
 * @returns {object|null}
 */
function _normalizeTarget(raw) {
    if (!raw || typeof raw !== "object") return null;
    const tokenId = typeof raw.tokenId === "string" ? raw.tokenId
        : (raw.tokenId != null ? String(raw.tokenId) : null);
    const tokenUuid = typeof raw.tokenUuid === "string" ? raw.tokenUuid : null;
    if (!tokenId && !tokenUuid) return null;
    const wounds = normalizeFocusWounds(raw.wounds, raw.woundsKnown);
    return {
        tokenId,
        tokenUuid,
        targetId: tokenId ?? tokenUuid,
        actorId: raw.actorId ?? null,
        statuses: _statusIds(raw.statuses),
        reactionUsed: raw.reactionUsed ?? null,
        threatEv: Math.max(0, _finiteOr(raw.threatEv, 0)),
        allyEngaged: raw.allyEngaged === true,
        stickyCount: Number.isFinite(raw.stickyCount) ? raw.stickyCount : null,
        woundsEffective: wounds.effective,
        woundsKnown: wounds.known
    };
}

/**
 * The per-member capability against one target: `member.capability` keys
 * entries by tokenId or tokenUuid; a plain number is killEV shorthand,
 * the object form carries `{killEV, losCapable}`.
 * @param {object} member Normalized member input.
 * @param {object} target Normalized target.
 * @returns {{killEV: number, losCapable: boolean}}
 */
function _capabilityOf(member, target) {
    const map = member?.capability;
    if (!map || typeof map !== "object") return { killEV: 0, losCapable: false };
    const entry = (target.tokenId ? map[target.tokenId] : undefined)
        ?? (target.tokenUuid ? map[target.tokenUuid] : undefined)
        ?? map[target.targetId];
    if (Number.isFinite(entry)) return { killEV: entry, losCapable: false };
    if (entry && typeof entry === "object") {
        return {
            killEV: _finiteOr(entry.killEV, 0),
            losCapable: entry.losCapable === true || entry.los === true
        };
    }
    return { killEV: 0, losCapable: false };
}

/**
 * Whether a member's `lastTarget` record points at the target — by
 * tokenId, tokenUuid or actorId, mirroring the planner's sticky matching.
 * @param {*} record `lastTarget` flag-shaped record.
 * @param {object} target Normalized target.
 * @returns {boolean}
 */
function _lastTargetMatches(record, target) {
    if (!record || typeof record !== "object") return false;
    if (record.tokenId != null && target.tokenId != null
        && String(record.tokenId) === String(target.tokenId)) return true;
    if (record.tokenUuid != null && target.tokenUuid != null
        && String(record.tokenUuid) === String(target.tokenUuid)) return true;
    if (record.actorId != null && target.actorId != null
        && String(record.actorId) === String(target.actorId)) return true;
    return false;
}

/**
 * Freshness of a `lastTarget` record — the planner.js convention: valid
 * while from this or the previous round, roundless records count as
 * fresh, an unknown live round conservatively accepts everything.
 * @param {*} record
 * @param {number|null} round Current combat round.
 * @returns {boolean}
 */
function _lastTargetFresh(record, round) {
    if (!record || typeof record !== "object") return false;
    if (!Number.isFinite(record.round)) return true;
    if (!Number.isFinite(round)) return true;
    return record.round >= round - 1;
}

/**
 * Incumbent mass on a target: members with a fresh `lastTarget` record
 * pointing at it. An explicit numeric `target.stickyCount` wins — it is
 * the caller-injected override for already-aggregated data. Round 1 has
 * no hysteresis at all (spec), but an explicit count is the caller's
 * responsibility and passes through unchanged.
 * @param {object} target Normalized target.
 * @param {object[]} members Available member inputs.
 * @param {number|null} round Current combat round.
 * @returns {number}
 */
export function focusStickyCount(target, members = [], round = null) {
    if (Number.isFinite(target?.stickyCount)) return target.stickyCount;
    if (Number.isFinite(round) && round <= 1) return 0;
    let count = 0;
    for (const member of members ?? []) {
        const record = member?.lastTarget;
        if (_lastTargetFresh(record, round) && _lastTargetMatches(record, target)) count += 1;
    }
    return count;
}

/**
 * Threat contribution of one target when summed as an OTHER threat in
 * the exposure guard: unknown loadout (`threatEv` 0) counts as slightly
 * dangerous, proven threat normalizes against `REF_THREAT`.
 * @param {object} target Normalized target.
 * @param {object} cfg Resolved concentrate-fire config.
 * @returns {number}
 */
export function otherThreatContribution(target, cfg = CONCENTRATE_FIRE_CONFIG) {
    if (!(target?.threatEv > 0)) return cfg.UNKNOWN_THREAT_FLOOR;
    return _clamp01(target.threatEv / cfg.REF_THREAT);
}

/**
 * Evaluate one focus candidate end to end: kill-EV sum, capability,
 * capacity, exposure guard, hysteresis and the weighted focus score.
 * All arithmetic is pure arithmetic on normalized inputs.
 * @param {object} input
 * @param {object} input.target Normalized target (`_normalizeTarget` output shape).
 * @param {object[]} input.members Available member inputs.
 * @param {object[]} input.targets ALL normalized input targets — including
 *   excluded non-candidates: exclusion removes candidacy, not the threat.
 * @param {number|null} [input.round] Current combat round.
 * @param {object} [input.config] Resolved concentrate-fire config.
 * @param {number} [input.focusCapOverride] Explicit per-plan cap override.
 * @returns {object} Raw (unrounded) component breakdown plus score.
 */
export function evaluateFocusCandidate({
    target,
    members = [],
    targets = [],
    round = null,
    config = CONCENTRATE_FIRE_CONFIG,
    focusCapOverride = null
} = {}) {
    const cfg = config;
    const vulnerableSet = new Set(cfg.vulnerableStatuses);
    let killEV = 0;
    const capable = [];
    for (const member of members ?? []) {
        const contribution = _capabilityOf(member, target);
        if (contribution.killEV > 0) {
            killEV += contribution.killEV;
            capable.push({
                combatantId: member.combatantId,
                killEV: contribution.killEV,
                losCapable: contribution.losCapable
            });
        }
    }
    const memberCount = (members ?? []).length;
    const capableCount = capable.length;
    const effective = target.woundsEffective;
    const woundsKnown = target.woundsKnown === true && Number.isFinite(effective);
    let killRatio = 0;
    if (woundsKnown) {
        if (effective <= 0) {
            // Deep in criticals: any real damage output finishes the target.
            killRatio = killEV > 0 ? 1 : 0;
        } else {
            killRatio = _clamp01(killEV / (effective * cfg.K_OVERKILL));
        }
    }
    const threatNorm = target.threatEv > 0 ? _clamp01(target.threatEv / cfg.REF_THREAT) : 0;
    const vulnerable = target.statuses.some(id => vulnerableSet.has(id)) ? 1 : 0;
    const reactionSpent = reactionUsed(target.reactionUsed, round) ? 1 : 0;
    const friendlyFire = target.allyEngaged ? 1 : 0;
    const friendlyFireTerm = cfg.gangUp
        ? cfg.W_GANG * friendlyFire
        : -cfg.W_FF * friendlyFire;
    let otherThreats = 0;
    for (const other of targets ?? []) {
        if (!other || other.targetId === target.targetId) continue;
        otherThreats += otherThreatContribution(other, cfg);
    }
    const focusCap = computeFocusCap({
        capableCount,
        share: cfg.focusCapShare,
        otherThreats,
        override: focusCapOverride
    });
    const exposure = computeExposure({
        otherThreats,
        memberCount,
        focusCap,
        coverRate: cfg.EXPOSURE_COVER_RATE
    });
    const stickyCount = focusStickyCount(target, members, round);
    const hysteresis = Math.min(stickyCount, cfg.STICKY_CAP) * cfg.W_STICKY;
    const total = (cfg.W_KILL * killRatio)
        + (cfg.W_THREAT * threatNorm)
        + (cfg.W_VULN * vulnerable)
        + (cfg.W_REACT * reactionSpent)
        + friendlyFireTerm
        - (cfg.W_EXPOSE * exposure)
        + hysteresis;
    return {
        targetId: target.targetId,
        tokenId: target.tokenId,
        targetUuid: target.tokenUuid,
        killEV,
        woundsEffective: effective,
        woundsKnown,
        capableCount,
        capable,
        memberCount,
        focusCap,
        killRatio,
        threatNorm,
        vulnerable,
        reactionSpent,
        friendlyFire,
        friendlyFireTerm,
        otherThreats,
        exposure,
        stickyCount,
        hysteresis,
        total
    };
}

/**
 * Whether the legacy guaranteed-kill condition holds: readable wounds
 * and a real positive kill-EV covering the effective health. `killEV > 0`
 * keeps a zero-capability team out of a degenerate kill mode; targets at
 * or below zero effective health (criticals) qualify when the team can
 * actually damage them.
 * @param {object} evaluated {@link evaluateFocusCandidate} output.
 * @returns {boolean}
 */
function _killCondition(evaluated) {
    return evaluated.woundsKnown === true
        && evaluated.killEV > 0
        && Number.isFinite(evaluated.woundsEffective)
        && evaluated.killEV + EPS >= evaluated.woundsEffective;
}

/**
 * Deterministic assignment ordering: kill-EV contribution descending,
 * proven LOS first at equal contribution, combatant id as the final tie
 * break. The first `focusCap` entries receive the focus assignment; the
 * capable overflow is excluded from the focus target's pool.
 * @param {object[]} capable Capability entries of the winning target.
 * @returns {object[]} Sorted copy.
 */
function _rankCapable(capable) {
    return [...(capable ?? [])].sort((a, b) => {
        const diff = b.killEV - a.killEV;
        if (Math.abs(diff) > EPS) return diff;
        if (a.losCapable !== b.losCapable) return a.losCapable ? -1 : 1;
        return String(a.combatantId).localeCompare(String(b.combatantId));
    });
}

/**
 * Rounded serializable breakdown of one evaluated candidate.
 * @param {object} evaluated {@link evaluateFocusCandidate} output.
 * @returns {object}
 */
function _breakdownOf(evaluated) {
    return {
        killRatio: _round4(evaluated.killRatio),
        threatNorm: _round4(evaluated.threatNorm),
        vulnerable: evaluated.vulnerable,
        reactionSpent: evaluated.reactionSpent,
        friendlyFire: evaluated.friendlyFire,
        friendlyFireTerm: _round4(evaluated.friendlyFireTerm),
        exposure: _round4(evaluated.exposure),
        otherThreats: _round4(evaluated.otherThreats),
        stickyCount: evaluated.stickyCount,
        hysteresis: _round4(evaluated.hysteresis),
        total: _round4(evaluated.total)
    };
}

/**
 * Serializable candidate entry for diagnostics.
 * @param {object} evaluated {@link evaluateFocusCandidate} output.
 * @returns {object}
 */
function _candidateEntry(evaluated) {
    return {
        targetId: evaluated.targetId,
        targetUuid: evaluated.targetUuid,
        focusScore: _round4(evaluated.total),
        killEV: _round4(evaluated.killEV),
        wounds: evaluated.woundsKnown ? _round4(evaluated.woundsEffective) : null,
        woundsKnown: evaluated.woundsKnown,
        capableCount: evaluated.capableCount,
        focusCap: evaluated.focusCap,
        breakdown: _breakdownOf(evaluated)
    };
}

/**
 * Build the backward-compatible focus descriptor (superset of the legacy
 * convergence shape: `targetId…capableMembers` keep their names and
 * meaning, `margin` counts from corrected effective wounds).
 * @param {object} evaluated Winning candidate evaluation.
 * @param {string} mode `"kill"` or `"focus"`.
 * @param {object} input Extra shape data.
 * @param {object|null} [input.runnerUp] Runner-up candidate evaluation.
 * @param {boolean} [input.scored] Whether the scored pass ran.
 * @returns {object}
 */
function _buildDescriptor(evaluated, mode, { runnerUp = null, scored = true } = {}) {
    const ranked = _rankCapable(evaluated.capable);
    const kill = mode === "kill";
    const focusCap = kill ? ranked.length : evaluated.focusCap;
    const assignedMembers = ranked.slice(0, focusCap).map(entry => entry.combatantId);
    // Kill mode is the legacy full-team convergence: nobody is excluded.
    // Focus mode excludes only the capable overflow — non-capable members
    // cannot engage the target anyway and keep the full remaining pool.
    const excludedMembers = kill ? [] : ranked.slice(focusCap).map(entry => entry.combatantId);
    const margin = evaluated.woundsKnown && Number.isFinite(evaluated.woundsEffective)
        ? _round4(evaluated.killEV - evaluated.woundsEffective) : null;
    return {
        targetId: evaluated.targetId,
        targetUuid: evaluated.targetUuid,
        killEV: _round4(evaluated.killEV),
        wounds: evaluated.woundsKnown ? _round4(evaluated.woundsEffective) : null,
        margin,
        capableMembers: ranked.map(entry => entry.combatantId),
        mode,
        focusScore: scored ? _round4(evaluated.total) : null,
        focusCap,
        assignedMembers,
        excludedMembers,
        woundsKnown: evaluated.woundsKnown,
        breakdown: scored ? _breakdownOf(evaluated) : null,
        runnerUp: runnerUp
            ? { targetId: runnerUp.targetId, focusScore: _round4(runnerUp.total) }
            : null
    };
}

/**
 * Deterministic focus-target selector (issue #85): picks the priority
 * target the team concentrates on, the capacity-limited member
 * assignment and the exclusion set. Pure and document-free — wounds,
 * statuses, reaction, threat, capability and stickiness all arrive as
 * normalized inputs.
 * @param {object} input
 * @param {object[]} [input.targets] Visible hostile targets; entries:
 *   `{tokenId, tokenUuid, wounds, woundsKnown?, statuses, reactionUsed,
 *   threatEv, allyEngaged, stickyCount?}`. Excluded targets stay in this
 *   list — they no longer are candidates but still count as threats.
 * @param {object[]} [input.members] Team members; entries:
 *   `{combatantId, enabled?, defeated?, capability: {targetId: number|
 *   {killEV, losCapable?}}, lastTarget?}`. Incapable/dead entries are
 *   ignored for assignment but never read from documents here.
 * @param {number} [input.casualties] Defeated teammates (diagnostics echo).
 * @param {number|null} [input.round] Current combat round — reaction and
 *   stickiness freshness.
 * @param {string|null} [input.preset] Team preset id (doctrine overlay).
 * @param {object} [input.context] `objective`, `convergence`/`killEV`/
 *   `focus` disable flags, `excludeTargetIds`, per-plan `focus` overrides.
 * @param {object} [input.config] Explicit config overrides.
 * @returns {object} `{focus, reason, candidates, diagnostics}` — `focus`
 *   is the serializable descriptor or null; `candidates` the capped
 *   diagnostics list; `diagnostics` carries the resolved coefficients.
 */
export function selectFocusTarget({
    targets = [],
    members = [],
    casualties = 0,
    round = null,
    preset = null,
    context = {},
    config = null
} = {}) {
    const liveRound = Number.isFinite(round) ? round
        : (Number.isFinite(context?.round) ? context.round : null);
    const planFocus = context?.focus && typeof context.focus === "object" ? context.focus : null;
    const cfg = resolveConcentrateFireConfig(config, preset, planFocus);
    const capList = entries => entries
        .sort((a, b) => (b.focusScore - a.focusScore)
            || String(a.targetId).localeCompare(String(b.targetId)))
        .slice(0, cfg.diagnosticsCap);
    const finish = (focus, reason, evaluatedList = [], extra = {}) => ({
        focus,
        reason,
        candidates: capList(evaluatedList.map(_candidateEntry)),
        diagnostics: {
            reason,
            preset: preset ?? null,
            round: liveRound,
            memberCount: available.length,
            casualties: Math.max(0, _finiteOr(casualties, 0)),
            coefficients: { ...cfg, vulnerableStatuses: [...cfg.vulnerableStatuses] },
            ...extra
        }
    });

    const available = (members ?? [])
        .filter(member => member && member.combatantId
            && member.defeated !== true && member.enabled !== false);

    if (context?.convergence === false || context?.killEV === false || context?.focus === false) {
        return finish(null, FOCUS_REASONS.disabled);
    }
    if (context?.objective?.targetId) {
        return finish(null, FOCUS_REASONS.explicitObjective);
    }

    const exclusions = new Set([
        ...(Array.isArray(context?.excludeTargetIds) ? context.excludeTargetIds : []),
        ...(Array.isArray(planFocus?.excludeTargetIds) ? planFocus.excludeTargetIds : [])
    ].map(String));
    const normalized = (targets ?? []).map(_normalizeTarget).filter(Boolean);
    const excluded = target => (target.tokenId != null && exclusions.has(String(target.tokenId)))
        || (target.tokenUuid != null && exclusions.has(String(target.tokenUuid)));
    const candidates = normalized.filter(target => !excluded(target));
    if (!normalized.length || !candidates.length) {
        return finish(null, FOCUS_REASONS.noCandidates);
    }
    if (!available.length) {
        return finish(null, FOCUS_REASONS.noCapableMembers);
    }

    const focusCapOverride = Number.isFinite(planFocus?.focusCap) ? planFocus.focusCap : null;
    const evaluate = target => evaluateFocusCandidate({
        target,
        members: available,
        targets: normalized,
        round: liveRound,
        config: cfg,
        focusCapOverride
    });

    // Trivial case: one candidate never triggers the scored pass — the
    // team would engage it anyway; only the legacy guaranteed-kill
    // condition still produces a (backward-compatible) kill descriptor.
    if (candidates.length === 1) {
        const only = evaluate(candidates[0]);
        if (_killCondition(only)) {
            return finish(_buildDescriptor(only, "kill", { scored: false }), null, [], {
                mode: "kill"
            });
        }
        return finish(null, FOCUS_REASONS.singleTarget);
    }

    const evaluated = candidates.map(evaluate);
    let best = null;
    for (const entry of evaluated) {
        if (!best || entry.total > best.total + EPS
            || (Math.abs(entry.total - best.total) <= EPS
                && (entry.killEV > best.killEV + EPS
                    || (Math.abs(entry.killEV - best.killEV) <= EPS
                        && String(entry.targetId) < String(best.targetId))))) {
            best = entry;
        }
    }
    const runnerUp = evaluated
        .filter(entry => entry !== best)
        .sort((a, b) => (b.total - a.total)
            || (b.killEV - a.killEV)
            || String(a.targetId).localeCompare(String(b.targetId)))[0] ?? null;

    if (!(best.total > 0)) {
        return finish(null, FOCUS_REASONS.belowThreshold, evaluated);
    }
    if (best.capableCount < 1) {
        return finish(null, FOCUS_REASONS.noCapableMembers, evaluated);
    }
    const mode = _killCondition(best) ? "kill" : "focus";
    return finish(_buildDescriptor(best, mode, { runnerUp, scored: true }), null, evaluated, {
        mode
    });
}
