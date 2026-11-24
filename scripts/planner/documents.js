/**
 * Planner decomposition (issue #403 follow-up): this module was extracted
 * verbatim from scripts/planner.js — see that file for the design contract.
 * The planner service re-exports the public surface so existing importers
 * and tests keep working.
 */
import {
    FLAG_KEYS,
    MODULE_ID
} from "../constants.js";
import {
    grudgeActive
} from "../grudges.js";
import {
    moralePostureOf
} from "../layers.js";
import {
    MAX_SNAPSHOT_ITEMS,
    RESOURCE_KEYS
} from "./contract.js";
import {
    _blastFromSpecial,
    _finiteOr,
    _list,
    fnv1a,
    stableStringify
} from "./util.js";


/**
 * Unwrap a Token placeable to its TokenDocument; documents pass through.
 * @param {*} token
 * @returns {object|null}
 */
export function _tokenDoc(token) {
    if (!token || typeof token !== "object") return null;
    const doc = token.document;
    if (doc && typeof doc === "object" && doc.documentName === "Token") return doc;
    return token;
}


/**
 * Actor linked to a combatant or token.
 * @param {*} ref
 * @returns {object|null}
 */
export function _actorOf(ref) {
    if (!ref || typeof ref !== "object") return null;
    if (ref.actor && typeof ref.actor === "object") return ref.actor;
    if (ref.documentName === "Actor") return ref;
    if ("system" in ref && !("token" in ref)) return ref;
    return null;
}


/**
 * Top-left position of a token document.
 * @param {object} doc
 * @returns {{x: number|null, y: number|null}}
 */
export function _tokenPosition(doc) {
    const x = doc?._source?.x ?? doc?.x ?? doc?.object?.x;
    const y = doc?._source?.y ?? doc?.y ?? doc?.object?.y;
    return {
        x: Number.isFinite(x) ? x : null,
        y: Number.isFinite(y) ? y : null
    };
}


/**
 * Scene-scoped token UUID, reconstructing one for fixtures without `uuid`.
 * @param {object} doc
 * @param {string|null} sceneId
 * @returns {string|null}
 */
export function _tokenUuid(doc, sceneId) {
    if (typeof doc?.uuid === "string" && doc.uuid) return doc.uuid;
    if (doc?.id) return `Scene.${sceneId ?? "scene"}.Token.${doc.id}`;
    return null;
}


/**
 * Actor UUID, reconstructing a world-scoped id for fixtures.
 * @param {object} actor
 * @returns {string|null}
 */
export function _actorUuid(actor) {
    if (typeof actor?.uuid === "string" && actor.uuid) return actor.uuid;
    return actor?.id ? `Actor.${actor.id}` : null;
}


/**
 * Scene the combat runs on: explicit override, `combat.scene`, then the
 * active canvas scene.
 * @param {object} context
 * @param {object} combat
 * @returns {object|null}
 */
export function _sceneOf(context, combat) {
    return context.scene ?? combat?.scene ?? globalThis.canvas?.scene ?? null;
}


/**
 * Cheap collision fingerprint of a scene: sorted wall ids + geometry +
 * door state. Recomputed at validation time without touching navigation.
 * @param {object|null} scene
 * @returns {string|null} FNV-1a fingerprint or null when walls are
 *   unavailable on both sides (treated as "unchanged").
 */
export function _collisionRevision(scene) {
    const walls = _list(scene?.walls);
    if (!walls.length) return null;
    const parts = walls
        .map(wall => {
            const doc = wall?.document ?? wall;
            const coords = doc?.c ?? doc?.coords ?? null;
            const door = doc?.door?.state ?? doc?.doorState ?? doc?.ds ?? null;
            const move = doc?.move ?? doc?.movement ?? null;
            return `${doc?.id ?? "?"}|${Array.isArray(coords) ? coords.join(",") : ""}|${door}|${move}`;
        })
        .sort();
    return fnv1a(parts.join(";"));
}


/**
 * Serialized resource summary of an actor: only numeric `{value[, max]}`
 * pairs and plain numbers from the allow-list keys.
 * @param {object|null} actor
 * @returns {object}
 */
export function _resourcesOf(actor) {
    const resources = {};
    const system = actor?.system ?? {};
    for (const key of RESOURCE_KEYS) {
        const raw = system[key];
        if (Number.isFinite(raw)) {
            resources[key] = { value: raw };
        } else if (raw && typeof raw === "object" && Number.isFinite(raw.value)) {
            const entry = { value: raw.value };
            if (Number.isFinite(raw.max)) entry.max = raw.max;
            if (Number.isFinite(raw.min)) entry.min = raw.min;
            resources[key] = entry;
        }
    }
    return resources;
}


/**
 * Fingerprint of the actor resource summary вЂ” compared by the
 * `resources-changed` stale check.
 * @param {object|null} actor
 * @returns {string}
 */
export function _resourcesFingerprint(actor) {
    return fnv1a(stableStringify(_resourcesOf(actor)));
}


/**
 * Minimal serializable item summaries (weapons first, then the rest up to
 * the cap). Never carries Document references.
 * @param {object|null} actor
 * @returns {object[]}
 */
export function _itemSummaries(actor) {
    const items = _list(actor?.items)
        .filter(item => item && typeof item === "object")
        .map(item => {
            const system = item.system ?? {};
            const clip = system.clip?.value ?? system.ammo?.value;
            // Canonical OW blast lives in the `special` trait string
            // ("Blast (3)"); explicit fields win when present.
            const blast = system.blastRadius ?? system.traits?.blast
                ?? _blastFromSpecial(system.special);
            return {
                id: item.id ?? null,
                uuid: typeof item.uuid === "string" ? item.uuid : null,
                name: item.name ?? null,
                type: item.type ?? null,
                class: system.class ?? null,
                range: Number.isFinite(system.range) ? system.range
                    : (Number.isFinite(system.range?.value) ? system.range.value : null),
                ammo: Number.isFinite(clip) ? clip : null,
                // Weapon stats the action normalization reads back when a
                // replay rebuilds the actor items — without them the
                // `ev`/spray/blast factors evaluate to 0 on a replay.
                damage: typeof system.damage === "string" ? system.damage
                    : (Number.isFinite(system.damage) ? system.damage : null),
                blastRadius: Number.isFinite(blast) ? blast : null,
                special: typeof system.special === "string" ? system.special : null,
                rateOfFire: system.rateOfFire ?? null
            };
        })
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .slice(0, MAX_SNAPSHOT_ITEMS);
    return items;
}


/**
 * Sorted, deduplicated status ids collected from Foundry-style status
 * sources (Set/array/iterable of ids, or a `{id: truthy}` map). Mirrors
 * `statusIdsOf` in `perception.js`, kept local so the planner stays
 * self-contained for unit fixtures.
 * @param {...*} sources Status collections (`actor.statuses`,
 *   `token.statuses`, injected arrays).
 * @returns {string[]}
 */
export function _statusIds(...sources) {
    const ids = new Set();
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
    return [...ids].sort();
}


/**
 * Self status ids for the snapshot: `actor.statuses` merged with the
 * statuses carried by the token documents, plus the injected
 * `context.selfStatuses` array used by unit-test fixtures.
 * @param {object|null} actor Self actor document.
 * @param {object|null} tokenDoc Self token document.
 * @param {string[]|null} [injected] `context.selfStatuses` fixture array.
 * @returns {string[]} Sorted status ids.
 */
export function _selfStatuses(actor, tokenDoc, injected = null) {
    return _statusIds(
        injected,
        actor?.statuses,
        tokenDoc?.statuses,
        tokenDoc?.actor?.statuses
    );
}


/**
 * Whether a target token still exists and can be attacked: alive actor,
 * not defeated in combat, not hidden.
 * @param {object|null} targetToken
 * @param {object|null} combatant Combatant for the target token, if any.
 * @returns {boolean}
 */
export function _targetAlive(targetToken, combatant) {
    const doc = _tokenDoc(targetToken);
    if (!doc || doc.destroyed === true) return false;
    if (doc.hidden === true) return false;
    if (combatant?.defeated === true || combatant?.destroyed === true) return false;
    const actor = doc.actor ?? combatant?.actor;
    if (!actor || actor.destroyed === true) return false;
    return true;
}


/**
 * Find a combatant of the combat by its own id.
 * @param {object} combat
 * @param {string|null} combatantId
 * @returns {object|null}
 */
export function _findCombatant(combat, combatantId) {
    if (!combatantId) return null;
    const collection = combat?.combatants;
    if (collection && typeof collection.get === "function") {
        const hit = collection.get(combatantId);
        if (hit) return hit;
    }
    for (const entry of _list(collection)) {
        if (entry?.id === combatantId) return entry;
    }
    return null;
}


/**
 * Find a combatant of the combat by its token id.
 * @param {object} combat
 * @param {string|null} tokenId
 * @returns {object|null}
 */
export function _findCombatantByToken(combat, tokenId) {
    if (!tokenId) return null;
    for (const entry of _list(combat?.combatants)) {
        const doc = _tokenDoc(entry?.token);
        if ((entry?.tokenId ?? doc?.id) === tokenId) return entry;
    }
    return null;
}


/**
 * Find a token document by id: combat combatants first, then the scene
 * token collection.
 * @param {string|null} tokenId
 * @param {object} input Lookup context.
 * @param {object|null} [input.combat] Combat providing combatant tokens.
 * @param {object|null} [input.scene] Scene providing the token collection.
 * @returns {object|null}
 */
export function _findToken(tokenId, { combat = null, scene = null } = {}) {
    if (!tokenId) return null;
    const combatant = _findCombatantByToken(combat, tokenId);
    if (combatant?.token) return _tokenDoc(combatant.token);
    const collection = scene?.tokens ?? globalThis.canvas?.tokens;
    if (collection && typeof collection.get === "function") {
        const hit = collection.get(tokenId);
        if (hit) return _tokenDoc(hit);
    }
    for (const entry of _list(collection)) {
        const doc = _tokenDoc(entry);
        if (doc?.id === tokenId) return doc;
    }
    return null;
}


/**
 * Melee reach of a token's actor in pixels (issue #39 review): the
 * longest `range`/`reach` of its melee-class weapon items — a spear
 * armed ally engages a cell further than the unarmed default. `null`
 * when the token or its loadout cannot be resolved (the caller falls
 * back to {@link DEFAULT_MELEE_RANGE}).
 * @param {string|null} tokenId Token id to resolve.
 * @param {object} input Lookup context.
 * @param {object|null} [input.combat] Combat searched first.
 * @param {object|null} [input.scene] Scene for the token collection.
 * @param {number} [input.pxPerUnit] Pixels per scene unit.
 * @returns {number|null}
 */
export function _tokenMeleeReachPx(tokenId, { combat = null, scene = null, pxPerUnit = 1 } = {}) {
    const doc = _findToken(tokenId, { combat, scene });
    const actor = _actorOf(doc);
    const scale = pxPerUnit > 0 ? pxPerUnit : 1;
    const ranges = _list(actor?.items)
        .filter(item => item?.type === "weapon"
            && String(item.system?.class ?? "").toLowerCase() === "melee")
        .map(item => _finiteOr(item.system?.range ?? item.system?.reach, 0))
        .filter(range => range > 0);
    return ranges.length ? Math.max(...ranges) * scale : null;
}


/**
 * Morale state of a combatant for issue #38 gating/boosts (graceful
 * #26 integration): reads `context.morale` first (tests/integrations),
 * then the optional module flag `flags["only-war-ai"].morale`
 * `{state, pressured?, desperate?}`. No flag or unrecognized payload —
 * normal state, the caller keeps planning as usual.
 * @param {object|null} combatant Combatant document.
 * @param {object} [context] Planning context.
 * @returns {{pressured: boolean, desperate: boolean}}
 */
export function _moraleOf(combatant, context = {}) {
    const injected = context.morale;
    const record = injected !== undefined ? injected
        : (combatant?.getFlag?.(MODULE_ID, FLAG_KEYS.morale)
            ?? combatant?.flags?.[MODULE_ID]?.[FLAG_KEYS.morale]);
    return moralePostureOf(record);
}


/**
 * The `lastAttacker` record usable for scoring this turn (issue #39):
 * the flag value filtered by the round-expiry of {@link grudgeActive}
 * and by attacker liveness — a matching defeated combatant or destroyed
 * token proves the attacker dead, which mutes the grudge. An attacker
 * missing from the combat cannot disprove the record and keeps it.
 * @param {object|null} record Raw `lastAttacker` flag/context value.
 * @param {object|null} combat Live combat document.
 * @returns {object|null}
 */
export function _activeGrudge(record, combat) {
    if (!record || typeof record !== "object") return null;
    if (!grudgeActive(record, Number.isFinite(combat?.round) ? combat.round : null)) {
        return null;
    }
    let attacker = record.tokenId != null
        ? _findCombatantByToken(combat, record.tokenId)
        : null;
    if (!attacker && record.actorId != null) {
        attacker = _list(combat?.combatants).find(other => {
            const actor = _actorOf(other) ?? _actorOf(_tokenDoc(other?.token));
            return actor?.id === record.actorId || other?.actorId === record.actorId;
        }) ?? null;
    }
    if (attacker) {
        const doc = _tokenDoc(attacker.token);
        if (attacker.defeated === true || attacker.destroyed === true
            || doc?.destroyed === true) {
            return null;
        }
    }
    return record;
}
