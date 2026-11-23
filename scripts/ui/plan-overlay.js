/**
 * GM-only canvas overlays (issues #29/#30/#36): one shared debug/preview
 * drawing layer for AI plans, overwatch zones and the threat heatmap.
 *
 * Design contract (epic #363):
 * - Pure client-side rendering: the overlay is a PIXI `Container` tree on
 *   the templates layer. It never writes documents, never uses sockets
 *   and is drawn only on GM clients (`game.user.isGM`); the plan preview
 *   part additionally honours the authority controller check, matching
 *   the preview dialog gate (issue #409).
 * - Every consumer renders into a named sub-layer of the shared root
 *   container (`ensureOverlayLayer`) so preview plans (#29), declared
 *   overwatch zones (#14/#30) and the danger heatmap (#36) share one
 *   lifecycle: `canvasTearDown` destroys the tree, `canvasReady` lazily
 *   recreates it on the next draw.
 * - `buildPlanOverlayModel` converts a serialized planner plan into a
 *   plain view-model `{route, cones, blasts, target}`; all coordinates
 *   are canvas pixels, all cone data comes from serialized step inputs
 *   (`template.direction/angle/range`, `overwatch.direction/arc/range`,
 *   `targetPoint` + `blastRadius`).
 * - `dangerShade`/`dangerCells` are the deterministic threat-map (#16)
 *   heat mapping used by the debug overlay toggle
 *   (`threatMapOverlay` world setting or the Shift+M keybinding).
 */
import { MODULE_ID, SETTING_KEYS } from "../constants.js";
import { isThreatMapOverlayEnabled, logDiagnostics } from "../settings.js";

/** Name of the shared root container on the templates layer. */
const ROOT_NAME = "ow-ai-overlay";

/** Named sub-layers of the shared root container. */
export const OVERLAY_LAYERS = Object.freeze({
    plan: "plan",
    overwatch: "overwatch",
    danger: "danger"
});

/** Stable reason codes returned by the overlay service. */
export const OVERLAY_REASONS = Object.freeze({
    notController: "not-controller",
    notGm: "not-gm",
    noPlan: "no-plan",
    noCanvas: "no-canvas",
    noMap: "no-map"
});

/** Plan overlay palette. */
const ROUTE_COLOR = 0x33ccff;
const ROUTE_ALPHA = 0.9;
const CONE_COLOR = 0xffaa33;
const SUPPRESSION_COLOR = 0xff5533;
const OVERWATCH_COLOR = 0x33aaff;
const CONE_FILL_ALPHA = 0.15;
const CONE_EDGE_ALPHA = 0.7;
const BLAST_COLOR = 0xff3344;
const BLAST_FILL_ALPHA = 0.18;
const BLAST_EDGE_ALPHA = 0.8;
const TARGET_COLOR = 0x66ff66;
const TARGET_ALPHA = 0.9;
const RAY_COLOR = 0xff2233;
const RAY_ALPHA = 0.95;

/** Polygon fan step of rendered cone sectors (degrees). */
const CONE_FAN_STEP_DEG = 5;

/** Arrowhead size (pixels) of the route destination marker. */
const ARROW_SIZE_PX = 14;

/** Danger overlay: heat cells cap and top-contributor label count. */
const DANGER_MAX_CELLS = 2500;
const DANGER_LABEL_COUNT = 8;

/**
 * Normalize a Foundry collection/Map/array/iterable into a plain array.
 * @param {*} collection
 * @returns {object[]}
 */
function _list(collection) {
    if (!collection) return [];
    if (Array.isArray(collection)) return collection;
    if (Array.isArray(collection.contents)) return collection.contents;
    if (typeof collection.values === "function") return [...collection.values()];
    if (typeof collection[Symbol.iterator] === "function") return [...collection];
    return [];
}

/**
 * Unwrap a Token placeable to its TokenDocument; documents pass through.
 * @param {*} token
 * @returns {object|null}
 */
function _tokenDoc(token) {
    if (!token || typeof token !== "object") return null;
    const doc = token.document;
    if (doc && typeof doc === "object" && doc.documentName === "Token") return doc;
    return token;
}

/**
 * Numeric helper: value when finite, otherwise fallback.
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function _finiteOr(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}

/**
 * Normalize a pixel point `{x, y}` or return null.
 * @param {*} point
 * @returns {{x: number, y: number}|null}
 */
function _point(point) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/**
 * Normalize token bounds `{x, y, w, h}` (pixels) or return null.
 * @param {*} bounds
 * @returns {{x: number, y: number, w: number, h: number}|null}
 */
function _bounds(bounds) {
    const origin = _point(bounds);
    const w = Number(bounds?.w);
    const h = Number(bounds?.h);
    if (!origin || !(w > 0) || !(h > 0)) return null;
    return { x: origin.x, y: origin.y, w, h };
}

/**
 * Centre point of a bounds/doc rectangle in canvas pixels.
 * @param {object|null} bounds `{x, y, w, h}`.
 * @returns {{x: number, y: number}|null}
 */
function _center(bounds) {
    if (!bounds) return null;
    return { x: bounds.x + (bounds.w / 2), y: bounds.y + (bounds.h / 2) };
}

// --- Shared PIXI container tree --------------------------------------------

let _root = null;

/**
 * Lazily create the shared overlay root container on the templates layer.
 * The tree is rebuilt after `canvasTearDown` (the cached root detects a
 * destroyed parent). Returns null without PIXI/canvas.
 * @returns {PIXI.Container|null}
 */
export function ensureOverlayRoot() {
    if (_root && !_root.destroyed && _root.parent) return _root;
    _root = null;
    if (typeof PIXI === "undefined") return null;
    const layer = globalThis.canvas?.templates ?? globalThis.canvas?.stage ?? null;
    if (!layer || typeof layer.addChild !== "function") return null;
    _root = new PIXI.Container();
    _root.name = ROOT_NAME;
    _root.eventMode = "none";
    _root.zIndex = 10;
    layer.addChild(_root);
    return _root;
}

/**
 * Remove the shared overlay root container (canvas teardown/shutdown).
 * @returns {void}
 */
export function resetOverlayRoot() {
    if (_root) {
        try {
            _root.parent?.removeChild?.(_root);
            _root.destroy?.({ children: true });
        } catch(err) {
            // Best effort — a stale PIXI tree must not break services.
        }
        _root = null;
    }
}

/**
 * Find a named child layer of the shared root, if present.
 * @param {string} name Layer name (`OVERLAY_LAYERS` values or custom).
 * @returns {PIXI.Container|null}
 */
export function overlayLayer(name) {
    const root = (_root && !_root.destroyed) ? _root : null;
    if (!root) return null;
    if (typeof root.getChildByName === "function") {
        const hit = root.getChildByName(name);
        if (hit && !hit.destroyed) return hit;
    }
    return (root.children ?? []).find(child => child?.name === name && !child.destroyed) ?? null;
}

/**
 * Lazily create a named sub-layer under the shared overlay root.
 * @param {string} name Layer name.
 * @returns {PIXI.Container|null}
 */
export function ensureOverlayLayer(name) {
    const existing = overlayLayer(name);
    if (existing) return existing;
    const root = ensureOverlayRoot();
    if (!root || typeof PIXI === "undefined") return null;
    const layer = new PIXI.Container();
    layer.name = name;
    layer.eventMode = "none";
    root.addChild(layer);
    return layer;
}

/**
 * Remove the children of a named sub-layer without destroying the layer.
 * @param {string} name Layer name.
 * @returns {void}
 */
export function clearOverlayLayer(name) {
    const layer = overlayLayer(name);
    if (!layer) return;
    try {
        for (const child of layer.removeChildren()) {
            child.destroy?.({ children: true });
        }
    } catch(err) {
        // PIXI teardown is best effort.
    }
}

/**
 * Destroy a named sub-layer entirely.
 * @param {string} name Layer name.
 * @returns {void}
 */
export function removeOverlayLayer(name) {
    const layer = overlayLayer(name);
    if (!layer) return;
    try {
        layer.parent?.removeChild?.(layer);
        layer.destroy?.({ children: true });
    } catch(err) {
        // PIXI teardown is best effort.
    }
}

// --- Shared geometry --------------------------------------------------------

/**
 * Polygon points of a cone sector: the origin vertex plus the arc fan,
 * in the flat `[x0, y0, x1, y1, ...]` shape `PIXI.Graphics.drawPolygon`
 * accepts. Shared by the plan overlay (#29) and the overwatch service
 * (#14/#30) so both draw identical sectors.
 * @param {object} origin `{x, y}` cone apex in pixels.
 * @param {number} directionDeg Cone axis direction (degrees).
 * @param {number} arcDeg Full cone angle (degrees).
 * @param {number} radiusPx Cone length in pixels.
 * @param {number} [stepDeg] Fan tessellation step (degrees).
 * @returns {number[]} Flat polygon points.
 */
export function coneFanPoints(origin, directionDeg, arcDeg, radiusPx, stepDeg = CONE_FAN_STEP_DEG) {
    const start = directionDeg - (arcDeg / 2);
    const points = [origin.x, origin.y];
    const steps = Math.max(1, Math.ceil(arcDeg / Math.max(1, stepDeg)));
    for (let i = 0; i <= steps; i++) {
        const angle = (start + (arcDeg * i / steps)) * (Math.PI / 180);
        points.push(
            origin.x + (Math.cos(angle) * radiusPx),
            origin.y + (Math.sin(angle) * radiusPx)
        );
    }
    return points;
}

/**
 * Deterministic danger → heat-shade mapping for the threat overlay
 * (issue #36): 0 renders a faint cool cell, 1 a saturated hot one.
 * @param {number} danger Normalized danger 0..1.
 * @returns {{color: number, alpha: number}}
 */
export function dangerShade(danger) {
    const d = Math.max(0, Math.min(1, _finiteOr(danger, 0)));
    const green = Math.round(200 * (1 - d));
    const color = (0xff << 16) | (green << 8);
    const alpha = Math.round((0.05 + (0.4 * d)) * 1e4) / 1e4;
    return { color, alpha };
}

// --- Plan overlay view-model ------------------------------------------------

/**
 * Convert a serialized planner plan into the draw-list the overlay
 * renders (issue #29). Everything is plain data in canvas pixels —
 * no Document references, JSON-serializable.
 * @param {object} plan Serialized plan (`steps`, `snapshot`).
 * @param {object} [context]
 * @param {object|null} [context.self] Self token bounds `{x, y, w, h}`
 *   (top-left doc coords + pixel size); waypoint/doc positions are
 *   offset by half these bounds so the route draws centre-to-centre.
 * @param {object|null} [context.selfPos] Raw self position fallback
 *   `{x, y}` used when `self` bounds are unknown.
 * @param {object|null} [context.target] Target token bounds `{x, y, w, h}`.
 * @param {number} [context.pxPerUnit] Pixels per scene unit (ranges).
 * @param {string|null} [context.operationId] Operation owning the plan.
 * @param {string|boolean|null} [context.stale] Stale marker — the
 *   renderer dims the overlay while a stale banner is up.
 * @param {number|null} [context.stepIndex] 1-based plan cursor for the
 *   issue #26 intent badge (defaults to the chosen step / step 1).
 * @returns {object} `{operationId, planId, stale, self, route, cones,
 *   blasts, target, intent}`.
 */
export function buildPlanOverlayModel(plan, context = {}) {
    const steps = Array.isArray(plan?.steps) ? plan.steps : [];
    const self = _bounds(context.self);
    const half = self ? { x: self.w / 2, y: self.h / 2 } : { x: 0, y: 0 };
    const selfCenter = _center(self) ?? _point(context.selfPos);
    const pxPerUnit = _finiteOr(context.pxPerUnit, 0);

    // Movement route: serialized waypoints plus the move destination,
    // drawn centre-to-centre from the self bounds.
    const moveStep = steps.find(step => step?.type === "move");
    let route = null;
    if (moveStep) {
        const input = moveStep.input ?? {};
        const points = (Array.isArray(input.waypoints) ? input.waypoints : [])
            .map(_point)
            .filter(Boolean)
            .map(point => ({ x: point.x + half.x, y: point.y + half.y }));
        const to = _point(input.to ?? input.destination);
        if (to) {
            const last = points[points.length - 1];
            const centered = { x: to.x + half.x, y: to.y + half.y };
            if (!last || last.x !== centered.x || last.y !== centered.y) {
                points.push(centered);
            }
        }
        if (selfCenter && points.length) {
            const first = points[0];
            if (first.x !== selfCenter.x || first.y !== selfCenter.y) {
                points.unshift({ x: selfCenter.x, y: selfCenter.y });
            }
        }
        route = {
            points,
            approximate: input.approximate === true
        };
    }

    // Directed templates (spray / suppressing fire) originate where the
    // attack happens — the move destination or the self position.
    const attackDocPos = moveStep ? _point(moveStep.input?.to ?? moveStep.input?.destination) : null;
    const attackOrigin = attackDocPos
        ? { x: attackDocPos.x + half.x, y: attackDocPos.y + half.y }
        : selfCenter;

    const cones = [];
    const blasts = [];
    for (const step of steps) {
        const input = step?.input ?? {};
        if (input.template && Number.isFinite(input.template.direction) && attackOrigin) {
            const rangeUnits = _finiteOr(input.template.range ?? input.range, null);
            cones.push({
                kind: input.attackType === "suppressing_fire" ? "suppression" : "spray",
                origin: { x: attackOrigin.x, y: attackOrigin.y },
                direction: ((input.template.direction % 360) + 360) % 360,
                arc: _finiteOr(input.template.angle,
                    input.attackType === "suppressing_fire" ? 45 : 30),
                rangeUnits,
                radiusPx: rangeUnits !== null && pxPerUnit > 0
                    ? rangeUnits * pxPerUnit
                    : null,
                covered: Array.isArray(input.covered) ? [...input.covered] : []
            });
        }
        const targetPoint = _point(input.targetPoint);
        if (targetPoint) {
            const radiusUnits = _finiteOr(input.blastRadius, null);
            blasts.push({
                // Issue #54: a blast overwatch step shares the circle
                // renderer but keeps its own zone identity.
                kind: step?.type === "overwatch" ? "overwatch" : "blast",
                point: { x: targetPoint.x + half.x, y: targetPoint.y + half.y },
                radiusUnits,
                radiusPx: radiusUnits !== null && pxPerUnit > 0
                    ? radiusUnits * pxPerUnit
                    : null
            });
        }
        if (step?.type === "overwatch" && Number.isFinite(input.direction) && selfCenter) {
            const rangeUnits = _finiteOr(input.range, null);
            cones.push({
                kind: "overwatch",
                origin: { x: selfCenter.x, y: selfCenter.y },
                direction: ((input.direction % 360) + 360) % 360,
                arc: _finiteOr(input.arc, 45),
                rangeUnits,
                radiusPx: rangeUnits !== null && pxPerUnit > 0
                    ? rangeUnits * pxPerUnit
                    : null,
                covered: []
            });
        }
    }

    // Target highlight: resolved bounds win, the snapshot position plus
    // the self footprint is the fallback square.
    const targetId = plan?.snapshot?.target?.tokenId
        ?? steps.find(step => step?.input?.targetTokenId)?.input?.targetTokenId
        ?? null;
    const targetUuid = plan?.snapshot?.target?.tokenUuid
        ?? steps.find(step => step?.input?.targetTokenUuid)?.input?.targetTokenUuid
        ?? null;
    let target = null;
    const targetBounds = _bounds(context.target);
    if (targetBounds) {
        target = { tokenId: targetId, tokenUuid: targetUuid, bounds: targetBounds };
    } else {
        const pos = _point(plan?.snapshot?.target);
        const w = self?.w ?? (pxPerUnit > 0 ? pxPerUnit : 0);
        const h = self?.h ?? (pxPerUnit > 0 ? pxPerUnit : 0);
        if (pos && w > 0 && h > 0) {
            target = { tokenId: targetId, tokenUuid: targetUuid,
                bounds: { x: pos.x, y: pos.y, w, h } };
        }
    }

    // Attack ray: the GM must see *who* the shot goes at — a beam from
    // the attack origin (move destination or self) to the target centre.
    const targetCenter = target ? _center(target.bounds) : null;
    const attackRay = attackOrigin && targetCenter
        ? { from: { x: attackOrigin.x, y: attackOrigin.y },
            to: { x: targetCenter.x, y: targetCenter.y } }
        : null;

    // Issue #26 intent marker: a small "current/total" badge above the
    // previewed token telegraphing where inside the multi-step plan the
    // bot stands. `context.stepIndex` carries an explicit progress (the
    // executor's cursor); without it the marker shows step 1 — the plan
    // the GM is looking at is about to start.
    const intentTotal = steps.filter(step => step?.type !== "end-turn").length
        || steps.length;
    let intent = null;
    if (selfCenter && intentTotal > 0) {
        const explicit = _finiteOr(context.stepIndex, null);
        const chosenIdx = steps.findIndex(
            step => step?.id === plan?.diagnostics?.chosenStep);
        const stepIndex = Number.isFinite(explicit) && explicit > 0
            ? Math.min(Math.trunc(explicit), intentTotal)
            : (chosenIdx >= 0 ? Math.min(chosenIdx + 1, intentTotal) : 1);
        intent = {
            x: selfCenter.x,
            y: (self?.y ?? selfCenter.y) - 14,
            stepIndex,
            total: intentTotal,
            moraleTier: typeof plan?.diagnostics?.morale?.effectiveTier === "string"
                ? plan.diagnostics.morale.effectiveTier
                : (typeof plan?.diagnostics?.morale?.tier === "string"
                    ? plan.diagnostics.morale.tier : null)
        };
    }

    return {
        operationId: context.operationId ?? plan?.operationId ?? null,
        planId: plan?.id ?? null,
        sceneId: context.sceneId ?? null,
        stale: context.stale !== null && context.stale !== undefined
            && context.stale !== false,
        self,
        route,
        cones,
        blasts,
        target,
        intent,
        attackRay
    };
}

// --- Danger heat cells (issue #36) ------------------------------------------

/**
 * Deterministic heat-cell grid for a threat map. Iterates the scene in
 * grid-stride order (row-major) and keeps only cells with danger > 0;
 * `labels` marks the hottest cells with their top `explain` contributor.
 * @param {object} map Threat map exposing `dangerAt`/`explain`.
 * @param {object} [options]
 * @param {number} [options.width] Scene width in pixels.
 * @param {number} [options.height] Scene height in pixels.
 * @param {number} [options.cellSize] Grid cell size in pixels.
 * @param {number} [options.maxCells] Scan budget — bigger scenes sample
 *   with a coarser stride.
 * @param {number} [options.labelCount] Top-contributor labels to emit.
 * @returns {{cells: object[], labels: object[]}}
 */
export function dangerCells(map, {
    width = 0,
    height = 0,
    cellSize = 100,
    maxCells = DANGER_MAX_CELLS,
    labelCount = DANGER_LABEL_COUNT
} = {}) {
    const cells = [];
    const labels = [];
    if (!map || typeof map.dangerAt !== "function"
        || !(width > 0) || !(height > 0) || !(cellSize > 0)) {
        return { cells, labels };
    }
    const cols = Math.max(1, Math.floor(width / cellSize));
    const rows = Math.max(1, Math.floor(height / cellSize));
    let stride = 1;
    while ((cols * rows) / (stride * stride) > maxCells) stride += 1;
    const span = cellSize * stride;
    for (let j = 0; j < rows; j += stride) {
        for (let i = 0; i < cols; i += stride) {
            const center = { x: (i * cellSize) + (span / 2), y: (j * cellSize) + (span / 2) };
            let danger = 0;
            try {
                danger = Math.max(0, Math.min(1, _finiteOr(map.dangerAt(center), 0)));
            } catch(err) {
                danger = 0;
            }
            if (danger <= 0) continue;
            cells.push({ x: i * cellSize, y: j * cellSize, w: span, h: span, danger });
        }
    }
    const explain = typeof map.explain === "function" ? map.explain : null;
    const ranked = [...cells].sort((a, b) => (b.danger - a.danger)
        || (a.y - b.y) || (a.x - b.x));
    for (const cell of ranked.slice(0, Math.max(0, labelCount))) {
        const center = { x: cell.x + (cell.w / 2), y: cell.y + (cell.h / 2) };
        let top = null;
        if (explain) {
            try {
                top = (explain(center) ?? [])
                    .slice()
                    .sort((a, b) => (b.contribution - a.contribution)
                        || String(a.id).localeCompare(String(b.id)))[0] ?? null;
            } catch(err) {
                top = null;
            }
        }
        labels.push({ x: center.x, y: center.y, danger: cell.danger, top });
    }
    return { cells, labels };
}

// --- Service ----------------------------------------------------------------

/**
 * Create the `planOverlay` service published as
 * `api.services.get("planOverlay")` (issues #29/#36). Holds the current
 * preview-plan draw state and the danger-overlay toggle; rendering is
 * strictly local and GM-gated — nothing is written to documents or
 * broadcast to other clients.
 * @param {object} [deps]
 * @param {object} [deps.api] Module API for lazy service lookups.
 * @param {object} [deps.hooks] Hooks registry (Foundry `Hooks`).
 * @param {Function} [deps.getDangerEnabled] Initial danger-toggle read.
 * @param {Function} [deps.log] Diagnostic logger.
 * @returns {object} Plan-overlay service.
 */
export function createPlanOverlayService({
    api = null,
    hooks = null,
    getDangerEnabled = isThreatMapOverlayEnabled,
    log = (...args) => logDiagnostics(...args)
} = {}) {
    const H = hooks ?? globalThis.Hooks ?? null;
    let _started = false;
    let _planModel = null;
    let _dangerEnabled = false;
    let _dangerMode = "plan";
    const _registered = [];

    /**
     * Lazy service lookup (safe when the service is absent).
     * @param {string} name
     * @returns {object|null}
     */
    function _service(name) {
        try {
            return api?.services?.get?.(name) ?? null;
        } catch(err) {
            return null;
        }
    }

    /**
     * Whether this client may draw the plan preview overlay: the same
     * controller gate the preview dialog uses (issue #29 — players and
     * non-controller clients see nothing).
     * @returns {boolean}
     */
    function _isController() {
        const authority = _service("authority");
        if (authority && typeof authority.isController === "function") {
            try {
                return authority.isController() === true;
            } catch(err) {
                return false;
            }
        }
        return globalThis.game?.user?.isGM === true;
    }

    /**
     * Whether this client may draw at all: any overlay pixel only ever
     * exists on GM clients.
     * @returns {boolean}
     */
    function _canRender() {
        return globalThis.game?.user?.isGM === true;
    }

    /**
     * Grid info `{size, distance}` of the viewed scene.
     * @returns {object}
     */
    function _grid() {
        return globalThis.canvas?.scene?.grid
            ?? globalThis.canvas?.grid
            ?? {};
    }

    /**
     * Pixels per scene unit of the viewed grid.
     * @returns {number}
     */
    function _pxPerUnit() {
        const grid = _grid();
        const size = Number(grid.size) || 0;
        const distance = Number(grid.distance) || 1;
        return size > 0 ? size / distance : 0;
    }

    /**
     * Pixel bounds `{x, y, w, h}` of a token document.
     * @param {object|null} doc Token document.
     * @returns {object|null}
     */
    function _tokenBounds(doc) {
        const token = _tokenDoc(doc);
        if (!token) return null;
        const size = Number(_grid().size) || 100;
        const x = Number(token._source?.x ?? token.x);
        const y = Number(token._source?.y ?? token.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return {
            x,
            y,
            w: _finiteOr(token.width, 1) * size,
            h: _finiteOr(token.height, 1) * size
        };
    }

    /**
     * Token document lookup by id/uuid tail inside the combat and scene.
     * @param {string|null} tokenId
     * @param {string|null} tokenUuid
     * @param {object|null} combat
     * @returns {object|null}
     */
    function _findTokenDoc(tokenId, tokenUuid, combat) {
        const wanted = tokenId ?? (typeof tokenUuid === "string"
            ? tokenUuid.split(".").pop() : null);
        if (!wanted) return null;
        for (const combatant of _list(combat?.combatants)) {
            const doc = _tokenDoc(combatant?.token);
            if (doc?.id === wanted || combatant?.tokenId === wanted) return doc;
        }
        const collection = globalThis.canvas?.tokens?.placeables
            ?? globalThis.canvas?.scene?.tokens;
        for (const token of _list(collection)) {
            const doc = _tokenDoc(token);
            if (doc?.id === wanted) return doc;
        }
        return null;
    }

    // --- Plan layer --------------------------------------------------------

    /**
     * Draw one cone sector into the plan layer.
     * @param {PIXI.Container} layer
     * @param {object} cone `{origin, direction, arc, radiusPx, kind}`.
     * @param {number} dim Alpha multiplier for stale plans.
     */
    function _drawCone(layer, cone, dim) {
        if (!cone?.radiusPx || cone.radiusPx <= 0) return;
        const color = cone.kind === "suppression" ? SUPPRESSION_COLOR
            : (cone.kind === "overwatch" ? OVERWATCH_COLOR : CONE_COLOR);
        const graphics = new PIXI.Graphics();
        graphics.beginFill(color, CONE_FILL_ALPHA * dim);
        graphics.lineStyle(2, color, CONE_EDGE_ALPHA * dim, 0.5);
        graphics.drawPolygon(coneFanPoints(
            cone.origin, cone.direction, cone.arc, cone.radiusPx));
        graphics.endFill();
        layer.addChild(graphics);
    }

    /**
     * Draw the route polyline plus a destination arrowhead.
     * @param {PIXI.Container} layer
     * @param {object} route `{points, approximate}`.
     * @param {number} dim Alpha multiplier for stale plans.
     */
    function _drawRoute(layer, route, dim) {
        const points = route?.points ?? [];
        if (points.length < 2) return;
        const alpha = ROUTE_ALPHA * dim * (route.approximate ? 0.6 : 1);
        const graphics = new PIXI.Graphics();
        graphics.lineStyle(4, ROUTE_COLOR, alpha, 0.5);
        graphics.moveTo(points[0].x, points[0].y);
        for (const point of points.slice(1)) {
            graphics.lineTo(point.x, point.y);
        }
        // Arrowhead on the final segment pointing at the destination.
        const prev = points[points.length - 2];
        const last = points[points.length - 1];
        const angle = Math.atan2(last.y - prev.y, last.x - prev.x);
        const tip = { x: last.x, y: last.y };
        const left = angle + (Math.PI * 0.82);
        const right = angle - (Math.PI * 0.82);
        graphics.beginFill(ROUTE_COLOR, alpha);
        graphics.lineStyle(0, ROUTE_COLOR, 0);
        graphics.drawPolygon([
            tip.x, tip.y,
            tip.x + (Math.cos(left) * ARROW_SIZE_PX),
            tip.y + (Math.sin(left) * ARROW_SIZE_PX),
            tip.x + (Math.cos(right) * ARROW_SIZE_PX),
            tip.y + (Math.sin(right) * ARROW_SIZE_PX)
        ]);
        graphics.endFill();
        layer.addChild(graphics);
    }

    /**
     * Draw a blast aim circle at a `targetPoint`.
     * @param {PIXI.Container} layer
     * @param {object} blast `{point, radiusPx}`.
     * @param {number} dim Alpha multiplier for stale plans.
     */
    function _drawBlast(layer, blast, dim) {
        if (!blast?.point || !(blast.radiusPx > 0)) return;
        const color = blast.kind === "overwatch" ? OVERWATCH_COLOR : BLAST_COLOR;
        const graphics = new PIXI.Graphics();
        graphics.beginFill(color, BLAST_FILL_ALPHA * dim);
        graphics.lineStyle(2, color, BLAST_EDGE_ALPHA * dim, 0.5);
        graphics.drawCircle(blast.point.x, blast.point.y, blast.radiusPx);
        graphics.endFill();
        layer.addChild(graphics);
    }

    /**
     * Draw the attack ray — a beam from the attack origin to the target
     * centre so the GM sees at a glance who the shot goes at.
     * @param {PIXI.Container} layer
     * @param {object} ray `{from, to}`.
     * @param {number} dim Alpha multiplier for stale plans.
     */
    function _drawRay(layer, ray, dim) {
        if (!ray?.from || !ray?.to) return;
        const graphics = new PIXI.Graphics();
        // Wide glow underlay so the red beam stays visible over the cyan
        // route and the green target ring.
        graphics.lineStyle(9, RAY_COLOR, (RAY_ALPHA * dim) * 0.3, 0.5);
        graphics.moveTo(ray.from.x, ray.from.y);
        graphics.lineTo(ray.to.x, ray.to.y);
        graphics.lineStyle(4, RAY_COLOR, RAY_ALPHA * dim, 0.5);
        graphics.moveTo(ray.from.x, ray.from.y);
        graphics.lineTo(ray.to.x, ray.to.y);
        const s = 10;
        graphics.beginFill(RAY_COLOR, RAY_ALPHA * dim);
        graphics.lineStyle(0, RAY_COLOR, 0);
        graphics.drawPolygon([
            ray.to.x, ray.to.y - s,
            ray.to.x + s, ray.to.y,
            ray.to.x, ray.to.y + s,
            ray.to.x - s, ray.to.y
        ]);
        graphics.endFill();
        layer.addChild(graphics);
    }

    /**
     * Draw the target highlight ring around the target bounds.
     * @param {PIXI.Container} layer
     * @param {object} target `{bounds: {x, y, w, h}}`.
     * @param {number} dim Alpha multiplier for stale plans.
     */
    function _drawTarget(layer, target, dim) {
        const bounds = target?.bounds;
        if (!bounds) return;
        const pad = 6;
        const graphics = new PIXI.Graphics();
        graphics.lineStyle(3, TARGET_COLOR, TARGET_ALPHA * dim, 0.5);
        graphics.drawRoundedRect(
            bounds.x - pad, bounds.y - pad,
            bounds.w + (pad * 2), bounds.h + (pad * 2), 6
        );
        layer.addChild(graphics);
    }

    /**
     * Draw the intent badge (issue #26): a small "i/total" label above
     * the previewed token — the morale tier tints it (confident green,
     * pressured amber, desperate red). PIXI.Text is optional
     * decoration; the model keeps the data either way.
     * @param {PIXI.Container} layer
     * @param {object} intent `{x, y, stepIndex, total, moraleTier}`.
     * @param {number} dim Alpha multiplier for stale plans.
     */
    function _drawIntent(layer, intent, dim) {
        if (!intent || typeof PIXI?.Text !== "function") return;
        const color = intent.moraleTier === "confident" ? 0x66ff66
            : (intent.moraleTier === "desperate" ? 0xff5533 : 0xffaa33);
        try {
            const text = new PIXI.Text(`${intent.stepIndex}/${intent.total}`, {
                fontSize: 14,
                fill: color,
                stroke: 0x000000,
                strokeThickness: 3,
                fontWeight: "bold"
            });
            text.anchor?.set?.(0.5, 1);
            text.position?.set?.(intent.x, intent.y);
            if (Number.isFinite(text.alpha)) text.alpha = dim;
            layer.addChild(text);
        } catch(err) {
            // The badge is decorative — never block the overlay on it.
        }
    }

    /**
     * Rebuild the plan layer from the current model. No-op for non-GM
     * clients and without PIXI/canvas.
     * @returns {void}
     */
    function _renderPlan() {
        clearOverlayLayer(OVERLAY_LAYERS.plan);
        if (!_planModel || !_canRender()) return;
        const layer = ensureOverlayLayer(OVERLAY_LAYERS.plan);
        if (!layer) return;
        const dim = _planModel.stale ? 0.4 : 1;
        for (const cone of _planModel.cones) _drawCone(layer, cone, dim);
        for (const blast of _planModel.blasts) _drawBlast(layer, blast, dim);
        _drawRoute(layer, _planModel.route, dim);
        _drawRay(layer, _planModel.attackRay, dim);
        _drawTarget(layer, _planModel.target, dim);
        _drawIntent(layer, _planModel.intent, dim);
    }

    /**
     * Show the plan overlay for a preview session (issue #29). Replaces
     * the current model (a replan draws the new picture). Controller-only
     * and GM-rendered; the model is kept even when PIXI is absent so the
     * call still reports what would be drawn.
     * @param {object} plan Serialized planner plan.
     * @param {object} [context]
     * @param {object|null} [context.combat] Active combat.
     * @param {object|null} [context.combatant] Previewed combatant.
     * @param {string|null} [context.operationId] Owning operation.
     * @param {string|boolean|null} [context.stale] Stale marker.
     * @returns {{ok: boolean, reason?: string, model?: object}}
     */
    function showPlan(plan, context = {}) {
        if (!_isController()) return { ok: false, reason: OVERLAY_REASONS.notController };
        if (!plan) return { ok: false, reason: OVERLAY_REASONS.noPlan };
        const combat = context.combat ?? globalThis.game?.combat ?? null;
        const targetId = plan?.snapshot?.target?.tokenId
            ?? (plan?.steps ?? []).find(step => step?.input?.targetTokenId)
                ?.input?.targetTokenId
            ?? null;
        const targetUuid = plan?.snapshot?.target?.tokenUuid
            ?? (plan?.steps ?? []).find(step => step?.input?.targetTokenUuid)
                ?.input?.targetTokenUuid
            ?? null;
        const targetDoc = _findTokenDoc(targetId, targetUuid, combat);
        _planModel = buildPlanOverlayModel(plan, {
            self: _tokenBounds(context.combatant?.token),
            selfPos: context.selfPos ?? null,
            target: _tokenBounds(targetDoc),
            pxPerUnit: _pxPerUnit(),
            operationId: context.operationId ?? null,
            stale: context.stale ?? null,
            stepIndex: context.stepIndex ?? null,
            sceneId: globalThis.canvas?.scene?.id ?? null
        });
        _renderPlan();
        log(`plan overlay: plan=${_planModel.planId} cones=${_planModel.cones.length} `
            + `blasts=${_planModel.blasts.length} route=${_planModel.route?.points?.length ?? 0}`);
        return { ok: true, model: _planModel };
    }

    /**
     * Clear the plan overlay (any preview decision, operation change or
     * combat end). `operationId` mismatches are tolerated — the overlay
     * always clears.
     * @param {string|null} [operationId]
     * @returns {{ok: boolean}}
     */
    function clearPlan(operationId = null) {
        _planModel = null;
        clearOverlayLayer(OVERLAY_LAYERS.plan);
        return { ok: true, operationId: operationId ?? null };
    }

    // --- Danger layer ------------------------------------------------------

    /**
     * Threat targets for the aggregated "all" mode: every living,
     * non-hidden combatant hostile to the active combatant — or all
     * living combatants when nobody holds the turn.
     * @param {object|null} combat
     * @returns {object[]}
     */
    function _teamTargets(combat) {
        const viewer = combat?.combatant ?? null;
        const viewerDoc = _tokenDoc(viewer?.token);
        const viewerDisp = Math.sign(_finiteOr(
            viewerDoc?.disposition ?? viewer?.disposition, 0));
        const targets = [];
        for (const combatant of _list(combat?.combatants)) {
            if (!combatant || combatant === viewer) continue;
            const doc = _tokenDoc(combatant?.token);
            if (!doc || doc.destroyed === true || doc.hidden === true) continue;
            if (combatant?.defeated === true) continue;
            const disp = Math.sign(_finiteOr(doc.disposition ?? combatant?.disposition, 0));
            if (viewer && viewerDisp !== 0 && disp !== -viewerDisp) continue;
            const x = Number(doc._source?.x ?? doc.x);
            const y = Number(doc._source?.y ?? doc.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            targets.push({
                tokenId: doc.id ?? combatant?.tokenId ?? null,
                tokenUuid: doc.uuid ?? null,
                x,
                y
            });
        }
        return targets;
    }

    /**
     * Resolve the map the danger overlay renders: `plan` mode reuses the
     * map the planner refreshed for the current bot; `all` mode rebuilds
     * an aggregate over every hostile of the active combatant.
     * @returns {object|null}
     */
    function _dangerMap() {
        const svc = _service("threatMap");
        if (!svc) return null;
        const combat = globalThis.game?.combat ?? null;
        const scene = globalThis.canvas?.scene ?? null;
        if (_dangerMode === "all") {
            try {
                return svc.buildMap({
                    targets: _teamTargets(combat),
                    combat,
                    scene,
                    grid: _grid()
                });
            } catch(err) {
                return null;
            }
        }
        try {
            const current = typeof svc.map === "function" ? svc.map() : null;
            if (current && typeof current.dangerAt === "function") return current;
            return svc.buildMap({
                targets: _teamTargets(combat),
                combat,
                scene,
                grid: _grid()
            });
        } catch(err) {
            return null;
        }
    }

    /**
     * Rebuild the danger layer from the current toggle/mode. No-op for
     * non-GM clients, when disabled or without a resolvable map.
     * @returns {void}
     */
    function _renderDanger() {
        clearOverlayLayer(OVERLAY_LAYERS.danger);
        if (!_dangerEnabled || !_canRender()) return;
        const map = _dangerMap();
        if (!map || typeof PIXI === "undefined") return;
        const scene = globalThis.canvas?.scene ?? null;
        const dims = globalThis.canvas?.dimensions ?? {};
        const grid = _grid();
        const size = Number(grid.size) || 100;
        const width = Number(scene?.width ?? dims.sceneWidth ?? dims.width) || 0;
        const height = Number(scene?.height ?? dims.sceneHeight ?? dims.height) || 0;
        const { cells, labels } = dangerCells(map, {
            width,
            height,
            cellSize: size
        });
        if (!cells.length) return;
        const layer = ensureOverlayLayer(OVERLAY_LAYERS.danger);
        if (!layer) return;
        for (const cell of cells) {
            const shade = dangerShade(cell.danger);
            const graphics = new PIXI.Graphics();
            graphics.beginFill(shade.color, shade.alpha);
            graphics.drawRect(cell.x, cell.y, cell.w, cell.h);
            graphics.endFill();
            layer.addChild(graphics);
        }
        if (typeof PIXI.Text === "function") {
            for (const label of labels) {
                const top = label.top;
                const text = top
                    ? `${top.id}:${top.contribution}`
                    : `${Math.round(label.danger * 100)}%`;
                try {
                    const node = new PIXI.Text(text, {
                        fontSize: 12,
                        fill: 0xffffff,
                        stroke: 0x000000,
                        strokeThickness: 2
                    });
                    node.anchor?.set?.(0.5);
                    node.position?.set?.(label.x, label.y);
                    layer.addChild(node);
                } catch(err) {
                    // Labels are optional decoration.
                }
            }
        }
    }

    /**
     * Enable/disable the danger overlay (issue #36). GM clients may also
     * persist the toggle into the `threatMapOverlay` world setting;
     * non-GM clients only flip the local session flag (which still never
     * renders for them).
     * @param {boolean} enabled
     * @param {object} [options]
     * @param {boolean} [options.persist] Persist to the world setting.
     * @returns {{ok: boolean, enabled: boolean}}
     */
    function setDangerEnabled(enabled, { persist = true } = {}) {
        _dangerEnabled = enabled === true;
        if (persist && globalThis.game?.user?.isGM === true) {
            try {
                globalThis.game?.settings?.set?.(
                    MODULE_ID, SETTING_KEYS.threatMapOverlay, _dangerEnabled);
            } catch(err) {
                // Persisting the toggle is best effort.
            }
        }
        _renderDanger();
        return { ok: true, enabled: _dangerEnabled };
    }

    /**
     * Flip the danger overlay; optionally switch the mode first.
     * @param {string} [mode] `"plan"|"all"`.
     * @returns {{ok: boolean, enabled: boolean, mode: string}}
     */
    function toggleDanger(mode = null) {
        if (mode === "plan" || mode === "all") _dangerMode = mode;
        const result = setDangerEnabled(!_dangerEnabled);
        return { ...result, mode: _dangerMode };
    }

    /**
     * Pick the danger-overlay mode and re-render.
     * @param {string} mode `"plan"|"all"`.
     * @returns {{ok: boolean, mode: string}}
     */
    function setDangerMode(mode) {
        _dangerMode = mode === "all" ? "all" : "plan";
        _renderDanger();
        return { ok: true, mode: _dangerMode };
    }

    /**
     * Re-render the danger layer (replan, combatant change, canvasReady).
     * @returns {{ok: boolean}}
     */
    function refreshDanger() {
        _renderDanger();
        return { ok: true };
    }

    /**
     * Clear every overlay layer and the transient plan state.
     * @returns {{ok: boolean}}
     */
    function clearAll() {
        _planModel = null;
        for (const name of Object.values(OVERLAY_LAYERS)) {
            clearOverlayLayer(name);
        }
        return { ok: true };
    }

    /**
     * Introspection snapshot for e2e/debug assertions.
     * @returns {object}
     */
    function describe() {
        const layer = overlayLayer(OVERLAY_LAYERS.plan);
        const dangerLayer = overlayLayer(OVERLAY_LAYERS.danger);
        return {
            gm: _canRender(),
            controller: _isController(),
            plan: {
                active: _planModel !== null,
                operationId: _planModel?.operationId ?? null,
                planId: _planModel?.planId ?? null,
                stale: _planModel?.stale === true,
                cones: _planModel?.cones?.length ?? 0,
                blasts: _planModel?.blasts?.length ?? 0,
                routePoints: _planModel?.route?.points?.length ?? 0,
                drawn: layer ? (layer.children?.length ?? 0) : 0
            },
            danger: {
                enabled: _dangerEnabled,
                mode: _dangerMode,
                drawn: dangerLayer ? (dangerLayer.children?.length ?? 0) : 0
            }
        };
    }

    /**
     * Combat/canvas watchers: the plan overlay dies with the operation
     * (turn advance or combat end), the danger layer refreshes on the
     * same events and on `canvasReady`.
     * @returns {void}
     */
    function _subscribe() {
        if (!H || _registered.length) return;
        const on = (name, fn) => {
            if (typeof H.on === "function") {
                _registered.push([name, H.on(name, fn)]);
            }
        };
        on("canvasReady", () => {
            // The PIXI tree died with the canvas — recreate it and
            // redraw the plan when the preview still lives on the same
            // scene (a scene switch drops it instead).
            const sceneId = globalThis.canvas?.scene?.id ?? null;
            if (_planModel && _planModel.sceneId !== sceneId) _planModel = null;
            _renderPlan();
            _renderDanger();
        });
        on("canvasTearDown", () => {
            _planModel = null;
            resetOverlayRoot();
        });
        on("updateCombat", (_combat, changed) => {
            // The plan overlay dies only with the turn — unrelated
            // Combat updates (operation flag writes during an open
            // preview, marker changes) must not wipe the picture.
            const changedKeys = changed && typeof changed === "object" ? changed : {};
            if (changedKeys.round != null || changedKeys.turn != null) {
                clearPlan();
            }
            _renderDanger();
        });
        on("deleteCombat", () => {
            clearPlan();
            _renderDanger();
        });
    }

    /**
     * Remove every previously registered watcher hook.
     * @returns {void}
     */
    function _unsubscribe() {
        while (_registered.length) {
            const [name, id] = _registered.pop();
            try {
                if (typeof H?.off === "function") H.off(name, id);
            } catch(err) {
                // Hook teardown is best effort.
            }
        }
    }

    return {
        /** Register watcher hooks and sync the danger toggle (called on `ready`). */
        start() {
            if (_started) return;
            _started = true;
            try {
                _dangerEnabled = getDangerEnabled?.() === true;
            } catch(err) {
                _dangerEnabled = false;
            }
            _subscribe();
            _renderDanger();
        },
        /** Remove watcher hooks and every drawn overlay. */
        stop() {
            _started = false;
            _unsubscribe();
            clearAll();
            resetOverlayRoot();
        },
        get started() { return _started; },
        get dangerEnabled() { return _dangerEnabled; },
        get dangerMode() { return _dangerMode; },
        /**
         * The last shown plan model (debug/test helper).
         * @returns {object|null}
         */
        model() { return _planModel; },
        showPlan,
        clearPlan,
        clearAll,
        setDangerEnabled,
        toggleDanger,
        setDangerMode,
        refreshDanger,
        describe,
        reasons: OVERLAY_REASONS
    };
}
