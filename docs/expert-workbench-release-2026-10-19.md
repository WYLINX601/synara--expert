# Personal Workbench 0.1.1 交付记录

日期：2026-10-19。来源：用户在了解 Claude 401 验收缺口后明确要求合入、安装和发布。本机现有日用应用为 `Personal Workbench` / `com.wylinx.workbench`；沿用个人 Workbench 本机交付通道。

## 来源与范围

- `main` 从 `9bceb21ddb7570affae013bd8657ffcc32096176` 快进至 `caf748a61eef9590348445668a15000233b410a0`，已推送 `origin/main`。
- 原工作区 26 项专家/MCP 修复与候选基线 `c8a1134bb` 的 tree 完全一致，经核对后保留并合入；原始 patch 和集成回执保存在本机证据目录。
- 版本只更新 `workbench/build-config.json` 的日用 Workbench build version：0.1.0 → 0.1.1；Preview 及上游 package versions 不变。
- 功能与 UI 范围沿用已确认方案：现有专家设置、选择、详情与兼容状态扩展至 Claude Code / OMP；没有新增页面或视觉重构。
- 本轮没有迁移、数据格式或应用身份变更。源码、运行与限制见[专家扩展验收](./expert-multi-provider-acceptance.md)。

## 检查与已知限制

应用/包源码与 `caf748a61` 相同，复用其 17,559 passed / 39 skipped、全仓格式/lint/类型、相关 browser、Windows runtime 和 Workbench 边界检查；发布版本与文档完成后执行对应补充检查。

OMP 真实读取、MCP、恢复和取消已通过。Claude CLI 2.1.296 原生插件/技能初始化已通过，但模型接口返回 HTTP 401 `authentication_failed`，完整真实回合未验收；用户在该限制已披露后要求继续交付，不将其改写为通过。包含固定技能的 Claude 专家要求 CLI ≥2.1.261，本机全局 2.1.92 保持不变。

## 构建、备份与安装

本轮交付正在执行。最终源 SHA、构建产物、签名性质、隔离启动、维护备份、安装后身份与数据核对将按实际结果回写。未完成项不视为安装或发布成功。

本机证据目录：`/Users/wangyuelin/.codex/task-artifacts/expert-install-release-2026-10-19/`。备份包含私有配置与凭据，仅留本机，不上传仓库或 CI。
