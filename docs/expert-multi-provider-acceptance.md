# Claude Code / oh-my-pi 专家扩展验收

日期：2026-10-18 启动，2026-10-19 完成检查。来源：用户确认完整专家扩展方案并要求执行；两端同批交付，旧版本无法可靠加载固定技能时阻止启动并提示兼容要求。

**交付状态：代码候选完成，自动检查通过，OMP 真实验证通过；Claude 原生初始化通过，但模型接口返回 HTTP 401 `authentication_failed`，完整真实回合尚未验收。2026-10-19 用户在限制已披露后要求交付，功能已合入个人仓库 main，Personal Workbench 0.1.1 已本机安装启动；实际产物、备份和安装核对见[交付记录](./expert-workbench-release-2026-10-19.md)。Claude 完整真实回合仍未验收。**

## 来源与范围

- 原项目基线：`9bceb21ddb7570affae013bd8657ffcc32096176`；此前专家 MCP 可靠性修复完整保留在隔离基线提交 `c8a1134bb`，原工作区未改动。
- 实施分支：`codex/expert-claude-omp`，隔离工作区为 `/Users/wangyuelin/.codex/worktrees/expert-claude-omp/synara-expert`。
- 范围：四端专家契约与实例预检、Claude skills-only 插件投影、OMP ACP 进程级配置、Expert / Context 生效回执、恢复与停止态原生 fork、现有界面 Provider 选项和错误状态。
- 本次 UI 授权来自用户确认的方案：沿用现有布局与操作路径，扩展 Claude / OMP 选项及兼容状态；没有新增页面或视觉重构。
- WebSocket 协议修订为 5：旧修订无法解码新增专家 Provider 枚举，必须配套更新客户端与服务端，协商阶段拒绝旧修订。
- 定义、快照和 MCP 授权仍由原服务持有；无需数据库迁移。实现阶段未安装或发布应用；后续交付按 2026-10-19 的用户授权与交付记录执行。

## 版本与兼容

- 工具链固定 Node 24.13.1 / Bun 1.4.2；仓库 Claude Agent SDK 为 0.3.296。
- 本机全局 Claude Code 2.1.92 无法在首条请求前确认技能插件；固定技能明确要求 CLI ≥2.1.261。隔离验证使用 SDK 自带 CLI 2.1.296，OMP 使用 18.12.1。版本读取、单元测试和真实模型回合分别记录，不互相代替。
- Claude 使用 initialize 插件加载，在无用户 prompt 的控制握手中核验 `plugins_applied` 与具名技能命令；后续原生初始化额外核对路径和错误，不等待首轮才出现的 system/init。全局旧 CLI 保留不改。
- OMP 专家支持绑定已核查的 CLI 版本；使用原生有效设置和技能列表核验固定路径。其他版本或无法确认的配置明确不可用。原生禁用/过滤规则冲突时不自动启用。

## 检查与真实运行

### 源码与自动检查

受检增量以 `c8a1134bb` 为基线，39 个应用/包源码与测试文件的排序 SHA-256 清单保存在本机 `source-manifest.json`，摘要为 `4080f4bc1e35d94c57705be11361149bb5b893fa5891882d0bddea6316d272cc`。该指纹绑定源码；文档与接入点清单另作一致性检查。

| 检查                              | 实际结果                                                            |
| --------------------------------- | ------------------------------------------------------------------- |
| 全仓格式                          | 通过，4931 文件                                                     |
| lint + 服务端同步文件系统预算     | 通过，0 errors、995 warnings                                        |
| 全仓类型检查                      | 7 个 workspace 通过；保留既有 suggestion                            |
| Windows runtime 静态边界          | 通过，316 应用文件、118 边界文件、4 dependency patches、9 manifests |
| Workbench 静态依赖边界            | 通过，43 个 feature source files；不是运行时隔离证明                |
| ProviderService + RPC 定向        | 216 项通过，含恢复、停止态 fork、Context-only、畸形/缺失回执清理    |
| Claude 原生投影与生命周期最终审查 | 13 项定向通过，279 项无关测试跳过                                   |
| OMP 原生投影与 ACP 定向           | 63 项通过                                                           |
| 界面定向                          | 4 项单元测试、20 项专家设置 browser、1 项 ChatView browser 通过     |
| 全仓测试                          | 六个 workspace 全部通过；17,559 passed、39 skipped，耗时 17m8s      |

全仓使用 `bun run test --concurrency=1 --env-mode=loose --continue=always`，由 `mise exec` 固定工具链；`VITEST_MAX_WORKERS=1`。测试进程移除继承的 `ANTHROPIC_AUTH_TOKEN`，不改宿主环境或 Provider 设置。完整日志为 `full-test.log`；浏览器最终复跑日志为 `browser-settings-final.log`、`browser-chat-final.log`。

### 独立审查

- 公共契约、应用回执、宿主入口和界面经独立审查；增加 schema guard，畸形回执走原生命周期失败清理。
- Claude 审查发现完成回合时 Context 指纹被游标重建丢弃，已修复；新增完成回合后停止恢复及 fork 回归，最终独立复核通过。
- OMP 审查发现原生 profile 空格归一化与 `.omp` 用户目录禁用规则的差异，已按 18.12.1 修复并增加回归，最终独立复核通过。
- Simplify 审查后移除重复且无消费者的 capability 布尔值，未另建运行编排或权限层。

### 真实运行

真实模型测试使用私有测试 home、原生配置副本及本地 MCP fixture，经生产 ExpertStore、Adapter、Gateway transport、会话授权和下游 resolver；不触碰用户数据库。OMP 18.12.1 / `openai-codex/gpt-6.1-sol` 已通过真实隔离回合：原生 Read 工具读取两个固定文件，输出对应随机 marker；生产 Gateway 收到两次准确组合参数，fixture 记录两次 echo；停止后以原生 cursor 恢复同一 snapshot；长调用取消后 `waitCalls=1 / cancelledWaits=1 / activeWaits=0`，私有目录清理成功。摘要：`live/2026-10-18T15-46-00.675Z-omp-fbdd9125.json`。

此前两次 OMP 探针分别因事件参数解析和超出 fixture 上限的超时参数失败，均已修正验证脚本并重跑；不将它们记为产品成功。首次遗留的只读测试目录已安全清理，最终无私有 probe 目录残留。Claude 2.1.296 的生产 Adapter 启动/关闭实测已通过（无用户 prompt / 无模型回合），摘要 `live/2026-10-18T16-01-01.356Z-claudeAgent-800c11aa.json`。完整模型回合未通过：修复探针顺序后，原生插件名称/路径、全部固定技能及无加载错误均得到真实 `system/init` 确认；模型接口随后重试并超时，未执行 Read / echo。首轮摘要为 `live/2026-10-18T16-04-34.175Z-claudeAgent-b2480af6.json`。

追加一次 45 秒限时诊断已明确收到 7 条 HTTP 401 `authentication_failed`，重试 1–7/10；到期中断为 `Session stopped.`。当前原生 settings 与继承环境的认证键、API 地址仅作相等布尔比较，二者一致，排除了探针混用来源。该结果说明此配置下的模型接口拒绝认证，不将其推断为凭据过期或适配器加载失败。摘要：`live/2026-10-18T16-43-49.079Z-claudeAgent-1ac4f7b2.json`。最终清理成功，无探针进程或私有测试目录残留。

Claude 的真实 Read / MCP echo / native cursor 恢复 / 下游取消仍未验证；恢复有效原生认证后，需对同一源码重做这些检查。本轮停止模型请求，没有修改账户、API 地址、模型路由或全局 CLI。

Claude 诊断脚本曾在 ServerConfig 获取前预创建投影，首次 private-state 权限整理随后改变其文件 mode，导致完整性校验拒绝。脚本已改为沿用生产启动顺序，并从实际回执读取投影路径。该失败属于验证脚本顺序错误，不通过放宽产品完整性校验解决。

未验证：完整桌面产品中端到端点击路径、打包后的 macOS / Windows / Linux 行为、远端 MCP 服务、签名更新与生产数据恢复。本轮不作上述验收结论。

一次性探针保存在工作区 ignored `.synara/expert-live-probe.ts`，副本归档为本机证据目录中的 `expert-live-probe.ts`；它不是产品入口，不随本次提交分发。探针输出均为筛选结果，实际应用整体点击路径仍需另行验证。

本机证据目录：`/Users/wangyuelin/.codex/task-artifacts/expert-multi-provider-2026-10-18/`。日志只保存检查结果与经筛选的运行摘要，不记录凭证或完整账户配置。
