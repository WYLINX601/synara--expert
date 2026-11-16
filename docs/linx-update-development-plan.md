# Linx 更新能力开发计划

版本：0.2（LU-00 协议与 LU-02 检查下载已实现；整体待实施与验收）  
更新日期：2026-11-13  
负责人角色：Winston / Architect；开发与验收由用户和 Hub 协调员安排。  
状态：用户已授权在 `main` 推进开发、不创建 PR；LU-00 协议切片与 LU-02 检查/点击下载已提交。2026-11-13 完整实施方案已批准，新身份和公开发布仓库已冻结，工作树已补入安装身份绑定与维护/安装契约；迁移、受控发布、辅助安装及真实升级仍在开发，不代表发布、安装或产品验收通过。

## 1. 结论与已确认范围

**Linx 是独立产品，只建设 Linx 自有发布与升级链路。首批支持 macOS Apple Silicon；自动检查新版本，用户点击升级后才下载并安装；不要求购买 Apple Developer Program，不依赖 Developer ID 或 Apple 公证。**

```text
源码 push → CI 检查
  → 正式版本标签固定源码
  → 构建 macOS arm64 产物、验证、签署更新清单
  → 暂存候选资产 → 维护者确认 → 公开 GitHub Release
  → Linx 自动检查并提示（不下载应用包）
  → 用户点击升级 → 下载、验证、安装安全门禁
  → Linx 退出 → 独立辅助程序替换 → 重启与健康确认
```

### 已确认决定

- **D-01 [ADOPTED]**：产品正式名称为 **Linx**。
- **D-02 [ADOPTED]**：独立产品、单一自有发布链路；不以 Synara 上游合并或同步作为产品发布前置。保留许可证、来源历史和有效迁移约束，不等于保留另一产品链路。
- **D-03 [ADOPTED，修订]**：自动检查；只有点击升级后才下载并安装。取代 v0.1 的“只手动检查”，不采用自动后台下载或空闲自动安装。
- **D-04 [ADOPTED，授权边界补记]**：v0.2 方案轮次仅获文档授权；后续用户另行授权开发并在 `main` 推进、不创建 PR。远端工作流停用、仓库设置、生产密钥配置、推送、发布、安装及真实数据迁移不能由本地开发授权推定。
- **D-05 [ADOPTED]**：首批仅 macOS Apple Silicon。Intel Mac、Windows、Linux 不属于本批交付承诺。
- **D-06 [ADOPTED]**：不采用 Apple 付费 Developer ID 签名与公证作为本次分发前提。必要的 ad-hoc 代码签名与 Linx 自有更新清单签名不等同于 Apple 开发者认证。
- **D-07 [ADOPTED]**：正式标签触发发布构建，公开 Release 前由维护者确认；普通源码 push 不发布。
- **D-08 [ADOPTED，状态补记]**：逐项收敛设计，交付供工程师实现的方案。v0.2 编写时持久身份尚未选择；2026-11-13 已批准完整剩余方案，保留 LU-00～05 与全部 12 项验收，不把部分开发当作整体完成。
- **D-09 [ADOPTED，2026-11-13]**：用户选择并批准全新 Linx 内部身份及受控单向迁移，具体标识见 AD-02。迁移保全应用数据、草稿和受管引用，不改写历史事件、不保留旧 home 双写、不搬第三方 Keychain 条目，必要重新认证明确提示。批准本地实现与隔离演练不等于批准操作真实数据。
- **D-10 [ADOPTED，2026-11-13]**：用户选择受控 CI 签名。生产私钥只供受保护的发布任务使用；先核对仓库实际支持的 GitHub Environment 审批能力，不把推荐的环境/审批配置视为已配置。本次未生成或配置生产私钥。
- **D-11 [ADOPTED，2026-11-13]**：完整方案确认采用公开仓库 `WYLINX601/synara--expert` 作为 Linx 发布源；这不授权修改远端设置、推送、公开 Release 或日用安装。

### 本次包含与排除

包含品牌与旧安装承接、GitHub 发布流程、自动检查、点击下载/安装、独立更新辅助程序、来源验证、运行/数据保护、引导安装和真实升级验收。

不包含自建更新服务器、上游自动同步作为产品能力、整仓库替换 `synara` 字符串、新 Logo 设计、强制升级、插件/模型 CLI 更新、自动数据回滚，以及关闭 Gatekeeper、自动清除 quarantine 或绕过系统权限确认。应用关闭时不承诺检查，不安装常驻后台守护程序。

## 2. 输入依据与证据边界

本次输入是 v0.1 计划及后续用户决定。以下源码事实来自 2026-11-08 核对，**不是 2026-11-12 的全量源码重新审计**；实施前必须核对当前 checkout、锁文件和已安装应用。

- 当时 HEAD：`61264859dc431e354c57a710448987829ba0def3`，存在其他任务工作区改动；该 SHA 不等于安装产物完整来源证明。
- [构建版本](../workbench/build-config.json)当时 Workbench 为 `0.1.14`；[桌面 package](../apps/desktop/package.json)为 `1.1.0`、productName `Synara`，Electron `43.4.1`、electron-updater `^6.6.2`。工程师必须收口最终应用版本权威，不沿用旧上游版本比较。
- [桌面身份](../packages/shared/src/desktopIdentity.ts)：`com.wylinx.workbench`、`.synara-workbench`；Workbench/Preview 均采用 scripted updates，频道为 `synara`。
- [构建身份策略](../scripts/lib/desktop-artifact-identity.ts)：脚本更新身份不写更新 feed；不能只解除运行时禁用。
- [主进程](../apps/desktop/src/main.ts)、[版本准入](../apps/desktop/src/updateState.ts)：已有更新状态、包身份校验、安装记录、后端停止与失败监测；复用适用部分，不默认复用 Squirrel 安装交接。
- [现有更新按钮](../apps/web/src/components/DesktopUpdateRailButton.tsx)复用 Sidebar 订阅/动作归属；[发布工作流](../.github/workflows/release.yml)和[发布策略](../scripts/release-update-policy.json)当时仍含官方发布语义。
- [上游同步工作流](../.github/workflows/workbench-weekly-sync.yml)源码存在定时任务，不证明远端当前启用或停止。
- 当时 GitHub API 查询：`WYLINX601/synara--expert` 为 Public。建议复用现有仓库，不需客户端 Token；本次没有修改仓库或重新检查远端配置。
- [历史安装记录](./workbench-install-2026-11-04.md)记载 ad-hoc、无 Developer ID/公证；不能据此证明连续更新可行，也不代表当前已安装包的实测签名。
- 外部依据：[Electron autoUpdater 的 macOS 要求](https://www.electronjs.org/docs/latest/api/auto-updater#macos)在前一轮已读取：Squirrel.Mac 要求代码签名。该限制不能扩大解释为“从 GitHub 检查和下载必须付费”，也不能据此保证现有 ad-hoc 包可直接沿用 Squirrel。
- 前轮纯函数探针证明 Workbench/Preview feed 为 null，且有 feed 时仍被运行策略禁止；它不证明自有辅助程序、下载、替换或重启成功。

## 3. 架构约束与工程设计

AD-01～06 延续原编号并修订内容；新增 AD-07，避免旧交接引用失效。下述未标 ADOPTED 的技术细节是工程建议，不冒充用户逐项批准。

### AD-01：一个产品、一个受控正式发布入口

Linx Release 是唯一正式来源。发布不依赖 upstream tag 或候选同步状态。退役官方 stable/beta/bridge、自动 Beta 标签、官方 npm 包发布等对 Linx 的默认副作用；共享构建和质量检查保留。源码清理与远端工作流/宿主自动化停用分别执行和留回执，历史与许可证不删除。

### AD-02：品牌与持久安装身份分开

正式显示名、关于页面、菜单、安装包和 Release 标题使用 Linx。已批准身份为 Bundle ID `com.wylinx.linx`、home `.linx`、Electron profile `linx`、scheme `linx`、home 覆盖变量 `LINX_HOME`；Preview 对应 `com.wylinx.linx.preview`、`.linx-preview`、profile/scheme `linx-preview`、`LINX_PREVIEW_HOME`。自有凭证只进入各自 home 的 `userdata/secrets`；内部 workbench flavor/import 名不做无关重命名，Stable/Beta 权限与隔离不变。

首次 `Personal Workbench.app` → `Linx.app` 采用显式同意后的离线单向迁移，同时核对安装路径、Dock、登录项、深链、单实例锁、浏览器 origin 草稿与受管路径。禁止两个应用并发写同一 home，不覆盖已经产生数据的新 home。旧应用/旧数据仅作为恢复来源，不维持双在用版本或永久双读写兼容层；没有迁移回执前不声称已承接。

### AD-03：免费发布签名与系统信任分离

LU-00 协议切片已实现 Ed25519 原字节签名与客户端验签；用户已选择在受控 CI 中托管生产签名能力。生产私钥只进入受保护的发布任务，不进仓库、客户端、日志或文档；生产公钥、环境审批与凭证引用尚未配置。这不需要 Apple 会员，不能冒充 Developer ID、公证或保证 Gatekeeper 放行。ad-hoc 签名只满足包结构/本地执行要求，不提供发布者可信身份；哈希不能单独证明来源。

v1 清单契约：`schemaVersion`、`productId`、`installIdentity`、`channel`、`version`、`sourceCommit`、`platform`、`arch`、`minOSVersion`、`assetName`、`assetUrl`、`size`、`sha256`、`keyId`。固定 `productId=linx`、`installIdentity=com.wylinx.linx`、正式频道、`darwin/arm64`。首发前按已批准身份扩展 v1，全部消费者一起迁移，不保留缺失身份字段的旧形状。发布工具和客户端使用同一 schema，跨进程契约归 packages/contracts。

清单与 detached signature 分开发布：签署精确 UTF-8 文件字节，客户端先限制大小并核验原字节签名，再解析严格 schema，避免两端 JSON 重序列化差异。拒绝未知 schema/keyId、非法版本、同版/降级、错误产品/架构/安装身份、未知字段歧义及版本与包内元数据不一致。Release 只是候选发现渠道，不以 GitHub Latest 或名称直接授予安装权限；缺 Linx 有效清单不得回退到官方 feed。

固定 HTTPS 发布仓库与资产解析规则，重定向只接受明确允许的 GitHub 资产下载域；不向客户端注入 GitHub PAT，不接受用户输入的任意下载/安装路径。下载后按受签名 size/hash 重验，辅助程序替换前再次核验。正常轮换应先用旧可信密钥发布包含新公钥的版本；旧私钥泄露或丢失时停止发布并采用人工可信引导恢复，不接受来自网络的新公钥自行成为信任根。首次手动安装 B0 是信任根建立环节，必须通过维护者确认的来源取得。

#### LU-00 已实现协议（v1）

本节是更新清单协议的**唯一权威位置**；LU-02/03/04 以本节为准，BMad 过程计划只是过程材料。实现文件：

- `packages/contracts/src/linxUpdateManifest.ts`：字段文法、三层上限常量、严格版本比较、密钥环 schema。发布端与客户端唯一契约。
- `packages/shared/src/linxUpdateManifestVerification.ts`：验签→解码→准入管线、密钥环加载与 `keyId` 派生。纯函数，密钥环由调用方注入。
- `scripts/lib/linx-update-manifest-signing.ts` 与 `scripts/linx-update-manifest.ts`：发布侧密钥生成、签名与校验 CLI。仅发布环境使用，不进桌面包。

**固定字段**：`schemaVersion=1`、`productId="linx"`、`installIdentity="com.wylinx.linx"`、`channel="stable"`、`platform="darwin"`、`arch="arm64"`、`version` 为 `x.y.z`（无前导零、无预发布/构建号）、`sourceCommit` 为 40 位小写十六进制、`minOSVersion` 为最多三段数字（系统比较属 LU-04 安装预检）、`assetName` 以 `.zip` 结尾且不含路径分隔符与 `..`、`assetUrl` 为无凭据无片段的绝对 https、`size` 为 1 字节至 4 GiB 的整数、`sha256` 为 64 位小写十六进制、`keyId` 为 16 位小写十六进制。未知字段、错误产品/身份/频道/平台/架构、字段文法不符即拒绝；缺失或旧 Workbench/Preview 安装身份也拒绝。`channel: stable` 是单字面量；本批不含 Beta。生产公钥已提交，尚无正式分发包。

**签名与密钥**：

- 签署已发布清单文件的**原始 UTF-8 字节**；任何重序列化都会改变字节并导致验签失败。
- `.sig` 文件内容为 64 字节 Ed25519 原始签名的 base64（容许结尾空白）。
- `keyId` = 该公钥 SPKI DER 的 sha256 十六进制前 16 位。密钥环文件为 `keyId → base64 SPKI DER` 的 JSON 对象；加载时逐条要求 base64 恰解出 44 字节、`createPublicKey` 成功、类型为 Ed25519，且声明 `keyId` 必须与本条 DER 派生值一致，否则密钥环加载即失败（配置错误，不是清单拒绝）。
- 验签遍历环内全部受信密钥，再要求清单声明的 `keyId` 恰是实际验签成功的密钥，避免信任未经验签字节里的 id。
- 私钥只由发布脚本读取，禁止进入仓库、日志、协议输出或客户端。`generate-key` 拒绝覆盖既有私钥与密钥环，且拒绝把输出写进 Git 工作树（git 探测失败也按拒绝处理）。Ed25519 使用 `node:crypto`，未新增依赖。

**三层上限与拒绝顺序**：清单 ≤16 KiB、签名文件 ≤256 B、密钥环 ≤16 KiB 且 ≤8 条。验签在解码之前执行，拒绝 reason 为闭集，先命中者生效：`size`（清单或签名文件超过字节上限，或签名 base64 解出的字节数不是 64）→ `signature`（签名 base64 非法或与任何受信密钥都不匹配）→ `encoding`（清单不是合法 UTF-8）→ `schema`（JSON 损坏、未知字段、字段文法不符、非 https/带凭据 URL）→ `key`（声明的 `keyId` 不是实际签名密钥或不在环内）→ `url`（允许列表为裸主机名，`assetUrl` 主机不在列表内；带非默认端口的 URL 无法匹配）→ `version`（同版或降级）。密钥环形状/密钥非法、参数缺失或当前版本不可解析属配置错误，加载即抛错，不计入清单拒绝。

**CLI**（`mise exec -- bun scripts/linx-update-manifest.ts <subcommand>`）：

- `generate-key --out <dir>` 写 `<dir>/linx-update-private.pem`（0600，拒绝覆盖）与 `<dir>/linx-update-keys.json`，stdout 打印 `keyId` 与公钥。
- `sign --manifest <p> --key <p> [--out <sig>]` 默认写 `<manifest>.sig`；拒绝输入输出同路径；stdout 打印 `keyId` 与签名路径。
- `verify --manifest <p> --signature <p> --key-ring <p> --current-version <v> --asset-hosts <h,h>`（允许列表为裸主机名，不含端口或协议）成功打印 `version`/`keyId`。
- 退出码：`0` 成功、`1` 清单被拒绝（打印 reason 与字段）、`2` 用法或配置错误。私钥内容永不出现在 stdout/stderr。

**当前接线状态（2026-11-16）**：LU-02 在 `apps/desktop/src/linxUpdate{Source,Feed,Download,Client}.ts` 接入 Linx flavor：仅随包 `linx-update-source.json` 存在且有效时启用，自动/手动检查只取清单与签名，点击后才下载并流式复验 `size`/`sha256`；未配置时保持 `disabled` 且不发起请求。LU-04 的安装 IPC 已接入 `LinxUpdateClient.install` 和独立 helper 协调器；成功交接仅返回 `accepted:true, completed:false`，不是新版健康成功。已提交获批仓库和生产公钥的 source 配置，私钥仅在受保护签名 Environment；真实安装验收仍开放。

**安装协调契约**：`packages/contracts/src/linxUpdateInstall.ts` 固定受限 request/journal、attemptId、目标清单摘要和维护/窗口响应。活跃计数非零或未知时不得编码为 `ready/committed`；窗口有未保存/保存中的编辑时不得确认 ready。绝对路径只是声明，不授予写入权限；helper 仍须独立绑定真实父进程、固定应用路径和私有 attempt，不能采用调用方公钥。主进程维护/安装接线已实现；契约、单测和隔离原生演练仍不能代替 LU-AC-07/09。

### AD-04：自动检查、显式下载安装

建议调度初值（实现可在评审时调整）：应用启动稳定后约 60 秒检查，运行期间每 6 小时检查；持久化最近尝试时间，休眠恢复不补发积压请求。保留手动检查，自动/手动请求单飞；遵守 GitHub 限流和 Retry-After，不形成后台高频重试。应用关闭时不检查。

检查允许下载版本清单、签名及必要发布说明，**不得预下载应用包**。自动检查失败保留上次成功结果及时间，标明结果过期；手动检查报告具体错误，不把离线/限流显示为“已是最新”。后台不反复弹窗。

点击“升级并重启”固定目标版本和清单摘要，授权此次下载、校验与安装；下载过程中发现更新版本不偷换目标。普通退出不安装，重启后不恢复自动安装授权。若有任务、审批、未保存状态或预检失败，保留可验证的包，展示阻塞原因，用户解除阻塞后再次点击安装；不后台等待后突然重启。

### AD-05：单一状态所有者与安装维护互斥

主进程拥有检查/下载状态和安装协调，renderer 只发窄 IPC 请求并订阅；业务后端拥有任务、审批、自动化派发和数据兼容状态。辅助程序只执行一次受约束的安装尝试，不查询模型、不创建任务、不维护第二套业务状态。

建议更新状态为 `idle/checking/available/downloading/verifying/ready/preparing/installing/error`，安装结果在下次启动确认；每次安装使用唯一 attemptId，状态变更绑定目标版本和清单摘要。适配现有状态机和错误上下文，避免另建前端状态权威。

安全门禁必须覆盖竞争窗口：预检空间和目录权限 → 通知所有窗口处理未保存编辑 → 后端进入维护态拒绝新派发/写入 → 排空已接受操作并确认无活动任务/审批 → 停止后端并验证退出 → 获得独占数据维护锁 → 创建并核验恢复集。不能只查询一次“空闲”后直接退出。多窗口、后台自动化及其他同 home 实例均在保护范围。失败释放锁、恢复可用状态并报告真实结果，不强杀用户任务以通过安装。

### AD-06：重启与数据健康才算成功

安装记录关联 attemptId、源/目标版本、清单/包摘要、恢复引用、替换阶段和健康结果。“包下载完”“主进程退出”“辅助程序返回”均不等于成功。新版启动确认实际版本、正确 home、迁移完成、后端 ready 和必要投影健康后确认成功。

数据库迁移仍遵循既有追加 ledger 与已应用脚本冻结规则。恢复集覆盖数据库及必要配置、专家/技能资产和受管引用，不每次复制整个源码工作区。新程序尚未启动/写数据前的替换失败可恢复旧应用；一旦可能运行了新版本，除非有可信的未写入证明，否则禁止自动启动旧应用读新库。程序恢复与数据恢复分开，新版写入或迁移后优先更高版本修复；恢复旧数据需要明确告知影响和用户授权。

### AD-07：独立辅助程序安装，不绕过系统保护

选择方向是“复用现有检查/UI/恢复能力＋受限辅助程序”，不是关闭 Squirrel 校验或把 GitHub 文件直接执行。辅助程序随已信任的 Linx 包分发，由现有应用启动并在应用退出后继续；不从 Release 下载任意安装脚本，不建立常驻高权限守护进程。

工程边界：

1. 只更新当前确定的 Linx 应用路径。确认不是从 DMG/只读卷或 App Translocation 临时路径运行；确认目标 owner、可写性、实际路径与身份。不允许 renderer 或清单指定任意文件替换位置。
2. 候选在私有 staging 中解包，限制文件数/展开大小；拒绝路径穿越、绝对路径及逃出包根的符号链接，同时保留 Electron framework 合法包内链接。检查 app 元数据、arm64 组件和 ad-hoc 结构完整性。
3. 在同一文件系统准备候选与恢复路径；等待主进程及相关子进程准确退出，锁定安装路径，并重验候选、清单和目标。不能仅凭可复用 PID 或启动时一次检查。
4. 写入可恢复的阶段日志，保存旧包，再执行平台支持的安全切换。不能将两个 rename 宣称为整体原子操作；中断后的每个阶段必须能判定哪个包可用，任何时候不先删除唯一可用旧包。
5. helper 及日志不能因旧 app 被移动而丢失；helper 在用户私有、权限受限的运行位置执行并验证来源。主进程到 helper 的请求绑定一次性 attemptId、固定路径与摘要；helper 自己复核，不盲信参数。
6. 重启只启动固定目标 Linx。系统拦截时停止并显示安全提示/外部恢复说明，不自动 `xattr` 清 quarantine、不关闭 Gatekeeper、不要求为更新长期授予管理员权限。目标目录不可写则明确拒绝并提供手动安装说明，不偷偷提权。

**可行性门禁**：以上是待开发的安全设计，不是已验证的平台能力。必须先在 macOS arm64 隔离环境，用真实 GitHub 下载来源的两个 ad-hoc Linx 包验证下载、退出、替换、重启、系统拦截及中断恢复。若只有清除隔离属性或关闭系统保护才能通过，门禁失败；返回设计决策，不能把手动拖拽替代品当作自动安装完成。

## 4. GitHub 发布流程

### LU-03A：版本与审批规则

- 普通 push/PR 只运行 CI，不持有发布私钥或仓库写权限。建议正式 tag 为 `vX.Y.Z`，仅允许已确认的 main 提交；以配置和 tag 校验最终应用版本，不重用旧 Synara 更大版本号。
- 唯一发布记录绑定 tag、精确 sourceCommit、锁摘要、平台、产物摘要和 CI run。构建始终 checkout 固定 SHA；版本标签不移动。
- 维护者审批固定候选及其摘要，不是笼统批准“最新”。审批后任何字节变化都要重新验证和审批。

### LU-03B：构建、清单签署与公开

- 复用现有 macOS arm64 构建，生成首次安装 DMG 和更新 ZIP；保留运行所需 ad-hoc 签名，不要求 Developer ID、公证或 Apple 凭据。
- 质量检查、包内身份/架构验证、启动 smoke 和本次适用迁移验收通过后，按实际 ZIP 生成清单和签名，上传候选资产到草稿 Release。
- 自有私钥只在受控可信发布 job 可用，绝不暴露给 PR/fork 代码。仓库写权限仅限发布 job；临时凭据用完清理，日志不可记录私钥。
- 建议用受保护 GitHub Environment 执行发布审批；LU-00 核对当前账号/仓库是否支持并实际启用 reviewer。若不支持，须配置同等可审计的维护者发布入口，而不是继续自动公开。
- 公开前下载候选资产复核摘要、签名、文件齐全及来源，审批 job 只提升同一候选，不重建包。失败不向普通客户端暴露新版本。
- GitHub 不是多文件事务数据库：先完整上传草稿再公开，同时客户端必须验证全部清单字段/签名/包摘要，不能依赖“页面可见”保证资产正确。

### LU-03C：重试、坏版本与发布后核查

- 重试只能复用同一固定源码和已核验候选；同名资产摘要不符立即停止。已公开版本不可覆盖，修复发更高版本。
- 公开后从匿名客户端路径下载并核验所有资产，确认自动检查只能发现合格 Linx 版本。不依赖可读草稿的维护者 Token 验证普通用户可见性。
- 严重坏版本应停止继续分发并发布修复版本；撤下 Release 不能撤回已下载的包。安装前在线重验同一公开 Release/资产仍有效；离线时保留包但不安装。目标被撤下或内容改变时取消此次授权，不换成别的目标安装。重验与替换间仍有不可消除的撤回竞态，不承诺远程即时召回。
- 每次发布保留准确版本、检查结果、已知问题、恢复说明。首次通道必须完成 B0→B1 的实际升级，后续按改动风险做相应验证。

## 5. 用户交互与工作包

交互：自动发现新版后只提示版本/说明；点击升级展示下载和验证进度；进入安全门禁后说明重启；有阻塞时显示原因及“再次安装”动作。错误区分检查、下载、验证、准备、替换、启动和迁移。发布说明按不可信内容安全渲染。

复用现有菜单、Sidebar 订阅、更新按钮和通用弹窗，不新建更新中心页面或改主布局。界面设计按现行 SOP 确认。产品独立不授权开启原版 Beta 诊断采集，也不允许通过统一 flavor 顺手开放受限能力。

### LU-00：配置契约与安装可行性门禁

- 固定首批 darwin/arm64、不依赖 Apple 付费方案、自动检查/点击下载；按已选择的全新内部身份冻结具体标识与迁移/恢复契约，收敛 Q-04 发布源，检查实际运行版本、安装位置、数据归属及 GitHub 审批能力。
- 首先验证 AD-07 的双版本真实辅助安装路径。清单签名算法/库选型核对当前 runtime API 与 helper 执行环境后固定，形成发布/客户端共享的协议样例。
- 交付可行性证据、身份配置、可信公钥管理、恢复边界和 UI 状态草案；失败时保留证据，不假装正式升级已具备。除安装相关实现外的独立工作可继续，但正式发布联调不能越过门禁。

### LU-01：Linx 品牌、版本与旧入口退役

- 依赖 LU-00 的身份决定；更新 desktopIdentity、桌面 package、构建身份、build-config、品牌/发布文档；最终包只有一个产品版本权威，不重命名全部内部 import。
- 清理默认上游 sync、官方 bridge、自动 Beta/npm 发布和无调用专用代码/测试；共享质量、平台、迁移检查保留。远端停用需对应授权并单独记录，不把源码删除当作远端完成。
- 验收名称、版本、安装身份/home/profile 一致；旧数据可见、无双写、权限未被放宽。

### LU-02：自动检查与点击下载状态机

- 依赖 LU-00 协议；复用 main/updateState/updateMachine/preload 和现有 Web 订阅，跨进程契约放 contracts。
- 自动/手动检查共用单飞和限流；接入清单验签、版本准入、显式目标授权、下载进度与错误。Linx 不走会自动下载或 Squirrel 安装的旧调用分支，不能保留两个安装引擎竞争。
- 验收启动/计时器会检查但没有包下载；点击才下载；重复点击和晚返回不启动第二次安装，普通退出/重启不延续授权。

### LU-03：GitHub 发布自动化

- 依赖 LU-00 契约，最终集成依赖 LU-01；按第 4 节 LU-03A/B/C 实施。复用现有 release.yml/release-platform.yml、构建器和 provenance/smoke 能力，替换不适用的 Apple 付费门禁与官方 feed 政策。
- 验收正式 tag、候选签署、人工确认、完整公开和匿名下载闭环；不得在文档中写“支持审批”却未核对远端配置。

### LU-04：辅助安装、运行保护与恢复

- 依赖 LU-00 的可行性通过；联调依赖 LU-02/03。复用现有安装准备/marker、后端停止及备份服务，新增受限 helper 和持久阶段记录，不新建业务队列。
- 实现 AD-05～07；恢复集只覆盖必要用户资产，维护锁跨主进程/helper 交接不留写入窗口。新 app 启动前明确释放/转交锁，迁移期间仍排他。
- 验收任务竞争、未保存状态、磁盘/权限不足、备份失败、解包攻击、进程中断和系统拦截。只有“新包尚未运行且数据未变”才可自动恢复旧程序；其他情况停在可诊断恢复状态。

### LU-05：引导安装与正式双版本升级

- 依赖 LU-01～04、适用质量门禁与身份决定。先手动安装建立可信公钥的 B0，再发布 B1，通过 B0 自动发现并点击升级。B0/B1 是角色名，不预占 SemVer。
- 覆盖旧 Workbench→Linx 引导、B0→B1 自动替换、无迁移与有迁移路径、系统提示、数据保留及恢复。手动入口是首次引导/故障恢复，不代替 B0→B1 的自动安装验收。
- 绑定源码/标签/摘要记录真实结果；日用安装、公开发布按对应授权执行。完成开发、合入、发布、安装和用户验收分别登记。

依赖：`LU-00 → LU-01/LU-02/LU-03/LU-04 → LU-05`。协议固定后各工作包可独立推进，共享 main/契约由一名集成负责人管理；本计划不自动创建任务或派发线程。工期由可行性和当前基线实测后估算。

## 6. 验收矩阵

- **LU-AC-01 品牌与身份**：名称 Linx；包版本一致；旧数据、深链、登录项和必要权限行为可核对；错误 home/双实例写入被阻止。
- **LU-AC-02 可信来源**：拒绝错误公钥/签名、被改清单、损坏包、错误产品/架构、同版/降级/预发布、未知 schema；无有效清单不得回退官方源。
- **LU-AC-03 更新触发**：启动与运行期间自动检查，手动入口可用；点击前不下载应用包，普通退出/重启不安装；自动失败不反复弹窗，限流无请求风暴。
- **LU-AC-04 发布门禁**：固定 SHA/tag、最终包版本、清单和远端字节一致；公开前人工批准精确候选；失败候选普通客户端不可见；同版本不可改写，PR/fork 无私钥和发布权。
- **LU-AC-05 并发保护**：重复点击幂等；维护期间拒绝新任务/自动化写入；运行/审批/编辑阻塞时不退出；失败释放维护状态；旧请求不能安装新目标。
- **LU-AC-06 故障恢复**：离线/限流、下载中断、空间不足、权限不足、备份失败、辅助程序中断、系统拦截、版本未变分别可诊断；不误报成功或循环重装。
- **LU-AC-07 真实升级**：macOS arm64 上从 GitHub 真实下载 B1，由 B0 点击后完成退出、替换、重启、后端健康；不得以本地免隔离包或手动拖拽替代。
- **LU-AC-08 数据恢复**：聊天/专家/技能/配置及必要受管引用保留；有迁移/无迁移分别验收；数据可能已变化时不自动启动旧版，不静默覆盖更新后的新增数据。
- **LU-AC-09 首次承接**：旧 ad-hoc 应用→Linx B0 的手动引导、可信公钥建立、安装路径和权限提示有实测证据；不以 Developer ID/公证为通过条件，不通过削弱系统安全过关。
- **LU-AC-10 退役与资源**：旧默认同步/发布入口退役、远端状态另有回执；恢复引用有效，新恢复集验证后才轮换旧包；本批不宣称 Intel/Windows/Linux 支持。
- **LU-AC-11 辅助程序边界**：目录穿越、包外符号链接、任意目标路径、伪造 attemptId、候选被替换、PID 复用不能造成任意写入或错误安装；合法 framework 链接保留；中断后至少一份可恢复包存在。
- **LU-AC-12 撤回与密钥**：撤下/变更目标后禁止继续安装；离线保留包但不安装；按可信旧钥授权轮换，未知网络公钥不能自行生效。撤回竞态和私钥泄露的人工恢复边界明确说明。

实施最终门禁：`bun run fmt:check`、`bun run lint`、`bun run typecheck`、受影响 Vitest 及跨生命周期的 `bun run test`。宿主接入清单同步并执行 `bun run workbench:check-boundaries`；涉及平台/进程边界执行 `bun run windows-runtime:check`（静态检查不等于支持 Windows）；迁移变化执行 `bun run migrations:check`；品牌变化执行 `bun run brand:check` 并更新其 Linx 合约。

UI 实际操作、真实安装器/系统安全行为、GitHub 资产分发、迁移恢复分别留证。源码测试不能代替真实更新。正式协议和算法冻结前补充可信来源研究及安全审查，不直接把建议字段或状态当成已存在 API。

## 7. 决策状态与实施阻塞

- **Q-01 已解决**：首批 macOS Apple Silicon；其他平台不在本批范围。
- **Q-02 已解决（产品方向）**：不购买 Apple 开发者会员、不依赖 Developer ID/公证。仍需建立自有更新清单签名和完成 AD-07 实机门禁，不代表平台可行性已经通过。
- **Q-03 身份与迁移设计已批准，实施/实测未完成**：具体标识按 AD-02；单向迁移必须保全草稿与受管路径，不能只复制 `userdata`。最终包和真实迁移仍须验收。
- **Q-04 发布源已选定，受控前置配置已获授权**：用户批准沿用 `WYLINX601/synara--expert`，继续 main、不创建 PR，并授权门禁通过后的提交/推送、正式 tag/发布及隔离升级演练。更换仓库、改名/可见性或删除历史 Release 均不在授权内；日用应用和个人数据迁移仍须隔离验收通过后另行确认。
- **Q-05 本批沿用既有图标**：名称已确认；第 1 节明确排除新 Logo 设计，因此不以新 Logo 决策阻塞本批开发，也不借改名改主布局。后续如改变视觉资产，另行提交可审查方案并取得授权。
- **Q-06 实机阻塞门禁**：目录可写性、quarantine/Gatekeeper、helper 生命周期、跨进程锁和中断恢复必须真实验证；未通过不得声称“无需付费即可无提示自动升级”。
- **Q-07 签名托管及单人显式审批已配置，正式候选未发布**：2026-11-16 用户明确允许 owner 发起并亲自批准同一发布，仍须两次 Environment 审批、固定 source/candidate digest 且禁止管理员绕过。两个真实 Environment 已指定 `WYLINX601`、`prevent_self_review: false`、`can_admins_bypass: false`，部署仅限 `v*.*.*` tag。生产 Ed25519 私钥仅存 `linx-signing` secret，实际公钥 `1113c8bdec541a20` 已提交。用户选择短期 `GITHUB_TOKEN`：预检只读，签名/发布复检共享该任务已有写权限，不配置长期 PAT；真实 workflow-token 能力、精确 bootstrap SHA 批准和正式候选仍待验收。

## 8. 工程交接、历史变更与验证

继续完成 LU-00 安装可行性及 LU-01/03/04/05 全部剩余开发；身份、发布仓库、自动检查/点击下载和 CI 托管方向已批准，不重复索取这些决定。真实数据、远端设置、推送/发布和日用安装操作分别取得授权。按 LU-AC 提交证据，未通过真实安装与升级门禁不得关闭整体目标。

本文是本需求唯一开发计划；确认后的长期约束按[架构标准](./workbench-adaptation-plan.md#current-standard-v11)归档。实施时同步[发布指南](./release.md)、[开发 SOP](./workbench-development-workflow.md#execution-sop)、[项目入口](../context/PROJECT_CONTEXT.md)，历史上游材料只作追溯。当前文档不把既有代码/远端工作流伪装成已切换。

复用已有开发树、隔离预览及单一交付根；大构建前核对容量。不复制整库作为每次备份，不删除唯一用户数据；新恢复集验证且更新恢复入口后才轮换旧产物。

### v0.2 对 v0.1 的替代关系

- D-03 / AD-04 / LU-02 / LU-AC-03：改为自动检查、点击后才下载安装。
- D-05 / Q-01：平台由待定变为 macOS arm64。
- D-06 / AD-03 / LU-03 / Q-02：取消 Apple 付费签名与公证前置，改为自有可信更新清单与必要 ad-hoc 包处理；二者不可混称。
- AD-07 / LU-00 / LU-04 / LU-AC-11：增加独立辅助安装及先行可行性验证，不再假设可直接复用 Squirrel 安装器。
- D-07 / LU-03A～C：补齐标签触发、精确候选人工审批、失败重试和发布后核验。
- Q-03：v0.2 编写时保持待决策；2026-11-13 后续方向见 D-09，不追认迁移操作授权。原 LU-AC-01～10 编号保留，追加 11～12。

### 验证边界

v0.1 曾核对 16 处本地链接、8 个命令入口、6 个工作包、10 项验收编号；这是历史文档检查，不自动继承到 v0.2。

v0.2 实际文档检查 PASS：15 处本地链接及所含锚点可解析；8 个引用命令存在；AD-01～07、LU-00～05、LU-AC-01～12 连续且唯一；代码围栏成对。检查清理了“启动/计时器不检查”“关闭自动检查”“建议 Apple 付费签名公证”“B0/B1 连续 Apple 签名身份”四类旧要求；项目入口已同步 v0.2，持久身份仍明确待决策。

2026-11-12 方案编写轮次未重新审计全量代码，未运行应用测试、构建、签名、GitHub 发布、辅助安装或迁移恢复；该轮次只修改计划与项目入口，无新增服务、工作树、依赖或安装产物。后续开发与补验证据分别登记，不把这段历史边界当作当前实施状态。

### 2026-11-13：LU-00/LU-02 开发与补验

- 已提交：`b6e004c60987920b93c8fa16c297a8d75c07b22d` 为 LU-00 清单协议切片；`8fcab5aa5b317c03c1d218e2e8b539708194e968` 为 LU-02 检查/点击下载及获授权的最小 Web 文案/按钮修正。不是 LU-00 安装可行性、LU-01 品牌迁移、LU-03 受控发布、LU-04 辅助安装或 LU-05 真实升级的完成声明。
- 全量覆盖经根 `bun run test` 调度按包执行，Server 使用既有 CI 的 `--shard=1/3`、`2/3`、`3/3`；复用先前 Contracts/Desktop 已通过结果。不是一次未中断的全量命令；退出 143 的中断结果与原始失败日志均保留，完成的包未重复执行。19 个被监测文件在各续跑任务前后指纹未变，不等于核对了整个工作区的所有文件。

| 范围      | Passed | Failed | Skipped | 说明                       |
| --------- | -----: | -----: | ------: | -------------------------- |
| Contracts |    346 |      0 |       0 | 复用已完成结果             |
| Shared    |  1,175 |      0 |       2 | 完整包                     |
| Scripts   |    495 |      0 |       0 | 完整包                     |
| Web       |  5,976 |      0 |       3 | 完整包                     |
| Desktop   |  1,681 |      0 |       6 | 复用已完成结果             |
| Server    | 10,731 |      1 |      36 | 三片汇总，修复前           |
| 合计      | 20,404 |      1 |      47 | 保留原始失败，不回写为全绿 |

- 唯一失败为 `apps/server/src/open.test.ts` 的 Windows Store VS Code 发现用例；本次用时 1,520 ms，既有交付日志也曾记录同项 1,516 ms 失败，探测超时为 1,500 ms。相关三个运行/测试文件与更新开发前一致。独立真实子进程诊断成功（280 ms）；原始探测捕获并丢弃底层异常，超时是有证据支持的推断，不冒充已捕获的错误码。
- 修复只替换该用例的外部 PowerShell 夹具：按现有测试约定限定 mock 生命周期、清除发现缓存，断言无 CLI 时只发现已注册的 VS Code，移除失用 shell 夹具。不修改 Server 运行代码、不增加生产超时、不跳过用例。修复后经根调度执行 `src/open.test.ts` **18/18 通过**，受影响 typecheck **4/4 通过**、该文件 lint **0 warnings / 0 errors**。没有再重跑已完成的全量，不能把它写成修复后完整 workspace 单次通过。
- 复用已完成的 workspace typecheck 7/7、Web/Server/Desktop 构建及 Electron 未配置源启动 smoke。仓库 lint 已执行且无错误；原有 warning、Turbo 锁文件解析 warning 保留。仓库级格式与 brand 检查原先的失败不因补验自动转绿；未改用户并行文件及历史来源记录。
- Electron 43.4.1 / Node 24.18.1 运行真实 LU-02 客户端：实际观察 `checking → available → downloading → downloaded`；点击前包请求 0、点击后 1；下载真实 ZIP 139,404 字节并匹配 SHA-256；重复点击被拒、篡改清单不下载、安装被拒、退出清除 staging。仅通过既有注入点将地址映射到本地夹具，不代表正式 GitHub 分发、完整主进程 IPC、代理或安装验收。
- 浏览器实际渲染 `DesktopUpdateRailButton` 与已构建 CSS：Workbench 可用态能点击，点击一次后为 42% 下载中且禁用；production 可用态仍禁用。已检查截图；状态由夹具驱动，不是完整 Sidebar、原生菜单、IPC 或真实升级证明。
- GitHub 真实传输探测 `releases/latest/download/linx-update.json` 返回 **404**；这是没有已发布 Linx 清单的失败回执，不是正式更新成功。Node HTTPS 对 Electron 系统代理/PAC 的支持未验证，当前实现没有证明该能力。
- 本地详细回执位于 `.synara/expert-evolution-delivery-20261029/operations/linx-update-verification/verification-8fcab5aa5.json`，原始续跑日志位于 `/tmp/linx-verification-8fcab5aa5/`。临时浏览器、夹具服务、隔离 home 和一次性源码已收尾；没有生产密钥、正式更新源配置、真实数据迁移、应用安装、PR、推送或 Release。

### 2026-11-13：完整方案批准与安装身份约束

- 用户已选择“批准并继续”完整剩余实施方案；设计风险为 high，不把迁移/替换失败降格为普通下载错误。
- 必填安装身份的回归先观察到 3 项失败，修复后 49 项通过；新增安装/维护契约 26 项、共享验签 29 项、签名/CLI 19 项、原客户端 24 项通过。删除了只固定协议常量值的实现细节测试。
- 实际运行签名 CLI：临时测试钥签署的 Linx 身份清单通过；同一测试钥有效签名的 Workbench 身份清单以 `reason=schema, field=installIdentity`、退出 1 拒绝。只验证协议和 CLI，没有验证该夹具描述的 Release/包；临时私钥与夹具已删除，没有生产密钥。
- 独立 Bun 1.4.4 helper runtime 探针完成编译、ad-hoc 验签、私有目录执行和原件移位后的验签；两份各 89,178,064 字节已删除。未执行真实替换、Gatekeeper、quarantine 或数据迁移；不把该探针当作 LU-00 整体可行性通过。

### 2026-11-16：续跑集成与原生边界验证

- 仍在 main 工作树推进，未开 PR、未推送。安装授权不再复用下载前可能过期的 receipt：helper 启动前和最终交接前均在线重验同一固定候选。实际错误保持可恢复，交接只返回 accepted，不返回升级 completed。
- 实际 Electron 43.4.1 暴露 `session.fetch({redirect:"manual"})` 对 302 抛出 `Redirect was cancelled`，已切为绑定同一 Session 的 `net.request` 手动重定向；Feed 继续逐跳执行白名单。实际系统代理、隔离 fixed/PAC、TLS 拒绝、限流、取消/超时及背压 **19/19** 通过；32 MiB 响应暂停时下游缓冲 65,536 字节。批准仓库的匿名 API 与既有 Workbench v0.1.3 provenance 资产 302→200 通过，**不是 Linx 发布验证**。未修改 OS 代理或放宽 TLS。
- 真正编译的独立 helper 使用 mise Bun **1.4.4**，89,725,168 字节，arm64/strict ad-hoc 验签与 minimum macOS 13.0 通过；**10 个真实子进程场景**覆盖原生父进程/kernel 身份、认证 prepare→cancel、错误 nonce/digest/路径/资源/签名候选等拒绝。旧 fixture seal 保持有效，home/profile 为空。先前误用环境 Bun 1.4.0 的三份结果明确保留为 invalid-wrong-toolchain，不用于结论，也不据此抬高系统要求。未执行正式 commit、替换、LaunchServices、Gatekeeper 接受或新版健康。
- 原生 Swift AppSnap helper 的两次新租约、两次错误/旧租约释放拒绝、两次暂停期间捕获拒绝已实跑；未截图真实屏幕或修改权限。原生 C bridge 的 5 项检查、资源叉和 provenance 保留为独立证据，不等于系统允许升级。
- Server 维护准入及观察者 **86 项**通过；真实 Chromium 的协调器/Monaco **15 项**、IndexedDB/水合/存储失败 **8 项**通过。浏览器夹具类型修正及最终整合以后续门禁为准。最小真实更新控件实测一次点击进入 42% 禁用态、中文空间拒绝、再次点击进入准备禁用态；状态由隔离夹具驱动，不是完整 Sidebar/IPC 或真实安装证明。
- 错误 IPC 仅传固定 failure 枚举，不回显路径、nonce、schema 输入或凭据。空间/配额、权限/只读、最低系统版本和各安装阶段使用既有本地化资源；配置验签错误同样不回显未知 key-ring 输入。
- 原始失败和通过回执统一在 `.synara/expert-evolution-delivery-20261029/operations/linx-update-verification/`：`standalone-helper-qualification.json`、`native-proxy-qualification*.json`、`native-maintenance-qualification.json`、`update-ui-qualification.json`。相关一次性源码、测试钥、fixture 应用、原生二进制、隔离浏览器和服务已按各回执收尾。
- 最终 workspace 测试与整合检查仍须完成；未把历史通过或单项通过改写为全目标完成。生产公钥配置、受保护 CI 的真实审批回执、正式候选/匿名完整分发、首次引导和真实 B0→B1 仍待分别授权与执行。

### 2026-11-16：审查修复与剩余验收

- 三轮定向源码审查发现的缺口均登记在实施记录，逐项修复而非缩减 LU-AC。当前追加迁移任务为 copied Codex generation、账号私有 overlay 和 live continuation bindings；完成实现、兼容性验证以前不关闭迁移验收。
- 原生准备失败的旧清理路径会提前终止 helper，随后父安装器的 cancel 无法取得 ack，错误进入 recovery-required。系统版本/空间/metadata 三项单测先失败，修复后 helper 核心 **37/37** 通过；真实原生协议另行验证，不把 mock 平台单测称为原生安装证据。
- 候选期望改为直接从受认证 ZIP 解压流计算，认证与解包共用固定文件句柄并检查最终身份；不再以可写解包目录自证。helper 的期望 SHA-256 固定在运行中的 main 构建，最终资源不得再次签名改变；目标锁保留稳定 guard，以原子 owner 记录恢复中断，guard-only 目录不是未释放的安装所有权。
- 真实 Bun **1.4.4** / `/usr/bin/ditto` smoke 发现 `café.txt` 被解码成 `caf├⌐.txt`；原生 ZIP 未设置语言位但使用 UTF-8。严格解码原始 UTF-8、核对中央/本地头和 Unicode extra field 后，archive **25/25** 及真实文件系统四项 smoke 通过：内容 inventory、framework/Unicode 路径、独立启动复核、被替换候选拒绝。回执为 `archive-content-qualification.json`，仅为该源码快照的归档路径，不代表完整安装。
- 非图片附件拒绝、OAuth 回调全生命周期和服务 scope 摘要计时器已补齐；当前 Chromium durability **11/11** 通过。真实 Electron renderer/preload/main 的同步只读 IPC、同步写拒绝、异步写拒绝和释放恢复 **4/4** 通过，回执 `native-ipc-qualification.json`；这是隔离窗口/夹具通道，不是完整主程序升级。
- 当前第二轮整合的 Desktop/native/controller/migration 四个测试文件 **88/88** 通过，shared recovery **37/37** 通过。后续 continuation 迁移仍在修改，这些结果不得冒充最终 workspace 门禁。完整测试曾失败，续跑在发现新增安全缺口后主动停止；原始失败和取消状态保留，最终检查尚待整合稳定后完成。两处无关格式失败未擅自修改。
- 2026-11-16 远端只读核验：仓库公开、默认 main；Environment 为 0，旧 `Release Desktop` / `Release desktop platform` / `Workbench weekly upstream sync` 仍 active；`v0.1.15` ref 为 404。未做任何远端更改，源码退役不等于远端退役。
- 先前 `native-helper-commit-qualification.json` 的六场景属于其记录的旧源码快照：包括所有权交接、中断恢复和替换/LaunchServices 后等待健康超时；**没有新版健康成功**。后续内容认证与永久 guard 修复不能继承该回执作为当前完整安装资格。生产密钥、公钥配置、真实受控审批/公开分发、首次引导、B0→B1、个人数据迁移仍未执行。
- 当前 helper 重新编译并完成五项原生资格：arm64/ad-hoc seal、无效入口拒绝、最低系统版本、认证 OS 拒绝后的 cancel/ack、完整隔离 main 构建中的最终 helper 摘要绑定。回执 `helper-build-binding-qualification.json` 记录精确源码/二进制摘要；fixture 总量 272,628,550 字节，临时钥/原生父程序/helper/main 产物已移除。未替换或运行日用 Linx。
- 第四轮迁移修复覆盖真实 macOS contained aliases、账号私有文件/入站链接、原生 `config.toml` 的受管 root `sqlite_home`、原始 `~` 目录拼写及只读源凭据证明。源设置、敏感目录值和 copied 配置分别验证，不以新设置自行授权旧 cursor；仅同一被验证目录的 canonical/alias 拼写可等价，其他账号目录仍拒绝。Desktop 显式依赖既有 `smol-toml@1.9.0`；共享 source identity 使用异步 IO，不增加同步 IO 预算。
- 最新 Desktop migration **41/41**、Server binding migration **26/26** 通过。原生链接先有三项失败，修复后 root `sqlite_home` 三项仍失败，分别补齐；原始拼写/源凭据先有十一项失败，canonical copied path 后又有两项失败，均已回归。多进程原生用例曾触发 5 秒测试超时及清理竞争，现只为该组设置 30 秒界限；遗留的自有临时目录经无句柄核对后删除。
- 真实 Electron **43.4.1** / Node **24.18.1** / SQLite 演练 **7/7** 通过，关闭后重开真实 ProviderSessionDirectory 的两条绑定，验证原生 aliases/私有 auth、受管 sqlite_home、Claude/Codex 启动兼容、cursor/generation/model/fixed Expert 保留、重复迁移和旧源六类文件字节不变。回执 `continuation-migration-qualification.json` 固定源码摘要。浏览器 storage 是空适配器，未运行真实 Provider/完整 Server 启动；不得作为个人数据或 B0→B1 验收。演练脚本、打包程序、临时 profile/home/数据库/恢复集均已收尾。
- 当前类型检查曾达到 **7/7**；静态门禁最近通过品牌、Windows 边界（368 应用文件/138 边界文件/5 补丁/9 manifest）、103 release tags 的迁移 lineage 和 140 文件的宿主边界。后续迁移修复及依赖声明后仍须执行最终门禁。最近 lint 的 **1341 warnings / 0 errors** 后同步 IO 门禁曾失败，异步修复尚待最终核验；不得把这次 lint 记录为通过。
- 第五轮闭合审查发现合法 TOML 指令字符串可吞掉后续 root assignment；单项回归先失败，改为重叠候选且仍由完整 TOML 等价证明后 Desktop migration **42/42** 通过。真实 Electron 的三项配置迁移 smoke 验证仅 root 值变化、源/恢复配置字节不变；`native-config-qualification.json` 记录源码摘要。`desktop-bundle-qualification.json` 另证四个 Desktop 入口在直接 `smol-toml` 依赖下构建通过；隔离输出已移除，不覆盖签名/安装资格。
- canonical source receipt 对 live cwd/folders 的 lexical 比较另有三项真实链接回归先失败；新 async ownership resolver 的真实 Bun **1.4.4** 五项 smoke 覆盖合法别名、缺失后代、源 external/dangling 链接、目标越界拒绝及源字节不变，见 `live-path-qualification.json`。完整绑定/项目联动回归仍待当前启动修复整合。
- 崩溃导入的真实 SQLite/engine/decider 证明：未收敛 orphan turn/checkpoint 时，`project.meta.update` 因 busy-folder invariant 拒绝，不能完成迁移。正在复用原生 replay/恢复意图/settlement，在生产者未发布前完成收敛；不放宽正常准入。最初集成红测还暴露新增必需 callback 未接线，已单独保留，未把 TypeError 冒充 busy guard 证据。
- 本轮静态门禁再次通过相同品牌/Windows/迁移 lineage/宿主扫描范围。类型检查为 **6/7**，失败为源配置对象缺少 index signature 的三条 TS7053，已补准确局部类型；该串行命令未运行 lint。当前新增启动联动仍在修改，最终 typecheck/lint/root test 尚未完成。
- 原生启动协调已用真正的 Node **24.13.1**、磁盘 SQLite、生产 settings/engine/replay layers 在 Vitest 外完成 **6/6** 演练：accepted/pending 输出保留、orphan 中断后才通过目录准入、canonical receipt 搬迁项目别名、恢复意图持久化、历史/源字节不变及关闭重开幂等。配置与数据为隔离夹具，没有启动 transports/producers/真实 Provider；`native-startup-qualification.json` 固定执行源码摘要。临时 home、数据库、profile、脚本和 bundle 已清理。
- 九文件聚焦检查先记录 **296 通过 / 8 失败**；八项均停在新测试夹具对未水合 summary flag 的错误断言，改为原生 thread detail 的持久 pending-interaction 状态后七项通过。图像用例随后补齐真实 group onboarding repository 与源 `userdata` 前置，实际图像迁移、Markdown 保留和源目录不变已通过，未修改生产 busy guard。
- 最终类型检查另外暴露离线 replay 仍依赖 live ProviderService 的 diff capability；四个 Provider 的真实 journal 回归均先因 `getCapabilities` 缺失被 drain fence 拒绝。改为 Adapter 层的穷举只读协议元数据，实际 Adapter 和离线 replay 共用同一事实，在线 service 行为不变；不以 `false` fallback 隐藏差异。
- 闭合迁移审查另外发现：`sqlite_home` 的外部路径拼写可以实际指向受管旧目录，单靠 lexical 前缀会漏迁移。回归先失败，改为先核对 native identity 后 Desktop migration **43/43**，真实 Electron 配置 smoke **4/4**；更新后的 `native-config-qualification.json` 固定此源码快照。
- 离线图像 replay 的真实写入失败会取消固定 reservation，原逻辑后续每次启动都冲突。红测为 **17 失败 / 3 通过**，其中一项是测试夹具违反既有 SQL CHECK，已改用合法 deleting 状态而未放宽 schema；其余复现恢复、配额或 drain fence 缺口。仅排他离线路径可在完整 identity/未 claim/删除原因/配额核验后，事务替换 reservation 并移除复制的 cleanup lease；普通上传不复用。三文件 **47/47** 通过，其中 startup **13**、repository **28**、image staging **6** 项。两处测试 finalizer 类型错误修复后 repository **28/28** 再次通过。
- 实际 Node **24.13.1** / 磁盘 SQLite 在 Vitest 外完成附件重试 **5/5**：真实目录写失败、同操作同 ID 恢复、cleanup job 删除、不重复计费、崩溃 `.part` 恢复且不碰其他 partial、源图片字节保留，见 `native-attachment-retry-qualification.json`。仅单一排他 fixture runtime，不是网络上传、个人数据或完整升级；脚本、数据库、bundle 和临时文件已清理。
- 另以真实 Electron **43.4.1** 的三次独立进程补足非空 Chromium 存储证据：生产 extraction/transfer 保留 localStorage 草稿快照、**600001 字节**多块 IndexedDB blob 和图标记录，拒绝覆盖非空目标，冷重开仍可读，原 profile **46 个文件**字节不变。`native-browser-storage-qualification.json` 记录六项结果。首个夹具因最后窗口关闭而提前正常退出，未计为通过；补明确夹具生命周期后完成。它不替代整 home/真实用户草稿或 B0→B1，所有隔离 profile 和脚本已清理。
- 最后静态品牌、Windows 边界、迁移 lineage、宿主边界检查均通过，扫描范围同前。最后类型检查六包通过，Server 的测试 finalizer TS2379 修正后单包通过；lint/sync IO 门禁通过。根 fmt 检查发现三文件，已修正本次拥有的 startup reconciliation 并单独检查通过；另两处无关格式问题未擅自改动。根 `bun run test` 正在执行，尚不能登记为通过。
- 根测试本次退出失败：Desktop **1901 通过 / 26 跳过**，Contracts **410 通过**；Scripts **563 通过 / 1 失败**（原生 Node 打包 CLI 的 extensionless import），Web **6007 通过 / 1 超时 / 3 跳过**（既有 `viteConfig.test.ts` 的 5 秒配置加载用例）。Server 在五个文件通过后以 143 中断，Shared 未完成，不把它们计为通过。续跑仅覆盖剩余 Server 文件及受影响/未完成包；保留原始日志。
- 打包 CLI 失败已追到 shared process-runtime 的三个模块及 manifest verifier 的 contracts barrel。保留共享进程边界，补可由 Node 解析的 `.ts` 后缀，并提供直接 manifest 公共子路径，避免让构建 CLI 装载整套非必要 contracts。实际 Node **24.13.1** 执行 `scripts/build-desktop-artifact.ts --help` 已成功；对应原生回归及 Shared 检查正在续跑。
- Native TypeScript 的显式 `.ts` 路径需要所有源码消费者使用一致编译规则；只配置 Contracts/Shared 时 Desktop 仍报 TS5097。最终在共同 base 配置启用 `rewriteRelativeImportExtensions`，移除临时包级覆盖。最终 typecheck **7/7**、lint **1343 warnings / 0 errors** 和同步 IO 预算通过；Contracts 在隔离目录实际产出 ESM/CJS 与两种声明文件，原 `dist` 未覆盖，临时产物已移除。
- Server 续跑排除原先完成的五文件，三片各 239 文件，与原五文件共 **722 个互不重叠文件**。第一片四项 Checkpoint 失败来自真实 Git 外另加的 1–3 秒测试等待：保留 gate-held 并发和顺序断言，使用外层测试期限后完整 Checkpoint **140/140** 通过，未修改生产恢复逻辑。其余两片分别 **2585 通过 / 4 跳过**、**3239 通过 / 19 跳过**；Server 去重合计 **10872 通过 / 36 跳过**。
- Shared 首次完整包检查有四项原生 Git fixture 超过默认 5 秒，另出现超时后清理竞态；该组使用明确 30 秒测试期限后 **11/11** 通过，唯一遗留临时目录在无句柄确认后清除。Scripts 的同类 missing-tag 原生场景沿用邻例的 30 秒期限后通过。按原通过结果加失败修复、去除重跑重复，当前合计 **21017 通过 / 1 失败 / 67 跳过**；仍失败的是未修改的 Web `viteConfig.test.ts` 首个配置加载用例，另两处无关格式问题仍保留。此统计是多轮分包/续跑，不是一次完整全绿根命令；Desktop/Contracts 的早期结果不能当作后续 native import 补丁前后完全相同的源码快照。
- 用户随后明确授权修复 Web 配置测试及两处无关格式门禁。删除只断言插件名的测试，直接验证真实 apply 策略的 opt-in/拒绝/优先级十二种边界；不改策略语义。实际 Vite 与 Synara 浏览器的开发关闭/开发开启/test/production 四种模式均完成组件 prop/state 更新，child commits 分别为 **3/1/1/1**，真实源编辑后的 Fast Refresh 保留 `Count: 1 → Clicks: 1`；五项运行演练通过，fixture、服务、浏览器页和脚本均已清理。详见 `web-compiler-policy-qualification.json`，不是整产品 UI 或升级验收。
- 单人审批新回归先红后绿。真实 GitHub protection CLI 另暴露仓库根 API 多余 `/` 导致 404；三项子进程 HTTP 回归先全部失败，修复 URL 组装后 release 五文件 **77/77**，真实双 Environment 检查退出 0。最新去重测试汇总 **21027 通过 / 0 尚未修复失败 / 67 跳过**，仍是原根执行、分片续跑和失败修复的组合证据，不能称作一次根全绿。
- 远端配置已执行但没有发布：三个规则集保护 main 删除/非快进、正式 tag 更新/删除，以及仅 owner 创建正式 tag；后两类限制分离，tag 不可变规则没有 bypass。旧 Release Desktop、Release desktop platform、Workbench weekly upstream sync 已停用；待当前受控源码推送并核对后才重新启用前两个同路径受控工作流。未创建 tag，未设置 bootstrap SHA，未操作日用数据。
- 最后集中检查对应当前工作树：fmt **5739 文件通过**，lint **1343 warnings / 0 errors**、Server 同步 IO 预算通过，typecheck **7/7**。纯格式 Suite validator 已独立提交 `29832c871`；后续逻辑提交只纳入本任务 owned hunks，保留原并行 Suite/Server 和架构文档修改。已逐项审查可见界面差异，仅包括获批的 Linx 名称、既有更新控件/拒绝提示、一次性导入确认与维护期间编辑/重载保护，没有新增页面、Logo 或主布局。
- 逻辑提交 `10f3abad983d5e1804752bcc19eb91f555fab41b` 已推送 main，未开 PR。四个混合文件仅提交 owned hunks，其余原用户修改留在工作区；三个不明归属 `.bun-build` 文件未提交或删除。远端已核对同路径工作流切为 `Linx controlled release` / `Qualify Linx macOS arm64` 后才重新启用，旧周同步源入口已删除。该 SHA 的 Marketing CI 全通过；主 CI 仍在运行。
- 用户另选短期工作流令牌而非长期只读 PAT。发布预检使用 `contents: read` / `actions: read`；签名与提升保持既有 `contents: write` 并增加 `actions: read`，检查步骤共享所在任务权限。无个人管理凭证复制、无审批绕过，也不修改候选绑定；正式运行必须实测 API 能力，失败即停止。
- 手动仅构建入口也执行同一只读 protection 检查，用于实测短期令牌和产出 AD-07 真实隔离包；不触发签名或公开。先完成两个真实包的辅助安装可行性门禁，再进入正式候选及 LU-AC-07 的公开升级，不能用先前夹具健康超时代替通过。
