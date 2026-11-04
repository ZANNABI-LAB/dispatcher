import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Config, SCRUB_ENV } from "./config";
import { git, gitSoft, protectedChanges } from "./git";
import { type Ledger } from "./ledger";
import { fail, newJobId, sh } from "./util";

export function claudeBin() {
  return process.env.CLAUDE_BIN ?? "claude";
}

/** Claude 자식 환경: 집행용 비밀정보를 지우고, 설정의 env_allow 만 예외로 남긴다. */
export function childEnv(cfg: Config): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (SCRUB_ENV.includes(k) && !cfg.agent.envAllow.includes(k)) continue;
    env[k] = v;
  }
  return env;
}

export function toolVersions(cfg: Config): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, cmd] of [
    ["claude", [claudeBin(), "--version"]],
    ["gh", [process.env.GH_BIN ?? "gh", "--version"]],
    ["git", ["git", "--version"]],
    ["bun", ["bun", "--version"]],
  ] as const) {
    try {
      const r = sh([...cmd], { env: childEnv(cfg) });
      out[name] = (r.out || r.err).split("\n")[0] || `rc=${r.code}`;
    } catch (e) {
      out[name] = `unavailable: ${(e as Error).name}`;
    }
  }
  return out;
}

export function budgetCheck(cfg: Config, ledger: Ledger) {
  const nToday = ledger.countToday();
  const nActive = ledger.countActive();
  if (nToday >= cfg.budget.maxJobsPerDay) fail(`예산 초과: 오늘 이미 ${nToday}건 접수 (상한 ${cfg.budget.maxJobsPerDay})`);
  if (nActive >= cfg.budget.maxConcurrent)
    fail(`동시 진행 상한: ${nActive}건 (상한 ${cfg.budget.maxConcurrent}). SUBMIT_UNKNOWN 은 reconcile, PR_OPEN 은 check 하세요.`);
}

export function newJob(ledger: Ledger, jobFile: string, path: string, prefix: "j" | "a" = "j") {
  const text = readFileSync(jobFile, "utf8");
  const title = text.split("\n").map((l) => l.replace(/^[#\s]+/, "").trim()).find(Boolean) ?? "untitled";
  const jobId = newJobId(prefix);
  ledger.insertJob({ job_id: jobId, title, job_file: jobFile, path, status: "CREATED", branch: `claude/${jobId}` });
  return { jobId, text };
}

export function rules(cfg: Config, jobId: string) {
  const prot = [...cfg.protect.prefixes, ...cfg.protect.files].join(", ");
  const done = cfg.agent.doneCommands.length ? cfg.agent.doneCommands.join(" / ") : "(저장소 README 의 검증 명령)";
  return `
[디스패처 규칙 — 작업지시서보다 우선]
- 다음 경로는 수정하지 않는다: ${prot}
  (수정하면 디스패처 검사에서 NEEDS_HUMAN 으로 멈춘다)
- 완료 전 실행: ${done}
- 커밋 메시지 첫 줄에 [${jobId}] 를 붙이고 현재 브랜치에 커밋만 한다. push와 PR 생성은 하지 않는다.
- 막히면 우회하지 말고 이유를 적고 멈춘다.
- 마지막 메시지 형식:
  RESULT: success | blocked | failed
  JOB_ID: ${jobId}
  SUMMARY: <한두 문장>
`;
}

export interface RunSummary {
  exit_code: number | null;
  interrupted: boolean;
  result_seen: boolean;
  is_error: boolean | null;
  subtype: string | null;
  num_turns: number | null;
  duration_s: number;
  total_cost_usd: number | null;
  dirty_worktree: boolean;
  new_commits: string;
  head_sha: string;
  base_sha: string;
  versions: Record<string, string>;
  final_text_tail: string;
}

/** 로컬 실행 단계. 반환: [jobId, 다음 단계로 진행 가능 여부]. */
export async function runLocal(cfg: Config, ledger: Ledger, jobFile: string, push = true): Promise<[string, boolean]> {
  budgetCheck(cfg, ledger);
  const { jobId, text } = newJob(ledger, jobFile, "local");
  const branch = `claude/${jobId}`;
  const wt = resolve(cfg.root, "..", `wt-${jobId}`);
  const baseSha = git(cfg.root, "rev-parse", cfg.baseBranch);
  git(cfg.root, "worktree", "add", wt, "-b", branch, cfg.baseBranch);
  const runDir = join(ledger.runsDir, jobId);
  mkdirSync(runDir, { recursive: true });
  const versions = toolVersions(cfg);
  ledger.logEvent(jobId, "RUN_CONTEXT", { base_sha: baseSha, versions });
  const sessionId = crypto.randomUUID();
  const prompt = `JOB_ID: ${jobId}\n\n${text}\n${rules(cfg, jobId)}`;
  const cmd = [
    claudeBin(), "-p", prompt,
    "--output-format", "stream-json", "--verbose",
    "--session-id", sessionId,
    "--permission-mode", "acceptEdits",
    "--allowedTools", cfg.agent.allowedTools.join(","),
    "--max-turns", String(cfg.agent.maxTurns),
  ];
  ledger.setStatus(jobId, "RUNNING", { session_id: sessionId, note: wt });
  console.log(`[${jobId}] 실행 시작 · worktree=${wt} · session=${sessionId}`);

  const started = Date.now();
  const logPath = join(runDir, "stream.jsonl");
  writeFileSync(logPath, "");
  const proc = Bun.spawn(cmd, { cwd: wt, env: childEnv(cfg), stdout: "pipe", stderr: "pipe" });
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    proc.kill("SIGTERM");
    setTimeout(() => proc.killed || proc.kill("SIGKILL"), 10_000).unref();
  };
  process.once("SIGINT", onSigint);

  let result: any = null;
  let buf = "";
  const decoder = new TextDecoder();
  for await (const chunk of proc.stdout) {
    const s = decoder.decode(chunk, { stream: true });
    appendFileSync(logPath, s);
    buf += s;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const ev = JSON.parse(line);
        if (ev.type === "result") result = ev;
      } catch {}
    }
  }
  const exitCode = await proc.exited;
  process.removeListener("SIGINT", onSigint);
  writeFileSync(join(runDir, "stderr.txt"), await new Response(proc.stderr).text());

  const dirty = Boolean(gitSoft(wt, "status", "--porcelain"));
  const base = gitSoft(wt, "merge-base", "HEAD", cfg.baseBranch) || "HEAD";
  const ahead = gitSoft(wt, "rev-list", "--count", `${base}..HEAD`);
  const head = gitSoft(wt, "rev-parse", "HEAD");
  const summary: RunSummary = {
    exit_code: exitCode,
    interrupted,
    result_seen: result !== null,
    is_error: result?.is_error ?? null,
    subtype: result?.subtype ?? null,
    num_turns: result?.num_turns ?? null,
    duration_s: Math.round((Date.now() - started) / 1000),
    total_cost_usd: result?.total_cost_usd ?? null,
    dirty_worktree: dirty,
    new_commits: ahead,
    head_sha: head,
    base_sha: baseSha,
    versions,
    final_text_tail: String(result?.result ?? "").slice(-400),
  };
  // 중단 경로에서도 요약을 남긴다 (v0.3 E4 발견: 중단 시 summary.json 이 없었음)
  writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
  if (summary.total_cost_usd !== null) ledger.logEvent(jobId, "COST", { usd: summary.total_cost_usd, source: "claude.result" });

  if (interrupted) {
    ledger.setStatus(jobId, "INTERRUPTED", { note: `user interrupt; dirty=${dirty}` });
    console.log(`[${jobId}] 중단됨. 재개하려면 worktree에서: claude --resume ${sessionId}`);
    return [jobId, false];
  }
  console.log(JSON.stringify(summary, null, 2));

  const ok = result !== null && result.is_error === false && result.subtype === "success" && !dirty && !["", "0"].includes(ahead);
  if (!ok) {
    const note = JSON.stringify({ is_error: summary.is_error, subtype: summary.subtype, dirty_worktree: dirty, new_commits: ahead });
    ledger.setStatus(jobId, "AGENT_FAILED", { note });
    console.log(`[${jobId}] AGENT_FAILED → 다음 단계로 진행하지 않음`);
    return [jobId, false];
  }

  const prot = protectedChanges(cfg, head);
  if (prot.length) {
    ledger.setStatus(jobId, "NEEDS_HUMAN", { note: `protected paths changed: ${JSON.stringify(prot)}` });
    console.log(`[${jobId}] 보호 경로 변경 감지 → NEEDS_HUMAN, 자동 처리 중단: ${prot}`);
    return [jobId, false];
  }

  ledger.setStatus(jobId, "AGENT_DONE");
  console.log(`[${jobId}] AGENT_DONE (완료 아님)`);
  if (push) {
    const r = sh(["git", "push", "-u", "origin", branch], { cwd: wt });
    if (r.code !== 0) {
      ledger.setStatus(jobId, "PUSH_FAILED", { note: r.err.slice(0, 300) });
      console.log(`[${jobId}] push 실패: ${r.err.slice(0, 300)}`);
      return [jobId, false];
    }
    ledger.setStatus(jobId, "PUSHED");
    console.log(`[${jobId}] push 완료: ${branch}`);
  }
  return [jobId, true];
}
