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
import { useTranslation } from "~/i18n";

export function SuiteCatalog({
  onUseExpert,
}: {
  onUseExpert?: (selection: ExpertDraftSelection) => Promise<void>;
}) {
  const { t } = useTranslation();
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
        setStorageError(t("settings:suiteRecoveryClearFailed", { detail: suiteErrorText(cause) }));
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
      setStorageError(t("settings:suiteRestoreRecordFailed", { detail: suiteErrorText(cause) }));
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
      setError(t("settings:suiteSaveRecoveryFailed", { detail: suiteErrorText(cause) }));
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
      setError(t("settings:suiteConfirmSavedUnknown", { detail: suiteErrorText(cause) }));
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
      if (client !== ensureExpertClient()) throw new Error(t("settings:suiteConnectionChanged"));
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
    <section className="space-y-4 text-ui" aria-label={t("settings:suiteCatalogAria")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">{t("common:suiteTerm")}</h2>
        <Button
          ref={importButtonRef}
          disabled={Boolean(storageError)}
          onClick={() => {
            setOpen(true);
            if (operationRef.current) void reconcile();
          }}
        >
          {operation ? t("settings:suiteConfirmResult") : t("settings:suiteImport")}
        </Button>
      </div>
      {storageError ? (
        <p role="alert" className="text-destructive">
          {storageError}
        </p>
      ) : null}
      {receipt?.state === "committed" ? (
        <p role="status">
          {receipt.reused ? t("settings:suiteOpenedExisting") : t("settings:suiteImported")}
        </p>
      ) : null}
      {suites.isPending ? (
        <p role="status">{t("chat:suiteLoading")}</p>
      ) : suites.isError ? (
        <div role="alert">
          <p>{suiteErrorText(suites.error)}</p>
          <Button variant="outline" onClick={() => void suites.refetch()}>
            {t("common:common_retry")}
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
        <p className="text-muted-foreground">{t("settings:suiteEmpty")}</p>
      )}
      <Dialog
        open={selected !== null}
        onOpenChange={(next) => {
          if (!next) setSelected(null);
        }}
      >
        <DialogPopup finalFocus={selectionReturnFocus}>
          <DialogHeader>
            <DialogTitle>{selectedSuite.data?.name ?? t("common:suiteTerm")}</DialogTitle>
            <DialogDescription>{t("settings:suitePreviewMembers")}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {selectedSuite.data ? (
              <SuiteSummary suite={selectedSuite.data} {...(onUseExpert ? { onUseExpert } : {})} />
            ) : selectedSuite.isError ? (
              <div role="alert">
                <p>{suiteErrorText(selectedSuite.error)}</p>
                <Button variant="outline" onClick={() => void selectedSuite.refetch()}>
                  {t("common:common_retry")}
                </Button>
              </div>
            ) : (
              <p role="status">{t("chat:suiteLoading")}</p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelected(null)}>
              {t("common:app_close")}
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
            <DialogTitle>{t("settings:suiteImport")}</DialogTitle>
            <DialogDescription>
              {saving
                ? t("settings:suiteSaving")
                : operation
                  ? t("settings:suiteConfirmExisting")
                  : t("settings:suiteReadStructure")}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            {operation ? (
              <div className="space-y-3" role="status">
                <p>
                  {receipt?.state === "failed"
                    ? t("settings:suiteImportIncomplete")
                    : t("settings:suiteConfirming")}
                </p>
                <p className="break-all text-ui-sm text-muted-foreground">
                  {operation.operationId}
                </p>
                {receipt?.state === "failed" ? (
                  <p>{receipt.issue.message}</p>
                ) : (
                  <p className="text-ui-sm text-muted-foreground">
                    {t("settings:suiteOutcomeUnknown")}
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
                  ariaLabel={t("settings:suiteSourceChannelAria")}
                  options={[
                    { value: "github", label: "GitHub" },
                    { value: "local-folder", label: t("settings:suiteLocalFolder") },
                  ]}
                />
                {!preview ? (
                  <div className="space-y-2">
                    <label className="block" htmlFor="suite-source">
                      {channel === "github"
                        ? t("settings:suiteSourceLabelGithub")
                        : t("settings:suiteSourceLabelFolder")}
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
                        channel === "github"
                          ? "https://github.com/org/suite"
                          : t("settings:suiteSourcePlaceholderFolder")
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
                          {t("settings:suiteChooseFolder")}
                        </Button>
                        <p className="text-ui-sm text-muted-foreground">
                          {t("settings:suiteFolderHint")}
                        </p>
                      </>
                    ) : null}
                    {reading ? <p role="status">{t("settings:suiteReadingSource")}</p> : null}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <h3 className="font-medium">{preview.name}</h3>
                    <p className="whitespace-pre-wrap">{preview.description}</p>
                    <SuiteDisclosure label={t("settings:suiteSourceBaseline")}>
                      <p className="break-all text-ui-sm">
                        {preview.source.kind === "github"
                          ? `${preview.source.repository}/${preview.source.subdirectory} · ${preview.source.resolvedCommit}`
                          : t("settings:suiteLocalFolder")}
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
                    <SuiteDisclosure
                      label={t("settings:suiteContentsAria", {
                        count: preview.resourceKeys.length,
                      })}
                    >
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
                        {t("settings:suiteViewIssues", { count: preview.issues.length })}
                      </Button>
                    ) : null}
                    {identical ? (
                      <p>{t("settings:suiteIdentical")}</p>
                    ) : existing.length ? (
                      <div className="space-y-1 text-ui-sm">
                        <p>{t("settings:suiteExistingVersions")}</p>
                        {existing.map((suite) => (
                          <p key={suite.ref.suiteId} className="break-all">
                            {t("settings:suiteExistingLabel")}
                            {suite.source.kind === "github"
                              ? `${suite.source.resolvedCommit} · `
                              : ""}
                            {suite.source.contentHash}
                          </p>
                        ))}
                        <p className="break-all">
                          {t("settings:suiteThisImportLabel")}
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
              {operation ? t("settings:suiteBackToCatalog") : t("common:form_cancel")}
            </Button>
            {operation ? (
              <>
                <Button disabled={saving} onClick={() => void reconcile()}>
                  {saving ? t("settings:suiteConfirming") : t("settings:suiteRetryConfirm")}
                </Button>
                {receipt?.state === "failed" ? (
                  <Button variant="outline" onClick={returnToPreview}>
                    {t("settings:suiteBackToPreview")}
                  </Button>
                ) : confirmedAbsent ? (
                  <Button variant="outline" disabled={saving} onClick={resendOriginal}>
                    {t("settings:suiteResendOriginal")}
                  </Button>
                ) : null}
              </>
            ) : preview ? (
              <>
                <Button variant="outline" onClick={clearPreview}>
                  {t("settings:suiteBackToSource")}
                </Button>
                {identical ? (
                  <Button
                    onClick={() => {
                      selectionReturnFocus.current = importButtonRef.current;
                      setSelected(identical.ref);
                      close();
                    }}
                  >
                    {t("settings:suiteOpenExisting")}
                  </Button>
                ) : (
                  <Button disabled={denied || reading} onClick={() => void submit()}>
                    {existing.length
                      ? t("settings:suiteImportAsNew")
                      : t("settings:suiteImportShort")}
                  </Button>
                )}
              </>
            ) : (
              <Button
                disabled={reading || !(channel === "github" ? github.trim() : folder.trim())}
                onClick={() => void readSource()}
              >
                {t("settings:suiteReadSource")}
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
