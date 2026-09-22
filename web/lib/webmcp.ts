import type { Library } from "./types";
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
  actions: { list: () => Promise<Library>; open: (id: string) => void },
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
        "Read the local evaluation library, including warnings. Does not run evaluations.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute(input) {
        if (!input || typeof input !== "object" || Object.keys(input).length)
          throw new Error("Expected an empty object.");
        const result = await actions.list();
        return {
          runs: result.runs.map((r) => ({
            id: r.id,
            status: r.status,
            mode: r.mode,
            recorded: r.recorded,
            planned: r.planned_trials,
          })),
          warnings: result.warnings,
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
          Object.keys(input).length !== 1 ||
          !("id" in input) ||
          typeof input.id !== "string"
        )
          throw new Error("Provide one run id.");
        const result = await actions.list();
        if (!result.runs.some((r) => r.id === input.id))
          throw new Error("Run is unavailable.");
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
