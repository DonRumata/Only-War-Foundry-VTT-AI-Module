/**
 * Combat tracker context menu for the temporary Combatant override
 * (issue #399).
 *
 * Adds "Only War AI" entries to the combatant row context menu so the GM can
 * enable a preset, disable AI or return to inherit for this combat only
 * (`flags["only-war-ai"].override`).
 */
import {
    AI_PRESETS,
    FLAG_KEYS,
    MODULE_ID
} from "../constants.js";
import { isModuleEnabled } from "../module-state.js";

/** Register the combat tracker context menu hook. Called on `init`. */
export function registerCombatTrackerControls() {
    Hooks.on("getCombatTrackerEntryContext", (_html, menu) => {
        // AI controls are GM-only: a player client never sees them, just
        // like the preview dialog.
        if (!isModuleEnabled() || !game.user?.isGM) return;
        if (!Array.isArray(menu)) return;

        menu.push({
            name: _localize("OWAI.Context.Inherit"),
            icon: '<i class="fas fa-link"></i>',
            condition: li => _combatantFrom(li) !== null,
            callback: li => _setOverride(li, { mode: "inherit", preset: null })
        });

        for (const preset of AI_PRESETS) {
            menu.push({
                name: _localize(`OWAI.Context.Enable.${preset}`),
                icon: '<i class="fas fa-robot"></i>',
                condition: li => _combatantFrom(li) !== null,
                callback: li => _setOverride(li, { mode: "enabled", preset })
            });
        }

        menu.push({
            name: _localize("OWAI.Context.Disable"),
            icon: '<i class="fas fa-ban"></i>',
            condition: li => _combatantFrom(li) !== null,
            callback: li => _setOverride(li, { mode: "disabled", preset: null })
        });
    });
}

/**
 * Resolve the Combatant document for a context-menu list element.
 * @param {jQuery|HTMLElement} li
 * @returns {object|null}
 */
function _combatantFrom(li) {
    const element = li instanceof HTMLElement ? li : li?.[0];
    const id = element?.dataset?.combatantId
        ?? element?.dataset?.combatantid
        ?? element?.dataset?.documentId;
    const combatant = id ? game.combat?.combatants?.get(id) : null;
    return combatant ?? null;
}

/**
 * Persist the temporary override flag on the combatant.
 * @param {jQuery|HTMLElement} li
 * @param {{mode: string, preset: string|null}} override
 */
async function _setOverride(li, override) {
    const combatant = _combatantFrom(li);
    if (!combatant) return;
    try {
        await combatant.setFlag(MODULE_ID, FLAG_KEYS.override, override);
    } catch(err) {
        console.error(`${MODULE_ID} | Failed to set combatant override`, err);
    }
}

/**
 * Localize a key, tolerating early init states.
 * @param {string} key
 * @returns {string}
 */
function _localize(key) {
    return game.i18n?.localize?.(key) ?? key;
}
