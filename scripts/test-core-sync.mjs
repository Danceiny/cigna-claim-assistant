#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const syncedFiles = [
  ["src/core/claimIntake.mjs", "extension/core/claimIntake.mjs"],
];

for (const [sourcePath, extensionPath] of syncedFiles) {
  const source = await readFile(join(root, sourcePath), "utf8");
  const extension = await readFile(join(root, extensionPath), "utf8");
  assert.equal(extension, source, `${extensionPath} must stay byte-for-byte in sync with ${sourcePath}`);
}

console.log("core sync test passed");
