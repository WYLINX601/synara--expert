# Synara Workbench 验收快照

日期：2026-10-02

## 当前进度（2026-10-03）

本节记录当前 source `aeffdc63623d7cf4c535141a71889f29dcbf0d5f` 的进度。Source 68、294 与 source 61 小节保留为各自 SHA 绑定的历史快照；后续 source 38 的验收结论、失败记录与档案哈希保持 2026-10-02 原样，不代表当前 HEAD、PR 正文或 workbench 状态。

### 已合入 main 的候选：source ae

- 候选为 canonical 分支 `codex/sync-v0-9-2-a33435c1` 上的 source `aeffdc63623d7cf4c535141a71889f29dcbf0d5f`，parent 为 source `68f73f820ed5cc0a99819fedd7f5c99468f70d80`，worktree clean；绑定基础 ref `refs/heads/codex/workbench-foundation` / `b608f0c17fcbc69ee7735cb6bd3d82d9e4d6801b`，官方目标 `v0.9.2` / `a33435c18474eb7816582004e45f87382965ac8d`。该提交只修复正式验收 runner 错误判定与对应测试；source 68 的 `tests` 曾以 exit 0 同时报 `runnerError=ETIMEDOUT`，该历史 passed 结论已被 root 拒绝，保留在下节，不重写。
- 两 flavor 诊断构建与完整 payload 已接受：`workbench` [builder summary](/private/tmp/synara-workbench-final-aeffdc63623d/reports/builder-diagnostic-summary.json)，SHA-256 `86eee8aa7487b54d3e7313bbee7962ad0bd13bd87224f916ad41147236d01f10`；`workbench-preview` [builder summary](/private/tmp/synara-workbench-final-aeffdc63623d/reports/builder-preview-summary.json)，SHA-256 `d0d5cefde78d3bcd672a5fdae492f613de251532f6a612568ee53b410074800a`。Root 接受的 [payload authority](/private/tmp/synara-workbench-final-aeffdc63623d/reports/diagnostic-payload-authority.json) SHA-256 为 `7419c010997841202432e342e80ef50d75c6f037d7492f8d5579b77d9250bf45`，包含 42 个实际文件引用（含归档的 CUA 输入）。[Payload comparison](/private/tmp/synara-workbench-final-aeffdc63623d/reports/payload-comparison.json) SHA-256 `b61d485874b81d6d228d3f41e13dd5b4713fbf6e8346c6b4df2fc07df21a3009`：两个包均与构建输出零差异，server 2,642 文件 / 38,865,665 bytes，web 2,619 文件 / 32,088,966 bytes。它们是本地诊断包，不表示签名或发布。
- Source ae 稳定 package artifact 归档：[artifact index](/Users/wangyuelin/.codex/workbench-artifacts/aeffdc63623d-20261003/index.json)，5,490 bytes，SHA-256 `24e4ceff963bc00082e323f82038a07dbaa02079c2023e6ca2b95ba9c59d4d47`。
- 本机三应用共存已通过：[coexistence report](/private/tmp/waen/coexistence-report.json)，SHA-256 `fe03e65152a4099cbcc48aafcb39229d12b6738605c1976b5d4a69841a45cb5d`；[nested package report](/private/tmp/waen/two-pack-run/report.json)，SHA-256 `7dbfb841bb82558a6e221f53575881e854f452be422f23dbe835c2420086d2f6`。原版与两 Workbench 应用使用独立 homes/profiles/后端端口；两个 Workbench updater override 未设置，bridge 均为 disabled/null；原版安装的 plist、executable 与 app.asar 前后哈希一致，owned 进程组和双栈端口清理通过。
- 三个合成迁移/恢复场景均通过；Electron restore 执行成功，备份与可执行文件 / ASAR 校验匹配。[Migration rehearsal report](/private/tmp/workbench-migration-aeffdc-electron/rehearsal/rehearsal-report.json)，SHA-256 `bb5211465c60eadabc6cfff8c303b543609aac4dff71ca97154f27ecd3e3e89f`。这是合成恢复证据，不是用户数据库升级。
- source ae 一次隔离真实 runtime 验收 8/8 passed；10 项 [runtime evidence binding](/private/tmp/workbench-final-binding-aeffdc-20261003/runtime-evidence.json) 已接受，SHA-256 `71f5238f6b5698b45a48ee543150356cb7461a47cf98fde3355e81548eb4fe7d`。安全 [supervisor report](/private/tmp/workbench-runtime-supervisor/runs/live-aeffdc-codex-luna-local/supervisor-report.json) SHA-256 `f7001a8db94587de4ca8d9e73d72dd08159e818f91ebd5033e90c9e5a83f912b`；[probe report](/private/tmp/workbench-runtime-supervisor/runs/live-aeffdc-codex-luna-local/probe-output/report.json) SHA-256 `6681508805d3995f434675229d82c4d99a3bb8e734ae3321022d91238571fc79`。包含两 provider 普通/Expert 首轮、取消、MCP、会话隔离，以及真实受控服务重启后的恢复；staged auth 文件已删除，owned 进程组退出且双栈端口空闲。该 supervisor 记录 `provenanceIndependentlyVerified=false`，仅为与冻结 source HEAD 匹配的 caller attestation；payload authority 是单独核验的证据。
- source ae 唯一正式六项 verify 已终态通过：原生 CLI session `15041` exit 0；[verification index](/Users/wangyuelin/synara-expert/.git/workbench-sync/verification-logs/aeffdc63623d7cf4c535141a71889f29dcbf0d5f/c8bafed4-4cff-4c3c-a854-6d6e3ee1aaa0/index.json)，SHA-256 `71df28e224076d5dc2fd37d004321d8148c9217bcb4a820cbf7b7167c859cf40`，六项 `format`、`lint`、`typecheck`、`tests`、`migrations`、`windows-runtime` 均 passed / exit 0，无 `runnerError`。六个 workspace 合计 13,189 tests passed、36 个既有 skip。[最终 workbench state](/Users/wangyuelin/synara-expert/.git/workbench-sync/state.json) 为 9,400 bytes，SHA-256 `3b82ea779e9e5261bf8a2681770ec297e1b3602c8c0c8e1918b43d30551cfbd6`，状态 `ready`、runtime evidence 10 项。Root 接受 WB-00 至 WB-04 在声明的 macOS arm64 本机隔离范围内 READY，M1/M2 为该本地范围通过；不表示生产发布或跨平台通过。
- Source ae 稳定 evidence 归档：[evidence index](/Users/wangyuelin/.codex/workbench-evidence/aeffdc63623d-20261003/index.json)，18,366 bytes，SHA-256 `0be13106030b4d6dd3cf62ba27a33be95d9abe066d9b9ae1d49fd8bc80b55364`；[archive status](/Users/wangyuelin/.codex/workbench-evidence/aeffdc63623d-20261003/status.json)，1,598 bytes，SHA-256 `e06cb9118a50c569cadacee30cbea9f393f8d3915ab45a166dbddddf24554d16`。索引绑定 source ae、base `b608f0c17fcbc69ee7735cb6bd3d82d9e4d6801b` 与 parent source 68。
- PR #1 已合并到 GitHub `main`：merge commit `61df29b094d3e5f2877f7787613655220a4f72a2`，父提交为旧 main `eaa61eded31b6755d4f30ba8eabc5d905cf817cb` 与 source ae；merge tree 与 source ae tree `575932958a3df1f8406a7defaaf49348d17caff9` 相同。PR 状态为 closed/merged，正文保持用户批准的版本。source ae exact-head CI 的 24/24 项全部通过：CI `37095476336`、Marketing `37095476365`、PR Size `37095474364`、PR Vouch `37095474564`。合并后 `main` push 触发的五个 Actions workflow 也均成功。
- 用户已决定暂不继续同步官方上游当前稳定版。因此本轮不推进 `workbench/upstream.lock.json`，不手动触发上游同步，也不把 no-update 写成 CAS 通过。锁文件仍记 `integratedBase=v0.9.1` / `eaa61…`，候选 v0.9.2 状态为 `not-yet-integrated`；这一记录保持原样，待用户恢复上游同步时再处理。
- 周同步 workflow 已存在于 `main`，schedule 为每周六 10:30（Asia/Shanghai），用户确认保持启用。10 月 3 日的 schedule 时点在本次合并前已过；GitHub 当前尚无该 workflow 的运行记录，下一次 scheduled run 为 2026-10-10 10:30（Asia/Shanghai）。由于锁文件仍把 v0.9.2 视为待集成版本，该周任务可能会选择它作为候选；本轮没有手动触发。WB-06 延期。诊断包未签名或发布；没有生产安装、用户数据库访问/升级，也没有 Linux/Windows 实测。
### Source 68 历史快照（source ae 绑定前）

本节保留 source 68 首轮正式门禁失败时的记录；后续提交 source ae 增加了 runner-error 门禁修复，不会改写 source 68 当时的失败结果。

Source 68 稳定 package artifact 归档：[artifact index](/Users/wangyuelin/.codex/workbench-artifacts/68f73f820ed5-20261003/index.json)，5,477 bytes，SHA-256 `c6064cdce6a1d1b4ed8956cd52b3543303a78afa789c18b35eb80bc9dd365120`。

- canonical 分支 `codex/sync-v0-9-2-a33435c1` 在该历史时点指向 source `68f73f820ed5cc0a99819fedd7f5c99468f70d80`，parent 为 source `294385921e14a4317832b092ef44144ab52d197f`。该提交只改 `apps/web/src/components/ChatView.browser.tsx` 的测试导航：auto-advance 变体等待下一题 Choice 出现，manual/custom 变体继续点击 `Next question`。产品 200 ms 自动推进、提交/重试/恢复断言、性能阈值、timeout 与 skip 均未改。当前 checkout 有未提交的验收工具改动 `scripts/lib/workbench-sync/workflow.ts` 与 `scripts/workbench-sync-workflow.test.ts`；它们不属于 source 68 提交或 PR head，也未计入该候选的验收。
- 锁定环境下的目标浏览器用例报告三个变体均通过（3/3），Node `24.13.1` / Bun `1.4.2`；过滤后 105 个其它测试跳过。日志：[target-test-escalated.log](/private/tmp/wb-browser-294385-target-evidence-20261003/target-test-escalated.log)，SHA-256 `2030fc2e80c82bd6941ef3038701380927851a906fdbba378d0a22706ab6310e`。执行包装器未保留外层 exit code，不将其报告为捕获到的 exit 0。
- source 68 的 PR #1 exact-head CI 已终态：24/24 success、0 failure、0 pending。工作流 run IDs：CI `37051338315`、Validate marketing site `37051338443`、PR Size `37051332528`、PR Vouch `37051332550`。
- 两个 source 68 诊断包构建器均成功：`workbench` 的 [builder summary](/private/tmp/synara-workbench-final-68f73f820ed5/reports/builder-diagnostic-summary.json)，SHA-256 `f5d9bf3ff1e1a3722ff75cb1900b9cfd2d2c2cfc5150772442e06f4c5b4a2662`；`workbench-preview` 的 [builder summary](/private/tmp/synara-workbench-final-68f73f820ed5/reports/builder-preview-summary.json)，SHA-256 `f96e666c8613e2e5d0efa87c83d181f7e8c4013e70ab9fb45727699df7383936`。Root 已接受两 flavor 完整 payload 零差异：[payload authority](/private/tmp/synara-workbench-final-68f73f820ed5/reports/diagnostic-payload-authority.json)，SHA-256 `4b10788bceeb5bc7d23f20306ec35f3ed70abe84a8263ad3e553a6057f4ea574`；[payload comparison](/private/tmp/synara-workbench-final-68f73f820ed5/reports/payload-comparison.json)，SHA-256 `2963d5e52a3afe60d7d4a7ccd5ce8474938ec096eed4db3106f99052a5212340`。这些是本地诊断包证据，不代表签名或发布。
- 正式 verify 运行前的 workbench raw state SHA 为 `6276a7034c448de7812fd3cd544a4b0ae9340b996fb49df5803e6b7afae6c143`，绑定 source 68，状态 `awaiting-verification`，`invalidations: []`，操作锁 `unlocked`，工具链 Node `24.13.1` / Bun `1.4.2`。verify 后当前 raw state SHA 为 `5a012255d902e8b8ee5706e83555fcef6317a60a1c46488c1e729abe96a744fe`，状态 `checks-failed` / stage `automatic-checks`。运行前只读 `status` 记录：[status-mise.console.log](/private/tmp/workbench-final-binding-68f73f-20261003/status-mise.console.log)，SHA-256 `60cb10c8a7d8d0f2409e4b69589966748035a1cd20e69bf06d07a92b52bb39f2`。
- Root 已接受 source 68 本机三应用共存与两 flavor Workbench updater unset 检查：[coexistence report](/private/tmp/w68n/coexistence-report.json)，SHA-256 `061ec38801c2ccef8ba265a2f3f6121bdf87cecb7bf41e2cef426919f5e2c121`；[nested package run report](/private/tmp/w68n/two-pack-run/report.json)，SHA-256 `9e5bb60b9f8cb09c249fac64495e119385587ddb21c395806f3e3a0bf0e58f42`。三种合成恢复场景均通过：[migration rehearsal report](/private/tmp/workbench-migration-68f73f-electron/rehearsal/rehearsal-report.json)，SHA-256 `0d19c9f43c13fba6c2af10098c83e584039a11e8364f9ea4ab17bc8a824bb4ff`；真实 Electron restore CLI exit 0，ledger 未被误写，备份校验一致。
- source 68 的十项 runtime evidence binding 已接受，10/10：前八项为一次隔离真实 Provider/Product runtime 检查，后两项绑定上述 native coexistence 与 synthetic migration 证据。绑定文件 [runtime-evidence.json](/private/tmp/workbench-final-binding-68f73f-20261003/runtime-evidence.json)，SHA-256 `65866741a7a669b0c3337fcf63b668b904119122260832b193483148cff5564a`；安全 supervisor 报告 [supervisor-report.redacted.json](/private/tmp/workbench-runtime-supervisor/runs/live-68f73f-codex-luna-local/supervisor-report.redacted.json)，SHA-256 `ac97e85701b5af40c3e6fef21d234db4ed5408dfb120ade2130bd8dadb571324`。仅此 source 的一次账户尝试，八项均通过；隔离 staging 凭据已清理、受控进程组已退出、双栈端口空闲。没有读取或写入用户数据库。
- 首轮正式六项门禁 index [index.json](/Users/wangyuelin/synara-expert/.git/workbench-sync/verification-logs/68f73f820ed5cc0a99819fedd7f5c99468f70d80/22ada02f-bfdd-4025-8c6b-26eeb0723f13/index.json)，SHA-256 `a02471f864e6dc9c34de3f49dbd3af9e7b1ac51c6f45b0da4ec01244d41882df`：`typecheck` exit 1，原因为 marketing 生成的 `collections` / `server` 模块缺失；`tests` 同时被记录为 passed / exit 0，但该 index 还包含 `runnerError=ETIMEDOUT`，对应 [tests.runner-error.log](/Users/wangyuelin/synara-expert/.git/workbench-sync/verification-logs/68f73f820ed5cc0a99819fedd7f5c99468f70d80/22ada02f-bfdd-4025-8c6b-26eeb0723f13/tests.runner-error.log)，SHA-256 `73c67e806351452facd4f0b2b1aa57f6798f490e89d566bee49e593639c0c0eb`。root 不接受这项 tests 通过结论。原生 CLI session `43031` 已确认 exit 1；当前 status 为 `checks-failed` / stage `automatic-checks`，raw state SHA `5a012255d902e8b8ee5706e83555fcef6317a60a1c46488c1e729abe96a744fe`。首轮失败逐字节留档目录为 `/private/tmp/workbench-final-binding-68f73f-20261003/formal-attempt-22ada02f-bfdd-4025-8c6b-26eeb0723f13`（actual-attempt record SHA-256 `749fd5f5353ffde83602c39104592290c2b0f9ecf2db362078e6bbb6f2c62eaf`；residual-check SHA-256 `81929d104f7b58ffd22206ac72a291b445d41136f74006546eabd3e83c364ca5`）。修复尚未提交，尚未重试，正式六项门禁未通过；source 68 不标记为 `ready`，也不继承 source 38 或 source 61 的 runtime/native 结论。
- PR #1 的 head 为 source 68，base 为远端 `main` `eaa61eded31b6755d4f30ba8eabc5d905cf817cb`，PR open、non-draft、unmerged；以上 24/24 CI 结果与 PR 正文刷新是两件事。针对此前正文的 REST PATCH 在执行前被自动审批审查拒绝，因为 transcript 不包含该精确正文 payload 与 GitHub 目标的可信用户授权；远端正文最后读取时 SHA-256 为旧值 `c8e68d696b7874b669d9e4a1f4790ea54e856230ee125eabad342c3052b80822`，后续更正仍未发布。详情见 [publication report](/private/tmp/workbench-publication-68f73f-20261003/publication-report.json)，SHA-256 `2d090338e7cf8b2e592dfbc39b5e1a73426d497992204ed4d786918447cc69e6`。不通过其他路径绕过该拒绝。

### Source 294 历史快照（source 68 更新前）

以下记录保留 source 294 曾为候选时的 CI、工具链与状态结论；其中“当前”均指该历史快照时点，不代表现在的 canonical HEAD、PR head、workbench raw state 或 CI。

- canonical 分支 `codex/sync-v0-9-2-a33435c1` 在该历史快照时指向 source `294385921e14a4317832b092ef44144ab52d197f`，parent 为 `61b058dbf44ce352f3709a97180a1553fc63f68d`，候选 worktree clean。该提交只改 CI 工具链来源与对应合约测试/说明：共享 setup action 严格读取 `.mise.toml` 中 Node `24.13.1`、Bun `1.4.2`，不再从 `package.json` engine range 选择版本。产品行为与 browser 性能阈值未改。

- 本地锁定环境验证通过：CI contract 16/16、`workbench-sync-workflow.test.ts` 19/19，Node `24.13.1` / Bun `1.4.2`。日志分别为 [node-contracts.log](/private/tmp/workbench-ci-repair-61b058-locked-runs-ls7eietz/node-contracts.log)，SHA-256 `084bb20e6af8fdedc806ba678e9badbbdfe0e906dd7eb2213dbb94de8a4fc76b`，及 [workbench-sync-workflow.log](/private/tmp/workbench-ci-repair-61b058-locked-runs-ls7eietz/workbench-sync-workflow.log)，SHA-256 `136a997d246263969234cab891e6d95e4086464f6867d1dd19f28dbaddb8a081`。提交 diff 与已验证 patch 字节一致，SHA-256 `80a3f0cdacbded2bed01825cf0bb8326b2f4c35930dae7fd3f6d2d36d9fe3ee8`。
- 当前 workbench raw state 仍绑定 source `61b058dbf44ce352f3709a97180a1553fc63f68d`，source 294 尚未 rebind，也不能标记为 `ready`。包、真实 Provider 与 full-six gate 仍 pending；不得把 source 61 的 runtime/native 结果继承给 source 294。
- source 294 已使用 expected-old SHA `61b058dbf44ce352f3709a97180a1553fc63f68d` 的 CAS lease，将 PR 分支 `codex/workbench-ready-38f9ef8` 快进至 `294385921e14a4317832b092ef44144ab52d197f`。PR #1 为 open、non-draft、unmerged，base `main`=`eaa61eded31b6755d4f30ba8eabc5d905cf817cb`，head 精确为 source 294，远端显示 1000 changed files。CI 已终态：24 项中 22 success、2 failure、0 pending。`Unit Tests (core)` 与 `Browser Tests (chat-workflows 1/1)` 成功；失败项为聚合 `Format, Lint, Typecheck, Test, Browser Test, Build` 及 `Browser Tests (chat-projects 1/1)`。CI 整体未通过。
- `chat-projects` 失败用例为 `ChatView transcript geometry (full app) > preserves three answers (auto-advance) on transient failure and restores expired questions without sending a message`。GitHub annotation 指向 `ChatView.browser.tsx:2347` 的 `Next question` locator click，88,273 ms 后超时：locator 初次可见/启用/稳定，随后导航容器拦截 pointer events，重试时按钮变为 disabled。源码分析（root 根因判断）：`UserInputQuestionForm.tsx:65-74` 在单选后安排 200 ms auto-advance；测试在 `ChatView.browser.tsx:2345-2347` 随即手动点击 `Next question`，两条推进路径可能竞争并使点击目标状态变化。原 annotation 只证明点击超时与状态变化，不能单独证明该竞态为根因。在 source 294 快照时该失败尚未修复/验证；后续 source 68 对测试导航做了最小修正，auto-advance/manual/custom 三变体 targeted test 均通过（见上方当前候选），但这不能替代整个 `chat-projects` suite 的 CI 结果。

### Source 61 历史诊断与冻结档案

source `61b058dbf44ce352f3709a97180a1553fc63f68d` 的两个诊断构建、完整 payload、本机三 app 共存短 root 验证及三种合成 restore 演练通过；真实账户调用为 0，full-six gate 未运行。其远端 CI 中 fetch 与 migration lineage 修复通过；Core 有 7 项失败，job 实际 Node `24.21.0` 与锁定 `24.13.1` 不一致；Browser Test 在 near-cap workload、short React commit duration 场景测得 ratio `1.624069479`（无单位，阈值 `1.6`），因此该历史 job 失败并保留。source 294 的 pin 修复已推送且 Core job 通过，但远端 CI 仍有上述两个终态失败，不能改写 source 61 这段历史或声称 source 294 已整体通过。

root 已核实并冻结 source 61 档案的 48 个 archive refs 与 metadata。制品索引为 [artifact index](/Users/wangyuelin/.codex/workbench-artifacts/61b058dbf44c-20261003/index.json)，7618 bytes，SHA-256 `e5603be00bb09ea1aa8360f4f49bef274e8b473f32d0899530620217bf985cd6`；证据索引为 [evidence index](/Users/wangyuelin/.codex/workbench-evidence/61b058dbf44c-20261003/index.json)，20584 bytes，SHA-256 `8b7896f7d5ede3ab7ef2699f2f4a8a6d13931febeebfc08db96c4d48e5281f5c`。两份 [artifact status](/Users/wangyuelin/.codex/workbench-artifacts/61b058dbf44c-20261003/status.json) 与 [evidence status](/Users/wangyuelin/.codex/workbench-evidence/61b058dbf44c-20261003/status.json) 均为 3043 bytes，SHA-256 `5e82796619c29224a1ce64b3a1ef1562670d1633b365119abf53de8dc39076f9`。这些是 source 61 历史快照，不声明当前 HEAD 或 worktree 状态。

### Source 68 验收范围与后续门槛（历史快照）

以下范围与“修复未提交”“workbench 当前为 checks-failed”等状态均记录 source 68 首轮验收时点，不代表当前 source ae。正文中的历史证据和结论保持原样。

- source 68 已接受 exact-source CI 24/24、两 flavor payload 零差异、三应用共存与 updater 状态、三种合成恢复，以及 10/10 runtime evidence binding；这些证据仍不替代正式六项门禁。首轮 run `22ada02f-bfdd-4025-8c6b-26eeb0723f13` 的 [index](/Users/wangyuelin/synara-expert/.git/workbench-sync/verification-logs/68f73f820ed5cc0a99819fedd7f5c99468f70d80/22ada02f-bfdd-4025-8c6b-26eeb0723f13/index.json) 记录 `typecheck` failed，且 `tests` 的 passed / exit 0 与 `runnerError=ETIMEDOUT` 同时存在，root 不接受该 tests 通过结论；原生 CLI session `43031` exit 1，当前 status 为 `checks-failed` / stage `automatic-checks`。修复未提交，也尚未重试。workbench 当前为 `checks-failed`，因此本页不将 source 68 标记为 `ready`，也不声明 source 68 的 M1/M2 完成。source 38 的 M1/M2 与 `ready` 结论仅属于其历史快照，不转移到 source 68。
- 本地 `main` 仍为 `8e5c12b963e3dd143837aa751e1749b5b55f5d73`；远端默认 `main` 历史只读值为 `eaa61eded31b6755d4f30ba8eabc5d905cf817cb`。本轮没有 promote/merge。
- M3 的真实 manual CAS 与独立 scheduled run 仍 pending；WB-06 仍 deferred。诊断包没有签名或发布；没有生产安装、用户数据升级或跨平台实测，也未触及用户数据库。PR 正文未远端更新；被拒绝的 PATCH 不会通过其他路径绕过。

## Source 38 最终结论（历史验收快照）

root 已接受候选 SHA `38f9ef8103e670c55ed2d30ea6bb4a7514526733` 在 **WB-00 至 WB-04 本机/隔离范围**的最终状态为 `ready`。M1（WB-00—WB-03 安全演进）与 M2（WB-04 官方更新后的原生/Expert 链路在所声明 macOS arm64 隔离范围内应用并验证）均为本地范围通过。该结论不表示候选已合入 `main`、正式安装或生产升级。WB-05 状态仅为本地 fixture 通过、远端验收待完成；M3 的真实 manual CAS publish 与独立 scheduled run 均 pending，WB-06 deferred。

## Source 38 固定来源与 refs（历史快照）

- 候选源：`codex/sync-v0-9-2-a33435c1`，SHA `38f9ef8103e670c55ed2d30ea6bb4a7514526733`，source worktree clean。
- Workbench 基线：`codex/workbench-foundation`，SHA `b608f0c17fcbc69ee7735cb6bd3d82d9e4d6801b`。
- 官方目标：`v0.9.2`，SHA `a33435c18474eb7816582004e45f87382965ac8d`。
- 原 checkout 本地 `main`：`8e5c12b963e3dd143837aa751e1749b5b55f5d73`，本轮未改。
- GitHub API 只读核实的远端默认 `main`（截至 `2026-10-02T11:46:09Z`）：`eaa61eded31b6755d4f30ba8eabc5d905cf817cb`。这不是从本地 tracking ref 推断。见 [remote read-only report](/Users/wangyuelin/.codex/workbench-evidence/38f9ef8103e6-20261002/remote-readonly/report.json)，SHA-256 `129615a170e5891e31593be3ca255f6ab1f8a42d0d2bf085570ee8b01fa26312`。截至该报告时间，默认 `main` 上未发现 WB weekly workflow，报告窗口内匹配 workflow runs 为 0。
- `bun.lock`、`.mise.toml`、`workbench/upstream.lock.json` 三项锁定输入未改；upstream lock 仍为 `integratedBase=v0.9.1` / `eaa61…`、`not-yet-integrated`。

## Source 38 十项 runtime 验收（历史快照）

十个必需 runtime check 均绑定源 SHA `38f9ef8…`，10/10 passed。前八项为隔离真实 Provider/Product runtime；本轮 Codex 使用 `gpt-6-luna/high`，Pi 使用 `openai-codex/gpt-5.6-sol/medium`，未因此修改全局模型设置。最终绑定文件为 [runtime-evidence.json](/Users/wangyuelin/.codex/workbench-evidence/38f9ef8103e6-20261002/verification/final-runtime-binding/binding/runtime-evidence.json)，SHA-256 `aab3fbbc78cba395e229b63f8e380a6292ffa58f9fcbc384969eee8f77b9630f`。

| 必需 ID | 本轮范围 | 结果与边界 |
|---|---|---|
| `codex-ordinary-first-turn` | Codex 普通产品会话首轮 | passed；见 [live report](/Users/wangyuelin/.codex/workbench-evidence/38f9ef8103e6-20261002/runtime/live-report.json)，SHA-256 `a3ac2157ed90e384c518ee64986746a3780aa595b8eb8f7a6f846b81d6ffd2d1`。|
| `codex-expert-first-turn` | Codex Expert 产品会话首轮 | passed；与普通会话分别记录。|
| `pi-ordinary-first-turn` | Pi 普通产品会话首轮 | passed；隔离 provider profile。|
| `pi-expert-first-turn` | Pi Expert 产品会话首轮 | passed；与普通会话分别记录。|
| `recovery` | 受控服务重启后的产品恢复 | passed；只操作本轮拥有的实例。见 [supervisor report](/Users/wangyuelin/.codex/workbench-evidence/38f9ef8103e6-20261002/runtime/supervisor-report.json)，SHA-256 `3fcef7d6f72019bc0ba6b09b9ca6d557c8b8840670dc777dd611ca9f21b400c2`。|
| `cancellation` | Provider turn 与等待工具取消 | passed；见 live report。|
| `mcp` | MCP 往返 | passed；见 live report。|
| `session-isolation` | Synara 产品 session/persona 隔离 | passed；此为产品层 session/persona 证据，不代表 Codex/Pi 原生 provider session ID 不同。|
| `packaged-identity` | 两 flavor bundle/plist 身份、原版共存及 updater bridge 状态 | passed；见 [native coexistence report](/Users/wangyuelin/.codex/workbench-evidence/38f9ef8103e6-20261002/native/coexistence-report.json)，SHA-256 `3ac82fed42fc54b0a47cbb135c8fe32290a99448e5650f48796b76665790c786`。|
| `migration-restore` | 三种合成 SQLite 迁移/恢复情景 | passed；见 [migration report](/Users/wangyuelin/.codex/workbench-evidence/38f9ef8103e6-20261002/migration/rehearsal-report.json)，SHA-256 `809031887745aad0ee99b1cd7f5a228e7ee7bd028b5fb9e9365a96c6b74d770e`。|

## 六项正式门禁与保留的运行历史

六项固定门禁为 `fmt:check`、`lint`、`typecheck`、`bun run test`、`migrations:check`、`windows-runtime:check`。早期 83ae run 六项通过，作为历史记录保留：[83ae historical index](/Users/wangyuelin/.codex/workbench-evidence/38f9ef8103e6-20261002/verification/formal-six-gate/index.json)，SHA-256 `38b30da23dc84cbdc422f73723914d7e176fbf111696a218766c76f926817fcc`。

两次失败均单独保留，且明确排除在最终通过之外：

- 第一轮 `a6cde23f-d06a-4695-bb19-36ee9cf3369a`：五项通过，全量 tests 失败并报告 13 项 desktop test failures。见 [a6cde failed index](/Users/wangyuelin/.codex/workbench-evidence/38f9ef8103e6-20261002/verification/failed-runtime-binding-a6cde/index.json)，SHA-256 `bdce89ea5ab9c3adf81dbad1cdbc2fe066e4dc9c6eafbc34eb3ab73ffcb280c0`。
- 第二轮 `2378d503-7513-43c9-95d0-d819c874417b`：五项通过；`scripts/workbench-build.test.ts` 的 Workbench 参数化 fixture 在默认 5 秒超时内未完成，1 项 test 失败，后续 workspace 未执行。见 [2378 failed index](/Users/wangyuelin/.codex/workbench-evidence/38f9ef8103e6-20261002/verification/failed-runtime-binding-2378d503/index.json)，SHA-256 `487e6a82e5b87faefd289ec77772e3a43e40ab1b8b6fffa4c09470784571c00e`。

最终第三轮 `1c2d10a1-befd-4e25-be3b-0314129ba94e` 六项全部通过，root 接受 status `ready`。见 [final runtime-binding index](/Users/wangyuelin/.codex/workbench-evidence/38f9ef8103e6-20261002/verification/final-runtime-binding/index.json)，SHA-256 `6a6e2cfad0a7ce0aa5d7ed9ae20d63f7287acf64f31392b60a8ecafecf768729`，4625 bytes。全量测试汇总为 13,189 passed、36 个既有 skip，六个 workspace 均执行；root 独立核对 12 份本轮日志的 hash、size 与 `0600` 权限。

- 操作者配置：[turbo.json](/Users/wangyuelin/.codex/workbench-evidence/38f9ef8103e6-20261002/verification/final-runtime-binding/operator/turbo.json)，SHA-256 `933127f3d3a70de263cf76ed38309fb78cedeeed12ef1061503620f7180399c4`。采用 `TURBO_ENV_MODE=strict`、`TURBO_CONCURRENCY=1`、`VITEST_MAX_WORKERS=1`；私有 Turbo 配置相对源配置只增加 `globalPassThroughEnv`，源配置 SHA-256 `30a18212748bc7b7c417012b05fef8ec932ce5af50e1804eade782bee842b090`。 候选源码、测试清单、测试超时及 runner 未修改；调整仅为本机操作者的并发配置。
- 执行摘要：[safe-summary.json](/Users/wangyuelin/.codex/workbench-evidence/38f9ef8103e6-20261002/verification/final-runtime-binding/execution/safe-summary.json)，SHA-256 `3f1e2be710230ba6cecb613d8002f655337804f7339bc0a0f5b091a63d43779a`。

前两轮并行调度期间记录了资源相关观察：锁定 Turbo 2.10.5 在 `TURBO_CONCURRENCY=0` dry run 返回 reject，`=1` dry run 成功生成完整 graph；当时记录为 10 CPU、16 GB 内存和 9.5 GiB swap。这些观察支持采用串行调度，但不能证明资源是前两轮失败的唯一成因。根报告与 operator mechanism 诊断分别见 [resource report](/Users/wangyuelin/.codex/workbench-evidence/38f9ef8103e6-20261002/resource-scheduling/report.json)（SHA-256 `186a75baee83465e04d276d1de6a8367a0c92909713b4e73e29f95d9eeb2d4a1`）和 [operator mechanism report](/Users/wangyuelin/.codex/workbench-evidence/38f9ef8103e6-20261002/resource-scheduling/operator-mechanism/operator-mechanism-report.json)（SHA-256 `40d4f7e37df7373cee1edb1dc841c61a748eece785f566d1f915ed295f7334d8`）。

## WB-01：macOS arm64 诊断包与身份共存

Workbench `0.1.0` 与 Preview `0.1.0-preview.1` 均绑定候选 SHA。打包 authority：[packaged-payload-authority.json](/Users/wangyuelin/.codex/workbench-evidence/38f9ef8103e6-20261002/authority/packaged-payload-authority.json)，SHA-256 `9421cff876b756afe3688168f9c824f3eb5141ed188c33b5e2f417e91de5f598`。manifest：[Workbench](/Users/wangyuelin/.codex/workbench-artifacts/38f9ef8103e6-20261002/workbench/workbench-build-manifest.json)，SHA-256 `1d6742f4c0044a400fb85c3306dcc31ee252c0ca2e870c787a5453f7d0ab7645`；[Preview](/Users/wangyuelin/.codex/workbench-artifacts/38f9ef8103e6-20261002/preview/workbench-build-manifest.json)，SHA-256 `8a5bcb3b6c0e5deb6696639549f282f66043bff826e420de7440272493754970`。独立 artifact archive index：[archive-index.json](/Users/wangyuelin/.codex/workbench-artifacts/38f9ef8103e6-20261002/archive-index.json)，SHA-256 `e2c6416d8b093104522f3757708ee9d1fdcaee611777eba2b89223adbe844503`。

- bundle ID / scheme：Workbench `com.wylinx.workbench` / `workbench://`；Preview `com.wylinx.workbench.preview` / `workbench-preview://`。与已安装原版 `com.emanueledipietro.synara` 共存检查通过，三 app 使用独立 profile/data home；本轮自有进程组清理完成，IPv4/IPv6 listener 释放。
- updater 环境变量 unset 时，两个 Workbench updater bridge 均报告 `enabled=false`、`status=disabled`、`releaseUrl=null`。原版 updater 未读取，不能据此声称其 updater policy 已验证。
- 两包是本机 macOS arm64 诊断构建；packager 使用 ad-hoc local signing，无 Developer ID 签名、notarization、正式安装或发布。构建使用外部 `Assets.car` 输入，不能据此声称源码可复现 release provenance。
- 两 flavor 的 server/web payload 与冻结 workspace 0 diff。执行路径证据在 [authority execution summary](/Users/wangyuelin/.codex/workbench-evidence/38f9ef8103e6-20261002/authority/execution-summary.json)，SHA-256 `4be7f8137b9bf3b49296008e66e9042bb676fe7c98241430b3cdb4c6987e22ae`；归档 launcher/helper copies 是证据留存，不表示任务从归档副本路径执行。

## WB-02：合成迁移与恢复

三种隔离合成 SQLite 演练均通过，未打开或改动用户数据库：

1. 接管旧 110 行后，官方 high-water 为 108、Workbench ledger 记录 1/2，业务数据保留。
2. 在 durable snapshot 后注入失败，使用同一个 backup 重试成功。
3. 以 Workbench Electron 43.4.1、`ELECTRON_RUN_AS_NODE=1` 执行打包 restore CLI：恢复为旧 110 行；Workbench ledger 表不存在；业务数据恢复，SQLite integrity 为 `ok`，backup 不变。

报告：[rehearsal-report.json](/Users/wangyuelin/.codex/workbench-evidence/38f9ef8103e6-20261002/migration/rehearsal-report.json)，SHA-256 `809031887745aad0ee99b1cd7f5a228e7ee7bd028b5fb9e9365a96c6b74d770e`；[synthetic-rehearsal.log](/Users/wangyuelin/.codex/workbench-evidence/38f9ef8103e6-20261002/migration/synthetic-rehearsal.log)，SHA-256 `36941192f49c8e0a3f6a864359626e94e9c88f6ea4de864006a0ce5c64093d32`。归档 runner helper 为 [runner.electron-as-node.mjs](/Users/wangyuelin/.codex/workbench-evidence/38f9ef8103e6-20261002/helpers/migration/runner.electron-as-node.mjs)，SHA-256 `a081461cf30d1ab9ead2b3b2ca0adb4c61cb80640ecd566211e20cd092f04632`。迁移执行方式以本节 rehearsal report 与日志为准；前两项使用锁定 Bun，第三项使用打包 Electron 的 Node mode。

这些演练只证明声明的合成 SQLite scope；它们不是正常 Electron 启动迁移或用户实例生产升级测试，也不涉及真实 Provider 数据库。

## WB-05：本地 fixture 通过，远端验收 pending

本轮 WB-05 milestone 状态为 `local-fixture-passed-remote-acceptance-pending`，只通过本地 synthetic Git fixture：`mise exec -- bun run .github/scripts/workbench-weekly.test.mjs`，Node `24.13.1` / Bun `1.4.2`，exit 0。覆盖 full-history fetch、worktree identity、cross-job bundle import 与真实 sync bind、CAS create/advance、race preservation。日志：[wb05-workbench-weekly.test.log](/Users/wangyuelin/.codex/workbench-evidence/38f9ef8103e6-20261002/weekly/wb05-workbench-weekly.test.log)，SHA-256 `57596ebbc0d283ae3915f4dbf4f626afb2c206f0edb351048c8fc3fb0e395905`。

先前 remote read-only report 的核验窗口内，远端 workflow runs 为 0；该历史观察不包含本页候选 PR 触发的 CI。真实 GitHub CAS publish 与独立 scheduled run 仍未实测，M3 继续 pending，因此 WB-05 不能写成整体完成。WB-06 deferred。

## 里程碑与范围

- **M1：accepted-local-scope。** 定义为 WB-00—WB-03 safe evolution；source ae 已在声明范围内验证并随 PR #1 合入 `main`。
- **M2：accepted-local-scope。** 定义为 WB-04 官方更新后的 native/Expert 链路在声明的隔离 macOS arm64 范围内应用并验证；不代表生产发布或跨平台验证。
- **M3：pending。** PR exact-head CI 与合并后 main push workflow 均通过。用户暂缓手动同步官方当前稳定版；因此本轮不更新 `integratedBase`、不执行 manual dispatch。CAS 与实际 scheduled sync 验收尚未完成；workflow 保持启用并按周运行。
- **WB-06：deferred。**

本页记录本机隔离证据与 GitHub 集成证据。source ae 已合入 `main`，但尚未正式安装，未做生产迁移或跨平台验证；没有用户数据库被打开或更改。这些限制不改写 M1/M2 已接受的声明范围。

## Source 38 远端 WB-05 后续步骤（历史快照）

1. **已完成。** 本轮获人类授权后，只读复核固定候选、本地 refs 与远端默认 `main`；远端 `main` 为 `eaa61eded31b6755d4f30ba8eabc5d905cf817cb`，候选仍为 `38f9ef8103e670c55ed2d30ea6bb4a7514526733`。
2. **已完成。** 本轮获人类授权后，将固定候选发布到独立分支 `codex/workbench-ready-38f9ef8`，并创建 [PR #1](https://github.com/WYLINX601/synara--expert/pull/1)。PR 当前 open、non-draft、unmerged；base 为远端 `main`，head 为候选 SHA，包含 64 commits / 998 changed files。
3. **待单独授权。** PR review 与合并均未完成；合并需另行明确授权。合并后若获授权，再进行 `candidate_ref` 留空的 manual weekly dispatch。只有确有待处理更新并发生实际 CAS publish/ref 写入，才算 CAS 验收；无待更新或无写入不能算通过。
4. **待单独授权。** 随后进行一次独立 Saturday 10:30 Asia/Shanghai scheduled run。M3 只有在 manual CAS publish 和独立 scheduled run 均有实际证据后才能更新。

`upstream.lock.json` 的 `integratedBase` 推进是单独记录的基线元数据更新，不由 manual 验收顺带完成；merge wrapper 或未来 lock 元数据提交也不能作为 SHA `38f9ef8103e670c55ed2d30ea6bb4a7514526733` 的 runtime 证据。

本页初始验收形成时，远端发布尚未获授权；本轮后续人类明确授权固定候选 push 与 PR，二者现已完成。PR 尚未合并。合并、workflow dispatch 与生产操作仍需另行授权；本轮未执行这些操作。

## 长期证据归档

- evidence archive index：[archive-index.json](/Users/wangyuelin/.codex/workbench-evidence/38f9ef8103e6-20261002/archive-index.json)，55067 bytes，SHA-256 `f062e76877734ef335b91eb0735c3f421f8d9ff5660beade25288a07550ca739`。
- 状态快照：[status.json](/Users/wangyuelin/.codex/workbench-evidence/38f9ef8103e6-20261002/status.json)，58201 bytes，SHA-256 `0c2c1881b10db80300894010512ac7dd714fc123b2367f120a9d4b1e87f1eacd`。
- package artifacts 另存于 [artifact archive index](/Users/wangyuelin/.codex/workbench-artifacts/38f9ef8103e6-20261002/archive-index.json)，SHA-256 `e2c6416d8b093104522f3757708ee9d1fdcaee611777eba2b89223adbe844503`。
- root 校验了 evidence archive 内 112 个文件的 hash、size、`0600` 权限及目录 `0700`，并核对 status 与最终 runtime binding。归档未包含 auth 文件、用户数据库/sidecar、原始模型内容或 raw Provider/runtime logs，也未复制合成迁移数据库。
- 本页是 source `38f9ef8…` 的补充验收快照，不改写按其他 source SHA 形成的历史 docs 或失败结论；每个历史记录仍按其自身绑定的 SHA 解读。

## Source 38 候选发布记录（历史快照）

只读核验记录时点：2026-10-02 13:59 UTC。

- 本轮人类授权后，固定 source `38f9ef8103e670c55ed2d30ea6bb4a7514526733` 已发布至 `codex/workbench-ready-38f9ef8`；[PR #1](https://github.com/WYLINX601/synara--expert/pull/1) 为 open、non-draft、unmerged，base `main`=`eaa61eded31b6755d4f30ba8eabc5d905cf817cb`，64 commits、998 changed files。
- PR CI 已结束：24 项 checks 中 21 项成功、3 项失败（`Unit Tests (core)`、`Migration Lineage`、CI 聚合 `Format, Lint, Typecheck, Test, BrowserTest, Build`）。CI 聚合失败可能只是下游汇总，不据此推断另一项独立根因；CI 整体未通过。
- `Migration Lineage` 因远端仓库没有 `v*` tag refs，在运行 lineage 程序前由 [ci.yml:400](/Users/wangyuelin/synara-expert/.github/workflows/ci.yml:400) 的 fail-closed guard 以 exit 1 拒绝验收。core job 中，`workbench-sync-workflow.test.ts` 有 8 项失败；首个失败用例 `rejects a locked release target that diverges from the integrated base during bind` 在第 323 行报告 `git fetch failed (128)`（helper 第 43 行）。其余 7 项状态/检查数断言失败；job 日志未给出底层 fetch stderr，故该错误的进一步根因未诊断。
- M3 仍 pending：尚未完成真实 manual CAS publish 或独立 scheduled run。root 将另行处理 CI 如何获取官方 tag；本轮未推 tag、未 merge、未 dispatch、未执行生产操作。
