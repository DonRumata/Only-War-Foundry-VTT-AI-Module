import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as h from './lib.mjs';

/**
 * Performance acceptance scenario (issue #410, epic #363): 10 active AI
 * NPCs organized in TWO fireteams run a full combat cycle through the
 * authority -> planner -> executor automation (automatic mode). The test
 * collects machine-readable counters (planning ms, execution ms,
 * candidate counts, path nodes, document update counts, replans, total
 * cycle time) into `reports/performance-<timestamp>.json`, proves the
 * cycle completes without runaway hooks or unbounded candidate growth,
 * and emits a human-readable failure report with operation/plan ids,
 * seeds, reasons and timings when it fails.
 *
 * Requires a running Foundry (FOUNDRY_URL), Chrome with CDP (CDP_URL) and
 * the only-war-ai module.
 */

const NPC_COUNT = 10;
const ENEMY_COUNT = 3;
const TEAM_IDS = ['alpha-perf', 'beta-perf'];
const CYCLE_TIMEOUT_MS = Number(process.env.OWAI_CYCLE_TIMEOUT) || 240_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.join(__dirname, 'reports');

let page;
let browser;
const npcActorIds = [];
const enemyActorIds = [];
let sceneId;
let combatId;
let previousMode;

async function setup() {
    browser = await chromium.connectOverCDP(h.CDP_URL);
    page = await h.getGmPage(browser);
    await h.ensureJoinedGame(page);
    page.on('console', (msg) => {
        const text = msg.text();
        if (/only-war-ai|nextTurn/.test(text)) console.log(`[page] ${text.slice(0, 220)}`);
    });
    // Chrome aggressively throttles setTimeout in hidden tabs; keep the GM
    // page foregrounded so the authority debounce fires promptly.
    await page.bringToFront().catch(() => {});

    console.log('Connected to Foundry game session');

    for (let i = 0; i < NPC_COUNT; i += 1) {
        const id = await h.createTestActor(page, 'npc', `AI Perf NPC ${i + 1}`, async (actor) => {
            await actor.update({ 'system.characteristics.agility.base': 40 });
            await actor.createEmbeddedDocuments('Item', [
                { name: 'Chainsword', type: 'weapon', system: { class: 'melee', damage: '1d10+4' } },
                {
                    name: 'Auto Pistol',
                    type: 'weapon',
                    system: {
                        class: 'pistol',
                        range: 10,
                        damage: '1d10+2',
                        clip: { value: 6, max: 9 },
                        rateOfFire: { single: 1, semi: 0, full: 0 }
                    }
                }
            ]);
        });
        npcActorIds.push(id);
    }
    for (let i = 0; i < ENEMY_COUNT; i += 1) {
        enemyActorIds.push(await h.createTestActor(page, 'npc', `AI Perf Enemy ${i + 1}`));
    }

    sceneId = await h.createTestScene(page, { grid: 1, size: 100 });
    const npcTids = [];
    const enemyTids = [];
    for (const [i, actorId] of npcActorIds.entries()) {
        const col = i % 2;
        const row = Math.floor(i / 2);
        npcTids.push(await h.placeToken(page, sceneId, actorId,
            { x: 400 + col * 200, y: 300 + row * 300 }));
    }
    for (const [i, actorId] of enemyActorIds.entries()) {
        enemyTids.push(await h.placeToken(page, sceneId, actorId,
            { x: 1400 + (i % 2) * 200, y: 500 + i * 400 }));
    }
    await page.evaluate(async (data) => {
        const scene = game.scenes.get(data.sceneId);
        for (const tid of data.npcTids) await scene.tokens.get(tid).update({ disposition: -1 });
        for (const tid of data.enemyTids) await scene.tokens.get(tid).update({ disposition: 1 });
    }, { sceneId, npcTids, enemyTids });
    combatId = await h.createCombat(page, [...npcTids, ...enemyTids]);

    // Two fireteams (5+5) — temporary memberships on the combatant flags.
    const teamOf = await page.evaluate(async (data) => {
        const combat = game.combats.get(data.combatId);
        const map = {};
        const npcCids = [];
        for (const [index, tid] of data.npcTids.entries()) {
            const combatant = combat.combatants.find((c) => c.tokenId === tid);
            const teamId = index < data.half ? 'alpha-perf' : 'beta-perf';
            await combatant.setFlag('only-war-ai', 'override', { mode: 'enabled', preset: 'assault' });
            await combatant.setFlag('only-war-ai', 'fireteam', { teamId });
            map[combatant.id] = teamId;
            npcCids.push(combatant.id);
        }
        return { map, npcCids };
    }, { combatId, npcTids, half: NPC_COUNT / 2 });
    npcTeamMap = teamOf.map;
    npcCombatantIds = teamOf.npcCids;
    console.log(`combat ${combatId}: ${NPC_COUNT} AI NPCs in teams alpha-perf/beta-perf + ${ENEMY_COUNT} enemies`);
}

let npcTeamMap = {};
let npcCombatantIds = [];

/** Install per-NPC counters: wrap planner/executor and count hooks. */
async function instrument() {
    await page.evaluate((combatIdArg) => {
        window.__owaiCombatId = combatIdArg;
        const api = game.modules.get('only-war-ai').api;
        const perf = window.__owaiPerf = {
            enabled: true,
            plans: [],
            runs: [],
            docUpdates: {
                createToken: 0, updateToken: 0, updateCombatant: 0,
                updateCombat: 0, updateActor: 0, updateItem: 0, createChatMessage: 0, total: 0
            },
            teamPlans: []
        };
        const planner = api.services.get('planner');
        const originalPlanTurn = planner.planTurn;
        planner.planTurn = async (combat, combatant, ctx = {}) => {
            const t0 = performance.now();
            const res = await originalPlanTurn.call(planner, combat, combatant, ctx);
            const ms = performance.now() - t0;
            if (perf.enabled) {
                const plan = res?.plan ?? null;
                const steps = Array.isArray(plan?.steps) ? plan.steps : [];
                perf.plans.push({
                    combatantId: combatant?.id ?? null,
                    ms: Math.round(ms * 100) / 100,
                    status: res?.status ?? null,
                    reason: res?.reason ?? null,
                    planId: plan?.id ?? null,
                    seed: plan?.seed ?? ctx?.seed ?? null,
                    replanCount: ctx?.replanCount ?? plan?.replanCount ?? 0,
                    candidatesCount: plan?.diagnostics?.candidatesCount ?? null,
                    movesEvaluated: plan?.diagnostics?.metrics?.movesEvaluated ?? null,
                    targetsEvaluated: plan?.diagnostics?.metrics?.targetsEvaluated ?? null,
                    pathNodes: steps
                        .filter((s) => s?.type === 'move')
                        .reduce((n, s) => n + (Array.isArray(s?.input?.waypoints) ? s.input.waypoints.length : 0), 0),
                    stepTypes: steps.map((s) => s?.type ?? null)
                });
            }
            return res;
        };
        const operations = api.services.get('operations');
        const originalClaim = operations.claimTurn;
        perf.claims = [];
        operations.claimTurn = async (combat, combatant, opts) => {
            const res = await originalClaim.call(operations, combat, combatant, opts);
            perf.claims.push({
                combatantId: combatant?.id ?? null,
                turn: combat?.turn ?? null,
                round: combat?.round ?? null,
                ok: res?.ok ?? null,
                reason: res?.reason ?? null,
                operationId: res?.operation?.id ?? null
            });
            return res;
        };
        const executor = api.services.get('executor');
        const originalRunPlan = executor.runPlan;
        executor.runPlan = async (context = {}) => {
            const updatesBefore = perf.docUpdates.total;
            const t0 = performance.now();
            const res = await originalRunPlan.call(executor, context);
            const ms = performance.now() - t0;
            if (perf.enabled) {
                perf.runs.push({
                    combatantId: context?.combatant?.id ?? context?.operation?.combatantId ?? null,
                    operationId: res?.operationId ?? context?.operation?.id ?? null,
                    planId: res?.planId ?? null,
                    ms: Math.round(ms * 100) / 100,
                    status: res?.status ?? null,
                    reason: res?.reason ?? null,
                    replanCount: res?.replanCount ?? 0,
                    stepsDone: res?.stepsDone?.length ?? 0,
                    chatCards: res?.chatMessageIds?.length ?? 0,
                    docUpdates: perf.docUpdates.total - updatesBefore
                });
            }
            return res;
        };
        const events = ['createToken', 'updateToken', 'updateCombatant', 'updateCombat',
            'updateActor', 'updateItem', 'createChatMessage'];
        for (const event of events) {
            Hooks.on(event, () => {
                perf.docUpdates[event] += 1;
                perf.docUpdates.total += 1;
            });
        }
        perf.nextTurnCalls = [];
        perf.combatUpdates = [];
        Hooks.on('updateCombat', (doc, change, options, userId) => {
            perf.combatUpdates.push({
                at: Date.now(), turn: doc?.turn ?? null,
                keys: Object.keys(change ?? {}).join(','),
                userId: userId ?? null
            });
        });
        perf.preCombatUpdates = [];
        Hooks.on('preUpdateCombat', (doc, change, options, userId) => {
            perf.preCombatUpdates.push({
                at: Date.now(), turn: change?.turn,
                round: change?.round,
                keys: Object.keys(change ?? {}).join(','),
                userId: userId ?? null
            });
        });
        const combat = game.combats.get(window.__owaiCombatId);
        if (combat && !combat.__owaiSpied) {
            combat.__owaiSpied = true;
            const original = combat.nextTurn.bind(combat);
            combat.nextTurn = async () => {
                const entry = { at: Date.now(), turn: combat.turn, ok: null, err: null };
                perf.nextTurnCalls.push(entry);
                try {
                    const out = await original();
                    entry.ok = true;
                    entry.after = { turn: combat.turn, round: combat.round };
                    return out;
                } catch (err) {
                    entry.ok = false;
                    entry.err = String(err?.message ?? err);
                    throw err;
                }
            };
        }
    }, combatId);
}

/** Build both TeamPlans and record timing + member planning results. */
async function buildTeamPlans() {
    return page.evaluate(async (data) => {
        const api = game.modules.get('only-war-ai').api;
        const fireteam = api.services.get('fireteam');
        const combat = game.combats.get(data.combatId);
        const perf = window.__owaiPerf;
        const out = [];
        for (const teamId of data.teams) {
            const t0 = performance.now();
            const result = await fireteam.buildTeamPlan(combat, { teamId }, { seed: 17 });
            const ms = performance.now() - t0;
            const entry = {
                teamId,
                ms: Math.round(ms * 100) / 100,
                status: result?.status ?? null,
                tactic: result?.teamPlan?.tactic ?? null,
                members: result?.teamPlan?.members?.length ?? 0,
                memberStatuses: result?.diagnostics?.memberStatuses ?? null
            };
            perf.teamPlans.push(entry);
            out.push(entry);
        }
        return out;
    }, { combatId, teams: TEAM_IDS });
}

/** Drive the combat until every AI combatant produced a terminal run. */
async function runCycle() {
    await page.evaluate((combatId) => game.combats.get(combatId).startCombat(), combatId);
    const start = Date.now();
    const deadline = start + CYCLE_TIMEOUT_MS;
    let lastTurn = null;
    let lastProgress = Date.now();
    let lastCount = 0;
    let lastCurrentId = null;
    const stallDumps = [];
    while (Date.now() < deadline) {
        const state = await page.evaluate(async (data) => {
            const perf = window.__owaiPerf;
            const combat = game.combats.get(data.combatId);
            const api = game.modules.get('only-war-ai').api;
            const authority = api.services.get('authority');
            // The live tab may be throttled: drain pending debounced claims
            // directly instead of relying on the scheduler timer.
            await authority?.flush?.();
            const current = combat?.combatant ?? null;
            let enabled = false;
            try {
                enabled = api.config.resolveEffectiveConfig(current)?.enabled === true;
            } catch (_err) { /* resolveConfig may fail for odd docs */ }
            const terminal = perf.runs.filter((run) =>
                ['completed', 'partial', 'failed', 'cancelled'].includes(run.status));
            const op = combat?.getFlag('only-war-ai', 'operation') ?? null;
            const opTerminal = op && ['completed', 'failed', 'cancelled'].includes(op.phase);
            // A stuck turn: the current combatant's operation is already
            // terminal for THIS turn index but the tracker did not advance.
            const stuckDone = !!(current && opTerminal
                && op.combatantId === current.id
                && op.turn === combat.turn
                && op.round === combat.round);
            return {
                turn: combat?.turn ?? null,
                round: combat?.round ?? null,
                currentId: current?.id ?? null,
                currentEnabled: enabled,
                stuckDone,
                runCount: perf.runs.length,
                terminalCount: terminal.length,
                combatantIds: [...new Set(terminal.map((r) => r.combatantId))],
                diag: {
                    operation: combat?.getFlag('only-war-ai', 'operation') ?? null,
                    nextTurnCalls: perf.nextTurnCalls,
                    combatUpdates: perf.combatUpdates?.slice(-15),
                    claims: perf.claims,
                    preCombatUpdates: perf.preCombatUpdates?.slice(-15),
                    turn: combat?.turn ?? null,
                    sourceTurn: combat?._source?.turn ?? null,
                    current: JSON.parse(JSON.stringify(combat?.current ?? null)),
                    turnIndex: combat?.turns?.findIndex((t) => t.id === current?.id),
                    currentId: current?.id ?? null,
                    currentName: current?.name ?? null,
                    authorityStatus: authority?.status?.() ?? null,
                    controllerId: authority?.controllerId ?? null,
                    isController: authority?.isController?.() ?? null,
                    claimedKeys: authority?.claimedKeys ?? [],
                    combatantConfig: api.config.resolveEffectiveConfig(current) ?? null
                }
            };
        }, { combatId });
        if (state.combatantIds.length >= NPC_COUNT || state.terminalCount >= NPC_COUNT) break;
        if (state.round >= 2) break;
        if (state.currentId !== lastCurrentId) {
            console.log(`  turn ${state.turn} -> combatant ${state.currentId} ai=${state.currentEnabled} runs=${state.terminalCount}`);
            lastCurrentId = state.currentId;
        }
        if (state.terminalCount !== lastCount) {
            lastCount = state.terminalCount;
            lastProgress = Date.now();
        } else if (Date.now() - lastProgress > 20_000) {
            stallDumps.push(JSON.parse(JSON.stringify(state.diag)));
            console.error(`[stall] ${JSON.stringify(state.diag)}`);
            lastProgress = Date.now();
        }
        // Manually advance turns that belong to non-AI combatants, plus
        // turns whose operation is already terminal but the tracker did not
        // advance on its own (live-sync stalls observed in this world).
        if (state.currentId && (!state.currentEnabled || state.stuckDone)) {
            await page.evaluate((cid) => game.combats.get(cid).nextTurn(), combatId);
            await page.waitForTimeout(300);
        }
        lastTurn = state.turn;
        await page.waitForTimeout(500);
    }
    return { elapsedMs: Date.now() - start, lastTurn, stallDumps };
}

/** Collect counters, write the JSON report, return the summary. */
async function collectReport(elapsedMs, teamPlans) {
    const perf = await page.evaluate(() => JSON.parse(JSON.stringify(window.__owaiPerf)));
    const report = {
        generatedAt: new Date().toISOString(),
        combatId,
        npcCount: NPC_COUNT,
        teams: TEAM_IDS,
        cycleMs: elapsedMs,
        totals: {
            docUpdates: perf.docUpdates,
            plans: perf.plans.length,
            runs: perf.runs.length,
            replans: perf.plans.filter((p) => (p.replanCount ?? 0) > 0).length
                + perf.runs.filter((r) => (r.replanCount ?? 0) > 0).length,
            chatCards: perf.runs.reduce((n, r) => n + (r.chatCards ?? 0), 0)
        },
        teamPlans: teamPlans.map((t) => ({ ...t })),
        npcs: npcCombatantIds.map((cid) => {
            const plans = perf.plans.filter((p) => p.combatantId === cid);
            const runs = perf.runs.filter((r) => r.combatantId === cid);
            const planningMs = plans.reduce((n, p) => n + (p.ms ?? 0), 0);
            const turnMs = runs.reduce((n, r) => n + (r.ms ?? 0), 0);
            return {
                combatantId: cid,
                teamId: npcTeamMap[cid] ?? null,
                planId: plans.at(-1)?.planId ?? null,
                operationId: runs.at(-1)?.operationId ?? null,
                seed: plans.at(-1)?.seed ?? null,
                status: runs.at(-1)?.status ?? (plans.at(-1)?.status ?? 'none'),
                reason: runs.at(-1)?.reason ?? plans.at(-1)?.reason ?? null,
                planningMs: Math.round(planningMs * 100) / 100,
                executionMs: Math.round((turnMs - planningMs) * 100) / 100,
                turnMs: Math.round(turnMs * 100) / 100,
                replanCount: Math.max(0, ...runs.map((r) => r.replanCount ?? 0)),
                candidatesCount: plans.at(-1)?.candidatesCount ?? null,
                movesEvaluated: plans.reduce((n, p) => n + (p.movesEvaluated ?? 0), 0),
                pathNodes: plans.reduce((n, p) => n + (p.pathNodes ?? 0), 0),
                stepsDone: runs.reduce((n, r) => n + (r.stepsDone ?? 0), 0),
                docUpdates: runs.reduce((n, r) => n + (r.docUpdates ?? 0), 0),
                stepTypes: plans.at(-1)?.stepTypes ?? []
            };
        }),
        allRuns: perf.runs,
        allPlans: perf.plans.map((p) => ({ ...p, stepTypes: undefined }))
    };
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const file = path.join(REPORT_DIR, `performance-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`machine-readable counters -> ${path.relative(process.cwd(), file)}`);
    return report;
}

function printFailureReport(report, why) {
    console.error(`\n=== PERFORMANCE FAILURE REPORT (${why}) ===`);
    console.error(`combat ${combatId} | ${NPC_COUNT} NPCs | teams ${TEAM_IDS.join(', ')}`);
    console.error('cid | team | plan | op | seed | status | reason | planMs | execMs | cands | nodes | updates | replans');
    for (const npc of report?.npcs ?? []) {
        console.error([
            npc.combatantId, npc.teamId, npc.planId, npc.operationId, npc.seed,
            npc.status, npc.reason ?? '-',
            npc.planningMs, npc.executionMs, npc.candidatesCount,
            npc.pathNodes, npc.docUpdates, npc.replanCount
        ].join(' | '));
    }
    if (report) {
        const file = path.join(REPORT_DIR, `performance-failure-${Date.now()}.md`);
        const lines = [
            `# Performance failure report (${why})`,
            '',
            `- combat: ${combatId}`,
            `- generated: ${new Date().toISOString()}`,
            '',
            '| combatant | team | planId | operationId | seed | status | reason | planning ms | execution ms | candidates | path nodes | doc updates | replans |',
            '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
            ...(report.npcs ?? []).map((n) =>
                `| ${n.combatantId} | ${n.teamId} | ${n.planId} | ${n.operationId} | ${n.seed} | ${n.status} | ${n.reason ?? ''} | ${n.planningMs} | ${n.executionMs} | ${n.candidatesCount} | ${n.pathNodes} | ${n.docUpdates} | ${n.replanCount} |`)
        ];
        fs.mkdirSync(REPORT_DIR, { recursive: true });
        fs.writeFileSync(file, `${lines.join('\n')}\n`);
        console.error(`failure report -> ${path.relative(process.cwd(), file)}`);
    }
}

async function cleanup() {
    try {
        if (previousMode !== undefined) {
            await page.evaluate(async (mode) => {
                await game.settings.set('only-war-ai', 'executionMode', mode);
            }, previousMode);
        }
    } catch { /* best-effort */ }
    await h.closeAllWindows(page);
    if (combatId) await h.deleteCombat(page, combatId);
    if (sceneId) await h.deleteScene(page, sceneId);
    for (const id of npcActorIds) await h.deleteActor(page, id);
    for (const id of enemyActorIds) await h.deleteActor(page, id);
}

(async () => {
    let failed = false;
    let report = null;
    try {
        await setup();
        previousMode = await page.evaluate(async () => {
            const mode = game.settings.get('only-war-ai', 'executionMode');
            await game.settings.set('only-war-ai', 'executionMode', 'automatic');
            return mode;
        });
        await instrument();
        const teamPlans = await buildTeamPlans();
        for (const entry of teamPlans) {
            assert.equal(entry.status, 'ok',
                `TeamPlan for ${entry.teamId} failed: ${entry.status}`);
            assert.equal(entry.members, NPC_COUNT / 2,
                `${entry.teamId} should have ${NPC_COUNT / 2} members`);
        }
        const { elapsedMs, stallDumps } = await runCycle();
        report = await collectReport(elapsedMs, teamPlans);
        if (stallDumps?.length) {
            console.error(`stall diagnostics (${stallDumps.length} dumps):`);
            for (const dump of stallDumps.slice(0, 3)) console.error(JSON.stringify(dump));
        }

        const ran = report.npcs.filter((n) => n.status && n.status !== 'none');
        assert.equal(ran.length, NPC_COUNT,
            `only ${ran.length}/${NPC_COUNT} NPCs completed a turn`);
        const badRuns = report.npcs.filter((n) => !['completed', 'partial'].includes(n.status));
        assert.equal(badRuns.length, 0,
            `NPCs with non-terminal turns: ${badRuns.map((n) => `${n.combatantId}:${n.status}:${n.reason}`).join(', ')}`);

        // Bounded resource use: no infinite hooks, no uncontrolled growth.
        for (const npc of report.npcs) {
            assert.ok((npc.candidatesCount ?? 0) <= 500,
                `unbounded candidate growth for ${npc.combatantId}: ${npc.candidatesCount}`);
            assert.ok(npc.planningMs <= 30_000,
                `planning took ${npc.planningMs}ms for ${npc.combatantId}`);
        }
        assert.ok(report.totals.docUpdates.total <= 3000,
            `document update storm: ${report.totals.docUpdates.total} updates`);
        console.log(`cycle completed in ${elapsedMs}ms | `
            + `doc updates=${report.totals.docUpdates.total} | `
            + `chat cards=${report.totals.chatCards} | replans=${report.totals.replans}`);
        for (const npc of report.npcs) {
            console.log(`  ${npc.combatantId} (${npc.teamId}): ${npc.status} `
                + `plan=${npc.planningMs}ms exec=${npc.executionMs}ms cands=${npc.candidatesCount} `
                + `nodes=${npc.pathNodes} updates=${npc.docUpdates} replans=${npc.replanCount}`);
        }
        console.log('performance.test.mjs PASSED');
    } catch (err) {
        failed = true;
        console.error('performance.test.mjs FAILED:', err);
        if (!report) {
            try { report = await collectReport(0, []); } catch { /* ignore */ }
        }
        printFailureReport(report, err?.message ?? 'unknown');
        try { await h.screenshot(page, 'performance-failure'); } catch { /* ignore */ }
    }
    await cleanup().catch(() => {});
    process.exit(failed ? 1 : 0);
})();
