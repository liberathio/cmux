import {
  jsonResponse,
  notFoundVm,
  withAuthedVmApiRoute,
} from "../../../../../services/vms/routeHelpers";
import { setSpanAttributes } from "../../../../../services/telemetry";
import { isVmNotFoundError } from "../../../../../services/vms/errors";
import { execVm, runVmWorkflow } from "../../../../../services/vms/workflows";
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  MAX_EXEC_TIMEOUT_MS,
} from "../../../../../services/vms/config";

export const dynamic = "force-dynamic";
// Keep in sync with VM_ROUTE_MAX_DURATION_SECONDS; Next.js requires a literal here.
export const maxDuration = 60;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return withAuthedVmApiRoute(
    request,
    "/api/vm/[id]/exec",
    { "cmux.vm.operation": "exec" },
    "/api/vm/[id]/exec POST failed",
    async ({ user, span }) => {
      let rawBody: unknown;
      try {
        rawBody = await request.json();
      } catch {
        return jsonResponse({ error: "invalid JSON body" }, 400);
      }
      if (rawBody === null || typeof rawBody !== "object") {
        return jsonResponse({ error: "body must be a JSON object" }, 400);
      }
      const body = rawBody as { command?: unknown; timeoutMs?: unknown };
      if (typeof body.command !== "string" || body.command.length === 0) {
        return jsonResponse({ error: "`command` is required and must be a non-empty string" }, 400);
      }
      // Clamp the timeout so a client can't tie up provider quota on a runaway exec. The upper
      // bound is the function's own budget, not the provider's: Freestyle accepts 15 min, but
      // this request is killed at `maxDuration`, so a longer timeout only buys the caller a 504
      // with the command still running. Negative / non-number values fall back to the default.
      const rawTimeout = body.timeoutMs;
      const timeoutMs = typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0
        ? Math.min(Math.floor(rawTimeout), MAX_EXEC_TIMEOUT_MS)
        : DEFAULT_EXEC_TIMEOUT_MS;

      const { id } = await params;
      setSpanAttributes(span, {
        "cmux.vm.id": id,
        "cmux.command_length": body.command.length,
        "cmux.timeout_ms": timeoutMs,
      });
      try {
        const result = await runVmWorkflow(execVm({
          userId: user.id,
          providerVmId: id,
          command: body.command,
          timeoutMs,
        }));
        setSpanAttributes(span, { "cmux.exec.exit_code": result.exitCode });
        return jsonResponse(result);
      } catch (err) {
        if (isVmNotFoundError(err)) return notFoundVm(id);
        throw err;
      }
    },
  );
}
