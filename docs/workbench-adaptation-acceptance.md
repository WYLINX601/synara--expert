# 工作台适配层实施验收

日期：2026-10-08。状态：首期代码完成，相关检查与隔离演练通过；全量门禁仍有实施前已存在的桌面失败。源码未提交、未安装或发布。

## 源码与保存点

实现工作目录：`/Users/wangyuelin/.codex/worktrees/expert-frontend-redesign/synara-expert`，分支 `codex/workbench-adaptation`，起点 HEAD `61df29b094d3e5f2877f7787613655220a4f72a2`。实施前已有专家 UI、全局 MCP 与本机导入的未提交实现，全部保留。

实施前完整源码 tree：`560487726a8dffb4432f3d46b8262b3bbe7332f5`。归档与恢复说明在本机 `/Users/wangyuelin/.codex/task-artifacts/workbench-adaptation-2026-10-08/`；源码归档不包括依赖、索引和应用数据。主目录的旧应用源码没有被候选覆盖；方案与验收文档同步到两个目录。最终源码 tree 和变更清单记录在该目录的交付清单。

方案：[轻量适配层与 UI 模块化](./workbench-adaptation-plan.md)。接入所有权、保留依赖及回归路径以实施目录的 `workbench/integration-points.json` 为准。

## 首期实现

- 统一专家和 MCP 的导航与搜索元数据，独立的静态页面映射按需加载业务页面。设置路由保留原生外壳，通过宿主适配处理旧地址、页签、专家与连接目标。
- 专家、MCP 管理、本机发现和两个聊天控件使用现有 NativeApi 的窄能力类型。没有第二套客户端、DTO、缓存或任务状态；草稿保护及查询 key 沿用原实现。
- 专家/MCP 的服务端 handlers 从 wsRpc 收拢至静态宿主装配；认证、准入、连接上下文和两种错误包装仍由原入口提供。请求、响应、CAS 及数据格式不变。
- 边界检查覆盖原有专家目录与相关 Web 功能组件；明确限制新增原生数据库、Provider、任务内核、网关、授权和完整前端客户端依赖。保留接入按具体文件与 import 登记，没有整目录豁免。
- 聊天控件已经有明确 props 与操作回调，本轮复用其既有挂载位置，无需新增空包装。会话、Provider、Gateway 生命周期、投影、迁移、进程和存储实现继续原位维护。

页面加载状态复用 SettingsEmptyState，失败操作复用 Button。因代码库没有适用的局部页面错误边界，新增一个仅用于这两页的最小错误边界；正常 URL 参数变化保持页面实例，重试仅用于失败后恢复。任意组件运行时崩溃后的内存草稿恢复不在本轮保证范围。

## 实际检查

工具链为项目锁定的 Bun 1.4.2 / Node 24.13.1；全仓检查在候选目录执行。

| 检查                | 实际结果                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run fmt:check` | 通过，4060 个文件                                                                                                                       |
| `bun run lint`      | 退出码 0，0 errors、786 warnings；未把 warnings 写成零                                                                                  |
| `bun run typecheck` | 7/7 workspace tasks 通过；输出有 Effect schema suggestions                                                                              |
| 受影响 Vitest       | 包含于完整执行；服务端 512 文件、6519 tests 通过，覆盖请求、认证、专家/MCP、原生任务及恢复；Web registry/host/search 聚焦 11 tests 通过 |
| 设置 browser        | 现有专家/MCP 3 文件 20 tests + 新装配 2 tests 通过；验证草稿保护、保存/冲突、授权/导入以及路由实例、history、Retry/Back                 |
| 依赖边界            | 28 源文件扫描通过；8 个边界测试通过，包含新增旁路反例及保留接入与清单一致性                                                             |
| diff 与文档         | 格式、路径、链接、指令和同步内容核对通过                                                                                                |

全量使用 `bun run test --continue=always` 完成六包执行，退出码 1：原始汇总为 **13258 通过、19 失败、36 跳过**，耗时 9 分 32 秒。首次执行与类型检查并行，未改动文件出现多项超时/时序失败。随后保持原测试门槛、按包单 worker 复跑这些文件：scripts 49、Web 59、Desktop 167，共 **275 tests 全部通过**，其中 17 项在复跑后通过；只有下述两项 Beta 失败持续存在。此复跑结果不改写原始全量失败记录，也不代表一次完整绿色门禁。

页面装配的错误测试模拟了组件渲染失败，未另模拟动态 import 请求被拒绝。browser 使用真实页面组件或明确的装配 mock，均未访问用户数据库；它们不等同于完整桌面主路由的实机操作或真实 Provider 成功。深浅色及共享键盘样式沿用原组件，本轮未进行逐项手工实机验收。

实施前源码副本的桌面测试已复现 `betaChannel.test.ts` 两项失败：安装后启动路径选中了本机 `/Applications` 应用；安装失败用例返回成功。实施前桌面汇总为 1315 通过、2 失败、6 跳过。本轮不改发布/安装逻辑，也不通过降低断言或跳过用例掩盖它们。

## 接口变化演练与投入

在源码副本 `rehearsal-route` 模拟宿主把 URL 的 `expertId` 改为 `selectedExpertId`。仅调整一个产品源文件 `workbench/host/settings.ts`，另调整两份测试文件；保留旧字段读取兼容并转换新跳转地址。12 个 Expert/MCP 功能组件的 SHA-256 前后及候选/副本间保持一致。

宿主单测 6/6、真实专家面板 browser 7/7 通过，planner 选择正常；browser 的 native API 数据为 mock，测试端口为 51101。模拟变更未带回候选。报告、diff 和日志保留于本机产物目录的 `rehearsal-route/.rehearsal/`。

此结果只证明所选 URL 变化能集中到宿主文件，不能代表任意官方变更均可隔离或一次真实官方升级成功。首期相对保存基线新增/修改 **16 个实现文件、7 个测试文件**；实现 diff 为 +687/-275，测试为 +680/-56，文档与图示单列。实现净增约 412 行，包含从原入口移出的 handler 与类型化页面装配，不能以行数或文件数推导节省比例。

本轮基线保存至交付的本机墙钟约半小时，包含完整检查、失败复跑与模拟演练；它不是人工工期估计。后续两到三次类似官方升级再记录官方变更类型、需语义修改的宿主/模块文件、修复时间与验证时间，并计入本层维护成本。

## 交付限制

没有集成官方新版本、安装生产应用、迁移或重置用户数据库，没有改 Provider/model 选择，也没有发布安装包。本轮验证代码与指定交互，不重新宣称历史运行、跨平台产物和真实官方升级已通过。完整仓库门禁若仍有既有失败，会单独列明；本轮通过不等于候选已满足发布条件。

## 2026-10-09 开发预览与首加载修复

应用户要求打开当前候选，运行独立开发实例：Web `http://localhost:17733/settings?section=experts`，server 15773；数据根为 `/Users/wangyuelin/.codex/task-artifacts/workbench-preview-2026-10-09/home`。启动前检查 IPv4 / IPv6 监听及 dev runner dry-run，未复用日用数据或停止旧实例。地址仅在预览进程运行时有效。

实机首页正常，首次进入 Experts 后持续显示 Loading。修复 `apps/web/src/workbench/settingsPages.tsx`：将两页 lazy 组件的创建移到内部 Suspense 边界之上，避免初始挂起子树丢弃 memo 缓存后重新创建加载身份；保留 URL 参数更新时的实例和 Retry 行为。复用原有页面装配、SettingsEmptyState 与 Button，没有新增控件或状态服务。另在既有 `WorkbenchSettingsPages.browser.tsx` 添加普通 concurrent root 下专家/MCP 首加载回归，补充 `render()` 的 act 刷新之外的运行路径。

修复后实机首页、专家列表及产品经理编辑页已显示。原装配 mock 的两项测试在修复前的 development 模式也通过，因此此前测试没有捕获这次实机问题；不将旧成功记录改写成已覆盖它。本轮新增路径的证据和实际显示共同记录，未宣称任意冷启动环境均已验证。

本轮最终检查（Bun 1.4.2 / Node 24.13.1）：根 `bun run fmt:check` 通过；`bun run lint` 退出 0（785 warnings、0 errors）；`bun run typecheck` 7/7 tasks 通过，仍有 schema suggestions。专家、全局 MCP、页面装配三份 browser **18 tests 通过**；装配 browser 的 `--mode development` **3 tests 通过**。测试仍使用 native API / 组件 mock，不等于真实 Provider 成功。未重跑完整仓库门禁，10 月 8 日两项 Beta 失败及其他历史限制继续保留。

源码仍未提交、未安装或发布。此修复改变候选源码，10 月 8 日交付 tree 不再代表当前内容，原归档及门禁证据保留不替换。本轮两份变更源码、锁文件 SHA-256、日志与预览截图保存在 `/Users/wangyuelin/.codex/task-artifacts/workbench-preview-2026-10-09/`；`preview-validation.json` 标明当前 HEAD 与未提交状态。本轮没有模型任务、真实 MCP 调用、官方升级、桌面包构建或日用数据库迁移。
