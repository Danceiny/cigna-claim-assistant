const DATE_TOKEN_RE = /(?:(20\d{2})[-/.年]\s*(\d{1,2})[-/.月]\s*(\d{1,2})日?)|(?:(\d{1,2})[-/.]\s*(\d{1,2})[-/.]\s*(20\d{2}))|(?<!\d)(\d{8})(?!\d)|(?<!\d)(\d{4})(?!\d)/g;

export const DEFAULT_SETTINGS = {
  diagnosis: "",
  country: "阿拉伯联合酋长国",
  claimType: "医疗类",
  visitType: "门诊",
  paymentLabel: "",
  defaultYear: new Date().getFullYear(),
  ongoingConditionEarliestDate: "",
  minServiceDate: "",
  submitInvoiceOnly: false,
  requireInvoice: true,
  maxFileBytes: 6 * 1024 * 1024,
  maxClaimBytes: 30 * 1024 * 1024,
  compression: {
    enabled: true,
    targetFileBytes: 5.7 * 1024 * 1024,
    targetClaimBytes: 28 * 1024 * 1024,
    strategy: "auto",
  },
};

export function normalizeSettings(settings = {}) {
  return { ...DEFAULT_SETTINGS, ...dropEmpty(settings) };
}

export async function buildClaimPlan(fileRecords, options = {}) {
  const settings = normalizeSettings(options.settings);
  const ledger = normalizeLedger(options.ledger);
  const files = [];
  for (const record of fileRecords) {
    files.push(analyzeFileRecord(record, settings, ledger));
  }

  const duplicateFiles = files.filter((file) => file.duplicate);
  const curated = curateFiles(files.filter((file) => !file.duplicate));
  duplicateFiles.push(...curated.logicalDuplicates);
  const freshFiles = curated.files;
  const groups = groupFiles(freshFiles, settings);
  const claims = groups.map((group) => validateClaimGroup(group, settings, ledger));

  return {
    generatedAt: new Date().toISOString(),
    settings,
    duplicateFiles,
    files,
    claims,
    summary: summarizeClaims(claims, duplicateFiles),
  };
}

export function analyzeFileRecord(record, settings = DEFAULT_SETTINGS, ledger = { fileHashes: new Set(), claimKeys: new Set() }) {
  const name = record.name || basename(record.path || "unnamed");
  const text = normalizeText(record.text || "");
  const filenameDates = extractDates(name, settings.defaultYear);
  const relativePath = record.relativePath || record.webkitRelativePath || relativePathFrom(record.path);
  const pathDates = extractDates(relativePath, settings.defaultYear);
  const textDates = extractDates(text, settings.defaultYear);
  const detectedServiceDate = pickServiceDate({ text, name, filenameDates, pathDates, textDates });
  const serviceDate = record.overrideServiceDate || detectedServiceDate;
  const detectedEarliestTreatmentDate = pickEarliestTreatmentDate({ text, serviceDate: detectedServiceDate, settings });
  const earliestTreatmentDate = record.overrideEarliestTreatmentDate || detectedEarliestTreatmentDate;
  const earliestTreatmentDateSource = record.overrideEarliestTreatmentDate
    ? "manual-override"
    : earliestTreatmentDateSourceFor({ text, date: earliestTreatmentDate, settings });
  const kind = record.overrideKind || classifyDocument({ name, text });
  const hash = record.sha256 || "";
  const size = Number(record.size || record.bytes || 0);
  const duplicate = Boolean(hash && ledger.fileHashes.has(hash));

  return {
    id: stableFileId({ name, hash, size }),
    name,
    path: record.path || "",
    relativePath,
    kind,
    size,
    sha256: hash,
    originalSha256: record.originalSha256 || "",
    duplicate,
    serviceDate,
    earliestTreatmentDate,
    earliestTreatmentDateSource,
    detectedServiceDate,
    detectedEarliestTreatmentDate,
    overrideKind: record.overrideKind || "",
    overrideServiceDate: record.overrideServiceDate || "",
    overrideEarliestTreatmentDate: record.overrideEarliestTreatmentDate || "",
    thumbnailDataUrl: record.thumbnailDataUrl || "",
    filenameDates,
    pathDates,
    textDates,
    confidence: confidenceFor({ kind, text, serviceDate, earliestTreatmentDate, filenameDates }),
    warnings: fileWarnings({ kind, size, serviceDate, earliestTreatmentDate, settings, text }),
    source: {
      hasText: text.length > 0,
      textPreview: text.slice(0, 240),
      ocr: record.ocr || {},
    },
    file: record.file,
  };
}

export function groupFiles(files, settings = DEFAULT_SETTINGS) {
  const groups = new Map();
  for (const file of files) {
    const key = file.serviceDate || "undated";
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        serviceDate: key === "undated" ? "" : key,
        files: [],
      });
    }
    groups.get(key).files.push(file);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      files: withUploadOrder(inferScanPairKinds(group.files.sort(compareFiles)).sort(compareFiles)),
      claimDate: pickClaimDateForGroup(group.files, settings),
      claimDateSource: pickClaimDateSourceForGroup(group.files, settings),
      totalBytes: group.files.reduce((sum, file) => sum + file.size, 0),
    }))
    .sort((a, b) => (a.serviceDate || "9999").localeCompare(b.serviceDate || "9999"));
}

export function curateFiles(files) {
  const logicalGroups = new Map();
  for (const file of files) {
    const key = logicalFileKey(file);
    if (!logicalGroups.has(key)) logicalGroups.set(key, []);
    logicalGroups.get(key).push(file);
  }
  const kept = [];
  const logicalDuplicates = [];
  for (const group of logicalGroups.values()) {
    group.sort((a, b) => scoreFileVariant(b) - scoreFileVariant(a));
    kept.push(group[0]);
    logicalDuplicates.push(...group.slice(1).map((file) => ({
      ...file,
      duplicate: true,
      duplicateReason: "logical-file-variant",
    })));
  }
  return { files: kept, logicalDuplicates };
}

export function validateClaimGroup(group, settings = DEFAULT_SETTINGS, ledger = { claimKeys: new Set() }) {
  const hasInvoice = group.files.some((file) => file.kind === "invoice" || file.kind === "receipt");
  const hasMedical = group.files.some((file) => ["medical", "claim-form", "prescription", "progress-report"].includes(file.kind));
  const hasOnlyImages = group.files.every((file) => file.kind === "image");
  const fileNames = group.files.map(displayFileName);
  const claimKey = makeClaimKey({
    serviceDate: group.serviceDate,
    claimDate: group.claimDate,
    files: group.files,
  });
  const warnings = [];
  const blockers = [];
  const compression = planCompression(group, settings);

  if (!group.serviceDate) blockers.push("无法识别服务日期，不能安全分组。");
  if (!group.claimDate) blockers.push("无法确定最早治疗日期，不能安全选择日期。");
  if (settings.minServiceDate && group.serviceDate && group.serviceDate < settings.minServiceDate) blockers.push(`服务日期早于提交起始日期 ${settings.minServiceDate}。`);
  if (!settings.submitInvoiceOnly && hasInvoice && !hasMedical) blockers.push("只有发票/收据，缺少医疗报告或理赔表。");
  if (!settings.submitInvoiceOnly && !hasMedical) blockers.push("缺少医疗类文件。");
  if (settings.requireInvoice !== false && hasMedical && !hasInvoice) blockers.push("缺少发票/收据。");
  if (hasOnlyImages) blockers.push("只有图片，无法确认是否包含医疗报告。");
  if (group.totalBytes > settings.maxClaimBytes && !compression.canAttempt) blockers.push(`附件总大小超过 ${formatBytes(settings.maxClaimBytes)}。`);
  for (const file of group.files) {
    if (file.size > settings.maxFileBytes && !compression.fileIds.has(file.id)) blockers.push(`${file.name} 超过单文件 ${formatBytes(settings.maxFileBytes)} 限制。`);
    warnings.push(...file.warnings.map((warning) => `${file.name}: ${warning}`));
  }
  if (compression.items.length) warnings.push(`需要先压缩 ${compression.items.length} 个 PDF 文件。`);
  if (ledger.claimKeys.has(claimKey)) blockers.push("本组文件已在提交记录中，疑似重复。");
  if (group.serviceDate && ledger.serviceDates.has(group.serviceDate)) blockers.push("该服务日期已在提交记录中，疑似重复。");
  if (group.files.some((file) => file.confidence === "low")) warnings.push("部分文件识别置信度低，建议提交前复核。");

  return {
    id: claimKey,
    serviceDate: group.serviceDate,
    claimDate: group.claimDate,
    claimDateSource: group.claimDateSource,
    diagnosis: settings.diagnosis,
    files: group.files,
    fileNames,
    totalBytes: group.totalBytes,
    status: blockers.length ? "blocked" : warnings.length ? "review" : "ready",
    blockers: unique(blockers),
    warnings: unique(warnings),
    compression: {
      required: compression.items.length > 0,
      items: compression.items,
      projectedTotalBytes: compression.projectedTotalBytes,
    },
  };
}

export function planCompression(group, settings = DEFAULT_SETTINGS) {
  const enabled = settings.compression?.enabled !== false;
  const targetFileBytes = settings.compression?.targetFileBytes || Math.floor(settings.maxFileBytes * 0.95);
  const targetClaimBytes = settings.compression?.targetClaimBytes || Math.floor(settings.maxClaimBytes * 0.95);
  const items = [];
  const fileIds = new Set();
  let projectedTotalBytes = group.totalBytes;

  if (!enabled) {
    return { canAttempt: false, items, fileIds, projectedTotalBytes };
  }

  for (const file of group.files) {
    const isPdf = /\.pdf$/i.test(file.name);
    const tooLarge = file.size > settings.maxFileBytes;
    const usefulForTotal = projectedTotalBytes > settings.maxClaimBytes && isPdf && file.size > 1024 * 1024;
    if (isPdf && (tooLarge || usefulForTotal)) {
      const targetBytes = Math.min(targetFileBytes, Math.max(512 * 1024, Math.floor(file.size * 0.7)));
      items.push({
        fileId: file.id,
        name: file.name,
        path: file.path,
        size: file.size,
        targetBytes,
        reason: tooLarge ? "file-limit" : "claim-total-limit",
      });
      fileIds.add(file.id);
      projectedTotalBytes -= Math.max(0, file.size - targetBytes);
    }
  }

  const canAttempt = items.length > 0;
  if (projectedTotalBytes > targetClaimBytes) {
    for (const file of group.files) {
      if (!/\.pdf$/i.test(file.name) || fileIds.has(file.id) || file.size < 1024 * 1024) continue;
      const targetBytes = Math.max(512 * 1024, Math.floor(file.size * 0.7));
      items.push({
        fileId: file.id,
        name: file.name,
        path: file.path,
        size: file.size,
        targetBytes,
        reason: "claim-total-limit",
      });
      fileIds.add(file.id);
      projectedTotalBytes -= Math.max(0, file.size - targetBytes);
      if (projectedTotalBytes <= targetClaimBytes) break;
    }
  }

  return { canAttempt, items, fileIds, projectedTotalBytes };
}

export function extractDates(input, defaultYear = new Date().getFullYear()) {
  const out = [];
  const text = String(input || "");
  for (const match of text.matchAll(DATE_TOKEN_RE)) {
    let year;
    let month;
    let day;
    if (match[1]) {
      year = Number(match[1]);
      month = Number(match[2]);
      day = Number(match[3]);
    } else if (match[6]) {
      day = Number(match[4]);
      month = Number(match[5]);
      year = Number(match[6]);
    } else if (match[7]) {
      const compact = match[7];
      year = Number(compact.slice(0, 4));
      month = Number(compact.slice(4, 6));
      day = Number(compact.slice(6, 8));
    } else if (match[8]) {
      const compact = match[8];
      month = Number(compact.slice(0, 2));
      day = Number(compact.slice(2, 4));
      year = Number(defaultYear);
    }
    const iso = toIsoDate(year, month, day);
    if (iso) out.push(iso);
  }
  return unique(out);
}

export function pickServiceDate({ text, name, filenameDates, pathDates = [], textDates }) {
  const patterns = [
    /date\s+of\s+visit\s*[:\-]?\s*([0-9./-]{8,10})/i,
    /treatment\s+date\s*[:\-]?\s*([0-9./-]{8,10})/i,
    /date\s+of\s+service\s*[:\-]?\s*([0-9./-]{8,10})/i,
    /invoice\s+date\s*[:\-]?\s*([0-9./-]{8,10})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const [iso] = extractDates(match[1]);
      if (iso) return iso;
    }
  }
  if (filenameDates.length === 1) return filenameDates[0];
  if (/invoice|receipt|cigna|claim|scan|form/i.test(name) && filenameDates.length) return filenameDates[0];
  if (pathDates.length === 1) return pathDates[0];
  return textDates[0] || filenameDates[0] || "";
}

export function pickEarliestTreatmentDate({ text, serviceDate, settings }) {
  const patterns = [
    /date\s+of\s+first\s+consultation[^0-9]{0,80}([0-9./-]{8,10})/i,
    /first\s+consultation[^0-9]{0,80}([0-9./-]{8,10})/i,
    /date\s+of\s+onset[^0-9]{0,80}([0-9./-]{8,10})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const [iso] = extractDates(match[1], settings.defaultYear);
      if (iso) return iso;
    }
  }
  return settings.ongoingConditionEarliestDate || "";
}

export function classifyDocument({ name, text }) {
  const haystack = `${name}\n${text}`.toLowerCase();
  if (/\.(png|jpe?g|gif|bmp)$/i.test(name)) return "image";
  if (/progress\s+report/.test(haystack)) return "progress-report";
  if (/prescription|rx\b/.test(haystack)) return "prescription";
  if (/invoice|tax\s+invoice|receipt|付款|收据/.test(haystack)) return /receipt/.test(haystack) ? "receipt" : "invoice";
  if (/claim\s+form|scan\s+claim|cigna|medical\s+report|diagnosis|date\s+of\s+first\s+consultation/.test(haystack)) return "claim-form";
  if (/clinic|hospital|doctor|diagnosis|treatment/.test(haystack)) return "medical";
  return "unknown";
}

export function inferScanPairKinds(files) {
  const byDate = new Map();
  for (const file of files) {
    const key = file.serviceDate || file.earliestTreatmentDate || "undated";
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(file);
  }

  return files.map((file) => {
    if (file.kind !== "unknown" || !/\.pdf$/i.test(file.name)) return file;
    const peers = byDate.get(file.serviceDate || file.earliestTreatmentDate || "undated") || [];
    const hasNumberedPair = peers.some((peer) => /(?:^|[_\-\s])1(?:\D|$)/.test(peer.name)) && peers.some((peer) => /(?:^|[_\-\s])2(?:\D|$)/.test(peer.name));
    if (!hasNumberedPair) return file;
    if (/(?:^|[_\-\s])1(?:\D|$)/.test(file.name)) {
      return inferredScanFile(file, "claim-form", "按扫描件命名规则推断为医疗/理赔表。");
    }
    if (/(?:^|[_\-\s])2(?:\D|$)/.test(file.name)) {
      return inferredScanFile(file, "invoice", "按扫描件命名规则推断为发票/收据。");
    }
    return file;
  });
}

function inferredScanFile(file, kind, warning) {
  return {
    ...file,
    kind,
    inferredKind: true,
    confidence: file.serviceDate ? "medium" : file.confidence,
    warnings: [
      ...file.warnings.filter((item) => !item.includes("无法识别文件类型")),
      warning,
    ],
  };
}

export function makeClaimKey({ serviceDate, claimDate, files }) {
  const filePart = files
    .map((file) => file.sha256 || `${file.name}:${file.size}`)
    .sort()
    .join("|");
  return shaLike(`${serviceDate}|${claimDate}|${filePart}`);
}

export function normalizeLedger(ledger = {}) {
  return {
    fileHashes: new Set(ledger.fileHashes || []),
    claimKeys: new Set(ledger.claimKeys || []),
    serviceDates: new Set(ledger.serviceDates || []),
  };
}

function pickClaimDateForGroup(files, settings) {
  const dates = files
    .filter((file) => file.earliestTreatmentDate && file.earliestTreatmentDateSource !== "global-fallback")
    .map((file) => file.earliestTreatmentDate)
    .sort();
  return dates[0] || settings.ongoingConditionEarliestDate || "";
}

function pickClaimDateSourceForGroup(files, settings) {
  const datedFiles = files
    .filter((file) => file.earliestTreatmentDate && file.earliestTreatmentDateSource !== "global-fallback")
    .sort((a, b) => (
      a.earliestTreatmentDate.localeCompare(b.earliestTreatmentDate)
      || claimDateSourcePriority(a.earliestTreatmentDateSource) - claimDateSourcePriority(b.earliestTreatmentDateSource)
    ));
  if (datedFiles[0]) return datedFiles[0].earliestTreatmentDateSource || "file-text";
  if (settings.ongoingConditionEarliestDate) return "global-fallback";
  return "";
}

function claimDateSourcePriority(source) {
  const priority = {
    "manual-override": 0,
    "file-text": 1,
    "global-fallback": 2,
  };
  return priority[source] ?? 9;
}

function earliestTreatmentDateSourceFor({ text, date, settings }) {
  if (!date) return "";
  if (settings.ongoingConditionEarliestDate && date === settings.ongoingConditionEarliestDate && !textHasEarliestTreatmentDate(text, settings)) return "global-fallback";
  return "file-text";
}

function textHasEarliestTreatmentDate(text, settings) {
  return Boolean(pickEarliestTreatmentDate({ text, serviceDate: "", settings: { ...settings, ongoingConditionEarliestDate: "" } }));
}

function confidenceFor({ kind, text, serviceDate, earliestTreatmentDate, filenameDates }) {
  if (text && serviceDate && earliestTreatmentDate && kind !== "unknown") return "high";
  if ((serviceDate || filenameDates.length) && kind !== "unknown") return "medium";
  return "low";
}

function fileWarnings({ kind, size, serviceDate, earliestTreatmentDate, settings, text }) {
  const warnings = [];
  if (kind === "unknown") warnings.push("无法识别文件类型。");
  if (!text && kind !== "image") warnings.push("PDF 文本层为空，可能是扫描件。");
  if (!serviceDate) warnings.push("未识别服务日期。");
  if (!earliestTreatmentDate) warnings.push("未识别最早治疗日期。");
  if (size > settings.maxFileBytes) warnings.push(`文件超过 ${formatBytes(settings.maxFileBytes)}，需要压缩。`);
  return warnings;
}

function summarizeClaims(claims, duplicateFiles) {
  return {
    ready: claims.filter((claim) => claim.status === "ready").length,
    review: claims.filter((claim) => claim.status === "review").length,
    blocked: claims.filter((claim) => claim.status === "blocked").length,
    duplicates: duplicateFiles.length,
  };
}

function compareFiles(a, b) {
  const rank = { "claim-form": 0, medical: 1, "progress-report": 2, prescription: 3, invoice: 4, receipt: 5, image: 6, unknown: 7 };
  return (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || a.name.localeCompare(b.name);
}

function withUploadOrder(files) {
  return files.map((file, index) => ({
    ...file,
    uploadOrder: index + 1,
  }));
}

function logicalFileKey(file) {
  const scope = file.serviceDate || dirname(file.relativePath || file.path || "");
  const name = String(file.name)
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/\bcopy\b/g, "")
    .replace(/[-_\s]*compressed\b/g, "")
    .replace(/[-_\s]+/g, " ")
    .trim();
  return `${scope}|${name}`;
}

function displayFileName(file) {
  return file.relativePath || file.name;
}

function dirname(path) {
  const value = String(path || "");
  const index = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return index > 0 ? value.slice(0, index) : "";
}

function scoreFileVariant(file) {
  let score = 0;
  if (/compressed/i.test(file.name)) score += 100;
  if (!/copy/i.test(file.name)) score += 10;
  if (file.size && file.size <= DEFAULT_SETTINGS.maxFileBytes) score += 20;
  if (file.source?.hasText) score += 5;
  return score;
}

function toIsoDate(year, month, day) {
  if (!year || !month || !day) return "";
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return "";
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function basename(path) {
  return String(path).split(/[\\/]/).pop();
}

function relativePathFrom(path) {
  const value = String(path || "");
  if (!value || /^[a-z]+:\/\//i.test(value) || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return "";
  return value.includes("/") || value.includes("\\") ? value : "";
}

function stableFileId({ name, hash, size }) {
  return hash || shaLike(`${name}:${size}`);
}

function shaLike(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function dropEmpty(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== "" && value != null));
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
