/**
 * Planner decomposition (issue #403 follow-up): this module was extracted
 * verbatim from scripts/planner.js — see that file for the design contract.
 * The planner service re-exports the public surface so existing importers
 * and tests keep working.
 */
import {
    _actionBlastRadius,
    _actionRange
} from "./actions.js";
import {
    OVERWATCH_CONE_DEG,
    SPRAY_CONE_DEG,
    SUPPRESSION_CONE_DEG
} from "./contract.js";
import {
    _findToken,
    _tokenDoc,
    _tokenPosition,
    _tokenUuid
} from "./documents.js";
import {
    _hostileTo,
    _isMemorySource
} from "./targets.js";
import {
    _angleDiffDeg,
    _bearingMidpoint,
    _bearingTo,
    _distPx,
    _finiteOr,
    _list,
    _pixelDistance
} from "./util.js";


/**
 * Token list evaluated for blast coverage. Injected `context.blastTokens`
 * (unit tests) wins; live runs scan the canvas placeables and flag the
 * combat-defeated tokens via the combat combatant index; the last resort
 * is the combat's own combatant tokens.
 * @param {object} context Planning context.
 * @param {object} combat Combat document.
 * @param {string|null} sceneId Scene id for token uuid derivation.
 * @returns {object[]} `{tokenUuid, x, y, disposition}` entries (pixels).
 */
export function _blastTokens(context, combat, sceneId) {
    if (Array.isArray(context.blastTokens)) return context.blastTokens;
    const defeated = new Set();
    const index = new Map();
    for (const other of _list(combat?.combatants)) {
        const doc = _tokenDoc(other?.token);
        if (doc?.id) index.set(doc.id, other);
        if (other?.defeated === true && doc?.id) defeated.add(doc.id);
    }
    const placeables = _list(globalThis.canvas?.tokens?.placeables);
    const fromCanvas = placeables.map(token => {
        const doc = _tokenDoc(token);
        if (!doc || doc.destroyed === true || doc.hidden === true || !doc.actor) return null;
        const combatant = index.get(doc.id);
        if (combatant?.defeated === true) return null;
        const pos = _tokenPosition(doc);
        if (!pos) return null;
        return {
            tokenUuid: _tokenUuid(doc, sceneId) ?? doc.uuid ?? null,
            tokenId: doc.id ?? null,
            x: pos.x,
            y: pos.y,
            disposition: doc.disposition ?? combatant?.disposition ?? 0
        };
    }).filter(Boolean);
    if (fromCanvas.length) return fromCanvas;
    const fallback = [];
    for (const other of _list(combat?.combatants)) {
        const doc = _tokenDoc(other?.token);
        if (!doc || doc.destroyed === true || doc.hidden === true || other?.defeated === true) continue;
        const pos = _tokenPosition(doc);
        if (!pos) continue;
        fallback.push({
            tokenUuid: _tokenUuid(doc, sceneId) ?? doc.uuid ?? null,
            tokenId: doc.id ?? null,
            x: pos.x,
            y: pos.y,
            disposition: doc.disposition ?? other?.disposition ?? 0
        });
    }
    return fallback;
}


/**
 * Aim-point candidates around a blast target: the target centre plus
 * eight offsets at half the blast radius so the template can clip the
 * target instead of landing dead-centre.
 * @param {object} target Normalized target `{x, y}` (pixels).
 * @param {number} radiusPx Blast radius in pixels.
 * @returns {object[]}
 */
export function _blastAimPoints(target, radiusPx) {
    const cx = target?.x ?? 0;
    const cy = target?.y ?? 0;
    const r = radiusPx / 2;
    const points = [{ x: cx, y: cy }];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (const [dx, dy] of dirs) {
        const scale = dx !== 0 && dy !== 0 ? r * Math.SQRT1_2 : r;
        points.push({ x: cx + (dx * scale), y: cy + (dy * scale) });
    }
    return points;
}


/**
 * Pick the blast aim point covering the most hostile tokens while keeping
 * friendlies — and neutrals unless `options.includeNeutral` — outside the
 * template. `presumedUuid` marks a last-known strike point whose
 * remembered token is not locatable and counts as one presumed hostile.
 * @param {object} input
 * @param {object} input.tokenDoc Viewer token document.
 * @param {object} input.origin Throw origin `{x, y}` (pixels).
 * @param {object} input.target Normalized target (pixels; last-known ok).
 * @param {number} input.rangePx Weapon range in pixels.
 * @param {number} input.radiusPx Blast radius in pixels.
 * @param {object[]} input.tokens Blast-coverage scan entries.
 * @param {number} input.viewerDisposition Self disposition.
 * @param {object} input.options `{includeNeutral, dispositions}`.
 * @param {object|null} input.perception Perception service (LOS probes).
 * @param {string|null} [input.presumedUuid] Remembered target uuid.
 * @param {boolean} [input.requireLos] LOS from origin to the aim point.
 * @returns {{point: object, hits: number}|null}
 */
export function _bestBlastAim({
    tokenDoc, origin, target, rangePx, radiusPx, tokens,
    viewerDisposition, options, perception,
    presumedUuid = null, requireLos = true
}) {
    if (!origin || radiusPx <= 0) return null;
    const points = presumedUuid
        ? [{ x: target?.x ?? 0, y: target?.y ?? 0 }]
        : _blastAimPoints(target, radiusPx);
    let best = null;
    for (const point of points) {
        if (_distPx(origin, point) > rangePx + 1e-9) continue;
        if (requireLos && perception && typeof perception.hasLineOfSight === "function") {
            let los = true;
            try {
                // The aim point is a pixel centre — wrap it so the probe
                // does not treat it as a top-left corner and measure
                // into the wall half a cell away.
                los = perception.hasLineOfSight(tokenDoc, { center: point }) === true;
            } catch(err) {
                los = true;
            }
            if (!los) continue;
        }
        let hits = presumedUuid ? 1 : 0;
        let blocked = false;
        for (const token of tokens) {
            if (presumedUuid && token.tokenUuid === presumedUuid) continue;
            // Issue #54: the firing token itself is never a friendly-fire
            // veto — a template always covers its own origin.
            if ((token.tokenId ?? token.id) === tokenDoc?.id) continue;
            if (_distPx(point, token) > radiusPx + 1e-9) continue;
            const disp = Math.sign(_finiteOr(token.disposition, 0));
            if (!_hostileTo(viewerDisposition, disp, options)) blocked = true;
            else if (!presumedUuid) hits++;
        }
        if (blocked || hits <= 0) continue;
        if (!best || hits > best.hits
            || (hits === best.hits
                && _distPx(point, { x: target?.x, y: target?.y })
                    < _distPx(best.point, { x: target?.x, y: target?.y }))) {
            best = { point, hits };
        }
    }
    return best;
}


/**
 * Whether a token centre sits inside a directed cone: within `rangePx`
 * and no further than `angleDeg/2` off-axis.
 * @param {object} origin `{x, y}` pixels.
 * @param {number} directionDeg Cone axis direction (degrees).
 * @param {number} angleDeg Full cone angle (degrees).
 * @param {number} rangePx Cone length (pixels).
 * @param {object} token `{x, y}` pixels.
 * @returns {boolean}
 */
export function _tokenInCone(origin, directionDeg, angleDeg, rangePx, token) {
    const dx = _finiteOr(token?.x, NaN) - _finiteOr(origin?.x, NaN);
    const dy = _finiteOr(token?.y, NaN) - _finiteOr(origin?.y, NaN);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    const dist = Math.hypot(dx, dy);
    if (dist > rangePx + 1e-9) return false;
    if (dist < 1e-9) return true;
    const bearing = ((Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360;
    return _angleDiffDeg(bearing, directionDeg) <= (angleDeg / 2) + 1e-9;
}


/**
 * Cone spec of a template action: `suppressing_fire` fires a 45°
 * suppression cone; spray weapons (`traits.spray` / a `template`
 * requirement) fire a 30° cone. Regular attacks return null.
 * @param {object} action Normalized action.
 * @returns {{angle: number, spray?: boolean, suppression?: boolean, burstMode?: string}|null}
 */
export function _coneSpecOf(action) {
    if (!action) return null;
    if (action.attackType === "suppressing_fire") {
        const rof = action.rateOfFire ?? {};
        const burstMode = Number(rof.burst) > 0
            ? "semi_auto"
            : (Number(rof.full) > 0 ? "full_auto" : "semi_auto");
        return { angle: SUPPRESSION_CONE_DEG, suppression: true, burstMode };
    }
    if (action.spray === true || action.requirements?.includes("template")) {
        return { angle: SPRAY_CONE_DEG, spray: true };
    }
    return null;
}


/**
 * Pick the cone direction covering the most hostile tokens while keeping
 * friendlies — and neutrals unless `options.includeNeutral` — outside the
 * cone. Directions are searched over each hostile bearing plus the
 * short-arc midpoint of every hostile pair that fits inside one cone, so
 * clustered targets yield cluster-centred directions instead of a
 * single-token lock.
 * @param {object} input
 * @param {object} input.tokenDoc Viewer token document (LOS probes).
 * @param {object} input.origin Cone origin `{x, y}` (pixels).
 * @param {number} input.rangePx Cone length in pixels.
 * @param {number} input.angleDeg Full cone angle (degrees).
 * @param {object[]} input.tokens Coverage scan entries (blastTokens shape).
 * @param {object[]} [input.anchors] Perceived orientation anchors (issue
 *   #30): when provided, only these `{x, y, tokenUuid?, tokenId?}` points
 *   steer the cone — visible targets aim their live position, last-known
 *   contacts the remembered point; `tokens` still vetoes friendlies but
 *   hostiles the bot cannot perceive are ignored instead of counted.
 * @param {number} input.viewerDisposition Self disposition.
 * @param {object} input.options `{includeNeutral, dispositions}`.
 * @param {object|null} input.perception Perception service (LOS probes).
 * @param {boolean} [input.requireLos] Require LOS to ≥1 covered hostile.
 * @returns {{direction: number, hits: number, covered: object[]}|null}
 */
export function _bestConeAim({
    tokenDoc, origin, rangePx, angleDeg, tokens,
    anchors = null, viewerDisposition, options, perception, requireLos = true
}) {
    if (!origin || rangePx <= 0 || !(angleDeg > 0)) return null;
    const hostiles = (tokens ?? []).filter(token =>
        _hostileTo(viewerDisposition, Math.sign(_finiteOr(token.disposition, 0)), options));
    // Issue #30: without an explicit anchor list the hostile coverage
    // scan steers the cone (legacy behaviour); with one, only perceived
    // anchors do — a hostile the bot cannot see never aims the template.
    const anchorList = Array.isArray(anchors)
        ? anchors.filter(anchor => Number.isFinite(anchor?.x) && Number.isFinite(anchor?.y))
        : hostiles;
    if (!anchorList.length) return null;
    const bearings = anchorList.map(anchor =>
        ((Math.atan2(anchor.y - origin.y, anchor.x - origin.x) * 180 / Math.PI) + 360) % 360);
    const directions = new Set(bearings);
    for (let i = 0; i < bearings.length; i++) {
        for (let j = i + 1; j < bearings.length; j++) {
            if (_angleDiffDeg(bearings[i], bearings[j]) <= angleDeg - 1e-9) {
                directions.add(_bearingMidpoint(bearings[i], bearings[j]));
            }
        }
    }
    let best = null;
    for (const direction of directions) {
        let hits = 0;
        let blocked = false;
        const covered = [];
        for (const anchor of anchorList) {
            if (!_tokenInCone(origin, direction, angleDeg, rangePx, anchor)) continue;
            hits++;
            covered.push({
                tokenUuid: anchor.tokenUuid ?? null,
                tokenId: anchor.tokenId ?? anchor.id ?? null,
                x: anchor.x,
                y: anchor.y,
                elevation: anchor.elevation ?? null
            });
        }
        if (hits <= 0) continue;
        // Friendly/neutral veto still scans every scene token: the bot
        // must not blanket allies just because it aimed by perception.
        for (const token of tokens) {
            // Issue #54: the firing token itself always sits at the cone
            // origin — it is not a friendly-fire veto.
            if ((token.tokenId ?? token.id) === tokenDoc?.id) continue;
            if (!_tokenInCone(origin, direction, angleDeg, rangePx, token)) continue;
            const disp = Math.sign(_finiteOr(token.disposition, 0));
            if (!_hostileTo(viewerDisposition, disp, options)) {
                blocked = true;
                break;
            }
        }
        if (blocked) continue;
        if (requireLos && perception && typeof perception.hasLineOfSight === "function") {
            let anyLos = false;
            for (const entry of covered) {
                let los = true;
                try {
                    los = perception.hasLineOfSight(tokenDoc,
                        { center: { x: entry.x, y: entry.y } }) === true;
                } catch(err) {
                    los = true;
                }
                if (los) {
                    anyLos = true;
                    break;
                }
            }
            if (!anyLos) continue;
        }
        if (!best || hits > best.hits
            || (hits === best.hits && direction < best.direction)) {
            best = { direction, hits, covered };
        }
    }
    if (best) best.covered.sort((a, b) => String(a.tokenUuid).localeCompare(String(b.tokenUuid)));
    return best;
}


/**
 * Factor-facing target entry of a cone candidate: the covered token that
 * maps to a normalized target wins (real target data), otherwise the
 * first covered token is synthesized into a minimal visible-target
 * record so factors like `proximity`/`vulnerable` stay meaningful.
 * @param {object|null} aim `_bestConeAim` result.
 * @param {object[]} targets Normalized targets.
 * @param {object} selfPos Self position `{x, y}` (pixels).
 * @param {object} grid `_gridInfo` result.
 * @returns {object|null}
 */
export function _coneTargetOf(aim, targets, selfPos, grid) {
    for (const covered of aim?.covered ?? []) {
        const match = targets.find(target => target.tokenUuid === covered.tokenUuid);
        if (match) return match;
    }
    const first = aim?.covered?.[0] ?? null;
    if (!first) return null;
    return {
        tokenUuid: first.tokenUuid,
        tokenId: first.tokenId,
        x: first.x,
        y: first.y,
        elevation: first.elevation,
        distance: _pixelDistance(selfPos, first, grid),
        canAttack: true,
        source: "visible",
        statuses: [],
        threat: 0
    };
}


/**
 * Half-move rate of a target in scene units: the normalized `halfMove`
 * field wins, the threat-profile copy is the fallback (same precedence
 * as the dodge-escape model in {@link dodgeChanceOf}).
 * @param {object|null} target Normalized target.
 * @returns {number|null}
 */
export function _targetHalfMove(target) {
    return _finiteOr(target?.halfMove ?? target?.threatProfile?.halfMove, null);
}


/**
 * Lead point of a target ("на опережение", issue #54): where the enemy
 * arrives next turn walking its shortest straight line toward the bot —
 * `threatPos + dir(threat → self) × min(halfMove, distToSelf)`.
 * @param {object} target Normalized target `{x, y}` (pixels).
 * @param {object} selfPos Self position `{x, y}` (pixels).
 * @param {number} pxPerUnit Pixels per scene unit.
 * @returns {{x: number, y: number}|null}
 */
export function _leadPointOf(target, selfPos, pxPerUnit) {
    const halfMove = _targetHalfMove(target);
    if (!(halfMove > 0)) return null;
    const dist = _distPx(target, selfPos);
    if (!Number.isFinite(dist) || dist < 1e-9) return null;
    const step = Math.min(halfMove * pxPerUnit, dist);
    return {
        x: target.x + (((selfPos.x - target.x) / dist) * step),
        y: target.y + (((selfPos.y - target.y) / dist) * step)
    };
}


/**
 * Route waypoint of the nearest threat ("в проход", issue #54): the
 * enemy's own `planRoute(threat → self)` — the same deterministic
 * pathfind the planner uses for its own moves — walked to the point
 * ~half a half-move along it. The shortest approach route threads the
 * doors and corridors itself, so a cone steered at this anchor covers
 * the real chokepoint instead of open ground. Without a rate the route
 * midpoint is taken; a missing service/token/route yields `null` and the
 * caller falls back to lead points. Partial routes are accepted — the
 * anchor sits close to the threat end either way.
 * @param {object} input
 * @param {object} input.threat Normalized nearest threat.
 * @param {object} input.selfPos Self position `{x, y}` (pixels).
 * @param {number} input.pxPerUnit Pixels per scene unit.
 * @param {object|null} input.navigation Navigation service.
 * @param {object|null} input.combat Active combat (token lookup).
 * @param {object|null} input.scene Active scene (token lookup).
 * @returns {{x: number, y: number}|null}
 */
export function _overwatchRoutePoint({ threat, selfPos, pxPerUnit,
    navigation, combat, scene }) {
    if (!navigation || typeof navigation.planRoute !== "function") return null;
    const threatDoc = _findToken(threat?.tokenId, { combat, scene });
    if (!threatDoc || !Number.isFinite(selfPos?.x)) return null;
    const distUnits = _finiteOr(threat?.distance, null);
    // A generous numeric budget keeps the search deterministic while
    // still bounding it — a route winding past the straight distance is
    // truncated to a partial path, whose first leg anchors just as well.
    const budget = Number.isFinite(distUnits) && distUnits > 0
        ? Math.max(distUnits * 4, 1) : 64;
    let route = null;
    try {
        route = navigation.planRoute(threatDoc, { x: selfPos.x, y: selfPos.y }, budget);
    } catch(err) {
        route = null;
    }
    const waypoints = (route?.waypoints ?? route?.path ?? [])
        .filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y));
    if (waypoints.length < 2) return null;
    const px = pxPerUnit > 0 ? pxPerUnit : 1;
    const halfMove = _targetHalfMove(threat);
    const total = waypoints.slice(1).reduce(
        (sum, point, index) => sum + _distPx(waypoints[index], point), 0);
    if (!(total > 0)) return null;
    const wanted = halfMove > 0
        ? Math.min(halfMove * px / 2, total)
        : total / 2;
    let walked = 0;
    for (let index = 1; index < waypoints.length; index++) {
        walked += _distPx(waypoints[index - 1], waypoints[index]);
        if (walked + 1e-9 >= wanted) {
            return { x: waypoints[index].x, y: waypoints[index].y };
        }
    }
    const last = waypoints[waypoints.length - 1];
    return { x: last.x, y: last.y };
}


/**
 * Predicted orientation anchors of an overwatch declaration (issue #54).
 * The zone controls ground the enemy is about to cross, not the square
 * it already stands on: the route waypoint of the nearest threat first
 * (one bounded pathfind per plan, only while an overwatch candidate is
 * being built), a lead point per live threat, and the remembered
 * positions of memory contacts (`last-known`/`team-contact` — their
 * recorded point IS the prediction, issue #45 anchor). Anchors the bot
 * cannot see are dropped — a watch zone behind a wall can never fire.
 * @param {object} input
 * @param {object[]} input.targets Normalized targets.
 * @param {object} input.threatTarget Nearest threat (route anchor).
 * @param {object} input.selfPos Self position `{x, y}` (pixels).
 * @param {number} input.pxPerUnit Pixels per scene unit.
 * @param {object|null} input.navigation Navigation service.
 * @param {object|null} input.combat Active combat.
 * @param {object|null} input.scene Active scene.
 * @param {object|null} input.tokenDoc Viewer token document (LOS probes).
 * @param {object|null} input.perception Perception service (LOS probes).
 * @param {object|null} [input.lane] Active chokepoint-defense lane contract;
 *   its chokepoint becomes the priority synthetic orientation anchor.
 * @returns {object[]} `{x, y, kind, tokenUuid, tokenId}` anchors.
 */
export function _overwatchAnchors({ targets, threatTarget, selfPos, pxPerUnit,
    navigation, combat, scene, tokenDoc, perception, lane = null }) {
    const anchors = [];
    const seen = new Set();
    const push = (point, kind, target) => {
        if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
        // Equal predictions (a lead point landing on the route waypoint)
        // must not count double — the aim coverage score stays honest.
        const key = `${Math.round(point.x)},${Math.round(point.y)}`;
        if (seen.has(key)) return;
        seen.add(key);
        anchors.push({
            x: point.x,
            y: point.y,
            kind,
            tokenUuid: target?.tokenUuid ?? null,
            tokenId: target?.tokenId ?? null
        });
    };
    // Issue #91: the lane chokepoint is the high-priority synthetic
    // orientation anchor. Generic route/lead/memory anchors are narrowed
    // to the lane threat ids when those ids are known; the lane anchor
    // itself may remain as the declare-only orientation point even when
    // every concrete threat is currently outside this member's LOS.
    const laneIds = new Set((lane?.threatIds ?? []).map(String));
    const inLane = target => {
        if (!lane || !laneIds.size) return true;
        return [target?.tokenId, target?.tokenUuid, target?.actorId]
            .filter(id => id !== null && id !== undefined)
            .some(id => laneIds.has(String(id)));
    };
    const laneTargets = (targets ?? []).filter(inLane);
    push(lane?.chokepoint ?? lane?.lanePoint ?? null, "lane", null);
    const routeTarget = lane
        ? (laneTargets.find(target => target === threatTarget)
            ?? laneTargets.find(target => target?.canAttack === true && target?.hidden !== true)
            ?? laneTargets[0]
            ?? threatTarget)
        : threatTarget;
    push(_overwatchRoutePoint({
        threat: routeTarget, selfPos, pxPerUnit, navigation, combat, scene
    }), "route", routeTarget);
    for (const target of laneTargets) {
        if (target?.canAttack !== true || target?.hidden === true) continue;
        push(_leadPointOf(target, selfPos, pxPerUnit), "lead", target);
    }
    for (const target of laneTargets) {
        if (!_isMemorySource(target?.source) || target?.hidden === true) continue;
        push({ x: target.x, y: target.y }, "memory", target);
    }
    if (!perception || typeof perception.hasLineOfSight !== "function") {
        return anchors;
    }
    return anchors.filter(anchor => {
        try {
            return perception.hasLineOfSight(tokenDoc, anchor) === true;
        } catch(err) {
            return true;
        }
    });
}


/**
 * Trigger circle of a blast overwatch (issue #54): the predicted anchor
 * covering the most other anchors within the blast radius wins — the
 * grenade lands where converging approach routes intersect. Candidate
 * centres must sit inside the throw range and must not blanket a
 * friendly (the same `blastTokens` veto as `_bestBlastAim`); the visible
 * threat's live position is the last-resort centre, so an empty
 * prediction set degrades to the old straight-at-threat zone.
 * @param {object} input
 * @param {object[]} input.anchors Predicted anchors (`_overwatchAnchors`).
 * @param {object} input.threatTarget Nearest live threat (fallback centre).
 * @param {object} input.selfPos Self position `{x, y}` (pixels).
 * @param {object|null} input.tokenDoc Viewer token document (self veto
 *   exemption).
 * @param {number} input.rangePx Weapon range in pixels.
 * @param {number} input.radiusPx Blast radius in pixels.
 * @param {object[]} input.tokens Coverage scan (`_blastTokens` shape).
 * @param {number} input.viewerDisposition Self disposition.
 * @param {object} input.options `{includeNeutral, dispositions}`.
 * @returns {{shape: "blast", targetPoint: {x: number, y: number}}|null}
 */
export function _overwatchBlastZone({ anchors, threatTarget, selfPos, tokenDoc,
    rangePx, radiusPx, tokens, viewerDisposition, options }) {
    if (!(rangePx > 0) || !(radiusPx > 0)) return null;
    const centres = [...(anchors ?? [])];
    if (Number.isFinite(threatTarget?.x) && Number.isFinite(threatTarget?.y)) {
        centres.push({ x: threatTarget.x, y: threatTarget.y, kind: "live" });
    }
    let best = null;
    centres.forEach(centre => {
        if (_distPx(selfPos, centre) > rangePx + 1e-9) return;
        let hits = 0;
        let blocked = false;
        for (const token of tokens ?? []) {
            if ((token.tokenId ?? token.id) === tokenDoc?.id) continue;
            if (_distPx(centre, token) > radiusPx + 1e-9) continue;
            const disp = Math.sign(_finiteOr(token.disposition, 0));
            if (!_hostileTo(viewerDisposition, disp, options)) {
                blocked = true;
                break;
            }
        }
        if (blocked) return;
        for (const anchor of anchors ?? []) {
            if (_distPx(centre, anchor) <= radiusPx + 1e-9) hits++;
        }
        // The threat's own square always counts — a trigger circle over
        // the live enemy fires the moment it acts.
        if (_distPx(centre, threatTarget) <= radiusPx + 1e-9) hits++;
        if (hits <= 0) return;
        // First-listed centre wins ties: route > lead > memory > live —
        // the deterministic preference order of issue #54.
        if (!best || hits > best.hits) best = { centre, hits };
    });
    if (!best) return null;
    return {
        shape: "blast",
        targetPoint: { x: best.centre.x, y: best.centre.y }
    };
}


/**
 * Watch zone of one overwatch weapon (issue #54). Cone geometries steer
 * `_bestConeAim` by the predicted anchors — the existing coverage sweep
 * already maximizes the number of covered predictions with the friendly
 * veto, so converging approach routes land the cone on the shared
 * chokepoint naturally (all-anchors variant of the issue). A raw bearing
 * on the nearest threat stays the last-resort fallback when nothing was
 * predictable, preserving the issue #15 behaviour.
 * @param {object} input
 * @param {"cone"|"spray"|"blast"} input.kind Zone geometry of the weapon.
 * @param {object} input.action Overwatch weapon action.
 * @param {object[]} input.anchors Predicted anchors.
 * @param {object} input.threatTarget Nearest live threat (fallback).
 * @param {object} input.selfPos Self position `{x, y}` (pixels).
 * @param {number} input.pxPerUnit Pixels per scene unit.
 * @param {object|null} input.tokenDoc Viewer token document.
 * @param {object[]} input.tokens Coverage scan (`_blastTokens` shape).
 * @param {number} input.viewerDisposition Self disposition.
 * @param {object} input.options `{includeNeutral, dispositions}`.
 * @param {object|null} [input.fallbackPoint] Lane chokepoint orientation point
 *   used when no concrete anchor produces a cone aim.
 * @returns {object|null} `{shape, direction?, arc?, range?, targetPoint?,
 *   blastRadius?}`.
 */
export function _overwatchZone({ kind, action, anchors, threatTarget, selfPos,
    pxPerUnit, tokenDoc, tokens, viewerDisposition, options, fallbackPoint = null }) {
    const range = _actionRange(action);
    const rangePx = range * pxPerUnit;
    if (kind === "blast") {
        const zone = _overwatchBlastZone({
            anchors, threatTarget, selfPos, tokenDoc, rangePx,
            radiusPx: _actionBlastRadius(action) * pxPerUnit,
            tokens, viewerDisposition, options
        });
        return zone ? { ...zone, blastRadius: _actionBlastRadius(action), range } : null;
    }
    const spec = _coneSpecOf(action);
    const arc = spec?.angle ?? OVERWATCH_CONE_DEG;
    const aim = _bestConeAim({
        tokenDoc,
        origin: selfPos,
        rangePx,
        angleDeg: arc,
        tokens,
        anchors,
        viewerDisposition,
        options,
        perception: null,
        requireLos: false
    });
    if (aim) return { shape: "cone", direction: aim.direction, arc, range };
    const direction = _bearingTo(selfPos, fallbackPoint ?? threatTarget);
    return Number.isFinite(direction)
        ? { shape: "cone", direction, arc, range }
        : null;
}


/**
 * Danger value at the bot's own position for the drop-prone check —
 * `dangerAt` may throw; a broken probe counts as no cover urgency.
 * @param {Function} dangerAt Threat-map probe.
 * @param {object} selfPos Self position `{x, y}` (pixels).
 * @returns {number} 0..1.
 */
export function _dangerAtSelf(dangerAt, selfPos) {
    try {
        return _finiteOr(dangerAt(selfPos), 0);
    } catch(err) {
        return 0;
    }
}
