/**
 * Only War AI module bootstrap (issue #399).
 *
 * Lifecycle:
 * - `init` registers world settings, the settings menu, the public module API
 *   (`game.modules.get("only-war-ai").api`) and UI hook points.
 * - `ready` verifies `game.system.id === "only-war-local"` and the major
 *   version of `game.darkHeresy.api` (issue #398 contract). On mismatch the
 *   module shows a single GM notification and stays disabled — it never
 *   activates NPCs on its own.
 */
import { MODULE_ID } from "./constants.js";
import { checkSystemCompatibility, COMPATIBILITY_REASONS } from "./compatibility.js";
import { createModuleApi } from "./api.js";
import { createPlannerService } from "./planner.js";
import { registerAssaultPreset } from "./presets/assault.js";
import { registerSettings } from "./settings.js";
import { registerSheetControls } from "./ui/npc-sheet.js";
import { registerCombatTrackerControls } from "./ui/combat-tracker.js";
import { registerConfigMenu } from "./ui/config-menu.js";

Hooks.once("init", () => {
    console.log(`${MODULE_ID} | Initializing Only War AI`);

    // Publish the API early so macros and follow-up modules can inspect it
    // even when the compatibility check on `ready` keeps the module disabled.
    const mod = game.modules.get(MODULE_ID);
    if (mod) {
        mod.api = createModuleApi();
    } else {
        console.error(`${MODULE_ID} | Module record not found; API not published`);
    }

    try {
        _registerPlannerService(mod?.api);
    } catch(err) {
        console.error(`${MODULE_ID} | Failed to register planner service`, err);
    }

    try {
        registerSettings();
    } catch(err) {
        console.error(`${MODULE_ID} | Failed to register settings`, err);
    }

    try {
        registerConfigMenu();
    } catch(err) {
        console.error(`${MODULE_ID} | Failed to register settings menu`, err);
    }

    try {
        registerSheetControls();
    } catch(err) {
        console.error(`${MODULE_ID} | Failed to register sheet controls`, err);
    }

    try {
        registerCombatTrackerControls();
    } catch(err) {
        console.error(`${MODULE_ID} | Failed to register combat tracker controls`, err);
    }

    // Hook point for follow-up subtasks and third-party integrations.
    Hooks.callAll(`${MODULE_ID}.apiReady`, mod?.api);
});

Hooks.once("ready", () => {
    const api = game.modules.get(MODULE_ID)?.api;
    const compatibility = checkSystemCompatibility({
        systemId: game.system?.id,
        api: game.darkHeresy?.api
    });

    if (!compatibility.ok) {
        if (api) {
            api._state.enabled = false;
            api._state.incompatibleReason = compatibility.reason;
        }
        _notifyIncompatibleOnce(compatibility);
        console.warn(
            `${MODULE_ID} | Disabled: ${compatibility.reason} `
            + `(expected ${compatibility.expected}, got ${compatibility.actual ?? "none"})`
        );
        return;
    }

    if (api) {
        api._state.enabled = true;
        api._state.incompatibleReason = null;
    }
    console.log(`${MODULE_ID} | Ready`);
});

/**
 * Register the `planner` service on the module API (issue #403). The
 * service is pure/deterministic — no hooks, no lifecycle — so it is
 * available immediately for the executor and macros.
 * @param {object} api Module API object.
 */
function _registerPlannerService(api) {
    if (!api?.services) return;
    if (!api.services.has("planner")) {
        const planner = createPlannerService({ api });
        // Issue #404: replace the assault skeleton with the real preset.
        registerAssaultPreset(planner);
        api.services.register("planner", planner);
    }
}

/**
 * Show a single GM-facing notification for an incompatible environment.
 * @param {{reason: string, expected: string, actual: string|null}} compatibility
 */
function _notifyIncompatibleOnce(compatibility) {
    const key = {
        [COMPATIBILITY_REASONS.wrongSystem]: "OWAI.Notifications.WrongSystem",
        [COMPATIBILITY_REASONS.apiMissing]: "OWAI.Notifications.ApiMissing",
        [COMPATIBILITY_REASONS.versionMismatch]: "OWAI.Notifications.VersionMismatch"
    }[compatibility.reason] ?? "OWAI.Notifications.ApiMissing";

    const message = game.i18n?.format?.(key, {
        expected: compatibility.expected,
        actual: compatibility.actual ?? "—"
    }) ?? `Only War AI disabled (${compatibility.reason})`;

    // `warn` type deduplicates visually; only GMs can act on module problems.
    ui.notifications?.warn?.(message, { permanent: true, localize: false });
}
