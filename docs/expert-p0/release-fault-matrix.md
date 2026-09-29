# Expert 发布故障矩阵

日期：2026-09-27。

本矩阵区分三类证据：`自动化` 表示仓库测试覆盖，`本机实测` 表示在隔离的 macOS Synara 实例中完成真实进程或真实模型验证，`待平台实测` 表示实现和通用检查已通过，但尚未在对应操作系统上运行产品链路。任何一项待平台实测都不能写成已经通过。

## 配置与启动

| 故障                                        | 预期行为                                      | 证据                                                | 状态       |
| ------------------------------------------- | --------------------------------------------- | --------------------------------------------------- | ---------- |
| 必需连接未配置                              | 首回合启动前阻止 Provider 会话，并给出连接 ID | `ExpertStore.test.ts`、`ExpertGatewayTools.test.ts` | 自动化通过 |
| 必需环境变量缺失                            | 连接前失败，不读取或保存明文凭据              | `ExpertMcpClient.test.ts`、`ExpertStore.test.ts`    | 自动化通过 |
| 必需工具未由下游 MCP 暴露                   | 首回合启动前阻止会话，并关闭已建立的临时连接  | `ExpertGatewayTools.test.ts`                        | 自动化通过 |
| 可选连接未配置或不可达                      | 专家以部分能力启动，记录降级，不影响其他连接  | `ExpertGatewayTools.test.ts`                        | 自动化通过 |
| 固定快照丢失或损坏                          | 启动失败关闭，不回退到当前可编辑专家          | `ProviderCommandReactor.test.ts`                    | 自动化通过 |
| 连接配置并发覆盖                            | 拒绝过期 revision 的保存或删除                | `ExpertConnectionStore.test.ts`                     | 自动化通过 |
| 连接配置含明文密钥、令牌 URL 或未知敏感字段 | 保存时拒绝；只允许宿主环境变量引用            | `ExpertConnectionStore.test.ts`                     | 自动化通过 |
| 非本机明文 HTTP 地址                        | 保存时拒绝，回环测试地址除外                  | `ExpertConnectionStore.test.ts`                     | 自动化通过 |

## Gateway 授权与工具调用

| 故障                             | 预期行为                                     | 证据                                                   | 状态                 |
| -------------------------------- | -------------------------------------------- | ------------------------------------------------------ | -------------------- |
| 会话请求未在专家允许列表中的工具 | `tools/list` 不暴露，`tools/call` 不授权     | `mcpTransport.test.ts`、`gateway-auth-evidence.md`     | 自动化与本机实测通过 |
| A 会话尝试调用 B 专家的工具      | 按已验证 session 和固定 snapshot 隔离        | `gateway-auth-evidence.md`、`full-chain-evidence.md`   | 本机实测通过         |
| 动态专家连接解析失败             | 静态 Gateway 工具仍可列出；专家动态工具为空  | `mcpTransport.test.ts`                                 | 自动化通过           |
| 下游工具返回错误                 | 错误作为工具失败结果返回，不伪造成功         | `ExpertGatewayTools.test.ts`                           | 自动化通过           |
| 活跃工具调用被取消               | AbortSignal 传到下游 MCP，等待中的调用结束   | `ExpertMcpClient.test.ts`、`gateway-evidence.md`       | 自动化与本机实测通过 |
| 凭据撤销或会话退出               | 等待在途请求清理，然后关闭该会话的下游客户端 | `ExpertGatewayTools.test.ts`、`full-chain-evidence.md` | 自动化与本机实测通过 |
| 同一会话重复列举工具             | 复用会话目录，不重复创建下游客户端           | `ExpertGatewayTools.test.ts`                           | 自动化通过           |
| 撤销后恢复同一任务               | 创建新连接并继续使用原固定 snapshot          | `ExpertGatewayTools.test.ts`、`full-chain-evidence.md` | 自动化与本机实测通过 |

## 持久化、恢复与产品状态

| 故障                       | 预期行为                                                                                          | 证据                                                                              | 状态                 |
| -------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------- |
| 编辑专家后返回旧任务       | 旧任务继续显示并使用绑定 revision 和 snapshot                                                     | `ExpertStore.test.ts`、产品隔离实例                                               | 自动化与本机实测通过 |
| Handoff 或“换专家继续”     | 继承原固定 snapshot，或由服务端为新专家准备新 snapshot                                            | `decider.expert.test.ts`                                                          | 自动化通过           |
| 旧数据库没有 Expert 字段   | migration 109 增加可空绑定；旧任务按无专家处理                                                    | migrations tests、projection tests                                                | 自动化通过           |
| Provider 重启后恢复任务    | 重新注入同一 Persona、Skills、资料目录；Gateway 按同一 snapshot 重连                              | `ProviderCommandReactor.test.ts`、Codex/Pi lifecycle evidence                     | 自动化与本机实测通过 |
| 会话停止或恢复后的运行记录 | 保留最近一次成功应用的实际 SDK/CLI 版本；恢复时用新的 lifecycle generation 覆盖，硬删除任务时清理 | `ExpertAppliedRuntimeRecords.test.ts`、`ProviderService.test.ts`、migration tests | 自动化通过           |
| 用户查看任务诊断           | 显示固定 snapshot、实际 Provider/模型、资源目录和连接要求；连接检测必须由用户显式触发             | `ExpertTaskControl.tsx`                                                           | 产品实现通过         |
| 诊断泄漏凭据               | 只显示连接 ID、配置状态、工具名和错误摘要，不显示环境变量值或请求头值                             | UI 与连接配置契约                                                                 | 代码审查通过         |

## 平台与发布门槛

| 平台/场景                     | 当前证据                                               | 发布前动作                                                          | 状态                   |
| ----------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------- | ---------------------- |
| macOS，stdio MCP，Codex       | 设置、绑定、首回合、恢复、撤销清理均在隔离实例实测     | 版本发布候选上复跑产品链路                                          | 本机实测通过           |
| macOS，stdio MCP，Pi          | P0 真实模型、恢复、取消与 Gateway 链路实测             | 版本发布候选上复跑产品链路                                          | 本机实测通过           |
| macOS，Streamable HTTP MCP    | HTTP SDK 连接、认证头、取消和关闭由本地服务器覆盖      | 用一个真实远端或受控局域网服务复跑                                  | 自动化通过，远端待实测 |
| Linux，stdio/HTTP，Codex/Pi   | 通用服务端测试可运行，尚无产品实例证据                 | 在 Linux 隔离 home 与独立端口跑保存、绑定、首回合、恢复、取消、撤销 | 待平台实测             |
| Windows，stdio/HTTP，Codex/Pi | `windows-runtime:check` 通过；尚无打包应用和子进程实测 | 在打包应用中覆盖路径、参数、环境继承、取消和进程树退出              | 待平台实测             |
| 依赖版本                      | 本机 Node 22.23.1、Bun 1.4.0 低于仓库声明版本          | 在 Node 24.13.1、Bun 1.4.2 的发布环境复跑全套检查                   | 待发布环境复测         |

## 发布候选执行顺序

1. 运行格式、lint、类型、迁移和 Windows runtime 检查。
2. 运行 Expert 定向测试以及完整 server/web 测试；记录任何与本功能无关但仍存在的失败。
3. 在全新隔离 home 中分别配置 stdio 和 HTTP 连接，保存专家并创建任务。
4. 对 Codex 与 Pi 分别验证首回合、恢复回合、活跃调用取消、凭据撤销和进程退出。
5. 在 macOS、Linux、Windows 上记录 Provider、模型、Synara 版本、Node/Bun 版本和失败分类；未执行的平台保持“待平台实测”。
