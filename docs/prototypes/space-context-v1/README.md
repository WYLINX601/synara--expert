# Synara Space / Project Context V1.1 独立原型

这是用于评审最小增量前端交互的独立 React / Vite 演示壳。它沿用现有 Sidebar、Space、Project、Environment、Space 编辑弹窗和 Chat「＋」菜单的行为边界；不声称完整 Sidebar / ChatView 接入，也不证明生产服务端或 Provider 能力已经实现。

本地预览：<http://127.0.0.1:17736/>。先运行前端服务，再用浏览器打开。

## 启动与构建

从 Synara 主仓库根目录执行：

```sh
mise exec -- bun run --cwd docs/prototypes/space-context-v1 dev
```

命令使用仓库锁定的 Node 24.13.1 / Bun 1.4.2，只启动原型前端，并在 `127.0.0.1:17736` 监听；端口占用时会直接失败。用启动终端的 `Ctrl+C` 停止服务。

当前机器使用忽略的 `ui-source.local.json` 指向候选 UI 工作区。换机器时可用环境变量或该本地配置指定现有 UI 源码目录：

```sh
SYNARA_UI_SOURCE_ROOT=/absolute/path/to/synara-ui-checkout mise exec -- bun run --cwd docs/prototypes/space-context-v1 dev
```

源码目录需有 `apps/web/src/components/SpaceSwitcher.tsx`、已安装的前端依赖及本轮共享 UI 可选扩展。扩展基线与补丁见[验收记录](./acceptance.md)；更换源码后先运行类型检查确认兼容。未配置时尝试主仓库，所需组件缺失会明确报错。本原型不复制或另装 UI 组件。

可按需运行局部检查或构建：

```sh
mise exec -- bun run --cwd docs/prototypes/space-context-v1 typecheck
mise exec -- bun run --cwd docs/prototypes/space-context-v1 test
mise exec -- bun run --cwd docs/prototypes/space-context-v1 build
mise exec -- bun run --cwd docs/prototypes/space-context-v1 preview
```

构建输出写入忽略的 `dist/`。`preview` 用于展示构建后的产物，和 dev 一样使用 `127.0.0.1:17736` 且严格占用端口；先停止另一个服务，避免端口冲突。

## 审核路径

1. 通过原有 Sidebar Space 切换器选择 Space，使用已有 Space 编辑弹窗查看名称、图标、目标和指令的组合编辑。新建仍只有名称与图标；Void 不显示 Context。
2. 在 Space 下选择普通 Project，打开原聊天 Environment 面板。查看默认折叠的只读 Space 继承内容，以及 Project 目标和原 Project instructions。
3. 从 Chat 的「＋」菜单按需打开 Context 详情。常态不保留 Context chip、计数、更新横幅或 legacy Notes 横幅。
4. 如需检查主题、字号、失败或冲突，再展开审核工具。提供方通过原输入区选择控件演示，绑定后保持固定；此处选择不启动真实 Provider。
5. 有旧指令样本时，仅从相关 Project 进入迁移流程，检查工作区归属与结果反馈。

本轮最新实际验收和截图见[验收记录](./acceptance.md)与[视觉和交互 QA](./design-qa.md)。V1 旧材料及旧截图索引见[history](./history/README.md)；旧截图不再作为 V1.1 的当前视觉基准。

## 隔离边界

- 页面直接导入现有 Synara UI 控件与主题/字号能力；新增部分只是原型页面组合与 Context 演示内容。
- 独立原型不接入完整生产 Sidebar、ChatView、路由或执行订阅。保存、绑定、snapshot、Provider 与迁移流程仅为演示行为。
- `nativeApi` 和生产 store 使用明确失败的隔离实现；业务网络调用 fail-closed。系统窗口 Hook 使用专用的 unavailable mock，不枚举或捕获真实系统窗口。启动时先安装页面内存 Storage 替身，再动态加载业务组件，不访问浏览器中真实的 Synara 缓存。
- 不调用 Synara 服务端、数据库或真实 Provider；不读写 Synara localStorage 或 Provider 配置。演示状态刷新后可重置。
- 不修改生产 API、`packages/contracts` 或 Provider 执行链。候选 UI 中的 SpaceEditorDialog、EnvironmentProjectInstructionsSection、ComposerExtrasPanel 和草稿保护 Hook 增加可选受控扩展；缺省调用保留原行为。本轮源码差异与基线见验收记录。
- 审核工具默认收起，不让故障或 Provider 演示状态成为普通界面的一部分。

当前产品行为以[Space / Project Context V1.1 PRD](../../space-project-context-v1-interaction-prd.md)为准。正式实现、端到端持久化与 Provider 验收需依据真实服务端证据另行记录。
