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
exports.logout = void 0;
exports.logoutAction = logoutAction;
const prompts_1 = require("@clack/prompts");
const chalk_1 = __importDefault(require("chalk"));
const commander_1 = require("commander");
const token_1 = require("./token");
function logoutAction() {
    return __awaiter(this, void 0, void 0, function* () {
        const token = yield (0, token_1.getStoredToken)();
        if (!token) {
            (0, prompts_1.outro)(chalk_1.default.blue("You are not logged in"));
            process.exit(0);
        }
        yield (0, token_1.deleteToken)();
        (0, prompts_1.outro)(chalk_1.default.green("✅ Successfully logged out"));
    });
}
exports.logout = new commander_1.Command("logout")
    .description("Logout from the Mixedbread platform")
    .action(logoutAction);
//# sourceMappingURL=logout.js.map