import { describe, expect, test } from "bun:test";
import { resolveVmEntitlements } from "../services/vms/entitlements";
import type { AuthedUser } from "../services/vms/auth";

function makeUser(overrides: Partial<AuthedUser> = {}): AuthedUser {
  return {
    id: "user_1",
    displayName: null,
    primaryEmail: null,
    billingCustomerType: "user",
    billingTeamId: "team_1",
    teamIds: ["team_1"],
    billingPlanId: null,
    ...overrides,
  };
}

describe("resolveVmEntitlements", () => {
  test("defaults an unknown plan to free with a single active VM", () => {
    const entitlements = resolveVmEntitlements(makeUser(), {});
    expect(entitlements).toEqual({
      planId: "free",
      billingTeamId: "team_1",
      maxActiveVms: 1,
    });
  });

  test("grants the paid default limit for a non-free plan", () => {
    const entitlements = resolveVmEntitlements(makeUser({ billingPlanId: "pro" }), {});
    expect(entitlements.planId).toBe("pro");
    expect(entitlements.maxActiveVms).toBe(10);
  });

  test("normalizes the plan id by trimming and lowercasing", () => {
    const entitlements = resolveVmEntitlements(makeUser({ billingPlanId: "  PRO  " }), {});
    expect(entitlements.planId).toBe("pro");
  });

  test("treats a blank plan id as free", () => {
    const entitlements = resolveVmEntitlements(makeUser({ billingPlanId: "   " }), {});
    expect(entitlements.planId).toBe("free");
    expect(entitlements.maxActiveVms).toBe(1);
  });

  test("falls back to CMUX_VM_DEFAULT_PLAN when the user has no plan", () => {
    const entitlements = resolveVmEntitlements(makeUser({ billingPlanId: null }), {
      CMUX_VM_DEFAULT_PLAN: "team",
    });
    expect(entitlements.planId).toBe("team");
    expect(entitlements.maxActiveVms).toBe(10);
  });

  test("honors plan-specific env overrides, including punctuated plan ids", () => {
    const entitlements = resolveVmEntitlements(makeUser({ billingPlanId: "pro-monthly" }), {
      CMUX_VM_PLAN_PRO_MONTHLY_MAX_ACTIVE_VMS: "42",
    });
    expect(entitlements.planId).toBe("pro-monthly");
    expect(entitlements.maxActiveVms).toBe(42);
  });

  test("allows overriding the free and paid default limits", () => {
    expect(
      resolveVmEntitlements(makeUser({ billingPlanId: "free" }), {
        CMUX_VM_FREE_MAX_ACTIVE_VMS: "3",
      }).maxActiveVms,
    ).toBe(3);
    expect(
      resolveVmEntitlements(makeUser({ billingPlanId: "enterprise" }), {
        CMUX_VM_PAID_MAX_ACTIVE_VMS: "99",
      }).maxActiveVms,
    ).toBe(99);
  });

  test("passes the billing team id straight through", () => {
    const entitlements = resolveVmEntitlements(makeUser({ billingTeamId: "team_xyz" }), {});
    expect(entitlements.billingTeamId).toBe("team_xyz");
  });

  test("rejects non-positive or non-integer limit overrides", () => {
    expect(() =>
      resolveVmEntitlements(makeUser({ billingPlanId: "free" }), {
        CMUX_VM_FREE_MAX_ACTIVE_VMS: "0",
      }),
    ).toThrow(/must be a positive integer/);
    expect(() =>
      resolveVmEntitlements(makeUser({ billingPlanId: "pro" }), {
        CMUX_VM_PAID_MAX_ACTIVE_VMS: "-5",
      }),
    ).toThrow(/must be a positive integer/);
    expect(() =>
      resolveVmEntitlements(makeUser({ billingPlanId: "pro" }), {
        CMUX_VM_PAID_MAX_ACTIVE_VMS: "ten",
      }),
    ).toThrow(/must be a positive integer/);
  });
});
