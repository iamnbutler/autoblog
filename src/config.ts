import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";

const HOME = homedir();

export const STATE_DIR = process.env.AUTOBLOG_STATE_DIR ?? join(HOME, ".autoblog");
export const CONFIG_PATH = join(STATE_DIR, "config.json");
export const STATE_PATH = join(STATE_DIR, "state.json");
export const LOG_PATH = join(STATE_DIR, "decisions.jsonl");
export const LOCK_PATH = join(STATE_DIR, "sweep.lock");
export const REPO_ROOT = join(import.meta.dir, "..");

export type Config = {
  /** Whose journal this is, by first name. Prompts say "{owner}'s journal". */
  owner: string;
  /** Local clone of the private journal repo. */
  journal: string;
  /** Model used by the auto-mode reviewer (any `claude --model` value). */
  model: string;
  /** Model that writes the timeline (the work log) from transcripts. */
  timelineModel: string;
  /** Model the linker uses to find mentions of other entries. */
  linkModel: string;
  /** In-band: a Stop hook asks the agent to reflect once this many tool calls pile up. */
  reflectEvery: number;
  /** In-band, when the harness gives no transcript to measure: reflect every N turns. */
  reflectEveryTurns: number;
  /** Fallback sweep: a transcript must be untouched this long before it is reviewed. */
  idleMinutes: number;
  /** Deltas with fewer tool calls than this are skipped without calling the model. */
  minToolCalls: number;
  /** On first sight, transcripts older than this are marked seen instead of backfilled. */
  lookbackHours: number;
  /** Condensed transcript budget sent to the reviewer, in characters. */
  maxChars: number;
  /** Which transcript sources the sweep reads. */
  sources: ("claude" | "codex")[];
  /** Push the journal after each write. */
  push: boolean;
  /** Private site (Cloudflare Worker behind basic auth), set by `autoblog site setup`. Redeployed after each write. */
  site?: {
    worker: string;
    user: string;
    url?: string;
    kv?: string;
    /** Cloudflare Access in front of the Worker, set by `autoblog site access`: team domain, app audience tag, and the service token's client id. */
    access?: { team: string; aud: string; clientId?: string };
  };
};

export const DEFAULTS: Config = {
  owner: defaultOwner(),
  journal: join(HOME, "code", "autoblog"), // replaced by `autoblog init` with ~/code/<you>-autoblog
  model: "opus",
  linkModel: "sonnet",
  timelineModel: "sonnet",
  reflectEvery: 40,
  reflectEveryTurns: 6,
  idleMinutes: 20,
  minToolCalls: 8,
  lookbackHours: 24,
  maxChars: 120_000,
  sources: ["claude", "codex"],
  push: true,
};

/** First name from git config, or a neutral stand-in. */
function defaultOwner(): string {
  try {
    const name = require("node:child_process").spawnSync("git", ["config", "--global", "user.name"], { encoding: "utf8" }).stdout.trim();
    return name.split(/\s+/)[0] || "the user";
  } catch {
    return "the user";
  }
}

/** Fill the owner's name into a prompt. */
export const personalize = (cfg: Config, s: string) => s.replaceAll("{{OWNER}}", cfg.owner);

export function loadConfig(): Config {
  let user: Partial<Config> = {};
  if (existsSync(CONFIG_PATH)) user = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const cfg = { ...DEFAULTS, ...user };
  if (process.env.AUTOBLOG_JOURNAL) cfg.journal = process.env.AUTOBLOG_JOURNAL;
  return cfg;
}

/**
 * Whether `path` is `dir` or inside it. macOS volumes usually ignore case, so ~/Code and
 * ~/code are one folder: compare the on-disk spelling, and fold case for paths that no
 * longer exist (old transcripts).
 */
export function isWithin(path: string, dir: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync.native(p);
    } catch {
      return resolve(p);
    }
  };
  let a = real(path), b = real(dir);
  if (process.platform === "darwin") (a = a.toLowerCase()), (b = b.toLowerCase());
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}
