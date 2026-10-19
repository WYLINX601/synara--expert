# Personal Workbench 0.1.1 交付记录

日期：2026-10-19。来源：用户在了解 Claude 401 验收缺口后明确要求合入、安装和发布。用户选择“个人 Workbench：合入个人仓库并安装本机版本”。本机现有日用应用为 `Personal Workbench` / `com.wylinx.workbench`；沿用个人 Workbench 本机交付通道。

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

**本机交付完成：Personal Workbench 0.1.1 已安装并启动。**

| 项目       | 实际结果                                                                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 冻结构建源 | `48bbe61ed066b4eae6018fefac7140f0f5223c7a`                                                                                                                              |
| 应用身份   | `/Applications/Personal Workbench.app`；`com.wylinx.workbench`；arm64；`workbench` flavor                                                                               |
| 实际包内容 | 已读取安装后的 app.asar，version 0.1.1、source commit 与构建源一致                                                                                                      |
| 用户数据   | 继续使用 `~/.synara-workbench` 与原 `workbench` Electron profile；原 Space 和专家已显示                                                                                 |
| 补充检查   | 格式通过；lint 0 errors / 995 warnings；类型 7 workspace 通过；打包器 20/20；release smoke 通过                                                                         |
| 远端 CI    | 功能提交 `caf748a61` 的 18 项检查全部通过；[运行记录](https://github.com/WYLINX601/synara--expert/actions/runs/39186979933)。版本提交检查单独记录，不冒用功能提交的 SHA |
| 产物启动   | 真实 macOS arm64 包的依赖及隔离启动 smoke 通过                                                                                                                          |
| 签名性质   | 本机 ad-hoc 签名、strict/deep codesign 验证通过；无 Developer ID 签名/公证。provenance 保留 `unsigned-build-only` / `publication disabled` 的原始标记                   |
| 维护与备份 | 退出前全局 Tasks 为 0；正常退出，确认程序/数据库无打开进程后取得既有数据库 lifecycle lock；备份原 home、Electron profile、旧 app 和独立一致性 SQLite 副本               |
| 数据核对   | SQLite quick_check 与 85 张表的 row counts / schema 摘要一致；8 个专家、连接、凭据和设置文件 hash 不变；安装后由新服务重新持有数据库生命周期锁                          |
| 回退材料   | 本机证据目录的 `private-backup-0.1.0-before-0.1.1/`，目录权限 0700；未上传。回退需先停止新应用并核对数据兼容，不把应用回退等同于数据恢复                                |

个人版本标记为 `workbench-v0.1.1`，指向冻结构建源；它不触发上游 `v*.*.*` 的公开 Stable/Beta 发布流水线。本轮交付个人仓库源码、本机安装及本地安装包，不创建公开二进制 GitHub Release。

| 安装包                             | SHA-256                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| Personal-Workbench-0.1.1-arm64.dmg | `36f98755ca49cae7232c810394e39c9c246deade0ddc765a5bbaee1f943864b3` |
| Personal-Workbench-0.1.1-arm64.zip | `9e7389257c12105bbe92841d289c4ce5801473606d63f8d427b9cdf7fe3a72ff` |

原生组件和图标输入复用此前 v1.0.5 的本机已核查产物，相关源码在本次扩展中未变；输入副本及 SHA-256 保存在 `build-inputs/input-manifest.json`，构建清单另记实际采用的外部输入。没有安装 Xcode、升级 Provider CLI、修改账户/API/model 配置，或运行新的真实模型回合。

本机证据目录：`/Users/wangyuelin/.codex/task-artifacts/expert-install-release-2026-10-19/`。备份包含私有配置与凭据，仅留本机，不上传仓库或 CI。
