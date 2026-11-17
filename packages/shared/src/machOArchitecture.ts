/**
 * `lipo -verify_arch arm64 <file>` is not portable: the cctools binary accepts that
 * order, while the llvm-lipo shipped with Xcode development toolchains treats the
 * file argument as another architecture name and fails. Parsing `-archs` output is
 * accepted by both, and keeps the decision on the actual slice list.
 */
export function assertArm64MachO(binary: string, lipoArchsOutput: string): void {
  const architectures = lipoArchsOutput.trim().split(/\s+/).filter(Boolean);
  if (!architectures.includes("arm64"))
    throw new Error(
      `Expected an arm64 Mach-O at ${binary}, found: ${architectures.join(", ") || "none"}.`,
    );
}
