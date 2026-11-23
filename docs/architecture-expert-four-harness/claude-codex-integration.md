---
name: Claude Code 与 Codex 开放方案
type: architecture-spine
purpose: build-substrate
altitude: feature
paradigm: 端口与适配器
scope: Claude Code / Codex 的 Suite 运行与可信原生 Expert 委派
status: draft
created: 2026-11-23
updated: 2026-11-23
binds: [Suite 专业运行, Suite 协调者, 同 harness 原生委派]
sources: [四端架构主干 AD-1–5, ProviderService, Claude Agent SDK 0.3.296, Codex app-server 0.170.0]
---

# Claude Code 与 Codex：开放方案

## 设计范式与继承约束

沿用[四端架构主干](./architecture-expert-four-harness.md#不变量与规则) AD-1–5：一个 Expert 库；宿主固定业务 Run、资源与授权，Adapter 负责原生投影。Hub worker 是持续的 `HubWork`，可跨 harness；原生委派只在同一 harness 父子会话内发生。两者不是互相后备。本增补先冻结接入方向的提案，不授权改门禁、UI、模型、账户、安装或发布。

## 不变量与规则

### AD-1 — 独立验证三项能力，再分别开放

- **Binds:** Suite 专业运行（直属 Expert／worker）、Suite 协调者、可信原生委派。
- **Prevents:** 因已有独立 Expert、普通子代理或一次探针成功，连带开放整个 Provider。
- **Rule:** 沿用 `supportsSuiteRuntime(provider, role)` 的两个执行用途；原生委派能力独立。只登记已通过对应场景验收的 Adapter／运行版本组合；实际实例、版本和所需公开能力必须在新 Hub 的不可逆模式锁和新工作受理前可证明。启动/恢复另行验证当前代次。功能不可用只拒绝对应动作，不回退到普通任务、不切换 Provider、不改旧绑定。Pi/OMP 现有准入保持不变；无新 UI。

### AD-2 — 固定 Run 用现有回执；每个运行代次验证实际生效

- **Binds:** `RunSkillAssemblyStore`、`renderSuiteRuntimeInstructions`、Provider Adapter、`ProviderService.verifySuiteReceipt`、Gateway。
- **Prevents:** 把宿主输入、文件校验、角色注册或原生 Skill 列表的任一项当成完整装配证明。
- **Rule:** 在 Adapter 内从同一 `SuiteRuntimeContext` 生成规范 Suite 段、固定 Skill 目录和连接范围。专业执行叠加原 Expert persona；协调者只用协调用途资源与工具，不伪造 persona，不继承成员连接。释放首个真实用户 turn 前，核验已生效的 Suite 指令段（原生读回原文或其生效摘要）、固定资源/Skill、工具范围及实际 native session ID；用当前 `lifecycleGeneration` 生成既有 `suiteApplication`，不新增宿主账本。原生若提供文件载体的加载证据，只有同时能证明它读取了固定字节、以要求的指令级别生效，且恢复不会覆写时才等价；路径回显不够。发布前用真实 harness 的合成模型传输核对实际请求；发布后不代理、不采集真实模型请求正文。若公开接口不足，最小上游需求是**只读返回本会话实际采用的宿主管控指令段摘要**，覆盖启动与恢复，不要求暴露整份提示词。
- **Rule:** 恢复从原 `rootRunId`、`assemblyId` 和 native cursor 重投影并复验；不读最新模板。Stop 先撤 Gateway 代次，再交原进程所有者停止。回执不符、原生版本失配或退出未证实，不复用该运行、不重发未决工具；历史和成果仍可读。fork 不继承回执；未经独立验收保持拒绝。

### AD-3 — Claude Code：用 Agent SDK 的会话配置和事件，不依赖模型自报

- **Binds:** [ClaudeAdapter](../../apps/server/src/provider/Layers/ClaudeAdapter.ts#L8127)、Claude Agent SDK 的 `query`、`initializationResult`、`SubagentStart`／`task_started`、`stopTask`。
- **Prevents:** `systemPrompt.append` 被旧快照覆盖；`Agent` 类型名漂移或普通子任务冒充指定 Expert。
- **Rule:** Suite 保留 `claude_code` preset，通过 `systemPrompt.append` 装配固定段，复用固定 Skill 插件加载和原生核对。受管 Suite 明确关闭提示词快照重用（`snapshot: false`）并验证恢复和 compact 后仍使用原段；这一选项不是回执。协调者用原生工具列表和 `strictMcpConfig`，只保留必要只读能力与受信 Hub Gateway 工具；权限策略仍受上游和宿主约束。`initializationResult` 用于核对实际 CLI、插件及注册角色，不能代替生效摘要。
- **Rule:** 原生委派由宿主将允许的 `(expertId, revision, profileDigest)` 映射为该父代次唯一的 `agents` 键，不透传来源 hooks、MCP、permissionMode 或模型配置。复用 `Agent` 参数校验；用实际 `SubagentStart` 的 `agent_type/agent_id`、`task_started` 的类型、tool-use ID 和 task/run ID 证明原生派发。不能唯一关联就不能归为 Expert。目标方法如不能作为子级原生 Skill 单独装配，则经已授权精确路径走文本后备；严禁往父 Skill 目录加全体成员。子级 Gateway 调用必须能追到可信父代次；原生作用域无法核验时不开放相关工具。结束与停止沿 SDK 原生事件和 `stopTask`，不按父回合结束推定子已结束。

### AD-4 — Codex：用原有 app-server；配置与真实线程分别证明

- **Binds:** [CodexAppServerManager](../../apps/server/src/codexAppServerManager.ts)、app-server `thread/start`／`thread/resume`、`skills/list`、`config/read`、原生 `subAgentActivity`。
- **Prevents:** 进程级 Skill 根通过子代理改变父目录；按模型提供的 task 名或独立 fork 标注 Expert 委派。
- **Rule:** Suite 用原生 `developerInstructions` 送固定段，延续安全配置、固定 Skill 禁用与重查、Gateway 的 thread 级连接及原生续跑目录。统一启动、恢复、普通 turn、计划模式的指令来源；若 `collaborationMode` 或保存状态能替换 Suite 段，拒绝该模式/恢复，不以重发指令来猜测成功。`config/read` 是配置层证据；`instructionSources` 是已载入文件路径证据，不能证明内联 developer 指令生效。协调者显式关闭 shell 等非必要编排工具并核对实际工具/权限；`read-only` sandbox 不等于没有 shell，公开接口不能证明该角色边界就保持关闭。
- **Rule:** 目标 Expert 使用父运行专有的 `[agents.<key>]` 公共角色配置和只读受管 `config_file`；不写入用户全局配置。通过真实原生 spawn 启动；关联 `subAgentActivity.agentThreadId`、可信父会话和原生报告的已选角色。`agentPath` 或 `task_name` 只可作展示，不能证明加载了哪个角色配置。验证子级 developer 指令实际采用目标 Profile、父配置未被扩大；不可证子级目录时只走既定文本后备，不调用进程级 `skills/extraRoots/set` 放宽父范围。缺少可信角色/装配或子工具来源信号时，使用上游公开扩展或保持该能力关闭，不把 `thread/start`／`thread/fork` 当原生委派。

### AD-5 — 原生委派只交付一次，不新增可重放工作项

- **Binds:** 两端 Adapter、根会话代次、原生子结果、既有活动流。
- **Prevents:** Gateway 继承成为额外授权、假取消、断线后重复派发和重复结果。
- **Rule:** 子执行最多继承当前父会话原生允许的工具，不复制目标连接、凭据或创建子 Gateway principal。父自然结束不撤销仍有效的父会话；显式 Stop、代次更换、全局撤权拒绝新调用。原生结果通过原生路径进入父上下文一次，现有活动可以展示晚结果但不能重启工作。重连只能恢复可归属的原生执行，不能关联就记未知，不重新派发。新委派与旧 OMP 退役仍受母方案 AD-20 一次切换约束；该约束不阻塞两端 Suite 单独开放。

## 已核对的接口与开放条件

- **Claude：** 当前仓库 Agent SDK `0.3.296`，隔离无凭据握手实际 CLI `2.1.296`。返回显示测试角色已注册，未返回生效系统指令或其摘要，未发送模型回合。[SDK 接口](https://code.claude.com/docs/en/agent-sdk/typescript.md)与[原生子 Agent](https://code.claude.com/docs/en/sub-agents)是实现入口，不是本产品验收。
- **Codex：** CLI `0.170.0` 实测 `config/read` 可读回受管 launch 配置，`thread/start` 返回加载的项目指令文件路径，`thread/start`／`thread/read` 未返回内联指令生效摘要。无模型回合的短探针未生成可恢复 rollout，因此本次没有恢复实测结论。[app-server 协议](https://developers.openai.com/codex/app-server/)与[该版本上游原生子角色指令测试](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/app-server/tests/suite/v2/multi_agent_v2_developer_instructions.rs)提供公共接口和测试参照，不证明 Linx 已接入。
- **当前准入：** [服务端](../../apps/server/src/provider/suiteRuntimeSupport.ts#L3)只开放 Pi／OMP。上述两端指令生效路径尚无本方案认可的会话证据，当前不得开放相应 Suite 能力；不能通过合成回执或在提示中放标志再请模型复述来开放。

## 实施与验收顺序

1. **先做无权限副作用的运行器资格验证。** 真实二进制接隔离合成模型端点，观察首轮、Stop 后恢复、压缩后继续的 Suite 段和实际工具；验证删改或替换该段时必须在放行前拒绝。Codex 另测计划模式覆盖；Claude 另测旧提示快照不能接管。无可支持的公开生效证据，则提交最小上游接口需求并保持门禁关闭。
2. **Suite 专业运行 → Hub 协调者。** 同一冻结 Suite 分别跑 Claude/Codex 直属任务和 worker：核对 Skill 精确集合、MCP 正反授权、停止、同 work/Run 恢复及错误回执。随后每端作协调者，分别验证只读工具、无成员身份/连接和跨 Hub 拒绝；用同一个 Hub 混跑四端 worker，确认一端失败不重派其他工作。逐用途开放，不等原生委派。
3. **两端分别验收原生委派。** 单父并行派两个不同目标；要求非授权角色/工具被拒，正常结果只返回一次，父固定清单保持，目标专属连接不出现；覆盖父自然结束、显式 Stop、晚到事件、断线与旧代次。身份、权限或生命周期缺任一证据，保持相应入口关闭。公开子执行证据齐备，再按现有一次切换规则处理旧 OMP。
4. **集成与交付。** 保留现有角色和 Provider 实例选择；按实际变动更新接入清单并执行边界检查，执行定向测试及仓库规定的生命周期门禁；分别记录隔离原生验证、真实 Provider、打包与部署。诊断只记录 Provider/版本、执行用途、代次、失败原因和是否命中校验；不保留提示词、资源正文、凭据或项目名。

## 延后事项

不引入生产流量代理、不接入私有协议、不使用自定义分叉二进制、不改变 Pi 委派条件，也不修改 Stable/Beta 开放策略。若必须在缺少公开生效证据时上线，应作为单独的产品契约变更评审，不能从本方案默认推出。
