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
let priorSceneId;
let previousSettings;

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

    priorSceneId = await page.evaluate(() => canvas.scene?.id);
    sceneId = await page.evaluate(async () => {
        const scene = await Scene.create({
            name: `AI performance ${Date.now()}`, active: false, navigation: false,
            width: 2000, height: 2000, padding: 0, tokenVision: false,
            grid: { type: 1, size: 100, distance: 1 }
        });
        await scene.view();
        return scene.id;
    });
    await page.waitForFunction(id => canvas.ready && canvas.scene?.id === id, sceneId);
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
    combatId = await page.evaluate(async (tokenIds) => {
        const combat = await Combat.create({ scene: canvas.scene.id, active: false });
        await combat.createEmbeddedDocuments('Combatant', tokenIds.map((tokenId, i) => ({
            tokenId, sceneId: canvas.scene.id, initiative: tokenIds.length - i
        })));
        combat.getTimeDelta = () => 0;
        return combat.id;
    }, [...npcTids, ...enemyTids]);

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
        const hookIds = [];
        const on = (event, fn) => hookIds.push([event, Hooks.on(event, fn)]);
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
            if (perf.enabled && combat?.id === combatIdArg) {
                const plan = res?.plan ?? null;
                const steps = Array.isArray(plan?.steps) ? plan.steps : [];
                perf.plans.push({
                    combatantId: combatant?.id ?? null,
                    operationId: ctx.operationId ?? ctx.operation?.id ?? null,
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
            if (combat?.id === combatIdArg) perf.claims.push({
                combatantId: combatant?.id ?? null, turn: combat?.turn ?? null,
                round: combat?.round ?? null, ok: res?.ok ?? null,
                reason: res?.reason ?? null, operationId: res?.operation?.id ?? null
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
            if (perf.enabled && context?.combat?.id === combatIdArg) {
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
            on(event, () => {
                perf.docUpdates[event] += 1;
                perf.docUpdates.total += 1;
            });
        }
        perf.nextTurnCalls = [];
        perf.combatUpdates = [];
        perf.trackerOrder = [];
        let lastPosition = null;
        on('updateCombat', (doc, change, options, userId) => {
            if (doc?.id !== combatIdArg) return;
            const position = `${doc.round}:${doc.turn}:${doc.combatant?.id}`;
            if (doc.started && position !== lastPosition) {
                perf.trackerOrder.push(doc.combatant?.id);
                lastPosition = position;
            }
            perf.combatUpdates.push({
                at: Date.now(), turn: doc?.turn ?? null,
                keys: Object.keys(change ?? {}).join(','),
                userId: userId ?? null
            });
        });
        perf.preCombatUpdates = [];
        on('preUpdateCombat', (doc, change, options, userId) => {
            if (doc?.id !== combatIdArg) return;
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
        window.__owaiPerfRestore = () => {
            perf.enabled = false;
            planner.planTurn = originalPlanTurn;
            operations.claimTurn = originalClaim;
            executor.runPlan = originalRunPlan;
            for (const [event, id] of hookIds) Hooks.off(event, id);
        };
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
            const current = combat?.combatant ?? null;
            let enabled = false;
            try {
                enabled = api.config.resolveEffectiveConfig(current)?.enabled === true;
            } catch (_err) { /* resolveConfig may fail for odd docs */ }
            const terminal = perf.runs.filter((run) =>
                ['completed', 'partial', 'failed', 'cancelled'].includes(run.status));
            const op = combat?.getFlag('only-war-ai', 'operation') ?? null;
            return {
                turn: combat?.turn ?? null,
                round: combat?.round ?? null,
                currentId: current?.id ?? null,
                currentEnabled: enabled,
                runCount: perf.runs.length,
                terminalCount: terminal.length,
                combatantIds: [...new Set(terminal.map((r) => r.combatantId))],
                diag: {
                    operation: op,
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
        if (state.currentId && !state.currentEnabled && state.round === 1 && state.turn === NPC_COUNT
            && state.combatantIds.length === NPC_COUNT) {
            return { elapsedMs: Date.now() - start, lastTurn: state.turn, stallDumps };
        }
        if (state.round > 1 || state.turn > NPC_COUNT) {
            throw new Error(`AI skipped the first manual turn: ${JSON.stringify(state.diag)}`);
        }
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
        lastTurn = state.turn;
        await page.waitForTimeout(500);
    }
    throw new Error(`Timed out at turn ${lastTurn} without auto-handoff: ${JSON.stringify(stallDumps.at(-1))}`);
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
            const opIds = new Set(runs.map(run => run.operationId).filter(Boolean));
            const planningMs = perf.plans.filter(plan => opIds.has(plan.operationId))
                .reduce((n, p) => n + (p.ms ?? 0), 0);
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
        trackerOrder: perf.trackerOrder,
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
        await page.evaluate(() => {
            window.__owaiPerfRestore?.();
            delete window.__owaiPerfRestore;
            delete window.__owaiPerf;
            delete window.__owaiCombatId;
        });
    } catch { /* best-effort */ }
    if (combatId) await h.deleteCombat(page, combatId);
    if (sceneId) await page.evaluate(async (id) => {
        const messages = game.messages.filter(message => message.speaker?.scene === id).map(message => message.id);
        if (messages.length) await ChatMessage.deleteDocuments(messages);
    }, sceneId);
    if (priorSceneId) await page.evaluate(id => game.scenes.get(id)?.view(), priorSceneId);
    if (sceneId) await h.deleteScene(page, sceneId);
    for (const id of npcActorIds) await h.deleteActor(page, id);
    for (const id of enemyActorIds) await h.deleteActor(page, id);
    if (previousSettings) await page.evaluate(async (settings) => {
        for (const [key, value] of Object.entries(settings)) await game.settings.set('only-war-ai', key, value);
    }, previousSettings);
}

(async () => {
    let failed = false;
    let report = null;
    try {
        await setup();
        previousSettings = await page.evaluate(async () => {
            // Landed attacks still go through the real system pipelines.
            // Use the ordinary damage-wait timeout to release them.
            const settings = { executionMode: 'automatic', attackAdjudication: 'auto',
                turnPacingMs: 0, damageWaitTimeoutSeconds: 1, damageWaitAutoAdvance: true,
                diagnosticsEnabled: false };
            const previous = {};
            for (const [key, value] of Object.entries(settings)) {
                previous[key] = game.settings.get('only-war-ai', key);
                await game.settings.set('only-war-ai', key, value);
            }
            return previous;
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
        assert.deepEqual(report.allRuns.map(run => run.combatantId).sort(), [...npcCombatantIds].sort(),
            'Every AI NPC must be called exactly once');
        assert.deepEqual(report.trackerOrder.slice(0, -1), npcCombatantIds,
            'Tracker must not skip, revisit or reorder any AI turn');
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
