/**
 * Unit tests for the GM-only plan/danger overlay (issues #29/#36):
 * the serializable draw-list view-model (`buildPlanOverlayModel`), the
 * deterministic danger → shade mapping, the PIXI layer lifecycle
 * (create/clear/teardown), GM/controller gating and the preview
 * controller wiring (open/replan/stale draw, decisions clear).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createModuleApi } from "../../scripts/api.js";
import {
    buildPlanOverlayModel,
    coneFanPoints,
    createPlanOverlayService,
    dangerCells,
    dangerShade,
    OVERLAY_REASONS,
    resetOverlayRoot
} from "../../scripts/ui/plan-overlay.js";
import { createPreviewController } from "../../scripts/ui/preview-dialog.js";

// --- Minimal PIXI stub ------------------------------------------------------

class FakeGraphics {
    constructor() {
        this.calls = [];
        this.destroyed = false;
    }

    beginFill(...args) { this.calls.push(["beginFill", ...args]); return this; }
    lineStyle(...args) { this.calls.push(["lineStyle", ...args]); return this; }
    drawPolygon(points) { this.calls.push(["drawPolygon", points]); return this; }
    drawRect(...args) { this.calls.push(["drawRect", ...args]); return this; }
    drawCircle(...args) { this.calls.push(["drawCircle", ...args]); return this; }
    drawRoundedRect(...args) { this.calls.push(["drawRoundedRect", ...args]); return this; }
    moveTo(...args) { this.calls.push(["moveTo", ...args]); return this; }
    lineTo(...args) { this.calls.push(["lineTo", ...args]); return this; }
    endFill() { this.calls.push(["endFill"]); return this; }
    destroy() { this.destroyed = true; }
}

class FakeContainer {
    constructor() {
        this.children = [];
        this.parent = null;
        this.destroyed = false;
        this.name = null;
    }

    addChild(child) {
        this.children.push(child);
        child.parent = this;
        return child;
    }

    removeChild(child) {
        const index = this.children.indexOf(child);
        if (index >= 0) this.children.splice(index, 1);
        child.parent = null;
        return child;
    }

    removeChildren() {
        const removed = this.children.splice(0);
        for (const child of removed) child.parent = null;
        return removed;
    }

    getChildByName(name) {
        return this.children.find(child => child.name === name) ?? null;
    }

    destroy() {
        this.destroyed = true;
        for (const child of this.removeChildren()) child.destroy?.();
    }
}

class FakeText extends FakeContainer {
    constructor(text) {
        super();
        this.text = text;
        this.anchor = { set: () => {} };
        this.position = { set: () => {} };
    }
}

/**
 * Install a canvas/PIXI stub world for one test.
 * @param {object} [options]
 * @param {boolean} [options.isGM]
 * @param {object} [options.scene]
 * @returns {{templates: FakeContainer, scene: object}}
 */
function makeCanvasWorld({ isGM = true, scene = {} } = {}) {
    const templates = new FakeContainer();
    const sceneDoc = {
        id: "scene-1",
        grid: { size: 100, distance: 1.5, type: 1 },
        width: 2000,
        height: 2000,
        tokens: [],
        ...scene
    };
    globalThis.PIXI = {
        Container: FakeContainer,
        Graphics: FakeGraphics,
        Text: FakeText
    };
    globalThis.canvas = {
        templates,
        scene: sceneDoc,
        tokens: { placeables: [] },
        dimensions: { width: 2000, height: 2000 }
    };
    game.user.isGM = isGM;
    resetOverlayRoot();
    return { templates, scene: sceneDoc };
}

/**
 * Serialized plan fixture: move → cone attack → end-turn with a target.
 * @returns {object}
 */
function makeSerializedPlan() {
    return {
        id: "plan-ov-1",
        operationId: "op-ov-1",
        snapshot: {
            self: { tokenId: "npc1", x: 0, y: 0 },
            target: { tokenId: "enemy1", tokenUuid: "Scene.scene-1.Token.enemy1", x: 300, y: 0 }
        },
        steps: [
            {
                id: "step-move-1",
                type: "move",
                input: {
                    to: { x: 200, y: 0 },
                    waypoints: [{ x: 100, y: 0 }, { x: 200, y: 0 }],
                    distance: 3,
                    approximate: false
                }
            },
            {
                id: "step-attack-2",
                type: "attack",
                input: {
                    actionId: "flamer",
                    attackType: "standard",
                    range: 9,
                    targetTokenUuid: "Scene.scene-1.Token.enemy1",
                    template: { direction: 0, angle: 30, range: 9 },
                    covered: ["Scene.scene-1.Token.enemy1"],
                    suppressionFire: false
                }
            },
            { id: "step-end-3", type: "end-turn", input: {} }
        ]
    };
}

test("coneFanPoints produces a sector fan from origin to arc", () => {
    const points = coneFanPoints({ x: 0, y: 0 }, 0, 30, 100);
    // First pair is the apex; the last vertex sits on the +arc/2 ray.
    assert.equal(points[0], 0);
    assert.equal(points[1], 0);
    const endX = points[points.length - 2];
    const endY = points[points.length - 1];
    assert.ok(Math.abs(endX - (Math.cos(Math.PI / 12) * 100)) < 1e-6);
    assert.ok(Math.abs(endY - (Math.sin(Math.PI / 12) * 100)) < 1e-6);
});

test("buildPlanOverlayModel emits route, cone and target from a serialized plan", () => {
    const plan = makeSerializedPlan();
    const model = buildPlanOverlayModel(plan, {
        self: { x: 0, y: 0, w: 100, h: 100 },
        target: { x: 300, y: 0, w: 100, h: 100 },
        pxPerUnit: 100 / 1.5,
        operationId: "op-ov-1"
    });

    // Serializable contract.
    assert.deepEqual(JSON.parse(JSON.stringify(model)), model);
    assert.equal(model.operationId, "op-ov-1");
    assert.equal(model.planId, "plan-ov-1");
    assert.equal(model.stale, false);

    // Route: self centre → waypoint centres → destination centre (the
    // `to` doc position duplicates the last waypoint → no extra point).
    assert.deepEqual(model.route.points, [
        { x: 50, y: 50 },
        { x: 150, y: 50 },
        { x: 250, y: 50 }
    ]);
    assert.equal(model.route.approximate, false);

    // Cone: apex at the attack origin (destination centre), serialized
    // geometry through template.direction/angle/range.
    assert.equal(model.cones.length, 1);
    const cone = model.cones[0];
    assert.equal(cone.kind, "spray");
    assert.equal(cone.direction, 0);
    assert.equal(cone.arc, 30);
    assert.equal(cone.rangeUnits, 9);
    assert.ok(Math.abs(cone.radiusPx - 600) < 1e-6);
    assert.deepEqual(cone.origin, { x: 250, y: 50 });

    // Target highlight uses the resolved token bounds.
    assert.equal(model.target.tokenId, "enemy1");
    assert.deepEqual(model.target.bounds, { x: 300, y: 0, w: 100, h: 100 });
    assert.deepEqual(model.blasts, []);
});

test("buildPlanOverlayModel maps blast targetPoint and overwatch steps", () => {
    const plan = {
        id: "plan-ov-2",
        snapshot: { self: { tokenId: "npc1", x: 0, y: 0 }, target: null },
        steps: [
            {
                id: "s1",
                type: "attack",
                input: {
                    targetPoint: { x: 400, y: 400 },
                    blastRadius: 5,
                    range: 60
                }
            },
            {
                id: "s2",
                type: "overwatch",
                input: { direction: 90, arc: 45, range: 30 }
            },
            { id: "s3", type: "end-turn", input: {} }
        ]
    };
    const model = buildPlanOverlayModel(plan, {
        self: { x: 0, y: 0, w: 100, h: 100 },
        pxPerUnit: 100
    });
    assert.equal(model.blasts.length, 1);
    assert.equal(model.blasts[0].radiusPx, 500);
    assert.equal(model.cones.length, 1);
    assert.equal(model.cones[0].kind, "overwatch");
    assert.equal(model.cones[0].direction, 90);
    assert.equal(model.cones[0].arc, 45);
    assert.equal(model.cones[0].radiusPx, 3000);
    assert.deepEqual(model.cones[0].origin, { x: 50, y: 50 });
    assert.equal(model.route, null);
    assert.equal(model.target, null);
});

test("dangerShade is deterministic and monotonic in alpha", () => {
    const low = dangerShade(0.1);
    const mid = dangerShade(0.5);
    const high = dangerShade(1);
    assert.deepEqual(dangerShade(0.5), mid);
    assert.ok(low.alpha < mid.alpha && mid.alpha < high.alpha);
    assert.ok(high.alpha <= 0.5);
    assert.equal(dangerShade(1.5).alpha, high.alpha);
    assert.equal(dangerShade(-2).alpha, dangerShade(0).alpha);
});

test("dangerCells scans deterministically and labels top contributors", () => {
    const map = {
        dangerAt: point => (point.x <= 500 && point.y <= 500 ? 0.8 : 0),
        explain: () => [{ id: "enemy1", contribution: 0.8 }]
    };
    const first = dangerCells(map, { width: 2000, height: 2000, cellSize: 100 });
    const second = dangerCells(map, { width: 2000, height: 2000, cellSize: 100 });
    assert.deepEqual(first, second);
    assert.equal(first.cells.length, 25);
    assert.ok(first.cells.every(cell => cell.danger === 0.8));
    assert.ok(first.labels.length > 0);
    assert.equal(first.labels[0].top.id, "enemy1");
    // Empty map → empty heat.
    assert.deepEqual(dangerCells(null, { width: 100, height: 100 }).cells, []);
});

test("showPlan draws into the shared root on a GM client and clears", () => {
    const { templates } = makeCanvasWorld();
    const api = createModuleApi();
    api._state.enabled = true;
    api.services.register("authority", { isController: () => true });
    const overlay = createPlanOverlayService({ api, getDangerEnabled: () => false });
    overlay.start();

    const combat = { combatants: [], combatant: null };
    const combatant = { id: "c1", token: { id: "npc1", x: 0, y: 0, width: 1, height: 1 } };
    const result = overlay.showPlan(makeSerializedPlan(), {
        combat,
        combatant,
        operationId: "op-ov-1"
    });
    assert.equal(result.ok, true);
    const root = templates.getChildByName("ow-ai-overlay");
    assert.ok(root, "shared overlay root exists");
    const planLayer = root.getChildByName("plan");
    assert.ok(planLayer, "plan layer exists");
    assert.ok(planLayer.children.length >= 2, "route + cone + target drawn");
    assert.equal(overlay.describe().plan.active, true);

    overlay.clearPlan("op-ov-1");
    assert.equal(overlay.describe().plan.active, false);
    assert.equal(planLayer.children.length, 0);
});

test("showPlan refuses non-controller clients and never draws", () => {
    const { templates } = makeCanvasWorld();
    const api = createModuleApi();
    api._state.enabled = true;
    api.services.register("authority", { isController: () => false });
    const overlay = createPlanOverlayService({ api, getDangerEnabled: () => false });
    overlay.start();

    const result = overlay.showPlan(makeSerializedPlan(), {
        combat: { combatants: [] },
        combatant: { token: { id: "npc1", x: 0, y: 0 } },
        operationId: "op-x"
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, OVERLAY_REASONS.notController);
    assert.equal(templates.children.length, 0, "no overlay root created");
});

test("the danger overlay toggles, draws heat cells and cleans up (GM-only)", () => {
    const { templates } = makeCanvasWorld();
    const api = createModuleApi();
    api._state.enabled = true;
    api.services.register("authority", { isController: () => true });
    api.services.register("threatMap", {
        map: () => ({
            dangerAt: point => (point.x <= 500 ? 0.6 : 0),
            explain: () => [{ id: "enemy1", contribution: 0.6 }]
        }),
        buildMap: () => null
    });
    const overlay = createPlanOverlayService({ api, getDangerEnabled: () => false });
    overlay.start();
    assert.equal(overlay.dangerEnabled, false);

    overlay.setDangerEnabled(true, { persist: false });
    assert.equal(overlay.dangerEnabled, true);
    const root = templates.getChildByName("ow-ai-overlay");
    const dangerLayer = root?.getChildByName("danger");
    assert.ok(dangerLayer, "danger layer exists");
    assert.ok(dangerLayer.children.length > 0, "heat cells drawn");
    assert.equal(overlay.describe().danger.drawn, dangerLayer.children.length);

    overlay.setDangerEnabled(false, { persist: false });
    assert.equal(overlay.dangerEnabled, false);
    assert.equal(dangerLayer.children.length, 0);
});

test("the danger overlay draws nothing for non-GM clients", () => {
    const { templates } = makeCanvasWorld({ isGM: false });
    const api = createModuleApi();
    api._state.enabled = true;
    api.services.register("threatMap", {
        map: () => ({ dangerAt: () => 0.9, explain: () => [] })
    });
    const overlay = createPlanOverlayService({ api, getDangerEnabled: () => true });
    overlay.start();
    assert.equal(overlay.dangerEnabled, true, "toggle state kept");
    assert.equal(templates.children.length, 0, "players see nothing");
});

// --- Preview controller wiring (issue #29) ----------------------------------

/**
 * Minimal preview rig with an overlay spy — verifies open/replan/stale
 * draw and every decision path clears.
 * @returns {object}
 */
function makePreviewRig() {
    const api = createModuleApi();
    api._state.enabled = true;
    const completed = [];
    const transitions = [];
    api.services.register("authority", {
        isController: () => true,
        operations: {
            completeTurn: async (combat, id, result) => {
                completed.push({ id, result });
                return { ok: true };
            },
            transitionOperation: async (combat, id, from, to) => {
                transitions.push({ id, from, to });
                return { ok: true };
            }
        }
    });
    api.services.register("executor", {
        executePlan: async () => ({ status: "completed" }),
        clearExecutions: () => {}
    });
    const shows = [];
    const clears = [];
    api.services.register("planOverlay", {
        showPlan: (plan, context) => {
            shows.push({ plan, context });
            return { ok: true };
        },
        clearPlan: id => {
            clears.push(id);
            return { ok: true };
        }
    });
    const presented = [];
    const rendered = [];
    const preview = createPreviewController({
        api,
        getMode: () => "preview",
        getTimeout: () => 0,
        present: () => {
            presented.push(1);
            return { render: vm => rendered.push(vm), close: () => {} };
        },
        setTimer: () => 1,
        clearTimer: () => {}
    });
    return { api, preview, shows, clears, completed, transitions };
}

/**
 * Open a preview session on the rig with a synthetic plan.
 * @param {object} rig
 * @param {object} [plan]
 * @returns {Promise<object>}
 */
async function openRigSession(rig, plan = makeSerializedPlan()) {
    const operation = { id: `op-${rig.shows.length + 1}`, phase: "awaiting-preview" };
    const opened = rig.preview.openPreview({
        combat: { combatants: [], round: 1, turn: 0, ended: false },
        combatant: { id: "c1", token: { id: "npc1", x: 0, y: 0 } },
        operation,
        plan,
        planContext: {}
    });
    return { opened, operation };
}

test("openPreview draws the plan overlay; confirm clears it", async () => {
    const rig = makePreviewRig();
    const { opened, operation } = await openRigSession(rig);
    assert.equal(opened.ok, true);
    assert.equal(rig.shows.length, 1);
    assert.equal(rig.shows[0].context.operationId, operation.id);

    const outcome = await rig.preview.resolvePreview(operation.id, { decision: "confirm" });
    assert.equal(outcome.ok, true);
    assert.deepEqual(rig.clears, [operation.id]);
});

test("cancel and timeout paths clear the plan overlay", async () => {
    const rig = makePreviewRig();
    const { opened, operation } = await openRigSession(rig);
    assert.equal(opened.ok, true);
    const outcome = await rig.preview.resolvePreview(operation.id, { decision: "cancel" });
    assert.equal(outcome.ok, true);
    assert.deepEqual(rig.clears, [operation.id]);
});

test("replan redraws the overlay with the new plan", async () => {
    const rig = makePreviewRig();
    const { opened, operation } = await openRigSession(rig);
    assert.equal(opened.ok, true);
    assert.equal(rig.shows.length, 1);

    // Planner stub returns a fresh plan for the replan.
    const newPlan = { ...makeSerializedPlan(), id: "plan-ov-2", replanCount: 1 };
    rig.api.services.register("planner", {
        planTurn: async () => ({ status: "ok", plan: newPlan }),
        validateSnapshot: () => ({ valid: true, reason: null })
    });
    const outcome = await rig.preview.resolvePreview(operation.id, { decision: "replan" });
    assert.equal(outcome.ok, true);
    // Second draw: the overlay re-rendered with the replanned plan.
    assert.equal(rig.shows.length, 2);
    assert.strictEqual(rig.shows[1].plan, newPlan);
    assert.equal(rig.clears.length, 0, "overlay redraws in place");
});

test("a stale marker re-draws the overlay with the stale flag", async () => {
    const rig = makePreviewRig();
    const { opened, operation } = await openRigSession(rig);
    assert.equal(opened.ok, true);
    assert.equal(rig.shows.length, 1);

    // A recoverable stale (token moved) marks the session and re-renders
    // the overlay so the canvas picture matches the banner.
    const verdicts = [
        { valid: false, reason: "token-moved" },
        { valid: false, reason: "turn-stale" }
    ];
    rig.api.services.register("planner", {
        validateSnapshot: () => verdicts.shift() ?? { valid: true, reason: null }
    });
    rig.preview.checkStale();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(rig.preview.hasSession(operation.id), true);
    assert.equal(rig.shows.length, 2);
    assert.equal(rig.shows[1].context.stale, "token-moved");

    // A terminal stale auto-cancels — the overlay clears with the drop.
    rig.preview.checkStale();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(rig.preview.hasSession(operation.id), false);
    assert.deepEqual(rig.clears, [operation.id]);
});

// --- Attack ray + overlay persistence (review findings) ---------------------

test("buildPlanOverlayModel emits an attack ray from origin to target centre", () => {
    const model = buildPlanOverlayModel(makeSerializedPlan(), {
        self: { x: 0, y: 0, w: 100, h: 100 },
        target: { x: 300, y: 0, w: 100, h: 100 },
        pxPerUnit: 100 / 1.5,
        operationId: "op-ov-1",
        sceneId: "scene-1"
    });
    // From the move destination centre to the target bounds centre.
    assert.deepEqual(model.attackRay, {
        from: { x: 250, y: 50 },
        to: { x: 350, y: 50 }
    });
    assert.equal(model.sceneId, "scene-1");

    // No resolvable target → no ray.
    const rayless = buildPlanOverlayModel({
        ...makeSerializedPlan(),
        snapshot: { self: { tokenId: "npc1", x: 0, y: 0 }, target: null },
        steps: makeSerializedPlan().steps.filter(step => step.type !== "attack")
    }, { self: { x: 0, y: 0, w: 100, h: 100 } });
    assert.equal(rayless.attackRay, null);
});

test("updateCombat without a turn advance keeps the plan overlay", () => {
    const { templates } = makeCanvasWorld();
    const api = createModuleApi();
    api._state.enabled = true;
    api.services.register("authority", { isController: () => true });
    const overlay = createPlanOverlayService({ api, getDangerEnabled: () => false });
    overlay.start();
    overlay.showPlan(makeSerializedPlan(), {
        combat: { combatants: [] },
        combatant: { token: { id: "npc1", x: 0, y: 0, width: 1, height: 1 } },
        operationId: "op-ov-1"
    });
    const root = templates.getChildByName("ow-ai-overlay");
    const planLayer = root.getChildByName("plan");
    assert.ok(planLayer.children.length > 0, "plan drawn");

    const onUpdateCombat = Hooks._calls
        .filter(call => call.event === "updateCombat").at(-1).fn;

    // Unrelated Combat writes (operation flags during an open preview)
    // must not wipe the picture.
    onUpdateCombat({}, { flags: { "only-war-ai": { operation: { phase: "awaiting-preview" } } } });
    assert.equal(overlay.describe().plan.active, true);
    assert.ok(planLayer.children.length > 0, "overlay survives flag writes");

    // A turn advance does clear it.
    onUpdateCombat({}, { turn: 2, round: 1 });
    assert.equal(overlay.describe().plan.active, false);
    assert.equal(planLayer.children.length, 0);
});

test("canvasReady redraws the plan on the same scene and drops it on a scene change", () => {
    const { templates } = makeCanvasWorld();
    const api = createModuleApi();
    api._state.enabled = true;
    api.services.register("authority", { isController: () => true });
    const overlay = createPlanOverlayService({ api, getDangerEnabled: () => false });
    overlay.start();
    overlay.showPlan(makeSerializedPlan(), {
        combat: { combatants: [] },
        combatant: { token: { id: "npc1", x: 0, y: 0, width: 1, height: 1 } },
        operationId: "op-ov-1"
    });
    assert.equal(overlay.describe().plan.active, true);

    const onCanvasReady = Hooks._calls
        .filter(call => call.event === "canvasReady").at(-1).fn;

    // Canvas re-init on the same scene: the PIXI tree is gone, the model
    // is kept and the plan is redrawn.
    resetOverlayRoot();
    onCanvasReady();
    const root = templates.getChildByName("ow-ai-overlay");
    assert.ok(root, "root recreated");
    assert.ok(root.getChildByName("plan").children.length > 0, "plan redrawn");
    assert.equal(overlay.describe().plan.active, true);

    // A scene switch drops the stale model — nothing is drawn.
    canvas.scene = { ...canvas.scene, id: "scene-2" };
    resetOverlayRoot();
    onCanvasReady();
    assert.equal(overlay.describe().plan.active, false);
});
