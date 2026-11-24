/**
 * Reason trace (issue #27): the layered L0–L4 decision diagnostics
 * surface for the GM.
 *
 * The raw material is the chronological `{layer, code, detail}` reason
 * records of `plan.diagnostics.layers` (issue #24 contract) — every
 * layer already writes its verdicts there. This module renders the
 * trace on top:
 *
 * - {@link buildLayerTrace} — materializes the per-layer trace entries
 *   (`{layer, kind, ...}`) stored on `plan.diagnostics.trace`. One
 *   trace entry per reason record: the planner stamps the array at
 *   plan-assembly time so a serialized plan explains itself offline.
 * - {@link renderTrace} — localized display lines: the `compact` mode
 *   collapses every layer to its verdict line (grouped L0 vetoes, one
 *   merged L4 scoring line), `full` renders each reason record. The
 *   `aiTraceVerbose` world setting picks the mode; the preview "How it
 *   decided" block renders it.
 * - {@link compactTraceLine} — the single-line GM whisper summary of a
 *   stopped/cancelled turn ("commitment cancelled: gm-intervention;
 *   morale desperate; winner attack-in-place 0.41").
 * - Replay capture ({@link buildCaptureEntry}/
 *   {@link appendCaptureEntry}/{@link sanitizeCaptureContext}): when
 *   `aiCaptureContext` is on, the executor journals a bounded
 *   `planContext`+snapshot entry on the combatant `captureJournal`
 *   flag — a ready-made offline fixture: JSON in, `planTurn` out,
 *   identical plan and trace (seeded determinism).
 *
 * Everything here is pure: no `game`/`canvas` reads beyond an injected
 * or global i18n handle, no document writes, no state between calls.
 */
import {
    CAPTURE_JOURNAL_MAX,
    FLAG_KEYS,
    MODULE_ID,
    TRACE_TOP_FACTORS
} from "./constants.js";

/* ------------------------------------------------------------------ */
/* Trace entries                                                       */
/* ------------------------------------------------------------------ */

/** Trace entry kinds produced by {@link buildLayerTrace}. */
export const TRACE_ENTRY_KINDS = Object.freeze([
    "veto",
    "disabled",
    "commitment-hit",
    "commitment-miss",
    "commitment-cancelled",
    "morale",
    "morale-shift",
    "personality",
    "scored",
    "lookahead",
    "easy-slip",
    "winner",
    "record"
]);

/**
 * Map one `{layer, code, detail}` reason record to a trace entry
 * `{layer, kind, ...}` — a serializable projection holding exactly the
 * fields the render needs (reason details stay small by contract).
 * @param {object} record Reason record.
 * @returns {object|null}
 */
function _entryFor(record) {
    if (!record || typeof record !== "object") return null;
    const { layer, code } = record;
    if (typeof layer !== "string" || typeof code !== "string") return null;
    const detail = record.detail;
    const base = { layer, code };
    if (layer === "L0") {
        return {
            ...base,
            kind: "veto",
            candidate: typeof detail === "string"
                ? detail
                : (detail?.candidate ?? detail ?? null)
        };
    }
    if (layer === "L1") {
        if (code === "commitment-layer-disabled") return { ...base, kind: "disabled" };
        if (code === "commitment-miss") {
            return { ...base, kind: "commitment-miss", reason: detail?.reason ?? null };
        }
        if (code === "commitment-hit") {
            return {
                ...base,
                kind: "commitment-hit",
                source: detail?.source ?? null,
                steps: Number.isFinite(detail?.steps) ? detail.steps : null,
                selfMoved: detail?.selfMoved === true,
                gmAccepted: detail?.gmAccepted === true,
                reactive: detail?.reactive === true
            };
        }
        // Every other L1 record is an invalidator verdict.
        return {
            ...base,
            kind: "commitment-cancelled",
            detail: detail && typeof detail === "object" ? detail : null
        };
    }
    if (layer === "L2") {
        if (code === "morale-layer-disabled") return { ...base, kind: "disabled" };
        if (code === "morale-posture") {
            return {
                ...base,
                kind: "morale",
                tier: detail?.tier ?? null,
                effectiveTier: detail?.effectiveTier ?? null
            };
        }
        if (code === "morale-weight-shift") {
            return {
                ...base,
                kind: "morale-shift",
                tier: detail?.tier ?? null,
                effectiveTier: detail?.effectiveTier ?? null,
                deltas: detail?.deltas && typeof detail.deltas === "object"
                    ? { ...detail.deltas } : {}
            };
        }
    }
    if (layer === "L3") {
        if (code === "personality-layer-disabled") return { ...base, kind: "disabled" };
        if (code === "personality-overlay") {
            return {
                ...base,
                kind: "personality",
                traits: Array.isArray(detail?.traits) ? [...detail.traits] : [],
                character: detail?.character ?? null,
                deltas: detail?.deltas && typeof detail.deltas === "object"
                    ? { ...detail.deltas } : {},
                clamped: Array.isArray(detail?.clamped) ? [...detail.clamped] : []
            };
        }
    }
    if (layer === "L4") {
        if (code === "lookahead-layer-disabled") return { ...base, kind: "disabled" };
        if (code === "scored") {
            return {
                ...base,
                kind: "scored",
                candidates: Number.isFinite(detail?.candidates) ? detail.candidates : 0
            };
        }
        if (code === "lookahead") {
            return {
                ...base,
                kind: "lookahead",
                lambda: Number.isFinite(detail?.lambda) ? detail.lambda : null,
                topK: Number.isFinite(detail?.topK) ? detail.topK : null
            };
        }
        if (code === "easy-slip") {
            return {
                ...base,
                kind: "easy-slip",
                chance: Number.isFinite(detail?.chance) ? detail.chance : null,
                mistake: detail?.mistake === true
            };
        }
        if (code === "winner") {
            return {
                ...base,
                kind: "winner",
                candidate: detail?.candidate ?? null,
                score: Number.isFinite(detail?.score) ? detail.score : null,
                top: Array.isArray(detail?.top)
                    ? detail.top.map(entry => ({
                        candidate: entry?.candidate ?? null,
                        score: Number.isFinite(entry?.score) ? entry.score : null
                    }))
                    : [],
                runnerUp: detail?.runnerUp && typeof detail.runnerUp === "object"
                    ? {
                        candidate: detail.runnerUp.candidate ?? null,
                        score: Number.isFinite(detail.runnerUp.score)
                            ? detail.runnerUp.score : null
                    }
                    : null,
                margin: Number.isFinite(detail?.margin) ? detail.margin : null,
                factors: Array.isArray(detail?.factors)
                    ? detail.factors.map(entry => ({
                        factor: entry?.factor ?? null,
                        contribution: Number.isFinite(entry?.contribution)
                            ? entry.contribution : 0
                    }))
                    : []
            };
        }
    }
    // Unknown/future codes keep a generic record entry — the trace never
    // drops a reason silently.
    return { ...base, kind: "record", detail: detail ?? null };
}

/**
 * Materialize the trace entries of a plan diagnostics record: one
 * serializable `{layer, kind, ...}` entry per `diagnostics.layers`
 * reason record, in chronological order. Pure — safe to re-derive for
 * plans planned before issue #27.
 * @param {object|null} diagnostics Plan diagnostics record.
 * @returns {object[]}
 */
export function buildLayerTrace(diagnostics) {
    const layers = Array.isArray(diagnostics?.layers) ? diagnostics.layers : [];
    const entries = [];
    for (const record of layers) {
        const entry = _entryFor(record);
        if (entry) entries.push(entry);
    }
    return entries;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/**
 * Localize a key, treating an echoed-back key as "missing" (Foundry
 * returns the key for unknown entries).
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
 * Format a key with data; falls back when i18n is absent, the key is
 * unknown or the format call throws.
 * @param {object|null} i18n
 * @param {string} key
 * @param {object} data
 * @param {string} fallback
 * @returns {string}
 */
function _format(i18n, key, data, fallback) {
    try {
        const value = i18n?.format?.(key, data);
        if (typeof value === "string" && value && !value.startsWith(key)) return value;
    } catch(_err) {
        // Fall through to the fallback render.
    }
    return fallback;
}

/**
 * Localized label of a reason code (raw code fallback).
 * @param {object|null} i18n
 * @param {string|null} code
 * @returns {string}
 */
function _reasonLabel(i18n, code) {
    return _label(i18n, `OWAI.Trace.Reason.${code}`, code ?? "?");
}

/**
 * Localized label of a candidate variant.
 * @param {object|null} i18n
 * @param {string|null} variant
 * @returns {string}
 */
function _variantLabel(i18n, variant) {
    return _label(i18n, `OWAI.Trace.Variant.${variant}`, variant ?? "?");
}

/**
 * Localized label of a morale tier.
 * @param {object|null} i18n
 * @param {string|null} tier
 * @returns {string}
 */
function _tierLabel(i18n, tier) {
    return _label(i18n, `OWAI.Morale.${tier}`, tier ?? "—");
}

/**
 * Localized label of a scoring factor.
 * @param {object|null} i18n
 * @param {string|null} factor
 * @returns {string}
 */
function _factorLabel(i18n, factor) {
    return _label(i18n, `OWAI.Preview.Factor.${factor}`, factor ?? "?");
}

/**
 * Localized label of a personality trait.
 * @param {object|null} i18n
 * @param {string|null} trait
 * @returns {string}
 */
function _traitLabel(i18n, trait) {
    return _label(i18n, `OWAI.Personality.${trait}`, trait ?? "?");
}

/**
 * Short display name of a candidate id
 * (`attack-in-place|t1|stay|lasgun|0` → "Attack in place · lasgun").
 * @param {string|null} id
 * @param {object|null} i18n
 * @returns {string}
 */
export function formatCandidate(id, i18n = null) {
    if (typeof id !== "string" || !id) return "?";
    const [variant, , , action] = id.split("|");
    const label = _variantLabel(i18n, variant);
    return action && action !== "none" ? `${label} · ${action}` : label;
}

/**
 * Display number — two decimals, trailing zeros trimmed.
 * @param {number} value
 * @returns {string}
 */
function _num(value) {
    if (!Number.isFinite(value)) return "—";
    const rounded = Math.round(value * 100) / 100;
    return `${Object.is(rounded, -0) ? 0 : rounded}`;
}

/**
 * Signed display number (`+0.10` / `−0.03`, typographic minus).
 * @param {number} value
 * @returns {string}
 */
function _signed(value) {
    if (!Number.isFinite(value)) return "—";
    const rounded = Math.round(value * 100) / 100;
    if (rounded > 0) return `+${rounded}`;
    if (rounded < 0) return `−${Math.abs(rounded)}`;
    return "±0";
}

/**
 * Signed weight-delta list ("+cover, −charge") from a factor→delta map.
 * @param {object|null} i18n
 * @param {object} deltas
 * @returns {string}
 */
function _deltaList(i18n, deltas) {
    return Object.entries(deltas ?? {})
        .filter(([, delta]) => Number.isFinite(delta) && delta !== 0)
        .map(([factor, delta]) => `${delta > 0 ? "+" : "−"}${_factorLabel(i18n, factor)}`)
        .join(", ");
}

/**
 * Contribution list ("attackNow +0.10, exposure −0.03") from
 * `[{factor, contribution}]` entries.
 * @param {object|null} i18n
 * @param {object[]} factors
 * @returns {string}
 */
function _contributionList(i18n, factors) {
    return (Array.isArray(factors) ? factors : [])
        .map(entry => `${_factorLabel(i18n, entry?.factor)} ${_signed(entry?.contribution)}`)
        .join(", ");
}

/**
 * Veto list for the grouped L0 line ("pinned ×3, out-of-range").
 * @param {object|null} i18n
 * @param {Map<string, number>} counts Reason → count (insertion ordered).
 * @param {number} [max] How many entries before "+N more".
 * @returns {string}
 */
function _vetoList(i18n, counts, max = 4) {
    const parts = [];
    let rest = 0;
    for (const [code, count] of counts.entries()) {
        if (parts.length >= max) {
            rest += count;
            continue;
        }
        parts.push(count > 1
            ? `${_reasonLabel(i18n, code)} ×${count}`
            : _reasonLabel(i18n, code));
    }
    if (rest > 0) parts.push(`+${rest}`);
    return parts.join(", ");
}

/**
 * Count records by a key extractor, insertion-ordered.
 * @param {object[]} records
 * @param {Function} keyOf
 * @returns {Map<string, number>}
 */
function _countBy(records, keyOf) {
    const counts = new Map();
    for (const record of records) {
        const key = keyOf(record) ?? "unknown";
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
}

/**
 * Winner detail tail for the L4 scoring/winner lines:
 * "+0.09 vs hold — attackNow +0.10, exposure −0.03".
 * @param {object|null} i18n
 * @param {object} entry Winner trace entry.
 * @returns {string}
 */
function _winnerDetail(i18n, entry) {
    const parts = [];
    if (entry?.runnerUp && Number.isFinite(entry.margin)) {
        parts.push(_format(i18n, "OWAI.Trace.WinnerDelta", {
            margin: _signed(entry.margin),
            runnerUp: formatCandidate(entry.runnerUp.candidate, i18n)
        }, `${_signed(entry.margin)} vs ${formatCandidate(entry.runnerUp.candidate, i18n)}`));
    }
    const factors = _contributionList(i18n, entry?.factors);
    if (factors) parts.push(factors);
    return parts.length ? ` (${parts.join(": ")})` : "";
}

/**
 * Render one trace entry to a display line (`"L1: …"`).
 * @param {object} entry Trace entry ({@link buildLayerTrace}).
 * @param {object|null} i18n
 * @returns {string}
 */
function _renderEntry(entry, i18n) {
    const prefix = `${entry?.layer ?? "?"}: `;
    switch (entry?.kind) {
        case "veto":
            return `${prefix}${_format(i18n, "OWAI.Trace.VetoOne", {
                reason: _reasonLabel(i18n, entry.code),
                candidate: entry.candidate ?? "—"
            }, `veto ${_reasonLabel(i18n, entry.code)} — ${entry.candidate ?? "—"}`)}`;
        case "disabled":
            return `${prefix}${_reasonLabel(i18n, entry.code)}`;
        case "commitment-hit":
            return `${prefix}${_format(i18n, "OWAI.Trace.CommitmentHit", {
                steps: entry.steps ?? "—",
                source: entry.source ?? "commitment"
            }, `commitment valid → ${entry.steps ?? "?"} step(s) (${entry.source ?? "commitment"})`)}`;
        case "commitment-miss":
            return `${prefix}${_format(i18n, "OWAI.Trace.CommitmentMiss", {
                reason: _reasonLabel(i18n, entry.reason)
            }, `no commitment (${_reasonLabel(i18n, entry.reason)})`)}`;
        case "commitment-cancelled":
            return `${prefix}${_format(i18n, "OWAI.Trace.CommitmentCancelled", {
                reason: _reasonLabel(i18n, entry.code)
            }, `commitment cancelled: ${_reasonLabel(i18n, entry.code)}`)}`;
        case "morale": {
            const effective = entry.effectiveTier && entry.effectiveTier !== entry.tier
                ? ` → ${_tierLabel(i18n, entry.effectiveTier)}` : "";
            return `${prefix}${_format(i18n, "OWAI.Trace.Morale", {
                tier: _tierLabel(i18n, entry.tier),
                effective
            }, `morale ${_tierLabel(i18n, entry.tier)}${effective}`)}`;
        }
        case "morale-shift": {
            const factors = _deltaList(i18n, entry.deltas);
            return `${prefix}${_format(i18n, "OWAI.Trace.MoraleShift", {
                tier: _tierLabel(i18n, entry.effectiveTier ?? entry.tier),
                factors: factors || "—"
            }, `posture ${_tierLabel(i18n, entry.effectiveTier ?? entry.tier)} shifts ${factors || "—"}`)}`;
        }
        case "personality": {
            const traits = (entry.traits ?? [])
                .map(trait => _traitLabel(i18n, trait)).join(", ") || "—";
            const character = entry.character
                ? ` (${_label(i18n, `OWAI.FireteamCharacter.${entry.character}`, entry.character)})`
                : "";
            const factors = _deltaList(i18n, entry.deltas);
            return `${prefix}${_format(i18n, "OWAI.Trace.Personality", {
                traits: `${traits}${character}`,
                factors: factors ? ` ${factors}` : ""
            }, `${traits}${character}${factors ? ` ${factors}` : ""}`)}`;
        }
        case "scored":
            return `${prefix}${_format(i18n, "OWAI.Trace.Scored", {
                candidates: entry.candidates ?? 0
            }, `scored ${entry.candidates ?? 0} candidates`)}`;
        case "lookahead":
            return `${prefix}${_format(i18n, "OWAI.Trace.Lookahead", {
                topK: entry.topK ?? "—",
                lambda: entry.lambda ?? "—"
            }, `lookahead top-${entry.topK ?? "?"} λ=${entry.lambda ?? "?"}`)}`;
        case "easy-slip": {
            const result = _label(i18n,
                entry.mistake ? "OWAI.Trace.EasySlip.Mistake" : "OWAI.Trace.EasySlip.Held",
                entry.mistake ? "picked a lower score" : "held the best pick");
            return `${prefix}${_format(i18n, "OWAI.Trace.EasySlip.Result", {
                result,
                chance: entry.chance ?? "—"
            }, `easy slip: ${result} (p=${entry.chance ?? "?"})`)}`;
        }
        case "winner":
            return `${prefix}${_format(i18n, "OWAI.Trace.Winner", {
                candidate: formatCandidate(entry.candidate, i18n),
                score: _num(entry.score),
                detail: _winnerDetail(i18n, entry)
            }, `winner ${formatCandidate(entry.candidate, i18n)} — ${_num(entry.score)}${_winnerDetail(i18n, entry)}`)}`;
        default: {
            const detail = entry?.detail !== null && entry?.detail !== undefined
                ? ` ${JSON.stringify(entry.detail)}` : "";
            return `${prefix}${entry?.code ?? "?"}${detail}`;
        }
    }
}

/**
 * Compact-mode line for the L0 layer: one grouped veto line over the
 * per-candidate entries ("L0: veto pinned ×3, out-of-range").
 * @param {object[]} vetoes L0 veto entries.
 * @param {object|null} i18n
 * @returns {string}
 */
function _renderVetoGroup(vetoes, i18n) {
    const list = _vetoList(i18n, _countBy(vetoes, entry => entry.code));
    return `L0: ${_format(i18n, "OWAI.Trace.Veto", { list }, `veto ${list}`)}`;
}

/**
 * Compact-mode line for the L4 layer: one merged scoring line —
 * "L4: scoring 12 → attack-in-place 0.41 (+0.09 vs hold: attackNow
 * +0.10)" — with an easy-slip note appended when the slip fired.
 * @param {object[]} entries L4 trace entries.
 * @param {object|null} i18n
 * @returns {string|null}
 */
function _renderScoringLine(entries, i18n) {
    const winner = entries.find(entry => entry.kind === "winner");
    const scored = entries.find(entry => entry.kind === "scored");
    const slip = entries.find(entry => entry.kind === "easy-slip");
    if (!winner && !scored) return null;
    const top = Array.isArray(winner?.top) && winner.top.length
        ? winner.top.map(entry =>
            `${formatCandidate(entry.candidate, i18n)} ${_num(entry.score)}`).join(", ")
        : null;
    const detail = winner ? _winnerDetail(i18n, winner) : "";
    let line = `L4: ${_format(i18n, "OWAI.Trace.Scoring", {
        candidates: scored?.candidates ?? 0,
        top: top ? ` [${top}]` : "",
        winner: formatCandidate(winner?.candidate, i18n),
        score: _num(winner?.score),
        detail
    }, `scoring ${scored?.candidates ?? 0} → ${formatCandidate(winner?.candidate, i18n)} ${_num(winner?.score)}${detail}`)}`;
    if (slip?.mistake === true) {
        line += _format(i18n, "OWAI.Trace.ScoringSlip", {}, " (easy slip)");
    }
    return line;
}

/**
 * Render trace entries to display lines (issue #27).
 *
 * - `compact` (default): every layer collapses to its verdict line —
 *   grouped L0 vetoes, one line per L1–L3 record, one merged L4
 *   scoring line (top-3 ranking, winner margin and the decisive
 *   factor contributions).
 * - `full`: each recorded reason record renders as its own line —
 *   per-candidate L0 vetoes plus the `scored`/`lookahead`/`easy-slip`/
 *   `winner` granularity.
 * @param {object[]|object} entries Trace entries ({@link buildLayerTrace})
 *   or a diagnostics record carrying `trace`/`layers`.
 * @param {object} [options]
 * @param {object|null} [options.i18n] `game.i18n`-compatible object.
 * @param {string} [options.mode] `"compact" | "full"` (default compact).
 * @returns {string[]} Display lines.
 */
export function renderTrace(entries, { i18n = null, mode = "compact" } = {}) {
    const list = Array.isArray(entries) ? entries
        : (Array.isArray(entries?.trace) ? entries.trace : buildLayerTrace(entries));
    const source = i18n ?? globalThis.game?.i18n ?? null;
    if (mode === "full") {
        return list.map(entry => _renderEntry(entry, source));
    }
    const lines = [];
    for (let i = 0; i < list.length; i++) {
        const entry = list[i];
        if (entry?.kind === "veto") {
            // Collapse the whole run of L0 vetoes into one grouped line.
            if (lines.some(line => line.startsWith("L0:"))) continue;
            const vetoes = list.filter(other => other?.kind === "veto");
            lines.push(_renderVetoGroup(vetoes, source));
            continue;
        }
        if (entry?.layer === "L4") {
            if (lines.some(line => line.startsWith("L4:"))) continue;
            const line = _renderScoringLine(
                list.filter(other => other?.layer === "L4"), source);
            if (line) lines.push(line);
            continue;
        }
        lines.push(_renderEntry(entry, source));
    }
    return lines;
}

/* ------------------------------------------------------------------ */
/* Compact one-liner (GM whisper)                                      */
/* ------------------------------------------------------------------ */

/**
 * Single-line trace summary for a GM whisper (issue #27): the
 * verdict-shaped digest of a stopped or cancelled turn — e.g.
 * "commitment cancelled: gm-intervention; morale desperate; winner
 * attack-in-place 0.41". Layer fragments are emitted in funnel order;
 * layers without a verdict are skipped. `null` when nothing was
 * recorded (early gate vetoes carry no diagnostics).
 * @param {object|null} diagnostics Plan diagnostics record (or a plan).
 * @param {object|null} [i18n]
 * @returns {string|null}
 */
export function compactTraceLine(diagnostics, i18n = null) {
    const source = i18n ?? globalThis.game?.i18n ?? null;
    const layers = Array.isArray(diagnostics?.layers)
        ? diagnostics.layers
        : (Array.isArray(diagnostics?.diagnostics?.layers)
            ? diagnostics.diagnostics.layers : []);
    if (!layers.length) return null;
    const parts = [];
    const vetoes = layers.filter(record => record?.layer === "L0");
    if (vetoes.length) {
        const list = _vetoList(source, _countBy(vetoes, r => r.code), 3);
        parts.push(_format(source, "OWAI.Trace.Compact.Veto", { list }, `veto ${list}`));
    }
    const l1 = [...layers].reverse().find(record => record?.layer === "L1");
    if (l1 && l1.code !== "commitment-layer-disabled"
        && l1.code !== "commitment-miss") {
        if (l1.code === "commitment-hit") {
            parts.push(_format(source, "OWAI.Trace.Compact.Commitment", {
                source: l1.detail?.source ?? "commitment"
            }, `commitment ${l1.detail?.source ?? ""}`.trim()));
        } else {
            parts.push(_format(source, "OWAI.Trace.Compact.Cancelled", {
                reason: _reasonLabel(source, l1.code)
            }, `cancelled: ${_reasonLabel(source, l1.code)}`));
        }
    }
    const l2 = [...layers].reverse()
        .find(record => record?.layer === "L2" && record.code === "morale-posture");
    if (l2) {
        const effective = l2.detail?.effectiveTier
            && l2.detail.effectiveTier !== l2.detail.tier
            ? `→${_tierLabel(source, l2.detail.effectiveTier)}` : "";
        parts.push(_format(source, "OWAI.Trace.Compact.Morale", {
            tier: _tierLabel(source, l2.detail?.tier),
            effective
        }, `morale ${_tierLabel(source, l2.detail?.tier)}${effective}`));
    }
    const l3 = [...layers].reverse()
        .find(record => record?.layer === "L3" && record.code === "personality-overlay");
    const traits = Array.isArray(l3?.detail?.traits) ? l3.detail.traits : [];
    if (traits.length) {
        const names = traits.map(trait => _traitLabel(source, trait)).join(", ");
        parts.push(_format(source, "OWAI.Trace.Compact.Traits", { traits: names }, names));
    }
    const l4 = [...layers].reverse()
        .find(record => record?.layer === "L4" && record.code === "winner");
    if (l4) {
        const detail = l4.detail ?? {};
        const delta = detail.runnerUp && Number.isFinite(detail.margin)
            ? ` ${_signed(detail.margin)} vs ${formatCandidate(detail.runnerUp.candidate, source)}`
            : "";
        parts.push(_format(source, "OWAI.Trace.Compact.Winner", {
            candidate: formatCandidate(detail.candidate, source),
            score: _num(detail.score),
            delta
        }, `winner ${formatCandidate(detail.candidate, source)} ${_num(detail.score)}${delta}`));
    }
    return parts.length ? parts.join("; ") : null;
}

/* ------------------------------------------------------------------ */
/* Per-factor explainability (L4 winner detail)                        */
/* ------------------------------------------------------------------ */

/**
 * Per-factor `weight × factor` contribution map of a scored candidate.
 * The `evaluateFactors` breakdown carries `contributions` verbatim;
 * custom preset evaluators record only `factors` — contributions are
 * then derived against the effective weights.
 * @param {object|null} entry Scored candidate (`{factors, breakdown}`).
 * @param {object} weights Effective scoring weights.
 * @returns {object} `factor → contribution`.
 */
function _contributionsOf(entry, weights) {
    const fromBreakdown = entry?.breakdown?.contributions;
    if (fromBreakdown && typeof fromBreakdown === "object") return fromBreakdown;
    const factors = entry?.factors ?? entry?.breakdown?.factors ?? {};
    const out = {};
    for (const [key, weight] of Object.entries(weights ?? {})) {
        if (!Number.isFinite(weight) || weight === 0) continue;
        const value = (Number.isFinite(factors[key]) ? factors[key] : 0) * weight;
        if (value !== 0) out[key] = (Math.round(value * 1e4) / 1e4) + 0;
    }
    return out;
}

/**
 * Explainability payload of the L4 winner (issue #27): the per-factor
 * contribution *difference* between the winner and the runner-up —
 * `winnerFactor − runnerFactor` per `w × f` — cut to the
 * {@link TRACE_TOP_FACTORS} most decisive entries by |delta|. A null
 * runner-up reports the winner's own top contributions.
 * @param {object} winner Scored winner entry.
 * @param {object|null} runnerUp Next-best scored entry.
 * @param {object} weights Effective scoring weights.
 * @param {number} [max] Cap on returned factors.
 * @returns {Array<{factor: string, contribution: number}>}
 */
export function factorDelta(winner, runnerUp, weights = {}, max = TRACE_TOP_FACTORS) {
    const cw = _contributionsOf(winner, weights);
    const cr = runnerUp ? _contributionsOf(runnerUp, weights) : {};
    const keys = new Set([...Object.keys(cw), ...Object.keys(cr)]);
    const deltas = [];
    for (const key of keys) {
        const delta = Math.round(((cw[key] ?? 0) - (cr[key] ?? 0)) * 1e4) / 1e4;
        if (delta !== 0) deltas.push({ factor: key, contribution: delta + 0 });
    }
    deltas.sort((a, b) => (Math.abs(b.contribution) - Math.abs(a.contribution))
        || a.factor.localeCompare(b.factor));
    return deltas.slice(0, Math.max(1, max));
}

/* ------------------------------------------------------------------ */
/* Replay capture (issue #27)                                          */
/* ------------------------------------------------------------------ */

/**
 * `planContext` keys captured for replay: every plain-data override a
 * `planTurn` run reads. Documents, services and probe functions are
 * never captured — a capture must stay JSON-serializable and document-
 * free by construction.
 */
export const CAPTURE_CONTEXT_KEYS = Object.freeze([
    "seed",
    "replanCount",
    "targets",
    "actions",
    "moves",
    "approximateMoves",
    "moveBudget",
    "actionBudget",
    "rates",
    "halfMove",
    "spent",
    "selfStatuses",
    "difficulty",
    "personality",
    "team",
    "morale",
    "commitment",
    "commitmentTtl",
    "layers",
    "lookahead",
    "easyMistakeChance",
    "maxTargets",
    "maxActions",
    "includeNeutral",
    "dispositions",
    "preferredWeapon",
    "lastUsedWeapon",
    "lastAttacker",
    "reactionUsed",
    "carriedAim",
    "defaultDodgeTN",
    "threats",
    "threatMap",
    "collisionRevision",
    "interventionThreshold",
    "threatTolerance",
    "positionTolerance",
    "moveTolerancePx",
    "manualOverrideGrace",
    "moraleOutnumberRatio",
    "orderBoost",
    "barks",
    "capture"
]);

/**
 * Combatant flag keys captured into a replay entry: the AI-state reads
 * `planTurn` performs against the combatant (morale record, commitment
 * record/journal, weapon/grudge/reaction bookkeeping, personality
 * list, fireteam, order/delay bookkeeping).
 */
export const CAPTURE_FLAG_KEYS = Object.freeze([
    FLAG_KEYS.morale,
    FLAG_KEYS.committedPlan,
    FLAG_KEYS.moveJournal,
    FLAG_KEYS.gmControlled,
    FLAG_KEYS.lastUsedWeapon,
    FLAG_KEYS.lastAttacker,
    FLAG_KEYS.reactionUsed,
    FLAG_KEYS.aim,
    FLAG_KEYS.personality,
    FLAG_KEYS.fireteam,
    FLAG_KEYS.lastOrder,
    FLAG_KEYS.delaySync
]);

/**
 * JSON-clone helper: returns `undefined` for values that cannot round-
 * trip (functions, circular structures, `undefined` itself) — capture
 * fields simply drop out instead of breaking the journal.
 * @param {*} value
 * @returns {*}
 */
function _jsonCloneSafe(value) {
    if (value === undefined || typeof value === "function") return undefined;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch(_err) {
        return undefined;
    }
}

/**
 * Serializable `planContext` slice for a capture entry: whitelisted
 * plain-data keys only, each JSON round-tripped — services, probe
 * functions and Document references never survive the filter.
 * @param {object} [context] The `planContext` handed to `planTurn`.
 * @returns {object}
 */
export function sanitizeCaptureContext(context = {}) {
    const out = {};
    for (const key of CAPTURE_CONTEXT_KEYS) {
        const value = context?.[key];
        if (value === undefined) continue;
        const cloned = _jsonCloneSafe(value);
        if (cloned !== undefined) out[key] = cloned;
    }
    return out;
}

/**
 * Read one module flag via `getFlag` with a raw `flags` fallback.
 * @param {object|null} doc
 * @param {string} key
 * @returns {*}
 */
function _readFlag(doc, key) {
    if (typeof doc?.getFlag === "function") {
        try {
            return doc.getFlag(MODULE_ID, key);
        } catch(_err) {
            // Fall through to the raw flags read.
        }
    }
    return doc?.flags?.[MODULE_ID]?.[key];
}

/**
 * The AI-state flag reads `planTurn` performs against the combatant —
 * captured verbatim so the replay resolves identical inputs.
 * @param {object|null} combatant
 * @returns {object}
 */
function _captureFlags(combatant) {
    const flags = {};
    for (const key of CAPTURE_FLAG_KEYS) {
        const value = _jsonCloneSafe(_readFlag(combatant, key));
        if (value !== undefined) flags[key] = value;
    }
    return flags;
}

/**
 * Build a replay-capture entry (issue #27): the sanitized
 * `planContext`, the AI flag reads, the effective config, the finalized
 * plan snapshot and a compact result fingerprint (winner, steps, trace)
 * a replay test can diff against. Fully JSON-serializable by
 * construction.
 * @param {object} input
 * @param {object|null} input.combat Live combat document.
 * @param {object|null} input.combatant Active combatant document.
 * @param {object} input.context The `planContext` handed to `planTurn`.
 * @param {object|null} input.plan The produced plan.
 * @param {object|null} [input.config] Resolved effective config.
 * @param {string|null} [input.operationId] Owning operation id.
 * @returns {object} Capture entry.
 */
export function buildCaptureEntry({ combat = null, combatant = null,
    context = {}, plan = null, config = null, operationId = null } = {}) {
    const winner = (Array.isArray(plan?.diagnostics?.layers)
        ? plan.diagnostics.layers : [])
        .find(record => record?.layer === "L4" && record.code === "winner");
    return {
        version: 1,
        at: {
            combatId: combat?.id ?? null,
            combatantId: combatant?.id ?? null,
            round: Number.isFinite(combat?.round) ? combat.round : 0,
            turn: Number.isFinite(combat?.turn) ? combat.turn : 0,
            operationId: operationId ?? null
        },
        preset: plan?.preset ?? config?.preset ?? null,
        config: config
            ? {
                enabled: config.enabled === true,
                preset: config.preset ?? null,
                ...(config.includeNeutral === true ? { includeNeutral: true } : {}),
                ...(Array.isArray(config.personality) && config.personality.length
                    ? { personality: [...config.personality] } : {})
            }
            : null,
        flags: _captureFlags(combatant),
        context: sanitizeCaptureContext(context),
        snapshot: _jsonCloneSafe(plan?.snapshot) ?? null,
        result: {
            planId: plan?.id ?? null,
            score: Number.isFinite(plan?.score) ? plan.score : null,
            winner: winner?.detail?.candidate ?? null,
            steps: _jsonCloneSafe(plan?.steps) ?? [],
            trace: _jsonCloneSafe(plan?.diagnostics?.trace) ?? []
        }
    };
}

/**
 * Normalize a stored `captureJournal` flag value: an array of capture
 * objects, bounded at {@link CAPTURE_JOURNAL_MAX} (most recent last).
 * @param {*} raw Raw flag payload.
 * @param {number} [max] Bound override.
 * @returns {object[]}
 */
export function sanitizeCaptureJournal(raw, max = CAPTURE_JOURNAL_MAX) {
    const entries = (Array.isArray(raw) ? raw : [])
        .filter(entry => entry && typeof entry === "object"
            && entry.context && typeof entry.context === "object");
    return entries.slice(-Math.max(1, max));
}

/**
 * Pure journal append: returns a new bounded capture journal with the
 * entry appended (most recent last).
 * @param {object[]|*} journal Existing journal.
 * @param {object} entry Capture entry ({@link buildCaptureEntry}).
 * @param {number} [max] Bound override.
 * @returns {object[]}
 */
export function appendCaptureEntry(journal, entry, max = CAPTURE_JOURNAL_MAX) {
    const next = sanitizeCaptureJournal(journal, max);
    const clean = _jsonCloneSafe(entry);
    // Entries without a context are not captures — they never join.
    return clean ? sanitizeCaptureJournal([...next, clean], max) : next;
}
