import { describe, expect, mock, test } from "bun:test";

// routeHelpers imports ./auth -> ../../app/lib/stack -> ../env, which validates a large
// runtime env schema at module load. The helpers under test (parseBearer, jsonResponse,
// notFoundVm) never touch Stack Auth, so we stub the stack module to break that import
// chain and load the helpers deterministically without real credentials.
mock.module("../app/lib/stack", () => ({
  getStackServerApp: () => {
    throw new Error("stack auth is not used by route-helper unit tests");
  },
  isStackConfigured: () => false,
}));

const { jsonResponse, notFoundVm, parseBearer } = await import(
  "../services/vms/routeHelpers"
);

function requestWithHeaders(headers: Record<string, string>): Request {
  return new Request("https://app.example.com/api/mc/vms", { headers });
}

describe("parseBearer", () => {
  test("extracts the access and refresh token pair", () => {
    const bearer = parseBearer(
      requestWithHeaders({
        authorization: "Bearer access-123",
        "x-stack-refresh-token": "refresh-456",
      }),
    );
    expect(bearer).toEqual({ accessToken: "access-123", refreshToken: "refresh-456" });
  });

  test("is case-insensitive on the bearer scheme and trims values", () => {
    const bearer = parseBearer(
      requestWithHeaders({
        authorization: "bearer   access-123  ",
        "x-stack-refresh-token": "  refresh-456  ",
      }),
    );
    expect(bearer).toEqual({ accessToken: "access-123", refreshToken: "refresh-456" });
  });

  test("returns null when the authorization header is missing", () => {
    expect(parseBearer(requestWithHeaders({ "x-stack-refresh-token": "refresh" }))).toBeNull();
  });

  test("returns null when the refresh token header is missing", () => {
    expect(parseBearer(requestWithHeaders({ authorization: "Bearer access" }))).toBeNull();
  });

  test("returns null for a non-bearer scheme", () => {
    expect(
      parseBearer(
        requestWithHeaders({
          authorization: "Basic abc",
          "x-stack-refresh-token": "refresh",
        }),
      ),
    ).toBeNull();
  });

  test("returns null when the access token is blank after trimming", () => {
    expect(
      parseBearer(
        requestWithHeaders({
          authorization: "Bearer    ",
          "x-stack-refresh-token": "refresh",
        }),
      ),
    ).toBeNull();
  });
});

describe("jsonResponse", () => {
  test("defaults to 200 with a JSON content type and serialized body", async () => {
    const res = jsonResponse({ ok: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ ok: true });
  });

  test("uses the provided status code", async () => {
    const res = jsonResponse({ error: "forbidden" }, 403);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });
});

describe("notFoundVm", () => {
  test("returns a 404 whose body names the missing vm", async () => {
    const res = notFoundVm("vm_abc");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "vm not found: vm_abc" });
  });
});
