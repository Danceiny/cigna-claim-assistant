#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { PDFDocument } from "pdf-lib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await mkdtemp(join(tmpdir(), "cigna-scan-cli-"));

try {
  const inputDir = join(tmp, "claims");
  const datedDir = join(inputDir, "2026-05-14");
  await mkdir(datedDir, { recursive: true });
  const blankPdf = await makeBlankPdf();
  await writeFile(join(datedDir, "scan_1.pdf"), blankPdf);
  await writeFile(join(datedDir, "scan_2.pdf"), blankPdf);
  await writeFile(join(inputDir, "notes.txt"), "ignore me");

  const outputPath = join(tmp, "plan.json");
  await run(process.execPath, [
    "scripts/scan-claims.mjs",
    "--dir",
    inputDir,
    "--output",
    outputPath,
    "--earliest",
    "2026-05-05",
  ]);

  const plan = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(plan.claims.length, 1);
  assert.equal(plan.claims[0].serviceDate, "2026-05-14");
  assert.equal(plan.claims[0].claimDate, "2026-05-05");
  assert.deepEqual(plan.claims[0].files.map((file) => file.kind).sort(), ["claim-form", "invoice"]);
  assert.deepEqual(plan.claims[0].files.map((file) => file.relativePath).sort(), [
    "2026-05-14/scan_1.pdf",
    "2026-05-14/scan_2.pdf",
  ]);

  const minServiceDateOutputPath = join(tmp, "min-service-date-plan.json");
  await run(process.execPath, [
    "scripts/scan-claims.mjs",
    "--dir",
    inputDir,
    "--output",
    minServiceDateOutputPath,
    "--earliest",
    "2026-05-05",
    "--min-service-date",
    "2026-05-15",
  ]);
  const minServiceDatePlan = JSON.parse(await readFile(minServiceDateOutputPath, "utf8"));
  assert.equal(minServiceDatePlan.claims.length, 1);
  assert.equal(minServiceDatePlan.claims[0].status, "blocked");
  assert.match(minServiceDatePlan.claims[0].blockers.join("\n"), /早于提交起始日期 2026-05-15/);

  const sidecarDir = join(inputDir, "sidecar");
  await mkdir(sidecarDir, { recursive: true });
  await writeFile(join(sidecarDir, "medical.pdf"), blankPdf);
  await writeFile(join(sidecarDir, "invoice.pdf"), blankPdf);
  await writeFile(join(sidecarDir, "medical.pdf.txt"), "Cigna claim form. Treatment Date 15/05/2026. Diagnosis lower back pain.");
  await writeFile(join(sidecarDir, "invoice.pdf.txt"), "Tax Invoice. Invoice Date 15/05/2026.");
  const sidecarOutputPath = join(tmp, "sidecar-plan.json");
  await run(process.execPath, [
    "scripts/scan-claims.mjs",
    "--dir",
    sidecarDir,
    "--output",
    sidecarOutputPath,
    "--earliest",
    "2026-05-05",
  ]);
  const sidecarPlan = JSON.parse(await readFile(sidecarOutputPath, "utf8"));
  assert.equal(sidecarPlan.claims.length, 1);
  assert.equal(sidecarPlan.claims[0].serviceDate, "2026-05-15");
  assert.deepEqual(sidecarPlan.claims[0].files.map((file) => file.kind).sort(), ["claim-form", "invoice"]);
  assert.equal(sidecarPlan.claims[0].files.every((file) => file.source.ocr?.method === "sidecar"), true);

  const ocrDir = join(inputDir, "ocr-command");
  await mkdir(ocrDir, { recursive: true });
  await writeFile(join(ocrDir, "scan-a.pdf"), blankPdf);
  await writeFile(join(ocrDir, "scan-b.pdf"), blankPdf);
  const fakeOcr = join(tmp, "fake-ocr.sh");
  await writeFile(fakeOcr, [
    "#!/bin/sh",
    "case \"$1\" in",
    "  *scan-a.pdf) echo 'Cigna claim form. Treatment Date 16/05/2026. Diagnosis lower back pain.' ;;",
    "  *scan-b.pdf) echo 'Tax Invoice. Invoice Date 16/05/2026.' ;;",
    "  *) echo '' ;;",
    "esac",
    "",
  ].join("\n"));
  await chmod(fakeOcr, 0o755);
  const ocrOutputPath = join(tmp, "ocr-plan.json");
  await run(process.execPath, [
    "scripts/scan-claims.mjs",
    "--dir",
    ocrDir,
    "--output",
    ocrOutputPath,
    "--earliest",
    "2026-05-05",
    "--ocr",
    "--ocr-command",
    fakeOcr,
  ]);
  const ocrPlan = JSON.parse(await readFile(ocrOutputPath, "utf8"));
  assert.equal(ocrPlan.claims.length, 1);
  assert.equal(ocrPlan.claims[0].serviceDate, "2026-05-16");
  assert.deepEqual(ocrPlan.claims[0].files.map((file) => file.kind).sort(), ["claim-form", "invoice"]);
  assert.equal(ocrPlan.claims[0].files.every((file) => file.source.ocr?.method === "external-ocr-command"), true);

  const generatedSidecarDir = join(inputDir, "generated-sidecars");
  await mkdir(generatedSidecarDir, { recursive: true });
  await writeFile(join(generatedSidecarDir, "scan-c.pdf"), blankPdf);
  await writeFile(join(generatedSidecarDir, "scan-d.pdf"), blankPdf);
  const fakeSidecarOcr = join(tmp, "fake-sidecar-ocr.sh");
  await writeFile(fakeSidecarOcr, [
    "#!/bin/sh",
    "case \"$1\" in",
    "  *scan-c.pdf) echo 'Cigna claim form. Treatment Date 17/05/2026. Date of first consultation 05/05/2026. Diagnosis lower back pain.' ;;",
    "  *scan-d.pdf) echo 'Tax Invoice. Invoice Date 17/05/2026.' ;;",
    "  *) echo '' ;;",
    "esac",
    "",
  ].join("\n"));
  await chmod(fakeSidecarOcr, 0o755);
  await run(process.execPath, [
    "scripts/generate-ocr-sidecars.mjs",
    "--dir",
    generatedSidecarDir,
    "--ocr-command",
    fakeSidecarOcr,
  ]);
  assert.match(await readFile(join(generatedSidecarDir, "scan-c.pdf.txt"), "utf8"), /Date of first consultation 05\/05\/2026/);
  assert.match(await readFile(join(generatedSidecarDir, "scan-d.pdf.txt"), "utf8"), /Tax Invoice/);

  const generatedSidecarOutputPath = join(tmp, "generated-sidecar-plan.json");
  await run(process.execPath, [
    "scripts/scan-claims.mjs",
    "--dir",
    generatedSidecarDir,
    "--output",
    generatedSidecarOutputPath,
  ]);
  const generatedSidecarPlan = JSON.parse(await readFile(generatedSidecarOutputPath, "utf8"));
  assert.equal(generatedSidecarPlan.claims.length, 1);
  assert.equal(generatedSidecarPlan.claims[0].serviceDate, "2026-05-17");
  assert.equal(generatedSidecarPlan.claims[0].claimDate, "2026-05-05");
  assert.deepEqual(generatedSidecarPlan.claims[0].files.map((file) => file.kind).sort(), ["claim-form", "invoice"]);
  assert.equal(generatedSidecarPlan.claims[0].files.every((file) => file.source.ocr?.method === "sidecar"), true);

  const cleanCwd = join(tmp, "clean-cwd");
  await mkdir(cleanCwd);
  await run(process.execPath, [
    join(root, "scripts/scan-claims.mjs"),
    "--dir",
    generatedSidecarDir,
  ], { cwd: cleanCwd });
  const defaultOutputPlan = JSON.parse(await readFile(join(cleanCwd, "outputs", "cigna-claim-plan.json"), "utf8"));
  assert.equal(defaultOutputPlan.claims.length, 1);

  const exactFilesDir = join(inputDir, "exact-files");
  await mkdir(exactFilesDir, { recursive: true });
  await writeFile(join(exactFilesDir, "picked-medical.pdf"), blankPdf);
  await writeFile(join(exactFilesDir, "picked-invoice.pdf"), blankPdf);
  await writeFile(join(exactFilesDir, "ignored-medical.pdf"), blankPdf);
  await writeFile(join(exactFilesDir, "picked-medical.pdf.txt"), "Cigna claim form. Treatment Date 18/05/2026. Diagnosis lower back pain.");
  await writeFile(join(exactFilesDir, "picked-invoice.pdf.txt"), "Tax Invoice. Invoice Date 18/05/2026.");
  await writeFile(join(exactFilesDir, "ignored-medical.pdf.txt"), "Cigna claim form. Treatment Date 19/05/2026. Diagnosis lower back pain.");
  const exactFilesOutputPath = join(tmp, "exact-files-plan.json");
  await run(process.execPath, [
    "scripts/scan-claims.mjs",
    "--file",
    join(exactFilesDir, "picked-medical.pdf"),
    "--file",
    join(exactFilesDir, "picked-invoice.pdf"),
    "--output",
    exactFilesOutputPath,
    "--earliest",
    "2026-05-05",
  ]);
  const exactFilesPlan = JSON.parse(await readFile(exactFilesOutputPath, "utf8"));
  assert.equal(exactFilesPlan.claims.length, 1);
  assert.equal(exactFilesPlan.claims[0].serviceDate, "2026-05-18");
  assert.deepEqual(exactFilesPlan.claims[0].files.map((file) => file.relativePath).sort(), [
    "picked-invoice.pdf",
    "picked-medical.pdf",
  ]);

  const messyDir = join(inputDir, "messy-folder");
  await mkdir(messyDir, { recursive: true });
  await writeFile(join(messyDir, "IMG_9942 final FINAL.pdf"), blankPdf);
  await writeFile(join(messyDir, "wechat export(7).pdf"), blankPdf);
  await writeFile(join(messyDir, "IMG_9942 final FINAL.pdf.txt"), "Cigna claim form. Treatment Date 20/05/2026. Date of first consultation 05/05/2026. Diagnosis lower back pain.");
  await writeFile(join(messyDir, "wechat export(7).pdf.txt"), "Tax Invoice. Invoice Date 20/05/2026.");
  const organizedDir = join(tmp, "organized-claims");
  const messyOutputPath = join(tmp, "messy-plan.json");
  await run(process.execPath, [
    "scripts/scan-claims.mjs",
    "--dir",
    messyDir,
    "--output",
    messyOutputPath,
    "--organize",
    "--organize-dir",
    organizedDir,
  ]);
  const organizedManifest = JSON.parse(await readFile(join(organizedDir, "organize-manifest.json"), "utf8"));
  assert.equal(organizedManifest.files.length, 2);
  assert.equal(organizedManifest.files.every((file) => file.serviceDate === "2026-05-20"), true);
  assert.equal(organizedManifest.files.some((file) => /2026-05-20_01_claim-form_IMG_9942-final-FINAL\.pdf$/.test(file.target)), true);
  assert.equal(organizedManifest.files.some((file) => /2026-05-20_02_invoice_wechat-export-7\.pdf$/.test(file.target)), true);
  assert.deepEqual((await readdir(join(organizedDir, "2026-05-20"))).sort(), [
    "2026-05-20_01_claim-form_IMG_9942-final-FINAL.pdf",
    "2026-05-20_02_invoice_wechat-export-7.pdf",
  ]);

  console.log("scan claims CLI test passed");
} finally {
  await rm(tmp, { recursive: true, force: true });
}

async function makeBlankPdf() {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}\n${stdout}\n${stderr}`));
    });
    child.on("error", reject);
  });
}
