import type {
  ScoredAudioURLInputChunk,
  ScoredImageURLInputChunk,
  ScoredTextInputChunk,
  ScoredVideoURLInputChunk,
} from "@mixedbread/sdk/resources/vector-stores/vector-stores";
import type { Command } from "commander";
import { Command as CommanderCommand } from "commander";
import { join } from "path";
import { getJWTToken } from "../lib/auth";
import { createMxbaiClient } from "../lib/mxbai";
import type { FileMetadata } from "../types";
import { ensureAuthenticated } from "../utils";

type ChunkType =
  | ScoredTextInputChunk
  | ScoredImageURLInputChunk
  | ScoredAudioURLInputChunk
  | ScoredVideoURLInputChunk;

function formatChunk(chunk: ChunkType) {
  const pwd = process.cwd();
  const path =
    (chunk.metadata as FileMetadata)?.path?.replace(pwd, "") ?? "Unknown path";
  let line_range = "";
  switch (chunk.type) {
    case "text":
      line_range = `, lines ${chunk.generated_metadata?.start_line} to ${(chunk.generated_metadata?.start_line as number) + (chunk.generated_metadata?.num_lines as number)}`;
      break;
    case "image_url":
      line_range =
        chunk.generated_metadata?.type === "pdf"
          ? `, page ${chunk.chunk_index + 1}`
          : "";
      break;
    case "audio_url":
      line_range = "";
      break;
    case "video_url":
      line_range = "";
      break;
  }
  return `.${path}${line_range}`;
}

export const search: Command = new CommanderCommand("search")
  .description("File pattern searcher")
  .option("-i", "Makes the search case-insensitive", false)
  .option("-r", "Recursive search", false)
  .option(
    "-m <max_count>, --max-count <max_count>",
    "The maximum number of results to return",
    "10",
  )
  .argument("<pattern>", "The pattern to search for")
  .argument("[path]", "The path to search in")
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (pattern, exec_path, _options, cmd) => {
    const options: { store: string; m: string } = cmd.optsWithGlobals();
    if (exec_path?.startsWith("--")) {
      exec_path = "";
    }

    await ensureAuthenticated();

    try {
      const jwtToken = await getJWTToken();
      const mxbai = createMxbaiClient(jwtToken);

      const search_path = join(process.cwd(), exec_path ?? "");

      const results = await mxbai.stores.search({
        query: pattern,
        store_identifiers: [options.store],
        top_k: parseInt(options.m),
        search_options: {
          rerank: true,
        },
        filters: {
          all: [
            {
              key: "path",
              operator: "starts_with",
              value: search_path,
            },
          ],
        },
      });

      console.log(results.data.map(formatChunk).join("\n"));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to search:", message);
      process.exitCode = 1;
    }
  });
