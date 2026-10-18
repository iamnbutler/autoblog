// Belt-and-braces: the reviewer is told never to include secrets, but transcripts
// are full of them, so everything written to the journal passes through here too.
const PATTERNS: RegExp[] = [
  /\b(gh[opusr]_[A-Za-z0-9]{20,})\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bapikey_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const ASSIGNMENT = /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|PRIVATE_KEY)[A-Z0-9_]*)(\s*[=:]\s*)(["']?)[^\s"'`]{8,}\3/g;

export function redact(text: string): string {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, "<redacted>");
  return out.replace(ASSIGNMENT, (_m, k, sep, q) => `${k}${sep}${q}<redacted>${q}`);
}
