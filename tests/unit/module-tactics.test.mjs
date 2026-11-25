/**
 * Module-bootstrap coverage for the tactic registry service (issue #92).
 */
import test from "node:test";
import assert from "node:assert/strict";

import "../../scripts/module.js";

test("init registers the tactics service with specOps and rangedCover selectors", () => {
    game.modules.set("only-war-ai", {});
    const init = Hooks._calls.find(call => call.type === "once" && call.event === "init");
    assert.ok(init, "module init hook is registered");
    init.fn();

    const api = game.modules.get("only-war-ai")?.api;
    assert.ok(api, "module API is published");
    const tactics = api.services.get("tactics");
    assert.ok(tactics, "tactic registry service is registered");
    assert.equal(typeof tactics.registerTacticSelector, "function");
    assert.equal(typeof tactics.resolveTactic, "function");
    const specOps = tactics.listTacticSelectors("specOps");
    assert.equal(specOps.length, 1);
    assert.equal(specOps[0].kind, "maneuver");
    assert.equal(typeof specOps[0].select, "function");
    const rangedCover = tactics.listTacticSelectors("rangedCover");
    assert.equal(rangedCover.length, 1);
    assert.equal(rangedCover[0].kind, "maneuver");
    assert.equal(typeof rangedCover[0].select, "function");
    assert.equal(tactics.resolveTactic("assault", {}), null);
});
