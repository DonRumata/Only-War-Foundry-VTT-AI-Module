/**
 * Unit tests for the pure concentrate-fire selector (issue #85, epic
 * #84): exact focusScore arithmetic on hand-computed fixtures, corrected
 * effective-wounds semantics (`max − value`), threat normalization cap,
 * vulnerability/reaction/friendly-fire signs per preset, exposure guard,
 * sticky hysteresis, exclusions, capacity ordering, deterministic
 * tie-breaks, trivial/kill modes and JSON round-trip stability.
 *
 * The module is document-free: every input is a plain normalized DTO,
 * no Foundry fixtures required.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    CONCENTRATE_FIRE_CONFIG,
    CONCENTRATE_FIRE_PRESET_OVERRIDES,
    FOCUS_MODES,
    FOCUS_REASONS,
    computeExposure,
    computeFocusCap,
    evaluateFocusCandidate,
    focusStickyCount,
    normalizeFocusWounds,
    otherThreatContribution,
    resolveConcentrateFireConfig,
    selectFocusTarget
} from "../../scripts/presets/concentrate-fire.js";

/**
 * Raw target input for {@link selectFocusTarget}.
 * @param {object} overrides
 * @returns {object}
 */
function makeTarget(overrides = {}) {
    return {
        tokenId: "t1",
        tokenUuid: null,
        wounds: { value: 0, max: 10 },
        statuses: [],
        reactionUsed: false,
        threatEv: 0,
        allyEngaged: false,
        ...overrides
    };
}

/**
 * Raw member input: `capability` maps target ids to killEV or
 * `{killEV, losCapable}` entries.
 * @param {string} combatantId
 * @param {object} capability
 * @param {object} [overrides]
 * @returns {object}
 */
function makeMember(combatantId, capability = {}, overrides = {}) {
    return { combatantId, capability, ...overrides };
}

/**
 * Normalized target shape for direct {@link evaluateFocusCandidate} calls.
 * @param {object} overrides
 * @returns {object}
 */
function makeNormalized(overrides = {}) {
    return {
        tokenId: "x",
        tokenUuid: null,
        targetId: "x",
        actorId: null,
        statuses: [],
        reactionUsed: null,
        threatEv: 0,
        allyEngaged: false,
        stickyCount: null,
        woundsEffective: 10,
        woundsKnown: true,
        ...overrides
    };
}

/**
 * Canonical two-target scenario (exact arithmetic reference):
 * t1 — damaged, pinned, reaction-spent gunner; t2 — fresh rifleman.
 * @returns {object} Selector input.
 */
function scenarioA() {
    return {
        preset: "rangedCover",
        round: 3,
        targets: [
            makeTarget({
                tokenId: "t1",
                wounds: { value: 2, max: 14 },
                statuses: ["pinned"],
                reactionUsed: true,
                threatEv: 12
            }),
            makeTarget({
                tokenId: "t2",
                wounds: { value: 0, max: 20 },
                threatEv: 6
            })
        ],
        members: [
            makeMember("c1", {
                t1: { killEV: 4, losCapable: true },
                t2: { killEV: 4, losCapable: true }
            }),
            makeMember("c2", { t1: { killEV: 3 } }),
            makeMember("c3", { t2: { killEV: 5 } })
        ]
    };
}

test("normalizeFocusWounds: effective health is max − value (corrected semantics)", () => {
    assert.deepEqual(normalizeFocusWounds({ value: 0, max: 14 }), { effective: 14, known: true });
    assert.deepEqual(normalizeFocusWounds({ value: 10, max: 14 }), { effective: 4, known: true });
    assert.deepEqual(normalizeFocusWounds({ value: 16, max: 14 }), { effective: -2, known: true });
    assert.deepEqual(normalizeFocusWounds({ value: 14, max: 14 }), { effective: 0, known: true });
});

test("normalizeFocusWounds: legacy plain-number and {value} injections read as effective", () => {
    assert.deepEqual(normalizeFocusWounds(7), { effective: 7, known: true });
    assert.deepEqual(normalizeFocusWounds({ value: 6 }), { effective: 6, known: true });
    assert.deepEqual(normalizeFocusWounds({ max: 14 }), { effective: 14, known: true });
});

test("normalizeFocusWounds: unreadable or suppressed data is unknown", () => {
    assert.deepEqual(normalizeFocusWounds(null), { effective: null, known: false });
    assert.deepEqual(normalizeFocusWounds({}), { effective: null, known: false });
    assert.deepEqual(normalizeFocusWounds("abc"), { effective: null, known: false });
    assert.deepEqual(normalizeFocusWounds({ value: 0, max: 14 }, false), { effective: null, known: false });
});

test("config baseline matches the spec experimental coefficients", () => {
    assert.equal(CONCENTRATE_FIRE_CONFIG.W_KILL, 2.0);
    assert.equal(CONCENTRATE_FIRE_CONFIG.W_THREAT, 1.5);
    assert.equal(CONCENTRATE_FIRE_CONFIG.W_VULN, 1.0);
    assert.equal(CONCENTRATE_FIRE_CONFIG.W_REACT, 0.75);
    assert.equal(CONCENTRATE_FIRE_CONFIG.W_FF, 1.5);
    assert.equal(CONCENTRATE_FIRE_CONFIG.W_GANG, 0.75);
    assert.equal(CONCENTRATE_FIRE_CONFIG.W_EXPOSE, 1.0);
    assert.equal(CONCENTRATE_FIRE_CONFIG.W_STICKY, 0.5);
    assert.equal(CONCENTRATE_FIRE_CONFIG.K_OVERKILL, 1.5);
    assert.equal(CONCENTRATE_FIRE_CONFIG.REF_THREAT, 15);
    assert.deepEqual(CONCENTRATE_FIRE_PRESET_OVERRIDES.assault, { focusCapShare: 1.0, gangUp: true });
    assert.deepEqual(CONCENTRATE_FIRE_PRESET_OVERRIDES.rangedCover, { focusCapShare: 0.75 });
    assert.deepEqual(CONCENTRATE_FIRE_PRESET_OVERRIDES.hold, { focusCapShare: 0.5 });
    assert.deepEqual(CONCENTRATE_FIRE_PRESET_OVERRIDES.specOps, { focusCapShare: 1.0 });
});

test("resolveConcentrateFireConfig: preset overlay, explicit and per-plan overrides layer", () => {
    const base = resolveConcentrateFireConfig(null, "rangedCover");
    assert.equal(base.focusCapShare, 0.75);
    assert.equal(base.gangUp, false);
    const assault = resolveConcentrateFireConfig(null, "assault");
    assert.equal(assault.focusCapShare, 1.0);
    assert.equal(assault.gangUp, true);
    const overridden = resolveConcentrateFireConfig({ W_KILL: 3 }, "hold", { W_KILL: 4, W_THREAT: 1.2 });
    assert.equal(overridden.W_KILL, 4);
    assert.equal(overridden.W_THREAT, 1.2);
    assert.equal(overridden.focusCapShare, 0.5);
    // Invalid values fall through to the previous layer.
    const invalid = resolveConcentrateFireConfig({ W_KILL: "big" }, "hold");
    assert.equal(invalid.W_KILL, 2.0);
});

test("selectFocusTarget: exact focusScore arithmetic on the canonical scenario", () => {
    const result = selectFocusTarget(scenarioA());
    assert.equal(result.reason, null);
    const focus = result.focus;
    assert.equal(focus.targetId, "t1");
    assert.equal(focus.mode, "focus");
    // killEV = 4 + 3 = 7; killRatio = 7 / (12 × 1.5) = 0.3889;
    // threatNorm = 12/15 = 0.8; vuln 1; react 1; ff 0; exposure 0.
    // total = 2×0.38889 + 1.5×0.8 + 1 + 0.75 = 3.72778.
    assert.equal(focus.focusScore, 3.7278);
    assert.equal(focus.killEV, 7);
    assert.equal(focus.wounds, 12);
    assert.equal(focus.margin, -5);
    assert.equal(focus.woundsKnown, true);
    assert.deepEqual(focus.breakdown, {
        killRatio: 0.3889,
        threatNorm: 0.8,
        vulnerable: 1,
        reactionSpent: 1,
        friendlyFire: 0,
        friendlyFireTerm: 0,
        exposure: 0,
        otherThreats: 0.4,
        stickyCount: 0,
        hysteresis: 0,
        total: 3.7278
    });
    // Runner-up t2: killEV 9, killRatio 9/30 = 0.3, threat 0.4×1.5 = 0.6,
    // exposure 0.3 → total 0.6 + 0.6 − 0.3 = 0.9.
    assert.deepEqual(focus.runnerUp, { targetId: "t2", focusScore: 0.9 });
    const runnerEntry = result.candidates.find(entry => entry.targetId === "t2");
    assert.equal(runnerEntry.focusScore, 0.9);
    assert.equal(runnerEntry.breakdown.exposure, 0.3);
    assert.equal(runnerEntry.breakdown.killRatio, 0.3);
});

test("selectFocusTarget: assignment ordering by killEV, LOS first at ties, id last", () => {
    const focus = selectFocusTarget(scenarioA()).focus;
    assert.equal(focus.focusCap, 2);
    assert.deepEqual(focus.capableMembers, ["c1", "c2"]);
    assert.deepEqual(focus.assignedMembers, ["c1", "c2"]);
    assert.deepEqual(focus.excludedMembers, []);
});

test("damaged target outscores an identical fresh one (effective wounds drive killRatio)", () => {
    const result = selectFocusTarget({
        preset: "rangedCover",
        round: 3,
        targets: [
            makeTarget({ tokenId: "fresh", wounds: { value: 0, max: 14 }, threatEv: 6 }),
            makeTarget({ tokenId: "hurt", wounds: { value: 10, max: 14 }, threatEv: 6 })
        ],
        members: [
            makeMember("c1", { fresh: 6, hurt: 6 }),
            makeMember("c2", {})
        ]
    });
    assert.equal(result.focus.targetId, "hurt");
    // hurt: effective 4 → killRatio = clamp01(6/6) = 1; fresh: effective
    // 14 → killRatio = clamp01(6/21) = 0.2857.
    assert.equal(result.focus.breakdown.killRatio, 1);
    const fresh = result.candidates.find(entry => entry.targetId === "fresh");
    assert.equal(fresh.breakdown.killRatio, 0.2857);
});

test("unknown wounds: killRatio 0, kill mode forbidden, wounds/margin null", () => {
    const result = selectFocusTarget({
        preset: "rangedCover",
        round: 3,
        targets: [
            makeTarget({
                tokenId: "t1",
                wounds: null,
                statuses: ["pinned"],
                threatEv: 12
            }),
            makeTarget({ tokenId: "t2", wounds: { value: 0, max: 20 }, threatEv: 3 })
        ],
        members: [
            makeMember("c1", { t1: 100, t2: 5 }),
            makeMember("c2", {})
        ]
    });
    const focus = result.focus;
    assert.equal(focus.targetId, "t1");
    assert.equal(focus.mode, "focus");
    assert.equal(focus.woundsKnown, false);
    assert.equal(focus.wounds, null);
    assert.equal(focus.margin, null);
    assert.equal(focus.breakdown.killRatio, 0);
});

test("threat normalization saturates at REF_THREAT", () => {
    const evaluated = evaluateFocusCandidate({
        target: makeNormalized({ threatEv: 30 }),
        members: [],
        targets: [makeNormalized({ threatEv: 30 })],
        round: 3,
        config: resolveConcentrateFireConfig(null, "rangedCover")
    });
    assert.equal(evaluated.threatNorm, 1);
    const half = evaluateFocusCandidate({
        target: makeNormalized({ threatEv: 7.5 }),
        members: [],
        targets: [],
        round: 3,
        config: resolveConcentrateFireConfig(null, "rangedCover")
    });
    assert.equal(half.threatNorm, 0.5);
});

test("vulnerability statuses: pinned/prone/stunned count, others do not", () => {
    for (const status of ["pinned", "prone", "stunned"]) {
        const evaluated = evaluateFocusCandidate({
            target: makeNormalized({ statuses: [status] }),
            members: [],
            targets: [],
            config: resolveConcentrateFireConfig(null, "rangedCover")
        });
        assert.equal(evaluated.vulnerable, 1, status);
    }
    const bleeding = evaluateFocusCandidate({
        target: makeNormalized({ statuses: ["bleeding", "blinded"] }),
        members: [],
        targets: [],
        config: resolveConcentrateFireConfig(null, "rangedCover")
    });
    assert.equal(bleeding.vulnerable, 0);
});

test("reaction spent: boolean and round-record semantics match reactions.js", () => {
    const config = resolveConcentrateFireConfig(null, "rangedCover");
    const spent = record => evaluateFocusCandidate({
        target: makeNormalized({ reactionUsed: record }),
        members: [],
        targets: [],
        round: 3,
        config
    }).reactionSpent;
    assert.equal(spent(true), 1);
    assert.equal(spent(false), 0);
    assert.equal(spent({ round: 3, reason: "dodge" }), 1);
    assert.equal(spent({ round: 2, reason: "dodge" }), 0);
    assert.equal(spent({ reason: "dodge" }), 1);
    assert.equal(spent(null), 0);
    // Unknown live round: a roundless or matching record conservatively counts.
    const noRound = evaluateFocusCandidate({
        target: makeNormalized({ reactionUsed: { round: 3 } }),
        members: [],
        targets: [],
        round: null,
        config
    });
    assert.equal(noRound.reactionSpent, 1);
});

test("friendly-fire sign flips with the preset: assault gang-up vs ranged penalty", () => {
    const build = preset => ({
        preset,
        round: 3,
        targets: [
            makeTarget({
                tokenId: "t1",
                wounds: { value: 2, max: 14 },
                threatEv: 7.5,
                allyEngaged: true
            }),
            makeTarget({ tokenId: "t2", wounds: { value: 2, max: 14 }, threatEv: 7.5 })
        ],
        members: [
            makeMember("c1", { t1: 3, t2: 3 }),
            makeMember("c2", { t1: 3, t2: 3 })
        ]
    });
    const ranged = selectFocusTarget(build("rangedCover"));
    // Identical base scores; t1 is penalized −1.5 → t2 wins for ranged.
    assert.equal(ranged.focus.targetId, "t2");
    const t1Entry = ranged.candidates.find(entry => entry.targetId === "t1");
    assert.equal(t1Entry.breakdown.friendlyFire, 1);
    assert.equal(t1Entry.breakdown.friendlyFireTerm, -1.5);
    assert.equal(t1Entry.focusScore, -0.5833);
    const assault = selectFocusTarget(build("assault"));
    // Assault doctrine reads the engaged ally as a +0.75 gang-up bonus.
    assert.equal(assault.focus.targetId, "t1");
    assert.equal(assault.focus.breakdown.friendlyFireTerm, 0.75);
    assert.equal(assault.focus.focusScore, 1.6667);
});

test("exposure saturates at 1 when other threats overwhelm the residual mass", () => {
    const exposure = computeExposure({ otherThreats: 2.4, memberCount: 2, focusCap: 2, coverRate: 0.5 });
    assert.equal(exposure, 1);
    // Raw helper math keeps full float precision; compare with epsilon.
    assert.ok(Math.abs(computeExposure({ otherThreats: 0.8, memberCount: 3, focusCap: 2, coverRate: 0.5 }) - 0.3) < 1e-9);
    assert.equal(computeExposure({ otherThreats: 0.4, memberCount: 3, focusCap: 2, coverRate: 0.5 }), 0);
});

test("otherThreatContribution: unknown loadout counts as slightly dangerous", () => {
    assert.equal(otherThreatContribution({ threatEv: 0 }), 0.25);
    assert.equal(otherThreatContribution({ threatEv: 15 }), 1);
    assert.equal(otherThreatContribution({ threatEv: 7.5 }), 0.5);
});

test("computeFocusCap: share rounding, minimum two, capable count ceiling", () => {
    assert.equal(computeFocusCap({ capableCount: 5, share: 0.5, otherThreats: 1 }), 3);
    assert.equal(computeFocusCap({ capableCount: 4, share: 0.75, otherThreats: 1 }), 3);
    assert.equal(computeFocusCap({ capableCount: 2, share: 0.5, otherThreats: 1 }), 2);
    assert.equal(computeFocusCap({ capableCount: 1, share: 0.5, otherThreats: 1 }), 1);
    assert.equal(computeFocusCap({ capableCount: 0, share: 0.5, otherThreats: 1 }), 0);
    // Guard: no other threats → the whole capable team concentrates.
    assert.equal(computeFocusCap({ capableCount: 4, share: 0.5, otherThreats: 0 }), 4);
    // Explicit per-plan override wins, clamped to the capable count.
    assert.equal(computeFocusCap({ capableCount: 4, share: 0.5, otherThreats: 1, override: 2 }), 2);
    assert.equal(computeFocusCap({ capableCount: 4, share: 0.5, otherThreats: 1, override: 9 }), 4);
});

test("capacity: hold share 0.5 caps assignment, overflow capable members are excluded", () => {
    const result = selectFocusTarget({
        preset: "hold",
        round: 3,
        targets: [
            makeTarget({ tokenId: "t1", wounds: 30, threatEv: 7.5 }),
            makeTarget({ tokenId: "t2", wounds: 30, threatEv: 3 })
        ],
        members: [
            makeMember("c1", { t1: 5 }),
            makeMember("c2", { t1: 4 }),
            makeMember("c3", { t1: 3 }),
            makeMember("c4", { t1: 2 }),
            makeMember("c5", { t1: 1 })
        ]
    });
    const focus = result.focus;
    assert.equal(focus.targetId, "t1");
    assert.equal(focus.focusCap, 3);
    assert.deepEqual(focus.assignedMembers, ["c1", "c2", "c3"]);
    assert.deepEqual(focus.excludedMembers, ["c4", "c5"]);
    assert.deepEqual(focus.capableMembers, ["c1", "c2", "c3", "c4", "c5"]);
});

test("capacity ordering: LOS-capable member first at equal killEV, combatantId breaks the rest", () => {
    const result = selectFocusTarget({
        preset: "specOps",
        round: 3,
        targets: [
            makeTarget({ tokenId: "t1", wounds: 30, threatEv: 7.5 }),
            makeTarget({ tokenId: "t2", wounds: 30, threatEv: 3 })
        ],
        members: [
            makeMember("m9", { t1: { killEV: 3, losCapable: false } }),
            makeMember("m2", { t1: { killEV: 3, losCapable: true } }),
            makeMember("m5", { t1: { killEV: 3, losCapable: true } }),
            makeMember("m1", { t1: 5 })
        ]
    });
    // m1 leads on killEV; m2/m5 share killEV and LOS → id order; m9 (no
    // LOS) sorts behind them despite the same contribution.
    assert.deepEqual(result.focus.capableMembers, ["m1", "m2", "m5", "m9"]);
});

test("hysteresis: incumbent with fresh lastTarget records resists a near-equal challenger", () => {
    const build = threatEv => ({
        preset: "rangedCover",
        round: 3,
        targets: [
            makeTarget({ tokenId: "t1", wounds: null, threatEv: 6 }),
            makeTarget({ tokenId: "t2", wounds: null, threatEv })
        ],
        members: [
            makeMember("c1", { t1: 5, t2: 5 }, { lastTarget: { tokenId: "t1", round: 2 } }),
            makeMember("c2", {}),
            makeMember("c3", {}),
            makeMember("c4", {})
        ]
    });
    // Base terms: t1 0.6 vs t2 1.0 — the challenger is stronger, but one
    // fresh sticky record adds +0.5 → t1 holds at 1.1 vs 1.0.
    const hold = selectFocusTarget(build(10));
    assert.equal(hold.focus.targetId, "t1");
    assert.equal(hold.focus.breakdown.stickyCount, 1);
    assert.equal(hold.focus.breakdown.hysteresis, 0.5);
    assert.equal(hold.focus.focusScore, 1.1);
    // A stronger challenger (term 1.2 > 1.1) overcomes the incumbency.
    const flip = selectFocusTarget(build(12));
    assert.equal(flip.focus.targetId, "t2");
});

test("hysteresis: stale records and round 1 produce no stickiness", () => {
    const build = (round, recordRound) => ({
        preset: "rangedCover",
        round,
        targets: [
            makeTarget({ tokenId: "t1", wounds: null, threatEv: 6 }),
            makeTarget({ tokenId: "t2", wounds: null, threatEv: 10 })
        ],
        members: [
            makeMember("c1", { t1: 5, t2: 5 }, { lastTarget: { tokenId: "t1", round: recordRound } }),
            makeMember("c2", {}),
            makeMember("c3", {}),
            makeMember("c4", {})
        ]
    });
    // Round 4 vs record round 2: older than round − 1 → stale.
    assert.equal(selectFocusTarget(build(4, 2)).focus.targetId, "t2");
    // Round 3 vs record round 2: still fresh (round − 1 boundary).
    assert.equal(selectFocusTarget(build(3, 2)).focus.targetId, "t1");
    // Round 1 has no hysteresis even with a fresh record.
    assert.equal(selectFocusTarget(build(1, 1)).focus.targetId, "t2");
});

test("hysteresis: sticky count caps at STICKY_CAP × W_STICKY and explicit counts win", () => {
    const evaluated = evaluateFocusCandidate({
        target: makeNormalized({ stickyCount: 5 }),
        members: [],
        targets: [],
        round: 3,
        config: resolveConcentrateFireConfig(null, "rangedCover")
    });
    assert.equal(evaluated.stickyCount, 5);
    assert.equal(evaluated.hysteresis, 1.5);
    assert.equal(focusStickyCount(makeNormalized({ stickyCount: 2 }), [], 1), 2);
});

test("excludeTargetIds: interdicted targets never become focus candidates", () => {
    // Three candidates: excluding the top-scored t1 leaves a real scored
    // pass between t2 and t3 (a single survivor would be the trivial case).
    const build = excludeTargetIds => ({
        preset: "rangedCover",
        round: 3,
        context: { excludeTargetIds },
        targets: [
            makeTarget({
                tokenId: "t1",
                wounds: { value: 2, max: 14 },
                statuses: ["pinned"],
                reactionUsed: true,
                threatEv: 12
            }),
            makeTarget({ tokenId: "t2", wounds: { value: 0, max: 20 }, threatEv: 6 }),
            makeTarget({ tokenId: "t3", wounds: { value: 0, max: 20 }, threatEv: 4 })
        ],
        members: [
            makeMember("c1", { t1: 4, t2: 4, t3: 4 }),
            makeMember("c2", { t1: 3 }),
            makeMember("c3", { t2: 5, t3: 5 })
        ]
    });
    assert.equal(selectFocusTarget(build([])).focus.targetId, "t1");
    const result = selectFocusTarget(build(["t1"]));
    assert.equal(result.focus.targetId, "t2");
    const empty = selectFocusTarget(build(["t1", "t2", "t3"]));
    assert.equal(empty.focus, null);
    assert.equal(empty.reason, FOCUS_REASONS.noCandidates);
});

test("excludeTargetIds: exclusion by tokenUuid and per-plan context.focus list", () => {
    const input = {
        preset: "rangedCover",
        round: 3,
        context: { focus: { excludeTargetIds: ["Scene.s1.Token.t1"] } },
        targets: [
            makeTarget({
                tokenId: "t1",
                tokenUuid: "Scene.s1.Token.t1",
                wounds: { value: 2, max: 14 },
                statuses: ["pinned"],
                threatEv: 12
            }),
            makeTarget({ tokenId: "t2", wounds: { value: 0, max: 20 }, threatEv: 6 }),
            makeTarget({ tokenId: "t3", wounds: { value: 0, max: 20 }, threatEv: 4 })
        ],
        members: [
            makeMember("c1", { t1: 4, t2: 4, t3: 4 }),
            makeMember("c2", { t1: 3 }),
            makeMember("c3", { t2: 5, t3: 5 })
        ]
    };
    assert.equal(selectFocusTarget(input).focus.targetId, "t2");
});

test("excluded targets still count as threats in the exposure guard", () => {
    const result = selectFocusTarget({
        preset: "rangedCover",
        round: 3,
        context: { excludeTargetIds: ["t3"] },
        targets: [
            makeTarget({ tokenId: "t1", wounds: 30, threatEv: 6 }),
            makeTarget({ tokenId: "t2", wounds: 30, threatEv: 3 }),
            makeTarget({ tokenId: "t3", wounds: 30, threatEv: 7.5 })
        ],
        members: [
            makeMember("c1", { t1: 5, t2: 5 }),
            makeMember("c2", {}),
            makeMember("c3", {})
        ]
    });
    // otherThreats(t1) = threatNorm(t2) 0.2 + threatNorm(t3) 0.5 = 0.7
    // even though t3 was excluded from candidacy.
    assert.equal(result.focus.targetId, "t1");
    assert.equal(result.focus.breakdown.otherThreats, 0.7);
});

test("trivial case: one candidate skips the scored pass with single-target", () => {
    const result = selectFocusTarget({
        preset: "rangedCover",
        round: 3,
        targets: [makeTarget({ tokenId: "t1", wounds: 30, threatEv: 12 })],
        members: [makeMember("c1", { t1: 4 })]
    });
    assert.equal(result.focus, null);
    assert.equal(result.reason, FOCUS_REASONS.singleTarget);
    assert.deepEqual(result.candidates, []);
});

test("kill mode: single killable candidate yields the legacy-shaped descriptor", () => {
    const result = selectFocusTarget({
        preset: "rangedCover",
        round: 3,
        targets: [makeTarget({ tokenId: "t1", wounds: { value: 6, max: 14 }, threatEv: 12 })],
        members: [
            makeMember("c1", { t1: { killEV: 7, losCapable: true } }),
            makeMember("c2", { t1: 3 })
        ]
    });
    const focus = result.focus;
    assert.equal(result.reason, null);
    assert.equal(focus.mode, "kill");
    // effective wounds = 14 − 6 = 8, killEV 10 ≥ 8 → guaranteed kill.
    assert.equal(focus.wounds, 8);
    assert.equal(focus.killEV, 10);
    assert.equal(focus.margin, 2);
    assert.equal(focus.focusCap, 2);
    assert.deepEqual(focus.capableMembers, ["c1", "c2"]);
    assert.deepEqual(focus.assignedMembers, ["c1", "c2"]);
    assert.deepEqual(focus.excludedMembers, []);
    // The trivial case never runs the scored pass.
    assert.equal(focus.focusScore, null);
    assert.equal(focus.breakdown, null);
    assert.equal(focus.runnerUp, null);
});

test("kill mode: multi-candidate killable winner keeps the scored breakdown", () => {
    const input = scenarioA();
    input.targets[0].wounds = { value: 9, max: 14 };
    const result = selectFocusTarget(input);
    // effective 5, killEV 7 ≥ 5 → kill mode, but the scored pass ran.
    // killRatio = 7/(5×1.5) = 0.9333 → total 1.8667 + 1.2 + 1 + 0.75.
    assert.equal(result.focus.mode, "kill");
    assert.equal(result.focus.focusScore, 4.8167);
    assert.ok(result.focus.breakdown);
    assert.equal(result.focus.focusCap, 2);
    assert.deepEqual(result.focus.excludedMembers, []);
    assert.deepEqual(result.focus.runnerUp, { targetId: "t2", focusScore: 0.9 });
});

test("kill mode: targets at or below zero effective health are finishable", () => {
    const atZero = selectFocusTarget({
        round: 3,
        targets: [makeTarget({ tokenId: "t1", wounds: { value: 14, max: 14 }, threatEv: 5 })],
        members: [makeMember("c1", { t1: 2 })]
    });
    assert.equal(atZero.focus.mode, "kill");
    const negative = selectFocusTarget({
        round: 3,
        targets: [makeTarget({ tokenId: "t1", wounds: { value: 16, max: 14 }, threatEv: 5 })],
        members: [makeMember("c1", { t1: 2 })]
    });
    assert.equal(negative.focus.mode, "kill");
    // ...but never without real damage output.
    const harmless = selectFocusTarget({
        round: 3,
        targets: [makeTarget({ tokenId: "t1", wounds: { value: 14, max: 14 }, threatEv: 5 })],
        members: [makeMember("c1", {})]
    });
    assert.equal(harmless.focus, null);
    assert.equal(harmless.reason, FOCUS_REASONS.singleTarget);
});

test("explicit objective and disable flags suppress the focus pass", () => {
    const input = scenarioA();
    input.context = { objective: { targetId: "gm-ordered" } };
    assert.equal(selectFocusTarget(input).reason, FOCUS_REASONS.explicitObjective);
    const disabled = scenarioA();
    disabled.context = { convergence: false };
    assert.equal(selectFocusTarget(disabled).reason, FOCUS_REASONS.disabled);
    const focusOff = scenarioA();
    focusOff.context = { focus: false };
    assert.equal(selectFocusTarget(focusOff).reason, FOCUS_REASONS.disabled);
});

test("below-threshold: a focus score of zero or less selects nothing", () => {
    const result = selectFocusTarget({
        preset: "rangedCover",
        round: 3,
        targets: [
            makeTarget({ tokenId: "t1", wounds: null, threatEv: 0, allyEngaged: true }),
            makeTarget({ tokenId: "t2", wounds: null, threatEv: 0, allyEngaged: true })
        ],
        members: [
            makeMember("c1", { t1: 5, t2: 5 }),
            makeMember("c2", {}),
            makeMember("c3", {})
        ]
    });
    // killRatio 0 (unknown wounds), threat 0, vuln/react 0, −1.5 ff,
    // exposure 0 → total −1.5.
    assert.equal(result.focus, null);
    assert.equal(result.reason, FOCUS_REASONS.belowThreshold);
    assert.equal(result.candidates.length, 2);
    assert.equal(result.candidates[0].focusScore, -1.5);
});

test("no-capable-members: an unengageable winner never produces a degenerate focus", () => {
    const result = selectFocusTarget({
        preset: "rangedCover",
        round: 3,
        targets: [
            makeTarget({ tokenId: "t1", wounds: null, statuses: ["pinned"], threatEv: 15 }),
            makeTarget({ tokenId: "t2", wounds: null, threatEv: 3 })
        ],
        members: [makeMember("c1", {}), makeMember("c2", {})]
    });
    assert.equal(result.focus, null);
    assert.equal(result.reason, FOCUS_REASONS.noCapableMembers);
});

test("no-candidates: empty and junk-only target lists select nothing", () => {
    const base = { preset: "rangedCover", round: 3, members: [makeMember("c1", {})] };
    assert.equal(selectFocusTarget({ ...base, targets: [] }).reason, FOCUS_REASONS.noCandidates);
    assert.equal(selectFocusTarget({ ...base, targets: [null, {}, { tokenId: null }] }).reason,
        FOCUS_REASONS.noCandidates);
});

test("deterministic tie-break: larger killEV wins equal scores, then the smaller target id", () => {
    const build = (aId, bId, aEV, bEV) => ({
        preset: "rangedCover",
        round: 3,
        targets: [
            makeTarget({ tokenId: aId, wounds: { value: 0, max: 10 }, threatEv: 7.5 }),
            makeTarget({ tokenId: bId, wounds: { value: 0, max: 10 }, threatEv: 7.5 })
        ],
        members: [makeMember("c1", { [aId]: aEV, [bId]: bEV })]
    });
    // Both killRatios saturate at 1 (effective 10, overkill needs 15) —
    // equal scores resolve on the larger killEV.
    assert.equal(selectFocusTarget(build("taa", "tbb", 20, 30)).focus.targetId, "tbb");
    assert.equal(selectFocusTarget(build("taa", "tbb", 30, 20)).focus.targetId, "taa");
    // Equal killEV as well → the lexicographically smaller id wins.
    assert.equal(selectFocusTarget(build("tbb", "taa", 20, 20)).focus.targetId, "taa");
});

test("anti laying-down rule: a live heavy gunner outscores a pinned helpless victim", () => {
    const result = selectFocusTarget({
        preset: "rangedCover",
        round: 3,
        targets: [
            makeTarget({
                tokenId: "victim",
                wounds: { value: 0, max: 10 },
                statuses: ["pinned"],
                threatEv: 0
            }),
            makeTarget({ tokenId: "gunner", wounds: { value: 0, max: 14 }, threatEv: 15 })
        ],
        members: [
            makeMember("c1", { victim: 6, gunner: 6 }),
            makeMember("c2", {}),
            makeMember("c3", {})
        ]
    });
    // victim: killRatio 6/15 = 0.4 → 0.8 + vuln 1.0 + threat 0 = 1.8;
    // gunner: killRatio 6/21 ≈ 0.2857 → 0.5714 + threat 1×1.5 = 2.0714 —
    // the threat term outweighs the vulnerability of a harmless victim.
    assert.equal(result.focus.targetId, "gunner");
    assert.equal(result.focus.focusScore, 2.0714);
    const victim = result.candidates.find(entry => entry.targetId === "victim");
    assert.equal(victim.focusScore, 1.8);
    // But a genuinely finishable victim (low effective wounds) IS a valid
    // concentrate-fire target — saturation reverses the verdict.
    const finishable = selectFocusTarget({
        preset: "rangedCover",
        round: 3,
        targets: [
            makeTarget({
                tokenId: "victim",
                wounds: { value: 8, max: 10 },
                statuses: ["pinned"],
                threatEv: 0
            }),
            makeTarget({ tokenId: "gunner", wounds: { value: 0, max: 14 }, threatEv: 15 })
        ],
        members: [
            makeMember("c1", { victim: 6, gunner: 6 }),
            makeMember("c2", {}),
            makeMember("c3", {})
        ]
    });
    assert.equal(finishable.focus.targetId, "victim");
});

test("config plumbing: per-plan and explicit coefficient overrides apply", () => {
    const input = scenarioA();
    input.context = { focus: { W_VULN: 0 } };
    const noVuln = selectFocusTarget(input);
    // Removing the vuln point drops the canonical total by exactly 1.
    assert.equal(noVuln.focus.focusScore, 2.7278);
    const explicit = scenarioA();
    explicit.config = { W_REACT: 0 };
    assert.equal(selectFocusTarget(explicit).focus.focusScore, 2.9778);
});

test("diagnostics carry the resolved coefficients and the reason", () => {
    const result = selectFocusTarget(scenarioA());
    assert.equal(result.diagnostics.preset, "rangedCover");
    assert.equal(result.diagnostics.round, 3);
    assert.equal(result.diagnostics.memberCount, 3);
    assert.equal(result.diagnostics.coefficients.W_KILL, 2.0);
    assert.equal(result.diagnostics.coefficients.focusCapShare, 0.75);
    assert.deepEqual(result.diagnostics.coefficients.vulnerableStatuses, ["pinned", "prone", "stunned"]);
    assert.equal(result.diagnostics.reason, null);
    assert.equal(result.candidates.length, 2);
    // Deterministic ordering: score descending.
    assert.equal(result.candidates[0].targetId, "t1");
    assert.equal(result.candidates[1].targetId, "t2");
});

test("empty results are JSON-serializable and stable across runs", () => {
    const first = selectFocusTarget(scenarioA());
    const second = selectFocusTarget(scenarioA());
    assert.deepEqual(first, second);
    assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
    assert.ok(FOCUS_MODES.includes(first.focus.mode));
});

test("kill descriptor JSON round-trip preserves the legacy-compatible shape", () => {
    const result = selectFocusTarget({
        round: 3,
        targets: [makeTarget({ tokenId: "t1", wounds: { value: 6, max: 14 }, threatEv: 12 })],
        members: [makeMember("c1", { t1: 8 })]
    });
    const copy = JSON.parse(JSON.stringify(result));
    assert.deepEqual(copy, result);
    for (const key of ["targetId", "targetUuid", "killEV", "wounds", "margin", "capableMembers"]) {
        assert.ok(key in copy.focus, key);
    }
});
