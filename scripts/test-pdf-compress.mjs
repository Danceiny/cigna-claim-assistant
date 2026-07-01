#!/usr/bin/env node
import assert from "node:assert/strict";
import { compressionAttempts } from "../src/core/pdfCompress.mjs";

const defaults = compressionAttempts();
assert.equal(defaults.length, 9);
assert.deepEqual(defaults.slice(0, 3), [
  { scale: 1, quality: 0.58 },
  { scale: 1, quality: 0.46 },
  { scale: 1, quality: 0.34 },
]);
assert.deepEqual(defaults.slice(-3), [
  { scale: 0.7, quality: 0.58 },
  { scale: 0.7, quality: 0.46 },
  { scale: 0.7, quality: 0.34 },
]);

assert.deepEqual(compressionAttempts({ browserScale: 0.8, browserQualities: [0.5] }), [
  { scale: 0.8, quality: 0.5 },
]);
assert.deepEqual(compressionAttempts({ browserAttempts: [{ scale: 0.6, quality: 0.3 }] }), [
  { scale: 0.6, quality: 0.3 },
]);

console.log("pdf compression tests passed");
