import { libraryQuery } from "./library-query";
import { StoreError } from "./store";

export function jobQuery(url: string) {
  const params = new URL(url).searchParams;
  const view = params.get("view") ?? "history";
  if (
    params.getAll("view").length > 1 ||
    !["history", "reserved"].includes(view)
  )
    throw new StoreError("Choose the history or reserved job view.", 400);
  if (view === "reserved") {
    if (params.has("limit") || params.has("cursor"))
      throw new StoreError(
        "The reserved job view does not accept archive pagination.",
        400,
      );
    return { view: "reserved" as const };
  }
  return { view: "history" as const, ...libraryQuery(url) };
}
