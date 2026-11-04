# dispatcher

> LLM 이 제안하고, 디스패처가 집행한다.

로컬 Claude Code(`claude -p`, 본인 구독)로 작업을 실행하고, 보호 경로를 검사하고, 봇 계정으로 PR 을 열고,
CI check-run 을 **출처·SHA 까지** 확인해 `VERIFIED` 를 기록한 뒤, 사람의 판단 직전에서 멈춘다. 자동 머지·배포는 없다.

- 계약(상태 기계·이벤트·장부·설정): [`docs/contracts.md`](docs/contracts.md)
- 기준 구현: ogan_maum `poc/dispatcher.py` v0.3.1 — 모의 검증 17개 사례를 `test/` 에서 회귀 테스트로 고정

## 설치
```bash
bun install
bun link            # 이후 어디서나 `dispatcher`
```

## 사용 (검증 대상 저장소의 깨끗한 base 체크아웃에서)
```bash
export BOT_GH_TOKEN_CMD="python3 ~/bin/app_token.py"   # 호출마다 새 GitHub App 설치 토큰 (~ 확장 지원)
dispatcher run jobs/<job>.md
dispatcher status
dispatcher decide <JOB_ID> approve --reason "왜 승인하는지 한 줄"
```
저장소 루트에 `.dispatcher.toml` 이 필요하다 (예시는 계약 문서 §6).
장부와 실행 기록은 저장소 밖 `~/.local/state/dispatcher/<project>/` 에 남는다 (`DISPATCHER_STATE_DIR` 로 변경).

## v0.4 (TypeScript/Bun 이전) 에서 바뀐 것
- 디스패처를 검증 대상 저장소 밖으로 분리, 프로젝트 설정은 `.dispatcher.toml`
- 중단(Ctrl+C) 시에도 `summary.json` 기록 · Routine 결과 반영 `routine-result` · 판단 지연(`latency_s`) 기록 · 비용 이벤트(`COST`)
- `BOT_GH_TOKEN_CMD` 의 `~` 확장 · Claude 자식 환경 비밀정보는 기본 제거, `agent.env_allow` 만 예외

## 개발
```bash
bun run test        # 가짜 claude·gh + 로컬 bare 원격으로 27개 사례
bun run typecheck
```
