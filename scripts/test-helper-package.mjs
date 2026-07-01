#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const tmp = await mkdtemp(join(tmpdir(), "cigna-helper-self-"));

try {
  await run("npm", ["run", "claims:test:core-sync"], { timeoutMs: 30000 });
  const emptyDir = join(tmp, "empty-claims");
  await mkdir(emptyDir);
  await run("npm", ["run", "claims:scan", "--", "--dir", emptyDir], { timeoutMs: 30000 });
  const plan = JSON.parse(await readFile(join(root, "outputs", "cigna-claim-plan.json"), "utf8"));
  assert.equal(Array.isArray(plan.claims), true);
  assert.equal(plan.claims.length, 0);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log("helper package self test passed");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
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
