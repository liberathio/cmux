import type { ProviderId } from "./drivers";
import { VmCreateDisabledError } from "./errors";

export type VmRuntimeEnv = Record<string, string | undefined>;

/**
 * Wall-clock budget for VM routes that wait on a provider call.
 *
 * Next.js only accepts a statically analyzable literal for `maxDuration`, so each route
 * repeats the number; this constant is the single place that documents it and the value the
 * exec timeout clamp is derived from. Keep the two in sync: a request allowed to outlive the
 * function budget can only end as a 504 with provider work still running.
 */
export const VM_ROUTE_MAX_DURATION_SECONDS = 60;

/**
 * Longest exec the route can honestly promise. Kept below the function budget so the caller
 * gets a real exit code or a real timeout, never a truncated connection.
 */
export const MAX_EXEC_TIMEOUT_MS = (VM_ROUTE_MAX_DURATION_SECONDS - 5) * 1000;

/** Exec timeout applied when the caller does not ask for one. */
export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;

export function assertVmCreateEnabled(
  provider: ProviderId,
  env: VmRuntimeEnv = process.env,
): void {
  if (isFalseFlag(env.CMUX_VM_CREATE_ENABLED)) {
    throw new VmCreateDisabledError({
      provider,
      reason: "Cloud VM creation is disabled",
    });
  }

  const providerKey = providerEnabledEnvKey(provider);
  if (isFalseFlag(env[providerKey])) {
    throw new VmCreateDisabledError({
      provider,
      reason: `${provider} VM creation is disabled`,
    });
  }
}

export function providerEnabledEnvKey(provider: ProviderId): string {
  switch (provider) {
    case "e2b":
      return "CMUX_VM_E2B_ENABLED";
    case "freestyle":
      return "CMUX_VM_FREESTYLE_ENABLED";
    default:
      return assertNever(provider);
  }
}

export function isDeployedRuntime(env: VmRuntimeEnv = process.env): boolean {
  return env.VERCEL === "1" ||
    env.VERCEL_ENV === "production" ||
    env.VERCEL_ENV === "preview" ||
    env.VERCEL_ENV === "staging";
}

export function allowUnmanifestedImages(env: VmRuntimeEnv = process.env): boolean {
  return isTrueFlag(env.CMUX_VM_ALLOW_UNMANIFESTED_IMAGES) || !isDeployedRuntime(env);
}

function isFalseFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  switch (value.trim().toLowerCase()) {
    case "0":
    case "false":
    case "no":
    case "off":
    case "disabled":
      return true;
    default:
      return false;
  }
}

function isTrueFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
    case "enabled":
      return true;
    default:
      return false;
  }
}

function assertNever(value: never): never {
  throw new Error(`unsupported VM provider: ${String(value)}`);
}
