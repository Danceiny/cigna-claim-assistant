import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const FILTERS = [
  "/System/Library/Filters/Reduce File Size.qfilter",
  "/System/Library/Filters/Compress PDF.qfilter",
];

export async function compressPdf(inputPath, options = {}) {
  const targetBytes = options.targetBytes || 5.7 * 1024 * 1024;
  const outputPath = options.outputPath || defaultCompressedPath(inputPath);
  await mkdir(dirname(outputPath), { recursive: true });

  const before = await fileSize(inputPath);
  if (before <= targetBytes && !options.force) {
    return {
      inputPath,
      outputPath: inputPath,
      beforeBytes: before,
      afterBytes: before,
      skipped: true,
      withinTarget: true,
      method: "none",
    };
  }

  const attempts = [];
  let best = null;
  if (!options.preferBrowser) {
    for (const filter of FILTERS) {
      const result = await quartzCompress(inputPath, outputPath, filter);
      attempts.push(result);
      if (result.ok) {
        const after = await fileSize(outputPath);
        const compressedBytes = await readFile(outputPath);
        best = pickBetterCompression(best, {
          inputPath,
          outputPath,
          beforeBytes: before,
          afterBytes: after,
          compressedBytes,
          skipped: false,
          withinTarget: after <= targetBytes,
          method: `quartz:${basename(filter)}`,
          attempts: [...attempts],
        });
        if (best?.withinTarget) return best;
      }
    }
  }

  for (const attempt of compressionAttempts(options)) {
    const result = await browserRasterCompress(inputPath, outputPath, attempt);
    attempts.push(result);
    if (result.ok) {
      const after = await fileSize(outputPath);
      const compressedBytes = await readFile(outputPath);
      best = pickBetterCompression(best, {
        inputPath,
        outputPath,
        beforeBytes: before,
        afterBytes: after,
        compressedBytes,
        skipped: false,
        withinTarget: after <= targetBytes,
        method: `browser-raster:scale-${attempt.scale}:quality-${attempt.quality}`,
        attempts: [...attempts],
      });
      if (best?.withinTarget) return best;
    }
  }

  if (best) {
    await writeFile(outputPath, best.compressedBytes);
    const { compressedBytes, ...result } = best;
    return result;
  }

  return {
    inputPath,
    outputPath: "",
    beforeBytes: before,
    afterBytes: before,
    skipped: false,
    withinTarget: false,
    method: "",
    attempts,
    error: "No available PDF compression method reduced the file.",
  };
}

export function compressionAttempts(options = {}) {
  if (Array.isArray(options.browserAttempts)) return options.browserAttempts;
  const scales = options.browserScales || (options.browserScale ? [options.browserScale] : [1.0, 0.85, 0.7]);
  const qualities = options.browserQualities || [0.58, 0.46, 0.34];
  return scales.flatMap((scale) => qualities.map((quality) => ({ scale, quality })));
}

function pickBetterCompression(current, candidate) {
  if (candidate.afterBytes >= candidate.beforeBytes) return current;
  if (!current) return candidate;
  return candidate.afterBytes < current.afterBytes ? candidate : current;
}

export async function compressClaimFiles(claim, options = {}) {
  const replacements = new Map();
  const results = [];
  for (const item of claim.compression?.items || []) {
    if (!item.path) {
      results.push({ ...item, error: "Missing local path." });
      continue;
    }
    const result = await compressPdf(item.path, {
      targetBytes: item.targetBytes,
      outputPath: options.outputPathFor?.(item) || defaultCompressedPath(item.path, options.outputDir),
      preferBrowser: options.preferBrowser ?? true,
    });
    results.push({ ...item, ...result });
    if (result.outputPath && result.afterBytes < item.size) {
      replacements.set(item.fileId, result.outputPath);
    }
  }
  return {
    results,
    replacements,
    ok: results.every((result) => result.skipped || result.outputPath),
  };
}

function defaultCompressedPath(inputPath, outputDir = join(process.cwd(), "outputs", "compressed")) {
  const ext = extname(inputPath) || ".pdf";
  const base = basename(inputPath, ext);
  return join(outputDir, `${base}-compressed${ext}`);
}

async function quartzCompress(inputPath, outputPath, filterPath) {
  const script = [
    `set inputFile to POSIX file "${escapeAppleScript(inputPath)}"`,
    `set outputFile to POSIX file "${escapeAppleScript(outputPath)}"`,
    `set quartzFilter to POSIX file "${escapeAppleScript(filterPath)}"`,
    `tell application "ColorSync Utility"`,
    `  launch`,
    `  open inputFile`,
    `  delay 0.5`,
    `  try`,
    `    save front document in outputFile with properties {quartz filter:quartzFilter}`,
    `  on error errMsg number errNo`,
    `    close front document saving no`,
    `    error errMsg number errNo`,
    `  end try`,
    `  close front document saving no`,
    `end tell`,
  ].join("\n");

  const result = await run("osascript", ["-e", script], { timeoutMs: 30000 });
  return { filterPath, ok: result.code === 0, ...result };
}

async function browserRasterCompress(inputPath, outputPath, options = {}) {
  let browser;
  let server;
  try {
    const [{ chromium }, inputBytes] = await Promise.all([
      import("playwright"),
      readFile(inputPath),
    ]);
    server = await createPdfJsServer();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(server.origin);
    await page.addScriptTag({ path: resolve("node_modules/pdf-lib/dist/pdf-lib.min.js") });
    await page.waitForFunction(() => window.pdfjsLib && window.PDFLib);
    const base64 = inputBytes.toString("base64");
    const outputBase64 = await page.evaluate(async ({ base64: pdfBase64, quality, scale }) => {
      const bytes = Uint8Array.from(atob(pdfBase64), (char) => char.charCodeAt(0));
      const source = await window.pdfjsLib.getDocument({ data: bytes }).promise;
      const output = await window.PDFLib.PDFDocument.create();

      for (let pageNumber = 1; pageNumber <= source.numPages; pageNumber += 1) {
        const sourcePage = await source.getPage(pageNumber);
        const baseViewport = sourcePage.getViewport({ scale: 1 });
        const renderViewport = sourcePage.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(renderViewport.width);
        canvas.height = Math.ceil(renderViewport.height);
        const context = canvas.getContext("2d", { alpha: false });
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        await sourcePage.render({ canvasContext: context, viewport: renderViewport }).promise;
        const image = await output.embedJpg(canvas.toDataURL("image/jpeg", quality));
        const newPage = output.addPage([baseViewport.width, baseViewport.height]);
        newPage.drawImage(image, {
          x: 0,
          y: 0,
          width: baseViewport.width,
          height: baseViewport.height,
        });
      }

      return output.saveAsBase64({ dataUri: false });
    }, {
      base64,
      quality: options.quality || 0.6,
      scale: options.scale || 1.35,
    });
    await writeFile(outputPath, Buffer.from(outputBase64, "base64"));
    return { ok: true, method: "browser-raster", quality: options.quality, scale: options.scale };
  } catch (error) {
    return { ok: false, method: "browser-raster", quality: options.quality, scale: options.scale, error: error.message };
  } finally {
    await browser?.close().catch(() => {});
    await server?.close();
  }
}

async function createPdfJsServer() {
  const files = new Map([
    ["/pdf.min.mjs", resolve("node_modules/pdfjs-dist/build/pdf.min.mjs")],
    ["/pdf.worker.min.mjs", resolve("node_modules/pdfjs-dist/build/pdf.worker.min.mjs")],
  ]);
  const server = createServer(async (request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`
        <!doctype html>
        <script type="module">
          import * as pdfjsLib from "/pdf.min.mjs";
          pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
          window.pdfjsLib = pdfjsLib;
        </script>
      `);
      return;
    }
    const path = files.get(request.url || "");
    if (!path) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    try {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(await readFile(path));
    } catch (error) {
      response.writeHead(500);
      response.end(error.message);
    }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ code: 124, stdout, stderr: `${stderr}\nTimed out after ${options.timeoutMs} ms`.trim() });
    }, options.timeoutMs || 30000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => finish({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.on("error", (error) => finish({ code: 127, stdout, stderr: error.message }));
  });
}

async function fileSize(path) {
  return (await stat(path)).size;
}

function escapeAppleScript(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
