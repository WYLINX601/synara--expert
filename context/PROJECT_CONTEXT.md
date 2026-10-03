# Synara Expert 项目上下文

更新日期：2026-09-29  
范围：在现有 Synara 中实现跨 Codex / Pi 的 Expert 能力。本文只负责项目路由和当前状态；产品与技术细节以链接的权威文档为准。

## 当前目标

把 Expert 作为可复用、可检查、可固定版本的工作能力配置，组合 Persona、Skills 和 MCP 工具；Task 在首次启动时绑定不可变快照，并记录实际生效的 Provider、模型、SDK / CLI 版本和 lifecycle generation。

当前实现已达到 P2 主体范围，下一阶段是补齐跨平台和发布候选实测，而不是继续扩大首版功能。

## 当前权威材料

| 材料                                                         | 角色               | 当前用途                                                    |
| ------------------------------------------------------------ | ------------------ | ----------------------------------------------------------- |
| [产品与技术方案](../docs/expert-product-technical-design.md) | 当前产品与架构基线 | 产品定位、对象边界、交互、数据模型、Provider 适配和阶段范围 |
| [P0 技术验证记录](../docs/expert-p0/README.md)               | 当前验证结论入口   | Codex / Pi、恢复、取消、Gateway 与真实模型证据              |
| [发布故障矩阵](../docs/expert-p0/release-fault-matrix.md)    | 当前验收与缺口清单 | 区分自动化、本机实测和待平台实测                            |
| [交互线框](../docs/expert-interaction-wireframe.html)        | 已确认的交互参考   | 新任务选专家、专家管理和任务详情的首版流程                  |
| [架构图](../docs/expert-architecture.drawio)                 | 可编辑架构参考     | Expert、Task、Provider、Gateway 和连接的关系                |

## 已确认的产品与架构决定

以下决定的权威说明均在[产品与技术方案](../docs/expert-product-technical-design.md)：

- Expert 是一级产品对象，Task 仍是实际工作的承载者；首版不另建独立 Agent Runtime。
- Expert 组合 Persona、Skills、连接和运行偏好；凭证不进入 Expert 定义或快照。
- Task 首次发送时固定 Expert snapshot。修改模板、归档模板、恢复旧任务都不能改变既有任务的快照。
- 换专家或跨 Provider 继续工作沿用派生任务与 handoff，不在活跃会话中热替换配置。
- Codex 和 Pi 保留各自协议行为；Provider 专属投影留在 Adapter，跨进程 Schema 留在 `packages/contracts`。
- 第三方工具统一经过 Synara Gateway。`tools/list` 与 `tools/call` 都按已验证的会话身份和固定快照授权，不能信任工具参数中的 Expert 或 thread 标识。
- Provider 自带的环境 Skill 可能继续出现；产品只声明专家提供的固定技能来源，不把专家技能清单描述为严格工具沙箱。

## 当前实现状态

以下是 2026-09-29 工作树中的机械事实，产品语义仍由上面的方案文档解释：

- 专家库已支持新建、编辑、复制、归档、预检和版本化保存。
- 专家技能配置已支持手动新增、修改、删除本机 Skill 引用，也可从当前机器的发现目录快捷添加或移除；保存前检查空名称、空路径和重复路径。
- 新任务输入区可选择专家；首次发送创建不可变快照与任务绑定。fork、handoff、恢复和接续任务保留既定继承规则。
- Codex 通过会话指令和独立 Skill 根目录加载专家资源；Pi 通过会话 ResourceLoader 与 custom tools 加载。
- 本机 stdio / Streamable HTTP MCP 连接、环境变量凭据引用、连接测试、专家工具允许列表、会话隔离、取消和撤销清理已接入。
- 任务详情可查看固定快照、任务配置模型、最近一次成功启动的实际 Provider / 模型、Codex CLI 或 Pi SDK 版本、lifecycle generation、资源目录和连接要求。
- 实际运行记录在成功启动或恢复后覆盖；停止后保留；任务硬删除时清理。记录写入失败会使本次启动失败并清理对应运行时，不能显示虚假成功。

主要实现入口：

- 合同：[expert.ts](../packages/contracts/src/expert.ts)、[provider.ts](../packages/contracts/src/provider.ts)
- 专家与连接服务：[experts](../apps/server/src/experts/)
- 生命周期与应用记录：[ProviderService.ts](../apps/server/src/provider/Layers/ProviderService.ts)
- Codex / Pi 适配：[codexAppServerManager.ts](../apps/server/src/codexAppServerManager.ts)、[PiAdapter.ts](../apps/server/src/provider/Layers/PiAdapter.ts)
- 专家管理与技能编辑：[ExpertsSettingsPanel.tsx](../apps/web/src/components/settings/ExpertsSettingsPanel.tsx)
- 任务诊断：[ExpertTaskControl.tsx](../apps/web/src/components/chat/ExpertTaskControl.tsx)

## 当前验证状态

- P0 技术可行性已通过：macOS 上 Codex / Pi 真实模型的 Persona、Skill、工具调用、恢复和取消已有证据；两端经过 Gateway 调用本地 MCP、会话 A/B 授权、下游取消与退出清理也已有证据。边界见[P0 技术验证记录](../docs/expert-p0/README.md)。
- 2026-09-29 本地检查中，格式、lint、类型检查、Windows runtime 静态边界检查、Expert 定向测试、完整 Web 测试和完整 server 测试通过。
- 仓库根完整测试没有形成全绿结论：五个工作区完成，desktop 工作区卡在 Electron `install.js`，8 分 25 秒无进展后终止。后续应在依赖完整的环境单独复跑 desktop 全套测试。
- 迁移检查命令正常退出，但当前 checkout 没有可访问的发布标签，因此没有完成历史发布链比较。
- 当前机器 Node 22.23.1、Bun 1.4.0 低于仓库声明的 Node 24.13.1、Bun 1.4.2；发布候选需要在声明版本复跑。

## 当前工作状态与边界

- 当前分支为 `main`，基线提交为 `eaa61ed`。Expert 实现及文档仍在工作树中，尚未提交或发布；继续工作前先查看 `git status`，不要把文档中的完成状态误认为已有远端提交。
- 不重置用户数据库，不复用生产状态做验证。启动产品实例时使用独立 `SYNARA_HOME` 和未占用端口，并先检查开发启动器的 dry-run。
- 连接配置只保存环境变量或凭证引用；诊断、日志、导出和 context 不保存凭证值。
- 真实 Provider 成功、进程退出和取消清理必须由对应运行证据确认；mock、类型检查和本地构建不能替代产品实测。

## 下一步

1. 在 Linux 隔离实例完成保存连接、绑定专家、首回合、恢复、取消和凭据撤销清理。
2. 在 Windows 打包应用中覆盖可执行文件解析、参数与环境继承、stdio / HTTP MCP、取消及进程树退出。
3. 用真实远端或受控局域网 Streamable HTTP MCP 服务补充 macOS 远端链路实测。
4. 在仓库声明的 Node / Bun 版本和发布候选上复跑完整检查，并解决或隔离 desktop Electron 安装脚本挂起。
5. 完成上述发布门槛后，再决定提交、发布及是否进入 P3。P3 的导出分享、Git 来源、OAuth、团队分发和项目默认专家仍是按需求启动的后续范围。

执行时先从本文件选择权威材料，再只读取当前任务需要的章节。若方案文档、P0 证据或发布故障矩阵发生变化，应重新核对本页对应摘要，不以本页日期代替新证据。
