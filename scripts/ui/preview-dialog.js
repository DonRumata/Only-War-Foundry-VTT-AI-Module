/**
 * GM plan preview UI (issue #409): a modal summary of a serialized planner
 * plan with Confirm / Cancel / Replan controls, a configurable auto-cancel
 * timeout and live stale-snapshot watching.
 *
 * Design contract (epic #363, issues #400/#403/#407):
 * - Only the elected controller client opens the dialog, and only while
 *   `executionMode === "preview"`. The entry point is the
 *   `only-war-ai.previewRequested` hook emitted by the executor when an
 *   operation parks in `awaiting-preview`; `only-war-ai.phaseChanged`
 *   (authority, issue #400) closes previews resolved elsewhere.
 * - `resolvePreview(operationId, decision)` is the single decision API —
 *   the dialog buttons, the auto-timeout and external integrations all go
 *   through it. `confirm` re-validates the plan snapshot (a stale plan is
 *   never executed), transitions the authority operation to `executing`
 *   when the operations service is available and launches
 *   `executor.executePlan`.
 * - `cancel`/`preview-timeout` close the operation as `cancelled` without
 *   touching documents and keep the combat turn under manual GM control —
 *   the turn is never advanced implicitly.
 * - `replan` asks the planner for a fresh plan from live state (bounded by
 *   the shared `planner.maxReplans` budget) and re-renders the dialog.
 * - `previewTimeoutSeconds` (world setting, default 60, 0 disables) bounds
 *   how long an undecided preview may hold the combat.
 * - Document hooks re-validate every open preview: `combat-ended` and
 *   `turn-stale` auto-cancel; other stale reasons disable Confirm until
 *   the GM replans or cancels. Closing the window without a decision
 *   cancels — never confirms.
 */
import { MODULE_ID, MORALE_TIERS } from "../constants.js";
import { planIntentOf } from "../layers.js";
import { isModuleEnabled } from "../module-state.js";
import { STALE_REASONS } from "../planner.js";
import { buildLayerTrace, renderTrace } from "../trace.js";
import {
    getCenterOnBot,
    getExecutionMode,
    getPreviewTimeoutSeconds,
    getTraceMode,
    isDiagnosticsEnabled,
    logDiagnostics
} from "../settings.js";
import { centerOnToken } from "./plan-overlay.js";

/** GM decisions accepted by {@link resolvePreview}. */
export const PREVIEW_DECISIONS = Object.freeze({
    confirm: "confirm",
    cancel: "cancel",
    replan: "replan"
});

/** Stable reason codes produced by the preview controller itself. */
export const PREVIEW_REASONS = Object.freeze({
    timeout: "preview-timeout",
    dialogClosed: "dialog-closed",
    gmCancelled: "gm-cancelled",
    noPreview: "no-preview",
    notController: "not-controller",
    moduleDisabled: "module-disabled",
    automaticMode: "automatic-mode",
    invalidPlan: "invalid-plan",
    alreadyResolved: "already-resolved",
    noPlanner: "no-planner",
    planFailed: "plan-failed",
    replanLimit: "replan-limit-exceeded",
    stale: "stale"
});

/**
 * Stale reasons that end the AI turn outright: replanning is meaningless
 * once the combat advanced or ended, so the preview auto-cancels.
 */
const TURN_ENDING_STALE = Object.freeze(new Set([
    STALE_REASONS.turnStale,
    STALE_REASONS.combatEnded,
    STALE_REASONS.invalidPlan
]));

/**
 * I18n keys for planner stale reasons shown inside the
 * `OWAI.Preview.Stale` banner — `{reason}` interpolates with the
 * localized label, falling back to the raw code for unmapped reasons.
 */
const STALE_REASON_LABEL_KEYS = Object.freeze({
    [STALE_REASONS.turnStale]: "OWAI.STALE.TURN_STALE",
    [STALE_REASONS.tokenMoved]: "OWAI.STALE.TOKEN_MOVED",
    [STALE_REASONS.targetGone]: "OWAI.STALE.TARGET_GONE",
    [STALE_REASONS.resourcesChanged]: "OWAI.STALE.RESOURCES_CHANGED",
    [STALE_REASONS.collisionChanged]: "OWAI.STALE.COLLISION_CHANGED",
    [STALE_REASONS.statusesChanged]: "OWAI.STALE.STATUS_CHANGED",
    [STALE_REASONS.combatEnded]: "OWAI.STALE.COMBAT_ENDED",
    [STALE_REASONS.invalidPlan]: "OWAI.STALE.INVALID_PLAN",
    [STALE_REASONS.stale]: "OWAI.STALE.STALE"
});

/** Document hooks whose changes may invalidate an open preview. */
const STALE_WATCH_HOOKS = Object.freeze([
    "updateToken",
    "createToken",
    "deleteToken",
    "updateActor",
    "updateCombatant",
    "deleteCombatant",
    "updateCombat",
    "deleteCombat",
    "createWall",
    "updateWall",
    "deleteWall",
    "updateScene"
]);

/** Cap on diagnostics rows rendered inside the dialog. */
const MAX_DIAGNOSTICS_ROWS = 20;
const MAX_RANKING_ROWS = 10;

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
 * Unwrap a Token placeable to its TokenDocument; documents pass through.
 * @param {*} token
 * @returns {object|null}
 */
function _tokenDoc(token) {
    if (!token || typeof token !== "object") return null;
    const doc = token.document;
    if (doc && typeof doc === "object" && doc.documentName === "Token") return doc;
    return token;
}

/**
 * Actor linked to a combatant or token.
 * @param {*} ref
 * @returns {object|null}
 */
function _actorOf(ref) {
    if (!ref || typeof ref !== "object") return null;
    if (ref.actor && typeof ref.actor === "object") return ref.actor;
    if (ref.documentName === "Actor") return ref;
    if ("system" in ref && !("token" in ref)) return ref;
    return null;
}

/**
 * Numeric helper: value when finite, otherwise fallback.
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function _finiteOr(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}

/**
 * Find a combatant of the combat by its own id.
 * @param {object} combat
 * @param {string|null} combatantId
 * @returns {object|null}
 */
function _findCombatant(combat, combatantId) {
    if (!combatantId) return null;
    const collection = combat?.combatants;
    if (collection && typeof collection.get === "function") {
        const hit = collection.get(combatantId);
        if (hit) return hit;
    }
    for (const entry of _list(collection)) {
        if (entry?.id === combatantId) return entry;
    }
    return null;
}

/**
 * Find a combatant of the combat by its token id.
 * @param {object} combat
 * @param {string|null} tokenId
 * @returns {object|null}
 */
function _findCombatantByToken(combat, tokenId) {
    if (!tokenId) return null;
    for (const entry of _list(combat?.combatants)) {
        const doc = _tokenDoc(entry?.token);
        if ((entry?.tokenId ?? doc?.id) === tokenId) return entry;
    }
    return null;
}

/**
 * Find a token document by id on the combat scene (or the active canvas).
 * @param {string|null} tokenId
 * @param {object} context `{combat?, scene?}`.
 * @returns {object|null}
 */
function _findTokenDoc(tokenId, context = {}) {
    if (!tokenId) return null;
    const combatant = _findCombatantByToken(context.combat, tokenId);
    if (combatant?.token) return _tokenDoc(combatant.token);
    const collection = context.scene?.tokens ?? context.combat?.scene?.tokens
        ?? globalThis.canvas?.tokens;
    if (collection && typeof collection.get === "function") {
        const hit = collection.get(tokenId);
        if (hit) return _tokenDoc(hit);
    }
    for (const entry of _list(collection)) {
        const doc = _tokenDoc(entry);
        if (doc?.id === tokenId) return doc;
    }
    return null;
}

/**
 * Build a plain, serializable view-model out of a planner plan. Contains
 * only data the dialog template renders — never Document references.
 * @param {object} plan Serialized planner plan.
 * @param {object} [context]
 * @param {object|null} [context.combat] Live combat document.
 * @param {object|null} [context.combatant] Active combatant document.
 * @param {object|null} [context.operation] Authority operation.
 * @param {string|null} [context.operationId] Operation id fallback.
 * @param {boolean} [context.diagnosticsEnabled] Show diagnostics section.
 * @param {number} [context.maxReplans] Replan budget for the turn.
 * @param {string|null} [context.stale] Stale reason banner, if any.
 * @param {number|null} [context.timeoutSeconds] Auto-cancel countdown.
 * @returns {object} Serializable view-model.
 */
export function buildPreviewViewModel(plan, context = {}) {
    const snapshot = plan?.snapshot ?? {};
    const rawSteps = Array.isArray(plan?.steps) ? plan.steps : [];
    const steps = rawSteps.map(step => ({
        id: step?.id ?? null,
        type: step?.type ?? null,
        name: step?.input?.name ?? null,
        // Issue #38: a delay step explains its wait condition — the reason
        // and the `until` signal it holds for. Localized in
        // `localizePreviewViewModel` — the base model stays i18n-free.
        detail: step?.type === "delay"
            ? {
                reason: step?.input?.reason ?? null,
                until: step?.input?.until ?? null
            }
            : null
    }));

    // Merge the projected resource deltas of all steps into one summary.
    const projected = {};
    for (const step of rawSteps) {
        for (const [key, value] of Object.entries(step?.projectedResourceDelta ?? {})) {
            projected[key] = _finiteOr(projected[key], 0) + _finiteOr(value, 0);
        }
    }
    const resources = Object.entries(projected)
        .filter(([, value]) => value !== 0)
        .map(([key, value]) => ({ key, value }))
        .sort((a, b) => a.key.localeCompare(b.key));

    const combat = context.combat ?? null;
    const combatant = context.combatant
        ?? _findCombatant(combat, snapshot.combatantId);
    const token = _tokenDoc(combatant?.token);
    const actor = _actorOf(combatant) ?? _actorOf(token);
    const npc = {
        name: combatant?.name ?? token?.name ?? actor?.name ?? null,
        img: actor?.img ?? token?.texture?.src ?? null,
        preset: plan?.preset ?? null,
        replanCount: _finiteOr(plan?.replanCount, 0),
        // Issue #19: resolved bot personality shown in the preview.
        traits: Array.isArray(plan?.personality?.traits)
            ? [...plan.personality.traits] : [],
        character: plan?.personality?.character ?? null,
        personalitySource: plan?.personality?.source ?? null
    };

    const targetId = snapshot.target?.tokenId ?? null;
    const targetCombatant = _findCombatantByToken(combat, targetId);
    const targetDoc = _findTokenDoc(targetId, { combat, scene: context.scene });
    const targetSnapshot = Array.isArray(snapshot.targets)
        ? snapshot.targets.find(t => t?.tokenId === targetId)
        : null;
    const target = snapshot.target
        ? {
            tokenId: targetId,
            name: targetCombatant?.name ?? targetDoc?.name ?? targetId,
            x: snapshot.target.x ?? null,
            y: snapshot.target.y ?? null,
            distance: Number.isFinite(targetSnapshot?.distance)
                ? targetSnapshot.distance
                : (Number.isFinite(snapshot.target.distance) ? snapshot.target.distance : null)
        }
        : null;

    const actionStep = rawSteps.find(s => s?.type === "attack" || s?.type === "test");
    const actionInput = actionStep?.input ?? {};
    const targetNumber = actionInput.targetNumber ?? actionInput.tn;
    const action = actionStep
        ? {
            id: actionStep.id ?? null,
            type: actionStep.type,
            name: actionInput.name ?? actionInput.actionId ?? null,
            mode: actionInput.mode ?? null,
            attackType: actionInput.attackType ?? null,
            // Localized in localizePreviewViewModel — the base model
            // stays free of i18n so it remains serializable.
            attackTypeLabel: null,
            range: Number.isFinite(actionInput.range) ? actionInput.range : null,
            targetNumber: Number.isFinite(targetNumber) ? targetNumber : null,
            itemUuid: actionInput.itemUuid ?? null
        }
        : null;

    const moveStep = rawSteps.find(s => s?.type === "move");
    let route = null;
    if (moveStep) {
        const to = moveStep.input?.to ?? moveStep.input?.destination ?? null;
        const rawWaypoints = Array.isArray(moveStep.input?.waypoints)
            ? moveStep.input.waypoints
            : [];
        const points = rawWaypoints
            .filter(p => Number.isFinite(p?.x) && Number.isFinite(p?.y))
            .map(p => ({ x: p.x, y: p.y }));
        if (Number.isFinite(to?.x) && Number.isFinite(to?.y)) {
            const last = points[points.length - 1];
            if (!last || last.x !== to.x || last.y !== to.y) {
                points.push({ x: to.x, y: to.y });
            }
        }
        route = {
            points,
            cost: _finiteOr(moveStep.cost?.movement, Math.abs(_finiteOr(projected.movement, 0))),
            approximate: moveStep.input?.approximate === true
        };
    }

    const contributions = plan?.breakdown?.contributions ?? {};
    const breakdown = Object.entries(contributions)
        .filter(([, value]) => Number.isFinite(value) && value !== 0)
        .map(([factor, value]) => ({ factor, value }))
        .sort((a, b) => (Math.abs(b.value) - Math.abs(a.value))
            || a.factor.localeCompare(b.factor));

    const rawDiagnostics = plan?.diagnostics ?? {};
    // Issue #26 intent telegraphing: the compact step-type chain of the
    // plan (`move → attack`) plus the morale tiers the L2 layer stamped
    // on the diagnostics — `localizePreviewViewModel` turns both into
    // display strings.
    const intent = planIntentOf(plan);
    const rawMorale = rawDiagnostics.morale;
    const morale = rawMorale?.enabled === true && rawMorale?.tier != null
        ? {
            tier: MORALE_TIERS.includes(rawMorale.tier) ? rawMorale.tier : null,
            effectiveTier: MORALE_TIERS.includes(rawMorale.effectiveTier)
                ? rawMorale.effectiveTier : null
        }
        : null;
    const diagnostics = {
        enabled: context.diagnosticsEnabled === true,
        rejected: (Array.isArray(rawDiagnostics.rejected) ? rawDiagnostics.rejected : [])
            .slice(0, MAX_DIAGNOSTICS_ROWS)
            .map(r => ({ candidate: r?.candidate ?? null, reason: r?.reason ?? null })),
        ranking: (Array.isArray(rawDiagnostics.ranking) ? rawDiagnostics.ranking : [])
            .slice(0, MAX_RANKING_ROWS)
            .map(r => ({
                candidate: r?.candidate ?? null,
                score: Number.isFinite(r?.score) ? r.score : null
            })),
        candidatesCount: _finiteOr(rawDiagnostics.candidatesCount, 0),
        chosenStep: rawDiagnostics.chosenStep ?? null
    };
    // Issue #27: the "How it decided" trace block — the materialized
    // per-layer entries (or the on-the-fly derivation for pre-#27
    // plans); `aiTraceVerbose` picks the compact/full render mode at
    // display time. Entries stay raw here; `localizePreviewViewModel`
    // renders them into display lines.
    const trace = Array.isArray(rawDiagnostics.trace)
        ? rawDiagnostics.trace
        : buildLayerTrace(rawDiagnostics);

    const maxReplans = Number.isFinite(context.maxReplans) ? context.maxReplans : 1;
    const replanCount = _finiteOr(plan?.replanCount, 0);

    return {
        planId: plan?.id ?? null,
        operationId: context.operation?.id ?? context.operationId
            ?? plan?.operationId ?? null,
        npc,
        preset: plan?.preset ?? null,
        score: Number.isFinite(plan?.score) ? plan.score : null,
        hasScore: Number.isFinite(plan?.score),
        target,
        action,
        route,
        steps,
        resources,
        breakdown,
        intent,
        morale,
        diagnostics,
        trace,
        traceMode: context.traceMode ?? getTraceMode(),
        replan: {
            allowed: replanCount < maxReplans,
            count: replanCount,
            max: maxReplans
        },
        stale: context.stale ?? null,
        timeoutSeconds: Number.isFinite(context.timeoutSeconds) && context.timeoutSeconds > 0
            ? context.timeoutSeconds
            : null
    };
}

/**
 * Localize a key, falling back when i18n is unavailable or the key is
 * unknown (Foundry echoes the key back for missing entries).
 * @param {object|null} i18n `game.i18n`-compatible object.
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function _label(i18n, key, fallback) {
    const value = i18n?.localize?.(key);
    return typeof value === "string" && value && value !== key ? value : fallback;
}

/**
 * Joined personality display string for the preview summary:
 * localized trait labels plus the fireteam character in parentheses
 * (issue #19). Null when the plan carries no personality at all.
 * @param {object} npc `npc` block of {@link buildPreviewViewModel}.
 * @param {object|null} i18n `game.i18n`-compatible object.
 * @returns {string|null}
 */
function _personalityLabel(npc, i18n) {
    const traits = (npc?.traits ?? []).map(trait =>
        _label(i18n, `OWAI.Personality.${trait}`, trait));
    const character = npc?.character
        ? _label(i18n, `OWAI.FireteamCharacter.${npc.character}`, npc.character)
        : null;
    if (!traits.length && !character) return null;
    return character
        ? `${traits.join(", ")} (${character})`.trim()
        : traits.join(", ");
}

/**
 * Decorate a view-model with localized labels for the template. The raw
 * model stays untouched so it remains serializable; the returned copy is
 * what the Application renders.
 * @param {object} vm {@link buildPreviewViewModel} output.
 * @param {object|null} [i18n] `game.i18n`-compatible object.
 * @returns {object} View-model plus `*Label` fields.
 */
export function localizePreviewViewModel(vm, i18n = null) {
    const i18nSource = i18n ?? globalThis.game?.i18n ?? null;
    return {
        ...vm,
        title: _label(i18nSource, "OWAI.Preview.Title", "AI plan preview"),
        npc: vm.npc
            ? {
                ...vm.npc,
                presetLabel: _label(
                    i18nSource, `OWAI.Preset.${vm.npc.preset}`, vm.npc.preset ?? "—"
                ),
                // Issue #19: localized trait/character labels, joined for
                // the summary row.
                traitLabels: (vm.npc.traits ?? []).map(trait => _label(
                    i18nSource, `OWAI.Personality.${trait}`, trait
                )),
                characterLabel: vm.npc.character
                    ? _label(
                        i18nSource,
                        `OWAI.FireteamCharacter.${vm.npc.character}`,
                        vm.npc.character
                    )
                    : null,
                personalityLabel: _personalityLabel(vm.npc, i18nSource)
            }
            : vm.npc,
        action: vm.action
            ? {
                ...vm.action,
                typeLabel: _label(
                    i18nSource, `OWAI.Preview.Step.${vm.action.type}`, vm.action.type
                ),
                attackTypeLabel: vm.action.attackType
                    ? _label(
                        i18nSource,
                        `OWAI.AttackType.${vm.action.attackType}`,
                        vm.action.attackType
                    )
                    : null
            }
            : vm.action,
        steps: (vm.steps ?? []).map(step => ({
            ...step,
            label: _label(i18nSource, `OWAI.Preview.Step.${step.type}`, step.type ?? "?"),
            detailLabel: step.detail
                ? (i18nSource?.format?.("OWAI.Delay.Detail", {
                    reason: _label(
                        i18nSource,
                        `OWAI.Delay.Reason.${step.detail.reason}`,
                        step.detail.reason ?? "—"),
                    until: _label(
                        i18nSource,
                        `OWAI.Delay.Until.${step.detail.until}`,
                        step.detail.until ?? "—")
                }) ?? null)
                : null
        })),
        resources: (vm.resources ?? []).map(entry => ({
            ...entry,
            label: _label(i18nSource, `OWAI.Preview.Resource.${entry.key}`, entry.key)
        })),
        breakdown: (vm.breakdown ?? []).map(entry => ({
            ...entry,
            label: _label(i18nSource, `OWAI.Preview.Factor.${entry.factor}`, entry.factor)
        })),
        // Issue #26: localized intent chain + morale tier labels.
        intentLabel: (vm.intent?.steps ?? []).length
            ? vm.intent.steps
                .map(type => _label(i18nSource, `OWAI.Preview.Step.${type}`, type))
                .join(" → ")
            : null,
        morale: vm.morale
            ? {
                ...vm.morale,
                tierLabel: vm.morale.tier
                    ? _label(i18nSource, `OWAI.Morale.${vm.morale.tier}`, vm.morale.tier)
                    : null,
                effectiveTierLabel: vm.morale.effectiveTier
                        && vm.morale.effectiveTier !== vm.morale.tier
                    ? _label(
                        i18nSource,
                        `OWAI.Morale.${vm.morale.effectiveTier}`,
                        vm.morale.effectiveTier)
                    : null
            }
            : vm.morale,
        staleLabel: vm.stale
            ? (i18nSource?.format?.("OWAI.Preview.Stale", {
                reason: _label(i18nSource, STALE_REASON_LABEL_KEYS[vm.stale] ?? "", vm.stale)
            }) ?? vm.stale)
            : null,
        timeoutLabel: vm.timeoutSeconds
            ? (i18nSource?.format?.("OWAI.Preview.Timeout", { seconds: vm.timeoutSeconds }) ?? null)
            : null,
        // Issue #27: rendered per-layer trace lines for the "How it
        // decided" collapsible block (compact/full per traceMode).
        traceLines: renderTrace(vm.trace ?? [], {
            i18n: i18nSource,
            mode: vm.traceMode
        })
    };
}

/**
 * Create the `preview` controller published as
 * `api.services.get("preview")` (issue #409). Holds the pending preview
 * sessions keyed by operation id and resolves GM decisions. The dialog
 * itself is injected through `present` so the controller stays testable
 * without a Foundry Application.
 * @param {object} [deps]
 * @param {object} [deps.api] Module API for lazy service lookups.
 * @param {Function} [deps.getMode] `() => "automatic"|"preview"`.
 * @param {Function} [deps.getTimeout] `() => seconds` (0 disables).
 * @param {Function} [deps.diagnostics] Diagnostics-enabled predicate.
 * @param {Function} [deps.isController] Controller predicate override.
 * @param {Function} [deps.present] `(session, viewModel) => {render, close}`.
 * @param {object} [deps.i18n] `game.i18n`-compatible override.
 * @param {Function} [deps.setTimer] `setTimeout` replacement.
 * @param {Function} [deps.clearTimer] `clearTimeout` replacement.
 * @param {object} [deps.planContext] Extra `planTurn` context for replans.
 * @param {number} [deps.maxReplans] Replan budget override.
 * @param {Function} [deps.log] Diagnostic logger.
 * @returns {object} Preview controller.
 */
export function createPreviewController({
    api = null,
    getMode = getExecutionMode,
    getTimeout = getPreviewTimeoutSeconds,
    diagnostics = isDiagnosticsEnabled,
    isController = null,
    present = null,
    i18n = null,
    setTimer = null,
    clearTimer = null,
    planContext = null,
    maxReplans = null,
    log = (...args) => logDiagnostics(...args)
} = {}) {
    /** Operation id → pending preview session. */
    const pending = new Map();

    const _setTimer = typeof setTimer === "function"
        ? setTimer
        : (fn, ms) => (typeof globalThis.setTimeout === "function"
            ? globalThis.setTimeout(fn, ms)
            : null);
    const _clearTimer = typeof clearTimer === "function"
        ? clearTimer
        : id => {
            if (typeof globalThis.clearTimeout === "function") globalThis.clearTimeout(id);
        };

    /**
     * Lazy service lookup: session/context override first, then registry.
     * @param {string} name
     * @param {*} override Injected service (undefined = registry).
     * @returns {object|null}
     */
    function _service(name, override) {
        if (override !== undefined && override !== null) return override;
        try {
            return api?.services?.get?.(name) ?? null;
        } catch(err) {
            return null;
        }
    }

    /**
     * Whether this client may decide a preview. The authority service
     * (#400) wins when it answers; otherwise any GM client may. Guards
     * against spoofed `resolvePreview` calls from non-controller clients.
     * @returns {boolean}
     */
    function _isController() {
        if (typeof isController === "function") {
            const verdict = isController();
            if (typeof verdict === "boolean") return verdict;
        }
        const authority = _service("authority");
        const verdict = authority?.isController?.();
        if (typeof verdict === "boolean") return verdict;
        return globalThis.game?.user?.isGM === true;
    }

    /**
     * Operations service: session override first, then the authority
     * service, then a directly registered `operations` service.
     * @param {object} session
     * @returns {object|null}
     */
    function _operations(session) {
        if (session?.operations) return session.operations;
        const authority = _service("authority", session?.authority);
        return authority?.operations ?? _service("operations") ?? null;
    }

    /**
     * Localized i18n source.
     * @returns {object|null}
     */
    function _i18n() {
        return i18n ?? globalThis.game?.i18n ?? null;
    }

    /**
     * GM-facing notification, best-effort.
     * @param {"info"|"warn"|"error"} type
     * @param {string} key i18n key.
     * @param {object} data Format data.
     */
    function _notify(type, key, data) {
        try {
            const message = _i18n()?.format?.(key, data) ?? `${key} ${JSON.stringify(data)}`;
            globalThis.ui?.notifications?.[type]?.(message);
        } catch(err) {
            // Notifications are best-effort.
        }
    }

    /**
     * Plan-overlay service: session override first, then the registry
     * (issue #29 — the GM-only canvas visualization of the previewed
     * plan). Absent services degrade to no-ops.
     * @param {object} session
     * @returns {object|null}
     */
    function _overlay(session) {
        return _service("planOverlay", session?.overlay);
    }

    /**
     * (Re)draw the GM-only plan overlay for a session — the route, the
     * serialized templates and the target highlight (issue #29). Called
     * on open, after a replan and when a stale banner appears, so the
     * canvas picture always matches the dialog.
     * @param {object} session
     */
    function _showOverlay(session) {
        try {
            _overlay(session)?.showPlan?.(session.plan, {
                combat: session.combat,
                combatant: session.combatant,
                operationId: session.operationId,
                stale: session.stale ?? null
            });
        } catch(err) {
            // The overlay is decorative — never block the preview on it.
        }
    }

    /**
     * Clear the plan overlay of a resolved/dropped session.
     * @param {object} session
     */
    function _clearOverlay(session) {
        try {
            _overlay(session)?.clearPlan?.(session.operationId);
        } catch(err) {
            // Overlay cleanup is best-effort.
        }
    }

    /**
     * Display name of the previewed NPC for notifications.
     * @param {object} session
     * @returns {string}
     */
    function _npcName(session) {
        const tokenDoc = _tokenDoc(session?.combatant?.token);
        return session?.combatant?.name ?? tokenDoc?.name
            ?? _actorOf(session?.combatant)?.name ?? "NPC";
    }

    /**
     * Pre-decision snapshot validation via the planner — the same check
     * the executor runs before every state-changing step. Without a
     * planner the check degrades to "valid".
     * @param {object} session
     * @returns {{valid: boolean, reason: string|null}}
     */
    function _validateSession(session) {
        const planner = _service("planner", session?.planner);
        if (typeof planner?.validateSnapshot !== "function") {
            return { valid: true, reason: null };
        }
        try {
            return planner.validateSnapshot(session.plan, {
                combat: session.combat ?? null,
                combatant: session.combatant ?? null,
                token: _tokenDoc(session.combatant?.token),
                scene: session.combat?.scene ?? globalThis.canvas?.scene ?? null
            });
        } catch(err) {
            return { valid: false, reason: STALE_REASONS.stale };
        }
    }

    /**
     * Render-ready localized view-model for a session.
     * @param {object} session
     * @returns {object}
     */
    function _viewModel(session) {
        const planner = _service("planner", session.planner);
        return localizePreviewViewModel(buildPreviewViewModel(session.plan, {
            combat: session.combat,
            combatant: session.combatant,
            operation: session.operation,
            operationId: session.operationId,
            diagnosticsEnabled: diagnostics(),
            maxReplans: Number.isFinite(maxReplans)
                ? maxReplans
                : _finiteOr(planner?.maxReplans, 1),
            stale: session.stale,
            timeoutSeconds: session.timeoutSeconds
        }), _i18n());
    }

    /**
     * Open or create the dialog for a session through the injected
     * presenter (no-op when `present` is absent — headless mode).
     * @param {object} session
     */
    function _present(session) {
        if (typeof present !== "function") return;
        try {
            session.dialog = present(session, _viewModel(session)) ?? null;
        } catch(err) {
            console.error(`${MODULE_ID} | preview dialog render failed`, err);
            session.dialog = null;
        }
    }

    /**
     * Re-render the dialog after plan/stale changes.
     * @param {object} session
     */
    function _render(session) {
        if (!session.dialog) {
            _present(session);
            return;
        }
        try {
            if (typeof session.dialog.render === "function") {
                session.dialog.render(_viewModel(session));
            }
        } catch(err) {
            console.error(`${MODULE_ID} | preview dialog re-render failed`, err);
        }
    }

    /**
     * (Re)arm the auto-cancel timeout of a session.
     * @param {object} session
     */
    function _scheduleTimeout(session) {
        _cancelTimeout(session);
        if (!(session.timeoutSeconds > 0)) return;
        session.timeoutId = _setTimer(() => {
            Promise.resolve(resolvePreview(session.operationId, {
                decision: PREVIEW_DECISIONS.cancel,
                reason: PREVIEW_REASONS.timeout
            })).catch(err => {
                console.error(`${MODULE_ID} | preview timeout failed`, err);
            });
        }, session.timeoutSeconds * 1000);
    }

    /**
     * Disarm the auto-cancel timeout of a session.
     * @param {object} session
     */
    function _cancelTimeout(session) {
        if (session.timeoutId !== null && session.timeoutId !== undefined) {
            _clearTimer(session.timeoutId);
        }
        session.timeoutId = null;
    }

    /**
     * Resolve and dispose a session: disarm the timer, forget the pending
     * entry and close the dialog. `session.resolved` is set *before* the
     * dialog closes so the dialog's own "close cancels" path cannot
     * re-enter the controller.
     * @param {object} session
     * @param {string} decision Terminal decision marker.
     */
    function _drop(session, decision) {
        session.resolved = decision;
        _cancelTimeout(session);
        pending.delete(session.operationId);
        _clearOverlay(session);
        const dialog = session.dialog;
        session.dialog = null;
        try {
            if (typeof dialog?.close === "function") dialog.close();
        } catch(err) {
            // Dialog cleanup is best-effort.
        }
    }

    /**
     * Confirm path: re-validate the snapshot, transition the operation to
     * `executing` when authority is present, then execute the plan.
     * @param {object} session
     * @returns {Promise<object>} Decision outcome.
     */
    async function _confirm(session) {
        if (session.stale) {
            return {
                ok: false,
                decision: PREVIEW_DECISIONS.confirm,
                stale: true,
                reason: session.stale
            };
        }
        const verdict = _validateSession(session);
        if (!verdict.valid) {
            session.stale = verdict.reason ?? PREVIEW_REASONS.stale;
            _render(session);
            return {
                ok: false,
                decision: PREVIEW_DECISIONS.confirm,
                stale: true,
                reason: session.stale
            };
        }
        const operations = _operations(session);
        if (operations && typeof operations.transitionOperation === "function") {
            const transition = await operations.transitionOperation(
                session.combat, session.operationId, "awaiting-preview", "executing"
            ).catch(() => null);
            // The operation already left `awaiting-preview` elsewhere
            // (authority abort, another client, a stale pass): executing
            // would run the steps under a dead operation and lose the
            // turn advance — drop the session instead.
            if (transition?.ok === false) {
                _drop(session, PREVIEW_DECISIONS.cancel);
                return {
                    ok: false,
                    decision: PREVIEW_DECISIONS.confirm,
                    reason: transition?.reason ?? "transition-failed"
                };
            }
        }
        // Lock the session before the long `executePlan` await: disarm the
        // auto-cancel timer and mark it resolved so a stale-watch pass or
        // the timeout callback can no longer cancel the operation
        // mid-flight — that raced `completeTurn` would win the operation
        // and lose the turn advance.
        _cancelTimeout(session);
        session.resolved = "executing";
        const executor = _service("executor", session.executor);
        let result = null;
        if (executor && typeof executor.executePlan === "function") {
            // The recorded `preview` result must not shadow the real run.
            try {
                executor.clearExecutions?.(session.operationId);
            } catch(err) {
                // Older executors may lack the helper — harmless.
            }
            try {
                result = await executor.executePlan(session.plan, {
                    combat: session.combat,
                    combatant: session.combatant,
                    operation: session.operation,
                    operationId: session.operationId,
                    operations: session.operations,
                    planContext: session.planContext
                });
            } catch(err) {
                console.error(`${MODULE_ID} | confirmed plan failed to launch`, err);
                result = { status: "failed", reason: String(err?.message ?? err) };
            }
        }
        _drop(session, PREVIEW_DECISIONS.confirm);
        return { ok: true, decision: PREVIEW_DECISIONS.confirm, result };
    }

    /**
     * Cancel path (GM button, dialog close, timeout, terminal stale):
     * closes the authority operation as `cancelled` without touching
     * documents; the combat turn stays under manual GM control.
     * @param {object} session
     * @param {string} reason Cancel reason code.
     * @returns {Promise<object>} Decision outcome.
     */
    async function _cancel(session, reason) {
        const operations = _operations(session);
        if (operations && typeof operations.completeTurn === "function") {
            try {
                await operations.completeTurn(session.combat, session.operationId, {
                    cancelled: true,
                    reason,
                    advanceTurn: false,
                    result: {
                        status: "cancelled",
                        planId: session.plan?.id ?? null,
                        reason
                    }
                });
            } catch(err) {
                // Operation bookkeeping is best-effort.
            }
        }
        _drop(session, PREVIEW_DECISIONS.cancel);
        const name = _npcName(session);
        if (reason === PREVIEW_REASONS.timeout) {
            _notify("warn", "OWAI.Notifications.PreviewTimeout", { name });
        } else {
            _notify("info", "OWAI.Notifications.PreviewCancelled", { name, reason });
        }
        return { ok: true, decision: PREVIEW_DECISIONS.cancel, reason };
    }

    /**
     * Replan path: ask the planner for a fresh plan on the current state
     * (bounded by the shared replan budget) and re-render the dialog with
     * a fresh timeout window.
     * @param {object} session
     * @returns {Promise<object>} Decision outcome.
     */
    async function _replan(session) {
        const planner = _service("planner", session.planner);
        const limit = Number.isFinite(maxReplans)
            ? maxReplans
            : _finiteOr(planner?.maxReplans, 1);
        const used = _finiteOr(session.plan?.replanCount, 0);
        if (used >= limit) {
            return { ok: false, decision: PREVIEW_DECISIONS.replan, reason: PREVIEW_REASONS.replanLimit };
        }
        if (typeof planner?.planTurn !== "function") {
            return { ok: false, decision: PREVIEW_DECISIONS.replan, reason: PREVIEW_REASONS.noPlanner };
        }
        let planned = null;
        try {
            planned = await planner.planTurn(session.combat, session.combatant, {
                ...(session.planContext ?? {}),
                ...(planContext ?? {}),
                operation: session.operation,
                operationId: session.operationId,
                replanCount: used + 1
            });
        } catch(err) {
            planned = null;
        }
        if (planned?.status !== "ok" || !planned.plan) {
            const reason = planned?.reason ?? PREVIEW_REASONS.planFailed;
            _notify("warn", "OWAI.Notifications.ReplanFailed", { name: _npcName(session), reason });
            return { ok: false, decision: PREVIEW_DECISIONS.replan, reason };
        }
        session.plan = planned.plan;
        session.stale = null;
        _scheduleTimeout(session);
        _render(session);
        _showOverlay(session);
        log(`preview ${session.operationId} replanned -> ${planned.plan.id}`);
        return { ok: true, decision: PREVIEW_DECISIONS.replan, plan: planned.plan };
    }

    /**
     * Open a preview session for a `previewRequested` payload.
     * @param {object} payload `{combat?, combatant?, operation?,
     *   operationId?, plan, planContext?, executor?, planner?,
     *   operations?, authority?}`.
     * @returns {{ok: boolean, reason?: string, operationId?: string,
     *   session?: object, duplicate?: boolean}}
     */
    function openPreview(payload = {}) {
        // The master switch (`isModuleEnabled`) disables previews too —
        // `api.enabled` alone only reflects the compatibility gate.
        if (!isModuleEnabled()) {
            return { ok: false, reason: PREVIEW_REASONS.moduleDisabled };
        }
        if (getMode() !== "preview") {
            return { ok: false, reason: PREVIEW_REASONS.automaticMode };
        }
        if (!_isController()) {
            return { ok: false, reason: PREVIEW_REASONS.notController };
        }
        const plan = payload.plan ?? null;
        if (!plan) {
            return { ok: false, reason: PREVIEW_REASONS.invalidPlan };
        }
        const operationId = payload.operation?.id ?? payload.operationId
            ?? plan.operationId ?? plan.id ?? null;
        if (!operationId) {
            return { ok: false, reason: PREVIEW_REASONS.invalidPlan };
        }
        if (pending.has(operationId)) {
            return {
                ok: true,
                operationId,
                session: pending.get(operationId),
                duplicate: true
            };
        }
        const timeoutSeconds = _finiteOr(getTimeout?.(), 0);
        const session = {
            operationId,
            combat: payload.combat ?? null,
            combatant: payload.combatant ?? payload.combat?.combatant ?? null,
            operation: payload.operation ?? null,
            plan,
            planContext: payload.planContext ?? null,
            executor: payload.executor,
            planner: payload.planner,
            operations: payload.operations,
            authority: payload.authority,
            overlay: payload.overlay,
            timeoutSeconds: Number.isFinite(timeoutSeconds) ? timeoutSeconds : 0,
            timeoutId: null,
            stale: null,
            resolved: null,
            dialog: null
        };
        pending.set(operationId, session);
        _scheduleTimeout(session);
        _present(session);
        _showOverlay(session);
        // Issue #32: pan the GM view onto the acting bot.
        if (getCenterOnBot()) centerOnToken(_tokenDoc(session.combatant?.token));
        log(`preview ${operationId}: plan ${plan.id} timeout=${session.timeoutSeconds}s`);
        return { ok: true, operationId, session };
    }

    /**
     * Single decision entry point: dialog buttons, the timeout and
     * integrations all resolve here.
     * @param {string} operationId
     * @param {object|string} decision `{decision, reason?}` or a bare
     *   decision string (`"confirm"|"cancel"|"replan"|"timeout"`).
     * @returns {Promise<object>} `{ok, decision, reason?, result?, plan?}`.
     */
    async function resolvePreview(operationId, decision = {}) {
        const input = typeof decision === "string" ? { decision } : (decision ?? {});
        const session = pending.get(operationId);
        if (!session) {
            return { ok: false, reason: PREVIEW_REASONS.noPreview, operationId };
        }
        if (session.resolved !== null && session.resolved !== undefined) {
            return { ok: false, reason: PREVIEW_REASONS.alreadyResolved, operationId };
        }
        if (!_isController()) {
            return { ok: false, reason: PREVIEW_REASONS.notController, operationId };
        }
        switch (input.decision) {
            case PREVIEW_DECISIONS.confirm:
                return _confirm(session);
            case PREVIEW_DECISIONS.cancel:
                return _cancel(session, input.reason ?? PREVIEW_REASONS.gmCancelled);
            case PREVIEW_DECISIONS.replan:
                return _replan(session);
            case "timeout":
                return _cancel(session, PREVIEW_REASONS.timeout);
            default:
                return { ok: false, reason: "unknown-decision", operationId };
        }
    }

    /**
     * Mark a session stale: terminal stales auto-cancel, recoverable
     * stales re-render with a banner and a disabled Confirm.
     * @param {object} session
     * @param {string} reason Stale reason code.
     * @returns {Promise<void>}
     */
    async function _markStale(session, reason) {
        if (session.resolved) return;
        session.stale = reason ?? PREVIEW_REASONS.stale;
        if (TURN_ENDING_STALE.has(session.stale)) {
            await _cancel(session, session.stale);
            return;
        }
        _render(session);
        _showOverlay(session);
        log(`preview ${session.operationId} stale: ${session.stale}`);
    }

    /**
     * Re-validate every pending session — called from the stale-watch
     * document hooks.
     */
    function checkStale() {
        for (const session of [...pending.values()]) {
            if (session.resolved) continue;
            let verdict;
            try {
                verdict = _validateSession(session);
            } catch(err) {
                verdict = { valid: false, reason: STALE_REASONS.stale };
            }
            if (!verdict.valid) {
                Promise.resolve(_markStale(session, verdict.reason)).catch(err => {
                    console.error(`${MODULE_ID} | stale preview handling failed`, err);
                });
            }
        }
    }

    /**
     * Authority `phaseChanged` hook (issue #400): when a pending operation
     * leaves `awaiting-preview` outside this dialog (e.g. resolved by
     * another client or by the authority itself), drop the session quietly.
     * @param {object} combat
     * @param {object} operation Operation carrying `id`/`phase`.
     * @param {...*} rest Optional trailing phases (`oldPhase`, `newPhase`).
     */
    function handlePhaseChange(combat, operation, ...rest) {
        const operationId = operation?.id ?? null;
        if (!operationId) return;
        const session = pending.get(operationId);
        if (!session) return;
        const phases = rest.filter(arg => typeof arg === "string");
        const phase = phases.length ? phases[phases.length - 1] : (operation?.phase ?? null);
        if (phase && phase !== "awaiting-preview") {
            _drop(session, "external");
        }
    }

    /**
     * Cancel every pending session (shutdown/testing helper).
     * @param {string} reason Cancel reason code.
     * @returns {Promise<void>}
     */
    async function closeAll(reason = PREVIEW_REASONS.gmCancelled) {
        for (const session of [...pending.values()]) {
            try {
                await _cancel(session, reason);
            } catch(err) {
                // Best-effort cleanup.
            }
        }
    }

    return {
        openPreview,
        resolvePreview,
        checkStale,
        handlePhaseChange,
        closeAll,
        decisions: PREVIEW_DECISIONS,
        reasons: PREVIEW_REASONS,
        /**
         * Whether a preview session is pending for an operation id.
         * @param {string} operationId
         * @returns {boolean}
         */
        hasSession(operationId) {
            return pending.has(operationId);
        },
        /**
         * Look up a pending session (test/introspection helper).
         * @param {string} operationId
         * @returns {object|null}
         */
        getSession(operationId) {
            return pending.get(operationId) ?? null;
        },
        /**
         * Number of pending preview sessions.
         * @returns {number}
         */
        sessionCount() {
            return pending.size;
        }
    };
}

/**
 * Register the preview UI: builds the controller, wires the
 * `previewRequested`/`phaseChanged` hooks plus the stale-watch document
 * hooks and returns the controller (published as the `preview` service by
 * `module.js`). Called on `init`.
 * @returns {object} Preview controller.
 */
/**
 * Register the preview UI: build the controller with the module API (for
 * lazy service lookups — operations/authority/executor/planner), wire the
 * hooks and return the controller.
 * @param {object} [api] Module API object (`api.services` registry).
 * @returns {object} Preview controller.
 */
export function registerPreviewUI(api = null) {
    const ApplicationBase = globalThis.foundry?.appv1?.api?.Application
        ?? globalThis.Application
        ?? null;
    let controller = null;
    let present = null;

    if (ApplicationBase) {
        /** Plan preview dialog bound to one controller session. */
        const AIPlanPreviewDialog = class extends ApplicationBase {
            /** @inheritdoc */
            static get defaultOptions() {
                return globalThis.foundry.utils.mergeObject(super.defaultOptions, {
                    id: "ow-ai-preview",
                    classes: ["ow-ai-preview", "dialog"],
                    title: globalThis.game?.i18n?.localize?.("OWAI.Preview.Title")
                        ?? "AI plan preview",
                    template: `modules/${MODULE_ID}/templates/ai-preview.hbs`,
                    width: 560,
                    height: "auto",
                    resizable: true
                });
            }

            /**
             * Create the dialog bound to one preview session.
             * @param {object} options `{controller, session, viewModel}`.
             */
            constructor(options) {
                super(options);
                this.controller = options.controller;
                this.session = options.session;
                this.viewModel = options.viewModel;
            }

            /** @inheritdoc */
            getData() {
                return this.viewModel;
            }

            /** @inheritdoc */
            activateListeners(html) {
                super.activateListeners(html);
                html.find("[data-action]").on("click", event => {
                    event.preventDefault();
                    const action = event.currentTarget?.dataset?.action;
                    if (!action || !this.controller || !this.session) return;
                    Promise.resolve(this.controller.resolvePreview(
                        this.session.operationId, { decision: action }
                    )).catch(err => {
                        console.error(`${MODULE_ID} | preview decision failed`, err);
                    });
                });
                // Debug helper (diagnostics mode): copy the route
                // waypoint list to the clipboard. `data-clipboard` keeps
                // it out of the resolvePreview decision path.
                html.find("[data-clipboard='route']").on("click", event => {
                    event.preventDefault();
                    const points = this.viewModel?.route?.points ?? [];
                    const text = points.map(p => `(${p.x}, ${p.y})`).join("\n");
                    if (!text) return;
                    const done = globalThis.game?.clipboard?.copyPlainText?.(text)
                        ?? globalThis.navigator?.clipboard?.writeText?.(text);
                    Promise.resolve(done).then(() => {
                        globalThis.ui?.notifications?.info?.(
                            globalThis.game?.i18n?.localize?.(
                                "OWAI.Notifications.RouteCopied") ?? "Route copied");
                    }).catch(() => {});
                });
                // Debug helper (diagnostics mode): copy the full plan
                // export — bot identity, turn context, steps, scores,
                // rejected candidates and layer trace (smoke finding).
                html.find("[data-clipboard='info']").on("click", event => {
                    event.preventDefault();
                    const session = this.session ?? {};
                    const plan = session.plan ?? {};
                    const snapshot = plan.snapshot ?? {};
                    const diagnostics = plan.diagnostics ?? {};
                    const payload = {
                        module: MODULE_ID,
                        exportedAt: new Date().toISOString(),
                        combat: {
                            id: session.combat?.id ?? snapshot.combatId ?? null,
                            round: snapshot.round ?? session.combat?.round ?? null,
                            turn: snapshot.turn ?? session.combat?.turn ?? null
                        },
                        bot: {
                            combatantId: session.combatant?.id ?? snapshot.combatantId ?? null,
                            name: this.viewModel?.npc?.name
                                ?? session.combatant?.name ?? null,
                            preset: this.viewModel?.npc?.presetLabel ?? null
                        },
                        operation: {
                            id: session.operationId ?? null,
                            phase: session.operation?.phase ?? null,
                            revision: session.operation?.revision ?? null
                        },
                        plan: {
                            id: plan.id ?? null,
                            variant: plan.variant ?? null,
                            score: plan.breakdown?.score ?? plan.score ?? null,
                            steps: (plan.steps ?? []).map(step => ({
                                id: step.id ?? null,
                                type: step.type ?? null,
                                cost: step.cost ?? null,
                                input: step.input ?? null
                            }))
                        },
                        breakdown: plan.breakdown ?? null,
                        targets: diagnostics.targets ?? [],
                        rejected: diagnostics.rejected ?? [],
                        ranking: diagnostics.ranking ?? [],
                        layers: (diagnostics.layers ?? [])
                            .map(layer => layer?.code ?? layer),
                        trace: diagnostics.trace ?? null
                    };
                    const text = JSON.stringify(payload, null, 2);
                    const done = globalThis.game?.clipboard?.copyPlainText?.(text)
                        ?? globalThis.navigator?.clipboard?.writeText?.(text);
                    Promise.resolve(done).then(() => {
                        globalThis.ui?.notifications?.info?.(
                            globalThis.game?.i18n?.localize?.(
                                "OWAI.Notifications.InfoCopied") ?? "Info copied");
                    }).catch(() => {});
                });
            }

            /** @inheritdoc */
            async close(options) {
                const result = await super.close(options);
                // Closing the window without a decision cancels the plan —
                // it never counts as a confirm.
                if (this.session && this.session.resolved === null && this.controller) {
                    await this.controller.resolvePreview(this.session.operationId, {
                        decision: PREVIEW_DECISIONS.cancel,
                        reason: PREVIEW_REASONS.dialogClosed
                    });
                }
                return result;
            }
        };

        present = (session, viewModel) => {
            const app = new AIPlanPreviewDialog({ controller, session, viewModel });
            try {
                app.render(true);
            } catch(err) {
                console.error(`${MODULE_ID} | preview dialog render failed`, err);
            }
            return {
                /**
                 * Push a new view-model into the dialog.
                 * @param {object} vm
                 */
                render(vm) {
                    app.viewModel = vm;
                    try {
                        app.render(true);
                    } catch(err) {
                        console.error(`${MODULE_ID} | preview dialog re-render failed`, err);
                    }
                },
                /** Close the dialog window. */
                close() {
                    try {
                        app.close();
                    } catch(err) {
                        // Dialog cleanup is best-effort.
                    }
                }
            };
        };
    } else {
        console.warn(`${MODULE_ID} | Application class unavailable; GM preview runs headless`);
    }

    controller = createPreviewController({ api, present });

    if (typeof globalThis.Hooks?.on !== "function") return controller;

    globalThis.Hooks.on(`${MODULE_ID}.previewRequested`, payload => {
        try {
            controller.openPreview(payload ?? {});
        } catch(err) {
            console.error(`${MODULE_ID} | previewRequested handling failed`, err);
        }
    });

    globalThis.Hooks.on(`${MODULE_ID}.phaseChanged`, (combat, operation, ...rest) => {
        try {
            controller.handlePhaseChange(combat, operation, ...rest);
        } catch(err) {
            console.error(`${MODULE_ID} | phaseChanged handling failed`, err);
        }
    });

    for (const hook of STALE_WATCH_HOOKS) {
        globalThis.Hooks.on(hook, () => {
            try {
                controller.checkStale();
            } catch(err) {
                console.error(`${MODULE_ID} | stale preview check failed`, err);
            }
        });
    }

    return controller;
}
