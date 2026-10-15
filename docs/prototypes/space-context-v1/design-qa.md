# Context V1.1 视觉与交互 QA

日期：2026-10-13。结果：本轮原型检查通过，等待用户界面审核。

## 依据与范围

依据已批准的 [V1.1 PRD](../../space-project-context-v1-interaction-prd.md)，保留 Space 图标导航、普通 Project 列表及项目内对话；配置复用原 Space 弹窗和 Environment，详情从原「＋」菜单打开。直接导入当前候选源码，摘要及差异见 [验收记录](./acceptance.md)。

没有整页像素设计稿，不声称演示壳是完整 Sidebar / ChatView 或与某幅设计稿像素相同。旧版双图对比、Space Sheet、独立设置导航与 Context 常驻入口见 [history](./history/README.md)，均不属于 V1.1 当前界面。

## 当前关键界面

| 界面                | 当前证据                                                                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 常态导航与聊天      | [默认界面](./qa-v1.1/01-default.jpg)：原层级，无常驻状态或更新横幅                                                                                                                                        |
| Project Environment | [最终面板](./qa-v1.1/25-final-project-environment.jpg)：继承默认折叠，目标与原指令编辑；待迁移入口只在相关编辑区                                                                                          |
| Space 编辑          | [最终单弹窗](./qa-v1.1/26-final-space-dialog.jpg)：名称、图标、方向目标、共享指令共同保存，背景保留 Environment                                                                                           |
| 详情入口            | [最终「＋」菜单](./qa-v1.1/27-final-plus-menu.jpg)：按需查看行，保持原菜单内容                                                                                                                            |
| 固定内容与更新      | [加载详情](./qa-v1.1/07-bound-context.jpg)、[更新只在详情](./qa-v1.1/08-update-in-details-only.jpg)                                                                                                       |
| 故障处理            | [Project 失败](./qa-v1.1/11-project-save-failure.jpg)、[冲突](./qa-v1.1/13-project-conflict.jpg)、[Space 失败](./qa-v1.1/14-space-save-failure.jpg)、[加载重试](./qa-v1.1/10-original-snapshot-retry.jpg) |
| 深色大字号          | [18px 桌面](./qa-v1.1/17-dark-large-font.jpg)、[390px 面板](./qa-v1.1/18-mobile-dark-project.jpg)、[390px Space 弹窗](./qa-v1.1/19-mobile-space-dialog.jpg)                                               |
| 小字号与导航        | [11px 浅色聊天](./qa-v1.1/22-mobile-light-small-font.jpg)、[390px 导航](./qa-v1.1/23-mobile-navigation.jpg)                                                                                               |

## 检查结果

- 使用真实 index.css、主题构造与字号纯函数，继承系统 UI 字体。18px 表单实测 18px，11px 聊天输入实测 11px；代码遵循 text-ui / text-chat，字号测试通过。
- 默认桌面约 1045×822，窄屏 390×844；面板和弹窗正文可滚动、按钮可达，无横向溢出。没有为截图放大浏览器，响应式检查后恢复默认尺寸。
- 标识、Space 图标和图标库直接复用，没有另画基础图标。展开来自 Collapsible / disclosureMotion，不新增动画时长。
- 失败和冲突在相关编辑区处理；常态不显示固定已保存状态、字符计数或版本。迁移/加载异常只提示受影响对象。
- 关闭详情返回「＋」；Project→Space 保存后返回继承入口；移动导航选择返回导航按钮。图标使用原方向键及 roving tabindex，菜单使用原键盘处理。
- 已打开最终设置/菜单及深色、窄屏截图人工核对。未发现阻断本轮原型审核的布局或交互问题；不等于生产运行验收。

## 本轮修正

1. 将常驻 Context、独立设置页、Space Sheet 收敛到原菜单、原弹窗与 Environment。旧图保留为历史参考。
2. Project 保存串行排队，固定对象身份和确认基线；失败/冲突暂停，ACK 丢失回读。实际切换完成后读取对应字段，未见串写。
3. 导航行间接导入生产 store 的缓存访问路径已隔离；业务组件导入前安装内存 Storage，测试确认不调用真实 getter。
4. 新建 Space 入口和提交都补齐 Project 草稿保护；失败草稿下实际出现原 guard。
5. Space 保存校验编辑打开时的名称/图标基线，避免只凭 Context revision 覆盖另一处编辑。
6. 迁移完成后旧错误残留已修正，关闭时清除提示并保留输入。[复验](./qa-v1.1/24-migration-notice-cleared.jpg)

## 保留事项

原 Space 与 Environment 控件保留英文文案，新 Context 为中文；未做全产品本地化重写。浅深色和次级文字遵循候选 token，整体密度与语言交由用户审核。

未强制模拟系统 reduced-motion、其他浏览器/系统或移动软键盘。新 props 缺省兼容经相关浏览器测试和源码核对；真实 Provider、远程快照、完整路由、Expert、fork/handoff 仍需正式联调。

构建、类型、状态与浏览器检查，以及整体格式门禁两份既有失败，见 [acceptance.md](./acceptance.md)。当前截图在 qa-v1.1；旧 qa 图片仅作追溯。
