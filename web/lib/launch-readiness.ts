import type { Readiness, RunSetup } from "./types";
export type LaunchCheck = {
  setup: string;
  checkedAt: number;
  result: Readiness;
};
export const LIVE_CHECK_LIFETIME = 5 * 60 * 1000;
/** A check is guidance for this exact plan, never provider authentication or authorization. */
export function setupIdentity(setup: RunSetup) {
  return JSON.stringify([
    [...setup.tasks].sort(),
    setup.trials,
    setup.concurrency,
    setup.maxInfraFailures,
    setup.provider,
    setup.modelId,
  ]);
}
export function liveCheckAllowsLaunch(
  check: LaunchCheck | null,
  setup: RunSetup,
  now = Date.now(),
) {
  return (
    !!check &&
    check.setup === setupIdentity(setup) &&
    now >= check.checkedAt &&
    now - check.checkedAt < LIVE_CHECK_LIFETIME &&
    check.result.ready &&
    check.result.checks.length > 0 &&
    check.result.checks.every(
      (item) => item.status === "pass" || item.status === "warning",
    )
  );
}
