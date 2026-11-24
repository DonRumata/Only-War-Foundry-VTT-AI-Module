/**
 * Unit matrix for the pure effective-config resolver (issue #399).
 *
 * Covers the full Combatant → Token → Actor precedence chain, unknown/damaged
 * flag normalisation, deleted documents and read-only behaviour.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    isAiEnabled,
    resolveEffectiveConfig
} from "../../scripts/config-resolver.js";
import { MODULE_ID } from "../../scripts/constants.js";
import {
    freezeDeep,
    makeActor,
    makeCombatant,
    makeToken
} from "./fixtures.mjs";

const DISABLED = { enabled: false, preset: null, source: "none" };

test("no document resolves to disabled", () => {
    assert.deepEqual(resolveEffectiveConfig(null), DISABLED);
    assert.deepEqual(resolveEffectiveConfig(undefined), DISABLED);
    assert.deepEqual(resolveEffectiveConfig("not-a-doc"), DISABLED);
});

test("actor without flags resolves to disabled (no implicit opt-in)", () => {
    assert.deepEqual(resolveEffectiveConfig(makeActor()), DISABLED);
});

test("actor enabled with known preset resolves to that preset", () => {
    const actor = makeActor({ enabled: true, preset: "assault" });
    assert.deepEqual(resolveEffectiveConfig(actor), {
        enabled: true, preset: "assault", source: "actor"
    });
});

for (const preset of ["assault", "rangedCover", "hold", "specOps"]) {
    test(`actor enabled preset ${preset} resolves correctly`, () => {
        const result = resolveEffectiveConfig(makeActor({ enabled: true, preset }));
        assert.equal(result.enabled, true);
        assert.equal(result.preset, preset);
    });
}

test("actor enabled with unknown preset falls back to hold", () => {
    const actor = makeActor({ enabled: true, preset: "bogus-preset" });
    assert.deepEqual(resolveEffectiveConfig(actor), {
        enabled: true, preset: "hold", source: "actor"
    });
});

test("actor enabled without preset falls back to hold", () => {
    const actor = makeActor({ enabled: true });
    assert.deepEqual(resolveEffectiveConfig(actor), {
        enabled: true, preset: "hold", source: "actor"
    });
});

test("actor enabled:false resolves to disabled", () => {
    assert.deepEqual(resolveEffectiveConfig(makeActor({ enabled: false, preset: "assault" })), DISABLED);
});

test("damaged actor config resolves to disabled", () => {
    for (const raw of ["enabled", 42, null, [], { enabled: "yes" }]) {
        const actor = makeActor({ rawConfig: raw });
        assert.equal(resolveEffectiveConfig(actor).enabled, false, `rawConfig=${JSON.stringify(raw)}`);
    }
});

test("token without override inherits actor config", () => {
    const actor = makeActor({ enabled: true, preset: "rangedCover" });
    const token = makeToken({ actor });
    assert.deepEqual(resolveEffectiveConfig(token), {
        enabled: true, preset: "rangedCover", source: "actor"
    });
});

test("token inherit mode inherits actor config", () => {
    const actor = makeActor({ enabled: true, preset: "assault" });
    const token = makeToken({ actor, mode: "inherit", preset: "hold" });
    assert.deepEqual(resolveEffectiveConfig(token), {
        enabled: true, preset: "assault", source: "actor"
    });
});

test("token enabled with preset overrides actor", () => {
    const actor = makeActor({ enabled: true, preset: "assault" });
    const token = makeToken({ actor, mode: "enabled", preset: "specOps" });
    assert.deepEqual(resolveEffectiveConfig(token), {
        enabled: true, preset: "specOps", source: "token"
    });
});

test("token enabled without preset falls back to actor preset", () => {
    const actor = makeActor({ enabled: true, preset: "assault" });
    const token = makeToken({ actor, mode: "enabled" });
    assert.deepEqual(resolveEffectiveConfig(token), {
        enabled: true, preset: "assault", source: "token"
    });
});

test("token enabled with unknown preset falls back to actor preset", () => {
    const actor = makeActor({ enabled: true, preset: "rangedCover" });
    const token = makeToken({ actor, mode: "enabled", preset: "bogus" });
    assert.deepEqual(resolveEffectiveConfig(token), {
        enabled: true, preset: "rangedCover", source: "token"
    });
});

test("token enabled with unknown preset and disabled actor falls back to hold", () => {
    const actor = makeActor({ enabled: false });
    const token = makeToken({ actor, mode: "enabled", preset: "bogus" });
    assert.deepEqual(resolveEffectiveConfig(token), {
        enabled: true, preset: "hold", source: "token"
    });
});

test("token enabled on a disabled actor activates AI (explicit opt-in)", () => {
    const actor = makeActor({ enabled: false, preset: "assault" });
    const token = makeToken({ actor, mode: "enabled", preset: "specOps" });
    assert.deepEqual(resolveEffectiveConfig(token), {
        enabled: true, preset: "specOps", source: "token"
    });
});

test("token disabled wins over enabled actor", () => {
    const actor = makeActor({ enabled: true, preset: "assault" });
    const token = makeToken({ actor, mode: "disabled" });
    assert.deepEqual(resolveEffectiveConfig(token), {
        enabled: false, preset: null, source: "token"
    });
});

test("combatant override wins over token and actor", () => {
    const actor = makeActor({ enabled: true, preset: "assault" });
    const token = makeToken({ actor, mode: "enabled", preset: "rangedCover" });
    const combatant = makeCombatant({ actor, token, mode: "enabled", preset: "specOps" });
    assert.deepEqual(resolveEffectiveConfig(combatant), {
        enabled: true, preset: "specOps", source: "combatant"
    });
});

test("combatant disabled wins over enabled token and actor", () => {
    const actor = makeActor({ enabled: true, preset: "assault" });
    const token = makeToken({ actor, mode: "enabled", preset: "assault" });
    const combatant = makeCombatant({ actor, token, mode: "disabled" });
    assert.deepEqual(resolveEffectiveConfig(combatant), {
        enabled: false, preset: null, source: "combatant"
    });
});

test("combatant inherit falls through to token override", () => {
    const actor = makeActor({ enabled: true, preset: "assault" });
    const token = makeToken({ actor, mode: "enabled", preset: "rangedCover" });
    const combatant = makeCombatant({ actor, token, mode: "inherit" });
    assert.deepEqual(resolveEffectiveConfig(combatant), {
        enabled: true, preset: "rangedCover", source: "token"
    });
});

test("combatant inherit + token inherit falls through to actor", () => {
    const actor = makeActor({ enabled: true, preset: "hold" });
    const token = makeToken({ actor, mode: "inherit" });
    const combatant = makeCombatant({ actor, token, mode: "inherit" });
    assert.deepEqual(resolveEffectiveConfig(combatant), {
        enabled: true, preset: "hold", source: "actor"
    });
});

test("combatant with no flags inherits token then actor", () => {
    const actor = makeActor({ enabled: false });
    const token = makeToken({ actor, mode: "enabled", preset: "assault" });
    const combatant = makeCombatant({ actor, token });
    assert.deepEqual(resolveEffectiveConfig(combatant), {
        enabled: true, preset: "assault", source: "token"
    });
});

test("damaged override flags normalise to inherit", () => {
    const actor = makeActor({ enabled: true, preset: "assault" });
    for (const raw of ["enabled", 42, null, [], { mode: "nonsense", preset: "bogus" }]) {
        const token = makeToken({ actor, rawOverride: raw });
        const result = resolveEffectiveConfig(token);
        assert.equal(result.enabled, true, `rawOverride=${JSON.stringify(raw)}`);
        assert.equal(result.preset, "assault");
        assert.equal(result.source, "actor");
    }
});

test("deleted actor resolves to disabled", () => {
    const actor = makeActor({ enabled: true, preset: "assault" });
    actor.destroyed = true;
    assert.deepEqual(resolveEffectiveConfig(actor), DISABLED);
});

test("token with deleted actor resolves to disabled", () => {
    const token = makeToken({ actor: null, mode: "enabled", preset: "assault" });
    assert.deepEqual(resolveEffectiveConfig(token), DISABLED);
});

test("combatant with deleted token resolves to disabled", () => {
    const actor = makeActor({ enabled: true, preset: "assault" });
    const combatant = makeCombatant({ actor, token: null, mode: "enabled", preset: "assault" });
    assert.deepEqual(resolveEffectiveConfig(combatant), DISABLED);
});

test("combatant with deleted actor resolves to disabled", () => {
    const token = makeToken({ actor: makeActor({ enabled: true, preset: "assault" }) });
    const combatant = makeCombatant({ actor: null, token, mode: "enabled", preset: "assault" });
    assert.deepEqual(resolveEffectiveConfig(combatant), DISABLED);
});

test("destroyed combatant resolves to disabled", () => {
    const combatant = makeCombatant({ destroyed: true, mode: "enabled", preset: "assault" });
    assert.deepEqual(resolveEffectiveConfig(combatant), DISABLED);
});

test("resolver is read-only: frozen fixtures stay untouched", () => {
    const actor = freezeDeep(makeActor({ enabled: true, preset: "assault" }));
    const token = freezeDeep(makeToken({ actor, mode: "enabled", preset: "rangedCover" }));
    const combatant = freezeDeep(makeCombatant({ actor, token, mode: "inherit" }));

    assert.deepEqual(resolveEffectiveConfig(freezeDeep(actor)), {
        enabled: true, preset: "assault", source: "actor"
    });
    assert.deepEqual(resolveEffectiveConfig(token), {
        enabled: true, preset: "rangedCover", source: "token"
    });
    assert.deepEqual(resolveEffectiveConfig(combatant), {
        enabled: true, preset: "rangedCover", source: "token"
    });
});

test("resolver is deterministic: repeated calls return equal results", () => {
    const combatant = makeCombatant({
        actor: makeActor({ enabled: true, preset: "hold" }),
        token: makeToken({ mode: "enabled", preset: "assault" }),
        mode: "inherit"
    });
    const first = resolveEffectiveConfig(combatant);
    const second = resolveEffectiveConfig(combatant);
    assert.deepEqual(first, second);
});

test("includeNeutral carries from actor config to the enabled result", () => {
    const actor = makeActor({ rawConfig: { enabled: true, preset: "assault", includeNeutral: true } });
    assert.deepEqual(resolveEffectiveConfig(actor), {
        enabled: true, preset: "assault", source: "actor", includeNeutral: true
    });
});

test("includeNeutral defaults to absent and override may force it off", () => {
    const actor = makeActor({ rawConfig: { enabled: true, preset: "assault", includeNeutral: true } });
    // Token override without the flag keeps the actor setting.
    const inheritToken = makeToken({ actor, mode: "enabled", preset: "hold" });
    assert.equal(resolveEffectiveConfig(inheritToken).includeNeutral, true);
    // Explicit false on the override wins over the actor flag.
    const overrideToken = makeToken({ actor, mode: "enabled", preset: "hold" });
    overrideToken.flags[MODULE_ID].override.includeNeutral = false;
    const result = resolveEffectiveConfig(overrideToken);
    assert.equal(result.includeNeutral === true, false);
    // Actor config without the flag resolves without includeNeutral.
    assert.equal(resolveEffectiveConfig(makeActor({ enabled: true, preset: "hold" })).includeNeutral, undefined);
});

test("isAiEnabled mirrors resolveEffectiveConfig", () => {
    assert.equal(isAiEnabled(makeActor({ enabled: true, preset: "hold" })), true);
    assert.equal(isAiEnabled(makeActor()), false);
    assert.equal(isAiEnabled(null), false);
});
