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
    commsNet: "commsNet",
    overwatch: "overwatch",
    aim: "aim",
    personality: "personality",
    reactionUsed: "reactionUsed",
    lastUsedWeapon: "lastUsedWeapon",
    lastAttacker: "lastAttacker",
    lastTarget: "lastTarget",
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
    morale: "morale",
    // Issue #27 replay capture: the bounded journal of captured
    // `planContext`+snapshot entries the executor writes when
    // `aiCaptureContext` is on — each entry is a ready-made unit fixture
    // (`replayPlan` re-runs `planTurn` deterministically from it).
    captureJournal: "captureJournal"
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
    // The executor defers `nextTurn` after a landed bot attack while the
    // GM rolls/applies the damage card; this bounds that wait (`0` —
    // wait until the card is settled or the turn advances manually).
    damageWaitTimeoutSeconds: "damageWaitTimeoutSeconds",
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
    manualOverrideGrace: "manualOverrideGrace",
    // Issue #26: short chat barks telegraphing the AI's intentions —
    // emitted on a morale-tier change and at the start of a committed
    // multi-turn plan. GM-only whispers by default; `barksToPlayers`
    // widens the audience to the whole table.
    aiBarks: "aiBarks",
    barksToPlayers: "barksToPlayers",
    // Issue #27 reason trace: `compact` renders the final per-layer
    // verdicts, `full` every recorded layer record. `aiCaptureContext`
    // keeps a bounded replay journal of `planContext`+snapshot captures
    // on the combatant `captureJournal` flag.
    aiTraceVerbose: "aiTraceVerbose",
    aiCaptureContext: "aiCaptureContext",
    // Issue #26: outnumber ratio at which the enemy headcount alone
    // turns the morale proposal `desperate` (default
    // `MORALE_DESPERATE_OUTNUMBER_RATIO = 2` — a 2:1 deficit).
    moraleDesperateRatio: "moraleDesperateRatio"
});

/**
 * Default on/off state of the optional behaviour layers (issue #24).
 * Disabled layers degrade to the previous level of the funnel — a plan is
 * still produced, just without that layer's influence. Rollout order per
 * the issue: commitment → morale → traits → lookahead. `commitment` (L1)
 * and `personality` (L3, issue #19) / `lookahead` (L4, issue #16) run as
 * the historical behaviour, so they default on. `commitment` (L1) and
 * `morale` (L2) are implemented since issues #25/#26 and default on —
 * the first rollout stages of the funnel. Any layer remains a
 * one-toggle rollback.
 */
export const DEFAULT_LAYER_FLAGS = Object.freeze({
    commitment: true,
    morale: true,
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

/**
 * L2 morale tiers of a fireteam (issue #26): `confident` — the team
 * holds a numeric/positional edge, `pressured` — parity (the baseline
 * posture), `desperate` — enemy advantage/losses force regrouping.
 */
export const MORALE_TIERS = Object.freeze([
    "confident",
    "pressured",
    "desperate"
]);

/**
 * Baseline morale tier: an absent or damaged record reads as
 * `pressured` — the parity posture with no task/weight shifts.
 */
export const MORALE_DEFAULT_TIER = "pressured";

/**
 * Morale hysteresis (issue #26): a tier transition commits only after
 * the proposing conditions held for this many consecutive team
 * evaluations (one per round) — the posture never flaps on a single
 * bad turn. A leader loss forces the transition immediately.
 */
export const MORALE_HYSTERESIS_ROUNDS = 2;

/**
 * Sliding window (combat rounds) for "recent" team losses in the
 * morale counters (issue #26): the `losses` log keeps the rounds when
 * members fell and `casualtiesRecent` counts the entries inside this
 * window.
 */
export const MORALE_RECENT_LOSS_ROUNDS = 3;

/**
 * Recent losses inside the window that push the proposal to
 * `desperate` (issue #26).
 */
export const MORALE_DESPERATE_RECENT_LOSSES = 2;

/**
 * Outnumber ratio for the `desperate` proposal (issue #26): the enemy
 * headcount must reach `members × ratio` — default 2 (a 5v10 fight is
 * the team's normal war, not despair; parity and small deficits stay
 * `pressured`). GM-tunable via the `moraleDesperateRatio` world
 * setting / `context.moraleOutnumberRatio`.
 */
export const MORALE_DESPERATE_OUTNUMBER_RATIO = 2;

/**
 * Fraction of the starting strength the team must lose before the
 * proposal turns `desperate` regardless of the headcount (issue #26).
 */
export const MORALE_DESPERATE_LOSS_RATIO = 0.5;

/**
 * Space-control floor for the `desperate` proposal: when the share of
 * sampled member cells outside the enemy threat coverage drops to or
 * below this value the team has lost the ground (issue #26).
 */
export const MORALE_DESPERATE_SPACE_CONTROL = 0.25;

/**
 * Confidence floor for the `confident` proposal: the team must hold a
 * headcount edge AND control at least this share of its own cells
 * (when space control is measurable at all) without fresh losses
 * (issue #26).
 */
export const MORALE_CONFIDENT_SPACE_CONTROL = 0.5;

/**
 * Danger level below which a sampled cell counts as "ours" for the
 * space-control counter (issue #26, threat map #16).
 */
export const MORALE_SAFE_DANGER = 0.5;

/** Bound on the morale `losses` log kept on the fireteam record. */
export const MORALE_LOSS_LOG_MAX = 16;

/**
 * Bound on the `seenEnemies` list persisted on the evaluated morale
 * record (issue #26 review): the squad's "ever seen" hostile set —
 * a tokenUuid is remembered once a member spots it (or once it enters
 * a member's memory) and stays counted while the enemy lives.
 */
export const MORALE_SEEN_ENEMIES_MAX = 128;

/** Default pacing delay between AI execution steps in milliseconds. */
export const DEFAULT_TURN_PACING_MS = 800;

/**
 * Reason-trace render modes for the `aiTraceVerbose` world setting
 * (issue #27): `compact` collapses every layer to its final verdict
 * (grouped vetoes, merged scoring line), `full` renders each recorded
 * `{layer, code, detail}` reason record as its own trace line.
 */
export const TRACE_MODES = Object.freeze([
    "compact",
    "full"
]);

/** Default reason-trace mode — the compact per-layer verdict view. */
export const DEFAULT_TRACE_MODE = "compact";

/**
 * Bound on the executor replay-capture journal (issue #27): the
 * combatant `captureJournal` flag keeps the most recent
 * `planContext`+snapshot captures — each is a ready-made offline replay
 * fixture for `planTurn`.
 */
export const CAPTURE_JOURNAL_MAX = 8;

/**
 * How many top-|contribution| factors the L4 winner record explains
 * (issue #27): the per-factor `w × f` deltas between the winner and the
 * runner-up, cut to the most decisive entries.
 */
export const TRACE_TOP_FACTORS = 3;

/** Default GM preview timeout in seconds (issue #409); 0 disables it. */
export const DEFAULT_PREVIEW_TIMEOUT_SECONDS = 60;

/**
 * Default bound of the post-attack damage wait in seconds (issue #56):
 * after a landed bot attack the executor holds `combat.nextTurn` while
 * the GM rolls and applies the damage card. `0` waits indefinitely —
 * a manual turn advance always releases the wait.
 */
export const DEFAULT_DAMAGE_WAIT_TIMEOUT_SECONDS = 120;

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
