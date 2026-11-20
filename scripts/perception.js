/**
 * Perception service (issue #401): token-perspective line of sight, valid
 * target discovery, deterministic target scoring and last-known-position
 * memory for AI-controlled NPCs.
 *
 * Design contract (epic #363):
 * - Every check runs from the *NPC token's* perspective. GM-only data
 *   (hidden tokens, tokens without line of sight) never reaches planner
 *   output just because the controller client happens to be a GM.
 * - `flags["only-war-ai"].memory` on the Combatant stores
 *   `{ [targetTokenUuid]: {sceneId, x, y, elevation, lastSeenRound,
 *   lastSeenTurn, dispositionAtDetection} }` — sanitized entries only: no
 *   actor stats, no ownership data, no live hidden coordinates.
 * - Persistent memory is written only by the authority controller (the
 *   `authority` service from issue #400 when present, `game.user.isGM`
 *   fallback otherwise); entries expire after
 *   {@link MEMORY_MAX_AGE_ROUNDS} full combat rounds without re-detection.
 * - Everything except the Foundry adapters is pure and deterministic so the
 *   behaviour can be unit-tested without a canvas.
 */
import { FLAG_KEYS, MODULE_ID } from "./constants.js";
import { isAiEnabled } from "./config-resolver.js";
import { logDiagnostics } from "./settings.js";

/** Full rounds a last-known-position entry survives without re-detection. */
export const MEMORY_MAX_AGE_ROUNDS = 3;

/** Snapshot status values. */
export const PERCEPTION_STATUS = Object.freeze({
    ok: "ok",
    unavailable: "perception-unavailable"
});

/**
 * Default component weights for {@link scoreTarget}. Presets override them
 * through `context.weights`; `canAttack` acts as a strong gate — targets
 * that cannot be attacked score below any attackable one.
 */
export const DEFAULT_SCORE_WEIGHTS = Object.freeze({
    canAttack: 10,
    effectiveness: 3,
    threat: 2,
    distance: 1
});

/** TokenDocument change keys that can alter perception or memory. */
const TOKEN_UPDATE_KEYS = Object.freeze([
    "x",
    "y",
    "elevation",
    "hidden",
    "disposition",
    "sight",
    "width",
    "height"
]);

/**
 * Unwrap a Token placeable to its TokenDocument; documents pass through.
 * @param {object} token Token placeable, TokenDocument or plain fixture.
 * @returns {object|null}
 */
function _tokenDocument(token) {
    if (!token || typeof token !== "object") return null;
    const doc = token.document;
    if (doc && typeof doc === "object" && doc.documentName === "Token") return doc;
    return token;
}

/**
 * Unwrap a TokenDocument to its canvas placeable when one exists.
 * @param {object} token
 * @returns {object|null}
 */
function _tokenObject(token) {
    if (!token || typeof token !== "object") return null;
    return token.object ?? token;
}

/**
 * Centre point of a token in canvas pixels, or null when no position exists.
 * @param {object} token
 * @returns {{x: number, y: number}|null}
 */
function _positionOf(token) {
    const obj = _tokenObject(token);
    const doc = _tokenDocument(token);
    // The document source is authoritative: a placeable's center/x
    // lags behind update() during Foundry's movement animation, while
    // _source carries the applied position immediately.
    if (Number.isFinite(doc?._source?.x) && Number.isFinite(doc?._source?.y)) {
        const size = globalThis.canvas?.scene?.grid?.size ?? globalThis.canvas?.dimensions?.size ?? 100;
        const w = (doc?.width ?? (Number.isFinite(obj?.w) ? obj.w / size : 1)) * size;
        const h = (doc?.height ?? (Number.isFinite(obj?.h) ? obj.h / size : 1)) * size;
        return { x: doc._source.x + (w / 2), y: doc._source.y + (h / 2) };
    }
    const center = obj?.center ?? doc?.center;
    if (center && Number.isFinite(center.x) && Number.isFinite(center.y)) {
        return { x: center.x, y: center.y };
    }
    const x = doc?.x ?? obj?.x;
    const y = doc?.y ?? obj?.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const size = globalThis.canvas?.scene?.grid?.size ?? globalThis.canvas?.dimensions?.size ?? 100;
    const w = (doc?.width ?? (Number.isFinite(obj?.w) ? obj.w / size : 1)) * size;
    const h = (doc?.height ?? (Number.isFinite(obj?.h) ? obj.h / size : 1)) * size;
    return { x: x + (w / 2), y: y + (h / 2) };
}

/**
 * Token elevation in scene units (0 when absent).
 * @param {object} token
 * @returns {number}
 */
function _elevationOf(token) {
    const doc = _tokenDocument(token);
    const value = doc?.elevation ?? _tokenObject(token)?.elevation;
    return Number.isFinite(value) ? value : 0;
}

/**
 * Stable UUID of a token, reconstructing a scene-scoped UUID when the
 * document does not carry one (plain fixtures, headless tests).
 * @param {object} token
 * @returns {string|null}
 */
function _tokenUuid(token) {
    const doc = _tokenDocument(token);
    if (typeof doc?.uuid === "string" && doc.uuid) return doc.uuid;
    const sceneId = doc?.parent?.id ?? globalThis.canvas?.scene?.id ?? "scene";
    return doc?.id ? `Scene.${sceneId}.Token.${doc.id}` : null;
}

/**
 * Status ids of a token's actor (`actor.statuses` set/array/map), merged
 * with any statuses carried by the token documents themselves.
 * @param {object} token
 * @returns {Set<string>}
 */
export function statusIdsOf(token) {
    const ids = new Set();
    const doc = _tokenDocument(token);
    const sources = [doc?.actor?.statuses, doc?.statuses, _tokenObject(token)?.statuses];
    for (const source of sources) {
        if (!source) continue;
        if (typeof source[Symbol.iterator] === "function") {
            for (const id of source) ids.add(String(id));
        } else if (typeof source === "object") {
            for (const key of Object.keys(source)) {
                if (source[key]) ids.add(String(key));
            }
        }
    }
    return ids;
}

/**
 * Whether the token should be treated as hidden from perception checks:
 * TokenDocument `hidden` flag, Combatant `hidden` flag or a hidden/invisible
 * status. Hidden targets must never leak to the AI only because the
 * controller client is a GM.
 * @param {object} token
 * @param {object} [options]
 * @param {object} [options.combatant] Combatant linked to the token.
 * @returns {boolean}
 */
export function isHiddenToken(token, { combatant = null } = {}) {
    const doc = _tokenDocument(token);
    if (doc?.hidden === true || combatant?.hidden === true) return true;
    const ids = statusIdsOf(token);
    return ids.has("hidden") || ids.has("invisible");
}

/**
 * Whether the token is dead or marked defeated and therefore not a target.
 * @param {object} token
 * @param {object} [options]
 * @param {object} [options.combatant] Combatant linked to the token.
 * @returns {boolean}
 */
export function isDeadOrDefeated(token, { combatant = null } = {}) {
    if (combatant?.defeated === true) return true;
    const ids = statusIdsOf(token);
    return ids.has("dead") || ids.has("defeated");
}

/**
 * Whether the viewer is blinded and cannot perceive anything.
 * @param {object} token
 * @returns {boolean}
 */
export function isBlinded(token) {
    const ids = statusIdsOf(token);
    return ids.has("blinded") || ids.has("blind");
}

/**
 * Token disposition (`-1` hostile, `0` neutral, `1` friendly).
 * @param {object} token
 * @returns {number}
 */
export function dispositionOf(token) {
    const doc = _tokenDocument(token);
    const value = doc?.disposition ?? _tokenObject(token)?.disposition;
    return Number.isFinite(value) ? value : 0;
}

/**
 * Whether a target disposition is a valid target for the viewer. Default
 * rule: strictly opposite dispositions (`hostile` ↔ `friendly`) are
 * targets; neutral tokens and same-faction tokens are not.
 * @param {number} viewerDisposition
 * @param {number} targetDisposition
 * @param {object} [options]
 * @param {number[]|null} [options.dispositions] Explicit allow-list that
 *   replaces the default rule when provided.
 * @param {boolean} [options.includeNeutral] Also accept neutral targets.
 * @returns {boolean}
 */
export function isHostileDisposition(
    viewerDisposition,
    targetDisposition,
    { includeNeutral = false, dispositions = null } = {}
) {
    if (Array.isArray(dispositions)) return dispositions.includes(targetDisposition);
    const viewer = Math.sign(viewerDisposition);
    const target = Math.sign(targetDisposition);
    if (target === 0) return includeNeutral === true && viewer !== 0;
    if (viewer === 0) return false;
    return viewer !== target;
}

/**
 * Live tokens of the currently viewed scene.
 * @returns {object[]}
 */
function _sceneTokens() {
    const placeables = globalThis.canvas?.tokens?.placeables ?? globalThis.canvas?.tokens?.contents;
    if (Array.isArray(placeables) && placeables.length) return placeables;
    const collection = globalThis.canvas?.scene?.tokens;
    if (Array.isArray(collection?.contents)) return collection.contents;
    if (collection && typeof collection[Symbol.iterator] === "function") return [...collection];
    return [];
}

/**
 * Call `testVisibility` defensively; returns null when the API shape is
 * missing or threw so callers can fall through to the next adapter.
 * @param {object} tester Object exposing `testVisibility`.
 * @param {object} point `{x, y}` point to test.
 * @param {object} options Options forwarded to the API.
 * @returns {boolean|null}
 */
function _tryTestVisibility(tester, point, options) {
    try {
        const result = tester.testVisibility(point, options);
        return typeof result === "boolean" ? result : null;
    } catch(_err) {
        return null;
    }
}

/**
 * Line-of-sight adapter for Foundry 13/14. Resolution order:
 * `canvas.visibility.testVisibility` (v13+), `canvas.effects.visibility`
 * (legacy path), placeable `testVisibility`, `visionSource.testVisibility`,
 * then a geometric wall fallback (`canvas.walls.checkCollision` or a manual
 * segment test). The check is always evaluated from `from`'s vision
 * sources — never from `game.user` — so GM-owned clients do not leak
 * hidden information.
 * @param {object} from Viewer token (placeable or document).
 * @param {object} to Target token (placeable or document).
 * @returns {boolean}
 */
export function hasLineOfSight(from, to) {
    const origin = _positionOf(from);
    const target = _positionOf(to);
    if (!origin || !target) return false;

    const viewer = _tokenObject(from);
    const layer = globalThis.canvas?.visibility ?? globalThis.canvas?.effects?.visibility;
    if (layer && typeof layer.testVisibility === "function") {
        const seen = _tryTestVisibility(layer, target, { object: viewer, tolerance: 2 });
        // When core reports "visible" the walls still apply: scenes with
        // vision disabled or an uninitialized visibility layer answer
        // permissively, so cross-check the geometry before trusting it.
        if (seen === true) return _geometricLineOfSight(origin, target);
        if (seen === false) {
            // A probe point with an explicitly null document is not a real
            // canvas token: core reports it "not visible" regardless of
            // walls — for such probes the wall geometry is the authority.
            if (from?.document === null || viewer?.document === null) {
                return _geometricLineOfSight(origin, target);
            }
            return false;
        }
    }
    if (viewer && typeof viewer.testVisibility === "function") {
        const seen = _tryTestVisibility(viewer, target, { tolerance: 2 });
        if (seen !== null) return seen;
    }
    const vision = viewer?.vision ?? _tokenDocument(from)?.vision;
    if (vision && typeof vision.testVisibility === "function") {
        const seen = _tryTestVisibility(vision, target, {});
        if (seen !== null) return seen;
    }
    return _geometricLineOfSight(origin, target);
}

/**
 * Wall-based LOS fallback used when no vision API answered.
 * @param {{x: number, y: number}} origin
 * @param {{x: number, y: number}} target
 * @returns {boolean}
 */
function _geometricLineOfSight(origin, target) {
    const ray = { A: { x: origin.x, y: origin.y }, B: { x: target.x, y: target.y } };
    try {
        // Foundry v13+: the sight polygon backend is the authoritative wall
        // collision API; walls.checkCollision returns opaque results there.
        const backends = globalThis.CONFIG?.Canvas?.polygonBackends;
        const backend = backends?.sight ?? backends?.limited;
        if (typeof backend?.testCollision === "function") {
            const hit = backend.testCollision(origin, target, { type: "sight", mode: "any" });
            if (typeof hit === "boolean") return !hit;
        }
    } catch(_err) {
        // Fall through to the manual segment test below.
    }
    try {
        if (typeof globalThis.canvas?.walls?.checkCollision === "function") {
            const hit = globalThis.canvas.walls.checkCollision(origin, target,
                { type: "sight", mode: "any" });
            if (typeof hit === "boolean") return !hit;
        }
    } catch(_err) {
        // Fall through to the manual segment test below.
    }
    for (const wall of _sightBlockingWalls()) {
        if (_segmentsIntersect(ray.A, ray.B, wall.A, wall.B)) return false;
    }
    return true;
}

/**
 * Sight-blocking walls of the current scene as `{A, B}` segments.
 * @returns {Array<{A: {x: number, y: number}, B: {x: number, y: number}}>}
 */
function _sightBlockingWalls() {
    const docs = [];
    const layer = globalThis.canvas?.walls;
    for (const wall of layer?.placeables ?? layer?.contents ?? []) {
        const doc = wall?.document ?? wall;
        if (doc) docs.push(doc);
    }
    if (!docs.length) {
        const collection = globalThis.canvas?.scene?.walls;
        const list = collection?.contents
            ?? (collection && typeof collection[Symbol.iterator] === "function" ? [...collection] : []);
        for (const wall of list) {
            const doc = wall?.document ?? wall;
            if (doc) docs.push(doc);
        }
    }
    return docs.filter(_wallBlocksSight).map(_wallSegment).filter(Boolean);
}

/**
 * Whether a wall document blocks sight right now, accepting both the
 * v13 `sight`/`door` object schema and the legacy numeric `sight`/`ds`
 * schema. Open doors never block.
 * @param {object} doc
 * @returns {boolean}
 */
function _wallBlocksSight(doc) {
    if (!doc || typeof doc !== "object") return false;
    const doorState = doc.door?.state ?? doc.doorState ?? doc.ds;
    if (doorState === "open" || doorState === 1) return false;
    const sight = doc.sight;
    if (sight === null || sight === undefined) return false;
    if (typeof sight === "number") return sight > 0;
    if (typeof sight === "object") {
        if (sight.enabled === false) return false;
        return sight.type !== "none" && sight.type !== 0;
    }
    return false;
}

/**
 * Wall endpoints as a segment, from the `c`/`coords` coordinate array or
 * `A`/`B` point fields.
 * @param {object} doc
 * @returns {{A: {x: number, y: number}, B: {x: number, y: number}}|null}
 */
function _wallSegment(doc) {
    const c = doc?.c ?? doc?.coords;
    if (Array.isArray(c) && c.length >= 4) {
        return { A: { x: c[0], y: c[1] }, B: { x: c[2], y: c[3] } };
    }
    const a = doc?.A ?? doc?.a;
    const b = doc?.B ?? doc?.b;
    if (a && b && Number.isFinite(a.x) && Number.isFinite(b.x)) return { A: a, B: b };
    return null;
}

/**
 * 2D segment intersection test (proper crossings only).
 * @param {{x: number, y: number}} p1
 * @param {{x: number, y: number}} p2
 * @param {{x: number, y: number}} p3
 * @param {{x: number, y: number}} p4
 * @returns {boolean}
 */
function _segmentsIntersect(p1, p2, p3, p4) {
    const d1 = _cross(p3, p4, p1);
    const d2 = _cross(p3, p4, p2);
    const d3 = _cross(p1, p2, p3);
    const d4 = _cross(p1, p2, p4);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
        && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * Signed orientation of point `p` relative to segment `a → b`.
 * @param {{x: number, y: number}} a
 * @param {{x: number, y: number}} b
 * @param {{x: number, y: number}} p
 * @returns {number}
 */
function _cross(a, b, p) {
    return ((b.x - a.x) * (p.y - a.y)) - ((b.y - a.y) * (p.x - a.x));
}

/**
 * Grid-aware distance between two tokens in scene units. Works identically
 * for square and hex grids through `canvas.grid.measureDistance`, with a
 * pixel fallback converted by the grid size/distance.
 * @param {object} from
 * @param {object} to
 * @returns {number|null}
 */
export function measureDistance(from, to) {
    const a = _positionOf(from);
    const b = _positionOf(to);
    if (!a || !b) return null;
    try {
        const result = globalThis.canvas?.grid?.measureDistance?.(a, b);
        if (typeof result === "number" && Number.isFinite(result)) return result;
        if (result && Number.isFinite(result.distance)) return result.distance;
    } catch(_err) {
        // Fall through to the euclidean fallback below.
    }
    const size = globalThis.canvas?.scene?.grid?.size ?? globalThis.canvas?.dimensions?.size ?? 100;
    const unit = globalThis.canvas?.scene?.grid?.distance ?? globalThis.canvas?.dimensions?.distance ?? 1;
    return Math.hypot(a.x - b.x, a.y - b.y) / size * unit;
}

/**
 * Combatants of a combat indexed by token id.
 * @param {object} combat
 * @returns {Map<string, object>}
 */
function _combatantIndex(combat) {
    const index = new Map();
    const collection = combat?.combatants;
    const list = collection?.contents
        ?? (collection && typeof collection[Symbol.iterator] === "function" ? [...collection] : []);
    for (const combatant of list) {
        const tokenId = combatant?.tokenId ?? _tokenDocument(combatant?.token)?.id;
        if (tokenId) index.set(tokenId, combatant);
    }
    return index;
}

/**
 * Valid targets for the viewer token, evaluated strictly from the viewer's
 * perspective. Candidates are scene tokens with an opposite disposition
 * (or matching `options.dispositions`), alive/not defeated, and — unless
 * `options.ignoreLOS` — with an actual line of sight. Hidden tokens are
 * excluded entirely by default so GM-only data cannot leak; with
 * `options.includeHidden` they appear flagged `hidden: true,
 * canAttack: false` for diagnostics. Each entry also carries `statuses` —
 * a sorted array of the target's status ids only (no actor data), so the
 * planner can weigh pinned/prone/stunned targets without document access.
 * @param {object} viewer Viewer token (placeable or document).
 * @param {object} [options]
 * @param {object} [options.combat] Combat providing combatant flags
 *   (defeated/hidden). Defaults to `game.combat`.
 * @param {number[]|null} [options.dispositions] Explicit disposition allow-list.
 * @param {boolean} [options.includeNeutral] Accept neutral targets.
 * @param {boolean} [options.includeHidden] Include hidden tokens flagged as
 *   not attackable.
 * @param {boolean} [options.ignoreLOS] Skip the line-of-sight check.
 * @returns {object[]} Target entries sorted by token id.
 */
export function visibleTargets(viewer, options = {}) {
    if (!globalThis.canvas?.scene || !viewer) return [];
    const viewerDoc = _tokenDocument(viewer);
    if (!viewerDoc || viewerDoc.destroyed === true) return [];
    if (isBlinded(viewer)) return [];

    const combat = options.combat ?? globalThis.game?.combat ?? null;
    const combatants = _combatantIndex(combat);
    const viewerDisposition = dispositionOf(viewer);
    const targets = [];

    for (const candidate of _sceneTokens()) {
        const doc = _tokenDocument(candidate);
        if (!doc || doc === viewerDoc) continue;
        if (doc.id && doc.id === viewerDoc.id) continue;
        if (doc.destroyed === true || doc.actor?.destroyed === true) continue;
        if (!doc.actor) continue;
        const combatant = combatants.get(doc.id) ?? null;
        if (isDeadOrDefeated(candidate, { combatant })) continue;
        if (!isHostileDisposition(viewerDisposition, dispositionOf(candidate), options)) continue;
        const hidden = isHiddenToken(candidate, { combatant });
        if (hidden && options.includeHidden !== true) continue;
        if (options.ignoreLOS !== true && !hasLineOfSight(viewer, candidate)) continue;
        const position = _positionOf(candidate);
        targets.push({
            tokenId: doc.id ?? null,
            tokenUuid: _tokenUuid(candidate),
            actorId: doc.actor?.id ?? null,
            name: doc.name ?? _tokenObject(candidate)?.name ?? null,
            sceneId: globalThis.canvas.scene?.id ?? null,
            disposition: dispositionOf(candidate),
            x: position?.x ?? null,
            y: position?.y ?? null,
            elevation: _elevationOf(candidate),
            distance: measureDistance(viewer, candidate),
            statuses: [...statusIdsOf(candidate)].sort(),
            hidden,
            canAttack: !hidden
        });
    }
    targets.sort((a, b) => String(a.tokenId).localeCompare(String(b.tokenId)));
    return targets;
}

/**
 * Normalize a stored memory entry to the sanitized contract. Anything
 * outside `{sceneId, x, y, elevation, lastSeenRound, lastSeenTurn,
 * dispositionAtDetection}` is dropped so hidden/GM-only data cannot leak.
 * @param {object} entry
 * @returns {object|null}
 */
export function sanitizeMemoryEntry(entry) {
    if (!entry || typeof entry !== "object") return null;
    if (typeof entry.sceneId !== "string" || !entry.sceneId) return null;
    if (!Number.isFinite(entry.x) || !Number.isFinite(entry.y)) return null;
    return {
        sceneId: entry.sceneId,
        x: entry.x,
        y: entry.y,
        elevation: Number.isFinite(entry.elevation) ? entry.elevation : 0,
        lastSeenRound: Number.isFinite(entry.lastSeenRound) ? entry.lastSeenRound : 0,
        lastSeenTurn: Number.isFinite(entry.lastSeenTurn) ? entry.lastSeenTurn : 0,
        dispositionAtDetection: Number.isFinite(entry.dispositionAtDetection)
            ? entry.dispositionAtDetection
            : 0
    };
}

/**
 * Normalize a whole memory map, dropping damaged entries.
 * @param {object} memory
 * @returns {object}
 */
export function sanitizeMemory(memory) {
    const next = {};
    if (!memory || typeof memory !== "object") return next;
    // Storage shape is an array of {tokenUuid, ...entry}: Foundry expands
    // dotted object keys (token uuids contain dots) into nested paths, so
    // the flag must never store the map as a bare object.
    const pairs = Array.isArray(memory)
        ? memory.map(item => [item?.tokenUuid, item])
        : Object.entries(memory);
    for (const [uuid, entry] of pairs) {
        if (typeof uuid !== "string" || !uuid) continue;
        const clean = sanitizeMemoryEntry(entry);
        if (clean) next[uuid] = clean;
    }
    return next;
}

/**
 * Pure memory write: record or refresh a contact. Re-detection overwrites
 * position and resets `lastSeenRound`/`lastSeenTurn`.
 * @param {object} memory Existing memory map.
 * @param {object} contact `{tokenUuid}` plus the entry fields.
 * @returns {object} New memory map.
 */
export function rememberContact(memory, contact) {
    const next = sanitizeMemory(memory);
    if (typeof contact?.tokenUuid !== "string" || !contact.tokenUuid) return next;
    const entry = sanitizeMemoryEntry(contact);
    if (!entry) return next;
    next[contact.tokenUuid] = entry;
    return next;
}

/**
 * Whether a memory entry is older than `maxAge` full rounds.
 * @param {object} entry
 * @param {number} currentRound
 * @param {number} [maxAge]
 * @returns {boolean}
 */
export function isMemoryExpired(entry, currentRound, maxAge = MEMORY_MAX_AGE_ROUNDS) {
    if (!entry) return true;
    const lastSeen = Number.isFinite(entry.lastSeenRound) ? entry.lastSeenRound : 0;
    return currentRound - lastSeen > maxAge;
}

/**
 * Pure expiry: drop entries older than `maxAge` full rounds.
 * @param {object} memory
 * @param {number} currentRound
 * @param {number} [maxAge]
 * @returns {object} New memory map.
 */
export function expireMemoryEntries(memory, currentRound, maxAge = MEMORY_MAX_AGE_ROUNDS) {
    const next = {};
    for (const [uuid, entry] of Object.entries(sanitizeMemory(memory))) {
        if (!isMemoryExpired(entry, currentRound, maxAge)) next[uuid] = entry;
    }
    return next;
}

/**
 * Pure pruning: drop entries that belong to another scene or reference
 * tokens that no longer exist.
 * @param {object} memory
 * @param {object} [options]
 * @param {string|null} [options.sceneId] Keep only this scene's entries.
 * @param {Function|null} [options.tokenExists] `(tokenUuid) => boolean`.
 * @returns {object} New memory map.
 */
export function pruneMemory(memory, { sceneId = null, tokenExists = null } = {}) {
    const next = {};
    for (const [uuid, entry] of Object.entries(sanitizeMemory(memory))) {
        if (sceneId && entry.sceneId !== sceneId) continue;
        if (typeof tokenExists === "function" && !tokenExists(uuid)) continue;
        next[uuid] = entry;
    }
    return next;
}

/**
 * Whether a token uuid still resolves to a live token on the current scene.
 * @param {string} tokenUuid
 * @returns {boolean}
 */
function _tokenExistsOnScene(tokenUuid) {
    const tokenId = String(tokenUuid).split(".").pop();
    const collection = globalThis.canvas?.scene?.tokens ?? globalThis.canvas?.tokens;
    if (!collection) return true;
    try {
        if (typeof collection.get === "function" && collection.get(tokenId)) return true;
        if (typeof collection.has === "function" && collection.has(tokenId)) return true;
    } catch(_err) {
        // Fall through to the contents scan below.
    }
    const list = collection.contents
        ?? (typeof collection[Symbol.iterator] === "function" ? [...collection] : []);
    return list.some(t => (t?.id ?? t?.document?.id) === tokenId);
}

/**
 * Read the sanitized memory flag of a combatant.
 * @param {object} combatant
 * @returns {object}
 */
function _readMemory(combatant) {
    if (!combatant) return {};
    try {
        if (typeof combatant.getFlag === "function") {
            return sanitizeMemory(combatant.getFlag(MODULE_ID, FLAG_KEYS.memory));
        }
    } catch(_err) {
        // Fall back to the raw flags object below.
    }
    return sanitizeMemory(combatant.flags?.[MODULE_ID]?.[FLAG_KEYS.memory]);
}

/**
 * FNV-1a fingerprint used for the deterministic snapshot revision.
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
 * Deep-freeze helper for immutable snapshots and entries.
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
 * Build an immutable `PerceptionSnapshot` for an AI combatant.
 *
 * - `visibleTargets` — currently seen, attackable targets with token UUID
 *   and live geometry;
 * - `lastKnownTargets` — remembered contacts without current LOS, holding
 *   only the sanitized last-known record (movement/search allowed, direct
 *   attacks not); visible contacts are excluded;
 * - `revision` — deterministic fingerprint of the inputs, identical for
 *   identical world state;
 * - `status` is `"perception-unavailable"` when there is no scene/canvas
 *   or no viewer token — callers retry after `canvasReady`, never fall
 *   back to the GM-visible token collection.
 * @param {object} [input]
 * @param {object} [input.combat]
 * @param {object} [input.combatant]
 * @param {object} [input.token] Viewer token of the combatant.
 * @returns {object} Frozen snapshot.
 */
export function buildPerceptionSnapshot({ combat = null, combatant = null, token = null } = {}) {
    if (!globalThis.canvas?.scene || !token) {
        return _deepFreeze({
            status: PERCEPTION_STATUS.unavailable,
            combatId: combat?.id ?? null,
            combatantId: combatant?.id ?? null,
            sceneId: globalThis.canvas?.scene?.id ?? null,
            round: combat?.round ?? 0,
            turn: combat?.turn ?? 0,
            viewer: null,
            visibleTargets: [],
            lastKnownTargets: [],
            revision: null
        });
    }

    const sceneId = globalThis.canvas.scene.id ?? null;
    const round = Number.isFinite(combat?.round) ? combat.round : 0;
    const turn = Number.isFinite(combat?.turn) ? combat.turn : 0;
    const visible = visibleTargets(token, { combat });
    const visibleUuids = new Set(visible.map(t => t.tokenUuid).filter(Boolean));
    const memory = pruneMemory(expireMemoryEntries(_readMemory(combatant), round), {
        sceneId,
        tokenExists: _tokenExistsOnScene
    });
    const lastKnownTargets = Object.entries(memory)
        .filter(([uuid]) => !visibleUuids.has(uuid))
        .map(([tokenUuid, entry]) => ({ tokenUuid, ...entry }))
        .sort((a, b) => a.tokenUuid.localeCompare(b.tokenUuid));

    const viewerDoc = _tokenDocument(token);
    const position = _positionOf(token);
    const revision = _fnv1a(JSON.stringify({
        sceneId,
        round,
        turn,
        viewer: [viewerDoc?.id ?? null, position?.x ?? null, position?.y ?? null],
        visible: visible.map(t => t.tokenUuid).sort(),
        lastKnown: lastKnownTargets.map(t => t.tokenUuid)
    }));

    return _deepFreeze({
        status: PERCEPTION_STATUS.ok,
        combatId: combat?.id ?? null,
        combatantId: combatant?.id ?? null,
        sceneId,
        round,
        turn,
        viewer: {
            tokenId: viewerDoc?.id ?? null,
            tokenUuid: _tokenUuid(token),
            x: position?.x ?? null,
            y: position?.y ?? null,
            elevation: _elevationOf(token)
        },
        visibleTargets: visible,
        lastKnownTargets,
        revision
    });
}

/**
 * Numeric helper: value if finite (or a numeric string), else fallback.
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function _finiteOr(value, fallback) {
    if (Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
        return Number(value);
    }
    return fallback;
}

/**
 * Expected damage of a damage spec: plain numbers, `{formula}` objects or
 * dice strings like `1d10+3` (evaluated deterministically as the mean).
 * @param {*} value
 * @returns {number}
 */
function _expectedDamage(value) {
    if (Number.isFinite(value)) return value;
    const formula = typeof value === "object" && value !== null ? value.formula : value;
    if (Number.isFinite(formula)) return formula;
    if (typeof formula !== "string") return 0;
    const trimmed = formula.trim();
    if (trimmed === "") return 0;
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
 * Item list of an actor-like document.
 * @param {object} actor
 * @returns {object[]}
 */
function _itemList(actor) {
    const items = actor?.items;
    if (Array.isArray(items)) return items;
    if (Array.isArray(items?.contents)) return items.contents;
    if (items && typeof items[Symbol.iterator] === "function") return [...items];
    return [];
}

/**
 * Weapon range in scene units; melee weapons default to a 2 m reach.
 * @param {object} system Weapon `system` data.
 * @returns {number}
 */
function _weaponRange(system) {
    const raw = system?.range;
    const value = Number.isFinite(raw) ? raw : _finiteOr(raw?.value, NaN);
    if (Number.isFinite(value) && value > 0) return value;
    return system?.class === "melee" ? 2 : 0;
}

/**
 * Attack profile of an NPC: `{range, damage, penetration}` taken either
 * from a plain profile object or derived from the strongest weapon item of
 * an actor-like document (best expected damage + penetration wins).
 * @param {object} npc Plain profile, token or actor-like document.
 * @returns {{range: number, damage: number, penetration: number}}
 */
function _attackProfileOf(npc) {
    if (!npc) return { range: 0, damage: 0, penetration: 0 };
    if (Number.isFinite(npc.damage) || Number.isFinite(npc.penetration) || Number.isFinite(npc.range)) {
        return {
            range: _finiteOr(npc.range, 0),
            damage: _finiteOr(npc.damage, _expectedDamage(npc.damage)),
            penetration: _finiteOr(npc.penetration, 0)
        };
    }
    const actor = npc.actor ?? npc;
    let best = { range: 0, damage: 0, penetration: 0 };
    let bestPower = 0;
    for (const item of _itemList(actor)) {
        if (item?.type !== "weapon") continue;
        const system = item.system ?? {};
        const damage = _expectedDamage(system.damage);
        const penetration = _finiteOr(system.penetration ?? system.pen, 0);
        const range = _weaponRange(system);
        const power = damage + penetration;
        if (power > bestPower || (power === bestPower && power > 0 && range > best.range)) {
            best = { range, damage, penetration };
            bestPower = power;
        }
    }
    return best;
}

/**
 * Highest armour value found under `actor.system.armour`, scanning numeric
 * leaves (per-location armour blocks or a flat value).
 * @param {object} actor
 * @returns {number}
 */
function _armourOf(actor) {
    let best = 0;
    const visit = value => {
        if (Number.isFinite(value)) {
            if (value > best) best = value;
            return;
        }
        if (value && typeof value === "object") {
            for (const key of Object.keys(value)) visit(value[key]);
        }
    };
    visit(actor?.system?.armour);
    return best;
}

/**
 * Normalized target inputs for scoring. Missing `threat` falls back to the
 * target's own best weapon damage; missing `armour` scans the actor's
 * armour data.
 * @param {object} target Target entry, token or plain profile.
 * @returns {{distance: number|null, threat: number, armour: number, canAttack: boolean|undefined}}
 */
function _targetProfileOf(target) {
    const actor = target?.actor ?? null;
    return {
        distance: Number.isFinite(target?.distance) ? target.distance : null,
        threat: Number.isFinite(target?.threat) ? target.threat : _attackProfileOf(actor).damage,
        armour: Number.isFinite(target?.armour) ? target.armour : _armourOf(actor),
        canAttack: target?.canAttack
    };
}

/**
 * Clamp a number into the [0, 1] interval.
 * @param {number} value
 * @returns {number}
 */
function _clamp01(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
}

/**
 * Approximate hit effectiveness `damage + penetration − armour`, mapped to
 * a bounded 0–1 factor (`x / (x + 10)`).
 * @param {object} profile Attack profile.
 * @param {object} targetProfile Target profile.
 * @returns {number}
 */
function _expectedEffectiveness(profile, targetProfile) {
    const expected = Math.max(
        0,
        (profile.damage ?? 0) + (profile.penetration ?? 0) - (targetProfile.armour ?? 0)
    );
    return expected <= 0 ? 0 : expected / (expected + 10);
}

/**
 * Pure, deterministic target utility score.
 *
 * Components (each in 0–1, weighted by `context.weights` merged over
 * {@link DEFAULT_SCORE_WEIGHTS}):
 * - `canAttack` — target flagged attackable *and* inside the NPC weapon
 *   range (when a positive range is known);
 * - `effectiveness` — expected damage + penetration minus target armour;
 * - `threat` — target's own damage potential;
 * - `distance` — closeness factor `1 / (1 + d/10)`.
 *
 * `canAttack` contributes `+weight` when attackable and `−weight` when not,
 * so an unreachable or non-attackable target always ranks below every
 * attackable one under the default weights. The function never reads
 * `game`/`canvas`: identical inputs produce identical scores.
 * @param {object} npc Plain `{range, damage, penetration}` profile or an
 *   actor-like document with weapon items.
 * @param {object} target Target entry (`distance`, `threat`, `armour`,
 *   `canAttack`) or token-like object.
 * @param {object} [context]
 * @param {object} [context.weights] Weight overrides from the active preset.
 * @returns {{score: number, components: object, weights: object}} Frozen result.
 */
export function scoreTarget(npc, target, context = {}) {
    const weights = { ...DEFAULT_SCORE_WEIGHTS, ...(context?.weights ?? {}) };
    const profile = _attackProfileOf(npc);
    const targetProfile = _targetProfileOf(target);
    const inRange = profile.range > 0 && Number.isFinite(targetProfile.distance)
        ? (targetProfile.distance <= profile.range ? 1 : 0)
        : 1;
    const canAttack = targetProfile.canAttack === false ? 0 : inRange;
    const components = {
        canAttack,
        inRange,
        effectiveness: _expectedEffectiveness(profile, targetProfile),
        threat: _clamp01((targetProfile.threat ?? 0) / 20),
        distance: 1 / (1 + (Math.max(0, targetProfile.distance ?? 0) / 10))
    };
    const score = (weights.canAttack * (canAttack ? 1 : -1))
        + (weights.effectiveness * components.effectiveness)
        + (weights.threat * components.threat)
        + (weights.distance * components.distance);
    return Object.freeze({
        score,
        components: Object.freeze(components),
        weights: Object.freeze(weights)
    });
}

/**
 * Rank targets by score: descending score, deterministic tie-break on
 * `tokenId`. Each entry is `{target, score, components, weights}`.
 * @param {object} npc
 * @param {object[]} targets
 * @param {object} [context]
 * @returns {object[]}
 */
export function rankTargets(npc, targets, context = {}) {
    return (targets ?? [])
        .map(target => Object.freeze({ target, ...scoreTarget(npc, target, context) }))
        .sort((a, b) => (b.score - a.score)
            || String(a.target?.tokenId ?? "").localeCompare(String(b.target?.tokenId ?? "")));
}

/**
 * Whether a `updateToken` change can affect perception or memory
 * (position, elevation, visibility, disposition, size).
 * @param {object} change The update diff object.
 * @returns {boolean}
 */
export function isRelevantTokenUpdate(change) {
    if (!change || typeof change !== "object") return false;
    return TOKEN_UPDATE_KEYS.some(key => Object.prototype.hasOwnProperty.call(change, key));
}

/**
 * Whether an `updateCombat` change is relevant (round or turn advanced).
 * @param {object} change The update diff object.
 * @returns {boolean}
 */
export function isRelevantCombatUpdate(change) {
    if (!change || typeof change !== "object") return false;
    return Object.prototype.hasOwnProperty.call(change, "round")
        || Object.prototype.hasOwnProperty.call(change, "turn");
}

/**
 * Create the `perception` service published as
 * `api.services.get("perception")`.
 *
 * The service wraps the pure helpers above with live Foundry state and
 * debounced hook maintenance: relevant `updateCombat`/`updateToken`/
 * `deleteToken` changes and `canvasReady` retries coalesce into a single
 * memory refresh per burst (~150 ms). Memory flags are written only when
 * this client is the authority controller.
 * @param {object} [deps]
 * @param {object} [deps.api] Module API (for the optional `authority` service).
 * @param {object} [deps.hooks] Hook bus, defaults to global `Hooks`.
 * @returns {object} Perception service.
 */
export function createPerceptionService({ api = null, hooks = null } = {}) {
    const hookBus = hooks ?? globalThis.Hooks;
    const timers = new Map();
    const state = {
        started: false,
        pendingCombat: null
    };

    /**
     * Whether this client may write persistent combatant memory: the
     * elected authority controller when the #400 service is present,
     * otherwise any GM client.
     * @returns {boolean}
     */
    function isController() {
        const authority = api?.services?.get?.("authority");
        if (authority && typeof authority.isController === "function") {
            return authority.isController() === true;
        }
        return globalThis.game?.user?.isGM === true;
    }

    /**
     * Combatants of a combat as a plain array.
     * @param {object} combat
     * @returns {object[]}
     */
    function _combatantList(combat) {
        const collection = combat?.combatants;
        if (Array.isArray(collection?.contents)) return collection.contents;
        if (collection && typeof collection[Symbol.iterator] === "function") return [...collection];
        return [];
    }

    /**
     * Resolve a token-like argument to its combatant in `game.combat`.
     * @param {object} doc Combatant or token.
     * @returns {object|null}
     */
    function _combatantOf(doc) {
        if (!doc) return null;
        if (doc.documentName === "Combatant" || ("token" in doc && "actor" in doc)) return doc;
        const tokenId = _tokenDocument(doc)?.id ?? doc.id;
        if (!tokenId) return null;
        return _combatantList(globalThis.game?.combat)
            .find(c => (c?.tokenId ?? _tokenDocument(c?.token)?.id) === tokenId) ?? null;
    }

    /**
     * Persist a memory map on a combatant document.
     * @param {object} combatant
     * @param {object} memory
     * @returns {Promise<void>}
     */
    async function _writeMemory(combatant, memory) {
        if (typeof combatant?.setFlag === "function") {
            const entries = Object.entries(memory ?? {})
                .map(([tokenUuid, entry]) => ({ tokenUuid, ...entry }));
            await combatant.setFlag(MODULE_ID, FLAG_KEYS.memory, entries);
        } else if (combatant && typeof combatant === "object") {
            combatant.flags = combatant.flags ?? {};
            combatant.flags[MODULE_ID] = {
                ...(combatant.flags[MODULE_ID] ?? {}),
                [FLAG_KEYS.memory]: memory
            };
        }
    }

    /**
     * Record every currently visible target of a combatant's token into its
     * memory flag: fresh positions reset the age, expired and stale entries
     * are pruned. Persisted only on the authority controller.
     * @param {object} combat Combat document.
     * @param {object} combatant Combatant whose NPC observes.
     * @returns {Promise<object>} Resulting memory map (frozen).
     */
    async function rememberPositions(combat, combatant) {
        if (!combat || !combatant) return Object.freeze({});
        const token = combatant.token ?? null;
        const sceneId = globalThis.canvas?.scene?.id ?? combat.scene?.id ?? null;
        const round = Number.isFinite(combat.round) ? combat.round : 0;
        const turn = Number.isFinite(combat.turn) ? combat.turn : 0;
        let memory = pruneMemory(expireMemoryEntries(_readMemory(combatant), round), {
            sceneId,
            tokenExists: _tokenExistsOnScene
        });
        if (token && globalThis.canvas?.scene) {
            for (const target of visibleTargets(token, { combat })) {
                if (!target.tokenUuid) continue;
                memory = rememberContact(memory, {
                    tokenUuid: target.tokenUuid,
                    sceneId: target.sceneId ?? sceneId,
                    x: target.x,
                    y: target.y,
                    elevation: target.elevation,
                    lastSeenRound: round,
                    lastSeenTurn: turn,
                    dispositionAtDetection: target.disposition
                });
            }
        }
        if (isController()) await _writeMemory(combatant, memory);
        return Object.freeze(memory);
    }

    /**
     * Sanitized last-known contacts of a combatant (or the combatant owning
     * a token), already expired/pruned — never current hidden positions.
     * @param {object} doc Combatant or token.
     * @returns {object[]} Sorted `{tokenUuid, sceneId, x, y, elevation,
     *   lastSeenRound, lastSeenTurn, dispositionAtDetection}` entries.
     */
    function lastKnownPositions(doc) {
        const combatant = _combatantOf(doc);
        const memory = pruneMemory(
            expireMemoryEntries(_readMemory(combatant), globalThis.game?.combat?.round ?? 0),
            {
                sceneId: globalThis.canvas?.scene?.id ?? globalThis.game?.combat?.scene?.id ?? null,
                tokenExists: _tokenExistsOnScene
            }
        );
        return Object.entries(memory)
            .map(([tokenUuid, entry]) => Object.freeze({ tokenUuid, ...entry }))
            .sort((a, b) => a.tokenUuid.localeCompare(b.tokenUuid));
    }

    /**
     * Expire every combatant memory map at the given combat round and prune
     * entries for other scenes/deleted tokens. Returns the number of
     * removed entries.
     * @param {object} combat Combat document.
     * @param {number} [round] Current round, defaults to `combat.round`.
     * @returns {Promise<number>}
     */
    async function expireMemory(combat, round) {
        const currentRound = Number.isFinite(round) ? round : combat?.round ?? 0;
        const sceneId = globalThis.canvas?.scene?.id ?? combat?.scene?.id ?? null;
        let removed = 0;
        for (const combatant of _combatantList(combat)) {
            const stored = _readMemory(combatant);
            const count = Object.keys(stored).length;
            if (!count) continue;
            const next = pruneMemory(expireMemoryEntries(stored, currentRound), {
                sceneId,
                tokenExists: _tokenExistsOnScene
            });
            const remaining = Object.keys(next).length;
            if (remaining === count) continue;
            removed += count - remaining;
            if (isController()) await _writeMemory(combatant, next);
        }
        return removed;
    }

    /**
     * Forget one token uuid across all combatant memory maps (deleted or
     * scene-changed token).
     * @param {string} tokenUuid
     * @returns {Promise<number>} Number of memory maps cleaned.
     */
    async function forgetToken(tokenUuid) {
        if (typeof tokenUuid !== "string" || !tokenUuid) return 0;
        let removed = 0;
        for (const combatant of _combatantList(globalThis.game?.combat)) {
            const stored = _readMemory(combatant);
            if (!(tokenUuid in stored)) continue;
            const next = { ...stored };
            delete next[tokenUuid];
            removed++;
            if (isController()) await _writeMemory(combatant, next);
        }
        return removed;
    }

    /**
     * Debounce a memory refresh task per key.
     * @param {string} key
     * @param {Function} task
     * @param {number} [delay]
     */
    function _schedule(key, task, delay = 150) {
        if (timers.has(key)) clearTimeout(timers.get(key));
        timers.set(key, setTimeout(() => {
            timers.delete(key);
            Promise.resolve().then(task).catch(err => {
                console.error(`${MODULE_ID} | perception refresh failed`, err);
            });
        }, delay));
    }

    /**
     * Expire combat memory and re-record visible contacts of every
     * AI-enabled combatant. Deferred to `canvasReady` while the canvas is
     * unavailable — never falls back to GM visibility.
     * @param {object} combat
     * @returns {Promise<void>}
     */
    async function _refreshCombat(combat) {
        if (!combat) return;
        if (!globalThis.canvas?.scene) {
            state.pendingCombat = combat;
            return;
        }
        await expireMemory(combat, combat.round);
        for (const combatant of _combatantList(combat)) {
            if (!isAiEnabled(combatant)) continue;
            await rememberPositions(combat, combatant);
        }
        logDiagnostics("perception: memory refreshed", {
            combat: combat.id,
            round: combat.round
        });
    }

    const _onUpdateCombat = (combat, change) => {
        if (!isRelevantCombatUpdate(change)) return;
        _schedule("combat", () => _refreshCombat(combat));
    };

    const _onUpdateToken = (tokenDoc, change) => {
        if (!isRelevantTokenUpdate(change)) return;
        _schedule("tokens", () => _refreshCombat(globalThis.game?.combat));
    };

    const _onDeleteToken = tokenDoc => {
        const uuid = tokenDoc?.uuid ?? (tokenDoc?.id
            ? `Scene.${tokenDoc.parent?.id ?? globalThis.canvas?.scene?.id ?? "scene"}.Token.${tokenDoc.id}`
            : null);
        if (!uuid) return;
        _schedule("delete", () => forgetToken(uuid));
    };

    const _onCanvasReady = () => {
        const pending = state.pendingCombat;
        state.pendingCombat = null;
        if (pending) _schedule("pending", () => _refreshCombat(pending));
    };

    /**
     * Subscribe the watcher hooks. Idempotent.
     */
    function start() {
        if (state.started || typeof hookBus?.on !== "function") return;
        state.started = true;
        hookBus.on("updateCombat", _onUpdateCombat);
        hookBus.on("updateToken", _onUpdateToken);
        hookBus.on("deleteToken", _onDeleteToken);
        hookBus.on("canvasReady", _onCanvasReady);
    }

    /**
     * Unsubscribe hooks and cancel pending refreshes.
     */
    function stop() {
        if (!state.started) return;
        state.started = false;
        hookBus?.off?.("updateCombat", _onUpdateCombat);
        hookBus?.off?.("updateToken", _onUpdateToken);
        hookBus?.off?.("deleteToken", _onDeleteToken);
        hookBus?.off?.("canvasReady", _onCanvasReady);
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
        state.pendingCombat = null;
    }

    return {
        start,
        stop,
        isController,
        hasLineOfSight,
        measureDistance,
        visibleTargets,
        buildPerceptionSnapshot,
        scoreTarget,
        rankTargets,
        rememberPositions,
        lastKnownPositions,
        expireMemory,
        forgetToken,
        sanitizeMemory,
        isRelevantTokenUpdate,
        isRelevantCombatUpdate,
        /**
         * Whether the watcher hooks are currently subscribed.
         * @returns {boolean}
         */
        get started() {
            return state.started;
        }
    };
}
