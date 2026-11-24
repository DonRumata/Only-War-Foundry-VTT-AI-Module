import assert from "node:assert/strict";
import test from "node:test";
import { createTurnAdvance } from "../../scripts/executor/advance.js";

test("manual advance during pacing does not skip the next turn", async () => {
    let pacingStarted;
    const waiting = new Promise(resolve => { pacingStarted = resolve; });
    const combat = {
        id: "combat",
        round: 1,
        turn: 0,
        async nextTurn() { this.turn++; }
    };
    const { _advanceForOperation } = createTurnAdvance({
        _isController: () => true,
        log: () => {},
        pacing: () => {
            pacingStarted();
            return 10;
        }
    });

    const auto = _advanceForOperation(combat, { round: 1, turn: 0 }, {});
    await waiting;
    await combat.nextTurn();
    await auto;

    assert.equal(combat.turn, 1);
});
