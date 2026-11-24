import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const [version, repository, destination] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/.test(version)
    || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !destination) {
    throw new Error("Usage: node tools/stage-release.mjs <version> <owner/repo> <new directory>");
}

const manifest = JSON.parse(await readFile("module.json", "utf8"));
if (manifest.id !== "only-war-ai") throw new Error("Unexpected package id");
const releases = `https://github.com/${repository}/releases`;
const releaseManifest = {
    ...manifest,
    version,
    manifest: `${releases}/latest/download/module.json`,
    download: `${releases}/download/v${version}/${manifest.id}-${version}.zip`
};

await mkdir(dirname(destination), { recursive: true });
await mkdir(destination);
for (const entry of ["languages", "scripts", "styles", "templates", "README.md", "LICENSE"]) {
    await cp(entry, join(destination, entry), { recursive: true });
}
await writeFile(join(destination, "module.json"), `${JSON.stringify(releaseManifest, null, 2)}\n`);
