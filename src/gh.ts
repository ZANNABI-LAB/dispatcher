import { type Config } from "./config";
import { sh, splitCommand } from "./util";

/** 인증·네트워크·조회 오류. 검증 실패와 구분한다. */
export class GhError extends Error {}

export function botToken(): string {
  const cmd = process.env.BOT_GH_TOKEN_CMD;
  if (cmd) {
    // 호출할 때마다 새 토큰 (GitHub App 설치 토큰 1시간 만료 대응)
    const r = sh(splitCommand(cmd));
    if (r.code !== 0 || !r.out) throw new GhError(`BOT_GH_TOKEN_CMD 실패: ${r.err.slice(0, 200)}`);
    return r.out;
  }
  const tok = process.env.BOT_GH_TOKEN;
  if (!tok) throw new GhError("BOT_GH_TOKEN 또는 BOT_GH_TOKEN_CMD 가 필요합니다. 내 계정 토큰으로 PR을 열면 내가 승인할 수 없습니다.");
  return tok;
}

export function gh(cfg: Config, args: string[]) {
  return sh([process.env.GH_BIN ?? "gh", ...args], { cwd: cfg.root, env: { ...process.env, GH_TOKEN: botToken() } });
}

export function ghOk(cfg: Config, args: string[]): string {
  const r = gh(cfg, args);
  if (r.code !== 0) throw new GhError(`gh ${args.slice(0, 3).join(" ")} 실패 (rc=${r.code}): ${r.err.slice(0, 300)}`);
  return r.out;
}

export function prHeadSha(cfg: Config, prUrl: string): { sha: string; state: string } {
  const d = JSON.parse(ghOk(cfg, ["pr", "view", prUrl, "--json", "headRefOid,state"]));
  return { sha: d.headRefOid, state: d.state };
}

/** 반환: items, complete(전체 조회 확정), pending(gh rc=8). */
export function ghPaginate(cfg: Config, endpoint: string, key: string, perPage = 100, maxPages = 20) {
  const items: any[] = [];
  let total: number | undefined;
  const sep = endpoint.includes("?") ? "&" : "?";
  for (let page = 1; page <= maxPages; page++) {
    const r = gh(cfg, ["api", `${endpoint}${sep}per_page=${perPage}&page=${page}`]);
    if (r.code === 8) return { items, complete: false, pending: true };
    if (r.code !== 0) throw new GhError(`${key} 조회 실패 (rc=${r.code}): ${r.err.slice(0, 300)}`);
    const data = JSON.parse(r.out || "{}");
    const batch: any[] = data[key] ?? [];
    total = data.total_count ?? total;
    items.push(...batch);
    if (batch.length < perPage) return { items, complete: total === undefined || items.length >= total, pending: false };
  }
  return { items, complete: false, pending: false }; // maxPages 초과
}
