import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as h from '../lib.mjs';

/**
 * Drives the staged "Smoke Combat" through AI turns in preview mode.
 *
 * For every AI combatant the script waits for the preview session, dumps
 * the plan (winner, steps, score, diagnostics, trace) to a JSONL log,
 * optionally takes a screenshot, and resolves the preview according to a
 * per-combatant action map. Non-AI combatants get a simple scripted turn
 * (shot at the nearest visible hostile) unless `PAUSE_ON` names them вЂ”
 * matching combatants get a human wait window. The driver survives page
 * reloads: every evaluate is retried until `game` is usable again.
 *
 * Env:
 *   ACTIONS    - JSON array of {match, do, note?} rules; first match wins.
 *                do: confirm|cancel|replan|pause|capture
 *   MAX_TURNS  - cap on processed combatants (default 400)
 *   RUN_ROUNDS - stop after this combat round (default 0 = no limit)
 *   END        - "1" to endCombat() when RUN_ROUNDS is reached
 *   LOG        - JSONL output path (default ./smoke-drive.jsonl)
 *   SHOTS      - "1" to screenshot every preview
 *   SKIP       - "0" to disable scripted turns for non-AI combatants
 *   PAUSE_ON   - substring of the combatant name given a human window
 *                (default "" вЂ” all players scripted)
 *   PLAYER_WAIT_MS - human window length (default 30000)
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = process.env.LOG || path.join(__dirname, 'smoke-drive.jsonl');
const MAX_TURNS = Number(process.env.MAX_TURNS || 400);
const RUN_ROUNDS = Number(process.env.RUN_ROUNDS || 0);
const END_COMBAT = process.env.END === '1';
const ACTIONS = JSON.parse(process.env.ACTIONS || '[]');
const SHOTS = process.env.SHOTS === '1';
const SKIP_PLAYERS = process.env.SKIP !== '0';
const PAUSE_ON = process.env.PAUSE_ON ?? '';

const log = (rec) => {
    fs.appendFileSync(LOG_PATH, JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n');
    console.log(JSON.stringify(rec));
};

const browser = await chromium.connectOverCDP(h.CDP_URL);
const page = await h.getGmPage(browser);
page.on('pageerror', (err) => log({ type: 'pageerror', text: String(err) }));
page.on('console', (msg) => {
    if (msg.type() === 'error') log({ type: 'console-error', text: msg.text().slice(0, 500) });
});

/**
 * Evaluate resilient to reloads: `game` is undefined while the page
 * bootstraps вЂ” retry for ~90 s instead of crashing. Other errors rethrow.
 */
async function ev(fn, arg) {
    for (let attempt = 0; attempt < 60; attempt++) {
        try {
            return await page.evaluate(fn, arg);
        } catch (err) {
            const text = String(err);
            const transient = /Execution context|navigat|Cannot read propert|destroyed|Target closed|game is not defined|Cannot read|Protocol error|Session|Connection|IPC|detached|no frame/i.test(text);
            if (!transient) throw err;
            if (attempt === 0) log({ type: 'eval-transient', text: text.slice(0, 300) });
            await page.waitForTimeout(1500);
        }
    }
    log({ type: 'eval-exhausted', note: 'evaluate kept failing for ~90s' });
    return null;
}

process.on('unhandledRejection', (err) => log({ type: 'unhandled', text: String(err).slice(0, 400) }));
process.on('uncaughtException', (err) => log({ type: 'uncaught', text: String(err).slice(0, 400) }));

/** Poll until Foundry reports `game.ready`. */
async function waitForGame() {
    for (let i = 0; i < 120; i++) {
        const ready = await ev(() => globalThis.game?.ready === true).catch(() => false);
        if (ready) return true;
        await page.waitForTimeout(1500);
    }
    return false;
}

const combatOf = () => {
    const combat = globalThis.game?.combats?.find((c) => c.name === 'Smoke Combat') ?? globalThis.game?.combat ?? null;
    return combat;
};

if (!(await waitForGame())) {
    log({ type: 'driver-error', reason: 'game-not-ready' });
    process.exit(1);
}
await h.ensureJoinedGame(page);
console.log('GM:', await ev(() => game.user.name));

const started = await ev(async () => {
    const combat = game.combats.find((c) => c.name === 'Smoke Combat') ?? game.combat;
    if (!combat) return { ok: false, reason: 'no-combat' };
    try { if (ui.combat) ui.combat.viewed = combat; } catch { /* */ }
    if (!combat.started) await combat.startCombat();
    return {
        ok: true, round: combat.round, turn: combat.turn,
        current: combat.combatant?.name ?? null,
        order: combat.turns.map((c) => c.name)
    };
});
log({ type: 'start', ...started });
if (!started?.ok) process.exit(1);

/** Advance the current turn (skips when combat moved or ended). */
async function nextTurn() {
    return ev(async () => {
        const combat = game.combats?.find((c) => c.name === 'Smoke Combat') ?? game.combat;
        const name = combat?.combatant?.name ?? null;
        await combat?.nextTurn();
        return name;
    });
}

/** Wait for the combat round/turn to move past `before`. */
async function waitAdvance(before, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const moved = await ev((b) => {
            const combat = game.combats?.find((c) => c.name === 'Smoke Combat') ?? game.combat;
            if (!combat) return true;
            return combat.round !== b.round || combat.turn !== b.turn;
        }, before);
        if (moved) return true;
        await page.waitForTimeout(700);
    }
    return false;
}

/** Scripted player turn: shoot the nearest visible hostile, then advance. */
async function scriptedPlayerTurn() {
    return ev(async () => {
        const combat = game.combats?.find((c) => c.name === 'Smoke Combat') ?? game.combat;
        const cb = combat?.combatant ?? null;
        const out = { name: cb?.name ?? null, shot: null };
        try {
            const api = game.darkHeresy?.api;
            const actor = cb?.actor ?? null;
            const token = cb?.token ?? null;
            if (api && actor && token) {
                const hostile = canvas.tokens.placeables
                    .filter((t) => t.document.disposition === -1 && !t.document.hidden)
                    .map((t) => ({
                        uuid: t.document.uuid,
                        d: Math.hypot(t.document.x - token.x, t.document.y - token.y)
                    }))
                    .sort((a, b) => a.d - b.d)[0] ?? null;
                const actions = await api.actions.list(actor, {}) ?? [];
                const atk = actions.find((a) => a.available !== false
                    && (a.attackType === 'single' || a.attackType === 'semi_auto'))
                    ?? actions.find((a) => a.available !== false && (a.kind === 'attack' || a.attack === true));
                if (hostile && atk) {
                    const prepared = await api.rolls.prepareAttack({
                        actorUuid: actor.uuid,
                        tokenUuid: token.uuid,
                        targetUuid: hostile.uuid,
                        weaponId: atk.itemUuid ?? atk.weaponId ?? atk.weapon ?? null,
                        attackType: atk.attackType ?? 'single'
                    });
                    if (prepared?.ok === false || prepared?.error) {
                        out.shot = { ok: false, reason: prepared?.reason ?? prepared?.error ?? 'prepare-fail' };
                    } else {
                        const res = await api.rolls.executeAttack(prepared, {});
                        out.shot = {
                            ok: res?.ok ?? res?.outcome ?? null,
                            hit: res?.hit ?? res?.success ?? res?.result?.hit ?? null,
                            target: hostile.uuid.split('.').pop()
                        };
                    }
                } else {
                    out.shot = { ok: false, reason: hostile ? 'no-attack-action' : 'no-hostile' };
                    // Jammed weapon: a scripted "player" clears it so the
                    // combatant keeps firing in later turns.
                    if (hostile) {
                        const jammed = actor.items.filter((i) => i.type === 'weapon'
                            && i.system?.jammed === true);
                        for (const w of jammed) {
                            await w.update({ 'system.jammed': false });
                            out.shot.unjammed = w.name;
                        }
                    }
                }
            }
        } catch (e) {
            out.shot = { ok: false, reason: `throw:${e.message}` };
        }
        await combat?.nextTurn();
        return out;
    });
}

/**
 * Damage pump: the system never applies attack damage by itself вЂ” the
 * chat flow is `.invoke-damage` (roll damage) then `.apply-damage-hit`
 * (apply with armour/TB/crits). Clicking the real buttons keeps the
 * automated run faithful. Buttons are marked once clicked.
 */
async function flushDamage(victimId = null) {
    return ev(async (victimArg) => {
        const clicked = { rolls: 0, applied: 0 };
        window.__drvInvoked ??= new Set();
        // Roll damage once per attack card (message ids survive re-renders).
        for (const el of document.querySelectorAll('.chat-message[data-message-id]')) {
            const mid = el.dataset.messageId;
            if (window.__drvInvoked.has(mid)) continue;
            const btn = el.querySelector('.invoke-damage');
            if (!btn) continue;
            window.__drvInvoked.add(mid);
            btn.click();
            clicked.rolls++;
        }
        if (clicked.rolls) await new Promise((r) => setTimeout(r, 600));
        // Apply pending hits: the per-hit handler needs a VICTIM token in
        // `game.user.targets`. Directed/suppression cards stamp
        // `damages[i].targetTokenId`; plain attack cards carry no victim
        // at all — the driver falls back to the most recent attack's
        // target. `rd.tokenId` is the ATTACKER's speaker token, never a
        // victim. An unresolvable hit is skipped — clicking it would only
        // spam APPLY_DAMAGE_NO_TARGET or deal damage to nobody.
        for (const el of document.querySelectorAll('.chat-message[data-message-id]')) {
            const mid = el.dataset.messageId;
            const buttons = [...el.querySelectorAll('.apply-damage-hit:not([data-drv])')];
            if (!buttons.length) continue;
            const rd = game.messages.get(mid)?.getRollData?.() ?? {};
            for (const btn of buttons) {
                const idx = Number(btn.closest('.damage-hit')?.dataset?.damageIndex);
                const entry = rd.damages?.[Number.isFinite(idx) ? idx : 0] ?? null;
                const victimId = entry?.targetTokenId ?? rd.targetTokenId ?? victimArg;
                const victimActorId = rd.targetActor?.id ?? rd.targetActor?._id ?? null;
                const token = victimId
                    ? (canvas.tokens.get(victimId)
                        ?? canvas.tokens.placeables.find((t) => t.id === victimId || t.document?.id === victimId))
                    : (victimActorId
                        ? canvas.tokens.placeables.find((t) => t.actor?.id === victimActorId)
                        : null);
                btn.dataset.drv = '1';
                if (!token || typeof token.setTarget !== 'function') {
                    clicked.skipped = (clicked.skipped ?? 0) + 1;
                    continue;
                }
                token.setTarget(true, { user: game.user, releaseOthers: true });
                btn.click();
                token.setTarget(false, { user: game.user });
                clicked.applied++;
            }
            if (clicked.applied) await new Promise((r) => setTimeout(r, 400));
        }

        // Death bookkeeping a GM would do manually: critical >= 5 while
        // wounds are fully consumed is lethal — mark the combatant
        // defeated so bots stop targeting the corpse.
        const combat = game.combats?.find((c) => c.name === 'Smoke Combat') ?? game.combat;
        if (combat?.started) {
            for (const cb of combat.combatants) {
                const crit = cb.actor?.system?.wounds?.critical ?? 0;
                const w = cb.actor?.system?.wounds ?? {};
                if (!cb.defeated && crit >= 5 && (w.value ?? 0) >= (w.max ?? Infinity)) {
                    await cb.update({ defeated: true });
                    try {
                        await cb.actor?.toggleStatusEffect?.('dead', { active: true, overlay: true });
                    } catch { /* status API is best-effort */ }
                    clicked.deaths = (clicked.deaths ?? []).concat(cb.name);
                }
            }
        }
        return clicked;
    }, victimId);
}

const handledOps = new Set();
// The last attack's victim token id — plain damage cards record no
// defender, so the damage pump aims `game.user.targets` at it.
let lastVictim = null;
let processed = 0;
let noSessionTicks = 0;
let lastWaitOpId = null;
// Grenade+door scenario: the Frag Grenadier starts sealed inside the
// central building; the driver opens its door at round 2 (a GM-side
// action — bot-initiated door opening is a separate feature).
let doorOpened = false;

while (processed < MAX_TURNS) {
    const state = await ev(() => {
        const combat = game.combats?.find((c) => c.name === 'Smoke Combat') ?? game.combat;
        if (!combat || !combat.started) return { done: true };
        const api = game.modules.get('only-war-ai')?.api;
        const preview = api?.services?.get('preview');
        const op = combat.getFlag('only-war-ai', 'operation') ?? null;
        const current = combat.combatant ?? null;
        const enabled = current
            ? api?.config?.resolveEffectiveConfig?.(current)?.enabled === true
            : false;
        const session = preview && op?.id ? preview.getSession(op.id) : null;
        return {
            done: false,
            round: combat.round,
            turn: combat.turn,
            current: current?.name ?? null,
            currentId: current?.id ?? null,
            ai: enabled,
            opPhase: op?.phase ?? null,
            opId: op?.id ?? null,
            hasSession: !!session
        };
    });
    if (!state || state.done) { log({ type: 'combat-ended' }); break; }
    if (RUN_ROUNDS && state.round > RUN_ROUNDS) {
        log({ type: 'round-limit', round: state.round, limit: RUN_ROUNDS });
        break;
    }

    // #66: open the building door once the combat reaches round 2 — the
    // sealed grenadier must then navigate through it before attacking.
    if (!doorOpened && state.round >= 2) {
        doorOpened = true;
        const opened = await ev(async () => {
            const scene = game.scenes.find((s) => s.name === 'Smoke Arena') ?? canvas.scene;
            const door = scene?.walls?.find((w) => (w.door > 0 || w.door?.type > 0));
            if (!door) return 'no-door';
            for (const update of [{ ds: 1 }, { 'door.state': 1 }]) {
                try { await door.update(update); return JSON.stringify(update); }
                catch (e) { /* try the next door-state schema */ }
            }
            return 'update-failed';
        });
        log({ type: 'door-opened', round: state.round, result: opened });
    }

    if (state.hasSession && !handledOps.has(state.opId)) {
        await page.waitForTimeout(400);
        const dump = await ev(async (opId) => {
            const api = game.modules.get('only-war-ai').api;
            const session = api.services.get('preview').getSession(opId);
            if (!session) return null;
            const plan = session.plan ?? {};
            const combat = game.combat;
            const cbt = combat?.combatant ?? null;
            const tok = cbt?.token ?? null;
            const safe = (o) => { try { return JSON.parse(JSON.stringify(o)); } catch { return String(o); } };
            return {
                operationId: opId,
                stale: session.stale ?? null,
                plan: safe({
                    id: plan.id,
                    winner: plan.winner ?? plan.action?.type ?? null,
                    intent: plan.intent ?? null,
                    steps: (plan.steps ?? []).map((s) => ({
                        type: s.type, mode: s.mode,
                        distance: s.distance ?? s.move?.distance ?? null,
                        name: s.input?.name ?? null,
                        blastRadius: s.input?.blastRadius ?? null,
                        attackType: s.input?.attackType ?? null
                    })),
                    score: plan.score ?? null,
                    seed: plan.seed ?? null,
                    replanCount: plan.replanCount ?? 0,
                    diagnostics: plan.diagnostics ?? null,
                    trace: plan.trace ?? null,
                    personality: plan.personality ?? null,
                    morale: plan.morale ?? null,
                    team: plan.teamPlan ?? plan.fireteam ?? null
                }),
                combatant: cbt?.name ?? null,
                tokenPos: tok ? { x: tok.x, y: tok.y } : null,
                round: combat?.round ?? null,
                turn: combat?.turn ?? null
            };
        }, state.opId);

        const rule = ACTIONS.find((r) => (dump?.combatant ?? '').includes(r.match));
        const action = rule?.do ?? 'confirm';
        log({
            type: 'preview',
            round: dump?.round ?? state.round,
            combatant: dump?.combatant ?? state.current,
            winner: dump?.plan?.winner ?? null,
            steps: dump?.plan?.steps ?? null,
            score: dump?.plan?.score ?? null,
            replan: dump?.plan?.replanCount ?? 0,
            stale: dump?.stale ?? null,
            tokenPos: dump?.tokenPos ?? null,
            rule: rule ?? null,
            action
        });
        if (dump?.plan?.diagnostics || dump?.plan?.trace || dump?.plan?.personality || dump?.plan?.morale || dump?.plan?.team) {
            log({ type: 'plan-detail', combatant: dump.combatant, opId: state.opId, ...dump.plan });
        }
        // Remember the attack victim for the damage pump: winner/candidate
        // strings carry the target token id as `...|<tokenId>`.
        const cand = dump?.plan?.diagnostics?.ranking?.[0]?.candidate ?? dump?.plan?.winner;
        const cParts = typeof cand === 'string' ? cand.split('|') : [];
        if (cParts.some((p) => /attack/.test(p)) && cParts[1]) lastVictim = cParts[1];
        if (SHOTS || action === 'capture') {
            await h.screenshot(page, `preview-${dump?.combatant ?? 'x'}-r${dump?.round ?? 0}`.replace(/\s+/g, '-'));
        }
        if (action === 'pause') {
            log({ type: 'paused', opId: state.opId, combatant: dump?.combatant });
            handledOps.add(state.opId);
            processed++;
            continue;
        }

        const before = { round: state.round, turn: state.turn };
        const res = await ev(async ({ opId, action }) => {
            const preview = game.modules.get('only-war-ai').api.services.get('preview');
            try { return await preview.resolvePreview(opId, action); }
            catch (e) { return { ok: false, reason: `throw:${e.message}` }; }
        }, { opId: state.opId, action });
        log({ type: 'decision', opId: state.opId, combatant: dump?.combatant, action, ok: res?.ok, reason: res?.reason ?? null, result: res?.result ?? null });

        const advanced = res?.ok === false
            ? false
            : await waitAdvance(before, 60000);
        if (!advanced) {
            log({ type: 'stall', opId: state.opId, combatant: dump?.combatant, note: 'turn did not advance in 60s' });
            // The op is stuck non-terminal (e.g. a dead target at confirm):
            // cancel the session, close the orphaned preview dialog and
            // push the turn forward — otherwise the run waits forever on
            // hasSession + handledOps below.
            await ev(async ({ opId }) => {
                try {
                    await game.modules.get('only-war-ai').api.services
                        .get('preview')?.resolvePreview?.(opId, 'cancel');
                } catch (e) { /* best effort */ }
                for (const app of [...document.querySelectorAll('.ow-ai-preview, #ow-ai-preview')]) {
                    app.closest('.window-app, .application')
                        ?.querySelector('[data-action="close"], button.close, a.close')
                        ?.click();
                }
                const combat = game.combats?.find((c) => c.name === 'Smoke Combat') ?? game.combat;
                await combat?.nextTurn();
                return true;
            }, { opId: state.opId });
        }
        handledOps.add(state.opId);
        processed++;
        const dmg = await flushDamage(lastVictim);
        if (dmg?.rolls || dmg?.applied) log({ type: 'damage-pump', ...dmg });
        continue;
    }

    if (state.ai && state.opId && ['completed', 'failed', 'cancelled'].includes(state.opPhase)) {
        // Operation already terminal (e.g. dialog-closed cancel) вЂ” the turn
        // stays under manual control, push it forward ourselves.
        const skipped = await nextTurn();
        log({ type: 'skip-terminal-op', combatant: skipped, opId: state.opId, opPhase: state.opPhase });
        handledOps.add(state.opId);
        await page.waitForTimeout(800);
        continue;
    }

    if (!state.hasSession && state.ai && !handledOps.has(state.opId)) {
        noSessionTicks = (state.opId === lastWaitOpId) ? noSessionTicks + 1 : 1;
        lastWaitOpId = state.opId;
        if (noSessionTicks > 16) {
            const skipped = await nextTurn();
            log({ type: 'watchdog-skip', combatant: skipped, opId: state.opId, opPhase: state.opPhase });
            handledOps.add(state.opId);
            noSessionTicks = 0;
        }
        await page.waitForTimeout(1200);
        continue;
    }

    if (state.hasSession && handledOps.has(state.opId)) {
        await page.waitForTimeout(1200);
        continue;
    }

    if (!state.ai) {
        if (PAUSE_ON && state.current?.includes(PAUSE_ON)) {
            const waitMs = Number(process.env.PLAYER_WAIT_MS || 30000);
            log({ type: 'player-wait', combatant: state.current, waitMs, round: state.round });
            const before = { round: state.round, turn: state.turn };
            const moved = await waitAdvance(before, waitMs);
            if (!moved) {
                await nextTurn();
                log({ type: 'player-timeout-skip', combatant: state.current });
            } else {
                log({ type: 'player-acted', combatant: state.current });
            }
            continue;
        }
        if (SKIP_PLAYERS) {
            const played = await scriptedPlayerTurn();
            log({ type: 'player-turn', combatant: played?.name ?? state.current, shot: played?.shot ?? null, round: state.round });
            if (played?.shot?.target) lastVictim = played.shot.target;
            const dmg = await flushDamage(lastVictim);
            if (dmg?.rolls || dmg?.applied) log({ type: 'damage-pump', ...dmg });
            await page.waitForTimeout(800);
        } else {
            await page.waitForTimeout(1500);
        }
        continue;
    }

    await page.waitForTimeout(800);
}

/** Click Yes/OK on blocking dialogs (endCombat confirm, etc.). */
async function acceptDialogs() {
    return ev(() => {
        const buttons = [
            ...document.querySelectorAll('.dialog button, .window-app button, .application button')
        ];
        const ok = buttons.find((b) => /yes|ok|confirm|accept/i.test(b.dataset.action ?? '')
            || /^(yes|ok|confirm|accept)$/i.test((b.textContent ?? '').trim()));
        if (!ok) return false;
        ok.click();
        return true;
    });
}

const tail = await ev(() => {
    const combat = game.combats?.find((c) => c.name === 'Smoke Combat') ?? game.combat;
    return {
        round: combat?.round ?? null,
        turn: combat?.turn ?? null,
        started: combat?.started ?? null,
        consoleErrors: (window.__owAiErrors ?? []).length
    };
});
if (END_COMBAT && tail?.started) {
    // endCombat() resolves only after the "end this encounter?" dialog —
    // keep re-firing the call and accepting the dialog until the combat
    // is actually gone: the first invocation can race a pending
    // combatant update and silently no-op.
    for (let i = 0; i < 30; i++) {
        await ev(() => {
            const combat = game.combats?.find((c) => c.name === 'Smoke Combat') ?? game.combat;
            if (combat?.started === true) combat.endCombat?.().catch(() => {});
            return true;
        });
        await page.waitForTimeout(600);
        await acceptDialogs();
        const gone = !(await ev(() => {
            const combat = game.combats?.find((c) => c.name === 'Smoke Combat') ?? game.combat;
            return combat?.started === true;
        }));
        if (gone) { tail.ended = true; break; }
    }
}
log({ type: 'driver-done', ...tail });
console.log('DRIVER EXIT');
process.exit(0);
