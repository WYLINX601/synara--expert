# WB-00 基线记录

记录日期：2026-09-29（Asia/Shanghai）
状态：已保存可恢复基线并核验所需版本关系；完整上游历史与全部标签尚未补齐，因此 WB-00 仍未完全验收。

## 已保存基线

- 原始 Git 基线：`eaa61eded31b6755d4f30ba8eabc5d905cf817cb`，对应官方 `v0.9.1` peeled commit。
- 专家实现、测试、上下文和验证材料保存在 `3ee130a`（108 个文件）。
- 工作台架构与执行计划保存在 `a7dbaf3`（3 个文件）。此记录建立时 `main` 位于 `a7dbaf3ea060302550b2277a86dfa83cd26cd940`，相对 `origin/main` 本地领先两提交；未推送。
- 初始候选的 111 项均为源码、测试、脚本和设计/证据文档：63 个已跟踪修改、48 个新增文件。文件名/新增内容扫描未发现数据库、运行产物或常见私钥/API token/Bearer 凭据模式。`/Users/me` 与 `/Users/test` 是通用 UI 示例/测试夹具，不含本机用户名。忽略的 `.synara`、`node_modules`、`.turbo` 等未进入提交。

## 上游与版本关系

- `upstream` 已配置为 `https://github.com/Emanuele-web04/synara.git`；`origin` 保持原有 fork 设置。
- 官方 Releases 页面将 `v0.9.2` 标为最新稳定版，`v0.9.3-beta.1` 为预发布版本：[GitHub Releases](https://github.com/Emanuele-web04/synara/releases)。
- `v0.9.1` annotated tag object：`fec57fd608af83eb1416115a23bf788780626c97`；peeled commit：`eaa61eded31b6755d4f30ba8eabc5d905cf817cb`。
- `v0.9.2` commit：`a33435c18474eb7816582004e45f87382965ac8d`，比 `v0.9.1` 多 22 个提交；`v0.9.1` 是其祖先。`v0.9.2` 也是 `upstream/main` 的祖先。
- `upstream/main` 当前观察到 `ec3b1f6ef9c2f656f26dd9711339fe1265d8cb5c`。`merge-base(main, upstream/main)` 和 `merge-base(main, v0.9.2)` 均为 `eaa61eded31b6755d4f30ba8eabc5d905cf817cb`。
- `workbench/upstream.lock.json` 固定当前已集成基线 `v0.9.1` 与尚未集成的稳定候选 `v0.9.2`；锁定候选不代表已合并或已验证可安装。
- 完整历史 fetch 在 HTTP/2 传输中失败（`curl 92 ... CANCEL`，随后 `early EOF`）。改用 HTTP/1.1 定向获取 `upstream/main` 深度 100 及 `v0.9.1`、`v0.9.2` 两个 tag 后成功。仓库仍是浅克隆（`git rev-parse --is-shallow-repository` 为 `true`）；本地仅补到验证这些 refs 所需的历史，没有取得其余全部发布标签。完整历史应在后续联网窗口重试。

## 迁移 lineage

- 官方 `v0.9.2` 迁移目录最高编号为 `108_GatewayCompletions.ts`。当前专家实现新增 `109_ProjectionThreadsExpertBinding.ts` 与 `110_ExpertAppliedRuntimeRecords.ts`；它们是本 fork 的专家扩展，官方版本中不存在。WB-02 必须将其迁移记录归属与官方 tracker 拆开，再进行升级演练。
- `bun run migrations:check` 通过：已发布的 `v0.9.1..v0.9.2` 迁移保持原始 `(id, name)`。此检查仅审查仓库与标签，不连接任何 SQLite 数据库。

## 工具链与运行实例

- `.mise.toml` 固定 Node `24.13.1`、Bun `1.4.2`；`mise exec -- node --version` 与 `mise exec -- bun --version` 均匹配。裸 PATH 返回 Node `22.23.1`、Bun `1.4.0`，后续仓库验证需使用 `mise exec --`。Git 为 `2.50.1`。
- 只用 `ps`、`lsof` 检查进程、监听端口和已打开文件句柄，没有读取数据库内容。
- 检查时安装版 `/Applications/Synara.app` 正在运行，后端监听 `127.0.0.1:58460`，活动数据位于 `~/.synara/userdata/state.sqlite`（另有 WAL）。
- 当前仓库 dev server 监听 `127.0.0.1:3773`，dev web 监听 `[::1]:5733`；dev 数据位于 `~/.synara/dev/state.sqlite`（另有 WAL）。
- 上述两个数据目录属于正在运行的实例；不得打开、重置、迁移或作为测试数据源。此阶段没有启动或停止任何 Synara 实例，也没有直接打开 SQLite。

## 基线检查

| 检查 | 结果 |
| --- | --- |
| `mise exec -- bun run fmt:check` | 通过，3,960 个文件 |
| `mise exec -- bun run lint` | 通过，0 errors；有 742 warnings |
| `mise exec -- bun run typecheck` | 通过，7 个 workspace 包；有 Effect 建议诊断，无类型错误 |
| `mise exec -- bun run migrations:check` | 通过，v0.9.1 到 v0.9.2 的发布迁移身份一致 |
| `mise exec -- bun run windows-runtime:check` | 通过，检查 269 个应用源码文件；这不是 Windows 实机验收 |
| 专家相关 focused Vitest | 23 个文件通过：server 18 个文件 877 passed / 1 skipped，web 4 个文件 145 passed，contracts 1 个文件 10 passed |
| `mise exec -- bun run test` | 全量并行测试退出码 1：Turbo 4/6 个任务通过；desktop 有 100 passed、2 skipped、2 failed。`backendShutdown.posix.integration.test.ts` 缺少临时 `signals.log`；`browserUsePipeServer.test.ts` 的 8 MiB frame 用例超过 5 秒。两项单独重跑均通过（分别 1 passed，以及 1 passed / 14 skipped），说明失败对并行负载/时序敏感；全量套件仍按失败记录。 |

## 平台缺口与下一步

- 本次主机是 macOS。计划引用的既有专家记录包含 macOS 运行证据；Linux 和 Windows 的真实安装、启动、隔离、升级/恢复仍待实测。静态 Windows 边界检查不能替代 Windows 实机验证。
- WB-00 尚缺完整 Git 历史及全部发布标签；后续以 HTTP/1.1 重试完整 fetch。WB-01/WB-02 可使用锁定的 v0.9.2 SHA 继续准备隔离候选，但在 WB-02 明确迁移归属并完成恢复验证前，不得据此宣称升级完成。
