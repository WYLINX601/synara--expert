import type { ExpertDefinition } from "@synara/contracts";

import { HubExpertSelectionSection } from "~/features/hubCollaboration/HubExpertSelectionSection";

export function GroupExpertsSection(props: {
  readonly expertIds: ReadonlyArray<string>;
  readonly experts: ReadonlyArray<ExpertDefinition> | undefined;
  readonly loading: boolean;
  readonly error: string | null;
  readonly showOrdinaryFallback?: boolean;
  readonly onChange: (expertIds: ReadonlyArray<string>) => void;
}) {
  return <HubExpertSelectionSection {...props} />;
}
