# synara-suite.json v1

源目录根部的唯一清单。未知字段会保留在原始源中，但不会进入运行配置；不要依赖它们。

## 顶层

| 字段                      | 必填 | 约束                              |
| ------------------------- | ---- | --------------------------------- |
| `schemaVersion`           | 是   | 固定为 `1`                        |
| `name`                    | 是   | 非空字符串，≤200                  |
| `description`             | 是   | 字符串，≤16000                    |
| `experts`                 | 是   | 1–5000 项                         |
| `resources`               | 否   | ≤5000 项                          |
| `sharedResourceKeys`      | 否   | 资源 key 数组                     |
| `coordinatorResourceKeys` | 否   | 资源 key 数组                     |
| `defaults`                | 否   | 仅 `language` / `outputDirectory` |

所有 `key` 在成员和资源之间必须唯一；引用到的 resource key 必须先在 `resources` 声明。

## 成员

```json
{ "key": "pm", "kind": "reference", "expertId": "expert_existing" }
```

```json
{
  "key": "author",
  "kind": "definition",
  "name": "Author",
  "description": "Writes specifications",
  "personaPath": "roles/author.md",
  "resourceKeys": ["rules"]
}
```

- `reference` 只引用本机已有且未归档的 Expert；不复制定义，后续修改会影响成员可用性。
- `definition` 会新建 Expert，只支持 `name`、`description`、`personaPath` 和 `resourceKeys`。persona 文件必须是非空 UTF-8，长度 ≤32000。
- 成员没有 `useCases`、`outputRequirements`、模型、MCP 或成员级覆盖字段。

## 资源

```json
{
  "key": "rules",
  "kind": "files",
  "root": "files/rules",
  "purpose": "instructions"
}
```

```json
{
  "key": "review",
  "kind": "skill",
  "packageRoot": "skills",
  "entryPath": "review/SKILL.md"
}
```

```json
{
  "key": "browser",
  "kind": "connection",
  "connectionId": "playwright",
  "tools": { "mode": "selected", "names": ["navigate", "screenshot"] }
}
```

```json
{
  "key": "existing",
  "kind": "resource-reference",
  "resourceRef": {
    "kind": "managed-skill",
    "sourceId": "local",
    "managedSkillId": "skl_..."
  }
}
```

- `skill`：`packageRoot` 是包根，`entryPath` 相对包根，最后一段必须是 `SKILL.md`。入口文件必须真实存在。
- `files`：`root` 是目录；`purpose` 只能是 `instructions`、`reference`、`template`、`workflow`。
- `connection`：只引用已有连接；导入不会创建或验证连接。`tools.mode` 为 `all`，或 `selected` 且提供 `names`。
- `resource-reference`：只引用已有资源；`resourceRef.kind` 支持 `skill`、`managed-skill`、`files`、`connection`。无法确认存在时不要写入。

## 默认值

```json
{ "defaults": { "language": "中文", "outputDirectory": "docs/generated" } }
```

没有成员级默认值。`outputDirectory` 在运行时还会按项目边界校验。

## 路径安全

- 所有清单路径必须是相对路径，使用 `/`，NFC。
- 不允许绝对路径、`..`、反斜杠、控制字符或软链接组件。
- 资源必须位于源目录内；不要在源目录中放指向外部目录的链接。
