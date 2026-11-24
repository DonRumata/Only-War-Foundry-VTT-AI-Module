/**
 * AI turn operation lifecycle on Combat documents (issue #400).
 *
 * The authoritative operation record lives on the Combat document as
 * `flags["only-war-ai"].operation`:
 * `{ id, combatId, combatantId, round, turn, controllerId, phase, revision,
 *    startedAt, completedAt?, reason?, result? }`.
 *
 * Only the elected controller writes this flag. All mutations use
 * compare-before-update semantics: the flag is re-read after every write and
 * the operation id plus expected phase must match, otherwise the mutation is
 * rejected with a stable reason code. Terminal phases (`completed`, `failed`,
 * `cancelled`) are final — a repeated `completeTurn` is an idempotent no-op.
 */
import {
    FLAG_KEYS,
    MODULE_ID,
    OPERATION_PHASES,
    OPERATION_REASONS,
    OPERATION_TERMINAL_PHASES,
    OPERATION_TRANSITIONS
} from "./constants.js";

/**
 * Whether an operation record describes a live (non-terminal) operation.
 * @param {object|null} operation
 * @returns {boolean}
 */
export function isLiveOperation(operation) {
    return !!operation && OPERATION_TERMINAL_PHASES.includes(operation.phase) === false;
}

/**
 * Compute a stable revision fingerprint of the turn state that is relevant to
 * an AI operation: combat round/turn and the combatant/token position and
 * state. Two clients computing it over the same documents get the same hash.
 * @param {object} combat Combat document.
 * @param {object} combatant Combatant document.
 * @returns {string} Hex hash prefixed with "r".
 */
export function computeRevision(combat, combatant) {
    const tokenDoc = combatant?.token && typeof combatant.token === "object"
        ? combatant.token
        : null;
    const fingerprint = {
        combatId: combat?.id ?? null,
        combatantId: combatant?.id ?? null,
        round: combat?.round ?? null,
        turn: combat?.turn ?? null,
        tokenId: combatant?.tokenId ?? tokenDoc?.id ?? null,
        x: tokenDoc?._source?.x ?? tokenDoc?.x ?? null,
        y: tokenDoc?._source?.y ?? tokenDoc?.y ?? null,
        elevation: tokenDoc?.elevation ?? null,
        hidden: tokenDoc?.hidden === true,
        defeated: combatant?.defeated === true,
        initiative: combatant?.initiative ?? null
    };
    return `r${_fnv1a(_stableStringify(fingerprint)).toString(16)}`;
}

/**
 * Read the operation flag from a Combat document. Returns a defensive copy so
 * callers can never mutate the stored flag; damaged values read as `null`.
 * @param {object} combat Combat document.
 * @returns {object|null} The operation record or null.
 */
export function readOperation(combat) {
    const raw = _readFlag(combat, FLAG_KEYS.operation);
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.id !== "string" || raw.id === "") return null;
    if (!OPERATION_PHASES.includes(raw.phase)) return null;
    return _clone(raw);
}

/**
 * Create the operations service that manages the Combat operation flag.
 * @param {object} [deps]
 * @param {Function} [deps.now] Clock override for tests (`() => ms`).
 * @param {Function} [deps.idGen] Id generator override for tests.
 * @param {object} [deps.hooks] Hooks-like object; `operationCompleted` is
 *   emitted after a successful {@link completeTurn} so a later executor
 *   (#407) can advance the combat turn.
 * @returns {object} Service with claim/transition/complete/abort methods.
 */
export function createOperationService({ now, idGen, hooks } = {}) {
    const _now = typeof now === "function" ? now : () => Date.now();
    const _idGen = typeof idGen === "function" ? idGen : () => foundry.utils.randomID();

    /**
     * Broadcast `only-war-ai.phaseChanged` after a phase write — the
     * preview dialog listens to drop sessions whose operation left
     * `awaiting-preview` (without this emission the preview UI lingered
     * stale through the whole execution window).
     * @param {object} combat Combat document.
     * @param {object} operation Operation record after the write.
     * @param {string|null} oldPhase Phase before the transition.
     * @param {string} newPhase Phase after the transition.
     */
    function _emitPhaseChanged(combat, operation, oldPhase, newPhase) {
        try {
            hooks?.callAll?.(
                `${MODULE_ID}.phaseChanged`, combat, _clone(operation), oldPhase, newPhase
            );
        } catch(_err) {
            // Hook delivery is best-effort — flag state is authoritative.
        }
    }

    /**
     * Claim an AI turn for the given combatant. Succeeds only when no live
     * operation exists for the same (combatId, combatantId, round, turn);
     * a live operation from an older turn is marked `turn-stale` first.
     * Compare-before-update: after writing, the flag is re-read — if a
     * parallel claim won the race the loser sees `operation-exists`.
     * @param {object} combat Combat document.
     * @param {object} combatant Active Combatant document.
     * @param {object} [options]
     * @param {string} [options.controllerId] Elected controller user id.
     * @returns {Promise<{ok: boolean, reason?: string, operation?: object}>}
     */
    async function claimTurn(combat, combatant, { controllerId = null } = {}) {
        if (!combat || !combatant) {
            return { ok: false, reason: OPERATION_REASONS.invalidArgument, operation: null };
        }
        const existing = readOperation(combat);
        if (isLiveOperation(existing)) {
            if (_sameTurnKey(existing, combat, combatant)) {
                return { ok: false, reason: OPERATION_REASONS.operationExists, operation: existing };
            }
            await _cancelOperation(combat, existing, OPERATION_REASONS.turnStale);
        }

        const operation = {
            id: _idGen(),
            combatId: combat.id ?? null,
            combatantId: combatant.id ?? null,
            round: combat.round ?? 0,
            turn: combat.turn ?? 0,
            controllerId,
            phase: "planning",
            revision: computeRevision(combat, combatant),
            startedAt: _now()
        };
        await _write(combat, operation);

        const winner = readOperation(combat);
        if (winner && winner.id !== operation.id) {
            return { ok: false, reason: OPERATION_REASONS.operationExists, operation: winner };
        }
        return { ok: true, operation: readOperation(combat) ?? operation };
    }

    /**
     * Transition an operation to the next phase. Updates only when the
     * operation id matches and the current phase equals `expectedPhase`
     * (compare-before-update); otherwise returns a stable reason.
     * @param {object} combat Combat document.
     * @param {string} id Operation id.
     * @param {string} expectedPhase Phase the caller believes is current.
     * @param {string} nextPhase Target phase.
     * @param {object} [patch] Extra fields merged into the record.
     * @returns {Promise<{ok: boolean, reason?: string, operation?: object}>}
     */
    async function transitionOperation(combat, id, expectedPhase, nextPhase, patch = {}) {
        const operation = readOperation(combat);
        if (!operation) {
            return { ok: false, reason: OPERATION_REASONS.operationMissing, operation: null };
        }
        if (operation.id !== id) {
            return { ok: false, reason: OPERATION_REASONS.operationMismatch, operation };
        }
        if (operation.phase !== expectedPhase) {
            return { ok: false, reason: OPERATION_REASONS.phaseMismatch, operation };
        }
        if (!OPERATION_TRANSITIONS[operation.phase]?.includes(nextPhase)) {
            return { ok: false, reason: OPERATION_REASONS.invalidTransition, operation };
        }
        const updated = { ...operation, ...patch, phase: nextPhase };
        if (OPERATION_TERMINAL_PHASES.includes(nextPhase) && updated.completedAt === undefined) {
            updated.completedAt = _now();
        }
        await _write(combat, updated);
        _emitPhaseChanged(combat, updated, operation.phase, nextPhase);
        return { ok: true, operation: readOperation(combat) ?? updated };
    }

    /**
     * Complete an operation. Idempotent: repeating the call on a terminal
     * operation is a no-op reporting `already-completed`. The result (with a
     * `completed` flag) is stored on the record; the actual turn advancement
     * (`combat.nextTurn`) is the executor's job (#407) and is signalled
     * through the `only-war-ai.operationCompleted` hook.
     * @param {object} combat Combat document.
     * @param {string} id Operation id.
     * @param {object} [result] `{ completed?, failed?, cancelled?, reason?, ... }`.
     * @returns {Promise<{ok: boolean, noop?: boolean, reason?: string, operation?: object}>}
     */
    async function completeTurn(combat, id, result = {}) {
        const operation = readOperation(combat);
        if (!operation) {
            return { ok: false, reason: OPERATION_REASONS.operationMissing, operation: null };
        }
        if (operation.id !== id) {
            return { ok: false, reason: OPERATION_REASONS.operationMismatch, operation };
        }
        if (!isLiveOperation(operation)) {
            return { ok: true, noop: true, reason: OPERATION_REASONS.alreadyCompleted, operation };
        }
        let phase = "completed";
        if (result.failed === true) phase = "failed";
        else if (result.cancelled === true) phase = "cancelled";
        const updated = {
            ...operation,
            phase,
            reason: result.reason ?? operation.reason,
            result: result && typeof result === "object" ? { ...result } : result,
            completedAt: _now()
        };
        await _write(combat, updated);
        _emitPhaseChanged(combat, updated, operation.phase, phase);
        // Integration point: only after the operation is completed may the
        // turn be advanced (`combat.nextTurn` via the executor, #407).
        hooks?.callAll?.(`${MODULE_ID}.operationCompleted`, combat, _clone(updated));
        return { ok: true, operation: readOperation(combat) ?? updated };
    }

    /**
     * Cancel a live operation whose recorded controller no longer matches the
     * currently elected controller. Used by the new controller to invalidate
     * unfinished plans after a GM change.
     * @param {object} combat Combat document.
     * @param {string} controllerId Currently elected controller id.
     * @returns {Promise<{aborted: boolean, operation: object|null}>}
     */
    async function abortIfControllerChanged(combat, controllerId) {
        const operation = readOperation(combat);
        if (!isLiveOperation(operation)) {
            return { aborted: false, operation: operation ?? null };
        }
        if (operation.controllerId === controllerId) {
            return { aborted: false, operation };
        }
        const updated = await _cancelOperation(combat, operation, OPERATION_REASONS.controllerChanged);
        return { aborted: true, operation: updated };
    }

    /**
     * Cancel a live operation when the combat already moved to another
     * round/turn — the plan can never be resumed safely.
     * @param {object} combat Combat document.
     * @returns {Promise<{stale: boolean, operation: object|null}>}
     */
    async function markTurnStale(combat) {
        const operation = readOperation(combat);
        if (!isLiveOperation(operation)) {
            return { stale: false, operation: operation ?? null };
        }
        const sameTurn = operation.combatId === (combat?.id ?? null)
            && operation.round === (combat?.round ?? 0)
            && operation.turn === (combat?.turn ?? 0);
        if (sameTurn) return { stale: false, operation };
        const updated = await _cancelOperation(combat, operation, OPERATION_REASONS.turnStale);
        return { stale: true, operation: updated };
    }

    /**
     * Whether a live operation exists for the given combat/turn.
     * @param {object} combat Combat document.
     * @param {object} combatant Combatant document.
     * @returns {boolean}
     */
    function hasLiveOperation(combat, combatant) {
        const operation = readOperation(combat);
        return isLiveOperation(operation) && _sameTurnKey(operation, combat, combatant);
    }

    /**
     * Persist the operation flag.
     * @param {object} combat Combat document.
     * @param {object} operation Operation record.
     * @returns {Promise<object>} The written record.
     */
    async function _write(combat, operation) {
        await combat.setFlag(MODULE_ID, FLAG_KEYS.operation, operation);
        return operation;
    }

    /**
     * Write a terminal cancellation for a live operation.
     * @param {object} combat Combat document.
     * @param {object} operation Current operation record.
     * @param {string} reason Stable reason code.
     * @returns {Promise<object>} The updated record.
     */
    async function _cancelOperation(combat, operation, reason) {
        const updated = { ...operation, phase: "cancelled", reason, completedAt: _now() };
        await _write(combat, updated);
        return updated;
    }

    return {
        abortIfControllerChanged,
        claimTurn,
        completeTurn,
        computeRevision,
        hasLiveOperation,
        isLiveOperation,
        markTurnStale,
        phases: OPERATION_PHASES,
        readOperation,
        reasons: OPERATION_REASONS,
        transitionOperation
    };
}

/**
 * Whether an operation belongs to the exact combatant and turn being claimed.
 * @param {object} operation
 * @param {object} combat
 * @param {object} combatant
 * @returns {boolean}
 */
function _sameTurnKey(operation, combat, combatant) {
    return operation.combatId === (combat?.id ?? null)
        && operation.combatantId === (combatant?.id ?? null)
        && operation.round === (combat?.round ?? 0)
        && operation.turn === (combat?.turn ?? 0);
}

/**
 * Read a module flag via `getFlag` or the raw `flags` object.
 * @param {object} doc
 * @param {string} key
 * @returns {*}
 */
function _readFlag(doc, key) {
    if (typeof doc?.getFlag === "function") {
        try {
            return doc.getFlag(MODULE_ID, key);
        } catch(_err) {
            return undefined;
        }
    }
    return doc?.flags?.[MODULE_ID]?.[key];
}

/**
 * Defensive deep copy for JSON-shaped flag payloads.
 * @param {*} value
 * @returns {*}
 */
function _clone(value) {
    if (typeof foundry?.utils?.deepClone === "function") {
        return foundry.utils.deepClone(value);
    }
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/**
 * Deterministic JSON stringify with recursively sorted keys.
 * @param {*} value
 * @returns {string}
 */
function _stableStringify(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(_stableStringify).join(",")}]`;
    const keys = Object.keys(value).sort();
    const entries = keys.map(key => `${JSON.stringify(key)}:${_stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
}

/**
 * FNV-1a 32-bit hash — small, stable and identical on every client.
 * @param {string} str
 * @returns {number} Unsigned 32-bit hash.
 */
function _fnv1a(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}
