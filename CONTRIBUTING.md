# Contributing to @waffo/pancake-migrate

Thanks for helping more teams move to Waffo Pancake. This repo holds the CLI
source and the public migration guide.

## Repo layout

```
src/
  cli.ts             # commander root, registers subcommands
  commands/          # one file per source platform (stripe.ts, creem.ts, dodo.ts)
  stripe/ creem/ dodo/     # fetchers + mappers for each source
  mapper/            # shared mapping helpers (intervals, currencies, media)
  pancake/creator.ts # writes products / stores / webhooks / branding via @waffo/pancake-ts
  prompts/           # interactive mode
docs/
  migrate.{en,zh,ja}.mdx   # mirrors https://docs.waffo.ai/integrate/migrate
```

## Local development

```bash
npm install
npm run dev          # tsup --watch
node dist/index.js   # run the CLI
npm run typecheck
npm test
npm run format:check # verify formatting
npm run format       # apply formatting
```

Always test against **test-mode** keys (`sk_test_`, `creem_test_`, a Pancake
test-environment API key). For Dodo, select `--environment test` explicitly. Use `--dry-run` while iterating.

## Adding a new source platform

1. Add `src/<platform>/fetcher.ts` (read products / prices / webhooks / branding)
   and `src/<platform>/mapper.ts` (map to `PancakeProductInput`, see `src/utils/types.ts`).
2. Add `src/commands/<platform>.ts` and register it in `src/cli.ts`.
3. Add the platform to the interactive source picker in `src/prompts/interactive.ts`.
4. Document the flags and the "what migrates / what doesn't" tables in all three
   `docs/migrate.*.mdx` files.

## Docs

The three MDX files under `docs/` are the source for the public migration guide at
[docs.waffo.ai/integrate/migrate](https://docs.waffo.ai/integrate/migrate)
(English, 中文, 日本語). Edit them here in a PR; maintainers sync merged changes to
the docs site. Keep the three languages in step — if you only speak one, update
that one and say so in the PR, we will translate the rest.

## Pull requests

- Never commit keys, `.pem` files, or real merchant / store IDs.
- Conventional commit messages (`feat:`, `fix:`, `docs:`).
- Describe how you verified the change (dry-run output is great).

## Dependency pins

`@waffo/pancake-ts` is pinned to `0.4.2` and `creem` to `1.4.4` — the versions
the published `0.2.0` was built against. Newer releases of both changed their
APIs (`SDKOptions.serverIdx`, paginated `products.search`, `UpdateStoreParams`).
Upgrading them is a welcome contribution; keep `npm run typecheck` green.
