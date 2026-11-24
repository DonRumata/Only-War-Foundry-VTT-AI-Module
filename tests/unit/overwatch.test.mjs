/**
 * Unit tests for the overwatch service (issue #14): declare-only cone
 * declarations on the combatant flag, controller gating and the GM-only
 * rendering guard.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createModuleApi } from "../../scripts/api.js";
import { createOverwatchService, OVERWATCH_REASONS } from "../../scripts/overwatch.js";
import { FLAG_KEYS, MODULE_ID } from "../../scripts/constants.js";
import {
    makeActor,
    makeCombat,
    makeCombatant,
    makeToken
} from "./fixtures.mjs";

/**
 * A declaring bot combatant with flag persistence (FixtureDocument
 * provides getFlag/setFlag/unsetFlag).
 * @returns {object}
 */
function makeWorld() {
    const actor = makeActor({ enabled: true, preset: "hold" });
    const token = makeToken({ actor });
    token.x = 0;
    token.y = 0;
    token.disposition = -1;
    const combatant = makeCombatant({ actor, token });
    combatant.tokenId = token.id;
    const combat = makeCombat({ round: 1, turn: 0, combatants: [combatant] });
    return { actor, token, combatant, combat };
}

/** Module API with an optional authority stub. */
function makeApi({ controller = true } = {}) {
    const api = createModuleApi();
    api.services.register("authority", {
        isController: () => controller
    });
    return api;
}

const SPEC = { direction: 45, arc: 45, range: 30, weaponId: "w1", name: "Lasgun" };

test("declare writes a sanitized cone record on the combatant flag", async () => {
    const { combat, combatant } = makeWorld();
    const service = createOverwatchService({ api: makeApi() });
    const result = await service.declare({ combat, combatant, spec: SPEC });
    assert.equal(result.ok, true);
    const record = combatant.getFlag(MODULE_ID, FLAG_KEYS.overwatch);
    assert.ok(record);
    assert.equal(record.direction, 45);
    assert.equal(record.arc, 45);
    assert.equal(record.range, 30);
    assert.equal(record.weaponId, "w1");
    assert.equal(record.combatantId, combatant.id);
    assert.equal(record.tokenId, combatant.tokenId);
    assert.equal(record.round, 1);
});

test("declare is refused for a non-controller client", async () => {
    const { combat, combatant } = makeWorld();
    const service = createOverwatchService({ api: makeApi({ controller: false }) });
    const result = await service.declare({ combat, combatant, spec: SPEC });
    assert.equal(result.ok, false);
    assert.equal(result.reason, OVERWATCH_REASONS.notController);
    assert.equal(combatant.getFlag(MODULE_ID, FLAG_KEYS.overwatch), undefined);
});

test("declare rejects specs without direction or range", async () => {
    const { combat, combatant } = makeWorld();
    const service = createOverwatchService({ api: makeApi() });
    const bad = await service.declare({ combat, combatant, spec: { range: 30 } });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, OVERWATCH_REASONS.invalidSpec);
    const noRange = await service.declare({ combat, combatant, spec: { direction: 10 } });
    assert.equal(noRange.ok, false);
    assert.equal(noRange.reason, OVERWATCH_REASONS.invalidSpec);
});

test("overwatchOf and clear round-trip the declaration", async () => {
    const { combat, combatant } = makeWorld();
    const service = createOverwatchService({ api: makeApi() });
    assert.equal(service.overwatchOf(combatant), null);
    await service.declare({ combat, combatant, spec: SPEC });
    assert.equal(service.overwatchOf(combatant).direction, 45);
    const cleared = await service.clear(combatant);
    assert.equal(cleared.ok, true);
    assert.equal(service.overwatchOf(combatant), null);
});

test("activeOverwatches lists declarations of the active combat only", async () => {
    const { combat, combatant } = makeWorld();
    const service = createOverwatchService({ api: makeApi() });
    assert.deepEqual(service.activeOverwatches(combat), []);
    await service.declare({ combat, combatant, spec: SPEC });
    const entries = service.activeOverwatches(combat);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].combatant.id, combatant.id);
    // A foreign combat sees no declarations of this combatant.
    const other = makeCombat({ round: 2, turn: 0, combatants: [] });
    assert.deepEqual(service.activeOverwatches(other), []);
});

test("turn-start expiry keeps a same-round declaration and ignores flag writes (smoke)", async () => {
    // Smoke finding: re-deploying overwatch wiped both zones — the
    // module's own `operation` flag writes fire `updateCombat` too, and
    // the expiry pass cleared the fresh record on every update.
    const { combat, combatant } = makeWorld();
    const service = createOverwatchService({ api: makeApi() });
    service.start();
    try {
        await service.declare({ combat, combatant, spec: SPEC });
        const handler = Hooks._calls
            .filter(call => call.type === "on" && call.event === "updateCombat")
            .at(-1)?.fn;
        assert.ok(handler, "updateCombat expiry handler registered");
        // A Combat flag write (module operation bookkeeping) changes
        // neither round nor turn — it must not expire the zone.
        handler(combat, { flags: { "only-war-ai": { operation: {} } } });
        assert.equal(service.overwatchOf(combatant)?.direction, 45,
            "a non-turn update must not clear the fresh declaration");
        // A turn advance inside the same round: a record declared this
        // round is still fresh — it only expires on a later round.
        combat.turn = 1;
        handler(combat, { turn: 1 });
        assert.equal(service.overwatchOf(combatant)?.direction, 45,
            "a same-round re-declaration survives the turn-start pass");
        // The next round's turn start does expire it (OW: until your
        // next turn).
        combat.round = 2;
        combat.turn = 0;
        handler(combat, { round: 2, turn: 0 });
        assert.equal(service.overwatchOf(combatant), null,
            "the declaration expires on the next round's turn start");
    } finally {
        service.stop();
    }
});

test("renderAll is a no-op for non-GM clients and absent PIXI", () => {
    const { combat, combatant } = makeWorld();
    const service = createOverwatchService({ api: makeApi() });
    const wasGM = game.user.isGM;
    try {
        // Non-GM client: rendering stays off even with an active record.
        game.user.isGM = false;
        assert.doesNotThrow(() => service.renderAll());
        game.user.isGM = true;
        game.combat = combat;
        // GM client without PIXI (unit environment) still must not throw.
        assert.doesNotThrow(() => service.renderAll());
    } finally {
        game.user.isGM = wasGM;
        game.combat = null;
    }
});
