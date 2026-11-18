/**
 * Shared fixtures for unit tests: Actor/Token/Combatant document mocks and
 * square/hex Scene stubs (issue #399).
 *
 * Fixtures mimic only the surface the resolver and settings code touch:
 * `documentName`, `flags`, `getFlag`/`setFlag`/`unsetFlag`, `actor`/`token`
 * links and a `destroyed` marker for deleted documents.
 */
import { FLAG_KEYS, MODULE_ID } from "../../scripts/constants.js";

let _id = 0;

/**
 * Next deterministic fixture id.
 * @returns {string}
 */
function _nextId() {
    return `fixture-${++_id}`;
}

/**
 * Base flag-capable document mock.
 */
class FixtureDocument {
    /**
     * @param {string} documentName
     * @param {object} data `{flags, ...extra}`.
     */
    constructor(documentName, data = {}) {
        this.documentName = documentName;
        this.id = data.id ?? _nextId();
        this.name = data.name ?? this.id;
        this.flags = foundry.utils.deepClone(data.flags ?? {});
        this.destroyed = data.destroyed === true;
        Object.assign(this, data.extra ?? {});
    }

    getFlag(scope, key) {
        return this.flags?.[scope]?.[key];
    }

    async setFlag(scope, key, value) {
        this.flags = this.flags ?? {};
        this.flags[scope] = this.flags[scope] ?? {};
        this.flags[scope][key] = value;
        return this;
    }

    async unsetFlag(scope, key) {
        if (this.flags?.[scope]) delete this.flags[scope][key];
        return this;
    }
}

/**
 * Actor fixture.
 * @param {object} [options]
 * @param {boolean} [options.enabled] Actor-level `config.enabled`.
 * @param {string} [options.preset] Actor-level `config.preset`.
 * @param {*} [options.rawConfig] Overrides the whole `config` flag value
 *   (for damaged-data tests).
 * @returns {FixtureDocument}
 */
export function makeActor({ enabled, preset, rawConfig } = {}) {
    const flags = {};
    if (rawConfig !== undefined) {
        flags[MODULE_ID] = { [FLAG_KEYS.actorConfig]: rawConfig };
    } else if (enabled !== undefined || preset !== undefined) {
        flags[MODULE_ID] = {
            [FLAG_KEYS.actorConfig]: { enabled: enabled === true, preset: preset ?? null }
        };
    }
    return new FixtureDocument("Actor", {
        name: "Test NPC",
        flags,
        extra: { type: "npc", system: {}, isOwner: true }
    });
}

/**
 * TokenDocument fixture.
 * @param {object} [options]
 * @param {object} [options.actor] Linked actor (pass null for a deleted actor).
 * @param {string} [options.mode] `override.mode`.
 * @param {string} [options.preset] `override.preset`.
 * @param {*} [options.rawOverride] Overrides the whole `override` flag value.
 * @param {boolean} [options.destroyed] Mark the token as deleted.
 * @returns {FixtureDocument}
 */
export function makeToken({ actor, mode, preset, rawOverride, destroyed } = {}) {
    const flags = {};
    if (rawOverride !== undefined) {
        flags[MODULE_ID] = { [FLAG_KEYS.override]: rawOverride };
    } else if (mode !== undefined || preset !== undefined) {
        flags[MODULE_ID] = {
            [FLAG_KEYS.override]: { mode: mode ?? "inherit", preset: preset ?? null }
        };
    }
    const token = new FixtureDocument("Token", { name: "Test Token", flags, destroyed });
    token.actor = actor === undefined ? makeActor() : actor;
    return token;
}

/**
 * Combatant fixture.
 * @param {object} [options]
 * @param {object} [options.actor] Linked actor.
 * @param {object} [options.token] Linked TokenDocument.
 * @param {string} [options.mode] `override.mode`.
 * @param {string} [options.preset] `override.preset`.
 * @param {*} [options.rawOverride] Overrides the whole `override` flag value.
 * @param {boolean} [options.destroyed] Mark the combatant as deleted.
 * @returns {FixtureDocument}
 */
export function makeCombatant({ actor, token, mode, preset, rawOverride, destroyed } = {}) {
    const flags = {};
    if (rawOverride !== undefined) {
        flags[MODULE_ID] = { [FLAG_KEYS.override]: rawOverride };
    } else if (mode !== undefined || preset !== undefined) {
        flags[MODULE_ID] = {
            [FLAG_KEYS.override]: { mode: mode ?? "inherit", preset: preset ?? null }
        };
    }
    const combatant = new FixtureDocument("Combatant", { name: "Test Combatant", flags, destroyed });
    if (actor !== undefined) combatant.actor = actor;
    if (token !== undefined) combatant.token = token;
    if (!("actor" in combatant)) combatant.actor = combatant.token?.actor ?? makeActor();
    if (!("token" in combatant)) combatant.token = makeToken({ actor: combatant.actor });
    return combatant;
}

/**
 * User fixture for controller-election tests.
 * @param {object} [options]
 * @param {string} [options.id] Stable user id.
 * @param {boolean} [options.isGM] Foundry `isGM` flag.
 * @param {boolean} [options.active] Whether the user is connected.
 * @param {number} [options.role] Foundry role (4 = GAMEMASTER); defaults to
 *   `isGM ? 4 : 1`.
 * @returns {object}
 */
export function makeUser({ id, isGM = false, active = true, role } = {}) {
    const userId = id ?? _nextId();
    return {
        id: userId,
        name: `User ${userId}`,
        isGM,
        active,
        role: role ?? (isGM ? 4 : 1)
    };
}

/**
 * Combat fixture with the surface the authority services touch: `id`,
 * `round`, `turn`, `combatants` collection, `turns`, `combatant` getter and
 * flag accessors from {@link FixtureDocument}.
 * @param {object} [options]
 * @param {string} [options.id] Stable combat id.
 * @param {number} [options.round] Current round.
 * @param {number} [options.turn] Current turn index.
 * @param {object[]} [options.combatants] Combatant fixtures in turn order.
 * @returns {FixtureDocument}
 */
export function makeCombat({ id, round = 0, turn = 0, combatants = [] } = {}) {
    const combat = new FixtureDocument("Combat", { id: id ?? _nextId(), name: "Test Combat" });
    combat.round = round;
    combat.turn = turn;
    const collection = new Map(combatants.map(c => [c.id, c]));
    collection.contents = combatants;
    combat.combatants = collection;
    combat.turns = combatants;
    Object.defineProperty(combat, "combatant", {
        configurable: true,
        get() {
            return this.turns[this.turn] ?? null;
        }
    });
    return combat;
}

/**
 * Scene stub for square/hex grids.
 * @param {object} [options]
 * @param {"square"|"hex"} [options.grid]
 * @returns {object}
 */
export function makeScene({ grid = "square" } = {}) {
    return {
        documentName: "Scene",
        id: _nextId(),
        name: `Stub ${grid} scene`,
        grid: {
            type: grid === "hex" ? 2 : 1,
            size: 100,
            distance: grid === "hex" ? 2 : 1.5,
            units: "m"
        }
    };
}

/** Deep-freeze helper for read-only assertions. */
export function freezeDeep(value) {
    if (value && typeof value === "object") {
        for (const key of Object.keys(value)) freezeDeep(value[key]);
        Object.freeze(value);
    }
    return value;
}
