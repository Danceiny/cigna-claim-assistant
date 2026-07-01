if (globalThis.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "CIGNA_SUBMITTER_PING") {
      sendResponse({ ok: true });
      return undefined;
    }
    if (message?.type === "CIGNA_PRECHECK_PAGE") {
      sendResponse({ ok: true, precheck: precheckPage(message.beneficiaryName) });
      return undefined;
    }
    if (message?.type !== "CIGNA_SUBMIT_CLAIMS") return undefined;
    submitClaims(message.claims, { batchId: message.batchId })
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });
}

async function submitClaims(claims, options = {}) {
  const results = [];
  for (let index = 0; index < claims.length; index += 1) {
    const claim = claims[index];
    await emitSubmissionProgress(options.batchId, {
      event: "claim-started",
      index,
      total: claims.length,
      claim: claimSummary(claim),
    });
    let result;
    try {
      result = await submitClaim(claim);
    } catch (error) {
      result = {
        id: claim.id,
        status: "failed",
        error: error.message,
      };
    }
    results.push(result);
    await emitSubmissionProgress(options.batchId, {
      event: result.status === "submitted" ? "claim-submitted" : "claim-failed",
      index,
      total: claims.length,
      claim: claimSummary(claim),
      result,
    });
  }
  return { results };
}

async function submitClaim(claim) {
  if (!claim.beneficiaryName?.trim()) throw new Error("缺少被保险人姓名。");
  window.__cignaClaimBeneficiaryName = claim.beneficiaryName.trim();
  await ensureSubmitClaimPage();
  await clickBeneficiary();
  await chooseCombobox("选择国家/地区*", claim.country || "阿拉伯联合酋长国");
  await clickButton("继续");
  await chooseCombobox("理赔类型*", claim.claimType || "医疗类");
  await clickButton("继续");
  await chooseCombobox("是门诊还是住院？*", claim.visitType || "门诊");
  await pickDate(claim.claimDate);
  await clickButton("继续");
  await fillTextbox("描述您的诊断 *", claim.diagnosis);
  await clickButton("继续");
  await clickButton("否");
  await uploadFiles(claim.files);
  await confirmUploadedFiles();
  if (claim.paymentLabel) await selectPaymentAccount(claim.paymentLabel);
  await clickButton("继续");
  await agreeAndSubmit();
  const submission = await waitForSubmissionResult();

  return {
    id: claim.id,
    status: "submitted",
    ...submission,
  };
}

async function ensureSubmitClaimPage() {
  if (!location.href.includes("/s/new-submitclaim")) {
    location.href = submitClaimUrl();
    await sleep(3000);
  }
  const successHeading = [...document.querySelectorAll("h1, h2")]
    .some((node) => node.textContent?.trim() === "理赔已提交");
  if (successHeading) {
    await clickButton("新理赔");
    await sleep(2500);
  }
}

function submitClaimUrl() {
  return `${location.origin}/s/new-submitclaim?LanguageCode=zh_CN&language=zh_CN`;
}

function precheckPage(beneficiaryName = "") {
  const expectedName = String(beneficiaryName || "").trim();
  const text = visiblePageText();
  const checks = [
    {
      name: "submit-page-url",
      ok: location.href.includes("/s/new-submitclaim"),
      detail: location.href,
    },
    {
      name: "new-claim-start",
      ok: text.includes("您为谁理赔") || text.includes("理赔已提交"),
      detail: text.includes("理赔已提交") ? "submitted-success-page" : "beneficiary-step",
    },
    {
      name: "beneficiary-card",
      ok: Boolean(expectedName) && (text.includes(expectedName) || text.includes("理赔已提交")),
      detail: expectedName,
    },
  ];
  return {
    ready: checks.every((check) => check.ok),
    checks,
  };
}

async function clickBeneficiary() {
  await waitForText("您为谁理赔");
  const name = String(window.__cignaClaimBeneficiaryName || "").trim();
  if (!name) throw new Error("缺少被保险人姓名。");
  const blocks = [...document.querySelectorAll("button, [role='button'], a, vlocity_ins-block, .beneficiary-card, div")]
    .filter((node) => node !== document.body && node.textContent?.includes(name) && isVisible(node))
    .sort((a, b) => elementArea(a) - elementArea(b));
  const block = blocks.find((node) => elementArea(node) > 200);
  if (!block) throw new Error(`找不到 ${name} 被保险人卡片。`);
  block.click();
  await sleep(2000);
}

async function chooseCombobox(labelText, value) {
  const combo = await waitFor(() => findByRoleAndLabel("combobox", labelText), `找不到 ${labelText}`);
  combo.click();
  combo.focus();
  setNativeValue(combo, value);
  combo.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  await sleep(500);
  const option = [...document.querySelectorAll('[role="option"], lightning-base-combobox-item, li, span')]
    .find((node) => node.textContent?.trim() === value);
  if (!option) throw new Error(`找不到选项 ${value}`);
  option.click();
  await sleep(500);
}

async function pickDate(isoDate) {
  const button = await waitFor(() => findByRoleAndLabel("button", "*最早治疗日期是什么时候？"), "找不到日期选择器");
  button.click();
  await sleep(500);
  const target = new Date(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(target.getTime())) throw new Error(`日期格式无效: ${isoDate}`);
  const monthNames = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];
  const targetMonth = target.getUTCMonth();
  const targetYear = target.getUTCFullYear();
  for (let i = 0; i < 24; i += 1) {
    const picked = clickDateInCurrentCalendar({ isoDate, target, monthNames });
    if (picked) {
      await sleep(500);
      return;
    }
    const visible = visibleCalendarMonth(monthNames);
    const direction = visible && (visible.year !== null)
      ? Math.sign((targetYear * 12 + targetMonth) - (visible.year * 12 + visible.month))
      : visible
        ? Math.sign(targetMonth - visible.month)
        : -1;
    const nav = direction > 0
      ? findDateNavButton("next")
      : findDateNavButton("previous");
    if (!nav) throw new Error(`找不到可导航到 ${isoDate} 的日期按钮。`);
    nav.click();
    await sleep(300);
  }
  throw new Error(`找不到日期 ${isoDate}`);
}

function clickDateInCurrentCalendar({ isoDate, target, monthNames }) {
  const wantedMonth = monthNames[target.getUTCMonth()];
  const day = String(target.getUTCDate());
  const paddedDay = day.padStart(2, "0");
  const month = String(target.getUTCMonth() + 1);
  const paddedMonth = month.padStart(2, "0");
  const year = String(target.getUTCFullYear());
  const dateTokens = [
    isoDate,
    `${year}/${paddedMonth}/${paddedDay}`,
    `${year}-${month}-${day}`,
    `${month}/${day}/${year}`,
    `${paddedMonth}/${paddedDay}/${year}`,
    `${year}年${month}月${day}日`,
    `${year}年${paddedMonth}月${paddedDay}日`,
    `${wantedMonth} ${day}, ${year}`,
    `${day} ${wantedMonth} ${year}`,
  ].map(comparableLabel);

  const explicitMatch = [...document.querySelectorAll('[role="gridcell"], button, td, span')]
    .find((node) => {
      if (!isVisible(node) || isDisabled(node)) return false;
      const label = comparableLabel([
        node.getAttribute("aria-label"),
        node.getAttribute("title"),
        node.getAttribute("data-date"),
        node.getAttribute("data-value"),
        node.getAttribute("datetime"),
      ].filter(Boolean).join(" "));
      return label && dateTokens.some((token) => label.includes(token));
    });
  if (explicitMatch) {
    explicitMatch.click();
    return true;
  }

  const grid = [...document.querySelectorAll('[role="grid"]')]
    .find((node) => isVisible(node) && (
      comparableLabel(node.getAttribute("aria-label")).includes(comparableLabel(wantedMonth))
      || comparableLabel(node.closest('[role="dialog"]')?.textContent).includes(comparableLabel(wantedMonth))
    ));
  if (!grid) return false;
  const matchingCells = [...grid.querySelectorAll('[role="gridcell"], button, td')]
    .filter((cell) => isVisible(cell) && !isDisabled(cell) && cell.textContent?.trim() === day)
    .filter((cell) => {
      const label = comparableLabel(cell.getAttribute("aria-label") || cell.getAttribute("title") || "");
      return !label || label.includes(comparableLabel(wantedMonth));
    });
  const cell = matchingCells[0];
  if (!cell) return false;
  cell.click();
  return true;
}

function visibleCalendarMonth(monthNames) {
  const headings = [...document.querySelectorAll("h1, h2, h3, [aria-live], [role='heading']")]
    .filter(isVisible)
    .map((node) => node.textContent?.trim() || "")
    .filter(Boolean);
  const dialogTexts = [...document.querySelectorAll('[role="dialog"]')]
    .filter(isVisible)
    .map((node) => node.textContent || "");
  for (const text of [...headings, ...dialogTexts]) {
    const month = monthNames.findIndex((name) => text.includes(name));
    if (month < 0) continue;
    const yearMatch = text.match(/20\d{2}/);
    return { month, year: yearMatch ? Number(yearMatch[0]) : null };
  }
  return null;
}

function findDateNavButton(direction) {
  const labels = direction === "next"
    ? ["Next Month", "下一月", "下个月"]
    : ["Previous Month", "上一月", "上个月"];
  for (const label of labels) {
    const button = findByRoleAndLabel("button", label);
    if (button && isVisible(button) && !isDisabled(button)) return button;
  }
  return null;
}

async function fillTextbox(label, value) {
  const box = await waitFor(() => findByRoleAndLabel("textbox", label), `找不到 ${label}`);
  setNativeValue(box, value);
  box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  box.dispatchEvent(new Event("change", { bubbles: true }));
  box.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  await sleep(800);
}

async function clickButton(name) {
  const button = await waitFor(() => findByRoleAndLabel("button", name), `找不到按钮 ${name}`);
  if (button.disabled || button.getAttribute("aria-disabled") === "true") {
    await waitFor(() => !(button.disabled || button.getAttribute("aria-disabled") === "true"), `${name} 按钮未启用`);
  }
  button.click();
  await sleep(1500);
}

async function uploadFiles(files) {
  await waitForText("请上传所有文件");
  for (const filePayload of orderedFiles(files)) {
    const input = await waitFor(() => document.querySelector('input[type="file"]'), "找不到文件上传控件");
    const file = fileFromPayload(filePayload);
    const transfer = new DataTransfer();
    transfer.items.add(file);
    try {
      input.files = transfer.files;
    } catch {
      Object.defineProperty(input, "files", { value: transfer.files, configurable: true });
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForUploadComplete(file.name, 60000);
    await clickButton("完成");
    await waitForText(file.name, 15000);
  }
}

async function waitForUploadComplete(fileName, timeoutMs = 60000) {
  const normalizedName = comparableLabel(fileName);
  return waitFor(() => {
    const text = comparableLabel(visiblePageText());
    const hasFile = text.includes(normalizedName);
    const hasComplete = /完成|complete|completed|uploaded|上载完成|上传完成/i.test(text);
    const hasUploadWord = /上传|上载|upload/i.test(text);
    return hasFile && hasComplete && (hasUploadWord || /完成|complete|completed/i.test(text));
  }, `${fileName} 未显示上传完成`, timeoutMs);
}

async function confirmUploadedFiles() {
  const continueButton = await waitFor(() => findClickableText("继续"), "找不到上传页继续按钮");
  continueButton.scrollIntoView({ block: "center" });
  continueButton.click();
  await sleep(800);
  const yes = await waitFor(() => findClickableText("是"), "找不到已上传确认的“是”");
  yes.click();
  await sleep(3000);
}

async function selectPaymentAccount(paymentLabel) {
  await waitForText(paymentLabel, 15000);
  const target = findPaymentAccountTarget(paymentLabel);
  if (target) {
    target.scrollIntoView({ block: "center" });
    target.click();
    target.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(800);
    return;
  }

  const selectableControls = [...document.querySelectorAll('input[type="radio"], input[type="checkbox"], button, [role="button"], label')]
    .filter((node) => isVisible(node) && !isContinueControl(node));
  if (selectableControls.length > 1) {
    throw new Error(`付款页面有多个可选项，但找不到可点击的 ${paymentLabel}。`);
  }
}

async function agreeAndSubmit() {
  await waitForText("请检查并提交", 30000);
  const checkbox = await waitFor(() => document.querySelector('input[type="checkbox"]'), "找不到免责声明复选框");
  checkbox.scrollIntoView({ block: "center" });
  checkbox.click();
  checkbox.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(500);
  await clickButton("提交");
}

async function waitForSubmissionResult() {
  await waitForText("理赔已提交", 60000);
  const text = visiblePageText();
  const patterns = [
    /提交\s*ID[:：]?\s*([A-Z0-9-]+)/i,
    /提交编号[:：]?\s*([A-Z0-9-]+)/i,
    /(?:Submission|Claim)\s*(?:ID|Number|Reference)[:：#]?\s*([A-Z0-9-]+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return {
        submissionId: match[1],
        submissionIdMissing: false,
      };
    }
  }
  return {
    submissionId: `success-no-id-${new Date().toISOString()}`,
    submissionIdMissing: true,
    warning: "Cigna 显示理赔已提交，但页面未显示提交 ID。",
  };
}

function visiblePageText() {
  return document.body?.innerText || document.body?.textContent || "";
}

function fileFromPayload(payload) {
  const binary = atob(payload.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], payload.name, { type: payload.type || "application/octet-stream" });
}

function orderedFiles(files = []) {
  return [...files].sort((a, b) => (
    Number(a.uploadOrder || 9999) - Number(b.uploadOrder || 9999)
    || String(a.name || "").localeCompare(String(b.name || ""))
  ));
}

function findClickableText(text) {
  return [...document.querySelectorAll("button, [role='button'], a, vlocity_ins-button, div, span")]
    .find((node) => node.textContent?.trim() === text && isVisible(node));
}

function findPaymentAccountTarget(paymentLabel) {
  const label = comparableLabel(paymentLabel);
  const candidates = [...document.querySelectorAll('input[type="radio"], input[type="checkbox"], button, [role="button"], label, a, div, section, article')]
    .filter((node) => node !== document.body && isVisible(node))
    .filter((node) => comparableLabel(node.textContent || node.getAttribute("aria-label") || node.value || "").includes(label))
    .filter((node) => !isContinueControl(node))
    .sort((a, b) => elementArea(a) - elementArea(b));

  for (const candidate of candidates) {
    const directControl = candidate.matches?.('input[type="radio"], input[type="checkbox"], button, [role="button"], label, a')
      ? candidate
      : candidate.querySelector?.('input[type="radio"], input[type="checkbox"], button, [role="button"], label, a');
    if (directControl && isVisible(directControl) && !isContinueControl(directControl)) return directControl;
  }
  return null;
}

function isContinueControl(node) {
  return comparableLabel(node.textContent || node.getAttribute?.("aria-label") || node.value || "") === comparableLabel("继续");
}

function isVisible(node) {
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isDisabled(node) {
  return Boolean(node.disabled)
    || node.getAttribute?.("disabled") !== null
    || node.getAttribute?.("aria-disabled") === "true";
}

function elementArea(node) {
  const rect = node.getBoundingClientRect();
  return rect.width * rect.height;
}

function findByRoleAndLabel(role, label) {
  const wanted = comparableLabel(label);
  return [...document.querySelectorAll(`[role="${role}"], button, input, textarea`)]
    .find((node) => {
      const roleOk = node.getAttribute("role") === role || (role === "button" && node.tagName === "BUTTON") || (role === "textbox" && ["INPUT", "TEXTAREA"].includes(node.tagName));
      const text = [node.getAttribute("aria-label"), node.getAttribute("name"), node.textContent, node.value].filter(Boolean).join(" ").trim();
      return roleOk && comparableLabel(text).includes(wanted);
    });
}

function comparableLabel(value) {
  return String(value || "").replace(/\*/g, "").replace(/\s+/g, "").trim();
}

async function waitForText(text, timeoutMs) {
  return waitFor(() => visiblePageText().includes(text), `页面没有出现 ${text}`, timeoutMs);
}

async function waitFor(fn, errorMessage, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = fn();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(errorMessage);
}

function setNativeValue(element, value) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  descriptor?.set?.call(element, value);
}

function sleep(ms) {
  const scale = Number(window.__cignaClaimSleepScale || 1);
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms * scale)));
}

async function emitSubmissionProgress(batchId, payload) {
  if (!batchId || !globalThis.chrome?.runtime?.sendMessage) return;
  try {
    await chrome.runtime.sendMessage({
      type: "CIGNA_SUBMISSION_PROGRESS",
      batchId,
      ...payload,
    });
  } catch {
    // Progress reporting is best-effort; the form submission itself is the critical path.
  }
}

function claimSummary(claim) {
  return {
    id: claim.id,
    serviceDate: claim.serviceDate || "",
    claimDate: claim.claimDate || "",
    fileNames: orderedFiles(claim.files || []).map((file) => file.name),
  };
}

window.__cignaClaimSubmitter = {
  submitClaims,
  submitClaim,
  precheckPage,
  pickDate,
  uploadFiles,
  waitForSubmissionResult,
};
