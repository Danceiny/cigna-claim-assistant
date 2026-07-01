#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const releaseZip = join(root, "dist", "cigna-claim-assistant-release.zip");
const info = await stat(releaseZip).catch(() => null);
assert.equal(Boolean(info?.isFile()), true, "release zip is missing");

const tmp = await mkdtemp(join(tmpdir(), "cigna-release-user-smoke-"));
try {
  await run("unzip", ["-q", releaseZip, "-d", tmp], { timeoutMs: 30000 });
  const releaseRoot = join(tmp, "cigna-claim-assistant-release");

  await assertFile(releaseRoot, "START.html");
  await assertFile(releaseRoot, "README.md");
  await assertFile(releaseRoot, "INSTALL.zh-CN.md");
  await assertFile(releaseRoot, "VERIFICATION.md");
  await assertFile(releaseRoot, "OPEN_INSTALLER.command");
  await assertFile(releaseRoot, "extension/manifest.json");
  await assertFile(releaseRoot, "extension/icons/icon-128.png");
  await assertFile(releaseRoot, "cigna-claim-assistant-utools.upx");
  await assertFile(releaseRoot, "package.json");
  await assertFile(releaseRoot, "scripts/scan-claims.mjs");
  await assertFile(releaseRoot, "scripts/generate-ocr-sidecars.mjs");

  const startHtml = await readFile(join(releaseRoot, "START.html"), "utf8");
  for (const href of findLocalHrefs(startHtml)) {
    await assertFile(releaseRoot, href);
  }
  assert.match(startHtml, /不要用临时 Chrome profile/);
  assert.match(startHtml, /cigna-claim-assistant-utools\.upx/);

  const install = await readFile(join(releaseRoot, "INSTALL.zh-CN.md"), "utf8");
  const readme = await readFile(join(releaseRoot, "README.md"), "utf8");
  const verification = await readFile(join(releaseRoot, "VERIFICATION.md"), "utf8");
  assert.match(install, /实际产品形态是 Chrome 插件和 uTools 插件/);
  assert.match(install, /Chrome 插件完成/);
  assert.match(readme, /release zip 只是把这两种形态/);
  assert.match(readme, /解压后的 release 包只保留用户侧 helper 命令/);
  assert.match(verification, /源码仓库一键 release 验证/);
  assert.match(verification, /未在真实登录态 Cigna Envoy/);

  const helperPackage = JSON.parse(await readFile(join(releaseRoot, "package.json"), "utf8"));
  assert.equal(helperPackage.scripts["claims:scan"], "node scripts/scan-claims.mjs");
  assert.equal(helperPackage.scripts["claims:test:helper"], "node scripts/test-helper-package.mjs");
  assert.equal(helperPackage.scripts["verify:release"], undefined);

  await run("unzip", ["-Z1", join(releaseRoot, "cigna-claim-assistant-utools.upx")], {
    timeoutMs: 30000,
    expectStdout: [/^plugin\.json$/m, /^preload\.js$/m, /^scripts\/scan-claims\.mjs$/m],
  });

  await run(process.execPath, ["scripts/test-extension-load.mjs"], {
    cwd: root,
    timeoutMs: 30000,
    env: {
      ...process.env,
      EXTENSION_DIR: join(releaseRoot, "extension"),
      EXTENSION_LOAD_HEADED: "1",
    },
  });
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log("release user smoke test passed");

async function assertFile(baseDir, relativePath) {
  const path = join(baseDir, relativePath);
  const info = await stat(path).catch(() => null);
  assert.equal(Boolean(info?.isFile()), true, `release user smoke missing ${relativePath}`);
}

function findLocalHrefs(html) {
  const hrefs = [];
  const pattern = /href="([^"]+)"/g;
  for (const match of html.matchAll(pattern)) {
    const href = match[1];
    if (/^(?:https?:|chrome:|mailto:|#)/.test(href)) continue;
    hrefs.push(href);
  }
  return hrefs;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || root,
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
      if (code === 0) {
        for (const expected of options.expectStdout || []) {
          assert.match(stdout, expected);
        }
        resolve(output);
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited ${code ?? signal}\n${output}`));
    });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
  });
}
