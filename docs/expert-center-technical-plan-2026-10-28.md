# Expert 中心技术改造方案

日期：2026-10-28。状态：产品方案已通过；用户已要求实施；初版已交付 0.1.7；专家团/技能整合后已合入并更新日用 Workbench 0.1.8，见[整合验收](./expert-center-organization-2026-10-28.md)。

基线：`2577e5819353e6089cc3f6e118e848f38df04913`。范围以[已通过的产品方案](./expert-center-product-plan-2026-10-28.md)为准；遵循[架构标准 v1.1](./workbench-adaptation-plan.md#current-standard-v11)及[开发检查矩阵](./workbench-development-workflow.md#按实际影响选择检查)。原型用于评审功能和入口，不作为重新实现现有控件的规格。

## 1. 技术结论

采用 **现有 Expert 编辑器独立挂载 + 原生草稿启动衔接 + 现有任务投影聚合**。

| 工作包     | 必要改造                                                         | 明确保留                                                        |
| ---------- | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| 独立入口   | 文件路由、导航、旧链接兼容、单一页面控制器、MCP 返回路径         | 卡片列表、能力/设置、配置字段、Skills、资料、管理操作及草稿规则 |
| 使用此专家 | 新任务草稿携带 Expert；保留项目主草稿；处理导航失败和首次发送    | 原 ChatView、Provider/模型选择、预检、快照和执行链路            |
| 任务历史   | 在已有任务概览上按 Expert 绑定筛选；状态和项目关联；同步状态提示 | 原生任务数据、订阅、详情加载和归档/删除规则                     |
| MCP        | 调整进入/返回链接，校验现有授权与状态操作无回归                  | 服务、协议、凭证、授权、配置版本、Gateway、检查和应用接入       |

**第一版不新增服务器 RPC，不新增 Expert/任务业务表，不迁移服务器数据库，不改变 Provider/Gateway 或 Skill 生效语义。** 新代码主要在 Web；草稿启动与任务投影接入属于宿主适配工作，不能只算菜单修改。

## 2. 已核对的约束

| 当前事实                                                                        | 对方案的约束                                                                   |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Expert 列表、编辑状态和专家团切换目前共处 ExpertsSettingsPanel                  | 只拆必要的宿主装配；不得因独立个人专家页面丢失专家团入口                       |
| Expert 编辑器已有能力/设置、共享草稿、expectedRevision、离开保护                | 复用这些实现，不按原型另做表单或保存状态                                       |
| `_chat` 提供工作台侧栏、快捷键及任务生命周期挂钩，root 已订阅任务概览           | 新页面继承真实布局；无需重造全局 shell，也不声称与聊天运行时完全隔离           |
| 普通新任务会复用项目主草稿；`fresh` 替换主槽时可能清除旧草稿                    | 不能“先新建再覆盖 expertId”，也不能仅用 `fresh:true` 保证保护草稿              |
| 已有 registerDraftThread / createDraftThread 支持不占项目主槽的 standalone 草稿 | 复用草稿基础，不增加任务执行器；需保护后续上下文修改不意外认领主槽             |
| getShellSnapshot 覆盖全部未删除任务，包含归档和完整 expertBinding               | 已满足本轮可访问历史范围，先不增加专用后端查询                                 |
| sidebar 摘要没有 expertBinding，但有任务状态摘要                                | 归属取 threadShellById；状态可按同一 threadId 关联现有摘要，不能只过滤侧栏列表 |

证据路径集中在文末。以下新文件、类型及函数名均为拟定落点，实施时可按现有命名规范微调，不代表已经存在。

## 3. 入口、路由和编辑器

### 3.1 路由与父布局

- 列表：`/experts`；详情：`/experts/$expertId`。
- 详情查询参数：`tab=capabilities|settings|history`。默认打开方式与现有编辑器保持一致；旧 Expert 深链接按现有能力页定位行为转换。
- 新建未保存专家继续是编辑器草稿状态，挂在 `/experts` 下，不要求新建草稿有永久地址；首次保存成功后 replace 到真实详情 URL。
- 使用现有文件路由生成机制，拟新增 `_chat.experts.tsx` 父入口及 index / `$expertId` 子入口；不手写生成路由树。
- 实际父布局为 `/_chat` → `ChatRouteLayout`。Expert 父入口惰性挂载唯一控制器；子入口仅提供身份/页签，不分别创建编辑器状态。
- 不新增通用 AppShell、不整体迁移现有 Expert 目录、不改变 MCP 的设置页承载。

同一专家切换能力、设置和历史不重挂草稿；不同专家、列表、新建或离开模块才触发既有离开保护。路由参数需验证：未知页签归一化；不存在或已删除的 Expert 显示不可用与返回列表，不沿用上一位专家的内容。归档专家允许查看，编辑仍只读。

### 3.2 单一控制器与组件复用

从 `ExpertsSettingsPanel` 中分离个人 Expert 的现有控制逻辑，形成一个 `ExpertCenter` 控制器；可以保留原组件路径并提取附近的 controller hook，不以改目录为目标。

| 职责                                                                  | 归属                                               |
| --------------------------------------------------------------------- | -------------------------------------------------- |
| selectedId、baseline、draft、revision、保存/复制/归档/恢复/删除、错误 | 同一 Expert 控制器                                 |
| 路由意图解析、导航、进入 MCP、启动任务、历史数据接入                  | Workbench host 适配                                |
| 列表、能力/设置表单、保存条、确认、Skill/资料/MCP 选择                | 现有 Expert 组件                                   |
| 历史页                                                                | 新增只读 ExpertTaskHistory，消费窄数据输入         |
| 专家团                                                                | 原 HubTeamsSettingsPanel，由专家页的专家团分类承载 |

必要组件扩展仅包含：详情顶部“使用此专家”回调、历史页签/内容槽、路由状态受控接入。`ExpertEditor` 中现有两个页签的布局、表单及校验继续复用；不能在外部再套一组重复页签。

保存后继续更新现有 `EXPERTS_QUERY_KEY` 和相关连接缓存。能力数据仍按可见页加载：仅能力页拉取连接/Skill 目录；历史页不触发所有 Provider 的技能或兼容性探测。

### 3.3 路由与草稿的协调

控制器是草稿所有者，URL 只表示当前对象/页签。使用既有 `useExpertDraftGuard`：

1. 同一详情 URL 的页签切换保持草稿，不阻断。
2. 更换 Expert、返回列表、新建、进入 MCP、使用此专家、离开页面经过一次保存/放弃/取消。
3. 保存失败、校验失败、并发 revision 冲突留在原对象，保留输入；成功前不先切 URL。
4. 浏览器前进/后退由同一 route blocker 接入，避免页面内确认后又弹第二次确认。
5. 异步保存/加载结果须核对请求对象与页面代次；不能把 A 的返回写入已经打开的 B。
6. 浏览器刷新沿用现有 beforeunload 保护；不新增 Expert 自动保存或跨会话草稿服务。

### 3.4 旧设置与 MCP 兼容

| 入口                                     | 处理                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 原设置中的“单个专家”                     | 导向新列表；携带 expertId 时导向对应详情                                                        |
| 原设置中的“专家团”                       | 同一原面板移入 `/experts?kind=teams`，旧入口重定向                                              |
| Expert → MCP                             | 沿用 section=mcp、tab=tools、expertId、connectionId、returnExpertId；仅发起方变为独立 Expert 页 |
| MCP → Expert                             | 返回 `/experts/$expertId?tab=capabilities`，保留必要目标标识                                    |
| 原 expert-connections / MCP 应用接入别名 | 继续由现有 settings adapter 归一化，不丢 tab、search 或连接标识                                 |

设置中仅保留跳转薄壳，不挂载第二套编辑器。依据后续用户授权，旧无 expertId 的 Experts 设置 URL 转到专家团分类，Agent skills 设置 URL 转到技能分类，详见下文整合补充。

在现有导航注册和 AppRail 接入 Experts，并处理当前项识别、自定义排序/隐藏与默认值归一化；不重置用户导航顺序，不新增 MCP 顶层项目。设置搜索指向同一新入口，元数据集中登记。

### 3.5 宿主行为回归

继承 root 的认证、连接和任务订阅。保留导航/侧栏/帮助等全局快捷键；编辑器内保存、输入和 Escape 遵守已有焦点与弹窗规则。聊天专属终端/消息操作继续受真实任务路由与焦点条件限制，不以“最近任务”冒充当前 Expert 页任务。

全局“新建任务”仍执行原通用行为，不因页面选中了 Expert 自动绑定它；只有“使用此专家”携带绑定。进入 Expert 页不得停止后台任务、重置选择状态或重新加载全部任务正文。

## 4. 使用此专家：复用原生独立草稿

### 4.1 入口契约

在 `workbench/host` 提供窄能力，例如 `startExpertDraft({ expertId, projectContext })`；功能组件不直接读取/修改整套 native API 或 composer store。

该能力只负责进入草稿，返回成功定位或明确不可用结果。不得调用 `createAndDispatchDraftThread`、`dispatchDraftThread` 或任何发送命令。

### 4.2 流程

1. 完成 Expert 离开保护。使用保存后的现有 Expert ID；尚未保存的新 Expert 必须先成功保存。校验当前 Expert 未归档/删除，异步步骤返回后再次核对身份。
2. 按宿主既有上下文解析可用项目、目录、环境及 Provider/模型选择。当前项目明确时直接使用；缺失时复用现有项目选择入口。禁止回退到随意一个项目，禁止替换已有模型偏好。
3. 复用 `createDraftThread` 的独立草稿路径创建新 ID，不占用、替换或清除项目主 chat/terminal 草稿。输入为空，不复制其他草稿的正文、附件或队列。
4. 扩展原生草稿创建参数，使 `expertId` 在注册时进入已存在的草稿字段；环境与模型沿用既有初始化逻辑。现有 createDraftThread 尚未暴露 branch/worktreePath，继承已有工作区时需补齐这些可选输入并原样传给注册能力，不能只传 envMode。无工作目录覆盖时保留原有省略语义。
5. 按原任务地址 `/$threadId` 导航到 ChatView。连续点击使用同一进行中启动请求，不重复制造草稿。
6. 用户首次发送继续从草稿读取 expertId，沿用 `useChatTurnSubmission`、服务端 Expert 快照、Provider 启动和 MCP 必需项校验。启动前任何失效都明确阻止，不降级成通用任务。

### 4.3 项目主槽保护

当前 `setDraftThreadContext` 会写项目主槽，因此只在创建时 standalone 还不够。设计要求：**独立草稿在修改 Expert、项目/环境等上下文后仍保持独立；已有主槽草稿继续沿用原有槽位迁移行为。**

优先利用现有“该 thread 是否占有项目主槽”的事实确定映射所有权：上下文更新只移动本来属于该 thread 的槽位；独立草稿保持无映射；明确认领仍由 `setProjectDraftThreadId` 完成。需要按下表处理当前调用者并补回归，不能顺手改变其他草稿的复用策略。不通过全局恢复隐式覆盖来规避保护。

| 已核对的调用者                                           | 实施规则                                                                                                                                                                    |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| useHandleNewThread                                       | 现有复用/创建路径已有显式认领，保留通用新任务原有主槽行为                                                                                                                   |
| ChatView 的 Expert/临时标记，模式/排队输入/Goal 修改     | 只更新元数据；standalone 不因这些编辑获得主槽                                                                                                                               |
| useChatWorkspaceSelection、BranchToolbar                 | 常规上下文编辑保持原所有权；明确移动项目的 moveDraftThreadToProject 分支也需保留 standalone 属性，不能绕过保护                                                              |
| prepareChatSendWorkspace 的首次发送项目创建/重复项目恢复 | 目前会先清空目标项目主槽再更新上下文。必须在任何清空前捕获原所有权：standalone 不清空目标槽、不认领；原主槽流程按既有迁移规则处理。尤其覆盖“目标已有草稿”的重复项目恢复路径 |
| ChatView 的 PR/分支处理                                  | 已有显式认领，不得让 standalone 在后续自动处理时被认领。对本草稿的上下文更新保留所有权；独立的通用新任务操作继续走原入口                                                    |

以上是本轮必要的草稿边界修正，涉及现有 standalone 调用者的行为校准，不能宣称完全没有原生流程变化。认领与上下文更新分开后，不新增持久化的 Expert 专属模式字段，也不新增一套草稿 store。

创建入口复用或提取现有 draft bootstrap 的初始化片段，避免复制模型、目录、分支和导航回滚逻辑。新增的 expertId 创建参数是可选的，未传入时保持原初始化行为。

### 4.4 持久性、失败与清理

- 未发送草稿仍是当前客户端的原生本地草稿，不是服务端任务；不承诺跨设备恢复或新增草稿收件箱。
- 已有 Kanban 会展示有正文/附件的 standalone chat 草稿；空草稿没有卡片，侧栏和 Tasks 页不保证自动列出所有 standalone 草稿。本轮不改它们的信息架构。
- 注册后导航失败/被新导航取代：只有确认仍是本次创建、未发送、未被用户修改的空草稿时才清理；否则保留内容，提供原草稿地址恢复。
- 导航成功后的草稿、附件和清理继续走现有持久化与提升流程。用户内容不能为恢复主槽而被覆盖。
- 跨页延迟回调与重复点击用请求 ID/导航身份防串写；本地注册成功不等于服务端接收任务。

## 5. 任务历史：前端聚合现有概览

### 5.1 本轮选择及边界

复用 root 已经维护的全量非删除任务概览，不在 Expert 页另发 `getSnapshot` 或重复拉取 `getShellSnapshot`，不按每条任务请求正文/快照。

范围包含当前实例可访问的未删除任务和归档任务；已删除任务不重建。未发送本地草稿尚未实际使用 Expert，不加入运行历史。该范围与已通过产品方案“删除与访问限制沿用原任务规则”一致。

服务器已有 `expert_binding_json` 和完整绑定字段；本轮既不新增任务索引表，也不为了准备将来分页增加数据库迁移。

### 5.2 数据与状态

通过拟新增 `workbench/host/expertTaskSource` 暴露只读视图；功能模块不直接耦合全局 store。数据源映射：

| 展示字段        | 来源                                                                              |
| --------------- | --------------------------------------------------------------------------------- |
| 归属            | threadShellById 中的 expertBinding.expertId，严格匹配 ID，不按名字或当前定义推断  |
| 任务标题 / 项目 | 原线程 title/projectId 与宿主项目数据；找不到项目时如实降级显示                   |
| 当时专家版本    | expertBinding.revision/displayName/snapshotId，不使用当前 Expert revision 覆盖    |
| 实际状态        | 同 threadId 的原生任务状态摘要及现有状态解析工具；无摘要时仅显示 shell 可确认状态 |
| 最近活动        | 沿用线程 updatedAt 口径；不把专家配置更新时间当任务时间                           |
| 归档            | archivedAt 原字段；不等同失败或完成                                               |
| 打开任务        | 既有线程路由和访问检查，不另建任务详情                                            |

按 updatedAt 降序、threadId 稳定排序；首屏最多渲染 50 条，按需增加可见条数。这里是已加载数据的分批展示，不伪称服务端游标分页。复用原状态解析时不把“用户关闭了状态提示”解释为任务不存在；审批/输入等待以可确认的宿主状态为准。

### 5.3 同步、缓存与性能

- 初次 `threadsHydrated=false` 显示加载中，不能以空数组判断“无历史”。
- 断连时保留旧行并提示状态待同步；不能标记为最新。
- 宿主窄读取能力需要提供本次连接/订阅代次是否收到权威概览的状态。现有代次在 root 局部维护；只公开必要的同步元信息，复用原快照 fence 和重试，不另开订阅、缓存或事件总线。
- 重连旧请求晚返回不得覆盖新代次；shell 失败沿用宿主恢复动作。Expert 页面不自行无限轮询。
- 归档/删除/新建/状态更新通过现有投影自然刷新；删除后移除该行，不回填缓存旧行。
- 筛选只依赖 shell、必要状态摘要和项目，不依赖消息 token 流。使用稳定 selector/memo，避免每次流式消息增长重算全表。

若测量发现大任务量存在不可接受的筛选/渲染成本，或宿主将来不再提供完整 shell，再单独评估按 Expert 的只读分页查询。此时可复用现有 projection 字段，是否加索引由查询测量决定；不是本轮预先承诺的后端工作。

## 6. 所有权与修改边界

| 数据/职责                        | 所有者                                 | 本轮变化                                        |
| -------------------------------- | -------------------------------------- | ----------------------------------------------- |
| Expert 定义、版本、快照          | 原 ExpertStore 与 RPC                  | 无 schema/保存语义变化                          |
| 页面编辑草稿                     | 单一 Expert 控制器                     | 从设置装配中复用到独立入口                      |
| 原生输入草稿、项目映射、提升清理 | composerDraftStore 与既有创建/发送流程 | 增加创建时 expertId、保护 standalone 映射所有权 |
| 任务状态、归档/删除、概览订阅    | 原生 orchestration / root 投影         | 新增窄只读消费；必要同步元信息可见              |
| MCP 配置/授权/状态/凭证          | 原连接服务、Expert 授权、Gateway       | 不改；仅链接适配与回归                          |
| 跨进程契约                       | packages/contracts                     | 本轮无新增 wire 方法或业务 schema               |

不新增独立服务或平台进程，不修改 Stable/Beta 身份与数据目录。沿用 Expert 当前可用范围；Beta 专有连接能力保持现有服务端与前端门控。

## 7. 文件与接入清单

以下是按职责的预期修改面，不要求一次性重命名或搬迁全部文件。

| 修改面          | 主要落点                                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 路由与导航      | 新 Expert 文件路由；现有 AppRail/导航顺序逻辑、settingsNavigation、settingsSearchIndex、workbench/registry                                                       |
| 单一编辑器      | ExpertsSettingsPanel、ExpertEditor 及就近控制器；已有 ExpertList/ActionsMenu/Preview/SaveBar 直接复用                                                            |
| 设置/专家团/MCP | workbench/settingsPages、workbench/host/settings、`_chat.settings`；HubTeams 面板继续复用                                                                        |
| 启动适配        | 新 workbench/host/expertTaskActions；draftThreadCreate、composerDraftDomain/Actions、prepareChatSendWorkspace、工作区选择/PR 调用点、相关 bootstrap 与持久化校验 |
| 历史适配        | 新 workbench/host/expertTaskSource 与 ExpertTaskHistory；现有 storeSelectors/任务状态工具；root 仅增加必要同步元信息出口                                         |
| 契约与后端      | 原则不改；发现必须改变启动/授权/查询合同需先回到范围评审                                                                                                         |
| 边界记录        | 实施时更新 workbench/integration-points.json 的 Expert 导航接入、新草稿/任务源接入，确保新增文件纳入扫描                                                         |

宿主适配依赖原 store/hook 属于显式接入；功能组件消费窄接口。对边界检查的结论只表述为静态依赖覆盖，不声称运行时隔离。

## 8. 实施顺序与退出条件

| 阶段        | 内容                                                                      | 退出条件                                                   |
| ----------- | ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| T0 接口冻结 | 明确路由/控制器协议、主槽所有权、历史同步输入；列出保留行为和受影响调用者 | 不存在草稿覆盖路径；无需新后端服务即可覆盖本轮场景         |
| T1 独立入口 | 复用编辑器、入口/旧链接、专家团保留、MCP 往返、详情/页签与草稿保护        | 现有 Expert/MCP 配置流程无功能丢失                         |
| T2 启动衔接 | 独立原生草稿携带 Expert、导航与失败处理                                   | 旧草稿不被改动；首次发送前无服务端任务执行                 |
| T3 历史     | 已有投影筛选、状态映射、分批展示、加载/断连处理                           | 归属/版本准确，归档可见、删除不复活，无额外正文读取        |
| T4 集成验证 | 聚焦回归、最终门禁、隔离预览及验收记录                                    | 证据对应具体源码，区分通过/失败/未验证；之后再评审交付动作 |

使用已有开发预览环境，实施前按生命周期规范核对归属、状态与端口；不因三个工作包自动创建三个工作树。产品批准与本技术文档不代表已合入、安装或发布。

## 9. 验证计划

### 行为检查

- 路由：列表/详情直达、刷新、前进后退、错误 ID、未知页签；同 Expert 切页保留草稿，不同 Expert 正确拦截。
- 原编辑器：新增、复制、保存、版本冲突、错误焦点、归档只读、恢复、删除与旧任务保留；Skill/资料/MCP 先改草稿。
- 相邻入口：专家团仍可用；MCP 应用接入、别名、授权目标与返回专家不丢失。
- 草稿保护：项目有文字/附件/队列/不同 Expert/模型的主草稿时，使用专家建立独立草稿；随后修改 Expert、项目/环境及首发均不覆盖原主槽。
- 启动：无项目、失效 Expert、重复点击、导航取消、异步返回过期；创建新草稿不调用派发接口。发送前保留原预检和审批。
- 原调用者：普通新任务主槽复用、Kanban standalone、Tasks 委托、临时/terminal 草稿的上下文与提升/清理不回归。
- 历史：同名不同 ID、旧版本、归档、删除、输入等待、审批、回合结束；零条数据与未加载区分；重连/旧响应/同步失败；不逐条请求详情。
- 界面：现有字体、键盘/焦点、弹窗与披露动画；Expert 页不误显示原聊天终端或触发消息滚动行为。

### 最终门禁

代码实施后执行 `bun run fmt:check`、`bun run lint`、`bun run typecheck`、受影响 Vitest/browser tests，以及 `bun run workbench:check-boundaries`。本方案涉及草稿生命周期与 root 投影接入，最终增加 `bun run test`。Web 聚焦测试使用现有 `bun run test:web:focused`，参数按包脚本核实。

如实施实际改变进程边界或迁移，再分别增加 `bun run windows-runtime:check`、`bun run migrations:check`；当前设计不要求这些边界变化。新启动入口至少做受影响路径的隔离真实首发与恢复检查，具体 Provider 按实际改动及可用认证选定；不将一个 Provider 的通过推广到其他 Provider 或平台。

方案编写阶段仅制定文档，执行链接/命令/规范一致性检查。后续实施与运行验收以实现记录为准；原型点击检查不作为产品运行验收。

## 10. 主要源码依据

- [现有 Expert 控制器](../apps/web/src/components/settings/ExpertsSettingsPanel.tsx)、[编辑器](../apps/web/src/components/settings/ExpertEditor.tsx)、[草稿保护](../apps/web/src/components/settings/useExpertDraftGuard.tsx)。
- [设置宿主适配](../apps/web/src/workbench/host/settings.ts)、[设置装配](../apps/web/src/workbench/settingsPages.tsx)、[MCP 页面](../apps/web/src/components/settings/GlobalMcpSettingsPanel.tsx)。
- [真实父布局](../apps/web/src/routes/_chat.tsx)、[root 概览同步](../apps/web/src/routes/__root.tsx)、[导航规则](../apps/web/src/appRail.logic.ts)。
- [新任务主槽流程](../apps/web/src/hooks/useHandleNewThread.ts)、[standalone 创建](../apps/web/src/lib/draftThreadCreate.ts)、[草稿动作](../apps/web/src/composerDraftActions.ts)、[草稿类型](../apps/web/src/composerDraftDomain.ts)、[本地持久化](../apps/web/src/composerDraftPersistence.ts)。
- [客户端概览结构](../apps/web/src/storeState.ts)、[服务端概览查询](../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts)、[Expert 绑定](../packages/contracts/src/expert.ts)。

## 11. 方案编写阶段检查（历史）

- 产品范围与关键代码事实的独立审查通过，无必须修正项；这是设计审查，不是用户技术方案批准或运行验收。
- 两份方案的 28 个相对文件链接、技术方案引用的项目检查命令已核对；Markdown 格式检查通过，已跟踪文档差异无空白错误。
- 产品方案标记为已通过，项目入口已链接到本方案；应用代码未改，未执行应用构建/测试，未提交、安装或发布。

## 12. 实际实现补充

- 原生启动最终复用 `useHandleNewThread` 的既有初始化与阶段式导航，增加可选 `standalone`、`expertId` 及 `navigation.isCurrent`，而不是在新适配器复制初始化流程。standalone 强制新草稿且不执行主槽认领；普通调用者不传这些参数时保持既有行为。`createDraftThread` 的可选注册字段同时补齐。
- Sidebar 从当前真实任务路由传入 `projectId/sourceThreadId`，Expert → MCP → Expert 保留允许的上下文字段。宿主只继承匹配项目的来源任务/草稿工作区，避免静默选取最近项目。
- `ExpertsSettingsPanel` 以可选 `centerRoute` 接入单一父路由，复用其原有状态和控件；旧设置使用跳转薄壳。专家团与技能库后续按下节移入中心，仍复用原编辑器。
- 历史复用任务状态解析器，回合完成显示“回合已结束”；同步游标延续 root 重挂前代次。静态边界清单覆盖新增接入和回归测试。

## 13. 专家团与技能库整合（2026-10-28）

依据用户后续直接要求，替代初版“专家团继续留在设置”的安排。父布局仍为 `_chat`，数据所有者不变：Expert/Skill 使用既有 server 资源接口，专家团使用既有 hubTeams 接口；没有新增 RPC、迁移或任务运行路径。

- 父路由 `/experts` 的可选 `kind` 接受 `teams` / `skills`；省略表示个人专家。`/experts/$expertId` 始终展示个人详情，原 `tab` 语义不变。分类切换保留允许的项目/来源上下文，并回到各分类列表。
- `ExpertsSettingsPanel.centerRoute` 接受分类及导航回调；保留个人 Expert 原控制器，条件挂载原 `HubTeamsSettingsPanel` 和按需加载的 `SkillLibrarySettingsPanel`，不新增第二套编辑器。
- `useExpertDraftGuard` 的可选导航判定接收当前/目标查询参数，个人专家和专家团可识别同路径的分类切换。个人同详情页签仍不触发离开保护；技能详情沿用自身既有路由保护。
- Settings adapter 统一使用 `expertCenterSectionRouteTarget(kind, search)`，仅保留允许的上下文字段。旧 Experts 有 ID 时进个人详情，无 ID 时进团队；旧 Skills 始终进技能库。MCP 的连接 ID、授权及返回个人专家 helper 保持原样。
- 复用 `SettingsSegmentedControl`、`SettingsSectionShell.count/layout` 与 `SettingsListRow.layout`；团队紧凑列表不另建控件。技能库查询、编辑、上传、绑定和更新流程均未改动。

本次仅改变 Web 入口、分类与编辑离开判定，不改任务草稿生命周期、进程或数据库。检查取 C + 受影响浏览器 + 接入边界；沿用初版未改路径的历史验收边界，不把 0.1.7 全库与真实 Provider 结果改记成本次验证。实际记录见[整合验收](./expert-center-organization-2026-10-28.md)。
