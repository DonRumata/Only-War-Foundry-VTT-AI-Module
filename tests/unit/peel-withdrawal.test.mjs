/**
 * Hand-computed unit tests for the pure peel-withdrawal core (issue #89).
 * The fixtures intentionally use scene-unit coordinates with a 1:1 grid so
 * every distance, trigger threshold, route cost and free-attack margin can
 * be checked without a Foundry scene or hidden randomness.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    PEEL_DEFAULT_THRESHOLDS,
    PEEL_REJECTIONS,
    PEEL_TRIGGERS,
    PEEL_WITHDRAWAL_NAME,
    computeThreatCentroid,
    detectDisengageCapability,
    evaluatePeelWithdrawal,
    selectPeelWithdrawal
} from "../../scripts/tactics/peel-withdrawal.js";

const RATES = Object.freeze({ half: 2, full: 4, charge: 6, run: 6 });

/** Round a coordinate the same way the breakdown does. */
function round4(value) {
    return Math.round(value * 1e4) / 1e4;
}

/** Stable coordinate key for the fake navigation oracle. */
function pointKey(x, y) {
    return `${round4(x)},${round4(y)}`;
}

/** Deterministic read-only navigation fake matching the service contract. */
function makeNavigation({
    invalidEndpoints = {},
    failingRoutes = {},
    routeCustomizer = null
} = {}) {
    return {
        validateEndpoint(token, destination) {
            const reason = invalidEndpoints[pointKey(destination.x, destination.y)];
            if (reason) return { status: "failed", valid: false, reason };
            return { status: "ok", valid: true, endpoint: { x: destination.x, y: destination.y } };
        },
        planRoute(token, destination) {
            const key = pointKey(destination.x, destination.y);
            const from = token?.position ?? { x: 10, y: 0 };
            if (failingRoutes[key]) {
                return {
                    status: "failed",
                    exact: false,
                    reason: failingRoutes[key],
                    cost: null,
                    waypoints: null
                };
            }
            let waypoints = [
                { x: from.x, y: from.y },
                { x: destination.x, y: destination.y }
            ];
            if (routeCustomizer) waypoints = routeCustomizer(token, destination, waypoints) ?? waypoints;
            return {
                status: "ok",
                exact: true,
                reason: null,
                cost: Math.hypot(destination.x - from.x, destination.y - from.y),
                waypoints
            };
        }
    };
}

/** Base danger field: hot line at the team, cool regroup fan. */
function defaultDanger(point) {
    if (point.x >= 14) return 0.1;
    if (point.x >= 10) return 0.7;
    return 1;
}

/** Low-but-nonzero danger field used to isolate continuation inputs. */
function continuationDanger(centerDanger) {
    return point => {
        if (point.x >= 14) return 0.1;
        if (point.x >= 10) return centerDanger;
        return 1;
    };
}

/** Plain member fixture; every field consumed by the pure core is explicit. */
function makeMember(id, x, y, extra = {}) {
    return {
        combatantId: id,
        position: { x, y },
        movement: { ...RATES },
        capabilities: {
            direct: true,
            suppression: false,
            overwatch: true,
            melee: false,
            ammo: true,
            los: true
        },
        ...extra
    };
}

/** Default engaged withdrawer and suppression-capable cover. */
function defaultMembers() {
    return [
        makeMember("m1", 10, 0, {
            engagers: ["e1"],
            capabilities: {
                direct: true,
                suppression: false,
                overwatch: true,
                melee: false,
                ammo: true,
                los: true
            }
        }),
        makeMember("m2", 10.5, 0, {
            capabilities: {
                direct: true,
                suppression: true,
                overwatch: true,
                melee: false,
                ammo: true,
                los: true
            }
        })
    ];
}

/** Default pair with the leader explicitly out of melee. */
function unengagedDefaultMembers() {
    const members = defaultMembers();
    members[0] = { ...members[0], engagers: [], engaged: false, engagedAtStart: false };
    return members;
}

/** Threat fixture with exact hand-computed melee free-attack values. */
function makeThreat(id = "e1", x = 0, y = 0, extra = {}) {
    return {
        tokenUuid: id,
        x,
        y,
        canAttack: true,
        meleeEV: 15,
        hitChance: 0.5,
        meleeReach: 2,
        ...extra
    };
}

/** Whether an own-property override was supplied (null is meaningful). */
function has(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

/** Base selector input; overrides are shallow and intentionally explicit. */
function makeInput(overrides = {}) {
    return {
        leaderId: "m1",
        rates: { ...RATES },
        members: has(overrides, "members") ? overrides.members : defaultMembers(),
        targets: has(overrides, "targets") ? overrides.targets : [makeThreat()],
        moraleInfo: has(overrides, "moraleInfo") ? overrides.moraleInfo : { tier: "desperate" },
        navigation: has(overrides, "navigation") ? overrides.navigation : makeNavigation(),
        dangerAt: has(overrides, "dangerAt") ? overrides.dangerAt : defaultDanger,
        ...Object.fromEntries(Object.entries(overrides)
            .filter(([key]) => !["members", "targets", "moraleInfo", "navigation", "dangerAt"].includes(key)))
    };
}

/** Cost row of one member or a test failure with a useful diff. */
function costOf(result, combatantId) {
    const cost = result.descriptor?.breakdown.costs.find(entry => entry.combatantId === combatantId)
        ?? result.breakdown?.costs?.find(entry => entry.combatantId === combatantId);
    assert.ok(cost, `missing cost row for ${combatantId}`);
    return cost;
}

/* ---------------------------------------------------------------------- */
/* Trigger matrix and stateless continuation                               */
/* ---------------------------------------------------------------------- */

test("trigger matrix: morale, exact loss boundary, recent losses and close threat", () => {
    const desperate = evaluatePeelWithdrawal(makeInput());
    assert.equal(desperate.status, "ok");
    assert.equal(desperate.reason, PEEL_TRIGGERS.moraleDesperate);
    assert.equal(desperate.descriptor.objective.trigger.value, "desperate");
    assert.equal(desperate.descriptor.objective.trigger.threshold, "desperate");

    const exactLosses = evaluatePeelWithdrawal(makeInput({
        moraleInfo: { tier: "pressured" },
        casualties: { total: 34, recent: 0, initialStrength: 100 }
    }));
    assert.equal(exactLosses.status, "ok");
    assert.equal(exactLosses.reason, PEEL_TRIGGERS.losses);
    assert.equal(exactLosses.descriptor.breakdown.triggerChecks.losses.ratio, 0.34);
    assert.equal(exactLosses.descriptor.breakdown.triggerChecks.losses.threshold, 0.34);
    assert.equal(exactLosses.descriptor.objective.trigger.kind, "losses");

    const recentLosses = evaluatePeelWithdrawal(makeInput({
        moraleInfo: { tier: "pressured" },
        casualties: { total: 0, recent: 2, initialStrength: 10 }
    }));
    assert.equal(recentLosses.status, "ok");
    assert.equal(recentLosses.reason, PEEL_TRIGGERS.losses);
    assert.equal(recentLosses.descriptor.breakdown.triggerChecks.losses.casualtiesRecent, 2);

    // Two members require ceil(1.5 × 2) = 3 weighted close enemies.  Two
    // direct contacts (1 each) plus two half-weight memory contacts exactly
    // meet the boundary; the distant engager at x=0 does not count by range.
    const closeTargets = [
        makeThreat("e1", 0, 0),
        makeThreat("e2", 5, 0),
        makeThreat("e3", 6, 0),
        makeThreat("e4", 7, 0, { source: "last-known", weight: 0.5 }),
        makeThreat("e5", 7.5, 0, { source: "last-known", weight: 0.5 })
    ];
    const close = evaluatePeelWithdrawal(makeInput({
        moraleInfo: { tier: "pressured" },
        members: unengagedDefaultMembers(),
        targets: closeTargets,
        threatCentroid: { x: 0, y: 0, sourceCount: 5, weight: 4 }
    }));
    assert.equal(close.status, "ok");
    assert.equal(close.reason, PEEL_TRIGGERS.closeThreat);
    const closeCheck = close.descriptor.breakdown.triggerChecks.closeThreat;
    assert.equal(closeCheck.closeEnemies, 3);
    assert.equal(closeCheck.required, 3);
    assert.equal(closeCheck.danger, 0.7);
    assert.equal(closeCheck.dangerThreshold, 0.65);
});

test("trigger matrix: close-threat boundaries stay off and no-trigger is explainable", () => {
    const closeTargets = [
        makeThreat("e1", 0, 0),
        makeThreat("e2", 5, 0),
        makeThreat("e3", 6, 0),
        makeThreat("e4", 7, 0, { source: "last-known", weight: 0.5 })
    ];
    // 1 + 1 + 0.5 = 2.5 weighted close enemies, below ceil(1.5 × 2) = 3.
    const underCount = evaluatePeelWithdrawal(makeInput({
        moraleInfo: { tier: "pressured" },
        members: unengagedDefaultMembers(),
        targets: closeTargets,
        threatCentroid: { x: 0, y: 0, sourceCount: 4, weight: 3.5 },
        dangerAt: continuationDanger(0.5)
    }));
    assert.equal(underCount.status, "ok");
    assert.equal(underCount.reason, PEEL_TRIGGERS.continuation);
    assert.equal(underCount.descriptor.breakdown.triggerChecks.closeThreat.active, false);
    assert.equal(underCount.descriptor.breakdown.triggerChecks.closeThreat.closeEnemies, 2.5);

    // Count is sufficient in this fixture, but danger 0.64 is below the
    // 0.65 enter threshold; the weaker 0.45 exit threshold still continues.
    const underDanger = evaluatePeelWithdrawal(makeInput({
        moraleInfo: { tier: "pressured" },
        members: unengagedDefaultMembers(),
        targets: [
            makeThreat("e1", 0, 0),
            makeThreat("e2", 5, 0),
            makeThreat("e3", 6, 0),
            makeThreat("e4", 7, 0)
        ],
        threatCentroid: { x: 0, y: 0, sourceCount: 4, weight: 4 },
        dangerAt: continuationDanger(0.64)
    }));
    assert.equal(underDanger.status, "ok");
    assert.equal(underDanger.reason, PEEL_TRIGGERS.continuation);
    assert.equal(underDanger.descriptor.breakdown.triggerChecks.closeThreat.active, false);
    assert.equal(underDanger.descriptor.breakdown.triggerChecks.closeThreat.danger, 0.64);

    // Confident morale, no losses, one distant contact and center danger
    // below the exit threshold: there is neither a primary trigger nor a
    // stateless continuation condition.
    const off = evaluatePeelWithdrawal(makeInput({
        moraleInfo: { tier: "confident" },
        dangerAt: continuationDanger(0.2)
    }));
    assert.equal(off.status, "rejected");
    assert.equal(off.reason, PEEL_REJECTIONS.noTrigger);
    assert.deepEqual(off.rejections, ["no-trigger"]);
    assert.equal(selectPeelWithdrawal(makeInput({
        moraleInfo: { tier: "confident" },
        dangerAt: continuationDanger(0.2)
    })), null);
});

test("stateless continuation reads weak danger, enemy reach and existing commitments", () => {
    // 0.5 is below close-threat enter (0.65) but exactly above the 0.45
    // continuation exit floor.  No latch or peelActive flag is involved.
    const weakDanger = evaluatePeelWithdrawal(makeInput({
        moraleInfo: { tier: "pressured" },
        dangerAt: continuationDanger(0.5)
    }));
    assert.equal(weakDanger.status, "ok");
    assert.equal(weakDanger.reason, PEEL_TRIGGERS.continuation);
    assert.deepEqual(
        weakDanger.descriptor.breakdown.continuation.weakConditions,
        { danger: true, enemyReach: false, casualties: false, commitment: false }
    );
    assert.equal(weakDanger.descriptor.objective.hysteresis.mode, "l2-morale/commitment/stateless");
    assert.equal("peelActive" in weakDanger.descriptor, false);
    assert.equal("peelActive" in weakDanger.descriptor.breakdown, false);

    // A close but unengaged enemy inside melee reach is an independent weak
    // continuation condition even when center danger is calm.
    const reach = evaluatePeelWithdrawal(makeInput({
        moraleInfo: { tier: "pressured" },
        targets: [makeThreat("e1", 9, 1.5)],
        threatCentroid: { x: 0, y: 0, sourceCount: 1, weight: 1 },
        dangerAt: continuationDanger(0.3)
    }));
    assert.equal(reach.status, "ok");
    assert.equal(reach.reason, PEEL_TRIGGERS.continuation);
    assert.equal(reach.descriptor.breakdown.continuation.weakConditions.enemyReach, true);
    assert.equal(reach.descriptor.breakdown.continuation.weakConditions.danger, false);

    // An existing L1 withdrawal commitment to the same regroup area is
    // sufficient input for continuation.  The record is only read; the pure
    // core neither creates nor updates multi-round peel state.
    const committedMembers = defaultMembers();
    committedMembers[0].withdrawalCommitment = {
        status: "active",
        objective: { type: "peel-withdrawal", regroupPoint: { x: 16, y: 0 } },
        steps: [{ type: "move", input: { mode: "withdraw", to: { x: 16, y: 0 } } }]
    };
    const committed = evaluatePeelWithdrawal(makeInput({
        moraleInfo: { tier: "pressured" },
        members: committedMembers,
        dangerAt: continuationDanger(0.3)
    }));
    assert.equal(committed.status, "ok");
    assert.equal(committed.reason, PEEL_TRIGGERS.continuation);
    assert.equal(committed.descriptor.breakdown.continuation.weakConditions.commitment, true);
});

/* ---------------------------------------------------------------------- */
/* Roles, pinned/stunned and uncovered degradation                         */
/* ---------------------------------------------------------------------- */

test("role allocation is object-form, deterministic and exposes stranded members", () => {
    const members = [
        ...defaultMembers(),
        makeMember("m3", 10.2, 0, { stunned: true }),
        makeMember("m4", 10.4, 0, { alreadyActed: true }),
        makeMember("m5", 9.8, 0, { pinned: true }),
        makeMember("m6", 10.6, 0, { unavailable: true })
    ];
    const result = evaluatePeelWithdrawal(makeInput({ members }));
    assert.equal(result.status, "ok");
    assert.deepEqual(result.descriptor.assignments, {
        m1: { task: "regroup", role: "withdraw" },
        m2: { task: "support", role: "cover" },
        m5: { task: "regroup", role: "withdraw" }
    });
    const stranded = Object.fromEntries(result.descriptor.breakdown.stranded
        .map(entry => [entry.combatantId, entry.reason]));
    assert.equal(stranded.m3, "stranded-stunned");
    assert.equal(stranded.m4, "stranded-already-acted");
    assert.equal(stranded.m6, "stranded-unavailable");
    assert.equal(costOf(result, "m5").pinned, true);
    assert.equal(costOf(result, "m5").mode, "withdraw");
});

test("pinned in melee is ordinary engaged, while a closing pinned route is stranded", () => {
    const pinnedEngagedMembers = defaultMembers();
    pinnedEngagedMembers[0].pinned = true;
    const pinnedEngaged = evaluatePeelWithdrawal(makeInput({ members: pinnedEngagedMembers }));
    assert.equal(pinnedEngaged.status, "ok");
    assert.equal(pinnedEngaged.descriptor.assignments.m1.role, "withdraw");
    assert.equal(costOf(pinnedEngaged, "m1").pinned, false);
    assert.equal(pinnedEngaged.descriptor.breakdown.stranded
        .some(entry => entry.reason === "stranded-pinned-no-safe-exit"), false);

    const members = [
        ...defaultMembers(),
        makeMember("m3", 9.8, 0, { pinned: true })
    ];
    const navigation = makeNavigation({
        routeCustomizer: (token, destination, waypoints) => {
            if (token?.combatantId !== "m3") return waypoints;
            return [waypoints[0], { x: 5, y: 0 }, waypoints.at(-1)];
        }
    });
    const unsafePinned = evaluatePeelWithdrawal(makeInput({ members, navigation }));
    assert.equal(unsafePinned.status, "ok");
    assert.equal(unsafePinned.descriptor.assignments.m3, undefined);
    assert.deepEqual(unsafePinned.descriptor.breakdown.stranded.find(entry => entry.combatantId === "m3"), {
        combatantId: "m3",
        reason: "stranded-pinned-no-safe-exit"
    });
});

test("all-engaged peel is rejected by default and uncovered only by explicit desperate opt-in", () => {
    const members = [
        makeMember("m1", 10, 0, { engagers: ["e1"] }),
        makeMember("m2", 10.5, 0, {
            engaged: true,
            capabilities: {
                direct: true,
                suppression: true,
                overwatch: true,
                melee: false,
                ammo: true,
                los: true
            }
        })
    ];
    const rejected = evaluatePeelWithdrawal(makeInput({ members }));
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.reason, "no-cover-all-engaged");
    assert.equal(selectPeelWithdrawal(makeInput({ members })), null);

    const uncovered = evaluatePeelWithdrawal(makeInput({
        members,
        thresholds: { peelAllowUncovered: true }
    }));
    assert.equal(uncovered.status, "ok");
    assert.equal(uncovered.descriptor.cover.mode, "none");
    assert.equal(uncovered.descriptor.cover.reason, "uncovered-desperate");
    assert.deepEqual(uncovered.descriptor.assignments, {
        m1: { task: "regroup", role: "withdraw" },
        m2: { task: "regroup", role: "withdraw" }
    });
    // No-cover cost: hit 0.5 × min(1, 15/15) × 1.15 = 0.575;
    // margin (0.7 + 0.5 − 0.1) − 0.575 = 0.525.
    assert.equal(costOf(uncovered, "m1").freeAttackRisk, 0.575);
    assert.equal(costOf(uncovered, "m1").margin, 0.525);
});

/* ---------------------------------------------------------------------- */
/* Explicit free-attack cost and disengage branches                        */
/* ---------------------------------------------------------------------- */

test("free-attack cost model hand-computes suppression, direct, overwatch and margin failure", () => {
    const suppression = evaluatePeelWithdrawal(makeInput());
    // hit 0.5 × EV 15/15 = 0.5 pressure; suppression 0.6 ⇒ risk 0.3;
    // stay 0.7 + 0.5, endpoint 0.1 ⇒ margin 1.2 − 0.1 − 0.3 = 0.8.
    assert.equal(costOf(suppression, "m1").coverMode, "suppression");
    assert.equal(costOf(suppression, "m1").basePressure, 0.5);
    assert.equal(costOf(suppression, "m1").freeAttackRisk, 0.3);
    assert.equal(costOf(suppression, "m1").stayRisk, 1.2);
    assert.equal(costOf(suppression, "m1").margin, 0.8);
    assert.equal(costOf(suppression, "m1").mode, "withdraw");

    const directMembers = defaultMembers();
    directMembers[1].capabilities = {
        direct: true,
        suppression: false,
        overwatch: true,
        melee: false,
        ammo: true,
        los: true
    };
    const direct = evaluatePeelWithdrawal(makeInput({ members: directMembers }));
    assert.equal(direct.descriptor.cover.mode, "direct");
    assert.equal(costOf(direct, "m1").coverMultiplier, 1);
    assert.equal(costOf(direct, "m1").freeAttackRisk, 0.5);
    assert.equal(costOf(direct, "m1").margin, 0.6);

    const overwatchMembers = defaultMembers();
    overwatchMembers[1].capabilities = {
        direct: false,
        suppression: false,
        overwatch: true,
        melee: false,
        ammo: true,
        los: true
    };
    const overwatch = evaluatePeelWithdrawal(makeInput({ members: overwatchMembers }));
    assert.equal(overwatch.descriptor.cover.mode, "overwatch");
    assert.equal(costOf(overwatch, "m1").coverMultiplier, 0.8);
    assert.equal(costOf(overwatch, "m1").freeAttackRisk, 0.4);
    assert.equal(costOf(overwatch, "m1").margin, 0.7);

    // Endpoint danger 0.35, center/self danger 0.4, direct cover:
    // margin (0.4 + 0.5 − 0.35) − 0.5 = 0.05, below the 0.15 threshold.
    const marginDanger = point => {
        if (point.x >= 14) return 0.35;
        if (point.x >= 10) return 0.4;
        return 1;
    };
    const marginFailure = evaluatePeelWithdrawal(makeInput({
        members: directMembers,
        dangerAt: marginDanger
    }));
    assert.equal(marginFailure.status, "rejected");
    assert.equal(marginFailure.reason, "no-withdraw-capable");
    const failedCost = marginFailure.breakdown.costs.find(entry => entry.combatantId === "m1");
    assert.equal(failedCost.margin, 0.05);
    assert.equal(failedCost.mode, "fight-in-place");
    assert.equal(failedCost.decisionReason, "free-attack-margin");
});

test("disengage is structural capability-only; ordinary API v1 fallback always pays risk", () => {
    assert.equal(detectDisengageCapability({ capabilities: { disengage: true } }).available, true);
    assert.equal(detectDisengageCapability([{ id: "disengage", available: true }]).available, true);
    assert.equal(detectDisengageCapability({ movement: { disengage: { halves: 2 } } }).available, true);
    assert.equal(detectDisengageCapability([{ id: "standard", attackType: "standard" }]).available, false);

    const fallback = evaluatePeelWithdrawal(makeInput());
    assert.equal(costOf(fallback, "m1").disengageAvailable, false);
    assert.equal(costOf(fallback, "m1").mode, "withdraw");
    assert.ok(costOf(fallback, "m1").freeAttackRisk > 0);
    assert.equal(costOf(fallback, "m1").actionCost, null);

    const capableMembers = defaultMembers();
    capableMembers[0].capabilities = {
        ...capableMembers[0].capabilities,
        disengage: true
    };
    const capable = evaluatePeelWithdrawal(makeInput({ members: capableMembers }));
    const cost = costOf(capable, "m1");
    assert.equal(cost.disengageAvailable, true);
    assert.equal(cost.mode, "disengage");
    assert.equal(cost.freeAttackRisk, 0);
    assert.equal(cost.margin, 1.1);
    assert.deepEqual(cost.actionCost, { halves: 2 });
    assert.equal(cost.movementCap, "half");
    assert.deepEqual(capable.descriptor.breakdown.disengage.capableMembers, ["m1"]);
});

/* ---------------------------------------------------------------------- */
/* Regroup generation, validation, rejection evidence and scoring          */
/* ---------------------------------------------------------------------- */

test("regroup candidates expose endpoint, route, enemy-crossing and gain rejections", () => {
    const x30 = round4(10 + (6 * Math.cos(Math.PI / 6)));
    const navigation = makeNavigation({
        invalidEndpoints: {
            [pointKey(16, 0)]: "endpoint-out-of-bounds",
            [pointKey(x30, 3)]: "endpoint-occupied"
        },
        failingRoutes: {
            [pointKey(x30, -3)]: "path-not-found"
        },
        routeCustomizer: (token, destination, waypoints) => {
            if (round4(destination.x) === 14 && round4(destination.y) === 0) {
                return [waypoints[0], { x: 0, y: 0 }, waypoints.at(-1)];
            }
            return waypoints;
        }
    });
    const danger = point => {
        if (round4(point.x) === x30 && round4(point.y) === 3) return 0.5;
        return defaultDanger(point);
    };
    const result = evaluatePeelWithdrawal(makeInput({ navigation, dangerAt: danger }));
    assert.equal(result.status, "rejected");
    assert.equal(result.reason, "regroup-invalid");
    const rows = new Map(result.breakdown.regroupCandidates.map(row => [row.source, row]));
    assert.equal(rows.get("away-0-extended").rejection, "out-of-bounds");
    assert.ok(rows.get("away-30-extended").rejections.includes("occupied"));
    assert.ok(rows.get("away-30-extended").rejections.includes("danger-too-high"));
    assert.equal(rows.get("away--30-extended").rejection, "no-exact-route");
    assert.ok(rows.get("away-0-full").rejections.includes("route-through-enemy"));
    assert.ok(rows.get("away-0-half").rejections.includes("insufficient-gain"));
    assert.ok(result.breakdown.regroupCandidates.every(row => row.selected === false));
});

test("regroup scoring prefers lower danger before distance gain and route cost", () => {
    const x30 = round4(10 + (6 * Math.cos(Math.PI / 6)));
    const danger = point => {
        const x = round4(point.x);
        const y = round4(point.y);
        if (x === x30 && Math.abs(y) === 3) return 0.1;
        if (x === 16 && y === 0) return 0.3;
        if (x === 14 && y === 0) return 0.2;
        if (point.x >= 10) return 0.7;
        return 1;
    };
    const result = evaluatePeelWithdrawal(makeInput({ dangerAt: danger }));
    assert.equal(result.status, "ok");
    assert.equal(result.descriptor.objective.regroupPoint.source, "away-30-extended");
    const rows = result.descriptor.breakdown.regroupCandidates;
    const selected = rows.find(row => row.selected);
    const straight = rows.find(row => row.source === "away-0-extended");
    assert.equal(selected.danger, 0.1);
    assert.equal(straight.danger, 0.3);
    assert.ok(straight.distanceGain > selected.distanceGain);
    assert.equal(selected.rank, 1);
    assert.ok(Number.isFinite(straight.rank));
});

test("regroup validation can use an injected threat centroid and rejects missing services", () => {
    const centroid = computeThreatCentroid([
        { x: 0, y: 0, ev: 15, weight: 1 },
        { x: 10, y: 0, ev: 0, weight: 0.5, source: "last-known" }
    ]);
    assert.deepEqual(centroid, {
        x: round4(10 / 3),
        y: 0,
        sourceCount: 2,
        weight: 1.5
    });

    const noNavigation = evaluatePeelWithdrawal(makeInput({ navigation: null }));
    assert.equal(noNavigation.status, "rejected");
    assert.equal(noNavigation.reason, "navigation-unavailable");

    const noDanger = evaluatePeelWithdrawal(makeInput({ dangerAt: null }));
    assert.equal(noDanger.status, "rejected");
    assert.equal(noDanger.reason, "danger-unavailable");

    const noRatesMembers = defaultMembers().map(member => {
        const copy = { ...member };
        delete copy.movement;
        return copy;
    });
    const noRates = evaluatePeelWithdrawal(makeInput({ members: noRatesMembers, rates: null }));
    assert.equal(noRates.status, "rejected");
    assert.equal(noRates.reason, "movement-rates-unavailable");
});

/* ---------------------------------------------------------------------- */
/* Cover priority                                                          */
/* ---------------------------------------------------------------------- */

test("cover choice is suppression first, then direct, then overwatch", () => {
    const base = evaluatePeelWithdrawal(makeInput());
    assert.equal(base.descriptor.cover.mode, "suppression");
    assert.deepEqual(base.descriptor.cover.members, ["m2"]);

    const directMembers = defaultMembers();
    directMembers[1].capabilities = {
        direct: true,
        suppression: false,
        overwatch: true,
        melee: false,
        ammo: true,
        los: true
    };
    const direct = evaluatePeelWithdrawal(makeInput({ members: directMembers }));
    assert.equal(direct.descriptor.cover.mode, "direct");
    assert.equal(direct.descriptor.cover.reason, "direct-fallback");

    const overwatchMembers = defaultMembers();
    overwatchMembers[1].capabilities = {
        direct: false,
        suppression: false,
        overwatch: true,
        melee: false,
        ammo: true,
        los: true
    };
    const overwatch = evaluatePeelWithdrawal(makeInput({ members: overwatchMembers }));
    assert.equal(overwatch.descriptor.cover.mode, "overwatch");
    assert.equal(overwatch.descriptor.cover.reason, "overwatch-fallback");

    // A suppression cone marked lane/friendly-unsafe cannot claim priority;
    // the same member falls back to direct fire rather than overwatch.
    const laneMembers = defaultMembers();
    laneMembers[1].capabilities = {
        direct: true,
        suppression: true,
        overwatch: true,
        melee: false,
        ammo: true,
        los: true,
        lane: { suppression: false }
    };
    const lane = evaluatePeelWithdrawal(makeInput({ members: laneMembers }));
    assert.equal(lane.descriptor.cover.mode, "direct");

    const reactionMembers = defaultMembers();
    reactionMembers[1] = {
        ...reactionMembers[1],
        reactionUsed: true,
        capabilities: {
            direct: false,
            suppression: false,
            overwatch: true,
            melee: false,
            ammo: true,
            los: true
        }
    };
    const reaction = evaluatePeelWithdrawal(makeInput({ members: reactionMembers }));
    assert.equal(reaction.status, "rejected");
    assert.equal(reaction.reason, "no-cover-reaction-used");
});

/* ---------------------------------------------------------------------- */
/* Serializable/frozen descriptor and repeat determinism                   */
/* ---------------------------------------------------------------------- */

test("descriptor is frozen, JSON-serializable and repeat-identical", () => {
    const input = makeInput();
    const first = evaluatePeelWithdrawal(input);
    const second = evaluatePeelWithdrawal(makeInput());
    assert.equal(first.status, "ok");
    assert.equal(first.descriptor.name, PEEL_WITHDRAWAL_NAME);
    assert.equal(first.descriptor.objective.ttl, 1);
    assert.equal(Object.isFrozen(first.descriptor), true);
    assert.equal(Object.isFrozen(first.descriptor.assignments), true);
    assert.equal(Object.isFrozen(first.descriptor.breakdown), true);

    const roundTrip = JSON.parse(JSON.stringify(first.descriptor));
    assert.deepEqual(roundTrip, JSON.parse(JSON.stringify(second.descriptor)));
    assert.deepEqual(roundTrip.assignments, {
        m1: { task: "regroup", role: "withdraw" },
        m2: { task: "support", role: "cover" }
    });
    assert.equal(roundTrip.objective.type, "peel-withdrawal");
    assert.equal(roundTrip.objective.hysteresis.mode, "l2-morale/commitment/stateless");
    assert.equal(roundTrip.breakdown.thresholds.experimental, true);
    assert.equal(roundTrip.breakdown.thresholds.peelCasualtyRatio, PEEL_DEFAULT_THRESHOLDS.peelCasualtyRatio);
    assert.equal(roundTrip.breakdown.thresholds.peelFreeAttackCoverMultipliers.suppression, 0.6);
    assert.equal(roundTrip.breakdown.rejections.length, 0);

    // Member input order is not observable: normalization sorts combatant
    // ids and the assignment object itself is rebuilt in sorted key order.
    const reversedInput = makeInput({ members: [...defaultMembers()].reverse() });
    const reversed = evaluatePeelWithdrawal(reversedInput);
    assert.deepEqual(JSON.parse(JSON.stringify(reversed.descriptor)), roundTrip);
});
