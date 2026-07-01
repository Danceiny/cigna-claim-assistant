# Cigna Claim Assistant

本项目把一次性的 Cigna 报销自动化沉淀成一个本地小工具雏形：

- Chrome 扩展：使用用户已登录的 Cigna 页面，拖入 PDF/图片或整个文件夹后识别、分组、提交。
- uTools 插件：作为桌面入口选择或拖入报销目录、本地扫描 PDF、生成提交计划，并打开 Cigna/Chrome 提交入口。
- 总交付包：只是把 Chrome 插件、uTools 插件、安装说明和验证材料打在一起的分发合集，不是第三种产品形态。
- uTools 设置会持久化保存被保险人、报销理由、付款账户关键词、最早提交服务日期、长期病症最早治疗日期和最近使用的报销目录，并可导出 Chrome 扩展可导入的设置备份。
- uTools 会显示 Chrome 自动提交设置是否就绪；缺少被保险人、报销理由、付款账户关键词等必填项时，会阻止导出 Chrome 设置备份。
- uTools 扫描可打开本机 OCR，并可填写 OCR 命令路径；留空时本地扫描 CLI 会按自身规则尝试 `tesseract`。
- uTools 扫描也可打开超限 PDF 压缩，直接调用本地扫描 CLI 的 `--compress`。
- 安装包包含 Chrome 扩展图标，安装后可在工具栏和扩展管理页直接识别。
- Chrome 侧边栏：可把助手固定在 Cigna 页面旁边，边看 Cigna 边拖文件和修正识别结果。
- 独立助手页：从 popup 打开完整标签页处理大批文件，拖拽、修正和压缩时不会因为 popup 失焦关闭。
- 后台提交：提交任务由扩展 background worker 执行，popup 关闭后不依赖弹窗继续存活。
- 默认拖入即提交：用户授权文件选择或拖拽后，会自动走识别、压缩、防重、Cigna 页面预检和提交流程；需要人工逐步检查时可关闭“拖入/选择文件后自动处理并提交”。
- 页面预检：可从 popup 打开 Cigna 提交页，或在不提交的情况下检查页面脚本是否能注入。
- Cigna 诊断导出：可下载当前已登录 Cigna 页面结构检查 JSON，验证 URL、起始步骤、被保险人卡片和脚本注入，不上传文件、不提交。
- 真实页面彩排：可在已登录 Cigna 页面走到最终检查页，验证页面选择器、日期选择器、附件上传和付款账户选择；彩排会真实上传附件到 Cigna 页面，但不会勾选免责声明，也不会点击最终提交，不会写入防重账本。
- 本地 helper：批量扫描目录、生成计划，也可作为调试/批处理入口。

## 当前能力

- 本地解析带文本层的 PDF。
- 对扫描件使用文件名和成对规则推断：
  - `0512_1.pdf` 这类 `_1` 文件推断为医疗/理赔表。
  - `0512_2.pdf` 这类 `_2` 文件推断为发票/收据。
  - `2026-05-14/scan_1.pdf` 和 `2026-05-14/scan_2.pdf` 这类日期文件夹内的扫描件会按文件夹日期分组，并按 `_1/_2` 推断类型。
- 从文件名、用户授权的相对文件夹路径和文本提取服务日期。
- OCR 文本补强：扩展和本地扫描 CLI 都会优先读取 PDF 文本层；如果为空，会读取同名 `*.pdf.txt` / `*.txt` sidecar，把识别出的文字送入同一套日期、类型和防漏规则。CLI 额外支持 `--ocr` 调用本机 OCR 命令，也可用 `claims:ocr-sidecars` 先批量生成扩展可直接拖入使用的 sidecar。
- 可选设置长期病症最早治疗日期，例如 `2026-05-05`，只作为整单 PDF/OCR/人工修正都没有最早治疗日期时的兜底值；如果任一相关 PDF/OCR 文本识别出最早治疗日期，会优先使用 PDF/OCR/人工修正日期，不会让全局兜底压过文件内容。
- 可在 popup 中对单个文件修正类型、服务日期、最早治疗日期；适合扫描件没有文本层或文件名不规范时补救。
- popup 会为 PDF 第一页和图片生成本地缩略图，方便修正扫描件类型和日期。
- 可设置最早提交服务日期，例如 `2026-05-08`，早于该日期的分组会阻塞。
- 一天一单自动分组。
- 附件上传顺序稳定并可审计：医疗/理赔表、医疗报告、病程/处方在前，发票/收据在后；导出计划、提交预检和提交账本都会记录 `uploadOrder`。
- 实际提交前会保存批次快照：记录 `submissionFingerprint`、提交日期、跳过日期、压缩是否清零、重复项和附件 hash，便于失败后核对防重防漏。
- 防重：
  - SHA-256 文件哈希去重。
  - `-compressed`、`copy`、原件等同一逻辑文件变体去重，优先保留压缩版。
  - 逻辑文件变体去重会按服务日期/相对文件夹隔离；不同日期文件夹里的同名 `scan_1.pdf`、`scan_2.pdf` 不会互相吞掉。
  - 成功提交后的服务日期会进入账本；再次导入同一天材料会阻塞，防止重新下载或压缩导致 hash 变化后重复提交。
- 防漏：
  - 只有发票/收据会阻塞。
  - 只有医疗/理赔表、没有发票/收据会阻塞。
  - 只有图片会阻塞。
  - 无法确定日期会阻塞。
- 压缩：
  - 单文件超过 6 MB 会进入压缩计划。
  - 单个理赔总附件超过 30 MB 会进入压缩计划。
  - Chrome 扩展内置 PDF 压缩：用 PDF.js 渲染页面，再用 pdf-lib 重建压缩 PDF。
  - 压缩成功日志会显示原始大小、压缩后大小和使用的 scale/quality；如果仍超限，错误会显示最佳结果和每档尝试大小，方便改用外部压缩后再拖回工具。
  - 本地 CLI 批量压缩优先使用 Chromium + PDF.js + pdf-lib 重建扫描 PDF，会尝试多档分辨率和 JPEG 质量直到达标，并保留 macOS ColorSync/Quartz filter 作为非优先路径。

## 从 GitHub Releases 安装

普通使用优先下载 GitHub Release 附件，不需要自己打包：

1. 打开 [Releases](https://github.com/Danceiny/cigna-claim-assistant/releases)。
2. 下载 `cigna-claim-assistant-release.zip`。
3. 解压后双击 `START.html` 或 `OPEN_INSTALLER.command` 查看安装入口。
4. Chrome 插件安装使用解压目录里的 `extension/` 文件夹。
5. uTools 插件导入同目录里的 `cigna-claim-assistant-utools.upx`。

也可以单独下载 `cigna-claim-assistant.zip` 归档 Chrome 扩展，或下载 `cigna-claim-assistant-utools.upx` 只安装 uTools 桌面伴侣。真实 Cigna 自动提交仍由 Chrome 插件完成。

## 从源码安装扩展

1. 打开 Chrome: `chrome://extensions`
2. 打开 Developer mode。
3. 选择 Load unpacked。
4. 选择本项目的 `extension` 目录。
5. 在普通 Chrome 里登录 Cigna Envoy，并打开 Cigna 页面。

## 开源仓库边界

GitHub 仓库只保留源码、测试、文档和可复现的打包脚本，不提交本地报销文件、Cigna 页面截图、Chrome profile、`outputs/` 计划文件、`dist/` 生成包或 `node_modules/`。需要交付安装包时，在本地运行打包命令重新生成。

## 打包扩展

```bash
npm run extension:package
```

输出文件为 `dist/cigna-claim-assistant.zip`。打包前会检查 manifest 声明的入口文件、content script、vendor 文件是否存在。

生成可交付 release 包：

```bash
npm run extension:release
```

输出文件为 `dist/cigna-claim-assistant-release.zip`，这是总交付包，不是第三种产品形态。它包含可直接 `Load unpacked` 的 Chrome `extension/` 文件夹、扩展 zip、可导入 uTools 的 `cigna-claim-assistant-utools.upx`、机器可读的 `release-manifest.json`、双击可打开的 `START.html`、macOS 安装辅助脚本 `OPEN_INSTALLER.command`、README 和中文安装使用清单 `INSTALL.zh-CN.md`。

实际产品形态仍然只有两种：Chrome 插件负责复用用户已登录的 Cigna 页面并执行真实提交，uTools 插件负责本地入口、拖入 PDF、扫描识别、基础设置和导出 Chrome 设置备份。release zip 只是把这两种形态和安装/验证材料放在一起的分发包。

release 包根目录也是一个本地 helper 包。解压后如需使用批量 OCR sidecar 或本地扫描 CLI，先在 release 根目录运行：

```bash
npm install
```

## 使用扩展

1. 点击扩展图标。
2. 处理大批文件时，优先从 Chrome 侧边栏打开 Cigna Claim Assistant；也可点击 `独立页面` 打开完整助手页。少量文件可直接在 popup 里操作。
3. 设置被保险人、报销理由、治疗国家/地区、理赔类型、就诊类型、付款账户关键词、可选的长期病症最早治疗日期兜底值、最早提交服务日期，以及是否允许提交需复核但未阻塞的项目。这些设置会保存；报销理由没有内置默认值，必须明确填写或从备份导入；默认允许提交普通扫描件类 `review` 项。
   - `拖入/选择文件后自动处理并提交` 默认开启。关闭后，选择或拖入文件只会进入当前批次，需要手动点击 `自动处理并提交`。
   - 设置区下方会显示自动提交是否已就绪；缺少被保险人、报销理由、付款账户等必填项时会列出缺项。
   - 防重记录状态会显示本地已记录的提交日期、理赔键和文件 hash 数，便于确认扩展是否还记得历史提交。
4. 可选：点击 `打开 Cigna` 打开/定位提交页，或点击 `检查 Cigna 页面` 做不提交的结构预检，确认页面 URL、起始步骤和被保险人卡片可识别。需要留存验收证据时，点击 `导出 Cigna 诊断` 下载只读诊断 JSON。
5. 选择/拖入报销文件夹，或点击 `添加文件` 追加单个 PDF/图片；拖入文件夹会递归读取其中的 PDF/图片，同一批次内同名同大小文件会去重。同名 `.txt` OCR sidecar 可一起拖入，只用于识别，不会作为附件上传。
6. 检查 summary 中的 `将提交 / 将跳过 / 需压缩` 数量；也可点击 `导出计划` 下载本次识别结果，检查将提交、跳过、阻塞、压缩和重复项。
   - 每个理赔单会显示最早治疗日期来源：PDF/OCR 文本、人工修正或全局兜底。提交前优先确认不是误用全局兜底。
   - 如果扫描件被识别成 unknown、未识别日期，直接在文件行里修正 `类型`、`服务日期` 或 `最早治疗日期`；计划会立即重算。之后用 `添加文件` 或拖拽追加附件时，已选文件的人工修正会保留；重新选择文件夹会开启新批次并清空当前批次修正。
   - 文件行里的缩略图只在当前 popup 本地显示，不会写入提交账本或导出计划。
   - 如果选错文件，点击文件行里的 `移除`，计划会立即重算。
   - 如果整批选错，点击 `清空批次`；基础设置和提交记录不会被清除。
7. 可先点击 `提交预检` 导出将提交的日期、字段、附件、大小和哈希清单；预检不会启动 Cigna 提交，也不会导出 PDF/图片内容。
8. 可选：点击 `真实页面彩排`，让工具在已登录 Cigna 页面完整填写到最终检查页后停止。彩排会上传附件并选择付款账户，但不会勾选免责声明、不会点击最终提交，也不会写入防重账本。
9. 点击 `自动处理并提交`。

自动流程会依次识别文件、压缩超限 PDF、重新分组，然后提交可提交项。提交时如果没有现成的 Cigna 标签页，后台会打开中文提交页并使用当前 Chrome 登录态。`blocked` 或未允许提交的 `review` 会被跳过并显示原因；如果没有任何可提交项才会停止。

默认打开“拖入/选择文件后自动处理并提交”，文件夹选择、添加文件和拖拽文件都会自动启动这条自动流程。自动触发仍会执行必填设置校验、Cigna 页面预检、压缩检查、防重账本检查和正在提交锁检查；校验失败时只会显示错误，不会进入 Cigna 提交动作。

`review` 并不总是自动提交。扫描件文本层为空、但日期和文件类型可推断时，可按设置自动提交；如果包含无法识别文件类型或低置信度文件，会被标记为 `review 需要人工确认` 并跳过。

每次自动提交前，后台都会强制执行 Cigna 页面结构预检。只要 Chrome 里有已登录的 Cigna 标签页，后台会复用该标签页并自动导航到中文新建理赔入口；如果页面卡在非起始步骤，会重置一次再预检。预检会确认 URL、起始步骤和被保险人卡片可识别；被保险人不匹配或重试后仍失败会停止提交，不会进入 Cigna 表单提交动作。`导出 Cigna 诊断` 使用同一套预检路径，但只导出 JSON，不会触发表单提交。

提交脚本会使用 popup 中的国家/地区、理赔类型和就诊类型选择 Cigna 下拉框；付款页会查找并点击匹配付款账户关键词的账户，例如 `BANK 0001`。如果关键词不存在，或页面存在多个付款可选项但找不到匹配账户，会停止提交。

提交前会在本地校验必填设置：被保险人、报销理由、国家/地区、理赔类型、就诊类型和付款账户关键词。每单还必须能确定最早治疗日期；优先使用 PDF/OCR/人工修正里的最早治疗日期，只有整单都缺失时才使用长期病症最早治疗日期兜底值，不会拿服务日期冒充最早治疗日期，也不会让全局兜底覆盖 PDF/OCR 文本里的真实日期。校验失败不会发送提交请求；修正设置后可继续点击 `提交预检` 或 `自动处理并提交`。

批量提交时每一天独立记录结果：某一天提交失败会显示 failed 和错误原因，后续日期仍会继续尝试；本地防重账本只记录真正提交成功的日期。

如果 Cigna 已显示“理赔已提交”但页面未显示提交 ID，工具仍会把该日期记录为已成功提交，并在记录里标记 `submissionIdMissing: true` 和警告，避免因为成功页文案变化导致本地账本漏记、后续重复提交。

提交返回后 popup 会用最新账本立即重算当前批次；已经成功提交的文件会显示为 duplicate 或已提交日期阻塞，避免用户在同一个打开的 popup 里重复点击提交。

如果后台已有提交处于 queued、opening-tab、injecting、prechecking 或 submitting 状态，popup 和 background worker 都会拒绝启动新的提交批次，避免并发重复提交。该锁 6 小时后会视为过期，允许从浏览器崩溃或扩展中断留下的旧状态中恢复。

也可以手动执行：

1. 点击 `识别文件`。
2. 检查分组：
   - `ready` 可直接提交。
   - 普通 `review` 默认会提交；取消勾选“允许提交需复核但未阻塞的项目”后会跳过。
   - 需要人工确认的 `review` 不会自动提交。
   - `blocked` 不会提交。
   - `需要压缩` 的项目先点 `压缩 PDF`，压缩后会自动重新识别。
3. 点击 `提交可提交项`。

提交会发送到后台 worker，由后台找到已登录的 Cigna 标签页、注入提交脚本并记录提交账本。重新打开 popup 会显示最近一次后台提交状态、当前第几单、每个日期的完成状态和提交 ID。

`提交预检` 会下载预检文件，包含即将提交到 Cigna 的日期、最早治疗日期来源、表单字段、附件上传顺序、附件名、大小、hash、`submissionFingerprint` 和本地账本记录摘要，但不包含 PDF/图片 base64 内容，也不会启动提交。实际提交消息、提交前批次快照和成功后的本地账本也会记录同一个 `submissionFingerprint`，用于核对提交的就是预检过的那批字段和附件。`导出计划` 会下载本次识别计划，包含 summary、可提交项、跳过项、blocked 项、压缩项、最早治疗日期来源、附件上传顺序、重复文件和最近一次提交快照。`导出记录` 会下载本地防重账本和最近提交状态。`导入记录` 会合并导出的账本，用于失败后恢复已成功日期；如果当前已选文件，会立即重新识别并阻塞已提交日期。`导出备份` 会下载基础设置、账本、最近提交状态、最近一次提交快照和最近一次 Cigna 诊断，适合重装扩展或换机器；`导入备份` 会恢复基础设置并合并账本，同时恢复最近诊断/快照。`清空记录` 只清除本地账本、最近提交状态和最后一次提交结果，不清除基础设置。

面向日常使用的安装、压缩、防重防漏和失败恢复步骤见 `docs/INSTALL.zh-CN.md`。release 包内包含 Chrome 扩展、uTools `.upx`、可双击打开的 `START.html` 和 `OPEN_INSTALLER.command`。验收证据和真实 Cigna 上线前检查见 `docs/VERIFICATION.md`。

## 本地扫描

```bash
npm run claims:scan -- --dir /Users/bytedance/Documents/报销 --output outputs/current-claim-plan.json
```

输出会列出每个日期分组、状态、阻塞原因、警告和压缩计划。
扫描会递归遍历目录下的 PDF/图片，并把相对路径写入计划；日期文件夹内的扫描件可以复用扩展里的路径日期推断规则。

如果扫描 PDF 没有文本层，可以放置同名 OCR 文本；扩展拖入文件夹和本地 CLI 都会读取：

```bash
/Users/bytedance/Documents/报销/2026-05-14/scan_1.pdf
/Users/bytedance/Documents/报销/2026-05-14/scan_1.pdf.txt
```

批量生成扩展可用的 OCR sidecar：

```bash
npm run claims:ocr-sidecars -- --dir /Users/bytedance/Documents/报销 --ocr-command /path/to/ocr-wrapper
```

如果是在解压后的 release 包里运行，先在 release 根目录执行一次 `npm install`。
也可以执行 `npm run claims:test:helper` 做本地 helper 自检；它会检查核心同步并用默认输出路径跑一次空目录扫描。

未传 `--ocr-command` 时会尝试 `tesseract <file> stdout -l eng`。生成的默认文件名是 `原文件名.pdf.txt`，例如 `scan_1.pdf.txt`；扩展拖入原文件夹时会自动读取这些 sidecar，sidecar 不会作为 Cigna 附件上传。已有 sidecar 默认不会覆盖；需要重跑时加 `--overwrite`。

CLI 也可以调用本机 OCR 命令：

```bash
npm run claims:scan -- --dir /Users/bytedance/Documents/报销 --ocr --ocr-command /path/to/ocr-wrapper
```

`--ocr-command` 会收到文件路径作为第一个参数，并把 stdout 当作 OCR 文本。未指定 `--ocr-command` 时会尝试 `tesseract <file> stdout -l eng`；如果本机未安装 tesseract，会跳过 OCR，不影响文件名/文件夹日期推断。

uTools 插件里的 `扫描时启用本机 OCR` 和 `OCR 命令` 会传给同一套本地扫描 CLI，适合先在桌面端审计扫描件日期和文件类型。

## 本地压缩

扫描时只规划压缩：

```bash
npm run claims:scan -- --dir /Users/bytedance/Documents/报销
```

尝试压缩计划中的 PDF：

```bash
npm run claims:scan -- --dir /Users/bytedance/Documents/报销 --compress
```

压缩输出默认写入 `outputs/compressed/`。这是扩展内置压缩之外的备用路径，适合先把超 6 MB 的扫描 PDF 处理成可上传版本。

uTools 插件里的 `扫描时压缩超限 PDF` 会传给同一套本地扫描 CLI，适合在桌面端先生成带压缩结果的计划。

## 验证

在源码仓库里一键生成并验证当前可交付包：

```bash
npm run verify:release
```

它会顺序覆盖核心识别、CLI/helper、PDF 压缩、mock Cigna 提交、Chrome popup/background/manifest、release 打包、打包后 Chrome 扩展加载、uTools `.upx` 审计、uTools 页面 smoke、release helper 解包运行和 release 解压后用户侧入口冒烟验证。解压后的 release 包只保留用户侧 helper 命令，完整 release 验证入口保留在源码仓库。

也可以按需单独运行：

```bash
npm run claims:test
npm run claims:test:core-sync
npm run claims:test:helper
npm run claims:test:scan
npm run claims:test:compress
npm run claims:test:e2e
npm run extension:test:background
npm run extension:test:popup
npm run extension:test:manifest
npm run extension:test:load
npm run extension:test:load:headed
npm run extension:test:zip:load
npm run utools:test:package
npm run utools:test:renderer
npm run extension:test:release
npm run extension:test:release-helper
npm run extension:test:release-user-smoke
npm run extension:icons
npm run extension:package
npm run extension:release
```

`extension:test:load` 默认用 headless Chromium 探测 unpacked 扩展加载能力；如果当前 Chromium 不在 headless 模式启动扩展 service worker，会明确跳过。桌面窗口验证可运行：

```bash
npm run extension:test:load:headed
```

当前测试覆盖：

- 日期提取。
- 附件上传顺序稳定，并进入计划、提交预检、content script payload 和提交账本。
- 提交预检、提交前批次快照、实际提交消息和成功账本共享 `submissionFingerprint`，用于审计字段和附件清单一致性。
- CLI 和扩展共用的核心识别/防重/日期规则保持字节级同步，避免只改一边。
- 长期病症最早治疗日期不会被误用为服务日期；全局兜底不会覆盖 PDF/OCR 文本或人工修正里的真实最早治疗日期；最早治疗日期来源会进入计划、预检和提交账本。
- 只有发票阻塞。
- 只有医疗/理赔表但缺少发票/收据阻塞。
- 早于最早提交服务日期的分组阻塞。
- 大 PDF 触发压缩计划。
- 本地 CLI 压缩策略覆盖多档 scale/quality，而不是单次压缩后直接放弃。
- 重复文件哈希跳过。
- 已成功提交服务日期跳过。
- 扫描件文件级类型/日期修正后重新分组。
- 本地扫描 CLI 递归读取日期子目录，并保留相对路径用于日期推断和审计。
- 扩展和本地扫描 CLI 读取 OCR sidecar，把扫描件文字用于服务日期和文件类型识别；CLI 还可调用外部 OCR 命令。
- `claims:ocr-sidecars` 批量生成 `.pdf.txt` OCR sidecar，随后 `claims:scan` 和扩展都能读取。
- mock Cigna 页面上的结构预检、诊断导出、日期点击、PDF 上传、确认提交、付款账户选择链路。
- mock Cigna 页面上成功页缺少提交 ID 时仍记录为 submitted，并带 `submissionIdMissing` 标记。
- mock Cigna 页面上单项失败后继续提交后续日期。
- background worker 复用已登录 Cigna 标签页并导航到新建理赔入口、注入 content script、提交前强制 Cigna 页面预检、转发提交、正在提交时拒绝并发启动、旧提交锁过期恢复、记录防重账本、整体提交状态、逐单进度和单项失败。
- popup/独立助手页设置恢复、基础提交字段持久化、提交前必填设置校验、提交预检导出、正在提交时本地阻断重复启动、旧提交锁过期恢复、review 默认提交和高风险 review 人工确认策略、Cigna 页面预检入口、提交状态展示、批次提交/跳过/压缩摘要、文件选择、文件夹拖拽递归读取、选择/拖入后自动处理并提交开关、文件移除、清空当前批次、PDF/图片本地缩略图、文件级类型/日期修正、一键自动处理入口、计划导出、超大 PDF 先压缩再提交、图片类阻塞识别、混合批次跳过 blocked 并提交 eligible claims、提交后立即按账本刷新防重状态、本地账本导出/导入、完整备份导出/导入和清空。
- manifest 声明 Chrome side panel，入口复用 `assistant.html`。
- manifest 声明扩展图标和 toolbar action 图标，打包脚本会检查图标文件存在。
- Chrome 以 unpacked MV3 扩展方式加载 extension 目录，验证 service worker、popup 默认设置、assistant 页面、background 消息响应和文件夹选择入口。
- 扩展 zip 解包加载测试会解压 `dist/cigna-claim-assistant.zip`，再用同一套 MV3 加载验证检查打包产物可作为 unpacked 扩展运行。
- uTools `.upx` 包审计会确认桌面入口、目录选择、本地扫描计划、打开 Cigna 入口、必要运行时依赖都在包内，并会解包后加载 `index.html`/`renderer.js` 做页面 smoke。
- uTools renderer smoke 会加载 `utools/index.html` 和 `renderer.js`，验证设置恢复、目录选择、拖入目录、扫描、导出 Chrome 设置、打开 Cigna 和打开发布包目录这些 UI 动作能调用预期 API。
- release 包审计会直接读取 `dist/cigna-claim-assistant-release.zip`，确认 Chrome 扩展入口、uTools 插件包、sidecar OCR、提交预检、压缩、Cigna 提交脚本、`release-manifest.json`、中文安装说明和真实 Cigna 验收限制都在交付包内。
- release helper 解包测试会把 `dist/cigna-claim-assistant-release.zip` 解到临时目录，执行 `npm install`、`claims:test:core-sync` 和默认输出的 `claims:scan`，确认用户解压后本地 helper 可以按文档运行。
- release 用户侧冒烟测试会把 `dist/cigna-claim-assistant-release.zip` 解到临时目录，确认 `START.html` 的本地链接都指向实际文件、release helper 不暴露源码仓库专用验证入口、uTools `.upx` 可读取，并把解压后的 `extension/` 目录作为 unpacked Chrome 扩展加载。

## 设计边界

Chrome 扩展不能静默读取任意本地路径；用户必须通过文件夹选择、文件选择或拖拽把 PDF 交给扩展。选择文件夹会开启一批新文件，`添加文件` 和拖拽文件/文件夹会追加到当前批次并做选择层去重。扩展内置压缩会把 PDF 页面重建为 JPEG 页面，因此是有损压缩，适合扫描发票和理赔表，不适合需要保留可复制文本层的 PDF。浏览器扩展当前不内置大体积 OCR 引擎；扫描件 OCR 可通过同名 sidecar 进入扩展，或先通过本地 CLI 的 `claims:ocr-sidecars` / `--ocr-command` 生成识别文本，再用同一套规则审计计划。

当前提交自动化依赖 Cigna 中文页面结构。Cigna UI 如果调整，主要需要修改 `extension/content/cignaSubmitter.js`，PDF 识别/分组/压缩逻辑不受影响。
