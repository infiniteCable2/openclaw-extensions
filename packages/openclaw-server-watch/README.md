# Server Watch

Server Watch divides collection from OpenClaw tool execution. A local Linux
collector samples and stores bounded, structured observations in SQLite. A
local socket worker opens the database read-only and verifies the caller
against the systemd Gateway MainPID with Linux peer credentials. The Gateway
has no database group access. The plugin only registers its tools for the
named monitoring agent and rechecks that binding before each call. The model does
not run shell commands or receive raw journal entries, IP addresses,
credentials or arbitrary filesystem paths.

| Tool | Result |
| --- | --- |
| `server_health` | Monitored systemd and Docker status, expected state and restart counters |
| `server_connections` | Port/scope/family, current established TCP count and a seven-day count series (most recent 24 samples returned) |
| `server_security_events` | Bounded SSH journal counts, current Fail2ban counts and per-hour buckets from the current Fail2ban file |
| `server_tls` | CA/hostname validation and certificate expiry, plus the state and last invocation outcome of configured renewal timers and services |
| `server_resources` | Host CPU/I/O wait, RAM, swap, filesystem usage, GPU utilization/VRAM, and peak CPU/RAM/swap by monitored service or container |
| `server_vulnerabilities` | Locally affected Debian source packages, known fixed versions, running kernel match, CISA KEV prioritization and coverage gaps |
| `server_advisories` | Recent NVD publication timeline, filter by date, CVSS severity, CVE or vendor/product and CISA KEV membership |

## Data sources and coverage

Debian Tracker entries are joined by release, source package and full Debian
version, including epoch, revision and backports. A package name or a generic
CPE alone does not make a host vulnerable. Result timestamps distinguish
local first observation from catalog publication. Debian urgency and NVD CVSS
are separate. A fixed version in the Tracker is not proof that the local APT
configuration offers it. Kernel matching uses the active reported Debian
build, when the corresponding installed package can be identified.

[NVD](https://nvd.nist.gov/developers/vulnerabilities) supplies the recent
publication timeline and CVSS. [CISA KEV](https://github.com/cisagov/kev-data)
supplies known exploitation, with its own addition date. The
[Debian Security Tracker](https://security-tracker.debian.org/tracker/) is the
authority for Debian package fixes. Public feed requests carry time ranges
and public metadata only. Inventory matching and product filtering are local.
The tools report source freshness, coverage and truncation. A failed fetch
preserves the prior successful snapshot and reports the failed latest attempt.

The Debian collector does not infer installed versions inside containers or
package ownership for out-of-tree drivers. It reports those gaps, along with
the loaded NVIDIA driver version when observable. Exact image digests and
a vendor scanner or SBOM are needed for container advisory matching. A
successfully installed package update does not prove every service process
has loaded the new binaries. TLS expiry is observed through a handshake. An
optional `renewalTimer` and `renewalUnit` per endpoint add systemd outcome and
timing. Detailed ACME failure reasons require a source-specific log parser.

## Resource collection

The sample timer runs once a minute. Service and container CPU is expressed as
percent of one core. Raw intervals are used for CPU averaging. The collector
omits CPU deltas after a reboot, service restart or a collection gap. RAM and
swap come from procfs and cgroup v2. Only configured mount points are sampled.
NVIDIA GPU sampling is opt-in and skips devices whose runtime power status
does not report active. Suspended and unavailable are distinct from zero use.
Resource windows are limited to seven days, with coverage reported as the
number of samples. Per-process GPU attribution is outside this version.

## Install and connect the internal agent

Install the package on Linux with Node 24 or later and Python 3. Adapt
`deploy/collector.example.json` to the trusted service inventory.
Install the collector and systemd files from `deploy/`. Give the collector a
root-owned state directory with group `server-watch` and mode `0750`.
Run the socket worker as the dedicated, non-login `server-watch-reader`
account with group `server-watch`. The Gateway connects through the socket
and must not be in that group.
The collector's fixed host probes are the only users of restricted journal
access and the optional Docker socket. Keep the personal agents' host/file
access restricted. A single OpenClaw Gateway with host shell access is not a
strong boundary between mutually untrusted agents.

Merge the relevant fields from `deploy/openclaw.example.json` into the
existing configuration. It restricts cross-agent communication to the two
explicit agent IDs and keeps agent-scoped session visibility. The monitoring
agent has no channel binding. Both agents may send to the other through
`sessions_send`. The personal agent receives results and never receives the
monitoring tools. Keep the existing personal agent's tool allowlist and grant
`sessions_send` there if it is not already available.

Use `deploy/AGENTS.example.md` in the dedicated workspace and provision
the intended peer there. Use the native OpenClaw scheduler with
`deploy/cron.example.json` as the job template to run an agent-turn every day at
`0 20 * * *` in `Europe/Berlin`, with the monitoring agent's fixed internal
session and automatic external delivery disabled. After checking feed
freshness, health, access, TLS and resources, send one concise report to the
designated personal agent using `sessions_send`. Distinguish routine,
attention, critical and unavailable data. Include the time window and
observations that justify each finding. The personal agent uses its existing
authorized private delivery route when the operator has opted into alerts.
For a manual request, send the query to the same fixed monitoring agent and
return the report to the original requester. A fresh agent turn reads the
latest samples; it does not force a new feed download.

Troubleshoot locally with `node --test watch.test.mjs`. Deployment acceptance
requires checking collector permissions and freshness, effective per-agent
tools, a scheduled or manual internal handoff, and the actual private Matrix
destination before configuring proactive delivery.

## Future event triggers

Keep triggers inactive in the initial deployment. Evaluate sustained changes
in established TCP counts or Fail2ban event rate against recent baselines in
a local deterministic worker. A finding can request an internal agent turn
after deduplication and a cooldown. A device event can enter such a workflow
through authenticated ingress with an allowlisted event type and static target.
Device payload text, agent names, session keys and shell command parameters
must not control the run. A generic public agent webhook is unnecessary.
