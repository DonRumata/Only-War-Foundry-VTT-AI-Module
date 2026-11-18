/**
 * Unit tests for world settings registration and accessors (issue #399).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    getExecutionMode,
    isDiagnosticsEnabled,
    registerSettings
} from "../../scripts/settings.js";
import { MODULE_ID, SETTING_KEYS } from "../../scripts/constants.js";

test("registerSettings registers world-scoped settings", () => {
    _resetMocks();
    registerSettings();
    const registered = game.settings._registered;
    assert.equal(registered.length, 2);
    for (const entry of registered) {
        assert.equal(entry.scope, MODULE_ID);
        assert.equal(entry.data.scope, "world");
        assert.equal(entry.data.config, true);
    }
});

test("executionMode defaults to preview with automatic/preview choices", () => {
    _resetMocks();
    registerSettings();
    const entry = game.settings._registered.find(e => e.key === SETTING_KEYS.executionMode);
    assert.ok(entry, "executionMode registered");
    assert.equal(entry.data.default, "preview");
    assert.deepEqual(Object.keys(entry.data.choices), ["automatic", "preview"]);
    assert.equal(getExecutionMode(), "preview");
});

test("diagnosticsEnabled defaults to false", () => {
    _resetMocks();
    registerSettings();
    const entry = game.settings._registered.find(e => e.key === SETTING_KEYS.diagnosticsEnabled);
    assert.ok(entry, "diagnosticsEnabled registered");
    assert.equal(entry.data.default, false);
    assert.equal(isDiagnosticsEnabled(), false);
});

test("getExecutionMode honours a stored value and rejects damaged ones", async () => {
    _resetMocks();
    registerSettings();
    await game.settings.set(MODULE_ID, SETTING_KEYS.executionMode, "automatic");
    assert.equal(getExecutionMode(), "automatic");
    await game.settings.set(MODULE_ID, SETTING_KEYS.executionMode, "garbage");
    assert.equal(getExecutionMode(), "preview");
});

test("isDiagnosticsEnabled reads the stored value", async () => {
    _resetMocks();
    registerSettings();
    await game.settings.set(MODULE_ID, SETTING_KEYS.diagnosticsEnabled, true);
    assert.equal(isDiagnosticsEnabled(), true);
});
