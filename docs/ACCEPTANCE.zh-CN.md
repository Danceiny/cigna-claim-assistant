# 验收矩阵

本文件用于判断 Cigna Claim Assistant 是否满足原始目标：用户在常用 Chrome 中登录 Cigna 后，把报销 PDF/图片交给工具，由工具完成识别、压缩、防重防漏和按天自动提交；基础字段可由用户设置。

## 当前结论

源码、自动化测试和当前发布包已经证明 Chrome 插件 + uTools 插件的小工具形态可交付；mock Cigna 页面已经覆盖从文件识别到自动填写、点击日期选择器、上传附件、选择付款账户和提交结果记录的链路。

仍未证明的唯一上线项是：在真实登录态 Cigna Envoy 页面完成最终提交，并拿到真实提交结果。发布包因此仍把 `release-manifest.json` 中的 `limits.realCignaEndToEndVerified` 标记为 `false`。

## 需求与证据

| 需求 | 当前证据 | 状态 |
| --- | --- | --- |
| 做成小工具，而不是一次性脚本 | Chrome MV3 扩展位于 `extension/`，uTools 插件位于 `utools/`，发布包包含两者和安装入口 | 已证明 |
| 用户使用常用 Chrome 登录 Cigna | README、安装页和发布包入口要求安装到常用 Chrome；background 会复用或打开 Cigna 标签页 | 已实现，真实登录态最终提交待验收 |
| 往工具里扔 PDF/图片或目录 | popup/assistant 支持文件选择、追加文件、拖拽文件和递归目录读取；uTools 支持桌面目录选择/拖入扫描 | 已证明 |
| 自动识别 PDF 内容 | 核心规则读取 PDF 文本层，支持 OCR sidecar；CLI 可调用本机 OCR 生成 sidecar | 已证明 |
| 一天一个报销单 | 核心规则按服务日期分组，content script 每个 claim 单独提交 | 已证明 |
| 不能只有发票就提交 | 核心规则阻塞只有发票/收据的分组，也阻塞缺少发票/收据的医疗材料 | 已证明 |
| 处理 PDF 超限 | Chrome 扩展内置压缩，本地 CLI/uTools 可批量压缩；单文件和单理赔总附件大小都会检查 | 已证明 |
| 防重防漏 | 本地账本记录文件 hash、服务日期、claim key 和提交结果；提交后立即按账本刷新，导入账本会阻塞已提交日期 | 已证明 |
| 基础设置可配置 | 被保险人、报销理由、国家/地区、理赔类型、就诊类型、付款账户关键词、最早服务日期和长期病症兜底日期均在 UI 中设置并持久化 | 已证明 |
| 日期通过 Cigna 日期选择器点击 | content script 使用日期控件导航和点击日期，不手动输入日期 | mock 已证明，真实页面待最终验收 |
| 自动提交前可审计 | 提交预检导出字段、附件名、大小、hash、日期来源和 `submissionFingerprint`，不包含 PDF/图片 base64 | 已证明 |
| 可在真实页面低风险验收 | 真实页面彩排会上传附件并停在最终检查页，不勾免责声明、不点击最终提交、不写防重账本 | 已证明到代码和 mock，真实页面需人工或代理执行验收 |
| 发布包可安装 | release 包包含 Chrome `extension/`、扩展 zip、uTools `.upx`、`START.html`、`OPEN_INSTALLER.command` 和 helper package | 已证明 |

## 真实 Cigna 最终验收清单

在把 `realCignaEndToEndVerified` 改为 `true` 前，需要在用户常用 Chrome 登录态下完成以下步骤，并保存证据：

1. 安装最新 release 包里的 Chrome `extension/`，不使用临时 Chrome profile。
2. 在同一个 Chrome 中登录 Cigna Envoy，并打开中文新建理赔页。
3. 配置被保险人、报销理由、国家/地区、理赔类型、就诊类型和付款账户关键词。
4. 拖入一组低风险、可真实提交的测试报销 PDF，确认识别结果为一天一个可提交 claim。
5. 点击 `提交预检`，保存预检 JSON。
6. 点击 `真实页面彩排`，确认已到达最终检查页，且没有勾选免责声明、没有最终提交。
7. 重新打开新建理赔页，点击 `自动处理并提交` 完成一个真实 claim。
8. 确认 Cigna 显示提交成功或提交 ID；如果缺少提交 ID，确认本地记录带 `submissionIdMissing` 警告。
9. 再次拖入同一天材料，确认该日期被本地账本阻塞，不会重复提交。

完成以上验收后，更新 `docs/VERIFICATION.md` 和 release manifest 中的真实 Cigna 验收状态，再发布新的 tag。
