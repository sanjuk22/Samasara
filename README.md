# Samasara

Local Bun daemon that polls GitHub `main` on tracked repos. When the check rollup is red, it runs an OMP healer (up to 3 times), then commits and pushes to `main` (no PRs). A land that fixes the original reds is kept if a new check goes red; the healer is invoked again on that new failure. Revert only if the original failing checks are still red. Always-red checks can be ignored. Heal commits use `gitName` / `gitEmail` in `config.json` (GitHub attributes the commit to the account that owns that email). Status, telemetry, and repository tracking are also available on the private Tailscale dashboard.

Needs `bun`, `git`, `gh` (or `GITHUB_TOKEN` / `GH_TOKEN`), and a logged-in `omp`. The token must be able to push `main`.

```bash
cp config.example.json config.json
```

`config.json` is gitignored.

## Tracked repositories

```bash
bun src/index.ts repo ls
bun src/index.ts repo add owner/name
bun src/index.ts repo rm owner/name
bun src/index.ts repo ignore owner/name 'CI-BlackDuck-SCA-Basic / build (push)'
bun src/index.ts repo unignore owner/name 'CI-BlackDuck-SCA-Basic / build (push)'
```

`repo add` creates `config.json` from the example if it is missing. Per-repo `ignore` is a case-insensitive substring of the GitHub check title (workflow, job, or `Workflow / job (event)`). Global ignores live in `config.json` as `ignoreChecks`.

Repo-list and ignore-rule changes from the CLI or dashboard apply on the **next daemon tick**. A poll already in progress keeps the snapshot it started with. Restart `start` after changing healer code or other non-repo settings; `once` reads config each run.

## Run

```bash
bun src/index.ts start
bun src/index.ts status
bun src/index.ts stop
bun src/index.ts once
```

`start` launches the daemon in the background, detached from the SSH session. It polls every `pollIntervalSeconds` (default 15m), single-flight, with an exclusive `data/samasara.lock`; output is appended to `data/samasara.log`. `status` first reports `daemon=running pid=N` or `daemon=stopped`, then prints the latest stored repository state. `stop` sends SIGTERM and lets the current poll finish before the daemon exits. `once` is one foreground poll pass (heal if red).

## Dashboard

The healer daemon and the dashboard are separate processes. The dashboard listens on `127.0.0.1` only. Tailscale Funnel publishes HTTPS on the public internet; the process itself is not bound to a public port.

URL: `https://samasara.tail22214a.ts.net/`

Anyone can open that URL to view status and telemetry. Adding, editing, or removing repositories still requires Tailscale identity `nxu981@gmail.com` (install from https://tailscale.com/download and join this tailnet). Semantic dashboard events are accepted only for that authenticated identity; anonymous views are not recorded. Do not put GitHub or SMTP secrets in the dashboard env file.

```bash
bun src/index.ts dashboard
```

Production unit: `deploy/samasara-dashboard.service` → `samasara-dashboard.service`. Access settings live in `/etc/samasara-dashboard.env` (`SAMASARA_DASHBOARD_ORIGIN`, `SAMASARA_DASHBOARD_USER`). Set `SAMASARA_TELEMETRY_HASH_KEY` there to a stable random value of at least 32 characters; it HMAC-hashes the Tailscale login before telemetry is queued and must remain secret.

## Email

When a session ends in `not_reproduced`, `gave_up`, `denied_policy`, `budget`, `error`, `reverted`, or `head_moved`, Samasara emails `notifyEmail`. Successful `landed` and in-cycle `follow_up` do not.

This VPS has no local MTA. Set `smtp` in `config.json` (gitignored) or notify is skipped:

```json
"notifyEmail": "nathaniel.xu@eeoc.gov",
"smtp": {
  "host": "smtp.example.com",
  "port": 587,
  "user": "USER",
  "password": "PASSWORD",
  "from": "samasara@example.com"
}
```

Port 465 uses SSL; 587 uses STARTTLS. Test with `bun src/index.ts notify-test`.

```bash
bun test
```

## Telemetry

Healer diagnostics remain in local SQLite. `infra/main.bicep` also deploys the shared Azure Log Analytics workspace, direct Data Collection Rule, and `SamasaraEvent_CL` table used by instrumented applications. AI interaction records contain hashes and usage metadata only—never prompts, responses, email addresses, or usernames. Application workloads publish with managed identity to the `Custom-SamasaraEvent` stream; set `deployRoleAssignments=true` with `eventPublisherPrincipalIds` when an Owner or User Access Administrator deploys the template.

Samasara queues one `ai_interaction` after every OMP healer invocation. The record includes the repository, feature, result, latency, model when OMP reports it, input/output/total tokens, OMP conversation id, trace id, service-identity hash, and a SHA-256 hash of the complete healer question. Raw failed-job logs, prompts, and responses are never copied into the monitoring event. Failed deliveries remain in SQLite with exponential retry backoff and are retried at the next daemon tick.

The dashboard records only allowlisted semantic controls—view opens, session selection, refreshes, and successful repository changes—through `feature_clicked` events. It never captures arbitrary DOM clicks, labels, repository names, or form content. Browser events use `sendBeacon` with a keepalive `fetch` fallback; the server validates the allowlist, supplies its own timestamp and trace ID, hashes the authenticated identity, and queues the event in the durable outbox.

Configure the daemon from the Bicep deployment outputs; these values are identifiers, not secrets:

```bash
SAMASARA_ENVIRONMENT=prod
SAMASARA_AZURE_LOGS_ENDPOINT='<logsIngestionEndpoint>'
SAMASARA_AZURE_DCR_ID='<dataCollectionRuleImmutableId>'
SAMASARA_AZURE_MANAGED_IDENTITY_CLIENT_ID='<runtimeIdentityClientId>'
```

The VM must have that user-assigned identity attached. Its DCR `Monitoring Metrics Publisher` role is created when the Bicep deployment uses `deployRoleAssignments=true`.

```bash
bun src/index.ts telemetry
bun src/index.ts telemetry 2
```

`telemetry` lists recent healer sessions as: proposed patch, accepted?, worked?, reasoning. Pass a session id to print the full diff.

| Path | What |
| --- | --- |
| `data/samasara.sqlite` | WAL SQLite: `polls`, `sessions`, `events`, `lands`, durable `monitoring_outbox` |
| `data/logs/*.omp.jsonl` | raw OMP `--mode json` stdout per session |
| `data/logs/*__*.log` | redacted failed Actions logs attached to the healer |
| `bun src/index.ts status` | last poll + last session per tracked repo |
| `bun src/index.ts telemetry` | patch / accepted / worked / reasoning per session |

`polls` is every GitHub rollup sample. `sessions` is each healer attempt (`landed`, `follow_up`, `reverted`, `gave_up`, `head_moved`, `not_reproduced`, `denied_policy`, `budget`, `error`). `events` is the session trace (lock, logs, tools, anticheat, push, post-land). `lands` is successful pushes for the daily cap. `maxSessionMinutes` is 60. `maxHealIterations` is 3. Follow-up heals resume the same OMP session (`--resume`) so the previous patch is in context.
