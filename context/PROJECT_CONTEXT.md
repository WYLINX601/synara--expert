# Linx 项目上下文

更新日期为 2026-11-12。本文负责当前目标、任务路由、已确认决定摘要与下一步，执行规范由根 `AGENTS.md` 的 BMAD 托管块维护。

## 当前目标与已确认边界

- 以 [Linx V2.0](../docs/linx-product-design-v2.md) 组织长期方向管理、专业任务执行与能力进化，复用现有源码持续演进。规划与源码实现、运行证据和用户验收分别核对。
- Linx 按独立产品管理，产品更新消费自有已发布安装包。[更新能力计划 v0.2](../docs/linx-update-development-plan.md)已按用户决定收敛为首批 macOS Apple Silicon、自动检查但点击后才下载安装、不依赖 Apple Developer ID／公证；标签触发构建，公开 Release 前人工确认。独立更新辅助程序、自有清单签名及系统安全提示的实机验证尚未实施；Bundle ID／数据目录是否迁移仍待选择。本轮只更新方案，不代表应用、发布源或远端工作流已切换。
- 架构约束、操作与检查、实际结果各有权威记录，入口只维护摘要与链接。每项工作按准确源码与当前工作区核对证据。

<a id="execution-entry"></a>

## 执行入口

| 任务                       | 权威材料                                                                                                                                                                                                          | 使用方式                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Agent 规范与上下文维护     | [根规范](../AGENTS.md)、[回写 SOP](../docs/workbench-development-workflow.md#文档与-context-回写-sop)                                                                                                             | 使用 BMAD adopt/refresh/record/audit，规则逐条追踪去向  |
| 开发、修复、UI、文档与集成 | [开发 SOP](../docs/workbench-development-workflow.md#execution-sop)、[CONTRIBUTING](../CONTRIBUTING.md)                                                                                                           | 先核对范围和已有改动，按影响选检查                      |
| 模块、数据、路由与宿主接入 | [架构标准](../docs/workbench-adaptation-plan.md#current-standard-v11)、[接入清单](../workbench/integration-points.json)                                                                                           | 明确所有权、父布局、公共能力与失败行为                  |
| 产品方向、对象与 Provider  | [Linx V2.0](../docs/linx-product-design-v2.md)、[core concepts](../docs/core-concepts.md)、[providers](../docs/providers.md)                                                                                      | 按具体问题分别查规划、当前契约与实现                    |
| Linx 更新、发布与安装承接  | [更新能力计划 v0.2](../docs/linx-update-development-plan.md)、[release](../docs/release.md) | 先验证无 Apple 付费分发的辅助安装可行性；实现、真实升级和发布分别验收 |
| Beta/Stable 与 Canary      | [BETA](../BETA.md)、[Canary](../docs/canary.md)                                                                                                                                                                   | 分别核对身份、数据、更新源和对应交付授权                |
| 环境、交付根与恢复         | [环境生命周期](../docs/workbench-development-workflow.md#environment-lifecycle)、[应用/预览记录](../docs/application-preview-environments-2026-10-24.md)、[存储记录](../docs/delivery-storage-plan-2026-11-05.md) | 操作前复核当前现场与兼容性，历史容量仅供追溯            |
| 上游源码导入               | [sync SOP](../docs/workbench-implementation-plan.md#sync-sop)、[来源基线](../workbench/WB-00-upstream-evidence.md)、[自动化记录](../workbench/WB-05-automation.md)                                                | 仅在对应源码导入任务中使用，核对当前候选与远端实际状态  |
| Marketing                  | [包级规范](../apps/marketing/AGENTS.md)、[包 README](../apps/marketing/README.md)、[manifest](../apps/marketing/package.json)                                                                                     | 读取本包 Next.js 文档，单独选择 docs/browser/性能等检查 |

## 专项工作与证据

| 专项                       | 当前工作入口                                                                                                                                                                                                                                                                                                                               | 验证与交付边界                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Context 与规范接管         | [根规范](../AGENTS.md)、[接管记录](./BMAD_CONTEXT_ADOPTION.md)、[开发 SOP](../docs/workbench-development-workflow.md#文档与-context-回写-sop)                                                                                                                                                                                              | 按 BMAD 生命周期维护，具体状态与待决项查接管记录                          |
| 禅模式与任务界面           | [实施记录](./zen-mode-implementation-2026-11-06.md)、[BMAD 当前计划](../_bmad-output/initiative-zen-companion/plan-native-window-and-task-ui.md)、[前端交接](../apps/web/prototypes/zen-companion/FRONTEND_HANDOFF.md)、[当前证据](../apps/web/prototypes/zen-companion/README.md#local-repair-package)                                    | 按记录分别核对源码、候选包、安装及真实 Provider，最新材料含本地未跟踪文件 |
| Ambient Context / Obsidian | [实施入口](./ambient-context-implementation-plan-2026-11-06.md)、[闭环验收](../docs/ambient-context-obsidian-acceptance-2026-11-06.md)、[多库验收](../docs/ambient-context-multivault-acceptance-2026-11-06.md)                                                                                                                            | 连接、绑定和发送快照分别管理，安装状态按专项证据核对                      |
| OMP Expert 兼容            | [兼容验收](../docs/omp-runtime-compatibility-2026-11-06.md)                                                                                                                                                                                                                                                                                | 按正式版本、能力探针与对应源码核对，真实线程恢复单独验证                  |
| Expert / MCP 与学习        | [既有契约](../docs/expert-product-technical-design.md)、[Expert 方案](../docs/expert-center-product-plan-2026-10-28.md)、[技术方案](../docs/expert-center-technical-plan-2026-10-28.md)、[第一阶段验收](../docs/expert-autolearning-acceptance-2026-10-31.md)、[第二阶段验收](../docs/expert-autolearning-phase2-acceptance-2026-10-31.md) | Skill、Memory、Provider 和学习链路按各自范围与版本追溯                    |
| Hub Graph 回滚及遗留协作   | [回滚安装记录](../docs/hub-graph-rollback-install-2026-11-02.md)、[迁移前记录](./PROJECT_RECORDS.md)                                                                                                                                                                                                                                       | 按用户回滚决定保留迁移与历史数据边界，旧方案作为历史材料                  |

## 后续待办

- [ ] 跨 Provider 接续规则与落地核对。双路径已有源码，先复核产品入口和真实运行验收，再判断是否需要产品方案讨论，并对齐设计文档和 context。来源与边界见 [接管记录](./BMAD_CONTEXT_ADOPTION.md)。

## 后续维护

- 当前任务改变时更新目标、入口、已确认决定摘要和下一步，实际检查只写入对应专项证据。
- 规划变化时重查相关实现映射，源码或产物变化时重查对应验收范围。当前应用、端口、分支和安装状态在执行时核验。
- 跨机器交接前核对关键材料的可取得性，禅模式原型、更新计划和 `_bmad-output` 中的过程计划按实际 Git/保留状态登记。
- 追溯旧安装版本、历史候选、原决定来源和旧检查结果时读取 [迁移前完整记录](./PROJECT_RECORDS.md)。历史记录保持原时点含义，后续状态由本入口及专项权威材料承载。
