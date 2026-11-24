/**
 * Replay helpers (issue #27): rebuild a deterministic `planTurn` run
 * from a capture-journal entry — the `captureJournal` combatant flag
 * payload the executor writes when `aiCaptureContext` is on, or a
 * hand-built fixture of the same shape.
 *
 * A capture entry is fully self-contained: the sanitized `planContext`
 * (targets/actions/moves/seed, no Documents), the AI-state flag reads,
 * the effective config and the finalized planning snapshot. Replaying
 * it runs `planTurn` against reconstructed document mocks and produces
 * the identical plan and trace — "context JSON → planTurn → plan" with
 * no Foundry dependencies.
 */
import { FLAG_KEYS, MODULE_ID } from "../../scripts/constants.js";
import { createPlannerService } from "../../scripts/planner.js";

let _replayId = 0;

/** Flag-capable document mock (mirrors the fixture documents). */
function _doc(documentName, data = {}) {
    const doc = {
        documentName,
        id: data.id ?? `replay-${documentName.toLowerCase()}-${++_replayId}`,
        name: data.name ?? `Replay ${documentName}`,
        flags: JSON.parse(JSON.stringify(data.flags ?? {})),
        ...data.extra
    };
    doc.getFlag = (scope, key) => doc.flags?.[scope]?.[key];
    doc.setFlag = async (scope, key, value) => {
        doc.flags[scope] = doc.flags[scope] ?? {};
        doc.flags[scope][key] = value;
        return doc;
    };
    doc.unsetFlag = async (scope, key) => {
        if (doc.flags?.[scope]) delete doc.flags[scope][key];
        return doc;
    };
    return doc;
}

/**
 * Replay a captured planning context offline.
 * @param {object|string} capture Capture entry (or its JSON form) — the
 *   `{version, at, preset, config, flags, context, snapshot, result}`
 *   payload {@link buildCaptureEntry} produces.
 * @param {object} [options]
 * @param {object} [options.planner] Planner service override.
 * @returns {Promise<{result: object, combat: object, combatant: object,
 *   entry: object}>} The `planTurn` result plus the rebuilt mocks.
 */
export async function replayPlan(capture, { planner = null } = {}) {
    const entry = typeof capture === "string" ? JSON.parse(capture) : capture;
    if (!entry || typeof entry !== "object") {
        throw new Error("replayPlan expects a capture entry object or JSON string");
    }
    const snapshot = entry.snapshot ?? {};
    const self = snapshot.self ?? {};
    const capturedFlags = entry.flags ?? {};
    const context = entry.context ?? {};

    const scene = {
        documentName: "Scene",
        id: snapshot.scene?.id ?? `replay-scene-${++_replayId}`,
        grid: {
            type: snapshot.scene?.grid?.type ?? 1,
            size: snapshot.scene?.grid?.size ?? 100,
            distance: snapshot.scene?.grid?.distance ?? 1.5,
            units: "m"
        }
    };

    // The captured effective config restores as the actor-level config —
    // the same resolution layer the planner read at capture time.
    const config = entry.config ?? {};
    // Item summaries captured on the snapshot restore as the actor's
    // items — the action normalization enriches class/range/damage/
    // blast/spray/clip from `actor.items`, so a replay needs the same
    // weapon data or the `ev`/template factors diverge (issue #54).
    const items = (Array.isArray(self.items) ? self.items : [])
        .map(item => ({
            id: item.id ?? null,
            uuid: item.uuid ?? null,
            name: item.name ?? null,
            type: item.type ?? null,
            system: {
                class: item.class ?? null,
                range: item.range ?? null,
                clip: item.ammo != null ? { value: item.ammo } : undefined,
                damage: item.damage ?? null,
                blastRadius: item.blastRadius ?? null,
                special: item.special ?? null,
                rateOfFire: item.rateOfFire ?? null
            }
        }));
    const actor = _doc("Actor", {
        id: self.actorId ?? `replay-actor-${++_replayId}`,
        flags: {
            [MODULE_ID]: {
                [FLAG_KEYS.actorConfig]: {
                    enabled: true,
                    preset: config.preset ?? entry.preset ?? "hold",
                    includeNeutral: config.includeNeutral === true,
                    ...(config.preferredWeapon
                        ? { preferredWeapon: config.preferredWeapon } : {})
                }
            }
        },
        extra: { type: "npc", system: {}, items }
    });

    const token = _doc("Token", {
        id: self.tokenId ?? `replay-token-${++_replayId}`,
        extra: {
            x: self.x ?? 0,
            y: self.y ?? 0,
            elevation: self.elevation ?? 0,
            hidden: self.hidden === true,
            disposition: self.disposition ?? 0,
            actor
        }
    });

    // The captured AI-state flags restore verbatim on the combatant —
    // every flag read `planTurn` performs resolves identically.
    const combatant = _doc("Combatant", {
        id: snapshot.combatantId ?? `replay-combatant-${++_replayId}`,
        flags: { [MODULE_ID]: JSON.parse(JSON.stringify(capturedFlags)) },
        extra: {
            tokenId: token.id,
            token,
            actor,
            defeated: self.defeated === true,
            initiative: self.initiative ?? 0
        }
    });

    const combatants = new Map([[combatant.id, combatant]]);
    combatants.contents = [combatant];
    const combat = {
        documentName: "Combat",
        id: snapshot.combatId ?? `replay-combat-${++_replayId}`,
        round: snapshot.round ?? 1,
        turn: snapshot.turn ?? 0,
        scene,
        ended: false,
        combatants,
        turns: [combatant],
        get combatant() {
            return this.turns[this.turn] ?? null;
        }
    };

    const service = planner ?? createPlannerService();
    const result = await service.planTurn(combat, combatant, context);
    return { result, combat, combatant, entry };
}
