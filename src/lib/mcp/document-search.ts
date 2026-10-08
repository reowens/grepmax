// Dedicated stdio surface: no normal CLI, workers, models, native stores or watchers.
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { McpServer } from "@modelcontextprotocol/server";
import {
  StdioServerTransport,
  serveStdio,
} from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  canonicalPointer,
  DOCUMENT_CAPABILITIES,
  DOCUMENT_CONTRACT_VERSION,
  DOCUMENT_LIMITS,
  documentCoveragePaths,
  documentFailure,
  documentGeneration,
  documentIndexedAt,
  documentIndexState,
  documentMtime,
  documentPaths,
  documentQueryState,
  selectDocumentContext,
} from "./document-contract";

export function sendDocumentCommand(
  socketPath: string,
  cmd: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: socketPath });
    const decoder = new StringDecoder("utf8");
    let settled = false,
      bytes = 0,
      buffer = "";
    const finish = (response: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      socket.destroy();
      resolve(response);
    };
    const abort = () =>
      finish(
        documentFailure(
          signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled",
        ),
      );
    const timer = setTimeout(
      () => finish(documentFailure("timeout")),
      DOCUMENT_LIMITS.deadlineMs,
    );
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    socket.on("connect", () => socket.write(`${JSON.stringify(cmd)}\n`));
    socket.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > DOCUMENT_LIMITS.frameBytes) {
        finish(documentFailure("search_unavailable"));
        return;
      }
      buffer += decoder.write(chunk);
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, nl));
        finish(
          response && typeof response === "object" && !Array.isArray(response)
            ? response
            : documentFailure("search_unavailable"),
        );
      } catch {
        finish(documentFailure("search_unavailable"));
      }
    });
    socket.on("error", () => finish(documentFailure("daemon_unavailable")));
    socket.on("close", () => finish(documentFailure("daemon_unavailable")));
  });
}
export function runDocumentSearchBridge(): void {
  const home = path.resolve(
    process.env.GMAX_HOME ?? path.join(os.homedir(), ".gmax"),
  );
  const socket = path.join(home, "daemon.sock");
  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: DOCUMENT_LIMITS.frameBytes,
  });
  serveStdio(
    () => {
      const server = new McpServer({
        name: "gmax-document-search",
        version: "1",
      });
      const call = async (
        name: string,
        args: Record<string, unknown>,
        signal: AbortSignal,
      ) => {
        signal = AbortSignal.any([
          signal,
          AbortSignal.timeout(DOCUMENT_LIMITS.deadlineMs),
        ]);
        let response: Record<string, unknown>;
        try {
          const context = selectDocumentContext(home, process.cwd());
          const selection =
            name === "document_search_status"
              ? documentCoveragePaths(args.paths, context)
              : {
                  paths: documentPaths(args.prefixes, context, "prefixes"),
                  requested: 0,
                };
          const values = selection.paths;
          const ping = await sendDocumentCommand(
            socket,
            { cmd: "ping" },
            signal,
          );
          if (ping.ok !== true)
            response = documentFailure(
              typeof ping.state === "string"
                ? ping.state
                : "daemon_unavailable",
            );
          else if ((ping.capabilities as any)?.existingIndexOnlySearch !== 1)
            response = documentFailure("unsupported_daemon");
          else if (ping.ready !== true)
            response = documentFailure("index_unavailable");
          else if (!documentGeneration(ping.resourceGeneration))
            response = documentFailure("embedding_mismatch");
          else {
            const result = await sendDocumentCommand(
              socket,
              {
                cmd:
                  name === "document_search_status"
                    ? "documents.status"
                    : "documents.search",
                contractVersion: DOCUMENT_CONTRACT_VERSION,
                checkout: context.checkout,
                projectRoot: context.wireRoot,
                store: context.store,
                generation: ping.resourceGeneration,
                ...(name === "document_search_status"
                  ? { paths: args.paths }
                  : { query: args.query, prefixes: values }),
              },
              signal,
            );
            if (result.ok !== true)
              response = documentFailure(
                typeof result.state === "string"
                  ? result.state
                  : "search_unavailable",
              );
            else if (
              result.root !== context.root ||
              result.store !== context.store ||
              !documentGeneration(result.generation) ||
              result.generation !== ping.resourceGeneration
            )
              response = documentFailure("embedding_mismatch");
            else if (name === "document_search_status") {
              const seen = new Set<string>();
              const covered = (
                Array.isArray(result.covered) ? result.covered : []
              )
                .slice(0, DOCUMENT_LIMITS.paths)
                .flatMap((row) => {
                  const p =
                    typeof row?.path === "string" && values.includes(row.path)
                      ? canonicalPointer(row.path, context)
                      : null;
                  if (!p || seen.has(p)) return [];
                  seen.add(p);
                  return [
                    {
                      path: p,
                      ...pointerHash(row),
                      ...(documentMtime(row.indexedMtimeMs) !== null
                        ? { indexedMtimeMs: row.indexedMtimeMs }
                        : {}),
                    },
                  ];
                });
              response = {
                state: "ready",
                generation: result.generation,
                project: {
                  root: context.root,
                  store: context.store,
                  lastIndexed:
                    documentIndexedAt(result.lastIndexed) ??
                    context.lastIndexed,
                },
                embeddingReady:
                  result.embeddingReady === true &&
                  documentQueryState(result.queryState) === "ready",
                queryState: documentQueryState(result.queryState),
                covered,
                coverage: {
                  requested: selection.requested,
                  indexed: covered.length,
                  partial:
                    covered.length !== selection.requested ||
                    documentIndexState(result.indexState).degraded === true ||
                    (result.coverage as any)?.partial === true,
                },
                indexState: documentIndexState(result.indexState),
              };
            } else {
              const matches = (
                Array.isArray(result.matches) ? result.matches : []
              )
                .slice(0, DOCUMENT_LIMITS.candidates)
                .flatMap((row) => {
                  const p =
                    typeof row?.path === "string"
                      ? canonicalPointer(row.path, context)
                      : null;
                  const wire =
                    p &&
                    path.join(context.wireRoot, path.relative(context.root, p));
                  return p &&
                    wire &&
                    values.some(
                      (prefix) =>
                        wire === prefix || wire.startsWith(prefix + path.sep),
                    ) &&
                    Number.isInteger(row.startLine) &&
                    row.startLine > 0 &&
                    Number.isInteger(row.endLine) &&
                    row.endLine >= row.startLine &&
                    Number.isFinite(row.score)
                    ? [
                        {
                          path: p,
                          startLine: row.startLine,
                          endLine: row.endLine,
                          score: row.score,
                          ...pointerHash(row),
                        },
                      ]
                    : [];
                });
              response = {
                state: "ready",
                generation: result.generation,
                root: context.root,
                store: context.store,
                matches,
                indexState: documentIndexState(result.indexState),
              };
            }
          }
        } catch (error) {
          response = documentFailure((error as Error).message);
        }
        let structuredContent: Record<string, unknown> = {
          ...response,
          contractVersion: DOCUMENT_CONTRACT_VERSION,
          capabilities: DOCUMENT_CAPABILITIES,
        };
        if (
          Buffer.byteLength(JSON.stringify(structuredContent)) >
          DOCUMENT_LIMITS.frameBytes - 4096
        )
          structuredContent = {
            ...documentFailure("no_coverage"),
            contractVersion: DOCUMENT_CONTRACT_VERSION,
            capabilities: DOCUMENT_CAPABILITIES,
          };
        return {
          content: [
            {
              type: "text" as const,
              text: String(structuredContent.state ?? "search_unavailable"),
            },
          ],
          structuredContent,
        };
      };
      server.registerTool(
        "document_search_status",
        {
          inputSchema: z.object({
            paths: z.array(z.string()).max(DOCUMENT_LIMITS.paths),
          }),
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
        (args, context) =>
          call("document_search_status", args, context.mcpReq.signal),
      );
      server.registerTool(
        "semantic_search",
        {
          inputSchema: z.object({
            query: z.string().min(1).max(DOCUMENT_LIMITS.query),
            prefixes: z.array(z.string()).min(1).max(DOCUMENT_LIMITS.prefixes),
          }),
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
        (args, context) => call("semantic_search", args, context.mcpReq.signal),
      );
      return server;
    },
    {
      transport,
      legacy: "serve",
      onerror: () => {
        /* Never retain query-bearing diagnostics. */
      },
    },
  );
}
function pointerHash(row: Record<string, unknown>): Record<string, string> {
  return row.hashAlgorithm === "sha256-bytes" &&
    typeof row.hash === "string" &&
    /^[a-f0-9]{64}$/.test(row.hash)
    ? { hash: row.hash, hashAlgorithm: "sha256-bytes" }
    : {};
}
