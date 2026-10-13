#!/usr/bin/env node
// Collects the differences between two branches of the RHDH repositories and
// writes one JSON file per repository into src/data/. The Astro site renders
// those files.
//
// For every changed line the script runs `git blame` and resolves the commit
// to the pull request that merged it (from the squash-merge commit subject,
// with the GitHub API as a fallback when GITHUB_TOKEN is set).
//
// The script is plain TypeScript that Node 22.18+ runs directly through its
// built-in type stripping (`node scripts/collect.ts`), so only erasable syntax
// is used: no enums, namespaces or parameter properties.
//
// Environment variables:
//   BASE_BRANCH   branch on the left side of the diff   (default: release-2.1)
//   HEAD_BRANCH   branch on the right side of the diff  (default: main)
//   REPOS_DIR     where the repositories are cloned     (default: .repos)
//   OUT_DIR       where the JSON files are written      (default: src/data)
//   GITHUB_TOKEN  optional, enables the commit -> PR API fallback
//   MAX_DIFF_LINES  max rendered diff lines per file    (default: 1500)

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import type {
  ChangedFile,
  Commit,
  CommitLocation,
  DiffLine,
  FileStatus,
  Grouping,
  Hunk,
  RepoData,
} from '../src/lib/types.ts';

const execFileAsync = promisify(execFile);

const BASE_BRANCH = process.env.BASE_BRANCH || 'release-2.1';
const HEAD_BRANCH = process.env.HEAD_BRANCH || 'main';
const REPOS_DIR = path.resolve(process.env.REPOS_DIR || '.repos');
const OUT_DIR = path.resolve(process.env.OUT_DIR || 'src/data');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const MAX_DIFF_LINES = Number(process.env.MAX_DIFF_LINES || 1500);
const BLAME_CONCURRENCY = 8;
const API_CONCURRENCY = 4;

interface RepoConfig {
  owner: string;
  name: string;
  description: string;
  grouping: Grouping;
}

/** Repositories to compare, in the order they appear on the site. */
const REPOS: RepoConfig[] = [
  {
    owner: 'redhat-developer',
    name: 'rhdh',
    description: 'Red Hat Developer Hub application',
    grouping: 'topdir',
  },
  {
    owner: 'redhat-developer',
    name: 'rhdh-plugins',
    description: 'Red Hat Developer Hub plugins',
    grouping: 'workspace',
  },
  {
    owner: 'redhat-developer',
    name: 'rhdh-plugin-export-overlays',
    description: 'Dynamic plugin export overlays',
    grouping: 'workspace',
  },
];

interface SkipPattern {
  test: (filePath: string) => boolean;
  reason: string;
}

/** Files whose diff body is not rendered (they are still listed with their stats). */
const SKIP_DIFF_PATTERNS: SkipPattern[] = [
  { test: (p) => /(^|\/)yarn\.lock$/.test(p), reason: 'lockfile' },
  { test: (p) => /(^|\/)package-lock\.json$/.test(p), reason: 'lockfile' },
  { test: (p) => /(^|\/)pnpm-lock\.yaml$/.test(p), reason: 'lockfile' },
  { test: (p) => /(^|\/)\.yarn\/(releases|plugins|cache)\//.test(p), reason: 'vendored yarn release' },
  { test: (p) => /\.min\.(js|css)$/.test(p), reason: 'minified file' },
];

// ---------------------------------------------------------------------------
// helpers

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['--literal-pathspecs', '-c', 'core.quotePath=false', ...args], {
    cwd,
    maxBuffer: 512 * 1024 * 1024,
    encoding: 'utf8',
  });
  return stdout;
}

async function pool<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function run(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function log(...args: unknown[]): void {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// cloning

async function ensureClone(repo: RepoConfig): Promise<string> {
  const url = `https://github.com/${repo.owner}/${repo.name}.git`;
  const dir = path.join(REPOS_DIR, repo.name);
  if (existsSync(path.join(dir, '.git'))) {
    log(`${repo.name}: fetching ${BASE_BRANCH} and ${HEAD_BRANCH}`);
    await git(dir, [
      'fetch', '--no-tags', '--force', 'origin',
      `${BASE_BRANCH}:refs/remotes/origin/${BASE_BRANCH}`,
      `${HEAD_BRANCH}:refs/remotes/origin/${HEAD_BRANCH}`,
    ]);
  } else {
    log(`${repo.name}: cloning ${url}`);
    await mkdir(REPOS_DIR, { recursive: true });
    // A full clone is needed: blame has to walk the history of every file.
    await git(REPOS_DIR, ['clone', '--quiet', '--no-tags', '--no-checkout', '--branch', HEAD_BRANCH, url, repo.name]);
    await git(dir, ['fetch', '--no-tags', 'origin', `${BASE_BRANCH}:refs/remotes/origin/${BASE_BRANCH}`]);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// diff listing and parsing

interface FileStats {
  binary: boolean;
  additions: number;
  deletions: number;
}

/** Lists the changed files with their status and numstat. */
async function listChangedFiles(dir: string, base: string, head: string): Promise<ChangedFile[]> {
  const nameStatus = await git(dir, ['diff', '--name-status', '-M', '-z', base, head]);
  const numstat = await git(dir, ['diff', '--numstat', '-M', '-z', base, head]);

  const files: ChangedFile[] = [];
  const ns = nameStatus.split('\0');
  for (let i = 0; i < ns.length; ) {
    const status = ns[i];
    if (!status) break;
    const kind = status[0] as FileStatus;
    let oldPath: string | null;
    let newPath: string | null;
    if (kind === 'R' || kind === 'C') {
      oldPath = ns[i + 1];
      newPath = ns[i + 2];
      i += 3;
    } else {
      const p = ns[i + 1];
      oldPath = kind === 'A' ? null : p;
      newPath = kind === 'D' ? null : p;
      i += 2;
    }
    files.push({
      status: kind,
      oldPath,
      newPath,
      path: newPath ?? oldPath ?? '',
      additions: 0,
      deletions: 0,
      binary: false,
      group: '',
      skipped: null,
      truncated: false,
      hunks: [],
    });
  }

  // numstat -z: "add\tdel\tpath\0" or for renames "add\tdel\t\0old\0new\0"
  const stats = new Map<string, FileStats>();
  const parts = numstat.split('\0');
  for (let i = 0; i < parts.length; ) {
    const rec = parts[i];
    if (!rec) break;
    const [add, del, p] = rec.split('\t');
    let key = p;
    if (p === '' || p === undefined) {
      key = parts[i + 2];
      i += 3;
    } else {
      i += 1;
    }
    stats.set(key, {
      binary: add === '-' || del === '-',
      additions: add === '-' ? 0 : Number(add),
      deletions: del === '-' ? 0 : Number(del),
    });
  }

  for (const f of files) {
    const s = stats.get(f.path);
    if (s) Object.assign(f, s);
  }
  return files;
}

interface ParsedDiff {
  hunks: Hunk[];
  binary: boolean;
  diffLines: number;
}

/** Parses the unified diff of a single file into hunks. */
function parseUnifiedDiff(text: string): ParsedDiff {
  const lines = text.split('\n');
  const hunks: Hunk[] = [];
  let hunk: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let binary = false;
  let diffLines = 0;

  for (const raw of lines) {
    if (!hunk) {
      if (/^Binary files .* differ$/.test(raw) || /^GIT binary patch/.test(raw)) binary = true;
    }
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(raw);
    if (m) {
      hunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        header: m[5].trim(),
        lines: [],
      };
      hunks.push(hunk);
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      continue;
    }
    if (!hunk) continue;
    const t = raw[0];
    const content = raw.slice(1);
    if (t === '\\') {
      // "\ No newline at end of file"
      const prev = hunk.lines[hunk.lines.length - 1];
      if (prev) prev.noNewline = true;
      continue;
    }
    if (t === '+') {
      hunk.lines.push({ t: '+', o: null, n: newLine++, s: content, c: null });
    } else if (t === '-') {
      hunk.lines.push({ t: '-', o: oldLine++, n: null, s: content, c: null });
    } else if (t === ' ') {
      hunk.lines.push({ t: ' ', o: oldLine++, n: newLine++, s: content, c: null });
    } else {
      // Empty trailing line from the split, or anything else outside -U3 output.
      continue;
    }
    diffLines++;
  }
  return { hunks, binary, diffLines };
}

/** Caps the rendered diff of a file. Returns true when truncated. */
function truncateHunks(hunks: Hunk[], max: number): boolean {
  let count = 0;
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i];
    if (count + h.lines.length <= max) {
      count += h.lines.length;
      continue;
    }
    const keep = Math.max(0, max - count);
    h.lines = h.lines.slice(0, keep);
    hunks.length = keep > 0 ? i + 1 : i;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// blame

type LineRange = [start: number, end: number];

interface BlameInfo {
  author: string;
  time: number;
  summary: string;
}

interface BlameResult {
  lineToSha: Map<number, string>;
  commits: Map<string, BlameInfo>;
}

/** Merges hunk ranges into non-overlapping, ascending -L arguments. */
function rangesToArgs(ranges: LineRange[]): string[] {
  const sorted = ranges.filter(([s, e]) => e >= s).sort((a, b) => a[0] - b[0]);
  const merged: LineRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged.flatMap(([s, e]) => ['-L', `${s},${e}`]);
}

/** Runs `git blame --porcelain` for the given line ranges. */
async function blame(dir: string, rev: string, filePath: string, ranges: LineRange[]): Promise<BlameResult> {
  const args = rangesToArgs(ranges);
  if (args.length === 0) return { lineToSha: new Map(), commits: new Map() };
  let out: string;
  try {
    out = await git(dir, ['blame', '--porcelain', ...args, rev, '--', filePath]);
  } catch (err) {
    log(`blame failed for ${filePath}@${rev}: ${errorMessage(err).split('\n')[0]}`);
    return { lineToSha: new Map(), commits: new Map() };
  }
  const lineToSha = new Map<number, string>();
  const commits = new Map<string, BlameInfo>();
  let current: string | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('\t')) {
      current = null;
      continue;
    }
    const hm = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/.exec(line);
    if (hm) {
      current = hm[1];
      lineToSha.set(Number(hm[3]), current);
      if (!commits.has(current)) commits.set(current, { author: '', time: 0, summary: '' });
      continue;
    }
    if (!current) continue;
    const c = commits.get(current);
    if (!c) continue;
    if (line.startsWith('author ')) c.author = line.slice(7);
    else if (line.startsWith('author-time ')) c.time = Number(line.slice(12));
    else if (line.startsWith('summary ')) c.summary = line.slice(8);
  }
  return { lineToSha, commits };
}

// ---------------------------------------------------------------------------
// commit -> pull request

function prFromSummary(summary: string): number | null {
  let m = /\(#(\d+)\)\s*$/.exec(summary);
  if (m) return Number(m[1]);
  m = /^Merge pull request #(\d+)\b/.exec(summary);
  if (m) return Number(m[1]);
  return null;
}

interface PullRef {
  number: number;
  merged_at: string | null;
}

let apiDisabled = false;

async function prFromApi(repo: RepoConfig, sha: string): Promise<number | null> {
  if (apiDisabled) return null;
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${sha}/pulls`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'rhdh-compare-branches',
    },
  });
  if (!res.ok) {
    const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 120);
    log(`GitHub API ${res.status} for ${sha.slice(0, 7)}: ${body}`);
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      log('GitHub API lookups disabled for the rest of this run');
      apiDisabled = true;
    }
    return null;
  }
  const pulls = (await res.json()) as PullRef[];
  const merged = pulls.find((p) => p.merged_at) ?? pulls[0];
  return merged ? Number(merged.number) : null;
}

// ---------------------------------------------------------------------------
// grouping

function groupFor(repo: RepoConfig, filePath: string): string {
  if (repo.grouping === 'workspace') {
    const m = /^workspaces\/([^/]+)\//.exec(filePath);
    return m ? m[1] : '(root)';
  }
  const idx = filePath.indexOf('/');
  return idx === -1 ? '(root)' : filePath.slice(0, idx);
}

// ---------------------------------------------------------------------------
// main

async function collectRepo(repo: RepoConfig): Promise<void> {
  const dir = await ensureClone(repo);
  const base = `origin/${BASE_BRANCH}`;
  const head = `origin/${HEAD_BRANCH}`;
  const baseSha = (await git(dir, ['rev-parse', base])).trim();
  const headSha = (await git(dir, ['rev-parse', head])).trim();
  const mergeBase = (await git(dir, ['merge-base', base, head])).trim();
  const aheadBehind = (await git(dir, ['rev-list', '--left-right', '--count', `${base}...${head}`])).trim().split('\t');

  log(`${repo.name}: ${BASE_BRANCH}@${baseSha.slice(0, 7)} vs ${HEAD_BRANCH}@${headSha.slice(0, 7)}`);

  const files = await listChangedFiles(dir, base, head);
  log(`${repo.name}: ${files.length} changed files`);

  const commitIndex = new Map<string, number>(); // sha -> index into commits[]
  const commits: Commit[] = [];
  function commitId(sha: string, info: BlameInfo | undefined): number {
    let idx = commitIndex.get(sha);
    if (idx === undefined) {
      idx = commits.length;
      commitIndex.set(sha, idx);
      commits.push({
        sha,
        short: sha.slice(0, 7),
        author: info?.author ?? '',
        time: info?.time ?? 0,
        summary: info?.summary ?? '',
        pr: null,
        on: 'both',
      });
    }
    return idx;
  }

  await pool(files, BLAME_CONCURRENCY, async (f) => {
    f.group = groupFor(repo, f.path);

    const skip = SKIP_DIFF_PATTERNS.find((s) => s.test(f.path));
    if (skip) {
      f.skipped = skip.reason;
      return;
    }
    if (f.binary) {
      f.skipped = 'binary file';
      return;
    }

    const pathspec = [...new Set([f.oldPath, f.newPath].filter((p): p is string => p !== null))];
    const patch = await git(dir, ['diff', '-M', '-U3', '--no-color', '--no-ext-diff', base, head, '--', ...pathspec]);
    const parsed = parseUnifiedDiff(patch);
    if (parsed.binary) {
      f.skipped = 'binary file';
      f.binary = true;
      return;
    }
    f.hunks = parsed.hunks;
    f.truncated = truncateHunks(f.hunks, MAX_DIFF_LINES);

    const newRanges: LineRange[] = f.hunks.filter((h) => h.newLines > 0).map((h) => [h.newStart, h.newStart + h.newLines - 1]);
    const oldRanges: LineRange[] = f.hunks.filter((h) => h.oldLines > 0).map((h) => [h.oldStart, h.oldStart + h.oldLines - 1]);

    const [newBlame, oldBlame] = await Promise.all([
      f.newPath ? blame(dir, head, f.newPath, newRanges) : null,
      f.oldPath ? blame(dir, base, f.oldPath, oldRanges) : null,
    ]);

    for (const h of f.hunks) {
      for (const l of h.lines) {
        attachCommit(l, newBlame, oldBlame, commitId);
      }
    }
  });

  // Resolve pull requests.
  for (const c of commits) c.pr = prFromSummary(c.summary);
  const unresolved = commits.filter((c) => c.pr === null);
  if (unresolved.length && GITHUB_TOKEN) {
    log(`${repo.name}: resolving ${unresolved.length} commits through the GitHub API`);
    await pool(unresolved, API_CONCURRENCY, async (c) => {
      c.pr = await prFromApi(repo, c.sha);
    });
  } else if (unresolved.length) {
    log(`${repo.name}: ${unresolved.length} commits without a PR number (set GITHUB_TOKEN to resolve them)`);
  }

  // Mark on which branch each blamed commit lives.
  const headOnly = new Set((await git(dir, ['rev-list', `${base}..${head}`])).split('\n').filter(Boolean));
  const baseOnly = new Set((await git(dir, ['rev-list', `${head}..${base}`])).split('\n').filter(Boolean));
  for (const c of commits) {
    const on: CommitLocation = headOnly.has(c.sha) ? 'head' : baseOnly.has(c.sha) ? 'base' : 'both';
    c.on = on;
  }

  const totals = files.reduce(
    (acc, f) => ({ files: acc.files + 1, additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
    { files: 0, additions: 0, deletions: 0 },
  );

  // Sort files by group then path so the site renders deterministically.
  files.sort((a, b) => (a.group === b.group ? a.path.localeCompare(b.path) : a.group.localeCompare(b.group)));

  // The commit indices were assigned in the order the concurrent blame calls
  // finished. Re-number them by commit date and SHA so the output is stable.
  const order = commits.map((c, i) => i).sort((a, b) => commits[a].time - commits[b].time || commits[a].sha.localeCompare(commits[b].sha));
  const remap = new Map(order.map((oldIndex, newIndex) => [oldIndex, newIndex]));
  const sortedCommits = order.map((i) => commits[i]);
  for (const f of files) {
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.c !== null) l.c = remap.get(l.c) ?? null;
      }
    }
  }

  const data: RepoData = {
    name: repo.name,
    owner: repo.owner,
    fullName: `${repo.owner}/${repo.name}`,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    grouping: repo.grouping,
    order: REPOS.indexOf(repo),
    generatedAt: new Date().toISOString(),
    base: { branch: BASE_BRANCH, sha: baseSha },
    head: { branch: HEAD_BRANCH, sha: headSha },
    mergeBase,
    commitsOnlyOnBase: Number(aheadBehind[0]),
    commitsOnlyOnHead: Number(aheadBehind[1]),
    totals,
    maxDiffLines: MAX_DIFF_LINES,
    commits: sortedCommits,
    files,
  };

  await mkdir(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `${repo.name}.json`);
  await writeFile(out, JSON.stringify(data));
  log(`${repo.name}: wrote ${out} (${sortedCommits.length} commits, ${unresolved.filter((c) => c.pr === null).length} without PR)`);
}

/** Attaches the blamed commit of a changed line: added lines from the head side, removed lines from the base side. */
function attachCommit(
  line: DiffLine,
  newBlame: BlameResult | null,
  oldBlame: BlameResult | null,
  commitId: (sha: string, info: BlameInfo | undefined) => number,
): void {
  line.c = null;
  if (line.t === '+' && newBlame && line.n !== null) {
    const sha = newBlame.lineToSha.get(line.n);
    if (sha) line.c = commitId(sha, newBlame.commits.get(sha));
  } else if (line.t === '-' && oldBlame && line.o !== null) {
    const sha = oldBlame.lineToSha.get(line.o);
    if (sha) line.c = commitId(sha, oldBlame.commits.get(sha));
  }
}

const only = process.argv.slice(2);
const selected = only.length ? REPOS.filter((r) => only.includes(r.name)) : REPOS;
if (selected.length === 0) {
  console.error(`Unknown repository. Known: ${REPOS.map((r) => r.name).join(', ')}`);
  process.exit(1);
}
for (const repo of selected) {
  await collectRepo(repo);
}
