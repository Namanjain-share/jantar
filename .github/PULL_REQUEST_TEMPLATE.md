## What and why

<!-- What this changes, and the problem it solves. Link the issue if there is one. -->

## How it was tested

<!-- The tests you added or ran. Tests never touch a real Terminal, cswap, claude or ~/.claude: they use the synthetic home from @jantar/fixtures. -->

## Checklist

- [ ] `pnpm check` is green (build, typecheck, tests, `lint:secrets`, `lint:oss`, provenance).
- [ ] Every example, fixture and picture is synthetic: no real names, e-mail addresses, accounts, paths, transcripts or tokens.
- [ ] A change that shows on a screen: pictures retaken with `node scripts/screenshots.mjs` (then `node scripts/brand.mjs` if a banner phone changed), and each one checked by eye.
- [ ] A change people will notice: README or `docs/` updated, and a line in `CHANGELOG.md`.
- [ ] Code adapted from another project carries its header and a row in `docs/PROVENANCE.md` (see CONTRIBUTING.md).
- [ ] I have signed the contributor agreement (`CLA.md`); the bot asks on your first pull request.
