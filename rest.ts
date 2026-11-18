// rest.ts — GitHub REST v3: repositories, branches, commits, contents, labels, issues,
// comments and pull requests. Every reply is JSON and carries X-GitHub-Request-Id (app.ts).

import { parseCommit, parseTree } from './git.ts';
import {
  FIXED_ISO,
  globalId,
  VIEWER,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { emptyResult, errJson, jsonResult, type HandlerResult, type ReqCtx } from './http.ts';

// ---------------------------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('repo', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, node_id: globalId('user', VIEWER.id), type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headUser = { login: VIEWER.login, id: VIEWER.id, type: 'User' };
  return {
    id: pull.id,
    node_id: globalId('pr', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${VIEWER.login}:${pull.headRef}`, user: headUser },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${VIEWER.login}:${pull.baseRef}`, user: headUser },
    user: headUser,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bodyObject(ctx: ReqCtx): Record<string, unknown> | null {
  if (ctx.jsonError) return null;
  if (ctx.json === undefined) return {};
  return isRecord(ctx.json) ? ctx.json : null;
}

function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

function intParam(ctx: ReqCtx, name: string, fallback: number): number {
  const raw = ctx.query.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

/** A page of `items`, plus the Link header value for the next page when there is one. */
function paginate<T>(ctx: ReqCtx, path: string, items: readonly T[]): { page: T[]; link: string | null } {
  const perPage = Math.min(100, Math.max(1, intParam(ctx, 'per_page', 30)));
  const page = Math.max(1, intParam(ctx, 'page', 1));
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const base = `http://${ctx.host}${path}`;
  const query = (p: number): string => {
    const params = new URLSearchParams(ctx.query);
    params.set('per_page', String(perPage));
    params.set('page', String(p));
    return `${base}?${params.toString()}`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`<${query(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${query(page - 1)}>; rel="prev"`);
  if (totalPages > 1) {
    links.push(`<${query(1)}>; rel="first"`);
    links.push(`<${query(totalPages)}>; rel="last"`);
  }
  return { page: [...slice], link: links.length > 0 ? links.join(', ') : null };
}

function pagedJson<T>(ctx: ReqCtx, path: string, items: readonly T[]): HandlerResult {
  const { page, link } = paginate(ctx, path, items);
  return jsonResult(200, page, link === null ? {} : { link });
}

function requireRepo(ctx: ReqCtx, owner: string, name: string): Repo | HandlerResult {
  if (owner !== VIEWER.login) return errJson(404, 'Not Found');
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) return errJson(404, 'Not Found');
  return repo;
}

function isError(value: Repo | HandlerResult): value is HandlerResult {
  return !('objects' in value);
}

// ---------------------------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------------------------

/** Handle a /api/v3 request. Returns null when the path is not a REST route. */
export function handleRest(ctx: ReqCtx): HandlerResult | null {
  const segments = ctx.segments;
  if (segments[0] !== 'api' || segments[1] !== 'v3') return null;
  const rest = segments.slice(2);
  const method = ctx.method;

  // The API root.
  if (rest.length === 0) {
    if (method !== 'GET') return errJson(404, 'Not Found');
    return jsonResult(
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') return errJson(404, 'Not Found');
    return jsonResult(200, { installed_version: '1.0.0' });
  }

  if (rest[0] === 'user' && rest.length === 1) {
    if (method !== 'GET') return errJson(404, 'Not Found');
    return jsonResult(200, {
      login: VIEWER.login,
      id: VIEWER.id,
      node_id: globalId('user', VIEWER.id),
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
    });
  }

  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      return pagedJson(ctx, '/api/v3/user/repos', ctx.store.listRepos().map(repoJson));
    }
    if (method === 'POST') {
      const body = bodyObject(ctx);
      if (body === null) return errJson(400, 'malformed JSON body');
      const name = stringField(body, 'name');
      if (name === '') return errJson(422, 'name is required');
      const created = ctx.store.createRepo(name, body.private === true, stringField(body, 'description'));
      if (created.error !== undefined) return errJson(422, created.error);
      return jsonResult(201, repoJson(created.repo!));
    }
    return errJson(404, 'Not Found');
  }

  if (rest[0] === 'repos' && rest.length >= 3) {
    return handleRepoRoute(ctx, rest[1]!, rest[2]!, rest.slice(3));
  }

  return errJson(404, 'Not Found');
}

function handleRepoRoute(ctx: ReqCtx, owner: string, name: string, tail: string[]): HandlerResult {
  const method = ctx.method;
  const repoOrError = requireRepo(ctx, owner, name);
  if (isError(repoOrError)) return repoOrError;
  const repo = repoOrError;
  const store: Store = ctx.store;

  // /repos/{o}/{r}
  if (tail.length === 0) {
    if (method === 'GET') return jsonResult(200, repoJson(repo));
    if (method === 'PATCH') {
      const body = bodyObject(ctx);
      if (body === null) return errJson(400, 'malformed JSON body');
      if (typeof body.description === 'string') repo.description = body.description;
      return jsonResult(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, name);
      return emptyResult(204, { 'content-type': 'application/json; charset=utf-8' });
    }
    return errJson(404, 'Not Found');
  }

  const head = tail[0]!;

  // Branches.
  if (head === 'branches') {
    if (method === 'GET' && tail.length === 1) {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => ({
          name: branch,
          commit: { sha: repo.refs.get(`refs/heads/${branch}`)! },
          protected: false,
        }));
      return jsonResult(200, branches);
    }
    if (method === 'GET' && tail.length >= 2) {
      const branch = tail.slice(1).join('/');
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) return errJson(404, 'Not Found');
      return jsonResult(200, { name: branch, commit: { sha: tip }, protected: false });
    }
    return errJson(404, 'Not Found');
  }

  // Commits.
  if (head === 'commits' && method === 'GET' && tail.length === 1) {
    const ref = ctx.query.get('sha') ?? repo.defaultBranch;
    const tip = store.resolveCommit(repo, ref);
    if (tip === null) return jsonResult(200, []);
    const commits = store.commitsFrom(repo, tip).map(({ sha, message }) => ({
      sha,
      commit: {
        message,
        author: { name: VIEWER.name, email: VIEWER.email, date: FIXED_ISO },
        committer: { name: VIEWER.name, email: VIEWER.email, date: FIXED_ISO },
      },
      author: { login: VIEWER.login, id: VIEWER.id },
    }));
    return pagedJson(ctx, `/api/v3/repos/${owner}/${name}/commits`, commits);
  }

  // Git Data: refs.
  if (head === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const body = bodyObject(ctx);
      if (body === null) return errJson(400, 'malformed JSON body');
      const ref = stringField(body, 'ref');
      const sha = stringField(body, 'sha');
      if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) {
        return errJson(422, 'invalid ref');
      }
      if (sha === '' || repo.objects.get(sha) === undefined) return errJson(422, 'unknown object');
      if (repo.refs.has(ref)) return errJson(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      const object = repo.objects.get(sha)!;
      return jsonResult(201, { ref, object: { sha, type: object.type, url: '' } });
    }
    if (method === 'GET') {
      if (tail.length === 2) {
        const all = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha } }));
        return jsonResult(200, all);
      }
      const kind = tail[2]!;
      const refName = tail.slice(3).join('/');
      const ref = `refs/${kind}/${refName}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return errJson(404, 'Not Found');
      return jsonResult(200, { ref, object: { sha } });
    }
    return errJson(404, 'Not Found');
  }

  // Contents.
  if (head === 'contents') {
    const path = tail.slice(1).join('/');
    if (method === 'GET') return getContent(ctx, repo, path);
    if (method === 'PUT') return putContent(ctx, repo, path);
    if (method === 'DELETE') return deleteContent(ctx, repo, path);
    return errJson(404, 'Not Found');
  }

  // Labels.
  if (head === 'labels' && tail.length === 1) {
    if (method === 'POST') {
      const body = bodyObject(ctx);
      if (body === null) return errJson(400, 'malformed JSON body');
      const name = stringField(body, 'name');
      if (name === '') return errJson(422, 'name is required');
      const label = store.createLabel(repo, name, stringField(body, 'color') || 'ededed');
      return jsonResult(201, { name: label.name, color: label.color, description: label.description });
    }
    if (method === 'GET') {
      return jsonResult(200, [...repo.labels.values()]);
    }
    return errJson(404, 'Not Found');
  }

  // Issues.
  if (head === 'issues') {
    if (tail.length === 1) {
      if (method === 'GET') return listIssues(ctx, repo);
      if (method === 'POST') {
        const body = bodyObject(ctx);
        if (body === null) return errJson(400, 'malformed JSON body');
        const labels = labelsOf(body);
        if (labels === null) return errJson(422, 'labels must be names');
        const created = store.createIssue(repo, stringField(body, 'title'), stringField(body, 'body'), labels);
        if (created.error !== undefined) return errJson(422, created.error);
        return jsonResult(201, issueJson(repo, created.issue!));
      }
      return errJson(404, 'Not Found');
    }
    const number = Number.parseInt(tail[1]!, 10);
    if (!Number.isInteger(number) || number < 1) return errJson(404, 'Not Found');
    const issue = store.getIssue(repo, number);
    if (issue === undefined) return errJson(404, 'Not Found');
    if (tail.length === 2) {
      if (method === 'GET') return jsonResult(200, issueJson(repo, issue));
      if (method === 'PATCH') {
        const body = bodyObject(ctx);
        if (body === null) return errJson(400, 'malformed JSON body');
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        return jsonResult(200, issueJson(repo, issue));
      }
      return errJson(404, 'Not Found');
    }
    if (tail[2] === 'comments') {
      if (method === 'GET') {
        const comments = issue.comments.map((comment) => ({
          id: comment.id,
          body: comment.body,
          user: { login: comment.user, id: VIEWER.id, type: 'User' },
          created_at: FIXED_ISO,
          updated_at: FIXED_ISO,
        }));
        return jsonResult(200, comments);
      }
      if (method === 'POST') {
        const body = bodyObject(ctx);
        if (body === null) return errJson(400, 'malformed JSON body');
        const comment = store.addComment(repo, issue, stringField(body, 'body'));
        return jsonResult(201, {
          id: comment.id,
          body: comment.body,
          user: { login: comment.user, id: VIEWER.id, type: 'User' },
          created_at: FIXED_ISO,
          updated_at: FIXED_ISO,
        });
      }
      return errJson(404, 'Not Found');
    }
    return errJson(404, 'Not Found');
  }

  // Pull requests.
  if (head === 'pulls') {
    if (tail.length === 1) {
      if (method === 'GET') return listPulls(ctx, repo);
      if (method === 'POST') {
        const body = bodyObject(ctx);
        if (body === null) return errJson(400, 'malformed JSON body');
        const headRef = refField(body, 'head');
        const baseRef = refField(body, 'base');
        const created = store.createPull(repo, stringField(body, 'title'), stringField(body, 'body'), headRef, baseRef);
        if (created.error !== undefined) return errJson(422, created.error);
        return jsonResult(201, pullJson(repo, created.pull!));
      }
      return errJson(404, 'Not Found');
    }
    const number = Number.parseInt(tail[1]!, 10);
    if (!Number.isInteger(number) || number < 1) return errJson(404, 'Not Found');
    const pull = store.getPull(repo, number);
    if (tail[2] === 'merge') {
      if (method !== 'PUT') return errJson(404, 'Not Found');
      if (pull === undefined) return errJson(404, 'Not Found');
      const merged = store.mergePull(repo, pull);
      if (merged.error === 'conflicted') return errJson(405, 'Merge conflict');
      if (merged.error === 'already-merged') return errJson(405, 'Pull request is already merged');
      return jsonResult(200, { sha: merged.sha, merged: true, message: pull.title });
    }
    if (pull === undefined) return errJson(404, 'Not Found');
    if (tail.length === 2) {
      if (method === 'GET') return jsonResult(200, pullJson(repo, pull));
      return errJson(404, 'Not Found');
    }
    if (tail[2] === 'files' && method === 'GET') {
      const files = pull.files.map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      }));
      return jsonResult(200, files);
    }
    return errJson(404, 'Not Found');
  }

  return errJson(404, 'Not Found');
}

function labelsOf(body: Record<string, unknown>): string[] | null {
  const raw = body.labels;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') names.push(entry);
    else if (isRecord(entry) && typeof entry.name === 'string') names.push(entry.name);
    else return null;
  }
  return names;
}

function refField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.ref === 'string') return value.ref;
  return '';
}

function listIssues(ctx: ReqCtx, repo: Repo): HandlerResult {
  const state = ctx.query.get('state') ?? 'open';
  let issues = [...repo.issues];
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  else if (state !== 'all') issues = issues.filter((issue) => issue.state === 'open');
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = ctx.query.get('direction') ?? 'desc';
  if (sort === 'created') {
    issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  }
  return pagedJson(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, issues.map((issue) => issueJson(repo, issue)));
}

function listPulls(ctx: ReqCtx, repo: Repo): HandlerResult {
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  else if (state !== 'all') pulls = pulls.filter((pull) => pull.state === 'open');
  pulls.sort((a, b) => b.number - a.number);
  return pagedJson(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, pulls.map((pull) => pullJson(repo, pull)));
}

function getContent(ctx: ReqCtx, repo: Repo, path: string): HandlerResult {
  const ref = ctx.query.get('ref') ?? undefined;
  let tip: string | null = null;
  if (ref !== undefined) {
    tip = ctx.store.resolveCommit(repo, ref);
    if (tip === null) return errJson(404, 'Not Found');
  } else {
    const head = ctx.store.headTip(repo);
    if (head === undefined) return errJson(404, 'Not Found');
    tip = ctx.store.derefToCommit(repo, head);
    if (tip === null) return errJson(404, 'Not Found');
  }
  const commit = repo.objects.get(tip);
  if (commit === undefined || commit.type !== 'commit') return errJson(404, 'Not Found');
  const tree = parseCommit(commit.data).tree;
  if (path === '') {
    return jsonResult(200, directoryEntries(repo, tree, ''));
  }
  const found = ctx.store.treeEntryAt(repo, tree, path);
  if (found === null) return errJson(404, 'Not Found');
  if (found.isDir) {
    return jsonResult(200, directoryEntries(repo, found.entry.oid, path));
  }
  const blob = repo.objects.get(found.entry.oid);
  if (blob === undefined || blob.type !== 'blob') return errJson(404, 'Not Found');
  const name = path.split('/').pop() ?? path;
  return jsonResult(200, {
    type: 'file',
    encoding: 'base64',
    size: blob.data.length,
    name,
    path,
    content: blob.data.toString('base64'),
    sha: found.entry.oid,
  });
}

function directoryEntries(repo: Repo, treeOid: string, prefix: string): Array<Record<string, unknown>> {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  const entries: Array<Record<string, unknown>> = [];
  for (const entry of parseTree(object.data)) {
    entries.push({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.oid,
      size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
    });
  }
  return entries;
}

function putContent(ctx: ReqCtx, repo: Repo, path: string): HandlerResult {
  const body = bodyObject(ctx);
  if (body === null) return errJson(400, 'malformed JSON body');
  const contentB64 = stringField(body, 'content');
  if (contentB64 === '') return errJson(422, 'content is required');
  const content = Buffer.from(contentB64, 'base64');
  const branch = typeof body.branch === 'string' ? body.branch : undefined;
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  const result = ctx.store.putContent(repo, path, content, stringField(body, 'message') || 'update', branch, sha);
  if ('error' in result) return errJson(result.error, result.message);
  const name = path.split('/').pop() ?? path;
  return jsonResult(result.created ? 201 : 200, {
    content: { name, path, sha: result.contentSha, size: content.length, type: 'file', encoding: 'base64' },
    commit: { sha: result.commitSha, message: stringField(body, 'message') || 'update' },
  });
}

function deleteContent(ctx: ReqCtx, repo: Repo, path: string): HandlerResult {
  const body = bodyObject(ctx);
  if (body === null) return errJson(400, 'malformed JSON body');
  const branch = typeof body.branch === 'string' ? body.branch : undefined;
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  const result = ctx.store.deleteContent(repo, path, stringField(body, 'message') || 'delete', branch, sha);
  if ('error' in result) return errJson(result.error, result.message);
  return jsonResult(200, { commit: { sha: result.commitSha } });
}
