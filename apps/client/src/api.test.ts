import { afterEach, expect, it, vi } from "vitest";
import { applyTeamTaskChanges } from "./api";

const teamRunId = "b4f3742a-a771-4dba-9620-7184061a3148";
const teamTaskId = "0c7cb9df-31e3-48cb-a722-a0410290236a";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("does not declare an empty body as JSON for bodyless team actions", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
    team: {
      id: teamRunId,
      sessionId: "96294f4a-b7e1-427c-a757-8a789e7b719d",
      goal: "Apply an isolated patch",
      status: "completed",
      maxConcurrency: 1,
      workspaceMode: "worktree",
      mergeStrategy: "manual",
      createdAt: "2026-07-24T00:00:00.000Z",
      completedAt: "2026-07-24T00:01:00.000Z",
      tasks: [{
        id: teamTaskId,
        teamRunId,
        sessionId: "96294f4a-b7e1-427c-a757-8a789e7b719d",
        agentId: "6de7376f-5356-4a84-9af7-5976687b2f64",
        agentLabel: "Writer",
        prompt: "Write the assigned file",
        status: "completed",
        output: "done",
        error: null,
        allowedPaths: ["src"],
        worktreeBranch: `prometheus/team/${teamTaskId}`,
        baseCommit: "a".repeat(40),
        changedPaths: ["src/result.txt"],
        changeStatus: "applied",
        conflictPaths: [],
        patchBytes: 128,
        createdAt: "2026-07-24T00:00:00.000Z",
        startedAt: "2026-07-24T00:00:01.000Z",
        completedAt: "2026-07-24T00:00:02.000Z",
      }],
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchMock);

  await applyTeamTaskChanges(teamRunId, teamTaskId);

  const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
  expect(init.body).toBeUndefined();
  expect(new Headers(init.headers).has("content-type")).toBe(false);
});
