# Linx 个人 AI 工作台｜产品设计方案 V2.0

**版本定位：** 产品架构与核心功能设计  
**设计目标：** 建立长期智能协作与专业任务执行之间的完整工作闭环。

---

## 1. 产品定位

Linx 是一个面向个人学习、研究与工作的 AI-native 工作台。

产品围绕 **Space → Project → Task / Run** 组织用户工作，由 Hermes 等常驻智能体承担长期方向管理，由 Expert 和 Agent Team 完成专业任务，并通过 Skill Evolution 实现专业能力持续改进。

Linx 不以 IDE 或 Agent 管理平台为核心，而是让用户在一个界面中完成：

- 管理日常行动与长期目标。
- 持续推进多个工作方向和项目。
- 与常驻 AI 助理协作。
- 调用专业 Expert 深入讨论、分析与执行。
- 将成果及有效经验沉淀为可复用资产。

### 核心价值

**持续理解用户，持续推进方向，专注完成工作，持续积累能力。**

### 三个关键体验目标

1. **工作有连续性：** AI 能够长期跟进一个方向，不需要用户反复介绍背景。
2. **执行有专业性：** 具体任务可以进入相对干净的专家执行环境，按需加载 Project Context 和 Skills。
3. **成果有积累性：** 工作成果留在 Project，通用方法沉淀为 Skill，并服务于后续任务。

---

## 2. 核心产品架构

### 2.1 组织结构

```text
Linx
│
├── Home / Today
│   └── Hermes · Personal Assistant
│
├── Spaces
│   │
│   ├── Space A：学术研究
│   │   ├── Hermes · 学术负责人
│   │   ├── Project：硕士论文
│   │   ├── Project：传统建筑调研
│   │   └── Project：学术论文
│   │
│   ├── Space B：产品工作
│   │   ├── Hermes · 产品负责人
│   │   ├── Project：Linx 开发
│   │   └── Project：企业 IM Agent
│   │
│   └── Space C：职业发展
│       ├── Hermes · 职业发展负责人
│       └── Project：求职准备
│
├── Tasks / Inbox
│   └── 跨 Space 的统一任务视图
│
├── Experts & Skills
│   └── 专业能力配置与复用
│
└── Settings
    └── Agent、连接器、权限与自动化
```

**组织关系：**

- 一个 Space 对应一个主要负责人。
- 一个 Space 可以包含多个 Project。
- 一个 Project 默认属于一个 Space。
- Project 下包含 Task、Run、Thread 和 Artifact。
- Expert 和 Skill 是可跨 Space、跨 Project 复用的资源。
- 全局个人助理独立于各 Space 负责人，负责跨方向协调。

日常事项可以直接归属于 Space 或全局 Inbox，不强制创建 Project。

### 2.2 核心对象

| 对象 | 产品定义 | 生命周期 |
|---|---|---|
| Space | 长期工作方向与责任边界 | 长期 |
| Project | 围绕明确目标开展的具体工作 | 阶段性 |
| Task | 可执行、可跟踪的工作事项 | 短期 |
| Run | 一次 Agent 执行过程 | 单次 |
| Artifact | 可持续修改和复用的工作成果 | 长期保留 |
| Persistent Agent | 拥有持续身份与职责的 AI | 长期 |
| Expert | 可配置、可复用的专业能力角色 | 长期 |
| Skill | 可复用的专业工作方法 | 持续迭代 |

---

## 3. Space：长期工作方向

### 3.1 产品定位

Space 是 Linx 的核心长期组织单元。

它不只是 Project 的文件夹，而是一个包含**方向目标、项目集合、长期上下文和 AI 负责人**的工作空间。

例如：

- 学术研究：论文、调研、知识积累。
- 产品工作：产品设计、技术开发、行业研究。
- 职业发展：求职计划、岗位准备、能力提升。

### 3.2 Space 的必要信息

| 字段 | 说明 |
|---|---|
| Name | Space 名称 |
| Goal | 长期目标与当前重点 |
| Owner | 唯一主要负责人 |
| Projects | 关联的 Project |
| Context Sources | Obsidian、文件夹及其他资料引用 |
| Reporting | 负责人汇报规则 |
| Permissions | 负责人允许读取和执行的操作 |

Space 不需要独立复制全部 Project 文件。其 Context 以目标、索引、跨项目状态和长期决策为主。

### 3.3 Space Overview

Space 首页聚焦四个问题：

1. 这个方向正在实现什么目标？
2. 当前最重要的工作是什么？
3. 各 Project 推进得怎么样？
4. 负责人有什么建议或需要我确认的事项？

建议采用以下信息结构：

**顶部：** Space 名称、当前目标、负责人、联系负责人入口。

**主体：**
- Current Focus：当前最重要的 1–3 个事项。
- Projects：项目列表，显示进展和关键状态。
- Updates：最新进展、风险与待确认事项。

**交互：** 点击负责人，打开侧边对话面板；点击 Project，进入现有 Synara Project Workspace。

不在 Space 首页重复构建完整任务看板、文件管理器和聊天界面。

---

## 4. Hermes：常驻智能体体系

### 4.1 身份重新定位

Hermes 在技术上仍然拥有独立的 Agent Runtime，但在 Linx 中主要承担 **Persistent Agent（常驻智能体）**的产品身份。

它与 Expert 不同：

- Hermes：长期承担职责，维护状态与目标。
- Expert：针对具体任务提供专业能力。
- Agent Team：组织多个 Expert 协作完成复杂任务。

Hermes 不应仅仅作为与 Codex、Pi 并列的 Provider 选项呈现。

### 4.2 三种角色

#### A. Personal Assistant｜个人助理

**作用范围：全局**

负责用户日常学习、工作和生活的整体协调。

主要职责：

- 汇总跨 Space 的重要事项。
- 结合日历、任务和项目状态生成 Daily Brief。
- 管理个人长期偏好和重要目标。
- 发现阻塞、冲突和机会。
- 向 Space 负责人或专业 Expert 发起协作请求。

默认呈现在 Linx Home。

#### B. Space Owner｜方向负责人

**作用范围：单个 Space**

持续负责一个方向，关注长期目标和多个 Project 的整体推进。

主要职责：

- 理解 Space 目标和当前计划。
- 维护项目进度与关键决策。
- 发现跨项目依赖和风险。
- 提出下一步行动建议。
- 必要时创建任务或发起 Expert 协作。
- 定期向用户汇报。

一个 Space 绑定一个主要 Owner。

Owner 由 Hermes Profile 支撑，但不要求每个 Space 启动独立操作系统进程。建议默认使用隔离的方向记忆，避免学术、工作等 Context 相互干扰。

#### C. Team Coordinator｜团队调度者

**作用范围：某次复杂任务**

负责临时组织多个 Expert 工作。

主要职责：

- 拆解任务。
- 选择专业 Expert。
- 分配子任务与管理依赖。
- 跟踪执行。
- 整合成果并安排审查。

Team Coordinator 是一个可选协作角色，不一定长期存在，也不要求所有任务都通过它启动。

### 4.3 角色不等于 Prompt

一个常驻负责人除了人设，还应具备：

- **Scope：** 管理范围。
- **Responsibility：** 工作职责与目标。
- **Context：** 允许访问的信息。
- **Authority：** 可以执行的操作。
- **Reporting：** 汇报和主动工作机制。

因此，建议新增轻量的 `AgentAssignment`（角色分配）关系，将 Hermes Profile 与 Space 绑定。

### 4.4 权限原则

负责人可以主动分析和提出建议，但不能默认获得全部写入权限。

建议区分：

- 自动读取授权范围内的项目状态。
- 自动生成总结与建议。
- 创建任务、修改状态等操作依据授权执行。
- 删除资料、修改重要成果、访问外部敏感系统等操作需要明确审批。

**长期负责不等于无限自主执行。**

---

## 5. Project：专业工作单元

### 5.1 产品定位

Project 继续复用 Synara 的现有项目能力。

它负责一项具体工作的上下文、讨论、执行、文件与成果管理。

例如：

Space：学术研究  
Project：硕士论文  
Task：完成案例分析章节  
Expert：建筑研究专家

### 5.2 与 Space 的关系

Project 从所属 Space 获得：

- 所属工作方向。
- 必要的长期目标和约束。
- 负责人提供的任务背景。
- 相关知识源索引。

但 Project 不应自动加载 Space Owner 的完整记忆或历史会话。

### 5.3 Project Workspace

保留 Synara 当前成熟的工作体验。

重点能力包括：

- Project Context。
- Thread / Chat。
- Expert 选择与调用。
- Task 与 Run。
- 文件和 Artifacts。
- 后续的 Agent Team。

新增最小的 Space 关联与负责人协作入口即可，不建议大规模重构原有 Project UI。

---

## 6. Expert：专业能力体系

### 6.1 Expert 的定位

Expert 是 Provider 无关的专业角色配置，而非一个必须长期在线的智能体。

它主要由以下能力构成：

| 模块 | 作用 |
|---|---|
| Persona | 专业身份、职责和工作原则 |
| Skills | 专业方法与操作流程 |
| References | 可引用的资料和知识源 |
| Connections | 工具与外部系统 |
| Runtime Preferences | 执行偏好及 Provider 配置 |

继续保留现有 Expert 配置体系，尤其不需要重做 Skills 配置界面。

### 6.2 Expert 与 Hermes 的关系

Hermes 可以选择并调用 Expert，但 Expert 不依附于 Hermes。

用户也可以在 Project 中直接启动 Expert。

Expert 默认加载：

1. 当前任务目标与约束。
2. 必要的 Project Context。
3. 自身 Persona 与相关 Skills。
4. 明确授权的知识源。

不自动加载 Hermes 的全部长期记忆。

---

## 7. Context 设计

### 7.1 四类 Context

| 类型 | 主要来源 | 核心用途 |
|---|---|---|
| Personal Context | Hermes Memory | 了解用户、偏好和长期目标 |
| Space Context | Space + Owner | 了解方向、跨项目关系及长期决策 |
| Project Context | Synara Project | 理解具体工作与已有成果 |
| Expert Context | Persona + Skills | 提供专业方法和执行约束 |

Obsidian 作为长期知识底座，为 Space、Project 和 Expert 提供按需检索的知识来源。

**知识只维护权威来源，其他对象保存索引、引用和必要摘要。**

### 7.2 Context 加载原则

采用按需组装，而不是逐层全文继承。

对于一次专业任务：

**Task Context = 当前任务 + 必要 Project Context + 选定 Expert Skills + 少量相关 Space Context**

Personal Context 仅在任务确实需要用户偏好、个人目标等信息时加载。

### 7.3 最小任务上下文包

建议统一以下字段：

- Task Goal：要完成什么。
- Constraints：约束与边界。
- Project References：相关资料与成果。
- Relevant Context：必要背景。
- Expert / Skills：专业角色和方法。
- Expected Output：交付要求。
- Allowed Actions：操作权限。

上下文包用于执行时的信息组织，不必成为独立的大型知识存储系统。

---

## 8. Skill Evolution：通用专业进化机制

### 8.1 产品定位

Skill Evolution 是 Synara 独立的专业能力进化插件。

借鉴 Hermes 的 Skill 学习与修改机制，但不依赖 Hermes 作为执行 Agent。

它服务于所有支持的 Provider 和 Expert。

### 8.2 核心流程

**Run 完成 → 经验识别 → Skill 修改建议 → 审核 → 新版本生效**

主要能力：

- 从 Run、用户反馈和成果中提取经验。
- 识别有复用价值的工作方法。
- 创建 Skill 或修改已有 Skill。
- 提供 Diff 预览。
- 人工确认并记录版本。
- 后续任务使用更新后的 Skill。

### 8.3 MVP 设计

第一版优先提供：

**任务完成后 →「提炼为 Skill」→ 展示修改建议 → 用户确认**

不需要一开始就建立自动学习中心。

后续再支持在明确纠错、重复失败等场景下自动分析并提出修改建议。

Skill 可以跨多个 Expert、Project 和 Space 复用。

Project 中保留原始成果；Skill 中只沉淀通用、可执行的方法，不将整个任务过程写入 Skill。

### 8.4 版本和质量控制

- 不自动覆盖已发布 Skill。
- 修改建议必须能追溯到来源 Run。
- 用户可以审核和回滚。
- 任务运行期间使用固定的 Skill 版本。
- 修改后的 Skill 在后续任务中生效。

---

## 9. Agent Team：专业协作机制

Agent Team 是复杂任务的可选执行模式。

不建议所有任务默认启动多 Agent。

### MVP 形态

**主 Expert 执行 + 独立 Expert 审查。**

主 Expert 负责方案和交付，审查 Expert 负责检查目标满足情况、事实依据、错误与遗漏。

审查方应尽量独立获取任务目标和必要证据，避免完全继承主 Expert 的推理和判断。

### 后续扩展

- 多 Expert 并行分工。
- Team Coordinator 动态分配任务。
- 任务依赖管理。
- 多结果比较与冲突处理。
- 用户审批和成果汇总。

**Hermes 负责持续推进方向，Agent Team 负责完成复杂专业任务。**

两者可以结合，但不应强制绑定。

---

## 10. 关键用户工作流

### 场景 A：日常规划与项目推进

1. 用户打开 Linx Home。
2. Hermes Personal Assistant 汇总各 Space 的重点工作。
3. 用户选择某个 Space。
4. Space Owner 展示当前目标、项目进展与下一步建议。
5. 用户进入一个 Project。
6. 选择 Expert，开始深入讨论或执行任务。

**价值：** 从全局规划自然进入具体工作，不需要反复建立背景。

### 场景 B：Space Owner 主动发现问题

1. Space Owner 定期读取授权范围内的 Project 状态。
2. 发现项目延误、任务阻塞或遗漏。
3. 生成建议和待确认事项。
4. 用户批准后，创建或调整 Task。
5. 重要进展同步至 Home。

**价值：** 用户不必持续手动检查每一个 Project。

### 场景 C：专业任务与经验进化

1. 用户在 Project 中启动 Expert。
2. Expert 根据 Project Context 和 Skills 执行任务。
3. 完成 Artifact，用户进行验收。
4. 使用 Skill Evolution 提炼有效方法。
5. 用户审核并应用 Skill 修改。
6. 后续 Expert 运行时复用新的专业方法。

**价值：** 工作成果不仅留存，也能改善后续执行。

### 场景 D：复杂任务团队协作

1. 用户提交复杂任务。
2. 选择主 Expert，必要时启用 Team。
3. Coordinator 组织分工与执行。
4. 各 Expert 在独立上下文中工作。
5. 统一汇总、审查和交付。
6. Project 保存成果，Space Owner 获得结构化进展。

**价值：** 同时兼顾任务质量与长期工作连续性。

---

## 11. Linx UI 信息架构

### 一级导航

| 入口 | 功能 |
|---|---|
| Home | 今日重点、全局助理、跨方向信息汇总 |
| Spaces | 长期方向、负责人、Project 导航 |
| Tasks | 统一任务与 Inbox |
| Experts | 专业角色和 Skills |
| Settings | 连接器、Agent 运行配置、权限 |

Project 主要从所属 Space 进入，同时保留最近访问和全局搜索快捷入口。

### Home

继续采用轻量的个人工作首页：

- Today / Top Priorities。
- Current Focus。
- 跨 Space 的重要更新。
- 待处理事项。
- Hermes Personal Assistant。
- 最近访问的 Project。

避免将各 Space 的完整项目列表全部复制到 Home。

### Space Overview

重点展示方向目标、负责人、当前重点、Project 和关键更新。

### Project Workspace

沿用 Synara 现有专业工作界面，保留对话、执行、文件、成果和 Expert 能力。

### Expert Center

维护专业能力配置，增加 Skill Evolution 的修改记录入口即可。

---

## 12. 技术架构原则

### 12.1 Linx 掌握核心业务对象

Linx 应掌握 Space、Project、Task、Artifact、Agent Assignment 和 Run 的业务关系。

Hermes Profile、Codex、Pi 等运行时配置属于外部执行系统，不应成为 Linx 业务数据模型的基础。

### 12.2 Hermes 接入方式

优先将 Hermes 作为 **Persistent Agent Service** 接入。

主要接口方向：

- Linx → Hermes：对话、状态、记忆范围及定时任务。
- Hermes → Synara：查询 Project、创建 Task、启动专业执行、读取结果。
- Synara → Hermes：提供经过筛选的项目进展与执行结果。

可结合 Hermes API、MCP 与 Synara 已有接口实现，具体需要以当前 Fork 的实际能力为准。

这不妨碍未来将 Hermes 进一步适配为普通 Provider，但不将其作为 MVP 的主要目标。

### 12.3 Skill Evolution 接入方式

以 Provider 无关的独立模块实现。

接收标准化 Run 结果及反馈，调用已配置的模型完成经验分析，操作标准 Skill 文件。

不要求 Hermes Runtime 参与，也不要求其他 Provider 理解 Hermes 的原生 Memory 格式。

### 12.4 低改造原则

优先扩展现有 Synara：

- 保留 Project Workspace。
- 保留 Expert 配置与 Skill 引用方式。
- 复用已有 Task / Run 数据。
- 新增 Space 与 Agent Assignment。
- 增加 Hermes 服务连接与 Skill Evolution。

不为了这次产品调整重构整个 Agent Harness。

---

## 13. MVP 开发规划

### P0：建立 Space + Hermes 长期负责的基础体验

**目标：验证 AI 能否长期负责一个方向。**

- 新增 Space 对象与基本 UI。
- 将现有 Project 关联到 Space。
- 一个 Space 绑定一个 Hermes Owner。
- 支持 Space Owner 对话。
- Owner 可以读取授权范围内的项目状态并形成摘要。
- Home 可查看跨 Space 的重要事项。

**验收：** 用户能创建一个学术 Space，将两个 Project 纳入其中，与负责人持续讨论项目状态，且负责人能够基于实际项目数据给出进展汇报。

### P0：Skill Evolution MVP（可并行开发）

**目标：验证跨任务的专业经验复用。**

- 在 Run 完成后手动触发经验提炼。
- 支持新建 / Patch Skill。
- 支持 Diff 审核和回滚。
- 后续 Expert 可使用新版本 Skill。

**验收：** 一次任务中的有效改进，可以被提炼为 Skill，并在另一个任务中复用。

### P1：长期协作闭环

- Hermes 创建与跟踪 Synara Task。
- Space Owner 主动识别项目阻塞。
- 负责人定期汇报与待确认事项。
- Home 汇总多个 Space 的状态。
- Agent Assignment 权限控制。

**验收：** 负责人不仅能够回答问题，还能在授权下持续推动 Project 进展。

### P2：复杂任务与高级进化

- Expert Team。
- Team Coordinator。
- Skill Evolution 自动触发。
- Skill Curator 与质量评价。
- 更丰富的跨 Space 协同。

---

## 14. 明确不做什么

为了保持 MVP 简洁，当前不做：

1. 重建一套独立于 Obsidian 的知识库。
2. 给所有 Expert 配置长期个人记忆。
3. 为每个 Project 强制创建 Hermes。
4. 为每次任务默认启动 Agent Team。
5. 自动批准和发布 Skill 修改。
6. 重新实现 Synara 已经具备的 Project 和执行功能。
7. 一开始就建设复杂的数字员工组织、绩效与层级管理系统。

---

## 15. 产品设计原则

**原则一：长期负责与专业执行分离。**  
Hermes 负责方向的连续性，Expert 负责具体任务的专业性。

**原则二：Context 按需流动。**  
共享必要信息，而不是共享所有记忆与对话。

**原则三：知识与能力分离。**  
Obsidian 保存知识，Skill 保存专业方法，Project 保存工作成果。

**原则四：AI 主动但可控。**  
允许主动发现和提出建议，执行权限必须有明确边界。

**原则五：能力持续进化，但不污染执行环境。**  
通过 Skill Evolution 维护可验证、可复用的方法，而不是无限累积 Context。

**原则六：优先复用现有能力。**  
以增量开发构建 Linx，不将重构 Agent Runtime 作为产品前提。

---

## 16. 最终产品形态

Linx 最终由三类核心能力协同构成：

**Persistent Agents｜常驻智能体**  
长期理解用户与工作方向，承担持续责任。

**Experts & Agent Teams｜专业执行体系**  
根据具体任务组合专业能力，深入分析、执行和验证。

**Knowledge & Skill Evolution｜知识与能力体系**  
连接 Obsidian、Project 和 Skills，让工作成果能够持续复用。

三者共同形成：

**方向管理 → 项目推进 → 专业执行 → 成果沉淀 → 能力改进 → 持续推进**

这就是 Linx 从普通 AI 工作台迈向长期人机协作系统的核心路径。