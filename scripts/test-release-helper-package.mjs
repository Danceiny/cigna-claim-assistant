#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const releaseZip = join(root, "dist", "cigna-claim-assistant-release.zip");
const info = await stat(releaseZip).catch(() => null);
assert.equal(Boolean(info?.isFile()), true, "release zip is missing");

const tmp = await mkdtemp(join(tmpdir(), "cigna-release-helper-"));
try {
  await run("unzip", ["-q", releaseZip, "-d", tmp], { cwd: root, timeoutMs: 30000 });
  const releaseRoot = join(tmp, "cigna-claim-assistant-release");
  const packageJson = JSON.parse(await readFile(join(releaseRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["claims:scan"], "node scripts/scan-claims.mjs");
  assert.equal(packageJson.scripts["claims:test:core-sync"], "node scripts/test-core-sync.mjs");
  assert.equal(packageJson.scripts["claims:test:helper"], "node scripts/test-helper-package.mjs");

  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: releaseRoot,
    timeoutMs: 120000,
  });
  await run("npm", ["run", "claims:test:helper"], {
    cwd: releaseRoot,
    timeoutMs: 30000,
  });
  const plan = JSON.parse(await readFile(join(releaseRoot, "outputs", "cigna-claim-plan.json"), "utf8"));
  assert.equal(Array.isArray(plan.claims), true);
  assert.equal(plan.claims.length, 0);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log("release helper package test passed");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = options.timeoutMs
      ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      const output = `${stdout}${stderr}`;
      if (code === 0) resolve(output);
      else reject(new Error(`${command} ${args.join(" ")} exited ${code ?? signal}\n${output}`));
    });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
  });
}
