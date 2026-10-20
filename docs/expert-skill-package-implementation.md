# 专家技能索引与共享版本包：实施与验收记录

## 交付范围

按用户确认的[完整方案](expert-skill-package-design.md)实现共享不可变包、专家入口选择、V2 任务清单、四端统一目录、显式调用、配置界面、版本更新与引用保护删除、BMad 预设和集中切换工具。

候选分支：`codex/feature-expert-skill-packages`；起点：`49ab5dc9cabcead1bb1b489b4b4aec7576c2232a`。改动保留在隔离工作树，未提交、合入、推送、安装或发布。日用数据库、专家定义、账户配置及原技能源目录没有转换或清理。

功能实现、隔离转换及三端真实回合已经完成，最终全仓检查结果见文末。Claude 的现有认证持续返回 HTTP 401，不能报告四端真实模型全部验收。

## 实现与所有权

| 范围       | 实现与边界                                                                                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 资源包     | [SkillPackageStore](../apps/server/src/experts/SkillPackageStore.ts) 保存完整目录、内容寻址、只读发布、完整性复验；来源指针独立存储，任务不解析来源最新版                                                       |
| 专家与任务 | [ExpertStore](../apps/server/src/experts/ExpertStore.ts) 保存包入口选择及 V2 清单；参考资料沿用原快照职责，技能不复制进任务目录                                                                                 |
| 运行       | [目录构建器](../apps/server/src/provider/expertSkillCatalog.ts) 与 ProviderService 在启动、恢复和发送时核验固定快照、包和入口；Codex、Pi、Claude Code、oh-my-pi 使用各自指令通道                                |
| UI         | 复用现有 Settings 父布局、Expert 编辑器、技能选择器和任务详情；增加受管理包导入/更新/删除、启动与按需入口、版本和目录提交状态，无新增顶级页面                                                                   |
| 输入框     | 草稿先保存待绑定的包与入口；首次发送读取服务端接受的任务快照后补齐不可变身份；已有任务从固定快照发现技能                                                                                                        |
| 切换       | [SkillPackageSwitch](../apps/server/src/experts/SkillPackageSwitch.ts) 管理具体预览、摘要、备份与进度；[宿主适配](../apps/server/src/workbench/host/skillPackageSwitchHost.ts) 调用原生停止、Hub 取消及删除能力 |
| 协议与迁移 | WS revision 6；Expert 独立 ledger 新增迁移 6 保存技能目录提交回执；没有改写冻结的原生迁移                                                                                                                       |

接入关系登记于[清单](../workbench/integration-points.json)，依赖扫描覆盖直接依赖与已登记宿主接口，不代表完整运行时隔离。

### 存储、调用和失败规则

- 完整包位于 `<stateDir>/experts/skill-packages/pkg_<sha256>/content/`。哈希覆盖根名称、相对路径、类型、原始字节与可执行标记；来源路径、mtime 和导入时间不参与版本身份。
- 明确选择 `SKILL.md` 时以其所在目录为边界；复杂包选择公共根。内部链接、特殊文件、路径越界、规范化碰撞和超限项拒绝导入，不猜测额外目录、不静默丢弃内容。既有上限为单文件 16 MiB、整包 100 MiB、5,000 条目。
- 导入需服务端预览 token；确认重新读取、比对资源和来源 revision。持久化 pending/complete 回执使来源发布中断后可重入，不重复递增来源版本。更新列出入口及共享资源差异，旧任务仍引用旧包。
- 删除扫描当前定义、保留 revision、全部任务快照（涵盖已接受 Hub 工作）。未知或损坏记录阻止删除。删除日志与隔离目录可恢复中断；来源指针只删除捕获的精确记录，外部源目录不动。重新导入同一内容版本后仍可正常再次删除。
- 专家最多一个 startup 入口；重名入口拒绝保存。未选择入口不进入专家目录；startup 正文加载，其余按需读取原文件。
- 显式调用以快照、包、入口三元组验证，客户端路径不作为授权依据。每入口正文 64 KiB、合并 128 KiB，超限明确失败、不截断。`user-invocable` / `disable-model-invocation` 按策略生效；不支持的执行型 metadata 拒绝，`allowed-tools` 不扩权。
- 四端新链路不产生专家技能插件、额外扫描根或技能目录投影。普通环境技能维持既有行为；环境重名不会替代专家的固定调用身份。
- ProviderService 从磁盘重读固定快照，验证会话身份和内容一致；缺失、损坏或伪造时拒绝启动/恢复/发送，不升级到最新定义。旧格式含技能的任务明确要求完成切换，不维持长期兼容分支。
- `skillApplication` 记录目录、实际配置指令哈希、启动入口、固定版本及 lifecycle generation。此回执证明适配器提交的配置一致，不证明模型执行了每项技能；UI 保留这一区别。
- 包写入、定义/快照发布与删除使用同一 stateDir 的进程内串行队列。所有变更经拥有该 stateDir 的服务端执行，不宣称存在跨进程文件锁。

## 集中切换

[一次性 CLI](../scripts/expert-p0/skill-package-switch.ts) 通过 owner RPC 运行，沿用当前服务端认证和数据归属。先准备明确的专家选择与测试任务/快照白名单 JSON，再依次执行：

```sh
mise exec -- bun scripts/expert-p0/skill-package-switch.ts preview --input /absolute/request.json
mise exec -- bun scripts/expert-p0/skill-package-switch.ts apply --switch-id <returned-id> --digest <returned-digest>
mise exec -- bun scripts/expert-p0/skill-package-switch.ts progress --switch-id <returned-id>
```

认证 WebSocket 地址由当前进程的 `SYNARA_EXPERT_SWITCH_OWNER_URL` 提供；不要把实际 token 写入文档、日志或命令历史。工具不会自行选择日用数据或补全白名单。具体 preview 包含非技能字段摘要、Persona 精确前后值、任务、快照、Hub 工作、投影和引用；目标变化使旧摘要失效。备份完成后才发布新定义，并保存可恢复进度。

原生 `thread.delete` 先标记删除，再由 ThreadDeletionReactor 在停止会话、终端和统计归档完成后清除任务行与事件；若清理或 fence 未完成，软删除行可能保留至后续重试。切换不自行删除事件，也不假设 dispatch 返回即代表引用已消失。预览列为保留的快照采取保守策略，即使宿主随后清除了任务，仍保留这些快照并返回 `complete_with_retained_artifacts`。只有不在保留清单且经读回确认为无引用的旧快照与 Claude 受管理投影可清理；OMP 临时投影仍由原有会话 finalizer 负责。普通任务或无法解释的引用会阻止破坏性清理。

两项隔离演练通过：

- **现有 12 位专家转换**：只读现有定义和显式 SKILL.md 来源，在新 stateDir 经实际包存储、切换 preview/apply 转换 12/12，合计 8 个唯一包。ID、姓名、非技能业务字段和引用路径保持一致；六位 BMad 的 Persona 仅发生已确认桥接句移除。备份与原定义一致，来源集合转换前后 SHA-256 均为 `8386e59caa4623c659e1d36c5c8b68ae92d54a43396a85661a08c6617f227b92`。该场景使用完整但为空的宿主任务清单，不证明原生删除；没有复制参考资料内容、凭据或日用数据库。
- **真实宿主删除与重入**：独立 home / 端口 5391，通过 owner RPC 与 CLI preview/apply/progress 执行。当前创建入口会拒绝旧格式技能，因此旧 V1 绑定只在隔离数据库中以持久化夹具构造；删除通过实际原生命令完成。第一次执行暴露清理读回边界问题，修复后使用同一清单继续成功。再次重启服务端并 replay 完成清单，返回成功，进度完全不变、专家仍为 revision 2、删除记录仍为一项、备份存在。普通任务和项目与创建时摘要一致。目标行与事件由原生删除流程清除，旧 V1 快照按确认清单保守保留。

证据分别为 `.synara/skill-package-checks/existing-experts-conversion/result.json` 和 `switch-isolated-2026-10-20/switch-result.json`。5391 已停止。没有执行日用状态转换。

## BMad

固定来源提交：`61e01f82644c4bb533750cfa0d6d61ab61d2cc9b`。重新核验 SOURCE_LOCK 的 301 个文件；包大小 2,241,151 字节，包 ID：`pkg_68dd77963cede6d24c8715f4ae2fd1fe7221ff5644a9ed1e5c1a7f1d9333e144`。

[本地验收脚本](../scripts/expert-p0/skill-packages-local.ts) 仅向新的隔离目录写入：六角色引用同一包，启动入口分别是 Mary / analyst、John / pm、Sofia / po、Winston / architect、Amelia / dev、Sally / ux-designer；V2 快照均没有技能副本。Persona 只在隔离副本中移除精确匹配的旧桥接路由句，前后差异进入结果，其余内容保留。

六次真实 `uv run _bmad/scripts/resolve_customization.py --skill <fixed-role-path> --project-root <isolated-project> --key agent` 均正常退出并命中相应身份。项目 `_bmad`、定制文件和输出仍归项目；预检读取实际任务 worktree 或项目目录，缺少脚本、配置或 uv 时阻止启动，不安装依赖。

单次本机测量：完整校验及首次导入 249.3 ms；六次快照准备及读取 254.0–273.4 ms。该测量含文件系统缓存且非性能基准，不推导提升比例。确定的结构结果是包只保存一份、任务不复制包、上下文不预载所有按需工作流。

Codex / `gpt-6-luna` 已逐一完成六角色真实回合，分别核验角色名称、固定启动入口和两项官方解析脚本的工具证据。Mary 的显式 `bmad-prfaq` 回合读取概念输入、官方工作流和模板，并在项目 `_bmad-output/prfaq-campus-study-rooms/` 写入 11,930 字节 PRFAQ 及 2,369 字节摘要。随后从实际运行 stateDir 重读并校验整个包，301 文件 / 2,241,151 字节保持完整。

初轮验收提示错误地给出另一个同版本夹具的模板路径，且拼接读取中另有文件缺失，不能作为最终模板读取证明。保留初轮证据后，在同一固定任务中纠正提示，要求独立 `cat` 实际运行包内的 `bmad-prfaq/assets/prfaq-template.md`；新轮次命令退出 0、工具输出包含模板原文，两个项目文件均在新请求后重新生成。没有修改项目配置或官方资源以使验收通过。最终证据位于 `apps/server/.synara/skill-package-checks/bmad-live-run-6/result.json`、`template-followup-result.json` 和 `mary-prfaq-live-template.json`。

## 真实 Provider 验收

全部使用独立 home、工作区、owner token 和端口 5387；现有 Provider、模型与认证选择保持不变。凭据只在受限隔离目录临时复制，证据不含凭据值。

[真实验收脚本](../scripts/expert-p0/skill-packages-live.ts) 创建随机 Persona、启动角色共享资源、按需工作流资源。用户提示不包含资源 token；正确答案须结合工具读取。每轮等待不同 turn ID、该请求时间之后的新轮次和当前轮次已落盘的非 streaming assistant 消息，恢复要求新 lifecycle generation。取消用真实等待子进程验证退出。

| Provider / 已有模型                   | Runtime                    | 首次、显式调用、停止恢复、取消                              |
| ------------------------------------- | -------------------------- | ----------------------------------------------------------- |
| Codex / `gpt-6-luna`                  | `0.162.0`                  | 通过                                                        |
| Pi / `openai-codex/gpt-5.6-sol`       | `0.87.1`                   | 通过，导入源删除后执行                                      |
| oh-my-pi / `openai-codex/gpt-6.1-sol` | `18.12.1`                  | 通过，导入源删除后执行                                      |
| Claude Code / `claude-sonnet-5`       | `2.1.92`（仅启动配置回执） | **认证阻塞**：现有账户请求重试持续 HTTP 401，已停止隔离会话 |

本机各一次首轮请求至目录回执耗时：Codex 5.173 s、Pi 0.338 s、oh-my-pi 4.406 s。计时包含原生启动和本机准备，不是纯模型响应耗时，也不用于 Provider 性能排名。

Claude 的目录提交回执已落盘（`live-claude-3/submission-receipt.json`），这只证明启动配置已提交，不能替代因认证失败而缺失的模型行为证据。

三端又在实际重启隔离服务端进程后复验：同一任务、快照、包和目录哈希保持一致，新的轮次重新读取资源并产生新的 lifecycle generation。三端此时都已删除导入源。证据分别为上述结果目录中的 `server-restart-result.json` 与 `server-restart-thread.json`。

本地原始证据保留于工作树 `.synara/skill-package-checks/`：`final-codex/`、`final-pi-settled/`、`final-omp-settled/`、`live-claude-3/final-thread.json`、`bmad-local-2/`。较早轮次的投影等待条件不足，已作废；不与修正后的结果混合计数。完成后已停止 5387 / 5391 隔离服务，并移除临时复制的 Provider home 与 owner token；原始账户与日用状态未变。

## 检查与未验证范围

最终检查日期：2026-10-21（Asia/Shanghai）。工具链：Node 24.13.1 / Bun 1.4.2，未更改依赖锁文件。

完整命令 `VITEST_MAX_WORKERS=1 mise exec -- bun run test --concurrency=1 --continue=always` 退出 0，6 个工作区全部成功、无缓存，耗时 15 分 17 秒：

| 工作区       |       通过 |   跳过 |
| ------------ | ---------: | -----: |
| shared       |      1,114 |      2 |
| desktop      |      1,444 |      6 |
| server / CLI |      9,000 |     29 |
| web          |      5,548 |      3 |
| contracts    |        245 |      0 |
| scripts      |        435 |      0 |
| **合计**     | **17,786** | **40** |

受影响浏览器测试另有 38 项通过：专家设置 21、包设置 4、技能发现 12，以及 ChatView 首次发送绑定已接受快照 1 项；最后一项为聚焦运行，239 项中另 238 项被筛选，未计为通过。

最终静态检查：`fmt:check` 通过；`lint` 通过（1,037 条警告、0 错误，服务端同步文件系统预算通过），`typecheck` 7 个工作区全部通过；迁移检查覆盖 92 个发布 tag，Workbench 边界检查覆盖 64 个源文件；Windows 边界静态检查覆盖 318 个应用源文件、119 个边界文件、4 个依赖补丁和 9 个 workspace manifest。`git diff --check` 通过，方案与本记录的本地链接均存在。

最终源码输入 SHA-256：`363771c50f7c4efc5a62ad923f77b6e89be4caca929c5fec371c691339bda24c`。基于上述起点，按路径排序汇总全部变更/新增的非 Markdown 文件及 `.mise.toml`、`bun.lock`、`package.json`，共 97 个输入；逐项摘要与算法输入保存在 `.synara/skill-package-checks/final-source-inputs.json`。该摘要标识未提交候选的检查输入，不是 Git 提交或已发布版本。

原始完整日志为 `.synara/skill-package-checks/full-suite-final.log`，最终静态日志为同目录 `*-completion.log`，浏览器结果为 `browser-final.log` 及 `chat-first-send-browser-completion.log`。所有原始证据留在本机隔离工作树，不随源码发布。

已完成的定向检查覆盖包导入与删除故障恢复、固定快照、元数据与调用预算、适配器提交与回执失败、迁移、入口选择、草稿/已绑定任务发现与队列发送。静态 Windows 检查不代替 Windows 实机；Linux 专属大小写实文件用例在 macOS 跳过。未做 Linux/Windows 实机、签名包、安装或发布验收。

历史 P1 的 99 通过 / 1 跳过只证明当时存储阶段，不适用于当前全部改动。本轮首次并发完整测试出现超时。串行执行补齐了迁移版本断言和共享测试状态清理；真实 V2 夹具引入只读包后，ProviderCommandReactor 测试清理还需覆盖整个 Expert 资源目录，否则一次清理失败会使后续用例连锁失败，该问题已修复。

一次后续完整服务端运行达到 8,999 通过 / 1 失败 / 29 跳过；唯一失败是既有 Windows Store 图标复制单测启动假 PowerShell 命令耗尽 1,500 ms 超时。该单测现仅替换包目录发现结果，继续验证真实 PNG 选择和复制；AppX 发现进程与注册校验仍由既有 `open.test.ts` 覆盖。没有改动编辑器产品行为、超时阈值或跳过失败项。最终完整复跑单独记录，前述非零与中断运行均不算通过。
