# Synara Expert 与 Multica 智能体产品能力对照

日期：2026-10-28。范围：Expert 本身，以及使 Expert 能被配置、调用、协作、监督和复用的前后端产品能力。

**当前 Synara 更接近个人专业执行工作台，Multica 更接近人与智能体共同使用的任务协作平台。** 我们已有较完整的角色、技能、MCP、任务快照和本机执行能力；主要差距在于把这些能力组织成持续可分配、可触发、可统计、可由多人共同管理的工作系统。技能管理近期已明显靠近 Multica，不能再以旧版“本机路径列表”描述现状。

这里的“前端”指用户能找到和操作的产品入口，“后台”指配置生效、任务调度、权限、恢复和运营支撑。源码只用于核实能力，不展开技术架构。

## 1 比较基线

| 对象        | 本次采用的状态                                                                             | 解读边界                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Synara 源码 | 干净的 main，`2577e5819353e6089cc3f6e118e848f38df04913`；核对时与 origin/main 一致         | Skill 管理、Worker 上下文和 OMP 修复均已包含；不把历史分支当成待实现能力                                 |
| 日用应用    | 最近交付记录为 Personal Workbench 0.1.6，构建源 `d189ce8af2c8eec6ab30515cdaaee3485867b9d4` | 后续提交包含测试及记录更新；本次没有重新操作日用应用或执行模型任务。安装成功不覆盖每项功能的端到端验收   |
| Multica     | 官方文档与公开仓库 main，固定于 `8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663`                 | 源码实现和官方产品说明不等于所有部署、账号或已发布客户端均已开放；插件及 Composio 应用连接等存在部署门禁 |
| Linx V2.0   | 已确认产品方向                                                                             | Hermes Owner、Personal Assistant、Skill Evolution 等保留规划状态，不计入当前完成能力                     |

能力判断使用“已有”“部分”“未见同等入口”“规划”四种口径。“未见同等入口”限于本次核对范围；不据缺少某个页面推断底层绝无相关代码。

基线依据：[当前项目状态][S1]、[0.1.6 交付记录][S2]、[Multica 固定版本][M0]。这是一份产品能力与使用边界梳理，不是两款应用的实机性能或效果排名。

## 2 两边产品对象如何对应

| 我们的对象                         | Multica 对应对象          | 对应程度和产品差异                                                                                                            |
| ---------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Expert 定义                        | Agent                     | 角色、指令、技能、工具和执行偏好接近。Multica Agent 还直接拥有任务负责人身份、调用权限、工作负载和运行历史入口                |
| Thread 及其中的执行                | Chat、Issue 下的 Run      | 不能直接一一映射。我们的工作主要围绕对话与执行环境展开；Multica Issue 独立保存工作状态，一个 Issue 可以反复产生多个 Agent Run |
| Provider / Provider instance       | Runtime 的一部分          | Multica Runtime 同时表达“哪台机器、哪款工具、由谁共享、当前是否在线”。不能把多 Provider 支持等同于跨机器执行管理              |
| 统一 Skill Library                 | Workspace Skills          | 已非常接近：独立资产、完整资源、来源、绑定、更新和复用。我们的权限主要围绕个人 owner，Multica 围绕工作区成员                  |
| Hub、专家团、Coordinator 和 Worker | Squad、队长与成员         | 都有协调和分工。Hub 更侧重有状态执行及成果审核；Squad 更紧密地嵌入任务指派、评论路由和成员回复后的再次唤醒                    |
| Space                              | Workspace                 | 语义不同。我们的 Space 表达个人长期方向及上下文；Multica Workspace 同时是成员、权限、任务、技能和运行资源的协作范围           |
| Project Context                    | Project 说明与资源        | 都提供共享背景。Multica Project 还承载负责人、工作流、任务视图及仓库/本地目录资源                                             |
| Automation                         | Autopilot 和 Issue Wakeup | 我们已支持定时新任务与原线程续跑；Multica 又把外部触发、等待条件和任务状态联动做成独立产品                                    |

**两边都不能简单理解成“每个专家背后一直运行着一个进程”。** Multica Agent 的长期存在首先是身份、配置和历史的存在，工作到来才产生 Run。我们规划中的 Hermes Owner 另有持续服务语义，不能与已有 Expert 或 Multica Agent 混写。[Agent 定义][M1]、[运行时定义][M6]。

## 3 前端产品能力

### 3.1 专家创建与能力配置

| 能力           | 当前 Synara                                                          | Multica                                                          | 产品差异                                                                           |
| -------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 专家库         | 设置中的专家列表；新建、编辑、复制、归档、恢复、删除、预检和版本保存 | 独立 Agent 列表和详情；配置、状态、调用入口和历史围绕 Agent 组织 | 我们偏配置管理，Multica 更突出可被团队分配工作的协作者                             |
| 角色表达       | 名称、用途、Persona、输出要求、固定参考资料                          | 名称、头像、描述、Instructions、开场建议                         | 基本能力接近；Multica 明确区分展示介绍与执行指令                                   |
| 创建引导       | 表单编辑和已有示例；未见同等专用 AI Builder 流程                     | 先选在线 Runtime，再配置；支持对话式 Agent Builder，同时编辑草稿 | Multica 更完整地覆盖“不会写配置的新用户如何建立 Agent”；Builder 对运行时有可用条件 |
| 模型与工具适配 | Expert 支持 Codex、Claude Code、Pi、OMP；按当前 Provider 预检        | 绑定具体 Runtime，按工具展示模型、思考强度及可用能力             | 我们强调跨 Provider 复用定义；Multica 强调明确执行位置与工具能力                   |
| 调用范围       | 个人 owner 管理为主                                                  | 仅自己、整个工作区、指定成员                                     | Multica 将“能修改”和“能运行”分开，形成可共享的 Agent 资产                          |
| 可用状态       | 可用、部分能力可用、需处理依赖、不兼容等预检与任务运行信息           | 在线/离线/不稳定，加工作中/排队/空闲                             | 我们擅长解释配置能否生效；Multica 更适合从 Agent 列表判断谁现在能接活              |

依据：[Expert 契约][S3]、[专家管理入口][S4]、[Agent][M1]、[创建与配置][M2]。当前 Expert 四端支持不代表四端真实模型与所有原生能力均已验收，见第 8 节。

### 3.2 Skill 管理

| 能力           | 当前 Synara                                                                        | Multica                                                                                            | 产品差异                                                                                 |
| -------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 独立技能库     | 已有稳定 Skill 身份、完整不可变内容包、来源与标签                                  | 工作区技能库，可供多个 Agent 使用                                                                  | 已进入同一类产品能力                                                                     |
| 创建与导入     | 手工创建、本地目录/归档、托管 URL、从选定运行时复制                                | 手工、本地目录/归档、GitHub/ClawHub/Skills.sh、从连接电脑复制                                      | 我们仅核对本机四端，不含跨机器目录发现；浏览器目录上传、市场检索不在当前范围             |
| 列表管理       | 搜索；使用状态、来源、Expert、创建者、标签筛选；排序与显示控制                     | 具有相近的筛选、排序和选择操作                                                                     | 近期已明确参考并实现，不能再列作主要差距                                                 |
| 阅读与编辑     | 概览/文件页；Markdown 阅读预览和源码编辑；支持文件增删、上传替换和下载；草稿保护   | SKILL.md 与配套脚本、模板、资料管理                                                                | 两边都在维护可运行资源包，而不只是提示词正文                                             |
| 多对多装配     | 单 Expert 绑定及 N 个 Skill → M 个 Expert 批量追加，预演、冲突、部分成功与重试     | 从 Skill 或 Agent 侧绑定；同一技能可复用；绑定可禁用                                               | 我们已具有清楚的批量操作和并发保护语义                                                   |
| 技能使用边界   | Expert 只使用该次固定装配，空装配为零；未选 Expert 的普通任务沿用 Harness 原生技能 | 绑定 Workspace Skill，另可存在仓库原生 Skill 与运行时本地 Skill；部分工具支持逐 Agent 禁用本地技能 | 我们更强调受控装配；Multica 更强调与既有工具环境共存。两者都不能据此承诺 OS 文件访问隔离 |
| 来源更新       | 单项/批量更新，保留身份与绑定；覆盖本地改动需处理；更新冲突保留旧版                | 托管来源刷新，保留分配/标签/创建者；覆盖正文与支持文件                                             | 基本对齐；两边的“来源更新”都不等于模型自动学习                                           |
| 更新生效       | 当前 Run 及其恢复保留旧装配；未启动队列及下一根 Run 启动时取最新版                 | 正在执行的 Run 不变，之后领取的运行用保存配置                                                      | 都有运行边界；我们的不可变包与实际装配记录更强调追溯                                     |
| Agent 管理技能 | 已有窄权限 CLI、配对、dry-run、版本检查、可撤销凭据                                | CLI 可创建、导入、更新与绑定；遵循成员/资源权限                                                    | 我们已有管理通道，但没有自动创建默认管理 Agent                                           |
| 自动进化       | 尚未形成“任务反馈→改进提案→审查→发布→回滚”的产品闭环                               | 已证实手工/CLI 编辑与来源更新；没有据此确认通用自动学习闭环                                        | 不应把任何一边的技能库称为已完成自主进化                                                 |

依据：[当前 Skill 范围][S5]、[真实验证][S6]、[27 日审核修复][S2]、[Skill 前端入口][S7]、[Multica Skills][M3]。

### 3.3 MCP 与外部工具配置

| 能力       | 当前 Synara                                                      | Multica                                                                                            | 产品差异                                                        |
| ---------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 连接管理   | 本机 stdio / Streamable HTTP；连接测试、发现导入、凭据引用       | Agent 专属 MCP、工作区共享 MCP、运行时继承 MCP 三组展示                                            | Multica 的来源层级和共享关系更显性                              |
| 分配与范围 | Expert 选连接；显式工具列表或启动时读取全部并固定；必需/可选依赖 | 工作区添加一次再分配给多 Agent，支持单 Agent 关闭或移除；同名来源有覆盖顺序                        | 我们更细到连接/工具与会话授权；Multica 更突出团队复用和配置来源 |
| 启动前提示 | 必需依赖失败可阻止启动；可选依赖降级并保留说明                   | 是否支持受管 MCP 取决于 Runtime；继承来源可见                                                      | 我们的“预检→阻止或降级→记录实际配置”已构成产品能力              |
| 授权生效   | Gateway 按验证会话及固定快照处理工具发现和调用                   | 受管配置由运行时下发，结合工作区、Agent 和 Runtime 权限                                            | 两边权限对象不同，不宜只按“都有 MCP”判断等价                    |
| 凭据管理   | 凭据引用不进入 Expert 定义或快照                                 | 受管配置在服务器保存；共享 MCP 配置保存后不可读回，custom_env 有更严格读写审计，但为服务器明文存储 | Multica 本地执行不表示所有配置 secret 都留在电脑上              |

依据：[Expert 连接契约][S3]、[既有执行与授权规则][S8]、[Multica MCP 和敏感配置][M2]、[本机 MCP 合并][M6]。Synara 的 Beta 连接器产品与自定义 Expert MCP 连接也应分开判断；不能把某个 OAuth 连接器的支持情况推广到全部第三方工具。

### 3.4 开始工作与运行中交互

| 能力           | 当前 Synara                                                              | Multica                                                         | 产品差异                                                             |
| -------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------- |
| 发起工作       | 新任务输入区选 Expert，首次发送绑定快照                                  | 指派 Issue、评论 @、直接 Chat、自动化、任务唤醒                 | Multica 的触发入口覆盖协作过程更多环节                               |
| 直接对话       | 在任务/线程中选 Expert 工作                                              | 独立私人 Chat，可附加项目背景，另有全局悬浮聊天窗               | Multica 清楚区分私人探索与团队工作记录                               |
| 请求他人参与   | Hub、Worker、派生对话等显式执行路径                                      | @Agent/@Squad 可处理评论而不换负责人；回复可自动路由            | 我们的协作单元主要在执行编排，Multica 的协作单元主要在任务讨论       |
| 运行时干预     | 停止、用户输入、审批、队列与 Provider 相关交互                           | 停止、队列；支持工具可插话、下一轮执行或停止重启                | 两边都有干预能力，但 Multica 的任务评论路由选项更直接面向团队讨论    |
| 换专家或工具   | 已有 handoff、fork、换 Expert 的接续任务；有界转移历史信息               | Issue 可由不同 Agent 多次处理；原生会话尽量续用，失败可建新会话 | 我们对会话继承和配置固定更显式；Multica 保持业务任务身份不变更自然   |
| 检查配置与过程 | 专家版本、Persona、固定资源、实际 Provider/模型/运行组件、工具绑定等详情 | 逐 Run 查看触发来源、Agent、状态、工具日志、错误和用量          | 我们偏“这次配置是否真实生效”，Multica 偏“这项工作由谁在何时跑了几次” |

依据：[选择 Expert][S9]、[任务 Expert 详情][S10]、[Multica Chat][M4]、[评论路由与插话][M5]、[Runs][M7]。

**常用请求复用还有独立差异。** Multica Quick Actions 将“请哪个 Agent/Squad、做什么”保存成个人或团队操作：任务侧栏点击即执行，评论框 `/` 则先填草稿；不改变负责人和状态，暂不支持提示词变量。我们已有应用/Provider 斜杠命令、部分 Provider 原生提示模板和 Skill 复用，未见同等统一的“指定 Expert 加请求”的可管理操作资产。[Quick Actions][M32]、[我们的命令入口][S20]。

## 4 任务协作与成果交付

| 能力         | 当前 Synara                                                           | Multica                                                        | 产品差异                                                                            |
| ------------ | --------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 工作组织     | Space、Project、Task/Thread、Hub 和工作项                             | Workspace、Project、Issue、子任务、阶段和 Run                  | Multica 的任务属性与执行记录分离更完整                                              |
| 状态与优先级 | 对话运行状态及 Hub 计划/工作项状态；不能据此当作通用 Issue 系统       | 独立任务状态、优先级、日期、标签、自定义字段、父子关系         | 工作管理是 Multica 的主干产品之一                                                   |
| 多种工作视图 | 现有工作台、Hub 与列表入口                                            | 列表、看板、表格、甘特图、泳道及保存视图                       | Multica 更适合管理一组跨人跨 Agent 的工作                                           |
| 可复用团队   | Expert Team 配置、Coordinator/Workers、成员与协作指令                 | Squad 队长、Agent/人类成员、角色说明和小队指令                 | 两边都有团队抽象；Multica 人与 Agent 在同一名单中协作更自然                         |
| 协调方式     | 计划阶段、工作项、上下文包、提问与定向答复、暂停/恢复等               | 先唤醒队长，队长阅读任务后 @派发；成员反馈可再次唤醒队长       | Hub 更偏有状态编排；Squad 更偏围绕任务评论反复路由                                  |
| 阶段交接     | Hub 有阶段和审查机制，但真实成果审核与人工放行闭环仍有未验边界        | 可配置项目工作流：进入状态后交给某 Agent/成员，含通过/退回指令 | Multica 将“进入哪一步就交给谁”做成项目设置；一次 Run 结束仍不自动等于任务完成       |
| 审查与验收   | 有候选、Reviewer、用户放行等产品机制；T2 整体闭环未完整验收           | in_review、工作流交接、人工确认及 PR 合并状态联动              | 不能把我们的机制设计当作已验收优势，也不能把 Multica 状态流转等同于固定候选版本审查 |
| 文件成果     | 文件工作区、diff、Hub 成果展示与审查入口                              | 评论上传内容汇总为产物，支持类型筛选、同名版本、定位到评论     | Multica 更容易从任务找到最终交付；我们更直接贴近实际文件和代码工作区                |
| 项目开发操作 | 文件编辑/搜索、Git diff 与暂存、commit/push/pull/PR、终端、内置浏览器 | 项目仓库与本地目录供 Run 使用；任务侧显示 PR/CI/冲突和结果     | 我们已有较深的本机工作台，不是缺少“能动手做事”的界面                                |

依据：[Hub 当前完成边界][S1]、[第二／三阶段记录][S11]、[专家团队配置][S12]、[Git 操作][S13]、[Multica Issues][M8]、[Squads][M9]、[Workflows][M10]、[GitHub 联动][M11]。

Hub 当前对 Stable 和 Beta 均有产品路径，不能因为内部常量名称含 `BETA` 就判断它仅在 Beta 可用。[功能门禁][S14]。同时，Linx V2.0 的后续 Team 规划不抹去已有 Hub 能力；两者应按实际场景与完成程度分别讨论。

## 5 后台产品能力

### 5.1 执行位置与运行可靠性

| 能力         | 当前 Synara                                                | Multica                                                                                | 产品差异                                                       |
| ------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 执行工具覆盖 | Expert 当前四端，保留各自协议行为                          | 官方对照列出更广泛的工具，包括 Hermes、OpenClaw 等，并区分 MCP、模型和 Skill 支持      | Multica 覆盖广；不能据适配器数量推断每端质量相同               |
| 执行位置管理 | 个人工作台和 Provider 实例；未见同等的成员共享机器管理产品 | Runtime 对应机器和工具；在线状态、拥有者、共享范围、容量等可管理                       | 从“我用哪个工具”扩展到“谁允许用哪台机器做什么”                 |
| 并发与队列   | 任务、Provider 及 Hub 生命周期各有管理                     | 守护进程及 Agent 两层并发上限，排队与目录等待可见                                      | Multica 在 Agent/机器维度的容量表达更完整                      |
| 离线和恢复   | 持久会话、取消、恢复、失败传播；实际支持依 Provider 与场景 | 心跳、领取状态、离线宽限、有限自动重试、手动重试与会话恢复                             | 两边都已有恢复机制；Multica 更围绕远程机器和统一 Run 状态表达  |
| 自动换机器   | 不据多 Provider 或 handoff 推断                            | 离线运行通常等待原 Runtime，不自动迁往别的电脑                                         | 跨机器管理不等于自动容灾调度                                   |
| 工作目录     | 本地与 worktree 环境，可从工作台检查改动                   | 仓库缓存/worktree，本地目录原地运行或 worktree 模式，目录锁和分支续接                  | 都有隔离工作副本；Multica 将其与项目资源及队列绑定更深         |
| 资源回收     | 已确认生命周期规范，部分管理入口和自动回收仍规划           | daemon 提供目录、会话、缓存的分类清理和磁盘用量入口                                    | Multica 更接近可运维的分布式执行产品；自动清理仍有明确保留条件 |
| 云端执行     | 未见 Expert 对等的远端云 Runtime 产品入口                  | 已有 Qoder Cloud Agents 桥接；模型/工具/Skill 在远端配置，首版有聊天/本地目录/附件限制 | 是特定集成，不能表述为任意 Agent 均可无缝云本地切换            |

依据：[Provider 范围][S3]、[运行记录][S10]、[工作环境契约][S15]、[Multica 工具矩阵][M12]、[Runtime][M6]、[Run 状态及重试][M7]、[项目资源][M13]。

**产品层团队协作与 Harness 原生子智能体也要分开。** Multica 默认关闭 Codex 原生子智能体；显式开启后，父线程结束可能使仍在运行的子智能体结果丢失。我们的固定技能链路已有 Codex 原生子任务与 OMP 一层后台子任务、旧任务结束后新装配排队启动的实际证据；Pi 没有核心 subagent 工具，Claude 真实模型仍受认证阻塞。这些差异应按具体 Provider 判断，不能用“支持多智能体”统一概括。[Multica 原生子智能体边界][M6]、[我们的实际验证][S6]。

### 5.2 自动化与持续推进

| 能力           | 当前 Synara                                                                 | Multica                                                                    | 产品差异                                                 |
| -------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------- |
| 定时启动       | 手动、一次性、间隔、每日、工作日、每周、cron 与时区                         | 时间表、多触发器、cron 与时区、立即运行                                    | 定时功能两边都有                                         |
| 每次新建工作   | standalone 每次创建新线程执行                                               | Autopilot 可选择创建任务或仅运行                                           | 我们输出偏新执行线程，Multica 输出可直接成为团队 Issue   |
| 回到已有工作   | heartbeat 继续现有线程；dedicated 复用自动化自己的线程                      | Issue Wakeup 在原任务上重新触发 Run                                        | 不能把“原任务续跑”列为我们的全空白                       |
| 选择执行专家   | 自动化定义没有直接 Expert 选择字段；heartbeat 可沿用目标线程已绑定的 Expert | 直接选择 Agent 或 Squad                                                    | 我们的 Expert 与自动化在产品配置上尚未完全贯通           |
| 项目事件       | 已有 project-event，但普通自动化创建明确拒绝，仅供 Project Coordinator 管理 | 任务回复、字段变化、Run 结束、子任务/阶段结束、PR/CI、其他任务状态等可配置 | 我们有特定事件机制；尚未提供同等通用条件唤醒编辑器       |
| 外部事件       | 当前自动化契约未见同等 Webhook 入口                                         | Webhook 接收事件，支持过滤、投递记录、去重及重放                           | Multica 适合把外部业务变化转成工作                       |
| 等待与跟进     | 线程 heartbeat 和 Coordinator 路径提供部分基础                              | 单次、定期检查、等回复/状态/子任务/PR，带有效期、超时策略和最大次数        | Multica 把“等什么、等多久、满足后做什么”做成明确产品对象 |
| 无变化静默     | 自动化有通知策略及 Memory                                                   | Wakeup 可静默 check-in，记录触发过程而不刷评论                             | 都能减少无效打扰，Multica 与任务条件和时间线关联更直接   |
| 循环与失败治理 | 已有停止条件、审批等待、恢复及运行记录                                      | Wakeup 次数/互相触发/频率保护；自动化持续失败可暂停                        | 需要按具体规则比较，不能只写“都有自动化”                 |

依据：[自动化契约][S16]、[自动化服务][S17]、[Autopilots][M14]、[Issue Wakeups][M15]。Project Coordinator 的既有事件机制不等于 Linx 的 Hermes Space Owner 已接入。

### 5.3 上下文 记忆与能力进化

| 层次             | 当前 Synara                                                     | Multica                                                                   | 判断                                                                 |
| ---------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 显式背景         | Space 方向目标/共享指令，Project 目标/指令，Expert Persona/资料 | Agent Instructions、Project 说明与资源、Issue 描述/评论、Squad briefing   | 两边都能把背景交给运行；我们的多层来源固定与加载记录已有明确语义     |
| 会话连续性       | 原生恢复、fork、handoff、历史整理                               | 同任务/同 Chat 尽量恢复原生会话，恢复不了新建                             | 这是会话恢复，不等于长期记忆                                         |
| 自动化记忆       | 有自动化独立 Memory                                             | 自动化可保存 Runbook 与历史，运行工具也可能有自己的记忆                   | 不把自动化 Memory 推广为所有 Expert 共享长期记忆                     |
| Agent 长期记忆   | 未见通用 Expert 个人长期记忆产品；Hermes Owner 仍规划           | Hermes 有按 Agent 保存的本机状态/记忆；Codex 原生记忆默认关闭，可显式启用 | Multica 有特定 Harness 的记忆策略，不是所有 Agent 通用的知识记忆平台 |
| 工作方法沉淀     | 统一 Skill、CLI、手工编辑与来源更新已有                         | Workspace Skills、CLI、源更新与多人复用已有                               | 都有资产维护基础                                                     |
| 经验自动变成技能 | Skill Evolution 的提案、审核 Diff、发布、回滚与来源追溯仍规划   | 未据当前文档和已核源码确认通用的自动反思、评估与发布闭环                  | 两边都不能直接宣传已完成自动进化                                     |

依据：[Context 实现][S18]、[Skill 当前范围][S5]、[Linx 规划边界][S1]、[Multica Skill][M3]、[Runtime 中的记忆策略][M6]。

## 6 治理 运营与产品触达

| 能力         | 当前 Synara                                                                       | Multica                                                                                                   | 产品差异                                                                                           |
| ------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 多人协作权限 | 个人 owner 与具体管理能力授权；未见同等成员级工作区 RBAC 入口                     | 工作区 owner/admin/member，加 Agent Access、Runtime 私有/公开/指定成员                                    | Multica 更适合团队内共享能力和执行资源                                                             |
| Agent 身份   | 会话/Gateway/Worker 具有各自可信身份与权限边界                                    | Agent 能以自身身份发评论、更新任务，Run 使用绑定 Agent/任务的临时 API token                               | Multica 将执行身份更完整地呈现在业务活动记录中                                                     |
| 人工执行审批 | 有工具批准、用户输入、权限选择及自动化等待态，实际行为依 Provider                 | 默认无人值守，运行工具的审批通常自动应答                                                                  | 我们的人工干预路径有价值；选型取决于是否要求人保持在执行决策中                                     |
| 文件系统隔离 | 固定技能集合与 MCP allowlist 不等于 OS 沙箱；实际边界依 Runtime/Provider/权限设置 | 官方明确不保证文件系统沙箱，默认边界是 daemon 所属 OS 用户；worktree 也不是安全沙箱                       | 不能把任何一方“分目录/固定技能”宣传为全面安全隔离                                                  |
| 使用量统计   | Profile 本机累计活动和 Provider/模型 token；部分会话可显示成本                    | 工作区、项目、Agent、Runtime、Issue/Run 维度的 token、费用估算、耗时、错误分类与趋势                      | 我们有统计基础，缺少同等跨 Agent 的管理归因视图                                                    |
| 故障运营     | 预检、运行记录、日志及专项诊断                                                    | 错误率、失败原因、问题 Agent 排名、时间和项目筛选                                                         | Multica 更方便管理“哪名 Agent 经常失败、为什么失败”                                                |
| 通知与待办   | 已有 Inbox、自动化通知及 Hub 待处理事项                                           | Inbox、订阅、评论通知、任务/自动化动态                                                                    | 我们不是没有 Inbox；Multica 的通知直接围绕多人 Issue 协作组织                                      |
| 外部消息触达 | MCP 可调用外部服务；未见同等完整 IM 消息入站触发产品                              | 飞书、Slack、钉钉、企业微信、Telegram；身份绑定、会话和任务创建；国际 Lark 仅维护已有连接                 | 工具调用能力与外部消息触发能力应分开。部分渠道属社区维护                                           |
| Git 平台联动 | 本机 Git 与 GitHub Issue/PR 工作台操作较深                                        | GitHub PR 自动关联、CI/冲突快照、合并后状态联动；自托管还有 Git 平台接入                                  | 我们偏主动操作和审查，Multica 偏任务与外部交付状态自动关联                                         |
| 产品扩展     | 已有宿主接入与模块边界；未见同等面向用户的动态插件 SDK/安装管理产品               | 已有插件包/版本、Issue panel/modal、Action、事件/定时/Agent hook、Skill 与 MCP 扩展；MCP 工具需管理员批准 | Multica PluginsV1 默认关闭，当前不支持 sidebar_panel；应计作受门禁控制的实现，不能计作默认开放能力 |
| 客户端       | Web 与桌面，当前本机 Workbench 0.1.6 已安装                                       | Web、桌面及可自行构建的 iOS 客户端                                                                        | iOS 尚未上架 App Store，Android 暂未提供；不能当作成熟全端商店发行                                 |
| 部署与数据   | 当前重点是个人本机工作台和独立 home                                               | Cloud 或自托管协调服务器，加本地/远程 daemon                                                              | Multica 的跨设备协作依赖服务器保存任务、评论、配置和运行结果；本地执行不等于数据全部不出机器       |

依据：[统计契约][S19]、[功能门禁][S14]、[Multica 成员角色][M16]、[安全模型][M17]、[统计][M18]、[消息渠道][M19]、[Inbox][M20]、[桌面][M21]、[移动端][M22]。

费用只能作为估算或工具上报值理解。Multica 对未上报 token、未知模型价格等有专门说明；有报表不等于能准确还原实际订阅账单。[费用口径][M18]。

扩展能力依据：[插件 SDK][M23]、[宿主可支持的扩展位置][M24]、[默认功能门禁][M25]、[插件 MCP 批准][M26]。插件工具批准是扩展治理流程，与默认无人值守运行的工具审批行为应分别理解。

## 7 按用户场景看差异

| 用户想完成的事                               | 当前我们的路径                                                | Multica 路径                                          | 直接结论                                                               |
| -------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------- |
| 配一个研究专家，绑定方法和资料，马上处理项目 | 建 Expert → 绑定 Skill/MCP → 预检 → 任务执行                  | 建 Agent → 选 Runtime → 绑定 Skill/MCP → Chat/Issue   | 个人专业任务的基础能力已相当接近                                       |
| 更新一份方法，让多个专家下次都使用           | 更新稳定 Skill → 多 Expert 复用 → 下次 Run 装配               | 更新 Workspace Skill → 已绑定 Agent 后续 Run 使用     | 主要差异已转向团队权限、管理体验和运行覆盖                             |
| 在同一业务任务先开发再审查                   | Hub/接续任务/Reviewer，保留固定成果与版本约束；部分闭环仍待验 | 同 Issue 进入工作流下一状态，交给审查 Agent           | Multica 的任务连续性更自然；我们的候选版本与放行语义值得保留并完成验收 |
| 让协调者安排几个人和几个 Agent 干活          | Hub 和专家团，按工作项/阶段推进                               | 指派 Squad，队长 @成员，依据回复继续协调              | 我们有基础，差在业务任务、人员和评论路由的贯通                         |
| 等供应商回复、子任务结束或 CI 通过后再继续   | heartbeat/Coordinator 提供部分基础；许多条件需额外逻辑        | 在 Issue 上配置 Wakeup 条件                           | Multica 在非连续执行、等待与恢复工作上更产品化                         |
| 手机上查看结果、从聊天工具发起新工作         | 当前已核主要是本机 Web/桌面和 MCP 工具路径                    | IM 渠道；iOS 源码构建可用但有发行限制                 | Multica 触达面更广，不代表所有端成熟度一致                             |
| 把自己的电脑共享给某些同事执行               | 未见同等的成员共享 Runtime 产品                               | Runtime 指定成员/公开共享，再按 Agent Access 限制调用 | 这是多人产品边界扩展，不是给 Expert 编辑器加几个字段即可补齐           |
| 找到最贵、最慢、最常失败的专家               | Profile/会话成本/日志，需人工关联                             | Analytics 按 Agent、Runtime、项目和时间汇总           | Multica 更具智能体运营能力                                             |
| 每次外部写入前由我确认                       | 按 Provider 支持的批准与用户输入路径执行                      | 默认无人值守，平台运行通常自动批准；需外层权限约束    | 这是不同执行模式，不能把自动批准单列为“能力更强”                       |

## 8 完成程度与不能混用的结论

| 容易误判的说法                           | 当前应采用的表述                                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 我们只有提示词加 Skill 路径              | 已有可复用 Expert、统一技能库、运行装配、MCP 授权、任务快照、上下文和执行工作台                                       |
| 技能管理还停留在独立分支                 | 已合入 main；0.1.6 已安装。历史候选的“未合入/未安装”只描述当时时点                                                    |
| 模板固定，所以 Skill 永远不更新          | Expert 任务快照与 Run 技能装配分层；运行/恢复保留旧版，后续新 Run 可读最新版                                          |
| 四个 Provider 都完整端到端通过           | Codex/Pi/OMP 有此次 Skill 实际模型与换版证据；Claude 的真实模型仍有认证阻塞。保留字段不等于其他 Provider 执行同样语义 |
| 有 Skill 隔离就没有文件越权风险          | 目录发现、上下文和调用约束不是任意 Read/Bash 的 OS 沙箱                                                               |
| 我们没有多智能体和自动化                 | 已有 Hub/Worker、专家团、定时、heartbeat、dedicated 以及 Coordinator 专用项目事件                                     |
| Hub 就等于 Linx 后续 Team 完成           | 已有 Hub 应计入；真实成果审核放行、运行中修订及后续 Team 目标仍分别保留完成边界                                       |
| 有 Space 就有 Hermes Owner               | Space/Project Context 已实现；Hermes Space Owner、Personal Assistant 和通用 Skill Evolution 仍规划                    |
| Multica 的 Agent 一直后台运行            | Agent 是持久身份与配置；按工作生成 Run。常驻的是执行连接等基础设施                                                    |
| Multica 支持所有运行时相同能力           | 官方逐工具列明模型、MCP、Skill、恢复差异；云端集成也有独立限制                                                        |
| Multica 能自动吸取经验并发布 Skill       | 已核实 Skill 编辑、CLI 与来源更新；未确认通用自主学习、评审和发布闭环                                                 |
| Multica 有 workflow 就有固定版本质量门禁 | 工作流支持状态和交接；不能据此证明审查对象被固定、审核与发布为同一候选版本                                            |
| Multica 代码里有插件就等于默认可安装     | 有完整插件实现，但 PluginsV1 默认关闭；工作区/部署开放状态需单独核实                                                  |
| 源码有功能就代表全平台已发布             | 两边都要区分源码、运行验证、安装产物、功能开放与正式发行                                                              |

## 9 产品差距如何分组

以下是基于能力对照的产品判断，不改变既有路线或授权实施新功能。

| 分组               | 具体内容                                                                               | 对我们意味着什么                                                 |
| ------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 已接近 应继续打磨  | Expert 基本配置、Skill 资产及批量装配、来源更新、MCP 连接、任务诊断                    | 不必重复建设基础能力，重点检查发现、配置、实际生效和复用是否顺畅 |
| 已有基础 需要串通  | Expert 与自动化、Hub 与团队模板、工作项与业务任务、结果与审查、定时与事件              | 主要是让已有模块共同完成用户流程，而非增加孤立功能页面           |
| 有明确缺口         | 通用事件唤醒、Agent/Run 成本与失败归因、Agent 工作负载/历史中心、外部消息触发          | 与 Multica 差异直接，适合按明确场景进一步讨论                    |
| 需要先确认产品边界 | 多成员工作区、共享 Runtime、跨机器调度、云端协作                                       | 将个人工作台扩展成团队平台，涉及新的数据所有权、权限和运维责任   |
| 应保留的能力       | 人工批准、配置预检、固定快照与实际加载记录、按 Run 固定技能、本机文件/Git/浏览器工作台 | 这是我们的实际价值；功能数量增加时仍应让行为可理解、可追溯       |
| 两边都需谨慎判断   | 通用长期记忆、自主 Skill Evolution、完全自治交付、跨平台可靠性                         | 不用宣传词代替完整产品流程和真实运行证据                         |

如果继续围绕个人专业工作台推进，最值得先验证的是三条使用链：**选专家→持续跟进同一件事；产生结果→独立审查→用户接受；改进方法→更新技能→下一次复用。** Multica 最值得借鉴的是任务身份、触发条件和运行记录之间的连续性；是否引入团队工作区和共享机器，应另作产品决定。

## 10 依据索引

Synara 的源码位置用于追溯当前实现，验收文档用于区分运行证据与未验证边界。Multica 文档全部固定在同一提交，避免后续 main 更新改变本次比较依据。

Multica 的产品说明另经关键服务端入口交叉核对：[Agent/Runtime/Run 路由][M27]、[Squad 队长派发][M28]、[成员评论再次触发队长的回归][M29]、[任务唤醒入口][M30]、[工作区 MCP 管理][M31]。这些入口证明存在相应实现，不代替真实部署验收。

[S1]: /Users/wangyuelin/synara-expert/context/PROJECT_CONTEXT.md
[S2]: /Users/wangyuelin/synara-expert/docs/skill-management-review-fixes-2026-10-27.md
[S3]: /Users/wangyuelin/synara-expert/packages/contracts/src/expert.ts
[S4]: /Users/wangyuelin/synara-expert/apps/web/src/components/settings/ExpertsSettingsPanel.tsx
[S5]: /Users/wangyuelin/synara-expert/docs/skill-management-product-discussion-v0.1.md
[S6]: /Users/wangyuelin/synara-expert/docs/skill-management-2026-10-26-acceptance.md
[S7]: /Users/wangyuelin/synara-expert/apps/web/src/components/settings/SkillLibrarySettingsPanel.tsx
[S8]: /Users/wangyuelin/synara-expert/docs/expert-product-technical-design.md
[S9]: /Users/wangyuelin/synara-expert/apps/web/src/components/chat/ExpertComposerPicker.tsx
[S10]: /Users/wangyuelin/synara-expert/apps/web/src/components/chat/ExpertTaskControl.tsx
[S11]: /Users/wangyuelin/synara-expert/docs/hub-review-2026-10-22/T2收尾与T3实施记录-2026-10-23.md
[S12]: /Users/wangyuelin/synara-expert/apps/web/src/features/hubCollaboration/HubTeamsSettingsPanel.tsx
[S13]: /Users/wangyuelin/synara-expert/apps/web/src/components/GitActionsControl.tsx
[S14]: /Users/wangyuelin/synara-expert/packages/shared/src/betaFeatures.ts
[S15]: /Users/wangyuelin/synara-expert/packages/contracts/src/orchestration.ts
[S16]: /Users/wangyuelin/synara-expert/packages/contracts/src/automation.ts
[S17]: /Users/wangyuelin/synara-expert/apps/server/src/automation/Layers/AutomationService.ts
[S18]: /Users/wangyuelin/synara-expert/docs/space-project-context-v1-implementation.md
[S19]: /Users/wangyuelin/synara-expert/packages/contracts/src/stats.ts
[S20]: /Users/wangyuelin/synara-expert/apps/web/src/composerSlashCommands.ts
[M0]: https://github.com/multica-ai/multica/tree/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663
[M1]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/apps/docs/content/docs/agents.zh.mdx
[M2]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/apps/docs/content/docs/agents-create.zh.mdx
[M3]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/apps/docs/content/docs/skills.zh.mdx
[M4]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/apps/docs/content/docs/chat.zh.mdx
[M5]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/apps/docs/content/docs/mentioning-agents.zh.mdx
[M6]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/apps/docs/content/docs/daemon-runtimes.zh.mdx
[M7]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/apps/docs/content/docs/tasks.zh.mdx
[M8]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/apps/docs/content/docs/issues.zh.mdx
[M9]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/apps/docs/content/docs/squads.zh.mdx
[M10]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/apps/docs/content/docs/workflows.zh.mdx
[M11]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/apps/docs/content/docs/github-integration.zh.mdx
[M12]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/apps/docs/content/docs/providers.zh.mdx
[M13]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/apps/docs/content/docs/project-resources.zh.mdx
[M14]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/apps/docs/content/docs/autopilots.zh.mdx
[M15]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/apps/docs/content/docs/issue-wakeups.zh.mdx
[M16]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/apps/docs/content/docs/members-roles.zh.mdx
[M17]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/apps/docs/content/docs/security-model.zh.mdx
[M18]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/apps/docs/content/docs/analytics.zh.mdx
[M19]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/apps/docs/content/docs/channels.zh.mdx
[M20]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/apps/docs/content/docs/inbox.zh.mdx
[M21]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/apps/docs/content/docs/desktop-app.zh.mdx
[M22]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/apps/docs/content/docs/mobile-app.zh.mdx
[M23]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/packages/plugin-sdk/README.md
[M24]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/server/pkg/plugincontract/capabilities.go#L25-L57
[M25]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/server/internal/featureflags/keys.go#L15-L45
[M26]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/server/internal/handler/plugin_mcp.go#L13-L94
[M27]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/server/cmd/server/router.go#L2277-L2382
[M28]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/server/internal/handler/squad.go#L1189-L1235
[M29]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/server/internal/handler/squad_worker_comment_wakes_leader_test.go
[M30]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/server/cmd/server/router.go#L2058-L2069
[M31]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/server/internal/handler/workspace_mcp_api.go#L87-L132
[M32]: https://github.com/multica-ai/multica/blob/8ffcc88dbdf13d8b1c7f6c9779920d0bb04ea663/apps/docs/content/docs/quick-actions.zh.mdx
