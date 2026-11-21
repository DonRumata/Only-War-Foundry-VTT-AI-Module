/**
 * Public module API published as `game.modules.get("only-war-ai").api`
 * (issue #399).
 *
 * The API object is created on `init` so other modules and macros can rely on
 * it before `ready`. Activation status lives in `_state` and is flipped by the
 * `ready`-hook compatibility check.
 */
import {
    AI_PRESETS,
    ATTACK_ADJUDICATION_MODES,
    EXECUTION_MODES,
    FIRETEAM_CHARACTERS,
    MODULE_API_VERSION,
    OVERRIDE_MODES
} from "./constants.js";
import { resolveEffectiveConfig } from "./config-resolver.js";
import { PERSONALITY_IDS } from "./personalities.js";
import { createServiceRegistry } from "./services.js";

/**
 * Build the public module API object.
 * @returns {object} API contract for `game.modules.get("only-war-ai").api`.
 */
export function createModuleApi() {
    const state = {
        // Flipped by the `ready` hook after the system compatibility check.
        enabled: false,
        incompatibleReason: null
    };

    const services = createServiceRegistry();

    return {
        /** Module API contract version ("major.minor"). */
        version: MODULE_API_VERSION,

        /** Capability discovery map, mirrors the system API style. */
        capabilities: Object.freeze({
            "authority.election": true,
            "authority.socket": true,
            "config.resolveEffectiveConfig": true,
            "executor.adjudication": true,
            "executor.executePlan": true,
            "executor.runPlan": true,
            "fireteam.buildTeamPlan": true,
            "fireteam.electLeader": true,
            "fireteam.validateTeamPlan": true,
            "navigation.planRoute": true,
            "navigation.canReach": true,
            "navigation.findCandidates": true,
            "navigation.movementBudget": true,
            "operations.lifecycle": true,
            "perception.snapshot": true,
            "perception.memory": true,
            "perception.targets": true,
            "planner.freeActions": true,
            "planner.personalities": true,
            "planner.planTurn": true,
            "planner.presets": true,
            "planner.validateSnapshot": true,
            "reactions.flags": true,
            "services.register": true,
            "services.get": true,
            "ui.npcSheet": true,
            "ui.tokenConfig": true,
            "ui.combatTracker": true,
            "ui.preview": true
        }),

        /** Fixed AI presets and override modes exposed to consumers. */
        presets: Object.freeze([...AI_PRESETS]),
        overrideModes: Object.freeze([...OVERRIDE_MODES]),
        executionModes: Object.freeze([...EXECUTION_MODES]),
        /** Attack adjudication modes (issue #37, `attackAdjudication` setting). */
        attackAdjudicationModes: Object.freeze([...ATTACK_ADJUDICATION_MODES]),
        /** Bot personality trait ids and fireteam characters (issue #19). */
        personalities: Object.freeze([...PERSONALITY_IDS]),
        fireteamCharacters: Object.freeze([...FIRETEAM_CHARACTERS]),

        /** Configuration helpers. */
        config: Object.freeze({
            resolveEffectiveConfig
        }),

        /** Planner/executor service registry for follow-up subtasks. */
        services,

        /**
         * Whether a capability key is supported.
         * @param {string} name
         * @returns {boolean}
         */
        hasCapability(name) {
            return this.capabilities[name] === true;
        },

        /**
         * Whether the module passed the system compatibility check and is
         * allowed to run AI logic this session.
         * @returns {boolean}
         */
        get enabled() {
            return state.enabled;
        },

        /**
         * Reason the module stayed disabled ("wrong-system", "api-missing",
         * "version-mismatch") or null when compatible.
         * @returns {string|null}
         */
        get incompatibleReason() {
            return state.incompatibleReason;
        },

        /** Internal mutable state, do not rely on it from outside. */
        _state: state
    };
}
