// 회귀 테스트: ogan_maum poc/experiments.md A절의 모의 검증 17개 사례 + v0.4 수정 사항.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cr, passing, setup, wr } from "./helpers";

describe("CI 판정 (check)", () => {
  test("#1 필수 체크 누락 → VERIFIED 아님, 대기 후 VERIFY_TIMEOUT", () => {
    const t = setup();
    const id = t.adoptedPr();
    t.setGh({ checkRuns: [cr("analyze-and-test")], workflowRuns: [wr()] });
    expect(t.dispatcher(["check", id, "--wait"]).out).toContain("→ VERIFY_TIMEOUT");
  });

  test("#2 analyze-and-test skipped → VERIFY_INCOMPLETE", () => {
    const t = setup();
    const id = t.adoptedPr();
    t.setGh({ checkRuns: [cr("analyze-and-test", { conclusion: "skipped" }), cr("protected-paths", { id: 2 })], workflowRuns: [wr()] });
    expect(t.dispatcher(["check", id]).out).toContain("→ VERIFY_INCOMPLETE");
  });

  test("#3 pending / gh rc=8 / 다른 SHA 체크만 → 예외 없이 대기", () => {
    const t = setup();
    const id = t.adoptedPr();
    t.setGh({ checkRuns: [cr("analyze-and-test", { status: "in_progress", conclusion: null }), cr("protected-paths", { id: 2 })], workflowRuns: [wr()] });
    expect(t.dispatcher(["check", id]).out).toContain("→ PENDING");
    t.setGh({ rc: { api: 8 } });
    expect(t.dispatcher(["check", id]).out).toContain("→ PENDING");
    t.setGh({ rc: {}, checkRuns: [cr("analyze-and-test", { sha: "deadbeef" }), cr("protected-paths", { id: 2, sha: "deadbeef" })], workflowRuns: [wr({ sha: "deadbeef" })] });
    expect(t.dispatcher(["check", id]).out).toContain("→ PENDING");
    expect(t.job(id).status).toBe("PR_OPEN");
  });

  test("#4 인증 오류(401) → CHECK_ERROR 이벤트, 상태 유지", () => {
    const t = setup();
    const id = t.adoptedPr();
    t.setGh({ rc: { all: 1 } });
    expect(t.dispatcher(["check", id]).out).toContain("→ CHECK_ERROR");
    expect(t.job(id).status).toBe("PR_OPEN");
    expect(t.events(id).some((e) => e.kind === "CHECK_ERROR")).toBe(true);
  });

  test("#5 체크 실패 → VERIFY_FAILED / protected-paths 실패 → NEEDS_HUMAN", () => {
    const t = setup();
    const id = t.adoptedPr();
    t.setGh({ checkRuns: [cr("analyze-and-test", { conclusion: "failure" }), cr("protected-paths", { id: 2 })], workflowRuns: [wr()] });
    expect(t.dispatcher(["check", id]).out).toContain("→ VERIFY_FAILED");
    const t2 = setup();
    const id2 = t2.adoptedPr();
    t2.setGh({ checkRuns: [cr("analyze-and-test"), cr("protected-paths", { id: 2, conclusion: "failure" })], workflowRuns: [wr()] });
    expect(t2.dispatcher(["check", id2]).out).toContain("→ NEEDS_HUMAN");
  });

  test("#6 두 체크 통과(재실행 시 최신 run 기준) → VERIFIED + 검증 SHA·check-run 근거", () => {
    const t = setup();
    const id = t.adoptedPr();
    t.setGh({
      checkRuns: [cr("analyze-and-test", { id: 101, conclusion: "failure" }), cr("analyze-and-test", { id: 105 }), cr("protected-paths", { id: 102 })],
      workflowRuns: [wr()],
    });
    expect(t.dispatcher(["check", id]).out).toContain("→ VERIFIED");
    const j = t.job(id);
    expect(j.verify_sha).toBe(t.gh().prs[0].head);
    expect(JSON.parse(j.verify_evidence)["analyze-and-test"].id).toBe(105);
  });

  test("#7 같은 이름·SHA 지만 다른 출처만 존재 → VERIFIED 아님", () => {
    const t = setup();
    const id = t.adoptedPr();
    t.setGh({ checkRuns: [cr("analyze-and-test", { slug: "evil-app" }), cr("protected-paths", { id: 2, slug: "evil-app" })], workflowRuns: [wr()] });
    const r = t.dispatcher(["check", id]);
    expect(r.out).toContain("→ PENDING");
    expect(r.out).toContain('"ignored_untrusted":2');
  });

  test("#8 신뢰 체크 통과 + 다른 출처의 같은 이름 실패(더 최신) → 다른 출처 무시, VERIFIED", () => {
    const t = setup();
    const id = t.adoptedPr();
    t.setGh({ checkRuns: [...passing().checkRuns, cr("analyze-and-test", { id: 999, conclusion: "failure", suite: 7 })], workflowRuns: [wr()] });
    expect(t.dispatcher(["check", id]).out).toContain("→ VERIFIED");
  });

  test("#9 결과 150개, 필수 체크가 2페이지 → 전부 조회 후 VERIFIED", () => {
    const t = setup();
    const id = t.adoptedPr();
    const noise = Array.from({ length: 148 }, (_, i) => cr(`lint-${i}`, { id: i + 1 }));
    t.setGh({ checkRuns: [...noise, ...passing().checkRuns], workflowRuns: [wr()] });
    expect(t.dispatcher(["check", id]).out).toContain("→ VERIFIED");
  });

  test("#10 total_count 가 실제보다 큼 → 판정 보류 (VERIFIED 아님)", () => {
    const t = setup();
    const id = t.adoptedPr();
    t.setGh({ ...passing(), totalCount: { check_runs: 50 } });
    expect(t.dispatcher(["check", id]).out).toContain("→ CHECK_ERROR");
    expect(t.job(id).status).toBe("PR_OPEN");
  });
});

describe("사람 판단 (decide)", () => {
  const verified = () => {
    const t = setup();
    const id = t.adoptedPr();
    t.setGh(passing());
    expect(t.dispatcher(["check", id]).out).toContain("→ VERIFIED");
    return { t, id };
  };

  test("#11 VERIFIED 이후 같은 SHA 재실행 중 → 승인 거부 → PR_OPEN", () => {
    const { t, id } = verified();
    t.setGh({ checkRuns: [cr("analyze-and-test", { id: 200, status: "in_progress", conclusion: null }), cr("protected-paths", { id: 102 })] });
    const r = t.dispatcher(["decide", id, "approve", "--reason", "ok"]);
    expect(r.code).not.toBe(0);
    expect(t.job(id).status).toBe("PR_OPEN");
  });

  test("#12 VERIFIED 이후 같은 SHA 재실행 실패 → 승인 거부 → VERIFY_FAILED", () => {
    const { t, id } = verified();
    t.setGh({ checkRuns: [cr("analyze-and-test", { id: 200, conclusion: "failure" }), cr("protected-paths", { id: 102 })] });
    expect(t.dispatcher(["decide", id, "approve", "--reason", "ok"]).code).not.toBe(0);
    expect(t.job(id).status).toBe("VERIFY_FAILED");
  });

  test("#13 검증 후 PR head 변경 → 승인 거부", () => {
    const { t, id } = verified();
    const s = t.gh();
    s.prs[0].head = "0".repeat(40);
    t.setGh(s);
    const r = t.dispatcher(["decide", id, "approve", "--reason", "ok"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("다릅니다");
  });

  test("#14 정상 승인 → HUMAN_APPROVED, decisions 에 SHA + check-run ID + 판단 지연", () => {
    const { t, id } = verified();
    const r = t.dispatcher(["decide", id, "approve", "--reason", "인수 테스트 통과"]);
    expect(r.code).toBe(0);
    expect(t.job(id).status).toBe("HUMAN_APPROVED");
    const d: any = t.db().query("SELECT * FROM decisions WHERE job_id=?").get(id);
    expect(d.sha).toBe(t.gh().prs[0].head);
    expect(Object.values(JSON.parse(d.evidence)).map((v: any) => v.id).sort()).toEqual([101, 102]);
    expect(typeof d.latency_s).toBe("number");
  });

  test("v0.3.1 닫힌 PR → 승인 거부, check 는 PR_CLOSED", () => {
    const { t, id } = verified();
    const s = t.gh();
    s.prs[0].state = "CLOSED";
    t.setGh(s);
    const r = t.dispatcher(["decide", id, "approve", "--reason", "ok"]);
    expect(r.err).toContain("OPEN 아님");
    expect(t.dispatcher(["check", id]).out).toContain("→ PR_CLOSED");
  });

  test("reason 이 비어 있으면 거부", () => {
    const { t, id } = verified();
    expect(t.dispatcher(["decide", id, "approve", "--reason", "  "]).code).not.toBe(0);
  });
});

describe("로컬 실행 (run)", () => {
  test("정상 완주 → 봇 PR → VERIFIED, summary 에 versions·비용", () => {
    const t = setup();
    // PR 이 생기기 전에 체크 응답을 미리 넣어 둔다 ($HEAD 는 PR head 로 치환됨)
    t.setGh(passing());
    const r = t.dispatcher(["run", join(t.root, ".dispatcher.toml")], { FAKE_CLAUDE_MODE: "success" });
    expect(r.out).toContain("최종 상태: VERIFIED");
    const id = r.out.match(/\[(j[\d-]+-[0-9a-f]{4})\]/)![1]!;
    const sum = JSON.parse(readFileSync(join(t.dir, "state/testapp/runs", id, "summary.json"), "utf8"));
    expect(sum.versions.claude).toContain("fake-claude");
    expect(t.events(id).some((e) => e.kind === "COST")).toBe(true);
  });

  test("#15 보호 경로 변경 → PR 생성 전 NEEDS_HUMAN", () => {
    const t = setup();
    const r = t.dispatcher(["run", join(t.root, ".dispatcher.toml")], { FAKE_CLAUDE_MODE: "protected" });
    expect(r.out).toContain("NEEDS_HUMAN");
    expect(t.gh().created ?? 0).toBe(0);
  });

  test("에이전트 실패·dirty → AGENT_FAILED", () => {
    for (const mode of ["error", "dirty"]) {
      const t = setup();
      expect(t.dispatcher(["run", join(t.root, ".dispatcher.toml")], { FAKE_CLAUDE_MODE: mode }).out).toContain("AGENT_FAILED");
    }
  });

  test("#16 기존 PR 존재 → 재사용, 중복 생성 없음, 승인 상태 유지", () => {
    const t = setup();
    const id = t.adoptedPr();
    t.setGh(passing());
    t.dispatcher(["check", id]);
    t.dispatcher(["decide", id, "approve", "--reason", "ok"]);
    expect(t.dispatcher(["open-pr", id]).out).toContain("기존 PR 재사용");
    expect(t.gh().created).toBe(1);
    expect(t.job(id).status).toBe("HUMAN_APPROVED");
  });

  test("#17 Claude 자식 환경: 봇·루틴 토큰, GH_TOKEN, API 키 제거 / env_allow 만 통과", () => {
    const t = setup();
    const dump = join(t.dir, "env.txt");
    t.dispatcher(["run-local", join(t.root, ".dispatcher.toml"), "--no-push"], {
      FAKE_CLAUDE_MODE: "envdump", FAKE_ENV_DUMP: dump,
      ROUTINE_TOKEN: "x", GH_TOKEN: "x", GITHUB_TOKEN: "x", ANTHROPIC_API_KEY: "x", BOT_GH_TOKEN_CMD: "echo x",
      ALLOWED_SECRET: "keep",
    });
    const names = readFileSync(dump, "utf8").split("\n");
    for (const n of ["BOT_GH_TOKEN", "BOT_GH_TOKEN_CMD", "ROUTINE_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "ANTHROPIC_API_KEY"]) expect(names).not.toContain(n);
    expect(names).toContain("ALLOWED_SECRET");
  });

  test("v0.4 중단(SIGINT) → INTERRUPTED + summary.json 생성", async () => {
    const t = setup();
    const p = t.spawn(["run", join(t.root, ".dispatcher.toml")], { FAKE_CLAUDE_MODE: "slow" });
    // 실행이 RUNNING 에 들어간 뒤(= SIGINT 처리기 등록 후)에 보낸다
    for (let i = 0; i < 100; i++) {
      await Bun.sleep(100);
      if (existsSync(join(t.dir, "state/testapp/ledger.db")) && t.db().query("SELECT 1 FROM jobs WHERE status='RUNNING'").get()) break;
    }
    await Bun.sleep(300);
    p.kill("SIGINT");
    await p.exited;
    const out = await new Response(p.stdout).text();
    expect(out).toContain("중단됨");
    const id = out.match(/\[(j[\d-]+-[0-9a-f]{4})\]/)![1]!;
    expect(t.job(id).status).toBe("INTERRUPTED");
    const sum = JSON.parse(readFileSync(join(t.dir, "state/testapp/runs", id, "summary.json"), "utf8"));
    expect(sum.interrupted).toBe(true);
  }, 20_000);
});

describe("Routine · 기타", () => {
  test("v0.4 routine-result: SUBMITTED 인 routine 작업만 ROUTINE_BLOCKED 로", () => {
    const t = setup();
    t.dispatcher(["status"]); // 장부 생성
    const db = t.db();
    db.query("INSERT INTO jobs(job_id,project,title,job_file,path,status,branch,created_at,updated_at) VALUES('j1','testapp','t','f','routine','SUBMITTED','claude/j1','x','x')").run();
    expect(t.dispatcher(["routine-result", "j1", "blocked", "--note", "flutter 없음"]).code).toBe(0);
    expect(t.job("j1").status).toBe("ROUTINE_BLOCKED");
    expect(t.dispatcher(["routine-result", "j1", "blocked", "--note", "again"]).code).not.toBe(0);
  });

  test("동시 진행 상한", () => {
    const t = setup();
    t.dispatcher(["status"]);
    const db = t.db();
    for (let i = 0; i < 5; i++)
      db.query(`INSERT INTO jobs(job_id,project,title,job_file,path,status,branch,created_at,updated_at) VALUES('p${i}','testapp','t','f','local','PR_OPEN','b','x','x')`).run();
    const r = t.dispatcher(["run", join(t.root, ".dispatcher.toml")]);
    expect(r.err).toContain("동시 진행 상한");
  });

  test("설정 파일이 없으면 종료", () => {
    const t = setup();
    require("node:fs").rmSync(join(t.root, ".dispatcher.toml"));
    expect(t.dispatcher(["status"]).err).toContain("설정 파일이 없습니다");
    expect(existsSync(join(t.root, ".dispatcher.toml"))).toBe(false);
  });
});
