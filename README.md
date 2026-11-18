# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/huahhhas/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/huahhhas/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge: smart HTTP git (protocol v2 and v0, packfiles, shallow fetch, push report-status), REST v3 (repositories, branches, commits, contents, labels, issues, comments, pull requests), GraphQL (viewer, repository, node, issues, pull requests, mutations, introspection) and MCP (server/discover, tools/list, tools/call). Stdlib-only Node 22, no dependencies, deterministic object ids and timestamps so live and replay runs agree.

## Run it

```sh
MAKEFUN_ENV_URL=http://localhost:8080 node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it with the environment, and exits when the environment reports done. Without `MAKEFUN_ENV_URL` it exits at once; for a local smoke test, start the app directly:

```sh
node --experimental-strip-types -e "import('./app.ts').then(({createApp}) => createApp().listen(0, function () { console.log('listening on', this.address().port) }))"
```

Then point any git client, `gh`, or MCP client at it with any non-empty `Authorization: Bearer <token>` header (when `MAKEFUN_SHOP_TOKEN` is set, the bearer must match it exactly). The authenticated user is `adaiversen`.

<sub>Entered on [make.fun](https://make.fun/?ref=4bs5ey91&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
