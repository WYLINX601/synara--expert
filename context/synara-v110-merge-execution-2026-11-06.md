# Synara v1.1.0 合并执行方案

用户授权：先梳理《对比合并方案》，再执行合并。来源为 [原始完整方案](https://chatgpt.com/space/page_b63ff5c050608191ba69db872e0396b8)，本地执行遵循 [同步 SOP](../docs/workbench-implementation-plan.md#sync-sop)。本次合并范围为源码与隔离验收；日用安装、生产数据库迁移和远端推送分别按对应授权处理。

## 当前基线与原方案的修正

- 官方目标固定为 `v1.1.0 / b6aa37bc82eec649dd527c5956fdccc2c63d3b24`；已从 upstream 获取并核对标签，官方 latest release 仍为该非预发布版本。
- 执行开始时，工作区 HEAD 与刷新后的 origin/main 均为 `238f5eda0bb2625c40bfd63224194aaca90fe4b8`。本地 main `757ab03f655dca318ae378657bab0e27e940a993` 是其祖先，落后 5 个提交，没有独有提交。
- Obsidian/Ambient Context 与 OMP 18.16 兼容修复已先纳入可恢复基线 `e147a7c4e93eed3a8734b72213781f547a8d5f16`，再计算真实冲突；不直接使用原方案中仅含 238f5eda0 的候选。
- 保留当前 AGENTS、存储政策、安装与验收文档的既有改动。合并前全库验收为 18,651 通过、42 跳过，但只证明合并前源码，不能转移给升级候选。
- 官方迁移从 135 升至 141，136–140 保留空位；当前 Expert ledger 已由 Ambient Context 推进至 **14**，必须保留，不按旧方案退回 13。Context ledger 和 Workbench 文件格式继续保留各自检查。
- 保留 OMP 当前能力验证及官方扩展适配，不恢复对 18.12.1 的全局精确版本限制。保留 Obsidian 快照从草稿、队列到 Provider 和持久化的完整传递。

## 合并次序和固定规则

1. 建立本地 `codex/pre-upstream-v1-1-0` 基线，提交已授权且已验收的工作区成果；以其实际 SHA 作为本次 source base，后续一致使用该 main-ref 绑定候选。原 main 和 origin/main 保留，正式合入前不前移。
2. 创建唯一升级候选，执行现有 `workbench:sync check/prepare` 对固定目标的真实 merge；保留第二 parent 为官方目标，不 squash、不重写已验收候选。
3. 合并 contracts/RPC、依赖及 shared exports；采用目标的 Node 24.13.1/Bun 1.4.4，保留 Fork 必需补丁及测试串行化。合并 manifests 后统一生成 bun.lock。
4. 合并官方及扩展迁移、plain/gzip 备份与恢复；逐项复核 Sqlite 自动合并后的完整升级链、锁与关闭顺序。
5. 合并 Provider/Adapter/Reactor：保留上游 Stop generation、恢复与凭据退休，同时保留 Expert/Context 准入、实际装载记录、固定资源与模型身份。
6. 合并 Hub/Gateway 与学习：规范化创建指纹并保留冻结 Expert 绑定及旧请求重放；统一真实终态结算和重试；保留 ACK 前持久交接、独立采集重试及单一学习入口。事件查询的单/多 ID、序列上下界和字节预算组合生效。
7. 合并前端宿主与国际化：保留 Expert/统一技能库/Context/Obsidian 产品结构；修复模型选择器 helper 的翻译函数与 prompt 修改权限参数，保留重连草稿和稳定搜索锚点。Hub Graph、团队编辑、计划审批执行和已回滚的定向回复入口不恢复。
8. 同步 integration-points、候选 metadata、构建版本与来源。Workbench 候选版本采用 0.1.14（上游版本独立记录为 1.1.0），不将构建版本更新表述为安装或发布。
9. 独立审查、修复并冻结候选，再按同一 SHA 执行 bind/verify 和适用运行验收；达到本地合入条件后，将 main 快进至已验收候选。源码、自动门禁、运行证据、合入、安装分别记录。

## 资源与环境安排

本轮只创建一个隔离源码候选，复用 Git common-dir，不创建完整仓库备份。已有 4 个工作树：主目录含本轮成果，Expert 工作树含既有历史，两个已停止的 Ambient 工作树均仍含文档改动；本轮不重置、删除或改换这些工作树的归属。

因此记录一次临时源码数量例外：由本合并任务负责第 5 个候选，结束条件为合并验收和可验证 Git 留存后归档候选。初次盘点可用空间约 22 GiB；主目录 node_modules 约 2.7 GiB、.synara 约 15 GiB，历史交付与预览材料不作为可任意删除资源。先完成盘点，再允许本轮候选、差异依赖及隔离验证新增峰值最多 6 GiB；临时总量预算为 26 GiB，并始终保留至少 10 GiB 磁盘余量。超预算重新评估，不删除唯一数据或恢复点。

依赖只安装在候选，子代理共享同一候选并按文件分工。既有单一交付根继续使用；不建立新的按任务／版本长期保留的安装交付副本。必要的预览使用独立 HOME/端口和合成数据；本轮不迁移日用数据库。

## 验收与接续记录

- 七项固定门禁：fmt:check、lint、typecheck、test、migrations:check、windows-runtime:check、workbench:check-boundaries；正式验证显式使用 Bun 1.4.4。
- 重点回归：Expert 默认模型及实际装载；取消/恢复/排队；Hub 幂等和单次结算；学习交接及 journal 清理后重试；MCP 凭据退休；Context 与 Obsidian 快照/草稿；135→141 与 Expert/14 保留；plain/gzip 恢复；应用身份。
- 自动门禁通过仅为 awaiting-runtime。按现有固定十项 runtime evidence 结构记录同源证据；OMP、Claude、学习及国际化追加到适用证据附件，不伪造缺失的真实运行结果。
- 冲突数量、具体文件所有权、候选 SHA、检查结果、未验范围和环境关闭情况在本次验收记录中维护；原方案的 73 文件/150 冲突仅为旧基线预演值。

## 国际化存量边界

上游 `i18n:check` 的目录、key、占位符校验完整保留。`i18n:extract --check` 在候选发现 1,209 处未翻译文案；用同一 AST 检查器逐文件对照 e147a7c4e93eed3a8734b72213781f547a8d5f16，所有文案及出现次数均来自合并前 Fork，新增为零。本次不把保留产品结构扩大为全部历史 UI 文案改写。

CI 使用 `workbench:i18n:check` 对这些存量建立精确的文件、诊断、文本与次数边界（`workbench/i18n-legacy-literals.json`），新增或增加次数会失败；删除或翻译后必须同步缩减登记，不保留空闲额度。原始 `i18n:extract --check` 仍可用于查看全量翻译缺口，不声称 Fork 已完成全量国际化。存量登记无自动更新命令，也不豁免目录或新页面。

存量登记本身属于受审配置：不得借新增条目放行新文案；修改必须核对冻结来源。门禁验证内容/次数和配置结构，不自动从 Git 历史证明 `sourceSha` 的来源真实性；本轮已另行逐文件证明，浅克隆 CI 不额外获取历史。
