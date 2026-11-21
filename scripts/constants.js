/**
 * Shared constants for the Only War AI module.
 * Flag namespace, preset/mode enums and the system compatibility contract.
 */

/** Foundry module id, used as the flags scope and settings namespace. */
export const MODULE_ID = "only-war-ai";

/** Version of the module's public API contract ("major.minor"). */
export const MODULE_API_VERSION = "1.0";

/** Fixed AI behaviour presets exposed to the GM. */
export const AI_PRESETS = Object.freeze([
    "assault",
    "rangedCover",
    "hold",
    "specOps"
]);

/** Fallback preset used when AI is explicitly enabled without a valid preset. */
export const FALLBACK_PRESET = "hold";

/** Override modes for Token and Combatant flags. */
export const OVERRIDE_MODES = Object.freeze([
    "inherit",
    "enabled",
    "disabled"
]);

/** Temporary fireteam tasks assigned inside a single TeamPlan (issue #408). */
export const FIRETEAM_TASKS = Object.freeze([
    "support",
    "advance",
    "flank",
    "assault",
    "regroup"
]);

/** Default preferred fireteam cohesion distance in scene units (metres). */
export const DEFAULT_PREFERRED_COHESION = 5;

/** Flag keys inside the `flags["only-war-ai"]` namespace. */
export const FLAG_KEYS = Object.freeze({
    actorConfig: "config",
    override: "override",
    operation: "operation",
    memory: "memory",
    fireteam: "fireteam",
    overwatch: "overwatch",
    aim: "aim",
    personality: "personality"
});

/**
 * Fireteam "characters" (issue #19): the shared temperament of a team
 * recorded on the `fireteam` flag. Each character contributes a weight
 * overlay and a jitter bias applied to every member's plan.
 */
export const FIRETEAM_CHARACTERS = Object.freeze([
    "disciplined",
    "shock",
    "elite",
    "rabble"
]);

/** World setting keys. */
export const SETTING_KEYS = Object.freeze({
    masterEnabled: "masterEnabled",
    executionMode: "executionMode",
    diagnosticsEnabled: "diagnosticsEnabled",
    preferredCohesion: "preferredCohesion",
    previewTimeoutSeconds: "previewTimeoutSeconds",
    turnPacingMs: "turnPacingMs",
    aiDifficulty: "aiDifficulty"
});

/** Default pacing delay between AI execution steps in milliseconds. */
export const DEFAULT_TURN_PACING_MS = 800;

/** Default GM preview timeout in seconds (issue #409); 0 disables it. */
export const DEFAULT_PREVIEW_TIMEOUT_SECONDS = 60;

/** Execution modes for the world setting. */
export const EXECUTION_MODES = Object.freeze([
    "automatic",
    "preview"
]);

/**
 * AI difficulty levels for the world setting (issue #16): `easy` bots
 * deliberately pick suboptimal plans and ignore the threat map, `normal`
 * applies the danger factor, `hard` additionally enables the 2-ply
 * lookahead pass.
 */
export const AI_DIFFICULTIES = Object.freeze([
    "easy",
    "normal",
    "hard"
]);

/** Default AI difficulty when the world setting is missing or damaged. */
export const DEFAULT_AI_DIFFICULTY = "normal";

/** Required host system id. */
export const REQUIRED_SYSTEM_ID = "only-war-local";

/** Required major version of the public system API (`game.darkHeresy.api`). */
export const REQUIRED_SYSTEM_API_MAJOR = "1";

/**
 * AI turn operation lifecycle phases (issue #400):
 * `idle -> planning -> awaiting-preview -> executing -> completed/failed/cancelled`.
 */
export const OPERATION_PHASES = Object.freeze([
    "idle",
    "planning",
    "awaiting-preview",
    "executing",
    "completed",
    "failed",
    "cancelled"
]);

/** Phases after which an operation is finished and never resumes. */
export const OPERATION_TERMINAL_PHASES = Object.freeze([
    "completed",
    "failed",
    "cancelled"
]);

/** Allowed phase transitions for the compare-before-update state machine. */
export const OPERATION_TRANSITIONS = Object.freeze({
    idle: ["planning"],
    planning: ["awaiting-preview", "executing", "failed", "cancelled"],
    "awaiting-preview": ["executing", "failed", "cancelled"],
    executing: ["completed", "failed", "cancelled"],
    completed: [],
    failed: [],
    cancelled: []
});

/** Stable reason codes for operation results and the authority status. */
export const OPERATION_REASONS = Object.freeze({
    alreadyCompleted: "already-completed",
    controllerChanged: "controller-changed",
    error: "error",
    invalidArgument: "invalid-argument",
    invalidTransition: "invalid-transition",
    noExecutor: "no-executor",
    notController: "not-controller",
    operationExists: "operation-exists",
    operationMismatch: "operation-mismatch",
    operationMissing: "operation-missing",
    phaseMismatch: "phase-mismatch",
    turnStale: "turn-stale",
    waitingForGm: "waiting-for-gm"
});

/** Authority (controller election) status values. */
export const AUTHORITY_STATUS = Object.freeze({
    disabled: "disabled",
    ready: "ready",
    waitingForGm: "waiting-for-gm"
});

/** Foundry socket channel used by the module protocol. */
export const SOCKET_CHANNEL = `module.${MODULE_ID}`;

/** Module socket message types. */
export const SOCKET_MESSAGE_TYPES = Object.freeze({
    request: "ai-request",
    status: "ai-status"
});
