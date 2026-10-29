import {
  type ModelSelection,
  type SkillDefinition,
  type SkillEvolutionGraph,
  type SkillEvolutionGraphNode,
  type SkillEvolutionProposal,
  type SkillEvolutionRequest,
  type SkillEvolutionResponse,
  type SkillEvolutionRun,
  type SkillFileChange,
  type ThreadId,
} from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type WheelEvent,
} from "react";
import { useAppSettings } from "~/appSettings";
import { SkillLibraryDetail } from "~/components/settings/SkillLibraryDetail";
import { useExpertDraftGuard } from "~/components/settings/useExpertDraftGuard";
import { ScratchModelPickers } from "~/components/chat/ScratchAgentControls";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { useScratchComposerDraft } from "~/hooks/useScratchComposerDraft";
import { useScratchModelCatalog } from "~/hooks/useScratchModelCatalog";
import { resolveProviderDiscoveryCwd } from "~/lib/providerDiscovery";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { ensureExpertClient } from "~/workbench/host/expertClient";
import { buildModelSelection } from "~/providerModelOptions";
import {
  isSkillEvolutionRunActive,
  layoutEvolutionGraph,
  skillEvolutionEventLabel,
  skillEvolutionPolicyLabel,
  skillEvolutionProposalStatusLabel,
  skillEvolutionQueryKey,
  skillEvolutionRunPresentation,
  skillEvolutionRunStatusLabel,
  skillEvolutionScopeLabel,
} from "./model";
import {
  CircleAlertIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  MinusIcon,
  PlusIcon,
} from "~/lib/icons";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";

const RUNS_QUERY_SUFFIX = "runs";
const SOURCES_QUERY_SUFFIX = "sources";
const CAPABILITIES_QUERY_KEY = ["server", "skillEvolution", "capabilities"] as const;
const SKILL_LIBRARY_QUERY_KEY = ["server", "skillLibrary", "evolution"] as const;
const EXPERTS_QUERY_KEY = ["server", "experts"] as const;
const ACTIVE_POLL_MS = 2_000;

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function stableOperationId(
  kind: "apply" | "restore" | "bind-restore",
  parts: ReadonlyArray<string>,
) {
  const bytes = new TextEncoder().encode(parts.join("\u0000"));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `skill-evolution-${kind}-${hex}`;
}

function sourceKey(source: { threadId: string; turnId: string }) {
  return `${source.threadId}:${source.turnId}`;
}

function decodeUtf8Base64(value: string): string | null {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

type SkillFileComparisonBase = Pick<
  SkillEvolutionProposal,
  "baseSkillId" | "baseRevision" | "basePackageId"
>;

function ProposalFileChange({
  proposal,
  change,
  index = 0,
  editing = false,
  onChange,
  onRemove,
  onExecutableChange,
  baseVersionLabel,
  targetVersionLabel = "候选版本",
  compareButtonLabel = "查看完整基础版本与候选内容",
}: {
  proposal: SkillFileComparisonBase;
  change: SkillFileChange;
  index?: number;
  editing?: boolean;
  onChange?: (index: number, content: string) => void;
  onRemove?: (index: number) => void;
  onExecutableChange?: (index: number, executable: boolean) => void;
  baseVersionLabel?: string;
  targetVersionLabel?: string;
  compareButtonLabel?: string;
}) {
  const [showBase, setShowBase] = useState(false);
  const basePackage = useQuery({
    queryKey: ["server", "skillPackages", "evolutionDiff", proposal.basePackageId],
    queryFn: () => ensureExpertClient().readSkillPackage({ packageId: proposal.basePackageId! }),
    enabled: showBase && Boolean(proposal.basePackageId),
    staleTime: 30_000,
  });
  const basePathExists = basePackage.data?.resources.some(
    (resource) => resource.kind === "file" && resource.path === "content/" + change.path,
  );
  const baseFile = useQuery({
    queryKey: [
      "server",
      "skillEvolution",
      "baseFile",
      proposal.baseSkillId,
      proposal.baseRevision,
      change.path,
    ],
    queryFn: () =>
      ensureExpertClient().skillLibrary({
        action: "readFile",
        skillId: proposal.baseSkillId!,
        path: change.path,
        ...(proposal.baseRevision === undefined ? {} : { expectedRevision: proposal.baseRevision }),
      }),
    enabled:
      showBase && basePathExists === true && Boolean(proposal.baseSkillId && proposal.baseRevision),
    staleTime: 30_000,
  });
  const candidateText = change.content === undefined ? null : decodeUtf8Base64(change.content);
  const baseText =
    baseFile.data?.file?.text ??
    (baseFile.data?.file ? decodeUtf8Base64(baseFile.data.file.content) : null);

  return (
    <li className="min-w-0 rounded-lg border border-border bg-muted/20">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-3 py-2">
        <code className="min-w-0 break-all text-ui-xs">{change.path}</code>
        <span className="text-ui-xs text-muted-foreground">
          {change.content === undefined ? "删除" : "新增或更新完整文件"}
        </span>
      </div>
      {editing ? (
        change.content === undefined ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2 text-ui-sm">
            <span>此路径会从候选中删除。</span>
            <Button size="sm" variant="ghost" onClick={() => onRemove?.(index)}>
              取消删除
            </Button>
          </div>
        ) : candidateText === null ? (
          <p className="border-t border-border px-3 py-2 text-ui-xs text-muted-foreground">
            该资源不是 UTF-8 文本；保留原候选字节，可从候选中移除此项。
            <Button size="sm" variant="ghost" onClick={() => onRemove?.(index)}>
              移除更改
            </Button>
          </p>
        ) : (
          <Textarea
            aria-label={`候选文件 ${change.path}`}
            value={candidateText}
            rows={Math.min(18, Math.max(5, candidateText.split("\n").length))}
            className="rounded-none border-0 border-t border-border font-mono text-ui-xs"
            onChange={(event) => onChange?.(index, encodeUtf8Base64(event.target.value))}
          />
        )
      ) : change.content === undefined ? (
        <p className="border-t border-border px-3 py-2 text-ui-xs text-muted-foreground">
          该文件会被删除。
        </p>
      ) : candidateText === null ? (
        <p className="border-t border-border px-3 py-2 text-ui-xs text-muted-foreground">
          二进制文件；候选包含完整文件字节。
        </p>
      ) : (
        <pre className="max-h-64 min-w-0 overflow-auto border-t border-border px-3 py-2 text-ui-xs">
          <code>{candidateText}</code>
        </pre>
      )}
      {editing && change.content !== undefined ? (
        <label className="flex items-center gap-2 border-t border-border px-3 py-2 text-ui-xs">
          <Checkbox
            aria-label={`设置可执行权限：${change.path}`}
            checked={change.executable === true}
            onCheckedChange={(value) => onExecutableChange?.(index, value === true)}
          />
          设置为可执行文件
        </label>
      ) : null}
      <div className="border-t border-border px-3 py-2">
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={showBase}
          onClick={() => setShowBase((value) => !value)}
        >
          {showBase ? "收起完整对照" : compareButtonLabel}
        </Button>
      </div>
      {showBase ? (
        <div className="grid min-w-0 gap-2 border-t border-border p-3 lg:grid-cols-2">
          <section className="min-w-0 space-y-1">
            <h5 className="text-ui-xs font-medium">
              {baseVersionLabel ?? `基础版本 r${proposal.baseRevision ?? "未知"}`}
            </h5>
            {!proposal.baseSkillId || !proposal.basePackageId ? (
              <p className="text-ui-xs text-muted-foreground">此候选没有目标 Skill 基础文件。</p>
            ) : basePackage.isPending ? (
              <p className="text-ui-xs text-muted-foreground" role="status">
                正在读取基础文件清单…
              </p>
            ) : basePackage.isError ? (
              <p className="text-ui-xs text-destructive" role="alert">
                基础文件清单不可读：{errorText(basePackage.error)}
              </p>
            ) : !basePathExists ? (
              <p className="text-ui-xs text-muted-foreground">新增路径：基础版本中没有此文件。</p>
            ) : baseFile.isPending ? (
              <p className="text-ui-xs text-muted-foreground" role="status">
                正在读取基础文件…
              </p>
            ) : baseFile.isError ? (
              <p className="text-ui-xs text-destructive" role="alert">
                基础版本不可读：{errorText(baseFile.error)}
              </p>
            ) : baseText === null ? (
              <p className="text-ui-xs text-muted-foreground">
                {basePathExists
                  ? "当前版本是二进制文件，无法按 UTF-8 文本显示。"
                  : "新增路径：基础版本中没有此文件。"}
              </p>
            ) : (
              <pre className="max-h-80 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-ui-xs">
                <code>{baseText}</code>
              </pre>
            )}
          </section>
          <section className="min-w-0 space-y-1">
            <h5 className="text-ui-xs font-medium">{targetVersionLabel}</h5>
            {change.content === undefined ? (
              <p className="text-ui-xs text-destructive">该路径将在目标版本中删除。</p>
            ) : candidateText === null ? (
              <p className="text-ui-xs text-muted-foreground">
                目标版本是二进制文件，完整字节会随更改保存。
              </p>
            ) : (
              <pre className="max-h-80 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-ui-xs">
                <code>{candidateText}</code>
              </pre>
            )}
          </section>
        </div>
      ) : null}
    </li>
  );
}

function EvolutionGraphView({
  expertId,
  active,
  graph,
  currentGraph,
  loading,
  selectedSkillId,
  onSelectSkill,
}: {
  readonly expertId: string;
  readonly active: boolean;
  graph: SkillEvolutionGraph | undefined;
  currentGraph: SkillEvolutionGraph | undefined;
  loading: boolean;
  selectedSkillId: string | null;
  onSelectSkill: (node: SkillEvolutionGraphNode) => void;
}) {
  const [timelineIndex, setTimelineIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    panX: number;
    panY: number;
  } | null>(null);
  const events = currentGraph?.events ?? graph?.events ?? [];
  const currentIndex = Math.max(0, events.length);
  const selectedIndex = timelineIndex ?? currentIndex;
  const selectedEvent = selectedIndex < events.length ? events[selectedIndex] : undefined;
  const historical = useQuery({
    queryKey: [...skillEvolutionQueryKey(expertId), "graphAt", selectedEvent?.createdAt],
    queryFn: () =>
      ensureExpertClient().skillEvolution({
        action: "graph",
        expertId,
        at: selectedEvent?.createdAt,
      }),
    enabled: active && Boolean(currentGraph && selectedEvent),
  });
  const displayedGraph = selectedEvent
    ? (historical.data?.graph ?? graph ?? currentGraph)
    : (currentGraph ?? graph);
  const positions = useMemo(
    () => (displayedGraph ? layoutEvolutionGraph(displayedGraph) : []),
    [displayedGraph],
  );
  const positionById = new Map(positions.map((position) => [position.node.skillId, position]));
  useEffect(() => {
    if (!active) {
      setPlaying(false);
      return;
    }
    if (!playing || events.length < 2) return;
    const timer = window.setInterval(() => {
      setTimelineIndex((current) => {
        const next = (current ?? currentIndex) + 1;
        if (next >= events.length) {
          setPlaying(false);
          return events.length;
        }
        return next;
      });
    }, 1_800);
    return () => window.clearInterval(timer);
  }, [active, currentIndex, events.length, playing]);

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };
  const beginPan = (event: PointerEvent<SVGSVGElement>) => {
    if ((event.target as Element).closest("[data-skill-node]")) return;
    drag.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const movePan = (event: PointerEvent<SVGSVGElement>) => {
    const activeDrag = drag.current;
    if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
    setPan({
      x: activeDrag.panX + event.clientX - activeDrag.x,
      y: activeDrag.panY + event.clientY - activeDrag.y,
    });
  };
  const finishPan = (event: PointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onWheel = (event: WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    setZoom((current) => Math.max(0.65, Math.min(2.5, current * (event.deltaY < 0 ? 1.12 : 0.89))));
  };

  return (
    <section className="min-w-0 space-y-3" aria-labelledby="expert-evolution-chart-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 id="expert-evolution-chart-heading" className="text-ui-lg font-medium">
            Skill 进化星图
          </h2>
          <p className="text-ui-sm text-muted-foreground">
            每个 Skill 保持一个节点；圆环表示记录时间，未记录基线时间的节点留在内环。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            aria-label="缩小星图"
            onClick={() => setZoom((value) => Math.max(0.65, value * 0.85))}
          >
            <MinusIcon aria-hidden="true" className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-label="放大星图"
            onClick={() => setZoom((value) => Math.min(2.5, value * 1.18))}
          >
            <PlusIcon aria-hidden="true" className="size-4" />
          </Button>
          <Button size="sm" variant="ghost" onClick={resetView}>
            重置视图
          </Button>
        </div>
      </div>
      <div className="relative h-[min(28rem,55vh)] min-h-64 min-w-0 overflow-hidden rounded-xl border border-border bg-background">
        {loading ? (
          <p
            className="flex h-full items-center justify-center gap-2 text-ui-sm text-muted-foreground"
            role="status"
          >
            <LoaderCircleIcon
              aria-hidden="true"
              className="size-4 animate-spin motion-reduce:animate-none"
            />
            正在读取进化记录…
          </p>
        ) : !displayedGraph?.nodes.length ? (
          <p className="flex h-full items-center justify-center px-4 text-center text-ui-sm text-muted-foreground">
            尚无已记录的 Skill 基线或采用事件。候选、拒绝和失败记录不会生成能力节点。
          </p>
        ) : (
          <svg
            className="h-full w-full touch-none"
            viewBox="-360 -260 720 520"
            aria-label="Expert Skill 时间环星图"
            role="group"
            onPointerDown={beginPan}
            onPointerMove={movePan}
            onPointerUp={finishPan}
            onPointerCancel={finishPan}
            onWheel={onWheel}
          >
            <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
              {[62, 122, 204, 286].map((radius) => (
                <circle
                  key={radius}
                  cx="0"
                  cy="0"
                  r={radius}
                  fill="none"
                  stroke="currentColor"
                  strokeOpacity="0.12"
                  strokeDasharray={radius === 62 ? "2 5" : undefined}
                />
              ))}
              <text x="0" y="6" textAnchor="middle" className="fill-muted-foreground text-ui-xs">
                Skill
              </text>
              {positions.flatMap(({ node, x, y }) => {
                if (!node.derivedFromSkillId) return [];
                const parent = positionById.get(node.derivedFromSkillId);
                if (!parent) return [];
                return [
                  <path
                    key={`${node.skillId}:derived`}
                    d={`M ${parent.x} ${parent.y} L ${x} ${y}`}
                    fill="none"
                    stroke="currentColor"
                    strokeOpacity="0.42"
                    strokeWidth="1.4"
                    markerEnd="url(#evolution-arrow)"
                  />,
                ];
              })}
              <defs>
                <marker
                  id="evolution-arrow"
                  markerWidth="8"
                  markerHeight="8"
                  refX="7"
                  refY="3"
                  orient="auto"
                  markerUnits="strokeWidth"
                >
                  <path d="M0,0 L0,6 L8,3 z" fill="currentColor" fillOpacity="0.55" />
                </marker>
              </defs>
              {positions.map(({ node, x, y }) => (
                <g
                  key={node.skillId}
                  data-skill-node
                  role="button"
                  tabIndex={0}
                  aria-label={`${node.name}，版本 ${node.revision}，${skillEvolutionPolicyLabel(node.policy)}${node.timestamp ? `，${new Date(node.timestamp).toLocaleDateString()}` : "，时间未知"}${node.deleted ? "，已删除" : ""}`}
                  className="cursor-pointer outline-none focus-visible:outline-none"
                  onClick={() => onSelectSkill(node)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelectSkill(node);
                    }
                  }}
                >
                  <circle
                    cx={x}
                    cy={y}
                    r="19"
                    fill={
                      node.skillId === selectedSkillId
                        ? "var(--color-accent)"
                        : "var(--color-background)"
                    }
                    stroke={
                      node.policy === "protected"
                        ? "var(--color-border)"
                        : node.policy === "shared"
                          ? "var(--color-primary)"
                          : "var(--color-ring)"
                    }
                    strokeWidth={node.skillId === selectedSkillId ? "3" : "1.5"}
                  />
                  <text x={x} y={y + 4} textAnchor="middle" className="fill-foreground text-ui-xs">
                    v{node.revision}
                  </text>
                  <text x={x} y={y + 32} textAnchor="middle" className="fill-foreground text-ui-xs">
                    {node.name.slice(0, 18)}
                  </text>
                  {node.timestamp === null ? (
                    <text
                      x={x}
                      y={y - 25}
                      textAnchor="middle"
                      className="fill-muted-foreground text-ui-xs"
                    >
                      时间未知
                    </text>
                  ) : null}
                </g>
              ))}
            </g>
          </svg>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2">
        <Button
          size="sm"
          variant="outline"
          disabled={events.length === 0}
          onClick={() => {
            setPlaying((value) => {
              if (value) return false;
              setTimelineIndex((current) =>
                current === null || current >= events.length ? 0 : current,
              );
              return true;
            });
          }}
        >
          {playing ? "暂停播放" : "播放时间线"}
        </Button>
        <label className="flex min-w-40 flex-1 items-center gap-3 text-ui-sm">
          <span className="shrink-0">时间回溯</span>
          <input
            aria-label="进化时间回溯"
            type="range"
            min={0}
            max={events.length}
            value={selectedIndex}
            disabled={events.length === 0}
            className="min-w-0 flex-1 accent-primary"
            onChange={(event) => {
              setPlaying(false);
              const next = Number(event.currentTarget.value);
              setTimelineIndex(next === events.length ? null : next);
            }}
          />
          <span className="max-w-44 truncate text-ui-xs text-muted-foreground">
            {selectedEvent ? new Date(selectedEvent.createdAt).toLocaleString() : "当前"}
          </span>
        </label>
      </div>
    </section>
  );
}

function ProposalCard({
  proposal,
  expertArchived,
  affectedExperts,
  busy,
  onEdit,
  onApply,
  onReject,
  onOpenTask,
}: {
  proposal: SkillEvolutionProposal;
  expertArchived: boolean;
  affectedExperts: ReadonlyArray<string> | null;
  busy: boolean;
  onEdit: (input: {
    proposal: SkillEvolutionProposal;
    name: string;
    changes: SkillFileChange[];
  }) => Promise<void>;
  onApply: (proposal: SkillEvolutionProposal) => Promise<void>;
  onReject: (proposal: SkillEvolutionProposal) => Promise<void>;
  onOpenTask?: (threadId: ThreadId) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(proposal.name);
  const [changes, setChanges] = useState(() => proposal.changes.map((change) => ({ ...change })));
  const [newFilePath, setNewFilePath] = useState("");
  useEffect(() => {
    if (editing) return;
    setName(proposal.name);
    setChanges(proposal.changes.map((change) => ({ ...change })));
  }, [editing, proposal.changes, proposal.name]);
  const statusLabel = skillEvolutionProposalStatusLabel(proposal.status);
  const applyLabel =
    proposal.policy === "protected"
      ? "认可并采用本次改动"
      : proposal.policy === "shared"
        ? "采用到共享版本"
        : proposal.action === "derive"
          ? "创建专用副本并采用"
          : "更新专用版本";
  const missingSharedImpactSnapshot =
    proposal.policy === "shared" &&
    proposal.action === "update" &&
    proposal.affectedExpertIds === undefined;

  return (
    <article
      className="min-w-0 space-y-3 rounded-xl border border-border p-4"
      aria-label={`Skill 候选：${proposal.name}`}
    >
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          {editing ? (
            <Input
              aria-label="候选 Skill 名称"
              value={name}
              maxLength={200}
              onChange={(event) => setName(event.target.value)}
            />
          ) : (
            <h3 className="break-words text-ui-lg font-medium">{proposal.name}</h3>
          )}
          <p className="break-words text-ui-sm text-muted-foreground">{proposal.summary}</p>
        </div>
        <span className="shrink-0 rounded-full border border-border px-2 py-1 text-ui-xs text-muted-foreground">
          {skillEvolutionPolicyLabel(proposal.policy)} · {statusLabel}
        </span>
      </header>

      {proposal.error ? (
        <p className="text-ui-sm text-destructive" role="alert">
          {proposal.error}
        </p>
      ) : null}
      {proposal.policy === "shared" && proposal.baseSkillId ? (
        <p className="rounded-lg bg-muted/50 px-3 py-2 text-ui-sm text-foreground/80">
          共享更新会影响：
          {affectedExperts === null
            ? "此旧候选没有冻结影响名单，当前范围未知；请重新提炼后再采用。"
            : affectedExperts.length
              ? affectedExperts.join("、")
              : "冻结影响名单为空。"}
        </p>
      ) : null}
      {missingSharedImpactSnapshot ? (
        <p className="text-ui-sm text-destructive" role="alert">
          此共享更新候选缺少冻结的影响专家名单，不能采用；请重新提炼。
        </p>
      ) : null}
      {proposal.action === "derive" ? (
        <p className="rounded-lg bg-muted/50 px-3 py-2 text-ui-sm text-foreground/80">
          将基于来源 Skill 创建当前专家专用副本；来源内容和其他专家绑定保持原样。
        </p>
      ) : null}

      <section className="space-y-2" aria-label="候选文件差异">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-ui-sm font-medium">文件差异（{changes.length} 项）</h4>
          {editing ? (
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-none">
              <Input
                aria-label="新候选文件路径"
                value={newFilePath}
                maxLength={4_096}
                placeholder="添加文件路径"
                className="min-w-40 flex-1 sm:max-w-72"
                onChange={(event) => setNewFilePath(event.target.value)}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={
                  !newFilePath.trim() ||
                  changes.some((change) => change.path === newFilePath.trim())
                }
                onClick={() => {
                  const path = newFilePath.trim();
                  if (!path || changes.some((change) => change.path === path)) return;
                  setChanges((current) => [...current, { path, content: encodeUtf8Base64("") }]);
                  setNewFilePath("");
                }}
              >
                添加文件
              </Button>
            </div>
          ) : null}
        </div>
        {changes.length ? (
          <ul className="space-y-2">
            {changes.map((change, index) => (
              <ProposalFileChange
                key={`${change.path}:${index}`}
                proposal={proposal}
                change={change}
                index={index}
                editing={editing}
                onChange={(fileIndex, content) =>
                  setChanges((current) =>
                    current.map((item, i) => (i === fileIndex ? { ...item, content } : item)),
                  )
                }
                onExecutableChange={(fileIndex, executable) =>
                  setChanges((current) =>
                    current.map((item, i) => (i === fileIndex ? { ...item, executable } : item)),
                  )
                }
                onRemove={(fileIndex) =>
                  setChanges((current) => current.filter((_, i) => i !== fileIndex))
                }
              />
            ))}
          </ul>
        ) : (
          <p className="text-ui-sm text-muted-foreground">
            当前编辑草稿没有文件改动；保存后将由服务端重新校验。
          </p>
        )}
      </section>

      <section className="space-y-2" aria-label="提炼依据">
        <h4 className="text-ui-sm font-medium">提炼依据</h4>
        {proposal.evidence.length ? (
          <ul className="space-y-2">
            {proposal.evidence.map((evidence) => (
              <li
                key={`${evidence.threadId}:${evidence.messageId}`}
                className="rounded-lg bg-muted/50 p-3 text-ui-sm"
              >
                <blockquote className="whitespace-pre-wrap break-words">
                  {evidence.quote}
                </blockquote>
                {onOpenTask ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onOpenTask(evidence.threadId as ThreadId)}
                  >
                    打开来源任务 <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ui-sm text-muted-foreground">没有返回可展示的证据引用。</p>
        )}
      </section>

      <footer className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        {proposal.status === "proposed" && !expertArchived ? (
          editing ? (
            <>
              <Button
                size="sm"
                disabled={busy || !name.trim()}
                onClick={() =>
                  void onEdit({ proposal, name: name.trim(), changes }).then(() =>
                    setEditing(false),
                  )
                }
              >
                保存候选编辑
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setName(proposal.name);
                  setChanges(proposal.changes.map((change) => ({ ...change })));
                  setEditing(false);
                }}
              >
                放弃编辑
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(true)}>
                编辑候选
              </Button>
              <Button
                size="sm"
                disabled={busy || missingSharedImpactSnapshot}
                onClick={() => void onApply(proposal)}
              >
                {applyLabel}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void onReject(proposal)}
              >
                拒绝
              </Button>
            </>
          )
        ) : proposal.status === "saved_unbound" && !expertArchived ? (
          <Button
            size="sm"
            disabled={busy || missingSharedImpactSnapshot}
            onClick={() => void onApply(proposal)}
          >
            继续完成绑定
          </Button>
        ) : proposal.status === "conflict" ? (
          <p className="text-ui-sm text-destructive" role="status">
            目标版本或绑定已变化；候选已保留，请基于最新配置重新提炼。
          </p>
        ) : proposal.status === "applied" ? (
          <p className="text-ui-sm text-emerald-700 dark:text-emerald-300" role="status">
            已采用 {proposal.resultSkillId ? `· ${proposal.resultSkillId}` : ""}
            {proposal.resultRevision ? ` · v${proposal.resultRevision}` : ""}
          </p>
        ) : proposal.status === "rejected" ? (
          <p className="text-ui-sm text-muted-foreground" role="status">
            已拒绝，此候选不会写入正式 Skill。
          </p>
        ) : proposal.status === "applying" ? (
          <p className="flex items-center gap-2 text-ui-sm text-muted-foreground" role="status">
            <LoaderCircleIcon
              aria-hidden="true"
              className="size-4 animate-spin motion-reduce:animate-none"
            />
            正在核对并采用…
          </p>
        ) : null}
      </footer>
    </article>
  );
}

export function ExpertSkillEvolution({
  expertId,
  expertName,
  expertArchived = false,
  active,
  initialThreadId,
  initialThreadRequestKey,
  onOpenTask,
}: {
  readonly expertId: string;
  readonly expertName: string;
  readonly expertArchived?: boolean;
  readonly active: boolean;
  readonly initialThreadId?: string | null;
  readonly initialThreadRequestKey?: number;
  readonly onOpenTask?: (threadId: ThreadId) => void;
}) {
  const queryClient = useQueryClient();
  const { settings } = useAppSettings();
  const providerStatuses = useProviderStatusesForLocalConfig();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const draft = useScratchComposerDraft({ defaultProvider: settings.defaultProvider, settings });
  const catalog = useScratchModelCatalog({
    draft,
    providerStatuses,
    discoveryCwd: resolveProviderDiscoveryCwd({
      activeThreadWorktreePath: null,
      activeProjectCwd: null,
      serverCwd: serverConfigQuery.data?.cwd ?? null,
    }),
  });
  const modelSelection = useMemo<ModelSelection>(
    () =>
      buildModelSelection(
        draft.selectedProvider,
        draft.selectedModel ?? "",
        draft.selectedProviderModelOptions,
        draft.selectedModelSupportsAutoMode,
        { instanceId: draft.selectedProviderInstanceId },
      ),
    [
      draft.selectedModel,
      draft.selectedModelSupportsAutoMode,
      draft.selectedProvider,
      draft.selectedProviderInstanceId,
      draft.selectedProviderModelOptions,
    ],
  );
  const runKey = [...skillEvolutionQueryKey(expertId), RUNS_QUERY_SUFFIX] as const;
  const sourcesQuery = useQuery({
    queryKey: [...skillEvolutionQueryKey(expertId), SOURCES_QUERY_SUFFIX],
    queryFn: () => ensureExpertClient().skillEvolution({ action: "sources", expertId }),
    enabled: active,
    staleTime: 5_000,
  });
  const capabilitiesQuery = useQuery({
    queryKey: CAPABILITIES_QUERY_KEY,
    queryFn: () => ensureExpertClient().skillEvolution({ action: "capabilities" }),
    enabled: active,
    staleTime: 30_000,
  });
  const runsQuery = useQuery({
    queryKey: runKey,
    queryFn: () => ensureExpertClient().skillEvolution({ action: "list", expertId }),
    enabled: active,
    refetchInterval: (query) => {
      const runs = query.state.data?.runs ?? [];
      return active && runs.some(isSkillEvolutionRunActive) ? ACTIVE_POLL_MS : false;
    },
  });
  const skillsQuery = useQuery({
    queryKey: [...SKILL_LIBRARY_QUERY_KEY, "all"],
    queryFn: () => ensureExpertClient().skillLibrary({ action: "list" }),
    enabled: active,
    staleTime: 15_000,
  });
  const expertsQuery = useQuery({
    queryKey: EXPERTS_QUERY_KEY,
    queryFn: () => ensureExpertClient().listExperts(),
    enabled: active,
    staleTime: 15_000,
  });
  const currentGraphQuery = useQuery({
    queryKey: [...skillEvolutionQueryKey(expertId), "graph", "current"],
    queryFn: () => ensureExpertClient().skillEvolution({ action: "graph", expertId }),
    enabled: active,
    staleTime: 5_000,
  });
  const [selectedSources, setSelectedSources] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [focus, setFocus] = useState("");
  const [targetSkillId, setTargetSkillId] = useState("");
  const [protectedAction, setProtectedAction] = useState<"update" | "derive">("update");
  const [selectedSkillNode, setSelectedSkillNode] = useState<SkillEvolutionGraphNode | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const currentGraph = currentGraphQuery.data?.graph;
  const selectedCurrentNode = selectedSkillId
    ? (currentGraph?.nodes.find((node) => node.skillId === selectedSkillId) ?? null)
    : null;
  const selectedSkillDeleted = Boolean(selectedCurrentNode?.deleted ?? selectedSkillNode?.deleted);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [skillDetail, setSkillDetail] = useState<SkillDefinition | null>(null);
  const [deleteSkill, setDeleteSkill] = useState<SkillDefinition | null>(null);
  const initialThreadSeen = useRef<number | null>(null);
  const sources = sourcesQuery.data?.sources ?? [];
  const runs = runsQuery.data?.runs ?? [];
  const selectedRunIdFromList = selectedRunId ?? runs[0]?.requestId ?? null;
  const selectedRunQuery = useQuery({
    queryKey: [...skillEvolutionQueryKey(expertId), "run", selectedRunIdFromList],
    queryFn: () =>
      ensureExpertClient().skillEvolution({ action: "read", requestId: selectedRunIdFromList! }),
    enabled: active && Boolean(selectedRunIdFromList),
    refetchInterval: (query) => {
      const run = query.state.data?.run;
      return active && isSkillEvolutionRunActive(run) ? ACTIVE_POLL_MS : false;
    },
  });
  const selectedRun =
    selectedRunQuery.data?.run ?? runs.find((run) => run.requestId === selectedRunIdFromList);
  const selectedRunPresentation = selectedRun ? skillEvolutionRunPresentation(selectedRun) : null;
  const selectedEvent = (currentGraphQuery.data?.graph?.events ?? []).find(
    (event) => event.eventId === selectedEventId,
  );
  const sourceRunQuery = useQuery({
    queryKey: [...skillEvolutionQueryKey(expertId), "sourceRun", selectedEvent?.requestId],
    queryFn: () =>
      ensureExpertClient().skillEvolution({ action: "read", requestId: selectedEvent!.requestId }),
    enabled: active && Boolean(selectedEvent),
    staleTime: 10_000,
  });
  const selectedSkillQuery = useQuery({
    queryKey: [...SKILL_LIBRARY_QUERY_KEY, "skill", selectedSkillId],
    queryFn: async () => {
      const response = await ensureExpertClient().skillLibrary({
        action: "read",
        skillId: selectedSkillId! as SkillDefinition["skillId"],
      });
      if (!response.skill) throw new Error("未能读取 Skill 详情。");
      return response.skill;
    },
    enabled: active && Boolean(selectedSkillId) && !selectedSkillDeleted,
    staleTime: 5_000,
  });
  const restorePreviewMutation = useMutation({
    mutationFn: (eventId: string) =>
      ensureExpertClient().skillEvolution({ action: "previewRestore", eventId, expertId }),
    onSuccess: (result) => {
      if (result.restorePreview)
        setNotice(
          `已生成恢复预览：影响 ${result.restorePreview.affectedExpertIds.length} 个专家。`,
        );
      void queryClient.invalidateQueries({
        queryKey: [...skillEvolutionQueryKey(expertId), "restorePreview"],
      });
    },
    onError: (cause) => setError(errorText(cause)),
  });
  const bindingRestorePreviewMutation = useMutation({
    mutationFn: (eventId: string) =>
      ensureExpertClient().skillEvolution({ action: "previewBindingRestore", eventId, expertId }),
    onSuccess: (result) => {
      if (result.bindingRestorePreview)
        setNotice("已生成恢复原绑定预览；专用副本会保留。请核对完整绑定变化后确认。");
    },
    onError: (cause) => setError(errorText(cause)),
  });

  useEffect(() => {
    if (
      !initialThreadId ||
      initialThreadSeen.current === (initialThreadRequestKey ?? 0) ||
      !sources.length
    )
      return;
    initialThreadSeen.current = initialThreadRequestKey ?? 0;
    const source = sources
      .filter((candidate) => candidate.threadId === initialThreadId)
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt))[0];
    if (!source) {
      setNotice("此任务没有可用的已结束提炼来源；可从列表选择其他记录。");
      return;
    }
    setSelectedSources((current) => {
      if (current.size >= 5 || current.has(sourceKey(source))) return current;
      return new Set([...current, sourceKey(source)]);
    });
  }, [initialThreadId, initialThreadRequestKey, sources]);

  useEffect(() => {
    if (!selectedRunId && runs[0]) setSelectedRunId(runs[0].requestId);
  }, [runs, selectedRunId]);

  const currentProviderCapability = (capabilitiesQuery.data?.capabilities ?? []).find(
    (capability) => capability.provider === draft.selectedProvider,
  );
  const currentExpertSkillIds = new Set(
    (expertsQuery.data?.find((expert) => expert.id === expertId)?.skillBindings ?? []).map(
      (binding) => binding.skillId,
    ),
  );
  const availableSkills = (skillsQuery.data?.skills ?? []).filter((skill) => {
    const scope = skill.scope;
    return (
      currentExpertSkillIds.has(skill.skillId) &&
      !skill.deleted &&
      (!scope || scope.kind === "shared" || scope.expertId === expertId)
    );
  });
  const selectedTargetSkill = availableSkills.find((skill) => skill.skillId === targetSkillId);
  const expertNameById = new Map(
    (expertsQuery.data ?? []).map((expert) => [expert.id, expert.name]),
  );
  const capabilityFailure = !currentProviderCapability
    ? capabilitiesQuery.isPending
      ? "正在确认当前 Provider 的提炼约束。"
      : "当前 Provider 没有返回可验证的提炼能力，暂不可用。"
    : !currentProviderCapability.supported
      ? currentProviderCapability.reason || "当前 Provider 暂不支持受约束的 Skill 提炼。"
      : null;

  const updateRun = useCallback(
    (next: SkillEvolutionRun | undefined) => {
      if (next) {
        queryClient.setQueryData<SkillEvolutionResponse>(runKey, (current) => ({
          ...(current ?? {}),
          runs: [next, ...(current?.runs ?? []).filter((run) => run.requestId !== next.requestId)],
        }));
        queryClient.setQueryData([...skillEvolutionQueryKey(expertId), "run", next.requestId], {
          run: next,
        });
        setSelectedRunId(next.requestId);
      }
    },
    [expertId, queryClient, runKey, runsQuery.data],
  );

  const startMutation = useMutation({
    mutationFn: (request: Extract<SkillEvolutionRequest, { action: "start" }>) =>
      ensureExpertClient().skillEvolution(request),
    onSuccess: (result) => {
      updateRun(result.run);
      setNotice("已提交 Skill 提炼任务。状态会在任务运行期间同步；关闭此页不会取消任务。");
      setSelectedSources(new Set());
      setFocus("");
      setTargetSkillId("");
      setProtectedAction("update");
      void queryClient.invalidateQueries({ queryKey: runKey });
    },
    onError: (cause) => setError(errorText(cause)),
  });

  const formDraftDirty =
    selectedSources.size > 0 ||
    focus.trim().length > 0 ||
    targetSkillId.length > 0 ||
    protectedAction !== "update";
  const draftGuard = useExpertDraftGuard({
    isDirty: formDraftDirty && !startMutation.isPending,
    shouldGuardNavigation: ({ currentPathname, nextPathname, currentSearch, nextSearch }) =>
      currentPathname !== nextPathname ||
      currentSearch.kind !== nextSearch.kind ||
      currentSearch.expertId !== nextSearch.expertId,
    canSave: false,
    saveDisabledReason: "来源选择和提炼重点不会自动提交；可留在本页开始提炼，或明确放弃草稿。",
    onSave: async () => false,
    onDiscard: () => {
      setSelectedSources(new Set());
      setFocus("");
      setTargetSkillId("");
      setProtectedAction("update");
    },
  });

  const runRequest = async (request: SkillEvolutionRequest) => {
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      const response = await ensureExpertClient().skillEvolution(request);
      updateRun(response.run);
      if (response.run) {
        setNotice(`操作结果：${skillEvolutionRunPresentation(response.run).label}。`);
      } else if (response.skill) {
        setNotice(`Skill 已保存为 v${response.skill.revision}。`);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: runKey }),
        queryClient.invalidateQueries({ queryKey: EXPERTS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: [...skillEvolutionQueryKey(expertId), "graph"] }),
        queryClient.invalidateQueries({
          queryKey: [...skillEvolutionQueryKey(expertId), "graph", "current"],
        }),
        queryClient.invalidateQueries({ queryKey: SKILL_LIBRARY_QUERY_KEY }),
      ]);
      return response;
    } catch (cause) {
      setError(errorText(cause));
      throw cause;
    } finally {
      setWorking(false);
    }
  };

  const start = () => {
    const selected = sources.filter((source) => selectedSources.has(sourceKey(source)));
    if (!selected.length || selected.length > 5 || capabilityFailure || expertArchived) return;
    setError(null);
    setNotice(null);
    startMutation.mutate({
      action: "start",
      requestId: globalThis.crypto.randomUUID(),
      expertId,
      sources: selected.map(({ threadId, turnId }) => ({ threadId, turnId })),
      ...(selectedTargetSkill ? { targetSkillId: selectedTargetSkill.skillId } : {}),
      ...(selectedTargetSkill &&
      (selectedTargetSkill.evolutionPolicy ?? "protected") === "protected"
        ? { protectedAction }
        : {}),
      ...(focus.trim() ? { focus: focus.trim() } : {}),
      modelSelection,
    });
  };

  const performProposalEdit = async (input: {
    proposal: SkillEvolutionProposal;
    name: string;
    changes: SkillFileChange[];
  }) => {
    await runRequest({
      action: "edit",
      requestId: input.proposal.requestId,
      proposalId: input.proposal.proposalId,
      expectedDigest: input.proposal.digest,
      name: input.name,
      changes: input.changes,
    });
  };
  const performApply = async (proposal: SkillEvolutionProposal) => {
    if (
      proposal.policy === "shared" &&
      proposal.action === "update" &&
      proposal.affectedExpertIds === undefined
    ) {
      setError("此共享更新候选缺少冻结的影响专家名单，不能采用；请重新提炼。");
      return;
    }
    const operationId = await stableOperationId("apply", [
      proposal.requestId,
      proposal.proposalId,
      proposal.digest,
    ]);
    await runRequest({
      action: "apply",
      requestId: proposal.requestId,
      proposalId: proposal.proposalId,
      expectedDigest: proposal.digest,
      operationId,
      ...(proposal.policy === "protected" ? { approveProtected: true } : {}),
    });
  };
  const performReject = async (proposal: SkillEvolutionProposal) => {
    await runRequest({
      action: "reject",
      requestId: proposal.requestId,
      proposalId: proposal.proposalId,
      expectedDigest: proposal.digest,
    });
  };
  const cancelRun = async (run: SkillEvolutionRun) => {
    await runRequest({ action: "cancel", requestId: run.requestId });
  };

  const graphQuery = useQuery({
    queryKey: [
      ...skillEvolutionQueryKey(expertId),
      "graph",
      selectedEventId ? "at" : "current",
      selectedEvent?.createdAt,
    ],
    queryFn: () =>
      ensureExpertClient().skillEvolution({
        action: "graph",
        expertId,
        ...(selectedEvent ? { at: selectedEvent.createdAt } : {}),
      }),
    enabled: active,
    staleTime: 5_000,
  });
  const graph = graphQuery.data?.graph;
  const selectedNode =
    selectedCurrentNode ??
    selectedSkillNode ??
    (selectedSkillId
      ? (currentGraph?.nodes.find((node) => node.skillId === selectedSkillId) ?? null)
      : null);
  const impactedExperts = (proposal: SkillEvolutionProposal) => {
    if (proposal.affectedExpertIds === undefined) return null;
    return proposal.affectedExpertIds.map((id) => expertNameById.get(id) ?? id);
  };
  const applyRestore = async () => {
    const preview = restorePreviewMutation.data?.restorePreview;
    if (!preview || preview.eventId !== selectedEvent?.eventId) return;
    const currentNode = currentGraph?.nodes.find((node) => node.skillId === preview.skill.skillId);
    if (!currentNode) {
      setError("当前图中缺少恢复目标，无法安全校验版本。");
      return;
    }
    const operationId = await stableOperationId("restore", [
      expertId,
      preview.eventId,
      String(preview.skill.revision),
    ]);
    await runRequest({
      action: "restore",
      eventId: preview.eventId,
      expertId,
      operationId,
      expectedRevision: preview.skill.revision,
      expectedAffectedExpertIds: preview.affectedExpertIds,
      ...((preview.skill.evolutionPolicy ?? "protected") === "protected"
        ? { approveProtected: true }
        : {}),
    });
    restorePreviewMutation.reset();
  };
  const applyBindingRestore = async () => {
    const preview = bindingRestorePreviewMutation.data?.bindingRestorePreview;
    if (!preview || preview.eventId !== selectedEvent?.eventId || preview.expertId !== expertId)
      return;
    const operationId = await stableOperationId("bind-restore", [
      preview.expertId,
      preview.eventId,
      preview.digest,
    ]);
    await runRequest({
      action: "restoreBinding",
      expertId: preview.expertId,
      eventId: preview.eventId,
      operationId,
      expectedDigest: preview.digest,
    });
    bindingRestorePreviewMutation.reset();
    setNotice("已恢复本专家到来源 Skill 的原绑定；专用副本保留，内容未恢复。");
  };
  const bindingSkillName = (skillId: string) => {
    const names = [
      ...(skillsQuery.data?.skills ?? []).map((skill) => [skill.skillId, skill.name] as const),
      ...(currentGraph?.nodes ?? []).map((node) => [node.skillId, node.name] as const),
      ...(graph?.nodes ?? []).map((node) => [node.skillId, node.name] as const),
    ];
    return names.find(([id]) => id === skillId)?.[1] ?? skillId;
  };
  const contentRestorePreview = restorePreviewMutation.data?.restorePreview;
  const bindingRestorePreview = bindingRestorePreviewMutation.data?.bindingRestorePreview;
  const selectedContentRestorePreview =
    contentRestorePreview?.eventId === selectedEvent?.eventId && contentRestorePreview
      ? contentRestorePreview
      : undefined;
  const selectedBindingRestorePreview =
    bindingRestorePreview?.eventId === selectedEvent?.eventId &&
    bindingRestorePreview?.expertId === expertId
      ? bindingRestorePreview
      : undefined;

  return (
    <div className="min-w-0 space-y-5" aria-label={`${expertName} Skill 进化`}>
      <section className="min-w-0 space-y-4 rounded-xl border border-border bg-background p-4">
        <header className="space-y-1">
          <h2 className="text-ui-lg font-medium">主动提炼 Skill</h2>
          <p className="text-ui-sm text-muted-foreground">
            只读取你选定的已结束任务。候选、拒绝和“无需提炼”不会直接改变正式 Skill。
          </p>
        </header>
        {expertArchived ? (
          <p className="rounded-lg bg-muted/50 p-3 text-ui-sm text-muted-foreground" role="status">
            专家已归档。历史进化记录可查看，但不能发起、采用或恢复。
          </p>
        ) : (
          <>
            <fieldset className="min-w-0 space-y-2" disabled={startMutation.isPending}>
              <legend className="text-ui-sm font-medium">选择 1–5 条已结束工作记录</legend>
              {sourcesQuery.isPending ? (
                <p className="text-ui-sm text-muted-foreground" role="status">
                  正在读取可用来源…
                </p>
              ) : sourcesQuery.isError ? (
                <p className="text-ui-sm text-destructive" role="alert">
                  无法读取来源：{errorText(sourcesQuery.error)}
                </p>
              ) : sources.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border p-3 text-ui-sm text-muted-foreground">
                  没有可用的已结束 Expert
                  工作片段。运行中的任务、无法确认归属的材料和提炼任务不会作为来源。
                </p>
              ) : (
                <ul className="max-h-72 min-w-0 space-y-2 overflow-y-auto pr-1">
                  {sources.map((source) => {
                    const key = sourceKey(source);
                    const checked = selectedSources.has(key);
                    const disabled = !checked && selectedSources.size >= 5;
                    return (
                      <li key={key} className="min-w-0 rounded-lg border border-border p-3">
                        <label className="flex min-w-0 cursor-pointer items-start gap-3">
                          <Checkbox
                            aria-label={`选择来源：${source.title || "未命名任务"}`}
                            checked={checked}
                            disabled={disabled}
                            onCheckedChange={(value) =>
                              setSelectedSources((current) => {
                                const next = new Set(current);
                                if (value === true) next.add(key);
                                else next.delete(key);
                                return next;
                              })
                            }
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block break-words text-ui font-medium">
                              {source.title || "未命名任务"}
                            </span>
                            <span className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-ui-xs text-muted-foreground">
                              <span>Expert v{source.expertRevision}</span>
                              <span>{new Date(source.completedAt).toLocaleString()}</span>
                              <span>{source.messageCount} 条消息</span>
                              <span>来源 {source.snapshotId}</span>
                            </span>
                          </span>
                        </label>
                        {onOpenTask ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="ml-7 mt-1"
                            onClick={() => onOpenTask(source.threadId as ThreadId)}
                          >
                            打开任务 <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
                          </Button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </fieldset>

            <div className="grid min-w-0 gap-4 lg:grid-cols-2">
              <div className="grid min-w-0 gap-1.5 text-ui-sm">
                <span className="font-medium">目标 Skill</span>
                <select
                  aria-label="目标 Skill"
                  className="h-9 min-w-0 rounded-md border border-input bg-background px-3 text-ui-sm"
                  value={targetSkillId}
                  disabled={startMutation.isPending || skillsQuery.isPending}
                  onChange={(event) => setTargetSkillId(event.target.value)}
                >
                  <option value="">新建当前专家专用 Skill</option>
                  {availableSkills.map((skill) => (
                    <option key={skill.skillId} value={skill.skillId}>
                      {skill.name} ·{" "}
                      {skillEvolutionPolicyLabel(skill.evolutionPolicy ?? "protected")} ·{" "}
                      {skillEvolutionScopeLabel(skill.scope, expertNameById)}
                    </option>
                  ))}
                </select>
                {skillsQuery.isError ? (
                  <span className="text-ui-xs text-destructive">
                    无法读取目标 Skill：{errorText(skillsQuery.error)}
                  </span>
                ) : null}
                {selectedTargetSkill &&
                (selectedTargetSkill.evolutionPolicy ?? "protected") === "protected" ? (
                  <fieldset className="mt-2 space-y-2 rounded-lg border border-border bg-muted/30 p-3">
                    <legend className="px-1 text-ui-xs font-medium">
                      本次受保护操作（仍需认可准确候选）
                    </legend>
                    <label className="flex items-start gap-2 text-ui-sm">
                      <input
                        type="radio"
                        name="protected-skill-action"
                        value="update"
                        checked={protectedAction === "update"}
                        onChange={() => setProtectedAction("update")}
                      />
                      <span>
                        <strong>修改原版</strong>
                        <span className="block text-ui-xs text-muted-foreground">
                          保持当前 Skill 身份和范围。
                        </span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2 text-ui-sm">
                      <input
                        type="radio"
                        name="protected-skill-action"
                        value="derive"
                        checked={protectedAction === "derive"}
                        onChange={() => setProtectedAction("derive")}
                      />
                      <span>
                        <strong>创建本专家专用副本</strong>
                        <span className="block text-ui-xs text-muted-foreground">
                          保留原版，候选采用后由本专家使用副本。
                        </span>
                      </span>
                    </label>
                  </fieldset>
                ) : null}
              </div>
              <label className="grid min-w-0 gap-1.5 text-ui-sm">
                <span className="font-medium">提炼重点（可选）</span>
                <Textarea
                  aria-label="提炼重点"
                  value={focus}
                  maxLength={8_000}
                  rows={3}
                  placeholder="例如：提取可复用的排查步骤，排除本项目专有信息。"
                  onChange={(event) => setFocus(event.target.value)}
                />
              </label>
            </div>

            <div className="min-w-0 space-y-2 rounded-lg border border-border p-3">
              <div className="space-y-1">
                <p className="text-ui-sm font-medium">本次运行模型</p>
                <p className="text-ui-xs text-muted-foreground">
                  沿用当前用户的 Provider／模型选择；切换只在你通过选择器明确操作后发生。
                </p>
              </div>
              <ScratchModelPickers
                draft={draft}
                catalog={catalog}
                providerStatuses={providerStatuses}
              />
              {capabilityFailure ? (
                <p className="flex items-start gap-2 text-ui-sm text-destructive" role="status">
                  <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span>{capabilityFailure}</span>
                </p>
              ) : currentProviderCapability ? (
                <p className="text-ui-xs text-muted-foreground" role="status">
                  {currentProviderCapability.reason || "当前 Provider 满足提炼能力约束。"}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={
                  selectedSources.size < 1 ||
                  selectedSources.size > 5 ||
                  Boolean(capabilityFailure) ||
                  startMutation.isPending ||
                  !draft.selectedModel ||
                  !draft.selectedModel.trim()
                }
                aria-busy={startMutation.isPending}
                onClick={start}
              >
                {startMutation.isPending ? (
                  <LoaderCircleIcon
                    aria-hidden="true"
                    className="size-4 animate-spin motion-reduce:animate-none"
                  />
                ) : null}
                {startMutation.isPending ? "提交中…" : "开始提炼"}
              </Button>
              {selectedSources.size > 0 ? (
                <span className="text-ui-xs text-muted-foreground">
                  已选 {selectedSources.size} 条
                </span>
              ) : null}
            </div>
          </>
        )}
        {notice ? (
          <p className="rounded-lg border border-border bg-muted/40 p-3 text-ui-sm" role="status">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p
            className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-ui-sm text-destructive"
            role="alert"
          >
            {error}
          </p>
        ) : null}
      </section>

      <section className="min-w-0 space-y-3" aria-labelledby="expert-evolution-history-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="expert-evolution-history-heading" className="text-ui-lg font-medium">
            提炼记录与候选
          </h2>
          {runsQuery.isFetching ? (
            <span className="text-ui-xs text-muted-foreground" role="status">
              同步任务状态…
            </span>
          ) : null}
        </div>
        {runsQuery.isError ? (
          <p role="alert" className="text-ui-sm text-destructive">
            无法读取提炼记录：{errorText(runsQuery.error)}
          </p>
        ) : null}
        {!runs.length && !runsQuery.isPending ? (
          <p className="rounded-lg border border-dashed border-border p-3 text-ui-sm text-muted-foreground">
            还没有提炼请求。
          </p>
        ) : null}
        {runs.length ? (
          <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(12rem,0.32fr)_minmax(0,1fr)]">
            <nav className="min-w-0 space-y-1" aria-label="提炼请求列表">
              {runs.map((run) => (
                <button
                  key={run.requestId}
                  type="button"
                  aria-current={run.requestId === selectedRunIdFromList ? "true" : undefined}
                  className="flex w-full min-w-0 items-start justify-between gap-2 rounded-lg border border-border px-3 py-2 text-left text-ui-sm hover:bg-muted/50 aria-current:border-primary aria-current:bg-primary/5"
                  onClick={() => setSelectedRunId(run.requestId)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block break-all font-medium">{run.requestId}</span>
                    <span className="block text-ui-xs text-muted-foreground">
                      {new Date(run.createdAt).toLocaleString()}
                    </span>
                  </span>
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-ui-xs">
                    {skillEvolutionRunPresentation(run).label}
                  </span>
                </button>
              ))}
            </nav>
            <div className="min-w-0 space-y-3">
              {selectedRunQuery.isFetching ? (
                <p role="status" className="text-ui-sm text-muted-foreground">
                  正在读取请求详情…
                </p>
              ) : null}
              {selectedRunQuery.isError ? (
                <p role="alert" className="text-ui-sm text-destructive">
                  请求详情不可用：{errorText(selectedRunQuery.error)}
                </p>
              ) : null}
              {selectedRun ? (
                <div className="min-w-0 space-y-3 rounded-xl border border-border p-4">
                  <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <h3 className="break-all text-ui font-medium">
                        {selectedRunPresentation?.label ??
                          skillEvolutionRunStatusLabel(selectedRun.status)}
                      </h3>
                      {selectedRunPresentation?.detail ? (
                        <p className="break-words text-ui-sm text-muted-foreground" role="status">
                          {selectedRunPresentation.detail}
                        </p>
                      ) : null}
                      {selectedRun.summary && !selectedRunPresentation?.detail ? (
                        <p className="break-words text-ui-sm text-muted-foreground">
                          {selectedRun.summary}
                        </p>
                      ) : null}
                      {selectedRun.error ? (
                        <p className="break-words text-ui-sm text-destructive" role="alert">
                          {selectedRun.error}
                        </p>
                      ) : null}
                    </div>
                    {selectedRun.taskThreadId && onOpenTask ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onOpenTask(selectedRun.taskThreadId!)}
                      >
                        查看提炼任务 <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
                      </Button>
                    ) : null}
                    {isSkillEvolutionRunActive(selectedRun) && !expertArchived ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={working}
                        onClick={() => void cancelRun(selectedRun)}
                      >
                        取消真实任务
                      </Button>
                    ) : null}
                  </div>
                  {selectedRun.status === "no_change" ? (
                    <p className="rounded-lg bg-muted/50 p-3 text-ui-sm" role="status">
                      无需提炼：没有发现值得写入的可复用方法。正式 Skill、修订和绑定不变。
                    </p>
                  ) : null}
                  {selectedRun.status === "insufficient_evidence" ? (
                    <p className="rounded-lg bg-muted/50 p-3 text-ui-sm" role="status">
                      证据不足：当前来源无法支撑可复用结论。你可以补充来源后再次主动提炼。
                    </p>
                  ) : null}
                  {selectedRun.status === "failed" ? (
                    <p
                      className="rounded-lg border border-destructive/40 p-3 text-ui-sm text-destructive"
                      role="alert"
                    >
                      分析失败。{selectedRun.error ?? "请检查任务链接中的原生执行错误。"}
                    </p>
                  ) : null}
                  {selectedRun.proposals.map((proposal) => (
                    <ProposalCard
                      key={proposal.proposalId}
                      proposal={proposal}
                      expertArchived={expertArchived}
                      affectedExperts={impactedExperts(proposal)}
                      busy={working}
                      onEdit={performProposalEdit}
                      onApply={performApply}
                      onReject={performReject}
                      {...(onOpenTask ? { onOpenTask } : {})}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>

      <section className="min-w-0 space-y-4" aria-label="进化星图与版本详情">
        <EvolutionGraphView
          expertId={expertId}
          active={active}
          graph={graph}
          currentGraph={currentGraph}
          loading={graphQuery.isPending || currentGraphQuery.isPending}
          selectedSkillId={selectedSkillId}
          onSelectSkill={(node) => {
            setSelectedSkillNode(node);
            setSelectedSkillId(node.skillId);
            setSelectedEventId(null);
            restorePreviewMutation.reset();
            bindingRestorePreviewMutation.reset();
          }}
        />
        {selectedNode ? (
          <div
            className="min-w-0 rounded-xl border border-border p-4"
            aria-label="选中 Skill 版本详情"
          >
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="break-words text-ui-lg font-medium">{selectedNode.name}</h3>
                {selectedNode.deleted ? (
                  <p className="text-ui-sm text-muted-foreground" role="status">
                    已删除 · 历史事件仍可查看，当前 Skill 详情不可用。
                  </p>
                ) : null}
                <p className="break-all text-ui-sm text-muted-foreground">
                  {selectedNode.skillId} · v{selectedNode.revision} ·{" "}
                  {skillEvolutionPolicyLabel(selectedNode.policy)} ·{" "}
                  {skillEvolutionScopeLabel(
                    selectedNode.ownerExpertId
                      ? { kind: "expert", expertId: selectedNode.ownerExpertId }
                      : undefined,
                    expertNameById,
                  )}
                </p>
                <p className="break-all text-ui-xs text-muted-foreground">
                  内容包 {selectedNode.packageId} ·{" "}
                  {selectedNode.timestamp
                    ? new Date(selectedNode.timestamp).toLocaleString()
                    : "基线时间未知"}
                  {selectedNode.derivedFromSkillId
                    ? ` · 派生自 ${selectedNode.derivedFromSkillId}`
                    : ""}
                </p>
              </div>
              {selectedSkillNode &&
              !selectedNode.deleted &&
              !selectedSkillQuery.isPending &&
              selectedSkillQuery.data ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setSkillDetail(selectedSkillQuery.data!)}
                >
                  打开当前 Skill 详情
                </Button>
              ) : null}
            </div>
            {!selectedNode.deleted && selectedSkillQuery.isError ? (
              <p className="mt-2 text-ui-sm text-destructive" role="alert">
                Skill 详情不可用：{errorText(selectedSkillQuery.error)}
              </p>
            ) : null}
            {(currentGraph?.events ?? []).filter((event) => event.skillId === selectedNode.skillId)
              .length ? (
              <div className="mt-3 space-y-2">
                <h4 className="text-ui-sm font-medium">版本与来源</h4>
                <ul className="space-y-2">
                  {(currentGraph?.events ?? [])
                    .filter((event) => event.skillId === selectedNode.skillId)
                    .map((event) => (
                      <li
                        key={event.eventId}
                        className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2"
                      >
                        <span className="min-w-0 flex-1 text-ui-sm">
                          {event.kind === "binding_restored"
                            ? skillEvolutionEventLabel(event.kind)
                            : `${skillEvolutionEventLabel(event.kind)} · v${event.revision}`}{" "}
                          · {new Date(event.createdAt).toLocaleString()}
                          <span className="block break-all text-ui-xs text-muted-foreground">
                            来源请求 {event.requestId} · {event.operationId}
                            {event.affectedExpertIds.length
                              ? ` · 影响 ${event.affectedExpertIds.map((id) => expertNameById.get(id) ?? id).join("、")}`
                              : ""}
                          </span>
                        </span>
                        <div className="flex shrink-0 flex-wrap gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setSelectedEventId(event.eventId)}
                          >
                            查看来源
                          </Button>
                          {event.kind !== "binding_restored" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={
                                expertArchived ||
                                selectedNode.deleted ||
                                working ||
                                restorePreviewMutation.isPending
                              }
                              onClick={() => {
                                setSelectedEventId(event.eventId);
                                bindingRestorePreviewMutation.reset();
                                restorePreviewMutation.mutate(event.eventId);
                              }}
                            >
                              预览内容恢复
                            </Button>
                          ) : null}
                          {event.kind === "derived" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={
                                expertArchived ||
                                selectedNode.deleted ||
                                working ||
                                bindingRestorePreviewMutation.isPending
                              }
                              onClick={() => {
                                setSelectedEventId(event.eventId);
                                restorePreviewMutation.reset();
                                bindingRestorePreviewMutation.mutate(event.eventId);
                              }}
                            >
                              预览恢复原绑定
                            </Button>
                          ) : null}
                        </div>
                      </li>
                    ))}
                </ul>
              </div>
            ) : null}
            {selectedEvent && sourceRunQuery.data?.run ? (
              <div
                className="mt-3 space-y-2 rounded-lg border border-border p-3"
                aria-label="事件来源证据"
              >
                <p className="text-ui-sm font-medium">
                  来源请求：{sourceRunQuery.data.run.requestId}
                </p>
                {sourceRunQuery.data.run.proposals
                  .flatMap((proposal) => proposal.evidence)
                  .map((evidence) => (
                    <blockquote
                      key={`${evidence.threadId}:${evidence.messageId}`}
                      className="break-words border-l-2 border-border pl-3 text-ui-sm"
                    >
                      {evidence.quote}
                      {onOpenTask ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onOpenTask(evidence.threadId as ThreadId)}
                        >
                          打开任务
                        </Button>
                      ) : null}
                    </blockquote>
                  ))}
              </div>
            ) : null}
            {selectedContentRestorePreview ? (
              <div
                className="mt-3 space-y-3 rounded-lg border border-border bg-muted/20 p-3"
                aria-label="恢复预览"
                role="region"
              >
                <div>
                  <h4 className="text-ui-sm font-medium">恢复预览 · 将保存为新修订</h4>
                  <p className="text-ui-xs text-muted-foreground">
                    受影响专家：
                    {selectedContentRestorePreview.affectedExpertIds
                      .map((id) => expertNameById.get(id) ?? id)
                      .join("、") || "无"}
                  </p>
                </div>
                <ul className="space-y-2">
                  {selectedContentRestorePreview.changes.map((change, index) => (
                    <ProposalFileChange
                      key={change.path}
                      proposal={{
                        baseSkillId: selectedContentRestorePreview.skill.skillId,
                        baseRevision: selectedContentRestorePreview.skill.revision,
                        basePackageId: selectedContentRestorePreview.skill.packageId,
                      }}
                      change={change}
                      index={index}
                      baseVersionLabel={`当前版本 v${selectedContentRestorePreview.skill.revision}`}
                      targetVersionLabel="恢复目标"
                      compareButtonLabel="查看当前版本 vs 恢复目标完整对照"
                    />
                  ))}
                </ul>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={expertArchived || working}
                    onClick={() =>
                      void applyRestore().catch((cause: unknown) => setError(errorText(cause)))
                    }
                  >
                    {(selectedContentRestorePreview.skill.evolutionPolicy ?? "protected") ===
                    "protected"
                      ? "认可并恢复为新修订"
                      : "恢复为新修订"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => restorePreviewMutation.reset()}>
                    关闭预览
                  </Button>
                </div>
              </div>
            ) : null}
            {selectedBindingRestorePreview ? (
              <div
                className="mt-3 space-y-3 rounded-lg border border-border bg-muted/20 p-3"
                aria-label="恢复原绑定预览"
                role="region"
              >
                <div>
                  <h4 className="text-ui-sm font-medium">恢复原绑定</h4>
                  <p className="text-ui-sm">
                    {selectedBindingRestorePreview.fromSkill.name} →{" "}
                    {selectedBindingRestorePreview.toSkill.name}
                  </p>
                  <p className="text-ui-xs text-muted-foreground">
                    仅替换本专家的 Skill
                    绑定。专用副本会保留，其他绑定、启用状态和激活方式均按预览保留；不会恢复内容。
                  </p>
                </div>
                <div className="grid min-w-0 gap-3 md:grid-cols-2">
                  {(
                    [
                      ["恢复前绑定", selectedBindingRestorePreview.before],
                      ["恢复后绑定", selectedBindingRestorePreview.after],
                    ] as const
                  ).map(([title, bindings]) => (
                    <section key={title} className="min-w-0 rounded-lg border border-border p-3">
                      <h5 className="mb-2 text-ui-sm font-medium">{title}</h5>
                      <ul className="space-y-1">
                        {bindings.map((binding) => (
                          <li
                            key={binding.skillId}
                            className="break-words text-ui-xs"
                            data-testid={`${title}:${binding.skillId}`}
                          >
                            {bindingSkillName(binding.skillId)} ·{" "}
                            {binding.enabled ? "已启用" : "已停用"} ·{" "}
                            {binding.activation === "startup" ? "启动时激活" : "按需激活"}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={expertArchived || working}
                    onClick={() => void applyBindingRestore()}
                  >
                    确认恢复原绑定
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => bindingRestorePreviewMutation.reset()}
                  >
                    关闭预览
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      {skillDetail ? (
        <SkillLibraryDetail
          initial={skillDetail}
          onClose={() => setSkillDetail(null)}
          onChanged={async () => {
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: SKILL_LIBRARY_QUERY_KEY }),
              queryClient.invalidateQueries({
                queryKey: [...skillEvolutionQueryKey(expertId), "graph"],
              }),
              queryClient.invalidateQueries({
                queryKey: [...skillEvolutionQueryKey(expertId), "graph", "current"],
              }),
            ]);
          }}
          onDelete={setDeleteSkill}
        />
      ) : null}
      <Dialog
        open={Boolean(deleteSkill)}
        onOpenChange={(open) => {
          if (!open) setDeleteSkill(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>删除进化 Skill？</DialogTitle>
            <DialogDescription>
              {deleteSkill
                ? `“${deleteSkill.name}”可能仍被专家或进化记录引用。删除只会在服务器确认引用约束后执行。`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteSkill(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={working || !deleteSkill}
              onClick={() => {
                if (!deleteSkill) return;
                setWorking(true);
                void ensureExpertClient()
                  .skillLibrary({
                    action: "delete",
                    skillId: deleteSkill.skillId,
                    expectedRevision: deleteSkill.revision,
                    requestId: globalThis.crypto.randomUUID(),
                    confirmExpertIds: (expertsQuery.data ?? [])
                      .filter((expert) =>
                        expert.skillBindings?.some(
                          (binding) => binding.skillId === deleteSkill.skillId,
                        ),
                      )
                      .map((expert) => expert.id),
                  })
                  .then(async () => {
                    setSkillDetail(null);
                    setDeleteSkill(null);
                    await queryClient.invalidateQueries({ queryKey: SKILL_LIBRARY_QUERY_KEY });
                    await queryClient.invalidateQueries({
                      queryKey: [...skillEvolutionQueryKey(expertId), "graph"],
                    });
                  })
                  .catch((cause: unknown) => setError(errorText(cause)))
                  .finally(() => setWorking(false));
              }}
            >
              删除 Skill
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      {draftGuard.dialog}
    </div>
  );
}
