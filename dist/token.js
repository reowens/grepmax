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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.pollForToken = pollForToken;
exports.storeToken = storeToken;
exports.getStoredToken = getStoredToken;
exports.deleteToken = deleteToken;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const chalk_1 = __importDefault(require("chalk"));
const yocto_spinner_1 = __importDefault(require("yocto-spinner"));
const CONFIG_DIR = node_path_1.default.join(node_os_1.default.homedir(), ".mgrep");
const TOKEN_FILE = node_path_1.default.join(CONFIG_DIR, "token.json");
function pollForToken(authClient, deviceCode, clientId, initialInterval, expiresIn) {
    return __awaiter(this, void 0, void 0, function* () {
        let pollingInterval = initialInterval;
        const spinner = (0, yocto_spinner_1.default)({ text: "", color: "cyan" });
        let dots = 0;
        return new Promise((resolve, reject) => {
            let pollTimeout = null;
            let expirationTimeout = null;
            const cleanup = () => {
                if (pollTimeout)
                    clearTimeout(pollTimeout);
                if (expirationTimeout)
                    clearTimeout(expirationTimeout);
                spinner.stop();
            };
            // Set up expiration timeout
            expirationTimeout = setTimeout(() => {
                cleanup();
                reject(new Error("Device code has expired. Please run the login command again."));
            }, expiresIn * 1000);
            const poll = () => __awaiter(this, void 0, void 0, function* () {
                // Update spinner text with animated dots
                dots = (dots + 1) % 4;
                spinner.text = chalk_1.default.gray(`Polling for authorization${".".repeat(dots)}${" ".repeat(3 - dots)}`);
                if (!spinner.isSpinning)
                    spinner.start();
                try {
                    const { data, error } = yield authClient.device.token({
                        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                        device_code: deviceCode,
                        client_id: clientId,
                        fetchOptions: {
                            headers: {
                                "user-agent": "mgrep",
                            },
                        },
                    });
                    if (data === null || data === void 0 ? void 0 : data.access_token) {
                        cleanup();
                        resolve(data);
                        return;
                    }
                    else if (error) {
                        switch (error.error) {
                            case "authorization_pending":
                                // Continue polling
                                break;
                            case "slow_down":
                                pollingInterval += 5;
                                spinner.text = chalk_1.default.yellow(`Slowing down polling to ${pollingInterval}s`);
                                break;
                            case "access_denied":
                                cleanup();
                                reject(new Error("Access was denied by the user"));
                                return;
                            case "expired_token":
                                cleanup();
                                reject(new Error("The device code has expired. Please try again."));
                                return;
                            default:
                                cleanup();
                                reject(new Error(error.error_description || "Unknown error"));
                                return;
                        }
                    }
                }
                catch (err) {
                    cleanup();
                    const errorMessage = err instanceof Error ? err.message : "Unknown error";
                    reject(new Error(`Network error: ${errorMessage}`));
                    return;
                }
                pollTimeout = setTimeout(poll, pollingInterval * 1000);
            });
            // Start polling after initial interval
            pollTimeout = setTimeout(poll, pollingInterval * 1000);
        });
    });
}
function storeToken(token) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            // Ensure config directory exists
            yield promises_1.default.mkdir(CONFIG_DIR, { recursive: true });
            // Store token with metadata
            const tokenData = {
                access_token: token.access_token,
                token_type: token.token_type || "Bearer",
                scope: token.scope,
                expires_in: token.expires_in,
                created_at: new Date().toISOString(),
            };
            yield promises_1.default.writeFile(TOKEN_FILE, JSON.stringify(tokenData, null, 2), "utf-8");
        }
        catch (_error) {
            console.warn("Failed to store authentication token locally");
        }
    });
}
function getStoredToken() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const data = yield promises_1.default.readFile(TOKEN_FILE, "utf-8");
            return JSON.parse(data);
        }
        catch (_a) {
            return null;
        }
    });
}
function deleteToken() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            yield promises_1.default.unlink(TOKEN_FILE);
        }
        catch (error) {
            // Ignore error if file doesn't exist
            if (error.code !== "ENOENT") {
                throw error;
            }
        }
    });
}
//# sourceMappingURL=token.js.map