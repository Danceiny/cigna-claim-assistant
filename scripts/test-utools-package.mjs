#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const root = process.cwd();
const packagePath = join(root, "dist", "cigna-claim-assistant-utools.upx");
const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const info = await stat(packagePath).catch(() => null);
assert.equal(Boolean(info?.isFile()), true, "uTools package is missing");
assert.equal(info.size > 1_000_000, true, "uTools package is unexpectedly small");

const listing = await run("unzip", ["-Z1", packagePath]);
for (const file of [
  "plugin.json",
  "index.html",
  "preload.js",
  "renderer.js",
  "logo.png",
  "scripts/scan-claims.mjs",
  "src/core/claimIntake.mjs",
  "node_modules/pdfjs-dist/package.json",
  "node_modules/pdf-lib/package.json",
]) {
  assert.match(listing, new RegExp(escapeRegExp(file)));
}

const pluginJson = JSON.parse(await run("unzip", ["-p", packagePath, "plugin.json"]));
assert.equal(pluginJson.pluginName, "Cigna Claim Assistant");
assert.equal(pluginJson.version, rootPackage.version);
assert.equal(pluginJson.main, "index.html");
assert.equal(pluginJson.preload, "preload.js");
assert.equal(pluginJson.features[0].code, "cigna-claim-assistant");

const preload = await run("unzip", ["-p", packagePath, "preload.js"]);
const indexHtml = await run("unzip", ["-p", packagePath, "index.html"]);
const renderer = await run("unzip", ["-p", packagePath, "renderer.js"]);
assert.match(preload, /scanDirectory/);
assert.match(preload, /ocrEnabled/);
assert.match(preload, /compressEnabled/);
assert.match(preload, /organizeEnabled/);
assert.match(preload, /onlyNewEnabled/);
assert.match(preload, /saveFolderState/);
assert.match(preload, /folderStateKey/);
assert.match(preload, /--compress/);
assert.match(preload, /--organize/);
assert.match(preload, /--ocr-command/);
assert.match(preload, /loadSettings/);
assert.match(preload, /saveSettings/);
assert.match(preload, /exportChromeBackup/);
assert.match(preload, /directoryFromDrop/);
assert.match(preload, /inputFromDrop/);
assert.match(preload, /--file/);
assert.match(preload, /scan-claims\.mjs/);
assert.match(preload, /shellOpenExternal/);
assert.match(preload, /new-submitclaim/);
assert.match(indexHtml, /id="settingsStatus"/);
assert.match(indexHtml, /organizeEnabled/);
assert.match(indexHtml, /onlyNewEnabled/);
assert.match(indexHtml, /baselineDir/);
assert.match(renderer, /renderSettingsStatus/);
assert.match(renderer, /missingRequiredSettings/);
assert.match(renderer, /请先填写必填设置/);

const tmp = await mkdtemp(join(tmpdir(), "cigna-utools-package-"));
try {
  await run("unzip", ["-q", packagePath, "-d", tmp]);
  const scanScript = join(tmp, "scripts", "scan-claims.mjs");
  const emptyDir = join(tmp, "empty");
  const planPath = join(tmp, "plan.json");
  const droppedPdfPath = join(tmp, "dropped.pdf");
  const inboxPdfPath = join(emptyDir, "new-claim.pdf");
  await mkdir(emptyDir);
  await writeFile(droppedPdfPath, "%PDF-1.4\n");
  await run(process.execPath, [scanScript, "--dir", emptyDir, "--output", planPath]);
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  assert.equal(plan.claims.length, 0);
  const preloadSmoke = join(tmp, "preload-smoke.cjs");
  await writeFile(preloadSmoke, `
global.window = {};
let storedSettings = null;
let storedFolderState = null;
let openedUrl = "";
global.utools = {
  dbStorage: {
    getItem(key) {
      if (key === "cigna-claim-assistant-folder-state") return storedFolderState;
      return storedSettings;
    },
    setItem(key, value) {
      if (key === "cigna-claim-assistant-folder-state") storedFolderState = value;
      else storedSettings = value;
    }
  },
  showOpenDialog() { return [${JSON.stringify(emptyDir)}]; },
  shellOpenExternal(url) { openedUrl = url; }
};
require("./preload.js");
(async () => {
  const picked = window.cignaAssistant.chooseDirectory();
  if (picked !== ${JSON.stringify(emptyDir)}) throw new Error("chooseDirectory did not return the mocked directory");
  const blank = window.cignaAssistant.saveSettings({ claimDir: picked });
  if (blank.diagnosis !== "") throw new Error("blank uTools settings should not inject a default diagnosis");
  const saved = window.cignaAssistant.saveSettings({
    beneficiaryName: "TEST USER",
    diagnosis: "BACK_PAIN",
    country: "阿拉伯联合酋长国",
    claimType: "医疗类",
    visitType: "门诊",
    paymentLabel: "BANK 0001",
    minServiceDate: "2026-05-08",
    earliestDate: "2026-05-01",
    claimDir: picked,
    ocrEnabled: true,
    compressEnabled: true,
    organizeEnabled: true,
    onlyNewEnabled: true,
    ocrCommand: ${JSON.stringify(process.execPath)}
  });
  if (window.cignaAssistant.loadSettings().minServiceDate !== "2026-05-08") throw new Error("settings were not persisted");
  const backup = window.cignaAssistant.exportChromeBackup(saved);
  if (!backup.ok || backup.payload.schema !== "cigna-claim-assistant-backup-v1") throw new Error("backup export failed");
  if (backup.payload.settings.beneficiaryName !== "TEST USER") throw new Error("backup beneficiary was not exported");
  if (backup.payload.settings.paymentLabel !== "BANK 0001") throw new Error("backup payment label was not exported");
  if (backup.payload.settings.ongoingConditionEarliestDate !== "2026-05-01") throw new Error("backup earliest date was not exported");
  if (backup.payload.settings.autoSubmitOnSelect !== true) throw new Error("backup did not enable drop-to-submit mode");
  const droppedDir = await window.cignaAssistant.directoryFromDrop({ dataTransfer: { files: [{ path: picked }] } });
  if (droppedDir !== picked) throw new Error("directory drop did not return the dropped directory");
  const droppedFiles = await window.cignaAssistant.inputFromDrop({ dataTransfer: { files: [{ path: ${JSON.stringify(droppedPdfPath)} }] } });
  if (droppedFiles.filePaths.length !== 1 || droppedFiles.filePaths[0] !== ${JSON.stringify(droppedPdfPath)}) throw new Error("file drop did not preserve exact file input");
  const result = await window.cignaAssistant.scanDirectory({ ...saved, dir: picked });
  if (!result.ok) throw new Error(result.error || result.stderr || "scanDirectory failed");
  const stored = window.cignaAssistant.loadSettings();
  if (stored.ocrEnabled !== true) throw new Error("OCR setting was not persisted");
  if (stored.compressEnabled !== true) throw new Error("compression setting was not persisted");
  if (stored.organizeEnabled !== true) throw new Error("organize setting was not persisted");
  if (stored.onlyNewEnabled !== true) throw new Error("only-new setting was not persisted");
  if (stored.ocrCommand !== ${JSON.stringify(process.execPath)}) throw new Error("OCR command was not persisted");
  const baseline = window.cignaAssistant.saveFolderState(picked);
  if (!baseline.ok || baseline.count !== 0) throw new Error("empty folder baseline failed");
  await require("fs/promises").writeFile(${JSON.stringify(inboxPdfPath)}, "%PDF-1.4\\nnew");
  const firstNew = await window.cignaAssistant.scanDirectory({ ...saved, dir: picked });
  if (!firstNew.ok) throw new Error(firstNew.error || firstNew.stderr || "new-file scan failed");
  if (!firstNew.stdout.includes("new/changed files")) throw new Error("new-file scan did not report folder state");
  const secondNew = await window.cignaAssistant.scanDirectory({ ...saved, dir: picked });
  if (!secondNew.ok || !secondNew.stdout.includes("No new or changed files")) throw new Error("unchanged folder was not skipped");
  window.cignaAssistant.openChromeSubmit();
  if (!openedUrl.includes("new-submitclaim")) throw new Error("Cigna URL was not opened");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`);
  await run(process.execPath, [preloadSmoke], { cwd: tmp });
  await runRendererSmoke(tmp);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log("uTools package test passed");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      const output = `${stdout}${stderr}`;
      if (code === 0 || options.allowFailure) resolve(output);
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${output}`));
    });
    child.on("error", reject);
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runRendererSmoke(pluginRoot) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.addInitScript(() => {
      window.__utoolsCalls = [];
      window.cignaAssistant = {
        loadSettings() {
          return {
            beneficiaryName: "PACKAGED USER",
            diagnosis: "BACK_PAIN",
            country: "阿拉伯联合酋长国",
            claimType: "医疗类",
            visitType: "门诊",
            paymentLabel: "BANK 0001",
            minServiceDate: "2026-05-08",
            earliestDate: "2026-05-01",
            claimDir: "/tmp/packaged-claims",
            ocrEnabled: true,
            compressEnabled: true,
            organizeEnabled: true,
            onlyNewEnabled: true,
            ocrCommand: "/usr/local/bin/ocr-wrapper",
          };
        },
        saveSettings(settings) {
          window.__utoolsCalls.push({ type: "saveSettings", settings });
          return settings;
        },
        chooseDirectory() {
          window.__utoolsCalls.push({ type: "chooseDirectory" });
          return "/tmp/packaged-selected";
        },
        async directoryFromDrop() {
          window.__utoolsCalls.push({ type: "directoryFromDrop" });
          return "/tmp/packaged-dropped";
        },
        async inputFromDrop() {
          window.__utoolsCalls.push({ type: "inputFromDrop" });
          return {
            dir: "/tmp",
            filePaths: ["/tmp/packaged-a.pdf", "/tmp/packaged-b.pdf"],
            label: "2 个文件: packaged-a.pdf, packaged-b.pdf",
          };
        },
        async scanDirectory(options) {
          window.__utoolsCalls.push({ type: "scanDirectory", options });
          return {
            ok: true,
            output: "/tmp/outputs/utools-claim-plan.json",
            stdout: "Ready: 1, review: 0, blocked: 0, duplicates: 0",
          };
        },
        saveFolderState(dir) {
          window.__utoolsCalls.push({ type: "saveFolderState", dir });
          return { ok: true, dir, count: 12 };
        },
        exportChromeBackup(settings) {
          window.__utoolsCalls.push({ type: "exportChromeBackup", settings });
          return { ok: true, output: "/tmp/outputs/cigna-claim-assistant-chrome-settings-backup.json" };
        },
        openChromeSubmit() {
          window.__utoolsCalls.push({ type: "openChromeSubmit" });
        },
        openReleaseFolder() {
          window.__utoolsCalls.push({ type: "openReleaseFolder" });
        },
      };
    });
    await page.goto(pathToFileURL(join(pluginRoot, "index.html")).href);
    await page.waitForSelector("#scanDir");
    assert.equal(await page.locator("#beneficiaryName").inputValue(), "PACKAGED USER");
    assert.equal(await page.locator("#paymentLabel").inputValue(), "BANK 0001");
    assert.match(await page.locator("#settingsStatus").innerText(), /已就绪/);
    await page.locator("#paymentLabel").fill("");
    await page.locator("#paymentLabel").dispatchEvent("change");
    assert.match(await page.locator("#settingsStatus").innerText(), /缺少: 付款账户关键词/);
    await page.locator("#exportChromeBackup").click();
    assert.match(await page.locator("#log").innerText(), /请先填写必填设置: 付款账户关键词/);
    let calls = await page.evaluate(() => window.__utoolsCalls);
    assert.equal(calls.some((call) => call.type === "exportChromeBackup"), false);
    await page.locator("#paymentLabel").fill("BANK 0001");
    await page.locator("#paymentLabel").dispatchEvent("change");
    assert.match(await page.locator("#settingsStatus").innerText(), /已就绪/);
    await page.locator("#chooseDir").click();
    assert.equal(await page.locator("#claimDir").inputValue(), "/tmp/packaged-selected");
    await page.evaluate(() => {
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { files: [{ path: "/tmp/packaged-dropped" }] } });
      document.querySelector("#dropzone").dispatchEvent(event);
    });
    assert.equal(await page.locator("#claimDir").inputValue(), "2 个文件: packaged-a.pdf, packaged-b.pdf");
    await page.locator("#scanDir").click();
    await page.waitForFunction(() => document.querySelector("#log")?.textContent.includes("扫描完成"));
    await page.locator("#exportChromeBackup").click();
    assert.match(await page.locator("#log").innerText(), /cigna-claim-assistant-chrome-settings-backup\.json/);
    await page.locator("#openChromeSubmit").click();
    await page.locator("#openReleaseFolder").click();
    calls = await page.evaluate(() => window.__utoolsCalls);
    assert.equal(calls.some((call) => call.type === "scanDirectory" && call.options.claimDir === undefined && call.options.dir === "/tmp" && call.options.filePaths?.length === 2 && call.options.ocrEnabled === true && call.options.compressEnabled === true && call.options.organizeEnabled === true && call.options.onlyNewEnabled === true && call.options.ocrCommand === "/usr/local/bin/ocr-wrapper"), true);
    assert.equal(calls.some((call) => call.type === "exportChromeBackup" && call.settings.beneficiaryName === "PACKAGED USER"), true);
  } finally {
    await browser?.close();
  }
}
