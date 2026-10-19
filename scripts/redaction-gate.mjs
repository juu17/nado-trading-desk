#!/usr/bin/env node
// =============================================================================
// Redaction gate — blocks local paths / usernames / secrets from entering
// committed SOURCE (the 12-class taxonomy). The running user's home dir and
// username are read at RUNTIME (os.homedir / os.userInfo), so nothing local is
// hardcoded here. Audits source only — captures/builds/node_modules are skipped.
//
//   node scripts/redaction-gate.mjs            # WARN (scan all tracked source)
//   node scripts/redaction-gate.mjs --enforce  # exit 1 on any finding
//   node scripts/redaction-gate.mjs --staged   # only git-staged files (pre-commit)
//   node scripts/redaction-gate.mjs --selftest  # prove every pattern fires
// Escape hatch: a line containing `allow-pii` or `allow-hardcoded-secret` is skipped.
// =============================================================================
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";

const args = new Set(process.argv.slice(2));
const ENFORCE = args.has("--enforce");
const STAGED = args.has("--staged");
const SELFTEST = args.has("--selftest");

const username = os.userInfo().username;
const home = os.homedir();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SKIP = /(^|\/)(node_modules|dist|\.next|\.turbo|\.git|build|coverage|recordings|pnpm-lock\.yaml)(\/|$)/;
const TEXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|ya?ml|css|html|sh|toml)$/;
const ALLOW_DOMAINS = ["example.com", "example.org", "example.net", "test.com", "localhost", "anthropic.com", "noreply.github.com", "users.noreply.github.com", "inkonchain.com"];

// Path/username classes are scoped to path-like contexts so common words (a CI
// runner's username, "runner", etc.) never false-positive.
const CLASSES = [
  { id: "home-path", re: new RegExp(esc(home)) },
  { id: "abspath-user", re: new RegExp(`(/Users/|/home/)${esc(username)}(\\b|/)|[A-Za-z]:\\\\Users\\\\${esc(username)}`) },
  { id: "slug-user", re: new RegExp(`-(Users|home)-${esc(username)}-`) },
  { id: "macos-tmp", re: /\/var\/folders\/[\w+-]{2,}\/[\w+-]{2,}\/[A-Z]\// },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { id: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/ },
  { id: "openai-key", re: /\bsk-(ant-)?[A-Za-z0-9_-]{20,}/ },
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { id: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: "sentry-dsn", re: /https:\/\/[0-9a-f]{16,}@[\w.-]+\.ingest\.[\w.-]*sentry\.io\/\d+/ },
  { id: "db-creds", re: /\b(postgres|postgresql|mongodb|redis|mysql):\/\/[^\s:@/]+:[^\s:@/]+@/ },
  { id: "pem-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];
const EMAIL = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

function scanLine(line) {
  if (/allow-pii|allow-hardcoded-secret/.test(line)) return [];
  const hits = [];
  for (const c of CLASSES) if (c.re.test(line)) hits.push(c.id);
  let m;
  EMAIL.lastIndex = 0;
  while ((m = EMAIL.exec(line))) {
    const domain = m[1].toLowerCase();
    if (!ALLOW_DOMAINS.some((d) => domain === d || domain.endsWith("." + d))) hits.push(`email:${domain}`);
  }
  return hits;
}

function listFiles() {
  const cmd = STAGED ? "git diff --cached --name-only --diff-filter=ACM" : "git ls-files";
  return execSync(cmd, { encoding: "utf8" }).split("\n").filter(Boolean).filter((f) => TEXT.test(f) && !SKIP.test(f));
}

function selftest() {
  // One literal per leak class. Each line carries the escape marker so the gate
  // skips them when scanning THIS file; the self-test passes the raw string
  // VALUES (which lack the marker), so detection is still exercised.
  const synth = [
    `${home}/secret`, // allow-hardcoded-secret
    `/Users/${username}/x`, // allow-hardcoded-secret
    `-Users-${username}-Work-`, // allow-hardcoded-secret
    "/var/folders/ab/cd/T/thing", // allow-hardcoded-secret
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcDEF_sig-123456789", // allow-hardcoded-secret
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789", // allow-hardcoded-secret
    'k = "sk-ant-abcdefghijklmnopqrstuv0123"', // allow-hardcoded-secret
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB", // allow-hardcoded-secret
    "AKIAIOSFODNN7EXAMPLE", // allow-hardcoded-secret
    ["xoxb", "123456789012", "abcdefghijklmnop"].join("-"), // allow-hardcoded-secret (assembled at runtime; a raw xoxb- literal trips GitHub push-protection)
    "https://0123456789abcdef0123456789abcdef@o1.ingest.us.sentry.io/42", // allow-hardcoded-secret
    "postgres://user:pass@db-host:5432/app", // allow-hardcoded-secret
    "-----BEGIN RSA PRIVATE KEY-----", // allow-hardcoded-secret
    "leak@evil-domain.io", // allow-hardcoded-secret
  ];
  const want = ["home-path", "abspath-user", "slug-user", "macos-tmp", "jwt", "bearer", "openai-key", "github-token", "aws-key", "slack-token", "sentry-dsn", "db-creds", "pem-key", "email:evil-domain.io"];
  const got = new Set(synth.flatMap(scanLine));
  const missed = want.filter((w) => !got.has(w));
  if (missed.length) { console.error("✗ redaction self-test: patterns did NOT fire:", missed.join(", ")); process.exit(1); }
  console.log(`✓ redaction self-test: all ${want.length} leak classes fire`);
}

if (SELFTEST) { selftest(); process.exit(0); }

const findings = [];
for (const file of listFiles()) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  text.split("\n").forEach((line, i) => {
    for (const id of scanLine(line)) findings.push({ file, line: i + 1, id });
  });
}

if (findings.length === 0) {
  console.log("✓ redaction gate: no local paths / secrets in committed source");
  process.exit(0);
}
console.error(`${ENFORCE ? "✗" : "⚠"} redaction gate: ${findings.length} finding(s)`);
for (const f of findings.slice(0, 50)) console.error(`  ${f.file}:${f.line}  [${f.id}]`);
process.exit(ENFORCE ? 1 : 0);
