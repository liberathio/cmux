import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import postgres, { type Sql } from "postgres";
import { closeCloudDbForTests } from "../db/client";
import { VmRepositoryLive } from "../services/vms/repository";
import { reapStuckProvisioningVms } from "../services/vms/workflows";

const runDbTests = process.env.CMUX_DB_TEST === "1";
const dbTest = runDbTests ? test : test.skip;

let sql: Sql | null = null;

beforeAll(() => {
  if (!runDbTests) return;
  const databaseURL = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseURL) {
    throw new Error("DATABASE_URL is required when CMUX_DB_TEST=1");
  }
  sql = postgres(databaseURL, { max: 1 });
});

afterAll(async () => {
  await closeCloudDbForTests();
  await sql?.end();
});

describe("stuck provisioning reaper", () => {
  dbTest("fails creates whose function died before the provider answered", async () => {
    if (!sql) throw new Error("test database not initialized");
    await sql`truncate cloud_vm_usage_events, cloud_vm_leases, cloud_vms restart identity cascade`;

    // Abandoned: the serverless function was killed before markCreateRunning ran.
    await sql`
      insert into cloud_vms (user_id, billing_team_id, provider, image_id, status, idempotency_key, created_at)
      values ('user-reaper', 'team-reaper', 'e2b', 'cmuxd-ws:test', 'provisioning', 'reaper-stale', now() - interval '2 hours')
    `;
    // Still plausibly in flight.
    await sql`
      insert into cloud_vms (user_id, billing_team_id, provider, image_id, status, idempotency_key, created_at)
      values ('user-reaper', 'team-reaper', 'e2b', 'cmuxd-ws:test', 'provisioning', 'reaper-fresh', now())
    `;
    // Old, but the provider did answer: this VM exists and must not be touched.
    await sql`
      insert into cloud_vms (user_id, billing_team_id, provider, provider_vm_id, image_id, status, idempotency_key, created_at)
      values ('user-reaper', 'team-reaper', 'e2b', 'reaper-real-vm', 'cmuxd-ws:test', 'provisioning', 'reaper-has-vm', now() - interval '2 hours')
    `;

    const reaped = await Effect.runPromise(
      reapStuckProvisioningVms({ staleAfterMs: 15 * 60 * 1000 }).pipe(
        Effect.provide(VmRepositoryLive),
      ),
    );

    expect(reaped.reaped).toBe(1);

    const rows = await sql<{ idempotencyKey: string; status: string; failureCode: string | null }[]>`
      select idempotency_key as "idempotencyKey", status, failure_code as "failureCode"
      from cloud_vms
      where user_id = 'user-reaper'
      order by idempotency_key
    `;
    expect(rows).toEqual([
      { idempotencyKey: "reaper-fresh", status: "provisioning", failureCode: null },
      { idempotencyKey: "reaper-has-vm", status: "provisioning", failureCode: null },
      { idempotencyKey: "reaper-stale", status: "failed", failureCode: "create_abandoned" },
    ]);
  });

  dbTest("releases the active VM slot the abandoned create was holding", async () => {
    if (!sql) throw new Error("test database not initialized");
    await sql`truncate cloud_vm_usage_events, cloud_vm_leases, cloud_vms restart identity cascade`;
    await sql`
      insert into cloud_vms (user_id, billing_team_id, provider, image_id, status, idempotency_key, created_at)
      values ('user-reaper-slot', 'team-reaper-slot', 'e2b', 'cmuxd-ws:test', 'provisioning', 'slot-stale', now() - interval '2 hours')
    `;

    const activeBefore = await countActive(sql, "team-reaper-slot");
    await Effect.runPromise(
      reapStuckProvisioningVms({ staleAfterMs: 15 * 60 * 1000 }).pipe(
        Effect.provide(VmRepositoryLive),
      ),
    );
    const activeAfter = await countActive(sql, "team-reaper-slot");

    // beginCreate counts `provisioning` towards the active limit, so an abandoned row locks a
    // paying team out of creating any VM until it is resolved.
    expect(activeBefore).toBe(1);
    expect(activeAfter).toBe(0);
  });

  dbTest("records a usage event so reaping is auditable", async () => {
    if (!sql) throw new Error("test database not initialized");
    await sql`truncate cloud_vm_usage_events, cloud_vm_leases, cloud_vms restart identity cascade`;
    await sql`
      insert into cloud_vms (user_id, billing_team_id, provider, image_id, status, idempotency_key, created_at)
      values ('user-reaper-audit', 'team-reaper-audit', 'e2b', 'cmuxd-ws:test', 'provisioning', 'audit-stale', now() - interval '2 hours')
    `;

    await Effect.runPromise(
      reapStuckProvisioningVms({ staleAfterMs: 15 * 60 * 1000 }).pipe(
        Effect.provide(VmRepositoryLive),
      ),
    );

    const events = await sql<{ eventType: string }[]>`
      select event_type as "eventType" from cloud_vm_usage_events where user_id = 'user-reaper-audit'
    `;
    expect(events.map((event) => event.eventType)).toEqual(["vm.create.abandoned"]);
  });

  dbTest("is idempotent across repeated runs", async () => {
    if (!sql) throw new Error("test database not initialized");
    await sql`truncate cloud_vm_usage_events, cloud_vm_leases, cloud_vms restart identity cascade`;
    await sql`
      insert into cloud_vms (user_id, billing_team_id, provider, image_id, status, idempotency_key, created_at)
      values ('user-reaper-twice', 'team-reaper-twice', 'e2b', 'cmuxd-ws:test', 'provisioning', 'twice-stale', now() - interval '2 hours')
    `;

    const first = await Effect.runPromise(
      reapStuckProvisioningVms({ staleAfterMs: 15 * 60 * 1000 }).pipe(
        Effect.provide(VmRepositoryLive),
      ),
    );
    const second = await Effect.runPromise(
      reapStuckProvisioningVms({ staleAfterMs: 15 * 60 * 1000 }).pipe(
        Effect.provide(VmRepositoryLive),
      ),
    );

    expect(first.reaped).toBe(1);
    expect(second.reaped).toBe(0);
    const events = await sql<{ total: string }[]>`
      select count(*)::text as total from cloud_vm_usage_events where user_id = 'user-reaper-twice'
    `;
    expect(events[0]?.total).toBe("1");
  });
});

async function countActive(sql: Sql, billingTeamId: string): Promise<number> {
  const [row] = await sql<{ total: string }[]>`
    select count(*)::text as total from cloud_vms
    where billing_team_id = ${billingTeamId} and status in ('provisioning', 'running', 'paused')
  `;
  return Number(row?.total ?? 0);
}
