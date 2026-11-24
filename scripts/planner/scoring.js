/**
 * Planner decomposition (issue #403 follow-up): this module was extracted
 * verbatim from scripts/planner.js — see that file for the design contract.
 * The planner service re-exports the public surface so existing importers
 * and tests keep working.
 */
import {
    AI_DIFFICULTIES
} from "../constants.js";
import {
    personalityBehaviorFlags,
    personalityWeaponAffinity
} from "../personalities.js";
import {
    getAIDifficulty
} from "../settings.js";
import {
    buildThreatMap,
    expectedCounterDamage,
    threatSourcesOf
} from "../threat-map.js";
import {
    _actionBlastRadius,
    _actionRange,
    _isMeleeAction,
    _weaponMatches,
    dodgeChanceOf
} from "./actions.js";
import {
    ATTACK_TYPE_DESIRE,
    ATTACK_TYPE_DESIRE_DEFAULT,
    DEFAULT_LOOKAHEAD_LAMBDA,
    DEFAULT_LOOKAHEAD_TOP_K,
    DEFAULT_MELEE_RANGE,
    VULNERABLE_STATUSES
} from "./contract.js";
import {
    _findToken
} from "./documents.js";
import {
    _isMemorySource
} from "./targets.js";
import {
    _distPx,
    _finiteOr,
    mulberry32
} from "./util.js";
import {
    _coneSpecOf
} from "./zones.js";


/**
 * Factor vector of a candidate variant вЂ” the shared, data-driven scoring
 * input presets weight.
 * @param {object} input Factor input.
 * @param {string} input.variant Candidate variant kind.
 * @param {object|null} input.target Normalized target entry.
 * @param {object|null} input.move Normalized move candidate.
 * @param {object|null} input.action Normalized action candidate.
 * @param {number|null} [input.moveBudget] Numeric movement budget for the
 *   `budgetOver` penalty factor (null/unknown disables it).
 * @param {Function|null} [input.dangerAt] Threat-map probe
 *   `(point) => 0..1` evaluated on the candidate endpoint (issue #16).
 * @param {object|null} [input.selfPos] Self position `{x, y}` in pixels —
 *   the endpoint of stationary variants.
 * @param {number} [input.blastHits] Hostiles covered by a blast aim point.
 * @param {object|null} [input.dodge] `{dodgeable, chance}` of the
 *   (target, action) pair (issue #37); recomputed when absent.
 * @param {object|string|null} [input.preferredWeapon] Resolved
 *   `preferredWeapon` config value (issue #37).
 * @param {object|string|null} [input.lastUsedWeapon] `lastUsedWeapon`
 *   flag/context value feeding the `weaponInertia` factor (issue #37).
 * @param {string[]} [input.traits] Resolved personality trait ids —
 *   their `weaponAffinity` specs feed the `weaponAffinity` factor.
 * @param {number|null} [input.dodgeTN] Default dodge TN override.
 * @param {Set<string>|null} [input.allyEngagedTargets] Hostile token
 *   uuids currently engaged in melee with an ally (issue #39) — feeds
 *   the `alliedEngagement` factor on point-target attacks.
 * @param {object[]} [input.enemies] Enemy contacts `{x, y, reachPx}` —
 *   feeds the `leaveMeleeEngage`/`engageDenial` free-attack factors.
 * @param {object|null} [input.lastAttacker] Active `lastAttacker` flag
 *   record (`{tokenUuid, actorId, ...}`) — feeds the `grudge` factor.
 * @param {object|null} [input.lastTarget] `lastTarget` flag/context
 *   record (`{tokenUuid, tokenId, actorId, round}`) — feeds the
 *   `stickyTarget` factor while fresh.
 * @param {object|null} [input.orderBoost] `{character, pressured}` — the
 *   `order` factor grows +0.5 in `disciplined`/`elite` teams and +0.5
 *   under morale pressure (issue #38, graceful #26 hook).
 * @param {Map<string,object>|null} [input.shooterProfiles] tokenUuid →
 *   `{threat, distance}` of visible enemies — feeds the `counterThreat`
 *   factor weighting safer firing angles.
 * @returns {object}
 */
export function _factorsOf({ variant, target, move, action, moveBudget = null, blastHits = 0,
    dangerAt = null, selfPos = null, dodge = null, preferredWeapon = null,
    lastUsedWeapon = null, traits = [], dodgeTN = null,
    allyEngagedTargets = null, enemies = null, lastAttacker = null,
    orderBoost = null, lastTarget = null, shooterProfiles = null }) {
    const targetDistance = _finiteOr(target?.distance, null);
    const postDistance = _finiteOr(move?.distance, targetDistance);
    const canAttack = target?.canAttack === true;
    const attackNow = (variant === "attack-in-place" || variant === "aim-attack")
        && canAttack ? 1 : 0;
    const attackAfterMove = (variant === "move-attack" || variant === "charge") && canAttack ? 1 : 0;
    let advance = 0;
    if (move && !move.stay && Number.isFinite(targetDistance) && targetDistance > 0
        && Number.isFinite(postDistance)) {
        advance = Math.max(0, Math.min(1, (targetDistance - postDistance) / targetDistance));
    }
    const proximity = Number.isFinite(postDistance)
        ? 1 / (1 + (postDistance / 10))
        : 0;
    const los = target?.source === "visible" || move?.los === true ? 1 : 0;
    const cover = Math.max(0, Math.min(1, _finiteOr(move?.cover, 0)));
    const stationary = variant === "hold" || variant === "attack-in-place"
        || variant === "aim-attack" || variant === "aim"
        || variant === "reload" || variant === "overwatch"
        || variant === "ready-weapon" || variant === "drop-prone"
        || variant === "unpin" || variant === "order";
    const holdPosition = stationary || move?.stay === true ? 1 : 0;
    const budget = Number.isFinite(moveBudget) && moveBudget > 0 ? moveBudget : null;
    const budgetOver = budget !== null && move
        ? Math.max(0, (_finiteOr(move.cost, 0) - budget) / budget)
        : 0;
    const melee = _isMeleeAction(action) ? 1 : 0;
    // Melee reach of the evaluated endpoint: the melee action's own
    // range when the candidate carries one, the default reach otherwise
    // — a ranged candidate still counts as engaged in close contact.
    const meleeReach = melee ? _actionRange(action) : DEFAULT_MELEE_RANGE;
    const engaged = Number.isFinite(postDistance) && postDistance <= meleeReach + 1e-9 ? 1 : 0;
    // Issue #37: an enemy that already spent its reaction is defenceless
    // against the next shot — scored through the same `vulnerable` door
    // as pinned/prone/stunned targets.
    const vulnerable = target?.reactionUsed === true
        || (target?.statuses ?? []).some(status => VULNERABLE_STATUSES.has(status)) ? 1 : 0;
    // Issue #37 counter-EV: `EV = hitsEV × (1 − P(dodge))` folded into
    // the attack-type desire — dodgeable attacks lose expected value
    // against evasive targets; undodgeable ones (spray/cone, unescapable
    // blast, reaction-spent targets) keep the full desire.
    const dodgeInfo = dodge ?? dodgeChanceOf(target, action, dodgeTN);
    const attackDesire = action
        ? (ATTACK_TYPE_DESIRE[action.attackType] ?? ATTACK_TYPE_DESIRE_DEFAULT)
        : 0;
    // Weapon affinity and inertia (issue #37): the GM-marked signature
    // weapon wins outright; a matching personality `weaponAffinity` spec
    // (sniper → long-las, grenadier → blast) contributes half strength;
    // the weapon used on the previous turn gets a small hysteresis.
    let weaponAffinity = 0;
    if (action && preferredWeapon && _weaponMatches(action, preferredWeapon)) {
        weaponAffinity = 1;
    } else if (action && personalityWeaponAffinity(traits, action)) {
        weaponAffinity = 0.5;
    }
    // Issue #16 threat map: aggregated danger of the candidate endpoint —
    // the move destination, the stay cell or the actor position for
    // stationary variants. It complements `cover`/`exposure`: those only
    // measure walls against the *planned* target, `danger` sums every
    // known enemy's effective weapon range over the cell — a spot safe
    // from the current target may still be a kill lane for a second
    // shooter.
    const endpoint = move && Number.isFinite(move.x) && Number.isFinite(move.y)
        ? { x: move.x, y: move.y }
        : (Number.isFinite(selfPos?.x) && Number.isFinite(selfPos?.y) ? selfPos : null);
    let danger = 0;
    if (endpoint && typeof dangerAt === "function") {
        try {
            danger = Math.max(0, Math.min(1, _finiteOr(dangerAt(endpoint), 0)));
        } catch(err) {
            danger = 0;
        }
    }
    // Issue #39: firing at a target standing in melee with an ally draws
    // the −20 shooting-into-melee penalty — only point-target attacks
    // suffer it. Melee actions and blast/cone templates are exempt: the
    // template candidates already veto any aim point covering an ally.
    // Issue #39 review: the `heretic` trait fires into an ally's melee
    // without compunction — the factor never engages for it.
    const firesIntoMelee = personalityBehaviorFlags(traits).firesIntoMelee === true;
    const alliedEngaged = !firesIntoMelee
        && allyEngagedTargets != null && typeof allyEngagedTargets.has === "function"
        && target?.tokenUuid != null
        && allyEngagedTargets.has(target.tokenUuid)
        && action && melee !== 1
        && _actionBlastRadius(action) <= 0
        && !_coneSpecOf(action) ? 1 : 0;
    // Issue #39 free-attack awareness (DH2e Disengage): leaving an
    // enemy's melee reach without a Disengage action provokes a free
    // swing — compared per enemy, so walking out of A's reach into B's
    // still counts. `engageDenial` marks the inverse transition: ending
    // inside an enemy's reach while starting outside all of them.
    let engagedAtStart = false;
    let engagedAtEnd = false;
    let leaveMeleeEngage = 0;
    for (const enemy of enemies ?? []) {
        if (!enemy || !Number.isFinite(enemy.reachPx)) continue;
        const startIn = _distPx(selfPos, enemy) <= enemy.reachPx + 1e-9;
        const endIn = _distPx(endpoint, enemy) <= enemy.reachPx + 1e-9;
        if (startIn && !endIn) leaveMeleeEngage = 1;
        engagedAtStart = engagedAtStart || startIn;
        engagedAtEnd = engagedAtEnd || endIn;
    }
    const engageDenial = !engagedAtStart && engagedAtEnd ? 1 : 0;
    // Issue #39 review: `grudge` marks candidates whose target is the
    // recorded last attacker — scaled by the wounds actually lost so a
    // scratch barely registers while a near-kill pulls hard (default 5
    // when the record carries no wound count).
    const grudge = lastAttacker && target
        && ((lastAttacker.tokenUuid != null
                && target.tokenUuid === lastAttacker.tokenUuid)
            || (lastAttacker.tokenId != null
                && target.tokenId === lastAttacker.tokenId)
            || (lastAttacker.actorId != null
                && target.actorId === lastAttacker.actorId))
        ? Math.min(Math.max(_finiteOr(lastAttacker.woundsLost, 5), 0) / 10, 1)
        : 0;
    // Smoke finding: target inertia — a bot keeps pressing the target it
    // already engaged/attacked instead of switching between near-equal
    // options every round. Applies to any attack variant on that target,
    // so a charge on the *same* target still earns it.
    const stickyTarget = lastTarget && target
        && ((lastTarget.tokenUuid != null
                && target.tokenUuid === lastTarget.tokenUuid)
            || (lastTarget.tokenId != null
                && target.tokenId === lastTarget.tokenId)
            || (lastTarget.actorId != null
                && target.actorId === lastTarget.actorId))
        ? 1 : 0;
    // Ganging up (OW numerical superiority in melee): melee candidates
    // against a target already engaged by allies earn up to the full
    // factor at two-plus allies — only melee enjoys the rule bonus.
    const allyCount = melee === 1 && target?.tokenUuid != null
        && allyEngagedTargets != null && typeof allyEngagedTargets.get === "function"
        ? (allyEngagedTargets.get(target.tokenUuid) ?? 0) : 0;
    const outnumber = Math.min(allyCount, 2) / 2;
    // Spec-ops doctrine (smoke): a melee candidate against a KNOWN pure
    // shooter binds its gun — the enemy cannot fire while engaged. The
    // value scales with the target's ranged output so tying up a heavy
    // gunner outranks grabbing a pistol-wielder; enemies without a
    // resolved emitter profile stay neutral (0).
    const shooter = melee === 1 && target?.tokenUuid != null
        ? shooterProfiles?.get(target.tokenUuid) ?? null : null;
    const tieUp = shooter && shooter.melee !== true && shooter.rangedDamage > 0
        ? Math.min(shooter.rangedDamage / 15, 1) : 0;
    return {
        attackNow,
        attackAfterMove,
        charge: variant === "charge" ? 1 : 0,
        melee,
        advance,
        threat: Math.max(0, Math.min(1, _finiteOr(target?.threat, 0))),
        proximity,
        los,
        cover,
        exposure: move && move.stay !== true ? Math.max(0, 1 - cover) : 0,
        holdPosition,
        // Comms-net hearsay weighs half of a direct memory: the squad
        // still advances on it, but a fresher own sighting always wins.
        lastKnown: _isMemorySource(target?.source)
            ? (target?.source === "relay" || target?.source === "intel" ? 0.5 : 1) : 0,
        budgetOver,
        attackType: attackDesire,
        // Issue #37 counter-EV (review): the dodge discount scaled by
        // expected weapon damage — `ev = damageNorm × attackDesire ×
        // (1 − P(dodge))`. Undodgeable attacks (spray, unescapable
        // blast, reaction-spent target) keep `chance` 0 → full value.
        ev: action?.type === "attack"
            ? Math.round(
                Math.max(0, Math.min(1, _finiteOr(action.damage, 0) / 20))
                * attackDesire
                * (1 - dodgeInfo.chance) * 1e6) / 1e6
            : 0,
        vulnerable,
        engaged,
        meleeEngage: melee * engaged,
        // Blast coverage: 1+ hostiles under the template; a presumed
        // last-known strike counts 0.5 of a confirmed two-target hit.
        area: Math.min(_finiteOr(blastHits, 0) / 2, 1),
        // Action-economy markers (issue #15): an aimed attack spends the
        // whole budget for a +10/+20 bonus; reload/overwatch are the
        // utility turns of a dry clip or a held position.
        // `aim` marks the aimed shot; `aimAlone` the standalone full-aim
        // turn — presets weight it low so aiming never beats a legal shot.
        aim: variant === "aim-attack" ? 1 : 0,
        aimAlone: variant === "aim" ? 1 : 0,
        reload: (variant === "reload" || variant === "move-reload") ? 1 : 0,
        overwatch: variant === "overwatch" ? 1 : 0,
        danger,
        weaponAffinity,
        weaponInertia: action && _weaponMatches(action, lastUsedWeapon) ? 1 : 0,
        dropProne: variant === "drop-prone" ? 1 : 0,
        readyWeapon: variant === "ready-weapon" ? 1 : 0,
        alliedEngagement: alliedEngaged,
        leaveMeleeEngage,
        engageDenial,
        unpin: variant === "unpin" ? 1 : 0,
        grudge,
        // Issue #38 leader order: a plain order is the moderate utility
        // turn (1); disciplined/elite teams obey better (+0.5) and an
        // order matters more while the squad is under pressure (+0.5,
        // graceful #26 morale hook — absent flags read as calm).
        order: variant === "order"
            ? 1 + (orderBoost?.character === true ? 0.5 : 0)
                + (orderBoost?.pressured === true ? 0.5 : 0)
            : 0,
        stickyTarget,
        outnumber,
        tieUp,
        // Seek mechanic (smoke request): the cautious wall-hugging
        // advance — only seek-variant candidates (hidden endpoints on a
        // non-visible contact) light the factor; the doctrine weight
        // decides whether hiding outranks a faster open approach.
        seek: variant === "seek" ? 1 : 0,
        // Run mechanic (smoke request): a full-action sprint beyond the
        // full-move rate — the doctrine weight prices burning the whole
        // turn on ground gain.
        run: variant === "run" ? 1 : 0
    };
}


/**
 * Default utility evaluation: `ОЈ weight_i Г— factor_i` with an explainable
 * per-factor breakdown.
 * @param {object} factors
 * @param {object} weights
 * @returns {{score: number, breakdown: object}}
 */
export function evaluateFactors(factors, weights) {
    const contributions = {};
    let total = 0;
    for (const [key, weight] of Object.entries(weights ?? {})) {
        if (!Number.isFinite(weight) || weight === 0) continue;
        const contribution = (_finiteOr(factors?.[key], 0)) * weight;
        // `+ 0` normalizes -0 so plans stay JSON-round-trip stable.
        contributions[key] = (Math.round(contribution * 1e4) / 1e4) + 0;
        total += contribution;
    }
    return {
        score: (Math.round(total * 1e6) / 1e6) + 0,
        breakdown: { factors: { ...factors }, contributions, weights: { ...weights } }
    };
}


/**
 * Seeded FisherвЂ“Yates pick inside the equal-score tie group. The same
 * seed always selects the same candidate; different seeds may differ.
 * @param {object[]} tied Candidates sharing the top score (pre-sorted).
 * @param {number} seed
 * @returns {object}
 */
export function _seededPick(tied, seed) {
    const shuffled = [...tied];
    const next = mulberry32(seed);
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled[0];
}


/**
 * Resolved AI difficulty for one plan: validated `context.difficulty`
 * wins, otherwise the `aiDifficulty` world setting (issue #16).
 * @param {object} context Planning context.
 * @returns {string} One of `easy|normal|hard`.
 */
export function _difficultyOf(context) {
    return AI_DIFFICULTIES.includes(context?.difficulty)
        ? context.difficulty
        : getAIDifficulty();
}


/**
 * Threat sources for the plan's danger field and counter model:
 * injected `context.threats` win; otherwise the resolved targets provide
 * positions while `threatSourcesOf` derives weapon emitters from
 * explicit target profiles or the enemy token's actor loadout.
 * @param {object} input
 * @param {object[]} input.targets Normalized targets.
 * @param {object} input.combat Combat document.
 * @param {object|null} input.scene Scene for token lookup.
 * @param {object} input.context Planning context.
 * @returns {object[]} Raw/normalized threat sources.
 */
export function _enemyThreats({ targets, combat, scene, context }) {
    if (Array.isArray(context?.threats)) return context.threats;
    return threatSourcesOf(targets, {
        combat,
        scene,
        findToken: tokenId => _findToken(tokenId, { combat, scene })
    });
}


/**
 * Per-target shooter profile derived from the resolved threat emitters
 * (smoke finding — spec-ops doctrine): `{melee, rangedDamage}` — whether
 * the enemy fields a melee weapon and the EV of its strongest ranged
 * emitter. Feeds the `tieUp` factor: a melee candidate against a known
 * pure shooter binds its gun. Pure snapshot data, like `_enemyContacts`.
 * @param {object[]} threats Resolved threat sources with `emitters`.
 * @returns {Map<string, {melee: boolean, rangedDamage: number}>}
 */
export function _shooterProfiles(threats) {
    const map = new Map();
    for (const source of threats ?? []) {
        const key = source?.tokenUuid ?? source?.id ?? null;
        if (key == null) continue;
        const entry = map.get(key) ?? { melee: false, rangedDamage: 0 };
        for (const emitter of source?.emitters ?? []) {
            if (emitter?.melee === true) entry.melee = true;
            else entry.rangedDamage = Math.max(entry.rangedDamage,
                _finiteOr(emitter?.ev ?? emitter?.damage, 0));
        }
        map.set(key, entry);
    }
    return map;
}


/**
 * Resolve the threat map for one plan. `context.threatMap` may be a
 * ready map (`dangerAt`), a threat-map service (`refresh` builds and
 * returns it) or `false` to disable the factor; absent an injection the
 * map is built locally from the resolved threat sources — but only on
 * `normal`/`hard`: easy bots deliberately do not read the danger field.
 * @param {object} input
 * @param {string} input.difficulty Resolved AI difficulty.
 * @param {object[]} input.threats Threat sources.
 * @param {object} input.grid Normalized grid info.
 * @param {Function|boolean|undefined} input.los Sight probe override.
 * @param {object|null} input.service Registered `threatMap` service.
 * @param {object} input.context Planning context.
 * @returns {object|null} Map exposing `dangerAt(point)` or null.
 */
export function _resolveThreatMap({ difficulty, threats, grid, los, service, context }) {
    const injected = context?.threatMap;
    if (injected === false) return null;
    if (injected && typeof injected === "object") {
        if (typeof injected.refresh === "function") {
            try {
                const map = injected.refresh({ threats, grid, los, context });
                if (map && typeof map.dangerAt === "function") return map;
            } catch(err) {
                // Fall back to the local build below.
            }
        }
        if (typeof injected.dangerAt === "function") return injected;
    }
    // Easy bots skip the derived danger field; an explicit source list
    // still applies because caller-injected context always wins.
    if (difficulty === "easy" && !Array.isArray(context?.threats)) return null;
    if (!threats.length) return null;
    if (service && typeof service.refresh === "function") {
        try {
            const map = service.refresh({ threats, grid, los, context });
            if (map && typeof map.dangerAt === "function") return map;
        } catch(err) {
            // Fall back to the local build below.
        }
    }
    try {
        return buildThreatMap({ threats, los, grid });
    } catch(err) {
        return null;
    }
}


/**
 * Whether the 2-ply lookahead pass runs for this plan: `hard`
 * difficulty enables it by default, `context.lookahead` force-enables
 * or force-disables it; `context.lookaheadLambda`/`lookaheadTopK` tune
 * the penalty weight and the top-K bound.
 * @param {object} context Planning context.
 * @param {string} difficulty Resolved AI difficulty.
 * @returns {{enabled: boolean, lambda: number, topK: number}}
 */
export function _lookaheadConfig(context, difficulty) {
    const enabled = context?.lookahead === true
        || (context?.lookahead !== false && difficulty === "hard");
    if (!enabled) return { enabled: false, lambda: 0, topK: 0 };
    const lambda = Number.isFinite(context?.lookaheadLambda)
        ? context.lookaheadLambda : DEFAULT_LOOKAHEAD_LAMBDA;
    const topK = Math.max(1, Math.min(8,
        Math.floor(_finiteOr(context?.lookaheadTopK, DEFAULT_LOOKAHEAD_TOP_K))));
    return { enabled: true, lambda, topK };
}


/**
 * Lookahead pass over the top-K scored candidates: each candidate's
 * endpoint is charged the expected counter damage of the strongest
 * enemy emitter able to respond (`adjusted = score − λ × EV`). The
 * returned pool is re-sorted by adjusted score with candidate-id
 * tie-breaks — deterministic for identical input.
 * @param {object[]} scored Scored candidates (score-sorted).
 * @param {object} input
 * @param {object[]} input.threats Threat sources of the plan.
 * @param {object} input.grid Normalized grid info.
 * @param {Function|boolean|undefined} input.los Sight probe override.
 * @param {number} input.lambda Penalty weight.
 * @param {number} input.topK Candidates re-scored.
 * @param {object} input.selfPos Self position `{x, y}` in pixels.
 * @returns {object[]} The adjusted top-K pool (sorted).
 */
export function _applyLookahead(scored, { threats, grid, los, lambda, topK, selfPos }) {
    const pool = scored.slice(0, Math.max(1, topK));
    for (const entry of pool) {
        const endpoint = entry.move && Number.isFinite(entry.move.x)
            && Number.isFinite(entry.move.y)
            ? { x: entry.move.x, y: entry.move.y }
            : selfPos;
        const counter = expectedCounterDamage(endpoint, threats, { grid, los });
        const adjusted = Math.round((entry.score - (lambda * counter)) * 1e6) / 1e6;
        entry.lookahead = { counterDamage: counter, adjusted };
    }
    pool.sort((a, b) => (b.lookahead.adjusted - a.lookahead.adjusted)
        || String(a.id).localeCompare(String(b.id)));
    return pool;
}
