#!/usr/bin/env bun
/**
 * dispatcher — LLM 이 제안하고, 이 코드가 집행한다.
 *
 * 검증 대상 저장소 밖에 설치되고, 저장소 루트의 `.dispatcher.toml` 을 읽는다.
 * 항상 깨끗한 base 브랜치 체크아웃에서 실행한다 (기본: 현재 작업 디렉터리, --repo 로 지정).
 *
 *   dispatcher run <job.md>                 로컬 경로 완주: 실행→보호검사→push→봇 PR→CI 대기→기록
 *   dispatcher run-local <job.md> [--no-push]
 *   dispatcher fire <job.md>                Routine 접수 (비교 실험)
 *   dispatcher reconcile <JOB_ID> --session-url URL | --not-found
 *   dispatcher routine-result <JOB_ID> blocked|failed --note "..."
 *   dispatcher open-pr <JOB_ID>
 *   dispatcher check <JOB_ID> [--wait]
 *   dispatcher decide <JOB_ID> approve|reject --reason "..."
 *   dispatcher adopt <branch> [--title T]
 *   dispatcher status [--json]
 *
 * 환경 변수: CLAUDE_BIN, GH_BIN, BOT_GH_TOKEN | BOT_GH_TOKEN_CMD, ROUTINE_URL, ROUTINE_TOKEN,
 *            CI_TIMEOUT_S(1200), CI_POLL_S(30), DISPATCHER_STATE_DIR
 */
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { adopt, checkOnce, checkWait, decide, fire, openPr, reconcile, routineResult, run, status } from "./commands";
import { loadConfig } from "./config";
import { GhError } from "./gh";
import { Ledger } from "./ledger";
import { runLocal } from "./runner";
import { Exit, fail } from "./util";

const USAGE = "사용법: dispatcher <run|run-local|fire|reconcile|routine-result|open-pr|check|decide|adopt|status> ... (--repo DIR)";

export async function main(argv: string[]) {
  const { values: o, positionals: p } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      "no-push": { type: "boolean" },
      wait: { type: "boolean" },
      reason: { type: "string" },
      note: { type: "string" },
      title: { type: "string" },
      "session-url": { type: "string" },
      "not-found": { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  const [cmd, a1, a2] = p;
  if (!cmd) fail(USAGE);
  const cfg = loadConfig(resolve(o.repo ?? process.cwd()));
  const ledger = new Ledger(cfg.project);
  const need = (v: string | undefined, what: string) => v ?? fail(`${cmd}: ${what} 가 필요합니다`);

  switch (cmd) {
    case "run":
      return run(cfg, ledger, need(a1, "작업지시서 경로"));
    case "run-local":
      return void (await runLocal(cfg, ledger, need(a1, "작업지시서 경로"), !o["no-push"]));
    case "fire":
      return fire(cfg, ledger, need(a1, "작업지시서 경로"));
    case "reconcile":
      if (Boolean(o["session-url"]) === Boolean(o["not-found"])) fail("reconcile: --session-url 또는 --not-found 중 하나만");
      return reconcile(ledger, need(a1, "JOB_ID"), { sessionUrl: o["session-url"], notFound: o["not-found"] });
    case "routine-result": {
      const r = need(a2, "blocked|failed");
      if (r !== "blocked" && r !== "failed") fail("routine-result: blocked 또는 failed");
      return routineResult(ledger, need(a1, "JOB_ID"), r, need(o.note, "--note"));
    }
    case "open-pr":
      try {
        return void openPr(cfg, ledger, need(a1, "JOB_ID"));
      } catch (e) {
        if (!(e instanceof GhError)) throw e;
        ledger.logEvent(a1!, "GH_ERROR", { op: "open-pr", error: e.message });
        fail(`[${a1}] GitHub 오류(검증 실패 아님): ${e.message}`);
      }
    case "check": {
      const id = need(a1, "JOB_ID");
      const s = o.wait ? await checkWait(cfg, ledger, id) : checkOnce(cfg, ledger, id);
      return console.log(`[${id}] → ${s}`);
    }
    case "decide": {
      const v = need(a2, "approve|reject");
      if (v !== "approve" && v !== "reject") fail("decide: approve 또는 reject");
      return decide(cfg, ledger, need(a1, "JOB_ID"), v, need(o.reason, "--reason"));
    }
    case "adopt":
      return void adopt(cfg, ledger, need(a1, "브랜치"), o.title ?? "GitHub 연결 확인");
    case "status":
      return status(ledger, Boolean(o.json));
    default:
      fail(USAGE);
  }
}

if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2));
  } catch (e) {
    if (e instanceof Exit) {
      console.error(e.message);
      process.exit(e.code);
    }
    throw e;
  }
}
