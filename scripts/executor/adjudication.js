/**
 * Executor decomposition (issue #407 follow-up): extracted verbatim from
 * scripts/executor.js — see that file for the design contract. Sub-factory
 * env objects destructure to the identifiers the moved code already used.
 */
import {
    MODULE_ID
} from "../constants.js";
import {
    ADJUDICATION_ACTIONS
} from "./contract.js";
import {
    _list
} from "./util.js";

/**
 * The createAdjudication sub-factory — an extracted block of
 * createExecutorService (issue #407). The env object carries the closure
 * identifiers the moved code referenced: shared state maps, service
 * lookups and sibling helpers wired in executor.js.
 * @param {object} [env]
 * @param {*} [env.adjudicationTimeout] Closure dependency.
 * @param {*} [env.pendingAdjudications] Closure dependency.
 * @returns {object} Block handlers.
 */
export function createAdjudication({
    adjudicationTimeout,
    pendingAdjudications
} = {}) {

    /**
     * Resolve a pending adjudication request — the single decision entry
     * point called by the GM card buttons and integrations. Unknown
     * request ids and unsupported actions are ignored; the resolve is
     * idempotent (the pending entry is deleted on first resolve).
     * @param {string} requestId Pending request id.
     * @param {string|object} action One of {@link ADJUDICATION_ACTIONS}
     *   or a `{action, reason?}` record.
     * @returns {boolean} Whether a pending request was resolved.
     */
    function resolveAdjudication(requestId, action) {
        const pending = pendingAdjudications.get(requestId);
        if (!pending) return false;
        const verdict = typeof action === "object" && action !== null
            ? { action: action.action, reason: action.reason ?? null }
            : { action, reason: null };
        if (!ADJUDICATION_ACTIONS.includes(verdict.action)) return false;
        clearTimeout(pending.timer);
        pendingAdjudications.delete(requestId);
        pending.resolve(verdict);
        return true;
    }


    /**
     * GM whisper recipients for the adjudication card.
     * @returns {string[]} User ids.
     */
    function _gmWhisper() {
        return _list(globalThis.game?.users)
            .filter(user => user?.isGM)
            .map(user => user.id);
    }


    /**
     * Localize helper tolerating early init states.
     * @param {string} key
     * @param {object} [data] Format data.
     * @returns {string}
     */
    function _localize(key, data = null) {
        const i18n = globalThis.game?.i18n;
        if (data && typeof i18n?.format === "function") return i18n.format(key, data);
        return i18n?.localize?.(key) ?? key;
    }


    /**
     * HTML content of the GM adjudication card: the step summary plus the
     * four decision buttons (`data-ow-ai-adjudicate` marks them for the
     * `renderChatMessage` binding).
     * @param {object} request Pending request `{id, stepId, step, plan}`.
     * @param {object} context Execution context.
     * @returns {string}
     */
    function _adjudicationCard(request, context) {
        const step = request.step ?? {};
        const input = step.input ?? {};
        const title = _localize("OWAI.Adjudication.Title");
        const detail = _localize("OWAI.Adjudication.Detail", {
            name: request.combatant?.name ?? "NPC",
            action: input.name ?? input.actionId ?? step.id ?? "—"
        });
        const button = key =>
            `<button type="button" data-ow-ai-adjudicate="${key}">`
            + `${_localize(`OWAI.Adjudication.${key}`)}</button>`;
        const buttons = ADJUDICATION_ACTIONS.map(button).join("");
        return `<div class="ow-ai-adjudication" data-ow-ai-adjudication="${request.id}">`
            + `<p><strong>${title}</strong> ${detail}</p>`
            + `<div class="ow-ai-adjudication-buttons">${buttons}</div></div>`;
    }


    /**
     * Ask the GM how to resolve an irreversible step (issue #37). An
     * injected `context.adjudication` resolver wins (tests, integrations);
     * otherwise a whispered `ChatMessage` card with decision buttons is
     * posted and the gate waits for {@link resolveAdjudication} — a turn
     * transition auto-cancels the pending gate via `updateCombat`. When
     * the chat channel is unavailable the step executes (the documented
     * safe default: adjudication cannot park the combat).
     * @param {object} step Irreversible step (`attack`/`test`).
     * @param {object} context Execution context.
     * @param {object} run Shared execution state.
     * @returns {Promise<object>} `{action, reason?}` decision.
     */
    async function _adjudicate(step, context, run) {
        const request = {
            id: `${run.operationId}.${step.id}.adjudication`,
            operationId: run.operationId,
            stepId: step.id,
            step,
            planId: run.plan?.id ?? null,
            combatant: run.combatant
        };
        if (typeof context.adjudication === "function") {
            try {
                const verdict = await context.adjudication(request);
                const action = typeof verdict === "object" && verdict !== null
                    ? verdict.action : verdict;
                return ADJUDICATION_ACTIONS.includes(action)
                    ? { action, reason: verdict?.reason ?? null }
                    : { action: "execute" };
            } catch(err) {
                return { action: "cancel", reason: String(err?.message ?? err) };
            }
        }
        if (typeof globalThis.ChatMessage?.create !== "function") {
            // No chat channel (headless/test harness): fail closed —
            // a `gm-confirm` world asked for a decision and cannot be
            // asked, so the turn goes back to manual GM control rather
            // than executing irreversible rolls unattended (issue #52).
            return { action: "cancel", reason: "adjudication-unavailable" };
        }
        const requestId = request.id;
        const pending = new Promise(resolve => {
            const entry = {
                resolve, request, timer: null,
                combatId: context.combat?.id ?? null
            };
            const seconds = Number(adjudicationTimeout());
            if (Number.isFinite(seconds) && seconds > 0) {
                // Issue #52: a GM who never answers cannot park the
                // combat — the gate resolves itself as a cancel, handing
                // the turn back to manual control.
                entry.timer = setTimeout(() => {
                    pendingAdjudications.delete(requestId);
                    resolve({ action: "cancel", reason: "adjudication-timeout" });
                }, seconds * 1000);
            }
            pendingAdjudications.set(requestId, entry);
        });
        try {
            await globalThis.ChatMessage.create({
                content: _adjudicationCard(request, context),
                whisper: _gmWhisper(),
                speaker: { alias: "Only War AI" },
                flags: { [MODULE_ID]: { adjudication: requestId } }
            });
        } catch(err) {
            const entry = pendingAdjudications.get(requestId);
            clearTimeout(entry?.timer);
            pendingAdjudications.delete(requestId);
            return { action: "cancel", reason: "adjudication-unavailable" };
        }
        return pending;
    }

    return {
        resolveAdjudication,
        _gmWhisper,
        _localize,
        _adjudicationCard,
        _adjudicate
    };
}
