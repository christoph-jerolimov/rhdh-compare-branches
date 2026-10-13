// Shared data model between scripts/collect.ts (writer) and the Astro site (reader).

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

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T';

export interface ChangedFile {
  status: FileStatus;
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

export type CommitLocation = 'head' | 'base' | 'both';

export interface Commit {
  sha: string;
  short: string;
  author: string;
  /** unix seconds */
  time: number;
  summary: string;
  pr: number | null;
  /** which branch(es) contain the commit */
  on: CommitLocation;
}

export type Grouping = 'workspace' | 'topdir';

export interface BranchRef {
  branch: string;
  sha: string;
}

export interface RepoData {
  name: string;
  owner: string;
  fullName: string;
  url: string;
  description: string;
  grouping: Grouping;
  order: number;
  generatedAt: string;
  base: BranchRef;
  head: BranchRef;
  mergeBase: string;
  commitsOnlyOnBase: number;
  commitsOnlyOnHead: number;
  totals: { files: number; additions: number; deletions: number };
  maxDiffLines: number;
  commits: Commit[];
  files: ChangedFile[];
}
