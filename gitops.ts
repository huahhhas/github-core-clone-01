// gitops.ts — git smart HTTP: info/refs advertisements, upload-pack (v2 + v0) and
// receive-pack. The wire follows git's protocol v2 and v0 as the suite's client speaks them.

import {
  decodePktLines,
  isObjectId,
  packetLines,
  parseCommit,
  pktDelim,
  pktFlush,
  pktLine,
  pktLines,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './git.ts';
import { selectFetch, VIEWER, type Repo, type Store } from './store.ts';
import { errJson, type HandlerResult, type ReqCtx } from './http.ts';

const AGENT = 'github-core-clone-forge/1.0.0';
const UPLOAD_CAPS_V2 = ['ls-refs=unborn', 'fetch=shallow', `agent=${AGENT}`, 'object-format=sha1'];
const UPLOAD_CAPS_V0 = `symref=HEAD:refs/heads/main agent=${AGENT} side-band-64k side-band thin-pack ofs-delta shallow multi_ack multi_ack_detailed`;
const RECEIVE_CAPS_V0 = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

function findRepo(ctx: ReqCtx, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** A tag object peeled to its commit, following nested tags. */
function peelTag(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined) return null;
  if (object.type === 'commit') return oid;
  if (object.type !== 'tag') return null;
  const text = object.data.toString('utf8');
  const match = /^object ([0-9a-f]{40})$/m.exec(text);
  if (match === null) return null;
  return peelTag(repo, match[1]!);
}

/** Sideband packets for a pack: one band byte plus up to 65515 payload bytes each. */
function packSideband(objects: Map<string, GitObject>): Buffer[] {
  const sorted = [...objects.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const pack = writePack(sorted.map(([, object]) => object));
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function v0RefLines(repo: Repo, caps: string): string[] {
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    return [`${ZERO_OID} capabilities^{}\0${caps}\n`];
  }
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? refs[0]!.oid;
  const lines: string[] = [`${head} HEAD\0${caps}\n`];
  for (const ref of refs) {
    lines.push(`${ref.oid} ${ref.name}\n`);
    const object = repo.objects.get(ref.oid);
    if (ref.name.startsWith('refs/tags/') && object !== undefined && object.type === 'tag') {
      const peeled = peelTag(repo, ref.oid);
      if (peeled !== null) lines.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  return lines;
}

export function handleInfoRefs(ctx: ReqCtx, owner: string, name: string, service: string): HandlerResult {
  const repo = findRepo(ctx, owner, name);
  if (repo === null) return errJson(404, 'Not Found');
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-receive-pack') {
    const body = pktLines(['# service=git-receive-pack\n', 'flush', ...v0RefLines(repo, RECEIVE_CAPS_V0), 'flush']);
    return { status: 200, headers: { 'content-type': contentType }, body };
  }
  if (ctx.headers['git-protocol'] === 'version=2') {
    const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), pktFlush(), pktLine('version 2\n')];
    for (const cap of UPLOAD_CAPS_V2) parts.push(pktLine(`${cap}\n`));
    parts.push(pktFlush());
    return { status: 200, headers: { 'content-type': contentType }, body: Buffer.concat(parts) };
  }
  const body = pktLines(['# service=git-upload-pack\n', 'flush', ...v0RefLines(repo, UPLOAD_CAPS_V0), 'flush']);
  return { status: 200, headers: { 'content-type': contentType }, body };
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
  deepenSince: number | undefined;
  deepenNot: string[];
  done: boolean;
}

function emptyFetchArgs(): FetchArgs {
  return { wants: [], haves: [], shallow: [], depth: undefined, deepenSince: undefined, deepenNot: [], done: false };
}

interface V2Request {
  command: string;
  args: FetchArgs;
  prefixes: string[];
  peel: boolean;
  symrefs: boolean;
}

function parseV2(lines: string[]): V2Request | null {
  const first = (lines[0] ?? '').replace(/\n$/, '');
  if (!first.startsWith('command=')) return null;
  const command = first.slice('command='.length);
  const args = emptyFetchArgs();
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  for (const raw of lines.slice(1)) {
    const text = raw.replace(/\n$/, '');
    if (text === '') continue;
    if (text.startsWith('agent=') || text.startsWith('object-format=')) continue;
    if (command === 'ls-refs') {
      if (text === 'peel') peel = true;
      else if (text === 'symrefs') symrefs = true;
      else if (text === 'unborn') continue;
      else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
      continue;
    }
    if (command === 'fetch') {
      if (text === 'thin-pack' || text === 'no-progress' || text === 'ofs-delta') continue;
      if (text === 'done') {
        args.done = true;
        continue;
      }
      if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
      else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) args.depth = Number.parseInt(text.slice(7), 10);
      else if (text.startsWith('deepen-since ')) args.deepenSince = Number.parseInt(text.slice(13), 10);
      else if (text.startsWith('deepen-not ')) args.deepenNot.push(text.slice(11).trim());
      else if (text.startsWith('filter ')) continue;
    }
  }
  return { command, args, prefixes, peel, symrefs };
}

function lsRefsLines(repo: Repo, prefixes: string[], peel: boolean, symrefs: boolean): string[] {
  const lines: string[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (keep('HEAD')) {
    const oid = headTip ?? ZERO_OID;
    const symref = symrefs ? ' symref-target:refs/heads/main' : '';
    lines.push(`${oid} HEAD${symref}\n`);
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const object = repo.objects.get(ref.oid);
      if (ref.name.startsWith('refs/tags/') && object !== undefined && object.type === 'tag') {
        const peeled = peelTag(repo, ref.oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    lines.push(`${line}\n`);
  }
  return lines;
}

function fetchResponse(repo: Repo, args: FetchArgs, v2: boolean): Buffer {
  const selection = selectFetch(repo, args.wants, args.haves, args.shallow, args.depth, args.deepenSince, args.deepenNot);
  const parts: Buffer[] = [];
  if (v2) {
    // The protocol says: when the client sent `done`, negotiation is over and the
    // acknowledgments section MUST be omitted — the packfile section comes first.
    if (!args.done) {
      parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim(), pktFlush());
      return Buffer.concat(parts);
    }
    if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(pktDelim());
    }
    if (selection.objects.size > 0) {
      parts.push(pktLine('packfile\n'));
      for (const packet of packSideband(selection.objects)) parts.push(packet);
    }
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  parts.push(pktLine('NAK\n'));
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (selection.objects.size > 0) {
    for (const packet of packSideband(selection.objects)) parts.push(packet);
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function handleUploadPack(ctx: ReqCtx, owner: string, name: string): HandlerResult {
  const repo = findRepo(ctx, owner, name);
  if (repo === null) return errJson(404, 'Not Found');
  const contentType = 'application/x-git-upload-pack-result';
  try {
    const { packets } = decodePktLines(ctx.body);
    const lines = packetLines(packets);
    if (lines.length > 0 && lines[0]!.startsWith('command=')) {
      const parsed = parseV2(lines);
      if (parsed === null) return { status: 200, headers: { 'content-type': contentType }, body: pktFlush() };
      if (parsed.command === 'ls-refs') {
        const out = lsRefsLines(repo, parsed.prefixes, parsed.peel, parsed.symrefs);
        const body = Buffer.concat([...out.map((line) => pktLine(line)), pktFlush()]);
        return { status: 200, headers: { 'content-type': contentType }, body };
      }
      if (parsed.command === 'fetch') {
        return { status: 200, headers: { 'content-type': contentType }, body: fetchResponse(repo, parsed.args, true) };
      }
      return { status: 200, headers: { 'content-type': contentType }, body: pktFlush() };
    }
    // v0: wants/shallow/deepen, flush, haves/done, flush.
    const args = emptyFetchArgs();
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8').replace(/\n$/, '');
      if (text.startsWith('want ')) {
        const rest = text.slice(5).trim().split(' ')[0]!;
        if (isObjectId(rest)) args.wants.push(rest);
      } else if (text.startsWith('shallow ')) {
        args.shallow.push(text.slice(8).trim());
      } else if (text.startsWith('deepen ')) {
        args.depth = Number.parseInt(text.slice(7), 10);
      } else if (text.startsWith('deepen-since ')) {
        args.deepenSince = Number.parseInt(text.slice(13), 10);
      } else if (text.startsWith('deepen-not ')) {
        args.deepenNot.push(text.slice(11).trim());
      } else if (text.startsWith('have ')) {
        args.haves.push(text.slice(5).trim());
      }
    }
    return { status: 200, headers: { 'content-type': contentType }, body: fetchResponse(repo, args, false) };
  } catch {
    // A malformed body must not take the server down: answer an empty result.
    return { status: 200, headers: { 'content-type': contentType }, body: pktFlush() };
  }
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function isDescendant(repo: Repo, ancestor: string, commit: string): boolean {
  if (ancestor === commit) return true;
  const seen = new Set<string>();
  const queue: string[] = [commit];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

export function handleReceivePack(ctx: ReqCtx, owner: string, name: string): HandlerResult {
  const repo = findRepo(ctx, owner, name);
  if (repo === null) return errJson(404, 'Not Found');
  const contentType = 'application/x-git-receive-pack-result';
  const report = (unpackLine: string, lines: string[]): HandlerResult => {
    // The report-status lines are pkt-lined inside band 1, and the band-1 stream itself ends
    // with a flush packet before the outer flush: real git's sideband reader expects it.
    const inner = pktLines([unpackLine, ...lines, 'flush']);
    const band1 = pktLine(Buffer.concat([Buffer.from([1]), inner]));
    return { status: 200, headers: { 'content-type': contentType }, body: Buffer.concat([band1, pktFlush()]) };
  };
  try {
    const { packets, consumed } = decodePktLines(ctx.body, { stopAtFlush: true });
    const commands: PushCommand[] = [];
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      let text = packet.payload.toString('utf8');
      const nul = text.indexOf('\0');
      if (nul >= 0) text = text.slice(0, nul);
      const line = text.replace(/\n$/, '');
      const parts = line.split(' ');
      if (parts.length < 3) continue;
      const [oldOid, newOid, ref] = parts as [string, string, string];
      if (!isObjectId(oldOid) || !isObjectId(newOid)) continue;
      commands.push({ oldOid, newOid, ref });
    }
    const packBytes = ctx.body.subarray(consumed);
    const hasUpdates = commands.some((command) => command.newOid !== ZERO_OID);
    if (hasUpdates && packBytes.length > 0) {
      const pack = readPack(packBytes);
      for (const [oid, object] of pack.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    }
    const lines: string[] = [];
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        if (current === undefined) {
          lines.push(`ng ${command.ref} remote ref does not exist\n`);
          continue;
        }
        if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          lines.push(`ng ${command.ref} non-fast-forward\n`);
          continue;
        }
        repo.refs.delete(command.ref);
        lines.push(`ok ${command.ref}\n`);
        continue;
      }
      const newObject = repo.objects.get(command.newOid);
      if (newObject === undefined) {
        lines.push(`ng ${command.ref} object not found\n`);
        continue;
      }
      if (current === undefined) {
        if (command.oldOid !== ZERO_OID) {
          lines.push(`ng ${command.ref} non-fast-forward\n`);
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        lines.push(`ok ${command.ref}\n`);
        continue;
      }
      if (command.oldOid !== current) {
        lines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      if (command.ref.startsWith('refs/tags/')) {
        repo.refs.set(command.ref, command.newOid);
        lines.push(`ok ${command.ref}\n`);
        continue;
      }
      const newCommit = peelTag(repo, command.newOid);
      if (newCommit === null || !isDescendant(repo, current, newCommit)) {
        lines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      lines.push(`ok ${command.ref}\n`);
    }
    return report('unpack ok\n', lines);
  } catch {
    return report('unpack error\n', []);
  }
}
