/**
 * Overwatch declarations (issue #14, declare-only).
 *
 * A bot declares an overwatch cone via an `overwatch` plan step; the
 * declaration is stored on the combatant flag `flags["only-war-ai"].overwatch`
 * and rendered as a GM-only cone overlay on the templates layer. The
 * module deliberately does NOT auto-fire the reaction — the GM adjudicates
 * the shot; the service only draws the sector and clears it when the
 * overwatch lapses: the bot's own next turn, any movement of its token,
 * combatant removal or combat end.
 */
import { FLAG_KEYS, MODULE_ID } from "./constants.js";
import {
    coneFanPoints,
    ensureOverlayLayer,
    removeOverlayLayer
} from "./ui/plan-overlay.js";

/** Default cone arc when the declaring step does not carry one. */
const DEFAULT_ARC_DEG = 45;

/** Cone overlay tint and opacity. */
const CONE_COLOR = 0xff8800;
const CONE_FILL_ALPHA = 0.18;
const CONE_EDGE_ALPHA = 0.75;

/** Stable machine-readable reasons returned by overwatch operations. */
export const OVERWATCH_REASONS = Object.freeze({
    notController: "not-controller",
    noCombatant: "no-combatant",
    invalidSpec: "invalid-spec",
    flagWriteFailed: "flag-write-failed"
});

/**
 * Iterate a Foundry Collection/array/iterable uniformly.
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
 * Unwrap a token-like object to its document.
 * @param {*} token
 * @returns {object|null}
 */
function _tokenDoc(token) {
    if (!token) return null;
    return token.document ?? token;
}

/**
 * Create the `overwatch` service published as `api.services.get("overwatch")`.
 * Flag writes go through the authority controller check; rendering is
 * local-only and strictly GM-gated.
 * @param {object} [deps]
 * @param {object} [deps.api] Module API for lazy service lookups.
 * @param {object} [deps.hooks] Hooks registry (Foundry `Hooks` in tests).
 * @returns {object} Overwatch service.
 */
export function createOverwatchService({ api = null, hooks = null } = {}) {
    const H = hooks ?? globalThis.Hooks ?? null;
    let _started = false;
    let _container = null;
    const _registered = [];

    /**
     * Lazy authority service lookup (safe when the service is absent).
     * @returns {object|null}
     */
    function _authority() {
        try {
            return api?.services?.get?.("authority") ?? null;
        } catch(err) {
            return null;
        }
    }

    /**
     * Whether this client is allowed to write the overwatch flag.
     * @returns {boolean}
     */
    function _isController() {
        const authority = _authority();
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
     * Sanitized flag payload of a declaration: no Document references, no
     * arbitrary caller data beyond the zone spec. Two zone shapes exist
     * (issue #54): the default watch `cone` (`direction`/`arc`/`range`)
     * and the `blast` trigger circle (`targetPoint` in canvas pixels +
     * `blastRadius` in scene units — "enemy entered the circle → the
     * grenade lands there").
     * @param {object} spec Step input `{direction|shape, arc, range,
     *   targetPoint?, blastRadius?, weaponId, ...}`.
     * @param {object|null} combat Active combat.
     * @param {object|null} combatant Declaring combatant.
     * @returns {object|null}
     */
    function _sanitize(spec, combat, combatant) {
        const tokenDoc = _tokenDoc(combatant?.token);
        const base = {
            combatantId: combatant?.id ?? null,
            tokenId: combatant?.tokenId ?? tokenDoc?.id ?? null,
            sceneId: tokenDoc?.parent?.id ?? tokenDoc?.scene?.id ?? null,
            weaponId: spec?.weaponId ?? spec?.itemUuid ?? null,
            weaponName: spec?.weaponName ?? spec?.name ?? null,
            attackType: spec?.attackType ?? null,
            round: combat?.round ?? null
        };
        if (spec?.shape === "blast" || spec?.zone?.shape === "blast") {
            const point = spec?.zone?.targetPoint ?? spec?.targetPoint;
            const radius = Number(spec?.zone?.blastRadius ?? spec?.blastRadius);
            if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)
                || !Number.isFinite(radius) || radius <= 0) return null;
            const range = Number(spec?.zone?.range ?? spec?.range);
            return {
                ...base,
                shape: "blast",
                targetPoint: { x: point.x, y: point.y },
                blastRadius: radius,
                range: Number.isFinite(range) && range > 0 ? range : null
            };
        }
        const direction = Number(spec?.zone?.direction ?? spec?.direction);
        if (!Number.isFinite(direction)) return null;
        const range = Number(spec?.zone?.range ?? spec?.range ?? spec?.reach);
        if (!Number.isFinite(range) || range <= 0) return null;
        const arc = Number(spec?.zone?.arc ?? spec?.arc);
        return {
            ...base,
            shape: "cone",
            direction: ((direction % 360) + 360) % 360,
            arc: Number.isFinite(arc) && arc > 0 ? arc : DEFAULT_ARC_DEG,
            range
        };
    }

    /**
     * Declare an overwatch cone on a combatant. Only the authority
     * controller may write; the call is a no-op elsewhere.
     * @param {object} input `{combat, combatant, spec}`.
     * @param {object|null} input.combat Active combat.
     * @param {object|null} input.combatant Declaring combatant.
     * @param {object} input.spec Step input: cone `{direction, arc,
     *   range, ...}` or blast `{shape:"blast", targetPoint, blastRadius}`.
     * @returns {Promise<object>} `{ok, record?|reason}`
     */
    async function declare({ combat = null, combatant = null, spec = {} } = {}) {
        if (!_isController()) return { ok: false, reason: OVERWATCH_REASONS.notController };
        if (typeof combatant?.setFlag !== "function") {
            return { ok: false, reason: OVERWATCH_REASONS.noCombatant };
        }
        const record = _sanitize(spec, combat, combatant);
        if (!record) return { ok: false, reason: OVERWATCH_REASONS.invalidSpec };
        try {
            await combatant.setFlag(MODULE_ID, FLAG_KEYS.overwatch, record);
        } catch(err) {
            return {
                ok: false,
                reason: OVERWATCH_REASONS.flagWriteFailed,
                error: String(err?.message ?? err)
            };
        }
        _renderAll();
        return { ok: true, record };
    }

    /**
     * Clear a combatant's overwatch declaration (expiry, manual cancel,
     * replan). Missing flags are a silent no-op.
     * @param {object|null} combatant
     * @returns {Promise<object>} `{ok}`
     */
    async function clear(combatant) {
        if (typeof combatant?.unsetFlag !== "function") return { ok: false };
        try {
            await combatant.unsetFlag(MODULE_ID, FLAG_KEYS.overwatch);
        } catch(err) {
            return { ok: false };
        }
        _renderAll();
        return { ok: true };
    }

    /**
     * Read the active overwatch declaration of a combatant, if any.
     * @param {object|null} combatant
     * @returns {object|null}
     */
    function overwatchOf(combatant) {
        return combatant?.getFlag?.(MODULE_ID, FLAG_KEYS.overwatch) ?? null;
    }

    /**
     * Active overwatch declarations of a combat `{combatant, record}`.
     * @param {object|null} combat
     * @returns {object[]}
     */
    function activeOverwatches(combat) {
        const entries = [];
        for (const combatant of _list(combat?.combatants)) {
            const record = overwatchOf(combatant);
            if (record) entries.push({ combatant, record });
        }
        return entries;
    }

    // --- GM-only canvas rendering -----------------------------------------
    // Issue #30: declarations render into the shared GM-only overlay root
    // (`scripts/ui/plan-overlay.js`) — same layer lifecycle as the preview
    // plan and the danger heatmap, nothing written to documents.

    /**
     * Remove the overlay layer (and children) from the canvas.
     * @returns {void}
     */
    function _teardownContainer() {
        _container = null;
        removeOverlayLayer("overwatch");
    }

    /**
     * Lazily fetch the shared `overwatch` sub-layer of the overlay root.
     * @returns {PIXI.Container|null}
     */
    function _ensureContainer() {
        _container = ensureOverlayLayer("overwatch");
        return _container;
    }

    /**
     * Pixels per scene unit of the viewed grid.
     * @returns {number}
     */
    function _pxPerUnit() {
        const grid = globalThis.canvas?.scene?.grid ?? {};
        const size = Number(grid.size) || 0;
        const distance = Number(grid.distance) || 1;
        return size > 0 ? size / distance : 0;
    }

    /**
     * Centre point of a token document in canvas pixels.
     * @param {object|null} tokenDoc
     * @returns {{x: number, y: number}|null}
     */
    function _tokenCenter(tokenDoc) {
        const doc = _tokenDoc(tokenDoc);
        if (!doc) return null;
        if (doc.center && Number.isFinite(doc.center.x)) return { x: doc.center.x, y: doc.center.y };
        const size = globalThis.canvas?.scene?.grid?.size ?? 100;
        const halfW = (doc.width ?? 1) * size / 2;
        const halfH = (doc.height ?? 1) * size / 2;
        if (!Number.isFinite(doc.x) || !Number.isFinite(doc.y)) return null;
        return { x: doc.x + halfW, y: doc.y + halfH };
    }

    /**
     * Draw one watch zone into the overlay container: the cone sector of
     * a plain/spray declaration, the trigger circle of a blast one
     * (issue #54 — `targetPoint` is stored in canvas pixels,
     * `blastRadius` in scene units).
     * @param {PIXI.Container} container
     * @param {object} combatant Declaring combatant.
     * @param {object} record Sanitized overwatch record.
     * @returns {void}
     */
    function _drawZone(container, combatant, record) {
        const pxPerUnit = _pxPerUnit();
        if (pxPerUnit <= 0) return;
        if (record?.shape === "blast") {
            const point = record.targetPoint;
            const radius = Number(record.blastRadius) * pxPerUnit;
            if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)
                || !(radius > 0)) return;
            const graphics = new PIXI.Graphics();
            graphics.beginFill(CONE_COLOR, CONE_FILL_ALPHA);
            graphics.lineStyle(2, CONE_COLOR, CONE_EDGE_ALPHA, 0.5);
            graphics.drawCircle(point.x, point.y, radius);
            graphics.endFill();
            container.addChild(graphics);
            return;
        }
        const center = _tokenCenter(combatant?.token);
        if (!center) return;
        const radius = record.range * pxPerUnit;
        const arc = Number(record.arc) || DEFAULT_ARC_DEG;
        const graphics = new PIXI.Graphics();
        graphics.beginFill(CONE_COLOR, CONE_FILL_ALPHA);
        graphics.lineStyle(2, CONE_COLOR, CONE_EDGE_ALPHA, 0.5);
        graphics.drawPolygon(coneFanPoints(center, record.direction, arc, radius));
        graphics.endFill();
        container.addChild(graphics);
    }

    /** Rebuild every declaration overlay. GM clients only. */
    function _renderAll() {
        if (globalThis.game?.user?.isGM !== true) {
            _teardownContainer();
            return;
        }
        const container = _ensureContainer();
        if (!container) return;
        for (const child of container.removeChildren()) {
            child.destroy?.({ children: true });
        }
        const combat = globalThis.game?.combat ?? null;
        for (const { combatant, record } of activeOverwatches(combat)) {
            _drawZone(container, combatant, record);
        }
    }

    /**
     * Expiry pass on `updateCombat`: a combatant's overwatch ends the
     * moment its own turn starts (Only War: until your next turn).
     * @param {object} combat
     */
    function _expireOnTurnStart(combat) {
        const current = combat?.combatant ?? null;
        if (!current || !overwatchOf(current)) return;
        if (!_isController()) return;
        clear(current);
    }

    /**
     * Expiry pass on `updateToken`: moving the declared token breaks
     * overwatch (the shooter repositioned).
     * @param {object} tokenDoc
     * @param {object} change
     */
    function _expireOnTokenMove(tokenDoc, change) {
        const doc = _tokenDoc(tokenDoc);
        const moved = change && (change.x !== undefined || change.y !== undefined);
        if (!doc?.id || !moved) return;
        const combat = globalThis.game?.combat ?? null;
        for (const { combatant, record } of activeOverwatches(combat)) {
            if (record.tokenId !== doc.id && combatant?.tokenId !== doc.id) continue;
            if (_isController()) clear(combatant);
        }
    }

    /**
     * Register the watcher hooks driving expiry and re-rendering.
     * @returns {void}
     */
    function _subscribe() {
        if (!H || _registered.length) return;
        const on = (name, fn) => {
            if (typeof H.on === "function") {
                _registered.push([name, H.on(name, fn)]);
            }
        };
        on("canvasReady", _renderAll);
        on("canvasTearDown", _teardownContainer);
        on("updateCombat", _expireOnTurnStart);
        on("updateToken", _expireOnTokenMove);
        on("updateCombatant", _renderAll);
        on("deleteCombatant", _renderAll);
        on("deleteCombat", _renderAll);
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
        /** Register watcher hooks (called on `ready`). */
        start() {
            if (_started) return;
            _started = true;
            _subscribe();
            _renderAll();
        },
        /** Remove watcher hooks and any drawn overlay. */
        stop() {
            _started = false;
            _unsubscribe();
            _teardownContainer();
        },
        get started() { return _started; },
        declare,
        clear,
        overwatchOf,
        activeOverwatches,
        renderAll: _renderAll,
        reasons: OVERWATCH_REASONS
    };
}
