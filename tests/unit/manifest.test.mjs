/**
 * Manifest and localization schema validation (issue #399).
 *
 * Guards the module.json contract that Foundry and the release workflow rely
 * on, and keeps en/ru localization files in key parity.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function _readJson(relative) {
    return JSON.parse(fs.readFileSync(path.join(ROOT, relative), "utf8"));
}

const manifest = _readJson("module.json");

test("manifest declares the expected id and title", () => {
    assert.equal(manifest.id, "only-war-ai");
    assert.equal(manifest.title, "Only War AI");
});

test("manifest covers Foundry 13-14", () => {
    assert.equal(manifest.compatibility.minimum, "13");
    assert.equal(manifest.compatibility.maximum, "14");
    assert.ok(Number(manifest.compatibility.verified) >= 13);
});

test("manifest requires the only-war-local system", () => {
    const system = manifest.relationships?.systems?.find(s => s.id === "only-war-local");
    assert.ok(system, "system relationship declared");
    assert.equal(system.type, "system");
});

test("manifest wires esmodule, style and en/ru languages", () => {
    assert.deepEqual(manifest.esmodules, ["scripts/module.js"]);
    assert.deepEqual(manifest.styles, ["styles/only-war-ai.css"]);
    const langs = manifest.languages.map(l => l.lang).sort();
    assert.deepEqual(langs, ["en", "ru"]);
});

test("manifest referenced files exist", () => {
    for (const file of [...manifest.esmodules, ...manifest.styles, ...manifest.languages.map(l => l.path)]) {
        assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} exists`);
    }
});

test("en and ru localization files have identical keys", () => {
    const en = _readJson("languages/en.json");
    const ru = _readJson("languages/ru.json");
    assert.deepEqual(Object.keys(en).sort(), Object.keys(ru).sort());
});

test("localization keys use the OWAI namespace", () => {
    const en = _readJson("languages/en.json");
    for (const key of Object.keys(en)) {
        assert.ok(key.startsWith("OWAI."), `${key} uses OWAI. prefix`);
    }
});
