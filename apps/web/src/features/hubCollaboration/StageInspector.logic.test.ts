import { describe, expect, it } from "vitest";
import { describeHubNodeIssue } from "./StageInspector.logic";

const base = {
  report: undefined,
  reasons: [],
  retryable: false,
  reviewOutcome: undefined,
  awaitingReview: false,
} as const;

describe("Hub issue presentation", () => {
  it("attributes an explicit read-only report and only states downstream impact when known", () => {
    const report =
      "阻塞：运行环境明确为 read-only，无法在本线程工作区保存所需 Markdown；本次 revision 0，另一 worker 的 revision 1 不替代交付。";
    const issue = describeHubNodeIssue({ ...base, report, retryable: true, awaitingReview: true });
    expect(issue.title).toBe("成果登记受阻");
    expect(issue.summary).toContain("线程报告");
    expect(issue.summary).toContain("后续审核暂时无法开始");
    expect(describeHubNodeIssue({ ...base, report }).summary).not.toContain("审核");
  });
  it.each([
    "回合结束，未提交成果。",
    "工作区不再只读，无法登记成果的原因另待排查。",
    "早前提到只读。当前无法登记成果，错误原因不明。",
  ])("does not invent a permission cause from ambiguous text: %s", (report) => {
    const issue = describeHubNodeIssue({ ...base, report, retryable: true });
    expect(issue.title).toBe("成果尚未提交");
    expect(issue.summary).not.toContain("只读");
    expect(issue.nextStep).not.toContain("权限");
  });
  it("distinguishes a blocked review from requested changes", () => {
    expect(describeHubNodeIssue({ ...base, reviewOutcome: "blocked" }).title).toBe("审核无法完成");
    expect(describeHubNodeIssue({ ...base, reviewOutcome: "changes_requested" }).title).toBe(
      "成果需要修改",
    );
  });
  it("keeps an unrecognized cause explicitly unverified", () => {
    expect(
      describeHubNodeIssue({ ...base, report: "ToolError id=abc", reasons: ["unclassified error"] })
        .title,
    ).toBe("阻塞原因待核实");
  });
});
