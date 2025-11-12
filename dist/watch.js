"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.watch = void 0;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const commander_1 = require("commander");
const ora_1 = __importDefault(require("ora"));
const auth_1 = require("./lib/auth");
const mxbai_1 = require("./lib/mxbai");
const utils_1 = require("./utils");
exports.watch = new commander_1.Command("watch")
    .description("Watch for file changes")
    .action((_args, cmd) => __awaiter(void 0, void 0, void 0, function* () {
    const options = cmd.optsWithGlobals();
    yield (0, utils_1.ensureAuthenticated)();
    try {
        const jwtToken = yield (0, auth_1.getJWTToken)();
        const mxbai = (0, mxbai_1.createMxbaiClient)(jwtToken);
        const watchRoot = process.cwd();
        const spinner = (0, ora_1.default)({ text: "Indexing files..." }).start();
        let lastProcessed = 0;
        let lastUploaded = 0;
        let lastTotal = 0;
        try {
            try {
                yield mxbai.stores.retrieve(options.store);
            }
            catch (_a) {
                yield mxbai.stores.create({
                    name: options.store,
                    description: "MGrep store - Mixedbreads mulitmodal mulitlingual magic search",
                });
            }
            const result = yield (0, utils_1.initialSync)(mxbai, options.store, watchRoot, (info) => {
                var _a, _b;
                lastProcessed = info.processed;
                lastUploaded = info.uploaded;
                lastTotal = info.total;
                const rel = ((_a = info.filePath) === null || _a === void 0 ? void 0 : _a.startsWith(watchRoot))
                    ? path.relative(watchRoot, info.filePath)
                    : ((_b = info.filePath) !== null && _b !== void 0 ? _b : "");
                spinner.text = `Indexing files (${lastProcessed}/${lastTotal}) • uploaded ${lastUploaded} ${rel}`;
            });
            spinner.succeed(`Initial sync complete (${result.processed}/${result.total}) • uploaded ${result.uploaded}`);
        }
        catch (e) {
            spinner.fail("Initial upload failed");
            throw e;
        }
        console.log("Watching for file changes in", watchRoot);
        fs.watch(watchRoot, { recursive: true }, (eventType, rawFilename) => {
            const filename = rawFilename === null || rawFilename === void 0 ? void 0 : rawFilename.toString();
            if (!filename) {
                return;
            }
            const filePath = path.join(watchRoot, filename);
            console.log(`${eventType}: ${filePath}`);
            try {
                const stat = fs.statSync(filePath);
                if (!stat.isFile()) {
                    return;
                }
            }
            catch (_a) {
                return;
            }
            if ((0, utils_1.isIgnoredByGit)(filePath, watchRoot)) {
                return;
            }
            (0, utils_1.uploadFile)(mxbai, options.store, filePath, filename).catch((err) => {
                console.error("Failed to upload changed file:", filePath, err);
            });
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("Failed to start watcher:", message);
        process.exitCode = 1;
    }
}));
//# sourceMappingURL=watch.js.map