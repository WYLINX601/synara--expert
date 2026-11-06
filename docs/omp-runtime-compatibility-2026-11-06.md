# OMP Expert 兼容修复（2026-11-06）

范围：修复已安装 OMP 18.16.0 因工作台只认可 18.12.1 而无法启动 Expert 的源码问题；不修改日用应用、账户、模型、全局 OMP 配置或原三条线程的状态。现有 Obsidian 改动保留。本记录不代表安装或用户线程已恢复。

## 实现

- Expert 准入从版本白名单改为有效配置与固定 Skill 装配验证。仍严格核对原生 AutoLearn、任务递归、Advisor、来源开关、Skill 清单、路径和文件完整性。
- 18.12.1 保留旧 bundle 哈希和锚点适配。其他可识别的正式版本通过官方 `--trusted-extension` 加载会话专属扩展；扩展加载失败、接口缺失或必要断言失败均拒绝启动。未逐个验证所有未来版本。
- 扩展传递原生后台任务状态及权限工具名。后台任务按原始工具调用归属回原始轮次；跨输出通道乱序时等待原生事件建立归属，不能归属则明确失败。权限元数据缺失时走原审批路径，不凭标题推断自动放行。
- 学习提炼禁用工具、Skills、规则、项目上下文和 LSP，核验固定系统提示；模型上下文由私有请求文件替换为本次明确提交的文本，拒绝重复请求及意外工具调用。OMP 原生生成的项目块在 `before_agent_start` 替换，并在 `context` 再核验；SDK 随后追加的日期／工作目录在 `before_provider_request` 最终请求阶段移除。最终检查同步执行，避免 OMP 的异步扩展超时回退发送原请求；只接受可验证的 messages、Responses input 或 Gemini contents 文本结构，未知结构明确拒绝。账户和模型选择沿用原配置。
- 检查与启动在同一账户环境解析 OMP 可执行文件；会话扩展、事件消费者及临时资源沿用现有会话生命周期。

## 原生接口依据

使用官方 v18.16.0 的 [CLI 实现](https://github.com/can1357/oh-my-pi/blob/v18.16.0/packages/coding-agent/src/main.ts)、[扩展接口](https://github.com/can1357/oh-my-pi/blob/v18.16.0/packages/coding-agent/src/extensibility/extensions/types.ts)、[扩展加载说明](https://github.com/can1357/oh-my-pi/blob/v18.16.0/packages/coding-agent/docs/extension-loading.md) 与 [ACP 实现](https://github.com/can1357/oh-my-pi/blob/v18.16.0/packages/coding-agent/src/modes/acp/acp-agent.ts)。扩展就绪检查属于实际子进程能力检查，不以 CLI 帮助文本替代。

## 验证记录

本机目标为 `/Users/wangyuelin/.bun/bin/omp`，输出 `omp/18.16.0`，Mach-O arm64 独立可执行文件；SHA-256 为 `d4a10d97488d6054d2b18198bd24f461079952c7e0fb75ba66336ca0df0cb99e`。

真实 CLI 探针 **2/2 通过**：

1. 真实 package store 中选定一个 Skill，另放置环境发现来源的干扰 Skill；通过实际 OMP 配置与清单命令核验只加载选定 Skill 及其精确路径，并启动固定会话扩展。
2. 真实 OMP ACP 学习会话向本机 OpenAI-compatible 合成服务发送请求；服务捕获的系统提示、用户文本与指定值完全一致，工具为空，没有环境资料哨兵或真实账户凭据，正常返回 `end_turn`。

复现：`SYNARA_TEST_REAL_OMP_BINARY=/Users/wangyuelin/.bun/bin/omp mise exec -- bun run --cwd apps/server test -- src/provider/acp/OmpNativeCompat.live.test.ts`。探针使用临时 HOME、OMP 配置、会话目录与本机合成模型端点；合成服务验证协议与请求内容，不构成真实模型质量或真实账户成功证据。常规测试默认跳过需要显式指定 CLI 的这两项。Anthropic、Responses 和 Gemini 请求结构有单元覆盖，未声称其真实服务端验证通过。

扩展单元测试 **9 项通过**；适配器固定 Skill／权限测试 **13 项通过**，覆盖新版本就绪信号、权限工具名先到／后到，以及后台任务状态先于 ACP 开始事件、结束状态晚于原轮次完成时仍归属原轮次。模拟事件的覆盖不等于真实模型子任务链路成功。

另用临时脚本执行真实 OMP 固定会话 `task`，由本机合成服务提供主／子请求结果。主轮次返回后保持 ACP 会话及 stderr 消费存活 5 秒，实际捕获并解析 **6 条 task 事件（5 running、1 completed）**，工具调用 ID 为 `call_fixed_task_probe`，子任务输出 `CHILD_ACK`。主会话使用 `rpc`／`main` 扩展上下文，最终更新在 `ctx.isIdle() === true` 时发出。先前探针在主轮次完成后立即释放作用域，导致子任务中止且 stderr 消费已关闭；修正测试生命周期后闭环通过，未因此修改生产桥接逻辑。临时探针和纯合成数据在独立核对后清理，未调用真实服务商模型。

独立审查发现并修复了账户 PATH 检查／启动不一致，以及最终异步请求检查可能超时放行的问题；修复后复审无剩余问题。

冻结后的最终检查均通过：

| 检查                                 | 结果                                                               |
| ------------------------------------ | ------------------------------------------------------------------ |
| `bun run test`                       | 6 包成功，18,651 项通过、42 项按配置跳过，17 分 1.882 秒，退出码 0 |
| `bun run fmt:check`                  | 通过                                                               |
| `bun run lint`                       | 0 errors，1,183 项既有 warnings；同步文件系统预算通过              |
| `bun run typecheck`                  | 7 包通过                                                           |
| `bun run workbench:check-boundaries` | 126 个源文件通过                                                   |
| `bun run windows-runtime:check`      | 静态边界通过；未执行 Windows 原生运行                              |
| `bun run migrations:check`           | 迁移归属与历史 lineage 通过；本修复未新增迁移                      |
| 本机 OMP gated live probes           | 2/2 通过；全库默认跳过的这两项已独立执行                           |

最终全库日志为 `/tmp/synara-omp-full-test-frozen.log`。OMP 的 9 个源码／测试文件在冻结前后 SHA-256 一致，校验清单为 `/tmp/synara-omp-frozen-source.sha256`。先前一次全库运行期间仍在修复最终请求检查，测试读到旧异步模块，并遇到一次 Claude 测试子进程启动超时；两项聚焦复核 17/17 通过，随后冻结代码重跑上述全库。该先前运行不作为最终验收依据。所有测试通过不等于真实账户、真实服务商模型或已安装应用验收。

## 交付边界

未打包、安装、推送或发布；日用 0.1.13 不会因源码修改自动获得修复。未恢复或重发原三条线程的消息。未修改生产数据库或 Obsidian Vault。Windows 静态边界检查与实际 Windows 原生运行是不同证据。
