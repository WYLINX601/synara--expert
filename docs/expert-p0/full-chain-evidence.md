# Synara Expert P0 完整链路验证

日期：2026-09-25。结论：**P0 技术可行性验证通过（本地夹具范围）**。这不是 Expert 产品功能验收；持久化快照绑定和真实连接管理仍属后续实现。

## 验证范围

本地夹具通过生产 `agentGatewayRouteLayer` 的 `POST /mcp`、`makeAgentGatewayMcpTransport`、会话注册表及请求取消注册表，向下使用 MCP SDK 1.29.0 的 stdio client 连接独立 MCP 子进程。专家授权由测试中的 `Map<sessionKey, exact tool names>` 充当尚未实现的绑定查询；工具标记 `sessionScoped: true`，无授权时默认不可列出或调用。夹具没有修改生产 `AgentGatewayLive`、用户配置或依赖声明。

Codex 客户端复用生产 `buildCodexMcpConfigToml`，把 Gateway URL 写入隔离的 Codex 配置，把临时 bearer 仅放入该进程环境。Pi 客户端复用生产 `listAgentGatewayMcpTools` 和 `callAgentGatewayMcpTool`，把 Gateway 列表投影为会话级 custom tool。两端均使用当前已配置的 Codex 模型和现有认证，真实运行一次模型工具回合。

## 实测结果

| 验证项           | 结果                                                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway A/B 授权 | Codex 与 Pi 各有 A、B 测试会话：A 可列出并调用 `expert_probe_echo`；B 不可列出，按精确名称直调返回 `-32602`，未进入下游处理器。A 在参数中伪造 B 的 `expertId/threadId`，仍只按已验证的 A 会话授权。 |
| 身份与回合失效   | 已完成回合的调用未到达下游；撤销 bearer 后，真实 HTTP 路由返回 401。                                                                                                                                |
| 下游 MCP 数据    | Gateway 转发的 echo 文本、图片块及 `structuredContent` 均与下游结果一致。                                                                                                                           |
| 下游取消         | 阻塞工具启动后，Gateway MCP 客户端取消请求；下游 MCP handler 收到取消信号。夹具退出时下游 stdio 子进程与 Gateway HTTP 服务均已关闭。                                                                |
| Pi 真实模型      | 锁定 Pi SDK 0.85.1、当前 `openai-codex/gpt-5.6-sol`：模型从 Gateway 发现工具并调用，工具返回只在执行阶段注入的随机标记；模型回复引用该标记，Persona 和 Skill 标记也通过。探针退出码 0。             |
| Codex 真实模型   | Codex CLI 0.156.1、当前 `gpt-6-sol/medium`：MCP 启动通知到达 `ready`，模型的 `synara/expert_probe_echo` 工具事件完成，结果和回复均包含测试标记；隔离 app-server 与目录清理完成。探针退出码 0。      |

Gateway 原实例记录下游调用总数 5：自检 3 次、Pi 和 Codex 的真实模型各 1 次；下游子进程和 HTTP 服务均关闭。最终检查发现旧版夹具在打印清理结果后仍保持标准输入开启，导致 Bun 包装进程残留；这些测试进程已清理。修正停止处理后，以真实 PTY 发送 Ctrl-C 再测，夹具退出码 0，`P0_CLEANUP` 显示子进程与 HTTP 服务关闭，进程列表无残留。Codex 的可选 `mcpServerStatus/list` 预检在 2.5 秒内没有响应，但 MCP 启动通知与实际工具调用均成功；不能据此声称该状态接口已验证。

此前的 [Codex 恢复与活跃回合取消](./codex-lifecycle-live-evidence.md)、[Pi 恢复与工具取消](./pi-lifecycle-evidence.md) 已分别通过真实模型实测。本次 Gateway 夹具另行验证了取消可抵达下游 MCP。它们合在一起支持 P0 的技术可行性结论，但**没有**验证真实 Provider 正在执行这个 MCP 工具时，从产品“停止”动作到下游连接清理的一次连续链路。

## 复现与边界

脚本：[Gateway 服务夹具](../../scripts/expert-p0/gateway-live-server.ts)、[Codex 客户端](../../scripts/expert-p0/codex-gateway-live-client.mjs)、[Pi 客户端](../../scripts/expert-p0/pi-gateway-live-client.mjs)。Gateway 脚本启动时输出一次 `P0_READY`（本地 URL 与临时测试 bearer）；将相应 A 令牌分别作为 `P0_GATEWAY_URL`、`P0_GATEWAY_TOKEN` 环境变量传给两个客户端。`MCP_SDK_ROOT` 指向临时安装的 MCP SDK 1.29.0；两个客户端都只接受 loopback HTTP URL。停止 Gateway 后检查 `P0_CLEANUP`，不得把服务仍在运行当作清理通过。

这里的 A/B 绑定是夹具中的会话键与工具名映射，并非持久化 Expert 快照、用户授权或产品连接配置。尚未验证真实 `AgentGatewayLive` 中专家目录的装载、OAuth/远端 MCP、跨机器恢复、打包后的 Windows 行为，以及 Provider 中途停止 MCP 调用时的完整产品清理链。进入 P1 时应把夹具映射替换为按可信会话读取的持久化绑定，并保持同一 list/call 授权判定；连接生命周期与停止链路必须单独验收。

Gateway 夹具直接导入 server 源码，作为 Bun 验证脚本从 `scripts` 的复合 TypeScript 项目排除，避免该项目错误地接管 server 文件；因此仓库 typecheck 通过不代表夹具本身经过静态类型检查。夹具已经实际启动、自检、接受两端真实调用并验证退出，新增脚本的格式与 lint 检查均通过。
