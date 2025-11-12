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
exports.computeBufferHash = computeBufferHash;
exports.computeFileHash = computeFileHash;
exports.getGitRepoFiles = getGitRepoFiles;
exports.isIgnoredByGit = isIgnoredByGit;
exports.isDevelopment = isDevelopment;
exports.listStoreFileHashes = listStoreFileHashes;
exports.filterRepoFiles = filterRepoFiles;
exports.ensureAuthenticated = ensureAuthenticated;
exports.uploadFile = uploadFile;
exports.initialSync = initialSync;
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const prompts_1 = require("@clack/prompts");
const p_limit_1 = __importDefault(require("p-limit"));
const login_1 = require("./login");
const token_1 = require("./token");
function computeBufferHash(buffer) {
    return (0, node_crypto_1.createHash)("sha256").update(buffer).digest("hex");
}
function computeFileHash(filePath, readFileSyncFn) {
    const buffer = readFileSyncFn(filePath);
    return computeBufferHash(buffer);
}
function getGitRepoFiles(repoRoot) {
    const run = (args) => {
        const res = (0, node_child_process_1.spawnSync)("git", args, { cwd: repoRoot, encoding: "utf-8" });
        if (res.error)
            return "";
        return res.stdout;
    };
    // Tracked files
    const tracked = run(["ls-files", "-z"]).split("\u0000").filter(Boolean);
    // Untracked but not ignored
    const untracked = run(["ls-files", "--others", "--exclude-standard", "-z"])
        .split("\u0000")
        .filter(Boolean);
    const allRel = Array.from(new Set([...tracked, ...untracked]));
    return allRel.map((rel) => path.join(repoRoot, rel));
}
function isIgnoredByGit(filePath, repoRoot) {
    try {
        const result = (0, node_child_process_1.spawnSync)("git", ["check-ignore", "-q", "--", filePath], {
            cwd: repoRoot,
        });
        return result.status === 0;
    }
    catch (_a) {
        return false;
    }
}
function isDevelopment() {
    // Check if running from node_modules (published package)
    if (__dirname.includes("node_modules")) {
        return false;
    }
    // Check if NODE_ENV is set to development
    if (process.env.NODE_ENV === "development") {
        return true;
    }
    // Default to local if we can't determine
    return true;
}
function listStoreFileHashes(client, store) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d;
        const byExternalId = new Map();
        let after;
        do {
            const resp = yield client.stores.files.list(store, { limit: 100, after });
            for (const f of resp.data) {
                const externalId = (_a = f.external_id) !== null && _a !== void 0 ? _a : undefined;
                if (!externalId)
                    continue;
                const metadata = (f.metadata || {});
                const hash = typeof (metadata === null || metadata === void 0 ? void 0 : metadata.hash) === "string" ? metadata.hash : undefined;
                byExternalId.set(externalId, hash);
            }
            after = ((_b = resp.pagination) === null || _b === void 0 ? void 0 : _b.has_more)
                ? ((_d = (_c = resp.pagination) === null || _c === void 0 ? void 0 : _c.last_cursor) !== null && _d !== void 0 ? _d : undefined)
                : undefined;
        } while (after);
        return byExternalId;
    });
}
function filterRepoFiles(files, repoRoot) {
    const filtered = [];
    for (const filePath of files) {
        try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile())
                continue;
        }
        catch (_a) {
            continue;
        }
        if (isIgnoredByGit(filePath, repoRoot))
            continue;
        filtered.push(filePath);
    }
    return filtered;
}
function ensureAuthenticated() {
    return __awaiter(this, void 0, void 0, function* () {
        const token = yield (0, token_1.getStoredToken)();
        if (token) {
            return;
        }
        const shouldLogin = yield (0, prompts_1.confirm)({
            message: "You are not logged in. Would you like to login now?",
            initialValue: true,
        });
        if ((0, prompts_1.isCancel)(shouldLogin) || !shouldLogin) {
            (0, prompts_1.cancel)("Operation cancelled");
            process.exit(0);
        }
        yield (0, login_1.loginAction)();
    });
}
function uploadFile(client, store, filePath, fileName) {
    return __awaiter(this, void 0, void 0, function* () {
        const buffer = yield fs.promises.readFile(filePath);
        if (buffer.length === 0) {
            return false;
        }
        const hash = computeBufferHash(buffer);
        const options = {
            external_id: filePath,
            overwrite: true,
            metadata: {
                path: filePath,
                hash,
            },
        };
        try {
            yield client.stores.files.upload(store, fs.createReadStream(filePath), options);
        }
        catch (_err) {
            yield client.stores.files.upload(store, new File([buffer], fileName, { type: "text/plain" }), options);
        }
        return true;
    });
}
function initialSync(client, store, repoRoot, onProgress) {
    return __awaiter(this, void 0, void 0, function* () {
        const storeHashes = yield listStoreFileHashes(client, store);
        const repoFiles = filterRepoFiles(getGitRepoFiles(repoRoot), repoRoot);
        const total = repoFiles.length;
        let processed = 0;
        let uploaded = 0;
        const concurrency = 100;
        const limit = (0, p_limit_1.default)(concurrency);
        yield Promise.all(repoFiles.map((filePath) => limit(() => __awaiter(this, void 0, void 0, function* () {
            try {
                const buffer = yield fs.promises.readFile(filePath);
                const hash = computeBufferHash(buffer);
                const existingHash = storeHashes.get(filePath);
                processed += 1;
                if (!existingHash || existingHash !== hash) {
                    const didUpload = yield uploadFile(client, store, filePath, path.basename(filePath));
                    if (didUpload) {
                        uploaded += 1;
                    }
                }
                onProgress === null || onProgress === void 0 ? void 0 : onProgress({ processed, uploaded, total, filePath });
            }
            catch (_err) {
                onProgress === null || onProgress === void 0 ? void 0 : onProgress({ processed, uploaded, total, filePath });
            }
        }))));
        return { processed, uploaded, total };
    });
}
//# sourceMappingURL=utils.js.map