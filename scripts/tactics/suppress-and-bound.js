/**
 * Pure core of the `suppress-and-bound` team tactic (issue #86, epic #84).
 *
 * The module is deliberately document-free: it never reads `game`, `canvas`,
 * combat turn order or Foundry collections beyond the plain data objects the
 * caller passes in. Fireteam/preset adapters normalize member positions to
 * pixel centres, supply `turnIndex`/`hasActed`, scene-token geometry and any
 * LOS probe; this core only scans weapon data, evaluates safe suppression
 * cones and returns a serializable tactic descriptor (or an explained
 * degradation through {@link explainSuppressAndBound}).
 *
 * v1 approximations fixed by the specification:
 * - suppression capability is scanned synchronously from item data, with
 *   `system.modified.rateOfFire` winning over the base RoF;
 * - suppression ammunition cost is the full system burst: semi-auto first,
 *   full-auto only when no semi-auto RoF exists;
 * - visible/team-contact anchors weigh 1, own last-known memory anchors weigh
 *   {@link LAST_KNOWN_WEIGHT}; pinned and hidden targets never count;
 * - coverage normally needs {@link SUPPRESSION_COVERAGE_MIN}, while a real
 *   bound need lowers the trigger to one weighted target (spec trigger 3).
 */
import { SUPPRESSION_CONE_DEG } from "../planner/contract.js";
import { _hostileTo } from "../planner/targets.js";
import {
    _angleDiffDeg,
    _bearingMidpoint,
    _bearingTo,
    _distPx,
    _finiteOr,
    _list
} from "../planner/util.js";
import { _tokenInCone } from "../planner/zones.js";

/** Tactic name serialized in the descriptor. */
export const SUPPRESS_AND_BOUND = "suppress-and-bound";

/** Weight of one own-memory (`last-known`) target in cone coverage. */
export const LAST_KNOWN_WEIGHT = 0.5;

/** Default weighted coverage needed without a bound need. */
export const SUPPRESSION_COVERAGE_MIN = 2;

/** Weighted coverage accepted when the team genuinely needs to bound. */
export const BOUND_NEED_COVERAGE_MIN = 1;

/** Default enemy/member ratio treated as overwhelming for the tactic. */
export const SUPPRESSION_PRESSURE_CANCEL_RATIO = 2;

/** Experimental coefficients of the pure selector; presets may override them. */
export const DEFAULT_SUPPRESS_AND_BOUND_CONFIG = Object.freeze({
    coverageMin: SUPPRESSION_COVERAGE_MIN,
    boundNeedCoverageMin: BOUND_NEED_COVERAGE_MIN,
    lastKnownWeight: LAST_KNOWN_WEIGHT,
    pressureCancelRatio: SUPPRESSION_PRESSURE_CANCEL_RATIO,
    coneAngleDeg: SUPPRESSION_CONE_DEG,
    maxDetachedPhases: 2,
    requireLos: true
});

const CAPABILITY_REASON_ORDER = Object.freeze([
    "no-weapon",
    "not-ranged",
    "no-autofire",
    "jammed",
    "low-ammo"
]);

const MEMORY_WEIGHT_SOURCES = Object.freeze(new Set([
    "last-known",
    "memory",
    "relay",
    "intel"
]));

const EPSILON = 1e-9;

/**
 * Numeric coercion with fallback (item data occasionally arrives as strings).
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function _numberOr(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

/**
 * Round a finite number for stable serialized diagnostics.
 * @param {*} value
 * @param {number} [digits]
 * @returns {*}
 */
function _round(value, digits = 4) {
    if (!Number.isFinite(value)) return value;
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

/**
 * Whether a value is a finite `{x, y}` point.
 * @param {*} point
 * @returns {boolean}
 */
function _isPoint(point) {
    return Number.isFinite(point?.x) && Number.isFinite(point?.y);
}

/**
 * Copy a finite point into a plain serializable object.
 * @param {*} point
 * @returns {{x: number, y: number}|null}
 */
function _copyPoint(point) {
    return _isPoint(point) ? { x: point.x, y: point.y } : null;
}

/**
 * Sorted status ids from Foundry-style arrays, sets or truthy maps.
 * @param {*} source
 * @returns {string[]}
 */
function _statusIds(source) {
    const ids = new Set();
    if (!source) return [];
    if (typeof source[Symbol.iterator] === "function") {
        for (const id of source) ids.add(String(id));
    } else if (typeof source === "object") {
        for (const key of Object.keys(source)) {
            if (source[key]) ids.add(String(key));
        }
    }
    return [...ids].sort();
}

/**
 * Unwrap a token placeable; plain documents pass through.
 * @param {*} token
 * @returns {object|null}
 */
function _tokenDoc(token) {
    if (!token || typeof token !== "object") return null;
    return token.document && typeof token.document === "object" ? token.document : token;
}

/**
 * Top-left position of a plain token document.
 * @param {object|null} token
 * @returns {{x: number|null, y: number|null}}
 */
function _tokenTopLeft(token) {
    const x = token?._source?.x ?? token?.x ?? token?.object?.x;
    const y = token?._source?.y ?? token?.y ?? token?.object?.y;
    return {
        x: Number.isFinite(x) ? x : null,
        y: Number.isFinite(y) ? y : null
    };
}

/**
 * Centre of a token document in pixels using the scene grid size.
 * @param {object|null} token
 * @param {number} gridSize
 * @returns {{x: number, y: number}|null}
 */
function _tokenCenter(token, gridSize) {
    const topLeft = _tokenTopLeft(token);
    if (!_isPoint(topLeft) || !(gridSize > 0)) return _isPoint(topLeft) ? topLeft : null;
    const width = _numberOr(token?.width, 1) || 1;
    const height = _numberOr(token?.height, 1) || 1;
    return {
        x: topLeft.x + (width * gridSize / 2),
        y: topLeft.y + (height * gridSize / 2)
    };
}

/**
 * Member origin in pixel centres. Adapters may pass `member.center` or mark
 * `positionIsCenter`; raw `collectMembers` positions are converted only when
 * they still exactly match the linked token's top-left document position.
 * @param {object} member
 * @param {number} gridSize
 * @returns {{x: number, y: number}|null}
 */
function _memberCenter(member, gridSize) {
    if (_isPoint(member?.center)) return _copyPoint(member.center);
    const position = _copyPoint(member?.position);
    if (!position) return null;
    if (member?.positionIsCenter === true) return position;
    const token = _tokenDoc(member?.combatant?.token);
    const topLeft = _tokenTopLeft(token);
    if (_isPoint(topLeft) && topLeft.x === position.x && topLeft.y === position.y) {
        return _tokenCenter(token, gridSize);
    }
    return position;
}

/**
 * Actor-like object carrying the member inventory.
 * @param {object} member
 * @returns {object|null}
 */
function _actorOfMember(member) {
    return member?.combatant?.actor
        ?? _tokenDoc(member?.combatant?.token)?.actor
        ?? member?.actor
        ?? null;
}

/**
 * Stable item/combatant id used as the final deterministic tie-break.
 * @param {object} entry
 * @returns {string}
 */
function _stableId(entry) {
    return String(entry?.itemId ?? entry?.id ?? entry?.itemUuid ?? entry?.uuid ?? entry?.name ?? "");
}

/**
 * Read a clip value from the small number of shapes used by OW item data.
 * @param {*} container
 * @returns {number}
 */
function _clipPart(container) {
    if (Number.isFinite(container)) return container;
    return _numberOr(container?.value, 0);
}

/**
 * Resolve the system suppression burst mode: semi-auto wins, full-auto is
 * the fallback for weapons that cannot fire semi-auto bursts.
 * @param {object} rateOfFire
 * @returns {string|null}
 */
function _suppressionBurstMode(rateOfFire) {
    if (_numberOr(rateOfFire?.burst, 0) > 0) return "semi_auto";
    if (_numberOr(rateOfFire?.full, 0) > 0) return "full_auto";
    return null;
}

/**
 * Scan one member inventory for suppression-capable ranged weapons. The scan
 * is intentionally synchronous and approximate: firing-mode power settings
 * are represented by the base/modified item RoF, while the ammo gate demands
 * the full suppression burst (`max(1, RoF) × ammoPerShot`).
 * @param {object} member Fireteam member entry or plain member DTO.
 * @returns {{capable: boolean, weapon: object|null, weapons: object[],
 *   reasons: string[]}} Capability summary; every weapon row carries
 *   machine-readable refusal reasons.
 */
export function scanSuppressionCapability(member) {
    const actor = _actorOfMember(member);
    const rows = [];
    for (const item of _list(actor?.items)) {
        if (!item || item.type !== "weapon") continue;
        const system = item.system ?? {};
        const cls = String(system.class ?? "").toLowerCase();
        const notRanged = cls === "melee" || cls === "thrown"
            || system.isMelee === true || system.isThrown === true
            || system.isGrenade === true || system.usesGrenade === true
            || system.grenade === true;
        const modifiedRoF = system.modified?.rateOfFire;
        const rofSource = modifiedRoF ?? system.rateOfFire ?? {};
        const rateOfFire = {
            single: _numberOr(rofSource.single, 0),
            burst: _numberOr(rofSource.burst, 0),
            full: _numberOr(rofSource.full, 0)
        };
        const burstMode = _suppressionBurstMode(rateOfFire);
        const rate = burstMode === "semi_auto" ? rateOfFire.burst : rateOfFire.full;
        const ammoPerShot = _numberOr(system.ammoPerShot, 1);
        const ammoCost = burstMode ? Math.max(1, rate) * ammoPerShot : null;
        const clip = _clipPart(system.clip ?? system.ammo);
        const clipMax = _numberOr(system.clip?.max ?? system.ammo?.max, 0);
        const jammed = system.jammed === true || item.jammed === true;
        const reasons = [];
        if (notRanged) reasons.push("not-ranged");
        if (!burstMode) reasons.push("no-autofire");
        if (jammed) reasons.push("jammed");
        if (burstMode && !(clip >= ammoCost)) reasons.push("low-ammo");
        const itemId = item.id ?? item.itemId ?? null;
        rows.push({
            itemId,
            itemUuid: item.uuid ?? null,
            name: item.name ?? itemId ?? "weapon",
            class: system.class ?? null,
            attackType: "suppressing_fire",
            range: _numberOr(system.range, 0),
            rateOfFire,
            modifiedRateOfFire: modifiedRoF != null,
            burstMode,
            ammoPerShot,
            ammoCost,
            clip,
            clipMax,
            clipPercent: clipMax > 0 ? _round(clip / clipMax) : (clip > 0 ? 1 : 0),
            clipAfter: ammoCost === null ? null : clip - ammoCost,
            jammed,
            capable: reasons.length === 0,
            reasons
        });
    }
    rows.sort((a, b) => _stableId(a).localeCompare(_stableId(b)));
    const capableRows = rows.filter(row => row.capable);
    capableRows.sort((a, b) => (b.clipPercent - a.clipPercent)
        || (b.range - a.range)
        || _stableId(a).localeCompare(_stableId(b)));
    const reasonSet = new Set();
    for (const row of rows) {
        for (const reason of row.reasons) reasonSet.add(reason);
    }
    if (!rows.length) reasonSet.add("no-weapon");
    const reasons = CAPABILITY_REASON_ORDER.filter(reason => reasonSet.has(reason));
    return {
        capable: capableRows.length > 0,
        weapon: capableRows[0] ?? null,
        weapons: rows,
        reasons
    };
}

/**
 * Coverage weight of a target anchor. Team contacts are fresh squad sightings
 * and weigh like visible targets; own memory and rough intel are halved.
 * @param {object} target
 * @param {number} lastKnownWeight
 * @returns {number}
 */
function _targetWeight(target, lastKnownWeight) {
    const source = target?.source ?? null;
    if (source === "team-contact") return 1;
    return MEMORY_WEIGHT_SOURCES.has(source) ? lastKnownWeight : 1;
}

/**
 * Deterministic dedupe key of a target/token anchor.
 * @param {object} target
 * @returns {string}
 */
function _targetKey(target) {
    if (target?.tokenUuid) return `uuid:${target.tokenUuid}`;
    if (target?.tokenId) return `id:${target.tokenId}`;
    return `xy:${target?.x},${target?.y}`;
}

/**
 * Prefer direct sightings when duplicate target records describe one token.
 * @param {string|null} source
 * @returns {number}
 */
function _sourceRank(source) {
    if (source === "visible" || source === "fallback" || source === "injected" || source === null) return 0;
    if (source === "team-contact") return 1;
    return 2;
}

/**
 * Normalize and deduplicate target records into weighted cone anchors.
 * @param {object[]} targets
 * @param {number} lastKnownWeight
 * @returns {{entries: object[], anchors: object[], targetCount: number,
 *   pinnedExcluded: number, hiddenExcluded: number}}
 */
function _prepareTargets(targets, lastKnownWeight) {
    const byKey = new Map();
    for (const target of targets ?? []) {
        if (!_isPoint(target)) continue;
        const statuses = _statusIds(target.statuses);
        const source = target.source ?? null;
        const entry = {
            tokenUuid: target.tokenUuid ?? null,
            tokenId: target.tokenId ?? null,
            x: target.x,
            y: target.y,
            elevation: _finiteOr(target.elevation, null),
            source,
            statuses,
            pinned: statuses.includes("pinned"),
            hidden: target.hidden === true,
            disposition: Number.isFinite(target.disposition) ? target.disposition : null,
            weight: _targetWeight(target, lastKnownWeight)
        };
        const key = _targetKey(entry);
        const previous = byKey.get(key);
        if (!previous
            || entry.weight > previous.weight + EPSILON
            || (Math.abs(entry.weight - previous.weight) <= EPSILON
                && _sourceRank(entry.source) < _sourceRank(previous.source))) {
            byKey.set(key, entry);
        }
    }
    const entries = [...byKey.values()]
        .sort((a, b) => _targetKey(a).localeCompare(_targetKey(b)));
    const visibleSpace = entries.filter(entry => entry.hidden !== true);
    return {
        entries,
        anchors: visibleSpace.filter(entry => entry.pinned !== true && entry.weight > 0),
        targetCount: visibleSpace.length,
        pinnedExcluded: visibleSpace.filter(entry => entry.pinned === true).length,
        hiddenExcluded: entries.filter(entry => entry.hidden === true).length
    };
}

/**
 * Grid size in pixels supplied explicitly or derived from plain scene data.
 * @param {object} context
 * @param {object|null} combat
 * @param {object|null} scene
 * @returns {number}
 */
function _gridSize(context, combat, scene) {
    const grid = context.grid ?? scene?.grid ?? context.scene?.grid ?? combat?.scene?.grid ?? {};
    return _numberOr(grid.size, 0);
}

/**
 * Pixels per scene unit supplied explicitly or derived from grid data.
 * @param {object} context
 * @param {object|null} combat
 * @param {object|null} scene
 * @returns {number}
 */
function _pxPerUnit(context, combat, scene) {
    if (_numberOr(context.pxPerUnit, 0) > 0) return _numberOr(context.pxPerUnit, 1);
    const grid = context.grid ?? scene?.grid ?? context.scene?.grid ?? combat?.scene?.grid ?? {};
    const size = _numberOr(grid.size, 0);
    const distance = _numberOr(grid.distance, 0);
    return size > 0 && distance > 0 ? size / distance : 1;
}

/**
 * Normalize an explicitly injected scene-token geometry row. These rows are
 * already expected to use pixel centres, matching normalized target data.
 * @param {object} raw
 * @returns {object|null}
 */
function _explicitToken(raw) {
    const point = _isPoint(raw?.center) ? raw.center : raw;
    if (!_isPoint(point)) return null;
    return {
        tokenUuid: raw.tokenUuid ?? raw.uuid ?? null,
        tokenId: raw.tokenId ?? raw.id ?? null,
        x: point.x,
        y: point.y,
        disposition: _numberOr(raw.disposition, 0),
        hidden: raw.hidden === true,
        destroyed: raw.destroyed === true,
        defeated: raw.defeated === true
    };
}

/**
 * Dedupe key of a scene-token row.
 * @param {object} token
 * @returns {string}
 */
function _scanTokenKey(token) {
    if (token?.tokenId) return `id:${token.tokenId}`;
    if (token?.tokenUuid) return `uuid:${token.tokenUuid}`;
    return `xy:${token?.x},${token?.y}`;
}

/**
 * Build the friendly/neutral veto scan without touching the canvas. Explicit
 * geometry wins; otherwise plain combat combatants are converted from token
 * documents. Team members are always supplemented because their bodies are
 * the veto this tactic exists for.
 * @param {object} input
 * @param {object[]} input.members
 * @param {object|null} input.combat
 * @param {object} input.context
 * @param {number} input.gridSize
 * @returns {object[]}
 */
function _sceneTokens({ members, combat, context, gridSize }) {
    const explicit = [context.suppressionTokens, context.sceneTokens, context.blastTokens, context.tokens]
        .find(value => Array.isArray(value));
    const rows = [];
    if (explicit) {
        for (const raw of explicit) {
            const token = _explicitToken(raw);
            if (token) rows.push(token);
        }
    } else {
        for (const combatant of _list(combat?.combatants)) {
            const doc = _tokenDoc(combatant?.token);
            const pos = _tokenCenter(doc, gridSize);
            if (!pos) continue;
            rows.push({
                tokenUuid: doc?.uuid ?? null,
                tokenId: combatant?.tokenId ?? doc?.id ?? null,
                x: pos.x,
                y: pos.y,
                disposition: _numberOr(doc?.disposition ?? combatant?.disposition, 0),
                hidden: doc?.hidden === true,
                destroyed: doc?.destroyed === true,
                defeated: combatant?.defeated === true
            });
        }
    }
    const byKey = new Map(rows.map(row => [_scanTokenKey(row), row]));
    for (const member of members ?? []) {
        const doc = _tokenDoc(member?.combatant?.token);
        const pos = _memberCenter(member, gridSize);
        if (!pos) continue;
        const row = {
            tokenUuid: doc?.uuid ?? null,
            tokenId: member?.tokenId ?? doc?.id ?? null,
            x: pos.x,
            y: pos.y,
            disposition: _numberOr(doc?.disposition ?? member?.combatant?.disposition ?? member?.disposition, 0),
            hidden: doc?.hidden === true,
            destroyed: doc?.destroyed === true,
            defeated: member?.defeated === true
        };
        const key = _scanTokenKey(row);
        if (!byKey.has(key)) byKey.set(key, row);
    }
    return [...byKey.values()].sort((a, b) => _scanTokenKey(a).localeCompare(_scanTokenKey(b)));
}

/**
 * Unwrap a Wall placeable to its document.
 * @param {*} wall
 * @returns {object|null}
 */
function _wallDoc(wall) {
    return wall?.document ?? wall ?? null;
}

/**
 * Whether a plain wall document blocks the requested sense.
 * @param {object} doc
 * @param {string} sense
 * @returns {boolean}
 */
function _wallBlocks(doc, sense) {
    if (!doc || typeof doc !== "object") return false;
    const doorState = doc.door?.state ?? doc.doorState ?? doc.ds;
    if (doorState === "open" || doorState === 1) return false;
    const field = doc[sense];
    if (field === null || field === undefined) return false;
    if (typeof field === "number") return field > 0;
    if (typeof field === "object") {
        if (field.enabled === false) return false;
        return field.type !== "none" && field.type !== 0;
    }
    return false;
}

/**
 * Wall endpoints as a segment.
 * @param {object} doc
 * @returns {{A: object, B: object}|null}
 */
function _wallSegment(doc) {
    const coords = doc?.c ?? doc?.coords ?? null;
    if (Array.isArray(coords) && coords.length >= 4 && coords.slice(0, 4).every(Number.isFinite)) {
        return {
            A: { x: coords[0], y: coords[1] },
            B: { x: coords[2], y: coords[3] }
        };
    }
    if (_isPoint(doc?.A) && _isPoint(doc?.B)) {
        return { A: { x: doc.A.x, y: doc.A.y }, B: { x: doc.B.x, y: doc.B.y } };
    }
    return null;
}

/**
 * Cross-product direction of segment `a → b` toward point `p`.
 * @param {object} a
 * @param {object} b
 * @param {object} p
 * @returns {number}
 */
function _cross(a, b, p) {
    return ((b.x - a.x) * (p.y - a.y)) - ((b.y - a.y) * (p.x - a.x));
}

/**
 * Whether point `p` lies on a collinear segment `a → b`.
 * @param {object} a
 * @param {object} b
 * @param {object} p
 * @returns {boolean}
 */
function _onSegment(a, b, p) {
    return p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x)
        && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
}

/**
 * Inclusive 2D segment intersection test.
 * @param {object} p1
 * @param {object} p2
 * @param {object} p3
 * @param {object} p4
 * @returns {boolean}
 */
function _segmentsIntersect(p1, p2, p3, p4) {
    const d1 = _cross(p3, p4, p1);
    const d2 = _cross(p3, p4, p2);
    const d3 = _cross(p1, p2, p3);
    const d4 = _cross(p1, p2, p4);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
        && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
        return true;
    }
    if (d1 === 0 && _onSegment(p3, p4, p1)) return true;
    if (d2 === 0 && _onSegment(p3, p4, p2)) return true;
    if (d3 === 0 && _onSegment(p1, p2, p3)) return true;
    if (d4 === 0 && _onSegment(p1, p2, p4)) return true;
    return false;
}

/**
 * Plain wall documents available for the movement probe; no canvas fallback.
 * @param {object} context
 * @param {object|null} combat
 * @param {object|null} scene
 * @returns {object[]}
 */
function _wallsOf(context, combat, scene) {
    if (Array.isArray(context.walls)) {
        return context.walls.map(_wallDoc).filter(Boolean);
    }
    const source = scene ?? context.scene ?? combat?.scene ?? null;
    return _list(source?.walls).map(_wallDoc).filter(Boolean);
}

/**
 * Count movement-blocking walls crossed by a straight probe.
 * @param {object|null} from
 * @param {object|null} to
 * @param {object[]} walls
 * @returns {number}
 */
function _moveWallsCrossed(from, to, walls) {
    if (!_isPoint(from) || !_isPoint(to)) return 0;
    let count = 0;
    for (const doc of walls ?? []) {
        if (!_wallBlocks(doc, "move")) continue;
        const segment = _wallSegment(doc);
        if (segment && _segmentsIntersect(from, to, segment.A, segment.B)) count += 1;
    }
    return count;
}

/**
 * Centroid of finite points.
 * @param {object[]} points
 * @returns {{x: number, y: number}|null}
 */
function _centroid(points) {
    let x = 0;
    let y = 0;
    let count = 0;
    for (const point of points ?? []) {
        if (!_isPoint(point)) continue;
        x += point.x;
        y += point.y;
        count += 1;
    }
    return count ? { x: x / count, y: y / count } : null;
}

/**
 * Median of positive numbers (average of the two middle values when even).
 * @param {number[]} values
 * @returns {number|null}
 */
function _median(values) {
    const sorted = (values ?? []).filter(value => Number.isFinite(value) && value > 0)
        .sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Longest non-excluded weapon range of one capability report.
 * @param {object} report Result of {@link scanSuppressionCapability}.
 * @returns {number}
 */
function _bestWeaponRange(report) {
    let best = 0;
    for (const weapon of report?.weapons ?? []) {
        if (weapon.reasons.includes("not-ranged")) continue;
        best = Math.max(best, _numberOr(weapon.range, 0));
    }
    return best;
}

/**
 * Evaluate the measurable bound need of the team: distance beyond the median
 * member weapon range, a movement-blocked frontal probe, or an explicit
 * flank/lane objective hint.
 * @param {object} input
 * @param {object[]} input.members Available member entries.
 * @param {Map} input.capabilityById Member id → capability report.
 * @param {string|null} input.leaderId
 * @param {object[]} input.targetEntries Non-hidden target records.
 * @param {object|null} input.objective Tactic/objective input.
 * @param {object} input.context Planning context.
 * @param {object|null} input.combat Combat document (scene geometry only).
 * @param {object|null} input.scene Scene geometry.
 * @param {number} input.gridSize Grid size in pixels.
 * @param {number} input.pxPerUnit Pixels per scene unit.
 * @returns {{boundNeed: boolean, details: object}}
 */
function _assessBoundNeed({ members, capabilityById, leaderId, targetEntries,
    objective, context, combat, scene, gridSize, pxPerUnit }) {
    const positions = members.map(member => _memberCenter(member, gridSize)).filter(Boolean);
    const teamCenter = _centroid(positions);
    const targetCenter = _centroid(targetEntries);
    const ranges = members.map(member => _bestWeaponRange(capabilityById.get(member.combatantId)))
        .filter(range => range > 0);
    const medianRange = _median(ranges);
    const medianRangePx = medianRange === null ? null : medianRange * pxPerUnit;
    const distancePx = teamCenter && targetCenter ? _distPx(teamCenter, targetCenter) : null;
    const distanceBeyondMedianRange = Number.isFinite(distancePx) && Number.isFinite(medianRangePx)
        ? distancePx > medianRangePx + EPSILON
        : false;
    const leader = members.find(member => member.combatantId === leaderId) ?? members[0] ?? null;
    const leaderPos = leader ? _memberCenter(leader, gridSize) : null;
    const frontalBlocked = typeof context.frontalBlocked === "boolean"
        ? context.frontalBlocked
        : _moveWallsCrossed(leaderPos, targetCenter, _wallsOf(context, combat, scene)) > 0;
    const flankPoint = _copyPoint(objective?.flankPoint);
    const lanePoint = _copyPoint(objective?.lanePoint);
    const explicitManeuverObjective = flankPoint !== null || lanePoint !== null;
    const boundNeed = distanceBeyondMedianRange || frontalBlocked || explicitManeuverObjective;
    return {
        boundNeed,
        details: {
            distanceBeyondMedianRange,
            frontalBlocked,
            explicitManeuverObjective,
            distancePx: Number.isFinite(distancePx) ? _round(distancePx) : null,
            medianRange: medianRange === null ? null : _round(medianRange),
            medianRangePx: Number.isFinite(medianRangePx) ? _round(medianRangePx) : null,
            teamCenter: teamCenter ? { x: _round(teamCenter.x), y: _round(teamCenter.y) } : null,
            targetCenter: targetCenter ? { x: _round(targetCenter.x), y: _round(targetCenter.y) } : null,
            flankPoint,
            lanePoint
        }
    };
}

/**
 * Deterministic weighted suppression-cone adapter. It mirrors the direction
 * search of the planner (`_tokenInCone` geometry, hostile-bearing and
 * short-arc midpoint candidates, strict friendly/neutral veto) but scores
 * anchors by weight instead of raw count so last-known contacts count as 0.5.
 * All geometry inputs are plain data; LOS is optional injected behaviour.
 * @param {object} input
 * @param {object} input.origin Cone origin `{x, y}` in pixel centres.
 * @param {number} input.rangePx Cone length in pixels.
 * @param {number} [input.angleDeg] Full cone angle.
 * @param {object[]} [input.tokens] Scene-token scan for the safety veto.
 * @param {object[]} [input.anchors] Perceived hostile anchors with `weight`.
 * @param {number} [input.viewerDisposition] Firing token disposition.
 * @param {boolean} [input.includeNeutral] Neutral tokens are valid hostiles.
 * @param {number[]|null} [input.dispositions] Explicit hostile dispositions.
 * @param {string|number|null} [input.selfTokenId] Firing token id.
 * @param {string|null} [input.selfTokenUuid] Firing token UUID.
 * @param {object|null} [input.tokenDoc] Firing token document for LOS probes.
 * @param {object|null} [input.perception] Injected LOS service.
 * @param {boolean} [input.requireLos] Require LOS to at least one anchor.
 * @returns {object|null} `{direction, hits, coverage, covered}` or null.
 */
export function findBestSuppressionCone({ origin, rangePx, angleDeg = SUPPRESSION_CONE_DEG,
    tokens = [], anchors = [], viewerDisposition = 0, includeNeutral = false, dispositions = null,
    selfTokenId = null, selfTokenUuid = null, tokenDoc = null, perception = null,
    requireLos = true } = {}) {
    if (!_isPoint(origin) || !(rangePx > 0) || !(angleDeg > 0)) return null;
    const hostileOptions = {
        includeNeutral: includeNeutral === true,
        dispositions: Array.isArray(dispositions) ? dispositions : null
    };
    const anchorList = (anchors ?? []).filter(anchor => _isPoint(anchor)
        && _numberOr(anchor.weight, 1) > 0
        && (!Number.isFinite(anchor.disposition)
            || _hostileTo(viewerDisposition, anchor.disposition, hostileOptions)));
    if (!anchorList.length) return null;
    const bearings = anchorList
        .map(anchor => _bearingTo(origin, anchor))
        .filter(Number.isFinite);
    if (!bearings.length) return null;
    const directions = new Set(bearings);
    for (let i = 0; i < bearings.length; i++) {
        for (let j = i + 1; j < bearings.length; j++) {
            if (_angleDiffDeg(bearings[i], bearings[j]) <= angleDeg - EPSILON) {
                directions.add(_bearingMidpoint(bearings[i], bearings[j]));
            }
        }
    }
    let best = null;
    for (const direction of [...directions].sort((a, b) => a - b)) {
        const covered = anchorList
            .filter(anchor => _tokenInCone(origin, direction, angleDeg, rangePx, anchor))
            .map(anchor => ({
                tokenUuid: anchor.tokenUuid ?? null,
                tokenId: anchor.tokenId ?? null,
                x: anchor.x,
                y: anchor.y,
                elevation: anchor.elevation ?? null,
                source: anchor.source ?? null,
                weight: _round(_numberOr(anchor.weight, 1))
            }));
        if (!covered.length) continue;
        let blocked = false;
        for (const token of tokens ?? []) {
            if (!_isPoint(token) || token.destroyed === true || token.defeated === true) continue;
            const tokenId = token.tokenId ?? token.id ?? null;
            const tokenUuid = token.tokenUuid ?? token.uuid ?? null;
            if (selfTokenId !== null && selfTokenId !== undefined
                && tokenId !== null && String(tokenId) === String(selfTokenId)) continue;
            if (selfTokenUuid && tokenUuid && String(tokenUuid) === String(selfTokenUuid)) continue;
            if (!_tokenInCone(origin, direction, angleDeg, rangePx, token)) continue;
            const disposition = Math.sign(_numberOr(token.disposition, 0));
            if (!_hostileTo(viewerDisposition, disposition, hostileOptions)) {
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
        const coverage = _round(covered.reduce((sum, entry) => sum + entry.weight, 0));
        const candidate = {
            direction: _round(direction, 6),
            hits: covered.length,
            coverage,
            covered: covered.sort((a, b) => String(a.tokenUuid ?? a.tokenId ?? `${a.x},${a.y}`)
                .localeCompare(String(b.tokenUuid ?? b.tokenId ?? `${b.x},${b.y}`)))
        };
        if (!best || candidate.coverage > best.coverage + EPSILON
            || (Math.abs(candidate.coverage - best.coverage) <= EPSILON && candidate.hits > best.hits)
            || (Math.abs(candidate.coverage - best.coverage) <= EPSILON && candidate.hits === best.hits
                && candidate.direction < best.direction)) {
            best = candidate;
        }
    }
    return best;
}

/**
 * Whether the member already acted. Missing turn-order data is conservative:
 * only an explicit `hasActed === false` makes the member eligible.
 * @param {object} member
 * @returns {boolean}
 */
function _hasActed(member) {
    return member?.hasActed !== false;
}

/**
 * Finite turn index or null; null sorts after every real initiative slot.
 * @param {object} member
 * @returns {number|null}
 */
function _turnIndex(member) {
    return Number.isFinite(member?.turnIndex) ? member.turnIndex : null;
}

/**
 * Compact serializable capability diagnostic for one member.
 * @param {object} member
 * @param {object} report
 * @returns {object}
 */
function _capabilityDiagnostic(member, report) {
    const weapon = report.weapon;
    return {
        id: member.combatantId,
        capable: report.capable,
        reasons: [...report.reasons],
        acted: _hasActed(member),
        turnIndex: _turnIndex(member),
        weaponId: weapon?.itemId ?? null,
        burstMode: weapon?.burstMode ?? null,
        ammoCost: weapon?.ammoCost ?? null,
        clip: weapon?.clip ?? null,
        clipAfter: weapon?.clipAfter ?? null
    };
}

/**
 * Whether any weapon of the report failed only because the full suppression
 * burst does not fit in the clip (not because of class, RoF or jamming).
 * @param {object} report
 * @returns {boolean}
 */
function _hasLowAmmoOnlyFailure(report) {
    return (report?.weapons ?? []).some(weapon => weapon.reasons.includes("low-ammo")
        && !weapon.reasons.includes("not-ranged")
        && !weapon.reasons.includes("no-autofire")
        && !weapon.reasons.includes("jammed"));
}

/**
 * Evaluate the best safe cone of one eligible member.
 * @param {object} input
 * @param {object} input.member
 * @param {object} input.capability
 * @param {object[]} input.anchors
 * @param {object[]} input.tokens
 * @param {object} input.context
 * @param {object} input.config
 * @param {number} input.gridSize
 * @param {number} input.pxPerUnit
 * @returns {object} Internal candidate row (`member` is not serialized).
 */
function _coneCandidate({ member, capability, anchors, tokens, context, config, gridSize, pxPerUnit }) {
    const weapon = capability.weapon;
    const base = {
        member,
        id: member.combatantId,
        turnIndex: _turnIndex(member),
        clipAfter: weapon?.clipAfter ?? null,
        weaponId: weapon?.itemId ?? null,
        coverage: 0,
        cone: null,
        reason: null
    };
    if (!weapon) return { ...base, reason: "no-weapon" };
    const origin = _memberCenter(member, gridSize);
    if (!origin) return { ...base, reason: "no-position" };
    const rangePx = _numberOr(weapon.range, 0) * pxPerUnit;
    if (!(rangePx > 0)) return { ...base, reason: "no-range" };
    const tokenDoc = _tokenDoc(member.combatant?.token);
    const tokenUuid = tokenDoc?.uuid ?? null;
    const cone = findBestSuppressionCone({
        origin,
        rangePx,
        angleDeg: config.coneAngleDeg,
        tokens,
        anchors,
        viewerDisposition: _numberOr(tokenDoc?.disposition ?? member.combatant?.disposition ?? member.disposition, 0),
        includeNeutral: context.includeNeutral === true,
        dispositions: Array.isArray(context.dispositions) ? context.dispositions : null,
        selfTokenId: member.tokenId ?? tokenDoc?.id ?? null,
        selfTokenUuid: tokenUuid,
        tokenDoc,
        perception: context.perception ?? null,
        requireLos: config.requireLos !== false
    });
    if (!cone) return { ...base, reason: "no-safe-cone" };
    return {
        ...base,
        origin,
        rangePx,
        tokenUuid,
        cone,
        coverage: cone.coverage
    };
}

/**
 * Suppressor ordering fixed by the specification: weighted coverage desc,
 * earlier turn asc, clip remaining after the shot desc, stable id asc.
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
function _compareSuppressorCandidates(a, b) {
    if (Math.abs((b.coverage ?? 0) - (a.coverage ?? 0)) > EPSILON) {
        return (b.coverage ?? 0) - (a.coverage ?? 0);
    }
    const turnA = Number.isFinite(a.turnIndex) ? a.turnIndex : Number.POSITIVE_INFINITY;
    const turnB = Number.isFinite(b.turnIndex) ? b.turnIndex : Number.POSITIVE_INFINITY;
    if (turnA !== turnB) return turnA - turnB;
    const clipA = _numberOr(a.clipAfter, Number.NEGATIVE_INFINITY);
    const clipB = _numberOr(b.clipAfter, Number.NEGATIVE_INFINITY);
    if (clipA !== clipB) return clipB - clipA;
    return String(a.id).localeCompare(String(b.id));
}

/**
 * Serializable candidate diagnostic (drops the internal member reference).
 * @param {object} candidate
 * @returns {object}
 */
function _candidateDiagnostic(candidate) {
    return {
        id: candidate.id,
        coverage: candidate.coverage ?? 0,
        hits: candidate.cone?.hits ?? 0,
        turnIndex: candidate.turnIndex ?? null,
        clipAfter: candidate.clipAfter ?? null,
        weaponId: candidate.weaponId ?? null,
        direction: candidate.cone?.direction ?? null,
        reason: candidate.reason ?? null
    };
}

/**
 * Resolve tactic coefficients. `context.suppressAndBound` is the adapter
 * override layer; the explicit `config` argument wins last.
 * @param {object|null} config
 * @param {object} context
 * @returns {object}
 */
function _resolveConfig(config, context = {}) {
    const merged = {
        ...DEFAULT_SUPPRESS_AND_BOUND_CONFIG,
        ...(context.suppressAndBound ?? {}),
        ...(config ?? {})
    };
    const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback;
    const pressure = merged.pressureCancelRatio === null || merged.pressureCancelRatio === false
        ? null
        : positive(merged.pressureCancelRatio, SUPPRESSION_PRESSURE_CANCEL_RATIO);
    return {
        coverageMin: positive(merged.coverageMin, SUPPRESSION_COVERAGE_MIN),
        boundNeedCoverageMin: positive(merged.boundNeedCoverageMin, BOUND_NEED_COVERAGE_MIN),
        lastKnownWeight: Number.isFinite(merged.lastKnownWeight)
            ? Math.max(0, Math.min(1, merged.lastKnownWeight))
            : LAST_KNOWN_WEIGHT,
        pressureCancelRatio: pressure,
        coneAngleDeg: positive(merged.coneAngleDeg, SUPPRESSION_CONE_DEG),
        maxDetachedPhases: Number.isInteger(merged.maxDetachedPhases) && merged.maxDetachedPhases >= 0
            ? merged.maxDetachedPhases
            : DEFAULT_SUPPRESS_AND_BOUND_CONFIG.maxDetachedPhases,
        requireLos: merged.requireLos !== false
    };
}

/**
 * Full diagnostic assessment of the suppress-and-bound trigger. Unlike
 * {@link assessSuppressAndBound}, this function returns an explained object
 * even when the tactic degrades, so preset selectors can surface a stable
 * reason instead of re-scanning the situation.
 * @param {object} input
 * @param {object[]} [input.members] Living member DTOs. Positions are pixel
 *   centres (`center`/`positionIsCenter`) or raw collect-members top-lefts.
 * @param {string|null} [input.leaderId]
 * @param {object[]|null} [input.targets] Shared hostile/contact target list.
 * @param {object|null} [input.objective] Polymorphic objective hints.
 * @param {number} [input.casualties] Additional casualty count.
 * @param {object|null} [input.scene] Plain scene geometry (no canvas lookup).
 * @param {object|null} [input.combat] Plain combat data for scene/token
 *   geometry only; turn order is never read here.
 * @param {object} [input.context] Injected geometry, walls, perception,
 *   objective, cancellation flags and coefficient overrides.
 * @param {object} [input.config] Explicit experimental coefficient overrides.
 * @returns {{selected: boolean, reason: string, descriptor: object|null,
 *   breakdown: object, degradation: object|null}}
 */
export function explainSuppressAndBound({ members = [], leaderId = null, targets = null,
    objective = null, casualties = 0, scene = null, combat = null, context = {}, config = null } = {}) {
    const cfg = _resolveConfig(config, context);
    const gridSize = _gridSize(context, combat, scene);
    const pxPerUnit = _pxPerUnit(context, combat, scene);
    const objectiveInput = objective ?? context.objective ?? null;
    const targetInput = Array.isArray(targets) ? targets
        : (Array.isArray(context.targets) ? context.targets : []);
    const targetData = _prepareTargets(targetInput, cfg.lastKnownWeight);
    const available = [...(members ?? [])]
        .filter(member => member && member.combatantId && member.defeated !== true && member.enabled !== false)
        .sort((a, b) => String(a.combatantId).localeCompare(String(b.combatantId)));
    const capabilityById = new Map(available.map(member => [member.combatantId, scanSuppressionCapability(member)]));
    const capabilityDiagnostics = available.map(member =>
        _capabilityDiagnostic(member, capabilityById.get(member.combatantId)));
    const memberCount = available.length;
    const casualtyCount = Math.max(0, _numberOr(casualties, 0))
        + (members ?? []).filter(member => member?.defeated === true).length;
    const enemyCount = targetData.targetCount;
    const pressure = memberCount > 0 ? enemyCount / memberCount : Number.POSITIVE_INFINITY;
    const suppressionCapable = capabilityDiagnostics.filter(entry => entry.capable).length;
    const acted = capabilityDiagnostics.filter(entry => entry.acted).length;
    const coefficients = {
        coverageMin: cfg.coverageMin,
        boundNeedCoverageMin: cfg.boundNeedCoverageMin,
        lastKnownWeight: cfg.lastKnownWeight,
        pressureCancelRatio: cfg.pressureCancelRatio,
        coneAngleDeg: cfg.coneAngleDeg,
        maxDetachedPhases: cfg.maxDetachedPhases,
        requireLos: cfg.requireLos
    };
    const baseBreakdown = () => ({
        coefficients,
        members: memberCount,
        enemies: enemyCount,
        casualties: casualtyCount,
        pressure: Number.isFinite(pressure) ? _round(pressure) : null,
        acted,
        suppressionCapable,
        eligible: 0,
        pinnedExcluded: targetData.pinnedExcluded,
        hiddenExcluded: targetData.hiddenExcluded,
        coverableTargets: targetData.anchors.length,
        capability: capabilityDiagnostics
    });
    const finishFailure = (reason, extra = {}) => ({
        selected: false,
        reason,
        descriptor: null,
        degradation: { reason },
        breakdown: { ...baseBreakdown(), ...extra }
    });

    if (memberCount < 2) return finishFailure("insufficient-members");
    if (context.regroup === true || context.forcedRegroup === true) return finishFailure("forced-regroup");
    if (casualtyCount > 0) return finishFailure("casualties");
    if (cfg.pressureCancelRatio !== null && pressure >= cfg.pressureCancelRatio - EPSILON) {
        return finishFailure("overwhelming-threat");
    }

    const capableMembers = available.filter(member => capabilityById.get(member.combatantId)?.capable === true);
    const eligibleMembers = capableMembers.filter(member => _hasActed(member) === false);
    if (!eligibleMembers.length) {
        const anyCapableActed = capableMembers.some(member => _hasActed(member) === true);
        const lowAmmo = available.some(member => _hasActed(member) === false
            && _hasLowAmmoOnlyFailure(capabilityById.get(member.combatantId)));
        const reason = anyCapableActed ? "suppressor-acted" : (lowAmmo ? "low-ammo" : "no-suppressor");
        return finishFailure(reason, {
            eligible: 0,
            suppressorRejects: capabilityDiagnostics.filter(entry => entry.acted || !entry.capable)
        });
    }

    if (!targetData.anchors.length) {
        const reason = targetData.pinnedExcluded > 0 ? "all-pinned" : "no-coverable-targets";
        return finishFailure(reason, { eligible: eligibleMembers.length });
    }

    const tokens = _sceneTokens({ members: available, combat, context, gridSize });
    const candidates = eligibleMembers.map(member => _coneCandidate({
        member,
        capability: capabilityById.get(member.combatantId),
        anchors: targetData.anchors,
        tokens,
        context,
        config: cfg,
        gridSize,
        pxPerUnit
    }));
    const candidateDiagnostics = candidates.map(_candidateDiagnostic);
    const viable = candidates.filter(candidate => candidate.cone).sort(_compareSuppressorCandidates);
    const eligibleCount = eligibleMembers.length;
    if (!viable.length) {
        return finishFailure("no-safe-cone", {
            eligible: eligibleCount,
            candidates: candidateDiagnostics
        });
    }

    const best = viable[0];
    const targetEntries = targetData.entries.filter(entry => entry.hidden !== true);
    const bound = _assessBoundNeed({
        members: available,
        capabilityById,
        leaderId,
        targetEntries,
        objective: objectiveInput,
        context,
        combat,
        scene,
        gridSize,
        pxPerUnit
    });
    const coverageRule = best.coverage >= cfg.coverageMin - EPSILON
        ? "coverage-min"
        : (bound.boundNeed && best.coverage >= cfg.boundNeedCoverageMin - EPSILON ? "bound-need" : null);
    if (!coverageRule) {
        return finishFailure("coverage-insufficient", {
            eligible: eligibleCount,
            suppressorId: best.id,
            coverage: best.coverage,
            boundNeed: bound.boundNeed,
            boundNeedDetails: bound.details,
            candidates: candidateDiagnostics
        });
    }

    const boundMembers = available.filter(member => member.combatantId !== best.id
        && _hasActed(member) === false);
    if (!boundMembers.length) {
        return finishFailure("no-bound-element", {
            eligible: eligibleCount,
            suppressorId: best.id,
            coverage: best.coverage,
            boundNeed: bound.boundNeed,
            boundNeedDetails: bound.details,
            candidates: candidateDiagnostics
        });
    }

    const firstCovered = best.cone.covered[0] ?? null;
    const targetId = firstCovered?.tokenId ?? firstCovered?.tokenUuid ?? null;
    const targetUuid = firstCovered?.tokenUuid ?? null;
    const targetPoint = firstCovered ? { x: firstCovered.x, y: firstCovered.y } : null;
    const flankPoint = _copyPoint(objectiveInput?.flankPoint);
    const lanePoint = _copyPoint(objectiveInput?.lanePoint);
    const suppressionCone = {
        x: _round(best.origin.x),
        y: _round(best.origin.y),
        direction: best.cone.direction,
        angleDeg: cfg.coneAngleDeg,
        rangePx: _round(best.rangePx),
        burstMode: capabilityById.get(best.id)?.weapon?.burstMode ?? null,
        coveredTokenUuids: best.cone.covered.map(entry => entry.tokenUuid).filter(Boolean)
    };
    const copyMemberObjective = () => ({
        type: SUPPRESS_AND_BOUND,
        targetId,
        targetUuid,
        targetPoint: _copyPoint(targetPoint),
        flankPoint: _copyPoint(flankPoint),
        lanePoint: _copyPoint(lanePoint)
    });
    const boundTask = context.boundTask === "flank" || flankPoint ? "flank" : "advance";
    const assignments = {};
    for (const member of available) {
        if (_hasActed(member) !== false) continue;
        if (member.combatantId === best.id) {
            assignments[member.combatantId] = {
                task: "support",
                role: "suppressor",
                element: "fire",
                objective: copyMemberObjective()
            };
        } else {
            assignments[member.combatantId] = {
                task: boundTask,
                role: "bound",
                element: "maneuver",
                objective: copyMemberObjective()
            };
        }
    }
    const exclusionZone = {
        x: suppressionCone.x,
        y: suppressionCone.y,
        direction: suppressionCone.direction,
        angleDeg: suppressionCone.angleDeg,
        rangePx: suppressionCone.rangePx,
        ownerId: best.id,
        kind: "suppression"
    };
    const winningWeapon = capabilityById.get(best.id)?.weapon ?? null;
    const cone = {
        ...suppressionCone,
        coveredTokenUuids: [...suppressionCone.coveredTokenUuids],
        weaponId: winningWeapon?.itemId ?? null,
        weaponName: winningWeapon?.name ?? null,
        itemUuid: winningWeapon?.itemUuid ?? null,
        ammoCost: winningWeapon?.ammoCost ?? null,
        clipAfter: winningWeapon?.clipAfter ?? null,
        coverage: best.coverage,
        hits: best.cone.hits,
        covered: best.cone.covered.map(entry => ({ ...entry }))
    };
    const reason = bound.boundNeed ? "coverage-and-bound-need" : "coverage-threshold";
    const breakdown = {
        ...baseBreakdown(),
        eligible: eligibleCount,
        suppressorId: best.id,
        coverage: best.coverage,
        hits: best.cone.hits,
        boundNeed: bound.boundNeed,
        boundNeedDetails: bound.details,
        ammoCost: winningWeapon?.ammoCost ?? null,
        burstMode: winningWeapon?.burstMode ?? null,
        candidates: candidateDiagnostics,
        coverageRule
    };
    const descriptor = {
        name: SUPPRESS_AND_BOUND,
        reason,
        assignments,
        allowFlank: false,
        regroup: false,
        suppressorId: best.id,
        coverage: best.coverage,
        boundNeed: bound.boundNeed,
        cone,
        exclusionZone,
        exclusionZones: [{ ...exclusionZone }],
        objective: {
            type: SUPPRESS_AND_BOUND,
            targetId,
            targetUuid,
            targetPoint,
            suppressionCone,
            flankPoint,
            lanePoint
        },
        maxDetachedPhases: cfg.maxDetachedPhases,
        breakdown,
        diagnostics: {
            coefficients,
            coverageRule,
            trigger: {
                coverage: best.coverage,
                coverageMin: cfg.coverageMin,
                boundNeedCoverageMin: cfg.boundNeedCoverageMin,
                boundNeed: bound.boundNeed
            },
            candidates: candidateDiagnostics
        }
    };
    return {
        selected: true,
        reason,
        descriptor,
        breakdown,
        degradation: null
    };
}

/**
 * Pure deterministic suppress-and-bound selector. It returns the serializable
 * tactic descriptor when every trigger passes and `null` otherwise; use
 * {@link explainSuppressAndBound} when the caller needs the stable degradation
 * reason (`no-suppressor`, `low-ammo`, `suppressor-acted`, `no-safe-cone`,
 * `coverage-insufficient`, `all-pinned`, `no-bound-element`, …).
 * @param {object} input See {@link explainSuppressAndBound}.
 * @returns {object|null} JSON-serializable tactic descriptor or null.
 */
export function assessSuppressAndBound(input = {}) {
    return explainSuppressAndBound(input).descriptor;
}
