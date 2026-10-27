# Skill 管理审核修复（2026-10-27）

首次修复验收范围：用户提供的 CR-01 至 CR-06；基线 `e1137f7f44e86da00d07d516845249da2c52ec51`，当时在主源码目录形成未提交差异，尚未提交、推送、安装或发布。该阶段未修改日用数据、认证、模型选择或全局 CLI。后续用户授权的 main 推送和本机更新见[交付结果](#delivery-20261027)。复用现有 Store、不可变包、生命周期锁、CAS、操作回执和编辑器；没有新增依赖、状态机或配置体系。[设计边界](./expert-skill-package-design.md)已同步。

首次修复验收的代码与测试差异指纹（`git diff --binary -- apps packages` 的 SHA-256）：`b3b3fc423b305d957c30bb6ff7f9dc867368c81737e7acea9df8b7949e977e0a`。它是当时未提交补丁的指纹，不是提交或安装产物。

| 问题     | 修复及回归边界                                                                                                                                                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CR-01 P1 | ProviderService 在每次实际原生启动前后登记初始化结果，覆盖首次启动、自动恢复、回滚及 stale-cursor fallback；Reactor 移除重复登记。真实 Store/SQLite 配合 fake adapter 验证成功、失败、中断、回滚失败后 uncertain 和禁止重放。没有初始化副作用的失败仍允许既有安全重试。 |
| CR-02 P1 | 单项和批量确认携带预览的 expectedPackageId；来源变化返回 conflict，旧头及本地编辑保持。受控来源验证预览 v2、实际下载 v3 被拒绝，重新预览后可提交。直接更新接口保留兼容。                                                                                                |
| CR-03 P1 | 统一发布边界在包生命周期锁内校验候选 revision 和受影响 Expert 的有效装配；保存、替换导入、refresh、updateFromSource 冲突均保留旧头。覆盖相同名称、大小写、NFC 归一化冲突和新 Run 仍可启动；不强制全库名称唯一。                                                         |
| CR-04 P1 | Claude 投影保留原清单字段并统一受控 name，资源镜像跳过原清单。真实包导入、解析、投影验证宿主身份一致及原不可变清单未变。派生目录提升至 v4，覆盖旧 v3 缓存存在时创建新视图、保留旧缓存与原包字节。                                                                       |
| CR-05 P2 | 保存期间保留可编辑草稿；响应更新保存基线和 revision，提交后编辑仍 dirty，下一次保存使用新 revision。Chromium 延迟 POST 用例验证两次实际上传内容和 revision。未改布局、样式或文案。                                                                                      |
| CR-06 P2 | 下载、解包和独立校验移出管理提交队列；读取已提交状态，提交重查 revision、回执和授权。覆盖下载中列表/详情/无关保存完成、同一 Skill 并发修改导致 CAS 冲突，以及按请求 ID 取消、dispose 清理及重新打开。                                                                   |

## 验证

工具链：通过 `mise exec --` 使用 Node 24.13.1、Bun 1.4.2。测试使用独立临时目录，没有启动日用实例或真实 Provider。

| 检查                         | 实际结果                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| 格式、lint、类型             | 格式通过；lint 0 errors、1,114 warnings；类型检查 7/7 工作区通过                             |
| 管理库定向回归               | SkillLibraryStore 38/38，包含单项/批量来源漂移、改名发布冲突、下载中并发读写及取消/关闭清理  |
| ProviderService              | 214/214，包括 4 条新增初始化边界回归                                                         |
| 投影及受影响调用方           | 最终源码 6 文件 406/406，含旧 v3 缓存恢复与派生清单读取字节校验                              |
| Chromium                     | SkillLibrarySettingsPanel 与 CodeEditorPane 两文件 46/46；包含预览确认摘要断言               |
| Windows / Workbench 静态边界 | 均通过；不代表 Windows 实机或完整运行隔离                                                    |
| 完整 workspace 测试          | 冻结源码后 **18,324 通过、40 跳过**，6/6 任务成功；1,430 测试文件通过、13 文件跳过，退出码 0 |

完整检查命令为 `mise exec -- bun run test --concurrency=1 --continue=always`；最终日志 `test-frozen.log`。服务端 9,447、web 5,619、shared 1,114、desktop 1,444、contracts 259、scripts 441 项通过。`--continue=always` 仅用于收集全部任务结果，未改变失败退出语义。

首次全仓沙箱运行因本地监听 `EPERM` 失败；沙箱外并行运行中 5 项桌面用例超时并导致其他任务中止，未记为全仓通过。修复期间另一轮串行运行与 v4 投影补丁重叠，进程复用了旧模块而测试已更新，产生 2 项投影失败；冻结源码重新运行后，全仓及上述桌面用例全部通过。首次浏览器新增用例在 POST 完成前断言服务端文件；补齐等待条件后，两文件 46/46 通过。集成类型检查曾发现新增错误联合未在 stale-cursor 判断中排除；修正后 7/7 通过。没有修改已有测试超时、添加跳过或放宽断言。

日志和浏览器生成图片在 `/private/tmp/synara-review-fixes-20261027.enDIyl/`。图片已从测试自动创建的 `_bmad-output/` 移出；未创建工作树、安装依赖、修改现有运行环境或写入生产数据。未执行真实模型、真实 hooks、Windows/Linux 桌面或签名打包；故障注入及投影结果不等于真实 Provider 端到端验收。

<a id="delivery-20261027"></a>

## main 推送与日用应用更新（后续授权，2026-10-27）

用户明确要求提交并推送六项修复到 main、更新日用应用。以下是本轮实际交付，不改变上文首次验收的历史范围。

| 项目             | 实际结果                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 修复与版本提交   | [`d189ce8af2c8eec6ab30515cdaaee3485867b9d4`](https://github.com/WYLINX601/synara--expert/commit/d189ce8af2c8eec6ab30515cdaaee3485867b9d4)，已推送 origin/main；Workbench 构建版本 0.1.6，官方 Stable/Beta 版本未改 |
| 仅测试的 CI 跟进 | [`4337c7e6e659035619a0d2d4ca8d5111f2a22e62`](https://github.com/WYLINX601/synara--expert/commit/4337c7e6e659035619a0d2d4ca8d5111f2a22e62)，已推送；不改变程序构建输入                                              |
| CI               | 修复提交最初有一组 chat-workflows 失败；跟进测试修正后的 [CI 已成功](https://github.com/WYLINX601/synara--expert/actions/runs/40470375834)，未用首次失败冒充通过                                                   |
| 日用应用         | `/Applications/Personal Workbench.app` 已从 0.1.5 更新到 **0.1.6 并启动**；包内源提交为 d189ce8af，bundle ID `com.wylinx.workbench`，沿用原 `.synara-workbench` home 和 Electron profile                           |
| 构建与包校验     | 固定 Node 24.13.1 / Bun 1.4.2，干净源构建 macOS arm64 DMG/ZIP；隔离依赖及实际启动 smoke、923 项 bundle 清单、源码/锁文件/版本和 deep/strict codesign 校验通过                                                      |
| 数据保护         | 原生数据库生命周期锁内完整备份 home/profile，用 SQLite backup API 校验一致性；副本迁移层通过，105 张原表的旧列逐行摘要保持；没有替换日用数据库或修改 Provider/模型设置                                             |
| 实际启动与记录   | 本地 health 为 ok；实际安装进程与原 home 原生锁 PID 一致；通过已认证的只读应用快照核对 **32 线程、308 消息、3 Space、18 Project** 的全部原始 ID 均保留；原生窗口正常显示已有会话                                   |
| 配置与资源       | **699 个**用户设置、凭据、专家资源等文件逐文件摘要不变；唯一另记的变化是 ProviderDiscoveryService 正常刷新的模型目录缓存，不是用户模型选择                                                                         |
| 额外门禁         | Workbench 构建测试 21/21、release smoke 通过；CI 修正对应完整 chat-workflows 分组 146 通过，另 94 项由现有分组配置排除；web 类型、格式、lint 通过，未新增 skip 或放宽业务断言                                      |

原 CI 失败来自既存测试将全局最后一次详情读取当作发送前置读取，后台补偿同步可能在发送后再次读取详情。实际发送代码仍严格等待详情、accepted snapshot 和 turn；跟进只把断言限定到同线程、同快照的 `create < detail < snapshot read < turn`，保留原技能 payload 校验，没有修改产品 UI 或服务端代码。因此已构建的 d189ce8af 程序仍是本次安装输入。

首次安装在备份/替换前被旧应用 Finder 元数据导致的严格签名校验挡住，原应用和数据未变。后续从已保留且摘要、文件清单一致的 0.1.5 原 ZIP 验证干净回退应用；原安装应用连同 Finder 元数据另外原样保留，未清理或改签旧应用。新候选及安装副本的严格签名检查始终保留。启动后的直接 SQLite 读取遇服务独占锁，改用应用自身已认证的只读接口核验记录，没有使用 immutable 方式绕过锁。

本机私有交付目录：`/Users/wangyuelin/.codex/task-artifacts/skill-review-delivery-20261027/`。`installation-result.json` 的实际状态为 `installed-and-started`；`recovery-set/` 保存一致性 home/profile、干净 0.1.5 回退应用及原安装应用。现行操作入口 `application/installation-receipt.json` 和 `application/latest-application-backup.json` 已更新指向本轮回执与恢复组合，旧入口内容保留在恢复集。回退前须停止应用并保护更新后新增数据，再按匹配的程序、home 和 profile 组合恢复；不自动回滚或覆盖新增工作。

安装 app.asar SHA-256：`87609cb921d8305526ed0a8c628039011d50fb8c214a0aa0ac83ac40cf9fe58f`。

| 产物                               | SHA-256                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| Personal-Workbench-0.1.6-arm64.dmg | `55eb4735834c1ca8c56b98850b86375c2d27de9d3558e10f7acf089bd6293666` |
| Personal-Workbench-0.1.6-arm64.zip | `df2519f17e397872fe9ea9bdc2c3c5226907076c8e9db34b2211a16c90543146` |

这是本机 ad-hoc 构建与更新，不是 Developer ID 签名或公证。没有创建发布 tag、GitHub Release、上传二进制或更新自动更新 feed；没有新增真实模型/hooks 回归，也没有 Windows/Linux 实机验收。独立预览未刷新，已有数据及任务保留。
