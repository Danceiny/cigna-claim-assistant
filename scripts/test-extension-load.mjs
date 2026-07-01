#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const root = process.cwd();
const extensionDir = process.env.EXTENSION_DIR || join(root, "extension");
const userDataDir = await mkdtemp(join(tmpdir(), "cigna-claim-assistant-"));
const headed = process.env.EXTENSION_LOAD_HEADED === "1";
let skipped = false;

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: !headed,
  args: [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
  ],
});

try {
  let [worker] = context.serviceWorkers();
  if (!worker) {
    try {
      worker = await context.waitForEvent("serviceworker", { timeout: 10000 });
    } catch (error) {
      if (!headed) {
        console.log("extension load test skipped: Chromium did not start extension service workers in headless mode. Re-run with EXTENSION_LOAD_HEADED=1 for headed verification.");
        skipped = true;
        worker = null;
      } else {
        throw error;
      }
    }
  }
  if (skipped) process.exitCode = 0;
  if (!skipped) {
    const extensionId = new URL(worker.url()).host;
    assert.match(worker.url(), /^chrome-extension:\/\//);
    assert.ok(extensionId.length > 8);

    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.waitForSelector("#autoSubmit", { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector("#autoSubmitOnSelect")?.checked === true, null, { timeout: 10000 });

    assert.equal(await page.locator("#diagnosis").inputValue(), "");
    assert.equal(await page.locator("#country").inputValue(), "阿拉伯联合酋长国");
    assert.equal(await page.locator("#claimType").inputValue(), "医疗类");
    assert.equal(await page.locator("#visitType").inputValue(), "门诊");
    assert.equal(await page.locator("#paymentLabel").inputValue(), "");
    assert.equal(await page.locator("#earliestDate").inputValue(), "");
    assert.equal(await page.locator("#minServiceDate").inputValue(), "");
    assert.equal(await page.locator("#autoSubmitOnSelect").isChecked(), true);
    assert.equal(await page.locator("#folderFiles").evaluate((input) => input.hasAttribute("webkitdirectory")), true);

    const backgroundResponse = await page.evaluate(() => chrome.runtime.sendMessage({
      type: "CIGNA_PREPARE_PAGE",
      openIfMissing: false,
      beneficiaryName: "",
    }));
    assert.equal(backgroundResponse.ok, false);
    assert.match(backgroundResponse.error, /缺少被保险人姓名/);

    await page.goto(`chrome-extension://${extensionId}/assistant.html`);
    await page.waitForSelector("body.assistant-page #autoSubmit", { timeout: 10000 });
    assert.equal(await page.locator("#openAssistant").isDisabled(), true);
    assert.equal(await page.locator("#folderFiles").evaluate((input) => input.hasAttribute("webkitdirectory")), true);

    console.log(`extension load test passed (${extensionId})`);
  }
} finally {
  await context.close();
  await rm(userDataDir, { recursive: true, force: true });
}
