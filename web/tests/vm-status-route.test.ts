import { beforeEach, describe, expect, mock, test } from "bun:test";
import { VmNotFoundError } from "../services/vms/errors";

const getUser = mock(async () => null);
const runVmWorkflow = mock(async () => {
  throw new Error("unauthenticated VM routes must not reach the VM workflow");
});
const destroyVm = mock(() => ({ workflow: "destroy" }));
const getUserVmStatus = mock(() => ({ workflow: "status" }));

mock.module("../app/lib/stack", () => ({
  getStackServerApp: () => ({ getUser }),
  isStackConfigured: () => true,
}));

// `mock.module` replaces the module for the whole test process, so every export the other
// VM route tests import has to stay present here too.
mock.module("../services/vms/workflows", () => ({
  createVm: mock(() => ({ workflow: "create" })),
  destroyVm,
  execVm: mock(() => ({ workflow: "exec" })),
  getUserVmStatus,
  listUserVms: mock(() => ({ workflow: "list" })),
  openAttachEndpoint: mock(() => ({ workflow: "attach" })),
  openSshEndpoint: mock(() => ({ workflow: "ssh" })),
  runVmWorkflow,
}));

const { GET } = await import("../app/api/vm/[id]/route");

beforeEach(() => {
  getUser.mockClear();
  getUser.mockResolvedValue(null);
  runVmWorkflow.mockClear();
  destroyVm.mockClear();
  getUserVmStatus.mockClear();
});

describe("GET /api/vm/[id]", () => {
  test("rejects unauthenticated status reads before reaching Postgres", async () => {
    const response = await GET(
      new Request("https://cmux.test/api/vm/provider-vm-1"),
      { params: Promise.resolve({ id: "provider-vm-1" }) },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(runVmWorkflow).not.toHaveBeenCalled();
  });

  test("reports a create that is still provisioning and has no provider VM id yet", async () => {
    getUser.mockResolvedValue(authedStackUser());
    runVmWorkflow.mockResolvedValue({
      providerVmId: null,
      status: "provisioning",
      provider: "e2b",
      image: "cmuxd-ws:test",
      imageVersion: "e2b-test",
      idempotencyKey: "idem-slow-create",
      createdAt: 1_777_000_000_000,
      failure: null,
    });

    const response = await GET(
      new Request("https://cmux.test/api/vm/idem-slow-create"),
      { params: Promise.resolve({ id: "idem-slow-create" }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: null,
      status: "provisioning",
      provider: "e2b",
      image: "cmuxd-ws:test",
      imageVersion: "e2b-test",
      idempotencyKey: "idem-slow-create",
      createdAt: 1_777_000_000_000,
    });
    // The client that lost its POST response only knows the idempotency key it sent, so the
    // path segment must be forwarded verbatim as a handle.
    expect(getUserVmStatus).toHaveBeenCalledWith({
      userId: "user-1",
      handle: "idem-slow-create",
    });
  });

  test("reports a finished create with its provider VM id", async () => {
    getUser.mockResolvedValue(authedStackUser());
    runVmWorkflow.mockResolvedValue({
      providerVmId: "provider-vm-1",
      status: "running",
      provider: "freestyle",
      image: "snapshot-test",
      imageVersion: null,
      idempotencyKey: "idem-1",
      createdAt: 1_777_000_000_000,
      failure: null,
    });

    const response = await GET(
      new Request("https://cmux.test/api/vm/provider-vm-1"),
      { params: Promise.resolve({ id: "provider-vm-1" }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "provider-vm-1",
      status: "running",
      provider: "freestyle",
    });
  });

  test("surfaces the recorded failure for a create that already failed", async () => {
    getUser.mockResolvedValue(authedStackUser());
    runVmWorkflow.mockResolvedValue({
      providerVmId: null,
      status: "failed",
      provider: "e2b",
      image: "cmuxd-ws:test",
      imageVersion: null,
      idempotencyKey: "idem-failed",
      createdAt: 1_777_000_000_000,
      failure: { code: "create", message: "provider unavailable" },
    });

    const response = await GET(
      new Request("https://cmux.test/api/vm/idem-failed"),
      { params: Promise.resolve({ id: "idem-failed" }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: null,
      status: "failed",
      failure: { code: "create", message: "provider unavailable" },
    });
  });

  test("returns 404 for a handle the caller does not own", async () => {
    getUser.mockResolvedValue(authedStackUser());
    runVmWorkflow.mockRejectedValue(new VmNotFoundError({ vmId: "provider-vm-other" }));

    const response = await GET(
      new Request("https://cmux.test/api/vm/provider-vm-other"),
      { params: Promise.resolve({ id: "provider-vm-other" }) },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "vm not found: provider-vm-other" });
  });
});

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
