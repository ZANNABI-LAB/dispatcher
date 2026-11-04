import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fail } from "./util";

export interface Config {
  root: string;
  project: string;
  baseBranch: string;
  protect: { prefixes: string[]; files: string[] };
  checks: {
    required: string[];
    protectedCheck: string;
    trustedAppSlug: string;
    workflowPath: string;
    event: string;
  };
  agent: { maxTurns: number; allowedTools: string[]; doneCommands: string[]; envAllow: string[] };
  budget: { maxJobsPerDay: number; maxConcurrent: number };
}

/** Claude 자식 프로세스에서 항상 제거하는 환경 변수 (집행용 비밀정보, API 키). env_allow 로만 예외. */
export const SCRUB_ENV = [
  "BOT_GH_TOKEN", "BOT_GH_TOKEN_CMD", "ROUTINE_TOKEN", "ROUTINE_URL",
  "GH_TOKEN", "GITHUB_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
];

type Raw = Record<string, any>;

function strings(v: unknown, name: string, fallback?: string[]): string[] {
  if (v === undefined && fallback) return fallback;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) fail(`.dispatcher.toml: ${name} 는 문자열 배열이어야 합니다`);
  return v as string[];
}

export function loadConfig(root: string): Config {
  const path = join(root, ".dispatcher.toml");
  if (!existsSync(path)) fail(`설정 파일이 없습니다: ${path}`);
  const raw = Bun.TOML.parse(readFileSync(path, "utf8")) as Raw;
  const c: Raw = raw.checks ?? {};
  const a: Raw = raw.agent ?? {};
  const b: Raw = raw.budget ?? {};
  const required = strings(c.required, "checks.required");
  const protectedCheck = c.protected_check ?? "protected-paths";
  if (!required.includes(protectedCheck)) fail(`.dispatcher.toml: checks.protected_check(${protectedCheck}) 가 checks.required 에 없습니다`);
  const envAllow = strings(a.env_allow, "agent.env_allow", []);
  const forbidden = envAllow.filter((n) => ["BOT_GH_TOKEN", "BOT_GH_TOKEN_CMD", "GH_TOKEN", "GITHUB_TOKEN"].includes(n));
  if (forbidden.length) fail(`.dispatcher.toml: GitHub 집행용 토큰은 env_allow 에 넣을 수 없습니다: ${forbidden}`);
  return {
    root,
    project: raw.project ?? fail(".dispatcher.toml: project 가 필요합니다"),
    baseBranch: raw.base_branch ?? "main",
    protect: { prefixes: strings(raw.protect?.prefixes, "protect.prefixes"), files: strings(raw.protect?.files, "protect.files", []) },
    checks: {
      required,
      protectedCheck,
      trustedAppSlug: c.trusted_app_slug ?? "github-actions",
      workflowPath: c.workflow_path ?? fail(".dispatcher.toml: checks.workflow_path 가 필요합니다"),
      event: c.event ?? "pull_request",
    },
    agent: {
      maxTurns: a.max_turns ?? 40,
      allowedTools: strings(a.allowed_tools, "agent.allowed_tools"),
      doneCommands: strings(a.done_commands, "agent.done_commands", []),
      envAllow,
    },
    budget: { maxJobsPerDay: b.max_jobs_per_day ?? 10, maxConcurrent: b.max_concurrent ?? 2 },
  };
}

export function isProtected(cfg: Config, path: string): boolean {
  return cfg.protect.prefixes.some((p) => path.startsWith(p)) || cfg.protect.files.includes(path) || path.endsWith("/CODEOWNERS");
}
