## Context
The app manages local project folders. Users need to start multiple services (DB, API, frontend) to work on a project. Currently the Tasks widget just lists `package.json` scripts and lets you run them individually, with no concept of dependencies, health, or orchestration.

We're building a "Stack" system that understands a project's runtime topology and can start/stop everything in the right order.

## Goals / Non-Goals

**Goals:**
- One-click "Start All" that boots services in dependency order
- Auto-detect services from common project files
- Show real-time status and logs per service
- Graceful shutdown in reverse dependency order
- Port conflict detection before starting
- Persist stack config per project in DB

**Non-Goals:**
- Remote/cloud deployment (this is local dev only)
- Container building (we invoke docker-compose, not build images)
- Full PM2/supervisor replacement (no daemonization, auto-restart policies)
- Editing Dockerfiles or compose files from the UI

## Decisions

### Data Model
Store services in SQLite per project. Each service has:
```
stack_services:
  id            TEXT PRIMARY KEY
  project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE
  name          TEXT NOT NULL
  command       TEXT NOT NULL
  cwd           TEXT           -- relative to project root, defaults to "."
  env           TEXT           -- JSON object of env vars (optional)
  depends_on    TEXT           -- JSON array of service names (optional)
  health_check  TEXT           -- shell command to check readiness (optional)
  port          INTEGER        -- expected port, for conflict detection (optional)
  sort_order    INTEGER        -- display order
  source        TEXT           -- "auto" | "manual" — how it was created
  auto_source   TEXT           -- e.g. "docker-compose.yml", "package.json:dev"
  created_at    INTEGER
  updated_at    INTEGER
```

**Why DB over config file?** DB is simpler for the app to query and update. Config file export (`.1code/stack.yml`) is a future opt-in feature for team sharing.

### Auto-Detection Strategy
On project open or manual refresh, scan the project root:

1. **docker-compose.yml / docker-compose.yaml** → parse YAML, create one service per `services:` entry. Command: `docker compose up <service-name>`. Dependencies extracted from `depends_on`.
2. **package.json** → if `scripts.dev` exists, create a "Dev Server" service. Detect package manager from lockfile (bun/pnpm/yarn/npm). If monorepo root detected, scan workspace packages too.
3. **turbo.json** → detect workspace packages with `dev` scripts. Create service per workspace package. Infer dependency order from turbo pipeline config if present.
4. **Makefile** → look for common targets: `run`, `dev`, `serve`, `start`. Create services for found targets.
5. **Procfile** → parse `name: command` format, create service per entry.

Detection is additive — multiple sources combine into one stack. Auto-detected services are marked `source: "auto"` and can be edited/overridden by the user.

### Process Management (Main Process)

```
src/main/lib/stack/
  ├── process-manager.ts    — spawn/kill/signal per service, PTY sessions
  ├── orchestrator.ts       — dependency resolution, start/stop ordering
  ├── auto-detect.ts        — project scanning logic
  └── health-check.ts       — health check polling
```

**Process lifecycle per service:**
1. `spawn()` — creates child process via node-pty (for colored output)
2. Track PID, status (stopped → starting → running → error → stopping)
3. Pipe stdout/stderr to a ring buffer (last N lines) + tRPC subscription for live streaming
4. Health check polling: if `health_check` defined, poll every 2s until success (max 60s timeout)
5. Status transitions: starting → running (health check passes or delay elapsed), starting → error (process exits or health check timeout)

**Graceful shutdown:**
1. Send SIGINT to process
2. Wait up to 5s for exit
3. If still running, send SIGTERM
4. Wait up to 3s
5. SIGKILL as last resort
6. Shutdown order: reverse topological sort of dependency graph

### Dependency Resolution
Simple topological sort (Kahn's algorithm). Circular dependencies are detected and reported as error. Services with no dependencies start in parallel.

**Start sequence:**
1. Sort services topologically
2. Start all services with no unresolved dependencies (in parallel)
3. For each started service, wait for health check or configurable delay (default: 2s)
4. When a service becomes "running", unblock its dependents
5. Continue until all services are started or an error occurs

**Error handling:** If a service fails to start, mark it as "error", skip its dependents (mark them as "blocked"), continue starting other independent services.

### Port Conflict Detection
Before starting a service with a defined `port`:
1. Check if port is already in use (`net.createServer` bind test)
2. If occupied, set service status to "port_conflict" and surface in UI
3. Don't block other services from starting

### tRPC Router: `stackRouter`

```typescript
// Queries
stack.getServices({ projectId })          → Service[]
stack.getStatus({ projectId })            → { serviceId: status }[]
stack.autoDetect({ projectPath })         → DetectedService[]

// Mutations
stack.saveServices({ projectId, services }) → void
stack.startAll({ projectId })             → void
stack.stopAll({ projectId })              → void
stack.startService({ projectId, serviceId }) → void
stack.stopService({ projectId, serviceId }) → void
stack.restartService({ projectId, serviceId }) → void

// Subscriptions
stack.onStatusChange({ projectId })       → { serviceId, status, port? }
stack.onLog({ projectId, serviceId })     → { line, timestamp }
```

### UI: Stack Widget

Replaces the current Tasks widget in the details sidebar. Widget ID changes from `"tasks"` to `"stack"`.

**Compact view (in sidebar):**
```
┌─────────────────────────────────────┐
│ ⚡ Stack        [▶ Start All] [■ Stop] │
├─────────────────────────────────────┤
│ 🟢 postgres     :5432               │
│ 🟢 api          :3001      [■] [↻]  │
│ 🟡 web          :3000   starting...  │
│ ⚫ worker                  [▶]       │
├─────────────────────────────────────┤
│ > Logs: api                          │
│ [info] Server listening on :3001     │
└─────────────────────────────────────┘
```

**Expanded view (in sidebar panel):**
- Full log viewer per service (scrollable, search)
- Service configuration editor (name, command, cwd, deps, health check, port)
- Add/remove services
- Re-detect button

**Status colors:**
- Gray (⚫) = stopped
- Yellow (🟡) = starting
- Green (🟢) = running
- Red (🔴) = error
- Orange (🟠) = port conflict

### Migration from Tasks Widget
- Rename widget ID `"tasks"` → `"stack"` in `WIDGET_REGISTRY`
- Migrate existing widget visibility/order preferences
- The existing `tasksRouter` getScripts logic moves into auto-detect (it's essentially the package.json scanner)
- Terminal integration pattern (spawn + attach) is reused from current TasksWidget

## Risks / Trade-offs

- **PTY overhead**: each service is a PTY session. For projects with many services (10+), this could use significant memory. Mitigation: ring buffer for logs (cap at 5000 lines per service), lazy PTY creation.
- **Auto-detection accuracy**: parsing docker-compose.yml and turbo.json has edge cases. Mitigation: always let user edit/override detected config; mark auto-detected services clearly.
- **Cross-platform**: node-pty behavior differs on Windows. Mitigation: already used in Terminal widget, so existing patterns apply.
- **Stale processes**: if app crashes, child processes may become orphans. Mitigation: on app start, check for stale PIDs and offer cleanup.

## Open Questions
- Should stack config be per-project or per-chat (workspace)? Recommendation: **per-project**, since the stack is a property of the project, not the chat session.
- Should we support `.env` file selection per service? (e.g. service A uses `.env.local`, service B uses `.env.test`) — defer to future iteration.
- Should auto-detect run on project open automatically, or only on first setup? Recommendation: auto on first open, then manual refresh.
