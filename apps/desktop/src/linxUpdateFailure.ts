import type { LinxUpdateHelperResponse } from "@synara/contracts";

export type LinxUpdateFailureReason = NonNullable<LinxUpdateHelperResponse["failure"]>;

/** Only fixed codes cross the helper boundary; never filesystem paths or schema input. */
export class LinxUpdateOperationError extends Error {
  constructor(readonly reason: LinxUpdateFailureReason) {
    super(`Linx update refused: ${reason}`);
    this.name = "LinxUpdateOperationError";
  }
}

export function linxUpdateFailureReason(error: unknown): LinxUpdateFailureReason | null {
  if (error instanceof LinxUpdateOperationError) return error.reason;
  if (error instanceof Error && "code" in error) {
    if (error.code === "ENOSPC" || error.code === "EDQUOT") return "space";
    if (error.code === "EACCES" || error.code === "EPERM" || error.code === "EROFS")
      return "permissions";
  }
  return null;
}
