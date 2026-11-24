/**
 * Executor decomposition (issue #407 follow-up): extracted verbatim from
 * scripts/executor.js — see that file for the design contract. Sub-factory
 * env objects destructure to the identifiers the moved code already used.
 */
import {
    barkText,
    emitBarkOnce,
    gmWhisper
} from "../barks.js";
import {
    CAPTURE_JOURNAL_MAX,
    FLAG_KEYS,
    MODULE_ID
} from "../constants.js";
import {
    COMMITMENT_REASONS,
    appendJournalEntry,
    planIntentOf,
    readCommittedPlan,
    readMoveJournal
} from "../layers.js";
import {
    isCaptureContextEnabled
} from "../settings.js";
import {
    appendCaptureEntry,
    buildCaptureEntry,
    compactTraceLine
} from "../trace.js";
import {
    EXECUTOR_REASONS,
    EXECUTOR_STATUS,
    STEP_STATUS
} from "./contract.js";
import {
    _finiteOr,
    _rejectedSummary
} from "./util.js";

/**
 * The createBookkeeping sub-factory — an extracted block of
 * createExecutorService (issue #407). The env object carries the closure
 * identifiers the moved code referenced: shared state maps, service
 * lookups and sibling helpers wired in executor.js.
 * @param {object} [env]
 * @param {*} [env._advanceTurn] Closure dependency.
 * @param {*} [env._isController] Closure dependency.
 * @param {*} [env._operations] Closure dependency.
 * @param {*} [env.diagnostics] Closure dependency.
 * @param {*} [env.log] Closure dependency.
 * @returns {object} Block handlers.
 */
export function createBookkeeping({
    _advanceTurn,
    _isController,
    _operations,
    diagnostics,
    log
} = {}) {
    /** Dedup keys of emitted plan-start barks (issue #26). */
    const _barkSeen = new Set();


    /**
     * Append the executed move to the combatant `moveJournal` flag
     * (issue #25): the bounded (32) own-move journal the L1 layer diffs
     * against `expectedState.self` — a position change with no matching
     * journal entry is a manual intervention. Best-effort, controller
     * only; failures never fail the step.
     * @param {object} context
     * @param {object} run Shared execution state.
     * @param {{x: number, y: number, elevation?: number}} position
     *   Document-space endpoint of the executed move.
     * @returns {Promise<void>}
     */
    async function _noteMove(context, run, position) {
        const combatant = run.combatant;
        if (!combatant || typeof combatant.setFlag !== "function") return;
        if (!_isController(context)) return;
        if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y)) return;
        try {
            const journal = appendJournalEntry(readMoveJournal(combatant), {
                round: _finiteOr(context.combat?.round, 0),
                turn: _finiteOr(context.combat?.turn, 0),
                x: position.x,
                y: position.y,
                elevation: Number.isFinite(position.elevation) ? position.elevation : null,
                operationId: run.operationId ?? null
            });
            await combatant.setFlag(MODULE_ID, FLAG_KEYS.moveJournal, journal);
        } catch(err) {
            // The journal is bookkeeping — never fatal.
        }
    }


    /**
     * Replay capture (issue #27), controller-only and best-effort: when
     * `aiCaptureContext` is on (or a caller injects `context.capture`),
     * the sanitized `planContext`, the AI flag reads and the finalized
     * snapshot land on the combatant `captureJournal` flag — a bounded
     * journal of ready-made `planTurn` replay fixtures
     * ({@link CAPTURE_JOURNAL_MAX}). Diagnostics additionally echo the
     * JSON to the console. Never fatal: a flag failure degrades to no
     * capture.
     * @param {object} context
     * @param {object} run Shared execution state.
     * @param {object} plannedContext The exact context handed to
     *   `planTurn`.
     */
    function _capturePlanContext(context, run, plannedContext) {
        const combatant = run.combatant;
        if (!combatant || typeof combatant.setFlag !== "function") return;
        if (context?.capture !== true && !isCaptureContextEnabled()) return;
        if (!_isController(context)) return;
        (async () => {
            try {
                const entry = buildCaptureEntry({
                    combat: context.combat ?? null,
                    combatant,
                    context: plannedContext ?? {},
                    plan: run.plan ?? null,
                    config: run.config ?? null,
                    operationId: run.operationId ?? null
                });
                const journal = appendCaptureEntry(
                    combatant.getFlag?.(MODULE_ID, FLAG_KEYS.captureJournal)
                        ?? combatant.flags?.[MODULE_ID]?.[FLAG_KEYS.captureJournal],
                    entry,
                    CAPTURE_JOURNAL_MAX);
                await combatant.setFlag(MODULE_ID, FLAG_KEYS.captureJournal, journal);
                log(`capture ${run.operationId}:`, JSON.stringify(entry));
            } catch(err) {
                // The capture journal is debug plumbing — never fatal.
            }
        })();
    }


    /**
     * End-of-turn commitment bookkeeping (issue #25), controller-only:
     *
     * - an `L1/gm-intervention` trace entry marks the combatant
     *   `gmControlled` for the round (the fireteam replans marked
     *   members at `support`, interventions feed reactive mode);
     * - an invalidated flag record is stamped `cancelled` with the
     *   invalidator code so the next turn does not re-validate a dead
     *   plan;
     * - a commitment hit refreshes the stored `expectedState.self` to
     *   the actual end-of-turn position (steps and ttl are untouched);
     * - a scored plan carrying `plan.commitment` is written as the new
     *   active `committedPlan` record.
     * @param {object} context
     * @param {object} run Shared execution state.
     * @param {object} result Public result summary.
     * @returns {Promise<void>}
     */
    async function _syncCommitment(context, run, result) {
        const combatant = run.combatant;
        if (!combatant || typeof combatant.setFlag !== "function") return;
        if (!_isController(context)) return;
        const diagnostics = run.plan?.diagnostics;
        const layers = Array.isArray(diagnostics?.layers) ? diagnostics.layers : [];
        const intervened = layers.some(entry => entry?.layer === "L1"
            && entry?.code === COMMITMENT_REASONS.gmIntervention);
        if (intervened) {
            try {
                await combatant.setFlag(MODULE_ID, FLAG_KEYS.gmControlled, {
                    round: _finiteOr(context.combat?.round, 0),
                    turn: _finiteOr(context.combat?.turn, 0),
                    reason: COMMITMENT_REASONS.gmIntervention
                });
            } catch(err) {
                // Best-effort flag bookkeeping.
            }
        }
        const record = readCommittedPlan(combatant);
        const invalidated = diagnostics?.commitment?.invalidated ?? null;
        const hit = run.plan?.breakdown?.reason === "commitment";
        try {
            if (hit && record?.status === "active") {
                // Exhausted record: a replayed plan whose substantive
                // steps are all already-satisfied moves contributes
                // nothing — it used to stay `active` and re-commit the
                // same skip-everything plan every turn. Stamp it
                // cancelled so the next turn plans fresh.
                const substantive = (Array.isArray(record.steps) ? record.steps : [])
                    .filter(step => step?.type && step.type !== "end-turn");
                const doneById = new Map(
                    (result.stepsDone ?? []).map(entry => [entry.stepId, entry]));
                const exhausted = substantive.length > 0
                    && substantive.every(step => step.type === "move"
                        && doneById.get(step.id)?.status === STEP_STATUS.skipped
                        && doneById.get(step.id)?.reason === EXECUTOR_REASONS.alreadyAtEndpoint);
                if (exhausted) {
                    await combatant.setFlag(MODULE_ID, FLAG_KEYS.committedPlan, {
                        ...record,
                        status: "cancelled",
                        cancelledReason: COMMITMENT_REASONS.planExhausted,
                        cancelledRound: _finiteOr(context.combat?.round, 0)
                    });
                } else {
                    // Commitment hit: refresh the expected self position to
                    // where the turn actually ended; steps, ttl and the
                    // recorded threats stay as committed.
                    const position = run.expectedPosition ?? record.expectedState?.self;
                    await combatant.setFlag(MODULE_ID, FLAG_KEYS.committedPlan, {
                        ...record,
                        expectedState: {
                            ...record.expectedState,
                            self: {
                                x: position?.x ?? record.expectedState?.self?.x ?? null,
                                y: position?.y ?? record.expectedState?.self?.y ?? null,
                                elevation: Number.isFinite(position?.elevation)
                                    ? position.elevation
                                    : _finiteOr(record.expectedState?.self?.elevation, 0)
                            }
                        }
                    });
                }
            } else if (invalidated && invalidated !== COMMITMENT_REASONS.noCommitment
                && record?.status === "active") {
                // Dead plan: stamp the cancellation so the next turn
                // does not re-validate a known-invalid record.
                await combatant.setFlag(MODULE_ID, FLAG_KEYS.committedPlan, {
                    ...record,
                    status: "cancelled",
                    cancelledReason: invalidated,
                    cancelledRound: _finiteOr(context.combat?.round, 0)
                });
            } else if (!hit && run.plan?.commitment
                && (result.status === EXECUTOR_STATUS.completed
                    || result.status === EXECUTOR_STATUS.partial)) {
                // Fresh scored plan → persist it as the next active
                // commitment (`plan.commitment` carries steps, ttl and
                // expectedState).
                await combatant.setFlag(MODULE_ID, FLAG_KEYS.committedPlan, {
                    id: `c-${run.plan.id ?? run.operationId ?? "plan"}`,
                    status: "active",
                    combatId: context.combat?.id ?? null,
                    combatantId: combatant.id ?? null,
                    createdRound: _finiteOr(context.combat?.round, 0),
                    createdTurn: _finiteOr(context.combat?.turn, 0),
                    ...run.plan.commitment
                });
                // Issue #26: a fresh multi-turn commitment is the plan
                // start the table should hear — the bark dedups to one
                // per combatant per round.
                await _barkPlanStart(context, run);
            }
        } catch(err) {
            // Commitment persistence is best-effort — a lost record
            // degrades to ordinary per-turn planning.
        }
    }


    /**
     * Committed-plan start bark (issue #26): a short localized phrase
     * telegraphing the fresh multi-turn plan ("Move → Attack") — at
     * most one per combatant per round so a same-round replan never
     * repeats it. Single-step commitments do not telegraph (nothing to
     * anticipate). GM whisper by default; `barksToPlayers` opens it.
     * @param {object} context
     * @param {object} run Shared execution state.
     * @returns {Promise<boolean>}
     */
    async function _barkPlanStart(context, run) {
        const steps = planIntentOf(run.plan).steps;
        if (steps.length < 2) return false;
        const name = run.combatant?.name
            ?? run.combatant?.token?.name ?? "NPC";
        const intent = steps
            .map(type => barkText(`OWAI.Preview.Step.${type}`))
            .join(" → ");
        const round = _finiteOr(context.combat?.round, 0);
        return emitBarkOnce(_barkSeen,
            `${context.combat?.id ?? "combat"}|${run.combatant?.id ?? "bot"}|${round}`, {
                key: "OWAI.Bark.Plan.Start",
                data: { name, intent },
                speaker: name,
                context,
                flags: { planStart: { planId: run.plan?.id ?? null, steps: steps.length } }
            });
    }


    /**
     * Close the authority operation for a terminal execution and advance
     * the combat turn. Best-effort: flag failures never crash the result.
     * @param {object} context
     * @param {object} run Shared execution state.
     * @param {object} result Public result summary.
     * @param {boolean} advanceTurn Whether the hook/fallback may advance.
     * @returns {Promise<void>}
     */
    async function _finish(context, run, result, advanceTurn = true) {
        const operations = _operations(context);
        const payload = {
            completed: result.status === EXECUTOR_STATUS.completed,
            failed: result.status === EXECUTOR_STATUS.failed,
            cancelled: result.status === EXECUTOR_STATUS.cancelled,
            reason: result.reason,
            advanceTurn,
            result: {
                status: result.status,
                planId: result.planId,
                reason: result.reason,
                replanCount: result.replanCount,
                stepsDone: result.stepsDone,
                resourceDelta: result.resourceDelta,
                chatMessageIds: result.chatMessageIds
            }
        };
        if (operations && typeof operations.completeTurn === "function") {
            try {
                await operations.completeTurn(context.combat, run.operationId, payload);
            } catch(err) {
                console.error(`${MODULE_ID} | completeTurn failed`, err);
            }
        }
        // Issue #25: persist commitment bookkeeping before the turn
        // moves on — the record/journal must reflect this turn's moves
        // when the next combatant plans.
        await _syncCommitment(context, run, result);
        if (advanceTurn) await _advanceTurn(context, run);
    }


    /**
     * GM-facing diagnostics for stopped turns: a warning notification plus
     * a whispered chat card with the plan diagnostics when diagnostics are
     * enabled.
     * @param {object} context
     * @param {object} run Shared execution state.
     * @param {object} result Terminal result.
     */
    function _report(context, run, result) {
        const i18n = globalThis.game?.i18n;
        const name = run.combatant?.name ?? "NPC";
        let message = `Only War AI: ${name} stopped (${result.reason})`;
        try {
            message = i18n?.format?.("OWAI.Notifications.ExecutorStopped", {
                name,
                reason: result.reason ?? "unknown"
            }) ?? message;
        } catch(err) {
            // Localization is best-effort diagnostics.
        }
        try {
            globalThis.ui?.notifications?.warn?.(message);
        } catch(err) {
            // Notifications are best-effort diagnostics.
        }
        log(`execution ${run.operationId} stopped: ${result.reason}`, run.report ?? "");
        if (diagnostics() && typeof globalThis.ChatMessage !== "undefined") {
            // The whole diagnostics-card block is guarded: a broken i18n
            // or trace formatter must never crash the executor — the
            // turn is already finished when this runs.
            try {
                const rejected = _rejectedSummary(run.report);
                const detail = rejected
                    ? (barkText("OWAI.Chat.ExecutorDiagnosticsDetail", { list: rejected })
                        ?? ` rejected: ${rejected}`)
                    : "";
                const content = barkText("OWAI.Chat.ExecutorDiagnostics", {
                    name,
                    reason: result.reason ?? "unknown",
                    plan: result.planId ?? "—",
                    detail
                }) ?? message;
                // Issue #27: the stopped/cancelled turn whispers its compact
                // reason trace — "commitment cancelled: gm-intervention;
                // morale desperate; winner attack-in-place 0.41" — so the GM
                // reads *why* without opening diagnostics.
                const traceLine = compactTraceLine(
                    run.report ?? run.plan?.diagnostics, i18n);
                const trace = traceLine
                    ? (barkText("OWAI.Chat.ExecutorTrace", { line: traceLine })
                        ?? ` — trace: ${traceLine}`)
                    : "";
                const whisper = gmWhisper();
                Promise.resolve(globalThis.ChatMessage.create({
                    content: `<p>${content}${trace}</p>`,
                    whisper,
                    speaker: { alias: "Only War AI" }
                })).catch(() => {});
            } catch(err) {
                // Chat diagnostics are optional.
            }
        }
    }

    return {
        _noteMove,
        _capturePlanContext,
        _syncCommitment,
        _barkPlanStart,
        _finish,
        _report
    };
}
