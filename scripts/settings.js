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
 */
import {
    AI_DIFFICULTIES,
    ATTACK_ADJUDICATION_MODES,
    DEFAULT_AI_DIFFICULTY,
    DEFAULT_ATTACK_ADJUDICATION,
    DEFAULT_LAYER_FLAGS,
    DEFAULT_PREFERRED_COHESION,
    DEFAULT_PREVIEW_TIMEOUT_SECONDS,
    DEFAULT_TURN_PACING_MS,
    EXECUTION_MODES,
    MODULE_ID,
    SETTING_KEYS
} from "./constants.js";

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
