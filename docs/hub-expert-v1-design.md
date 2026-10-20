# Hub × Expert V1

来源：用户于 2026-10-19 确认开发计划；参考[产品讨论](chatgpt-conversation://6ad4b8b0-89d0-83ec-9283-618ba41e2265)。本文件是该需求的接口与行为说明，不代表实现、运行或发布验收。实际结果另记验收文档。

## 场景与范围

用户从 Project 创建 Hub，由 Coordinator 派发实际 Expert。Expert 自主发布文档或索引，后续 Expert 按需读取后继续工作。复用原有 Hub、Worker、Library、预览和工具审批，不新增页面或执行系统。

交付目标是本地完整验收；推送、日用应用安装和发布不在范围内。2026-10-19 用户审核通过修订 Figma 并明确允许进入开发，授权原 Project 菜单创建／打开 Hub、原任务及线程条目显示 Expert 名称、原 Library 关键产物筛选／标识和发布版本预览；分屏继续沿用现有能力。当前开发分支为 `codex/hub-expert-v1`，从 `850de05e08ab9c116c639e7b1cb8145e0b6e05d5` 隔离创建，不包含原工作区的输入框 UI 修改。

用户此前指出首版原型偏离现有 Hub、Library 和子线程交互，首版不作为实现依据。获批修订以现有 `ProjectPanel`、`GroupOverview`、`LibraryPanel` 和 `ChatView` 为基础：Hub 保持紧凑的浮动面板与线程状态列表，Worker 沿用原完整对话及分屏，Library 保留搜索、类型、目录树、列表／网格、上传、历史和显式展开，仅增加关键产物筛选与轻量标识。

获批修订版位于 Figma 的 `V2 · 原生 Hub 增量` 页：[Hub 概览](https://www.figma.com/design/mJatQwnjWkdzXUfLBtjNfk?node-id=15-56)、[Worker 对话](https://www.figma.com/design/mJatQwnjWkdzXUfLBtjNfk?node-id=15-227)、[紧凑 Library](https://www.figma.com/design/mJatQwnjWkdzXUfLBtjNfk?node-id=15-375)、[Project 菜单](https://www.figma.com/design/mJatQwnjWkdzXUfLBtjNfk?node-id=24-153)、[原生分屏选择器](https://www.figma.com/design/mJatQwnjWkdzXUfLBtjNfk?node-id=26-214)、[展开 Library 预览](https://www.figma.com/design/mJatQwnjWkdzXUfLBtjNfk?node-id=26-418)。前四个状态已核对修订截图；后两个状态的最终编辑后截图受 Figma 调用额度限制，实际实现另以本地浏览器验收。原型使用 Noto Sans SC 作为导出兼容字体，实际 UI 沿用原生字体和用户字号设置。

## 数据所有权与宿主能力

| 数据                   | 所有者               | 接入能力                                                                  |
| ---------------------- | -------------------- | ------------------------------------------------------------------------- |
| 项目、线程与执行事件   | 原生 Orchestration   | 原有类型化命令、线程投影及 Provider 生命周期                              |
| Hub 来源 Project       | Workbench 扩展持久化 | Project 创建关联时显式记录；ProjectAgent 提供来源，Context 在首次运行绑定 |
| Space／Project Context | 现有 Context 模块    | 首次运行的不可变快照，不复制到 Hub 记忆                                   |
| Expert 配置与快照      | 现有 ExpertStore     | 接受任务前预检与快照；内部执行上下文传递固定绑定                          |
| Hub 工作项、排队和恢复 | 现有 HubWork         | 持久化接受时的目标与绑定，不另建调度器                                    |
| 关键集合与请求回执     | Workbench 扩展持久化 | 按 Hub、Worker 线程管理版本及幂等请求                                     |
| 发布文件及版本         | 原有 Git Library     | 原路径边界、写入锁、Git commit 和版本读取                                 |

UI 继续位于原 `_chat` 宿主布局，继承其认证、订阅、侧栏、快捷键及聊天状态；本次不声称页面或运行隔离。

## 来源 Project 与 Context

`ProjectAgentConfigureInput` 和 `ProjectAgentConfig` 增加可选 `sourceProjectId`。`ProjectAgentLinkProjectInput.contextSource: true` 仅供用户从 Project 创建 Hub 的显式关联流程，事务性写入来源及关联关系。来源必须是普通 Project，既有来源不可更换；旧 Hub 不自动推断。`getOverview.sourceProjectId` 和未完成配置的 summary 也保留来源，设置页关闭、刷新或重试不丢失。

客户端在创建前保存请求对应的 Hub ID、名称和关联请求 ID，并使用带 ID 的独立目录。相同请求失败重试原对象，不以名称复用其他 Hub；关联成功后新的创建请求获得新身份。关联失败不自动启动。只有确认删除成功才清除被丢弃对象的请求身份，失败删除或普通关闭继续保留。`configure` 省略来源时沿用持久化来源。

Coordinator 首次执行从明确来源读取现有 Space／Project Context，使用原绑定事件保存快照。普通 Worker 仍按实际目标 Project 绑定 Context。绑定后项目编辑、归档或删除不会替换快照；新的首次绑定遇到失效来源时失败。来源 Project 不能被解除关联。

每个 Hub 的记忆、决策、工作项和关键集合分别管理。共享 Project 的文件不属于安全隔离；涉及并行代码修改时继续复用既有 worktree 能力。

## Expert 派发

Gateway 创建输入允许可选 `expertId`；指定专家时可省略运行目标，普通 Worker 保持原有目标要求。显式目标优先；否则优先专家偏好的 Provider 的可用默认模型；没有偏好时沿用原派发目标。不可用、配置不兼容或必需能力缺失明确失败，不静默降级。

Hub 接受工作项之前完成快照与运行目标解析，将固定绑定写入创建规格。重复请求先核对已接受记录，再进行新请求预检；排队期间的模板修改或归档不能改变已接受任务。内部绑定不作为 Agent 工具参数或 WebSocket 创建参数开放。

运行继续通过原 Provider Adapter 应用 Persona、Skills、References、输出要求及 MCP 授权。任务卡使用绑定中的名称。授权仍由原调用身份、请求准入与工具权限控制，工具说明不创造权限。

## 关键产物

每个 Hub 内，每个 Expert Worker 线程拥有一个当前集合，最多三项；发布接收 1～3 份文档或索引，替换该线程原集合。未发布和撤下后允许为空，撤下不删除历史文件。文件名默认为名称，说明可选，Expert 自主决定产物和时机。

发布顺序为完整校验、受锁保护的文件提交、当前集合事务切换。集合引用固定发布 commit；读取不能意外返回工作目录里的新草稿。请求回执保存请求身份与指纹，相同请求重放，不同内容或过期集合版本冲突；文件已提交但集合切换失败时保留原集合，重试复用该批次。

读取接口接受 `ownerThreadId`、`path` 和可选 `revision`。指定版本只从本 Hub、该 Worker 已完成的发布回执解析，不能把任意 Git commit 当作访问凭据；省略版本时读取当前集合。旧发布在重新发布或撤下后仍可按原版本读取。

发布调用身份决定 Hub、Worker 和 Expert 来源，不能信任参数中的身份。Worker 只更新或撤下自己的集合；用户通过既有授权路径撤下。读取必须验证 Hub 归属和资源范围。索引不会向引用资源授予权限，远端资源仍按原访问方式按需读取。

Library 的普通编辑、重命名、删除或恢复不等于重新发布。`libraryPath` 固定为发布 commit 内的路径；`currentLibraryPath` 跟随原生重命名，`libraryState` 区分可用与缺失。普通编辑不替换发布正文。删除隐藏有效标识，原生恢复重新核验文件；缺失文件随父目录重命名时保持缺失，不把新出现的同名文件自动当作已恢复。目录移动在原锁内准备持久化意图、完成文件操作后切换引用；失败可按实际文件证据恢复。根目录移动保留 Git 历史后，引用继续在新根目录解析。

Library 关键条目打开固定 revision 的原生只读预览，保留发布版本和 Expert 来源。Markdown 沿用现有渲染，PDF 沿用现有 `PdfFilePreview` 和页码／缩放控件。发布预览不请求实时工作区文件，不开放编辑、原生 Open、磁盘重载或实时路径聊天引用。普通 Library 文件继续使用原有预览与操作。

每轮 Hub Context 提供受预算限制的简短索引，先列明确引用的产物，再列其余当前集合，超出部分通过查询发现。正文、历史讨论和过程文件不默认注入。关键产物不是用户已认可决定，不自动推进阶段或跨 Hub 同步。

### 当前候选接口

| 接口                                           | 输入要点                                         | 归属                               |
| ---------------------------------------------- | ------------------------------------------------ | ---------------------------------- |
| `synara_hub_list_experts`                      | 按需获取名称、用途、偏好与可用状态               | Coordinator 只读                   |
| 原线程创建规格                                 | 可选 `expertId`；专家可省略 `target`             | 服务端预检后固定快照与目标         |
| `synara_hub_publish_deliverables`              | `requestId`、`expectedRevision`、1～3 个 `files` | 已认证 Expert Worker 的自身集合    |
| `synara_hub_list_deliverables`                 | 可选 `ownerThreadId`                             | 当前 Hub 的集合元数据              |
| `synara_hub_read_deliverable`                  | `ownerThreadId`、`path`、可选 `revision`         | 当前 Hub 已发布版本                |
| `synara_hub_withdraw_deliverables`             | `ownerThreadId`、`requestId`、`expectedRevision` | Worker 自身；用户沿用既有授权路径  |
| `projectAgent.deliverables.list/read/withdraw` | 以上输入加 `projectId`                           | 原生 WebSocket 身份及 Hub 访问检查 |

公开文件元数据返回 Worker 来源 `path`、服务端生成的 `libraryPath`、当前位置 `currentLibraryPath` 与 `libraryState`，客户端无需推导内部存储路径。名称从工作项接受时的 Expert 快照取得，不读已重命名模板。旧版本读取只读取可信发布记录中的 Git commit；普通文件编辑不改变该引用。

当前实现的工程上限为每文件 1,000,000 字节、每批 3,000,000 字节，支持 Markdown、文本、HTML、JSON、PDF、DOCX；该上限严于原 Library，不改写为用户已确认的产品规则。文本 Agent 工具不解析 PDF／DOCX 正文；需要跨 Expert 接续时发布文本索引／摘要，并按原权限读取源资源。PDF 固定字节的原生浏览器预览已有聚焦测试，DOCX 预览和二进制正文的真实 Agent 理解未验收。大文件及二进制读取限制须在交付中保留，不能据文本链路通过宣称全格式通过。

## 验收原则

按[开发 SOP](./workbench-development-workflow.md)执行跨包、生命周期与迁移检查。最终检查绑定实际受检源码和差异；真实 Provider、恢复、浏览器与完整链路分别记录。聚焦测试通过不代表本地完整验收、安装或发布。
