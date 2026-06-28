import * as path from "node:path";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { GraphBuilder } from "../graph/graph-builder";
import { Searcher } from "../search/searcher";
import { VectorDB } from "../store/vector-db";
import { ensureProjectPaths } from "../utils/project-root";
import { getLlmConfig } from "./config";
import {
  FORCE_FINAL_MESSAGE,
  MAX_ROUNDS,
  MAX_SEARCHES,
  SYSTEM_PROMPT,
  searchLimitMessage,
} from "./prompts";
import { executeTool, type InvestigateContext, TOOLS } from "./tools";

export interface InvestigateOptions {
  question: string;
  projectRoot: string;
  maxRounds?: number;
  verbose?: boolean;
}

export interface InvestigateResult {
  answer: string;
  rounds: number;
  toolCalls: number;
  wallMs: number;
}

function stripThinkTags(text: string): string {
  return text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/g, "").trim();
}

/**
 * Detect raw model tool-call markup leaking into `message.content`.
 *
 * Some local models (notably Qwen3.5-35B-A3B, which emits Qwen-XML tool calls)
 * trip a known llama.cpp `peg-native` parser bug: the call is never extracted
 * into structured `tool_calls` and instead leaks into `content` as raw markup
 * like `<tool_call>…`, `<function=peek>…`, or `<parameter=…>`. Returning that
 * verbatim as the "answer" is what this guards against.
 */
export function looksLikeRawToolCall(text: string): boolean {
  return /<tool_call\b|<\/?function[=\s>]|<parameter[=\s>]/i.test(text);
}

/** Guidance shown when a non-tool-calling model leaks raw tool-call markup. */
export function toolCallLeakHint(modelName: string): string {
  return (
    `The investigate tool needs a model that emits structured tool calls, but ` +
    `"${modelName}" returned raw tool-call markup instead. This is a known ` +
    `llama.cpp limitation for Qwen-XML tool-calling models — switch GMAX_LLM_MODEL ` +
    `to a Hermes-JSON tool-calling model (e.g. Qwen3-30B-A3B-Instruct-2507), or ` +
    `use review_commit / the gmax CLI search tools for this question.`
  );
}

/**
 * Turn a model message's content into the final answer: detect a tool-call leak
 * (return a clear hint), otherwise strip reasoning tags.
 */
export function finalizeAnswer(
  content: string | null | undefined,
  modelName: string,
): string {
  if (content && looksLikeRawToolCall(content)) {
    return toolCallLeakHint(modelName);
  }
  const stripped = content ? stripThinkTags(content) : "";
  return stripped || "(no response)";
}

export async function investigate(
  opts: InvestigateOptions,
): Promise<InvestigateResult> {
  const { question, projectRoot, verbose = false } = opts;
  const maxRounds = opts.maxRounds ?? MAX_ROUNDS;
  const config = getLlmConfig();
  const modelName = path.basename(config.model, path.extname(config.model));

  const client = new OpenAI({
    baseURL: `http://${config.host}:${config.port}/v1`,
    apiKey: "local",
  });

  // Health check
  try {
    await client.models.list();
  } catch {
    throw new Error(
      "Cannot connect to LLM server. Run `gmax llm on && gmax llm start`.",
    );
  }

  // Initialize gmax resources
  const paths = ensureProjectPaths(projectRoot);
  const vectorDb = new VectorDB(paths.lancedbDir);
  const searcher = new Searcher(vectorDb);
  const graphBuilder = new GraphBuilder(vectorDb, projectRoot);
  const ctx: InvestigateContext = {
    vectorDb,
    searcher,
    graphBuilder,
    projectRoot,
  };

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: question },
  ];

  const wallStart = Date.now();
  let searchCount = 0;
  let totalToolCalls = 0;
  let rounds = 0;

  try {
    for (let round = 0; round < maxRounds; round++) {
      rounds = round + 1;
      const roundStart = Date.now();

      const response = await client.chat.completions.create({
        model: modelName,
        messages,
        tools: TOOLS,
        tool_choice: "auto",
        temperature: 0,
      });

      if (!response.choices?.length) {
        throw new Error("LLM returned empty response");
      }

      const message = response.choices[0].message;
      const roundMs = Date.now() - roundStart;

      // No tool calls — final answer
      if (!message.tool_calls || message.tool_calls.length === 0) {
        if (verbose) {
          process.stderr.write(`[R${round}] Final answer (${roundMs}ms)\n`);
        }
        const answer = finalizeAnswer(message.content, modelName);
        return {
          answer,
          rounds,
          toolCalls: totalToolCalls,
          wallMs: Date.now() - wallStart,
        };
      }

      if (verbose) {
        process.stderr.write(
          `[R${round}] ${roundMs}ms — ${message.tool_calls.length} tool call(s)\n`,
        );
        if (message.content) {
          const reasoning = stripThinkTags(message.content);
          if (reasoning) {
            process.stderr.write(`  (reasoning) ${reasoning}\n`);
          }
        }
      }

      // Append assistant message (required before tool results)
      messages.push(message as ChatCompletionMessageParam);

      // Execute each tool call
      for (const tc of message.tool_calls) {
        // Only handle function-type tool calls
        if (tc.type !== "function") continue;
        const fn = tc.function;
        totalToolCalls++;
        let result: string;

        let args: Record<string, unknown>;
        try {
          args = JSON.parse(fn.arguments);
        } catch {
          args = {};
          result = `(error: malformed arguments: ${fn.arguments})`;
          messages.push({ role: "tool", tool_call_id: tc.id, content: result });
          continue;
        }

        // Search count limit
        if (fn.name === "search") {
          searchCount++;
          if (searchCount > MAX_SEARCHES) {
            result = searchLimitMessage(MAX_SEARCHES);
            if (verbose) {
              process.stderr.write(`  ${fn.name}() — BLOCKED (limit)\n`);
            }
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: result,
            });
            continue;
          }
        }

        if (verbose) {
          const argsStr = JSON.stringify(args);
          process.stderr.write(`  ${fn.name}(${argsStr})\n`);
        }

        result = await executeTool(fn.name, args, ctx);

        if (verbose) {
          const preview = result.split("\n").slice(0, 5).join("\n");
          const extra = result.split("\n").length - 5;
          for (const line of preview.split("\n")) {
            process.stderr.write(`    ${line}\n`);
          }
          if (extra > 0) {
            process.stderr.write(`    ... (${extra} more lines)\n`);
          }
        }

        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
    }

    // Round cap — force final answer
    if (verbose) {
      process.stderr.write(
        `[R${maxRounds}] Round cap reached, forcing final answer\n`,
      );
    }

    messages.push({ role: "user", content: FORCE_FINAL_MESSAGE });

    // No tools on the synthesis call. Note: tool_choice:"none" does NOT stop this
    // model from emitting a stray tool call here (verified 2026-06-28 — it still
    // leaks raw markup into content), so the finalizeAnswer guard is what protects
    // this path rather than a request-shape tweak.
    const response = await client.chat.completions.create({
      model: modelName,
      messages,
      temperature: 0,
    });

    if (!response.choices?.length) {
      throw new Error("LLM returned empty response");
    }

    const answer = finalizeAnswer(response.choices[0].message.content, modelName);

    return {
      answer,
      rounds: rounds + 1,
      toolCalls: totalToolCalls,
      wallMs: Date.now() - wallStart,
    };
  } finally {
    await vectorDb.close();
  }
}
