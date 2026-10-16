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

<a id="standards-rollout-20261016"></a>

## 2026-10-16 二开 v1.1 规范与 SOP 落地

目标与授权：用户确认执行审核修订后的二开 v1.1，优化项目 context 并明确仓库规范执行 SOP。本轮是文档/指令落地，未修改产品实现、运行脚本、接入清单 schema、上游锁文件或候选元数据。

源码范围：本地主目录 `main`，HEAD 为 `7e25e023d147ac8bac630139822e13d5c1c676a4`，加本轮九份文档差异；实施前已有 Expert/MCP 及 context 等未提交修改，HEAD 不代表完整工作区。本轮在原内容上补充 context，其他 29 个已有改动文件的 SHA-256 保持不变。实施前文档及原 dirty 文件 hashes 保存在本机临时目录 `/private/tmp/linx-sop-20261016-913vgtm8`，仅用于本次差异核对，不作为长期运行证据入口。

落地：AGENTS 增加任务路由及执行要求；适配方案拥有当前架构/模块/布局标准；开发流程拥有日常步骤、合入条件、检查选择与回写规则；同步计划拥有基线核对及应用/数据恢复；context 以任务表定位权威文档，保留原产品决定和历史验收边界。历史架构和 WB-00/WB-05 加入当前标准或核对入口。

检查：九份文档的局部格式、相对链接/锚点、所引用根命令及 diff 空白检查通过；首次局部格式检查发现六份文档需格式化，限定本轮文件修正后复查。已有 `workbench:check-boundaries` 通过，扫描 29 个源文件；本轮没有新增运行时代码，未重跑 lint、typecheck、Vitest、真实 Provider/MCP、安装包或数据迁移，不能继承旧源码的完整通过结果。

本轮基线及远端核对分别见 [WB-00](../workbench/WB-00-upstream-evidence.md#2026-10-16-baseline-audit) 与 [WB-05](../workbench/WB-05-automation.md#2026-10-16-remote-read-only-audit)。规范已落地不等于上游状态已校准、main 远端保护已启用或定时链路已通过；这些待办继续按 context 与升级 SOP 跟进。本轮没有触发 workflow、改变仓库设置、推送、安装、发布或访问用户数据库。

<a id="alignment-implementation-20261016"></a>

## 2026-10-16 架构对齐实现与验收

授权范围为用户确认的架构对齐计划。实施目录为 `/Users/wangyuelin/synara-expert`，本地 `main` 的 HEAD 为 `7e25e023d147ac8bac630139822e13d5c1c676a4`，另有本轮与实施前的未提交差异；HEAD 不是完整受检源码。实施前保存了 tracked diff 与文件摘要，本轮范围以外的 31 份既有未提交文件 hashes 保持不变，原有 Expert/MCP 工作保留。本轮没有提交、推送、生产迁移、远端设置修改或发布。

### 已由检查执行的规则

- Context 详情、自动保存及旧指令迁移使用 `workbench/host/contextClient`，复用 contracts 的 `ContextApi`、既有 capability 订阅及原 API 对象。不支持 Context 与支持但连接不可用分别处理；保留首次发送兼容与阻断、轮询、草稿保护、回执重试及切换取消。Space 辅助函数接收实际所需的 orchestration 方法，批量移动仍可回读 shell 校准未知回执。
- [接入清单](../workbench/integration-points.json)登记 Space controller/路由同步/旧存储，以及 Context RPC、生命周期、投影、Provider 加载和持久化的具体接入与回归路径。ContextRepository 继续拥有原连接及事务，本轮不搬目录或新增路由。
- `workbench:check-boundaries` 覆盖 Space/Context 功能源码与既有 Expert/MCP；清单声明的功能参加扫描，接入、回归及保留依赖有存在性和一致性校验。反例证明直接依赖完整 native 客户端、任务 store、路由、数据库或旧 Context 缓存会失败；UI、contracts 和明确的宿主入口可用。没有目录整体豁免。
- `migrations:check` 在原 lineage 检查外审计迁移归属，固定上游 tag/SHA、catalog 与新增迁移脚本来源；缺少可访问证据时明确失败。静态 catalog 不能使用未被审计的动态项、spread 等语法绕过。正式 `verify` 加入第七项 `workbench:check-boundaries`，旧六项通过不满足新门禁。
- `workbench:sync status [--main-ref REF]` 默认检查 `refs/heads/main`，只读报告请求 ref/SHA、工作区、候选绑定、目标包含关系及 lock 差异；保留历史候选状态，顶层按范围报告 `baseline-review-required`。退出码 0 只代表读取成功。`check/prepare/bind` 共用基线核对，差异未校准时拒绝推进。

### 历史兼容例外与待维护事项

`111_ContextV1` 冻结为原生 tracker 中的历史兼容例外，身份、路径及脚本 SHA-256 为 `b7dbd84911484156f3f38093973338ca005dce9e8ba4b38b8972d9dfe79a4911`；未修改编号、表名、脚本或执行历史，未执行 ledger 接管。后续 Linx 新扩展使用既有独立 Workbench ledger。该冻结不是官方来源认证，也不允许继续追加本地原生迁移。

原生迁移脚本通过 `.gitattributes` 固定 LF checkout，避免 Windows 的自动换行转换使脚本摘要与固定 Git 源码产生假差异；不归一化或忽略实际脚本编辑。本机全部现有迁移内容保持原样，Windows checkout 的实际执行仍未实测。

当前 main 已包含 v0.9.2 目标源码，旧 ref 的候选曾为 ready，当前 main 没有因此获得验收。真实只读查询返回两项差异：`candidate-main-ref-mismatch` 与 `locked-target-in-main-without-baseline-calibration`；state、upstream lock、candidate metadata 的查询前后 hashes 不变。校准说明及恢复顺序见 [WB-00](../workbench/WB-00-upstream-evidence.md#alignment-status-20261016)。tracked lock 未改成已验收，旧候选未自动退休。远端定时任务 prepare 失败继续独立维护，本轮未修改链路或触发重跑。

### 检查与实际限制

工具链为项目锁定的 Node 24.13.1 / Bun 1.4.2。最终结果如下：

| 检查             | 实际结果                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 格式、lint、类型 | 全仓格式通过；lint 0 errors、788 warnings；类型检查 7/7 workspace tasks 通过，仍有 Effect suggestions                     |
| 架构边界         | 41 个功能源文件通过；11 项边界/覆盖一致性测试通过                                                                         |
| 迁移             | 18 项测试通过；归属审计与 92 个发布 tag 的原 lineage 检查通过，111 脚本未变                                               |
| 升级工具         | 22 项 workflow 测试在串行聚焦执行中通过，覆盖范围差异、过期 lock、dirty、只读无副作用及旧六门禁拒绝                       |
| CI 与调度夹具    | CI contracts 16 项通过；weekly 的本地 full-history/worktree/cross-job bind/CAS/race 夹具通过，不代表远端 scheduled 已通过 |
| 前端回归         | host Context API 身份/连接及 Space 聚焦单测 9 项通过；Context 详情、迁移交互、Space 导航 3 份 browser 共 9 项通过         |

最终完整执行为 `mise exec -- bun run test --continue=always --concurrency=1`，保留每包原有参数，六包全部执行结束，耗时 9 分 24.802 秒，退出码 1：**13,364 通过、2 失败、36 跳过**。Web 4100、scripts 368、contracts 186、shared 828、服务端 6567 项通过；Desktop 1315 通过、2 失败。唯一失败文件为既有 `apps/desktop/src/betaChannel.test.ts`：安装后启动路径选中 `/Applications/Synara Beta.app`，以及安装失败用例返回成功。本轮未改该文件或发布/安装逻辑，未降低断言或添加 skip。完整门禁仍未全绿，不能据此宣布正式候选 ready。

完整测试各次结果独立保留：第一轮默认沙箱遇到本机监听 `EPERM`；第二轮允许测试端口，但统一传入 maxWorkers 与 CLI 原脚本重复参数，同时一项 Git workflow 测试在并发下超时。随后使用原包参数串行完成上述全仓验证，参数冲突和 workflow 超时不再出现；未覆盖前两轮的失败日志。

Browser 使用现有组件和 native API mock，未访问日用数据库，不证明真实 Provider 成功。没有修改 Provider/任务运行和数据库恢复实现；本轮未调用真实模型、执行当前源码的生产恢复、构建或安装跨平台产物。代码与规则落地不等于正式升级候选达到 ready，基线校准、远端定时运行与已知 Beta 测试问题仍分别管理。

SOP 见[开发流程](./workbench-development-workflow.md)与[升级执行](./workbench-implementation-plan.md#sync-sop)，架构规则见[适配方案](./workbench-adaptation-plan.md)。本机临时差异、原始测试日志与只读状态快照保存于 `/private/tmp/linx-alignment-e7ejz9b8`，仅作本轮复核，不作为长期运行入口。

<a id="maintenance-followup-20261016"></a>

## 2026-10-16 维护续办

用户要求继续完成基线校准、远端 prepare 失败及 Beta 问题。本轮仍在主目录 `main` 的原 HEAD 与未提交差异上工作，原 Expert/MCP 与架构对齐差异保留。

### Beta 修复

两个既有失败由测试触及本机已安装的 `/Applications/Synara Beta.app` 引起：ensureInstalled 判断已安装后跳过模拟安装器，导致启动路径与安装失败断言错误。`betaChannel.ts` 增加可选只读 `probeBetaInstall` 依赖，默认仍调用原检测；受影响测试使用临时目录探测。生产安装探测、安装器、失败语义和 Stable/Beta 隔离不变，原断言保留，没有新增 skip。聚焦文件从 30 通过/2 失败变为 32/32 通过，完整 desktop 为 1317 通过、6 既有跳过。最终完整执行 `mise exec -- bun run test --continue=always --concurrency=1`，六包全部完成、退出码 0，耗时 10 分 15.773 秒：**13,366 通过、0 失败、36 既有跳过**。其中服务端 6567、Web 4100、desktop 1317、scripts 368、shared 828、contracts 186 项通过。保留此前两项失败记录，不覆盖历史验收。

最终工作区检查：格式通过（4138 文件）；lint 0 errors、788 warnings；类型检查 7/7 workspace tasks 通过，仍有 Effect suggestions；边界扫描 41 个功能源文件、迁移归属和本地 92 个 tag 的 lineage、Windows 静态边界 279 个源文件均通过。独立只读复核未发现可行动问题。未重跑未受本次改动影响的 browser；本轮不是绑定准确候选 SHA 的正式 verify，也没有新的真实 Provider、产物、安装或恢复验收，不能宣布当前 main 或 v1.0.1 候选 ready。

### 基线与定时任务

- 历史 v0.9.2 的已验收源码、六项门禁日志及十项运行绑定已完整核对，形成来源校准草案，见 [WB-00](../workbench/WB-00-upstream-evidence.md#maintenance-proof-20261016)。自动审批首次拒绝后，用户明确确认允许写入；随后完成来源校准并完整归档原 lock/state，[结果与版本化回执](../workbench/WB-00-upstream-evidence.md#baseline-reconciled-20261016)保留旧证据。当前 status 为 no-candidate、baseline reasons 为空；未把当前 main 标为 ready。
- 实际远端 prepare 报告为 v1.0.1 合并的 30 项冲突；选择检查成功，verify/publish 正确跳过。当前源码与未提交工作已在独立 Git 副本冻结、保留同一目标的 46 项未解决冲突，原 main 未移动，未推送或重跑 workflow。详情见 [WB-05 根因](../workbench/WB-05-automation.md#maintenance-root-cause-20261016)。
- 上游与本地都占用原生迁移 111，完成升级需调整已确认的冻结/不接管策略；[兼容方案](./workbench-implementation-plan.md#v101-compatibility-proposal)已获用户明确确认推进，尚未修改迁移实现或数据库。不能把这项阻塞宣称为已完成升级。

检查日志、原始远端报告与 bundle、基线草案及隔离升级快照在本机 `/private/tmp/linx-maintenance-lb7ugot1`。没有安装应用、调用真实 Provider、访问用户数据库或更改远端设置。临时目录是本轮恢复材料，后续长期候选须另保存并按准确源码重验。
