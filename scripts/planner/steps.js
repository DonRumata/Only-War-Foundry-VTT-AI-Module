/**
 * Planner decomposition (issue #403 follow-up): this module was extracted
 * verbatim from scripts/planner.js — see that file for the design contract.
 * The planner service re-exports the public surface so existing importers
 * and tests keep working.
 */
import {
    _actionBlastRadius,
    _actionCost,
    _actionRange
} from "./actions.js";
import {
    ACTION_BUDGET_HALVES,
    ATTACK_VARIANTS,
    OVERWATCH_CONE_DEG
} from "./contract.js";
import {
    _finiteOr
} from "./util.js";


/**
 * Serialize a plan candidate variant into executable action steps.
 * @param {object} input Step input.
 * @param {object} input.candidate Winning scored candidate.
 * @param {number|null} [input.carriedAim] Aim bonus carried by the
 *   combatant `aim` flag from a previous turn; attached to attack steps.
 * @param {number|null} [input.halfMoveLimit] Half-move rate in scene
 *   units — standalone moves past it cost a full action (issue #31).
 * @returns {object[]}
 */
export function _stepsFor({ candidate, carriedAim = null, halfMoveLimit = null }) {
    const steps = [];
    const { target, move, action, variant } = candidate;
    // Issue #15: an `aim` step books the aim bonus — for `aim-attack`
    // plans it is consumed by the attack step of the same turn, for a
    // standalone `aim` variant the executor persists it on the combatant
    // flag until the next attack (aimedUntil).
    if (variant === "aim-attack" || variant === "aim") {
        steps.push({
            id: `step-aim-${steps.length + 1}`,
            type: "aim",
            cost: { halves: variant === "aim" ? _actionCost(action) : 1 },
            input: {
                actionId: action?.id ?? null,
                name: action?.name ?? "Aim",
                aim: candidate.aimBonus ?? action?.aim ?? 10
            },
            preconditions: ["turn"],
            projectedResourceDelta: {}
        });
    }
    if (move && !move.stay) {
        // Issue #31: charge folds its movement into the attack's full
        // action (0 here); a bundled move costs one half; a standalone
        // move beyond the half-move rate costs a full action; a run is
        // always the whole action economy however short the sprint.
        const moveHalves = variant === "charge" ? 0
            : variant === "run" ? 2
                : (candidate.action === null || candidate.action === undefined)
                    ? (halfMoveLimit !== null && _finiteOr(move.cost, 0) > halfMoveLimit ? 2 : 1)
                    : 1;
        steps.push({
            id: `step-move-${steps.length + 1}`,
            type: "move",
            cost: { movement: _finiteOr(move.cost, 0), halves: moveHalves },
            input: {
                to: { x: move.x, y: move.y, i: move.i, j: move.j },
                waypoints: move.waypoints ?? [],
                approximate: move.approximate === true,
                // `run` rides the step so the executor can stamp the
                // +20-evasion marker after the sprint lands.
                ...(variant === "run" ? { mode: "run" } : {})
            },
            preconditions: ["turn", "self-position", "collision"],
            projectedResourceDelta: { movement: -(_finiteOr(move.cost, 0)) }
        });
    }
    const attacks = action && target && ATTACK_VARIANTS.has(variant);
    if (attacks) {
        const rememberedBlast = candidate.aim && target.canAttack !== true;
        steps.push({
            id: `step-${action.type === "attack" ? "attack" : "test"}-${steps.length + 1}`,
            type: action.type === "attack" ? "attack" : "test",
            cost: { halves: _actionCost(action) },
            input: {
                actionId: action.id,
                name: action.name,
                itemUuid: action.itemUuid,
                targetTokenUuid: rememberedBlast ? null : target.tokenUuid,
                targetTokenId: rememberedBlast ? null : target.tokenId,
                range: _actionRange(action),
                ...(action.attackType ? { attackType: action.attackType } : {}),
                ...(variant === "charge" ? { mode: "charge" } : {}),
                ...(candidate.aimBonus != null
                    ? { aim: candidate.aimBonus }
                    : (Number.isFinite(carriedAim) ? { aim: carriedAim } : {})),
                ...(candidate.aim
                    ? {
                        targetPoint: { x: candidate.aim.x, y: candidate.aim.y },
                        // Issue #29: the blast radius rides along so the
                        // GM overlay (and the system template layer) can
                        // draw the strike zone without re-resolving the
                        // weapon profile.
                        blastRadius: _actionBlastRadius(action)
                    }
                    : {}),
                ...(candidate.cone
                    ? {
                        template: {
                            direction: candidate.cone.direction,
                            angle: candidate.cone.spec?.angle ?? null,
                            range: _actionRange(action)
                        },
                        covered: candidate.cone.covered.map(entry => entry.tokenUuid),
                        ...(candidate.cone.spec?.suppression
                            ? {
                                suppressionFire: true,
                                burstMode: candidate.cone.spec.burstMode
                            }
                            : {})
                    }
                    : {})
            },
            preconditions: ["turn", "target", "resources"],
            projectedResourceDelta: action.type === "attack" ? { ammo: -1 } : {}
        });
    }
    // Issue #15: `reload` executes through `api.actions.reload`; the step
    // carries the weapon reference — the system picks the magazine swap
    // when `magazineItemId` is left unset.
    if (variant === "reload" || variant === "move-reload") {
        steps.push({
            id: `step-reload-${steps.length + 1}`,
            type: "reload",
            cost: { halves: _actionCost(action) },
            input: {
                actionId: action.id,
                name: action.name,
                weaponId: action.itemId ?? null,
                itemUuid: action.itemUuid ?? null,
                spans: action.spans ?? null
            },
            preconditions: ["turn", "resources"],
            projectedResourceDelta: {}
        });
    }
    // Issue #15: `overwatch` declares a GM-rendered zone through the
    // overwatch service (issue #14); no roll is made. Issue #54: the
    // zone descriptor follows the weapon geometry — a watch cone
    // (`direction`/`arc`/`range`, arc from `_coneSpecOf` for spray) or a
    // blast trigger circle (`shape:"blast"` + `targetPoint`/
    // `blastRadius`, matching the attack-step contract so the plan
    // overlay draws it without a new reader).
    if (variant === "overwatch") {
        const zone = candidate.zone ?? null;
        steps.push({
            id: `step-overwatch-${steps.length + 1}`,
            type: "overwatch",
            cost: { halves: ACTION_BUDGET_HALVES },
            input: {
                actionId: action.id,
                name: action.name,
                weaponId: action.itemId ?? null,
                itemUuid: action.itemUuid ?? null,
                attackType: action.attackType ?? "standard",
                ...(zone?.shape === "blast"
                    ? {
                        shape: "blast",
                        targetPoint: { x: zone.targetPoint.x, y: zone.targetPoint.y },
                        blastRadius: zone.blastRadius,
                        range: _actionRange(action)
                    }
                    : {
                        direction: zone?.direction ?? candidate.direction,
                        arc: zone?.arc ?? OVERWATCH_CONE_DEG,
                        range: _actionRange(action)
                    }),
                targetTokenUuid: target?.tokenUuid ?? null
            },
            preconditions: ["turn"],
            projectedResourceDelta: {}
        });
    }
    // Issue #37: `ready-weapon` draws/equips the alternative weapon —
    // free action when the system prices it so (Quick Draw), a half
    // action otherwise. Execution goes through
    // `api.actions.readyWeapon` when the system exposes it.
    if (variant === "ready-weapon") {
        steps.push({
            id: `step-ready-weapon-${steps.length + 1}`,
            type: "ready-weapon",
            cost: { halves: _actionCost(action) },
            input: {
                actionId: action.id,
                name: action.name,
                weaponId: action.itemId ?? null,
                itemUuid: action.itemUuid ?? null
            },
            preconditions: ["turn", "resources"],
            projectedResourceDelta: {}
        });
    }
    // Issue #39: `unpin` is the DH2e full-action Willpower test clearing
    // the pinned status. The verified `prepareTest` contract takes
    // `type` + `key`; the step also carries the descriptive
    // `characteristic`/`testKind` pair so the plan stays readable.
    if (variant === "unpin") {
        steps.push({
            id: `step-test-${steps.length + 1}`,
            type: "test",
            cost: { halves: _actionCost(action) },
            input: {
                actionId: action?.id ?? "unpin",
                name: action?.name ?? "Unpin",
                type: "characteristic",
                key: "willpower",
                characteristic: action?.characteristic ?? "willpower",
                testKind: action?.testKind ?? "characteristic"
            },
            preconditions: ["turn"],
            projectedResourceDelta: {}
        });
    }
    // Issue #37: `drop-prone` is the free-action cover answer to pinning
    // and suppression fire — executor toggles the prone status.
    if (variant === "drop-prone") {
        steps.push({
            id: `step-drop-prone-${steps.length + 1}`,
            type: "drop-prone",
            cost: { halves: 0 },
            input: { statusId: "prone" },
            preconditions: ["turn"],
            projectedResourceDelta: {}
        });
    }
    // Issue #38: `order` serializes as a regular `test` step —
    // `type:"skill"`, `key:"command"` — carrying the order identity
    // (`orderId`/`orderType`/`orderBenefit`) so the executor can
    // post-stamp `lastOrder` after a successful roll and `flags.isOrder`
    // reaches the roll card.
    if (variant === "order") {
        steps.push({
            id: `step-test-${steps.length + 1}`,
            type: "test",
            cost: { halves: _actionCost(action) },
            input: {
                actionId: action?.id ?? null,
                name: action?.name ?? null,
                type: "skill",
                key: action?.key ?? "command",
                skill: action?.skill ?? "command",
                characteristic: action?.characteristic ?? null,
                orderId: action?.orderId ?? null,
                orderType: action?.orderType ?? null,
                orderBenefit: action?.benefit ?? null,
                flags: { ...(action?.flags ?? {}), isOrder: true }
            },
            preconditions: ["turn"],
            projectedResourceDelta: {}
        });
    }
    steps.push({
        id: `step-end-turn-${steps.length + 1}`,
        type: "end-turn",
        cost: {},
        input: attacks ? {} : { reason: variant === "hold" ? "hold-position" : "no-attack" },
        preconditions: ["turn"],
        projectedResourceDelta: {}
    });
    return steps;
}
