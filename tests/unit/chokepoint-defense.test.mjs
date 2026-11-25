/**
 * Unit tests of the pure chokepoint-defense tactic core (issue #91).
 *
 * Coverage per the epic contract:
 * 1. Anchor priority chain and lane inference (bounded routing, sample
 *    weights, deterministic clustering).
 * 2. Injective member→lane assignment and sticky lane identity without
 *    new persisted state.
 * 3. Counterattack evaluation and honest degradation reasons.
 * 4. Deterministic JSON round-trip of the serialized contract.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    CHOKEPOINT_CONSTANTS,
    CHOKEPOINT_TACTIC_NAME,
    LANE_SPREAD_DEG,
    MAX_ROUTE_THREATS,
    assignLaneIdentities,
    assignMembersToLanes,
    buildMemberProfile,
    clusterApproachLanes,
    collectDefenseThreats,
    committedLaneHints,
    evaluateChokepointDefense,
    insideKillZone,
    laneBaseId,
    lanePost,
    resolveDefenseAnchor,
    sampleThreatApproach,
    selectChokepointDefense
} from "../../scripts/presets/chokepoint-defense.js";
import {
    makeActor,
    makeCombatant,
    freezeDeep
} from "./fixtures.mjs";
import {
    FLAG_KEYS,
    MODULE_ID
} from "../../scripts/constants.js";

/** Test grid: 100 px per metre — conversions stay trivial. */
const SCENE = { id: "scene-1", grid: { size: 100, distance: 1 } };
const GRID = { size: 100, distance: 1 };
const ANCHOR = { x: 0, y: 0, elevation: 0, sceneId: "scene-1", radiusMeters: 6, source: "hold" };

/**
 * Minimal fireteam member entry for the pure selector.
 * @param {string} id Combatant id.
 * @param {object} [options]
 * @param {object} [options.position] Pixel position.
 * @param {string|null} [options.character] Team character.
 * @param {object|null} [options.combatant] Combatant document.
 * @returns {object}
 */
function memberEntry(id, { position = { x: 0, y: 0 }, character = null, combatant = null } = {}) {
    return {
        combatantId: id,
        tokenId: `tok-${id}`,
        ids: [id],
        position,
        enabled: true,
        defeated: false,
        team: character ? { character } : null,
        combatant
    };
}

/**
 * Ranged member profile DTO.
 * @param {object} [overrides]
 * @returns {object}
 */
function rangedProfile(overrides = {}) {
    return {
        bestRangeM: 30,
        suppressionCapable: false,
        suppressionRangeM: 0,
        meleeOnly: false,
        reactionUsed: false,
        visibleTargetIds: null,
        ...overrides
    };
}

/**
 * Live visible threat entry in normalized-target shape.
 * @param {string} id Token id.
 * @param {number} x Pixel x.
 * @param {number} y Pixel y.
 * @param {object} [overrides]
 * @returns {object}
 */
function liveThreat(id, x, y, overrides = {}) {
    return {
        tokenId: id,
        tokenUuid: `Scene.scene-1.Token.${id}`,
        x,
        y,
        canAttack: true,
        source: "visible",
        halfMove: 4,
        statuses: [],
        ...overrides
    };
}

/**
 * Baseline selector input: two ranged members, hold anchor at the
 * origin, no threats — tests override pieces as needed.
 * @param {object} [overrides]
 * @returns {object}
 */
function baseInput(overrides = {}) {
    const members = overrides.members ?? [
        memberEntry("m1"),
        memberEntry("m2", { position: { x: 100, y: 0 } })
    ];
    return {
        members,
        leaderId: "m1",
        targets: [],
        memberProfiles: overrides.memberProfiles ?? {
            m1: rangedProfile(),
            m2: rangedProfile()
        },
        scene: SCENE,
        context: {
            hold: { anchor: { x: 0, y: 0 }, radiusMeters: 6 },
            scene: SCENE,
            round: 1
        },
        ...overrides
    };
}

/**
 * Angular position helper: polar → pixel point at `distM` metres.
 * @param {number} bearingDeg Bearing in degrees (0 = east, 90 = south).
 * @param {number} distM Distance in metres.
 * @returns {{x: number, y: number}}
 */
function polar(bearingDeg, distM) {
    const rad = (bearingDeg * Math.PI) / 180;
    return {
        x: Math.cos(rad) * distM * 100,
        y: Math.sin(rad) * distM * 100
    };
}

// ---------------------------------------------------------------------------
// 1. Anchor and lane inference
// ---------------------------------------------------------------------------

test("resolveDefenseAnchor: explicit defend objective wins the whole chain", () => {
    const anchor = resolveDefenseAnchor({
        members: [memberEntry("m1")],
        leaderId: "m1",
        objective: {
            type: "defend",
            anchor: { x: 500, y: 500, radiusMeters: 9, sceneId: "scene-1" }
        },
        context: {
            hold: { anchor: { x: 0, y: 0 }, radiusMeters: 6 },
            scene: SCENE
        },
        scene: SCENE
    });
    assert.equal(anchor.source, "defend-objective");
    assert.equal(anchor.x, 500);
    assert.equal(anchor.radiusMeters, 9);
});

test("resolveDefenseAnchor: context.hold wins over member holds and centroid", () => {
    const anchor = resolveDefenseAnchor({
        members: [memberEntry("m1")],
        leaderId: "m1",
        context: {
            hold: { anchor: { x: 200, y: 100 }, radiusMeters: 7 },
            scene: SCENE
        },
        scene: SCENE
    });
    assert.equal(anchor.source, "hold");
    assert.equal(anchor.x, 200);
    assert.equal(anchor.radiusMeters, 7);
});

test("resolveDefenseAnchor: leader configured hold beats first member hold", () => {
    const make = (id, x, y) => {
        const actor = makeActor({
            rawConfig: { hold: { anchor: { x, y }, radiusMeters: 8 } }
        });
        const combatant = makeCombatant({ actor });
        return memberEntry(id, { combatant });
    };
    // Member ids sort as a1 < z2 — a1 is first in stable order, but the
    // leader z2 must win.
    const first = make("a1", 111, 111);
    const leader = make("z2", 222, 222);
    const anchor = resolveDefenseAnchor({
        members: [first, leader],
        leaderId: "z2",
        scene: SCENE
    });
    assert.equal(anchor.source, "leader-hold");
    assert.equal(anchor.x, 222);
    assert.equal(anchor.y, 222);
});

test("resolveDefenseAnchor: first member hold in stable id order without leader hold", () => {
    const make = (id, x, y) => {
        const actor = makeActor({
            rawConfig: { hold: { anchor: { x, y } } }
        });
        return memberEntry(id, { combatant: makeCombatant({ actor }) });
    };
    const members = [make("m2", 300, 0), make("m1", 400, 0)];
    const anchor = resolveDefenseAnchor({
        members,
        leaderId: "no-such-leader",
        scene: SCENE
    });
    assert.equal(anchor.source, "member-hold");
    // m1 sorts before m2 — its anchor wins.
    assert.equal(anchor.x, 400);
});

test("resolveDefenseAnchor: objective position when no holds exist", () => {
    const anchor = resolveDefenseAnchor({
        members: [memberEntry("m1")],
        objective: { x: 700, y: 800 },
        scene: SCENE
    });
    assert.equal(anchor.source, "objective-point");
    assert.equal(anchor.x, 700);
    assert.equal(anchor.y, 800);
});

test("resolveDefenseAnchor: centroid fallback with clamped cohesion radius", () => {
    const anchor = resolveDefenseAnchor({
        members: [
            memberEntry("m1", { position: { x: 0, y: 0 } }),
            memberEntry("m2", { position: { x: 200, y: 0 } })
        ],
        scene: SCENE,
        preferredCohesion: 5
    });
    assert.equal(anchor.source, "centroid");
    assert.equal(anchor.x, 100);
    assert.equal(anchor.y, 0);
    // clamp(preferredCohesion + 1 = 6, 6, 10) = 6.
    assert.equal(anchor.radiusMeters, 6);
});

test("resolveDefenseAnchor: broken and foreign-scene anchors are skipped", () => {
    const skipped = resolveDefenseAnchor({
        members: [memberEntry("m1")],
        objective: {
            type: "defend",
            anchor: { x: Number.NaN, y: 0 }
        },
        context: {
            hold: { anchor: { x: 50, y: 50, sceneId: "other-scene" } },
            scene: SCENE
        },
        scene: SCENE
    });
    // Both invalid sources fall through to the centroid of m1.
    assert.equal(skipped.source, "centroid");
    assert.equal(skipped.x, 0);

    const nothing = resolveDefenseAnchor({
        members: [memberEntry("m1", { position: null })],
        objective: { type: "defend", anchor: { x: Number.NaN, y: 0 } },
        scene: SCENE
    });
    assert.equal(nothing, null);
});

test("lane inference: exact route shifts the chokepoint off the straight line", () => {
    const threat = {
        ...liveThreat("t1", 2000, 0, { tokenDoc: { id: "t1" } }),
        distanceM: 20,
        etaRounds: 5,
        memory: false
    };
    const waypoints = [
        { x: 2000, y: 0 },
        { x: 2000, y: 500 },
        { x: 900, y: 500 },
        { x: 900, y: 100 },
        { x: 100, y: 100 },
        { x: 0, y: 0 }
    ];
    const calls = [];
    const navigation = {
        planRoute(token, destination, budget, options) {
            calls.push({ token, destination, budget, options });
            return { exact: true, partial: false, status: "ok", waypoints };
        }
    };
    const sample = sampleThreatApproach(threat, {
        anchor: ANCHOR,
        grid: GRID,
        leadM: 8,
        routeBudgetM: 24,
        routeAllowed: true,
        navigation,
        scene: SCENE
    });
    assert.equal(sample.kind, "exact");
    assert.equal(sample.weight, 1);
    // 8 m before the end of the detoured path: interpolates inside the
    // (900,100)→(100,100) segment, clearly off the straight ray y = 0.
    assert.ok(Math.abs(sample.x - 758.5858) < 1, `x ${sample.x}`);
    assert.ok(Math.abs(sample.y - 100) < 1, `y ${sample.y}`);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].budget, 24);
    assert.equal(calls[0].options.maxVisited, CHOKEPOINT_CONSTANTS.ROUTE_MAX_VISITED);
});

test("lane inference: partial route endpoint with reduced weight, straight fallback otherwise", () => {
    const base = {
        ...liveThreat("t1", 2000, 0, { tokenDoc: { id: "t1" } }),
        distanceM: 20,
        etaRounds: 5,
        memory: false
    };
    const partialNav = {
        planRoute() {
            return {
                exact: false,
                partial: true,
                waypoints: [{ x: 2000, y: 0 }, { x: 1500, y: 200 }]
            };
        }
    };
    const partial = sampleThreatApproach(base, {
        anchor: ANCHOR, grid: GRID, leadM: 8, routeBudgetM: 24,
        routeAllowed: true, navigation: partialNav, scene: SCENE
    });
    assert.equal(partial.kind, "partial");
    assert.equal(partial.weight, 0.65);
    assert.deepEqual({ x: partial.x, y: partial.y }, { x: 1500, y: 200 });

    const failNav = { planRoute() { return { status: "failed", waypoints: [] }; } };
    const straight = sampleThreatApproach(base, {
        anchor: ANCHOR, grid: GRID, leadM: 8, routeBudgetM: 24,
        routeAllowed: true, navigation: failNav, scene: SCENE
    });
    assert.equal(straight.kind, "straight");
    assert.equal(straight.weight, 0.35);
    assert.deepEqual({ x: straight.x, y: straight.y }, { x: 800, y: 0 });

    // Memory halving applies on top of the fidelity weight.
    const memory = sampleThreatApproach({ ...base, memory: true }, {
        anchor: ANCHOR, grid: GRID, leadM: 8, routeBudgetM: 24,
        routeAllowed: true, navigation: failNav, scene: SCENE
    });
    assert.equal(memory.weight, 0.175);
    assert.equal(memory.liveWeight, 0);

    // A threat inside the lead distance samples its own exact position.
    const close = sampleThreatApproach({ ...base, x: 500, y: 0, distanceM: 5 }, {
        anchor: ANCHOR, grid: GRID, leadM: 8, routeBudgetM: 24,
        routeAllowed: true, navigation: failNav, scene: SCENE
    });
    assert.equal(close.kind, "close");
    assert.equal(close.weight, 1);
    assert.deepEqual({ x: close.x, y: close.y }, { x: 500, y: 0 });
});

test("lane inference: route cap covers only the most urgent threats, rest stay straight", () => {
    // Six threats at distinct bearings; nearest four by ETA get routes.
    const members = [memberEntry("m1"), memberEntry("m2", { position: { x: 100, y: 0 } })];
    const threats = [0, 60, 120, 180, 240, 300].map((bearing, index) => {
        const distM = 10 + index;
        const pos = polar(bearing, distM);
        return liveThreat(`t${index}`, pos.x, pos.y, { tokenDoc: { id: `t${index}` } });
    });
    const calls = [];
    const navigation = {
        planRoute(token) {
            calls.push(token.id);
            return { status: "failed", waypoints: [] };
        }
    };
    const result = evaluateChokepointDefense(baseInput({
        members,
        targets: threats,
        navigation
    }));
    assert.equal(result.active, true, result.reason);
    assert.equal(calls.length, MAX_ROUTE_THREATS);
    assert.deepEqual(calls.sort(), ["t0", "t1", "t2", "t3"]);
    // The straight samples of the two non-routed threats still open
    // coverage — no direction silently disappears.
    const allThreatIds = new Set(result.breakdown.lanes.flatMap(lane => lane.threatIds));
    for (const lane of result.breakdown.lanes) void lane;
    const coveredOrDropped = new Set([
        ...allThreatIds,
        ...result.breakdown.droppedThreatIds
    ]);
    for (let index = 0; index < 6; index++) {
        assert.ok(coveredOrDropped.has(`Scene.scene-1.Token.t${index}`), `t${index} present`);
    }
});

test("clustering: same-corridor threats share one lane, opposite sides split", () => {
    const sample = (id, x, y) => ({
        x, y, kind: "straight", weight: 0.35, liveWeight: 0.35,
        memory: false, etaRounds: 3, tokenId: id, tokenUuid: `u-${id}`
    });
    // 15 degrees apart — inside the 35-degree spread.
    const a1 = polar(10, 8);
    const a2 = polar(25, 8);
    const together = clusterApproachLanes([
        sample("a1", a1.x, a1.y),
        sample("a2", a2.x, a2.y)
    ], { anchor: ANCHOR, grid: GRID });
    assert.equal(together.length, 1);
    assert.deepEqual(together[0].threatIds, ["u-a1", "u-a2"]);

    // Opposite directions — two lanes.
    const b1 = polar(0, 8);
    const b2 = polar(180, 8);
    const opposite = clusterApproachLanes([
        sample("b1", b1.x, b1.y),
        sample("b2", b2.x, b2.y)
    ], { anchor: ANCHOR, grid: GRID });
    assert.equal(opposite.length, 2);
});

test("clustering: circular wrap — bearings 350/10 merge, 350/30 split", () => {
    const sample = (id, x, y) => ({
        x, y, kind: "straight", weight: 0.35, liveWeight: 0.35,
        memory: false, etaRounds: 3, tokenId: id, tokenUuid: `u-${id}`
    });
    const near1 = polar(350, 8);
    const near2 = polar(10, 8);
    assert.equal(clusterApproachLanes([
        sample("n1", near1.x, near1.y),
        sample("n2", near2.x, near2.y)
    ], { anchor: ANCHOR, grid: GRID }).length, 1);

    const far2 = polar(30, 8);
    assert.equal(clusterApproachLanes([
        sample("n1", near1.x, near1.y),
        sample("f2", far2.x, far2.y)
    ], { anchor: ANCHOR, grid: GRID }).length, 2);
});

test("clustering: lateral corridor split beyond LANE_SPLIT_M", () => {
    const sample = (id, x, y) => ({
        x, y, kind: "straight", weight: 1, liveWeight: 1,
        memory: false, etaRounds: 3, tokenId: id, tokenUuid: `u-${id}`
    });
    // Two parallel eastward corridors 5.5 m apart — split.
    const wide = clusterApproachLanes([
        sample("w1", 1000, 0),
        sample("w2", 1000, 550)
    ], { anchor: ANCHOR, grid: GRID });
    assert.equal(wide.length, 2);

    // 3.5 m apart — one lane with a measurable width.
    const narrow = clusterApproachLanes([
        sample("n1", 1000, 0),
        sample("n2", 1000, 350)
    ], { anchor: ANCHOR, grid: GRID });
    assert.equal(narrow.length, 1);
    assert.ok(narrow[0].widthMeters > 2, `width ${narrow[0].widthMeters}`);
    assert.ok(narrow[0].widthDeg > 0 && narrow[0].widthDeg <= LANE_SPREAD_DEG);
    // The medoid chokepoint is always a real sample position.
    const choke = narrow[0].chokepoint;
    const matchesSample = (choke.x === 1000 && (choke.y === 0 || choke.y === 350));
    assert.ok(matchesSample, `chokepoint ${JSON.stringify(choke)}`);
});

test("clustering: largest-gap tie resolves to the smaller start bearing deterministically", () => {
    const sample = (id, x, y) => ({
        x, y, kind: "straight", weight: 1, liveWeight: 1,
        memory: false, etaRounds: 3, tokenId: id, tokenUuid: `u-${id}`
    });
    // Three evenly spaced directions — every gap is 120 degrees. Input
    // order must not matter.
    const points = [0, 120, 240].map(bearing => polar(bearing, 8));
    const forward = clusterApproachLanes([
        sample("p0", points[0].x, points[0].y),
        sample("p1", points[1].x, points[1].y),
        sample("p2", points[2].x, points[2].y)
    ], { anchor: ANCHOR, grid: GRID });
    const shuffled = clusterApproachLanes([
        sample("p2", points[2].x, points[2].y),
        sample("p0", points[0].x, points[0].y),
        sample("p1", points[1].x, points[1].y)
    ], { anchor: ANCHOR, grid: GRID });
    assert.equal(forward.length, 3);
    assert.deepEqual(
        forward.map(lane => lane.chokepoint),
        shuffled.map(lane => lane.chokepoint)
    );
});

test("collectDefenseThreats: memory duplicates collapse, hidden drop, ETA penalized", () => {
    const threats = collectDefenseThreats({
        targets: [
            liveThreat("t1", 1000, 0),
            liveThreat("ghost", 900, 0, { hidden: true })
        ],
        teamContacts: [
            { tokenUuid: "Scene.scene-1.Token.t1", x: 1200, y: 0, lastSeenRound: 1 },
            { tokenUuid: "Scene.scene-1.Token.mem", x: 1000, y: 0, lastSeenRound: 1, halfMove: 4 }
        ],
        anchor: ANCHOR,
        grid: GRID
    });
    const ids = threats.map(threat => threat.tokenUuid);
    assert.ok(!ids.includes("Scene.scene-1.Token.ghost"), "hidden dropped");
    // The live t1 entry wins over its memory duplicate.
    const t1 = threats.find(threat => threat.tokenUuid === "Scene.scene-1.Token.t1");
    assert.equal(t1.memory, false);
    assert.equal(t1.x, 1000);
    // Memory contact carries the +1.5 round ETA penalty.
    const memory = threats.find(threat => threat.tokenUuid === "Scene.scene-1.Token.mem");
    assert.equal(memory.memory, true);
    assert.ok(memory.etaRounds > t1.etaRounds, "memory ETA penalized");
});

// ---------------------------------------------------------------------------
// 2. Assignment and sticky identity
// ---------------------------------------------------------------------------

test("assignment: suppression-capable member wins the lane over plain ranged", () => {
    const members = [
        memberEntry("m1"),
        memberEntry("m2"),
        memberEntry("m3")
    ];
    const profiles = {
        m1: rangedProfile({ suppressionCapable: true, suppressionRangeM: 30 }),
        m2: rangedProfile(),
        m3: rangedProfile({ bestRangeM: 0, meleeOnly: true })
    };
    const threat = liveThreat("t1", 2000, 0);
    const result = evaluateChokepointDefense(baseInput({
        members,
        targets: [threat],
        memberProfiles: profiles
    }));
    assert.equal(result.active, true, result.reason);
    const assignments = result.descriptor.assignments;
    // m1 is the leader here — make it non-leader by checking whoever is
    // suppression-capable got the lane. Both m1/m2 are candidates; the
    // suppression bonus must put m1 on the lane despite the tie.
    const laneRoles = Object.entries(assignments)
        .filter(([, value]) => value.role === "overwatch-lane")
        .map(([key]) => key);
    assert.ok(laneRoles.includes("m1"), `m1 on lane: ${JSON.stringify(assignments)}`);
});

test("assignment: melee-only member falls back to reserve behind ranged members", () => {
    // Two approach directions, three members — the melee-only fighter
    // loses both lane slots to the ranged members.
    const east = polar(0, 15);
    const west = polar(180, 15);
    const result = evaluateChokepointDefense(baseInput({
        members: [memberEntry("m1"), memberEntry("m2"), memberEntry("m3")],
        memberProfiles: {
            m1: rangedProfile(),
            m2: rangedProfile(),
            m3: rangedProfile({ bestRangeM: 0, meleeOnly: true })
        },
        targets: [
            liveThreat("te", east.x, east.y),
            liveThreat("tw", west.x, west.y)
        ]
    }));
    assert.equal(result.active, true, result.reason);
    const assignments = result.descriptor.assignments;
    assert.equal(assignments.m3.role, "reserve");
    assert.equal(assignments.m1.role, "overwatch-lane");
    assert.equal(assignments.m2.role, "overwatch-lane");
    assert.notEqual(assignments.m1.element, assignments.m2.element);
});

test("assignment: reaction-spent members still assigned deterministically when no alternative", () => {
    const members = [memberEntry("m1"), memberEntry("m2")];
    const profiles = {
        m1: rangedProfile({ reactionUsed: true }),
        m2: rangedProfile({ reactionUsed: true })
    };
    // Both reactions spent and no suppression — activation fails the
    // overwatch gate, proving the gate itself.
    const blocked = evaluateChokepointDefense(baseInput({
        members,
        targets: [liveThreat("t1", 2000, 0)],
        memberProfiles: profiles
    }));
    assert.equal(blocked.active, false);
    assert.equal(blocked.reason, "no-overwatcher");

    // With one suppression-capable member the tactic activates and the
    // lane is filled deterministically even though reactions are spent.
    const profilesWithSuppression = {
        m1: rangedProfile({ reactionUsed: true, suppressionCapable: true, suppressionRangeM: 30 }),
        m2: rangedProfile({ reactionUsed: true })
    };
    const active = evaluateChokepointDefense(baseInput({
        members,
        targets: [liveThreat("t1", 2000, 0)],
        memberProfiles: profilesWithSuppression
    }));
    assert.equal(active.active, true, active.reason);
    const laneHolders = Object.entries(active.descriptor.assignments)
        .filter(([, value]) => value.role === "overwatch-lane")
        .map(([key]) => key);
    assert.equal(laneHolders.length, 1);
    assert.equal(laneHolders[0], "m1");
});

test("assignment: primary lane second watcher only when memberCount > laneCount + 1", () => {
    const threat = liveThreat("t1", 2000, 0);
    // Two members, one lane: single slot, one watcher, one reserve/leader.
    const two = evaluateChokepointDefense(baseInput({
        members: [memberEntry("m1"), memberEntry("m2")],
        targets: [threat]
    }));
    assert.equal(two.active, true, two.reason);
    const twoLanes = Object.values(two.descriptor.assignments)
        .filter(value => value.role === "overwatch-lane");
    assert.equal(twoLanes.length, 1);

    // Three members, one lane (3 > 1 + 1): the primary lane carries a
    // second overwatcher.
    const three = evaluateChokepointDefense(baseInput({
        members: [memberEntry("m1"), memberEntry("m2"), memberEntry("m3")],
        memberProfiles: {
            m1: rangedProfile(),
            m2: rangedProfile(),
            m3: rangedProfile()
        },
        targets: [threat]
    }));
    assert.equal(three.active, true, three.reason);
    const threeLanes = Object.values(three.descriptor.assignments)
        .filter(value => value.role === "overwatch-lane");
    assert.equal(threeLanes.length, 2);
    assert.equal(new Set(threeLanes.map(value => value.element)).size, 1,
        "both watchers on the single lane");
});

test("assignment: lane coverage cap leaves a reserve and reports uncovered lanes", () => {
    // Three members, three approach directions: coverage limited to two
    // watchers — one lane stays consciously uncovered.
    const bearings = [0, 120, 240];
    const threats = bearings.map((bearing, index) => {
        const pos = polar(bearing, 15);
        return liveThreat(`t${index}`, pos.x, pos.y);
    });
    const result = evaluateChokepointDefense(baseInput({
        members: [memberEntry("m1"), memberEntry("m2"), memberEntry("m3")],
        memberProfiles: {
            m1: rangedProfile(),
            m2: rangedProfile(),
            m3: rangedProfile()
        },
        targets: threats
    }));
    assert.equal(result.active, true, result.reason);
    assert.equal(result.descriptor.objective.lanes.length, 3);
    assert.equal(result.breakdown.uncoveredLaneIds.length, 1);
    const reserveOrLeader = Object.values(result.descriptor.assignments)
        .filter(value => value.role !== "overwatch-lane");
    assert.ok(reserveOrLeader.length >= 1, "at least one member off the lanes");
    // Every lane holds at most one watcher — injective assignment.
    const laneElements = Object.values(result.descriptor.assignments)
        .filter(value => value.role === "overwatch-lane")
        .map(value => value.element);
    assert.equal(new Set(laneElements).size, laneElements.length);
});

test("assignment object shape matches the epic contract", () => {
    const result = evaluateChokepointDefense(baseInput({
        targets: [liveThreat("t1", 2000, 0)]
    }));
    assert.equal(result.active, true, result.reason);
    const assignments = result.descriptor.assignments;
    const laneEntry = Object.values(assignments)
        .find(value => value.role === "overwatch-lane");
    assert.equal(laneEntry.task, "support");
    assert.equal(laneEntry.element, laneEntry.objective.laneId);
    assert.equal(laneEntry.objective.type, "defend");
    assert.ok(Number.isFinite(laneEntry.objective.lanePoint.x));
    assert.ok(Number.isFinite(laneEntry.objective.post.x));
    // The post stays inside the hold radius — no hold-veto escape.
    const postDist = Math.hypot(laneEntry.objective.post.x, laneEntry.objective.post.y) / 100;
    assert.ok(postDist <= 6 + 1e-6, `post inside radius: ${postDist}`);
    const lane = result.descriptor.objective.lanes[0];
    assert.ok(Number.isFinite(lane.bearingDeg));
    assert.ok(Array.isArray(lane.threatIds));
    assert.ok(Number.isFinite(lane.threatWeight));
    assert.ok(Number.isFinite(lane.etaRounds));
    assert.ok(Number.isFinite(lane.quality));
    assert.equal(typeof lane.sourceBreakdown.route, "number");
    assert.equal(result.descriptor.maxDetachedPhases, 0);
    assert.equal(result.descriptor.allowFlank, false);
    assert.equal(result.descriptor.regroup, false);
});

test("assignment: leader marker is not a role mutex", () => {
    // The leader stands next to the eastern post — it wins the lane and
    // keeps `leader: true` next to the overwatch-lane role.
    const onLane = evaluateChokepointDefense(baseInput({
        members: [
            memberEntry("m1", { position: { x: 400, y: 0 } }),
            memberEntry("m2", { position: { x: 0, y: 0 } })
        ],
        targets: [liveThreat("t1", 2000, 0)]
    }));
    assert.equal(onLane.active, true, onLane.reason);
    const leaderAssignment = onLane.descriptor.assignments.m1;
    assert.equal(leaderAssignment.role, "overwatch-lane");
    assert.equal(leaderAssignment.leader, true);

    // Off the lanes the leader holds the anchor with the leader role —
    // and never joins the reserve counterattack pool.
    const offLane = evaluateChokepointDefense(baseInput({
        members: [
            memberEntry("m1", { position: { x: -400, y: 0 } }),
            memberEntry("m2", { position: { x: 400, y: 0 } })
        ],
        targets: [liveThreat("t1", 2000, 0)]
    }));
    const anchor = offLane.descriptor.assignments.m1;
    assert.equal(anchor.role, "leader");
    assert.equal(anchor.leader, true);
    assert.equal(anchor.element, "main");
});

test("sticky identity: committed lane hint id inherited within drift tolerance", () => {
    // m1 stands next to the eastern post, m2 far behind the anchor —
    // without any hint m1 is strictly the better watcher.
    const members = [
        memberEntry("m1", { position: { x: 400, y: 0 } }),
        memberEntry("m2", { position: { x: -300, y: 0 } })
    ];
    const threatPos = polar(0, 20);
    const input = baseInput({
        members,
        targets: [liveThreat("t1", threatPos.x, threatPos.y)]
    });
    const first = evaluateChokepointDefense(input);
    assert.equal(first.active, true, first.reason);
    const lane = first.descriptor.objective.lanes[0];
    const watcherOf = result => Object.entries(result.descriptor.assignments)
        .filter(([, value]) => value.role === "overwatch-lane")
        .map(([key]) => key);
    assert.deepEqual(watcherOf(first), ["m1"]);

    // Round two: the threat drifted slightly; the committed hint of m2
    // names the old lane geometry. The lane inherits the hint id…
    const drifted = polar(3, 20);
    const hinted = evaluateChokepointDefense({
        ...input,
        targets: [liveThreat("t1", drifted.x, drifted.y)],
        laneHints: [{
            memberId: "m2",
            laneId: "lane-committed-east",
            bearingDeg: lane.bearingDeg,
            chokepoint: { ...lane.chokepoint }
        }]
    });
    assert.equal(hinted.active, true, hinted.reason);
    assert.equal(hinted.descriptor.objective.lanes[0].id, "lane-committed-east");
    // …and the sticky bonus keeps the hinting member on its lane despite
    // the worse post distance (+2 overcomes the 1.75 suitability gap).
    assert.deepEqual(watcherOf(hinted), ["m2"]);

    // Counterfactual: the same drifted round without the hint keeps m1.
    const unhinted = evaluateChokepointDefense({
        ...input,
        targets: [liveThreat("t1", drifted.x, drifted.y)]
    });
    assert.deepEqual(watcherOf(unhinted), ["m1"]);
});

test("sticky identity: large drift drops the hint and re-keys the lane", () => {
    const threatPos = polar(0, 20);
    const input = baseInput({
        targets: [liveThreat("t1", threatPos.x, threatPos.y)]
    });
    const first = evaluateChokepointDefense(input);
    const lane = first.descriptor.objective.lanes[0];

    // The hint points at a chokepoint 10 m away — outside the 4 m
    // matching tolerance: the lane keeps its quantized geometry id.
    const farChoke = { x: lane.chokepoint.x + 1000, y: lane.chokepoint.y };
    const second = evaluateChokepointDefense({
        ...input,
        laneHints: [{
            memberId: "m2",
            laneId: "lane-committed-east",
            bearingDeg: lane.bearingDeg,
            chokepoint: farChoke
        }]
    });
    assert.notEqual(second.descriptor.objective.lanes[0].id, "lane-committed-east");
    assert.equal(second.descriptor.objective.lanes[0].id, lane.id);
});

test("sticky identity: quantized base id stable inside the quantum, changes outside", () => {
    const base = laneBaseId(ANCHOR, { x: 800, y: 0 }, GRID);
    // 1 m drift — inside the 2 m quantum rounding.
    assert.equal(laneBaseId(ANCHOR, { x: 890, y: 50 }, GRID), base);
    // 5 m drift — a different cell.
    assert.notEqual(laneBaseId(ANCHOR, { x: 1300, y: 0 }, GRID), base);
});

test("committedLaneHints: reads valid committed plans, skips cancelled/expired", () => {
    const lanePayload = {
        status: "active",
        createdRound: 1,
        ttl: 2,
        steps: [{
            type: "overwatch",
            input: { lane: { id: "lane-x", bearingDeg: 90, chokepoint: { x: 500, y: 0 } } }
        }]
    };
    const withPlan = flagValue => {
        const combatant = makeCombatant({ id: "c1" });
        combatant.flags = { [MODULE_ID]: { [FLAG_KEYS.committedPlan]: flagValue } };
        combatant.getFlag = (scope, key) => combatant.flags?.[scope]?.[key];
        return memberEntry("c1", { combatant });
    };
    const valid = committedLaneHints([withPlan(lanePayload)], { round: 1 });
    assert.equal(valid.length, 1);
    assert.equal(valid[0].laneId, "lane-x");
    assert.equal(valid[0].memberId, "c1");
    assert.deepEqual(valid[0].chokepoint, { x: 500, y: 0 });

    // TTL: round 3 - createdRound 1 >= ttl 2 — expired.
    assert.equal(committedLaneHints([withPlan(lanePayload)], { round: 3 }).length, 0);
    // Cancelled records never hint.
    assert.equal(committedLaneHints([withPlan({ ...lanePayload, status: "cancelled" })], { round: 1 }).length, 0);
});

test("purity: the selector never writes flags or mutates its input", () => {
    const actor = makeActor({ id: "actor-m1" });
    const combatant = makeCombatant({ id: "m1", actor });
    const forbidden = () => {
        throw new Error("selector must not write");
    };
    combatant.setFlag = forbidden;
    actor.setFlag = forbidden;
    const members = [
        memberEntry("m1", { combatant }),
        memberEntry("m2", { position: { x: 100, y: 0 } })
    ];
    const input = baseInput({
        members,
        targets: [liveThreat("t1", 2000, 0)]
    });
    const snapshot = freezeDeep(structuredClone({
        members: input.members.map(member => ({
            combatantId: member.combatantId,
            position: member.position
        })),
        targets: input.targets
    }));
    const result = evaluateChokepointDefense(input);
    assert.equal(result.active, true, result.reason);
    assert.deepEqual(
        input.members.map(member => ({ combatantId: member.combatantId, position: member.position })),
        snapshot.members
    );
    assert.deepEqual(input.targets, snapshot.targets);
});

test("determinism: shuffled member and threat order yields the identical descriptor", () => {
    const threats = [0, 90, 200].map((bearing, index) => {
        const pos = polar(bearing, 15);
        return liveThreat(`t${index}`, pos.x, pos.y);
    });
    const mkMembers = order => order.map(id => memberEntry(id));
    const mkProfiles = () => ({
        m1: rangedProfile(),
        m2: rangedProfile(),
        m3: rangedProfile()
    });
    const forward = evaluateChokepointDefense(baseInput({
        members: mkMembers(["m1", "m2", "m3"]),
        memberProfiles: mkProfiles(),
        targets: threats
    }));
    const shuffled = evaluateChokepointDefense(baseInput({
        members: mkMembers(["m3", "m1", "m2"]),
        memberProfiles: mkProfiles(),
        targets: [threats[2], threats[0], threats[1]]
    }));
    assert.equal(forward.active, true);
    assert.equal(shuffled.active, true);
    assert.deepEqual(shuffled.descriptor, forward.descriptor);
});

// ---------------------------------------------------------------------------
// 3. Counterattack and degradation
// ---------------------------------------------------------------------------

/**
 * Counterattack fixture: three ranged members at the anchor, a lane of
 * three threats east and a breakthrough target inside the hold radius.
 * The outside lane weight deliberately dominates the live picture so an
 * inactive counterattack does not tip the scenario into the (correctly
 * behaving) defense-bypassed degradation.
 * @param {object} targetOverrides
 * @param {object} [inputOverrides]
 * @returns {object} Evaluation result.
 */
function counterattackScenario(targetOverrides = {}, inputOverrides = {}) {
    const members = [
        memberEntry("m1"),
        memberEntry("m2"),
        memberEntry("m3")
    ];
    const profiles = {
        m1: rangedProfile(),
        m2: rangedProfile(),
        m3: rangedProfile()
    };
    return evaluateChokepointDefense(baseInput({
        members,
        memberProfiles: profiles,
        targets: [
            liveThreat("lane-threat-a", 2000, 0),
            liveThreat("lane-threat-b", 2000, 150),
            liveThreat("lane-threat-c", 2000, -150),
            liveThreat("intruder", 400, 0, { halfMove: 4, ...targetOverrides })
        ],
        ...inputOverrides
    }));
}

test("counterattack: pinned intruder triggers the reserve assault for disciplined teams", () => {
    const result = counterattackScenario({ statuses: ["pinned"] }, { character: "disciplined" });
    assert.equal(result.active, true, result.reason);
    const counterattack = result.descriptor.objective.counterattack;
    assert.equal(counterattack.active, true);
    assert.equal(counterattack.targetId, "intruder");
    // pinned (+2) + focus of fire of three in-range members (+2).
    assert.equal(counterattack.vulnerabilityScore, 4);
    const reserve = Object.values(result.descriptor.assignments)
        .find(value => value.role === "reserve");
    assert.ok(reserve, "a reserve exists");
    assert.equal(reserve.task, "assault");
    assert.equal(reserve.objective.targetId, "intruder");
    assert.equal(reserve.objective.targetTokenUuid, "Scene.scene-1.Token.intruder");
});

test("counterattack: discipline gate — focus-only vulnerability fails shock, passes disciplined", () => {
    // No statuses, no spent reaction: vulnerability is only the focus
    // bonus (+2).
    const disciplined = counterattackScenario({}, { character: "disciplined" });
    assert.equal(disciplined.descriptor.objective.counterattack.active, true);
    assert.equal(disciplined.descriptor.objective.counterattack.vulnerabilityScore, 2);

    const shock = counterattackScenario({}, { character: "shock" });
    assert.equal(shock.descriptor.objective.counterattack.active, false);
    assert.equal(shock.descriptor.objective.counterattack.reason, "threshold-unmet");

    // The unknown/absent character falls back to the conservative gate.
    const anonymous = counterattackScenario({});
    assert.equal(anonymous.descriptor.objective.counterattack.active, false);

    // Rabble never coordinates a counterattack.
    const rabble = counterattackScenario({ statuses: ["pinned"], reactionUsed: true },
        { character: "rabble" });
    assert.equal(rabble.descriptor.objective.counterattack.active, false);
    assert.equal(rabble.descriptor.objective.counterattack.reason, "rabble-undisciplined");
});

test("counterattack: vulnerable statuses do not stack; memory and outside targets never qualify", () => {
    const stacked = counterattackScenario(
        { statuses: ["pinned", "prone", "stunned"] },
        { character: "disciplined" }
    );
    // Still a single +2 status contribution plus focus.
    assert.equal(stacked.descriptor.objective.counterattack.vulnerabilityScore, 4);

    // A memory contact inside the zone never triggers the strike.
    const memoryOnly = evaluateChokepointDefense(baseInput({
        members: [memberEntry("m1"), memberEntry("m2"), memberEntry("m3")],
        memberProfiles: {
            m1: rangedProfile(),
            m2: rangedProfile(),
            m3: rangedProfile()
        },
        targets: [liveThreat("lane-threat", 2000, 0)],
        teamContacts: [{
            tokenUuid: "Scene.scene-1.Token.ghost",
            x: 400,
            y: 0,
            statuses: ["pinned"],
            lastSeenRound: 1
        }],
        character: "disciplined"
    }));
    assert.equal(memoryOnly.active, true, memoryOnly.reason);
    assert.equal(memoryOnly.descriptor.objective.counterattack.active, false);

    // A live target outside the kill zone is not a candidate either.
    const outside = evaluateChokepointDefense(baseInput({
        members: [memberEntry("m1"), memberEntry("m2"), memberEntry("m3")],
        memberProfiles: {
            m1: rangedProfile(),
            m2: rangedProfile(),
            m3: rangedProfile()
        },
        targets: [
            liveThreat("lane-threat", 2000, 0),
            liveThreat("far-pinned", 2000, 1500, { statuses: ["pinned"] })
        ],
        character: "disciplined"
    }));
    const counterattack = outside.descriptor.objective.counterattack;
    assert.equal(counterattack.active, false);
    assert.notEqual(counterattack.targetId, "far-pinned");
});

test("insideKillZone: radius pad, lane sector depth and negative controls", () => {
    const lane = {
        bearingDeg: 0,
        widthDeg: 0,
        chokepoint: { x: 800, y: 0 }
    };
    const input = { anchor: ANCHOR, lanes: [lane], grid: GRID };
    // Inside the padded radius.
    assert.equal(insideKillZone({ x: 640, y: 0 }, input), true);
    // Outside the radius but in the lane sector, 1+ m past the chokepoint.
    assert.equal(insideKillZone({ x: 690, y: 80 }, input), true);
    // Same range but outside the lane sector (bearing ≈ -30 deg).
    assert.equal(insideKillZone({ x: 690, y: -400 }, input), false);
    // In the sector but not yet deep enough past the chokepoint.
    assert.equal(insideKillZone({ x: 750, y: 60 }, input), false);
});

test("degradation: majority live weight inside without vulnerability bypasses the defense", () => {
    const input = baseInput({
        members: [memberEntry("m1"), memberEntry("m2")],
        targets: [
            liveThreat("in1", 300, 0),
            liveThreat("in2", 400, 0),
            liveThreat("out", 1500, 0)
        ]
        // No character — conservative threshold 3; focus-only
        // vulnerability is 2, so no legal counterattack target.
    });
    const result = evaluateChokepointDefense(input);
    assert.equal(result.active, false);
    assert.equal(result.reason, "defense-bypassed");
    assert.equal(result.descriptor, null);

    // A pinned intruder is a legal counterattack target — the defense
    // stays meaningful and no bypass degradation fires.
    const vulnerable = evaluateChokepointDefense({
        ...input,
        targets: [
            liveThreat("in1", 300, 0, { statuses: ["pinned"] }),
            liveThreat("in2", 400, 0),
            liveThreat("out", 1500, 0)
        ]
    });
    assert.equal(vulnerable.active, true, vulnerable.reason);
    assert.equal(vulnerable.descriptor.objective.counterattack.active, true);
});

test("degradation: spread beyond the lane budget outflanks the defense", () => {
    // Seven evenly distributed approach directions — the three covered
    // lanes cannot hold the majority of the live weight.
    const threats = Array.from({ length: 7 }, (unused, index) => {
        const pos = polar((index * 360) / 7, 15);
        return liveThreat(`t${index}`, pos.x, pos.y);
    });
    const result = evaluateChokepointDefense(baseInput({
        members: [memberEntry("m1"), memberEntry("m2"), memberEntry("m3"), memberEntry("m4")],
        memberProfiles: {
            m1: rangedProfile(),
            m2: rangedProfile(),
            m3: rangedProfile(),
            m4: rangedProfile()
        },
        targets: threats
    }));
    assert.equal(result.active, false);
    assert.equal(result.reason, "defense-outflanked");
    assert.ok(result.breakdown.droppedThreatIds.length >= 4,
        `dropped ${result.breakdown.droppedThreatIds.length}`);
});

test("degradation: no perceived threat inside the horizon", () => {
    const empty = evaluateChokepointDefense(baseInput({ targets: [] }));
    assert.equal(empty.active, false);
    assert.equal(empty.reason, "no-perceived-threat");

    // A contact beyond the engagement horizon does not count.
    const far = evaluateChokepointDefense(baseInput({
        targets: [liveThreat("far", 5000, 0)]
    }));
    assert.equal(far.active, false);
    assert.equal(far.reason, "no-perceived-threat");
});

test("degradation: no overwatch-capable member", () => {
    // The melee-only team caps the engagement horizon at 18 m — the
    // threat must sit inside it for the overwatch gate to be what fails.
    const result = evaluateChokepointDefense(baseInput({
        memberProfiles: {
            m1: rangedProfile({ bestRangeM: 0, meleeOnly: true }),
            m2: rangedProfile({ bestRangeM: 0, meleeOnly: true })
        },
        targets: [liveThreat("t1", 1500, 0)]
    }));
    assert.equal(result.active, false);
    assert.equal(result.reason, "no-overwatcher");
});

test("degradation: objective and posture gates", () => {
    const threat = liveThreat("t1", 2000, 0);
    const complete = evaluateChokepointDefense(baseInput({
        objective: { type: "defend", anchor: { x: 0, y: 0 }, complete: true },
        targets: [threat]
    }));
    assert.equal(complete.reason, "objective-complete");

    const mismatch = evaluateChokepointDefense(baseInput({
        objective: { targetId: "enemy-1" },
        targets: [threat]
    }));
    assert.equal(mismatch.reason, "objective-mismatch");

    const typedMismatch = evaluateChokepointDefense(baseInput({
        objective: { type: "assault", targetId: "enemy-1" },
        targets: [threat]
    }));
    assert.equal(typedMismatch.reason, "objective-mismatch");

    const regrouping = evaluateChokepointDefense(baseInput({
        targets: [threat],
        context: {
            hold: { anchor: { x: 0, y: 0 }, radiusMeters: 6 },
            scene: SCENE,
            round: 1,
            regroup: true
        }
    }));
    assert.equal(regrouping.reason, "regroup-active");

    const lonely = evaluateChokepointDefense(baseInput({
        members: [memberEntry("m1")],
        memberProfiles: { m1: rangedProfile() },
        targets: [threat]
    }));
    assert.equal(lonely.reason, "insufficient-members");

    const anchorless = evaluateChokepointDefense(baseInput({
        members: [
            memberEntry("m1", { position: null }),
            memberEntry("m2", { position: null })
        ],
        context: { scene: SCENE, round: 1 },
        targets: [threat]
    }));
    assert.equal(anchorless.reason, "no-defense-anchor");
});

test("degradation: defeat of the overwatcher re-evaluates deterministically instead of flickering", () => {
    const members = [
        memberEntry("m1"),
        memberEntry("m2", { position: { x: 100, y: 0 } }),
        memberEntry("m3", { position: { x: 0, y: 100 } })
    ];
    const threat = liveThreat("t1", 1500, 0);
    const aliveProfiles = {
        m1: rangedProfile(),
        m2: rangedProfile(),
        m3: rangedProfile()
    };
    const alive = evaluateChokepointDefense(baseInput({
        members,
        memberProfiles: aliveProfiles,
        targets: [threat]
    }));
    assert.equal(alive.active, true, alive.reason);

    // The only ranged member falls: the surviving melee pair cannot
    // hold a lane — one stable degradation reason, no flicker.
    const fallenInput = baseInput({
        members: [
            { ...members[0], defeated: true },
            members[1],
            members[2]
        ],
        memberProfiles: {
            m1: rangedProfile(),
            m2: rangedProfile({ bestRangeM: 0, meleeOnly: true }),
            m3: rangedProfile({ bestRangeM: 0, meleeOnly: true })
        },
        targets: [threat]
    });
    const fallen = evaluateChokepointDefense(fallenInput);
    assert.equal(fallen.active, false);
    assert.equal(fallen.reason, "no-overwatcher");
    const repeat = evaluateChokepointDefense(fallenInput);
    assert.equal(repeat.reason, fallen.reason);
    assert.deepEqual(repeat.breakdown, fallen.breakdown);
});

// ---------------------------------------------------------------------------
// 4. Serializable contract
// ---------------------------------------------------------------------------

test("contract: descriptor survives a JSON round-trip byte-identical", () => {
    const threats = [0, 120].map((bearing, index) => {
        const pos = polar(bearing, 15);
        return liveThreat(`t${index}`, pos.x, pos.y, { statuses: index === 0 ? ["pinned"] : [] });
    });
    const result = evaluateChokepointDefense(baseInput({
        members: [memberEntry("m1"), memberEntry("m2"), memberEntry("m3")],
        memberProfiles: {
            m1: rangedProfile(),
            m2: rangedProfile(),
            m3: rangedProfile()
        },
        targets: threats,
        character: "disciplined"
    }));
    assert.equal(result.active, true, result.reason);
    const roundTrip = JSON.parse(JSON.stringify(result.descriptor));
    assert.deepEqual(roundTrip, result.descriptor);
    // Two serializations of the same descriptor are byte-identical.
    assert.equal(JSON.stringify(result.descriptor), JSON.stringify(roundTrip));
    // No document references leak into the output.
    const serialized = JSON.stringify(result.descriptor);
    assert.ok(!serialized.includes("tokenDoc"), "no document refs");
    assert.equal(result.descriptor.name, CHOKEPOINT_TACTIC_NAME);
});

test("contract: degradation output is serializable and carries the tuning echo", () => {
    const result = evaluateChokepointDefense(baseInput({ targets: [] }));
    assert.equal(result.active, false);
    const roundTrip = JSON.parse(JSON.stringify(result));
    assert.deepEqual(roundTrip.breakdown.constants, CHOKEPOINT_CONSTANTS);
    assert.deepEqual(roundTrip, JSON.parse(JSON.stringify(roundTrip)));
});

test("contract: selectChokepointDefense mirrors the fireteam tactic factory shape", () => {
    const descriptor = selectChokepointDefense(baseInput({
        targets: [liveThreat("t1", 2000, 0)]
    }));
    assert.equal(descriptor.name, "chokepoint-defense");
    assert.equal(typeof descriptor.assignments, "object");
    assert.equal(descriptor.objective.type, "defend");

    const degraded = selectChokepointDefense(baseInput({ targets: [] }));
    assert.equal(degraded, null);
});

test("buildMemberProfile: weapon items derive range, suppression and reaction state", () => {
    const actor = makeActor();
    actor.items = [
        {
            id: "w1",
            name: "Lasgun",
            type: "weapon",
            system: { class: "basic", range: 100, rateOfFire: { burst: 3, full: 0 } }
        },
        {
            id: "w2",
            name: "Knife",
            type: "weapon",
            system: { class: "melee", range: 0 }
        }
    ];
    const combatant = makeCombatant({ actor });
    combatant.flags = {
        [MODULE_ID]: { [FLAG_KEYS.reactionUsed]: { round: 2 } }
    };
    combatant.getFlag = (scope, key) => combatant.flags?.[scope]?.[key];
    const member = memberEntry("cx", { combatant });
    const profile = buildMemberProfile(member, { round: 2 });
    assert.equal(profile.bestRangeM, 100);
    assert.equal(profile.suppressionCapable, true);
    assert.equal(profile.meleeOnly, false);
    assert.equal(profile.reactionUsed, true);
    // A past round's reaction record does not count as spent.
    assert.equal(buildMemberProfile(member, { round: 3 }).reactionUsed, false);
});

test("lanePost: stays inside the radius and off the chokepoint", () => {
    const post = lanePost(ANCHOR, { x: 800, y: 0 }, GRID);
    // min(6 * 0.75, 8 - 2) = 4.5 m along the ray.
    assert.ok(Math.abs(post.x - 450) < 1e-6, `post ${post.x}`);
    assert.equal(post.y, 0);
    // Degenerate geometry falls back to the anchor itself.
    const degenerate = lanePost(ANCHOR, { x: 0, y: 0 }, GRID);
    assert.deepEqual(degenerate, { x: 0, y: 0 });
});

test("assignMembersToLanes: exposed helper is injective and deterministic", () => {
    const lanes = [
        { id: "lane-a", chokepoint: { x: 800, y: 0 }, post: { x: 450, y: 0 }, bearingDeg: 0 },
        { id: "lane-b", chokepoint: { x: -800, y: 0 }, post: { x: -450, y: 0 }, bearingDeg: 180 }
    ];
    const members = [memberEntry("m1"), memberEntry("m2"), memberEntry("m3")];
    const profiles = { m1: rangedProfile(), m2: rangedProfile(), m3: rangedProfile() };
    const first = assignMembersToLanes({ members, lanes, profiles, grid: GRID });
    const second = assignMembersToLanes({
        members: [...members].reverse(),
        lanes,
        profiles,
        grid: GRID
    });
    assert.equal(first.key, second.key);
    const laneIds = [...first.assignments.values()].map(slot => slot.lane.id);
    assert.equal(new Set(laneIds).size, laneIds.length, "injective");
    // Three members, two lanes, cap two: exactly one lane left uncovered
    // or both covered with one member in reserve — never three watchers.
    assert.ok(first.assignments.size <= 2);
});

test("assignLaneIdentities: collision suffixes are deterministic in lane order", () => {
    const lane = (id, x, y) => ({
        bearingDeg: 0,
        chokepoint: { x, y },
        threatIds: [`u-${id}`],
        threatWeight: 1,
        liveWeight: 1,
        etaRounds: 1,
        quality: 1,
        widthDeg: 0,
        widthMeters: 0,
        sourceBreakdown: { route: 1, partial: 0, straight: 0, close: 0, memory: 0 }
    });
    // Two lanes quantizing into the same cell pick up -2 in sort order.
    const lanes = [lane("a", 800, 10), lane("b", 810, -10)];
    const identified = assignLaneIdentities(lanes, [], { anchor: ANCHOR, grid: GRID });
    const ids = identified.map(entry => entry.id);
    assert.equal(new Set(ids).size, 2, `unique ids ${ids}`);
    assert.equal(identified[0].id, identified[0].baseId);
    assert.equal(identified[1].id, `${identified[1].baseId}-2`);
});
