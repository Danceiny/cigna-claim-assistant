#!/usr/bin/env node
import assert from "node:assert/strict";
import { buildClaimPlan, extractDates, planCompression } from "../src/core/claimIntake.mjs";

assert.deepEqual(extractDates("CIGNA 24.06.2026.pdf"), ["2026-06-24"]);
assert.deepEqual(extractDates("Date of Visit: 12/05/2026 Date of first consultation: 05/05/2026"), ["2026-05-12", "2026-05-05"]);

const baseSettings = {
  diagnosis: "LOWER-BACK-PAIN",
  ongoingConditionEarliestDate: "2026-05-05",
};

const invoiceOnly = await buildClaimPlan(
  [
    {
      name: "INVOICE 24.06.2026.pdf",
      size: 400_000,
      sha256: "invoice1",
      text: "Tax Invoice Invoice Date 24/06/2026",
    },
  ],
  { settings: baseSettings },
);
assert.equal(invoiceOnly.claims.length, 1);
assert.equal(invoiceOnly.claims[0].status, "blocked");
assert.match(invoiceOnly.claims[0].blockers.join("\n"), /只有发票/);

const medicalOnly = await buildClaimPlan(
  [
    {
      name: "CIGNA 24.06.2026.pdf",
      size: 400_000,
      sha256: "medical-only",
      text: "Cigna claim form. Treatment Date 24/06/2026. Diagnosis lower back pain.",
    },
  ],
  { settings: baseSettings },
);
assert.equal(medicalOnly.claims.length, 1);
assert.equal(medicalOnly.claims[0].status, "blocked");
assert.match(medicalOnly.claims[0].blockers.join("\n"), /缺少发票/);

const ready = await buildClaimPlan(
  [
    {
      name: "CIGNA 24.06.2026.pdf",
      size: 7_200_000,
      sha256: "medical1",
      text: "Cigna claim form. Treatment Date 24/06/2026. Diagnosis lower back pain.",
    },
    {
      name: "INVOICE 24.06.2026.pdf",
      size: 400_000,
      sha256: "invoice2",
      text: "Tax Invoice Invoice Date 24/06/2026",
    },
  ],
  { settings: baseSettings },
);
assert.equal(ready.claims.length, 1);
assert.equal(ready.claims[0].status, "review");
assert.equal(ready.claims[0].claimDate, "2026-05-05");
assert.equal(ready.claims[0].claimDateSource, "global-fallback");
assert.equal(ready.claims[0].compression.required, true);
assert.equal(ready.claims[0].compression.items[0].name, "CIGNA 24.06.2026.pdf");

const stableUploadOrder = await buildClaimPlan(
  [
    {
      name: "AAA INVOICE 19.06.2026.pdf",
      size: 300_000,
      sha256: "invoice-upload-order",
      text: "Tax Invoice Invoice Date 19/06/2026",
    },
    {
      name: "ZZZ CIGNA 19.06.2026.pdf",
      size: 400_000,
      sha256: "medical-upload-order",
      text: "Cigna claim form. Treatment Date 19/06/2026. Date of first consultation 03/06/2026. Diagnosis lower back pain.",
    },
  ],
  { settings: baseSettings },
);
assert.deepEqual(stableUploadOrder.claims[0].files.map((file) => `${file.uploadOrder}:${file.kind}:${file.name}`), [
  "1:claim-form:ZZZ CIGNA 19.06.2026.pdf",
  "2:invoice:AAA INVOICE 19.06.2026.pdf",
]);

const pdfEarliestWithoutGlobalFallback = await buildClaimPlan(
  [
    {
      name: "CIGNA 15.06.2026.pdf",
      size: 400_000,
      sha256: "medical-pdf-earliest",
      text: "Cigna claim form. Treatment Date 15/06/2026. Date of first consultation 03/06/2026. Diagnosis lower back pain.",
    },
    {
      name: "INVOICE 15.06.2026.pdf",
      size: 300_000,
      sha256: "invoice-pdf-earliest",
      text: "Tax Invoice Invoice Date 15/06/2026",
    },
  ],
  { settings: { diagnosis: "LOWER-BACK-PAIN" } },
);
assert.equal(pdfEarliestWithoutGlobalFallback.claims.length, 1);
assert.equal(pdfEarliestWithoutGlobalFallback.claims[0].claimDate, "2026-06-03");
assert.equal(pdfEarliestWithoutGlobalFallback.claims[0].claimDateSource, "file-text");
assert.notEqual(pdfEarliestWithoutGlobalFallback.claims[0].claimDate, pdfEarliestWithoutGlobalFallback.claims[0].serviceDate);

const pdfEarliestBeatsGlobalFallback = await buildClaimPlan(
  [
    {
      name: "CIGNA 18.06.2026.pdf",
      size: 400_000,
      sha256: "medical-pdf-earliest-with-global",
      text: "Cigna claim form. Treatment Date 18/06/2026. Date of first consultation 03/06/2026. Diagnosis lower back pain.",
    },
    {
      name: "INVOICE 18.06.2026.pdf",
      size: 300_000,
      sha256: "invoice-global-fallback-only",
      text: "Tax Invoice Invoice Date 18/06/2026",
    },
  ],
  { settings: baseSettings },
);
assert.equal(pdfEarliestBeatsGlobalFallback.claims.length, 1);
assert.equal(pdfEarliestBeatsGlobalFallback.claims[0].claimDate, "2026-06-03");
assert.equal(pdfEarliestBeatsGlobalFallback.claims[0].claimDateSource, "file-text");

const missingEarliestWithoutGlobalFallback = await buildClaimPlan(
  [
    {
      name: "CIGNA 16.06.2026.pdf",
      size: 400_000,
      sha256: "medical-no-earliest",
      text: "Cigna claim form. Treatment Date 16/06/2026. Diagnosis lower back pain.",
    },
    {
      name: "INVOICE 16.06.2026.pdf",
      size: 300_000,
      sha256: "invoice-no-earliest",
      text: "Tax Invoice Invoice Date 16/06/2026",
    },
  ],
  { settings: { diagnosis: "LOWER-BACK-PAIN" } },
);
assert.equal(missingEarliestWithoutGlobalFallback.claims.length, 1);
assert.equal(missingEarliestWithoutGlobalFallback.claims[0].status, "blocked");
assert.match(missingEarliestWithoutGlobalFallback.claims[0].blockers.join("\n"), /无法确定最早治疗日期/);

const beforeStart = await buildClaimPlan(
  [
    {
      name: "CIGNA 07.05.2026.pdf",
      size: 400_000,
      sha256: "medical-before-start",
      text: "Cigna claim form. Treatment Date 07/05/2026. Diagnosis lower back pain.",
    },
    {
      name: "INVOICE 07.05.2026.pdf",
      size: 400_000,
      sha256: "invoice-before-start",
      text: "Tax Invoice Invoice Date 07/05/2026",
    },
  ],
  { settings: { ...baseSettings, minServiceDate: "2026-05-08" } },
);
assert.equal(beforeStart.claims.length, 1);
assert.equal(beforeStart.claims[0].status, "blocked");
assert.match(beforeStart.claims[0].blockers.join("\n"), /早于提交起始日期 2026-05-08/);

const duplicate = await buildClaimPlan(
  [
    {
      name: "CIGNA 24.06.2026.pdf",
      size: 7_200_000,
      sha256: "medical1",
      text: "Treatment Date 24/06/2026.",
    },
  ],
  { settings: baseSettings, ledger: { fileHashes: ["medical1"] } },
);
assert.equal(duplicate.duplicateFiles.length, 1);
assert.equal(duplicate.claims.length, 0);

const duplicateDate = await buildClaimPlan(
  [
    {
      name: "CIGNA 24.06.2026 redownloaded.pdf",
      size: 500_000,
      sha256: "medical-redownloaded",
      text: "Cigna claim form. Treatment Date 24/06/2026. Diagnosis lower back pain.",
    },
    {
      name: "INVOICE 24.06.2026 redownloaded.pdf",
      size: 300_000,
      sha256: "invoice-redownloaded",
      text: "Tax Invoice Invoice Date 24/06/2026",
    },
  ],
  { settings: baseSettings, ledger: { serviceDates: ["2026-06-24"] } },
);
assert.equal(duplicateDate.claims.length, 1);
assert.equal(duplicateDate.claims[0].status, "blocked");
assert.match(duplicateDate.claims[0].blockers.join("\n"), /服务日期已在提交记录/);

const undatedScan = await buildClaimPlan(
  [
    {
      name: "scan-undated.pdf",
      size: 400_000,
      sha256: "undated-scan",
      text: "",
    },
  ],
  { settings: baseSettings },
);
assert.equal(undatedScan.claims[0].serviceDate, "");
assert.equal(undatedScan.claims[0].claimDate, "2026-05-05");
assert.match(undatedScan.claims[0].blockers.join("\n"), /无法识别服务日期/);

const manuallyCorrectedScans = await buildClaimPlan(
  [
    {
      name: "scan-a.pdf",
      size: 400_000,
      sha256: "manual-medical",
      text: "",
      overrideKind: "claim-form",
      overrideServiceDate: "2026-05-14",
      overrideEarliestTreatmentDate: "2026-05-05",
    },
    {
      name: "scan-b.pdf",
      size: 300_000,
      sha256: "manual-invoice",
      text: "",
      overrideKind: "invoice",
      overrideServiceDate: "2026-05-14",
    },
  ],
  { settings: baseSettings },
);
assert.equal(manuallyCorrectedScans.claims.length, 1);
assert.equal(manuallyCorrectedScans.claims[0].serviceDate, "2026-05-14");
assert.equal(manuallyCorrectedScans.claims[0].claimDate, "2026-05-05");
assert.equal(manuallyCorrectedScans.claims[0].claimDateSource, "manual-override");
assert.equal(/无法识别服务日期|缺少医疗|只有发票/.test(manuallyCorrectedScans.claims[0].blockers.join("\n")), false);
assert.equal(manuallyCorrectedScans.claims[0].files[0].overrideKind || manuallyCorrectedScans.claims[0].files[1].overrideKind, "claim-form");

const datedFolderScans = await buildClaimPlan(
  [
    {
      name: "scan_1.pdf",
      path: "2026-05-14/scan_1.pdf",
      size: 400_000,
      sha256: "folder-scan-medical",
      text: "",
    },
    {
      name: "scan_2.pdf",
      path: "2026-05-14/scan_2.pdf",
      size: 300_000,
      sha256: "folder-scan-invoice",
      text: "",
    },
  ],
  { settings: baseSettings },
);
assert.equal(datedFolderScans.claims.length, 1);
assert.equal(datedFolderScans.claims[0].serviceDate, "2026-05-14");
assert.equal(datedFolderScans.claims[0].claimDate, "2026-05-05");
assert.equal(datedFolderScans.claims[0].status, "review");
assert.deepEqual(datedFolderScans.claims[0].files.map((file) => file.kind).sort(), ["claim-form", "invoice"]);
assert.equal(datedFolderScans.claims[0].warnings.some((warning) => warning.includes("无法识别文件类型")), false);
assert.equal(datedFolderScans.claims[0].warnings.some((warning) => warning.includes("部分文件识别置信度低")), false);

const repeatedScanNamesAcrossDates = await buildClaimPlan(
  [
    {
      name: "scan_1.pdf",
      path: "2026-05-14/scan_1.pdf",
      size: 400_000,
      sha256: "folder-0514-medical",
      text: "",
    },
    {
      name: "scan_2.pdf",
      path: "2026-05-14/scan_2.pdf",
      size: 300_000,
      sha256: "folder-0514-invoice",
      text: "",
    },
    {
      name: "scan_1.pdf",
      path: "2026-05-15/scan_1.pdf",
      size: 410_000,
      sha256: "folder-0515-medical",
      text: "",
    },
    {
      name: "scan_2.pdf",
      path: "2026-05-15/scan_2.pdf",
      size: 310_000,
      sha256: "folder-0515-invoice",
      text: "",
    },
  ],
  { settings: baseSettings },
);
assert.deepEqual(repeatedScanNamesAcrossDates.claims.map((claim) => claim.serviceDate), ["2026-05-14", "2026-05-15"]);
assert.equal(repeatedScanNamesAcrossDates.duplicateFiles.length, 0);
assert.deepEqual(repeatedScanNamesAcrossDates.claims.flatMap((claim) => claim.fileNames).sort(), [
  "2026-05-14/scan_1.pdf",
  "2026-05-14/scan_2.pdf",
  "2026-05-15/scan_1.pdf",
  "2026-05-15/scan_2.pdf",
]);

const compressedVariant = await buildClaimPlan(
  [
    {
      name: "CIGNA 25.06.2026-compressed.pdf",
      size: 800_000,
      sha256: "compressed-medical",
      originalSha256: "original-medical",
      text: "Cigna claim form. Treatment Date 25/06/2026. Diagnosis lower back pain.",
    },
  ],
  { settings: baseSettings },
);
assert.equal(compressedVariant.claims[0].files[0].originalSha256, "original-medical");

const compression = planCompression({
  totalBytes: 7_200_000,
  files: [{ id: "f1", name: "big.pdf", path: "/tmp/big.pdf", size: 7_200_000 }],
});
assert.equal(compression.items.length, 1);
assert.equal(compression.items[0].reason, "file-limit");

console.log("claim intake tests passed");
