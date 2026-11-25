/**
 * Turn-by-turn execution of a TeamPlan. A draft is scoped to one snapshot;
 * only assignments and verified progress survive the change of initiative.
 */
import { FLAG_KEYS, MODULE_ID } from "../constants.js";
import { movementCells, NAVIGATION_STATUS, offsetKey } from "../navigation.js";
import { isLiveOperation, readOperation } from "../operations.js";
import { isDeadOrDefeated, isHiddenToken } from "../perception.js";
import { _collisionRevision } from "../planner/documents.js";
import { SPEC_OPS_PRESET_ID } from "../presets/spec-ops-config.js";
import { specOpsTokenCenter } from "../presets/spec-ops.js";
import { getSpecOpsConfig } from "../settings.js";
import { _docPoint, _findCombatant, _tokenDoc } from "./util.js";

const MAX_MANEUVER_ROUNDS = 2;

const positionOf = token => ({
    x: token?._source?.x ?? token?.x,
    y: token?._source?.y ?? token?.y,
    elevation: token?._source?.elevation ?? token?.elevation ?? 0
});
const atPosition = (a, b) => Math.abs(a.x - b.x) < 0.5
    && Math.abs(a.y - b.y) < 0.5 && a.elevation === b.elevation;
const statesOf = combat => {
    const value = combat?.getFlag?.(MODULE_ID, FLAG_KEYS.teamManeuvers);
    return Array.isArray(value) ? value.filter(state => state?.id && Array.isArray(state.members)) : [];
};
const beforeTurn = (combat, turn) => combat.round < turn.round
    || (combat.round === turn.round && combat.turn < turn.turn);
const acts = phase => phase === "movement" || phase === "action" || phase === "regroup";
const coordinating = state => state.members.some(member => member.move || member.action);
const movementLocks = (state, member) => state.members
    .filter(other => other !== member && other.move)
    .flatMap(other => other.move.cells ?? [other.move.destination]);
const rejoinLocks = (state, memberId, combat) => state.members
    .filter(other => other.id !== memberId && other.rejoin?.untilRound >= combat.round)
    .flatMap(other => movementCells(_tokenDoc(_findCombatant(combat, other.id)?.token),
        [other.rejoin.point]));
const sameProgress = (a, b) => a?.id === b?.id
    && a?.last?.id === b?.last?.id && a?.inFlight === b?.inFlight;

/**
 * Find a member's next slot, counting turn indices across round boundaries.
 * @param {object} combat Live initiative order, including tie breaks.
 * @param {string} memberId
 * @param {number} [from] Earliest allowed slot.
 * @returns {{index: number, round: number}|null}
 */
function nextTurnSlot(combat, memberId, from = combat.turn) {
    if (!Number.isInteger(from) || from < 0 || !Array.isArray(combat.turns)) return null;
    const order = combat.turns;
    const turn = order.findIndex(entry => entry?.id === memberId);
    if (turn < 0) return null;
    const earliest = from % order.length;
    const index = from - earliest + turn + (turn < earliest ? order.length : 0);
    return { index, round: combat.round + Math.floor(index / order.length) };
}

/**
 * Fit each remaining phase onto actual initiative slots without sharing a
 * turn across phases. Only a member's own planned departure starts its clock.
 * @param {object} state
 * @param {object} combat
 * @returns {boolean}
 */
function fitsSchedule(state, combat) {
    if (!state.members.some(member => member.rejoin)) return true;
    let from = combat.turn;
    const deadlines = new Map();
    for (const phase of ["move", "action", "rejoin"]) {
        let nextPhase = from;
        for (const member of state.members) {
            if (!member[phase]) continue;
            const slot = nextTurnSlot(combat, member.id, from);
            if (!slot || (phase !== "rejoin" && slot.round >= state.expiresRound)) return false;
            if (phase === "move" && member.rejoin) {
                deadlines.set(member.id, slot.round + member.rejoin.maxRounds);
            } else if (phase === "rejoin"
                && !(slot.round <= (member.rejoin.untilRound ?? deadlines.get(member.id)))) return false;
            nextPhase = Math.max(nextPhase, slot.index + 1);
        }
        from = nextPhase;
    }
    return true;
}

/**
 * Drop coordination, but retain legal return turns for members who already left.
 * @param {object} state
 * @param {object} combat
 * @returns {object|null}
 */
function returnOnly(state, combat) {
    const members = state.members.map(member => ({
        ...member, move: null, action: null,
        rejoin: Number.isFinite(member.rejoin?.untilRound)
            && nextTurnSlot(combat, member.id)?.round <= member.rejoin.untilRound ? member.rejoin : null
    }));
    return members.some(member => member.rejoin) ? { ...state, members } : null;
}

/**
 * Validate the approved route, not a substitute route or the draft's old cell.
 * Snapshot validation also checks the scene wall revision and self statuses.
 * @param {object} step
 * @param {object} token
 * @param {object} nav
 * @param {object[]} reservations
 * @returns {boolean}
 */
function validReturnRoute(step, token, nav, reservations) {
    const { to, waypoints = [] } = step.input;
    if (nav?.validateEndpoint?.(token, to, { reservations })?.valid !== true) return false;
    const end = waypoints.at(-1);
    const route = end?.x === to.x && end?.y === to.y ? waypoints : [...waypoints, to];
    const locked = new Set(reservations.map(offsetKey));
    if (movementCells(token, route).some(cell => locked.has(offsetKey(cell)))) return false;
    const measured = nav.measurePath?.(token, route, { reservations });
    // Navigation stores costs to three decimal places; apply the same rounding.
    return measured?.status === NAVIGATION_STATUS.ok
        && Math.round(measured.cost * 1000) / 1000 <= step.cost?.movement
        && measured.waypoints?.length === route.length
        && measured.waypoints.every(({ x, y }, index) =>
            Math.abs(x - route[index].x) < 0.5 && Math.abs(y - route[index].y) < 0.5);
}

/**
 * Coordinate only turns claimed by the normal authority service. No
 * turn advancement, document movements or rolls happen in this layer.
 * @param {object} deps Executor dependencies.
 * @param {Function} deps.service Lazy service lookup.
 * @param {Function} deps.isController Controller predicate.
 * @param {Function} deps.isEnabled Module-enabled predicate.
 * @param {Function} deps.resolveConfig Effective config resolver.
 * @param {Function} deps.log Diagnostic logger.
 * @returns {object}
 */
export function createTeamTurns({ service, isController, isEnabled, resolveConfig, log }) {
    /**
     * Check the authoritative claim again after any await.
     * @param {object} context
     * @param {object} combatant
     * @param {boolean} [executing] Require confirmation before any step.
     * @returns {boolean}
     */
    function ownsTurn(context, combatant, executing = false) {
        const { combat, operation, signal } = context;
        if (!operation?.controllerId || signal?.aborted || !isEnabled() || !isController(context)
            || combat?.ended || combat?.destroyed || !(combat?.round > 0)
            || combat.combatant?.id !== combatant?.id) return false;
        const live = readOperation(combat);
        return isLiveOperation(live) && (!executing || live.phase === "executing") && live.id === operation.id
            && live.combatId === combat.id && live.combatantId === combatant?.id
            && live.controllerId === operation.controllerId
            && live.round === combat.round && live.turn === combat.turn;
    }

    /**
     * Validate progress independently of the turn-scoped draft revision.
     * @param {object} state
     * @param {object} context
     * @param {object|null} [movedMember] Expected position after our own move.
     * @returns {string|null} Invalidation reason.
     */
    function stateReason(state, context, movedMember = null) {
        const { combat, operation } = context;
        const scene = combat.scene;
        if (state.controllerId !== operation?.controllerId) return "controller-changed";
        if ((state.inFlight && state.inFlight !== operation.id)
            || beforeTurn(combat, state.last ?? state)) return "team-turn-interrupted";
        if ((coordinating(state) && combat.round >= state.expiresRound)
            || state.members.some(member => Number.isFinite(member.rejoin?.untilRound)
                && member.rejoin.untilRound < combat.round)) return "team-timeout";
        // Once attacks are done, find the return route against live geometry.
        if (coordinating(state) && _collisionRevision(scene) !== state.collision) return "collision-changed";
        const fireteam = service("fireteam", context.fireteam);
        for (const member of state.members) {
            const live = _findCombatant(combat, member.id);
            const token = _tokenDoc(live?.token);
            if (!token || token.id !== member.tokenId || !resolveConfig(live)?.enabled
                || fireteam?.resolveTeamConfig(live)?.teamId !== state.teamId
                || !Number.isFinite(live?.initiative) || isDeadOrDefeated(token, { combatant: live })) {
                if (member.id === state.leaderId) return "leader-lost";
                return state.required.includes(member.id) ? "sync-broken" : "team-member-unavailable";
            }
            const expected = movedMember?.id === member.id ? movedMember.position : member.position;
            if (!atPosition(positionOf(token), expected)) return "token-moved";
        }
        return null;
    }

    /**
     * Only a member's own live LOS can authorize its action.
     * @param {object} context
     * @param {object} combatant
     * @param {object} plannerContext
     * @returns {object[]} Visible hostile contacts.
     */
    function visible(context, combatant, plannerContext) {
        const viewed = globalThis.canvas?.scene;
        if (viewed && viewed.id !== context.combat.scene?.id) return [];
        const token = _tokenDoc(combatant?.token);
        const perception = service("perception", plannerContext.perception);
        return (perception?.visibleTargets?.(token, {
            combat: context.combat,
            includeNeutral: resolveConfig(combatant)?.includeNeutral === true
        }) ?? []).filter(target => target.tokenId && target.canAttack === true && !target.hidden);
    }

    /**
     * Retain assignments, not executable moves, rolls or old budgets.
     * @param {object} draft TeamPlan.
     * @param {object[]} entries Live team entries.
     * @param {object} context
     * @returns {object|null} Serializable progress record.
     */
    function compile(draft, entries, context) {
        if (!draft?.id || !draft.phases || draft.members.length !== entries.length) return null;
        const movement = draft.phases.find(phase => phase.name === "movement");
        const action = draft.phases.find(phase => phase.name === "action");
        const members = [];
        for (const entry of entries) {
            const id = entry.combatantId;
            const assignment = draft.members.find(member => member.combatantId === id);
            const plan = draft.memberPlans[id];
            if (!assignment || !plan) return null;
            const moveRef = movement?.steps.find(ref => ref.combatantId === id);
            const move = moveRef ? plan.steps[moveRef.stepIndex] : null;
            const to = move?.input?.to;
            const token = _tokenDoc(entry.combatant.token);
            // Lost reservations and bundled charges cannot be replayed
            // as independent moves on an earlier turn.
            if (plan.steps.some(step => step.type === "move") && (!move
                || !Number.isFinite(to?.i) || !Number.isFinite(to?.j) || !(move.cost?.halves > 0))) return null;
            const actionRef = action?.steps.find(ref => ref.combatantId === id);
            const act = actionRef ? plan.steps[actionRef.stepIndex] : null;
            const targetId = act?.input?.targetTokenId;
            const target = plan.snapshot.targets?.find(t => t.tokenId === targetId);
            if (act && !(targetId && target?.canAttack && target.source === "visible")) return null;
            // Setup and other stand-alone actions keep their ordinary turn
            // semantics when this draft cannot express them as a phase.
            if (plan.steps.some(step => step !== move && step !== act
                && step.type !== "end-turn" && !(step.type === "aim" && act))) return null;
            members.push({
                id, tokenId: entry.tokenId, task: assignment.task, groupId: assignment.groupId,
                position: positionOf(token),
                move: move ? { destination: { i: to.i, j: to.j }, mode: move.input.mode ?? null,
                    route: move.input.waypoints, cost: move.cost?.movement, halves: move.cost?.halves,
                    cells: movementCells(token, [...(move.input.waypoints ?? []), to]) } : null,
                action: act ? { type: act.type, targetId, name: act.input.name ?? null,
                    halves: (act.cost?.halves ?? 0) + (plan.steps.find(step => step.type === "aim")?.cost?.halves ?? 0),
                    resources: act.projectedResourceDelta ?? {} } : null,
                separation: assignment.separation ?? null,
                rejoin: assignment.rejoinPoint ? {
                    point: assignment.rejoinPoint, route: assignment.rejoinRoute, cost: assignment.rejoinCost,
                    maxRounds: assignment.maxDetachedRounds, untilRound: null
                } : null
            });
        }
        const required = action?.barrier?.requiredAssignmentIds ?? [];
        if (required.some(id => !members.some(member => member.id === id && member.move))) return null;
        if (members.filter(member => member.move || member.action).length < 2) return null;
        return {
            id: draft.id, teamId: draft.teamId, leaderId: draft.leaderId, tactic: draft.tactic,
            objective: draft.objective ?? null, score: draft.score,
            tacticReason: draft.diagnostics?.tactic?.reason ?? null,
            preferredCohesion: draft.diagnostics?.preferredCohesion,
            character: draft.character, teamPreset: draft.teamPreset,
            ...(draft.specOpsConfig ? { specOpsConfig: draft.specOpsConfig } : {}),
            round: context.combat.round, turn: context.combat.turn,
            expiresRound: context.combat.round + MAX_MANEUVER_ROUNDS,
            controllerId: context.operation.controllerId, collision: _collisionRevision(context.combat.scene),
            required, members, actionStarted: false, last: null, inFlight: null
        };
    }

    /**
     * Plan the current member's legal turn. The draft and first action
     * each carry a same-turn preflight snapshot of the other participants.
     * @param {object} context Executor context of a claimed turn.
     * @param {object} combatant The active NPC.
     * @param {object} planner The registered planner.
     * @param {object} plannerContext Fresh budgets and snapshot overrides.
     * @returns {Promise<object|null>} Null lets the individual planner run.
     */
    async function plan(context, combatant, planner, plannerContext) {
        if (!ownsTurn(context, combatant)) return null;
        const { combat } = context;
        const fireteam = service("fireteam", context.fireteam);
        const cfg = fireteam?.resolveTeamConfig(combatant);
        if (!cfg?.teamId) return null;
        const previous = statesOf(combat).find(state => state?.teamId === cfg.teamId) ?? null;
        let state = previous;
        let preflight = [];
        let base = {
            ...plannerContext, includeNeutral: resolveConfig(combatant)?.includeNeutral === true,
            layers: { ...plannerContext.layers, commitment: false }
        };
        const wrap = (planned, phase, reason = null) => planned?.plan ? {
            ...planned, plan: Object.freeze({
                ...planned.plan, teamTurn: { phase, reason, state, preflight, existing: previous !== null }
            })
        } : planned;
        const wait = async (reason, phase = "wait") => wrap(await planner.planTurn(combat, combatant, {
            ...base, teamTurn: { phase: "wait", reason }
        }), phase, reason);

        if (!state) {
            const entries = fireteam.collectMembers(combat, cfg.teamId).filter(member =>
                member.enabled && !member.defeated && Number.isFinite(member.initiative));
            const teamPreset = cfg.teamPreset ?? entries.find(member => member.team?.teamPreset)?.team.teamPreset
                ?? (entries.length && entries.every(member => member.preset === SPEC_OPS_PRESET_ID)
                    ? SPEC_OPS_PRESET_ID : null);
            const fallback = () => teamPreset === SPEC_OPS_PRESET_ID
                ? planner.planTurn(combat, combatant, {
                    ...base, fallbackPreset: getSpecOpsConfig(base.specOpsConfig).fallbackPreset
                })
                : null;
            if (entries.length < 2) return fallback();
            const targets = new Map();
            for (const member of entries) {
                for (const target of visible(context, member.combatant, base)) {
                    targets.set(target.tokenId, target);
                }
            }
            const draft = (await fireteam.buildTeamPlan(combat, {
                ...cfg, members: entries.map(member => member.combatantId)
            }, {
                ...base, readOnly: true, syncDelay: false,
                teamTurn: { phase: "draft" }, tacticTargets: [...targets.values()]
            }))?.teamPlan;
            if (!ownsTurn(context, combatant)) return null;
            state = compile(draft, entries, context);
            if (!state || !fitsSchedule(state, combat)) return fallback();
            preflight = Object.values(draft.memberPlans).map(memberPlan => memberPlan.snapshot);
        }
        if (state.specOpsConfig) base = { ...base, specOpsConfig: state.specOpsConfig };
        const stopped = stateReason(state, context);
        if (stopped && stopped !== "team-timeout") return wait(stopped, "interrupt");
        let prioritizingReturn = false;
        if (stopped || !fitsSchedule(state, combat)) {
            const returning = returnOnly(state, combat);
            if (!returning || stateReason(returning, context)) return wait("team-timeout", "interrupt");
            state = returning;
            prioritizingReturn = true;
        }
        const active = state.members.find(member => member.id === combatant.id);
        if (!active) return null;
        const center = state.members.find(member => member.id === state.leaderId)?.position;
        const forMember = member => ({
            teamId: state.teamId, task: member.task, groupId: member.groupId,
            character: state.character, leaderId: state.leaderId, center, preset: state.teamPreset,
            ...(member.task === "flank" && state.tactic === "flank-and-fix" && state.specOpsConfig ? {
                flankCenter: specOpsTokenCenter(_tokenDoc(_findCombatant(combat, state.leaderId)?.token),
                    combat.scene, center),
                flankMinAngleDegrees: state.specOpsConfig.flankMinAngleDegrees
            } : {})
        });
        const movers = state.members.filter(member => member.move);
        let ownMove = null;
        for (const member of previous ? movers.filter(member => member === active) : movers) {
            const planned = await planner.planTurn(combat, _findCombatant(combat, member.id), {
                ...base, ...(member === active ? {} : { spent: undefined }),
                team: forMember(member),
                teamTurn: { phase: "movement", ...member.move, reservations: movementLocks(state, member) }
            });
            if (!planned?.plan?.steps.some(step => step.type === "move")) {
                return wait("team-route-unavailable", "interrupt");
            }
            if (member === active) ownMove = planned;
        }
        if (ownMove) return wrap(ownMove, "movement");
        if (!coordinating(state) && active.rejoin) {
            const leader = _tokenDoc(_findCombatant(combat, state.leaderId)?.token);
            const grid = context.combat.scene?.grid;
            const leaderCenter = Number.isFinite(grid?.size) ? {
                x: center.x + ((leader.width ?? 1) * grid.size / 2),
                y: center.y + ((leader.height ?? 1) * grid.size / 2)
            } : null;
            const reservations = rejoinLocks(state, active.id, combat);
            const rejoin = await fireteam.planRejoin(_tokenDoc(combatant.token), leaderCenter, {
                grid, preferredCohesion: state.preferredCohesion, navigation: base.navigation,
                rates: base.rates, reservations
            });
            if (!rejoin) return wait("team-rejoin-unavailable", "interrupt");
            const returning = await planner.planTurn(combat, combatant, {
                ...base, team: forMember(active),
                teamTurn: rejoin.route.length > 1
                    ? { phase: "movement", destination: rejoin.point, reservations }
                    : { phase: "wait", reason: "team-regrouped" }
            });
            return returning?.plan ? wrap(returning, "regroup", prioritizingReturn ? "team-timeout" : null)
                : wait("team-rejoin-unavailable", "interrupt");
        }
        // Passing a turn never waits on a promise/animation from a different
        // NPC. That NPC must get its normal place in initiative.
        if (movers.length || !active.action) {
            return wait(prioritizingReturn ? "team-timeout" : "team-waiting");
        }
        let ownPlan = null;
        const actors = state.actionStarted ? [active] : state.members.filter(member => member.action);
        for (const member of actors) {
            const doc = _findCombatant(combat, member.id);
            const targets = visible(context, doc, base).filter(t => t.tokenId === member.action.targetId);
            if (!targets.length) return wait("team-action-unavailable", "interrupt");
            const planned = await planner.planTurn(combat, doc, {
                ...base, ...(member === active ? {} : { spent: undefined }),
                includeNeutral: resolveConfig(doc)?.includeNeutral === true,
                team: forMember(member), targets, shareContacts: false, seekContacts: false,
                teamTurn: { phase: "action", ...member.action }
            });
            if (!planned?.plan?.steps.some(step => step.type === member.action.type
                && step.input.targetTokenId === member.action.targetId)) {
                return wait("team-action-unavailable", "interrupt");
            }
            if (member === active) ownPlan = planned;
            else preflight.push(planned.plan.snapshot);
        }
        return wrap(ownPlan, "action");
    }

    /**
     * Check the current claim, shared progress and the same-turn preflight.
     * @param {object} plan
     * @param {object} context
     * @param {object} combatant
     * @param {object} planner
     * @param {object} [options]
     * @param {boolean} [options.before] Check prior to committing a fresh record.
     * @returns {object} Freshness verdict.
     */
    function validate(plan, context, combatant, planner, { before = false } = {}) {
        const turn = plan?.teamTurn;
        if (!turn) return { valid: true, reason: null };
        const fail = reason => ({ valid: false, reason });
        if (!ownsTurn(context, combatant, !before) || plan.snapshot?.combatantId !== combatant.id
            || plan.operationId !== context.operation.id) return fail("turn-stale");
        const { state, phase, existing, preflight } = turn;
        const live = statesOf(context.combat).find(record => record?.teamId === state.teamId);
        if (before ? !sameProgress(live, existing ? state : null)
            : live?.id !== state.id || (acts(phase) && live.inFlight !== context.operation.id)) {
            return fail("team-plan-stale");
        }
        if (phase === "interrupt") return { valid: true, reason: null };
        const reason = stateReason(state, context);
        if (reason) return fail(reason);
        if (coordinating(state) && !fitsSchedule(state, context.combat)) return fail("team-timeout");
        for (const snapshot of preflight) {
            const verdict = planner.validateSnapshot({ snapshot }, { combat: context.combat });
            if (!verdict.valid) return verdict;
        }
        const active = state.members.find(member => member.id === combatant.id);
        if (phase === "movement") {
            const nav = service("navigation", context.planContext?.navigation);
            const endpoint = nav?.validateEndpoint?.(_tokenDoc(combatant.token),
                active.move.destination, { reservations: movementLocks(state, active) });
            if (endpoint && endpoint.valid !== true) {
                return fail("team-route-unavailable");
            }
        } else if (phase === "regroup") {
            const move = plan.steps.find(step => step.type === "move");
            if (move && !validReturnRoute(move, _tokenDoc(combatant.token),
                service("navigation", context.planContext?.navigation), rejoinLocks(live, active.id, context.combat))) {
                return fail("team-rejoin-unavailable");
            }
        } else if (phase === "action") {
            const attackers = state.actionStarted ? [active] : state.members.filter(member => member.action);
            for (const member of attackers) {
                const targetId = member.action.targetId;
                const token = context.combat.scene?.tokens?.get?.(targetId);
                const targetCombatant = context.combat.combatants?.find?.(entry => entry.tokenId === targetId);
                const viewer = _findCombatant(context.combat, member.id);
                if ((token && isHiddenToken(token, { combatant: targetCombatant }))
                    || !visible(context, viewer, context.planContext ?? {}).some(t => t.tokenId === targetId)) {
                    return fail("team-action-unavailable");
                }
            }
        }
        return { valid: true, reason: null };
    }

    /**
     * Replace just one team record while preserving other active teams.
     * @param {object} context
     * @param {object} combatant
     * @param {object} turn
     * @param {object|null} state
     * @returns {Promise<boolean>}
     */
    async function write(context, combatant, turn, state) {
        if (!ownsTurn(context, combatant)) return false;
        const { combat } = context;
        const others = statesOf(combat);
        const live = others.find(record => record?.teamId === turn.state.teamId);
        if (live ? (!sameProgress(live, turn.state)
            && (live.id !== turn.state.id || live.inFlight !== context.operation.id)) : turn.existing) return false;
        if (!live && !state) return true;
        try {
            const remaining = others.filter(record => record?.teamId !== turn.state.teamId
                && (record?.expiresRound > combat.round || record.members.some(member =>
                    member.rejoin?.untilRound >= combat.round))
                && record.controllerId === context.operation.controllerId);
            await combat.setFlag(MODULE_ID, FLAG_KEYS.teamManeuvers, state ? [...remaining, state] : remaining);
            return true;
        } catch(err) {
            log(`team ${turn.state.teamId}: could not persist progress`, err);
            return false;
        }
    }

    /**
     * Persist a new maneuver only when its first turn is actually executed.
     * @param {object} plan
     * @param {object} context
     * @param {object} combatant
     * @param {object} planner
     * @returns {Promise<object>} Freshness verdict.
     */
    async function begin(plan, context, combatant, planner) {
        if (!ownsTurn(context, combatant, true)) return { valid: false, reason: "turn-stale" };
        const turn = plan.teamTurn;
        const verdict = validate(plan, context, combatant, planner, { before: true });
        if (!verdict.valid || !turn || turn.phase === "interrupt") return verdict;
        const startsStep = acts(turn.phase);
        if (!startsStep && turn.existing) return verdict;
        // If the GM changes the turn mid-step, the next claim must not
        // retry a move or roll that may already have reached the server.
        const state = startsStep ? { ...turn.state, inFlight: context.operation.id } : turn.state;
        return await write(context, combatant, turn, state)
            ? verdict : { valid: false, reason: "team-plan-stale" };
    }

    /**
     * Record completed work before the ordinary executor advances initiative.
     * @param {object} plan
     * @param {object} context
     * @param {object} combatant
     * @param {object} result
     * @returns {Promise<void>}
     */
    async function finish(plan, context, combatant, result) {
        const turn = plan?.teamTurn;
        if (!turn || !ownsTurn(context, combatant)) return;
        const { state, phase } = turn;
        if (phase === "interrupt" || result.status !== "completed") {
            await write(context, combatant, turn, null);
            return;
        }
        const last = { id: context.operation.id, round: context.combat.round, turn: context.combat.turn };
        if (phase === "wait") {
            if (turn.reason === "team-timeout") await write(context, combatant, turn, { ...state, last });
            return;
        }
        const member = state.members.find(entry => entry.id === combatant.id);
        const moving = phase === "movement" || phase === "regroup";
        const step = plan.steps.find(entry => entry.type === (moving ? "move" : member.action.type));
        const done = result.stepsDone.some(entry => entry.stepId === step?.id && entry.status === "done"
            && entry.reason !== "adjudicated-skill-test");
        let replacement = null;
        if (done && moving) {
            const token = _tokenDoc(combatant.token);
            const position = { ..._docPoint(step.input.to, token, { scene: context.combat.scene }),
                elevation: member.position.elevation };
            if (!stateReason(state, context, { id: member.id, position })) {
                replacement = { ...member, position, move: null, rejoin: phase === "regroup" || !member.rejoin
                    ? null : { ...member.rejoin, untilRound: context.combat.round + member.rejoin.maxRounds } };
            }
        } else if (phase === "regroup" && !step && !stateReason(state, context)) {
            replacement = { ...member, rejoin: null };
        } else if (done && !stateReason(state, context)) {
            replacement = { ...member, action: null };
        }
        const members = state.members.map(entry => entry === member ? replacement : entry);
        const pending = replacement && members.some(entry => entry.move || entry.action || entry.rejoin);
        await write(context, combatant, turn, pending
            ? { ...state, members, actionStarted: state.actionStarted || phase === "action", inFlight: null, last }
            : null);
    }

    return { plan, validate, begin, finish, ownsTurn };
}
