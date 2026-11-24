/**
 * Planner service (issue #403): immutable planning snapshots, deterministic
 * candidate scoring, serializable plans and the stale-plan/replan policy.
 *
 * Design contract (epic #363):
 * - Planning works on an immutable DTO snapshot вЂ” a plain, JSON-serializable
 *   object captured at planning time. Plans never hold Document instances.
 * - `planTurn(combat, combatant, context)` is deterministic: identical
 *   snapshot + preset weights + seed always produce the identical plan.
 *   Tie-breaking between equal-score candidates uses a mulberry32 PRNG fed
 *   by the recorded `plan.seed`.
 * - Sibling services are resolved lazily through the registry
 *   (`api.services.get("authority" | "perception" | "navigation")`) or
 *   injected via `context` вЂ” every lookup degrades to a safe fallback so
 *   the planner works before/without the other stacked branches.
 * - `validateSnapshot(plan, currentContext)` runs before every
 *   state-changing step: a cheap revision fingerprint is compared first,
 *   and only a mismatch triggers the ordered checks that produce a stable
 *   stale reason code.
 * - `shouldReplan(failure)` allows at most `maxReplans` (default 1) full
 *   replans per turn; after the budget is spent the AI holds and reports
 *   a diagnostic reason for the GM instead of acting on stale state.
 */
import {
    resolveEffectiveConfig
} from "./config-resolver.js";
import {
    COMMITMENT_THREAT_MAX,
    COMMITMENT_TTL_ROUNDS,
    FALLBACK_PRESET,
    FLAG_KEYS,
    MODULE_ID
} from "./constants.js";
import {
    applyCommitmentLayer,
    applyMoraleLayer,
    applyMoraleWeightShift,
    boundedPersonalityOverlay,
    moraleTierOf,
    recordLayerReason,
    resolveLayerFlags
} from "./layers.js";
import {
    personalityBehaviorFlags,
    personalityIdentity,
    personalityJitter,
    personalityJitterFactor,
    resolvePersonality
} from "./personalities.js";
import {
    reactionUsed
} from "./reactions.js";
import {
    logDiagnostics
} from "./settings.js";
import {
    buildLayerTrace,
    factorDelta
} from "./trace.js";
import {
    _actionBlastRadius,
    _actionCost,
    _actionRange,
    _aimActions,
    _isMeleeAction,
    _orderAction,
    _overwatchWeapons,
    _readyWeaponActions,
    _resolveActions,
    _unpinAction,
    _weaponJammedOf,
    dodgeChanceOf
} from "./planner/actions.js";
import {
    ACTION_BUDGET_HALVES,
    CHARGE_MIN_DISTANCE,
    CHARGE_STRAIGHT_TOLERANCE,
    CHARGE_SWITCH_MARGIN,
    SEEK_MAX_CANDIDATES,
    DEFAULT_DODGE_TN,
    DEFAULT_LOOKAHEAD_LAMBDA,
    DEFAULT_LOOKAHEAD_TOP_K,
    DEFAULT_MAX_ACTIONS,
    DEFAULT_MAX_REPLANS,
    DEFAULT_MAX_TARGETS,
    DEFAULT_MELEE_RANGE,
    DEFAULT_MOVE_CANDIDATES,
    DEFAULT_PRESET_WEIGHTS,
    DROP_PRONE_DANGER,
    EASY_MISTAKE_CHANCE,
    EASY_PICK_SEED_XOR,
    EASY_PICK_TOP_K,
    PLANNER_STATUS,
    PRESET_SKELETONS,
    REPLAN_ACTIONS,
    REPLAN_REASONS,
    SCORE_FACTORS,
    STALE_REASONS,
    STEP_TYPES
} from "./planner/contract.js";
import {
    _activeGrudge,
    _actorOf,
    _collisionRevision,
    _findCombatant,
    _findCombatantByToken,
    _findToken,
    _moraleOf,
    _resourcesFingerprint,
    _sceneOf,
    _selfStatuses,
    _targetAlive,
    _tokenDoc,
    _tokenMeleeReachPx,
    _tokenPosition,
    _tokenUuid
} from "./planner/documents.js";
import {
    _resolveMoves
} from "./planner/moves.js";
import {
    _applyLookahead,
    _difficultyOf,
    _enemyThreats,
    _factorsOf,
    _lookaheadConfig,
    _resolveThreatMap,
    _seededPick,
    _shooterProfiles,
    evaluateFactors
} from "./planner/scoring.js";
import {
    _staleFingerprint,
    buildPlanSnapshot
} from "./planner/snapshot.js";
import {
    _stepsFor
} from "./planner/steps.js";
import {
    _allyEngagedTargets,
    _enemyContacts,
    _isMemorySource,
    _nearestThreat,
    _resolveTargets
} from "./planner/targets.js";
import {
    _chargeAimsAt,
    _chargeStraight,
    _deepFreeze,
    _finiteOr,
    _gridInfo,
    _halveMoveBudget,
    _jsonClone,
    _list,
    _pixelDistance,
    _pxPerUnit,
    fnv1a,
    mulberry32,
    stableStringify
} from "./planner/util.js";
import {
    _bestBlastAim,
    _bestConeAim,
    _blastTokens,
    _coneSpecOf,
    _coneTargetOf,
    _dangerAtSelf,
    _overwatchAnchors,
    _overwatchZone
} from "./planner/zones.js";


/**
 * Create the `planner` service published as `api.services.get("planner")`.
 * Pure/deterministic: never mutates documents; sibling services are looked
 * up lazily through `api.services` or injected via `context`.
 * @param {object} [deps]
 * @param {object} [deps.api] Module API for lazy service lookups.
 * @param {number} [deps.maxReplans] Replan budget per turn (default 1).
 * @param {Function} [deps.resolveConfig] Effective-config resolver.
 * @param {Function} [deps.log] Diagnostic logger.
 * @returns {object} Planner service.
 */
export function createPlannerService({
    api = null,
    maxReplans = DEFAULT_MAX_REPLANS,
    resolveConfig = resolveEffectiveConfig,
    log = (...args) => logDiagnostics(...args)
} = {}) {
    const presets = new Map();
    for (const [id, def] of Object.entries(PRESET_SKELETONS)) {
        presets.set(id, {
            id,
            weights: { ...DEFAULT_PRESET_WEIGHTS, ...(def.weights ?? {}) },
            evaluate: typeof def.evaluate === "function" ? def.evaluate : null,
            veto: typeof def.veto === "function" ? def.veto : null,
            allowNoTarget: def.allowNoTarget === true,
            allowNoAction: def.allowNoAction === true,
            alwaysOfferHold: def.alwaysOfferHold === true
        });
    }

    /**
     * Lazy service lookup: `context[name]` first, then the registry.
     * @param {string} name
     * @param {*} override Injected service (undefined = registry).
     * @returns {object|null}
     */
    function _service(name, override) {
        if (override !== undefined) return override;
        try {
            return api?.services?.get?.(name) ?? null;
        } catch(err) {
            return null;
        }
    }

    /**
     * Deterministic plan seed: injected `context.seed` wins, otherwise the
     * turn identity is hashed so identical world state re-plans identically.
     * @param {object} context
     * @param {object} combat
     * @param {object} combatant
     * @returns {number}
     */
    function _seedFor(context, combat, combatant) {
        if (Number.isFinite(context.seed)) return context.seed >>> 0;
        const key = `${combat?.id}|${combatant?.id}|${combat?.round}|${combat?.turn}`;
        return parseInt(fnv1a(key), 16) >>> 0;
    }

    /**
     * Plan a full AI turn. Async because the system actions API may be
     * async; everything else is synchronous and deterministic.
     * @param {object} combat Combat document.
     * @param {object} combatant Active combatant document.
     * @param {object} [context] Optional overrides/services:
     *   `seed`, `operation`, `replanCount`, `targets`, `actions`,
     *   `actionsApi`, `moves`, `moveBudget`, `actionBudget`, `rates`,
     *   `perception`, `navigation`, `authority`, `scene`, `token`,
     *   `collisionRevision`, `maxTargets`, `maxActions`,
     *   `approximateMoves`, `selfStatuses`, `difficulty`,
     *   `personality` (trait list or `false` to disable, issue #19),
     *   `team` (`{task, character, center, regroupPoint, ...}`).
     * @returns {Promise<object>} `{status, plan?, reason?, diagnostics?}`.
     */
    async function planTurn(combat, combatant, context = {}) {
        const authority = _service("authority", context.authority);
        if (authority) {
            if (authority.status === "waiting-for-gm"
                || (typeof authority.isController === "function"
                    && authority.isController() === false)) {
                return { status: PLANNER_STATUS.waitingForGm, reason: "not-controller", plan: null };
            }
        }
        if (!combat || combat.ended === true || combat.destroyed === true) {
            return { status: PLANNER_STATUS.disabled, reason: STALE_REASONS.combatEnded, plan: null };
        }
        if (!combatant || combatant.destroyed === true || combatant.defeated === true) {
            return { status: PLANNER_STATUS.disabled, reason: "combatant-gone", plan: null };
        }
        const config = resolveConfig(combatant);
        if (!config?.enabled) {
            return { status: PLANNER_STATUS.disabled, reason: "config-disabled", plan: null };
        }
        const presetId = presets.has(config.preset) ? config.preset : FALLBACK_PRESET;
        const preset = presets.get(presetId) ?? presets.get(FALLBACK_PRESET);
        const seed = _seedFor(context, combat, combatant);
        // Issue #16 difficulty: `context.difficulty` (validated) overrides
        // the world setting; it gates threat-map reads, the lookahead
        // pass and the deliberate slip of easy mode.
        const difficulty = _difficultyOf(context);
        const diagnostics = {
            seed,
            difficulty,
            weights: { ...preset.weights },
            preset: presetId,
            candidatesCount: 0,
            rejected: [],
            ranking: [],
            chosenStep: null,
            metrics: { targetsEvaluated: 0, movesEvaluated: 0 },
            // Issue #24 funnel: unified `{layer, code, detail}` reason
            // trace (#27 plumbing) plus the effective layer toggles.
            layers: [],
            layerFlags: null
        };
        // `context.layers` boolean overrides win over the world settings;
        // a disabled layer degrades to the previous funnel level.
        const layerFlags = resolveLayerFlags(context);
        diagnostics.layerFlags = { ...layerFlags };

        const tokenDoc = _tokenDoc(context.token ?? combatant?.token);
        const actor = _actorOf(combatant) ?? _actorOf(tokenDoc);
        const scene = _sceneOf(context, combat);
        const sceneId = scene?.id ?? null;
        const grid = _gridInfo(scene);
        // Gridless scenes are rejected before planning: movement
        // candidates and route scoring need a square/hex grid (issue
        // #410). Navigation answers `gridless-unsupported` the same way.
        if (grid.type === 0) {
            recordLayerReason(diagnostics, "L0", "gridless-unsupported");
            diagnostics.trace = buildLayerTrace(diagnostics);
            return {
                status: PLANNER_STATUS.unsupported,
                reason: "gridless-unsupported",
                plan: null,
                diagnostics
            };
        }
        const selfPos = _tokenPosition(tokenDoc);
        // Issue #19 personalities live at L3 of the funnel (issue #24):
        // explicit `context.personality` or the resolved
        // `flags["only-war-ai"].personality` list wins, otherwise 1–2
        // traits are generated seeded from the stable document identity.
        // The profile is resolved lazily so the L0 stunned short-circuit
        // below and the main scoring path share the same resolution —
        // and issue #26 hoists the pure resolution above the funnel so
        // L2 morale reads the trait exceptions (`fanatic`/`cowardly`)
        // without reordering the L3 trace entry.
        const _resolvePersonality = () => resolvePersonality({
            // A disabled L3 layer degrades to `source:"disabled"` —
            // same as `context.personality === false`: no traits, no
            // jitter, a fully deterministic pick.
            explicit: layerFlags.personality === false
                ? false
                : context.personality,
            flagged: config.personality,
            character: context.team?.character,
            difficulty,
            identity: personalityIdentity({ combatant, token: tokenDoc, actor })
        });
        const _runPersonalityLayer = (resolved = _resolvePersonality()) => {
            const amp = resolved.source === "disabled"
                ? 0
                : personalityJitter({
                    traits: resolved.traits,
                    character: resolved.character,
                    difficulty
                });
            diagnostics.personality = {
                traits: [...resolved.traits],
                character: resolved.character,
                source: resolved.source,
                jitter: amp,
                flags: personalityBehaviorFlags(resolved.traits)
            };
            // L3 bound (issue #24): additive deltas merge over the preset
            // weights but every applied delta is braced to ±30% of the
            // base weight — scripts/layers.js documents the zero-base
            // floor and reports the clamped factors.
            const overlay = boundedPersonalityOverlay(preset.weights, {
                traits: resolved.traits,
                character: resolved.character
            });
            if (Object.keys(overlay.clamped).length) {
                diagnostics.personality.clamped = overlay.clamped;
            }
            diagnostics.weights = { ...overlay.weights };
            // Issue #27 explainability: the applied per-factor deltas of
            // the trait overlay ride the L3 reason record (and the
            // diagnostics personality block) so the trace can name the
            // factors the personality bent ("−proximity, −attackNow").
            const appliedDeltas = {};
            for (const [factor, weight] of Object.entries(overlay.weights)) {
                const base = Number.isFinite(preset.weights[factor])
                    ? preset.weights[factor] : 0;
                const delta = Math.round((weight - base) * 1e6) / 1e6;
                if (delta !== 0) appliedDeltas[factor] = delta + 0;
            }
            if (Object.keys(appliedDeltas).length) {
                diagnostics.personality.deltas = appliedDeltas;
            }
            recordLayerReason(diagnostics, "L3",
                layerFlags.personality === false
                    ? "personality-layer-disabled"
                    : "personality-overlay",
                layerFlags.personality === false ? undefined : {
                    traits: [...resolved.traits],
                    character: resolved.character,
                    deltas: appliedDeltas,
                    clamped: Object.keys(overlay.clamped)
                });
            return {
                personality: resolved,
                personalityAmp: amp,
                effectiveWeights: overlay.weights
            };
        };
        // Self status constraints (issue #413): deterministic rules read
        // from actor/token statuses merged with the injected
        // `context.selfStatuses` fixture array. These are L0 hard vetoes —
        // they run ahead of every other funnel entry point so nothing
        // below may override them.
        // - `stunned`: OW combatants take no actions — short-circuit to an
        //   ok plan whose only step is `end-turn` stamped `stunned`.
        // - `pinned`: no charge and no move that ends closer to the
        //   target; attack-in-place and distance-keeping moves stay legal.
        // - `prone`: the movement budget halves (floor; crawl) and charge
        //   is vetoed.
        const selfStatuses = _selfStatuses(actor, tokenDoc, context.selfStatuses);
        diagnostics.selfStatuses = selfStatuses;
        if (selfStatuses.includes("stunned")) {
            recordLayerReason(diagnostics, "L0", "stunned");
            const l3 = _runPersonalityLayer();
            const steps = [{
                id: "step-end-turn-1",
                type: "end-turn",
                cost: {},
                input: { reason: "stunned" },
                preconditions: ["turn"],
                projectedResourceDelta: {}
            }];
            diagnostics.chosenStep = steps[0].id;
            const plan = _assemblePlan({
                combat, combatant, context, authority, seed, presetId,
                diagnostics, steps, personality: l3.personality,
                winner: { score: 0, breakdown: { reason: "stunned" }, target: null },
                targets: [],
                actions: []
            });
            log(`plan ${plan.id} preset=${presetId} stunned hold`);
            return { status: PLANNER_STATUS.ok, plan, reason: null };
        }
        const isPinned = selfStatuses.includes("pinned");
        const isProne = selfStatuses.includes("prone");
        // Services resolve ahead of L1: the committed-attack staleness
        // check (los-broken) needs the perception probe inside the live
        // view, and navigation feeds the flank move probe further down.
        const perception = _service("perception", context.perception);
        const navigation = _service("navigation", context.navigation);
        // Resolve the personality before L1 too: a commitment replay
        // used to show a blank personality line in the preview — the
        // profile is a cheap flag/seeded read, and the replayed plan now
        // carries it for display even though no scoring runs.
        const personalityProfile = _resolvePersonality();
        const commitmentContext = perception
            ? { ...context, perception } : context;
        // Issue #24/#25 L1 commitment: a valid committed plan (flag
        // record or injected `context.commitment`) short-circuits the
        // funnel — its serialized steps execute verbatim and no scoring
        // runs. The layer validates the record's `expectedState` against
        // live state (ttl, own-move journal, gm-intervention, target,
        // morale tier, threat drift, attack LOS, cheap L0) and reports
        // the stable invalidator codes on the trace.
        const commitment = applyCommitmentLayer({
            combat, combatant, context: commitmentContext,
            flags: layerFlags, diagnostics,
            selfStatuses
        });
        // Bookkeeping for the executor and the #27 trace: which record
        // was evaluated, why it was dropped and whether the world is in
        // reactive mode (>threshold same-team gm-interventions squeeze
        // every new commitment's ttl to one round).
        diagnostics.commitment = {
            recordId: commitment.record?.id ?? null,
            invalidated: commitment.invalidated ?? null,
            reactive: commitment.reactive === true,
            interventions: _finiteOr(commitment.interventions, 0)
        };
        if (commitment.decision) {
            const steps = commitment.decision.steps;
            diagnostics.chosenStep = steps.find(step => step.type !== "end-turn")?.id
                ?? steps[0]?.id ?? null;
            // Preview readability (smoke finding): a replayed commitment
            // used to leave `snapshot.target` null — the dialog showed an
            // attack step aimed at "(no target)". Resolve the committed
            // attack's target token back into a display target; the
            // recorded expectedState point fills in when the token is
            // unresolvable.
            const expectedTarget = commitment.record?.expectedState?.target ?? null;
            const commitTokenId = steps.find(step =>
                step?.type === "attack" || step?.type === "test")
                ?.input?.targetTokenId ?? expectedTarget?.tokenId ?? null;
            const commitTokenDoc = commitTokenId
                ? _findToken(commitTokenId, { combat, scene }) : null;
            const commitTarget = commitTokenId
                ? {
                    tokenId: commitTokenId,
                    tokenUuid: commitTokenDoc?.uuid
                        ?? expectedTarget?.tokenUuid ?? null,
                    x: commitTokenDoc?.x ?? expectedTarget?.x ?? null,
                    y: commitTokenDoc?.y ?? expectedTarget?.y ?? null,
                    elevation: commitTokenDoc?.elevation ?? 0,
                    statuses: []
                }
                : null;
            const plan = _assemblePlan({
                combat, combatant, context, authority, seed, presetId,
                diagnostics, steps, personality: personalityProfile,
                winner: {
                    score: 0,
                    breakdown: {
                        reason: "commitment",
                        source: commitment.decision.source,
                        recordId: commitment.record?.id ?? null
                    },
                    target: commitTarget
                },
                targets: [],
                actions: []
            });
            log(`plan ${plan.id} preset=${presetId} commitment hit`);
            return { status: PLANNER_STATUS.ok, plan, reason: null };
        }
        // Issue #26 L2 morale: the layer resolves the team tier from the
        // combatant's `morale` record, derives the member-effective tier
        // through the trait exceptions (`fanatic`/`cowardly`) and
        // reports both on the trace. The bounded posture weight deltas
        // below narrow the scoring pass; the fireteam remaps the task
        // assignments. The team tier alone feeds `expectedState.morale`
        // (a tier change invalidates the commitment); the legacy #38
        // graceful morale reads stay unconditional.
        const moralePosture = applyMoraleLayer({
            combatant, context, flags: layerFlags, diagnostics,
            traits: personalityProfile.traits
        });
        diagnostics.morale = {
            enabled: moralePosture.enabled,
            state: moralePosture.state,
            tier: moralePosture.tier,
            effectiveTier: moralePosture.effectiveTier,
            pressured: moralePosture.pressured,
            desperate: moralePosture.desperate,
            confident: moralePosture.confident
        };
        const l3 = _runPersonalityLayer(personalityProfile);
        const personality = l3.personality;
        const personalityAmp = l3.personalityAmp;
        let effectiveWeights = l3.effectiveWeights;
        // L2 narrowing (issue #26): the member-effective tier shifts the
        // scoring weights inside a bounded delta map — desperate
        // postpones charges and pulls toward cover/regroup, confident
        // pushes the assault. The baseline `pressured` tier shifts
        // nothing.
        if (moralePosture.enabled === true && moralePosture.effectiveTier) {
            const shifted = applyMoraleWeightShift(
                effectiveWeights, moralePosture.effectiveTier);
            if (Object.keys(shifted.deltas).length) {
                effectiveWeights = shifted.weights;
                diagnostics.weights = { ...effectiveWeights };
                diagnostics.morale.shift = { ...shifted.deltas };
                recordLayerReason(diagnostics, "L2", "morale-weight-shift", {
                    tier: moralePosture.tier,
                    effectiveTier: moralePosture.effectiveTier,
                    deltas: shifted.deltas
                });
            }
        }
        // Prone halves the numeric movement budget (floor; crawl) — both
        // the navigation findCandidates input and the `budgetOver`
        // factor see the reduced value.
        const planContext = isProne
            ? { ...context, moveBudget: _halveMoveBudget(context.moveBudget ?? { mode: "full" }) }
            : context;
        // Prime the per-actor movement-rate cache: findCandidates is
        // synchronous and resolves {mode} budgets only against prefetched
        // rates (issue #398 system API or actor.system.movement).
        let moveRates = null;
        if (navigation && context.rates == null
            && typeof navigation.getMovementRates === "function") {
            try {
                moveRates = (await navigation.getMovementRates(tokenDoc))?.rates ?? null;
            } catch(_err) {
                // Rates stay unresolved; findCandidates degrades to stay.
            }
        }
        // Issue #31: a move bundled with a half action is a half move —
        // only endpoints within the half-move rate may combine; anything
        // further is a standalone full move. Prone crawls at half speed.
        const halfMoveRate = _finiteOr(
            context.halfMove ?? context.rates?.half ?? moveRates?.half, null);
        const halfMoveLimit = halfMoveRate !== null && isProne
            ? Math.floor(halfMoveRate / 2)
            : halfMoveRate;

        const targets = _resolveTargets({
            combat, combatant, tokenDoc, selfPos, sceneId, grid, perception,
            context: {
                ...context,
                // Smoke finding: presets opting into `seekContacts`
                // (spec-ops, assault) get rough radio-intel approach
                // markers when no LOS/memory/relay contact exists.
                seekContacts: context.seekContacts !== undefined
                    ? context.seekContacts
                    : preset?.seekContacts === true
            },
            // Issue #38 review: a `distrustsContacts` trait (loner) or a
            // `rabble` squad character makes the bot ignore shared
            // contacts — willfulness over shared intel.
            distrustsContacts:
                personalityBehaviorFlags(personality.traits).distrustsContacts === true
                || personality.character === "rabble"
        });
        diagnostics.metrics.targetsEvaluated = targets.length;
        diagnostics.targets = targets.map(t => ({
            id: t.tokenId ?? t.token?.id ?? null,
            source: t.source ?? "self",
            canAttack: t.canAttack !== false,
            lastSeenRound: t.lastSeenRound ?? null,
            via: t.sourceCombatantId ?? null
        }));
        // Issue #16 threat map: one aggregated danger field built once per
        // plan from the resolved enemies' weapon loadouts (weapon EV +
        // range emitters). `context.threatMap` injects a ready map or a
        // service (`refresh` runs here), `context.threats` injects raw
        // sources; derived sources only engage on normal+hard — easy bots
        // never read the field.
        const threats = _enemyThreats({ targets, combat, scene, context: planContext });
        const losProbe = typeof planContext.los === "function" ? planContext.los : undefined;
        const threatMap = _resolveThreatMap({
            difficulty, threats, grid, los: losProbe,
            service: _service("threatMap"), context: planContext
        });
        const dangerAt = threatMap ? point => threatMap.dangerAt(point) : null;
        if (threatMap) {
            diagnostics.threatMap = {
                threats: Array.isArray(threatMap.threats) ? threatMap.threats.length : threats.length
            };
        }
        if (!targets.length && !preset.allowNoTarget) {
            diagnostics.trace = buildLayerTrace(diagnostics);
            return {
                status: PLANNER_STATUS.noTarget,
                reason: "no-target",
                plan: null,
                diagnostics
            };
        }

        const allActions = await _resolveActions(actor, context);
        // Issue #15: aim and reload entries are auxiliary actions — they
        // join the budget economy but never become attack candidates.
        const aimActions = _aimActions(allActions);
        const aimHalfAction = aimActions.find(action => _actionCost(action) === 1) ?? null;
        const aimFullAction = aimActions.find(action => _actionCost(action) >= 2)
            ?? aimHalfAction;
        const reloadActions = allActions.filter(action => action.type === "reload");
        const actions = allActions.filter(action => action.type === "attack"
            || action.type === "test");
        // AimedUntil: a combatant `aim` flag left by a previous full-aim
        // turn is consumed by this turn's attack step. Re-aiming only
        // makes sense when it raises the booked bonus.
        const carriedAim = _finiteOr(
            planContext.carriedAim,
            combatant?.getFlag?.(MODULE_ID, FLAG_KEYS.aim)?.bonus ?? null
        );
        // `maxActions` bounds weapons, not action rows: curated attack
        // types of one weapon must not crowd other weapons out.
        const actionGroups = new Map();
        for (const action of actions) {
            // Smoke finding: a jammed weapon cannot fire — its attack/test
            // rows leave the usable pool so the plan falls back to
            // reload/ready/melee candidates instead of a dead shot.
            if ((action.type === "attack" || action.type === "test")
                && _weaponJammedOf(actor, action)) {
                diagnostics.rejected.push({
                    candidate: `action|${action.id}`, reason: "weapon-jammed"
                });
                recordLayerReason(diagnostics, "L0", "weapon-jammed", `action|${action.id}`);
                continue;
            }
            const key = action.itemUuid ?? action.itemId ?? action.name ?? action.id;
            if (!actionGroups.has(key)) actionGroups.set(key, []);
            actionGroups.get(key).push(action);
        }
        const usableActions = [...actionGroups.values()]
            .slice(0, _finiteOr(context.maxActions, DEFAULT_MAX_ACTIONS))
            .flat();
        // Issue #37: ready-weapon candidates rescue a bot whose attack
        // list is dry (empty clip, unreadied weapon) — they keep it out
        // of the `no-action` failure when the system or the inventory
        // still offers a live weapon to draw. Issue #53: synthesized
        // inventory candidates only when the system can actually run
        // the draw — a missing endpoint produces failed turns.
        const readyApi = context.actionsApi
            ?? globalThis.game?.darkHeresy?.api?.actions
            ?? null;
        const readyCapable = typeof readyApi?.readyWeapon === "function"
            || typeof readyApi?.ready === "function"
            || typeof readyApi?.equip === "function";
        const readyActions = _readyWeaponActions({
            allActions, actor, usableActions, readyCapable
        });
        if (!usableActions.length && !readyActions.length
            && !preset.allowNoAction && targets.length) {
            diagnostics.trace = buildLayerTrace(diagnostics);
            return {
                status: PLANNER_STATUS.noAction,
                reason: "no-action",
                plan: null,
                diagnostics
            };
        }

        // Numeric movement budget used by the `budgetOver` factor; injected
        // budgets may be a number or `{budget|limit}` objects from callers
        // like the executor. `planContext` already carries the halved
        // prone budget.
        const moveBudget = Number.isFinite(planContext.moveBudget)
            ? planContext.moveBudget
            : _finiteOr(planContext.moveBudget?.budget ?? planContext.moveBudget?.limit, null);
        // Issue #33: `context.spent` subtracts budget already consumed
        // this turn — GM manual actions or a partial execution before a
        // replan. Movement endpoints past the remainder are filtered out;
        // a spent-up action budget leaves only free actions.
        const spentMove = _finiteOr(context.spent?.movement, 0);
        const spentHalves = _finiteOr(context.spent?.halves, 0);
        const totalMoveBudget = Number.isFinite(moveBudget) ? moveBudget
            : _finiteOr(
                moveRates?.[planContext.moveBudget?.mode ?? "full"]
                    ?? context.rates?.[planContext.moveBudget?.mode ?? "full"],
                null);
        const remainingMove = spentMove > 0 && totalMoveBudget !== null
            ? Math.max(0, totalMoveBudget - spentMove)
            : null;
        const _withinRemaining = move => move?.stay === true
            || !Number.isFinite(move?.cost)
            || remainingMove === null
            || move.cost <= remainingMove + 1e-9;
        const actionBudget = Math.max(0,
            _finiteOr(context.actionBudget, ACTION_BUDGET_HALVES) - spentHalves);
        // Issue #37 weapon affinity/inertia inputs: `context` injections
        // win over the resolved config `preferredWeapon` and the
        // combatant `lastUsedWeapon` flag the executor wrote after the
        // previous successful attack.
        const preferredWeapon = context.preferredWeapon
            ?? config.preferredWeapon ?? null;
        const lastUsedWeapon = context.lastUsedWeapon
            ?? combatant?.getFlag?.(MODULE_ID, FLAG_KEYS.lastUsedWeapon)
            ?? combatant?.flags?.[MODULE_ID]?.[FLAG_KEYS.lastUsedWeapon]
            ?? null;
        const dodgeTN = _finiteOr(context.defaultDodgeTN, DEFAULT_DODGE_TN);
        // Issue #39: the combatant `lastAttacker` flag feeds the `grudge`
        // factor. It is deliberately kept out of the stale fingerprint —
        // a fresh hit must not force a replan. `context.lastAttacker`
        // injects the record in tests; `null` disables the factor.
        const lastAttackerRecord = context.lastAttacker !== undefined
            ? context.lastAttacker
            : (combatant?.getFlag?.(MODULE_ID, FLAG_KEYS.lastAttacker)
                ?? combatant?.flags?.[MODULE_ID]?.[FLAG_KEYS.lastAttacker]);
        const lastAttacker = _activeGrudge(lastAttackerRecord, combat);
        // Sticky-target memory: the combatant `lastTarget` flag the
        // executor wrote after the previous attack — valid while the
        // record is from this or the previous round, stale records read
        // as "no favourite" so a long-gone target never locks the bot.
        const lastTargetRecord = context.lastTarget !== undefined
            ? context.lastTarget
            : (combatant?.getFlag?.(MODULE_ID, FLAG_KEYS.lastTarget)
                ?? combatant?.flags?.[MODULE_ID]?.[FLAG_KEYS.lastTarget]);
        const lastTarget = lastTargetRecord && (lastTargetRecord.round == null
            || !Number.isFinite(combat?.round)
            || lastTargetRecord.round >= combat.round - 1)
            ? lastTargetRecord : null;
        // Issue #37 reaction slot: a bot that already spent its reaction
        // this round cannot bank another one — overwatch declarations
        // drop out of the candidate set.
        const selfReactionRecord = context.reactionUsed !== undefined
            ? context.reactionUsed
            : (combatant?.getFlag?.(MODULE_ID, FLAG_KEYS.reactionUsed)
                ?? combatant?.flags?.[MODULE_ID]?.[FLAG_KEYS.reactionUsed]);
        const selfReactionUsed = reactionUsed(selfReactionRecord, combat?.round);
        // Fallback approach points aim for the shortest usable range so a
        // melee-capable NPC keeps closing instead of stopping at gun range.
        const positiveRanges = usableActions
            .map(action => _actionRange(action))
            .filter(value => value > 0);
        const approachRange = positiveRanges.length ? Math.min(...positiveRanges) : 0;
        // The edge band is probed at the *farthest* weapon's reach —
        // `approachRange` is the shortest (a melee bot keeps closing), but
        // move-attack endpoints should exist for the longest-ranged gun.
        const bandRange = positiveRanges.length ? Math.max(...positiveRanges) : 0;
        const targetPosOf = target => ({ x: target?.x ?? null, y: target?.y ?? null });

        const candidates = [];
        let routesMissing = false;
        // L0 hard vetoes (issue #24): every candidate rejection is
        // absolute — no personality or morale layer may revive it, and
        // each is mirrored into the unified layer reason trace.
        const rejectL0 = (candidate, reason) => {
            diagnostics.rejected.push({ candidate, reason });
            recordLayerReason(diagnostics, "L0", reason, candidate);
        };
        // Dedup guard so a status veto logs one diagnostics entry per
        // candidate/reason instead of one per enumerated move.
        const rejectedOnce = new Set();
        const rejectOnce = (candidate, reason) => {
            const key = `${candidate}|${reason}`;
            if (rejectedOnce.has(key)) return;
            rejectedOnce.add(key);
            rejectL0(candidate, reason);
        };
        // Blast-awareness context: aim points are searched once per
        // action/target over this coverage set; friendlies always veto a
        // point, neutrals veto it unless `includeNeutral` marks them as
        // legitimate targets (hostage-execution scenes).
        const blastOptions = {
            includeNeutral: context.includeNeutral === true,
            dispositions: Array.isArray(context.dispositions) ? context.dispositions : null
        };
        const blastTokens = _blastTokens(context, combat, sceneId);
        const viewerDisposition = _finiteOr(
            _tokenDoc(combatant?.token)?.disposition ?? combatant?.disposition, 0);
        const pxPerUnit = _pxPerUnit(grid);
        // Issue #39: the same scene token scan backs two pure factor
        // inputs — hostiles engaged in melee with an ally
        // (`alliedEngagement`) and enemy contact reaches for the
        // free-attack factors (`leaveMeleeEngage`/`engageDenial`).
        const enemyContacts = _enemyContacts(targets, threats, pxPerUnit);
        const shooterProfiles = _shooterProfiles(threats);
        const contactReachPx = new Map();
        for (const contact of enemyContacts) {
            if (contact.tokenUuid != null) contactReachPx.set(contact.tokenUuid, contact.reachPx);
        }
        const allyEngagedTargets = _allyEngagedTargets({
            tokens: blastTokens,
            viewerDisposition,
            selfTokenUuid: _tokenUuid(tokenDoc, sceneId)
                ?? tokenDoc?.uuid ?? tokenDoc?.id ?? null,
            reachPx: DEFAULT_MELEE_RANGE * (pxPerUnit > 0 ? pxPerUnit : 1),
            // Review: engagement reach is the pair's max — a spear-armed
            // ally or a long-limbed hostile engages a cell further.
            resolveReachPx: (target, ally) => {
                const hostile = contactReachPx.get(target.tokenUuid) ?? null;
                const friendly = _tokenMeleeReachPx(ally.tokenId, { combat, scene, pxPerUnit });
                const best = Math.max(hostile ?? 0, friendly ?? 0);
                return best > 0 ? best : null;
            },
            options: blastOptions
        });
        // Smoke finding: a bot standing inside an enemy's melee reach does
        // not charge a *different* target unless the new target is a
        // substantially greater threat — disengaging earns the adjacent
        // enemy a free attack and produced the "charges away from the
        // adjacent foe" behaviour seen in the smoke. `engagedThreat` is
        // the highest `threat` among known targets already in reach;
        // -1 means the bot is not engaged at all.
        const engageReachUnits = Math.max(DEFAULT_MELEE_RANGE,
            ...usableActions.filter(_isMeleeAction).map(a => _finiteOr(_actionRange(a), 0)));
        const engagedThreat = targets.reduce((best, other) => {
            const d = _pixelDistance(selfPos, other, grid);
            return Number.isFinite(d) && d <= engageReachUnits + 1e-9
                ? Math.max(best, _finiteOr(other?.threat, 0)) : best;
        }, -1);
        for (const target of targets.slice(0, _finiteOr(context.maxTargets, DEFAULT_MAX_TARGETS))) {
            const distance = _finiteOr(target.distance, Infinity);
            // Memory contacts are investigated at weapon range, not
            // hugged: the shortest-range `approachRange` used to walk a
            // rifleman right onto the remembered square (smoke finding —
            // the spec-ops bot kept hugging a stale ghost).
            const moves = _resolveMoves({
                tokenDoc, target,
                range: _isMemorySource(target.source) && bandRange > 0
                    ? bandRange : approachRange,
                bandRange,
                selfPos, targetPos: targetPosOf(target),
                grid, navigation, perception, context: planContext
            }).filter(_withinRemaining);
            diagnostics.metrics.movesEvaluated += moves.length;

            let approachMove = null;
            for (const move of moves) {
                if (move.stay) continue;
                if (!approachMove || (_finiteOr(move.distance, Infinity)
                    < _finiteOr(approachMove.distance, Infinity))) {
                    approachMove = move;
                }
            }

            let attackFound = false;
            // Blast weapons may strike a last-known position (room
            // clearing) even when the remembered target is not attackable.
            // Issue #38: shared team contacts count as memory too.
            const memoryStrike = _isMemorySource(target.source)
                && usableActions.some(action => _actionBlastRadius(action) > 0
                    && !_isMeleeAction(action));
            if (target.canAttack !== true && !memoryStrike) {
                rejectL0(`attack|${target.tokenUuid}`, "target-not-attackable");
            } else if (!usableActions.length) {
                rejectL0(`attack|${target.tokenUuid}`, "no-action");
            } else {
                // One attack variant per legal action so presets can prefer
                // melee charge plans over a higher-damage ranged option.
                for (const action of usableActions) {
                    const tag = `${action.id}|${target.tokenUuid}`;
                    if (_actionCost(action) > actionBudget) {
                        rejectL0(`action|${tag}`, "over-budget");
                        continue;
                    }
                    // Cone weapons aim a direction, not a token — their
                    // candidates are generated once after the target loop.
                    if (_coneSpecOf(action)) continue;
                    const range = _actionRange(action);
                    const melee = _isMeleeAction(action);
                    // Blast weapons do not attack the target token itself:
                    // they aim at a point whose template covers hostiles
                    // and never friendlies (`blastTokens` scan). Aiming at
                    // a last-known memory position is allowed too — the
                    // LOS gate drops for remembered strikes.
                    if (_actionBlastRadius(action) > 0 && !melee) {
                        const presumed = _isMemorySource(target.source)
                            ? (target.tokenUuid ?? null) : null;
                        const aimInput = {
                            tokenDoc,
                            target,
                            rangePx: range * pxPerUnit,
                            radiusPx: _actionBlastRadius(action) * pxPerUnit,
                            tokens: blastTokens,
                            viewerDisposition,
                            options: blastOptions,
                            perception
                        };
                        const aim = _bestBlastAim({
                            ...aimInput,
                            origin: selfPos,
                            presumedUuid: presumed,
                            requireLos: presumed === null
                        });
                        if (aim) {
                            candidates.push({
                                target, action, move: null,
                                variant: "attack-in-place",
                                aim: aim.point,
                                blastHits: aim.hits
                            });
                            attackFound = true;
                            // Half aim (+10) + a half-cost blast throw
                            // fills the turn budget exactly. Skipped when
                            // a carried aimedUntil bonus already matches
                            // or beats the half-aim value, or when the
                            // remaining budget cannot pay both halves.
                            if (aimHalfAction && _actionCost(action) === 1
                                && 1 + 1 <= actionBudget
                                && _finiteOr(aimHalfAction.aim, 10) > _finiteOr(carriedAim, 0)) {
                                candidates.push({
                                    target, action, move: null,
                                    variant: "aim-attack",
                                    aim: aim.point,
                                    blastHits: aim.hits,
                                    aimBonus: aimHalfAction.aim
                                });
                            }
                        } else {
                            rejectOnce(`blast|${tag}`, presumed === null
                                ? "blast-no-safe-aim" : "blast-unclear-position");
                        }
                        if (!presumed && !isPinned) {
                            for (const move of moves) {
                                if (move.stay) continue;
                                // Issue #31: blast thrown after a move is
                                // a half move — beyond half rate it is a
                                // standalone relocation instead. Issue #33:
                                // the combo also needs a free half action.
                                if (_actionCost(action) + 1 > actionBudget
                                    || (halfMoveLimit !== null
                                        && Number.isFinite(move.cost)
                                        && move.cost > halfMoveLimit + 1e-9)) continue;
                                const aimFromMove = _bestBlastAim({
                                    ...aimInput,
                                    origin: { x: move.x, y: move.y },
                                    presumedUuid: null,
                                    requireLos: true
                                });
                                if (!aimFromMove) continue;
                                candidates.push({
                                    target, action, move,
                                    variant: "move-attack",
                                    aim: aimFromMove.point,
                                    blastHits: aimFromMove.hits
                                });
                                attackFound = true;
                            }
                        }
                        continue;
                    }
                    // The weapon's own `charge` attack type — when the
                    // system API exposes one — is the canonical action
                    // for move-into-reach candidates; sibling attack
                    // types of the same weapon defer to it instead of
                    // duplicating the charge variant.
                    const weaponKey = action.itemUuid ?? action.itemId
                        ?? action.name ?? action.id;
                    const chargePeer = action.attackType === "charge" ? null
                        : usableActions.find(other => other !== action
                            && other.attackType === "charge"
                            && (other.itemUuid ?? other.itemId ?? other.name ?? other.id)
                                === weaponKey);
                    // Status constraints: pinned and prone combatants
                    // cannot charge at all; a pinned combatant may still
                    // reposition while keeping or increasing the distance
                    // to the target.
                    const chargeVeto = isPinned ? "pinned" : (isProne ? "prone" : null);
                    // `alreadyEngaged` measures contact the way the move
                    // endpoints do (centre-to-centre `_pixelDistance`) —
                    // `target.distance` may arrive from a different
                    // measure and read an adjacent enemy as out of reach,
                    // which used to turn the same in-place swing into a
                    // spurious "charge" (smoke finding).
                    const selfTargetDistance = _pixelDistance(selfPos, target, grid);
                    const alreadyEngaged = melee === true
                        && Number.isFinite(selfTargetDistance)
                        && selfTargetDistance <= range + 1e-9;
                    let inPlace = false;
                    if (distance <= range + 1e-9 || alreadyEngaged) {
                        candidates.push({ target, action, move: null, variant: "attack-in-place" });
                        inPlace = true;
                        attackFound = true;
                        // Issue #15: aim.half (+10) + a half-cost attack
                        // consumes the whole two-half budget — only
                        // half-cost attack types qualify. Skipped when a
                        // carried aimedUntil bonus is already as good or
                        // the remaining budget cannot pay both halves.
                        if (aimHalfAction && _actionCost(action) === 1
                            && 1 + 1 <= actionBudget
                            && _finiteOr(aimHalfAction.aim, 10) > _finiteOr(carriedAim, 0)) {
                            candidates.push({
                                target, action, move: null,
                                variant: "aim-attack",
                                aimBonus: aimHalfAction.aim
                            });
                        }
                    } else {
                        rejectL0(`attack-in-place|${tag}`, "out-of-range");
                    }
                    let attackMoveFound = false;
                    let chargeRuleVeto = false;
                    let attackMoves = moves;
                    // A charge exists to close distance вЂ” when a melee
                    // attack is already possible in place (which
                    // `alreadyEngaged` feeds), repositioning
                    // move-attacks are only generated for ranged actions.
                    if (!melee || !inPlace) {
                        // OW charge rules (smoke tuning): the run-up must
                        // cover at least CHARGE_MIN_DISTANCE units and
                        // follow a straight line; candidates reach out to
                        // the system `charge` rate (3×AB) instead of the
                        // ordinary full-move budget, so melee gets its
                        // own enumeration.
                        const chargeTooClose = melee === true
                            && Number.isFinite(selfTargetDistance)
                            && selfTargetDistance < CHARGE_MIN_DISTANCE;
                        if (melee === true && !chargeTooClose && !chargeVeto
                            && Array.isArray(context.moves) !== true
                            && navigation) {
                            const chargeLimit = _finiteOr(
                                context.chargeMove
                                    ?? context.rates?.charge ?? moveRates?.charge,
                                null);
                            const budget = chargeLimit ?? totalMoveBudget;
                            if (budget !== null) {
                                const chargeRemaining = spentMove > 0
                                    ? Math.max(0, budget - spentMove) : null;
                                attackMoves = _resolveMoves({
                                    tokenDoc, target, range,
                                    selfPos, targetPos: targetPosOf(target),
                                    grid, navigation, perception,
                                    context: {
                                        ...planContext,
                                        moveBudget: budget
                                    }
                                }).filter(move => move?.stay === true
                                    || !Number.isFinite(move?.cost)
                                    || chargeRemaining === null
                                    || move.cost <= chargeRemaining + 1e-9);
                                diagnostics.metrics.movesEvaluated += attackMoves.length;
                            }
                        }
                        for (const move of attackMoves) {
                            if (move.stay) continue;
                            if (!Number.isFinite(move.distance) || move.distance > range + 1e-9) continue;
                            // Moving into melee reach is a charge; any
                            // other move inside weapon range is move+attack.
                            const variant = melee ? "charge" : "move-attack";
                            // Endpoint LOS (smoke finding): a move-attack
                            // whose firing cell cannot see the target is
                            // wasted motion — navigation may have priced
                            // `move.los`; when it did not, probe the
                            // endpoint directly. Melee charges reach
                            // around corners by contact, so the gate
                            // stays on ranged variants only.
                            if (variant === "move-attack" && move.los !== true
                                && perception && typeof perception.hasLineOfSight === "function") {
                                let endpointLos = true;
                                try {
                                    endpointLos = perception.hasLineOfSight(
                                        { center: { x: move.x, y: move.y }, document: null },
                                        { center: { x: target.x, y: target.y }, document: null }
                                    ) === true;
                                } catch(err) {
                                    endpointLos = true;
                                }
                                if (!endpointLos) {
                                    rejectOnce(`move-attack|${tag}`, "no-los-endpoint");
                                    continue;
                                }
                            }
                            // Issue #15 action budget: a full-cost action
                            // cannot follow a half move — move+full_auto
                            // or move+allOut are illegal. The `charge`
                            // attack type is the exception: its full
                            // action already includes the move.
                            if (_actionCost(action) >= 2
                                && action.attackType !== "charge") {
                                rejectOnce(`${variant}|${tag}`, "full-after-move");
                                continue;
                            }
                            // Issue #31: a move bundled with a half-cost
                            // attack is a half move — endpoints beyond
                            // the half-move rate belong to standalone
                            // approach/full-move candidates instead.
                            // Issue #33: the combo also needs a free half
                            // action on top of the attack's own cost.
                            if (variant === "move-attack") {
                                if (_actionCost(action) + 1 > actionBudget) {
                                    rejectOnce(`${variant}|${tag}`, "over-budget");
                                    continue;
                                }
                                if (halfMoveLimit !== null
                                    && Number.isFinite(move.cost)
                                    && move.cost > halfMoveLimit + 1e-9) {
                                    rejectOnce(`${variant}|${tag}`, "beyond-half-move");
                                    continue;
                                }
                            }
                            // Pinned/prone veto charges outright; a
                            // sibling `charge` attack type owns the
                            // variant so other types skip it (dedup, not
                            // a rejection).
                            if (variant === "charge" && chargeVeto) {
                                rejectOnce(`charge|${tag}`, chargeVeto);
                                continue;
                            }
                            // OW run-up rules: a charge covers at least
                            // CHARGE_MIN_DISTANCE units and follows a
                            // straight line to the endpoint (smoke
                            // tuning).
                            if (variant === "charge" && chargeTooClose) {
                                rejectOnce(`charge|${tag}`, "charge-too-close");
                                chargeRuleVeto = true;
                                continue;
                            }
                            if (variant === "charge"
                                && !_chargeStraight(move, selfPos, grid,
                                    CHARGE_STRAIGHT_TOLERANCE)) {
                                rejectOnce(`charge|${tag}`, "charge-bent-route");
                                continue;
                            }
                            // The straight run must point AT the target —
                            // a charge line that ends beside the enemy
                            // on a line heading elsewhere is vetoed.
                            if (variant === "charge"
                                && !_chargeAimsAt(move, selfPos,
                                    targetPosOf(target), grid, range)) {
                                rejectOnce(`charge|${tag}`, "charge-off-line");
                                continue;
                            }
                            // Engaged veto (smoke finding): charging a
                            // different target while already in reach of
                            // an enemy is only justified when the new
                            // target is a substantially greater threat —
                            // the engaged foe would take a free attack.
                            if (variant === "charge" && engagedThreat >= 0 && !alreadyEngaged
                                && _finiteOr(target.threat, 0)
                                    <= engagedThreat + CHARGE_SWITCH_MARGIN) {
                                rejectOnce(`charge|${tag}`, "already-engaged");
                                continue;
                            }
                            if (variant === "charge" && chargePeer) continue;
                            // Pinned: a move-attack that ends closer to
                            // the target is vetoed; distance-keeping
                            // moves stay legal.
                            if (variant === "move-attack" && isPinned
                                && move.distance < distance) {
                                rejectOnce(`move-attack|${tag}`, "pinned");
                                continue;
                            }
                            candidates.push({ target, action, move, variant });
                            attackMoveFound = true;
                            attackFound = true;
                        }
                    }
                    if (!inPlace && !attackMoveFound && !chargeRuleVeto) {
                        rejectL0(`${melee ? "charge" : "move-attack"}|${tag}`,
                            attackMoves.some(move => !move.stay) ? "out-of-range" : "no-route");
                    }
                }
            }

            // A closing approach is a relocation that ends nearer the
            // target — pinned combatants may only move while keeping or
            // increasing the distance, exactly like move-attack.
            const approachVetoed = approachMove !== null && isPinned
                && Number.isFinite(approachMove.distance)
                && approachMove.distance < distance;
            // Issue #33: a standalone move still costs an action — a
            // full move needs both halves, a ≤half move needs one.
            const approachHalves = approachMove
                ? (halfMoveLimit !== null
                    && _finiteOr(approachMove.cost, 0) > halfMoveLimit ? 2 : 1)
                : 0;
            if (approachMove && !approachVetoed && approachHalves <= actionBudget) {
                candidates.push({ target, action: null, move: approachMove, variant: "approach" });
            } else if (approachVetoed) {
                rejectL0(`approach|${target.tokenUuid}`, "pinned");
            } else if (!attackFound) {
                routesMissing = true;
                rejectL0(`approach|${target.tokenUuid}`, "no-route");
            }

            // Seek mechanic (smoke request): on a non-visible contact —
            // own memory, relay or radio intel — offer cautious close-in
            // variants whose endpoints stay out of the presumed firing
            // lane (`los:false` toward the contact point = wall geometry
            // hides the cell). Action economy is unchanged: a short seek
            // fits a half move, a long one spends the full action; the
            // `seek` factor lets presets/personalities decide whether
            // hiding outranks the faster open approach.
            if (_isMemorySource(target.source) && Number.isFinite(distance)) {
                let seeked = 0;
                for (const move of moves) {
                    if (seeked >= SEEK_MAX_CANDIDATES) break;
                    if (move.stay || move.los !== false) continue;
                    if (!Number.isFinite(move.distance)
                        || move.distance >= distance - 1e-9) continue;
                    if (isPinned && move.distance < distance) continue;
                    const seekHalves = halfMoveLimit !== null
                        && _finiteOr(move.cost, 0) > halfMoveLimit ? 2 : 1;
                    if (seekHalves > actionBudget) continue;
                    candidates.push({
                        target, action: null, move, variant: "seek"
                    });
                    seeked++;
                }
            }

            // Run mechanic (smoke request): a sprint at the run rate is
            // the only way to close more than a full move in one turn.
            // It always costs the whole action economy (2 halves — no
            // attack follows) and is offered only when its nearest
            // endpoint lands strictly closer than the best approach
            // endpoint; a pinned/prone bot cannot sprint at all. The
            // executor marks the bot `running` for the +20-evasion
            // window after such a move.
            const runRate = _finiteOr(
                moveRates?.run ?? context.rates?.run, null);
            const runNav = navigation
                || Array.isArray(context.runMoves);
            if (runRate !== null && runRate > 0
                && !isPinned && !isProne && actionBudget >= 2 && runNav) {
                const runRemaining = spentMove > 0
                    ? Math.max(0, runRate - spentMove) : runRate;
                const runContext = {
                    ...planContext,
                    moveBudget: { mode: "run" },
                    moves: Array.isArray(context.runMoves)
                        ? context.runMoves : undefined
                };
                let runMove = null;
                for (const move of _resolveMoves({
                    tokenDoc, target,
                    range: _isMemorySource(target.source) && bandRange > 0
                        ? bandRange : approachRange,
                    bandRange,
                    selfPos, targetPos: targetPosOf(target),
                    grid, navigation, perception, context: runContext
                })) {
                    if (move.stay) continue;
                    if (!Number.isFinite(move.cost)
                        || move.cost > runRemaining + 1e-9) continue;
                    if (!runMove || (_finiteOr(move.distance, Infinity)
                        < _finiteOr(runMove.distance, Infinity))) {
                        runMove = move;
                    }
                }
                diagnostics.metrics.movesEvaluated += runMove ? 1 : 0;
                if (runMove && Number.isFinite(runMove.distance)
                    && runMove.distance
                        < (_finiteOr(approachMove?.distance, Infinity) - 1e-9)) {
                    candidates.push({
                        target, action: null, move: runMove, variant: "run"
                    });
                }
            }
        }

        // Directed-cone weapons (spray, suppressing fire) cover a sector
        // rather than a token: `_bestConeAim` sweeps firing directions for
        // maximum hostile coverage under a strict friendly/neutral veto.
        // One attack-in-place candidate per template action; spray may
        // also reposition — suppression is a sustained area attack and
        // never combines with movement.
        // Issue #30: cone orientation anchors are only perceived contacts —
        // visible targets aim their live position, last-known contacts the
        // remembered point. Hostiles present on the scene but unknown to
        // the bot (no LOS, no memory) never steer the template; the
        // friendly/neutral veto still scans every scene token for safety.
        const coneAnchors = targets
            .filter(target => target?.hidden !== true
                && Number.isFinite(target?.x) && Number.isFinite(target?.y))
            .map(target => ({
                tokenUuid: target.tokenUuid ?? null,
                tokenId: target.tokenId ?? null,
                x: target.x,
                y: target.y,
                elevation: target.elevation ?? null,
                source: target.source ?? null
            }));
        for (const action of usableActions) {
            const spec = _coneSpecOf(action);
            if (!spec) continue;
            const range = _actionRange(action);
            const aimInput = {
                tokenDoc,
                rangePx: range * pxPerUnit,
                angleDeg: spec.angle,
                tokens: blastTokens,
                anchors: coneAnchors,
                viewerDisposition,
                options: blastOptions,
                perception
            };
            const aim = _bestConeAim({ ...aimInput, origin: selfPos });
            if (!aim) {
                rejectL0(`cone|${action.id}`, "cone-no-safe-aim");
                continue;
            }
            const coneTarget = _coneTargetOf(aim, targets, selfPos, grid);
            candidates.push({
                target: coneTarget, action, move: null,
                variant: "attack-in-place",
                cone: { ...aim, spec }
            });
            if (!spec.spray || isPinned) continue;
            // Spray move-attack: aim is recomputed from each route
            // endpoint so a repositioned cone still clears all friendlies.
            const coneMoves = _resolveMoves({
                tokenDoc, target: coneTarget, range,
                selfPos, targetPos: { x: coneTarget?.x ?? null, y: coneTarget?.y ?? null },
                grid, navigation, perception, context: planContext
            }).filter(_withinRemaining);
            diagnostics.metrics.movesEvaluated += coneMoves.length;
            for (const move of coneMoves) {
                if (move.stay) continue;
                // Issue #31: spray + reposition is a half move combo.
                // Issue #33: it also needs a free half action.
                if (_actionCost(action) + 1 > actionBudget
                    || (halfMoveLimit !== null
                        && Number.isFinite(move.cost)
                        && move.cost > halfMoveLimit + 1e-9)) continue;
                const aimFromMove = _bestConeAim({
                    ...aimInput,
                    origin: { x: move.x, y: move.y }
                });
                if (!aimFromMove) continue;
                candidates.push({
                    target: coneTarget, action, move,
                    variant: "move-attack",
                    cone: { ...aimFromMove, spec }
                });
            }
        }

        // ---- Issue #15 action-economy candidates ----------------------

        // Full aim (+20 on the next attack): a full action whose bonus
        // persists on the combatant `aim` flag until the shot is taken
        // (aimedUntil). Worth planning when no shot is available now or
        // the preset explicitly prefers it.
        const threatTarget = _nearestThreat(targets, selfPos, grid);
        // Standalone aim only makes sense for a ranged loadout facing a
        // live contact — for last-known memories a search move or an
        // overwatch declaration is the meaningful turn instead.
        const hasRangedAction = usableActions.some(action => action.type === "attack"
            && !_isMeleeAction(action) && _actionRange(action) > 0);
        if (!isPinned && aimFullAction && threatTarget?.canAttack === true
            && hasRangedAction
            && _actionCost(aimFullAction) <= actionBudget
            && _finiteOr(aimFullAction.aim, 20) > _finiteOr(carriedAim, 0)) {
            candidates.push({
                variant: "aim",
                action: aimFullAction,
                aimBonus: aimFullAction.aim ?? 20,
                target: threatTarget,
                move: null
            });
        }

        // Reload candidates for clip-fed weapons (`kind:"reload"` entries
        // from the system `actions.list`). A half-cost reload may follow
        // a half move (half+half budget); a full-cost reload stands alone.
        if (reloadActions.length) {
            let auxMoves = null;
            for (const reload of reloadActions) {
                const halves = _actionCost(reload);
                if (halves > actionBudget) {
                    rejectL0(`reload|${reload.id}`, "over-budget");
                    continue;
                }
                candidates.push({
                    variant: "reload",
                    action: reload,
                    target: threatTarget,
                    move: null
                });
                if (halves > 1 || isPinned) continue;
                if (auxMoves === null) {
                    auxMoves = threatTarget
                        ? _resolveMoves({
                            tokenDoc, target: threatTarget, range: approachRange,
                            selfPos,
                            targetPos: { x: threatTarget.x, y: threatTarget.y },
                            grid, navigation, perception, context: planContext
                        }).filter(_withinRemaining)
                        : [];
                }
                for (const move of auxMoves) {
                    if (move.stay) continue;
                    // Issue #31: reload bundled with a move is a half move.
                    // Issue #33: it also needs a free half action.
                    if (halves + 1 > actionBudget
                        || (halfMoveLimit !== null
                            && Number.isFinite(move.cost)
                            && move.cost > halfMoveLimit + 1e-9)) continue;
                    candidates.push({
                        variant: "move-reload",
                        action: reload,
                        target: threatTarget,
                        move
                    });
                }
            }
        }

        // Overwatch: declare a watch zone toward the nearest visible
        // threat. The step only registers the declaration — the reaction
        // shot itself stays under manual GM control (issue #14 service,
        // #15 candidate). Issue #30: only a live visible target is a
        // valid orientation anchor — for own-memory contacts a search
        // move or a spray/memory-strike is the documented turn, and a
        // hidden or entirely unknown position never steers a declaration.
        // Issue #54: the zone aims at predicted positions (route
        // waypoint, lead points, remembered contacts), not the square the
        // enemy already occupies; spray and blast weapons declare their
        // own geometry (template cone, trigger circle).
        // Issue #38 review merge: a `team-contact` shared by a living
        // teammate DOES gate the declaration — fresh squad intel, not the
        // bot's stale own memory (own `last-known` stays excluded).
        if (!isPinned) {
            const owWeapons = _overwatchWeapons(usableActions);
            const owGate = threatTarget
                && (threatTarget.canAttack === true
                    || threatTarget.source === "team-contact")
                && threatTarget.hidden !== true;
            // Anchors are computed once — only while an overwatch
            // candidate is actually built, and the route probe stays
            // limited to the single nearest threat (issue #54 bound).
            const owAnchors = owWeapons.length && owGate
                ? _overwatchAnchors({
                    targets, threatTarget, selfPos, pxPerUnit,
                    navigation, combat, scene, tokenDoc, perception
                })
                : [];
            for (const { action: owAction, kind } of owWeapons) {
                if (selfReactionUsed) {
                    // Issue #37: the reaction slot is spent — a
                    // declaration could never fire this round, so the
                    // zone is not offered.
                    rejectL0(`overwatch|${owAction.id}`, "reaction-used");
                    continue;
                }
                if (!owGate || ACTION_BUDGET_HALVES > actionBudget) continue;
                const zone = _overwatchZone({
                    kind, action: owAction, anchors: owAnchors,
                    threatTarget, selfPos, pxPerUnit, tokenDoc,
                    tokens: blastTokens, viewerDisposition,
                    options: blastOptions
                });
                if (!zone) continue;
                candidates.push({
                    variant: "overwatch",
                    action: owAction,
                    target: threatTarget,
                    move: null,
                    direction: zone.direction ?? null,
                    zone
                });
            }
        }

        // ---- Issue #37 free-action candidates -------------------------

        // `ready-weapon`: draw/equip an alternative weapon — the only
        // meaningful turn of a bot whose attack list is dry. Costs come
        // straight from the system entry (free under Quick Draw); the
        // inventory fallback synthesizes a half action.
        for (const ready of readyActions) {
            if (_actionCost(ready) > actionBudget) {
                rejectL0(`ready-weapon|${ready.id}`, "over-budget");
                continue;
            }
            candidates.push({
                variant: "ready-weapon",
                action: ready,
                target: threatTarget,
                move: null
            });
        }

        // `drop-prone`: a free-action cover answer — offered under fire
        // (pinned, or standing inside a real kill lane the threat map
        // reads ≥ DROP_PRONE_DANGER), never when already prone. Landing
        // prone engages the existing prone rules next turn (halved move
        // budget, no charge) instead of bypassing them.
        if (!isProne && threatTarget
            && (isPinned || (dangerAt && selfPos
                && _dangerAtSelf(dangerAt, selfPos) >= DROP_PRONE_DANGER))) {
            candidates.push({
                variant: "drop-prone",
                action: null,
                target: threatTarget,
                move: null
            });
        }

        // Issue #39 `unpin`: a pinned combatant may spend a full action
        // on the Willpower test that clears pinning — the recovery
        // alternative to the drop-prone cover answer. Actors without a
        // `willpower` characteristic never get the candidate; a pinned
        // bot that cannot even try logs `unpin-unavailable`.
        if (isPinned) {
            const unpin = _unpinAction(actor);
            if (!unpin) {
                rejectL0("unpin", "unpin-unavailable");
            } else if (_actionCost(unpin) > actionBudget) {
                rejectL0(`unpin|${unpin.id}`, "over-budget");
            } else {
                candidates.push({
                    variant: "unpin",
                    action: unpin,
                    target: threatTarget,
                    move: null
                });
            }
        }

        // Issue #38 orders: a fireteam leader may spend the turn giving an
        // order — a synthesized Command test carrying the order id/benefit
        // so the roll card records it (`flags.isOrder`). The fireteam
        // service supplies `context.team.orderCandidate`; a leader without
        // the Command skill is rejected `order-unavailable` upfront.
        const orderCandidate = context.team?.orderCandidate ?? null;
        if (orderCandidate) {
            const order = _orderAction(actor, orderCandidate);
            if (!order) {
                rejectL0(`order|${orderCandidate.orderId ?? "unknown"}`, "order-unavailable");
            } else if (_actionCost(order) > actionBudget) {
                rejectL0(`order|${order.orderId}`, "over-budget");
            } else {
                candidates.push({
                    variant: "order",
                    action: order,
                    target: threatTarget,
                    move: null
                });
            }
        }

        if (preset.alwaysOfferHold === true) {
            candidates.push({ variant: "hold", target: targets[0] ?? null, action: null, move: null });
        }
        if (!candidates.length && preset.allowNoTarget && !targets.length) {
            candidates.push({ variant: "hold", target: null, action: null, move: null });
        }
        if (!candidates.length && preset.allowNoAction && !usableActions.length) {
            candidates.push({ variant: "hold", target: targets[0] ?? null, action: null, move: null });
        }

        if (!candidates.length) {
            diagnostics.trace = buildLayerTrace(diagnostics);
            return {
                status: routesMissing ? PLANNER_STATUS.noRoute : PLANNER_STATUS.noAction,
                reason: routesMissing ? "no-route" : "no-valid-plan",
                plan: null,
                diagnostics
            };
        }

        // Preset hooks see the caller context enriched with the resolved
        // runtime facts вЂ” service lookups, scene, token and normalized
        // targets вЂ” so evaluators can run LOS/cover probes without their
        // own registry access. Caller-injected keys always win.
        const evalContext = {
            combat,
            combatant,
            scene,
            token: tokenDoc,
            selfPos,
            perception,
            navigation,
            resolvedTargets: targets,
            usableActions,
            // Issue #15: presets check `aimAvailable`/`aimActions` to
            // decide whether an aimed attack is an option this turn.
            // `aimAvailable` keeps its original meaning — the API lists
            // an explicit aim action — synthesized aim stays invisible.
            aimActions,
            aimAvailable: aimActions.some(action => action.synthesized !== true),
            // Issue #24 review: merged trait flags reach preset
            // evaluators (`context.traitFlags`) — behaviour flags like
            // `ignoreRegroup` are enforced structurally, not through
            // bounded deltas the task overlay would mask.
            traitFlags: personalityBehaviorFlags(personality.traits),
            ...planContext
        };
        const scored = [];
        candidates.forEach((candidate, index) => {
            const dodge = dodgeChanceOf(candidate.target, candidate.action, dodgeTN);
            const factors = _factorsOf({
                ...candidate, moveBudget, dangerAt, selfPos, dodge,
                preferredWeapon, lastUsedWeapon,
                traits: personality.traits, dodgeTN,
                allyEngagedTargets, enemies: enemyContacts, lastAttacker,
                lastTarget, shooterProfiles,
                // Issue #38: disciplined/elite squads and pressured morale
                // (graceful #26 hook) raise the leader's order utility.
                orderBoost: {
                    character: personality.character === "disciplined"
                        || personality.character === "elite",
                    pressured: _moraleOf(combatant, context).pressured
                }
            });
            // Presets may veto candidates outright (e.g. a ranged preset
            // refusing attacks without a resolved line of sight); vetoed
            // entries land in `rejected` diagnostics instead of ranking.
            if (typeof preset.veto === "function") {
                let vetoReason = null;
                try {
                    vetoReason = preset.veto({ factors, candidate, context: evalContext }) ?? null;
                } catch(err) {
                    vetoReason = null;
                }
                if (vetoReason) {
                    rejectL0(_candidateId(candidate, index),
                        typeof vetoReason === "string" ? vetoReason : "preset-veto");
                    return;
                }
            }
            let evaluation;
            if (typeof preset.evaluate === "function") {
                const custom = preset.evaluate({
                    factors, candidate, weights: effectiveWeights, context: evalContext
                });
                evaluation = Number.isFinite(custom)
                    ? { score: custom, breakdown: { factors, custom: true } }
                    : {
                        score: _finiteOr(custom?.score, 0),
                        breakdown: custom?.breakdown ?? { factors, custom: true }
                    };
            } else {
                evaluation = evaluateFactors(factors, effectiveWeights);
            }
            // Issue #19: seeded per-candidate jitter — a deterministic
            // multiplier keyed by the stable candidate id that lets
            // unsteady personalities pick off the argmax while identical
            // input + seed still reproduces the identical plan.
            const candidateId = _candidateId(candidate, index);
            const jitterFactor = personalityJitterFactor({
                seed, candidateId, amp: personalityAmp
            });
            const score = jitterFactor === 1
                ? evaluation.score
                : (Math.round(evaluation.score * jitterFactor * 1e6) / 1e6) + 0;
            scored.push({
                ...candidate,
                id: candidateId,
                factors,
                dodge,
                score,
                breakdown: jitterFactor !== 1
                    ? {
                        ...evaluation.breakdown,
                        jitter: {
                            amp: personalityAmp,
                            factor: Math.round(jitterFactor * 1e6) / 1e6
                        }
                    }
                    : evaluation.breakdown
            });
        });
        scored.sort((a, b) => (b.score - a.score) || String(a.id).localeCompare(String(b.id)));

        diagnostics.candidatesCount = scored.length;
        diagnostics.ranking = scored.map(entry => ({
            candidate: entry.id,
            score: entry.score,
            // Smoke asserts read the winner's engagement context: melee
            // vs ranged pick and whether the shot fires into an ally's
            // melee (the −20 friendly-fire lane).
            melee: entry.factors?.melee === 1,
            alliedEngaged: entry.factors?.alliedEngagement === 1
        }));
        recordLayerReason(diagnostics, "L4", "scored", {
            candidates: scored.length
        });

        if (!scored.length) {
            diagnostics.trace = buildLayerTrace(diagnostics);
            return {
                status: PLANNER_STATUS.noAction,
                reason: "no-valid-plan",
                plan: null,
                diagnostics
            };
        }

        // Issue #16 lookahead (2-ply, model-level): the top-K candidates
        // are re-scored by the expected counter damage of the strongest
        // responding enemy emitter —
        // `adjusted = score − λ × expectedCounterDamage`. No world
        // simulation: the counter model only reads the same snapshot data
        // (enemy emitters, distances, the sight probe) the threat map
        // uses, so the pass stays deterministic. Enabled on hard
        // difficulty or through `context.lookahead`.
        const lookahead = _lookaheadConfig(planContext, difficulty);
        // Issue #24: the L4 lookahead flag is the master gate — off
        // degrades to plain base-utility scoring even on hard difficulty
        // and even with a `context.lookahead` force-enable.
        if (layerFlags.lookahead === false && lookahead.enabled) {
            lookahead.enabled = false;
            recordLayerReason(diagnostics, "L4", "lookahead-layer-disabled");
        }
        let pickPool = scored;
        let scoreOf = entry => entry.score;
        if (lookahead.enabled) {
            recordLayerReason(diagnostics, "L4", "lookahead", {
                lambda: lookahead.lambda,
                topK: lookahead.topK
            });
            pickPool = _applyLookahead(scored, {
                threats, grid, los: losProbe,
                lambda: lookahead.lambda,
                topK: lookahead.topK,
                selfPos
            });
            scoreOf = entry => _finiteOr(entry.lookahead?.adjusted, entry.score);
            diagnostics.lookahead = {
                lambda: lookahead.lambda,
                topK: lookahead.topK,
                entries: pickPool.map(entry => ({
                    candidate: entry.id,
                    score: entry.score,
                    counterDamage: entry.lookahead.counterDamage,
                    adjusted: entry.lookahead.adjusted
                }))
            };
        }

        const topScore = scoreOf(pickPool[0]);
        const top = pickPool.filter(entry => scoreOf(entry) === topScore);
        let winner = top.length > 1 ? _seededPick(top, seed) : top[0];

        // Issue #16 difficulty: on easy the bot deliberately slips — with
        // `EASY_MISTAKE_CHANCE` probability the winner is a seeded pick
        // among the next-best candidates instead of the argmax. The slip
        // roll uses its own XOR-masked seed stream; identical seed
        // reproduces the identical plan.
        if (difficulty === "easy" && pickPool.length > 1) {
            const chance = _finiteOr(planContext.easyMistakeChance, EASY_MISTAKE_CHANCE);
            const mistake = mulberry32((seed ^ EASY_PICK_SEED_XOR) >>> 0)() < chance;
            diagnostics.easyPick = { chance, mistake };
            recordLayerReason(diagnostics, "L4", "easy-slip", { chance, mistake });
            if (mistake) {
                const rest = pickPool.filter(entry => entry !== winner)
                    .slice(0, EASY_PICK_TOP_K);
                if (rest.length) winner = _seededPick(rest, seed);
            }
        }
        if (winner.lookahead) {
            winner.breakdown = {
                ...winner.breakdown,
                lookahead: { ...winner.lookahead, lambda: lookahead.lambda }
            };
        }
        // Issue #37: the dodge verdict of the winning attack rides the
        // breakdown so the preview/diagnostics can explain the EV cut.
        if (winner.dodge) {
            winner.breakdown = { ...winner.breakdown, dodge: winner.dodge };
        }
        // Issue #27 explainability: the winner record carries the top-3
        // ranking, the runner-up score delta and the per-factor
        // contribution differences that decided the pick — the trace
        // renders "attack-in-place beats hold by +0.09 (attackNow +0.10,
        // exposure −0.03)" straight from this record. An easy-slip
        // winner may score below its runner-up — the margin stays
        // signed and shows it.
        const runnerUp = pickPool.find(entry => entry !== winner) ?? null;
        recordLayerReason(diagnostics, "L4", "winner", {
            candidate: winner.id ?? null,
            score: winner.score,
            top: pickPool.slice(0, 3).map(entry => ({
                candidate: entry.id ?? null,
                score: Math.round(scoreOf(entry) * 1e6) / 1e6
            })),
            runnerUp: runnerUp
                ? {
                    candidate: runnerUp.id ?? null,
                    score: Math.round(scoreOf(runnerUp) * 1e6) / 1e6
                }
                : null,
            margin: runnerUp
                ? Math.round((scoreOf(winner) - scoreOf(runnerUp)) * 1e6) / 1e6
                : null,
            factors: factorDelta(winner, runnerUp, effectiveWeights)
        });
        diagnostics.chosenStep = null;
        // AimedUntil (issue #15): the booked flag bonus rides into the
        // attack step — the executor clears the flag once the shot lands.
        const steps = _stepsFor({ candidate: winner, carriedAim, halfMoveLimit });
        diagnostics.chosenStep = steps.find(step => step.type !== "end-turn")?.id ?? steps[0].id;

        // Issue #25 L1: when the commitment layer is on, the scored plan
        // carries a serializable `commitment` payload — the same steps
        // plus the `expectedState` fingerprint (self endpoint, committed
        // target, morale tier, threat list). The executor persists it on
        // the combatant `committedPlan` flag after the turn; the next
        // planTurn then short-circuits while the expectation holds.
        // Reactive mode (interventions above the threshold) writes the
        // squeezed ttl=1 — the per-turn baseline during manual chaos.
        // A bare hold (`[end-turn]`) never commits: the expectedState
        // would carry no threats to drift-check, so a replayed hold stays
        // blind to new contacts — a sealed grenadier kept holding for
        // turns after the door opened (smoke finding).
        const commitmentPayload = layerFlags.commitment === true && steps.length
            && steps.some(step => step?.type && step.type !== "end-turn")
            ? {
                source: "planner",
                ttl: commitment.reactive === true
                    ? 1
                    : _finiteOr(context.commitmentTtl, COMMITMENT_TTL_ROUNDS),
                steps: _jsonClone(steps),
                expectedState: {
                    self: _committedSelfPosition(steps, selfPos, tokenDoc, scene),
                    target: winner.target
                        ? {
                            tokenId: winner.target.tokenId ?? null,
                            tokenUuid: winner.target.tokenUuid ?? null,
                            x: _finiteOr(winner.target.x, null),
                            y: _finiteOr(winner.target.y, null)
                        }
                        : null,
                    morale: moraleTierOf(moralePosture),
                    threats: _commitmentThreats(targets, winner.target)
                }
            }
            : null;

        const plan = _assemblePlan({
            combat, combatant, context, authority, seed, presetId,
            diagnostics, steps, winner, targets, personality,
            actions: usableActions, commitment: commitmentPayload
        });
        log(`plan ${plan.id} preset=${presetId} score=${winner.score} steps=${steps.length}`);
        return { status: PLANNER_STATUS.ok, plan, reason: null };
    }

    /**
     * Assemble the serialized plan: finalized snapshot (self, targets,
     * actions, chosen target), stale/revision fingerprints and the frozen
     * plan document shared by the normal scoring path and the stunned
     * short-circuit.
     * @param {object} input
     * @param {object} input.combat Combat document.
     * @param {object} input.combatant Active combatant document.
     * @param {object} input.context Planning context overrides.
     * @param {object|null} input.authority Authority service or null.
     * @param {number} input.seed Deterministic plan seed.
     * @param {string} input.presetId Resolved preset id.
     * @param {object} input.diagnostics Diagnostics record.
     * @param {object[]} input.steps Serialized plan steps.
     * @param {object} input.winner `{score, breakdown, target}` triple.
     * @param {object[]} input.targets Normalized targets for the snapshot.
     * @param {object[]} input.actions Usable actions for the snapshot.
     * @param {object|null} [input.personality] Issue #19 profile
     *   `{traits, character, source}` recorded on the plan.
     * @param {object|null} [input.commitment] Issue #25 persistence
     *   payload `{source, ttl, steps, expectedState}` the executor writes
     *   on the combatant `committedPlan` flag after the turn.
     * @returns {object} Frozen plan.
     */
    function _assemblePlan({ combat, combatant, context, authority, seed,
        presetId, diagnostics, steps, winner, targets, actions, personality = null,
        commitment = null }) {
        const tokenDoc = _tokenDoc(context.token ?? combatant?.token);
        const actor = _actorOf(combatant) ?? _actorOf(tokenDoc);
        const scene = _sceneOf(context, combat);
        const base = buildPlanSnapshot({ combat, combatant, context, authority });
        const snapshot = _jsonClone({
            ...base,
            self: { ...base.self },
            targets: targets.map(target => ({
                tokenId: target.tokenId,
                tokenUuid: target.tokenUuid,
                x: target.x,
                y: target.y,
                elevation: target.elevation,
                distance: target.distance,
                canAttack: target.canAttack,
                statuses: Array.isArray(target.statuses) ? [...target.statuses] : [],
                source: target.source
            })),
            actions: actions.map(action => ({
                id: action.id,
                type: action.type,
                name: action.name,
                itemUuid: action.itemUuid,
                range: _actionRange(action)
            })),
            target: winner.target
                ? {
                    tokenId: winner.target.tokenId,
                    tokenUuid: winner.target.tokenUuid,
                    x: winner.target.x,
                    y: winner.target.y,
                    elevation: winner.target.elevation,
                    statuses: Array.isArray(winner.target.statuses)
                        ? [...winner.target.statuses]
                        : []
                }
                : null,
            seed
        });
        // Rebuild stale/revision fingerprints over the finalized snapshot.
        const staleFingerprint = _staleFingerprint({
            combat,
            combatant,
            token: tokenDoc,
            actor,
            targetToken: snapshot.target ? _findToken(snapshot.target.tokenId, { combat, scene }) : null,
            collision: snapshot.scene.collisionRevision,
            selfStatuses: context.selfStatuses,
            snapshot
        });
        snapshot.staleFingerprint = staleFingerprint;
        snapshot.revision = `s${fnv1a(stableStringify({ ...snapshot, revision: null }))}`;

        const replanCount = _finiteOr(context.replanCount, 0);
        const planId = `plan-${fnv1a(`${snapshot.revision}|${presetId}|${seed}|${replanCount}`)}`;
        // Issue #27: materialize the per-layer trace entries — one
        // serializable `{layer, kind, ...}` entry per reason record —
        // so a serialized plan explains itself offline (preview block,
        // GM whisper, replay fixtures).
        diagnostics.trace = buildLayerTrace(diagnostics);
        return _deepFreeze({
            id: planId,
            operationId: context.operation?.id ?? context.operationId ?? null,
            actorUuid: snapshot.self.actorUuid,
            tokenUuid: snapshot.self.tokenUuid,
            preset: presetId,
            seed,
            replanCount,
            difficulty: _difficultyOf(context),
            // Issue #19: the resolved personality rides on the plan so the
            // GM preview and executor diagnostics can show it.
            personality: personality
                ? {
                    traits: [...personality.traits],
                    character: personality.character ?? null,
                    source: personality.source ?? "generated"
                }
                : null,
            score: winner.score,
            breakdown: winner.breakdown,
            target: snapshot.target,
            snapshot: _deepFreeze(snapshot),
            steps,
            // Issue #25: the L1 persistence payload the executor writes
            // on the `committedPlan` flag — null for commitment hits
            // (the existing record is refreshed, not rewritten) and
            // when the layer is off.
            commitment: commitment ? _jsonClone(commitment) : null,
            diagnostics,
            debug: { seed }
        });
    }

    /**
     * Projected end-of-turn self position for a committed plan
     * (issue #25): the document-space endpoint of the last move step
     * (the serialized `to` is a footprint centre — the token document
     * stores top-left, mirroring the executor's `_docPoint`), or the
     * live position when the plan keeps the bot in place.
     * @param {object[]} steps Serialized plan steps.
     * @param {{x: number|null, y: number|null}} selfPos Live position.
     * @param {object|null} tokenDoc Self token document.
     * @param {object|null} scene Scene for the grid size.
     * @returns {{x: number|null, y: number|null, elevation: number}}
     */
    function _committedSelfPosition(steps, selfPos, tokenDoc, scene) {
        const size = Number.isFinite(scene?.grid?.size) && scene.grid.size > 0
            ? scene.grid.size : 100;
        let last = null;
        for (const step of steps ?? []) {
            const to = step?.input?.to;
            if (step?.type === "move" && Number.isFinite(to?.x) && Number.isFinite(to?.y)) {
                last = to;
            }
        }
        if (!last) {
            return {
                x: selfPos?.x ?? null,
                y: selfPos?.y ?? null,
                elevation: _finiteOr(tokenDoc?.elevation, 0)
            };
        }
        const fw = _finiteOr(tokenDoc?.width, 1) * size;
        const fh = _finiteOr(tokenDoc?.height, 1) * size;
        return {
            x: last.x - (fw / 2),
            y: last.y - (fh / 2),
            elevation: Number.isFinite(last.elevation)
                ? last.elevation : _finiteOr(tokenDoc?.elevation, 0)
        };
    }

    /**
     * Compact threat fingerprint of a committed plan's expectedState
     * (issue #25): `{tokenId, x, y}` of every evaluated target, the
     * committed target deduped in, bounded at
     * {@link COMMITMENT_THREAT_MAX}. Validation re-resolves the same ids
     * and counts drifts beyond one grid cell.
     * @param {object[]} targets Normalized snapshot targets.
     * @param {object|null} winnerTarget Chosen target.
     * @returns {object[]}
     */
    function _commitmentThreats(targets, winnerTarget) {
        const seen = new Set();
        const list = [];
        const push = entry => {
            const id = entry?.tokenId ?? entry?.tokenUuid ?? null;
            if (!id || seen.has(id)) return;
            if (!Number.isFinite(entry.x) || !Number.isFinite(entry.y)) return;
            seen.add(id);
            list.push({ tokenId: id, x: entry.x, y: entry.y });
        };
        push(winnerTarget);
        for (const target of targets ?? []) {
            if (list.length >= COMMITMENT_THREAT_MAX) break;
            push(target);
        }
        return list;
    }

    /**
     * Stable candidate id for diagnostics.
     * @param {object} candidate
     * @param {number} index
     * @returns {string}
     */
    function _candidateId(candidate, index) {
        const targetKey = candidate.target?.tokenId ?? candidate.target?.tokenUuid ?? "none";
        const moveKey = candidate.move?.key ?? "stay";
        const actionKey = candidate.action?.id ?? "none";
        return `${candidate.variant}|${targetKey}|${moveKey}|${actionKey}|${index}`;
    }

    /**
     * Validate a plan's snapshot against live state. Called by the
     * executor immediately before every state-changing step. The cheap
     * stale fingerprint is compared first вЂ” an equal fingerprint returns
     * `valid` without running any detailed checks.
     * @param {object} plan Serialized plan with `snapshot`.
     * @param {object} [currentContext] Live overrides: `combat`,
     *   `combatant`, `token`, `target`, `scene`, `collisionRevision`.
     * @returns {{valid: boolean, reason: string|null}}
     */
    function validateSnapshot(plan, currentContext = {}) {
        const snapshot = plan?.snapshot;
        if (!snapshot || typeof snapshot !== "object") {
            return { valid: false, reason: STALE_REASONS.invalidPlan };
        }
        const combat = currentContext.combat ?? _findCombat(snapshot.combatId);
        if (!combat || combat.id !== snapshot.combatId
            || combat.ended === true || combat.destroyed === true) {
            return { valid: false, reason: STALE_REASONS.combatEnded };
        }
        const combatant = currentContext.combatant !== undefined
            ? currentContext.combatant
            : _findCombatant(combat, snapshot.combatantId);
        const tokenDoc = currentContext.token !== undefined
            ? currentContext.token
            : _tokenDoc(combatant?.token);
        const actor = _actorOf(combatant) ?? _actorOf(tokenDoc);
        const scene = _sceneOf(currentContext, combat);
        const collision = currentContext.collisionRevision !== undefined
            ? currentContext.collisionRevision
            : _collisionRevision(scene);
        const targetToken = "target" in currentContext
            ? currentContext.target
            : (snapshot.target ? _findToken(snapshot.target.tokenId, { combat, scene }) : null);

        // Fast path: the fingerprint covers every field the checks below
        // inspect, so an equal fingerprint means the plan is still valid.
        const live = _staleFingerprint({
            combat, combatant, token: tokenDoc, actor, targetToken, collision,
            selfStatuses: currentContext.selfStatuses, snapshot
        });
        if (live === snapshot.staleFingerprint) {
            return { valid: true, reason: null };
        }

        // Turn index stays null until the first advance; snapshots
        // normalize both fields to 0, so the comparison must too.
        if (_finiteOr(combat.round, 0) !== _finiteOr(snapshot.round, 0)
            || _finiteOr(combat.turn, 0) !== _finiteOr(snapshot.turn, 0)) {
            return { valid: false, reason: STALE_REASONS.turnStale };
        }
        const position = _tokenPosition(tokenDoc);
        const self = snapshot.self ?? {};
        if (!tokenDoc || tokenDoc.destroyed === true
            || combatant?.destroyed === true
            || tokenDoc.id !== self.tokenId
            || position.x !== self.x || position.y !== self.y
            || _finiteOr(tokenDoc.elevation, 0) !== _finiteOr(self.elevation, 0)
            || (tokenDoc.hidden === true) !== (self.hidden === true)
            || (combatant?.defeated === true) !== (self.defeated === true)) {
            return { valid: false, reason: STALE_REASONS.tokenMoved };
        }
        if (snapshot.target) {
            const targetCombatant = _findCombatantByToken(combat, snapshot.target.tokenId);
            // Perception stores token centres, injected targets may carry
            // top-left positions вЂ” accept either coordinate basis so a
            // standing target does not look "moved".
            const targetPos = _tokenPosition(targetToken);
            const targetDoc = _tokenDoc(targetToken);
            const gridSize = snapshot.scene?.grid?.size ?? scene?.grid?.size ?? 100;
            const halfW = (_finiteOr(targetDoc?.width, 1) * gridSize) / 2;
            const halfH = (_finiteOr(targetDoc?.height, 1) * gridSize) / 2;
            const unmoved = [
                { x: targetPos.x, y: targetPos.y },
                { x: targetPos.x + halfW, y: targetPos.y + halfH }
            ].some(point => point.x === snapshot.target.x
                && point.y === snapshot.target.y);
            if (!_targetAlive(targetToken, targetCombatant) || !unmoved) {
                return { valid: false, reason: STALE_REASONS.targetGone };
            }
        }
        if (_resourcesFingerprint(actor) !== self.resourcesHash) {
            return { valid: false, reason: STALE_REASONS.resourcesChanged };
        }
        // Self statuses (pinned/prone/stunned/…) gate which candidates are
        // legal, so any drift invalidates the plan with its own reason.
        const liveStatuses = _selfStatuses(actor, tokenDoc, currentContext.selfStatuses);
        const plannedStatuses = Array.isArray(self.statuses) ? self.statuses : [];
        if (liveStatuses.join("|") !== plannedStatuses.join("|")) {
            return { valid: false, reason: STALE_REASONS.statusesChanged };
        }
        if ((collision ?? null) !== (snapshot.scene?.collisionRevision ?? null)) {
            return { valid: false, reason: STALE_REASONS.collisionChanged };
        }
        // Fingerprint covered a field no check owns вЂ” defensive fallback.
        return { valid: false, reason: STALE_REASONS.stale };
    }

    /**
     * Combat lookup for validation: injected first, then the world.
     * @param {string|null} combatId
     * @returns {object|null}
     */
    function _findCombat(combatId) {
        const collection = globalThis.game?.combats;
        if (collection && combatId) {
            if (typeof collection.get === "function") {
                const hit = collection.get(combatId);
                if (hit) return hit;
            }
            for (const entry of _list(collection)) {
                if (entry?.id === combatId) return entry;
            }
        }
        const active = globalThis.game?.combat;
        return active?.id === combatId ? active : null;
    }

    /**
     * Replan policy hook consulted by the executor after a failed or stale
     * step. At most `maxReplans` replans are granted per turn; afterwards
     * the AI holds and reports a diagnostic reason for the GM.
     * @param {object|string} failure `{reason, plan?, replanCount?,
     *   maxReplans?}` or a bare reason string.
     * @returns {object} `{replan, action, reason, originalReason,
     *   replanCount, report}` вЂ” `action` is `"replan"` or
     *   `"hold-and-report"`.
     */
    function shouldReplan(failure = {}) {
        const input = typeof failure === "string" ? { reason: failure } : (failure ?? {});
        const reason = input.reason ?? null;
        const plan = input.plan ?? null;
        const used = Number.isFinite(input.replanCount)
            ? input.replanCount
            : _finiteOr(plan?.replanCount, 0);
        const limit = Number.isFinite(input.maxReplans) ? input.maxReplans : maxReplans;
        const replannable = REPLAN_REASONS.has(reason);
        const report = {
            planId: plan?.id ?? null,
            reason,
            replanCount: used,
            maxReplans: limit
        };
        if (replannable && used < limit) {
            return _deepFreeze({
                replan: true,
                action: REPLAN_ACTIONS.replan,
                reason,
                originalReason: reason,
                replanCount: used + 1,
                report
            });
        }
        const holdReason = replannable
            ? "replan-limit-exceeded"
            : (reason ?? "unknown-failure");
        return _deepFreeze({
            replan: false,
            action: REPLAN_ACTIONS.holdAndReport,
            reason: holdReason,
            originalReason: reason,
            replanCount: used,
            report
        });
    }

    /**
     * Register or replace a preset definition. `weights` merge over the
     * defaults; `evaluate(context)` may return a score number or
     * `{score, breakdown}`; `veto({factors, candidate, context})` may
     * return a reason string to exclude a candidate from ranking.
     * @param {string} id Preset id.
     * @param {object} def `{weights?, evaluate?, veto?, allowNoTarget?, allowNoAction?}`.
     * @returns {object} The stored preset.
     */
    function registerPreset(id, def = {}) {
        if (typeof id !== "string" || id.trim() === "") {
            throw new Error("[only-war-ai] Preset id must be a non-empty string");
        }
        if (!def || typeof def !== "object") {
            throw new Error(`[only-war-ai] Preset "${id}" requires a definition object`);
        }
        const stored = {
            id,
            weights: { ...DEFAULT_PRESET_WEIGHTS, ...(def.weights ?? {}) },
            evaluate: typeof def.evaluate === "function" ? def.evaluate : null,
            veto: typeof def.veto === "function" ? def.veto : null,
            allowNoTarget: def.allowNoTarget === true,
            allowNoAction: def.allowNoAction === true,
            alwaysOfferHold: def.alwaysOfferHold === true
        };
        presets.set(id, stored);
        return stored;
    }

    /**
     * Look up a registered preset definition.
     * @param {string} id
     * @returns {object|null}
     */
    function getPreset(id) {
        return presets.get(id) ?? null;
    }

    /**
     * Registered preset ids in registration order.
     * @returns {string[]}
     */
    function listPresets() {
        return [...presets.keys()];
    }

    return {
        planTurn,
        validateSnapshot,
        shouldReplan,
        registerPreset,
        getPreset,
        listPresets,
        buildPlanSnapshot,
        statuses: PLANNER_STATUS,
        staleReasons: STALE_REASONS,
        stepTypes: STEP_TYPES,
        get maxReplans() {
            return maxReplans;
        }
    };
}

// Public surface — re-exported from the extracted planner/* modules so
// existing importers (presets, fireteam, executor, tests) keep working.
export {
    ACTION_BUDGET_HALVES,
    CHARGE_SWITCH_MARGIN,
    DEFAULT_DODGE_TN,
    DEFAULT_LOOKAHEAD_LAMBDA,
    DEFAULT_LOOKAHEAD_TOP_K,
    DEFAULT_MAX_ACTIONS,
    DEFAULT_MAX_REPLANS,
    DEFAULT_MAX_TARGETS,
    DEFAULT_MELEE_RANGE,
    DEFAULT_MOVE_CANDIDATES,
    DEFAULT_PRESET_WEIGHTS,
    EASY_MISTAKE_CHANCE,
    EASY_PICK_TOP_K,
    PLANNER_STATUS,
    PRESET_SKELETONS,
    REPLAN_ACTIONS,
    REPLAN_REASONS,
    SCORE_FACTORS,
    STALE_REASONS,
    STEP_TYPES,
    buildPlanSnapshot,
    dodgeChanceOf,
    evaluateFactors,
    fnv1a,
    mulberry32,
    stableStringify
};
