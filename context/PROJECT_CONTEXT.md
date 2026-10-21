# Linx / Synara Expert 项目上下文

更新日期：2026-10-21

范围：以 Linx V2.0 组织长期方向管理、专业任务执行与能力进化，并在现有 Synara Expert / MCP / 工作台适配层上增量推进。本文只负责项目路由、设计边界与当前状态；产品、技术和验收细节以链接的权威文档为准。

<a id="execution-entry"></a>

## 执行入口：先选任务，再读对应规范

2026-10-16，用户在审核修订后明确要求执行《Linx 二次开发流程与工程标准 v1.1》并落地仓库规范与 SOP。规范已分别纳入下列现有文件；本页只维护路由和状态，不再复制完整架构、步骤或检查矩阵。该决定建立工程标准，不代表新的产品功能、上游升级或发布已完成。

| 本次任务                              | 先读的权威材料                                                                                                                                                                                                               | 使用边界                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 普通开发、修复、UI 或文档调整         | [执行 SOP 与检查矩阵](../docs/workbench-development-workflow.md#execution-sop)                                                                                                                                               | 按影响选择检查；核心流程/信息架构/重要视觉先确认，小修可实现后预览                        |
| 新模块、新页面、宿主接口或依赖        | [v1.1 架构标准](../docs/workbench-adaptation-plan.md#current-standard-v11)、[接入点清单](../workbench/integration-points.json)                                                                                               | 明确数据所有权、真实父布局、窄能力与扫描覆盖；不按目录名声称隔离                          |
| 官方更新、候选续跑或基线校准          | [升级 SOP](../docs/workbench-implementation-plan.md#sync-sop)、[基线核对](../workbench/WB-00-upstream-evidence.md#2026-10-16-baseline-audit)、[远端状态](../workbench/WB-05-automation.md#2026-10-16-remote-read-only-audit) | 先核对 Git/锁文件/候选/ref/验收，历史 ready 不代表当前 main                               |
| 数据兼容、恢复或安装                  | [恢复 SOP](../docs/workbench-implementation-plan.md#72-安装与恢复流程)、[发布指南](../docs/release.md)、[Canary](../docs/canary.md)                                                                                          | 应用与数据恢复分开；实际安装/生产操作按对应授权                                           |
| 产品范围与优先级                      | [Linx V2.0 原文](../docs/linx-product-design-v2.md)                                                                                                                                                                          | 用户产品设计来源，未实现内容保留规划状态                                                  |
| Space / Project Context               | [Context V1.1 实现](../docs/space-project-context-v1-implementation.md)、[浏览器整合验收](../docs/space-project-context-v1-acceptance.md#8-2026-10-15-浏览器版整合补充)                                                      | 实现、运行证据与未发布边界分别核对                                                        |
| Expert / MCP                          | [产品与技术方案](../docs/expert-product-technical-design.md)、[MCP 调整验收](../docs/mcp-connection-selection-acceptance.md)                                                                                                 | 最新未提交增量与历史实现分开；交互参考见[线框](../docs/expert-interaction-wireframe.html) |
| Provider / Gateway 真实运行与发布缺口 | [P0 证据](../docs/expert-p0/README.md)、[故障矩阵](../docs/expert-p0/release-fault-matrix.md)                                                                                                                                | 查对应源码、Provider、平台和场景，不搬用旧结果                                            |
| 既有适配实现与历史设计                | [适配层验收](../docs/workbench-adaptation-acceptance.md)、[工作台历史架构](../docs/workbench-architecture.md)、[Expert 架构图](../docs/expert-architecture.drawio)                                                           | 历史路径、tree 和演练保留原范围，不是当前源码入口                                         |

每项任务先完成 SOP 的范围/基线核对，实施中按需读取表中材料，结束时把结果写入对应验收，只有跨任务目标、入口、决定或状态变化才回写本页。主会话保留需求和架构决策；明确边界后才委派执行。不为小改强制新增需求目录或管理记录。

### 规范落地状态与维护入口

- **规范已落地，代码已对齐**：规范来源与早期文档检查见[规范落地验收](../docs/workbench-adaptation-acceptance.md#standards-rollout-20261016)；后续代码收口与实际检查见[架构对齐验收](../docs/workbench-adaptation-acceptance.md#alignment-implementation-20261016)。Context 窄客户端、Space 命令能力、清单覆盖/依赖检查、迁移归属检查及升级状态范围已实现；正式候选增加第七项边界门禁。
- **来源基线已校准，当前验收独立**：用户明确确认后，按已核验的历史验收与真实合入记录登记 v0.9.2 来源，完整归档旧 ref 的候选状态，不转移历史 ready。冻结 v1.0.5 前 main B 的 `status` 为 no-candidate、baseline reasons 为空；这份快照不代表后续候选或 main 的验收状态。详见[校准结果与回执](../workbench/WB-00-upstream-evidence.md#baseline-reconciled-20261016)，活动升级见下节。
- **已登记的兼容例外（升级前状态）**：B 的 Context 原生 tracker 中 `111_ContextV1` 保留不迁移；身份、路径及脚本内容被冻结，后续新增原生迁移必须能证明来自固定上游，Linx 扩展使用独立 ledger。本次 v1.0.5 候选按用户授权改为精确识别后转入 context1 ledger，先备份、事务内审计接管；冻结原文件和摘要保持不变。该候选尚未验收，不表示 main 已执行接管。不要追加本地原生迁移编号。
- **架构对齐历史检查**：格式、lint、类型、边界、迁移及受影响 browser 通过；完整六包首次 13,364 通过、2 失败、36 跳过，Beta 两项随后修复。具体范围见[架构对齐验收](../docs/workbench-adaptation-acceptance.md#alignment-implementation-20261016)。这些数量不适用于 v1.0.5 候选。
- **维护续办**：Beta 两项已修复为隔离安装探测，聚焦 32 项通过，完整六包随后为 13,366 通过、0 失败、36 既有跳过，详见[维护验收](../docs/workbench-adaptation-acceptance.md#maintenance-followup-20261016)。远端 prepare 的固定 v1.0.1 有 30 项合并冲突、原本地快照有 46 项；该目标已被 v1.0.5 替代。旧 111 精确兼容授权和原由保留在[兼容方案](../docs/workbench-implementation-plan.md#v101-compatibility-proposal)，活动实现及验收见下节。
- **远端自动保护未启用**：2026-10-16 只读 API 返回 main 未保护、rulesets 为空；按开发 SOP 人工执行相同门禁，不宣称已有强制保护。
- **定时链路已触发但未成功验收**：查询返回 1 次 schedule，prepare 失败，verify/publish 跳过；下一维护任务先查该失败，再验收手动与定时路径。运行链接和范围仅维护在[远端核对](../workbench/WB-05-automation.md#2026-10-16-remote-read-only-audit)。本轮未改变仓库设置、触发 workflow、推送或发布。

## Hub 可靠性与技能装配分批修复（进行中）

2026-10-21 用户授权按批次执行并使用有边界的子 agent。第一批在 `codex/hub-reliability-batch-1` 修复 Worker 终态、停止分类、V2 Expert 可选连接与 Fork、实际目标检查、固定产物字节、摘要与资料刷新；本地修复与所列验证已完成，未合并、推送或安装。第二批按用户最新澄清收窄：保留现有技能区配置设计，只补充“从文件夹添加”和“选择角色组合”入口；此前整区重设计原型撤回。当前结果、真实运行与未验证项统一记录在[分批执行与验收记录](../docs/hub-reliability-2026-10-21-acceptance.md)。

## 专家技能索引与共享版本包（候选验收）

用户已确认并要求实施“共享不可变技能包＋专家入口索引＋任务版本清单＋四端统一目录加载”。隔离分支 `codex/feature-expert-skill-packages` 基于 `49ab5dc9cabcead1bb1b489b4b4aec7576c2232a`，已实现包存储、V2 固定清单、四端目录与显式调用、配置界面、更新/引用保护删除和集中切换工具。

三端真实启动、调用、停止恢复、服务端重启和取消，以及 BMad 六角色/模板输出、12 位现有专家的隔离转换、原生删除与重复切换均已有证据。最终全仓 17,786 通过、40 跳过，受影响浏览器 38 项通过。Claude 现有认证仍返回 401；Linux/Windows 实机未验收。日用状态、main、安装和发布未变。最终检查与源码边界以[实施验收记录](../docs/expert-skill-package-implementation.md)为准，架构与完整范围见[确认方案](../docs/expert-skill-package-design.md)。

## 专家技能包合入与安装交接（0.1.3）

2026-10-21 用户授权合并并安装。本地 main 已快进到技能包功能和 0.1.3 版本提交，受检源码摘要一致，macOS arm64 构建、隔离产物启动和 release smoke 通过。后续用户再次授权安装并更新 GitHub：本机于 2026-10-21 10:04 完成 0.1.3 安装启动、停机备份、副本迁移演练、health 和配置一致性核验，源码已推送个人仓库 main。个人 macOS arm64 包以 workbench-v0.1.3 预览发布，本机 ad-hoc 签名、无 Apple 公证及自动更新 feed。未自动转换日用技能配置；Claude 401 缺口保留。详见[交付与安装结果入口](../docs/expert-skill-package-install-2026-10-21.md)。

## Hub 与输入区 UI 合入安装（0.1.2）

2026-10-20 用户授权两工作树合入 main、推送和安装。冻结构建源 `4c2204427900a2345daf8ba0bdb85198b4ef438e` 已包含 Hub × Expert 及输入区菜单/专家提示修复，已推送并安装启动 Personal Workbench 0.1.2。最终完整测试 17,663 通过、39 原有跳过，相关 browser 118 项；数据库副本升级演练、真实安装包启动及原数据保留均已核对。旧 app/home/profile 与一致性备份只留本机；远端 CI 与本地结果分开记录，详见[集成安装回执](../docs/hub-ui-integration-release-2026-10-20.md)。不包含其他旧工作树、公开二进制 Release 或 Provider 配置更新。

## Hub 参与专家与选择器调整（本地验收完成）

2026-10-20 用户已批准后续计划：新旧 Hub 默认空参与名单，名单约束发现和新派发，既有接受任务及历史成果不重绑；设置页增加 Experts，多选可为空，无适合专家时仍走原普通 Worker。`@关键产物` 单板块、专家名称及聊天辅助信息浅色右对齐，侧栏三个标题箭头一致。设计和接口见[V1.1 方案补充](../docs/hub-expert-v1-1-design.md#2026-10-20-参与专家与选择器调整)，本轮真实结果见[独立补充验收](../docs/hub-expert-v1-1-acceptance.md#2026-10-20-参与专家与选择器布局补充验收)；旧 V1.1 数量不代表本轮。本轮冻结源码完整测试 17,663 通过、39 原有跳过，格式、lint、类型、迁移、边界通过；受影响浏览器 47 项，真实 Codex 7 项场景断言通过，包含移除后拒绝新派发、旧任务恢复与固定版本读取、空名单/无匹配普通 Worker。当前独立预览端口 19736；继续隔离工作树，未推送/安装/发布。

## Hub × Expert V1.1（本地验收完成）

2026-10-19 用户确认统一导航、专家选择、关键产物双视图和固定版本引用，并要求实施。Hub 独立归属 Space；从 Project 创建仍进入 Hubs 分组；Hub Worker 默认在 Hub 下展开。专家引用仅限 Coordinator 派发，独立新 Hub 首次固定 Space Context。行为和接口见[V1.1 方案](../docs/hub-expert-v1-1-design.md)，本轮进度与证据见[V1.1 验收](../docs/hub-expert-v1-1-acceptance.md)。沿用 V1 隔离工作树与已保存基线。用户已确认精简原型，并补充 @ 单列和专家 Skill 筛选；正式界面已落地，草稿读取所选专家预览，已有线程读取固定快照。Codex 真实运行覆盖选择、排队归档、固定版本读取、取消与重启恢复。最终冻结源码完整测试 17,645 通过、39 原有跳过；格式、lint、类型、边界及受影响浏览器检查通过。其余 Provider、外部 MCP、Windows 实机及人工回放范围见验收记录。预览端口 19734，未合入、推送或安装 Synara 应用；验收时误触的 Provider CLI 更新已回退并记录。

## Hub × Expert V1（本地验收完成）

2026-10-19 用户审核通过 [Figma V2 原型](https://www.figma.com/design/mJatQwnjWkdzXUfLBtjNfk/?node-id=15-56) 并允许开发，保留原有 Hub 浮动面板、紧凑线程列表、完整 Worker 对话及分屏和 Library 能力。专项行为、接口及宿主接入见 [Hub × Expert V1](../docs/hub-expert-v1-design.md)。隔离分支 `codex/hub-expert-v1` 从 `850de05e08ab9c116c639e7b1cb8145e0b6e05d5` 开发，不包含原工作区输入框改动。Project 创建入口、接受前 Expert 快照与目标固定、关键集合和原生 Library 增量已实现；真实 Codex 文本链路、队列归档、取消后续接、重启恢复、版本读取及 Library 维护已有独立数据证据。

最终源码、检查与边界以[本地验收记录](../docs/hub-expert-v1-acceptance.md)为准；最终完整测试 17,603 项通过、39 项跳过，相关浏览器 66 项通过，格式、lint、类型、迁移及边界检查通过；源码清单与日志摘要已固定。未验证其他 Provider、Windows 运行包及 PDF／DOCX 的 Agent 正文读取；发布有每文件 1 MB 的工程上限。本轮不包含推送、安装或发布。

## 当前升级：Synara v1.0.5 源码与验收入口

2026-10-16 用户批准固定合并官方 `v1.0.5` / `1eb2beb6b5019fc311f23a3deb5362f68d07d537`，采用新版原生界面并保留 Linx Expert、MCP、Space / Context。现有 63 文件开发已完整保存为基线 B `21052b8338e4c71514df31fee9a422778ac626c9`；隔离分支为 `codex/sync-v1-0-5-1eb2beb6`，本次原始合并有 57 个冲突文件。v1.0.1 不再是活动目标。2026-10-18 原临时候选目录被清理后，已从保留的 Git 合并状态及逐份核对的会话源码修改恢复至项目内持久目录；失去的旧日志不作验收。候选包含精确旧 111 接管、恢复 v3、Context 连接与草稿保护，以及会话重启必需 MCP 预检；实现、独立复核和冻结前检查统一见升级验收。

只有最终候选 C 通过全部正式要求才快进本地 main；本轮不推送、不安装日用应用、不迁移用户数据库、不发布。固定输入、归档和兼容决定见 [v1.0.5 升级验收](../docs/workbench-v105-upgrade-acceptance.md)。该文是冻结前来源说明；最终 C、同源检查、运行与合入结果读取项目内 `.synara/upgrades/v1.0.5/evidence/` 的交付回执及 Git common-dir 的正式 sync 状态，以实际 HEAD 和记录绑定为准。此前基线或冻结前检查不作为 C 的验收，缺少完整回执时继续保持待验收。

## 当前目标

按 [Linx V2.0](../docs/linx-product-design-v2.md)构建面向个人学习、研究与工作的 AI-native 工作台，让长期负责与专业执行形成连续闭环。V2.0 继续作为产品规划；Space / Project Context 已完成实现与浏览器范围验证，其余新增能力仍按设计边界推进。既有 Expert 技术目标继续保留如下。

把 Expert 作为可复用、可检查、可固定版本的工作能力配置，组合 Persona、Skills 和 MCP 工具；Task 在首次启动时绑定不可变快照，并记录实际生效的 Provider、模型、SDK / CLI 版本和 lifecycle generation。

Expert / MCP、轻量适配层与 Space / Project Context 已形成可追溯的本地功能提交。10 月 15 日浏览器整合的范围及检查见[Context 接入验收](../docs/space-project-context-v1-acceptance.md#8-2026-10-15-浏览器版整合补充)；当前 v1.0.5 升级另行授权隔离 Provider、桌面诊断打包及恢复验收，按上节固定目标执行。安装、远端推送与发布仍不在本轮范围。不将旧运行证据改写为最新源码的通过结果。

## 当前产品方案：Linx V2.0（2026-10-10 归档）

来源：Linx 在 2026-10-10 直接提供《Linx 个人 AI 工作台｜产品设计方案 V2.0》并要求归档与更新 context。[V2.0 原文](../docs/linx-product-design-v2.md)完整保留用户提供的内容，是当前 Linx 产品方向与 MVP 规划的权威设计来源；本文只是路由摘要。原文中的建议与待验证接口仍保留其设计状态，本次归档不等于代码实现、运行验证或发布。

- **产品组织**：Space → Project → Task / Run；日常事项也可直接进入 Space 或全局 Inbox。Space 表达长期方向，Project 表达阶段目标；每个 Space 一个主要 Owner，Project 默认属于一个 Space。
- **职责分离**：全局 Personal Assistant 负责跨方向协调，Space Owner 负责方向持续推进，Expert 负责具体任务，Agent Team 为复杂任务的可选模式。Hermes 优先作为 Persistent Agent Service 接入；长期身份不等于每个 Space 一个操作系统进程，也不把 Hermes 仅作为普通 Provider 呈现。
- **复用底座**：保留 Synara Project Workspace、Expert / Skills 配置与已有任务执行能力，增量增加 Space、AgentAssignment、Hermes 服务连接及 Skill Evolution。Linx 持有核心业务对象关系，外部 Runtime 配置不作为业务模型基础。
- **Context 按需组装**：Personal、Space、Project、Expert 四类上下文有各自范围；任务加载目标、必要项目资料、选定技能和少量相关方向背景，不自动继承 Owner 的全部记忆或历史会话。Obsidian 保存权威知识，其他对象保留索引、引用与必要摘要。
- **权限与版本**：主动读取、分析和建议依据授权范围；创建任务、状态修改与外部写入按授权执行。Skill Evolution 独立于 Provider 和 Hermes Runtime，从 Run / 反馈提出 Skill 新建或 Patch，用户审核 Diff 后生效，可回滚并追溯来源 Run；运行中固定 Skill 版本，不自动覆盖已发布 Skill。
- **UI 方向**：Home、Spaces、Tasks、Experts、Settings；Space Overview 提供目标、负责人、重点、项目与关键更新，负责人通过侧边对话面板协作，专业工作继续进入原 Project Workspace。
- **MVP 顺序**：两条 P0 为 Space + Hermes Owner 基础体验与手动 Skill Evolution；P1 补授权任务推进、主动阻塞发现及定期汇报；P2 再扩展 Expert Team、Coordinator 和自动进化。Team 的首个形态为主 Expert 执行 + 独立 Expert 审查，多 Agent 不是默认执行方式。
- **范围边界**：不另建知识库、不为所有 Expert 添加长期记忆、不强制每个 Project 创建 Hermes、不默认每次任务启动 Team、不自动发布 Skill 修改、不重建 Synara 已有 Project / 执行功能、不先建设复杂数字员工层级。

### 设计与现有实现的衔接

- V2.0 描述产品目标与阶段规划；下面的 Expert、MCP 和适配层记录描述已有候选及历史证据。原有检查、失败与未发布状态不因归档而改变。
- 既有 Expert 的快照、工具授权和 Provider Adapter 细节继续查阅[Expert 产品与技术方案](../docs/expert-product-technical-design.md)。其中“不另建 Agent Runtime”限定既有 Expert 首版；V2.0 的 Hermes 外部常驻服务是新增设计，不能据此声称已接入或修改 Expert Runtime 边界。
- V2.0 的 Task、Run、Thread 是产品层对象划分，不能仅凭此文档认定现有数据模型已有对应独立实体。实施前需核对映射、数据关系及增量迁移需求。
- 尚需核对当前 Hermes Fork 的 API / MCP、Profile 与记忆隔离、项目状态查询、授权与定时能力；AgentAssignment 字段与空间归属迁移仍需技术方案；Skill 版本存储已有上方专项候选，不能据此认定 Hermes 集成已完成。原文中的“插件”定位不证明 Synara 已具备动态插件 SDK。
- P0 验收以原文第 13 节为准：一个学术 Space 关联两个 Project，Owner 基于实际项目数据持续汇报；一次任务中的有效改进提炼为 Skill 并在另一任务复用。当前没有上述场景的实现或验收完成结论。

## 既有候选进度（2026-10-09 核对）

本节摘要依据 [2026-10-08 适配层实施验收](../docs/workbench-adaptation-acceptance.md)及其源码交付清单；详细检查与限制只维护在验收文档。预览修复前核对候选与记录的交付 tree 无差异；下述 10 月 9 日修复随后改变候选源码，旧 tree 不代表修复后内容。

- **A0 已完成**：保存此前专家 UI、全局 MCP、本机发现/导入的完整未提交候选基线，可恢复源码；归档不包含依赖、索引或应用数据。
- **A1–A3 已完成**：统一 UI 注册、搜索和惰性页面装配，收拢窄客户端与服务端静态 handler 接入，扩大依赖检查。现有草稿、缓存、原生认证、CAS 与任务生命周期继续沿用；保留深层依赖逐项登记。
- **A4 已完成，范围有限**：在独立副本模拟链接参数改名，只改一个宿主产品源文件，12 个 Expert/MCP 功能组件内容保持不变；宿主 6 项单测及真实专家面板 7 项 browser 通过，数据 API 为 mock。这不是一次真实官方升级验收。
- **本轮检查**：使用 Node 24.13.1 / Bun 1.4.2。格式、lint（0 errors，仍有 warnings）、7 个 workspace 类型检查、22 项候选 browser、6519 项服务端测试及依赖边界检查通过。
- **完整门禁未绿色**：全量首次执行为 13258 通过、19 失败、36 跳过；降低并发复跑 275 项全部通过，其中 17 项首次失败未再复现。剩余两项 `betaChannel.test.ts` 失败在实施前源码也已复现：安装后启动路径选中本机应用、安装失败用例返回成功。不得把复跑结果改写成完整绿色门禁。
- **未交付到生产**：没有集成官方新版本、安装或发布候选；本轮没有重验真实 Provider、跨平台安装包或数据迁移。受控演练不能证明任意官方变更均可隔离，也不能推导长期节省比例。

## 历史开发预览（2026-10-09）

- 应用户要求打开候选，在 `http://localhost:17733/settings?section=experts` 启动独立开发预览；服务端端口 15773。数据目录为 `/Users/wangyuelin/.codex/task-artifacts/workbench-preview-2026-10-09/home`，不复用日用数据库。预览地址只在进程运行期间有效。
- 实机首次打开专家页时发现持续显示 Loading，已把两页 lazy 组件身份移至 Suspense 边界之外；候选新增正常并发根下的首加载回归。首页、专家列表及产品经理编辑页已实际显示；没有发起模型任务、安装应用或升级官方源码。
- 修复检查与限制记录在[适配层实施验收的 10 月 9 日补充](../docs/workbench-adaptation-acceptance.md#2026-10-09-开发预览与首加载修复)。10 月 8 日归档和完整门禁结果保留原样，不作为修复后候选的完整验收。

## 既有 Expert 子系统已确认决定

以下为既有 Expert 范围内的决定，不代替上面的 Linx V2.0 产品规划。权威说明均在[产品与技术方案](../docs/expert-product-technical-design.md)：

- Expert 是一级产品对象，Task 仍是实际工作的承载者；首版不另建独立 Agent Runtime。
- Expert 组合 Persona、Skills、连接和运行偏好；凭证不进入 Expert 定义或快照。
- Task 首次发送时固定 Expert snapshot。修改模板、归档模板、恢复旧任务都不能改变既有任务的快照。
- 换专家或跨 Provider 继续工作沿用派生任务与 handoff，不在活跃会话中热替换配置。
- Codex 和 Pi 保留各自协议行为；Provider 专属投影留在 Adapter，跨进程 Schema 留在 `packages/contracts`。
- 第三方工具统一经过 Synara Gateway。`tools/list` 与 `tools/call` 都按已验证的会话身份和固定快照授权，不能信任工具参数中的 Expert 或 thread 标识。
- Provider 自带的环境 Skill 可能继续出现；产品只声明专家提供的固定技能来源，不把专家技能清单描述为严格工具沙箱。

## 2026-09-29 实现记录（历史基线）

以下是 2026-09-29 工作树中的机械事实，产品语义仍由上面的方案文档解释：

- 专家库已支持新建、编辑、复制、归档、预检和版本化保存。
- 专家技能配置已支持手动新增、修改、删除本机 Skill 引用，也可从当前机器的发现目录快捷添加或移除；保存前检查空名称、空路径和重复路径。
- 新任务输入区可选择专家；首次发送创建不可变快照与任务绑定。fork、handoff、恢复和接续任务保留既定继承规则。
- Codex 通过会话指令和独立 Skill 根目录加载专家资源；Pi 通过会话 ResourceLoader 与 custom tools 加载。
- 本机 stdio / Streamable HTTP MCP 连接、环境变量凭据引用、连接测试、专家工具允许列表、会话隔离、取消和撤销清理已接入。
- 任务详情可查看固定快照、任务配置模型、最近一次成功启动的实际 Provider / 模型、Codex CLI 或 Pi SDK 版本、lifecycle generation、资源目录和连接要求。
- 实际运行记录在成功启动或恢复后覆盖；停止后保留；任务硬删除时清理。记录写入失败会使本次启动失败并清理对应运行时，不能显示虚假成功。

主要实现入口：

- 合同：[expert.ts](../packages/contracts/src/expert.ts)、[provider.ts](../packages/contracts/src/provider.ts)
- 专家与连接服务：[experts](../apps/server/src/experts/)
- 生命周期与应用记录：[ProviderService.ts](../apps/server/src/provider/Layers/ProviderService.ts)
- Codex / Pi 适配：[codexAppServerManager.ts](../apps/server/src/codexAppServerManager.ts)、[PiAdapter.ts](../apps/server/src/provider/Layers/PiAdapter.ts)
- 专家管理与技能编辑：[ExpertsSettingsPanel.tsx](../apps/web/src/components/settings/ExpertsSettingsPanel.tsx)
- 任务诊断：[ExpertTaskControl.tsx](../apps/web/src/components/chat/ExpertTaskControl.tsx)

## 2026-09-29 验证记录（历史证据）

- P0 技术可行性已通过：macOS 上 Codex / Pi 真实模型的 Persona、Skill、工具调用、恢复和取消已有证据；两端经过 Gateway 调用本地 MCP、会话 A/B 授权、下游取消与退出清理也已有证据。边界见[P0 技术验证记录](../docs/expert-p0/README.md)。
- 2026-09-29 本地检查中，格式、lint、类型检查、Windows runtime 静态边界检查、Expert 定向测试、完整 Web 测试和完整 server 测试通过。
- 当时仓库根完整测试没有形成全绿结论：五个工作区完成，desktop 工作区卡在 Electron `install.js`，8 分 25 秒无进展后终止。2026-10-08 全量执行已完成，当前桌面失败改由本轮验收记录说明。
- 迁移检查命令正常退出，但当时 checkout 没有可访问的发布标签，因此没有完成历史发布链比较。
- 当时默认工具为 Node 22.23.1 / Bun 1.4.0，低于仓库声明版本；2026-10-08 适配层检查已使用声明的 Node 24.13.1 / Bun 1.4.2。该检查不等同于签名安装包或跨平台发布验收。

## 当前工作状态与边界

- 2026-10-19 专家扩展交付：用户明确要求合入、安装和发布；`caf748a61` 已合入并推送个人仓库 main，原 26 项 MCP 修复完整保留。Personal Workbench 0.1.1 已本机安装启动，旧程序与一致性数据备份、原文件 hash 和应用身份核对通过；实际产物、安装、备份与 Claude 401 限制见[交付记录](../docs/expert-workbench-release-2026-10-19.md)。

- 2026-10-18 Claude Code / oh-my-pi 专家扩展：按用户确认方案，在 `codex/expert-claude-omp` 隔离候选中扩展固定 Persona、Skills、MCP、Context 与恢复/派生，沿用现有专家界面。兼容版本、实际检查与真实回合状态见[扩展验收](../docs/expert-multi-provider-acceptance.md)；该条是实现阶段记录，不继承其他候选的验收；后续合入与本机安装读取 2026-10-19 交付记录。

- 2026-10-18 专家/MCP 审核修复：六类缺陷、主 CI 和局部代码精简已在基于 `9bceb21d` 的 `codex/expert-mcp-reliability` 完成本地验证；完整六包 17,499 项通过、39 项跳过，另有 34 项浏览器回归通过。本轮未提交、推送、安装或发布，实际检查及兼容限制统一见[审核修复验收](../docs/expert-mcp-reliability-acceptance.md)，不复用旧源码的通过结论。
- 2026-10-15 至 10-16 MCP 交互与授权调整：本机导入取消结果页、改用 toast；专家按连接添加，全部工具由首次任务启动自动读取并固定，后续新任务可读取新增工具。旧配置缺少 `toolMode` 时维持显式允许列表，旧任务不扩权。该增量为本地未提交改动，检查与实测边界统一见 [MCP 调整验收](../docs/mcp-connection-selection-acceptance.md)。
- 主目录的本地 `main` 是后续开发入口，当前源码以实际 Git HEAD 与工作区状态为准。2026-10-15 浏览器整合验收对应产品源码 `3a754ee69`；后续文档/历史整合及未提交 Expert/MCP 增量不自动继承该验收。v1.1 规范核对的 HEAD 与历史状态差异见上方基线入口。
- 整合预览位于 `.synara/browser-integration`（`codex/browser-integration`），使用独立测试 home；不是正式用户数据库。预览与完整检查见[最新接入验收](../docs/space-project-context-v1-acceptance.md#8-2026-10-15-浏览器版整合补充)。
- 原 Expert 候选与 Context 候选分别保存为 `0f67f540e`、`4b3705f0b`，仅作历史追溯；不再要求后续工作只在旧候选目录实施。原主目录的文档与原型已保存为 `20d370eb7`。
- 2026-10-08 历史实施前 tree 为 `560487726a8dffb4432f3d46b8262b3bbe7332f5`、当时交付 tree 为 `490e1320a7a193fb486479e254e24304ce2f8c61`；历史归档位于 `/Users/wangyuelin/.codex/task-artifacts/workbench-adaptation-2026-10-08/`。这些 tree 不作为 10 月 15 日整合源码的验收结果。
- 不重置用户数据库，不复用生产状态做验证。启动产品实例时使用独立 `SYNARA_HOME` 和未占用端口，并先检查开发启动器的 dry-run。
- 连接配置只保存环境变量或凭证引用；诊断、日志、导出和 context 不保存凭证值。
- 真实 Provider 成功、进程退出和取消清理必须由对应运行证据确认；mock、类型检查和本地构建不能替代产品实测。

## 下一步

### Linx V2.0 待开展

1. 以 V2.0 第 13 节验收场景为目标，核对现有 Synara 对象与当前 Hermes Fork 能力，在已落地的 Space / Project Context 契约上制定 Hermes Owner、AgentAssignment 与权限的增量技术方案。
2. 分别细化 Space + Owner 与 Skill Evolution 两条 P0 的范围、依赖和验收；本轮只落地 Context，未实施 Owner、Skill Evolution 或其自动化。
3. 产品原文变化时重新核对本页摘要与后续技术方案；原文中的建议不通过摘要自动变成新增实现约束。

### 后续验证与交付

0. 活动目标固定为 v1.0.5；完成隔离候选的独立审查并冻结 C，执行同源七项门禁及十项运行/产物要求，全部满足后才快进本地 main。来源校准和旧 111 授权沿用已确认结果；远端旧 prepare 冲突不通过触发重跑解决。
1. Beta 两项既有测试失败已修复，保留此前失败及本次复跑证据；准备桌面交付时仍需准确源码的产物/身份与适用运行验收，测试通过不代表安装或发布。
2. 本地已保存并整合专家 UI / 全局 MCP / 本机导入、适配层与 Context；远端推送、构建、安装与发布分别记录实际状态，不能互相替代。
3. 按实际交付目标补齐当前源码的真实 Provider、取消/恢复、MCP、跨平台安装包和迁移验证；保留 Linux、Windows 与远端 HTTP MCP 的历史缺口，不搬用旧 SHA 的成功结论。
4. 后续两到三次真实官方升级记录改动类型、需语义适配的宿主/模块文件、修复与验证时间，评估本层维护成本。没有本轮官方升级或长期收益的完成结论。
5. P3 导出分享、Git 来源、OAuth、团队分发和项目默认专家，以及已延期的业务看板，仍按实际需求另行启动。

执行时先从本文件选择权威材料，再只读取当前任务需要的章节。后续阶段完成、检查结果变化或源码交接时，及时更新本页进度摘要与证据链接；方案、验收、P0 证据或发布故障矩阵变化时重新核对对应摘要，不以本页日期代替新证据。
