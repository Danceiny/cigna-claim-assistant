const { execFile } = require("child_process");
const { existsSync, mkdirSync, writeFileSync } = require("fs");
const { dirname, extname, join, resolve } = require("path");

const pluginRoot = __dirname;
const releaseRoot = existsSync(join(pluginRoot, "scripts", "scan-claims.mjs"))
  ? pluginRoot
  : dirname(pluginRoot);
const nodeBin = process.execPath;
const settingsKey = "cigna-claim-assistant-settings";

function runNodeScript(script, args = []) {
  return new Promise((resolvePromise) => {
    const child = execFile(nodeBin, [script, ...args], {
      cwd: releaseRoot,
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolvePromise({
        ok: !error,
        code: error?.code || 0,
        error: error?.message || "",
        stdout,
        stderr,
      });
    });
  });
}

function openExternal(url) {
  if (globalThis.utools?.shellOpenExternal) {
    globalThis.utools.shellOpenExternal(url);
    return true;
  }
  return false;
}

window.cignaAssistant = {
  releaseRoot,
  loadSettings() {
    const stored = globalThis.utools?.dbStorage?.getItem?.(settingsKey);
    return stored && typeof stored === "object" ? stored : {};
  },
  saveSettings(settings = {}) {
    const next = {
      beneficiaryName: settings.beneficiaryName || "",
      diagnosis: settings.diagnosis || "",
      country: settings.country || "阿拉伯联合酋长国",
      claimType: settings.claimType || "医疗类",
      visitType: settings.visitType || "门诊",
      paymentLabel: settings.paymentLabel || "",
      minServiceDate: settings.minServiceDate || "",
      earliestDate: settings.earliestDate || "",
      claimDir: settings.claimDir || "",
      ocrEnabled: Boolean(settings.ocrEnabled),
      compressEnabled: Boolean(settings.compressEnabled),
      ocrCommand: settings.ocrCommand || "",
    };
    globalThis.utools?.dbStorage?.setItem?.(settingsKey, next);
    return next;
  },
  chooseDirectory() {
    const result = globalThis.utools?.showOpenDialog?.({
      properties: ["openDirectory"],
    });
    return Array.isArray(result) ? result[0] || "" : "";
  },
  async directoryFromDrop(event) {
    const files = Array.from(event?.dataTransfer?.files || []);
    const paths = files.map((file) => file.path).filter(Boolean);
    if (!paths.length) return "";
    const first = paths[0];
    try {
      const info = require("fs").statSync(first);
      if (info.isDirectory()) return first;
      if (info.isFile() && extname(first).toLowerCase() === ".pdf") return dirname(first);
    } catch {
      return "";
    }
    return "";
  },
  async inputFromDrop(event) {
    const files = Array.from(event?.dataTransfer?.files || []);
    const paths = files.map((file) => file.path).filter(Boolean);
    if (!paths.length) return { dir: "", filePaths: [], label: "" };
    const filePaths = [];
    for (const path of paths) {
      try {
        const info = require("fs").statSync(path);
        if (info.isDirectory()) return { dir: path, filePaths: [], label: path };
        if (info.isFile() && /\.(pdf|png|jpe?g|gif|bmp)$/i.test(path)) filePaths.push(path);
      } catch {
        // Ignore unreadable drop entries.
      }
    }
    if (!filePaths.length) return { dir: "", filePaths: [], label: "" };
    return {
      dir: dirname(filePaths[0]),
      filePaths,
      label: `${filePaths.length} 个文件: ${filePaths.map((path) => require("path").basename(path)).join(", ")}`,
    };
  },
  async scanDirectory(options = {}) {
    const dir = options.dir || "";
    const filePaths = Array.isArray(options.filePaths) ? options.filePaths.filter(Boolean) : [];
    if (filePaths.length) {
      const missing = filePaths.find((path) => !existsSync(path));
      if (missing) return { ok: false, error: `文件不存在: ${missing}` };
    } else if (!dir || !existsSync(dir)) {
      return { ok: false, error: "请选择有效报销目录或拖入 PDF/图片文件。" };
    }
    this.saveSettings({
      diagnosis: options.diagnosis,
      beneficiaryName: options.beneficiaryName,
      country: options.country,
      claimType: options.claimType,
      visitType: options.visitType,
      paymentLabel: options.paymentLabel,
      minServiceDate: options.minServiceDate,
      earliestDate: options.earliestDate,
      claimDir: dir,
      ocrEnabled: options.ocrEnabled,
      compressEnabled: options.compressEnabled,
      ocrCommand: options.ocrCommand,
    });
    const script = join(releaseRoot, "scripts", "scan-claims.mjs");
    mkdirSync(join(releaseRoot, "outputs"), { recursive: true });
    const output = join(releaseRoot, "outputs", "utools-claim-plan.json");
    const args = [
      "--output", output,
      "--diagnosis", options.diagnosis || "",
    ];
    if (filePaths.length) {
      for (const path of filePaths) args.push("--file", path);
    } else {
      args.push("--dir", dir);
    }
    if (options.compressEnabled) args.push("--compress");
    if (options.minServiceDate) args.push("--min-service-date", options.minServiceDate);
    if (options.earliestDate) args.push("--earliest", options.earliestDate);
    if (options.ocrEnabled) {
      args.push("--ocr");
      if (options.ocrCommand) args.push("--ocr-command", options.ocrCommand);
    }
    const result = await runNodeScript(script, args);
    return { ...result, output };
  },
  exportChromeBackup(settings = {}) {
    const saved = this.saveSettings(settings);
    mkdirSync(join(releaseRoot, "outputs"), { recursive: true });
    const output = join(releaseRoot, "outputs", "cigna-claim-assistant-chrome-settings-backup.json");
    const payload = {
      schema: "cigna-claim-assistant-backup-v1",
      exportedAt: new Date().toISOString(),
      source: "utools",
      settings: {
        beneficiaryName: saved.beneficiaryName,
        diagnosis: saved.diagnosis,
        country: saved.country,
        claimType: saved.claimType,
        visitType: saved.visitType,
        paymentLabel: saved.paymentLabel,
        ongoingConditionEarliestDate: saved.earliestDate,
        minServiceDate: saved.minServiceDate,
        allowReview: true,
        autoSubmitOnSelect: true,
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
    writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`);
    return { ok: true, output, payload };
  },
  openChromeSubmit() {
    return openExternal("https://customer.cignaenvoy.com/s/new-submitclaim?LanguageCode=zh_CN&language=zh_CN");
  },
  openReleaseFolder() {
    return openExternal(`file://${resolve(releaseRoot)}`);
  },
};
