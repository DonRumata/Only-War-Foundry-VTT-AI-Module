/**
 * Global Foundry VTT mocks for Node unit tests.
 * Preloaded with `node --import tests/unit/setup.mjs --test tests/unit`.
 *
 * Mirrors the style of `tests/unit/setup.mjs` in the Only War system repo:
 * only the globals the module actually touches are stubbed.
 */

function _getProperty(obj, key) {
    if (!obj || !key) return undefined;
    const parts = String(key).split(".");
    let current = obj;
    for (const part of parts) {
        if (current === null || current === undefined) return undefined;
        current = current[part];
    }
    return current;
}

globalThis.foundry = {
    utils: {
        mergeObject: (target, source) => Object.assign({}, target, source),
        deepClone: (obj) => {
            if (obj === null || typeof obj !== "object") return obj;
            return JSON.parse(JSON.stringify(obj));
        },
        getProperty: _getProperty,
        randomID: () => Math.random().toString(36).slice(2, 18)
    }
};

const hookCalls = [];
globalThis.Hooks = {
    on: (event, fn) => { hookCalls.push({ type: "on", event, fn }); },
    once: (event, fn) => { hookCalls.push({ type: "once", event, fn }); },
    call: () => true,
    callAll: () => {},
    // Test helper: inspect what was registered.
    _calls: hookCalls
};

const registeredSettings = [];
const registeredMenus = [];
const settingValues = new Map();

globalThis.game = {
    system: { id: "only-war-local" },
    user: { id: "user1", isGM: true },
    darkHeresy: { api: { version: "1.0", capabilities: {} } },
    modules: new Map(),
    combat: null,
    combats: new Map(),
    actors: new Map(),
    settings: {
        register: (scope, key, data) => {
            registeredSettings.push({ scope, key, data });
            if (data && "default" in data) settingValues.set(`${scope}.${key}`, data.default);
        },
        registerMenu: (scope, key, data) => {
            registeredMenus.push({ scope, key, data });
        },
        get: (scope, key) => settingValues.get(`${scope}.${key}`),
        set: (scope, key, value) => { settingValues.set(`${scope}.${key}`, value); },
        _registered: registeredSettings,
        _menus: registeredMenus,
        _values: settingValues
    },
    i18n: {
        localize: (key) => key,
        format: (key, data = {}) => `${key} ${JSON.stringify(data)}`
    }
};

globalThis.ui = {
    notifications: {
        warn: () => {},
        info: () => {},
        error: () => {}
    }
};

globalThis.duplicate = (data) => foundry.utils.deepClone(data);

// The module always publishes its api on `init`; the ready-check flips
// `api.enabled`. Unit tests default to a compatible, master-enabled world.
game.modules.set("only-war-ai", { api: { enabled: true } });

// Test helper: reset registered settings/menus and stored values.
globalThis._resetMocks = () => {
    registeredSettings.length = 0;
    registeredMenus.length = 0;
    settingValues.clear();
    game.combat = null;
    game.modules.set("only-war-ai", { api: { enabled: true } });
};
