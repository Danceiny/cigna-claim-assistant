#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { chromium } from "playwright";

const root = process.cwd();
const fixturePath = join(root, "test", "fixtures", "cigna-mock.html");
const contentScriptPath = join(root, "extension", "content", "cignaSubmitter.js");

const server = createServer(async (req, res) => {
  if (req.url.startsWith("/s/new-submitclaim")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(await readFile(fixturePath, "utf8"));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

await listen(server);
const port = server.address().port;
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/s/new-submitclaim?LanguageCode=zh_CN&language=zh_CN`);
  await page.addScriptTag({ path: contentScriptPath });
  await page.evaluate(() => {
    window.__cignaClaimSleepScale = 0.01;
  });

  const precheck = await page.evaluate(() => window.__cignaClaimSubmitter.precheckPage("TEST BENEFICIARY"));
  if (!precheck.ready) throw new Error(`Mock precheck failed: ${JSON.stringify(precheck)}`);

  const dryRunResult = await page.evaluate(async () => {
    const pdfA = btoa("%PDF-1.4 fake claim form");
    const pdfB = btoa("%PDF-1.4 fake invoice");
    return window.__cignaClaimSubmitter.submitClaims([
      {
        id: "mock-claim-dry-run",
        beneficiaryName: "TEST BENEFICIARY",
        claimDate: "2026-05-05",
        diagnosis: "LOWER-BACK-PAIN",
        paymentLabel: "BANK 0001",
        files: [
          { name: "0510_1.pdf", type: "application/pdf", base64: pdfA },
          { name: "0510_2.pdf", type: "application/pdf", base64: pdfB },
        ],
      },
    ], { dryRun: true });
  });
  const dryRun = dryRunResult.results?.[0];
  if (dryRun?.status !== "dry-run-ready" || dryRun?.dryRun !== true) {
    throw new Error(`Expected dry run to stop before final submit: ${JSON.stringify(dryRunResult)}`);
  }
  const dryRunState = await page.evaluate(() => ({
    step: window.__cignaMockState.step,
    agreed: window.__cignaMockState.agreed,
    submitted: window.__cignaMockState.submitted,
  }));
  if (dryRunState.step !== "review" || dryRunState.agreed || dryRunState.submitted) {
    throw new Error(`Dry run changed final submit state: ${JSON.stringify(dryRunState)}`);
  }

  await page.goto(`http://127.0.0.1:${port}/s/new-submitclaim?LanguageCode=zh_CN&language=zh_CN`);
  await page.addScriptTag({ path: contentScriptPath });
  await page.evaluate(() => {
    window.__cignaClaimSleepScale = 0.01;
  });

  const result = await page.evaluate(async () => {
    const pdfA = btoa("%PDF-1.4 fake claim form");
    const pdfB = btoa("%PDF-1.4 fake invoice");
    return window.__cignaClaimSubmitter.submitClaims([
      {
        id: "mock-claim-failed",
        beneficiaryName: "MISSING USER",
        claimDate: "2026-05-05",
        diagnosis: "LOWER-BACK-PAIN",
        files: [
          { name: "0511_1.pdf", type: "application/pdf", base64: pdfA },
          { name: "0511_2.pdf", type: "application/pdf", base64: pdfB },
        ],
      },
      {
        id: "mock-claim-1",
        beneficiaryName: "TEST BENEFICIARY",
        claimDate: "2026-05-05",
        diagnosis: "LOWER-BACK-PAIN",
        paymentLabel: "BANK 0001",
        files: [
          { name: "0512_1.pdf", type: "application/pdf", base64: pdfA },
          { name: "0512_2.pdf", type: "application/pdf", base64: pdfB },
        ],
      },
    ]);
  });

  if (result.results?.[0]?.status !== "failed") {
    throw new Error(`Expected first mock claim to fail: ${JSON.stringify(result)}`);
  }
  if (result.results?.[1]?.submissionId !== "99900123") {
    throw new Error(`Unexpected mock submit result: ${JSON.stringify(result)}`);
  }
  const selectedPayment = await page.evaluate(() => window.__cignaMockState.payment);
  if (selectedPayment !== "BANK 0001") {
    throw new Error(`Expected BANK 0001 payment selection, got ${selectedPayment || "(none)"}.`);
  }
  const reviewText = await page.locator("body").innerText();
  if (!reviewText.includes("理赔已提交")) throw new Error("Mock page did not reach submitted state.");
  await page.goto(`http://127.0.0.1:${port}/s/new-submitclaim?LanguageCode=zh_CN&language=zh_CN&hideSubmissionId=1&alternateUploadText=1`);
  await page.addScriptTag({ path: contentScriptPath });
  await page.evaluate(() => {
    window.__cignaClaimSleepScale = 0.01;
  });
  const missingIdResult = await page.evaluate(async () => {
    const pdfA = btoa("%PDF-1.4 fake claim form");
    const pdfB = btoa("%PDF-1.4 fake invoice");
    return window.__cignaClaimSubmitter.submitClaims([
      {
        id: "mock-claim-no-id",
        beneficiaryName: "TEST BENEFICIARY",
        claimDate: "2026-05-05",
        diagnosis: "LOWER-BACK-PAIN",
        paymentLabel: "BANK 0001",
        files: [
          { name: "0513_1.pdf", type: "application/pdf", base64: pdfA },
          { name: "0513_2.pdf", type: "application/pdf", base64: pdfB },
        ],
      },
    ]);
  });
  const noId = missingIdResult.results?.[0];
  if (noId?.status !== "submitted" || noId?.submissionIdMissing !== true || !String(noId?.submissionId || "").startsWith("success-no-id-")) {
    throw new Error(`Expected visible success without ID to be recorded as submitted: ${JSON.stringify(missingIdResult)}`);
  }
  console.log("cigna submit mock test passed");
} finally {
  await browser.close();
  server.close();
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}
