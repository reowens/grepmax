#!/usr/bin/env node
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
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const commander_1 = require("commander");
const claude_code_1 = require("./install/claude-code");
const login_1 = require("./login");
const logout_1 = require("./logout");
const search_1 = require("./search");
const watch_1 = require("./watch");
// utility functions moved to ./utils
commander_1.program
    .version(JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), {
    encoding: "utf-8",
})).version)
    .option("--store <string>", "The store to use", process.env.MXBAI_STORE || "mgrep");
commander_1.program.addCommand(search_1.search, { isDefault: true });
commander_1.program.addCommand(watch_1.watch);
commander_1.program.addCommand(claude_code_1.installClaudeCode);
commander_1.program.addCommand(login_1.login);
commander_1.program.addCommand(logout_1.logout);
commander_1.program.parse();
//# sourceMappingURL=index.js.map