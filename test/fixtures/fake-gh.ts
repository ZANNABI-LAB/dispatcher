#!/usr/bin/env bun
// 가짜 gh: FAKE_GH_STATE(JSON 파일)를 읽고 쓴다. 문자열 "$HEAD" 는 현재 PR head SHA 로 치환한다.
// state = { prs: [{url, branch, head, state}], checkRuns: [], workflowRuns: [], totalCount?: {check_runs?, workflow_runs?},
//           rc?: {api?: number, all?: number}, err?: string }
import { readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.FAKE_GH_STATE!;
const state = JSON.parse(readFileSync(statePath, "utf8"));
state.prs ??= [];
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const args = Bun.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const exit = (code: number, out = "", err = "") => {
  if (out) console.log(out);
  if (err) console.error(err);
  process.exit(code);
};

if (args[0] === "--version") exit(0, "gh version 0.0.0-fake");
if (!process.env.GH_TOKEN) exit(4, "", "no token");
if (state.rc?.all) exit(state.rc.all, "", state.err ?? "HTTP 401: Bad credentials");

const head = () => state.prs.at(-1)?.head as string | undefined;
const subst = (v: unknown) => JSON.parse(JSON.stringify(v).replaceAll("$HEAD", head() ?? ""));

if (args[0] === "pr" && args[1] === "list") {
  const branch = opt("--head");
  exit(0, JSON.stringify(state.prs.filter((p: any) => p.branch === branch && p.state === "OPEN").map((p: any) => ({ url: p.url }))));
}
if (args[0] === "pr" && args[1] === "create") {
  const branch = opt("--head")!;
  const ls = Bun.spawnSync(["git", "ls-remote", "origin", `refs/heads/${branch}`]).stdout.toString().trim();
  const sha = ls.split(/\s+/)[0];
  const url = `https://github.com/acme/app/pull/${state.prs.length + 1}`;
  state.prs.push({ url, branch, head: sha, state: "OPEN" });
  state.created = (state.created ?? 0) + 1;
  save();
  exit(0, `Creating pull request\n${url}`);
}
if (args[0] === "pr" && args[1] === "view") {
  const pr = state.prs.find((p: any) => p.url === args[2]);
  if (!pr) exit(1, "", "no pr");
  exit(0, JSON.stringify({ headRefOid: pr.head, state: pr.state }));
}
if (args[0] === "api") {
  if (state.rc?.api) exit(state.rc.api, "", state.err ?? "");
  const url = new URL("https://x/" + args[1]);
  const page = Number(url.searchParams.get("page") ?? 1);
  const per = Number(url.searchParams.get("per_page") ?? 30);
  const key = url.pathname.includes("check-runs") ? "check_runs" : "workflow_runs";
  const all = subst(key === "check_runs" ? state.checkRuns ?? [] : state.workflowRuns ?? []);
  const total = state.totalCount?.[key] ?? all.length;
  exit(0, JSON.stringify({ total_count: total, [key]: all.slice((page - 1) * per, page * per) }));
}
exit(1, "", `fake gh: unsupported ${args.join(" ")}`);
