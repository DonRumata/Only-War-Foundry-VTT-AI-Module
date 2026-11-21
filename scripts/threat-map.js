/**
 * Threat map service (issue #16): an aggregated influence/danger field of
 * the combat scene, built once per AI plan and shared by every scoring
 * decision.
 *
 * Design contract (epic #363):
 * - A threat source is a known enemy with a resolved weapon profile — one
 *   or more *emitters* `{ev, range, melee}` derived from the enemy actor's
 *   weapon items (or injected directly in tests). `ev` is the expected
 *   damage of a single hit (dice formulas evaluate to their mean);
 *   `range` is the weapon reach in scene units; melee emitters threaten
 *   their melee reach plus a charge allowance with a linear falloff.
 * - `dangerAt(point)` returns a normalized `0..1` score: the sum of
 *   per-source contributions capped at 1. A ranged emitter contributes
 *   its full normalized strength `min(1, ev / referenceDamage)` whenever
 *   the point sits inside weapon range; melee emitters contribute full
 *   strength inside melee reach and decay linearly to zero across the
 *   charge allowance. A wall-check LOS probe gates every contribution;
 *   without a probe the threat pessimistically counts (the bot assumes
 *   the enemy can shoot).
 * - The map complements the `cover`/`exposure` factors instead of
 *   replacing them: cover measures walls against the *planned* target
 *   only, while danger aggregates every known enemy's effective range —
 *   a cell safe from the current target may still be a kill lane for a
 *   second shooter.
 * - Deterministic and read-only: the map never touches documents, holds
 *   no Document references and reproduces identical values for identical
 *   input. The service is a thin stateful wrapper — `refresh(input)`
 *   builds the map once per plan, `dangerAt(point)` queries it.
 */
import { createGridAdapter } from "./navigation.js";
import { logDiagnostics } from "./settings.js";

/**
 * Reference expected damage that maps a threat emitter to full strength
 * (`ev / referenceDamage >= 1`). Roughly the EV of a lasgun hit.
 */
export const DEFAULT_REFERENCE_DAMAGE = 10;

/** Melee reach in scene units used for melee threat emitters. */
export const DEFAULT_MELEE_REACH = 2;

/**
 * Additional scene units a melee enemy may cover with a charge/full move
 * to reach a cell; threat decays linearly across this band.
 */
export const DEFAULT_MELEE_ALLOWANCE = 6;

/** Maximum emitters kept per actor (a combatant fires one weapon anyway). */
const MAX_EMITTERS_PER_SOURCE = 2;

/**
 * Expected damage of a damage spec: numbers pass through, dice strings
 * (`1d10+3`) evaluate deterministically to their mean.
 * @param {*} value
 * @returns {number}
 */
export function expectedDamageOf(value) {
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
 * Unwrap a Token placeable to its TokenDocument; documents pass through.
 * @param {*} token
 * @returns {object|null}
 */
function _tokenDoc(token) {
    if (!token || typeof token !== "object") return null;
    const doc = token.document;
    if (doc && typeof doc === "object" && doc.documentName === "Token") return doc;
    return token;
}

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
 * Deep-freeze helper for immutable map descriptors.
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
 * Weapon emitters of an actor — the loadout summary a threat source
 * projects onto the map. Melee weapons emit on their melee reach;
 * ranged weapons on their `system.range`. At most
 * {@link MAX_EMITTERS_PER_SOURCE} entries survive, sorted by expected
 * damage so the best weapon profiles win.
 * @param {object|null} actor Actor document with `items`.
 * @returns {object[]} Emitters `{ev, range, melee}`.
 */
export function weaponEmitters(actor) {
    const emitters = [];
    for (const item of _list(actor?.items)) {
        if (item?.type !== "weapon") continue;
        const melee = String(item.system?.class ?? "").toLowerCase() === "melee";
        const ev = expectedDamageOf(item.system?.damage ?? 0);
        if (!(ev > 0)) continue;
        emitters.push({
            ev,
            range: melee ? DEFAULT_MELEE_REACH : _finiteOr(item.system?.range, 0),
            melee
        });
    }
    emitters.sort((a, b) => (b.ev - a.ev)
        || (Number(b.melee) - Number(a.melee))
        || (b.range - a.range));
    return emitters.slice(0, MAX_EMITTERS_PER_SOURCE);
}

/**
 * Normalize one emitter entry `{ev|damage, range, melee}`.
 * @param {object} raw
 * @returns {object|null}
 */
function _normalizeEmitter(raw) {
    if (!raw || typeof raw !== "object") return null;
    const ev = expectedDamageOf(raw.ev ?? raw.damage ?? 0);
    if (!(ev > 0)) return null;
    const melee = raw.melee === true;
    return {
        ev,
        range: melee ? DEFAULT_MELEE_REACH : _finiteOr(raw.range, 0),
        melee
    };
}

/**
 * Normalize one threat source into `{id, x, y, emitters}`. Accepts a
 * resolved emitter list (`emitters`) or a single-profile shorthand
 * (`ev`/`damage`, `range`, `melee`). Entries without a position or a
 * positive-EV emitter drop out — contacts with unknown loadouts do not
 * project threat (the heuristic `threat` factor still covers them).
 * @param {object} raw
 * @param {number} index
 * @returns {object|null}
 */
function _normalizeThreat(raw, index) {
    if (!raw || typeof raw !== "object") return null;
    const x = _finiteOr(raw.x, null);
    const y = _finiteOr(raw.y, null);
    if (x === null || y === null) return null;
    let emitters = Array.isArray(raw.emitters)
        ? raw.emitters.map(_normalizeEmitter).filter(Boolean)
        : [];
    if (!emitters.length) {
        const single = _normalizeEmitter(raw);
        if (single) emitters = [single];
    }
    if (!emitters.length) return null;
    return {
        id: raw.tokenUuid ?? raw.tokenId ?? raw.id ?? `threat-${index}`,
        tokenId: raw.tokenId ?? null,
        tokenUuid: raw.tokenUuid ?? null,
        x,
        y,
        emitters
    };
}

/**
 * Scene-unit distance between two pixel points. Without grid info the
 * inputs are assumed to already be in scene units.
 * @param {{x: number, y: number}} a
 * @param {{x: number, y: number}} b
 * @param {object|null} grid `{size, distance}` — pixels per scene unit.
 * @returns {number}
 */
function _distanceUnits(a, b, grid) {
    const px = Math.hypot(b.x - a.x, b.y - a.y);
    const size = _finiteOr(grid?.size, 0);
    const unit = _finiteOr(grid?.distance, 0);
    return size > 0 && unit > 0 ? px / size * unit : px;
}

/**
 * Default sight probe between two pixel points through the grid adapter
 * (v13 polygon backends → `canvas.walls.checkCollision` → manual wall
 * segments). Returns null when no adapter/scene is available — the map
 * then treats every line as open.
 * @returns {Function|null}
 */
function _defaultLosProbe() {
    try {
        const adapter = createGridAdapter();
        if (adapter?.describe?.()) {
            return (a, b) => adapter.hasLineOfSight(a, b);
        }
    } catch(_err) {
        // No canvas/scene — the map runs probeless.
    }
    return null;
}

/**
 * Resolve the LOS gate probe: `false`/`null` disables the gate (all
 * lines open), a function is used directly, anything else resolves the
 * wall-geometry default.
 * @param {Function|boolean|null|undefined} los
 * @returns {Function|null}
 */
function _resolveProbe(los) {
    if (los === false || los === null) return null;
    return typeof los === "function" ? los : _defaultLosProbe();
}

/**
 * Whether the sight line `from → point` is open under `probe`. A missing
 * or throwing probe treats the line as open — a threat we cannot
 * disprove still counts.
 * @param {Function|null} probe
 * @param {{x: number, y: number}} from
 * @param {{x: number, y: number}} point
 * @returns {boolean}
 */
function _losOpen(probe, from, point) {
    if (probe === null) return true;
    try {
        return probe(from, point) !== false;
    } catch(_err) {
        return true;
    }
}

/**
 * Build an immutable threat map over a fixed set of threat sources.
 * The returned object is frozen except for the two closures
 * (`dangerAt`, `explain`) that evaluate points on demand — the sources,
 * probe and grid were fixed at build time, so evaluation is pure and
 * deterministic.
 * @param {object} input
 * @param {object[]} input.threats Threat sources `{x, y, emitters?|
 *   ev|damage, range?, melee?}` in pixel coordinates.
 * @param {Function|null} [input.los] Sight probe `(from, to) => boolean`
 *   on pixel points; null/undefined resolves the wall-geometry default,
 *   `false` disables the LOS gate entirely.
 * @param {object|null} [input.grid] Grid info `{size, distance}` for the
 *   pixel→scene-unit conversion.
 * @param {number} [input.referenceDamage] EV mapping to full strength.
 * @param {number} [input.meleeReach] Melee reach in scene units.
 * @param {number} [input.meleeAllowance] Charge band beyond melee reach.
 * @returns {object} Frozen map `{threats, referenceDamage, meleeReach,
 *   meleeAllowance, dangerAt(point), explain(point)}`.
 */
export function buildThreatMap({
    threats = [],
    los,
    grid = null,
    referenceDamage = DEFAULT_REFERENCE_DAMAGE,
    meleeReach = DEFAULT_MELEE_REACH,
    meleeAllowance = DEFAULT_MELEE_ALLOWANCE
} = {}) {
    const sources = (threats ?? [])
        .map(_normalizeThreat)
        .filter(Boolean)
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const reference = Number.isFinite(referenceDamage) && referenceDamage > 0
        ? referenceDamage : DEFAULT_REFERENCE_DAMAGE;
    const reach = Number.isFinite(meleeReach) && meleeReach > 0
        ? meleeReach : DEFAULT_MELEE_REACH;
    const allowance = Number.isFinite(meleeAllowance) && meleeAllowance > 0
        ? meleeAllowance : DEFAULT_MELEE_ALLOWANCE;
    const probe = _resolveProbe(los);

    /**
     * Danger contribution of one emitter against `point` (0..1).
     * @param {object} source Normalized threat source.
     * @param {object} emitter `{ev, range, melee}`.
     * @param {number} distance Distance in scene units.
     * @returns {number}
     */
    function _emitterContribution(source, emitter, distance) {
        const strength = Math.min(1, emitter.ev / reference);
        if (strength <= 0) return 0;
        if (emitter.melee) {
            if (distance <= reach + 1e-9) return strength;
            if (distance >= reach + allowance) return 0;
            return strength * (1 - ((distance - reach) / allowance));
        }
        return emitter.range > 0 && distance <= emitter.range + 1e-9 ? strength : 0;
    }

    /**
     * Per-source contribution records for `point` (deterministic order).
     * @param {{x: number, y: number}} point
     * @returns {object[]} `{id, contribution}` entries.
     */
    function explain(point) {
        if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return [];
        const entries = [];
        for (const source of sources) {
            const distance = _distanceUnits({ x: source.x, y: source.y }, point, grid);
            if (!Number.isFinite(distance)) continue;
            const contribution = Math.max(0, ...source.emitters.map(
                emitter => _emitterContribution(source, emitter, distance)));
            if (contribution > 0 && _losOpen(probe, { x: source.x, y: source.y }, point)) {
                entries.push({
                    id: source.id,
                    contribution: Math.round(contribution * 1e4) / 1e4
                });
            }
        }
        return entries;
    }

    /**
     * Aggregated danger of `point`: the capped sum of every known threat
     * source able to cover it. 0 = uncovered, 1 = saturated kill lane.
     * @param {{x: number, y: number}} point
     * @returns {number} 0..1.
     */
    function dangerAt(point) {
        const entries = explain(point);
        if (!entries.length) return 0;
        const total = entries.reduce((sum, entry) => sum + entry.contribution, 0);
        return Math.round(Math.min(1, total) * 1e4) / 1e4;
    }

    return _deepFreeze({
        threats: sources,
        referenceDamage: reference,
        meleeReach: reach,
        meleeAllowance: allowance,
        dangerAt,
        explain
    });
}

/**
 * Expected counter damage of the strongest enemy emitter able to respond
 * at `point` — the raw model behind the planner's 2-ply lookahead
 * (issue #16). A ranged emitter counters when the point sits inside its
 * weapon range under an open sight line; a melee emitter counters when
 * the point lies within `meleeReach + meleeAllowance`. The result is the
 * maximum single-emitter EV (an enemy attacks once) — no normalization,
 * no world simulation, fully deterministic.
 * @param {{x: number, y: number}} point Candidate endpoint in pixels.
 * @param {object[]} threats Raw or normalized threat sources (same shape
 *   {@link buildThreatMap} accepts).
 * @param {object} [options]
 * @param {object|null} [options.grid] `{size, distance}` conversion info.
 * @param {Function|boolean|null} [options.los] Sight probe or `false`.
 * @param {number} [options.meleeReach] Melee reach in scene units.
 * @param {number} [options.meleeAllowance] Melee charge band.
 * @returns {number} Expected counter damage (0 = no responder).
 */
export function expectedCounterDamage(point, threats, {
    grid = null,
    los,
    meleeReach = DEFAULT_MELEE_REACH,
    meleeAllowance = DEFAULT_MELEE_ALLOWANCE
} = {}) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return 0;
    const reach = Number.isFinite(meleeReach) && meleeReach > 0
        ? meleeReach : DEFAULT_MELEE_REACH;
    const allowance = Number.isFinite(meleeAllowance) && meleeAllowance > 0
        ? meleeAllowance : DEFAULT_MELEE_ALLOWANCE;
    const probe = _resolveProbe(los);
    let best = 0;
    for (const source of (threats ?? []).map(_normalizeThreat).filter(Boolean)) {
        const distance = _distanceUnits({ x: source.x, y: source.y }, point, grid);
        if (!Number.isFinite(distance)) continue;
        const reachable = source.emitters.some(emitter =>
            emitter.melee
                ? distance <= reach + allowance + 1e-9
                : (emitter.range > 0 && distance <= emitter.range + 1e-9));
        if (!reachable) continue;
        if (!_losOpen(probe, { x: source.x, y: source.y }, point)) continue;
        best = Math.max(best, ...source.emitters.map(emitter => emitter.ev));
    }
    return Math.round(best * 1e4) / 1e4;
}

/**
 * Derive threat sources from normalized planner targets: explicit
 * `threatProfile`/`emitters`/`damage`-fields win, then the target's own
 * token document's actor loadout.
 * @param {object[]} targets Planner-normalized targets `{tokenId,
 *   tokenUuid, x, y}` (optionally `emitters`, `damage`, `range`,
 *   `melee`, `threatProfile`).
 * @param {object} input
 * @param {object|null} input.combat Combat for combatant-token lookup.
 * @param {object|null} input.scene Scene for token lookup.
 * @param {Function} [input.findToken] `(tokenId) => tokenDoc|null`
 *   override (tests); defaults to a combat/scene scan.
 * @returns {object[]} Threat sources for {@link buildThreatMap}.
 */
export function threatSourcesOf(targets, { combat = null, scene = null, findToken = null } = {}) {
    const lookup = typeof findToken === "function"
        ? findToken
        : tokenId => _findTokenDoc(tokenId, { combat, scene });
    const sources = [];
    for (const target of targets ?? []) {
        if (!Number.isFinite(target?.x) || !Number.isFinite(target?.y)) continue;
        const profile = target.threatProfile ?? target;
        let emitters = Array.isArray(profile.emitters)
            ? profile.emitters.map(_normalizeEmitter).filter(Boolean)
            : [];
        if (!emitters.length) {
            const single = _normalizeEmitter(profile);
            if (single) emitters = [single];
        }
        if (!emitters.length) {
            const doc = lookup(target.tokenId ?? target.tokenUuid);
            const actor = _actorOfTarget(doc);
            emitters = weaponEmitters(actor);
        }
        if (!emitters.length) continue;
        sources.push({
            tokenId: target.tokenId ?? null,
            tokenUuid: target.tokenUuid ?? null,
            x: target.x,
            y: target.y,
            emitters
        });
    }
    return sources;
}

/**
 * Token document lookup inside a combat's combatants or the scene's
 * token collection.
 * @param {string|null} tokenId
 * @param {object} input Lookup context.
 * @param {object|null} input.combat Combat providing combatant tokens.
 * @param {object|null} input.scene Scene providing the token collection.
 * @returns {object|null}
 */
function _findTokenDoc(tokenId, { combat = null, scene = null } = {}) {
    if (!tokenId) return null;
    for (const combatant of _list(combat?.combatants)) {
        const doc = _tokenDoc(combatant?.token);
        if (doc && (doc.id === tokenId || combatant.tokenId === tokenId)) return doc;
    }
    const collection = scene?.tokens ?? globalThis.canvas?.scene?.tokens;
    for (const token of _list(collection)) {
        const doc = _tokenDoc(token);
        if (doc?.id === tokenId) return doc;
    }
    return null;
}

/**
 * Actor of a target token document (token doc → actor link).
 * @param {object|null} doc
 * @returns {object|null}
 */
function _actorOfTarget(doc) {
    if (!doc || typeof doc !== "object") return null;
    return doc.actor ?? doc.actorData?.actor ?? null;
}

/**
 * Create the `threatMap` service published as
 * `api.services.get("threatMap")` (issue #16). Stateless between
 * `refresh` calls: the planner rebuilds the map once per plan and every
 * decision of that plan reads the same field.
 * @param {object} [deps]
 * @param {object} [deps.api] Module API for lazy service lookups.
 * @param {Function} [deps.log] Diagnostic logger.
 * @returns {object} Threat-map service `{refresh, buildMap, dangerAt, map}`.
 */
export function createThreatMapService({
    api = null,
    log = (...args) => logDiagnostics(...args)
} = {}) {
    let _current = null;

    /**
     * Build (but do not store) a threat map for one plan.
     * @param {object} input
     * @param {object[]} [input.threats] Explicit threat sources; wins
     *   over `targets`-derived profiles.
     * @param {object[]} [input.targets] Normalized planner targets used
     *   to derive sources when `threats` is absent.
     * @param {object|null} [input.combat] Combat for token lookup.
     * @param {object|null} [input.scene] Scene for token/grid lookup.
     * @param {object|null} [input.grid] `{size, distance}`.
     * @param {Function|boolean|null} [input.los] Sight probe or `false`.
     * @param {number} [input.referenceDamage]
     * @param {number} [input.meleeReach]
     * @param {number} [input.meleeAllowance]
     * @returns {object} Frozen map from {@link buildThreatMap}.
     */
    function buildMap(input = {}) {
        const threats = Array.isArray(input.threats)
            ? input.threats
            : threatSourcesOf(input.targets, {
                combat: input.combat ?? null,
                scene: input.scene ?? null,
                findToken: input.findToken
            });
        return buildThreatMap({
            threats,
            los: input.los,
            grid: input.grid,
            referenceDamage: input.referenceDamage,
            meleeReach: input.meleeReach,
            meleeAllowance: input.meleeAllowance
        });
    }

    /**
     * Rebuild and store the threat map for the current plan. Always
     * returns a usable map — empty input yields an empty field.
     * @param {object} input See {@link buildMap}.
     * @returns {object} The stored frozen map.
     */
    function refresh(input = {}) {
        try {
            _current = buildMap(input);
        } catch(err) {
            _current = buildThreatMap({ threats: [] });
        }
        log(`threat map refresh: threats=${_current.threats.length}`);
        return _current;
    }

    /**
     * Danger of `point` under the last refreshed map (0 without one).
     * @param {{x: number, y: number}} point
     * @returns {number} 0..1.
     */
    function dangerAt(point) {
        try {
            return _current ? _current.dangerAt(point) : 0;
        } catch(_err) {
            return 0;
        }
    }

    return {
        refresh,
        buildMap,
        dangerAt,
        /**
         * The last refreshed map or null.
         * @returns {object|null}
         */
        map() {
            return _current;
        }
    };
}
