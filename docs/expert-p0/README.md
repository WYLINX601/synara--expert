# Synara Expert P0 技术验证记录

日期：2026-09-25。基线：本仓库当前代码与 Codex CLI 0.156.1、锁定的 Pi SDK 0.85.1。验证脚本在 [`scripts/expert-p0/`](../../scripts/expert-p0/)；Gateway 授权入口已修改，依赖声明未变。

| 验证项                                    | 结果                                 | 证据边界                                                                                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex 两个并行 Expert 的 Persona 与 Skill | **通过真实模型回合**                 | 两个独立 app-server 会话各自输出对应标记；其中一轮同时带 Synara 风格的 `collaborationMode` 指令。[详情](./codex-evidence.md)                                                                                                                  |
| Codex 恢复与取消                          | **真实模型恢复、活跃回合取消通过**   | 当前 `gpt-6-sol/medium` 下重启恢复同一 thread 后，回复包含 Persona 与 Skill 标记；等到 `turn/started` 后中断，终态为 `interrupted`。尚未证明运行中工具或下游 MCP 清理。[详情](./codex-lifecycle-live-evidence.md)                             |
| Pi 会话级资源隔离                         | **SDK 层通过**                       | 两个并行会话的 Persona、所选 Skill、customTool 未互相串用；仍能看到环境继承的 Skill。[详情](./pi-evidence.md)                                                                                                                                 |
| Pi 真实模型执行                           | **通过真实模型回合**                 | 当前 `openai-codex / gpt-5.6-sol` 输出了 Persona 与 Skill 标记，调用了自定义工具并引用结果；原“缺少认证”是探针跳过初始化造成的误判。[详情](./pi-evidence.md)                                                                                  |
| Pi 恢复与取消                             | **真实模型实测通过，终止标签有限制** | 重建 SDK runtime 与会话服务后，同一持久化会话再次输出 Persona、Skill、工具标记；取消时工具收到并处理 AbortSignal，prompt 结束且会话空闲。未观察到 assistant 的精确 `aborted` 标签。[详情](./pi-lifecycle-evidence.md)                         |
| 第三方 MCP 协议连接                       | **产品连接层与独立 fixture 均通过**  | SDK 的 stdio 和 Streamable HTTP 完成 list/call、结果类型、取消与清理；产品设置只保存环境变量引用，不保存凭据值。[详情](./gateway-evidence.md)                                                                                                 |
| Gateway Expert 工具授权                   | **持久化快照与会话授权通过**         | Gateway 按已验证 session 查询线程固定的 Expert snapshot，只暴露 snapshot 工具允许列表；静态 Gateway 工具不受动态连接失败影响。[详情](./gateway-auth-evidence.md)                                                                              |
| 两端经 Gateway 调用第三方 MCP             | **本地夹具真实模型回合通过**         | Codex、Pi 均经生产 `/mcp` 路由调用本地 MCP；A/B、取消到下游、退出清理通过。2026-09-27 又以产品 UI 保存连接并绑定持久化 Expert，Codex 首回合与恢复回合分别得到 `echo:synara-expert-e2e`、`echo:recovery-ok`。 [详情](./full-chain-evidence.md) |

架构决定保持不变：Expert 以不可变快照绑定 Task；Codex 在会话参数与独立进程的 Skill 根目录加载，Pi 在会话资源加载器注入；第三方工具经现有 Gateway 统一暴露，并在已验证的会话身份下同时限制 `tools/list` 和 `tools/call`。Provider 自带的环境 Skill 仍可能出现，产品界面必须区分“专家提供”和“环境继承”，不能宣称专家清单是严格沙箱。

**P0 技术可行性验证已通过，P1 主体与专家 MCP 产品链路也已接入。** 两端真实模型均穿过 Gateway 调用了本地 MCP；按可信会话的 A/B 授权、下游取消信号和退出清理得到实测。产品化复测使用独立 `SYNARA_HOME` 和独立端口，验证了设置页保存与测试连接、专家工具允许列表、固定快照、首回合调用、后续回合重连，以及凭据撤销后下游子进程退出。任务页现在可查看固定快照、任务配置模型、最近一次成功启动的实际 Provider/模型、Codex CLI 或 Pi SDK 版本、lifecycle generation、资源目录和连接要求，并由用户显式重测连接。该运行记录在恢复时覆盖、停止后保留，任务硬删除时清理。发布故障项、现有证据和待平台实测项见[发布故障矩阵](./release-fault-matrix.md)。

当前机器的 Node 22.23.1、Bun 1.4.0 低于仓库声明的 Node 24.13.1、Bun 1.4.2。相关服务端定向测试已通过；完整依赖安装曾因 `react-dom@19.2.4` 完整性校验失败而未干净完成。上述运行结果仅代表当前本机环境与版本。
