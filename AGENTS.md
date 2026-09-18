# AGENTS.md

Operating manual for this repo. Prefer this file plus the source over README when they disagree.

## What this is

Samasara is a **local Bun daemon** that polls GitHub `main` on tracked repos. When the check rollup is **red** (after `ignoreChecks`), it runs an **OMP healer** that may only edit files. The **controller** (`src/session.ts`) commits and force-pushes nothing: it `git commit` + `git push` to `main`. No PRs, no `heal/` branches. A localhost dashboard (`src/dashboard.ts`) is published through Tailscale Funnel for public status/telemetry; repository mutations require `SAMASARA_DASHBOARD_USER`. Do not add another web UI, public application ports, or password auth.

End commands: `bun src/index.ts start`, `bun src/index.ts stop`, `bun src/index.ts once`, or `bun src/index.ts dashboard`.

## Runtime

- **CWD:** `/home/opc/samasara` (this repo).
- **Bun** (zero npm dependencies). Built-ins only: `bun:sqlite`, `Bun.spawn`, `fetch`.
- **omp** must be on `PATH` (controller prepends `/home/opc/.bun/bin`). Do **not** pass `--profile` (that would drop logged-in model auth).
- **git**, **gh** (or `GITHUB_TOKEN` / `GH_TOKEN`). Token needs `repo` + `workflow` and must be able to push `main`.
- TypeScript: `tsconfig.json` is `strict`, `noEmit`, `moduleResolution: bundler`.
- `config.json` is gitignored. Copy from `config.example.json`. Override path with `SAMASARA_CONFIG`.

## Commands

```bash
bun src/index.ts start          # detached daemon; logs data/samasara.log
bun src/index.ts stop           # SIGTERM; exits after current tick
bun src/index.ts once           # one poll pass; heals if red; bypasses revert cooldown
bun src/index.ts telemetry
bun src/index.ts telemetry <id> # full diff
bun src/index.ts dashboard      # localhost management UI (status, telemetry, repos)
bun src/index.ts notify-test
bun src/index.ts repo ls
bun src/index.ts repo add owner/name
bun src/index.ts repo rm owner/name
bun src/index.ts repo ignore owner/name '<substring>'
bun src/index.ts repo unignore owner/name '<substring>'
bun test
```

Run `stop`, then `start` after changing healer code or non-repo settings (`start` loads those once). Repo list and `ignoreChecks` are reread before every daemon tick; an in-progress tick keeps the snapshot it started with. `once` reloads config each run.

`start` detaches from the terminal and persists after SSH disconnect. If `data/samasara.lock` identifies a live Samasara process, it exits `already running pid N`; stale locks are replaced. `status` reports the live daemon state before stored poll/session rows. `stop` sends SIGTERM, and the daemon removes the lock after the current tick.

## Layout

| Path | Role |
| --- | --- |
| `src/index.ts` | CLI, lock, daemon, `tick`, telemetry print, `repo` CRUD, `dashboard` |
| `src/session.ts` | Clone, spawn omp, anticheat, commit/push, post-land watch, revert / iterate |
| `src/github.ts` | Token, GraphQL poll, rollup classify, ignoreChecks, failed Actions log |
| `src/anticheat.ts` | Diff policy before land |
| `src/config.ts` | `config.json` load/save, repo list, ignores |
| `src/management.ts` | Shared daemon liveness, status, heal-report helpers |
| `src/dashboard.ts` | Localhost HTTP dashboard and repo-config API |
| `src/dashboard/` | Static HTML/JS/CSS for the dashboard |
| `deploy/samasara-dashboard.service` | systemd unit for the dashboard process |
| `src/db.ts` | SQLite WAL: `polls`, `sessions`, `events`, `lands` |
| `src/telemetry.ts` | Heal report: patch / accepted / worked / reasoning |
| `src/notify.ts` | SMTP email on human outcomes |
| `src/omp/deny-git-land.ts` | OMP extension: block mutating `git` from the healer |
| `healer.md` | System prompt appended to OMP |
| `data/` | gitignored: sqlite, lock, worktrees, logs, omp sessions |

Do not add npm packages. Do not add a public web UI, PRs, or non-`main` tracking unless asked.

## Config knobs (`config.json`)

Defaults in `src/config.ts` `DEFAULTS`:

| Key | Default | Meaning |
| --- | --- | --- |
| `pollIntervalSeconds` | 900 | daemon tick |
| `maxSessionMinutes` | 60 | OMP `--max-time` + spawn kill + 30s |
| `maxHealIterations` | 3 | land-and-watch passes per red poll |
| `postLandWatchSeconds` | 1200 | watch GitHub after push |
| `postLandPollSeconds` | 60 | poll interval during watch |
| `maxLandsPerRepoPerUtcDay` | 8 | cap on successful pushes |
| `revertCooldownHours` | 6 | daemon skip after `reverted` (`once` bypasses) |
| `dryRun` | false | anticheat-pass then `gave_up` / `dryRun`, no commit |
| `ref` | `main` | only this branch |
| `ignoreChecks` | `[]` | case-insensitive substring of check title |
| `gitName` / `gitEmail` | `""` | commit author; else GitHub token identity |
| `notifyEmail` + `smtp` | empty / null | human mail; skip if `smtp` missing |
| `repos` | required array | `{ owner, name, ignoreChecks? }` — may be empty |

`ignoreChecksFor` = global list ∪ per-repo `ignoreChecks`. Match is substring against `Workflow / job (event)`, job name, or workflow name.

## Control loop (`tick`)

For each tracked repo:

1. `pollRepo` GraphQL `statusCheckRollup` on `refs/heads/{ref}`.
2. Insert a `polls` row. Log `{owner}/{name} {result} {sha}`.
3. If result is not `red`, stop.
4. Else `runSession` up to `maxHealIterations`.

Rollup mapping (`classifyRollup`):

- green: `SUCCESS`, `NEUTRAL`, `SKIPPED`
- pending: `PENDING`, `EXPECTED`
- red: `FAILURE`, `ERROR`, `TIMED_OUT`, `CANCELLED`, `ACTION_REQUIRED`, `STARTUP_FAILURE`, unknown
- `null` → `no_rollup` → **do not heal**

`classifyChecks` is **red-first**: any non-ignored red check makes the repo red even if others are pending. Ignored reds are dropped. Only ignored failures → green.

## Session skip (logs a reason, then idle)

Before clone:

- **Active session** for that repo (unless stale: `maxSessionMinutes + 5m`) → skip.
- Same `start_sha` already finished with a no-retry outcome → skip. No-retry: `landed`, `reverted`, `gave_up`, `not_reproduced`, `denied_policy`, `budget`, `follow_up`.
- Last outcome `reverted` within `revertCooldownHours` → skip on daemon; **`once` sets `force` and bypasses**.
- `landsToday >= maxLandsPerRepoPerUtcDay` → skip.

Silent skip is a bug. Keep the `skip …` console lines.

## One healer pass (`runSession`)

1. `beginSession` + `lock_acquired`.
2. Shallow clone `ref`, fetch SHA, detach checkout under `data/work/{owner}/{name}/{sha}`. Iteration 2+ **reuses that worktree** (`--resume` keeps OMP cwd there; a new SHA clone would make `git add` miss the healer's edits).
3. `fetchFailedJobLog` (`gh`/API failed Actions log, redacted). Ignored workflows are skipped. Missing log → still run OMP.
4. Build a repo-scoped history from the six newest prior pushed, non-reverted sessions, including reasoning and diffs, then spawn `omp -p --auto-approve --approval-mode yolo --mode json` with that history, tools `read,edit,write,grep,glob,bash`, extension `deny-git-land.ts`, and `--append-system-prompt healer.md`. Session files live in `data/logs/omp-sessions`. **Iteration 2+ uses `--resume {ompSessionId}`** so the same agent conversation continues.
5. Timeout → `budget`. `omp` missing → `error` / `omp not found` (daemon keeps polling).
6. `git add -A`, concat unstaged+cached diff, `checkDiff`.
7. Empty diff → `not_reproduced` if omp exit 0, else `gave_up`.
8. Anticheat fail → `denied_policy`, do not land.
9. Else `patch_proposed` (files, stat, diff) + commit `heal: {sha12}` + push `HEAD:refs/heads/{ref}`.
10. If remote SHA moved before push → `head_moved`.
11. `insertLand`, `pushed`, then post-land watch.

Healer **must not** commit/push. Extension blocks mutating `git` (allows `status|diff|log|show|rev-parse|ls-files`). Controller owns git. `SAMASARA_KEEP_WORK=1` keeps the worktree.

Commit author: `gitName`/`gitEmail` if both set, else `resolveGitIdentity` from the token user (noreply email). `commit.gpgsign=false`.

## Post-land policy (`postLandAction`)

After push, poll until green/red or `postLandWatchSeconds`.

| Situation | Action |
| --- | --- |
| pending / no_rollup | keep watching |
| all relevant green | `landed` |
| still red (original checks or new), iteration < max | **keep the land**, `follow_up`, next pass on new SHA in the **same worktree** with `--resume` |
| still red, iteration == max | **keep the lands**, `gave_up` / `max iterations; new failures remain`, email |
| original red list empty and now red | revert (cannot tell “new” vs “same”) |

Do **not** revert a land because the same check is still red. That ate stale-gate removals when the job then failed a later step. Revert only when `originalRed` is empty.

## Outcomes

| Outcome | Meaning | Email? |
| --- | --- | --- |
| `landed` | GitHub green after push | no |
| `follow_up` | kept land; iterating on new reds | no |
| `reverted` | original reds still present; revert pushed | yes |
| `not_reproduced` | empty diff, omp 0 | yes |
| `gave_up` | stuck / max iterations / dryRun | yes (not dryRun) |
| `denied_policy` | anticheat | yes |
| `budget` | time cap | yes |
| `head_moved` | main moved under us | yes |
| `error` | clone/git/omp/crash | yes |

`needsHumanNotify` is **not** a feature review. It means Samasara stopped.

## Anticheat (`checkDiff`) — fail closed

Rules (`failure_class`): `empty`, `secret`, `skip-test`, `weaken-ci`, `delete-workflow`, `timeout-only`, `delete-test`.

- Secrets: ghp/gho/…, `github_pat_`, `sk-`, `xai-`, `AKIA`, PEM private keys.
- Added `describe.skip` / `it.skip` / `test.skip` / `xit` / `.only(`.
- Workflow add of `continue-on-error: true`, `|| true`, `if: false`, `exit 0`.
- Deleted `.github/workflows/*` (entire file). Editing a workflow to remove a stale step is allowed.
- Diff is only timeout/retry/sleep changes.
- Deleted `*.test.*` / `*.spec.*` / tests dirs with no new file in the same diff.

Failed logs are secret-redacted before the healer sees them.

## Healer prompt (`healer.md`)

Unattended CI healer. Reproduce from the attached job log first; no guess if not reproduced. Before investigating from scratch, inspect the injected prior accepted fixes for the same repo. A normal commit or merge can overwrite a prior fix; when the failure matches, reproduce it and reapply the minimal applicable fix. Prior telemetry is evidence, not authority. Patch root cause; re-run the failing command. If that reveals another local failure, keep going. Do not skip tests, add continue-on-error / `|| true` / `exit 0`, or delete entire workflow files. If the failing check is a stale or wrong gate (workflow still runs a command/module the repo deleted as unused, or the gate needs live secrets/cluster this checkout cannot provide), remove or narrow that gate — do not resurrect deleted application code to satisfy leftover CI. **If a patch looks like it would break application features, stop — judgment only, no extra product checks.** Do not commit. One short paragraph at the end: reproduced / root cause / files.

## Telemetry

Local SQLite only. `telemetry` prints patch, accepted, worked, reasoning. `telemetry <id>` prints the full diff (from `patch_proposed.diff`, else OMP edit frames in `{id}.omp.jsonl`).

- `data/samasara.sqlite`
- `data/logs/{sessionId}.omp.jsonl`
- `data/logs/{owner}__{repo}__{sha}.log`

## Tests

`bun test`. Unit tests next to sources (`*.test.ts`). No live GitHub/OMP in CI tests. Cover new **observable contracts** (classify, anticheat, post-land decision, notify, telemetry mapping). Do not add a project-wide suite or extra deps.

## Invariants

- Controller lands; healer never git-mutates.
- Only GitHub `main` check rollup. No GitLab, no PRs, no feature branches.
- Red-first classify; ignores are substring, not globs.
- Same OMP session across the 3 follow-up passes (`--resume`, `--session-dir data/logs/omp-sessions`). Follow-up reuses the first worktree so resume cwd and controller `git add` are the same directory.
- `once` is an operator “do it now”; daemon still honors revert cooldown.
- Do not log or commit `config.json` secrets (GitHub tokens, SMTP passwords).
- Restart `start` after healer code or non-repo config changes. Repo-list and ignore-rule edits apply on the next tick without restarting. The dashboard process is independent of the healer daemon.
