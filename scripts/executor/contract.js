/**
 * Executor decomposition (issue #407 follow-up): extracted verbatim from
 * scripts/executor.js — see that file for the design contract. Sub-factory
 * env objects destructure to the identifiers the moved code already used.
 */


/** Terminal/interim statuses of an execution result. */
export const EXECUTOR_STATUS = Object.freeze({
    completed: "completed",
    partial: "partial",
    failed: "failed",
    cancelled: "cancelled",
    preview: "preview"
});


/** Stable reason codes produced by the executor itself. */
export const EXECUTOR_REASONS = Object.freeze({
    notController: "not-controller",
    controllerChanged: "controller-changed",
    configDisabled: "config-disabled",
    moduleDisabled: "module-disabled",
    previewMode: "preview-mode",
    systemApiMissing: "system-api-missing",
    noPlanner: "no-planner",
    noCombatant: "no-combatant",
    planFailed: "plan-failed",
    moveFailed: "move-failed",
    rollFailed: "roll-failed",
    invalidStep: "invalid-step",
    alreadyAtEndpoint: "already-at-endpoint",
    actionBudgetSpent: "action-budget-spent",
    // Issue #37 adjudication outcomes recorded on steps/results.
    adjudicationCancelled: "adjudication-cancelled",
    adjudicationManual: "adjudicated-manual",
    adjudicationSkillTest: "adjudicated-skill-test"
});


/** Step types that spend irreversible resources through the system API. */
export const IRREVERSIBLE_STEP_TYPES = Object.freeze(new Set(["attack", "test"]));


/** System roll API entry points per step type (system PR #440). */
export const ROLL_API = Object.freeze({
    attack: Object.freeze({ prepare: "prepareAttack", execute: "executeAttack" }),
    test: Object.freeze({ prepare: "prepareTest", execute: "executeTest" })
});


/**
 * GM decisions accepted by the issue #37 adjudication gate:
 * `execute` — run the step through the system roll API;
 * `manual` — the GM rolls it manually and the step counts as spent;
 * `skill-test` — substitute the attack with a `test` step (legally
 * resolves "two identical half actions"/Use Skill situations);
 * `cancel` — stop the turn, hand it back to manual GM control.
 */
export const ADJUDICATION_ACTIONS = Object.freeze([
    "execute",
    "manual",
    "skill-test",
    "cancel"
]);


/** Step statuses recorded inside {@link ExecutionResult.stepsDone}. */
export const STEP_STATUS = Object.freeze({
    done: "done",
    skipped: "skipped",
    failed: "failed"
});


/** Settle windows checked after each turn advance (cumulative ~4.5 s). */
export const ADVANCE_VERIFY_WINDOWS = Object.freeze([600, 1200, 2400]);


/** Retry budget for a silently reverted turn advance. */
export const ADVANCE_VERIFY_RETRIES = 2;
