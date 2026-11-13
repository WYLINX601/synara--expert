---
name: create-suite
description: 在对话中创建可导入的 Synara Suite 源目录时使用。先完成最小访谈，再写出 synara-suite.json、角色 persona 和声明的资源，校验后交给用户在 Suite 页导入；不直接注册 Suite，不创建连接，不绕过 owner 导入。
---

# 创建 Suite

把一个专家组合整理成一个合法、可导入的 Suite 源目录。产出是**源目录**，不是已注册的 Suite。

## 边界

- 不直接调用导入 RPC、数据库或本机状态；最终导入由用户在 Experts → Suite → 导入 Suite 完成。
- 不创建 MCP 连接，不修改已有 Expert，不编造 `expertId`。
- 只使用 v1 支持字段。不要发明 workflow、graph、协调者指令、成员模型等字段。
- 声明的所有路径必须位于源目录内，使用相对路径，无 `..`、无绝对路径、无软链接。

默认 Expert 与线程配置见 `references/default-expert.md`。

## 最小访谈

只问缺少的信息；用户说“基础创建”时使用默认值，不为了完整而扩问。

1. Suite 名称和一句描述。
2. 成员：
   - 已有 Expert：要求用户给出准确的 `expertId`，写为 `kind: "reference"`。
   - 新角色：收集名称、描述和 persona，写为 `kind: "definition"`，persona 落到 `roles/<key>.md`。
3. 资源，可全部省略：
   - `skill`：`packageRoot` + `entryPath`，入口必须是 `SKILL.md`。
   - `files`：`root` + `purpose`（instructions/reference/template/workflow）。
   - `connection`：已有 `connectionId` + `tools`；导入不会创建连接。
   - `resource-reference`：已有 Skill/文件/连接的引用；无法确认存在时不要写入。
4. `defaults`：可选 `language`、`outputDirectory`；不确定就省略。

基础模式默认：一个新建角色、无资源、无 defaults。

## 输出目录

使用用户授权的绝对路径。用户未指定时，建议当前项目根下的 `suite-sources/<slug>`，写入前说明路径。

生成结构：

```text
<suite-root>/
  synara-suite.json
  roles/<member-key>.md
  skills/...        # 仅当声明了 skill 资源
  files/...         # 仅当声明了 files 资源
```

只复制声明的资源，不复制整个来源库。manifest 示例：

```json
{
  "schemaVersion": 1,
  "name": "My Suite",
  "description": "One sentence",
  "experts": [
    {
      "key": "author",
      "kind": "definition",
      "name": "Author",
      "description": "Writes specifications",
      "personaPath": "roles/author.md"
    }
  ],
  "resources": [],
  "sharedResourceKeys": [],
  "coordinatorResourceKeys": []
}
```

完整字段和约束见 `references/manifest-v1.md`。

## 校验

写完后，在本 Skill 目录下运行（不要假设当前工作目录是 Skill 目录）：

```bash
node scripts/validate-suite.mjs <suite-root>
```

`error` 必须修复并重新运行；`warning` 要如实报告。不要把导入界面的失败当作校验通过。

## 交付

报告：

- 源目录绝对路径
- 成员与资源清单
- 校验输出
- 导入步骤：Experts → Suite → 导入 Suite → 本地文件夹 → 预览 → 确认导入
- 两个事实：导入后 Suite 不可变；`reference` 成员指向现有 Expert，不复制其定义。

不要声称 Suite 已创建或已导入，直到用户完成导入并被界面确认。
