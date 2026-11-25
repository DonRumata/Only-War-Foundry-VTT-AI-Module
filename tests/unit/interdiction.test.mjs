/**
 * Unit tests for the interdiction-screen pure core (issue #87, epic #84):
 * trigger A/B gates and priority, target eligibility, deterministic
 * interdictor scoring with the survival model, charge precheck legality,
 * screen-point fallback chain, second interdictor rules, exclusion output,
 * object-form assignments and byte-equal determinism. All numbers are
 * hand-computed; positions use the gridless 1:1 pixel-per-unit mode
 * unless a test injects an explicit grid.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    INTERDICTION_DEFAULTS,
    INTERDICTION_TACTIC,
    INTERDICT_EXCLUSION_REASON,
    INTERDICT_ROLE,
    chargeExpectedOf,
    memberCombatProfile,
    normalizeAssignment,
    resolveInterdictionConfig,
    screenPointOf,
    selectInterdiction,
    shooterProfileOf,
    soakOfActor,
    survivalThresholdOf
} from "../../scripts/presets/interdiction.js";

/* ------------------------------------------------------------------ */
/* Fixture helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Team member stub. Flat EV/rate fields inject the combat projection
 * directly; `items`/`system` build the actor-document projection path.
 * @param {string} id Combatant id.
 * @param {number} x Position x (units == px in gridless mode).
 * @param {number} y Position y.
 * @param {object} [extra] Field overrides.
 * @returns {object}
 */
function member(id, x, y, extra = {}) {
    const system = extra.system ?? {};
    const actor = {
        id: `actor-${id}`,
        items: extra.items ?? [],
        statuses: extra.actorStatuses ?? [],
        system
    };
    const combatant = {
        id,
        actor,
        token: { x, y, statuses: extra.tokenStatuses ?? [] },
        flags: extra.combatantFlags ?? {}
    };
    return {
        combatantId: id,
        position: { x, y },
        enabled: extra.enabled ?? true,
        defeated: extra.defeated ?? false,
        statuses: extra.statuses ?? [],
        combatant,
        ...(extra.meleeEV !== undefined ? { meleeEV: extra.meleeEV } : {}),
        ...(extra.rangedEV !== undefined ? { rangedEV: extra.rangedEV } : {}),
        ...(extra.bestRange !== undefined ? { bestRange: extra.bestRange } : {}),
        ...(extra.chargeRate !== undefined ? { chargeRate: extra.chargeRate } : {}),
        ...(extra.fullMove !== undefined ? { fullMove: extra.fullMove } : {}),
        ...(extra.hp !== undefined ? { hp: extra.hp } : {})
    };
}

/**
 * Enemy target stub with a flat shooter profile.
 * @param {string} id Token id.
 * @param {number} x
 * @param {number} y
 * @param {object} [extra] Profile/eligibility overrides.
 * @returns {object}
 */
function target(id, x, y, extra = {}) {
    return {
        tokenId: id,
        tokenUuid: `Scene.s.Token.${id}`,
        x,
        y,
        statuses: extra.statuses ?? [],
        canAttack: extra.canAttack ?? true,
        hidden: extra.hidden ?? false,
        ...(extra.source ? { source: extra.source } : {}),
        ...(extra.rangedEV !== undefined ? { rangedEV: extra.rangedEV } : {}),
        ...(extra.meleeEV !== undefined ? { meleeEV: extra.meleeEV } : {}),
        ...(extra.chargeRate !== undefined ? { chargeRate: extra.chargeRate } : {}),
        ...(extra.emitters ? { emitters: extra.emitters } : {}),
        ...(extra.actor ? { actor: extra.actor } : {})
    };
}

/** Lasgun weapon item: EV 1d10+3 = 5.5 + 3 = 8.5, range 100. */
function lasgun() {
    return { id: "w-las", type: "weapon", system: { class: "ranged", range: 100, damage: "1d10+3" } };
}

/** Knife weapon item: EV 1d5+2 = 3 + 2 = 5. */
function knife() {
    return { id: "w-knife", type: "weapon", system: { class: "melee", damage: "1d5+2" } };
}

/** Armour table with the given per-location totals. */
function armour(totals) {
    const [head, leftArm, rightArm, body, leftLeg, rightLeg] = totals;
    return {
        head: { total: head },
        leftArm: { total: leftArm },
        rightArm: { total: rightArm },
        body: { total: body },
        leftLeg: { total: leftLeg },
        rightLeg: { total: rightLeg }
    };
}

/**
 * Melee-capable interdictor candidate with a hand-computable profile.
 * @param {string} id
 * @param {number} x
 * @param {number} y
 * @param {object} [extra]
 * @returns {object}
 */
function fighter(id, x, y, extra = {}) {
    return member(id, x, y, {
        meleeEV: extra.meleeEV ?? 5,
        chargeRate: extra.chargeRate ?? 9,
        fullMove: extra.fullMove ?? 6,
        hp: extra.hp ?? 10,
        system: {
            wounds: { value: extra.hp ?? 10 },
            movement: { charge: extra.chargeRate ?? 9, full: extra.fullMove ?? 6 },
            armour: armour(extra.armourTotals ?? [5, 5, 5, 5, 5, 5])
        },
        ...extra
    });
}

/**
 * Team shooter (lasgun profile): rangedEV 8.5, bestRange 100, no melee.
 * @param {string} id
 * @param {number} x
 * @param {number} y
 * @param {object} [extra]
 * @returns {object}
 */
function shooter(id, x, y, extra = {}) {
    return member(id, x, y, {
        rangedEV: 8.5,
        meleeEV: 0,
        bestRange: 100,
        hp: 10,
        ...extra
    });
}

/* ------------------------------------------------------------------ */
/* Profile resolution                                                  */
/* ------------------------------------------------------------------ */

test("shooterProfileOf: flat explicit fields pass through", () => {
    const profile = shooterProfileOf({ rangedEV: 8.5, meleeEV: 4, chargeRate: 9 });
    assert.equal(profile.rangedEV, 8.5);
    assert.equal(profile.meleeEV, 4);
    assert.equal(profile.chargeRate, 9);
    assert.equal(profile.melee, true);
});

test("shooterProfileOf: emitters derive EVs, explicit zero overrides", () => {
    const fromEmitters = shooterProfileOf({
        emitters: [
            { ev: 8.5, range: 100, melee: false },
            { ev: 5, melee: true }
        ]
    });
    assert.equal(fromEmitters.rangedEV, 8.5);
    assert.equal(fromEmitters.meleeEV, 5);
    const overridden = shooterProfileOf({
        rangedEV: 0,
        emitters: [{ ev: 8.5, range: 100, melee: false }]
    });
    assert.equal(overridden.rangedEV, 0);
    assert.equal(overridden.melee, false);
});

test("shooterProfileOf: actor weapon items project through weaponEmitters", () => {
    const actor = {
        items: [lasgun(), knife()],
        system: { movement: { charge: 9 } }
    };
    const profile = shooterProfileOf({ actor });
    assert.equal(profile.rangedEV, 8.5);
    assert.equal(profile.meleeEV, 5);
    assert.equal(profile.chargeRate, 9);
});

test("memberCombatProfile: lasgun-only member is a shooter, not melee-capable", () => {
    const profile = memberCombatProfile({
        combatant: { actor: { items: [lasgun()], system: {} } }
    });
    assert.equal(profile.rangedEV, 8.5);
    assert.equal(profile.meleeEV, 0);
    assert.equal(profile.bestRange, 100);
});

test("memberCombatProfile: full move falls back to 2/3 of the charge rate", () => {
    const profile = memberCombatProfile({
        chargeRate: 9,
        combatant: { actor: { items: [], system: {} } }
    });
    assert.equal(profile.fullMove, 6);
});

test("soakOfActor: median of location totals, toughness fallback", () => {
    // Sorted [4,5,5,5,6,7] — even count, median = (5+5)/2 = 5.
    assert.equal(soakOfActor({ system: { armour: armour([7, 5, 5, 4, 6, 5]) } }), 5);
    assert.equal(soakOfActor({
        system: { characteristics: { toughness: { bonus: 3 } } }
    }), 3);
    assert.equal(soakOfActor({ system: {} }), 0);
});

test("survivalThresholdOf: per-character gates with default fallback", () => {
    assert.equal(survivalThresholdOf("elite"), 1.5);
    assert.equal(survivalThresholdOf("shock"), 1.5);
    assert.equal(survivalThresholdOf("disciplined"), 2);
    assert.equal(survivalThresholdOf("rabble"), 3);
    assert.equal(survivalThresholdOf(null), 2);
    assert.equal(survivalThresholdOf("unknown"), 2);
});

test("resolveInterdictionConfig: finite overrides win, junk ignored", () => {
    const cfg = resolveInterdictionConfig({ confidenceMin: 0.5, minRangedEV: "junk" });
    assert.equal(cfg.confidenceMin, 0.5);
    assert.equal(cfg.minRangedEV, INTERDICTION_DEFAULTS.minRangedEV);
    const custom = resolveInterdictionConfig({ survivalThresholds: { rabble: 4 } });
    assert.equal(custom.survivalThresholds.rabble, 4);
    assert.equal(custom.survivalThresholds.disciplined, 2);
});

/* ------------------------------------------------------------------ */
/* Trigger A: pure-shooter shutdown                                    */
/* ------------------------------------------------------------------ */

test("trigger A: pure shooter (confidence 1.0) is interdicted", () => {
    const result = selectInterdiction({
        members: [fighter("m1", 0, 0), shooter("m2", 2, 0)],
        targets: [target("e1", 8, 0, { rangedEV: 8.5, meleeEV: 0 })],
        leaderId: "m2"
    });
    assert.equal(result.name, INTERDICTION_TACTIC);
    assert.equal(result.reason, "pure-shooter");
    assert.equal(result.objective.trigger, "A");
    assert.equal(result.objective.targetId, "e1");
    assert.equal(result.breakdown.interdiction.confidence, 1);
});

test("trigger A: hybrid 8.5/4 fails the 0.7 confidence gate (0.68)", () => {
    const result = selectInterdiction({
        members: [fighter("m1", 0, 0), shooter("m2", 2, 0)],
        targets: [target("e1", 8, 0, { rangedEV: 8.5, meleeEV: 4 })],
        leaderId: "m2"
    });
    assert.equal(result.name, null);
    assert.equal(result.reason, "no-interdiction-target");
    const candidate = result.breakdown.interdiction.candidates[0];
    // 8.5 / (8.5 + 4) = 0.68 — under the 0.7 experimental default.
    assert.equal(candidate.confidence, 0.68);
    assert.equal(candidate.rejected, "confidence-below-min");
});

test("trigger A: ranged EV below the 6 floor rejects a pistolero", () => {
    const result = selectInterdiction({
        members: [fighter("m1", 0, 0), shooter("m2", 2, 0)],
        targets: [target("e1", 8, 0, { rangedEV: 5, meleeEV: 0 })],
        leaderId: "m2"
    });
    assert.equal(result.name, null);
    const candidate = result.breakdown.interdiction.candidates[0];
    assert.equal(candidate.confidence, 1);
    assert.equal(candidate.rejected, "ranged-ev-below-floor");
});

test("trigger A: overridden confidence gate admits the hybrid", () => {
    const result = selectInterdiction({
        members: [fighter("m1", 0, 0), shooter("m2", 2, 0)],
        targets: [target("e1", 8, 0, { rangedEV: 8.5, meleeEV: 4 })],
        leaderId: "m2",
        config: { confidenceMin: 0.6 }
    });
    assert.equal(result.name, INTERDICTION_TACTIC);
    assert.equal(result.objective.trigger, "A");
    assert.equal(result.breakdown.interdiction.thresholds.confidenceMin, 0.6);
});

test("trigger A: the highest ranged EV wins, tokenUuid breaks the tie", () => {
    const members = [fighter("m1", 0, 0), shooter("m2", 2, 0)];
    const strongest = selectInterdiction({
        members,
        targets: [
            target("e1", 8, 0, { rangedEV: 8.5, meleeEV: 0 }),
            target("e2", 9, 0, { rangedEV: 10, meleeEV: 0 })
        ],
        leaderId: "m2"
    });
    assert.equal(strongest.objective.targetId, "e2");
    const tied = selectInterdiction({
        members,
        targets: [
            target("zz", 8, 0, { rangedEV: 8.5, meleeEV: 0 }),
            target("aa", 9, 0, { rangedEV: 8.5, meleeEV: 0 })
        ],
        leaderId: "m2"
    });
    // Equal ranged EV — `Scene.s.Token.aa` sorts before `Scene.s.Token.zz`.
    assert.equal(tied.objective.targetId, "aa");
});

/* ------------------------------------------------------------------ */
/* Trigger B: charger screen                                           */
/* ------------------------------------------------------------------ */

/** Charger fixture: meleeEV 9, no ranged, charge rate 9. */
function charger(id, x, y, extra = {}) {
    return target(id, x, y, { meleeEV: 9, rangedEV: 0, chargeRate: 9, ...extra });
}

test("trigger B: charger inside the threat zone is screened", () => {
    // Zone = chargeRate 9 + buffer 1 = 10; the shooter sits at 9.5.
    const result = selectInterdiction({
        members: [fighter("m1", 0, 0), fighter("m2", 1, 0), shooter("m3", 40, 0)],
        targets: [charger("e1", 49.5, 0)],
        leaderId: "m1"
    });
    assert.equal(result.name, INTERDICTION_TACTIC);
    assert.equal(result.reason, "charger-threat");
    assert.equal(result.objective.trigger, "B");
    const candidate = result.breakdown.interdiction.candidates[0];
    assert.equal(candidate.threatenedCount, 1);
    assert.deepEqual(candidate.threatened, ["m3"]);
    assert.equal(candidate.chargeReach, 9);
});

test("trigger B: charger outside the zone is no threat", () => {
    // 10.5 units away — beyond chargeRate 9 + buffer 1.
    const result = selectInterdiction({
        members: [fighter("m1", 0, 0), fighter("m2", 1, 0), shooter("m3", 40, 0)],
        targets: [charger("e1", 50.5, 0)],
        leaderId: "m1"
    });
    assert.equal(result.name, null);
    const candidate = result.breakdown.interdiction.candidates[0];
    assert.equal(candidate.threatenedCount, 0);
    assert.equal(candidate.rejected, "no-threatened-shooter");
});

test("trigger B: unreadable movement falls back to the 8-unit reach", () => {
    const near = selectInterdiction({
        members: [fighter("m1", 0, 0), fighter("m2", 1, 0), shooter("m3", 40, 0)],
        targets: [charger("e1", 48, 0, { chargeRate: null })],
        leaderId: "m1"
    });
    // Fallback reach = meleeReach 2 + allowance 6 = 8, zone 9 — 8 units
    // away the shooter is covered.
    assert.equal(near.name, INTERDICTION_TACTIC);
    assert.equal(near.breakdown.interdiction.candidates[0].chargeReach, 8);
    const far = selectInterdiction({
        members: [fighter("m1", 0, 0), fighter("m2", 1, 0), shooter("m3", 40, 0)],
        targets: [charger("e1", 49.5, 0, { chargeRate: null })],
        leaderId: "m1"
    });
    // 9.5 > 8 + 1 — no threat under the fallback reach.
    assert.equal(far.name, null);
});

test("trigger B: inverse-confidence admits a hybrid charger", () => {
    // meleeEV 8 vs rangedEV 6: inverse 8/14 ≈ 0.571 ≥ 0.5 — melee-oriented
    // even though the rifle is real (and confidence 0.43 fails trigger A).
    const result = selectInterdiction({
        members: [fighter("m1", 0, 0), fighter("m2", 1, 0), shooter("m3", 40, 0)],
        targets: [target("e1", 49, 0, { meleeEV: 8, rangedEV: 6, chargeRate: 9 })],
        leaderId: "m1"
    });
    assert.equal(result.name, INTERDICTION_TACTIC);
    assert.equal(result.objective.trigger, "B");
    const candidate = result.breakdown.interdiction.candidates[0];
    assert.equal(candidate.inverseConfidence, 0.5714);
});

test("trigger B: pinned or stunned chargers are ignored", () => {
    for (const status of ["pinned", "stunned"]) {
        const result = selectInterdiction({
            members: [fighter("m1", 0, 0), fighter("m2", 1, 0), shooter("m3", 40, 0)],
            targets: [charger("e1", 49.5, 0, { statuses: [status] })],
            leaderId: "m1"
        });
        assert.equal(result.name, null);
        assert.equal(result.breakdown.interdiction.candidates[0].rejected, `target-${status}`);
    }
});

test("trigger B: a shooter already in melee is not worth screening", () => {
    // The shooter stands next to a second enemy — the screen cannot help
    // a member already engaged, so the charger threatens nobody.
    const result = selectInterdiction({
        members: [fighter("m1", 0, 0), fighter("m2", 1, 0), shooter("m3", 40, 0)],
        targets: [
            charger("e1", 49.5, 0),
            target("e2", 41.5, 0, { meleeEV: 4, rangedEV: 0, chargeRate: 6 })
        ],
        leaderId: "m1"
    });
    const first = result.breakdown.interdiction.candidates
        .find(candidate => candidate.targetId === "e1");
    assert.equal(first.threatenedCount, 0);
});

test("trigger priority: the charger outranks the pure shooter (B > A)", () => {
    const result = selectInterdiction({
        members: [fighter("m1", 0, 0), fighter("m2", 1, 0), shooter("m3", 40, 0)],
        targets: [
            target("e-shooter", -30, 0, { rangedEV: 10, meleeEV: 0 }),
            charger("e-charger", 49.5, 0)
        ],
        leaderId: "m1"
    });
    assert.equal(result.name, INTERDICTION_TACTIC);
    assert.equal(result.reason, "charger-threat");
    assert.equal(result.objective.targetId, "e-charger");
});

test("trigger both: custom gates let one target satisfy A and B", () => {
    const result = selectInterdiction({
        members: [fighter("m1", 0, 0), fighter("m2", 1, 0), shooter("m3", 40, 0)],
        targets: [target("e1", 49, 0, { rangedEV: 6, meleeEV: 6, chargeRate: 9 })],
        leaderId: "m1",
        config: { confidenceMin: 0.4, chargerConfidenceMin: 0.4 }
    });
    assert.equal(result.name, INTERDICTION_TACTIC);
    assert.equal(result.reason, "both");
    assert.equal(result.objective.trigger, "both");
});

test("trigger B: threat count outranks melee EV, tokenUuid breaks ties", () => {
    const members = [
        fighter("m1", 0, 0), fighter("m2", 1, 0),
        shooter("m3", 40, 0), shooter("m4", 41, 0)
    ];
    // e-stronger threatens one shooter, e-wider threatens two — the wider
    // coverage wins despite the lower melee EV.
    const result = selectInterdiction({
        members,
        targets: [
            charger("e-stronger", 90, 0, { meleeEV: 12 }),
            charger("e-wider", 49.5, 0, { meleeEV: 6 })
        ],
        leaderId: "m1"
    });
    assert.equal(result.objective.targetId, "e-wider");
});

/* ------------------------------------------------------------------ */
/* Target eligibility                                                  */
/* ------------------------------------------------------------------ */

test("eligibility: memory, relay and intel contacts never qualify", () => {
    for (const source of ["last-known", "team-contact", "relay", "intel"]) {
        const result = selectInterdiction({
            members: [fighter("m1", 0, 0), shooter("m2", 2, 0)],
            targets: [target("e1", 8, 0, { rangedEV: 8.5, meleeEV: 0, source })],
            leaderId: "m2"
        });
        assert.equal(result.name, null, source);
        assert.equal(result.breakdown.interdiction.candidates[0].rejected, "memory-source");
    }
});

test("eligibility: unattackable and hidden targets are rejected", () => {
    const noAttack = selectInterdiction({
        members: [fighter("m1", 0, 0), shooter("m2", 2, 0)],
        targets: [target("e1", 8, 0, { rangedEV: 8.5, meleeEV: 0, canAttack: false })],
        leaderId: "m2"
    });
    assert.equal(noAttack.breakdown.interdiction.candidates[0].rejected, "not-attackable");
    const hidden = selectInterdiction({
        members: [fighter("m1", 0, 0), shooter("m2", 2, 0)],
        targets: [target("e1", 8, 0, { rangedEV: 8.5, meleeEV: 0, hidden: true })],
        leaderId: "m2"
    });
    assert.equal(hidden.breakdown.interdiction.candidates[0].rejected, "hidden");
});

test("eligibility: pinned/stunned shooters are already neutralized", () => {
    for (const status of ["pinned", "stunned"]) {
        const result = selectInterdiction({
            members: [fighter("m1", 0, 0), shooter("m2", 2, 0)],
            targets: [target("e1", 8, 0, { rangedEV: 8.5, meleeEV: 0, statuses: [status] })],
            leaderId: "m2"
        });
        assert.equal(result.breakdown.interdiction.candidates[0].rejected, `target-${status}`);
    }
});

test("eligibility: a target already in melee needs no interception", () => {
    // Geometric inference: m2 stands 1.5 units from the target (reach 2).
    const geometric = selectInterdiction({
        members: [fighter("m1", 0, 0), shooter("m2", 9.5, 0)],
        targets: [target("e1", 8, 0, { rangedEV: 8.5, meleeEV: 0 })],
        leaderId: "m2"
    });
    assert.equal(geometric.breakdown.interdiction.candidates[0].rejected, "already-engaged");
    // Injected engagement keys win over geometry (m2 far away now).
    const injected = selectInterdiction({
        members: [fighter("m1", 0, 0), shooter("m2", 30, 0)],
        targets: [target("e1", 8, 0, { rangedEV: 8.5, meleeEV: 0 })],
        leaderId: "m2",
        engagements: ["Scene.s.Token.e1"]
    });
    assert.equal(injected.breakdown.interdiction.candidates[0].rejected, "already-engaged");
});

/* ------------------------------------------------------------------ */
/* Interdictor scoring                                                 */
/* ------------------------------------------------------------------ */

test("interdictor scoring: hand-computed weights plus survival margin", () => {
    // m1: meleeEV 5, chargeRate 9, wounds 10, soak 5 (flat armour table).
    // Target meleeEV 9 → hitEV = max(9−5, 1) = 4; rtd = 10/4 = 2.5 ≥ 2;
    // margin = min(2.5, 4) − 2 = 0.5; score = 2×5 + 0.5×9 + 0.2×10 + 0.5 = 17.
    const result = selectInterdiction({
        members: [fighter("m1", 0, 0), shooter("m2", 40, 0)],
        targets: [charger("e1", 49.5, 0)],
        leaderId: "m2"
    });
    const detail = result.breakdown.interdiction.interdictors[0];
    assert.equal(detail.combatantId, "m1");
    assert.equal(detail.score, 17);
    assert.equal(detail.rtd, 2.5);
    assert.equal(detail.hitEV, 4);
    assert.equal(detail.soak, 5);
    assert.equal(detail.margin, 0.5);
    assert.equal(detail.threshold, 2);
});

test("interdictor scoring: the leader carries a −3 penalty, never a veto", () => {
    const members = [
        fighter("m1", 0, 0),
        fighter("m2", 0.5, 0), // Identical stats.
        shooter("m3", 40, 0)
    ];
    const result = selectInterdiction({
        members,
        targets: [charger("e1", 49.5, 0)],
        leaderId: "m1"
    });
    // m1 is the leader: 17 − 3 = 14 vs m2's 17 — the non-leader wins.
    const detail = result.breakdown.interdiction.interdictors[0];
    assert.equal(detail.combatantId, "m2");
    assert.equal(detail.score, 17);
    const leaderRow = result.breakdown.interdiction.interdictorCandidates
        .find(candidate => candidate.combatantId === "m1");
    assert.equal(leaderRow.score, 14);
});

test("interdictor scoring: exact ties break by combatant id ascending", () => {
    const members = [
        fighter("m-z", 0, 0),
        fighter("m-a", 0.5, 0),
        shooter("m3", 40, 0)
    ];
    const result = selectInterdiction({
        members,
        targets: [charger("e1", 49.5, 0)],
        leaderId: "m3"
    });
    assert.equal(result.breakdown.interdiction.interdictors[0].combatantId, "m-a");
});

test("interdictor gates: statuses, melee capability and charge rate", () => {
    const base = [shooter("m3", 40, 0)];
    for (const [extra, reason] of [
        [{ statuses: ["stunned"] }, "status-stunned"],
        [{ statuses: ["pinned"] }, "status-pinned"],
        [{ statuses: ["prone"] }, "status-prone"],
        [{ meleeEV: 0 }, "not-melee-capable"],
        [{ chargeRate: null, system: { wounds: { value: 10 }, armour: armour([5, 5, 5, 5, 5, 5]) } },
            "charge-rate-unavailable"]
    ]) {
        const result = selectInterdiction({
            members: [fighter("m1", 0, 0, extra), ...base],
            targets: [charger("e1", 49.5, 0)],
            leaderId: "m3"
        });
        assert.equal(result.name, null, reason);
        assert.equal(result.reason, "no-interdictor");
        const row = result.breakdown.interdiction.interdictorCandidates[0];
        assert.equal(row.rejected, reason);
    }
});

test("interdictor gates: gm-controlled members are excluded this round", () => {
    const combatantFlags = {
        "only-war-ai": { gmControlled: { round: 3, turn: 0, reason: "gm-intervention" } }
    };
    const build = round => selectInterdiction({
        members: [fighter("m1", 0, 0, { combatantFlags }), shooter("m3", 40, 0)],
        targets: [charger("e1", 49.5, 0)],
        leaderId: "m3",
        round
    });
    const row = build(3).breakdown.interdiction.interdictorCandidates[0];
    assert.equal(row.rejected, "gm-controlled");
    // A stale record from another round does not gate.
    assert.equal(build(4).name, INTERDICTION_TACTIC);
});

test("survival model: thresholds per team character gate the trade", () => {
    // Target meleeEV 9, soak 5 → hitEV 4; wounds 6 → rtd 1.5 exactly.
    const build = character => selectInterdiction({
        members: [fighter("m1", 0, 0, { hp: 6 }), shooter("m3", 40, 0)],
        targets: [charger("e1", 49.5, 0)],
        leaderId: "m3",
        character
    });
    assert.equal(build("elite").name, INTERDICTION_TACTIC);
    assert.equal(build("shock").name, INTERDICTION_TACTIC);
    assert.equal(build("disciplined").name, null);
    assert.equal(build("disciplined").reason, "no-survivable-interdictor");
    assert.equal(build(null).reason, "no-survivable-interdictor");
    assert.equal(build("rabble").reason, "no-survivable-interdictor");
    const row = build("rabble").breakdown.interdiction.interdictorCandidates[0];
    assert.equal(row.rejected, "survival-below-threshold");
    assert.equal(row.rtd, 1.5);
});

test("survival model: rabble rejects trades a disciplined team accepts", () => {
    // hitEV 4, wounds 8 → rtd 2.0: passes disciplined (2), fails rabble (3).
    const build = character => selectInterdiction({
        members: [fighter("m1", 0, 0, { hp: 8 }), shooter("m3", 40, 0)],
        targets: [charger("e1", 49.5, 0)],
        leaderId: "m3",
        character
    });
    assert.equal(build("disciplined").name, INTERDICTION_TACTIC);
    assert.equal(build("rabble").name, null);
});

test("interdictor selection: actor weapon items project the melee capability", () => {
    // No flat EV injection: the knife-only loadout must surface through
    // the same weaponEmitters projection the threat map uses. Knife EV
    // 1d5+2 = 5, no ranged weapon — melee-capable, never a shooter.
    const knifeFighter = member("m1", 0, 0, {
        items: [knife()],
        system: {
            wounds: { value: 10 },
            movement: { charge: 9, full: 6 },
            armour: armour([5, 5, 5, 5, 5, 5])
        }
    });
    const result = selectInterdiction({
        members: [knifeFighter, shooter("m2", 2, 0)],
        targets: [target("e1", 8, 0, { rangedEV: 8.5, meleeEV: 0 })],
        leaderId: "m2"
    });
    assert.equal(result.name, INTERDICTION_TACTIC);
    const row = result.breakdown.interdiction.interdictorCandidates[0];
    assert.equal(row.combatantId, "m1");
    assert.equal(row.meleeEV, 5);
    assert.equal(row.rejected, null);
});

test("survival model: a melee-less target makes the trade cheap", () => {
    // Pure shooter meleeEV 0 → hitEV = max(0−5, 1) = 1; rtd = 10 — the
    // doctrine exactly: tying up a gun costs the interdictor almost nothing.
    const result = selectInterdiction({
        members: [fighter("m1", 0, 0), shooter("m2", 2, 0)],
        targets: [target("e1", 8, 0, { rangedEV: 8.5, meleeEV: 0 })],
        leaderId: "m2"
    });
    const detail = result.breakdown.interdiction.interdictors[0];
    assert.equal(detail.hitEV, 1);
    assert.equal(detail.rtd, 10);
    assert.equal(detail.margin, 2); // min(10, 4) − 2.
});

/* ------------------------------------------------------------------ */
/* Charge precheck                                                     */
/* ------------------------------------------------------------------ */

test("chargeExpectedOf: distance window and wall probe", () => {
    const cfg = INTERDICTION_DEFAULTS;
    // 9 units inside [4, 9] — legal.
    assert.equal(chargeExpectedOf({ x: 0, y: 0 }, { x: 9, y: 0 }, 9, { cfg }), true);
    // 3 < 4 — too close for the running start.
    assert.equal(chargeExpectedOf({ x: 0, y: 0 }, { x: 3, y: 0 }, 9, { cfg }), false);
    // 12 > 9 — beyond the charge rate.
    assert.equal(chargeExpectedOf({ x: 0, y: 0 }, { x: 12, y: 0 }, 9, { cfg }), false);
    // A move-blocking wall on the straight segment breaks the precheck.
    assert.equal(chargeExpectedOf({ x: 0, y: 0 }, { x: 9, y: 0 }, 9, {
        cfg,
        wallProbe: () => true
    }), false);
});

test("charge precheck: walls array crosses are honoured in the selector", () => {
    // Pure-shooter target 8 units out: inside the [4, 9] charge window.
    // The wall at x = 4 crosses the straight segment m1(0,0) → e1(8,0).
    const build = walls => selectInterdiction({
        members: [fighter("m1", 0, 0), shooter("m2", 40, 0)],
        targets: [target("e1", 8, 0, { rangedEV: 8.5, meleeEV: 0 })],
        leaderId: "m2",
        walls
    });
    assert.equal(build([{ c: [4, -5, 4, 5], move: 1, sight: 1, door: null }])
        .objective.chargeExpected, false);
    assert.equal(build([]).objective.chargeExpected, true);
    // An open door never blocks.
    assert.equal(build([{ c: [4, -5, 4, 5], move: 1, door: { state: "open" } }])
        .objective.chargeExpected, true);
    // A sight-only wall does not block movement.
    assert.equal(build([{ c: [4, -5, 4, 5], move: 0, sight: 1, door: null }])
        .objective.chargeExpected, true);
});

/* ------------------------------------------------------------------ */
/* Screen point geometry                                               */
/* ------------------------------------------------------------------ */

test("screenPointOf: contact wins when reachable", () => {
    // E(100,0) → P(0,0), L = 100. contact at 1.5 from E = (98.5, 0),
    // mid (50, 0), deep 4 from P = (4, 0). Interdictor (98, 5), full 6:
    // contact distance √(0.5² + 5²) ≈ 5.02 ≤ 6 — reachable and nearest
    // to the enemy.
    const screen = screenPointOf({
        enemy: { x: 100, y: 0 },
        protect: { x: 0, y: 0 },
        interdictor: { x: 98, y: 5 },
        fullMove: 6
    });
    assert.equal(screen.kind, "contact");
    assert.equal(screen.reachable, true);
    assert.deepEqual(screen.point, { x: 98.5, y: 0 });
});

test("screenPointOf: mid wins when contact is out of reach", () => {
    // Interdictor (55, 0): contact at 43.5 — out, mid at 5 — in,
    // deep at 51 — out. Mid is the nearest reachable to the enemy.
    const screen = screenPointOf({
        enemy: { x: 100, y: 0 },
        protect: { x: 0, y: 0 },
        interdictor: { x: 55, y: 0 },
        fullMove: 6
    });
    assert.equal(screen.kind, "mid");
    assert.equal(screen.reachable, true);
    assert.deepEqual(screen.point, { x: 50, y: 0 });
});

test("screenPointOf: deep is the direction fallback when nothing reaches", () => {
    const screen = screenPointOf({
        enemy: { x: 100, y: 0 },
        protect: { x: 0, y: 0 },
        interdictor: { x: 200, y: 0 },
        fullMove: 6
    });
    assert.equal(screen.kind, "deep");
    assert.equal(screen.reachable, false);
    assert.deepEqual(screen.point, { x: 4, y: 0 });
});

test("screenPointOf: deep drops out of short segments", () => {
    // L = 5: deep t = 1 − 4/5 = 0.2 — valid. L = 3: t negative — dropped.
    const longEnough = screenPointOf({
        enemy: { x: 5, y: 0 },
        protect: { x: 0, y: 0 },
        interdictor: { x: 500, y: 0 },
        fullMove: 1
    });
    assert.ok(longEnough.candidates.some(entry => entry.kind === "deep"));
    const short = screenPointOf({
        enemy: { x: 3, y: 0 },
        protect: { x: 0, y: 0 },
        interdictor: { x: 500, y: 0 },
        fullMove: 1
    });
    assert.ok(!short.candidates.some(entry => entry.kind === "deep"));
});

test("screenPointOf: degenerate segment builds no screen", () => {
    const screen = screenPointOf({
        enemy: { x: 1, y: 0 },
        protect: { x: 0, y: 0 },
        interdictor: { x: 0.5, y: 0 },
        fullMove: 6
    });
    assert.equal(screen.degenerate, true);
    assert.equal(screen.point, null);
});

test("screenPointOf: grid quantization snaps to cell centres", () => {
    // Grid 100 px per 1-unit cell: E(10030, 0) px = 100.3 units from P.
    // contact raw x = 10030 − 150 = 9880 px → snapped to 9850 (centre).
    const screen = screenPointOf({
        enemy: { x: 10030, y: 0 },
        protect: { x: 0, y: 0 },
        interdictor: { x: 9800, y: 0 },
        fullMove: 6,
        grid: { size: 100, distance: 1 }
    });
    assert.equal(screen.kind, "contact");
    assert.deepEqual(screen.point, { x: 9850, y: 50 });
});

test("screen chain: charge-illegal interdiction degrades to screen mode", () => {
    // Interdictor 3 units from the target — inside the 4-unit minimum,
    // chargeExpected false, but the screen point is still served.
    const result = selectInterdiction({
        members: [fighter("m1", 5, 0), shooter("m2", 0, 0)],
        targets: [target("e1", 8, 0, { rangedEV: 8.5, meleeEV: 0 })],
        leaderId: "m2"
    });
    const detail = result.breakdown.interdiction.interdictors[0];
    assert.equal(detail.chargeExpected, false);
    assert.equal(detail.mode, "screen");
    assert.equal(detail.degradeReason, "charge-unavailable");
    assert.ok(result.objective.screenPoint);
});

test("screen chain: degenerate segment degrades the role to plain assault", () => {
    // E(8,0), protectee m2 at (6.5, 0) — the E→P segment is 1.5 units,
    // below the 2-unit degenerate cutoff, so no screen can be built.
    // Geometric engagement would eat the target first, so engagements
    // are injected empty: the interdictor ends in pure-assault mode.
    const result = selectInterdiction({
        members: [fighter("m1", 4.5, 0), shooter("m2", 6.5, 0)],
        targets: [target("e1", 8, 0, { rangedEV: 8.5, meleeEV: 0 })],
        leaderId: "m1",
        engagements: []
    });
    const detail = result.breakdown.interdiction.interdictors[0];
    assert.equal(detail.protectId, "m2");
    assert.equal(detail.screenPoint, null);
    assert.equal(detail.screenDegenerate, true);
    // The interdictor stands 3.5 units out — inside the 4-unit charge
    // minimum — so with no screen the role is plain assault on the target.
    assert.equal(detail.chargeExpected, false);
    assert.equal(detail.mode, "assault");
    assert.equal(detail.degradeReason, "screen-degenerate");
});

test("screen chain: no protectee leaves the objective screenless", () => {
    // The only teammate carries no position at all — nobody can be the
    // protect anchor, so the charge stays primary with no screen geometry.
    const positionless = {
        combatantId: "m2",
        enabled: true,
        defeated: false,
        statuses: [],
        combatant: { id: "m2", actor: { items: [], statuses: [], system: {} }, token: {} }
    };
    const result = selectInterdiction({
        members: [fighter("m1", 0, 0), positionless],
        targets: [target("e1", 8, 0, { rangedEV: 8.5, meleeEV: 0 })],
        leaderId: "m1"
    });
    const detail = result.breakdown.interdiction.interdictors[0];
    assert.equal(detail.protectId, null);
    assert.equal(detail.mode, "charge"); // Charge stays primary when legal.
    assert.equal(detail.screenPoint, null);
    assert.equal(result.objective.screenPoint, null);
});

test("screen chain: charge-illegal plus no protectee is plain assault", () => {
    const positionless = {
        combatantId: "m2",
        enabled: true,
        defeated: false,
        statuses: [],
        combatant: { id: "m2", actor: { items: [], statuses: [], system: {} }, token: {} }
    };
    const result = selectInterdiction({
        members: [fighter("m1", 5, 0), positionless],
        targets: [target("e1", 8, 0, { rangedEV: 8.5, meleeEV: 0 })],
        leaderId: "m1"
    });
    const detail = result.breakdown.interdiction.interdictors[0];
    assert.equal(detail.chargeExpected, false);
    assert.equal(detail.mode, "assault");
    assert.equal(detail.degradeReason, "no-protect-member");
});

/* ------------------------------------------------------------------ */
/* Exclusions and assignments                                          */
/* ------------------------------------------------------------------ */

test("exclusions: the interdiction target leaves the team fire list", () => {
    const result = selectInterdiction({
        members: [fighter("m1", 0, 0), shooter("m2", 2, 0)],
        targets: [target("e1", 8, 0, { rangedEV: 8.5, meleeEV: 0 })],
        leaderId: "m2"
    });
    assert.deepEqual(result.excludedTargets, [{
        targetId: "e1",
        tokenUuid: "Scene.s.Token.e1",
        reason: INTERDICT_EXCLUSION_REASON
    }]);
});

test("assignments: interdictor entries are object-form with the role marker", () => {
    const result = selectInterdiction({
        members: [fighter("m1", 0, 0), shooter("m2", 2, 0)],
        targets: [target("e1", 8, 0, { rangedEV: 8.5, meleeEV: 0 })],
        leaderId: "m2"
    });
    const assignment = result.assignments.m1;
    assert.equal(assignment.task, "assault");
    assert.equal(assignment.role, INTERDICT_ROLE);
    assert.equal(assignment.objective.type, "interdict");
    assert.equal(assignment.objective.targetId, "e1");
});

test("assignments: base maneuver merges in normalized object form", () => {
    const result = selectInterdiction({
        members: [fighter("m1", 0, 0), shooter("m2", 2, 0), shooter("m3", 3, 0)],
        targets: [target("e1", 8, 0, { rangedEV: 8.5, meleeEV: 0 })],
        leaderId: "m2",
        base: {
            name: "coordinated-assault",
            assignments: { m1: "assault", m2: "support", m3: { task: "assault", element: "base" } }
        }
    });
    assert.equal(result.breakdown.baseTactic, "coordinated-assault");
    // The interdictor object-form overrides the base string entry.
    assert.equal(result.assignments.m1.role, INTERDICT_ROLE);
    assert.deepEqual(result.assignments.m2, { task: "support" });
    assert.deepEqual(result.assignments.m3, { task: "assault", element: "base" });
});

test("normalizeAssignment: strings read as {task}, objects keep their fields", () => {
    assert.deepEqual(normalizeAssignment("support"), { task: "support" });
    assert.deepEqual(normalizeAssignment({ task: "assault", role: "interdictor" }),
        { task: "assault", role: "interdictor" });
    assert.equal(normalizeAssignment(null), null);
    assert.equal(normalizeAssignment({}), null);
});

/* ------------------------------------------------------------------ */
/* Second interdictor                                                  */
/* ------------------------------------------------------------------ */

/**
 * Five-member squad fixture: two fighters, three shooters — charger plus
 * pure-shooter threats.
 * @param {object} [extra] selectInterdiction overrides.
 * @returns {object}
 */
function secondInterdictionWorld(extra = {}) {
    return selectInterdiction({
        members: [
            fighter("m1", 40, 0),
            fighter("m2", 45, 0, { meleeEV: 4 }),
            shooter("m3", 56, 4),
            shooter("m4", 56, -4),
            shooter("m5", 58, 0)
        ],
        targets: [
            // Zone = chargeRate 9 + buffer 1 = 10: m3/m4 sit at √80 ≈ 8.9
            // units, m5 at 6 — every shooter is threatened.
            charger("e-charger", 64, 0),
            target("e-shooter", -30, 0, { rangedEV: 8.5, meleeEV: 0 })
        ],
        leaderId: "m3",
        ...extra
    });
}

test("second interdictor: five members and two threats field two", () => {
    const result = secondInterdictionWorld();
    assert.equal(result.name, INTERDICTION_TACTIC);
    // Primary is the charger (B > A): m1 (meleeEV 5, score 17) takes it;
    // m2 (meleeEV 4, score 15) screens the shooter.
    assert.equal(result.objective.targetId, "e-charger");
    assert.equal(result.breakdown.interdiction.secondInterdictor, true);
    const ids = result.breakdown.interdiction.interdictors
        .map(detail => detail.combatantId).sort();
    assert.deepEqual(ids, ["m1", "m2"]);
    assert.equal(result.excludedTargets.length, 2);
    assert.deepEqual(result.excludedTargets.map(entry => entry.targetId).sort(),
        ["e-charger", "e-shooter"]);
    // Both assignments are object-form interdictors with own objectives.
    assert.equal(result.assignments.m1.role, INTERDICT_ROLE);
    assert.equal(result.assignments.m2.role, INTERDICT_ROLE);
    assert.equal(result.assignments.m2.objective.targetId, "e-shooter");
    assert.equal(result.objectives.length, 2);
});

test("second interdictor: four-member teams never field two", () => {
    const result = selectInterdiction({
        members: [
            fighter("m1", 40, 0),
            fighter("m2", 45, 0, { meleeEV: 4 }),
            shooter("m3", 56, 4),
            shooter("m4", 58, 0)
        ],
        targets: [
            charger("e-charger", 64, 0),
            target("e-shooter", -30, 0, { rangedEV: 8.5, meleeEV: 0 })
        ],
        leaderId: "m3"
    });
    assert.equal(result.breakdown.interdiction.secondInterdictor, false);
    assert.equal(result.excludedTargets.length, 1);
});

test("second interdictor: rabble never fields two", () => {
    const result = secondInterdictionWorld({ character: "rabble" });
    assert.equal(result.breakdown.interdiction.secondInterdictor, false);
    // The rabble threshold 3 rejects the charger trade (rtd 2.5) but the
    // melee-less shooter is cheap even for rabble (hitEV 1, rtd 10) —
    // exactly one interdictor, never the second.
    assert.equal(result.name, INTERDICTION_TACTIC);
    assert.equal(result.objective.targetId, "e-shooter");
    assert.equal(result.breakdown.interdiction.interdictors.length, 1);
    const skipped = result.breakdown.interdiction.skipped;
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].targetId, "e-charger");
    assert.equal(skipped[0].rejected, "no-survivable-interdictor");
});

test("second interdictor: a single shared threat fields only one", () => {
    const result = selectInterdiction({
        members: [
            fighter("m1", 40, 0),
            fighter("m2", 45, 0, { meleeEV: 4 }),
            shooter("m3", 56, 4),
            shooter("m4", 56, -4),
            shooter("m5", 58, 0)
        ],
        targets: [charger("e-charger", 64, 0)],
        leaderId: "m3"
    });
    assert.equal(result.breakdown.interdiction.secondInterdictor, false);
    assert.equal(result.breakdown.interdiction.interdictors.length, 1);
});

test("second interdictor: failure of the second slot is reported, not fatal", () => {
    // Only m1 is melee-capable — the second threat finds no candidate.
    const result = selectInterdiction({
        members: [
            fighter("m1", 40, 0),
            shooter("m2", 45, 0),
            shooter("m3", 56, 4),
            shooter("m4", 56, -4),
            shooter("m5", 58, 0)
        ],
        targets: [
            charger("e-charger", 64, 0),
            target("e-shooter", -30, 0, { rangedEV: 8.5, meleeEV: 0 })
        ],
        leaderId: "m3"
    });
    assert.equal(result.name, INTERDICTION_TACTIC);
    assert.equal(result.breakdown.interdiction.secondInterdictor, false);
    const skipped = result.breakdown.interdiction.skipped;
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].targetId, "e-shooter");
    assert.equal(skipped[0].rejected, "no-interdictor");
    assert.equal(result.excludedTargets.length, 1);
});

/* ------------------------------------------------------------------ */
/* Degradation and edge cases                                          */
/* ------------------------------------------------------------------ */

test("threat fallthrough: a non-viable primary yields the queue to the next threat", () => {
    // The charger is the priority threat, but against meleeEV 9 with
    // soak 0 the only fighter dies in 10/9 ≈ 1.1 rounds — no survivable
    // interdictor. The pure shooter downstream is still tied up: the
    // honest skip beats both the suicide mission and the full refusal.
    const fragile = member("m1", 0, 0, {
        meleeEV: 5,
        chargeRate: 9,
        fullMove: 6,
        hp: 10,
        system: { wounds: { value: 10 }, movement: { charge: 9, full: 6 } }
    });
    const result = selectInterdiction({
        members: [fragile, shooter("m2", 40, 0)],
        targets: [
            charger("e-charger", 49.5, 0),
            target("e-shooter", 8, 0, { rangedEV: 8.5, meleeEV: 0 })
        ],
        leaderId: "m2"
    });
    assert.equal(result.name, INTERDICTION_TACTIC);
    assert.equal(result.reason, "pure-shooter");
    assert.equal(result.objective.targetId, "e-shooter");
    const skipped = result.breakdown.interdiction.skipped;
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].targetId, "e-charger");
    assert.equal(skipped[0].rejected, "no-survivable-interdictor");
});

test("degradation: no targets in the queue is a clean refusal", () => {
    const result = selectInterdiction({
        members: [fighter("m1", 0, 0), shooter("m2", 2, 0)],
        targets: [],
        leaderId: "m2"
    });
    assert.equal(result.name, null);
    assert.equal(result.reason, "no-interdiction-target");
    assert.equal(result.breakdown.interdiction.rejected, "no-interdiction-target");
});

test("degradation: one-member teams cannot interdict", () => {
    const result = selectInterdiction({
        members: [fighter("m1", 0, 0)],
        targets: [target("e1", 8, 0, { rangedEV: 8.5, meleeEV: 0 })],
        leaderId: "m1"
    });
    assert.equal(result.name, null);
    assert.equal(result.reason, "insufficient-members");
});

test("breakdown: thresholds and candidate detail are reported", () => {
    const result = selectInterdiction({
        members: [fighter("m1", 0, 0), shooter("m2", 2, 0)],
        targets: [target("e1", 8, 0, { rangedEV: 8.5, meleeEV: 0 })],
        leaderId: "m2",
        character: "disciplined"
    });
    const thresholds = result.breakdown.interdiction.thresholds;
    assert.equal(thresholds.confidenceMin, 0.7);
    assert.equal(thresholds.minRangedEV, 6);
    assert.equal(thresholds.chargerConfidenceMin, 0.5);
    assert.equal(thresholds.survivalThreshold, 2);
    assert.equal(thresholds.character, "disciplined");
    const candidate = result.breakdown.interdiction.candidates[0];
    assert.equal(candidate.trigger, "A");
    assert.equal(candidate.rejected, null);
    assert.equal(candidate.rangedEV, 8.5);
});

/* ------------------------------------------------------------------ */
/* Determinism                                                         */
/* ------------------------------------------------------------------ */

test("determinism: JSON round-trip preserves the descriptor exactly", () => {
    const result = secondInterdictionWorld();
    const clone = JSON.parse(JSON.stringify(result));
    assert.deepEqual(clone, result);
});

test("determinism: repeated runs are byte-equal", () => {
    const first = JSON.stringify(secondInterdictionWorld());
    const second = JSON.stringify(secondInterdictionWorld());
    assert.equal(first, second);
});

test("determinism: input ordering does not change the outcome", () => {
    const membersForward = [
        fighter("m1", 40, 0),
        fighter("m2", 45, 0, { meleeEV: 4 }),
        shooter("m3", 55, 5),
        shooter("m4", 55, -5),
        shooter("m5", 58, 0)
    ];
    const targetsForward = [
        charger("e-charger", 64, 0),
        target("e-shooter", -30, 0, { rangedEV: 8.5, meleeEV: 0 })
    ];
    const forward = selectInterdiction({
        members: membersForward,
        targets: targetsForward,
        leaderId: "m3"
    });
    const backward = selectInterdiction({
        members: [...membersForward].reverse(),
        targets: [...targetsForward].reverse(),
        leaderId: "m3"
    });
    assert.equal(JSON.stringify(forward), JSON.stringify(backward));
});
