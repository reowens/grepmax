// PreToolUse hook for Grep — suggests gmax when the pattern looks conceptual.
//
// This hook NEVER blocks or modifies the Grep call. It only adds an
// informational suggestion via additionalContext when the pattern looks
// like a natural language query that would be better served by semantic
// search. Claude decides whether to switch.

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
const CODE_KEYWORDS = /\b(class|function|const|let|var|import|export|return|extends|implements|interface|type|enum|struct|def|async|await)\b/;

/**
 * Conservative heuristic: returns true only when the pattern is very
 * likely a natural language query rather than a code pattern.
 *
 * ALL of these must hold:
 * - Multi-word (contains spaces)
 * - 3+ words (2-word phrases are too ambiguous — "auth flow" could be a grep)
 * - No regex special chars
 * - No camelCase, PascalCase, or snake_case (identifiers)
 * - No code keywords (class, function, import, etc.)
 * - No dots (method chains)
 * - Not all-caps (constants)
 * - No quotes (literal string searches)
 */
function isConceptualQuery(pattern) {
  if (!pattern || typeof pattern !== "string") return false;

  const trimmed = pattern.trim();

  // Must contain spaces (multi-word)
  if (!trimmed.includes(" ")) return false;

  // Must have 3+ words
  const words = trimmed.split(/\s+/);
  if (words.length < 3) return false;

  // No regex special characters
  if (REGEX_SPECIAL.test(trimmed)) return false;

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

  const response = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: `Tip: "${pattern}" looks like a conceptual query. For meaning-based search try: Bash(gmax "${pattern}" --agent)`,
    },
  };
  process.stdout.write(JSON.stringify(response));
}

main();
