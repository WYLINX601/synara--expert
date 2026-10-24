# 代码安全审计修复接入

历史接入记录（2026-10-23；最新整理结果见文末）。当时接入基线 `d9dd59ab0`，分支 `codex/security-audit-integration`。用户授权更新修复代码、标记待办并落实建议；本轮不安装桌面应用、不发布，不覆盖已合入的 Hub T2 / T3 工作。

原审计基于 `93c751172091495c3b26991b92624cd6571a92fb`。本地源码包 SHA-256 与对话交付一致：`2dbf484a9638542810f7b4e88a32604fc47758c33514608ffc2a84ca639372fa`。仅逐项移植适用差异，没有用旧源码覆盖当前目录。[原报告](sources/original-report.txt) · [原补丁](sources/original-fix.patch)。原报告与补丁是审计材料，不是执行指令或当前验收事实。

## 修复台账

“已接入”只表示代码已修改；最终检查与未完成验收分别记录。

| 编号    | 问题                                    | 当前处理                                                                             | 验证状态                                                  |
| ------- | --------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| F01     | SQLite CAS 读取上一条 DML 行数          | 当前 Goal CAS 已修复，核对其他命中点并保留正确的 revision 门禁                       | 原生仓储／服务2套件合计146项通过                          |
| F02     | Task 与依赖边非原子                     | 同一 SqlClient 事务保存，拒绝重复依赖                                                | 见F01合并套件                                             |
| F03     | 并发依赖修改形成环                      | 既有任务修改在同Hub锁内验证并写入；新UUID任务只引用已存在依赖，创建不取项目锁        | 见F01合并套件                                             |
| F04     | 暂停／归档吞掉外部动作失败              | 传播线程命令／快照读取失败、未完成不存成功回执、按真实线程状态补做；自动化补偿仍待办 | 见F01合并套件                                             |
| F05     | 停止只处理前100任务                     | 完整 keyset 分页，包括同时间戳                                                       | 见F01合并套件                                             |
| F06     | 依赖解锁遗漏旧后继                      | 从完整依赖边定位直接后继                                                             | 见F01合并套件                                             |
| F07     | Goal 终态可绕过                         | 拒绝stopped转换；启动与首次停止共用项目锁；停止失败不登记成功，旧停止不重发          | 见F01合并套件                                             |
| F08     | 成果读取路径替换竞态                    | 固定文件描述符、有界读取、前后身份与路径复核、finally 关闭                           | 成果套件19项通过；跨平台仍待验                            |
| F09     | MCP 重定向转发凭据                      | transport fetch 拒绝自动重定向，覆盖 POST 与 SSE GET                                 | 与技能套件合计60通过、1跳过                               |
| F10     | TOML 原型污染                           | 应用依赖与锁固定 toml 5.0.1；保留入口回归                                            | 预览固定锁已同步，实际 5.0.1 入口回归通过；完整门禁待完成 |
| F11     | TOML 同步死循环                         | 固定 smol-toml 1.9.0；子进程超时回归                                                 | 预览实际 1.9.0 子进程回归通过；完整门禁待完成             |
| F12     | 技能包列表无界并发                      | 按稳定顺序逐包验证，不跳过内容校验                                                   | 见F09合并套件，未做RSS收益声明                            |
| F13–F16 | 迟到列表、重连、分页、Hub切换与busy竞争 | 生命周期scope、事件重放、revision保护、完整分页、在途计数                            | 前端2套件20项通过，类型通过                               |
| F17     | 测试未等待异步session写入               | 仅等待原状态成立，保留断言及默认超时                                                 | REL-01B定向15项通过，其余471项是筛选未运行                |

SkillPicker 已按稳定键预建 Map，移除 catalog / package entries 的重复线性查找；不改变界面外观，不虚报大数据量性能收益。

MCP HTTP URL 现在必须直接指向最终端点，自动重定向会被拒绝；这覆盖自定义凭据头和请求体，也包括 SDK 的 SSE GET 路径。需要重定向的旧配置应改成最终 URL，不能以重新打开重定向恢复兼容。

## 待完成问题与关闭条件

| 优先级 / 项目                       | 下一步实现或验证                                                                                                                                                | 关闭条件                                                                                                                         |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| P1 旧 Goal 停止的持久补偿           | 在共享事务中记录 stop operation、Goal/准入代次、thread/turn/attempt 及稳定命令ID；异步中断并持久回执；启动时对账。不能用重复中断共享Coordinator的方式误停新Goal | 中断失败、进程崩溃、已换新Goal、重复请求均有回归；真实Provider停止与恢复验证。现有 managed plan outbox 不等于 legacy Goal 已覆盖 |
| P1 Hub自动化部分失败                | 暂停／归档相关的 automation update 仍存在吞错；需要持久记录每项变更及待补动作，不能只把 catch 改成报错后丢失已执行进度                                          | 自动化更新部分成功、重试、重启均不漏恢复；不得仅凭Hub控制字段声称自动化均已停止                                                  |
| 已关闭 F10/F11 开发依赖验证         | 固定锁实际解析 toml 5.0.1 / smol-toml 1.9.0，35 项入口回归及本轮完整仓库测试通过                                                                                | 仅关闭这两项应用依赖运行验证；Effect 的 toml 3.0.0 及其他依赖分类仍见下项                                                        |
| P1 Beta OAuth凭据归属与依赖风险分类 | Beta OAuth已确认条件可达，按下节做issuer绑定、历史凭据迁移与SDK升级验证；继续分类Effect CLI、Electron、marketing等其余公告                                      | 可达入口、前提、修复版本与兼容性证据齐全；历史扫描计数不冒充当前结果                                                             |
| P1 真实协作闭环                     | 前一轮T2记录中Luna作者未登记本线程成果；本轮未调用模型复验。不能借旧作者revision补齐；保留真实写入审批、审核固定版本与用户出口                                  | 作者→固定候选→同版本审核→人工放行→下游实测通过                                                                                   |
| P2 文件系统边界                     | Windows reparse point、持续修改目录树的同UID对手；增长文件与关闭句柄故障注入                                                                                    | 对应平台与故障测试通过；不把macOS夹具扩大成跨平台保证                                                                            |
| P2 原报告调度超时                   | 对照当前源码、默认配置重跑隔离用例与完整测试，区分环境失败与时序缺陷                                                                                            | 当前修复tree有完整退出码；不得提高超时或删除断言掩盖失败                                                                         |
| P2 Hub周期对账                      | 先测空闲CPU、SQL次数及历史增长p95，再设计活跃项索引、事件局部对账、低频全量兜底                                                                                 | 历史与活跃项均不漏恢复，提供前后基准；本轮未替换执行器                                                                           |
| P2 Library加载                      | 按需展开、有界加载、受影响目录刷新；先验证缓存和root串行锁语义                                                                                                  | 请求数、队列与超时回归通过，不新增第二缓存或改变界面流程                                                                         |
| P2 历史线程关系索引                 | 服务端窄 thread-task 索引与展示分页分离                                                                                                                         | 全历史关联完整、响应体有界；本轮完整分页先保证正确性                                                                             |
| P2 维护债务                         | 拆分大服务、统一错误与operation身份时保留锁/事务所有权；lint清理独立处理                                                                                        | 独立有边界变更与回归，不混入本次安全补丁                                                                                         |

## 复核追加：锁顺序与 SDK 风险边界

独立复核发现移植时给 `createTask` 添加项目锁会与 Gateway 的共享 SQL 完成事务发生锁顺序倒置，已移除该锁并补充并发回归。创建使用新 UUID 且依赖必须已存在，因此不可能通过新节点闭环；既有任务修改仍需项目锁。`startGoal` 与首次停止现在共享同一项目锁，避免旧停止尚在发送中断时启动新 Goal。这只覆盖单进程交错，不能替代持久补偿。

首次停止的中断失败会返回错误且不保存成功回执；Goal 可能已经持久化为 stopped。已有成功回执可以回放；已 stopped 且无成功回执的请求返回冲突，不再向共享 Coordinator 重发中断。此时不表示所有线程都已停止，必须由待办中的持久补偿协议恢复，不能靠客户端无条件重试。

SDK 仍固定为1.29.0；以下是当前源码可达性判断，不是漏洞利用实测：

| 公告                                                                  | 当前路径与判断                                                                                                                                                                                                                                      | 后续                                                                                                                                                     |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [OAuth凭据归属](https://github.com/advisories/GHSA-6qxp-vccf-f47h)    | **P1，Beta MCP Connectors条件可达**。`mcpConnectors/runtime.ts` 的登录调用 `auth()`，可重用自己的应用凭据；刷新直接调用 `refreshAuthorization()`。授权服务器由discovery指定，现有出站origin限制只约束每次请求及其重定向，没有把凭据绑定到可信issuer | SDK升级只是其中一步；绑定凭据issuer，迁移或清除缺少issuer的旧凭据，显式核验直接refresh/exchange路径；增加恶意discovery、历史凭据及合法跨源授权服务器回归 |
| [HTTP/OAuth重定向](https://github.com/advisories/GHSA-6prh-2h8m-c8cw) | 产品Expert HTTP路径本次禁止重定向；Connector OAuth出站校验每次重定向origin，代理禁止重定向。`scripts/expert-p0/gateway-live-server.ts` / `gateway-probe.mjs` 的探针客户端仍使用原SDK行为                                                            | 探针不属于生产运行，但使用真实凭据前也应沿用同等保护                                                                                                     |
| [实验任务跨会话](https://github.com/advisories/GHSA-22jm-h49p-29qw)   | 未发现产品启用SDK taskStore或experimental tasks；仅有不支持任务工具的错误文案                                                                                                                                                                       | 当前未证明可达；将来启用前复查                                                                                                                           |
| [服务端校验DoS](https://github.com/advisories/GHSA-46jr-4wx8-v453)    | 产品使用自定义Effect路由，未使用SDK的McpServer/HTTP ServerTransport；SDK服务端出现在夹具／探针                                                                                                                                                      | 该SDK路径未证明产品可达，不代表所有自定义JSON校验均已审计                                                                                                |
| [服务端Bearer受众](https://github.com/advisories/GHSA-rvq5-wwqv-78pq) | 产品路由使用Synara会话与Connector grant校验，没有调用SDK服务端Bearer中间件                                                                                                                                                                          | 当前未证明可达；保留锁文件命中                                                                                                                           |

对应入口见 [Connector runtime](../../apps/server/src/mcpConnectors/runtime.ts)、[OAuth provider](../../apps/server/src/mcpConnectors/oauth.ts)、[Connector路由](../../apps/server/src/mcpConnectors/httpRoute.ts)、[Gateway路由](../../apps/server/src/agentGateway/httpRoute.ts)。Beta门禁仍由现有服务端特性限制负责，本轮未打开或关闭功能，也未修改现有凭据。

Effect的 `Primitive.fileParse({format: "toml"})` 仍依赖toml 3.0.0；当前应用使用Effect CLI，但未找到调用该TOML parser的产品入口。因此记录为传递依赖风险与可达性待确认，不强制覆盖上游major约束。其余扫描命中仍按当前锁逐项分类，不能从本节五项推导整棵依赖树已关闭。

## Hub V0.8 建议与当前实现的对照

- 事件：当前 `hub_plan_events.sequence` 由数据库全局 AUTOINCREMENT 分配，Hub / plan 过滤后允许合法间隔。快照读取相同事件表的 MAX；客户端按游标去重并重新获取，不依赖数值连续。无需为了符合旧提案改写已运行迁移。
- 全局命令：预设回执使用 operation scope、aggregate ID、request ID 与payload摘要；当前是本地owner授权模型，不声称已有多租户owner隔离。
- 作者：每阶段单作者已由 `planGraph` 验证，并有 author_count 反例；T3并行审核不等于开放多作者候选。
- carry-forward：目前只有纯影响分析；originRevision、effectiveRevision、授权代次、任务绑定迁移及迟到结果的运行规则仍属T3待办，不把结构候选当沿用授权。
- 信任：owner会话不等于不可被全权限Agent控制的真人确认；独立凭据、进程和可信确认通道需要单独设计与威胁建模，当前不能宣称已实现该隔离。
- 认证顺序：先认证与当前Hub/回执访问权限，再幂等、CAS；不要为了回放旧结果恢复已撤销的执行权。事件、回执、outbox的总大小及保留策略仍待定义，不能直接删除授权历史。

## 2026-10-23 验证与限制（历史）

安全公告已核对维护者原始资料：[TOML 原型污染](https://github.com/advisories/GHSA-v5mp-jgw5-2x6j)、[smol-toml 死循环](https://github.com/squirrelchat/smol-toml/security/advisories/GHSA-7w5x-hrqm-74c2)。

当前锁文件只读扫描命中37个包、151个去重公告URL，详见[扫描记录](dependency-findings.json)。这是版本命中，不等于151条已证实可利用链；与原报告38包、152公告的输入不同。Effect保留的toml 3.0.0传递依赖仍在锁中，不能声称依赖树风险清零。

本轮代码仍为未提交差异，未合入main。受检代码差异SHA-256（`git diff -- apps packages scripts package.json bun.lock`，不含本文）：`8dc60edd383fb56f25e52442f26b6d37ff0badb5d1d8ee782751a929ce7a0684`。独立复核确认新增锁倒置与首次停止／启动竞态已消除；以下通过项不包含新TOML依赖的运行验收。

| 检查                                 | 本轮结果                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `bun run fmt:check`                  | 通过，5087个匹配文件                                                                                |
| `bun run lint`                       | 通过，0错误／1071警告；同步文件系统预算通过                                                         |
| `bun run typecheck`                  | 7/7包通过；使用现有node_modules，不等于新依赖验证。Turbo仍提示既有nested override锁文件格式解析警告 |
| 原生仓储与服务                       | 2套件146通过，包括事务回滚、并发环、完整分页、失败回执、锁倒置和停止／新Goal交错                    |
| MCP Client与SkillPackageStore        | 2套件60通过、1原有Linux专用大小写测试在macOS跳过；本地HTTP夹具，不是真实远程MCP验收                 |
| Hub Deliverables                     | 19通过，包括文件路径替换夹具                                                                        |
| useProjectAgent与SkillPicker browser | 2套件20通过，包括切换、禁用、迟到响应、重连、分页、事件竞争及busy计数                               |
| ProviderCommandReactor REL-01B       | 15通过，471筛选未运行；没有增加测试超时或删除断言                                                   |
| 边界／迁移／Windows静态检查          | 通过；Windows静态扫描不等于Windows实机文件系统验证                                                  |
| McpConfigSource新回归                | 旧toml 3.0.0下2/8失败（原型污染与整数边界），并未关闭。新5.0.1未安装，待正确依赖后复验              |
| Codex TOML死循环回归                 | 已改为子进程5秒硬超时保护；新smol-toml 1.9.0未安装，运行验收待做                                    |
| 完整 `bun run test`                  | **本轮未执行**；先完成获准的固定锁依赖同步及TOML定向验证，再跑全仓，不沿用前一轮Hub测试计数         |

重现命令均使用 `mise exec --`，服务器测试在 `apps/server` 执行 `bun run test --` 后指定台账中相应测试文件。前端在 `apps/web` 执行 `env VITEST_BROWSER_API_PORT=51101 bun run test:browser -- src/components/chat/project/useProjectAgent.browser.tsx src/components/settings/SkillPicker.browser.tsx`；REL-01B筛选为 `bun run test src/orchestration/Layers/ProviderCommandReactor.test.ts -t 'REL-01B gate'`。

早期未提升权限的组合运行曾报告14个失败，包括loopback EPERM、2项TOML回归及2项后来修正的macOS canonical路径断言；修正后MCP/Skill与成果套件分别重跑通过，TOML两项失败仍按上表保留，不能用其他套件通过冲销。格式、lint、类型最终日志位于本机 `/tmp/synara-audit-final-*.log`，其余定向结果保留于本次工具输出。

开发依赖下载曾被自动审批拒绝，理由是之前“不安装”的授权边界未区分应用与开发依赖；已单独请求澄清。拒绝后不绕过执行，不把旧node_modules对新锁文件的运行记为通过。没有安装应用、改日用数据库或进行真实收费模型调用。当前属于可审阅修复候选，依赖同步、完整测试及上列P1未关闭前，不报告整体验收完成。

## 2026-10-24 独立预览依赖补验

用户已澄清“不安装”限制针对桌面应用，允许同步开发依赖、测试与浏览器构建。未触碰原 node_modules，已在独立预览 `/Users/wangyuelin/.codex/worktrees/browser-preview/synara-expert` 按固定锁、禁用安装脚本完成依赖同步，实际应用解析 toml 5.0.1 / smol-toml 1.9.0。

在预览 `apps/server` 执行 `mise exec -- bun run test -- src/experts/McpConfigSource.test.ts src/git/Layers/codexTextGenerationIsolation.test.ts`，**35 项通过**，包括此前未通过的 TOML 入口回归和子进程保护。日志 `/tmp/synara-browser-preview-toml-tests.log`。这补齐 F10/F11 的定向运行证据；上方旧环境失败及未安装记录保留为历史，不再表示当前预览的依赖版本。P1 完整门禁、其他依赖风险、停止补偿与真实模型闭环尚未关闭，不报告整体验收通过。

原审计 diff 和 24 份文件在搬迁前固定保存并核验，预览基线追加了两项环境支持提交（`c3dfb98c9`、`8f7143cf6`），审计增量仍未提交/合入。日用固定构建不含这些审计修复；双环境的实际状态与备份边界见[环境记录](../browser-environments-2026-10-24.md)。

## 2026-10-24 候选整合复核

整合基线为 `8f7143cf6f001aa495d57f0e3867a91c3cb9f351`。本节取代上方历史记录中的“依赖未安装／完整测试未执行／未提交”进度；历史失败和原始输入保留，不改写原报告。

本轮独立复核修复了一个新增的前端时序问题：重连 snapshot 是刷新信号，不再作为 delta 回放覆盖较新的 API overview。浏览器回归验证 rev1 snapshot、rev2 API 结果和迟到首个请求，保留最新 config、goal 与 coordinatorStatus。SkillPicker 和该 Hook 合计 21 项 browser 测试通过；未改变布局、视觉文案或业务操作入口。

完整运行先出现 scripts 的两项 5 秒超时，原配置单文件 22/22 通过；降低包级并发的运行随后暴露 MCP HTTP 夹具 30 秒超时。已为夹具补上 5 秒有界启动等待及 finally 中的连接清理，避免原始失败被无界 teardown 遮蔽。关闭与取消断言仍在夹具强制清理之前执行；没有提高超时、删除断言、增加 skip 或改变产品 MCP 生命周期。该文件 14/14 通过后，重新执行完整门禁。

| 最终检查                                                 | 结果                                                       |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| `bun run fmt:check`、`bun run lint`、`bun run typecheck` | 全部通过；lint 0 errors，保留既有 warning；类型 7/7 包通过 |
| `bun run test --concurrency=1`                           | 18028 通过、40 原有跳过，退出 0；断言及原有超时未放宽      |
| affected browser                                         | useProjectAgent 14、SkillPicker 7，共 21 通过              |
| 边界、迁移 lineage、Windows runtime 静态检查             | 通过；不代表 Windows 实机通过                              |
| 固定开发依赖                                             | 应用 toml 5.0.1、smol-toml 1.9.0；实际模块入口回归通过     |

全量日志、逐文件输入摘要及提交回执保留于本机 `.synara/browser-environments/consolidation-20261024/`；不将带本机数据的操作记录提交 Git。逻辑补丁和环境／工作流程文档分别提交，已安装应用仍保持 0.1.5 的原验收源码，不由本次代码整合自动更新。

以上只表示这一批适用修复完成代码检查。旧 Goal 停止持久补偿、Hub 自动化部分失败补偿、Beta OAuth issuer 绑定及剩余依赖分类仍是 P1 待办；真实协作成果／同版本审核／人工放行、跨平台及性能专项仍未验收，不能声称整轮安全审计全部关闭。
