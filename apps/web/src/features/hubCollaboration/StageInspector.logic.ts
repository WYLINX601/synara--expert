export type HubNodeIssue = {
  readonly title: string;
  readonly summary: string;
  readonly nextStep: string;
};

/** Presentation only: a thread report is evidence of a report, not a permission probe. */
export function describeHubNodeIssue(input: {
  readonly report: string | undefined;
  readonly reasons: readonly string[];
  readonly retryable: boolean;
  readonly reviewOutcome: "pass" | "blocked" | "changes_requested" | undefined;
  readonly awaitingReview: boolean;
}): HubNodeIssue {
  if (
    input.reviewOutcome === "changes_requested" ||
    input.reasons.includes("A current required review requested changes.")
  ) {
    return {
      title: "成果需要修改",
      summary: "必要审核要求修改当前成果，当前阶段尚不能放行。",
      nextStep: "按审核意见修订成果，再通过现有流程重新提交审核。",
    };
  }
  if (
    input.reviewOutcome === "blocked" ||
    input.reasons.includes("A current required review is blocked.")
  ) {
    return {
      title: "审核无法完成",
      summary: "必要审核未能完成，当前阶段尚不能放行。",
      nextStep: "在审核线程处理审核意见中指出的问题，再确认是否可以继续。",
    };
  }
  // Require an explicit causal statement, rather than disconnected keywords or historical mentions.
  if (
    input.report &&
    /(?:环境|工作区|workspace)[^。；\n]{0,50}(?:read[- ]only|只读)[^。；\n]{0,50}(?:无法|不能)[^。；\n]{0,60}(?:保存|写入|登记)/i.test(
      input.report,
    ) &&
    !/(?:不再|不是|并非|已解除|已取消)[^。；\n]{0,8}(?:read[- ]only|只读)/i.test(input.report)
  ) {
    return {
      title: "成果登记受阻",
      summary: `线程报告工作区只读，无法保存并登记成果${input.awaitingReview ? "，后续审核暂时无法开始" : "，本次交付尚未就绪"}。`,
      nextStep: "先在对应线程处理工作区写入权限，确认问题已解决后再使用现有计划操作重试。",
    };
  }
  if (input.reasons.includes("The current stage generation is unavailable or invalid.")) {
    return {
      title: "执行轮次不可用",
      summary: "当前阶段没有有效执行轮次，流程暂时无法继续。",
      nextStep: "通过现有计划操作核对当前计划版本与执行轮次。",
    };
  }
  if (
    input.retryable ||
    input.reasons.includes(
      "A provider turn completed without an accepted node result; an explicit retry is available.",
    )
  ) {
    return {
      title: "成果尚未提交",
      summary: "当前回合已结束，但系统尚未收到可验收的成果，流程暂时无法继续。",
      nextStep: "在对应线程核对成果登记与提交结果，确认问题已解决后再使用现有计划操作重试。",
    };
  }
  if (input.reasons.includes("Every stage task must be done before the stage can be released.")) {
    return {
      title: "仍有任务未完成",
      summary: "当前阶段仍有任务未完成，暂时不能放行。",
      nextStep: "先处理未完成的任务，再返回当前阶段确认。",
    };
  }
  return {
    title: "阻塞原因待核实",
    summary: "当前记录尚不足以确认具体原因，流程暂时无法继续。",
    nextStep: "查看技术详情或对应线程，先核实导致中断的原因。",
  };
}
