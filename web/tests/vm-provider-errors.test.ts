import { describe, expect, test } from "bun:test";
import { isProviderNotFoundError } from "../services/vms/providerErrors";

describe("isProviderNotFoundError", () => {
  test("returns false for non-object inputs", () => {
    expect(isProviderNotFoundError(null)).toBe(false);
    expect(isProviderNotFoundError(undefined)).toBe(false);
    expect(isProviderNotFoundError("not found")).toBe(false);
    expect(isProviderNotFoundError(404)).toBe(false);
  });

  test("detects 404 across status, statusCode, and response.status", () => {
    expect(isProviderNotFoundError({ status: 404 })).toBe(true);
    expect(isProviderNotFoundError({ statusCode: 404 })).toBe(true);
    expect(isProviderNotFoundError({ response: { status: 404 } })).toBe(true);
  });

  test("detects not-found codes and names", () => {
    expect(isProviderNotFoundError({ code: "not_found" })).toBe(true);
    expect(isProviderNotFoundError({ code: "NotFound" })).toBe(true);
    expect(isProviderNotFoundError({ code: 404 })).toBe(true);
    expect(isProviderNotFoundError({ name: "NOT_FOUND" })).toBe(true);
  });

  test("matches provider-missing messages in both orderings", () => {
    expect(isProviderNotFoundError({ message: "Sandbox not found" })).toBe(true);
    expect(isProviderNotFoundError({ message: "The vm does not exist" })).toBe(true);
    expect(isProviderNotFoundError({ message: "no such instance abc123" })).toBe(true);
    expect(isProviderNotFoundError({ message: "container has been deleted" })).toBe(true);
  });

  test("matches a 404 in the message only when paired with a resource subject", () => {
    expect(isProviderNotFoundError({ message: "404 vm gone" })).toBe(true);
    expect(isProviderNotFoundError({ message: "error 40456 timeout" })).toBe(false);
    expect(isProviderNotFoundError({ message: "404 rate limited" })).toBe(false);
  });

  test("inspects response.data as string or object", () => {
    expect(isProviderNotFoundError({ response: { data: "instance not found" } })).toBe(true);
    expect(
      isProviderNotFoundError({ response: { data: { error: "sandbox was deleted" } } }),
    ).toBe(true);
    expect(isProviderNotFoundError({ response: { data: { error: "boom" } } })).toBe(false);
  });

  test("recurses into the cause chain", () => {
    expect(
      isProviderNotFoundError({ message: "wrapper", cause: { status: 404 } }),
    ).toBe(true);
    expect(
      isProviderNotFoundError({
        message: "wrapper",
        cause: { message: "deeper", cause: { message: "resource does not exist" } },
      }),
    ).toBe(true);
  });

  test("returns false for unrelated errors", () => {
    expect(isProviderNotFoundError({ status: 500, message: "internal error" })).toBe(false);
    expect(isProviderNotFoundError({ code: "rate_limited" })).toBe(false);
    expect(isProviderNotFoundError({ message: "permission denied" })).toBe(false);
    expect(isProviderNotFoundError({})).toBe(false);
  });
});
