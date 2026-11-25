import { AI_PRESETS, FALLBACK_PRESET } from "../constants.js";

export const SPEC_OPS_PRESET_ID = "specOps";
export const SPEC_OPS_FALLBACK_PRESETS = Object.freeze(AI_PRESETS.filter(id => id !== SPEC_OPS_PRESET_ID));

/** Default doctrine for all Spec Ops fireteams (issue #412). */
export const SPEC_OPS_CONFIG = Object.freeze({
    flankMinAngleDegrees: 60,
    maxDetachedRounds: 2,
    highThreatRatio: 2,
    supportWeight: 6,
    flankWeight: 8,
    assaultWeight: 7,
    cohesionWeight: 10,
    // Issue #87: interdiction-screen trigger gates. `confidenceMin` is the
    // pure-shooter ratio `rangedEV / (rangedEV + meleeEV)`, `minRangedEV`
    // the damage floor of trigger A and `chargerConfidenceMin` the
    // melee-orientation ratio of trigger B.
    interdictConfidenceMin: 0.7,
    interdictMinRangedEV: 6,
    interdictChargerConfidenceMin: 0.5,
    fallbackPreset: FALLBACK_PRESET
});

const weightRange = Object.freeze({ min: 0, max: 20, step: 0.5 });
const ratioRange = Object.freeze({ min: 0, max: 1, step: 0.05 });
export const SPEC_OPS_NUMERIC_RANGES = Object.freeze({
    flankMinAngleDegrees: Object.freeze({ min: 1, max: 180, step: 1 }),
    maxDetachedRounds: Object.freeze({ min: 0, max: 10, step: 1 }),
    highThreatRatio: Object.freeze({ min: 1, max: 10, step: 0.5 }),
    supportWeight: weightRange,
    flankWeight: weightRange,
    assaultWeight: weightRange,
    cohesionWeight: weightRange,
    interdictConfidenceMin: ratioRange,
    interdictMinRangedEV: Object.freeze({ min: 0, max: 30, step: 0.5 }),
    interdictChargerConfidenceMin: ratioRange
});

/**
 * Resolve each field independently: valid override, saved value, then default.
 * @param {object|null} [overrides] Explicit planning inputs.
 * @param {object|null} [stored] World settings.
 * @returns {object}
 */
export function resolveSpecOpsConfig(overrides = null, stored = null) {
    const result = { ...SPEC_OPS_CONFIG };
    for (const key of Object.keys(SPEC_OPS_CONFIG)) {
        for (const value of [overrides?.[key], stored?.[key]]) {
            const range = SPEC_OPS_NUMERIC_RANGES[key];
            const valid = range
                ? Number.isFinite(value) && value >= range.min && value <= range.max
                    && (key !== "maxDetachedRounds" || Number.isInteger(value))
                : SPEC_OPS_FALLBACK_PRESETS.includes(value);
            if (valid) {
                result[key] = value;
                break;
            }
        }
    }
    return result;
}
