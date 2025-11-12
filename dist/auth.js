"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authClient = void 0;
const client_1 = require("better-auth/client");
const utils_1 = require("./utils");
const plugins_1 = require("better-auth/plugins");
const SERVER_URL = (0, utils_1.isDevelopment)()
    ? "http://localhost:3001"
    : "https://www.platform.mixedbread.com";
// Create the auth client
exports.authClient = (0, client_1.createAuthClient)({
    baseURL: SERVER_URL,
    plugins: [(0, plugins_1.deviceAuthorizationClient)()],
});
//# sourceMappingURL=auth.js.map