# Context V1 原型验收记录

日期：2026-10-13（Asia/Shanghai）。本地审核入口：<http://127.0.0.1:17736/>。

## 交付范围

完成独立 React / Vite 原型、内存演示模型、真实组件复用、启动说明、交互截图和 QA。修改仅位于本目录；主仓库原有改动和候选工作区源码保留。没有提交、推送、安装、生产数据迁移或真实 Provider 执行。

UI 来自 `expert-frontend-redesign` 候选工作区，HEAD 为 `61df29b094d3e5f2877f7787613655220a4f72a2`，包含该工作区的未提交修改。不能用 HEAD 代替实际源码；关键 UI 文件和锁文件的摘要见 [source-baseline.json](../qa/source-baseline.json)。原型直接读取该源码，后续源码变化需重新检查。

## 自动检查

| 检查                       | 结果                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------- |
| 原型构建                   | 通过，生成 `dist/index.html` 与资源。JS 约 959 kB、gzip 约 293 kB，存在 Vite 大块提示 |
| 原型独立类型检查           | 通过，包含原型及所导入真实 UI 的类型                                                  |
| 原型 Vitest                | 2 文件、10 测试通过；覆盖快照、失败重试、保存 CAS、迁移及网络/API 隔离                |
| 原型 lint                  | 0 警告、0 错误                                                                        |
| 原型格式检查               | 通过                                                                                  |
| 根目录 `bun run typecheck` | 7 包通过，有既有 Effect 建议诊断                                                      |
| 根目录 `bun run lint`      | 退出 0；742 个既有警告，原型局部检查为 0                                              |
| 根目录 `bun run fmt:check` | 未通过，以下 7 个本轮未修改文件存在格式问题                                           |

全仓库格式失败项：

- `context/PROJECT_CONTEXT.md`
- `docs/global-mcp-management-architecture.md`
- `docs/linx-product-design-v2.md`
- `docs/local-mcp-discovery-acceptance.md`
- `docs/prototypes/local-mcp-discovery-v1/index.html`
- `docs/workbench-acceptance-2026-10-02.md`
- `workbench/WB-00-baseline.md`

未为消除全仓库失败而改动这些文件。没有运行全量业务测试、数据库迁移或平台进程检查：本轮没有相应生产链路变更。

所有检查使用仓库锁定的 Node 24.13.1 / Bun 1.4.2。原型实际加载 Vite 8.1.5 / Vitest 4.1.10。

## 浏览器验证

在 Codex 内置浏览器实际操作，验证了以下流程：

- Space 设置保存成功；项目继承内容可展开、只读，入口能返回 Space 修改。
- 编辑区离开保护：取消后草稿保留。普通聊天发送不触发未保存配置弹窗。
- 单次保存失败保留草稿；版本冲突同时显示最新值和草稿，明确选择后重新以最新版本保存。
- 首次发送固定已保存配置。更改项目源配置后，原对话仍显示 `snapshot-demo-1`、原哈希及原目标。
- 新对话显示最新 Space / Project 字段，支持 Codex / Pi 演示。Claude 的非空 Context 选择被明确拒绝。
- 首次加载失败后，原用户消息保留；修改源配置再重试仍为 `snapshot-demo-2` / `84b23367`，加载代次从 1 到 2，没有重复用户消息或回复。
- 初始当前项目迁移未处理时发送按钮禁用。明确批次归属后，空配置导入、相同内容核对、不同版本分别选择；处理完成后可首次发送。
- 旧对话继续工作，不补入新 Context。其他无迁移项目未被全局阻断；Void 项目只显示一层。
- 浅色 / 深色、11px / 18px 字号、390×844 窄屏布局；导航、聊天、设置和 Context 详情可操作，没有横向溢出。
- 真实图标编辑器用方向键切换并保存；Esc 关闭 Context 后返回 Context 按钮，关闭 Space 设置后返回 Space 按钮。
- 修复移动导航中的迁移焦点问题，关闭迁移弹窗后返回“展开导航”按钮。
- 最终页面控制区显示业务请求拦截数 0；浏览器 error 日志为空。隔离测试另验证意外业务请求会报错，未连接真实业务后端。

## 复用与新增

复用真实的 SpaceSwitcher、SpaceEditorDialog、ChatComposerFooter、SettingsPanelPrimitives、useExpertDraftGuard、主题与字号纯函数，以及现有基础控件。展开使用真实 Collapsible / disclosureMotion。

新增的是独立页面框架、ContextEditor、ContextDetails、MigrationDialog 和内存适配器；没有现成的 Context V1 表单可直接使用，因此以现有控件组合。没有复制基础组件、重写动画或修改正式路由/API。

## 交付限制

浏览器交互和演示状态通过；真实配置持久化、原生 Provider 注入、恢复、fork/handoff 及生产迁移均留待正式接入。没有强制改变系统的 reduced-motion 设置，动画沿用既有组件支持。未验证其他操作系统或浏览器。

原型可用于审核。全仓库格式门禁的既有失败已单独列明，不能将本轮报告理解为整个仓库所有检查通过。
