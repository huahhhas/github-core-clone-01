// app.ts — the HTTP server: reads each request, builds its ReqCtx, enforces the bearer
// token, routes to the REST / GraphQL / MCP / git surfaces, and stamps every reply with
// X-GitHub-Request-Id. No wall clock or randomness is used anywhere in a reply.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMCP } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitops.ts';
import { decodeSegment, errJson, jsonResult, type HandlerResult, type ReqCtx } from './http.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      if (tooBig) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooBig = true;
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, result: HandlerResult, reqId: string): void {
  const headers: Record<string, string> = {
    'x-github-request-id': reqId,
    'content-type': 'application/json; charset=utf-8',
    ...(result.headers ?? {}),
  };
  const body = result.body === undefined ? Buffer.alloc(0) : typeof result.body === 'string' ? Buffer.from(result.body, 'utf8') : result.body;
  res.writeHead(result.status, headers);
  res.end(body);
}

/** Build the server. A fresh Store is created per process; pass one in only for tests. */
export function createApp(store: Store = new Store()): Server {
  let requestCounter = 0;
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  return createServer((req, res) => {
    void (async () => {
      const reqId = `req-${(requestCounter += 1)}`;
      try {
        const rawUrl = req.url ?? '/';
        const url = new URL(rawUrl, 'http://localhost');
        const rawSegments = url.pathname.split('/').filter((segment) => segment !== '');
        const segments: string[] = [];
        for (const raw of rawSegments) {
          const decoded = decodeSegment(raw);
          if (decoded === null) {
            send(res, errJson(400, 'malformed path'), reqId);
            return;
          }
          segments.push(decoded);
        }
        const body = await readBody(req);
        let json: unknown;
        let jsonError = false;
        if (body.length > 0) {
          try {
            json = JSON.parse(body.toString('utf8')) as unknown;
          } catch {
            jsonError = true;
          }
        }
        const headers: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
        }
        const authHeader = headers.authorization ?? '';
        const authed =
          expectedToken !== ''
            ? authHeader === `Bearer ${expectedToken}`
            : authHeader.startsWith('Bearer ') && authHeader.slice('Bearer '.length).trim() !== '';
        const ctx: ReqCtx = {
          store,
          method: (req.method ?? 'GET').toUpperCase(),
          segments,
          query: url.searchParams,
          headers,
          body,
          json,
          jsonError,
          authed,
          host: headers.host ?? '127.0.0.1',
          reqId,
        };

        const isRoot = ctx.method === 'GET' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'v3';
        const isHealthz = ctx.method === 'GET' && segments.length === 1 && segments[0] === 'healthz';
        if (!isRoot && !isHealthz && !authed) {
          send(res, errJson(401, 'Requires authentication'), reqId);
          return;
        }

        let result: HandlerResult | null = null;
        if (isHealthz) {
          result = jsonResult(200, { ok: true });
        } else if (segments[0] === 'api' && segments[1] === 'v3') {
          result = handleRest(ctx);
        } else if (segments[0] === 'api' && segments[1] === 'graphql') {
          result = ctx.method === 'POST' ? handleGraphQL(ctx) : errJson(404, 'Not Found');
        } else if (segments[0] === 'mcp') {
          result = ctx.method === 'POST' ? handleMCP(ctx) : errJson(405, 'Method Not Allowed');
        } else if (
          segments.length === 4 &&
          segments[1] !== undefined &&
          segments[1].endsWith('.git') &&
          segments[2] === 'info' &&
          segments[3] === 'refs' &&
          ctx.method === 'GET'
        ) {
          const service = ctx.query.get('service') ?? '';
          const repoName = segments[1].slice(0, -'.git'.length);
          result = handleInfoRefs(ctx, segments[0], repoName, service);
        } else if (
          segments.length === 3 &&
          segments[1] !== undefined &&
          segments[1].endsWith('.git') &&
          segments[2] === 'git-upload-pack' &&
          ctx.method === 'POST'
        ) {
          result = handleUploadPack(ctx, segments[0], segments[1].slice(0, -'.git'.length));
        } else if (
          segments.length === 3 &&
          segments[1] !== undefined &&
          segments[1].endsWith('.git') &&
          segments[2] === 'git-receive-pack' &&
          ctx.method === 'POST'
        ) {
          result = handleReceivePack(ctx, segments[0], segments[1].slice(0, -'.git'.length));
        }
        if (result === null) result = errJson(404, 'Not Found');
        send(res, result, reqId);
      } catch (error) {
        // A handler that throws must not take the server down with it.
        try {
          send(res, errJson(500, error instanceof Error ? error.message : 'internal error'), reqId);
        } catch {
          res.destroy();
        }
      }
    })();
  });
}
