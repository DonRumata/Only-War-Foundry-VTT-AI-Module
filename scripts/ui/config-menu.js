/**
 * Module settings menu (issue #399).
 *
 * Registers a GM-only menu via `game.settings.registerMenu`. The menu renders
 * `templates/config-menu.hbs` with the current world settings summary and a
 * housekeeping action that clears all temporary Combatant overrides in the
 * active combat.
 */
import {
    AI_PRESETS,
    FLAG_KEYS,
    MODULE_ID
} from "../constants.js";
import { getExecutionMode, isDiagnosticsEnabled } from "../settings.js";

/** Register the settings menu. Called on `init`; skips cleanly on old Foundry. */
export function registerConfigMenu() {
    const FormApplicationBase = foundry?.appv1?.api?.FormApplication
        ?? globalThis.FormApplication
        ?? null;
    if (!FormApplicationBase || !game?.settings?.registerMenu) {
        console.warn(`${MODULE_ID} | FormApplication unavailable; settings menu not registered`);
        return;
    }

    class OnlyWarAIConfigMenu extends FormApplicationBase {
        /** @inheritdoc */
        static get defaultOptions() {
            return foundry.utils.mergeObject(super.defaultOptions, {
                id: "only-war-ai-config",
                title: game.i18n.localize("OWAI.Settings.Menu.Title"),
                template: `modules/${MODULE_ID}/templates/config-menu.hbs`,
                width: 520,
                height: "auto",
                closeOnSubmit: true
            });
        }

        /** @inheritdoc */
        getData() {
            const combat = game.combat;
            const overrides = combat
                ? combat.combatants
                    .filter(c => c.getFlag?.(MODULE_ID, FLAG_KEYS.override))
                    .map(c => ({ id: c.id, name: c.name }))
                : [];
            return {
                executionMode: getExecutionMode(),
                diagnosticsEnabled: isDiagnosticsEnabled(),
                presets: AI_PRESETS,
                combatName: combat?.name ?? null,
                combatantOverrides: overrides
            };
        }

        /** @inheritdoc */
        activateListeners(html) {
            super.activateListeners(html);
            html.find("[data-action=clear-combatant-overrides]").on("click", async event => {
                event.preventDefault();
                await _clearCombatantOverrides();
                this.render();
            });
        }

        /** @inheritdoc */
        async _updateObject(_event, _formData) {
            // Display-only menu; world settings are edited via the standard
            // settings panel entries registered in settings.js.
        }
    }

    game.settings.registerMenu(MODULE_ID, "configMenu", {
        name: "OWAI.Settings.Menu.Name",
        label: "OWAI.Settings.Menu.Label",
        hint: "OWAI.Settings.Menu.Hint",
        icon: "fas fa-robot",
        type: OnlyWarAIConfigMenu,
        restricted: true
    });
}

/**
 * Remove the temporary `override` flag from every combatant of the active
 * combat.
 * @returns {Promise<number>} Number of cleared combatants.
 */
async function _clearCombatantOverrides() {
    const combat = game.combat;
    if (!combat) return 0;
    let cleared = 0;
    for (const combatant of combat.combatants) {
        if (!combatant.getFlag?.(MODULE_ID, FLAG_KEYS.override)) continue;
        try {
            if (typeof combatant.unsetFlag === "function") {
                await combatant.unsetFlag(MODULE_ID, FLAG_KEYS.override);
            } else {
                await combatant.setFlag(MODULE_ID, FLAG_KEYS.override, { mode: "inherit", preset: null });
            }
            cleared++;
        } catch(err) {
            console.error(`${MODULE_ID} | Failed to clear override for ${combatant.name}`, err);
        }
    }
    ui.notifications?.info?.(
        game.i18n.format("OWAI.Notifications.OverridesCleared", { count: cleared })
    );
    return cleared;
}
