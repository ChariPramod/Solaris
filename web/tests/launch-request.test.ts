import test from "node:test";
import assert from "node:assert/strict";
import {
  launchIdentity,
  pendingLaunchKey,
  finishLaunch,
} from "../lib/launch-request";
const setup = {
  tasks: ["T01", "T02"],
  trials: 1,
  concurrency: 1,
  maxInfraFailures: 1,
  provider: "claude" as const,
  modelId: "",
};
function fixture() {
  let data: string | null = null;
  return {
    storage: {
      getItem: () => data,
      setItem: (_name: string, value: string) => {
        data = value;
      },
    },
    corrupt: () => {
      data = "invalid";
    },
  };
}
test("unconfirmed UI launches retain identity across dialog instances, but confirmed requests allow new attempts", () => {
  const f = fixture();
  const identity = launchIdentity(setup, "dry-run");
  let serial = 0;
  const uuid = () =>
    `${String(++serial).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const first = pendingLaunchKey(identity, f.storage, 1, uuid);
  assert.equal(pendingLaunchKey(identity, f.storage, 2, uuid), first);
  assert.equal(
    launchIdentity({ ...setup, tasks: ["T02", "T01"] }, "dry-run"),
    identity,
  );
  finishLaunch(identity, first, f.storage);
  assert.notEqual(pendingLaunchKey(identity, f.storage, 3, uuid), first);
});
test("live mode and parent changes require separate request identities, corrupt pending state blocks ambiguous replay", () => {
  assert.notEqual(
    launchIdentity(setup, "dry-run"),
    launchIdentity(setup, "live"),
  );
  assert.notEqual(
    launchIdentity(setup, "dry-run"),
    launchIdentity(setup, "dry-run", "parent"),
  );
  const f = fixture();
  f.corrupt();
  assert.throws(() => pendingLaunchKey("request", f.storage), /unreadable/);
});
