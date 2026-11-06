# Personal Workbench 0.1.13 本机安装

日期：2026-11-04。用户授权安装 GitHub 最新修复；已安装并启动 `/Applications/Personal Workbench.app`。

- 精确源码：远端 main `238f5eda0bb2625c40bfd63224194aaca90fe4b8`，PR #7；本机分支从其父提交 fast-forward。包含专家默认模型持久化及原生模型选择器修复，无额外代码修改。
- 本地版本：0.1.13；Node 24.13.1 / Bun 1.4.2；锁文件 SHA-256 `f3a13e91999ced2111ca55dfd04db2c7f63c3b91e8be7fbd314e22a3daffd45f`。
- 精确提交的 GitHub CI [41768233182](https://github.com/WYLINX601/synara--expert/actions/runs/41768233182) 全部成功，涵盖静态、类型、单元、浏览器、迁移及桌面构建；本机未重复完整测试。额外宿主边界检查通过。
- 本机编译、ZIP 完整性、包内源码和锁元数据、安装前严格签名、隔离依赖与启动检查通过。app.asar SHA-256 `5125c99a0a2691a5dbc4b36e4486a2524999b6b7df06b967f055db78d1abc3d6`。
- 安装前后 113 张非迁移表的结构及数据完全一致；35 个聊天、20 个项目、3 个 Space、365 条可见消息的身份一致，781 份设置及专家保护文件完全一致。无数据库迁移变化，Expert 保持 13；未替换日用数据。
- 新应用实际进程和日用 home 对应，HTTP 200、startupReady=true、projection=healthy。未提交真实模型测试任务。
- 备份时应用已退出且数据库无占用。持久化状态中有一条标记 running 的旧自动化任务，但完成时间为 2026-11-03；单独记录该残留，不修改业务行。
- 安装包为本地 ad-hoc 签名，无 Developer ID／公证。启动后已有 Finder 图标元数据造成严格签名诊断；全部包内文件、权限及链接与验收包一致，仅新增 Finder 图标文件。

复用唯一交付根 `.synara/expert-evolution-delivery-20261029/`；当前 `installation-receipt.json`、`current-recovery.json`、`application-recovery.json` 已更新并回读。保留上一版 0.1.12 原应用、校验通过的 ZIP、本次新备份数据库／设置及 8 个托管工作区与 Electron profile。恢复前停止应用并另存更新后工作，按恢复入口使用成套资料。

已清理临时解压应用、安装后数据库核对副本和被 0.1.12 替代的 0.1.11 应用／ZIP。既有 0.1.9 固定迁移恢复资料及历史数据库备份保留；历史备份轮换需另行兼容性审计，未声称全部存储治理完成。收尾可用空间约 25 GiB。没有新增工作树、推送、发布或修改更新源。
