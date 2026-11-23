---
name: Claude Code 与 Codex 开放方案
type: architecture-spine
purpose: build-substrate
altitude: feature
paradigm: 端口与适配器
scope: Claude Code / Codex 的 Suite 运行与可信原生 Expert 委派
status: final
created: 2026-11-23
updated: 2026-11-23
binds: [Suite 专业运行, Suite 协调者, 同 harness 原生委派]
sources: [四端架构主干 AD-1–5, ProviderService, Claude Agent SDK 0.3.296, Codex app-server 0.170.0]
---

# Claude Code 与 Codex：开放方案

## 设计范式与继承约束

沿用[四端架构主干](./architecture-expert-four-harness.md#不变量与规则) AD-1–5：一个 Expert 库；宿主固定业务 Run、资源与授权，Adapter 负责原生投影。Hub worker 是持续的 `HubWork`，可跨 harness；原生委派只在同一 harness 父子会话内发生，两者不互为后备。用户确认 Claude/Codex Suite 改走 Linx 托管装配与版本验收，不再把上游逐会话指令摘要作为前置依赖。本文冻结设计，不代表实现、开放或发布；不授权改 UI、模型或账户。

## 不变量与规则

### AD-1 — 独立验证三项能力，再分别开放

- **Binds:** Suite 专业运行（直属 Expert／worker）、Suite 协调者、可信原生委派。
- **Prevents:** 因已有独立 Expert、普通子代理或一次探针成功，连带开放整个 Provider。
- **Rule:** 沿用 `supportsSuiteRuntime(provider, role)` 的两个执行用途；原生委派能力独立。服务端支持记录按用途绑定实际 CLI（Claude 还含 SDK）、平台、合格认证／路由类型与启动／续跑策略版本；版本范围和账户特性不能外推。保存 Hub Suite 锁或受理新 work 前先用 Provider 现有发现和可用性路径核对选定实例的资格；启动、恢复再核对实际执行进程，二者不匹配时拒绝。队列等待期间失去资格只失败原 work，不创建替代、不解锁 Suite、不换 Provider。Pi／OMP 已有准入及普通 Expert 不变。先分别开放合格版本的 `expert`（直属 Expert／worker），协调者和原生委派不随之开放。

### AD-2 — 分开证明版本行为、当次装配与权限 [ADOPTED]

- **Binds:** `RunSkillAssemblyStore`、`renderSuiteRuntimeInstructions`、Provider Adapter、`ProviderService.verifySuiteReceipt`、Gateway。
- **Prevents:** 将版本验收、启动参数回显或固定文件校验说成运行器逐会话证明；用指令代替工具授权。
- **Rule:** `RunSkillAssemblyStore` 持有唯一固定装配。Adapter 从同一 `SuiteRuntimeContext` 渲染固定 Suite 段、资源、原生 Skill 目录和连接绑定；专业用途叠加原 Expert persona，协调者不伪造 persona、不继承成员连接。用真实 harness 与隔离合成端点确认该版本和启动策略在首轮、恢复、压缩后构造预期的指令层，且不会保留相冲突的旧段；版本验收不是每个生产会话都读回了提示，也不保证模型遵循指令。生产环境不代理、不采集模型请求正文。
- **Rule:** 首次发送前，逐代次核对实际选定运行器与原生会话身份、规范投影及固定内容、实际原生 Skill 精确集合、MCP／工具隔离和当前 Gateway 代次；任何一项失败都不给模型派发用户任务。MCP 只使用真实会话的固定授权，未授权的连接不能从环境或项目配置带入；Shell、文件及网络仍由原生权限、审批和宿主边界控制。语言、输出目录等指令只指导行为，不新增权限；成果归属和发布路径仍由宿主校验。
- **Rule:** 保留 `suiteApplication` 的 Run／配置／资源字段；为本接入增加明确的 `instructionEvidence.kind = host-managed-version-qualified`，同时标明投影版本及对应资格 ID。`ProviderService.verifySuiteReceipt` 继续比较全部既有字段与当前 `lifecycleGeneration`，并对 Claude／Codex 要求证据类型及资格匹配；该证据由完成逐会话检查的 Adapter 产出，而非从请求复制。旧 Pi／OMP 的回执解释不变。若将来支持原生指令回执，单独记录证据类型。跨进程 schema 归 `packages/contracts`，不另建 Run 或结果存储。
- **Rule:** 恢复来源只从现有 `ProviderSessionDirectory` 的服务端记录读取：在核验成功后随 native cursor 原子写入托管续跑标记，绑定原 thread、Provider 实例和认证／存储边界、原生会话 ID、原 Run／装配、投影策略与固定指令段指纹。标记不授予工具，也不是当前代次回执。恢复只接受原记录且必须用原 Run 重投影、核对同一 native ID、取得新代次回执；不读最新模板。替换 cursor、外部导入、缺失／不匹配标记、未知版本或原生会话丢失一律拒绝；不进入 `ProviderService` 通用 stale-session fresh-start 分支。已发生但未确认的工作不自动重放。Stop 先撤 Gateway 授权再由原进程所有者停止；退出不可证实不可开替代进程。既有历史和成果仍可读；未经单独验收的 fork 不继承回执。

### AD-3 — Claude Code：用 Agent SDK 的会话配置和事件，不依赖模型自报

- **Binds:** [ClaudeAdapter](../../apps/server/src/provider/Layers/ClaudeAdapter.ts#L8127)、Claude Agent SDK 的 `query`、`initializationResult`、`SubagentStart`／`task_started`、`stopTask`。
- **Prevents:** `systemPrompt.append` 被旧快照覆盖；`Agent` 类型名漂移或普通子任务冒充指定 Expert。
- **Rule:** Claude 的受管 Suite 专业会话保留 `claude_code` preset，通过 `systemPrompt.append` 装配固定段，设 `snapshot: false`，复用固定插件装配；用 `initializationResult`、命令／插件证据核对实际 CLI 和固定目录，用 `strictMcpConfig` 隔离环境 MCP。续跑仅接受 AD-2 的受管来源，从原 Run 重新渲染，不采用外部会话、分叉会话或旧快照；资格测试必须覆盖提示词快照记录启用的恢复路径，不能以隔离路由未观测到覆盖当成通过。不把 `initializationResult` 或用量统计称为指令回执。协调者另验原生只读工具列表、仅受信 Hub Gateway 可用且无成员连接。
- **Rule:** 原生委派由宿主将允许的 `(expertId, revision, profileDigest)` 映射为该父代次唯一的 `agents` 键，不透传来源 hooks、MCP、permissionMode 或模型配置。复用 `Agent` 参数校验；用实际 `SubagentStart` 的 `agent_type/agent_id`、`task_started` 的类型、tool-use ID 和 task/run ID 证明原生派发。不能唯一关联就不能归为 Expert。目标方法如不能作为子级原生 Skill 单独装配，则经已授权精确路径走文本后备；严禁往父 Skill 目录加全体成员。子级 Gateway 调用必须能追到可信父代次；原生作用域无法核验时不开放相关工具。结束与停止沿 SDK 原生事件和 `stopTask`，不按父回合结束推定子已结束。

### AD-4 — Codex：用原有 app-server；配置与真实线程分别证明

- **Binds:** [CodexAppServerManager](../../apps/server/src/codexAppServerManager.ts)、app-server `thread/start`／`thread/resume`、`skills/list`、`config/read`、原生 `subAgentActivity`。
- **Prevents:** 进程级 Skill 根通过子代理改变父目录；按模型提供的 task 名或独立 fork 标注 Expert 委派。
- **Rule:** Codex 的 Suite 固定段只由 `thread/start`／`thread/resume` 的 `developerInstructions` 提交，不写进 home 或项目配置。沿用固定 Skill 校验、thread 级 Gateway 与受管续跑目录。`turn/start.collaborationMode` 只允许 Adapter 的公共模式指导，不再拼入 `baseDeveloperInstructions` 中的 Suite 段，不接受外部模式指令；每次发送前检查本次模式，普通模式不能沿用上一次计划模式。恢复核对 `thread/resume` 回报的模式与该策略允许的精确值；仅当该版本的测试证明字段缺省必为中性状态时才接受缺省。未知或冲突状态拒绝，不静默降级、不用新 prompt 洗掉旧状态。`config/read` 仅核对能观测的配置，`instructionSources` 仅核对路径。协调者单独验实际工具集合；只读 sandbox 或只关闭 shell 都不能证明网页搜索、子 Agent 等工具已关闭。
- **Rule:** 目标 Expert 使用父运行专有的 `[agents.<key>]` 公共角色配置和只读受管 `config_file`；不写入用户全局配置。通过真实原生 spawn 启动；关联 `subAgentActivity.agentThreadId`、可信父会话和原生报告的已选角色。`agentPath` 或 `task_name` 只可作展示，不能证明加载了哪个角色配置。验证子级 developer 指令实际采用目标 Profile、父配置未被扩大；不可证子级目录时只走既定文本后备，不调用进程级 `skills/extraRoots/set` 放宽父范围。缺少可信角色/装配或子工具来源信号时，使用上游公开扩展或保持该能力关闭，不把 `thread/start`／`thread/fork` 当原生委派。

### AD-5 — 原生委派只交付一次，不新增可重放工作项

- **Binds:** 两端 Adapter、根会话代次、原生子结果、既有活动流。
- **Prevents:** Gateway 继承成为额外授权、假取消、断线后重复派发和重复结果。
- **Rule:** 子执行最多继承当前父会话原生允许的工具，不复制目标连接、凭据或创建子 Gateway principal。父自然结束不撤销仍有效的父会话；显式 Stop、代次更换、全局撤权拒绝新调用。原生结果通过原生路径进入父上下文一次，现有活动可以展示晚结果但不能重启工作。重连只能恢复可归属的原生执行，不能关联就记未知，不重新派发。新委派与旧 OMP 退役仍受母方案 AD-20 一次切换约束；该约束不阻塞两端 Suite 单独开放。

## 已核对的接口与开放条件

- **Claude：** 当前仓库 Agent SDK `0.3.296`，隔离无凭据握手实际 CLI `2.1.296`。返回显示测试角色已注册，未返回生效系统指令或其摘要，未发送模型回合。[SDK 接口](https://code.claude.com/docs/en/agent-sdk/typescript.md)与[原生子 Agent](https://code.claude.com/docs/en/sub-agents)是实现入口，不是本产品验收。
- **Codex：** CLI `0.170.0` 实测 `config/read` 可读回受管 launch 配置，`thread/start` 返回加载的项目指令文件路径，`thread/start`／`thread/read` 未返回内联指令生效摘要。无模型回合的短探针未生成可恢复 rollout，因此本次没有恢复实测结论。[app-server 协议](https://developers.openai.com/codex/app-server/)与[该版本上游原生子角色指令测试](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/app-server/tests/suite/v2/multi_agent_v2_developer_instructions.rs)提供公共接口和测试参照，不证明 Linx 已接入。
- **当前准入：** [服务端](../../apps/server/src/provider/suiteRuntimeSupport.ts#L3)只开放 Pi／OMP。已有隔离探针不等于本方案的托管运行已实现或通过验收。不得预先开放、合成回执或要求模型复述标志替代验证。

## 实施与验收顺序

1. **版本资格。** 对实际 CLI／SDK、平台及生产 Adapter 启动策略运行隔离回环测试，核对最终系统／developer 指令层（不是只找固定段出现）、实际工具、固定 Skill 精确集合和错误阻断。覆盖首轮、Stop 后恢复、压缩后继续、启动与恢复时的不同版本／实例、篡改或缺失资源、会话 ID 互换、失效授权。Claude 加测快照记录启用前后及外部 session 拒绝；Codex 加测普通→计划→普通、进程重启、持久模式冲突和同段不得重复注入。合成端点以实际收到的 0 次生成请求验证应在派发前拒绝的负例。通过的组合才出现在相应支持记录；新版本重验，不用最低版本号放行未测版本。
2. **Suite 专业运行 → 混合 Hub → Hub 协调者。** 每端先通过在同一冻结 Suite 中的直属 Expert 和由 Pi／OMP 派发的 worker：实际目标 Provider、原 Scope 内授权工具成功及未授权工具拒绝、成果归属、Stop 后旧代次撤权、同一 work／Run 和原生 ID 恢复、缺失预期 cursor 不另开、普通 Expert 回归。通过的端可先开放 `expert`；另用一个 Hub 同时派发四端 worker，验证单端失败不会影响或重派其他 work，才宣称混合 Hub 已验收。随后每端作协调者单独验只读工具、无成员身份／连接、跨 Hub 拒绝和模式锁，再开放 `hub-coordinator`。
3. **两端分别验收原生委派。** 单父并行派两个不同目标；要求非授权角色/工具被拒，正常结果只返回一次，父固定清单保持，目标专属连接不出现；覆盖父自然结束、显式 Stop、晚到事件、断线与旧代次。身份、权限或生命周期缺任一证据，保持相应入口关闭。公开子执行证据齐备，再按现有一次切换规则处理旧 OMP。
4. **集成与交付。** 保留现有角色和 Provider 实例选择；按实际变动更新接入清单并执行边界检查，执行定向测试及仓库规定的生命周期门禁；分别记录隔离原生验证、真实 Provider、打包与部署。诊断只记录 Provider/版本、执行用途、代次、失败原因和是否命中校验；不保留提示词、资源正文、凭据或项目名。

## 历史资格验证记录

基线 `d4667fa87efea36bd67509f9fbdf378573abea66`。2026-11-23 在 macOS arm64 使用两端真实运行器、独立临时 home 与工作区、回环合成模型端点。子进程网络仅允许连接夹具端口；没有使用真实凭据、公网模型、生产请求代理或日用会话。只比较指令命中、公开回执字段、工具名和生命周期结果，不保留请求正文。下列未开放结论对应当时的逐会话回执要求，是本方案的输入，不是新版资格测试结果。

### Claude Code — 不开放

- Agent SDK `0.3.296` 实际启动 CLI `2.1.296`。`claude_code` preset + 固定 `append` 在首轮、关闭运行器后恢复同一 native session、`/compact` 成功后继续均进入系统指令；夹具的 `tools: ["Read"]` 在首轮及恢复后均只有 `Read` 到达合成端点。
- 分别以 `snapshot: false` 和 `snapshot: true` 创建历史，再按 `snapshot: false` 恢复。替换 append 后，端点观察到只有替换段，没有旧段；`initializationResult()`、`getContextUsage({ detail: "summary" })` 和 `system/init` 均未返回任一段原文或摘要。这表明当前隔离路径没有观察到旧段覆盖，**不证明**生产账户已启用提示词快照记录时的行为。不能用这三个公开响应在首轮放行前识别替换。

### Codex — 不开放

- app-server `0.170.0` 使用 `developerInstructions`；首轮、退出后恢复同一 native thread、原生 `thread/compact/start` 完成后继续都在 developer 消息中观察到固定段。以当前宿主方式在计划模式指令中保留固定段，合成端点也观察到该段。只读 sandbox 加 `shell_tool = false` 的夹具不暴露 shell，但仍暴露网页搜索及原生子 Agent 工具；不能据此验收协调者工具边界。
- 计划模式负例故意只提交替换指令。实际请求的 developer 消息**同时包含原段和替换段**；退出后恢复该 thread，普通首轮仍包含两段。`thread/resume.collaborationMode` 可读回上次的计划模式指令，但正常恢复响应不回报实际送达的基础段；`thread/start`、不加载历史的 `thread/read` 和 `turn/start` 回执也不提供它。在请求里找到原段，或只验证 `collaborationMode`，都不能证明最终生效的段没有被追加或覆盖。

第 1 步的传输验证已有结果，**放行门禁未通过**。未进入第 2、3 步：无两端 Suite worker／协调者、四端混合 Hub、真实 Gateway 权限、在途 Stop 或新原生委派的验收结论。保持 Pi／OMP 现有准入，无产品代码、配置或界面改动。

### 独立复核：替代接口和准入

- **Claude CLI `2.1.296`：** 在无用户轮次、独立 home 的会话调用 `getContextUsage({ detail: "full" })`。回环夹具收到 12 次 token 计数请求，其中 1 次包含测试用固定段；SDK 只返回用量分类，未返回该段或摘要。无模型生成请求。`full` 既不能作为生效回执，也不是纯本地读取：实际配置会向所选计数端点发送内容。另查 [SDK `0.3.330` 发布包](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.330.tgz) 的公开类型，初始化、`system/init` 和用量明细仍未提供所需证明；未执行该版本。
- **Codex CLI `0.170.0`：** 给进程默认配置和 `thread/start.developerInstructions` 分别传入不同的合成值。`config/read` 返回的是进程默认值，不是线程传入值；启动与 `thread/read` 回执均不返回线程值或指令摘要。无模型轮次。静态检查 [`0.171.0` 协议](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)：启动、恢复和读取回执仍无所需证明；实验性的 [`thread/sample`](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/app-server-protocol/src/protocol/v2/thread_sample.rs) 会生成模型响应，不是派发前的只读核验；未执行该版本。
- **服务端：** 独立 Expert 四端仍可准入；专业 Suite 和协调 Suite 门禁仍只允许 Pi／OMP。工作流测试通过 3 项：首次发送不绑定、已绑定任务不接受不支持的 Provider、协调者不提前锁定 Suite。未验证真实 Suite worker、协调者或原生委派，未修改开放门禁。

### 可选的上游增强（不阻塞托管接入，未对外提交）

- **Claude SDK：** 提供 query 作用域的公开只读证明，返回实际会话 ID 与渲染后的宿主管控 `append` 段摘要。必须在首个模型请求前可取；恢复或压缩后从最终使用的系统提示生成，若旧快照覆盖当前段，必须反映实际结果或标记不可验证。
- **Codex app-server：** 提供 thread 作用域的公开只读证明，返回原生 thread ID、基础 developer 段与当前模式层各自生效的摘要和层级；恢复、压缩、普通与计划模式按最终合并结果计算，而不是回报 `config/read`、最后一次请求或单独的 `collaborationMode`。
- **共同验收：** 摘要绑定实际生效的指令修订。读回后若启动、恢复、压缩或模式切换改变该修订，旧证明不得用于派发；Provider 必须在采样前拒绝过期证明或重新提供可校验的新证明。正例以合成端点独立核对摘要；替换、缺段、旧快照或旧模式负例必须在发出模型请求前拒绝。无需公开或记录完整系统提示、模型输入、工具参数或用户数据。

## 延后事项

不引入生产流量代理、私有协议或自定义分叉二进制；不改变 Pi 原生委派条件或 Stable/Beta 开放策略。原生逐会话指令摘要是可选增强，不改变当前证据类型。若指定版本无法证明托管指令稳定或权限边界，保持该版本、模式或用途关闭，不能为凑齐覆盖降低校验。
