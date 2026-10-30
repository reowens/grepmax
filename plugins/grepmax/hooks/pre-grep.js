// PreToolUse hook for Grep — suggests gmax when the pattern looks conceptual.
//
// This hook NEVER blocks or modifies the Grep call. It only adds an
// informational suggestion via additionalContext when the pattern looks
// like a natural language query that would be better served by semantic
// search. Claude decides whether to switch.
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
    setTimeout(() => resolve({}), 1000);
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

async function main() {
  const input = await readStdin();
  const pattern = input.tool_input?.pattern;

  if (!isConceptualQuery(pattern)) return;
  const status = readRepoStatus(input.cwd || process.cwd());
  if (!status.cliHint) return;

  const response = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: `This repo has a semantic index: when you are guessing names for a behavior, run ${status.cliHint.replace("<concept>", "<question in plain words>")} first (requires gmax on PATH), then Read the file:line pointers it returns. Use Grep for exact names and honor explicit query/startup limits.`,
    },
  };
  process.stdout.write(JSON.stringify(response));
}

main();
