#!/usr/bin/env node
// Keeps this public repo free of what must stay private: credentials, internal
// ticket references, the hostnames and LAN addresses of the instances it runs
// against, and brand data. Brands, boards and hosts are injected at run time by
// whoever uses the package, never written here. Scans every tracked file; exits 1
// with each hit named. `--history` scans every commit's patch (`git log -p --all`)
// instead, which is the check a repo needs before it goes public.
//
// Brand data is checked against scripts/brand-hashes.json: sha256 hashes of the
// brands' names, slugs, domains and phones, generated from the private brand
// roster. Only hashes are committed, so the list itself names no brand. A line is
// split into lowercase alphanumeric words; every run of one to four words, and the
// same run written without spaces, is hashed and looked up. Phone-like digit runs
// are hashed by their last ten digits.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SELF = "scripts/guard.mjs";
const HASHES = "scripts/brand-hashes.json";

/** Ticket-shaped refs (ABC-123). Standards that look the same are allowed. */
const TICKET = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g;
const NOT_TICKETS = new Set(["UTF", "ISO", "RFC", "SHA", "AES", "ES", "TLS", "HTTP", "CVE", "GHSA", "WCAG", "IEEE", "X"]);

/** Credential shapes. A real value never belongs in this repo. */
const SECRETS = [
  { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "GitHub token", re: /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/ },
  { name: "npm token", re: /\bnpm_[A-Za-z0-9]{30,}/ },
  { name: "AWS key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "API key assignment", re: /(api[_-]?key|secret|token|password)\s*[:=]\s*["'][A-Za-z0-9_\-]{24,}["']/i },
];

/** Instances this code runs against are configuration, not source. A brand's own
 * domain is caught by the brand hashes below, so it is not spelled out here. */
const PRIVATE_HOSTS = /\b[a-z0-9-]+\.practical\.works\b/i;

/** A LAN address or an mDNS name is a machine on someone's network, not source. */
const LAN_ADDRESSES = [
  { name: "private IPv4 address", re: /\b(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/ },
  { name: "mDNS host", re: /\b[a-z0-9][a-z0-9-]*\.local\b(?!\.)/i },
];

const MAX_WORDS = 4;
const PHONE = /\+?\d[\d\s().-]{8,}\d/g;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** Every hashed candidate a line offers for the brand lookup. */
export function brandCandidates(line) {
  const words = line.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const out = new Set();
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= MAX_WORDS && i + n <= words.length; n++) {
      const run = words.slice(i, i + n);
      out.add(run.join(" "));
      out.add(run.join(""));
    }
  }
  for (const m of line.matchAll(PHONE)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 10) out.add(`phone:${digits.slice(-10)}`);
  }
  return out;
}

/** The findings for one file's text. `brandHashes` is a Set of sha256 hex strings. */
export function scanText(file, text, brandHashes) {
  const hits = [];
  text.split("\n").forEach((line, i) => {
    const at = `${file}:${i + 1}`;
    for (const m of line.matchAll(TICKET)) {
      if (!NOT_TICKETS.has(m[1])) hits.push(`${at}: ticket reference ${m[0]}`);
    }
    for (const s of SECRETS) if (s.re.test(line)) hits.push(`${at}: ${s.name}`);
    if (PRIVATE_HOSTS.test(line)) hits.push(`${at}: private host ${line.match(PRIVATE_HOSTS)[0]}`);
    for (const l of LAN_ADDRESSES) if (l.re.test(line)) hits.push(`${at}: ${l.name}`);
    for (const c of brandCandidates(line)) {
      // Name the hash prefix, not the text: the finding itself is printed in public CI logs.
      const h = sha256(c);
      if (brandHashes.has(h)) hits.push(`${at}: brand data (hash ${h.slice(0, 12)})`);
    }
  });
  return hits;
}

export function loadBrandHashes(path = HASHES) {
  const { hashes } = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(hashes) || hashes.length === 0 || !hashes.every((h) => /^[0-9a-f]{64}$/.test(h))) {
    throw new Error(`${path} must hold a non-empty list of sha256 hex hashes`);
  }
  return new Set(hashes);
}

/** Every added or removed line in the repo's history, as `scanText` input. The
 * guard's own files are skipped here too, since they name what they look for. */
function historyText() {
  const log = execFileSync("git", ["log", "-p", "--all", "--format=commit %H%n%B"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const kept = [];
  let skip = false;
  for (const line of log.split("\n")) {
    if (line.startsWith("diff --git ")) skip = [SELF, HASHES].some((f) => line.endsWith(` b/${f}`)) || line.endsWith("pnpm-lock.yaml");
    if (!skip) kept.push(line);
  }
  return kept.join("\n");
}

function main() {
  const brandHashes = loadBrandHashes();
  if (process.argv.includes("--history")) {
    const hits = scanText("history", historyText(), brandHashes);
    if (hits.length) {
      console.error(`guard: ${hits.length} finding(s) in git history:\n  ${hits.join("\n  ")}`);
      process.exit(1);
    }
    console.log("guard: history clean");
    return;
  }
  const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f && f !== SELF && f !== HASHES && !f.endsWith("pnpm-lock.yaml"));

  const hits = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    hits.push(...scanText(file, text, brandHashes));
  }

  if (hits.length) {
    console.error(`guard: ${hits.length} finding(s) that must not be in a public repo:\n  ${hits.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`guard: ${files.length} files clean`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
