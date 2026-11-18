/**
 * Shared constants for the Only War AI module.
 * Flag namespace, preset/mode enums and the system compatibility contract.
 */

/** Foundry module id, used as the flags scope and settings namespace. */
export const MODULE_ID = "only-war-ai";

/** Version of the module's public API contract ("major.minor"). */
export const MODULE_API_VERSION = "1.0";

/** Fixed AI behaviour presets exposed to the GM. */
export const AI_PRESETS = Object.freeze([
    "assault",
    "rangedCover",
    "hold",
    "specOps"
]);

/** Fallback preset used when AI is explicitly enabled without a valid preset. */
export const FALLBACK_PRESET = "hold";

/** Override modes for Token and Combatant flags. */
export const OVERRIDE_MODES = Object.freeze([
    "inherit",
    "enabled",
    "disabled"
]);

/** Flag keys inside the `flags["only-war-ai"]` namespace. */
export const FLAG_KEYS = Object.freeze({
    actorConfig: "config",
    override: "override",
    memory: "memory"
});

/** World setting keys. */
export const SETTING_KEYS = Object.freeze({
    executionMode: "executionMode",
    diagnosticsEnabled: "diagnosticsEnabled"
});

/** Execution modes for the world setting. */
export const EXECUTION_MODES = Object.freeze([
    "automatic",
    "preview"
]);

/** Required host system id. */
export const REQUIRED_SYSTEM_ID = "only-war-local";

/** Required major version of the public system API (`game.darkHeresy.api`). */
export const REQUIRED_SYSTEM_API_MAJOR = "1";
