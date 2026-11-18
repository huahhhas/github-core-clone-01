// http.ts — the request context and response helpers every surface shares.

import type { Store } from './store.ts';

export interface ReqCtx {
  store: Store;
  method: string;
  /** Decoded path segments, no leading/trailing empties. */
  segments: string[];
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  /** The raw request body (empty for body-less requests). */
  body: Buffer;
  /** The parsed JSON body, when the body parsed as JSON. */
  json: unknown;
  /** True when a non-empty body failed to parse as JSON. */
  jsonError: boolean;
  /** True when the request carried the trial's bearer token. */
  authed: boolean;
  /** The request's Host header value, for absolute pagination URLs. */
  host: string;
  /** The request-id value this response carries. */
  reqId: string;
}

export interface HandlerResult {
  status: number;
  headers?: Record<string, string>;
  /** A string body is sent as UTF-8; a Buffer as-is. Undefined sends no body. */
  body?: string | Buffer;
}

export function jsonResult(status: number, body: unknown, headers: Record<string, string> = {}): HandlerResult {
  return { status, headers, body: `${JSON.stringify(body)}\n` };
}

export function textResult(status: number, body: string, contentType: string, headers: Record<string, string> = {}): HandlerResult {
  return { status, headers: { 'content-type': contentType, ...headers }, body };
}

export function emptyResult(status: number, headers: Record<string, string> = {}): HandlerResult {
  return { status, headers };
}

export function errJson(status: number, message: string): HandlerResult {
  return jsonResult(status, { message });
}

/** Decode one path segment, or null when it is not valid percent-encoding. */
export function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
