#!/usr/bin/env node
import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const distDir = join(root, "dist");
const stagingDir = join(distDir, "cigna-claim-assistant-utools");
const packagePath = join(distDir, "cigna-claim-assistant-utools.upx");
const packageTmp = `${packagePath}.tmp`;

await rm(stagingDir, { recursive: true, force: true });
await mkdir(stagingDir, { recursive: true });

for (const file of ["plugin.json", "index.html", "style.css", "preload.js", "renderer.js", "logo.png"]) {
  await cp(join(root, "utools", file), join(stagingDir, file));
}

await mkdir(join(stagingDir, "scripts"), { recursive: true });
for (const file of ["scan-claims.mjs", "generate-ocr-sidecars.mjs"]) {
  await cp(join(root, "scripts", file), join(stagingDir, "scripts", file));
}

await mkdir(join(stagingDir, "src", "core"), { recursive: true });
for (const file of ["claimIntake.mjs", "pdfCompress.mjs"]) {
  await cp(join(root, "src", "core", file), join(stagingDir, "src", "core", file));
}

await mkdir(join(stagingDir, "node_modules"), { recursive: true });
for (const moduleName of ["pdfjs-dist", "pdf-lib", "tslib", "pako", "@pdf-lib"]) {
  await cp(join(root, "node_modules", moduleName), join(stagingDir, "node_modules", moduleName), { recursive: true });
}

await writeFile(join(stagingDir, "package.json"), `${JSON.stringify({
  private: true,
  dependencies: {
    "pdfjs-dist": "^4.10.38",
    "pdf-lib": "^1.17.1",
  },
}, null, 2)}\n`);

for (const file of [
  "plugin.json",
  "index.html",
  "preload.js",
  "renderer.js",
  "scripts/scan-claims.mjs",
  "src/core/claimIntake.mjs",
  "node_modules/pdfjs-dist/package.json",
  "node_modules/pdf-lib/package.json",
]) {
  const info = await stat(join(stagingDir, file)).catch(() => null);
  if (!info?.isFile()) throw new Error(`Missing uTools package file: ${file}`);
}

await rm(packageTmp, { force: true });
await run("zip", ["-qr", packageTmp, "."], { cwd: stagingDir });
await rm(packagePath, { force: true });
await cp(packageTmp, packagePath);
await rm(packageTmp, { force: true });
console.log(`Wrote ${packagePath}`);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
    });
    child.on("error", reject);
  });
}
