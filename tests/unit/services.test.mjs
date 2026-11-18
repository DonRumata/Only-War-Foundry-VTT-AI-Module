/**
 * Unit tests for the module API and service registry (issue #399).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createServiceRegistry } from "../../scripts/services.js";
import { createModuleApi } from "../../scripts/api.js";
import { AI_PRESETS, MODULE_API_VERSION, OVERRIDE_MODES } from "../../scripts/constants.js";

test("register/get/has/list round-trip", () => {
    const registry = createServiceRegistry();
    const planner = { plan: () => [] };
    assert.equal(registry.register("planner", planner), planner);
    assert.equal(registry.get("planner"), planner);
    assert.equal(registry.has("planner"), true);
    assert.equal(registry.get("missing"), null);
    assert.deepEqual(registry.list(), ["planner"]);
});

test("duplicate registration throws", () => {
    const registry = createServiceRegistry();
    registry.register("executor", {});
    assert.throws(() => registry.register("executor", {}), /already registered/);
});

test("invalid names and implementations throw", () => {
    const registry = createServiceRegistry();
    for (const bad of ["", "   ", null, undefined, 42]) {
        assert.throws(() => registry.register(bad, {}), /non-empty string/);
    }
    assert.throws(() => registry.register("x", null), /requires an implementation/);
    assert.throws(() => registry.register("y", undefined), /requires an implementation/);
});

test("unregister removes a service", () => {
    const registry = createServiceRegistry();
    registry.register("perception", {});
    assert.equal(registry.unregister("perception"), true);
    assert.equal(registry.has("perception"), false);
    assert.equal(registry.unregister("perception"), false);
});

test("module api exposes version, capabilities, config and services", () => {
    const api = createModuleApi();
    assert.equal(api.version, MODULE_API_VERSION);
    assert.equal(typeof api.version, "string");
    assert.equal(api.hasCapability("config.resolveEffectiveConfig"), true);
    assert.equal(api.hasCapability("services.register"), true);
    assert.equal(api.hasCapability("planner.planTurn"), true);
    assert.equal(typeof api.config.resolveEffectiveConfig, "function");
    assert.equal(typeof api.services.register, "function");
    assert.deepEqual([...api.presets], [...AI_PRESETS]);
    assert.deepEqual([...api.overrideModes], [...OVERRIDE_MODES]);
});

test("module api starts disabled until the ready check flips state", () => {
    const api = createModuleApi();
    assert.equal(api.enabled, false);
    assert.equal(api.incompatibleReason, null);
    api._state.enabled = true;
    api._state.incompatibleReason = null;
    assert.equal(api.enabled, true);
});

test("frozen api collections cannot be extended", () => {
    const api = createModuleApi();
    assert.equal(Object.isFrozen(api.capabilities), true);
    assert.equal(Object.isFrozen(api.presets), true);
    assert.equal(Object.isFrozen(api.config), true);
});
