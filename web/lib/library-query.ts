import { StoreError } from "./store";

export function libraryQuery(url: string) {
  const params = new URL(url).searchParams;
  if (params.getAll("limit").length > 1 || params.getAll("cursor").length > 1)
    throw new StoreError("Use one limit and continuation cursor.", 400);
  const raw = params.get("limit") ?? "50";
  if (!/^[1-9]\d{0,2}$/.test(raw) || Number(raw) > 200)
    throw new StoreError("Choose a page size from 1 to 200.", 400);
  const cursor = params.get("cursor") ?? undefined;
  if (cursor !== undefined && !/^[\x21-\x7e]{1,4096}$/.test(cursor))
    throw new StoreError("Invalid continuation cursor.", 400);
  return { limit: Number(raw), ...(cursor === undefined ? {} : { cursor }) };
}
