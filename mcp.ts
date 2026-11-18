// mcp.ts — Model Context Protocol over Streamable HTTP (JSON-RPC 2.0, plain JSON answers).
// Modern era 2026-07-28: server/discover first; the legacy initialize handshake is also answered.

import { FIXED_ISO, globalId, VIEWER, type Repo, type Store } from './store.ts';
import { jsonResult, type HandlerResult, type ReqCtx } from './http.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the new repository.' },
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Repository full name "owner/repo".' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Repository full name "owner/repo".' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Repository full name "owner/repo".' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Repository full name "owner/repo".' },
        title: { type: 'string', description: 'Pull request title.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
        body: { type: 'string', description: 'Pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Repository full name "owner/repo".' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function intArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return undefined;
}

/** Resolve owner/repo from tool arguments (accepts full_name as "owner/repo"). */
function resolveRepo(store: Store, args: Record<string, unknown>): { repo: Repo; owner: string } | { error: string } {
  let owner = stringArg(args, 'owner');
  let name = stringArg(args, 'repo');
  const fullName = stringArg(args, 'full_name');
  if (fullName !== '' && (owner === '' || name === '')) {
    const slash = fullName.indexOf('/');
    if (slash > 0) {
      owner = fullName.slice(0, slash);
      name = fullName.slice(slash + 1);
    }
  }
  if (owner === '') owner = VIEWER.login;
  if (name === '') return { error: 'missing required argument: repo' };
  if (owner !== VIEWER.login) return { error: `repository ${owner}/${name} not found` };
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return { error: `repository ${owner}/${name} not found` };
  return { repo, owner };
}

function repoPayload(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('repo', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

type ToolOutcome =
  | { ok: true; payload: unknown }
  | { ok: false; message: string };

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return { ok: false, message: `unknown tool "${name}"` };
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { ok: false, message: `missing required argument: ${required}` };
    }
  }
  if (name === 'create_repo') {
    const owner = stringArg(args, 'owner');
    if (owner !== '' && owner !== VIEWER.login) return { ok: false, message: `cannot create a repository for ${owner}` };
    const created = store.createRepo(stringArg(args, 'name'), args.private === true, stringArg(args, 'description'));
    if (created.repo === undefined) return { ok: false, message: created.error ?? 'could not create repository' };
    return { ok: true, payload: repoPayload(created.repo) };
  }
  if (name === 'get_repo') {
    const resolved = resolveRepo(store, args);
    if ('error' in resolved) return { ok: false, message: resolved.error };
    return { ok: true, payload: repoPayload(resolved.repo) };
  }
  if (name === 'create_issue') {
    const resolved = resolveRepo(store, args);
    if ('error' in resolved) return { ok: false, message: resolved.error };
    const created = store.createIssue(resolved.repo, stringArg(args, 'title'), stringArg(args, 'body'), []);
    if (created.issue === undefined) return { ok: false, message: created.error ?? 'could not create issue' };
    const issue = created.issue;
    return {
      ok: true,
      payload: {
        id: issue.id,
        node_id: globalId('issue', resolved.repo.id, issue.number),
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        url: `https://example.invalid/${resolved.repo.owner}/${resolved.repo.name}/issues/${issue.number}`,
      },
    };
  }
  if (name === 'list_issues') {
    const resolved = resolveRepo(store, args);
    if ('error' in resolved) return { ok: false, message: resolved.error };
    const state = stringArg(args, 'state') || 'open';
    let issues = [...resolved.repo.issues];
    if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
    else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
    const list = issues.map((issue) => ({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
    }));
    return { ok: true, payload: { issues: list } };
  }
  if (name === 'create_pull_request') {
    const resolved = resolveRepo(store, args);
    if ('error' in resolved) return { ok: false, message: resolved.error };
    const created = store.createPull(
      resolved.repo,
      stringArg(args, 'title'),
      stringArg(args, 'body'),
      stringArg(args, 'head'),
      stringArg(args, 'base'),
    );
    if (created.pull === undefined) return { ok: false, message: created.error ?? 'could not create pull request' };
    const pull = created.pull;
    return {
      ok: true,
      payload: {
        id: pull.id,
        node_id: globalId('pr', resolved.repo.id, pull.number),
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.headRef, sha: pull.headSha },
        base: { ref: pull.baseRef, sha: pull.baseSha },
      },
    };
  }
  if (name === 'merge_pull_request') {
    const resolved = resolveRepo(store, args);
    if ('error' in resolved) return { ok: false, message: resolved.error };
    const number = intArg(args, 'pull_number') ?? intArg(args, 'number');
    if (number === undefined) return { ok: false, message: 'missing required argument: pull_number' };
    const pull = store.getPull(resolved.repo, number);
    if (pull === undefined) return { ok: false, message: `pull request #${number} not found` };
    const merged = store.mergePull(resolved.repo, pull);
    if (merged.error !== undefined) return { ok: false, message: `cannot merge pull request: ${merged.error}` };
    return {
      ok: true,
      payload: { number: pull.number, merged: true, state: pull.state, sha: merged.sha ?? null },
    };
  }
  return { ok: false, message: `unknown tool "${name}"` };
}

function rpcResult(id: unknown, result: unknown): HandlerResult {
  return jsonResult(200, { jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string): HandlerResult {
  return jsonResult(200, { jsonrpc: '2.0', id, error: { code, message } });
}

/** POST /mcp — JSON-RPC 2.0 over Streamable HTTP (plain JSON answers). */
export function handleMCP(ctx: ReqCtx): HandlerResult {
  if (ctx.jsonError) {
    // A body that is not JSON at all: HTTP 400 carrying JSON-RPC -32700.
    return jsonResult(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const body = ctx.json;
  if (!isRecord(body) || typeof body.method !== 'string') {
    return jsonResult(200, { jsonrpc: '2.0', id: isRecord(body) ? (body.id ?? null) : null, error: { code: -32600, message: 'Invalid Request' } });
  }
  const id = body.id;
  const params = isRecord(body.params) ? body.params : {};
  const isNotification = id === undefined;

  // Notifications carry no id and expect no JSON-RPC answer: HTTP 202, empty body.
  if (isNotification) {
    return { status: 202, headers: { 'content-type': 'application/json' }, body: Buffer.alloc(0) };
  }

  switch (body.method) {
    case 'server/discover': {
      const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      });
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(offered) ? offered : SUPPORTED_VERSIONS[0]!;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (tool === undefined) {
        return rpcError(id, -32601, `unknown tool "${name}"`);
      }
      const outcome = callTool(ctx.store, name, args);
      if (!outcome.ok) {
        return rpcResult(id, {
          content: [{ type: 'text', text: outcome.message }],
          isError: true,
        });
      }
      const text = JSON.stringify(outcome.payload);
      return rpcResult(id, {
        content: [{ type: 'text', text }],
        structuredContent: outcome.payload,
        isError: false,
      });
    }
    default:
      return rpcError(id, -32601, `method not found: ${body.method}`);
  }
}
