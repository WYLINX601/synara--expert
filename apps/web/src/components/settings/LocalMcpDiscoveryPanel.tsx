import type { McpDiscoveryCandidate, McpDiscoveryResult, McpImportResult } from "@synara/contracts";
import { useEffect, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { toastManager } from "~/components/ui/toast";
import { ensureExpertClient } from "~/workbench/host/expertClient";

import { SettingsCard, SettingsEmptyState, SettingsSectionShell } from "./SettingsPanelPrimitives";

type ImportMode = "create" | "update";
type Selection = { mode: ImportMode; targetId: string; expectedRevision?: number };
const EMPTY_CANDIDATES: ReadonlyArray<McpDiscoveryCandidate> = [];
const SOURCE_LABELS: Record<McpDiscoveryCandidate["sourceKind"], string> = {
  codex: "Codex",
  "cc-switch": "CC Switch",
  json: "JSON",
};

export interface LocalMcpDiscoveryPanelProps {
  onBack: () => void;
  onImported: () => Promise<void>;
}

function statusLabel(candidate: McpDiscoveryCandidate): string {
  return {
    ready: "可导入",
    exists: "已存在",
    conflict: "配置冲突",
    "needs-config": "需要配置",
    unsupported: "暂不支持",
  }[candidate.status];
}

function sourceLabel(candidate: McpDiscoveryCandidate): string {
  const kinds = candidate.sources?.length
    ? candidate.sources.map((source) => source.kind)
    : [candidate.sourceKind];
  return [...new Set(kinds)].map((kind) => SOURCE_LABELS[kind]).join(" · ");
}

export function LocalMcpDiscoveryPanel({ onBack, onImported }: LocalMcpDiscoveryPanelProps) {
  const [step, setStep] = useState<"results" | "outcome">("results");
  const [result, setResult] = useState<McpDiscoveryResult | null>(null);
  const [selection, setSelection] = useState<Record<string, Selection>>({});
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<McpImportResult | null>(null);

  const scan = async () => {
    setPending(true);
    setError(null);
    try {
      const next = await ensureExpertClient().discoverMcpConnections({});
      setResult(next);
      setSelection({});
      setStep("results");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法扫描本机 MCP 配置。");
    } finally {
      setPending(false);
    }
  };

  useEffect(() => {
    void scan();
  }, []);

  const candidates = result?.candidates ?? EMPTY_CANDIDATES;
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return candidates.filter((candidate) => {
      return (
        !query ||
        `${candidate.name} ${candidate.summary} ${sourceLabel(candidate)}`
          .toLowerCase()
          .includes(query)
      );
    });
  }, [candidates, search]);
  const selectedItems = Object.entries(selection);
  const counts = candidates.reduce(
    (summary, candidate) => {
      const chosen = selection[candidate.candidateId];
      if (chosen?.mode === "update") summary.update += 1;
      else if (chosen?.mode === "create") summary.create += 1;
      else summary.skip += 1;
      if (candidate.status === "needs-config" || candidate.status === "unsupported")
        summary.blocked += 1;
      return summary;
    },
    { create: 0, update: 0, skip: 0, blocked: 0 },
  );

  const choose = (candidate: McpDiscoveryCandidate, checked: boolean) => {
    setSelection((current) => {
      const next = { ...current };
      if (checked)
        next[candidate.candidateId] = { mode: "create", targetId: candidate.suggestedId };
      else delete next[candidate.candidateId];
      return next;
    });
  };
  const chooseConflict = (candidate: McpDiscoveryCandidate, mode: "skip" | ImportMode) => {
    setSelection((current) => {
      const next = { ...current };
      if (mode === "skip") delete next[candidate.candidateId];
      else {
        next[candidate.candidateId] = {
          mode,
          targetId:
            mode === "update"
              ? (candidate.existingId ?? candidate.suggestedId)
              : candidate.suggestedId,
          ...(mode === "update" && candidate.existingRevision !== undefined
            ? { expectedRevision: candidate.existingRevision }
            : {}),
        };
      }
      return next;
    });
  };
  const importSelected = async () => {
    if (!result || !selectedItems.length) return;
    setPending(true);
    setImporting(true);
    setError(null);
    try {
      const imported = await ensureExpertClient().importMcpConnections({
        scanId: result.scanId,
        items: selectedItems.map(([candidateId, item]) => ({ candidateId, ...item })),
      });
      setImportResult(imported);
      setStep("outcome");
      await onImported();
      toastManager.add({ type: "success", title: "MCP 导入结果已更新" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导入 MCP 连接失败。");
    } finally {
      setPending(false);
      setImporting(false);
    }
  };

  return (
    <SettingsSectionShell title="从本机发现">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button size="sm" variant="ghost" onClick={onBack} disabled={pending}>
            ← 返回连接列表
          </Button>
          <div className="text-ui-sm text-muted-foreground" aria-label="发现流程">
            <span className={step === "results" ? "font-medium text-foreground" : undefined}>
              1 发现结果
            </span>
            <span className="px-2">→</span>
            <span className={step === "outcome" ? "font-medium text-foreground" : undefined}>
              2 导入结果
            </span>
          </div>
        </div>
        {error ? (
          <p className="text-ui-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {step === "results" ? (
          <SettingsCard className="overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
              <Input
                aria-label="搜索发现结果"
                placeholder="搜索名称或摘要"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="min-w-48 flex-1"
              />
              <Button size="sm" variant="outline" onClick={() => void scan()} disabled={pending}>
                {pending && !importing ? "扫描中…" : "重新扫描"}
              </Button>
            </div>
            {pending && !result ? (
              <SettingsEmptyState layout="status">正在扫描本机配置…</SettingsEmptyState>
            ) : null}
            {!pending && result && !filtered.length ? (
              <SettingsEmptyState layout="status">没有符合条件的发现结果。</SettingsEmptyState>
            ) : null}
            {filtered.length ? (
              <div className="divide-y divide-border">
                {filtered.map((candidate) => {
                  const chosen = selection[candidate.candidateId];
                  const disabled =
                    candidate.status === "exists" ||
                    candidate.status === "needs-config" ||
                    candidate.status === "unsupported";
                  const source = sourceLabel(candidate);
                  const enabled =
                    candidate.sourceEnabled !== undefined
                      ? ` · 来源中${candidate.sourceEnabled ? "启用" : "停用"}`
                      : "";
                  return (
                    <div
                      key={candidate.candidateId}
                      className="grid gap-3 p-3 md:grid-cols-[auto_minmax(0,1.5fr)_minmax(7rem,.7fr)_minmax(8rem,.9fr)] md:items-center"
                    >
                      <Checkbox
                        aria-label={`选择 ${candidate.name}`}
                        checked={Boolean(chosen)}
                        disabled={disabled || pending}
                        onCheckedChange={(checked) => choose(candidate, checked)}
                      />
                      <div className="min-w-0">
                        <div className="truncate text-ui font-medium">{candidate.name}</div>
                        <div className="truncate text-ui-xs text-muted-foreground">
                          {source} · {candidate.summary}
                          {enabled}
                        </div>
                      </div>
                      <span className="text-ui-sm text-muted-foreground">{candidate.protocol}</span>
                      <div className="flex items-center gap-2 text-ui-sm">
                        <span>{statusLabel(candidate)}</span>
                        {candidate.status === "conflict" ? (
                          <select
                            aria-label={`处理 ${candidate.name} 冲突`}
                            className="rounded border border-border bg-background px-2 py-1 text-ui-xs"
                            value={chosen?.mode ?? "skip"}
                            disabled={pending}
                            onChange={(event) =>
                              chooseConflict(candidate, event.target.value as "skip" | ImportMode)
                            }
                          >
                            <option value="skip">跳过</option>
                            <option value="create">另建 ID</option>
                            <option value="update">更新现有</option>
                          </select>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border p-3">
              <span className="text-ui-sm text-muted-foreground">
                新增 {counts.create} · 更新 {counts.update} · 跳过 {counts.skip} · 不可导入{" "}
                {counts.blocked}
              </span>
              <Button
                size="sm"
                disabled={!selectedItems.length || pending}
                onClick={() => void importSelected()}
              >
                {importing ? "导入中…" : `导入所选（${selectedItems.length}）`}
              </Button>
            </div>
          </SettingsCard>
        ) : null}
        {step === "outcome" ? (
          <SettingsCard className="space-y-3 p-4">
            <h3 className="text-ui-lg font-medium">导入结果</h3>
            <p className="text-ui-sm text-muted-foreground">
              结果按条目显示；失败项可以重新扫描后重试。
            </p>
            <div className="divide-y divide-border border-y border-border">
              {(importResult?.items ?? []).map((item) => (
                <div
                  key={`${item.candidateId}:${item.targetId}`}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 text-ui-sm"
                >
                  <span>{item.targetId}</span>
                  <span
                    className={
                      item.status === "failed" ? "text-destructive" : "text-muted-foreground"
                    }
                  >
                    {item.status === "imported"
                      ? "已导入"
                      : item.status === "skipped"
                        ? "已跳过"
                        : (item.message ?? "导入失败")}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setStep("results")}>
                返回结果
              </Button>
              <Button size="sm" onClick={onBack} disabled={pending}>
                返回连接列表
              </Button>
            </div>
          </SettingsCard>
        ) : null}
      </div>
    </SettingsSectionShell>
  );
}
