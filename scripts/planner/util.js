/**
 * Planner decomposition (issue #403 follow-up): this module was extracted
 * verbatim from scripts/planner.js — see that file for the design contract.
 * The planner service re-exports the public surface so existing importers
 * and tests keep working.
 */


/**
 * Deterministic 32-bit FNV-1a fingerprint, identical on every client.
 * @param {string} text
 * @returns {string} Hex string, zero-padded to 8 chars.
 */
export function fnv1a(text) {
    let hash = 0x811c9dc5;
    const str = String(text);
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}


/**
 * JSON serialization with recursively sorted object keys so equal inputs
 * hash identically regardless of property insertion order.
 * @param {*} value
 * @returns {string}
 */
export function stableStringify(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) {
        return `[${value.map(entry => stableStringify(entry)).join(",")}]`;
    }
    const keys = Object.keys(value).sort();
    const parts = keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${parts.join(",")}}`;
}


/**
 * Mulberry32 PRNG вЂ” small, fast and fully deterministic for a given seed.
 * @param {number} seed 32-bit integer seed.
 * @returns {Function} `() => number` in `[0, 1)`.
 */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function() {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}


/**
 * Deep-freeze helper for immutable snapshots and plans.
 * @param {*} value
 * @returns {*}
 */
export function _deepFreeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        for (const key of Object.keys(value)) _deepFreeze(value[key]);
        Object.freeze(value);
    }
    return value;
}


/**
 * Strip anything non-serializable via a JSON round-trip. Guarantees the
 * plan holds no Document instances, functions or undefined properties.
 * @param {*} value
 * @returns {*}
 */
export function _jsonClone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}


/**
 * Normalize a Foundry collection/Map/array/iterable into a plain array.
 * @param {*} collection
 * @returns {object[]}
 */
export function _list(collection) {
    if (!collection) return [];
    if (Array.isArray(collection)) return collection;
    if (Array.isArray(collection.contents)) return collection.contents;
    if (typeof collection.values === "function") return [...collection.values()];
    if (typeof collection[Symbol.iterator] === "function") return [...collection];
    return [];
}


/**
 * Numeric helper: value when finite, otherwise fallback.
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
export function _finiteOr(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}


/**
 * Halve a movement budget for a prone (crawling) combatant: numeric
 * budgets are floored to half, `{mode}` budgets degrade to the `half`
 * movement mode, other shapes pass through untouched.
 * @param {*} budget Numeric, `{meters|cells|budget|limit|mode}` budget.
 * @returns {*}
 */
export function _halveMoveBudget(budget) {
    if (Number.isFinite(budget)) return Math.floor(budget / 2);
    if (budget && typeof budget === "object") {
        const copy = { ...budget };
        for (const key of ["meters", "cells", "budget", "limit"]) {
            if (Number.isFinite(copy[key])) copy[key] = Math.floor(copy[key] / 2);
        }
        if (typeof copy.mode === "string") copy.mode = "half";
        return copy;
    }
    return budget;
}


/**
 * Expected damage of a damage spec: numbers pass through, dice strings
 * (`1d10+3`) evaluate deterministically to their mean.
 * @param {*} value
 * @returns {number}
 */
export function _expectedDamage(value) {
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
 * Blast radius parsed from an OW weapon `special` trait string —
 * "Blast (3)" (smoke finding: the canonical blast field lives in the
 * traits string, not a `blastRadius` data key). `null` when absent.
 * @param {string|null} special Trait spec text.
 * @returns {number|null}
 */
export function _blastFromSpecial(special) {
    if (typeof special !== "string" || !special) return null;
    const match = /blast\s*\(\s*(\d+)\s*\)/i.exec(special);
    return match ? parseInt(match[1], 10) : null;
}


/**
 * Pixels per scene unit derived from the normalized grid info.
 * @param {object|null} grid Grid info `{size, distance}`.
 * @returns {number}
 */
export function _pxPerUnit(grid) {
    const size = _finiteOr(grid?.size, 0);
    const distance = _finiteOr(grid?.distance, 0);
    return size > 0 && distance > 0 ? size / distance : 0;
}


/**
 * Euclidean distance between two pixel points.
 * @param {object|null} a `{x, y}`
 * @param {object|null} b `{x, y}`
 * @returns {number}
 */
export function _distPx(a, b) {
    if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(b.x)) return Infinity;
    return Math.hypot(b.x - a.x, b.y - a.y);
}


/**
 * Distance between a token-like point and the viewer in scene units.
 * @param {{x: number|null, y: number|null}} from Self position (pixels).
 * @param {{x: number|null, y: number|null}} to Target position (pixels).
 * @param {object} grid `_gridInfo` result.
 * @returns {number|null}
 */
export function _pixelDistance(from, to, grid) {
    if (!Number.isFinite(from?.x) || !Number.isFinite(to?.x)
        || !Number.isFinite(from?.y) || !Number.isFinite(to?.y)) return null;
    const size = Number.isFinite(grid?.size) && grid.size > 0 ? grid.size : 100;
    const unit = Number.isFinite(grid?.distance) && grid.distance > 0 ? grid.distance : 1;
    return Math.hypot(from.x - to.x, from.y - to.y) / size * unit;
}


/**
 * Grid description of a scene in a normalized, serializable shape.
 * @param {object|null} scene
 * @returns {{type: *, size: *, distance: *}}
 */
export function _gridInfo(scene) {
    const grid = scene?.grid ?? {};
    return {
        type: grid.type ?? null,
        size: Number.isFinite(grid.size) ? grid.size : null,
        distance: Number.isFinite(grid.distance) ? grid.distance : 1
    };
}


/**
 * Shortest absolute difference between two bearings in degrees (0..180).
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function _angleDiffDeg(a, b) {
    return Math.abs(((((a - b) % 360) + 540) % 360) - 180);
}


/**
 * Short-arc midpoint between two bearings, normalized to [0, 360).
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function _bearingMidpoint(a, b) {
    const diff = ((((b - a) % 360) + 540) % 360) - 180;
    return (a + (diff / 2) + 360) % 360;
}


/**
 * Compass bearing (0-360, degrees) from self to a target point.
 * @param {{x: number|null, y: number|null}} from
 * @param {{x: number|null, y: number|null}} to
 * @returns {number|null}
 */
export function _bearingTo(from, to) {
    if (!Number.isFinite(from?.x) || !Number.isFinite(from?.y)
        || !Number.isFinite(to?.x) || !Number.isFinite(to?.y)) return null;
    return (((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI) + 360) % 360;
}
