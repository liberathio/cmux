import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { createVmWorkflowMocks } from "./support/vmWorkflowMocks";

const runVmWorkflow = mock(async () => ({ reaped: 2 }));
const reapStuckProvisioningVms = mock(() => ({ workflow: "reap" }));

mock.module("../services/vms/workflows", () =>
  createVmWorkflowMocks({ reapStuckProvisioningVms, runVmWorkflow }),
);

const { GET } = await import("../app/api/cron/vm-reaper/route");

const originalSecret = process.env.CRON_SECRET;

beforeEach(() => {
  runVmWorkflow.mockClear();
  runVmWorkflow.mockResolvedValue({ reaped: 2 });
  reapStuckProvisioningVms.mockClear();
  process.env.CRON_SECRET = "cron-secret";
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
});

describe("GET /api/cron/vm-reaper", () => {
  test("refuses to run when no cron secret is configured", async () => {
    delete process.env.CRON_SECRET;

    const response = await GET(new Request("https://cmux.test/api/cron/vm-reaper"));

    // Fail closed: an unprotected reaper is a public endpoint that can fail other users' creates.
    expect(response.status).toBe(503);
    expect(runVmWorkflow).not.toHaveBeenCalled();
  });

  test("rejects a caller without the configured secret", async () => {
    const responses = await Promise.all([
      GET(new Request("https://cmux.test/api/cron/vm-reaper")),
      GET(new Request("https://cmux.test/api/cron/vm-reaper", {
        headers: { authorization: "Bearer wrong-secret" },
      })),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(401);
    }
    expect(runVmWorkflow).not.toHaveBeenCalled();
  });

  test("reaps for an authorized cron caller", async () => {
    const response = await GET(
      new Request("https://cmux.test/api/cron/vm-reaper", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, reaped: 2 });
    expect(runVmWorkflow).toHaveBeenCalled();
  });
});
