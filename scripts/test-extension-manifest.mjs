#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const extensionDir = join(root, "extension");
const manifest = JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8"));

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.action.default_popup, "popup.html");
assert.equal(manifest.side_panel.default_path, "assistant.html");
assert.equal(manifest.permissions.includes("sidePanel"), true);
assert.equal(manifest.permissions.includes("storage"), true);
assert.equal(manifest.host_permissions.includes("https://customer.cignaenvoy.com/*"), true);
assert.deepEqual(Object.keys(manifest.icons || {}).sort(), ["128", "16", "32", "48"]);
assert.deepEqual(Object.keys(manifest.action.default_icon || {}).sort(), ["128", "16", "32", "48"]);

await assertFile(manifest.action.default_popup);
await assertFile(manifest.side_panel.default_path);
await assertFile(manifest.background.service_worker);
for (const file of Object.values(manifest.icons || {})) await assertFile(file);
for (const file of Object.values(manifest.action.default_icon || {})) await assertFile(file);
for (const script of manifest.content_scripts || []) {
  for (const file of script.js || []) await assertFile(file);
}
for (const entry of manifest.web_accessible_resources || []) {
  for (const file of entry.resources || []) await assertFile(file);
}

console.log("extension manifest test passed");

async function assertFile(path) {
  const info = await stat(join(extensionDir, path)).catch(() => null);
  assert.equal(Boolean(info?.isFile()), true, `missing extension file: ${path}`);
}
