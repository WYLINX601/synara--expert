# Hub × Expert V1.1 本地验收

状态：功能已落地，最终代码门禁、本地浏览器核心场景与 Codex 真实链路验收通过。验收日期：2026-10-19。平台与人工覆盖范围见下文；未推送或发布，也未安装 Synara 应用。

## 源码与隔离

- 工作树：`/Users/wangyuelin/.codex/worktrees/hub-expert-v1/synara-expert`，分支 `codex/hub-expert-v1`，基础 HEAD `850de05e08ab9c116c639e7b1cb8145e0b6e05d5`。大量变更未提交，HEAD 不能单独代表受检源码。
- 证据目录：`/Users/wangyuelin/.codex/task-artifacts/hub-expert-v1-1-2026-10-19/`。实施前保存 V1 的 72 个文件及 tracked diff：`v1-baseline.json`、`v1-baseline/`、`v1-baseline.patch`。原工作区 `codex/composer-ui-fixes` 保持独立。
- 最终代码摘要 `129f87b671744179d25b16a6e9f0ba41d1249d558454ec906244dcfcc03937ca`（130 个修改/新增文件，摘要排除 Markdown）。`source-frozen-start.json` / `source-frozen-end.json` 的全部逐文件摘要一致；检查后只回写 Markdown 验收和 Context，最终清单见 `source-final.json`。各历史日志保留其实际受检时点。
- 新产品预览为 `http://localhost:19734/`，服务端 `127.0.0.1:18774`；使用独立 `home/`，启动前核对 dry-run 与 IPv4/IPv6 监听。`19733` 是此前 V1 实例，`19735` 是示例原型，均不作为本轮产品验收。
- Hub 工作区仍按现有默认位置在 `~/Documents/Synara/Groups` 创建带本轮 UUID 的独立子目录；独立 home 不等于该默认根目录也隔离。未改动已有用户 Hub 数据。
- [V1 历史验收](./hub-expert-v1-acceptance.md)保留，不转移为 V1.1 通过证据。

## 已批准的可见变化

用户批准精简后的第二版本地原型，并补充要求 `@` 保持原单列。正式界面复用原 `_chat` 布局、侧栏、菜单、引用标签和 Library 预览：

- Projects / Hubs 同栏独立折叠；从 Project 创建的新 Hub 归 Hubs，不重复列出 Worker。跨项目 Worker 保留所属 Hub / 执行 Project 两个入口；项目总览仍计入 Hub 工作。
- Library 默认关键产物，保留全部文件；按专家与事项组织，列表不显示版本/时间/内部目录，详情可查版本。
- `@` 单列依次提供专家、按专家分组的关键产物及原有入口。成果项只显示文件名；专家只在 Coordinator 提供。选入的是稳定引用，不启动工作。
- 已绑定专家的线程 `/` 技能列表读取固定快照，首次发送前的专家草稿复用所选专家预览，没有选择专家的普通线程仍使用 Harness 技能目录；空集合、加载中或读取失败不回退。原生命令保留。Hub 引用或专家技能发现失败时，已有选项旁仍显示错误。

## 浏览器与真实运行

真实 Provider 仅验证 **Codex / gpt-6.1-sol**。所有数据为隔离夹具，未访问原用户数据库。

| 场景                      | 证据与实际结果                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Project 新建同名 Hub      | 通过实际菜单创建两个默认同名 `V1.1 Source Project` Hub；均归 Alpha Space 的 Hubs，取消配置后对象仍存在，刷新可继续。`live-evidence-before-restart.json` / `live-evidence-final.json` 保存对象。                                                                                                                                                                                      |
| 统一侧栏与跨 Space Worker | Alpha Hub 的 Worker 在 Beta Project 执行，侧栏维持 Alpha 并标注执行 Project；Projects 整组折叠刷新保留。实际点击执行 Project 后切换 Beta，前进/后退正确恢复 Hub 的 Alpha；`worker-project-browser-history.json`。项目总览来源 Hub、状态与默认列表去重另有浏览器/单元覆盖。                                                                                                           |
| 来源 Project Context      | Coordinator 已固定旧 Project Context；编辑项目后快照不变、界面可报告有新版本。`live-source-project-context-snapshot-evidence.json`。                                                                                                                                                                                                                                                 |
| 独立 Hub 的 Space Context | 真实运行先读取 Beta FIRST；编辑 Beta 为 SECOND 并将 Hub 移到 Alpha 后再运行，仍读取 FIRST；持久快照不变。`live-standalone-context-evidence.json`。                                                                                                                                                                                                                                   |
| 删除 Space                | 对本轮独立夹具删除 Space，Hub 与 Project 回到未归类，关联/Context/文件哨兵保留。`live-space-delete-unassignment-evidence.json`。                                                                                                                                                                                                                                                     |
| 纯讨论 @专家              | 实际选择专家并发送仅讨论请求，未创建 Hub 工作项。`live-evidence-discussion.json`。                                                                                                                                                                                                                                                                                                   |
| 固定配置实际生效          | Writer / Reader 均读到各自 Persona、Skill 文件、Reference 文件和输出要求的不同哨兵；并验证实际执行 Project / Space 背景。不是以显示名称代替运行证据。`live-evidence-reader-finished.json`。                                                                                                                                                                                          |
| 原 Skill 夹具失败         | 第一项使用缺少 YAML 头的 Skill，Codex 明确报必需 Skill 未加载。修复模板后创建独立新事项，旧接受项未被静默重绑。`live-expert-fixture-repair.json`；失败线程保留。                                                                                                                                                                                                                     |
| 排队后改名/归档           | 最大并发 1，Reader 入队后模板改名并归档，已接受工作仍使用原 Reader rev2；Worker 显示原名。`live-queued-expert-evidence.json`。                                                                                                                                                                                                                                                       |
| v1 引用与 v2 发布         | Library 将 Writer v1 引用插入 Coordinator；刷新草稿后引用仍在。Writer 随后发布 v2；Reader 从原消息获得引用并用读取工具精确读到 v1 的 `V11_PUBLISHED_ONE_OAK`，当前集合则是 v2 的 `V11_PUBLISHED_TWO_PINE`。                                                                                                                                                                          |
| 取消、重启、原线程续接    | 中断 Reader 轮次后重启隔离服务；原 Expert 与 Context 快照保持一致。原线程续接再次调用读取工具得到 v1 OAK，未创建替代 Worker。`live-cancel-turn-evidence.json`、`live-restart-binding-evidence.json`、`live-evidence-final.json`。                                                                                                                                                    |
| 非法引用                  | 跨 Hub、越界路径及不存在的发布版本被拒绝，未回退到实时文件；原 v1 仍可读。`live-negative-reference-evidence.json`。                                                                                                                                                                                                                                                                  |
| `/` 专家技能              | 已归档模板的 Reader 线程只列绑定快照中的 `v11-reader-fixture`，原生命令保留；选中后草稿刷新保留引用。未绑定专家的 Coordinator 实际仍列 86 个 Harness Skill，见 `ordinary-skill-menu.json`。`expert-skills-menu-final.png`（最终源码截图）及 `expert-skills-menu.png` / `.txt`；最终 10 项浏览器回归覆盖普通线程、空/失败快照、异步线程切换、草稿预览的加载/空/失败状态及绑定优先级。 |
| 专家草稿 `/`              | 实际点击 New thread、选择 Writer Expert 后，只列 `v11-writer-fixture`，原生命令保留；未发送该草稿。`draft-expert-skills-menu.png` / `.txt`，本地草稿 ID `63940a60-6290-498b-aa45-a6cdc1e4a15d`。                                                                                                                                                                                     |
| 单列 @ / 关键产物视图     | 实际产品截图 `mention-single-column.png`、`library-published-v1.png`；Worker Library 也读取到同 Hub v2 正文，见 `worker-library-v2.png`；新增混合结果/错误提示浏览器回归通过，保持原菜单键盘与选项交互。                                                                                                                                                                             |

关键运行对象：Hub `fc652fa9-7415-4df2-a2e7-73b37e3459fb`；Coordinator `61e2c568-2c95-4264-aaad-ea8c86e6ca74`；Writer `agent-b85129fac776742867e4b43b49d3cc9e`；Reader `agent-2bb05020555c336acada9bee27607ef3`。v1 发布 commit：`24ff556b1c345d257330148e7c8b6e9a9bd08945`。

## 检查记录

最终结果绑定上述冻结代码：

| 检查                           | 实际结果                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 格式、lint、类型               | 全部退出 0；类型检查 7 任务通过。`frozen-fmt.log`、`frozen-lint.log`、`frozen-typecheck.log`。文档回写后另做格式和链接检查。                                                                                                                                                                                                   |
| Workbench 边界                 | 退出 0，覆盖 54 个声明/自动收集文件。`frozen-boundaries.log`；静态直接依赖检查不证明运行时隔离。                                                                                                                                                                                                                               |
| 迁移、Windows runtime 静态检查 | 初轮全部通过，相关迁移/平台输入此后未变，复用对应证据。`final-migrations-check.log`、`final-windows-runtime-check.log`。Windows 检查覆盖 317 个应用源文件、119 个边界文件、4 个依赖补丁及 9 个 workspace manifest，仅为静态结果。                                                                                              |
| 受影响浏览器                   | 首轮 10 文件 / 109 项通过，后续未受影响的界面保留该时点证据。最终 Skill 与菜单两文件联合复核 17/17 通过，见 `frozen-browser.log`；其中 Skill 10 项包含新增草稿入口。                                                                                                                                                           |
| 完整 `bun run test`            | 最终串行运行退出 0，6 任务全部成功，无缓存复用。17,645 项通过、39 项原有跳过，零失败/未处理错误。命令为 `mise exec -- env -u ANTHROPIC_AUTH_TOKEN VITEST_MAX_WORKERS=1 bun run test --concurrency=1 --env-mode=loose`，仅本次测试子进程去除继承的 Anthropic 凭据，不改用户环境或测试断言。运行 17m43.751s。`frozen-test.log`。 |
| 完整包结果                     | Server 8,902 / Contracts 222 / Desktop 1,444 / Web 5,531 / Shared 1,114 / Scripts 432 项通过；跳过分别为 Server 28、Desktop 6、Web 3、Shared 2。                                                                                                                                                                               |
| 源码与汇总                     | `frozen-checks.json` 记录命令、时间和退出码；`final-check-summary.json` 汇总结果并验证检查前后逐文件摘要一致。                                                                                                                                                                                                                 |

历史失败与复查保留：

- 首次未限并发的完整检查出现 Desktop 34 项失败/超时，其余任务未全部完成；`final-test.log`。第二次限并发重跑退出 1，Scripts 4 项失败、Server 因其他包失败中断，且期间有后续菜单修改；`final-test-bounded.log`，不作为最终通过记录。
- 四个首轮失败文件原断言独立复查通过：ProviderCommandReactor 480、CodexTextGeneration 36、workbench-sync-workflow 22、workbench-sync 15；`failing-files-rerun.log`。
- 服务端完整包首次串行复查退出 1：8,894 项通过、4 项失败、28 项跳过，另有 AsyncUserInput worker 启动超时；`final-server-serial.log`。运行前后 1,484 个服务端源码/配置文件摘要一致：`5d85f87b0e678bb42d9e84e22f982fba66e1442f2e4594409280a01ad475e46b`；`server-source-pre.json` / `server-source-post.json`。
- 其中 PiAdapter 1 项和 ProviderHealth 2 项假设无凭据，实际继承的 `ANTHROPIC_AUTH_TOKEN` 改变了 SDK/健康检查结果；测试进程去除该变量后原断言通过。图标失败耗时 1,509ms，与既有 PowerShell 查找 1,500ms 超时吻合，独立运行未复现。四个文件合计 184 项复查通过；`server-health-worker-recheck.log`、`server-icon-pi-recheck.log`。相关生产与测试文件均无本轮改动。
- 一次最终运行在补查发现草稿专家入口后主动中断，日志 `final-test-serial-clean.log` / `interrupted-final-for-draft-fix.json` 只作为中断记录；即使进程返回 0，也不是完整通过。补齐草稿后冻结代码重新执行上述最终整套检查。

## 范围与缺口

- 最终代码门禁通过，早期失败和复查记录保留；此次交付停留在隔离工作树的本地验收，未执行合入、推送或应用安装。
- 未以本轮真实运行证明其他 Provider、外部 MCP、Windows 安装包或运行、PDF/DOCX Agent 正文解析、大文件、跨 Hub 成果引用；没有推送、安装 Synara 应用、签名或发布。
- 已人工验证 Worker 深链接与跨 Space 前进/后退。分屏归属、旧 Hub 未归类、Library 维护边界的本轮证据来自自动化，未逐项重复手工 UI 回放：`spaceNavigation.test.ts` 覆盖分屏的 Space 可达性，`spaces.test.ts` 覆盖旧 Hub 不自动归类及元数据/删除 Space，`hubDeliverables.test.ts` 覆盖重命名、删除、恢复、根目录移动、并发与失败恢复；上述均包含在最终完整测试中。浏览器组件覆盖见 `SidebarGroupsSurface.browser.tsx`、`LibraryPanel.browser.tsx` 的首轮记录。
- 已有宿主权限与文件边界继续承担授权；Space 归属、引用标签和技能列表筛选都不授予额外权限。

## 验收操作偏差

2026-10-19 21:41，关闭浏览器更新通知时误触“Update all”，更新了用户级 Provider CLI：Codex 0.162.0 → 0.163.0，Pi 1.1.0 → 1.3.0。此操作超出本轮授权范围，已向用户说明并立即恢复原版本；实际可执行文件输出再次确认 `codex-cli 0.162.0` 与 `pi 1.1.0`。证据 `unintended-provider-update.json`、`provider-update-rollback.log`。回退恢复了 CLI 包版本，不宣称非锁定传递依赖的逐字节还原；没有安装或发布 Synara 应用。真实 Agent 运行证据均发生在此误操作之前。

## 2026-10-20 参与专家与选择器布局补充验收

用户已明确批准本轮计划及可见修改；沿用 V1 隔离分支，未引入原工作区输入框修改。新旧 Hub 默认空名单、单一关键产物板块、右侧专家/聊天辅助信息、Experts 设置页、侧栏箭头调整为本轮范围。历史验收结果仅作为来源记录。

本轮证据目录：`/Users/wangyuelin/.codex/task-artifacts/hub-participants-2026-10-20`。`baseline.json`/`baseline.patch` 记录开始前 130 个修改/新增文件。隔离 home 为目录下 `home`，网页 19736、服务 18776；启动前检查 IPv4/IPv6 与 runner dry-run。只验证真实 Codex，不推送、安装或发布。

### 本轮实现与实际证据

- 授权界面范围：`@` 单一关键产物标题、快照专家名与聊天辅助信息右对齐、Experts 设置页、Projects/Hubs 标题箭头跟随标题。Library 组织、Expert 设置页及 Slash Skills 行为不变。复用既有设置弹窗、SettingsSectionShell/SettingsCard、Input/Checkbox、选择器与 DisclosureChevron；未新增页面或父布局。
- 配置按集合保存；省略保留、显式空数组清空、旧 Hub 缺省空名单。新成员存在且未归档才可加入，保留的归档/删除成员不阻塞其他设置保存。配置 CAS、名单替换、回滚与清理均有真实 SQLite 测试。
- 两个目录读取仅取参与 ID；空名单不会访问全局目录或 Provider 预检，删除成员返回不可用，不找替代专家。新引用由宿主校验 Hub/角色/名单并读取可信名称。新派发接受事务在预检后再次检查配置版本和名单；已接受重放、排队及恢复使用原快照。
- 独立后台审查见证据目录 `backend-independent-review.md`，当时 8 个套件 168 项通过，未发现实质问题。其指出的删除成员目录用例随后已补；真实恢复缺口由下表的 Codex 运行补齐。该数量是审查时的聚焦数量，不作为最终全量数量。

| 验收项                                                         | 实际结果 / 证据                                                                                                                                                             |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 选择、搜索、数量、清空、不可用项、加载失败、重试及非名单保存   | 设置页浏览器用例通过；实际浏览器选中和清空分别保存。`participants-settings.png`                                                                                             |
| 单板块、右侧信息、长 Project 名、不可用行、键盘/列表更新、折叠 | 3 个浏览器套件 **47/47**，`browser-accepted.log`；`preview.png`、`selector-after-restart.png`                                                                               |
| 选中专家真实派发                                               | `39fa06ad-cb21-45b1-b95b-3c37b64b58d8` Hub；专家 Worker `agent-ddf52ad6e04f51ff70de6042792da1fb` 实际返回 `PARTICIPANT_PERSONA_COBALT_620` / `PARTICIPANT_OUTPUT_CEDAR_491` |
| 移除后新派发                                                   | 目录为空；工具实际返回 `This Expert does not participate in the current Hub.`；没有替代或新增专家工作                                                                       |
| 空名单普通 Worker                                              | `agent-da1478cfceff5ff70fd9e204bf76f5d3` 无 expertBinding；真实 Codex 返回 `PLAIN_WORKER_EMPTY_ROSTER_761`                                                                  |
| 有参与专家但没有匹配项                                         | `agent-c084e12b52f9d391dc3876ff2a88d3eb` 走普通 Worker，真实返回 `PLAIN_WORKER_NO_MATCH_892`；无 expertBinding，applied runtime 为空                                        |
| 移除后旧事项与成果                                             | 同一旧 Worker 继续使用原快照，并发布两个同名但不同路径的文件。目录仍为空，成果及其快照专家身份可继续选择                                                                    |
| 刷新与重启                                                     | 选中名单重启保持；清空后再次重启保持；`restart-selected.json`、`restart-empty.json`。选择第二个同名成果后的固定引用草稿刷新/重启保留                                        |
| 空名单下真实恢复及固定读取                                     | 重启后的旧 Worker 通过规范引用读取发布 revision 1，返回 `ROSTER_HISTORY_RETAINED_620` 和原 Persona；`live-summary.json` 七项断言全通过                                      |

实际 Provider 为 Codex，CLI `0.162.0`，模型 `gpt-6.1-sol`。接受快照 ID 为 `exp_0775304157c811170aff9a1eafa1792b127c54b084d073452fd91b63ed5b4c70`；重启前后 applied runtime 的 snapshotId 相同、生命周期记录已更新。只验证此 Provider，不宣称远端 MCP、其他 Provider 或 Windows 包运行成功。本轮不触及平台/进程边界，因此未增加 Windows runtime 检查。

保留失败试验：首次真实发布时模型提交了 schema 外的 `deliverables` 字段，被明确拒绝；改用精确 `files` 参数后成功。首次重启读取脚本把整个路径的斜线编码，保留命名空间解析器正确拒绝；改用共享 URI 构造器后同一 Worker 成功读取。浏览器旧断言同时匹配两个专家名，以及旧 exact option 名称未包含新增辅助文本，修正为行内/文件名匹配后 47 项通过。Coordinator 在普通活动处理中还曾误用自动化结果回报，现有会话检查以 `The active turn was not dispatched by an automation.` 拒绝，未授予权限或创建额外任务；该原始活动也保留。早期中断/失败日志均保留，不计为正式通过。完整检查另发现构建清单的当前迁移最高版本仍预期 4；同步为 5 后聚焦 21 项通过，顺查迁移备份当前目标与 ledger 断言并同步后 38 项通过，历史来源版本保持原样，再冻结源码重跑全量。该轮服务端仅 `ContextMigrationCompatibility.test.ts` 的 6 项旧清单断言失败，其余 8,907 项通过；补齐第 5 项迁移后，兼容、恢复、Workbench 迁移、备份四个文件集中 **79/79** 通过，再冻结最终源码运行全量。冻结的 Context 111 字节与 checksum、历史来源版本始终未改。

### 最终源码与检查

最终冻结源码摘要：`483a63bd73186dfe8f153a7e97ae8b335a6ca55ce9f04bf75715f613e9857b7b`，基于 HEAD `850de05e08ab9c116c639e7b1cb8145e0b6e05d5`。`source-check-start.json` / `source-check-end.json` 记录 133 个实际修改/新增的非 Markdown 源码逐文件 SHA-256，检查前后完全一致；没有暂存变更。历史 V1/V1.1 检查数量不转移。正式结果见 `final-check-results.json` / `final-acceptance-summary.json` 与相应日志。

| 检查                                                             | 本轮结果                                          |
| ---------------------------------------------------------------- | ------------------------------------------------- |
| `bun run fmt:check`、`bun run lint`、`bun run typecheck`         | 全部通过                                          |
| `bun run migrations:check`、`bun run workbench:check-boundaries` | 全部通过                                          |
| 完整 `bun run test --concurrency=2 --env-mode=loose`             | **17,663 通过，39 原有跳过，0 失败**；702.154 秒  |
| 受影响浏览器                                                     | **47/47**；另见浏览器源码绑定记录                 |
| 真实 Codex                                                       | `live-summary.json` **7/7**；本地独立 home 与端口 |

完整测试分布：服务端 8,913、前端 5,537、桌面 1,444、共享层 1,114、脚本 432、契约 223。测试子进程设置 `VITEST_MAX_WORKERS=1`，并移除继承的 `ANTHROPIC_AUTH_TOKEN`；未改生产策略或 Provider 配置。文档回写后，格式、本地链接、差异与源码摘要复核均已通过，见 `final-document-checks.json`。

浏览器通过后仅更新了 `ContextMigrationCompatibility.test.ts` 的当前 ledger 预期，前端源码没有变化；`browser-source-binding.json` 记录浏览器受检摘要到最终源码摘要的差异。

边界检查实际覆盖清单中原有 54 个精确源码入口及相应禁止依赖规则；新增设置通过既有 ExpertClient 宿主能力读取，人类设置不能成为 Agent 名单写能力。SQL 和主进程宿主仍由原模块及行为测试负责，不把静态检查声明成完整运行隔离。

## 2026-10-20 后续合入与本机安装

用户后续明确授权与输入区 UI 修复一并合入、推送并安装。原隔离验收、未交付时的状态和失败证据保留原范围；最终源码、全量重验、备份与 Personal Workbench 0.1.2 安装结果见[集成安装回执](./hub-ui-integration-release-2026-10-20.md)。
