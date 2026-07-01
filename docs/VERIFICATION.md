# Cigna Claim Assistant 验收审计

## 目标要求

- 用户只需要在自己的 Chrome 登录 Cigna。
- 交付包同时包含 Chrome 插件形态和 uTools 桌面伴侣插件形态。
- uTools 形态支持选择或拖入报销文件夹；拖入单个 PDF 时使用它所在目录生成扫描计划。
- uTools 形态可保存完整基础设置，并导出 Chrome 扩展可导入的设置备份。
- 用户把 PDF/图片拖进工具后，工具本地识别、按服务日期一天一单分组。
- 用户可把同名 OCR `.txt` sidecar 一起拖入扩展；sidecar 只用于识别，不作为附件上传。
- 用户可用本地 CLI 批量生成扩展可读取的 OCR sidecar。
- 用户可把助手作为 Chrome 侧边栏固定在 Cigna 页面旁边。
- 安装后的 Chrome 扩展有工具栏/扩展管理页图标，方便和普通网页标签区分。
- 用户可从 popup 打开独立助手页，处理大批文件时不依赖 popup 保持打开。
- 用户可打开拖入/选择后自动提交开关，使授权文件后自动启动识别、压缩、防重和提交流程。
- 用户可在真实提交前导出提交预检，不启动 Cigna 提交动作。
- 用户可在真实提交前导出 Cigna 页面诊断，不上传文件、不提交理赔。
- 用户可修正扫描件的文件类型、服务日期和最早治疗日期。
- 用户修正扫描件时能看到本地缩略图辅助核对。
- 用户选错文件时可从当前批次移除，工具立即重算提交计划。
- 用户整批选错时可清空当前批次，且不会清除基础设置或防重账本。
- 已有提交进行中时，工具拒绝启动第二个提交批次。
- 浏览器或扩展中断留下的旧提交锁会在 6 小时后过期，允许恢复操作。
- 工具能设置基础字段：被保险人、报销理由、治疗国家/地区、理赔类型、就诊类型、付款账户关键词、可选长期病症最早治疗日期兜底值、最早提交服务日期。
- 日期必须通过 Cigna 日期选择器点击选择，不能手动输入。
- 工具必须暴露最早治疗日期来源，便于提交前审计。
- 每个报销单包含当天所有相关文件。
- 每个报销单的附件上传顺序必须稳定并可审计。
- 提交预检、提交前批次快照和实际提交必须可用同一个批次指纹核对一致性。
- 只有发票不能提交；缺少发票也不能提交。
- 需要防重、防漏。
- 超过上传限制的 PDF 必须压缩；压缩失败或仍超限不能提交。
- 能在已登录 Cigna 页面自动提交，并记录成功提交结果。

## 当前已验证证据

- 源码仓库一键 release 验证：
  - `npm run verify:release`
  - 顺序覆盖核心识别、核心同步、本地 helper、扫描 CLI、PDF 压缩、mock Cigna 提交、Chrome background/popup/manifest、release 打包、打包后 Chrome 扩展加载、uTools `.upx` 审计、uTools 页面 smoke、release helper 解包运行和 release 解压后用户侧入口冒烟验证。
- 文件识别、分组、最早治疗日期、最早提交服务日期、发票/医疗文件阻塞、重复文件和已提交日期阻塞：
- `npm run claims:test`
- 覆盖长期病症最早治疗日期不会被误用为服务日期、服务日期不会冒充最早治疗日期、PDF 内最早治疗日期优先用于 Cigna 日期选择器、最早治疗日期来源标记、稳定附件上传顺序、日期文件夹内 `scan_1/scan_2` 自动分组和类型推断、跨日期同名扫描件不被逻辑去重吞掉，以及手动修正扫描件后重新分组。
- 核心逻辑同步：
  - `npm run claims:test:core-sync`
  - 覆盖 CLI 和扩展使用的核心识别/防重/日期规则保持字节级同步，避免发布包和本地 helper 行为漂移。
- 本地扫描 CLI：
  - `npm run claims:test:scan`
  - 覆盖递归读取日期子目录、保留相对路径、复用路径日期推断、OCR sidecar 读取、外部 OCR 命令文本接入，以及批量生成 `.pdf.txt` sidecar 后再由扫描计划消费。
- 本地压缩策略：
  - `npm run claims:test:compress`
  - 覆盖多档 scale/quality 压缩尝试矩阵，避免退回单轮压缩。
- Cigna mock 页面端到端提交：
  - `npm run claims:test:e2e`
  - 覆盖被保险人选择、国家/地区、理赔类型、就诊类型、日期选择器点击、诊断填写、文件上传、上传完成文案变体、上传确认、付款账户选择、免责声明勾选、提交 ID 提取，以及成功页缺少提交 ID 时仍记录为已提交并标记 `submissionIdMissing`。
- background worker：
  - `npm run extension:test:background`
  - 覆盖复用已登录 Cigna 标签页并导航到新建理赔入口、页面预检、content script 注入、提交前阻断、逐单进度、只记录成功提交的理赔单。
- popup：
- `npm run extension:test:popup`
- 覆盖设置持久化、必填校验、独立助手页打开和加载、侧边栏窄宽度无横向溢出、文件选择、文件夹拖拽递归读取、OCR sidecar 进入扩展识别但不进入附件、拖入/选择后自动处理并提交开关、文件移除、清空当前批次、PDF 缩略图、文件级类型/日期修正、追加文件后保留已有人工修正、计划导出、Cigna 页面诊断导出、提交预检导出且不包含文件 base64、提交前批次快照、提交预检和实际提交共享 `submissionFingerprint`、账本导入导出、完整备份导入导出、正在提交时拒绝重复启动、旧提交锁过期恢复、review 跳过策略、压缩后再提交、提交后按账本刷新防重。
- manifest:
  - `npm run extension:test:manifest`
  - 覆盖 MV3 manifest、side panel 入口、权限、content script 和 vendor 文件存在。
  - 也覆盖扩展图标和 toolbar action 图标声明。
- unpacked 扩展加载：
  - `npm run extension:test:load:headed`
  - 已用桌面 Chromium 验证当前 `extension/` 目录可作为 unpacked MV3 扩展加载，service worker 启动，popup 和 assistant 页面可打开，background worker 能响应消息。
- extension zip 解包加载：
  - `npm run extension:test:zip:load`
  - 覆盖 `dist/cigna-claim-assistant.zip` 解压后的 MV3 加载、popup、assistant 和 background 响应。
- extension 打包：
  - `npm run extension:package`
  - `npm run extension:release`
  - `npm run extension:test:release`
- uTools 打包：
  - `npm run utools:test:package`
  - 覆盖 `.upx` 内的 `plugin.json`、桌面入口、目录选择/拖入、本地扫描计划、完整基础设置持久化、Chrome 设置备份导出、打开 Cigna 入口、必要运行时依赖，以及解包后 `index.html`/`renderer.js` 的页面 smoke。
- uTools 页面 smoke：
  - `npm run utools:test:renderer`
  - 覆盖 `utools/index.html` 加载、设置恢复、目录选择、拖入目录、扫描、导出 Chrome 设置、打开 Cigna 和打开发布包目录的 UI 调用链路。
- release 打包：
  - `npm run extension:release`
  - `npm run extension:test:release`
  - 覆盖 release zip 内的 manifest、`release-manifest.json`、popup、assistant、扩展图标、uTools `.upx`、双击可打开的 `START.html`、macOS 安装辅助脚本 `OPEN_INSTALLER.command`、可 `npm install` 的本地 helper package、sidecar OCR、提交预检、压缩、Cigna content script、安装说明和验收限制说明。
- release helper 解包运行：
  - `npm run extension:test:release-helper`
  - 覆盖 release zip 解压后的本地 helper：执行 `npm install` 和 release 内部的 `npm run claims:test:helper`。
- release 用户侧入口冒烟：
  - `npm run extension:test:release-user-smoke`
  - 覆盖 release zip 解压后的 `START.html` 本地链接、README/INSTALL/VERIFICATION 产品形态说明、helper package 命令边界、uTools `.upx` 可读取，以及解压后的 `extension/` 目录可作为 unpacked Chrome 扩展加载。
- release 内部 helper 自检：
  - `npm run claims:test:helper`
  - 覆盖核心同步检查和默认输出路径的空目录 `claims:scan`。

## 当前不能据此声明完成的部分

- 未在真实登录态 Cigna Envoy 上完成当前版本的端到端提交验证。
- uTools 插件是桌面扫描和计划导出入口；真实 Cigna 登录态提交仍由 Chrome 插件执行。
- PDF 内容识别主要依赖文本层、文件名、成对扫描件规则、用户修正和 OCR sidecar 文本补强。浏览器扩展当前不内置完整 OCR 引擎；CLI 可调用外部 OCR 命令生成 `.pdf.txt` sidecar 或直接生成扫描计划。
- 缩略图只在 popup 本地显示；导出计划只记录 `hasThumbnail`，不包含缩略图内容。
- 完整备份包含基础设置、账本和最近提交状态，不包含已选择文件、PDF 内容或缩略图 data URL。
- 付款账户选择会点击匹配付款账户关键词的可见控件；如果 Cigna 付款页结构变化，仍需要用真实页面重新验证。
- Chrome 扩展不能静默读取任意本地目录；用户必须通过文件选择、文件夹选择或拖拽授权文件。
- `extension:test:load` 在 headless Chromium 下可能跳过 service worker 启动验证；桌面窗口验证使用 `npm run extension:test:load:headed`。

## 真实上线前检查清单

1. 在用户常用 Chrome 中安装 release 包里的 `extension/` 文件夹，不使用临时 profile。
2. 登录 Cigna Envoy，打开任意 Cigna 页面。
3. 点击扩展的 `检查 Cigna 页面`，确认扩展能复用已登录标签页并定位到中文新建理赔入口，且 URL、起始步骤和被保险人卡片均通过。
4. 拖入一小批真实文件，点击 `识别文件`，导出计划并检查：
   - 每个服务日期一单。
   - PDF/OCR/人工修正里的最早治疗日期用于 Cigna 日期选择器，服务日期没有被当作最早治疗日期。
   - 每单同时有医疗/理赔表和发票/收据。
   - 扫描件识别不准时，先用文件行修正类型和服务日期，再确认计划重算结果。
   - 早于最早提交服务日期的项目被阻塞。
   - 单文件和总附件大小没有超限；如果超限，先压缩到 `需压缩 0`。
5. 用一单真实低风险材料做实际提交验证，确认：
   - 日期由日期选择器点击选中。
   - 付款账户关键词匹配并被选中。
   - 提交成功后能拿到 Cigna 提交 ID。
   - 本地账本记录该服务日期，再次导入同一天会阻塞。
