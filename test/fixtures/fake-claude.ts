#!/usr/bin/env bun
// 가짜 claude: FAKE_CLAUDE_MODE 에 따라 동작하고 stream-json result 이벤트를 출력한다.
//   success   lib/feature.txt 를 만들고 커밋
//   protected test/acceptance/a.txt 를 바꾸고 커밋
//   error     커밋 없이 is_error=true
//   dirty     커밋하지 않은 파일만 남김
//   slow      오래 대기 (중단 실험)
//   envdump   자식 환경 변수 이름을 FAKE_ENV_DUMP 파일에 기록하고 success
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";

const args = Bun.argv.slice(2);
if (args[0] === "--version") {
  console.log("fake-claude 0.0.0");
  process.exit(0);
}
const mode = process.env.FAKE_CLAUDE_MODE ?? "success";
const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { stdout: "ignore", stderr: "ignore" });
const result = (extra: object) =>
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 3, total_cost_usd: 0.12, result: "RESULT: success", ...extra }));

console.log(JSON.stringify({ type: "system", subtype: "init" }));
if (mode === "slow") {
  await Bun.sleep(60_000);
  process.exit(0);
}
if (mode === "envdump") writeFileSync(process.env.FAKE_ENV_DUMP!, Object.keys(process.env).sort().join("\n"));
if (mode === "success" || mode === "envdump") {
  mkdirSync("lib", { recursive: true });
  appendFileSync("lib/feature.txt", "feature\n");
  git("add", "-A");
  git("commit", "-qm", "feat");
  result({});
} else if (mode === "protected") {
  mkdirSync("test/acceptance", { recursive: true });
  appendFileSync("test/acceptance/a.txt", "weakened\n");
  git("add", "-A");
  git("commit", "-qm", "touch acceptance");
  result({});
} else if (mode === "error") {
  result({ is_error: true, subtype: "error_max_turns" });
} else if (mode === "dirty") {
  writeFileSync("uncommitted.txt", "x");
  result({});
}
