# Synara 专家配置前端改造方案

> 状态：实现完成，范围内验收完成。用户已授权实施并允许建立 CodeGraph 索引；检查结果和环境差异见[验收记录](expert-frontend-redesign-acceptance.md)。
> 原型仅用于信息结构和交互参考；实际能力与验证范围以文末验收记录为准。

## 1. 目标与设计边界

本方案整理专家配置与专家 MCP 管理的前端调整方向，供后续实现拆分和验收使用。实现前需要先核对目标 checkout、现有组件和接口契约，再据此更新方案中的代码位置。

| 项目       | 方案约束                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 原型参考   | OpenDesign 项目「agent的专家配置系统」中的 `expert-settings-v2.html` 提供信息结构和交互参考。                                               |
| 视觉规范   | 采用 Synara 现有设置面板、`SettingsPanelPrimitives`、`ui/button`、`input`、`textarea`、`switch`、`menu`、`dialog`、`tooltip` 和现有 theme。 |
| 字体与主题 | 遵循 `text-ui` 字体令牌、用户字号设置、深浅色主题与 reduced-motion 行为。                                                                   |
| 实现范围   | 实现专家配置与 MCP 管理调整，使用独立工作区和测试数据验收；发布及日用数据迁移另行处理。                                                     |
| 原型代码   | 不复制原型 CSS、固定像素字体或演示数据来冒充 Synara 产品行为。                                                                              |

最终界面沿用 Synara 自身的视觉语言、间距、组件状态和响应式行为。默认保持原型的“专家列表 → 独立详情 → 返回列表”流程，嵌入现有设置内容列；窄屏沿用设置导航收起和表单纵向排列。如现有设置组件可通过属性或变体满足需求，优先扩展现有组件。说明提示复用 Tooltip，涉及操作前提或失败原因的文字保留在可直接读取的位置。

## 2. 当前路由与工作基线

### 设置入口

- 沿用 `apps/web/src/workbench/registry.ts` 对 `experts-settings` 的静态注册。
- 沿用 `apps/web/src/routes/_chat.settings.tsx` 的 `workbenchSettingsPageForSection` 与 `renderWorkbenchSettingsPage` 挂载路径。
- 新增专家外部工具（MCP）入口时，同步扩展现有 `settingsNavigation.ts` 与 workbench settings 注册边界。
- 不把设计限定在旧 checkout 的 Settings switch 结构；实现前复核当前已合入 tree 的路由和导航实现。

### 复用边界

- 从现有 `ExpertsSettingsPanel` 中提取 `ExpertConnectionManager`，将连接管理职责放入独立的“专家外部工具（MCP）”设置页。
- `ExternalMcpSettingsPanel` 管理的是外部 app 经 Gateway 访问 Synara 的授权，不代表专家使用的第三方 MCP 连接，本次不将其改作专家连接页。
- `EditorDirtyRouteGuard.tsx` 的 `useBlocker` 模式可用于理解导航拦截，但该组件会自动 flush 文件编辑器，不可直接套用到专家草稿。
- 搜索和弹层复用现有 `search-input.tsx`、`popover.tsx` 及对应 primitives；不假设存在 `tabs.tsx`，可在现有 tab 按钮模式上补齐统一的 accessible tabs 行为。

### 基线与实现前检查

本轮 primary checkout 的 HEAD 为 `8e5c12b`，其中已有未提交文档修改；此前验收并合入 main 的候选为 source ae `aeffdc63623d7cf4c535141a71889f29dcbf0d5f`，本方案已从该提交的文件树核对工作台注册与专家契约。后续实现前应在隔离 checkout 复核项目 main 的最新 tree、组件和服务契约，不得覆盖或重置 primary checkout 中已有的文档改动。此步骤不执行官方上游版本同步。

## 3. 页面结构与主要流程

### 专家设置页

页面由专家列表、独立详情区、草稿保存栏组成。列表支持搜索、使用中与已归档筛选，并突出当前选中专家；列表行不触发逐行 MCP 连通性检测。

详情区提供两个页签：

| 页签 | 字段与交互                                                               |
| ---- | ------------------------------------------------------------------------ |
| 能力 | `persona`、`outputRequirements`、`skills`、`connections`、`references`。 |
| 设置 | `name`、`description`、`useCases`、`preferredProvider`。                 |

新建专家进入“设置”页签，先填写身份信息；编辑专家默认进入“能力”页签。能力页中的 MCP 项仅提供启用状态入口，工具白名单编辑统一放到专家外部工具（MCP）管理页。页面页签之间切换时保留当前专家的草稿，不触发自动保存。

配置表单采用单栏紧凑卡片：设置页为“基本信息”和“运行配置”，简介（description）与适用任务（useCases）独立保存；首选 Provider 保留 Codex、Pi、不指定的现有选择。能力页的“行为指令”卡片包含工作方式（persona）和输出要求两个独立字段。四个文本域复用 Textarea 的 compact 变体，默认两行高度，随内容及用户字号增长；其他调用者的默认尺寸不变。技能模块保持现有布局、数量和添加交互。

MCP 工具使用与技能、参考资料一致的紧凑标题与添加入口，数量表示保存的工具白名单条目数，不表示当前可调用数量。保留现有连接目录、授权开关、管理工具和导航保护；空目录不占位。全局停用、退役和未知状态由短标签表达，工具数量与必需性标签可聚焦查看完整含义。关闭连接仍保留白名单并跳过依赖检查。参考资料沿用文件名列表、完整路径提示及展开编辑，补充文件图标，行间距保持 8px。

专家页顶部只保留一个主标题：列表为“专家 + 总数 + 新建”，详情为“返回图标 + 名称 + 弱化版本 + 检查配置 / 更多操作”。删除全局重复标题、说明和面包屑；能力 / 设置页签紧贴标题栏，间距为 8px。通用 Restore defaults 作用于全局设置，从专家页隐藏；不虚构恢复预置专家功能。列表保留原有网格、搜索与状态筛选。卡片只显示名称与单行用途摘要（description 优先、useCases 兜底，超长省略并可悬停看全文），版本仅在详情展示；主体点击编辑，悬停背景反馈，右侧独立“···”菜单提供复制、归档 / 恢复、删除。菜单与主体按钮不嵌套，列表和详情共用 ExpertActionsMenu。复制打开未保存副本；归档、恢复与删除携带当前 revision。已归档专家只读。删除需要明确确认，永久移除专家定义，保留已有任务绑定、快照、源技能与参考资料、MCP 配置和凭据。初始化标记持久化在 experts/initialized.json，避免删空后重启重新补回预置专家；旧的非空专家库只补标记，不改写定义。

### 技能与参考资料

- 技能与参考资料采用按需添加布局：各显示一行标题、数量和添加按钮，不重复标题、不显示空列表占位或常驻添加表单。集合标题和条目上下各留白 8px。
- 技能添加使用现有 Dialog，以“已发现 / 按路径”切换添加方式；保留搜索、来源筛选和多选。目录读取失败时仍可按路径添加。名称和简短说明分开标注，路径通过详情提示查看。
- 已添加条目默认只显示摘要，展开后编辑字段；错误条目自动展开，支持错误定位和移除。复用现有 skills model 与 Collapsible，不引入第二套技能数据结构或动画。
- 参考资料添加窗口提供“单条路径 / 批量粘贴”，用新增、重复数量反馈去重结果；取消不改变专家草稿，确认后进入统一保存流程。
- 输入层可执行本地字段校验，例如必填、格式和重复路径提示；这些校验只检查输入，不运行专家或模拟工具。

### 专家外部工具（MCP）管理页

连接配置与专家授权分区呈现：

| 区域     | 编辑内容                                                   | 持久化边界                                                                                         |
| -------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 连接配置 | 专家可用的 MCP 连接配置及其元数据。                        | 连接配置使用现有连接管理服务；credential 不放入 Expert。                                           |
| 专家授权 | 专家选择、连接选择、允许使用的工具白名单及既有必需性要求。 | 仍通过 `saveExpert` 保存 `required/tools`，携带 `expectedRevision`；保存授权会生成该专家的新版本。 |

用户从专家编辑进入连接管理时，路由携带 `expertId` 和 `connectionId`，用于定位专家与连接。如果专家草稿有未保存修改，先统一显示保存、放弃、取消选项；取消留在原编辑页。选择保存后，保存成功才继续导航；若发生版本冲突，保留草稿并停留在可恢复的编辑上下文。

初次进入时白名单可以为空，但需明确说明“尚未授权任何工具”。
不默认授权连接提供的全部工具，也不把专家授权改为连接级全局授权。
页面提供的专家 MCP 开关只控制该专家是否启用这条连接。

## 4. 草稿、保存和状态呈现

### 显式草稿模型

页面加载当前服务版本后建立本地 draft，并记录其 `expectedRevision`。字段编辑、技能选择、参考资料变更、连接开关与工具授权修改都会标记 draft 为 dirty。保存通过现有专家保存流程提交；成功后更新版本和查询缓存，并清除 dirty 状态。不得通过 `localStorage` 伪造持久化、恢复或跨 reload 生效；后台 refetch 不得覆盖 dirty draft，保存失败或版本冲突时保留本地编辑内容。

dirty 状态出现保存栏，提供保存和放弃入口，并支持 `Cmd+S` / `Ctrl+S`。快捷键仅在专家编辑或授权编辑上下文生效，不抢占工作区文件编辑器的保存操作。切换同一详情页中的页签只改变视图，不丢失草稿。返回列表、切换专家、切换设置分区或跳往专家 MCP 管理页时，dirty guard 显示保存、放弃、取消；取消保持当前页面与草稿。保存失败或版本冲突均保留草稿，不静默覆盖服务端新版本。关闭窗口时使用原生未保存提示，不在退出过程中假定异步 RPC 已完成。

### 预检、连接测试与就绪状态

输入字段校验与服务预检分开呈现，前者只校验当前表单数据。真实 `previewExpert` 只检查已保存版本的资源路径、配置和 env 引用；成功不能表示 MCP 已联网，也不能表示 Provider 已加载。

连接测试只在用户明确点击 `testExpertConnection` 后执行。测试结果保存发生时间和连接 revision；配置修改后，旧成功结果标记为过期。当前没有测试结果时显示“未检测”；实际失败时显示服务返回的错误内容。列表不逐行联网检测；可按用户需求或当前可见范围缓存只读预检结果，并保证缓存与版本对应。
预检查询缓存 key 至少包含 `expertId`、请求 `revision` 和 `provider`；存在 `cwd` 时也纳入 key。
响应中的 `definition.revision` 若与请求版本不同，不显示该请求版本已通过，并保留版本冲突说明。

顶部默认显示“检查配置”，不常驻显示“未检查”；请求后以成功、问题或加载图标表达状态，通过现有 Popover 展示真实结果，完整状态保留为可访问名称与悬停提示；前端字段检查通过不生成运行时已就绪状态。草稿校验错误定位到相应字段；服务端 `issues` 是字符串时按原文展示，不用正则猜字段归属。无法结构化映射的错误以原始列表呈现，保留完整服务反馈。生产界面不接入原型中模拟 preflight、定时成功提示、示例技能目录或假连接结果；自动化测试仍可使用夹具验证界面行为。无真实检测结果的连接显示“未检测”，不得依据连接配置已保存显示为“已连接”。

## 5. 专家 MCP 数据兼容与服务依赖

现有数据中的 `required/tools` 必须保留；关闭后重新开启、重新加载页面均不能丢失原来的授权范围。禁用状态由后端 preview、真实预检和 gateway 统一解释；snapshot 保留绑定时的完整配置。已新增最小 optional `enabled` 字段：字段缺省时按 `true` 处理。禁用连接不参加新任务的依赖检查和工具授权。该兼容规则须进入实际 schema / contract 和各运行链路，不得由前端单独推断。旧定义与旧快照保持原有解释，不改写已绑定快照；修改专家配置仅影响后续生成的新快照。

不得创建第二套授权数据库，也不得把 MCP 凭据存入 Expert。
不得用空 `tools` 列表伪装连接禁用；空列表表示当前未授权任何工具。
归档恢复已补齐最小的 revision 受控 restore RPC、存储操作和 Web 传输。

启用状态持久化和归档恢复的后端依赖均已实现，再接入连接开关和恢复入口。连接测试返回实际读取配置的 revision，并在连接前核对 expectedRevision；专家 RPC 保留真实失败原因。

## 6. 建议的前端模块边界

| 模块                                      | 职责                                                                          | 主要复用                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `ExpertsSettingsPanel`                    | 专家查询、当前选择、dirty 状态、导航和保存协调。                              | 现有专家 query / mutation、统一 query keys、draft model。          |
| `ExpertList`                              | 搜索、使用中 / 已归档筛选和进入专家详情。                                     | 现有列表行、输入框和菜单 primitives。                              |
| `ExpertActionsMenu`                       | 列表卡片与详情共用复制、归档 / 恢复、删除入口。                               | 现有 Menu、Button、ComposerPickerMenuPopup 与图标。                |
| `ExpertEditor`                            | 两个页签及专家能力与设置字段。                                                | `SettingsPanelPrimitives`、现有表单组件、accessible tab 按钮模式。 |
| `SkillPicker`                             | 技能目录搜索、来源筛选、多选和按路径添加；行内编辑由编辑器复用 skills model。 | 现有 skills model、`dialog.tsx`、`search-input.tsx`。              |
| `ExpertConnectionPermissions`             | 专家能力页的连接开关与跳转管理入口。                                          | Expert save model、Switch 和连接数据查询。                         |
| `ExpertConnectionsSettingsPanel` 内授权区 | MCP 管理页按专家编辑工具白名单和必需性要求。                                  | 同一 Expert save model、Checkbox 与连接工具检测结果。              |
| `ExpertPreviewPopover`                    | 展示真实预检状态、错误和字段定位。                                            | 现有 popover、服务 response 与共享错误呈现。                       |
| `ExpertSaveBar`                           | dirty 提示、保存、放弃和快捷键。                                              | 现有 button / dialog、统一 draft 状态。                            |
| `ExpertConnectionsSettingsPanel`          | 独立管理 MCP 连接配置和专家授权。                                             | 从 `ExpertsSettingsPanel` 提取的 `ExpertConnectionManager`。       |

列表、编辑器与连接管理页使用统一的 query keys 和 draft model，避免重复的数据源。组件新增前先搜索同类实现；能通过扩展现有组件满足时，不另造一份相同交互。

## 7. 分阶段实施顺序

### A. 最终基线与复用核对

在隔离 checkout 复核最新已合入 commit、dirty 状态、workbench 注册、导航、专家模型和 RPC。列出可复用组件和接口字段，并更新本方案中的实现位置与未决服务依赖。不重置 primary checkout；仅将已评审且与本任务相关的方案和工作流文档带入实现 checkout。

### B. 布局和专家编辑

沿用 workbench 设置注册边界，拆分专家列表与独立详情。实现两页签、新建默认页签和编辑默认页签、复制与归档菜单，并完成 Synara theme、用户字体、深浅色、响应式与键盘交互适配。

### C. 技能、资料和草稿保存

实现技能来源搜索、多选、按路径入口与行内编辑，以及参考资料批量粘贴和去重。接入统一 draft、SaveBar、`Cmd+S` / `Ctrl+S`、离开提示和 revision 冲突保留。接入真实 `previewExpert` 结果，保持字段错误和原始 issues 的可追溯显示。

### D. MCP 管理迁移与后端依赖

从 `ExpertsSettingsPanel` 提取 `ExpertConnectionManager`，在导航和注册中加入“专家外部工具（MCP）”。拆分连接配置和专家授权；授权继续通过 `saveExpert` + `expectedRevision` 保存。后端补齐 optional `enabled` 的兼容语义，并在 preview / 真实预检 / gateway 统一生效，并验证已绑定 snapshot 不变。后端依赖未完成时先完成布局与现有行为迁移，不呈现无法持久化的完整开关。
save、archive、restore 与专家授权保存后，失效相关 expert / preview 查询；不改 task snapshot 或 diagnostics 业务。

### E. 恢复、真实检测与集成验收

服务提供 revision 受控 restore 后，再接入已归档专家恢复。接入用户主动发起的连接测试及其时间、revision、错误和过期状态。按下文检查专家授权、快照和网关解释是否一致，并记录仍未覆盖的运行环境。

## 8. 业务边界

- `preferredProvider` 继续表示 Provider 偏好；不增加专家模型选择字段。
- 不增加权限升高策略，不把模型排名或价格假设写入此产品配置。
- 不重写 task snapshot、composer 或 diagnostics 的业务边界。
- Provider-specific 的能力仍由当前 provider contracts 和 adapter 决定。
- 专家 MCP 授权属于专家的 `required/tools` 配置，不是连接级全局授权。

## 9. 完成标准与后续验证

### 本方案当前状态

实施基线为项目 main `61df29b094d3e5f2877f7787613655220a4f72a2`，在独立工作区 `expert-frontend-redesign` 开发。主工作区原有改动予以保留，未执行官方上游同步。最终实现与检查结果记录在[验收记录](expert-frontend-redesign-acceptance.md)中；实现保留为独立工作区的未提交修改，未执行合入、推送或发布。

### 前端交付标准

- 专家列表、详情页签、技能和参考资料编辑符合上文的信息结构与保存规则。
- dirty 导航、版本冲突、归档只读、真实预检和主动连接测试具有明确状态。
- MCP 连接配置与专家授权位置清楚；空白名单表达未授权，不表达已禁用。
- MCP enabled 与 restore 只有在对应服务契约落地后可操作。
- 界面使用 Synara 已有组件、theme、字体设置和 motion 约定。
- task snapshot、composer、diagnostics 及现有专家数据语义保持一致。

### 后续检查建议

文档阶段只做链接、命令与指令一致性检查，不运行应用测试。前端单包实现后，集中执行 `bun run fmt:check`、`bun run lint`、`bun run typecheck`、相关 Vitest 与隔离 browser 验证；Web 定向检查使用 `bun run test:web:focused`。browser 验证覆盖字体设置、深浅色、键盘、草稿保存 / 放弃、真实接口失败和响应式布局。若改动实际跨包服务契约、授权、snapshot 或生命周期，则运行完整 `bun run test` 与相关授权 / 快照测试，覆盖旧配置缺省启用、关闭保留白名单、新任务不暴露禁用工具及旧任务快照不变。schema 调整按真实存储方式判断是否需要 migration；修改迁移时执行 `bun run migrations:check`，修改平台/进程边界时执行 `bun run windows-runtime:check`。纯 UI 改动不要求全 Provider 模型验证或 DMG 验证；运行时路径改变时只增加受影响路径的真实验证。

## 10. 关联资料

- [专家配置产品与技术设计](expert-product-technical-design.md)
- [开发工作流](workbench-development-workflow.md)
- [实现验收记录](expert-frontend-redesign-acceptance.md)
- [专家设置面板与现有连接管理](../apps/web/src/components/settings/ExpertsSettingsPanel.tsx)
- 工作台静态注册：`apps/web/src/workbench/registry.ts`（实现工作区已从当前 main 核对）
- [聊天设置路由](../apps/web/src/routes/_chat.settings.tsx)
- [设置导航](../apps/web/src/settingsNavigation.ts)
