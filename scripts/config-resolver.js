/**
 * Pure resolver for the effective AI configuration of an Actor, Token or
 * Combatant document (issue #399).
 *
 * Priority: Combatant override → Token override → Actor config → disabled.
 *
 * The resolver is read-only and deterministic: it never mutates the passed
 * documents, never touches `game` state and therefore resolves identically on
 * every client. Deleted or missing documents normalise to a safe disabled
 * result, and unknown presets fall back to the actor preset, then to `hold`
 * when AI was explicitly enabled, otherwise to disabled.
 */
import {
    AI_PRESETS,
    FALLBACK_PRESET,
    FLAG_KEYS,
    MODULE_ID
} from "./constants.js";

/**
 * Resolve the effective AI configuration for a document.
 * @param {object} document Actor, TokenDocument, Token placeable or Combatant.
 * @returns {{enabled: boolean, preset: string|null, source: string}}
 *   `source` is "combatant" | "token" | "actor" | "none".
 */
export function resolveEffectiveConfig(document) {
    const doc = _unwrapDocument(document);
    if (_isMissing(doc)) return _disabledResult();

    const kind = _kindOf(doc);
    if (!kind) return _disabledResult();

    // Collect the override chain for the document kind and resolve the actor.
    const overrides = [];
    let actor = null;

    if (kind === "combatant") {
        // A combatant without a live token or actor means the underlying
        // documents were deleted — resolve to disabled.
        if (_isMissing(doc.token) || _isMissing(doc.actor)) return _disabledResult();
        overrides.push({ doc, source: "combatant" });
        overrides.push({ doc: _unwrapDocument(doc.token), source: "token" });
        actor = doc.actor;
    } else if (kind === "token") {
        if (_isMissing(doc.actor)) return _disabledResult();
        overrides.push({ doc, source: "token" });
        actor = doc.actor;
    } else {
        actor = doc;
    }

    if (_isMissing(actor)) return _disabledResult();
    const actorConfig = _normalizeActorConfig(actor);

    // Highest-priority explicit overrides win first.
    for (const layer of overrides) {
        const override = _normalizeOverride(layer.doc);
        if (override.mode === "disabled") {
            return { enabled: false, preset: null, source: layer.source };
        }
        if (override.mode === "enabled") {
            const preset = _presetOr(override.preset, actorConfig.preset);
            return { enabled: true, preset, source: layer.source };
        }
        // "inherit" or damaged data falls through to the next layer.
    }

    // Actor-level default configuration.
    if (actorConfig.enabled) {
        return { enabled: true, preset: actorConfig.preset ?? FALLBACK_PRESET, source: "actor" };
    }
    return _disabledResult();
}

/**
 * Whether the given document resolves to an enabled AI configuration.
 * @param {object} document
 * @returns {boolean}
 */
export function isAiEnabled(document) {
    return resolveEffectiveConfig(document).enabled === true;
}

/**
 * Read a module flag without mutating the document. Uses `getFlag` when the
 * document provides it, otherwise reads the raw `flags` object.
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
 * Pick the first known preset, then the module fallback preset.
 * @param {*} candidate
 * @param {string|null} fallback
 * @returns {string}
 */
function _presetOr(candidate, fallback) {
    if (AI_PRESETS.includes(candidate)) return candidate;
    if (AI_PRESETS.includes(fallback)) return fallback;
    return FALLBACK_PRESET;
}

/**
 * Normalise the actor-level `config` flag. Anything that is not an object, or
 * does not set `enabled === true`, resolves to a disabled default.
 * @param {object} actor
 * @returns {{enabled: boolean, preset: string|null}}
 */
function _normalizeActorConfig(actor) {
    const config = _readFlag(actor, FLAG_KEYS.actorConfig);
    if (!config || typeof config !== "object") {
        return { enabled: false, preset: null };
    }
    const enabled = config.enabled === true;
    const preset = AI_PRESETS.includes(config.preset) ? config.preset : null;
    return { enabled, preset };
}

/**
 * Normalise a Token/Combatant `override` flag. Missing or damaged data
 * resolves to "inherit".
 * @param {object} doc
 * @returns {{mode: string, preset: string|null}}
 */
function _normalizeOverride(doc) {
    const override = _readFlag(doc, FLAG_KEYS.override);
    if (!override || typeof override !== "object") {
        return { mode: "inherit", preset: null };
    }
    const mode = ["inherit", "enabled", "disabled"].includes(override.mode)
        ? override.mode
        : "inherit";
    const preset = AI_PRESETS.includes(override.preset) ? override.preset : null;
    return { mode, preset };
}

/**
 * Unwrap a Token placeable to its TokenDocument.
 * @param {object} document
 * @returns {object}
 */
function _unwrapDocument(document) {
    if (!document || typeof document !== "object") return document;
    const inner = document.document;
    if (inner && typeof inner === "object" && inner.documentName === "Token") {
        return inner;
    }
    return document;
}

/**
 * Whether the document is absent or marked as deleted.
 * @param {object} doc
 * @returns {boolean}
 */
function _isMissing(doc) {
    if (!doc || typeof doc !== "object") return true;
    if (doc.destroyed === true || doc._destroyed === true) return true;
    return false;
}

/**
 * Detect the document kind from `documentName`, falling back to a structural
 * heuristic for plain fixture objects.
 * @param {object} doc
 * @returns {string|null} "combatant" | "token" | "actor" | null
 */
function _kindOf(doc) {
    const name = doc.documentName ?? doc.constructor?.documentName ?? "";
    if (name === "Combatant") return "combatant";
    if (name === "Token") return "token";
    if (name === "Actor") return "actor";
    if (name) return null;

    // Structural fallback: a Combatant carries both actor and token, a
    // TokenDocument carries actor only, an Actor carries neither.
    if ("actor" in doc && "token" in doc) return "combatant";
    if ("actor" in doc) return "token";
    if ("flags" in doc || "system" in doc || "type" in doc) return "actor";
    return null;
}

/**
 * Standard disabled result.
 * @returns {{enabled: boolean, preset: string|null, source: string}}
 */
function _disabledResult() {
    return { enabled: false, preset: null, source: "none" };
}
