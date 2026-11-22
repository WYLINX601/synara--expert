# Expert 进化与导入真实验证（2026-11-22）

- 范围：`.claude/agents` 导入、零 Token 信号门、OMP/Pi 真实 Provider、打包 Stable 往返
- 隔离数据：`/tmp/synara-e2e-20261122`（Beta/dev 数据）、`/tmp/synara-stable-roundtrip`（Stable）
- 契约与契约 UI 已归档，不在本次验证范围

## 1. 真实 Provider

| Provider | 模型                        | 回合                                               | 结果                     |
| -------- | --------------------------- | -------------------------------------------------- | ------------------------ |
| OMP      | `openai-codex/gpt-6.1-sol`  | 导入 Expert，读取 `README.md` 并返回 `VERDICT: OK` | 7.1s，返回 `VERDICT: OK` |
| Pi       | `openai-codex/gpt-5.6-luna` | 同一 Expert，读取 `README.md` 并返回 `PI: OK`      | 9.9s，返回 `PI: OK`      |

OMP 线程的 `projection_threads.model_selection_json` 为：

```json
{ "provider": "omp", "instanceId": "omp", "model": "openai-codex/gpt-6.1-sol" }
```

Pi 线程使用同一联动路径；Provider 切换通过 Expert 默认模型固定，未依赖手工改线程会话。

证据：

![OMP 真实回合返回 VERDICT: OK](/Users/wangyuelin/.linx/codex-home-overlay/generated_images/browser-proof/ab020d1399f3c9747df5c079/8f21c54f-499f-4e7e-8c77-2bdb6a7b96db.png)

![Pi 真实回合返回 PI: OK](/Users/wangyuelin/.linx/codex-home-overlay/generated_images/browser-proof/ab020d1399f3c9747df5c079/a4b5b7f5-5bd3-4e5a-9e88-9901e6c9670c.png)

## 2. 零 Token 信号门

在 Pi Expert 上开启自学习后：

1. 普通回合（`NEUTRAL: OK`）完成：
   - `expert_learning_cycles`：0
   - `expert_learning_evidence`：1
2. 纠偏回合（`That's not right; correct it ...`）完成：
   - `expert_learning_cycles`：1
   - `expert_learning_evidence`：2
   - cycle 记录：

```json
{
  "status": "no_change",
  "signalScore": 3,
  "signalReasons": ["user_correction"]
}
```

说明：纠偏回合按预期进入 discovery；本次 discovery 返回 no_change，未写回 Skill/Memory。普通回合未创建 cycle，也未调用 discovery 模型。

## 3. Stable 打包与往返

产物：

- `Synara-1.1.0-arm64.zip`
- SHA-256：`d674688c38f1fa6cb4a5e7006eb556d3efcfb18173e9427be4e995a7c21d9b67`
- Bundle：`com.emanueledipietro.synara`，版本 `1.1.0`

构建限制与本地 workaround：

- 本机只有 Command Line Tools，无 `actool`；使用已有预编译 `Assets.car`（`SYNARA_MAC_ICON_CATALOG`）。
- 本机无 Rust 1.97.1；使用已有带 provenance 的 Cua 驱动目录（`SYNARA_CUA_ARTIFACT_DIR`）。
- 本地 `--target zip` 不生成 updater manifest；仅在本次本地验证中临时关闭 manifest 要求，构建后已还原 `scripts/build-desktop-artifact.ts`。该产物不是正式 release/sign/notarize 产物。

验证：

- 打包后的 Electron Stable 应用可启动；服务端在隔离 `SYNARA_HOME` 下运行迁移并启动引擎。
- 将 Beta/dev 的 `state.sqlite`、`experts/`、`suites/` 复制到 Stable 隔离目录（仅测试用途；产品支持的迁移方向是 Stable → Beta，不是 Beta → Stable）。
- Stable UI 能读取 Beta 创建的导入 Suite 与 `E2E Reviewer` Expert：

![Stable 读取 Beta 创建的导入 Suite](/Users/wangyuelin/.linx/codex-home-overlay/generated_images/browser-proof/ab020d1399f3c9747df5c079/1c72b2d8-af90-45bd-ae74-c188d65cb0c5.png)

![Stable 读取 Beta 创建的 Expert](/Users/wangyuelin/.linx/codex-home-overlay/generated_images/browser-proof/ab020d1399f3c9747df5c079/079e8e03-ea47-4967-837d-2e942d129214.png)

- Stable gate 单测：`SuiteSourceAdapters.test.ts` 在 production flavor 下拒绝 `.claude/agents`；`betaFeatureGate.test.ts` 验证导入与信号门在 Stable 关闭、Beta 开启。
- 打包 Electron 窗口由桌面应用自身启动；共享浏览器无法复用其随机 auth token，因此 UI 读取使用了从打包 asar 提取的同版本服务端并以关闭 auth 的隔离模式运行。未通过 Electron 窗口执行人工点击。

## 4. 未覆盖

- 未在 Stable 中执行真实 Provider 回合（保留能力为读取已导入数据与 gate 关闭）。
- 未验证正式签名、notarization、DMG 安装、Gatekeeper 接受。
- 未验证 Claude Code 的 `.claude/agents` 真实导入后运行（仅 OMP/Pi）。
- 未验证 Stable → Beta 的产品迁移方向；本次仅验证反向测试数据可读性。
