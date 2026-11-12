import * as fs from "node:fs/promises";
import * as path from "node:path";

// Like the existing learning reconciler, this is a scoped host capability, not
// cached publication state. Every observation reads the owning SQL transaction ledger.
const readers = new Map<
  string,
  {
    readonly published: (planId: string) => Promise<boolean>;
    readonly references: (packageId: string) => Promise<readonly string[]>;
  }
>();

export async function installExpertImportPublicationReader(
  stateDir: string,
  reader: (planId: string) => Promise<boolean>,
  references: (packageId: string) => Promise<readonly string[]>,
): Promise<() => void> {
  const root = await fs.realpath(stateDir);
  if (readers.has(root)) throw new Error("Expert import publication host is already installed.");
  const host = { published: reader, references };
  readers.set(root, host);
  return () => {
    if (readers.get(root) === host) readers.delete(root);
  };
}

export async function isExpertImportPublished(stateDir: string, planId: string): Promise<boolean> {
  if (planId.length === 0 || planId.length > 200 || /[\p{Cc}]/u.test(planId))
    throw new Error("Invalid Expert import publication identity.");
  // A file owner without the trusted SQL host can still serve legacy Experts,
  // but cannot infer publication or expose a staged import.
  const host = readers.get(await fs.realpath(stateDir));
  return host ? host.published(planId) : false;
}

export async function scanSuiteSkillPackageReferences(
  stateDir: string,
  packageId: string,
): Promise<readonly string[]> {
  let root: string;
  try {
    root = await fs.realpath(stateDir);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
  const host = readers.get(root);
  if (host) return host.references(packageId);
  try {
    await fs.lstat(path.join(root, "suites"));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
  // An unavailable SQL owner cannot prove that pending or committed Suite
  // references are absent. Do not turn a service-lifecycle gap into deletion.
  throw new Error(
    "Suite package references cannot be checked until their storage owner is available.",
  );
}
