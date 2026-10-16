# MCP 交互与授权调整验收

日期：2026-10-15 至 2026-10-16。状态：功能实现与验收完成；全部工作区已执行，整体门禁保留两项桌面 Beta 安装失败，不宣称全绿。

## 目标与范围

- 本机导入取消结果页，以 toast 区分成功、部分失败、失败和刷新失败；成功项不重复导入。
- 专家按 MCP 连接选择，自动加载全部工具；统一草稿保存，不显示逐工具配置。
- `toolMode` 缺失保留旧白名单；新配置用 `all`，旧配置仅在明确应用 MCP 选择后升级。
- 新任务首次启动持久化有效工具范围；恢复和重连不扩大范围，后续新任务可见新增工具。
- 不更新日用数据库，不推送、打包、安装或发布，不改变 Provider/model 选择。

## 源码与环境

- 实施入口：本地 `main`，基线 `7e25e023d147ac8bac630139822e13d5c1c676a4`；交付为该 HEAD 上的未提交 diff（包括新增测试），没有提交或推送。
- 改动的源码与测试文件内容指纹（27 文件，SHA-256）：`6f9267fa15e480ac803394b76212c52d5e0304055fa2459bbc9efde6231d8509`。文档不纳入指纹。
- 工具链：使用仓库锁定 Node 24.13.1 / Bun 1.4.2，锁文件保持原样。
- 隔离预览 home：`/private/tmp/synara-mcp-ui-20261015`。开发启动器 dry-run 已确认 server 15913 / web 17873；日用 5733 不复用。

## 检查与证据

- 导入组件浏览器回归：7 项通过，覆盖成功、部分成功、扫描过期、刷新失败、请求拒绝、跳过和提交期间锁定。
- 设置页浏览器回归：4 文件 / 41 项通过，覆盖专家添加／取消／保存、旧权限保留、全部工具模式、全局管理及导入反馈。
- 前端定向单元测试：4 文件 / 25 项通过，包括字体守卫。
- 最终服务端定向测试：6 文件 / 75 项通过；包含 MCP 全部工具授权、真实本地 HTTP 分页列举与第二页调用、恢复、累计超时预算、重复游标拒绝、首分页输出校验和任务工具调用保护、引用扫描及 Pi 模型发现。契约整包最终为 186 项通过（包含新增的 2 项）。
- 2026-10-16 最终格式、lint（0 errors）及 7 个 workspace 类型检查通过；保留 lint warnings 和既有 Effect suggestions。契约包 ESM/CJS 与类型声明完整构建通过，修复声明生成 TS7056；158 个 feature RPC 的成员与顺序保持一致。
- UI 复用现有 Dialog、SearchInput、Checkbox、SettingsListRow、SettingsSectionShell 与按钮；连接选择逻辑在原专家连接组件中调整，未另建通用控件体系。
- 独立审查覆盖契约、服务端授权与持久化、导入反馈、专家／全局设置及任务说明。发现的引用扫描兼容和分页／元数据校验问题已修复并补回归，复核无剩余实质性问题；10 月 16 日追加审查了 RPC 类型声明修复和单调时钟累计超时预算，同样无剩余发现。
- 全仓首轮 `bun run test`：脚本工作区 10 项超时，导致其他工作区提前中断，不记为完整通过。降低并发后脚本 355 项全部通过。
- 一次串行重试因统一追加的 `maxWorkers` 与服务端脚本已有参数重复而提前终止；已改用 `VITEST_MAX_WORKERS=1`，没有修改测试断言或超时。
- 后续串行运行的服务端为 6564 通过 / 3 失败 / 26 跳过：两项累计超时测试在实现写入期间加载了旧模块；另一项 Pi 测试受继承的 `ANTHROPIC_AUTH_TOKEN` 影响。冻结代码并仅从测试进程移除此变量后，75 项定向复验全部通过；生产环境变量未修改。
- 2026-10-16 完整入口再次运行：桌面包 1315 通过 / 2 失败 / 6 跳过。失败均在 `betaChannel.test.ts`：macOS 安装后启动选择了本机 `/Applications/Synara Beta.app`；模拟安装失败返回成功。与仓库已有验收记录一致，本轮未修改桌面安装逻辑。
- 其余全部工作区串行补全已通过：`VITEST_MAX_WORKERS=1 bun run test --concurrency=1 --env-mode=loose --continue=always --filter=!@synara/desktop`。桌面已完整执行，未跳过其失败断言；全仓不能报告全绿。
- 相同冻结源码的分工作区汇总：Web 4095 通过 / 3 跳过；Server 6567 通过 / 26 跳过；Shared 828 通过 / 1 跳过；Scripts 355 通过；Contracts 186 通过；Desktop 1315 通过 / 2 失败 / 6 跳过。合计 13346 通过 / 2 失败 / 36 跳过。补全命令退出码为 0，桌面完整入口退出码为 1。
- 隔离浏览器实测：专家添加弹窗显示两条测试连接，选中一条、应用后只显示该连接，底部统一保存成功（v1 → v2）；没有逐工具读取／选择操作。测试连接为本地临时配置，未调用真实外部账户。
- 2026-10-16 恢复最新源码预览后，再次从服务端读到专家 v2 和已保存的单条连接；契约 dev watcher 类型声明构建完成。
- 截图：[专家 MCP 简化后页面](/Users/wangyuelin/.codex/visualizations/2026/10/15/01a13f5d-d561-7431-8b52-7e12d48d0752/expert-mcp-after.jpg)。

## 验证边界

浏览器回归中的导入 API 使用 mock RPC；专家保存与重读另有隔离产品实例验证。MCP 连接与网关通过真实本地 HTTP 夹具验证，不等于真实 Provider 模型回合。未运行真实模型、远端 MCP、Windows/Linux 产物或签名安装包验收；日用实例与数据库保持原样。

## 检查日志

- 浏览器：`/private/tmp/synara-mcp-browser-final.log`
- 最终服务端定向：`/private/tmp/synara-mcp-server-focused-20261016.log`
- 最终类型、lint、格式：`/private/tmp/synara-mcp-typecheck-20261016.log`、`/private/tmp/synara-mcp-lint-20261016.log`、`/private/tmp/synara-mcp-fmt-20261016.log`
- 契约构建：`/private/tmp/synara-mcp-contract-build-20261016.log`
- 全仓首轮及历史重试：`/private/tmp/synara-mcp-full-test.log`、`/private/tmp/synara-mcp-full-test-serial.log`、`/private/tmp/synara-mcp-full-test-final.log`
- 最终桌面完整结果：`/private/tmp/synara-mcp-full-test-20261016.log`
- 其余工作区完整结果：`/private/tmp/synara-mcp-remaining-workspaces-20261016.log`
- 最新隔离预览：`/private/tmp/synara-mcp-preview-20261016.log`

临时路径仅用于本机追查，不作为可移植发布证据。
