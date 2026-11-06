import type {
  AmbientContextSourceManifest,
  AmbientContextSourcePolicy,
  AmbientResourceReference,
} from "@synara/contracts";

/** A desktop-owned producer of bounded, untrusted ambient observations. */
export interface AmbientContextSource {
  readonly manifest: AmbientContextSourceManifest;
  start(policy: AmbientContextSourcePolicy, emit: (publication: unknown) => void): Promise<void>;
  stop(): Promise<void>;
  searchResources?(
    query: string,
    policy: AmbientContextSourcePolicy,
    permissions: readonly string[],
  ): Promise<readonly AmbientResourceReference[]>;
}
