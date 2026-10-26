# 工作区整合与恢复记录

日期：2026-10-24。用户已确认执行工作树、候选代码、备份与文档整理。本记录不构成再次安装或发布应用的操作；日用仍为 Personal Workbench 0.1.5，安装源码固定在 `8f7143cf6f001aa495d57f0e3867a91c3cb9f351`。

## 当前核对（2026-10-26）

预览受管源码和旧项目入口兼容链接已恢复，Worker／OMP 修复已本地合入 main，合入记录提交为 `15c99597c0db524b97061b404f4ff09c22335ead`。当前登记主目录、常驻开发预览，以及一个独立 Skill 管理任务树；后者仍有未合入提交。本任务预览没有独有提交，按长期复用规则保留，并非待删除临时树。详细验证与交付边界见[问答修复验收](omp-question-answer-preview-2026-10-24.md)；本轮未推送、安装或删除其他任务源码。

## 历史状态：清理与存储收口（源码恢复前）

用户重启 ChatGPT 后，旧工作树已全部移除；当时 Git 仅登记主目录。`application-preview` 由用户误操作移除，数据仍保留，当时需重建源码后再用于开发。后续已执行备份压缩、历史数据与构建产物回收；以下目录和恢复点清单是清理前历史记录，当前恢复入口统一见[存储优化记录](storage-management-2026-10-24.md)。

## 当前入口（此前配置）

| 用途         | 位置                                                                   | 使用方式                                                        |
| ------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| 主源码与集成 | `/Users/wangyuelin/synara-expert`，`main`                              | 集中检查、审查和合并                                            |
| 开发预览     | `/Users/wangyuelin/.codex/worktrees/application-preview/synara-expert` | 唯一日常开发工作树；浏览器 19842，后端 19841                    |
| 日用应用     | `/Applications/Personal Workbench.app`                                 | 真实工作数据在 `~/.synara-workbench/userdata`，不跟随源码热更新 |
| 操作工具     | `~/Desktop/Synara 开发工作台`                                          | 打开、停止预览；显式现场复制；备份与恢复说明                    |

保留主目录和预览两种源码角色。worktree 不等于数据隔离；沿用[开发规范](workbench-development-workflow.md#browser-daily-preview)及[环境记录](application-preview-environments-2026-10-24.md)。已安装基线和开发提交分别记录，预览数据不回写日用。

## 已整理的历史内容

- 原根目录未提交内容固定保存为本地归档提交 `fe8a15af48da2733c9bbba89495f0df2dbe3aea9`，不作为验收或合入结论。原根目录与旧浏览器预览的补丁、文件归档及逐文件校验记录保留。
- 31 个不再使用的本地分支名转入 `refs/archive/workspace-consolidation-20261024/*`，保留原提交身份；完整 Git bundle 已验证可读。历史提交没有因删除分支名而丢失。
- `expert-skill-packages`、`browser-daily` 两个旧工作树已移除。前者的忽略数据、截图和证据先移至私有归档；依赖和可重建产物按清单处理。
- 5 份失败／中断的复制目录已清理。10 份内容与来源均完全相同的备份，经文件、权限、符号链接及 SQLite 完整性核验后去重；原清单与保留路径对应关系可查。
- 6 个指定恢复点、源码切换前新增且验证的预览备份、当前日用数据、当前预览、最近一次预览回退副本和应用回退包保留。旧 userdata 备份移至管理根 `application/rollback/userdata.pre-0.1.5-20261024T055108Z`，避免日用 home 备份再次包含整份旧备份；活跃 userdata 未移动。
- 旧浏览器配置已标记历史、停止初始化入口，不能复用当前预览启动标签误启旧环境。历史 Hub 后端通过对应旧协议的只读 owner RPC 确认空闲后正常停止，没有强制结束工作线程。

管理根：`/Users/wangyuelin/synara-expert/.synara/browser-environments`。本轮私有证据位于其 `consolidation-20261024/`：`source-preservation.json`、`retired-worktrees.json`、`archived-branch-refs.json`、`verified-protected-backups.json`、`backup-deduplication.json`、`rollback-data-relocation.json` 以及完整历史 bundle。这些目录含本机恢复资料，不提交 Git，也不使用整目录清空命令。

## 必须暂留的三个旧工作树

| 工作树                     | 代码状态           | 暂留原因                                               |
| -------------------------- | ------------------ | ------------------------------------------------------ |
| `expert-claude-omp`        | HEAD 已包含在 main | 当前 ChatGPT 持有 Electron `default_app.asar` 资源文件 |
| `expert-frontend-redesign` | HEAD 已包含在 main | 同上                                                   |
| `hub-expert-v1`            | HEAD 已包含在 main | 同上                                                   |

三者已加工作树锁，其旧开发后台已正常停止。它们不代表三个待合并功能。当前会话不退出 ChatGPT、不强制删除占用文件；宿主释放句柄后，重新核对工作区差异、进程和忽略数据，再归档移除。具体占用与恢复条件见私有 `pending-host-held-worktrees.json`。

## 审计代码与检查

审计候选以 8f7143cf6 为整合基线，只移植适用修复，未用旧源码包覆盖当前代码。重连快照覆盖新 API 状态的问题已补回归；MCP HTTP 测试夹具补上有界启动等待与连接清理，未降低断言或提高超时。

适用修复已以 `f9b1214d565930d26ec61bb27beda3701ac17368` 合入 main、推送个人 GitHub 仓库，并同步开发预览。`bun run test --concurrency=1` 最终退出 0：18,028 通过、40 原有跳过；格式、lint、7 包类型、相关 browser 21 项、边界、迁移与 Windows 静态检查通过。临时审计树的过时文档已另行逐文件归档并验证，工作树已向应用提交归档请求；完成状态以实际 worktree 清单和私有回执为准。前两次完整运行的超时保留记录，不能把定向复跑称为同一次全仓通过。依赖解析固定为应用 toml 5.0.1、smol-toml 1.9.0；其他传递依赖的风险不因此清零。

安全审计的未关闭问题以[台账](security-audit-2026-10-23/README.md)为准：旧 Goal 停止持久补偿、Hub 自动化部分失败补偿、Beta OAuth 凭据 issuer 绑定及剩余依赖分类、跨平台验证仍待完成。Hub T2 定向回复与 T3 纯影响分析已在 `197993e26` 进入当前基线；真实候选／审核／人工出口闭环及 T3 运行中修订仍未验收。应用启动后自定义图标元数据导致的严格签名检查问题另行保留，不以本次整理声称修复。

## 恢复与后续清理

1. 源码恢复优先读取归档 ref 或经过 `git bundle verify` 的历史包；在新分支恢复，不覆盖当前 main 或开发预览。
2. 数据恢复核对应用版本、备份归属和配套文件；重复备份的旧路径查 `backup-deduplication.json` 获取保留路径。保留的原清单用于追溯，不代表已删除路径仍可直接恢复。
3. 当前日用备份入口仍指向有效恢复点；应用、userdata、管理工作区与浏览器配置分别按现有恢复说明处理，不把预览库写回日用。
4. 本轮后不再新增长期浏览器日用实例。三个因宿主句柄暂留的旧工作树释放后再处理；无需为历史树重新启用服务或运行模型。
