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
  useId,
  type ReactNode,
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
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { resolveProviderDiscoveryCwd } from "~/lib/providerDiscovery";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { Button } from "~/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "~/components/ui/alert";
import { DetailTabs } from "~/components/ui/DetailTabs";
import { SettingsEditorDialog } from "~/components/settings/SettingsEditorDialog";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { ensureExpertClient } from "~/workbench/host/expertClient";
import { buildModelSelection, formatProviderModelOptionName } from "~/providerModelOptions";
import {
  evolutionTimelineEntries,
  isSkillEvolutionRunActive,
  defaultSkillEvolutionSources,
  isLatestOpportunityGeneration,
  latestOpportunityGeneration,
  layoutEvolutionGraph,
  skillEvolutionActionLabel,
  skillEvolutionEventLabel,
  skillEvolutionProposalStatusLabel,
  skillEvolutionQueryKey,
  skillEvolutionRunPresentation,
  skillEvolutionScopeLabel,
} from "./model";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  ClockIcon,
  ExternalLinkIcon,
  FileIcon,
  LoaderCircleIcon,
  MinusIcon,
  PlusIcon,
} from "~/lib/icons";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogPanel,
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
  kind: "apply" | "restore" | "bind-restore" | "generate",
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

function sameKeys(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  return left.size === right.size && [...left].every((key) => right.has(key));
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
  compareInitiallyOpen = false,
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
  compareInitiallyOpen?: boolean;
  onChange?: (index: number, content: string) => void;
  onRemove?: (index: number) => void;
  onExecutableChange?: (index: number, executable: boolean) => void;
  baseVersionLabel?: string;
  targetVersionLabel?: string;
  compareButtonLabel?: string;
}) {
  const [showBase, setShowBase] = useState(compareInitiallyOpen);
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
      ) : showBase ? null : change.content === undefined ? (
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
  expertNameById,
  active,
  graph,
  currentGraph,
  loading,
  selectedSkillId,
  onSelectSkill,
}: {
  readonly expertId: string;
  expertNameById: ReadonlyMap<string, string>;
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
                  aria-label={`${node.name}，版本 ${node.revision}，${skillEvolutionScopeLabel(node.ownerExpertId ? { kind: "expert", expertId: node.ownerExpertId } : undefined, expertNameById)}${node.timestamp ? `，${new Date(node.timestamp).toLocaleDateString()}` : "，时间未知"}${node.deleted ? "，已删除" : ""}`}
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
                    stroke={node.ownerExpertId ? "var(--color-ring)" : "var(--color-primary)"}
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

function ExtractionFailure({ reason }: { reason: string }) {
  return (
    <Alert variant="error" size="sm">
      <AlertTitle className="text-ui-sm">提取失败</AlertTitle>
      <AlertDescription className="break-words text-ui-sm">{reason}</AlertDescription>
    </Alert>
  );
}

function ProposalCard({
  proposal,
  expertArchived,
  readOnly = false,
  compact = false,
  hideHeader = false,
  summaryDetails,
  readOnlyReason,
  ownerName,
  busy,
  onEdit,
  onApply,
  onReject,
  onOpenTask,
  onViewResult,
}: {
  proposal: SkillEvolutionProposal;
  expertArchived: boolean;
  readOnly?: boolean;
  compact?: boolean;
  hideHeader?: boolean;
  summaryDetails?: ReactNode;
  readOnlyReason?: string;
  ownerName: string;
  busy: boolean;
  onEdit: (input: {
    proposal: SkillEvolutionProposal;
    name: string;
    changes: SkillFileChange[];
  }) => Promise<void>;
  onApply: (proposal: SkillEvolutionProposal) => Promise<void>;
  onReject: (proposal: SkillEvolutionProposal) => Promise<void>;
  onOpenTask?: (threadId: ThreadId) => void;
  onViewResult?: (proposal: SkillEvolutionProposal) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [appliedDetailsOpen, setAppliedDetailsOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [name, setName] = useState(proposal.name);
  const [changes, setChanges] = useState(() => proposal.changes.map((change) => ({ ...change })));
  const [newFilePath, setNewFilePath] = useState("");
  useEffect(() => {
    if (readOnly) setEditing(false);
  }, [readOnly]);
  useEffect(() => {
    if (editing) return;
    setName(proposal.name);
    setChanges(proposal.changes.map((change) => ({ ...change })));
  }, [editing, proposal.changes, proposal.name]);
  const statusLabel = skillEvolutionProposalStatusLabel(proposal.status);
  const applyLabel = `应用到「${proposal.name}」`;

  const files = (
    <section className="space-y-2" aria-label="候选文件差异">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-ui-sm font-medium">文件差异（{changes.length} 项）</h4>
        {editing && !readOnly ? (
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
                !newFilePath.trim() || changes.some((change) => change.path === newFilePath.trim())
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
              editing={editing && !readOnly}
              compareInitiallyOpen={compact}
              targetVersionLabel={proposal.status === "applied" ? "已应用内容" : "候选版本"}
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
  );
  const actions = (
    <footer className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
      {readOnly && (proposal.status === "proposed" || proposal.status === "saved_unbound") ? (
        <p className="text-ui-sm text-muted-foreground" role="status">
          {readOnlyReason ?? "此候选已被更新的生成结果替代，不能继续编辑或采用。"}
        </p>
      ) : proposal.status === "proposed" && !expertArchived ? (
        editing ? (
          <>
            <Button
              size="sm"
              disabled={busy || !name.trim()}
              onClick={() =>
                void onEdit({ proposal, name: name.trim(), changes }).then(() => setEditing(false))
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
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setEditing(true);
                if (compact) setDiffOpen(true);
              }}
            >
              编辑候选
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                if (compact && !diffOpen) setDiffOpen(true);
                else void onApply(proposal);
              }}
            >
              {compact && !diffOpen ? "审阅并应用" : applyLabel}
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
        <Button size="sm" disabled={busy} onClick={() => void onApply(proposal)}>
          继续完成绑定
        </Button>
      ) : proposal.status === "conflict" ? (
        <p className="text-ui-sm text-destructive" role="status">
          目标版本或绑定已变化；候选已保留，请基于最新配置重新提炼。
        </p>
      ) : proposal.status === "applied" && !compact ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-ui-sm text-emerald-700 dark:text-emerald-300" role="status">
            已应用到「{proposal.name}」
            {proposal.resultRevision ? ` · v${proposal.resultRevision}` : ""}
          </p>
          {proposal.resultSkillId && onViewResult ? (
            <Button size="sm" variant="ghost" onClick={() => onViewResult(proposal)}>
              查看 Skill <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
            </Button>
          ) : null}
        </div>
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
  );
  return (
    <article
      className={
        compact ? "min-w-0 space-y-4" : "min-w-0 space-y-3 rounded-xl border border-border p-4"
      }
      aria-label={`Skill 候选：${proposal.name}`}
    >
      {!hideHeader ? (
        <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            {editing && !readOnly && !compact ? (
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
            {skillEvolutionActionLabel(proposal.action)} · {statusLabel}
          </span>
        </header>
      ) : null}

      {hideHeader ? <p className="break-words text-ui-sm font-medium">{proposal.summary}</p> : null}
      {summaryDetails}
      {proposal.error ? (
        <p className="text-ui-sm text-destructive" role="alert">
          {proposal.error}
        </p>
      ) : null}
      {!hideHeader ? (
        <>
          {proposal.status === "applied" ? (
            <p className="text-ui-sm text-muted-foreground">
              已保存并绑定给 {ownerName}，后续独立运行可使用。
            </p>
          ) : proposal.action === "derive" ? (
            <p className="rounded-lg bg-muted/50 px-3 py-2 text-ui-sm text-foreground/80">
              将基于来源 Skill 为 {ownerName} 创建专用副本；共享来源保持原样。
            </p>
          ) : proposal.action === "update" ? (
            <p className="rounded-lg bg-muted/50 px-3 py-2 text-ui-sm text-foreground/80">
              将更新 {ownerName} 的专用 Skill。
            </p>
          ) : (
            <p className="rounded-lg bg-muted/50 px-3 py-2 text-ui-sm text-foreground/80">
              将创建归属于 {ownerName} 的专用 Skill。
            </p>
          )}
        </>
      ) : null}
      {compact ? (
        <>
          <button
            type="button"
            className="flex w-full min-w-0 flex-wrap items-center justify-between gap-2 border-y border-border py-3 text-left text-ui-sm hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setDiffOpen(true)}
          >
            <span className="flex min-w-0 items-center gap-2 break-all font-medium">
              <FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              {changes.length === 1 ? changes[0]?.path : `${changes.length} 项文件变更`}
            </span>
            <span className="flex items-center gap-2 text-muted-foreground">
              {editing ? "继续编辑草稿" : "查看完整差异"}
              <DisclosureChevron open={false} />
            </span>
          </button>
          {proposal.status !== "applied" && !diffOpen ? actions : null}
          <SettingsEditorDialog
            open={diffOpen}
            onClose={() => setDiffOpen(false)}
            closeButtonLabel="关闭完整差异"
          >
            <DialogHeader className="shrink-0 px-6 pt-5 pb-4">
              <DialogTitle className="pr-8">{proposal.name} · 完整差异</DialogTitle>
              <DialogDescription>
                核对文件内容与基础版本。关闭面板会保留当前页面内尚未保存的编辑。
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="min-w-0 space-y-4 px-6 pb-5">
              {editing && !readOnly ? (
                <Input
                  aria-label="候选 Skill 名称"
                  value={name}
                  maxLength={200}
                  onChange={(event) => setName(event.target.value)}
                />
              ) : null}
              {files}
            </DialogPanel>
            {proposal.status !== "applied" ? (
              <div className="shrink-0 px-6 pb-4">{actions}</div>
            ) : null}
          </SettingsEditorDialog>
        </>
      ) : (
        <>
          {proposal.status === "applied" ? (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={appliedDetailsOpen}
              onClick={() => setAppliedDetailsOpen((open) => !open)}
            >
              查看已应用内容与依据 <DisclosureChevron open={appliedDetailsOpen} />
            </Button>
          ) : null}
          <DisclosureRegion open={proposal.status !== "applied" || appliedDetailsOpen}>
            <div className="space-y-3">
              {files}
              <section className="space-y-2" aria-label="提炼依据">
                <h4 className="text-ui-sm font-medium">提炼依据</h4>
                {proposal.evidence.length ? (
                  <ul className="space-y-2">
                    {proposal.evidence.map((evidence, evidenceIndex) => (
                      <li
                        key={`${evidence.threadId}:${evidence.messageId}:${evidenceIndex}`}
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
                            打开来源任务{" "}
                            <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-ui-sm text-muted-foreground">没有返回可展示的证据引用。</p>
                )}
              </section>
            </div>
          </DisclosureRegion>
          {actions}
        </>
      )}
    </article>
  );
}

type SkillEvolutionOpportunity = NonNullable<SkillEvolutionRun["opportunities"]>[number];

function OpportunityCard({
  generations,
  opportunity,
  latestGeneration,
  generationBlockReason,
  failureReason,
  expertArchived,
  busy,
  feedback,
  onFeedbackChange,
  onGenerate,
  onDismiss,
  onOpenAbilities,
  ownerName,
  onEdit,
  onApply,
  onReject,
  onOpenTask,
  onViewResult,
}: {
  generations: ReadonlyArray<SkillEvolutionRun>;
  opportunity: SkillEvolutionOpportunity;
  latestGeneration?: SkillEvolutionRun;
  generationBlockReason?: string;
  failureReason?: string;
  expertArchived: boolean;
  busy: boolean;
  feedback: string;
  onFeedbackChange: (value: string) => void;
  onGenerate: () => void;
  onDismiss: () => void;
  onOpenAbilities?: () => void;
  ownerName: string;
  onEdit: (input: {
    proposal: SkillEvolutionProposal;
    name: string;
    changes: SkillFileChange[];
  }) => Promise<void>;
  onApply: (proposal: SkillEvolutionProposal) => Promise<void>;
  onReject: (proposal: SkillEvolutionProposal) => Promise<void>;
  onOpenTask?: (threadId: ThreadId) => void;
  onViewResult?: (proposal: SkillEvolutionProposal) => void;
}) {
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const detailId = useId();
  const [detailTab, setDetailTab] = useState<"changes" | "evidence">("changes");
  const displayedGeneration =
    generations.find((run) => run.requestId === attemptId) ?? latestGeneration;
  const historical = Boolean(
    displayedGeneration && displayedGeneration.requestId !== latestGeneration?.requestId,
  );
  const dismissed = opportunity.status === "dismissed";
  const generationActive = Boolean(latestGeneration && isSkillEvolutionRunActive(latestGeneration));
  const feedbackRequired = Boolean(
    latestGeneration &&
    !generationActive &&
    latestGeneration.status !== "failed" &&
    latestGeneration.status !== "cancelled",
  );
  const retryNeedsFeedback = feedbackRequired && !feedback.trim();
  const adopted = Boolean(
    latestGeneration?.proposals.some((proposal) =>
      ["applying", "saved_unbound", "applied"].includes(proposal.status),
    ),
  );
  const canGenerate =
    !dismissed &&
    !expertArchived &&
    !busy &&
    !generationActive &&
    !adopted &&
    !retryNeedsFeedback &&
    !generationBlockReason;

  const headerProposal =
    displayedGeneration?.proposals.length === 1 ? displayedGeneration.proposals[0] : undefined;
  const displayedEvidence = displayedGeneration?.proposals.length
    ? displayedGeneration.proposals.flatMap((proposal) => proposal.evidence)
    : opportunity.evidence;
  const outcomes = (
    <section className="space-y-2" aria-label="提炼目标">
      <ul className="list-disc space-y-1 pl-5 text-ui-sm">
        {opportunity.outcomes.map((outcome, index) => (
          <li key={`${opportunity.opportunityId}:outcome:${index}`} className="break-words">
            {outcome}
          </li>
        ))}
      </ul>
    </section>
  );
  const failed = latestGeneration?.status === "failed" || Boolean(failureReason);
  if (failed)
    return (
      <article className="min-w-0 pt-2" aria-label={`经验机会：${opportunity.name}`}>
        <ExtractionFailure
          reason={
            failureReason ??
            latestGeneration?.error ??
            latestGeneration?.summary ??
            "未能完成提取。"
          }
        />
      </article>
    );
  const previews = generations
    .filter((run) => run.status === "proposal_ready" && run.proposals.length > 0)
    .toSorted((a, b) => (b.generationIndex ?? 0) - (a.generationIndex ?? 0));

  return (
    <article className="min-w-0 space-y-4 pt-2" aria-label={`经验机会：${opportunity.name}`}>
      {headerProposal ? (
        <header className="space-y-2">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-1 basis-full items-start gap-2 sm:basis-auto">
              <FileIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <h3 className="min-w-0 flex-1 break-words text-ui font-medium">
                {headerProposal.name}
              </h3>
            </div>
            <span className="rounded-md bg-muted px-2 py-1 text-ui-xs text-muted-foreground">
              {headerProposal.status === "applied"
                ? "专家专用"
                : skillEvolutionActionLabel(headerProposal.action)}
              {headerProposal.resultRevision ? ` · v${headerProposal.resultRevision}` : ""}
            </span>
            {headerProposal.resultSkillId && onViewResult ? (
              <Button size="sm" variant="ghost" onClick={() => onViewResult(headerProposal)}>
                查看 Skill <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
              </Button>
            ) : null}
          </div>
          <p className="text-ui-sm text-muted-foreground">
            {headerProposal.status === "applied"
              ? `已绑定 ${ownerName}，下次独立运行生效。`
              : headerProposal.action === "derive"
                ? `应用后创建 ${ownerName} 的专用副本，共享来源保持原样。`
                : headerProposal.action === "update"
                  ? `应用后更新 ${ownerName} 的专用 Skill。`
                  : `应用后新建 ${ownerName} 的专用 Skill。`}
          </p>
        </header>
      ) : null}
      <DetailTabs
        id={detailId}
        label="经验详情"
        value={detailTab}
        onChange={setDetailTab}
        tabs={[
          { value: "changes", label: "本次改动" },
          { value: "evidence", label: `依据 ${displayedEvidence.length}` },
        ]}
      />
      <div
        role="tabpanel"
        id={`${detailId}-changes-panel`}
        aria-labelledby={`${detailId}-changes-tab`}
        hidden={detailTab !== "changes"}
        className="min-w-0 space-y-4"
      >
        {!displayedGeneration?.proposals.length ? (
          <>
            <header className="space-y-1">
              <p className="break-words text-ui-sm text-muted-foreground">{opportunity.reason}</p>
              <p className="text-ui-xs text-muted-foreground">
                {opportunity.targetSkillId
                  ? "完善已有 Skill，应用时按权限创建或更新专家专用副本。"
                  : "新建专家专用 Skill。"}
              </p>
            </header>

            <section className="space-y-2" aria-label="预计形成的方法">
              <h5 className="text-ui-sm font-medium">预计形成的方法</h5>
              <ul className="list-disc space-y-1 pl-5 text-ui-sm">
                {opportunity.outcomes.map((outcome, index) => (
                  <li key={`${opportunity.opportunityId}:outcome:${index}`} className="break-words">
                    {outcome}
                  </li>
                ))}
              </ul>
            </section>
          </>
        ) : null}
        {historical ? (
          <p className="text-ui-xs text-muted-foreground" role="status">
            正在查看第 {displayedGeneration?.generationIndex ?? 1} 次预览；旧轮次仅供查看。
          </p>
        ) : null}
        {displayedGeneration?.error ? (
          <p className="text-ui-sm text-destructive" role="alert">
            {displayedGeneration.error}
          </p>
        ) : null}
        {displayedGeneration && !displayedGeneration.proposals.length ? (
          <div
            className="flex flex-wrap items-center gap-2 text-ui-sm text-muted-foreground"
            role="status"
          >
            <span>
              {generationActive
                ? "正在提取…"
                : skillEvolutionRunPresentation(displayedGeneration).label}
              {displayedGeneration.summary ? ` · ${displayedGeneration.summary}` : ""}
            </span>
          </div>
        ) : null}
        {displayedGeneration ? (
          <>
            {displayedGeneration.stage === "generation"
              ? displayedGeneration.proposals.map((proposal) => (
                  <ProposalCard
                    key={proposal.proposalId}
                    proposal={proposal}
                    compact
                    hideHeader={Boolean(headerProposal)}
                    summaryDetails={outcomes}
                    expertArchived={expertArchived}
                    readOnly={dismissed || historical}
                    readOnlyReason={
                      dismissed
                        ? "此经验已忽略，不能继续编辑或采用。"
                        : "此候选已被更新的生成结果替代，不能继续编辑或采用。"
                    }
                    ownerName={ownerName}
                    busy={busy}
                    onEdit={onEdit}
                    onApply={onApply}
                    {...(onViewResult ? { onViewResult } : {})}
                    onReject={onReject}
                    {...(onOpenTask ? { onOpenTask } : {})}
                  />
                ))
              : null}
          </>
        ) : null}
        {!adopted && !dismissed && !generationActive ? (
          <label className="grid min-w-0 gap-1.5 text-ui-sm">
            <span className="font-medium">补充反馈（可选）</span>
            <Textarea
              aria-label={`生成反馈：${opportunity.name}`}
              value={feedback}
              maxLength={8_000}
              rows={2}
              disabled={dismissed || expertArchived || adopted || busy || generationActive}
              placeholder="例如：保留通用步骤，去掉项目专有信息。"
              onChange={(event) => onFeedbackChange(event.target.value)}
            />
          </label>
        ) : null}
        {retryNeedsFeedback && !adopted && !dismissed && !generationActive ? (
          <p className="text-ui-xs text-muted-foreground" role="status">
            再次生成前请补充反馈。
          </p>
        ) : null}

        {generationBlockReason && !adopted && !dismissed && !generationActive ? (
          <div className="space-y-2 rounded-lg bg-muted/50 p-3">
            <p className="text-ui-sm text-muted-foreground" role="status">
              {generationBlockReason}
            </p>
            {onOpenAbilities ? (
              <Button size="sm" variant="outline" onClick={onOpenAbilities}>
                前往 Expert 能力配置
              </Button>
            ) : null}
          </div>
        ) : null}
        {dismissed ? (
          <p className="text-ui-sm text-muted-foreground" role="status">
            已忽略此经验机会；相关生成结果不能采用。
          </p>
        ) : null}

        {!adopted && !dismissed && !generationActive ? (
          <footer className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Button
              disabled={!canGenerate}
              aria-busy={busy || generationActive}
              onClick={onGenerate}
            >
              {busy ? "提交中…" : latestGeneration ? "重新生成预览" : "生成修改预览"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={dismissed || expertArchived || busy || generationActive || adopted}
              onClick={onDismiss}
            >
              忽略
            </Button>
          </footer>
        ) : null}
      </div>
      <div
        role="tabpanel"
        id={`${detailId}-evidence-panel`}
        aria-labelledby={`${detailId}-evidence-tab`}
        hidden={detailTab !== "evidence"}
        className="min-w-0 space-y-4"
      >
        <p className="break-words text-ui-sm text-muted-foreground">{opportunity.reason}</p>
        <section aria-label="经验依据" className="space-y-3">
          <ul className="space-y-2">
            {displayedEvidence.map((evidence, evidenceIndex) => (
              <li
                key={`${evidence.threadId}:${evidence.messageId}:${evidenceIndex}`}
                className="flex min-w-0 flex-col gap-2 border-b border-border/60 py-3 text-ui-sm last:border-b-0 sm:flex-row sm:items-start sm:justify-between sm:gap-5"
              >
                <blockquote className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                  {evidence.quote}
                </blockquote>
                {onOpenTask ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0 self-start sm:self-center"
                    onClick={() => onOpenTask(evidence.threadId as ThreadId)}
                  >
                    打开来源任务 <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          {displayedEvidence.length === 0 ? (
            <p className="text-ui-sm text-muted-foreground">没有返回可展示的证据引用。</p>
          ) : null}
        </section>
      </div>
      {previews.length > 1 ? (
        <section aria-label="历史预览" className="border-t border-border pt-2">
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((open) => !open)}
          >
            历史预览（{previews.length}）<DisclosureChevron open={historyOpen} />
          </Button>
          <DisclosureRegion open={historyOpen}>
            <div className="flex flex-wrap gap-2 pt-2">
              {previews.map((attempt) => (
                <Button
                  key={attempt.requestId}
                  size="sm"
                  variant={
                    attempt.requestId === displayedGeneration?.requestId ? "secondary" : "ghost"
                  }
                  onClick={() => {
                    setAttemptId(
                      attempt.requestId === latestGeneration?.requestId ? null : attempt.requestId,
                    );
                    setDetailTab("changes");
                  }}
                >
                  第 {attempt.generationIndex ?? 1} 次预览
                  {attempt.requestId === latestGeneration?.requestId ? " · 最新" : ""}
                </Button>
              ))}
            </div>
          </DisclosureRegion>
        </section>
      ) : null}
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
  onOpenAbilities,
}: {
  readonly expertId: string;
  readonly expertName: string;
  readonly expertArchived?: boolean;
  readonly active: boolean;
  readonly initialThreadId?: string | null;
  readonly initialThreadRequestKey?: number;
  readonly onOpenTask?: (threadId: ThreadId) => void;
  readonly onOpenAbilities?: () => void;
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
  const [selectedSourcesOverride, setSelectedSourcesOverride] =
    useState<ReadonlySet<string> | null>(null);
  const pendingStartRef = useRef<{
    readonly fingerprint: string;
    readonly request: Extract<SkillEvolutionRequest, { action: "start" }>;
  } | null>(null);
  const initialThreadSelectionRef = useRef<string | null>(null);
  const [configPanel, setConfigPanel] = useState<"sources" | "model" | "focus" | null>(null);
  const [expandedSourceKey, setExpandedSourceKey] = useState<string | null>(null);
  const sourceOpen = configPanel === "sources";
  const modelOpen = configPanel === "model";
  const focusOpen = configPanel === "focus";
  const configPanelId = useId();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [expandedEntryId, setExpandedEntryId] = useState<string | null>(null);
  const [visitedEntries, setVisitedEntries] = useState<ReadonlySet<string>>(new Set());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [focus, setFocus] = useState("");
  const [feedbackDrafts, setFeedbackDrafts] = useState<Readonly<Record<string, string>>>({});
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
  const [extractionError, setExtractionError] = useState<string | null>(null);
  const [generationErrors, setGenerationErrors] = useState<
    Readonly<Record<string, { reason: string; previousRequestId: string | null }>>
  >({});
  const [working, setWorking] = useState(false);
  const [skillDetail, setSkillDetail] = useState<SkillDefinition | null>(null);
  const [deleteSkill, setDeleteSkill] = useState<SkillDefinition | null>(null);
  const sources = sourcesQuery.data?.sources ?? [];
  const runs = runsQuery.data?.runs ?? [];
  const defaultSources = useMemo(
    () =>
      defaultSkillEvolutionSources(sources, {
        runs,
        ...(initialThreadId === undefined ? {} : { preferredThreadId: initialThreadId }),
      }),
    [initialThreadId, runs, sources],
  );
  const defaultSourceKeys = useMemo(() => new Set(defaultSources.map(sourceKey)), [defaultSources]);
  const selectedSources = selectedSourcesOverride ?? defaultSourceKeys;
  const initialThreadSourceMissing = Boolean(
    initialThreadId && !sources.some((source) => source.threadId === initialThreadId),
  );
  const selectedRunIdFromList = selectedRunId;
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
  const hydratedSelectedRun =
    selectedRunQuery.data?.run ?? runs.find((run) => run.requestId === selectedRunIdFromList);

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

  const currentProviderCapability = (capabilitiesQuery.data?.capabilities ?? []).find(
    (capability) => capability.provider === draft.selectedProvider,
  );
  const currentBindings =
    expertsQuery.data?.find((expert) => expert.id === expertId)?.skillBindings ?? [];
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
    (next: SkillEvolutionRun | undefined, select = true) => {
      if (next) {
        queryClient.setQueryData<SkillEvolutionResponse>(runKey, (current) => ({
          ...(current ?? {}),
          runs: [next, ...(current?.runs ?? []).filter((run) => run.requestId !== next.requestId)],
        }));
        queryClient.setQueryData([...skillEvolutionQueryKey(expertId), "run", next.requestId], {
          run: next,
        });
        if (select) setSelectedRunId(next.requestId);
      }
    },
    [expertId, queryClient, runKey],
  );

  const startSources = useMemo(
    () =>
      sources
        .filter((source) => selectedSources.has(sourceKey(source)))
        .map(({ threadId, turnId }) => ({ threadId, turnId })),
    [selectedSources, sources],
  );
  const startFingerprint = useMemo(
    () =>
      JSON.stringify({
        action: "start",
        expertId,
        sources: startSources,
        ...(focus.trim() ? { focus: focus.trim() } : {}),
        modelSelection,
      }),
    [expertId, focus, modelSelection, startSources],
  );

  const startMutation = useMutation({
    mutationFn: (request: Extract<SkillEvolutionRequest, { action: "start" }>) =>
      ensureExpertClient().skillEvolution(request),
    onSuccess: (result) => {
      pendingStartRef.current = null;
      if (result.run) {
        updateRun(result.run);
        setExpandedEntryId(result.run.requestId);
        setVisitedEntries((current) => new Set([...current, result.run!.requestId]));
        setNotice("已开始查找可复用经验。此阶段不会写入正式 Skill。");
        setSelectedSourcesOverride(null);
        setFocus("");
      }
      void queryClient.invalidateQueries({ queryKey: runKey });
      void queryClient.invalidateQueries({
        queryKey: [...skillEvolutionQueryKey(expertId), SOURCES_QUERY_SUFFIX],
      });
    },
    onError: (cause) => {
      setExtractionError(errorText(cause));
      void queryClient.invalidateQueries({ queryKey: runKey });
    },
  });

  useEffect(() => {
    const pending = pendingStartRef.current;
    if (!pending || startMutation.isPending) return;
    const recovered = runs.find((run) => run.requestId === pending.request.requestId);
    if (!recovered) return;
    pendingStartRef.current = null;
    updateRun(recovered);
    setExpandedEntryId(recovered.requestId);
    setVisitedEntries((current) => new Set([...current, recovered.requestId]));
    setError(null);
    setExtractionError(null);
    setNotice("已恢复此次提炼请求。此阶段不会写入正式 Skill。");
  }, [runs, startMutation.isPending, updateRun]);

  useEffect(() => {
    const pending = pendingStartRef.current;
    if (!pending || startMutation.isPending || pending.fingerprint === startFingerprint) return;
    pendingStartRef.current = null;
  }, [startFingerprint, startMutation.isPending]);

  useEffect(() => {
    if (!sourcesQuery.isSuccess) return;
    const signature = `${initialThreadRequestKey ?? 0}\u0000${initialThreadId ?? ""}`;
    if (initialThreadSelectionRef.current === signature) return;
    initialThreadSelectionRef.current = signature;
    if (!initialThreadId) return;
    const explicitSource = defaultSkillEvolutionSources(sources, {
      preferredThreadId: initialThreadId,
    })[0];
    setSelectedSourcesOverride(new Set(explicitSource ? [sourceKey(explicitSource)] : []));
  }, [initialThreadId, initialThreadRequestKey, sources, sourcesQuery.isSuccess]);

  const sourceDraftDirty = Boolean(
    selectedSourcesOverride && !sameKeys(selectedSourcesOverride, defaultSourceKeys),
  );
  const feedbackDraftDirty = Object.values(feedbackDrafts).some((value) => value.trim().length > 0);
  const formDraftDirty = sourceDraftDirty || focus.trim().length > 0 || feedbackDraftDirty;
  const draftGuard = useExpertDraftGuard({
    isDirty: formDraftDirty,
    shouldGuardNavigation: ({ currentPathname, nextPathname, currentSearch, nextSearch }) =>
      currentPathname !== nextPathname ||
      currentSearch.kind !== nextSearch.kind ||
      currentSearch.expertId !== nextSearch.expertId,
    canSave: false,
    saveDisabledReason: "来源、重点和反馈不会自动提交；可留在本页提炼，或明确放弃草稿。",
    onSave: async () => false,
    onDiscard: () => {
      setSelectedSourcesOverride(null);
      setFocus("");
      setFeedbackDrafts({});
    },
  });

  const runRequest = async (
    request: SkillEvolutionRequest,
    options: { readonly selectResult?: boolean } = {},
  ) => {
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      const response = await ensureExpertClient().skillEvolution(request);
      updateRun(response.run, options.selectResult ?? true);
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
      if (request.action !== "generate") setError(errorText(cause));
      else void queryClient.invalidateQueries({ queryKey: runKey });
      throw cause;
    } finally {
      setWorking(false);
    }
  };

  const start = () => {
    if (
      !startSources.length ||
      startSources.length > 5 ||
      capabilityFailure ||
      expertArchived ||
      !runsQuery.isSuccess
    )
      return;
    setError(null);
    setNotice(null);
    setExtractionError(null);
    const fingerprint = startFingerprint;
    const request =
      pendingStartRef.current?.fingerprint === fingerprint
        ? pendingStartRef.current.request
        : {
            action: "start" as const,
            requestId: globalThis.crypto.randomUUID(),
            expertId,
            sources: startSources,
            ...(focus.trim() ? { focus: focus.trim() } : {}),
            modelSelection,
          };
    pendingStartRef.current = { fingerprint, request };
    startMutation.mutate(request);
  };

  const generateOpportunity = async (
    discovery: SkillEvolutionRun,
    opportunity: NonNullable<SkillEvolutionRun["opportunities"]>[number],
  ) => {
    const previousGeneration = latestOpportunityGeneration(
      runs,
      discovery.requestId,
      opportunity.opportunityId,
    );
    const submittedFeedback =
      feedbackDrafts[opportunity.opportunityId] ?? previousGeneration?.feedback ?? "";
    const feedback = submittedFeedback.trim();
    const requestId = await stableOperationId("generate", [
      discovery.requestId,
      opportunity.opportunityId,
      opportunity.digest,
      previousGeneration?.requestId ?? "first-generation",
      feedback,
    ]);
    setGenerationErrors((current) => {
      const next = { ...current };
      delete next[opportunity.opportunityId];
      return next;
    });
    try {
      await runRequest(
        {
          action: "generate",
          requestId,
          discoveryRequestId: discovery.requestId,
          opportunityId: opportunity.opportunityId,
          expectedDigest: opportunity.digest,
          ...(feedback ? { feedback } : {}),
        },
        { selectResult: false },
      );
    } catch (cause) {
      setGenerationErrors((current) => ({
        ...current,
        [opportunity.opportunityId]: {
          reason: errorText(cause),
          previousRequestId: previousGeneration?.requestId ?? null,
        },
      }));
      return;
    }
    setFeedbackDrafts((current) => {
      if (current[opportunity.opportunityId] !== submittedFeedback) return current;
      const next = { ...current };
      delete next[opportunity.opportunityId];
      return next;
    });
  };

  const dismissOpportunity = async (
    discovery: SkillEvolutionRun,
    opportunity: NonNullable<SkillEvolutionRun["opportunities"]>[number],
  ) => {
    await runRequest({
      action: "dismissOpportunity",
      requestId: discovery.requestId,
      opportunityId: opportunity.opportunityId,
      expectedDigest: opportunity.digest,
    });
    setFeedbackDrafts((current) => {
      const next = { ...current };
      delete next[opportunity.opportunityId];
      return next;
    });
  };

  const performProposalEdit = async (input: {
    proposal: SkillEvolutionProposal;
    name: string;
    changes: SkillFileChange[];
  }) => {
    await runRequest(
      {
        action: "edit",
        requestId: input.proposal.requestId,
        proposalId: input.proposal.proposalId,
        expectedDigest: input.proposal.digest,
        name: input.name,
        changes: input.changes,
      },
      { selectResult: input.proposal.requestId === selectedRunIdFromList },
    );
  };
  const performApply = async (proposal: SkillEvolutionProposal) => {
    const appliedChild = runs.find(
      (run) => run.stage === "generation" && run.requestId === proposal.requestId,
    );
    const operationId = await stableOperationId("apply", [
      proposal.requestId,
      proposal.proposalId,
      proposal.digest,
    ]);
    await runRequest(
      {
        action: "apply",
        requestId: proposal.requestId,
        proposalId: proposal.proposalId,
        expectedDigest: proposal.digest,
        operationId,
      },
      { selectResult: proposal.requestId === selectedRunIdFromList },
    );
    if (appliedChild?.opportunityId)
      setFeedbackDrafts((current) => {
        const next = { ...current };
        delete next[appliedChild.opportunityId!];
        return next;
      });
  };
  const performReject = async (proposal: SkillEvolutionProposal) => {
    await runRequest(
      {
        action: "reject",
        requestId: proposal.requestId,
        proposalId: proposal.proposalId,
        expectedDigest: proposal.digest,
      },
      { selectResult: proposal.requestId === selectedRunIdFromList },
    );
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
  const viewResult = (proposal: SkillEvolutionProposal) => {
    if (!proposal.resultSkillId) return;
    void ensureExpertClient()
      .skillLibrary({
        action: "read",
        skillId: proposal.resultSkillId as SkillDefinition["skillId"],
      })
      .then((response) => {
        if (!response.skill) throw new Error("此 Skill 已不可用，历史内容仍可在经验中查看。");
        setSkillDetail(response.skill);
      })
      .catch((cause) => setError(errorText(cause)));
  };
  const bindingSkillName = (skillId: string) => {
    const names = [
      ...(skillsQuery.data?.skills ?? []).map((skill) => [skill.skillId, skill.name] as const),
      ...(currentGraph?.nodes ?? []).map((node) => [node.skillId, node.name] as const),
      ...(graph?.nodes ?? []).map((node) => [node.skillId, node.name] as const),
    ];
    return names.find(([id]) => id === skillId)?.[1] ?? skillId;
  };
  const generationBlockReasonFor = (opportunity: SkillEvolutionOpportunity) => {
    if (!opportunity.targetSkillId) return undefined;
    if (expertsQuery.isPending) return "正在确认目标 Skill 的 Expert 绑定权限，暂不能生成。";
    if (expertsQuery.isError)
      return `无法读取此 Expert 的绑定权限：${errorText(expertsQuery.error)}，暂不能生成。`;
    const binding = currentBindings.find(
      (candidate) => candidate.skillId === opportunity.targetSkillId,
    );
    if (binding?.allowEvolution === true) return undefined;
    const targetName =
      skillsQuery.data?.skills?.find((skill) => skill.skillId === opportunity.targetSkillId)
        ?.name ?? bindingSkillName(opportunity.targetSkillId);
    return `目标 Skill「${targetName}」尚未在此 Expert 绑定中开启“允许复制并改进”，暂不能生成。`;
  };
  const timeline = useMemo(
    () =>
      evolutionTimelineEntries(runs).map((entry) => {
        const failedRequest = entry.opportunity
          ? generationErrors[entry.opportunity.opportunityId]
          : undefined;
        if (!entry.opportunity || !failedRequest) return entry;
        const latest = latestOpportunityGeneration(
          runs,
          entry.run.requestId,
          entry.opportunity.opportunityId,
        );
        return failedRequest.previousRequestId === (latest?.requestId ?? null)
          ? { ...entry, pending: false, failed: true, label: "提取失败" }
          : entry;
      }),
    [runs, generationErrors],
  );
  const recentApplied = new Set(
    timeline
      .filter((entry) => entry.applied)
      .slice(0, 3)
      .map((entry) => entry.id),
  );
  const recentFailureId = timeline.find((entry) => entry.failed)?.id;
  const visibleTimeline = timeline.filter(
    (entry) =>
      historyOpen ||
      entry.pending ||
      entry.id === recentFailureId ||
      recentApplied.has(entry.id) ||
      entry.id === expandedEntryId,
  );
  const hiddenCount = timeline.length - visibleTimeline.length;
  const pendingCount = timeline.filter((entry) => entry.pending).length;
  useEffect(() => {
    if (!expandedEntryId || timeline.some((entry) => entry.id === expandedEntryId)) return;
    const replacement = timeline.find((entry) => entry.run.requestId === expandedEntryId);
    if (replacement) {
      setExpandedEntryId(replacement.id);
      setVisitedEntries((current) => new Set([...current, replacement.id]));
    }
  }, [expandedEntryId, timeline]);
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
      <section className="min-w-0 rounded-xl border border-border bg-background p-4">
        <header className="mb-4 space-y-1">
          <h2 className="text-ui-lg font-medium">提炼经验</h2>
          <p className="text-ui-sm text-muted-foreground">
            把工作经验沉淀为技能。审阅并应用后，正式 Skill 才会更新。
          </p>
        </header>
        {expertArchived ? (
          <p className="rounded-lg bg-muted/50 p-3 text-ui-sm text-muted-foreground" role="status">
            专家已归档。历史进化记录可查看，但不能发起、采用或恢复。
          </p>
        ) : (
          <>
            {sourcesQuery.isPending ? (
              <p className="text-ui-sm text-muted-foreground" role="status">
                正在读取可用工作经验…
              </p>
            ) : sourcesQuery.isError ? (
              <p className="text-ui-sm text-destructive" role="alert">
                无法读取来源：{errorText(sourcesQuery.error)}
              </p>
            ) : sources.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border p-3 text-ui-sm text-muted-foreground">
                暂无可提炼的工作经验
              </p>
            ) : (
              <>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    aria-expanded={sourceOpen}
                    aria-controls={configPanelId}
                    onClick={() =>
                      setConfigPanel((panel) => (panel === "sources" ? null : "sources"))
                    }
                  >
                    已选 {selectedSources.size} 段工作记录 <DisclosureChevron open={sourceOpen} />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="min-w-0 max-w-full"
                    aria-label="调整提炼模型"
                    aria-expanded={modelOpen}
                    aria-controls={configPanelId}
                    onClick={() => setConfigPanel((panel) => (panel === "model" ? null : "model"))}
                  >
                    <span className="truncate">
                      {draft.selectedModel
                        ? formatProviderModelOptionName({
                            provider: draft.selectedProvider,
                            slug: draft.selectedModel,
                          })
                        : "选择模型"}
                    </span>
                    <DisclosureChevron open={modelOpen} />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={focusOpen}
                    aria-controls={configPanelId}
                    onClick={() => setConfigPanel((panel) => (panel === "focus" ? null : "focus"))}
                  >
                    {focus.trim() ? "编辑提炼重点" : "补充提炼重点"}
                    <DisclosureChevron open={focusOpen} />
                  </Button>
                  <div className="order-1 basis-full text-ui-xs empty:hidden">
                    {initialThreadSourceMissing ? (
                      <p className="text-ui-xs text-muted-foreground" role="status">
                        此任务没有可用片段，可在下方选择其他来源。
                      </p>
                    ) : null}
                    {capabilityFailure ? (
                      <p className="text-ui-xs text-destructive" role="status">
                        {capabilityFailure}
                      </p>
                    ) : !runsQuery.isSuccess ? (
                      <p className="text-ui-xs text-muted-foreground" role="status">
                        {runsQuery.isError
                          ? "无法确认已用片段，暂时不能发起提炼。"
                          : "正在核对已用片段…"}
                      </p>
                    ) : !draft.selectedModel?.trim() ? (
                      <p className="text-ui-xs text-muted-foreground" role="status">
                        请选择本次提炼使用的模型。
                      </p>
                    ) : null}
                  </div>
                  <Button
                    className="ml-auto"
                    disabled={
                      selectedSources.size < 1 ||
                      selectedSources.size > 5 ||
                      !runsQuery.isSuccess ||
                      Boolean(capabilityFailure) ||
                      startMutation.isPending ||
                      working ||
                      !draft.selectedModel?.trim()
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
                    {startMutation.isPending ? "提交中…" : "提炼经验"}
                  </Button>
                </div>

                <div id={configPanelId}>
                  <DisclosureRegion open={configPanel !== null} className="min-w-0">
                    <div hidden={!sourceOpen}>
                      <div className="border-t border-border pt-3">
                        <fieldset className="min-w-0 space-y-2" disabled={startMutation.isPending}>
                          <legend className="text-ui-sm font-medium">
                            选择工作记录（最多 5 段）
                          </legend>
                          <ul className="max-h-72 min-w-0 space-y-2 overflow-y-auto pr-1">
                            {[...sources]
                              .sort((left, right) =>
                                right.completedAt.localeCompare(left.completedAt),
                              )
                              .map((source) => {
                                const key = sourceKey(source);
                                const checked = selectedSources.has(key);
                                const disabled = !checked && selectedSources.size >= 5;
                                return (
                                  <li
                                    key={key}
                                    className="min-w-0 rounded-lg border border-border px-3 py-2"
                                  >
                                    <div className="grid min-w-0 grid-cols-1 items-center gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1fr)_auto]">
                                      <label className="flex min-w-0 cursor-pointer items-start gap-3">
                                        <Checkbox
                                          aria-label={`选择来源：${source.title || "未命名任务"}`}
                                          checked={checked}
                                          disabled={disabled}
                                          onCheckedChange={(value) =>
                                            setSelectedSourcesOverride((current) => {
                                              const next = new Set(current ?? defaultSourceKeys);
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
                                            <span>
                                              {new Date(source.completedAt).toLocaleString()}
                                            </span>
                                            <span>{source.messageCount} 条消息</span>
                                            {runs.some(
                                              (run) =>
                                                run.stage === "discovery" &&
                                                run.sourceSelections?.some(
                                                  (selection) => sourceKey(selection) === key,
                                                ),
                                            ) ? (
                                              <span>已提炼过</span>
                                            ) : null}
                                          </span>
                                        </span>
                                      </label>
                                      <div className="flex shrink-0 flex-wrap items-center gap-1 pl-7 sm:pl-0">
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          aria-expanded={expandedSourceKey === key}
                                          onClick={() =>
                                            setExpandedSourceKey((current) =>
                                              current === key ? null : key,
                                            )
                                          }
                                        >
                                          记录详情{" "}
                                          <DisclosureChevron open={expandedSourceKey === key} />
                                        </Button>
                                        {onOpenTask ? (
                                          <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => onOpenTask(source.threadId as ThreadId)}
                                          >
                                            打开任务{" "}
                                            <ExternalLinkIcon
                                              aria-hidden="true"
                                              className="size-3.5"
                                            />
                                          </Button>
                                        ) : null}
                                      </div>
                                    </div>
                                    <DisclosureRegion open={expandedSourceKey === key}>
                                      <p className="break-all pt-2 pl-7 text-ui-xs text-muted-foreground">
                                        Expert v{source.expertRevision} · 来源 {source.snapshotId}
                                      </p>
                                    </DisclosureRegion>
                                  </li>
                                );
                              })}
                          </ul>
                        </fieldset>
                      </div>
                    </div>
                    <div hidden={!focusOpen} className="pt-3">
                      <label className="grid min-w-0 gap-1.5 text-ui-sm">
                        <span className="font-medium">发现重点（可选）</span>
                        <Textarea
                          aria-label="发现重点"
                          value={focus}
                          maxLength={8_000}
                          rows={3}
                          disabled={startMutation.isPending}
                          placeholder="例如：查找可复用的排查与复核步骤。"
                          onChange={(event) => setFocus(event.target.value)}
                        />
                      </label>
                    </div>
                    <div hidden={!modelOpen} className="pt-3">
                      <div className="min-w-0 space-y-2 rounded-lg border border-border p-3">
                        <div className="space-y-1">
                          <p className="text-ui-sm font-medium">本次运行模型</p>
                          <p className="text-ui-xs text-muted-foreground">
                            使用当前已选 Provider 和模型；只有通过下方选择器明确操作时才会切换。
                          </p>
                        </div>
                        <ScratchModelPickers
                          draft={draft}
                          catalog={catalog}
                          providerStatuses={providerStatuses}
                        />
                        {capabilityFailure ? (
                          <p
                            className="flex items-start gap-2 text-ui-sm text-destructive"
                            role="status"
                          >
                            <CircleAlertIcon
                              aria-hidden="true"
                              className="mt-0.5 size-4 shrink-0"
                            />
                            <span>{capabilityFailure}</span>
                          </p>
                        ) : currentProviderCapability ? (
                          <p className="text-ui-xs text-muted-foreground" role="status">
                            {currentProviderCapability.reason || "当前 Provider 满足提炼约束。"}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </DisclosureRegion>
                </div>
              </>
            )}
          </>
        )}
        {notice ? (
          <p className="rounded-lg border border-border bg-muted/40 p-3 text-ui-sm" role="status">
            {notice}
          </p>
        ) : null}
        {extractionError ? <ExtractionFailure reason={extractionError} /> : null}
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
            经验{" "}
            {pendingCount > 0 ? (
              <span className="ml-2 text-ui-sm font-normal text-muted-foreground">
                {pendingCount} 条待处理
              </span>
            ) : null}
          </h2>
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={graphOpen}
            onClick={() => setGraphOpen((open) => !open)}
          >
            进化星图 <DisclosureChevron open={graphOpen} />
          </Button>
        </div>
        {runsQuery.isPending ? (
          <p role="status" className="text-ui-sm text-muted-foreground">
            正在读取经验…
          </p>
        ) : null}
        {runsQuery.isError ? (
          <p role="alert" className="text-ui-sm text-destructive">
            无法读取提炼记录：{errorText(runsQuery.error)}
          </p>
        ) : null}
        {!visibleTimeline.length && !runsQuery.isPending ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-6 text-ui-sm text-muted-foreground">
            {timeline.length
              ? "暂时没有待处理经验，历史记录已保留。"
              : "从一次工作记录开始，发现值得复用的方法。"}
          </p>
        ) : null}
        <ol className="min-w-0" aria-label="经验时间线">
          {timeline.map((entry) => {
            const visible = visibleTimeline.some((item) => item.id === entry.id);
            const expanded = visible && (entry.failed || entry.id === expandedEntryId);
            const selectedRun =
              hydratedSelectedRun?.requestId === entry.run.requestId
                ? hydratedSelectedRun
                : entry.run;
            const parent = runs.find((run) => run.requestId === selectedRun.discoveryRequestId);
            const opportunity = parent?.opportunities?.find(
              (item) => item.opportunityId === selectedRun.opportunityId,
            );
            const readOnlyReason =
              selectedRun.stage !== "generation"
                ? undefined
                : !parent || !opportunity
                  ? "无法确认此生成结果所属的经验机会，暂不能编辑或采用。"
                  : opportunity.status === "dismissed"
                    ? "此经验已忽略，不能继续编辑或采用。"
                    : !isLatestOpportunityGeneration(selectedRun, runs)
                      ? "此候选已被更新的生成结果替代，不能继续编辑或采用。"
                      : undefined;
            const StatusIcon = entry.active
              ? LoaderCircleIcon
              : entry.applied
                ? CircleCheckIcon
                : entry.pending
                  ? ClockIcon
                  : CircleAlertIcon;
            const detailId = `experience-detail-${encodeURIComponent(entry.id)}`;
            const nodeSummary = (
              <>
                <span className="min-w-0 flex-1 basis-full break-words text-ui font-medium sm:basis-auto">
                  {entry.title}
                </span>
                {!entry.failed ? (
                  <span
                    className={`rounded-md px-2 py-1 text-ui-xs ${entry.applied ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-muted text-muted-foreground"}`}
                  >
                    {entry.label}
                  </span>
                ) : null}

                <time
                  dateTime={entry.run.createdAt}
                  className="flex items-center gap-1 text-ui-xs text-muted-foreground"
                >
                  <ClockIcon aria-hidden="true" className="size-3.5" />
                  {new Date(entry.run.createdAt).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
                {!entry.failed ? <DisclosureChevron open={expanded} /> : null}
              </>
            );
            return (
              <li
                key={entry.id}
                hidden={!visible}
                className="relative min-w-0 pl-9"
                data-testid={`experience-node:${entry.id}`}
              >
                {visibleTimeline.at(-1)?.id !== entry.id || expanded ? (
                  <div
                    aria-hidden="true"
                    className="absolute bottom-0 left-3 top-7 border-l border-border"
                  />
                ) : null}
                <StatusIcon
                  aria-hidden="true"
                  className={`absolute left-0.5 top-4 size-5 bg-background ${entry.applied ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"} ${entry.active ? "animate-spin motion-reduce:animate-none" : ""}`}
                />
                {entry.failed ? (
                  <div className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-3 pr-2">
                    {nodeSummary}
                  </div>
                ) : (
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={detailId}
                    className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg py-3 pr-2 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      setExpandedEntryId(expanded ? null : entry.id);
                      setSelectedRunId(expanded ? null : entry.run.requestId);
                      setVisitedEntries((current) => new Set([...current, entry.id]));
                    }}
                  >
                    {nodeSummary}
                  </button>
                )}

                <div id={detailId}>
                  <DisclosureRegion open={expanded}>
                    {entry.failed || visitedEntries.has(entry.id) ? (
                      <div className="min-w-0 space-y-3 pb-5">
                        {expanded && !entry.failed && selectedRunQuery.isError ? (
                          <p role="alert" className="text-ui-sm text-destructive">
                            请求详情不可用：{errorText(selectedRunQuery.error)}
                          </p>
                        ) : null}
                        {entry.opportunity ? (
                          (() => {
                            const opportunity =
                              selectedRun.opportunities?.find(
                                (item) => item.opportunityId === entry.opportunity?.opportunityId,
                              ) ?? entry.opportunity;
                            const latestGeneration = latestOpportunityGeneration(
                              runs,
                              selectedRun.requestId,
                              opportunity.opportunityId,
                            );
                            const generationBlockReason = generationBlockReasonFor(opportunity);
                            const generationError = generationErrors[opportunity.opportunityId];
                            const failureReason =
                              generationError &&
                              generationError.previousRequestId ===
                                (latestGeneration?.requestId ?? null)
                                ? generationError.reason
                                : undefined;
                            return (
                              <div className="min-w-0 pr-2">
                                <OpportunityCard
                                  generations={runs.filter(
                                    (run) =>
                                      run.discoveryRequestId === selectedRun.requestId &&
                                      run.opportunityId === opportunity.opportunityId,
                                  )}
                                  opportunity={opportunity}
                                  {...(failureReason ? { failureReason } : {})}
                                  {...(latestGeneration ? { latestGeneration } : {})}
                                  {...(generationBlockReason ? { generationBlockReason } : {})}
                                  expertArchived={expertArchived}
                                  busy={working}
                                  feedback={
                                    feedbackDrafts[opportunity.opportunityId] ??
                                    latestGeneration?.feedback ??
                                    ""
                                  }
                                  onFeedbackChange={(value) =>
                                    setFeedbackDrafts((current) => ({
                                      ...current,
                                      [opportunity.opportunityId]: value,
                                    }))
                                  }
                                  onGenerate={() =>
                                    void generateOpportunity(selectedRun, opportunity).catch(
                                      () => {},
                                    )
                                  }
                                  onDismiss={() =>
                                    void dismissOpportunity(selectedRun, opportunity).catch(
                                      () => {},
                                    )
                                  }
                                  {...(onOpenAbilities ? { onOpenAbilities } : {})}
                                  ownerName={expertNameById.get(expertId) ?? expertName}
                                  onEdit={performProposalEdit}
                                  onApply={performApply}
                                  onViewResult={viewResult}
                                  onReject={performReject}
                                  {...(onOpenTask ? { onOpenTask } : {})}
                                />
                              </div>
                            );
                          })()
                        ) : selectedRun.status === "failed" ? (
                          <ExtractionFailure
                            reason={selectedRun.error ?? selectedRun.summary ?? "未能完成提取。"}
                          />
                        ) : (
                          <div className="space-y-3 rounded-xl border border-border p-4">
                            <h3 className="text-ui font-medium">
                              {skillEvolutionRunPresentation(selectedRun).label}
                            </h3>
                            {skillEvolutionRunPresentation(selectedRun).detail ? (
                              <p role="status" className="text-ui-sm text-muted-foreground">
                                {skillEvolutionRunPresentation(selectedRun).detail}
                              </p>
                            ) : null}
                            {selectedRun.summary &&
                            !skillEvolutionRunPresentation(selectedRun).detail ? (
                              <p className="break-words text-ui-sm text-muted-foreground">
                                {selectedRun.summary}
                              </p>
                            ) : null}
                            {selectedRun.error ? (
                              <p role="alert" className="break-words text-ui-sm text-destructive">
                                {selectedRun.error}
                              </p>
                            ) : null}
                            {selectedRun.status === "no_change" ? (
                              <p role="status" className="text-ui-sm text-muted-foreground">
                                {selectedRun.stage === "generation"
                                  ? "此次生成没有形成可采用的 Skill。正式 Skill、修订和绑定不变。"
                                  : "没有发现值得提炼的可复用经验。正式 Skill、修订和绑定不变。"}
                              </p>
                            ) : null}
                            {selectedRun.status === "insufficient_evidence" ? (
                              <p role="status" className="text-ui-sm text-muted-foreground">
                                证据不足：当前来源无法支撑可复用结论。你可以补充来源后再次主动提炼。
                              </p>
                            ) : null}
                            {selectedRun.stage !== "discovery"
                              ? selectedRun.proposals.map((proposal) => (
                                  <ProposalCard
                                    key={proposal.proposalId}
                                    proposal={proposal}
                                    expertArchived={expertArchived}
                                    readOnly={Boolean(readOnlyReason)}
                                    {...(readOnlyReason ? { readOnlyReason } : {})}
                                    ownerName={
                                      expertNameById.get(proposal.expertId) ?? proposal.expertId
                                    }
                                    busy={working}
                                    onEdit={performProposalEdit}
                                    onApply={performApply}
                                    onViewResult={viewResult}
                                    onReject={performReject}
                                    {...(onOpenTask ? { onOpenTask } : {})}
                                  />
                                ))
                              : null}
                          </div>
                        )}
                      </div>
                    ) : null}
                  </DisclosureRegion>
                </div>
              </li>
            );
          })}
        </ol>
        {hiddenCount > 0 || historyOpen ? (
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((open) => !open)}
          >
            {historyOpen ? "收起历史记录" : `查看全部提炼记录（另 ${hiddenCount} 条）`}
            <DisclosureChevron open={historyOpen} />
          </Button>
        ) : null}
      </section>

      <DisclosureRegion open={graphOpen}>
        <section className="min-w-0 space-y-4" aria-label="进化星图与版本详情">
          <EvolutionGraphView
            expertId={expertId}
            expertNameById={expertNameById}
            active={active && graphOpen}
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
              {(currentGraph?.events ?? []).filter(
                (event) => event.skillId === selectedNode.skillId,
              ).length ? (
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
                    .map((evidence, evidenceIndex) => (
                      <blockquote
                        key={`${evidence.threadId}:${evidence.messageId}:${evidenceIndex}`}
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
                      恢复为新修订
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => restorePreviewMutation.reset()}
                    >
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
                      绑定。专用副本会保留，其他绑定的启用状态与“允许复制并改进”权限均按预览保留；不会恢复内容。
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
                              {binding.allowEvolution === true ? "允许复制并改进" : "仅使用"}
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
      </DisclosureRegion>

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
