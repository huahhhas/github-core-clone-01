// store.ts — the forge's in-memory state and domain operations.
// One viewer (the token owner), deterministic counters, no wall clock: every id, number and
// timestamp is a function of the request order, so a replay reaches the same bytes.

import {
  buildCommit,
  buildTree,
  collectReachable,
  commitTimestamp,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git.ts';

/** The login the trial's bearer token names (the contest's fixed scenario). */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export const DEFAULT_BRANCH = 'main';
/** A fixed timestamp string for created_at / merged_at fields (no wall clock is ever sent). */
export const FIXED_ISO = '2025-01-01T00:00:00Z';
/** The base epoch for server-built git objects; a counter keeps them distinct and deterministic. */
const COMMIT_EPOCH = 1700000000;

export interface RepoLabel {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  files: PullFile[];
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdOrder: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, RepoLabel>;
  issues: Issue[];
  pulls: Pull[];
  /** One shared sequence for issues and pull requests, as GitHub numbers them. */
  seq: number;
}

export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const fields = text.split(':');
    const kind = fields[0];
    if (kind === undefined || kind === '') return null;
    return { kind, parts: fields.slice(1) };
  } catch {
    return null;
  }
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private repoSeq = 0;
  private objectIdSeq = 0;
  private commentSeq = 0;
  private commitClock = 0;
  private createOrder = 0;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdOrder - b.createdOrder);
  }

  createRepo(name: string, isPrivate: boolean, description: string): { repo?: Repo; error?: string } {
    if (name === '' || name.includes('/')) return { error: 'invalid repository name' };
    if (this.getRepo(VIEWER.login, name) !== undefined) return { error: 'Repository already exists' };
    this.repoSeq += 1;
    this.createOrder += 1;
    const repo: Repo = {
      id: this.repoSeq,
      name,
      owner: VIEWER.login,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdOrder: this.createOrder,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      seq: 0,
    };
    this.repos.set(this.repoKey(VIEWER.login, name), repo);
    return { repo };
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  // -------------------------------------------------------------------------------------------
  // git objects and refs
  // -------------------------------------------------------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  objectOf(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  refOf(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** Refs sorted by name: branches first, then tags. */
  sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
    return [...repo.refs.entries()]
      .map(([name, oid]) => ({ name, oid }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  headTip(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  /** The commit a ref name, branch name or raw oid resolves to, or null. */
  resolveCommit(repo: Repo, ref: string): string | null {
    if (isObjectId(ref)) {
      const object = repo.objects.get(ref);
      if (object?.type === 'commit') return ref;
      if (object?.type === 'tag') {
        try {
          return parseTag(object.data).object;
        } catch {
          return null;
        }
      }
      return null;
    }
    const direct = repo.refs.get(ref);
    if (direct !== undefined) return this.derefToCommit(repo, direct);
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return this.derefToCommit(repo, branch);
    return null;
  }

  derefToCommit(repo: Repo, oid: string): string | null {
    const object = repo.objects.get(oid);
    if (object === undefined) return null;
    if (object.type === 'commit') return oid;
    if (object.type === 'tag') {
      try {
        const target = parseTag(object.data).object;
        return this.derefToCommit(repo, target);
      } catch {
        return null;
      }
    }
    return null;
  }

  /** A server-built commit on `parents` with `tree`; deterministic timestamp. */
  makeCommit(repo: Repo, tree: string, parents: string[], message: string): string {
    const timestamp = COMMIT_EPOCH + (this.commitClock += 1);
    const data = buildCommit({ tree, parents, message, timestamp });
    return this.putObject(repo, 'commit', data);
  }

  /** Commits reachable from `tip`, newest first by insertion order. */
  commitsFrom(repo: Repo, tip: string): Array<{ sha: string; message: string }> {
    const seen = new Set<string>();
    const queue: string[] = [tip];
    const found: string[] = [];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      found.push(oid);
      const parsed = parseCommit(object.data);
      for (const parent of parsed.parents) queue.push(parent);
    }
    // Insertion order is the creation order: later commits were stored later. The BFS above
    // visits children before parents, so `found` is already newest-first for linear histories.
    return found.map((sha) => {
      const object = repo.objects.get(sha)!;
      return { sha, message: parseCommit(object.data).message };
    });
  }

  // -------------------------------------------------------------------------------------------
  // trees
  // -------------------------------------------------------------------------------------------

  /** Every tree and blob oid inside a tree, including intermediate subtrees. */
  treeClosure(repo: Repo, treeOid: string | null): Set<string> {
    return treeClosureOf(repo, treeOid);
  }

  /** Flatten a tree to path -> entry, recursively. */
  flattenTree(repo: Repo, treeOid: string | null, prefix = ''): Map<string, TreeEntry> {
    const out = new Map<string, TreeEntry>();
    if (treeOid === null) return out;
    const object = repo.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        for (const [sub, subEntry] of this.flattenTree(repo, entry.oid, path)) out.set(sub, subEntry);
      } else {
        out.set(path, entry);
      }
    }
    return out;
  }

  /** The entry at `path` in the tree rooted at `treeOid`, or null. */
  treeEntryAt(repo: Repo, treeOid: string | null, path: string): { entry: TreeEntry; isDir: boolean } | null {
    if (treeOid === null) return null;
    const segments = path.split('/').filter((part) => part !== '');
    let current: string | null = treeOid;
    for (let index = 0; index < segments.length; index += 1) {
      if (current === null) return null;
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
      if (entry === undefined) return null;
      const last = index === segments.length - 1;
      if (last) return { entry, isDir: entry.mode === '40000' };
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  /** The tree object at `path` ('' for the root), or null when the path is not a tree. */
  treeAt(repo: Repo, treeOid: string | null, path: string): string | null {
    if (treeOid === null) return null;
    if (path === '' || path === '/') return treeOid;
    const found = this.treeEntryAt(repo, treeOid, path);
    if (found === null || !found.isDir) return null;
    return found.entry.oid;
  }

  /**
   * A new root tree with `path` set to `blobOid` (or removed when null). Intermediate trees are
   * rebuilt; a subtree left empty by a removal is pruned, as git does.
   */
  setPathInTree(repo: Repo, baseTreeOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((part) => part !== '');
    const build = (treeOid: string | null, depth: number): string | null => {
      const entries = new Map<string, TreeEntry>();
      if (treeOid !== null) {
        const object = repo.objects.get(treeOid);
        if (object !== undefined && object.type === 'tree') {
          for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
        }
      }
      const name = segments[depth]!;
      if (depth === segments.length - 1) {
        if (blobOid === null) entries.delete(name);
        else entries.set(name, { mode: '100644', name, oid: blobOid });
      } else {
        const child = entries.get(name);
        const childOid = child !== undefined && child.mode === '40000' ? child.oid : null;
        const next = build(childOid, depth + 1);
        if (next === null) entries.delete(name);
        else entries.set(name, { mode: '40000', name, oid: next });
      }
      if (entries.size === 0) return null;
      const data = buildTree([...entries.values()]);
      return this.putObject(repo, 'tree', data);
    };
    const result = build(baseTreeOid, 0);
    if (result === null) {
      // An empty root tree.
      return this.putObject(repo, 'tree', buildTree([]));
    }
    return result;
  }

  // -------------------------------------------------------------------------------------------
  // diffs, merge-base, mergeability
  // -------------------------------------------------------------------------------------------

  private lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
    const oldLines = oldData === null ? [] : oldData.toString('utf8').split('\n');
    const newLines = newData === null ? [] : newData.toString('utf8').split('\n');
    const oldCount = new Map<string, number>();
    for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
    let additions = 0;
    for (const line of newLines) {
      const left = oldCount.get(line) ?? 0;
      if (left > 0) oldCount.set(line, left - 1);
      else additions += 1;
    }
    let deletions = 0;
    for (const left of oldCount.values()) deletions += left;
    return { additions, deletions };
  }

  /** The file changes from `baseTree` to `headTree`. */
  diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): PullFile[] {
    const base = this.flattenTree(repo, baseTree);
    const head = this.flattenTree(repo, headTree);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const files: PullFile[] = [];
    for (const path of [...paths].sort()) {
      const from = base.get(path);
      const to = head.get(path);
      if (from !== undefined && to !== undefined && from.oid === to.oid) continue;
      const oldData = from === undefined ? null : (repo.objects.get(from.oid)?.data ?? null);
      const newData = to === undefined ? null : (repo.objects.get(to.oid)?.data ?? null);
      const { additions, deletions } = this.lineDiff(oldData, newData);
      files.push({
        filename: path,
        status: from === undefined ? 'added' : to === undefined ? 'removed' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
    return files;
  }

  /** The nearest common ancestor of two commits (linear-history exact). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const queueA: string[] = [a];
    while (queueA.length > 0) {
      const oid = queueA.shift()!;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueA.push(parent);
    }
    const seenB = new Set<string>();
    const queueB: string[] = [b];
    while (queueB.length > 0) {
      const oid = queueB.shift()!;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (ancestorsA.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueB.push(parent);
    }
    return null;
  }

  /** 'MERGEABLE' or 'CONFLICTING' for a pull request's current head and base tips. */
  mergeableOf(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
    const headTip = this.derefToCommit(repo, pull.headSha) ?? pull.headSha;
    const baseTip = this.derefToCommit(repo, pull.baseSha) ?? pull.baseSha;
    const headNow = this.refOf(repo, `refs/heads/${pull.headRef}`);
    const baseNow = this.refOf(repo, `refs/heads/${pull.baseRef}`);
    const head = headNow !== undefined ? this.derefToCommit(repo, headNow) ?? headNow : headTip;
    const base = baseNow !== undefined ? this.derefToCommit(repo, baseNow) ?? baseNow : baseTip;
    const mergeBase = this.mergeBase(repo, head, base);
    if (mergeBase === null) return 'MERGEABLE';
    const headObject = repo.objects.get(head);
    const baseObject = repo.objects.get(base);
    const baseMergeObject = repo.objects.get(mergeBase);
    if (headObject === undefined || baseObject === undefined || baseMergeObject === undefined) return 'MERGEABLE';
    const mergeTree = parseCommit(baseMergeObject.data).tree;
    const headTree = parseCommit(headObject.data).tree;
    const baseTree = parseCommit(baseObject.data).tree;
    const changedHead = this.diffTrees(repo, mergeTree, headTree);
    const changedBase = this.diffTrees(repo, mergeTree, baseTree);
    const headByPath = new Map(changedHead.map((file) => [file.filename, file]));
    for (const file of changedBase) {
      const other = headByPath.get(file.filename);
      if (other === undefined) continue;
      const headFlat = this.flattenTree(repo, headTree).get(file.filename);
      const baseFlat = this.flattenTree(repo, baseTree).get(file.filename);
      const headBlob = headFlat?.oid ?? null;
      const baseBlob = baseFlat?.oid ?? null;
      if (headBlob !== baseBlob) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  // -------------------------------------------------------------------------------------------
  // contents
  // -------------------------------------------------------------------------------------------

  /**
   * PUT /contents: create or update a file on a branch, committing it. Returns the commit and
   * blob shas, or an error status/message.
   */
  putContent(
    repo: Repo,
    path: string,
    content: Buffer,
    message: string,
    branch: string | undefined,
    sha: string | undefined,
  ): { commitSha: string; contentSha: string; created: boolean } | { error: number; message: string } {
    const branchName = branch ?? repo.defaultBranch;
    const currentRef = repo.refs.get(`refs/heads/${branchName}`);
    const defaultTip = this.headTip(repo);
    let baseCommit: string | null = null;
    let baseTree: string | null = null;
    let creatingBranch = false;
    if (currentRef !== undefined) {
      baseCommit = this.derefToCommit(repo, currentRef);
      if (baseCommit !== null) {
        const object = repo.objects.get(baseCommit);
        if (object !== undefined && object.type === 'commit') baseTree = parseCommit(object.data).tree;
      }
    } else if (defaultTip !== undefined) {
      // The branch does not exist yet: start it at the default branch tip.
      baseCommit = this.derefToCommit(repo, defaultTip);
      if (baseCommit !== null) {
        const object = repo.objects.get(baseCommit);
        if (object !== undefined && object.type === 'commit') baseTree = parseCommit(object.data).tree;
      }
      creatingBranch = true;
    }
    const existing = baseTree === null ? null : this.treeEntryAt(repo, baseTree, path);
    if (sha !== undefined) {
      if (existing === null || existing.isDir || existing.entry.oid !== sha) {
        return { error: 409, message: 'the blob sha does not match the current file' };
      }
    }
    const blobSha = this.putObject(repo, 'blob', content);
    const created = existing === null;
    const newTree = this.setPathInTree(repo, baseTree, path, blobSha);
    const parents = baseCommit === null ? [] : [baseCommit];
    const commitSha = this.makeCommit(repo, newTree, parents, message);
    repo.refs.set(`refs/heads/${branchName}`, commitSha);
    return { commitSha, contentSha: blobSha, created };
  }

  /**
   * DELETE /contents: remove a file on a branch, committing it.
   */
  deleteContent(
    repo: Repo,
    path: string,
    message: string,
    branch: string | undefined,
    sha: string | undefined,
  ): { commitSha: string } | { error: number; message: string } {
    const branchName = branch ?? repo.defaultBranch;
    const currentRef = repo.refs.get(`refs/heads/${branchName}`);
    if (currentRef === undefined) return { error: 404, message: 'Not Found' };
    const baseCommit = this.derefToCommit(repo, currentRef);
    if (baseCommit === null) return { error: 404, message: 'Not Found' };
    const object = repo.objects.get(baseCommit);
    if (object === undefined || object.type !== 'commit') return { error: 404, message: 'Not Found' };
    const baseTree = parseCommit(object.data).tree;
    const existing = this.treeEntryAt(repo, baseTree, path);
    if (existing === null || existing.isDir) return { error: 404, message: 'Not Found' };
    if (sha !== undefined && existing.entry.oid !== sha) {
      return { error: 409, message: 'the blob sha does not match the current file' };
    }
    const newTree = this.setPathInTree(repo, baseTree, path, null);
    const commitSha = this.makeCommit(repo, newTree, [baseCommit], message);
    repo.refs.set(`refs/heads/${branchName}`, commitSha);
    return { commitSha };
  }

  // -------------------------------------------------------------------------------------------
  // issues, comments, labels
  // -------------------------------------------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string): RepoLabel {
    const existing = repo.labels.get(name);
    if (existing !== undefined) return existing;
    const label: RepoLabel = { name, color, description: '' };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(
    repo: Repo,
    title: string,
    body: string,
    labels: string[],
  ): { issue?: Issue; error?: string } {
    if (title === '') return { error: 'title is required' };
    for (const name of labels) {
      if (!repo.labels.has(name)) return { error: `unknown label ${name}` };
    }
    repo.seq += 1;
    this.objectIdSeq += 1;
    const issue: Issue = {
      number: repo.seq,
      id: this.objectIdSeq,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
    };
    repo.issues.push(issue);
    return { issue };
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    this.commentSeq += 1;
    const comment: IssueComment = { id: this.commentSeq, body, user: VIEWER.login };
    issue.comments.push(comment);
    return comment;
  }

  // -------------------------------------------------------------------------------------------
  // pull requests
  // -------------------------------------------------------------------------------------------

  createPull(
    repo: Repo,
    title: string,
    body: string,
    head: string,
    base: string,
  ): { pull?: Pull; error?: string } {
    const headTip = repo.refs.get(`refs/heads/${head}`);
    const baseTip = repo.refs.get(`refs/heads/${base}`);
    if (headTip === undefined) return { error: `unknown head branch ${head}` };
    if (baseTip === undefined) return { error: `unknown base branch ${base}` };
    const open = repo.pulls.find((pull) => pull.headRef === head && pull.baseRef === base && pull.state === 'open');
    if (open !== undefined) return { error: 'a pull request from this branch is already open' };
    const headCommit = this.derefToCommit(repo, headTip);
    const baseCommit = this.derefToCommit(repo, baseTip);
    if (headCommit === null || baseCommit === null) return { error: 'branch tips are not commits' };
    const headTree = parseCommit(repo.objects.get(headCommit)!.data).tree;
    const baseTree = parseCommit(repo.objects.get(baseCommit)!.data).tree;
    repo.seq += 1;
    this.objectIdSeq += 1;
    const pull: Pull = {
      number: repo.seq,
      id: this.objectIdSeq,
      title,
      body,
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      headRef: head,
      baseRef: base,
      headSha: headTip,
      baseSha: baseTip,
      files: this.diffTrees(repo, baseTree, headTree),
    };
    repo.pulls.push(pull);
    return { pull };
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the merge sha, or an error kind
   * the handler maps to a status: 'not-found' | 'conflicted' | 'already-merged'.
   */
  mergePull(repo: Repo, pull: Pull): { sha?: string; error?: 'conflicted' | 'already-merged' } {
    if (pull.merged) return { error: 'already-merged' };
    if (pull.state !== 'open') return { error: 'already-merged' };
    if (this.mergeableOf(repo, pull) === 'CONFLICTING') return { error: 'conflicted' };
    const headTip = this.refOf(repo, `refs/heads/${pull.headRef}`);
    const baseTip = this.refOf(repo, `refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return { error: 'conflicted' };
    const headCommit = this.derefToCommit(repo, headTip);
    const baseCommit = this.derefToCommit(repo, baseTip);
    if (headCommit === null || baseCommit === null) return { error: 'conflicted' };
    const mergeBase = this.mergeBase(repo, headCommit, baseCommit);
    const headTree = parseCommit(repo.objects.get(headCommit)!.data).tree;
    const baseTree = parseCommit(repo.objects.get(baseCommit)!.data).tree;
    const mergeBaseTree = mergeBase === null ? null : parseCommit(repo.objects.get(mergeBase)!.data).tree;
    // Apply the head's changes (against the merge base) onto the base tree.
    let resultTree = baseTree;
    for (const file of this.diffTrees(repo, mergeBaseTree, headTree)) {
      const flat = this.flattenTree(repo, headTree).get(file.filename);
      resultTree = this.setPathInTree(repo, resultTree, file.filename, flat === undefined ? null : flat.oid);
    }
    const message = `${pull.title}\n`;
    const sha = this.makeCommit(repo, resultTree, [baseCommit], message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.merged = true;
    pull.state = 'closed';
    pull.merged_at = FIXED_ISO;
    pull.merge_commit_sha = sha;
    return { sha };
  }
}

/** Every tree and blob oid inside a tree, including intermediate subtrees. */
export function treeClosureOf(repo: Repo, treeOid: string | null): Set<string> {
  const out = new Set<string>();
  if (treeOid === null) return out;
  const queue: string[] = [treeOid];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (out.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    }
  }
  return out;
}

/** The objects a shallow boundary stops a traversal at: a commit's parents are not held. */
export function heldClosure(
  repo: Repo,
  haves: readonly string[],
  shallowBoundaries: ReadonlySet<string>,
): Set<string> {
  const held = new Set<string>();
  const queue: string[] = [...haves];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      for (const entry of treeClosureOf(repo, commit.tree)) held.add(entry);
      if (!shallowBoundaries.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    }
  }
  return held;
}

export interface FetchSelection {
  /** Objects to send, keyed by oid. */
  objects: Map<string, GitObject>;
  /** New shallow boundaries (commits at the depth edge). */
  shallow: string[];
  /** Old boundaries that are now inside the fetched range. */
  unshallow: string[];
}

/**
 * The fetch object selection: commits reachable from `wants` within `depth` generations
 * (depth 1 = the wants only), minus the held closure, with shallow bookkeeping.
 * `deepenSince` (a unix timestamp) replaces the depth rule: commits at or after it are sent.
 */
export function selectFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  oldShallow: readonly string[],
  depth: number | undefined,
  deepenSince: number | undefined,
  deepenNot: readonly string[],
): FetchSelection {
  const oldBoundaries = new Set(oldShallow);
  const extraHaves = deepenNot
    .map((ref) => repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`))
    .filter((oid): oid is string => oid !== undefined);
  const held = heldClosure(repo, [...haves, ...extraHaves], oldBoundaries);
  const toSend = new Map<string, GitObject>();
  const sendCommit = new Set<string>();
  const newShallow = new Set<string>();
  const maxDist = depth === undefined ? Number.POSITIVE_INFINITY : depth - 1;

  const visitCommit = (oid: string, dist: number): void => {
    const isHeld = held.has(oid);
    const isBoundary = oldBoundaries.has(oid);
    if (isHeld && !isBoundary) return;
    if (!isHeld) {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') return;
      toSend.set(oid, object);
      sendCommit.add(oid);
      const commit = parseCommit(object.data);
      for (const entryOid of treeClosureOf(repo, commit.tree)) {
        const entryObject = repo.objects.get(entryOid);
        if (entryObject !== undefined) toSend.set(entryOid, entryObject);
      }
    }
    if (dist >= maxDist) {
      if (deepenSince === undefined) newShallow.add(oid);
      return;
    }
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return;
    const commit = parseCommit(object.data);
    for (const parent of commit.parents) {
      if (deepenSince !== undefined) {
        const parentObject = repo.objects.get(parent);
        const ts = parentObject !== undefined && parentObject.type === 'commit' ? commitTimestamp(parentObject.data) : null;
        if (ts !== null && ts < deepenSince) {
          newShallow.add(parent);
          continue;
        }
      }
      visitCommit(parent, dist + 1);
    }
  };

  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      if (!held.has(want)) toSend.set(want, object);
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject !== undefined && targetObject.type === 'commit') visitCommit(target, 0);
      continue;
    }
    if (object.type === 'commit') {
      if (deepenSince !== undefined) {
        const ts = commitTimestamp(object.data);
        if (ts !== null && ts < deepenSince) {
          newShallow.add(want);
          continue;
        }
      }
      visitCommit(want, 0);
    }
  }

  // Drop anything the client already holds (shared trees/blobs included).
  for (const oid of [...toSend.keys()]) {
    if (held.has(oid)) toSend.delete(oid);
  }
  const unshallow = oldShallow.filter((oid) => sendCommit.has(oid) || toSend.has(oid));
  // A boundary the traversal passed through is unshallowed even when the boundary commit itself
  // was already held (the deepen case: the old boundary is a want).
  for (const oid of oldShallow) {
    if (!unshallow.includes(oid) && wants.includes(oid)) unshallow.push(oid);
  }
  return { objects: toSend, shallow: [...newShallow], unshallow };
}

export { ZERO_OID };
