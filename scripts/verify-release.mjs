#!/usr/bin/env node
import { spawn } from "node:child_process";

if (process.env.CI !== "true" && process.env.ALLOW_LOCAL_BROWSER_VERIFY !== "1") {
  console.error([
    "[verify:release] Refusing to run full browser verification on this local machine.",
    "[verify:release] This command may launch Playwright/Chromium and disturb the user's active Chrome session.",
    "[verify:release] Use `npm run verify:static` for local no-browser checks.",
    "[verify:release] To intentionally run the full suite locally, use `ALLOW_LOCAL_BROWSER_VERIFY=1 npm run verify:release`.",
  ].join("\n"));
  process.exit(2);
}

const commands = [
  ["claims:test", "PDF识别、分组、防重、治疗日期规则"],
  ["claims:test:core-sync", "CLI 和 Chrome 扩展核心逻辑同步"],
  ["claims:test:helper", "release helper 自检"],
  ["claims:test:scan", "本地扫描 CLI 和 OCR sidecar"],
  ["claims:test:compress", "PDF 压缩策略"],
  ["claims:test:e2e", "mock Cigna 提交流程"],
  ["extension:test:background", "Chrome background 提交流程"],
  ["extension:test:popup", "Chrome popup/assistant 交互"],
  ["extension:test:manifest", "MV3 manifest 和资源声明"],
  ["extension:release", "生成 Chrome/uTools/release 发布包"],
  ["extension:test:zip:load", "打包后的 Chrome 扩展可加载"],
  ["utools:test:package", "uTools .upx 包审计"],
  ["utools:test:renderer", "uTools 页面 smoke"],
  ["extension:test:release-helper", "release 解包 helper 可运行"],
  ["extension:test:release-user-smoke", "release 解压后用户侧入口冒烟验证"],
];

const startedAt = Date.now();

for (const [script, label] of commands) {
  console.log(`\n[verify:release] npm run ${script}`);
  console.log(`[verify:release] ${label}`);
  await runNpmScript(script);
}

const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`\n[verify:release] passed in ${elapsedSeconds}s`);

function runNpmScript(script) {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", script], {
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const suffix = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(new Error(`npm run ${script} failed with ${suffix}`));
    });
  });
}
