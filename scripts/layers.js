/**
 * Behaviour layers L0–L4 (issue #24, epic #363): the planning funnel.
 *
 * Bot behaviour is a nested funnel — every layer only *narrows* the
 * candidate space of the layer below and never generates parallel
 * candidates of its own:
 *
 * - **L0 hard veto** — absolute legality gates: allies under a blast,
 *   unreachable/illegal actions, missing rights, `gridless-unsupported`,
 *   `canAttack`, status vetoes (pinned/prone/stunned) and preset vetoes.
 *   Nothing below may override an L0 rejection — no trait, no morale
 *   state. Enforced structurally: vetoed candidates never enter the
 *   scored set (the planner records every rejection as an L0 reason).
 * - **L1 commitment** — a still-valid multi-turn plan executes its next
 *   step and the scoring pipeline never runs. Implemented in issue #25:
 *   the record persists on the combatant `committedPlan` flag (written
 *   controller-only by the executor), is re-validated against its
 *   `expectedState` every turn (TTL, own-move journal, GM intervention,
 *   target, morale tier, threat drift, cheap L0) and reports stable
 *   reason codes. The injected `context.commitment` seam of issue #24
 *   stays: a bare `{valid?, steps, source?}` record is trusted verbatim,
 *   a full persisted-shape record runs the same validation as a flag
 *   read — so tests and integrations can exercise both paths.
 * - **L2 morale** — the fireteam's ternary posture
 *   (confident/pressured/desperate, issue #26). The controller-side
 *   team evaluation counts living members, losses, pinned members,
 *   enemies and threat-map space control into a hysteresis-gated
 *   record persisted on each member's `morale` flag; the layer reads
 *   that record, derives the member's *effective* tier through the
 *   trait exceptions (fanatic ignores `desperate`, cowardly escalates
 *   `pressured` to `desperate`) and narrows scoring through the bounded
 *   posture weight deltas while the fireteam remaps task assignments.
 *   The legacy graceful reads of the `morale` flag (issue #38
 *   sync/order hooks) stay unconditional by contract.
 * - **L3 personalities** — additive weight deltas inside the narrowed
 *   set, braced to ±30% of the base weight
 *   ({@link boundedPersonalityOverlay}) plus the seeded per-candidate
 *   jitter (`scripts/personalities.js`, issue #19).
 * - **L4 base utility + lookahead** — the existing deterministic scoring;
 *   reached only when planning happens from scratch (no commitment hit).
 *
 * Every layer is pure and deterministic: layers never write documents and
 * never keep state between calls; memory stays per-bot. Each layer
 * reports its decision as a unified reason record
 * `{layer, code, detail}` pushed onto `diagnostics.layers` — the
 * chronological plumbing issue #27 builds the full trace tool on.
 *
 * Layer toggles resolve through {@link resolveLayerFlags}: the four
 * world settings (`layersCommitment`/`layersMorale`/`layersPersonality`/
 * `layersLookahead`) carry {@link DEFAULT_LAYER_FLAGS} defaults and are
 * overridable per plan via `context.layers`. A disabled layer degrades
 * to the previous level — no errors, no missing plans.
 */
import {
    COMMITMENT_JOURNAL_MAX,
    COMMITMENT_POSITION_TOLERANCE_PX,
    COMMITMENT_REACTIVE_THRESHOLD,
    COMMITMENT_THREAT_MAX,
    COMMITMENT_THREAT_TOLERANCE,
    COMMITMENT_TTL_ROUNDS,
    DEFAULT_LAYER_FLAGS,
    FLAG_KEYS,
    MODULE_ID,
    MORALE_CONFIDENT_SPACE_CONTROL,
    MORALE_DEFAULT_TIER,
    MORALE_DESPERATE_LOSS_RATIO,
    MORALE_DESPERATE_OUTNUMBER_RATIO,
    MORALE_DESPERATE_RECENT_LOSSES,
    MORALE_DESPERATE_SPACE_CONTROL,
    MORALE_HYSTERESIS_ROUNDS,
    MORALE_LOSS_LOG_MAX,
    MORALE_RECENT_LOSS_ROUNDS,
    MORALE_SEEN_ENEMIES_MAX,
    MORALE_SAFE_DANGER,
    MORALE_TIERS
} from "./constants.js";
import {
    PERSONALITIES,
    personalityBehaviorFlags,
    personalityWeightDelta
} from "./personalities.js";
import { getLayerFlags, isManualOverrideGrace } from "./settings.js";

/** Ordered ids of the planning funnel. */
export const LAYER_IDS = Object.freeze(["L0", "L1", "L2", "L3", "L4"]);

/**
 * Maximum signed shift a personality delta may apply to a weight,
 * expressed as a fraction of the base weight (issue #24 bound: ±30%).
 */
export const L3_DELTA_MAX_RATIO = 0.3;

/**
 * Reference weight scale used only when the base weight is `0` (or
 * missing): `30%` of zero would clamp every trait to silence, so factors
 * the preset ignores may still be nudged inside `± L3_DELTA_MAX_RATIO ×
 * L3_DELTA_BASE_FLOOR` — ±6, roughly the pull of a mid-tier preset
 * weight. Non-zero bases keep the strict `±30%` brace.
 */
export const L3_DELTA_BASE_FLOOR = 20;

/** Layer-toggle keys understood by {@link resolveLayerFlags}. */
export const LAYER_FLAG_KEYS = Object.freeze(Object.keys(DEFAULT_LAYER_FLAGS));

/**
 * Build one unified layer reason record `{layer, code, detail}`. `detail`
 * must stay JSON-serializable — plans and diagnostics are deep-frozen
 * and serialized.
 * @param {string} layer One of `LAYER_IDS`.
 * @param {string} code Stable kebab-case reason code.
 * @param {*} [detail] Optional JSON-serializable payload.
 * @returns {{layer: string, code: string, detail?: *}}
 */
export function makeLayerReason(layer, code, detail = undefined) {
    const record = { layer, code };
    if (detail !== undefined && detail !== null) record.detail = detail;
    return record;
}

/**
 * Append a layer reason to `diagnostics.layers` (created on demand).
 * No-op without a diagnostics object — callers may pass `null`.
 * @param {object|null} diagnostics Plan diagnostics record.
 * @param {string} layer One of `LAYER_IDS`.
 * @param {string} code Stable reason code.
 * @param {*} [detail] Optional JSON-serializable payload.
 * @returns {object|null} The recorded reason or null.
 */
export function recordLayerReason(diagnostics, layer, code, detail = undefined) {
    if (!diagnostics || typeof diagnostics !== "object") return null;
    if (!Array.isArray(diagnostics.layers)) diagnostics.layers = [];
    const record = makeLayerReason(layer, code, detail);
    diagnostics.layers.push(record);
    return record;
}

/**
 * Effective per-plan layer toggles: `context.layers` boolean overrides
 * win, everything else falls back to the world settings
 * ({@link getLayerFlags} which itself falls back to
 * {@link DEFAULT_LAYER_FLAGS}). Unknown override keys are ignored.
 * @param {object} [context] Planning context (`context.layers`).
 * @returns {object} `{commitment, morale, personality, lookahead}`.
 */
export function resolveLayerFlags(context = {}) {
    const world = getLayerFlags();
    const overrides = context?.layers ?? {};
    const flags = {};
    for (const key of LAYER_FLAG_KEYS) {
        flags[key] = typeof overrides[key] === "boolean"
            ? overrides[key]
            : (world[key] === true);
    }
    return flags;
}

/**
 * Normalize a raw `morale` record into the ternary posture view (issue
 * #26). Accepts both the legacy stub `{state, pressured?, desperate?}`
 * and the evaluated team record `{tier, state, counters, pending, ...}`
 * — `state` leads, `tier` is the fallback. Absent or damaged records
 * mean normal morale.
 * @param {*} record Raw morale payload.
 * @returns {{state: string|null, pressured: boolean, desperate: boolean}}
 */
export function moralePostureOf(record) {
    const state = typeof record?.state === "string" ? record.state
        : (typeof record?.tier === "string" ? record.tier : null);
    return {
        state,
        pressured: record?.pressured === true || state === "pressured",
        desperate: record?.desperate === true || state === "desperate"
    };
}

/**
 * Read the raw morale record for one combatant: `context.morale`
 * injection wins (tests/integrations), then the module flag
 * `flags["only-war-ai"].morale` — either a manual posture stub or the
 * evaluated team record the fireteam writes every round (issue #26).
 * @param {object|null} combatant
 * @param {object} [context] Planning context.
 * @returns {object|null}
 */
export function readMoraleRecord(combatant, context = {}) {
    if (context?.morale !== undefined) return context.morale;
    return combatant?.getFlag?.(MODULE_ID, FLAG_KEYS.morale)
        ?? combatant?.flags?.[MODULE_ID]?.[FLAG_KEYS.morale]
        ?? null;
}

/**
 * Sanitize a persisted morale record into the evaluated shape (issue
 * #26): `{version, teamId, combatId, round, tier, state, pressured,
 * desperate, pending, leaderId, losses, initialStrength, counters}`.
 * A manual stub `{state, pressured?, desperate?}` keeps working — it
 * sanitizes to the matching bare record — and `null` is returned for
 * anything unusable.
 * @param {*} raw Raw flag/context payload.
 * @returns {object|null}
 */
export function sanitizeMoraleRecord(raw) {
    if (!raw || typeof raw !== "object") return null;
    const tier = MORALE_TIERS.includes(raw.tier) ? raw.tier
        : (MORALE_TIERS.includes(raw.state) ? raw.state
            : (raw.desperate === true ? "desperate"
                : (raw.pressured === true ? "pressured" : null)));
    if (tier === null) return null;
    const pending = raw.pending && MORALE_TIERS.includes(raw.pending.tier)
        ? {
            tier: raw.pending.tier,
            count: Math.max(1, Number.isFinite(raw.pending.count)
                ? Math.trunc(raw.pending.count) : 1)
        }
        : null;
    const counters = raw.counters && typeof raw.counters === "object"
        ? {
            members: Number.isFinite(raw.counters.members) ? raw.counters.members : 0,
            defeated: Number.isFinite(raw.counters.defeated) ? raw.counters.defeated : 0,
            casualties: Number.isFinite(raw.counters.casualties) ? raw.counters.casualties : 0,
            casualtiesRecent: Number.isFinite(raw.counters.casualtiesRecent)
                ? raw.counters.casualtiesRecent : 0,
            pinned: Number.isFinite(raw.counters.pinned) ? raw.counters.pinned : 0,
            enemies: Number.isFinite(raw.counters.enemies) ? raw.counters.enemies : 0,
            spaceControl: Number.isFinite(raw.counters.spaceControl)
                ? raw.counters.spaceControl : null,
            leaderDead: raw.counters.leaderDead === true
        }
        : null;
    return {
        version: Number.isFinite(raw.version) ? raw.version : 1,
        teamId: typeof raw.teamId === "string" ? raw.teamId : null,
        combatId: raw.combatId ?? null,
        round: Number.isFinite(raw.round) ? raw.round : 0,
        tier,
        state: tier,
        pressured: tier === "pressured",
        desperate: tier === "desperate",
        pending,
        leaderId: raw.leaderId ?? null,
        losses: (Array.isArray(raw.losses) ? raw.losses : [])
            .filter(entry => Number.isFinite(entry))
            .slice(-MORALE_LOSS_LOG_MAX),
        seenEnemies: (Array.isArray(raw.seenEnemies) ? raw.seenEnemies : [])
            .filter(id => typeof id === "string" && id)
            .slice(-MORALE_SEEN_ENEMIES_MAX),
        initialStrength: Number.isFinite(raw.initialStrength) && raw.initialStrength > 0
            ? raw.initialStrength : null,
        counters
    };
}

/**
 * Whether a morale record is an evaluated team record (written by the
 * fireteam evaluation of issue #26) rather than a manual posture stub —
 * manual stubs are member-level overrides the team evaluation never
 * overwrites.
 * @param {*} record Raw morale payload.
 * @returns {boolean}
 */
export function isEvaluatedMoraleRecord(record) {
    return record !== null && typeof record === "object"
        && Number.isFinite(record.version) && record.version >= 1
        && typeof record.combatId !== "undefined"
        && record.counters !== undefined;
}

/**
 * Propose the morale tier from the counted battlefield picture (issue
 * #26). Pure — the counters are gathered by the caller:
 *
 * - `desperate` — the *seen* enemy headcount outnumbers the team by
 *   `options.outnumberRatio` (default
 *   `MORALE_DESPERATE_OUTNUMBER_RATIO = 2` — a 2:1 deficit is the
 *   squad's normal war; a smaller numerical edge stays `pressured`),
 *   at least half of the starting strength fell,
 *   `MORALE_DESPERATE_RECENT_LOSSES` members died inside the recent
 *   window, every living member is pinned or the space-control share
 *   collapsed to `MORALE_DESPERATE_SPACE_CONTROL` or below;
 * - `confident` — the team holds a headcount edge, nobody fell recently
 *   and its own cells are mostly free of enemy threat coverage;
 * - `pressured` — parity (the baseline, every other case).
 *
 * `counters.leaderDead` is read by {@link evaluateMoraleRecord}, which
 * caps the proposal at `pressured` and forces the transition — a leader
 * loss never leaves the team `confident`.
 * @param {object} counters `{members, defeated, casualties,
 *   casualtiesRecent, pinned, enemies, spaceControl, leaderDead,
 *   initialStrength}`.
 * @param {object} [options]
 * @param {number} [options.outnumberRatio] Enemy-headcount ratio that
 *   alone proposes `desperate` (issue #26 review).
 * @returns {string} One of `MORALE_TIERS`.
 */
export function proposeMoraleTier(counters = {}, { outnumberRatio = null } = {}) {
    const members = Number.isFinite(counters.members) ? counters.members : 0;
    const enemies = Number.isFinite(counters.enemies) ? counters.enemies : 0;
    const pinned = Number.isFinite(counters.pinned) ? counters.pinned : 0;
    const casualties = Number.isFinite(counters.casualties) ? counters.casualties : 0;
    const recent = Number.isFinite(counters.casualtiesRecent)
        ? counters.casualtiesRecent : 0;
    const initial = Number.isFinite(counters.initialStrength)
        && counters.initialStrength > 0
        ? counters.initialStrength
        : members + casualties;
    const space = Number.isFinite(counters.spaceControl)
        ? counters.spaceControl : null;
    const ratio = Number.isFinite(outnumberRatio) && outnumberRatio >= 1
        ? outnumberRatio : MORALE_DESPERATE_OUTNUMBER_RATIO;
    if ((enemies > 0 && enemies >= members * ratio)
        || (initial > 0 && casualties >= initial * MORALE_DESPERATE_LOSS_RATIO)
        || recent >= MORALE_DESPERATE_RECENT_LOSSES
        || (members > 0 && pinned >= members)
        || (space !== null && space <= MORALE_DESPERATE_SPACE_CONTROL)) {
        return "desperate";
    }
    if (members > 0 && members > enemies && recent === 0
        && !(members > 0 && pinned >= members)
        && (space === null || space >= MORALE_CONFIDENT_SPACE_CONTROL)) {
        return "confident";
    }
    return MORALE_DEFAULT_TIER;
}

/**
 * Space-control share for the morale counters (issue #26, threat map
 * #16): the fraction of sampled points whose aggregated enemy danger
 * stays under {@link MORALE_SAFE_DANGER} — "the share of our cells that
 * is ours". `null` when nothing is measurable (no points, no probe).
 * @param {object[]} points Sampled positions `{x, y}` (member cells).
 * @param {Function|null} dangerAt Threat-map probe `({x,y}) => 0..1`.
 * @param {number} [safeDanger] Danger ceiling of an "our" cell.
 * @returns {number|null} Share `0..1` or null.
 */
export function moraleSpaceControl(points, dangerAt, safeDanger = MORALE_SAFE_DANGER) {
    const list = (Array.isArray(points) ? points : [])
        .filter(p => Number.isFinite(p?.x) && Number.isFinite(p?.y));
    if (!list.length || typeof dangerAt !== "function") return null;
    const ceiling = Number.isFinite(safeDanger) ? safeDanger : MORALE_SAFE_DANGER;
    let safe = 0;
    for (const point of list) {
        let danger = 0;
        try {
            danger = Number(dangerAt(point));
        } catch(_err) {
            danger = 0;
        }
        if (!(danger >= ceiling)) safe++;
    }
    return Math.round((safe / list.length) * 1e4) / 1e4;
}

/**
 * Advance the evaluated morale record one round (issue #26): the
 * counted picture proposes a tier, the hysteresis gate
 * ({@link MORALE_HYSTERESIS_ROUNDS} consecutive rounds of the same
 * proposal) commits it, and a leader loss forces the transition
 * immediately (the proposal is capped at `pressured` — never
 * `confident`). The loss log grows by every member lost since the
 * previous evaluation; `casualtiesRecent` counts the entries inside
 * {@link MORALE_RECENT_LOSS_ROUNDS}.
 * @param {object|null} previous Sanitized previous record.
 * @param {object} counters Fresh counters (see {@link proposeMoraleTier}).
 * @param {object} meta
 * @param {number} meta.round Combat round of this evaluation.
 * @param {*} [meta.combatId] Owning combat id.
 * @param {string|null} [meta.teamId] Owning team id.
 * @param {string|null} [meta.leaderId] Elected leader this round.
 * @param {number} [meta.hysteresis] Required consecutive proposals.
 * @param {number} [meta.outnumberRatio] Enemy-headcount ratio that
 *   alone proposes `desperate` (world setting `moraleDesperateRatio` /
 *   `context.moraleOutnumberRatio`, default
 *   `MORALE_DESPERATE_OUTNUMBER_RATIO = 2`).
 * @returns {object} New sanitized record.
 */
export function evaluateMoraleRecord(previous, counters = {}, meta = {}) {
    const prev = sanitizeMoraleRecord(previous);
    const round = Number.isFinite(meta.round) ? meta.round : 0;
    const count = Math.max(1, Number.isFinite(meta.hysteresis)
        ? Math.trunc(meta.hysteresis) : MORALE_HYSTERESIS_ROUNDS);
    const members = Number.isFinite(counters.members) ? counters.members : 0;
    const defeated = Number.isFinite(counters.defeated) ? counters.defeated : 0;
    const initialStrength = prev?.initialStrength
        ?? Math.max(1, members + defeated);
    // The loss log appends every member that fell since the last
    // evaluation — `casualties` is cumulative, `casualtiesRecent` is
    // the sliding-window view.
    const losses = [...(prev?.losses ?? [])];
    const previouslyCounted = prev?.counters?.defeated ?? 0;
    const freshLosses = Math.max(0, defeated - previouslyCounted);
    for (let i = 0; i < freshLosses && losses.length < MORALE_LOSS_LOG_MAX; i++) {
        losses.push(round);
    }
    const casualtiesRecent = losses
        .filter(at => round - at < MORALE_RECENT_LOSS_ROUNDS).length;
    const leaderId = meta.leaderId ?? null;
    const leaderDead = counters.leaderDead === true
        || (prev?.leaderId != null && leaderId != null
            && prev.leaderId !== leaderId);
    const next = {
        members,
        defeated,
        casualties: defeated,
        casualtiesRecent,
        pinned: Number.isFinite(counters.pinned) ? counters.pinned : 0,
        enemies: Number.isFinite(counters.enemies) ? counters.enemies : 0,
        spaceControl: Number.isFinite(counters.spaceControl)
            ? counters.spaceControl : null,
        leaderDead,
        initialStrength
    };
    let proposal = proposeMoraleTier(next, {
        outnumberRatio: meta.outnumberRatio
    });
    let tier = prev?.tier ?? MORALE_DEFAULT_TIER;
    let pending = prev?.pending ?? null;
    const leaderChanged = leaderDead === true
        && (prev?.leaderId == null || prev.leaderId !== leaderId);
    if (leaderChanged && proposal === "confident") {
        proposal = MORALE_DEFAULT_TIER;
    }
    if (proposal === tier) {
        pending = null;
    } else if (leaderChanged) {
        // Forced transition: a leader loss commits the (capped) proposal
        // immediately — the team reels, it does not wait for hysteresis.
        tier = proposal;
        pending = null;
    } else {
        pending = pending?.tier === proposal
            ? { tier: proposal, count: pending.count + 1 }
            : { tier: proposal, count: 1 };
        if (pending.count >= count) {
            tier = proposal;
            pending = null;
        }
    }
    return sanitizeMoraleRecord({
        version: 1,
        teamId: meta.teamId ?? prev?.teamId ?? null,
        combatId: meta.combatId ?? prev?.combatId ?? null,
        round,
        tier,
        pending,
        leaderId: leaderId ?? prev?.leaderId ?? null,
        losses,
        initialStrength,
        // Issue #26 review: the squad's "ever seen" hostile set — the
        // caller merges prev.seenEnemies with memory keys and live LOS;
        // the count drives `enemies` so an unseen enemy never panics
        // the team (blissfully ignorant until first contact).
        seenEnemies: counters.seenEnemies ?? prev?.seenEnemies ?? [],
        counters: next
    });
}

/**
 * Member-effective morale tier (issue #26): the team tier is one, but
 * trait exceptions re-interpret it for a single bot — a `fanatic`
 * (`flags.ignoreRegroup`) never acknowledges `desperate` and keeps its
 * posture at `pressured`, a `cowardly` (`flags.fragileMorale`) reads
 * mere `pressured` as `desperate`. The fanatic exception wins ties.
 * @param {string|null} tier Team tier (`MORALE_TIERS` or null).
 * @param {string[]} [traits] Resolved trait ids of the member.
 * @returns {string|null}
 */
export function effectiveMoraleTier(tier, traits = []) {
    if (!MORALE_TIERS.includes(tier)) return null;
    const flags = personalityBehaviorFlags(traits);
    if (tier === "desperate" && flags.ignoreRegroup === true) {
        return MORALE_DEFAULT_TIER;
    }
    if (tier === "pressured"
        && (traits ?? []).some(id => PERSONALITIES[id]?.flags?.fragileMorale === true)) {
        return "desperate";
    }
    return tier;
}

/**
 * Ternary booleans of a tier — the effective-posture view used by the
 * member-facing narrowing (task remap, weight shifts, delay gate).
 * @param {string|null} tier
 * @returns {{pressured: boolean, desperate: boolean, confident: boolean}}
 */
export function moralePostureOfTier(tier) {
    return {
        pressured: tier === "pressured",
        desperate: tier === "desperate",
        confident: tier === "confident"
    };
}

/**
 * Bounded posture weight deltas of L2 (issue #26): the morale layer is
 * a dramatic axis, not a second scorer — each effective tier nudges a
 * handful of factor weights inside a small bound.
 *
 * - `confident` — pushes assault/charge/advance and accepts exposure;
 * - `desperate` — postpones charges, pulls toward cover/regroup/hold;
 * - `pressured` — the baseline, no shift.
 */
export const MORALE_TIER_WEIGHT_DELTAS = Object.freeze({
    confident: Object.freeze({
        charge: 6,
        advance: 3,
        attackAfterMove: 2,
        meleeEngage: 3,
        holdPosition: -3,
        cover: -3,
        overwatch: -1
    }),
    desperate: Object.freeze({
        charge: -8,
        advance: -4,
        meleeEngage: -4,
        attackNow: -2,
        proximity: -3,
        cover: 4,
        holdPosition: 3,
        cohesionRestore: 8,
        overwatch: 2
    }),
    pressured: Object.freeze({})
});

/**
 * Apply the L2 posture weight shift (issue #26): additive deltas of the
 * effective tier over the scoring weights. Pure — returns the input map
 * unchanged for the baseline tier or an unknown tier.
 * @param {object} weights Base weight map (never mutated).
 * @param {string|null} effectiveTier Member-effective tier.
 * @returns {{weights: object, deltas: object}} Effective weights and
 *   the applied delta map (empty at baseline).
 */
export function applyMoraleWeightShift(weights, effectiveTier) {
    const deltas = MORALE_TIER_WEIGHT_DELTAS[effectiveTier] ?? {};
    const next = { ...(weights ?? {}) };
    const applied = {};
    for (const [key, delta] of Object.entries(deltas)) {
        if (!Number.isFinite(delta) || delta === 0) continue;
        applied[key] = delta;
        next[key] = (Number.isFinite(next[key]) ? next[key] : 0) + delta;
    }
    return { weights: next, deltas: applied };
}

/**
 * Compact plan-intent summary for telegraphing (issue #26): the
 * step-type chain of a serialized plan without the trailing
 * `end-turn` — e.g. `["move", "attack"]` rendered downstream as
 * "Move → Attack".
 * @param {object|null} plan Serialized plan.
 * @returns {{steps: string[], total: number}}
 */
export function planIntentOf(plan) {
    const steps = (Array.isArray(plan?.steps) ? plan.steps : [])
        .map(step => step?.type)
        .filter(type => typeof type === "string" && type !== "end-turn");
    return {
        steps,
        total: Math.max(steps.length, Array.isArray(plan?.steps) ? plan.steps.length : 0)
    };
}

/**
 * L2 morale — funnel entry point (issue #26). The layer resolves the
 * team tier from the combatant's `morale` record (evaluated flag or
 * injected `context.morale`), derives the member's *effective* tier
 * through the trait exceptions (`input.traits` — resolved personality
 * ids, defaulting to the combatant's flag list) and reports both on the
 * trace. The team tier alone feeds `expectedState.morale` — a tier
 * change is a commitment invalidator; the effective tier drives the
 * member-facing narrowing (task remap in the fireteam, posture weight
 * deltas in the scoring pass). When disabled the layer degrades to a
 * neutral posture and reports `morale-layer-disabled`.
 * @param {object} input
 * @param {object|null} input.combatant Active combatant document.
 * @param {object} [input.context] Planning context.
 * @param {object} [input.flags] Resolved layer flags.
 * @param {object|null} [input.diagnostics] Plan diagnostics record.
 * @param {string[]} [input.traits] Resolved member trait ids — wins
 *   over the `flags["only-war-ai"].personality` list.
 * @returns {{enabled: boolean, state: string|null, tier: string|null,
 *   effectiveTier: string|null, pressured: boolean, desperate: boolean,
 *   confident: boolean, effective: {pressured: boolean,
 *   desperate: boolean, confident: boolean}}}
 */
export function applyMoraleLayer({ combatant = null, context = {},
    flags = {}, diagnostics = null, traits = null } = {}) {
    if (flags.morale !== true) {
        recordLayerReason(diagnostics, "L2", "morale-layer-disabled");
        return {
            enabled: false,
            state: null,
            tier: null,
            effectiveTier: null,
            pressured: false,
            desperate: false,
            confident: false,
            effective: { pressured: false, desperate: false, confident: false }
        };
    }
    const record = readMoraleRecord(combatant, context);
    const posture = moralePostureOf(record);
    const tier = moraleTierOf(posture);
    const memberTraits = Array.isArray(traits) ? traits
        : (combatant?.getFlag?.(MODULE_ID, FLAG_KEYS.personality)
            ?? combatant?.flags?.[MODULE_ID]?.[FLAG_KEYS.personality]);
    const effectiveTier = effectiveMoraleTier(tier, memberTraits);
    const effective = moralePostureOfTier(effectiveTier);
    recordLayerReason(diagnostics, "L2", "morale-posture", {
        tier,
        effectiveTier,
        pressured: posture.pressured,
        desperate: posture.desperate,
        confident: posture.state === "confident"
    });
    return {
        enabled: true,
        state: posture.state,
        // The team tier — `moraleTierOf` consumes `pressured`/`desperate`/
        // `tier`/`state`, so `expectedState.morale` and the live
        // validation view stay on the team level.
        tier,
        effectiveTier,
        pressured: posture.pressured,
        desperate: posture.desperate,
        confident: posture.state === "confident",
        effective
    };
}

/* ------------------------------------------------------------------ */
/* L1 commitment (issue #25)                                           */
/* ------------------------------------------------------------------ */

/**
 * Stable reason codes of the L1 layer (issue #25/#27 trace contract).
 * An absent or damaged record reports `commitment-miss` with the reason
 * in `detail.reason` (issue #24 contract); a real persisted record that
 * fails a validator reports the invalidator code directly so the trace
 * reads `{layer:"L1", code:"gm-intervention"}`.
 */
export const COMMITMENT_REASONS = Object.freeze({
    noCommitment: "no-commitment",
    invalidCommitment: "invalid-commitment",
    combatEnded: "combat-ended",
    ttlExpired: "ttl-expired",
    gmIntervention: "gm-intervention",
    targetGone: "target-gone",
    moraleChanged: "morale-changed",
    threatDrift: "threat-drift",
    // A replayed attack step whose firing point no longer sees the live
    // target — the world moved (or the record always lacked LOS); the
    // bot replans instead of replaying a shot through a wall.
    losBroken: "los-broken",
    l0Veto: "l0-veto",
    // Executor-side stamp: every substantive step of the replayed
    // record resolved to a no-op (a move-only plan whose endpoint is
    // already reached) — the record is closed so the next turn plans
    // fresh instead of re-committing an exhausted route forever.
    planExhausted: "plan-exhausted"
});

/**
 * Normalize a stored `committedPlan` flag record (issue #25). The record
 * is `{id, status, combatId, combatantId, createdRound, createdTurn,
 * ttl, source, steps, expectedState{self, target, morale, threats},
 * cancelledReason?}`; anything outside the contract is dropped and a
 * damaged value reads as `null`.
 * @param {*} raw Raw flag payload.
 * @returns {object|null} Sanitized record.
 */
export function sanitizeCommittedPlan(raw) {
    if (!raw || typeof raw !== "object") return null;
    const steps = (Array.isArray(raw.steps) ? raw.steps : [])
        .filter(step => step && typeof step === "object"
            && typeof step.type === "string");
    const expected = raw.expectedState && typeof raw.expectedState === "object"
        ? raw.expectedState : {};
    const self = expected.self && Number.isFinite(expected.self.x)
        && Number.isFinite(expected.self.y)
        ? {
            x: expected.self.x,
            y: expected.self.y,
            elevation: Number.isFinite(expected.self.elevation)
                ? expected.self.elevation : 0
        }
        : null;
    const target = expected.target
        && (expected.target.tokenId || expected.target.tokenUuid)
        ? {
            tokenId: expected.target.tokenId ?? null,
            tokenUuid: typeof expected.target.tokenUuid === "string"
                ? expected.target.tokenUuid : null,
            x: Number.isFinite(expected.target.x) ? expected.target.x : null,
            y: Number.isFinite(expected.target.y) ? expected.target.y : null
        }
        : null;
    const threats = (Array.isArray(expected.threats) ? expected.threats : [])
        .filter(th => th && (th.tokenId || th.tokenUuid)
            && Number.isFinite(th.x) && Number.isFinite(th.y))
        .slice(0, COMMITMENT_THREAT_MAX)
        .map(th => ({
            tokenId: th.tokenId ?? th.tokenUuid ?? null,
            x: th.x,
            y: th.y
        }));
    return {
        id: typeof raw.id === "string" ? raw.id : null,
        status: raw.status === "cancelled" ? "cancelled" : "active",
        combatId: raw.combatId ?? null,
        combatantId: raw.combatantId ?? null,
        createdRound: Number.isFinite(raw.createdRound) ? raw.createdRound : 0,
        createdTurn: Number.isFinite(raw.createdTurn) ? raw.createdTurn : 0,
        ttl: Number.isFinite(raw.ttl) && raw.ttl > 0
            ? raw.ttl : COMMITMENT_TTL_ROUNDS,
        source: typeof raw.source === "string" ? raw.source : "planner",
        steps,
        expectedState: {
            self,
            target,
            // Issue #26: every real tier travels — a posture change of
            // any kind invalidates the commitment.
            morale: MORALE_TIERS.includes(expected.morale)
                ? expected.morale : null,
            threats
        },
        cancelledReason: typeof raw.cancelledReason === "string"
            ? raw.cancelledReason : null,
        cancelledRound: Number.isFinite(raw.cancelledRound)
            ? raw.cancelledRound : null
    };
}

/**
 * Normalize the bounded executor move journal (issue #25): entries
 * `{round, turn, x, y, elevation?, operationId?}`, most recent last,
 * capped at {@link COMMITMENT_JOURNAL_MAX}.
 * @param {*} raw Raw flag payload.
 * @param {number} [max] Bound override.
 * @returns {object[]} Sanitized journal.
 */
export function sanitizeMoveJournal(raw, max = COMMITMENT_JOURNAL_MAX) {
    const entries = (Array.isArray(raw) ? raw : [])
        .filter(entry => entry && typeof entry === "object"
            && Number.isFinite(entry.x) && Number.isFinite(entry.y)
            && Number.isFinite(entry.round))
        .map(entry => ({
            round: entry.round,
            turn: Number.isFinite(entry.turn) ? entry.turn : 0,
            x: entry.x,
            y: entry.y,
            elevation: Number.isFinite(entry.elevation) ? entry.elevation : null,
            operationId: typeof entry.operationId === "string"
                ? entry.operationId : null
        }));
    return entries.slice(-Math.max(1, max));
}

/**
 * Pure journal append: returns a new bounded journal with the entry
 * normalized and appended at the end.
 * @param {object[]|*} journal Existing journal.
 * @param {object} entry `{round, turn, x, y, elevation?, operationId?}`.
 * @param {number} [max] Bound override (default
 *   {@link COMMITMENT_JOURNAL_MAX}).
 * @returns {object[]} New journal.
 */
export function appendJournalEntry(journal, entry, max = COMMITMENT_JOURNAL_MAX) {
    const next = sanitizeMoveJournal(journal, max);
    const clean = sanitizeMoveJournal([entry], max);
    return clean.length ? [...next, clean[0]].slice(-Math.max(1, max)) : next;
}

/**
 * Read a module flag via `getFlag` with a raw `flags` fallback.
 * @param {object|null} doc
 * @param {string} key
 * @returns {*}
 */
function _readFlag(doc, key) {
    if (typeof doc?.getFlag === "function") {
        try {
            return doc.getFlag(MODULE_ID, key);
        } catch(_err) {
            // Fall through to the raw flags read.
        }
    }
    return doc?.flags?.[MODULE_ID]?.[key];
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
 * Top-left position of a token document (`_source` leads like the
 * executor does — it carries the applied move while `x` lags behind the
 * animation).
 * @param {object|null} doc
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
 * Centre point of a token document — `center` when the document exposes
 * it, otherwise the top-left position plus half a footprint (default
 * 100px cells when the live grid size is unknown).
 * @param {object|null} doc
 * @param {number} [gridSize] Scene grid size in pixels.
 * @returns {{x: number|null, y: number|null}}
 */
function _tokenCenter(doc, gridSize = 100) {
    const center = doc?.center ?? doc?.object?.center;
    if (center && Number.isFinite(center.x) && Number.isFinite(center.y)) {
        return { x: center.x, y: center.y };
    }
    const pos = _tokenPosition(doc);
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return pos;
    const size = Number.isFinite(gridSize) && gridSize > 0 ? gridSize : 100;
    return { x: pos.x + (size / 2), y: pos.y + (size / 2) };
}

/**
 * Read the sanitized `committedPlan` flag of a combatant.
 * @param {object|null} combatant
 * @returns {object|null}
 */
export function readCommittedPlan(combatant) {
    return sanitizeCommittedPlan(_readFlag(combatant, FLAG_KEYS.committedPlan));
}

/**
 * Read the sanitized `moveJournal` flag of a combatant.
 * @param {object|null} combatant
 * @param {number} [max] Bound override.
 * @returns {object[]}
 */
export function readMoveJournal(combatant, max = COMMITMENT_JOURNAL_MAX) {
    return sanitizeMoveJournal(_readFlag(combatant, FLAG_KEYS.moveJournal), max);
}

/**
 * Read the `gmControlled` flag of a combatant: `{round, turn, reason}` —
 * set for one turn when a `gm-intervention` invalidates the committed
 * plan (issue #25). The fireteam degrades marked members to `support`.
 * @param {object|null} combatant
 * @returns {{round: number, turn: number, reason: string|null}|null}
 */
export function readGmControlled(combatant) {
    const raw = _readFlag(combatant, FLAG_KEYS.gmControlled);
    if (!raw || typeof raw !== "object" || !Number.isFinite(raw.round)) return null;
    return {
        round: raw.round,
        turn: Number.isFinite(raw.turn) ? raw.turn : 0,
        reason: typeof raw.reason === "string" ? raw.reason : null
    };
}

/**
 * Whether the combatant is marked `gm-controlled` for the given round —
 * the mark lives exactly one round: a teammate replanned against it this
 * round degrades, an older mark is stale.
 * @param {object|null} combatant
 * @param {number} round Live combat round.
 * @returns {boolean}
 */
export function isGmControlled(combatant, round) {
    const record = readGmControlled(combatant);
    return record !== null && record.round === round;
}

/**
 * Compact morale tier stored in `expectedState.morale` (issues
 * #25/#26): `"confident" | "desperate" | "pressured" | null`. Reads the
 * posture view (`{state, pressured, desperate}`), a raw record
 * (`{tier, state}`) or an {@link applyMoraleLayer} result — an absent
 * morale flag means the neutral (null) tier.
 * @param {{pressured?: boolean, desperate?: boolean, confident?:
 *   boolean, state?: string|null, tier?: string|null}|null} posture
 * @returns {string|null}
 */
export function moraleTierOf(posture) {
    if (posture?.desperate === true || posture?.tier === "desperate"
        || posture?.state === "desperate") return "desperate";
    if (posture?.pressured === true || posture?.tier === "pressured"
        || posture?.state === "pressured") return "pressured";
    if (posture?.confident === true || posture?.tier === "confident"
        || posture?.state === "confident") return "confident";
    return null;
}

/**
 * Team id of a document for intervention counting: the raw `fireteam`
 * flag's `teamId` on the Combatant → Token → Actor chain (first hit
 * wins, matching the override order).
 * @param {object|null} doc Combatant (or token/actor) document.
 * @returns {string|null}
 */
function _flagTeamId(doc) {
    const chain = [doc, _tokenDoc(doc?.token), doc?.actor ?? _tokenDoc(doc?.token)?.actor];
    for (const entry of chain) {
        const flag = _readFlag(entry, FLAG_KEYS.fireteam);
        if (typeof flag?.teamId === "string" && flag.teamId) return flag.teamId;
    }
    return null;
}

/**
 * Count GM interventions of the current round: combatants flagged
 * `gmControlled` with `record.round === round`. With `teamId` only the
 * same-team marks count (the issue's "members of the team"); without one
 * every marked combatant counts — a solo bot reads the world's chaos.
 * @param {object|null} combat Live combat document.
 * @param {object} [options]
 * @param {number} [options.round] Round to count (defaults to combat's).
 * @param {string|null} [options.teamId] Restrict to this fireteam.
 * @returns {number}
 */
export function countGmInterventions(combat, { round = null, teamId = null } = {}) {
    const live = Number.isFinite(round) ? round : (Number.isFinite(combat?.round) ? combat.round : 0);
    const collection = combat?.combatants;
    const list = Array.isArray(collection) ? collection
        : (Array.isArray(collection?.contents) ? collection.contents
            : (collection && typeof collection[Symbol.iterator] === "function"
                ? [...collection] : []));
    let count = 0;
    for (const combatant of list) {
        if (!combatant) continue;
        if (teamId !== null && _flagTeamId(combatant) !== teamId) continue;
        if (isGmControlled(combatant, live)) count++;
    }
    return count;
}

/**
 * Find a live token document by id inside the combat's combatants or the
 * scene token collection.
 * @param {string|null} tokenId
 * @param {object|null} combat
 * @param {object|null} scene
 * @returns {object|null}
 */
function _findTokenDoc(tokenId, combat, scene) {
    if (!tokenId) return null;
    const combatants = combat?.combatants;
    const list = Array.isArray(combatants) ? combatants
        : (Array.isArray(combatants?.contents) ? combatants.contents
            : (combatants && typeof combatants[Symbol.iterator] === "function"
                ? [...combatants] : []));
    for (const entry of list) {
        const doc = _tokenDoc(entry?.token);
        if ((entry?.tokenId ?? doc?.id) === tokenId) return doc;
    }
    const tokens = scene?.tokens ?? globalThis.canvas?.tokens;
    const tlist = Array.isArray(tokens?.contents) ? tokens.contents
        : (tokens && typeof tokens[Symbol.iterator] === "function" ? [...tokens] : []);
    for (const entry of tlist) {
        const doc = _tokenDoc(entry);
        if (doc?.id === tokenId) return doc;
    }
    return null;
}

/**
 * Whether a threat/target token still counts as present for the
 * commitment expectedState: existing, not destroyed/hidden, its
 * combatant not defeated and its actor not destroyed.
 * @param {object|null} doc Token document.
 * @param {object|null} combat Combat for the defeated check.
 * @returns {boolean}
 */
function _committedTokenAlive(doc, combat) {
    if (!doc || doc.destroyed === true || doc.hidden === true) return false;
    const combatants = combat?.combatants;
    const list = Array.isArray(combatants) ? combatants
        : (Array.isArray(combatants?.contents) ? combatants.contents
            : (combatants && typeof combatants[Symbol.iterator] === "function"
                ? [...combatants] : []));
    for (const entry of list) {
        if (_tokenDoc(entry?.token) === doc && entry?.defeated === true) return false;
    }
    const actor = doc.actor ?? null;
    return !(actor && actor.destroyed === true);
}

/**
 * Validate a persisted commitment record against live state (issue #25).
 * Pure: the caller supplies every live datum the check touches.
 * Ordered validators — the first failure wins:
 *
 * 1. `combat-ended` — record belongs to another combat or it ended.
 * 2. `ttl-expired` — `round - createdRound >= effective ttl`; reactive
 *    mode squeezes the effective ttl to `1`.
 * 3. `gm-intervention` — the token is not where `expectedState.self`
 *    left it and no own journal entry explains the drift (within the
 *    plan's lifetime). `grace` accepts the drift silently
 *    (`accepted.gmMoved`), a journal match accepts it as an own move
 *    (`accepted.selfMoved`).
 * 4. `target-gone` — the committed target died, hid or vanished.
 * 5. `morale-changed` — the live morale tier differs from the recorded
 *    one (absent flag = neutral tier, graceful #26).
 * 6. `threat-drift` — more than `threatTolerance` recorded threat tokens
 *    moved over `moveTolerancePx`, died or disappeared.
 * 7. `l0-veto` — a cheap legality pass: `pinned`/`prone` self vetoes a
 *    committed `charge` step before it executes.
 *
 * @param {object} record Sanitized committed-plan record.
 * @param {object} live Live view.
 * @param {string|null} live.combatId
 * @param {boolean} [live.combatEnded]
 * @param {number} [live.round]
 * @param {number} [live.turn]
 * @param {{x: number|null, y: number|null, elevation?: number}} [live.self]
 * @param {string[]} [live.selfStatuses]
 * @param {object[]} [live.journal] Own-move journal entries.
 * @param {boolean} [live.grace] `manualOverrideGrace` — accept GM drift.
 * @param {boolean} [live.reactive] Squeeze the ttl to one round.
 * @param {number} [live.interventions] Team interventions this round.
 * @param {string|null} [live.moraleTier] Live morale tier.
 * @param {number} [live.threatTolerance]
 * @param {number} [live.positionTolerance] Pixels.
 * @param {number} [live.moveTolerancePx] Threat drift threshold (pixels).
 * @param {Function} [live.resolveToken] `(tokenId) => doc|null`.
 * @param {Function} [live.isTokenAlive] `(doc) => boolean`.
 * @returns {{valid: boolean, reason: string|null, detail?: object,
 *   accepted?: object}}
 */
export function validateCommitment(record, live = {}) {
    const fail = (reason, detail) => ({ valid: false, reason, detail });
    if (!record || typeof record !== "object") {
        return fail(COMMITMENT_REASONS.invalidCommitment);
    }
    if (record.status === "cancelled") {
        return fail(COMMITMENT_REASONS.invalidCommitment, {
            status: "cancelled",
            cancelledReason: record.cancelledReason ?? null
        });
    }
    const steps = Array.isArray(record.steps) ? record.steps : [];
    if (!steps.length) {
        return fail(COMMITMENT_REASONS.invalidCommitment, { missing: "steps" });
    }
    if (live.combatEnded === true
        || (record.combatId && live.combatId && record.combatId !== live.combatId)) {
        return fail(COMMITMENT_REASONS.combatEnded, {
            combatId: record.combatId ?? null,
            live: live.combatId ?? null
        });
    }
    const ttl = live.reactive === true
        ? 1
        : (Number.isFinite(record.ttl) && record.ttl > 0 ? record.ttl : COMMITMENT_TTL_ROUNDS);
    const round = Number.isFinite(live.round) ? live.round : 0;
    const createdRound = Number.isFinite(record.createdRound) ? record.createdRound : 0;
    if (round - createdRound >= ttl) {
        return fail(COMMITMENT_REASONS.ttlExpired, {
            ttl,
            round,
            createdRound,
            ...(live.reactive === true ? { reactive: true } : {})
        });
    }
    const expected = record.expectedState ?? {};
    const accepted = {};
    const tol = Number.isFinite(live.positionTolerance)
        ? live.positionTolerance : COMMITMENT_POSITION_TOLERANCE_PX;
    const liveSelf = live.self;
    if (expected.self && liveSelf
        && Number.isFinite(liveSelf.x) && Number.isFinite(liveSelf.y)) {
        const drifted = Math.abs(liveSelf.x - expected.self.x) >= tol
            || Math.abs(liveSelf.y - expected.self.y) >= tol;
        const elDrift = Number.isFinite(expected.self.elevation)
            && Number.isFinite(liveSelf.elevation)
            && liveSelf.elevation !== expected.self.elevation;
        if (drifted || elDrift) {
            // Journal-diff (issue #25): a bounded own-move record matching
            // the live position inside the plan's lifetime is an own
            // move; anything else is a manual intervention.
            const own = (Array.isArray(live.journal) ? live.journal : [])
                .some(entry => entry
                    && Number.isFinite(entry.round) && entry.round >= createdRound
                    && Math.abs((entry.x ?? NaN) - liveSelf.x) < tol
                    && Math.abs((entry.y ?? NaN) - liveSelf.y) < tol
                    && (!elDrift || !Number.isFinite(entry.elevation)
                        || entry.elevation === liveSelf.elevation));
            if (own) {
                accepted.selfMoved = true;
            } else if (live.grace === true) {
                accepted.gmMoved = true;
            } else {
                return fail(COMMITMENT_REASONS.gmIntervention, {
                    from: { x: expected.self.x, y: expected.self.y },
                    to: { x: liveSelf.x, y: liveSelf.y }
                });
            }
        }
    }
    const target = expected.target;
    if (target && (target.tokenId || target.tokenUuid)) {
        const doc = typeof live.resolveToken === "function"
            ? live.resolveToken(target.tokenId ?? target.tokenUuid) : null;
        const alive = doc
            ? (typeof live.isTokenAlive === "function" ? live.isTokenAlive(doc) : true)
            : false;
        if (!alive) {
            return fail(COMMITMENT_REASONS.targetGone, {
                tokenId: target.tokenId ?? null,
                tokenUuid: target.tokenUuid ?? null
            });
        }
    }
    const expectedMorale = expected.morale ?? null;
    const liveMorale = live.moraleTier ?? null;
    if (expectedMorale !== liveMorale) {
        return fail(COMMITMENT_REASONS.moraleChanged, {
            expected: expectedMorale,
            live: liveMorale
        });
    }
    const threats = Array.isArray(expected.threats) ? expected.threats : [];
    if (threats.length && typeof live.resolveToken === "function") {
        const moveTol = Number.isFinite(live.moveTolerancePx) ? live.moveTolerancePx : 100;
        const tolerance = Number.isFinite(live.threatTolerance)
            ? live.threatTolerance : COMMITMENT_THREAT_TOLERANCE;
        let drifted = 0;
        const driftedIds = [];
        for (const th of threats) {
            const id = th.tokenId ?? th.tokenUuid;
            const doc = live.resolveToken(id);
            const alive = doc
                ? (typeof live.isTokenAlive === "function" ? live.isTokenAlive(doc) : true)
                : false;
            const pos = _tokenPosition(doc);
            const moved = Number.isFinite(pos.x) && Number.isFinite(th.x)
                ? Math.hypot(pos.x - th.x, pos.y - th.y)
                : Number.POSITIVE_INFINITY;
            if (!alive || moved > moveTol) {
                drifted++;
                driftedIds.push(id ?? null);
            }
        }
        if (drifted > tolerance) {
            return fail(COMMITMENT_REASONS.threatDrift, {
                drifted,
                tolerance,
                tokens: driftedIds
            });
        }
    }
    // Cheap L0 pass (issue #25): committed steps must never bypass the
    // hard veto — a pinned/prone bot may not execute a committed charge.
    // The executor still re-validates every step; this only guards the
    // shortcut. `stunned` never reaches L1 (it short-circuits earlier).
    const statuses = Array.isArray(live.selfStatuses) ? live.selfStatuses : [];
    if (statuses.includes("pinned") || statuses.includes("prone")) {
        const charge = steps.find(step => step?.input?.mode === "charge"
            || step?.input?.attackType === "charge");
        if (charge) {
            return fail(COMMITMENT_REASONS.l0Veto, {
                status: statuses.includes("pinned") ? "pinned" : "prone",
                step: charge.id ?? null
            });
        }
    }
    // Stale attack (smoke finding): a committed attack whose firing
    // point — the last move destination or the recorded self position —
    // can no longer see the live target position is replayed verbatim
    // otherwise, walking the bot into a wall it cannot shoot through.
    if (typeof live.losCheck === "function") {
        const attackStep = steps.find(
            step => step?.type === "attack" || step?.type === "test");
        const targetRef = attackStep?.input?.targetTokenId
            ?? attackStep?.input?.targetTokenUuid ?? null;
        const targetDoc = targetRef && typeof live.resolveToken === "function"
            ? live.resolveToken(targetRef) : null;
        if (attackStep && targetDoc) {
            const moveStep = [...steps].reverse()
                .find(step => step?.type === "move");
            const origin = moveStep?.input?.to ?? moveStep?.input?.destination
                ?? expected?.self ?? liveSelf ?? null;
            const pos = _tokenCenter(targetDoc, live.gridSize);
            if (Number.isFinite(origin?.x) && Number.isFinite(origin?.y)
                && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
                let open = true;
                try {
                    open = live.losCheck(
                        { center: { x: origin.x, y: origin.y }, document: null },
                        { center: { x: pos.x, y: pos.y }, document: null }) !== false;
                } catch(err) {
                    open = true;
                }
                if (!open) {
                    return fail(COMMITMENT_REASONS.losBroken, {
                        step: attackStep.id ?? null,
                        targetId: targetRef
                    });
                }
            }
        }
    }
    return { valid: true, reason: null, accepted };
}

/**
 * Build the live view {@link validateCommitment} consumes from the
 * planning inputs: combat round/turn, live token position, the own-move
 * journal, the graceful morale tier (absent flag = neutral), the
 * `manualOverrideGrace` toggle and the same-team intervention count that
 * drives reactive mode.
 * @param {object} input
 * @param {object|null} input.combat
 * @param {object|null} input.combatant
 * @param {object} input.context Planning context.
 * @param {string[]} input.selfStatuses
 * @returns {object} Live view for `validateCommitment`.
 */
function _commitmentLiveView({ combat, combatant, context, selfStatuses }) {
    const scene = context?.scene ?? combat?.scene
        ?? globalThis.canvas?.scene ?? null;
    const tokenDoc = _tokenDoc(context?.token ?? combatant?.token);
    const pos = _tokenPosition(tokenDoc);
    const gridSize = Number.isFinite(scene?.grid?.size) && scene.grid.size > 0
        ? scene.grid.size : 100;
    const round = Number.isFinite(combat?.round) ? combat.round : 0;
    const teamId = context?.team?.teamId ?? _flagTeamId(combatant);
    const interventions = countGmInterventions(combat, { round, teamId });
    const threshold = Number.isFinite(context?.interventionThreshold)
        ? context.interventionThreshold : COMMITMENT_REACTIVE_THRESHOLD;
    const grace = typeof context?.manualOverrideGrace === "boolean"
        ? context.manualOverrideGrace : isManualOverrideGrace();
    return {
        combatId: combat?.id ?? null,
        combatEnded: !combat || combat.ended === true,
        round,
        turn: Number.isFinite(combat?.turn) ? combat.turn : 0,
        self: {
            x: pos.x,
            y: pos.y,
            elevation: Number.isFinite(tokenDoc?.elevation) ? tokenDoc.elevation : 0
        },
        selfStatuses: Array.isArray(selfStatuses) ? selfStatuses : [],
        journal: readMoveJournal(combatant),
        grace,
        reactive: interventions > threshold,
        interventions,
        moraleTier: moraleTierOf(moralePostureOf(readMoraleRecord(combatant, context))),
        threatTolerance: Number.isFinite(context?.threatTolerance)
            ? context.threatTolerance : COMMITMENT_THREAT_TOLERANCE,
        positionTolerance: Number.isFinite(context?.positionTolerance)
            ? context.positionTolerance : COMMITMENT_POSITION_TOLERANCE_PX,
        moveTolerancePx: Number.isFinite(context?.moveTolerancePx)
            ? context.moveTolerancePx : gridSize,
        gridSize,
        resolveToken: tokenId => _findTokenDoc(tokenId, combat, scene),
        isTokenAlive: doc => _committedTokenAlive(doc, combat),
        // Wall-geometry probe for the committed-attack staleness check —
        // absent when no perception service was injected, the check then
        // degrades to the other invalidators.
        losCheck: typeof context?.perception?.hasLineOfSight === "function"
            ? (from, to) => context.perception.hasLineOfSight(from, to)
            : null
    };
}

/**
 * L1 commitment — funnel entry point (issue #25).
 *
 * A valid committed plan short-circuits the funnel: its serialized
 * `steps` execute verbatim and no scoring runs. Records arrive through
 * two sources:
 * - `context.commitment` injection — a bare `{valid?, steps, source?}`
 *   keeps the issue #24 trusted contract verbatim; a record carrying the
 *   persisted shape (`expectedState`/`combatId`/`status`/`createdRound`)
 *   runs the same validation as a flag read;
 * - the combatant `committedPlan` flag — persisted by the executor
 *   (controller-only), validated against `expectedState` every turn.
 *
 * Validation failures report the stable invalidator code directly
 * (`gm-intervention`, `target-gone`, `morale-changed`, `threat-drift`,
 * `ttl-expired`, `combat-ended`, `l0-veto`); an absent or damaged record
 * reports `commitment-miss` with `detail.reason` of
 * `no-commitment`/`invalid-commitment` per the #24 contract. The return
 * also exposes `record`, `invalidated`, `reactive` and `interventions`
 * for the caller's bookkeeping (persistence stays the executor's job —
 * the layer stays pure).
 * @param {object} input
 * @param {object|null} [input.combat] Combat document for the live view.
 * @param {object|null} input.combatant Active combatant document.
 * @param {object} [input.context] Planning context.
 * @param {object} [input.flags] Resolved layer flags.
 * @param {object|null} [input.diagnostics] Plan diagnostics record.
 * @param {string[]} [input.selfStatuses] Self status ids for the cheap
 *   L0 pass over committed steps.
 * @returns {{enabled: boolean, decision: null|{steps: object[],
 *   source: string}, record?: object|null, invalidated?: string|null,
 *   reactive?: boolean, interventions?: number, accepted?: object}}
 */
export function applyCommitmentLayer({ combat = null, combatant = null,
    context = {}, flags = {}, diagnostics = null, selfStatuses = [] } = {}) {
    if (flags.commitment !== true) {
        recordLayerReason(diagnostics, "L1", "commitment-layer-disabled");
        return { enabled: false, decision: null };
    }
    // The live view is built for every enabled pass — the caller needs
    // `reactive`/`interventions` even on a miss (they squeeze the ttl of
    // the next written record).
    const live = _commitmentLiveView({ combat, combatant, context, selfStatuses });
    const injected = context?.commitment !== undefined;
    const record = injected ? context.commitment : readCommittedPlan(combatant);
    if (record === null || record === undefined) {
        recordLayerReason(diagnostics, "L1", "commitment-miss", {
            reason: COMMITMENT_REASONS.noCommitment
        });
        return {
            enabled: true,
            decision: null,
            record: null,
            invalidated: null,
            reactive: live.reactive,
            interventions: live.interventions
        };
    }
    const persistedShape = record.expectedState !== undefined
        || record.combatId !== undefined || record.status !== undefined
        || record.createdRound !== undefined;
    if (!persistedShape) {
        // Issue #24 trusted-injection contract, verbatim.
        const steps = Array.isArray(record.steps) ? record.steps : [];
        if (record.valid !== false && steps.length) {
            const source = typeof record.source === "string" ? record.source : "commitment";
            recordLayerReason(diagnostics, "L1", "commitment-hit", {
                source,
                steps: steps.length
            });
            return {
                enabled: true,
                decision: { steps, source },
                record,
                reactive: live.reactive,
                interventions: live.interventions
            };
        }
        recordLayerReason(diagnostics, "L1", "commitment-miss", {
            reason: COMMITMENT_REASONS.invalidCommitment
        });
        return {
            enabled: true,
            decision: null,
            record,
            invalidated: COMMITMENT_REASONS.invalidCommitment,
            reactive: live.reactive,
            interventions: live.interventions
        };
    }
    const verdict = validateCommitment(record, live);
    const result = {
        enabled: true,
        decision: null,
        record,
        invalidated: verdict.valid ? null : verdict.reason,
        reactive: live.reactive,
        interventions: live.interventions
    };
    if (!verdict.valid) {
        recordLayerReason(diagnostics, "L1", verdict.reason, verdict.detail);
        return result;
    }
    const accepted = verdict.accepted ?? {};
    const steps = record.steps;
    const source = typeof record.source === "string" ? record.source : "commitment";
    recordLayerReason(diagnostics, "L1", "commitment-hit", {
        source,
        steps: steps.length,
        ...(accepted.selfMoved === true ? { selfMoved: true } : {}),
        ...(accepted.gmMoved === true ? { gmAccepted: true } : {}),
        ...(live.reactive === true ? { reactive: true } : {})
    });
    result.decision = { steps, source };
    result.accepted = accepted;
    return result;
}

/**
 * L3 personalities — bounded weight overlay. Merges the trait/character
 * deltas ({@link personalityWeightDelta}) over the preset weights, then
 * braces every applied delta to `± L3_DELTA_MAX_RATIO × |base|` (for a
 * zero/missing base the reference scale {@link L3_DELTA_BASE_FLOOR}
 * stands in) — a trait may bend a preference, never flip an ignored
 * factor into a doctrine.
 * @param {object} weights Base weight map (left untouched).
 * @param {object} [profile] `{traits, character}` resolution result.
 * @param {string[]} [profile.traits]
 * @param {string|null} [profile.character]
 * @returns {{weights: object, clamped: object}} Effective weights plus
 *   the per-factor clamp report `factor → {raw, applied, bound}` for the
 *   deltas that hit the bound (empty when nothing clamped).
 */
export function boundedPersonalityOverlay(weights, { traits = [], character = null } = {}) {
    const base = { ...(weights ?? {}) };
    const delta = personalityWeightDelta({ traits, character });
    const effective = { ...base };
    const clamped = {};
    for (const [key, raw] of Object.entries(delta)) {
        if (!Number.isFinite(raw)) continue;
        const baseW = Number.isFinite(base[key]) ? base[key] : 0;
        const bound = L3_DELTA_MAX_RATIO
            * (Math.abs(baseW) > 0 ? Math.abs(baseW) : L3_DELTA_BASE_FLOOR);
        const applied = Math.max(-bound, Math.min(bound, raw));
        effective[key] = baseW + applied;
        if (Math.abs(applied - raw) > 1e-9) {
            clamped[key] = {
                raw,
                applied,
                bound: Math.round(bound * 1e6) / 1e6
            };
        }
    }
    return { weights: effective, clamped };
}
