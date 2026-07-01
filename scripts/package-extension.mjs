#!/usr/bin/env node
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const extensionDir = join(root, "extension");
const outputPath = join(root, "dist", "cigna-claim-assistant.zip");

const manifest = JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8"));
const requiredFiles = new Set([
  "manifest.json",
  manifest.action?.default_popup,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  manifest.side_panel?.default_path,
  manifest.background?.service_worker,
  "popup.css",
  "popup.js",
  ...(manifest.content_scripts || []).flatMap((script) => script.js || []),
  ...(manifest.web_accessible_resources || []).flatMap((entry) => entry.resources || []),
].filter(Boolean));

for (const file of requiredFiles) {
  await assertFile(join(extensionDir, file));
}

await mkdir(dirname(outputPath), { recursive: true });
await rm(outputPath, { force: true });
await run("zip", ["-qr", outputPath, "."], { cwd: extensionDir });
console.log(`Wrote ${outputPath}`);

async function assertFile(path) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new Error(`Missing extension file: ${path}`);
}

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
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
      }
    });
    child.on("error", reject);
  });
}
