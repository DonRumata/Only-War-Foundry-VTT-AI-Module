/**
 * Unit matrix for the active-GM authority service and the Combat operation
 * lifecycle (issue #400).
 *
 * Covers deterministic controller election, compare-before-update claims,
 * phase transitions, controller-change aborts, idempotent completion, the
 * waiting-for-gm state, the debounce/relevance filter, turn detection and
 * the module socket protocol.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    createAuthorityService,
    electController,
    isRelevantChange,
    isTurnChange
} from "../../scripts/authority.js";
import { createOperationService, readOperation } from "../../scripts/operations.js";
import {
    AUTHORITY_STATUS,
    FLAG_KEYS,
    MODULE_ID,
    OPERATION_REASONS,
    SOCKET_CHANNEL
} from "../../scripts/constants.js";
import {
    makeActor,
    makeCombat,
    makeCombatant,
    makeUser
} from "./fixtures.mjs";

/* ---------- Test doubles ---------- */

function makeHooks() {
    const handlers = new Map();
    return {
        on: (event, fn) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
        off: (event, fn) => handlers.set(event, (handlers.get(event) ?? []).filter(f => f !== fn)),
        callAll: () => {},
        trigger: (event, ...args) => (handlers.get(event) ?? []).forEach(fn => fn(...args))
    };
}

function makeScheduler() {
    const pending = new Set();
    return {
        schedule: fn => { pending.add(fn); return fn; },
        unschedule: timer => pending.delete(timer),
        run: () => { const fns = [...pending]; pending.clear(); fns.forEach(fn => fn()); },
        get size() {
            return pending.size;
        }
    };
}

function makeSocket() {
    const emitted = [];
    const handlers = new Map();
    return {
        emitted,
        emit: (channel, payload) => emitted.push({ channel, payload }),
        on: (channel, fn) => handlers.set(channel, fn),
        off: channel => handlers.delete(channel),
        receive: (channel, payload) => handlers.get(channel)?.(payload)
    };
}

function makeOperations() {
    let seq = 0;
    return createOperationService({
        now: () => 1000,
        idGen: () => `op-${++seq}`
    });
}

function makeAuthority({
    users,
    selfId,
    mode = "preview",
    hooks = makeHooks(),
    socket = null,
    scheduler = makeScheduler(),
    combats = [],
    activeCombat = null,
    operations = makeOperations(),
    runAIPlan = null,
    enabled = true,
    getUsers = null
} = {}) {
    const svc = createAuthorityService({
        operations,
        getUsers: getUsers ?? (() => users),
        getSelf: () => ({ id: selfId }),
        getCombats: () => combats,
        getCombat: () => activeCombat,
        isEnabled: () => enabled,
        getMode: () => mode,
        hooks,
        getSocket: () => socket,
        schedule: scheduler.schedule,
        unschedule: scheduler.unschedule,
        debounceMs: 10,
        runAIPlan,
        log: () => {}
    });
    return { svc, hooks, scheduler, socket, operations };
}

function makeEnabledCombat({ round = 1, turn = 0 } = {}) {
    const actor = makeActor({ enabled: true, preset: "assault" });
    const combatant = makeCombatant({ actor });
    const combat = makeCombat({ round, turn, combatants: [combatant] });
    return { combat, combatant, actor };
}

/* ---------- Election ---------- */

test("electController picks the active GM with the lowest user id", () => {
    const users = [
        makeUser({ id: "gm-b", isGM: true }),
        makeUser({ id: "player-1", isGM: false }),
        makeUser({ id: "gm-a", isGM: true })
    ];
    const { controllerId, status } = electController(users);
    assert.equal(controllerId, "gm-a");
    assert.equal(status, AUTHORITY_STATUS.ready);
});

test("electController is deterministic: shuffled users give the same controller", () => {
    const a = [
        makeUser({ id: "gm-1", isGM: true }),
        makeUser({ id: "gm-2", isGM: true }),
        makeUser({ id: "pl-1" })
    ];
    const b = [a[2], a[0], a[1]];
    const c = [a[1], a[2], a[0]];
    // Two simulated clients must agree without voting.
    assert.deepEqual(electController(a), electController(b));
    assert.deepEqual(electController(b), electController(c));
    assert.equal(electController(c).controllerId, "gm-1");
});

test("electController ignores inactive GMs and non-GM users", () => {
    const users = [
        makeUser({ id: "gm-off", isGM: true, active: false }),
        makeUser({ id: "pl-1" }),
        makeUser({ id: "gm-on", isGM: true })
    ];
    assert.equal(electController(users).controllerId, "gm-on");
});

test("electController accepts role === 4 as GM", () => {
    const users = [makeUser({ id: "gm", isGM: false, role: 4 })];
    assert.equal(electController(users).controllerId, "gm");
});

test("electController reports waiting-for-gm without an active GM", () => {
    assert.deepEqual(electController([]), {
        controllerId: null,
        status: AUTHORITY_STATUS.waitingForGm
    });
    const onlyPlayers = [makeUser({ id: "p1" }), makeUser({ id: "p2" })];
    assert.equal(electController(onlyPlayers).status, AUTHORITY_STATUS.waitingForGm);
    const offlineGm = [makeUser({ id: "gm", isGM: true, active: false })];
    assert.equal(electController(offlineGm).status, AUTHORITY_STATUS.waitingForGm);
});

test("electController accepts a Foundry-style collection with .contents", () => {
    const users = { contents: [makeUser({ id: "gm", isGM: true })] };
    assert.equal(electController(users).controllerId, "gm");
});

/* ---------- claimTurn ---------- */

test("claimTurn writes an authoritative operation flag", async () => {
    const { combat, combatant } = makeEnabledCombat({ round: 2, turn: 0 });
    const ops = makeOperations();
    const claim = await ops.claimTurn(combat, combatant, { controllerId: "gm-1" });

    assert.equal(claim.ok, true);
    const stored = readOperation(combat);
    assert.equal(stored.id, claim.operation.id);
    assert.equal(stored.combatId, combat.id);
    assert.equal(stored.combatantId, combatant.id);
    assert.equal(stored.round, 2);
    assert.equal(stored.turn, 0);
    assert.equal(stored.controllerId, "gm-1");
    assert.equal(stored.phase, "planning");
    assert.equal(typeof stored.revision, "string");
    assert.equal(stored.startedAt, 1000);
    assert.deepEqual(stored, combat.getFlag(MODULE_ID, FLAG_KEYS.operation));
});

test("second claim for the same turn sees operation-exists", async () => {
    const { combat, combatant } = makeEnabledCombat();
    const ops = makeOperations();
    const first = await ops.claimTurn(combat, combatant, { controllerId: "gm-1" });
    const second = await ops.claimTurn(combat, combatant, { controllerId: "gm-1" });

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.reason, OPERATION_REASONS.operationExists);
    assert.equal(second.operation.id, first.operation.id);
});

test("claim on a new turn marks the old live operation turn-stale", async () => {
    const { combat, combatant } = makeEnabledCombat({ round: 1, turn: 0 });
    const ops = makeOperations();
    const first = await ops.claimTurn(combat, combatant, { controllerId: "gm-1" });
    assert.equal(first.ok, true);

    combat.turn = 1;
    const other = makeCombatant({ actor: combatant.actor });
    const second = await ops.claimTurn(combat, other, { controllerId: "gm-1" });

    assert.equal(second.ok, true);
    assert.notEqual(second.operation.id, first.operation.id);
    assert.equal(second.operation.phase, "planning");
});

test("computeRevision changes when the turn or token position changes", async () => {
    const { combat, combatant } = makeEnabledCombat({ round: 1, turn: 0 });
    const ops = makeOperations();
    const base = ops.computeRevision(combat, combatant);
    assert.equal(ops.computeRevision(combat, combatant), base, "deterministic");

    combat.turn = 1;
    assert.notEqual(ops.computeRevision(combat, combatant), base);
    combat.turn = 0;
    combatant.token = { ...(combatant.token ?? {}), id: "tok", x: 10, y: 5 };
    const withToken = ops.computeRevision(combat, combatant);
    combatant.token.x = 99;
    assert.notEqual(ops.computeRevision(combat, combatant), withToken);
});

/* ---------- transitionOperation ---------- */

test("transitionOperation advances planning → awaiting-preview → executing", async () => {
    const { combat, combatant } = makeEnabledCombat();
    const ops = makeOperations();
    const claim = await ops.claimTurn(combat, combatant, { controllerId: "gm-1" });

    const preview = await ops.transitionOperation(combat, claim.operation.id, "planning", "awaiting-preview");
    assert.equal(preview.ok, true);
    assert.equal(preview.operation.phase, "awaiting-preview");

    const executing = await ops.transitionOperation(
        combat, claim.operation.id, "awaiting-preview", "executing"
    );
    assert.equal(executing.ok, true);
    assert.equal(executing.operation.phase, "executing");
    assert.equal(readOperation(combat).phase, "executing");
});

test("transitionOperation rejects a wrong expected phase (phase-mismatch)", async () => {
    const { combat, combatant } = makeEnabledCombat();
    const ops = makeOperations();
    const claim = await ops.claimTurn(combat, combatant, { controllerId: "gm-1" });

    const result = await ops.transitionOperation(combat, claim.operation.id, "executing", "completed");
    assert.equal(result.ok, false);
    assert.equal(result.reason, OPERATION_REASONS.phaseMismatch);
    assert.equal(readOperation(combat).phase, "planning");
});

test("transitionOperation rejects a foreign operation id", async () => {
    const { combat, combatant } = makeEnabledCombat();
    const ops = makeOperations();
    await ops.claimTurn(combat, combatant, { controllerId: "gm-1" });

    const result = await ops.transitionOperation(combat, "other-op", "planning", "executing");
    assert.equal(result.ok, false);
    assert.equal(result.reason, OPERATION_REASONS.operationMismatch);
});

test("transitionOperation rejects disallowed jumps and missing operations", async () => {
    const { combat, combatant } = makeEnabledCombat();
    const ops = makeOperations();
    const claim = await ops.claimTurn(combat, combatant, { controllerId: "gm-1" });

    const jump = await ops.transitionOperation(combat, claim.operation.id, "planning", "completed");
    assert.equal(jump.ok, false);
    assert.equal(jump.reason, OPERATION_REASONS.invalidTransition);

    const missing = await ops.transitionOperation(makeCombat({}), "x", "planning", "executing");
    assert.equal(missing.reason, OPERATION_REASONS.operationMissing);
});

/* ---------- completeTurn ---------- */

test("completeTurn finishes the operation and stores the result", async () => {
    const { combat, combatant } = makeEnabledCombat();
    const ops = makeOperations();
    const claim = await ops.claimTurn(combat, combatant, { controllerId: "gm-1" });
    await ops.transitionOperation(combat, claim.operation.id, "planning", "executing");

    const done = await ops.completeTurn(combat, claim.operation.id, { completed: true });
    assert.equal(done.ok, true);
    assert.equal(done.operation.phase, "completed");
    assert.equal(done.operation.completedAt, 1000);
    assert.equal(done.operation.result.completed, true);
});

test("completeTurn is idempotent: repeat returns already-completed no-op", async () => {
    const { combat, combatant } = makeEnabledCombat();
    const ops = makeOperations();
    const claim = await ops.claimTurn(combat, combatant, { controllerId: "gm-1" });
    await ops.completeTurn(combat, claim.operation.id, { completed: true });

    const repeat = await ops.completeTurn(combat, claim.operation.id, { completed: true });
    assert.equal(repeat.ok, true);
    assert.equal(repeat.noop, true);
    assert.equal(repeat.reason, OPERATION_REASONS.alreadyCompleted);
    assert.equal(readOperation(combat).phase, "completed");
});

test("completeTurn emits the operationCompleted hook (executor integration point)", async () => {
    const calls = [];
    const hooks = { callAll: (event, combat, op) => calls.push({ event, op }) };
    const ops = createOperationService({ idGen: () => "op-x", hooks });
    const { combat, combatant } = makeEnabledCombat();
    const claim = await ops.claimTurn(combat, combatant, { controllerId: "gm" });
    await ops.completeTurn(combat, claim.operation.id, { completed: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].event, `${MODULE_ID}.operationCompleted`);
    assert.equal(calls[0].op.phase, "completed");
});

/* ---------- controller change ---------- */

test("abortIfControllerChanged cancels foreign live operations", async () => {
    const { combat, combatant } = makeEnabledCombat();
    const ops = makeOperations();
    await ops.claimTurn(combat, combatant, { controllerId: "gm-old" });

    const same = await ops.abortIfControllerChanged(combat, "gm-old");
    assert.equal(same.aborted, false);

    const changed = await ops.abortIfControllerChanged(combat, "gm-new");
    assert.equal(changed.aborted, true);
    assert.equal(changed.operation.phase, "cancelled");
    assert.equal(changed.operation.reason, OPERATION_REASONS.controllerChanged);

    const terminal = await ops.abortIfControllerChanged(combat, "gm-other");
    assert.equal(terminal.aborted, false);
});

test("new controller marks foreign operations stale on refresh; old client stops", async () => {
    const { combat } = makeEnabledCombat();
    const ops = makeOperations();
    const hooksA = makeHooks();
    const hooksB = makeHooks();
    let users = [makeUser({ id: "gm-a", isGM: true })];

    // Client A is controller and owns a live operation (runAIPlan leaves it
    // in awaiting-preview so it is still live when the controller changes).
    const A = makeAuthority({
        users, selfId: "gm-a", hooks: hooksA, combats: [combat], activeCombat: combat,
        operations: ops, runAIPlan: async () => {}, getUsers: () => users
    });
    A.svc.start();
    A.scheduler.run();
    await A.svc.flush();
    assert.equal(A.svc.isController(), true);
    assert.equal(A.svc.localOperations.length, 1);
    assert.equal(readOperation(combat).phase, "awaiting-preview");

    // GM-A disconnects; client B becomes controller and invalidates the plan.
    users = [makeUser({ id: "gm-b", isGM: true })];
    const B = makeAuthority({
        users, selfId: "gm-b", hooks: hooksB, combats: [combat], operations: ops,
        getUsers: () => users
    });
    B.svc.refresh();
    await B.svc.flush();

    assert.equal(B.svc.isController(), true);
    const stored = readOperation(combat);
    assert.equal(stored.phase, "cancelled");
    assert.equal(stored.reason, OPERATION_REASONS.controllerChanged);

    // The old client's refresh stops its local process.
    A.svc.refresh();
    assert.equal(A.svc.isController(), false);
    assert.deepEqual(A.svc.localOperations, []);
});

/* ---------- waiting-for-gm ---------- */

test("service reports waiting-for-gm and never writes flags without a GM", async () => {
    const { combat } = makeEnabledCombat();
    const users = [makeUser({ id: "pl-1" })];
    const { svc, hooks, scheduler } = makeAuthority({
        users, selfId: "pl-1", combats: [combat], activeCombat: combat
    });
    svc.start();
    await svc.flush();

    assert.equal(svc.status(), AUTHORITY_STATUS.waitingForGm);
    assert.equal(svc.isController(), false);

    hooks.trigger("updateCombat", combat, { turn: 1 });
    scheduler.run();
    await svc.flush();
    assert.equal(readOperation(combat), null, "no operation flag without a GM");
});

test("disabled module reports status disabled and ignores hooks", async () => {
    const { combat } = makeEnabledCombat();
    const users = [makeUser({ id: "gm", isGM: true })];
    const { svc, hooks, scheduler } = makeAuthority({
        users, selfId: "gm", combats: [combat], enabled: false
    });
    svc.start();
    assert.equal(svc.status(), AUTHORITY_STATUS.disabled);
    hooks.trigger("updateCombat", combat, { turn: 1 });
    assert.equal(scheduler.size, 0);
});

/* ---------- debounce / relevance filter ---------- */

test("isRelevantChange filters irrelevant updates per document", () => {
    assert.equal(isRelevantChange("Combat", { turn: 1 }), true);
    assert.equal(isRelevantChange("Combat", { round: 2 }), true);
    assert.equal(isRelevantChange("Combat", { name: "renamed" }), false);
    assert.equal(isRelevantChange("Combat", { flags: { [MODULE_ID]: { operation: {} } } }), true);
    assert.equal(isRelevantChange("Combat", { flags: { other: {} } }), false);

    assert.equal(isRelevantChange("Combatant", { initiative: 12 }), true);
    assert.equal(isRelevantChange("Combatant", { defeated: true }), true);
    assert.equal(isRelevantChange("Combatant", { name: "x" }), false);
    assert.equal(isRelevantChange("Combatant", { flags: { [MODULE_ID]: { override: {} } } }), true);

    assert.equal(isRelevantChange("Token", { x: 100 }), true);
    assert.equal(isRelevantChange("Token", { y: 50, elevation: 2 }), true);
    assert.equal(isRelevantChange("Token", { name: "x" }), false);

    assert.equal(isRelevantChange("Actor", { name: "x" }), false);
    assert.equal(isRelevantChange("Actor", { flags: { [MODULE_ID]: { config: {} } } }), true);

    assert.equal(isRelevantChange("Item", { x: 1 }), false);
    assert.equal(isRelevantChange("Combat", null), false);
    assert.equal(isRelevantChange("Combat", "turn"), false);
});

test("isTurnChange detects turn/round diffs only", () => {
    assert.equal(isTurnChange({ turn: 1 }), true);
    assert.equal(isTurnChange({ round: 2 }), true);
    assert.equal(isTurnChange({ turn: 1, round: 2 }), true);
    assert.equal(isTurnChange({ flags: {} }), false);
    assert.equal(isTurnChange(undefined), false);
});

test("debounce: many updates collapse into a single scheduled flush", async () => {
    const { combat } = makeEnabledCombat();
    const users = [makeUser({ id: "gm", isGM: true })];
    const { svc, hooks, scheduler } = makeAuthority({
        users, selfId: "gm", combats: [combat]
    });
    svc.start();
    // Becoming controller schedules an initial evaluation — drain it first.
    scheduler.run();
    await svc.flush();
    assert.equal(scheduler.size, 0);

    // Irrelevant updates never schedule.
    hooks.trigger("updateCombat", combat, { name: "renamed" });
    hooks.trigger("updateActor", combatantActor(combat), { name: "x" });
    assert.equal(scheduler.size, 0, "irrelevant updates must not schedule");

    // Relevant updates schedule exactly one pending flush.
    hooks.trigger("updateCombat", combat, { turn: 1 });
    hooks.trigger("updateToken", {}, { x: 10 });
    hooks.trigger("updateCombatant", {}, { initiative: 5 });
    assert.equal(scheduler.size, 1, "updates debounced into one flush");

    scheduler.run();
    await svc.flush();
    assert.equal(scheduler.size, 0);
});

function combatantActor(combat) {
    return combat.turns[0]?.actor ?? null;
}

/* ---------- turn detection end-to-end ---------- */

test("turn change on an enabled combatant claims and finishes safely without executor", async () => {
    const { combat, combatant } = makeEnabledCombat({ round: 1, turn: 0 });
    const users = [makeUser({ id: "gm", isGM: true })];
    const { svc, hooks, scheduler } = makeAuthority({
        users, selfId: "gm", combats: [combat], activeCombat: combat
    });
    svc.start();
    assert.equal(svc.isController(), true);

    hooks.trigger("updateCombat", combat, { turn: 0, round: 1 });
    scheduler.run();
    await svc.flush();

    const stored = readOperation(combat);
    assert.ok(stored, "operation flag written");
    assert.equal(stored.controllerId, "gm");
    // Preview mode claimed and then completed safely without an executor.
    assert.equal(stored.phase, "completed");
    assert.equal(stored.result.completed, false);
    assert.equal(stored.reason, OPERATION_REASONS.noExecutor);
    assert.ok(combatant.id === stored.combatantId);
});

test("runAIPlan receives the operation in awaiting-preview phase (preview mode)", async () => {
    const { combat } = makeEnabledCombat();
    const users = [makeUser({ id: "gm", isGM: true })];
    const seen = [];
    const { svc, hooks, scheduler } = makeAuthority({
        users, selfId: "gm", combats: [combat], activeCombat: combat,
        runAIPlan: async ({ operation, operations }) => {
            seen.push(operation.phase);
            await operations.completeTurn(combat, operation.id, { completed: true });
        }
    });
    svc.start();

    hooks.trigger("updateCombat", combat, { turn: 0, round: 1 });
    scheduler.run();
    await svc.flush();

    assert.deepEqual(seen, ["awaiting-preview"]);
    assert.equal(readOperation(combat).phase, "completed");
    assert.equal(readOperation(combat).result.completed, true);
});

test("automatic mode transitions planning → executing before runAIPlan", async () => {
    const { combat } = makeEnabledCombat();
    const users = [makeUser({ id: "gm", isGM: true })];
    const seen = [];
    const { svc, hooks, scheduler } = makeAuthority({
        users, selfId: "gm", combats: [combat], activeCombat: combat, mode: "automatic",
        runAIPlan: async ({ operation }) => { seen.push(operation.phase); }
    });
    svc.start();

    hooks.trigger("updateCombat", combat, { turn: 0, round: 1 });
    scheduler.run();
    await svc.flush();

    assert.deepEqual(seen, ["executing"]);
    // The stub did not complete the operation — it stays live in executing.
    assert.equal(readOperation(combat).phase, "executing");
});

test("duplicate turn-change hooks do not create a second operation", async () => {
    const { combat } = makeEnabledCombat();
    const users = [makeUser({ id: "gm", isGM: true })];
    const { svc, hooks, scheduler } = makeAuthority({
        users, selfId: "gm", combats: [combat], activeCombat: combat
    });
    svc.start();

    hooks.trigger("updateCombat", combat, { turn: 0, round: 1 });
    hooks.trigger("updateCombat", combat, { turn: 0, round: 1 });
    scheduler.run();
    await svc.flush();
    await svc.flush();

    const stored = readOperation(combat);
    assert.ok(stored);
    assert.equal(stored.phase, "completed");
    assert.deepEqual(svc.claimedKeys, [`${combat.id}:${combat.turns[0].id}:1:0`]);
});

test("disabled combatant does not get claimed", async () => {
    const combat = makeCombat({ round: 1, turn: 0, combatants: [makeCombatant({ actor: makeActor() })] });
    const users = [makeUser({ id: "gm", isGM: true })];
    const { svc, hooks, scheduler } = makeAuthority({
        users, selfId: "gm", combats: [combat], activeCombat: combat
    });
    svc.start();
    hooks.trigger("updateCombat", combat, { turn: 0, round: 1 });
    scheduler.run();
    await svc.flush();
    assert.equal(readOperation(combat), null);
});

/* ---------- socket protocol ---------- */

test("sendRequest emits ai-request on the module channel", () => {
    const socket = makeSocket();
    const { svc } = makeAuthority({
        users: [makeUser({ id: "gm", isGM: true })],
        selfId: "gm",
        socket
    });
    svc.refresh();
    assert.equal(svc.sendRequest({ kind: "rerun" }), true);
    const requests = socket.emitted.filter(m => m.payload.type === "ai-request");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].channel, SOCKET_CHANNEL);
    assert.equal(requests[0].payload.userId, "gm");
    assert.equal(requests[0].payload.kind, "rerun");
});

test("ai-request is ignored on non-controller clients", async () => {
    const { combat } = makeEnabledCombat();
    const socket = makeSocket();
    const users = [
        makeUser({ id: "gm", isGM: true }),
        makeUser({ id: "pl" })
    ];
    const { svc } = makeAuthority({
        users, selfId: "pl", socket, combats: [combat], activeCombat: combat
    });
    svc.start();
    socket.receive(SOCKET_CHANNEL, { type: "ai-request", userId: "other" });
    await svc.flush();
    assert.equal(readOperation(combat), null, "non-controller must ignore requests");
});

test("ai-request nudges the controller to re-evaluate the active combat", async () => {
    const { combat } = makeEnabledCombat();
    const socket = makeSocket();
    const users = [makeUser({ id: "gm", isGM: true })];
    const { svc } = makeAuthority({
        users, selfId: "gm", socket, combats: [combat], activeCombat: combat
    });
    svc.start();

    socket.receive(SOCKET_CHANNEL, { type: "ai-request", userId: "player-1" });
    await svc.flush();

    const stored = readOperation(combat);
    assert.ok(stored, "controller reacted to ai-request");
    assert.equal(stored.controllerId, "gm");
});

test("ai-status updates the remote status on receiving clients", () => {
    const socket = makeSocket();
    const { svc } = makeAuthority({
        users: [makeUser({ id: "gm", isGM: true })],
        selfId: "pl",
        socket
    });
    svc.start();
    socket.receive(SOCKET_CHANNEL, {
        type: "ai-status",
        userId: "gm",
        controllerId: "gm",
        status: "ready"
    });
    assert.deepEqual(svc.remoteStatus, { controllerId: "gm", status: "ready", from: "gm" });
});

test("broadcastStatus emits the elected controller and status", () => {
    const socket = makeSocket();
    const { svc } = makeAuthority({
        users: [makeUser({ id: "gm", isGM: true })],
        selfId: "gm",
        socket
    });
    svc.refresh();
    assert.equal(svc.broadcastStatus(), true);
    assert.equal(socket.emitted[0].payload.type, "ai-status");
    assert.equal(socket.emitted[0].payload.controllerId, "gm");
    assert.equal(socket.emitted[0].payload.status, "ready");
});

/* ---------- statusText ---------- */

test("statusText maps statuses onto localized keys", () => {
    const { svc } = makeAuthority({
        users: [makeUser({ id: "pl" })],
        selfId: "pl"
    });
    svc.refresh();
    assert.equal(svc.statusText(), "OWAI.Authority.Status.WaitingForGm");
});
