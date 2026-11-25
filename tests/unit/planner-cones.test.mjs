/**
 * Unit tests for issue #14 cone candidates: spray weapons and
 * suppressing fire aim a serialized `template.direction` cone instead of
 * a token, with a strict friendly/neutral veto inside the cone.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PLANNER_STATUS, createPlannerService } from "../../scripts/planner.js";
import {
    makeActor,
    makeCombat,
    makeCombatant,
    makeScene,
    makeToken
} from "./fixtures.mjs";

/**
 * Build a small combat world: an AI-enabled NPC at (0, 0) plus hostile
 * enemies placed on the square scene.
 * @param {object} [options]
 * @param {object[]} [options.enemies] `{x, y}` placements.
 * @returns {object}
 */
function makeWorld({ enemies = [{ x: 300, y: 0 }] } = {}) {
    const scene = makeScene({ grid: "square" });
    const actor = makeActor({ enabled: true, preset: "assault" });
    actor.system = { wounds: { value: 12, max: 14 } };
    const token = makeToken({ actor });
    token.x = 0;
    token.y = 0;
    token.elevation = 0;
    token.disposition = -1;
    const combatant = makeCombatant({ actor, token });
    combatant.tokenId = token.id;
    combatant.initiative = 10;

    const enemyCombatants = enemies.map(enemy => {
        const enemyActor = makeActor();
        enemyActor.system = { wounds: { value: 0, max: 10 } };
        enemyActor.items = [];
        const enemyToken = makeToken({ actor: enemyActor });
        enemyToken.x = enemy.x;
        enemyToken.y = enemy.y;
        enemyToken.elevation = 0;
        enemyToken.disposition = 1;
        const enemyCombatant = makeCombatant({ actor: enemyActor, token: enemyToken });
        enemyCombatant.tokenId = enemyToken.id;
        return { combatant: enemyCombatant, token: enemyToken };
    });

    const combat = makeCombat({ round: 1, turn: 0, combatants: [combatant, ...enemyCombatants.map(e => e.combatant)] });
    combat.scene = scene;
    return { scene, actor, token, combatant, enemies: enemyCombatants, combat };
}

/**
 * Injected targets matching {@link makeWorld} enemies plus the coverage
 * scan (blastTokens) the cone sweep evaluates.
 * @param {object} world
 * @returns {object}
 */
function injected(world) {
    const targets = world.enemies.map(enemy => ({
        tokenId: enemy.token.id,
        tokenUuid: `Scene.${world.scene.id}.Token.${enemy.token.id}`,
        x: enemy.token.x,
        y: enemy.token.y,
        elevation: 0,
        canAttack: true,
        source: "injected"
    }));
    const blastTokens = world.enemies.map(enemy => ({
        tokenId: enemy.token.id,
        tokenUuid: `Scene.${world.scene.id}.Token.${enemy.token.id}`,
        x: enemy.token.x,
        y: enemy.token.y,
        disposition: 1
    }));
    return { targets, blastTokens };
}

/** A flamer-style spray action (template requirement + spray trait). */
function sprayAction() {
    return {
        id: "flamer", kind: "attack", type: "attack",
        name: "Flamer", itemUuid: "Actor.npc.Item.flamer", itemId: "flamer",
        weaponId: "flamer", weaponName: "Flamer",
        attackType: "standard",
        class: "ranged", range: 8,
        requirements: ["template"],
        spray: true,
        cost: "half",
        available: true
    };
}

/** A suppression action entry (system `actions.list` shape). */
function suppressionAction() {
    return {
        id: "supp", kind: "attack", type: "attack",
        name: "Heavy Bolter", itemUuid: "Actor.npc.Item.hb", itemId: "hb",
        weaponId: "hb", weaponName: "Heavy Bolter",
        attackType: "suppressing_fire",
        class: "ranged", range: 60,
        requirements: ["rateOfFire.burst|rateOfFire.full", "template"],
        rateOfFire: { single: 0, burst: 6, full: 10 },
        cost: "full",
        available: true
    };
}

test("spray attack emits a serialized template direction step", async () => {
    const world = makeWorld();
    const { targets, blastTokens } = injected(world);
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets,
        blastTokens,
        actions: [sprayAction()],
        moves: []
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const attack = result.plan.steps.find(step => step.type === "attack");
    assert.ok(attack, "attack step exists");
    assert.equal(attack.input.actionId, "flamer");
    assert.ok(Number.isFinite(attack.input.template?.direction), "cone direction serialized");
    // The lone enemy sits due east of the bot — the cone must point at it.
    assert.ok(Math.abs(attack.input.template.direction - 0) < 1e-6
        || Math.abs(attack.input.template.direction - 360) < 1e-6);
    assert.ok(Array.isArray(attack.input.covered) && attack.input.covered.length === 1);
    // Round-trip serialization keeps the template payload intact.
    const clone = JSON.parse(JSON.stringify(result.plan));
    assert.equal(
        clone.steps.find(step => step.type === "attack").input.template.direction,
        attack.input.template.direction
    );
});

test("suppressing fire emits suppressionFire + burstMode + template", async () => {
    const world = makeWorld();
    const { targets, blastTokens } = injected(world);
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets,
        blastTokens,
        actions: [suppressionAction()],
        moves: []
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const attack = result.plan.steps.find(step => step.type === "attack");
    assert.ok(attack, "suppression step exists");
    assert.equal(attack.input.attackType, "suppressing_fire");
    assert.equal(attack.input.suppressionFire, true);
    assert.equal(attack.input.burstMode, "semi_auto");
    assert.ok(Number.isFinite(attack.input.template?.direction));
});

test("a friendly inside the cone vetoes the template attack", async () => {
    const world = makeWorld();
    const { targets, blastTokens } = injected(world);
    blastTokens.push({ tokenUuid: "ally-uuid", x: 150, y: 0, disposition: -1 });
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets,
        blastTokens,
        actions: [suppressionAction()],
        moves: []
    });
    // The cone candidate is vetoed; the issue-#15 economy may still
    // rescue the turn with an aim/overwatch utility step.
    const attack = result.plan?.steps.find(step => step.type === "attack");
    assert.ok(!attack || attack.input.attackType !== "suppressing_fire",
        "no suppression step when the cone covers a friendly");
    const diagnostics = result.plan?.diagnostics ?? result.diagnostics ?? {};
    assert.ok((diagnostics.rejected ?? []).some(
        entry => String(entry.candidate).startsWith("cone|")
            && entry.reason === "cone-no-safe-aim"
    ));
});

test("clustered hostiles share one cone (midpoint direction, full coverage)", async () => {
    // Two enemies at bearings ~±11° relative to the bot — both fit inside
    // a single 45° suppression cone.
    const world = makeWorld({
        enemies: [{ x: 300, y: -60 }, { x: 300, y: 60 }]
    });
    const { targets, blastTokens } = injected(world);
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets,
        blastTokens,
        actions: [suppressionAction()],
        moves: []
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    const attack = result.plan.steps.find(step => step.type === "attack");
    assert.ok(attack);
    assert.equal(attack.input.covered.length, 2, "both hostiles inside the cone");
    // Midpoint direction ~0° (due east) — the cluster's centre axis.
    assert.ok(Math.abs(attack.input.template.direction) < 20);
    // Issue #93: the cone coverage feeds the `area` factor exactly like a
    // blast template — two covered hostiles saturate it. Before the fix
    // cone candidates never carried `blastHits` and `area` read 0.
    assert.equal(result.plan.breakdown.factors.area, 1,
        "two covered hostiles saturate the area factor");
});

test("a lone distant hostile outside the cone range yields no template step", async () => {
    const world = makeWorld({ enemies: [{ x: 90000, y: 0 }] });
    const { targets, blastTokens } = injected(world);
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets,
        blastTokens,
        actions: [suppressionAction()],
        moves: []
    });
    const attack = result.plan?.steps.find(step => step.type === "attack");
    assert.ok(!attack || !attack.input.template?.direction,
        "no cone template when the hostile is out of range");
    const diagnostics = result.plan?.diagnostics ?? result.diagnostics ?? {};
    assert.ok((diagnostics.rejected ?? []).some(
        entry => String(entry.candidate).startsWith("cone|")
            && entry.reason === "cone-no-safe-aim"
    ));
});

// --- Issue #30: cone orientation only by perceived anchors ------------------

test("a spray cone never orients at hostiles the bot cannot perceive", async () => {
    // The only perceived target sits far outside the flamer's reach; an
    // extra hostile on the scene (no LOS, no memory — injected through
    // `blastTokens` like the live canvas scan would) must not steer the
    // template. Before issue #30 the cone happily aimed at it.
    const world = makeWorld({ enemies: [{ x: 90000, y: 0 }] });
    const { targets, blastTokens } = injected(world);
    blastTokens.push({
        tokenUuid: `Scene.${world.scene.id}.Token.ghost`,
        tokenId: "ghost",
        x: 300,
        y: 0,
        elevation: 0,
        disposition: 1
    });
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets,
        blastTokens,
        actions: [sprayAction()],
        moves: []
    });
    const attack = result.plan?.steps.find(step => step.type === "attack");
    assert.ok(!attack || !attack.input.template?.direction,
        "no template aimed at an unperceived hostile");
    const diagnostics = result.plan?.diagnostics ?? result.diagnostics ?? {};
    assert.ok((diagnostics.rejected ?? []).some(
        entry => entry.reason === "cone-no-safe-aim"
    ), "unperceived hostiles yield no cone aim");
});

test("a spray cone aims the remembered point of a last-known contact", async () => {
    // The contact was seen at (400, 0) east; its live position drifted
    // west to (-500, 0) — the template must point at the memory, never
    // at the true position the bot cannot perceive (issue #30).
    const world = makeWorld({ enemies: [{ x: 90000, y: 0 }] });
    const lastKnown = {
        tokenId: "lost-enemy",
        tokenUuid: `Scene.${world.scene.id}.Token.lost-enemy`,
        x: 400,
        y: 0,
        elevation: 0,
        source: "last-known"
    };
    const blastTokens = [{
        tokenUuid: `Scene.${world.scene.id}.Token.lost-enemy`,
        tokenId: "lost-enemy",
        x: -500,
        y: 0,
        elevation: 0,
        disposition: 1
    }];
    const planner = createPlannerService();
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: [lastKnown],
        blastTokens,
        actions: [sprayAction()],
        moves: []
    });
    const attack = result.plan?.steps.find(step => step.type === "attack");
    assert.ok(attack?.input?.template, "cone attack produced");
    assert.ok(Math.abs(attack.input.template.direction) < 20,
        "cone aims the remembered point (~0°), not the live position (~180°)");
    assert.equal(attack.input.template.angle, 30);
    assert.equal(attack.input.template.range, 8);
    assert.deepEqual(attack.input.covered, [lastKnown.tokenUuid]);
});

test("no visible or last-known contact produces no overwatch or spray candidate", async () => {
    // Issue #30 DoD: without perception anchors there is nothing to
    // orient a cone at — neither a spray/suppression template nor an
    // overwatch declaration may appear.
    const world = makeWorld({ enemies: [{ x: 300, y: 0 }] });
    const planner = createPlannerService();
    planner.registerPreset("assault", {
        weights: { overwatch: 10, holdPosition: 1 },
        allowNoTarget: true,
        allowNoAction: true,
        alwaysOfferHold: true
    });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: [],
        actions: [sprayAction(), { id: "las", name: "Lasgun", itemUuid: "Actor.a.Item.w1", class: "ranged", range: 30, damage: 5, cost: "half", attackType: "standard", weaponId: "w1" }],
        moves: []
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.ok(result.plan.steps.every(step => step.type !== "overwatch"),
        "no overwatch without a perceived threat");
    assert.ok(result.plan.steps.every(step => !step.input?.template),
        "no spray template without a perceived target");
});

test("overwatch never declares on a last-known or hidden contact", async () => {
    // Issue #30 memory rules: a remembered contact may steer a spray or
    // a memory-strike blast, but an overwatch declaration needs a live
    // visible threat — search moves cover last-known positions instead.
    const world = makeWorld({ enemies: [{ x: 90000, y: 0 }] });
    const lastKnown = {
        tokenId: "lost-enemy",
        tokenUuid: `Scene.${world.scene.id}.Token.lost-enemy`,
        x: 1500,
        y: 0,
        elevation: 0,
        source: "last-known"
    };
    const hiddenContact = {
        tokenId: "sneaky",
        tokenUuid: `Scene.${world.scene.id}.Token.sneaky`,
        x: 200,
        y: 0,
        elevation: 0,
        hidden: true,
        source: "injected"
    };
    const planner = createPlannerService();
    planner.registerPreset("assault", {
        weights: { overwatch: 10, holdPosition: 1 },
        allowNoAction: true,
        alwaysOfferHold: true
    });
    const result = await planner.planTurn(world.combat, world.combatant, {
        seed: 1,
        targets: [lastKnown, hiddenContact],
        actions: [{ id: "las", name: "Lasgun", itemUuid: "Actor.a.Item.w1", class: "ranged", range: 30, damage: 5, cost: "half", attackType: "standard", weaponId: "w1" }],
        moves: []
    });
    assert.equal(result.status, PLANNER_STATUS.ok);
    assert.ok(result.plan.steps.every(step => step.type !== "overwatch"),
        "no overwatch on memory-only or hidden contacts");
});
