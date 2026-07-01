#!/usr/bin/env node
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const extensionZip = join(root, "dist", "cigna-claim-assistant.zip");
const info = await stat(extensionZip).catch(() => null);
if (!info?.isFile()) {
  throw new Error("Missing dist/cigna-claim-assistant.zip. Run npm run extension:package first.");
}

const tmp = await mkdtemp(join(tmpdir(), "cigna-extension-zip-load-"));
try {
  await run("unzip", ["-q", extensionZip, "-d", tmp], { timeoutMs: 30000 });
  await run(process.execPath, ["scripts/test-extension-load.mjs"], {
    timeoutMs: 30000,
    env: {
      ...process.env,
      EXTENSION_DIR: tmp,
      EXTENSION_LOAD_HEADED: "1",
    },
  });
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log("extension zip load test passed");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: options.env || process.env,
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
