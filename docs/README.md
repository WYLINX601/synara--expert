# Synara documentation

The full product documentation lives at [trysynara.com/docs](https://www.trysynara.com/docs). This
folder keeps a small set of focused guides that stay in sync with the repository:

- [Quickstart](./quickstart.md) — from installation to your first reviewed change in about five minutes.
- [Core concepts](./core-concepts.md) — projects, tasks, environments, provider sessions, and Git ownership.
- [Providers](./providers.md) — what Synara manages and what stays provider-owned.
- [External MCP integrations](./external-mcp.md) — pair another local app with a scoped Synara task surface.
- [Expert frontend redesign](./expert-frontend-redesign-plan.md) — expert configuration and per-expert MCP authorization flow.
- [Expert redesign acceptance](./expert-frontend-redesign-acceptance.md) — implementation evidence and remaining verification gaps.
- [Global MCP implementation acceptance](./global-mcp-implementation-acceptance.md) — candidate UI, RPC, runtime, focused checks, and explicit verification limits.
- [Workbench adaptation plan](./workbench-adaptation-plan.md) — static module entry points, host adapters, and scoped dependency boundaries.
- [Workbench adaptation acceptance](./workbench-adaptation-acceptance.md) — implementation and actual verification results.
- [Workbench development workflow](./workbench-development-workflow.md) — stages, scoped checks, and acceptance records.
- [Release process](./release.md) — release and signing setup checklist.
- [Beta channel](../BETA.md) — the packaged Synara Beta flavor, its isolated update feed, and how beta releases are cut.
- [Canary workflow](./canary.md) — install, update, operate, and roll back an isolated Canary build.

## Linx 产品与项目上下文

- [Linx 个人 AI 工作台｜产品设计方案 V2.0](./linx-product-design-v2.md) — 用户于 2026-10-10 提供的完整原文；当前产品方向与 MVP 规划，不代表实现或验收完成。
- [Linx / Synara Expert 项目上下文](../context/PROJECT_CONTEXT.md) — 当前方案、既有开发候选、权限与版本边界、后续任务路由。
- [Space / Project Context V1.1 实现](./space-project-context-v1-implementation.md) — 真实前后端接入、快照和 Provider 恢复；[交互 PRD](./space-project-context-v1-interaction-prd.md)与[接入验收](./space-project-context-v1-acceptance.md)。
- [Expert 产品与技术方案](./expert-product-technical-design.md) — 既有 Expert 子系统设计与实现约束，结合 V2.0 的上层产品范围阅读。

## Personal Workbench

- [轻量适配层与 UI 模块化方案](./workbench-adaptation-plan.md) — 当前专家与 MCP 的接入收拢、UI 边界、分阶段实施与收益验证。
- [Workbench adaptation acceptance](./workbench-adaptation-acceptance.md) — implementation and actual verification results.
- [全局 MCP 管理技术方案](./global-mcp-management-architecture.md) — CC Switch 参考、共享连接目录、专家授权、任务绑定与分阶段实施建议。
- [全局 MCP 交互方案](./global-mcp-interaction-design.md) — CC Switch 实际界面对照、服务列表、配置编辑与专家授权操作。
- [专家前端修改方案](./expert-frontend-redesign-plan.md) — 原型交互映射、Synara 原生风格、真实接口与实施步骤。
- [开发流程](./workbench-development-workflow.md) — 日常开发、集成与交付的检查选择、重跑规则和验收摘要。
- [架构设计](./workbench-architecture.md) — 工作台与 Synara 原生能力的接入边界。
- [实施计划](./workbench-implementation-plan.md) — 首轮底座改造的任务与依赖。
- [验收记录](./workbench-acceptance-2026-10-02.md) — 按版本记录的实际结果与未验证范围。

Other material lives in [docs/archive](./archive/) for historical reference.
