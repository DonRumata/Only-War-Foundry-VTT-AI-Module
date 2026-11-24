import { chromium } from 'playwright-core';
import * as h from '../lib.mjs';

/**
 * Automated driver for the live smoke scenario (docs: smoke/README.md).
 * Runs the staged "Smoke Arena" combat end to end on the GM client:
 *   phase A вЂ” baseline round: every bot executes its turn automatically;
 *   phase B вЂ” statuses: pinned / prone / stunned applied to bots;
 *   phase C вЂ” member loss: one alpha trooper is marked defeated+dead;
 *   phase D вЂ” hybrid: a player moves adjacent to an alpha trooper so a
 *             melee-capable bot should prefer its chainsword;
 *   phase E вЂ” preview: execution mode switches to "preview" for one bot
 *             turn, the GM approves, player tabs are checked for leaks;
 *   phase F вЂ” player view: whisper/dialog isolation is asserted.
 *
 * The in-page collector records every turn change with a full position
 * snapshot and the just-finished operation record, so fast automatic
 * turns are never missed. Prints a transcript at the end.
 *
 * Run: node smoke/run-smoke.mjs [phaseName]
 */

const MODULE = 'only-war-ai';
const BOT_TURN_TIMEOUT = 60000;

const browser = await chromium.connectOverCDP(h.CDP_URL);
const gm = await h.getGmPage(browser);
await h.ensureJoinedGame(gm);
const only = process.argv[2] ?? null;
console.log('GM:', await gm.evaluate(() => game.user.name), '| phases:', only ?? 'all');

// Page console capture: module warnings ('nextTurn failed', executor
// diagnostics) and uncaught errors go into the transcript.
const pageLogs = [];
gm.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || m.type() === 'warning'
        || /only-war-ai|nextTurn|executor|planner|fireteam|preview/i.test(t)) {
        pageLogs.push(`${m.type()}: ${t.slice(0, 250)}`);
    }
});
gm.on('pageerror', (e) => pageLogs.push(`pageerror: ${String(e?.stack ?? e).slice(0, 400)}`));

const ev = (fn, arg) => gm.evaluate(fn, arg);

// ---------- helpers --------------------------------------------------------

async function settings({ mode }) {
    return ev(async ({ mode }) => {
        await game.settings.set('only-war-ai', 'masterEnabled', true);
        await game.settings.set('only-war-ai', 'executionMode', mode);
        await game.settings.set('only-war-ai', 'diagnosticsEnabled', true);
        return {
            master: game.settings.get('only-war-ai', 'masterEnabled'),
            mode: game.settings.get('only-war-ai', 'executionMode')
        };
    }, { mode });
}

async function state() {
    return ev(() => {
        const c = game.combats.find((x) => x.scene?.name === 'Smoke Arena');
        if (!c) return null;
        const cur = c.combatant;
        return {
            started: c.started, round: c.round, turn: c.turn,
            current: cur ? { id: cur.id, name: cur.name ?? cur.token?.name } : null,
            size: c.combatants.size
        };
    });
}

async function aiEnabled(id) {
    return ev((cid) => {
        const c = game.combats.find((x) => x.scene?.name === 'Smoke Arena');
        const cb = c.combatants.get(cid);
        const cfg = game.modules.get('only-war-ai').api.config.resolveEffectiveConfig(cb);
        return cfg?.enabled === true;
    }, id);
}

async function installCollector() {
    return ev(() => {
        if (window.__smoke?.installed) return 'already';
        const s = window.__smoke = { installed: true, turns: [], chats: [], errors: [] };
        const isSmoke = (c) => c?.scene?.name === 'Smoke Arena';
        const snapshot = (c) => {
            const pos = {};
            for (const cb of c.combatants) {
                const t = cb.token;
                pos[cb.name ?? cb.token?.name] = t
                    ? { x: t.x, y: t.y, hidden: t.hidden === true, defeated: cb.defeated === true }
                    : null;
            }
            const op = foundry.utils.deepClone(c.getFlag('only-war-ai', 'operation') ?? null);
            return { positions: pos, op };
        };
        s._h1 = Hooks.on('updateCombat', (c, change) => {
            if (!isSmoke(c)) return;
            if (!('turn' in change || 'round' in change)) return;
            const cur = c.combatant;
            s.turns.push({
                round: c.round, turn: c.turn,
                name: cur?.name ?? null, ts: Date.now(),
                ...snapshot(c)
            });
        });
        s._h2 = Hooks.on('createChatMessage', (m) => {
            s.chats.push({
                alias: m.speaker?.alias ?? null, author: m.author?.name ?? null,
                isRoll: m.isRoll === true, type: m.type,
                whisper: (m.whisper ?? []).map((u) => u.name ?? u.id ?? u),
                content: String(m.content ?? '').slice(0, 100)
            });
        });
        window.addEventListener('error', (e) => s.errors.push(String(e.message).slice(0, 200)));
        return 'installed';
    });
}

async function nextTurn() {
    return ev(() => game.combats.find((x) => x.scene?.name === 'Smoke Arena').nextTurn());
}

/**
 * Pump combat turns until `until(state)` is true. Bot turns are waited
 * out (the executor advances itself); player turns are skipped.
 */
async function pump(until, { maxTurns = 80, label = 'pump' } = {}) {
    const log = [];
    for (let i = 0; i < maxTurns; i++) {
        const st = await state();
        if (!st) return { log, error: 'combat gone' };
        if (await until(st)) return { log, end: st };
        const cur = st.current;
        if (!cur) return { log, error: 'no current combatant' };
        if (!await aiEnabled(cur.id)) {
            log.push(`${label}: player turn ${cur.name} вЂ” skipped`);
            await nextTurn();
            await gm.waitForTimeout(500);
            continue;
        }
        const t0 = Date.now();
        let done = false;
        let stallLogged = false;
        let claimed = null;
        while (Date.now() - t0 < BOT_TURN_TIMEOUT) {
            await gm.waitForTimeout(500);
            const s2 = await state();
            if (!s2 || s2.round !== st.round || s2.turn !== st.turn) { done = true; break; }
            // Track whether authority ever claims this bot's turn; defeated
            // or otherwise unclaimed bots get skipped after a grace window.
            if (claimed === null && Date.now() - t0 > 20000) {
                claimed = await ev((cid) => {
                    const c = game.combats.find((x) => x.scene?.name === 'Smoke Arena');
                    const o = c.getFlag('only-war-ai', 'operation') ?? null;
                    return !!(o && o.combatantId === cid
                        && !['completed', 'failed', 'cancelled'].includes(o.phase));
                }, cur.id);
                if (!claimed) {
                    const info = await ev((cid) => {
                        const c = game.combats.find((x) => x.scene?.name === 'Smoke Arena');
                        const cb = c.combatants.get(cid);
                        return { defeated: cb?.defeated === true,
                            statuses: [...(cb?.token?.actor?.statuses ?? cb?.actor?.statuses ?? [])] };
                    }, cur.id);
                    log.push(`${label}: ${cur.name} UNCLAIMED after 20s (defeated=${info.defeated}, statuses=${info.statuses}) вЂ” skipping`);
                    await nextTurn();
                    done = true;
                    break;
                }
            }
            // Watchdog: a terminal op must advance the turn вЂ” flag a stall
            // instead of silently waiting the full timeout.
            if (!stallLogged && Date.now() - t0 > 8000) {
                const op = await ev(() => {
                    const c = game.combats.find((x) => x.scene?.name === 'Smoke Arena');
                    const o = c.getFlag('only-war-ai', 'operation') ?? null;
                    return o ? { phase: o.phase, res: o.result?.result?.status ?? null,
                        reason: o.result?.reason ?? o.result?.result?.reason ?? null,
                        adv: o.result?.advanceTurn ?? null } : null;
                });
                if (op && ['completed', 'failed', 'cancelled'].includes(op.phase)) {
                    stallLogged = true;
                    log.push(`${label}: ${cur.name} STALL вЂ” op ${op.phase}/${op.res ?? op.reason} adv=${op.adv} but turn held >8s`);
                }
            }
        }
        if (!done) {
            log.push(`${label}: ${cur.name} BOT TURN TIMEOUT вЂ” forcing nextTurn`);
            await nextTurn();
        } else {
            log.push(`${label}: ${cur.name} acted (r${st.round}t${st.turn})`);
        }
        const s3 = await state();
        if (s3 && await until(s3)) return { log, end: s3 };
    }
    return { log, error: 'maxTurns exceeded' };
}

async function collector() { return ev(() => window.__smoke ?? null); }

async function playerPages() {
    const ctx = browser.contexts()[0];
    const out = {};
    for (const p of ctx.pages()) {
        try {
            const name = await p.evaluate(() => globalThis.game?.user?.name);
            if (name?.startsWith('Smoke Player')) out[name] = p;
        } catch { /* not a game tab */ }
    }
    return out;
}

// ---------- run ------------------------------------------------------------

const transcript = [];
const say = (...a) => { console.log(...a); transcript.push(a.join(' ')); };

try {
    await installCollector();
    say('settings:', JSON.stringify(await settings({ mode: 'automatic' })));
    say('combat:', JSON.stringify(await ev(async () => {
        const c = game.combats.find((x) => x.scene?.name === 'Smoke Arena');
        if (!c.started) await c.startCombat();
        return { started: c.started, round: c.round, turn: c.turn };
    })));

    if (!only || only === 'baseline') {
        const r1 = await state();
        const a = await pump((st) => st.round > r1.round, { label: 'A' });
        for (const line of a.log) say(line);
        if (a.error) say('phase A error:', a.error);
    }

    if (!only || only === 'statuses') {
        const applied = await ev(async () => {
            const c = game.combats.find((x) => x.scene?.name === 'Smoke Arena');
            const apply = async (name, status) => {
                const cb = c.combatants.find((x) => (x.name ?? '') === name);
                const actor = cb?.token?.actor ?? cb?.actor;
                if (!actor) return `${name}: no actor`;
                await actor.toggleStatusEffect(status, { active: true });
                return `${name}: ${status} в†’ ${[...actor.statuses].join(',')}`;
            };
            return [
                await apply('Beta Rifleman 2', 'pinned'),
                await apply('Beta Rifleman 3', 'prone'),
                await apply('Alpha Trooper 3', 'stunned')
            ];
        });
        say('statuses applied:', JSON.stringify(applied));

        const killed = await ev(async () => {
            const c = game.combats.find((x) => x.scene?.name === 'Smoke Arena');
            const cb = c.combatants.find((x) => (x.name ?? '') === 'Alpha Trooper 2');
            await cb.update({ defeated: true });
            const actor = cb.token?.actor ?? cb.actor;
            await actor.toggleStatusEffect('dead', { active: true, overlay: true });
            return { defeated: cb.defeated, statuses: [...actor.statuses] };
        });
        say('Alpha Trooper 2 killed:', JSON.stringify(killed));
    }

    if (!only || only === 'hybrid' || only === 'statuses') {
        say('hybrid setup:', await ev(async () => {
            const c = game.combats.find((x) => x.scene?.name === 'Smoke Arena');
            const alpha = c.combatants.find((x) => (x.name ?? '') === 'Alpha Trooper 1')?.token;
            const pc = c.combatants.find((x) => (x.name ?? '') === 'Acolyte One')?.token;
            if (!alpha || !pc) return 'missing tokens';
            await pc.update({ x: alpha.x - 100, y: alpha.y });
            return `Acolyte One в†’ adjacent to Alpha Trooper 1 at ${alpha.x},${alpha.y}`;
        }));
    }

    if (!only || only === 'statuses' || only === 'hybrid') {
        const r = await state();
        const b = await pump((st) => st.round > r.round, { label: 'B' });
        for (const line of b.log) say(line);
        if (b.error) say('phase B error:', b.error);
    }

    if (!only || only === 'preview') {
        await settings({ mode: 'preview' });
        let session = null;
        for (let i = 0; i < 30 && !session; i++) {
            const st = await state();
            if (!st) break;
            const enabled = st.current ? await aiEnabled(st.current.id) : false;
            if (!enabled) {
                await nextTurn();
                await gm.waitForTimeout(500);
                continue;
            }
            for (let j = 0; j < 60; j++) {
                session = await ev(() => {
                    const pv = game.modules.get('only-war-ai').api.services.get('preview');
                    if (!pv || pv.sessionCount() === 0) return null;
                    const c = game.combats.find((x) => x.scene?.name === 'Smoke Arena');
                    const op = c.getFlag('only-war-ai', 'operation');
                    const s = pv.getSession(op?.id ?? '') ?? null;
                    return s ? {
                        operationId: s.operationId,
                        plan: s.plan ? {
                            variant: s.plan.breakdown?.variant ?? null,
                            steps: s.plan.steps?.map((x) => x.type) ?? [],
                            score: s.plan.score ?? null
                        } : null
                    } : { operationId: op?.id ?? null, plan: null, sessionMissing: true };
                });
                if (session?.operationId && !session.sessionMissing) break;
                if (session?.sessionMissing) { session = null; }
                await gm.waitForTimeout(400);
            }
            if (session) break;
        }
        if (session) {
            const st = await state();
            say(`preview pending for ${st.current?.name}:`, JSON.stringify(session));
            for (const [name, p] of Object.entries(await playerPages())) {
                say(`player view ${name}:`, JSON.stringify(await p.evaluate(() => ({
                    owaiDom: document.querySelectorAll('[class*="owai"], [id*="owai"]').length,
                    user: game.user.name, isGM: game.user.isGM
                }))));
            }
            say('GM owai DOM nodes:', await ev(() =>
                document.querySelectorAll('[class*="owai"], [id*="owai"]').length));
            await ev((opId) => game.modules.get('only-war-ai').api.services.get('preview')
                .resolvePreview(opId, 'confirm'), session.operationId);
            say('preview confirmed вЂ” execution continues');
            await gm.waitForTimeout(4000);
        } else {
            say('no preview session captured');
        }
        await settings({ mode: 'automatic' });
    }

    if (!only || only === 'players') {
        const players = await playerPages();
        say('player tabs:', Object.keys(players).join(', ') || 'none');
        const gmWhispered = await ev(() => game.messages.filter((m) => m.whisper?.length)
            .map((m) => ({ id: m.id, whisper: m.whisper.map((u) => u.name ?? u) })));
        say(`GM sees ${gmWhispered.length} whispered messages`);
        for (const [name, p] of Object.entries(players)) {
            say(`${name}:`, JSON.stringify(await p.evaluate(() => {
                // Whispered docs sync to all clients; the real leak check
                // is `visible` (server+UI filter) and rendered chat nodes.
                const leaked = game.messages.filter((m) => m.whisper?.length
                    && !m.whisper.some((u) => (u.id ?? u) === game.user.id)
                    && m.visible === true)
                    .map((m) => m.id);
                const rendered = [...document.querySelectorAll('#chat-log li.chat-message')]
                    .filter((li) => li.classList.contains('whisper'))
                    .length;
                const notif = [...document.querySelectorAll('#notifications .notification')]
                    .map((n) => n.textContent.slice(0, 80));
                const dialogs = [...document.querySelectorAll('.app.window-app')]
                    .map((a) => a.querySelector('.window-title')?.textContent ?? a.id)
                    .filter(Boolean);
                return { leakedVisibleWhispers: leaked, renderedWhispers: rendered,
                    notifications: notif, openDialogs: dialogs };
            })));
        }
    }
} catch(err) {
    say('DRIVER ERROR:', err.message);
} finally {
    try { await settings({ mode: 'automatic' }); } catch { /* best effort */ }
    // Never leave the combat parked on a pending preview/operation.
    try {
        await ev(async () => {
            const c = game.combats.find((x) => x.scene?.name === 'Smoke Arena');
            const op = c?.getFlag('only-war-ai', 'operation');
            if (op && !['completed', 'failed', 'cancelled'].includes(op.phase)) {
                await c.unsetFlag('only-war-ai', 'operation');
            }
        });
    } catch { /* best effort */ }
}

// ---------- transcript ------------------------------------------------------

const collected = await collector();
console.log('\n=== TURNS ===');
for (let i = 0; i < (collected?.turns?.length ?? 0); i++) {
    const t = collected.turns[i];
    const prev = i > 0 ? collected.turns[i - 1].positions : null;
    const moved = [];
    for (const [name, a] of Object.entries(t.positions ?? {})) {
        const b = prev?.[name];
        if (!a || !b) continue;
        const d = Math.hypot(a.x - b.x, a.y - b.y) / 100;
        if (d >= 0.5) moved.push(`${name} ${d.toFixed(1)}m`);
    }
    const op = t.op;
    const opTxt = op ? `${op.phase}/${op.result?.status ?? op.reason ?? '?'}` : '-';
    const steps = op?.result?.stepsDone?.map((s) => s.type).join(',') ?? '';
    console.log(`r${t.round} t${t.turn} в†’ ${t.name} | prev-op: ${opTxt}${steps ? ' steps:' + steps : ''}${moved.length ? ' | moved: ' + moved.join(', ') : ''}`);
}
console.log('\n=== CHAT (last 40) ===');
for (const c of (collected?.chats ?? []).slice(-40)) {
    console.log(`[${c.type}${c.isRoll ? '/roll' : ''}] ${c.alias ?? c.author}${c.whisper.length ? ' в†’ whisper:' + c.whisper.join('+') : ''} ${c.content}`);
}
if (collected?.errors?.length) {
    console.log('\n=== PAGE ERRORS ===');
    for (const e of collected.errors.slice(0, 10)) console.log(e);
}
if (pageLogs.length) {
    console.log('\n=== CONSOLE (module-related) ===');
    for (const e of pageLogs.slice(-30)) console.log(e);
}
console.log('\nDONE');
process.exit(0);
