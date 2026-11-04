import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fail, now } from "./util";

export const ACTIVE = ["RUNNING", "SUBMITTING", "SUBMITTED", "SUBMIT_UNKNOWN", "PR_OPEN"];

export interface Job {
  job_id: string;
  project: string;
  title: string;
  job_file: string;
  path: string;
  status: string;
  session_id: string | null;
  session_url: string | null;
  branch: string;
  pr_url: string | null;
  verify_sha: string | null;
  verify_evidence: string | null;
  created_at: string;
  updated_at: string;
  note: string | null;
}

export function stateDir(project: string): string {
  const base = process.env.DISPATCHER_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "dispatcher");
  const dir = join(base, project);
  mkdirSync(join(dir, "runs"), { recursive: true });
  return dir;
}

const JOB_FIELDS = new Set(["session_id", "session_url", "pr_url", "verify_sha", "verify_evidence", "note", "branch"]);

export class Ledger {
  readonly db: Database;
  readonly runsDir: string;

  constructor(readonly project: string) {
    const dir = stateDir(project);
    this.runsDir = join(dir, "runs");
    this.db = new Database(join(dir, "ledger.db"), { create: true });
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs(
        job_id TEXT PRIMARY KEY, project TEXT, title TEXT, job_file TEXT, path TEXT,
        status TEXT NOT NULL, session_id TEXT, session_url TEXT, branch TEXT,
        pr_url TEXT, verify_sha TEXT, verify_evidence TEXT, created_at TEXT, updated_at TEXT, note TEXT);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, job_id TEXT, ts TEXT, kind TEXT, payload TEXT);
      CREATE TABLE IF NOT EXISTS decisions(
        id INTEGER PRIMARY KEY, job_id TEXT, ts TEXT, verdict TEXT, reason TEXT NOT NULL,
        sha TEXT, evidence TEXT, latency_s INTEGER);
    `);
  }

  insertJob(j: Pick<Job, "job_id" | "title" | "job_file" | "path" | "status" | "branch">) {
    const t = now();
    this.db
      .query("INSERT INTO jobs(job_id,project,title,job_file,path,status,branch,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(j.job_id, this.project, j.title, j.job_file, j.path, j.status, j.branch, t, t);
  }

  get(jobId: string): Job {
    const row = this.db.query("SELECT * FROM jobs WHERE job_id=?").get(jobId) as Job | null;
    if (!row) fail(`없는 JOB_ID: ${jobId}`);
    return row;
  }

  /** 상태 변경과 이벤트를 한 트랜잭션으로. */
  setStatus(jobId: string, status: string, fields: Record<string, string | null> = {}) {
    for (const k of Object.keys(fields)) if (!JOB_FIELDS.has(k)) throw new Error(`알 수 없는 필드: ${k}`);
    const cols = Object.keys(fields).map((k) => `, ${k}=?`).join("");
    this.db.transaction(() => {
      this.db.query(`UPDATE jobs SET status=?, updated_at=?${cols} WHERE job_id=?`).run(status, now(), ...Object.values(fields), jobId);
      this.db.query("INSERT INTO events(job_id, ts, kind, payload) VALUES(?,?,?,?)").run(jobId, now(), status, JSON.stringify(fields));
    })();
  }

  logEvent(jobId: string, kind: string, payload: unknown) {
    this.db.query("INSERT INTO events(job_id, ts, kind, payload) VALUES(?,?,?,?)").run(jobId, now(), kind, JSON.stringify(payload));
  }

  events(jobId: string): { ts: string; kind: string; payload: string }[] {
    return this.db.query("SELECT ts, kind, payload FROM events WHERE job_id=? ORDER BY id").all(jobId) as any;
  }

  /** 마지막으로 VERIFIED 가 기록된 시각 (사람 판단 지연 측정용). */
  verifiedAt(jobId: string): string | null {
    const r = this.db.query("SELECT ts FROM events WHERE job_id=? AND kind='VERIFIED' ORDER BY id DESC LIMIT 1").get(jobId) as { ts: string } | null;
    return r?.ts ?? null;
  }

  countToday(): number {
    const today = new Date().toISOString().slice(0, 10);
    return (this.db.query("SELECT COUNT(*) AS n FROM jobs WHERE substr(created_at,1,10)=?").get(today) as { n: number }).n;
  }

  countActive(): number {
    const q = `SELECT COUNT(*) AS n FROM jobs WHERE status IN (${ACTIVE.map(() => "?").join(",")})`;
    return (this.db.query(q).get(...ACTIVE) as { n: number }).n;
  }

  recordDecision(d: { job_id: string; verdict: string; reason: string; sha: string | null; evidence: unknown; latency_s: number | null }) {
    this.db
      .query("INSERT INTO decisions(job_id, ts, verdict, reason, sha, evidence, latency_s) VALUES(?,?,?,?,?,?,?)")
      .run(d.job_id, now(), d.verdict, d.reason, d.sha, JSON.stringify(d.evidence), d.latency_s);
  }

  recent(limit = 30): Job[] {
    return this.db.query("SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit) as Job[];
  }

  decisionCounts(): { verdict: string; n: number }[] {
    return this.db.query("SELECT verdict, COUNT(*) AS n FROM decisions GROUP BY verdict").all() as any;
  }
}
