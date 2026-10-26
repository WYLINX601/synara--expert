export const SKILL_MANAGEMENT_EXIT_CODES = {
  success: 0,
  runtime: 1,
  usage: 2,
  conflict: 3,
  unauthorized: 4,
  partial: 5,
} as const;

export type SkillManagementExitCode =
  (typeof SKILL_MANAGEMENT_EXIT_CODES)[keyof typeof SKILL_MANAGEMENT_EXIT_CODES];

export function managementExitCodeName(code: SkillManagementExitCode): string {
  switch (code) {
    case SKILL_MANAGEMENT_EXIT_CODES.success:
      return "success";
    case SKILL_MANAGEMENT_EXIT_CODES.usage:
      return "usage_error";
    case SKILL_MANAGEMENT_EXIT_CODES.conflict:
      return "conflict";
    case SKILL_MANAGEMENT_EXIT_CODES.unauthorized:
      return "unauthorized";
    case SKILL_MANAGEMENT_EXIT_CODES.partial:
      return "partial_success";
    default:
      return "runtime_error";
  }
}
