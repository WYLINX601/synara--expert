# Synara Context Companion

桌面 Obsidian 插件，读取当前 Markdown 编辑器的文件身份、选区和位置；正文只有在 Synara 中明确开启后才读取。文件搜索只用 Vault 文件名/路径。实现依据 [Obsidian Editor API](https://docs.obsidian.md/Plugins/Editor/Editor)；不提供文件编辑、Agent 或 MCP 操作。

## 安装与配对

1. 使用包含 Ambient Context 的 Synara 开发版；已有安装版不会因源码变更自动获得功能。
2. 把本目录的 `manifest.json`、`main.js` 和 `capture.cjs` 放进目标 Vault 的 `.obsidian/plugins/synara-context/`，在 Obsidian 社区插件设置启用 **Synara Context**。
3. 在 Synara 的 Settings → Connectors 中开启 Obsidian context，选择允许的信息类型，显示配对信息。
4. 在 Obsidian 的 Synara Context 设置中填入 Local endpoint 与 Pairing code，点击 Connect。凭证只保留在本次应用会话中，不写入 Vault。
5. 打开笔记并选中文字，切回 Synara。点击 **Attach context** 固定当时的上下文，或在输入框用 `@` 搜索 Vault 文件。检查引用后发送。

重新启动 Synara/Obsidian 或改变来源策略后重新配对；只接受 `ws://127.0.0.1:端口`。同一 Synara 来源一次连接一个 Vault，第二个连接不会替换第一个。断开或关闭来源立即清空实时状态，已固定引用仍可手动移除。

## 已知边界

- 首版面向 Markdown 编辑视图；阅读模式、Canvas、PDF、移动端和弹出窗口未作实机验收。
- 不把笔记名称或插件实例 ID 当作系统窗口身份；首版未开放窗口身份采集。
- 实时状态最多保留 30 秒；没有持续操作历史。切回 Synara 不立即抹去刚刚选中的文字。
- 单项文本最多 16,384 个 UTF-16 字符，正文截断会标记；过长选区不伪装完整。传输/快照另有总量限制，序列化超量会清空上一批次并显示通知。
- 不改写笔记，不安装系统辅助功能或屏幕录制权限。资源路径只是来源信息，不能授权模型访问文件。
- 本目录无需构建即可复制，但仅源码/协议测试通过不代表已完成真实 Obsidian 联调。实际结果见仓库验收记录。
