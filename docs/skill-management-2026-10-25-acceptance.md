# 统一 Skill 管理与固定装配实施记录

状态：实现、独立审查补强、全部所列本地门禁与隔离预览验证完成，待用户评审。候选尚未合入、安装或发布，不代表用户验收。

## 版本与交付边界

用户已确认[当前方案](./expert-skill-package-design.md#current-skill-management)并要求实施。基线为 `3a2481666430b3315c1a02788dec103a260b5f1e`；候选分支 `codex/feature-skill-management`，目录 `/Users/wangyuelin/.codex/worktrees/skill-management/synara-expert`。所有改动均在该受管理 worktree，以本地提交交付；提交哈希见 Git 与完成摘要，未推送。

受检代码/测试/manifest 摘要为 `b83ea5963ad19ce02caf0f64de9102fa902436f988a61c52175c380bd3614c17`。计算范围为本轮非 `docs/`、`context/` 改动，按相对路径排序后对路径、NUL 和文件字节求 SHA-256；各门禁结束都复核摘要。

完成稳定 Skill 库、完整资源编辑与来源管理、双向 Expert 绑定、接受时解析最新头版本与固定任务快照、四端原生门禁、HTTP/RPC 和既有 Settings 页面。复用既有包存储、Settings/编辑器/草稿保护/连接客户端及服务端生命周期边界。没有进行日用数据迁移、旧任务转换或删除、全局 CLI/认证/模型/MCP 设置变更、合入、推送、安装或发布。

## 检查结果

命令均从候选根目录使用 `mise exec --` 执行，Node 24.13.1 / Bun 1.4.2。

| 检查                                                     | 实际结果                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `bun run fmt:check`、`bun run lint`、`bun run typecheck` | 通过                                                                                                                |
| `bun run workbench:check-boundaries`                     | 通过；覆盖 93 个声明的源文件，仅静态直接导入边界                                                                    |
| `bun run migrations:check`                               | 通过；本轮无迁移文件改动                                                                                            |
| `bun run windows-runtime:check`                          | 通过；319 个应用源文件、119 个边界文件、4 个依赖补丁、9 个 workspace manifest 的静态检查                            |
| `bun run test`                                           | 最终完整运行通过：6/6 测试任务，18,146 项通过、40 项跳过，0 缓存；跳过项不计为通过                                  |
| 受影响 Chromium browser 回归                             | 3 文件、50 项通过；包括真实 CodeEditorPane、保存并继续草稿保护、双向绑定、导入取消及固定 Expert 的发现缓存隔离      |
| 审查补强定向回归                                         | 原生侧 566 通过 / 2 既有跳过；存储侧 81 通过 / 1 既有跳过；库界面 9 项通过；这些计数与全库/browser 计数重叠，不相加 |

完整差异与增量均由主会话读过。独立 Quick 审查的 8 条问题已逐条核实并修复：Claude steering 门禁、原生插件路径证明、缺失目录误判、规范正文与版本同步、稳定归档根、当前/迟到预览取消和失败包回滚。冻结矩阵 8 行都有实际运行且通过的对应测试；跳过或被过滤的测试不作为覆盖证据。

首次全库执行在其余 5 个测试任务通过后，仅因 reactor 恢复用例仍按旧字段构造期望而失败。生产代码已正确传递固定策略；该用例现明确断言 schema 3 以及初次/恢复时同一个 `FIXED_EXPERT_SKILL_POLICY`。定向复测通过，未放宽断言或修改生产代码。

第二次执行因未改动的 Desktop 上传清理用例中断：该用例等待文件消失后立即重用配额，而实现需在异步目录删除完成后释放配额，存在调度窗口。首次整套通过，第二次失败后相同源码单独复测 11/11 通过；第三次 Desktop 整套已通过 1,444 项 / 6 项跳过。第三次完整全库运行最终成功。该既有测试同步问题单独记入本机 deferred-work，未扩大本轮代码范围。前两轮完整失败日志保留，不能写成通过。

本机检查材料位于 `_bmad-output/final-gates/`、`final-gates-attempt-1/`、`final-gates-attempt-2/`、`final-browser.log`、`recovery-policy-regression.log`、`desktop-upload-recheck.log`，不随 Git 发布。Turbo 对现有 `bun.lock` 的 workspace 格式有解析警告；测试任务强制执行且无缓存，未为消除提示改写锁文件。

## 稳定源码的实际探测

| 对象               | 结果与证明边界                                                                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 隔离 HTTP/WS       | 协议 7：归档预览→WS 显式入口导入→正文读回；8 字节二进制上传/下载完全一致；旧 revision 被拒绝且头版本不变；已取消预览不能导入                                                                                                                                                    |
| 实际界面           | 创建、标签、正文保存、资源重读、Skill 侧 Expert 绑定已验证；最终重启后把同一 Skill 改名为 `ui-managed-a-reviewed`，保存 r5 后编辑器立即读回新 frontmatter，原正文 marker 和产品经理启用/按需绑定保留                                                                            |
| Codex 0.162.0      | 正式 manager 的两阶段原生加载与配置/完整目录核验通过；探测退出不污染正式生命周期，新环境入口在 `turn/start` 前被拒绝；使用隔离启动接缝，未接入操作员认证配置                                                                                                                    |
| 内嵌 Pi SDK 0.87.1 | 真实 ResourceLoader 只解析指定入口、reload 保持集合、环境 extensions 为 0；不等于真实模型回合                                                                                                                                                                                   |
| OMP 18.12.1        | 私有配置、实际活动目录和重复核验通过；同一合成 extension 在普通 ACP `session/new` 执行，在正式参数构建器生成的 `--no-extensions` ACP 中不执行，两者会话均创建成功、均无 prompt                                                                                                  |
| Claude             | SDK 随附 CLI 的原生插件名称/实际路径回读、`error_count=0` 和非空 Skill context 匹配。已安装 CLI 2.1.92 不支持 SDK 0.3.296 的 `--await-initialize`；没有全局升级。随附 CLI 的空装配省略 `usage.skills`，而 `reloadSkills()` 返回 16 项可用命令，不能证明原生零目录，因此失败关闭 |

公开来源读取实测：GitHub 与 Skills.sh 的 `web-design-guidelines` 固定在 commit `063bee94c3f4df8453406c830b0a7df0f2860278`，正文读回 1,231 字节；ClawHub `steipete/skills/gifgrep` 固定 `1.0.1`，3 文件共 4,032 字节，正文读回 1,882 字节。最终 ClawHub 包为 `pkg_6b91245efe50185b912e0f60a7499d3fd02ccae8e49c3fa224ced460a4cb4e87`，归档使用稳定根目录；重复导入/不变刷新去重另有回归证明。ClawHub 来源身份和下载形态依据[官方 HTTP API](https://docs.openclaw.ai/clawhub/http-api)。没有执行下载内容中的脚本或 setup。

本机材料：`runtime-probe/implemented-runtime-result.json`、`runtime-probe/claude-provenance-result.json`、`runtime-probe/omp-extension-result.json`、`runtime-probe/supported-source-result.json`、`final-preview-result.json` 和 `ui-live-result.json`，均位于 `_bmad-output/` 下相应目录。原生/公开来源/预览探测都没有发模型请求。最终实测后只有恢复测试断言和静态 manifest 同步，生产源文件未变。

尚未验证：真实认证模型回合、原生子代理实际工具执行、Linux/Windows 实机、桌面打包/签名/安装。系统文件选择器上传因 Mac 锁屏未实测；没有修改浏览器文件访问权限，HTTP 真正二进制链路和浏览器回归不能代替该项。旧技能包候选的历史成功不转移到本轮。

## 环境收尾与用户评审

预览使用独立 home `_bmad-output/preview-home-verified`、state `dev/`、管理工作区 `_bmad-output/preview-managed`、server/web 端口 19941/19942；最终重启前已核对两端口的 IPv4/IPv6 监听和 dev-runner dry-run。入口为 `http://localhost:19942/settings?section=skills`，仅本机 loopback，当前由本轮 PTY 70139 持有。没有向日用数据库创建任务或技能配置，主仓库原有修改和另一任务的应用预览未动。

候选、当前预览、依赖和独有本机证据保留供本轮用户评审；原生探测自身已结束。已清理拥有且逐字节核对过的合成下载文件，夹具副本保留。评审结束后，先保存 `_bmad-output/` 的独有证据，再按环境生命周期停止本轮进程及归档受管理 worktree；不得因任务结束而删除日用数据或其他任务目录。截图为本机 `_bmad-output/skill-library-live-final.jpg`。
