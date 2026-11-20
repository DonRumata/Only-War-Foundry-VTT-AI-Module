/**
 * Syntax check helper: runs `node --check` on every JS/MJS file under
 * `scripts/` and `tests/unit/`.
 *
 * Mirrors the AGENTS.md guidance ("Для изменённых JS запускайте
 * `node --check <file>`") and gives the module a fast, dependency-free static
 * check that does not require a build step. Foundry still loads the raw
 * JS/HBS/CSS directly — this tool is a dev-time verification only.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SCAN_DIRS = [
    path.join(ROOT, "scripts"),
    path.join(ROOT, "tests", "unit")
];

/** Recursively collect every .js/.mjs file under the given directory. */
async function collectJsFiles(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) return collectJsFiles(absolute);
        if (entry.isFile() && /\.(js|mjs)$/.test(entry.name)) return [absolute];
        return [];
    }));
    return files.flat();
}

const files = (await Promise.all(SCAN_DIRS.map(collectJsFiles))).flat();
if (!files.length) {
    console.error("[check] No .js/.mjs files found under scripts/ and tests/unit/");
    process.exit(1);
}

let failures = 0;
for (const file of files) {
    try {
        execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    } catch (err) {
        failures++;
        const stderr = err.stderr ? err.stderr.toString().trim() : err.message;
        console.error(`FAIL: ${path.relative(ROOT, file)}\n${stderr}\n`);
    }
}

const checked = files.length;
if (failures) {
    console.error(`[check] ${failures}/${checked} file(s) failed syntax check.`);
    process.exit(1);
}
console.log(`[check] ${checked} file(s) OK.`);
