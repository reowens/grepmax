// PreToolUse hook for Grep and Bash: suggests gmax when a search looks conceptual.
//
// This hook NEVER blocks or modifies the call. It only adds an informational
// suggestion via additionalContext when a Grep pattern, or the pattern of an
// rg or grep in a shell command, looks like a natural language query that would
// be better served by semantic search. Claude decides whether to switch.
const { readRepoStatus } = require("./repo-status");

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
    // Unref'd: Bash runs this hook on every call, and a live timer would hold each one for a second.
    const timer = setTimeout(() => resolve({}), 1000);
    timer?.unref?.();
  });
}

const REGEX_SPECIAL = /[[\](){}\\^$+*?|]/;
const CAMEL_CASE = /[a-z][A-Z]/;
const PASCAL_CASE = /\b[A-Z][a-z]+[A-Z]/;
const SNAKE_CASE = /_[a-z]/;
const ALL_CAPS = /^[A-Z_]+$/;
const HAS_DOT = /\./;
const HAS_QUOTE = /['"]/;
const CODE_KEYWORDS =
  /\b(class|function|const|let|var|import|export|return|extends|implements|interface|type|enum|struct|def|async|await)\b/;

// Light fuzz agents put inside a guessed word: keep.?alive, re-?login, dry\s?run.
const WORD_FUZZ = /\.\?|-\?|\\s[?*]?/g;

/**
 * Count the plain lowercase words in a regex alternation such as
 * `(?i)keep.?alive|NoOp|heartbeat|ping`, the shape of a grep that is guessing
 * at a behavior's vocabulary. Identifiers, paths and code keywords don't count.
 */
function guessedWordCount(pattern) {
  const body = pattern.replace(/^\(\?i\)/, "").replace(/^\((.*)\)$/, "$1");
  const alternatives = body.split("|");
  if (alternatives.length < 3) return 0;
  return alternatives.filter((alt) => {
    const word = alt.replace(WORD_FUZZ, "");
    return /^[a-z]+$/.test(word) && !CODE_KEYWORDS.test(word);
  }).length;
}

/**
 * Match 3+ natural-language words, or an alternation with 3+ guessed plain
 * words. Skip identifiers, code syntax, paths and literal string searches.
 */
function isConceptualQuery(pattern) {
  if (!pattern || typeof pattern !== "string") return false;

  const trimmed = pattern.trim();
  if (trimmed.includes("|")) return guessedWordCount(trimmed) >= 3;

  if (trimmed.split(/\s+/).length < 3) return false;

  // No regex special characters or paths
  if (REGEX_SPECIAL.test(trimmed) || trimmed.includes("/")) return false;

  // No camelCase or PascalCase identifiers
  if (CAMEL_CASE.test(trimmed)) return false;
  if (PASCAL_CASE.test(trimmed)) return false;

  // No snake_case identifiers
  if (SNAKE_CASE.test(trimmed)) return false;

  // No code keywords (class, function, import, etc.)
  if (CODE_KEYWORDS.test(trimmed)) return false;

  // Not all-caps (constants)
  if (ALL_CAPS.test(trimmed.replace(/\s+/g, ""))) return false;

  // No dots (method chains, file paths)
  if (HAS_DOT.test(trimmed)) return false;

  // No quotes (literal string searches)
  if (HAS_QUOTE.test(trimmed)) return false;

  return true;
}

const VALUE_FLAGS = new Set([
  "-g",
  "--glob",
  "-t",
  "--type",
  "-T",
  "--type-not",
  "-A",
  "--after-context",
  "-B",
  "--before-context",
  "-C",
  "--context",
  "-m",
  "--max-count",
  "-d",
  "--max-depth",
  "--include",
  "--exclude",
  "--exclude-dir",
  "--sort",
  "--sortr",
  "--color",
  "--colors",
  "-j",
  "--threads",
  "-M",
  "--max-columns",
  "--replace",
  "--max-filesize",
]);
const NOT_A_PATTERN_SEARCH = new Set([
  "--fixed-strings",
  "--file",
  "--files",
  "--type-list",
  "--help",
  "--version",
]);
// Logs, data and output are filtered with a search, not explored with one.
const NOT_SOURCE =
  /\.(log|ndjson|jsonl|json|csv|txt)$|(^|\/)(logs?|tmp)(\/|$)|\$/;

// The command's words and control operators, with quotes removed.
function shellTokens(command) {
  const tokens = [];
  let word = null;
  let quote = null;
  const end = () => {
    if (word !== null) tokens.push({ word });
    word = null;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      word ??= "";
    } else if (c === "\\") {
      word = (word ?? "") + c + (command[++i] ?? "");
    } else if (/\s/.test(c) && c !== "\n") {
      end();
    } else if (";&|()\n".includes(c)) {
      end();
      const pair = command.slice(i, i + 2);
      const op = pair === "&&" || pair === "||" ? pair : c;
      i += op.length - 1;
      tokens.push({ op });
    } else {
      word = (word ?? "") + c;
    }
  }
  end();
  return tokens;
}

// The pattern of one rg or grep, or null when this run is not a code search:
// fixed strings, a single named file, a log, or a grep that does not recurse.
function searchPattern(head, args, cwd) {
  const positional = [];
  let pattern = null;
  let recursive = head === "rg";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const name = arg.split("=")[0];
      if (NOT_A_PATTERN_SEARCH.has(name)) return null;
      if (name === "--recursive") recursive = true;
      if (name === "--regexp")
        pattern ??= arg.includes("=") ? arg.slice(9) : args[++i];
      else if (VALUE_FLAGS.has(name) && !arg.includes("=")) i++;
    } else if (arg.startsWith("-") && arg.length > 1) {
      if (arg.length === 2 && VALUE_FLAGS.has(arg)) {
        i++;
      } else if (!VALUE_FLAGS.has(arg.slice(0, 2))) {
        if (/[Ff]/.test(arg)) return null;
        if (head !== "rg" && /[rR]/.test(arg)) recursive = true;
        if (arg.endsWith("e")) pattern ??= args[++i];
      }
    } else {
      positional.push(arg);
    }
  }
  if (!recursive) return null;
  if (pattern === null) pattern = positional.shift();
  for (const path of positional) {
    if (NOT_SOURCE.test(path) || /\.\w+$/.test(path)) return null;
    if ((path.startsWith("/") && !path.startsWith(cwd)) || path.startsWith("~"))
      return null;
  }
  return typeof pattern === "string" ? pattern.replace(/\\\|/g, "|") : null;
}

// Patterns of the rg and grep commands that start a pipeline. A later pipeline
// stage filters another command's output, and a heredoc body is not a command.
function shellSearchPatterns(command, cwd) {
  if (typeof command !== "string" || command.includes("<<")) return [];
  const tokens = shellTokens(command);
  const patterns = [];
  for (let i = 0; i < tokens.length; i++) {
    const startsPipeline =
      i === 0 || (tokens[i - 1].op && tokens[i - 1].op !== "|");
    if (!startsPipeline || tokens[i].op) continue;
    let at = i;
    while (/^\w+=/.test(tokens[at]?.word ?? "")) at++;
    const head = (tokens[at]?.word ?? "").split("/").pop();
    if (head !== "rg" && head !== "grep" && head !== "egrep") continue;
    const args = [];
    for (let j = at + 1; j < tokens.length && !tokens[j].op; j++)
      args.push(tokens[j].word);
    const pattern = searchPattern(head, args, cwd);
    if (pattern) patterns.push(pattern);
  }
  return patterns;
}

const BASH_HINT_INTERVAL_MS = 30 * 60 * 1000;

// A Bash hint shows at most once per 30 minutes per session. A hint that repeats is noise.
function bashHintIsDue(sessionId) {
  const fs = require("fs");
  const marker = require("path").join(
    require("os").tmpdir(),
    `gmax-search-hint-${String(sessionId ?? "unknown").replace(/\W/g, "")}`,
  );
  try {
    if (Date.now() - fs.statSync(marker).mtimeMs < BASH_HINT_INTERVAL_MS)
      return false;
  } catch {}
  try {
    fs.writeFileSync(marker, "");
  } catch {}
  return true;
}

async function main() {
  const input = await readStdin();
  const cwd = input.cwd || process.cwd();
  const isBash = input.tool_name === "Bash";
  const patterns = isBash
    ? shellSearchPatterns(input.tool_input?.command, cwd)
    : [input.tool_input?.pattern];

  if (!patterns.some(isConceptualQuery)) return;
  const status = readRepoStatus(cwd);
  if (!status.cliHint) return;
  if (isBash && !bashHintIsDue(input.session_id)) return;

  const response = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: `This repo has a semantic index: when you are guessing names for a behavior, run ${status.cliHint.replace("<concept>", "<question in plain words>")} first (requires gmax on PATH), then Read the file:line pointers it returns. Use ${isBash ? "rg" : "Grep"} for exact names and honor explicit query/startup limits.`,
    },
  };
  process.stdout.write(JSON.stringify(response));
}

main();
