import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type LineType = '+' | '-' | ' ';

export interface DiffLine {
  t: LineType;
  /** line number on the base branch (null for added lines) */
  o: number | null;
  /** line number on the head branch (null for removed lines) */
  n: number | null;
  /** line content */
  s: string;
  /** index into RepoData.commits, or null */
  c: number | null;
  noNewline?: boolean;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

export interface ChangedFile {
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T';
  oldPath: string | null;
  newPath: string | null;
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
  group: string;
  skipped: string | null;
  truncated: boolean;
  hunks: Hunk[];
}

export interface Commit {
  sha: string;
  short: string;
  author: string;
  /** unix seconds */
  time: number;
  summary: string;
  pr: number | null;
  /** which branch(es) contain the commit */
  on: 'head' | 'base' | 'both';
}

export interface RepoData {
  name: string;
  owner: string;
  fullName: string;
  url: string;
  description: string;
  grouping: 'workspace' | 'topdir';
  order: number;
  generatedAt: string;
  base: { branch: string; sha: string };
  head: { branch: string; sha: string };
  mergeBase: string;
  commitsOnlyOnBase: number;
  commitsOnlyOnHead: number;
  totals: { files: number; additions: number; deletions: number };
  maxDiffLines: number;
  commits: Commit[];
  files: ChangedFile[];
}

// Resolved from the project root: during the build this module is bundled
// into dist/, so import.meta.url cannot be used.
const dataDir = path.resolve(process.env.DATA_DIR || 'src/data');

let cache: RepoData[] | null = null;

/** Loads every src/data/*.json file written by scripts/collect.mjs. */
export function loadRepos(): RepoData[] {
  if (cache) return cache;
  const files = readdirSync(dataDir).filter((f) => f.endsWith('.json'));
  const repos = files.map((f) => JSON.parse(readFileSync(path.join(dataDir, f), 'utf8')) as RepoData);
  repos.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  cache = repos;
  return repos;
}

export interface FileGroup {
  name: string;
  files: ChangedFile[];
  additions: number;
  deletions: number;
}

export function groupFiles(repo: RepoData): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  for (const f of repo.files) {
    let g = groups.get(f.group);
    if (!g) {
      g = { name: f.group, files: [], additions: 0, deletions: 0 };
      groups.set(f.group, g);
    }
    g.files.push(f);
    g.additions += f.additions;
    g.deletions += f.deletions;
  }
  return [...groups.values()].sort((a, b) => {
    // root files first, then alphabetically
    if (a.name === '(root)') return -1;
    if (b.name === '(root)') return 1;
    return a.name.localeCompare(b.name);
  });
}

export interface PullRequestSummary {
  key: string;
  pr: number | null;
  commits: Commit[];
  url: string;
  title: string;
  on: Commit['on'];
  added: number;
  removed: number;
  files: Set<string>;
}

/** Aggregates the blamed commits of a repository per pull request. */
export function summarizePullRequests(repo: RepoData): PullRequestSummary[] {
  const byKey = new Map<string, PullRequestSummary>();
  const commitKey = (c: Commit) => (c.pr !== null ? `pr-${c.pr}` : `commit-${c.sha}`);
  for (const c of repo.commits) {
    const key = commitKey(c);
    let s = byKey.get(key);
    if (!s) {
      s = {
        key,
        pr: c.pr,
        commits: [],
        url: c.pr !== null ? `${repo.url}/pull/${c.pr}` : `${repo.url}/commit/${c.sha}`,
        title: c.pr !== null ? c.summary.replace(new RegExp(`\\s*\\(#${c.pr}\\)\\s*$`), '') : c.summary,
        on: c.on,
        added: 0,
        removed: 0,
        files: new Set(),
      };
      byKey.set(key, s);
    }
    s.commits.push(c);
  }
  for (const f of repo.files) {
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.c === null) continue;
        const s = byKey.get(commitKey(repo.commits[l.c]));
        if (!s) continue;
        if (l.t === '+') s.added++;
        else if (l.t === '-') s.removed++;
        s.files.add(f.path);
      }
    }
  }
  return [...byKey.values()].sort((a, b) => b.added + b.removed - (a.added + a.removed));
}

export function commitUrl(repo: RepoData, c: Commit): string {
  return c.pr !== null ? `${repo.url}/pull/${c.pr}` : `${repo.url}/commit/${c.sha}`;
}

export function commitLabel(c: Commit): string {
  return c.pr !== null ? `#${c.pr}` : c.short;
}

export function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export function fileUrl(repo: RepoData, f: ChangedFile): { head: string | null; base: string | null } {
  return {
    head: f.newPath ? `${repo.url}/blob/${repo.head.branch}/${f.newPath}` : null,
    base: f.oldPath ? `${repo.url}/blob/${repo.base.branch}/${f.oldPath}` : null,
  };
}

export const STATUS_LABEL: Record<ChangedFile['status'], string> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type changed',
};
