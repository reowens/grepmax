"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMxbaiClient = createMxbaiClient;
const sdk_1 = __importDefault(require("@mixedbread/sdk"));
const utils_1 = require("../utils");
const BASE_URL = (0, utils_1.isDevelopment)()
    ? "http://localhost:8000"
    : "https://api.mixedbread.com";
function createMxbaiClient(authToken) {
    if (!authToken) {
        throw new Error("Token is required");
    }
    return new sdk_1.default({
        baseURL: BASE_URL,
        apiKey: authToken,
    });
}
//# sourceMappingURL=mxbai.js.map