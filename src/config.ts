import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const HOME = homedir();

export const STATE_DIR = process.env.AUTOBLOG_STATE_DIR ?? join(HOME, ".autoblog");
export const CONFIG_PATH = join(STATE_DIR, "config.json");
export const STATE_PATH = join(STATE_DIR, "state.json");
export const LOG_PATH = join(STATE_DIR, "decisions.jsonl");
export const LOCK_PATH = join(STATE_DIR, "sweep.lock");
export const REPO_ROOT = join(import.meta.dir, "..");

export type Config = {
  /** Local clone of the private journal repo. */
  journal: string;
  /** Model used by the auto-mode reviewer (any `claude --model` value). */
  model: string;
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
  site?: { worker: string; user: string; url?: string };
};

export const DEFAULTS: Config = {
  journal: join(HOME, "code", "autoblog"), // replaced by `autoblog init` with ~/code/<you>-autoblog
  model: "opus",
  linkModel: "sonnet",
  reflectEvery: 40,
  reflectEveryTurns: 6,
  idleMinutes: 20,
  minToolCalls: 8,
  lookbackHours: 24,
  maxChars: 120_000,
  sources: ["claude", "codex"],
  push: true,
};

export function loadConfig(): Config {
  let user: Partial<Config> = {};
  if (existsSync(CONFIG_PATH)) user = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const cfg = { ...DEFAULTS, ...user };
  if (process.env.AUTOBLOG_JOURNAL) cfg.journal = process.env.AUTOBLOG_JOURNAL;
  return cfg;
}
