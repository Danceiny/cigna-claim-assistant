const fields = {
  beneficiaryName: document.querySelector("#beneficiaryName"),
  diagnosis: document.querySelector("#diagnosis"),
  country: document.querySelector("#country"),
  claimType: document.querySelector("#claimType"),
  visitType: document.querySelector("#visitType"),
  paymentLabel: document.querySelector("#paymentLabel"),
  minServiceDate: document.querySelector("#minServiceDate"),
  earliestDate: document.querySelector("#earliestDate"),
  claimDir: document.querySelector("#claimDir"),
  ocrEnabled: document.querySelector("#ocrEnabled"),
  compressEnabled: document.querySelector("#compressEnabled"),
  ocrCommand: document.querySelector("#ocrCommand"),
};

const logEl = document.querySelector("#log");
const dropzoneEl = document.querySelector("#dropzone");
const settingsStatusEl = document.querySelector("#settingsStatus");
const savedSettings = window.cignaAssistant.loadSettings();
let selectedFilePaths = [];
let selectedInputDir = "";
const requiredSettings = [
  ["beneficiaryName", "被保险人姓名"],
  ["diagnosis", "报销理由"],
  ["country", "治疗国家/地区"],
  ["claimType", "理赔类型"],
  ["visitType", "就诊类型"],
  ["paymentLabel", "付款账户关键词"],
];

fields.beneficiaryName.value = savedSettings.beneficiaryName || "";
fields.diagnosis.value = savedSettings.diagnosis || fields.diagnosis.value || "";
fields.country.value = savedSettings.country || fields.country.value || "阿拉伯联合酋长国";
fields.claimType.value = savedSettings.claimType || fields.claimType.value || "医疗类";
fields.visitType.value = savedSettings.visitType || fields.visitType.value || "门诊";
fields.paymentLabel.value = savedSettings.paymentLabel || "";
fields.minServiceDate.value = savedSettings.minServiceDate || "";
fields.earliestDate.value = savedSettings.earliestDate || "";
fields.claimDir.value = savedSettings.claimDir || "";
fields.ocrEnabled.checked = Boolean(savedSettings.ocrEnabled);
fields.compressEnabled.checked = Boolean(savedSettings.compressEnabled);
fields.ocrCommand.value = savedSettings.ocrCommand || "";

for (const field of Object.values(fields)) {
  field.addEventListener("change", saveSettings);
}
renderSettingsStatus();

document.querySelector("#chooseDir").addEventListener("click", () => {
  const dir = window.cignaAssistant.chooseDirectory();
  if (dir) {
    selectedFilePaths = [];
    selectedInputDir = dir;
    fields.claimDir.value = dir;
    saveSettings();
  }
});

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
  const input = window.cignaAssistant.inputFromDrop
    ? await window.cignaAssistant.inputFromDrop(event)
    : { dir: await window.cignaAssistant.directoryFromDrop(event), filePaths: [] };
  if (!input.dir && !input.filePaths?.length) {
    log("未找到可扫描的本地文件夹或 PDF。");
    return;
  }
  selectedFilePaths = input.filePaths || [];
  selectedInputDir = input.dir || "";
  fields.claimDir.value = input.label || input.dir;
  saveSettings();
  log(selectedFilePaths.length
    ? `已选择 ${selectedFilePaths.length} 个文件:\n${selectedFilePaths.join("\n")}`
    : `已选择报销目录:\n${input.dir}`);
});

document.querySelector("#scanDir").addEventListener("click", async () => {
  log("正在扫描目录...");
  const result = await window.cignaAssistant.scanDirectory({
    dir: selectedFilePaths.length ? selectedInputDir : fields.claimDir.value.trim(),
    filePaths: selectedFilePaths,
    beneficiaryName: fields.beneficiaryName.value.trim(),
    diagnosis: fields.diagnosis.value.trim(),
    country: fields.country.value.trim(),
    claimType: fields.claimType.value.trim(),
    visitType: fields.visitType.value.trim(),
    paymentLabel: fields.paymentLabel.value.trim(),
    minServiceDate: fields.minServiceDate.value,
    earliestDate: fields.earliestDate.value,
    ocrEnabled: fields.ocrEnabled.checked,
    compressEnabled: fields.compressEnabled.checked,
    ocrCommand: fields.ocrCommand.value.trim(),
  });
  if (!result.ok) {
    log(`扫描失败: ${result.error}\n${result.stderr || ""}`);
    return;
  }
  log(`扫描完成，计划已导出:\n${result.output}\n\n${result.stdout}`);
});

document.querySelector("#exportChromeBackup").addEventListener("click", () => {
  const missing = missingRequiredSettings();
  if (missing.length) {
    log(`请先填写必填设置: ${missing.join("、")}`);
    renderSettingsStatus();
    return;
  }
  const result = window.cignaAssistant.exportChromeBackup(readSettings());
  if (!result.ok) {
    log("导出 Chrome 设置失败。");
    return;
  }
  log(`已导出 Chrome 扩展可导入的设置备份:\n${result.output}`);
});

document.querySelector("#openChromeSubmit").addEventListener("click", () => {
  window.cignaAssistant.openChromeSubmit();
  log("已打开 Cigna。真实提交请使用已登录 Chrome 中的 Cigna Claim Assistant 扩展。");
});

document.querySelector("#openReleaseFolder").addEventListener("click", () => {
  window.cignaAssistant.openReleaseFolder();
});

function log(message) {
  logEl.textContent = message;
}

function saveSettings() {
  window.cignaAssistant.saveSettings(readSettings());
  renderSettingsStatus();
}

function readSettings() {
  return {
    beneficiaryName: fields.beneficiaryName.value.trim(),
    diagnosis: fields.diagnosis.value.trim(),
    country: fields.country.value.trim(),
    claimType: fields.claimType.value.trim(),
    visitType: fields.visitType.value.trim(),
    paymentLabel: fields.paymentLabel.value.trim(),
    minServiceDate: fields.minServiceDate.value,
    earliestDate: fields.earliestDate.value,
    claimDir: selectedFilePaths.length ? selectedInputDir : fields.claimDir.value.trim(),
    ocrEnabled: fields.ocrEnabled.checked,
    compressEnabled: fields.compressEnabled.checked,
    ocrCommand: fields.ocrCommand.value.trim(),
  };
}

function missingRequiredSettings() {
  const settings = readSettings();
  return requiredSettings.filter(([key]) => !settings[key]).map(([, label]) => label);
}

function renderSettingsStatus() {
  const missing = missingRequiredSettings();
  settingsStatusEl.classList.toggle("ready", missing.length === 0);
  settingsStatusEl.classList.toggle("missing", missing.length > 0);
  settingsStatusEl.textContent = missing.length
    ? `Chrome 自动提交设置未就绪，缺少: ${missing.join("、")}`
    : "Chrome 自动提交设置已就绪，可导出设置备份。";
}
