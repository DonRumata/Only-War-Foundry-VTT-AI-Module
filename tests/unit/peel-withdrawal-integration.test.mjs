/**
 * Integration tests for peel-withdrawal (issue #89): preset cascades,
 * fireteam input adaptation, object assignments, withdraw/disengage plan
 * generation, cover scoring and deterministic serialization.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { FLAG_KEYS, MODULE_ID } from "../../scripts/constants.js";
import { createFireteamService, FIRETEAM_STATUS } from "../../scripts/fireteam.js";
import { createPlannerService, PLANNER_STATUS } from "../../scripts/planner.js";
import { registerSpecOpsPreset, selectSpecOpsTactic } from "../../scripts/presets/spec-ops.js";
import { selectAssaultTactic } from "../../scripts/presets/assault.js";
import { selectRangedCoverTactic } from "../../scripts/presets/ranged-cover.js";
import { PEEL_WITHDRAWAL_NAME } from "../../scripts/tactics/peel-withdrawal.js";
import { makeActor, makeCombat, makeCombatant, makeScene, makeToken } from "./fixtures.mjs";

const RATES = Object.freeze({ half: 2, full: 4, charge: 6, run: 6 });

function round4(value) {
    return Math.round(value * 1e4) / 1e4;
}

function key(point) {
    return `${round4(point.x)},${round4(point.y)}`;
}

/** Read-only navigation oracle shared by selector and planner fixtures. */
function makeNavigation({ invalid = {}, failRoutes = {} } = {}) {
    return {
        validateEndpoint(token, destination) {
            const reason = invalid[key(destination)];
            return reason
                ? { status: "ok", valid: false, reason }
                : { status: "ok", valid: true, endpoint: { x: destination.x, y: destination.y } };
        },
        canReach(token, destination) {
            const route = this.planRoute(token, destination);
            return { status: route.status, reachable: route.exact === true, reason: route.reason, cost: route.cost };
        },
        planRoute(token, destination) {
            const failure = failRoutes[key(destination)];
            const from = token?.position ?? { x: 1000, y: 0 };
            if (failure) {
                return { status: "failed", exact: false, reason: failure, cost: null, waypoints: null };
            }
            return {
                status: "ok",
                exact: true,
                reason: null,
                endpoint: { x: destination.x, y: destination.y },
                cost: Math.hypot(destination.x - from.x, destination.y - from.y) / 66.6667,
                waypoints: [{ x: from.x, y: from.y }, { x: destination.x, y: destination.y }]
            };
        },
        coverEstimate: () => 0.5,
        findCandidates: () => ({ status: "ok", candidates: [] })
    };
}

function dangerAt(point) {
    if (point.x >= 1100) return 0.1;
    if (point.x >= 950) return 0.7;
    return 1;
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

function memberDto(id, x, y, { fullAuto = false, statuses = [], hasActed = false, turnIndex = 0 } = {}) {
    const actor = { id: `actor-${id}`, items: [weapon(`gun-${id}`, fullAuto)], system: { wounds: { value: 0, max: 10 }, movement: { ...RATES } }, statuses: new Set(statuses) };
    const token = { id: `token-${id}`, uuid: `token-uuid-${id}`, x, y, width: 1, height: 1, disposition: -1, actor, statuses: new Set(statuses) };
    return {
        combatantId: id,
        tokenId: token.id,
        position: { x, y },
        turnIndex,
        hasActed,
        enabled: true,
        defeated: false,
        combatant: { id, token, actor, disposition: -1, enabled: true, defeated: false }
    };
}

function targetDto(id, x, y, extra = {}) {
    return {
        tokenId: id,
        tokenUuid: `uuid-${id}`,
        x,
        y,
        elevation: 0,
        source: "visible",
        canAttack: true,
        hidden: false,
        meleeEV: 12,
        hitChance: 0.5,
        meleeReach: 2,
        ...extra
    };
}

function selectorInput(overrides = {}) {
    const members = [
        memberDto("m1", 1000, 0, { turnIndex: 0 }),
        memberDto("m2", 1050, 80, { fullAuto: true, turnIndex: 1 })
    ];
    return {
        members,
        leaderId: "m1",
        targets: [targetDto("e1", 850, 0, { engagedWith: ["m1"] })],
        casualties: { total: 34, recent: 0, initialStrength: 100 },
        moraleInfo: { tier: "pressured", effectiveTeamTier: "pressured" },
        rates: { ...RATES },
        navigation: makeNavigation(),
        dangerAt,
        context: {
            rates: { ...RATES },
            navigation: makeNavigation(),
            dangerAt,
            grid: { size: 100, distance: 1.5 }
        },
        ...overrides
    };
}

test("specOps cascade adapter triggers peel before legacy regroup-fallback", () => {
    const result = selectSpecOpsTactic(selectorInput());
    assert.equal(result.name, PEEL_WITHDRAWAL_NAME);
    assert.equal(result.reason, "losses");
    assert.equal(result.objective.type, PEEL_WITHDRAWAL_NAME);
    assert.equal(result.objective.ttl, 1);
    assert.ok(Number.isFinite(result.objective.regroupPoint.x));
    assert.equal(result.assignments.m1.task, "regroup");
    assert.equal(result.assignments.m1.role, "withdraw");
    assert.equal(result.assignments.m2.task, "support");
    assert.equal(result.assignments.m2.role, "cover");
    assert.equal(result.cover.mode, "suppression");
    assert.ok(result.breakdown.costs.length >= 1);
    assert.ok(result.breakdown.costs.some(row => row.combatantId === "m1"));
    assert.equal(result.breakdown.peel.selected, true);
});

test("OR trigger matrix reaches cascades through the integration adapter", () => {
    for (const [name, patch] of [
        ["morale", { casualties: { total: 0, recent: 0, initialStrength: 2 }, moraleInfo: { tier: "desperate" } }],
        ["losses", {}],
        ["close-threat", {
            casualties: { total: 0, recent: 0, initialStrength: 2 },
            moraleInfo: { tier: "pressured" },
            targets: [
                targetDto("e1", 850, 0),
                targetDto("e2", 930, 0),
                targetDto("e3", 960, 0)
            ]
        }]
    ]) {
        const result = selectSpecOpsTactic(selectorInput(patch));
        assert.equal(result.name, PEEL_WITHDRAWAL_NAME, name);
    }
});

test("selector is stateless, frozen, deterministic and JSON-round-trippable", () => {
    const input = selectorInput();
    const first = selectSpecOpsTactic(input);
    const second = selectSpecOpsTactic(input);
    assert.deepEqual(first, second);
    assert.ok(Object.isFrozen(first));
    assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
    assert.equal(input.members[0].role, undefined, "selector never annotates input members");
});

test("invalid regroup degrades to explainable legacy regroup-fallback", () => {
    const navigation = makeNavigation();
    navigation.validateEndpoint = () => ({ status: "ok", valid: false, reason: "occupied" });
    const input = selectorInput({ navigation, context: { ...selectorInput().context, navigation } });
    const result = selectSpecOpsTactic(input);
    // The exact rejection depends on which fan candidate the oracle first
    // invalidates; the contract is that peel never silently wins and the
    // legacy fallback remains available with peel diagnostics attached.
    assert.notEqual(result.name, PEEL_WITHDRAWAL_NAME);
    assert.equal(result.breakdown.peel.selected, false);
    assert.ok(result.breakdown.peel.reason);
});

test("assault and rangedCover cascades evaluate peel before their maneuvers", () => {
    const assault = selectAssaultTactic(selectorInput());
    assert.equal(assault.name, PEEL_WITHDRAWAL_NAME);
    const ranged = selectRangedCoverTactic(selectorInput());
    assert.equal(ranged.name, PEEL_WITHDRAWAL_NAME);
    const noTrigger = selectorInput({
        casualties: { total: 0, recent: 0, initialStrength: 2 },
        moraleInfo: { tier: "confident" },
        dangerAt: () => 0,
        context: { ...selectorInput().context, dangerAt: () => 0 },
        targets: [targetDto("e1", 2000, 0)]
    });
    const degraded = selectRangedCoverTactic(noTrigger);
    assert.notEqual(degraded.name, PEEL_WITHDRAWAL_NAME);
    assert.equal(degraded.breakdown.peel.selected, false);
});

/* ---------------------------------------------------------------------- */
/* Planner and TeamPlan end-to-end                                        */
/* ---------------------------------------------------------------------- */

function withFireteam(doc, preset = "specOps") {
    doc.flags[MODULE_ID] = doc.flags[MODULE_ID] ?? {};
    doc.flags[MODULE_ID][FLAG_KEYS.fireteam] = { teamId: "alpha", teamPreset: preset };
    return doc;
}

function worldMember(id, x, y, { initiative = 10, fullAuto = false } = {}) {
    const actor = makeActor({ enabled: true, preset: "specOps" });
    actor.system = {
        wounds: { value: 0, max: 10 },
        movement: { ...RATES },
        characteristics: { willpower: { base: 30, total: 30 } }
    };
    actor.items = [weapon(`gun-${id}`, fullAuto)];
    actor.statuses = new Set();
    const token = makeToken({ actor });
    token.x = x;
    token.y = y;
    token.disposition = -1;
    const combatant = makeCombatant({ actor, token });
    combatant.id = id;
    combatant.tokenId = token.id;
    combatant.initiative = initiative;
    combatant.defeated = false;
    withFireteam(combatant);
    return { actor, token, combatant };
}

function enemyWorldToken(id, x, y) {
    const actor = makeActor();
    actor.system = { wounds: { value: 0, max: 10 }, movement: { ...RATES } };
    actor.items = [];
    const token = makeToken({ actor });
    token.id = id;
    token.x = x;
    token.y = y;
    token.disposition = 1;
    const combatant = makeCombatant({ actor, token });
    combatant.id = `combatant-${id}`;
    combatant.tokenId = token.id;
    return { actor, token, combatant };
}

function makeWorld() {
    const members = [
        worldMember("m1", 1000, 0, { initiative: 20 }),
        worldMember("m2", 1050, 80, { initiative: 10, fullAuto: true })
    ];
    const enemies = [enemyWorldToken("e1", 850, 0)];
    const scene = makeScene({ grid: "square" });
    const combat = makeCombat({ round: 1, turn: 0, combatants: [
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
        x: token.x,
        y: token.y,
        elevation: 0,
        canAttack: true,
        source: "injected",
        meleeEV: 12,
        hitChance: 0.5,
        meleeReach: 2,
        engagedWith: ["m1"]
    }));
}

function withdrawalMove() {
    return {
        x: 1160,
        y: 0,
        i: 11,
        j: 0,
        cost: 2,
        los: true,
        cover: 0.5,
        withdrawal: true,
        waypoints: [{ x: 1000, y: 0 }, { x: 1160, y: 0 }]
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

test("fireteam buildTeamPlan carries peel roles, cost rows and a withdraw move end-to-end", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    registerSpecOpsPreset(planner);
    const contexts = [];
    const proxy = {
        planTurn: (combat, combatant, context) => {
            contexts.push({ combatantId: combatant.id, context });
            return planner.planTurn(combat, combatant, context);
        }
    };
    const fireteam = createFireteamService();
    const targets = injectedTargets(world);
    const result = await fireteam.buildTeamPlan(world.combat, "alpha", {
        seed: 42,
        readOnly: true,
        planner: proxy,
        targets,
        tacticTargets: targets,
        actions: [directAction()],
        moves: [withdrawalMove()],
        rates: { ...RATES },
        navigation: makeNavigation(),
        dangerAt,
        casualties: { total: 34, recent: 0, initialStrength: 100 },
        personality: false
    });
    assert.equal(result.status, FIRETEAM_STATUS.ok, result.reason);
    const plan = result.teamPlan;
    assert.equal(plan.tactic, PEEL_WITHDRAWAL_NAME);
    const rows = Object.fromEntries(plan.members.map(member => [member.combatantId, member]));
    assert.equal(rows.m1.role, "withdraw");
    assert.equal(rows.m1.task, "regroup");
    assert.equal(rows.m2.role, "cover");
    assert.equal(rows.m2.task, "support");
    const withdrawContext = contexts.find(entry => entry.combatantId === "m1")?.context;
    assert.ok(withdrawContext.team.peel.regroupPoint);
    assert.ok(withdrawContext.team.peel.cost);
    const withdrawPlan = plan.memberPlans.m1;
    assert.equal(withdrawPlan.breakdown.tactic.name, PEEL_WITHDRAWAL_NAME);
    assert.equal(withdrawPlan.breakdown.tactic.role, "withdraw");
    const move = withdrawPlan.steps.find(step => step.type === "move");
    assert.ok(move, "withdraw member receives an objective-driven move");
    assert.equal(move.input.to.x, 1160);
    assert.equal(withdrawPlan.breakdown.factors.withdrawal > 0, true);
    assert.ok("freeAttackCost" in withdrawPlan.breakdown.factors);
    const roundTrip = JSON.parse(JSON.stringify(plan));
    assert.equal(roundTrip.tactic, PEEL_WITHDRAWAL_NAME);
    assert.equal(roundTrip.members.find(member => member.combatantId === "m1").role, "withdraw");
});

test("withdraw candidate uses disengage only as move metadata", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    registerSpecOpsPreset(planner);
    const targets = injectedTargets(world).map(target => ({ ...target, x: 900 }));
    const combatant = world.members[0].combatant;
    const result = await planner.planTurn(world.combat, combatant, {
        seed: 7,
        targets,
        actions: [directAction()],
        moves: [withdrawalMove()],
        rates: { ...RATES },
        navigation: makeNavigation(),
        personality: false,
        team: {
            task: "regroup",
            role: "withdraw",
            regroupPoint: { x: 1160, y: 0 },
            peel: {
                regroupPoint: { x: 1160, y: 0 },
                threatCentroid: { x: 900, y: 0 },
                cost: { mode: "disengage", freeAttackRisk: 0, stayRisk: 10, engagers: ["uuid-e1"] }
            }
        }
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.equal(result.plan.breakdown.variant, "disengage");
    const move = result.plan.steps.find(step => step.type === "move");
    assert.equal(move.input.mode, "disengage");
    assert.deepEqual(move.input.disengagesFrom, ["uuid-e1"]);
    assert.equal(move.cost.halves, 2);
    assert.equal(result.plan.breakdown.factors.freeAttackCost, 0);
    assert.equal(result.plan.breakdown.factors.disengage, 1);
});

test("cover-role scoring prefers suppression and reaction-used overwatch is vetoed", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    registerSpecOpsPreset(planner);
    const suppressionAction = {
        ...directAction(),
        id: "suppress",
        attackType: "suppressing_fire",
        cost: "full"
    };
    const baseContext = {
        seed: 9,
        targets: injectedTargets(world),
        actions: [directAction(), suppressionAction],
        moves: [],
        navigation: makeNavigation(),
        personality: false,
        team: {
            task: "support",
            role: "cover",
            peel: { coverMode: "suppression", coverTargetUuid: world.enemies[0].token.uuid }
        }
    };
    const result = await planner.planTurn(world.combat, world.members[1].combatant, baseContext);
    assert.equal(result.status, PLANNER_STATUS.ok);
    const attack = result.plan.steps.find(step => step.type === "attack");
    assert.equal(attack?.input.attackType, "suppressing_fire");
    assert.ok(result.plan.breakdown.factors.coveringWithdrawal > 0);

    const reactionSpent = await planner.planTurn(world.combat, world.members[1].combatant, {
        ...baseContext,
        actions: [directAction()],
        reactionUsed: { round: 1, reason: "test" },
        team: { ...baseContext.team, peel: { coverMode: "overwatch", coverTargetUuid: world.enemies[0].token.uuid } }
    });
    assert.notEqual(reactionSpent.plan?.breakdown?.variant, "overwatch");
});

test("pinned withdrawal accepts only non-closing routes and explains closing vetoes", async () => {
    const world = makeWorld();
    const planner = createPlannerService();
    registerSpecOpsPreset(planner);
    const base = {
        seed: 10,
        targets: injectedTargets(world),
        actions: [directAction()],
        rates: { ...RATES },
        navigation: makeNavigation(),
        personality: false,
        selfStatuses: ["pinned"],
        team: {
            task: "regroup",
            role: "withdraw",
            regroupPoint: { x: 1160, y: 0 },
            peel: { threatCentroid: { x: 850, y: 0 }, cost: { mode: "withdraw", freeAttackRisk: 0, stayRisk: 10 } }
        }
    };
    const away = await planner.planTurn(world.combat, world.members[0].combatant, {
        ...base,
        moves: [withdrawalMove()]
    });
    assert.equal(away.status, PLANNER_STATUS.ok);
    assert.equal(away.plan.breakdown.variant, "withdraw");
    assert.equal(away.plan.steps.at(-1).type, "end-turn");
    assert.ok(away.plan.steps.some(step => step.type === "test" && step.input.unpin === true));

    const closingMove = { ...withdrawalMove(), x: 900, i: 9, waypoints: [{ x: 1000, y: 0 }, { x: 900, y: 0 }] };
    const closing = await planner.planTurn(world.combat, world.members[0].combatant, {
        ...base,
        moves: [closingMove]
    });
    assert.ok(closing.plan?.diagnostics?.rejected?.some(row => row.reason === "pinned-no-safe-exit"));
});
