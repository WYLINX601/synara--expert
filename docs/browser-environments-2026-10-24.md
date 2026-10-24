# 浏览器日用与预览双环境历史记录

历史状态：2026-10-24 已被用户新确认的“桌面应用日用＋独立预览”取代。当前配置和安装结果见[应用与预览环境](application-preview-environments-2026-10-24.md)；19840 浏览器日用已停止，以下记录只保留旧双浏览器环境当时的实测与恢复证据，不作为当前操作入口。其后工作树、分支与备份整理见本文末尾。

原记录更新：2026-10-24（本机 Asia/Shanghai）。这是实际配置和恢复记录；流程规范见[日用、预览与应用版协作流程](workbench-development-workflow.md#browser-daily-preview)。不代表桌面应用安装、远端发布或审计修复已整体验收。

## 旧双浏览器环境状态（当时快照）

- 当时预览运行于 `19842`，后端为 `19841`；页面、原生 owner RPC、空闲停止及恢复等检查通过。此地址不作为当前操作入口。
- 当时日用运行于 `19840`，接续了 Personal Workbench 的一致性副本，保留原 13 条项目记录（含 3 条已删除记录）和 23 个线程。该浏览器日用现已停止，其原数据和固定产物作为历史回退记录。
- 当时按授权恢复了副本原有 Codex、Claude、Pi、OMP 和 1 个 Provider 实例开关；原模型与权限未变，3 个 Hub／Studio 暂停，4 个自动化停用。此为当时核对结果，不代表当前运行实例的状态。
- 原有 `5933 → 19541` 属于 Hub 隔离验收实例，不是日用来源；其归属与恢复材料按历史记录保留。
- 当时桌面入口为「Synara 浏览器工作台」；当前应用版本入口和服务状态见[应用与预览环境](application-preview-environments-2026-10-24.md)。

## 环境归属

共同管理根：`/Users/wangyuelin/synara-expert/.synara/browser-environments`（私有、Git 忽略）。

该目录含真实私有数据和恢复点，不参与 Git 清理。以下目录、进程和代码路径是旧双浏览器模式的当时快照；当前日用、预览和备份操作以[应用与预览环境](application-preview-environments-2026-10-24.md)为准。不得把历史表格中的工作树状态当作当前状态。

| 项目                | 日用                                                                                         | 预览                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 浏览器              | `http://127.0.0.1:19840`                                                                     | `http://127.0.0.1:19842`                                                                    |
| 后端                | `127.0.0.1:19840`                                                                            | `127.0.0.1:19841`                                                                           |
| 源码工作树          | `/Users/wangyuelin/.codex/worktrees/browser-daily/synara-expert`，`main`                     | `/Users/wangyuelin/.codex/worktrees/browser-preview/synara-expert`，`codex/browser-preview` |
| 固定源码基线        | `8f7143cf6f001aa495d57f0e3867a91c3cb9f351`                                                   | 同一基线 + 保留的未提交审计修复；不能视为已合入                                             |
| 实际执行代码        | 管理根下 `releases/8f7143cf6f001aa495d57f0e3867a91c3cb9f351/tree/apps/server/dist/index.mjs` | 预览工作树的 server 源码 + Vite                                                             |
| 应用 home           | 管理根下 `daily/home`                                                                        | 管理根下 `preview/home`                                                                     |
| SQLite 状态         | `daily/home/userdata/state.sqlite`                                                           | `preview/home/dev/state.sqlite`                                                             |
| 新建管理文件        | `daily/home/Managed`                                                                         | `preview/home/Managed`                                                                      |
| 开发目标 / 验收文件 | 自修改项目须指向**预览源码工作树**                                                           | `preview/workspace/Fixture`（新建隔离验收项目）                                             |
| 启动标签            | `local.synara.browser.daily`                                                                 | `local.synara.browser.preview.server`、`local.synara.browser.preview.web`                   |

`environments.json` 是本机路径与初始化状态的来源；LaunchAgent 位于 `~/Library/LaunchAgents`，私有副本在管理根 `launch-agents`。两边仅监听 loopback，继承的认证变量只从新建本地子进程移除；不修改其他实例的认证。现有 owner RPC 仍由服务端执行认证、审批和操作约束。

日用运行产物及依赖是独立 APFS 克隆，附源码提交、锁文件和构建文件 SHA-256 清单；不会读取预览的 `node_modules`，不跟随预览热更新。Bun / Node 使用本机 mise 固定路径，版本升级或旧版本被清理后应更新启动配置并重新演练。

目录隔离不等于安全沙箱。Provider 凭据仍由各 Provider 自己的全局目录管理；手选 Project、旧线程与工具可访问的绝对路径不会自动改写。不要在预览里对真实项目做写入验收。

首次接续仅将 3 个原启用的原生管理工作区（Studio、两个 Hub）复制到日用 `Managed`，并通过原生项目接口绑定副本；否则原路径不属于新环境的原生管理根。原目录和固定成果身份保留，普通手选项目不批量改路径。精确对应关系在私有 `daily-initialization.json` 与 `daily-workspace-bindings.json`。

## 当时的工作与来源保护（历史快照）

当时原始审计 checkout `/Users/wangyuelin/synara-expert` 位于 `codex/security-audit-integration`，未提交审计增量已复制并核验到预览工作树。此处记录的是当时分支状态；主目录现已回到 `main` 的 `8f7143cf6` 基线，当前代码整理和审计候选状态见[应用与预览环境](application-preview-environments-2026-10-24.md)及项目[上下文](../context/PROJECT_CONTEXT.md#当前工作树整理与候选状态-2026-10-24)。

搬迁前归档位于 `preserved-source-20261023`：二进制 diff、24 份源文件、原基线和 SHA-256 清单。管理目录支持提交 `c3dfb98c9` 与显式本地 owner 连接提交 `8f7143cf6` 当时已进入本地 main；不包含未验收的审计增量。“未推送、安装或发布”限定于当时记录的迁移范围，不表示其后未获授权；后续用户授权了工作区整理、合并和推送，实际结果由主会话核实回写。

## 备份范围与现有快照

手动备份：双击桌面的「备份日用数据」或「备份预览数据」。工具先确认没有运行中的线程/回合，正常停止对应服务，取得原生数据库生命周期锁，再做 SQLite 一致性备份及文件复制、验证，最后恢复原先运行的服务。存在活动任务、检查失败或锁冲突时拒绝继续，不使用强杀或隐式覆盖。

| 来源                                                                    | 已保存位置（管理根下 `backups/`）                    | 校验结果                                   |
| ----------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------ |
| 原 Synara `~/.synara/userdata`，18 项目 / 98 线程                       | `source-synara-2026-10-23T16-49-28-615Z-6d9c0c61`    | 39 条文件/链接记录，SQLite 与文件校验通过  |
| 原 Personal Workbench `~/.synara-workbench/userdata`，13 项目 / 23 线程 | `source-workbench-2026-10-23T16-49-29-120Z-984158f8` | 691 条文件/链接记录，SQLite 与文件校验通过 |
| 本次选用 Workbench 新快照，13 条项目记录 / 23 线程                      | `source-workbench-2026-10-24T04-30-45-961Z-a6722287` | 691 条记录，迁移前校验通过                 |
| 日用接续并恢复原开关后                                                  | `daily-2026-10-24T04-51-13-635Z-7c2a9b1c`            | 数据库、文件清单及 Managed 副本校验通过    |
| 本次全新预览                                                            | `preview-2026-10-23T16-49-32-011Z-adbb228d`          | 108 条记录，已用于最终真实恢复演练         |

早期演练发现同名文件过滤和 WAL 临时文件问题，已修复并重新生成上表快照；旧演练及较早快照原样保留在 `historical-snapshots`，附位置索引，不作为当前恢复输入。最终演练同时验证了同名 Managed 用户文件和恢复前副本均保留。

快照时间名采用 UTC，本机记录采用上海时间。备份目录 `0700`；文件保留 owner 执行位、去除 group/other 权限；清单验证路径、长度、SHA-256、权限和链接文本，数据库做 `quick_check`。运行时 PID、生命周期锁、WAL/SHM 等易失文件不作为恢复输入。排除规则只匹配原生状态文件的精确相对路径，同名 Managed 用户文件保留。源数据库以正常只读连接读取 WAL；只将备份目标转为 DELETE journal mode，验证时仅对已生成快照使用 immutable 只读连接，不对运行数据库使用该模式。

**覆盖**：对应环境整个应用 home 中的数据库、配置、附件、成果内容、日志和新建 Managed 文件。

**不覆盖**：home 外的项目源文件、原 Documents/Synara 管理目录、Provider 全局登录目录、系统钥匙串、外部 Git 主仓库及其未提交文件。已复制到日用 Managed 的 3 个工作区副本在日用备份范围内，原目录不在其中。符号链接仅保存链接文本，不跟随复制目标。原来源快照只备份 userdata，不是整个旧应用 base，也不是整台电脑备份。

旧项目路径已私有盘点于 `external-path-inventory.json`、`external-path-status.json`：Synara 共 19 个不同绝对路径、2 个当前不存在；Workbench 13 个、1 个不存在。本次已核对所选来源并复制 3 个原启用的管理工作区；缺失路径属于已删除的旧项目，未伪造文件。其他外部文件仍需独立备份，不能从数据库快照推断其正文已恢复。源运行盘点与本次接续记录另存私有目录；所有导入自动化停用，Hub 保持暂停，防止复制后续跑。

当前备份为同盘私有恢复点，不能防磁盘损坏。应将已验证的快照、运行版本清单和相应外部项目备份纳入现有 Time Machine 或加密外置盘；本轮未配置外部盘、上传云端或承诺灾难恢复。暂不自动清理快照；本轮完成时磁盘剩余约 12 GiB，批量新建大快照前检查容量。

## 恢复流程

私有配置恢复包位于管理根 `operator-kit-2026-10-24`，保存控制工具、启动描述、配置和检查证据及哈希清单；它不包含应用数据快照或外部项目，恢复时仍须核对绝对路径和对应版本。实际检查日志也已复制到管理根 `evidence`，不依赖 `/tmp` 长期留存。

1. 保存工作并处理活动任务；在外部终端或桌面停止入口正常停止目标环境。
2. 校验目标快照。普通恢复只允许同一环境、同一 home/state 归属，避免把预览库覆盖日用库；原来源副本的首次接续是单独初始化步骤。
3. 先生成恢复计划，确认来源、目标、日期及运行版本兼容性；默认不改文件。
4. 显式应用时，锁定数据库，保存整个当前 home 到相邻 `.pre-restore-*` 目录，再恢复快照；不移动正在持有的生命周期锁父目录。失败保留旧副本，必要时使用它回退。
5. 选择匹配的数据/代码组合，启动后核对项目、线程、成果和权限，再继续工作。发生迁移时不能只退代码而让旧代码读取不兼容的新库。

以下命令使用真实管理入口，替换 `<快照绝对路径>`；不含 `--apply` 时只输出计划：

```sh
/Users/wangyuelin/.local/share/mise/installs/bun/1.4.2/bin/bun run \
  /Users/wangyuelin/synara-expert/.synara/browser-environments/control.ts \
  --config /Users/wangyuelin/synara-expert/.synara/browser-environments/environments.json \
  verify-backup '<快照绝对路径>'

/Users/wangyuelin/.local/share/mise/installs/bun/1.4.2/bin/bun run \
  /Users/wangyuelin/synara-expert/.synara/browser-environments/control.ts \
  --config /Users/wangyuelin/synara-expert/.synara/browser-environments/environments.json \
  restore preview '<快照绝对路径>'
```

确认后在第二条命令末尾追加 `--apply`。恢复前保留的旧 home 不自动删除。

## 使用与更新

1. 在日用中选择「Synara 开发（预览源码）」提出改进任务；它已通过原生 Project 接口指向预览源码工作树。任务先核对基线和已有审计增量，避免覆盖未完成工作。
2. 在预览修改和验收；日用继续执行固定产物。更改后端源码需要正常重启预览 server，前端由 Vite 更新。
3. 通过相应检查、审查 diff、固定提交后，按授权合入 main 并生成新的固定 release 目录；核验版本与构建清单。
4. 保存日用工作、完成备份；由**外部启动器或终端**更换日用 LaunchAgent 的产物路径并重启，核对原日用数据。不要由依赖待重启后端的 Agent 自行执行最终切换。
5. 更新本记录与私有配置；保留旧产物、兼容的数据恢复点及外部维护入口。切换不等于桌面安装或发布。

## 旧应用版衔接设想（已被两角色流程取代）

以下是当时浏览器日用架构下的设想快照，已由当前“桌面应用日用＋独立预览”流程取代。当前应用配置、数据恢复和 Stable／Beta 边界见[应用与预览环境](application-preview-environments-2026-10-24.md)及[开发规范](workbench-development-workflow.md#browser-daily-preview)。

当前 `control.ts restore` 是同一环境的数据恢复，**不是日用 → 应用增量导入器**，不能用它覆盖已有应用数据。未来交付应用前，另行实现并验证来源／目标稳定身份映射、消息及固定成果版本去重、目标独有数据保留、双版本冲突、重复导入和失败重试回执；先备份两侧，导入的任务和自动化不得自动启动。首次迁移和后续增量导入尚未实现或验收。

本次已保留原始 Project／Thread ID、模型和成果来源，以及来源快照、运行提交、工作区映射和恢复回执，供后续迁移核对；这些记录不构成增量导入已可用的证据。

## 实测与剩余事项

| 检查                | 结果                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 管理目录配置        | 9 项测试通过；保持旧默认值、规范化路径、非法值先失败；server 类型通过                                                                  |
| 显式本地 owner 连接 | 5 项测试通过；默认仍要求 token，远端/含用户凭据/片段/错误协议被拒绝                                                                    |
| 管理工具            | 12 项真实 SQLite/文件/锁/恢复/端点测试通过，格式和定向类型通过                                                                         |
| 日用候选门禁        | fmt、lint（0 错误 / 1072 警告）、7 包类型、边界、Windows 静态检查通过；browser/server 构建成功                                         |
| 固定日用产物演练    | 19843 临时 home 启动 ready，HTML 200；SIGTERM 后 30 秒内退出，实际退出码 130，未强杀；不代表桌面包验收；所选真实数据副本的接续另列下行 |
| 预览运行            | UI 已连接，隔离项目可见；原生 RPC、受保护停止、恢复后启动与重复启动 PID 不变已验证                                                     |
| 恢复演练            | 默认计划不改文件；显式恢复成功，恢复前 marker 留在 `.pre-restore-*`，数据库校验通过                                                    |
| 日用真实数据接续    | 原 13 条项目记录、23 线程及模型／权限保留；新增开发项目绑定预览；原 3 个 Hub 暂停、4 个自动化停用；原生 RPC 与浏览器已连接             |
| 日用恢复演练        | 在独立临时副本上完成默认计划、显式恢复及旧 home 保留验证，未覆盖运行中的日用数据；恢复原开关后另取最终备份                             |
| 预览审计依赖        | frozen-lockfile / ignore-scripts 同步成功；实际 TOML/隔离配置 35 项通过；完整审计测试仍待完成                                          |

私有实际证据：`daily-readiness.json`、`daily-migration-verification.json`、`daily-provider-restoration.json`、`daily-data-restore-rehearsal.json`、`preview-readiness.json`、`restore-rehearsal-final.json`、`daily-rehearsal/result.json`、`releases/<ref>/manifest.json`。源码检查日志位于本机 `/tmp/synara-browser-*.log`，不是永久备份依据。

**当时可用范围**：浏览器日用与预览启动、数据隔离、备份和恢复在旧双浏览器架构下完成。之后已安装桌面日用应用，当前状态见[应用与预览环境](application-preview-environments-2026-10-24.md)。旧记录中的“未完成应用打包安装”只描述当时；当前安全审计仍有 MCP 测试超时待修复，完整验收未完成。审计台账见[审计接入台账](security-audit-2026-10-23/README.md)，相关审计四份文件待主会话同步后复核链接。

## 2026-10-24 后续工作区与备份整理

- 主目录当前代码基线为 `main` / `8f7143cf6f001aa495d57f0e3867a91c3cb9f351`；当前预览工作树及桌面日用应用的信息以[应用与预览环境](application-preview-environments-2026-10-24.md)为准。
- 31 个旧分支已移动至 `refs/archive/workspace-consolidation-20261024/*`；旧 `expert-skill-packages`、`browser-daily` 工作树已安全移除。另 3 棵旧工作树因当前 ChatGPT 持有 Electron 资源锁而保留，其后台已确认 idle 并停止，待锁释放后再清理。
- 5 份失败复制和 10 份经核验完全相同的重复备份已去重；6 个恢复点保留。仅升级前旧 userdata 备份已同 inode 移至管理根 `application/rollback/userdata.pre-0.1.5-20261024T055108Z`，不再留在 `~/.synara-workbench`；活跃 `~/.synara-workbench/userdata` 保持原路径不动。
- 安全审计候选仍待合入，当前还有一个 MCP 测试超时待修复；完整门禁未通过，不记录为已合入、已推送或全绿。10 月 24 日早先“未推送”是当时范围的状态；用户随后授权整理、合并和推送，实际结果待主会话补录。
