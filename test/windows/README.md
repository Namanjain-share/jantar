# Native Windows checks (v0.6, preview)

The checks that need a real Windows machine: the daemon's named pipes, the
hook client over them, the exec-form hooks installer, a node-mode daemon on
a Windows profile, and the `schtasks` lines `jantar install` prints. They
run on GitHub's `windows-latest` runner (the `windows` job in
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)):

```sh
pnpm install --frozen-lockfile && pnpm build
pnpm --filter @jantar/cli test:windows
```

Everywhere else each case skips itself. The suite does not run the whole
test tree on Windows: the rest assumes POSIX. Until the job is green,
native Windows stays a preview in the docs.
