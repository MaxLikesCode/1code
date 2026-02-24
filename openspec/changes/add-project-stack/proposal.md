# Change: Add Project Stack — Orchestrated Service Launcher

## Why
Working on a project typically requires starting multiple processes (database, API server, frontend dev server, etc.) in the right order. Today this means opening multiple terminals and running commands manually — unnecessary friction that breaks flow. The app should understand a project's runtime dependencies and offer one-click orchestration.

## What Changes
- New "Stack" concept: a project has a set of **Services** that can be started together with dependency ordering
- **Auto-detection** of services from project files (`docker-compose.yml`, `package.json` scripts, `turbo.json` workspaces, `Makefile`, `Procfile`)
- **Dependency-aware orchestration**: topological sort of service graph, optional health checks, graceful shutdown in reverse order
- **Replaces current Tasks widget** with a richer Stack widget that shows service status (stopped/starting/running/error), logs, and one-click Start All / Stop All
- **Stack config persisted per project** in the app DB, optionally exportable as `.1code/stack.yml`
- **Port conflict detection** before starting services
- **Process management** in main process using `child_process.spawn` with PTY support for colored output
- **Log streaming** via tRPC subscription to renderer

## Impact
- Affected specs: new `project-stack` capability
- Affected code:
  - `src/main/lib/db/schema/index.ts` — new `stack_services` table
  - `src/main/lib/trpc/routers/tasks.ts` → renamed/replaced with `stack.ts`
  - `src/main/lib/stack/` — new process manager, auto-detector, dependency resolver
  - `src/renderer/features/details-sidebar/sections/tasks-widget.tsx` → replaced with `stack-widget.tsx`
  - `src/renderer/features/details-sidebar/atoms/index.ts` — add "stack" widget ID
