#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();

const readText = (path) => readFile(join(root, path), "utf8");
const readJson = async (path) => JSON.parse(await readText(path));

async function assertFile(path) {
  const info = await stat(join(root, path)).catch(() => null);
  assert.equal(Boolean(info?.isFile()), true, `missing required file: ${path}`);
}

const pkg = await readJson("package.json");
const manifest = await readJson("extension/manifest.json");
const utools = await readJson("utools/plugin.json");

assert.equal(pkg.scripts["verify:static"], "node scripts/verify-static.mjs");
assert.equal(pkg.scripts["verify:release"], "node scripts/verify-release.mjs");
assert.equal(manifest.version, pkg.version, "Chrome extension version must match package version");
assert.equal(utools.version, pkg.version, "uTools plugin version must match package version");

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.action.default_popup, "popup.html");
assert.equal(manifest.side_panel.default_path, "assistant.html");
assert.equal(manifest.permissions.includes("storage"), true);
assert.equal(manifest.permissions.includes("sidePanel"), true);
assert.equal(manifest.host_permissions.includes("https://customer.cignaenvoy.com/*"), true);

assert.equal(utools.pluginName, "Cigna Claim Assistant");
assert.equal(utools.main, "index.html");
assert.equal(utools.preload, "preload.js");

for (const file of [
  "extension/popup.html",
  "extension/assistant.html",
  "extension/popup.js",
  "extension/background.js",
  "extension/content/cignaSubmitter.js",
  "extension/core/claimIntake.mjs",
  "utools/plugin.json",
  "utools/index.html",
  "utools/preload.js",
  "utools/renderer.js",
  "scripts/scan-claims.mjs",
  "scripts/package-release.mjs",
  "docs/ACCEPTANCE.zh-CN.md",
  "docs/VERIFICATION.md",
  "README.md",
]) {
  await assertFile(file);
}

const popupHtml = await readText("extension/popup.html");
const assistantHtml = await readText("extension/assistant.html");
assert.match(popupHtml, /拖入 PDF\/图片/);
assert.match(assistantHtml, /拖入 PDF\/图片\/文件夹/);
assert.match(popupHtml, /id="autoSubmitOnSelect"/);
assert.match(assistantHtml, /id="autoSubmitOnSelect"/);

const popupJs = await readText("extension/popup.js");
assert.match(popupJs, /autoSubmitOnSelect/);
assert.match(popupJs, /CIGNA_START_SUBMISSION/);
assert.match(popupJs, /dryRun:\s*Boolean\(options\.dryRun\)/);
assert.match(popupJs, /submissionFingerprint/);

const submitter = await readText("extension/content/cignaSubmitter.js");
assert.match(submitter, /pickDate/);
assert.match(submitter, /dry-run-ready/);
assert.match(submitter, /未点击最终提交/);

const background = await readText("extension/background.js");
assert.match(background, /prepareClaimTab/);
assert.match(background, /recordSubmittedClaims/);
assert.match(background, /if \(!dryRun\) await recordSubmittedClaims/);

const utoolsPreload = await readText("utools/preload.js");
assert.match(utoolsPreload, /inputFromDrop/);
assert.match(utoolsPreload, /--file/);
assert.match(utoolsPreload, /exportChromeBackup/);
assert.match(utoolsPreload, /autoSubmitOnSelect:\s*true/);

const acceptance = await readText("docs/ACCEPTANCE.zh-CN.md");
assert.match(acceptance, /真实登录态 Cigna Envoy 页面完成最终提交/);
assert.match(acceptance, /realCignaEndToEndVerified.*false/);
assert.match(acceptance, /日期通过 Cigna 日期选择器点击/);

const verification = await readText("docs/VERIFICATION.md");
assert.match(verification, /npm run verify:static/);
assert.match(verification, /不会启动本机 Chrome/);

const readme = await readText("README.md");
assert.match(readme, /npm run verify:static/);
assert.match(readme, /不会启动本机 Chrome/);

const verifyRelease = await readText("scripts/verify-release.mjs");
assert.match(verifyRelease, /extension:test:zip:load/);
assert.match(verifyRelease, /utools:test:renderer/);

console.log("static verification passed (no browser launched)");
