import React, { useLayoutEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { ZenModeBubble } from "~/components/chat/ZenModeBubble";
import { Button } from "~/components/ui/button";
import { buildThemeCssVariables, DEFAULT_THEME_STATE, resolveThemePack } from "~/theme/theme.logic";
import type {
  BaselineFrameMessage,
  BaselineScene,
  CompanionPhase,
  CompanionStatus,
} from "./baseline.types";
import type { PreviewControlMessage } from "./previewBridge";
import "./style.css";

const scenes: readonly BaselineScene[] = [
  "idle",
  "history",
  "running",
  "question",
  "approval",
  "error",
];
const sceneLabels: Record<BaselineScene, string> = {
  idle: "ZB-01 空闲输入",
  history: "ZB-02 历史会话",
  running: "ZB-03 生成中",
  question: "ZB-04 待回答",
  approval: "ZB-05 待审批",
  error: "ZB-06 执行失败",
};
const phaseLabels: Record<CompanionPhase, string> = {
  idle: "随时协作",
  running: "正在处理",
  question: "需要你回答",
  approval: "等待你审批",
  error: "执行遇到错误",
  complete: "已完成",
};
type Surface = "bubble" | "panel" | "hidden";
type Mode = BaselineFrameMessage["mode"];
type PendingMode = { requestId: number; mode: Mode; surface: Surface; focusEditor: boolean };

function isCompanionStatus(value: unknown): value is CompanionStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as Partial<CompanionStatus>;
  return (
    (status.phase === "idle" ||
      status.phase === "running" ||
      status.phase === "question" ||
      status.phase === "approval" ||
      status.phase === "error" ||
      status.phase === "complete") &&
    typeof status.threadId === "string" &&
    typeof status.threadTitle === "string" &&
    typeof status.revision === "number" &&
    Number.isSafeInteger(status.revision) &&
    status.revision >= 0
  );
}

function ReviewPage() {
  const iframe = useRef<HTMLIFrameElement>(null);
  const bubble = useRef<HTMLButtonElement>(null);
  const restore = useRef<HTMLButtonElement>(null);
  const sceneRef = useRef<BaselineScene>("idle");
  const surfaceRef = useRef<Surface>("bubble");
  const statusRef = useRef<CompanionStatus | null>(null);
  const unreadRevisionRef = useRef<number | null>(null);
  const pendingRef = useRef<PendingMode | null>(null);
  const requestIdRef = useRef(0);
  const focusRef = useRef<"editor" | "bubble" | "restore" | null>(null);
  const frameRef = useRef<BaselineFrameMessage>({
    source: "synara-zen-baseline",
    mode: "zen",
    expanded: false,
    isBubble: true,
    height: 160,
  });
  const [scene, setScene] = useState<BaselineScene>("idle");
  const [surface, setSurface] = useState<Surface>("bubble");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState(frameRef.current);
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [unread, setUnread] = useState(false);
  const [pendingMode, setPendingMode] = useState<Mode | null>(null);
  const [modeNotice, setModeNotice] = useState<string | null>(null);

  const send = (message: PreviewControlMessage) => {
    iframe.current?.contentWindow?.postMessage(message, window.location.origin);
  };
  const reveal = (next: Surface, focusEditor = false) => {
    // Update refs before React commits: a status and a frame can arrive in one batch.
    surfaceRef.current = next;
    setSurface(next);
    if (next === "panel") {
      unreadRevisionRef.current = null;
      setUnread(false);
    }
    focusRef.current =
      next === "bubble" ? "bubble" : next === "hidden" ? "restore" : focusEditor ? "editor" : null;
  };
  const showMode = (mode: Mode, next: Surface = "panel") => {
    if (!ready || pendingRef.current) return;
    setModeNotice(null);
    const focusEditor = next === "panel" && mode === "zen";
    if (frameRef.current.mode === mode && !frameRef.current.isBubble) {
      reveal(next, focusEditor);
      return;
    }
    // The unchanged app/provider owns mode changes. Keep the old surface until ack.
    const requestId = ++requestIdRef.current;
    pendingRef.current = { requestId, mode, surface: next, focusEditor };
    setPendingMode(mode);
    send({ source: "synara-zen-review", type: "show-mode", requestId, mode });
  };
  const hide = () => {
    if (!pendingRef.current) send({ source: "synara-zen-review", type: "hide-bubble" });
  };

  useLayoutEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || event.source !== iframe.current?.contentWindow)
        return;
      if (!event.data || typeof event.data !== "object") return;
      const message = event.data as Record<string, unknown>;
      if (message.source !== "synara-zen-baseline") return;
      if ("type" in message) {
        if (message.type === "ready") {
          setReady(true);
          setError(null);
        } else if (message.type === "bubble-collapsed") {
          // The product surface owns the control; the review shell only stands in for
          // the native bubble window by hiding the panel and restoring focus to the bubble.
          if (!pendingRef.current) reveal("bubble");
        } else if (message.type === "bubble-hidden") {
          if (!pendingRef.current) reveal("hidden");
        } else if (message.type === "error" && typeof message.message === "string") {
          setReady(false);
          setError(message.message);
          pendingRef.current = null;
          setPendingMode(null);
          focusRef.current = null;
        } else if (message.type === "status" && isCompanionStatus(message.status)) {
          const next = message.status;
          if (statusRef.current && next.revision <= statusRef.current.revision) return;
          statusRef.current = next;
          setStatus(next);
          if (next.phase === "complete" && surfaceRef.current !== "panel") {
            unreadRevisionRef.current = next.revision;
          }
          setUnread(unreadRevisionRef.current !== null);
        } else if (
          message.type === "mode-result" &&
          typeof message.requestId === "number" &&
          Number.isSafeInteger(message.requestId) &&
          message.requestId > 0 &&
          (message.mode === "zen" || message.mode === "workspace")
        ) {
          const pending = pendingRef.current;
          if (!pending || message.requestId !== pending.requestId) return;
          pendingRef.current = null;
          setPendingMode(null);
          if (message.mode === pending.mode && frameRef.current.mode === message.mode) {
            reveal(pending.surface, pending.focusEditor);
          } else {
            setModeNotice("原界面暂未允许切换，已保留当前窗口。");
          }
        }
      } else if (
        (message.mode === "zen" || message.mode === "workspace") &&
        typeof message.expanded === "boolean" &&
        typeof message.isBubble === "boolean" &&
        typeof message.height === "number" &&
        Number.isFinite(message.height) &&
        message.height >= 36 &&
        message.height <= 600
      ) {
        const next: BaselineFrameMessage = {
          source: "synara-zen-baseline",
          mode: message.mode,
          expanded: message.expanded,
          isBubble: message.isBubble,
          height: message.height,
        };
        frameRef.current = next;
        setFrame(next);
        // Native workspace → Zen keeps an open panel open. Geometry/status updates
        // never reveal a collapsed or explicitly hidden companion.
      }
    };
    window.addEventListener("message", receive);
    send({ source: "synara-zen-review", type: "connect", scene: sceneRef.current });
    return () => window.removeEventListener("message", receive);
  }, []);

  const visible = ready && surface === "panel";
  useLayoutEffect(() => {
    const focus = focusRef.current;
    if (focus === "editor" && visible && frame.mode === "zen") {
      focusRef.current = null;
      send({ source: "synara-zen-review", type: "focus-composer" });
    } else if (focus === "bubble" && surface === "bubble" && ready) {
      focusRef.current = null;
      bubble.current?.focus();
    } else if (focus === "restore" && surface === "hidden") {
      focusRef.current = null;
      restore.current?.focus();
    }
  }, [visible, surface, ready, frame.mode, pendingMode]);

  const phase = status?.phase ?? "idle";
  const activityLabel = `${phaseLabels[phase]}${unread ? " · 有未读完成结果" : ""}`;
  const statusName = `${status?.threadTitle ? `${status.threadTitle}：` : ""}${activityLabel}`;
  const bubbleName = error
    ? "协作陪伴预览未能启动"
    : !ready
      ? "正在载入协作陪伴"
      : `打开协作陪伴 · ${statusName}`;
  const badge = phase === "running" ? "…" : phase === "question" ? "?" : "!";
  const showActivityBadge = phase !== "idle" && phase !== "complete";

  return (
    <main className="review-page">
      <nav className="review-toolbar" aria-label="隔离原型评审工具">
        <span className="review-label">协作陪伴原型 · 模拟数据 · 非系统窗口</span>
        <label className="review-scene">
          <span>评审场景</span>
          <select
            aria-label="模拟数据场景"
            value={scene}
            disabled={!ready}
            onChange={(event) => {
              const next = event.target.value as BaselineScene;
              if (!scenes.includes(next)) return;
              sceneRef.current = next;
              setScene(next);
              send({ source: "synara-zen-review", type: "scene", scene: next });
            }}
          >
            {scenes.map((value) => (
              <option key={value} value={value}>
                {sceneLabels[value]}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="outline"
          size="xs"
          disabled={!ready || pendingMode !== null || surface !== "panel"}
          onClick={hide}
        >
          模拟托盘：隐藏陪伴入口
        </Button>
        <Button
          ref={restore}
          variant="outline"
          size="xs"
          disabled={!ready || pendingMode !== null || surface !== "hidden"}
          onClick={() => reveal("bubble")}
        >
          模拟托盘：显示陪伴入口
        </Button>
        {modeNotice ? (
          <span className="review-label" role="status">
            {modeNotice}
          </span>
        ) : null}
      </nav>
      <section className="review-stage" aria-label="Synara 协作陪伴原型">
        <div
          className="companion-window"
          data-mode={frame.mode}
          data-visible={visible}
          style={{ "--companion-height": `${frame.height}px` } as React.CSSProperties}
          inert={!visible}
          aria-hidden={!visible}
        >
          <iframe
            ref={iframe}
            className="review-frame"
            title="Synara 原始禅模式与主窗口（模拟数据）"
            src="./app.html"
            data-mode={frame.mode}
            data-expanded={frame.expanded}
            data-ready={ready}
            tabIndex={visible ? 0 : -1}
            inert={!visible}
            aria-hidden={!visible}
            sandbox="allow-scripts allow-same-origin allow-forms"
            allow="camera 'none'; microphone 'none'; display-capture 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
            onLoad={() =>
              send({ source: "synara-zen-review", type: "connect", scene: sceneRef.current })
            }
          />
        </div>
        {surface === "bubble" ? (
          <div className="companion-entry">
            <ZenModeBubble
              buttonRef={bubble}
              className="companion-bubble"
              disabled={!ready || pendingMode !== null}
              label={bubbleName}
              hideLabel="隐藏陪伴入口"
              onRestore={() => showMode("zen")}
              onHide={hide}
              onError={(cause) => setModeNotice(String(cause))}
            >
              {showActivityBadge ? (
                <span className="companion-badge" data-phase={phase} aria-hidden="true">
                  {badge}
                </span>
              ) : null}
              {unread ? <span className="companion-unread" aria-hidden="true" /> : null}
            </ZenModeBubble>
          </div>
        ) : null}
        {error ? (
          <p className="review-notice review-error" role="alert">
            预览未能启动：{error}
          </p>
        ) : !ready ? (
          <p className="review-notice" role="status">
            正在载入原始界面与模拟数据…
          </p>
        ) : null}
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Preview review root is missing.");
// Use the same production token builder as the real app, without native theme
// calls or a second preference store in this review-only document.
const reviewTheme = buildThemeCssVariables(
  resolveThemePack(DEFAULT_THEME_STATE, "light"),
  "light",
  {
    systemUiFont: DEFAULT_THEME_STATE.systemUiFont,
  },
);
document.documentElement.dataset.themeVariant = "light";
document.documentElement.dataset.windowMaterial = reviewTheme.material;
document.documentElement.dataset.windowTranslucency = reviewTheme.translucencyScope;
for (const [name, value] of Object.entries(reviewTheme.variables)) {
  if (value.trim()) document.documentElement.style.setProperty(name, value);
}
ReactDOM.createRoot(root).render(<ReviewPage />);
