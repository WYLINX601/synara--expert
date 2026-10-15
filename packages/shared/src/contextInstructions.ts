/**
 * Compose the immutable instruction bundle submitted to a provider session.
 * Expert persona is kept before the already-rendered Space/Project Context.
 */
export function composeProviderBaseInstructions(input: {
  readonly expertPersona?: string | undefined;
  readonly contextInstructions?: string | undefined;
}): string | undefined {
  const parts = [input.expertPersona, input.contextInstructions].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
