import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const unitDir = path.join(__dirname, "unit");

const entries = await readdir(unitDir, { withFileTypes: true });
const files = entries
    .filter(e => e.isFile() && e.name.endsWith(".test.mjs"))
    .map(e => path.join("tests/unit", e.name));

if (!files.length) {
    console.error("No unit test files found in tests/unit");
    process.exit(1);
}

const proc = spawn(
    "node",
    ["--import", "./tests/unit/setup.mjs", "--test", ...files],
    { stdio: "inherit", shell: false }
);
proc.on("exit", code => process.exit(code ?? 0));
