#!/usr/bin/env node
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PDFJS = await import("pdfjs-dist/legacy/build/pdf.mjs");
PDFJS.GlobalWorkerOptions.workerSrc = new URL("../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).toString();

const args = parseArgs(process.argv.slice(2));
const scriptDir = dirname(fileURLToPath(import.meta.url));
const inputDir = args.dir || "/Users/bytedance/Documents/报销";
const command = args["ocr-command"] || "tesseract";
const explicitCommand = Boolean(args["ocr-command"]);
const lang = args["ocr-lang"] || "eng";
const timeoutMs = Number(args["ocr-timeout-ms"] || args.timeout || 60000);
const overwrite = Boolean(args.overwrite);
const force = Boolean(args.force);
const sidecarStyle = args["sidecar-style"] || "pdf.txt";

const commandAvailable = await isExecutable(command);
const macosVisionAvailable = !explicitCommand && await hasMacosVisionOcr();
if (!commandAvailable && !macosVisionAvailable) {
  const message = explicitCommand
    ? `OCR command not found or not executable: ${command}`
    : "tesseract is not installed or not on PATH, and macOS Vision OCR is unavailable. Install tesseract, pass --ocr-command, or use existing sidecars.";
  console.error(message);
  process.exitCode = 1;
} else {
  const results = [];
  for await (const entry of walkSupportedFiles(inputDir)) {
    results.push(await generateSidecar(entry.path, entry.relativePath));
  }
  printSummary(results);
  if (results.some((result) => result.status === "failed")) process.exitCode = 1;
}

async function generateSidecar(path, relativePath) {
  const outputPath = sidecarPathFor(path);
  const existing = await stat(outputPath).catch(() => null);
  if (existing?.isFile() && !overwrite) {
    return { status: "skipped", reason: "sidecar-exists", path, relativePath, outputPath };
  }

  if (!force && /\.pdf$/i.test(path)) {
    const bytes = await readFile(path);
    const nativeText = await extractPdfText(bytes).catch(() => "");
    if (nativeText.trim()) {
      return { status: "skipped", reason: "pdf-text-layer-present", path, relativePath, outputPath };
    }
  }

  const result = await runOcrCommand(path);
  if (result.code !== 0 || !result.stdout.trim()) {
    return {
      status: "failed",
      reason: result.code === 0 ? "empty-ocr-output" : `ocr-exit-${result.code}`,
      path,
      relativePath,
      outputPath,
      stderr: result.stderr.slice(0, 1000),
    };
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, normalizeOcrText(result.stdout));
  return {
    status: "written",
    path,
    relativePath,
    outputPath,
    bytes: Buffer.byteLength(result.stdout),
    method: result.method,
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
    yield { path, relativePath: relative(root, path) };
  }
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

function sidecarPathFor(path) {
  if (sidecarStyle === "stem") {
    const ext = extname(path);
    return ext ? `${path.slice(0, -ext.length)}.txt` : `${path}.txt`;
  }
  return `${path}.txt`;
}

async function runOcrCommand(path) {
  if (!commandAvailable && macosVisionAvailable) {
    const script = join(scriptDir, "macos-vision-ocr.swift");
    return { ...await run("swift", [script, path], { timeoutMs: Math.max(timeoutMs, 120000) }), method: "macos-vision" };
  }
  const commandArgs = explicitCommand ? [path] : [path, "stdout", "-l", lang];
  return { ...await run(command, commandArgs, { timeoutMs }), method: explicitCommand ? "external-ocr-command" : "tesseract" };
}

async function hasMacosVisionOcr() {
  if (process.platform !== "darwin") return false;
  if (!(await isExecutable("swift"))) return false;
  const script = join(scriptDir, "macos-vision-ocr.swift");
  return access(script, constants.R_OK).then(() => true, () => false);
}

async function isExecutable(candidate) {
  if (candidate.includes("/")) {
    return access(candidate, constants.X_OK).then(() => true, () => false);
  }
  const paths = String(process.env.PATH || "").split(":").filter(Boolean);
  for (const dir of paths) {
    if (await access(join(dir, candidate), constants.X_OK).then(() => true, () => false)) return true;
  }
  return false;
}

function normalizeOcrText(text) {
  return `${String(text || "").replace(/\r\n/g, "\n").trim()}\n`;
}

function printSummary(results) {
  const counts = countByStatus(results);
  console.log(`OCR sidecars for ${inputDir}`);
  console.log(`Written: ${counts.written || 0}, skipped: ${counts.skipped || 0}, failed: ${counts.failed || 0}`);
  for (const result of results) {
    const label = result.status.toUpperCase().padEnd(7);
    const detail = result.status === "written"
      ? `-> ${relative(inputDir, result.outputPath)}`
      : `${result.reason}${result.stderr ? `: ${result.stderr}` : ""}`;
    console.log(`${label} ${result.relativePath || basename(result.path)} ${detail}`);
  }
}

function countByStatus(results) {
  const counts = {};
  for (const result of results) counts[result.status] = (counts[result.status] || 0) + 1;
  return counts;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function run(executable, commandArgs, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(executable, commandArgs, { stdio: ["ignore", "pipe", "pipe"] });
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
      resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}` });
    });
  });
}
