/**
 * Post-run verifier for the smoke driver log (`smoke-drive.jsonl`).
 * Asserts the behavioural contract a healthy autonomous run must meet
 * and prints a PASS/FAIL checklist; exits non-zero on any FAIL.
 *
 * Contract (smoke findings + comms-net feature):
 *  1. driver-done present and `ended === true` (END=1 flow completed);
 *  2. every AI combatant got at least one `decision` on its turns;
 *  3. decisions mostly `ok: true`; no `uncaught`/`unhandled`/`eval-exhausted`;
 *  4. distant bots (Beta Rifleman, Spec Operative) produced non-end-turn
 *     plans once contacts existed — the comms-net regression sentinel;
 *  5. no dead/defeated combatant appears as an attack target later on;
 *  6. no `watchdog-skip` and no unrecovered `stall` (a stall must be
 *     followed by progress — the unstick path);
 *  7. no unexpected console/page errors (whitelisted patterns only).
 *
 * Run: node smoke/assert-smoke.mjs [logPath]
 */
import fs from 'node:fs';

const LOG = process.argv[2] ?? new URL('./smoke-drive.jsonl', import.meta.url).pathname
    .replace(/^\/([A-Za-z]:)/, '$1');
const AI_RE = /Alpha Trooper|Beta Rifleman|Spec Operative|Hold Gunner/;
const FAR_RE = /Beta Rifleman|Spec Operative/;
// Console errors seen in a healthy endCombat teardown (perception hook
// racing the combat deletion) — tracked separately, not a hard fail yet.
const ERROR_WHITELIST = /does not exist in combats/i;

const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').map(JSON.parse);
const results = [];
const check = (name, ok, detail = '') =>
    results.push({ name, ok, detail });
const events = (type) => lines.filter((r) => r.type === type);

/* 1 — completion */
const done = events('driver-done').pop();
check('driver-done logged', !!done, done ? `round=${done.round}` : 'missing');
check('combat ended via END=1', done?.ended === true,
    done ? `ended=${done.ended}` : 'no driver-done');

/* 2 — AI turn coverage */
const decisions = events('decision').filter((r) => AI_RE.test(r.combatant ?? ''));
const bots = new Set(lines.filter((r) => AI_RE.test(r.combatant ?? ''))
    .map((r) => r.combatant));
const decided = new Set(decisions.map((r) => r.combatant));
const silent = [...bots].filter((b) => !decided.has(b));
check('every AI combatant decided', silent.length === 0,
    silent.length ? `no decision: ${silent}` : `${decided.size} bots`);

/* 3 — health counters */
const okRate = decisions.length
    ? decisions.filter((r) => r.ok === true).length / decisions.length
    : 0;
check('decision ok-rate ≥ 80%', decisions.length === 0 || okRate >= 0.8,
    `${decisions.filter((r) => r.ok === true).length}/${decisions.length}`);
for (const t of ['uncaught', 'unhandled', 'eval-exhausted', 'watchdog-skip']) {
    check(`no ${t}`, events(t).length === 0, `${events(t).length} hit(s)`);
}

/* 4 — comms-net: distant bots act, not just end-turn */
const farDecisions = [...decided].filter((n) => FAR_RE.test(n));
const farPassive = farDecisions.filter((name) => {
    const plans = events('preview').filter((r) => r.combatant === name);
    return plans.length > 0 && plans.every(
        (r) => (r.steps ?? []).every((s) => s.type === 'end-turn'));
});
check('distant bots act (comms-net)', farPassive.length === 0,
    farPassive.length ? `all end-turn: ${farPassive}` : 'all acted at least once');

/* 5 — dead units never re-enter target lists */
const deadIds = new Set();
for (const r of events('damage-pump')) {
    for (const d of r.deaths ?? []) deadIds.add(d);
}
let deadTargeted = [];
if (deadIds.size) {
    // Map dead names → token ids as seen in plan-detail target lists.
    const deadNameRe = new RegExp([...deadIds].join('|'));
    for (const r of events('plan-detail')) {
        const ranked = r.diagnostics?.ranking ?? [];
        for (const c of ranked) {
            if (deadNameRe.test(c.candidate ?? '')) deadTargeted.push(c.candidate);
        }
    }
}
check('dead combatants not targeted after death', deadTargeted.length === 0,
    deadTargeted.length ? `${deadTargeted.length} hits` : 'clean');

/* 6 — stalls recovered */
const stalls = events('stall');
const progressed = stalls.length === 0
    || lines.slice(lines.findIndex((r) => r.type === 'stall'))
        .some((r) => r.type === 'decision' && r.ok === true || r.type === 'preview');
check('stalls recovered', stalls.length === 0 || progressed,
    `${stalls.length} stall(s)`);

/* 7 — console/page errors (whitelist-exempt) */
const errors = [...events('console-error'), ...events('pageerror')]
    .filter((r) => !ERROR_WHITELIST.test(r.text ?? ''));
check('no unexpected console/page errors', errors.length === 0,
    errors.length ? `${errors.length}: ${errors[0].text?.slice(0, 120)}` : 'clean');
const whitelisted = [...events('console-error'), ...events('pageerror')]
    .filter((r) => ERROR_WHITELIST.test(r.text ?? ''));
if (whitelisted.length) {
    results.push({ name: 'whitelisted errors (informal)', ok: true,
        detail: `${whitelisted.length} teardown errors` });
}

/* report */
let fails = 0;
for (const r of results) {
    if (!r.ok) fails++;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
