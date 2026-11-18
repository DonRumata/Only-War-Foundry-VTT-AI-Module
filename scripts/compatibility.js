/**
 * Host system compatibility check (issue #399).
 *
 * The module requires the `only-war-local` system and the major version of the
 * public system API contract published as `game.darkHeresy.api` (issue #398).
 * The check is pure: it takes plain values and returns a result object so the
 * caller decides how to notify.
 */
import {
    REQUIRED_SYSTEM_API_MAJOR,
    REQUIRED_SYSTEM_ID
} from "./constants.js";

/** Stable reasons returned by {@link checkSystemCompatibility}. */
export const COMPATIBILITY_REASONS = Object.freeze({
    ok: "ok",
    wrongSystem: "wrong-system",
    apiMissing: "api-missing",
    versionMismatch: "version-mismatch"
});

/**
 * Check whether the module may activate against the current system.
 * @param {object} input
 * @param {string} [input.systemId] `game.system.id`.
 * @param {object} [input.api] `game.darkHeresy?.api` object or null.
 * @returns {{ok: boolean, reason: string, expected: string, actual: string|null}}
 */
export function checkSystemCompatibility({ systemId, api } = {}) {
    if (systemId !== REQUIRED_SYSTEM_ID) {
        return {
            ok: false,
            reason: COMPATIBILITY_REASONS.wrongSystem,
            expected: REQUIRED_SYSTEM_ID,
            actual: systemId ?? null
        };
    }
    if (!api || typeof api !== "object" || typeof api.version !== "string") {
        return {
            ok: false,
            reason: COMPATIBILITY_REASONS.apiMissing,
            expected: REQUIRED_SYSTEM_API_MAJOR,
            actual: null
        };
    }
    const major = api.version.split(".")[0];
    if (major !== REQUIRED_SYSTEM_API_MAJOR) {
        return {
            ok: false,
            reason: COMPATIBILITY_REASONS.versionMismatch,
            expected: REQUIRED_SYSTEM_API_MAJOR,
            actual: api.version
        };
    }
    return {
        ok: true,
        reason: COMPATIBILITY_REASONS.ok,
        expected: REQUIRED_SYSTEM_API_MAJOR,
        actual: api.version
    };
}
