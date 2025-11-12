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
exports.login = void 0;
exports.loginAction = loginAction;
const prompts_1 = require("@clack/prompts");
const chalk_1 = __importDefault(require("chalk"));
const commander_1 = require("commander");
const open_1 = __importDefault(require("open"));
const yocto_spinner_1 = __importDefault(require("yocto-spinner"));
const auth_1 = require("./lib/auth");
const token_1 = require("./token");
const CLIENT_ID = "mgrep";
function loginAction() {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        (0, prompts_1.intro)(chalk_1.default.bold("🔐 Mixedbread Login"));
        // Check if already logged in
        const existingToken = yield (0, token_1.getStoredToken)();
        if (existingToken) {
            const shouldReauth = yield (0, prompts_1.confirm)({
                message: "You're already logged in. Do you want to log in again?",
                initialValue: false,
            });
            if ((0, prompts_1.isCancel)(shouldReauth) || !shouldReauth) {
                (0, prompts_1.cancel)("Login cancelled");
                process.exit(0);
            }
        }
        const spinner = (0, yocto_spinner_1.default)({ text: "Requesting device authorization..." });
        spinner.start();
        try {
            // Request device code
            const { data, error } = yield auth_1.authClient.device.code({
                client_id: CLIENT_ID,
                scope: "openid profile email",
            });
            spinner.stop();
            if (error || !data) {
                console.error(`Failed to request device authorization: ${(error === null || error === void 0 ? void 0 : error.error_description) || "Unknown error"}`);
                process.exit(1);
            }
            const { device_code, user_code, verification_uri, verification_uri_complete, interval = 5, expires_in, } = data;
            // Display authorization instructions
            console.log("");
            console.log(chalk_1.default.cyan("📱 Device Authorization Required"));
            console.log("");
            console.log("Login to your Mixedbread platform account, then:");
            console.log(`Please visit: ${chalk_1.default.underline.blue(`${verification_uri}?user_code=${user_code}`)}`);
            console.log(`Enter code: ${chalk_1.default.bold.green(user_code)}`);
            console.log("");
            // Ask if user wants to open browser
            const shouldOpen = yield (0, prompts_1.confirm)({
                message: "Open browser automatically?",
                initialValue: true,
            });
            if (!(0, prompts_1.isCancel)(shouldOpen) && shouldOpen) {
                const urlToOpen = verification_uri_complete || verification_uri;
                yield (0, open_1.default)(urlToOpen);
            }
            // Start polling
            console.log(chalk_1.default.gray(`Waiting for authorization (expires in ${Math.floor(expires_in / 60)} minutes)...`));
            const token = yield (0, token_1.pollForToken)(auth_1.authClient, device_code, CLIENT_ID, interval, expires_in);
            if (token) {
                yield (0, token_1.storeToken)(token);
                // Get user info
                const { data: session } = yield auth_1.authClient.getSession({
                    fetchOptions: {
                        headers: {
                            Authorization: `Bearer ${token.access_token}`,
                        },
                    },
                });
                const userIdentifier = ((_a = session === null || session === void 0 ? void 0 : session.user) === null || _a === void 0 ? void 0 : _a.name) || ((_b = session === null || session === void 0 ? void 0 : session.user) === null || _b === void 0 ? void 0 : _b.email);
                (0, prompts_1.outro)(chalk_1.default.green(`✅ Mixedbread platform login successful! ${userIdentifier ? `Logged in as ${userIdentifier}.` : ""}`));
            }
        }
        catch (err) {
            spinner.stop();
            console.error(`${err instanceof Error ? err.message : "Unknown error"}`);
            process.exit(1);
        }
    });
}
exports.login = new commander_1.Command("login")
    .description("Login to the Mixedbread platform")
    .action(loginAction);
//# sourceMappingURL=login.js.map