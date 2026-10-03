export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const timeout = AbortSignal.timeout(
    url.startsWith("/api/compare") ||
      url.endsWith("/gate") ||
      (url === "/api/jobs" && options?.method === "POST")
      ? 240000
      : url.endsWith("/rerun") ||
          url === "/api/dry-run" ||
          (url === "/api/projects" && options?.method === "POST")
        ? 110000
        : 40000,
  );
  const signal = options?.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  const response = await fetch(url, { cache: "no-store", ...options, signal });
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    // A timeout or user cancellation can also interrupt the response body.
    signal.throwIfAborted();
    throw new Error("The server returned an unreadable response. Try again.");
  }
  if (!response.ok) {
    const message =
      data !== null && typeof data === "object" && "error" in data
        ? data.error
        : undefined;
    throw new Error(
      typeof message === "string" && message.trim()
        ? message
        : "Request failed. Try again.",
    );
  }
  return data as T;
}
