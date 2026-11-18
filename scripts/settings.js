/**
 * World settings for the Only War AI module (issue #399).
 *
 * - `executionMode`: "automatic" | "preview" — GM-only, defaults to "preview"
 *   so AI never executes turns without an explicit opt-in.
 * - `diagnosticsEnabled`: boolean — GM-only diagnostic logging.
 */
import {
    EXECUTION_MODES,
    MODULE_ID,
    SETTING_KEYS
} from "./constants.js";

/** Register the module's world settings. Called on `init`. */
export function registerSettings() {
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
