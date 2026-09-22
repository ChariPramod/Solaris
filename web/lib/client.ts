export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const timeout = AbortSignal.timeout(
    url.endsWith("/rerun") || url === "/api/dry-run" ? 110000 : 40000,
  );
  const signal = options?.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  const response = await fetch(url, { cache: "no-store", ...options, signal });
  const data = await response
    .json()
    .catch(() => ({
      error: "The server returned an unreadable response. Try again.",
    }));
  if (!response.ok) throw new Error(data.error || "Request failed. Try again.");
  return data;
}
