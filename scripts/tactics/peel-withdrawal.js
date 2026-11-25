/**
 * Peel-withdrawal pure core (issue #89): a deterministic, stateless team
 * tactic selector for an organized fighting withdrawal.
 *
 * This module deliberately has no Foundry/runtime dependencies and never
 * reads `game`, mutates a Document or writes a flag.  Every world-dependent
 * answer (danger field, navigation, LOS, movement rates, threat centroid)
 * is injected as data or a read-only function.  The selector therefore can
 * be replayed from identical JSON input and produces a frozen,
 * JSON-serializable descriptor.
 *
 * Scope notes from the issue specification:
 * - System API v1.0 exposes no Disengage action.  The ordinary `withdraw`
 *   fallback is the primary path and pays an explicit free-attack utility
 *   cost; `disengage` is used only when structural capability data is
 *   injected by the caller.
 * - There is no peel latch or multi-round state machine.  Continuation is
 *   derived every round from committed morale, irreversible casualties,
 *   current danger/engagement and existing L1 withdrawal commitments.
 * - Assignments use the object form `{task, role}`; `stranded` members are
 *   diagnostics, never silent withdrawals or imaginary cover.
 */

/** Canonical tactic name used in TeamPlan descriptors. */
export const PEEL_WITHDRAWAL_NAME = "peel-withdrawal";

/** Stable trigger kinds in priority order. */
export const PEEL_TRIGGERS = Object.freeze({
    moraleDesperate: "morale-desperate",
    losses: "losses",
    closeThreat: "close-threat",
    continuation: "continuation"
});

/** Stable top-level rejection/degradation reasons of the pure selector. */
export const PEEL_REJECTIONS = Object.freeze({
    noMembers: "no-members",
    noThreats: "no-threats",
    noLeader: "no-leader",
    movementRatesUnavailable: "movement-rates-unavailable",
    navigationUnavailable: "navigation-unavailable",
    dangerUnavailable: "danger-unavailable",
    awayVectorDegenerate: "away-vector-degenerate",
    regroupInvalid: "regroup-invalid",
    regroupTrap: "regroup-trap",
    noTrigger: "no-trigger",
    noCover: "no-cover",
    noCoverAllEngaged: "no-cover-all-engaged",
    uncoveredMargin: "uncovered-margin",
    noWithdrawCapable: "no-withdraw-capable"
});

/** Stable candidate/member rejection reasons. */
export const PEEL_DETAIL_REASONS = Object.freeze({
    outOfBounds: "out-of-bounds",
    occupied: "occupied",
    invalidEndpoint: "invalid-endpoint",
    dangerTooHigh: "danger-too-high",
    dangerWorse: "danger-worse",
    nearbyThreat: "nearby-threat",
    insufficientGain: "insufficient-gain",
    noExactRoute: "no-exact-route",
    routeThroughEnemy: "route-through-enemy",
    routeThroughThreatCentroid: "route-through-threat-centroid",
    routeThroughReservation: "route-through-reservation",
    strandedStunned: "stranded-stunned",
    strandedPinnedNoSafeExit: "stranded-pinned-no-safe-exit",
    strandedUnavailable: "stranded-unavailable",
    strandedAlreadyActed: "stranded-already-acted",
    strandedNoRoute: "stranded-no-route",
    freeAttackMargin: "free-attack-margin",
    disengageEndpointEngagers: "disengage-endpoint-engagers"
});

/**
 * Experimental defaults fixed by the issue specification.  Every value may
 * be overridden for evaluation through `context.peel`, `context` itself or
 * `input.thresholds`; the resolved set is copied verbatim into breakdown.
 */
export const PEEL_DEFAULT_THRESHOLDS = Object.freeze({
    peelCasualtyRatio: 0.34,
    peelCasualtiesRecent: 2,
    peelCloseThreatDistance: 8,
    peelCloseThreatRatio: 1.5,
    peelDangerEnter: 0.65,
    peelDangerExit: 0.45,
    peelRegroupDangerMax: 0.35,
    peelRegroupThreatRadius: 6,
    peelMinWithdrawalGain: 4,
    peelFreeAttackMargin: 0.15,
    peelAllowUncovered: false,
    peelDefaultHitChance: 0.45,
    peelDefaultMeleeEV: 10,
    peelMeleeReach: 2,
    peelRegroupArriveRadius: 1,
    peelCommitmentRadius: 6,
    peelEnemyCellRadius: 0.5
});

/**
 * Free-attack mitigation by cover mode.  The specification fixes
 * suppression/overwatch/no-cover/disengage.  `direct` and `melee` are
 * deliberately neutral (`1`) in v1: they can remove or pin a pursuer in
 * play, but the pure cost model must not claim an unproven reaction or
 * status effect.  The resolved table is exposed in breakdown as part of
 * the experimental cost contract.
 */
export const PEEL_FREE_ATTACK_COVER_MULTIPLIERS = Object.freeze({
    suppression: 0.6,
    direct: 1,
    overwatch: 0.8,
    melee: 1,
    none: 1.15,
    disengage: 0
});

/** Cover modes in strict doctrine priority order. */
export const PEEL_COVER_MODES = Object.freeze([
    "suppression",
    "direct",
    "overwatch",
    "melee"
]);

const EPSILON = 1e-9;
const DEGREES_TO_RADIANS = Math.PI / 180;
const AWAY_ANGLES = Object.freeze([0, 30, -30, 60, -60]);
const AWAY_DISTANCE_MODES = Object.freeze(["half", "full", "extended"]);

/**
 * Numeric helper: value when finite, otherwise fallback.
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function _finiteOr(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}

/**
 * Round a finite number to the deterministic 1e-4 precision used in the
 * descriptor; non-finite values become null so the DTO stays JSON-safe.
 * @param {*} value
 * @returns {number|null}
 */
function _round(value) {
    return Number.isFinite(value) ? Math.round(value * 1e4) / 1e4 : null;
}

/**
 * Clamp a numeric value into `[0, 1]`.
 * @param {*} value
 * @returns {number}
 */
function _clamp01(value) {
    return Math.max(0, Math.min(1, _finiteOr(value, 0)));
}

/**
 * Whether a value is a finite point.
 * @param {*} point
 * @returns {boolean}
 */
function _isPoint(point) {
    return Number.isFinite(point?.x) && Number.isFinite(point?.y);
}

/**
 * Normalize a point-like object to a plain finite `{x, y}` or null.
 * @param {*} value
 * @returns {{x: number, y: number}|null}
 */
function _pointOf(value) {
    if (!value || typeof value !== "object") return null;
    const x = value.x ?? value.left;
    const y = value.y ?? value.top;
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/**
 * Deep-freeze helper for immutable results.
 * @param {*} value
 * @returns {*}
 */
function _deepFreeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        for (const key of Object.keys(value)) _deepFreeze(value[key]);
        Object.freeze(value);
    }
    return value;
}

/**
 * Normalize a Foundry collection/Map/array/iterable into a plain array.
 * @param {*} collection
 * @returns {object[]}
 */
function _list(collection) {
    if (!collection) return [];
    if (Array.isArray(collection)) return collection;
    if (Array.isArray(collection.contents)) return collection.contents;
    if (typeof collection.values === "function") return [...collection.values()];
    if (typeof collection[Symbol.iterator] === "function") return [...collection];
    return [];
}

/**
 * Deterministic stable JSON serializer for revision fingerprints.
 * @param {*} value
 * @returns {string}
 */
function _stableStringify(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(_stableStringify).join(",")}]`;
    const entries = Object.keys(value)
        .filter(key => value[key] !== undefined && typeof value[key] !== "function")
        .sort()
        .map(key => `${JSON.stringify(key)}:${_stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
}

/**
 * Deterministic 32-bit FNV-1a fingerprint used for regroup revisions.
 * @param {string} text
 * @returns {string}
 */
function _fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}

/**
 * Mean value of a simple damage spec.  Numbers pass through and simple
 * `XdY+Z` formulas evaluate to their mathematical mean; unknown payloads
 * are zero.
 * @param {*} value
 * @returns {number}
 */
function _expectedValue(value) {
    if (Number.isFinite(value)) return value;
    const formula = typeof value === "object" && value !== null ? value.formula : value;
    if (typeof formula !== "string") return 0;
    const trimmed = formula.trim();
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return numeric;
    const match = /^(\d*)d(\d+)\s*([+-]\s*\d+)?$/i.exec(trimmed);
    if (!match) return 0;
    const count = parseInt(match[1] || "1", 10);
    const faces = parseInt(match[2], 10);
    const bonus = match[3] ? parseInt(match[3].replace(/\s+/g, ""), 10) : 0;
    return ((count * (faces + 1)) / 2) + bonus;
}

/**
 * Grid conversion info.  When a Foundry grid is present, coordinates are
 * pixels and tactical distances are scene units; without grid info the
 * input is assumed to already use scene units as coordinates.
 * @param {object} input Selector input.
 * @returns {object|null}
 */
function _gridOf(input) {
    return input.grid ?? input.context?.grid ?? input.scene?.grid
        ?? input.combat?.scene?.grid ?? input.context?.scene?.grid ?? null;
}

/**
 * Coordinate units per scene unit.
 * @param {object|null} grid
 * @returns {number}
 */
function _coordinateScale(grid) {
    const size = _finiteOr(grid?.size, 0);
    const distance = _finiteOr(grid?.distance, 0);
    return size > 0 && distance > 0 ? size / distance : 1;
}

/**
 * Euclidean distance in scene units between two coordinate-space points.
 * @param {object|null} a
 * @param {object|null} b
 * @param {number} scale Coordinate units per scene unit.
 * @returns {number}
 */
function _distanceUnits(a, b, scale) {
    if (!_isPoint(a) || !_isPoint(b)) return Number.POSITIVE_INFINITY;
    return Math.hypot(b.x - a.x, b.y - a.y) / Math.max(EPSILON, scale);
}

/**
 * Distance from point `p` to segment `a → b` in scene units.
 * @param {object} a
 * @param {object} b
 * @param {object} p
 * @param {number} scale Coordinate units per scene unit.
 * @returns {number}
 */
function _segmentDistanceUnits(a, b, p, scale) {
    if (!_isPoint(a) || !_isPoint(b) || !_isPoint(p)) return Number.POSITIVE_INFINITY;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const lengthSquared = (vx * vx) + (vy * vy);
    if (!(lengthSquared > 0)) return _distanceUnits(a, p, scale);
    const t = Math.max(0, Math.min(1,
        (((p.x - a.x) * vx) + ((p.y - a.y) * vy)) / lengthSquared));
    const projection = { x: a.x + (t * vx), y: a.y + (t * vy) };
    return _distanceUnits(projection, p, scale);
}

/**
 * Centroid of positioned entries.
 * @param {object[]} entries Entries with `position` or direct x/y.
 * @returns {{x: number, y: number}|null}
 */
function _centroid(entries) {
    let x = 0;
    let y = 0;
    let count = 0;
    for (const entry of entries ?? []) {
        const point = _pointOf(entry?.position) ?? _pointOf(entry);
        if (!point) continue;
        x += point.x;
        y += point.y;
        count += 1;
    }
    return count ? { x: x / count, y: y / count } : null;
}

/**
 * Resolve the first explicitly defined boolean or value without treating
 * `false` as missing.
 * @param {...*} values Candidate values.
 * @returns {*}
 */
function _firstDefined(...values) {
    return values.find(value => value !== undefined);
}

/**
 * Normalize the threshold table.  Direct `context.peelCasualtyRatio`-style
 * overrides are intentionally accepted because these are the future world
 * setting names; `context.peel` and `input.thresholds` are the test and
 * pure-core injection forms.
 * @param {object} input Selector input.
 * @returns {object}
 */
function _thresholdsOf(input = {}) {
    const resolved = { ...PEEL_DEFAULT_THRESHOLDS };
    const overlays = [
        input.context?.peel,
        input.thresholds,
        Object.fromEntries(Object.keys(PEEL_DEFAULT_THRESHOLDS)
            .filter(key => input.context?.[key] !== undefined)
            .map(key => [key, input.context[key]])),
        Object.fromEntries(Object.keys(PEEL_DEFAULT_THRESHOLDS)
            .filter(key => input[key] !== undefined)
            .map(key => [key, input[key]]))
    ];
    for (const overlay of overlays) {
        if (!overlay || typeof overlay !== "object") continue;
        for (const key of Object.keys(PEEL_DEFAULT_THRESHOLDS)) {
            if (overlay[key] !== undefined) resolved[key] = overlay[key];
        }
    }
    for (const key of Object.keys(PEEL_DEFAULT_THRESHOLDS)) {
        if (key === "peelAllowUncovered") {
            resolved[key] = resolved[key] === true;
        } else {
            resolved[key] = _finiteOr(Number(resolved[key]), PEEL_DEFAULT_THRESHOLDS[key]);
        }
    }
    const multiplierOverlays = [
        input.context?.peel?.freeAttackCoverMultipliers,
        input.thresholds?.freeAttackCoverMultipliers,
        input.context?.freeAttackCoverMultipliers,
        input.freeAttackCoverMultipliers
    ];
    resolved.peelFreeAttackCoverMultipliers = { ...PEEL_FREE_ATTACK_COVER_MULTIPLIERS };
    for (const overlay of multiplierOverlays) {
        if (!overlay || typeof overlay !== "object") continue;
        for (const [mode, value] of Object.entries(overlay)) {
            if (mode in PEEL_FREE_ATTACK_COVER_MULTIPLIERS && Number.isFinite(value)) {
                resolved.peelFreeAttackCoverMultipliers[mode] = value;
            }
        }
    }
    resolved.experimental = true;
    return resolved;
}

/**
 * Status ids of a member, accepting arrays, Sets and Foundry status maps.
 * @param {object} raw Member-like entry.
 * @returns {string[]}
 */
function _statusIdsOf(raw) {
    const ids = new Set();
    const push = source => {
        if (!source) return;
        if (typeof source[Symbol.iterator] === "function") {
            for (const id of source) ids.add(String(id));
        } else if (typeof source === "object") {
            for (const key of Object.keys(source)) {
                if (source[key]) ids.add(String(key));
            }
        }
    };
    push(raw.statuses);
    push(raw.combatant?.statuses);
    push(raw.combatant?.actor?.statuses);
    push(raw.actor?.statuses);
    push(raw.token?.statuses);
    push(raw.combatant?.token?.statuses);
    return [...ids].sort();
}

/**
 * Normalize an identifier reference to a target/member for comparisons.
 * @param {*} value
 * @returns {string|null}
 */
function _idRef(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "string" || typeof value === "number") return String(value);
    if (typeof value === "object") {
        const id = value.tokenUuid ?? value.uuid ?? value.tokenId ?? value.combatantId ?? value.id;
        return id === null || id === undefined ? null : String(id);
    }
    return null;
}

/**
 * Normalize tactical threat/target records to plain positioned data.  The
 * input may be planner target rows or threat-map sources; only the fields
 * needed by the pure selector survive.
 * @param {object[]} threats Raw targets/threats.
 * @returns {object[]}
 */
function _normalizeThreats(threats) {
    const seen = new Set();
    const normalized = [];
    _list(threats).forEach((raw, index) => {
        const position = _pointOf(raw) ?? _pointOf(raw?.position);
        if (!position) return;
        const tokenId = raw.tokenId ?? raw.id ?? null;
        const tokenUuid = raw.tokenUuid ?? raw.uuid ?? (tokenId === null ? null : String(tokenId));
        const key = String(tokenUuid ?? tokenId ?? `threat-${index}`);
        if (seen.has(key)) return;
        seen.add(key);
        const emitters = _list(raw.emitters);
        const meleeEmitter = emitters
            .filter(emitter => emitter?.melee === true)
            .map(emitter => _expectedValue(emitter.ev ?? emitter.damage))
            .filter(value => value > 0)
            .sort((a, b) => b - a)[0];
        normalized.push({
            key,
            tokenId: tokenId === null || tokenId === undefined ? null : String(tokenId),
            tokenUuid: tokenUuid === null || tokenUuid === undefined ? null : String(tokenUuid),
            id: raw.id === null || raw.id === undefined ? null : String(raw.id),
            name: raw.name ?? null,
            x: position.x,
            y: position.y,
            source: raw.source ?? "visible",
            hidden: raw.hidden === true,
            canAttack: raw.canAttack !== false,
            weight: Number.isFinite(raw.weight) ? _clamp01(raw.weight) : null,
            threat: Number.isFinite(raw.threat) ? raw.threat : null,
            ev: _expectedValue(raw.ev ?? raw.damage ?? raw.threatProfile?.ev ?? 0) || null,
            meleeEV: _expectedValue(raw.meleeEV ?? raw.meleeEv ?? raw.meleeDamage ?? 0) || meleeEmitter || null,
            meleeReach: _finiteOr(raw.meleeReach ?? raw.reach, null),
            hitChance: _firstDefined(raw.hitChance, raw.weaponSkill, raw.ws, raw.weaponSkillPercent),
            engagedWith: _list(raw.engagedWith ?? raw.engages ?? raw.engagedMembers)
                .map(_idRef).filter(Boolean),
            raw
        });
    });
    return normalized.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Infer the knowledge weight of a target.  Engaged contacts count at at
 * least half weight even when their positional memory is stale.
 * @param {object} target Normalized target.
 * @param {boolean} engagedWithTeam Whether the target engages a member.
 * @returns {number}
 */
function _targetWeight(target, engagedWithTeam = false) {
    let weight = target.weight;
    if (!Number.isFinite(weight)) {
        switch (target.source) {
            case "last-known": weight = 0.5; break;
            case "team-contact":
            case "relay":
            case "intel": weight = 0.25; break;
            default: weight = 1;
        }
    }
    if (engagedWithTeam) weight = Math.max(weight, 0.5);
    return _clamp01(weight);
}

/**
 * Compute the weighted centroid of known threat sources.  The weight is
 * the maximum of emitter/EV contribution, explicit threat value normalized
 * as a utility and memory/knowledge weight — deterministic, explainable and
 * independent of any threat-map service implementation.
 * @param {object[]} threats Raw or normalized threat entries.
 * @param {object} [options]
 * @param {number} [options.evReference] EV mapping to contribution 1.
 * @returns {{x: number, y: number, sourceCount: number, weight: number}|null}
 */
export function computeThreatCentroid(threats = [], { evReference = 15 } = {}) {
    let x = 0;
    let y = 0;
    let total = 0;
    let count = 0;
    for (const raw of _list(threats)) {
        const point = _pointOf(raw) ?? _pointOf(raw?.position);
        if (!point) continue;
        const emitters = _list(raw.emitters);
        const bestEmitter = Math.max(0, ...emitters.map(emitter =>
            _expectedValue(emitter?.ev ?? emitter?.damage ?? 0)));
        const evContribution = Math.max(_expectedValue(raw.ev ?? raw.damage ?? 0), bestEmitter) / evReference;
        const explicitThreat = Number.isFinite(raw.threat)
            ? (raw.threat > 1 ? raw.threat / evReference : raw.threat) : 0;
        const memoryWeight = Number.isFinite(raw.weight) ? _clamp01(raw.weight)
            : raw.source === "last-known" ? 0.5
                : ["team-contact", "relay", "intel"].includes(raw.source) ? 0.25 : 1;
        const weight = Math.max(0, evContribution, explicitThreat, memoryWeight);
        if (!(weight > 0)) continue;
        x += point.x * weight;
        y += point.y * weight;
        total += weight;
        count += 1;
    }
    if (!(total > 0)) return null;
    return {
        x: Math.round((x / total) * 1e4) / 1e4,
        y: Math.round((y / total) * 1e4) / 1e4,
        sourceCount: count,
        weight: Math.round(total * 1e4) / 1e4
    };
}

/**
 * Structural Disengage capability detection.  No UI label parsing is used:
 * an action must carry `kind`, `id`, `attackType` or `actionType` equal to
 * `disengage`, or movement/action data must expose a `disengage` rate/cost.
 * In system API v1.0 this normally returns unavailable and the selector
 * stays on the ordinary-withdrawal fallback.
 * @param {*} subject Member, actor, action list or capability object.
 * @returns {{available: boolean, source: string|null, actionId: string|null, cost: object|null}}
 */
export function detectDisengageCapability(subject) {
    const unavailable = { available: false, source: null, actionId: null, cost: null };
    if (!subject) return unavailable;
    if (Array.isArray(subject)) {
        const action = subject.find(entry => entry && entry.available !== false
            && [entry.kind, entry.id, entry.attackType, entry.actionType]
                .map(value => String(value ?? "").toLowerCase())
                .includes("disengage"));
        return action
            ? {
                available: true,
                source: "actions",
                actionId: action.uuid ?? action.id ?? action.name ?? "disengage",
                cost: action.cost ?? null
            }
            : unavailable;
    }
    const capabilities = subject.capabilities ?? subject.coverCapabilities ?? {};
    if (capabilities.disengage === true || subject.disengageCapable === true) {
        return {
            available: true,
            source: "capability",
            actionId: "disengage",
            cost: capabilities.disengageCost ?? subject.disengageCost ?? null
        };
    }
    const movement = subject.movement ?? subject.rates ?? subject.actor?.system?.movement
        ?? subject.combatant?.actor?.system?.movement ?? null;
    if (movement && (movement.disengage !== undefined || movement.disengageCost !== undefined)) {
        return {
            available: true,
            source: "movement",
            actionId: "disengage",
            cost: movement.disengageCost ?? movement.disengage ?? null
        };
    }
    const actions = subject.actions ?? subject.actor?.actions ?? subject.combatant?.actor?.actions ?? null;
    return Array.isArray(actions) ? detectDisengageCapability(actions) : unavailable;
}

/**
 * Member weapon/cover capability summary.  Explicit normalized fields win;
 * structural action/item data is only read, never resolved through system
 * internals.  Unknown LOS remains null and is resolved against injected
 * perception evidence at cover selection time.
 * @param {object} raw Raw member entry.
 * @param {object} extra Normalizer-hook fields.
 * @returns {object}
 */
function _capabilitiesOf(raw, extra) {
    const actor = raw.actor ?? raw.combatant?.actor ?? raw.token?.actor
        ?? raw.combatant?.token?.actor ?? null;
    const explicit = {
        ...(raw.capabilities ?? {}),
        ...(raw.coverCapabilities ?? {}),
        ...(extra.capabilities ?? {}),
        ...(extra.coverCapabilities ?? {})
    };
    const actions = _list(raw.actions ?? extra.actions ?? actor?.actions);
    const items = _list(actor?.items);
    const hasAction = names => actions.some(action => action && action.available !== false
        && names.includes(String(action.attackType ?? action.kind ?? action.id ?? "").toLowerCase()));
    const rangedItem = items.find(item => item?.type === "weapon"
        && String(item.system?.class ?? "").toLowerCase() !== "melee");
    const meleeItem = items.find(item => item?.type === "weapon"
        && String(item.system?.class ?? "").toLowerCase() === "melee");
    const direct = _firstDefined(
        explicit.direct, explicit.directCapable, raw.directCapable, raw.hasRangedAttack,
        raw.hasRanged, raw.canShoot,
        rangedItem ? true : (hasAction(["standard", "semi_auto", "full_auto", "called_shot"]) ? true : undefined),
        false);
    const fullAutoItem = items.some(item => item?.type === "weapon"
        && String(item.system?.class ?? "").toLowerCase() !== "melee"
        && Number(item.system?.rateOfFire?.full) > 0);
    const suppression = _firstDefined(
        explicit.suppression, explicit.suppressionCapable, raw.suppressionCapable,
        hasAction(["suppressing_fire"]) ? true : undefined,
        fullAutoItem ? true : undefined,
        false);
    const melee = _firstDefined(
        explicit.melee, explicit.meleeCapable, raw.meleeCapable, raw.hasMelee,
        meleeItem ? true : (hasAction(["all_out", "charge", "swift", "lightning"]) ? true : undefined),
        false);
    const clipValues = items
        .filter(item => item?.type === "weapon")
        .map(item => item.system?.clip?.value)
        .filter(Number.isFinite);
    const ammo = _firstDefined(
        explicit.ammo, explicit.hasAmmo, raw.hasAmmo, raw.ammo,
        clipValues.length ? clipValues.some(value => value > 0) : undefined,
        direct === true || suppression === true);
    const overwatch = _firstDefined(
        explicit.overwatch, explicit.overwatchCapable, raw.overwatchCapable,
        direct === true || suppression === true ? true : undefined,
        false);
    const los = _firstDefined(explicit.los, explicit.hasLos, raw.hasLos, raw.los, null);
    const lane = {
        ...(raw.cover?.lane ?? {}),
        ...(raw.laneCover ?? {}),
        ...(explicit.lane ?? {})
    };
    return {
        suppression: suppression === true,
        direct: direct === true,
        overwatch: overwatch === true,
        melee: melee === true,
        ammo: ammo === true,
        los: typeof los === "boolean" ? los : null,
        lane
    };
}

/**
 * Normalize member entries without retaining their data in the output.
 * A caller may inject `normalizeMember(member)` to supply open integration
 * details such as initiative/already-acted semantics; returned plain fields
 * are merged over the raw entry.
 * @param {object[]} members Raw member entries.
 * @param {object} input Selector input.
 * @returns {object[]}
 */
function _normalizeMembers(members, input) {
    const normalizeMember = input.normalizeMember ?? input.context?.normalizeMember;
    const normalized = _list(members).map((raw, index) => {
        let extra = {};
        if (typeof normalizeMember === "function") {
            try {
                extra = normalizeMember(raw) ?? {};
            } catch(_err) {
                extra = {};
            }
        }
        const merged = { ...(raw ?? {}), ...extra };
        const combatant = raw?.combatant ?? merged.combatant
            ?? (raw?.documentName === "Combatant" ? raw : null);
        const token = raw?.token ?? merged.token ?? combatant?.token ?? null;
        const actor = raw?.actor ?? merged.actor ?? combatant?.actor ?? token?.actor ?? null;
        const combatantId = merged.combatantId ?? combatant?.id ?? raw?.id ?? `member-${index}`;
        const tokenDoc = token?.document ?? token ?? null;
        const position = _pointOf(merged.position) ?? _pointOf(raw?.position)
            ?? _pointOf(merged) ?? _pointOf(raw) ?? _pointOf(tokenDoc);
        const statuses = [...new Set([
            ..._statusIdsOf(raw ?? {}),
            ..._statusIdsOf(merged)
        ])].sort();
        const pinned = merged.pinned === true || statuses.includes("pinned");
        const stunned = merged.stunned === true || statuses.includes("stunned");
        const defeated = merged.defeated === true || combatant?.defeated === true
            || statuses.includes("dead") || statuses.includes("destroyed");
        const incapacitated = merged.incapacitated === true || statuses.includes("unconscious")
            || statuses.includes("incapacitated");
        const unavailable = merged.unavailable === true || merged.enabled === false
            || combatant?.enabled === false;
        const alreadyActed = merged.alreadyActed === true || merged.hasActed === true
            || merged.acted === true || combatant?.alreadyActed === true || combatant?.hasActed === true;
        const engagers = _list(merged.engagers ?? raw?.engagers).map(_idRef).filter(Boolean);
        const capabilities = _capabilitiesOf({ ...(raw ?? {}), ...merged, actor, token, combatant }, extra);
        const movement = merged.movement ?? merged.rates ?? raw?.movement ?? raw?.rates
            ?? actor?.system?.movement ?? null;
        const disengage = detectDisengageCapability({ ...(raw ?? {}), ...merged, actor, combatant });
        return {
            combatantId: String(combatantId),
            tokenId: merged.tokenId ?? combatant?.tokenId ?? tokenDoc?.id ?? null,
            tokenUuid: merged.tokenUuid ?? tokenDoc?.uuid ?? null,
            position,
            statuses,
            pinned,
            stunned,
            defeated,
            incapacitated,
            unavailable,
            alreadyActed,
            engagedAtStart: merged.engagedAtStart === true || merged.engaged === true || engagers.length > 0,
            engagers,
            reactionUsed: (() => {
                const record = _firstDefined(merged.reactionUsed, merged.reaction?.used, false);
                if (record === true) return true;
                if (record && typeof record === "object") return record.active !== false && record.used !== false;
                return false;
            })(),
            capabilities,
            movement,
            disengage,
            leader: merged.leader === true || merged.isLeader === true,
            withdrawalCommitment: _firstDefined(
                merged.withdrawalCommitment, raw?.withdrawalCommitment, merged.commitment, raw?.commitment),
            combatant,
            token: tokenDoc,
            actor,
            raw
        };
    });
    return normalized.sort((a, b) => a.combatantId.localeCompare(b.combatantId));
}

/**
 * Resolve member ids used for engagement comparisons.
 * @param {object} member Normalized member.
 * @returns {Set<string>}
 */
function _memberIds(member) {
    return new Set([
        member.combatantId,
        member.tokenId,
        member.tokenUuid,
        member.actor?.id,
        member.raw?.id
    ].filter(value => value !== null && value !== undefined).map(String));
}

/**
 * Resolve target references in `member.engagers` plus reverse references on
 * targets (`target.engagedWith`) to normalized target rows.
 * @param {object} member Normalized member.
 * @param {object[]} threats Normalized threats.
 * @returns {object[]}
 */
function _engagersOf(member, threats) {
    const ids = _memberIds(member);
    const byRef = new Map();
    for (const target of threats ?? []) {
        for (const ref of [target.key, target.tokenId, target.tokenUuid, target.id].filter(Boolean)) {
            byRef.set(String(ref), target);
        }
    }
    const result = new Map();
    for (const ref of member.engagers ?? []) {
        const target = byRef.get(String(ref));
        if (target) result.set(target.key, target);
    }
    for (const target of threats ?? []) {
        if ((target.engagedWith ?? []).some(ref => ids.has(String(ref)))) {
            result.set(target.key, target);
        }
    }
    return [...result.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Normalize movement rates.  At least half/full are required because the
 * geometric fan is specified in those units.
 * @param {*} value
 * @returns {object|null}
 */
function _normalizeRates(value) {
    if (!value || typeof value !== "object") return null;
    const rates = {
        half: Number(value.half) || 0,
        full: Number(value.full) || 0,
        charge: Number(value.charge) || 0,
        run: Number(value.run) || 0
    };
    return rates.half > 0 && rates.full > 0 ? rates : null;
}

/**
 * Resolve the reference movement rates for candidate generation.
 * @param {object} input Selector input.
 * @param {object[]} members Normalized members.
 * @returns {object|null}
 */
function _ratesOf(input, members) {
    const direct = _normalizeRates(input.rates ?? input.context?.rates);
    if (direct) return direct;
    const reference = members.find(member => member.combatantId === input.leaderId)
        ?? members.find(member => member.leader)
        ?? members[0];
    return _normalizeRates(reference?.movement);
}

/**
 * Resolve the read-only danger function injected directly or exposed by a
 * threat-map service/current map.
 * @param {object} input Selector input.
 * @returns {Function|null}
 */
function _dangerAtOf(input) {
    if (typeof input.dangerAt === "function") return input.dangerAt;
    if (typeof input.context?.dangerAt === "function") return input.context.dangerAt;
    const threatMap = input.threatMap ?? input.context?.threatMap ?? null;
    if (typeof threatMap?.dangerAt === "function") return point => threatMap.dangerAt(point);
    if (typeof threatMap?.map === "function") {
        try {
            const map = threatMap.map();
            if (typeof map?.dangerAt === "function") return point => map.dangerAt(point);
        } catch(_err) {
            return null;
        }
    }
    return null;
}

/**
 * Call the injected danger function defensively and normalize to 0..1.
 * @param {Function|null} dangerAt
 * @param {object|null} point
 * @returns {number|null}
 */
function _dangerAt(dangerAt, point) {
    if (typeof dangerAt !== "function" || !_isPoint(point)) return null;
    try {
        const value = dangerAt({ x: point.x, y: point.y });
        return Number.isFinite(value) ? _clamp01(value) : null;
    } catch(_err) {
        return null;
    }
}

/**
 * Determine team center: explicit injection, live leader position, then
 * member centroid.  The source is returned for explainability.
 * @param {object} input Selector input.
 * @param {object[]} members Living members.
 * @returns {{point: object|null, source: string|null, leader: object|null}}
 */
function _teamCenterOf(input, members) {
    const injected = _pointOf(input.teamCenter ?? input.context?.teamCenter);
    if (injected) {
        return { point: injected, source: "injected", leader: null };
    }
    const leader = members.find(member => member.combatantId === input.leaderId && member.position)
        ?? members.find(member => member.leader && member.position) ?? null;
    if (leader) return { point: leader.position, source: "leader", leader };
    return { point: _centroid(members), source: "centroid", leader: null };
}

/**
 * Normalize casualty counters from the selector input and morale record.
 * @param {object} input Selector input.
 * @param {number} livingCount Living member count.
 * @returns {{total: number, recent: number, initialStrength: number}}
 */
function _casualtiesOf(input, livingCount) {
    const raw = input.casualties;
    const counters = input.moraleInfo?.counters ?? input.moraleInfo?.record?.counters ?? {};
    const total = Math.max(0, _finiteOr(
        typeof raw === "number" ? raw : raw?.total ?? raw?.casualties,
        _finiteOr(counters.casualties, 0)));
    const recent = Math.max(0, _finiteOr(
        typeof raw === "object" && raw !== null ? raw.recent ?? raw.casualtiesRecent : undefined,
        _finiteOr(input.casualtiesRecent ?? counters.casualtiesRecent, 0)));
    const initialStrength = Math.max(1, Math.round(_finiteOr(
        typeof raw === "object" && raw !== null ? raw.initialStrength : undefined,
        _finiteOr(input.initialStrength ?? counters.initialStrength, livingCount + total))));
    return { total, recent, initialStrength };
}

/**
 * Resolve team morale tier from the evaluated L2 data.  Explicit effective
 * team-tier forms win over the committed team tier; member exceptions are
 * intentionally not re-interpreted here.
 * @param {*} moraleInfo
 * @returns {string|null}
 */
function _teamMoraleTier(moraleInfo) {
    if (typeof moraleInfo === "string") return moraleInfo;
    if (!moraleInfo || typeof moraleInfo !== "object") return null;
    return moraleInfo.effectiveTeamTier ?? moraleInfo.effectiveTier ?? moraleInfo.tier
        ?? moraleInfo.record?.tier ?? moraleInfo.record?.state ?? moraleInfo.diagnostics?.tier
        ?? moraleInfo.state ?? null;
}

/**
 * Whether a target is currently in melee with any living team member,
 * either by explicit member references or reverse target references.
 * @param {object} target Normalized target.
 * @param {object[]} members Normalized members.
 * @returns {boolean}
 */
function _targetEngagesTeam(target, members) {
    return (members ?? []).some(member => _engagersOf(member, [target]).length > 0);
}

/**
 * Evaluate all trigger checks before mandatory-condition gating.
 * @param {object} input Selector input.
 * @param {object} state Normalized evaluation state.
 * @returns {object}
 */
function _triggerChecks(input, state) {
    const {
        livingMembers, threats, teamCenter, dangerAt, thresholds, scale
    } = state;
    const tier = _teamMoraleTier(input.moraleInfo ?? input.context?.moraleInfo ?? input.context?.morale);
    const casualties = _casualtiesOf(input, livingMembers.length);
    const casualtyRatio = casualties.total / casualties.initialStrength;
    const closeThreatDistance = thresholds.peelCloseThreatDistance;
    let closeEnemies = 0;
    const closeEntries = [];
    for (const threat of threats) {
        const engaged = _targetEngagesTeam(threat, livingMembers);
        const distance = _distanceUnits(threat, teamCenter, scale);
        const weight = _targetWeight(threat, engaged);
        const close = distance <= closeThreatDistance + EPSILON || engaged;
        if (close) closeEnemies += weight;
        closeEntries.push({
            key: threat.key,
            distance: _round(distance),
            weight: _round(weight),
            engaged,
            close
        });
    }
    closeEnemies = Math.round(closeEnemies * 1e4) / 1e4;
    const requiredCloseEnemies = Math.max(1,
        Math.ceil(thresholds.peelCloseThreatRatio * livingMembers.length));
    const centerDanger = _dangerAt(dangerAt, teamCenter);
    const lossesActive = casualtyRatio + EPSILON >= thresholds.peelCasualtyRatio
        || casualties.recent >= thresholds.peelCasualtiesRecent;
    return {
        moraleDesperate: {
            active: tier === "desperate",
            tier,
            threshold: "desperate"
        },
        losses: {
            active: lossesActive,
            casualties: casualties.total,
            casualtiesRecent: casualties.recent,
            initialStrength: casualties.initialStrength,
            ratio: _round(casualtyRatio),
            threshold: thresholds.peelCasualtyRatio,
            recentThreshold: thresholds.peelCasualtiesRecent
        },
        closeThreat: {
            active: closeEnemies + EPSILON >= requiredCloseEnemies
                && centerDanger !== null && centerDanger + EPSILON >= thresholds.peelDangerEnter,
            closeEnemies,
            required: requiredCloseEnemies,
            distanceThreshold: closeThreatDistance,
            ratioThreshold: thresholds.peelCloseThreatRatio,
            danger: _round(centerDanger),
            dangerThreshold: thresholds.peelDangerEnter,
            entries: closeEntries
        },
        centerDanger: _round(centerDanger),
        casualties
    };
}

/**
 * Select the primary trigger reason in deterministic doctrine priority.
 * @param {object} checks Trigger checks.
 * @returns {string|null}
 */
function _primaryTrigger(checks) {
    if (checks.moraleDesperate.active) return PEEL_TRIGGERS.moraleDesperate;
    if (checks.losses.active) return PEEL_TRIGGERS.losses;
    if (checks.closeThreat.active) return PEEL_TRIGGERS.closeThreat;
    return null;
}

/**
 * Resolve the token-like reference passed to injected navigation.  The
 * selector itself never depends on Document methods.
 * @param {object} member Normalized member.
 * @returns {*}
 */
function _navigationToken(member) {
    return member?.token ?? member?.combatant?.token ?? member?.combatant ?? member?.raw ?? null;
}

/**
 * Map endpoint validation failure reasons to stable peel detail reasons.
 * @param {*} reason
 * @returns {string}
 */
function _endpointReason(reason) {
    switch (reason) {
        case "endpoint-out-of-bounds":
        case "out-of-bounds": return PEEL_DETAIL_REASONS.outOfBounds;
        case "endpoint-occupied":
        case "occupied": return PEEL_DETAIL_REASONS.occupied;
        case "navigation-unavailable":
        case "scene-unavailable":
        case "gridless-unsupported": return PEEL_REJECTIONS.navigationUnavailable;
        default: return PEEL_DETAIL_REASONS.invalidEndpoint;
    }
}

/**
 * Validate one endpoint through the injected navigation service.
 * @param {object|null} navigation Injected navigation service.
 * @param {object} member Reference member.
 * @param {object} point Candidate point.
 * @param {object} [options] Read-only navigation options.
 * @returns {{valid: boolean, reason: string|null, raw: object|null}}
 */
function _validateEndpoint(navigation, member, point, options = {}) {
    if (typeof navigation?.validateEndpoint !== "function") {
        return { valid: false, reason: PEEL_REJECTIONS.navigationUnavailable, raw: null };
    }
    try {
        const result = navigation.validateEndpoint(_navigationToken(member), { x: point.x, y: point.y }, options);
        if (result === true) return { valid: true, reason: null, raw: { boolean: true } };
        if (result === false) {
            return { valid: false, reason: PEEL_DETAIL_REASONS.invalidEndpoint, raw: { boolean: false } };
        }
        const valid = result?.valid === true || (result?.status === "ok" && result?.valid !== false);
        return {
            valid,
            reason: valid ? null : _endpointReason(result?.reason),
            raw: result && typeof result === "object"
                ? { status: result.status ?? null, valid: result.valid === true, reason: result.reason ?? null }
                : null
        };
    } catch(_err) {
        return { valid: false, reason: PEEL_DETAIL_REASONS.invalidEndpoint, raw: null };
    }
}

/**
 * Probe an exact route through `planRoute` (preferred, because geometry is
 * inspectable) or `canReach` (accepted as a reachability oracle with only
 * straight-line conservatism available for crossing checks).
 * @param {object|null} navigation Injected navigation service.
 * @param {object} member Reference member.
 * @param {object} point Destination.
 * @param {number} budget Scene-unit validation budget.
 * @param {object} [options] Read-only navigation options.
 * @returns {object}
 */
function _probeRoute(navigation, member, point, budget, options = {}) {
    if (typeof navigation?.planRoute !== "function" && typeof navigation?.canReach !== "function") {
        return { exact: false, reason: PEEL_REJECTIONS.navigationUnavailable, cost: null, waypoints: null, proof: "none" };
    }
    try {
        if (typeof navigation.planRoute === "function") {
            const result = navigation.planRoute(_navigationToken(member), { x: point.x, y: point.y }, budget, options);
            const exact = result?.exact === true && result?.status !== "failed";
            const waypoints = Array.isArray(result?.waypoints)
                ? result.waypoints.map(_pointOf).filter(Boolean)
                : Array.isArray(result?.path) ? result.path.map(_pointOf).filter(Boolean) : null;
            return {
                exact,
                reason: exact ? null : (result?.reason ?? PEEL_DETAIL_REASONS.noExactRoute),
                cost: Number.isFinite(result?.cost) ? result.cost : null,
                waypoints,
                proof: waypoints?.length ? "route" : "endpoint-only"
            };
        }
        const result = navigation.canReach(_navigationToken(member), { x: point.x, y: point.y }, budget, options);
        const exact = result === true || result?.reachable === true
            || (result?.status === "ok" && result?.reachable !== false);
        return {
            exact,
            reason: exact ? null : (result?.reason ?? PEEL_DETAIL_REASONS.noExactRoute),
            cost: Number.isFinite(result?.cost) ? result.cost : null,
            waypoints: null,
            proof: "reachable-only"
        };
    } catch(_err) {
        return { exact: false, reason: PEEL_DETAIL_REASONS.noExactRoute, cost: null, waypoints: null, proof: "error" };
    }
}

/**
 * Rotate the away vector by degrees in coordinate space.
 * @param {object} vector Unit vector.
 * @param {number} degrees
 * @returns {object}
 */
function _rotate(vector, degrees) {
    const radians = degrees * DEGREES_TO_RADIANS;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return {
        x: (vector.x * cos) - (vector.y * sin),
        y: (vector.x * sin) + (vector.y * cos)
    };
}

/**
 * Normalize the deterministic retreat direction.
 * @param {object} input Selector input.
 * @param {object} teamCenter
 * @param {object} threatCentroid
 * @returns {{vector: object|null, source: string|null}}
 */
function _awayVectorOf(input, teamCenter, threatCentroid) {
    const explicit = input.away ?? input.context?.away ?? input.context?.retreatVector ?? null;
    const raw = _isPoint(explicit) ? explicit
        : _isPoint(teamCenter) && _isPoint(threatCentroid)
            ? { x: teamCenter.x - threatCentroid.x, y: teamCenter.y - threatCentroid.y }
            : null;
    if (!raw) return { vector: null, source: null };
    const length = Math.hypot(raw.x, raw.y);
    if (!(length > EPSILON)) return { vector: null, source: null };
    return {
        vector: { x: raw.x / length, y: raw.y / length },
        source: _isPoint(explicit) ? "injected" : "team-threat-centroid"
    };
}

/**
 * Legacy regroup candidates injected by the caller (`leader`/`centroid` in
 * the current fireteam service) plus the generated fan.
 * @param {object} input Selector input.
 * @param {object[]} members Normalized members.
 * @returns {object[]}
 */
function _legacyRegroupPoints(input, members) {
    let source = input.regroupPoints ?? input.context?.regroupPoints ?? null;
    if (typeof source === "function") {
        try {
            source = source(members, input.context ?? {});
        } catch(_err) {
            source = [];
        }
    }
    const points = _list(source).map((entry, index) => {
        const point = _pointOf(entry);
        return point ? { ...point, source: entry.source ?? `legacy-${index}` } : null;
    }).filter(Boolean);
    const single = _pointOf(input.regroupPoint ?? input.context?.regroupPoint);
    if (single) points.push({ ...single, source: "injected" });
    return points;
}

/**
 * Generate the deterministic candidate fan and legacy candidates.
 * @param {object} input Selector input.
 * @param {object} state Evaluation state.
 * @param {object} away Away vector.
 * @returns {object[]}
 */
function _regroupCandidates(input, state, away) {
    const candidates = [];
    let index = 0;
    const distances = {
        half: state.rates.half,
        full: state.rates.full,
        extended: state.rates.full * 1.5
    };
    for (const angle of AWAY_ANGLES) {
        const vector = _rotate(away.vector, angle);
        for (const mode of AWAY_DISTANCE_MODES) {
            const distance = distances[mode] * state.scale;
            candidates.push({
                index: index++,
                source: `away-${angle}-${mode}`,
                angle,
                distanceMode: mode,
                x: state.teamCenter.x + (vector.x * distance),
                y: state.teamCenter.y + (vector.y * distance),
                generated: true
            });
        }
    }
    for (const legacy of _legacyRegroupPoints(input, state.members)) {
        candidates.push({
            index: index++,
            source: legacy.source,
            angle: null,
            distanceMode: "legacy",
            x: legacy.x,
            y: legacy.y,
            generated: false
        });
    }
    return candidates;
}

/**
 * Whether a route (or its straight-line conservative fallback) crosses a
 * threat, the threat centroid or an explicit reservation.
 * @param {object[]} points Coordinate-space route points.
 * @param {object} state Evaluation state.
 * @param {object} threatCentroid
 * @returns {string|null}
 */
function _routeCrossingReason(points, state, threatCentroid) {
    const clean = (points ?? []).filter(_isPoint);
    if (clean.length < 2) return null;
    const radius = state.thresholds.peelEnemyCellRadius;
    const segments = [];
    for (let i = 0; i < clean.length - 1; i++) segments.push([clean[i], clean[i + 1]]);
    for (const threat of state.threats) {
        for (const [a, b] of segments) {
            if (_segmentDistanceUnits(a, b, threat, state.scale) <= radius + EPSILON) {
                return PEEL_DETAIL_REASONS.routeThroughEnemy;
            }
        }
    }
    for (const [a, b] of segments) {
        if (_isPoint(threatCentroid)
            && _segmentDistanceUnits(a, b, threatCentroid, state.scale) <= radius + EPSILON) {
            return PEEL_DETAIL_REASONS.routeThroughThreatCentroid;
        }
    }
    for (const reservation of _list(state.input.reservations ?? state.input.context?.reservations)) {
        const point = _pointOf(reservation?.point ?? reservation);
        if (!point) continue;
        for (const [a, b] of segments) {
            if (_segmentDistanceUnits(a, b, point, state.scale) <= radius + EPSILON) {
                return PEEL_DETAIL_REASONS.routeThroughReservation;
            }
        }
    }
    return null;
}

/**
 * Validate one regroup candidate and copy all independent rejection
 * evidence into its breakdown row.
 * @param {object} candidate Candidate point.
 * @param {object} state Evaluation state.
 * @returns {object}
 */
function _validateRegroupCandidate(candidate, state) {
    const rejections = [];
    const point = { x: candidate.x, y: candidate.y };
    const validationBudget = Math.max(state.rates.full, state.rates.run || state.rates.full);
    const endpoint = _validateEndpoint(state.navigation, state.referenceMember, point, {
        reservations: state.input.reservations ?? state.input.context?.reservations
    });
    let route = { exact: false, reason: "not-probed", cost: null, waypoints: null, proof: "none" };
    if (!endpoint.valid) {
        rejections.push(endpoint.reason ?? PEEL_DETAIL_REASONS.invalidEndpoint);
    } else {
        route = _probeRoute(state.navigation, state.referenceMember, point, validationBudget, {
            reservations: state.input.reservations ?? state.input.context?.reservations
        });
        if (!route.exact) {
            rejections.push(route.reason === PEEL_REJECTIONS.navigationUnavailable
                ? PEEL_REJECTIONS.navigationUnavailable
                : PEEL_DETAIL_REASONS.noExactRoute);
        }
    }

    const danger = _dangerAt(state.dangerAt, point);
    if (danger === null) {
        rejections.push(PEEL_REJECTIONS.dangerUnavailable);
    } else {
        if (danger > state.thresholds.peelRegroupDangerMax + EPSILON) {
            rejections.push(PEEL_DETAIL_REASONS.dangerTooHigh);
        }
        if (Number.isFinite(state.centerDanger) && danger > state.centerDanger + EPSILON) {
            rejections.push(PEEL_DETAIL_REASONS.dangerWorse);
        }
    }

    let nearestThreat = null;
    let nearestThreatDistance = Number.POSITIVE_INFINITY;
    for (const threat of state.threats) {
        const distance = _distanceUnits(point, threat, state.scale);
        if (distance < nearestThreatDistance) {
            nearestThreatDistance = distance;
            nearestThreat = threat;
        }
        const reach = _finiteOr(threat.meleeReach, state.thresholds.peelMeleeReach);
        if (distance <= Math.max(state.thresholds.peelRegroupThreatRadius, reach) + EPSILON) {
            rejections.push(PEEL_DETAIL_REASONS.nearbyThreat);
            break;
        }
    }

    const centerDistance = _distanceUnits(state.teamCenter, state.threatCentroid, state.scale);
    const candidateDistance = _distanceUnits(point, state.threatCentroid, state.scale);
    const gain = candidateDistance - centerDistance;
    if (!(gain + EPSILON >= state.thresholds.peelMinWithdrawalGain)) {
        rejections.push(PEEL_DETAIL_REASONS.insufficientGain);
    }

    if (endpoint.valid && route.exact) {
        const routePoints = route.waypoints?.length >= 2
            ? route.waypoints
            : [state.referenceMember.position, point].filter(_isPoint);
        const crossing = _routeCrossingReason(routePoints, state, state.threatCentroid);
        if (crossing) rejections.push(crossing);
    }

    const uniqueRejections = [...new Set(rejections.filter(Boolean))];
    return {
        index: candidate.index,
        source: candidate.source,
        angle: candidate.angle,
        distanceMode: candidate.distanceMode,
        generated: candidate.generated,
        x: _round(point.x),
        y: _round(point.y),
        danger: _round(danger),
        centerDistance: _round(centerDistance),
        threatDistance: _round(candidateDistance),
        distanceGain: _round(gain),
        nearestThreat: nearestThreat?.key ?? null,
        nearestThreatDistance: _round(nearestThreatDistance),
        routeCost: _round(route.cost),
        routeProof: route.proof,
        valid: uniqueRejections.length === 0,
        rejection: uniqueRejections[0] ?? null,
        rejections: uniqueRejections,
        selected: false,
        rank: null
    };
}

/**
 * Compare valid candidates by doctrine: lower danger, larger withdrawal
 * gain, cheaper exact route, then deterministic generation index.
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
function _compareRegroupCandidates(a, b) {
    return ((_finiteOr(a.danger, 1) - _finiteOr(b.danger, 1))
        || (_finiteOr(b.distanceGain, -Infinity) - _finiteOr(a.distanceGain, -Infinity))
        || (_finiteOr(a.routeCost, Number.POSITIVE_INFINITY) - _finiteOr(b.routeCost, Number.POSITIVE_INFINITY))
        || (a.index - b.index));
}

/**
 * Generate, validate and rank all regroup candidates.
 * @param {object} input Selector input.
 * @param {object} state Evaluation state.
 * @returns {object}
 */
function _evaluateRegroup(input, state) {
    if (!state.navigation || (typeof state.navigation.validateEndpoint !== "function"
        && typeof state.navigation.planRoute !== "function" && typeof state.navigation.canReach !== "function")) {
        return {
            selected: null,
            candidates: [],
            rejection: PEEL_REJECTIONS.navigationUnavailable,
            awayVector: null
        };
    }
    if (typeof state.dangerAt !== "function") {
        return {
            selected: null,
            candidates: [],
            rejection: PEEL_REJECTIONS.dangerUnavailable,
            awayVector: null
        };
    }
    const away = _awayVectorOf(input, state.teamCenter, state.threatCentroid);
    if (!away.vector) {
        return {
            selected: null,
            candidates: [],
            rejection: PEEL_REJECTIONS.awayVectorDegenerate,
            awayVector: null
        };
    }
    const generated = _regroupCandidates(input, state, away);
    const evaluated = generated.map(candidate => _validateRegroupCandidate(candidate, state));
    const valid = evaluated.filter(candidate => candidate.valid).sort(_compareRegroupCandidates);
    const rankByIndex = new Map(valid.map((candidate, rank) => [candidate.index, rank + 1]));
    const selectedIndex = valid[0]?.index ?? null;
    const rows = evaluated.map(candidate => ({
        ...candidate,
        selected: candidate.index === selectedIndex,
        rank: rankByIndex.get(candidate.index) ?? null
    }));
    const selectedRow = rows.find(candidate => candidate.selected) ?? null;
    let rejection = null;
    if (!selectedRow) {
        const trapReasons = new Set([
            PEEL_DETAIL_REASONS.dangerTooHigh,
            PEEL_DETAIL_REASONS.dangerWorse,
            PEEL_DETAIL_REASONS.nearbyThreat,
            PEEL_DETAIL_REASONS.routeThroughEnemy,
            PEEL_DETAIL_REASONS.routeThroughThreatCentroid
        ]);
        const trapEvidence = rows.length > 0
            && rows.every(row => row.rejections.some(reason => trapReasons.has(reason)));
        rejection = trapEvidence ? PEEL_REJECTIONS.regroupTrap : PEEL_REJECTIONS.regroupInvalid;
    }
    return {
        selected: selectedRow,
        candidates: rows,
        rejection,
        awayVector: {
            x: _round(away.vector.x),
            y: _round(away.vector.y),
            source: away.source
        }
    };
}

/**
 * Inspect an existing L1 commitment for a withdrawal move toward the same
 * regroup area.  This is read-only state derivation — no peel latch exists.
 * @param {object} member Normalized member.
 * @param {object} regroupPoint Selected regroup point.
 * @param {object} state Evaluation state.
 * @returns {boolean}
 */
function _hasWithdrawalCommitment(member, regroupPoint, state) {
    const direct = member.withdrawalCommitment;
    if (direct === true) return true;
    const record = direct && typeof direct === "object" ? direct
        : member.combatant?.flags?.["only-war-ai"]?.committedPlan ?? null;
    if (!record || typeof record !== "object") return false;
    if (record.active === false || record.status === "cancelled" || record.status === "completed"
        || record.status === "failed" || record.cancelledReason) {
        return false;
    }
    const radius = state.thresholds.peelCommitmentRadius;
    const near = point => {
        const normalized = _pointOf(point);
        return normalized && _distanceUnits(normalized, regroupPoint, state.scale) <= radius + EPSILON;
    };
    if (near(record.to) || near(record.regroupPoint) || near(record.objective?.regroupPoint)
        || near(record.objective?.point)) {
        return true;
    }
    const withdrawalWord = value => ["withdraw", "withdrawal", "disengage", "peel-withdrawal", "regroup"]
        .includes(String(value ?? "").toLowerCase());
    for (const step of _list(record.steps)) {
        if (step?.type !== "move") continue;
        const mode = step.input?.mode ?? step.input?.variant ?? step.variant ?? step.input?.objective?.type;
        if (!withdrawalWord(mode) && !withdrawalWord(record.objective?.type) && direct !== true) continue;
        if (near(step.to) || near(step.input?.to) || near(step.input?.destination)
            || near(_list(step.waypoints).at(-1))) {
            return true;
        }
    }
    return direct === true;
}

/**
 * Evaluate stateless continuation conditions after regroup selection.
 * @param {object} input Selector input.
 * @param {object} state Evaluation state.
 * @param {object} regroup Selected regroup row.
 * @param {object} checks Trigger checks.
 * @returns {object}
 */
function _continuationOf(input, state, regroup, checks) {
    const point = regroup ? { x: regroup.x, y: regroup.y } : null;
    const dangerWeak = Number.isFinite(state.centerDanger)
        && state.centerDanger + EPSILON >= state.thresholds.peelDangerExit;
    const enemyReach = state.livingMembers.some(member => {
        if (!member.position) return false;
        return state.threats.some(threat =>
            _distanceUnits(member.position, threat, state.scale)
                <= _finiteOr(threat.meleeReach, state.thresholds.peelMeleeReach) + EPSILON);
    });
    const casualtyPersistent = checks.losses.active === true;
    const commitment = Boolean(point) && state.livingMembers.some(member =>
        _hasWithdrawalCommitment(member, point, state));
    const distanceToRegroup = point
        ? _distanceUnits(state.teamCenter, point, state.scale) : Number.POSITIVE_INFINITY;
    const atRegroup = point
        && distanceToRegroup <= state.thresholds.peelRegroupArriveRadius + EPSILON;
    const weakConditions = {
        danger: dangerWeak,
        enemyReach,
        casualties: casualtyPersistent,
        commitment
    };
    const weakCount = Object.values(weakConditions).filter(Boolean).length;
    return {
        active: Boolean(point) && !atRegroup && weakCount > 0,
        weakConditions,
        weakCount,
        atRegroup: Boolean(atRegroup),
        distanceToRegroup: _round(distanceToRegroup),
        mode: "l2-morale/commitment/stateless",
        dangerExit: state.thresholds.peelDangerExit
    };
}

/**
 * Resolve member LOS evidence.  Explicit member capability/LOS data wins,
 * then an injected read-only probe, then shared attackable-target evidence.
 * @param {object} member Normalized member.
 * @param {object} state Evaluation state.
 * @returns {boolean}
 */
function _memberHasLos(member, state) {
    if (typeof member.capabilities.los === "boolean") return member.capabilities.los;
    const probe = state.input.hasLineOfSight ?? state.input.context?.hasLineOfSight
        ?? state.input.losProbe ?? state.input.context?.losProbe;
    if (typeof probe === "function") {
        try {
            const result = probe(member, state.threatCentroid, state.threats);
            if (typeof result === "boolean") return result;
        } catch(_err) {
            return false;
        }
    }
    return state.threats.some(target => target.canAttack === true && target.hidden !== true);
}

/**
 * Whether a cover candidate can perform a mode this round under the pure
 * capability contract.  Lane/template friendliness is injectable through
 * `capabilities.lane[mode]` because cone adjudication belongs to planner.
 * @param {object} member Normalized member.
 * @param {string} mode Cover mode.
 * @param {object} state Evaluation state.
 * @returns {{available: boolean, reasons: string[]}}
 */
function _coverModeAvailability(member, mode, state) {
    const reasons = [];
    const capabilities = member.capabilities;
    if (capabilities.lane?.[mode] === false) reasons.push("lane-unsafe");
    const los = _memberHasLos(member, state);
    if (!los && mode !== "melee") reasons.push("no-los");
    if (!capabilities.ammo && ["suppression", "direct"].includes(mode)) reasons.push("no-ammo");
    if (mode === "overwatch" && member.reactionUsed) reasons.push("reaction-used");
    if (mode === "suppression" && !capabilities.suppression) reasons.push("not-suppression-capable");
    if (mode === "direct" && !capabilities.direct) reasons.push("not-direct-capable");
    if (mode === "overwatch" && !capabilities.overwatch) reasons.push("not-overwatch-capable");
    if (mode === "melee" && !capabilities.melee) reasons.push("not-melee-capable");
    return { available: reasons.length === 0, reasons };
}

/**
 * Select the single canonical cover member by strict mode priority and a
 * deterministic low-risk/lane-position ordering.
 * @param {object[]} pool Active, unengaged, non-pinned members.
 * @param {object} state Evaluation state.
 * @param {object} regroup Selected regroup row.
 * @returns {object}
 */
function _selectCover(pool, state, regroup) {
    const laneFrom = state.threatCentroid;
    const laneTo = { x: regroup.x, y: regroup.y };
    const rows = pool.map(member => {
        const modes = Object.fromEntries(PEEL_COVER_MODES.map(mode => {
            const availability = _coverModeAvailability(member, mode, state);
            return [mode, { available: availability.available, reasons: availability.reasons }];
        }));
        const risk = _dangerAt(state.dangerAt, member.position) ?? 0;
        return {
            combatantId: member.combatantId,
            member,
            modes,
            laneDistance: _round(_segmentDistanceUnits(laneFrom, laneTo, member.position, state.scale)),
            risk: _round(risk)
        };
    });
    const candidateRows = rows.map(row => ({
        combatantId: row.combatantId,
        laneDistance: row.laneDistance,
        risk: row.risk,
        suppression: row.modes.suppression.available,
        direct: row.modes.direct.available,
        overwatch: row.modes.overwatch.available,
        melee: row.modes.melee.available,
        reasons: Object.fromEntries(PEEL_COVER_MODES.map(mode => [mode, row.modes[mode].reasons]))
    }));
    for (const mode of PEEL_COVER_MODES) {
        const capable = rows.filter(row => row.modes[mode].available)
            .sort((a, b) => (_finiteOr(a.risk, Infinity) - _finiteOr(b.risk, Infinity))
                || (_finiteOr(a.laneDistance, Infinity) - _finiteOr(b.laneDistance, Infinity))
                || a.combatantId.localeCompare(b.combatantId));
        if (!capable.length) continue;
        const chosen = capable[0];
        const nearest = state.threats
            .map(threat => ({
                threat,
                distance: _distanceUnits(threat, state.teamCenter, state.scale)
            }))
            .sort((a, b) => (a.distance - b.distance) || a.threat.key.localeCompare(b.threat.key))[0]?.threat ?? null;
        return {
            cover: {
                mode,
                members: [chosen.combatantId],
                reason: mode === "suppression" ? "suppression-preferred" : `${mode}-fallback`,
                target: nearest?.tokenUuid ?? nearest?.tokenId ?? nearest?.key ?? null,
                laneDistance: chosen.laneDistance,
                risk: chosen.risk,
                unpinSupport: 0
            },
            candidates: candidateRows,
            rejection: null
        };
    }
    let rejection = PEEL_REJECTIONS.noCover;
    if (!rows.length) rejection = PEEL_REJECTIONS.noCoverAllEngaged;
    else if (rows.every(row => row.modes.overwatch.reasons.includes("reaction-used")
        && !row.modes.suppression.available && !row.modes.direct.available && !row.modes.melee.available)) {
        rejection = "no-cover-reaction-used";
    } else if (rows.length) {
        rejection = "no-cover-capability";
    }
    return {
        cover: { mode: "none", members: [], reason: rejection, target: null, unpinSupport: 0 },
        candidates: candidateRows,
        rejection
    };
}

/**
 * Normalize hit chance from explicit probability or percentile weapon
 * skill; unknown profiles use the experimental default.
 * @param {object} threat Normalized threat.
 * @param {object} thresholds Resolved thresholds.
 * @returns {number}
 */
function _hitChanceOf(threat, thresholds) {
    const raw = threat.hitChance;
    if (Number.isFinite(raw)) {
        return _clamp01(raw > 1 ? raw / 100 : raw);
    }
    return thresholds.peelDefaultHitChance;
}

/**
 * Melee expected damage of an engager.  Unknown loadouts pessimistically
 * use the experimental default instead of pretending the exit is free.
 * @param {object} threat Normalized threat.
 * @param {object} thresholds Resolved thresholds.
 * @returns {number}
 */
function _meleeEvOf(threat, thresholds) {
    const value = _expectedValue(threat.meleeEV ?? threat.ev ?? 0);
    return value > 0 ? value : thresholds.peelDefaultMeleeEV;
}

/**
 * Count how many current engagers remain in melee reach at the common
 * regroup endpoint.
 * @param {object[]} engagers Engager target rows.
 * @param {object} endpoint Regroup endpoint.
 * @param {object} state Evaluation state.
 * @returns {number}
 */
function _engagersAtEndpoint(engagers, endpoint, state) {
    return engagers.filter(threat =>
        _distanceUnits(endpoint, threat, state.scale)
            <= _finiteOr(threat.meleeReach, state.thresholds.peelMeleeReach) + EPSILON).length;
}

/**
 * Explicit free-attack/stay-risk cost record for one potential withdrawer.
 * @param {object} member Normalized member.
 * @param {object[]} engagers Resolved engagers.
 * @param {object} endpoint Regroup endpoint.
 * @param {string} coverMode Selected cover mode (`none` when uncovered).
 * @param {object} state Evaluation state.
 * @returns {object}
 */
function _costForMember(member, engagers, endpoint, coverMode, state) {
    const thresholds = state.thresholds;
    const multipliers = thresholds.peelFreeAttackCoverMultipliers;
    const engaged = engagers.length > 0 || member.engagedAtStart;
    // An explicitly engaged member without resolvable engager rows still
    // has at least one unknown opponent in base contact.  Treat that
    // opponent pessimistically with the experimental default profile rather
    // than pricing the exit as free.
    const pressureSources = engaged ? (engagers.length ? engagers : [{}]) : [];
    const engagerCount = engaged ? Math.max(1, engagers.length) : 0;
    const basePressure = pressureSources.reduce((sum, threat) => sum
        + (_hitChanceOf(threat, thresholds) * Math.min(1, _meleeEvOf(threat, thresholds) / 15)), 0);
    const endpointEngagers = engaged && engagers.length
        ? _engagersAtEndpoint(engagers, endpoint, state) : 0;
    const reducesEngagers = !engaged
        || (engagers.length > 0 && endpointEngagers < engagerCount);
    const disengageAvailable = engaged && member.disengage.available === true;
    const disengageLegal = disengageAvailable && reducesEngagers;
    const multiplier = disengageLegal
        ? multipliers.disengage
        : multipliers[coverMode] ?? multipliers.none;
    const freeAttackRisk = disengageLegal
        ? 0
        : _clamp01(basePressure * multiplier);
    const selfDanger = _dangerAt(state.dangerAt, member.position) ?? 0;
    const endpointDanger = _dangerAt(state.dangerAt, endpoint) ?? 0;
    const stayRisk = selfDanger + basePressure;
    const margin = (stayRisk - endpointDanger) - freeAttackRisk;
    let mode = "fight-in-place";
    let decisionReason = PEEL_DETAIL_REASONS.freeAttackMargin;
    if (!engaged) {
        if (margin + EPSILON >= thresholds.peelFreeAttackMargin) {
            mode = "withdraw";
            decisionReason = "margin-pass";
        }
    } else if (disengageAvailable && !reducesEngagers) {
        if (margin + EPSILON >= thresholds.peelFreeAttackMargin) {
            mode = "withdraw";
            decisionReason = PEEL_DETAIL_REASONS.disengageEndpointEngagers;
        }
    } else if (margin + EPSILON >= thresholds.peelFreeAttackMargin) {
        mode = disengageLegal ? "disengage" : "withdraw";
        decisionReason = disengageLegal ? "disengage-capability" : "margin-pass";
    }
    return {
        combatantId: member.combatantId,
        engaged,
        engagers: engagers.map(threat => threat.tokenUuid ?? threat.tokenId ?? threat.key).filter(Boolean),
        freeAttackRisk: _round(freeAttackRisk),
        stayRisk: _round(stayRisk),
        endpointDanger: _round(endpointDanger),
        margin: _round(margin),
        threshold: thresholds.peelFreeAttackMargin,
        coverMode,
        coverMultiplier: _round(multiplier),
        basePressure: _round(basePressure),
        endpointEngagers,
        reducesEngagers,
        disengageAvailable,
        mode,
        actionCost: mode === "disengage" ? { halves: 2 } : null,
        movementCap: mode === "disengage" ? "half" : null,
        decisionReason
    };
}

/**
 * Whether a pinned-outside-melee route never approaches any enemy and the
 * endpoint is genuinely better for that member.
 * @param {object} member Normalized member.
 * @param {object} route Route probe.
 * @param {object} endpoint Regroup endpoint.
 * @param {object} state Evaluation state.
 * @returns {boolean}
 */
function _pinnedRouteSafe(member, route, endpoint, state) {
    if (!_isPoint(member.position)) return false;
    const routePoints = route.waypoints?.length >= 2
        ? route.waypoints
        : [member.position, endpoint];
    for (const threat of state.threats) {
        const startDistance = _distanceUnits(member.position, threat, state.scale);
        for (const point of routePoints) {
            if (_distanceUnits(point, threat, state.scale) < startDistance - EPSILON) return false;
        }
    }
    const selfDanger = _dangerAt(state.dangerAt, member.position) ?? 1;
    const endpointDanger = _dangerAt(state.dangerAt, endpoint) ?? 1;
    const startThreatDistance = _distanceUnits(member.position, state.threatCentroid, state.scale);
    const endpointThreatDistance = _distanceUnits(endpoint, state.threatCentroid, state.scale);
    return endpointDanger < selfDanger - EPSILON
        || endpointThreatDistance > startThreatDistance + EPSILON;
}

/**
 * Build an object whose keys are sorted by combatant id, preserving the
 * object-form assignment contract while making key order deterministic.
 * @param {Map<string, object>} entries Assignment entries.
 * @returns {object}
 */
function _sortedAssignments(entries) {
    return Object.fromEntries([...entries.entries()]
        .sort((a, b) => a[0].localeCompare(b[0])));
}

/**
 * Allocate withdraw/cover/stranded roles and compute per-member withdrawal
 * costs.  Exactly one canonical cover is selected in v1; every other member
 * that can legally and profitably move receives the withdraw assignment.
 * @param {object} input Selector input.
 * @param {object} state Evaluation state.
 * @param {object} regroup Selected regroup row.
 * @param {string} triggerKind Winning trigger kind.
 * @returns {object}
 */
function _allocateRoles(input, state, regroup, triggerKind) {
    const endpoint = { x: regroup.x, y: regroup.y };
    const validationBudget = Math.max(state.rates.full, state.rates.run || state.rates.full);
    const roles = [];
    const stranded = [];
    const active = [];
    const assignments = new Map();

    for (const member of state.members) {
        const danger = _dangerAt(state.dangerAt, member.position);
        const baseRole = {
            combatantId: member.combatantId,
            engaged: member.engagedAtStart,
            pinned: member.pinned,
            danger: _round(danger)
        };
        if (member.defeated || member.incapacitated || member.unavailable) {
            const reason = PEEL_DETAIL_REASONS.strandedUnavailable;
            stranded.push({ combatantId: member.combatantId, reason });
            roles.push({ ...baseRole, role: "stranded", reason });
            continue;
        }
        if (member.alreadyActed) {
            const reason = PEEL_DETAIL_REASONS.strandedAlreadyActed;
            stranded.push({ combatantId: member.combatantId, reason });
            roles.push({ ...baseRole, role: "stranded", reason });
            continue;
        }
        if (member.stunned) {
            const reason = PEEL_DETAIL_REASONS.strandedStunned;
            stranded.push({ combatantId: member.combatantId, reason });
            roles.push({ ...baseRole, role: "stranded", reason });
            continue;
        }
        active.push(member);
    }

    const coverPool = active.filter(member =>
        !member.engagedAtStart && !(member.pinned && !member.engagedAtStart));
    let coverResult = _selectCover(coverPool, state, regroup);
    if (coverResult.rejection === PEEL_REJECTIONS.noCoverAllEngaged) {
        const trulyAllEngaged = active.length > 0
            && active.every(member => member.engagedAtStart);
        if (!trulyAllEngaged) {
            coverResult = {
                ...coverResult,
                rejection: active.length ? "no-cover-capability" : PEEL_REJECTIONS.noCover
            };
        }
    }
    const coverIds = new Set(coverResult.cover.members);
    const costs = [];
    const fightInPlace = [];

    for (const member of active) {
        const danger = _dangerAt(state.dangerAt, member.position);
        const engagers = _engagersOf(member, state.threats);
        const engaged = engagers.length > 0 || member.engagedAtStart;
        const baseRole = {
            combatantId: member.combatantId,
            engaged,
            pinned: member.pinned && !engaged,
            danger: _round(danger)
        };
        if (coverIds.has(member.combatantId)) {
            assignments.set(member.combatantId, { task: "support", role: "cover" });
            roles.push({ ...baseRole, role: "cover", task: "support", reason: coverResult.cover.reason });
            continue;
        }

        const route = _probeRoute(state.navigation, member, endpoint, validationBudget, {
            reservations: state.input.reservations ?? state.input.context?.reservations
        });
        if (!route.exact) {
            const reason = PEEL_DETAIL_REASONS.strandedNoRoute;
            stranded.push({ combatantId: member.combatantId, reason, routeReason: route.reason ?? null });
            roles.push({ ...baseRole, role: "stranded", reason, routeReason: route.reason ?? null });
            continue;
        }
        const pinnedOutsideMelee = member.pinned && !engaged;
        if (pinnedOutsideMelee && !_pinnedRouteSafe(member, route, endpoint, state)) {
            const reason = PEEL_DETAIL_REASONS.strandedPinnedNoSafeExit;
            stranded.push({ combatantId: member.combatantId, reason });
            roles.push({ ...baseRole, role: "stranded", reason });
            continue;
        }

        const cost = _costForMember(member, engagers, endpoint, coverResult.cover.mode, state);
        cost.pinned = pinnedOutsideMelee;
        costs.push(cost);
        if (cost.mode === "withdraw" || cost.mode === "disengage") {
            assignments.set(member.combatantId, { task: "regroup", role: "withdraw" });
            const closestEngager = engagers
                .map(threat => ({ threat, distance: _distanceUnits(member.position, threat, state.scale) }))
                .sort((a, b) => (a.distance - b.distance) || a.threat.key.localeCompare(b.threat.key))[0];
            roles.push({
                ...baseRole,
                role: "withdraw",
                task: "regroup",
                mode: cost.mode,
                priority: engaged ? 0 : 1,
                closestEnemyDistance: _round(closestEngager?.distance),
                margin: cost.margin,
                reason: cost.decisionReason
            });
        } else {
            fightInPlace.push({
                combatantId: member.combatantId,
                reason: cost.decisionReason,
                margin: cost.margin
            });
            roles.push({
                ...baseRole,
                role: "fight-in-place",
                mode: cost.mode,
                margin: cost.margin,
                reason: cost.decisionReason
            });
        }
    }

    const withdrawCosts = costs.filter(cost => cost.mode === "withdraw" || cost.mode === "disengage");
    let uncovered = false;
    if (!coverIds.size) {
        const positiveMargins = withdrawCosts.length > 0
            && withdrawCosts.every(cost => cost.margin > 0);
        uncovered = state.thresholds.peelAllowUncovered
            && triggerKind === PEEL_TRIGGERS.moraleDesperate
            && positiveMargins;
        if (uncovered) {
            coverResult = {
                ...coverResult,
                cover: {
                    mode: "none",
                    members: [],
                    reason: "uncovered-desperate",
                    target: null,
                    unpinSupport: 0
                },
                rejection: null
            };
        }
    }
    if (coverResult.cover.mode === "suppression") {
        const pinnedCovered = costs.filter(cost => cost.pinned
            && (cost.mode === "withdraw" || cost.mode === "disengage")).length;
        coverResult = {
            ...coverResult,
            cover: { ...coverResult.cover, unpinSupport: pinnedCovered }
        };
    }

    return {
        assignments: _sortedAssignments(assignments),
        roles,
        stranded,
        fightInPlace,
        costs,
        cover: coverResult.cover,
        coverCandidates: coverResult.candidates,
        coverRejection: coverResult.rejection,
        uncovered,
        withdrawCount: withdrawCosts.length
    };
}

/**
 * Build the compact objective trigger row for the winning trigger.
 * @param {string} kind Winning trigger kind.
 * @param {object} checks Trigger checks.
 * @param {object} continuation Continuation checks.
 * @returns {object}
 */
function _triggerSummary(kind, checks, continuation) {
    const closeEnemies = checks.closeThreat.closeEnemies;
    const danger = checks.closeThreat.danger;
    switch (kind) {
        case PEEL_TRIGGERS.moraleDesperate:
            return {
                kind,
                value: checks.moraleDesperate.tier,
                threshold: checks.moraleDesperate.threshold,
                danger,
                closeEnemies
            };
        case PEEL_TRIGGERS.losses:
            return {
                kind,
                value: checks.losses.ratio,
                threshold: checks.losses.threshold,
                casualtiesRecent: checks.losses.casualtiesRecent,
                recentThreshold: checks.losses.recentThreshold,
                danger,
                closeEnemies
            };
        case PEEL_TRIGGERS.closeThreat:
            return {
                kind,
                value: checks.closeThreat.closeEnemies,
                threshold: checks.closeThreat.required,
                danger,
                closeEnemies
            };
        default:
            return {
                kind: PEEL_TRIGGERS.continuation,
                value: continuation.weakCount,
                threshold: 1,
                danger,
                closeEnemies
            };
    }
}

/**
 * Resolve the threat centroid from injection (`threatCentroid` point or
 * function), a threat-map helper, or the pure weighted fallback.
 * @param {object} input Selector input.
 * @param {object[]} threats Normalized threats.
 * @returns {object|null}
 */
function _threatCentroidOf(input, threats) {
    const injected = input.threatCentroid ?? input.context?.threatCentroid ?? null;
    try {
        if (typeof injected === "function") {
            const result = injected(threats, input);
            if (_isPoint(result)) {
                return {
                    x: result.x,
                    y: result.y,
                    sourceCount: _finiteOr(result.sourceCount, threats.length),
                    weight: _finiteOr(result.weight, threats.length),
                    source: "injected"
                };
            }
        } else if (_isPoint(injected)) {
            return {
                x: injected.x,
                y: injected.y,
                sourceCount: _finiteOr(injected.sourceCount, threats.length),
                weight: _finiteOr(injected.weight, threats.length),
                source: "injected"
            };
        }
        const service = input.threatMap ?? input.context?.threatMap;
        if (typeof service?.threatCentroid === "function") {
            const result = service.threatCentroid(threats);
            if (_isPoint(result)) {
                return {
                    x: result.x,
                    y: result.y,
                    sourceCount: _finiteOr(result.sourceCount, threats.length),
                    weight: _finiteOr(result.weight, threats.length),
                    source: "threat-map"
                };
            }
        }
    } catch(_err) {
        // Fall through to the deterministic local computation.
    }
    const computed = computeThreatCentroid(threats);
    return computed ? { ...computed, source: "computed" } : null;
}

/**
 * Finish a rejected evaluation with a frozen serializable explanation.
 * @param {string} reason Top-level rejection reason.
 * @param {object} breakdown Partial breakdown accumulated so far.
 * @returns {object}
 */
function _reject(reason, breakdown) {
    const complete = {
        thresholds: breakdown.thresholds ?? null,
        triggerChecks: breakdown.triggerChecks ?? null,
        continuation: breakdown.continuation ?? null,
        teamCenter: breakdown.teamCenter ?? null,
        threatCentroid: breakdown.threatCentroid ?? null,
        awayVector: breakdown.awayVector ?? null,
        regroupCandidates: breakdown.regroupCandidates ?? [],
        roles: breakdown.roles ?? [],
        costs: breakdown.costs ?? [],
        stranded: breakdown.stranded ?? [],
        fightInPlace: breakdown.fightInPlace ?? [],
        coverCandidates: breakdown.coverCandidates ?? [],
        rejections: [reason]
    };
    return _deepFreeze({
        status: "rejected",
        reason,
        rejections: [reason],
        descriptor: null,
        breakdown: complete
    });
}

/**
 * Evaluate the peel-withdrawal selector completely.  Unlike
 * {@link selectPeelWithdrawal}, this diagnostic API returns a serializable
 * evaluation even when the tactic is rejected, so tests, preview tooling
 * and future integration can display exactly why no peel was chosen.
 *
 * Expected input is plain/read-only data:
 * `{members, targets, casualties, moraleInfo, leaderId, threatMap,
 * navigation, dangerAt, threatCentroid, rates, grid, context}`.
 * `members` may carry normalized tactical fields (`position`, `statuses`,
 * `engagers`, `capabilities`) or Fireteam-like document references.
 *
 * @param {object} input Selector input.
 * @returns {object} Frozen evaluation `{status, reason, rejections,
 *   descriptor, breakdown}`.
 */
export function evaluatePeelWithdrawal(input = {}) {
    const thresholds = _thresholdsOf(input);
    const rawThreats = input.threats ?? input.targets ?? input.context?.targets ?? [];
    const threats = _normalizeThreats(rawThreats);
    const members = _normalizeMembers(input.members ?? [], input);
    // Reverse engagement references live on the targets, so they cannot be
    // folded into member normalization before the threat list exists.  A
    // pinned member with such a reference is intentionally treated as an
    // ordinary engaged member (the corebook states melee removes pinning).
    for (const member of members) {
        if (!member.engagedAtStart && _engagersOf(member, threats).length > 0) {
            member.engagedAtStart = true;
        }
    }
    const grid = _gridOf(input);
    const scale = _coordinateScale(grid);
    const dangerAt = _dangerAtOf(input);
    const navigation = input.navigation ?? input.context?.navigation ?? null;
    const livingMembers = members.filter(member => !member.defeated && !member.incapacitated);
    const centerInfo = _teamCenterOf(input, livingMembers);
    const teamCenter = centerInfo.point;
    const threatCentroid = _threatCentroidOf(input, threats);
    const leader = centerInfo.leader
        ?? livingMembers.find(member => member.combatantId === input.leaderId)
        ?? livingMembers.find(member => member.leader)
        ?? livingMembers.find(member => member.position) ?? null;
    const state = {
        input,
        members,
        livingMembers,
        threats,
        threatCentroid,
        teamCenter,
        centerDanger: null,
        dangerAt,
        navigation,
        thresholds,
        scale,
        rates: null,
        referenceMember: leader
    };
    const base = {
        thresholds,
        teamCenter: teamCenter ? {
            x: _round(teamCenter.x),
            y: _round(teamCenter.y),
            source: centerInfo.source
        } : null,
        threatCentroid: threatCentroid ? {
            x: _round(threatCentroid.x),
            y: _round(threatCentroid.y),
            sourceCount: threatCentroid.sourceCount,
            weight: _round(threatCentroid.weight),
            source: threatCentroid.source
        } : null
    };

    if (!members.length) return _reject(PEEL_REJECTIONS.noMembers, base);
    if (!livingMembers.length) return _reject(PEEL_REJECTIONS.noMembers, base);
    if (!threats.length || !threatCentroid) return _reject(PEEL_REJECTIONS.noThreats, base);
    if (!leader || !_isPoint(teamCenter)) return _reject(PEEL_REJECTIONS.noLeader, base);

    const checks = _triggerChecks(input, state);
    state.centerDanger = Number.isFinite(checks.centerDanger) ? checks.centerDanger : null;
    base.triggerChecks = {
        moraleDesperate: checks.moraleDesperate,
        losses: checks.losses,
        closeThreat: {
            ...checks.closeThreat,
            entries: checks.closeThreat.entries
        }
    };

    const rates = _ratesOf(input, livingMembers);
    if (!rates) return _reject(PEEL_REJECTIONS.movementRatesUnavailable, base);
    state.rates = rates;

    const regroupEvaluation = _evaluateRegroup(input, state);
    base.awayVector = regroupEvaluation.awayVector;
    base.regroupCandidates = regroupEvaluation.candidates;
    if (regroupEvaluation.rejection) return _reject(regroupEvaluation.rejection, base);
    const regroup = regroupEvaluation.selected;
    const regroupPoint = {
        x: regroup.x,
        y: regroup.y,
        source: regroup.source,
        revision: _fnv1a(_stableStringify({
            source: regroup.source,
            x: regroup.x,
            y: regroup.y,
            teamCenter: base.teamCenter,
            threatCentroid: base.threatCentroid
        }))
    };

    const continuation = _continuationOf(input, state, regroup, checks);
    base.continuation = continuation;
    const primary = _primaryTrigger(checks);
    const reason = primary ?? (continuation.active ? PEEL_TRIGGERS.continuation : null);
    if (!reason) return _reject(PEEL_REJECTIONS.noTrigger, base);

    const allocation = _allocateRoles(input, state, regroup, reason);
    base.roles = allocation.roles;
    base.costs = allocation.costs;
    base.stranded = allocation.stranded;
    base.fightInPlace = allocation.fightInPlace;
    base.coverCandidates = allocation.coverCandidates;

    if (!allocation.cover.members.length && !allocation.uncovered) {
        return _reject(allocation.coverRejection ?? PEEL_REJECTIONS.noCover, base);
    }
    if (!allocation.withdrawCount) return _reject(PEEL_REJECTIONS.noWithdrawCapable, base);
    if (!allocation.cover.members.length && allocation.cover.mode === "none"
        && allocation.cover.reason !== "uncovered-desperate") {
        return _reject(PEEL_REJECTIONS.uncoveredMargin, base);
    }

    const withdrawCentroid = { x: regroupPoint.x, y: regroupPoint.y };
    const breakdown = {
        ...base,
        disengage: {
            capableMembers: members.filter(member => member.disengage.available)
                .map(member => member.combatantId),
            fallback: members.some(member => member.disengage.available)
                ? "capability-detected" : "ordinary-withdraw",
            apiV1Default: "fallback-only"
        },
        rejections: []
    };
    const descriptor = {
        name: PEEL_WITHDRAWAL_NAME,
        reason,
        objective: {
            type: PEEL_WITHDRAWAL_NAME,
            ttl: 1,
            regroupPoint,
            threatCentroid: {
                x: _round(threatCentroid.x),
                y: _round(threatCentroid.y),
                sourceCount: threatCentroid.sourceCount,
                weight: _round(threatCentroid.weight)
            },
            lane: {
                from: { x: _round(threatCentroid.x), y: _round(threatCentroid.y) },
                to: { x: _round(withdrawCentroid.x), y: _round(withdrawCentroid.y) }
            },
            trigger: _triggerSummary(reason, checks, continuation),
            hysteresis: {
                mode: "l2-morale/commitment/stateless",
                dangerExit: thresholds.peelDangerExit
            }
        },
        assignments: allocation.assignments,
        cover: allocation.cover,
        breakdown
    };
    const frozenDescriptor = _deepFreeze(descriptor);
    return _deepFreeze({
        status: "ok",
        reason,
        rejections: [],
        descriptor: frozenDescriptor,
        breakdown: frozenDescriptor.breakdown
    });
}

/**
 * Tactic-selector form matching the future per-preset registry contract:
 * return the immutable peel descriptor when the maneuver is legal and
 * useful, otherwise null.  Use {@link evaluatePeelWithdrawal} when the
 * caller needs the explainable rejection/breakdown.
 * @param {object} input Selector input.
 * @returns {object|null}
 */
export function selectPeelWithdrawal(input = {}) {
    return evaluatePeelWithdrawal(input).descriptor ?? null;
}

/**
 * Integration adapter for preset cascades: merge the fireteam selector
 * envelope (`moraleTier`, `context.navigation`, `context.threatMap`,
 * `context.rates`, scene/grid fallbacks) into the explicit pure-core input
 * without reading Foundry globals or mutating documents. Explicit input
 * fields always win over context fallbacks; selector purity and the
 * no-latch contract are unchanged.
 * @param {object} input Fireteam/preset selector input.
 * @returns {object} Frozen peel evaluation (`evaluatePeelWithdrawal`).
 */
export function evaluatePeelCascade(input = {}) {
    const context = input.context ?? {};
    const scene = input.scene ?? context.scene ?? input.combat?.scene ?? context.combat?.scene ?? null;
    const moraleTier = input.moraleTier ?? context.moraleTier ?? null;
    return evaluatePeelWithdrawal({
        ...input,
        scene,
        grid: input.grid ?? context.grid ?? scene?.grid ?? null,
        rates: input.rates ?? context.rates ?? null,
        navigation: input.navigation ?? context.navigation ?? null,
        threatMap: input.threatMap ?? context.threatMap ?? null,
        dangerAt: input.dangerAt ?? context.dangerAt,
        moraleInfo: input.moraleInfo ?? (moraleTier ? { tier: moraleTier } : null),
        context
    });
}
