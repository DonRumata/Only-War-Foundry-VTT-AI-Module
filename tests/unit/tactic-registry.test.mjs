/**
 * Unit tests for the per-preset tactic selector registry (issue #92):
 * validation, priority/tie-break order, deterministic resolution, duplicate
 * registration contract and input immutability.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    DEFAULT_TACTIC_PRIORITY,
    TACTIC_KINDS,
    createTacticRegistry
} from "../../scripts/tactics/registry.js";
import { freezeDeep } from "./fixtures.mjs";

test("registerTacticSelector validates and freezes the preferred record form", () => {
    const registry = createTacticRegistry();
    const select = () => ({ name: "hold-fast" });
    const record = registry.registerTacticSelector({
        presetId: "hold",
        kind: "maneuver",
        priority: 25,
        select
    });
    assert.equal(record.presetId, "hold");
    assert.equal(record.kind, "maneuver");
    assert.equal(record.priority, 25);
    assert.equal(record.select, select);
    assert.equal(Object.isFrozen(record), true);
    assert.deepEqual(registry.listTacticSelectors("hold"), [record]);
    assert.equal(registry.hasTacticSelectors("hold"), true);
    assert.equal(registry.hasTacticSelectors("hold", "overlay"), false);
    assert.ok(TACTIC_KINDS.includes(record.kind));

    assert.throws(() => registry.registerTacticSelector({
        presetId: "",
        select
    }), /non-empty string/);
    assert.throws(() => registry.registerTacticSelector({
        presetId: "hold",
        kind: "unknown",
        select
    }), /kind must be/);
    assert.throws(() => registry.registerTacticSelector({
        presetId: "hold",
        priority: Number.NaN,
        select
    }), /finite number/);
    assert.throws(() => registry.registerTacticSelector({
        presetId: "hold"
    }), /select function/);
});

test("shorthand registration applies maneuver/default-priority defaults", () => {
    const registry = createTacticRegistry();
    const select = () => null;
    const record = registry.registerTacticSelector("assault", select);
    assert.equal(record.kind, "maneuver");
    assert.equal(record.priority, DEFAULT_TACTIC_PRIORITY);
});

test("resolveTactic uses priority order and yields on null", () => {
    const registry = createTacticRegistry();
    const calls = [];
    registry.registerTacticSelector("assault", () => {
        calls.push("fallback");
        return { name: "fallback" };
    }, { priority: 50 });
    registry.registerTacticSelector("assault", () => {
        calls.push("preferred-null");
        return null;
    }, { priority: 10 });

    assert.deepEqual(registry.resolveTactic("assault", {}), { name: "fallback" });
    assert.deepEqual(calls, ["preferred-null", "fallback"]);
});

test("resolveTactic tie-breaks equal priority by registration order", () => {
    const registry = createTacticRegistry();
    const calls = [];
    registry.registerTacticSelector("assault", () => {
        calls.push("first");
        return { name: "first" };
    }, { priority: 10 });
    registry.registerTacticSelector("assault", () => {
        calls.push("second");
        return { name: "second" };
    }, { priority: 10 });

    assert.deepEqual(registry.resolveTactic("assault", {}), { name: "first" });
    assert.deepEqual(calls, ["first"]);

    const yielding = createTacticRegistry();
    yielding.registerTacticSelector("assault", () => null, { priority: 10 });
    yielding.registerTacticSelector("assault", () => ({ name: "second" }), { priority: 10 });
    assert.deepEqual(yielding.resolveTactic("assault", {}), { name: "second" });
});

test("v1 ignores overlay selectors when resolving the maneuver", () => {
    const registry = createTacticRegistry();
    registry.registerTacticSelector({
        presetId: "specOps",
        kind: "overlay",
        priority: 1,
        select: () => ({ name: "overlay-must-not-win" })
    });
    assert.equal(registry.resolveTactic("specOps", {}), null);

    registry.registerTacticSelector({
        presetId: "specOps",
        kind: "maneuver",
        priority: 100,
        select: () => ({ name: "maneuver" })
    });
    assert.deepEqual(registry.resolveTactic("specOps", {}), { name: "maneuver" });
});

test("unknown or empty presets fall back to null", () => {
    const registry = createTacticRegistry();
    registry.registerTacticSelector("assault", () => ({ name: "assault" }));
    assert.equal(registry.resolveTactic("rangedCover", {}), null);
    assert.equal(registry.resolveTactic("unknown-preset", {}), null);
    assert.equal(registry.resolveTactic("", {}), null);
    assert.equal(registry.resolveTactic(null, {}), null);
});

test("resolution is deterministic and does not mutate frozen input", () => {
    const registry = createTacticRegistry();
    const input = freezeDeep({
        members: [
            { combatantId: "m1", position: { x: 100, y: 200 } },
            { combatantId: "m2", position: { x: 300, y: 400 } }
        ],
        leaderId: "m1",
        seed: 77,
        context: { objective: { x: 1000, y: 1000 } }
    });
    registry.registerTacticSelector("hold", value => ({
        name: "hold-fast",
        reason: `seed-${value.seed}`,
        assignments: Object.fromEntries(value.members.map(member => [member.combatantId, "support"])),
        breakdown: { leader: value.leaderId }
    }));

    const first = registry.resolveTactic("hold", input);
    const second = registry.resolveTactic("hold", input);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(input.members[0].position.x, 100);
    assert.equal(input.context.objective.x, 1000);
});

test("exact duplicate registration is idempotent; conflicting reuse errors", () => {
    const registry = createTacticRegistry();
    const select = () => null;
    const first = registry.registerTacticSelector({
        presetId: "specOps",
        kind: "maneuver",
        priority: 20,
        select
    });
    const second = registry.registerTacticSelector({
        presetId: "specOps",
        kind: "maneuver",
        priority: 20,
        select
    });
    assert.equal(second, first);
    assert.equal(registry.listTacticSelectors("specOps").length, 1);
    assert.throws(() => registry.registerTacticSelector({
        presetId: "specOps",
        kind: "maneuver",
        priority: 30,
        select
    }), /already registered/);

    // A different factory is a distinct selector even at the same priority.
    assert.doesNotThrow(() => registry.registerTacticSelector({
        presetId: "specOps",
        kind: "maneuver",
        priority: 20,
        select: () => null
    }));
});

test("selector results must be synchronous object descriptors or null", () => {
    const registry = createTacticRegistry();
    registry.registerTacticSelector("assault", () => "not-a-descriptor");
    assert.throws(() => registry.resolveTactic("assault", {}), /object descriptor or null/);

    const asyncRegistry = createTacticRegistry();
    asyncRegistry.registerTacticSelector("assault", async() => ({ name: "async" }));
    assert.throws(() => asyncRegistry.resolveTactic("assault", {}), /object descriptor or null/);
});
