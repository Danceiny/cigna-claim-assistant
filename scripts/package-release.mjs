#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const distDir = join(root, "dist");
const stagingDir = join(distDir, "cigna-claim-assistant-release");
const releaseZip = join(distDir, "cigna-claim-assistant-release.zip");
const releaseZipTmp = join(distDir, "cigna-claim-assistant-release.zip.tmp");
const extensionZip = join(distDir, "cigna-claim-assistant.zip");
const utoolsPackage = join(distDir, "cigna-claim-assistant-utools.upx");

await run(process.execPath, ["scripts/package-extension.mjs"], { cwd: root });
await run(process.execPath, ["scripts/package-utools.mjs"], { cwd: root });

await rm(stagingDir, { recursive: true, force: true });
await mkdir(stagingDir, { recursive: true });

await cp(join(root, "extension"), join(stagingDir, "extension"), { recursive: true });
await cp(join(root, "utools"), join(stagingDir, "utools"), { recursive: true });
await cp(join(root, "README.md"), join(stagingDir, "README.md"));
await cp(join(root, "docs", "START.html"), join(stagingDir, "START.html"));
await cp(join(root, "docs", "OPEN_INSTALLER.command"), join(stagingDir, "OPEN_INSTALLER.command"));
await chmod(join(stagingDir, "OPEN_INSTALLER.command"), 0o755);
await cp(join(root, "docs", "INSTALL.zh-CN.md"), join(stagingDir, "INSTALL.zh-CN.md"));
await cp(join(root, "docs", "VERIFICATION.md"), join(stagingDir, "VERIFICATION.md"));
await mkdir(join(stagingDir, "scripts"), { recursive: true });
await cp(join(root, "scripts", "generate-ocr-sidecars.mjs"), join(stagingDir, "scripts", "generate-ocr-sidecars.mjs"));
await cp(join(root, "scripts", "scan-claims.mjs"), join(stagingDir, "scripts", "scan-claims.mjs"));
await cp(join(root, "scripts", "test-core-sync.mjs"), join(stagingDir, "scripts", "test-core-sync.mjs"));
await cp(join(root, "scripts", "test-helper-package.mjs"), join(stagingDir, "scripts", "test-helper-package.mjs"));
await mkdir(join(stagingDir, "src", "core"), { recursive: true });
await cp(join(root, "src", "core", "claimIntake.mjs"), join(stagingDir, "src", "core", "claimIntake.mjs"));
await cp(join(root, "src", "core", "pdfCompress.mjs"), join(stagingDir, "src", "core", "pdfCompress.mjs"));
await writeHelperPackageJson();
await cp(extensionZip, join(stagingDir, "cigna-claim-assistant-extension.zip"));
await cp(utoolsPackage, join(stagingDir, "cigna-claim-assistant-utools.upx"));

await assertFile(join(stagingDir, "extension", "manifest.json"));
await assertFile(join(stagingDir, "START.html"));
await assertFile(join(stagingDir, "OPEN_INSTALLER.command"));
await assertFile(join(stagingDir, "INSTALL.zh-CN.md"));
await assertFile(join(stagingDir, "VERIFICATION.md"));
await assertFile(join(stagingDir, "scripts", "generate-ocr-sidecars.mjs"));
await assertFile(join(stagingDir, "scripts", "scan-claims.mjs"));
await assertFile(join(stagingDir, "scripts", "test-core-sync.mjs"));
await assertFile(join(stagingDir, "scripts", "test-helper-package.mjs"));
await assertFile(join(stagingDir, "src", "core", "claimIntake.mjs"));
await assertFile(join(stagingDir, "src", "core", "pdfCompress.mjs"));
await assertFile(join(stagingDir, "package.json"));
await assertFile(join(stagingDir, "cigna-claim-assistant-extension.zip"));
await assertFile(join(stagingDir, "cigna-claim-assistant-utools.upx"));

await writeReleaseManifest();

await rm(releaseZipTmp, { force: true });
await run("zip", ["-qr", releaseZipTmp, "cigna-claim-assistant-release"], { cwd: distDir });
await rename(releaseZipTmp, releaseZip);
await run(process.execPath, ["scripts/test-release-package.mjs"], { cwd: root });
console.log(`Wrote ${releaseZip}`);

async function assertFile(path) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new Error(`Missing release file: ${path}`);
}

async function writeReleaseManifest() {
  const extensionManifest = JSON.parse(await readFile(join(stagingDir, "extension", "manifest.json"), "utf8"));
  const extensionZipPath = join(stagingDir, "cigna-claim-assistant-extension.zip");
  const checkedFiles = [
    "START.html",
    "OPEN_INSTALLER.command",
    "INSTALL.zh-CN.md",
    "VERIFICATION.md",
    "README.md",
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
    "package.json",
    "scripts/generate-ocr-sidecars.mjs",
    "scripts/scan-claims.mjs",
    "scripts/test-core-sync.mjs",
    "scripts/test-helper-package.mjs",
    "src/core/claimIntake.mjs",
    "src/core/pdfCompress.mjs",
    "cigna-claim-assistant-extension.zip",
    "cigna-claim-assistant-utools.upx",
  ];
  const fileEntries = {};
  for (const file of checkedFiles) {
    const path = join(stagingDir, file);
    const info = await stat(path);
    fileEntries[file] = {
      bytes: info.size,
      sha256: await sha256File(path),
    };
  }
  const manifest = {
    schema: "cigna-claim-assistant-release-v1",
    builtAt: new Date().toISOString(),
    packageName: "cigna-claim-assistant-release",
    extension: {
      name: extensionManifest.name,
      version: extensionManifest.version,
      manifestVersion: extensionManifest.manifest_version,
      hostPermissions: extensionManifest.host_permissions || [],
      permissions: extensionManifest.permissions || [],
      zip: {
        path: relative(stagingDir, extensionZipPath),
        bytes: fileEntries["cigna-claim-assistant-extension.zip"].bytes,
        sha256: fileEntries["cigna-claim-assistant-extension.zip"].sha256,
      },
    },
    capabilities: [
      "chrome-extension",
      "utools-plugin",
      "side-panel",
      "assistant-page",
      "folder-drag-drop",
      "auto-submit-on-file-select",
      "pdf-text-extraction",
      "ocr-sidecar",
      "ocr-sidecar-generator",
      "one-claim-per-service-date",
      "invoice-and-medical-file-required",
      "duplicate-ledger",
      "pdf-compression",
      "submit-preflight",
      "submission-audit-snapshot",
      "cigna-page-precheck",
      "cigna-page-diagnostics-export",
      "date-picker-click-selection",
      "background-submission",
      "settings-backup",
      "macos-install-helper",
      "local-helper-package",
      "desktop-scan-companion",
    ],
    limits: {
      maxPdfBytes: 6 * 1024 * 1024,
      maxClaimBytes: 30 * 1024 * 1024,
      requiresLoggedInUserChrome: true,
      realCignaEndToEndVerified: false,
    },
    files: fileEntries,
  };
  await writeFile(join(stagingDir, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function writeHelperPackageJson() {
  const packageJson = {
    type: "module",
    private: true,
    scripts: {
      "claims:scan": "node scripts/scan-claims.mjs",
      "claims:ocr-sidecars": "node scripts/generate-ocr-sidecars.mjs",
      "claims:test:core-sync": "node scripts/test-core-sync.mjs",
      "claims:test:helper": "node scripts/test-helper-package.mjs",
    },
    dependencies: {
      "pdf-lib": "^1.17.1",
      "pdfjs-dist": "^4.10.38",
      "playwright": "^1.55.1",
    },
  };
  await writeFile(join(stagingDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
      }
    });
    child.on("error", reject);
  });
}
