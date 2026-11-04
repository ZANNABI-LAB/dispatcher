# Dispatcher 계약 (언어 중립)

> 구현 언어가 바뀌어도 유지되는 경계. 상태·이벤트·설정·장부 스키마를 바꾸려면 이 문서를 먼저 바꾼다.
> 기준 구현: ogan_maum `poc/dispatcher.py` v0.3.1 (Python). TS 구현은 같은 동작을 회귀 테스트로 증명한다.

## 1. 원칙
- LLM 이 제안하고 디스패처가 집행한다. 장부는 디스패처만 쓴다 (single writer).
- `agent.finished != task.done`. 에이전트 종료·CI 통과·사람 판단은 서로 다른 상태다.
- 한 세션이 자기 결과를 채점하지 않는다. 판정 근거는 외부 증거(CI check-run, 보호 경로 diff)다.
- 디스패처는 검증 대상 저장소 **밖**에 설치된다. 저장소에는 설정(`.dispatcher.toml`)과 작업지시서만 있다.

## 2. 상태 기계

```
CREATED ─▶ RUNNING ─┬▶ AGENT_FAILED
                    ├▶ INTERRUPTED
                    ├▶ NEEDS_HUMAN            (보호 경로 변경)
                    └▶ AGENT_DONE ─▶ PUSHED ─▶ PR_OPEN ─┬▶ VERIFIED ─┬▶ HUMAN_APPROVED
                                     │                  │            └▶ REJECTED
                                     └▶ PUSH_FAILED     ├▶ VERIFY_FAILED
                                                        ├▶ VERIFY_INCOMPLETE
                                                        ├▶ VERIFY_TIMEOUT
                                                        ├▶ NEEDS_HUMAN    (protected-paths 실패)
                                                        ├▶ CHECK_ERROR    (조회 오류 3회 연속)
                                                        └▶ PR_CLOSED
PR_FAILED (PR 생성 단계 GitHub 오류)

Routine: CREATED ─▶ SUBMITTING ─┬▶ SUBMITTED ─▶ (push 후) PR_OPEN …
                                ├▶ SUBMIT_FAILED
                                └▶ SUBMIT_UNKNOWN ─(reconcile)▶ SUBMITTED | SUBMIT_FAILED
         SUBMITTED ─(routine-result)▶ ROUTINE_BLOCKED | ROUTINE_FAILED
adopt:   PUSHED (Claude 실행 없이 이미 push 된 브랜치 등록)
```

- 활성(동시 실행 상한에 포함): `RUNNING, SUBMITTING, SUBMITTED, SUBMIT_UNKNOWN, PR_OPEN`
- `decide approve` 는 `VERIFIED` 에서만, 그리고 직전에 PR OPEN · head SHA = 검증 SHA · 최신 필수 체크 PASS · 신뢰 출처 · 보호 경로 무변경을 다시 확인한다.

## 3. CI 판정 (`evaluateChecks(headSha)`)
- 필수 체크가 **모두 존재**, **head SHA 에 대응**, **신뢰 출처**(app slug = 설정값, check suite 가 같은 SHA 의 설정된 workflow path·event 실행에 속함), **모두 success** → `PASS`
- 신뢰 출처 안에서 같은 이름이 여러 번이면 id 가 가장 큰 run 기준. 출처가 다르면 이름·SHA 가 같아도 무시(`ignored_untrusted`)
- check-runs·workflow runs 는 페이지네이션 전부 조회. `total_count` 미충족 → `UNCERTAIN` (판정 보류)
- 누락·미완료 → `PENDING` / protected-paths 체크 failure → `PROTECTED_FAIL` / failure·timed_out·action_required·startup_failure → `FAIL` / 그 외(skipped·cancelled·neutral) → `INCOMPLETE`
- `gh` 종료 코드 8 → `PENDING`. 인증·네트워크 오류는 검증 실패가 아니라 `CHECK_ERROR` 이벤트

## 4. 이벤트
`events(job_id, ts, kind, payload JSON)` — `kind` 는 상태 이름 또는 아래 중 하나:
`RUN_CONTEXT`(base_sha, versions) · `CHECK_ERROR` · `HEAD_MOVED` · `GH_ERROR` · `COST`(usd, source)

## 5. 장부 스키마 (SQLite)
```sql
jobs(job_id PK, project, title, job_file, path, status, session_id, session_url, branch,
     pr_url, verify_sha, verify_evidence, created_at, updated_at, note)
events(id PK, job_id, ts, kind, payload)
decisions(id PK, job_id, ts, verdict, reason NOT NULL, sha, evidence, latency_s)
```
- `latency_s`: VERIFIED 기록 시각부터 사람 판단까지 걸린 초 (사람 주의 비용 측정)
- 위치: `$DISPATCHER_STATE_DIR` 또는 `~/.local/state/dispatcher/<project>/ledger.db`, 실행 기록은 같은 폴더의 `runs/<JOB_ID>/`

## 6. 프로젝트 설정 `.dispatcher.toml` (저장소 루트)
```toml
project = "ogan_maum"
base_branch = "main"

[protect]
prefixes = ["test/acceptance/", "poc/", ".github/", "docs/"]
files = ["analysis_options.yaml", "CODEOWNERS"]

[checks]
required = ["analyze-and-test", "protected-paths"]
protected_check = "protected-paths"
trusted_app_slug = "github-actions"
workflow_path = ".github/workflows/verify.yml"
event = "pull_request"

[agent]
max_turns = 40
allowed_tools = ["Read", "Edit", "Write", "Glob", "Grep", "Bash(flutter test:*)"]
done_commands = ["dart format --output=none --set-exit-if-changed lib test", "flutter analyze", "flutter test"]
env_allow = []          # Claude 자식 환경에 넘길 비밀정보 이름 (기본: 없음)

[budget]
max_jobs_per_day = 10
max_concurrent = 2
```

## 7. 작업 ID
- 로컬·Routine: `jYYYYMMDD-HHMMSS-xxxx`, adopt: `aYYYYMMDD-HHMMSS-xxxx`, 브랜치 `claude/<JOB_ID>`
