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
 *   step and the scoring pipeline never runs. This module carries only
 *   the entry point and the contract for issue #25: a commitment record
 *   `{valid?, steps, source?}` arrives through `context.commitment` (the
 *   persistence backend is #25's own job). A valid record short-circuits
 *   the whole funnel; an absent or invalid one is a documented miss.
 * - **L2 morale** — the fireteam's ternary posture
 *   (defensive/neutral/aggressive, today expressed through the reserved
 *   `morale` flag's `pressured`/`desperate` readings). Pass-through stub
 *   for issue #26: the layer resolves and reports the posture but narrows
 *   nothing yet — task assignment and posture factors land with #26.
 *   The legacy graceful reads of the `morale` flag (issue #38 sync/order
 *   hooks) stay unconditional by contract.
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
    DEFAULT_LAYER_FLAGS,
    FLAG_KEYS,
    MODULE_ID
} from "./constants.js";
import { personalityWeightDelta } from "./personalities.js";
import { getLayerFlags } from "./settings.js";

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
 * Normalize a raw `morale` record (issue #26 reserved flag) into the
 * ternary posture view. Absent or damaged records mean normal morale.
 * @param {*} record Raw `{state, pressured?, desperate?}` payload.
 * @returns {{state: string|null, pressured: boolean, desperate: boolean}}
 */
export function moralePostureOf(record) {
    const state = typeof record?.state === "string" ? record.state : null;
    return {
        state,
        pressured: record?.pressured === true || state === "pressured",
        desperate: record?.desperate === true || state === "desperate"
    };
}

/**
 * Read the raw morale record for one combatant: `context.morale`
 * injection wins (tests/integrations), then the reserved module flag
 * `flags["only-war-ai"].morale`.
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
 * L2 morale — funnel entry point (stub for issue #26). When the layer is
 * enabled the resolved posture is reported on the trace and returned to
 * the caller; when disabled the layer degrades to a neutral posture and
 * reports `morale-layer-disabled`. Narrowing effects (task assignment,
 * posture factors) are #26's own work.
 * @param {object} input
 * @param {object|null} input.combatant Active combatant document.
 * @param {object} [input.context] Planning context.
 * @param {object} [input.flags] Resolved layer flags.
 * @param {object|null} [input.diagnostics] Plan diagnostics record.
 * @returns {{enabled: boolean, state: string|null, pressured: boolean,
 *   desperate: boolean}}
 */
export function applyMoraleLayer({ combatant = null, context = {},
    flags = {}, diagnostics = null } = {}) {
    if (flags.morale !== true) {
        recordLayerReason(diagnostics, "L2", "morale-layer-disabled");
        return { enabled: false, state: null, pressured: false, desperate: false };
    }
    const posture = moralePostureOf(readMoraleRecord(combatant, context));
    recordLayerReason(diagnostics, "L2", "morale-posture", posture);
    return { enabled: true, ...posture };
}

/**
 * L1 commitment — funnel entry point (contract stub for issue #25).
 *
 * Contract: a commitment record is `{valid?: boolean, steps: object[],
 * source?: string}` where `steps` are already-serialized plan steps (the
 * same shape `_stepsFor` emits). Today the record only arrives through
 * `context.commitment` — #25 owns flag persistence, validity checks and
 * step regeneration. A valid non-empty record produces a decision the
 * planner executes verbatim (scoring never runs); anything else is a
 * miss and the funnel continues. Committed steps must already satisfy
 * L0 — the layer trusts the record's own validity marker.
 * @param {object} input
 * @param {object|null} input.combatant Active combatant document.
 * @param {object} [input.context] Planning context.
 * @param {object} [input.flags] Resolved layer flags.
 * @param {object|null} [input.diagnostics] Plan diagnostics record.
 * @returns {{enabled: boolean, decision: null|{steps: object[],
 *   source: string}}}
 */
export function applyCommitmentLayer({ combatant = null, context = {},
    flags = {}, diagnostics = null } = {}) {
    if (flags.commitment !== true) {
        recordLayerReason(diagnostics, "L1", "commitment-layer-disabled");
        return { enabled: false, decision: null };
    }
    const record = context?.commitment ?? null;
    const steps = Array.isArray(record?.steps) ? record.steps : [];
    if (record && record.valid !== false && steps.length) {
        const source = typeof record.source === "string" ? record.source : "commitment";
        recordLayerReason(diagnostics, "L1", "commitment-hit", {
            source,
            steps: steps.length
        });
        return { enabled: true, decision: { steps, source } };
    }
    recordLayerReason(diagnostics, "L1", "commitment-miss", {
        reason: record ? "invalid-commitment" : "no-commitment"
    });
    return { enabled: true, decision: null };
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
