# Expert 中心实现与验收

2026-10-29 存储收口补充：本文所述旧私有交付目录及恢复集已按用户要求退役；必要记录归入最新交付的 `history/`，现行恢复入口见[清理记录](./storage-management-2026-10-24.md#delivery-cleanup-20261029)。下文保留当时的交付事实。
日期：2026-10-28。用户已批准产品方案并要求实施。初次实现位于 `codex/expert-center` 隔离开发分支，基线 `2577e5819353e6089cc3f6e118e848f38df04913`；下文初始实施验收保留其时点范围；本轮已提交合入本地 main 并更新日用应用至 0.1.7，见文末交付结果。代码摘要见[源码清单](./expert-center-evidence-2026-10-28/source-manifest.json)。

后续用户要求将专家团与技能库一并移入专家页；该补充已更新至 0.1.9，见[整合验收](./expert-center-organization-2026-10-28.md)。以下保留 0.1.7 的原始实施与交付记录。

## 交付范围

| 能力       | 实际实现                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| 专家库     | `/experts` 列表与 `/experts/$expertId` 详情；卡片/搜索/归档筛选、能力/设置及原管理操作复用                    |
| 编辑保护   | 单一父路由控制器，共享草稿；页签切换保留输入，跨对象/离开保存保护，错误 ID 不复用旧内容，新专家保存后定位详情 |
| 使用此专家 | 原生新任务流程的 standalone 选项；当前任务的项目/工作区通过来源 ID 传递，首次发送才执行，旧草稿与主槽保留     |
| 历史       | 按实际绑定 ID、版本读取现有 shell；归档可见，删除排除；状态/项目/时间，50 条分批渲染，断连与同步状态降级      |
| 相邻功能   | 旧设置保留专家团并跳转个人 Expert；MCP 进入/返回保留允许的上下文；配置、授权、应用接入与后端执行语义不变      |

无新增 RPC、数据库迁移、Provider 或 Gateway 实现。接入声明见 [integration-points](../workbench/integration-points.json) 的 `web.expert-center`；该检查只证明静态导入边界。

## 验证记录

| 检查                           | 结果                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| 格式、lint、全工作区 typecheck | 通过；lint 有仓库告警，0 错误；typecheck 7/7 包成功                                               |
| 聚焦 Vitest                    | 草稿/首发 49、历史与同步 6、导航兼容 127 项通过；同时纳入完整测试                                 |
| 浏览器交互                     | 共 40 项分别通过：Expert 编辑器 32、历史列表 1、旧设置装配 3、原生启动 hook 4                     |
| 静态接入边界                   | 通过，116 个源文件                                                                                |
| 全库测试                       | `bun run test --concurrency=1` 通过：6/6 包，18,337 tests passed，40 既有 skipped；耗时 17m5.938s |
| 独立审查                       | 首轮发现 3 项，已修复并复核通过：PR 误用主草稿、异步准备抢回导航、入口丢来源工作区                |

首轮 `bun run test` 并行执行出现 3 个未改动桌面测试超时（`cuaDriverHost` 2 项、`browserSessionRestore` 1 项），触发其他包中断。随后使用 `bun run test --concurrency=1` 降低包级资源争用，不跳过测试；桌面重跑 1444 项通过、6 项既有跳过。

浏览器测试最初因本地端口监听权限未能启动，使用获准的本地测试执行后完成。新增页签保护用例第一次等待了取消导航后不结算的导航 Promise，导致测试超时；修正测试为检查取消后的地址和保留输入，再跑通过。没有以提高超时掩盖业务失败。

## 隔离真实运行

- 单独实例：后端 `127.0.0.1:19851`，Web `localhost:19852`；独立 home 与托管工作区，无日用数据库复制或回写。
- 从测试项目主草稿进入 Experts，URL 携带实际项目/来源线程；点击使用专家直接进入新的空草稿，没有重复项目确认，Expert 为“产品经理”。
- 使用当前原生 Codex 设置，发送仅要求返回固定文本的验收消息；收到 `EXPERT_CENTER_OK`。重新进入同一任务续跑，收到 `EXPERT_RESUME_OK`。
- 返回原草稿，正文“原有项目草稿：保留这段内容，不发送。”和“通用”专家选择均保留。
- 历史显示 1 条任务，绑定“产品经理 · 修订 1”，状态“回合已结束”，不是任务验收成功。截图见下。
- 首轮真实任务期间主会话移除了新设置壳中的 3 行未用声明，原生工作区差异面板因此显示 1 个文件变化；该差异是主会话清理，不将它作为 Provider 写文件的证据。

![真实历史页面](./expert-center-evidence-2026-10-28/history.png)

未验证所有 Provider、Windows、签名打包或安装；本次不声称这些路径通过。没有新 MCP 协议行为，未额外调用外部业务工具。

## 环境与恢复

- 实施时源码：`/Users/wangyuelin/synara-expert/.synara/expert-center-source`，分支 `codex/expert-center`。独立锁定依赖；检查使用仓库指定 Node 24.13.1 / Bun 1.4.2。该临时树在合入和安装完成后已核验回收；当前源码位于主目录，受管预览见文末。
- 初次依赖安装由当前 shell 的 Bun 1.4.0 执行 frozen lockfile；锁文件未变，最终检查切换到指定工具版本。
- 测试 home：`/Users/wangyuelin/synara-expert/.synara/expert-center-runtime`；保留最小测试任务与草稿供复核，不回写日用。
- 桌面工具最初创建的空树 `/Users/wangyuelin/.codex/worktrees/expert-center/synara-expert` 是当前任务主 checkout，归档曾被原生工具拒绝。后续已将其干净同步到 main，复用为唯一受管预览，不再保留无用途的空树。实施阶段所有检查使用上述临时源码路径，交付后主目录及受管预览均有同一代码。
- 预览已正常停止；19851/19852 监听均关闭，本轮已知服务、Codex 与其 MCP 子进程均不再存在。截图和最小测试 home 保留，界面验证用临时页已关闭。
- 初次实施结束时未提交、合并、安装或发布；后续授权及实际交付以文末为准。

## 2026-10-28 提交与安装交付结果

用户授权提交合入与更新日用应用。提交前审查补齐了 standalone 草稿仅改 Expert/项目/工作区元数据时的回滚保护；新增两项延迟导航回归，修后独立复核通过。

| 项目           | 实际结果                                                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 源码提交与合入 | `7af8e7f0971d124a7720aa941e3d564a26087acb` 已快进合入本地 main；包含已批准的独立 Expert 页面、启动衔接、历史页及必要导航，版本配置仅 Workbench 升为 0.1.7  |
| 最终门禁       | 格式、lint、7 包 typecheck 通过；最终全库 6/6 包通过，18,337 tests passed、40 既有 skipped，耗时 16m19.075s；浏览器交互累计 40 项通过；构建专项 21/21 通过 |
| 本机产物       | 固定源码/锁文件构建 macOS arm64 DMG/ZIP；包内版本、flavor、源码、锁摘要、完整文件清单与 deep/strict codesign 通过；隔离原生依赖及实际产物启动通过          |
| 日用应用       | `/Applications/Personal Workbench.app` 已从 0.1.6 更新至 **0.1.7 并启动**；包内来源仍为 7af8e7f09，沿用原 `.synara-workbench` home 与 Electron profile     |
| 数据与恢复     | 原生生命周期锁内完整备份 home/profile；SQLite backup API 一致性校验、副本迁移层和 105 张原表旧列逐行摘要核验通过；未替换日用数据库                         |
| 安装后核验     | 新进程与原 home 的原生锁 PID 一致，health=ok；已认证只读快照核验原 32 线程、308 消息、3 Space、18 Project 的全部 ID 保留；699 个受保护配置/资源摘要不变    |
| 原生界面       | 已安装窗口显示独立 Experts 入口和原有 12 个专家；原专家的 Skill/MCP 配置可读，历史显示原任务与当时修订 3/4，没有改写成当前版本                             |

首轮构建缺少本机 `actool`，随后发现 Rust 未在当前 PATH。采用构建器已有的正式输入：经摘要校验的上一版原包 `Assets.car`，以及来源、补丁、架构、编译器记录和二进制摘要均符合当前锁定版本的原生 Cua 构建缓存。没有改写 provenance、放宽校验或安装新的全局工具链。最终通过后才安装；失败尝试日志保留在本机交付目录。

本机交付与恢复目录：`/Users/wangyuelin/synara-expert/.synara/expert-center-delivery/`。`installation-result.json` 状态为 `installed-and-started`；`recovery-set/` 保留完整一致性 home/profile、干净 0.1.6 回退应用及原安装应用。现行操作入口 `application/installation-receipt.json` 与 `application/latest-application-backup.json` 已更新，上一份指针原样保存在恢复集。回退前须停止应用并保护更新后新增数据，使用匹配程序与数据组合。

| 产物                               | SHA-256                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| app.asar                           | `0e980f6a04229c3fd81892230073614463ec394b970f0f3c57784a54efff5527` |
| Personal-Workbench-0.1.7-arm64.dmg | `9e5f4769cef0e11946b5a00c307ac8a6feac4bfb038b505b06e1a5a03c3ac022` |
| Personal-Workbench-0.1.7-arm64.zip | `b187b921da79ed8723277e31927d37750ac8135dc436f348d1e300f79323c205` |

这是本机 ad-hoc 更新，未经 Developer ID 签名或公证；没有创建发布 tag、推送、上传二进制或更改自动更新 feed。未进行 Windows/Linux 实机验收。

交付收尾：目前 Git 仅登记主目录 `/Users/wangyuelin/synara-expert` 与受管预览 `/Users/wangyuelin/.codex/worktrees/expert-center/synara-expert`。临时开发树在确认源码已合入、无未提交/独有成果及文件占用，并保留失败浏览器截图和测试日志后回收；两个可从已校验 ZIP 重建的解包目录也已回收，完整恢复集和原包保留。图标输入恢复引用已改指向恢复集中的 0.1.6 原应用，不再引用退役解包路径。

最小隔离测试 home 保留在 `.synara/expert-center-runtime`；其中测试项目仍记录原临时源码路径，若需重演，应先从 `codex/expert-center` 固定提交重建该工作树并安装锁定依赖，再按隔离端口启动，不将该测试 home 用于日用应用。早期主目录方案草稿保存在 Git stash `ac5fe91d92ff6077a807c66ee25f7d1af7c82b03`，未覆盖或丢弃。

## 2026-11-03 默认 harness／模型修复

本次为独立修复分支交付，不替换上述历史安装记录；未合并 main、未构建或安装日用应用，未恢复 Graph。

- Expert 设置改为复用原生对话框的一个模型按钮，支持 harness、账号、模型、effort 的保存、刷新回显和清除。Hub 显式 target 覆盖已保存默认值；原生任务草稿带入默认值并允许局部覆盖，不回写 Expert。
- 隔离真实页面保存并刷新回显 `OMP / GPT-6.1 Sol / High`；产品经理任务草稿带入相同选择，改为 `GPT-6 Luna / Low` 后，读取 Expert 保存值仍为原来的 `Sol / High`。未发送消息或运行 Provider 回合，不能据此声称真实 Provider 派发成功。
- 受影响服务端 5 文件 115 tests、Web unit 5 文件 91 tests、浏览器 3 文件 69 tests 通过；contracts 32 文件 287 tests、shared 104 文件 1,114 tests 通过（2 skipped）。保存／清除、模型可用性、显式覆盖、冻结与草稿隔离均有行为覆盖。
- 格式、lint（0 errors）、7 包 typecheck 与 115 文件静态接入边界检查通过。边界检查证明清单和依赖规则，不证明完整运行时隔离。React Doctor 以本地 main 为基线扫描 17 文件，72/100；4 项小列表循环内查找警告，未为理论优化额外改写现有选择逻辑。
- 全库 `bun run test` 未通过。完整原始日志复盘纠正此前只列 4 项的漏报：至少 **23 项失败、8 个文件**，包括 desktop `backendShutdown.posix.integration` 1、`cuaDriverHost` 1、`macAppIcon.native` 1；Web `storeNormalization` 1、`ChatMarkdown` 5、`wsNativeApi` 2；scripts `workbench-build` 5、`workbench-sync` 7。contracts、shared 和 desktop 有包级终态，其余被 Turbo 中断，缺少最终断言详情；`storeNormalization` 仅有 7,390ms 的失败标记，不能据耗时直接归因超时。相关文件未改动不证明失败在变更前已存在，也不构成正式集成验收。
- 验收期间集成浏览器坐标点击偏移，关闭通知的操作误触 Provider 更新；服务端记录 Codex 更新至 0.166.0、Pi 从 1.1.0 更新至 1.5.0，Pi 扩展未更新。已通知用户并报告工具问题；该主机侧变化不属于修复内容，未自行降级或重启。后续交互改用精确键盘定位。
- 独立预览使用隔离 home 与端口；原始验收标签存在用户未保存编辑，因此保留该标签和隔离数据，不丢弃或覆盖。未更改日用数据库；隔离 home 并不能隔离系统级 CLI 安装。

## 2026-11-03 测试失败复盘与修复

范围：接续 `ae1425f3c` 的 `codex/fix-expert-default-model`，修复测试执行问题并取得全包终态。最初仅授权独立分支；用户随后明确授权更新、推送并合并到 GitHub main，需通过适用门禁后执行。不恢复 Graph，不安装应用，不处理上一节的 Provider 更新事故，也不覆盖用户预览编辑。

### 完整失败清单与隔离对照

首轮原始日志至少 23 项失败；此前仅报告 4 项是漏报，已在上节纠正。该轮只有 contracts、shared、desktop 有包级终态，不能把其他包的中间通过标记相加当作完整验收。

| 文件组                                      | 首轮失败数 | 隔离检查结果 | 判定与处理                                                                                                                      |
| ------------------------------------------- | ---------: | ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| desktop `backendShutdown.posix.integration` |          1 | 2/2 通过     | 原断言为 SIGTERM 日志为空、最终 SIGKILL；保留 TERM→KILL 和退出边界，不修改生产时限或断言                                        |
| desktop `cuaDriverHost`                     |          1 | 157/157 通过 | 原失败为请求 1,000ms 超时、effect 为 dispatched-unknown；保留输入释放失败后永久关闭 admission、不重放和不替换 generation 的断言 |
| desktop `macAppIcon.native`                 |          1 | 1/1 通过     | 原失败为 5,000ms 超时；实际操作仅临时测试 bundle，未扩大预算                                                                    |
| Web `storeNormalization`                    |          1 | 29/29 通过   | 原日志只有 7,390ms 失败标记，未取得具体断言；保留后台所有权、任务列表和终态裁剪断言，不直接归为超时                             |
| Web `ChatMarkdown`                          |          5 | 60/60 通过   | 原冷导入／渲染失败在隔离执行及后续按包串行运行中未再出现；保留双向文字、HTML、alert 和 streaming 行为                           |
| Web `wsNativeApi`                           |          2 | 53/53 通过   | Context 身份和 user-input 答案过滤原断言保留，无实现改写                                                                        |
| scripts `workbench-build`                   |          5 | 21/21 通过   | 临时本地 Git／产物夹具验证，无真实发布；不放宽祖先、标签或来源校验                                                              |
| scripts `workbench-sync`                    |          7 | 15/15 通过   | 临时本地 Git 远端验证；不改变候选、冲突或脏工作区保护                                                                           |

隔离命令（路径分别相对包目录）：

```bash
bun run --cwd apps/desktop test src/backendShutdown.posix.integration.test.ts src/cuaDriverHost.test.ts src/macAppIcon.native.test.ts --maxWorkers=1 --no-file-parallelism
bun run --cwd apps/web test src/storeNormalization.test.ts src/components/ChatMarkdown.test.tsx src/wsNativeApi.test.ts --maxWorkers=1 --no-file-parallelism
bun run --cwd scripts test workbench-build.test.ts workbench-sync.test.ts --maxWorkers=1 --no-file-parallelism
```

三个命令分别为 160、142、36 项通过，耗时 77.58s、5.50s、9.75s；这只是失败组隔离证据，不代替最终完整运行。

### 根因与最小修改

1. 根入口曾同时启动多个包，每包 Vitest 又按整机可用核数建立 worker 池，造成嵌套并发资源竞争；默认失败即取消又截断其他包的终态。本轮只将根 `test` 改为 `turbo run test --concurrency=1 --continue=always`，保留包内 worker 设置、测试时限、所有断言及跳过状态。隔离及按包串行结果与资源竞争解释一致，但未将缺少断言详情的历史失败逐项武断标成超时，也未据此声称发现产品逻辑缺陷。
2. 新增 `scripts/workspace-test-runner.test.ts`，实际运行三个临时包，以排他资源探测并发重叠；覆盖全部成功，以及一个包失败后依赖包和独立包仍完成且总退出非零的两条路径。聚焦 2/2 通过；另做真实失败注入 smoke，临时夹具均回收。没有只断言命令文本或弱化业务／安全测试。
3. 首次按包串行全库随后暴露 `workbench-sync-workflow` 的 9 项明确断言失败。原因不是时序：默认 PATH 的 Node 22.23.1／Bun 1.4.0 被 prepare 记录，fixture／verify 则按仓库锁定的 24.13.1／1.4.2 检查，正确拒绝不匹配候选，导致后续状态与证据断言失败。所需版本已安装，仅用 `mise exec` 选择，不安装、升级或修改全局 PATH，不绕过 toolchain／候选安全门。
4. `mise exec -- bun run --cwd scripts test workbench-sync-workflow.test.ts --maxWorkers=1 --no-file-parallelism` 已确认 Node 24.13.1、Bun 1.4.2，22/22 通过。CONTRIBUTING 与开发 SOP 补齐工具链、串行调度、失败汇总和避免重检查叠加的约定。

首次按包串行、但工具链未纠正且最终被中断的一轮：desktop 1,444 passed／6 skipped，shared 1,114／2，Web 5,580／3，contracts 287／0；scripts 431 passed／9 failed；server 无终态。该记录保留失败，不冒充最终全过。

### 2026-11-04 最终完整覆盖与交付边界

基线为 `ae1425f3c` 加本轮根测试入口、真实 runner 回归及文档变更；产品源码、锁文件与已有测试断言在续验期间未变。统一使用已安装的 Node 24.13.1／Bun 1.4.2。以下是每个完整包或原生分片的最终汇总，不是累加中断前的单项通过：

| 包／分片   |     passed | failed | skipped |
| ---------- | ---------: | -----: | ------: |
| Web        |      5,580 |      0 |       3 |
| shared     |      1,114 |      0 |       2 |
| desktop    |      1,444 |      0 |       6 |
| contracts  |        287 |      0 |       0 |
| scripts    |        440 |      0 |       0 |
| server 1/3 |      3,421 |      0 |      11 |
| server 2/3 |      2,296 |      0 |       4 |
| server 3/3 |      3,984 |      0 |      16 |
| **合计**   | **18,566** |  **0** |  **42** |

server 三片覆盖完整包，共 9,701 passed、31 skipped；使用当前 `ci.yml` 和 `release.yml` 的三分片机制，保持单 worker／不并行文件。当前 CI 已是三片，历史 CI 性能文档中的两片不代表现行配置。本轮没有新增 skip，也不把历史版本的 40 skipped 移用为本轮数量。

```bash
mise exec -- bun run test
# 上一命令中 Web/shared/desktop 已取得终态；外部中断后，仅续跑未完成包：
mise exec -- bun run test --filter=@synara/scripts --filter=@synara/contracts
mise exec -- bun run test --filter=@synara/cli -- --shard=1/3
mise exec -- bun run test --filter=@synara/cli -- --shard=2/3
mise exec -- bun run test --filter=@synara/cli -- --shard=3/3
```

完整覆盖来自同一代码与锁定环境下的分包／原生分片续验，并非一次未中断的根命令成功。外层 runner 曾在 SIGTERM 中断后显示 exit 0，但 Tasks 为 0 successful／3 total，缺少包级终态；该次明确不计为通过。持久服务标记没有阻止那次子任务中断，后改为逐片保留完整终态。

- 最终 Expert 浏览器专项 3 文件 **69/69** 通过，覆盖单按钮保存／回显／清除、effort、不改聊天默认值、原生草稿默认值与覆盖。
- `fmt:check` 5,201 文件通过；lint **1,163 warnings、0 errors**，server sync-fs 通过；typecheck **7/7 包**通过，保留建议性诊断。
- 接入边界 115 文件通过；Windows 静态边界检查覆盖 324 应用源文件、119 边界文件、4 依赖补丁和 9 workspace manifests，通过；migration 归属与 92 个 release tags 的 lineage 检查通过。静态 Windows 检查不代表 Windows 实机运行。
- Turbo 仍报告现有 `bun.lock` 解析警告；各包实际执行、缓存关闭，并已读取完整终态，不依赖该警告推断成功。Browserslist 数据过期提示未通过安装或更新依赖来消除。
- 本轮未改生产取消、输入释放、admission、重放或进程退出逻辑；未调用真实 Provider 回合，未安装、升级、降级或重启日用应用／Provider。原预览进程已随先前中断退出，保留隔离数据及原始未保存页，不擅自重启或丢弃编辑。
- 本记录固定本地验收与用户授权范围；GitHub 合并结果以关联 PR 的实际状态为准，不把本地检查当作远端 CI、签名发行或安装成功。
