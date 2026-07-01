const CIGNA_CLAIM_URL = "https://customer.cignaenvoy.com/s/new-submitclaim?LanguageCode=zh_CN&language=zh_CN";
const ACTIVE_SUBMISSION_TTL_MS = 6 * 60 * 60 * 1000;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "CIGNA_SUBMISSION_PROGRESS") {
    handleSubmissionProgress(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "CIGNA_PREPARE_PAGE") {
    prepareCignaPage({
      openIfMissing: Boolean(message.openIfMissing),
      beneficiaryName: message.beneficiaryName,
    })
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type !== "CIGNA_START_SUBMISSION") return undefined;
  startSubmission(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function startSubmission(message) {
  const claims = message.claims || [];
  const ledgerClaims = message.ledgerClaims || [];
  const submissionFingerprint = message.submissionFingerprint || "";
  const dryRun = Boolean(message.dryRun);
  if (!claims.length) throw new Error("没有可提交的理赔单。");
  const beneficiaryName = claims[0]?.beneficiaryName?.trim();
  if (!beneficiaryName) throw new Error("缺少被保险人姓名，不能检查 Cigna 页面。");
  const { submissionStatus } = await chrome.storage.local.get(["submissionStatus"]);
  if (isActiveSubmissionStatus(submissionStatus)) {
    throw new Error(`已有理赔提交正在进行中: ${submissionStatus.status}`);
  }
  const batchId = `batch-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  await writeSubmissionStatus("queued", { batchId, total: claims.length, submissionFingerprint, dryRun, progress: [] });
  try {
    await writeSubmissionStatus("opening-tab", { batchId, total: claims.length, submissionFingerprint, dryRun, progress: [] });
    const tab = await prepareClaimTab(await findCignaTab({ openIfMissing: true }));
    await writeSubmissionStatus("injecting", { batchId, total: claims.length, submissionFingerprint, dryRun, tabId: tab.id, progress: [] });
    await ensureSubmitterInjected(tab.id);
    await writeSubmissionStatus("prechecking", { batchId, total: claims.length, submissionFingerprint, dryRun, tabId: tab.id, progress: [] });
    await assertCignaPageReady(tab.id, beneficiaryName);
    await writeSubmissionStatus(dryRun ? "dry-running" : "submitting", { batchId, total: claims.length, submissionFingerprint, dryRun, tabId: tab.id, progress: [] });
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "CIGNA_SUBMIT_CLAIMS",
      batchId,
      dryRun,
      claims,
    });
    if (!response?.ok) throw new Error(response?.error || "Cigna 页面提交失败。");
    if (!dryRun) await recordSubmittedClaims(ledgerClaims, response.results || []);
    const lastSubmission = {
      at: new Date().toISOString(),
      dryRun,
      results: response.results || [],
    };
    await chrome.storage.local.set({ lastSubmission });
    const { submissionStatus } = await chrome.storage.local.get(["submissionStatus"]);
    await writeSubmissionStatus(dryRun ? "dry-run-ready" : "submitted", {
      batchId,
      total: claims.length,
      submissionFingerprint,
      dryRun,
      submitted: (response.results || []).filter((result) => result.status === "submitted").length,
      dryRunReady: (response.results || []).filter((result) => result.status === "dry-run-ready").length,
      failed: (response.results || []).filter((result) => result.status === "failed").length,
      results: response.results || [],
      progress: submissionStatus?.batchId === batchId ? submissionStatus.progress || [] : [],
    });
    return response;
  } catch (error) {
    await writeSubmissionStatus("failed", {
      batchId,
      total: claims.length,
      submissionFingerprint,
      dryRun,
      error: error.message,
    });
    throw error;
  }
}

async function prepareCignaPage(options = {}) {
  if (!options.beneficiaryName?.trim()) throw new Error("缺少被保险人姓名，不能检查 Cigna 页面。");
  const tab = await prepareClaimTab(await findCignaTab(options));
  await ensureSubmitterInjected(tab.id);
  const precheck = await chrome.tabs.sendMessage(tab.id, {
    type: "CIGNA_PRECHECK_PAGE",
    beneficiaryName: options.beneficiaryName.trim(),
  });
  return {
    tabId: tab.id,
    url: tab.url || CIGNA_CLAIM_URL,
    ready: Boolean(precheck?.precheck?.ready),
    precheck: precheck?.precheck || null,
  };
}

async function assertCignaPageReady(tabId, beneficiaryName) {
  let precheck = await runPrecheck(tabId, beneficiaryName);
  if (precheck?.precheck?.ready) return precheck.precheck;

  if (shouldResetClaimPage(precheck?.precheck?.checks || [])) {
    await chrome.tabs.update(tabId, { url: CIGNA_CLAIM_URL, active: true });
    await waitForTabReady(tabId);
    await ensureSubmitterInjected(tabId);
    precheck = await runPrecheck(tabId, beneficiaryName);
    if (precheck?.precheck?.ready) return precheck.precheck;
  }

  const failed = (precheck?.precheck?.checks || [])
    .filter((check) => !check.ok)
    .map((check) => check.name)
    .join(", ");
  throw new Error(`Cigna 页面结构检查未通过${failed ? `: ${failed}` : ""}`);
}

async function runPrecheck(tabId, beneficiaryName) {
  return chrome.tabs.sendMessage(tabId, {
    type: "CIGNA_PRECHECK_PAGE",
    beneficiaryName,
  });
}

function shouldResetClaimPage(checks) {
  const byName = new Map(checks.map((check) => [check.name, check]));
  if (byName.get("beneficiary-card")?.ok === false) return false;
  return byName.get("submit-page-url")?.ok === false || byName.get("new-claim-start")?.ok === false;
}

async function handleSubmissionProgress(message) {
  const { submissionStatus } = await chrome.storage.local.get(["submissionStatus"]);
  if (!submissionStatus || submissionStatus.batchId !== message.batchId) return;
  const progress = [...(submissionStatus.progress || [])];
  const existingIndex = progress.findIndex((entry) => entry.index === message.index);
  const entry = {
    index: message.index,
    event: message.event,
    claim: message.claim || {},
    result: message.result || null,
    updatedAt: new Date().toISOString(),
  };
  if (existingIndex >= 0) {
    progress[existingIndex] = { ...progress[existingIndex], ...entry };
  } else {
    progress.push(entry);
  }
  progress.sort((a, b) => a.index - b.index);
  const { status, updatedAt, ...statusDetails } = submissionStatus;
  await writeSubmissionStatus(submissionStatus.dryRun ? "dry-running" : "submitting", {
    ...statusDetails,
    current: message.index + 1,
    total: message.total,
    progress,
  });
}

async function findCignaTab(options = {}) {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.url?.startsWith("https://customer.cignaenvoy.com/")) return active;

  const [existing] = await chrome.tabs.query({ url: "https://customer.cignaenvoy.com/*" });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    return existing;
  }

  if (options.openIfMissing) {
    const created = await chrome.tabs.create({ url: CIGNA_CLAIM_URL, active: true });
    await waitForTabReady(created.id);
    return { ...created, url: created.url || CIGNA_CLAIM_URL };
  }

  throw new Error("请先在 Chrome 里打开并登录 Cigna Envoy 页面，或点击打开 Cigna。");
}

async function prepareClaimTab(tab) {
  if (tab?.url?.includes("/s/new-submitclaim")) return tab;
  const updated = await chrome.tabs.update(tab.id, { url: CIGNA_CLAIM_URL, active: true });
  await waitForTabReady(tab.id);
  return { ...tab, ...updated, url: updated?.url || CIGNA_CLAIM_URL };
}

async function ensureSubmitterInjected(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: "CIGNA_SUBMITTER_PING" });
    if (ping?.ok) return;
  } catch {
    // The content script may not be present if the tab was opened before the extension was loaded.
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/cignaSubmitter.js"],
  });
  const ping = await chrome.tabs.sendMessage(tabId, { type: "CIGNA_SUBMITTER_PING" });
  if (!ping?.ok) throw new Error("Cigna 页面脚本注入后未响应。");
}

async function waitForTabReady(tabId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.status === "complete") return;
    await sleep(500);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function recordSubmittedClaims(claims, results) {
  const store = await chrome.storage.local.get(["ledger"]);
  const ledger = store.ledger || {};
  const fileHashes = new Set(ledger.fileHashes || []);
  const claimKeys = new Set(ledger.claimKeys || []);
  const serviceDates = new Set(ledger.serviceDates || []);
  const submissions = [...(ledger.submissions || [])];
  const resultById = new Map(results.map((result) => [result.id, result]));

  for (const claim of claims) {
    const result = resultById.get(claim.id);
    if (result?.status !== "submitted") continue;
    claimKeys.add(claim.id);
    if (claim.serviceDate) serviceDates.add(claim.serviceDate);
    for (const hash of claim.fileHashes || []) fileHashes.add(hash);
    submissions.push({
      claimKey: claim.id,
      submissionFingerprint: claim.submissionFingerprint || "",
      serviceDate: claim.serviceDate,
      claimDate: claim.claimDate,
      claimDateSource: claim.claimDateSource || "",
      submissionId: result.submissionId,
      submissionIdMissing: Boolean(result.submissionIdMissing),
      warning: result.warning || "",
      submittedAt: new Date().toISOString(),
      fileNames: claim.fileNames || [],
    });
  }

  await chrome.storage.local.set({
    ledger: {
      fileHashes: [...fileHashes],
      claimKeys: [...claimKeys],
      serviceDates: [...serviceDates],
      submissions,
    },
  });
}

async function writeSubmissionStatus(status, patch = {}) {
  await chrome.storage.local.set({
    submissionStatus: {
      status,
      updatedAt: new Date().toISOString(),
      ...patch,
    },
  });
}

function isActiveSubmissionStatus(status) {
  if (!["queued", "opening-tab", "injecting", "prechecking", "submitting", "dry-running"].includes(status?.status)) return false;
  const updatedAt = Date.parse(status.updatedAt || "");
  if (!Number.isFinite(updatedAt)) return true;
  return Date.now() - updatedAt < ACTIVE_SUBMISSION_TTL_MS;
}
