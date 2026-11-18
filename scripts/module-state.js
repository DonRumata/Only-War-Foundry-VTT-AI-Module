/**
 * Shared module state helpers.
 *
 * The `ready` hook flips `api._state.enabled` after the system compatibility
 * check. UI hooks consult {@link isModuleEnabled} so injected controls never
 * appear when the module stayed disabled.
 */
import { MODULE_ID } from "./constants.js";

/**
 * Whether the module passed the system compatibility check on `ready`.
 * @returns {boolean}
 */
export function isModuleEnabled() {
    return game.modules.get(MODULE_ID)?.api?.enabled === true;
}
