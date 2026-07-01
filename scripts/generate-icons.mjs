#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";

const root = process.cwd();
const outDir = join(root, "extension", "icons");
await mkdir(outDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  drawIcon(ctx, size);
  await writeFile(join(outDir, `icon-${size}.png`), canvas.toBuffer("image/png"));
}

console.log("generated extension icons");

function drawIcon(ctx, size) {
  const scale = size / 128;
  ctx.clearRect(0, 0, size, size);

  roundRect(ctx, 8 * scale, 8 * scale, 112 * scale, 112 * scale, 24 * scale);
  const gradient = ctx.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, "#0f766e");
  gradient.addColorStop(1, "#155e75");
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.fillStyle = "#ecfeff";
  roundRect(ctx, 34 * scale, 24 * scale, 60 * scale, 80 * scale, 8 * scale);
  ctx.fill();

  ctx.fillStyle = "#99f6e4";
  roundRect(ctx, 46 * scale, 38 * scale, 36 * scale, 5 * scale, 3 * scale);
  ctx.fill();
  roundRect(ctx, 46 * scale, 52 * scale, 36 * scale, 5 * scale, 3 * scale);
  ctx.fill();
  roundRect(ctx, 46 * scale, 66 * scale, 24 * scale, 5 * scale, 3 * scale);
  ctx.fill();

  ctx.strokeStyle = "#0f766e";
  ctx.lineWidth = Math.max(2, 6 * scale);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(44 * scale, 88 * scale);
  ctx.lineTo(58 * scale, 100 * scale);
  ctx.lineTo(86 * scale, 72 * scale);
  ctx.stroke();
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
