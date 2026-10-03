import type { Library, Run } from "./types";
type Tool = {
  name: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute: (input: unknown) => Promise<unknown>;
};
export type ModelContext = {
  registerTool: (
    tool: Tool,
    options: { signal: AbortSignal },
  ) => void | Promise<void>;
};
export function registerWorkspaceTools(
  actions: {
    list: (options?: { limit?: number; cursor?: string }) => Promise<Library>;
    read: (id: string) => Promise<Pick<Run, "id">>;
    open: (id: string) => void;
  },
  context?: ModelContext,
) {
  const registry =
    context ??
    (typeof document === "undefined"
      ? undefined
      : (document as Document & { modelContext?: ModelContext }).modelContext);
  if (!registry) return () => {};
  const lifecycle = new AbortController();
  const tools: Tool[] = [
    {
      name: "list_evaluations",
      description:
        "Read a page of saved evaluations, including warnings. Results cover the loaded page; follow page.nextCursor when present to read more. Does not run evaluations.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 200 },
          cursor: { type: "string", minLength: 1, maxLength: 4096 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute(input) {
        if (
          !input ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          Object.keys(input).some((key) => key !== "limit" && key !== "cursor")
        )
          throw new Error(
            "Provide only an optional page limit and continuation cursor.",
          );
        const { limit, cursor } = input as Record<string, unknown>;
        if (
          limit !== undefined &&
          (typeof limit !== "number" ||
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 200)
        )
          throw new Error("Choose a page size from 1 to 200.");
        if (
          cursor !== undefined &&
          (typeof cursor !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(cursor))
        )
          throw new Error("Invalid continuation cursor.");
        const result = await actions.list({
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        });
        return {
          runs: result.runs.map((r) => ({
            id: r.id,
            status: r.status,
            mode: r.mode,
            recorded: r.recorded,
            planned: r.planned_trials,
          })),
          warnings: result.warnings,
          page: result.page ?? null,
        };
      },
    },
    {
      name: "start_evaluation_inspection",
      description:
        "Open the saved-run inspector in the workspace. Starts loading evidence; does not launch or change an evaluation.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      async execute(input) {
        if (
          !input ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          Object.keys(input).length !== 1 ||
          !("id" in input) ||
          typeof input.id !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(input.id)
        )
          throw new Error("Provide one valid run id.");
        const result = await actions.read(input.id);
        if (result.id !== input.id) throw new Error("Run is unavailable.");
        actions.open(input.id);
        await new Promise<void>((resolve) =>
          typeof requestAnimationFrame === "function"
            ? requestAnimationFrame(() => resolve())
            : resolve(),
        );
        return { id: input.id, state: "inspection_opened" };
      },
    },
  ];
  for (const tool of tools) {
    try {
      void Promise.resolve(
        registry.registerTool(tool, { signal: lifecycle.signal }),
      ).catch(() => {});
    } catch {
      /* Unsupported draft API must never break the workspace. */
    }
  }
  return () => lifecycle.abort();
}
