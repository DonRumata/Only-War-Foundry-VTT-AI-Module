/**
 * Unit tests for the layered reason trace (issue #27): materialized
 * `diagnostics.trace` entries per layer, the enriched L4 winner record
 * (top-3, runner-up margin, factor contributions), L3 per-factor deltas,
 * compact/full trace rendering, the compact GM-whisper line, the preview
 * "How it decided" view-model block and the replay-capture helpers.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    CAPTURE_JOURNAL_MAX,
    FLAG_KEYS,
    MODULE_ID,
    SETTING_KEYS
} from "../../scripts/constants.js";
import { createExecutorService, EXECUTOR_STATUS } from "../../scripts/executor.js";
import { createModuleApi } from "../../scripts/api.js";
import {
    PLANNER_STATUS,
    createPlannerService
} from "../../scripts/planner.js";
import {
    appendCaptureEntry,
    buildCaptureEntry,
    buildLayerTrace,
    compactTraceLine,
    factorDelta,
    formatCandidate,
    renderTrace,
    sanitizeCaptureContext,
    sanitizeCaptureJournal
} from "../../scripts/trace.js";
import {
    getTraceMode,
    isCaptureContextEnabled,
    registerSettings
} from "../../scripts/settings.js";
import {
    buildPreviewViewModel,
    localizePreviewViewModel
} from "../../scripts/ui/preview-dialog.js";
import {
    makeActor,
    makeCombatant,
    makeScene,
    makeToken
} from "./fixtures.mjs";

let _combatId = 0;
let _opId = 0;

/** Minimal Combat fixture. */
function makeCombat({ combatants = [] } = {}) {
    const collection = new Map(combatants.map(c => [c.id, c]));
    collection.contents = combatants;
    return {
        documentName: "Combat",
        id: `trace-combat-${++_combatId}`,
        round: 1,
        turn: 0,
        combatants: collection,
        turns: combatants,
        scene: null,
        ended: false,
        get combatant() {
            return this.turns[this.turn] ?? null;
        }
    };
}

/** Lasgun-equivalent ranged weapon item. */
const RANGED_WEAPON = {
    id: "w1",
    uuid: "Actor.npc.Item.w1",
    name: "Lasgun",
    type: "weapon",
    system: { class: "ranged", range: 100, damage: "1d10+3" }
};

/**
 * Small AI world: one assault NPC plus a hostile at `(300, 0)`.
 * @param {object} [options]
 * @returns {object}
 */
function makeWorld({ weapons = [RANGED_WEAPON] } = {}) {
    const scene = makeScene({ grid: "square" });
    const actor = makeActor({ enabled: true, preset: "assault" });
    actor.system = { wounds: { value: 12, max: 14 } };
    actor.items = weapons;
    const token = makeToken({ actor });
    token.x = 0;
    token.y = 0;
    token.elevation = 0;
    token.disposition = -1;
    const combatant = makeCombatant({ actor, token });
    combatant.tokenId = token.id;
    token.move = async waypoints => {
        const last = waypoints.at(-1);
        token.x = last.x;
        token.y = last.y;
        return true;
    };

    const enemyActor = makeActor();
    enemyActor.system = { wounds: { value: 10, max: 10 } };
    enemyActor.items = [];
    const enemyToken = makeToken({ actor: enemyActor });
    enemyToken.x = 300;
    enemyToken.y = 0;
    enemyToken.elevation = 0;
    enemyToken.disposition = 1;
    const enemy = makeCombatant({ actor: enemyActor, token: enemyToken });
    enemy.tokenId = enemyToken.id;

    const combat = makeCombat({ combatants: [combatant, enemy] });
    combat.scene = scene;
    combat.nextTurn = async () => {
        combat.turn += 1;
        return combat;
    };
    return { scene, actor, token, combatant, enemy, enemyToken, combat };
}

/**
 * Injected planTurn context: an out-of-range melee action (stacked L0
 * `out-of-range` vetoes) plus a working ranged attack, morale posture
 * and an explicit personality — every layer writes a reason.
 * @param {object} world
 * @returns {object}
 */
function planContext(world) {
    return {
        seed: 7,
        targets: [{
            tokenId: world.enemyToken.id,
            tokenUuid: `Scene.${world.scene.id}.Token.${world.enemyToken.id}`,
            x: 300,
            y: 0,
            elevation: 0,
            distance: 4.5,
            canAttack: true,
            source: "injected"
        }],
        actions: [
            {
                id: "knife", type: "attack", name: "Knife",
                itemUuid: "Actor.npc.Item.knife", itemId: "knife",
                class: "melee", range: 2, cost: "half"
            },
            {
                id: "lasgun", type: "attack", name: "Lasgun",
                itemUuid: "Actor.npc.Item.las", itemId: "las",
                class: "ranged", range: 100, cost: "half"
            }
        ],
        moves: [{
            key: "m1",
            x: 200,
            y: 0,
            i: 2,
            j: 0,
            cost: 2,
            distance: 1.5,
            waypoints: [{ x: 100, y: 0 }, { x: 200, y: 0 }]
        }],
        // Pinned vetoes every movement-based candidate (pinned ×N) while
        // the melee knife adds an out-of-range veto — the compact render
        // groups them all into one L0 line.
        selfStatuses: ["pinned"],
        morale: { state: "desperate" },
        personality: ["cowardly"]
    };
}

/** Plan a traced turn for {@link makeWorld}. */
async function makePlan(world, extra = {}) {
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, {
        ...planContext(world),
        ...extra
    });
    return result;
}

/* ------------------------------------------------------------------ */
/* Materialized trace entries                                          */
/* ------------------------------------------------------------------ */

test("planTurn materializes diagnostics.trace — one entry per reason record", async () => {
    _resetMocks();
    const world = makeWorld();
    const result = await makePlan(world);
    assert.equal(result.status, PLANNER_STATUS.ok);
    const diagnostics = result.plan.diagnostics;
    assert.ok(Array.isArray(diagnostics.trace), "trace array materialized");
    assert.equal(diagnostics.trace.length, diagnostics.layers.length,
        "one trace entry per reason record");
    // Serializable — the trace survives a JSON round-trip unchanged.
    assert.deepEqual(JSON.parse(JSON.stringify(diagnostics.trace)), diagnostics.trace);
    // Every layer reports.
    const layers = new Set(diagnostics.trace.map(e => e.layer));
    for (const layer of ["L0", "L1", "L2", "L3", "L4"]) {
        assert.ok(layers.has(layer), `expected a ${layer} trace entry`);
    }
});

test("buildLayerTrace maps reason records to per-layer trace entries", async () => {
    _resetMocks();
    const diagnostics = { layers: [
        { layer: "L0", code: "out-of-range", detail: "attack-in-place|t1|stay|k|0" },
        { layer: "L0", code: "out-of-range", detail: "charge|k|t1|0" },
        { layer: "L1", code: "commitment-miss", detail: { reason: "no-commitment" } },
        { layer: "L1", code: "gm-intervention", detail: { from: { x: 0 } } },
        { layer: "L1", code: "commitment-hit", detail: { source: "planner", steps: 3 } },
        { layer: "L2", code: "morale-posture", detail: { tier: "pressured", effectiveTier: "desperate" } },
        { layer: "L2", code: "morale-weight-shift", detail: { tier: "desperate", effectiveTier: "desperate", deltas: { charge: -8 } } },
        { layer: "L2", code: "morale-layer-disabled" },
        { layer: "L3", code: "personality-overlay", detail: { traits: ["cowardly"], character: "rabble", deltas: { proximity: -1.5 } } },
        { layer: "L4", code: "scored", detail: { candidates: 5 } },
        { layer: "L4", code: "winner", detail: { candidate: "hold|stay", score: 9 } },
        { layer: "L4", code: "something-new", detail: { x: 1 } }
    ] };
    const entries = buildLayerTrace(diagnostics);
    assert.equal(entries.length, diagnostics.layers.length);
    assert.deepEqual(entries[0], {
        layer: "L0", code: "out-of-range", kind: "veto",
        candidate: "attack-in-place|t1|stay|k|0"
    });
    assert.equal(entries[2].kind, "commitment-miss");
    assert.equal(entries[2].reason, "no-commitment");
    assert.equal(entries[3].kind, "commitment-cancelled");
    assert.equal(entries[3].code, "gm-intervention");
    assert.equal(entries[4].kind, "commitment-hit");
    assert.equal(entries[4].steps, 3);
    assert.equal(entries[5].kind, "morale");
    assert.equal(entries[5].effectiveTier, "desperate");
    assert.equal(entries[6].kind, "morale-shift");
    assert.deepEqual(entries[6].deltas, { charge: -8 });
    assert.equal(entries[7].kind, "disabled");
    assert.equal(entries[8].kind, "personality");
    assert.deepEqual(entries[8].traits, ["cowardly"]);
    assert.equal(entries[9].kind, "scored");
    assert.equal(entries[9].candidates, 5);
    assert.equal(entries[10].kind, "winner");
    // Unknown codes degrade to a generic record — never dropped.
    assert.equal(entries[11].kind, "record");
    assert.equal(entries[11].code, "something-new");
    assert.equal(buildLayerTrace(null).length, 0);
    assert.equal(buildLayerTrace({}).length, 0);
});

/* ------------------------------------------------------------------ */
/* L3 deltas and L4 winner explainability                              */
/* ------------------------------------------------------------------ */

test("L3 personality-overlay records the applied per-factor deltas", async () => {
    _resetMocks();
    const world = makeWorld();
    const result = await makePlan(world);
    const overlay = result.plan.diagnostics.layers.find(
        r => r.layer === "L3" && r.code === "personality-overlay");
    assert.ok(overlay, "overlay record present");
    assert.deepEqual(overlay.detail.traits, ["cowardly"]);
    assert.ok(overlay.detail.deltas && typeof overlay.detail.deltas === "object",
        "per-factor deltas ride the reason detail");
    assert.ok(Object.keys(overlay.detail.deltas).length > 0,
        "cowardly bends at least one factor");
    // Every delta is the effective-minus-base weight difference.
    assert.ok(overlay.detail.deltas.proximity !== undefined
        || overlay.detail.deltas.attackNow !== undefined,
        `expected proximity/attackNow deltas, got ${JSON.stringify(overlay.detail.deltas)}`);
    // The trace entry carries the same delta map.
    const entry = result.plan.diagnostics.trace.find(e => e.kind === "personality");
    assert.deepEqual(entry.deltas, overlay.detail.deltas);
});

test("L4 winner records top-3 ranking, runner-up margin and factor contributions", async () => {
    _resetMocks();
    const world = makeWorld();
    const result = await makePlan(world);
    const winner = result.plan.diagnostics.layers.find(
        r => r.layer === "L4" && r.code === "winner");
    assert.ok(winner, "winner record present");
    const { detail } = winner;
    assert.ok(detail.candidate, "winner candidate id");
    assert.ok(Number.isFinite(detail.score), "winner score");
    assert.ok(Array.isArray(detail.top) && detail.top.length >= 1
        && detail.top.length <= 3, "top-3 ranking recorded");
    assert.equal(detail.top[0].candidate, detail.candidate,
        "the winner leads the top-3");
    assert.ok(detail.runnerUp, "runner-up recorded");
    assert.ok(Number.isFinite(detail.runnerUp.score));
    assert.ok(Number.isFinite(detail.margin));
    assert.ok(Math.abs(detail.margin - (detail.top[0].score - detail.runnerUp.score)) < 1e-4,
        "margin is the winner/runner-up score delta");
    assert.ok(Array.isArray(detail.factors) && detail.factors.length <= 3,
        "top-|delta| factor contributions recorded");
    for (const factor of detail.factors) {
        assert.ok(typeof factor.factor === "string" && factor.factor.length);
        assert.ok(Number.isFinite(factor.contribution) && factor.contribution !== 0);
    }
    // Sorted by |contribution| descending.
    const magnitudes = detail.factors.map(f => Math.abs(f.contribution));
    assert.deepEqual(magnitudes, [...magnitudes].sort((a, b) => b - a));
    // The same payload rides the materialized trace entry.
    const entry = result.plan.diagnostics.trace.find(e => e.kind === "winner");
    assert.equal(entry.candidate, detail.candidate);
    assert.equal(entry.margin, detail.margin);
    assert.deepEqual(entry.factors, detail.factors);
});

test("factorDelta reports contribution differences winner − runner-up", () => {
    const weights = { attackNow: 3, proximity: -2 };
    const winner = {
        factors: { attackNow: 2, proximity: 1 },
        breakdown: { factors: { attackNow: 2, proximity: 1 }, custom: true }
    };
    const runnerUp = {
        factors: { attackNow: 0, proximity: 3 },
        breakdown: { factors: { attackNow: 0, proximity: 3 }, custom: true }
    };
    const deltas = factorDelta(winner, runnerUp, weights);
    assert.deepEqual(deltas, [
        { factor: "attackNow", contribution: 6 },
        { factor: "proximity", contribution: 4 }
    ]);
    // Breakdown contributions win over the derived map.
    const withBreakdown = {
        breakdown: { contributions: { attackNow: 1, cover: 5 } }
    };
    const deltas2 = factorDelta(withBreakdown, runnerUp, weights);
    // cover +5 (breakdown) vs proximity +6 (derived: 0 − (3 × −2)).
    assert.equal(deltas2[0].factor, "proximity");
    assert.equal(deltas2[0].contribution, 6);
    assert.equal(deltas2[1].factor, "cover");
    // No runner-up → the winner's own top contributions.
    const solo = factorDelta(winner, null, weights);
    assert.equal(solo[0].factor, "attackNow");
    assert.equal(solo[0].contribution, 6);
});

/* ------------------------------------------------------------------ */
/* Compact / full rendering                                            */
/* ------------------------------------------------------------------ */

test("renderTrace compact collapses layers to verdict lines", async () => {
    _resetMocks();
    const world = makeWorld();
    const result = await makePlan(world);
    const diagnostics = result.plan.diagnostics;
    assert.ok(diagnostics.trace.filter(e => e.kind === "veto").length >= 2,
        "fixture produces several L0 vetoes");
    const compact = renderTrace(diagnostics.trace, { mode: "compact" });
    assert.ok(compact.length < diagnostics.trace.length,
        "compact mode groups the per-candidate vetoes");
    const l0 = compact.filter(line => line.startsWith("L0:"));
    assert.equal(l0.length, 1, "one grouped L0 veto line");
    assert.match(l0[0], /out-of-range/);
    const l4 = compact.filter(line => line.startsWith("L4:"));
    assert.equal(l4.length, 1, "one merged L4 scoring line");
    assert.match(l4[0], /scoring/);
    // Every rendered line carries its layer prefix.
    assert.ok(compact.every(line => /^L[0-4]:/.test(line)));
});

test("renderTrace full renders one line per reason record", async () => {
    _resetMocks();
    const world = makeWorld();
    const result = await makePlan(world);
    const diagnostics = result.plan.diagnostics;
    const full = renderTrace(diagnostics.trace, { mode: "full" });
    assert.equal(full.length, diagnostics.trace.length);
    const vetoes = full.filter(line => line.startsWith("L0:"));
    assert.ok(vetoes.length >= 2, "per-candidate veto lines");
    assert.ok(vetoes.some(line => line.includes("attack-in-place")
        || line.includes("charge")), "the candidate rides the veto line");
    const scoring = full.filter(line => line.startsWith("L4:"));
    assert.ok(scoring.some(line => line.includes("scored")));
    assert.ok(scoring.some(line => line.includes("winner")));
    // Diagnostics themselves render too (a diagnostics record works in
    // place of the entries array).
    assert.equal(renderTrace(diagnostics, { mode: "full" }).length,
        diagnostics.trace.length);
});

test("compactTraceLine summarizes a cancelled/stopped turn in one line", async () => {
    _resetMocks();
    const diagnostics = { layers: [
        { layer: "L0", code: "pinned", detail: "charge|k|t1|0" },
        { layer: "L1", code: "gm-intervention", detail: {} },
        { layer: "L2", code: "morale-posture", detail: { tier: "desperate", effectiveTier: "desperate" } },
        { layer: "L4", code: "winner", detail: {
            candidate: "attack-in-place|t1|stay|lasgun|0", score: 9.5,
            runnerUp: { candidate: "hold|stay", score: 9.1 }, margin: 0.4
        } }
    ] };
    const line = compactTraceLine(diagnostics);
    assert.ok(line, "compact line produced");
    assert.match(line, /gm-intervention/);
    assert.match(line, /desperate/);
    assert.match(line, /attack-in-place/);
    // No diagnostics → no line.
    assert.equal(compactTraceLine(null), null);
    assert.equal(compactTraceLine({ layers: [] }), null);
    // A plan object works in place of diagnostics.
    assert.ok(compactTraceLine({ diagnostics }).includes("desperate"));
});

test("formatCandidate shortens candidate ids for display", () => {
    assert.equal(formatCandidate("attack-in-place|t1|stay|lasgun|0"),
        "attack-in-place · lasgun");
    assert.equal(formatCandidate("hold|stay"), "hold");
    assert.equal(formatCandidate(null), "?");
});

/* ------------------------------------------------------------------ */
/* Preview "How it decided" view-model                                 */
/* ------------------------------------------------------------------ */

test("preview view-model carries the trace and renders traceLines", async () => {
    _resetMocks();
    const world = makeWorld();
    const result = await makePlan(world);
    const vm = buildPreviewViewModel(result.plan, {
        combat: world.combat,
        combatant: world.combatant,
        diagnosticsEnabled: true,
        traceMode: "full"
    });
    assert.ok(Array.isArray(vm.trace) && vm.trace.length > 0);
    assert.equal(vm.traceMode, "full");
    const localized = localizePreviewViewModel(vm, null);
    assert.ok(Array.isArray(localized.traceLines));
    assert.equal(localized.traceLines.length, vm.trace.length);
    assert.ok(localized.traceLines.every(line => /^L[0-4]:/.test(line)));
    // Compact mode groups the L0 veto lines into one.
    const compactVm = buildPreviewViewModel(result.plan, { traceMode: "compact" });
    const compactLocalized = localizePreviewViewModel(compactVm, null);
    assert.ok(compactLocalized.traceLines.length < localized.traceLines.length);
});

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

test("aiTraceVerbose registers compact/full and defaults to compact", async () => {
    _resetMocks();
    registerSettings();
    const entry = game.settings._registered.find(
        e => e.key === SETTING_KEYS.aiTraceVerbose);
    assert.ok(entry, "aiTraceVerbose registered");
    assert.equal(entry.data.scope, "world");
    assert.equal(entry.data.type, String);
    assert.deepEqual(Object.keys(entry.data.choices), ["compact", "full"]);
    assert.equal(entry.data.default, "compact");
    assert.equal(getTraceMode(), "compact");
    await game.settings.set(MODULE_ID, SETTING_KEYS.aiTraceVerbose, "full");
    assert.equal(getTraceMode(), "full");
    await game.settings.set(MODULE_ID, SETTING_KEYS.aiTraceVerbose, "garbage");
    assert.equal(getTraceMode(), "compact");
});

test("aiCaptureContext registers as a default-off boolean", async () => {
    _resetMocks();
    registerSettings();
    const entry = game.settings._registered.find(
        e => e.key === SETTING_KEYS.aiCaptureContext);
    assert.ok(entry, "aiCaptureContext registered");
    assert.equal(entry.data.type, Boolean);
    assert.equal(entry.data.default, false);
    assert.equal(isCaptureContextEnabled(), false);
    await game.settings.set(MODULE_ID, SETTING_KEYS.aiCaptureContext, true);
    assert.equal(isCaptureContextEnabled(), true);
    await game.settings.set(MODULE_ID, SETTING_KEYS.aiCaptureContext, "garbage");
    assert.equal(isCaptureContextEnabled(), false);
});

/* ------------------------------------------------------------------ */
/* Replay capture helpers                                              */
/* ------------------------------------------------------------------ */

test("sanitizeCaptureContext keeps plain-data keys and drops services/functions", () => {
    const context = {
        seed: 7,
        targets: [{ tokenId: "t1", x: 300, y: 0 }],
        actions: [{ id: "a1" }],
        layers: { morale: false },
        los: () => true,
        navigation: { planRoute: () => null },
        token: { documentName: "Token" },
        hooks: { callAll: () => {} },
        circular: null
    };
    context.circular = context;
    const clean = sanitizeCaptureContext(context);
    assert.equal(clean.seed, 7);
    assert.deepEqual(clean.targets, context.targets);
    assert.deepEqual(clean.actions, context.actions);
    assert.deepEqual(clean.layers, { morale: false });
    // Services, probes, documents and non-serializable data never
    // survive the filter.
    for (const dropped of ["los", "navigation", "token", "hooks", "circular"]) {
        assert.ok(!(dropped in clean), `${dropped} dropped`);
    }
    // The result is strictly JSON-serializable.
    assert.deepEqual(JSON.parse(JSON.stringify(clean)), clean);
});

test("appendCaptureEntry bounds the journal at CAPTURE_JOURNAL_MAX", () => {
    let journal = [];
    for (let i = 0; i < CAPTURE_JOURNAL_MAX + 4; i++) {
        journal = appendCaptureEntry(journal, {
            version: 1,
            at: { combatId: "c", round: i },
            context: { seed: i },
            snapshot: null,
            result: { planId: `p${i}` }
        });
    }
    assert.equal(journal.length, CAPTURE_JOURNAL_MAX);
    // Most recent last; the oldest entries dropped.
    assert.equal(journal.at(-1).result.planId, `p${CAPTURE_JOURNAL_MAX + 3}`);
    assert.equal(journal[0].result.planId, "p4");
    // Entries without a context never join the journal.
    const kept = appendCaptureEntry(journal, { version: 1, at: {} });
    assert.equal(kept.length, CAPTURE_JOURNAL_MAX);
    assert.equal(kept.at(-1).result.planId, `p${CAPTURE_JOURNAL_MAX + 3}`);
    // sanitizeCaptureJournal filters non-capture junk.
    assert.equal(sanitizeCaptureJournal("garbage").length, 0);
    assert.equal(sanitizeCaptureJournal([null, { context: {} }]).length, 1);
});

test("buildCaptureEntry produces a self-contained serializable replay fixture", async () => {
    _resetMocks();
    const world = makeWorld();
    const result = await makePlan(world);
    const context = planContext(world);
    context.los = () => true;
    context.navigation = { fake: true };
    const entry = buildCaptureEntry({
        combat: world.combat,
        combatant: world.combatant,
        context,
        plan: result.plan,
        config: { enabled: true, preset: "assault" },
        operationId: "op-cap"
    });
    assert.equal(entry.version, 1);
    assert.equal(entry.at.combatId, world.combat.id);
    assert.equal(entry.at.operationId, "op-cap");
    assert.equal(entry.preset, "assault");
    assert.equal(entry.config.enabled, true);
    // The context is sanitized: injected services/probes dropped.
    assert.equal(entry.context.seed, 7);
    assert.ok(!("los" in entry.context) && !("navigation" in entry.context));
    // Result fingerprint: winner, steps and the materialized trace.
    assert.equal(entry.result.winner,
        result.plan.diagnostics.layers.find(r => r.code === "winner")?.detail?.candidate);
    assert.deepEqual(entry.result.steps, result.plan.steps);
    assert.deepEqual(entry.result.trace, result.plan.diagnostics.trace);
    // Fully serializable.
    assert.deepEqual(JSON.parse(JSON.stringify(entry)), entry);
});

/* ------------------------------------------------------------------ */
/* Executor integration: run.trace, capture flag, GM whisper           */
/* ------------------------------------------------------------------ */

/** Install a minimal `game.darkHeresy.api.rolls` mock for attack steps. */
function _mockRolls() {
    game.darkHeresy.api.rolls = {
        prepareAttack: async input => ({ fingerprint: "fp", rollData: {}, input }),
        executeAttack: async (_prepared, options) => ({
            status: "ok",
            operationId: options?.operationId,
            chatMessageIds: ["chat-msg"],
            resourceDelta: { ammo: -1 }
        })
    };
    return () => { delete game.darkHeresy.api.rolls; };
}

test("executor captures the planContext when context.capture is set", async () => {
    _resetMocks();
    const clearRolls = _mockRolls();
    const world = makeWorld();
    const api = createModuleApi();
    const planner = createPlannerService({ api });
    api.services.register("planner", planner);
    api.services.register("authority", { isController: () => true });
    const executor = createExecutorService({
        api,
        getMode: () => "automatic",
        pacing: () => 0
    });
    // No `pinned` here — snapshot validation would read the live
    // (status-free) fixture and flag the turn stale instead.
    const executableContext = planContext(world);
    delete executableContext.selfStatuses;
    const result = await executor.runPlan({
        combat: world.combat,
        combatant: world.combatant,
        operation: { id: `op-trace-${++_opId}`, combatantId: world.combatant.id },
        planContext: executableContext,
        capture: true
    });
    assert.equal(result.status, EXECUTOR_STATUS.completed);
    // The capture write is fire-and-forget — flush the microtask queue.
    await new Promise(resolve => globalThis.setTimeout(resolve, 20));
    const journal = world.combatant.getFlag(MODULE_ID, FLAG_KEYS.captureJournal);
    assert.ok(Array.isArray(journal) && journal.length === 1,
        "one capture entry journaled");
    const entry = journal[0];
    assert.equal(entry.version, 1);
    assert.equal(entry.result.planId, result.planId);
    assert.ok(entry.context.seed === 7);
    assert.ok(entry.snapshot?.self?.tokenId === world.token.id);
    assert.ok(Array.isArray(entry.result.trace) && entry.result.trace.length);
    // The capture is a ready fixture: JSON round-trip is lossless.
    assert.deepEqual(JSON.parse(JSON.stringify(entry)), entry);
    // Without the capture flag/setting nothing is journaled.
    const second = makeWorld();
    const secondContext = planContext(second);
    delete secondContext.selfStatuses;
    await executor.runPlan({
        combat: second.combat,
        combatant: second.combatant,
        operation: { id: `op-trace-${++_opId}`, combatantId: second.combatant.id },
        planContext: secondContext
    });
    await new Promise(resolve => globalThis.setTimeout(resolve, 20));
    assert.equal(second.combatant.getFlag(MODULE_ID, FLAG_KEYS.captureJournal),
        undefined);
    clearRolls();
});

test("executor whispers the compact trace line on a stopped turn", async () => {
    _resetMocks();
    registerSettings();
    await game.settings.set(MODULE_ID, SETTING_KEYS.diagnosticsEnabled, true);
    const world = makeWorld();
    const api = createModuleApi();
    api.services.register("authority", { isController: () => true });
    const sent = [];
    const originalChatMessage = globalThis.ChatMessage;
    globalThis.ChatMessage = {
        create: async payload => {
            sent.push(payload);
            return payload;
        }
    };
    try {
        const executor = createExecutorService({
            api,
            getMode: () => "automatic",
            pacing: () => 0
        });
        const diagnostics = { layers: [
            { layer: "L1", code: "gm-intervention", detail: {} },
            { layer: "L2", code: "morale-posture",
                detail: { tier: "desperate", effectiveTier: "desperate" } }
        ] };
        const result = await executor.runPlan({
            combat: world.combat,
            combatant: world.combatant,
            operation: { id: `op-trace-${++_opId}`, combatantId: world.combatant.id },
            planner: {
                planTurn: async () => ({
                    status: "no-target", reason: "no-target",
                    plan: null, diagnostics
                })
            }
        });
        assert.equal(result.status, EXECUTOR_STATUS.failed);
        assert.equal(sent.length, 1, "one GM diagnostics whisper");
        assert.match(sent[0].content, /gm-intervention/);
        assert.match(sent[0].content, /desperate/);
        assert.ok(Array.isArray(sent[0].whisper));
    } finally {
        globalThis.ChatMessage = originalChatMessage;
    }
});
