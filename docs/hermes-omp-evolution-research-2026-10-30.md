# Hermes 学习进化能力迁移至 Synara OMP 技术调研

日期：2026-10-30，Asia/Shanghai。状态：能力与源码调研，包含架构建议和待执行验收；不是实现方案已批准、功能已完成或运行验收记录。

结论：在 Synara 中以 OMP 执行 Hermes 式前台学习、后台复盘、Skill 管理、可选写入审批、Space 记忆和技能库维护，未发现必须替换现有宿主架构的障碍。它们需要迁移业务机制，不能只打开 OMP 的 autolearn 开关。独立的评测型自进化可以建设，但 Hermes 的独立 self-evolution 仓库存在源码衔接问题，不能直接当作成熟模块引入。

## 1 范围与调研基线

### 1.1 已确认的产品输入

- 对齐 Hermes 在前述讨论中的日常学习与进化能力，包括主动学习、使用中修订、后台复盘、自动写入与可选审批、使用记录、技能库维护、版本与恢复。
- 记忆统一归属当前 Space；用户偏好、环境事实可以区分类型，但不因此另建 Expert 私有 Memory。
- 不建设或移植历史会话搜索与跨会话召回。读取当前任务的执行过程、读取现有 Skill/Space 记忆、使用明确提供的评测样例不属于历史会话检索。
- 下一版优先适配 OMP 与 Pi，保留多 Harness 边界；不移除既有其他适配器，不隐式切换用户的模型、实例或账户。
- 增加自进化能力。这里区分日常经验修订与“候选生成—执行评测—择优采用”的优化循环。
- 本轮只调研。界面、运行代码、依赖、全局 OMP 配置、生产数据、安装与发布均未变更。

### 1.2 固定来源

| 对象                       | 调研基线                                                 | 使用方式                                             |
| -------------------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| Synara Expert              | 本地 HEAD f879925a46897e6a4b70d0a575a22f95721e1af5       | 读取当前实现与既有验收；6 份既有未提交文档保持原样   |
| Hermes 主仓                | ef35e8b9e1a8bc7f0efb50e4f2d68f1ec052f6a8                 | 固定提交读取学习、记忆、审批、Curator 与文档         |
| OMP 已用版本               | v18.12.1，对应 291e055836c210f314af3f73f53244e8e9d09de8  | 读取标签源码，并核对本机已安装包版本及 CLI 摘要      |
| OMP 当前 main              | 338d2ce6658dfdbfba19efe0f006f0d5a8edd66d，包版本 18.14.0 | 了解新增接口，不能替代 18.12.1 的兼容性证据          |
| Hermes 独立 self-evolution | 0a929e3aa20e15cf04dc7c28492a7d41a5139125                 | 读取实际优化、评分和约束代码；未将未合并 PR 视为能力 |
| Pi 当前依赖                | bun.lock 中的 SDK 0.87.1                                 | 沿用现有 PiAdapter，不以最新网页接口冒充已安装接口   |

本机 OMP CLI 为 17,638,974 字节，SHA-256 为 c5d51fbb4d787035f3cec7b3579234de4c55b169574a094e2a672bb68970992d，与仓库当前 ACP 兼容层固定的构建一致。此检查只读取包文件，未启动模型、修改认证或运行用户任务。

“可对齐”表示已找到可行接口或可复用实现，不表示已经通过真实 OMP/Pi 测试。没有用主观百分比表示完成率。

## 2 能力对齐矩阵

| 编号与能力                    | Hermes 实际机制                                                         | Synara 当前状态                                                          | 对齐结论与主要工作                                                            |
| ----------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| C01 Skill 发现与按需使用      | 先读目录，再按需读取入口和主题资源                                      | 已有技能库、专家绑定、固定 Run 装配和原生目录核验                        | 基础较好。保持通用 Skill；为专有工具依赖保留 Harness 适用范围                 |
| C02 前台主动创建与修订        | Agent 通过 skill_manage 创建、编辑、定向 patch、删除或增删支持文件      | 有用户侧资产操作和手动提炼；没有对应的专家学习工具入口                   | 可功能对齐。增加受当前会话约束的学习写入口，复用正式技能库                    |
| C03 用户纠正与使用中改进      | 将纠正、缺失步骤、失效方法作为学习信号，优先完善正在使用的 Skill        | 用户可事后选回合；未自动关联信号与实际使用版本                           | 可对齐。保存来源、已用 Skill 身份和证据；不能仅靠最后一条总结                 |
| C04 从资料学习                | /learn 在正常 Agent 回合中读取用户指定文件、网页、文档并编写 Skill      | 导入资产与无工具提炼存在；指定资料的学习流程未接通                       | 可对齐。复用正常任务读取资料，学习服务负责结构与正式写入                      |
| C05 自动后台复盘              | 达到周期条件且回合正常交付后，分离会话快照，受限工具复盘                | 没有自动触发；现有提炼任务只接受选定正文且禁用工具                       | 可对齐，需宿主接入。复盘拥有独立执行身份、预算、取消和写入授权                |
| C06 手动聚焦复盘              | /refine 可立即发起带重点的复盘，与自动触发开关区分                      | 手动提炼已有重点输入、原生任务链接和取消                                 | 可复用现有产品基础；扩展来源与执行模式                                        |
| C07 长期记忆                  | 用户资料与环境笔记分开维护，启动注入快照，可增补、修改和删除            | Space Context 有目标/指令；Hub 有另一套项目记忆，不是通用 Space Memory   | 按用户要求改为 Space 归属，功能可对齐；需要正式记忆服务和注入契约             |
| C08 自动写入与可选审批        | skills.write_approval 与 memory.write_approval 默认关闭；开启后暂存待审 | 进化一律生成候选后手动采用；Skill 另有 protected/shared/independent 策略 | 可对齐。自动化授权必须进入服务端，不能只让模型“自认已获批”                    |
| C09 新能力生效与通知          | 目录变化可通知后续消息；正式系统目录在边界刷新                          | 已有下一独立 Run 更新、当前/恢复 Run 固定版本                            | 达到后续工作复用的能力等价；保留 Synara 固定 Run 语义，不承诺原生缓存行为一致 |
| C10 使用与改进记录            | 记录查看、使用、修订及时间，供学习旅程与维护使用                        | 技能库 usage 主要表示哪些专家绑定；已有装配、初始化和版本记录            | 可对齐。绑定人数、已装配、已读取、任务成功必须分开统计                        |
| C11 陈旧管理与归档            | Curator 默认做确定性陈旧判断与可恢复归档，保护固定技能                  | 无对应生命周期；已有删除引用检查和包保留                                 | 可对齐。增加托管资格、固定、状态与恢复，引用和运行中的包不得丢失              |
| C12 LLM 合并与去重            | 可选 consolidation，整包处理支持资源与路径，不只是拼接入口              | 没有自主合并和绑定迁移流程                                               | 可对齐，工作量较大。合并内容、资源、绑定和恢复要有逐阶段回执                  |
| C13 修改审计与恢复            | 写入账本、前后内容快照、来源与维护记录                                  | 已有不可变包、候选摘要、版本比较、采用 intent、派生和恢复                | 可大量复用；补全前台/后台/维护/优化的来源记录                                 |
| C14 评测型自进化              | 独立仓库尝试 DSPy/GEPA；不属于主仓日常复盘                              | 尚无评测优化循环                                                         | 可建设，不宜原样移植。首先解决真实 Harness 评测、候选持久化与发布门禁         |
| C15 历史会话搜索              | session_search、历史数据库与召回                                        | 不纳入本次目标                                                           | 明确不迁移；也不以评测挖掘为名扫描历史会话                                    |
| C16 工具实现/系统提示自动优化 | 独立仓库 README 将相关后续阶段列为 Planned                              | 无本轮实现                                                               | 不能宣称有成熟上游模块可迁移。作为后续研究范围，不冒充 C14 已覆盖             |

C01—C13 是本轮要求的日常能力；可以以统一服务实现产品能力等价。C14 需要单独的实验与验收；C15 按要求排除；C16 区分规划与实现。上述分类不等于工期承诺。

## 3 Hermes 的学习闭环到底做什么

### 3.1 前台学习与资料学习

skill_manage 不只写一份总结。它支持入口编辑、定向 patch 和支持文件增删，并在写入后记录账本、使用侧信息与目录变化。后台修改现有内容还有先读后写约束。/learn 的主要实现是将用户的资料学习要求变成一条有编写规范的正常 Agent 请求，再由 Agent 使用已有读取工具和 skill_manage 完成。[H03][H05]

可迁移的是“识别经验—先查已有方法—读取准确版本—修改—验证结构—写入—通知”的机制。Hermes 的 Python 类、工具注册表、路径与会话存储不能直接放入 Synara 的 TypeScript 运行层。

### 3.2 自动复盘的触发与隔离

Hermes 的默认 Skill 周期参数为 creation_nudge_interval=10，计量对象是内部工具调用迭代，不应解释成“每 10 条用户消息”。回合结束时还要满足有最终回复、未中断、未被专用任务禁止后台复盘等条件。只有阈值满足，不代表模型一定产出有用经验。[H01][H02]

后台复盘使用分离的会话消息快照。相同模型路径尽量复用原提示前缀；显式路由到其他模型时会改用摘要。实际工具分派另有白名单，包括技能工具、符合条件的记忆工具和只读文件工具；提示中能看到某个工具不等于有权调用它。新前台回合可抢占复盘，取消有单独握手与等待上限。[H01]

因此，对齐需要真实的后台任务生命周期与权限，不能仅添加一句“任务结束后请反思”。也不能让后台模型继续控制原前台会话、无限等待或在新用户操作后覆盖旧目标。

### 3.3 Memory 与 Skill 分工

Hermes 将用户资料和环境笔记分开，文件有容量限制，会话启动时注入固定快照。Memory 增删改与 Skill 写入都支持独立审批开关。模型说“已记住”不等于实际写入完成。[H06][H07]

迁移到 Space 后仍可保留 profile/environment 等类型。归属变为 Space，不应把自动学到的事实直接追加到人工 sharedInstructions，更不能让另一个 Space 继承这些内容。

### 3.4 Curator 的默认行为需要准确对齐

固定基线的默认值是：维护开启；检查间隔 168 小时；最小空闲 2 小时；14 天无活动标为 stale；30 天无活动可归档；LLM consolidation 默认关闭。第一次观察先建立时间基线，不立即清理旧库。归档资格与作者身份不是同一个概念，不能因字段叫 created_by 就认定原作者。[H08][H09]

默认托管范围主要是后台学习生成的技能；手写、外部或用户前台创建的技能不因此自动获得归档资格。固定、任务引用和支持文件需要保留。使用计数用于维护，不是成功率，也不是方法正确性的证明。[H08][H09]

## 4 OMP 已有能力及其接入限制

### 4.1 当前 18.12.1 已有学习原语

标签源码与已安装包均可核对 autolearn.enabled、autolearn.autoContinue、autolearn.minToolCalls、managed-skills 与 restrictToolNames。主开关和自动继续默认关闭；默认最少 5 次 tool_execution_end，且跳过中断、计划模式和 Goal 模式回合。它的阈值单位与 Hermes 的迭代次数不同。[O01][O02]

OMP 通过私有 capture Agent 分离消息和 Provider 会话状态，带走原会话当前已有消息中的工具执行上下文；不是扫描所有系统日志。当前版本已有这些原语，因此本轮功能目标没有证明必须先升级到 18.14.0。[O03]

### 4.2 原生 Skill 写入口不足以直接替代 Hermes

manage_skill 只处理隔离 managed-skills 下的创建、更新和删除，以名称及入口正文为主要参数，完整入口上限为 64,000 UTF-8 字节；不会直接修改用户编写的同名 Skill。其管理范围与 Hermes 可修改整包资源的 skill_manage 不同。Synara 的正式 Skill 又是稳定 ID、版本、不可变包和专家绑定，不能靠往 managed-skills 写文件替代。[O04][L04]

learn 工具先保存记忆，再可选写入 Skill。因此可能出现记忆成功、Skill 失败的部分结果。它只对明确支持的 local/hindsight/mnemopi 后端开放，不是任意 MemoryBackend 接口实例都能直接使用。当前原生返回“已写入”也不能证明 Synara 绑定和下一 Run 装配已成功。[O05]

### 4.3 Space Memory 不是一个可填写的现成 backend 值

OMP 有 MemoryBackend 接口，但 backend ID 是固定联合类型，resolver 对几个内置值显式分派；没有在已核对的 resolver/SDK 构造选项中找到任意自定义 Space backend 的注入入口。learn 也直接依赖具体后端，而非统一调用一个可替换 save。不能只配置 memory.backend=space 就完成接入。[O05][O06]

可行做法是通过 Synara Gateway 暴露受当前会话约束的 Space 记忆工具；若将来决定复用 OMP 原生 backend，则需要补充并验证上游扩展点或维护明确的适配补丁。

### 4.4 原生 capture 默认不能调用 Synara 学习工具

18.12.1 的 SDK 在组装私有 capture 时，只从当前 session 按名称取 manage*skill 与 learn；普通 MCP/Gateway 工具不会因为前台可见而被自动纳入。源码还显式避免 fallback 将 capture 的调用转给主会话 MCP。仅接入 synara*\* 学习工具并开启原生 autolearn，后台仍可能没有写入口。[O03]

可在受控 SDK 层调用导出的 createAutoLearnCaptureRunner 并提供工具，也可建设宿主拥有的独立复盘任务；当前 ACP 集成不能直接当作对这些 SDK 构造参数的访问。

### 4.5 SDK 与 Pi 的兼容边界

OMP 的 toolNames 单独使用不是白名单；受限模式还需要 restrictToolNames。受限模式下自定义工具、扩展、MCP 的加载另有规则，后续动态注册和原生子任务也要验证。类似名称的参数不能被认定与 Pi 具有相同权限语义。[O03][O07]

Synara 当前 Pi 走 SDK，OMP 走 ACP。新的 OMP SDK 文档要求 Bun 1.4.4+，而仓库固定 Bun 1.4.2，桌面服务还存在 Node 运行方式。直接把最新 OMP SDK 嵌入服务涉及工具链、原生依赖、打包和进程生命周期，不是替换 import。优先沿用已验证 ACP 边界；SDK worker 是需要专项论证的后续路径。[O07][L01][L02]

## 5 Synara 当前真正缺少的部分

| 缺口                    | 源码事实                                                                   | 对迁移的影响                                             |
| ----------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------- |
| 进化来源仅正文          | sourceFor 将所选消息映射为 threadId/messageId/role/text                    | 无法可靠还原“调用—报错—修正—验证”                        |
| OMP 进化未开放          | 能力表将 omp 标为不支持；受限提炼适配只覆盖已实现端                        | 不能只改 supported=true，需要证明执行限制与回执          |
| 提炼禁止学习工具        | skill-evolution purpose 去除 Expert、Context、恢复与外部工具               | 新后台学习模式需要独立的受限能力；不能悄悄放宽旧 purpose |
| 面向用户的写入口        | 当前进化 RPC requireOwner，采用还要候选摘要与版本核对                      | Agent 调用需要会话授权的窄入口，不能转发任意 owner 请求  |
| Space 只有 Context 契约 | SpaceContextSettings 是目标、共享指令和 revision，没有通用可增删改记忆条目 | 需要 Space 记忆数据服务；不是替换一个磁盘目录            |
| Hub 记忆归属不同        | synara_project_remember 只允许 Hub 线程/协调者，归属 projectId             | 可以复用规范和部分持久化经验，不能冒充 Space Memory      |
| 活动投影会截断          | 活动数据整体约 16,000 字符、单字符串约 2,000 字符，且有数组/字段上限       | 页面上可读的工具记录不等于完整学习证据                   |
| 原始事件有保留策略      | 单事件上限 2 MiB；已接受事件尾部保留基线 512，另有未完成/检查点保护        | 回合结束后才读取，不保证长任务的全部原始证据仍在         |
| 使用统计语义不足        | SkillLibraryItem.usage 表示专家绑定；Run 记录证明装配与初始化              | 缺少实际读取/使用/复用记录，不能直接拿绑定数驱动 Curator |
| 缺自主治理与评测        | 当前候选、版本和恢复已实现，没有后台托管生命周期或优化试验                 | 复用资产可靠性，增量建设学习业务                         |

上述事实来自 [L03]—[L09]。现有原始事件可包含工具输入、输出和内容，但实际完整性还受 Provider 是否发出、日志截断、事件留存和附件可读性影响；不能声称已经拥有无损轨迹。

## 6 推荐接入路线

### 6.1 选择功能迁移并复用现有运行边界

推荐路线是：Hermes 提供能力规范；Synara 管理学习策略、资产、记忆、审批与维护；OMP/Pi 执行原生任务和受限复盘。不是把 Hermes Python 进程嵌进 OMP，也不再建立一套 Agent 执行器、事件总线或 Provider 管理器。

| 路线                             | 可复用部分                                               | 代价与边界                                                              | 判断                                     |
| -------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------- |
| A Synara 学习服务 + 既有 OMP ACP | 正式 Skill 库、Gateway、事件持久化、原生任务、审批与取消 | 要补学习工具、证据快照、受限复盘和 Space 记忆                           | 推荐首条落地路线，最利于同时支持 Pi      |
| B OMP 原生 autolearn + 定向扩展  | 原生 capture、会话快照与事件 Hook                        | 工具名单、Memory backend、资源写入、后台回执与宿主生命周期都需适配      | 可作局部优化；不能作为“开关即对齐”的捷径 |
| C OMP SDK 受管 worker            | 更直接控制工具、会话及 capture 构造                      | 引入 Bun/原生包兼容、进程与桌面打包工作，须替代相应执行路径而非并行双写 | 只有 ACP 的具体能力缺口无法补齐时再选择  |

路线 A 不排除使用可信 OMP 扩展收集精确 Skill 读取等证据，但持久化、授权和写入仍由 Synara 拥有。路线 B/C 如被选中，应给出固定版本及补丁范围，不将原生 Fork 当成免费兼容层。

### 6.2 所有权与宿主边界

| 模块           | 拥有的数据/行为                                     | 接入方式                                                   |
| -------------- | --------------------------------------------------- | ---------------------------------------------------------- |
| 专家进化模块   | 学习信号、来源快照、复盘请求、优化试验、维护建议    | 扩展现有 experts/evolution，通过 workbench/host 注入窄能力 |
| 正式技能库     | Skill ID、修订、不可变包、派生与专家绑定            | 复用 SkillLibraryStore/Operations；不能直接写投影目录      |
| Space 记忆服务 | Space 归属、条目类型、版本、来源、容量与待审修改    | 新增正式窄契约；不借用 Hub projectId 或人工指令字段        |
| Synara 宿主    | Thread/Run、Provider 实例、事件消费、执行取消和恢复 | 复用 ProviderService、原生任务准入与持久命令链路           |
| OMP/Pi 适配器  | 原生能力、轨迹转换、工具约束、注入与实际应用回执    | 扩展既有 ProviderAdapter，不新增并行 HarnessAdapter 框架   |
| 公共契约       | 来源、学习请求、写回执、记忆修改、试验与能力说明    | packages/contracts 只定义 schema，不加入运行编排           |

## 7 关键技术设计要求

本节是候选设计要求，后续正式架构决策应纳入现有架构标准，操作与检查进入研发 SOP，实测结果另记验收。

### 7.1 学习证据包

来源必须绑定 owner、数据实例、Space、Project、Thread、Turn、rootRunId、装配 ID 与源 Harness/版本。内容至少包含用户要求与纠正、助手正文、实际工具输入与结果、工具失败与重试、产物引用及已有验证结果；每项保留来源身份与截断标记。

应在原始事件被裁剪前，在既有持久消费/投影链路中形成有界证据快照。学习模块只读取宿主暴露的快照，不另开消费者竞争适配器事件流。长输出采用相关片段与受控产物引用，明确丢失范围，不无限复制日志。

调试日志是 best-effort 且轮换，不应作为唯一业务证据。工具完成、命令退出 0、测试通过、用户验收分别记录；缺少验证不能被助手自述补成成功。

### 7.2 前台工具与资料学习

提供 Skill 读取、创建、定向修订、支持资源增删、以及 Space 记忆增删改等窄能力。工具的具体名称待契约方案确定；“使用 MCP”不意味着模型可以传任意 Space 或拥有 owner 权限。

目标归属由服务端从当前会话及授权学习请求解析。编辑前读取准确版本；正式写入继续使用 expectedRevision、稳定 requestId、候选/修改摘要和持久回执。共享、独立派生、受保护等规则由服务器决定，模型只提供内容与理由。

/learn 式资料学习使用用户已授权的正常任务工具，读取指定资料后写回方法。不能因为学习工具存在就授权后台无限读取其他项目、执行资料内命令或扩大工具权限。

### 7.3 自动写入与审批

触发方式、资产范围和写入审批是三个独立维度。支持前台与后台自动写入，也支持统一暂存、预览、批准和拒绝；开启审批后两条路径都必须经过同一写入门。

不能保留“所有进化都必须手动采用”的硬限制后宣称与 Hermes 对齐。也不能将“自动学习开启”解释为允许改归属、分享范围、受保护资产或其他 Space。现有用户明确配置的保护策略要迁移并显式表达，不被模型或默认值覆盖。

采用授权固定到准确内容与目标版本。写入完成、绑定完成、实际装配分开回执；部分完成可恢复，重试不重复创建 Skill。取消停止新工作，并不声称能撤回已经提交的资产修改。

### 7.4 后台复盘

复用原生任务执行，分配与前台独立的学习请求身份；固定源快照、来源 Space、模型/实例和允许的资产范围。仅开放本轮需要的只读与学习写接口，不继承任意业务 MCP、Shell、子代理或电脑控制。

学习任务和维护任务本身不再触发学习，避免递归。对同一来源边界去重、合并连续触发，限制并发、回合、输入与总预算。前台继续工作或用户取消时，按明确策略抢占或延后，任何写入前再次检查授权与版本。

原生会话固定装配保留：当前/恢复/自动续接 Run 使用原版本，新独立 Run 解析新内容。后台不修改前台系统提示或活跃上下文。这是 Synara 的运行一致性，不应伪称和 Hermes 的缓存/目录刷新逐字节一致。

### 7.5 Space 记忆

建议采用条目化正式存储，至少包含 Space ID、类型、内容、revision、来源、创建/更新时间及删除状态。记忆容量限制与精简动作可配置；超限有可读回执，不能悄悄覆盖人工指令。

任务启动只注入所属 Space 的有界记忆快照；需要即时读取时走同一 Space 服务。Space 切换、删除、项目搬迁、恢复和后台延迟提交必须校验真实归属。没有 Space 的任务不猜测其他 Space 作为写入目标。

对本 Space 记忆进行精简或按类型读取不等于历史会话检索。本次不引入 session_search，不扫描其他会话来自动补全记忆。

### 7.6 使用记录与 Curator

分别记录绑定、装配、原生确认可见、实际读取、再次使用和修改。工具名或助手声称使用了某技能不足以证明读取；通过原生读取事件/可信扩展与装配资源路径映射核对，无法证明时记 unknown。

托管资格、固定状态和作者身份使用不同字段。默认先做无模型的陈旧维护，LLM 合并可独立启用。引用中的技能、定时任务依赖、当前 Run 包及可恢复版本进入保留检查。归档是可恢复生命周期，不复用永久删除冒充归档。

合并必须处理支持文件、相对链接、名称冲突、专家绑定和依赖引用；不能只合并 SKILL.md。资产、绑定与模块数据并非天然跨介质原子事务，沿用 intent/阶段回执补偿，不在失败时报告整体完成。

### 7.7 多 Harness 能力说明

在现有 adapter 能力边界上说明：轨迹覆盖及截断、学习工具接入、受限复盘、当前快照输入、Skill 使用证据、取消/恢复和固定装配的实际支持状态。能力必须绑定版本/实例及验证状态，不以 provider 名称推断。

通用 Skill 与 Space 记忆由 Linx 管理；专有工具步骤保留其依赖。共享源码之前先证明输入/输出与生命周期等价，不能因 OMP 来自 Pi 就共用两端的 resume cursor、SDK 类型或所有扩展代码。

## 8 评测型自进化的真实可复用程度

### 8.1 独立上游实现不是成熟的直接迁移包

README 将 Skill 优化列为 Implemented，将工具描述、系统提示、代码和持续流水线列为 Planned。实际入口使用 DSPy，候选评估主要是文本任务输出与 LLM Judge，不是调用 Synara OMP 执行真实工具工作流。[E01][E02][E03]

固定源码中有三处衔接问题：

1. SkillModule 将原文存在 self.skill_text，并作为 predictor 的输入字段；导出时却读取 optimized_module.skill_text。源码没有把优化后的 predictor 指令转换回可保存的 Skill 正文。当前闭环存在“评分对象变了，保存正文仍取旧字段”的风险，不能将优化后的分数当作已保存 Skill 的收益。
2. 入口将去除 YAML frontmatter 的 skill body 传入 validate_all；其中结构检查却要求以 frontmatter 开头并含 name/description。普通不带 frontmatter 的正文会被最终结构校验拒绝。
3. constraints 中有 run_test_suite，但 evolve 入口未调用它；run_tests 参数被传入配置，不等于完整测试已执行。README 中“所有候选经过完整测试”的表述不能代替调用链证据。

本轮做了离线 AST 与最小输入核对：skill_text 在模块内的赋值为第 106 行，导出从该字段读取为第 183 行；evolve 中调用 run_test_suite 的数量为 0；普通正文无法满足前述 frontmatter 检查。该核对没有安装 DSPy、调用真实模型或运行 GEPA 端到端实验。[E02][E04]

### 8.2 推荐建设方式

保留候选搜索、固定评测集、训练/验证/保留集分离及收益比较的思路。优化器只产生准确的候选包；用同一 Harness/版本、模型选择、输入、工具授权与测试环境分别运行基础版和候选版。修改对象在试验中必须是实际装配的候选包，不能只优化评测提示而保存旧 Skill。

评测来源用用户明确提供的样例、当前任务固定证据或受控生成样例；不启用独立仓库的 sessiondb 历史挖掘路径。保留集不参与候选生成。可执行测试、产物校验和任务达成优先；表达性任务可辅以模型评分，但应标为辅助评分。

采用需满足非空样本、关键回归通过、实际输出与保存内容一致、版本未过期、预算内及当前写入策略。无提升时保留基础版。取消、崩溃和评测失败不发布，支持精确版本恢复。

OMP 的 metaharness 已有基准执行、trace、费用与分数归一化基础设施，但面向仓库基准任务，不是现成的用户 Skill 自动进化服务。可以参考其数据模型或后续接入专用基准，不应为首期学习闭环整体引入该服务。[O08]

## 9 实施拆分与退出条件

以下为依赖顺序，不是已授权开始编码或已完成状态。

| 阶段                    | 交付能力                                                   | 退出条件                                                      |
| ----------------------- | ---------------------------------------------------------- | ------------------------------------------------------------- |
| A 证据与能力探针        | 当前 Run 有界证据快照；OMP/Pi 学习工具、受限运行和取消证明 | 超长轨迹不冒充完整；原生工具接入与权限事实可核对              |
| B 前台学习与 Space 记忆 | 主动创建/修订整包 Skill；记忆增删改；自动写入与可选审批    | 两端真实任务能保存并在后续 Run 使用；Space 隔离及版本冲突通过 |
| C 自动/手动复盘         | 周期触发、聚焦复盘、独立任务、预算、前台优先和重启恢复     | 不递归、不双写、不阻塞原会话；取消有停止证据                  |
| D 使用记录与治理        | 可证明的使用事件、托管资格、陈旧/固定/归档/恢复、可选合并  | 完整包和引用保留；绑定迁移失败不伪报完成                      |
| E 实验型自进化          | 候选包、固定评测集、OMP/Pi 实跑、对比与采用                | 真正保存被评测的候选；无提升/失败不替换基础版                 |

下一版可将 A—D 作为日常学习对齐的验收范围，并包含 E 的受控试验能力；不能用“有一个 GEPA 按钮”代替 E 的完整退出条件。是否使用原生 capture、受控扩展或 SDK worker，应由 A 的实际结果决定。

## 10 必须执行的验收场景

| 场景                  | 预期证明                                                   |
| --------------------- | ---------------------------------------------------------- |
| 用户纠正方法/格式     | 生成对应 Skill 或 Space 记忆修改，来源准确，后续任务可读取 |
| 工具失败后修正并验证  | 经验包含适用条件与有效修正，不固化临时故障为长期禁令       |
| 已有 Skill 缺步骤     | 修订实际使用版本，保留无关内容、脚本和引用                 |
| 无新增经验            | 无需更新是正常结果，不制造空技能或重复记录                 |
| 明确指定资料学习      | 只使用授权资料，支持资源按主题组织，能再次调用             |
| 自动模式与审批模式    | 前台、后台、维护写入都遵循同一设置和资产保护               |
| 当前 Run 与下一 Run   | 活跃/恢复 Run 不变，新独立 Run 实际装配新版本              |
| 并发修改与重复请求    | 旧版本冲突；同一请求不重复生成或绑定；部分失败可续办       |
| 前台抢占与取消        | 后台不会占用前台会话状态，停止与已提交修改分别报告         |
| 长任务/原始事件被裁剪 | 证据截断可见；有界快照保留所需片段，缺证据不编造           |
| Space 切换/项目搬迁   | 后台不能把原 Space 内容写入新的 Space，也不能读错记忆      |
| 新技能再次使用        | 记录实际装配与读取，不用目录存在或助手文字代替             |
| 陈旧归档与固定技能    | 只处理明确托管范围，运行引用保留，可恢复完整内容           |
| 技能合并              | 支持文件、链接和引用正确迁移，失败有原包与恢复入口         |
| 自进化收益            | 比较实际候选与基础版；保留集隔离；保存内容与被评测内容一致 |
| OMP 与 Pi 对等场景    | 分别得到真实运行证据；一端通过不替另一端背书               |

实施后的自动检查按影响执行格式、Lint、类型、受影响测试和边界检查；进程边界/迁移变化分别加 Windows runtime/migrations 检查。桌面打包、平台行为和模型实跑单独记录，不等同于单元测试通过。

## 11 本轮结论与验证边界

- 日常学习 C01—C13：有可行迁移路径，资产与生命周期部分已有可复用基础；主要工程量在学习服务接入、证据完整性、Space 记忆和治理，不在重新编写 Agent Loop。
- 当前 OMP 18.12.1 已含关键学习原语，但未接通 Synara 资产；本轮没有证明必须先升级 OMP，亦没有证明开启开关即可达标。
- 自进化 C14：应按真实 Harness 评测建设受控能力，独立上游实现只作为设计参考，不能直接宣布功能对齐或效果提升。
- 历史检索 C15：明确排除。C16 的规划能力不能作为现成迁移对象。
- 本轮完成固定源码核对、本机 OMP 包摘要核对、离线结构检查；未启动 OMP/Pi 模型任务、未测成本/时延/效果、未验证操作系统沙箱或打包行为。表中可行性不是验收完成率。
- 仅新增本文。未覆盖工作区既有 6 份用户文档改动，未安装依赖、创建 worktree、启动预览、修改应用代码或生产数据。

## 12 证据索引

### Hermes 主仓

- [H01 后台复盘与工具白名单](https://github.com/NousResearch/hermes-agent/blob/ef35e8b9e1a8bc7f0efb50e4f2d68f1ec052f6a8/agent/background_review.py)：分离快照、模型路由、取消、工具白名单与费用记录。
- [H02 周期初始化](https://github.com/NousResearch/hermes-agent/blob/ef35e8b9e1a8bc7f0efb50e4f2d68f1ec052f6a8/agent/agent_init.py)与[回合末触发](https://github.com/NousResearch/hermes-agent/blob/ef35e8b9e1a8bc7f0efb50e4f2d68f1ec052f6a8/agent/turn_finalizer.py)：默认周期与交付/取消条件。
- [H03 Skill 写工具](https://github.com/NousResearch/hermes-agent/blob/ef35e8b9e1a8bc7f0efb50e4f2d68f1ec052f6a8/tools/skill_manager_tool.py)与[后台写入约束](https://github.com/NousResearch/hermes-agent/blob/ef35e8b9e1a8bc7f0efb50e4f2d68f1ec052f6a8/tools/skill_manager_guards.py)：资源写入、先读后写、固定与归档边界。
- [H04 Skill 官方说明](https://github.com/NousResearch/hermes-agent/blob/ef35e8b9e1a8bc7f0efb50e4f2d68f1ec052f6a8/website/docs/user-guide/features/skills.md)：资料学习、目录刷新与审批行为。
- [H05 资料学习提示构造](https://github.com/NousResearch/hermes-agent/blob/ef35e8b9e1a8bc7f0efb50e4f2d68f1ec052f6a8/agent/learn_prompt.py)。
- [H06 Memory 官方说明](https://github.com/NousResearch/hermes-agent/blob/ef35e8b9e1a8bc7f0efb50e4f2d68f1ec052f6a8/website/docs/user-guide/features/memory.md)与[Memory 工具](https://github.com/NousResearch/hermes-agent/blob/ef35e8b9e1a8bc7f0efb50e4f2d68f1ec052f6a8/tools/memory_tool.py)。
- [H07 统一写入审批](https://github.com/NousResearch/hermes-agent/blob/ef35e8b9e1a8bc7f0efb50e4f2d68f1ec052f6a8/tools/write_approval.py)。
- [H08 Curator 实现](https://github.com/NousResearch/hermes-agent/blob/ef35e8b9e1a8bc7f0efb50e4f2d68f1ec052f6a8/agent/curator.py)与[官方说明](https://github.com/NousResearch/hermes-agent/blob/ef35e8b9e1a8bc7f0efb50e4f2d68f1ec052f6a8/website/docs/user-guide/features/curator.md)：默认值、空闲条件、归档与可选 LLM 合并。
- [H09 使用记录](https://github.com/NousResearch/hermes-agent/blob/ef35e8b9e1a8bc7f0efb50e4f2d68f1ec052f6a8/tools/skill_usage.py)、[写入来源](https://github.com/NousResearch/hermes-agent/blob/ef35e8b9e1a8bc7f0efb50e4f2d68f1ec052f6a8/tools/skill_provenance.py)与[修改账本](https://github.com/NousResearch/hermes-agent/blob/ef35e8b9e1a8bc7f0efb50e4f2d68f1ec052f6a8/tools/skill_ledger.py)。

### OMP

- [O01 18.12.1 学习设置](https://github.com/can1357/oh-my-pi/blob/291e055836c210f314af3f73f53244e8e9d09de8/packages/coding-agent/src/autolearn/settings.ts)。
- [O02 18.12.1 学习控制器](https://github.com/can1357/oh-my-pi/blob/291e055836c210f314af3f73f53244e8e9d09de8/packages/coding-agent/src/autolearn/controller.ts)。
- [O03 18.12.1 SDK](https://github.com/can1357/oh-my-pi/blob/291e055836c210f314af3f73f53244e8e9d09de8/packages/coding-agent/src/sdk.ts)：私有 capture、工具筛选、受限模式和 Memory 启动。
- [O04 18.12.1 Skill 管理工具](https://github.com/can1357/oh-my-pi/blob/291e055836c210f314af3f73f53244e8e9d09de8/packages/coding-agent/src/tools/manage-skill.ts)与[managed-skills 写入](https://github.com/can1357/oh-my-pi/blob/291e055836c210f314af3f73f53244e8e9d09de8/packages/coding-agent/src/autolearn/managed-skills.ts)。
- [O05 18.12.1 Learn 工具](https://github.com/can1357/oh-my-pi/blob/291e055836c210f314af3f73f53244e8e9d09de8/packages/coding-agent/src/tools/learn.ts)；另核对[当前行为文档](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/docs/tools/learn.md)，两者版本分别标明。
- [O06 18.12.1 MemoryBackend 类型](https://github.com/can1357/oh-my-pi/blob/291e055836c210f314af3f73f53244e8e9d09de8/packages/coding-agent/src/memory-backend/types.ts)与[resolver](https://github.com/can1357/oh-my-pi/blob/291e055836c210f314af3f73f53244e8e9d09de8/packages/coding-agent/src/memory-backend/resolve.ts)。
- [O07 当前 SDK 文档](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/docs/sdk.md)、[扩展文档](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/docs/extensions.md)与[包信息](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/packages/coding-agent/package.json)。
- [O08 Metaharness](https://github.com/can1357/oh-my-pi/blob/338d2ce6658dfdbfba19efe0f006f0d5a8edd66d/packages/metaharness/README.md)。

### 独立 Self Evolution

- [E01 README 的已实现与规划范围](https://github.com/NousResearch/hermes-agent-self-evolution/blob/0a929e3aa20e15cf04dc7c28492a7d41a5139125/README.md)。
- [E02 优化入口](https://github.com/NousResearch/hermes-agent-self-evolution/blob/0a929e3aa20e15cf04dc7c28492a7d41a5139125/evolution/skills/evolve_skill.py)。
- [E03 Skill 模块](https://github.com/NousResearch/hermes-agent-self-evolution/blob/0a929e3aa20e15cf04dc7c28492a7d41a5139125/evolution/skills/skill_module.py)与[评分实现](https://github.com/NousResearch/hermes-agent-self-evolution/blob/0a929e3aa20e15cf04dc7c28492a7d41a5139125/evolution/core/fitness.py)。
- [E04 约束实现](https://github.com/NousResearch/hermes-agent-self-evolution/blob/0a929e3aa20e15cf04dc7c28492a7d41a5139125/evolution/core/constraints.py)。

### 本地实现与既有记录

- L01：[多 Harness 运行接口](../apps/server/src/provider/Services/ProviderAdapter.ts)、[PiAdapter](../apps/server/src/provider/Layers/PiAdapter.ts)、[OmpAdapter](../apps/server/src/provider/Layers/OmpAdapter.ts)。
- L02：[OMP 固定装配](../apps/server/src/provider/acp/OmpExpertSession.ts)、[精确构建兼容层](../apps/server/src/provider/acp/OmpAcpIdleTaskCompat.ts)、[工具链](../.mise.toml)。
- L03：[现有提炼服务](../apps/server/src/experts/evolution/SkillEvolutionService.ts)、[执行限制](../apps/server/src/provider/skillEvolutionConstraints.ts)、[owner RPC](../apps/server/src/workbench/host/skillEvolutionRpc.ts)。
- L04：[技能库契约](../packages/contracts/src/skillLibrary.ts)、[资产服务](../apps/server/src/experts/SkillLibraryStore.ts)、[Run 装配](../apps/server/src/experts/RunSkillAssemblyStore.ts)。
- L05：[Space Context 契约](../packages/contracts/src/context.ts)、[ContextRepository](../apps/server/src/context/ContextRepository.ts)。
- L06：[Hub 记忆工具](../apps/server/src/agentGateway/projectAgentTools.ts)、[Hub 服务](../apps/server/src/projectAgent/Layers/ProjectAgentService.ts)。
- L07：[ACP 工具输入输出](../apps/server/src/provider/acp/AcpRuntimeModel.ts)、[原生事件转换](../apps/server/src/provider/acp/AcpCoreRuntimeEvents.ts)。
- L08：[原始事件仓储契约](../apps/server/src/persistence/Services/ProviderRuntimeEvents.ts)、[事件保留实现](../apps/server/src/persistence/Layers/ProviderRuntimeEvents.ts)、[活动截断](../apps/server/src/orchestration/providerRuntimeActivityProjection.ts)、[轮换观察日志](../apps/server/src/provider/Layers/EventNdjsonLogger.ts)。
- L09：[当前进化验收](./expert-skill-evolution-acceptance-2026-10-29.md)、[多 Provider 历史验收](./expert-multi-provider-acceptance.md)。历史实测不能代替本轮新增学习能力的实测。
- L10：[当前架构标准](./workbench-adaptation-plan.md#current-standard-v11)、[开发 SOP](./workbench-development-workflow.md#execution-sop)、[原有 Expert 多 Harness 设计](./expert-product-technical-design.md)。
