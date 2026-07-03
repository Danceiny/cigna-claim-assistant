#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, extname, join, relative } from "node:path";
import { buildClaimPlan } from "../src/core/claimIntake.mjs";
import { compressClaimFiles } from "../src/core/pdfCompress.mjs";

const PDFJS = await import("pdfjs-dist/legacy/build/pdf.mjs");
PDFJS.GlobalWorkerOptions.workerSrc = new URL("../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).toString();

const args = parseArgs(process.argv.slice(2));
const inputFiles = arrayArg(args.file);
const inputDir = args.dir || (inputFiles.length ? "" : "/Users/bytedance/Documents/报销");
const outputPath = args.output || "outputs/cigna-claim-plan.json";
const doCompress = Boolean(args.compress);
const doOcr = Boolean(args.ocr);
const doOrganize = Boolean(args.organize);
const organizeDir = args["organize-dir"] || "outputs/organized-claims";
const settings = {
  diagnosis: args.diagnosis || "",
  ongoingConditionEarliestDate: args.earliest || "",
  minServiceDate: args["min-service-date"] || "",
};

const records = [];
for await (const entry of collectInputFiles({ inputDir, inputFiles })) {
  const path = entry.path;
  const info = await stat(path);
  records.push(await buildFileRecord(path, info, entry.relativePath));
}

const plan = await buildClaimPlan(records, { settings });

if (doCompress) {
  for (const claim of plan.claims) {
    if (!claim.compression?.required) continue;
    const compression = await compressClaimFiles(claim);
    claim.compression.results = compression.results;
  }
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
const organized = doOrganize ? await organizePlanFiles(plan, organizeDir) : null;
printSummary(plan, outputPath);
if (organized) {
  console.log(`Organized: ${organized.files.length} files -> ${organized.dir}`);
  console.log(`Organize manifest: ${organized.manifestPath}`);
}

async function buildFileRecord(path, info, relativePath) {
  const bytes = await readFile(path);
  const nativeText = /\.pdf$/i.test(path) ? await extractPdfText(bytes).catch(() => "") : "";
  const ocr = nativeText.trim() ? { skipped: true, reason: "pdf-text-layer-present" } : await extractOcrText(path);
  const text = nativeText || ocr.text || "";
  return {
    path,
    relativePath,
    name: basename(path),
    size: info.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    text,
    ocr: sanitizeOcrResult(ocr),
  };
}

async function* walkSupportedFiles(dir, root = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkSupportedFiles(path, root);
      continue;
    }
    if (!entry.isFile() || !/\.(pdf|png|jpe?g|gif|bmp)$/i.test(entry.name)) continue;
    yield {
      path,
      relativePath: relative(root, path),
    };
  }
}

async function* collectInputFiles({ inputDir, inputFiles }) {
  if (inputFiles.length) {
    const entries = [];
    for (const file of inputFiles) {
      const info = await stat(file);
      if (!info.isFile() || !/\.(pdf|png|jpe?g|gif|bmp)$/i.test(file)) continue;
      entries.push({
        path: file,
        relativePath: basename(file),
      });
    }
    entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    for (const entry of entries) yield entry;
    return;
  }
  yield* walkSupportedFiles(inputDir);
}

async function extractPdfText(bytes) {
  const data = new Uint8Array(bytes);
  const doc = await PDFJS.getDocument({ data, useWorkerFetch: false, isEvalSupported: false }).promise;
  const pages = [];
  for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
    const page = await doc.getPage(pageNo);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str || "").join(" "));
  }
  return pages.join("\n");
}

async function extractOcrText(path) {
  if (!/\.(pdf|png|jpe?g|gif|bmp)$/i.test(path)) return { skipped: true, reason: "unsupported-file" };
  const sidecar = await readOcrSidecar(path);
  if (sidecar.text) return sidecar;
  if (!doOcr) return { skipped: true, reason: "ocr-disabled" };
  return runOcrCommand(path);
}

async function readOcrSidecar(path) {
  if (args["no-ocr-sidecar"]) return { skipped: true, reason: "ocr-sidecar-disabled" };
  const candidates = [`${path}.txt`];
  if (extname(path)) candidates.push(path.slice(0, -extname(path).length) + ".txt");
  for (const candidate of candidates) {
    try {
      const text = await readFile(candidate, "utf8");
      if (text.trim()) {
        return {
          text,
          method: "sidecar",
          sidecarPath: candidate,
        };
      }
    } catch {
      // Try the next sidecar name.
    }
  }
  return { skipped: true, reason: "no-ocr-sidecar" };
}

async function runOcrCommand(path) {
  const command = args["ocr-command"] || "tesseract";
  const explicitCommand = Boolean(args["ocr-command"]);
  const commandAvailable = await isExecutable(command);
  if (!commandAvailable) {
    if (explicitCommand) {
      return { error: `OCR command not found or not executable: ${command}` };
    }
    return { skipped: true, reason: "tesseract-not-installed" };
  }

  const lang = args["ocr-lang"] || "eng";
  const commandArgs = explicitCommand ? [path] : [path, "stdout", "-l", lang];
  const result = await run(command, commandArgs, { timeoutMs: Number(args["ocr-timeout-ms"] || 60000) });
  if (result.code !== 0) {
    return {
      error: `OCR command failed with exit code ${result.code}`,
      stderr: result.stderr.slice(0, 1000),
      method: explicitCommand ? "external-ocr-command" : "tesseract",
    };
  }
  return {
    text: result.stdout,
    method: explicitCommand ? "external-ocr-command" : "tesseract",
  };
}

async function isExecutable(command) {
  if (command.includes("/")) {
    return access(command, constants.X_OK).then(() => true, () => false);
  }
  const paths = String(process.env.PATH || "").split(":").filter(Boolean);
  for (const dir of paths) {
    if (await access(join(dir, command), constants.X_OK).then(() => true, () => false)) return true;
  }
  return false;
}

function printSummary(plan, outputPath) {
  console.log(`Wrote ${outputPath}`);
  console.log(`Ready: ${plan.summary.ready}, review: ${plan.summary.review}, blocked: ${plan.summary.blocked}, duplicates: ${plan.summary.duplicates}`);
  for (const claim of plan.claims) {
    const tag = claim.status.toUpperCase().padEnd(7);
    const compression = claim.compression.required ? ` compress:${claim.compression.items.length}` : "";
    console.log(`${tag} ${claim.serviceDate || "undated"} claimDate=${claim.claimDate || "-"} files=${claim.files.length}${compression}`);
    for (const blocker of claim.blockers) console.log(`  BLOCK ${blocker}`);
    for (const warning of claim.warnings.slice(0, 3)) console.log(`  WARN  ${warning}`);
  }
}

async function organizePlanFiles(plan, targetDir) {
  await mkdir(targetDir, { recursive: true });
  const used = new Set();
  const entries = [];
  for (const claim of plan.claims) {
    const claimDir = join(targetDir, safeName(claim.serviceDate || "undated"));
    await mkdir(claimDir, { recursive: true });
    for (const file of claim.files || []) {
      if (!file.path) continue;
      const ext = extname(file.name || file.path) || ".bin";
      const ordered = String(file.uploadOrder || entries.length + 1).padStart(2, "0");
      const base = safeName(stripExtension(file.name || basename(file.path))) || "file";
      const targetName = uniqueTargetName(
        claimDir,
        `${claim.serviceDate || "undated"}_${ordered}_${safeName(file.kind || "unknown")}_${base}${ext.toLowerCase()}`,
        used,
      );
      const targetPath = join(claimDir, targetName);
      await copyFile(file.path, targetPath);
      entries.push({
        source: file.path,
        target: targetPath,
        serviceDate: claim.serviceDate || "",
        claimDate: claim.claimDate || "",
        kind: file.kind || "unknown",
        uploadOrder: file.uploadOrder || null,
        sha256: file.sha256 || "",
        status: claim.status,
      });
    }
  }
  const manifestPath = join(targetDir, "organize-manifest.json");
  const manifest = {
    schema: "cigna-claim-assistant-organized-v1",
    generatedAt: new Date().toISOString(),
    dir: targetDir,
    files: entries,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir: targetDir, manifestPath, files: entries };
}

function uniqueTargetName(dir, name, used) {
  const ext = extname(name);
  const stem = stripExtension(name);
  let candidate = name;
  let index = 2;
  while (used.has(join(dir, candidate))) {
    candidate = `${stem}-${index}${ext}`;
    index += 1;
  }
  used.add(join(dir, candidate));
  return candidate;
}

function safeName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 96);
}

function stripExtension(value) {
  const ext = extname(value);
  return ext ? value.slice(0, -ext.length) : value;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) appendArg(out, key, true);
      else {
        appendArg(out, key, next);
        i += 1;
      }
    }
  }
  return out;
}

function appendArg(out, key, value) {
  if (out[key] == null) {
    out[key] = value;
    return;
  }
  if (Array.isArray(out[key])) out[key].push(value);
  else out[key] = [out[key], value];
}

function arrayArg(value) {
  if (value == null || value === true) return [];
  return Array.isArray(value) ? value : [value];
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      resolve({ code: -1, stdout, stderr, error: error.message });
    });
  });
}

function sanitizeOcrResult(ocr) {
  if (!ocr) return {};
  const { text, ...rest } = ocr;
  return {
    ...rest,
    hasText: Boolean(text && text.trim()),
    textLength: text ? text.length : 0,
  };
}
