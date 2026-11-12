import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type SuiteImportRequest,
  type ExpertDraftSelection,
  type SuiteComposition,
  type SuiteImportReceipt,
  type SuitePreview,
  type SuiteRef,
} from "@synara/contracts";
import { ensureExpertClient } from "~/workbench/host/expertClient";
import { ensureNativeApi } from "~/nativeApi";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { SettingsSegmentedControl } from "./SettingControls";
import { SuiteSummary, suiteErrorText } from "./SuiteSummary";
import { EXPERTS_QUERY_KEY, SUITES_QUERY_KEY, suiteQueryKey } from "./expertSettingsQueries";

import {
  readSuiteImportJournal,
  writeSuiteImportJournal,
  clearSuiteImportJournal,
} from "./suiteImportJournal";
import { SuiteDisclosure } from "./SuiteDisclosure";
import { SuiteIssuesDialog } from "./SuiteIssuesDialog";

export function SuiteCatalog({
  onUseExpert,
}: {
  onUseExpert?: (selection: ExpertDraftSelection) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const suites = useQuery({
    queryKey: SUITES_QUERY_KEY,
    queryFn: () => ensureExpertClient().listSuites(),
  });
  const [selected, setSelected] = useState<SuiteRef | null>(null);
  const selectedSuite = useQuery({
    queryKey: suiteQueryKey(selected),
    queryFn: () => ensureExpertClient().readSuite(selected!),
    enabled: selected !== null,
  });
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<"github" | "local-folder">("github");
  const [github, setGithub] = useState("");
  const [folder, setFolder] = useState("");
  const [preview, setPreview] = useState<SuitePreview | null>(null);
  const previewRef = useRef<SuitePreview | null>(null);
  const requestId = useRef<string | null>(null);
  const sourceGeneration = useRef(0);
  const importButtonRef = useRef<HTMLButtonElement | null>(null);
  const selectionReturnFocus = useRef<HTMLElement | null>(null);
  const issuesButtonRef = useRef<HTMLButtonElement | null>(null);
  const [reading, setReading] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<ReadonlyArray<SuiteComposition>>([]);
  const [operation, setOperation] = useState<SuiteImportRequest | null>(null);
  const operationRef = useRef<SuiteImportRequest | null>(null);
  const [receipt, setReceipt] = useState<SuiteImportReceipt | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmedAbsent, setConfirmedAbsent] = useState(false);
  const inFlight = useRef(false);
  const [storageError, setStorageError] = useState<string | null>(null);

  const acceptReceipt = (result: SuiteImportReceipt | null) => {
    setReceipt(result);
    setConfirmedAbsent(result === null);
    if (result?.state === "committed") {
      try {
        clearSuiteImportJournal();
      } catch (cause) {
        setStorageError(`导入已完成，但无法清除本地恢复记录：${suiteErrorText(cause)}`);
      }
      operationRef.current = null;
      setOperation(null);
      selectionReturnFocus.current = importButtonRef.current;
      setSelected(result.suite);
      setOpen(false);
      setPreview(null);
      previewRef.current = null;
      void queryClient.invalidateQueries({ queryKey: SUITES_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: EXPERTS_QUERY_KEY });
    } else if (result?.state === "failed") {
      setError(result.issue.message);
    }
  };
  const reconcile = async (accepted = operationRef.current) => {
    if (!accepted || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      acceptReceipt(
        await ensureExpertClient().getSuiteImportReceipt({ operationId: accepted.operationId }),
      );
    } catch (cause) {
      setError(suiteErrorText(cause));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  useEffect(() => {
    try {
      const journal = readSuiteImportJournal();
      if (journal) {
        operationRef.current = journal.request;
        setOperation(journal.request);
        previewRef.current = journal.preview;
        setPreview(journal.preview);
        setGithub(journal.github);
        setFolder(journal.folder);
        setChannel(journal.channel);
        void reconcile(journal.request);
      }
    } catch (cause) {
      setStorageError(`无法恢复导入记录：${suiteErrorText(cause)}`);
    }
    return () => {
      requestId.current = null;
      if (previewRef.current && !operationRef.current)
        void ensureExpertClient()
          .cancelSuitePreview({ previewId: previewRef.current.previewId })
          .catch(() => undefined);
    };
  }, []);
  const clearPreview = () => {
    requestId.current = null;
    setReading(false);
    sourceGeneration.current += 1;
    setIssuesOpen(false);
    const previous = previewRef.current;
    previewRef.current = null;
    setPreview(null);
    setExisting([]);
    setError(null);
    if (previous && !operationRef.current)
      void ensureExpertClient()
        .cancelSuitePreview({ previewId: previous.previewId })
        .catch(() => undefined);
  };
  const close = () => {
    if (saving) return;
    if (!operationRef.current) clearPreview();
    setOpen(false);
  };
  const readSource = async () => {
    if (operationRef.current) return;
    clearPreview();
    const id = crypto.randomUUID();
    requestId.current = id;
    setReading(true);
    const client = ensureExpertClient();
    try {
      setReceipt(null);
      setConfirmedAbsent(false);
      const result = await client.previewSuite({
        requestId: id,
        source:
          channel === "github"
            ? { kind: "github", url: github.trim() }
            : { kind: "local-folder", path: folder.trim() },
      });
      if (requestId.current !== id || result.requestId !== id || client !== ensureExpertClient()) {
        void client.cancelSuitePreview({ previewId: result.previewId }).catch(() => undefined);
        return;
      }
      previewRef.current = result;
      const catalog = await client.listSuites();
      const records = await Promise.all(catalog.map((entry) => client.readSuite(entry.ref)));
      if (requestId.current !== id || client !== ensureExpertClient()) {
        void client.cancelSuitePreview({ previewId: result.previewId }).catch(() => undefined);
        return;
      }
      previewRef.current = result;
      setPreview(result);
      setExisting(
        records.filter(
          (suite) =>
            suite.source.kind === result.source.kind &&
            suite.source.sourceId === result.source.sourceId,
        ),
      );
      setIssuesOpen(result.issues.length > 0);
    } catch (cause) {
      if (requestId.current === id) setError(suiteErrorText(cause));
    } finally {
      if (requestId.current === id) setReading(false);
    }
  };
  const submit = async () => {
    if (!preview || reading || denied || inFlight.current || operationRef.current) return;
    const accepted: SuiteImportRequest = {
      operationId: crypto.randomUUID(),
      previewId: preview.previewId,
      contentHash: preview.contentHash,
      mode: existing.length ? "independent-new-content" : "reuse-or-create",
    };
    try {
      writeSuiteImportJournal({ request: accepted, preview, github, folder, channel });
    } catch (cause) {
      setError(`无法保存恢复记录，尚未提交：${suiteErrorText(cause)}`);
      return;
    }
    operationRef.current = accepted;
    setOperation(accepted);
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      acceptReceipt(await ensureExpertClient().commitSuiteImport(accepted));
    } catch (cause) {
      setError(`暂时无法确认是否已保存：${suiteErrorText(cause)}`);
      try {
        acceptReceipt(
          await ensureExpertClient().getSuiteImportReceipt({ operationId: accepted.operationId }),
        );
      } catch {
        /* Keep the exact request until the original receipt is reachable. */
      }
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  const returnToPreview = async () => {
    if (inFlight.current || !preview) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    const client = ensureExpertClient();
    try {
      const catalog = await client.listSuites();
      const records = await Promise.all(catalog.map((entry) => client.readSuite(entry.ref)));
      if (client !== ensureExpertClient()) throw new Error("连接已改变，请重新确认原导入结果。");
      setExisting(
        records.filter(
          (suite) =>
            suite.source.kind === preview.source.kind &&
            suite.source.sourceId === preview.source.sourceId,
        ),
      );
      clearSuiteImportJournal();
      operationRef.current = null;
      setOperation(null);
      setReceipt(null);
      setConfirmedAbsent(false);
    } catch (cause) {
      setError(suiteErrorText(cause));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  const resendOriginal = () => {
    const accepted = operationRef.current;
    if (!confirmedAbsent || !accepted || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setConfirmedAbsent(false);
    void ensureExpertClient()
      .commitSuiteImport(accepted)
      .then(acceptReceipt)
      .catch((cause: unknown) => setError(suiteErrorText(cause)))
      .finally(() => {
        inFlight.current = false;
        setSaving(false);
      });
  };
  const identical = preview
    ? existing.find(
        (suite) =>
          suite.source.contentHash === preview.contentHash &&
          suite.adapterId === preview.adapterId &&
          suite.adapterVersion === preview.adapterVersion,
      )
    : undefined;
  const denied = preview?.issues.some(
    (issue) =>
      (issue.action === "commit" || issue.action === "preview") && issue.effect === "deny-action",
  );
  return (
    <section className="space-y-4 text-ui" aria-label="Suite 目录">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">Suite</h2>
        <Button
          ref={importButtonRef}
          disabled={Boolean(storageError)}
          onClick={() => {
            setOpen(true);
            if (operationRef.current) void reconcile();
          }}
        >
          {operation ? "确认导入结果" : "导入 Suite"}
        </Button>
      </div>
      {storageError ? (
        <p role="alert" className="text-destructive">
          {storageError}
        </p>
      ) : null}
      {receipt?.state === "committed" ? (
        <p role="status">{receipt.reused ? "已打开已有套件。" : "Suite 已导入。"}</p>
      ) : null}
      {suites.isPending ? (
        <p role="status">正在读取 Suite…</p>
      ) : suites.isError ? (
        <div role="alert">
          <p>{suiteErrorText(suites.error)}</p>
          <Button variant="outline" onClick={() => void suites.refetch()}>
            重试
          </Button>
        </div>
      ) : suites.data?.length ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {suites.data.map((suite) => (
            <li key={`${suite.ref.suiteId}:${suite.ref.revision}`}>
              <button
                type="button"
                className="w-full p-3 text-start hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={(event) => {
                  selectionReturnFocus.current = event.currentTarget;
                  setSelected(suite.ref);
                }}
              >
                <span className="font-medium">{suite.name}</span>
                <p className="text-ui-sm text-muted-foreground">{suite.description}</p>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">尚无 Suite，可从 GitHub 或本地文件夹导入。</p>
      )}
      <Dialog
        open={selected !== null}
        onOpenChange={(next) => {
          if (!next) setSelected(null);
        }}
      >
        <DialogPopup finalFocus={selectionReturnFocus}>
          <DialogHeader>
            <DialogTitle>{selectedSuite.data?.name ?? "Suite"}</DialogTitle>
            <DialogDescription>用途与成员预览</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {selectedSuite.data ? (
              <SuiteSummary suite={selectedSuite.data} {...(onUseExpert ? { onUseExpert } : {})} />
            ) : selectedSuite.isError ? (
              <div role="alert">
                <p>{suiteErrorText(selectedSuite.error)}</p>
                <Button variant="outline" onClick={() => void selectedSuite.refetch()}>
                  重试
                </Button>
              </div>
            ) : (
              <p role="status">正在读取 Suite…</p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelected(null)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <DialogPopup finalFocus={importButtonRef} showCloseButton={!saving}>
          <DialogHeader>
            <DialogTitle>导入 Suite</DialogTitle>
            <DialogDescription>
              {saving
                ? "正在保存，请勿重复提交。"
                : operation
                  ? "按原提交记录确认结果，不会创建第二次导入。"
                  : "读取支持的套件结构，不执行来源脚本或授予权限。"}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            {operation ? (
              <div className="space-y-3" role="status">
                <p>{receipt?.state === "failed" ? "此次导入未完成" : "正在确认导入结果…"}</p>
                <p className="break-all text-ui-sm text-muted-foreground">
                  {operation.operationId}
                </p>
                {receipt?.state === "failed" ? (
                  <p>{receipt.issue.message}</p>
                ) : (
                  <p className="text-ui-sm text-muted-foreground">
                    连接中断或结果未知不代表已取消。返回目录后仍保留本次记录。
                  </p>
                )}
              </div>
            ) : (
              <>
                <SettingsSegmentedControl
                  value={channel}
                  onValueChange={(value) => {
                    clearPreview();
                    setChannel(value);
                  }}
                  ariaLabel="Suite 来源渠道"
                  options={[
                    { value: "github", label: "GitHub" },
                    { value: "local-folder", label: "本地文件夹" },
                  ]}
                />
                {!preview ? (
                  <div className="space-y-2">
                    <label className="block" htmlFor="suite-source">
                      {channel === "github" ? "仓库或目录链接" : "服务端可访问的套件文件夹"}
                    </label>
                    <Input
                      id="suite-source"
                      value={channel === "github" ? github : folder}
                      onChange={(event) => {
                        clearPreview();
                        if (channel === "github") setGithub(event.target.value);
                        else setFolder(event.target.value);
                      }}
                      placeholder={
                        channel === "github" ? "https://github.com/org/suite" : "套件文件夹绝对路径"
                      }
                    />
                    {channel === "local-folder" ? (
                      <>
                        <Button
                          variant="outline"
                          onClick={() => {
                            const generation = sourceGeneration.current;
                            void ensureNativeApi()
                              .dialogs.pickFolder()
                              .then((path) => {
                                if (
                                  path &&
                                  !operationRef.current &&
                                  sourceGeneration.current === generation
                                ) {
                                  clearPreview();
                                  setFolder(path);
                                }
                              })
                              .catch((cause: unknown) => setError(suiteErrorText(cause)));
                          }}
                        >
                          选择文件夹
                        </Button>
                        <p className="text-ui-sm text-muted-foreground">
                          文件夹必须可由当前服务端读取；浏览器不能上传或访问任意本机目录。
                        </p>
                      </>
                    ) : null}
                    {reading ? <p role="status">正在读取并识别来源…</p> : null}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <h3 className="font-medium">{preview.name}</h3>
                    <p className="whitespace-pre-wrap">{preview.description}</p>
                    <SuiteDisclosure label="来源与内容基线">
                      <p className="break-all text-ui-sm">
                        {preview.source.kind === "github"
                          ? `${preview.source.repository}/${preview.source.subdirectory} · ${preview.source.resolvedCommit}`
                          : "本地文件夹"}
                      </p>
                      <p className="break-all text-ui-sm">{preview.contentHash}</p>
                    </SuiteDisclosure>
                    <ul className="divide-y divide-border">
                      {preview.members.map((member) => (
                        <li key={member.key} className="py-2">
                          <SuiteDisclosure
                            label={<span className="font-medium">{member.name}</span>}
                          >
                            <p className="whitespace-pre-wrap text-ui-sm">{member.description}</p>
                          </SuiteDisclosure>
                        </li>
                      ))}
                    </ul>
                    <SuiteDisclosure label={`能力与包含内容（${preview.resourceKeys.length}）`}>
                      <ul className="text-ui-sm">
                        {preview.resourceKeys.map((key) => (
                          <li key={key}>{key}</li>
                        ))}
                      </ul>
                    </SuiteDisclosure>
                    {preview.issues.length ? (
                      <Button
                        ref={issuesButtonRef}
                        variant="outline"
                        onClick={() => setIssuesOpen(true)}
                      >
                        查看识别问题（{preview.issues.length}）
                      </Button>
                    ) : null}
                    {identical ? (
                      <p>此来源与内容已导入。</p>
                    ) : existing.length ? (
                      <div className="space-y-1 text-ui-sm">
                        <p>
                          此来源已有其他版本。新套件独立保存，原套件、Expert 和已有任务保持不变。
                        </p>
                        {existing.map((suite) => (
                          <p key={suite.ref.suiteId} className="break-all">
                            已有：
                            {suite.source.kind === "github"
                              ? `${suite.source.resolvedCommit} · `
                              : ""}
                            {suite.source.contentHash}
                          </p>
                        ))}
                        <p className="break-all">
                          本次：
                          {preview.source.kind === "github"
                            ? `${preview.source.resolvedCommit} · `
                            : ""}
                          {preview.contentHash}
                        </p>
                      </div>
                    ) : null}
                  </div>
                )}
              </>
            )}
            {error ? (
              <p className="text-ui-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={close}>
              {operation ? "返回目录" : "取消"}
            </Button>
            {operation ? (
              <>
                <Button disabled={saving} onClick={() => void reconcile()}>
                  {saving ? "正在确认…" : "重试确认"}
                </Button>
                {receipt?.state === "failed" ? (
                  <Button variant="outline" onClick={returnToPreview}>
                    返回预览
                  </Button>
                ) : confirmedAbsent ? (
                  <Button variant="outline" disabled={saving} onClick={resendOriginal}>
                    重送原提交
                  </Button>
                ) : null}
              </>
            ) : preview ? (
              <>
                <Button variant="outline" onClick={clearPreview}>
                  返回来源
                </Button>
                {identical ? (
                  <Button
                    onClick={() => {
                      selectionReturnFocus.current = importButtonRef.current;
                      setSelected(identical.ref);
                      close();
                    }}
                  >
                    打开已有套件
                  </Button>
                ) : (
                  <Button disabled={denied || reading} onClick={() => void submit()}>
                    {existing.length ? "作为新套件导入" : "导入"}
                  </Button>
                )}
              </>
            ) : (
              <Button
                disabled={reading || !(channel === "github" ? github.trim() : folder.trim())}
                onClick={() => void readSource()}
              >
                读取来源
              </Button>
            )}
          </DialogFooter>
          <SuiteIssuesDialog
            finalFocus={issuesButtonRef}
            issues={preview?.issues ?? []}
            open={issuesOpen && open && !operation}
            onOpenChange={setIssuesOpen}
            onRetry={() => void readSource()}
          />
        </DialogPopup>
      </Dialog>
    </section>
  );
}
