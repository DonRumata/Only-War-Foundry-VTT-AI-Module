/**
 * Planner decomposition (issue #403 follow-up): this module was extracted
 * verbatim from scripts/planner.js — see that file for the design contract.
 * The planner service re-exports the public surface so existing importers
 * and tests keep working.
 */
import {
    _actorOf,
    _actorUuid,
    _collisionRevision,
    _findCombatantByToken,
    _itemSummaries,
    _reconcileSelfStatuses,
    _resourcesFingerprint,
    _resourcesOf,
    _sceneOf,
    _selfStatuses,
    _targetAlive,
    _tokenDoc,
    _tokenPosition,
    _tokenUuid
} from "./documents.js";
import {
    _deepFreeze,
    _finiteOr,
    _gridInfo,
    fnv1a,
    stableStringify
} from "./util.js";


/**
 * Deterministic turn revision: delegates to the authority service's
 * `operations.computeRevision` (#400) when it is available so plan and
 * operation revisions agree, and falls back to an equivalent local
 * FNV-1a fingerprint otherwise.
 * @param {object} combat
 * @param {object} combatant
 * @param {object|null} authority Authority service or null.
 * @returns {string}
 */
export function _turnRevision(combat, combatant, authority) {
    const compute = authority?.operations?.computeRevision;
    if (typeof compute === "function") {
        try {
            const revision = compute(combat, combatant);
            if (typeof revision === "string" && revision) return revision;
        } catch(err) {
            // Fall through to the local fingerprint below.
        }
    }
    const tokenDoc = _tokenDoc(combatant?.token);
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
    return `r${fnv1a(stableStringify(fingerprint))}`;
}


/**
 * Fingerprint of exactly the fields the stale checks inspect. Compared
 * first in `validateSnapshot` вЂ” equal fingerprints mean the plan is still
 * valid without running the detailed checks.
 * @param {object} input Fingerprint input.
 * @param {object|null} input.combat Live combat document.
 * @param {object|null} input.combatant Live combatant document.
 * @param {object|null} input.token Live self token document.
 * @param {object|null} input.actor Live self actor document.
 * @param {object|null} input.targetToken Live target token document.
 * @param {string|null} input.collision Live collision revision.
 * @param {string[]|null} [input.selfStatuses] Injected fixture statuses
 *   (`context.selfStatuses`) that must merge into the live computation.
 * @param {object|null} [input.statusAdjust] Self-inflicted status changes
 *   of the plan's own steps (issue #93: `{added, removed}`) — reconciled
 *   against the snapshot baseline before hashing so the fast-path
 *   fingerprint stays valid after the plan's own unpin/drop-prone ran.
 * @param {object} input.snapshot Stored plan snapshot.
 * @returns {string}
 */
export function _staleFingerprint(input) {
    const { combat, combatant, token, actor, targetToken, collision,
        selfStatuses, statusAdjust, snapshot } = input;
    const position = _tokenPosition(token);
    const targetPosition = _tokenPosition(targetToken);
    const targetCombatant = _findCombatantByToken(combat, snapshot?.target?.tokenId ?? null);
    const statuses = _reconcileSelfStatuses(
        _selfStatuses(actor, token, selfStatuses),
        Array.isArray(snapshot?.self?.statuses) ? snapshot.self.statuses : [],
        statusAdjust ?? null
    );
    return fnv1a(stableStringify({
        round: combat?.round ?? null,
        turn: combat?.turn ?? null,
        self: [
            token?.id ?? null,
            position.x,
            position.y,
            token?.elevation ?? null,
            token?.hidden === true,
            combatant?.defeated === true,
            statuses
        ],
        target: snapshot?.target
            ? (targetToken
                ? [snapshot.target.tokenId ?? targetToken.id ?? null,
                    targetPosition.x,
                    targetPosition.y,
                    targetToken?.elevation ?? null,
                    _targetAlive(targetToken, targetCombatant)]
                : "missing")
            : null,
        resources: _resourcesFingerprint(actor),
        collision: collision ?? null
    }));
}


/**
 * Build the immutable `PlanningSnapshot` for an AI combatant. Plain,
 * JSON-serializable data only вЂ” never Document references.
 * @param {object} input Builder input.
 * @param {object|null} [input.combat] Combat document.
 * @param {object|null} [input.combatant] Active combatant document.
 * @param {object} [input.context] Planning context overrides.
 * @param {object|null} [input.authority] Authority service or null.
 * @returns {object} Frozen snapshot (targets/actions filled by the caller
 *   before `revision`/`staleFingerprint` are finalized).
 */
export function buildPlanSnapshot({ combat = null, combatant = null, context = {}, authority = null } = {}) {
    const tokenDoc = _tokenDoc(context.token ?? combatant?.token);
    const actor = _actorOf(combatant) ?? _actorOf(tokenDoc);
    const scene = _sceneOf(context, combat);
    const sceneId = scene?.id ?? null;
    const position = _tokenPosition(tokenDoc);
    const grid = _gridInfo(scene);
    const collision = context.collisionRevision !== undefined
        ? context.collisionRevision
        : _collisionRevision(scene);
    return _deepFreeze({
        combatId: combat?.id ?? null,
        combatantId: combatant?.id ?? null,
        round: _finiteOr(combat?.round, 0),
        turn: _finiteOr(combat?.turn, 0),
        scene: {
            id: sceneId,
            grid,
            collisionRevision: collision
        },
        self: {
            tokenId: combatant?.tokenId ?? tokenDoc?.id ?? null,
            tokenUuid: _tokenUuid(tokenDoc, sceneId),
            actorId: actor?.id ?? null,
            actorUuid: _actorUuid(actor),
            x: position.x,
            y: position.y,
            elevation: _finiteOr(tokenDoc?.elevation, 0),
            hidden: tokenDoc?.hidden === true,
            defeated: combatant?.defeated === true,
            initiative: combatant?.initiative ?? null,
            disposition: _finiteOr(tokenDoc?.disposition ?? combatant?.disposition, 0),
            statuses: _selfStatuses(actor, tokenDoc, context?.selfStatuses),
            resources: _resourcesOf(actor),
            resourcesHash: _resourcesFingerprint(actor),
            items: _itemSummaries(actor)
        },
        targets: [],
        actions: [],
        target: null,
        turnRevision: _turnRevision(combat, combatant, authority),
        staleFingerprint: null,
        revision: null
    });
}
