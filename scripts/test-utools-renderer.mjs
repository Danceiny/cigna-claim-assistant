#!/usr/bin/env node
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { chromium } from "playwright";

const root = process.cwd();
const pageUrl = pathToFileURL(join(root, "utools", "index.html")).href;
let browser;

try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("pageerror", (error) => {
    throw error;
  });
  await page.addInitScript(() => {
    window.__utoolsCalls = [];
    window.cignaAssistant = {
      loadSettings() {
        return {
          beneficiaryName: "TEST USER",
          diagnosis: "BACK_PAIN",
          country: "阿拉伯联合酋长国",
          claimType: "医疗类",
          visitType: "门诊",
          paymentLabel: "BANK 0001",
          minServiceDate: "2026-05-08",
          earliestDate: "2026-05-01",
          claimDir: "/tmp/claims",
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
        return "/tmp/selected-claims";
      },
      async directoryFromDrop() {
        window.__utoolsCalls.push({ type: "directoryFromDrop" });
        return "/tmp/dropped-claims";
      },
      async inputFromDrop() {
        window.__utoolsCalls.push({ type: "inputFromDrop" });
        return {
          dir: "/tmp",
          filePaths: ["/tmp/drop-a.pdf", "/tmp/drop-b.pdf"],
          label: "2 个文件: drop-a.pdf, drop-b.pdf",
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
        return { ok: true, dir, count: 42 };
      },
      exportChromeBackup(settings) {
        window.__utoolsCalls.push({ type: "exportChromeBackup", settings });
        return {
          ok: true,
          output: "/tmp/outputs/cigna-claim-assistant-chrome-settings-backup.json",
        };
      },
      openChromeSubmit() {
        window.__utoolsCalls.push({ type: "openChromeSubmit" });
      },
      openReleaseFolder() {
        window.__utoolsCalls.push({ type: "openReleaseFolder" });
      },
    };
  });

  await page.goto(pageUrl);
  await page.waitForSelector("#scanDir");
  assert.equal(await page.locator("#beneficiaryName").inputValue(), "TEST USER");
  assert.equal(await page.locator("#diagnosis").inputValue(), "BACK_PAIN");
  assert.equal(await page.locator("#paymentLabel").inputValue(), "BANK 0001");
  assert.equal(await page.locator("#minServiceDate").inputValue(), "2026-05-08");
  assert.equal(await page.locator("#earliestDate").inputValue(), "2026-05-01");
  assert.equal(await page.locator("#claimDir").inputValue(), "/tmp/claims");
  assert.equal(await page.locator("#ocrEnabled").isChecked(), true);
  assert.equal(await page.locator("#compressEnabled").isChecked(), true);
  assert.equal(await page.locator("#organizeEnabled").isChecked(), true);
  assert.equal(await page.locator("#onlyNewEnabled").isChecked(), true);
  assert.equal(await page.locator("#ocrCommand").inputValue(), "/usr/local/bin/ocr-wrapper");
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
  assert.equal(await page.locator("#claimDir").inputValue(), "/tmp/selected-claims");

  await page.evaluate(() => {
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { files: [{ path: "/tmp/dropped-claims" }] },
    });
    document.querySelector("#dropzone").dispatchEvent(event);
  });
  assert.equal(await page.locator("#claimDir").inputValue(), "2 个文件: drop-a.pdf, drop-b.pdf");
  assert.match(await page.locator("#log").innerText(), /已选择 2 个文件/);

  await page.locator("#scanDir").click();
  await page.waitForFunction(() => document.querySelector("#log")?.textContent.includes("扫描完成"));
  assert.match(await page.locator("#log").innerText(), /utools-claim-plan\.json/);
  await page.locator("#baselineDir").click();
  assert.match(await page.locator("#log").innerText(), /已建立目录基线/);

  await page.locator("#exportChromeBackup").click();
  assert.match(await page.locator("#log").innerText(), /cigna-claim-assistant-chrome-settings-backup\.json/);

  await page.locator("#openChromeSubmit").click();
  assert.match(await page.locator("#log").innerText(), /已打开 Cigna/);
  await page.locator("#openReleaseFolder").click();

  calls = await page.evaluate(() => window.__utoolsCalls);
  assert.equal(calls.some((call) => call.type === "chooseDirectory"), true);
  assert.equal(calls.some((call) => call.type === "inputFromDrop"), true);
  assert.equal(calls.some((call) => call.type === "scanDirectory" && call.options.paymentLabel === "BANK 0001" && call.options.dir === "/tmp" && call.options.filePaths?.length === 2 && call.options.ocrEnabled === true && call.options.compressEnabled === true && call.options.organizeEnabled === true && call.options.onlyNewEnabled === true && call.options.ocrCommand === "/usr/local/bin/ocr-wrapper"), true);
  assert.equal(calls.some((call) => call.type === "saveFolderState" && call.dir === "/tmp"), true);
  assert.equal(calls.some((call) => call.type === "exportChromeBackup" && call.settings.beneficiaryName === "TEST USER"), true);
  assert.equal(calls.some((call) => call.type === "openChromeSubmit"), true);
  assert.equal(calls.some((call) => call.type === "openReleaseFolder"), true);
} finally {
  await browser?.close();
}

console.log("uTools renderer smoke test passed");
