# Synara Space / Project Context V1.1：前后端实现

日期：2026-10-15。产品范围以 [V1.1 交互 PRD](./space-project-context-v1-interaction-prd.md)为准；实际检查和运行结果见[接入验收](./space-project-context-v1-acceptance.md)。旧[独立原型](./prototypes/space-context-v1/README.md)保留作交互历史参考。

## 1. 交付边界

本轮在原有 Sidebar、Space 编辑弹窗、Environment 与 Chat 中接入真实配置和执行链路。配置统一由服务端存储，浏览器只持有草稿。Hermes、Memory、知识库和安装包发布不在本轮范围内。

当前产品源码已固定为本地功能提交 `3a754ee69`，后续开发以主目录的本地 `main` 为入口。最初的隔离 Context 候选保存为 `4b3705f0b`，保留作历史证据；最终整合清单与检查范围见[接入验收第 8 节](./space-project-context-v1-acceptance.md#8-2026-10-15-浏览器版整合补充)。原测试实例与正式数据库保持独立。

## 2. 数据与所有权

| 对象         | 内容及责任                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| Space 配置   | 方向目标、共享指令、配置 revision；名称和图标使用同一保存事务。Void 没有 Context。                         |
| Project 配置 | 项目目标、项目指令、独立 revision；读取时带只读 Space 来源及迁移状态。                                     |
| Thread 快照  | 四字段原文、来源名称及 ID、来源 revision、渲染版本、提交文本、哈希、快照 ID 和时间。固定后不跟随配置变化。 |
| 加载记录     | Thread、快照、Provider、会话代次、提交指令、合成哈希、加载确认时间。与快照独立。                           |
| 迁移与回执   | 数据实例 UUID、项目归属、旧文本摘要、处理状态、命令 ID 与条件保存结果。                                    |

四字段可为空，服务端与前端按 JavaScript UTF-16 字符串长度校验：目标 4096，指令 16384。不截断输入，不改写已保存原文。来源删除或归属变化不能删除历史快照。

契约在 `packages/contracts/src/context.ts`；持久化在 `apps/server/src/context/ContextRepository.ts`。本地原生 tracker 曾加入 `111_ContextV1`，它不是已证明来自官方上游的迁移。2026-10-16 按用户确认将其保留为冻结的历史兼容例外：不改号、不改脚本或搬表，后续 Linx 扩展使用独立 ledger，归属由[迁移检查](../scripts/check-migration-lineage.ts)验证。不重新占用保留的 109/110，也不把 Workbench Expert 的独立迁移重新注册为官方迁移。旧备份识别与恢复保护继续保留。

## 3. 读写与协议

Context RPC 接在已有命令准入和事务边界，未引入另一套配置文件或浏览器权威存储。

| API                                                   | 行为                                                                                |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `context.getSpace` / `context.getProject`             | 返回已提交配置、归属、版本和迁移状态。                                              |
| `context.saveSpace` / `context.saveProject`           | 按 dataInstanceId、对象 ID、expectedRevision 条件保存；Space 同时校验原名称和图标。 |
| `context.getCommandResult`                            | 查询原命令的 saved / conflict / rejected / pending / unknown 回执。                 |
| `context.getThread`                                   | 返回历史模式、预览或固定快照，以及当前加载证据与更新提示。                          |
| `context.claimMigration` / `context.resolveMigration` | 确认工作区归属后登记旧数据，按版本选择迁移或保留服务端版本。                        |
| `context.retryLoad`                                   | 在执行侧确认安全后，重试原事件；不创建第二条用户消息。                              |

相同命令 ID 只恢复同一次操作。不同请求复用 ID 会被拒绝，不能用旧成功回执掩盖冲突。保存、旧指令认领与迁移选择的回执，以及首次冻结的完整快照，均写入事件后再投影。重放只应用已提交值，不重新判断当前工作目录、配置版本或源文本；Context 投影在项目和对话投影之后重建。内部 `context.bind` 不属于客户端可派发命令。

WebSocket 协议最低版本提高到 revision 3，并发布 `context.v1` capability，避免旧客户端读取无法解析的新事件。UI 扩展与 capability 检查保留旧组件调用的默认行为。

## 4. 前端接入

- Space：复用 `SpaceEditorDialog` 与 `useSpacesController`。新建仍只填写名称、图标；编辑已有 Space 时增加两字段。一次提交，成功关闭，失败或冲突保留全部草稿。
- Project：复用 `EnvironmentProjectInstructionsSection`。只读继承默认折叠；“Edit Space context”打开原弹窗，不切路由或丢弃项目草稿。没有 Space 时省略继承。
- 自动保存：`projectContextAutosave.ts` 持有每个连接、数据实例和项目的独立队列。500ms 防抖、串行提交、最新草稿排队；在途保存期间仍能继续编辑。只在确认后推进基线。未知结果查询原回执，冲突暂停队列并比较原文。

- 离开保护：离开项目或关闭编辑区先提交并等待；无法确认时保留草稿。放弃仅取消未提交内容。普通发送和同项目切换对话不触发配置保存弹窗。
- 配置刷新：活动页面每 5 秒回读已提交配置，后台停止轮询；Space 保存后主动刷新项目来源。控制器保护在途与未保存草稿，远端结果不能覆盖本地新输入。
- Chat：仅从现有“＋”菜单按需打开 `ContextDetailsDialog`。正常界面不常驻显示 Context 状态、更新横幅或迁移导航。详情每 2 秒刷新当前加载状态，技术编号和版本默认折叠。普通字段不显示常驻字符计数，超限才报错。
- 旧项目指令：Context capability 存在时停止自动复制到 Thread Notes；手动复制已提交指令仍可用。既有 Notes 不自动清理。

2026-10-16 架构对齐：Context 详情、自动保存和旧指令迁移通过 `workbench/host/contextClient` 读取原生 `ContextApi` 和 capability，保留原对象身份及已有队列；旧指令读取也集中到只读宿主入口。Space 业务辅助函数只接收实际所需的 orchestration 方法，批量移动保留传输结果不确定时的 shell 回读。接入归属与功能扫描统一登记在[接入清单](../workbench/integration-points.json)，源码范围与检查见[架构对齐验收](./workbench-adaptation-acceptance.md#alignment-implementation-20261016)。

## 5. 首次执行、Provider 与恢复

1. 接受首次有效执行时，事务内校验 Provider 能力和已认领迁移状态，再将完整快照与用户消息、执行请求一起提交。前置拒绝不会提前固定快照。
2. 普通发送只使用已提交配置。空内容仍固定空快照，但不改变原 Provider / Expert 能力。非空内容首期支持 Codex、Pi；不支持的 Provider 在执行准入前明确拒绝。
3. Provider 层统一合成独立 Expert 指令与 Context。Codex 使用原生初始化、恢复和派生参数；Pi 使用原有 system-prompt 扩展。Context 不作为用户消息反复拼接，也不覆盖专家指令。
4. 原生初始化确认后，记录当前代次的实际提交文本和合成哈希。发送、steer、review、compaction 等入口校验绑定与当前代次；原生恢复失败不能用旧代次记录冒充成功。Provider 切换失败后恢复原会话时，同样重新传入原 Expert 与 Context，并在初始化确认后重写原代次的加载证据；证据保存失败时停止恢复的运行时。
5. 已固定对话继续使用原快照；同项目 fork / handoff / sidechat 按来源继承绑定或历史模式。跨项目派生沿用原禁止规则。服务端导入路径用可信入口标记历史模式，客户端 creationSource 不能绕过绑定。

“已加载”仅表示 Synara 已构造指令且原生会话初始化已确认，不代表模型一定遵循全部指令；Provider 文件指令仍可能另行加载。

## 6. 原消息重试边界

执行投递账本保存快照 ID、原消息 ID、执行输入摘要，以及 `before_dispatch → dispatch_started → acknowledged` 阶段。摘要包含原消息、附件、Notes、模型与模式，以及项目根目录和实际工作目录等执行输入。

只有原事件仍存在、内容及工作目录未变、阶段证明未开始派发、没有存活会话或后台任务时，才允许按原事件重试。重试登记持久审计回执并对投递状态做条件更新，清除该失败尝试的短期去重缓存，不重新绑定最新配置。

派发开始后结果不明，或原输入、目录、会话状态无法确认时，不自动重发。加载失败保留原消息和快照，明确展示失败；不能把一次未执行的加载拒绝标成普通发送已完成。

## 7. 旧指令迁移

旧浏览器键 `synara:project-instructions:v1` 仅有项目 ID，不能据此自动认领。用户须确认当前数据实例、项目与工作目录，再登记迁移。服务端按版本保存、核对原文并持久保存完成状态；项目目标不被迁移覆盖。

无冲突和冲突路径均保留旧浏览器数据；失败、未知结果或冲突不能标为完成。只限制存在待处理迁移的相关项目的新对话首次执行，不影响已有快照、其他项目或无旧数据的用户。迁移不清理历史 Notes。

未发布开发基线中曾存在未冻结回执的迁移事件。它们只来自旧的隔离测试实例；这类事件缺少可信结果时重建会明确失败，不使用当前配置猜测。旧测试 home 与对应源码保留作历史证据，不作为生产迁移或新整合版恢复输入。本轮未迁移正式用户数据。

## 8. 本地预览

在整合预览工作区 `.synara/browser-integration` 使用仓库锁定的 Node / Bun 版本运行：

```sh
env -u SYNARA_AUTH_TOKEN mise exec -- bun run dev --dry-run \
  --home-dir /private/tmp/synara-browser-integration-20261015 \
  --host 127.0.0.1 --port 17739 --no-browser --no-auto-bootstrap-project-from-cwd
```

确认输出的 server/web 端口和独立目录后，去掉 `--dry-run` 启动。此实例网页为 [localhost:5734](http://localhost:5734/)，服务端为 17739。已有实例运行时重新检查 IPv4/IPv6 端口，勿复用正式 home 或数据库。上面的环境变量清理仅作用于隔离测试进程。

正式部署、数据迁移与安装包验收需要另外执行，不能把本地原生 Provider 验收当作已发布结果。
