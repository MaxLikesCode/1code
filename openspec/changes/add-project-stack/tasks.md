# Tasks: Add Project Stack

## 1. Database Schema
- [ ] 1.1 Add `stack_services` table to Drizzle schema (`src/main/lib/db/schema/index.ts`)
- [ ] 1.2 Add relations (project → services)
- [ ] 1.3 Generate and test migration (`bun run db:generate`)
- [ ] 1.4 Export types (`StackService`, `NewStackService`)

## 2. Auto-Detection Engine
- [ ] 2.1 Create `src/main/lib/stack/auto-detect.ts` with project scanner
- [ ] 2.2 Implement `package.json` scanner (scripts + package manager detection) — migrate logic from `tasksRouter.getScripts`
- [ ] 2.3 Implement `docker-compose.yml` scanner (parse YAML, extract services + depends_on)
- [ ] 2.4 Implement `turbo.json` / monorepo workspace scanner
- [ ] 2.5 Implement `Makefile` target scanner (dev/run/serve/start)
- [ ] 2.6 Implement `Procfile` parser
- [ ] 2.7 Merge results from all scanners into unified service list

## 3. Dependency Resolution
- [ ] 3.1 Create `src/main/lib/stack/orchestrator.ts`
- [ ] 3.2 Implement topological sort (Kahn's algorithm) with cycle detection
- [ ] 3.3 Implement start sequence: parallel start of independent services, wait for health/delay, unblock dependents
- [ ] 3.4 Implement stop sequence: reverse topological order with graceful shutdown (SIGINT → SIGTERM → SIGKILL)

## 4. Process Management
- [ ] 4.1 Create `src/main/lib/stack/process-manager.ts`
- [ ] 4.2 Implement service spawn via node-pty (reuse patterns from terminal router)
- [ ] 4.3 Implement log ring buffer (5000 lines per service)
- [ ] 4.4 Implement status tracking (stopped → starting → running → error → stopping)
- [ ] 4.5 Create `src/main/lib/stack/health-check.ts` — poll health check command every 2s, timeout after 60s
- [ ] 4.6 Implement port conflict detection (`net.createServer` bind test)
- [ ] 4.7 Handle stale process cleanup on app startup

## 5. tRPC Router
- [ ] 5.1 Create `src/main/lib/trpc/routers/stack.ts` with queries: `getServices`, `getStatus`, `autoDetect`
- [ ] 5.2 Add mutations: `saveServices`, `startAll`, `stopAll`, `startService`, `stopService`, `restartService`
- [ ] 5.3 Add subscriptions: `onStatusChange`, `onLog`
- [ ] 5.4 Register router in `src/main/lib/trpc/routers/index.ts`
- [ ] 5.5 Remove or deprecate `tasksRouter` (migrate package.json logic to auto-detect)

## 6. UI: Stack Widget
- [ ] 6.1 Update widget registry: rename `"tasks"` → `"stack"` in atoms, update icon/label
- [ ] 6.2 Create `src/renderer/features/details-sidebar/sections/stack-widget.tsx`
- [ ] 6.3 Implement compact view: service list with status indicators (colored dots), port numbers, Start/Stop/Restart buttons per service
- [ ] 6.4 Implement "Start All" / "Stop All" header actions
- [ ] 6.5 Implement inline log viewer (expandable per service, reuse Terminal component)
- [ ] 6.6 Implement expanded view (full sidebar): log viewer with search, service config editor, add/remove services, re-detect button
- [ ] 6.7 Wire up tRPC queries/mutations/subscriptions
- [ ] 6.8 Handle status transitions with animations (dot color changes)

## 7. Integration & Cleanup
- [ ] 7.1 Update `details-sidebar.tsx` to render StackWidget instead of TasksWidget
- [ ] 7.2 Migrate widget visibility/order preferences from "tasks" to "stack"
- [ ] 7.3 Remove old `tasks-widget.tsx`, `tasks-section.tsx`, and `task-runner.ts`
- [ ] 7.4 Update CLAUDE.md architecture docs if needed
