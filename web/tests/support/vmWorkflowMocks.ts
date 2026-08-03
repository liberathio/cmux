import { mock } from "bun:test";
import * as realWorkflows from "../../services/vms/workflows";

/**
 * `mock.module` replaces a module for the whole test process, not just the file that called it.
 * A hand-written literal therefore has to list every export the *other* test files import, and
 * adding one workflow used to break unrelated suites with "Export named X not found".
 *
 * Deriving the mock from the real module's key set removes that failure mode: a new export is
 * stubbed automatically, and only the workflows a test actually asserts on need an override.
 */
export function createVmWorkflowMocks(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const stubs = Object.fromEntries(
    Object.keys(realWorkflows).map((name) => [name, mock(() => ({ workflow: name }))]),
  );
  return { ...stubs, ...overrides };
}
