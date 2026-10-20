# Hub × Expert V1.1：统一导航与成果引用

来源：2026-10-19 用户在 V1 浏览器反馈后确认四项改进，并明确要求实施本方案。用户进一步选择：Hub 独立归属一个 Space、专家引用仅在 Coordinator 派发、Library 内双视图、独立 Hub 首次固定 Space Context。本文描述已确认行为；实际完成情况见[验收记录](./hub-expert-v1-1-acceptance.md)。

## 基线与交付

在 `codex/hub-expert-v1` 的 V1 未提交成果上增量开发，Git 基础为 `850de05e08ab9c116c639e7b1cb8145e0b6e05d5`。实施前已另存 72 个 V1 变更文件、摘要与完整 tracked diff。原工作区 `codex/composer-ui-fixes` 保持独立。V1 的[方案](./hub-expert-v1-design.md)及[验收](./hub-expert-v1-acceptance.md)保留历史范围，不作为本轮通过证据。

交付至本地浏览器与真实 Agent 验收，不包含推送、安装或发布。P0 延续用户要求：修订原型经确认后实施可见 UI；后台契约、Context 和引用传递可先推进。Figma Starter 工具额度耗尽后，用户已明确批准改用本地高保真交互原型；第二版原型已获用户明确确认，正式 UI 按修订版实施。

## 用户流程与所有权

| 对象                    | 数据所有者                            | 本轮规则                                                     |
| ----------------------- | ------------------------------------- | ------------------------------------------------------------ |
| Space 与 Hub 的导航归属 | 原生 Orchestration 容器 `spaceId`     | Hub 独立归属一个 Space；可关联其他 Space 的 Project          |
| 线程与状态              | 原生线程、ProjectAgent 成员及 HubWork | 一个线程对象；按协作归属确定默认列表，按执行位置汇总项目工作 |
| Context                 | 现有 Context 模块                     | 首次绑定不可变快照，移动和改名不重绑                         |
| Expert                  | 原 ExpertStore 与运行绑定             | 用稳定 ID 选择，在工作项被接受前固定配置                     |
| 引用                    | 原消息 mentions 与 HubWork 来源记录   | 元数据不授予权限，发布版本明确且可恢复                       |
| 文件与关键集合          | 原 Git Library 与 V1 关键集合服务     | 当前集合查询与固定版本读取继续分离                           |

UI 继续在原 `_chat` 布局内运行，继承原订阅、认证、快捷键、分屏和聊天生命周期；不新增父布局或另一套任务执行系统。

### 导航与线程

- 同一 Space 侧栏有 Projects、Hubs 两个独立可折叠分组。打开普通线程、Coordinator、Worker 不替换整套侧栏。
- 在 Project 新建 Hub，预置其 Space 和来源关联，创建结果出现在 Hubs 分组，自动展开并定位；未配置完也可恢复。
- 侧栏 Hub 下不显示“关联项目”标签；此精简适用于既有及新建 Hub，关联关系仍保留。
- Project 提供紧凑关联协作摘要，不再展开一套重复的 Hub/Worker。原任务总览保留实际执行的 Hub 工作及其来源。
- Hub Worker 默认只在所属 Hub 下展开，显示执行 Project；独立 Project 线程不自动进入 Hub。归属只能来自服务端关系，不能按路径、名称推断。
- 列表去重不移除审批、运行和失败统计。归属未加载或读取失败时不使线程失去可访问入口。
- 查看跨 Space Worker 时维持 Hub 所属 Space；显式点击执行 Project 才切换至该 Project 所属 Space。搜索、最近访问、固定入口和分屏使用同一 thread ID。
- Hub 设置及紧凑右键子菜单允许移动 Space，不改变关联、文件根目录、记忆、任务或已绑定 Context。旧 Hub 保持未归类；使用现有 Void/未归属的用户命名。
- 删除 Space 将 Hub 和 Project 置为未归类，不删除内容。全局 Hubs 及旧路由是同一界面的汇总/定位入口。

### Context

- 来源 Project Hub 的 Coordinator 仍按 V1 显式来源固定 Project 及其 Space Context。
- 无来源 Project 的新 Hub，其 Coordinator 首次运行固定当时所属 Space；未归类时不继承外部 Context。
- Worker 在普通 Project 运行时绑定实际目标 Project；在 Hub 自身工作区运行时绑定其适用的 Space 背景，不汇集全部关联项目。
- 新版本快照必须准确表达仅 Space 来源，不能构造虚假的 Project Context。既有版本原样解码，旧摘要及已绑定/legacy 线程不重写。
- 首次绑定的来源竞态明确失败；后续编辑和移动不替换固定快照。Context 读取与运行生效证据继续使用现有通道。

### 专家与关键产物

- `@` 选择器沿用原单列纵向列表，专家、单一关键产物板块、对话、文件及原有入口在同一列展示，不使用分类标签切换。键盘方向键与搜索沿用原选择器。
- `@专家` 仅在 Hub 主对话提供，用稳定 Expert ID 引用名称、用途及可用状态。选择不启动任务、不替换 Coordinator 配置、不新增授权凭据；用户的执行请求经现有 Coordinator 工具派发。
- Expert 快照和目标在接受工作项前固定；排队期间模板变更不影响旧事项。不可用目标继续明确失败，无静默降级。
- 2026-10-19 用户补充：已绑定专家的线程在 `/` / Skill 选择器只列接受时快照中的 Skill，引用使用快照路径；首次发送前已选专家的草稿复用现有专家预览中的 Skill。接受后的快照优先于草稿预览。空集合、加载中或读取失败不回退到 Harness 全量技能；读取失败显示状态。没有选择专家的普通线程维持原技能发现，原生 `/` 命令继续保留。该入口复用 `ExpertClient.readExpertSnapshot` 和现有草稿预览，不更改 Provider 权限。
- Library 默认显示关键产物，可切换全部文件并保留原文件管理。关键视图按 Expert、来源事项组织；列表只展示名称及可选说明，不展示版本、发布时间或内部保存目录。预览详情保留版本与时间信息。
- 同一专家的不同事项分别呈现，每 Worker 最多三项的限制不变。历史身份使用接受时快照名称，不能随模板改名漂移。
- Coordinator 与 Hub Worker 的 `@关键产物` 只列当前 Hub，和 Library 共用数据、搜索、状态及来源身份。选择器只用一个“关键产物”标题，文件名靠左、执行快照中的专家名称浅色右对齐，无法恢复身份显示“未知专家”；不展示事项小标题、描述或版本号；Library 仍保留事项组织。发布预览提供引用到当前对话入口。
- 选择固定发布版本；新发布、改名或切换 Provider 不改变引用。撤下后不再作为当前成果选择，既有引用按历史记录与原权限读取。
- 缺失明确标识；读取失败不回退最新版本或实时文件。默认仅注入受预算约束的元数据和准确读取入口，正文按需读取。

## 宿主接口与兼容

1. 复用 `project.create`、`project.meta.update` 和 `spaceId`，仅扩展受支持 Hub 容器类型；Chats 仍不可归属。同步更新事件回放、路由恢复、元数据更新及 Space 删除行为。
2. Context schema 增加仅 Space 来源版本，继续用现有 JSON 快照与首次绑定事件冻结数据；保持 v1 hash 兼容。
3. 沿用消息 `mentions: { name, path }[]`，用共享的严格构造/解析器表示专家和发布版本引用。跨进程类型在 contracts，共享运行帮助函数使用 shared 显式子路径。
4. 服务端验证会话 Hub/角色、资源范围、版本与专家身份，将工作台引用转换成受预算约束的提示并从 Provider 原生引用中移除；模型给出的名称、commit 或 Hub ID 不是授权依据。
5. `HubWorkSourceMessage` 添加可选引用信息，服务端从原始用户消息提取、校验并随被接受工作项持久化，Worker 无需模型转述也能获得准确版本。旧记录缺省为空。
6. 现有关键集合查询增加服务端解析的快照身份与来源事项；保留发布、读取、撤下、版本 CAS、写入锁和中断恢复语义。
7. 接入能力登记到 `workbench/integration-points.json`，更新精确边界检查覆盖。必要新增结构只用 Workbench 独立 ledger，不追加本地原生迁移编号。

## 当前实现接口

- 用户界面的专家发现入口为 `projectAgent.listExperts({ projectId })`；连接沿用原认证，服务端核对 Hub 及其 Coordinator，再复用 Gateway 的专家/运行目标预检。返回稳定 ID、名称、用途、偏好和可用状态；此查询不创建任务或准备快照，也不调用会修复摘要的 overview 读取。
- 两类引用仍存入原 `mentions`，规范形式为 `synara://expert/{expertId}` 及 `synara://hub/{hubId}/deliverables/{workerThreadId}/{encodedPath}?revision={positiveInteger}`。构造、严格解析及普通 Provider 引用分离由 `@synara/shared/hubReferences` 提供；保留命名空间中的非法 URI 明确拒绝。
- Provider 入口把选中引用投影为简短元数据及精确读取参数，不当作文件路径或 Provider 原生角色选择。单条消息最多 8 个工作台引用、总引用说明最多 8,000 字符，并受原总 Context 预算约束；超出时明确失败，不截断版本读取入口。
- 被接受的工作项在 `HubWorkSourceMessage.references?` 保存原始用户引用，旧记录可缺省。当前关键集合及历史版本解析补充 `expertBinding?`、`sourceWorkTitle?`；身份先取原接受快照，再查对应不可变快照文件，不读取最新版模板冒充历史身份。
- Context v1 保留原字段与 hash 算法；v2 用 `source: space | none` 表达真实来源，不带虚构的 Project 字段。沿用原 JSON 快照和事件持久化，不新增数据库迁移。

## 阶段与验收

2026-10-19 原型第二轮按用户五处浏览器标注精简：移除侧栏关联项目标签、Library 列表版本与时间，以及 `@关键产物` 的描述、版本和事项小标题。固定版本引用的数据与读取规则不变。用户随后明确确认：“可以，前端方案通过，落地方案吧”，正式 UI 按第二版原型实施。

P0 保存基线、修订原型并确认；P1 归属/Context/导航；P2 关键视图与固定版本引用；P3 专家选择；P4 本地整体验收。接口和后台可在原型待确认时推进。

必测场景：同名 Hub 与未完成配置恢复；跨 Project/Space Worker 唯一默认位置且状态完整；移动/删除 Space、旧 Hub、深链接与分屏；旧/新 Context 和重启；专家讨论/执行与不可用状态；引用 v1 后发布 v2 并排队重启；同专家多事项、撤下/改名/删除/恢复与非法跨 Hub 请求。

最终执行格式、lint、类型、受影响 Vitest/browser、完整 `bun run test`、迁移及 Workbench 边界检查；平台/进程变化才加 Windows runtime 静态检查。隔离真实 Agent 验证专家选择、成果引用、派发、固定版本读取与恢复。仅声明实际验证的 Provider；不扩展 PDF/DOCX 正文解析、大文件上限或跨 Hub 引用权限。

2026-10-19 实施中用户补充要求 `@` 选择器与原来一样在同一列展示，正式界面改为单列分组，替代原型中的横向分类按钮；此前批准的精简信息和固定版本语义继续有效。

## 2026-10-20 参与专家与选择器调整

本节为用户批准的后续实现，覆盖此前全目录专家发现与选择器专家分组规则，Library 分组不变。

- 新旧 Hub 的参与专家默认均为空；不从历史 Worker、成果或全局目录导入。创建和编辑共用设置弹窗，General 后增加 Experts 页，支持搜索、多选、数量、清空和不可用项移除。空名单或没有适合专家时仍可创建普通 Worker。
- `@关键产物` 单板块；名称靠左、不可变执行快照专家名浅色右对齐，缺失身份为“未知专家”。同名成果保留各自版本引用，不可用资源继续禁用。聊天所属 Project/Hub 信息使用相同右侧槽，长文本省略并可悬停查看。
- Projects、Hubs 标题复用 Chats 的标题与箭头排布；箭头紧跟标题，操作按钮保留在右侧。

### 名单接口与一致性

`ProjectAgentConfig.expertIds?` 读取缺省为空；`ProjectAgentConfigureInput.expertIds?` 创建省略为空，编辑省略保留，显式 `[]` 清空。按集合规范化并纳入设置保存指纹和版本检查。Workbench expert ledger migration 5 `HubExpertParticipants` 新增 `hub_expert_participants(hub_id, expert_id)`，联合主键，Hub 外键级联；不增加原生编号。名单替换与配置 revision 在同一事务，Hub 数据清理同步清除名单。

新加入 ID 必须存在且未归档。保留的旧 ID 即使后来归档或删除，也不阻塞其他设置保存；设置页显示不可用并可移除。名单只有认证用户配置能力可修改，Agent 不获得名单写工具。

`projectAgent.listExperts` 和 `synara_hub_list_experts` 从同一服务端配置读取名单，只读取并预检名单内 ID；空名单不读取全局目录、不预检 Provider。创建设置页另复用用户侧 ExpertClient 全目录读取以选择参与者。当前菜单在保存后失效刷新，错误明确展示。

新专家引用在 Provider 入口经宿主 `resolveParticipatingExpert` 校验 Hub/Coordinator/成员及当前可用性，名称也从服务端读取。新派发在快照预检前校验成员，提交新工作项的 SQL 事务再次核对配置版本与成员；预检过程中配置变化返回冲突且整批不接受。接受请求的幂等重放先返回已有记录；排队、恢复与原快照不重新检查当前名单。

Coordinator 每轮说明要求优先选择适合的参与专家，没有匹配时省略 `expertId` 并提供明确目标走既有普通 Worker。明确指定专家或运行目标不可用继续报错，不自动降级。普通 Worker 不因此获得专家关键产物发布身份；历史专家成果与固定版本引用不受移除影响。
