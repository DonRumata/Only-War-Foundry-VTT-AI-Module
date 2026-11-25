/**
 * Unit tests for the perception service (issue #401): LOS adapters,
 * disposition/state filtering, deterministic target scoring and the
 * last-known-position memory lifecycle.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    MEMORY_MAX_AGE_ROUNDS,
    PERCEPTION_STATUS,
    buildPerceptionSnapshot,
    createPerceptionService,
    dispositionOf,
    expireMemoryEntries,
    hasLineOfSight,
    isBlinded,
    isDeadOrDefeated,
    isHiddenToken,
    isHostileDisposition,
    isMemoryExpired,
    isRelevantCombatUpdate,
    isRelevantTokenUpdate,
    measureDistance,
    pruneMemory,
    rankTargets,
    rememberContact,
    sanitizeMemory,
    sanitizeMemoryEntry,
    scoreTarget,
    statusIdsOf,
    visibleTargets
} from "../../scripts/perception.js";
import { FLAG_KEYS, MODULE_ID } from "../../scripts/constants.js";
import { makeCombatant } from "./fixtures.mjs";

let _id = 0;

/**
 * Next deterministic mock id.
 * @returns {string}
 */
function _nextId() {
    return `mock-${++_id}`;
}

/**
 * TokenDocument-like perception fixture: position via `center`, document
 * `disposition`/`hidden`, actor `statuses` set.
 * @param {object} [options]
 * @returns {object}
 */
function mockToken({
    id,
    x = 0,
    y = 0,
    elevation = 0,
    disposition = -1,
    hidden = false,
    statuses = [],
    actor,
    uuid,
    destroyed = false,
    width = 1,
    height = 1
} = {}) {
    const tokenId = id ?? _nextId();
    return {
        documentName: "Token",
        id: tokenId,
        name: tokenId,
        uuid: uuid ?? `Scene.scene-1.Token.${tokenId}`,
        x,
        y,
        elevation,
        width,
        height,
        disposition,
        hidden,
        destroyed,
        actor: actor ?? {
            documentName: "Actor",
            id: `actor-${tokenId}`,
            type: "npc",
            statuses: new Set(statuses),
            destroyed: false,
            system: {}
        },
        center: { x: x + 50, y: y + 50 }
    };
}

/**
 * Minimal combat stub with a collection-shaped `combatants`.
 * @param {object} [options]
 * @returns {object}
 */
function mockCombat({ round = 1, turn = 0, combatants = [], id = "combat-1" } = {}) {
    const map = new Map(combatants.map(c => [c.id, c]));
    map.contents = combatants;
    return { documentName: "Combat", id, round, turn, combatants: map, scene: { id: "scene-1" } };
}

/**
 * Combatant stub carrying flag accessors and token links.
 * @param {object} tokenDoc
 * @returns {object}
 */
function mockCombatant(tokenDoc) {
    const combatant = makeCombatant({ token: tokenDoc, actor: tokenDoc.actor });
    combatant.tokenId = tokenDoc.id;
    return combatant;
}

/**
 * Install a mocked `canvas` global; returns a restore callback.
 * @param {object} [options]
 * @param {object[]} [options.tokens]
 * @param {object[]} [options.walls]
 * @param {Function|null} [options.testVisibility] Mock on each viewer token.
 * @param {object} [options.effects] Legacy `canvas.effects` mock.
 * @param {object} [options.scene]
 * @returns {Function}
 */
function installCanvas({ tokens = [], walls = [], testVisibility = null, effects = null, scene = null } = {}) {
    const previous = globalThis.canvas;
    if (testVisibility) for (const token of tokens) token.testVisibility = testVisibility;
    const collection = {
        contents: tokens,
        placeables: tokens,
        get: id => tokens.find(t => t.id === id) ?? null,
        has: id => tokens.some(t => t.id === id)
    };
    globalThis.canvas = {
        ready: true,
        scene: scene ?? {
            id: "scene-1",
            grid: { size: 100, distance: 1.5 },
            tokens: collection,
            walls: { contents: walls }
        },
        tokens: collection,
        walls: { contents: walls, placeables: walls },
        grid: { measureDistance: (a, b) => Math.hypot(a.x - b.x, a.y - b.y) / 100 * 1.5 },
        dimensions: { size: 100, distance: 1.5 },
        effects: effects ?? undefined
    };
    return () => {
        if (previous === undefined) delete globalThis.canvas;
        else globalThis.canvas = previous;
    };
}

/* ------------------------------------------------------------------------- */
/* Token state helpers                                                        */
/* ------------------------------------------------------------------------- */

test("status/disposition helpers read token and actor state", () => {
    const token = mockToken({ disposition: -1, statuses: ["blinded"] });
    assert.equal(dispositionOf(token), -1);
    assert.equal(statusIdsOf(token).has("blinded"), true);
    assert.equal(isBlinded(token), true);
    assert.equal(isBlinded(mockToken({ statuses: [] })), false);
    assert.equal(isHiddenToken(mockToken({ hidden: true })), true);
    assert.equal(isHiddenToken(mockToken({ statuses: ["hidden"] })), true);
    assert.equal(isDeadOrDefeated(mockToken({ statuses: ["dead"] })), true);
    assert.equal(isDeadOrDefeated(mockToken(), { combatant: { defeated: true } }), true);
    assert.equal(dispositionOf({ documentName: "Token", id: "x" }), 0);
});

test("isHostileDisposition: opposite signs, neutral excluded by default", () => {
    assert.equal(isHostileDisposition(-1, 1), true);
    assert.equal(isHostileDisposition(1, -1), true);
    assert.equal(isHostileDisposition(-1, -1), false);
    assert.equal(isHostileDisposition(1, 1), false);
    assert.equal(isHostileDisposition(-1, 0), false);
    assert.equal(isHostileDisposition(0, -1), false);
    assert.equal(isHostileDisposition(-1, 0, { includeNeutral: true }), true);
    assert.equal(isHostileDisposition(0, 0, { includeNeutral: true }), false);
    assert.equal(isHostileDisposition(-1, -1, { dispositions: [-1] }), true);
    assert.equal(isHostileDisposition(-1, 1, { dispositions: [0] }), false);
});

/* ------------------------------------------------------------------------- */
/* Line of sight adapters                                                     */
/* ------------------------------------------------------------------------- */

test("hasLineOfSight uses a viewer-local visibility test", () => {
    const viewer = mockToken({ id: "viewer", x: 0, y: 0 });
    const target = mockToken({ id: "target", x: 300, y: 0 });
    const calls = [];
    const restore = installCanvas({
        tokens: [viewer, target],
        testVisibility: (point, options) => {
            calls.push({ point, options });
            return point.x < 500;
        }
    });
    try {
        assert.equal(hasLineOfSight(viewer, target), true);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].point, { x: 350, y: 50 });
        assert.equal(calls[0].options.tolerance, 2);

        const far = mockToken({ id: "far", x: 900, y: 0 });
        assert.equal(hasLineOfSight(viewer, far), false);
    } finally {
        restore();
    }
});

test("a viewer does not inherit the active user's canvas visibility", () => {
    const viewer = mockToken({ x: 0, y: 0 });
    const target = mockToken({ x: 300, y: 0 });
    const restore = installCanvas({
        tokens: [viewer, target],
        effects: { visibility: { testVisibility: () => false } }
    });
    try {
        assert.equal(hasLineOfSight(viewer, target), true);
    } finally {
        restore();
    }
});

test("hasLineOfSight falls back to placeable/visionSource testVisibility", () => {
    const doc = mockToken({ x: 0, y: 0 });
    const target = mockToken({ x: 300, y: 0 });
    const restore = installCanvas({ tokens: [doc, target] });
    try {
        const placeable = { document: doc, testVisibility: () => true };
        assert.equal(hasLineOfSight(placeable, target), true);

        const withVision = { document: doc, vision: { testVisibility: () => false } };
        assert.equal(hasLineOfSight(withVision, target), false);
    } finally {
        restore();
    }
});

test("geometric LOS fallback honours blocking walls, ignores open doors and non-blocking walls", () => {
    const viewer = mockToken({ x: 0, y: 0 });
    const target = mockToken({ x: 300, y: 0 });
    const blockingWall = { document: { c: [200, -100, 200, 200], sight: 10, door: 0, ds: 0 } };
    const openDoor = { document: { c: [200, -100, 200, 200], sight: 10, door: 1, ds: 1 } };
    const v13OpenDoor = { document: { c: [200, -100, 200, 200], sight: { enabled: true, type: 10 }, door: { state: "open" } } };
    const noSight = { document: { c: [200, -100, 200, 200], sight: { enabled: false } } };
    const offPath = { document: { c: [900, 900, 950, 950], sight: 10 } };

    let restore = installCanvas({ tokens: [viewer, target], walls: [blockingWall] });
    try {
        assert.equal(hasLineOfSight(viewer, target), false);
    } finally {
        restore();
    }

    restore = installCanvas({ tokens: [viewer, target], walls: [openDoor, noSight, offPath] });
    try {
        assert.equal(hasLineOfSight(viewer, target), true);
    } finally {
        restore();
    }

    restore = installCanvas({ tokens: [viewer, target], walls: [v13OpenDoor] });
    try {
        assert.equal(hasLineOfSight(viewer, target), true);
    } finally {
        restore();
    }
});

test("hasLineOfSight without positions or canvas returns false", () => {
    const viewer = mockToken({ x: 0, y: 0 });
    const restore = installCanvas({ tokens: [viewer] });
    try {
        assert.equal(hasLineOfSight(viewer, { documentName: "Token", id: "nowhere" }), false);
    } finally {
        restore();
    }
});

test("measureDistance prefers grid measurement and falls back to pixels", () => {
    const a = mockToken({ x: 0, y: 0 });
    const b = mockToken({ x: 300, y: 0 });
    let restore = installCanvas({
        tokens: [a, b],
        scene: { id: "scene-1", grid: { size: 100, distance: 2 }, tokens: { contents: [a, b] } }
    });
    try {
        // Mock grid: Euclidean pixels / 100 * 1.5 в†’ 4.5.
        assert.equal(measureDistance(a, b), 4.5);
    } finally {
        restore();
    }

    const previous = globalThis.canvas;
    globalThis.canvas = {
        scene: { id: "s", grid: { size: 100, distance: 2 }, tokens: { contents: [] } },
        tokens: { contents: [] },
        dimensions: { size: 100, distance: 2 }
    };
    try {
        // No grid.measureDistance в†’ pixel fallback: 300px / 100 * 2 = 6.
        assert.equal(measureDistance(a, b), 6);
    } finally {
        globalThis.canvas = previous;
    }
});

/* ------------------------------------------------------------------------- */
/* visibleTargets                                                             */
/* ------------------------------------------------------------------------- */

test("visibleTargets filters by disposition, state and LOS; hidden never leaks", () => {
    const viewer = mockToken({ id: "viewer", x: 0, y: 0, disposition: -1 });
    const friendly = mockToken({ id: "friendly", x: 200, y: 0, disposition: 1 });
    const hostile = mockToken({ id: "hostile", x: 250, y: 0, disposition: -1 });
    const neutral = mockToken({ id: "neutral", x: 300, y: 0, disposition: 0 });
    const hidden = mockToken({ id: "hidden", x: 350, y: 0, disposition: 1, hidden: true });
    const dead = mockToken({ id: "dead", x: 400, y: 0, disposition: 1, statuses: ["dead"] });
    const behindWall = mockToken({ id: "walled", x: 900, y: 0, disposition: 1 });
    const restore = installCanvas({
        tokens: [viewer, friendly, hostile, neutral, hidden, dead, behindWall],
        testVisibility: point => point.x < 500
    });
    try {
        const targets = visibleTargets(viewer);
        assert.deepEqual(targets.map(t => t.tokenId), ["friendly"]);
        assert.equal(targets[0].canAttack, true);
        assert.equal(targets[0].disposition, 1);
        assert.equal(targets[0].tokenUuid, "Scene.scene-1.Token.friendly");
        assert.equal(typeof targets[0].distance, "number");
        assert.equal(targets[0].hidden, false);

        const withNeutral = visibleTargets(viewer, { includeNeutral: true });
        assert.deepEqual(withNeutral.map(t => t.tokenId), ["friendly", "neutral"]);

        const withHidden = visibleTargets(viewer, { includeHidden: true });
        const hiddenEntry = withHidden.find(t => t.tokenId === "hidden");
        assert.ok(hiddenEntry, "hidden token listed only when requested");
        assert.equal(hiddenEntry.hidden, true);
        assert.equal(hiddenEntry.canAttack, false, "hidden target is never attackable");
    } finally {
        restore();
    }
});

test("visibleTargets: defeated combatant and destroyed token are excluded", () => {
    const viewer = mockToken({ id: "viewer", x: 0, y: 0, disposition: -1 });
    const defeated = mockToken({ id: "defeated", x: 200, y: 0, disposition: 1 });
    const gone = mockToken({ id: "gone", x: 250, y: 0, disposition: 1, destroyed: true });
    const combat = mockCombat({
        combatants: [
            { id: "c1", tokenId: "defeated", defeated: true },
            { id: "c2", tokenId: "viewer", defeated: false }
        ]
    });
    const restore = installCanvas({ tokens: [viewer, defeated, gone], testVisibility: () => true });
    try {
        assert.deepEqual(visibleTargets(viewer, { combat }).map(t => t.tokenId), []);
    } finally {
        restore();
    }
});

test("visibleTargets entries carry sorted status ids", () => {
    const viewer = mockToken({ id: "viewer", x: 0, y: 0, disposition: -1 });
    const target = mockToken({
        id: "target",
        x: 200,
        y: 0,
        disposition: 1,
        statuses: ["stunned", "pinned"]
    });
    const restore = installCanvas({ tokens: [viewer, target], testVisibility: () => true });
    try {
        const targets = visibleTargets(viewer);
        assert.deepEqual(targets.map(t => t.tokenId), ["target"]);
        assert.deepEqual(targets[0].statuses, ["pinned", "stunned"]);
    } finally {
        restore();
    }
});

test("visibleTargets: blinded viewer sees nothing", () => {
    const viewer = mockToken({ id: "viewer", x: 0, y: 0, disposition: -1, statuses: ["blinded"] });
    const target = mockToken({ id: "target", x: 200, y: 0, disposition: 1 });
    const restore = installCanvas({ tokens: [viewer, target], testVisibility: () => true });
    try {
        assert.deepEqual(visibleTargets(viewer), []);
    } finally {
        restore();
    }
});

test("visibleTargets without canvas returns an empty list", () => {
    const viewer = mockToken({ x: 0, y: 0, disposition: -1 });
    assert.deepEqual(visibleTargets(viewer), []);
});

/* ------------------------------------------------------------------------- */
/* Memory: pure functions                                                     */
/* ------------------------------------------------------------------------- */

test("memory entries are sanitized to the contract fields", () => {
    const entry = sanitizeMemoryEntry({
        sceneId: "scene-1",
        x: 100,
        y: 200,
        elevation: 5,
        lastSeenRound: 3,
        lastSeenTurn: 1,
        dispositionAtDetection: 1,
        actorId: "secret-actor",
        system: { hp: 42 },
        hidden: true
    });
    assert.deepEqual(Object.keys(entry).sort(), [
        "dispositionAtDetection",
        "elevation",        "firstSeenRound",        "lastSeenRound",
        "lastSeenTurn",
        "sceneId",
        "x",
        "y"
    ]);
    assert.equal(sanitizeMemoryEntry(null), null);
    assert.equal(sanitizeMemoryEntry({ x: 1, y: 2 }), null, "sceneId required");
    assert.equal(sanitizeMemoryEntry({ sceneId: "s", x: "NaN", y: 2 }), null);
    assert.deepEqual(sanitizeMemory(null), {});
    assert.deepEqual(sanitizeMemory("junk"), {});
    assert.deepEqual(sanitizeMemory({ ok: { sceneId: "s", x: 1, y: 2 }, bad: { x: 1 } }), {
        ok: { sceneId: "s", x: 1, y: 2, elevation: 0, lastSeenRound: 0, lastSeenTurn: 0, firstSeenRound: 0, dispositionAtDetection: 0 }
    });
});

test("rememberContact records and re-detection refreshes position and age", () => {
    let memory = rememberContact({}, {
        tokenUuid: "Scene.scene-1.Token.t1",
        sceneId: "scene-1",
        x: 100,
        y: 100,
        lastSeenRound: 1,
        lastSeenTurn: 2,
        dispositionAtDetection: 1
    });
    assert.equal(memory["Scene.scene-1.Token.t1"].x, 100);
    assert.equal(memory["Scene.scene-1.Token.t1"].lastSeenRound, 1);

    memory = rememberContact(memory, {
        tokenUuid: "Scene.scene-1.Token.t1",
        sceneId: "scene-1",
        x: 400,
        y: 400,
        lastSeenRound: 4,
        lastSeenTurn: 0,
        dispositionAtDetection: 1
    });
    assert.equal(memory["Scene.scene-1.Token.t1"].x, 400, "re-detection updates position");
    assert.equal(memory["Scene.scene-1.Token.t1"].lastSeenRound, 4, "re-detection resets age");

    // Invalid contacts and foreign keys never leak into the map.
    const unchanged = rememberContact(memory, { tokenUuid: "", sceneId: "s", x: 0, y: 0 });
    assert.deepEqual(unchanged, memory);
});

test("memory expires after three full rounds without re-detection", () => {
    const uuid = "Scene.scene-1.Token.t1";
    const seen = (round) => rememberContact({}, {
        tokenUuid: uuid,
        sceneId: "scene-1",
        x: 1,
        y: 1,
        lastSeenRound: round
    });

    const memory = seen(1);
    // Round 1 в†’ rounds 2,3,4 = three full rounds; entry survives until
    // round 5 starts.
    assert.equal(isMemoryExpired(memory[uuid], 4, MEMORY_MAX_AGE_ROUNDS), false);
    assert.equal(isMemoryExpired(memory[uuid], 5, MEMORY_MAX_AGE_ROUNDS), true);
    assert.equal(Object.keys(expireMemoryEntries(memory, 4)).length, 1);
    assert.deepEqual(expireMemoryEntries(memory, 5), {});
});

test("pruneMemory drops foreign scenes and deleted tokens", () => {
    const memory = {
        a: { sceneId: "scene-1", x: 1, y: 1, lastSeenRound: 0 },
        b: { sceneId: "scene-2", x: 2, y: 2, lastSeenRound: 0 },
        c: { sceneId: "scene-1", x: 3, y: 3, lastSeenRound: 0 }
    };
    assert.deepEqual(
        Object.keys(pruneMemory(memory, { sceneId: "scene-1" })).sort(),
        ["a", "c"]
    );
    assert.deepEqual(
        Object.keys(pruneMemory(memory, {
            sceneId: "scene-1",
            tokenExists: uuid => uuid !== "c"
        })),
        ["a"]
    );
});

/* ------------------------------------------------------------------------- */
/* Perception snapshot                                                        */
/* ------------------------------------------------------------------------- */

test("buildPerceptionSnapshot splits visible and last-known targets, stays immutable", async () => {
    const viewer = mockToken({ id: "viewer", x: 0, y: 0, disposition: -1 });
    const seen = mockToken({ id: "seen", x: 200, y: 0, disposition: 1 });
    const lost = mockToken({ id: "lost", x: 900, y: 0, disposition: 1 });
    const combatant = mockCombatant(viewer);
    await combatant.setFlag(MODULE_ID, FLAG_KEYS.memory, {
        [lost.uuid]: {
            sceneId: "scene-1",
            x: 500,
            y: 500,
            elevation: 0,
            lastSeenRound: 1,
            lastSeenTurn: 0,
            dispositionAtDetection: 1
        },
        [seen.uuid]: {
            sceneId: "scene-1",
            x: 1,
            y: 1,
            lastSeenRound: 1,
            lastSeenTurn: 0,
            dispositionAtDetection: 1
        }
    });
    const combat = mockCombat({ round: 1, combatants: [combatant] });
    const restore = installCanvas({
        tokens: [viewer, seen, lost],
        testVisibility: point => point.x < 500
    });
    try {
        const snapshot = buildPerceptionSnapshot({ combat, combatant, token: viewer });
        assert.equal(snapshot.status, PERCEPTION_STATUS.ok);
        assert.equal(snapshot.sceneId, "scene-1");
        assert.deepEqual(snapshot.visibleTargets.map(t => t.tokenId), ["seen"]);
        // Previously seen contact without LOS survives only as last-known.
        assert.equal(snapshot.lastKnownTargets.length, 1);
        const known = snapshot.lastKnownTargets[0];
        assert.equal(known.tokenUuid, lost.uuid);
        assert.deepEqual(Object.keys(known).sort(), [
            "dispositionAtDetection",
            "elevation",            "firstSeenRound",            "lastSeenRound",
            "lastSeenTurn",
            "sceneId",
            "tokenUuid",
            "x",
            "y"
        ], "last-known entries carry no actor/secret data");
        // Currently visible contacts do not duplicate into last-known.
        assert.equal(snapshot.lastKnownTargets.some(t => t.tokenUuid === seen.uuid), false);
        assert.equal(typeof snapshot.revision, "string");
        assert.equal(Object.isFrozen(snapshot), true);
        assert.equal(Object.isFrozen(snapshot.visibleTargets), true);
        assert.equal(Object.isFrozen(snapshot.lastKnownTargets[0]), true);

        // Deterministic revision for identical state.
        const repeat = buildPerceptionSnapshot({ combat, combatant, token: viewer });
        assert.equal(repeat.revision, snapshot.revision);
    } finally {
        restore();
    }
});

test("buildPerceptionSnapshot without canvas or token reports perception-unavailable", () => {
    const missing = buildPerceptionSnapshot({});
    assert.equal(missing.status, PERCEPTION_STATUS.unavailable);
    assert.deepEqual(missing.visibleTargets, []);
    assert.deepEqual(missing.lastKnownTargets, []);
    assert.equal(missing.revision, null);
    assert.equal(Object.isFrozen(missing), true);

    const restore = installCanvas({ tokens: [] });
    try {
        const noToken = buildPerceptionSnapshot({ combat: mockCombat() });
        assert.equal(noToken.status, PERCEPTION_STATUS.unavailable);
    } finally {
        restore();
    }
});

/* ------------------------------------------------------------------------- */
/* Target scoring                                                             */
/* ------------------------------------------------------------------------- */

test("scoreTarget is pure, deterministic and weight-driven", () => {
    const npc = { range: 30, damage: 10, penetration: 5 };
    const target = { tokenId: "t1", distance: 15, threat: 8, armour: 4, canAttack: true };

    const first = scoreTarget(npc, target);
    const second = scoreTarget(npc, target);
    assert.equal(first.score, second.score, "identical inputs в†’ identical score");
    assert.equal(Object.isFrozen(first), true);

    // Non-attackable targets always rank below attackable ones.
    const blocked = scoreTarget(npc, { ...target, canAttack: false });
    assert.ok(blocked.score < 0, `unreachable target scores negative (${blocked.score})`);
    assert.ok(blocked.score < first.score);

    // Out-of-range target drops the attack gate.
    const farAway = scoreTarget(npc, { ...target, distance: 200 });
    assert.equal(farAway.components.inRange, 0);
    assert.ok(farAway.score < first.score);
});

test("scoreTarget ordering flips with preset weights", () => {
    const npc = { range: 100, damage: 10, penetration: 0 };
    const near = { tokenId: "near", distance: 5, threat: 0, armour: 0, canAttack: true };
    const dangerous = { tokenId: "far", distance: 60, threat: 40, armour: 0, canAttack: true };

    const closeFirst = rankTargets(npc, [near, dangerous], {
        weights: { canAttack: 10, effectiveness: 0, threat: 0, distance: 10 }
    });
    assert.equal(closeFirst[0].target.tokenId, "near");

    const threatFirst = rankTargets(npc, [near, dangerous], {
        weights: { canAttack: 10, effectiveness: 0, threat: 10, distance: 0 }
    });
    assert.equal(threatFirst[0].target.tokenId, "far");

    // Deterministic tie-break by tokenId.
    const tied = rankTargets(npc, [
        { tokenId: "b", distance: 5, threat: 0, armour: 0, canAttack: true },
        { tokenId: "a", distance: 5, threat: 0, armour: 0, canAttack: true }
    ]);
    assert.deepEqual(tied.map(e => e.target.tokenId), ["a", "b"]);
});

test("scoreTarget derives an attack profile from actor weapon items", () => {
    const actor = {
        items: [
            { type: "weapon", system: { damage: "1d10+3", penetration: 2, range: 30 } },
            { type: "weapon", system: { damage: "2d10", penetration: 8, class: "melee" } },
            { type: "talent", system: {} }
        ]
    };
    // Best weapon: 2d10 (11) + pen 8 = 19 > 1d10+3 (8.5) + 2 = 10.5.
    const scored = scoreTarget(actor, { tokenId: "t", distance: 2, threat: 0, armour: 0, canAttack: true });
    assert.equal(scored.components.inRange, 1);
    const outOfMelee = scoreTarget(actor, { tokenId: "t", distance: 20, threat: 0, armour: 0, canAttack: true });
    assert.equal(outOfMelee.components.inRange, 0, "melee profile limited to 2 m reach");
});

test("scoreTarget falls back to target actor stats for threat and armour", () => {
    const npc = { range: 50, damage: 10, penetration: 10 };
    const target = {
        tokenId: "t",
        distance: 10,
        canAttack: true,
        actor: {
            system: { armour: { head: { value: 4 }, body: { value: 6 } } },
            items: [{ type: "weapon", system: { damage: "1d10", range: 20 } }]
        }
    };
    const scored = scoreTarget(npc, target);
    // Armour 6 в†’ expected 10 + 10 - 6 = 14 в†’ 14 / (14 + 10).
    assert.equal(scored.components.effectiveness, 14 / 24);
    // Threat proxy: 1d10 expected = 5.5 в†’ 5.5/20.
    assert.equal(scored.components.threat, 5.5 / 20);
});

/* ------------------------------------------------------------------------- */
/* Service wrapper                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Service test helper: fake api/hooks wiring.
 * @param {object} [options]
 * @returns {{service: object, api: object, hookCalls: object[]}}
 */
function makeService({ authority = null } = {}) {
    const hookCalls = [];
    const api = {
        services: {
            get: name => (name === "authority" ? authority : null)
        }
    };
    const service = createPerceptionService({
        api,
        hooks: {
            on: (event, fn) => hookCalls.push({ event, fn }),
            off: () => {}
        }
    });
    return { service, api, hookCalls };
}

test("service registers hooks and exposes the perception API", () => {
    const { service, hookCalls } = makeService();
    assert.equal(service.started, false);
    service.start();
    assert.equal(service.started, true);
    assert.deepEqual(hookCalls.map(c => c.event), [
        "updateCombat",
        "updateToken",
        "deleteToken",
        "canvasReady"
    ]);
    service.start();
    assert.equal(hookCalls.length, 4, "start is idempotent");
    service.stop();
    assert.equal(service.started, false);
    assert.equal(typeof service.hasLineOfSight, "function");
    assert.equal(typeof service.visibleTargets, "function");
    assert.equal(typeof service.buildPerceptionSnapshot, "function");
    assert.equal(typeof service.rememberPositions, "function");
    assert.equal(typeof service.lastKnownPositions, "function");
    assert.equal(typeof service.expireMemory, "function");
    assert.equal(typeof service.scoreTarget, "function");
});

test("isController prefers the authority service, falls back to GM", () => {
    const { service: gmFallback } = makeService({ authority: null });
    game.user.isGM = true;
    assert.equal(gmFallback.isController(), true);
    game.user.isGM = false;
    assert.equal(gmFallback.isController(), false);
    game.user.isGM = true;

    const { service: notController } = makeService({ authority: { isController: () => false } });
    assert.equal(notController.isController(), false, "authority verdict wins over GM flag");
    const { service: controller } = makeService({ authority: { isController: () => true } });
    assert.equal(controller.isController(), true);
});

test("relevance filters gate debounced memory updates", () => {
    assert.equal(isRelevantTokenUpdate({ x: 100 }), true);
    assert.equal(isRelevantTokenUpdate({ hidden: true }), true);
    assert.equal(isRelevantTokenUpdate({ disposition: 1 }), true);
    assert.equal(isRelevantTokenUpdate({ name: "renamed" }), false);
    assert.equal(isRelevantTokenUpdate(null), false);
    assert.equal(isRelevantCombatUpdate({ round: 2 }), true);
    assert.equal(isRelevantCombatUpdate({ turn: 0 }), true);
    assert.equal(isRelevantCombatUpdate({ combatants: [] }), false);
});

test("rememberPositions records visible contacts into the combatant flag", async () => {
    const { service } = makeService();
    const viewer = mockToken({ id: "viewer", x: 0, y: 0, disposition: -1 });
    const target = mockToken({ id: "target", x: 200, y: 0, disposition: 1 });
    const combatant = mockCombatant(viewer);
    const combat = mockCombat({ round: 2, turn: 1, combatants: [combatant] });
    const restore = installCanvas({ tokens: [viewer, target], testVisibility: () => true });
    try {
        const memory = await service.rememberPositions(combat, combatant);
        // Storage shape is an array of {tokenUuid, ...} entries (Foundry
        // expands dotted object keys in flags, so the map cannot persist
        // as a bare object).
        const stored = combatant.getFlag(MODULE_ID, FLAG_KEYS.memory);
        assert.ok(Array.isArray(stored), "memory persisted as an entry array");
        assert.deepEqual(stored.map((e) => e.tokenUuid).sort(), Object.keys(memory).sort(),
            "every remembered uuid persisted");
        const entry = stored.find((e) => e.tokenUuid === target.uuid);
        assert.ok(entry, "contact recorded");
        assert.equal(entry.sceneId, "scene-1");
        assert.equal(entry.x, 250);
        assert.equal(entry.y, 50);
        assert.equal(entry.lastSeenRound, 2);
        assert.equal(entry.lastSeenTurn, 1);
        assert.equal(entry.dispositionAtDetection, 1);
    } finally {
        restore();
    }
});

test("rememberPositions does not write when the client is not controller", async () => {
    const { service } = makeService({ authority: { isController: () => false } });
    const viewer = mockToken({ id: "viewer", x: 0, y: 0, disposition: -1 });
    const target = mockToken({ id: "target", x: 200, y: 0, disposition: 1 });
    const combatant = mockCombatant(viewer);
    const combat = mockCombat({ round: 1, combatants: [combatant] });
    const restore = installCanvas({ tokens: [viewer, target], testVisibility: () => true });
    try {
        const memory = await service.rememberPositions(combat, combatant);
        assert.ok(memory[target.uuid], "snapshot still computed");
        assert.equal(combatant.getFlag(MODULE_ID, FLAG_KEYS.memory), undefined,
            "no persistent write without authority");
    } finally {
        restore();
    }
});

test("lastKnownPositions returns sanitized entries for combatant or token", async () => {
    const { service } = makeService();
    const viewer = mockToken({ id: "viewer", x: 0, y: 0, disposition: -1 });
    const target = mockToken({ id: "target", x: 200, y: 0, disposition: 1 });
    const combatant = mockCombatant(viewer);
    await combatant.setFlag(MODULE_ID, FLAG_KEYS.memory, {
        [target.uuid]: {
            sceneId: "scene-1",
            x: 250,
            y: 50,
            elevation: 0,
            lastSeenRound: 3,
            lastSeenTurn: 1,
            dispositionAtDetection: 1,
            secretField: "must-not-leak"
        }
    });
    const restore = installCanvas({ tokens: [viewer, target], testVisibility: () => true });
    const previousCombat = game.combat;
    game.combat = mockCombat({ round: 3, combatants: [combatant] });
    try {
        const known = service.lastKnownPositions(combatant);
        assert.equal(known.length, 1);
        assert.equal(known[0].tokenUuid, target.uuid);
        assert.equal(known[0].secretField, undefined, "no extra fields leak");
        assert.deepEqual(Object.keys(known[0]).sort(), [
            "dispositionAtDetection",
            "elevation",            "firstSeenRound",            "lastSeenRound",
            "lastSeenTurn",
            "sceneId",
            "tokenUuid",
            "x",
            "y"
        ]);
        // Token argument resolves to the owning combatant.
        assert.deepEqual(service.lastKnownPositions(viewer), known);
    } finally {
        game.combat = previousCombat;
        restore();
    }
});

test("expireMemory removes entries after three rounds and forgetToken prunes deletions", async () => {
    const { service } = makeService();
    const viewer = mockToken({ id: "viewer", x: 0, y: 0, disposition: -1 });
    const target = mockToken({ id: "target", x: 200, y: 0, disposition: 1 });
    const combatant = mockCombatant(viewer);
    await combatant.setFlag(MODULE_ID, FLAG_KEYS.memory, {
        [target.uuid]: { sceneId: "scene-1", x: 1, y: 1, lastSeenRound: 1 }
    });
    const restore = installCanvas({ tokens: [viewer, target], testVisibility: () => true });
    try {
        // Two full rounds later the entry survives.
        let combat = mockCombat({ round: 4, combatants: [combatant] });
        assert.equal(await service.expireMemory(combat), 0);
        assert.ok(combatant.getFlag(MODULE_ID, FLAG_KEYS.memory)[target.uuid]);

        // Three full rounds в†’ forgotten.
        combat = mockCombat({ round: 5, combatants: [combatant] });
        assert.equal(await service.expireMemory(combat), 1);
        assert.deepEqual(combatant.getFlag(MODULE_ID, FLAG_KEYS.memory), []);

        // Re-record, then the token disappears в†’ forgetToken prunes it.
        await combatant.setFlag(MODULE_ID, FLAG_KEYS.memory, {
            [target.uuid]: { sceneId: "scene-1", x: 1, y: 1, lastSeenRound: 5 }
        });
        const previousCombat = game.combat;
        game.combat = combat;
        try {
            assert.equal(await service.forgetToken(target.uuid), 1);
            assert.deepEqual(combatant.getFlag(MODULE_ID, FLAG_KEYS.memory), []);
        } finally {
            game.combat = previousCombat;
        }
    } finally {
        restore();
    }
});
