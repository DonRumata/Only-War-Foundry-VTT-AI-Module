/**
 * Unit tests for the issue #90 recover-pinned pure tactics core. All
 * fixtures are document-free DTOs and every LOS/cover/reachability answer is
 * injected explicitly, so the expected scores and orderings are hand-computed.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    RECOVER_COVER_REASONS,
    RECOVER_DONOR_EXCLUSIONS,
    RECOVER_GATE_REASONS,
    RECOVER_OVERLAY_MODES,
    RECOVER_PINNED_ROLES,
    RECOVER_PINNED_THRESHOLDS,
    attributePinSource,
    buildRecoverPinnedOverlay,
    evaluateRecoverGate,
    normalizeAssignment,
    scorePinnedTriage,
    selectCoverMember
} from "../../scripts/tactics/recover-pinned.js";

/**
 * Compact member DTO factory. `attackCapable` is explicit because the pure
 * donor pool is intentionally conservative without capability data.
 * @param {string} id Combatant id.
 * @param {object} [overrides] DTO overrides.
 * @returns {object}
 */
function makeMember(id, overrides = {}) {
    return {
        combatantId: id,
        tokenId: `t-${id}`,
        actorId: `a-${id}`,
        position: { x: 0, y: 0 },
        disposition: 1,
        statuses: [],
        attackCapable: true,
        initiative: 5,
        ...overrides
    };
}

/**
 * Pinned member DTO factory.
 * @param {string} id Combatant id.
 * @param {object} [overrides] DTO overrides.
 * @returns {object}
 */
function makePinned(id, overrides = {}) {
    return makeMember(id, {
        statuses: ["pinned"],
        ...overrides
    });
}

/**
 * Hostile source/contact DTO factory.
 * @param {string} id Token id.
 * @param {object} [overrides] DTO overrides.
 * @returns {object}
 */
function makeSource(id, overrides = {}) {
    return {
        tokenId: id,
        tokenUuid: `uuid-${id}`,
        actorId: `actor-${id}`,
        position: { x: 10, y: 0 },
        disposition: -1,
        visible: true,
        ...overrides
    };
}

/**
 * System suppression-fire chat card fixture.
 * @param {object} input Card data.
 * @param {string} input.id Message id.
 * @param {object} input.victim Pinned victim DTO.
 * @param {object} input.source Source token DTO.
 * @param {boolean} [input.pinned] Whether the victim result is positive.
 * @returns {object}
 */
function suppressionMessage({ id, victim, source, pinned = true }) {
    return {
        id,
        flags: {
            "only-war-local": {
                rollData: {
                    flags: { isSuppressingFire: true },
                    ownerId: source.actorId,
                    tokenId: source.tokenId,
                    pinnedResults: [{
                        tokenId: victim.tokenId,
                        actorId: victim.actorId,
                        pinned
                    }]
                }
            }
        }
    };
}

/**
 * Confidence-3 attribution DTO for gate/donor tests that do not exercise the
 * chat scan itself.
 * @param {object} source Source token DTO.
 * @returns {object}
 */
function recordedAttribution(source) {
    return {
        method: "recorded",
        confidence: 3,
        tokenId: source.tokenId,
        tokenUuid: source.tokenUuid,
        actorId: source.actorId,
        position: source.position
    };
}

/**
 * Baseline gate input with one pinned member, one valid donor and a visible
 * recorded source.
 * @param {object} [overrides] Input/member overrides.
 * @returns {object}
 */
function makeGateInput(overrides = {}) {
    const source = overrides.source ?? makeSource("src");
    const pinned = overrides.pinned ?? makePinned("p1");
    const donor = overrides.donor ?? makeMember("d1", { initiative: 8, losToSource: true });
    const attribution = overrides.attribution ?? recordedAttribution(source);
    return {
        members: overrides.members ?? [pinned, donor],
        pinned: overrides.pinnedList ?? [pinned],
        attributions: overrides.attributions ?? { [pinned.combatantId]: attribution },
        hostiles: [source],
        source,
        pinnedMember: pinned,
        donor,
        attribution
    };
}

/* -------------------------------------------- */
/*  Attribution                                  */
/* -------------------------------------------- */

test("recorded suppression card attributes the pin source at confidence 3", () => {
    const victim = makePinned("p1");
    const olderSource = makeSource("older", { position: { x: 20, y: 0 } });
    const newerSource = makeSource("newer", { position: { x: 30, y: 0 } });
    const messages = [
        suppressionMessage({ id: "m-older", victim, source: olderSource }),
        { id: "noise", flags: {} },
        suppressionMessage({ id: "m-newer", victim, source: newerSource })
    ];

    const result = attributePinSource({
        pinned: victim,
        messages,
        hostiles: [olderSource, newerSource],
        round: 2
    });

    assert.equal(result.method, "recorded");
    assert.equal(result.confidence, 3);
    assert.equal(result.tokenId, "newer");
    assert.equal(result.actorId, "actor-newer");
    assert.deepEqual(result.position, { x: 30, y: 0 });
});

test("recorded attribution rejects self-pinning and proven same-side cards", () => {
    const victim = makePinned("p1");
    const selfSource = makeSource(victim.tokenId, { actorId: victim.actorId, disposition: -1 });
    const sameSide = makeSource("ally", { disposition: 1 });
    const selfCard = suppressionMessage({ id: "self", victim, source: selfSource });
    const sameSideCard = suppressionMessage({ id: "friendly", victim, source: sameSide });

    assert.deepEqual(
        attributePinSource({ pinned: victim, messages: [selfCard], tokens: [selfSource] }),
        { method: "unknown", confidence: 0 }
    );
    assert.deepEqual(
        attributePinSource({ pinned: victim, messages: [sameSideCard], tokens: [sameSide] }),
        { method: "unknown", confidence: 0 }
    );
});

test("recorded chat scan is bounded and negative pinned results do not count", () => {
    const victim = makePinned("p1");
    const source = makeSource("src");
    const positive = suppressionMessage({ id: "positive", victim, source });
    const messages = [
        positive,
        { id: "noise-1", flags: {} },
        { id: "noise-2", flags: {} }
    ];
    const input = { pinned: victim, messages, hostiles: [source] };

    assert.deepEqual(attributePinSource({ ...input, maxScan: 2 }), { method: "unknown", confidence: 0 });
    assert.equal(attributePinSource({ ...input, maxScan: 3 }).method, "recorded");

    const negative = suppressionMessage({ id: "negative", victim, source, pinned: false });
    assert.deepEqual(
        attributePinSource({ pinned: victim, messages: [negative], hostiles: [source] }),
        { method: "unknown", confidence: 0 }
    );
});

test("grudge attribution uses a fresh living lastAttacker at confidence 2", () => {
    const victim = makePinned("p1");
    const source = makeSource("grudger", { position: { x: 12, y: 0 } });
    const grudge = {
        tokenId: source.tokenId,
        tokenUuid: source.tokenUuid,
        actorId: source.actorId,
        round: 3
    };

    const result = attributePinSource({
        pinned: victim,
        round: 4,
        grudge,
        hostiles: [source]
    });

    assert.equal(result.method, "grudge");
    assert.equal(result.confidence, 2);
    assert.equal(result.tokenId, source.tokenId);
    assert.deepEqual(result.position, { x: 12, y: 0 });

    assert.deepEqual(
        attributePinSource({ pinned: victim, round: 5, grudge, hostiles: [source] }),
        { method: "unknown", confidence: 0 }
    );
});

test("los-nearest attribution is confidence 1 and deterministic over distance, threat and id", () => {
    const victim = makePinned("p1", { position: { x: 0, y: 0 } });
    const far = makeSource("far", {
        position: { x: 10, y: 0 }, threat: 99, losToPinned: true
    });
    const weaker = makeSource("z-equal", {
        position: { x: 5, y: 0 }, threat: 1, tokenUuid: "uuid-z", losToPinned: true
    });
    const stronger = makeSource("a-equal", {
        position: { x: 5, y: 0 }, threat: 2, tokenUuid: "uuid-a", losToPinned: true
    });
    const blocked = makeSource("blocked", {
        position: { x: 1, y: 0 }, threat: 99, losToPinned: false
    });

    const result = attributePinSource({
        pinned: victim,
        hostiles: [far, weaker, stronger, blocked]
    });

    assert.equal(result.method, "los-nearest");
    assert.equal(result.confidence, 1);
    assert.equal(result.tokenId, "a-equal");
    assert.deepEqual(result.position, { x: 5, y: 0 });

    const first = makeSource("b-tie", {
        position: { x: 5, y: 0 }, threat: 2, tokenUuid: "uuid-b", losToPinned: true
    });
    const second = makeSource("a-tie", {
        position: { x: 5, y: 0 }, threat: 2, tokenUuid: "uuid-a", losToPinned: true
    });
    assert.equal(
        attributePinSource({ pinned: victim, hostiles: [first, second] }).tokenUuid,
        "uuid-a"
    );
});

test("los-nearest honors an injected LOS probe and unknown is exactly minimal", () => {
    const victim = makePinned("p1");
    const near = makeSource("near", { position: { x: 2, y: 0 } });
    const far = makeSource("far", { position: { x: 8, y: 0 } });

    const result = attributePinSource({
        pinned: victim,
        hostiles: [far, near],
        hasLineOfSight: hostile => hostile.tokenId === "far"
    });
    assert.equal(result.method, "los-nearest");
    assert.equal(result.tokenId, "far");

    assert.deepEqual(
        attributePinSource({
            pinned: victim,
            hostiles: [near, far],
            hasLineOfSight: () => false
        }),
        { method: "unknown", confidence: 0 }
    );
});

/* -------------------------------------------- */
/*  Triage                                       */
/* -------------------------------------------- */

test("pinned triage follows exposure, value, maneuver criticality and id deterministically", () => {
    const pinnedA = makePinned("p-a", {
        danger: 0.8,
        coverEstimate: 0.4,
        leader: true
    });
    const pinnedB = makePinned("p-b", {
        danger: 0.9,
        coverEstimate: 0.2,
        heavyWeapon: true,
        canReachCover: true
    });
    const pinnedC = makePinned("p-c", {
        danger: 0.7,
        coverEstimate: 0.2,
        assignment: { task: "flank" },
        activeCommitment: true
    });
    const pinnedD = makePinned("p-z", {
        danger: 0.7,
        coverEstimate: 0.2
    });
    const pinnedE = makePinned("p-y", {
        danger: 0.7,
        coverEstimate: 0.2
    });
    const input = [pinnedC, pinnedA, pinnedE, pinnedB, pinnedD];

    const first = scorePinnedTriage(input);
    const second = scorePinnedTriage([...input].reverse());
    const order = first.map(entry => entry.combatantId);

    // Hand-computed exposures: p-b .7; p-c/p-y/p-z .5; p-a .4.
    // Values: leader p-a = 4, heavy p-b = 2; p-c gets the +2 maneuver flag.
    assert.deepEqual(order, ["p-b", "p-c", "p-y", "p-z", "p-a"]);
    assert.deepEqual(second.map(entry => entry.combatantId), order);
    assert.equal(first[0].exposure, 0.7);
    assert.equal(first[0].value, 2);
    assert.equal(first[0].accessibility.canReachCover, true);
    assert.equal(first[1].maneuverCritical, true);
    assert.equal(first[1].maneuverBonus, 2);
    assert.deepEqual(first.map(entry => entry.rank), [1, 2, 3, 4, 5]);
});

/* -------------------------------------------- */
/*  Gate                                         */
/* -------------------------------------------- */

test("gate returns no-pinned and all-pinned for the empty extremes", () => {
    const donor = makeMember("d1");
    assert.equal(
        evaluateRecoverGate({ members: [donor] }).reason,
        RECOVER_GATE_REASONS.noPinned
    );

    const p1 = makePinned("p1");
    const p2 = makePinned("p2");
    const all = evaluateRecoverGate({ members: [p1, p2] });
    assert.equal(all.active, false);
    assert.equal(all.reason, RECOVER_GATE_REASONS.allPinned);
});

test("gate returns pinned-in-melee when every pinned member is already saved by melee", () => {
    const pinned = makePinned("p1", { inMelee: true });
    const world = makeGateInput({ pinned });
    const result = evaluateRecoverGate(world);

    assert.equal(result.active, false);
    assert.equal(result.reason, RECOVER_GATE_REASONS.pinnedInMelee);
    assert.deepEqual(result.diagnostics.excluded.melee, ["p1"]);
});

test("gate returns source-dead and reports the exclusion diagnostics", () => {
    const source = makeSource("src", { defeated: true });
    const world = makeGateInput({ source });
    const result = evaluateRecoverGate(world);

    assert.equal(result.active, false);
    assert.equal(result.reason, RECOVER_GATE_REASONS.sourceDead);
    assert.deepEqual(result.diagnostics.excluded.sourceDead, ["p1"]);
});

test("gate returns safe-in-cover-unreachable without disrupting the maneuver", () => {
    const pinned = makePinned("p1", { coverEstimate: 0.8 });
    const source = makeSource("src", { visible: false, reachable: false, canAttack: false });
    const world = makeGateInput({ pinned, source });
    const result = evaluateRecoverGate(world);

    assert.equal(result.active, false);
    assert.equal(result.reason, RECOVER_GATE_REASONS.safeInCoverUnreachable);
    assert.equal(result.diagnostics.safeInCover.coverEstimate, 0.8);
    assert.equal(result.diagnostics.safeInCover.sourceReachable, false);
    assert.equal(result.diagnostics.safeInCover.threshold,
        RECOVER_PINNED_THRESHOLDS.cover.safeEstimate);
});

test("gate returns no-donors when every non-pinned member is incapable or already acted", () => {
    const donor = makeMember("d1", { attackCapable: false, hasActed: true });
    const world = makeGateInput({ donor });
    const result = evaluateRecoverGate(world);

    assert.equal(result.active, false);
    assert.equal(result.reason, RECOVER_GATE_REASONS.noDonors);
    assert.equal(result.donorCount, 0);
});

test("gate activates with attribution confidence, redirect target and explicit thresholds", () => {
    const world = makeGateInput();
    const result = evaluateRecoverGate(world);

    assert.equal(result.active, true);
    assert.equal(result.reason, RECOVER_GATE_REASONS.active);
    assert.equal(result.gate, "active");
    assert.equal(result.mode, RECOVER_OVERLAY_MODES.full);
    assert.equal(result.redirectTargetId, "src");
    assert.equal(result.attribution.confidence, 3);
    assert.equal(result.diagnostics.experimental, true);
    assert.equal(result.diagnostics.thresholds.donor.suppressionCapable, 4);
    assert.equal(result.diagnostics.marginalValue.teamEffect, true);
});

test("self-cover activation without donors is the individual-only form, not a cover assignment", () => {
    const pinned = makePinned("p1", { canReachCover: true });
    const donor = makeMember("d1", { attackCapable: false });
    const world = makeGateInput({ pinned, donor });
    const gate = evaluateRecoverGate(world);
    const overlay = buildRecoverPinnedOverlay(world);

    assert.equal(gate.active, true);
    assert.equal(gate.mode, RECOVER_OVERLAY_MODES.individualOnly);
    assert.equal(overlay.mode, RECOVER_OVERLAY_MODES.individualOnly);
    assert.equal(overlay.coverAssignment, null);
    assert.equal(overlay.coverReason, RECOVER_COVER_REASONS.noDonors);
    assert.equal(overlay.assignments.p1.role, RECOVER_PINNED_ROLES.recovering);
});

/* -------------------------------------------- */
/*  Cover donor selection                        */
/* -------------------------------------------- */

test("cover donor scoring is hand-computed and initiative breaks equal scores", () => {
    const pinned = makePinned("p1");
    const source = makeSource("src");
    const attribution = recordedAttribution(source);
    const donorA = makeMember("d-a", {
        initiative: 5,
        suppressionCapable: true,
        losToSource: true
    });
    const donorB = makeMember("d-b", {
        initiative: 20,
        losToSource: true,
        lastTarget: "src",
        naturalTarget: "src"
    });
    const donorC = makeMember("d-c", {
        initiative: 10,
        losToSource: true,
        lastTarget: "src",
        naturalTarget: "src"
    });
    const input = {
        members: [pinned, donorC, donorA, donorB],
        pinned,
        pinnedMembers: [pinned],
        attribution,
        hostiles: [source]
    };

    const first = selectCoverMember(input);
    assert.equal(first.reason, RECOVER_COVER_REASONS.selected);
    assert.equal(first.combatantId, "d-a");
    assert.equal(first.selected.score, 7); // +4 suppression +3 LOS.
    assert.deepEqual(first.selected.components, {
        suppressionCapable: 4,
        lineOfSight: 3,
        lastTarget: 0,
        naturalTarget: 0,
        soleObjective: 0
    });

    const tie = selectCoverMember({
        ...input,
        members: [pinned, donorC, donorB]
    });
    assert.equal(tie.combatantId, "d-b");
    assert.equal(tie.selected.score, 6); // +3 LOS +2 sticky +1 natural target.

    const acted = selectCoverMember({
        ...input,
        members: [pinned, donorC, { ...donorB, hasActed: true }]
    });
    assert.equal(acted.combatantId, "d-c");
    const excluded = acted.candidates.find(candidate => candidate.combatantId === "d-b");
    assert.equal(excluded.eligible, false);
    assert.equal(excluded.reason, RECOVER_DONOR_EXCLUSIONS.hasActed);
});

test("turn order indexes derive hasActed: only indexes before the current turn are spent", () => {
    const pinned = makePinned("p1");
    const source = makeSource("src");
    const attribution = recordedAttribution(source);
    const early = makeMember("d-early", { initiative: 30, losToSource: true });
    const current = makeMember("d-current", { initiative: 20, losToSource: true });
    const late = makeMember("d-late", { initiative: 10, losToSource: true });
    const result = selectCoverMember({
        members: [pinned, early, current, late],
        pinned,
        pinnedMembers: [pinned],
        attribution,
        hostiles: [source],
        turnOrder: ["d-early", "d-current", "d-late"],
        currentTurnIndex: 1
    });

    const byId = Object.fromEntries(result.candidates.map(candidate => [candidate.combatantId, candidate]));
    assert.equal(byId["d-early"].hasActed, true);
    assert.equal(byId["d-early"].reason, RECOVER_DONOR_EXCLUSIONS.hasActed);
    assert.equal(byId["d-current"].hasActed, false);
    assert.equal(byId["d-late"].hasActed, false);
    // Both remaining donors score +3; initiative 20 beats initiative 10.
    assert.equal(result.combatantId, "d-current");
});

test("critical assignments and protected donors are excluded without breaking the maneuver", () => {
    const pinned = makePinned("p1");
    const source = makeSource("src");
    const attribution = recordedAttribution(source);
    const critical = makeMember("d-critical", {
        initiative: 99,
        suppressionCapable: true,
        losToSource: true,
        criticalAssignment: true
    });
    const fallback = makeMember("d-fallback", {
        initiative: 1,
        losToSource: true
    });
    const protectedMembers = [
        makeMember("d-flank", { assignment: { task: "flank" }, losToSource: true }),
        makeMember("d-commit", { activeCommitment: true, losToSource: true }),
        makeMember("d-gm", { gmControlled: true, losToSource: true }),
        makeMember("d-melee", { inMelee: true, losToSource: true }),
        makeMember("d-regroup", {
            assignment: { task: "regroup" }, effectiveTier: "desperate", losToSource: true
        })
    ];
    const result = selectCoverMember({
        members: [pinned, critical, fallback, ...protectedMembers],
        pinned,
        pinnedMembers: [pinned],
        attribution,
        hostiles: [source]
    });

    assert.equal(result.combatantId, "d-fallback");
    const reasons = Object.fromEntries(result.candidates.map(candidate => [candidate.combatantId, candidate.reason]));
    assert.equal(reasons["d-critical"], RECOVER_DONOR_EXCLUSIONS.criticalAssignment);
    assert.equal(reasons["d-flank"], RECOVER_DONOR_EXCLUSIONS.detachedAssignment);
    assert.equal(reasons["d-commit"], RECOVER_DONOR_EXCLUSIONS.commitmentProtected);
    assert.equal(reasons["d-gm"], RECOVER_DONOR_EXCLUSIONS.gmControlled);
    assert.equal(reasons["d-melee"], RECOVER_DONOR_EXCLUSIONS.inMelee);
    assert.equal(reasons["d-regroup"], RECOVER_DONOR_EXCLUSIONS.regroupDesperate);
});

test("sole shared-objective holder receives the -3 donor score component", () => {
    const pinned = makePinned("p1");
    const source = makeSource("src");
    const attribution = recordedAttribution(source);
    const objectiveHolder = makeMember("d-objective", {
        suppressionCapable: true,
        losToSource: true,
        soleObjectiveHolder: true,
        initiative: 10
    });
    const sticky = makeMember("d-sticky", {
        losToSource: true,
        lastTarget: "src",
        naturalTarget: "src",
        initiative: 5
    });
    const result = selectCoverMember({
        members: [pinned, objectiveHolder, sticky],
        pinned,
        pinnedMembers: [pinned],
        attribution,
        hostiles: [source]
    });

    const scored = result.candidates.find(candidate => candidate.combatantId === "d-objective");
    assert.equal(scored.components.soleObjective, -3);
    assert.equal(scored.score, 4); // +4 suppression +3 LOS −3 sole objective.
    assert.equal(result.combatantId, "d-sticky"); // Sticky donor scores 6.
});

test("no accessible donor degrades to source-unreachable without a pointed assignment", () => {
    const pinned = makePinned("p1");
    const source = makeSource("src");
    const attribution = recordedAttribution(source);
    const donor = makeMember("d1", { losToSource: false, canReachSource: false });
    const result = selectCoverMember({
        members: [pinned, donor],
        pinned,
        pinnedMembers: [pinned],
        attribution,
        hostiles: [source]
    });

    assert.equal(result.reason, RECOVER_COVER_REASONS.sourceUnreachable);
    assert.equal(result.assignment, null);
    assert.equal(result.coverAssignment, null);
    assert.equal(result.redirectTargetId, "src");
    assert.equal(result.diagnostics.accessibleDonorCount, 0);
});

/* -------------------------------------------- */
/*  Overlay descriptor and JSON contract         */
/* -------------------------------------------- */

test("full overlay emits object-form recovering and suppression cover assignments", () => {
    const pinned = makePinned("p1");
    const source = makeSource("src");
    const donor = makeMember("d1", {
        suppressionCapable: true,
        losToSource: true,
        initiative: 8
    });
    const world = makeGateInput({ pinned, source, donor });
    const overlay = buildRecoverPinnedOverlay(world);

    assert.equal(overlay.active, true);
    assert.equal(overlay.gate, "active");
    assert.equal(overlay.mode, RECOVER_OVERLAY_MODES.full);
    assert.equal(overlay.coverReason, RECOVER_COVER_REASONS.selected);
    assert.deepEqual(overlay.coverAssignment, {
        combatantId: "d1",
        for: "p1",
        score: 7,
        mode: "suppression"
    });

    const recovering = overlay.assignments.p1;
    assert.equal(recovering.task, "support");
    assert.equal(recovering.role, RECOVER_PINNED_ROLES.recovering);
    assert.equal(recovering.objective.type, "recover-pinning");

    const cover = overlay.assignments.d1;
    assert.equal(cover.task, "support");
    assert.equal(cover.role, RECOVER_PINNED_ROLES.coverFire);
    assert.equal(cover.objective.type, "suppress-pin-source");
    assert.equal(cover.objective.targetId, "src");
    assert.equal(cover.assignedTargetId, "src");
    assert.equal(overlay.memberContexts.d1.preferSuppression, true);
    assert.equal(overlay.breakdown.attribution.confidence, 3);
    assert.equal(overlay.diagnostics.donorSelection.selected.score, 7);

    assert.deepEqual(JSON.parse(JSON.stringify(overlay)), overlay);
});

test("direct-fire variant is emitted when the selected donor is not suppression-capable", () => {
    const pinned = makePinned("p1");
    const source = makeSource("src");
    const donor = makeMember("d1", { losToSource: true });
    const overlay = buildRecoverPinnedOverlay(makeGateInput({ pinned, source, donor }));

    assert.equal(overlay.coverAssignment.mode, "direct");
    assert.equal(overlay.assignments.d1.objective.type, "attack-pin-source");
    assert.equal(overlay.assignments.d1.objective.preferSuppression, false);
});

test("confidence-1 source is only a soft redirect plus declare-only overwatch descriptor", () => {
    const pinned = makePinned("p1");
    const source = makeSource("src");
    const donor = makeMember("d1", { losToSource: true, rangedCapable: true });
    const attribution = {
        method: "los-nearest",
        confidence: 1,
        tokenId: source.tokenId,
        tokenUuid: source.tokenUuid,
        actorId: source.actorId,
        position: source.position
    };
    const world = makeGateInput({ pinned, source, donor, attribution });
    const overlay = buildRecoverPinnedOverlay(world);

    assert.equal(overlay.active, true);
    assert.equal(overlay.mode, RECOVER_OVERLAY_MODES.redirectOnly);
    assert.equal(overlay.redirectTargetId, "src");
    assert.equal(overlay.coverAssignment, null);
    assert.equal(overlay.coverReason, RECOVER_COVER_REASONS.lowConfidence);
    assert.equal(overlay.assignments.d1, undefined);
    assert.equal(overlay.memberContexts.d1.mode, "overwatch");
    assert.equal(overlay.memberContexts.d1.redirectTargetId, "src");
    assert.equal(overlay.memberContexts.d1.objective.type, "overwatch-pin-recovery");
});

test("unknown source never creates pointed fire but still marks the pinned member recovering", () => {
    const pinned = makePinned("p1");
    const donor = makeMember("d1", { losToSource: false, rangedCapable: true });
    const unknown = { method: "unknown", confidence: 0 };
    const world = makeGateInput({
        pinned,
        donor,
        attribution: unknown,
        attributions: { p1: unknown }
    });
    const overlay = buildRecoverPinnedOverlay(world);

    assert.equal(overlay.active, true);
    assert.equal(overlay.mode, RECOVER_OVERLAY_MODES.individualOnly);
    assert.equal(overlay.redirectTargetId, null);
    assert.equal(overlay.coverAssignment, null);
    assert.equal(overlay.coverReason, RECOVER_COVER_REASONS.unknownSource);
    assert.equal(overlay.assignments.d1, undefined);
    assert.equal(overlay.assignments.p1.role, RECOVER_PINNED_ROLES.recovering);
});

test("legacy assignment strings normalize into object-form assignments", () => {
    assert.deepEqual(normalizeAssignment("flank"), { task: "flank" });
    assert.deepEqual(normalizeAssignment({
        task: "support",
        role: "focus",
        element: "main",
        objective: { type: "test" }
    }), {
        task: "support",
        role: "focus",
        element: "main",
        objective: { type: "test" }
    });
});
