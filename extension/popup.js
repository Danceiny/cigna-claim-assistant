import * as pdfjsLib from "./vendor/pdf.min.mjs";
import { buildClaimPlan } from "./core/claimIntake.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.min.mjs");
const ACTIVE_SUBMISSION_TTL_MS = 6 * 60 * 60 * 1000;

const state = {
  files: [],
  sidecarFiles: [],
  records: [],
  plan: null,
};

const filesInput = document.querySelector("#files");
const folderFilesInput = document.querySelector("#folderFiles");
const pickFilesButton = document.querySelector("#pickFiles");
const analyzeButton = document.querySelector("#analyze");
const compressButton = document.querySelector("#compress");
const preflightSubmitButton = document.querySelector("#preflightSubmit");
const dryRunSubmitButton = document.querySelector("#dryRunSubmit");
const submitButton = document.querySelector("#submit");
const autoSubmitButton = document.querySelector("#autoSubmit");
const openCignaButton = document.querySelector("#openCigna");
const checkCignaButton = document.querySelector("#checkCigna");
const exportCignaDiagnosticsButton = document.querySelector("#exportCignaDiagnostics");
const openAssistantButton = document.querySelector("#openAssistant");
const exportPlanButton = document.querySelector("#exportPlan");
const clearBatchButton = document.querySelector("#clearBatch");
const exportLedgerButton = document.querySelector("#exportLedger");
const importLedgerButton = document.querySelector("#importLedger");
const ledgerFileInput = document.querySelector("#ledgerFile");
const exportBackupButton = document.querySelector("#exportBackup");
const importBackupButton = document.querySelector("#importBackup");
const backupFileInput = document.querySelector("#backupFile");
const clearLedgerButton = document.querySelector("#clearLedger");
const claimsEl = document.querySelector("#claims");
const summaryEl = document.querySelector("#summary");
const logEl = document.querySelector("#log");
const settingsStatusEl = document.querySelector("#settingsStatus");
const ledgerStatusEl = document.querySelector("#ledgerStatus");
const allowReviewInput = document.querySelector("#allowReview");
const autoSubmitOnSelectInput = document.querySelector("#autoSubmitOnSelect");
const dropzoneEl = document.querySelector(".dropzone");
const settingInputs = ["#beneficiaryName", "#diagnosis", "#country", "#claimType", "#visitType", "#paymentLabel", "#earliestDate", "#minServiceDate"].map((selector) => document.querySelector(selector));

filesInput.addEventListener("change", () => {
  setSelectedFiles([...filesInput.files], { append: true });
  filesInput.value = "";
});

folderFilesInput.addEventListener("change", () => {
  setSelectedFiles([...folderFilesInput.files], { append: false });
  folderFilesInput.value = "";
});

pickFilesButton.addEventListener("click", () => {
  filesInput.click();
});

allowReviewInput.addEventListener("change", () => {
  saveSettings();
  if (state.plan) renderPlan(state.plan);
});

autoSubmitOnSelectInput.addEventListener("change", saveSettings);

dropzoneEl.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzoneEl.classList.add("dragging");
});

dropzoneEl.addEventListener("dragleave", () => {
  dropzoneEl.classList.remove("dragging");
});

dropzoneEl.addEventListener("drop", async (event) => {
  event.preventDefault();
  dropzoneEl.classList.remove("dragging");
  try {
    const files = await filesFromDrop(event.dataTransfer);
    if (!files.length) {
      log("未发现可处理的 PDF/图片文件。");
      return;
    }
    setSelectedFiles(files, { append: true });
  } catch (error) {
    log(`读取拖入文件失败: ${error.message}`);
  }
});

claimsEl.addEventListener("change", async (event) => {
  const control = event.target.closest("[data-file-id][data-field]");
  if (!control) return;
  const record = state.records.find((candidate) => candidate.id === control.dataset.fileId);
  if (!record) return;
  record[control.dataset.field] = control.value;
  await rebuildPlan();
  log(`已应用文件修正: ${record.name}`);
});

claimsEl.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-remove-file-id]");
  if (!button) return;
  await removeSelectedFile(button.dataset.removeFileId);
});

for (const input of settingInputs) {
  input.addEventListener("change", () => {
    renderSettingsStatus();
    saveSettings();
  });
}

restoreSettings();
restoreSubmissionStatus();
refreshLedgerStatus();
configureAssistantPageButton();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.submissionStatus?.newValue) {
    log(formatSubmissionStatus(changes.submissionStatus.newValue));
  }
  if (changes.ledger?.newValue && state.records.length) {
    rebuildPlan().catch((error) => log(`提交记录更新后刷新计划失败: ${error.message}`));
  }
  if (changes.ledger) {
    renderLedgerStatus(changes.ledger.newValue);
  }
});

analyzeButton.addEventListener("click", async () => {
  try {
    analyzeButton.disabled = true;
    await runAnalysis();
  } catch (error) {
    log(`识别失败: ${error.message}`);
  } finally {
    analyzeButton.disabled = false;
  }
});

compressButton.addEventListener("click", async () => {
  if (!state.plan) return;
  try {
    compressButton.disabled = true;
    await runCompression();
  } catch (error) {
    log(`压缩失败: ${error.message}`);
  } finally {
    compressButton.disabled = state.plan ? !state.plan.claims.some((claim) => claim.compression.required) : false;
  }
});

submitButton.addEventListener("click", async () => {
  if (!state.plan) return;
  try {
    submitButton.disabled = true;
    await runSubmission();
  } catch (error) {
    log(`提交失败: ${error.message}`);
  } finally {
    submitButton.disabled = submittableClaims(state.plan).length === 0;
  }
});

dryRunSubmitButton.addEventListener("click", async () => {
  if (!state.plan) return;
  try {
    dryRunSubmitButton.disabled = true;
    await runSubmission({
      dryRun: true,
      note: "真实页面彩排会在 Cigna 最终检查页停止，不勾选免责声明，不点击最终提交，也不会写入防重账本。",
    });
  } catch (error) {
    log(`真实页面彩排失败: ${error.message}`);
  } finally {
    dryRunSubmitButton.disabled = submittableClaims(state.plan).length === 0;
  }
});

exportLedgerButton.addEventListener("click", exportLedger);
importLedgerButton.addEventListener("click", () => ledgerFileInput.click());
ledgerFileInput.addEventListener("change", async () => {
  const [file] = ledgerFileInput.files || [];
  ledgerFileInput.value = "";
  if (!file) return;
  try {
    await importLedger(file);
  } catch (error) {
    log(`导入记录失败: ${error.message}`);
  }
});
exportBackupButton.addEventListener("click", exportBackup);
importBackupButton.addEventListener("click", () => backupFileInput.click());
backupFileInput.addEventListener("change", async () => {
  const [file] = backupFileInput.files || [];
  backupFileInput.value = "";
  if (!file) return;
  try {
    await importBackup(file);
  } catch (error) {
    log(`导入备份失败: ${error.message}`);
  }
});
clearLedgerButton.addEventListener("click", clearLedger);
clearBatchButton.addEventListener("click", () => clearCurrentBatch("已清空当前批次。基础设置和提交记录未清除。"));
exportPlanButton.addEventListener("click", exportPlan);
preflightSubmitButton.addEventListener("click", runSubmitPreflight);
openCignaButton.addEventListener("click", () => prepareCignaPage({ openIfMissing: true }));
checkCignaButton.addEventListener("click", () => prepareCignaPage({ openIfMissing: false }));
exportCignaDiagnosticsButton.addEventListener("click", exportCignaDiagnostics);
openAssistantButton.addEventListener("click", openAssistantPage);

autoSubmitButton.addEventListener("click", runAutoSubmit);

async function runAutoSubmit() {
  try {
    assertRequiredSettings({ forSubmission: true });
    setActionButtonsDisabled(true);
    await runAnalysis();
    if (state.plan.claims.some((claim) => claim.compression.required)) {
      await runCompression();
    }
    const skipped = skippedClaims(state.plan);
    const claimsToSubmit = submittableClaims(state.plan);
    if (!claimsToSubmit.length) {
      log(`自动处理已停止: ${skippedSummary(skipped) || "没有可提交项。"}`);
      return;
    }
    await runSubmission({
      note: skipped.length ? `自动处理将跳过: ${skippedSummary(skipped)}` : "",
    });
  } catch (error) {
    log(`自动处理失败: ${error.message}`);
  } finally {
    if (state.plan) {
      renderPlan(state.plan);
      setActionButtonsDisabled(false);
    } else {
      setActionButtonsDisabled(false);
    }
  }
}

async function runAnalysis() {
  if (!state.files.length) throw new Error("请先选择或拖入文件。");
  log("正在本地解析文件...");
  const previousRecords = new Map(state.records.map((record) => [record.file, record]));
  const ocrSidecars = await buildOcrSidecarMap(state.sidecarFiles);
  const records = [];
  for (const file of state.files) {
    const previous = previousRecords.get(file);
    const overrides = previous ? recordOverrides(previous) : {};
    const sidecar = findOcrSidecarForFile(file, ocrSidecars);
    records.push(await fileToRecord(file, sidecar?.text ? {
      ...overrides,
      ocrText: sidecar.text,
      ocr: {
        method: "sidecar",
        sidecarPath: sidecar.path,
        hasText: true,
        textLength: sidecar.text.length,
      },
    } : overrides));
  }
  state.records = records;
  await rebuildPlan();
}

async function runCompression() {
  if (!state.plan) throw new Error("请先识别文件。");
  if (!state.plan.claims.some((claim) => claim.compression?.required)) {
    log("没有需要压缩的 PDF。");
    return;
  }
  let compressedCount = 0;
  while (state.plan.claims.some((claim) => claim.compression?.required)) {
    const claim = state.plan.claims.find((candidate) => candidate.compression?.required);
    const item = claim.compression.items[0];
    const byId = new Map(state.records.map((record) => [record.id, record]));
    const record = byId.get(item.fileId);
    if (!record?.file) throw new Error(`${item.name} 缺少原始文件引用。`);
    log(`正在压缩 ${item.name}，目标 ${formatBytes(item.targetBytes)}...`);
    const compressed = await compressPdfFile(record.file, {
      targetBytes: item.targetBytes,
      name: compressedName(record.name),
    });
    if (!compressed.withinTarget) {
      throw new Error(`${record.name} 压缩后最佳结果仍为 ${formatBytes(compressed.file.size)}，超过目标 ${formatBytes(item.targetBytes)}。尝试记录: ${compressionAttemptSummary(compressed.attempts)}`);
    }
    const compressedRecord = await fileToRecord(compressed.file, {
      originalName: record.name,
      originalSha256: record.sha256,
      text: record.text,
      ocr: record.ocr,
      ...recordOverrides(record),
    });
    state.records = state.records.filter((candidate) => candidate.id !== record.id);
    state.records.push(compressedRecord);
    state.files = state.files.filter((candidate) => candidate !== record.file);
    state.files.push(compressed.file);
    compressedCount += 1;
    log(`${record.name}: ${formatBytes(record.size)} -> ${formatBytes(compressed.file.size)} (${compressionAttemptLabel(compressed.attempt)})`);
    await rebuildPlan();
  }
  if (compressedCount) {
    log(`压缩完成: ${compressedCount} 个 PDF，提交前会再次检查单文件和总附件大小。`);
  }
}

async function runSubmission(options = {}) {
  if (!state.plan) throw new Error("请先识别文件。");
  assertRequiredSettings({ forSubmission: true });
  await assertNoActiveSubmission();
  const claimsToSubmit = submittableClaims(state.plan);
  if (!claimsToSubmit.length) throw new Error("没有可提交项；先处理 blocked 或需要压缩的项目。");
  assertAttachmentLimits(claimsToSubmit, state.plan.settings);
  const settings = readSettings();
  const fingerprint = submissionFingerprint(claimsToSubmit, settings);
  const audit = buildSubmissionAudit({ plan: state.plan, claimsToSubmit, settings, fingerprint, note: options.note || "" });
  await chrome.storage.local.set({ lastSubmissionAudit: audit });
  const actionLabel = options.dryRun ? "真实页面彩排" : "提交";
  log(`${options.note ? `${options.note}\n` : ""}${formatSubmissionAudit(audit)}\n后台开始${actionLabel} ${claimsToSubmit.length} 个理赔单...`);
  const response = await chrome.runtime.sendMessage({
    type: "CIGNA_START_SUBMISSION",
    dryRun: Boolean(options.dryRun),
    submissionFingerprint: fingerprint,
    claims: await Promise.all(claimsToSubmit.map(serializeClaimForContentScript)),
    ledgerClaims: claimsToSubmit.map((claim) => claimForLedger(claim, fingerprint)),
  });
  if (state.records.length) await rebuildPlan();
  log(`${options.note ? `${options.note}\n` : ""}${formatSubmissionAudit(audit)}\n${JSON.stringify(response, null, 2)}`);
}

async function runSubmitPreflight() {
  if (!state.plan) {
    log("请先识别文件再做提交预检。");
    return;
  }
  try {
    preflightSubmitButton.disabled = true;
    const payload = buildSubmitPreflightPayload();
    downloadJson(payload, `cigna-submit-preflight-${new Date().toISOString().slice(0, 10)}.json`);
    log(`提交预检通过: ${payload.claims.length} 个理赔单，${payload.skipped.length} 个跳过；未启动 Cigna 提交。`);
  } catch (error) {
    log(`提交预检失败: ${error.message}`);
  } finally {
    preflightSubmitButton.disabled = !state.plan || submittableClaims(state.plan).length === 0;
  }
}

function buildSubmitPreflightPayload() {
  assertRequiredSettings({ forSubmission: true });
  const claimsToSubmit = submittableClaims(state.plan);
  if (!claimsToSubmit.length) throw new Error("没有可提交项；先处理 blocked 或需要压缩的项目。");
  assertAttachmentLimits(claimsToSubmit, state.plan.settings);
  const settings = readSettings();
  const fingerprint = submissionFingerprint(claimsToSubmit, settings);
  return {
    schema: "cigna-submit-preflight-v1",
    exportedAt: new Date().toISOString(),
    submissionFingerprint: fingerprint,
    settings,
    summary: state.plan.summary,
    claims: claimsToSubmit.map(preflightClaimSnapshot),
    ledgerClaims: claimsToSubmit.map((claim) => claimForLedger(claim, fingerprint)),
    skipped: skippedClaims(state.plan),
    note: "预检文件不包含 PDF/图片 base64 内容，也不会启动 Cigna 提交。",
  };
}

async function assertNoActiveSubmission() {
  const { submissionStatus } = await chrome.storage.local.get(["submissionStatus"]);
  if (isActiveSubmissionStatus(submissionStatus)) {
    throw new Error(`已有理赔提交正在进行中: ${formatSubmissionStatus(submissionStatus)}`);
  }
}

async function prepareCignaPage(options = {}) {
  const button = options.openIfMissing ? openCignaButton : checkCignaButton;
  try {
    button.disabled = true;
    assertRequiredSettings({ forPrecheck: true });
    log(options.openIfMissing ? "正在打开 Cigna 提交页..." : "正在检查 Cigna 页面...");
    const response = await chrome.runtime.sendMessage({
      type: "CIGNA_PREPARE_PAGE",
      openIfMissing: Boolean(options.openIfMissing),
      beneficiaryName: readSettings().beneficiaryName,
    });
    if (!response?.ok) throw new Error(response?.error || "Cigna 页面检查失败。");
    const failedChecks = (response.precheck?.checks || []).filter((check) => !check.ok);
    if (response.ready) {
      log(`Cigna 页面可用，结构检查通过，已连接标签页 ${response.tabId}。`);
    } else {
      log(`Cigna 页面已连接，但结构检查未通过: ${failedChecks.map((check) => check.name).join(", ") || "unknown"}`);
    }
  } catch (error) {
    log(`Cigna 页面检查失败: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

async function exportCignaDiagnostics() {
  try {
    exportCignaDiagnosticsButton.disabled = true;
    assertRequiredSettings({ forPrecheck: true });
    log("正在生成 Cigna 页面诊断...");
    const settings = readSettings();
    const response = await chrome.runtime.sendMessage({
      type: "CIGNA_PREPARE_PAGE",
      openIfMissing: false,
      beneficiaryName: settings.beneficiaryName,
    });
    const payload = {
      schema: "cigna-page-diagnostics-v1",
      exportedAt: new Date().toISOString(),
      ok: Boolean(response?.ok),
      ready: Boolean(response?.ready),
      tabId: response?.tabId || null,
      url: response?.url || "",
      precheck: response?.precheck || null,
      error: response?.ok ? "" : response?.error || "Cigna 页面诊断失败。",
      settings: {
        beneficiaryName: settings.beneficiaryName,
        country: settings.country,
        claimType: settings.claimType,
        visitType: settings.visitType,
      },
      note: "诊断只检查当前 Chrome 里的 Cigna 页面和 content script 注入，不上传文件，也不提交理赔。",
    };
    await chrome.storage.local.set({ lastCignaDiagnostics: payload });
    downloadJson(payload, `cigna-page-diagnostics-${new Date().toISOString().slice(0, 10)}.json`);
    if (!payload.ok) {
      log(`Cigna 页面诊断失败: ${payload.error}`);
      return;
    }
    const failedChecks = (payload.precheck?.checks || []).filter((check) => !check.ok);
    log(`已导出 Cigna 页面诊断: ready=${payload.ready}${failedChecks.length ? `，失败检查: ${failedChecks.map((check) => check.name).join(", ")}` : ""}`);
  } catch (error) {
    log(`导出 Cigna 诊断失败: ${error.message}`);
  } finally {
    exportCignaDiagnosticsButton.disabled = false;
  }
}

function configureAssistantPageButton() {
  if (!document.body.classList.contains("assistant-page")) return;
  openAssistantButton.disabled = true;
}

async function openAssistantPage() {
  if (document.body.classList.contains("assistant-page")) return;
  await chrome.tabs.create({
    url: chrome.runtime.getURL("assistant.html"),
    active: true,
  });
}

async function rebuildPlan() {
  const settings = readSettings();
  const ledger = (await chrome.storage.local.get(["ledger"])).ledger || {};
  state.plan = await buildClaimPlan(state.records, { settings, ledger });
  renderPlan(state.plan);
}

async function removeSelectedFile(fileId) {
  const record = state.records.find((candidate) => candidate.id === fileId);
  if (!record) return;
  state.records = state.records.filter((candidate) => candidate.id !== fileId);
  state.files = state.files.filter((file) => file !== record.file);
  if (!state.records.length) {
    clearCurrentBatch(`已移除文件: ${record.name}。当前批次为空。`);
    return;
  }
  await rebuildPlan();
  autoSubmitButton.disabled = state.files.length === 0;
  clearBatchButton.disabled = state.files.length === 0;
  log(`已移除文件: ${record.name}`);
}

async function fileToRecord(file, overrides = {}) {
  const bytes = await file.arrayBuffer();
  const digest = await sha256(bytes);
  const nativeText = file.type === "application/pdf" || /\.pdf$/i.test(file.name) ? await extractPdfText(bytes.slice(0)) : "";
  const text = overrides.text ?? (nativeText || overrides.ocrText || "");
  return {
    id: digest,
    name: file.name,
    path: file.webkitRelativePath || "",
    relativePath: file.webkitRelativePath || "",
    size: file.size,
    sha256: digest,
    text,
    ocr: nativeText ? { skipped: true, reason: "pdf-text-layer-present" } : overrides.ocr || {},
    originalName: overrides.originalName || "",
    originalSha256: overrides.originalSha256 || "",
    overrideKind: overrides.overrideKind || "",
    overrideServiceDate: overrides.overrideServiceDate || "",
    overrideEarliestTreatmentDate: overrides.overrideEarliestTreatmentDate || "",
    thumbnailDataUrl: overrides.thumbnailDataUrl || await createThumbnail(file, bytes.slice(0)).catch(() => ""),
    file,
  };
}

function recordOverrides(record = {}) {
  return {
    overrideKind: record.overrideKind || "",
    overrideServiceDate: record.overrideServiceDate || "",
    overrideEarliestTreatmentDate: record.overrideEarliestTreatmentDate || "",
    thumbnailDataUrl: record.thumbnailDataUrl || "",
    ocr: record.ocr || {},
  };
}

async function createThumbnail(file, bytes) {
  if (file.type?.startsWith("image/") || /\.(png|jpe?g|gif|bmp)$/i.test(file.name)) {
    return imageBytesToThumbnail(bytes, file.type || contentTypeFor(file.name));
  }
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
    return pdfBytesToThumbnail(bytes);
  }
  return "";
}

async function pdfBytesToThumbnail(bytes) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, isEvalSupported: false }).promise;
  const page = await doc.getPage(1);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(112 / baseViewport.width, 140 / baseViewport.height, 0.35);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas.toDataURL("image/jpeg", 0.72);
}

async function imageBytesToThumbnail(bytes, type) {
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  try {
    const image = await loadImage(url);
    const scale = Math.min(112 / image.naturalWidth, 140 / image.naturalHeight, 1);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.72);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片预览生成失败。"));
    image.src = url;
  });
}

async function extractPdfText(bytes) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, isEvalSupported: false }).promise;
  const pages = [];
  for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
    const page = await doc.getPage(pageNo);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str || "").join(" "));
  }
  return pages.join("\n");
}

async function sha256(bytes) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readSettings() {
  return {
    beneficiaryName: document.querySelector("#beneficiaryName").value.trim(),
    diagnosis: document.querySelector("#diagnosis").value.trim(),
    country: document.querySelector("#country").value.trim(),
    claimType: document.querySelector("#claimType").value.trim(),
    visitType: document.querySelector("#visitType").value.trim(),
    paymentLabel: document.querySelector("#paymentLabel").value.trim(),
    ongoingConditionEarliestDate: document.querySelector("#earliestDate").value,
    minServiceDate: document.querySelector("#minServiceDate").value,
    allowReview: allowReviewInput.checked,
    autoSubmitOnSelect: autoSubmitOnSelectInput.checked,
  };
}

const requiredSubmissionSettings = [
  ["beneficiaryName", "被保险人姓名"],
  ["diagnosis", "报销理由"],
  ["country", "治疗国家/地区"],
  ["claimType", "理赔类型"],
  ["visitType", "就诊类型"],
  ["paymentLabel", "付款账户关键词"],
];

function missingRequiredSettings(options = {}) {
  const settings = readSettings();
  const required = [
    ["beneficiaryName", "被保险人姓名"],
    ...(options.forSubmission ? requiredSubmissionSettings.slice(1) : []),
  ];
  return required.filter(([key]) => !settings[key]).map(([, label]) => label);
}

function assertRequiredSettings(options = {}) {
  const missing = missingRequiredSettings(options);
  if (missing.length) throw new Error(`请先填写必填设置: ${missing.join("、")}`);
}

function renderSettingsStatus() {
  const missing = missingRequiredSettings({ forSubmission: true });
  settingsStatusEl.classList.toggle("ready", missing.length === 0);
  settingsStatusEl.classList.toggle("missing", missing.length > 0);
  if (missing.length) {
    settingsStatusEl.textContent = `自动提交未就绪，缺少: ${missing.join("、")}`;
    return;
  }
  settingsStatusEl.textContent = autoSubmitOnSelectInput.checked
    ? "自动提交已就绪: 拖入或选择文件后会自动处理并提交。"
    : "基础设置已就绪: 当前为手动模式，拖入文件后需点击自动处理并提交。";
}

async function saveSettings() {
  renderSettingsStatus();
  await chrome.storage.local.set({ settings: readSettings() });
}

async function restoreSettings() {
  const stored = (await chrome.storage.local.get(["settings"])).settings || {};
  applySettings({
    beneficiaryName: document.querySelector("#beneficiaryName").value,
    diagnosis: document.querySelector("#diagnosis").value,
    country: document.querySelector("#country").value,
    claimType: document.querySelector("#claimType").value,
    visitType: document.querySelector("#visitType").value,
    paymentLabel: document.querySelector("#paymentLabel").value,
    ongoingConditionEarliestDate: document.querySelector("#earliestDate").value,
    minServiceDate: document.querySelector("#minServiceDate").value,
    allowReview: true,
    autoSubmitOnSelect: true,
    ...stored,
  });
  renderSettingsStatus();
}

async function restoreSubmissionStatus() {
  const { submissionStatus, lastSubmission } = await chrome.storage.local.get(["submissionStatus", "lastSubmission"]);
  if (submissionStatus) {
    log(formatSubmissionStatus(submissionStatus));
  } else if (lastSubmission) {
    log(`上次提交: ${lastSubmission.at}\n${JSON.stringify(lastSubmission.results || [], null, 2)}`);
  }
}

async function exportLedger() {
  const snapshot = await chrome.storage.local.get(["ledger", "submissionStatus", "lastSubmission"]);
  const payload = {
    exportedAt: new Date().toISOString(),
    ledger: snapshot.ledger || {},
    submissionStatus: snapshot.submissionStatus || null,
    lastSubmission: snapshot.lastSubmission || null,
  };
  downloadJson(payload, `cigna-claim-ledger-${new Date().toISOString().slice(0, 10)}.json`);
  log("已导出本地提交记录。");
}

async function importLedger(file) {
  const payload = JSON.parse(await file.text());
  const incoming = normalizeLedgerPayload(payload);
  const currentSnapshot = await chrome.storage.local.get(["ledger", "submissionStatus", "lastSubmission"]);
  const current = normalizeLedgerPayload(currentSnapshot);
  const mergedLedger = {
    fileHashes: mergeUnique(current.ledger.fileHashes, incoming.ledger.fileHashes),
    claimKeys: mergeUnique(current.ledger.claimKeys, incoming.ledger.claimKeys),
    serviceDates: mergeUnique(current.ledger.serviceDates, incoming.ledger.serviceDates),
    submissions: mergeSubmissions(current.ledger.submissions, incoming.ledger.submissions),
  };
  await chrome.storage.local.set({
    ledger: mergedLedger,
    submissionStatus: incoming.submissionStatus || currentSnapshot.submissionStatus || null,
    lastSubmission: incoming.lastSubmission || currentSnapshot.lastSubmission || null,
  });
  renderLedgerStatus(mergedLedger);
  if (state.records.length) await rebuildPlan();
  log(`已导入记录: ${mergedLedger.serviceDates.length} 个已提交日期，${mergedLedger.fileHashes.length} 个文件哈希。`);
}

async function exportBackup() {
  const snapshot = await chrome.storage.local.get(["settings", "ledger", "submissionStatus", "lastSubmission", "lastSubmissionAudit", "lastCignaDiagnostics"]);
  const payload = {
    schema: "cigna-claim-assistant-backup-v1",
    exportedAt: new Date().toISOString(),
    settings: sanitizeSettings(snapshot.settings || readSettings()),
    ledger: normalizeLedgerPayload(snapshot).ledger,
    submissionStatus: snapshot.submissionStatus || null,
    lastSubmission: snapshot.lastSubmission || null,
    lastSubmissionAudit: snapshot.lastSubmissionAudit || null,
    lastCignaDiagnostics: snapshot.lastCignaDiagnostics || null,
  };
  downloadJson(payload, `cigna-claim-assistant-backup-${new Date().toISOString().slice(0, 10)}.json`);
  log("已导出完整备份。");
}

async function importBackup(file) {
  const payload = JSON.parse(await file.text());
  if (payload?.schema && payload.schema !== "cigna-claim-assistant-backup-v1") {
    throw new Error(`不支持的备份格式: ${payload.schema}`);
  }
  const incomingSettings = sanitizeSettings(payload.settings || {});
  const incoming = normalizeLedgerPayload(payload);
  const currentSnapshot = await chrome.storage.local.get(["ledger", "submissionStatus", "lastSubmission", "lastSubmissionAudit", "lastCignaDiagnostics"]);
  const current = normalizeLedgerPayload(currentSnapshot);
  const mergedLedger = {
    fileHashes: mergeUnique(current.ledger.fileHashes, incoming.ledger.fileHashes),
    claimKeys: mergeUnique(current.ledger.claimKeys, incoming.ledger.claimKeys),
    serviceDates: mergeUnique(current.ledger.serviceDates, incoming.ledger.serviceDates),
    submissions: mergeSubmissions(current.ledger.submissions, incoming.ledger.submissions),
  };
  await chrome.storage.local.set({
    settings: incomingSettings,
    ledger: mergedLedger,
    submissionStatus: incoming.submissionStatus || currentSnapshot.submissionStatus || null,
    lastSubmission: incoming.lastSubmission || currentSnapshot.lastSubmission || null,
    lastSubmissionAudit: normalizeObjectSnapshot(payload.lastSubmissionAudit) || currentSnapshot.lastSubmissionAudit || null,
    lastCignaDiagnostics: normalizeObjectSnapshot(payload.lastCignaDiagnostics) || currentSnapshot.lastCignaDiagnostics || null,
  });
  applySettings(incomingSettings);
  renderLedgerStatus(mergedLedger);
  if (state.records.length) await rebuildPlan();
  log(`已导入完整备份: ${mergedLedger.serviceDates.length} 个已提交日期，基础设置已恢复。`);
}

function normalizeObjectSnapshot(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

async function exportPlan() {
  if (!state.plan) {
    log("请先识别文件再导出计划。");
    return;
  }
  const { lastSubmissionAudit } = await chrome.storage.local.get(["lastSubmissionAudit"]);
  const payload = {
    exportedAt: new Date().toISOString(),
    settings: readSettings(),
    summary: state.plan.summary,
    files: state.plan.files.map(planFileSnapshot),
    toSubmit: submittableClaims(state.plan).map(planClaimSnapshot),
    skipped: skippedClaims(state.plan),
    blocked: state.plan.claims.filter((claim) => claim.status === "blocked").map(planClaimSnapshot),
    compression: state.plan.claims.flatMap((claim) => (claim.compression?.items || []).map((item) => ({
      serviceDate: claim.serviceDate,
      claimDate: claim.claimDate,
      name: item.name,
      size: item.size,
      sizeLabel: formatBytes(item.size),
      targetBytes: item.targetBytes,
      targetLabel: formatBytes(item.targetBytes),
      reason: item.reason,
      projectedTotalBytes: claim.compression.projectedTotalBytes,
      projectedTotalLabel: formatBytes(claim.compression.projectedTotalBytes),
    }))),
    duplicates: state.plan.duplicateFiles.map((file) => ({
      name: file.name,
      size: file.size,
      sha256: file.sha256,
      originalSha256: file.originalSha256 || "",
      reason: file.duplicateReason || "ledger-file-hash",
    })),
    lastSubmissionAudit: lastSubmissionAudit || null,
  };
  downloadJson(payload, `cigna-claim-plan-${new Date().toISOString().slice(0, 10)}.json`);
  log(`已导出本次计划: ${payload.toSubmit.length} 个可提交，${payload.skipped.length} 个跳过。`);
}

function sanitizeSettings(settings = {}) {
  const out = {};
  for (const key of ["beneficiaryName", "diagnosis", "country", "claimType", "visitType", "paymentLabel", "ongoingConditionEarliestDate", "minServiceDate"]) {
    if (typeof settings[key] === "string") out[key] = settings[key].trim();
  }
  if (settings.allowReview != null) out.allowReview = Boolean(settings.allowReview);
  if (settings.autoSubmitOnSelect != null) out.autoSubmitOnSelect = Boolean(settings.autoSubmitOnSelect);
  return out;
}

function applySettings(settings = {}) {
  if ("beneficiaryName" in settings) document.querySelector("#beneficiaryName").value = settings.beneficiaryName || "";
  if ("diagnosis" in settings) document.querySelector("#diagnosis").value = settings.diagnosis || "";
  if ("country" in settings) document.querySelector("#country").value = settings.country || "";
  if ("claimType" in settings) document.querySelector("#claimType").value = settings.claimType || "";
  if ("visitType" in settings) document.querySelector("#visitType").value = settings.visitType || "";
  if ("paymentLabel" in settings) document.querySelector("#paymentLabel").value = settings.paymentLabel || "";
  if ("ongoingConditionEarliestDate" in settings) document.querySelector("#earliestDate").value = settings.ongoingConditionEarliestDate || "";
  if ("minServiceDate" in settings) document.querySelector("#minServiceDate").value = settings.minServiceDate || "";
  if ("allowReview" in settings) allowReviewInput.checked = Boolean(settings.allowReview);
  if ("autoSubmitOnSelect" in settings) autoSubmitOnSelectInput.checked = Boolean(settings.autoSubmitOnSelect);
  renderSettingsStatus();
}

async function clearLedger() {
  const emptyLedger = { fileHashes: [], claimKeys: [], serviceDates: [], submissions: [] };
  await chrome.storage.local.set({
    ledger: emptyLedger,
    submissionStatus: null,
    lastSubmission: null,
  });
  renderLedgerStatus(emptyLedger);
  log("已清空本地提交记录。基础设置未清除。");
}

async function refreshLedgerStatus() {
  const { ledger } = await chrome.storage.local.get(["ledger"]);
  renderLedgerStatus(ledger || {});
}

function renderLedgerStatus(rawLedger = {}) {
  const normalized = normalizeLedgerPayload({ ledger: rawLedger }).ledger;
  const submittedDates = new Set([
    ...normalized.serviceDates,
    ...normalized.submissions.map((entry) => entry.serviceDate).filter(Boolean),
  ]);
  ledgerStatusEl.textContent = `防重记录: 已记录 ${submittedDates.size} 个提交日期，${normalized.claimKeys.length} 个理赔键，${normalized.fileHashes.length} 个文件哈希。`;
}

function normalizeLedgerPayload(payload) {
  const ledger = payload?.ledger || payload || {};
  return {
    ledger: {
      fileHashes: asStringArray(ledger.fileHashes),
      claimKeys: asStringArray(ledger.claimKeys),
      serviceDates: asStringArray(ledger.serviceDates),
      submissions: Array.isArray(ledger.submissions) ? ledger.submissions.filter((entry) => entry && typeof entry === "object") : [],
    },
    submissionStatus: payload?.submissionStatus || null,
    lastSubmission: payload?.lastSubmission || null,
  };
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))];
}

function mergeUnique(a = [], b = []) {
  return [...new Set([...a, ...b])];
}

function mergeSubmissions(a = [], b = []) {
  const seen = new Set();
  const out = [];
  for (const entry of [...a, ...b]) {
    const key = [entry.claimKey || "", entry.serviceDate || "", entry.submissionId || ""].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function renderPlan(plan) {
  const toSubmit = submittableClaims(plan);
  const skipped = skippedClaims(plan);
  const compressionCount = plan.claims.reduce((sum, claim) => sum + (claim.compression?.items?.length || 0), 0);
  summaryEl.textContent = [
    `Ready ${plan.summary.ready} / Review ${plan.summary.review} / Blocked ${plan.summary.blocked} / Duplicate ${plan.summary.duplicates}`,
    `将提交 ${toSubmit.length} / 将跳过 ${skipped.length} / 需压缩 ${compressionCount}`,
  ].join("\n");
  compressButton.disabled = !plan.claims.some((claim) => claim.compression.required);
  preflightSubmitButton.disabled = toSubmit.length === 0;
  dryRunSubmitButton.disabled = toSubmit.length === 0;
  submitButton.disabled = toSubmit.length === 0;
  exportPlanButton.disabled = false;
  claimsEl.innerHTML = "";
  for (const claim of plan.claims) {
    const el = document.createElement("article");
    el.className = "claim";
    const notes = [...claim.blockers.map((x) => `阻塞: ${x}`), ...claim.warnings.map((x) => `提示: ${x}`)];
    el.innerHTML = `
      <header>
        <span>${claim.serviceDate || "未识别日期"} -> ${claim.claimDate || "未识别最早治疗日期"}</span>
        <span class="status-${claim.status}">${claim.status}</span>
      </header>
      <div>最早治疗日期来源: ${escapeHtml(claimDateSourceLabel(claim.claimDateSource))}</div>
      <div>${claim.fileNames.join(", ")}</div>
      ${claim.compression.required ? `<div>需要压缩: ${claim.compression.items.map((x) => x.name).join(", ")}</div>` : ""}
      ${claim.files.map(fileOverrideControls).join("")}
      ${notes.length ? `<ul>${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>` : ""}
    `;
    claimsEl.append(el);
  }
}

function fileOverrideControls(file) {
  const thumbnail = file.thumbnailDataUrl
    ? `<img class="file-thumb" src="${escapeHtml(file.thumbnailDataUrl)}" alt="${escapeHtml(file.name)} 预览">`
    : `<div class="file-thumb file-thumb-empty">无预览</div>`;
  const displayName = file.relativePath || file.name;
  return `
    <div class="file-override">
      ${thumbnail}
      <div class="file-name">${escapeHtml(displayName)}</div>
      <button class="file-remove" type="button" data-remove-file-id="${escapeHtml(file.id)}">移除</button>
      <label>
        类型
        <select data-file-id="${escapeHtml(file.id)}" data-field="overrideKind">
          ${documentKindOptions(file)}
        </select>
      </label>
      <label>
        服务日期
        <input type="date" data-file-id="${escapeHtml(file.id)}" data-field="overrideServiceDate" value="${escapeHtml(file.overrideServiceDate || "")}" placeholder="${escapeHtml(file.detectedServiceDate || "")}">
      </label>
      <label>
        最早治疗日期
        <input type="date" data-file-id="${escapeHtml(file.id)}" data-field="overrideEarliestTreatmentDate" value="${escapeHtml(file.overrideEarliestTreatmentDate || "")}" placeholder="${escapeHtml(file.detectedEarliestTreatmentDate || "")}">
      </label>
    </div>
  `;
}

function documentKindOptions(file) {
  const options = [
    ["", `自动: ${file.kind || "unknown"}`],
    ["claim-form", "理赔表/医疗文件"],
    ["medical", "医疗报告"],
    ["invoice", "发票"],
    ["receipt", "收据"],
    ["prescription", "处方"],
    ["progress-report", "病程报告"],
    ["image", "图片"],
    ["unknown", "未知"],
  ];
  return options.map(([value, label]) => `<option value="${escapeHtml(value)}" ${file.overrideKind === value ? "selected" : ""}>${escapeHtml(label)}</option>`).join("");
}

function planFileSnapshot(file) {
  return {
    uploadOrder: file.uploadOrder || 0,
    name: file.name,
    relativePath: file.relativePath || "",
    kind: file.kind,
    serviceDate: file.serviceDate,
    earliestTreatmentDate: file.earliestTreatmentDate,
    earliestTreatmentDateSource: file.earliestTreatmentDateSource || "",
    detectedServiceDate: file.detectedServiceDate,
    detectedEarliestTreatmentDate: file.detectedEarliestTreatmentDate,
    hasThumbnail: Boolean(file.thumbnailDataUrl),
    overrideKind: file.overrideKind || "",
    overrideServiceDate: file.overrideServiceDate || "",
    overrideEarliestTreatmentDate: file.overrideEarliestTreatmentDate || "",
    confidence: file.confidence,
    warnings: file.warnings,
    ocr: file.source?.ocr || {},
  };
}

function planClaimSnapshot(claim) {
  return {
    id: claim.id,
    serviceDate: claim.serviceDate,
    claimDate: claim.claimDate,
    claimDateSource: claim.claimDateSource || "",
    status: claim.status,
    totalBytes: claim.totalBytes,
    fileNames: claim.fileNames,
    uploadOrder: claim.files.map((file) => ({
      order: file.uploadOrder || 0,
      name: file.relativePath || file.name,
      kind: file.kind,
    })),
    blockers: claim.blockers,
    warnings: claim.warnings,
    compressionRequired: Boolean(claim.compression?.required),
  };
}

function preflightClaimSnapshot(claim) {
  const settings = readSettings();
  return {
    id: claim.id,
    beneficiaryName: settings.beneficiaryName,
    serviceDate: claim.serviceDate,
    claimDate: claim.claimDate,
    claimDateSource: claim.claimDateSource || "",
    diagnosis: settings.diagnosis || claim.diagnosis,
    country: settings.country,
    claimType: settings.claimType,
    visitType: settings.visitType,
    paymentLabel: settings.paymentLabel,
    status: claim.status,
    totalBytes: claim.totalBytes,
    totalLabel: formatBytes(claim.totalBytes),
    files: claim.files.map((file) => ({
      uploadOrder: file.uploadOrder || 0,
      name: file.name,
      relativePath: file.relativePath || "",
      kind: file.kind,
      size: file.size,
      sizeLabel: formatBytes(file.size),
      sha256: file.sha256,
      originalSha256: file.originalSha256 || "",
      serviceDate: file.serviceDate,
      earliestTreatmentDate: file.earliestTreatmentDate,
      earliestTreatmentDateSource: file.earliestTreatmentDateSource || "",
      confidence: file.confidence,
      warnings: file.warnings,
    })),
  };
}

function buildSubmissionAudit({ plan, claimsToSubmit, settings, fingerprint, note = "" }) {
  const skipped = skippedClaims(plan);
  const compressionPending = plan.claims.flatMap((claim) => claim.compression?.items || []);
  return {
    schema: "cigna-submission-audit-v1",
    createdAt: new Date().toISOString(),
    submissionFingerprint: fingerprint,
    note,
    settings: sanitizeSettings(settings),
    summary: plan.summary,
    counts: {
      submit: claimsToSubmit.length,
      skipped: skipped.length,
      compressionPending: compressionPending.length,
      duplicates: plan.duplicateFiles.length,
    },
    submit: claimsToSubmit.map((claim) => ({
      id: claim.id,
      serviceDate: claim.serviceDate,
      claimDate: claim.claimDate,
      claimDateSource: claim.claimDateSource || "",
      status: claim.status,
      totalBytes: claim.totalBytes,
      totalLabel: formatBytes(claim.totalBytes),
      fileCount: claim.files.length,
      files: claim.files.map((file) => ({
        uploadOrder: file.uploadOrder || 0,
        name: file.relativePath || file.name,
        kind: file.kind,
        size: file.size,
        sizeLabel: formatBytes(file.size),
        sha256: file.sha256 || "",
        originalSha256: file.originalSha256 || "",
      })),
    })),
    skipped,
    compressionPending: compressionPending.map((item) => ({
      fileId: item.fileId,
      name: item.name,
      size: item.size,
      sizeLabel: formatBytes(item.size),
      targetBytes: item.targetBytes,
      targetLabel: formatBytes(item.targetBytes),
      reason: item.reason,
    })),
    duplicates: plan.duplicateFiles.map((file) => ({
      name: file.relativePath || file.name,
      sha256: file.sha256 || "",
      originalSha256: file.originalSha256 || "",
      reason: file.duplicateReason || "ledger-file-hash",
    })),
  };
}

function formatSubmissionAudit(audit) {
  const submitDates = audit.submit.map((claim) => `${claim.serviceDate}->${claim.claimDate}`).join(", ") || "无";
  const skippedDates = audit.skipped.map((claim) => `${claim.serviceDate}:${claim.reason}`).join("; ") || "无";
  return [
    `提交批次快照 ${audit.submissionFingerprint}`,
    `将提交: ${submitDates}`,
    `将跳过: ${skippedDates}`,
    `需压缩: ${audit.counts.compressionPending} / 重复文件: ${audit.counts.duplicates}`,
  ].join("\n");
}

function downloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function compressPdfFile(file, options = {}) {
  await ensurePdfLib();
  const sourceBytes = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(sourceBytes), useWorkerFetch: false, isEvalSupported: false }).promise;
  const targetBytes = options.targetBytes || 5.7 * 1024 * 1024;
  const attempts = [
    { scale: 1.0, quality: 0.58 },
    { scale: 0.85, quality: 0.46 },
    { scale: 0.7, quality: 0.34 },
  ];
  let best = null;
  const attemptResults = [];
  for (const attempt of attempts) {
    const bytes = await renderCompressedPdf(doc, attempt);
    attemptResults.push({ ...attempt, bytes: bytes.byteLength });
    if (!best || bytes.byteLength < best.bytes.byteLength) best = { bytes, attempt };
    if (bytes.byteLength <= targetBytes) break;
  }
  const outputName = options.name || compressedName(file.name);
  const outputFile = new File([best.bytes], outputName, { type: "application/pdf" });
  return {
    file: outputFile,
    attempt: best.attempt,
    attempts: attemptResults,
    withinTarget: outputFile.size <= targetBytes,
  };
}

async function renderCompressedPdf(doc, attempt) {
  const pdfDoc = await window.PDFLib.PDFDocument.create();
  for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
    const page = await doc.getPage(pageNo);
    const baseViewport = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: attempt.scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    const jpgBytes = await canvasToBytes(canvas, "image/jpeg", attempt.quality);
    const jpg = await pdfDoc.embedJpg(jpgBytes);
    const pdfPage = pdfDoc.addPage([baseViewport.width, baseViewport.height]);
    pdfPage.drawImage(jpg, { x: 0, y: 0, width: baseViewport.width, height: baseViewport.height });
  }
  return pdfDoc.save({ useObjectStreams: true });
}

function canvasToBytes(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error("Canvas compression failed."));
        return;
      }
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, type, quality);
  });
}

async function ensurePdfLib() {
  if (window.PDFLib?.PDFDocument) return;
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("vendor/pdf-lib.min.js");
    script.onload = resolve;
    script.onerror = () => reject(new Error("pdf-lib 加载失败。"));
    document.head.append(script);
  });
}

function compressedName(name) {
  return name.replace(/\.pdf$/i, "-compressed.pdf");
}

function claimDateSourceLabel(source) {
  const labels = {
    "file-text": "PDF/OCR 文本",
    "manual-override": "人工修正",
    "global-fallback": "全局兜底",
  };
  return labels[source] || "未确定";
}

function compressionAttemptLabel(attempt = {}) {
  if (!attempt.scale || !attempt.quality) return "压缩参数未知";
  return `scale ${attempt.scale}, quality ${attempt.quality}`;
}

function compressionAttemptSummary(attempts = []) {
  if (!attempts.length) return "无可用结果";
  return attempts.map((attempt) => `${compressionAttemptLabel(attempt)} => ${formatBytes(attempt.bytes || 0)}`).join("; ");
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function submittableClaims(plan) {
  const allowReview = allowReviewInput.checked;
  return plan.claims.filter((claim) => {
    if (claim.compression.required) return false;
    if (claim.status === "ready") return true;
    if (allowReview && claim.status === "review" && !requiresManualReview(claim)) return true;
    return false;
  });
}

function requiresManualReview(claim) {
  return claim.warnings.some((warning) => (
    warning.includes("无法识别文件类型")
    || warning.includes("部分文件识别置信度低")
  ));
}

function assertAttachmentLimits(claims, settings) {
  const maxFileBytes = settings?.maxFileBytes || 6 * 1024 * 1024;
  const maxClaimBytes = settings?.maxClaimBytes || 30 * 1024 * 1024;
  const failures = [];
  for (const claim of claims) {
    const oversizedFiles = claim.files
      .filter((file) => file.size > maxFileBytes)
      .map((file) => `${file.name} ${formatBytes(file.size)}`);
    if (oversizedFiles.length) {
      failures.push(`${claim.serviceDate || claim.id}: 单文件超限 ${oversizedFiles.join(", ")}`);
    }
    const totalBytes = claim.files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > maxClaimBytes) {
      failures.push(`${claim.serviceDate || claim.id}: 附件总大小 ${formatBytes(totalBytes)} 超过 ${formatBytes(maxClaimBytes)}`);
    }
  }
  if (failures.length) {
    throw new Error(`附件大小检查失败，不能提交。${failures.join("; ")}`);
  }
}

function skippedClaims(plan) {
  const allowReview = allowReviewInput.checked;
  return plan.claims
    .filter((claim) => claim.status === "blocked" || claim.status === "review")
    .filter((claim) => claim.status === "blocked" || !allowReview || requiresManualReview(claim))
    .map((claim) => ({
      serviceDate: claim.serviceDate || "未识别日期",
      status: claim.status,
      reason: claim.status === "review" ? reviewSkipReason(claim, allowReview) : claim.blockers[0] || "blocked",
    }));
}

function reviewSkipReason(claim, allowReview) {
  if (!allowReview) return "review 未允许提交";
  if (requiresManualReview(claim)) return "review 需要人工确认";
  return "review";
}

function skippedSummary(skipped) {
  if (!skipped.length) return "";
  return skipped.map((claim) => `${claim.serviceDate} ${claim.status}: ${claim.reason}`).join("; ");
}

async function serializeClaimForContentScript(claim) {
  const settings = readSettings();
  return {
    id: claim.id,
    beneficiaryName: settings.beneficiaryName,
    serviceDate: claim.serviceDate,
    claimDate: claim.claimDate,
    claimDateSource: claim.claimDateSource || "",
    diagnosis: settings.diagnosis || claim.diagnosis,
    country: settings.country,
    claimType: settings.claimType,
    visitType: settings.visitType,
    paymentLabel: settings.paymentLabel,
    files: await Promise.all(claim.files.map(fileForContentScript)),
  };
}

async function fileForContentScript(fileRecord) {
  if (!fileRecord.file) throw new Error(`${fileRecord.name} 缺少浏览器 File 引用。`);
  const bytes = await fileRecord.file.arrayBuffer();
  return {
    uploadOrder: fileRecord.uploadOrder || 0,
    name: fileRecord.name,
    type: fileRecord.file.type || contentTypeFor(fileRecord.name),
    base64: arrayBufferToBase64(bytes),
  };
}

function claimForLedger(claim, fingerprint = "") {
  const fileHashes = claim.files.flatMap((file) => [file.sha256, file.originalSha256]).filter(Boolean);
  return {
    id: claim.id,
    submissionFingerprint: fingerprint,
    serviceDate: claim.serviceDate,
    claimDate: claim.claimDate,
    claimDateSource: claim.claimDateSource || "",
    fileNames: claim.fileNames,
    uploadOrder: claim.files.map((file) => ({
      order: file.uploadOrder || 0,
      name: file.relativePath || file.name,
      kind: file.kind,
    })),
    fileHashes: [...new Set(fileHashes)],
  };
}

function submissionFingerprint(claims, settings) {
  return shaLike(JSON.stringify({
    settings: {
      beneficiaryName: settings.beneficiaryName || "",
      diagnosis: settings.diagnosis || "",
      country: settings.country || "",
      claimType: settings.claimType || "",
      visitType: settings.visitType || "",
      paymentLabel: settings.paymentLabel || "",
    },
    claims: claims.map((claim) => ({
      id: claim.id,
      serviceDate: claim.serviceDate || "",
      claimDate: claim.claimDate || "",
      claimDateSource: claim.claimDateSource || "",
      files: claim.files.map((file) => ({
        uploadOrder: file.uploadOrder || 0,
        name: file.relativePath || file.name,
        kind: file.kind,
        size: file.size,
        sha256: file.sha256 || "",
        originalSha256: file.originalSha256 || "",
      })),
    })),
  }));
}

function shaLike(input) {
  let hash = 2166136261;
  const text = String(input || "");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function contentTypeFor(name) {
  if (/\.pdf$/i.test(name)) return "application/pdf";
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.jpe?g$/i.test(name)) return "image/jpeg";
  if (/\.gif$/i.test(name)) return "image/gif";
  return "application/octet-stream";
}

function setSelectedFiles(files, options = {}) {
  const incomingAttachments = files.filter(isSupportedAttachmentFile);
  const incomingSidecars = files.filter(isOcrSidecarFile);
  const attachmentCandidates = options.append ? [...state.files, ...incomingAttachments] : incomingAttachments;
  const sidecarCandidates = options.append ? [...state.sidecarFiles, ...incomingSidecars] : incomingSidecars;
  state.files = uniqueFiles(attachmentCandidates);
  state.sidecarFiles = uniqueFiles(sidecarCandidates);
  if (options.append) {
    const selected = new Set(state.files);
    state.records = state.records.filter((record) => selected.has(record.file));
  } else {
    state.records = [];
  }
  state.plan = null;
  claimsEl.innerHTML = "";
  summaryEl.textContent = "";
  submitButton.disabled = true;
  preflightSubmitButton.disabled = true;
  dryRunSubmitButton.disabled = true;
  compressButton.disabled = true;
  exportPlanButton.disabled = true;
  autoSubmitButton.disabled = state.files.length === 0;
  clearBatchButton.disabled = state.files.length === 0;
  const selectedMessage = `${state.files.length} 个附件已选择${state.sidecarFiles.length ? `，${state.sidecarFiles.length} 个 OCR 文本已配对候选` : ""}`;
  log(selectedMessage);
  if (autoSubmitOnSelectInput.checked && state.files.length) {
    const missing = missingRequiredSettings({ forSubmission: true });
    if (missing.length) {
      log(`${selectedMessage}\n自动提交未启动: 缺少 ${missing.join("、")}`);
      return;
    }
    setTimeout(() => {
      runAutoSubmit().catch((error) => log(`自动处理失败: ${error.message}`));
    }, 0);
  }
}

function clearCurrentBatch(message = "已清空当前批次。") {
  state.files = [];
  state.sidecarFiles = [];
  state.records = [];
  state.plan = null;
  filesInput.value = "";
  folderFilesInput.value = "";
  claimsEl.innerHTML = "";
  summaryEl.textContent = "";
  submitButton.disabled = true;
  preflightSubmitButton.disabled = true;
  dryRunSubmitButton.disabled = true;
  compressButton.disabled = true;
  exportPlanButton.disabled = true;
  autoSubmitButton.disabled = true;
  clearBatchButton.disabled = true;
  log(message);
}

function uniqueFiles(files) {
  const seen = new Set();
  const result = [];
  for (const file of files) {
    const key = [file.webkitRelativePath || file.name, file.name, file.size].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(file);
  }
  return result;
}

async function filesFromDrop(dataTransfer) {
  if (!dataTransfer) return [];
  const entryFiles = await filesFromDataTransferItems(dataTransfer.items);
  const files = entryFiles.length ? entryFiles : [...(dataTransfer.files || [])];
  return files.filter(isSupportedInputFile);
}

async function filesFromDataTransferItems(items) {
  const entries = [...(items || [])]
    .map((item) => typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null)
    .filter(Boolean);
  if (!entries.length) return [];
  const nested = await Promise.all(entries.map(filesFromEntry));
  return nested.flat();
}

async function filesFromEntry(entry) {
  if (!entry) return [];
  if (entry.isFile) return [await fileFromEntry(entry)];
  if (!entry.isDirectory) return [];
  const reader = entry.createReader();
  const files = [];
  while (true) {
    const entries = await readDirectoryEntries(reader);
    if (!entries.length) break;
    const nested = await Promise.all(entries.map(filesFromEntry));
    files.push(...nested.flat());
  }
  return files;
}

function fileFromEntry(entry) {
  return new Promise((resolve, reject) => {
    entry.file((file) => {
      if (entry.fullPath && !file.webkitRelativePath) {
        Object.defineProperty(file, "webkitRelativePath", {
          value: entry.fullPath.replace(/^\/+/, ""),
          configurable: true,
        });
      }
      resolve(file);
    }, reject);
  });
}

function readDirectoryEntries(reader) {
  return new Promise((resolve, reject) => {
    reader.readEntries(resolve, reject);
  });
}

function setActionButtonsDisabled(disabled) {
  analyzeButton.disabled = disabled;
  compressButton.disabled = disabled || !state.plan?.claims.some((claim) => claim.compression.required);
  submitButton.disabled = disabled || !state.plan || submittableClaims(state.plan).length === 0;
  preflightSubmitButton.disabled = disabled || !state.plan || submittableClaims(state.plan).length === 0;
  dryRunSubmitButton.disabled = disabled || !state.plan || submittableClaims(state.plan).length === 0;
  exportPlanButton.disabled = disabled || !state.plan;
  autoSubmitButton.disabled = disabled;
}

function isSupportedInputFile(file) {
  return isSupportedAttachmentFile(file) || isOcrSidecarFile(file);
}

function isSupportedAttachmentFile(file) {
  return /\.(pdf|png|jpe?g|gif|bmp)$/i.test(file.name);
}

function isOcrSidecarFile(file) {
  return /\.txt$/i.test(file.name) || file.type === "text/plain";
}

async function buildOcrSidecarMap(sidecarFiles) {
  const byPath = new Map();
  for (const file of sidecarFiles) {
    const path = normalizedSidecarPath(file.webkitRelativePath || file.name);
    const text = await file.text().catch(() => "");
    if (!text.trim()) continue;
    byPath.set(path, { text, path: file.webkitRelativePath || file.name });
  }
  return byPath;
}

function findOcrSidecarForFile(file, sidecars) {
  const path = file.webkitRelativePath || file.name;
  for (const candidate of sidecarCandidatesForPath(path)) {
    const sidecar = sidecars.get(candidate);
    if (sidecar) return sidecar;
  }
  return null;
}

function sidecarCandidatesForPath(path) {
  const normalized = normalizedSidecarPath(path);
  const withoutExtension = normalized.replace(/\.[^/.\\]+$/, "");
  return [
    `${normalized}.txt`,
    `${withoutExtension}.txt`,
  ];
}

function normalizedSidecarPath(path) {
  return String(path || "").replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

function log(message) {
  logEl.textContent = message;
}

function formatSubmissionStatus(status) {
  const labels = {
    queued: "已排队",
    "opening-tab": "正在定位 Cigna 页面",
    injecting: "正在注入提交脚本",
    prechecking: "正在检查 Cigna 页面",
    submitting: "正在提交",
    "dry-running": "正在真实页面彩排",
    "dry-run-ready": "彩排到达最终检查页",
    submitted: "提交完成",
    failed: "提交失败",
  };
  const lines = [
    `${labels[status.status] || status.status} (${status.updatedAt || ""})`,
  ];
  if (status.total != null) lines.push(`理赔单: ${status.submitted || 0}/${status.total}`);
  if (status.dryRunReady != null) lines.push(`彩排完成: ${status.dryRunReady}/${status.total}`);
  if (status.failed) lines.push(`失败: ${status.failed}`);
  if (status.current != null && ["submitting", "dry-running"].includes(status.status)) lines.push(`当前: ${status.current}/${status.total}`);
  if (status.error) lines.push(status.error);
  if (status.progress?.length) {
    lines.push(...status.progress.map((entry) => {
      const date = entry.claim?.serviceDate || entry.claim?.claimDate || entry.claim?.id || `#${entry.index + 1}`;
      const label = entry.event === "claim-submitted" ? "完成" : entry.event === "claim-dry-run-ready" ? "彩排完成" : entry.event === "claim-failed" ? "失败" : "提交中";
      const submission = entry.result?.submissionId ? ` #${entry.result.submissionId}` : "";
      const error = entry.result?.error ? `: ${entry.result.error}` : "";
      return `${entry.index + 1}. ${date}: ${label}${submission}${error}`;
    }));
  }
  if (status.results?.length) {
    lines.push(...status.results.map((result) => `${result.id}: ${result.status}${result.submissionId ? ` #${result.submissionId}` : ""}${result.error ? `: ${result.error}` : ""}`));
  }
  return lines.join("\n");
}

function isActiveSubmissionStatus(status) {
  if (!["queued", "opening-tab", "injecting", "prechecking", "submitting", "dry-running"].includes(status?.status)) return false;
  const updatedAt = Date.parse(status.updatedAt || "");
  if (!Number.isFinite(updatedAt)) return true;
  return Date.now() - updatedAt < ACTIVE_SUBMISSION_TTL_MS;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[char]);
}
