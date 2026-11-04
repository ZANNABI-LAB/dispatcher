import { type Config } from "./config";
import { ghPaginate } from "./gh";

export type Verdict = "PASS" | "PENDING" | "FAIL" | "PROTECTED_FAIL" | "INCOMPLETE" | "UNCERTAIN";
export type Evidence = Record<string, { id: number; url: string; conclusion: string | null; check_suite_id: number | null }>;

/**
 * 필수 체크를 headSha 기준으로, 신뢰하는 출처에 한해 판정한다.
 * 신뢰 조건: app.slug == 설정값, check suite 가 이 SHA 의 설정된 workflow(event) 실행에 속함.
 * 전체 조회를 확정할 수 없으면 UNCERTAIN → VERIFIED 금지.
 */
export function evaluateChecks(cfg: Config, headSha: string): { verdict: Verdict; detail: Record<string, unknown>; evidence: Evidence } {
  const { checks } = cfg;
  const runs = ghPaginate(cfg, `repos/{owner}/{repo}/commits/${headSha}/check-runs?filter=all`, "check_runs");
  const wruns = ghPaginate(cfg, `repos/{owner}/{repo}/actions/runs?head_sha=${headSha}`, "workflow_runs");
  if (runs.pending || wruns.pending) return { verdict: "PENDING", detail: { note: "gh rc=8" }, evidence: {} };
  if (!(runs.complete && wruns.complete))
    return {
      verdict: "UNCERTAIN",
      detail: { note: "pagination incomplete", check_runs: runs.items.length, workflow_runs: wruns.items.length },
      evidence: {},
    };

  const trustedSuites = new Set(
    wruns.items
      .filter((w) => (w.path ?? "").split("@")[0] === checks.workflowPath && w.event === checks.event && w.head_sha === headSha)
      .map((w) => w.check_suite_id),
  );
  const latest = new Map<string, any>();
  let ignored = 0;
  for (const run of runs.items) {
    if (!checks.required.includes(run.name)) continue;
    const suite = run.check_suite?.id;
    const trusted = run.head_sha === headSha && run.app?.slug === checks.trustedAppSlug && trustedSuites.has(suite);
    if (!trusted) {
      ignored++; // 이름·SHA 가 같아도 출처가 다르면 무시
      continue;
    }
    const prev = latest.get(run.name);
    if (!prev || (run.id ?? 0) > (prev.id ?? 0)) latest.set(run.name, run); // 신뢰 출처 안에서 최신 재실행
  }

  const detail: Record<string, unknown> = {};
  for (const n of checks.required) {
    const r = latest.get(n);
    detail[n] = r ? [r.status, r.conclusion] : ["missing", null];
  }
  detail.ignored_untrusted = ignored;
  const evidence: Evidence = {};
  for (const [n, r] of latest)
    evidence[n] = { id: r.id, url: r.html_url ?? r.details_url, conclusion: r.conclusion, check_suite_id: r.check_suite?.id ?? null };

  if (checks.required.some((n) => latest.get(n)?.status !== "completed")) return { verdict: "PENDING", detail, evidence };
  const conc = Object.fromEntries(checks.required.map((n) => [n, latest.get(n).conclusion as string]));
  if (conc[checks.protectedCheck] === "failure") return { verdict: "PROTECTED_FAIL", detail, evidence };
  if (Object.values(conc).every((c) => c === "success")) return { verdict: "PASS", detail, evidence };
  if (Object.values(conc).some((c) => ["failure", "timed_out", "action_required", "startup_failure"].includes(c)))
    return { verdict: "FAIL", detail, evidence };
  return { verdict: "INCOMPLETE", detail, evidence }; // skipped, cancelled, neutral, stale
}
