import {
  type ExpertBinding,
  type ExpertPreview,
  type ProjectEntry,
  type ProviderInstanceId,
  type ProviderKind,
  type ProviderMentionReference,
  type ProviderNativeCommandDescriptor,
  type ProviderPluginDescriptor,
  type ProviderSkillDescriptor,
  type ProviderStartOptions,
  ThreadId,
} from "@synara/contracts";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { ensureExpertClient } from "~/workbench/host/expertClient";
import { PENDING_EXPERT_SKILL_SNAPSHOT } from "~/lib/expertSkillInvocation";
import { isLocalFolderMentionQuery } from "~/lib/localFolderMentions";
import { projectSearchEntriesQueryOptions } from "~/lib/projectReactQuery";
import {
  providerCommandsQueryOptions,
  providerComposerCapabilitiesQueryOptions,
  providerPluginsQueryOptions,
  providerSkillsQueryOptions,
  supportsNativeSlashCommandDiscovery,
  supportsPluginDiscovery,
  supportsSkillDiscovery,
  supportsThreadCompaction,
} from "~/lib/providerDiscoveryReactQuery";
import { type ComposerTrigger } from "../../composer-logic";
import {
  hasProviderNativeSlashCommand,
  providerSupportsTextNativeReviewCommand,
} from "../../composerSlashCommands";

const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];
const EMPTY_PROVIDER_NATIVE_COMMANDS: ProviderNativeCommandDescriptor[] = [];
const EMPTY_PROVIDER_SKILLS: ProviderSkillDescriptor[] = [];
type ComposerPluginSuggestion = {
  plugin: ProviderPluginDescriptor;
  mention: ProviderMentionReference;
};

const EMPTY_COMPOSER_PLUGIN_SUGGESTIONS: ComposerPluginSuggestion[] = [];
const COMPOSER_PATH_QUERY_DEBOUNCE_MS = 120;
interface ComposerDiscoveryInput {
  threadId: ThreadId;
  expertBinding?: ExpertBinding | null;
  draftExpert?: {
    readonly preview: ExpertPreview | undefined;
    readonly isFetching: boolean;
    readonly isError: boolean;
  } | null;
  selectedProvider: ProviderKind;
  selectedProviderInstanceId: ProviderInstanceId;
  composerTrigger: ComposerTrigger | null;
  composerCommandPicker: "fork-target" | "review-target" | null;
  providerModelDiscoveryCwd: string | null;
  providerOptionsForDispatch: ProviderStartOptions | undefined;
  gitCwd: string | null;
  piAgentDir: string;
  ompAgentDir: string;
  discoverNativeCompaction?: boolean;
}

export function useComposerDiscovery({
  threadId,
  expertBinding,
  draftExpert,
  selectedProvider,
  selectedProviderInstanceId,
  composerTrigger,
  composerCommandPicker,
  providerModelDiscoveryCwd,
  providerOptionsForDispatch,
  gitCwd,
  piAgentDir,
  ompAgentDir,
  discoverNativeCompaction,
}: ComposerDiscoveryInput) {
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const mentionTriggerQuery = composerTrigger?.kind === "mention" ? composerTrigger.query : "";
  const isMentionTrigger = composerTriggerKind === "mention";

  const isLocalFolderBrowserOpen =
    composerCommandPicker === null &&
    isMentionTrigger &&
    isLocalFolderMentionQuery(mentionTriggerQuery);
  const isSkillTrigger = composerTriggerKind === "skill";
  const [debouncedPathQuery, composerPathQueryDebouncer] = useDebouncedValue(
    mentionTriggerQuery,
    { wait: COMPOSER_PATH_QUERY_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const effectiveMentionQuery = mentionTriggerQuery.length > 0 ? debouncedPathQuery : "";
  const composerSkillCwd = providerModelDiscoveryCwd;
  const hasExpertSkillSource = Boolean(expertBinding || draftExpert);
  const providerComposerCapabilitiesQuery = useQuery(
    providerComposerCapabilitiesQueryOptions(selectedProvider, selectedProviderInstanceId),
  );
  const providerCommandsQuery = useQuery(
    providerCommandsQueryOptions({
      provider: selectedProvider,
      instanceId: selectedProviderInstanceId,
      cwd: composerSkillCwd,
      threadId,
      binaryPath:
        (selectedProvider === "opencode"
          ? providerOptionsForDispatch?.opencode?.binaryPath
          : selectedProvider === "devin"
            ? providerOptionsForDispatch?.devin?.binaryPath
            : null) ?? null,
      serverUrl:
        (selectedProvider === "opencode"
          ? providerOptionsForDispatch?.opencode?.serverUrl
          : null) ?? null,
      experimentalWebSockets:
        selectedProvider === "opencode"
          ? providerOptionsForDispatch?.opencode?.experimentalWebSockets
          : undefined,
      agentDir:
        selectedProvider === "pi"
          ? piAgentDir || null
          : selectedProvider === "omp"
            ? ompAgentDir || null
            : null,
      enabled:
        !hasExpertSkillSource &&
        (composerTriggerKind === "slash-command" ||
          composerTriggerKind === "slash-model" ||
          discoverNativeCompaction === true) &&
        supportsNativeSlashCommandDiscovery(providerComposerCapabilitiesQuery.data) &&
        composerSkillCwd !== null,
    }),
  );
  const canDiscoverProviderSkills =
    selectedProvider === "pi" ||
    selectedProvider === "omp" ||
    supportsSkillDiscovery(providerComposerCapabilitiesQuery.data);
  // Expert threads use the accepted snapshot, never the mutable template or the
  // harness-wide catalog. Load outside the picker too, so restored skill chips
  // keep resolving to the exact snapshot paths after refresh/provider changes.
  const expertSnapshotQuery = useQuery({
    queryKey: ["server", "expertSnapshot", expertBinding?.snapshotId],
    enabled: !!expertBinding,
    queryFn: () => {
      if (!expertBinding) throw new Error("This thread has no Expert binding.");
      return ensureExpertClient().readExpertSnapshot({ snapshotId: expertBinding.snapshotId });
    },
  });
  const providerSkillsQuery = useQuery(
    providerSkillsQueryOptions({
      provider: selectedProvider,
      instanceId: selectedProviderInstanceId,
      cwd: composerSkillCwd,
      threadId,
      agentDir:
        selectedProvider === "pi"
          ? piAgentDir || null
          : selectedProvider === "omp"
            ? ompAgentDir || null
            : null,
      enabled:
        !hasExpertSkillSource &&
        (isSkillTrigger ||
          composerTriggerKind === "slash-command" ||
          selectedProvider === "pi" ||
          selectedProvider === "omp") &&
        canDiscoverProviderSkills &&
        composerSkillCwd !== null,
    }),
  );
  const providerPluginsQuery = useQuery(
    providerPluginsQueryOptions({
      provider: selectedProvider,
      instanceId: selectedProviderInstanceId,
      cwd: composerSkillCwd,
      threadId,
      enabled:
        !hasExpertSkillSource &&
        supportsPluginDiscovery(providerComposerCapabilitiesQuery.data) &&
        composerSkillCwd !== null,
    }),
  );
  const workspaceEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd: gitCwd,
      query: effectiveMentionQuery,
      enabled: isMentionTrigger && !isLocalFolderBrowserOpen,
      limit: 80,
    }),
  );
  const workspaceEntries = workspaceEntriesQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;

  // Keep plugin suggestions referentially stable so prompt-sync effects do not loop on rerender.
  const providerPlugins = useMemo(
    () =>
      hasExpertSkillSource
        ? EMPTY_COMPOSER_PLUGIN_SUGGESTIONS
        : (providerPluginsQuery.data?.marketplaces.flatMap((marketplace) =>
            marketplace.plugins.map((plugin) => ({
              plugin,
              mention: {
                name: plugin.name,
                path: `plugin://${plugin.name}@${marketplace.name}`,
              } satisfies ProviderMentionReference,
            })),
          ) ?? EMPTY_COMPOSER_PLUGIN_SUGGESTIONS),
    [hasExpertSkillSource, providerPluginsQuery.data],
  );
  const providerNativeCommands = hasExpertSkillSource
    ? EMPTY_PROVIDER_NATIVE_COMMANDS
    : (providerCommandsQuery.data?.commands ?? EMPTY_PROVIDER_NATIVE_COMMANDS);
  const providerNativeCommandNames = useMemo(
    () => providerNativeCommands.map((command) => command.name),
    [providerNativeCommands],
  );
  const effectiveComposerTrigger = useMemo(() => {
    if (
      composerTrigger?.kind === "slash-model" &&
      hasProviderNativeSlashCommand(selectedProvider, providerNativeCommandNames, "model")
    ) {
      return {
        ...composerTrigger,
        kind: "slash-command" as const,
        query: "model",
      };
    }
    return composerTrigger;
  }, [composerTrigger, providerNativeCommandNames, selectedProvider]);
  const effectiveComposerTriggerKind = effectiveComposerTrigger?.kind ?? null;
  const supportsTextNativeReviewCommand = useMemo(
    () => providerSupportsTextNativeReviewCommand(selectedProvider, providerNativeCommands),
    [providerNativeCommands, selectedProvider],
  );
  // Unsent drafts reuse the existing preview; accepted bindings always take precedence.
  const expertEntries = expertBinding
    ? expertSnapshotQuery.isError
      ? undefined
      : expertSnapshotQuery.data?.skillEntries
    : draftExpert?.isError
      ? undefined
      : draftExpert?.preview?.skillEntries;
  const legacyExpertSkills = expertBinding
    ? expertSnapshotQuery.isError
      ? undefined
      : expertSnapshotQuery.data?.skills
    : draftExpert?.isError
      ? undefined
      : draftExpert?.preview?.definition.skills;
  const providerSkills = useMemo(
    () =>
      hasExpertSkillSource
        ? expertEntries
          ? expertEntries
              .filter((entry) => entry.userInvocable !== false)
              .map((entry) => ({
                name: entry.name,
                description: entry.description || undefined,
                path: `synara-expert-skill:${entry.packageId}#${entry.entryPath}`,
                enabled: true,
                scope: "expert",
                expert: {
                  snapshotId: expertBinding?.snapshotId ?? PENDING_EXPERT_SKILL_SNAPSHOT,
                  packageId: entry.packageId,
                  entryPath: entry.entryPath,
                },
              }))
          : (legacyExpertSkills?.map((skill) => ({
              ...skill,
              enabled: true,
              scope: "expert",
            })) ?? EMPTY_PROVIDER_SKILLS)
        : (providerSkillsQuery.data?.skills ?? EMPTY_PROVIDER_SKILLS),
    [
      hasExpertSkillSource,
      expertEntries,
      expertBinding?.snapshotId,
      legacyExpertSkills,
      providerSkillsQuery.data,
    ],
  );
  const skillsLoading = expertBinding
    ? expertSnapshotQuery.isLoading || expertSnapshotQuery.isFetching
    : draftExpert
      ? draftExpert.isFetching
      : providerSkillsQuery.isLoading || providerSkillsQuery.isFetching;
  const composerDiscoveryError =
    (isSkillTrigger || composerTriggerKind === "slash-command") &&
    (expertBinding ? expertSnapshotQuery.isError : draftExpert?.isError)
      ? expertBinding
        ? "无法读取此对话绑定的专家技能，请重试。"
        : "无法读取所选专家的技能，请重试。"
      : null;

  const isComposerMenuLoading =
    (composerTriggerKind === "mention" &&
      ((mentionTriggerQuery.length > 0 && composerPathQueryDebouncer.state.isPending) ||
        workspaceEntriesQuery.isLoading ||
        workspaceEntriesQuery.isFetching ||
        (!hasExpertSkillSource &&
          (providerPluginsQuery.isLoading || providerPluginsQuery.isFetching)))) ||
    (composerTriggerKind === "slash-command" &&
      ((!hasExpertSkillSource &&
        (providerCommandsQuery.isLoading || providerCommandsQuery.isFetching)) ||
        skillsLoading)) ||
    (composerTriggerKind === "skill" &&
      (providerComposerCapabilitiesQuery.isLoading ||
        providerComposerCapabilitiesQuery.isFetching ||
        skillsLoading));
  return {
    mentionTriggerQuery,
    isLocalFolderBrowserOpen,
    providerPlugins,
    providerNativeCommands,
    providerArtifacts: hasExpertSkillSource ? undefined : providerCommandsQuery.data?.artifacts,
    providerSkills,
    workspaceEntries,
    effectiveComposerTrigger,
    effectiveComposerTriggerKind,
    supportsTextNativeReviewCommand,
    isComposerMenuLoading,
    composerDiscoveryError,
    canCompactThread: supportsThreadCompaction(providerComposerCapabilitiesQuery.data),
    isNativeCommandDiscoveryPending:
      !hasExpertSkillSource &&
      (providerComposerCapabilitiesQuery.isPending ||
        (supportsNativeSlashCommandDiscovery(providerComposerCapabilitiesQuery.data) &&
          providerCommandsQuery.isPending) ||
        providerCommandsQuery.isFetching),
  };
}
