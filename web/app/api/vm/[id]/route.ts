import {
  jsonResponse,
  notFoundVm,
  withAuthedVmApiRoute,
} from "../../../../services/vms/routeHelpers";
import { setSpanAttributes } from "../../../../services/telemetry";
import { isVmNotFoundError } from "../../../../services/vms/errors";
import {
  destroyVm,
  getUserVmStatus,
  runVmWorkflow,
} from "../../../../services/vms/workflows";

export const dynamic = "force-dynamic";
// Keep in sync with VM_ROUTE_MAX_DURATION_SECONDS; Next.js requires a literal here.
export const maxDuration = 60;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return withAuthedVmApiRoute(
    request,
    "/api/vm/[id]",
    { "cmux.vm.operation": "status" },
    "/api/vm/[id] GET failed",
    async ({ user, span }) => {
      const { id } = await params;
      setSpanAttributes(span, { "cmux.vm.handle": id });
      let status;
      try {
        // `id` is a handle: the provider VM id when the caller has one, otherwise the
        // idempotency key it sent to POST /api/vm. The latter is the only identifier a
        // client still holds when the create request outlived the function duration.
        status = await runVmWorkflow(getUserVmStatus({ userId: user.id, handle: id }));
      } catch (err) {
        if (isVmNotFoundError(err)) return notFoundVm(id);
        throw err;
      }
      setSpanAttributes(span, {
        "cmux.vm.status": status.status,
        "cmux.vm.id": status.providerVmId ?? undefined,
      });
      // REST adapter: same `id` naming as GET /api/vm, but null until the provider VM exists.
      return jsonResponse({
        id: status.providerVmId,
        status: status.status,
        provider: status.provider,
        image: status.image,
        imageVersion: status.imageVersion,
        idempotencyKey: status.idempotencyKey,
        createdAt: status.createdAt,
        ...(status.failure ? { failure: status.failure } : {}),
      });
    },
  );
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return withAuthedVmApiRoute(
    request,
    "/api/vm/[id]",
    { "cmux.vm.operation": "destroy" },
    "/api/vm/[id] DELETE failed",
    async ({ user, span }) => {
      const { id } = await params;
      setSpanAttributes(span, { "cmux.vm.id": id });
      try {
        await runVmWorkflow(destroyVm({ userId: user.id, providerVmId: id }));
      } catch (err) {
        if (isVmNotFoundError(err)) return notFoundVm(id);
        throw err;
      }
      return jsonResponse({ ok: true });
    },
  );
}
