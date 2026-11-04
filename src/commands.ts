import { type Config } from "./config";
import { evaluateChecks, type Evidence } from "./checks";
import { trustedProtectedCheck } from "./git";
import { GhError, botToken, ghOk, prHeadSha } from "./gh";
import { type Ledger } from "./ledger";
import { budgetCheck, newJob, runLocal } from "./runner";
import { fail, newJobId, sh } from "./util";

// ---------------- PR / CI / 판단 ----------------
export function openPr(cfg: Config, ledger: Ledger, jobId: string): string {
  const row = ledger.get(jobId);
  const existing = JSON.parse(ghOk(cfg, ["pr", "list", "--head", row.branch, "--state", "open", "--json", "url"]) || "[]");
  let url: string;
  if (existing.length) {
    url = existing[0].url;
    console.log(`[${jobId}] 기존 PR 재사용: ${url}`);
    if (row.pr_url === url) return url; // 이미 기록된 PR 이면 상태를 되돌리지 않는다
  } else {
    const body =
      `JOB_ID: ${jobId}\npath: ${row.path}\nsession: ${row.session_url ?? row.session_id}\n` +
      `job: ${row.job_file}\n\n자동 머지·자동 배포 없음. 사람 판단 필요.`;
    url = ghOk(cfg, ["pr", "create", "--head", row.branch, "--base", cfg.baseBranch, "--title", `[${jobId}] ${row.title}`, "--body", body])
      .split("\n")
      .at(-1)!;
    console.log(`[${jobId}] PR 생성: ${url}`);
  }
  ledger.setStatus(jobId, "PR_OPEN", { pr_url: url });
  return url;
}

/** 한 번 판정. 반환: 최종 상태 또는 'PENDING' / 'CHECK_ERROR'. */
export function checkOnce(cfg: Config, ledger: Ledger, jobId: string): string {
  const row = ledger.get(jobId);
  if (!row.pr_url) fail("PR이 아직 없습니다.");
  let head: string, state: string, headAfter: string;
  let res: ReturnType<typeof evaluateChecks>;
  try {
    ({ sha: head, state } = prHeadSha(cfg, row.pr_url));
    res = evaluateChecks(cfg, head);
    headAfter = prHeadSha(cfg, row.pr_url).sha; // 판정 도중 head 변경 방지
  } catch (e) {
    if (!(e instanceof GhError)) throw e;
    ledger.logEvent(jobId, "CHECK_ERROR", { error: e.message });
    console.log(`[${jobId}] 조회 오류(검증 실패 아님): ${e.message}`);
    return "CHECK_ERROR";
  }
  if (headAfter !== head) {
    ledger.logEvent(jobId, "HEAD_MOVED", { from: head, to: headAfter });
    return "PENDING";
  }
  if (state !== "OPEN") {
    ledger.setStatus(jobId, "PR_CLOSED", { note: `PR state ${state}` });
    console.log(`[${jobId}] PR 상태 ${state} → 판정하지 않음`);
    return "PR_CLOSED";
  }
  const { verdict, detail, evidence } = res;
  console.log(`[${jobId}] head=${head.slice(0, 10)} ${JSON.stringify(detail)} → ${verdict}`);
  if (verdict === "PENDING") return "PENDING";
  if (verdict === "UNCERTAIN") {
    ledger.logEvent(jobId, "CHECK_ERROR", { error: "check results incomplete", detail });
    console.log(`[${jobId}] 체크 전체 조회를 확정할 수 없음 → 판정 보류`);
    return "CHECK_ERROR";
  }
  const prot = trustedProtectedCheck(cfg, row.branch, head);
  if (prot === null) {
    ledger.logEvent(jobId, "CHECK_ERROR", { error: `trusted check unavailable: ${head} not fetchable` });
    console.log(`[${jobId}] 신뢰된 보호 경로 검사 불가(커밋 ${head.slice(0, 10)} 없음) → 판정 보류`);
    return "CHECK_ERROR";
  }
  if (verdict === "PASS" && prot.length) {
    ledger.setStatus(jobId, "NEEDS_HUMAN", { verify_sha: head, note: `trusted check: protected paths ${JSON.stringify(prot)}` });
    return "NEEDS_HUMAN";
  }
  const status = ({ PASS: "VERIFIED", FAIL: "VERIFY_FAILED", PROTECTED_FAIL: "NEEDS_HUMAN", INCOMPLETE: "VERIFY_INCOMPLETE" } as const)[verdict];
  ledger.setStatus(jobId, status, { verify_sha: head, verify_evidence: JSON.stringify(evidence), note: JSON.stringify(detail) });
  return status;
}

export async function checkWait(cfg: Config, ledger: Ledger, jobId: string): Promise<string> {
  const timeout = Number(process.env.CI_TIMEOUT_S ?? 1200);
  const poll = Number(process.env.CI_POLL_S ?? 30);
  const deadline = Date.now() + timeout * 1000;
  let errors = 0;
  for (;;) {
    const s = checkOnce(cfg, ledger, jobId);
    if (s !== "PENDING" && s !== "CHECK_ERROR") return s;
    errors = s === "CHECK_ERROR" ? errors + 1 : 0;
    if (errors >= 3) {
      ledger.setStatus(jobId, "CHECK_ERROR", { note: "3회 연속 조회 오류" });
      return "CHECK_ERROR";
    }
    if (Date.now() + poll * 1000 > deadline) {
      ledger.setStatus(jobId, "VERIFY_TIMEOUT", { note: `${timeout}s 초과` });
      return "VERIFY_TIMEOUT";
    }
    await Bun.sleep(poll * 1000);
  }
}

/** 로컬 경로 완주. 사람 판단 직전에서 멈춘다. 자동 머지·배포 없음. */
export async function run(cfg: Config, ledger: Ledger, jobFile: string) {
  const [jobId, ok] = await runLocal(cfg, ledger, jobFile, true);
  if (!ok) return;
  try {
    botToken(); // PR 단계 전에 토큰 확인
    openPr(cfg, ledger, jobId);
  } catch (e) {
    if (!(e instanceof GhError)) throw e;
    ledger.setStatus(jobId, "PR_FAILED", { note: e.message.slice(0, 300) });
    console.log(`[${jobId}] PR 단계 실패(GitHub 오류): ${e.message}`);
    return;
  }
  const s = await checkWait(cfg, ledger, jobId);
  console.log(`\n[${jobId}] 최종 상태: ${s}`);
  if (s === "VERIFIED") console.log(`→ 사람 판단 대기. GitHub에서 리뷰 후:\n  dispatcher decide ${jobId} approve --reason "..."`);
}

export function decide(cfg: Config, ledger: Ledger, jobId: string, verdict: "approve" | "reject", reasonRaw: string) {
  const row = ledger.get(jobId);
  const reason = reasonRaw.trim();
  if (!reason) fail("--reason 은 필수입니다. 판단 이유가 판정 기준의 원재료입니다.");
  const sha = row.verify_sha;
  let evidence: Evidence = JSON.parse(row.verify_evidence ?? "{}"); // reject 는 마지막 검증 근거를 기록
  if (verdict === "approve") {
    if (row.status !== "VERIFIED") fail(`승인은 VERIFIED 에서만 가능 (현재 ${row.status}).`);
    let current: string, state: string;
    try {
      ({ sha: current, state } = prHeadSha(cfg, row.pr_url!));
    } catch (e) {
      fail(`PR head 재조회 실패 → 승인 보류: ${(e as Error).message}`);
    }
    if (state !== "OPEN") fail(`PR 상태가 ${state} 입니다 (OPEN 아님) → 승인 거부.`);
    if (current !== sha) {
      ledger.setStatus(jobId, "PR_OPEN", { note: `head changed ${sha?.slice(0, 10)}→${current.slice(0, 10)}; 재검증 필요` });
      fail(`검증 SHA(${sha?.slice(0, 10)})와 현재 PR head(${current.slice(0, 10)})가 다릅니다 → 승인 거부. check 로 재검증하세요.`);
    }
    // 같은 SHA라도 CI가 재실행됐을 수 있다 → 최신 결과·출처를 다시 확인
    let re: ReturnType<typeof evaluateChecks>;
    try {
      re = evaluateChecks(cfg, current);
    } catch (e) {
      fail(`체크 재조회 실패 → 승인 보류: ${(e as Error).message}`);
    }
    if (re.verdict !== "PASS") {
      const back = ({ FAIL: "VERIFY_FAILED", PROTECTED_FAIL: "NEEDS_HUMAN", INCOMPLETE: "VERIFY_INCOMPLETE" } as Record<string, string>)[re.verdict] ?? "PR_OPEN";
      ledger.setStatus(jobId, back, { note: `pre-approval recheck: ${re.verdict} ${JSON.stringify(re.detail)}` });
      fail(`승인 직전 재확인 결과 ${re.verdict} → 승인 거부 (상태 ${back}). ${JSON.stringify(re.detail)}`);
    }
    evidence = re.evidence;
    const prot = trustedProtectedCheck(cfg, row.branch, current);
    if (prot === null) fail(`커밋 ${current.slice(0, 10)} 를 로컬에서 볼 수 없어 보호 경로 검사 불가 → 승인 보류`);
    if (prot.length) {
      ledger.setStatus(jobId, "NEEDS_HUMAN", { note: `protected paths ${JSON.stringify(prot)}` });
      fail(`보호 경로 변경이 있어 자동 승인 대상이 아닙니다: ${prot}`);
    }
  }
  const verifiedAt = ledger.verifiedAt(jobId);
  const latency = verifiedAt ? Math.round((Date.now() - Date.parse(verifiedAt)) / 1000) : null;
  ledger.recordDecision({ job_id: jobId, verdict, reason, sha, evidence, latency_s: latency });
  ledger.setStatus(jobId, verdict === "approve" ? "HUMAN_APPROVED" : "REJECTED", { note: reason });
  console.log(`[${jobId}] ${verdict} 기록 (sha=${(sha ?? "").slice(0, 10)}, checks=${JSON.stringify(Object.values(evidence).map((v) => v.id))}, 판단 지연=${latency ?? "?"}s)`);
  console.log("  이 기록은 지금 시점의 사람 판단이다. GitHub 리뷰 승인·머지는 GitHub에서 따로 하고, 머지 시점의 필수 체크를 대체하지 않는다.");
}

// ---------------- Routine (비교 실험) ----------------
export async function fire(cfg: Config, ledger: Ledger, jobFile: string) {
  const url = process.env.ROUTINE_URL;
  const token = process.env.ROUTINE_TOKEN;
  if (!url || !token) fail("ROUTINE_URL, ROUTINE_TOKEN 환경 변수가 필요합니다.");
  budgetCheck(cfg, ledger);
  const { jobId, text } = newJob(ledger, jobFile, "routine");
  ledger.setStatus(jobId, "SUBMITTING"); // 요청 전에 먼저 기록 (멱등 키가 없으므로 자동 재시도 안 함)
  try {
    const r = await fetch(url, {
      method: "POST",
      body: JSON.stringify({ text: `JOB_ID: ${jobId}\n\n${text}` }),
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "experimental-cc-routine-2026-04-01",
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (r.ok) {
      const body: any = await r.json();
      ledger.setStatus(jobId, "SUBMITTED", { session_id: body.claude_code_session_id ?? null, session_url: body.claude_code_session_url ?? null });
      console.log(`[${jobId}] 접수됨 → ${body.claude_code_session_url}`);
      console.log(`   브랜치 claude/${jobId} 가 push 되면: open-pr ${jobId} → check ${jobId} --wait`);
      return;
    }
    const detail = (await r.text()).slice(0, 500);
    if ([400, 401, 403, 404, 429].includes(r.status)) {
      ledger.setStatus(jobId, "SUBMIT_FAILED", { note: `HTTP ${r.status} ${detail}` });
      console.log(`[${jobId}] 접수 실패 HTTP ${r.status}: ${detail}`);
    } else {
      ledger.setStatus(jobId, "SUBMIT_UNKNOWN", { note: `HTTP ${r.status} ${detail}` });
      console.log(`[${jobId}] 접수 불확실(HTTP ${r.status}). 자동 재시도 안 함 → 세션 확인 후 reconcile`);
    }
  } catch (e) {
    ledger.setStatus(jobId, "SUBMIT_UNKNOWN", { note: String(e) });
    console.log(`[${jobId}] 접수 불확실(${e}). 자동 재시도 안 함 → claude.ai/code 에서 '${jobId}' 세션 확인 후 reconcile`);
  }
}

export function reconcile(ledger: Ledger, jobId: string, opts: { sessionUrl?: string; notFound?: boolean }) {
  const row = ledger.get(jobId);
  if (row.status !== "SUBMIT_UNKNOWN") fail(`reconcile 대상 아님 (현재 ${row.status})`);
  if (opts.notFound) ledger.setStatus(jobId, "SUBMIT_FAILED", { note: "reconciled: session not found" });
  else ledger.setStatus(jobId, "SUBMITTED", { session_url: opts.sessionUrl ?? null, note: "reconciled" });
  console.log(`[${jobId}] → ${ledger.get(jobId).status}`);
}

/** Routine 세션이 push 없이 끝났을 때 결과를 장부에 반영 (v0.3 E6 발견: 반영 명령이 없었음). */
export function routineResult(ledger: Ledger, jobId: string, result: "blocked" | "failed", note: string) {
  const row = ledger.get(jobId);
  if (row.path !== "routine" || row.status !== "SUBMITTED") fail(`routine-result 대상 아님 (path=${row.path}, 현재 ${row.status})`);
  if (!note.trim()) fail("--note 는 필수입니다 (세션의 RESULT·SUMMARY 를 적으세요).");
  ledger.setStatus(jobId, result === "blocked" ? "ROUTINE_BLOCKED" : "ROUTINE_FAILED", { note });
  console.log(`[${jobId}] → ${ledger.get(jobId).status}`);
}

/** 이미 push된 브랜치를 장부에 등록 (GitHub 연결 확인용, Claude 실행 없음). */
export function adopt(cfg: Config, ledger: Ledger, branch: string, title: string) {
  if (sh(["git", "ls-remote", "--exit-code", "origin", `refs/heads/${branch}`], { cwd: cfg.root }).code !== 0)
    fail(`원격에 브랜치가 없습니다: ${branch}`);
  const jobId = newJobId("a");
  ledger.insertJob({ job_id: jobId, title, job_file: "", path: "adopted", status: "PUSHED", branch });
  console.log(`[${jobId}] 등록: ${branch} → open-pr ${jobId} → check ${jobId} --wait`);
  return jobId;
}

export function status(ledger: Ledger, json: boolean) {
  const rows = ledger.recent(30).map(({ job_id, status, path, title, verify_sha, pr_url, updated_at }) => ({
    job_id, status, path, title, verify_sha, pr_url, updated_at,
  }));
  if (json) return console.log(JSON.stringify(rows, null, 2));
  for (const r of rows)
    console.log(`${r.job_id.padEnd(26)} ${r.status.padEnd(17)} ${r.path.padEnd(8)} ${(r.verify_sha ?? "").slice(0, 8).padEnd(9)} ${r.title.slice(0, 36)}`);
  const d = ledger.decisionCounts();
  if (d.length) console.log("판단 기록:", d.map((x) => `${x.verdict}=${x.n}`).join(", "));
}
