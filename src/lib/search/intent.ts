export interface SearchIntent {
  type: "DEFINITION" | "FLOW" | "USAGE" | "ARCHITECTURE" | "GENERAL";
  filters?: {
    definitionsOnly?: boolean;
    usagesOnly?: boolean;
  };
  mode?: "orchestration_first" | "show_examples" | "group_by_role";
}

export function detectIntent(query: string): SearchIntent {
  const normalized = query.toLowerCase();

  // Definition queries
  if (/where is|what is|define/.test(normalized)) {
    return { type: "DEFINITION", filters: { definitionsOnly: true } };
  }

  // Implementation queries
  if (/how does|how is|implementation/.test(normalized)) {
    return { type: "FLOW", mode: "orchestration_first" };
  }

  // Usage queries
  if (/example|how to use|usage/.test(normalized)) {
    return { type: "USAGE", mode: "show_examples" };
  }

  // Architecture queries
  if (/architecture|system|overview/.test(normalized)) {
    return { type: "ARCHITECTURE", mode: "group_by_role" };
  }

  return { type: "GENERAL" };
}
