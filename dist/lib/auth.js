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
exports.authClient = void 0;
exports.getJWTToken = getJWTToken;
const client_1 = require("better-auth/client");
const plugins_1 = require("better-auth/plugins");
const token_1 = require("../token");
const utils_1 = require("../utils");
const SERVER_URL = (0, utils_1.isDevelopment)()
    ? "http://localhost:3001"
    : "https://www.platform.mixedbread.com";
exports.authClient = (0, client_1.createAuthClient)({
    baseURL: SERVER_URL,
    plugins: [(0, plugins_1.deviceAuthorizationClient)()],
});
function getJWTToken() {
    return __awaiter(this, void 0, void 0, function* () {
        const token = yield (0, token_1.getStoredToken)();
        if (!token) {
            throw new Error("No authentication token found. Please run 'mgrep login' to authenticate.");
        }
        const response = yield fetch(`${SERVER_URL}/api/auth/token`, {
            headers: {
                Authorization: `Bearer ${token.access_token}`,
            },
        });
        if (!response.ok) {
            throw new Error("Failed to get JWT token. You token might have expired. Please run 'mgrep login' to authenticate.");
        }
        const data = yield response.json();
        if (!data.token) {
            throw new Error("Failed to get JWT token. You token might have expired. Please run 'mgrep login' to authenticate.");
        }
        return data.token;
    });
}
//# sourceMappingURL=auth.js.map