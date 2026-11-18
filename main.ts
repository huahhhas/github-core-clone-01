// main.ts — the entrypoint: how this process lives and dies with the trial env.
//
// The harness (env/src/wire.ts) owns the trial. This file only does the handshake:
//   1. Read MAKEFUN_ENV_URL. With no env origin there is nothing to join, so exit 1.
//   2. Build the forge server (app.ts) and listen on an ephemeral port the kernel
//      picks. Port 8080 belongs to the env; never bind it.
//   3. POST {port} to $MAKEFUN_ENV_URL/register. The env records where the request
//      came from plus the port and dials the server from then on. The first
//      registration wins: a 409 means somebody else registered first, and this
//      process simply waits like any other.
//   4. GET $MAKEFUN_ENV_URL/done until it answers {"done": true}. The env replies
//      immediately ({"done": false} while the suite is still running), so this is
//      a poll. A failed or slow poll is retried with exponential backoff; the
//      process never exits before the env says it is done.
//   5. Close the server and exit 0. The harness then stops the env, which writes
//      the export the scorer reads.
//
// Nothing else is imported here: the server comes from app.ts, and there are no
// packages, no other Node built-ins, and no model calls in this file.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to join\n');
  process.exit(1);
}

/** One register or done request may take this long before it is abandoned and retried. */
const FETCH_TIMEOUT_MS = 30_000;
/** First backoff between retries, and the longest backoff. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_CAP_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Backoff after `failures` failed attempts: exponential from BACKOFF_FIRST_MS, capped. */
function backoffMs(failures: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_FIRST_MS * 2 ** Math.min(failures, 8));
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer and 409
 * means a first registration already won, which is not this process's to fix.
 * 400 and 405 are contract errors and end the program; anything else (a network
 * error, another status) is retried, since the env may still be starting up.
 */
async function register(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    let answer: Response | null = null;
    try {
      answer = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      // No answer at all: the env may still be starting; fall through to the retry.
    }
    if (answer !== null) {
      if (answer.status === 200 || answer.status === 409) return;
      if (answer.status === 400 || answer.status === 405) {
        throw new Error(`register was refused with HTTP ${answer.status}: ${await answer.text()}`);
      }
    }
    await pause(backoffMs(failures));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitUntilDone(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const answer = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (answer.ok) {
        const payload = (await answer.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: not done, so poll again.
    }
    await pause(backoffMs(failures));
  }
}

/** Bind the port, register it, then wait for the env: the whole life of the process. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      resolve();
    });
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] bound, port ${bound.port}\n`);

  await register(bound.port);
  process.stdout.write('[entry] registered; waiting for done\n');

  try {
    await waitUntilDone();
  } finally {
    // Close the server even if the wait fails: nothing should keep the port open
    // after this process stops caring about the env.
    server.close();
  }
  process.stdout.write('[entry] env said done; exiting\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
