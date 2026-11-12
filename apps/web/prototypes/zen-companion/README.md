# Synara 协作陪伴交互原型 · 10

状态：10 版四项修复、独立审查及本地 `0.1.15`／macOS arm64 候选包验证已完成，可由用户自行安装验收。09 及更早章节保留为历史；旧 `0.1.14` 候选包不包含本轮修复。工程完成不等于用户验收，未自动安装、提交、推送或发布。

## 10 版：原生气泡、拖动与任务默认隐藏（2026-11-09）

输入仍为 [前端交接 v1.0](./FRONTEND_HANDOFF.md)、[SVG 修订 02](./zen-handle-concept.svg)，加用户明确批准的四项问题修复；固定 BMad 6.13.0-next／`initiative-zen-companion`。计划及稳定编号为 [ZR-01～04／AC-1～3](../../../../_bmad-output/initiative-zen-companion/plan-native-window-and-task-ui.md)，来源为 `61264859dc431e354c57a710448987829ba0def3` 加保留的未提交改造，不冒充干净发布。

- **ZR-01**：Mac 生产 preload 暴露原子 `bubble: { collapse, restore, hide }` 能力。原窗口缩为右下角 36px 气泡，不创建第二聊天、不以 Dock 最小化替代；恢复保留原面板与草稿。右键可隐藏，Dock／原全局快捷键可恢复，不新增系统托盘。
- **ZR-02**：拖动命中区扩大为 `160×32px`，标记 `28×3px` 默认可见。区域置于 DOM 内容之后并报告 CSS 矩形，原生结合真实指针与缩放仲裁穿透；输入／决策区不被遮盖。真实移动、指示条布局和声明式 CSS 是三类不同证据，不互相替代。
- **ZR-03**：普通／禅模式任务列表与独立进度卡默认隐藏，原“任务”入口主动开闭；发送、跟进、任务更新、换聊天不再自动打开。关闭任务不改变原生展开模式，不隐藏消息内执行记录或改变任务 owner。
- **ZR-04**：唯一禅模式启动按钮移至左上角收起侧栏按钮右侧，删除旧聊天头部入口，同步单实例 dock 与占位。

### 本轮实际运行与限制

- 原生用户拖动：窗口 `(98,155,720,180)` → `(166,155,720,180)`，7 次移动／0 次缩放，草稿逐字保持；[原始测量摘要](file:///Users/wangyuelin/synara-expert/.synara/expert-evolution-delivery-20261029/candidate/zen-native-movement-verification.json)。没有用 `setBounds` 冒充输入。自动系统输入权限未授予，本次由用户在隔离窗口实际拖动。
- 用户指出的灰条间距过大来自固定高度的验收页。改用生产测高后自动到 `720×132`，标记距输入下沿 `18.5px`；[原生测量](file:///Users/wangyuelin/synara-expert/.synara/expert-evolution-delivery-20261029/candidate/zen-native-manual-result.json)与[已查看的截图](file:///Users/wangyuelin/synara-expert/.synara/expert-evolution-delivery-20261029/candidate/zen-native-drag-visible.png)保留。此页不连接 Provider，不冒充完整聊天 UI。
- 完整 ChatView 的共享浏览器预览同样实测间距 `18.5px`、非 Hover 时 opacity `0.65`。运行中任务初始隐藏，主动打开显示三项合成任务；关闭后窗口保持展开，后续历史→运行中更新不重开。[已查看的页面 proof](file:///Users/wangyuelin/.synara-workbench/codex-home-overlay/generated_images/browser-proof/d0b42584e92d2b1abd63c575/57d47349-edf6-444f-a531-218e00e447bd.png)为生产组件＋合成数据，不证明原生位移或真实 Provider 成功。
- 生产 preload／原生 manager 隔离 smoke 通过：36px 气泡、恢复／隐藏、迟到 IPC、几何／缩放、草稿、穿透恢复、可用区边界及 reload。完整聊天树保留另由生产组件连续预览验证；没有对日用数据库或全部跨应用／跨屏环境作验收。
- 全仓 `bun run test`：6/6 任务，20,049 passed／47 skipped；该次早于最终灰条 CSS 与两项审查修复。最终受影响包全量 `bun run test --filter=@synara/desktop --filter=@synara/web` 为 web 494 文件／5,962 passed／3 skipped、desktop 133 文件／1,616 passed／6 skipped，合计 **7,578 passed／9 skipped**。最终 ChatView browser 筛选为 **32 passed／290 skipped**；不能称整份 ChatView browser 或修复后的全仓全部通过。
- 最终 `fmt:check` 5,468 文件、lint 0 errors／1,271 warnings、7/7 包 typecheck 通过；Windows 静态边界 338 应用文件／125 边界文件／4 patches／9 manifests、Workbench 边界 136 文件、三语 catalog 5,709 消息通过。warnings 未在本轮清零；`i18n:extract --check` 的 **1,185 findings 未通过**。不将静态 Windows 检查当作 Windows 原生运行。
- 独立 quick／原生审查共确认两项缺陷，均已修复：气泡退出前先 await 原生恢复，避免退出确认 portal 被隐藏；气泡态复用现有快捷键暂停机制，避免较早注册的 capture 消费者打开隐藏搜索。后者新增回归先失败后通过，共享预览实走也无隐藏搜索残留，恢复后搜索正常。
- 原生退出链使用真实 manager／preload／Provider／QuitCoordinator 与实际主进程函数验证：[修复前](file:///Users/wangyuelin/synara-expert/.synara/expert-evolution-delivery-20261029/candidate/zen-quit-check-before.json)两条气泡路径均看不到确认；[修复后](file:///Users/wangyuelin/synara-expert/.synara/expert-evolution-delivery-20261029/candidate/zen-quit-check-after.json)恢复 `720×160`、按钮底边约 `128.42px`，取消保留原几何，确认返回允许退出，草稿保留。应用真正终止被运行器截获；隔离表面未初始化整套主题，也未验证日用进程退出。曾因验收页漏正式 CSS 扫描产生假裁切，已补齐并撤去试验性的自动展开，未将其作为产品改动。
- 实际 `0.1.15` 应用使用隔离 home 与真实本地后端，未安装、未发送模型任务。完成工作台→紧凑 `720×151`→气泡 `36×36`→恢复→展开 `720×560`→返回原 `1422×918` 工作台；六个检查点始终同一窗口、同一编辑器与完整 17 字中文多行草稿，Lexical 状态逐字一致、无消息行。实际包中的灰条间距同为 `18.5px`、opacity `0.65`、命中区 `160×32px`。[原生闭环回执](file:///Users/wangyuelin/synara-expert/.synara/expert-evolution-delivery-20261029/candidate/zen-packaged-native-journey.json)与[已查看的截图](file:///Users/wangyuelin/synara-expert/.synara/expert-evolution-delivery-20261029/candidate/zen-packaged-native-proof.png)可复用；程序化 Electron 输入不冒充物理鼠标拖动。
- 最初未明确编辑焦点的探测出现草稿差异及窗口关闭，未计为通过；明确原生焦点并记录输入事件后，完整闭环及 Hover 均保留草稿，未据未证实原因改产品代码。额外退出探测确认实际包会从气泡恢复并显示确认框，但后续检查前上下文已随退出销毁，不声称完成该次 Cancel 断言；取消／确认以此前生产函数原生回归为准。私有实例正常退出、后端关闭已观测；日志有两次非活动状态的迟到穿透请求拒绝，不宣称控制台无错误。

<a id="local-repair-package"></a>

### 本轮本地候选包与手动安装

- **安装包**：[Personal Workbench 0.1.15／Apple Silicon DMG](file:///Users/wangyuelin/synara-expert/.synara/expert-evolution-delivery-20261029/candidate/artifacts/Personal-Workbench-0.1.15-arm64.dmg)，`370,227,019` 字节；[SHA-256 校验文件](file:///Users/wangyuelin/synara-expert/.synara/expert-evolution-delivery-20261029/candidate/artifacts/Personal-Workbench-0.1.15-arm64.dmg.sha256)。摘要为 `691463c63bc7942de682e61a203494e4ad0d09f8f6fba532ae5e3426e17d2177`。
- 沿用现有 `Personal Workbench` 应用名、`com.wylinx.workbench` 身份及 `~/.synara-workbench` 数据 home，最低 macOS 13.0。不在本包顺带迁移 Linx 命名／安装身份或更改更新链路。
- 输入为上述 HEAD 加未提交改造，冻结 10,170 项源文件，清单 SHA-256 `13e7da06a94fe0bbb62d853be5fe955f92cb7d12a730dcf7e80a4c619fc46f18`；[构建输入](file:///Users/wangyuelin/synara-expert/.synara/expert-evolution-delivery-20261029/candidate/zen-repair-package-input.json)及 [构建后核对](file:///Users/wangyuelin/synara-expert/.synara/expert-evolution-delivery-20261029/candidate/zen-repair-postbuild-source-verification.json)记录来源。打包后核对全部一致；此后的 README、project context 和 BMad 计划仅补交付结果，未重新打包，不冒充包内文档。
- 包后验证：`hdiutil verify` 通过，DMG／临时 ZIP 应用均通过 `codesign --verify --deep --strict`；包内依赖 smoke 和官方隔离启动通过。947 项整包内容／链接／权限一致；239 项空签名扩展属性及一个属组差异已回放到相同元数据、再次严格验签后才回收重复 ZIP／解压应用。时间戳不在元数据比较范围。703 个正式客户端 JS／CSS 审计通过，原型评审工具栏和测试页面未进入产品包。
- 本地 **ad-hoc 签名，未 Developer ID 签名／Apple 公证**，不是已发布版本。未验证日用数据升级、全部跨屏／全屏场景、Windows 原生运行或真实 Provider 执行。[完整产物验证回执](file:///Users/wangyuelin/synara-expert/.synara/expert-evolution-delivery-20261029/candidate/zen-repair-package-verification.json)保留结果，不沿用旧包通过结论。

安装由用户操作：

1. 结束正在运行的任务，按现有恢复流程备份日用数据；然后**完全退出当前应用**，不是只关窗口。
2. 打开上述 `0.1.15` DMG，将 `Personal Workbench.app` 拖到“应用程序”，确认替换现有同名应用。不要删除 `~/.synara-workbench`，也不要同时运行两个同身份副本。
3. 从“应用程序”启动，确认版本 `0.1.15`。若 macOS 拦截，先核对摘要与本地来源，再由用户在“系统设置→隐私与安全性”允许此构建；不关闭系统安全策略。
4. 用日常会话验收 ZR-01～04：草稿随气泡／恢复保留；底部灰条贴近输入、拖动只改位置；任务默认隐藏且主动打开；启动入口在左上收起侧栏右侧。再检查历史会话、附件、设置与 Provider；这些真实数据／模型检查仍归用户安装验收。完成后推出 DMG。

本轮临时隔离 home、下载镜像、探针、ZIP 和解压副本已回收，现有安装的 ASAR／Info.plist 摘要未变。目录账回收约 `1.51GiB`，磁盘实际可用量由约 `27.68GiB` 到 `29.10GiB`，不将二者等同。唯一交付根仍约 `13.48GiB`，原有 `history/`、`recovery-set/`、`operations/` 恢复材料未擅自轮换；须核对归属、完整替代组合与恢复引用后再退役，不声称历史存储已收口。

旧版以下记录保留各自时间和范围，不将历史“无气泡能力”限制用于当前源码，也不将旧包验证继承到 `0.1.15`。

## 09 版：统一 Hover 把手（2026-11-08）

### 输入与改造范围

- 输入基线：`61264859dc431e354c57a710448987829ba0def3` 加用户确认保留的 08 版未提交增量；不是仅此 HEAD 的干净 checkout。用户批准本轮实施计划，明确不安装。
- 实际工具链：Bun 1.4.4 / Node 24.13.1（`mise exec --`）；BMad 固定版本 6.13.0-next 已初始化，当前 initiative 为 `initiative-zen-companion`。
- [34 个受检输入的 SHA-256 清单](../../../../_bmad-output/initiative-zen-companion/source-manifest.sha256)摘要为 `d7c7ceaf8b031beb5af08b262ac92dfb64a11fc1429b4a7667255b34ff8fd65e`；包含生产代码、测试、预览、设计基准与锁文件，不包含本报告自身。
- ZC-20～23：`ZenModeToolbar` 统一收起为气泡／展开收起对话／返回工作台。默认整组无图标、底板或占位；连续命中区 Hover 齐显，键盘 focus-visible 保持，普通点击焦点不锁定。
- 紧凑态锚定输入／决策卡上沿中央；展开后迁至历史抽屉或空会话详情外框最上沿中央，不随内部滚动。任一时刻只挂载一组控件，移除旧 footer/header 槽及 `ZenWindowChrome`，不保留兼容空壳。
- 复用 `IconButton`、Tooltip、原翻译、`disclosureMotion.ts`、真实模式 owner 和原 handler；无气泡能力时省略按钮。父级仅持有键盘焦点恢复意图，通过窄函数接口交给工具组，不复制宿主状态。
- 决策限高改由显式 `compact` 控制，保留 20rem 有界滚动和标题稳定；新增可达的提交／下一题入口，修复多选不能确认。普通聊天、异步问答、任务及 Hub 调用不启用 compact。
- 审查收口：内联答案不得激活隐藏编辑器的 `/`、`@`、`$` 菜单；决策响应错误在决策卡之外可见，仍复用原错误组件。审批去重由稳定 owner 保留，不能因禅模式／主窗口卡片换位丢失；输入法候选 Enter 与组合输入均不得提交。
- 内联问题通过 `userInputPresentation="inline"` 继续使用原答案 owner，但不写隐藏普通编辑器的 prompt／cursor／菜单；取消、完成均保留原草稿。移除 notification attention 自动展开，不改变原审批或回答语义。

### 实际连续预览

使用当前专用 Vite 预览，同一正式 router／父布局／聊天树；没有后端数据库或 Provider。外部评审下拉框只注入场景，不作为提交或模式切换的替代。

- 原生按键输入 `Draft survives`、Shift+Enter、`中文第二行`；实际完成气泡 → 输入 → Hover → 展开 → 收起 → 气泡 → 恢复 → 主窗口 → 禅模式。document、editor DOM 和草稿逐字保持，抽屉状态保持。
- Hover 跨按钮间隙保持显示，底边及 iframe 紧凑高度不变；历史展开时整组中心为 `(360,12)`，抽屉上沿同为 `y=12`，同一时刻只有一组控件。
- Enter／Space 切换时中间按钮保留键盘焦点；用户已转到编辑器时不抢焦点。首次预览观察到失焦后补了恢复逻辑，不沿用修复前结果。
- 通过真实发送操作启动合成回复后立即收起；完成只更新未读标记，陪伴表面仍 `visibility:hidden`、iframe inert，焦点仍在气泡。恢复展开后实际用户消息、合成回复可见，编辑器为空。此记录不证明真实 Provider 执行。
- 待回答通过“其他”输入中文多行，Shift+Enter 不提交、Enter 走原 handler；审批折叠历史后仍可批准，处理完成恢复原草稿与编辑器。
- 右键隐藏后恢复入口、Shift+F10 菜单与 Esc 焦点归还实际走过；入口仍为 36×36px、10px 圆角，无独立“···”。
- 浅色默认 13px；通过原设置界面切换深色与最大基础字号 18px。780×600 历史及 620×480 外层评审视口下无横向溢出；后者稳定审批 iframe 为 588×299，四种决定均在视口内。
- reduced-motion 媒体生效并等待样式结算后，工具组 `transition-property: none`；深色大字号顶部 Tooltip 位于 iframe 内，未被上沿裁剪。
- 最终源码刷新后重新原生按键输入 `Original draft survives`＋换行＋`中文草稿不丢失`；隐藏时注入新问题仍 `visibility:hidden`／inert／expanded=false，且不抢焦点。恢复后输入 `@foo` 请求高度为 251px，不再是 600px。
- 同一 document／editor 实际分别走过中文多行回答的取消和 Enter 提交，原多行草稿逐字恢复；再用 Enter／Space 跨锚点切换，中间按钮仍为 focus-visible。展开态经主窗口往返、气泡恢复，等待真实桥接回执后仍 expanded=true、同一 editor 和草稿；没有以回执前的瞬时尺寸当作结果。
- 620×480 实际滚轮离开历史底部后折叠／展开，scrollTop 为 0→0（最大值 250），工具组相对 iframe 的 top 仍为 0；没有拉到底。普通视口一次观察为 0→12（最大值 49），不将“阅读意图保持”夸大为所有布局的像素绝对不变。
- 已查看最终源码的[展开态 proof](file:///Users/wangyuelin/.synara-workbench/codex-home-overlay/generated_images/browser-proof/d0b42584e92d2b1abd63c575/6876858e-a96f-4404-a00f-f513cefccfe8.png)：唯一顶部工具组、键盘焦点、合成答案回执与未发送的原中文草稿同屏。

### 失败、证据边界与检查入口

- 多选确认回归先失败（缺少 Submit answers），再修复。首次完整 Zen 回归中的旧展开状态条文字和单箭头居中断言已移除／切换为本轮实际组锚点契约；保留真实可达性及窗口连续性断言，不复刻旧布局。
- 组件回归首轮 3 项失败：滚动容器的原生 Tab 顺序、圆角角点命中及一项仅检查默认样式/标题文字的测试；前两项改为真实焦点边界／上沿中心命中，后一项删除，不重新固定文案。
- 共享浏览器 `human.type`／fill 直接改 Lexical DOM 曾产生 `ElementDOMSlot.insertChild` 异常，已报告工具问题。该污染现场已刷新；最终草稿／发送连续路径改用原生键盘输入重新验证。textarea 不受此问题影响；不宣称整段控制台无错误。
- 独立审查复现 `@foo` 令隐藏菜单请求 600px，最终以显式内联输入所有权修复。新测试的 TS lib／exactOptionalPropertyTypes 错误与 React Compiler 的 prop-ref mutation、TryStatement finalizer、参数解构默认值报错均已修复；不扩展 lib、不增加编译豁免。
- 最终完整应用回归先发现取消清空原草稿，以及展开态重复错误横幅；修复输入所有权及决策错误展示所有权后，取消／提交两条草稿路径与 20 项 Zen 回归通过。预览禁用 HMR，旧页面的取消失败不作为修复后结果；刷新最终源码后已重新实际验证。
- FE-AC-01～15 的前端覆盖见下表，不将真实附件/语音、所有字体族、跨应用焦点或平台能力由模拟推定。全库所有 browser、真实 Provider、Electron 和触控无 Hover 未作为本轮通过项目。

### 最终检查记录

全部使用 `mise exec --`，Bun 1.4.4 / Node 24.13.1：

| 检查                                 | 实际结果                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `bun run fmt:check`                  | 5,466 文件通过；已移除本轮生成的工作流渲染缓存，而非添加格式豁免                           |
| `bun run lint`                       | 0 errors / 1,269 warnings；服务端同步文件预算通过                                          |
| `bun run typecheck`                  | 7/7 包成功；保留既有 Turbo 锁文件解析提示及 Effect 建议                                    |
| 受影响单元与编译守卫                 | 10 文件 / 272 项通过，包含全部 49 项 hot-path 编译检查                                     |
| 受影响组件 browser                   | 8 文件 / 79 项通过                                                                         |
| `ChatView.browser.tsx -t 'Zen'`      | 20 项通过 / 298 项因筛选跳过；不是完整 ChatView 套件通过                                   |
| `bun run workbench:check-boundaries` | 136 个源码文件通过；静态边界扫描不证明原生隔离                                             |
| 原型专项 `tsc --noEmit`              | 通过，有建议诊断                                                                           |
| `bun run i18n:check`                 | 3 语言 / 9 命名空间 / 5,707 消息，0 errors                                                 |
| `bun run i18n:extract --check`       | **失败，1,185 findings**，未修改文件；多处现有 UI 文案未国际化，不擅自扩大本轮 UI 范围批改 |

最终功能回归的准确入口：

```sh
mise exec -- bun run test:web:focused \
  src/lib/zenMode.test.ts src/pendingUserInput.test.ts src/pendingUserInputRecovery.test.ts \
  src/components/chatHotPath.compiler.test.ts src/components/ChatView.logic.test.ts \
  src/components/ChatView.selectors.test.ts src/components/ChatView.queuedAutoDispatch.test.ts \
  src/uiFontSize.test.ts src/hasSelectorVariants.test.ts src/lib/disclosureMotion.test.ts

mise exec -- bun run --cwd apps/web test:browser \
  src/components/chat/ZenModeToolbar.browser.tsx src/components/chat/UserInputQuestionForm.browser.tsx \
  src/components/chat/ComposerPendingApprovalPanel.browser.tsx src/components/chat/AsyncUserInputCard.browser.tsx \
  src/components/chat/usePendingUserInputDrafts.browser.tsx src/components/chat/useChatPendingInteractions.browser.tsx \
  src/components/chat/group/HubPendingApprovals.browser.tsx src/lib/contextMenuFallback.browser.ts

mise exec -- bun run --cwd apps/web test:browser src/components/ChatView.browser.tsx -t 'Zen'
mise exec -- node node_modules/@typescript/native/bin/tsc \
  --project apps/web/prototypes/zen-companion/tsconfig.json --noEmit
```

### FE-AC 覆盖与验收边界

| 编号     | 本轮证据／限制                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------- |
| FE-AC-01 | 实际默认 opacity=0；Toolbar browser 验证无残留标记和右侧旧入口                                          |
| FE-AC-02 | Hover／组内间隙、移出隐藏、布局与紧凑高度不变：实际预览＋Toolbar browser                                |
| FE-AC-03 | 展开态唯一外框顶部工具组：实际 proof＋ChatView 回归                                                     |
| FE-AC-04 | 真实滚轮离底及折展不拉底、外锚点稳定；不声称所有布局零像素位移                                          |
| FE-AC-05 | 空会话三个变体、历史、待回答、普通／超长审批：完整应用 Zen 回归                                         |
| FE-AC-06 | 同一 document／editor、中文多行草稿、抽屉与窗口往返实际验证；真实绑定／附件未接入实测                   |
| FE-AC-07 | 合成执行完成、新问题／审批与隐藏入口：真实组件／模拟通知，未使用真实 Provider                           |
| FE-AC-08 | 四种决定、连点、失败重试及稳定 owner 的回执／投影间隔去重：组件／owner browser；实际批准一次恢复编辑器  |
| FE-AC-09 | 单选、多选、多题、无选项、自定义、失败重试与 IME 事件回归；实际中文多行取消／提交，未逐个验证系统输入法 |
| FE-AC-10 | 超长卡片滚动回归；620×480、18px 字号审批实际测量，四种决定可达                                          |
| FE-AC-11 | 实际 Tab／Shift+Tab、Enter／Space 跨锚点恢复与菜单 Esc；输入法候选保护由事件回归覆盖                    |
| FE-AC-12 | 实际 36px／10px 入口、右键隐藏、模拟托盘恢复、Shift+F10／Esc；不是系统托盘验收                          |
| FE-AC-13 | `ZenModeProvider` 配模拟 bridge：pending、失败、重试、不支持与焦点转移回归；不证明原生进程成功          |
| FE-AC-14 | 深浅主题、13／18px、reduced-motion、窄低视口实际检查；字体族切换与全部屏幕尺寸未实测                    |
| FE-AC-15 | 普通聊天及 Async／Hub／共享审批回归通过；未走完整 Tasks 页面与所有主窗口工具                            |
| FE-AC-16 | 未验证：真实桌面穿透、拖动、托盘、工作区边缘、跨应用与跨屏／全屏；不在本轮前端实现内                    |

本轮实现完成，不等于用户验收或正式合入；文案抽取失败保留为明确非绿项。

<a id="local-manual-package"></a>

### 后续授权：本地手动安装包（2026-11-08）

用户另行授权“打包后自行安装”。本节是前端实现之后新增的产物验证，不改写前述“未打包”的阶段事实，也不表示已替换日用应用。

- [本地 DMG](file:///Users/wangyuelin/synara-expert/.synara/expert-evolution-delivery-20261029/candidate/artifacts/Personal-Workbench-0.1.14-arm64.dmg)：Personal Workbench 0.1.14／arm64，368,741,844 bytes；身份 `com.wylinx.workbench`，最低 macOS 13。版本号沿用现行构建配置，不是新的公开发布。
- DMG SHA-256：`18549c5ae6262167c93f0403a5f7a31902b20343b24acfd5add76ee62e534e40`。
- 源码：`61264859dc431e354c57a710448987829ba0def3`＋保留的未提交改造；构建前后 10,169 个输入一致，完整清单摘要 `c6bb7bb50e9c4bad41fa6aca24df82ab24a7c4d892d6c8a8b694a85b1b227b93`。构建完成后仅追加本节及交接状态文档；不是干净提交的正式发布。
- 新增验证：发布脚本安全 smoke 通过；安装包运行时依赖与 mac/arm64 隔离启动 smoke 通过；DMG 与 ZIP 的 947 个应用条目内容／链接／权限一致，两份应用均通过 `codesign --verify --deep --strict`。239 个条目有 xattr 差异、其中 1 个还有组属性差异，已保留两份元数据清单，不声称容器或全部元数据逐字节一致。
- 实际审计包内 703 个客户端 JS／CSS 资源：包含统一把手和内联回答所有权修复，不含评审工具栏或原型目录。源码检查结果按未变输入沿用，不将此前 272／79／20 项写成打包后全部重跑。
- 本地 ad-hoc 签名，未做 Developer ID 签名或 Apple 公证。首次 `actool` 缺失、已安装驱动重签后哈希不符、Electron 下载 HTTP 504 均保留为构建过程事实；最后通过既有预编译图标入口、原始构建驱动校验及匹配锁定 npm 校验值的 Electron 缓存完成，不禁用校验。
- [打包输入记录](file:///Users/wangyuelin/synara-expert/.synara/expert-evolution-delivery-20261029/candidate/zen-companion-package-input.json)；[产物验证与资源收尾记录](file:///Users/wangyuelin/synara-expert/.synara/expert-evolution-delivery-20261029/candidate/zen-companion-package-verification.json)。
- 仅保留一份新的 DMG 安装容器；已回收测试 ZIP、展开应用、临时回环镜像和下载副本，卸载只读验证卷。既有安装／恢复回执和旧恢复材料不改动；应用与 Info.plist 摘要与打包前相同。

**手动安装：**先结束需要保留的任务并备份最新数据，完整退出当前 Personal Workbench（不是只关窗口）；打开 DMG，将 `Personal Workbench.app` 拖到“应用程序”并选择替换，再从“应用程序”启动。不要删除 `~/.synara-workbench` 或同时运行两份同身份应用；本轮未创建新的日用数据备份，也未进行真实数据覆盖升级验收。安装后应检查原聊天／项目与禅模式交互，验收后推出 DMG。

**仍有限制：**常驻气泡／系统托盘的新增能力未接入，因此无气泡能力时左侧按钮不显示；真实 Provider、日用数据升级、附件／语音、完整 Tasks 页面等未由本次启动 smoke 证明。前述 1,185 项文案抽取非绿结果保留，不作为正式发布或用户验收完成。

## 范围、输入与所有权

- 产品定位：**整体协作陪伴**。Obsidian 写作只是一个场景；研究、规划、设计、执行讨论使用同一入口，不绑定作者专家。
- 已确认需求：右下角常驻、低打扰、可唤起；禅模式与主窗口往返方便；充分复用 Synara 现有交互组件。
- 输入：用户的原禅模式截图、03 版确认及本轮优化/方法 Skill 授权；生产源码输入 `61264859d`，本目录为未提交原型增量。未核对已安装二进制与该提交的精确映射。
- 05–08 版曾使用 `ZenWindowChrome`；09 版收敛到共享 `ZenModeToolbar`，旧组件已删除。主窗口审批与待回答布局保持原状。不改桌面进程，不提交、推送、打包、安装或发布。
- 合成数据归 `baselineFixture.ts` 所有；实际 UI 状态仍由生产 StoreProvider / QueryClient / ZenModeProvider / ChatView 管理。外围可见性由 `main.tsx` 管理，不拥有第二份聊天状态。
- 所需真实桌面能力：常驻入口、托盘恢复、窗口位置和跨应用焦点。这里只模拟它们的可见交互；正式实现需另行授权和原生验证。

## 05 版：审批决策区与图标操作

- **ZC-08 审批替代输入区**：共享 `ChatView` 直接渲染原 `ComposerPendingApprovalPanel`，禅模式下移出可折叠详情区，替代普通输入表面；没有第二套审批 handler 或状态机。审批数量、授权范围、响应中禁用行为继续由原组件与请求状态负责。
- 原输入组件保持挂载，审批期间隐藏并 inert，不清草稿；审批消失后恢复。主窗口继续使用原布局；待回答不应用此隐藏规则。
- 审批区保留原抽屉开关，收起历史不隐藏审批；普通状态条不重复显示“待审批”。气泡收起与窗口往返不代表批准、拒绝或取消。
- **ZC-09 图标操作**：收起为向下图标，主窗口展开/返回为现有 Maximize2/Minimize2；复用 `IconButton` 的可访问名称和 Tooltip，审批决定仍保留文字。
- 共享审批布局可直接沿用到产品；图标操作仍位于现有预览窗口外壳，原生气泡/窗口接入尚未实现。不能把整个原型称为已经完成产品集成。

### 05 版实际运行证据

- 实际走过：历史会话输入中文草稿 → 注入审批 → 收起对话（审批仍可操作）→ 收起为气泡 → 唤起 → 主窗口 → 返回陪伴面板 → 取消。原草稿“审批期间保留的草稿”恢复可见，审批区撤下。
- 分别点击批准一次、拒绝、始终允许此会话后，审批区撤下、输入可见且上述草稿保持；结果为隔离合成响应，不证明真实授权执行。
- 稳定审批态的原编辑器无可见矩形，位于 inert 子树。待回答场景仍显示原编辑器。评审场景切换会注入新快照，不保证任意场景之间草稿语义相同，尤其不能把问题回答草稿当作普通聊天草稿。
- 780×600 下 iframe 高 488px，审批区 top=234 / bottom=468；四个决定按钮最下边为 455px，无横向溢出。未覆盖极长审批内容、并发审批、提交失败和所有窗口尺寸。
- 查看过紧凑审批态截图：`d973d74b-1941-46bd-b6f5-89a5afe238c5.png`，包含审批替代输入区与外围图标。
- 浏览器原错误页无法再次导航，新建同域预览页后恢复，已报告工具问题。一次 DOM 检查使用了仅匹配可编辑状态的选择器而失败，另一次快照切换后的立即读取得到旧状态；后续等待审批可见再核对，不将前两次读数当作通过证据。
- 05 版代码检查：首次 fmt 发现 ChatView 格式问题，仅格式化该文件后最终检查通过；fmt 5,461 文件、lint 0 errors / 1,269 warnings、全仓 typecheck 7/7、原型专项 typecheck 均通过。相关 6 个 Vitest 文件共 205 项通过（zenMode、ChatView logic/selectors/queuedAutoDispatch、字号、选择器规则）。保留 Turbo 锁文件解析提示及 Effect 建议诊断；未运行全库测试或原生桌面验证。

## 06 版：待回答也成为决策区

- **ZC-10 待回答替代输入区**：禅模式下 `pendingUserInputs` 与审批一样移出可折叠详情区，占据原输入表面；原抽屉开关保留，历史收起时仍可作答。主窗口继续在原位置浮动显示问题卡。
- **ZC-11 自定义回答收进最后一个选项**：仅在禅模式的决策区，`UserInputQuestionForm` 在选项后新增一行“其他”，复用 `ComposerChoiceRow` 的序号与选中样式；`customAnswerEntry` 由 `ChatView` 传入。输入通过已有 `onChangeActivePendingUserInputCustomAnswer` 写入同一草稿，未新增状态或提交路径。数字快捷键顺延（两个选项时为 `3`），聚焦后光标落在已有草稿末尾。Enter 提交、Shift+Enter 换行；行内文本仍是唯一的可输入答案，不出现第二套输入框。
- 纯自由文本问题（无选项）同样只显示该行；此时序号为 `1`。未在原型中构造该场景，属推断行为。
- 模型控件、附件等输入工具栏在决策期间保持隐藏；回答完成后原编辑器恢复，不残留答案文本。

### 06 版实际运行证据

- 待回答：决策区文本为 `Next step / 1 Compare options / 2 Plan a pilot / 3 其他`；原编辑器无可见矩形且位于 inert 子树。
- 收起对话抽屉后决策区仍可作答；主窗口往返后内容一致；点“取消”后决策区撤下、编辑器恢复。
- 自定义回答：点按决策区后按 `3` 聚焦到 textarea；输入“短答案”后按 Enter 提交，决策区撤下，合成回复记录 `{"next-step":"自定义答案文本"}`。提交后编辑器为空。
- Shift+Enter 换行：内容为“短答案\n第二行”，textarea 高 38.5px，表面总高 218px。
- 选择“Compare options”后按原逻辑自动推进并提交；主窗口内待回答仍显示原编辑器、无内联答案行。
- 780×600 下决策区 top=250 / bottom=468，最后一项“取消”底边 455px，textarea 与各选项均在界内，无横向溢出。未覆盖极多选项、多问题导航、`multiSelect + allowCustomAnswerWithOptions` 组合以及提交失败。
- 新增浏览器回归：`UserInputQuestionForm.browser.tsx`「answers through the last choice row instead of the composer editor」覆盖末项渲染、无重复“Using custom answer”状态、数字快捷键聚焦、输入回写与 Enter 提交；该文件 8 项通过。
- 查看过待回答决策区截图：`2777606c-523d-49d9-8bb6-7b6f675c23fd.png`。
- 三语占位符新增 `chat:composerPendingUserInputPanel_customAnswerPlaceholder`，en / zh-CN / es 同步；行标签复用现有 `chat:other`。
- 06 版代码检查：fmt 5,461 文件通过；lint 0 errors / 1,269 warnings；全仓 typecheck 7/7；`i18n:check` 0 errors（9 命名空间 / 5,705 条）；7 个 Vitest 文件 216 项、`UserInputQuestionForm` 浏览器 8 项通过。保留既有 Turbo 锁文件解析提示与 Effect 建议诊断；未运行全库测试、Electron 或真实 Provider。

下方“04 版实际验证”为历史记录，不移用为本轮验收。

## 07 版：窗口操作进入禅模式自身 chrome

上一轮把窗口操作留在评审外壳，等于把产品必需的入口放在产品之外 —— 原型展示范围因此缺了一块。07 版把入口移进禅模式表面，外壳只保留评审工具。

- **ZC-12 窗口操作组件**：新增 `ZenWindowChrome`（共享代码），承载“收起为气泡”和“返回工作台”，复用 `IconButton`、`zenCollapseToBubble` / `zenReturn` 文案和现有图标。操作属于窗口边缘，不依赖历史内容展开才能访问。
- **ZC-13 紧凑态窗口栏**：紧凑禅模式顶部新增一行，左侧是原状态条（可用时），右侧是窗口操作；两者共处一行，互不覆盖，宽度与输入框对齐。窗口栏只承载状态与窗口操作，不承载模型、权限等输入控件。
- **ZC-14 展开态位置**：抽屉展开时窗口栏隐藏，操作移动到抽屉右上角（与抽屉返回按钮同位），随窗口上沿移动。`zen-drawer-return` 仍只在展开时出现。
- **ZC-15 宿主能力边界**：`ZenModeDesktopMethods.collapseToBubble?` 为可选宿主能力；浏览器/原生宿主未实现时按钮不渲染（`bubbleAvailable=false`）。预览桥接实现该能力，把面板藏起并显示气泡；这不是 Electron 实现。
- 评审外壳删除外侧窗口工具条；隐藏入口改为评审工具栏中的“模拟托盘：隐藏陪伴入口”，与“显示陪伴入口”并置，明确它模拟系统托盘。
- 紧凑窗口高度随窗口栏增长：空闲态 96 → 104px，带状态条时 106px；展开态仍由抽屉高度决定。
- **ZC-16 长决策内容有界滚动**：审批/问题内容最多占 20rem，超长时内部滚动；抽屉开关与窗口操作位于滚动区之外。使用固定内容上限而非 `vh`，避免原生紧凑高度测量形成视口反馈。更小屏幕与极端字号仍需单独验证。

### 07 版实际运行证据

- 紧凑态窗口栏 rect `(20,12.375,680×26.5)`，与输入表面同宽；右侧 `zen-window-return` 右边缘 700，与输入表面右边缘一致；状态条 622px 宽，无横向溢出。
- 点击产品内“收起为气泡”：面板隐藏，焦点回到气泡；再点气泡恢复面板、窗口栏与原编辑器。
- 展开态：`zen-drawer-return` 与“收起为气泡”都位于抽屉内右上角；紧凑态不出现 `zen-drawer-return`。
- 展开态点击收起为气泡 → 面板隐藏；重新打开仍保持展开与抽屉内容。
- 产品内“返回工作台”切换成功（iframe `data-mode=workspace`），再用主窗口内的禅模式入口回到 zen；外壳没有参与这两步。
- 紧凑审批态实测窗口栏无重复状态条，卡片上方是“收起为气泡”和“返回工作台”；审批态窗口高 294px，窗口栏 `(20,12,680×24)`。恢复任务后补测待回答：紧凑高 278px，窗口栏 `(20,12,680×24)`、决策区 `(20,40,680×218)`；普通编辑器仍 inert，无重复状态条。
- 实际指针点击“收起为气泡”（非脚本触发）：面板隐藏，气泡显示“等待你审批”且获得焦点；重新打开仍是同一审批卡。
- 外侧不再存在 `companion-actions` 工具条。
- 07 版已查看截图：运行态窗口栏 `6e652005-d2fb-425f-b7a7-476c93d81f7b.png`、空闲态 `3d1d38ad-08ad-4e14-a1de-1a064c21efd1.png`、待回答与末项输入 `f2851cba-f6bb-4f35-ad43-52b6db03c822.png`；修复后的最终待回答截图为 `0223ee11-476c-48b9-b669-369394b36cc1.png`，完整路径见本轮交付回复。
- 07 版已有检查记录：fmt 5,462 文件、lint 0 errors / 1,269 warnings、全仓 typecheck 7/7、i18n 0 errors、zenMode 单测 10 项、UserInputQuestionForm 浏览器 8 项通过。恢复后原型专项类型检查通过（保留 Effect 建议），接入清单已登记，边界扫描通过（136 文件；不是运行时隔离证明）。
- 两次完整 ChatView 浏览器运行在会话中断后没有可确认的终态，不计为通过；恢复后 `-t '^ChatView.*Zen'` 专项在 600 秒超时，退出 143，没有用例统计。随后改为更小范围运行：新会话三场景、空闲态、普通审批 5 项通过，超长审批先失败；修复后待回答、普通审批、超长审批 3 项通过。合计覆盖 7 个不同 Zen 用例，不声明完整 ChatView 套件通过。
- 已移除待回答回归中依赖旧状态条和隐藏 Footer 的操作，改为验证历史折叠后选项与返回入口可达、原编辑器 inert，并通过选择直接提交。共享浏览器实际点击 Compare options 后，决策区撤下、编辑器恢复可见且不再 inert、窗口返回入口仍在；这是隔离 RPC 的成功路径，不代表真实 Provider 执行。
- 边界回归发现超长审批（40 个参数）把 form 底部撑到 1032px，超过 600px 视口的 581px 上限；已补 ZC-16。真实预览临时注入同类长审批后，560px 高窗口内决策区为 `(20,220,680×320)`，内部内容 1024px；滚轮到底后四个审批操作可见，点击批准一次后卡片撤下并恢复编辑器。临时长 fixture 已移除；已查看证明截图 `c07989db-6154-49eb-8cb7-829a0e3b00fb.png`。
- 修复后的最终检查：fmt 5,462 文件通过、lint 0 errors / 1,269 warnings、全仓 typecheck 7/7、边界扫描 136 文件通过。没有新建环境、安装包或依赖副本；临时长审批数据已撤回，测试写出的历史 PR 截图恢复，不作为本轮新增交付。

## 08 版：操作融入表面，入口减负

- 输入依据：用户指出右上两图标仍独立悬空，并通过标注要求移除“···”、用右键隐藏，以及缩小圆角方形入口。以下取代 07 版窗口栏方案，历史记录不等于当前布局。
- **ZC-17 图标融入现有表面**：删除 `zen-window-bar`。紧凑普通输入态直接复用 `ChatComposerFooter.metadataControls`，不新增标题行；待回答/审批复用原卡片，增加可选 `headerActions` 槽。非禅模式调用方不传该槽，外观与行为不变。展开态仍使用抽屉内右上角位置。
- ZC-16 的 20rem 内容上限改由决策卡片自身承担，标题及窗口操作在内部滚动时 sticky；上限不依赖窗口高度，避免测量反馈。隐藏的普通编辑区不重复挂载窗口控件。
- **ZC-18 入口右键菜单**：移除独立“···”按钮；右键入口打开已有 `showContextMenuFallback` 菜单，只有“隐藏陪伴入口”。Shift+F10 / ContextMenu 键同样可用；Esc 关闭后焦点返回入口，隐藏后焦点转到模拟托盘恢复。
- **ZC-19 小圆角方形入口**：36×36px、10px 圆角、20px 品牌图标，停靠锚点与状态提示规则不变；桌面浏览器评审默认，不宣称触控设备验收。
- 实测入口尺寸 36×36、radius 10px，入口区域只剩一个按钮；右键隐藏、恢复、键盘菜单及 Esc 焦点归还通过。普通输入态两图标与编辑器处于同一行，待回答态图标位于卡片矩形内，无独立窗口栏。
- 浏览器回归：问题/审批组件和右键菜单共 27 项通过；ChatView 空闲、待回答、普通/超长审批 4 项通过。不代表全套 ChatView 或原生宿主通过。
- 已查看截图：输入操作区 `fa380b6d-0170-4d31-a3ae-f027edeab640.png`；圆角方形入口 `5fdda39b-6655-4ffd-94c7-8adc7927780a.png`。
- 最终检查：fmt 5,462 文件通过、lint 0 errors / 1,269 warnings、全仓类型 7/7 与原型专项类型通过；保留既有 Effect 建议。最后补充隐藏编辑区不重复挂载控件的 guard 后，实际复核审批/普通输入各只有一个返回入口、无独立窗口栏。测试产生的 4 张历史 PR 截图已恢复。未打包安装，未修改官方 Skill。

## 运行与环境

```sh
mise exec -- bun run --cwd apps/web dev --config prototypes/zen-companion/vite.config.ts
```

访问 http://127.0.0.1:5741/ 。本轮复用原目录/依赖/端口，独立 Vite 服务名 `zen-companion-review`，绑定 127.0.0.1；交付时该自建服务和本轮浏览器 tab 已关闭。再次运行前先检查端口归属，不能覆盖其他实例；服务仅供当前评审，可通过对应托管进程的停止入口或终端 Ctrl-C 停止。不启动 Synara 后端、Electron、Provider 或数据库，因此无后端数据 home；这不是启动日用实例的替代命令。

刷新会清空 **5741 专用预览 origin** 的 localStorage/sessionStorage 并重载合成数据。不要在此 origin 存放需要保留的数据。HMR 已禁用，源码更新后须刷新。当前预览默认只显示气泡，不自动展开。

没有创建新 checkout、依赖副本、安装包或真实数据副本。保留一份当前原型，不维护历轮 UI 副本。

## 真实组件复用与增量

`index.html → main.tsx（评审工具＋拟议陪伴窗口外壳）→ 同一个 app.html iframe → baselineApp.tsx → 正式 getRouter / RouterProvider → 正式父布局、StoreProvider、QueryClient、ZenModeProvider、ChatView`。

输入、Footer、菜单、消息、抽屉、待回答/待审批、错误和主窗口全部由共享生产代码直接渲染。05/06 版在共享 `ChatView` 内调整禅模式决策布局，并在 `UserInputQuestionForm` 中新增末行答案输入；没有复制 ChatView，也没有覆盖 iframe 内部 DOM 的样式。

新增气泡与操作区复用 `SynaraLogo`、`Button`、`Menu`、`MenuTrigger`、`MenuItem`、`ComposerPickerMenuPopup`，以及生产 stylesheet、theme token builder、字号变量。新写的仅为现有产品尚无的“气泡/面板/隐藏”外围可见性协调、提示标记和布局；不新增第二套输入组件或会话 Store。本轮没有新增切换动画。

- `baselineApp.css`：生产 index.css＋独立根目录所需的源码 Tailwind 扫描。
- `style.css`：外围布局和新入口；不越过 iframe 覆盖原界面。
- `previewBridge.ts`：模拟原生窗口尺寸和模式通知；沿用真实 ZenModeProvider 的进入限制，保存原抽屉展开状态。请求 ID 对应实际模式回执，拒绝切换不假报成功。
- `baselineFixture.ts`：原 MSW / Effect RPC 合成数据；状态提示从当前快照的 pending/turn/session/message 派生，不从评审下拉框猜测。
- `baselineApp.tsx`：真实应用挂载、状态发布和用户显式唤起后的焦点交接。隐藏层拒绝焦点请求。

## ZC 交互规则

ZB-01 至 ZB-06 保留为合成状态编号；ZC-01 至 ZC-07 描述外围交互，ZC-08 起见各版本说明，均不替代既有产品需求编号。

- **ZC-01 常驻入口**：当前为 36×36px、10px 圆角方形（ZC-19）；普通桌面视口距右/下边 28px，低高度/窄视口为 16px。原 Synara 标志；右键菜单可隐藏入口。
- **ZC-02 唤起与收起**：点击气泡恢复同一个禅模式和原抽屉状态，显式聚焦原编辑器。“收起为气泡”保留任务、草稿、会话和组件树；焦点返回气泡。失焦不收起，不额外劫持 Esc。
- **ZC-03 右下展开**：720px 窗口保留原 680px 输入表面；紧凑高度由生产 hook 回报，抽屉展开高度 560px，受可用视口约束。内容向上展开，输入底边稳定；窗口操作由产品内部布局预留空间。
- **ZC-04 主窗口往返**：使用产品内“返回工作台”和原主窗口“禅模式”入口。保持同一 iframe/路由树和原抽屉展开状态，不创建第二个会话；07 版已删除外围切换入口。
- **ZC-05 低打扰提示**：运行 `…`、待回答 `?`、审批/错误 `!`，均为静态标记；悬停和可访问名称提供具体状态。后台完成只标记未读结果，打开面板后清除提示。停止/取消为随时协作，不冒充完成。状态消息不自动唤起或抢焦点。
- **ZC-06 隐藏与恢复**：“隐藏陪伴入口”仅隐藏，iframe 保持挂载且 inert/退出 Tab 顺序；用评审区“模拟托盘：显示陪伴入口”恢复气泡。该按钮明确不是系统托盘的实现。
- **ZC-07 状态与显示分离**：收起或隐藏不取消执行；后台状态不会改变用户的可见性选择。真实原组件继续拥有问答、审批、错误恢复行为。

## ZB 合成场景与连续流程

- **ZB-01 空闲输入**：原单/多行编辑器与发送按钮。
- **ZB-02 历史会话**：通用协作讨论；原控件展开/收起抽屉。
- **ZB-03 生成中**：原流式内容和停止入口，停止保留部分文本。
- **ZB-04 待回答**：原选项/自由输入及提交入口。
- **ZB-05 待审批**：原批准/拒绝/取消行为；结果为本地合成状态。
- **ZB-06 执行失败**：原错误和“继续任务”路径。

评审选择器只负责替换快照，不是产品流程按钮；它会替换合成历史、取消演示计时器，不主动清草稿。空会话与历史快照切换可能使原组件切换分支，不能把它等同于普通窗口往返。

连续体验：气泡 → 原编辑器输入 → 原发送 → 执行中收起 → 完成提示但不弹开 → 气泡恢复原会话 → 主窗口查看 → 返回原禅模式。注入问答/审批/失败后，仍需点击原控件处理，不能靠切换场景冒充转换。

## 04 版实际验证（历史）

Synara 共享浏览器中操作原型，主要视口 1062×927，另验证 780×600 和 1353×927：

- **ZC-01/02**：气泡 48×48px；打开后原编辑器聚焦。输入中文后收起/重开，同一 iframe、同一 document、同一 editor DOM，草稿逐字保持；收起焦点返回气泡。
- **ZC-03**：稳定后紧凑 iframe 为 96px、展开为 560px；同一单行编辑器底边屏幕坐标前后均 868px。1353×927 展开时 iframe 为 `(605,339,720,560)`。
- **ZC-04**：展开状态经外围主窗口入口→原“禅模式”返回，仍展开且保留同一 editor/中文草稿。紧凑状态经两个外围入口往返，仍紧凑且同一 editor；点击外围评审区后面板不自动消失。
- **ZC-05/07**：实际点击原发送按钮，观察 running；收起后收到 complete 和未读标记，iframe 仍隐藏/inert，焦点没有转入面板。再次打开清除标记并看到完整合成回复。
- **ZC-06**：菜单隐藏后入口消失、iframe 仍在且 inert，焦点进入模拟恢复按钮；恢复再打开，原 document 和回复保持。
- **ZB-04**：收起时注入待回答，不自动弹开；原选择 Compare options 并提交，观察到记录该答案的完整模拟回复和 complete。
- **ZB-05**：取消后 pending 行撤下、记录 cancel、外围状态 idle；批准一次后记录 accept 和完整模拟回复，外围状态 complete。此次批准回复在收起前已完成，不据此声称该次产生后台未读。拒绝及本会话批准分支本轮未重验。
- **ZB-03**：原停止按钮消失，部分文字保留，外围状态 idle，不误报 complete。
- **ZB-06**：气泡状态显示错误且不抢走评审选择器焦点；打开后点击原“继续任务”，观察到完整合成回复、外围状态 complete。
- **小尺寸/菜单**：780×600 下外围窗口 `(44,60,720,524)`，原 iframe 488px 高，无内外横向溢出；模型菜单位于 iframe 内 `(361,276,296,152)`。紧凑态附加功能 listbox 位于屏幕 `(70,340.875,668,172)`，关键项可见；Esc 关闭列表但面板保持打开。

部分长批量工具调用超时/未确认；先读取实际页面再补足剩余操作，未把整个失败调用计为成功。一次立即测量仍是旧 compact 几何，随后等待实际 expanded 状态再取稳定值。没有为这些观察更改生产组件或降低验证要求。

### 代码与 Skill 检查

- 根 `bun run fmt:check`：5,461 文件通过。
- 根 `bun run lint`：1,269 warnings / 0 errors；本原型仍有 fixture map/spread 与同源脚本 iframe 两项提示。服务端同步文件预算通过。
- 根 `bun run typecheck`：7/7 包成功；保留 Turbo 锁文件解析提示。
- 原型专项 `node node_modules/@typescript/native/bin/tsc --project apps/web/prototypes/zen-companion/tsconfig.json --noEmit` 通过，有 Effect 建议诊断，无类型错误。
- `bun run --cwd apps/web test src/uiFontSize.test.ts src/hasSelectorVariants.test.ts src/components/chat/ComposerGoalHeader.test.ts`：3 文件 / 8 项通过。不新增仅检查组件接线的永久测试。
- 方法 Skill：frontmatter/8 个稳定步骤/包内引用检查通过；实际调用生产 `parseSkillFrontmatter` 与 `readSkillDescriptor` 成功解析名称和描述，未写入技能库。JS Eval 环境首次缺 yaml，改用仓库现有 Bun 解析成功，未安装依赖。

### 本轮截图证据

两张均实际查看，由 browser_screenshot proof 产生，完整 artifactPath 见本轮交付回复：

- 后台完成后的低打扰气泡：`17efc1c4-cba3-42e3-8c6f-777751b94390.png`（1062×927）。
- 右下角原抽屉＋中文草稿＋轻量操作区：`0f1f93f9-7cd1-455a-8096-9346e78b10c7.png`（1353×927）。

## 方法 Skill

[production-ui-prototyping / SKILL.md](../../../../skills/production-ui-prototyping/SKILL.md)，及其包内 `references/synara-zen.md`。

固定方法：完整真实组成优先 → 只替换数据/宿主边界 → 原貌比对确认 → 授权增量 → 实测连续流程与像素 → 明确模拟/产品/验收边界。保留了前轮 Tailwind 漏扫、iframe 缺 allow-forms、仅复用基础组件、状态快照冒充流程等教训。

这是工作区中的完整方法文件包，不是官方 BMad 修改，也不表示已注册到专家目录。本 Run 固定 Skill 快照且禁用自学习写入，未改原包/专家绑定。未来自动可用须通过宿主授权的技能管理流程导入并绑定，在新 Run 目录中核实；本轮不冒充这一过程已完成。

## 安全边界与未验证事项

- UI 来自生产代码，数据与模型回复是模拟；`codex/gpt-5` 来自原测试 fixture，没有更改用户真实模型配置。
- 原 MSW 边界保留：WebSocket 本地截获，普通 API/写入和外部 HTTP 拒绝，未知 RPC 明确失败；快照没有持久事件日志，replay 为空。不是完整后端。
- 同源 scripts iframe 用于真实组件行为，不是执行不可信代码的安全沙箱；forms 允许，摄像头/麦克风/屏幕捕获/剪贴板权限仍禁用。未验证真实录音、附件、复制或系统文件选择。
- 日志可出现有意拒绝的请求、外围能力不可用与 iframe 提示；不声明全控制台无错误。
- 未验证原生置顶、拖窗、鼠标穿透、全局快捷键、真实系统托盘、跨应用焦点恢复、跨屏/全屏。这里的聚焦证据仅为浏览器 iframe 内。
- 未连接真实 Obsidian 或任何 Provider，不读写笔记或项目文件。不声明真实任务、进程清理、持久恢复或所有主窗口工具通过。
- 早期轮次未覆盖深色、移动端、所有字号/输入法、所有拒绝切换分支或全部权限异常；09 版补验范围见顶部记录，仍不代表全响应式或跨平台验收。

## Hub / 下一步交接

最终设计及稳定编号以 [前端交接 v1.0](./FRONTEND_HANDOFF.md) 为准；09 版已实现统一 Hover 把手，保留 36px 圆角方形入口、右键隐藏和真实组件复用。旧版窗口图标位置已清理，前端验证不等于完整原生能力、用户验收或安装完成。

本轮原生窗口修复的实现入口为 [原生窗口与任务界面计划](../../../../_bmad-output/initiative-zen-companion/plan-native-window-and-task-ui.md)。原型桥接已迁移到 `isBubble`、`bubble: { collapse, restore, hide }` 和 `setDragRegion` 契约；生产与原型复用 `ZenModeBubble`，气泡恢复保留原聊天树与抽屉状态。原型仍只模拟窗口几何和隐藏，不提供系统托盘；真实 Dock/快捷键恢复由原生宿主拥有。

任务列表与独立进度卡默认隐藏，使用输入工具栏“任务”主动打开；发送、实现计划和换聊天不再隐式打开。关闭任务仅关闭任务列表，不折叠禅窗口。禅模式入口移至单实例侧栏收起按钮右侧，旧聊天头部入口移除。底部拖动条留出独立空间，报告真实 CSS 矩形，位于 DOM 内容之后以免被后续 no-drag 区覆盖。

父会话已集中完成上述新增行为回归、独立审查及 `0.1.15` 包后验收，结果以顶部 10 版记录和计划为准；子切片未自行运行检查的说明仅描述分工时点。当前可交给用户自行安装，未自动安装、提交或推送，工程 `built` 不等于用户验收。
