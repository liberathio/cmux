import { beforeEach, describe, expect, mock, test } from "bun:test";
import { VM_ROUTE_MAX_DURATION_SECONDS } from "../services/vms/config";
import { createVmWorkflowMocks } from "./support/vmWorkflowMocks";

const getUser = mock(async () => null);
const runVmWorkflow = mock(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
const execVm = mock(() => ({ workflow: "exec" }));

mock.module("../app/lib/stack", () => ({
  getStackServerApp: () => ({ getUser }),
  isStackConfigured: () => true,
}));

mock.module("../services/vms/workflows", () =>
  createVmWorkflowMocks({ execVm, runVmWorkflow }),
);

const { POST } = await import("../app/api/vm/[id]/exec/route");

beforeEach(() => {
  getUser.mockClear();
  getUser.mockResolvedValue(authedStackUser());
  runVmWorkflow.mockClear();
  runVmWorkflow.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  execVm.mockClear();
});

describe("POST /api/vm/[id]/exec timeout clamping", () => {
  test("never asks the provider to run longer than the function is allowed to live", async () => {
    const response = await execRequest({ command: "sleep 900", timeoutMs: 15 * 60 * 1000 });

    expect(response.status).toBe(200);
    const [call] = execVm.mock.calls;
    const requestedTimeoutMs = (call?.[0] as { timeoutMs: number }).timeoutMs;
    // A timeout past the function's own budget can only ever end as a 504 with the provider
    // still running the command, so the route must clamp below `maxDuration`.
    expect(requestedTimeoutMs).toBeLessThan(VM_ROUTE_MAX_DURATION_SECONDS * 1000);
    expect(requestedTimeoutMs).toBeGreaterThan(0);
  });

  test("keeps a timeout that already fits inside the function budget", async () => {
    const response = await execRequest({ command: "true", timeoutMs: 5_000 });

    expect(response.status).toBe(200);
    expect(execVm).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 5_000 }));
  });

  test("falls back to the default timeout for missing or invalid values", async () => {
    await execRequest({ command: "true" });
    await execRequest({ command: "true", timeoutMs: -1 });
    await execRequest({ command: "true", timeoutMs: "soon" });

    for (const call of execVm.mock.calls) {
      const { timeoutMs } = call[0] as { timeoutMs: number };
      expect(timeoutMs).toBe(30_000);
    }
  });
});

function execRequest(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request("https://cmux.test/api/vm/provider-vm-1/exec", {
      method: "POST",
      headers: { origin: "https://cmux.test" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "provider-vm-1" }) },
  );
}

function authedStackUser() {
  return {
    id: "user-1",
    displayName: null,
    primaryEmail: "user@example.com",
    selectedTeam: {
      id: "team-1",
      clientReadOnlyMetadata: { cmuxVmPlan: "pro" },
    },
    listTeams: async () => [{
      id: "team-1",
      clientReadOnlyMetadata: { cmuxVmPlan: "pro" },
    }],
  };
}
