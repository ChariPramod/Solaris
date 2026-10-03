import { setupIdentity } from "./launch-readiness";
import type { RunSetup } from "./types";
type Entry = { identity: string; key: string; createdAt: number };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
const NAME = "solaris.pending-launches.v1";
const memory = new Map<string, string>();
const fallback: Storage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => {
    memory.set(key, value);
  },
};
function browserStorage(): Storage {
  try {
    return typeof window === "undefined" ? fallback : window.sessionStorage;
  } catch {
    return fallback;
  }
}
export function launchIdentity(
  setup: RunSetup,
  mode: "dry-run" | "live",
  parentId?: string,
) {
  return JSON.stringify([setupIdentity(setup), mode, parentId ?? null]);
}
function entries(storage: Storage): Entry[] {
  const raw = storage.getItem(NAME);
  if (raw === null) return [];
  try {
    const values: unknown = JSON.parse(raw);
    if (
      !Array.isArray(values) ||
      values.length > 32 ||
      values.some(
        (v) =>
          !v ||
          typeof v.identity !== "string" ||
          typeof v.key !== "string" ||
          !/^ui-[a-f0-9-]{36}$/.test(v.key) ||
          !Number.isFinite(v.createdAt),
      )
    )
      throw new Error();
    return values as Entry[];
  } catch {
    throw new Error(
      "Pending launch history is unreadable. Inspect Execution jobs before clearing this browser session.",
    );
  }
}
/** Keep an uncertain launch identity across closing the dialog or reloading the tab. */
export function pendingLaunchKey(
  identity: string,
  storage = browserStorage(),
  now = Date.now(),
  uuid = () => crypto.randomUUID(),
) {
  const saved = entries(storage);
  const existing = saved.find((v) => v.identity === identity);
  if (existing) return existing.key;
  if (saved.length >= 32)
    throw new Error(
      "Too many unconfirmed launches. Inspect Execution jobs before clearing this browser session.",
    );
  const key = `ui-${uuid()}`;
  storage.setItem(
    NAME,
    JSON.stringify([...saved, { identity, key, createdAt: now }]),
  );
  return key;
}
export function finishLaunch(
  identity: string,
  key: string,
  storage = browserStorage(),
) {
  storage.setItem(
    NAME,
    JSON.stringify(
      entries(storage).filter((v) => v.identity !== identity || v.key !== key),
    ),
  );
}
