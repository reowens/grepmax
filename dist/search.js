"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.search = void 0;
const commander_1 = require("commander");
const path_1 = require("path");
const auth_1 = require("./lib/auth");
const mxbai_1 = require("./lib/mxbai");
const utils_1 = require("./utils");
function formatChunk(chunk) {
    var _a, _b, _c, _d, _e, _f, _g;
    const pwd = process.cwd();
    const path = (_c = (_b = (_a = chunk.metadata) === null || _a === void 0 ? void 0 : _a.path) === null || _b === void 0 ? void 0 : _b.replace(pwd, "")) !== null && _c !== void 0 ? _c : "Unknown path";
    let line_range = "";
    switch (chunk.type) {
        case "text":
            line_range = `, lines ${(_d = chunk.generated_metadata) === null || _d === void 0 ? void 0 : _d.start_line} to ${((_e = chunk.generated_metadata) === null || _e === void 0 ? void 0 : _e.start_line) + ((_f = chunk.generated_metadata) === null || _f === void 0 ? void 0 : _f.num_lines)}`;
            break;
        case "image_url":
            line_range =
                ((_g = chunk.generated_metadata) === null || _g === void 0 ? void 0 : _g.type) === "pdf"
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
exports.search = new commander_1.Command("search")
    .description("File pattern searcher")
    .option("-i", "Makes the search case-insensitive", false)
    .option("-r", "Recursive search", false)
    .option("-m <max_count>, --max-count <max_count>", "The maximum number of results to return", "10")
    .argument("<pattern>", "The pattern to search for")
    .argument("[path]", "The path to search in")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action((pattern, exec_path, _options, cmd) => __awaiter(void 0, void 0, void 0, function* () {
    const options = cmd.optsWithGlobals();
    if (exec_path === null || exec_path === void 0 ? void 0 : exec_path.startsWith("--")) {
        exec_path = "";
    }
    yield (0, utils_1.ensureAuthenticated)();
    try {
        const jwtToken = yield (0, auth_1.getJWTToken)();
        const mxbai = (0, mxbai_1.createMxbaiClient)(jwtToken);
        const search_path = (0, path_1.join)(process.cwd(), exec_path !== null && exec_path !== void 0 ? exec_path : "");
        const results = yield mxbai.stores.search({
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
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("Failed to search:", message);
        process.exitCode = 1;
    }
}));
//# sourceMappingURL=search.js.map