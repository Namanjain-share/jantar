# Native Windows checks (v0.6, preview)

The checks that need a real Windows machine. They run on GitHub's
`windows-latest` runner (the `windows` job in
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)):

```sh
pnpm install --frozen-lockfile && pnpm build
pnpm --filter @jantar/cli test:windows
```

| File | Check |
|---|---|
| `pipes.test.ts` | The daemon names one hooks pipe and one ctl pipe per state dir, whatever its spelling |
| `hooks-pipe.test.ts` | W1: the hook client, run as the exec-form entry says and with the state dir spelled another way, gets the decision over the hooks pipe; with the daemon down it exits 0 and prints nothing; no other user can write to the pipe |
| `installer.test.ts` | W2: `jantar hooks install` writes exec form (`node.exe`, `args`, `onFailure: "continue"`), installs once, and uninstall gives the file back byte for byte |
| `node.test.ts` | W3-W6: a node on a fake profile finds its sessions without `ps`, on `dirs` accounts; it links to a hub in the same process; a phone on the hub answers a card held on the node's pipe; a prompt gets the watch-only line; `jantar node status` answers over the ctl pipe |
| `schtasks.test.ts` | W7: the `schtasks` lines `jantar install` prints, run as printed against a task of the run's own name |
| `state-dirs.test.ts` | W8: the state dirs and `node.json` are written with no chmod failure |

Everywhere else each case skips itself; the same code paths are covered
with `win32` injected by the packages' own tests
(`packages/hook/test/pipe-name.test.ts`,
`packages/daemon/test/hooks/{installer,socket}-win32.test.ts`,
`packages/cli/test/ctl-pipe.test.ts`). The suite does not run the whole
test tree on Windows: the rest assumes POSIX. Until the job is green,
native Windows stays a preview in the docs.
