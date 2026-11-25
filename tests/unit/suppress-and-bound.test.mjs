/**
 * Hand-computed unit tests for the pure suppress-and-bound core (issue #86):
 * capability and ammo gates, weighted cone coverage, deterministic suppressor
 * tie-breaks, role assignments, degradation reasons and JSON round-trips.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    BOUND_NEED_COVERAGE_MIN,
    LAST_KNOWN_WEIGHT,
    SUPPRESS_AND_BOUND,
    SUPPRESSION_COVERAGE_MIN,
    assessSuppressAndBound,
    explainSuppressAndBound,
    findBestSuppressionCone,
    scanSuppressionCapability
} from "../../scripts/tactics/suppress-and-bound.js";

/**
 * Weapon item fixture.
 * @param {object} [options]
 * @returns {object}
 */
function makeWeapon({
    id = "w1",
    cls = "basic",
    range = 100,
    burst = 6,
    full = 10,
    clip = 30,
    clipMax = 30,
    ammoPerShot = 1,
    jammed = false,
    modified = null
} = {}) {
    const system = {
        class: cls,
        range,
        rateOfFire: { single: 1, burst, full },
        clip: { value: clip, max: clipMax },
        ammoPerShot,
        jammed
    };
    if (modified) system.modified = { rateOfFire: modified };
    return {
        id,
        uuid: `uuid-${id}`,
        name: `Weapon ${id}`,
        type: "weapon",
        system
    };
}

/**
 * Member DTO fixture. `positionIsCenter` mirrors the normalized adapter
 * contract; the core never derives turn order by itself.
 * @param {string} id
 * @param {object} [options]
 * @returns {object}
 */
function makeMember(id, {
    x = 0,
    y = 0,
    turnIndex = 0,
    hasActed = false,
    items = null,
    disposition = -1,
    enabled = true,
    defeated = false
} = {}) {
    const token = {
        id: `token-${id}`,
        uuid: `token-uuid-${id}`,
        disposition,
        width: 1,
        height: 1,
        x,
        y
    };
    const combatant = {
        id,
        token,
        disposition,
        actor: {
            id: `actor-${id}`,
            items: items ?? [makeWeapon({ id: `w-${id}` })]
        }
    };
    return {
        combatant: { ...combatant, defeated },
        combatantId: id,
        tokenId: token.id,
        actorId: combatant.actor.id,
        position: { x, y },
        positionIsCenter: true,
        turnIndex,
        hasActed,
        enabled,
        defeated
    };
}

/**
 * Hostile target fixture. Coordinates are pixel centres.
 * @param {string} id
 * @param {number} x
 * @param {number} y
 * @param {object} [options]
 * @returns {object}
 */
function makeTarget(id, x, y, {
    source = "visible",
    statuses = [],
    hidden = false,
    disposition = 1
} = {}) {
    return {
        tokenId: id,
        tokenUuid: `uuid-${id}`,
        x,
        y,
        elevation: 0,
        source,
        statuses,
        hidden,
        disposition,
        canAttack: source === "visible"
    };
}

/**
 * Standard three-man team east of a two-target cluster. Every member can
 * cover both targets; m1 at the same height aims exactly at bearing 0.
 * @param {object} [overrides] Per-member option overrides.
 * @returns {object[]}
 */
function standardMembers(overrides = {}) {
    return [
        makeMember("m1", { x: 0, y: 0, ...(overrides.m1 ?? {}) }),
        makeMember("m2", { x: 0, y: -30, ...(overrides.m2 ?? {}) }),
        makeMember("m3", { x: 0, y: 30, ...(overrides.m3 ?? {}) })
    ];
}

/**
 * Standard target pair symmetric around bearing 0.
 * @param {object} [overrides]
 * @returns {object[]}
 */
function standardTargets(overrides = {}) {
    return [
        makeTarget("e1", 50, -10, overrides.e1 ?? {}),
        makeTarget("e2", 50, 10, overrides.e2 ?? {})
    ];
}

/**
 * Build selector input with explicit centre-based scene-token geometry.
 * @param {object[]} members
 * @param {object[]} targets
 * @param {object} [options]
 * @returns {object}
 */
function makeInput(members, targets, {
    extraTokens = [],
    context = {},
    objective = null,
    combat = null,
    config = null,
    casualties = 0
} = {}) {
    const sceneTokens = [
        ...members.map(member => ({
            tokenId: member.tokenId,
            x: member.position.x,
            y: member.position.y,
            disposition: member.combatant.disposition
        })),
        ...targets.map(target => ({
            tokenId: target.tokenId,
            tokenUuid: target.tokenUuid,
            x: target.x,
            y: target.y,
            disposition: target.disposition,
            hidden: target.hidden
        })),
        ...extraTokens
    ];
    return {
        members,
        targets,
        objective,
        combat,
        config,
        casualties,
        context: {
            pxPerUnit: 1,
            sceneTokens,
            ...context
        }
    };
}

/* ------------------------------------------------------------------ */
/* Capability scan                                                     */
/* ------------------------------------------------------------------ */

test("capability scan gates melee/thrown/grenade and single-shot weapons with reasons", () => {
    const member = makeMember("m", {
        items: [
            makeWeapon({ id: "melee", cls: "melee", burst: 6, full: 0 }),
            makeWeapon({ id: "thrown", cls: "thrown", burst: 6, full: 0 }),
            makeWeapon({ id: "launcher", cls: "launched", burst: 6, full: 0 }),
            makeWeapon({ id: "single", burst: 0, full: 0 })
        ]
    });
    member.combatant.actor.items[2].system.usesGrenade = true;
    const scan = scanSuppressionCapability(member);
    assert.equal(scan.capable, false);
    const byId = Object.fromEntries(scan.weapons.map(row => [row.itemId, row]));
    assert.deepEqual(byId.melee.reasons, ["not-ranged"]);
    assert.deepEqual(byId.thrown.reasons, ["not-ranged"]);
    assert.deepEqual(byId.launcher.reasons, ["not-ranged"]);
    assert.deepEqual(byId.single.reasons, ["no-autofire"]);
    assert.ok(scan.reasons.includes("not-ranged"));
    assert.ok(scan.reasons.includes("no-autofire"));
});

test("modified rateOfFire replaces base RoF and suppression uses semi before full", () => {
    const enabledByMod = makeMember("m", {
        items: [makeWeapon({ id: "mod", burst: 0, full: 0, clip: 4, clipMax: 4, modified: { single: 1, burst: 4, full: 0 } })]
    });
    const scan = scanSuppressionCapability(enabledByMod);
    assert.equal(scan.capable, true);
    assert.equal(scan.weapon.burstMode, "semi_auto");
    assert.equal(scan.weapon.modifiedRateOfFire, true);
    assert.equal(scan.weapon.ammoCost, 4);
    assert.equal(scan.weapon.clipAfter, 0);
    assert.equal(scan.weapon.attackType, "suppressing_fire");

    const disabledByMod = makeMember("m2", {
        items: [makeWeapon({ id: "mod-off", burst: 6, full: 10, modified: { single: 1, burst: 0, full: 0 } })]
    });
    const offScan = scanSuppressionCapability(disabledByMod);
    assert.equal(offScan.capable, false);
    assert.deepEqual(offScan.weapons[0].reasons, ["no-autofire"]);
});

test("ammo gate uses exact full-burst cost times ammoPerShot; jam is a refusal", () => {
    const exact = scanSuppressionCapability(makeMember("exact", {
        items: [makeWeapon({ id: "full", burst: 0, full: 8, clip: 16, clipMax: 16, ammoPerShot: 2 })]
    }));
    assert.equal(exact.capable, true);
    assert.equal(exact.weapon.burstMode, "full_auto");
    assert.equal(exact.weapon.ammoCost, 16);
    assert.equal(exact.weapon.clipAfter, 0);

    const short = scanSuppressionCapability(makeMember("short", {
        items: [makeWeapon({ id: "full", burst: 0, full: 8, clip: 15, clipMax: 16, ammoPerShot: 2 })]
    }));
    assert.equal(short.capable, false);
    assert.deepEqual(short.weapons[0].reasons, ["low-ammo"]);

    const jammed = scanSuppressionCapability(makeMember("jam", {
        items: [makeWeapon({ id: "jam", jammed: true, clip: 30 })]
    }));
    assert.equal(jammed.capable, false);
    assert.deepEqual(jammed.weapons[0].reasons, ["jammed"]);
});

test("best capable weapon is chosen by clip percentage then range", () => {
    const scan = scanSuppressionCapability(makeMember("m", {
        items: [
            makeWeapon({ id: "long-low", range: 100, clip: 10, clipMax: 30 }),
            makeWeapon({ id: "short-high", range: 50, clip: 20, clipMax: 30 }),
            makeWeapon({ id: "long-high", range: 80, clip: 20, clipMax: 30 })
        ]
    }));
    assert.equal(scan.weapon.itemId, "long-high");
});

/* ------------------------------------------------------------------ */
/* Successful assessment and serialization                            */
/* ------------------------------------------------------------------ */

test("coverage two selects suppress-and-bound and assigns suppressor plus bound roles", () => {
    const input = makeInput(standardMembers(), standardTargets());
    const descriptor = assessSuppressAndBound(input);
    assert.ok(descriptor, "descriptor selected");
    assert.equal(descriptor.name, SUPPRESS_AND_BOUND);
    assert.equal(descriptor.reason, "coverage-threshold");
    assert.equal(descriptor.suppressorId, "m1");
    assert.equal(descriptor.coverage, 2);
    assert.equal(descriptor.allowFlank, false);
    assert.equal(descriptor.regroup, false);

    assert.deepEqual(descriptor.assignments.m1, {
        task: "support",
        role: "suppressor",
        element: "fire",
        objective: {
            type: SUPPRESS_AND_BOUND,
            targetId: "e1",
            targetUuid: "uuid-e1",
            targetPoint: { x: 50, y: -10 },
            flankPoint: null,
            lanePoint: null
        }
    });
    for (const id of ["m2", "m3"]) {
        assert.equal(descriptor.assignments[id].task, "advance");
        assert.equal(descriptor.assignments[id].role, "bound");
        assert.equal(descriptor.assignments[id].element, "maneuver");
        assert.equal(descriptor.assignments[id].objective.targetId, "e1");
    }

    assert.equal(descriptor.cone.direction, 0);
    assert.equal(descriptor.cone.angleDeg, 45);
    assert.equal(descriptor.cone.rangePx, 100);
    assert.equal(descriptor.cone.burstMode, "semi_auto");
    assert.deepEqual(descriptor.cone.coveredTokenUuids, ["uuid-e1", "uuid-e2"]);
    assert.deepEqual(descriptor.exclusionZone, {
        x: 0,
        y: 0,
        direction: 0,
        angleDeg: 45,
        rangePx: 100,
        ownerId: "m1",
        kind: "suppression"
    });
    assert.deepEqual(descriptor.exclusionZones, [descriptor.exclusionZone]);
    assert.equal(descriptor.breakdown.coefficients.coverageMin, SUPPRESSION_COVERAGE_MIN);
    assert.equal(descriptor.breakdown.coefficients.lastKnownWeight, LAST_KNOWN_WEIGHT);
    assert.equal(descriptor.breakdown.coefficients.boundNeedCoverageMin, BOUND_NEED_COVERAGE_MIN);

    const roundTrip = JSON.parse(JSON.stringify(descriptor));
    assert.deepEqual(roundTrip, descriptor, "descriptor is JSON-serializable without data loss");
});

test("explicit flank objective marks boundNeed and changes bound task to flank", () => {
    const objective = { flankPoint: { x: 90, y: 60 } };
    const input = makeInput(standardMembers(), standardTargets(), { objective });
    const descriptor = assessSuppressAndBound(input);
    assert.ok(descriptor);
    assert.equal(descriptor.reason, "coverage-and-bound-need");
    assert.equal(descriptor.boundNeed, true);
    assert.equal(descriptor.breakdown.boundNeedDetails.explicitManeuverObjective, true);
    assert.equal(descriptor.assignments.m2.task, "flank");
    assert.equal(descriptor.assignments.m3.task, "flank");
    assert.deepEqual(descriptor.objective.flankPoint, { x: 90, y: 60 });
});

test("a movement wall on the frontal probe is a measurable bound need", () => {
    const wall = { c: [25, -50, 25, 50], move: 1, sight: 0, door: null };
    const input = makeInput(standardMembers(), standardTargets(), {
        context: { walls: [wall] }
    });
    const descriptor = assessSuppressAndBound(input);
    assert.ok(descriptor);
    assert.equal(descriptor.boundNeed, true);
    assert.equal(descriptor.breakdown.boundNeedDetails.frontalBlocked, true);
    assert.equal(descriptor.reason, "coverage-and-bound-need");
});

/* ------------------------------------------------------------------ */
/* Weighted coverage and target exclusions                             */
/* ------------------------------------------------------------------ */

test("last-known targets weigh 0.5: 1.5 coverage is insufficient without bound need", () => {
    const targets = standardTargets({ e2: { source: "last-known" } });
    const input = makeInput(standardMembers(), targets);
    const explained = explainSuppressAndBound(input);
    assert.equal(explained.selected, false);
    assert.equal(explained.reason, "coverage-insufficient");
    assert.equal(explained.breakdown.coverage, 1.5);
    assert.equal(assessSuppressAndBound(input), null);
});

test("one weighted target plus real bound need passes the lower trigger", () => {
    const targets = [makeTarget("e1", 50, 0)];
    const objective = { flankPoint: { x: 80, y: 40 } };
    const input = makeInput(standardMembers(), targets, { objective });
    const descriptor = assessSuppressAndBound(input);
    assert.ok(descriptor);
    assert.equal(descriptor.coverage, 1);
    assert.equal(descriptor.breakdown.coverageRule, "bound-need");
    assert.equal(descriptor.reason, "coverage-and-bound-need");
});

test("one visible plus two last-known anchors reach coverage two", () => {
    const targets = [
        makeTarget("e1", 50, -10),
        makeTarget("e2", 50, 0, { source: "last-known" }),
        makeTarget("e3", 50, 10, { source: "last-known" })
    ];
    const input = makeInput(standardMembers(), targets);
    const descriptor = assessSuppressAndBound(input);
    assert.ok(descriptor);
    assert.equal(descriptor.coverage, 2);
    assert.equal(descriptor.cone.hits, 3);
});

test("pinned and hidden targets are excluded from coverage with diagnostics", () => {
    const pinnedInput = makeInput(standardMembers(), standardTargets({
        e1: { statuses: ["pinned"] },
        e2: { statuses: ["pinned"] }
    }));
    const pinned = explainSuppressAndBound(pinnedInput);
    assert.equal(pinned.selected, false);
    assert.equal(pinned.reason, "all-pinned");
    assert.equal(pinned.breakdown.pinnedExcluded, 2);

    const mixedInput = makeInput(standardMembers(), standardTargets({
        e1: { statuses: ["pinned"] }
    }));
    const mixed = explainSuppressAndBound(mixedInput);
    assert.equal(mixed.reason, "coverage-insufficient");
    assert.equal(mixed.breakdown.coverage, 1);
    assert.equal(mixed.breakdown.pinnedExcluded, 1);

    const hiddenInput = makeInput(standardMembers(), standardTargets({
        e2: { hidden: true }
    }));
    const hidden = explainSuppressAndBound(hiddenInput);
    assert.equal(hidden.reason, "coverage-insufficient");
    assert.equal(hidden.breakdown.hiddenExcluded, 1);
    assert.equal(hidden.breakdown.coverableTargets, 1);
});

test("weighted cone choice prefers two visible targets over three last-known targets", () => {
    // From the origin the visible pair lies east (bearing 0) while three
    // memory contacts form a tight northern cluster (bearing ~270): no 45°
    // cone can cover both groups, so weighted maximization chooses 2 over 1.5
    // even though the memory cluster has more raw anchors (3 over 2).
    const anchors = [
        { tokenId: "v1", x: 50, y: -5, weight: 1, source: "visible" },
        { tokenId: "v2", x: 50, y: 5, weight: 1, source: "visible" },
        { tokenId: "l1", x: 0, y: -50, weight: LAST_KNOWN_WEIGHT, source: "last-known" },
        { tokenId: "l2", x: 5, y: -50, weight: LAST_KNOWN_WEIGHT, source: "last-known" },
        { tokenId: "l3", x: -5, y: -50, weight: LAST_KNOWN_WEIGHT, source: "last-known" }
    ];
    const cone = findBestSuppressionCone({
        origin: { x: 0, y: 0 },
        rangePx: 100,
        angleDeg: 45,
        tokens: [],
        anchors,
        viewerDisposition: -1
    });
    assert.ok(cone);
    assert.equal(cone.coverage, 2);
    assert.equal(cone.hits, 2, "two weight-1 visible targets beat three weight-0.5 memories");
    assert.deepEqual(cone.covered.map(entry => entry.tokenId), ["v1", "v2"]);
});

/* ------------------------------------------------------------------ */
/* Suppressor choice and turn order                                    */
/* ------------------------------------------------------------------ */

test("higher weighted coverage wins before turn order", () => {
    // Close member m1 is beyond the far cone's 100 px range (105 px away),
    // so it does not veto m2. From m1 the two targets span ~67° and only one
    // fits a 45° cone; from m2 they span ~12.7° and both fit.
    const members = [
        makeMember("m1", { x: 105, y: 0, turnIndex: 0 }),
        makeMember("m2", { x: 0, y: 0, turnIndex: 4 }),
        makeMember("m3", { x: 0, y: -30, turnIndex: 1, hasActed: true })
    ];
    const targets = standardTargets().map(target => ({ ...target, x: 90 }));
    const input = makeInput(members, targets);
    const descriptor = assessSuppressAndBound(input);
    assert.ok(descriptor);
    assert.equal(descriptor.suppressorId, "m2");
    assert.equal(descriptor.coverage, 2);
    const close = descriptor.breakdown.candidates.find(candidate => candidate.id === "m1");
    assert.equal(close.coverage, 1);
});

test("equal coverage chooses the earlier turnIndex", () => {
    const members = standardMembers({
        m1: { turnIndex: 2 },
        m2: { turnIndex: 0 },
        m3: { turnIndex: 1 }
    });
    const descriptor = assessSuppressAndBound(makeInput(members, standardTargets()));
    assert.equal(descriptor.suppressorId, "m2");
});

test("equal coverage and turn choose the larger clip remaining after the shot", () => {
    const members = standardMembers({
        m1: { items: [makeWeapon({ id: "w-m1", clip: 12, clipMax: 30 })] },
        m2: { items: [makeWeapon({ id: "w-m2", clip: 30, clipMax: 30 })] },
        m3: { items: [makeWeapon({ id: "w-m3", clip: 18, clipMax: 30 })] }
    });
    const descriptor = assessSuppressAndBound(makeInput(members, standardTargets()));
    assert.equal(descriptor.suppressorId, "m2");
    assert.equal(descriptor.breakdown.ammoCost, 6);
    assert.equal(descriptor.cone.clipAfter, 24);
});

test("full tie resolves by stable combatant id", () => {
    const members = [
        makeMember("z-member", { x: 0, y: -30 }),
        makeMember("a-member", { x: 0, y: 0 }),
        makeMember("n-member", { x: 0, y: 30 })
    ];
    const descriptor = assessSuppressAndBound(makeInput(members, standardTargets()));
    assert.equal(descriptor.suppressorId, "a-member");
});

test("missing or true hasActed makes suppressors ineligible; acted members receive no bound role", () => {
    const actedTeam = standardMembers({
        m1: { hasActed: true, turnIndex: 0 },
        m2: { hasActed: true, turnIndex: 1 },
        m3: { hasActed: true, turnIndex: 2 }
    });
    const acted = explainSuppressAndBound(makeInput(actedTeam, standardTargets()));
    assert.equal(acted.selected, false);
    assert.equal(acted.reason, "suppressor-acted");

    const oneFree = [
        makeMember("m1", { x: 0, y: 0, hasActed: false }),
        makeMember("m2", { x: 0, y: -30, hasActed: true })
    ];
    const noBound = explainSuppressAndBound(makeInput(oneFree, standardTargets()));
    assert.equal(noBound.selected, false);
    assert.equal(noBound.reason, "no-bound-element");
});

test("the core never reads combat turn or turns for turn order", () => {
    const combat = {
        scene: null,
        combatants: [],
        get turn() { throw new Error("turn read"); },
        get turns() { throw new Error("turns read"); }
    };
    const input = makeInput(standardMembers(), standardTargets(), { combat });
    const descriptor = assessSuppressAndBound(input);
    assert.ok(descriptor);
    assert.equal(descriptor.suppressorId, "m1");
});

/* ------------------------------------------------------------------ */
/* Stable degradations                                                 */
/* ------------------------------------------------------------------ */

test("a friendly inside every feasible cone degrades to no-safe-cone", () => {
    // One capable suppressor on the ally/target axis; the second member is a
    // single-shot bound element outside the cone, so it cannot rescue geometry.
    const members = [
        makeMember("m1", { x: 0, y: 0 }),
        makeMember("m2", {
            x: 0,
            y: -30,
            items: [makeWeapon({ id: "single-m2", burst: 0, full: 0 })]
        })
    ];
    const ally = { tokenId: "ally", x: 25, y: 0, disposition: -1 };
    const input = makeInput(members, standardTargets(), { extraTokens: [ally] });
    const explained = explainSuppressAndBound(input);
    assert.equal(explained.selected, false);
    assert.equal(explained.reason, "no-safe-cone");
    assert.ok(explained.breakdown.candidates.every(candidate => candidate.reason === "no-safe-cone"));
});

test("full suppression bursts that do not fit the clip degrade to low-ammo", () => {
    const members = standardMembers({
        m1: { items: [makeWeapon({ id: "w-m1", clip: 5, clipMax: 30 })] },
        m2: { items: [makeWeapon({ id: "w-m2", clip: 5, clipMax: 30 })] },
        m3: { items: [makeWeapon({ id: "w-m3", clip: 5, clipMax: 30 })] }
    });
    const explained = explainSuppressAndBound(makeInput(members, standardTargets()));
    assert.equal(explained.selected, false);
    assert.equal(explained.reason, "low-ammo");
    assert.equal(explained.breakdown.suppressionCapable, 0);
});

test("jammed weapons degrade to no-suppressor while preserving the jam reason", () => {
    const members = standardMembers({
        m1: { items: [makeWeapon({ id: "w-m1", jammed: true })] },
        m2: { items: [makeWeapon({ id: "w-m2", jammed: true })] },
        m3: { items: [makeWeapon({ id: "w-m3", jammed: true })] }
    });
    const explained = explainSuppressAndBound(makeInput(members, standardTargets()));
    assert.equal(explained.selected, false);
    assert.equal(explained.reason, "no-suppressor");
    assert.ok(explained.breakdown.capability.every(entry => entry.reasons.includes("jammed")));
});

test("upper-level cancellation triggers are stable: regroup, casualties and pressure", () => {
    const regrouped = explainSuppressAndBound(makeInput(standardMembers(), standardTargets(), {
        context: { regroup: true }
    }));
    assert.equal(regrouped.reason, "forced-regroup");

    const casualty = explainSuppressAndBound(makeInput(standardMembers(), standardTargets(), {
        casualties: 1
    }));
    assert.equal(casualty.reason, "casualties");

    const twoMembers = standardMembers().slice(0, 2);
    const fourTargets = [
        makeTarget("e1", 50, -10),
        makeTarget("e2", 50, 10),
        makeTarget("e3", 45, -5),
        makeTarget("e4", 45, 5)
    ];
    const pressure = explainSuppressAndBound(makeInput(twoMembers, fourTargets));
    assert.equal(pressure.reason, "overwhelming-threat");
    assert.equal(pressure.breakdown.pressure, 2);
});

/* ------------------------------------------------------------------ */
/* Determinism                                                         */
/* ------------------------------------------------------------------ */

test("repeated runs are deterministic and do not mutate the input", () => {
    const input = makeInput(standardMembers(), standardTargets());
    const before = JSON.parse(JSON.stringify(input));
    const first = assessSuppressAndBound(input);
    const second = assessSuppressAndBound(input);
    assert.deepEqual(second, first);
    assert.equal(JSON.stringify(second), JSON.stringify(first));
    assert.deepEqual(input, before, "input DTO is not mutated");
});
