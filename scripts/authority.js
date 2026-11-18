/**
 * Deterministic active-GM controller election and AI turn detection
 * (issue #400).
 *
 * In multiplayer several GM clients may observe the start of an NPC turn at
 * the same time. To make the AI turn execute exactly once, every client
 * deterministically elects a single controller — the active GM with the
 * lowest stable user id — without any voting. Only the controller writes the
 * authoritative `flags["only-war-ai"].operation` record on Combat documents.
 *
 * Without an active GM the module reports `waiting-for-gm` and never mutates
 * documents. When the controller changes, the new controller marks every
 * unfinished foreign operation `controller-changed`, the old local process
 * stops, and the new controller re-reads the documents before claiming a new
 * attempt.
 *
 * Document subscriptions (`updateCombat`, `updateCombatant`, `updateToken`,
 * `updateActor`, deletions) are filtered for relevant changes and debounced
 * so unrelated updates never trigger a re-evaluation. The module socket
 * channel `module.only-war-ai` accepts `ai-request`/`ai-status` messages;
 * requests are ignored on non-controller clients and real state changes are
 * always performed by the controller only.
 */
import {
    AUTHORITY_STATUS,
    MODULE_ID,
    OPERATION_REASONS,
    SOCKET_CHANNEL,
    SOCKET_MESSAGE_TYPES
} from "./constants.js";
import { resolveEffectiveConfig } from "./config-resolver.js";
import { isModuleEnabled } from "./module-state.js";
import { createOperationService } from "./operations.js";
import { getExecutionMode, logDiagnostics } from "./settings.js";

/** Relevant top-level diff keys per document name (module flags always count). */
const RELEVANT_KEYS = Object.freeze({
    Combat: ["turn", "round", "combatants", "active"],
    Combatant: ["initiative", "defeated", "hidden"],
    Token: ["x", "y", "elevation", "hidden"],
    Actor: []
});

/**
 * Deterministically elect the controller among active GM users.
 * Pure: the same set of users always yields the same controller on every
 * client. The active GM with the lowest user id (code-unit order) wins.
 * @param {Iterable|Array|object} users `game.users` or a user array.
 * @returns {{controllerId: string|null, status: string}}
 *   `status` is "ready" or "waiting-for-gm".
 */
export function electController(users) {
    const ids = _userList(users)
        .filter(user => user && user.active === true && _isGm(user))
        .map(user => String(user.id ?? ""))
        .filter(id => id !== "")
        .sort(_compareIds);
    const controllerId = ids[0] ?? null;
    return {
        controllerId,
        status: controllerId ? AUTHORITY_STATUS.ready : AUTHORITY_STATUS.waitingForGm
    };
}

/**
 * Whether an `updateCombat` diff describes a turn/round transition.
 * @param {object} change Update diff.
 * @returns {boolean}
 */
export function isTurnChange(change) {
    return !!change && typeof change === "object"
        && (change.turn !== undefined || change.round !== undefined);
}

/**
 * Whether an update diff is relevant for AI authority re-evaluation.
 * Relevant: turn/round changes on Combat, combatant initiative/defeat,
 * token position changes, and any `flags["only-war-ai"]` change.
 * @param {string} documentName "Combat" | "Combatant" | "Token" | "Actor".
 * @param {object} change Update diff.
 * @returns {boolean}
 */
export function isRelevantChange(documentName, change) {
    if (!change || typeof change !== "object") return false;
    if (!Object.prototype.hasOwnProperty.call(RELEVANT_KEYS, documentName)) return false;
    if (_touchesModuleFlags(change)) return true;
    return RELEVANT_KEYS[documentName].some(key => change[key] !== undefined);
}

/**
 * Create the authority service: election, watcher hooks, socket protocol and
 * turn detection. All Foundry touch points are injectable for unit tests.
 * @param {object} [deps]
 * @param {object} [deps.api] Module API (`services` lookup for `executor`).
 * @param {object} [deps.operations] Operations service instance.
 * @param {Function} [deps.getUsers] `() => game.users`.
 * @param {Function} [deps.getSelf] `() => game.user`.
 * @param {Function} [deps.getCombats] `() => game.combats`.
 * @param {Function} [deps.getCombat] `() => game.combat` (active combat).
 * @param {Function} [deps.resolveConfig] Effective-config resolver.
 * @param {Function} [deps.isEnabled] Module-enabled predicate.
 * @param {Function} [deps.getMode] `() => "automatic"|"preview"`.
 * @param {object} [deps.hooks] Hooks implementation.
 * @param {Function} [deps.getSocket] `() => game.socket`.
 * @param {Function} [deps.schedule] `setTimeout`-compatible scheduler.
 * @param {Function} [deps.unschedule] `clearTimeout`-compatible canceller.
 * @param {number} [deps.debounceMs] Debounce interval for doc updates.
 * @param {Function} [deps.runAIPlan] Injected planner/executor entry point
 *   (`async ({combat, operation, operations, signal}) => {}`). Falls back to
 *   the `executor` service registered on `api.services` (#407).
 * @param {Function} [deps.log] Diagnostic logger.
 * @returns {object} Authority service.
 */
export function createAuthorityService(deps = {}) {
    const {
        api = null,
        operations = createOperationService({ hooks: deps.hooks ?? Hooks }),
        getUsers = () => game.users,
        getSelf = () => game.user,
        getCombats = () => game.combats,
        getCombat = () => game.combat,
        resolveConfig = resolveEffectiveConfig,
        isEnabled = isModuleEnabled,
        getMode = getExecutionMode,
        hooks = Hooks,
        getSocket = () => game.socket,
        schedule = (fn, ms) => setTimeout(fn, ms),
        unschedule = timer => clearTimeout(timer),
        debounceMs = 150,
        runAIPlan = null,
        log = (...args) => logDiagnostics(...args)
    } = deps;

    const state = {
        started: false,
        controllerId: null,
        status: AUTHORITY_STATUS.waitingForGm,
        /** Turn keys already claimed by this client — dedup of repeat hooks. */
        claimedKeys: new Set(),
        /** Operation ids owned by this client's local process. */
        localOperations: new Set(),
        /** Combats that reported a turn/round change since the last flush. */
        pendingTurns: new Map(),
        /** Socket request or module-flag change asking for re-evaluation. */
        nudged: false,
        timer: null,
        remoteStatus: null,
        listeners: []
    };
    const _inflight = new Set();

    /**
     * Recompute the election from the current user list. On a controller
     * change the local process stops; if this client became controller it
     * invalidates foreign live operations and re-evaluates the active turn.
     * @returns {{controllerId: string|null, status: string}}
     */
    function refresh() {
        const previous = state.controllerId;
        const election = electController(getUsers());
        state.controllerId = election.controllerId;
        state.status = election.status;
        if (previous !== state.controllerId) {
            _onControllerChanged(previous);
        }
        return { controllerId: state.controllerId, status: state.status };
    }

    /**
     * Whether this client is the elected controller.
     * @returns {boolean}
     */
    function isController() {
        const selfId = getSelf()?.id;
        return !!selfId && state.controllerId === selfId;
    }

    /**
     * Effective authority status: "disabled" when the module stayed inactive,
     * otherwise the election result ("ready" | "waiting-for-gm").
     * @returns {string}
     */
    function status() {
        if (!isEnabled()) return AUTHORITY_STATUS.disabled;
        return state.status;
    }

    /**
     * Localized human-readable status for UI surfaces.
     * @returns {string}
     */
    function statusText() {
        const key = {
            [AUTHORITY_STATUS.ready]: "OWAI.Authority.Status.Ready",
            [AUTHORITY_STATUS.waitingForGm]: "OWAI.Authority.Status.WaitingForGm",
            [AUTHORITY_STATUS.disabled]: "OWAI.Authority.Status.Disabled"
        }[status()] ?? "OWAI.Authority.Status.WaitingForGm";
        return game.i18n?.localize?.(key) ?? key;
    }

    /** Register watcher hooks and the socket handler. Idempotent. */
    function start() {
        if (state.started) return;
        state.started = true;
        _listen("userConnected", () => refresh());
        _listen("updateUser", () => refresh());
        _listen("updateCombat", _onUpdateCombat);
        _listen("combatStart", _onCombatStart);
        _listen("deleteCombat", _onDeleteCombat);
        _listen("updateCombatant", (doc, change) => _onDocumentChange("Combatant", doc, change));
        _listen("deleteCombatant", doc => _onDocumentDelete("Combatant", doc));
        _listen("updateToken", (doc, change) => _onDocumentChange("Token", doc, change));
        _listen("deleteToken", doc => _onDocumentDelete("Token", doc));
        _listen("updateActor", (doc, change) => _onDocumentChange("Actor", doc, change));
        const socket = getSocket();
        if (socket && typeof socket.on === "function") {
            socket.on(SOCKET_CHANNEL, _onSocketMessage);
        }
        refresh();
    }

    /** Remove watcher hooks, the socket handler and pending timers. */
    function stop() {
        if (!state.started) return;
        for (const { event, fn } of state.listeners) {
            try {
                hooks.off?.(event, fn);
            } catch(_err) {
                // Hooks.off is best-effort on older cores.
            }
        }
        state.listeners.length = 0;
        const socket = getSocket();
        if (socket && typeof socket.off === "function") {
            socket.off(SOCKET_CHANNEL, _onSocketMessage);
        }
        _clearTimer();
        state.started = false;
    }

    /**
     * Emit an `ai-request` message on the module socket. Any client may send
     * requests; only the controller acts on them.
     * @param {object} [payload] Free-form request payload.
     * @returns {boolean} Whether the message was emitted.
     */
    function sendRequest(payload = {}) {
        return _emit(SOCKET_MESSAGE_TYPES.request, payload);
    }

    /**
     * Broadcast the current authority status (`ai-status`) for other clients.
     * @returns {boolean} Whether the message was emitted.
     */
    function broadcastStatus() {
        return _emit(SOCKET_MESSAGE_TYPES.status, {
            controllerId: state.controllerId,
            status: status()
        });
    }

    /**
     * Flush pending debounced work immediately: claim turns for combats that
     * reported a turn change (plus the active combat after a nudge) and mark
     * live operations whose turn moved on as `turn-stale`.
     * @returns {Promise<void>}
     */
    async function flush() {
        _clearTimer();
        // Snapshot background work before this flush itself can be tracked —
        // awaiting a set containing the current invocation would deadlock.
        const background = [..._inflight];
        const pending = [...state.pendingTurns.values()];
        state.pendingTurns.clear();
        const nudged = state.nudged;
        state.nudged = false;
        if (isEnabled() && isController()) {
            const combats = new Map();
            for (const combat of pending) {
                if (combat) combats.set(combat.id ?? combat, combat);
            }
            if (nudged) {
                const active = getCombat();
                if (active) combats.set(active.id ?? active, active);
            }
            for (const combat of combats.values()) {
                await _maybeClaimTurn(combat);
            }
            for (const combat of _combatList()) {
                await _safe(() => operations.markTurnStale(combat));
            }
        }
        await Promise.allSettled(background);
    }

    /**
     * Sweep all combats and cancel live operations recorded under a different
     * controller. Only meaningful on the currently elected controller.
     * @returns {Promise<object[]>} Per-combat abort results.
     */
    async function abortIfControllerChanged() {
        const results = [];
        for (const combat of _combatList()) {
            results.push(await _safe(() => operations.abortIfControllerChanged(combat, state.controllerId)));
        }
        return results;
    }

    /**
     * Expose the operation-scoped abort check used by the watcher: cancels a
     * live operation when the elected controller differs from the recorded
     * one. Mirrors the issue-#400 `abortIfControllerChanged` contract.
     * @param {object} combat Combat document.
     * @returns {Promise<object>} `{aborted, operation}`.
     */
    async function abortCombatIfControllerChanged(combat) {
        return _safe(() => operations.abortIfControllerChanged(combat, state.controllerId));
    }

    /**
     * Handle the controller transition: stop this client's local process; the
     * new controller marks foreign live operations stale and re-evaluates.
     * @param {string|null} previous Previous controller id.
     */
    function _onControllerChanged(previous) {
        state.localOperations.clear();
        state.claimedKeys.clear();
        log("controller changed", previous, "->", state.controllerId);
        if (isController() && isEnabled()) {
            _track(abortIfControllerChanged());
            state.nudged = true;
            _schedule();
            broadcastStatus();
        }
    }

    /**
     * `updateCombat` handler: queue turn changes and relevant updates.
     * @param {object} combat Combat document.
     * @param {object} change Update diff.
     */
    function _onUpdateCombat(combat, change) {
        if (!isEnabled()) return;
        if (isTurnChange(change)) {
            state.pendingTurns.set(combat?.id ?? combat, combat);
        }
        if (isRelevantChange("Combat", change)) _schedule();
    }

    /**
     * `combatStart` handler: the first turn always counts as a turn change.
     * @param {object} combat Combat document.
     */
    function _onCombatStart(combat) {
        if (!isEnabled()) return;
        if (combat) state.pendingTurns.set(combat.id ?? combat, combat);
        _schedule();
    }

    /**
     * `deleteCombat` handler: drop pending work for the removed combat.
     * @param {object} combat Combat document.
     */
    function _onDeleteCombat(combat) {
        if (!isEnabled()) return;
        if (combat) state.pendingTurns.delete(combat.id ?? combat);
        _schedule();
    }

    /**
     * Generic update handler for Combatant/Token/Actor documents.
     * @param {string} documentName Document type name.
     * @param {object} _doc Updated document (unused; state is re-read on flush).
     * @param {object} change Update diff.
     */
    function _onDocumentChange(documentName, _doc, change) {
        if (!isEnabled()) return;
        if (!isRelevantChange(documentName, change)) return;
        // A module-flag change may toggle AI mid-turn — re-evaluate.
        if (_touchesModuleFlags(change)) state.nudged = true;
        _schedule();
    }

    /**
     * Deletion handler: removed tokens/combatants make the live plan stale.
     * @param {string} _documentName Document type name.
     * @param {object} _doc Deleted document.
     */
    function _onDocumentDelete(_documentName, _doc) {
        if (!isEnabled()) return;
        _schedule();
    }

    /**
     * Module socket handler. `ai-request` is ignored on non-controller
     * clients; `ai-status` updates the locally known remote status.
     * @param {object} message Decoded socket payload.
     */
    function _onSocketMessage(message) {
        if (!message || typeof message !== "object") return;
        if (message.userId === getSelf()?.id) return;
        if (message.type === SOCKET_MESSAGE_TYPES.request) {
            if (!isEnabled() || !isController()) return;
            state.nudged = true;
            _schedule();
        } else if (message.type === SOCKET_MESSAGE_TYPES.status) {
            state.remoteStatus = {
                controllerId: message.controllerId ?? null,
                status: message.status ?? null,
                from: message.userId ?? null
            };
        }
    }

    /**
     * Claim the AI turn for a combat when the active combatant resolves to an
     * enabled effective config. Only runs on the elected controller.
     * @param {object} combat Combat document.
     * @returns {Promise<void>}
     */
    async function _maybeClaimTurn(combat) {
        if (!combat || !isEnabled() || !isController()) return;
        const combatant = combat.combatant ?? combat.turns?.[combat.turn] ?? null;
        if (!combatant) return;
        const config = resolveConfig(combatant);
        if (!config?.enabled) return;
        const key = `${combat.id}:${combatant.id}:${combat.round}:${combat.turn}`;
        if (state.claimedKeys.has(key)) return;
        state.claimedKeys.add(key);

        let claim;
        try {
            claim = await operations.claimTurn(combat, combatant, {
                controllerId: state.controllerId
            });
        } catch(err) {
            state.claimedKeys.delete(key);
            console.error(`${MODULE_ID} | claimTurn failed`, err);
            return;
        }
        if (!claim.ok) {
            // `operation-exists` keeps the dedup key — repeat hooks and socket
            // messages must never retry the same claim.
            if (claim.reason !== OPERATION_REASONS.operationExists) {
                state.claimedKeys.delete(key);
            }
            log("claim rejected:", claim.reason);
            return;
        }
        state.localOperations.add(claim.operation.id);
        await _advanceAfterClaim(combat, claim.operation);
    }

    /**
     * Move a fresh claim through the lifecycle: `planning` →
     * `awaiting-preview` (preview mode) or `executing` (automatic mode),
     * then hand off to the planner/executor integration point.
     * @param {object} combat Combat document.
     * @param {object} operation Freshly claimed operation record.
     * @returns {Promise<void>}
     */
    async function _advanceAfterClaim(combat, operation) {
        const nextPhase = getMode() === "preview" ? "awaiting-preview" : "executing";
        const moved = await operations.transitionOperation(combat, operation.id, "planning", nextPhase);
        if (!moved.ok) {
            log("transition rejected:", moved.reason);
            return;
        }
        await _runAIPlan(combat, moved.operation);
    }

    /**
     * Planner/executor integration point (#407). Consumers register an
     * `executor` service with `runPlan(context)` on `api.services`, or inject
     * `runAIPlan` into the authority service. Without an executor the
     * operation is completed safely (`completed: false`, `no-executor`) so it
     * never hangs; no documents other than the operation flag are touched.
     * @param {object} combat Combat document.
     * @param {object} operation Current operation record.
     * @returns {Promise<void>}
     */
    async function _runAIPlan(combat, operation) {
        const runner = runAIPlan ?? api?.services?.get?.("executor")?.runPlan;
        const signal = _operationSignal(operation.id);
        if (typeof runner !== "function") {
            await _safe(() => operations.completeTurn(combat, operation.id, {
                completed: false,
                reason: OPERATION_REASONS.noExecutor
            }));
            return;
        }
        try {
            await runner({ combat, operation, operations, signal });
        } catch(err) {
            console.error(`${MODULE_ID} | runAIPlan failed`, err);
            await _safe(() => operations.completeTurn(combat, operation.id, {
                failed: true,
                completed: false,
                reason: OPERATION_REASONS.error
            }));
        }
    }

    /**
     * Abort-style signal for executor contexts: flips when this client's
     * local process loses the operation (e.g. controller change).
     * @param {string} operationId
     * @returns {{aborted: boolean, controllerId: string|null}}
     */
    function _operationSignal(operationId) {
        const signal = {
            get aborted() {
                return !state.localOperations.has(operationId);
            },
            get controllerId() {
                return state.controllerId;
            }
        };
        return signal;
    }

    /**
     * Normalized combat list from `game.combats`.
     * @returns {object[]}
     */
    function _combatList() {
        return _userList(getCombats()).filter(combat => combat && typeof combat === "object");
    }

    /**
     * Emit a module socket message.
     * @param {string} type Message type.
     * @param {object} payload Extra payload fields.
     * @returns {boolean} Whether the message was emitted.
     */
    function _emit(type, payload) {
        const socket = getSocket();
        if (!socket || typeof socket.emit !== "function") return false;
        try {
            socket.emit(SOCKET_CHANNEL, {
                type,
                userId: getSelf()?.id ?? null,
                ...payload
            });
            return true;
        } catch(err) {
            log("socket emit failed", err);
            return false;
        }
    }

    /**
     * Register a hook and remember it for `stop()`.
     * @param {string} event Hook name.
     * @param {Function} fn Handler.
     */
    function _listen(event, fn) {
        hooks.on(event, fn);
        state.listeners.push({ event, fn });
    }

    /** Schedule the debounced flush once. */
    function _schedule() {
        if (state.timer !== null) return;
        state.timer = schedule(() => {
            state.timer = null;
            _track(flush());
        }, debounceMs);
    }

    /** Cancel the pending debounce timer. */
    function _clearTimer() {
        if (state.timer !== null) {
            unschedule(state.timer);
            state.timer = null;
        }
    }

    /**
     * Track a background promise so `flush()` can drain it.
     * @param {Promise|*} promise
     * @returns {Promise<void>}
     */
    function _track(promise) {
        const tracked = Promise.resolve(promise).catch(err => {
            console.error(`${MODULE_ID} | background task failed`, err);
        });
        _inflight.add(tracked);
        tracked.finally(() => _inflight.delete(tracked));
        return tracked;
    }

    /**
     * Run an async step without letting failures escape.
     * @param {Function} fn
     * @returns {Promise<*>}
     */
    async function _safe(fn) {
        try {
            return await fn();
        } catch(err) {
            log("step failed", err);
            return null;
        }
    }

    return {
        abortCombatIfControllerChanged,
        abortIfControllerChanged,
        broadcastStatus,
        elect: electController,
        flush,
        isController,
        isRelevantChange,
        isTurnChange,
        operations,
        refresh,
        sendRequest,
        start,
        status,
        statusText,
        stop,
        get claimedKeys() {
            return [...state.claimedKeys];
        },
        get controllerId() {
            return state.controllerId;
        },
        get localOperations() {
            return [...state.localOperations];
        },
        get remoteStatus() {
            return state.remoteStatus;
        },
        get started() {
            return state.started;
        }
    };
}

/**
 * Whether the diff touches the module flag namespace (including deletions).
 * @param {object} change Update diff.
 * @returns {boolean}
 */
function _touchesModuleFlags(change) {
    const flags = change.flags;
    if (!flags || typeof flags !== "object") return false;
    return Object.prototype.hasOwnProperty.call(flags, MODULE_ID)
        || Object.prototype.hasOwnProperty.call(flags, `-=${MODULE_ID}`);
}

/**
 * Normalize a Foundry collection/Map/array/iterable into a plain array.
 * @param {*} collection
 * @returns {object[]}
 */
function _userList(collection) {
    if (!collection) return [];
    if (Array.isArray(collection)) return collection;
    if (Array.isArray(collection.contents)) return collection.contents;
    if (typeof collection.values === "function") return [...collection.values()];
    if (typeof collection[Symbol.iterator] === "function") return [...collection];
    return [];
}

/**
 * Whether the user is a GM account (Foundry `isGM` or GAMEMASTER role).
 * @param {object} user
 * @returns {boolean}
 */
function _isGm(user) {
    return user.isGM === true || user.role === 4;
}

/**
 * Code-unit id comparison — identical ordering on every client regardless
 * of locale (unlike `localeCompare`).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function _compareIds(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
