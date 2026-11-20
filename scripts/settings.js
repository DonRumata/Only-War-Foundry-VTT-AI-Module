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
 */
import {
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
 * Write a diagnostic line to the console when diagnostics are enabled.
 * @param {...*} args
 */
export function logDiagnostics(...args) {
    if (isDiagnosticsEnabled()) {
        console.debug(`${MODULE_ID} |`, ...args);
    }
}
