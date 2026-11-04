import { afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(import.meta.dir, "../src/cli.ts");
const FIX = resolve(import.meta.dir, "fixtures");

export const TOML = `
project = "testapp"
base_branch = "main"
[protect]
prefixes = ["test/acceptance/", ".github/", "docs/"]
files = ["CODEOWNERS"]
[checks]
required = ["analyze-and-test", "protected-paths"]
protected_check = "protected-paths"
trusted_app_slug = "github-actions"
workflow_path = ".github/workflows/verify.yml"
event = "pull_request"
[agent]
max_turns = 5
allowed_tools = ["Read", "Edit"]
done_commands = ["bun test"]
env_allow = ["ALLOWED_SECRET"]
[budget]
max_jobs_per_day = 10
max_concurrent = 5
`;

const run = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};

const created: string[] = [];
afterAll(() => {
  if (!process.env.KEEP_TEST_DIRS) for (const d of created) rmSync(d, { recursive: true, force: true });
});

export function setup() {
  const dir = mkdtempSync(join(tmpdir(), "dispatcher-test-"));
  created.push(dir);
  const remote = join(dir, "remote.git");
  const root = join(dir, "repo");
  run(["git", "init", "-q", "--bare", "-b", "main", remote], dir);
  run(["git", "clone", "-q", remote, root], dir);
  for (const [k, v] of [["user.email", "t@t"], ["user.name", "t"], ["commit.gpgsign", "false"]]) run(["git", "config", k!, v!], root);
  writeFileSync(join(root, ".dispatcher.toml"), TOML);
  mkdirSync(join(root, "test/acceptance"), { recursive: true });
  writeFileSync(join(root, "test/acceptance/a.txt"), "golden\n");
  run(["git", "add", "-A"], root);
  run(["git", "commit", "-qm", "init"], root);
  run(["git", "push", "-q", "-u", "origin", "main"], root);

  const ghState = join(dir, "gh.json");
  writeFileSync(ghState, JSON.stringify({ prs: [], checkRuns: [], workflowRuns: [] }));
  const baseEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_BIN: join(FIX, "fake-claude.ts"),
    GH_BIN: join(FIX, "fake-gh.ts"),
    BOT_GH_TOKEN: "bot-token",
    FAKE_GH_STATE: ghState,
    DISPATCHER_STATE_DIR: join(dir, "state"),
    CI_POLL_S: "0",
    CI_TIMEOUT_S: "0",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  };
  delete baseEnv.BOT_GH_TOKEN_CMD;

  const ctx = {
    dir, root, ghState,
    dispatcher(args: string[], env: Record<string, string> = {}) {
      const r = Bun.spawnSync(["bun", CLI, ...args, "--repo", root], { cwd: root, env: { ...baseEnv, ...env }, stdout: "pipe", stderr: "pipe" });
      return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
    },
    spawn(args: string[], env: Record<string, string> = {}) {
      return Bun.spawn(["bun", CLI, ...args, "--repo", root], { cwd: root, env: { ...baseEnv, ...env }, stdout: "pipe", stderr: "pipe" });
    },
    gh(): any {
      return JSON.parse(require("node:fs").readFileSync(ghState, "utf8"));
    },
    setGh(patch: Record<string, unknown>) {
      writeFileSync(ghState, JSON.stringify({ ...ctx.gh(), ...patch }));
    },
    db() {
      return new Database(join(dir, "state/testapp/ledger.db"));
    },
    job(id: string): any {
      return ctx.db().query("SELECT * FROM jobs WHERE job_id=?").get(id);
    },
    events(id: string): any[] {
      return ctx.db().query("SELECT kind, payload FROM events WHERE job_id=? ORDER BY id").all(id);
    },
    /** 비보호 경로만 바꾼 브랜치를 push 하고 adopt → open-pr 까지. JOB_ID 반환. */
    adoptedPr(branch = "feature/x", file = "lib/x.txt"): string {
      run(["git", "checkout", "-q", "-b", branch], root);
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), branch + "\n");
      run(["git", "add", "-A"], root);
      run(["git", "commit", "-qm", branch], root);
      run(["git", "push", "-q", "-u", "origin", branch], root);
      run(["git", "checkout", "-q", "main"], root);
      const a = ctx.dispatcher(["adopt", branch]);
      const id = a.out.match(/\[(a[\d-]+-[0-9a-f]{4})\]/)![1]!;
      const o = ctx.dispatcher(["open-pr", id]);
      if (o.code !== 0) throw new Error(o.err);
      return id;
    },
  };
  return ctx;
}

export const cr = (name: string, o: Partial<{ id: number; status: string; conclusion: string | null; slug: string; suite: number; sha: string }> = {}) => ({
  id: o.id ?? 100,
  name,
  head_sha: o.sha ?? "$HEAD",
  status: o.status ?? "completed",
  conclusion: o.conclusion === undefined ? "success" : o.conclusion,
  app: { slug: o.slug ?? "github-actions" },
  check_suite: { id: o.suite ?? 1 },
  html_url: `https://github.com/acme/app/runs/${o.id ?? 100}`,
});

export const wr = (o: Partial<{ suite: number; path: string; event: string; sha: string }> = {}) => ({
  check_suite_id: o.suite ?? 1,
  path: o.path ?? ".github/workflows/verify.yml",
  event: o.event ?? "pull_request",
  head_sha: o.sha ?? "$HEAD",
});

export const passing = () => ({ checkRuns: [cr("analyze-and-test", { id: 101 }), cr("protected-paths", { id: 102 })], workflowRuns: [wr()] });
