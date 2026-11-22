/**
 * AI chat barks (issue #26): short localized phrases that telegraph the
 * bots' intentions to the table — emitted when a fireteam's morale tier
 * changes and when a bot commits to a multi-turn plan.
 *
 * Design contract (epic #363):
 * - GM-only by default: barks are whispered to every GM user; the
 *   `barksToPlayers` world setting widens the audience for drama.
 * - Controller-only: callers already passed the authority gate, the
 *   helper itself only guards on the `aiBarks` setting and the presence
 *   of a chat channel.
 * - Never spams: callers emit a bark only on a *committed* tier
 *   transition (the hysteresis already deduplicates it) and on a fresh
 *   committed-plan write; per-round dedup keys live in the callers so a
 *   replan/rebuild never repeats a phrase.
 * - Pure client-side theatre: nothing is written to documents, a
 *   missing `ChatMessage`/i18n degrades to a silent no-op.
 */
import { MODULE_ID } from "./constants.js";
import { barksToPlayers, isBarksEnabled } from "./settings.js";

/**
 * Normalize a Foundry collection/Map/array/iterable into a plain array.
 * @param {*} collection
 * @returns {object[]}
 */
function _list(collection) {
    if (!collection) return [];
    if (Array.isArray(collection)) return collection;
    if (Array.isArray(collection.contents)) return collection.contents;
    if (typeof collection.values === "function") return [...collection.values()];
    if (typeof collection[Symbol.iterator] === "function") return [...collection];
    return [];
}

/**
 * Localize a bark key with format data, tolerating early-init i18n.
 * @param {string} key i18n key.
 * @param {object} [data] Format data.
 * @returns {string}
 */
export function barkText(key, data = null) {
    const i18n = globalThis.game?.i18n;
    if (data && typeof i18n?.format === "function") {
        try {
            const text = i18n.format(key, data);
            if (typeof text === "string" && text && text !== key) return text;
        } catch(_err) {
            // Fall through to the plain localize.
        }
    }
    try {
        const text = i18n?.localize?.(key);
        if (typeof text === "string" && text && text !== key) return text;
    } catch(_err) {
        // Fall through to the raw key fallback.
    }
    return data ? `${key} ${JSON.stringify(data)}` : key;
}

/**
 * GM whisper recipients for barks (every GM user id).
 * @returns {string[]}
 */
export function gmWhisper() {
    return _list(globalThis.game?.users)
        .filter(user => user?.isGM)
        .map(user => user.id);
}

/**
 * Whether a bark may be emitted for this call: the `aiBarks` world
 * setting leads, `context.barks === false` is the per-call kill switch
 * (tests, integrations).
 * @param {object} [context]
 * @param {boolean} [context.barks] `false` disables this emission.
 * @returns {boolean}
 */
export function barksEnabled(context = {}) {
    if (context?.barks === false) return false;
    return isBarksEnabled();
}

/**
 * Emit one chat bark. GM whisper by default; `barksToPlayers` (or the
 * injected `context.toPlayers`) posts it to the whole table. Returns
 * `true` when a message was created, `false` on every degrade path —
 * the chat theatre never blocks a turn.
 * @param {object} input
 * @param {string} input.key i18n key of the phrase.
 * @param {object} [input.data] Format data.
 * @param {string} [input.speaker] Speaker alias (NPC/team name).
 * @param {object} [input.context] `{barks?: boolean, toPlayers?:
 *   boolean}` — per-call overrides.
 * @param {object} [input.flags] Extra `flags["only-war-ai"]` payload
 *   stamped on the message (trace/debug metadata).
 * @returns {Promise<boolean>}
 */
export async function emitBark({ key, data = null, speaker = "Only War AI",
    context = {}, flags = null } = {}) {
    if (!barksEnabled(context)) return false;
    const create = globalThis.ChatMessage?.create;
    if (typeof create !== "function") return false;
    const toPlayers = context?.toPlayers === true || barksToPlayers();
    const content = `<p>${barkText(key, data)}</p>`;
    try {
        await create({
            content,
            speaker: { alias: speaker ?? "Only War AI" },
            whisper: toPlayers ? [] : gmWhisper(),
            flags: {
                [MODULE_ID]: {
                    bark: key,
                    ...(flags && typeof flags === "object" ? flags : {})
                }
            }
        });
        return true;
    } catch(_err) {
        return false;
    }
}

/**
 * Emit a bark at most once per dedup key inside a mutable `Set`
 * (round/team dedup — a replan in the same round never repeats the
 * phrase). The caller keeps the set per service instance.
 * @param {Set} seen Dedup set owned by the caller.
 * @param {string} dedupKey Stable key for this bark event.
 * @param {object} input `emitBark` input without `key` semantics.
 * @returns {Promise<boolean>}
 */
export async function emitBarkOnce(seen, dedupKey, input) {
    const key = String(dedupKey ?? "");
    if (seen.has(key)) return false;
    const emitted = await emitBark(input);
    if (emitted) seen.add(key);
    return emitted;
}
