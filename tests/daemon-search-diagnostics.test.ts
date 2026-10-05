import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/utils/project-registry", () => ({
  getProject: () => ({ status: "indexed" }),
}));

import {
  type DaemonSearchDeps,
  handleDaemonSearch,
} from "../src/lib/daemon/search-handler";
import { SearchDiagnosticCollector } from "../src/lib/search/diagnostics";
import type { Searcher } from "../src/lib/search/searcher";

describe("daemon search diagnostics", () => {
  it.each([true, false])(
    "preserves request opt-in and response diagnostics=%s",
    async (requested) => {
      const diagnostics = new SearchDiagnosticCollector().finish({
        settings: {},
        fts: { available: true, searchFailed: false },
        gate: {
          requestedRerank: false,
          threshold: 0.7,
          evaluated: false,
          share: null,
          activated: false,
          rerankInvoked: false,
        },
      });
      const search = vi.fn(async () => ({ data: [], diagnostics }));
      const deps: DaemonSearchDeps = {
        vectorDb: {} as NonNullable<DaemonSearchDeps["vectorDb"]>,
        workerPool: {} as NonNullable<DaemonSearchDeps["workerPool"]>,
        processors: new Map(),
        indexProgress: new Map(),
        searchers: new Map([["/repo", { search } as unknown as Searcher]]),
        getIndexState: () => ({ indexing: false, pendingFiles: 0 }),
        touchActivity: vi.fn(),
        generation: null,
      };
      const response = await handleDaemonSearch(
        deps,
        {
          projectRoot: "/repo",
          query: "find request handler",
          limit: 10,
          diagnostics: requested,
        },
        new AbortController().signal,
      );
      expect(response.ok).toBe(true);
      expect(search).toHaveBeenCalledWith(
        "find request handler",
        10,
        expect.objectContaining({ diagnostics: requested }),
        undefined,
        undefined,
        undefined,
        expect.any(AbortSignal),
      );
      if (requested) expect(response.diagnostics).toBe(diagnostics);
      else expect(response).not.toHaveProperty("diagnostics");
    },
  );
});
