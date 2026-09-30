# 个人工作台落地技术方案与实施计划

状态：WB-00 基线已完成；WB-04 阶段 A、阶段 B 与集成候选退休修复已通过 review；B2 隔离构建清单实现待 review，尚未执行实际构建；其余计划项尚未完成。
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

本次制定技术方案与计划；没有执行提交、配置远端、迁移数据、安装新应用、推送或启用定时任务。

当前已核实的实施起点：

| 项目       | 状态                                                                            | 实施影响                                         |
| ---------- | ------------------------------------------------------------------------------- | ------------------------------------------------ |
| Git        | `main` 基线为 `eaa61eded31b6755d4f30ba8eabc5d905cf817cb`；浅克隆；仅配置 origin | 先保存自定义改动、补齐历史和验证所需发布标签     |
| 自定义代码 | 专家能力有大量未提交文件                                                        | 不能直接在活动工作区执行周同步                   |
| Node / Bun | 当前为 22.23.1 / 1.4.0；[.mise.toml](../.mise.toml) 要求 24.13.1 / 1.4.2        | 验收使用仓库锁定工具链，避免环境差异造成误判     |
| 数据迁移   | 专家使用官方序列中的 109、110                                                   | 首次长期维护前拆分迁移归属，并处理已运行的历史库 |
| 备份与锁   | 已有独占锁、迁移快照、中断恢复                                                  | 扩展现有机制，不从应用外并发连接活动数据库       |
| 平台证据   | 专家旧记录包含 macOS 实测；Linux/Windows 仍有待实测项                           | 新版本重新验收；旧记录不能替代本次候选验证       |
| Git 网络   | 本会话早先访问 GitHub 受本机代理连接失败影响                                    | WB-00 重新核实，失败只阻塞联网步骤               |

第一轮优先完成当前 macOS 自用运行验证。平台无关代码继续遵循仓库边界，Linux/Windows 的支持状态按实际验证记录，不宣称已经覆盖。

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

| 工作包               | 具体交付                                                                          | 改动位置                                                                                                                                                                                                         | 完成条件                                                                 |
| -------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| WB-00 基线与环境     | 专家改动清单与可恢复提交；upstream；完整历史与标签；工具链；运行实例/数据位置盘点 | Git 配置、现有代码审查、拟新增 `workbench/upstream.lock.json`                                                                                                                                                    | 能复现当前版本；共同祖先已确认；记录现有失败与平台缺口                   |
| WB-01 应用与数据隔离 | 自定义日用/候选身份；独立 home、profile、端口；脚本更新模式                       | [desktopIdentity](../packages/shared/src/desktopIdentity.ts)、[desktop main](../apps/desktop/src/main.ts)、[构建器](../scripts/build-desktop-artifact.ts)、[Canary 工具](../scripts/canary.ts)                   | 原版和工作台可并存；实际构建的身份与更新策略正确；候选不占用日用数据     |
| WB-02 迁移归属与恢复 | 扩展 migrator；109/110 历史接管；统一备份/恢复计划；双 schema 版本检查            | [SQLite 装配](../apps/server/src/persistence/Layers/Sqlite.ts)、[迁移](../apps/server/src/persistence/Migrations.ts)、[备份](../apps/server/src/persistence/MigrationBackup.ts)、拟新增 `workbench/persistence/` | 历史样本、崩溃重试和恢复测试通过；官方与自定义迁移不再竞争编号           |
| WB-03 收拢接入       | 工作台入口注册、专家服务装配与依赖清单；接入边界检查                              | [wsRpc](../apps/server/src/wsRpc.ts)、[专家服务](../apps/server/src/experts/ExpertStore.ts)、[设置导航](../apps/web/src/settingsNavigation.ts)、拟新增 server/web `workbench/`                                   | 原生与专家行为不变；新模块可通过集中入口接入；没有新的执行器             |
| WB-04 首次真实同步   | 同步脚本；固定官方候选；冲突适配；隔离构建；真实运行及恢复演练                    | 拟新增 `scripts/workbench-sync.ts` 与支持模块；复用现有测试、构建和恢复工具                                                                                                                                      | 官方 SHA、自定义 SHA、检查和实测证据对应同一候选；形成可安装版本         |
| WB-05 每周自动准备   | 每周 workflow、并发控制、重复运行处理、候选报告、失败恢复入口                     | 拟新增 `.github/workflows/workbench-weekly-sync.yml`；复用 [CI](../.github/workflows/ci.yml) 和 setup-workspace                                                                                                  | 手动触发及一轮真实定时触发均有证据；同一候选不重复；不会自动替换日用程序 |
| WB-06 业务看板       | WorkItem/线程关联、最小页面与“交给专家”操作                                       | 拟新增 `workbench/features/boards/`；复用 [原生 Kanban](../apps/web/src/components/kanban/KanbanView.tsx) 的适用组件                                                                                             | 事项与执行状态分开；崩溃重试不重复创建任务；进入下次周同步验证           |

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

拟新增的 server 文件职责（目录前缀为 `apps/server/src/workbench/persistence/`）：

| 文件                               | 职责                                                            |
| ---------------------------------- | --------------------------------------------------------------- |
| `WorkbenchMigrations.ts`           | 静态扩展迁移清单、顺序执行和版本检查，复用现有 Effect/SqlClient |
| `LegacyExpertMigrationAdoption.ts` | 纯识别计划与受控接管，精确匹配旧 109/110 身份和 schema          |
| `WorkbenchUpgradePlan.ts`          | 汇总官方升级、自定义升级、历史接管和备份要求                    |
| 对应测试                           | 验证历史身份、事务、失败恢复、过新版本与数据保留                |

`workbench_sql_migrations` 的计划字段为 `module_id`、`migration_id`、`name`、`checksum`、`applied_at`，主键为 `(module_id, migration_id)`。同一模块的历史记录必须构成有效前缀，已执行脚本不可改名、改号或修改校验内容。另设工作台数据格式版本，拒绝当前程序不能解释的版本。优先使用现有 migrator 可支持的表配置；不足的部分写局部适配，不增加新的数据库框架。

### 4.2 启动执行顺序

1. 通过已有 DatabaseLifecycleLock 获得独占权，处理既有未完成恢复标记，再建立现有 SQLite 连接。
2. 只读检查官方 tracker、扩展 tracker、实际 schema 和版本。用同一个纯计划函数向备份器与执行器提供决策，避免二者对“是否迁移”判断不同。
3. 有官方变化、扩展变化或历史接管任一项时，对非空库创建完整 SQLite 一致性快照，持久化恢复标记。现有备份器只根据官方迁移清单判断，必须扩展它，否则“只有扩展升级”可能不备份。
4. 精确识别旧专家历史后，在事务内写入扩展迁移接管记录，并移除对应的旧专家 tracker 项，使官方 tracker 恢复为已证明的官方前缀。保留迁移来源和校验依据，事务失败整体回滚。
5. 执行原有官方迁移，再执行依赖它们的扩展迁移；每个扩展迁移的 schema 变化与记录写入同事务。
6. 核实两套 schema 和专家数据，完成恢复标记后才启动业务服务、投影消费者和 Provider 生命周期。

第 4 步必须在官方 lineage 检查之前完成，但不得在第 3 步备份前修改数据。官方原有的未知历史/分歧确认机制继续生效；白名单接管不构成跳过其他异常的理由。

### 4.3 109/110 的接管规则

- 只认精确 tracker 二元组 `(109, "ProjectionThreadsExpertBinding")` 和 `(110, "ExpertAppliedRuntimeRecords")`；文件名前缀不是 tracker 的 name。
- 同时校验官方前缀、必需列/表及数据结构；不能仅看到编号就判定属于我们。
- 只有 109 的合法中间态可接管，后续补做缺少的扩展迁移。109/110 都没有时走正常扩展初始化。
- 部分 schema 已存在但 tracker 缺失的状态需明确识别为可安全补记或拒绝；不以 `IF NOT EXISTS` 隐藏不兼容结构。
- 未知 name、未知更高扩展版本、官方前缀无法解释时停止升级，保留诊断。
- 接管后的扩展记录使重跑成为无操作，不重复备份覆盖原始恢复点。
- 旧自定义程序无法识别拆分后的迁移历史；默认视为跨越回退边界，恢复旧程序必须使用配套旧数据备份，除非另有实测兼容证据。

恢复标记需要记录官方和扩展的源/目标版本、旧历史身份和备份对应关系，并兼容已有标记。扩展迁移失败时复用同一恢复点；不能在重启时把部分升级库当作新的正常基线。仅扩展变化、旧 109/110 接管和扩展版本过新都必须进入备份/恢复测试。

恢复校验也要一起改造：当前 `inspectSqliteMigrationBackup`、`assertMigrationBackupCompatible` 及恢复来源核对依赖官方最高编号。拆分后旧备份可能含 110，而新官方基线只有 108，不能直接据此判为过新或放宽所有限制；应识别已知专家历史，并分别核对官方/扩展版本及目标程序。新备份信息采用可兼容读取旧格式的版本化结构，未知历史仍拒绝。

正式 SQLite 装配和内存测试库必须执行一致的扩展初始化。直接调用官方 migrator 的测试继续明确验证官方部分；依赖专家 schema 的测试使用完整工作台初始化，避免只在产品入口加迁移导致测试路径与实际启动分叉。

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

### 6.1 脚本接口

接口状态：WB-04 阶段 A 的 `check`/`prepare`、阶段 B 的持久状态/`bind`/`verify`/`status`、集成候选退休与隔离构建清单脚本已实现；真实构建和运行仍待验收。

| 命令                                                                                                                                                    | 行为与输出                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workbench:sync check [--main-ref REF]`                                                                                                                 | 读取当前 main ref SHA，检查官方稳定发布并持久化固定 tag/SHA 快照；不替换活动候选。默认 `refs/heads/main`。                                                                                                                                                                                                                                                                                                  |
| `workbench:sync prepare --checkout PATH --base SHA --target-tag TAG --target-sha SHA [--main-ref REF]`                                                  | 要求上一条成功检查的 tag、SHA、main SHA 与锁文件 hash 全部相符；在指定 clean 候选 checkout 中对固定 target 做真实 `--no-ff` merge。冲突保留现场。只把同步状态写入 git common dir，不在候选工作树写额外文件。                                                                                                                                                                                                |
| `workbench:sync bind --checkout PATH --base SHA --target-tag TAG --target-sha SHA --candidate-sha SHA [--main-ref REF]`                                 | 在新 runner 或人工修复后重建本地状态。核对 branch、clean HEAD、准确 SHA、当前 main ref、候选 metadata 和真实 target merge 历史；不依赖临时 runner 的成功状态。                                                                                                                                                                                                                                              |
| `workbench:sync verify --candidate-sha SHA [--runtime-evidence PATH]`                                                                                   | 只对绑定的准确 HEAD 运行固定门禁：格式、lint、typecheck、仓库测试、迁移与 Windows runtime 边界。逐项记录通过/失败/未运行。自动门禁全部通过后进入 `awaiting-runtime`；仅接受绑定相同候选、base、target、锁文件 hash 和 Node/Bun 版本的完整运行证据后进入 `ready`。运行证据必须逐项覆盖 Codex/Pi 普通与专家首轮、恢复、取消、MCP、session 隔离、打包身份和迁移恢复；每项均须 `passed` 并带 evidence SHA-256。 |
| `workbench:sync status`                                                                                                                                 | 对照实际 Git、当前 main ref、锁文件和工具链展示候选及证据状态；不展示本机绝对 checkout 路径。                                                                                                                                                                                                                                                                                                               |
| `scripts/workbench-build.ts --flavor FLAVOR --source-sha SHA --platform PLATFORM --arch ARCH --output-dir PATH [--upstream-tag TAG --upstream-sha SHA]` | 只对准确、干净的 HEAD 使用 mise 锁定的 Node/Bun 和现有桌面构建器；官方来源必须匹配锁文件并能由 Git 证明已集成。产物与 provenance/build manifest 写到源码树外的新目录。manifest 标记 `diagnostic-build-only`，自动门禁和运行证据明确为 `not-run`。候选分支可省略 upstream 参数，由已提交的候选 metadata 固定目标。                                                                                           |

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

建议实现文件为 `scripts/workbench-sync.ts`，版本选择、Git 操作、状态和检查执行放 `scripts/lib/workbench-sync/`；沿用现有平台/进程封装与参数数组调用。

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

需要处理的 GitHub 行为：定时 workflow 要存在于默认分支，执行可能延迟；自动 token 的 push 不能假设会触发另一轮 CI，自动创建 PR 的检查也可能等待批准。因此本次 workflow 必须显式关联候选 SHA 和检查运行，不把“PR 已创建”视为 CI 已启动。具体行为在启用时按仓库设置验证。[定时触发说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)、[工作流之间的触发规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow)。

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

1. 候选通过自动检查和本机真实运行验证，核对最终源码 SHA 与构建清单。
2. 在日用实例无活跃任务时进入维护窗口，停止拥有该数据目录的进程，取得生命周期锁；不能每周定时强制终止工作。
3. 保存一致性数据库备份及专家快照、必要配置文件，校验对应关系和可恢复性。已核实专家数据位于解析后的 `stateDir/experts/definitions`、`stateDir/experts/snapshots` 和 `stateDir/expert-connections`；备份清单覆盖这些内容及需要的文件引用，不导出环境变量中的明文凭据。备份包留在本机，不进入仓库/CI artifact。
4. 安装并启动自己的已验证构建，迁移成功后检查已有任务、专家、工具和个人数据。
5. 失败时先保留故障后数据，按兼容性选择程序回退或程序+数据配套恢复。升级后新增的数据不会自动回填进旧备份。

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

- [ ] WB-00：审查并保存基线，工具链匹配，upstream 与历史/标签可验证。
- [ ] WB-01：工作台日用版、候选版、原版的实际身份和数据目录隔离。
- [ ] WB-02：独立迁移记录与 109/110 接管完成，备份和恢复故障矩阵通过。
- [ ] WB-03：专家接入收拢，原生与专家回归通过，接入点有清单。
- [ ] WB-04：完成一次真实官方升级，形成准确版本证据和恢复记录。
- [ ] WB-05：每周任务手动/定时实测通过，冲突与重复运行处理可靠。
- [ ] WB-06：明确看板需求后实施，并纳入周更新验收。

开始实施时先执行 WB-00，验收结果写入实际工作包记录；计划不预填“已通过”。每阶段记录代码版本、完成项、未完成项和下一阶段依赖，保留可追溯证据即可，无需另建一套项目管理系统。
