/**
 * Unit tests for the system compatibility check (issue #399).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    checkSystemCompatibility,
    COMPATIBILITY_REASONS
} from "../../scripts/compatibility.js";

test("compatible system + api 1.0 passes", () => {
    const result = checkSystemCompatibility({
        systemId: "only-war-local",
        api: { version: "1.0" }
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, COMPATIBILITY_REASONS.ok);
});

test("api 1.x minors stay compatible", () => {
    for (const version of ["1.0", "1.1", "1.9.3"]) {
        const result = checkSystemCompatibility({ systemId: "only-war-local", api: { version } });
        assert.equal(result.ok, true, `version=${version}`);
    }
});

test("wrong system id fails", () => {
    const result = checkSystemCompatibility({
        systemId: "other-system",
        api: { version: "1.0" }
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, COMPATIBILITY_REASONS.wrongSystem);
    assert.equal(result.actual, "other-system");
});

test("missing api fails", () => {
    for (const api of [undefined, null, {}, { version: 1 }]) {
        const result = checkSystemCompatibility({ systemId: "only-war-local", api });
        assert.equal(result.ok, false, `api=${JSON.stringify(api)}`);
        assert.equal(result.reason, COMPATIBILITY_REASONS.apiMissing);
    }
});

test("major version mismatch fails", () => {
    const result = checkSystemCompatibility({
        systemId: "only-war-local",
        api: { version: "2.0" }
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, COMPATIBILITY_REASONS.versionMismatch);
    assert.equal(result.expected, "1");
    assert.equal(result.actual, "2.0");
});

test("empty input fails safely", () => {
    const result = checkSystemCompatibility();
    assert.equal(result.ok, false);
});
