# Synara Space / Project Context V1 交互原型

用于审核布局和交互的独立 React 页面。直接导入批准的 Synara UI 工作区，数据仅保存在内存，刷新可重置。聊天回复、保存、加载和迁移均为演示行为。

本地预览：<http://127.0.0.1:17736/>。使用浏览器打开，需要先运行前端服务。

## 启动

从 Synara 主仓库根目录执行：

```sh
mise exec -- bun run --cwd docs/prototypes/space-context-v1 dev
```

此命令沿用仓库锁定的 Node 24.13.1 / Bun 1.4.2。只启动原型前端，在 `127.0.0.1:17736` 监听；端口被占用时直接失败。停止服务用启动终端的 `Ctrl+C`。

当前机器已在忽略的 `ui-source.local.json` 中配置候选 UI 路径。换机器时，可以设置环境变量或创建该本地配置：

```sh
SYNARA_UI_SOURCE_ROOT=/absolute/path/to/synara-ui-checkout mise exec -- bun run --cwd docs/prototypes/space-context-v1 dev
```

```json
{
  "sourceRoot": "/absolute/path/to/synara-ui-checkout"
}
```

源码工作区必须已有 `apps/web/src/components/SpaceSwitcher.tsx` 和已安装的前端依赖。不配置时尝试主仓库；缺少所需组件会明确报错。这里不另安装或复制组件依赖。

## 建议审核顺序

1. 打开右上角 **Space 设置**，编辑方向目标和共享指令。点击保存；离开有草稿的编辑区才会询问保存或放弃。
2. 打开 **项目设置**，展开只读继承内容。可以从这里前往 Space 修改，项目专属的目标与指令仍独立编辑。
3. 初始“硕士论文”包含旧指令样本。点击 **处理旧指令**，先确认整批数据属于当前工作区，再选择冲突版本。“文献整理”自动导入空配置，“产品方案”相同内容自动完成核对。
4. 发送消息，点击输入区的 **Context** 查看固定内容。随后修改源配置，返回旧对话验证原快照保留，再从“在新对话中使用”创建新对话。
5. 用 **演示控制** 设置下一次保存失败、版本冲突或加载失败。这些条件只触发一次。失败保留草稿；冲突需要比较；加载失败后的重试使用原快照及原消息。
6. 打开 **旧对话示例**，查看历史模式，并继续发送演示消息。旧对话不补入新 Context，也不清理旧 Notes。
7. 切换主题、11/13/16/18px 字号及窄屏导航。也可切换 Space、项目，创建 Space 并使用现有图标编辑器。

有迁移待认领或待处理的项目，只限制自己的新对话首次发送；已有对话和其他项目继续工作。未归入 Space 的项目只使用项目层 Context。

## 实现与隔离

- 直接导入真实 `SpaceSwitcher`、`SpaceEditorDialog`、`ChatComposerFooter`、设置区域组件，以及 Button / Textarea / Sheet / Dialog / Popover / Tooltip / Collapsible。
- 颜色与字体来自真实 `index.css` 和主题构造函数；字号来自 `getAppTypographyScale`。没有挂载读取服务端设置的 Hook。
- `ContextEditor`、`ContextDetails` 和 `MigrationDialog` 是本原型新增的业务组合，使用上述现有控件。完整 ChatView、生产路由和执行订阅暂未接入。
- `ContextDemoAdapter` 保存四字段、版本、固定快照及独立加载记录；演示哈希仅用于状态比较。原文不自动截断或改写。
- `nativeApi` 导入被替换为明确抛错的隔离入口；网络边界拒绝业务 fetch、WebSocket、XHR、EventSource 和 beacon。允许本地静态资源及 Vite 的开发连接。
- 不调用 Synara 后端、真实 Provider 或数据库，不读写 Synara 的 localStorage 配置，不修改候选 UI 工作区、正式 API 或共享契约。
- Vite 只加载 React 和 Tailwind 插件；不运行生产路由生成、图标裁剪或发布构建插件。运行时生成的路径配置、CSS、缓存和构建产物均被忽略。

## 检查与构建

```sh
mise exec -- bun run --cwd docs/prototypes/space-context-v1 typecheck
mise exec -- bun run --cwd docs/prototypes/space-context-v1 test
mise exec -- bun run --cwd docs/prototypes/space-context-v1 build
```

构建产物在 `dist/`；可用 `preview` 命令在同一端口预览。先停止开发服务，避免端口冲突。

实际检查与截图见 [验收记录](./acceptance-v1.md) 和 [视觉与交互 QA](./design-qa-v1.md)。[组件视觉基准](http://127.0.0.1:17736/?ui-reference=1) 仅用于 QA，直接展示未修改的真实 SpaceEditorDialog。

## 本轮边界

当前交付用于前端审核。“已加载”是演示记录，不能据此判断真实 Provider 已加载或遵循指令。审核通过后，再将组件接入正式配置、快照和执行链路，验证持久化、原生恢复和真实 Provider 行为。

完整页面行为、异常状态和正式接入验收标准见 [Context V1 前端交互 PRD（评审稿）](../../../space-project-context-v1-interaction-prd.md)。
