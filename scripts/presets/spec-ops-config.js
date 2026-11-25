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
    // Issue #88: pincer selector thresholds. These are the `pincer*`
    // aliases the pure core in `scripts/presets/pincer.js` accepts — the
    // unprefixed canonical keys default inside the pure module, so only
    // the aliased forms live here.
    pincerMinMembers: 4,
    pincerMaxTravelMeters: 12,
    pincerMaxTravelFallbackPx: 1200,
    pincerEnemySpreadBasePx: 300,
    pincerEnemySpreadCohesionMultiplier: 2,
    pincerCorridorSeparationBasePx: 150,
    pincerCorridorSeparationGridMultiplier: 1.5,
    pincerCorridorSamples: 8,
    pincerMinRouteAngleDeg: 60,
    pincerRouteTrimFraction: 0.25,
    pincerFixMinRange: 10,
    pincerProbeMaxVisited: 2048,
    pincerMaxDetachedPhases: 2,
    pincerRouteProbe: true,
    pincerMinMorale: "pressured",
    pincerSync: "elastic",
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
    interdictChargerConfidenceMin: ratioRange,
    pincerMinMembers: Object.freeze({ min: 2, max: 12, step: 1 }),
    pincerMaxTravelMeters: Object.freeze({ min: 1, max: 60, step: 1 }),
    pincerMaxTravelFallbackPx: Object.freeze({ min: 100, max: 10000, step: 50 }),
    pincerEnemySpreadBasePx: Object.freeze({ min: 0, max: 2000, step: 10 }),
    pincerEnemySpreadCohesionMultiplier: Object.freeze({ min: 0, max: 10, step: 0.5 }),
    pincerCorridorSeparationBasePx: Object.freeze({ min: 0, max: 1000, step: 10 }),
    pincerCorridorSeparationGridMultiplier: Object.freeze({ min: 0, max: 10, step: 0.5 }),
    pincerCorridorSamples: Object.freeze({ min: 2, max: 32, step: 1 }),
    pincerMinRouteAngleDeg: Object.freeze({ min: 1, max: 180, step: 1 }),
    pincerRouteTrimFraction: Object.freeze({ min: 0, max: 0.5, step: 0.05 }),
    pincerFixMinRange: Object.freeze({ min: 0, max: 100, step: 1 }),
    pincerProbeMaxVisited: Object.freeze({ min: 1, max: 65536, step: 1 }),
    pincerMaxDetachedPhases: Object.freeze({ min: 0, max: 10, step: 1 })
});

/** Enum-validated string fields of the spec-ops config (issue #88). */
export const SPEC_OPS_ENUM_VALUES = Object.freeze({
    pincerMinMorale: Object.freeze(["desperate", "pressured", "confident"]),
    pincerSync: Object.freeze(["elastic", "strict"])
});

/** Boolean-validated fields of the spec-ops config (issue #88). */
export const SPEC_OPS_BOOLEAN_FIELDS = Object.freeze([
    "pincerRouteProbe"
]);

/**
 * Resolve each field independently: valid override, saved value, then default.
 * Enum fields accept one of their declared strings, boolean fields only
 * booleans, numeric ranges clamp to their declared bracket and the legacy
 * `fallbackPreset` keeps the preset-list validation.
 * @param {object|null} [overrides] Explicit planning inputs.
 * @param {object|null} [stored] World settings.
 * @returns {object}
 */
export function resolveSpecOpsConfig(overrides = null, stored = null) {
    const result = { ...SPEC_OPS_CONFIG };
    for (const key of Object.keys(SPEC_OPS_CONFIG)) {
        for (const value of [overrides?.[key], stored?.[key]]) {
            const range = SPEC_OPS_NUMERIC_RANGES[key];
            const enumValues = SPEC_OPS_ENUM_VALUES[key];
            const valid = enumValues
                ? enumValues.includes(value)
                : (SPEC_OPS_BOOLEAN_FIELDS.includes(key)
                    ? typeof value === "boolean"
                    : (range
                        ? Number.isFinite(value) && value >= range.min && value <= range.max
                            && (!["maxDetachedRounds", "pincerMinMembers", "pincerCorridorSamples",
                                "pincerProbeMaxVisited", "pincerMaxDetachedPhases"].includes(key)
                                || Number.isInteger(value))
                        : SPEC_OPS_FALLBACK_PRESETS.includes(value)));
            if (valid) {
                result[key] = value;
                break;
            }
        }
    }
    return result;
}
