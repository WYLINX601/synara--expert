// FILE: EnvironmentProjectInstructionsSection.browser.tsx
// Purpose: Browser-level regression tests for project instructions autosave behavior.
// Layer: Vitest browser tests

import "../../../index.css";

import { ProjectId } from "@synara/contracts";
import { useState } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { EnvironmentProjectInstructionsSection } from "./EnvironmentProjectInstructionsSection";

const PROJECT_A = ProjectId.makeUnsafe("project-instructions-a");
const PROJECT_B = ProjectId.makeUnsafe("project-instructions-b");

describe("EnvironmentProjectInstructionsSection", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("flushes pending edits to the original project before switching projects", async () => {
    const onInstructionsChange = vi.fn();

    function ProjectSwitchHarness() {
      const [projectId, setProjectId] = useState<ProjectId>(PROJECT_A);
      return (
        <>
          <button type="button" onClick={() => setProjectId(PROJECT_B)}>
            Switch project
          </button>
          <EnvironmentProjectInstructionsSection
            projectId={projectId}
            instructions={
              projectId === PROJECT_A ? "Saved instructions for A" : "Saved instructions for B"
            }
            threadNotes=""
            canCopyToThreadNotes
            onInstructionsChange={onInstructionsChange}
            onCopyToThreadNotes={vi.fn()}
          />
        </>
      );
    }

    await render(<ProjectSwitchHarness />);

    await page.getByPlaceholder("Architecture notes, conventions, repo links").fill("Draft for A");
    await page.getByRole("button", { name: "Switch project" }).click();

    expect(onInstructionsChange).toHaveBeenCalledWith(PROJECT_A, "Draft for A");
    expect(onInstructionsChange).not.toHaveBeenCalledWith(PROJECT_B, "Draft for A");
    expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
      "Saved instructions for B",
    );
  });

  it("keeps controlled Context raw, shows its limit, and disables copying a draft", async () => {
    const onGoalChange = vi.fn();
    const onInstructionsChange = vi.fn();
    const onCopy = vi.fn();
    function ControlledHarness() {
      const [goal, setGoal] = useState("");
      const [instructions, setInstructions] = useState("");
      return (
        <EnvironmentProjectInstructionsSection
          projectId={PROJECT_A}
          instructions=""
          threadNotes=""
          canCopyToThreadNotes
          onInstructionsChange={vi.fn()}
          onCopyToThreadNotes={onCopy}
          controlledContext={{
            goal,
            onGoalChange: (value) => {
              onGoalChange(value);
              setGoal(value);
            },
            instructions,
            onInstructionsChange: (value) => {
              onInstructionsChange(value);
              setInstructions(value);
            },
            copyDisabled: true,
          }}
        />
      );
    }
    await render(<ControlledHarness />);

    await page.getByRole("button", { name: "Project goal" }).click();
    expect(document.body.textContent).not.toContain("0 / 4096");
    const goal = "g".repeat(4_097);
    await page.getByLabelText("Project goal").fill(goal);
    expect(onGoalChange).toHaveBeenLastCalledWith(goal);
    const goalTextarea = Array.from(document.querySelectorAll("textarea")).find(
      (textarea) => textarea.placeholder === "Describe the project goal",
    );
    expect(goalTextarea?.value).toBe(goal);
    await expect.element(page.getByText("4097 / 4096")).toBeVisible();
    await expect.element(page.getByText("Limit exceeded", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Project instructions" }).click();
    await page.getByLabelText("Project instructions").fill("committed context draft");
    await expect.element(page.getByRole("button", { name: "Copy to notepad" })).toBeDisabled();
    expect(onCopy).not.toHaveBeenCalled();
  });
});
