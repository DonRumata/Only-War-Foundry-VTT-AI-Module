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
    personality: "personality",
    reactionUsed: "reactionUsed",
    lastUsedWeapon: "lastUsedWeapon",
    lastAttacker: "lastAttacker",
    lastOrder: "lastOrder",
    delaySync: "delaySync",
    // Issue #25 L1 commitment: the persisted multi-turn plan record
    // (`{status, steps, expectedState, ttl, ...}`), the bounded journal of
    // the bot's own executed moves (source of truth for "own move vs GM
    // move") and the one-turn `gm-controlled` mark left by a detected
    // GM intervention.
    committedPlan: "committedPlan",
    moveJournal: "moveJournal",
    gmControlled: "gmControlled",
    // Reserved for issue #26 morale — the squad-sync/order code already
    // reads `morale.{state|pressured|desperate}` gracefully: an absent
    // flag simply means normal morale.
    morale: "morale"
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
    aiDifficulty: "aiDifficulty",
    threatMapOverlay: "threatMapOverlay",
    attackAdjudication: "attackAdjudication",
    // Issue #24 behaviour-layer toggles (the planning funnel L0–L4).
    layersCommitment: "layersCommitment",
    layersMorale: "layersMorale",
    layersPersonality: "layersPersonality",
    layersLookahead: "layersLookahead",
    // Issue #25: whether a manual GM move is absolute law (`true` —
    // drift never cancels a commitment and never marks the bot
    // `gm-controlled`) or ordinary interference (`false`, default — a
    // committed bot treats an unexplained move as `gm-intervention`,
    // cancels the plan and replans on its next turn).
    manualOverrideGrace: "manualOverrideGrace"
});

/**
 * Default on/off state of the optional behaviour layers (issue #24).
 * Disabled layers degrade to the previous level of the funnel — a plan is
 * still produced, just without that layer's influence. Rollout order per
 * the issue: commitment → morale → traits → lookahead. `commitment` (L1)
 * and `personality` (L3, issue #19) / `lookahead` (L4, issue #16) run as
 * the historical behaviour, so they default on. `commitment` (L1) is
 * implemented since issue #25 and defaults on — the first rollout stage
 * of the funnel; `morale` (L2) stays off until issue #26 lands the
 * posture factors. Any layer remains a one-toggle rollback.
 */
export const DEFAULT_LAYER_FLAGS = Object.freeze({
    commitment: true,
    morale: false,
    personality: true,
    lookahead: true
});

/**
 * Default TTL of a committed multi-turn plan in combat rounds (issue
 * #25): a record written in round R stays valid while
 * `round - createdRound < ttl`. One bot activation happens per round, so
 * a round TTL is also a bot-turn TTL. Reactive mode squeezes the
 * effective TTL to `1` — only the round the record was written in.
 */
export const COMMITMENT_TTL_ROUNDS = 2;

/**
 * Bound on the executor move journal (issue #25): the combatant
 * `moveJournal` flag keeps the most recent own moves
 * `{round, turn, x, y, elevation, operationId}` — the source of truth
 * telling the bot's own motion apart from a GM drag.
 */
export const COMMITMENT_JOURNAL_MAX = 32;

/**
 * How many committed `expectedState.threats` tokens may drift (moved
 * more than one grid cell, died or disappeared) before the plan is
 * cancelled with `threat-drift` (issue #25).
 */
export const COMMITMENT_THREAT_TOLERANCE = 1;

/**
 * Bound on `expectedState.threats` entries of a committed plan
 * (issue #25).
 */
export const COMMITMENT_THREAT_MAX = 16;

/**
 * Reactive-mode threshold (issue #25): when more same-team combatants
 * than this count were marked `gmControlled` this round, the world is in
 * "manual chaos" — effective commitment TTL squeezes to 1 round (the
 * per-turn baseline) until the interventions stop.
 */
export const COMMITMENT_REACTIVE_THRESHOLD = 1;

/**
 * Sub-cell noise tolerance (pixels) for self-position drift checks
 * (issue #25): hex grids snap the stored position off the fractional
 * plan endpoint, so sub-pixel drift is ignored; anything larger is a
 * real move to be attributed via the move journal.
 */
export const COMMITMENT_POSITION_TOLERANCE_PX = 0.5;

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

/**
 * Attack adjudication modes for the `attackAdjudication` world setting
 * (issue #37): `"auto"` executes irreversible attack/test steps without a
 * pause; `"gm-confirm"` pauses before the irreversible step and asks the
 * GM through a chat card how to resolve it.
 */
export const ATTACK_ADJUDICATION_MODES = Object.freeze([
    "auto",
    "gm-confirm"
]);

/** Default attack-adjudication mode — the historical, hands-off one. */
export const DEFAULT_ATTACK_ADJUDICATION = "auto";

/**
 * Combat rounds a leader must wait between orders (issue #38): the
 * `lastOrder` flag record `{round, orderId, result}` blocks a new order
 * candidate until `round - lastOrder.round` reaches this value.
 */
export const ORDER_COOLDOWN_ROUNDS = 3;

/**
 * Safety bound for squad-sync delays (issue #38): a member never receives
 * more than this many consecutive `delay` assignments for the same `until`
 * condition — the `delaySync` flag records the running count.
 */
export const DEFAULT_MAX_SYNC_ROUNDS = 2;

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
