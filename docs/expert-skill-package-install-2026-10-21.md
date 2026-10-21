# Personal Workbench 0.1.3：技能包合入与本机安装交接

2026-10-21 用户授权「合并并安装」，范围为已确认的专家技能包方案。本轮不推送、不创建公开 Release，不自动转换或清理日用专家/任务，也不变更 Provider、账户或模型设置。

## 已完成

- 本地 main 从 `49ab5dc9cabcead1bb1b489b4b4aec7576c2232a` 快进：功能提交 `d76f135ad`，版本提交/冻结构建源 `dbb0c4f1d`；完整 SHA 见下方本机 integration receipt。回退 ref 为 `codex/pre-skill-packages-main-20261021`。
- 原受检 97 项非 Markdown 输入与已保存 manifest 逐项 SHA-256 相同，复用原验收的完整六包 **17,786 通过、40 跳过**、浏览器 **38 通过**及静态检查。仅额外变更 Workbench build version 0.1.2 → 0.1.3，构建测试 21/21、格式检查通过；官方 package versions 和 Preview 不变。原真实 Provider 证据仍限定原验收范围，不宣称本轮新增模型回合。
- 审查授权 UI 范围：包管理、专家入口、固定身份技能发现/调用及任务目录回执，未加入无关视觉调整。
- macOS arm64 包构建、实际隔离产物启动、release smoke、解压包 strict/deep codesign 均通过。包内 version/buildVersion/flavor/commit 与冻结源一致；本机 ad-hoc 签名，无 Developer ID/公证，不代表公开发布资格。
- 首次额外启动 smoke 命令误传含空格的 `--executable-name`，参数校验拒绝、未启动产物；改用 macOS 自动发现可执行文件后通过。失败日志保留，未修改验证器。

| 产物                               | SHA-256                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| Personal-Workbench-0.1.3-arm64.dmg | `bb37aaedd4fd641f91fcd85d45597caaee1cdfbca794bd519acf7b1b27296862` |
| Personal-Workbench-0.1.3-arm64.zip | `8c3f652887730271e1dd17a83c7bbe986845c6a73ab487a09a7325b29094154b` |

## 安装交接与实际状态

当前助手由待更新应用托管，不能将中断自身会话后的结果预报为成功。已准备独立安装进程：启动后等待 90 秒，正常退出 Personal Workbench；若 90 秒内不能正常退出则阻止安装，**不强杀任务**。安装后结果只以本机 `installation-result.json` 为准；本文件不是已安装回执。

安装进程仅在旧应用和数据库均已关闭后获取原生数据库生命周期锁，然后：

1. 在私有目录备份完整 `~/.synara-workbench`、Electron profile 和一致性 SQLite，逐文件摘要与数据库 quick_check/表计数/schema 校验；保留旧 0.1.2 app。
2. 在隔离数据库副本启动 SQLite 迁移层，不启动 Provider/自动化；校验旧列数据逐行摘要不变、native ledger 不变、Expert ledger 5 → 6，新增 receipt 列为 NULL。演练失败不替换应用。
3. 安装受检 0.1.3 app，校验 asar 与签名并启动；核对新服务持有原 home 生命周期锁、`/health` 正常、原生迁移完成记录及 Expert 6 / Context 1 / native 135。
4. 对设置、凭据文件、专家定义及连接配置与备份逐文件比较。不自动转换旧技能配置。

本机私有证据根目录：`/Users/wangyuelin/.codex/task-artifacts/skill-package-install-2026-10-21/`。`installation-result.json` 的 `installed-and-started` 才表示实际安装及运行检查完成；`blocked-application-still-running` 表示需先结束运行任务，其他失败不得当作成功。`install-receipt.json`、`migration-rehearsal-verification.json` 与 `installer.log` 分别记录替换、数据演练和过程。备份计划目录为 `private-backup-0.1.2-before-0.1.3/`，包含私有资料，不上传。

## 恢复与缺口

- 0.1.3 增加 Expert ledger 6；回退 0.1.2 时先停止应用，保留故障后数据，再配套恢复旧 app、完整 home 和 profile，不能只换旧程序后直接写新数据。恢复点后的新增消息/配置不自动回填，需要单独保留。
- 含旧格式技能的专家和历史任务须完成单独确认的切换；安装本身不自动执行破坏性切换。普通项目、文件和账户不因安装被清理。
- Claude HTTP 401、Linux/Windows 实机以及人工视觉回放仍未验证。原实施记录保留原阶段状态，后续交付状态以本交接与实际安装结果为准。

功能、隔离转换和真实运行的详细范围见[实施验收](expert-skill-package-implementation.md)。

## 2026-10-21 安装重试与 GitHub 交付

用户再次明确授权本机安装 0.1.3 并更新 GitHub。原安装回执为 `blocked-application-still-running`，不是已安装成功。本轮在原生退出确认中正常退出应用，未强杀任务。

- 前两次重试分别被安装脚本的 Node TypeScript 参数属性解析、源码扩展名解析阻止，均发生在替换应用和迁移日用数据库之前。私有安装脚本修正为 Node 显式类型转换，迁移演练使用仓库锁定 Bun；失败日志与首次备份保留。
- 最终回执于 2026-10-21 10:04:19（Asia/Shanghai）记录 `installed-and-started`：本机 0.1.3 已替换并启动，原 home 生命周期锁与服务进程一致，health 通过，Expert / Context / native ledger 分别为 6 / 1 / 135。25 个受保护配置文件逐文件摘要一致，未转换日用专家定义。
- 数据库副本迁移演练、原有业务表内容摘要、native ledger 与新增 receipt 列检查通过。最终完整备份在私有证据目录的 `private-backup-0.1.2-before-0.1.3-retry/`，包含旧 app、home、profile 和一致性 SQLite；不上传。
- 源码已推送个人仓库 main；`workbench-v0.1.3` 指向冻结构建源 `dbb0c4f1d57fe742bcdb165dd33cd8aca08b6ca8`。该前缀不触发上游 Stable/Beta tag 发布。
- 个人 macOS arm64 预览包发布入口：[Personal Workbench 0.1.3](https://github.com/WYLINX601/synara--expert/releases/tag/workbench-v0.1.3)。DMG / ZIP 及 SHA-256、原始构建来源文件随包提供。上传保留原始 build-only 元数据，不改写为上游正式签名发布资格；没有自动更新 feed，也未验收远端 CI、Apple 公证、Linux/Windows 实机或新增真实 Provider 回合。

本节是后续授权及实际交付记录；上文“不推送/公开发布”和待安装说明保留原阶段语境。安装回执中的 pushed/publicRelease 字段只描述安装程序当时范围，GitHub 最终状态应以本节和远端为准。
