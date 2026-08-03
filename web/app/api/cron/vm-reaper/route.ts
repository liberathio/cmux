// Scheduled cleanup for VM creates that never finished. Not part of the public `/api/vm`
// surface: the only caller is the Vercel cron, authenticated with CRON_SECRET.

import { jsonResponse } from "../../../../services/vms/jsonResponse";
import { recordSpanError, withApiRouteSpan, setSpanAttributes } from "../../../../services/telemetry";
import {
  reapStuckProvisioningVms,
  runVmWorkflow,
} from "../../../../services/vms/workflows";

export const dynamic = "force-dynamic";
// Keep in sync with VM_ROUTE_MAX_DURATION_SECONDS; Next.js requires a literal here.
export const maxDuration = 60;

/**
 * How long a create may sit in `provisioning` before it is considered abandoned. Far above the
 * route's own `maxDuration`, so any request that could still be running is left alone.
 */
const STALE_AFTER_MS = 15 * 60 * 1000;

export async function GET(request: Request): Promise<Response> {
  return withApiRouteSpan(
    request,
    "/api/cron/vm-reaper",
    { "cmux.subsystem": "vm-cloud", "cmux.vm.operation": "reap" },
    async (span) => {
      const secret = process.env.CRON_SECRET;
      if (!secret) {
        // Fail closed. Without a secret this route would let anyone fail other users' creates.
        return jsonResponse({ error: "cron_secret_not_configured" }, 503);
      }
      if (request.headers.get("authorization") !== `Bearer ${secret}`) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }

      try {
        const result = await runVmWorkflow(
          reapStuckProvisioningVms({ staleAfterMs: STALE_AFTER_MS }),
        );
        setSpanAttributes(span, {
          "cmux.vm.reaped": result.reaped,
          "cmux.vm.scanned": result.scanned,
        });
        return jsonResponse({ ok: true, reaped: result.reaped });
      } catch (err) {
        recordSpanError(span, err);
        console.error("/api/cron/vm-reaper GET failed", err);
        return jsonResponse({ error: "reaper failed" }, 500);
      }
    },
  );
}
