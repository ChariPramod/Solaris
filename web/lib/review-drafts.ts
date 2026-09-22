export type ReviewDraft = {
  verdict:
    "unreviewed" | "confirmed" | "needs-investigation" | "verifier-issue";
  category: "agent" | "environment" | "task" | "verifier" | "uncertain";
  note: string;
  reviewer: string;
};
export type DraftBase = { revision: number; evidenceDigest: string };
export type RetainedDraft = { draft: ReviewDraft; base: DraftBase };

/** Volatile, bounded navigation fallback. A page reload intentionally clears it. */
export function createReviewDraftCache(capacity = 32) {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100)
    throw new Error("Invalid draft capacity");
  const entries = new Map<string, RetainedDraft>();
  return {
    get(key: string): RetainedDraft | undefined {
      const value = entries.get(key);
      if (!value) return undefined;
      entries.delete(key);
      entries.set(key, value);
      return structuredClone(value);
    },
    set(key: string, value: RetainedDraft) {
      if (
        key.length > 300 ||
        value.draft.note.length > 8000 ||
        value.draft.reviewer.length > 120
      )
        throw new Error("Draft exceeds retention limits");
      entries.delete(key);
      entries.set(key, structuredClone(value));
      while (entries.size > capacity)
        entries.delete(entries.keys().next().value!);
    },
    remove(key: string, expected?: RetainedDraft) {
      if (
        !expected ||
        JSON.stringify(entries.get(key)) === JSON.stringify(expected)
      )
        entries.delete(key);
    },
  };
}
export const reviewDrafts = createReviewDraftCache();
