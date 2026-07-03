#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { chromium } from "playwright";

const root = process.cwd();
const extensionDir = join(root, "extension");
const server = createServer(async (req, res) => {
  const requestPath = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
  const relativePath = requestPath === "/" ? "/popup.html" : requestPath;
  const filePath = normalize(join(extensionDir, relativePath));
  if (!filePath.startsWith(extensionDir)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  try {
    res.writeHead(200, { "content-type": contentType(filePath) });
    res.end(await readFile(filePath));
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

await listen(server);
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  await page.addInitScript((baseUrl) => {
    const listeners = [];
    const store = {
      settings: {
        beneficiaryName: "TEST USER",
        diagnosis: "BACK_PAIN",
        paymentLabel: "BANK 0001",
        ongoingConditionEarliestDate: "2026-05-05",
        minServiceDate: "2026-05-08",
        allowReview: true,
      },
      submissionStatus: {
        status: "submitted",
        updatedAt: "2026-07-01T09:00:00.000Z",
        total: 1,
        submitted: 1,
        progress: [{
          index: 0,
          event: "claim-submitted",
          claim: { id: "claim-1", serviceDate: "2026-05-12", claimDate: "2026-05-05" },
          result: { id: "claim-1", status: "submitted", submissionId: "99900123" },
        }],
        results: [{ id: "claim-1", status: "submitted", submissionId: "99900123" }],
      },
      lastSubmission: {
        at: "2026-07-01T09:00:00.000Z",
        results: [{ id: "claim-1", status: "submitted", submissionId: "99900123" }],
      },
      ledger: {
        fileHashes: ["hash-a"],
        claimKeys: ["claim-1"],
        submissions: [{ claimKey: "claim-1", submissionId: "99900123" }],
      },
    };
    const originalCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      blob.text().then((text) => {
        const parsed = JSON.parse(text);
        window.__lastExportedJson = parsed;
        if ("ledger" in parsed) window.__lastExportedLedger = parsed;
        if ("toSubmit" in parsed) window.__lastExportedPlan = parsed;
      });
      return originalCreateObjectURL(blob);
    };
    window.__chromeStore = store;
    window.chrome = {
      runtime: {
        getURL(path) {
          return `${baseUrl}/${path}`;
        },
        async sendMessage(message) {
          window.__lastRuntimeMessage = message;
          if (message.type === "CIGNA_PREPARE_PAGE") {
            return {
              ok: true,
              tabId: 1,
              ready: true,
              precheck: {
                ready: true,
                checks: [
                  { name: "submit-page-url", ok: true, detail: "mock" },
                  { name: "new-claim-start", ok: true, detail: "beneficiary-step" },
                  { name: "beneficiary-card", ok: true, detail: message.beneficiaryName },
                ],
              },
            };
          }
          if (message.type === "CIGNA_START_SUBMISSION") {
            if (message.dryRun) {
              const results = (message.claims || []).map((claim) => ({
                id: claim.id,
                status: "dry-run-ready",
                dryRun: true,
              }));
              await window.chrome.storage.local.set({
                lastSubmission: { at: new Date().toISOString(), dryRun: true, results },
                submissionStatus: {
                  status: "dry-run-ready",
                  dryRun: true,
                  dryRunReady: results.length,
                  total: results.length,
                  results,
                  updatedAt: new Date().toISOString(),
                },
              });
              return { ok: true, results };
            }
            const ledger = store.ledger || { fileHashes: [], claimKeys: [], serviceDates: [], submissions: [] };
            const fileHashes = new Set(ledger.fileHashes || []);
            const claimKeys = new Set(ledger.claimKeys || []);
            const serviceDates = new Set(ledger.serviceDates || []);
            const submissions = [...(ledger.submissions || [])];
            const results = (message.claims || []).map((claim, index) => ({
              id: claim.id,
              status: "submitted",
              submissionId: `mock-${index + 1}`,
            }));
            for (const claim of message.ledgerClaims || []) {
              claimKeys.add(claim.id);
              if (claim.serviceDate) serviceDates.add(claim.serviceDate);
              for (const hash of claim.fileHashes || []) fileHashes.add(hash);
              submissions.push({
                claimKey: claim.id,
                serviceDate: claim.serviceDate,
                claimDate: claim.claimDate,
                submissionId: "mock-1",
                fileNames: claim.fileNames || [],
              });
            }
            await window.chrome.storage.local.set({
              ledger: {
                fileHashes: [...fileHashes],
                claimKeys: [...claimKeys],
                serviceDates: [...serviceDates],
                submissions,
              },
              lastSubmission: { at: new Date().toISOString(), results },
            });
            return { ok: true, results };
          }
          return { ok: true, results: [] };
        },
      },
      tabs: {
        async create(options) {
          window.__createdTabUrl = options.url;
          return { id: 2, ...options };
        },
        async query() {
          return [{ id: 1, url: "https://customer.cignaenvoy.com/s/new-submitclaim" }];
        },
      },
      storage: {
        onChanged: {
          addListener(listener) {
            listeners.push(listener);
          },
        },
        local: {
          async get(keys) {
            if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, store[key]]));
            if (typeof keys === "string") return { [keys]: store[keys] };
            return { ...store };
          },
          async set(values) {
            const changes = {};
            for (const [key, value] of Object.entries(values)) {
              changes[key] = { oldValue: store[key], newValue: value };
              store[key] = value;
            }
            for (const listener of listeners) listener(changes, "local");
          },
        },
      },
    };
  }, origin);

  await page.goto(`${origin}/popup.html`);
  await page.waitForSelector("#diagnosis");

  assert.equal(await page.locator("#beneficiaryName").inputValue(), "TEST USER");
  assert.equal(await page.locator("#diagnosis").inputValue(), "BACK_PAIN");
  assert.equal(await page.locator("#country").inputValue(), "阿拉伯联合酋长国");
  assert.equal(await page.locator("#claimType").inputValue(), "医疗类");
  assert.equal(await page.locator("#visitType").inputValue(), "门诊");
  assert.equal(await page.locator("#paymentLabel").inputValue(), "BANK 0001");
  assert.equal(await page.locator("#minServiceDate").inputValue(), "2026-05-08");
  assert.equal(await page.locator("#autoSubmitOnSelect").isChecked(), true);
  assert.match(await page.locator("#settingsStatus").innerText(), /自动提交已就绪/);
  await page.waitForFunction(() => document.querySelector("#ledgerStatus")?.textContent.includes("1 个理赔键"));
  assert.match(await page.locator("#ledgerStatus").innerText(), /0 个提交日期，1 个理赔键，1 个文件哈希/);
  assert.equal(await page.locator("#folderFiles").evaluate((input) => input.hasAttribute("webkitdirectory")), true);
  assert.match(await page.locator(".dropzone").innerText(), /拖入 PDF\/图片\/文件夹/);
  await page.locator("#files").evaluate((input) => {
    input.addEventListener("click", () => {
      window.__fileInputClicked = true;
    }, { once: true });
  });
  await page.locator("#pickFiles").click();
  assert.equal(await page.evaluate(() => window.__fileInputClicked), true);
  assert.equal(await page.locator("#allowReview").isChecked(), true);
  assert.match(await page.locator("#folderFiles").getAttribute("accept"), /\.txt/);
  assert.match(await page.locator("#log").innerText(), /提交完成/);
  assert.match(await page.locator("#log").innerText(), /2026-05-12: 完成 #99900123/);
  await page.locator("#openAssistant").click();
  await page.waitForFunction(() => window.__createdTabUrl?.endsWith("/assistant.html"));
  await page.setViewportSize({ width: 360, height: 820 });
  await page.goto(`${origin}/assistant.html`);
  await page.waitForSelector("body.assistant-page #diagnosis");
  assert.equal(await page.locator("#openAssistant").isDisabled(), true);
  assert.equal(await page.locator("#beneficiaryName").inputValue(), "TEST USER");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.locator("#autoSubmitOnSelect").uncheck();
  await page.locator("#autoSubmitOnSelect").dispatchEvent("change");
  assert.equal(await page.locator("#autoSubmitOnSelect").isChecked(), false);
  await page.locator(".dropzone").evaluate((dropzone) => {
    const pdf = new File(["folder pdf"], "INVOICE 09.06.2026.pdf", { type: "application/pdf" });
    const ignored = new File(["ignore"], "notes.txt", { type: "text/plain" });
    const makeFileEntry = (file) => ({
      isFile: true,
      isDirectory: false,
      file(resolve) {
        resolve(file);
      },
    });
    const directoryEntry = {
      isFile: false,
      isDirectory: true,
      createReader() {
        let read = false;
        return {
          readEntries(resolve) {
            if (read) {
              resolve([]);
              return;
            }
            read = true;
            resolve([makeFileEntry(pdf), makeFileEntry(ignored)]);
          },
        };
      },
    };
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: {
        items: [{ webkitGetAsEntry: () => directoryEntry }],
        files: [],
      },
    });
    dropzone.dispatchEvent(event);
  });
  await page.waitForFunction(() => document.querySelector("#log")?.textContent.includes("1 个附件已选择"));
  assert.equal(await page.locator("#autoSubmit").isDisabled(), false);
  await page.locator("#clearBatch").click();
  assert.equal(await page.locator("#autoSubmit").isDisabled(), true);

  await page.locator("#beneficiaryName").fill("");
  await page.locator("#beneficiaryName").dispatchEvent("change");
  assert.match(await page.locator("#settingsStatus").innerText(), /缺少: 被保险人姓名/);
  await page.locator("#checkCigna").click();
  assert.match(await page.locator("#log").innerText(), /请先填写必填设置: 被保险人姓名/);
  assert.equal(await page.evaluate(() => window.__lastRuntimeMessage), undefined);
  await page.locator("#exportCignaDiagnostics").click();
  assert.match(await page.locator("#log").innerText(), /请先填写必填设置: 被保险人姓名/);
  assert.equal(await page.evaluate(() => window.__lastExportedJson?.schema), undefined);
  await page.locator("#beneficiaryName").fill("TEST USER");
  await page.locator("#beneficiaryName").dispatchEvent("change");

  await page.locator("#checkCigna").click();
  await page.waitForFunction(() => window.__lastRuntimeMessage?.type === "CIGNA_PREPARE_PAGE");
  assert.equal(await page.evaluate(() => window.__lastRuntimeMessage.openIfMissing), false);
  assert.match(await page.locator("#log").innerText(), /结构检查通过/);
  await page.locator("#exportCignaDiagnostics").click();
  await page.waitForFunction(() => window.__lastExportedJson?.schema === "cigna-page-diagnostics-v1");
  assert.equal(await page.evaluate(() => window.__lastExportedJson.ready), true);
  assert.equal(await page.evaluate(() => window.__lastExportedJson.settings.beneficiaryName), "TEST USER");
  assert.equal(await page.evaluate(() => window.__lastExportedJson.precheck.checks.find((check) => check.name === "beneficiary-card").ok), true);
  assert.equal(await page.evaluate(() => window.__chromeStore.lastCignaDiagnostics?.schema), "cigna-page-diagnostics-v1");
  assert.equal(await page.evaluate(() => window.__chromeStore.lastCignaDiagnostics?.ready), true);
  assert.match(await page.locator("#log").innerText(), /已导出 Cigna 页面诊断/);

  await page.locator("#openCigna").click();
  await page.waitForFunction(() => window.__lastRuntimeMessage?.openIfMissing === true);
  assert.equal(await page.evaluate(() => window.__lastRuntimeMessage.type), "CIGNA_PREPARE_PAGE");
  await page.evaluate(() => {
    window.__lastRuntimeMessage = undefined;
  });

  await page.setInputFiles("#files", [
    {
      name: "medical-scan.pdf",
      mimeType: "application/pdf",
      buffer: await makeBlankPdf("medical-scan"),
    },
    {
      name: "medical-scan.pdf.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Cigna claim form. Treatment Date 18/05/2026. Diagnosis lower back pain."),
    },
    {
      name: "invoice-scan.pdf",
      mimeType: "application/pdf",
      buffer: await makeBlankPdf("invoice-scan"),
    },
    {
      name: "invoice-scan.pdf.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Tax Invoice. Invoice Date 18/05/2026."),
    },
  ]);
  await page.waitForFunction(() => document.querySelector("#log")?.textContent.includes("2 个附件已选择"));
  assert.match(await page.locator("#log").innerText(), /2 个 OCR 文本/);
  await page.locator("#analyze").click();
  await page.waitForFunction(() => document.querySelector("#summary")?.textContent.includes("Ready 1"));
  assert.match(await page.locator("#claims").innerText(), /2026-05-18/);
  await page.locator("#exportPlan").click();
  await page.waitForFunction(() => window.__lastExportedPlan?.toSubmit?.[0]?.serviceDate === "2026-05-18");
  assert.deepEqual(
    await page.evaluate(() => window.__lastExportedPlan.files.map((file) => file.name).sort()),
    ["invoice-scan.pdf", "medical-scan.pdf"],
  );
  assert.equal(await page.evaluate(() => window.__lastExportedPlan.files.every((file) => file.ocr?.method === "sidecar")), true);
  await page.locator("#clearBatch").click();

  await page.locator("#diagnosis").fill("BACK_PAIN UPDATED");
  await page.locator("#diagnosis").dispatchEvent("change");
  const storedDiagnosis = await page.evaluate(() => window.__chromeStore.settings.diagnosis);
  assert.equal(storedDiagnosis, "BACK_PAIN UPDATED");
  await page.locator("#paymentLabel").fill("BANK 0001 UPDATED");
  await page.locator("#paymentLabel").dispatchEvent("change");
  assert.equal(await page.evaluate(() => window.__chromeStore.settings.paymentLabel), "BANK 0001 UPDATED");
  await page.locator("#minServiceDate").fill("2026-05-09");
  await page.locator("#minServiceDate").dispatchEvent("change");
  assert.equal(await page.evaluate(() => window.__chromeStore.settings.minServiceDate), "2026-05-09");
  await page.locator("#minServiceDate").fill("2026-05-08");
  await page.locator("#minServiceDate").dispatchEvent("change");

  await page.evaluate(() => window.chrome.storage.local.set({ settings: {} }));
  await page.reload();
  await page.waitForSelector("#diagnosis");
  assert.equal(await page.locator("#allowReview").isChecked(), true);

  await page.locator("#beneficiaryName").fill("TEST USER");
  await page.locator("#beneficiaryName").dispatchEvent("change");
  await page.locator("#diagnosis").fill("BACK_PAIN UPDATED");
  await page.locator("#diagnosis").dispatchEvent("change");
  await page.locator("#minServiceDate").fill("2026-05-08");
  await page.locator("#minServiceDate").dispatchEvent("change");
  await page.locator("#allowReview").uncheck();
  const storedAllowReview = await page.evaluate(() => window.__chromeStore.settings.allowReview);
  assert.equal(storedAllowReview, false);

  await page.locator("#exportLedger").click();
  await page.waitForFunction(() => window.__lastExportedLedger?.ledger?.claimKeys?.[0] === "claim-1");
  assert.equal(await page.evaluate(() => window.__lastExportedLedger.lastSubmission.results[0].submissionId), "99900123");
  assert.equal(await page.locator("#exportPlan").isDisabled(), true);

  await page.locator("#clearLedger").click();
  await page.waitForFunction(() => window.__chromeStore.ledger?.claimKeys?.length === 0);
  assert.deepEqual(await page.evaluate(() => window.__chromeStore.ledger.serviceDates), []);
  assert.match(await page.locator("#ledgerStatus").innerText(), /0 个提交日期，0 个理赔键，0 个文件哈希/);
  assert.equal(await page.evaluate(() => window.__chromeStore.submissionStatus), null);
  assert.equal(await page.evaluate(() => window.__chromeStore.lastSubmission), null);
  assert.equal(await page.evaluate(() => window.__chromeStore.settings.diagnosis), "BACK_PAIN UPDATED");

  await page.setInputFiles("#ledgerFile", {
    name: "cigna-claim-ledger-restore.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      ledger: {
        fileHashes: ["hash-a", "hash-imported"],
        claimKeys: ["claim-1", "claim-imported"],
        serviceDates: ["2026-05-12"],
        submissions: [
          { claimKey: "claim-1", serviceDate: "2026-05-12", submissionId: "99900123" },
          { claimKey: "claim-imported", serviceDate: "2026-05-13", submissionId: "99900124" },
        ],
      },
      lastSubmission: {
        at: "2026-07-01T10:00:00.000Z",
        results: [{ id: "claim-imported", status: "submitted", submissionId: "99900124" }],
      },
    })),
  });
  await page.waitForFunction(() => window.__chromeStore.ledger?.claimKeys?.includes("claim-imported"));
  assert.deepEqual(await page.evaluate(() => window.__chromeStore.ledger.fileHashes.sort()), ["hash-a", "hash-imported"].sort());
  assert.equal(await page.evaluate(() => window.__chromeStore.lastSubmission.results[0].submissionId), "99900124");
  assert.match(await page.locator("#ledgerStatus").innerText(), /2 个提交日期，2 个理赔键，2 个文件哈希/);
  assert.match(await page.locator("#log").innerText(), /已导入记录/);

  await page.locator("#exportCignaDiagnostics").click();
  await page.waitForFunction(() => window.__chromeStore.lastCignaDiagnostics?.schema === "cigna-page-diagnostics-v1");
  await page.locator("#exportBackup").click();
  await page.waitForFunction(() => window.__lastExportedJson?.schema === "cigna-claim-assistant-backup-v1");
  const backupPayload = await page.evaluate(() => window.__lastExportedJson);
  assert.equal(backupPayload.settings.diagnosis, "BACK_PAIN UPDATED");
  assert.equal(backupPayload.settings.minServiceDate, "2026-05-08");
  assert.equal(backupPayload.settings.allowReview, false);
  assert.equal(backupPayload.ledger.claimKeys.includes("claim-imported"), true);
  assert.equal(backupPayload.lastCignaDiagnostics.schema, "cigna-page-diagnostics-v1");
  assert.equal(backupPayload.lastCignaDiagnostics.settings.beneficiaryName, "TEST USER");
  assert.equal(backupPayload.lastSubmissionAudit, null);
  assert.equal(JSON.stringify(backupPayload).includes("data:image/"), false);

  await page.locator("#diagnosis").fill("WRONG VALUE");
  await page.locator("#diagnosis").dispatchEvent("change");
  await page.locator("#minServiceDate").fill("");
  await page.locator("#minServiceDate").dispatchEvent("change");
  await page.locator("#allowReview").check();
  await page.locator("#clearLedger").click();
  await page.waitForFunction(() => window.__chromeStore.ledger?.claimKeys?.length === 0);
  await page.evaluate(() => {
    window.__chromeStore.lastCignaDiagnostics = null;
  });
  await page.setInputFiles("#backupFile", {
    name: "cigna-claim-assistant-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backupPayload)),
  });
  await page.waitForFunction(() => window.__chromeStore.ledger?.claimKeys?.includes("claim-imported"));
  assert.equal(await page.locator("#diagnosis").inputValue(), "BACK_PAIN UPDATED");
  assert.equal(await page.locator("#minServiceDate").inputValue(), "2026-05-08");
  assert.equal(await page.locator("#allowReview").isChecked(), false);
  assert.equal(await page.evaluate(() => window.__chromeStore.settings.diagnosis), "BACK_PAIN UPDATED");
  assert.equal(await page.evaluate(() => window.__chromeStore.lastCignaDiagnostics?.schema), "cigna-page-diagnostics-v1");
  assert.match(await page.locator("#log").innerText(), /已导入完整备份/);

  const utoolsSettingsBackup = {
    schema: "cigna-claim-assistant-backup-v1",
    exportedAt: "2026-07-01T12:00:00.000Z",
    source: "utools",
    settings: {
      beneficiaryName: "UTOOLS USER",
      diagnosis: "BACK_PAIN",
      country: "阿拉伯联合酋长国",
      claimType: "医疗类",
      visitType: "门诊",
      paymentLabel: "BANK 0001",
      ongoingConditionEarliestDate: "2026-05-01",
      minServiceDate: "2026-05-08",
      allowReview: true,
      autoSubmitOnSelect: false,
    },
    ledger: {
      fileHashes: [],
      claimKeys: [],
      serviceDates: [],
      submissions: [],
    },
    submissionStatus: null,
    lastSubmission: null,
    lastSubmissionAudit: null,
    lastCignaDiagnostics: null,
  };
  await page.setInputFiles("#backupFile", {
    name: "cigna-claim-assistant-chrome-settings-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(utoolsSettingsBackup)),
  });
  await page.waitForFunction(() => window.__chromeStore.settings?.beneficiaryName === "UTOOLS USER");
  assert.equal(await page.locator("#beneficiaryName").inputValue(), "UTOOLS USER");
  assert.equal(await page.locator("#diagnosis").inputValue(), "BACK_PAIN");
  assert.equal(await page.locator("#paymentLabel").inputValue(), "BANK 0001");
  assert.equal(await page.locator("#earliestDate").inputValue(), "2026-05-01");
  assert.equal(await page.locator("#minServiceDate").inputValue(), "2026-05-08");
  assert.equal(await page.locator("#allowReview").isChecked(), true);
  assert.equal(await page.locator("#autoSubmitOnSelect").isChecked(), false);

  await page.locator("#clearLedger").click();
  await page.waitForFunction(() => window.__chromeStore.ledger?.claimKeys?.length === 0);

  await page.setInputFiles("#files", {
    name: "IMG-20260607-WA0000.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  });
  assert.match(await page.locator("#log").innerText(), /1 个附件已选择/);
  assert.equal(await page.locator("#autoSubmit").isDisabled(), false);
  assert.equal(await page.locator("#clearBatch").isDisabled(), false);
  await page.locator("#clearBatch").click();
  assert.match(await page.locator("#log").innerText(), /已清空当前批次/);
  assert.equal(await page.locator("#autoSubmit").isDisabled(), true);
  assert.equal(await page.locator("#clearBatch").isDisabled(), true);
  assert.equal(await page.locator("#exportPlan").isDisabled(), true);
  assert.equal(await page.evaluate(() => window.__chromeStore.settings.diagnosis), "BACK_PAIN");

  await page.setInputFiles("#files", [
    {
      name: "IMG-20260607-WA0000.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    },
    {
      name: "CIGNA 07.06.2026.pdf",
      mimeType: "application/pdf",
      buffer: await makePdf("Cigna claim form. Treatment Date 07/06/2026. Date of first consultation 05/05/2026. Diagnosis lower back pain."),
    },
  ]);
  assert.match(await page.locator("#log").innerText(), /2 个附件已选择/);

  await page.reload();
  await page.waitForSelector("#diagnosis");
  await page.locator("#diagnosis").fill("BACK_PAIN UPDATED");
  await page.locator("#diagnosis").dispatchEvent("change");
  await page.locator("#minServiceDate").fill("2026-05-08");
  await page.locator("#minServiceDate").dispatchEvent("change");
  await page.locator("#allowReview").uncheck();
  await page.setInputFiles("#files", {
    name: "IMG-20260607-WA0000.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  });

  await page.locator("#autoSubmit").click();
  await page.waitForFunction(() => document.querySelector("#summary")?.textContent.includes("Blocked 1"));
  assert.match(await page.locator("#summary").innerText(), /将提交 0 \/ 将跳过 1 \/ 需压缩 0/);
  assert.match(await page.locator("#claims").innerText(), /只有图片/);
  await page.waitForFunction(() => document.querySelector("#log")?.textContent.includes("自动处理已停止"));
  assert.match(await page.locator("#log").innerText(), /自动处理已停止/);
  assert.equal(await page.evaluate(() => window.__lastRuntimeMessage), undefined);
  assert.equal(await page.locator("#exportPlan").isDisabled(), false);
  await page.locator("#exportPlan").click();
  await page.waitForFunction(() => window.__lastExportedPlan?.summary?.blocked === 1);
  assert.equal(await page.evaluate(() => window.__lastExportedPlan.toSubmit.length), 0);
  assert.equal(await page.evaluate(() => window.__lastExportedPlan.settings.minServiceDate), "2026-05-08");
  assert.equal(await page.evaluate(() => window.__lastExportedPlan.blocked[0].serviceDate), "2026-06-07");

  await page.reload();
  await page.waitForSelector("#diagnosis");
  await page.locator("#diagnosis").fill("BACK_PAIN UPDATED");
  await page.locator("#diagnosis").dispatchEvent("change");
  await page.locator("#minServiceDate").fill("2026-05-08");
  await page.locator("#minServiceDate").dispatchEvent("change");
  await page.locator("#allowReview").check();
  await page.setInputFiles("#files", [
    {
      name: "scan-a.pdf",
      mimeType: "application/pdf",
      buffer: await makeBlankPdf("scan-a"),
    },
    {
      name: "scan-b.pdf",
      mimeType: "application/pdf",
      buffer: await makeBlankPdf("scan-b"),
    },
  ]);
  await page.locator("#analyze").click();
  await page.waitForFunction(() => document.querySelector("#summary")?.textContent.includes("Blocked 1"));
  await page.waitForFunction(() => [...document.querySelectorAll(".file-thumb")].filter((image) => image.getAttribute("src")?.startsWith("data:image/")).length >= 2);
  assert.equal(await page.locator(".file-thumb").count(), 2);
  assert.match(await page.locator("#claims").innerText(), /未识别服务日期|无法识别服务日期/);
  await setFileOverride(page, "scan-a.pdf", {
    kind: "claim-form",
    serviceDate: "2026-05-14",
    earliestTreatmentDate: "2026-05-05",
  });
  await setFileOverride(page, "scan-b.pdf", {
    kind: "invoice",
    serviceDate: "2026-05-14",
  });
  await page.waitForFunction(() => document.querySelector("#summary")?.textContent.includes("Review 1"));
  await page.locator("#exportPlan").click();
  await page.waitForFunction(() => window.__lastExportedPlan?.files?.some((file) => file.overrideServiceDate === "2026-05-14"));
  assert.equal(await page.evaluate(() => window.__lastExportedPlan.toSubmit.length), 1);
  assert.equal(await page.evaluate(() => window.__lastExportedPlan.toSubmit[0].serviceDate), "2026-05-14");
  assert.deepEqual(await page.evaluate(() => window.__lastExportedPlan.files.map((file) => file.hasThumbnail)), [true, true]);
  assert.equal(await page.evaluate(() => window.__lastExportedPlan.files.some((file) => "thumbnailDataUrl" in file)), false);
  assert.deepEqual(
    await page.evaluate(() => window.__lastExportedPlan.files.map((file) => [file.name, file.overrideKind, file.overrideServiceDate]).sort()),
    [["scan-a.pdf", "claim-form", "2026-05-14"], ["scan-b.pdf", "invoice", "2026-05-14"]],
  );
  await page.locator("#clearBatch").click();
  await page.waitForFunction(() => document.querySelector("#summary")?.textContent === "");

  await page.locator("#allowReview").check();
  await page.evaluate(() => {
    window.__lastRuntimeMessage = undefined;
  });
  await page.setInputFiles("#files", [
    {
      name: "CIGNA 10.05.2026.pdf",
      mimeType: "application/pdf",
      buffer: await makePdf("Cigna claim form. Treatment Date 10/05/2026. Date of first consultation 05/05/2026. Diagnosis lower back pain."),
    },
    {
      name: "INVOICE 10.05.2026.pdf",
      mimeType: "application/pdf",
      buffer: await makePdf("Tax Invoice. Invoice Date 10/05/2026."),
    },
    {
      name: "MISC 10.05.2026.pdf",
      mimeType: "application/pdf",
      buffer: await makePdf("This attachment is not classifiable."),
    },
  ]);
  await page.locator("#autoSubmit").click();
  await page.waitForFunction(() => document.querySelector("#log")?.textContent.includes("review 需要人工确认"));
  assert.match(await page.locator("#summary").innerText(), /Review 1/);
  assert.match(await page.locator("#summary").innerText(), /将提交 0 \/ 将跳过 1 \/ 需压缩 0/);
  assert.equal(await page.evaluate(() => window.__lastRuntimeMessage), undefined);
  await page.locator(".file-override", { hasText: "MISC 10.05.2026.pdf" }).locator(".file-remove").click();
  await page.waitForFunction(() => document.querySelector("#log")?.textContent.includes("已移除文件: MISC 10.05.2026.pdf"));
  assert.equal(/MISC 10\.05\.2026/.test(await page.locator("#claims").innerText()), false);
  await page.locator("#exportPlan").click();
  await page.waitForFunction(() => window.__lastExportedPlan?.toSubmit?.[0]?.serviceDate === "2026-05-10");
  assert.match(await page.locator("#summary").innerText(), /将提交 1/);
  assert.equal(await page.evaluate(() => window.__lastExportedPlan.files.some((file) => file.name.includes("MISC"))), false);

  await page.reload();
  await page.waitForSelector("#diagnosis");
  await page.locator("#diagnosis").fill("BACK_PAIN UPDATED");
  await page.locator("#diagnosis").dispatchEvent("change");
  await page.locator("#minServiceDate").fill("2026-05-08");
  await page.locator("#minServiceDate").dispatchEvent("change");
  await page.locator("#allowReview").check();
  await page.locator("#paymentLabel").fill("");
  await page.locator("#paymentLabel").dispatchEvent("change");
  await page.evaluate(() => {
    window.__lastRuntimeMessage = undefined;
  });
  await page.setInputFiles("#files", [
    {
      name: "CIGNA 12.05.2026.pdf",
      mimeType: "application/pdf",
      buffer: await makePdf("Cigna claim form. Treatment Date 12/05/2026. Date of first consultation 05/05/2026. Diagnosis lower back pain."),
    },
    {
      name: "INVOICE 12.05.2026.pdf",
      mimeType: "application/pdf",
      buffer: await makePdf("Tax Invoice. Invoice Date 12/05/2026."),
    },
    {
      name: "IMG-20260607-WA0000.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    },
  ]);
  await page.waitForFunction(() => document.querySelector("#log")?.textContent.includes("自动提交未启动"));
  assert.match(await page.locator("#log").innerText(), /自动提交未启动: 缺少 付款账户关键词/);
  assert.equal(await page.evaluate(() => window.__lastRuntimeMessage), undefined);
  await page.locator("#autoSubmit").click();
  await page.waitForFunction(() => document.querySelector("#log")?.textContent.includes("付款账户关键词"));
  assert.match(await page.locator("#log").innerText(), /请先填写必填设置: 付款账户关键词/);
  assert.equal(await page.evaluate(() => window.__lastRuntimeMessage), undefined);
  await page.locator("#paymentLabel").fill("BANK 0001");
  await page.locator("#paymentLabel").dispatchEvent("change");
  await page.locator("#earliestDate").fill("");
  await page.locator("#earliestDate").dispatchEvent("change");
  await page.locator("#analyze").click();
  await page.waitForFunction(() => !document.querySelector("#preflightSubmit")?.disabled);
  await page.locator("#preflightSubmit").click();
  await page.waitForFunction(() => window.__lastExportedJson?.schema === "cigna-submit-preflight-v1");
  assert.equal(await page.evaluate(() => window.__lastExportedJson.claims.length), 1);
  assert.equal(await page.evaluate(() => window.__lastExportedJson.claims[0].beneficiaryName), "TEST USER");
  assert.equal(await page.evaluate(() => window.__lastExportedJson.claims[0].paymentLabel), "BANK 0001");
  assert.equal(await page.evaluate(() => window.__lastExportedJson.claims[0].claimDateSource), "file-text");
  assert.equal(await page.evaluate(() => window.__lastExportedJson.claims[0].files.length), 2);
  assert.deepEqual(await page.evaluate(() => window.__lastExportedJson.claims[0].files.map((file) => file.uploadOrder)), [1, 2]);
  assert.match(await page.evaluate(() => window.__lastExportedJson.submissionFingerprint), /^[0-9a-f]{8}$/);
  assert.equal(await page.evaluate(() => window.__lastExportedJson.ledgerClaims[0].submissionFingerprint), await page.evaluate(() => window.__lastExportedJson.submissionFingerprint));
  assert.equal(await page.evaluate(() => window.__lastExportedJson.claims[0].files.some((file) => "base64" in file)), false);
  assert.match(await page.locator("#log").innerText(), /提交预检通过/);
  assert.equal(await page.evaluate(() => window.__lastRuntimeMessage), undefined);
  assert.equal(await page.locator("#dryRunSubmit").isDisabled(), false);
  const ledgerBeforeDryRun = await page.evaluate(() => JSON.stringify(window.__chromeStore.ledger || {}));
  await page.locator("#dryRunSubmit").click();
  await page.waitForFunction(() => window.__lastRuntimeMessage?.type === "CIGNA_START_SUBMISSION" && window.__lastRuntimeMessage?.dryRun === true);
  const dryRunMessage = await page.evaluate(() => window.__lastRuntimeMessage);
  assert.equal(dryRunMessage.claims.length, 1);
  assert.equal(dryRunMessage.ledgerClaims[0].submissionFingerprint, await page.evaluate(() => window.__lastExportedJson.submissionFingerprint));
  assert.equal(await page.evaluate(() => window.__chromeStore.lastSubmission?.dryRun), true);
  assert.equal(await page.evaluate(() => window.__chromeStore.submissionStatus?.status), "dry-run-ready");
  assert.equal(await page.evaluate(() => JSON.stringify(window.__chromeStore.ledger || {})), ledgerBeforeDryRun);
  assert.match(await page.locator("#log").innerText(), /真实页面彩排/);
  await page.evaluate(() => {
    window.__lastRuntimeMessage = undefined;
  });
  await page.evaluate(() => {
    window.__chromeStore.submissionStatus = {
      status: "submitting",
      updatedAt: new Date().toISOString(),
      total: 1,
      current: 1,
    };
  });
  await page.locator("#autoSubmit").click();
  await page.waitForFunction(() => document.querySelector("#log")?.textContent.includes("已有理赔提交正在进行中"));
  assert.equal(await page.evaluate(() => window.__lastRuntimeMessage), undefined);
  await page.evaluate(() => {
    window.__chromeStore.submissionStatus = {
      status: "submitting",
      updatedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
      total: 1,
      current: 1,
    };
  });
  await page.locator("#autoSubmit").click();
  await page.waitForFunction(() => window.__lastRuntimeMessage?.type === "CIGNA_START_SUBMISSION");
  await page.waitForFunction(() => document.querySelector("#summary")?.textContent.includes("将提交 0"));
  assert.match(await page.locator("#summary").innerText(), /将提交 0 \/ 将跳过 1 \/ 需压缩 0/);
  assert.match(await page.locator("#summary").innerText(), /Duplicate 2/);
  assert.match(await page.locator("#log").innerText(), /自动处理将跳过: 2026-06-07 blocked/);
  const submitMessage = await page.evaluate(() => window.__lastRuntimeMessage);
  const preflightFingerprint = await page.evaluate(() => window.__lastExportedJson.submissionFingerprint);
  assert.equal(submitMessage.submissionFingerprint, preflightFingerprint);
  assert.equal(submitMessage.ledgerClaims[0].submissionFingerprint, preflightFingerprint);
  assert.equal(submitMessage.claims.length, 1);
  assert.equal(submitMessage.claims[0].beneficiaryName, "TEST USER");
  assert.equal(submitMessage.claims[0].diagnosis, "BACK_PAIN UPDATED");
  assert.equal(submitMessage.claims[0].country, "阿拉伯联合酋长国");
  assert.equal(submitMessage.claims[0].claimType, "医疗类");
  assert.equal(submitMessage.claims[0].visitType, "门诊");
  assert.equal(submitMessage.claims[0].paymentLabel, "BANK 0001");
  assert.equal(submitMessage.claims[0].claimDate, "2026-05-05");
  assert.equal(submitMessage.claims[0].claimDateSource, "file-text");
  assert.equal(submitMessage.claims[0].files.length, 2);
  assert.deepEqual(submitMessage.claims[0].files.map((file) => file.uploadOrder), [1, 2]);
  assert.deepEqual(submitMessage.ledgerClaims[0].uploadOrder.map((file) => `${file.order}:${file.kind}`), ["1:claim-form", "2:invoice"]);
  const submissionAudit = await page.evaluate(() => window.__chromeStore.lastSubmissionAudit);
  assert.equal(submissionAudit.schema, "cigna-submission-audit-v1");
  assert.equal(submissionAudit.submissionFingerprint, preflightFingerprint);
  assert.equal(submissionAudit.counts.submit, 1);
  assert.equal(submissionAudit.counts.skipped, 1);
  assert.equal(submissionAudit.counts.compressionPending, 0);
  assert.equal(submissionAudit.submit[0].serviceDate, "2026-05-12");
  assert.equal(submissionAudit.submit[0].claimDateSource, "file-text");
  assert.deepEqual(submissionAudit.submit[0].files.map((file) => file.uploadOrder), [1, 2]);
  assert.equal(submissionAudit.skipped[0].serviceDate, "2026-06-07");
  assert.match(await page.locator("#log").innerText(), /提交批次快照/);
  await page.locator("#exportPlan").click();
  await page.waitForFunction(() => window.__lastExportedPlan?.duplicates?.length === 2);
  assert.equal(await page.evaluate(() => window.__lastExportedPlan.toSubmit.length), 0);
  assert.equal(await page.evaluate(() => window.__lastExportedPlan.skipped.length), 1);
  assert.equal(await page.evaluate(() => window.__lastExportedPlan.lastSubmissionAudit?.submissionFingerprint), preflightFingerprint);

  await page.evaluate(() => {
    window.__lastRuntimeMessage = undefined;
  });
  await page.reload();
  await page.waitForSelector("#diagnosis");
  await page.locator("#diagnosis").fill("BACK_PAIN UPDATED");
  await page.locator("#diagnosis").dispatchEvent("change");
  await page.locator("#minServiceDate").fill("2026-05-08");
  await page.locator("#minServiceDate").dispatchEvent("change");
  await page.locator("#allowReview").check();
  await page.locator("#autoSubmitOnSelect").uncheck();
  await page.locator("#autoSubmitOnSelect").dispatchEvent("change");
  const largeClaimPdf = await makePaddedPdf("Cigna claim form. Treatment Date 13/05/2026. Date of first consultation 05/05/2026. Diagnosis lower back pain.");
  await page.setInputFiles("#files", [
    {
      name: "CIGNA 13.05.2026.pdf",
      mimeType: "application/pdf",
      buffer: largeClaimPdf,
    },
    {
      name: "INVOICE 13.05.2026.pdf",
      mimeType: "application/pdf",
      buffer: await makePdf("Tax Invoice. Invoice Date 13/05/2026."),
    },
  ]);
  await page.locator("#analyze").click();
  await page.waitForFunction(() => document.querySelector("#summary")?.textContent.includes("需压缩 1"));
  await page.locator("#exportPlan").click();
  await page.waitForFunction(() => window.__lastExportedPlan?.compression?.[0]?.serviceDate === "2026-05-13");
  assert.match(await page.evaluate(() => window.__lastExportedPlan.compression[0].sizeLabel), /MB/);
  assert.match(await page.evaluate(() => window.__lastExportedPlan.compression[0].targetLabel), /MB|KB/);
  assert.match(await page.evaluate(() => window.__lastExportedPlan.compression[0].projectedTotalLabel), /MB|KB/);
  await page.locator("#autoSubmit").click();
  await page.waitForFunction(() => window.__lastRuntimeMessage?.type === "CIGNA_START_SUBMISSION");
  await page.waitForFunction(() => document.querySelector("#summary")?.textContent.includes("将提交 0"));
  assert.match(await page.locator("#summary").innerText(), /将提交 0 \/ 将跳过 0 \/ 需压缩 0/);
  assert.match(await page.locator("#summary").innerText(), /Duplicate 2/);
  const compressedSubmitMessage = await page.evaluate(() => window.__lastRuntimeMessage);
  assert.equal(compressedSubmitMessage.claims.length, 1);
  assert.equal(compressedSubmitMessage.claims[0].files[0].uploadOrder, 1);
  assert.match(compressedSubmitMessage.claims[0].files[0].name, /-compressed\.pdf$/);
  assert.ok(Buffer.from(compressedSubmitMessage.claims[0].files[0].base64, "base64").byteLength < largeClaimPdf.byteLength);
  assert.equal(compressedSubmitMessage.ledgerClaims.length, 1);
  assert.equal(compressedSubmitMessage.ledgerClaims[0].fileHashes.length, 3);
  assert.ok(new Set(compressedSubmitMessage.ledgerClaims[0].fileHashes).size === 3);
  const compressedAudit = await page.evaluate(() => window.__chromeStore.lastSubmissionAudit);
  assert.equal(compressedAudit.counts.submit, 1);
  assert.equal(compressedAudit.counts.compressionPending, 0);
  assert.match(compressedAudit.submit[0].files[0].name, /-compressed\.pdf$/);
  await page.locator("#exportCignaDiagnostics").click();
  await page.waitForFunction(() => window.__chromeStore.lastCignaDiagnostics?.schema === "cigna-page-diagnostics-v1");
  await page.locator("#exportBackup").click();
  await page.waitForFunction(() => window.__lastExportedJson?.schema === "cigna-claim-assistant-backup-v1" && window.__lastExportedJson?.lastSubmissionAudit?.counts?.submit === 1);
  assert.match(await page.evaluate(() => window.__lastExportedJson.lastSubmissionAudit.submit[0].files[0].name), /-compressed\.pdf$/);
  assert.equal(await page.evaluate(() => window.__lastExportedJson.lastCignaDiagnostics?.schema), "cigna-page-diagnostics-v1");

  await page.evaluate(() => {
    window.__lastRuntimeMessage = undefined;
    window.__chromeStore.ledger = { fileHashes: [], claimKeys: [], serviceDates: [], submissions: [] };
    window.__chromeStore.submissionStatus = null;
    window.__chromeStore.lastSubmission = null;
  });
  await page.reload();
  await page.waitForSelector("#diagnosis");
  await page.locator("#beneficiaryName").fill("TEST USER");
  await page.locator("#beneficiaryName").dispatchEvent("change");
  await page.locator("#diagnosis").fill("BACK_PAIN UPDATED");
  await page.locator("#diagnosis").dispatchEvent("change");
  await page.locator("#paymentLabel").fill("BANK 0001");
  await page.locator("#paymentLabel").dispatchEvent("change");
  await page.locator("#allowReview").check();
  await page.locator("#autoSubmitOnSelect").check();
  await page.locator("#autoSubmitOnSelect").dispatchEvent("change");
  assert.equal(await page.evaluate(() => window.__chromeStore.settings.autoSubmitOnSelect), true);
  await page.setInputFiles("#files", [
    {
      name: "CIGNA 18.05.2026.pdf",
      mimeType: "application/pdf",
      buffer: await makePdf("Cigna claim form. Treatment Date 18/05/2026. Date of first consultation 05/05/2026. Diagnosis lower back pain."),
    },
    {
      name: "INVOICE 18.05.2026.pdf",
      mimeType: "application/pdf",
      buffer: await makePdf("Tax Invoice. Invoice Date 18/05/2026."),
    },
  ]);
  await page.waitForFunction(() => window.__lastRuntimeMessage?.type === "CIGNA_START_SUBMISSION");
  const autoRunMessage = await page.evaluate(() => window.__lastRuntimeMessage);
  assert.equal(autoRunMessage.claims.length, 1);
  assert.equal(autoRunMessage.claims[0].serviceDate, "2026-05-18");
  assert.equal(autoRunMessage.claims[0].claimDate, "2026-05-05");
  assert.equal(autoRunMessage.claims[0].claimDateSource, "file-text");
  assert.equal(autoRunMessage.claims[0].files.length, 2);
  console.log("popup smoke test passed");
} finally {
  await browser.close();
  server.close();
}

async function makePdf(text) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 48, y: 720, size: 12, font });
  return Buffer.from(await doc.save());
}

async function makeBlankPdf(title = "blank") {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}

async function makePaddedPdf(text) {
  const pdf = await makePdf(text);
  const padding = new Uint8Array(7 * 1024 * 1024);
  let value = 0x12345678;
  for (let i = 0; i < padding.length; i += 1) {
    value = (value * 1664525 + 1013904223) >>> 0;
    padding[i] = value & 0xff;
  }
  return Buffer.concat([pdf, Buffer.from(padding)]);
}

async function setFileOverride(page, fileName, overrides = {}) {
  const row = page.locator(".file-override", { hasText: fileName }).first();
  if (overrides.kind != null) {
    await row.locator('select[data-field="overrideKind"]').selectOption(overrides.kind);
    await page.waitForFunction((name) => document.querySelector("#log")?.textContent.includes(name), fileName);
  }
  if (overrides.serviceDate != null) {
    await page.locator(".file-override", { hasText: fileName }).first().locator('input[data-field="overrideServiceDate"]').fill(overrides.serviceDate);
    await page.locator(".file-override", { hasText: fileName }).first().locator('input[data-field="overrideServiceDate"]').dispatchEvent("change");
    await page.waitForFunction((name) => document.querySelector("#log")?.textContent.includes(name), fileName);
  }
  if (overrides.earliestTreatmentDate != null) {
    await page.locator(".file-override", { hasText: fileName }).first().locator('input[data-field="overrideEarliestTreatmentDate"]').fill(overrides.earliestTreatmentDate);
    await page.locator(".file-override", { hasText: fileName }).first().locator('input[data-field="overrideEarliestTreatmentDate"]').dispatchEvent("change");
    await page.waitForFunction((name) => document.querySelector("#log")?.textContent.includes(name), fileName);
  }
}

function listen(serverToStart) {
  return new Promise((resolve) => serverToStart.listen(0, "127.0.0.1", resolve));
}

function contentType(path) {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
