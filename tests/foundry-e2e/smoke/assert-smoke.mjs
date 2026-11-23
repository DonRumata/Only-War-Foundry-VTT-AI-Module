/**
 * Post-run verifier for the smoke driver log (`smoke-drive.jsonl`).
 * Asserts the behavioural contract a healthy autonomous run must meet
 * and prints a PASS/FAIL/SKIP checklist; exits non-zero on any FAIL.
 *
 * Contract (smoke findings + comms-net feature):
 *  1. driver-done present and `ended === true` (END=1 flow completed);
 *  2. every AI combatant got at least one `decision` on its turns;
 *  3. decisions mostly `ok: true`; no `uncaught`/`unhandled`/`eval-exhausted`;
 *  4. distant bots (Beta Rifleman, Spec Operative) produced non-end-turn
 *     plans once contacts existed — the comms-net regression sentinel;
 *  5. relayed contacts actually appear in diagnostics.targets as
 *     `source:"relay"` entries (SKIP when diagnostics lack targets —
 *     module build older than the targets dump);
 *  6. no dead/defeated combatant appears as an attack target later on;
 *  7. no `watchdog-skip` and stalls are followed by progress;
 *  8. no unexpected console/page errors (whitelisted patterns only);
 *  9. Alpha Troopers stay target-sticky: among attack plans the
 *     dominant target share is ≥50%;
 * 10. tactical layers are exercised: morale record, personality overlay,
 *     commitment layer — at least one plan shows each active;
 * 11. pinned bots reach for unpin/drop-prone (TF4);
 * 12. scripted player turns happened for each acolyte.
 *
 * Informational tallies (never fail): factor usage, step histogram,
 * damage/death counts, jams observed.
 *
 * Run: node smoke/assert-smoke.mjs [logPath]
 */
import fs from 'node:fs';

const LOG = process.argv[2] ?? new URL('./smoke-drive.jsonl', import.meta.url).pathname
    .replace(/^\/([A-Za-z]:)/, '$1');
const AI_RE = /Alpha Trooper|Beta Rifleman|Spec Operative|Hold Gunner/;
const FAR_RE = /Beta Rifleman|Spec Operative/;
const ALPHA_RE = /Alpha Trooper/;
// Console errors seen in a healthy endCombat teardown (perception hook
// racing the combat deletion) — tracked separately, not a hard fail yet.
const ERROR_WHITELIST = /does not exist in combats/i;

const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').map(JSON.parse);
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });
const skip = (name, detail = '') => results.push({ name, ok: 'skip', detail });
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

/* 5 — relayed contacts visible in diagnostics.targets */
const plans = events('plan-detail');
const withTargets = plans.filter((r) => Array.isArray(r.diagnostics?.targets));
if (!withTargets.length) {
    skip('relay contacts in diagnostics.targets', 'module build has no targets dump');
} else {
    const relayPlans = withTargets.filter((r) =>
        r.diagnostics.targets.some((t) => t.source === 'relay'));
    check('relay contacts reached planners', relayPlans.length > 0,
        relayPlans.length ? `${relayPlans.length} plan(s)` : 'none seen');
    const memPlans = withTargets.filter((r) =>
        r.diagnostics.targets.some((t) =>
            t.source === 'relay' || t.source === 'team-contact' || t.source === 'last-known'));
    results.push({ name: 'memory contacts (info)', ok: true,
        detail: `${memPlans.length} plan(s) with relay/team/last-known targets` });
}

/* 6 — dead units never re-enter target lists */
const deadIds = new Set();
for (const r of events('damage-pump')) {
    for (const d of r.deaths ?? []) deadIds.add(d);
}
let deadTargeted = [];
if (deadIds.size) {
    const deadNameRe = new RegExp([...deadIds].join('|'));
    for (const r of plans) {
        const ranked = r.diagnostics?.ranking ?? [];
        for (const c of ranked) {
            if (deadNameRe.test(c.candidate ?? '')) deadTargeted.push(c.candidate);
        }
        for (const t of r.diagnostics?.targets ?? []) {
            // diagnostics.targets only carries ids; matching by name is
            // impossible here — candidate strings already cover the names
            // embedded in rejected/ranking entries.
        }
    }
}
check('dead combatants not targeted after death', deadTargeted.length === 0,
    deadTargeted.length ? `${deadTargeted.length} hits` : 'clean');
results.push({ name: 'deaths recorded (info)', ok: true,
    detail: `${deadIds.size} combatant(s): ${[...deadIds].join(', ') || '-'}` });

/* 7 — stalls recovered */
const stalls = events('stall');
const progressed = stalls.length === 0
    || lines.slice(lines.findIndex((r) => r.type === 'stall'))
        .some((r) => (r.type === 'decision' && r.ok === true) || r.type === 'preview');
check('stalls recovered', stalls.length === 0 || progressed,
    `${stalls.length} stall(s)`);

/* 8 — console/page errors (whitelist-exempt) */
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

/* 9 — Alpha target stickiness */
const targetOf = (cand) => (cand ?? '').split('|')[1] ?? null;
const alphaSwitch = [];
for (const name of [...decided].filter((n) => ALPHA_RE.test(n))) {
    const seq = plans.filter((r) => r.combatant === name)
        .map((r) => targetOf(r.diagnostics?.ranking?.[0]?.candidate))
        .filter(Boolean);
    const attackSeq = plans.filter((r) => r.combatant === name
        && (r.steps ?? []).some((s) => /attack|charge/.test(s.type)))
        .map((r) => targetOf(r.diagnostics?.ranking?.[0]?.candidate))
        .filter(Boolean);
    if (attackSeq.length < 3) continue;
    const counts = {};
    for (const t of attackSeq) counts[t] = (counts[t] ?? 0) + 1;
    const topShare = Math.max(...Object.values(counts)) / attackSeq.length;
    if (topShare < 0.5) alphaSwitch.push(`${name} ${(topShare * 100).toFixed(0)}%`);
}
check('alpha target stickiness ≥50%', alphaSwitch.length === 0,
    alphaSwitch.length ? `hoppy: ${alphaSwitch}` : 'dominant target per bot');

/* 10 — tactical layers exercised */
const layerSeen = (kind) => plans.some((r) => r.diagnostics?.layerFlags?.[kind] === true);
for (const kind of ['commitment', 'morale', 'personality']) {
    if (!withTargets.length) { skip(`layer ${kind} active`, 'old diagnostics'); continue; }
    check(`layer ${kind} active`, layerSeen(kind),
        layerSeen(kind) ? 'seen in layerFlags' : 'never true');
}
const moraleRec = plans.filter((r) => r.diagnostics?.morale?.enabled === true);
if (withTargets.length) {
    check('morale records produced', moraleRec.length > 0, `${moraleRec.length} plan(s)`);
    const persRec = plans.filter((r) => (r.diagnostics?.personality?.traits?.length ?? 0) > 0);
    check('personality traits applied', persRec.length > 0, `${persRec.length} plan(s)`);
}

/* 11 — pinned bots reach for unpin/drop-prone (TF4) */
const pinnedPlans = plans.filter((r) => (r.diagnostics?.selfStatuses ?? []).includes('pinned'));
if (!pinnedPlans.length) {
    skip('pinned → unpin/drop-prone', 'no pinned bot observed');
} else {
    const escapes = pinnedPlans.filter((r) => {
        const inSteps = (r.steps ?? []).some((s) => /unpin|drop-prone/.test(s.type));
        const inRank = (r.diagnostics?.ranking ?? []).some((c) =>
            /unpin|drop-prone/.test(c.candidate ?? ''));
        return inSteps || inRank;
    });
    check('pinned → unpin/drop-prone', escapes.length > 0,
        `${escapes.length}/${pinnedPlans.length} pinned plans offer escape`);
}

/* 12 — scripted player turns */
const acolytes = [...new Set(lines.filter((r) => r.type === 'player-turn')
    .map((r) => r.combatant))];
check('player turns scripted', acolytes.length > 0,
    `${acolytes.length} acolyte(s): ${acolytes.join(', ')}`);

/* informational tallies */
const factorCounts = {};
for (const r of plans) {
    for (const t of r.trace ?? []) {
        if (t.kind === 'winner') {
            for (const f of t.detail?.factors ?? []) {
                factorCounts[f.factor] = (factorCounts[f.factor] ?? 0) + 1;
            }
        }
    }
}
results.push({ name: 'factors used (info)', ok: true,
    detail: Object.entries(factorCounts).sort((a, b) => b[1] - a[1])
        .slice(0, 10).map(([k, v]) => `${k}:${v}`).join(' ') || 'none' });
const jams = lines.filter((r) => /jam/i.test(JSON.stringify(r))).length;
results.push({ name: 'weapon jams (info)', ok: true, detail: `${jams} mention(s)` });

/* report */
let fails = 0;
for (const r of results) {
    if (r.ok === false) fails++;
    const tag = r.ok === 'skip' ? 'SKIP' : (r.ok ? 'PASS' : 'FAIL');
    console.log(`${tag}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
const scored = results.filter((r) => r.ok !== 'skip');
console.log(`\n${scored.length - fails}/${scored.length} checks passed`
    + ` (${results.length - scored.length} skipped)`);
process.exit(fails ? 1 : 0);
