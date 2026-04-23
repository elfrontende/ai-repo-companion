// Note parsing stays intentionally tiny and permissive.
// The workspace only needs lightweight frontmatter support and cheap token
// heuristics, not a full Markdown or YAML parser dependency.

const taskStopwords = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "or",
  "the",
  "this",
  "to",
  "with",
  "after",
  "before",
  "during",
  "via",
  "within",
  "across",
  "та",
  "або",
  "для",
  "до",
  "з",
  "зі",
  "із",
  "й",
  "на",
  "над",
  "перед",
  "після",
  "по",
  "при",
  "про",
  "такий",
  "у",
  "в",
  "це",
  "через",
  "щоб",
  "як"
]);

const genericTaskTokens = new Set([
  "add",
  "align",
  "build",
  "capture",
  "clarify",
  "create",
  "design",
  "document",
  "fix",
  "implement",
  "improve",
  "investigate",
  "plan",
  "polish",
  "prepare",
  "refresh",
  "remove",
  "review",
  "rewrite",
  "support",
  "tighten",
  "update",
  "verify",
  "задокументувати",
  "зробити",
  "оновити",
  "оптимізувати",
  "перевірити",
  "підготувати",
  "покращити",
  "прибрати",
  "спланувати",
  "створити",
  "уточнити",
  "додати",
  "переписати",
  "вирівняти"
]);

const companionTaskKeywords = [
  "agent",
  "benchmark",
  "companion",
  "context",
  "cost",
  "memory",
  "note",
  "notes",
  "orchestration",
  "policy",
  "provider",
  "queue",
  "retrieval",
  "review",
  "runtime",
  "tuning",
  "worker",
  "workspace",
  "zettelkasten",
  "агент",
  "агенти",
  "бенчмарк",
  "воркер",
  "контекст",
  "нотатки",
  "оркестрація",
  "память",
  "памʼять",
  "памятью",
  "провайдер",
  "ретривал",
  "ревю",
  "черга",
  "політика",
  "тюнінг"
];

export function parseFrontmatter(markdown) {
  const trimmed = markdown.trimStart();
  if (!trimmed.startsWith("---\n")) {
    return { meta: {}, body: markdown.trim() };
  }

  const endIndex = trimmed.indexOf("\n---\n", 4);
  if (endIndex === -1) {
    return { meta: {}, body: markdown.trim() };
  }

  const rawMeta = trimmed.slice(4, endIndex).trim();
  const body = trimmed.slice(endIndex + 5).trim();
  const meta = {};

  for (const line of rawMeta.split("\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    meta[key] = parseScalar(value);
  }

  return { meta, body };
}

function parseScalar(value) {
  if (!value) {
    return "";
  }

  if (value.includes(",")) {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return value;
}

export function formatFrontmatter(meta, body) {
  const lines = ["---"];
  for (const [key, rawValue] of Object.entries(meta)) {
    const value = Array.isArray(rawValue) ? rawValue.join(",") : rawValue;
    lines.push(`${key}: ${value}`);
  }
  lines.push("---", "", body.trim(), "");
  return lines.join("\n");
}

export function estimateTokens(text) {
  // A rough 4-chars-per-token estimate is "good enough" for retrieval
  // budgeting and keeps the runtime dependency-free.
  return Math.max(1, Math.ceil(text.trim().length / 4));
}

export function extractMeaningfulTaskTokens(text, options = {}) {
  const limit = Math.max(1, Number(options.limit) || 6);
  return tokenize(text)
    .filter((token) => !taskStopwords.has(token))
    .filter((token) => !genericTaskTokens.has(token))
    .slice(0, limit);
}

export function isCompanionTask(taskOrTokens) {
  const tokens = Array.isArray(taskOrTokens) ? taskOrTokens : tokenize(taskOrTokens);
  return tokens.some((token) => companionTaskKeywords.some((keyword) => roughTokenMatch(token, keyword)));
}

export function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "note";
}

export function tokenize(text) {
  // We keep tokenization language-light on purpose.
  // It only needs to support fuzzy routing and retrieval for short prompts,
  // mostly in English and Ukrainian.
  return [...new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .map((part) => part.trim())
      .filter((part) => part.length > 1)
  )];
}

export function roughTokenMatch(left, right) {
  // This matcher is intentionally fuzzy so notes can still match when the
  // wording changes a little between tasks, tags, and titles.
  if (!left || !right) {
    return false;
  }

  if (left === right) {
    return true;
  }

  const leftVariants = tokenVariants(left);
  const rightVariants = tokenVariants(right);

  for (const leftVariant of leftVariants) {
    for (const rightVariant of rightVariants) {
      if (leftVariant === rightVariant) {
        return true;
      }
      if (leftVariant.length >= 4 && rightVariant.length >= 4) {
        if (leftVariant.startsWith(rightVariant) || rightVariant.startsWith(leftVariant)) {
          return true;
        }
      }
    }
  }

  return false;
}

function tokenVariants(token) {
  const normalized = token.trim().toLowerCase();
  const variants = [normalized];

  if (normalized.length > 4) {
    variants.push(normalized.slice(0, -1));
  }
  if (normalized.length > 5) {
    variants.push(normalized.slice(0, -2));
  }
  if (normalized.length > 7) {
    variants.push(normalized.slice(0, -3));
  }

  return [...new Set(variants.filter((value) => value.length >= 3))];
}
