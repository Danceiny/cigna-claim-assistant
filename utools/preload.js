const { execFile } = require("child_process");
const { createHash } = require("crypto");
const { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } = require("fs");
const { dirname, extname, join, resolve } = require("path");

const pluginRoot = __dirname;
const releaseRoot = existsSync(join(pluginRoot, "scripts", "scan-claims.mjs"))
  ? pluginRoot
  : dirname(pluginRoot);
const nodeBin = process.execPath;
const settingsKey = "cigna-claim-assistant-settings";
const folderStateKey = "cigna-claim-assistant-folder-state";
const supportedFileRe = /\.(pdf|png|jpe?g|gif|bmp)$/i;

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
      organizeEnabled: settings.organizeEnabled !== false,
      onlyNewEnabled: settings.onlyNewEnabled !== false,
      ocrCommand: settings.ocrCommand || "",
    };
    globalThis.utools?.dbStorage?.setItem?.(settingsKey, next);
    return next;
  },
  loadFolderState() {
    const stored = globalThis.utools?.dbStorage?.getItem?.(folderStateKey);
    return stored && typeof stored === "object" ? stored : { dirs: {} };
  },
  saveFolderState(dir) {
    if (!dir || !existsSync(dir)) return { ok: false, error: "请选择有效报销目录。" };
    const state = this.loadFolderState();
    const snapshot = snapshotDirectory(dir);
    state.dirs = state.dirs || {};
    state.dirs[dir] = {
      updatedAt: new Date().toISOString(),
      files: snapshot.files,
    };
    globalThis.utools?.dbStorage?.setItem?.(folderStateKey, state);
    return { ok: true, dir, count: snapshot.files.length, updatedAt: state.dirs[dir].updatedAt };
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
      organizeEnabled: options.organizeEnabled,
      onlyNewEnabled: options.onlyNewEnabled,
      ocrCommand: options.ocrCommand,
    });
    const script = join(releaseRoot, "scripts", "scan-claims.mjs");
    mkdirSync(join(releaseRoot, "outputs"), { recursive: true });
    const output = join(releaseRoot, "outputs", "utools-claim-plan.json");
    let scanFilePaths = filePaths;
    let folderStateNote = "";
    let folderSnapshot = null;
    if (!scanFilePaths.length && options.onlyNewEnabled !== false) {
      folderSnapshot = snapshotDirectory(dir);
      const state = this.loadFolderState();
      const dirState = state.dirs?.[dir] || null;
      const previous = dirState?.files || [];
      const previousByPath = new Map(previous.map((file) => [file.path, file.signature]));
      scanFilePaths = folderSnapshot.files
        .filter((file) => previousByPath.get(file.path) !== file.signature)
        .map((file) => file.path);
      folderStateNote = dirState
        ? `Folder state: ${scanFilePaths.length} new/changed files out of ${folderSnapshot.files.length}.`
        : `Folder state: no baseline found, scanning all ${folderSnapshot.files.length} files and saving a baseline.`;
      if (!scanFilePaths.length) {
        writeFileSync(output, `${JSON.stringify({
          generatedAt: new Date().toISOString(),
          settings: {},
          duplicateFiles: [],
          files: [],
          claims: [],
          summary: { ready: 0, review: 0, blocked: 0, duplicates: 0 },
        }, null, 2)}\n`);
        return {
          ok: true,
          code: 0,
          error: "",
          stdout: `${folderStateNote}\nNo new or changed files to scan.`,
          stderr: "",
          output,
        };
      }
    }
    const args = [
      "--output", output,
      "--diagnosis", options.diagnosis || "",
    ];
    if (scanFilePaths.length) {
      for (const path of scanFilePaths) args.push("--file", path);
    } else {
      args.push("--dir", dir);
    }
    if (options.compressEnabled) args.push("--compress");
    if (options.organizeEnabled) args.push("--organize", "--organize-dir", join(releaseRoot, "outputs", "organized-claims"));
    if (options.minServiceDate) args.push("--min-service-date", options.minServiceDate);
    if (options.earliestDate) args.push("--earliest", options.earliestDate);
    if (options.ocrEnabled) {
      args.push("--ocr");
      if (options.ocrCommand) args.push("--ocr-command", options.ocrCommand);
    }
    const result = await runNodeScript(script, args);
    if (result.ok && folderSnapshot) {
      const state = this.loadFolderState();
      state.dirs = state.dirs || {};
      state.dirs[dir] = {
        updatedAt: new Date().toISOString(),
        files: folderSnapshot.files,
      };
      globalThis.utools?.dbStorage?.setItem?.(folderStateKey, state);
    }
    if (folderStateNote) result.stdout = `${folderStateNote}\n${result.stdout}`;
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

function snapshotDirectory(dir) {
  const files = [];
  walkSupportedFiles(dir, dir, files);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { dir, files };
}

function walkSupportedFiles(dir, root, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSupportedFiles(path, root, files);
      continue;
    }
    if (!entry.isFile() || !supportedFileRe.test(entry.name)) continue;
    const info = statSync(path);
    const sidecars = sidecarSignatures(path);
    files.push({
      path,
      relativePath: path.slice(root.length + 1),
      size: info.size,
      mtimeMs: Math.floor(info.mtimeMs),
      sha256: sha256File(path),
      sidecars,
      signature: JSON.stringify({
        size: info.size,
        sha256: sha256File(path),
        sidecars,
      }),
    });
  }
}

function sidecarSignatures(path) {
  const candidates = [`${path}.txt`];
  const ext = extname(path);
  if (ext) candidates.push(path.slice(0, -ext.length) + ".txt");
  return candidates
    .filter((candidate, index) => candidates.indexOf(candidate) === index && existsSync(candidate))
    .map((candidate) => {
      const info = statSync(candidate);
      return {
        path: candidate,
        size: info.size,
        mtimeMs: Math.floor(info.mtimeMs),
        sha256: sha256File(candidate),
      };
    });
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
