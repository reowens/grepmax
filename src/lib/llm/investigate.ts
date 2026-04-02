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
import { type InvestigateContext, TOOLS, executeTool } from "./tools";

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
  return text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/g, "")
    .trim();
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
  const ctx: InvestigateContext = { vectorDb, searcher, graphBuilder, projectRoot };

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
        const answer = message.content
          ? stripThinkTags(message.content)
          : "(no response)";
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
            messages.push({ role: "tool", tool_call_id: tc.id, content: result });
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

    const response = await client.chat.completions.create({
      model: modelName,
      messages,
      temperature: 0,
    });

    if (!response.choices?.length) {
      throw new Error("LLM returned empty response");
    }

    const answer = response.choices[0].message.content
      ? stripThinkTags(response.choices[0].message.content)
      : "(no response)";

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
