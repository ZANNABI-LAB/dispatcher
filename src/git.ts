import { type Config, isProtected } from "./config";
import { sh } from "./util";

export function git(cwd: string, ...args: string[]): string {
  const r = sh(["git", ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} 실패 (rc=${r.code}): ${r.err.slice(0, 300)}`);
  return r.out;
}

/** 실패해도 예외를 내지 않는다 (Python 의 check=False). */
export function gitSoft(cwd: string, ...args: string[]): string {
  return sh(["git", ...args], { cwd }).out;
}

export function hasCommit(cwd: string, sha: string): boolean {
  return sh(["git", "cat-file", "-e", `${sha}^{commit}`], { cwd }).code === 0;
}

/** 신뢰된 디스패처가 직접 계산하는 보호 경로 변경 목록 (브랜치 이름과 무관). */
export function protectedChanges(cfg: Config, head: string, base = cfg.baseBranch): string[] {
  const mb = gitSoft(cfg.root, "merge-base", base, head) || base;
  const files = gitSoft(cfg.root, "diff", "--name-only", `${mb}..${head}`).split("\n").filter(Boolean);
  return files.filter((f) => isProtected(cfg, f));
}

/** 보호 경로 검사. 커밋을 로컬에서 볼 수 없으면 null (= 판정 불가). */
export function trustedProtectedCheck(cfg: Config, branch: string, sha: string): string[] | null {
  if (!hasCommit(cfg.root, sha)) sh(["git", "fetch", "origin", branch], { cwd: cfg.root });
  if (!hasCommit(cfg.root, sha)) return null;
  return protectedChanges(cfg, sha);
}
