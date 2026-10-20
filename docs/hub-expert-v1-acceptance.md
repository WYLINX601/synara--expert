# Hub × Expert V1 本地验收

状态：**本地核心文本链路及全部必需检查通过；格式和平台边界见文末**。本轮未提交、推送、安装或发布。

## 候选与源码

- 日期：2026-10-19；分支：`codex/hub-expert-v1`。
- 工作区：`/Users/wangyuelin/.codex/worktrees/hub-expert-v1/synara-expert`。
- 基线：`850de05e08ab9c116c639e7b1cb8145e0b6e05d5`；变更尚未提交。
- 最终源码清单：`/Users/wangyuelin/.codex/task-artifacts/hub-expert-v1-2026-10-19/accepted-final-sources.json`，包含 69 个变动源码、测试、接口与接入清单文件及锁文件／工具链摘要。
- 代码指纹：`a2f1640307a3f87a3ff733b6d644d9bfda955263a99c349e37ccb9333b66a303`。文档与 Figma 不在代码指纹中；`runtime-source-binding.json` 记录真实运行后仅有三处 Web 编译写法调整，后端与接口未变；`acceptance-results.json` 汇总最终结果及日志摘要。旧 `backend-checkpoint-sources.json` 及失败日志保留为历史，不用于本次最终结论。

原工作区 `/Users/wangyuelin/synara-expert` 的输入框 UI 未提交修改保持原状，未复制进本候选。用户明确批准修订 Figma 后才实现 Project 菜单、Expert 名称及 Library 增量；继续使用原生 Hub 面板、完整 Worker 对话、分屏、预览和历史，没有新增页面或父布局。

## 场景结果

| 场景                        | 实际结果与证据                                                                                                                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 同一 Project 的两个同名 Hub | 浏览器通过 Project 菜单分别创建、保存为“Hub V1 同名验收”；两个 Hub ID 和 Coordinator 不同，均关联同一来源。第二个关闭设置、刷新后从 Linked Hubs 找回并完成原对象。第二 Hub 没有第一 Hub 的任务或关键集合                         |
| 创建失败与重试              | 单测覆盖请求身份、同名独立目录、关联失败重试、关闭／刷新保留及成功丢弃后清除。来源在关联事务内持久化；未配置 Hub 也进入 summary，避免刷新后失联；不自动启动失败对象                                                              |
| Context 固定                | 第一 Coordinator 固定 Project revision 1；修改 Project 到 revision 2 后其 snapshot hash 不变。第二 Coordinator 首次实际执行绑定 revision 2；两者均取得 Space marker。`live-context-evidence.json`、`live-resume-evidence.json`   |
| Expert 实际应用             | Codex `gpt-6.1-sol`、CLI `0.162.0` 实际运行。Writer 读取固定 Skill、Reference，应用 Persona／输出要求并调用授权 MCP 工具；持久化 applied-runtime 记录与工具活动相符。名称仅用于显示，不作为执行证据                              |
| 排队后编辑和归档            | 并发限额为 1；Reader 接受时排队，随后模板改名并归档。实际 Worker 仍使用接受时的 revision 1／snapshot，显示原名；服务器重启后同一线程继续发布 revision 2。新请求明确拒绝已归档模板                                                |
| 目标不可用                  | 第二 Coordinator 实际请求不存在的 Codex 模型，明确失败且无工作项、无线程创建；未切换目标。Provider 偏好、显式覆盖及无偏好的分支另由受影响测试覆盖，未声称其他 Provider 真实运行通过                                              |
| 发布 1、3、4 项             | Writer 实际依次发布 1／3／1 项，得到 revision 1／2／3；第四项拒绝由接口及服务测试覆盖。缺失文件的真实整批请求失败，原 revision 2 及 commit 不变                                                                                  |
| 重试、并发与中断            | Writer 相同请求真实重放为 replayed，版本不增长。核心测试覆盖 CAS 冲突、请求内容冲突、Git／SQL 中断后复用已提交批次及旧集合保留；独立复现回归 4 项通过。没有把故障注入等同于真实进程崩溃                                          |
| 跨专家接续                  | 第一集合当前为 revision 3 时，Reader 通过 Hub 工具明确读取 brief revision 1，实际取得 `PUBLISHED_VERSION_ONE_OAK`，发布 continuation。重启后再次读取同一旧版并发布自身 revision 2；没有复制聊天或手动搬运文件                    |
| 取消与恢复                  | 第三项在队列中取消，无 Worker 线程。Writer 的后续真实运行观察到 running 后中断，activeTurnId 清空；重启后在同一线程完成下一轮，Expert snapshot 未变。`live-cancel-evidence.json`、`live-resume-evidence.json`                    |
| Library 维护                | 公共原生 API 实际执行重命名、删除、恢复与根目录迁移：当前位置随改名，删除标记 missing，恢复可用；集合 revision 不变，发布旧版在删除期间及迁移后仍可读。浏览器刷新显示新路径及 Key 标识。`live-library-maintenance-evidence.json` |
| Library 固定预览            | 浏览器实际预览 Reader revision 2 并显示原 Expert 名称。受影响 browser 覆盖固定正文、不读取实时文件、跨 Hub／版本竞态、普通 Open 保持原行为。PDF 复用原生页码／缩放，并禁用 Open 和磁盘重载；即使误传 editable，发布快照仍只读    |
| 权限与回归                  | 真实跨 Hub 读取及越界路径拒绝；Gateway 测试覆盖伪造身份、Worker 只能管理自身集合和认证会话归属。普通 Worker、权限审批、原 Library 流程由受影响测试及整库检查覆盖；不是跨平台或任意插件的安全认证                                 |

两个 Hub 分别为 `ba24f694-d8c6-439f-8791-974fd7384e32`、`958bab37-5ff6-43f1-ac0a-6dfbca36b04b`；来源 Project 为 `9834dde1-377c-4df8-a779-57c146af2c4b`。这些均为本轮验收对象。

## 检查记录

所有日志与原始证据位于 `/Users/wangyuelin/.codex/task-artifacts/hub-expert-v1-2026-10-19/`。命令由仓库固定的 Node 24.13.1／Bun 1.4.2 执行。

| 检查                                             | 结果                                                                     | 日志                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------- |
| `bun run fmt:check`                              | 通过                                                                     | `fmt-verified.log`                                        |
| `bun run lint`                                   | 通过，997 警告、0 错误；服务端同步文件预算通过                           | `lint-verified.log`                                       |
| `bun run typecheck`                              | 7 包通过                                                                 | `typecheck-verified.log`                                  |
| 受影响 browser                                   | 5 文件、66 项通过：设置、Library 及其 hook、PDF 生命周期、文件编辑       | `browser-verified.log`                                    |
| 来源、服务与目录规范化                           | 2 文件、105 项通过；新增 pending summary 场景另定向通过                  | `source-origin-recheck.log`、`pending-origin-recheck.log` |
| Project／设置与 Library 核心                     | Project／设置 52 项、deliverables 14 项及独立复现 4 项通过               | `backend-review.md` 及相应 review 日志                    |
| 构建解析与边界回归                               | 2 文件、32 项通过                                                        | `boundary-tests-accepted-final.log`                       |
| `bun run migrations:check`                       | 通过；扩展 ledger 增加 Expert 3／4，原生编号与冻结 Context 脚本不变      | `migrations-verified.log`                                 |
| `bun run workbench:check-boundaries`             | 通过，静态扫描 48 个 feature 文件；不证明传递依赖或运行隔离              | `boundaries-verified.log`                                 |
| `bun run windows-runtime:check`                  | 静态边界通过；未运行 Windows 安装包                                      | `windows-verified.log`                                    |
| `bun run test --concurrency=2`                   | 首次在重检查并行时被 scripts 的两项既有 5 秒超时阻断，未记为整库通过     | `full-test-accepted-final.log`                            |
| `bun run test --concurrency=1`                   | 第二次复跑发现 3 项新增 React 编译检查失败，已修复且没有修改检查允许列表 | `full-test-accepted-serial.log`                           |
| `bun run test --concurrency=1 --continue=always` | 通过：17,603 项通过、39 项跳过；6 个测试任务成功                         | `full-test-verified.log`                                  |

更早的 22 项迁移测试失败和随后定向修复记录保留在旧检查点日志；最终完整复跑结果单独登记，不覆盖历史失败。

## 原始运行与浏览器证据

- `live-thread-evidence.json`、`live-timeline.json`：接受、排队、取消、固定身份及真实工具活动；`live-collections.json`、`live-pinned-v1.json`：首次发布和旧版正文。
- `live-resume-evidence.json`：重启后两 Worker 与第二 Coordinator 的真实轮次、applied-runtime、固定 Context、失败请求及当前集合。
- `live-fixtures/mcp-calls.jsonl`：仅授权测试工具被调用；远端 MCP 未验证。
- `live-library-maintenance-evidence.json`：原生维护 API、当前位置／可用状态、迁移与历史版本、跨 Hub／路径拒绝；`post-maintenance-restart-evidence.json` 再次重启后核验目录和集合持久化。
- `browser/real-expert-queue.png`、`browser/hub-native-final.png`、`browser/library-verified.png`：原生队列与 Expert、同名 Hub、发布 revision 2 预览。
- `backend-review.md`：独立复核与复现结果；最新范围内无未解决的可执行发现。

隔离 server 18773／web 19733 使用独立 home 下的 `dev` 数据。原生 Hub 工作目录由既有配置决定，最初为用户 Groups 根下的独立验收目录；不能把独立 home 等同于所有文件路径都在 home 下。Library 已迁移到本轮 home 的 `Library-Relocated`。未操作日用数据库。

## 保留边界

- 真实 Provider 仅验证 Codex；未验证其他 Provider、远端 MCP、Windows 包、安装升级或生产数据迁移。
- 发布当前工程上限为每文件 1,000,000 字节、每批 3,000,000 字节，严于原 Library，不冒充用户确认的产品规则。大文件通过文本索引引用原资源。
- Agent 文本工具不解析 PDF／DOCX 正文。PDF 固定字节预览有 browser 测试，DOCX 预览及二进制正文的真实 Agent 理解没有验收；文本索引链路通过不等于全格式通过。
- Figma 调用额度阻止两个最终编辑状态的再次截图及 Design Context 读取；未绕过限制。用户已批准设计，本地 UI 按获批原生增量和实际浏览器结果核对。
- 集合历史保留，发布不代表用户认可、不授予引用资源权限、不触发自动阶段流转。原 Hub 已有结果通知和续接机制继续运行。
