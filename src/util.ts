import { homedir } from "node:os";

export const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");

export interface ShResult {
  code: number;
  out: string;
  err: string;
}

/** 동기 실행. 반환 코드를 직접 해석한다 (check 하지 않음). */
export function sh(cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; input?: string } = {}): ShResult {
  const p = Bun.spawnSync(cmd, {
    cwd: opts.cwd,
    env: opts.env as Record<string, string> | undefined,
    stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode ?? -1, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}

/**
 * 셸 없이 실행할 명령 문자열을 나눈다. 따옴표를 지원하고, 단어 맨 앞의 `~` 를 홈으로 펼친다.
 * (v0.3 에서 `python3 ~/bin/app_token.py` 가 `~` 미확장으로 실패하던 문제를 고친 것)
 */
export function splitCommand(cmd: string): string[] {
  const words: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) words.push(cur);
      cur = "";
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (quote) throw new Error(`따옴표가 닫히지 않음: ${cmd}`);
  if (started) words.push(cur);
  return words.map((w) => (w === "~" || w.startsWith("~/") ? homedir() + w.slice(1) : w));
}

function stamp(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function newJobId(prefix: "j" | "a" = "j") {
  return `${prefix}${stamp(new Date())}-${crypto.randomUUID().replace(/-/g, "").slice(0, 4)}`;
}

export class Exit extends Error {
  constructor(message: string, readonly code = 1) {
    super(message);
  }
}

/** Python 의 sys.exit(msg) 와 같은 역할: 메시지를 출력하고 종료한다. */
export function fail(message: string): never {
  throw new Exit(message);
}
