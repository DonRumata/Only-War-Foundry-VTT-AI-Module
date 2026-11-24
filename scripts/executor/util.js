/**
 * Executor decomposition (issue #407 follow-up): extracted verbatim from
 * scripts/executor.js — see that file for the design contract. Sub-factory
 * env objects destructure to the identifiers the moved code already used.
 */


/**
 * Sleep helper for the advance-verification window.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function _sleep(ms) {
    return new Promise(resolve => {
        globalThis.setTimeout(resolve, ms);
    });
}


/**
 * Normalize a Foundry collection/Map/array into a plain array.
 * @param {*} collection
 * @returns {object[]}
 */
export function _list(collection) {
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
export function _tokenDoc(token) {
    if (!token || typeof token !== "object") return null;
    const doc = token.document;
    if (doc && typeof doc === "object" && doc.documentName === "Token") return doc;
    return token;
}


/**
 * Find a combatant of the combat by its own id.
 * @param {object} combat
 * @param {string|null} combatantId
 * @returns {object|null}
 */
export function _findCombatant(combat, combatantId) {
    if (!combatantId) return null;
    const collection = combat?.combatants;
    if (collection && typeof collection.get === "function") {
        const hit = collection.get(combatantId);
        if (hit) return hit;
    }
    for (const entry of _list(collection)) {
        if (entry?.id === combatantId) return entry;
    }
    return null;
}


/**
 * Numeric helper: value when finite, otherwise fallback.
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
export function _finiteOr(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}


/**
 * Merge a resource-delta object into the ledger: numeric fields add up,
 * everything else is stored as the latest value.
 * @param {object} ledger
 * @param {object|null} delta
 */
export function _mergeDelta(ledger, delta) {
    if (!delta || typeof delta !== "object") return;
    for (const [key, value] of Object.entries(delta)) {
        if (Number.isFinite(value) && Number.isFinite(ledger[key])) {
            ledger[key] += value;
        } else if (Number.isFinite(value)) {
            ledger[key] = value;
        } else {
            ledger[key] = value;
        }
    }
}


/**
 * Plan-time self position of the active plan's snapshot.
 * @param {object|null} plan
 * @returns {{x: number, y: number}|null}
 */
export function _selfPosition(plan) {
    const self = plan?.snapshot?.self;
    return self && Number.isFinite(self.x) && Number.isFinite(self.y)
        ? { x: self.x, y: self.y }
        : null;
}


/**
 * Grid size in pixels used for waypoint→document conversion.
 * @param {object} context
 * @returns {number}
 */
export function _gridSizeOf(context) {
    const size = context?.scene?.grid?.size
        ?? globalThis.canvas?.grid?.size;
    return Number.isFinite(size) && size > 0 ? size : 100;
}


/**
 * Document-space point of a serialized waypoint. Plans carry cell
 * *centres* (navigation `toPoint` = footprint centre), but Foundry 13
 * `TokenMovementWaypoint` expects the document position — the top-left
 * corner for a 1×1 token — so every point shifts by half the footprint.
 * Without this shift each move drifts the token half a cell off-grid,
 * the measured walk overshoots the planned budget and segments can
 * clip walls (issue #32).
 * @param {{x: number, y: number}} point Serialized waypoint/`to`.
 * @param {object|null} tokenDoc
 * @param {object} context
 * @returns {{x: number, y: number}}
 */
export function _docPoint(point, tokenDoc, context) {
    const size = _gridSizeOf(context);
    const fw = _finiteOr(tokenDoc?.width, 1) * size;
    const fh = _finiteOr(tokenDoc?.height, 1) * size;
    return { x: point.x - (fw / 2), y: point.y - (fh / 2) };
}


/**
 * Waypoint payload for `TokenDocument#move` (Foundry 13+): the
 * serialized navigation `planRoute` waypoints stored in the plan,
 * normalized to document-space `{x, y, elevation?}` with the step
 * endpoint appended. The path itself is never recomputed here.
 * @param {object} step Move step.
 * @param {{x: number, y: number}} to Destination (centre point).
 * @param {object|null} tokenDoc
 * @param {object} context
 * @returns {object[]}
 */
export function _movePayload(step, to, tokenDoc, context) {
    const raw = Array.isArray(step?.input?.waypoints) ? step.input.waypoints : [];
    const points = raw
        .filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))
        .map(point => ({
            ..._docPoint(point, tokenDoc, context),
            ...(Number.isFinite(point.elevation) ? { elevation: point.elevation } : {})
        }));
    const docTo = _docPoint(to, tokenDoc, context);
    const last = points[points.length - 1];
    if (!last || last.x !== docTo.x || last.y !== docTo.y) {
        points.push(docTo);
    }
    return points;
}


/**
 * Input for `prepareAttack`/`prepareTest`: the serialized step input
 * enriched with actor/token references and traceability flags. Extra
 * keys are ignored by the system API.
 * @param {object} step
 * @param {object} plan Active plan.
 * @param {string} operationId
 * @returns {object}
 */
export function _rollInput(step, plan, operationId) {
    const input = { ...(step?.input ?? {}) };
    // Steps serialize `itemUuid`; the rolls API expects `weaponId` —
    // an owned item id or UUID both resolve through `_findActorItem`.
    input.weaponId = input.weaponId ?? input.weaponItemId ?? input.itemUuid ?? null;
    input.actorUuid = input.actorUuid ?? plan?.actorUuid ?? plan?.snapshot?.self?.actorUuid ?? null;
    input.actorId = input.actorId ?? plan?.snapshot?.self?.actorId ?? null;
    input.tokenUuid = input.tokenUuid ?? plan?.tokenUuid ?? plan?.snapshot?.self?.tokenUuid ?? null;
    input.targetUuid = input.targetUuid ?? input.targetTokenUuid ?? null;
    // The step contract keeps the canonical `suppressing_fire` attack
    // type; the system API expects the underlying burst mode plus the
    // `suppressionFire` flag (`resolveSuppressionBurstMode` keeps it).
    if (input.attackType === "suppressing_fire") {
        input.suppressionFire = true;
        input.attackType = input.burstMode ?? "semi_auto";
    }
    input.flags = {
        ...(input.flags ?? {}),
        aiOperationId: operationId,
        aiStepId: step?.id ?? null
    };
    return input;
}


/**
 * Compact summary of the planner's rejected candidates for GM-facing
 * diagnostics ("pinned ×3, no-los ×2"). Returns `null` when the report
 * carries no rejection list.
 * @param {*} report Planner diagnostics or a replan report.
 * @returns {string|null}
 */
export function _rejectedSummary(report) {
    const rejected = Array.isArray(report?.rejected) ? report.rejected : [];
    if (!rejected.length) return null;
    const counts = new Map();
    for (const entry of rejected) {
        const reason = String(entry?.reason ?? "unknown");
        counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([reason, count]) => (count > 1 ? `${reason} ×${count}` : reason))
        .join(", ");
}
