# 专家与 MCP 审核修复验收

日期：2026-10-18。来源：用户确认审核修复方案并要求实施。

## 源码与交付边界

- 基线：`9bceb21ddb7570affae013bd8657ffcc32096176`，实施分支 `codex/expert-mcp-reliability`，交付为该基线上的未提交 diff；没有提交或推送。
- 受检源码及配置：22 个变更文件（含新增 hook 与测试，不含 Markdown），合并 SHA-256 为 `4a7b1dfb52c5fc710a4ce9760c8598c2812ec5c5a6d36aaa06c1980184c8ba89`；逐文件指纹保存在下方日志目录的 `source-fingerprint.json`。其余输入为上述基线；文档结果回写不改变该指纹。
- 范围：六类 Expert/MCP 缺陷、主 CI 阻塞，以及连接操作状态、受限 JSON 序列化和运行记录失败清理三处职责收拢。官网截图回归不在本轮范围。
- UI 授权仅覆盖已确认的异步错目标与迟到回调修复，沿用原布局、文案和控件；复用原草稿保护、查询缓存、私有原子写入与 Provider 停止边界。
- 公共 RPC、工具媒体联合类型和数据库 schema 不变。新快照增加可选执行位元数据；旧任务授权不扩大，旧快照不自动修复。旧错误占位符凭证需重新导入，历史超限文件不自动改写或隐藏。
- 使用仓库锁定 Node 24.13.1 / Bun 1.4.2；不访问日用数据库，不安装、签名或发布。

## 检查记录

| 检查                            | 实际结果                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 全局 MCP 设置与侧边栏浏览器回归 | 2 文件、34 项通过，覆盖 A/B、A→B→A、迟到保存/授权/错误、重复确认、版本冲突、卸载和新版状态缓存保护        |
| 迁移检查                        | 固定上游来源、冻结 111 与 92 个 HEAD 祖先发布标签通过；未比较无关分支标签                                 |
| Windows 静态边界                | 314 个应用源文件、117 个边界文件、4 个依赖补丁和 9 个 workspace manifest 通过                             |
| 功能模块边界                    | 42 个源文件通过，新操作 hook 已纳入接入清单扫描；不代表传递依赖或运行时隔离                               |
| CI 契约                         | 15 项通过；未触发远端 workflow                                                                            |
| 最终格式、Lint、类型            | 根目录 `fmt:check`、`lint`、`typecheck` 通过；Lint 为 0 errors、990 warnings，7 个 workspace 类型检查通过 |
| 完整测试                        | 六个 workspace 全部完成，17,499 项通过、39 项跳过、0 失败，退出码 0；无测试结果缓存命中                   |

最终完整测试逐包结果：

| Workspace    |  通过 | 跳过 | 失败 |
| ------------ | ----: | ---: | ---: |
| Scripts      |   431 |    0 |    0 |
| Server / CLI | 8,805 |   28 |    0 |
| Shared       | 1,110 |    2 |    0 |
| Web          | 5,492 |    3 |    0 |
| Contracts    |   217 |    0 |    0 |
| Desktop      | 1,444 |    6 |    0 |

独立审查发现并修复两处边界：迟到状态响应覆盖同连接新版缓存、快照执行位在公开后才设置。前者增加单调版本缓存更新与回归；后者在暂存阶段完成资源权限与同步，并在真实重命名后、根目录收紧前验证快照可读取。macOS 要求可写的暂存根目录参与重命名，因此仅根目录在公开后收紧，资源执行位不再于公开后改变。

首轮完整测试与其他重检查并行时，未改动的 `macAppIcon.native.test.ts` 超过原有 5 秒时限并使其余 workspace 提前中断，该轮不记为完整通过。单独复验 1 项通过（418 ms），最终完整复跑中也通过，没有改动断言、跳过测试或放宽时限。最终命令为 `env -u ANTHROPIC_AUTH_TOKEN VITEST_MAX_WORKERS=1 bun run test --concurrency=1 --env-mode=loose --continue=always`，通过仓库锁定工具链执行，耗时 16m25.696s；只限制测试并发并取消测试子进程的凭证继承，生产环境与 Provider/model 配置未改。

独立审查及后续新审查覆盖 UI/存储、Gateway/快照、CI/生命周期及发布顺序修复；最终无剩余实质发现。新文档链接、命令入口、接入清单与完整 diff 已核对。

## 本机证据

日志目录：`/Users/wangyuelin/.codex/task-artifacts/expert-mcp-reliability-2026-10-18/`。

- `source-fingerprint.json`、`test-summary.json`：源码输入与逐包测试汇总。
- `fmt-final.log`、`lint-final.log`、`typecheck-final.log`：最终质量检查。
- `full-test-serial.log`、`browser.log`、`boundaries-final.log`：完整测试、浏览器、迁移/平台/模块边界与 CI 契约。
- `full-test.log`、`mac-icon-retry.log`：保留首轮超时与单独复验，不改写旧结果。

这些路径用于本机追查，不作为安装包或远端 CI 的验收证据。

## 运行与限制

浏览器回归使用 mock RPC。真实本地 MCP 验证使用临时目录和官方 SDK HTTP 服务，通过生产 `connectExpertMcp` 与 Gateway handler 调用交付完整嵌入资源正文和链接信息；POSIX 快照脚本也实际执行成功。这些结果不等于真实 Provider 模型回合或第三方远端服务成功。Windows 执行位兼容分支的自动化检查不代替 Windows 安装包实测。未运行真实模型、第三方远端 MCP、远端 CI、用户数据库迁移、安装或发布。
