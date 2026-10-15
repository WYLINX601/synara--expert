# 本机 MCP 发现与导入：阶段验收记录

记录日期：2026-10-06。此记录反映当前候选的分阶段验收进度；全仓测试仍在运行，前端仍待用户确认。

## 当前状态

| 项目 | 状态 | 记录 |
| --- | --- | --- |
| 交互原型 | 待用户确认 | [原型页面](prototypes/local-mcp-discovery-v1/index.html) 已由主会话通过本地 HTTP 浏览器验收并保存截图；原型仍使用示例数据。 |
| 正式前端 | 未修改 | `apps/web` 尚未接入发现或导入 UI。 |
| 后端候选 | 验证中 | 候选工作树：`/Users/wangyuelin/.codex/worktrees/expert-frontend-redesign/synara-expert`。focused 测试与全仓静态 gates 已通过；全仓测试仍运行中，最终总数待补。 |
| 实际来源发现 | 通过，只读 | Bun `discover({})` 在空临时 store 下读取到 Codex 5 条、CCSwitch 10 条；两来源均为 `ready`，15 条候选均为 `ready` 且 issues 为空。 |
| 来源文件完整性 | 未变化 | 对 Codex `config.toml` 与 CCSwitch 数据库主文件做扫描前后 SHA-256 比较，均一致。脱敏记录见 `/private/tmp/synara-local-mcp-checks-20261006/source-sha256-check.json`。 |
| 用户服务导入或连接 | 未执行 | 没有调用 `importSelected` 或 `connectExpertMcp`，没有连接用户 MCP 服务；临时 store 与状态目录已清理。 |
| 服务端 focused 测试 | 已通过（主会话记录） | `LocalMcpDiscovery`、`ExpertMcpClient`、`McpConfigSource` 共 3 个文件 / 13 个测试；覆盖 env、cwd、超时、列表、PID 退出及 Codex HTTP 静态引用。RPC 测试 7 个通过。此处不重复累计此前重叠的 focused 套件。 |
| 全仓静态 gates | 已通过（主会话记录） | `fmt:check`、`lint`、`typecheck`、`windows-runtime:check` 均 exit 0。Windows runtime 检查不等于真实 Windows 运行验收；未验证 installer 或 signing。 |
| 全仓测试 | 进行中 | `bun run test --concurrency=1` 当前进度：web 382 个文件、4065 个测试通过、3 个跳过；最终汇总待主会话通知。 |
| 数据库迁移 gate | 不适用 | 本次没有 SQL migration。 |
| import / stdio runtime fixture | 待执行 | 尚未完成真实导入路径与 stdio 生命周期 fixture 验收。 |

## 实际来源条目

本次扫描结果与原型的 5 + 9 示例数量不同。Codex 当前扫描到：`codegraph`、`computer-use`、`node_repl`、`open-design`、`zotero`。CCSwitch 当前扫描到：`zotero`、`open-design`、`computer-use`、`codegraph`、`node_repl`、`ekko-studio-browser`、`ekko-studio-devices`、`ekko-studio-api`、`ekko-studio-interaction`、`ekko-studio-use`。前五个名称与 Codex 重复；来源配置没有写入本记录。

由于扫描使用空临时连接 store，所有条目显示 `ready`；该扫描不判断它们与已有 Synara 连接的冲突情况。脱敏扫描摘要见 `/private/tmp/synara-local-mcp-checks-20261006/discover-summary.json`。

## 后续更新

全仓测试最终汇总及 import / stdio runtime fixture 结果仍待补充。全仓测试完成后再更新后端验收状态；原型仍待用户确认，确认前不接入正式前端。本记录不将 focused checks、静态 gates 或只读扫描表述为整体功能已完成。
