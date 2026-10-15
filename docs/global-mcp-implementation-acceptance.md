# 全局 MCP 正式实施验收记录

> 状态：候选实现已完成本地手工验收、Global 管理面板 browser suite 与集中自动化检查；未覆盖边界按本页明确标注。记录不代表已安装、发布或合并到主工作树。

## 验收对象

| 项目                 | 记录                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 候选工作树           | `/Users/wangyuelin/.codex/worktrees/expert-frontend-redesign/synara-expert`，detached HEAD，工作树有未提交改动                                                                                                                                                                                                                                                               |
| HEAD                 | `61df29b094d3e5f2877f7787613655220a4f72a2`；未 commit、push 或合并                                                                                                                                                                                                                                                                                                           |
| 最终源码指纹         | `/private/tmp/synara-global-mcp-checks-20261005/candidate.json` 记录最终 source manifest SHA-256 `d9e179ebce6423d8091fd0a2b89440cf87c93ba0986b44dc02cfb2c096f7a51b`、7,795 个文件；包含专家全局状态标识与工具复选框 accessible-name 修正，临时诊断日志已移除。集中包测试早于最后两项 UI 修正；最终额外运行全工作区 fmt/lint/typecheck，受影响 browser 补跑覆盖末次 UI 修正。 |
| 日期 / 系统 / 工具链 | 2026-10-05；Darwin 24.6.0 arm64；mise Node 24.13.1、Bun 1.4.2                                                                                                                                                                                                                                                                                                                |
| 隔离应用状态         | `/private/tmp/synara-global-mcp-runtime-20261005/dev`；服务 `http://localhost:24743`，Web `http://localhost:24744`。本次服务监听 IPv6 loopback `::1`；`127.0.0.1` 可能不可访问                                                                                                                                                                                               |
| 本地 MCP fixture     | 手工验收期间为 `http://127.0.0.1:24746/mcp`；SDK health session `ffc2e31a-461b-49d2-84b5-df00756e1fea`。验收 fixture 进程现已退出；不要把该地址当作当前持续服务                                                                                                                                                                                                              |
| 操作与记录           | 浏览器操作由 Codex 主会话执行；本页基于主会话现场记录和隔离检查日志                                                                                                                                                                                                                                                                                                          |

## 功能与行为检查

| 检查项                              | 状态                             | 实际结果与证据                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 连接创建、编辑、revision 与删除保护 | 已验证（本地 UI）                | 创建 `acceptance-echo`（显示名“验收 Echo”，HTTP transport）并保存 v1。显式检查列出 `workbench_probe_echo`、`workbench_probe_wait`，初始均未授权。改名为“验收 Echo 更新”保存 v2 后，v1 检查结果显示已过期，没有自动重连或重测。因专家引用存在，删除按钮被禁用并显示引用说明。                                                                                    |
| 凭证解析与保存边界                  | 未做真实凭证验证                 | 本次 HTTP fixture 不需要凭证；没有读取真实主机环境变量或用户凭证。环境变量引用和脱敏行为由契约、存储与客户端自动化覆盖，不能据此声称真实凭证解析成功。                                                                                                                                                                                                          |
| 真实连接检查与工具发现              | 已验证（真实本地 HTTP fixture）  | UI 只在用户显式点击检查时连接，并显示本次发现的两个工具。独立 SDK health session 对 fixture 做了工具发现和 echo health 调用；这不是 Synara 任务，也不代表 UI 执行了 echo 工具或 Provider 任务。检查记录属于当前设置页会话，离开设置页或刷新会清空，不是持久化健康历史。                                                                                         |
| 专家授权                            | 已验证（本地 UI）                | 产品经理首次只授权 `workbench_probe_echo`；`workbench_probe_wait` 保持未选。关闭专家授权并保存后，echo 白名单仍保留且显示关闭。再次开启后清空工具，普通保存被禁用并显示原因；离开时草稿对话框列出原因，取消保留草稿，放弃返回应用接入页。                                                                                                                       |
| 专家页首次授权与返回                | 已验证（本地 UI）                | UI 设计师未授权时专家详情显示“选择工具”且不显示授权开关。跳转 MCP 时携带 expert、connection 与 return expert 定位；显式检查后仅选 echo 并保存，返回原专家详情 v2，显示 1 项工具且开关开启。                                                                                                                                                                     |
| 全局停用与专家授权独立              | 已验证（本地 UI）                | 引用确认显示 2 个专家、0 个任务、0 个活跃会话。停用后列表显示全局停用，已授权人数仍为 1；专家详情仍保留工具数和开启的 switch，并显示“已全局停用，授权和工具白名单保留，当前不可调用”。停用不写入或覆盖 expert binding。随后已恢复 active。证据：`/private/tmp/synara-global-mcp-checks-20261005/expert-disabled-global.png`。                                   |
| 状态读取失败与退役提示              | 已验证（自动化 / Web typecheck） | 专家页读取独立连接状态；加载或读取失败会标明“当前可用性未知”，不会默认显示 active。disabled、retired 的行内提示与授权开关分离。手工操作覆盖 active/disabled/active；retired 界面未单独手工操作，CAS、退役保存限制由自动化覆盖。                                                                                                                                 |
| 任务快照绑定与配置竞争              | 自动化验证                       | 全量 server 包测试覆盖绑定与 revision 相关行为。手工验收没有创建任务快照或真实 Expert 任务，因此未声称现场证明既有任务恢复固定到旧 revision。                                                                                                                                                                                                                   |
| 旧快照与 sidecar                    | 自动化验证                       | server 包测试覆盖旧 hash 兼容及 legacy binding 的安全读取语义；本次没有迁入或手工打开真实旧快照。                                                                                                                                                                                                                                                               |
| 在途调用取消与客户端关闭            | 自动化验证                       | server/runtime tests 覆盖状态撤销、调用拒绝和客户端清理。手工停用时活跃会话数为 0，没有现场在途任务可供取消；不声称观测到远端副作用撤销或真实 Provider 进程关闭。                                                                                                                                                                                               |
| 引用与删除保护                      | 已验证（本地 UI + 自动化）       | 引用视图实际显示两个专家定义引用、0 个任务、0 个会话；包括已关闭专家仍保留的白名单引用。连接删除被禁用。快照扫描、损坏引用 fail-closed 和 tombstone 由 server tests 覆盖，没有手工制造损坏数据。                                                                                                                                                                |
| 搜索、筛选、返回与草稿保护          | 已验证（本地 UI）                | 列表只提供“全部 / 已授权 / 未授权”三个筛选；搜索、detail 往返保留列表搜索/筛选。MCP 页与专家页跳转执行草稿保护。键盘 Shift+Tab、Escape、取消与放弃按现场记录验证。全局状态单独显示，没有额外状态筛选。                                                                                                                                                          |
| 窄屏、主题与字号                    | 已验证（视觉检查）               | 480px 窄屏布局通过；深色主题下设置字号 17px 时按钮计算字号 17px 并继承原生 UI 字体；恢复 System 13px 后复核。截图位于 `/private/tmp/synara-global-mcp-checks-20261005/{narrow.png,dark-large-font.png}`。                                                                                                                                                       |
| 应用接入兼容                        | 已验证（页面可访问）             | MCP 的“应用接入”显示既有原生 MCP connections 面板。仅检查现有配对 UI 可访问；没有创建配对或改变配对 scope/安全权限。                                                                                                                                                                                                                                            |
| 全局管理面板 browser suite          | 通过（5/5）                      | `VITEST_BROWSER_API_PORT=51118 mise exec -- bun run --cwd apps/web test:browser -- src/components/settings/GlobalMcpSettingsPanel.browser.tsx --reporter=verbose --testTimeout=20000`；1 file / 5 tests / 4.92s。两处工具权限 Checkbox 均以精确名称 `issues.search` 可访问。日志：`/private/tmp/synara-global-mcp-checks-20261005/global-wrapper-browser.log`。 |

## 自动化门禁

集中日志位于 `/private/tmp/synara-global-mcp-checks-20261005/`。完整包测试不是一次全仓命令单次 exit 0：剩余包在独立续跑日志中完成；桌面初跑只有一个 suite 因缺少 Electron 43.4.1 运行依赖失败，补齐隔离测试依赖后对该 suite 单独重跑通过。没有通过改测试源或增大 timeout 消除失败。

| 检查                                       | 结果                    | 日志 / 说明                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mise exec -- bun run fmt:check`           | 通过                    | `/private/tmp/synara-global-mcp-checks-20261005/fmt-check-final.log`；exit 0，4,044 个文件。                                                                                                                                                                                                                                                                                |
| `mise exec -- bun run lint`                | 通过，0 errors          | `/private/tmp/synara-global-mcp-checks-20261005/lint-final.log`；exit 0，773 warnings、0 errors。                                                                                                                                                                                                                                                                           |
| `mise exec -- bun run typecheck`           | 通过，7/7 package tasks | `/private/tmp/synara-global-mcp-checks-20261005/typecheck-final.log`；exit 0，7/7 tasks。                                                                                                                                                                                                                                                                                   |
| 全工作区包测试                             | 分组及补跑后通过        | `test.log` + `test-remaining.log` + `desktop-recheck.log`。`apps/server`（package name `@synara/cli`）6,490 passed / 26 skipped；contracts 178 passed；shared 828 passed / 1 skipped；web 4,062 passed / 3 skipped；scripts 351 passed；desktop 1,301 passed / 6 skipped，初跑未通过的 `browserUsePipeServer.test.ts` 隔离补跑 16/16。末尾增加的 web 专家状态用例另测如下。 |
| Expert 设置 browser test（最后状态修正后） | 6/6 通过                | `mise exec -- bun run --cwd apps/web test:browser -- src/components/settings/ExpertsSettingsPanel.browser.tsx`。                                                                                                                                                                                                                                                            |
| Expert draft model tests                   | 5/5 通过                | `mise exec -- bun run --cwd apps/web test -- src/components/settings/expertSettingsModel.test.ts`。                                                                                                                                                                                                                                                                         |
| 专家全局状态标识代码检查                   | 通过                    | 两文件 Oxlint 无 errors；web-only TypeScript check exit 0。                                                                                                                                                                                                                                                                                                                 |
| 导航、搜索模型与 route 聚焦检查            | 15 tests passed         | 主会话的 focused 验收记录；全工作区测试亦包含对应包测试。                                                                                                                                                                                                                                                                                                                   |

## 误触更新提示后的只读核查

2026-10-05 误点击了“Update all”，页面出现“Updating providers...”提示。只读 package.json 与文件时间检查显示 Codex 仍是 0.156.1（CLI/package 文件时间早于误点），Pi 仍是 0.87.1（CLI/package 文件时间早于误点），均与约 19:08 CST 状态快照一致；没有发现这两项安装发生变化。随后检查隔离 Synara server 进程树，没有发现仍在运行的 Codex/Pi updater。隔离实例没有保存 provider 事件日志（`logProviderEvents:false`，provider log 目录为空），因此无法完整还原 updater 命令是否短暂启动并结束、或其他 provider 的最终结果。Codex/Pi 更新命令会指向用户级路径，不能声称潜在影响仅限 isolated home。

## 范围外与结论

- MCP-2 普通任务独立选择与 MCP-3 CLI 配置导入/同步不属于本期。
- 未运行真实 Provider/CLI 任务；没有使用用户真实凭证或修改用户数据库、模型/Provider 选择或 CLI 配置。
- 没有验证 Windows、发行包、签名、正式安装、迁移或 release；没有 push、提交或合并到主工作树。
- 手工连接检查使用短生命周期本地 HTTP fixture；fixture 现已停止。操作截图不表示服务或连接仍在运行。
- 当前结论：MCP-0 / MCP-1 候选实现已完成本地浏览器和自动化范围验收；Global wrapper suite 5/5 通过。最终源码指纹为本页验收对象记录值。以上限制之外不作 Provider 全面能力或发布就绪声明。

## 2026-10-08：精简本机发现导入流程

根据用户页面反馈，将“发现结果 → 确认摘要 → 导入结果”调整为“发现结果 → 导入结果”。发现列表保留选择、逐条冲突策略和操作数量，点击“导入所选（N）”直接调用导入 RPC。导入期间禁止重复导入、修改冲突策略和返回连接列表；扫描与导入显示各自的处理中状态。

本次受检候选仍位于上述工作树，HEAD 为 `61df29b094d3e5f2877f7787613655220a4f72a2`，文件为未提交改动。本次两份代码文件的 SHA-256 为：

- `apps/web/src/components/settings/LocalMcpDiscoveryPanel.tsx`：`727543184a91cfcd7fdbe55c6bb572b6294e70a8a7fde04ec9020770f7ca1742`。
- `apps/web/src/components/settings/GlobalMcpSettingsPanel.browser.tsx`：`0ec49236c1a05aa832de8728d888155ad914e3d1cf2deca76b50608494a34639`。

主会话已审查子 agent 基于编辑前快照生成的本次变更，并集中完成以下检查。日志位于 `/tmp/synara-mcp-direct-import-20261008/`。

| 检查                     | 结果                          | 证据                                                                                                                           |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `bun run fmt:check`      | 通过                          | `fmt.log`；4,049 个文件                                                                                                        |
| `bun run lint`           | 通过，780 warnings / 0 errors | `lint.log`；受改组件无 lint 提示，browser harness 的两个提示位于既有 fixture 定义                                              |
| `bun run typecheck`      | 通过，7/7 tasks               | `typecheck.log`                                                                                                                |
| Global MCP browser suite | 通过，6/6 tests               | `browser.log`；新增用例覆盖空选择禁用、一次点击发出导入 RPC、更新携带 expectedRevision、处理中控件禁用，以及逐条成功和失败结果 |

交互方案已同步至[本机配置导入流程](./global-mcp-interaction-design.md#45-导入已有配置mcp-3)。隔离实例使用 `/tmp/synara-global-mcp-local-discovery`，Web 监听 `localhost:10033`（IPv6 loopback），server 监听 `127.0.0.1:8073`，健康接口返回 `startupReady:true`。

本次 browser 用例使用 RPC 替身验证前端交互，不代表实际导入用户配置或启动外部 MCP；没有重新执行真实 Provider、打包、平台检查或全仓库测试。上方 2026-10-05 的验收与源码指纹保留为历史记录，不覆盖本次后续变更。

### 同日后续：移除来源筛选与说明段落

移除发现页“全部来源 / Codex / CC Switch / JSON”筛选按钮及开头的说明段落，保留名称/摘要搜索、重新扫描、行内来源、冲突处理和两步导入。主会话审查了子 agent 的本轮快照 diff，补充的 browser 断言覆盖搜索框保留、筛选按钮和说明段落不显示。

本轮集中检查全部 exit 0：`bun run fmt:check`（4,049 文件）、`bun run lint`（780 warnings / 0 errors）、`bun run typecheck`（7/7 tasks）及 Global MCP browser suite（6/6 tests）。日志位于 `/tmp/synara-mcp-discovery-cleanup-20261008/`。本轮代码指纹替代上方初次两步流程记录中这两份文件的指纹，其余历史验收范围按原日期保留：

- `LocalMcpDiscoveryPanel.tsx`：`3e80a3fff40787dcd190c8abc59bbae487acd471801314f7eb5493f42042485a`。
- `GlobalMcpSettingsPanel.browser.tsx`：`1cc246a1c4caa624310462ad70a214907b2bab51a0bbf30bfa216dd72048eb74`。

## 2026-10-08：配置去重与独立导入

### 落地范围

- 发现列表按连接参数及解析后的环境变量、请求头值判断配置是否等价。等价配置合并为一行并保留多个来源；名称相同但配置不同的条目保持分开。
- 新导入连接将参数保存到 Synara，将环境变量和请求头值保存到 Synara 私有凭证文件。连接配置、前端与 RPC 只保留凭证引用和字段名，不返回凭证值。私有目录和文件权限分别为 `0700`、`0600`，采用既有 `ServerSecretStore`；当前不是加密存储。
- 原始来源仅作为导入记录。新导入配置不再在运行时读取原始 Codex、CC Switch 或 JSON 文件；导入时会重新验证所有归并来源，来源变化则拒绝对应条目。
- 既有来源引用继续兼容，不自动迁移。重新发现后选择“更新现有”可以转换为独立配置；更新仍受 revision CAS 和退役 ID 保护。旧 revision 的凭证保留，避免破坏任务快照。若配置保存已经开始但失败，也保守保留凭证文件；本轮未增加孤立凭证清理。
- 前端保留两步流程、搜索、重新扫描和逐条冲突处理；展示归并后的来源以及已保存的变量、请求头名称。导入不会自动启动 MCP、检查连接或修改专家授权。

主会话确定需求与边界，三个 `gpt-6-luna` / `max` 子 agent 分别执行服务端去重、凭证持久化和前端接入，主会话审查快照 diff 与集成结果。现有按钮、输入框、表单和字体 token 被复用；新增的凭证适配器用于接入既有私有文件存储。

### 本机与运行证据

| 检查                      | 结果                 | 证据与范围                                                                                                                                                                                                                                       |
| ------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 实际本机配置只读扫描      | 15 条归并为 11 组    | Codex 5 条、CC Switch 10 条；`codegraph`、`computer-use`、`open-design`、`zotero` 四组跨来源合并，两个配置不同的 `node_repl` 保持分开。来源扫描前后 SHA-256 未变化。`local-inventory.json`；使用临时空注册表，状态不代表当前页面中的既有连接状态 |
| 独立凭证与 stdio 生命周期 | 通过真实本地 fixture | 导入 fixture 后删除临时来源文件，重开配置和凭证存储，再连接、读取工具列表并关闭；观测到 fixture 子进程退出。没有导入、启动或调用用户现有 MCP                                                                                                     |
| HTTP 请求头解析           | 通过本地 fixture     | 测试覆盖私有凭证读取、缺失凭证拒绝及非法请求头值校验；不代表真实远程服务验收                                                                                                                                                                     |
| 隔离开发应用              | 启动就绪             | home 为 `/tmp/synara-global-mcp-local-discovery`；Web 为 `http://localhost:10033/settings?section=mcp&tab=tools`，IPv6 `::1`；server 为 `127.0.0.1:8073`。健康接口 `startupReady:true`，Web 返回 200。`dev.log`、`health.json`、`preview.html`   |

本轮没有进行实际页面手工视觉验收：先前直接预览受到权限阻止。浏览器交互由独立的测试 fixture 验证，用户可刷新当前开发页面查看真实扫描结果。

### 集中检查

日志目录：`/tmp/synara-mcp-owned-import-20261008/`。使用 mise Node `24.13.1`、Bun `1.4.2`；HEAD 仍为 `61df29b094d3e5f2877f7787613655220a4f72a2`，候选工作树未提交。`source-manifest.json` 记录本轮受影响源码的最终 SHA-256、HEAD 与锁文件指纹；上方历史指纹不覆盖本次改动。

| 检查                                         | 结果                                                    | 日志                                                                                                                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mise exec -- bun run fmt:check`             | 通过，4,051 文件                                        | `fmt.log`；验收文档补录后复查见 `fmt-final.log`                                                                                                                                                                            |
| `mise exec -- bun run lint`                  | 通过，782 warnings / 0 errors                           | `lint.log`                                                                                                                                                                                                                 |
| `mise exec -- bun run typecheck`             | 通过，7/7 tasks                                         | `typecheck.log`                                                                                                                                                                                                            |
| `mise exec -- bun run windows-runtime:check` | 静态检查通过，278 application files                     | `windows.log`；不是 Windows 运行或发行包验证                                                                                                                                                                               |
| Global MCP browser suite                     | 9/9 通过                                                | `browser.log`；覆盖合并来源、直接导入、冲突更新、处理中状态和结果展示                                                                                                                                                      |
| 集中包测试：web / shared                     | 4,068 / 828 passed，分别 3 / 1 skipped                  | `test.log`                                                                                                                                                                                                                 |
| 集中包测试：contracts / scripts              | 182 / 351 passed                                        | `test-remaining.log`                                                                                                                                                                                                       |
| 集中包测试：server（`@synara/cli`）          | 6,516 passed / 26 skipped，512 files passed / 7 skipped | `test-remaining.log`；三包续跑 exit 0                                                                                                                                                                                      |
| 集中包测试：desktop                          | 初跑 1,314 passed / 6 skipped / 3 failed                | `test.log`；全仓命令 exit 1，桌面失败后其他包分组续跑                                                                                                                                                                      |
| desktop 定向复验                             | 36 passed / 2 failed                                    | `desktop-recheck.log`；凭证库 6/6 通过，初跑超时未重现。两个 `betaChannel` 断言仍失败：本机已安装 `/Applications/Synara Beta.app`，测试进入已有应用路径，与安装 fixture 的预期不同。只读诊断未修改应用、测试源码或 timeout |
| `git diff --check`                           | 通过                                                    | 末次文档补录后再次执行                                                                                                                                                                                                     |

本次全仓测试不能记为全部通过。未发现上述两个可复现桌面失败与 MCP 改动存在调用依赖；它们保留为环境相关验证缺口。没有执行真实 Provider 任务、Windows 运行、打包签名、发布、主工作树合并、commit 或 push，也没有写回用户来源配置。
