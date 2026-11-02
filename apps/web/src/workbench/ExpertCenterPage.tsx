// Route-owned assembly keeps a single Expert editor alive across detail tabs.
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import type { ThreadId } from "@synara/contracts";
import { ExpertsSettingsPanel } from "~/components/settings/ExpertsSettingsPanel";
import { ExpertTaskHistory } from "~/components/settings/ExpertTaskHistory";
import { ExpertLearningControl } from "./features/expert-evolution/ExpertLearningControl";
import { ExpertSkillEvolution } from "./features/expert-evolution/ExpertSkillEvolution";
import { settingsSearchForMcpFromExpert } from "./host/settings";
import { useExpertTaskActions } from "./host/expertTaskActions";

export default function ExpertCenterPage() {
  const params = useParams({ strict: false });
  const search = useSearch({ from: "/_chat/experts" });
  const navigate = useNavigate();
  const actions = useExpertTaskActions(search.projectId, search.sourceThreadId);
  const [sourceSelection, setSourceSelection] = useState<{
    readonly expertId: string;
    readonly threadId: ThreadId;
    readonly requestKey: number;
  } | null>(null);
  const selectHistorySource = (expertId: string, threadId: ThreadId) => {
    setSourceSelection((current) => ({
      expertId,
      threadId,
      requestKey: (current?.requestKey ?? 0) + 1,
    }));
    void navigate({
      to: "/experts/$expertId",
      params: { expertId },
      search: { ...search, tab: "evolution" },
    });
  };
  return (
    <main className="h-full min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto flex min-h-full max-w-5xl flex-col">
        <ExpertsSettingsPanel
          centerRoute={{
            expertId: params.expertId ?? null,
            kind: params.expertId ? "experts" : (search.kind ?? "experts"),
            navigateKind: async (kind) => {
              const { kind: _previousKind, ...context } = search;
              await navigate({
                to: "/experts",
                search: {
                  ...context,
                  tab: "capabilities",
                  ...(kind !== "experts" ? { kind } : {}),
                },
              });
            },
            tab: search.tab,
            navigate: async (expertId, tab, replace) => {
              const { kind: _previousKind, ...context } = search;
              const nextSearch = { ...context, tab };
              if (expertId)
                await navigate({
                  to: "/experts/$expertId",
                  params: { expertId },
                  search: nextSearch,
                  ...(replace === undefined ? {} : { replace }),
                });
              else
                await navigate({
                  to: "/experts",
                  search: nextSearch,
                  ...(replace === undefined ? {} : { replace }),
                });
            },
          }}
          onUseExpert={actions.startExpertDraft}
          onOpenConnections={(expertId, connectionId) => {
            void navigate({
              to: "/settings",
              search: settingsSearchForMcpFromExpert({
                ...search,
                expertId,
                ...(connectionId ? { connectionId } : {}),
              }),
            });
          }}
          renderHistory={(expertId, canExtract) => (
            <ExpertTaskHistory
              expertId={expertId}
              onOpenThread={(threadId) => {
                void navigate({ to: "/$threadId", params: { threadId } });
              }}
              {...(canExtract
                ? {
                    onExtractFromThread: (threadId: ThreadId) =>
                      selectHistorySource(expertId, threadId),
                  }
                : {})}
            />
          )}
          renderLearning={(expert, active) => (
            <ExpertLearningControl
              expertId={expert.id}
              provider={expert.preferredProvider}
              active={active}
              disabled={expert.archived}
            />
          )}
          renderEvolution={(expert, active) => (
            <ExpertSkillEvolution
              key={expert.id}
              expertId={expert.id}
              expertName={expert.name}
              expertArchived={expert.archived}
              preferredProvider={expert.preferredProvider}
              active={active}
              initialThreadId={
                sourceSelection?.expertId === expert.id ? sourceSelection.threadId : null
              }
              {...(sourceSelection?.requestKey === undefined
                ? {}
                : { initialThreadRequestKey: sourceSelection.requestKey })}
              onOpenTask={(threadId) => {
                void navigate({ to: "/$threadId", params: { threadId } });
              }}
              onOpenAbilities={() => {
                void navigate({
                  to: "/experts/$expertId",
                  params: { expertId: expert.id },
                  search: { ...search, tab: "capabilities" },
                });
              }}
            />
          )}
        />
      </div>
      {actions.projectPicker}
    </main>
  );
}
