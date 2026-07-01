#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const releaseZip = join(root, "dist", "cigna-claim-assistant-release.zip");
const releasePrefix = "cigna-claim-assistant-release/";

const info = await stat(releaseZip).catch(() => null);
assert.equal(Boolean(info?.isFile()), true, "release zip is missing");
assert.equal(info.size > 1_000_000, true, "release zip is unexpectedly small");

const listing = await unzip(["-Z1", releaseZip]);
const files = new Set(listing.split(/\r?\n/).filter(Boolean));

for (const file of [
  "extension/manifest.json",
  "extension/popup.html",
  "extension/assistant.html",
  "extension/popup.js",
  "extension/background.js",
  "extension/content/cignaSubmitter.js",
  "extension/core/claimIntake.mjs",
  "utools/plugin.json",
  "utools/index.html",
  "utools/preload.js",
  "utools/renderer.js",
  "utools/logo.png",
  "extension/icons/icon-16.png",
  "extension/icons/icon-32.png",
  "extension/icons/icon-48.png",
  "extension/icons/icon-128.png",
  "extension/vendor/pdf.min.mjs",
  "extension/vendor/pdf.worker.min.mjs",
  "extension/vendor/pdf-lib.min.js",
  "package.json",
  "scripts/generate-ocr-sidecars.mjs",
  "scripts/scan-claims.mjs",
  "scripts/test-core-sync.mjs",
  "scripts/test-helper-package.mjs",
  "src/core/claimIntake.mjs",
  "src/core/pdfCompress.mjs",
  "cigna-claim-assistant-extension.zip",
  "cigna-claim-assistant-utools.upx",
  "START.html",
  "OPEN_INSTALLER.command",
  "release-manifest.json",
  "README.md",
  "INSTALL.zh-CN.md",
  "VERIFICATION.md",
]) {
  assert.equal(files.has(`${releasePrefix}${file}`), true, `release missing ${file}`);
}

const manifest = JSON.parse(await unzip(["-p", releaseZip, `${releasePrefix}extension/manifest.json`]));
const releaseManifest = JSON.parse(await unzip(["-p", releaseZip, `${releasePrefix}release-manifest.json`]));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.action.default_popup, "popup.html");
assert.equal(manifest.side_panel.default_path, "assistant.html");
assert.deepEqual(Object.keys(manifest.icons || {}).sort(), ["128", "16", "32", "48"]);
assert.deepEqual(Object.keys(manifest.action.default_icon || {}).sort(), ["128", "16", "32", "48"]);
assert.equal(manifest.permissions.includes("sidePanel"), true);
assert.equal(manifest.host_permissions.includes("https://customer.cignaenvoy.com/*"), true);
assert.equal(releaseManifest.schema, "cigna-claim-assistant-release-v1");
assert.equal(releaseManifest.extension.version, manifest.version);
assert.equal(releaseManifest.limits.realCignaEndToEndVerified, false);
assert.equal(releaseManifest.capabilities.includes("ocr-sidecar"), true);
assert.equal(releaseManifest.capabilities.includes("utools-plugin"), true);
assert.equal(releaseManifest.capabilities.includes("desktop-scan-companion"), true);
assert.equal(releaseManifest.capabilities.includes("ocr-sidecar-generator"), true);
assert.equal(releaseManifest.capabilities.includes("auto-submit-on-file-select"), true);
assert.equal(releaseManifest.capabilities.includes("pdf-compression"), true);
assert.equal(releaseManifest.capabilities.includes("submission-audit-snapshot"), true);
assert.equal(releaseManifest.capabilities.includes("cigna-page-diagnostics-export"), true);
assert.equal(releaseManifest.capabilities.includes("date-picker-click-selection"), true);
assert.equal(releaseManifest.capabilities.includes("macos-install-helper"), true);
assert.equal(releaseManifest.capabilities.includes("local-helper-package"), true);
assert.equal(releaseManifest.files["extension/popup.js"].sha256, sha256(await unzipRaw(["-p", releaseZip, `${releasePrefix}extension/popup.js`])));
assert.equal(releaseManifest.files["cigna-claim-assistant-utools.upx"].sha256, sha256(await unzipRaw(["-p", releaseZip, `${releasePrefix}cigna-claim-assistant-utools.upx`])));

const helperPackage = JSON.parse(await unzip(["-p", releaseZip, `${releasePrefix}package.json`]));
const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
assert.equal(helperPackage.scripts["claims:scan"], "node scripts/scan-claims.mjs");
assert.equal(helperPackage.scripts["claims:ocr-sidecars"], "node scripts/generate-ocr-sidecars.mjs");
assert.equal(helperPackage.scripts["claims:test:core-sync"], "node scripts/test-core-sync.mjs");
assert.equal(helperPackage.scripts["claims:test:helper"], "node scripts/test-helper-package.mjs");
assert.equal(Boolean(helperPackage.dependencies["pdfjs-dist"]), true);
assert.equal(Boolean(helperPackage.dependencies.playwright), true);
assert.equal(rootPackage.scripts["utools:test:renderer"], "node scripts/test-utools-renderer.mjs");
assert.equal(rootPackage.scripts["extension:test:zip:load"], "node scripts/test-extension-zip-load.mjs");
assert.equal(rootPackage.scripts["verify:release"], "node scripts/verify-release.mjs");
assert.equal(rootPackage.scripts["extension:test:release-user-smoke"], "node scripts/test-release-user-smoke.mjs");

const popupHtml = await unzip(["-p", releaseZip, `${releasePrefix}extension/popup.html`]);
const assistantHtml = await unzip(["-p", releaseZip, `${releasePrefix}extension/assistant.html`]);
const utoolsHtml = await unzip(["-p", releaseZip, `${releasePrefix}utools/index.html`]);
const utoolsPlugin = JSON.parse(await unzip(["-p", releaseZip, `${releasePrefix}utools/plugin.json`]));
const utoolsPreload = await unzip(["-p", releaseZip, `${releasePrefix}utools/preload.js`]);
const utoolsRenderer = await unzip(["-p", releaseZip, `${releasePrefix}utools/renderer.js`]);
assert.equal(utoolsPlugin.pluginName, "Cigna Claim Assistant");
assert.equal(utoolsPlugin.main, "index.html");
assert.equal(utoolsPlugin.preload, "preload.js");
assert.match(utoolsPreload, /scanDirectory/);
assert.match(utoolsPreload, /exportChromeBackup/);
assert.match(utoolsPreload, /scan-claims\.mjs/);
assert.match(utoolsPreload, /new-submitclaim/);
assert.match(utoolsPreload, /ocrEnabled/);
assert.match(utoolsPreload, /compressEnabled/);
assert.match(utoolsPreload, /--compress/);
assert.match(utoolsPreload, /--ocr-command/);
assert.match(utoolsPreload, /autoSubmitOnSelect:\s*true/);
assert.match(utoolsHtml, /id="ocrEnabled"/);
assert.match(utoolsHtml, /id="compressEnabled"/);
assert.match(utoolsHtml, /id="ocrCommand"/);
assert.match(utoolsHtml, /id="settingsStatus"/);
assert.match(utoolsRenderer, /renderSettingsStatus/);
assert.match(utoolsRenderer, /missingRequiredSettings/);
assert.match(utoolsRenderer, /请先填写必填设置/);
assert.match(popupHtml, /id="preflightSubmit"/);
assert.match(assistantHtml, /id="preflightSubmit"/);
assert.match(popupHtml, /id="autoSubmitOnSelect"/);
assert.match(assistantHtml, /id="autoSubmitOnSelect"/);
assert.match(popupHtml, /id="settingsStatus"/);
assert.match(assistantHtml, /id="settingsStatus"/);
assert.match(popupHtml, /id="ledgerStatus"/);
assert.match(assistantHtml, /id="ledgerStatus"/);
assert.match(popupHtml, /id="exportCignaDiagnostics"/);
assert.match(assistantHtml, /id="exportCignaDiagnostics"/);
assert.match(popupHtml, /\.txt,text\/plain/);
assert.match(assistantHtml, /\.txt,text\/plain/);
assert.doesNotMatch(popupHtml, /TEST BENEFICIARY/);
assert.doesNotMatch(assistantHtml, /TEST BENEFICIARY/);
assert.doesNotMatch(utoolsHtml, /value="BACK_PAIN"/);
for (const personalDefault of [/value="BACK_PAIN"/, /value="BANK 0001"/, /value="2026-05-05"/, /value="2026-05-08"/]) {
  assert.doesNotMatch(popupHtml, personalDefault);
  assert.doesNotMatch(assistantHtml, personalDefault);
}
assert.doesNotMatch(utoolsPreload, /diagnosis:\s*settings\.diagnosis\s*\|\|\s*"BACK_PAIN"/);
assert.doesNotMatch(utoolsPreload, /--diagnosis",\s*options\.diagnosis\s*\|\|\s*"BACK_PAIN"/);

const popupJs = await unzip(["-p", releaseZip, `${releasePrefix}extension/popup.js`]);
assert.match(popupJs, /buildOcrSidecarMap/);
assert.match(popupJs, /findOcrSidecarForFile/);
assert.match(popupJs, /sidecarFiles/);
assert.match(popupJs, /runSubmitPreflight/);
assert.match(popupJs, /compressPdfFile/);
assert.match(popupJs, /compressionAttemptSummary/);
assert.match(popupJs, /compressionAttemptLabel/);
assert.match(popupJs, /autoSubmitOnSelect/);
assert.match(popupJs, /autoSubmitOnSelect:\s*true/);
assert.match(popupJs, /renderSettingsStatus/);
assert.match(popupJs, /missingRequiredSettings/);
assert.match(popupJs, /renderLedgerStatus/);
assert.match(popupJs, /refreshLedgerStatus/);
assert.match(popupJs, /自动提交未启动/);
assert.match(popupJs, /assertRequiredSettings\(\{ forSubmission: true \}\);\s*setActionButtonsDisabled\(true\)/);
assert.match(popupJs, /claimDateSourceLabel/);
assert.match(popupJs, /claimDateSource/);
assert.match(popupJs, /uploadOrder/);
assert.match(popupJs, /submissionFingerprint/);
assert.match(popupJs, /buildSubmissionAudit/);
assert.match(popupJs, /cigna-submission-audit-v1/);
assert.match(popupJs, /lastSubmissionAudit/);
assert.match(popupJs, /cigna-page-diagnostics-v1/);
assert.match(popupJs, /exportCignaDiagnostics/);
assert.match(popupJs, /lastCignaDiagnostics/);
assert.match(popupJs, /lastSubmissionAudit/);
assert.match(popupJs, /normalizeObjectSnapshot/);
assert.match(popupJs, /shaLike/);
assert.match(popupJs, /CIGNA_START_SUBMISSION/);
assert.doesNotMatch(popupJs, /thumbnailDataUrl"\s*:/);
assert.doesNotMatch(popupJs, /TEST BENEFICIARY/);
assert.doesNotMatch(popupJs, /\["ongoingConditionEarliestDate",\s*"长期病症最早治疗日期"\]/);

const submitter = await unzip(["-p", releaseZip, `${releasePrefix}extension/content/cignaSubmitter.js`]);
const background = await unzip(["-p", releaseZip, `${releasePrefix}extension/background.js`]);
assert.match(submitter, /CIGNA_SUBMIT_CLAIMS/);
assert.match(submitter, /pickDate/);
assert.match(submitter, /waitForSubmissionResult/);
assert.match(submitter, /waitForUploadComplete/);
assert.match(submitter, /submissionIdMissing/);
assert.match(submitter, /visiblePageText/);
assert.match(submitter, /orderedFiles/);
assert.match(submitter, /clickDateInCurrentCalendar/);
assert.match(submitter, /findDateNavButton/);
assert.match(submitter, /upload/);
assert.match(submitter, /paymentLabel/);
assert.doesNotMatch(submitter, /TEST BENEFICIARY/);
assert.doesNotMatch(background, /TEST BENEFICIARY/);
assert.match(background, /claimDateSource/);
assert.match(background, /submissionIdMissing/);
assert.match(background, /submissionFingerprint/);
assert.match(background, /prepareClaimTab/);
assert.match(background, /shouldResetClaimPage/);

const claimIntake = await unzip(["-p", releaseZip, `${releasePrefix}extension/core/claimIntake.mjs`]);
const coreSync = await unzip(["-p", releaseZip, `${releasePrefix}scripts/test-core-sync.mjs`]);
const helperSelfTest = await unzip(["-p", releaseZip, `${releasePrefix}scripts/test-helper-package.mjs`]);
assert.match(coreSync, /extension\/core\/claimIntake\.mjs/);
assert.match(coreSync, /byte-for-byte in sync/);
assert.match(helperSelfTest, /claims:test:core-sync/);
assert.match(helperSelfTest, /claims:scan/);
assert.match(claimIntake, /submitInvoiceOnly:\s*false/);
assert.match(claimIntake, /只有发票\/收据/);
assert.match(claimIntake, /缺少发票\/收据/);
assert.match(claimIntake, /serviceDates/);
assert.match(claimIntake, /compression/);
assert.match(claimIntake, /ocr: record\.ocr/);
assert.match(claimIntake, /earliestTreatmentDateSource/);
assert.match(claimIntake, /claimDateSource/);
assert.match(claimIntake, /claimDateSourcePriority/);
assert.match(claimIntake, /earliestTreatmentDateSource !== "global-fallback"/);
assert.match(claimIntake, /withUploadOrder/);
assert.doesNotMatch(claimIntake, /settings\.ongoingConditionEarliestDate\s*\|\|\s*serviceDate/);
assert.doesNotMatch(claimIntake, /diagnosis:\s*"BACK_PAIN"/);
assert.doesNotMatch(claimIntake, /paymentLabel:\s*"BANK 0001"/);
assert.doesNotMatch(claimIntake, /ongoingConditionEarliestDate:\s*"2026-05-05"/);
assert.doesNotMatch(claimIntake, /minServiceDate:\s*"2026-05-08"/);

const sidecarGenerator = await unzip(["-p", releaseZip, `${releasePrefix}scripts/generate-ocr-sidecars.mjs`]);
assert.match(sidecarGenerator, /generateSidecar/);
assert.match(sidecarGenerator, /ocr-command/);
assert.match(sidecarGenerator, /sidecarStyle\s*=\s*args\["sidecar-style"\]\s*\|\|\s*"pdf\.txt"/);
assert.match(sidecarGenerator, /return `\$\{path\}\.txt`/);

const scanClaims = await unzip(["-p", releaseZip, `${releasePrefix}scripts/scan-claims.mjs`]);
assert.match(scanClaims, /buildClaimPlan/);
assert.match(scanClaims, /compressClaimFiles/);
assert.match(scanClaims, /mkdir\(dirname\(outputPath\)/);

const readme = await unzip(["-p", releaseZip, `${releasePrefix}README.md`]);
const start = await unzip(["-p", releaseZip, `${releasePrefix}START.html`]);
const installer = await unzip(["-p", releaseZip, `${releasePrefix}OPEN_INSTALLER.command`]);
const install = await unzip(["-p", releaseZip, `${releasePrefix}INSTALL.zh-CN.md`]);
const verification = await unzip(["-p", releaseZip, `${releasePrefix}VERIFICATION.md`]);
assert.match(readme, /不会作为附件上传/);
assert.match(readme, /claims:ocr-sidecars/);
assert.match(readme, /真实 Cigna/);
assert.match(readme, /总交付包/);
assert.match(readme, /不是第三种产品形态/);
assert.match(readme, /服务日期没有被当作最早治疗日期|不会拿服务日期冒充最早治疗日期/);
assert.match(start, /Load unpacked/);
assert.match(start, /提交预检/);
assert.match(start, /extension\/icons\/icon-128\.png/);
assert.match(installer, /chrome:\/\/extensions/);
assert.match(installer, /pbcopy/);
assert.match(installer, /cigna-claim-assistant-utools\.upx/);
assert.match(installer, /OPEN_INSTALLER|extension\/manifest\.json|Load unpacked/);
assert.match(install, /不要用临时 Chrome profile/);
assert.match(install, /单个 PDF 超过 6 MB/);
assert.match(install, /scale\/quality/);
assert.match(install, /不会拿服务日期冒充最早治疗日期/);
assert.match(install, /导出 Chrome 设置/);
assert.match(install, /Chrome 自动提交设置未就绪/);
assert.match(install, /cigna-claim-assistant-chrome-settings-backup\.json/);
assert.match(verification, /未在真实登录态 Cigna Envoy/);

const tmp = await mkdtemp(join(tmpdir(), "cigna-release-test-"));
try {
  const nestedZip = join(tmp, "cigna-claim-assistant-extension.zip");
  const nestedUtools = join(tmp, "cigna-claim-assistant-utools.upx");
  const nestedZipBytes = await unzipRaw(["-p", releaseZip, `${releasePrefix}cigna-claim-assistant-extension.zip`]);
  assert.equal(releaseManifest.extension.zip.sha256, sha256(nestedZipBytes));
  await writeFile(nestedZip, nestedZipBytes);
  const nestedListing = await unzip(["-Z1", nestedZip]);
  assert.match(nestedListing, /manifest\.json/);
  assert.match(nestedListing, /icons\/icon-128\.png/);
  assert.match(nestedListing, /popup\.js/);
  assert.match(nestedListing, /content\/cignaSubmitter\.js/);
  await writeFile(nestedUtools, await unzipRaw(["-p", releaseZip, `${releasePrefix}cigna-claim-assistant-utools.upx`]));
  const utoolsListing = await unzip(["-Z1", nestedUtools]);
  assert.match(utoolsListing, /plugin\.json/);
  assert.match(utoolsListing, /scripts\/scan-claims\.mjs/);
  assert.match(utoolsListing, /node_modules\/pdfjs-dist\/package\.json/);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

console.log("release package test passed");

function unzip(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("unzip", args, { stdio: ["ignore", "pipe", "pipe"] });
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
      else reject(new Error(`unzip ${args.join(" ")} exited ${code}\n${stderr}`));
    });
    child.on("error", reject);
  });
}

function unzipRaw(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("unzip", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`unzip ${args.join(" ")} exited ${code}\n${stderr}`));
    });
    child.on("error", reject);
  });
}
