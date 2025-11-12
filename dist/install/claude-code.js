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
exports.installClaudeCode = void 0;
const child_process_1 = require("child_process");
const commander_1 = require("commander");
const login_1 = require("../login");
function installPlugin() {
    (0, child_process_1.exec)("claude plugin marketplace add mixedbread-ai/mgrep", (error) => {
        if (error) {
            console.error(`Error installing plugin: ${error}`);
            process.exit(1);
        }
        console.log("Successfully added the mixedbread-ai/mgrep plugin to the marketplace");
        (0, child_process_1.exec)("claude plugin install mgrep", (error) => {
            if (error) {
                console.error(`Error installing plugin: ${error}`);
                process.exit(1);
            }
            console.log("Successfully installed the mgrep plugin");
        });
    });
}
exports.installClaudeCode = new commander_1.Command("install-claude-code")
    .description("Install the Claude Code plugin")
    .action(() => __awaiter(void 0, void 0, void 0, function* () {
    yield (0, login_1.loginAction)();
    yield installPlugin();
}));
//# sourceMappingURL=claude-code.js.map