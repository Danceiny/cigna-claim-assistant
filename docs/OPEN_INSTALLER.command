#!/bin/bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
EXTENSION_DIR="$DIR/extension"
START_FILE="$DIR/START.html"
MANIFEST_FILE="$EXTENSION_DIR/manifest.json"
UTOOLS_PACKAGE="$DIR/cigna-claim-assistant-utools.upx"
CIGNA_URL="https://customer.cignaenvoy.com/s/new-submitclaim?LanguageCode=zh_CN&language=zh_CN"

if [[ ! -f "$MANIFEST_FILE" ]]; then
  osascript -e 'display dialog "没有找到 extension/manifest.json。请确认已解压完整 release 包。" buttons {"OK"} default button "OK" with icon caution'
  exit 1
fi

if [[ ! -f "$UTOOLS_PACKAGE" ]]; then
  osascript -e 'display dialog "没有找到 cigna-claim-assistant-utools.upx。Chrome 扩展仍可安装，但 uTools 插件包缺失；请确认已解压完整 release 包。" buttons {"OK"} default button "OK" with icon caution'
fi

printf "%s" "$EXTENSION_DIR" | pbcopy || true

open "$START_FILE"
open -a "Google Chrome" "chrome://extensions" || open "chrome://extensions"
open -R "$UTOOLS_PACKAGE" || true

osascript <<APPLESCRIPT
display dialog "Cigna Claim Assistant 安装准备完成。\n\n1. Chrome 已打开扩展管理页。\n2. extension 文件夹路径已复制到剪贴板。\n3. 点击 Load unpacked 后粘贴/选择该 extension 文件夹。\n4. Finder 已定位 uTools 插件包 cigna-claim-assistant-utools.upx，可在 uTools 中导入。\n\n安装后请在同一个 Chrome 登录 Cigna，再点击扩展里的 检查 Cigna 页面。" buttons {"打开 Cigna", "稍后"} default button "打开 Cigna" with icon note
if button returned of result is "打开 Cigna" then
  do shell script "open -a 'Google Chrome' " & quoted form of "$CIGNA_URL"
end if
APPLESCRIPT
