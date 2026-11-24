/**
 * Planner decomposition (issue #403 follow-up): this module was extracted
 * verbatim from scripts/planner.js — see that file for the design contract.
 * The planner service re-exports the public surface so existing importers
 * and tests keep working.
 */
import {
    DEFAULT_DODGE_TN,
    DEFAULT_MAX_ACTIONS,
    DEFAULT_MELEE_RANGE,
    EXCLUDED_ATTACK_TYPES,
    MAX_ATTACK_TYPES_PER_WEAPON,
    MAX_DODGE_CHANCE,
    MELEE_ATTACK_TYPE_ORDER,
    RANGED_ATTACK_TYPE_ORDER
} from "./contract.js";
import {
    _expectedDamage,
    _finiteOr,
    _list
} from "./util.js";
import {
    _coneSpecOf
} from "./zones.js";


/**
 * Attack range of an action spec in scene units; melee defaults to
 * {@link DEFAULT_MELEE_RANGE}.
 * @param {object} action Normalized action candidate.
 * @returns {number}
 */
export function _actionRange(action) {
    const raw = action?.range;
    const value = Number.isFinite(raw) ? raw : _finiteOr(raw?.value, NaN);
    if (Number.isFinite(value) && value > 0) return value;
    return _isMeleeAction(action) ? DEFAULT_MELEE_RANGE : 0;
}


/**
 * Whether an action candidate is a melee attack.
 * @param {object|null} action Normalized action candidate.
 * @returns {boolean}
 */
export function _isMeleeAction(action) {
    return action?.melee === true
        || _isChargeAction(action)
        || String(action?.class ?? "").toLowerCase() === "melee";
}


/**
 * Whether an action candidate is an explicit charge attack mode.
 * @param {object|null} action Normalized action candidate.
 * @returns {boolean}
 */
export function _isChargeAction(action) {
    return action?.charge === true || String(action?.mode ?? "").toLowerCase() === "charge";
}


/**
 * Action-economy cost of an action candidate in half-action units
 * (issue #15): `"half"` → 1, `"full"` → 2, `"free"` → 0, numbers and
 * `{halves|actions}` objects pass through, default is one half action.
 * @param {object|null} action Normalized action candidate.
 * @returns {number}
 */
export function _actionCost(action) {
    const cost = action?.cost;
    if (cost === "half") return 1;
    if (cost === "full") return 2;
    if (cost === "free") return 0;
    if (Number.isFinite(cost)) return cost;
    if (cost && typeof cost === "object") {
        if (Number.isFinite(cost.halves)) return cost.halves;
        if (Number.isFinite(cost.actions)) return cost.actions;
    }
    return 1;
}


/**
 * Blast radius of an action in scene units (metres); `0` for regular attacks.
 * @param {object|null} action Normalized action candidate.
 * @returns {number}
 */
export function _actionBlastRadius(action) {
    return _finiteOr(action?.blastRadius, 0);
}


/**
 * Normalize one raw action entry to the action-candidate shape.
 * @param {object} raw
 * @param {number} index Fallback id index.
 * @returns {object|null}
 */
export function _normalizeAction(raw, index) {
    if (!raw || typeof raw !== "object") return null;
    if (raw.available === false) return null;
    const kind = raw.kind ?? raw.type ?? null;
    // Non-attack action kinds (aim/reload) are kept as auxiliary entries —
    // they never become attack candidates (issue #15).
    let type;
    if (kind === "aim" || raw.aim === true) type = "aim";
    else if (kind === "reload") type = "reload";
    // Issue #37 free actions: the system may emit explicit ready/draw
    // entries — their `cost` passes through unchanged (e.g. free under
    // Quick Draw) and lands in the step cost as-is.
    else if (kind === "ready-weapon" || kind === "ready" || kind === "draw"
        || kind === "equip" || raw.ready === true) type = "ready-weapon";
    else if (kind === "attack" || raw.attack === true || raw.itemUuid != null
        || raw.weapon != null || raw.weaponId != null || raw.attackType != null) {
        type = "attack";
    } else if (kind === "test" || kind === null || raw.test === true) type = "test";
    else return null;
    const id = typeof raw.id === "string" && raw.id ? raw.id : `action-${index}`;
    const cls = raw.class ?? raw.system?.class ?? null;
    const attackType = typeof raw.attackType === "string" ? raw.attackType : null;
    return {
        id,
        type,
        attackType,
        name: raw.name ?? raw.weaponName ?? id,
        itemUuid: raw.itemUuid ?? raw.weaponUuid ?? raw.item?.uuid ?? null,
        itemId: raw.itemId ?? raw.weaponId ?? raw.item?.id ?? null,
        class: cls,
        melee: raw.melee === true || String(cls ?? "").toLowerCase() === "melee",
        charge: raw.charge === true || attackType === "charge"
            || String(raw.mode ?? "").toLowerCase() === "charge",
        range: Number.isFinite(raw.range) ? raw.range
            : (Number.isFinite(raw.range?.value) ? raw.range.value
                : (Number.isFinite(raw.system?.range) ? raw.system.range : null)),
        blastRadius: _finiteOr(raw.blastRadius ?? raw.system?.blastRadius
            ?? raw.traits?.blast ?? raw.system?.traits?.blast, 0),
        damage: _expectedDamage(raw.damage ?? raw.system?.damage ?? 0),
        requirements: Array.isArray(raw.requirements) ? raw.requirements.slice() : [],
        spray: raw.spray === true || raw.traits?.spray === true,
        rateOfFire: raw.rateOfFire ?? raw.system?.rateOfFire ?? null,
        aim: Number.isFinite(raw.aim) ? raw.aim
            : (Number.isFinite(raw.modifier) ? raw.modifier : null),
        reload: raw.reload ?? null,
        spans: Number.isFinite(raw.spans) ? raw.spans : null,
        cost: raw.cost ?? null
    };
}


/**
 * Fallback action candidates when the system API is unavailable: one
 * attack per weapon item of the actor.
 * @param {object|null} actor
 * @returns {object[]}
 */
export function _fallbackActions(actor) {
    return _list(actor?.items)
        .filter(item => item?.type === "weapon")
        .map((item, index) => _normalizeAction({
            id: `weapon-${item.id ?? index}`,
            type: "attack",
            name: item.name,
            itemUuid: item.uuid ?? null,
            itemId: item.id ?? null,
            class: item.system?.class ?? null,
            range: item.system?.range ?? null,
            blastRadius: item.system?.blastRadius ?? item.system?.traits?.blast ?? 0,
            damage: item.system?.damage ?? 0
        }, index))
        .filter(Boolean);
}


/**
 * Resolve action candidates: injected `context.actions`, the system API
 * `game.darkHeresy.api.actions.list(actor)` (sync or async), or the
 * weapon-item fallback.
 * @param {object|null} actor
 * @param {object} context
 * @returns {Promise<object[]>}
 */
export async function _resolveActions(actor, context) {
    let raw = null;
    if (Array.isArray(context.actions)) {
        raw = context.actions;
    } else {
        const source = context.actionsApi
            ?? context.actionsProvider
            ?? globalThis.game?.darkHeresy?.api?.actions
            ?? null;
        if (source && typeof source.list === "function") {
            try {
                raw = await Promise.resolve(source.list(actor));
            } catch(err) {
                raw = null;
            }
        }
    }
    if (raw && !Array.isArray(raw) && Array.isArray(raw.actions)) raw = raw.actions;
    let actions = Array.isArray(raw)
        ? raw.map((entry, index) => _normalizeAction(entry, index)).filter(Boolean)
        : [];
    if (!actions.length) actions = _fallbackActions(actor);
    // Enrich normalized entries with the referenced weapon item: the system
    // API action shape carries only weaponId/weaponName, not class/range/
    // damage/uuid вЂ” melee detection and range depend on the item data.
    const itemById = new Map();
    for (const item of _list(actor?.items)) {
        if (item?.id) itemById.set(item.id, item);
    }
    actions = actions.map(action => {
        const item = action.itemId ? itemById.get(action.itemId) : null;
        if (!item) return action;
        const cls = action.class ?? item.system?.class ?? null;
        return {
            ...action,
            itemUuid: action.itemUuid ?? item.uuid ?? null,
            class: cls,
            melee: action.melee || String(cls ?? "").toLowerCase() === "melee",
            range: action.range ?? (Number.isFinite(item.system?.range) ? item.system.range : null),
            blastRadius: action.blastRadius > 0 ? action.blastRadius
                : _finiteOr(item.system?.blastRadius ?? item.system?.traits?.blast, 0),
            spray: action.spray || /spray/i.test(String(item.system?.special ?? "")),
            rateOfFire: action.rateOfFire ?? item.system?.rateOfFire ?? null,
            damage: action.damage > 0 ? action.damage : _expectedDamage(item.system?.damage ?? 0)
        };
    });
    actions = actions
        .sort((a, b) => (b.damage - a.damage)
            || ((_actionRange(b) - _actionRange(a)))
            || String(a.id).localeCompare(String(b.id)));
    // The system API exposes one entry per attack type per weapon
    // (standard/charge/allOut/…) — curate per weapon: keep all available
    // attack types but cap each weapon to MAX_ATTACK_TYPES_PER_WEAPON
    // picks in curated preference order so a multi-type weapon cannot
    // crowd others out under DEFAULT_MAX_ACTIONS. `suppressing_fire` is
    // excluded outright (it needs a targetPoint/template).
    // Injected/custom actions (no attackType) always pass through.
    const apiGroups = new Map();
    const passthrough = [];
    for (const action of actions) {
        if (action.attackType == null) {
            passthrough.push(action);
            continue;
        }
        const key = action.itemUuid ?? action.itemId ?? action.id;
        let group = apiGroups.get(key);
        if (!group) {
            group = [];
            apiGroups.set(key, group);
        }
        group.push(action);
    }
    for (const group of apiGroups.values()) {
        passthrough.push(..._curateAttackTypes(group));
    }
    return passthrough;
}


/**
 * Pick the best attack-type candidates of a single weapon: drop excluded
 * types, order by the curated melee/ranged preference list (unknown types
 * last, stable) and keep at most {@link MAX_ATTACK_TYPES_PER_WEAPON}.
 * @param {object[]} group Normalized actions sharing one weapon.
 * @returns {object[]}
 */
export function _curateAttackTypes(group) {
    const melee = group.some(action => _isMeleeAction(action));
    const order = melee ? MELEE_ATTACK_TYPE_ORDER : RANGED_ATTACK_TYPE_ORDER;
    const rank = new Map(order.map((type, index) => [type, index]));
    return group
        .map((action, index) => ({
            action,
            index,
            rank: rank.has(action.attackType) ? rank.get(action.attackType) : order.length
        }))
        .filter(entry => !EXCLUDED_ATTACK_TYPES.has(entry.action.attackType))
        .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
        // `suppressing_fire` is a distinct role (area denial), not another
        // damage attack type — it always survives the per-weapon cap.
        .filter((entry, position) => position < MAX_ATTACK_TYPES_PER_WEAPON
            || entry.action.attackType === "suppressing_fire")
        .map(entry => entry.action);
}


/**
 * Aim action entries for the action economy (issue #15). When the system
 * API or injected list exposes `kind:"aim"` records they pass through
 * with their own modifier; otherwise the universal Only War defaults are
 * synthesized — half aim (+10, one half action) and full aim (+20, a
 * full action).
 * @param {object[]} actions Normalized action entries.
 * @returns {object[]}
 */
export function _aimActions(actions) {
    const found = (actions ?? []).filter(action => action.type === "aim");
    if (found.length) return found;
    return [
        { id: "aim.half", type: "aim", aim: 10, name: "Aim",
            cost: "half", synthesized: true },
        { id: "aim.full", type: "aim", aim: 20, name: "Aim",
            cost: "full", synthesized: true }
    ];
}


/**
 * Overwatch weapons of the action list (issue #54): at most one pick per
 * zone geometry — the longest-range plain ranged attack (a 45° watch
 * cone), the longest-range spray weapon (its own template cone) and the
 * longest-range blast weapon (a trigger circle). `suppressing_fire`
 * entries are a firing mode of the same gun, not a watch weapon; melee
 * reach circles stay a niche and are deliberately skipped. Deterministic
 * tiebreak by action id inside each geometry pool.
 * @param {object[]} actions Normalized attack actions.
 * @returns {{action: object, kind: "cone"|"spray"|"blast"}[]}
 */
export function _overwatchWeapons(actions) {
    const pools = { cone: [], spray: [], blast: [] };
    for (const action of actions ?? []) {
        if (action.type !== "attack" || _isMeleeAction(action)
            || _actionRange(action) <= 0) continue;
        const spec = _coneSpecOf(action);
        if (spec?.suppression === true) continue;
        if (spec?.spray === true) {
            pools.spray.push(action);
        } else if (_actionBlastRadius(action) > 0) {
            pools.blast.push(action);
        } else {
            pools.cone.push(action);
        }
    }
    const pick = pool => [...pool].sort((a, b) => (_actionRange(b) - _actionRange(a))
        || String(a.id).localeCompare(String(b.id)))[0] ?? null;
    return ["cone", "spray", "blast"]
        .map(kind => (pools[kind].length ? { action: pick(pools[kind]), kind } : null))
        .filter(Boolean);
}


/**
 * Whether a normalized action belongs to a referenced weapon. The
 * reference may be a plain string (item uuid, item id or weapon name —
 * `config.preferredWeapon` and the sheet store whichever the GM picked)
 * or a record carrying those fields (`flags["only-war-ai"].lastUsedWeapon`).
 * @param {object|null} action Normalized action.
 * @param {object|string|null} ref Weapon reference.
 * @returns {boolean}
 */
export function _weaponMatches(action, ref) {
    if (!action || !ref) return false;
    if (typeof ref === "string") {
        const needle = ref.trim();
        if (!needle) return false;
        return [action.itemUuid, action.itemId, action.name]
            .some(entry => String(entry ?? "") === needle);
    }
    if (typeof ref === "object") {
        return [ref.itemUuid, ref.weaponUuid, ref.itemId, ref.weaponId, ref.name]
            .filter(entry => entry != null)
            .some(entry => _weaponMatches(action, entry));
    }
    return false;
}


/**
 * Current clip fill of a weapon item; `null` when the item tracks no
 * clip (melee and simple weapons — they never run dry).
 * @param {object|null} item
 * @returns {number|null}
 */
export function _itemAmmo(item) {
    const clip = item?.system?.clip;
    if (!clip || typeof clip !== "object") return null;
    return _finiteOr(clip.value, null);
}


/**
 * Clip fill of the weapon backing a normalized action; `null` when the
 * weapon item is unreadable or has no clip.
 * @param {object|null} actor
 * @param {object} action Normalized action.
 * @returns {number|null}
 */
export function _weaponClipOf(actor, action) {
    const item = _list(actor?.items).find(entry => entry
        && (entry.id === action?.itemId
            || (action?.itemUuid != null && entry.uuid === action.itemUuid)));
    return _itemAmmo(item);
}


/**
 * Ready-weapon entries for the action economy (issue #37): explicit
 * `kind:"ready"|"draw"|"equip"` records from the system `actions.list`
 * pass through with their own `cost` (free under Quick Draw — the module
 * deliberately does not parse talents, the system prices the entry).
 * Otherwise, when the live attack list is dry — no usable attack/test
 * actions at all, or every usable attack's weapon is out of ammo —
 * inventory weapons backing no usable action become synthesized
 * half-cost ready candidates. A dry or clip-less weapon is always a
 * legal ready target; only weapons whose clip reads `0` are skipped.
 * @param {object} input
 * @param {object[]} input.allActions Every normalized action entry.
 * @param {object|null} input.actor Actor document for the inventory scan.
 * @param {object[]} input.usableActions Usable attack/test actions.
 * @param {boolean} [input.readyCapable] Whether the system actions API
 *   can execute a ready/draw call (issue #53 — synthesized candidates
 *   are not offered when the endpoint is missing; explicit system
 *   entries still pass, the system emitted them).
 * @returns {object[]} Normalized `ready-weapon` entries.
 */
export function _readyWeaponActions({ allActions, actor, usableActions, readyCapable = true }) {
    const explicit = (allActions ?? []).filter(action => action.type === "ready-weapon");
    if (explicit.length) return explicit;
    if (!readyCapable) return [];
    const dry = !(usableActions ?? []).length
        || usableActions.every(action => _weaponClipOf(actor, action) === 0);
    if (!dry) return [];
    const backing = new Set((usableActions ?? []).map(action =>
        action.itemUuid ?? action.itemId ?? action.name ?? action.id));
    return _list(actor?.items)
        .filter(item => item?.type === "weapon"
            && !backing.has(item.uuid ?? item.id ?? item.name))
        .filter(item => {
            const ammo = _itemAmmo(item);
            return ammo === null || ammo > 0;
        })
        .map((item, index) => _normalizeAction({
            id: `ready-${item.id ?? index}`,
            kind: "ready-weapon",
            name: item.name,
            itemUuid: item.uuid ?? null,
            itemId: item.id ?? null,
            class: item.system?.class ?? null,
            damage: item.system?.damage ?? 0,
            cost: "half",
            synthesized: true
        }, index))
        .filter(Boolean)
        .sort((a, b) => (b.damage - a.damage) || String(a.id).localeCompare(String(b.id)))
        .slice(0, DEFAULT_MAX_ACTIONS);
}


/**
 * Synthesized `unpin` action entry (issue #39): the DH2e full-action
 * Willpower test that clears pinning. The candidate only exists when the
 * actor actually has a `willpower` characteristic — `null` otherwise, so
 * the planner can record a `unpin-unavailable` rejection instead.
 * @param {object|null} actor Actor document.
 * @returns {object|null}
 */
export function _unpinAction(actor) {
    const characteristics = actor?.system?.characteristics ?? actor?.characteristics ?? null;
    if (!characteristics || characteristics.willpower == null) return null;
    return {
        id: "unpin",
        type: "test",
        name: "Unpin",
        characteristic: "willpower",
        testKind: "characteristic",
        cost: "full",
        synthesized: true
    };
}


/**
 * Synthesized order action entry (issue #38): a fireteam leader's Command
 * skill test that delivers the order named by the team-supplied
 * `orderCandidate` record `{orderId, name, orderType, benefit, skill?,
 * advanced?}`. The candidate only exists when the actor actually carries
 * the `command` skill — `null` otherwise, so the planner can record an
 * `order-unavailable` rejection instead. Orders cost a half action; an
 * `advanced` order (veteran-tier) is a full action.
 * @param {object|null} actor Actor document.
 * @param {object|null} candidate `context.team.orderCandidate`.
 * @returns {object|null}
 */
export function _orderAction(actor, candidate) {
    if (!candidate || typeof candidate !== "object") return null;
    const skills = actor?.system?.skills ?? actor?.skills ?? null;
    if (!skills || skills.command == null) return null;
    const orderId = candidate.orderId ?? candidate.id ?? null;
    if (orderId == null) return null;
    return {
        id: `order-${orderId}`,
        type: "test",
        name: candidate.name ?? `Order ${orderId}`,
        kind: "skill",
        skill: candidate.skill ?? "command",
        skillKey: candidate.skill ?? "command",
        testKind: "skill",
        key: candidate.skill ?? "command",
        characteristic: candidate.characteristic ?? null,
        orderId,
        orderType: candidate.orderType ?? null,
        benefit: candidate.benefit ?? null,
        flags: { isOrder: true },
        cost: candidate.advanced === true ? "full" : "half",
        synthesized: true
    };
}


/**
 * Dodge model of one (target, action) pair (issue #37 counter-EV):
 * `{dodgeable, chance}` — `chance` is the rough `dodgeTN/100` of the
 * target, capped at {@link MAX_DODGE_CHANCE}. Cone/spray/suppression
 * attacks cannot be dodged; blast attacks only dodge when the target's
 * half-move provably reaches outside the zone (unknown half-move counts
 * as undodgeable — conservative); a target that already spent its
 * reaction this round is defenseless (`chance` 0).
 * @param {object|null} target Normalized target.
 * @param {object|null} action Normalized action.
 * @param {number|null} [dodgeTN] Default dodge TN override
 *   (`context.defaultDodgeTN`).
 * @returns {{dodgeable: boolean, chance: number}}
 */
export function dodgeChanceOf(target, action, dodgeTN = null) {
    if (!action || action.type !== "attack") return { dodgeable: false, chance: 0 };
    if (target?.reactionUsed === true) return { dodgeable: true, chance: 0 };
    if (_coneSpecOf(action)) return { dodgeable: false, chance: 0 };
    const blast = _actionBlastRadius(action);
    if (blast > 0) {
        const escape = _finiteOr(target?.halfMove ?? target?.threatProfile?.halfMove, null);
        if (!(escape > 0 && escape >= blast)) return { dodgeable: false, chance: 0 };
    }
    const tn = _finiteOr(
        target?.dodge ?? target?.threatProfile?.dodge ?? dodgeTN, DEFAULT_DODGE_TN);
    return {
        dodgeable: true,
        chance: Math.max(0, Math.min(MAX_DODGE_CHANCE, tn / 100))
    };
}
