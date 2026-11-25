/**
 * Integration tests for the issue #90 recover-pinned overlay: fireteam
 * adaptation of the pure kernel, the confidence ladder end-to-end, donor
 * exclusions, the single-donor contract, member-context injection and
 * interaction guards with peel/suppression/focus mechanics.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { FLAG_KEYS, MODULE_ID } from "../../scripts/constants.js";
import { createFireteamService, FIRETEAM_STATUS } from "../../scripts/fireteam.js";
import { createPlannerService } from "../../scripts/planner.js";
import { _factorsOf } from "../../scripts/planner/scoring.js";
import { registerSpecOpsPreset } from "../../scripts/presets/spec-ops.js";
import { makeActor, makeCombat, makeCombatant, makeScene, makeToken } from "./fixtures.mjs";

const RATES = Object.freeze({ half: 2, full: 4, charge: 6, run: 6 });

function round4(value) {
    return Math.round(value * 1e4) / 1e4;
}

function key(point) {
    return `${round4(point.x)},${round4(point.y)}`;
}

/** Read-only navigation oracle shared by selector and planner fixtures. */
function makeNavigation() {
    return {
        validateEndpoint(token, destination) {
            return { status: "ok", valid: true, endpoint: { x: destination.x, y: destination.y } };
        },
        canReach(token, destination) {
            const route = this.planRoute(token, destination);
            return { status: route.status, reachable: route.exact === true, reason: route.reason, cost: route.cost };
        },
        planRoute(token, destination) {
            const from = token?.position ?? { x: 1000, y: 0 };
            return {
                status: "ok",
                exact: true,
                reason: null,
                endpoint: { x: destination.x, y: destination.y },
                cost: Math.hypot(destination.x - from.x, destination.y - from.y) / 66.6667,
                waypoints: [{ x: from.x, y: from.y }, { x: destination.x, y: destination.y }]
            };
        },
        coverEstimate: () => 0,
        findCandidates: () => ({ status: "ok", candidates: [] })
    };
}

function dangerAt() {
    return 0.5;
}

function weapon(id = "gun", fullAuto = false) {
    return {
        id,
        uuid: `uuid-${id}`,
        name: "Lasgun",
        type: "weapon",
        system: {
            class: "basic",
            range: 30,
            damage: "1d10+3",
            rateOfFire: fullAuto ? { single: 1, burst: 2, full: 4 } : { single: 1, burst: 0, full: 0 },
            clip: { value: 10, max: 10 },
            jammed: false
        }
    };
}

function directAction() {
    return {
        id: "standard",
        type: "attack",
        attackType: "standard",
        itemId: "gun",
        itemUuid: "uuid-gun",
        name: "Lasgun",
        class: "ranged",
        range: 6,
        damage: 5,
        cost: "half"
    };
}

function withFireteam(doc, preset = "rangedCover") {
    doc.flags[MODULE_ID] = doc.flags[MODULE_ID] ?? {};
    doc.flags[MODULE_ID][FLAG_KEYS.fireteam] = { teamId: "alpha", teamPreset: preset };
    return doc;
}

function worldMember(id, x, y, {
    initiative = 10, fullAuto = false, statuses = [], teamPreset = "rangedCover"
} = {}) {
    const actor = makeActor({ enabled: true, preset: teamPreset });
    actor.system = {
        wounds: { value: 0, max: 10 },
        movement: { ...RATES },
        characteristics: { willpower: { base: 30, total: 30 } }
    };
    actor.items = [weapon(`gun-${id}`, fullAuto)];
    actor.statuses = new Set(statuses);
    const token = makeToken({ actor });
    token.x = x;
    token.y = y;
    token.width = 1;
    token.height = 1;
    token.disposition = -1;
    token.statuses = new Set(statuses);
    const combatant = makeCombatant({ actor, token });
    combatant.id = id;
    combatant.tokenId = token.id;
    combatant.initiative = initiative;
    combatant.defeated = false;
    withFireteam(combatant, teamPreset);
    return { actor, token, combatant };
}

function enemyWorldToken(id, x, y) {
    const actor = makeActor();
    actor.id = `actor-${id}`;
    actor.system = { wounds: { value: 0, max: 10 }, movement: { ...RATES } };
    actor.items = [weapon(`gun-${id}`, false)];
    actor.statuses = new Set();
    const token = makeToken({ actor });
    token.id = id;
    token.x = x;
    token.y = y;
    token.width = 1;
    token.height = 1;
    token.disposition = 1;
    token.statuses = new Set();
    const combatant = makeCombatant({ actor, token });
    combatant.id = `combatant-${id}`;
    combatant.tokenId = token.id;
    combatant.initiative = 5;
    return { actor, token, combatant };
}

/**
 * Standard recover world: leader m1, pinned m2, donor candidates m3/m4,
 * enemy e1 in sight to the west. Turn order is member-first so nobody has
 * acted yet at `turn: 0`.
 */
function makeWorld({
    pinned = ["m2"], memberCount = 4, round = 1, turn = 0, enemyAt = [850, 0]
} = {}) {
    const layout = [
        ["m1", 1000, 0, { initiative: 20 }],
        ["m2", 1050, 80, { initiative: 15, fullAuto: true }],
        ["m3", 1080, 160, { initiative: 12, fullAuto: true }],
        ["m4", 1110, 240, { initiative: 8 }]
    ].slice(0, Math.max(2, memberCount));
    const members = layout.map(([id, x, y, opts]) => worldMember(id, x, y, {
        ...opts,
        statuses: pinned.includes(id) ? ["pinned"] : []
    }));
    const enemies = [enemyWorldToken("e1", enemyAt[0], enemyAt[1])];
    const scene = makeScene({ grid: "square" });
    const combat = makeCombat({ round, turn, combatants: [
        ...members.map(member => member.combatant),
        ...enemies.map(enemy => enemy.combatant)
    ] });
    combat.scene = scene;
    scene.tokens = { contents: [...members.map(member => member.token), ...enemies.map(enemy => enemy.token)] };
    return { scene, combat, members, enemies };
}

function injectedTargets(world) {
    return world.enemies.map(({ token }) => ({
        tokenId: token.id,
        tokenUuid: token.uuid,
        actorId: token.actor?.id ?? null,
        x: token.x,
        y: token.y,
        elevation: 0,
        canAttack: true,
        visible: true,
        los: true,
        source: "injected",
        meleeEV: 0,
        hitChance: 0.5,
        meleeReach: 2
    }));
}

function losPerception(answer = true) {
    return {
        hasLineOfSight: () => answer
    };
}

/**
 * Capture-proxy planner: records every member context the fireteam builds
 * while delegating to the real planner service.
 */
function capturePlanner() {
    const planner = createPlannerService();
    registerSpecOpsPreset(planner);
    const contexts = [];
    const proxy = {
        planTurn: (combat, combatant, context) => {
            contexts.push({ combatantId: combatant.id, context });
            return planner.planTurn(combat, combatant, context);
        }
    };
    return { proxy, contexts };
}

function baseContext(world, overrides = {}) {
    const targets = injectedTargets(world);
    return {
        seed: 42,
        readOnly: true,
        targets,
        tacticTargets: targets,
        actions: [directAction()],
        moves: [],
        rates: { ...RATES },
        navigation: makeNavigation(),
        dangerAt,
        perception: losPerception(true),
        personality: false,
        casualties: { total: 0, recent: 0, initialStrength: 4 },
        assignments: {
            m1: "assault",
            m2: "support",
            m3: "support",
            m4: "support"
        },
        ...overrides
    };
}

function setGrudge(world, memberId, enemyIndex = 0, round = 1) {
    const member = world.members.find(entry => entry.combatant.id === memberId);
    const enemy = world.enemies[enemyIndex];
    member.combatant.flags[MODULE_ID][FLAG_KEYS.lastAttacker] = {
        tokenId: enemy.token.id,
        tokenUuid: enemy.token.uuid,
        actorId: enemy.actor.id,
        round,
        turn: 0,
        woundsLost: 3,
        attribution: "targeted-card"
    };
}

function suppressionMessage(world, victimId, enemyIndex = 0, id = "msg-pin-1") {
    const victim = world.members.find(entry => entry.combatant.id === victimId);
    const enemy = world.enemies[enemyIndex];
    return {
        id,
        speaker: { token: enemy.token.id, actor: enemy.actor.id },
        flags: {
            "only-war-local": {
                rollData: {
                    flags: { isSuppressingFire: true },
                    tokenId: enemy.token.id,
                    ownerId: enemy.actor.id,
                    pinnedResults: [
                        { tokenId: victim.token.id, actorId: victim.actor.id, pinned: true }
                    ]
                }
            }
        }
    };
}

function recoverOf(result) {
    return result.diagnostics?.recover ?? result.teamPlan?.diagnostics?.recover ?? null;
}

function memberRow(plan, combatantId) {
    return plan.members.find(member => member.combatantId === combatantId) ?? null;
}

/* ---------------------------------------------------------------------- */
/* Confidence ladder end-to-end                                           */
/* ---------------------------------------------------------------------- */

test("fresh grudge attribution activates full mode with exactly one cover-fire donor", async () => {
    const world = makeWorld();
    setGrudge(world, "m2");
    const { proxy, contexts } = capturePlanner();
    const fireteam = createFireteamService();
    const result = await fireteam.buildTeamPlan(world.combat, "alpha", {
        ...baseContext(world),
        planner: proxy
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok, result.reason);
    const recover = recoverOf(result);
    assert.ok(recover, "recover diagnostics exist");
    assert.equal(recover.active, true);
    assert.equal(recover.mode, "full");
    assert.equal(recover.breakdown.attribution.method, "grudge");
    assert.equal(recover.breakdown.attribution.confidence, 2);
    // Exactly one donor: m1 is detached on the assault task, m4 loses the
    // deterministic donor ordering to the equally capable but higher
    // initiative m3.
    assert.equal(recover.coverAssignment?.combatantId, "m3");
    assert.equal(recover.coverAssignment?.for, "m2");
    assert.equal(result.teamPlan.recover?.active, true);
    assert.equal(result.teamPlan.recover?.coverAssignment?.combatantId, "m3");

    const rows = Object.fromEntries(result.teamPlan.members.map(member => [member.combatantId, member]));
    assert.equal(rows.m3.role, "cover-fire");
    assert.equal(rows.m3.task, "support");
    assert.equal(rows.m3.assignedTargetId, world.enemies[0].token.id);
    assert.equal(rows.m2.role, "recovering");
    assert.equal(rows.m2.task, "support");
    assert.notEqual(rows.m1.role, "cover-fire");
    assert.notEqual(rows.m4.role, "cover-fire");
    // Exactly one cover donor across the whole team.
    assert.equal(result.teamPlan.members.filter(member => member.role === "cover-fire").length, 1);

    // Member-context injection: the donor reads the source, the pinned
    // member reads the threat position, everyone else a soft redirect.
    const byMember = Object.fromEntries(contexts.map(entry => [entry.combatantId, entry.context]));
    assert.equal(byMember.m3.team.recover.role, "cover-fire");
    assert.equal(byMember.m3.team.recover.sourceTargetId, world.enemies[0].token.id);
    assert.equal(byMember.m3.team.recover.confidence, 2);
    assert.equal(byMember.m3.team.recover.method, "grudge");
    // The donor is suppression-capable (full-auto fixture), so the mode
    // resolution prefers suppression — the doctrinal context flag rides
    // the injection exactly as the issue's member-context contract says.
    assert.equal(byMember.m3.team.recover.preferSuppression, true);
    assert.equal(byMember.m3.team.recover.mode, "suppression");
    assert.ok(byMember.m3.team.recover.protect?.combatantId === "m2");
    assert.equal(byMember.m2.team.recover.role, "recovering");
    assert.ok(Number.isFinite(byMember.m2.team.recover.threatPosition?.x));
    assert.equal(byMember.m1.team.recover.role, null);
    assert.equal(byMember.m1.team.recover.redirectTargetId, world.enemies[0].token.id);
    assert.equal(byMember.m4.team.recover.redirectTargetId, world.enemies[0].token.id);
});

test("recorded suppression card attribution beats the grudge leg", async () => {
    const world = makeWorld();
    // Both evidence channels exist: the recorded card must win at
    // confidence 3 over the confidence-2 grudge.
    setGrudge(world, "m2");
    const messages = [suppressionMessage(world, "m2")];
    const { proxy } = capturePlanner();
    const fireteam = createFireteamService();
    const result = await fireteam.buildTeamPlan(world.combat, "alpha", {
        ...baseContext(world),
        planner: proxy,
        messages
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok, result.reason);
    const recover = recoverOf(result);
    assert.equal(recover.active, true);
    assert.equal(recover.breakdown.attribution.method, "recorded");
    assert.equal(recover.breakdown.attribution.confidence, 3);
    assert.equal(recover.coverAssignment?.combatantId, "m3");
    assert.equal(memberRow(result.teamPlan, "m3")?.role, "cover-fire");
});

test("los-nearest confidence-1 degrades to redirectOnly without any donor assignment", async () => {
    const world = makeWorld();
    // No grudge, no suppression card: the only evidence is the visible
    // hostile nearest to the pinned member.
    const { proxy, contexts } = capturePlanner();
    const fireteam = createFireteamService();
    const result = await fireteam.buildTeamPlan(world.combat, "alpha", {
        ...baseContext(world),
        planner: proxy
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok, result.reason);
    const recover = recoverOf(result);
    assert.equal(recover.active, true);
    assert.equal(recover.breakdown.attribution.method, "los-nearest");
    assert.equal(recover.breakdown.attribution.confidence, 1);
    assert.equal(recover.mode, "redirect-only");
    assert.equal(recover.coverAssignment, null);
    assert.equal(recover.redirectTargetId, world.enemies[0].token.id);
    // No assignment rewrite: nobody carries the cover-fire role, only the
    // pinned member demotes to recovering.
    assert.equal(result.teamPlan.members.filter(member => member.role === "cover-fire").length, 0);
    assert.equal(memberRow(result.teamPlan, "m2")?.role, "recovering");
    assert.equal(memberRow(result.teamPlan, "m3")?.role ?? null, null);
    // The soft redirect id reaches every free member context.
    const byMember = Object.fromEntries(contexts.map(entry => [entry.combatantId, entry.context]));
    assert.equal(byMember.m3.team.recover.role, null);
    assert.equal(byMember.m3.team.recover.redirectTargetId, world.enemies[0].token.id);
});

test("unknown attribution never fires into empty space", async () => {
    const world = makeWorld();
    // No evidence at all and the LOS probe answers negatively, so even the
    // los-nearest hypothesis cannot form.
    const { proxy, contexts } = capturePlanner();
    const fireteam = createFireteamService();
    const result = await fireteam.buildTeamPlan(world.combat, "alpha", {
        ...baseContext(world),
        planner: proxy,
        perception: losPerception(false)
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok, result.reason);
    const recover = recoverOf(result);
    assert.equal(recover.active, true);
    assert.equal(recover.breakdown.attribution.method, "unknown");
    assert.equal(recover.breakdown.attribution.confidence, 0);
    assert.equal(recover.coverAssignment, null);
    assert.equal(recover.redirectTargetId, null);
    // Not a single member carries a target narrowing or a cover role.
    for (const member of result.teamPlan.members) {
        assert.notEqual(member.role, "cover-fire");
    }
    const donorContexts = contexts.filter(entry => entry.context.team?.recover?.sourceTargetId != null);
    assert.equal(donorContexts.length, 0);
    const redirects = contexts.filter(entry => entry.context.team?.recover?.redirectTargetId != null);
    assert.equal(redirects.length, 0);
    // The pinned member still demotes to recovering — individual recovery
    // is always allowed.
    assert.equal(memberRow(result.teamPlan, "m2")?.role, "recovering");
});

test("stale grudge outside the tight round window is not evidence", async () => {
    const world = makeWorld({ round: 4 });
    // Written in round 1, evaluated in round 4: the issue-90 window is one
    // round, far tighter than the damage-grudge scoring window.
    setGrudge(world, "m2", 0, 1);
    const { proxy } = capturePlanner();
    const fireteam = createFireteamService();
    const result = await fireteam.buildTeamPlan(world.combat, "alpha", {
        ...baseContext(world),
        planner: proxy
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok, result.reason);
    const recover = recoverOf(result);
    assert.notEqual(recover.breakdown.attribution.method, "grudge");
    assert.ok(recover.breakdown.attribution.confidence <= 1);
});

/* ---------------------------------------------------------------------- */
/* Donor exclusions                                                       */
/* ---------------------------------------------------------------------- */

test("a donor who already acted this round is excluded", async () => {
    // Turn order is member-first; at turn index 4 everyone has acted.
    const world = makeWorld({ turn: 4 });
    setGrudge(world, "m2");
    const { proxy } = capturePlanner();
    const fireteam = createFireteamService();
    const result = await fireteam.buildTeamPlan(world.combat, "alpha", {
        ...baseContext(world),
        planner: proxy
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok, result.reason);
    const recover = recoverOf(result);
    assert.equal(recover.coverAssignment, null);
    assert.equal(result.teamPlan.members.filter(member => member.role === "cover-fire").length, 0);
    const candidates = recover.diagnostics?.donorSelection?.candidates ?? [];
    const acted = candidates.filter(candidate => candidate.reason === "has-acted");
    assert.ok(acted.length >= 2, `expected has-acted exclusions, got ${JSON.stringify(candidates)}`);
});

test("a GM-controlled member is never recruited as cover donor", async () => {
    const world = makeWorld();
    setGrudge(world, "m2");
    // m3 — the natural donor — was moved by the GM this round; m4 picks up
    // the role instead.
    const m3 = world.members.find(entry => entry.combatant.id === "m3");
    m3.combatant.flags[MODULE_ID][FLAG_KEYS.gmControlled] = { round: 1, turn: 0, reason: "test" };
    const { proxy } = capturePlanner();
    const fireteam = createFireteamService();
    const result = await fireteam.buildTeamPlan(world.combat, "alpha", {
        ...baseContext(world),
        planner: proxy
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok, result.reason);
    const recover = recoverOf(result);
    assert.notEqual(recover.coverAssignment?.combatantId, "m3");
    assert.equal(recover.coverAssignment?.combatantId, "m4");
    const candidates = recover.diagnostics?.donorSelection?.candidates ?? [];
    const m3Row = candidates.find(candidate => candidate.combatantId === "m3");
    assert.equal(m3Row?.reason, "gm-controlled");
});

test("an active commitment protects its holder from donor duty", async () => {
    const world = makeWorld();
    setGrudge(world, "m2");
    const m3 = world.members.find(entry => entry.combatant.id === "m3");
    m3.combatant.flags[MODULE_ID][FLAG_KEYS.committedPlan] = {
        id: "c-test",
        status: "active",
        combatId: world.combat.id,
        combatantId: "m3",
        createdRound: 1,
        createdTurn: 0,
        ttl: 1,
        source: "planner",
        steps: [{ id: "s1", type: "move" }],
        expectedState: { self: null, target: null, morale: null, threats: [] }
    };
    const { proxy } = capturePlanner();
    const fireteam = createFireteamService();
    const result = await fireteam.buildTeamPlan(world.combat, "alpha", {
        ...baseContext(world),
        planner: proxy
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok, result.reason);
    const recover = recoverOf(result);
    assert.notEqual(recover.coverAssignment?.combatantId, "m3");
    const candidates = recover.diagnostics?.donorSelection?.candidates ?? [];
    const m3Row = candidates.find(candidate => candidate.combatantId === "m3");
    assert.equal(m3Row?.reason, "commitment-protected");
});

test("a melee-engaged member is never recruited as cover donor", async () => {
    // m3 is repositioned far from the pinned m2 and the enemy stands right
    // next to it — inside melee reach of its position — so the strict
    // donor pool excludes it without tripping the pinned-in-melee gate.
    const world = makeWorld({ enemyAt: [1605, 805] });
    const m3 = world.members.find(entry => entry.combatant.id === "m3");
    m3.token.x = 1600;
    m3.token.y = 800;
    setGrudge(world, "m2");
    const { proxy } = capturePlanner();
    const fireteam = createFireteamService();
    const result = await fireteam.buildTeamPlan(world.combat, "alpha", {
        ...baseContext(world),
        planner: proxy
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok, result.reason);
    const recover = recoverOf(result);
    assert.notEqual(recover.coverAssignment?.combatantId, "m3");
    const candidates = recover.diagnostics?.donorSelection?.candidates ?? [];
    const m3Row = candidates.find(candidate => candidate.combatantId === "m3");
    assert.equal(m3Row?.reason, "in-melee");
});

test("detached flank and assault tasks are never hijacked", async () => {
    const world = makeWorld();
    setGrudge(world, "m2");
    const { proxy } = capturePlanner();
    const fireteam = createFireteamService();
    const result = await fireteam.buildTeamPlan(world.combat, "alpha", {
        ...baseContext(world),
        planner: proxy,
        assignments: {
            m1: "support",
            m2: "support",
            m3: "flank",
            m4: "assault"
        }
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok, result.reason);
    const recover = recoverOf(result);
    // Both detached members are excluded; only the leader on support
    // remains as a donor candidate.
    assert.equal(recover.coverAssignment?.combatantId, "m1");
    const candidates = recover.diagnostics?.donorSelection?.candidates ?? [];
    assert.equal(candidates.find(candidate => candidate.combatantId === "m3")?.reason, "detached-assignment");
    assert.equal(candidates.find(candidate => candidate.combatantId === "m4")?.reason, "detached-assignment");
});

test("maneuver-critical roles are never hijacked as cover donors", async () => {
    const world = makeWorld();
    setGrudge(world, "m2");
    const { proxy } = capturePlanner();
    const fireteam = createFireteamService();
    const result = await fireteam.buildTeamPlan(world.combat, "alpha", {
        ...baseContext(world),
        planner: proxy,
        assignments: {
            m1: { task: "support", role: "suppressor" },
            m2: "support",
            m3: { task: "support", role: "suppressor" },
            m4: "support"
        }
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok, result.reason);
    const recover = recoverOf(result);
    assert.equal(recover.coverAssignment?.combatantId, "m4");
    const candidates = recover.diagnostics?.donorSelection?.candidates ?? [];
    assert.equal(candidates.find(candidate => candidate.combatantId === "m3")?.reason, "critical-assignment");
});

test("the pinned member itself is never a donor candidate", async () => {
    const world = makeWorld();
    setGrudge(world, "m2");
    const { proxy } = capturePlanner();
    const fireteam = createFireteamService();
    const result = await fireteam.buildTeamPlan(world.combat, "alpha", {
        ...baseContext(world),
        planner: proxy
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok, result.reason);
    const candidates = recoverOf(result).diagnostics?.donorSelection?.candidates ?? [];
    const m2Row = candidates.find(candidate => candidate.combatantId === "m2");
    assert.equal(m2Row?.reason, "pinned");
});

test("focus executors are never pulled onto cover duty (priority rule R7)", async () => {
    const world = makeWorld();
    setGrudge(world, "m2");
    const { proxy } = capturePlanner();
    const fireteam = createFireteamService();
    const result = await fireteam.buildTeamPlan(world.combat, "alpha", {
        ...baseContext(world),
        planner: proxy,
        assignments: {
            m1: { task: "support", role: "focus" },
            m2: "support",
            m3: { task: "support", role: "focus" },
            m4: "support"
        }
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok, result.reason);
    const recover = recoverOf(result);
    // Both focus executors keep their concentration; only the unroled m4
    // remains for cover duty.
    assert.equal(recover.coverAssignment?.combatantId, "m4");
    const candidates = recover.diagnostics?.donorSelection?.candidates ?? [];
    assert.equal(candidates.find(candidate => candidate.combatantId === "m3")?.reason, "critical-assignment");
    assert.equal(candidates.find(candidate => candidate.combatantId === "m1")?.reason, "critical-assignment");
});

test("desperate regrouping members are excluded from the donor pool (priority rule R4)", async () => {
    const world = makeWorld();
    setGrudge(world, "m2");
    // A manual morale stub on the member's own flag is its base posture;
    // with the regroup task the R4 exclusion fires.
    const m3 = world.members.find(entry => entry.combatant.id === "m3");
    m3.combatant.flags[MODULE_ID][FLAG_KEYS.morale] = { tier: "desperate" };
    const { proxy } = capturePlanner();
    const fireteam = createFireteamService();
    const result = await fireteam.buildTeamPlan(world.combat, "alpha", {
        ...baseContext(world),
        planner: proxy,
        assignments: {
            m1: "assault",
            m2: "support",
            m3: "regroup",
            m4: "support"
        }
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok, result.reason);
    const recover = recoverOf(result);
    assert.notEqual(recover.coverAssignment?.combatantId, "m3");
    const candidates = recover.diagnostics?.donorSelection?.candidates ?? [];
    assert.equal(candidates.find(candidate => candidate.combatantId === "m3")?.reason, "regroup-desperate");
});

/* ---------------------------------------------------------------------- */
/* Gate behaviour                                                         */
/* ---------------------------------------------------------------------- */

test("no pinned member means no overlay at all", async () => {
    const world = makeWorld({ pinned: [] });
    const { proxy, contexts } = capturePlanner();
    const fireteam = createFireteamService();
    const result = await fireteam.buildTeamPlan(world.combat, "alpha", {
        ...baseContext(world),
        planner: proxy
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok, result.reason);
    assert.equal(recoverOf(result), null);
    assert.equal(result.teamPlan.recover, null);
    assert.equal(contexts.filter(entry => entry.context.team?.recover).length, 0);
});

test("all members pinned degrades to the inactive all-pinned gate", async () => {
    const world = makeWorld({ pinned: ["m1", "m2", "m3", "m4"] });
    const { proxy } = capturePlanner();
    const fireteam = createFireteamService();
    const result = await fireteam.buildTeamPlan(world.combat, "alpha", {
        ...baseContext(world),
        planner: proxy
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok, result.reason);
    const recover = recoverOf(result);
    assert.equal(recover.active, false);
    assert.equal(recover.gate, "all-pinned");
    // Nobody demotes, nobody redirects — the overlay is fully inert.
    assert.equal(result.teamPlan.members.filter(member => member.role === "recovering").length, 0);
});

test("a pinned member in melee is excluded from recovery triage", async () => {
    // The enemy stands in melee reach of the pinned m2: melee pinning is
    // not suppression recovery and the gate reports the exclusion.
    const world = makeWorld({ enemyAt: [1055, 85] });
    setGrudge(world, "m2");
    const { proxy } = capturePlanner();
    const fireteam = createFireteamService();
    const result = await fireteam.buildTeamPlan(world.combat, "alpha", {
        ...baseContext(world),
        planner: proxy
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok, result.reason);
    const recover = recoverOf(result);
    assert.equal(recover.active, false);
    assert.equal(recover.gate, "pinned-in-melee");
});

test("a pinned flanker is always demoted to support+recovering (priority rule R5)", async () => {
    const world = makeWorld();
    setGrudge(world, "m2");
    const { proxy } = capturePlanner();
    const fireteam = createFireteamService();
    const result = await fireteam.buildTeamPlan(world.combat, "alpha", {
        ...baseContext(world),
        planner: proxy,
        assignments: {
            m1: "assault",
            m2: "flank",
            m3: "support",
            m4: "support"
        }
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok, result.reason);
    const row = memberRow(result.teamPlan, "m2");
    assert.equal(row.task, "support");
    assert.equal(row.role, "recovering");
    assert.equal(row.element ?? null, null, "the flank element is stripped with the demotion");
    // The demotion is recorded in the recover diagnostics with the stable
    // reason, exactly like the gm/morale demotion channels.
    const demotions = recoverOf(result).demotions ?? [];
    assert.ok(demotions.some(entry => entry.combatantId === "m2"
        && entry.from === "flank" && entry.reason === "recover-pinned"));
});

/* ---------------------------------------------------------------------- */
/* Issue #93 regression: the unpin step survives the overlay              */
/* ---------------------------------------------------------------------- */

test("the pinned member keeps its zero-cost end-of-turn unpin step", async () => {
    const world = makeWorld();
    setGrudge(world, "m2");
    const { proxy } = capturePlanner();
    const fireteam = createFireteamService();
    const result = await fireteam.buildTeamPlan(world.combat, "alpha", {
        ...baseContext(world),
        planner: proxy
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok, result.reason);
    const pinnedPlan = result.teamPlan.memberPlans.m2;
    assert.ok(pinnedPlan, "pinned member has a plan");
    const unpin = (pinnedPlan.steps ?? []).find(step => step.type === "test" && step.input?.unpin === true);
    assert.ok(unpin, "unpin step survives the overlay");
    assert.equal(unpin.cost?.halves ?? unpin.input?.cost?.halves ?? 0, 0);
    // And nothing in the overlay duplicated the mechanic: at most one
    // unpin step exists in the plan.
    assert.equal((pinnedPlan.steps ?? []).filter(step => step.input?.unpin === true).length, 1);
});

/* ---------------------------------------------------------------------- */
/* Planner-level factor wiring                                            */
/* ---------------------------------------------------------------------- */

test("recovering members price endpoint cover improvement through recoverCover", async () => {
    const world = makeWorld();
    setGrudge(world, "m2");
    const { proxy, contexts } = capturePlanner();
    const fireteam = createFireteamService();
    const awayMove = {
        x: 1150,
        y: 80,
        i: 11,
        j: 0,
        cost: 2,
        los: true,
        cover: 0.8,
        waypoints: [{ x: 1050, y: 80 }, { x: 1150, y: 80 }]
    };
    const navigation = makeNavigation();
    // Cover oracle: the endpoint eastward is hard cover against the
    // western threat; the start position is open.
    navigation.coverEstimate = (token, point, threat) => {
        if (point.x >= 1100) return 0.8;
        return 0;
    };
    const result = await fireteam.buildTeamPlan(world.combat, "alpha", {
        ...baseContext(world),
        planner: proxy,
        navigation,
        moves: [awayMove]
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok, result.reason);
    const pinnedContext = contexts.find(entry => entry.combatantId === "m2")?.context;
    assert.equal(pinnedContext?.team?.recover?.role, "recovering");
    const pinnedPlan = result.teamPlan.memberPlans.m2;
    // The recoverCover factor exists in the factor vector of the winning
    // plan whenever the endpoint genuinely improves cover.
    assert.ok("recoverCover" in (pinnedPlan.breakdown?.factors ?? {}));
});

/* ---------------------------------------------------------------------- */
/* Interaction guards                                                     */
/* ---------------------------------------------------------------------- */

test("peel-withdrawal roles survive — withdraw/cover members are never donors", async () => {
    const world = makeWorld();
    setGrudge(world, "m2");
    const { proxy } = capturePlanner();
    const fireteam = createFireteamService();
    // Heavy casualties trigger the peel cascade; the withdraw/cover roles
    // it authors are maneuver-critical and must survive the overlay.
    const result = await fireteam.buildTeamPlan(world.combat, "alpha", {
        ...baseContext(world),
        planner: proxy,
        casualties: { total: 34, recent: 0, initialStrength: 100 },
        assignments: undefined
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok, result.reason);
    const recover = recoverOf(result);
    const candidates = recover?.diagnostics?.donorSelection?.candidates ?? [];
    for (const candidate of candidates) {
        const row = memberRow(result.teamPlan, candidate.combatantId);
        if (row?.role === "withdraw" || row?.role === "cover") {
            assert.equal(candidate.eligible, false,
                `peel role ${row.role} of ${candidate.combatantId} must stay excluded`);
        }
    }
    // No peel role was rewritten into cover-fire.
    for (const member of result.teamPlan.members) {
        if (member.role === "cover-fire") {
            assert.equal(recover.coverAssignment?.combatantId, member.combatantId);
        }
    }
});

test("the overlay never narrows the awareness pool — redirects are additive weights", async () => {
    // Two runs on the identical world: the redirect run carries a fresh
    // grudge, the control run has no evidence at all (and a negative LOS
    // probe), so its attribution is unknown and no redirect exists. Both
    // overlays are active with identical assignments — any pool difference
    // would be the overlay narrowing awareness, which the spec forbids.
    const world = makeWorld();
    const fireteam = createFireteamService();
    const run = async withGrudge => {
        if (withGrudge) setGrudge(world, "m2");
        else delete world.members[1].combatant.flags[MODULE_ID][FLAG_KEYS.lastAttacker];
        const { proxy, contexts } = capturePlanner();
        const result = await fireteam.buildTeamPlan(world.combat, "alpha", {
            ...baseContext(world),
            planner: proxy,
            perception: losPerception(withGrudge)
        });
        assert.equal(result.status, FIRETEAM_STATUS.ok, result.reason);
        return { result, contexts };
    };
    const redirect = await run(true);
    const control = await run(false);
    assert.equal(recoverOf(redirect.result).redirectTargetId, world.enemies[0].token.id);
    assert.equal(recoverOf(control.result).redirectTargetId, null);
    for (const entry of redirect.contexts) {
        // The cover donor's soft `assignedTargetId` narrowing is the one
        // sanctioned pool effect and is asserted separately; the redirect
        // weight channel of everyone else must leave the pool byte-identical.
        if (entry.context.team?.recover?.role === "cover-fire") continue;
        const other = control.contexts.find(row => row.combatantId === entry.combatantId);
        assert.ok(other, `control context for ${entry.combatantId}`);
        const poolOf = context => (context.targets ?? [])
            .map(target => target.tokenId ?? target.tokenUuid ?? target).sort();
        assert.deepEqual(poolOf(entry.context), poolOf(other.context),
            `${entry.combatantId}: redirect must not narrow the awareness pool`);
        // The overlay never writes exclusion lists either way.
        const excluded = entry.context.excludedAttackTargetIds ?? [];
        assert.ok(!excluded.includes(world.enemies[0].token.id));
    }
    // And the redirect channel itself is the weight-only injection.
    const m1 = redirect.contexts.find(entry => entry.combatantId === "m1");
    assert.equal(m1.context.team.recover.redirectTargetId, world.enemies[0].token.id);
});

/* ---------------------------------------------------------------------- */
/* Determinism and serialization                                          */
/* ---------------------------------------------------------------------- */

test("the overlay is deterministic and the TeamPlan JSON-round-trips", async () => {
    // One world, two evaluations: readOnly team planning is a pure function
    // of the live documents and the injected context, so identical inputs
    // must reproduce the byte-identical serialized plan.
    const world = makeWorld();
    setGrudge(world, "m2");
    const fireteam = createFireteamService();
    const build = async () => {
        const { proxy } = capturePlanner();
        return fireteam.buildTeamPlan(world.combat, "alpha", {
            ...baseContext(world),
            planner: proxy
        });
    };
    const first = await build();
    const second = await build();
    assert.equal(first.status, FIRETEAM_STATUS.ok, first.reason);
    assert.equal(second.status, FIRETEAM_STATUS.ok, second.reason);
    const firstPlan = JSON.parse(JSON.stringify(first.teamPlan));
    const secondPlan = JSON.parse(JSON.stringify(second.teamPlan));
    assert.equal(firstPlan.recover.active, true);
    assert.deepEqual(firstPlan.recover, secondPlan.recover);
    assert.deepEqual(
        firstPlan.members.map(member => [member.combatantId, member.task, member.role ?? null]),
        secondPlan.members.map(member => [member.combatantId, member.task, member.role ?? null])
    );
    assert.equal(firstPlan.id, secondPlan.id, "identical inputs reproduce the identical plan id");
});

test("overlay diagnostics never carry document references", async () => {
    const world = makeWorld();
    setGrudge(world, "m2");
    const { proxy } = capturePlanner();
    const fireteam = createFireteamService();
    const result = await fireteam.buildTeamPlan(world.combat, "alpha", {
        ...baseContext(world),
        planner: proxy
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok, result.reason);
    // A lossless JSON round-trip proves the plain-data contract — Foundry
    // documents are not JSON-serializable in a stable way.
    const clone = JSON.parse(JSON.stringify(result.teamPlan));
    assert.equal(clone.diagnostics.recover.active, true);
    assert.equal(clone.diagnostics.recover.coverAssignment.combatantId, "m3");
});

/* ---------------------------------------------------------------------- */
/* Suppression preference factor grading                                  */
/* ---------------------------------------------------------------------- */

test("recoverRedirect grades the doctrinal suppression tilt without forcing it", () => {
    const target = { tokenId: "source-token", tokenUuid: "source-uuid", canAttack: true };
    const suppression = { attackType: "suppressing_fire" };
    const standard = { attackType: "standard" };
    const base = { variant: "attack-in-place", target };
    // Without the doctrinal preference every attack type on the source
    // lights the full factor.
    assert.equal(_factorsOf({ ...base, action: standard, redirectTarget: "source-token" }).recoverRedirect, 1);
    assert.equal(_factorsOf({ ...base, action: suppression, redirectTarget: "source-token" }).recoverRedirect, 1);
    // With the preference the suppression answer keeps the full factor
    // while direct fire keeps a reduced but still dominant share — the
    // tilt decides close races, it never zeroes the direct answer.
    assert.equal(_factorsOf({
        ...base, action: suppression, redirectTarget: "source-token", redirectSuppress: true
    }).recoverRedirect, 1);
    const direct = _factorsOf({
        ...base, action: standard, redirectTarget: "source-token", redirectSuppress: true
    }).recoverRedirect;
    assert.ok(direct > 0.5 && direct < 1, `direct fire keeps a reduced share, got ${direct}`);
    // Non-attack variants and other targets never light the factor.
    assert.equal(_factorsOf({
        ...base, variant: "move-attack", move: { x: 1, y: 1 }, action: standard,
        target: { tokenId: "other", canAttack: true }, redirectTarget: "source-token",
        redirectSuppress: true
    }).recoverRedirect, 0);
});
