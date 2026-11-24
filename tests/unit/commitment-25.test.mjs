/**
 * Unit tests for the L1 commitment layer (issue #25): the persisted
 * `committedPlan` flag record, `expectedState` validation and every
 * invalidator (ttl, gm-intervention, target, morale tier, threat drift,
 * cheap L0), the bounded own-move journal diff, `manualOverrideGrace`,
 * `gm-controlled` team degradation and reactive mode.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createModuleApi } from "../../scripts/api.js";
import {
    COMMITMENT_JOURNAL_MAX,
    FLAG_KEYS,
    MODULE_ID,
    SETTING_KEYS
} from "../../scripts/constants.js";
import { createExecutorService, EXECUTOR_STATUS } from "../../scripts/executor.js";
import { createFireteamService, FIRETEAM_STATUS } from "../../scripts/fireteam.js";
import {
    COMMITMENT_REASONS,
    appendJournalEntry,
    applyCommitmentLayer,
    countGmInterventions,
    isGmControlled,
    moraleTierOf,
    readCommittedPlan,
    readGmControlled,
    readMoveJournal,
    sanitizeCommittedPlan,
    sanitizeMoveJournal,
    validateCommitment
} from "../../scripts/layers.js";
import { createPlannerService, PLANNER_STATUS } from "../../scripts/planner.js";
import {
    makeActor,
    makeCombatant,
    makeScene,
    makeToken
} from "./fixtures.mjs";

let _combatId = 0;

/** Minimal combat fixture (mirrors layers-24/executor tests). */
function makeCombat({ round = 1, turn = 0, combatants = [] } = {}) {
    const collection = new Map(combatants.map(c => [c.id, c]));
    collection.contents = combatants;
    const combat = {
        documentName: "Combat",
        id: `commit-combat-${++_combatId}`,
        round,
        turn,
        combatants: collection,
        turns: combatants,
        scene: null,
        ended: false,
        get combatant() {
            return this.turns[this.turn] ?? null;
        }
    };
    return combat;
}

/** Small AI world: assault NPC at (0,0) plus a hostile at (300,0). */
function makeWorld() {
    const scene = makeScene({ grid: "square" });
    const actor = makeActor({ enabled: true, preset: "assault" });
    actor.system = { wounds: { value: 12, max: 14 } };
    actor.items = [{
        id: "w1",
        uuid: `Actor.${actor.id}.Item.w1`,
        name: "Lasgun",
        type: "weapon",
        system: { class: "ranged", range: 100, damage: "1d10+3" }
    }];
    const token = makeToken({ actor });
    token.x = 0;
    token.y = 0;
    token.elevation = 0;
    token.disposition = -1;
    token.move = async waypoints => {
        const last = waypoints.at(-1);
        token.x = last.x;
        token.y = last.y;
        return true;
    };
    const combatant = makeCombatant({ actor, token });
    combatant.tokenId = token.id;

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
    combat.nextTurn = async () => { combat.turn += 1; return combat; };
    return { scene, actor, token, combatant, enemy, enemyToken, combat };
}

/** planTurn context for {@link makeWorld}. */
function planContext(world, extra = {}) {
    return {
        seed: 7,
        targets: [{
            tokenId: world.enemyToken.id,
            tokenUuid: `Scene.${world.scene.id}.Token.${world.enemyToken.id}`,
            x: world.enemyToken.x,
            y: world.enemyToken.y,
            elevation: 0,
            distance: 4.5,
            canAttack: true,
            source: "injected"
        }],
        actions: [{
            id: "lasgun", type: "attack", name: "Lasgun",
            itemUuid: `Actor.${world.actor.id}.Item.w1`, itemId: "w1",
            class: "ranged", range: 100, cost: "half"
        }],
        ...extra
    };
}

/**
 * Build a valid committed-plan record for {@link makeWorld}: the bot
 * holds position and attacks the enemy — every expectedState check
 * passes against the fixture world.
 * @param {object} world
 * @param {object} [overrides] Shallow-merged record overrides plus
 *   `expectedState` merge.
 * @returns {object}
 */
function committedRecord(world, overrides = {}) {
    const { expectedState = {}, ...rest } = overrides;
    return {
        id: "c-test",
        status: "active",
        combatId: world.combat.id,
        combatantId: world.combatant.id,
        createdRound: world.combat.round,
        createdTurn: world.combat.turn,
        ttl: 2,
        source: "test",
        steps: [
            {
                id: "step-attack-1", type: "attack", cost: { halves: 1 },
                input: {
                    actionId: "lasgun", name: "Lasgun",
                    itemUuid: `Actor.${world.actor.id}.Item.w1`,
                    targetTokenUuid: `Scene.${world.scene.id}.Token.${world.enemyToken.id}`,
                    targetTokenId: world.enemyToken.id, range: 100
                },
                preconditions: ["turn"], projectedResourceDelta: {}
            },
            {
                id: "step-end-turn-2", type: "end-turn", cost: {},
                input: { reason: "committed" },
                preconditions: ["turn"], projectedResourceDelta: {}
            }
        ],
        expectedState: {
            self: { x: world.token.x, y: world.token.y, elevation: 0 },
            target: {
                tokenId: world.enemyToken.id,
                tokenUuid: `Scene.${world.scene.id}.Token.${world.enemyToken.id}`,
                x: world.enemyToken.x,
                y: world.enemyToken.y
            },
            morale: null,
            threats: [{ tokenId: world.enemyToken.id, x: world.enemyToken.x, y: world.enemyToken.y }],
            ...expectedState
        },
        ...rest
    };
}

/** Seed the `committedPlan` flag on a fixture combatant. */
function seedCommitment(combatant, record) {
    combatant.flags[MODULE_ID] = combatant.flags[MODULE_ID] ?? {};
    combatant.flags[MODULE_ID][FLAG_KEYS.committedPlan] = record;
    return record;
}

/* ------------------------------------------------------------------ */
/* Flag sanitizers and journals                                        */
/* ------------------------------------------------------------------ */

test("sanitizeCommittedPlan normalizes the record and drops damage", () => {
    assert.equal(sanitizeCommittedPlan(null), null);
    assert.equal(sanitizeCommittedPlan("junk"), null);
    const clean = sanitizeCommittedPlan({
        id: "c1",
        status: "bogus",
        combatId: "combat-1",
        createdRound: 3,
        ttl: 2,
        steps: [{ type: "move" }, "trash", { noType: true }],
        expectedState: {
            self: { x: 10, y: 20, elevation: 5 },
            target: { tokenId: "t1", x: 1, y: 2 },
            morale: "desperate",
            threats: [
                { tokenId: "t1", x: 1, y: 2 },
                { tokenId: "bad" },
                { tokenUuid: "u.t.2", x: 5, y: 6 }
            ]
        }
    });
    assert.equal(clean.status, "active");
    assert.equal(clean.steps.length, 1);
    assert.deepEqual(clean.expectedState.self, { x: 10, y: 20, elevation: 5 });
    assert.equal(clean.expectedState.morale, "desperate");
    assert.equal(clean.expectedState.threats.length, 2);
    const cancelled = sanitizeCommittedPlan({ status: "cancelled", cancelledReason: "ttl-expired" });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.cancelledReason, "ttl-expired");
});

test("the move journal is bounded at 32 entries, newest kept", () => {
    let journal = [];
    for (let i = 0; i < COMMITMENT_JOURNAL_MAX + 5; i++) {
        journal = appendJournalEntry(journal, { round: 1, turn: i, x: i * 100, y: 0 });
    }
    assert.equal(journal.length, COMMITMENT_JOURNAL_MAX);
    assert.equal(journal.at(-1).turn, COMMITMENT_JOURNAL_MAX + 4);
    assert.equal(journal[0].turn, 5);
    // Damaged entries are dropped by the sanitizer.
    assert.equal(sanitizeMoveJournal([{ x: 1 }, { x: 1, y: 2, round: 3 }]).length, 1);
    assert.equal(sanitizeMoveJournal("junk").length, 0);
});

test("gmControlled flag: read and one-round activity window", () => {
    const combatant = makeCombatant();
    assert.equal(readGmControlled(combatant), null);
    assert.equal(isGmControlled(combatant, 1), false);
    combatant.flags[MODULE_ID] = combatant.flags[MODULE_ID] ?? {};
    combatant.flags[MODULE_ID][FLAG_KEYS.gmControlled] = {
        round: 2, turn: 4, reason: "gm-intervention"
    };
    assert.deepEqual(readGmControlled(combatant), {
        round: 2, turn: 4, reason: "gm-intervention"
    });
    assert.equal(isGmControlled(combatant, 2), true);
    assert.equal(isGmControlled(combatant, 3), false, "the mark lives one round");
});

test("countGmInterventions counts same-round marks, optionally per team", () => {
    const member = teamId => {
        const c = makeCombatant();
        c.flags[MODULE_ID] = c.flags[MODULE_ID] ?? {};
        c.flags[MODULE_ID][FLAG_KEYS.fireteam] = { teamId };
        c.flags[MODULE_ID][FLAG_KEYS.gmControlled] = { round: 1, turn: 0 };
        return c;
    };
    const a = member("alpha");
    const b = member("alpha");
    const other = member("beta");
    const stale = makeCombatant();
    stale.flags[MODULE_ID] = stale.flags[MODULE_ID] ?? {};
    stale.flags[MODULE_ID][FLAG_KEYS.gmControlled] = { round: 3, turn: 0 };
    const combat = makeCombat({ round: 1, combatants: [a, b, other, stale] });
    assert.equal(countGmInterventions(combat, { round: 1 }), 3);
    assert.equal(countGmInterventions(combat, { round: 1, teamId: "alpha" }), 2);
    assert.equal(countGmInterventions(combat, { round: 1, teamId: "beta" }), 1);
    assert.equal(countGmInterventions(combat, { round: 2 }), 0);
});

/* ------------------------------------------------------------------ */
/* validateCommitment — the invalidators                               */
/* ------------------------------------------------------------------ */

test("validateCommitment: a matching expectedState is a hit", () => {
    const world = makeWorld();
    const record = committedRecord(world);
    const verdict = validateCommitment(record, {
        combatId: world.combat.id,
        round: 1,
        self: { x: 0, y: 0, elevation: 0 },
        moraleTier: null,
        resolveToken: id => id === world.enemyToken.id ? world.enemyToken : null,
        isTokenAlive: () => true
    });
    assert.equal(verdict.valid, true);
    assert.deepEqual(verdict.accepted, {});
});

test("validateCommitment: ttl expiry and the reactive squeeze", () => {
    const world = makeWorld();
    const record = committedRecord(world, { createdRound: 1, ttl: 2 });
    let verdict = validateCommitment(record, {
        combatId: world.combat.id, round: 3,
        self: { x: 0, y: 0, elevation: 0 }
    });
    assert.equal(verdict.reason, COMMITMENT_REASONS.ttlExpired);
    assert.equal(verdict.detail.ttl, 2);
    // Same record, one round later than written, reactive mode → ttl 1.
    verdict = validateCommitment(record, {
        combatId: world.combat.id, round: 2, reactive: true,
        self: { x: 0, y: 0, elevation: 0 }
    });
    assert.equal(verdict.reason, COMMITMENT_REASONS.ttlExpired);
    assert.equal(verdict.detail.reactive, true);
    // Without reactive the same round is still inside the ttl.
    verdict = validateCommitment(record, {
        combatId: world.combat.id, round: 2,
        self: { x: 0, y: 0, elevation: 0 },
        resolveToken: () => world.enemyToken,
        isTokenAlive: () => true
    });
    assert.equal(verdict.valid, true);
});

test("validateCommitment: combat mismatch and damaged records", () => {
    const world = makeWorld();
    const record = committedRecord(world);
    assert.equal(validateCommitment(record, {
        combatId: "other-combat", round: 1
    }).reason, COMMITMENT_REASONS.combatEnded);
    assert.equal(validateCommitment(record, {
        combatId: world.combat.id, combatEnded: true, round: 1
    }).reason, COMMITMENT_REASONS.combatEnded);
    assert.equal(validateCommitment(null, {}).reason, COMMITMENT_REASONS.invalidCommitment);
    assert.equal(validateCommitment({ status: "cancelled", cancelledReason: "target-gone" }, {})
        .detail.cancelledReason, "target-gone");
    assert.equal(validateCommitment({ status: "active", steps: [] }, {})
        .reason, COMMITMENT_REASONS.invalidCommitment);
});

test("validateCommitment: unexplained self drift is gm-intervention", () => {
    const world = makeWorld();
    const record = committedRecord(world);
    const verdict = validateCommitment(record, {
        combatId: world.combat.id, round: 1,
        self: { x: 500, y: 0, elevation: 0 },
        journal: []
    });
    assert.equal(verdict.reason, COMMITMENT_REASONS.gmIntervention);
    assert.deepEqual(verdict.detail.to, { x: 500, y: 0 });
});

test("validateCommitment: the journal diff accepts own moves", () => {
    const world = makeWorld();
    const record = committedRecord(world, { createdRound: 1 });
    // Own move recorded by the executor inside the plan's lifetime.
    const resolvers = {
        resolveToken: () => world.enemyToken,
        isTokenAlive: () => true
    };
    const verdict = validateCommitment(record, {
        combatId: world.combat.id, round: 2,
        self: { x: 150, y: -50, elevation: 0 },
        journal: [{ round: 1, turn: 3, x: 150, y: -50, elevation: 0 }],
        ...resolvers
    });
    assert.equal(verdict.valid, true);
    assert.equal(verdict.accepted.selfMoved, true);
    // A journal entry from before the plan existed does not explain it.
    const stale = validateCommitment(record, {
        combatId: world.combat.id, round: 2,
        self: { x: 150, y: -50, elevation: 0 },
        journal: [{ round: 0, turn: 3, x: 150, y: -50 }],
        ...resolvers
    });
    assert.equal(stale.reason, COMMITMENT_REASONS.gmIntervention);
});

test("validateCommitment: manualOverrideGrace accepts GM drift", () => {
    const world = makeWorld();
    const record = committedRecord(world);
    const verdict = validateCommitment(record, {
        combatId: world.combat.id, round: 1,
        self: { x: 500, y: 0, elevation: 0 },
        grace: true,
        resolveToken: () => world.enemyToken,
        isTokenAlive: () => true
    });
    assert.equal(verdict.valid, true);
    assert.equal(verdict.accepted.gmMoved, true);
});

test("validateCommitment: target and threat invalidators", () => {
    const world = makeWorld();
    const record = committedRecord(world);
    // Target died.
    let verdict = validateCommitment(record, {
        combatId: world.combat.id, round: 1,
        self: { x: 0, y: 0, elevation: 0 },
        resolveToken: () => null
    });
    assert.equal(verdict.reason, COMMITMENT_REASONS.targetGone);
    // Morale tier flipped.
    verdict = validateCommitment(record, {
        combatId: world.combat.id, round: 1,
        self: { x: 0, y: 0, elevation: 0 },
        moraleTier: "desperate",
        resolveToken: id => world.enemyToken,
        isTokenAlive: () => true
    });
    assert.equal(verdict.reason, COMMITMENT_REASONS.moraleChanged);
    // Threat map drifted beyond tolerance (2 threats recorded, both
    // gone; no committed target so the check is isolated).
    const driftRecord = committedRecord(world, {
        expectedState: {
            target: null,
            threats: [
                { tokenId: "t1", x: 0, y: 0 },
                { tokenId: "t2", x: 100, y: 0 }
            ]
        }
    });
    verdict = validateCommitment(driftRecord, {
        combatId: world.combat.id, round: 1,
        self: { x: 0, y: 0, elevation: 0 },
        threatTolerance: 1,
        moveTolerancePx: 100,
        resolveToken: () => null,
        isTokenAlive: () => false
    });
    assert.equal(verdict.reason, COMMITMENT_REASONS.threatDrift);
    assert.equal(verdict.detail.drifted, 2);
    // Within tolerance one drift is still a hit.
    verdict = validateCommitment(driftRecord, {
        combatId: world.combat.id, round: 1,
        self: { x: 0, y: 0, elevation: 0 },
        threatTolerance: 2,
        resolveToken: () => null,
        isTokenAlive: () => false
    });
    assert.equal(verdict.valid, true);
});

test("validateCommitment: the cheap L0 pass vetoes a committed charge", () => {
    const world = makeWorld();
    const chargeStep = {
        id: "step-attack-1", type: "attack",
        input: { mode: "charge", actionId: "w2" }
    };
    const record = committedRecord(world, { steps: [chargeStep] });
    const live = {
        combatId: world.combat.id, round: 1,
        self: { x: 0, y: 0, elevation: 0 },
        resolveToken: () => world.enemyToken,
        isTokenAlive: () => true
    };
    assert.equal(validateCommitment(record, live).valid, true);
    for (const status of ["pinned", "prone"]) {
        const verdict = validateCommitment(record, {
            ...live, selfStatuses: [status]
        });
        assert.equal(verdict.reason, COMMITMENT_REASONS.l0Veto);
        assert.equal(verdict.detail.status, status);
    }
});

test("validateCommitment: an already-finished move plan is exhausted", () => {
    const world = makeWorld();
    const moveStep = {
        id: "step-move-1", type: "move", cost: { movement: 8, halves: 2 },
        input: { to: { x: 200, y: 0 } }
    };
    const record = committedRecord(world, {
        steps: [moveStep, {
            id: "step-end-turn-2", type: "end-turn", cost: {}, input: {}
        }],
        expectedState: {
            self: { x: 200, y: 0, elevation: 0 },
            target: null,
            threats: []
        }
    });
    const live = {
        combatId: world.combat.id, round: 1,
        self: { x: 200, y: 0, elevation: 0 },
        resolveToken: () => world.enemyToken,
        isTokenAlive: () => true
    };
    // Smoke finding: the bot stands on the committed endpoint — the
    // replay would skip the only substantive step and burn the turn.
    assert.equal(validateCommitment(record, live).reason,
        COMMITMENT_REASONS.planExhausted);
    // An endpoint still ahead keeps the commitment alive.
    const open = committedRecord(world, {
        steps: [{ ...moveStep, input: { to: { x: 800, y: 0 } } },
            { id: "step-end-turn-2", type: "end-turn", cost: {}, input: {} }],
        expectedState: { target: null, threats: [] }
    });
    assert.equal(validateCommitment(open, {
        ...live, self: { x: 0, y: 0, elevation: 0 }
    }).valid, true);
});

/* ------------------------------------------------------------------ */
/* applyCommitmentLayer — flag records and the funnel decision         */
/* ------------------------------------------------------------------ */

test("applyCommitmentLayer: a flag record validates to a hit", () => {
    const world = makeWorld();
    seedCommitment(world.combatant, committedRecord(world));
    const diagnostics = {};
    const result = applyCommitmentLayer({
        combat: world.combat,
        combatant: world.combatant,
        context: planContext(world),
        flags: { commitment: true },
        diagnostics
    });
    assert.equal(result.enabled, true);
    assert.ok(result.decision);
    assert.equal(result.decision.steps.length, 2);
    assert.equal(result.invalidated, null);
    const last = diagnostics.layers.at(-1);
    assert.equal(last.code, "commitment-hit");
});

test("applyCommitmentLayer: gm-intervention reports the direct code", () => {
    const world = makeWorld();
    const record = committedRecord(world, {
        expectedState: { self: { x: 500, y: 500, elevation: 0 } }
    });
    seedCommitment(world.combatant, record);
    const diagnostics = {};
    const result = applyCommitmentLayer({
        combat: world.combat,
        combatant: world.combatant,
        context: planContext(world),
        flags: { commitment: true },
        diagnostics
    });
    assert.equal(result.decision, null);
    assert.equal(result.invalidated, "gm-intervention");
    const last = diagnostics.layers.at(-1);
    assert.deepEqual({ layer: last.layer, code: last.code }, {
        layer: "L1", code: "gm-intervention"
    });
});

test("applyCommitmentLayer: reactive mode reports interventions", () => {
    const world = makeWorld();
    // Two flagged teammates push the world into reactive mode.
    for (const name of ["m1", "m2"]) {
        const mate = makeCombatant();
        mate.flags[MODULE_ID] = mate.flags[MODULE_ID] ?? {};
        mate.flags[MODULE_ID][FLAG_KEYS.fireteam] = { teamId: "alpha" };
        mate.flags[MODULE_ID][FLAG_KEYS.gmControlled] = {
            round: world.combat.round, turn: 0
        };
        world.combat.combatants.set(mate.id, mate);
        // `contents` and `turns` share the array — one push suffices.
        world.combat.combatants.contents.push(mate);
    }
    world.combatant.flags[MODULE_ID] = world.combatant.flags[MODULE_ID] ?? {};
    world.combatant.flags[MODULE_ID][FLAG_KEYS.fireteam] = { teamId: "alpha" };
    const diagnostics = {};
    const result = applyCommitmentLayer({
        combat: world.combat,
        combatant: world.combatant,
        context: { team: { teamId: "alpha" }, commitment: undefined },
        flags: { commitment: true },
        diagnostics
    });
    assert.equal(result.reactive, true);
    assert.equal(result.interventions, 2);
});

test("applyCommitmentLayer: an injected full record runs validation", () => {
    const world = makeWorld();
    const diagnostics = {};
    // Injected persisted-shape record with a dead expected target →
    // validated, not trusted.
    const record = committedRecord(world, {
        expectedState: { target: { tokenId: "ghost", x: 0, y: 0 } }
    });
    const result = applyCommitmentLayer({
        combat: world.combat,
        combatant: world.combatant,
        context: { commitment: record },
        flags: { commitment: true },
        diagnostics
    });
    assert.equal(result.decision, null);
    assert.equal(result.invalidated, "target-gone");
    assert.equal(diagnostics.layers.at(-1).code, "target-gone");
});

/* ------------------------------------------------------------------ */
/* planTurn integration                                                */
/* ------------------------------------------------------------------ */

test("planTurn: a flag committedPlan short-circuits before scoring", async () => {
    const world = makeWorld();
    seedCommitment(world.combatant, committedRecord(world));
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant,
        planContext(world));
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.equal(result.plan.breakdown.reason, "commitment");
    assert.equal(result.plan.steps.length, 2);
    const diagnostics = result.plan.diagnostics;
    assert.equal(diagnostics.candidatesCount, 0);
    assert.equal(diagnostics.commitment.recordId, "c-test");
    assert.equal(diagnostics.layers.at(-1).code, "commitment-hit");
    // A hit plan carries no new commitment payload — the record is
    // refreshed, not rewritten.
    assert.equal(result.plan.commitment, null);
});

test("planTurn: a scored plan carries the commitment payload", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant,
        planContext(world));
    assert.equal(result.status, PLANNER_STATUS.ok);
    const payload = result.plan.commitment;
    assert.ok(payload, "scored plan exposes the persistence payload");
    assert.equal(payload.source, "planner");
    assert.equal(payload.ttl, 2);
    assert.equal(payload.steps.length, result.plan.steps.length);
    // Self = current position (no move in this plan), target = enemy.
    assert.deepEqual(payload.expectedState.self, { x: 0, y: 0, elevation: 0 });
    assert.equal(payload.expectedState.target.tokenId, world.enemyToken.id);
    assert.equal(payload.expectedState.morale, null);
    assert.ok(payload.expectedState.threats.some(
        th => th.tokenId === world.enemyToken.id));
    // Serializable.
    assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
});

test("planTurn: a bare hold never writes a commitment payload", async () => {
    // Smoke finding: a sealed grenadier's `[end-turn]` hold committed and
    // replayed every turn — its empty threat list skipped drift checks,
    // so new contacts never invalidated it. Hold plans stay uncommitted.
    const world = makeWorld();
    world.combatant.actor.flags[MODULE_ID][FLAG_KEYS.actorConfig] =
        { enabled: true, preset: "hold" };
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 7, targets: [], actions: []
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.ok(result.plan.steps.every(step => step.type === "end-turn"),
        "fixture: the plan is a bare hold");
    assert.equal(result.plan.commitment, null,
        "a hold plan does not persist a multi-turn commitment");
});

test("planTurn: a commitment hit restores the committed target", async () => {
    // Smoke finding: the preview of a replayed commitment showed an
    // attack step aimed at "(no target)" — the plan's snapshot target
    // was left null because scoring never ran.
    const world = makeWorld();
    seedCommitment(world.combatant, committedRecord(world));
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant,
        planContext(world));
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.equal(result.plan.breakdown.reason, "commitment");
    assert.equal(result.plan.target?.tokenId, world.enemyToken.id,
        "the committed attack's target is restored on the plan");
    assert.equal(result.plan.snapshot?.target?.tokenId, world.enemyToken.id,
        "the preview snapshot names the same target");
});

test("planTurn: gm-intervention misses to normal scoring", async () => {
    const world = makeWorld();
    seedCommitment(world.combatant, committedRecord(world, {
        expectedState: { self: { x: 999, y: 0, elevation: 0 } }
    }));
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant,
        planContext(world));
    assert.equal(result.status, PLANNER_STATUS.ok);
    const codes = result.plan.diagnostics.layers.map(r => r.code);
    assert.ok(codes.includes("gm-intervention"));
    assert.ok(codes.includes("scored"), "L4 scoring ran after the miss");
    assert.equal(result.plan.diagnostics.commitment.invalidated, "gm-intervention");
});

test("planTurn: manualOverrideGrace keeps the commitment on GM drift", async () => {
    const world = makeWorld();
    seedCommitment(world.combatant, committedRecord(world, {
        expectedState: { self: { x: 999, y: 0, elevation: 0 } }
    }));
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant,
        planContext(world, { manualOverrideGrace: true }));
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.equal(result.plan.breakdown.reason, "commitment");
    const hit = result.plan.diagnostics.layers.at(-1);
    assert.equal(hit.code, "commitment-hit");
    assert.equal(hit.detail.gmAccepted, true);
});

/* ------------------------------------------------------------------ */
/* Executor persistence: journal, record write, gm-controlled mark     */
/* ------------------------------------------------------------------ */

test("executor: a completed turn persists commitment + move journal", async () => {
    const world = makeWorld();
    const api = createModuleApi();
    const planner = createPlannerService({ api });
    api.services.register("planner", planner);
    const operations = { completeTurn: async () => ({ ok: true }) };
    api.services.register("authority", {
        isController: () => true,
        operations
    });
    const executor = createExecutorService({ api, getMode: () => "automatic" });
    game.darkHeresy.api.rolls = {
        prepareAttack: async input => ({ fingerprint: "fp", input }),
        executeAttack: async () => ({ status: "ok", resourceDelta: { ammo: -1 } })
    };
    try {
        const planned = await planner.planTurn(world.combat, world.combatant,
            planContext(world));
        assert.equal(planned.status, "ok");
        assert.ok(planned.plan.commitment, "fixture: the payload rides the plan");
        const result = await executor.executePlan(planned.plan, {
            combat: world.combat,
            combatant: world.combatant,
            operationId: "op-commit-1"
        });
        assert.equal(result.status, EXECUTOR_STATUS.completed);
        const stored = readCommittedPlan(world.combatant);
        assert.ok(stored, "committedPlan flag persisted");
        assert.equal(stored.status, "active");
        assert.equal(stored.combatId, world.combat.id);
        assert.equal(stored.createdRound, 1);
        assert.equal(stored.ttl, 2);
        assert.equal(stored.steps.length, planned.plan.steps.length);
        // This plan had no move — the journal only records own motion.
        assert.equal(readMoveJournal(world.combatant).length, 0);
    } finally {
        delete game.darkHeresy.api.rolls;
    }
});

test("executor: a move step writes the own-move journal entry", async () => {
    const world = makeWorld();
    const api = createModuleApi();
    const planner = createPlannerService({ api });
    api.services.register("planner", planner);
    api.services.register("authority", {
        isController: () => true,
        operations: { completeTurn: async () => ({ ok: true }) }
    });
    const executor = createExecutorService({ api, getMode: () => "automatic" });
    const planned = await planner.planTurn(world.combat, world.combatant,
        planContext(world));
    const plan = {
        ...planned.plan,
        steps: [
            {
                id: "step-move-1", type: "move",
                input: { to: { x: 250, y: 50 } },
                projectedResourceDelta: { movement: -2 }
            },
            { id: "step-end-turn-2", type: "end-turn", input: {}, projectedResourceDelta: {} }
        ]
    };
    const result = await executor.executePlan(plan, {
        combat: world.combat,
        combatant: world.combatant,
        operationId: "op-commit-move"
    });
    assert.equal(result.status, EXECUTOR_STATUS.completed);
    const journal = readMoveJournal(world.combatant);
    assert.equal(journal.length, 1);
    // Document space: centre (250,50) → top-left (200,0) on grid 100.
    assert.deepEqual({ x: journal[0].x, y: journal[0].y }, { x: 200, y: 0 });
    assert.equal(journal[0].operationId, "op-commit-move");
});

test("executor: end-to-end — committed turn replays as an L1 hit next round", async () => {
    const world = makeWorld();
    const api = createModuleApi();
    const planner = createPlannerService({ api });
    api.services.register("planner", planner);
    api.services.register("authority", {
        isController: () => true,
        operations: { completeTurn: async () => ({ ok: true }) }
    });
    const executor = createExecutorService({ api, getMode: () => "automatic" });
    game.darkHeresy.api.rolls = {
        prepareAttack: async input => ({ fingerprint: "fp", input }),
        executeAttack: async () => ({ status: "ok", resourceDelta: { ammo: -1 } })
    };
    try {
        const planned = await planner.planTurn(world.combat, world.combatant,
            planContext(world));
        const result = await executor.executePlan(planned.plan, {
            combat: world.combat,
            combatant: world.combatant,
            operationId: "op-e2e-1"
        });
        assert.equal(result.status, EXECUTOR_STATUS.completed);
        assert.ok(readCommittedPlan(world.combatant));

        // Round 2, same world: the stored commitment validates and the
        // scoring pipeline never runs.
        world.combat.round = 2;
        const next = await planner.planTurn(world.combat, world.combatant,
            planContext(world));
        assert.equal(next.status, "ok");
        assert.equal(next.plan.breakdown.reason, "commitment");
        assert.equal(next.plan.diagnostics.candidatesCount, 0);
        assert.equal(next.plan.diagnostics.layers.at(-1).code, "commitment-hit");
    } finally {
        delete game.darkHeresy.api.rolls;
    }
});

test("executor: gm-intervention marks the bot and cancels the record", async () => {
    const world = makeWorld();
    // The GM dragged the token since the plan was committed — the stored
    // self position no longer matches.
    seedCommitment(world.combatant, committedRecord(world, {
        expectedState: { self: { x: 999, y: 999, elevation: 0 } }
    }));
    const api = createModuleApi();
    const planner = createPlannerService({ api });
    api.services.register("planner", planner);
    api.services.register("authority", {
        isController: () => true,
        operations: { completeTurn: async () => ({ ok: true }) }
    });
    const executor = createExecutorService({ api, getMode: () => "automatic" });
    game.darkHeresy.api.rolls = {
        prepareAttack: async input => ({ fingerprint: "fp", input }),
        executeAttack: async () => ({ status: "ok" })
    };
    try {
        const result = await executor.runPlan({
            combat: world.combat,
            combatant: world.combatant,
            operation: { id: "op-gm-1", combatantId: world.combatant.id, phase: "executing" },
            planContext: planContext(world)
        });
        assert.equal(result.status, EXECUTOR_STATUS.completed);
        // The bot is marked gm-controlled for the round…
        const mark = readGmControlled(world.combatant);
        assert.ok(mark, "gmControlled flag written");
        assert.equal(mark.round, 1);
        assert.equal(mark.reason, "gm-intervention");
        // …and the dead record is stamped cancelled with the reason.
        const stored = world.combatant.flags[MODULE_ID][FLAG_KEYS.committedPlan];
        assert.equal(stored.status, "cancelled");
        assert.equal(stored.cancelledReason, "gm-intervention");
    } finally {
        delete game.darkHeresy.api.rolls;
    }
});

test("executor: manualOverrideGrace accepts the drift — no mark, plan stays", async () => {
    const world = makeWorld();
    seedCommitment(world.combatant, committedRecord(world, {
        expectedState: { self: { x: 999, y: 999, elevation: 0 } }
    }));
    const api = createModuleApi();
    const planner = createPlannerService({ api });
    api.services.register("planner", planner);
    api.services.register("authority", {
        isController: () => true,
        operations: { completeTurn: async () => ({ ok: true }) }
    });
    const executor = createExecutorService({ api, getMode: () => "automatic" });
    game.darkHeresy.api.rolls = {
        prepareAttack: async input => ({ fingerprint: "fp", input }),
        executeAttack: async () => ({ status: "ok" })
    };
    try {
        const result = await executor.runPlan({
            combat: world.combat,
            combatant: world.combatant,
            operation: { id: "op-grace-1", combatantId: world.combatant.id, phase: "executing" },
            planContext: planContext(world, { manualOverrideGrace: true })
        });
        // The committed steps executed — no gm-controlled mark, and the
        // record was refreshed (still active, the live position blessed
        // as the new expectation).
        assert.equal(result.status, EXECUTOR_STATUS.completed);
        assert.equal(readGmControlled(world.combatant), null);
        const stored = readCommittedPlan(world.combatant);
        assert.equal(stored.status, "active");
        assert.deepEqual(
            { x: stored.expectedState.self.x, y: stored.expectedState.self.y },
            { x: 0, y: 0 },
            "the GM position was blessed as the new expectation");
    } finally {
        delete game.darkHeresy.api.rolls;
    }
});

test("executor: world setting manualOverrideGrace drives the same semantic", async () => {
    _resetMocks();
    try {
        await game.settings.set(MODULE_ID, SETTING_KEYS.manualOverrideGrace, true);
        const world = makeWorld();
        seedCommitment(world.combatant, committedRecord(world, {
            expectedState: { self: { x: 999, y: 999, elevation: 0 } }
        }));
        const planner = createPlannerService();
        const result = await planner.planTurn(world.combat, world.combatant,
            planContext(world));
        assert.equal(result.plan.breakdown.reason, "commitment");
    } finally {
        _resetMocks();
    }
});

/* ------------------------------------------------------------------ */
/* Fireteam gm-controlled degradation                                  */
/* ------------------------------------------------------------------ */

/** AI-enabled team member fixture (mirrors fireteam tests). */
function makeMember({ fireteam, x = 0, y = 0, initiative = 10 } = {}) {
    const actor = makeActor({ enabled: true, preset: "assault" });
    actor.system = { wounds: { value: 10, max: 14 } };
    actor.items = [{
        id: "w1", uuid: `Actor.${actor.id}.Item.w1`, name: "Lasgun",
        type: "weapon",
        system: { class: "ranged", range: 100, damage: "1d10+3" }
    }];
    const token = makeToken({ actor });
    token.x = x;
    token.y = y;
    token.elevation = 0;
    token.disposition = -1;
    const combatant = makeCombatant({ actor, token });
    combatant.tokenId = token.id;
    combatant.initiative = initiative;
    if (fireteam) {
        combatant.flags[MODULE_ID] = combatant.flags[MODULE_ID] ?? {};
        combatant.flags[MODULE_ID][FLAG_KEYS.fireteam] = fireteam;
    }
    return { combatant, token, actor };
}

test("buildTeamPlan: a gm-controlled flanker demotes to support, team lives", async () => {
    const leader = makeMember({ fireteam: { teamId: "alpha" }, x: 0, initiative: 20 });
    const flanker = makeMember({ fireteam: { teamId: "alpha" }, x: 50, y: 150, initiative: 10 });
    // The GM moved the flanker this round — it is already marked.
    flanker.combatant.flags[MODULE_ID] =
        flanker.combatant.flags[MODULE_ID] ?? {};
    flanker.combatant.flags[MODULE_ID][FLAG_KEYS.gmControlled] = {
        round: 1, turn: 0, reason: "gm-intervention"
    };
    const scene = makeScene({ grid: "square" });
    const enemyActor = makeActor();
    enemyActor.system = { wounds: { value: 10, max: 10 } };
    const enemyToken = makeToken({ actor: enemyActor });
    enemyToken.x = 20000;
    enemyToken.y = 0;
    enemyToken.disposition = 1;
    const enemy = makeCombatant({ actor: enemyActor, token: enemyToken });
    enemy.tokenId = enemyToken.id;
    const combat = makeCombat({
        combatants: [leader.combatant, flanker.combatant, enemy]
    });
    combat.scene = scene;
    const service = createFireteamService({ planner: createPlannerService() });
    const result = await service.buildTeamPlan(combat, {
        teamId: "alpha",
        leaderId: leader.combatant.id
    }, {
        seed: 42,
        targets: [{
            tokenId: enemyToken.id,
            tokenUuid: `Scene.${scene.id}.Token.${enemyToken.id}`,
            x: enemyToken.x, y: enemyToken.y, elevation: 0,
            canAttack: true, source: "injected"
        }]
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    const byId = Object.fromEntries(
        result.teamPlan.members.map(m => [m.combatantId, m]));
    assert.equal(byId[leader.combatant.id].task, "assault");
    assert.equal(byId[flanker.combatant.id].task, "support",
        "the gm-controlled flanker degrades to support");
    assert.equal(byId[flanker.combatant.id].groupId, "main");
    assert.deepEqual(result.teamPlan.diagnostics.gmControlled,
        [flanker.combatant.id]);
    assert.equal(result.teamPlan.diagnostics.gmDemotions.length, 1);
    assert.equal(result.teamPlan.diagnostics.gmDemotions[0].from, "flank");
});

test("buildTeamPlan: a fresh gm-intervention marks, demotes and replans", async () => {
    const leader = makeMember({ fireteam: { teamId: "alpha" }, initiative: 20 });
    const flanker = makeMember({ fireteam: { teamId: "alpha" }, x: 50, initiative: 10 });
    const scene = makeScene({ grid: "square" });
    const combat = makeCombat({
        combatants: [leader.combatant, flanker.combatant]
    });
    combat.scene = scene;
    const calls = [];
    const fakePlan = (combatant, task) => ({
        id: `plan-${combatant.id}`,
        steps: [{ id: "s1", type: "end-turn", input: {} }],
        score: 1,
        target: null,
        snapshot: { targets: [] },
        diagnostics: {
            layers: task === "flank"
                ? [{ layer: "L1", code: "gm-intervention" }]
                : []
        }
    });
    const fakePlanner = {
        planTurn: async (combatDoc, combatant, context) => {
            calls.push({ combatantId: combatant.id, task: context?.team?.task });
            return {
                status: "ok",
                plan: fakePlan(combatant, context?.team?.task)
            };
        }
    };
    const service = createFireteamService({ planner: fakePlanner });
    const result = await service.buildTeamPlan(combat, {
        teamId: "alpha",
        leaderId: leader.combatant.id
    }, { seed: 5 });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    // The freshly detected member was marked for the round…
    const mark = readGmControlled(flanker.combatant);
    assert.ok(mark, "gmControlled flag written by the team pass");
    assert.equal(mark.round, combat.round);
    // …demoted to support…
    const byId = Object.fromEntries(
        result.teamPlan.members.map(m => [m.combatantId, m]));
    assert.equal(byId[flanker.combatant.id].task, "support");
    assert.equal(result.teamPlan.diagnostics.gmDemotions[0].reason,
        "gm-intervention");
    // …and replanned once with the demoted task.
    const flankCalls = calls.filter(c => c.combatantId === flanker.combatant.id);
    assert.equal(flankCalls.length, 2);
    assert.equal(flankCalls[0].task, "flank");
    assert.equal(flankCalls[1].task, "support");
});

test("delay × commitment: the sync wait wins the turn, the record survives", async () => {
    // A committed member whose plan strikes the convergence target is
    // still delayed for the transit flanker — the synchronized strike
    // outranks the personal plan — but the flag record is never touched:
    // the commitment resumes on the next turn if it stays valid.
    const leader = makeMember({ fireteam: { teamId: "alpha" }, x: 0, initiative: 20 });
    const support = makeMember({ fireteam: { teamId: "alpha" }, x: 100, initiative: 15 });
    const flanker = makeMember({ fireteam: { teamId: "alpha" }, x: 20000, initiative: 5 });
    const scene = makeScene({ grid: "square" });
    const enemyActor = makeActor();
    enemyActor.system = { wounds: { value: 10, max: 10 } };
    const enemyToken = makeToken({ actor: enemyActor });
    enemyToken.x = 300;
    enemyToken.y = 0;
    enemyToken.disposition = 1;
    const enemy = makeCombatant({ actor: enemyActor, token: enemyToken });
    enemy.tokenId = enemyToken.id;
    const combat = makeCombat({
        combatants: [leader.combatant, support.combatant, flanker.combatant, enemy]
    });
    combat.scene = scene;
    // The support member carries a live committed plan.
    const record = {
        id: "c-support",
        status: "active",
        combatId: combat.id,
        combatantId: support.combatant.id,
        createdRound: combat.round,
        createdTurn: combat.turn,
        ttl: 2,
        source: "test",
        steps: [
            { id: "s1", type: "attack", input: { targetTokenId: enemyToken.id } },
            { id: "s2", type: "end-turn", input: {} }
        ],
        expectedState: {
            self: { x: 100, y: 0, elevation: 0 },
            target: { tokenId: enemyToken.id, x: 300, y: 0 },
            morale: null,
            threats: []
        }
    };
    support.combatant.flags[MODULE_ID] =
        support.combatant.flags[MODULE_ID] ?? {};
    support.combatant.flags[MODULE_ID][FLAG_KEYS.committedPlan] = record;
    const stubPlanner = {
        planTurn: async (combatDoc, combatant) => {
            const isFlanker = combatant.id === flanker.combatant.id;
            const plan = {
                id: `plan-${combatant.id}`,
                score: 1,
                target: isFlanker ? null : { tokenId: enemyToken.id },
                snapshot: { targets: [] },
                steps: isFlanker
                    ? [
                        { id: "step-move-1", type: "move", input: { to: { x: 100, y: 0 }, waypoints: [] } },
                        { id: "step-end-turn-2", type: "end-turn", input: {} }
                    ]
                    : [
                        { id: "step-attack-1", type: "attack", input: { targetTokenId: enemyToken.id } },
                        { id: "step-end-turn-2", type: "end-turn", input: {} }
                    ]
            };
            return { status: "ok", plan, reason: null };
        }
    };
    const service = createFireteamService({ planner: stubPlanner });
    const result = await service.buildTeamPlan(combat, {
        teamId: "alpha",
        leaderId: leader.combatant.id
    }, {
        seed: 5,
        allowFlank: true,
        assignments: {
            [leader.combatant.id]: "assault",
            [support.combatant.id]: "support",
            [flanker.combatant.id]: "flank"
        },
        targets: [{ tokenId: enemyToken.id, x: 300, y: 0, wounds: 10 }]
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok);
    const supportEntry = result.teamPlan.members
        .find(m => m.combatantId === support.combatant.id);
    assert.ok(supportEntry.delayed, "sync delay outranks the commitment");
    assert.equal(supportEntry.delayed.reason, "await-sync");
    // The committed record itself is untouched — it resumes next turn.
    const stored = support.combatant.flags[MODULE_ID][FLAG_KEYS.committedPlan];
    assert.equal(stored.status, "active");
    assert.equal(stored.id, "c-support");
});

/* ------------------------------------------------------------------ */
/* Reactive mode threshold                                             */
/* ------------------------------------------------------------------ */

test("reactive mode: >1 same-team intervention squeezes the ttl to one round", () => {
    const world = makeWorld();
    for (const name of ["m1", "m2"]) {
        const mate = makeCombatant();
        mate.flags[MODULE_ID] = mate.flags[MODULE_ID] ?? {};
        mate.flags[MODULE_ID][FLAG_KEYS.fireteam] = { teamId: "alpha" };
        mate.flags[MODULE_ID][FLAG_KEYS.gmControlled] = { round: 2, turn: 0 };
        world.combat.combatants.set(mate.id, mate);
        // `contents` and `turns` share the array — one push suffices.
        world.combat.combatants.contents.push(mate);
    }
    world.combatant.flags[MODULE_ID] = world.combatant.flags[MODULE_ID] ?? {};
    world.combatant.flags[MODULE_ID][FLAG_KEYS.fireteam] = { teamId: "alpha" };
    world.combat.round = 2;
    const diagnostics = {};
    // A record committed last round would still be inside ttl=2 — but
    // reactive mode squeezes the effective ttl to 1 → ttl-expired.
    seedCommitment(world.combatant, committedRecord(world, { createdRound: 1 }));
    const result = applyCommitmentLayer({
        combat: world.combat,
        combatant: world.combatant,
        context: { team: { teamId: "alpha" } },
        flags: { commitment: true },
        diagnostics
    });
    assert.equal(result.invalidated, "ttl-expired");
    const last = diagnostics.layers.at(-1);
    assert.equal(last.code, "ttl-expired");
    assert.equal(last.detail.reactive, true);
    assert.equal(result.reactive, true);
    // With the chaos gone (round moved past the marks) the record is
    // evaluated normally again — here it is simply expired by ttl.
    world.combat.round = 4;
    const after = applyCommitmentLayer({
        combat: world.combat,
        combatant: world.combatant,
        context: { team: { teamId: "alpha" } },
        flags: { commitment: true },
        diagnostics: {}
    });
    assert.equal(after.reactive, false);
});

test("validateCommitment: a committed attack without live LOS is los-broken", () => {
    const world = makeWorld();
    const record = committedRecord(world);
    const base = {
        combatId: world.combat.id,
        round: 1,
        self: { x: 0, y: 0, elevation: 0 },
        resolveToken: id => id === world.enemyToken.id ? world.enemyToken : null,
        isTokenAlive: () => true
    };
    const verdict = validateCommitment(record, {
        ...base,
        losCheck: () => false
    });
    assert.equal(verdict.valid, false);
    assert.equal(verdict.reason, COMMITMENT_REASONS.losBroken);
    assert.equal(verdict.detail.step, "step-attack-1");
    // An open lane keeps the record a hit; a probe throwing degrades to open.
    assert.equal(validateCommitment(record, {
        ...base,
        losCheck: () => true
    }).valid, true);
    assert.equal(validateCommitment(record, {
        ...base,
        losCheck: () => { throw new Error("probe down"); }
    }).valid, true);
});
