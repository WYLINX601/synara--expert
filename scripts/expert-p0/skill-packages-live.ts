/** Isolated owner-RPC acceptance. The caller supplies the existing provider/model
 * selection and an owner token file; evidence never contains credentials. */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  ThreadId,
  ProjectId,
  type ProviderKind,
} from "@synara/contracts";
import { connectOwnerUrl } from "../computer-use-fixtures/packaged-client.ts";

const [portText, tokenPath, outputPath, providerText, model, mode = "markers"] =
  process.argv.slice(2);
if (!portText || !tokenPath || !outputPath || !providerText || !model)
  throw new Error(
    "Usage: skill-packages-live.ts <loopback-port> <token-file> <new-output-dir> <provider> <existing-model> [markers]",
  );
const provider = providerText as ProviderKind;
if (!["codex", "pi", "claudeAgent", "omp"].includes(provider) || /haiku/i.test(model))
  throw new Error("Unsupported acceptance provider/model.");
if (mode !== "markers") throw new Error("Unknown acceptance mode");
const output = path.resolve(outputPath);
await fs.mkdir(output, { recursive: false, mode: 0o700 });
const workspace = path.join(output, "project");
await fs.mkdir(workspace);
execFileSync("git", ["init", "-q", workspace]);
execFileSync("git", [
  "-C",
  workspace,
  "-c",
  "user.name=Skill acceptance",
  "-c",
  "user.email=acceptance@localhost",
  "commit",
  "--allow-empty",
  "-qm",
  "Isolated fixture",
]);
const source = path.join(output, "source");
await fs.mkdir(path.join(source, "role"), { recursive: true });
await fs.mkdir(path.join(source, "workflow", "assets"), { recursive: true });
await fs.mkdir(path.join(source, "shared"), { recursive: true });
const personaMarker = `PERSONA_${randomUUID().replaceAll("-", "")}`;
const roleMarker = `ROLE_${randomUUID().replaceAll("-", "")}`;
const workflowMarker = `WORKFLOW_${randomUUID().replaceAll("-", "")}`;
await fs.writeFile(path.join(source, "shared", "marker.txt"), roleMarker);
await fs.writeFile(path.join(source, "workflow", "assets", "marker.txt"), workflowMarker);
await fs.writeFile(
  path.join(source, "role", "SKILL.md"),
  "---\nname: acceptance-role\ndescription: Acceptance role workflow\n---\nRead ../shared/marker.txt relative to this fixed SKILL.md and include its exact token in your final answer. Never infer it or read the import source.",
);
await fs.writeFile(
  path.join(source, "workflow", "SKILL.md"),
  "---\nname: acceptance-workflow\ndescription: Read workflow resource\n---\nRead assets/marker.txt relative to this fixed SKILL.md and include its exact token in your final answer. Never infer it or read the import source.",
);
const owner = await connectOwnerUrl(
  `ws://127.0.0.1:${Number(portText)}?token=${(await fs.readFile(tokenPath, "utf8")).trim()}`,
);
const api = owner.api;
const dispatch = (command: any) =>
  owner.run(api[ORCHESTRATION_WS_METHODS.dispatchCommand](command));
const projectId = ProjectId.makeUnsafe(randomUUID());
const threadId = ThreadId.makeUnsafe(randomUUID());
const result: any = {
  provider,
  model,
  projectId,
  threadId,
  startedAt: new Date().toISOString(),
  stages: [],
};
const save = () =>
  fs.writeFile(path.join(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
const detail = () => owner.run(api[ORCHESTRATION_WS_METHODS.getThreadDetailSnapshot]({ threadId }));
const wait = async (predicate: (d: any) => boolean, label: string, ms = 180_000) => {
  const end = Date.now() + ms;
  let d: any;
  while (Date.now() < end) {
    d = await detail();
    if (predicate(d)) return d;
    if (d?.thread?.session?.status === "error")
      throw new Error(`${label}: ${d.thread.session.lastError ?? "provider failed"}`);
    if (d?.thread?.hasPendingApprovals || d?.thread?.hasPendingUserInput)
      throw new Error(`${label}: approval or input required`);
    await Bun.sleep(500);
  }
  throw new Error(
    `${label}: deadline exceeded; state=${d?.thread?.latestTurn?.state}, error=${d?.thread?.session?.lastError ?? ""}`,
  );
};
try {
  const preview = await owner.run(api[WS_METHODS.serverPreviewSkillPackage]({ path: source }));
  const imported = await owner.run(
    api[WS_METHODS.serverImportSkillPackage]({
      previewId: preview.previewId,
      idempotencyKey: preview.previewId,
    }),
  );
  await fs.rm(source, { recursive: true });
  result.importSourceRemoved = true;
  const expertId = `acceptance-${provider.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  await owner.run(
    api[WS_METHODS.serverSaveExpert]({
      id: expertId,
      name: "Skill package acceptance",
      description: "Isolated fixture",
      useCases: "",
      persona: `For each final answer include ${personaMarker}.`,
      outputRequirements: "",
      skills: [],
      skillSelections: [
        {
          packageId: imported.package.packageId,
          entryPath: "role/SKILL.md",
        },
        {
          packageId: imported.package.packageId,
          entryPath: "workflow/SKILL.md",
        },
      ],
      references: [],
      connections: [],
    }),
  );
  await dispatch({
    type: "project.create",
    commandId: randomUUID(),
    projectId,
    title: "Skill package isolated acceptance",
    workspaceRoot: workspace,
    createdAt: new Date().toISOString(),
  });
  const projectDeadline = Date.now() + 30_000;
  let projectReady = false;
  while (Date.now() < projectDeadline) {
    const projected = await owner.run(api[ORCHESTRATION_WS_METHODS.getSnapshot]({}));
    if (projected.projects.some((p) => p.id === projectId && p.workspaceRoot === workspace)) {
      projectReady = true;
      break;
    }
    await Bun.sleep(100);
  }
  if (!projectReady) throw new Error("Project workspace was not projected before task creation");
  await dispatch({
    type: "thread.create",
    commandId: randomUUID(),
    threadId,
    projectId,
    expertId,
    title: `Skill package ${provider} markers`,
    modelSelection: { provider, model },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: new Date().toISOString(),
  });
  const created = await detail();
  const snapshotId = created!.thread.expertBinding!.snapshotId;
  result.snapshotId = snapshotId;
  result.packageId = imported.package.packageId;
  const invoke = {
    name: "acceptance-workflow",
    path: "ignored-client-path",
    expert: { snapshotId, packageId: imported.package.packageId, entryPath: "workflow/SKILL.md" },
  };
  const turn = async (text: string, skills?: any[]) => {
    const messageId = randomUUID();
    const previousTurnId = (await detail())?.thread.latestTurn?.turnId;
    const requestedAt = new Date().toISOString();
    await dispatch({
      type: "thread.turn.start",
      commandId: randomUUID(),
      threadId,
      message: { messageId, role: "user", text, attachments: [], ...(skills ? { skills } : {}) },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: requestedAt,
    });
    const d = await wait(
      (d) =>
        d?.thread?.latestTurn?.turnId !== previousTurnId &&
        d?.thread?.latestTurn?.requestedAt >= requestedAt &&
        d?.thread?.messages?.some((m: any) => m.id === messageId) &&
        ["completed", "error", "interrupted", "failed"].includes(d.thread.latestTurn?.state) &&
        (d.thread.latestTurn.state !== "completed" ||
          (d.thread.messages.some(
            (m: any) =>
              m.turnId === d.thread.latestTurn.turnId && m.role === "assistant" && !m.streaming,
          ) &&
            !d.thread.messages.some(
              (m: any) =>
                m.turnId === d.thread.latestTurn.turnId && m.role === "assistant" && m.streaming,
            ))),
      "turn",
    );
    await fs.writeFile(
      path.join(output, `turn-${result.stages.length}.json`),
      JSON.stringify(d, null, 2),
    );
    const answer = d.thread.messages
      .filter(
        (m: any) =>
          m.role === "assistant" && m.turnId === d.thread.latestTurn.turnId && !m.streaming,
      )
      .map((m: any) => m.text)
      .join("\n");
    return {
      turnId: d.thread.latestTurn.turnId,
      assistantMessageId: d.thread.latestTurn.assistantMessageId,
      state: d.thread.latestTurn?.state,
      persona: answer.includes(personaMarker),
      role: answer.includes(roleMarker),
      workflow: answer.includes(workflowMarker),
    };
  };
  result.stages.push({
    stage: "on-demand-and-explicit",
    ...(await turn(
      "Use acceptance-role and $acceptance-workflow. Read their required resource files using your tools and return the markers. Touch only this isolated fixture.",
      [invoke],
    )),
  });
  await save();
  result.receipt = await owner.run(api[WS_METHODS.serverReadExpertAppliedRuntime]({ threadId }));
  if (!result.stages[0].persona || !result.stages[0].role || !result.stages[0].workflow)
    throw new Error("Required live markers missing");
  // Stop only this fixture session, then dispatch again to exercise recovery.
  await dispatch({
    type: "thread.session.stop",
    commandId: randomUUID(),
    threadId,
    createdAt: new Date().toISOString(),
  });
  await wait((d) => d?.thread?.session?.status === "stopped", "session stop", 30_000);
  result.stages.push({
    stage: "recovery",
    ...(await turn(
      "Read the same fixed resource files again via $acceptance-workflow and return all required markers.",
      [invoke],
    )),
  });
  await save();
  result.recoveredReceipt = await owner.run(
    api[WS_METHODS.serverReadExpertAppliedRuntime]({ threadId }),
  );
  if (result.recoveredReceipt?.lifecycleGeneration === result.receipt?.lifecycleGeneration)
    throw new Error("Recovery did not apply a new lifecycle generation");
  const holdScript = path.join(workspace, "hold.py");
  const holdPid = path.join(workspace, "hold.pid");
  await fs.writeFile(
    holdScript,
    `import os,time\nopen(${JSON.stringify(holdPid)},'w').write(str(os.getpid()))\ntime.sleep(90)\n`,
  );
  const messageId = randomUUID();
  await dispatch({
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId,
    message: {
      messageId,
      role: "user",
      text: `Run python3 ${JSON.stringify(holdScript)} and wait for it. Do not start other commands.`,
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });
  const deadline = Date.now() + 90_000;
  let holdObserved = false;
  while (Date.now() < deadline) {
    if (await Bun.file(holdPid).exists()) {
      holdObserved = true;
      break;
    }
    await Bun.sleep(500);
  }
  if (!holdObserved) throw new Error("Cancellation fixture process never started");
  const cancelledTurnId = (await detail())?.thread.latestTurn?.turnId;
  await dispatch({
    type: "thread.turn.interrupt",
    commandId: randomUUID(),
    threadId,
    turnId: cancelledTurnId,
    createdAt: new Date().toISOString(),
  });
  const stopped = await wait(
    (d) =>
      d?.thread?.latestTurn?.turnId === cancelledTurnId &&
      d?.thread?.latestTurn?.state !== "running" &&
      d?.thread?.latestTurn?.state !== "pending",
    "cancellation",
    30_000,
  );
  const pid = Number(await fs.readFile(holdPid, "utf8"));
  let exited = false;
  for (let i = 0; i < 20; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      exited = true;
      break;
    }
    await Bun.sleep(500);
  }
  result.stages.push({
    stage: "cancellation",
    state: stopped.thread.latestTurn?.state,
    commandExited: exited,
  });
  if (!exited) {
    process.kill(pid, "SIGTERM");
    throw new Error("Fixture command survived native stop; forcibly cleaned up");
  }
  result.passed =
    result.stages.every((s: any) =>
      s.stage === "cancellation" ? s.commandExited : s.persona && s.role && s.workflow,
    ) && result.receipt?.skillApplication?.mode === "catalog";
} catch (cause) {
  result.passed = false;
  result.failure = cause instanceof Error ? cause.message : String(cause);
  process.exitCode = 1;
} finally {
  await detail()
    .then((d) => fs.writeFile(path.join(output, "final-thread.json"), JSON.stringify(d, null, 2)))
    .catch(() => undefined);
  await dispatch({
    type: "thread.session.stop",
    commandId: randomUUID(),
    threadId,
    createdAt: new Date().toISOString(),
  }).catch(() => undefined);
  result.finishedAt = new Date().toISOString();
  await save();
  await owner.close();
  console.log(
    JSON.stringify(
      { provider, model, passed: result.passed, failure: result.failure, output },
      null,
      2,
    ),
  );
}
