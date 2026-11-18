/**
 * Unit tests for world settings registration and accessors (issue #399).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    getExecutionMode,
    getPreferredCohesion,
    getPreviewTimeoutSeconds,
    isDiagnosticsEnabled,
    registerSettings
} from "../../scripts/settings.js";
import {
    DEFAULT_PREFERRED_COHESION,
    DEFAULT_PREVIEW_TIMEOUT_SECONDS,
    MODULE_ID,
    SETTING_KEYS
} from "../../scripts/constants.js";

test("registerSettings registers world-scoped settings", () => {
    _resetMocks();
    registerSettings();
    const registered = game.settings._registered;
    assert.equal(registered.length, 4);
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

test("preferredCohesion defaults to 5 and reads a stored value", async () => {
    _resetMocks();
    registerSettings();
    const entry = game.settings._registered.find(e => e.key === SETTING_KEYS.preferredCohesion);
    assert.ok(entry, "preferredCohesion registered");
    assert.equal(entry.data.default, DEFAULT_PREFERRED_COHESION);
    assert.equal(getPreferredCohesion(), DEFAULT_PREFERRED_COHESION);
    await game.settings.set(MODULE_ID, SETTING_KEYS.preferredCohesion, 8);
    assert.equal(getPreferredCohesion(), 8);
    await game.settings.set(MODULE_ID, SETTING_KEYS.preferredCohesion, -1);
    assert.equal(getPreferredCohesion(), DEFAULT_PREFERRED_COHESION);
});

test("previewTimeoutSeconds defaults to 60, honours 0 and rejects damaged values", async () => {
    _resetMocks();
    registerSettings();
    const entry = game.settings._registered.find(e => e.key === SETTING_KEYS.previewTimeoutSeconds);
    assert.ok(entry, "previewTimeoutSeconds registered");
    assert.equal(entry.data.default, DEFAULT_PREVIEW_TIMEOUT_SECONDS);
    assert.equal(getPreviewTimeoutSeconds(), DEFAULT_PREVIEW_TIMEOUT_SECONDS);
    await game.settings.set(MODULE_ID, SETTING_KEYS.previewTimeoutSeconds, 5);
    assert.equal(getPreviewTimeoutSeconds(), 5);
    // 0 is a valid opt-out (no auto-cancel).
    await game.settings.set(MODULE_ID, SETTING_KEYS.previewTimeoutSeconds, 0);
    assert.equal(getPreviewTimeoutSeconds(), 0);
    await game.settings.set(MODULE_ID, SETTING_KEYS.previewTimeoutSeconds, -10);
    assert.equal(getPreviewTimeoutSeconds(), DEFAULT_PREVIEW_TIMEOUT_SECONDS);
});
