# Context V1.1 原型验收记录

日期：2026-10-13（Asia/Shanghai）。本地审核入口：<http://127.0.0.1:17736/>。

## 交付与基线

已完成 [V1.1 PRD](../../space-project-context-v1-interaction-prd.md)、独立 React / Vite 原型、内存适配器、真实 UI 扩展、状态测试与浏览器检查。旧文档保存在 [history](./history/README.md)，旧截图仍在 [qa](./qa/)；本轮截图在 [qa-v1.1](./qa-v1.1/)，不以旧图作为当前验收证据。

主仓库交付位于本目录及 PRD、文档索引。候选 UI 来自 `/Users/wangyuelin/.codex/worktrees/expert-frontend-redesign/synara-expert`，分支 `codex/workbench-adaptation`，HEAD 为 `61df29b094d3e5f2877f7787613655220a4f72a2`，包含任务前未提交改动。HEAD 不能代表实际加载源码；本轮 4 个共享 UI 文件和 1 个新增测试的前后摘要见 [source-manifest.json](./qa-v1.1/source-manifest.json)，相对任务前文件的差异见 [source-ui.patch](./qa-v1.1/source-ui.patch)。该 patch 以任务前候选文件为基线，不能直接当作干净 HEAD 的完整差异。后续源码变化需重新检查。

直接复用 SpaceSwitcher、SpaceEditorDialog、EnvironmentProjectInstructionsSection、SidebarThreadRowContent、ChatComposerFooter、ComposerExtrasPanel、表面样式、基础控件、草稿保护及主题/字号纯函数。仓库没有直接承载四字段与快照的业务组件，因此新增 Context 表单、详情、迁移弹窗和演示外壳，由已有控件组合；未复制基础组件或另写动画。共享组件的可选 props 缺省保留原分支，异步放弃草稿单独回归。

## 自动检查

仓库门禁在实际导入 UI 的候选工作区执行；主仓库原型和文档另做局部检查。

| 检查                       | 实际结果                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| 原型构建                   | 通过；生成 dist/index.html 与资源。最大 JS 分块约 347 kB，无大块警告                              |
| 原型类型检查               | 通过，包含导入真实 UI 的类型                                                                      |
| 原型 Vitest                | 4 文件、28 项通过：快照、原消息重试、CAS、迁移、自动保存队列、冲突、ACK 丢失、放弃与隔离          |
| 原型 lint                  | 21 文件，0 警告、0 错误                                                                           |
| 本轮代码、文档与链接       | 局部格式与链接检查通过                                                                            |
| 候选工作区 typecheck       | 最终 7 包全部通过；有既有 Effect 建议诊断                                                         |
| 候选工作区 lint            | 退出 0，781 个警告、0 错误；本轮 5 个 UI/测试文件为 2 个既有警告、0 错误                          |
| 基础 UI 浏览器测试         | ComposerExtrasPanel、EnvironmentProjectInstructionsSection：2 文件、16 项通过                     |
| 专家设置浏览器测试         | ExpertsSettingsPanel：1 文件、14 项通过                                                           |
| 新增异步草稿保护浏览器测试 | useExpertDraftGuard：1 文件、6 项通过，覆盖等待、成功、失败与同步 void 兼容                       |
| 字号约束测试               | 1 文件、2 项通过                                                                                  |
| 候选工作区 fmt:check       | 未通过：context/PROJECT_CONTEXT.md、docs/linx-product-design-v2.md 两份本轮未修改文档存在格式问题 |

局部 lint 两项 warning 来自旧 Project instructions 分支的 flush 依赖，任务前备份用同一配置也产生相同两项。本轮新增回调的一项 warning 已修正，没有改写旧分支。新增测试夹具曾有路由类型错误，修正后浏览器及最终工作区类型检查通过。未为消除整体格式失败而改写两份无关文档。

工具链为仓库锁定的 Node 24.13.1 / Bun 1.4.2，原型使用 Vite 8.1.5 / Vitest 4.1.10。浏览器测试提示 caniuse-lite 数据过期，未因此升级依赖。

## 浏览器实际验收

在 Codex 内置浏览器操作。桌面采用当前默认 viewport 约 1045×822；窄屏检查使用 390×844，完成后恢复默认尺寸。正常界面为浅色 13px，审核工具初始关闭。

| 场景                 | 实际结果与证据                                                                                                                                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 现有层级与常态聊天   | Space 图标切换、普通 Project 与项目内 Threads；无新增分区、迁移导航、常驻 Context、更新横幅或 Context 引导。[常态](./qa-v1.1/01-default.jpg)                                                                                                                      |
| Space 单弹窗         | 名称、图标、目标和指令一起保存；成功关闭，失败保留。取消离开保护后草稿仍在；图标方向键可操作。[编辑](./qa-v1.1/26-final-space-dialog.jpg)、[失败](./qa-v1.1/14-space-save-failure.jpg)                                                                            |
| 创建与 Void          | 创建弹窗只有名称、图标，取消未写入；Void Project 不显示继承区。空 Context 创建规则由模型测试验证                                                                                                                                                                  |
| Project 编辑         | 继承默认折叠、展开只读；前往 Space 编辑保留 Project 草稿并返回原入口。连续输入保存最新值，保留首尾空格。[面板](./qa-v1.1/25-final-project-environment.jpg)                                                                                                        |
| 跨项目与超限         | 即时离开先确认旧 Project 保存；文献整理目标保持原值，返回硕士论文读取其新值。4097 字符目标完整保留，报 4096 上限错误                                                                                                                                              |
| 失败、冲突、ACK 丢失 | 失败保留草稿并可重试；冲突比较后明确选择。响应丢失先回读，关闭再打开仍为正确值。[失败](./qa-v1.1/11-project-save-failure.jpg)、[冲突](./qa-v1.1/13-project-conflict.jpg)                                                                                          |
| 离开与普通发送       | 失败时关闭编辑区或新建 Space 触发原 guard，取消保留草稿。失败草稿存在时普通发送无弹窗，草稿仍在。在途队列和已提交写入的放弃边界另由状态/guard 测试覆盖。[保护](./qa-v1.1/12-leave-guard.jpg)                                                                      |
| 按需详情与旧快照     | 原「＋」菜单打开详情；源更新后 snapshot-demo-1 / demo-fnv1a-v1-07853650 与原目标不变。更新说明仅在详情。[入口](./qa-v1.1/27-final-plus-menu.jpg)、[更新](./qa-v1.1/08-update-in-details-only.jpg)                                                                 |
| 原快照重试           | 失败期间更新源目标，重试仍为 snapshot-demo-2 / demo-fnv1a-v1-124dc928，原目标不变，代次 1→2，无重复消息/回复。[失败](./qa-v1.1/09-load-failure.jpg)、[重试](./qa-v1.1/10-original-snapshot-retry.jpg)                                                             |
| 迁移与历史           | 先确认归属、再处理冲突并回读为已核对；完成关闭后错误消失、输入保留。旧对话仅在详情解释历史模式，Notes 规则由模型验证。[迁移](./qa-v1.1/05-migration-conflict.jpg)、[提示清除](./qa-v1.1/24-migration-notice-cleared.jpg)、[历史](./qa-v1.1/15-legacy-context.jpg) |
| Provider 演示        | 非空 Context 的 Claude 选择明确拒绝；Pi 发送与单层快照可演示，技术详情记录 pi。未启动真实 Provider                                                                                                                                                                |
| 主题、字号、窄屏     | 18px 表单实测 18px，11px 输入实测 11px；390px 页面 scrollWidth=390，无横向溢出，面板、弹窗、底部按钮可达。[深色](./qa-v1.1/17-dark-large-font.jpg)、[窄屏](./qa-v1.1/18-mobile-dark-project.jpg)、[小字号](./qa-v1.1/22-mobile-light-small-font.jpg)              |
| 键盘与焦点           | 加号菜单 ArrowUp / Enter 打开详情；关闭返回 Composer extras。图标 Book→Lab 保存返回「前往 Space 修改」，移动导航选择后返回「展开导航」。[焦点](./qa-v1.1/20-mobile-focus-return.jpg)                                                                              |

## 隔离与检查边界

审核工具的业务请求拦截数为 0，最终浏览器 error / warn 日志为空，[最终隔离界面](./qa-v1.1/28-final-isolation-controls.jpg)可核对。网络测试验证意外 fetch、业务 WebSocket、XHR、EventSource、Beacon 与 nativeApi 调用会报错。生产 store 使用失败替身，系统窗口 Hook 为 unavailable 替身；业务组件动态导入前安装页面内存 Storage，不读取或调用真实浏览器 Storage getter。隔离经测试与独立复核确认；此边界针对当前导入图，不声称可隔离将来任意新增依赖。

本轮为交互原型，没有接入生产 API、数据库、真实配置或 Provider。完整 Sidebar / ChatView 路由、事件订阅、真实持久化/重启恢复、加载结果不明、快照远程读取失败、Expert 合成、原生恢复、fork/handoff 与生产迁移属于正式接入验收。PRD 保留这些要求，不算本轮生产通过。未运行全量业务测试、Windows/process 或迁移检查，本轮没有对应执行边界与迁移脚本修改。

动画沿用 Collapsible / disclosureMotion；未强制切换系统 reduced-motion，未验证其他浏览器、系统或移动软键盘。尚需用户审核。没有提交、推送或发布；任务前改动保留。

当前原型检查通过，整体格式门禁两项既有失败已列明。界面依据与截图索引见 [design-qa.md](./design-qa.md)。
