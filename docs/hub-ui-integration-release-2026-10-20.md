# Personal Workbench 0.1.2 集成与本机安装

2026-10-20 用户明确要求将 Hub 工作树及「排查并修复前端 UI Bug」的工作树合入 main、推送并安装。范围仅为这两个已确认成果，不包含其他旧工作树或全局 MCP 候选，不创建公开二进制 Release。

## 来源

- 基线 `850de05e08ab9c116c639e7b1cb8145e0b6e05d5`。
- Hub 保存提交 `fea6660de`；输入区 UI 保存提交 `cb4b274db`。
- 冻结构建源 `4c2204427900a2345daf8ba0bdb85198b4ef438e`，tree `59d8d3899d7f7edaa574995f65af95eeb02b06f9`。合并仅处理 ChatView 的专家查询位置，并以纯函数保存占位提示回退；独立复核发现并修复了原输入区改动导致的 React Compiler bailout，编译守卫 48 项通过。保留诊断失败与修复日志，没有放宽守卫。
- 授权 UI：统一 Project/Hub 导航、参与专家、关键产物视图与固定引用，以及菜单实色背景、输入框内专家提示、去除正常可用状态；其他详细规则仍由专项方案负责。
- 仅 `workbench/build-config.json` 日用版本 0.1.1 → 0.1.2；Preview 和官方 package versions、Provider CLI/账号/模型设置不变。

## 检查与范围

冻结源的格式、lint、类型、迁移 lineage、Workbench 边界检查全部通过；完整 `bun run test --concurrency=2 --env-mode=loose` 重跑 **17,663 通过 / 39 原有跳过 / 0 失败**，6/6 tasks、0 cached，704.971 秒，前后 HEAD/tree/clean 状态一致。服务端 8,913、前端 5,537、桌面 1,444、共享 1,114、脚本 432、契约 223。测试子进程仅移除继承的 `ANTHROPIC_AUTH_TOKEN` 并设置 `VITEST_MAX_WORKERS=1`；未改生产策略。合并组件 browser 113 项与 ChatView 聚焦 5 项通过（其余 233 项未被过滤器选中）；编译守卫 48 项通过。原 UI 独立复验曾有一项点击超时，后续当前候选 5 项完整通过；失败证据保留，不把旧复验改写为全绿。

第一次完整测试与打包并行时，原有 `cuaDriverHost` 的 held-input 清理用例超过 1 秒请求期限，整轮失败且服务端被 Turbo 中止。该文件、驱动和协议源码本轮未改变；停止并行构建后，整个驱动套件单独 157/157 通过，随后重新运行完整工作区套件。无断言修改或新增 skip。首轮日志保留于 `parallel-build-test-attempt/`。

Hub 服务端、契约和共享运行源与 `fea6660de` 相同，原 Hub 验收中的真实 Codex 接受/移除/普通 Worker/恢复证据保留其原来源，不宣称本轮新增模型实测。其他 Provider、远端 MCP 和 Windows/Linux 安装包没有新增验证。

## 产物与数据

macOS arm64 `workbench` 包构建成功，真实打包依赖和隔离启动 smoke、release smoke 以及 strict/deep codesign 检查通过。包内 version/buildVersion 0.1.2、flavor workbench、源码 commit 与冻结源一致。仅本机 ad-hoc 签名，无 Developer ID/公证，provenance 保留 publication disabled/unsigned-build-only，不将本机验证解释为公开发布资格。

复用 0.1.1 已验证的 Cua/图标输入，相关源码、patch、release 定义及锁未变化；输入副本及 SHA-256 重新核对，见 `build-inputs/input-manifest.json`。

在停机且数据库生命周期锁保护下取得日用数据库一致性副本，仅通过 SQLite 启动层演练迁移，不启动 Provider/自动化。83 张旧业务表按原列逐值摘要不变，4 张新 Hub 表为空；native ledger 保持 135，Context 1，Expert 2 → 5，quick_check 通过。实际安装前另取得完整备份，随后新应用启动的原生迁移回执为 `migration-completed`：native 135 保持不变，Context 1、Expert 2 → 5。未从外部并发打开运行中的用户数据库。

## 安装与远端回执

**已合入、推送并安装启动。** main 从 `850de05e0` 快进至两分支合并提交 `4c2204427`，已推送 `origin/main` 并用远端 ref 回读核对；交付文档单独回写，其源码与构建源的差异仅限 Markdown。

| 核对     | 实际结果                                                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本机应用 | `/Applications/Personal Workbench.app`，0.1.2，`com.wylinx.workbench`                                                                                             |
| 安装内容 | app.asar 的 version/buildVersion/flavor/commit 与冻结源匹配；安装后的 asar hash 与受检包一致                                                                      |
| 回退材料 | `private-backup-0.1.1-before-0.1.2/` 保留旧 app、完整 home、Electron profile、一致性 SQLite 和逐文件 manifest；目录 0700                                          |
| 备份验证 | quick_check 通过，备份与停机源库 85 张表 row counts/schema 摘要相同                                                                                               |
| 实际启动 | 新服务持有原 `~/.synara-workbench` 数据库生命周期锁；原 Space/Hub/对话与专家列表实际加载可见，`installed.png`                                                     |
| 配置保留 | 8 项设置/凭据等受保护文件 hash 未变；未更新 Provider CLI 或账号/模型配置                                                                                          |
| 远端 CI  | 代码推送已触发 [CI 39386605234](https://github.com/WYLINX601/synara--expert/actions/runs/39386605234)，核对时仍在运行；不宣称远端通过。本地检查与远端状态分别记录 |

没有创建公开 GitHub 二进制 Release、发布 tag 或安装 Preview/Stable/Beta；仅沿用个人 Workbench 本机通道。其他旧工作树保持原样。两棵原始工作树的未提交文件在集成前已保存 patch、逐文件 hash 与完整文件归档；`main` 的合入前 ref 另保留为 `codex/pre-hub-ui-main-20261020`。

| 产物                               | SHA-256                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| Personal-Workbench-0.1.2-arm64.dmg | `1df97b4f26cc12d391a8dd47517d9977c876b0e5574d618e75b04df65b582a2c` |
| Personal-Workbench-0.1.2-arm64.zip | `93fd13dc7405e138b327020693bbbcd59e8d6181f9d94f777844c7754a9b7def` |

证据目录 `/Users/wangyuelin/.codex/task-artifacts/hub-ui-integration-2026-10-20/`；数据库和备份包含私有资料，只留本机，不上传。
