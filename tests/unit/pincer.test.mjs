/**
 * Unit tests for the pure pincer tactic core (issue #88): signed maneuver
 * point extraction, false-envelopment route tests, deterministic group
 * composition, morale gate, elastic/strict descriptors, degradation and the
 * loose assault variant. No Foundry objects or services are required.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    PINCER_CONFIG,
    PINCER_DEGRADATION_REASONS,
    PINCER_LOOSE_TACTIC,
    PINCER_REASONS,
    PINCER_TACTIC,
    composePincerGroups,
    composePincerLooseGroups,
    evaluatePincerMoraleGate,
    extractPincerManeuverPoints,
    flankProgress,
    measurePincerConcentration,
    pincerMoralePasses,
    pincerSyncPolicy,
    resolvePincerConfig,
    routesDiverge,
    selectPincerTactic
} from "../../scripts/presets/pincer.js";

/**
 * Minimal member fixture with explicit loadout data.
 * @param {string} id
 * @param {number} x
 * @param {number} y
 * @param {object} [options]
 * @returns {object}
 */
function member(id, x, y, { bestRange = 100, melee = false } = {}) {
    return {
        combatantId: id,
        enabled: true,
        defeated: false,
        position: { x, y },
        bestRange,
        melee
    };
}

/** Square scene fixture: 100 px per 1.5 m. */
function squareScene() {
    return { grid: { size: 100, distance: 1.5, units: "m", type: 1 } };
}

/**
 * Hand-crafted feasible flank options. The routes cross inside the first 25%
 * and then diverge widely, so all three divergence checks pass.
 * @returns {object[]}
 */
function feasibleFlankOptions() {
    return [
        {
            side: "left",
            point: { x: 300, y: 500 },
            leadId: "b",
            start: { x: 0, y: -20 },
            travel: 600,
            rawTravel: 600,
            angle: 90
        },
        {
            side: "right",
            point: { x: 300, y: -500 },
            leadId: "c",
            start: { x: 0, y: 20 },
            travel: 600,
            rawTravel: 600,
            angle: 90
        }
    ];
}

/** Successful pure selector input used by descriptor tests. */
function successfulInput(extra = {}) {
    return {
        members: [
            member("a", -20, 0),
            member("b", 0, -20),
            member("c", 0, 20),
            member("d", 0, 0, { bestRange: 20 })
        ],
        leaderId: "a",
        targets: [{ tokenId: "e1", x: 300, y: 0, canAttack: true }],
        flankOptions: feasibleFlankOptions(),
        scene: squareScene(),
        ...extra
    };
}

/** Simple side descriptor accepted by composition functions. */
function simpleSides(leftTravel = 100, rightTravel = 200) {
    return {
        left: { leadId: "b", travel: leftTravel },
        right: { leadId: "c", travel: rightTravel }
    };
}

/* ------------------------------------------------------------------------ */
/* Configuration                                                             */
/* ------------------------------------------------------------------------ */

test("pincer config exposes experimental defaults and resolves grid-dependent coefficients", () => {
    assert.equal(PINCER_CONFIG.minRouteAngleDeg, 60);
    assert.equal(PINCER_CONFIG.corridorSamples, 8);
    assert.equal(PINCER_CONFIG.minMembers, 4);
    assert.equal(PINCER_CONFIG.fixMinRange, 10);
    assert.equal(PINCER_CONFIG.minMorale, "pressured");
    assert.equal(PINCER_CONFIG.sync, "elastic");

    const fallback = resolvePincerConfig();
    assert.equal(fallback.corridorSeparation, 150);
    assert.equal(fallback.maxTravel, 1200);
    assert.equal(fallback.spread, 300);

    const resolved = resolvePincerConfig(null, null, {
        scene: squareScene(),
        preferredCohesion: 5
    });
    assert.equal(resolved.corridorSeparation, 150);
    assert.equal(resolved.maxTravel, 800);
    assert.ok(Math.abs(resolved.spread - (1000 / 1.5)) < 1e-6);

    const wideGrid = resolvePincerConfig(null, null, { scene: { grid: { size: 200, distance: 2 } } });
    assert.equal(wideGrid.corridorSeparation, 300);

    const aliased = resolvePincerConfig({
        pincerMaxTravel: 500,
        pincerEnemySpread: 450,
        pincerSync: "strict"
    });
    assert.equal(aliased.maxTravel, 500);
    assert.equal(aliased.spread, 450);
    assert.equal(aliased.enemySpread, 450);
    assert.equal(aliased.sync, "strict");
});

/* ------------------------------------------------------------------------ */
/* Signed maneuver point extraction                                          */
/* ------------------------------------------------------------------------ */

test("extractPincerManeuverPoints builds signed geometry and resolves lead conflicts deterministically", () => {
    // `b` is closest to both symmetric points. Equal side travel ties left;
    // the right side deterministically takes the next member (`c`).
    const members = [
        member("c", 10, 0),
        member("a", 0, 0),
        member("b", 20, 0)
    ];
    const input = {
        members,
        leaderId: "a",
        targets: [{ tokenId: "e1", x: 400, y: 0, canAttack: true }]
    };
    const extracted = extractPincerManeuverPoints(input);
    assert.equal(extracted.status, "ok");
    assert.equal(extracted.feasible, true);
    assert.ok(extracted.left.point.y > 0);
    assert.ok(extracted.right.point.y < 0);
    assert.equal(extracted.left.leadId, "b");
    assert.equal(extracted.right.leadId, "c");
    assert.notEqual(extracted.left.leadId, extracted.right.leadId);
    assert.equal(extracted.both.left.leadId, "b");
    assert.equal(extracted.both.right.leadId, "c");
    assert.equal(extracted.left.blocked, false);
    assert.ok(extracted.left.angle >= PINCER_CONFIG.flankMinAngleDegrees);
    assert.ok(extracted.left.route.waypoints.length >= 2);

    const shuffled = extractPincerManeuverPoints({
        ...input,
        members: [...members].reverse()
    });
    assert.deepEqual(shuffled, extracted);
});

test("extractPincerManeuverPoints accepts supplied flank options and normalizes routes", () => {
    const extracted = extractPincerManeuverPoints({
        members: successfulInput().members,
        leaderId: "a",
        targets: successfulInput().targets,
        flankOptions: feasibleFlankOptions()
    });
    assert.equal(extracted.status, "ok");
    assert.equal(extracted.left.leadId, "b");
    assert.equal(extracted.right.leadId, "c");
    assert.deepEqual(extracted.left.route.start, { x: 0, y: -20 });
    assert.deepEqual(extracted.right.route.end, { x: 300, y: -500 });
});

/* ------------------------------------------------------------------------ */
/* routesDiverge                                                             */
/* ------------------------------------------------------------------------ */

test("routesDiverge passes genuinely divergent routes", () => {
    const result = routesDiverge(
        [{ x: 0, y: -20 }, { x: 300, y: 500 }],
        [{ x: 0, y: 20 }, { x: 300, y: -500 }]
    );
    assert.equal(result.pass, true);
    assert.equal(result.reason, null);
    assert.ok(result.angle >= 60);
    assert.equal(result.crossed, false);
    assert.ok(result.minSeparation >= 150);
    assert.equal(result.checks.corridor.samples, 8);
});

test("routesDiverge rejects parallel false-envelopment routes", () => {
    const result = routesDiverge(
        [{ x: 0, y: 0 }, { x: 400, y: 100 }],
        [{ x: 0, y: 20 }, { x: 400, y: 120 }]
    );
    assert.equal(result.pass, false);
    assert.equal(result.angle, 0);
    assert.equal(result.reason, "route-angle-insufficient");
    assert.equal(result.checks.angle.pass, false);
});

test("routesDiverge rejects crossing polylines after the trim window", () => {
    const result = routesDiverge(
        [{ x: 0, y: -300 }, { x: 400, y: 300 }],
        [{ x: 0, y: 300 }, { x: 400, y: -300 }]
    );
    assert.equal(result.pass, false);
    assert.equal(result.crossed, true);
    assert.equal(result.reason, "routes-cross");
    assert.equal(result.checks.intersection.pass, false);
});

test("routesDiverge trim allows a shared startup cluster but still checks corridor separation", () => {
    const sharedStart = routesDiverge(
        [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 400, y: 700 }],
        [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 400, y: -700 }]
    );
    assert.equal(sharedStart.crossed, false);
    assert.equal(sharedStart.pass, true);

    const closeColumn = routesDiverge(
        [{ x: 0, y: 0 }, { x: 400, y: 100 }],
        [{ x: 0, y: 160 }, { x: 400, y: 260 }],
        { scene: { grid: { size: 200, distance: 2 } } }
    );
    assert.equal(closeColumn.checks.corridor.threshold, 300);
    assert.equal(closeColumn.checks.corridor.pass, false);
    assert.ok(closeColumn.minSeparation < 300);
});

test("routesDiverge navigation probes replace straight polylines for intersection checks", () => {
    const calls = [];
    const navigation = {
        searchRoute({ goal }) {
            calls.push(goal.y);
            return {
                status: "ok",
                exact: true,
                waypoints: goal.y > 0
                    ? [{ x: 0, y: -20 }, { x: 200, y: 0 }, { x: 300, y: 500 }]
                    : [{ x: 0, y: 20 }, { x: 200, y: 0 }, { x: 300, y: -500 }]
            };
        }
    };
    const result = routesDiverge(
        [{ x: 0, y: -20 }, { x: 300, y: 500 }],
        [{ x: 0, y: 20 }, { x: 300, y: -500 }],
        { navigation }
    );
    assert.deepEqual(calls, [500, -500]);
    assert.equal(result.probes.left.used, true);
    assert.equal(result.probes.right.used, true);
    assert.equal(result.crossed, true);
    assert.equal(result.pass, false);
    assert.equal(result.reason, "routes-cross");
});

/* ------------------------------------------------------------------------ */
/* Composition                                                               */
/* ------------------------------------------------------------------------ */

test("composePincerGroups produces deterministic n=4/5/6 compositions with fix-base invariants", () => {
    const sides = simpleSides();
    const ids = ["a", "b", "c", "d", "e", "f"];

    const n4 = composePincerGroups(ids.slice(0, 4).map(id => member(id, 0, 0)), "a", sides);
    assert.equal(n4.status, "ok");
    assert.equal(n4.sizes.fix, 1);
    assert.equal(n4.sizes.total, 4);
    assert.deepEqual(n4.composition.fix, ["a"]);
    assert.equal(n4.sizes.left + n4.sizes.right, 3);

    const n5 = composePincerGroups(ids.slice(0, 5).map(id => member(id, 0, 0)), "a", sides);
    assert.equal(n5.status, "ok");
    assert.equal(n5.sizes.fix, 2);
    assert.deepEqual(n5.composition.fix, ["a", "d"]);
    assert.equal(n5.sizes.left + n5.sizes.right, 3);

    const n6 = composePincerGroups(ids.map(id => member(id, 0, 0)), "a", sides);
    assert.equal(n6.status, "ok");
    assert.deepEqual(n6.sizes, { left: 2, right: 2, fix: 2, center: 0, total: 6 });
    assert.deepEqual(n6.composition.fix, ["a", "d"]);

    const shuffled = composePincerGroups(
        ids.map(id => member(id, 0, 0)).reverse(),
        "a",
        sides
    );
    assert.deepEqual(shuffled, n6);
});

test("composePincerGroups rebalances the longest-range flanker into a melee-led fix base", () => {
    const result = composePincerGroups([
        member("a", 0, 0, { bestRange: 0, melee: true }),
        member("b", 0, 0),
        member("c", 0, 0),
        member("d", 0, 0, { bestRange: 0, melee: true })
    ], "a", simpleSides());
    assert.equal(result.status, "ok");
    assert.deepEqual(result.composition.fix, ["a", "b"]);
    assert.equal(result.rebalance.memberId, "b");
    assert.equal(result.rebalance.reason, "fix-requires-ranged");
    assert.equal(result.composition.left.length, 1);
    assert.equal(result.composition.right.length, 1);
    assert.equal(result.assignments.b.element, "fix");
    assert.equal(result.assignments.b.role, "fixer");
});

test("composePincerGroups rejects a melee-only team because fix cannot pin by fire", () => {
    const result = composePincerGroups([
        member("a", 0, 0, { bestRange: 0, melee: true }),
        member("b", 0, 0, { bestRange: 0, melee: true }),
        member("c", 0, 0, { bestRange: 0, melee: true }),
        member("d", 0, 0, { bestRange: 0, melee: true })
    ], "a", simpleSides());
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason, PINCER_REASONS.noRangedFix);
});

/* ------------------------------------------------------------------------ */
/* Morale gate and concentration                                             */
/* ------------------------------------------------------------------------ */

test("pincer morale gate excludes desperate by default but accepts pressured and confident", () => {
    assert.equal(pincerMoralePasses("desperate"), false);
    assert.equal(pincerMoralePasses("pressured"), true);
    assert.equal(pincerMoralePasses("confident"), true);
    assert.equal(pincerMoralePasses(undefined), true);
    assert.equal(evaluatePincerMoraleGate("pressured", "confident").pass, false);

    const desperate = selectPincerTactic(successfulInput({ moraleTier: "desperate" }));
    assert.equal(desperate.name, null);
    assert.equal(desperate.reason, PINCER_REASONS.moraleGate);
    assert.equal(desperate.breakdown.moraleTier, "desperate");
});

test("pincer concentration rejects dispersed enemies", () => {
    const concentration = measurePincerConcentration([
        { tokenId: "e1", x: 300, y: 0 },
        { tokenId: "e2", x: 800, y: 0 }
    ], { spread: 300 });
    assert.equal(concentration.spread, 500);
    assert.equal(concentration.pass, false);

    const result = selectPincerTactic(successfulInput({
        targets: [
            { tokenId: "e1", x: 300, y: 0, canAttack: true },
            { tokenId: "e2", x: 1100, y: 0, canAttack: true }
        ]
    }));
    assert.equal(result.name, null);
    assert.equal(result.reason, PINCER_REASONS.enemySpread);
});

/* ------------------------------------------------------------------------ */
/* Descriptor semantics                                                      */
/* ------------------------------------------------------------------------ */

test("selectPincerTactic builds an elastic JSON descriptor with object-form assignments", () => {
    const result = selectPincerTactic(successfulInput());
    assert.equal(result.name, PINCER_TACTIC);
    assert.equal(result.reason, "superiority-pincer");
    assert.equal(result.objective.type, PINCER_TACTIC);
    assert.equal(result.objective.sync, "elastic");
    assert.equal(result.objective.syncPolicy.awaitSelection, "earliest-transit");
    assert.equal(result.objective.syncPolicy.validation, "all-awaited-lost-breaks-sync");
    assert.equal(result.objective.targetId, "e1");
    assert.equal(result.objective.flankTargetId, "e1");
    assert.equal(result.objective.elements.left.leadId, "b");
    assert.equal(result.objective.elements.right.leadId, "c");
    assert.equal(result.assignments.a.element, "fix");
    assert.equal(result.assignments.b.element, "flank-left");
    assert.equal(result.assignments.c.element, "flank-right");
    assert.equal(result.assignments.b.task, "flank");
    assert.equal(result.assignments.a.task, "support");
    assert.equal(result.breakdown.coefficients.minRouteAngleDeg, 60);
    assert.equal(result.breakdown.coefficients.maxTravel, 800);
    assert.equal(result.diagnostics.coefficients.sync, "elastic");
    assert.equal(result.breakdown.divergence.pass, true);
    assert.equal(result.taskCapacities.flank, 2);

    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    assert.deepEqual(selectPincerTactic(successfulInput()), result);
});

test("selectPincerTactic strict sync descriptor waits for all transit flankers", () => {
    const result = selectPincerTactic(successfulInput({ config: { sync: "strict" } }));
    assert.equal(result.name, PINCER_TACTIC);
    assert.equal(result.objective.sync, "strict");
    assert.equal(result.objective.syncPolicy.awaitSelection, "all-transit");
    assert.equal(result.objective.syncPolicy.readyWhen, "all-transit-flankers");
    assert.equal(result.objective.syncPolicy.validation, "any-awaited-lost-breaks-sync");
    assert.equal(result.breakdown.sync.validation, "any-awaited-lost-breaks-sync");
    assert.deepEqual(pincerSyncPolicy("strict"), result.objective.syncPolicy);
});

/* ------------------------------------------------------------------------ */
/* Degradation                                                               */
/* ------------------------------------------------------------------------ */

test("one blocked side degrades to flank-and-fix instead of cancelling the maneuver", () => {
    const options = feasibleFlankOptions();
    options[1].blocked = true;
    const result = selectPincerTactic(successfulInput({ flankOptions: options }));
    assert.equal(result.name, "flank-and-fix");
    assert.equal(result.reason, PINCER_DEGRADATION_REASONS.sideBlocked);
    assert.equal(result.objective.type, "flank-and-fix");
    assert.equal(result.objective.flankSide, "left");
    assert.equal(result.breakdown.degradation.reason, PINCER_DEGRADATION_REASONS.sideBlocked);
    assert.equal(result.breakdown.degradation.cause, "side-blocked");
    assert.equal(result.assignments.b.element, "flank-left");
    assert.equal(result.assignments.a.element, "fix");
});

test("non-divergent routes degrade with pincer-degraded-no-divergence", () => {
    const parallel = [
        {
            side: "left",
            point: { x: 300, y: 100 },
            leadId: "b",
            start: { x: 0, y: 0 },
            travel: 300,
            rawTravel: 300,
            angle: 90
        },
        {
            side: "right",
            point: { x: 300, y: 120 },
            leadId: "c",
            start: { x: 0, y: 20 },
            travel: 300,
            rawTravel: 300,
            angle: 90
        }
    ];
    const result = selectPincerTactic(successfulInput({ flankOptions: parallel }));
    assert.equal(result.name, "flank-and-fix");
    assert.equal(result.reason, PINCER_DEGRADATION_REASONS.noDivergence);
    assert.equal(result.breakdown.degradation.cause, "route-angle-insufficient");
    assert.equal(result.breakdown.divergence.pass, false);
    assert.equal(result.objective.flankSide, "left");
});

/* ------------------------------------------------------------------------ */
/* Loose assault variant                                                     */
/* ------------------------------------------------------------------------ */

test("loose assault variant has no sync barrier and an empty centre at n=4", () => {
    const result = selectPincerTactic(successfulInput({ loose: true }));
    assert.equal(result.name, PINCER_LOOSE_TACTIC);
    assert.equal(result.objective.type, PINCER_LOOSE_TACTIC);
    assert.equal(result.objective.sync, "none");
    assert.equal(result.objective.syncPolicy.awaitSelection, "none");
    assert.equal(result.breakdown.composition.center.length, 0);
    assert.equal(result.assignments.a.task, "flank");
    assert.equal(result.assignments.a.element, "flank-left");
    assert.equal(result.assignments.a.role, "flanker");
    assert.equal(result.objective.elements.center, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("composePincerLooseGroups places the leader in a non-empty centre from n=5", () => {
    const result = composePincerLooseGroups([
        member("a", 0, 0, { bestRange: 0, melee: true }),
        member("b", 0, 0, { bestRange: 0, melee: true }),
        member("c", 0, 0, { bestRange: 0, melee: true }),
        member("d", 0, 0, { bestRange: 0, melee: true }),
        member("e", 0, 0, { bestRange: 0, melee: true })
    ], "a", simpleSides());
    assert.equal(result.status, "ok");
    assert.deepEqual(result.composition.center, ["a"]);
    assert.equal(result.assignments.a.task, "assault");
    assert.equal(result.assignments.a.element, "center");
    assert.equal(result.sizes.left, 2);
    assert.equal(result.sizes.right, 2);
});

/* ------------------------------------------------------------------------ */
/* Shared helper and final determinism                                       */
/* ------------------------------------------------------------------------ */

test("flankProgress shared helper measures normalized movement toward the maneuver point", () => {
    const context = { selfPos: { x: 0, y: 0 }, team: { flankPoint: { x: 100, y: 0 } } };
    assert.equal(flankProgress({}, context), 0);
    assert.equal(flankProgress({ move: { x: 50, y: 0 } }, context), 0.5);
    assert.equal(flankProgress({ move: { x: 100, y: 0 } }, context), 1);
    assert.equal(flankProgress({ move: { x: 150, y: 0 } }, context), 0.5);
});

test("composition and descriptor results are JSON round-trip stable over repeated runs", () => {
    const extraction = extractPincerManeuverPoints({
        members: successfulInput().members,
        leaderId: "a",
        targets: successfulInput().targets,
        flankOptions: feasibleFlankOptions()
    });
    const composition = composePincerGroups(successfulInput().members, "a", extraction);
    assert.deepEqual(JSON.parse(JSON.stringify(composition)), composition);

    const first = selectPincerTactic(successfulInput());
    const second = selectPincerTactic(successfulInput());
    assert.deepEqual(second, first);
    assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
});

test("routesDiverge treats the 60 degree angle boundary as inclusive", () => {
    const vertical = Math.tan(Math.PI / 6) * 100;
    const boundary = routesDiverge(
        [{ x: 0, y: 0 }, { x: 100, y: vertical }],
        [{ x: 0, y: 0 }, { x: 100, y: -vertical }],
        { corridorSeparation: 1 }
    );
    assert.ok(Math.abs(boundary.angle - 60) < 1e-6);
    assert.equal(boundary.checks.angle.pass, true);
    assert.equal(boundary.pass, true);

    const belowVertical = Math.tan((29.5 * Math.PI) / 180) * 100;
    const below = routesDiverge(
        [{ x: 0, y: 0 }, { x: 100, y: belowVertical }],
        [{ x: 0, y: 0 }, { x: 100, y: -belowVertical }],
        { corridorSeparation: 1 }
    );
    assert.ok(below.angle < 60);
    assert.equal(below.checks.angle.pass, false);
    assert.equal(below.reason, "route-angle-insufficient");
});

test("routesDiverge reports corridor-separation when angle and crossings pass in one corridor", () => {
    const result = routesDiverge(
        [{ x: 0, y: 0 }, { x: 300, y: 200 }],
        [{ x: 0, y: 10 }, { x: 300, y: -200 }]
    );
    assert.equal(result.checks.angle.pass, true);
    assert.equal(result.crossed, false);
    assert.equal(result.checks.corridor.pass, false);
    assert.equal(result.reason, "corridor-separation");
    assert.ok(result.continuousSeparation <= result.minSeparation + 1e-9);
});

test("context.specOpsConfig pincer aliases configure the pure selector", () => {
    const strict = selectPincerTactic(successfulInput({
        context: { specOpsConfig: { pincerSync: "strict" } }
    }));
    assert.equal(strict.objective.sync, "strict");

    const tooSmall = selectPincerTactic(successfulInput({
        context: { specOpsConfig: { pincerMinMembers: 5 } }
    }));
    assert.equal(tooSmall.name, null);
    assert.equal(tooSmall.reason, PINCER_REASONS.insufficientMembers);
});

test("maxTravel degrades the side that cannot complete the maneuver", () => {
    const options = feasibleFlankOptions();
    options[1].travel = 700;
    options[1].rawTravel = 700;
    const result = selectPincerTactic(successfulInput({
        flankOptions: options,
        config: { maxTravel: 650 }
    }));
    assert.equal(result.name, "flank-and-fix");
    assert.equal(result.reason, PINCER_DEGRADATION_REASONS.sideBlocked);
    assert.equal(result.breakdown.degradation.cause, "travel-exceeded");
    assert.equal(result.objective.flankSide, "left");
});

test("loose n=4 leader placement uses the leader's own travel to side points", () => {
    const sides = {
        left: { leadId: "b", travel: 100, point: { x: 300, y: 500 } },
        right: { leadId: "c", travel: 10, point: { x: 300, y: -500 } }
    };
    const members = [
        member("a", 0, 100, { bestRange: 0, melee: true }),
        member("b", 0, 0, { bestRange: 0, melee: true }),
        member("c", 0, 0, { bestRange: 0, melee: true }),
        member("d", 0, 0, { bestRange: 0, melee: true })
    ];
    const result = composePincerLooseGroups({ members, leaderId: "a", sides });
    assert.equal(result.assignments.a.element, "flank-left");
});
