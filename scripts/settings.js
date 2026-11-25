/**
 * World settings for the Only War AI module (issue #399).
 *
 * - `masterEnabled`: boolean — GM-only kill switch for the whole module;
 *   when false no AI turn is claimed, executed or previewed (UI hidden).
 * - `executionMode`: "automatic" | "preview" — GM-only, defaults to "preview"
 *   so AI never executes turns without an explicit opt-in.
 * - `diagnosticsEnabled`: boolean — GM-only diagnostic logging.
 * - `preferredCohesion`: default fireteam cohesion distance (issue #408).
 * - `previewTimeoutSeconds`: GM preview auto-cancel timeout (issue #409).
 * - `aiDifficulty`: "easy" | "normal" | "hard" — tactical depth of the
 *   planner (issue #16); personalities of issue #19 read it too.
 * - `threatMapOverlay`: boolean — persisted toggle of the GM-only danger
 *   heatmap debug overlay (issue #36); rendering stays GM-only either way.
 * - `attackAdjudication`: "auto" | "gm-confirm" — whether irreversible
 *   attack/test steps execute unattended or pause for a GM decision card
 *   (issue #37). Applies to `executionMode: "automatic"` only; the preview
 *   mode already carries its own confirmation point.
 * - `layersCommitment`/`layersMorale`/`layersPersonality`/
 *   `layersLookahead`: booleans — per-layer on/off toggles of the L0–L4
 *   planning funnel (issue #24). A disabled layer degrades to the
 *   previous level; defaults live in {@link DEFAULT_LAYER_FLAGS}.
 * - `manualOverrideGrace`: boolean (issue #25) — on: a manual GM move of
 *   an AI token is absolute law and never cancels a committed plan;
 *   off (default): unexplained drift is `gm-intervention`.
 * - `aiBarks`/`barksToPlayers`: booleans (issue #26) — short chat barks
 *   telegraphing AI intent on morale-tier changes and committed-plan
 *   starts. GM whispers by default; `barksToPlayers` makes them public.
 * - `aiTraceVerbose`: "compact" | "full" (issue #27) — whether the
 *   reason trace renders the final per-layer verdicts or every recorded
 *   `{layer, code, detail}` reason record.
 * - `aiCaptureContext`: boolean (issue #27) — executor keeps a bounded
 *   journal of `planContext`+snapshot captures on the combatant
 *   `captureJournal` flag (offline `planTurn` replay fixtures).
 */
import {
    AI_DIFFICULTIES,
    ATTACK_ADJUDICATION_MODES,
    DEFAULT_AI_DIFFICULTY,
    DEFAULT_ATTACK_ADJUDICATION,
    DEFAULT_DAMAGE_WAIT_TIMEOUT_SECONDS,
    DEFAULT_LAYER_FLAGS,
    DEFAULT_PREFERRED_COHESION,
    DEFAULT_PREVIEW_TIMEOUT_SECONDS,
    DEFAULT_TRACE_MODE,
    DEFAULT_TURN_PACING_MS,
    EXECUTION_MODES,
    MODULE_ID,
    MORALE_DESPERATE_OUTNUMBER_RATIO,
    SETTING_KEYS,
    TRACE_MODES
} from "./constants.js";
import {
    SPEC_OPS_CONFIG,
    SPEC_OPS_FALLBACK_PRESETS,
    SPEC_OPS_NUMERIC_RANGES,
    resolveSpecOpsConfig
} from "./presets/spec-ops-config.js";

const SPEC_OPS_SETTINGS = {
    flankMinAngleDegrees: SETTING_KEYS.specOpsFlankMinAngleDegrees,
    maxDetachedRounds: SETTING_KEYS.specOpsMaxDetachedRounds,
    highThreatRatio: SETTING_KEYS.specOpsHighThreatRatio,
    supportWeight: SETTING_KEYS.specOpsSupportWeight,
    flankWeight: SETTING_KEYS.specOpsFlankWeight,
    assaultWeight: SETTING_KEYS.specOpsAssaultWeight,
    cohesionWeight: SETTING_KEYS.specOpsCohesionWeight,
    fallbackPreset: SETTING_KEYS.specOpsFallbackPreset
};

/** Register the module's world settings. Called on `init`. */
export function registerSettings() {
    game.settings.register(MODULE_ID, SETTING_KEYS.masterEnabled, {
        name: "OWAI.Settings.MasterEnabled.Name",
        hint: "OWAI.Settings.MasterEnabled.Hint",
        scope: "world",
        config: true,
        type: Boolean,
        default: true
    });

    game.settings.register(MODULE_ID, SETTING_KEYS.executionMode, {
        name: "OWAI.Settings.ExecutionMode.Name",
        hint: "OWAI.Settings.ExecutionMode.Hint",
        scope: "world",
        config: true,
        type: String,
        choices: {
            automatic: "OWAI.Settings.ExecutionMode.Automatic",
            preview: "OWAI.Settings.ExecutionMode.Preview"
        },
        default: "preview"
    });

    game.settings.register(MODULE_ID, SETTING_KEYS.diagnosticsEnabled, {
        name: "OWAI.Settings.DiagnosticsEnabled.Name",
        hint: "OWAI.Settings.DiagnosticsEnabled.Hint",
        scope: "world",
        config: true,
        type: Boolean,
        default: false
    });

    game.settings.register(MODULE_ID, SETTING_KEYS.preferredCohesion, {
        name: "OWAI.Settings.PreferredCohesion.Name",
        hint: "OWAI.Settings.PreferredCohesion.Hint",
        scope: "world",
        config: true,
        type: Number,
        default: DEFAULT_PREFERRED_COHESION
    });

    game.settings.register(MODULE_ID, SETTING_KEYS.previewTimeoutSeconds, {
        name: "OWAI.Settings.PreviewTimeout.Name",
        hint: "OWAI.Settings.PreviewTimeout.Hint",
        scope: "world",
        config: true,
        type: Number,
        default: DEFAULT_PREVIEW_TIMEOUT_SECONDS
    });

    // Issue #56: bound of the post-attack damage adjudication wait —
    // a landed bot attack defers `nextTurn` while the GM rolls and
    // applies the damage card; `0` waits until the turn is advanced
    // manually.
    game.settings.register(MODULE_ID, SETTING_KEYS.damageWaitTimeoutSeconds, {
        name: "OWAI.Settings.DamageWaitTimeout.Name",
        hint: "OWAI.Settings.DamageWaitTimeout.Hint",
        scope: "world",
        config: true,
        type: Number,
        default: DEFAULT_DAMAGE_WAIT_TIMEOUT_SECONDS
    });

    // Smoke finding: when off, a settled damage wait keeps the turn
    // under manual GM control — `nextTurn` is only driven by the GM.
    game.settings.register(MODULE_ID, SETTING_KEYS.damageWaitAutoAdvance, {
        name: "OWAI.Settings.DamageWaitAutoAdvance.Name",
        hint: "OWAI.Settings.DamageWaitAutoAdvance.Hint",
        scope: "world",
        config: true,
        type: Boolean,
        default: true
    });

    // Issue #32: pan the GM canvas onto the acting bot so automated and
    // previewed turns stay watchable without hunting the token.
    game.settings.register(MODULE_ID, SETTING_KEYS.centerOnBot, {
        name: "OWAI.Settings.CenterOnBot.Name",
        hint: "OWAI.Settings.CenterOnBot.Hint",
        scope: "world",
        config: true,
        type: Boolean,
        default: true
    });

    game.settings.register(MODULE_ID, SETTING_KEYS.turnPacingMs, {
        name: "OWAI.Settings.TurnPacing.Name",
        hint: "OWAI.Settings.TurnPacing.Hint",
        scope: "world",
        config: true,
        type: Number,
        default: DEFAULT_TURN_PACING_MS
    });

    game.settings.register(MODULE_ID, SETTING_KEYS.aiDifficulty, {
        name: "OWAI.Settings.AiDifficulty.Name",
        hint: "OWAI.Settings.AiDifficulty.Hint",
        scope: "world",
        config: true,
        type: String,
        choices: {
            easy: "OWAI.Settings.AiDifficulty.Easy",
            normal: "OWAI.Settings.AiDifficulty.Normal",
            hard: "OWAI.Settings.AiDifficulty.Hard"
        },
        default: DEFAULT_AI_DIFFICULTY
    });

    game.settings.register(MODULE_ID, SETTING_KEYS.attackAdjudication, {
        name: "OWAI.Settings.AttackAdjudication.Name",
        hint: "OWAI.Settings.AttackAdjudication.Hint",
        scope: "world",
        config: true,
        type: String,
        choices: {
            auto: "OWAI.Settings.AttackAdjudication.Auto",
            "gm-confirm": "OWAI.Settings.AttackAdjudication.GmConfirm"
        },
        default: DEFAULT_ATTACK_ADJUDICATION
    });

    game.settings.register(MODULE_ID, SETTING_KEYS.threatMapOverlay, {
        name: "OWAI.Settings.ThreatMapOverlay.Name",
        hint: "OWAI.Settings.ThreatMapOverlay.Hint",
        scope: "world",
        config: true,
        type: Boolean,
        default: false,
        onChange: value => {
            // Sync the live toggle with the debug overlay service (issue
            // #36); the service renders strictly on GM clients anyway.
            try {
                game.modules.get(MODULE_ID)?.api?.services
                    ?.get?.("planOverlay")?.setDangerEnabled?.(value === true, { persist: false });
            } catch(_err) {
                // The service may be absent or mid-init — harmless.
            }
        }
    });

    // Issue #24: per-layer toggles of the L0–L4 behaviour funnel.
    for (const [key, settingKey, suffix] of [
        ["commitment", SETTING_KEYS.layersCommitment, "LayerCommitment"],
        ["morale", SETTING_KEYS.layersMorale, "LayerMorale"],
        ["personality", SETTING_KEYS.layersPersonality, "LayerPersonality"],
        ["lookahead", SETTING_KEYS.layersLookahead, "LayerLookahead"]
    ]) {
        game.settings.register(MODULE_ID, settingKey, {
            name: `OWAI.Settings.${suffix}.Name`,
            hint: `OWAI.Settings.${suffix}.Hint`,
            scope: "world",
            config: true,
            type: Boolean,
            default: DEFAULT_LAYER_FLAGS[key]
        });
    }

    // Issue #25: manual GM moves vs committed plans — off (default) a
    // bot replans around the GM's move (gm-intervention), on a manual
    // move is absolute law that never cancels a commitment.
    game.settings.register(MODULE_ID, SETTING_KEYS.manualOverrideGrace, {
        name: "OWAI.Settings.ManualOverrideGrace.Name",
        hint: "OWAI.Settings.ManualOverrideGrace.Hint",
        scope: "world",
        config: true,
        type: Boolean,
        default: false
    });

    // Issue #26: AI intent telegraphing through short chat barks —
    // GM-only whispers by default (`barksToPlayers` opens them to the
    // table for drama).
    game.settings.register(MODULE_ID, SETTING_KEYS.aiBarks, {
        name: "OWAI.Settings.AiBarks.Name",
        hint: "OWAI.Settings.AiBarks.Hint",
        scope: "world",
        config: true,
        type: Boolean,
        default: true
    });

    game.settings.register(MODULE_ID, SETTING_KEYS.barksToPlayers, {
        name: "OWAI.Settings.BarksToPlayers.Name",
        hint: "OWAI.Settings.BarksToPlayers.Hint",
        scope: "world",
        config: true,
        type: Boolean,
        default: false
    });

    // Issue #27: the reason-trace render mode — compact collapses every
    // layer to its verdict line, full shows each recorded reason record.
    game.settings.register(MODULE_ID, SETTING_KEYS.aiTraceVerbose, {
        name: "OWAI.Settings.TraceVerbose.Name",
        hint: "OWAI.Settings.TraceVerbose.Hint",
        scope: "world",
        config: true,
        type: String,
        choices: {
            compact: "OWAI.Settings.TraceVerbose.Compact",
            full: "OWAI.Settings.TraceVerbose.Full"
        },
        default: DEFAULT_TRACE_MODE
    });

    // Issue #27: replay capture — the executor keeps a bounded journal
    // of `planContext`+snapshot captures on the combatant flag so a GM
    // can replay `planTurn` offline (debugging/bug reports).
    game.settings.register(MODULE_ID, SETTING_KEYS.aiCaptureContext, {
        name: "OWAI.Settings.CaptureContext.Name",
        hint: "OWAI.Settings.CaptureContext.Hint",
        scope: "world",
        config: true,
        type: Boolean,
        default: false
    });

    // Issue #26 review: GM-tunable desperation threshold — the enemy
    // headcount ratio that alone turns the morale proposal `desperate`.
    // Default 2: a 2:1 deficit is the squad's normal war; fighting at
    // parity or a small disadvantage stays `pressured`.
    game.settings.register(MODULE_ID, SETTING_KEYS.moraleDesperateRatio, {
        name: "OWAI.Settings.MoraleDesperateRatio.Name",
        hint: "OWAI.Settings.MoraleDesperateRatio.Hint",
        scope: "world",
        config: true,
        type: Number,
        range: { min: 1, max: 10, step: 0.5 },
        default: 2
    });

    for (const [field, key] of Object.entries(SPEC_OPS_SETTINGS)) {
        const range = SPEC_OPS_NUMERIC_RANGES[field];
        game.settings.register(MODULE_ID, key, {
            name: `OWAI.Settings.SpecOps.${field}.Name`,
            hint: `OWAI.Settings.SpecOps.${field}.Hint`,
            scope: "world",
            config: true,
            default: SPEC_OPS_CONFIG[field],
            ...(range ? { type: Number, range: { ...range } } : {
                type: String,
                choices: Object.fromEntries(SPEC_OPS_FALLBACK_PRESETS.map(id => [id, `OWAI.Preset.${id}`]))
            })
        });
    }
}

/**
 * Current execution mode ("automatic" | "preview"). Defaults to "preview"
 * when the setting is missing or damaged.
 * @returns {string}
 */
export function getExecutionMode() {
    try {
        const value = game.settings.get(MODULE_ID, SETTING_KEYS.executionMode);
        return EXECUTION_MODES.includes(value) ? value : "preview";
    } catch(_err) {
        return "preview";
    }
}

/**
 * Master kill switch for the whole module. When false the module behaves as
 * if it were incompatible: no turn claims, no execution, no preview and no
 * injected UI. Missing or damaged values fall back to `true`.
 * @returns {boolean}
 */
export function isMasterEnabled() {
    try {
        const value = game.settings.get(MODULE_ID, SETTING_KEYS.masterEnabled);
        return value !== false;
    } catch(_err) {
        return true;
    }
}

/**
 * World-level default preferred fireteam cohesion distance in scene units
 * (issue #408). Fireteam flags may override it per team; damaged or missing
 * values fall back to {@link DEFAULT_PREFERRED_COHESION}.
 * @returns {number}
 */
export function getPreferredCohesion() {
    try {
        const value = game.settings.get(MODULE_ID, SETTING_KEYS.preferredCohesion);
        return Number.isFinite(value) && value > 0 ? value : DEFAULT_PREFERRED_COHESION;
    } catch(_err) {
        return DEFAULT_PREFERRED_COHESION;
    }
}

/**
 * Resolve one snapshot of the world doctrine for a new Spec Ops plan.
 * @param {object|null} [overrides] Explicit TeamPlan inputs (macros/tests).
 * @returns {object}
 */
export function getSpecOpsConfig(overrides = null) {
    const stored = {};
    for (const [field, key] of Object.entries(SPEC_OPS_SETTINGS)) {
        try {
            stored[field] = globalThis.game?.settings?.get(MODULE_ID, key);
        } catch(_err) {
            // Before init the setting is not registered. Use its default.
        }
    }
    return resolveSpecOpsConfig(overrides, stored);
}

/**
 * GM preview timeout in seconds (issue #409). `0` disables the timeout so a
 * preview waits for a decision forever; damaged or missing values fall back
 * to {@link DEFAULT_PREVIEW_TIMEOUT_SECONDS}.
 * @returns {number}
 */
export function getPreviewTimeoutSeconds() {
    try {
        const value = game.settings.get(MODULE_ID, SETTING_KEYS.previewTimeoutSeconds);
        return Number.isFinite(value) && value >= 0 ? value : DEFAULT_PREVIEW_TIMEOUT_SECONDS;
    } catch(_err) {
        return DEFAULT_PREVIEW_TIMEOUT_SECONDS;
    }
}

/**
 * Bound of the post-attack damage adjudication wait in seconds (issue
 * #56). A landed bot attack defers `combat.nextTurn` while the GM rolls
 * the damage card and applies its hits; `0` disables the timeout so the
 * turn waits until the card settles or the GM advances it manually.
 * Damaged or missing values fall back to
 * {@link DEFAULT_DAMAGE_WAIT_TIMEOUT_SECONDS}.
 * @returns {number}
 */
export function getDamageWaitTimeoutSeconds() {
    try {
        const value = game.settings.get(MODULE_ID, SETTING_KEYS.damageWaitTimeoutSeconds);
        return Number.isFinite(value) && value >= 0 ? value : DEFAULT_DAMAGE_WAIT_TIMEOUT_SECONDS;
    } catch(_err) {
        return DEFAULT_DAMAGE_WAIT_TIMEOUT_SECONDS;
    }
}

/**
 * Whether a settled damage wait drives `combat.nextTurn` automatically
 * (`true`, default) or hands the turn back to manual GM control
 * (`false`) — the GM applies damage and advances at their own pace.
 * @returns {boolean}
 */
export function getDamageWaitAutoAdvance() {
    try {
        return game.settings.get(MODULE_ID, SETTING_KEYS.damageWaitAutoAdvance) !== false;
    } catch(_err) {
        return true;
    }
}

/**
 * Whether the GM canvas pans to the acting bot when its turn is
 * claimed (issue #32). Default on; damaged/missing values stay on.
 * @returns {boolean}
 */
export function getCenterOnBot() {
    try {
        return game.settings.get(MODULE_ID, SETTING_KEYS.centerOnBot) !== false;
    } catch(_err) {
        return true;
    }
}

/**
 * Pacing delay in milliseconds inserted between AI execution steps and
 * before the combat turn advances, so automated turns stay watchable.
 * `0` disables the delay; damaged or missing values fall back to
 * {@link DEFAULT_TURN_PACING_MS}.
 * @returns {number}
 */
export function getTurnPacingMs() {
    try {
        const value = game.settings.get(MODULE_ID, SETTING_KEYS.turnPacingMs);
        return Number.isFinite(value) && value >= 0 ? value : DEFAULT_TURN_PACING_MS;
    } catch(_err) {
        return DEFAULT_TURN_PACING_MS;
    }
}

/**
 * AI tactical difficulty ("easy" | "normal" | "hard", issue #16). Gates the
 * planner's threat-map awareness, the lookahead pass and the deliberate
 * sub-optimal pick of easy mode. Missing or damaged values fall back to
 * {@link DEFAULT_AI_DIFFICULTY}.
 * @returns {string}
 */
export function getAIDifficulty() {
    try {
        const value = game.settings.get(MODULE_ID, SETTING_KEYS.aiDifficulty);
        return AI_DIFFICULTIES.includes(value) ? value : DEFAULT_AI_DIFFICULTY;
    } catch(_err) {
        return DEFAULT_AI_DIFFICULTY;
    }
}

/**
 * Whether diagnostic logging is enabled.
 * @returns {boolean}
 */
export function isDiagnosticsEnabled() {
    try {
        return game.settings.get(MODULE_ID, SETTING_KEYS.diagnosticsEnabled) === true;
    } catch(_err) {
        return false;
    }
}

/**
 * Attack adjudication mode ("auto" | "gm-confirm", issue #37). With
 * `"gm-confirm"` the executor pauses before each irreversible attack/test
 * step and asks the GM via a chat card whether to execute it, roll it
 * manually, substitute a skill test or cancel the turn. Missing or damaged
 * values fall back to {@link DEFAULT_ATTACK_ADJUDICATION}.
 * @returns {string}
 */
export function getAttackAdjudication() {
    try {
        const value = game.settings.get(MODULE_ID, SETTING_KEYS.attackAdjudication);
        return ATTACK_ADJUDICATION_MODES.includes(value) ? value : DEFAULT_ATTACK_ADJUDICATION;
    } catch(_err) {
        return DEFAULT_ATTACK_ADJUDICATION;
    }
}

/**
 * Whether the GM-only danger heatmap debug overlay is enabled (issue #36).
 * @returns {boolean}
 */
export function isThreatMapOverlayEnabled() {
    try {
        return game.settings.get(MODULE_ID, SETTING_KEYS.threatMapOverlay) === true;
    } catch(_err) {
        return false;
    }
}

/**
 * Manual-override grace (issue #25): when `true` a GM move of an AI
 * token is absolute law — the committed plan is not cancelled and the
 * bot is not marked `gm-controlled`; the commitment simply accepts the
 * new position. When `false` (default) an unexplained drift cancels the
 * commitment as `gm-intervention` so the bot replans — the readable
 * drama of a cowardly bot crawling back on its own turn. Missing or
 * damaged values fall back to `false`.
 * @returns {boolean}
 */
export function isManualOverrideGrace() {
    try {
        return game.settings.get(MODULE_ID, SETTING_KEYS.manualOverrideGrace) === true;
    } catch(_err) {
        return false;
    }
}

/**
 * Whether AI chat barks are emitted (issue #26): short localized
 * phrases on morale-tier changes and committed-plan starts. Default
 * `true` — the audience is GM-only whispers anyway, so the telegraphing
 * costs the table nothing; `barksToPlayers` decides who else sees it.
 * @returns {boolean}
 */
export function isBarksEnabled() {
    try {
        const value = game.settings.get(MODULE_ID, SETTING_KEYS.aiBarks);
        return value !== false;
    } catch(_err) {
        return true;
    }
}

/**
 * Whether AI barks go to the whole table instead of GM whispers
 * (issue #26). Default `false` — the GM hears the intent telegraphing;
 * turning it on makes the drama public.
 * @returns {boolean}
 */
export function barksToPlayers() {
    try {
        const value = game.settings.get(MODULE_ID, SETTING_KEYS.barksToPlayers);
        return value === true;
    } catch(_err) {
        return false;
    }
}

/**
 * Reason-trace render mode ("compact" | "full", issue #27). `compact`
 * collapses each layer to its verdict line; `full` renders every
 * recorded `{layer, code, detail}` reason record. Missing or damaged
 * values fall back to {@link DEFAULT_TRACE_MODE}.
 * @returns {string}
 */
export function getTraceMode() {
    try {
        const value = game.settings.get(MODULE_ID, SETTING_KEYS.aiTraceVerbose);
        return TRACE_MODES.includes(value) ? value : DEFAULT_TRACE_MODE;
    } catch(_err) {
        return DEFAULT_TRACE_MODE;
    }
}

/**
 * Whether the executor keeps the replay-capture journal (issue #27):
 * a bounded `captureJournal` combatant flag of `planContext`+snapshot
 * entries — each a ready-made offline `planTurn` fixture.
 * @returns {boolean}
 */
export function isCaptureContextEnabled() {
    try {
        return game.settings.get(MODULE_ID, SETTING_KEYS.aiCaptureContext) === true;
    } catch(_err) {
        return false;
    }
}

/**
 * The enemy-headcount ratio at which numbers alone propose `desperate`
 * (issue #26): `enemies >= members × ratio` — default
 * `MORALE_DESPERATE_OUTNUMBER_RATIO` (2), a 2:1 deficit. Values below 1
 * or damaged read as the default; `context.moraleOutnumberRatio`
 * overrides per plan.
 * @returns {number}
 */
export function getMoraleDesperateRatio() {
    try {
        const value = Number(game.settings.get(MODULE_ID, SETTING_KEYS.moraleDesperateRatio));
        return Number.isFinite(value) && value >= 1 ? value : MORALE_DESPERATE_OUTNUMBER_RATIO;
    } catch(_err) {
        return MORALE_DESPERATE_OUTNUMBER_RATIO;
    }
}

/**
 * Effective on/off map of the behaviour layers (issue #24):
 * `{commitment, morale, personality, lookahead}`. Missing or damaged
 * values fall back to {@link DEFAULT_LAYER_FLAGS}; `context.layers`
 * overrides are merged by the planner funnel (`scripts/layers.js`).
 * @returns {object}
 */
export function getLayerFlags() {
    const read = key => {
        try {
            const value = game.settings.get(MODULE_ID, SETTING_KEYS[`layers${key[0].toUpperCase()}${key.slice(1)}`]);
            return typeof value === "boolean" ? value : DEFAULT_LAYER_FLAGS[key];
        } catch(_err) {
            return DEFAULT_LAYER_FLAGS[key];
        }
    };
    const flags = {};
    for (const key of Object.keys(DEFAULT_LAYER_FLAGS)) flags[key] = read(key);
    return flags;
}

/**
 * Write a diagnostic line to the console when diagnostics are enabled.
 * @param {...*} args
 */
export function logDiagnostics(...args) {
    if (isDiagnosticsEnabled()) {
        console.debug(`${MODULE_ID} |`, ...args);
    }
}
