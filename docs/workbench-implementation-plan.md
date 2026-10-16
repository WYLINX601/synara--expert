# 个人工作台落地技术方案与实施计划

状态：本文件保留 2026-09-29 制定的计划与实施起点快照；当前进度与验收见[工作台验收记录](./workbench-acceptance-2026-10-02.md)。本轮工作涉及 WB-00 至 WB-05，WB-06 按用户决定延期；各项完成状态以验收记录为准。

后续日常开发遵循[工作台开发流程](./workbench-development-workflow.md)：按改动影响选择检查，在集成和交付阶段集中验收。本计划的首次升级矩阵及既有验收记录继续适用于其声明范围，不作为每次界面修改的固定步骤。

后续 WB-03 接入边界的增量设计见[轻量适配层与 UI 模块化方案](./workbench-adaptation-plan.md)（2026-10-08，首期已完成，见[验收记录](./workbench-adaptation-acceptance.md)）。阶段 A0—A4 以现有专家 / 全局 MCP 候选稳定为前提，首期收拢 UI 入口、业务请求与依赖检查；不推进本计划已延期的 WB-06，也不更改官方同步门禁。

当前实施快照（2026-10-03）：source ae 的双 flavor payload、隔离、恢复、8 项真实 runtime、10 项绑定和正式六项门禁均已通过，六个 workspace 测试合计 13,189 passed、36 个既有 skip；WB-00 至 WB-04 在 macOS arm64 本机隔离范围为 READY/M1/M2 通过。PR #1 已合入 GitHub `main`（merge `61df29b`），候选 exact-head CI 24/24 通过，合并后 `main` 的五个 push workflow 均成功。按用户最新决定，本轮不手动同步官方当前稳定版、不更新上游基线，也不手动触发 workflow。M3 的真实 manual CAS publish 与独立 scheduled run 尚未验收。周同步 workflow 保持启用并按周运行；当前锁文件仍把 v0.9.2 记为未集成，下一次计划运行是 2026-10-10 10:30（Asia/Shanghai）。WB-06 延期。详细边界见[工作台验收记录](./workbench-acceptance-2026-10-02.md)。

日期：2026-09-29。适用仓库：当前 Synara Expert fork。
上位设计：[工作台架构](./workbench-architecture.md)。既有能力：[专家方案](./expert-product-technical-design.md)。

## 快速导航

- [交付目标与范围](#1-交付目标与范围)
- [实施决策](#2-实施决策)
- [任务与依赖](#3-任务与依赖)
- [数据库升级方案](#4-数据库升级方案)
- [模块接入方案](#5-模块接入方案)
- [每周同步工具与调度](#6-每周同步工具与调度)
- [验证与发布](#7-验证与发布)
- [未来看板接入](#8-未来看板接入)
- [实施检查清单](#9-实施检查清单)

## 1. 交付目标与范围

第一轮交付是一个可持续升级的个人工作台底座：当前专家能力继续可用，原生能力有回归验证，自定义应用与原版隔离，完成一次真实的官方版本集成，并建立每周候选更新流程。看板等新产品功能在此基础上继续增加。

计划制定时尚未执行提交、配置远端、迁移数据、安装新应用、推送或启用定时任务。以上为 2026-09-29 的历史记录，不代表当前进度；当前验收状态见[工作台验收记录](./workbench-acceptance-2026-10-02.md)。

截至 2026-09-29 核实的初始实施起点（历史快照）：

| 项目       | 状态                                                                            | 实施影响                                                         |
| ---------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Git        | `main` 基线为 `eaa61eded31b6755d4f30ba8eabc5d905cf817cb`；浅克隆；仅配置 origin | 先保存自定义改动、补齐历史和验证所需发布标签                     |
| 自定义代码 | 专家能力有大量未提交文件                                                        | 不能直接在活动工作区执行周同步                                   |
| Node / Bun | 当前为 22.23.1 / 1.4.0；[.mise.toml](../.mise.toml) 要求 24.13.1 / 1.4.2        | 验收使用仓库锁定工具链，避免环境差异造成误判                     |
| 数据迁移   | 旧专家版本曾使用官方序列中的 109、110；当前官方 catalog 截止 108                | 新库使用独立工作台 tracker；旧历史只按冻结身份与 schema 精确接管 |
| 备份与锁   | 已有独占锁、迁移快照、中断恢复                                                  | 扩展现有机制，不从应用外并发连接活动数据库                       |
| 平台证据   | 专家旧记录包含 macOS 实测；Linux/Windows 仍有待实测项                           | 新版本重新验收；旧记录不能替代本次候选验证                       |
| Git 网络   | 本会话早先访问 GitHub 受本机代理连接失败影响                                    | WB-00 重新核实，失败只阻塞联网步骤                               |

分阶段状态（2026-10-02；以下是按来源汇总的已观察结果，不替代当前 sync 状态）：

| 工作包 | 已有证据                                                                                                                                                                                                                                     | 尚未完成                                                                                                                                                                                                                                       |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WB-00  | [完整历史与 upstream 标签补充](../workbench/WB-00-upstream-evidence.md)记录 422 个上游 heads、92 个 `v*` tags，仓库不再是 shallow；`migrations:check` 检查全部发布标签通过。                                                                 | WB-00 基线工作完成。原基线全量测试记录中两项受并行/时序影响的失败及单项重跑通过结果仍保留；不将其写成全量套件全绿。                                                                                                                            |
| WB-01  | 858 和 f248 的 macOS arm64 两 flavor 诊断包、bundle/plist、payload、三应用共存和 updater-policy 均有独立通过证据；使用外部图标输入，不能代表源码可复现。                                                                                     | 有 ad-hoc 本机签名；无 Developer ID 签名、公证、安装或发布。后续源码必须重新构建并核对身份。                                                                                                                                                   |
| WB-02  | 858 和 f248 各自的三项合成 file-backed SQLite 场景均有通过证据；前两项 pinned Bun，第三项由打包 Workbench Electron 43.4.1 的 Node mode 执行 restore CLI。                                                                                    | 未访问用户数据库；普通 Electron 启动迁移/升级未验证。任何源 SHA 的通过记录都不代替另一 SHA 的运行。                                                                                                                                            |
| WB-03  | 专家注册、runtime 接线、边界检查和 probe 已集成。858 后续尝试的 Codex 普通首轮通过、专家首轮超时；f248 上 Codex/Pi 普通与专家首轮、MCP、产品 session/persona isolation 通过，模型为 `gpt-6-luna/high` 与 `openai-codex/gpt-5.6-sol/medium`。 | f248 cancellation 失败、recovery 未运行。de287 有界 HTTP cancel-drain 修复在三个服务端文件通过 25 个目标测试、scripts fixture 通过 3 个目标测试；尚无完整门禁/build/live 重验；原生 Provider session ID 未由 RPC 证明。                        |
| WB-04  | f248 六项固定门禁、两种 macOS arm64 诊断构建、隔离启动、payload/身份、三应用/updater-policy 和合成迁移/restore 均按限定范围通过。详见[运行证据页](../workbench/WB-04-runtime-preflight.md)。                                                 | f248 cancellation 失败且 recovery 未运行，十项 runtime evidence 未全部通过并绑定；该轮为 `awaiting-runtime`。截至本文记录，branch HEAD 为 de287、generated state 仍绑定 f248；须核对 checkout HEAD、state `candidateSha` 和 evidence binding。 |
| WB-05  | workflow/helper 已集成；9591 合成 Git fixture 因占位 base 以 `bind-rejected` 失败，858 只修正 fixture 元数据后本地 fixture 通过；生产 bind/CAS guard 未削弱。详见[自动化记录](../workbench/WB-05-automation.md)。                            | 未推送、未手动 dispatch、未定时运行；远端 branch write、artifact 保留和计划降级均无实际运行证据。                                                                                                                                              |
| WB-06  | 看板保持在架构草案中。                                                                                                                                                                                                                       | 按用户决定延期，不在当前授权范围内实施。                                                                                                                                                                                                       |

官方候选锁、已集成基线和三者 merge-base 的准确关系见 [WB-00 upstream evidence](../workbench/WB-00-upstream-evidence.md)。fee08、9591、858 与 f248 的结果分别保留在来源对应的记录中；9591 证据页保持原文。门禁、诊断构建和合成 restore 不代表 M1/M2/M3 完成，也不能把已通过的部分 Provider 检查解释为 cancellation/recovery 通过。

858 和 f248 的诊断/合成验收均有各自来源记录。startup smoke 设置了 `SYNARA_DISABLE_AUTO_UPDATE=1`，updater 策略由单独的变量 unset 身份运行验证。本机 ad-hoc 签名不等于 Developer ID 签名；这些检查也不等于公证、安装、发布或普通 Electron 启动迁移，且不覆盖 Linux/Windows。fee08 的 Codex `gpt-6.1-sol/high` 普通首轮请求因模型不受支持返回 HTTP 400；9591 没有 Provider 请求。858 的初始诊断验收轮没有 Provider 请求，另有后续 live attempt：Codex 普通首轮通过，专家首轮 provider approval 未完成后超时，其余请求未运行。f248 后续明确使用 Codex `gpt-6-luna/high` 与 Pi `openai-codex/gpt-5.6-sol/medium`，部分运行结果见 WB-04 preflight。不得用这些历史结果代替后续源码 SHA 的实时验证。

## 2. 实施决策

1. **同仓库模块化扩展**：复用 Synara 的 server、Web、desktop、contracts；保留 Provider Adapter 的专有行为。
2. **保持现有产品行为**：第一轮提取必要接入点，保留专家语义；不同时重写任务系统、整个 Sidebar 或 Provider 生命周期。
3. **独立应用身份**：自定义日用版和候选版与原版分别设置 bundle ID、scheme、Electron profile、应用 home 和更新策略；复用现有身份解析和构建机制。
4. **独立迁移记录，同一事务体系**：新增工作台业务表采用 `wb_` 前缀；迁移记录使用 `workbench_sql_migrations`。现存专家列/表先保留物理结构，登记为已知接入点；无需为了改目录或前缀搬迁用户数据。
5. **每周集成稳定版本**：默认合并最新非预发布版本的固定 SHA；候选创建后不追逐官方 HEAD。自己的长期分支使用 merge。
6. **自动准备、验证后安装**：首版周任务自动检查、准备可合并的候选及检查报告；冲突进入待处理状态，生产安装在空闲维护窗口执行。
7. **先跑通本地工具，再接调度**：核心同步逻辑为可重复执行的仓库脚本；推荐 GitHub Actions 每周触发，与 Synara 运行状态无关。本机保留相同命令作为手动入口。

应用暂用中性名称 `Personal Workbench`，正式显示名称在身份配置中集中设置。用户数据路径由该身份和现有配置解析，脚本不能硬编码当前用户目录。

WB-01 默认身份方案如下，实施时统一接入现有身份定义、打包和运行解析，避免多处常量不同步：

| 字段                  | 日用版                 | 候选版                         |
| --------------------- | ---------------------- | ------------------------------ |
| flavor                | `workbench`            | `workbench-preview`            |
| 显示名称              | Personal Workbench     | Personal Workbench Preview     |
| bundle ID             | `com.wylinx.workbench` | `com.wylinx.workbench.preview` |
| URL scheme            | `workbench`            | `workbench-preview`            |
| Electron profile 名称 | `workbench`            | `workbench-preview`            |
| 默认应用 home 名称    | `.synara-workbench`    | `.synara-workbench-preview`    |
| 首版更新方式          | 固定提交的自用脚本构建 | 固定候选提交的隔离构建         |

打包后的身份继续由构建时确定，不能靠启动环境把原版安装包变成工作台。WB-01 同步覆盖 URL/origin、单实例锁、后端 home 传递、更新缓存与平台身份测试；品牌检查仅对明确的自定义身份做适配，不进行全仓库字符串替换。首次导入原实例数据采用受控的一次性副本，不共用活动目录。

## 3. 任务与依赖

按可独立验证的工作包推进，每个工作包形成明确提交边界和验收记录。主路径为 `WB-00 → WB-01/WB-02 → WB-03 → WB-04 → WB-05`；WB-01 与 WB-02 完成后共同进入真实升级验收。看板 WB-06 在底座通过首次升级后开始。

| 工作包               | 具体交付                                                                          | 改动位置                                                                                                                                                                                                                                                                                | 完成条件                                                                 |
| -------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| WB-00 基线与环境     | 专家改动清单与可恢复提交；upstream；完整历史与标签；工具链；运行实例/数据位置盘点 | [基线记录](../workbench/WB-00-baseline.md)、[上游历史补充](../workbench/WB-00-upstream-evidence.md)、`workbench/upstream.lock.json`                                                                                                                                                     | 能复现当前版本；共同祖先已确认；记录现有失败与平台缺口                   |
| WB-01 应用与数据隔离 | 自定义日用/候选身份；独立 home、profile、端口；脚本更新模式                       | [desktopIdentity](../packages/shared/src/desktopIdentity.ts)、[desktop main](../apps/desktop/src/main.ts)、[构建器](../scripts/build-desktop-artifact.ts)、[WB-01 证据](../workbench/WB-01-evidence.md)                                                                                 | 原版和工作台可并存；实际构建的身份与更新策略正确；候选不占用日用数据     |
| WB-02 迁移归属与恢复 | 扩展 migrator；旧 109/110 精确接管；统一备份/恢复计划；双 schema 版本检查         | [SQLite 装配](../apps/server/src/persistence/Layers/Sqlite.ts)、[官方迁移目录](../apps/server/src/persistence/Migrations.ts)、[备份/恢复](../apps/server/src/persistence/MigrationBackup.ts)、[Workbench persistence](../apps/server/src/workbench/persistence/WorkbenchUpgradePlan.ts) | 历史样本、崩溃重试和恢复测试通过；官方与自定义迁移不再竞争编号           |
| WB-03 收拢接入       | 工作台入口注册、专家服务装配与依赖清单；接入边界检查                              | [workbench runtime](../apps/server/src/workbench/runtimeLayer.ts)、[RPC](../apps/server/src/wsRpc.ts)、[注册表](../apps/web/src/workbench/registry.ts)、[边界检查](../scripts/check-workbench-boundary.ts)                                                                              | 原生与专家行为不变；新模块可通过集中入口接入；没有新的执行器             |
| WB-04 首次真实同步   | 同步脚本；固定官方候选；冲突适配；隔离构建；真实运行及恢复演练                    | [sync CLI](../scripts/workbench-sync.ts)、[`workbench:sync`](../package.json)、[build manifest](../scripts/workbench-build.ts)；复用现有测试、构建和恢复工具                                                                                                                            | 官方 SHA、自定义 SHA、检查和实测证据对应同一候选；形成可安装版本         |
| WB-05 每周自动准备   | 每周 workflow、并发控制、重复运行处理、候选报告、失败恢复入口                     | [weekly workflow](../.github/workflows/workbench-weekly-sync.yml)、[helper/tests](../.github/scripts/workbench-weekly.mjs)、[自动化记录](../workbench/WB-05-automation.md)                                                                                                              | 手动触发及一轮真实定时触发均有证据；同一候选不重复；不会自动替换日用程序 |
| WB-06 业务看板       | WorkItem/线程关联、最小页面与“交给专家”操作（按用户决定延期）                     | 拟新增 `workbench/features/boards/`；复用 [原生 Kanban](../apps/web/src/components/kanban/KanbanView.tsx) 的适用组件                                                                                                                                                                    | 事项与执行状态分开；崩溃重试不重复创建任务；进入下次周同步验证           |

WB-00 的提交前先审查代码、运行产物、密钥和机器路径，按实际依赖整理提交；本地提交与远程推送分别执行。若其他工作仍在修改当前目录，先明确文件归属并保存基线，再在独立工作区实施。

三个验收里程碑：

- **M1 可安全演进**：WB-00～WB-03 完成，现有专家可用、数据可恢复、应用隔离成立。
- **M2 可真实升级**：WB-04 完成，至少一次官方更新后的原生与专家链路在实际应用中通过。
- **M3 可按周维护**：WB-05 完成，每周任务能形成可追踪候选，失败有明确处理入口。

工期按 WB-00 取得的代码基线、数据库样本和构建耗时重新估算。WB-02、首次冲突适配与原生构建是主要不确定项；不以未经实测的“几分钟自动升级”作为排期前提。

## 4. 数据库升级方案

### 4.1 最小物理改动

第一轮保留 `projection_threads.expert_binding_json` 和 `expert_applied_runtime_records` 的已有存储结构与读写路径。它们登记为工作台拥有的历史扩展，接受每次上游 schema、投影重建和清理变化的回归验证。新看板数据使用独立 `wb_` 表。

专家绑定仍随原有事件与投影持久化，保留创建、fork/handoff、恢复和重放语义。未来确有列冲突或多模块需求时，再单独评估把扩展投影迁到旁表；本轮不叠加该搬迁。

已新增的 server 文件职责（目录前缀为 `apps/server/src/workbench/persistence/`）：

| 文件                               | 职责                                                            |
| ---------------------------------- | --------------------------------------------------------------- |
| `WorkbenchMigrations.ts`           | 静态扩展迁移清单、顺序执行和版本检查，复用现有 Effect/SqlClient |
| `LegacyExpertMigrationAdoption.ts` | 纯识别计划与受控接管，精确匹配旧 109/110 身份和 schema          |
| `WorkbenchUpgradePlan.ts`          | 汇总官方升级、自定义升级、历史接管和备份要求                    |
| 对应测试                           | 验证历史身份、事务、失败恢复、过新版本与数据保留                |

代码状态：Workbench ledger 与只读升级计划，以及 SQLite 启动/备份/恢复共享计划的接线，已集成。fee08 上的聚焦测试记录和三场景演练保留在历史证据归档；fee08 的第三场景当时使用 pinned Node。9591 的后续演练中，成功启动和故障后复用同一备份重试由 pinned Bun harness 执行；built restore CLI 场景使用打包 Workbench Electron 43.4.1 的 `ELECTRON_RUN_AS_NODE=1`，exit 0。858 与较后的 f248 各自独立通过三个合成 file-backed SQLite 场景：前两项由 pinned Bun harness 执行，第三项由实际打包 Workbench Electron 43.4.1 的 Node mode 执行 restore CLI 并 exit 0。858 的 raw rehearsal report 和 audit hashes 及运行范围见 [WB-04 858 证据](../workbench/WB-04-858-evidence.md)；9591 报告见 [WB-04 9591 证据](../workbench/WB-04-9591-evidence.md)，f248 范围见 [WB-04 runtime preflight](../workbench/WB-04-runtime-preflight.md)。各轮均使用合成数据，不涉及用户数据库；Node mode 下运行 CLI 不证明普通 Electron 启动迁移或活动用户库已验证。

`workbench_sql_migrations` 的计划字段为 `module_id`、`migration_id`、`name`、`checksum`、`applied_at`，主键为 `(module_id, migration_id)`。同一模块的历史记录必须构成有效前缀，已执行脚本不可改名、改号或修改校验内容。另设工作台数据格式版本，拒绝当前程序不能解释的版本。优先使用现有 migrator 可支持的表配置；不足的部分写局部适配，不增加新的数据库框架。

### 4.2 启动执行顺序

1. 通过已有 DatabaseLifecycleLock 获得独占权，检查恢复标记，再建立现有 SQLite 连接。活动恢复重用原备份，不重新快照部分升级库。
2. 在任何迁移写入前，只读检查官方 tracker、扩展 tracker、格式 metadata、实际 schema 和版本。一个纯计划同时决定拒绝原因、备份需求与执行目标；官方过新仍通过 `MigrationSchemaTooNewError` 进入桌面诊断。
3. 官方、扩展、格式或精确历史接管任一项变化时，对非空库创建 SQLite 一致性快照并先持久化 v2 恢复标记。全新空库不创建无意义备份。
4. 仅对白名单中的旧专家历史，在事务内写入扩展迁移接管记录并移除对应的官方 tracker 项。此步骤在快照之后、官方 migrator 之前执行；失败则事务回滚。
5. 执行官方迁移，再执行工作台迁移；扩展 schema 变化与对应 tracker 写入保持同事务。
6. 启动前核实官方、工作台 tracker 与格式版本均达到计划目标，旧专家官方 tracker 项已清除。文件库和内存库共用这一初始化路径。

官方已有 imported-lineage 显式 consent 保持不变：只读计划先生成原 challenge；未提供匹配 token 时不创建备份、不写恢复标记，也不执行迁移。接管白名单不会放宽未知专家历史、未来官方版本或未知格式的检查。

### 4.3 109/110 的接管规则

当前官方迁移 catalog 独立于冻结的专家历史，官方版本以 catalog 最大迁移 ID 表示，完整官方前缀仍按 catalog entry 顺序校验。旧专家 ID 109/110 不再位于官方执行列表；lineage gate 只允许这两个精确历史身份继续被解释。

- 只认精确 tracker 二元组 `(109, "ProjectionThreadsExpertBinding")` 和 `(110, "ExpertAppliedRuntimeRecords")`；文件名前缀不是 tracker 的 name。
- 同时校验官方前缀、必需列/表及数据结构；不能仅看到编号就判定属于我们。
- 只有 109 的合法中间态可接管，后续补做缺少的扩展迁移。109/110 都没有时走正常扩展初始化。
- 部分 schema 已存在但 tracker 缺失的状态需明确识别为可安全补记或拒绝；不以 `IF NOT EXISTS` 隐藏不兼容结构。
- 未知 name、未知更高扩展版本、官方前缀无法解释时停止升级，保留诊断。
- 接管后的扩展记录使重跑成为无操作，不重复备份覆盖原始恢复点。
- 旧自定义程序无法识别拆分后的迁移历史；默认视为跨越回退边界，恢复旧程序必须使用配套旧数据备份，除非另有实测兼容证据。
- imported divergence 与 109/110 同时出现，或官方前缀不是冻结的 1..108 时，不借用官方 consent 接管专家历史；保持数据库和恢复文件不变，要求人工修复后再升级。

v2 恢复记录记录官方、工作台和格式的源/目标版本、旧历史身份和原备份对应关系。v1 pending marker 只在原备份、精确旧 source/target 和当前 live 进度都可解释时，才原子转换为 v2；转换保留原备份路径、尝试预算和完整 v1 provenance，然后继续完整工作台升级。未知状态保持 marker 不变并 fail closed。通用官方迁移调用仍兼容 v1 原行为。扩展迁移失败时复用同一恢复点；不能在重启时把部分升级库当作新的正常基线。仅扩展变化、旧 109/110 接管和扩展版本过新都必须进入备份/恢复测试。

恢复校验分别核对官方、工作台和格式版本。当前官方 catalog 截止 108 时，精确旧 109/110 由冻结识别器解释并映射到工作台 lineage；任意其他官方超新、扩展超新、格式超新或未知历史仍在写入前拒绝。新恢复记录使用 v2 双版本身份；v1 只接受可证明的旧 canonical 目标或精确冻结专家历史。

正式 SQLite 装配和内存测试库共用完整工作台初始化。直接调用官方 migrator 的测试继续明确验证官方部分；依赖专家 schema 的测试使用完整工作台初始化，避免只在产品入口加迁移导致测试路径与实际启动分叉。

### 4.4 数据验收矩阵

| 样本/故障                               | 必须证明                                                    |
| --------------------------------------- | ----------------------------------------------------------- |
| 全新空库                                | 官方及扩展 schema 按序建立，普通任务与专家任务均可用        |
| 旧官方库，无专家历史                    | 原任务保留，扩展初始化正确                                  |
| 只有旧 109；旧 109+110                  | 接管准确，已有绑定、运行记录与快照内容不丢失                |
| 同编号不同 name；未知更高版本           | 拒绝写入，不触发错误重放                                    |
| 仅有新的扩展迁移                        | 仍创建备份并记录恢复点                                      |
| 接管提交前后、官方/扩展迁移中断         | 重启可解释状态，重试无重复，原恢复点保留                    |
| 投影重建、thread 硬删除、恢复与 handoff | 专家绑定与清理语义正确                                      |
| 从备份恢复                              | 数据、tracker、专家快照与目标程序对应，WAL/SHM 无旧状态回放 |

真实数据库只在明确的维护窗口生成一致性副本，用副本验收；本轮计划没有访问或停止当前日用数据库。

<a id="v101-compatibility-proposal"></a>

### 4.5 v1.0.1 升级前置兼容方案（已确认，待实施）

2026-10-16 的隔离核对确认，固定上游 `v1.0.1` / `f44ce959bdeedf5e2dfe117d362ef4e08386b3c3` 使用 `111_GroupLibraryHosting`；当前 Linx 使用冻结的 `111_ContextV1`。二者不能占用同一原生 tracker 的同一 ID。用户随后明确允许推进精确兼容方案与隔离测试，批准在升级候选中调整“111 保留原生 tracker、不接管”的策略。本节是已确认的实施方向，尚无对应实现或迁移验收；当前 main 的迁移代码未变，也不授权生产迁移。

拟调整为：保留旧 `111_ContextV1` 的身份、路径、原始脚本摘要和来源证据；在未来升级版本中，把它从活动的原生 catalog 中退出，Context 通过既有 `workbench_sql_migrations` 的独立 `(module_id: context, migration_id: 1)` 登记。上游原生 109/110/111 及之后的名字、编号和脚本按固定上游保留；不改号，也不把上游迁移作为 Linx 扩展执行。现有 Expert ledger 记录不重写。

1. **只读识别先于写入**：只承认精确的旧 `111 / ContextV1`、可核验的官方前缀、现有 Expert 历史，以及七张 Context 表与四个投递账本列的预期 schema。保留 `data_instance_id`、配置 revision、快照、运行记录和命令回执。未知身份、结构不符、双重登记或部分接管状态明确拒绝，不按 ID 单独白名单放行。
2. **备份后原子接管**：沿用宿主连接、统一升级计划和恢复点；备份成功后，事务内登记 Context ledger、保留旧记录的审计来源并移除精确旧 tracker 项，再执行官方迁移和扩展迁移。正常重启与失败重试不能重复执行或丢弃原恢复点。
3. **新库和已升级库分开验证**：新库执行上游原生 catalog，并通过 Context 独立 ledger 建立同一 schema；已有正确 Context ledger 的库只验证，不重复初始化。复用冻结脚本时登记具体的宿主持久化接入，不为目录豁免；不得复制后悄悄改变历史脚本。
4. **检查规则随已确认策略调整**：实施时把强制“当前 catalog 必含旧 111”的检查改为“冻结历史文件与精确旧身份 + 官方 catalog 来源 + Context ledger 归属”，保留未知迁移、脚本编辑和缺少来源的拒绝。已有 109/110 精确兼容逻辑也须在官方已复用这些槽位的 catalog 下复验。
5. **验收覆盖恢复边界**：使用合成旧库验证合法旧 111、未知同号身份、缺表/列、冲突记录、新库、重复启动，以及接管前后、官方迁移和扩展迁移中断；证明数据库、相关状态与应用版本可配套恢复。升级后不保证旧应用可直接打开新库，回退使用已验证的完整恢复点。

实施先在隔离升级候选中进行，不能只删除当前 main 的冻结检查以消掉迁移冲突；用户数据库、日用应用和远端发布仍不在自动执行范围。实际恢复现场与上游冲突见 [WB-05](../workbench/WB-05-automation.md#maintenance-root-cause-20261016)。

## 5. 模块接入方案

### 5.1 第一轮收拢范围

- Web 新增 `apps/web/src/workbench/registry.ts`，静态声明模块 id、设置入口和必要页面入口；继续使用 TanStack 的类型化文件路由。路由文件仅转接到模块组件，不运行时拼装未知页面。
- server 新增 `apps/server/src/workbench/runtimeLayer.ts`，集中装配扩展服务；`host/` 封装确实跨模块复用的原生调用。先把 `wsRpc.ts` 中可以独立的专家服务装配与业务处理移出，保留其作为 RPC 注册入口。
- 专家实现仍放在现有 `apps/server/src/experts/`；复用现有 settings、picker、详情组件，无需为统一目录复制一份。
- 新增协议仍在 `packages/contracts`，沿用当前导出/构建约定。contracts 当前只有根导出，不能假定新增目录天然可作为包子路径导入；确需子路径时连同 package exports 和打包入口一起处理。
- 建立接入点清单，覆盖 RPC、导航、会话建立前、恢复、Gateway、投影与持久化；清单每项附职责和相关测试。

### 5.2 必须保留的运行约束

专家解析与固定快照在实际会话启动前完成；必需资源失败时阻止启动。恢复按任务原快照重新应用，不能重新读取最新模板。Provider-specific 注入留在现有 Adapter，工具目录和连接继续按 session/generation 管理。

新模块使用现有任务查询和命令服务；不直接改原生线程状态、不建立第二个 Provider 事件消费者、不扩大已有授权。看板状态通过已有投影/快照适配，断线后补齐。

模块开关关闭新的入口与调用，不跳过必要迁移或破坏已有专家任务。能力缺失应返回明确的不可用状态，不能悄悄用普通任务替代。

### 5.3 防止后续改动扩散

拟新增边界检查只约束自定义目录的危险依赖：原生数据库写入、Provider 运行控制和任务内部实现应走明确接入点。复用基础 UI、公共类型和 shared 工具正常允许。第一版可以采用现有 lint 的定向规则或一个小型检查器，依据仓库现有工具选择；不建立完整插件框架。

通过标准：专家页面、启动、恢复、MCP 和普通任务回归通过；新增模块的业务代码主要留在自定义目录；原生文件的新增改动都有具体接入理由和验证。

## 6. 每周同步工具与调度

<a id="sync-sop"></a>

### 6.0 当前升级执行 SOP（v1.1，2026-10-16）

来源与状态：用户确认执行二开 v1.1。本节是后续升级的操作入口；第 6.1 节保留实际命令与状态语义，第 7.2 节维护应用/数据恢复。历史候选和历史通过结果不自动晋级为当前 main 的验收。日常开发按[开发 SOP](./workbench-development-workflow.md#execution-sop)，架构按[二开标准](./workbench-adaptation-plan.md#current-standard-v11)。

| 步骤          | 操作与产出                                                                                                                                                    | 停止或继续条件                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 0. 校准基线   | 核对分支/HEAD/dirty diff、官方 tag 到 SHA 的映射、Git 祖先关系、upstream lock、候选 metadata、`workbench:sync status` 的 mainRef/base/candidateSha 和验收来源 | 记录不一致先解释；不能单凭历史 ready 或一个字段准备下一候选         |
| 1. 固定目标   | 按最新稳定发布渠道执行第 6.1 节 `check`，记录固定 base/tag/完整 SHA、锁文件 hash 与工具链                                                                     | `check` 会持久化检查快照，不是只读 status；不替换不同目标的活动候选 |
| 2. 准备/续跑  | 在干净隔离 checkout/worktree 按 `prepare` 执行 merge，或按现有候选恢复规则续跑                                                                                | 保持单一活动候选；冲突保留现场，人工审查并提交修复                  |
| 3. 审查适配   | 结合接入清单检查布局/导航、协议、Provider、生命周期、迁移及依赖补丁                                                                                           | 无文本冲突也执行适用回归；新增宿主依赖执行边界检查                  |
| 4. 绑定与验证 | 按当前 main ref、真实 merge 历史和最终候选 HEAD 执行 `bind`、`verify`                                                                                         | 完整固定门禁失败继续修复；自动检查通过仅是 awaiting-runtime         |
| 5. 冻结并实测 | 对同一候选补齐正式要求的原生/专家真实运行、取消恢复、MCP、身份、迁移与产物证据                                                                                | 输入变化按既有绑定规则重新验证，不搬用另一 SHA 的证据               |
| 6. 审核与交付 | 满足既有 ready/审核条件后按[main 合入要求](./workbench-development-workflow.md#main-合入条件与保护)操作；安装/发布另按对应授权                                | 分别记录候选保存、自动检查、runtime、合入、安装和发布状态           |

基线校准至少可以先只读运行以下命令，再对照对应文件和验收记录；命令成功退出不等于当前源码通过：

```bash
git status --short
git rev-parse HEAD
mise exec -- bun run workbench:sync status
```

`status` 支持 `--main-ref REF`，默认 `refs/heads/main`。输出 `baseline` 明确请求 ref/SHA、调用工作区的 HEAD/分支/dirty 状态、锁定版本的包含关系与候选绑定。请求范围不同、锁定目标已进入 main 但基线记录未校准等情况，顶层为 `baseline-review-required`；`candidate.status` 保留历史值。查询不修改状态、锁文件或退休候选，退出码 0 只表示读取成功，不能作为合入门禁。`check` / `prepare` / `bind` 复用核对，存在待校准差异时停止推进并返回处理指引。

对锁文件中的完整官方 SHA 使用 `git merge-base --is-ancestor <official-sha> HEAD` 核对历史。标签/远端需要刷新时按本次维护授权执行，缓存 ref 的观察日期必须注明。涉及实际安装/迁移时另核对运行应用版本、数据目录、官方/扩展 schema 与文件格式。

不一致的处理顺序：保留历史记录 → 明确哪个对象/源码已验证 → 找到合入与验收依据 → 按现有状态语义制定锁文件/候选记录的校准变更 → 重新绑定并验证。证据不足时将该升级标为待校准，只暂停候选生成/晋级；不阻塞独立日常开发，不直接将锁文件改成“已集成”。[2026-10-16 核对](../workbench/WB-00-upstream-evidence.md#2026-10-16-baseline-audit)记录了当前需处理的历史状态差异。

每周检查一次，不要求每周合并或发布。失败时保留上一可用版本并继续同一候选。远端自动化分别验收手动触发、实际定时触发、候选保存与报告；一次 schedule 触发或候选分支写入不是整条链路成功，最新观察见 [WB-05](../workbench/WB-05-automation.md#2026-10-16-remote-read-only-audit)。

每次真实升级在该次验收摘要中记录固定目标/候选 SHA、冲突文件、实际语义适配位置、模块业务改动、修复与验证耗时及阻塞原因；测试/文档改动单列。两至三次相似升级后评估是否增加接口，不预设零冲突、工期或节省比例。

### 6.1 脚本接口

接口状态：WB-04 的 `check`/`prepare`/`bind`/`verify`/`status`、集成候选退休、build manifest 与候选 runtime probe 已集成。fee08 的两项固定门禁失败、9591 的六项固定门禁通过及 weekly fixture 失败、858 在 umask `077` 下的首次 test 权限失败和 `022` 下六门禁通过，均按各自来源保留；f248 的六项固定门禁也通过。f248 上两 flavor 诊断构建、身份和合成迁移/restore 按范围通过，但 live cancellation 失败、recovery 未运行，故该轮为 `awaiting-runtime`。de287 的 HTTP cancel-drain 修复在三个服务端文件通过 25 个目标测试、scripts fixture 通过 3 个目标测试；这些检查在 pinned Node `24.13.1`/Bun `1.4.2` 工具链下运行。该提交尚未通过六项正式门禁、重新构建或 live 重验。十项 required runtime evidence 没有全部通过并绑定；858 后续 attempt、f248 结果和取消诊断见 [WB-04 runtime preflight](../workbench/WB-04-runtime-preflight.md)。未来候选须核对 checkout HEAD、生成状态中的 `candidateSha` 与 evidence binding 一致；不继承 f248 或 de287 的验收结论。

| 命令                                                                                                                                                    | 行为与输出                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workbench:sync check [--main-ref REF]`                                                                                                                 | 读取当前 main ref SHA，检查官方稳定发布并持久化固定 tag/SHA 快照；不替换活动候选。默认 `refs/heads/main`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `workbench:sync prepare --checkout PATH --base SHA --target-tag TAG --target-sha SHA [--main-ref REF]`                                                  | 要求上一条成功检查的 tag、SHA、main SHA 与锁文件 hash 全部相符；在指定 clean 候选 checkout 中对固定 target 做真实 `--no-ff` merge。冲突保留现场。只把同步状态写入 git common dir，不在候选工作树写额外文件。                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `workbench:sync bind --checkout PATH --base SHA --target-tag TAG --target-sha SHA --candidate-sha SHA [--main-ref REF]`                                 | 在新 runner 或人工修复后重建本地状态。核对 branch、clean HEAD、准确 SHA、当前 main ref、候选 metadata 和真实 target merge 历史；不依赖临时 runner 的成功状态。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `workbench:sync verify --candidate-sha SHA [--runtime-evidence PATH]`                                                                                   | 只对绑定的准确 HEAD 串行运行七项固定门禁（原六项加 workbench:check-boundaries），逐项记录通过/失败/未运行。stdout、stderr 和 runner 异常写入 Git common-dir 下按候选 SHA 与 run ID 隔离的私有日志目录；报告只返回日志相对引用、SHA-256 与状态，不包含日志正文。写日志失败不得进入 ready。workflow artifact 仅保留脱敏摘要和退出标识，临时 runner 的详细日志不会上传。自动门禁全部通过后进入 `awaiting-runtime`；仅接受绑定相同候选、base、target、锁文件 hash 和 Node/Bun 版本的完整运行证据后进入 `ready`。运行证据须覆盖 Codex/Pi 普通与专家首轮、恢复、取消、MCP、session 隔离、打包身份和迁移恢复；每项均须 `passed` 并带 evidence SHA-256。 |
| `workbench:sync status [--main-ref REF]`                                                                                                                | 只读检查请求的 main ref（默认 refs/heads/main）与候选绑定、锁文件、工作区和工具链；差异报告 baseline-review-required，历史 candidate.status 保留，退出 0 不代表验收；不展示本机绝对 checkout 路径。                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `scripts/workbench-build.ts --flavor FLAVOR --source-sha SHA --platform PLATFORM --arch ARCH --output-dir PATH [--upstream-tag TAG --upstream-sha SHA]` | 只对准确、干净的 HEAD 使用 mise 锁定的 Node/Bun 和现有桌面构建器；官方来源必须匹配锁文件并能由 Git 证明已集成。产物与 provenance/build manifest 写到源码树外的新目录。manifest 标记 `diagnostic-build-only`，自动门禁和运行证据明确为 `not-run`。候选分支可省略 upstream 参数，由已提交的候选 metadata 固定目标。                                                                                                                                                                                                                                                                                                                                |

常用命令需在仓库锁定工具链下运行，例如：

```bash
mise exec -- bun run workbench:sync check --main-ref refs/heads/main
mise exec -- bun run workbench:sync prepare --checkout ../candidate --base <main-sha> --target-tag <tag> --target-sha <official-sha>
mise exec -- bun run workbench:sync bind --checkout ../candidate --base <main-sha> --target-tag <tag> --target-sha <official-sha> --candidate-sha <candidate-head-sha>
mise exec -- bun run workbench:sync verify --candidate-sha <candidate-head-sha>
mise exec -- bun run workbench:sync status
mise exec -- bun scripts/workbench-build.ts --flavor workbench --source-sha <clean-head-sha> --platform mac --arch arm64 --output-dir ../workbench-artifacts --upstream-tag <locked-tag> --upstream-sha <locked-official-sha>
```

构建输出目录必须是源码树外不存在的新目录。`workbench/build-config.json` 独立记录 `workbench` 与 `workbench-preview` 的 build version；构建器仍负责打包与版本注入，provenance helper 负责产物 hash 和签名状态，旁置的 `workbench-build-manifest.json` 额外记录官方 SHA、双 migration 高水位、工作台 schema format、工具链与独立 build version。清单不代表自动门禁、真实运行或发布已通过。

第一版不把生产安装或推送藏在 check/prepare/bind/verify 中。远程候选发布由已授权的 workflow 显式执行；本地安装使用单独的维护入口，复用现有构建/启动机制。

配置与状态分开：

- `workbench/upstream.lock.json`：版本化记录官方仓库、release/tag、完整 SHA、更新渠道和格式版本。候选分支内可更新，只有通过验证并进入 main 才代表新集成基线。
- `workbench/integration-points.json`：自定义代码接入官方文件的位置、职责、影响测试；只记录真实接入点。
- 候选状态与验证日志：本机使用 Git common dir 下的 `workbench-sync/state.json` 和原子 `operation.lock`；CI 将状态作为 runner 本地缓存并用候选分支 metadata 恢复，不能依赖临时磁盘跨周存活。`check`、`prepare`、`bind`、`verify` 共用仓库级互斥锁；`status` 为只读。锁记录 PID、主机和 token，只在同主机确认进程已退出且再次核对目录 inode/token 后恢复；未知或跨主机锁保留人工检查。
- 候选分支 metadata：周 workflow 在合并 main、解决冲突或更新候选后显式写入并提交 `workbench/sync-candidate.json`，随后对新 HEAD 执行 `bind`。文件不包含候选 SHA，避免 SHA 自指：

  ```json
  {
    "formatVersion": 1,
    "baseSha": "<current-main-sha>",
    "target": { "tag": "<official-tag>", "commit": "<official-target-sha>" },
    "branch": "codex/sync-<tag>-<short-sha>"
  }
  ```

  `bind` 要求 metadata base 等于当前 `--main-ref` SHA，base 和 target 都是候选 HEAD 的祖先，并在历史中找到以固定 target 为第二父的真实 merge。候选 HEAD 可以包含该 merge 之后的 metadata/人工修复提交，或再合入较新的 main；新 base 必须仍沿祖先链成立。不同 target 的活动候选不能被新检查替换。

- 构建清单：记录最终源代码 SHA、官方 SHA、工具链、两套 schema 版本及产物 hash；运行中显示的版本来自该构建。

当前实现位于 `scripts/workbench-sync.ts` 与 `scripts/lib/workbench-sync/`；版本选择、Git 操作、状态和检查执行沿用现有平台/进程封装与参数数组调用。

### 6.2 版本与候选规则

1. 官方来源固定为 `Emanuele-web04/synara`；从官方发布元数据选择非草稿、非预发布目标，解析 tag 到 commit。不能以文件名或字符串排序猜“最新版”。
2. 取得完整祖先历史和 lineage 验证需要的官方 tags。记录完整 SHA，禁止在一次运行中重新解析移动的 HEAD 来替换目标。
3. 目标必须包含已集成官方基线；相同则无更新，目标较旧或发布线分歧则暂停选择。已锁定 tag 若指向不同 SHA，报告来源变化，不自动强制覆盖。
4. 候选从我们的 main 创建，使用 `codex/sync-<目标版本>-<短SHA>`。在本地优先使用受管理的独立 worktree；CI 使用独立 checkout。
5. 一个仓库同时只有一个活动同步候选。已有候选失败时继续处理该候选，不每周再制造一个相同 PR。
6. 文本冲突输出报告等待修复，不自动使用 ours/theirs 覆盖。人工已有修复不能被重新 prepare 清除。依赖锁文件按最终依赖声明和锁定工具链处理，不单边保留来掩盖冲突。
7. 候选准备后 main 有新提交，则旧验证不能直接作为合入依据：合入新 main、重新验证最终候选。正式构建也绑定最终提交，避免测试的是 A、安装的是 B。

网络失败和无更新是不同状态。失败报告至少包括目标、阶段、退出状态和可重试入口；报告不包含凭据或个人绝对路径。

### 6.3 状态与恢复

状态：`check` 持久化 `no-update / update-available / selection-blocked / network-failure` 快照；候选经过 `merging → conflict / awaiting-verification → checks-failed / awaiting-runtime → ready`，发现证据失效时进入 `rebind-required`。main 前进、候选 HEAD/分支变化、工作树变脏、锁文件或工具链变化都会让旧证据失效并要求重新 bind/verify。自动门禁通过不等于真实运行通过；安装另行记录 `installed` 和对应产物，不用“已创建 PR”代表“已升级”。

相同固定 SHA 的重复 `prepare` 只在候选 branch、HEAD 和 clean 状态都完全匹配时复用候选；`verify` 每次重新运行固定门禁。任何代码、依赖、迁移或工具链变化都会使相关证据失效。锁与状态写入采用原子方式，崩溃重启先检查实际 Git 和构建状态，再恢复流程，不能只信一个成功标记。

同步工具的必要测试覆盖：排除预发布、无更新与网络失败区分、祖先关系分歧、tag 移动、缺失发布标签、候选目录有改动、两个任务竞争、冲突后保留人工修复、main 前进使旧验证失效，以及检查失败不能进入 ready。使用本地临时 Git 仓库覆盖真实合并与恢复路径，不用纯 mock 代替 Git 行为。

### 6.4 周调度的默认落点

推荐在自己的 GitHub 仓库增加周 workflow，暂定每周六北京时间 10:30，可配置，并保留手动触发。首轮执行逻辑按以下职责组织：

| 环节         | 运行内容                                               | 权限与环境                                       |
| ------------ | ------------------------------------------------------ | ------------------------------------------------ |
| 检查与准备   | 解析目标、合并并生成可检查候选                         | 独立 runner；操作自身仓库的权限按需提供          |
| 自动验证     | 对准确候选 SHA 执行复用的检查入口                      | 只读仓库权限，不提供真实 Provider 凭据或发布密钥 |
| 候选报告     | 在自身仓库创建/更新一个草稿 PR或候选记录，保存检查结果 | 写权限只用于自身候选分支和记录，不写官方仓库     |
| 本机运行验收 | 隔离构建、真实 Codex/Pi/工具链路与恢复演练             | 使用已有本机认证和独立 home；不放到公开 CI       |

第一版复用已有 CI/setup/build 入口；如需显式 workflow_dispatch，给既有验证入口增加精确候选 ref 的支持，或用共享检查脚本在周 workflow 内调用。不复制整份 CI 成为第二套易漂移的验证逻辑。

需要处理的 GitHub 行为：WB-01 的只读设置快照显示 Actions 已启用、默认 token 权限只读、没有返回 branch protection/ruleset；允许 `GITHUB_TOKEN` 创建和批准 PR 的仓库设置关闭。因此自动 PR 创建按不可用处理，默认保留候选分支、run artifact 和 job summary；候选分支写入仍要以真实 workflow 运行结果为准，不引入 PAT，也不改仓库设置。定时 workflow 要存在于默认分支且执行可能延迟；自动 token 的 push 不能假设会触发另一轮 CI。显式关联候选 SHA 和检查运行，不把“PR 已创建”视为 CI 已启动。[定时触发说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)、[工作流之间的触发规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow)。

启用前检查仓库 Actions 开关、用量、默认分支、token 可用权限和候选分支规则。若暂不具备远程条件，先交付相同脚本的手动流程；M3 保持未完成，不能把本地成功当作定时已生效。

无更新和无状态变化只保留运行记录；候选就绪、新失败、冲突或需要本机验收时通知。重跑不反复发送相同通知。默认不创建每日轮询，周任务延迟或漏跑可手动补跑。

## 7. 验证与发布

### 7.1 分层验证

| 层次       | 范围                                                 | 通过证据                                         |
| ---------- | ---------------------------------------------------- | ------------------------------------------------ |
| 基线       | 锁定工具链、依赖安装、当前专家代码                   | 明确区分原有失败和新引入失败；未解决失败不能标绿 |
| 静态与单元 | 格式、lint、类型、相关 Vitest；跨包/生命周期完整测试 | 命令、退出码和候选 SHA                           |
| 数据       | 官方 lineage、扩展 lineage、历史接管与故障矩阵       | 数据样本与迁移前后断言；实际恢复演练             |
| 界面       | 原生导航、普通任务、专家入口、字体与对话滚动         | 相关浏览器测试及必要的产品检查                   |
| 实际运行   | Codex/Pi 首回合、恢复、取消、MCP、会话隔离           | 真实进程/模型证据，记录实际运行时版本            |
| 安装与身份 | 构建产物、独立 home/profile、更新源、重启            | 实际启动后的身份和数据路径；不能以编译成功代替   |

复用现有 [专家发布故障矩阵](./expert-p0/release-fault-matrix.md)，增加本轮升级场景，原有“待平台实测”状态保留。

仓库代码变更的最终检查：

```bash
bun run fmt:check
bun run lint
bun run typecheck
bun run test
bun run migrations:check
bun run windows-runtime:check
```

其中迁移与平台检查按对应改动要求执行；本计划的身份/升级工作涉及这些边界，必须覆盖。新增扩展 lineage 检查接入现有门禁。构建/安装阶段再运行 `bun run build:desktop` 和现有 smoke 检查。不会用 `bun test` 替代仓库测试入口。

### 7.2 安装与恢复流程

当前恢复标准（2026-10-16 v1.1）：应用回退和数据恢复分别制定方案。即使数据库结构未变，也要核对配置及其他持久化格式兼容性；未经验证，旧应用不得直接写入新版本数据。恢复不能跨 Stable/Beta/Workbench 的数据身份。

1. 候选通过自动检查和本机真实运行验证，核对最终源码 SHA 与构建清单。
2. 在日用实例无活跃任务时进入维护窗口，停止拥有该数据目录的进程，取得生命周期锁；不能每周定时强制终止工作。
3. 保存一致性数据库备份及专家快照、必要配置文件，校验对应关系和可恢复性。已核实专家数据位于解析后的 `stateDir/experts/definitions`、`stateDir/experts/snapshots` 和 `stateDir/expert-connections`；备份清单覆盖这些内容及需要的文件引用，不导出环境变量中的明文凭据。备份包留在本机，不进入仓库/CI artifact。
4. 安装并启动自己的已验证构建，迁移成功后检查已有任务、专家、工具和个人数据。
5. 失败时先保留故障后数据，按兼容性选择程序回退或程序+数据配套恢复。升级后新增的数据不会自动回填进旧备份。

涉及数据格式变化的交付，在该次验收中明确以下恢复输入：匹配应用版本、官方/扩展 schema 与状态文件格式、一致性恢复点、需要配套恢复的文件/引用、失败重试步骤、校验断言，以及恢复点后新增数据的保留办法与可能损失范围。SQLite 备份不自动覆盖数据库外的状态文件；不得把活动数据库主文件的普通复制视为完整一致性备份。

恢复演练先在隔离副本执行。实际恢复前停止所有访问目标 home/数据目录的应用和服务，按现有生命周期锁、provenance 和恢复标记校验；保留故障后副本，再恢复数据库和必要关联状态，使用匹配应用启动并核对原生任务、专家绑定、配置与数据。当前 `restoreMarkedMigrationBackup` 是数据库恢复入口，其通过不证明关联文件已备份或已恢复，须单独核对清单。不能用 Git 回退或重新安装代替这些步骤。

上述规则定义后续恢复要求，不表示本次已迁移用户库、演练当前源码或安装应用；实际结果仍进入对应源码的验收记录。

第一版以本机脚本更新为主，关闭工作台对官方二进制渠道的自动更新。后续需要安装包分发时，单独接入自己的签名与发布渠道。已有 Canary 的程序回退只提供复用基础，完整数据恢复仍需 WB-02/WB-04 的验证。

## 8. 未来看板接入

WB-06 只预留最小业务模型和接入方式，具体业务列、字段、优先级及交互在看板需求阶段确定。建议先实现：

- Board、Column、WorkItem 和 WorkItemThreadLink，业务事项允许尚无 AI 任务。
- 复用适用的原生卡片、对话入口、基础交互与字体 token；需要不同语义时扩展组件或抽取共享部分。
- “交给专家”通过已有命令创建任务，固定请求标识与专家快照；重复点击/崩溃重试不能创建重复线程。
- 业务状态和执行状态分别保存/派生；执行结束显示待验收，拖动卡片默认不触发模型运行或中断。
- 归档、删除、重连和丢失关联均有明确显示及恢复逻辑。

此阶段验收后把看板加入每周升级矩阵。进一步自动化、跨设备同步和多用户协作不作为本轮底座交付的前置条件。

## 9. 实施检查清单

- [x] WB-00：审查并保存基线，工具链匹配，upstream 与历史/标签可验证；全量并行测试的已记录失败与单项重跑结果仍保留在基线记录中。
- [x] WB-01：858 与 f248 的两 flavor macOS arm64 诊断包在各自来源上完成 bundle/plist、payload、隔离启动、三应用并存和 updater-policy 检查；packager 使用 ad-hoc 本机签名，无 Developer ID 签名、公证、安装或发布。
- [x] WB-02：858 与 f248 各自三个合成 file-backed SQLite 场景通过：前两项 pinned Bun，第三项使用打包 Workbench Electron 43.4.1 的 Node mode 执行 restore CLI。未访问用户数据库，也未验证普通 Electron 启动迁移。
- [ ] WB-03：专家接入收拢和聚焦检查已集成；858 后续 Codex 普通首轮通过、专家首轮超时；f248 的 Codex/Pi 普通与专家首轮、MCP 和产品 session/persona isolation 通过，cancellation 失败、recovery 未运行。de287 cancel-drain 修复的三个服务端文件 25 个目标测试及 scripts fixture 3 个目标测试通过，完整门禁/build/live 复验仍缺。
- [ ] WB-04：将十项 required runtime evidence 绑定同一候选并完成 Provider/runtime 验收后接受基线。f248 六项固定门禁、诊断构建与本地身份/合成 restore 按各自范围通过，但 cancellation 失败、recovery 未运行，尚未全部组装为通过的 `runtimeEvidence`。后续代码须按 `workbench:sync` 生成状态重新验收。
- [ ] WB-05：每周任务手动/定时实测通过，冲突与重复运行处理可靠。
- [ ] WB-06：明确看板需求后实施，并纳入周更新验收。

各工作包的勾选只代表该行列出的证据达到范围；诊断构建、合成 SQLite、Provider 部分结果和历史失败的候选门禁分别注明，不推导为 M1/M2/M3 完成。f248 的固定门禁和部分本地验收通过，但其 cancellation 失败、recovery 未运行；十项 runtime evidence 尚无完整通过绑定，因此 WB-04 与 M2 未完成。其后的 de287 定向测试不能代替新源码的正式门禁、构建和 live revalidation；2026-10-16 起正式验证为七项门禁，历史六项不自动晋级。WB-05 的本地 fixture 通过记录限于 858，远端 manual 与 scheduled 运行仍无证据；WB-06 按用户决定延期。每阶段记录代码版本、完成项、未完成项和下一阶段依赖，保留可追溯证据即可，无需另建一套项目管理系统。
