#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const listeners = [];
const storage = {};
let sentMessage;
let injected = false;
let precheckReady = true;
let activeTabUrl = "https://customer.cignaenvoy.com/s/new-submitclaim";
let tabUpdateCount = 0;
let submitCallCount = 0;

globalThis.chrome = {
  runtime: {
    onMessage: {
      addListener(listener) {
        listeners.push(listener);
      },
    },
  },
  tabs: {
    async query(query) {
      if (query.active) return [{ id: 42, url: activeTabUrl }];
      return [];
    },
    async sendMessage(tabId, message) {
      sentMessage = { tabId, message };
      if (message.type === "CIGNA_SUBMITTER_PING") {
        if (!injected) throw new Error("not injected");
        return { ok: true };
      }
      if (message.type === "CIGNA_PRECHECK_PAGE") {
        return {
          ok: true,
          precheck: {
            ready: precheckReady,
            checks: [
              { name: "submit-page-url", ok: true, detail: "mock" },
              { name: "new-claim-start", ok: precheckReady, detail: "beneficiary-step" },
              { name: "beneficiary-card", ok: precheckReady, detail: message.beneficiaryName },
            ],
          },
        };
      }
      assert.equal(message.type, "CIGNA_SUBMIT_CLAIMS");
      submitCallCount += 1;
      assert.ok(message.batchId);
      if (message.dryRun) {
        await sendRuntimeMessage({
          type: "CIGNA_SUBMISSION_PROGRESS",
          batchId: message.batchId,
          event: "claim-dry-run-ready",
          index: 0,
          total: 1,
          claim: { id: "claim-dry-run", serviceDate: "2026-05-14", claimDate: "2026-05-05" },
          result: { id: "claim-dry-run", status: "dry-run-ready", dryRun: true },
        });
        return {
          ok: true,
          results: [
            { id: "claim-dry-run", status: "dry-run-ready", dryRun: true },
          ],
        };
      }
      await sendRuntimeMessage({
        type: "CIGNA_SUBMISSION_PROGRESS",
        batchId: message.batchId,
        event: "claim-started",
        index: 0,
        total: 2,
        claim: { id: "claim-1", serviceDate: "2026-05-12", claimDate: "2026-05-05" },
      });
      await sendRuntimeMessage({
        type: "CIGNA_SUBMISSION_PROGRESS",
        batchId: message.batchId,
        event: "claim-submitted",
        index: 0,
        total: 2,
        claim: { id: "claim-1", serviceDate: "2026-05-12", claimDate: "2026-05-05" },
        result: { id: "claim-1", status: "submitted", submissionId: "99900123" },
      });
      await sendRuntimeMessage({
        type: "CIGNA_SUBMISSION_PROGRESS",
        batchId: message.batchId,
        event: "claim-failed",
        index: 1,
        total: 2,
        claim: { id: "claim-2", serviceDate: "2026-05-13", claimDate: "2026-05-05" },
        result: { id: "claim-2", status: "failed", error: "mock failure" },
      });
      return {
        ok: true,
        results: [
          { id: "claim-1", status: "submitted", submissionId: "99900123" },
          { id: "claim-2", status: "failed", error: "mock failure" },
        ],
      };
    },
    async update(tabId, update) {
      assert.equal(tabId, 42);
      if (update.url) activeTabUrl = update.url;
      tabUpdateCount += 1;
      return { id: tabId, url: activeTabUrl };
    },
    async get(tabId) {
      assert.equal(tabId, 42);
      return { id: tabId, url: activeTabUrl, status: "complete" };
    },
  },
  scripting: {
    async executeScript({ target, files }) {
      assert.equal(target.tabId, 42);
      assert.deepEqual(files, ["content/cignaSubmitter.js"]);
      injected = true;
    },
  },
  storage: {
    local: {
      async get(keys) {
        return Object.fromEntries(keys.map((key) => [key, storage[key]]));
      },
      async set(values) {
        Object.assign(storage, values);
      },
    },
  },
};

const source = await readFile(join(process.cwd(), "extension", "background.js"), "utf8");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
await import(moduleUrl);

assert.equal(listeners.length, 1);
const prepareResponse = await sendRuntimeMessage({
  type: "CIGNA_PREPARE_PAGE",
  openIfMissing: false,
  beneficiaryName: "TEST USER",
});
assert.equal(prepareResponse.ok, true);
assert.equal(prepareResponse.tabId, 42);
assert.equal(prepareResponse.ready, true);
assert.equal(prepareResponse.precheck.ready, true);
assert.equal(prepareResponse.precheck.checks.find((check) => check.name === "beneficiary-card").detail, "TEST USER");
assert.equal(injected, true);
assert.equal(tabUpdateCount, 0);
sentMessage = undefined;

activeTabUrl = "https://customer.cignaenvoy.com/s/member-home";
injected = false;
const navigatedPrepareResponse = await sendRuntimeMessage({
  type: "CIGNA_PREPARE_PAGE",
  openIfMissing: false,
  beneficiaryName: "TEST USER",
});
assert.equal(navigatedPrepareResponse.ok, true);
assert.equal(navigatedPrepareResponse.ready, true);
assert.equal(activeTabUrl, "https://customer.cignaenvoy.com/s/new-submitclaim?LanguageCode=zh_CN&language=zh_CN");
assert.equal(tabUpdateCount, 1);
assert.equal(injected, true);
sentMessage = undefined;

const response = await sendRuntimeMessage({
  type: "CIGNA_START_SUBMISSION",
  submissionFingerprint: "abc123ef",
  claims: [
    { id: "claim-1", beneficiaryName: "TEST USER", claimDate: "2026-05-05", files: [] },
    { id: "claim-2", beneficiaryName: "TEST USER", claimDate: "2026-05-05", files: [] },
  ],
  ledgerClaims: [
    {
      id: "claim-1",
      serviceDate: "2026-05-12",
      claimDate: "2026-05-05",
      submissionFingerprint: "abc123ef",
      fileNames: ["0512_1.pdf", "0512_2.pdf"],
      fileHashes: ["hash-a", "hash-b"],
    },
    {
      id: "claim-2",
      serviceDate: "2026-05-13",
      claimDate: "2026-05-05",
      fileNames: ["0513_1.pdf", "0513_2.pdf"],
      fileHashes: ["hash-c", "hash-d"],
    },
  ],
});

assert.equal(response.ok, true);
assert.equal(response.results[0].submissionId, "99900123");
assert.equal(sentMessage.tabId, 42);
assert.equal(submitCallCount, 1);
assert.equal(storage.ledger.fileHashes.length, 2);
assert.equal(storage.ledger.claimKeys[0], "claim-1");
assert.equal(storage.ledger.claimKeys.includes("claim-2"), false);
assert.deepEqual(storage.ledger.serviceDates, ["2026-05-12"]);
assert.equal(storage.ledger.submissions[0].submissionId, "99900123");
assert.equal(storage.ledger.submissions[0].submissionIdMissing, false);
assert.equal(storage.ledger.submissions[0].submissionFingerprint, "abc123ef");
assert.equal(storage.lastSubmission.results[0].submissionId, "99900123");
assert.equal(storage.submissionStatus.status, "submitted");
assert.equal(storage.submissionStatus.submissionFingerprint, "abc123ef");
assert.equal(storage.submissionStatus.submitted, 1);
assert.equal(storage.submissionStatus.failed, 1);
assert.equal(storage.submissionStatus.results[0].submissionId, "99900123");
assert.equal(storage.submissionStatus.progress[0].event, "claim-submitted");
assert.equal(storage.submissionStatus.progress[0].result.submissionId, "99900123");
assert.equal(storage.submissionStatus.progress[1].event, "claim-failed");
assert.equal(storage.submissionStatus.progress[1].result.error, "mock failure");

const ledgerBeforeDryRun = JSON.stringify(storage.ledger);
const dryRunResponse = await sendRuntimeMessage({
  type: "CIGNA_START_SUBMISSION",
  dryRun: true,
  submissionFingerprint: "dryrun123",
  claims: [
    { id: "claim-dry-run", beneficiaryName: "TEST USER", claimDate: "2026-05-05", files: [] },
  ],
  ledgerClaims: [
    {
      id: "claim-dry-run",
      serviceDate: "2026-05-14",
      claimDate: "2026-05-05",
      submissionFingerprint: "dryrun123",
      fileNames: ["0514_1.pdf", "0514_2.pdf"],
      fileHashes: ["hash-dry-a", "hash-dry-b"],
    },
  ],
});
assert.equal(dryRunResponse.ok, true);
assert.equal(dryRunResponse.results[0].status, "dry-run-ready");
assert.equal(sentMessage.message.dryRun, true);
assert.equal(JSON.stringify(storage.ledger), ledgerBeforeDryRun);
assert.equal(storage.lastSubmission.dryRun, true);
assert.equal(storage.submissionStatus.status, "dry-run-ready");
assert.equal(storage.submissionStatus.dryRunReady, 1);
assert.equal(storage.submissionStatus.submitted, 0);
assert.equal(storage.submissionStatus.progress[0].event, "claim-dry-run-ready");
assert.equal(submitCallCount, 2);

storage.submissionStatus = { status: "submitting", batchId: "active-batch", total: 1, updatedAt: new Date().toISOString() };
const duplicateStartResponse = await sendRuntimeMessage({
  type: "CIGNA_START_SUBMISSION",
  claims: [
    { id: "claim-active", beneficiaryName: "TEST USER", claimDate: "2026-05-05", files: [] },
  ],
  ledgerClaims: [],
});
assert.equal(duplicateStartResponse.ok, false);
assert.match(duplicateStartResponse.error, /已有理赔提交正在进行中/);
assert.equal(submitCallCount, 2);
storage.submissionStatus = { status: "submitting", batchId: "stale-batch", total: 1, updatedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString() };
const staleLockResponse = await sendRuntimeMessage({
  type: "CIGNA_START_SUBMISSION",
  claims: [
    { id: "claim-stale", beneficiaryName: "TEST USER", claimDate: "2026-05-05", files: [] },
  ],
  ledgerClaims: [],
});
assert.equal(staleLockResponse.ok, true);
assert.equal(submitCallCount, 3);

precheckReady = false;
sentMessage = undefined;
const blockedResponse = await sendRuntimeMessage({
  type: "CIGNA_START_SUBMISSION",
  claims: [
    { id: "claim-blocked", beneficiaryName: "MISSING USER", claimDate: "2026-05-05", files: [] },
  ],
  ledgerClaims: [],
});
assert.equal(blockedResponse.ok, false);
assert.match(blockedResponse.error, /Cigna 页面结构检查未通过/);
assert.equal(submitCallCount, 3);
assert.notEqual(sentMessage?.message?.type, "CIGNA_SUBMIT_CLAIMS");
assert.equal(storage.submissionStatus.status, "failed");
assert.match(storage.submissionStatus.error, /beneficiary-card/);
console.log("background worker tests passed");

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    listeners[0](message, {}, resolve);
  });
}
