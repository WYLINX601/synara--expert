# Expert 契约与契约提案（归档）

- 状态：`backlog`，2026-11-22 归档，本次不交付
- 来源：`_bmad-output/initiative-expert-suite-hub/plan-expert-evolution-optimization.md` Phase 1、Phase 3
- 代码快照：分支 `archive/expert-contract-2026-11-22`，提交 `1d27214fee09d1198c3e70db9912dd88fded77ef`
- 当前交付只保留：`.claude/agents` 导入、零 Token 进化信号门

## 1. 结论

契约本身是有效的产品方向，但本次交付不包含契约字段、首轮槽位、契约编辑器、composer 槽位、建议性章节提示和契约 proposal。原因不是技术不可行，而是：

- 已有实现如果只保留后端、不保留 UI，会形成没有用户入口的隐藏能力；
- 契约 proposal 需要新的模型结构化输出、diff UI 和确认写入路径，无法复用现有 Skill/Memory proposal；
- 仓库政策要求 UI 变更单独授权与审查，先归档可以避免把未定稿的界面混入本次交付。

因此将契约整体归档，后续作为独立产品方案恢复。

## 2. 问题与用户场景

Expert 目前只有自由文本的 persona / outputRequirements：

- 用户无法在首轮发送前结构化地补齐必要参数；
- 用户无法声明“最终输出必须包含哪些章节”；
- 用户无法把“完成度标准”作为可审查清单；
- 用户无法从一次成功实战中沉淀契约修改建议。

目标不是把 Expert 变成工作流引擎，而是让固定 Expert 在**首轮输入**和**输出审查**上有最小可验证契约。

## 3. 已实现后又被归档的范围

### 3.1 契约字段

`ExpertDefinition`、`ExpertSaveInput`、`ExpertSnapshot` 增加可选 `contract`：

```ts
contract?: {
  inputs?: Array<{
    key: string;              // ^[a-z0-9_-]{1,64}$
    label: string;            // <= 200
    type: "string" | "git_ref" | "file_path" | "url" | "enum";
    required?: boolean;
    options?: string[];       // enum only, <= 32
    default?: string;         // <= 2_000
    promptIfMissing?: string; // <= 500
  }>;                          // <= 8
  output?: { requiredSections?: string[] }; // <= 20 x 100
  definitionOfDone?: string[];              // <= 20 x 500
}
```

快照版本为 `schemaVersion: 4`，契约参与 `hashSnapshot`；旧 v2/v3 快照只读兼容。

### 3.2 首轮槽位

- 只在该线程首次 Expert 发送时要求必填槽位；
- 服务端在固定快照后按该快照契约校验；
- 未知 key、必填缺失、超长、enum 非法拒绝，不产生半条消息；
- 通过后渲染稳定标签块进入该轮消息；
- 后续回合不重复追问。

### 3.3 建议性出口检查

- `requiredSections` 由 Web 从最终助手消息做大小写/空白归一化检查；
- 缺失时显示建议性提示；
- 不改变 `review`/`done`，不新增服务端事件，不默认追加自检回合；
- `definitionOfDone` 只作为人工审查清单。

### 3.4 契约 proposal

计划中的 proposal 链路：

1. 从一次完成回合生成契约 diff（输入槽位 / 输出章节 / DoD）；
2. 用户在进化界面查看 diff；
3. 用户确认后走现有 `saveExpert(expectedRevision)` 写新 revision；
4. 未确认不落盘，旧快照/旧任务不变。

未新增持久 proposal 表；提案是瞬态数据。

## 4. UI 示意图

### 4.1 Expert 编辑器 · 契约页签

```text
┌──────────────────────────────────────────────────────────────┐
│  规划专家                         [对话] [检查配置] [⋯]      │
│  [设置] [能力] [契约] [任务历史] [进化]                       │
├──────────────────────────────────────────────────────────────┤
│  输入槽位                                                     │
│  首次发送时收集。必填且没有默认值的槽位必须在发送前填写。      │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ 标签 [Branch        ]  键 [branch      ]               │  │
│  │ 类型 [Git 引用 v]       ☑ 必填                         │  │
│  │ 默认值 [main                          ]                │  │
│  │ 缺失提示 [请填写目标分支              ]                │  │
│  │                                          [删除输入]    │  │
│  └────────────────────────────────────────────────────────┘  │
│  [+ 添加输入]                                                │
│                                                              │
│  输出章节                                                     │
│  每行一个章节标题；仅作为建议性检查，不改变任务状态。          │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ 结论                                                   │  │
│  │ 证据                                                   │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  完成度声明                                                   │
│  每行一条，供人工审查。                                       │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ 给出可复现步骤                                         │  │
│  │ 标明未验证范围                                         │  │
│  └────────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│  保存后将创建新的专家版本。              [放弃更改] [保存更改] │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 Composer 首轮槽位

```text
┌──────────────────────────────────────────────────────────────┐
│  [附件/引用区域]                                             │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ 专家输入                                               │  │
│  │ Branch *   [main                                  ]    │  │
│  │ Mode       [full v]                                    │  │
│  │ Note       [首次发送前需填写                      ]    │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  输入消息…                                                   │
│                                                              │
│  [+ 附件] [专家：规划专家] [模型/Effort]        [语音] [发送] │
└──────────────────────────────────────────────────────────────┘
```

缺必填时：输入框 `aria-invalid`，下方提示“首次发送前需填写”，发送不发起请求。

### 4.3 建议性章节提示

```text
┌──────────────────────────────────────────────────────────────┐
│  … 助手最终消息 …                                             │
│                                                              │
│  本次输出缺少契约章节：证据、风险。此提示不改变任务状态。      │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  输入消息…                                             │  │
│  └────────────────────────────────────────────────────────┘  │
│  [+ 附件] [模型]                                  [发送]     │
└──────────────────────────────────────────────────────────────┘
```

### 4.4 Tasks / Kanban 遇到必填槽位

```text
┌──────────────────────────────────────────────┐
│  该任务需要先填写专家输入                     │
│  已转到聊天编辑器；填写后会从首轮发送。       │
│                              [打开聊天]       │
└──────────────────────────────────────────────┘
```

## 5. 后续开发建议

### 5.1 先恢复契约基础，再单独做 proposal

建议拆成两个独立交付：

1. **契约基础**
   - 契约字段、快照 v4、保存/预览校验；
   - 首轮槽位与 composer 输入；
   - 建议性章节提示；
   - 完整 UI 授权与浏览器测试。

2. **契约 proposal**
   - 新增瞬态 `ContractProposal` 返回结构；
   - 模型生成 + diff UI + 确认应用；
   - 不新增持久表；
   - 复用 `saveExpert(expectedRevision)`；
   - 未确认不改定义，确认后 revision+1。

### 5.2 恢复代码

归档分支包含契约实现与本次已交付的导入/信号门改动。恢复时只取契约相关文件与 hunk：

- 契约：`packages/contracts/src/expert.ts`、`orchestration.ts`、`expert.test.ts`
- 共享：`packages/shared/src/expertContract.ts`、`expertContract.test.ts`、`packages/shared/package.json` export
- 服务端：`ExpertStore.ts`、`expertSnapshotSession.ts`、`OrchestrationEngine.ts`、`decider.ts`、`ProviderService.ts`、`RunSkillAssemblyStore.ts`、`expertRpc.ts`、对应测试
- Web：`ExpertContractEditor.tsx`、`ExpertContractInputs.tsx`、`ChatView.tsx`、`ExpertEditor.tsx`、`ExpertsSettingsPanel.tsx`、`expertSettingsModel.ts`、`composerDraft*`、`draftThreadDispatch.ts`、`useChatTurn*`、`useComposerDiscovery.ts`、`ExpertTaskControl.tsx`、`kanban*`、`routes/_chat.experts.tsx`
- 混合文件需重新加入：`betaFeatures.ts` 的 `expert-contract` key、CHANGELOG、技术设计段落

恢复后必须重跑 contracts/shared/server/web typecheck、契约聚焦测试、Stable flavor 检查与真实 Provider 冒烟。

## 6. 验收（恢复时使用）

- 无 `contract` 的旧 Expert、旧 v2/v3 快照、已开始任务行为不变；
- 同一 Expert 修改定义后，已绑定任务仍用原快照契约；新任务才用新定义；
- 必填槽位缺失：Web 不发请求；直接构造命令也被服务端拒绝；
- 未知 key、超长值、enum 非法值均拒绝，且不产生半条消息；
- 不新增模型调用；
- 缺失章节只显示建议，不改变 `review`/`done`；
- 契约 proposal 未确认时定义字节不变，确认后 revision+1，旧快照/旧任务不变；
- Beta-only：服务端拒绝、Web 隐藏、Stable 持久状态惰性。

## 7. 非目标

- 第二套 `SynaraExpert` 规格、Base/Overlay/Memlog 目录；
- 任意 JSON Schema 校验、`json_schema_file`；
- `handoff_projection`、`tool_policy`、`context_ingestion`；
- 硬 DoD 门、默认模型自检回合；
- 契约自动写入；
- 新的 Studio/专家工作台页面。

## 8. 开放问题

- 契约 proposal 由哪个模型输出承载：复用 `SkillEvolutionOpportunity` 还是新增独立 RPC；
- proposal 的过期与并发语义；
- 契约章节检查是否需要在多客户端持久化；
- 槽位是否允许敏感值；若允许，需要凭据引用而不是明文消息。
