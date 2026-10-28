// Route-owned assembly keeps a single Expert editor alive across detail tabs.
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ExpertsSettingsPanel } from "~/components/settings/ExpertsSettingsPanel";
import { ExpertTaskHistory } from "~/components/settings/ExpertTaskHistory";
import { settingsSearchForMcpFromExpert } from "./host/settings";
import { useExpertTaskActions } from "./host/expertTaskActions";

export default function ExpertCenterPage() {
  const params = useParams({ strict: false });
  const search = useSearch({ from: "/_chat/experts" });
  const navigate = useNavigate();
  const actions = useExpertTaskActions(search.projectId, search.sourceThreadId);
  return (
    <main className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-5xl">
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
          renderHistory={(expertId) => (
            <ExpertTaskHistory
              expertId={expertId}
              onOpenThread={(threadId) => {
                void navigate({ to: "/$threadId", params: { threadId } });
              }}
            />
          )}
        />
      </div>
      {actions.projectPicker}
    </main>
  );
}
