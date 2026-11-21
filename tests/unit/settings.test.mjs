/**
 * Unit tests for world settings registration and accessors (issue #399).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    getAIDifficulty,
    getAttackAdjudication,
    getExecutionMode,
    getPreferredCohesion,
    getPreviewTimeoutSeconds,
    getTurnPacingMs,
    isDiagnosticsEnabled,
    isMasterEnabled,
    isThreatMapOverlayEnabled,
    registerSettings
} from "../../scripts/settings.js";
import {
    ATTACK_ADJUDICATION_MODES,
    DEFAULT_PREFERRED_COHESION,
    DEFAULT_PREVIEW_TIMEOUT_SECONDS,
    DEFAULT_TURN_PACING_MS,
    MODULE_ID,
    SETTING_KEYS
} from "../../scripts/constants.js";

test("registerSettings registers world-scoped settings", () => {
    _resetMocks();
    registerSettings();
    const registered = game.settings._registered;
    assert.equal(registered.length, 9);
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

test("turnPacingMs defaults, honours 0 and rejects damaged values", async () => {
    _resetMocks();
    registerSettings();
    const entry = game.settings._registered.find(e => e.key === SETTING_KEYS.turnPacingMs);
    assert.ok(entry, "turnPacingMs registered");
    assert.equal(entry.data.default, DEFAULT_TURN_PACING_MS);
    assert.equal(getTurnPacingMs(), DEFAULT_TURN_PACING_MS);
    await game.settings.set(MODULE_ID, SETTING_KEYS.turnPacingMs, 300);
    assert.equal(getTurnPacingMs(), 300);
    // 0 is a valid opt-out (no pacing delay).
    await game.settings.set(MODULE_ID, SETTING_KEYS.turnPacingMs, 0);
    assert.equal(getTurnPacingMs(), 0);
    await game.settings.set(MODULE_ID, SETTING_KEYS.turnPacingMs, -50);
    assert.equal(getTurnPacingMs(), DEFAULT_TURN_PACING_MS);
});

test("masterEnabled defaults to true and reads a stored value", async () => {
    _resetMocks();
    registerSettings();
    const entry = game.settings._registered.find(e => e.key === SETTING_KEYS.masterEnabled);
    assert.ok(entry, "masterEnabled registered");
    assert.equal(entry.data.scope, "world");
    assert.equal(entry.data.default, true);
    assert.equal(isMasterEnabled(), true);
    await game.settings.set(MODULE_ID, SETTING_KEYS.masterEnabled, false);
    assert.equal(isMasterEnabled(), false);
    await game.settings.set(MODULE_ID, SETTING_KEYS.masterEnabled, true);
    assert.equal(isMasterEnabled(), true);
});

test("isMasterEnabled falls back to true on damaged values", async () => {
    _resetMocks();
    registerSettings();
    await game.settings.set(MODULE_ID, SETTING_KEYS.masterEnabled, "garbage");
    assert.equal(isMasterEnabled(), true);
    await game.settings.set(MODULE_ID, SETTING_KEYS.masterEnabled, 0);
    // Only an explicit false disables the module.
    assert.equal(isMasterEnabled(), true);
});

test("aiDifficulty defaults to normal with easy/normal/hard choices (issue #16)", () => {
    _resetMocks();
    registerSettings();
    const entry = game.settings._registered.find(e => e.key === SETTING_KEYS.aiDifficulty);
    assert.ok(entry, "aiDifficulty registered");
    assert.equal(entry.data.scope, "world");
    assert.equal(entry.data.default, "normal");
    assert.deepEqual(Object.keys(entry.data.choices), ["easy", "normal", "hard"]);
    assert.equal(getAIDifficulty(), "normal");
});

test("threatMapOverlay defaults to false and reads a stored value (issue #36)", async () => {
    _resetMocks();
    registerSettings();
    const entry = game.settings._registered.find(e => e.key === SETTING_KEYS.threatMapOverlay);
    assert.ok(entry, "threatMapOverlay registered");
    assert.equal(entry.data.scope, "world");
    assert.equal(entry.data.default, false);
    assert.equal(isThreatMapOverlayEnabled(), false);
    await game.settings.set(MODULE_ID, SETTING_KEYS.threatMapOverlay, true);
    assert.equal(isThreatMapOverlayEnabled(), true);
    await game.settings.set(MODULE_ID, SETTING_KEYS.threatMapOverlay, "garbage");
    assert.equal(isThreatMapOverlayEnabled(), false);
});

test("getAIDifficulty honours a stored value and rejects damaged ones", async () => {
    _resetMocks();
    registerSettings();
    await game.settings.set(MODULE_ID, SETTING_KEYS.aiDifficulty, "easy");
    assert.equal(getAIDifficulty(), "easy");
    await game.settings.set(MODULE_ID, SETTING_KEYS.aiDifficulty, "hard");
    assert.equal(getAIDifficulty(), "hard");
    await game.settings.set(MODULE_ID, SETTING_KEYS.aiDifficulty, "nightmare");
    assert.equal(getAIDifficulty(), "normal");
});

test("attackAdjudication defaults to auto with auto/gm-confirm choices (issue #37)", () => {
    _resetMocks();
    registerSettings();
    const entry = game.settings._registered.find(
        e => e.key === SETTING_KEYS.attackAdjudication);
    assert.ok(entry, "attackAdjudication registered");
    assert.equal(entry.data.scope, "world");
    assert.equal(entry.data.default, "auto");
    assert.deepEqual(Object.keys(entry.data.choices), [...ATTACK_ADJUDICATION_MODES]);
    assert.equal(getAttackAdjudication(), "auto");
});

test("getAttackAdjudication honours a stored value and rejects damaged ones", async () => {
    _resetMocks();
    registerSettings();
    await game.settings.set(MODULE_ID, SETTING_KEYS.attackAdjudication, "gm-confirm");
    assert.equal(getAttackAdjudication(), "gm-confirm");
    await game.settings.set(MODULE_ID, SETTING_KEYS.attackAdjudication, "garbage");
    assert.equal(getAttackAdjudication(), "auto");
});
