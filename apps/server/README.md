# Archivist Server

The Archivist service's server side: archive storage and rules, and the website's sign-in, JSON routes, and media streaming. It is a workspace of the repository's npm monorepo.

## Layout

| Path | Contents |
| --- | --- |
| `src/archivist/` | Archive storage and rules, described in its [README](src/archivist/README.md) |
| `src/archivist/web/` | The website's server side, described in its [README](src/archivist/web/README.md) |
| `tests/` | Automated tests, described in [Tests](tests/README.md) |

The website's pages are a separate workspace, [`apps/web`](../web/README.md), which this server serves once built.

## Commands

Run these from the repository root. They work the same inside the [dev container](../../.devcontainer/README.md).

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile the TypeScript in `src/` to `build/` |
| `npm run check` | Type check the source and tests, and check formatting |
| `npm test` | Compile and run every test suite |

## Porting From the Bot

This code came from `src/archivist/` and `tests/archivist/` in GuhBot.Discord at commit `d4b46a8`, with the same layout below `apps/server/`. Until the bot calls this service instead of its own copy, a change made to that copy can be carried over as a patch. From the repository root, with both repositories side by side, run the following, replacing `<commit>` with the bot commit to bring over.

```sh
git -C ../GuhBot.Discord diff d4b46a8 <commit> -- src/archivist tests/archivist/core tests/archivist/web tests/archivist/helpers > ../archivist.patch
git apply --directory=apps/server --reject ../archivist.patch
```

`--reject` applies what it can and writes each hunk that no longer fits to a `.rej` file beside its target. Apply those by hand, delete the `.rej` files, and run the checks. Record the bot commit you ported up to in the commit message.
