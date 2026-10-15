# Context V1 视觉与交互 QA

日期：2026-10-13。final result: passed

## 对比依据

来源视觉基准：[真实 SpaceEditorDialog 独立渲染](../qa/source-space-editor.jpg)。该页面通过 `?ui-reference=1` 直接导入候选 UI 的未修改业务组件，不复制源码。

实现截图：[原型中的真实 Space 编辑器](../qa/11-real-space-editor.jpg)。来源与实现均为“学术研究 / Bag / 浅色 / 13px / 编辑模式”。

两张截图均为 1280×720 像素，对应 1280×720 CSS viewport。实际组件矩形均为 x=448、y≈201.27、384×317.45 CSS px。来源报告 DPR=2，实现报告 DPR=1；浏览器截图 API 输出均已归一为 CSS 1×尺寸，不做额外拉伸，字体抗锯齿差异不作为布局偏差。原始测量见 [comparison-metadata.json](../qa/comparison-metadata.json)。

完整同屏对比：[comparison-full.jpg](../qa/comparison-full.jpg)。焦点区域同屏对比：[comparison-focus.jpg](../qa/comparison-focus.jpg)。已实际打开两幅组合图比较；单独来源没有工作区背景，原型有右侧 Sheet 和工作区背景，这属于批准的组合方式。此次没有完整工作区视觉稿，因此不声称整体页面与某幅未提供的设计稿像素一致。

新 Context 页面布局以批准方案的 Space / 项目 / 聊天 / 设置四区域和现有 UI 控件为依据。分别检查了桌面 1280×720、1045×822 及窄屏 390×844 的呈现。

## Findings

没有待修复的 P0/P1/P2 视觉或交互问题。原型的真实 Space 编辑器在控件布局、字体、图标、边框和按钮形状上与来源一致。

| 必查面       | 实际核对                                                                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 字体与字号   | 原生 UI 字体继承真实 theme；表单 18px 时实测为 18px、行高 29.25px。11px / 13px / 18px 状态可读，标签、说明和输入按 text-ui / text-chat 缩放。对比中的抗锯齿差别来自截图密度 |
| 间距与布局   | 基准编辑器矩形和内部行列一致。工作区使用批准的简化框架；右 Sheet、继承区和详情可滚动。390px 宽页面 scrollWidth=390，无横向溢出，保存和输入区控件可达                        |
| 色彩与 token | 真实 index.css、默认主题 pack 和纯主题构造函数驱动浅深色；没有重建颜色表。网页使用 opaque 材质，与桌面原生透明效果的差别是有意约束                                          |
| 图像与图标   | Synara 标识、Space 图标使用真实资源；其他图标来自已用图标库。没有新增插画、CSS 图画或自制 SVG 替代资源，图标清晰且选中态一致                                                |
| 产品文案     | 四字段、继承来源和固定快照清楚；技术信息默认折叠。主流程使用“已加载/加载失败”等演示状态，旧对话明确沿用历史内容；非空 Context 的提供方限制可见                              |

## 比较和修正历史

1. 首次基准捕获中，隐藏来源 tab 为 1280×720，前台原型为 1045×822；该捕获不用于判定视觉偏差。重新以 1280×720 捕获两者、对齐组件矩形并制作完整/焦点组合图后完成对比。
2. [P2 / 文案] 旧对话演示回复曾声称使用固定 Context；已改为沿用历史内容，聊天底部说明也按新/固定/历史模式区分。修正证据：[旧对话详情](../qa/10-legacy-thread.jpg)及新增模型断言。
3. [P2 / 行为] 当前项目的迁移限制曾遗漏；已在模型首次发送前和页面入口补齐。实际看到按钮禁用，处理冲突后可发送，其他项目不受全局阻断。[迁移冲突](../qa/06-migration-conflict.jpg)
4. [P2 / 键盘焦点] 从移动导航打开迁移后关闭，原先焦点落到 BODY。修正返回引用后，浏览器实测返回 BUTTON / aria-label="展开导航"。[修正后焦点](../qa/18-mobile-focus-return.jpg)
5. 最终重新打开页面和 Space 设置，浏览器 error 日志为空，拦截数 0；[最终界面](../qa/20-space-settings-final.jpg)中所有基础控件正常显示。构建、类型和 10 项测试通过。

## 关键界面与交互证据

- [Space 设置](../qa/20-space-settings-final.jpg)、[项目只读继承](../qa/03-project-inheritance.jpg)
- [保存失败](../qa/04-save-failure.jpg)、[版本比较](../qa/05-version-conflict.jpg)
- [当前固定 Context](../qa/07-thread-context.jpg)、[来源更新后仍固定](../qa/08-stale-snapshot.jpg)、[加载失败](../qa/09-load-failure.jpg)
- [18px 深色设置](../qa/13-project-dark-large-type.jpg)、[390px 深色项目](../qa/14-project-mobile-dark.jpg)、[移动 Context](../qa/15-context-mobile-dark.jpg)、[11px 浅色聊天](../qa/17-chat-mobile-light-small-type.jpg)
- [网络隔离控制](../qa/19-isolation-controls.jpg)

实际操作覆盖保存、失败、冲突、离开保护、迁移选择、第一次绑定、来源更新、原快照重试、旧对话、提供方选择、Space/项目切换、主题/字号和键盘焦点返回。详细结果见 [acceptance.md](./acceptance-v1.md)。

## Follow-up Polish / 检查边界

- [P3] 直接复用的 SpaceEditorDialog 保留来源的英文文案；新 Context 业务文案为中文。正式接入时可统一评估本地化。
- 这是基于真实组件的新交互组合，没有完整工作区视觉稿；整体视觉收敛仍由用户审核决定。
- 没有强制模拟系统 reduced-motion、其他浏览器/操作系统，也没有验证真实 Provider。完整业务验收属于后续接入阶段。
- 全仓库格式检查的 7 个既有失败不属于本原型视觉问题，已在验收记录中列出。

## Implementation Checklist

- [x] 真实组件与资源直接复用，主题和字号来自真实纯函数。
- [x] 同屏基准比较、窄屏/浅深色/大小字号及状态检查。
- [x] 无剩余 P0/P1/P2 问题；发现问题已修复并复验。
- [x] 截图、启动说明、检查结果和未验证范围已记录。

final result: passed
