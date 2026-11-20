/**
 * Shared module state helpers.
 *
 * The `ready` hook flips `api._state.enabled` after the system compatibility
 * check. UI hooks consult {@link isModuleEnabled} so injected controls never
 * appear when the module stayed disabled.
 */
import { MODULE_ID } from "./constants.js";
import { isMasterEnabled } from "./settings.js";

/**
 * Whether the module may run AI logic this session: the system
 * compatibility check passed on `ready` AND the GM master switch
 * (`masterEnabled` world setting) is on.
 * @returns {boolean}
 */
export function isModuleEnabled() {
    return game.modules.get(MODULE_ID)?.api?.enabled === true
        && isMasterEnabled();
}
