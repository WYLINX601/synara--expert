# Expert Skill 主动进化研发方案

日期：2026-10-28；执行更新：2026-10-30。状态：两阶段专家经验提炼已实施于隔离预览，实际文件、Provider 支持和检查以[优化验收](./skill-management-optimization-acceptance-2026-10-29.md)为准。当前候选基线 `f879925a4`；原设计基线 `9846774838274c45989a9dea3dcf1dc70de3af2b` 与[首轮实现验收](./expert-skill-evolution-acceptance-2026-10-29.md)保留为历史，不当作当前源码验收。

关联：[产品方案](./expert-skill-evolution-product-plan-2026-10-28.md)、[实施计划](./expert-skill-evolution-implementation-plan-2026-10-28.md)。主动暂指用户手动发起；自动触发和自动采用均不接入。

## 1. 模块边界与既有事实

模块 ID 为 expert.skill-evolution。模块拥有提炼请求、来源快照、候选、采用记录、派生与版本事件；宿主继续拥有 Thread、Provider 会话、模型配置、事件消费、取消、投影和数据库连接；技能库继续拥有正式 Skill、不可变包及绑定操作。

| 现有能力                                           | 证据                                                                                                                                                                      | 实际边界                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Skill 新建／保存、expectedRevision、持久 requestId | [SkillLibraryStore](../apps/server/src/experts/SkillLibraryStore.ts)、[SkillLibraryOperations](../apps/server/src/experts/SkillLibraryOperations.ts)                      | 没有经验提炼接口；不提供 Skill 与 Expert 的共同原子事务   |
| 不可变包与发布校验                                 | [SkillPackageStore](../apps/server/src/experts/SkillPackageStore.ts)                                                                                                      | 包补偿清理不等于多对象回滚；没有现成的 Skill 历史恢复命令 |
| Expert 保存和历史修订                              | [ExpertStore](../apps/server/src/experts/ExpertStore.ts)                                                                                                                  | 与 Skill 注册表是不同文件，不能宣称同时提交               |
| 下一 Run 解析最新绑定与包                          | [RunSkillAssemblyStore](../apps/server/src/experts/RunSkillAssemblyStore.ts)、[ProviderCommandReactor](../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts) | 当前 rootRunId、恢复及继承续接保持原装配                  |
| 会话启动、发送、事件、取消                         | [ProviderService](../apps/server/src/provider/Services/ProviderService.ts)                                                                                                | 完整原生生命周期；没有现成的提炼专用单次模型调用          |
| Expert 历史与消息投影                              | [expertTaskSource](../apps/web/src/workbench/host/expertTaskSource.ts)、[ProjectionThreadMessages](../apps/server/src/persistence/Services/ProjectionThreadMessages.ts)   | 前端只读列表不是服务端授权依据；没有统一的验收反馈对象    |

不新增第二套 Agent 执行器、队列或事件总线。不直连模型厂商 API，不选择新模型，不依赖 Hermes 安装或进程。

## 2. 前后端划分与真实布局

- 入口复用现有 /experts/$expertId，扩展本地 tab 为 evolution；更新查询参数校验和旧地址归一化，不另建顶级学习页面。
- 真实父布局仍是 \_chat。保留继承的导航、全局订阅、任务协调、快捷键和最小尺寸约束；新增页签不意味着脱离 Chat 生命周期。
- ExpertCenterPage 负责宿主装配；ExpertsSettingsPanel 继续拥有专家编辑草稿；通过 renderEvolution 类窄槽位接入模块，不在编辑器内编排 Provider。
- 前端业务放在拟新增 apps/web/src/workbench/features/expert-evolution；host 只提供认证 RPC、原生任务和来源投影的窄能力。
- 服务端业务放在拟新增 apps/server/src/experts/evolution；通过 workbench/host/expertRpc 等现有宿主装配进入类型化 RPC，认证和 owner 判断仍在宿主。
- 跨进程数据放在拟新增 packages/contracts/src/skillEvolution.ts；不在 contracts 编排运行。现有 skillLibrary 契约只增加需要的字段及受控动作。
- 实施时登记 integration-points.json，覆盖路由、RPC、原生任务、Skill 写入和装配资格；边界检查只能证明声明范围内静态导入规则。

## 3. 数据与兼容

### 3.1 Skill 元数据

ExpertSkillBinding 使用可选 allowEvolution:boolean，缺省为 false；当前 authoring 和存储投影共用此字段。SkillDefinition 保留只读 scope（shared 或 expert + expertId）和 derivedFrom（skillId、revision、packageId）。删除全局 evolutionPolicy 和 configureEvolution；技能不再记录添加者，认证及操作身份继续保留。

缺少改进权限的绑定按仅使用解释，原始文件声明不能授予权限。公开 create 不接受 scope 或策略；普通创建为共享原版，受信任服务端上下文 createForExpertId 仅用于新生成的专属技能，并参与持久操作指纹。开启权限不立即复制，也不隐含自动采用。

专用 Skill 的列表、读取、候选目标、绑定与导出都校验应用层归属；Run 装配资格检查复用同一归属校验。普通无 Expert 任务的发现规则保持原样。此范围控制不是操作系统文件权限承诺。

derivedFrom 固定首次派生的准确版本，不随上游更新漂移；后续修改同一专用 Skill 只新增版本事件。上游更新不自动合并。现有专属副本在原版重新绑定后可复用；系统记录绑定锚点和实际改进基础，保持版本及权限检查。

### 3.2 模块持久数据

使用宿主 SqlClient 与现有 Expert 扩展迁移 ledger，新增 additive 迁移；编号实施时按实际迁移链分配，不改已运行迁移。

| 数据              | 必要字段                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| EvolutionRequest  | requestId、请求指纹、subjectExpertId、来源快照摘要、原生提炼 thread/turn 关联、状态、Provider/model 固定值、创建与结束时间、错误 |
| SourceSnapshot    | threadId、消息 ID 和截止因果序号、真实 Expert/snapshot 身份、可确认的 rootRunId/assemblyId、Skill 包引用、选择的文本及摘要       |
| EvolutionProposal | proposalId、requestId、action、目标 Skill、基础 revision/package、拟变更文件及内容摘要、证据范围、理由、采用状态                 |
| ApplyIntent       | operationId、proposalDigest、owner 授权、预分配结果身份、Skill 和绑定预期版本、阶段、已有写入回执                                |
| EvolutionEvent    | eventId、actorExpertId、Skill、前后修订和包、派生来源、source request、apply operation、事件种类与时间                           |

SourceSnapshot 固定用户选择的必要材料，不保存完整历史副本、系统提示或凭据。原始内容不进入诊断上报；删除及保留策略沿用本地私有业务资料处理。来源不可读或版本未知需显式标记，不凭更新时间推断使用证据。

模块事务可保证自己的记录一致性，不能跨 SQLite 与现有文件注册表宣称原子性。

## 4. 来源构建与模型执行

### 4.1 来源构建

服务端重新校验来源身份及访问范围，按明确消息边界截取已结束片段。前端传消息 ID／截止序号，不传一份可伪造的“成功总结”作为唯一证据。重复或重叠片段合并，提炼专用任务排除在可选学习来源之外。

一次最多 5 个片段；输入预算按实际模型与现有输入限制计算，超限返回可读错误要求缩小范围，不静默丢弃约束。用户纠正、产物和工具结果保留角色及来源；只有确有验收记录时才标为已验收。

### 4.2 执行方案

新增 EvolutionExecutionPort，内部通过宿主原生任务准入和 Provider 链路创建一次可见、可取消的“Skill 提炼”任务；模块记录原生 threadId/turnId，用户可以打开。禁止直接旁路调用 ProviderService 或自建线程池消费同一 Provider 事件。

此任务的业务主体通过 EvolutionRequest 关联 Expert，不能伪造成一段新的原专家业务执行。发现阶段只提供冻结的选定来源和绑定技能目录，生成阶段才提供目标 Skill 基础内容及经验候选与反馈；两阶段都不自动继承原专家的完整历史、MCP、外部工具、Memory 或环境 Skill 扫描。

Provider/model 使用用户现有选择并固定到请求，不在重试时静默切换。无已配置、可用且满足限制的 Provider 时，显示不可用原因；不创建默认管理 Agent。

首期执行约束为只读／无业务写入工具；不允许模型访问正式 Skill 写接口或执行生成的脚本。contracts 中存在 read-only 不证明所有 Provider 已兑现。阶段 A 必须逐项核实 adapter 真实执行能力；只对证明约束生效的 Provider 开放提炼，不能用提示词代替运行时限制，也不能降级为 full-access。

若现有原生生命周期无法表达上述执行限制，只扩展宿主的显式 purpose／能力准入与 adapter 映射，仍复用原队列、事件和取消链路。此验证是阶段 A 的退出条件，不把尚未证明的四端支持计入完成。

### 4.3 两阶段请求与模型输出

start 是发现阶段，只接受专家、明确来源、可选重点和既有模型选择；不接受目标 Skill。发现输入包含冻结消息和绑定技能目录，输出为 SkillEvolutionDiscoveryResult：no_change、insufficient_evidence 或 opportunities。每条经验机会固定 name、reason、outcomes、evidence 和可选目录内 targetSkillId，服务生成身份和摘要；模型不能输出文件、归属、权限或写入动作。

generate 接受新 requestId、discoveryRequestId、opportunityId、expectedDigest 和可选 feedback。重新核验同一 owner／expert 与候选摘要，沿用父请求的模型和冻结消息；到此时才检查绑定权限、读取目标文件和固定当前基础包。每次生成分配独立原生任务与 generationIndex；不创建第二套执行服务。

父记录只在忽略经验时改变机会状态。子记录通过 discoveryRequestId／opportunityId 关联；按 generationIndex 查找最新轮次，不依赖跨两条 JSON 记录的原子更新。相同请求只恢复原任务；已生成的新轮次使旧轮次不可采用；任何未决采用意图阻止覆盖生成。失败或取消后可显式用新 ID 重试，完成草稿后的重生需具体反馈。

历史文件生成记录没有 stage 时仍只读／恢复其原语义，不批量改写为经验发现；旧配置转换不恢复。新请求均明确 stage，sourceSelections 是公开的来源选择身份，完整消息保持私有业务材料。发现与生成任务均通过同一持久执行身份查询和受限 purpose 链路。

### 4.4 草稿输出与校验

输出契约为 no_change、insufficient_evidence 或 proposals。候选 action 为 create、update 或 derive；最多 3 条，每条绑定准确目标基础版、文件列表、理由及 SourceSnapshot 内的证据范围。模型不能输出或决定权限、身份、审批和共享范围。

复用 Hermes 的先查重、先完善已有方法、支持文件按主题组织、禁止会话流水账等规则；移除“多数会话必须有更新”的倾向。项目事实、用户个人资料、未证实修复和已有方法重复返回无需提炼或证据不足。

校验覆盖结构、路径、体积、支持文件引用、证据归属、内容变化、归属／绑定权限、目标版本。模型判断不代替身份和权限校验。规范检查通过也不等于真实效果改善。

无效输出允许在同一固定输入和预算内修正一次；仍无效记失败，不落正式数据。取消、超时、权限待办和断连沿用宿主真实状态，不能当成无新增经验。

## 5. API 与状态

类型化请求复用既有入口，增加 generate 与 dismissOpportunity；start 表示经验发现，read／list 返回父子阶段、机会和草稿。edit／apply／reject 继续处理具体文件草稿，graph 与两类 restore 继续处理已采用历史。绑定权限复用现有技能库 bindings 和专家保存命令，继续 owner 认证和 revision 校验；移除公开 configureEvolution、protectedAction 与 approveProtected。

所有变更命令带 requestId 与请求指纹；同 ID 同载荷返回已有结果，异载荷报冲突。请求和原生命令的关联通过持久 dispatch intent／outbox 确立；崩溃恢复查询已接受原生命令，不盲目重发模型任务。

请求状态：queued、running、waiting_authorization、opportunity_ready、proposal_ready、no_change、insufficient_evidence、failed、cancel_requested、cancelled。opportunity_ready 只表示发现完成，不意味着有技能草稿或正式保存。原生状态由宿主投影，模块只记录业务结果；cancelled 需要停止证据，关闭页面不是取消。

候选状态：proposed、applying、saved_unbound、applied、rejected、conflict、failed。用户编辑产生新摘要，旧授权不能批准编辑后的不同内容。专属目标和文件差异均固定到此次摘要。

## 6. 采用、并发与部分完成

### 6.1 共同行为

applyProposal 仅接收可信 owner 上下文；不能信任客户端或模型传入的 actor=user。再次读取目标、绑定权限和版本，验证 proposalDigest、expectedRevision、范围和实际差异；无变化结束，不增加修订。

保存 ApplyIntent 后，调用现有 SkillLibrary 持久幂等命令。阶段标识和子请求 ID 固定；禁止在重试时换目标或重复生成新身份。正式脚本文件可保存为候选内容，但采用不自动执行脚本。

### 6.2 已有专属更新

按 Skill revision CAS 发布新包及定义，记录新旧包与贡献事件。并发改动返回 conflict，保留候选供重新提炼；本期不做未经再次预览的自动合并。仅更新本专家的专属 Skill，不更改共享原版或历史包。

Skill 写入成功但事件提交中断时，依固定操作回执恢复完成记录，不再次保存内容。UI 不用分析成功或 RPC 已受理代替已采用。

### 6.3 首次独立派生

1. 校验当前专家绑定权限与原 Skill 准确版本；查询当前专家已有的有效专用副本，防止重复派生。
2. 持久记录预分配结果 Skill ID、完整有效内容和绑定意图；创建 scope=expert 的副本，复制完整包及全部支持资源。
3. 通过现有 bindings 操作按 Expert expectedRevision 替换原绑定，保持 enabled、allowEvolution、selectionScope 和 resourceMode；不改其他绑定。
4. 完成后记录 applied 与派生事件；禁止同时把原版和副本作为替代方法重复加载。

两份文件不存在共同事务。步骤 2 后失败进入 saved_unbound：副本可在当前专家范围查看，但尚不参与装配，星图不显示为已采用。步骤 3 重试只恢复绑定；若 Expert 已被其他操作修改，显示冲突并保留副本，不覆盖新绑定、不重复创建、不假装全部回滚。

完整派生复用 SkillLibrary 的 derive 操作：内部预留身份、复制完整包、写入 plannedSkill 和归属／谱系，统一纳入原操作日志。公开 create 仅创建共享原版；新方法采用时通过可信内部上下文创建专属技能。外部调用方不能伪造结果 Skill ID 或归属，也不通过先公开不完整 Skill 再补文件模拟派生。

删除失败副本必须经过引用检查；不得为了清理移除其他任务引用。模块采用的历史包和待采用基础包需要加入现有包引用保留机制，防止清理后失去差异或恢复依据。

## 7. 恢复与运行生效

新增 previewRestore/restore，复用正式保存路径把旧内容作为新修订写入，保留事件；不是把 revision 倒退或覆盖不可变包。内容恢复只允许当前已授权绑定的本专家专属版本；共享原版通过技能库手动维护。

首次派生的撤销若包含绑定还原，作为新的显式 Adopt/RestoreIntent 执行，核对当前绑定后逐步恢复，保留部分完成状态。已被引用的派生 Skill 不自动删除。

RunSkillAssemblyStore 继续唯一决定实际运行装配：当前 rootRunId、审批等待、恢复及自动续接固定旧内容；下一次独立执行意图解析当前已保存绑定和头版本。必须测试同一会话的下一独立 Run，而不是仅测新建会话。

## 8. 星图数据与前端复用

readEvolutionGraph 组合当前专家的来源基线、已采用事件和谱系，不扫描整个文件系统。事件记录贡献者与影响专家，防止把别的专家共享贡献误标为当前专家学习。

一个 Skill 一个稳定节点；可选时间参数按事件序列计算当时已记录状态与版本。旧基线无时间则保持 unknown，不回填伪事件。只有真实派生才画 directed derivedFrom；关联与派生是不同边。

首期没有可信原生调用计数时节点固定尺寸，展示已绑定／已装配而非已执行。无需提炼、拒绝和失败在记录中可查，但不生成能力节点。

参考 Hermes Desktop 的 Canvas、D3 力布局和时间轴实现；移植时只复用绘图／交互，不带入其 Nanostores、路由、Python API 或 Memory。核对引入的源码许可标识，保留适用 MIT 声明。

复用现有 Dialog、Button、CodeEditorPane／SkillMarkdownPreview、资源树、草稿保护及 disclosureMotion；差异视图先检查现有 diff 能力再扩展，不复制第二套技能编辑器。使用 text-ui 字体，遵守 has 选择器、菜单、减少动画与父布局规则；320/390/1280 宽度检查。

## 9. 检查与事实边界

- 单元与持久化：发现无正式文件写入、父子任务登记、反馈重生／旧草稿拒绝、忽略、取消后明确重试、默认关闭、撤销与重放、范围／身份、摘要授权、CAS、重复提交、重启恢复、部分完成、历史包保留、恢复旧内容，以及 no_change 不写正式 Skill／修订／绑定但保留审计结果。
- 模型执行：候选结构、真实源材料、权限约束、原生等待／取消／超时、重复准入和事件归属；mock 不能替代真实 Provider。
- 前端：入口共用、选择与草稿、完整差异、部分完成、冲突、路由前进后退、字体、键盘、减少动画及真实 \_chat flex 父布局。
- 集成：当前 Run／恢复／自动续接装配不变，下一独立 Run 使用新版本；同一共享来源验证两个专家的权限独立及原版不变。
- 最终集中执行 fmt:check、lint、typecheck、受影响 Vitest、全库测试、workbench 边界和 migrations:check。只有实际修改平台／进程边界才加 windows-runtime:check；实机结果单独记录。
- 真实模型先选用户已配置且满足约束的 Provider；认证失败记为阻塞，不升级权限或切换模型。所有拟支持 Provider 必须逐项标为通过／受阻／未验证。
- 安装、推送、合入和发布不属于本次制定方案的执行范围，后续按授权和冻结候选交付。
