/**
 * Per-preset tactic selector registry (issue #92).
 *
 * The registry is deliberately instance-local: the canonical instance is
 * published through `api.services` by `module.js`, while tests and headless
 * services may create isolated instances. It never touches `game` or Foundry
 * documents itself. Selectors are synchronous, pure and deterministic by
 * contract — the same input must produce the same serializable descriptor
 * (or null) and must not mutate any Document or input object.
 *
 * Registration record:
 * `{presetId, kind: "maneuver"|"overlay", priority, select}`.
 * Lower priority values evaluate first; equal priorities keep registration
 * order. In v1 `resolveTactic` considers only `maneuver` selectors and the
 * first non-null maneuver descriptor wins. `overlay` records are accepted as
 * the extension point for the object-assignment increment but do not win the
 * maneuver resolution yet.
 */

/** Selector kinds understood by the registry. */
export const TACTIC_KINDS = Object.freeze([
    "maneuver",
    "overlay"
]);

/** Default priority for ordinary maneuver selectors (lower wins). */
export const DEFAULT_TACTIC_PRIORITY = 100;

/**
 * Normalize the supported registration forms: the preferred single-record
 * form `{presetId, kind, priority, select}` and the issue-compatible shorthand
 * `(presetId, select, {kind?, priority?})`.
 * @param {string|object} presetId Preset id or registration record.
 * @param {Function} [select] Selector for the shorthand form.
 * @param {object} [options] Shorthand options.
 * @param {string} [options.kind] Selector kind.
 * @param {number} [options.priority] Evaluation priority.
 * @returns {{presetId: string, kind: string, priority: number, select: Function}}
 */
function _normalizeRegistration(presetId, select, options = {}) {
    const raw = presetId && typeof presetId === "object" && select === undefined
        ? presetId
        : {
            presetId,
            kind: options.kind,
            priority: options.priority,
            select
        };
    const id = raw?.presetId;
    if (typeof id !== "string" || id.trim() === "") {
        throw new Error("[only-war-ai] Tactic selector preset id must be a non-empty string");
    }
    if (typeof raw?.select !== "function") {
        throw new Error(`[only-war-ai] Tactic selector "${id}" requires a select function`);
    }
    const kind = raw.kind ?? "maneuver";
    if (!TACTIC_KINDS.includes(kind)) {
        throw new Error(`[only-war-ai] Tactic selector "${id}" kind must be "maneuver" or "overlay"`);
    }
    const priority = raw.priority ?? DEFAULT_TACTIC_PRIORITY;
    if (!Number.isFinite(priority)) {
        throw new Error(`[only-war-ai] Tactic selector "${id}" priority must be a finite number`);
    }
    return { presetId: id, kind, priority, select: raw.select };
}

/**
 * Compare selector slots in the deterministic evaluation order: priority
 * ascending, then registration order ascending.
 * @param {object} a First internal slot.
 * @param {object} b Second internal slot.
 * @returns {number}
 */
function _compareSlots(a, b) {
    return (a.record.priority - b.record.priority) || (a.order - b.order);
}

/**
 * Create an isolated tactic selector registry.
 * @returns {object} Registry with `registerTacticSelector`, `resolveTactic`,
 *   `listTacticSelectors` and `hasTacticSelectors`.
 */
export function createTacticRegistry() {
    /** `presetId → internal slots`; a slot wraps the public record with its registration order. */
    const selectors = new Map();
    let nextOrder = 0;

    /**
     * Slots of one preset in deterministic evaluation order.
     * @param {string} presetId Preset id.
     * @returns {object[]}
     */
    function _slots(presetId) {
        return selectors.get(presetId) ?? [];
    }

    /**
     * Register a tactic selector. Re-registering exactly the same selector
     * function with the same kind and priority is idempotent and returns the
     * original record. Re-using the same selector for the same preset/kind
     * with a different priority is an explicit error; distinct selector
     * functions may share a priority and are tie-broken by registration order.
     * @param {string|object} presetId Preset id or `{presetId, kind, priority, select}`.
     * @param {Function} [select] Pure selector `(input) => descriptor|null`.
     * @param {object} [options] Shorthand options `{kind, priority}`.
     * @returns {object} The frozen registration record.
     */
    function registerTacticSelector(presetId, select, options = {}) {
        const normalized = _normalizeRegistration(presetId, select, options);
        const slots = [..._slots(normalized.presetId)];
        const duplicate = slots.find(slot => slot.record.kind === normalized.kind
            && slot.record.select === normalized.select);
        if (duplicate) {
            if (duplicate.record.priority === normalized.priority) {
                return duplicate.record;
            }
            throw new Error(
                `[only-war-ai] Tactic selector for "${normalized.presetId}" is already registered`
            );
        }
        const record = Object.freeze({
            presetId: normalized.presetId,
            kind: normalized.kind,
            priority: normalized.priority,
            select: normalized.select
        });
        slots.push({ record, order: nextOrder++ });
        slots.sort(_compareSlots);
        selectors.set(normalized.presetId, slots);
        return record;
    }

    /**
     * Resolve the winning maneuver descriptor for a preset. Only `maneuver`
     * selectors participate in v1; `overlay` registrations remain dormant
     * extension points. A selector returning null/undefined/false yields to
     * the next selector. Errors thrown by selectors deliberately propagate —
     * callers such as the fireteam service own the degradation policy.
     * @param {string} presetId Preset id.
     * @param {object} [input] Selector input; passed through unchanged.
     * @returns {object|null} First non-null maneuver descriptor or null.
     */
    function resolveTactic(presetId, input = {}) {
        if (typeof presetId !== "string" || presetId.trim() === "") return null;
        for (const slot of _slots(presetId)) {
            const { record } = slot;
            if (record.kind !== "maneuver") continue;
            const descriptor = record.select(input);
            if (descriptor === null || descriptor === undefined || descriptor === false) continue;
            if (typeof descriptor !== "object" || typeof descriptor.then === "function") {
                throw new Error(
                    `[only-war-ai] Tactic selector for "${presetId}" must return an object descriptor or null`
                );
            }
            return descriptor;
        }
        return null;
    }

    /**
     * List registered selector records in deterministic evaluation order.
     * Without a preset id, selectors of every preset are listed in preset
     * registration order.
     * @param {string|null} [presetId] Preset id or null for all presets.
     * @returns {object[]} Frozen registration records.
     */
    function listTacticSelectors(presetId = null) {
        if (typeof presetId === "string") {
            return _slots(presetId).map(slot => slot.record);
        }
        return [...selectors.values()]
            .flatMap(slots => slots.map(slot => slot.record));
    }

    /**
     * Whether a preset has at least one registered selector, optionally of a
     * specific kind.
     * @param {string} presetId Preset id.
     * @param {string|null} [kind] Optional selector kind filter.
     * @returns {boolean}
     */
    function hasTacticSelectors(presetId, kind = null) {
        return _slots(presetId).some(slot => kind === null || slot.record.kind === kind);
    }

    return Object.freeze({
        registerTacticSelector,
        resolveTactic,
        listTacticSelectors,
        hasTacticSelectors
    });
}
