## ADDED Requirements

### Requirement: Stack Service Definition
The system SHALL allow defining services for a project, where each service has a name, shell command, optional working directory (relative to project root), optional environment variables, optional dependency list (names of other services), optional health check command, and optional port number.

#### Scenario: Service with all fields
- **WHEN** a service is defined with name "api", command "bun run dev", cwd "./apps/api", depends_on ["database"], health_check "curl -f http://localhost:3001/health", port 3001
- **THEN** the service is stored in the database linked to the project

#### Scenario: Minimal service
- **WHEN** a service is defined with only name "dev" and command "npm run dev"
- **THEN** the service is stored with cwd defaulting to project root and no dependencies, health check, or port

### Requirement: Auto-Detection of Services
The system SHALL scan a project's root directory and detect services from common configuration files including docker-compose.yml, package.json, turbo.json (monorepo workspaces), Makefile, and Procfile. Detected services SHALL be marked with source "auto" and the originating file.

#### Scenario: Docker Compose detection
- **WHEN** the project contains a docker-compose.yml with services "postgres" and "redis" where "redis" depends_on "postgres"
- **THEN** the system detects two services with the correct dependency relationship and commands using `docker compose up <name>`

#### Scenario: Package.json script detection
- **WHEN** the project contains a package.json with a "dev" script and a bun.lockb file
- **THEN** the system detects a service named "dev" with command "bun run dev"

#### Scenario: No config files found
- **WHEN** the project contains no recognizable configuration files
- **THEN** the system returns an empty service list and shows a message inviting the user to add services manually

### Requirement: Dependency-Aware Start Orchestration
The system SHALL start services in topological order of their dependency graph. Services with no unresolved dependencies SHALL be started in parallel. A service SHALL only start after all its dependencies have reached "running" status (via health check) or a configurable delay has elapsed.

#### Scenario: Three-service chain
- **WHEN** "Start All" is triggered for services: database (no deps), api (depends on database), web (depends on api)
- **THEN** database starts first, api starts after database is running, web starts after api is running

#### Scenario: Independent services start in parallel
- **WHEN** "Start All" is triggered for services: worker (no deps) and cron (no deps)
- **THEN** both services start simultaneously

#### Scenario: Circular dependency detected
- **WHEN** service A depends on service B and service B depends on service A
- **THEN** the system reports a circular dependency error and does not start the affected services

### Requirement: Graceful Stop Orchestration
The system SHALL stop services in reverse topological order. Each service SHALL receive SIGINT first, then SIGTERM after 5 seconds if still running, then SIGKILL after 3 more seconds.

#### Scenario: Reverse-order shutdown
- **WHEN** "Stop All" is triggered for the chain: database → api → web
- **THEN** web stops first, then api, then database

#### Scenario: Graceful shutdown sequence
- **WHEN** a service is stopped
- **THEN** it receives SIGINT, waits up to 5 seconds, then SIGTERM, waits up to 3 seconds, then SIGKILL if still running

### Requirement: Service Status Tracking
The system SHALL track each service's status as one of: stopped, starting, running, error, stopping, port_conflict. Status changes SHALL be streamed to the renderer in real time via tRPC subscription.

#### Scenario: Successful start with health check
- **WHEN** a service with a health_check starts and the health check command succeeds within 60 seconds
- **THEN** the service transitions from "starting" to "running"

#### Scenario: Health check timeout
- **WHEN** a service's health check does not succeed within 60 seconds
- **THEN** the service transitions to "error" status

#### Scenario: Process crash
- **WHEN** a running service's process exits unexpectedly
- **THEN** the service transitions to "error" status

### Requirement: Port Conflict Detection
The system SHALL check whether a service's declared port is available before starting the service. If the port is occupied, the service status SHALL be set to "port_conflict" without blocking other services.

#### Scenario: Port available
- **WHEN** service "api" with port 3001 is about to start and port 3001 is free
- **THEN** the service starts normally

#### Scenario: Port occupied
- **WHEN** service "api" with port 3001 is about to start and port 3001 is in use
- **THEN** the service is set to "port_conflict" status and other services continue starting

### Requirement: Log Streaming
The system SHALL capture stdout and stderr from each service process and stream them to the renderer via tRPC subscription. Logs SHALL be buffered in a ring buffer of up to 5000 lines per service.

#### Scenario: Live log display
- **WHEN** a service writes to stdout
- **THEN** the output is immediately available to the renderer via the log subscription

#### Scenario: Log buffer overflow
- **WHEN** a service has written more than 5000 lines
- **THEN** the oldest lines are discarded and only the most recent 5000 lines are retained

### Requirement: Stack Widget UI
The system SHALL display a Stack widget in the details sidebar showing all services with their status (colored indicator), port, and action buttons (start/stop/restart). A "Start All" and "Stop All" button SHALL be available in the widget header. Clicking a service SHALL expand an inline log viewer.

#### Scenario: Widget displays services
- **WHEN** the Stack widget is visible and the project has 3 configured services
- **THEN** all 3 services are listed with their current status indicator and name

#### Scenario: Start All button
- **WHEN** the user clicks "Start All"
- **THEN** all services begin starting in dependency order

#### Scenario: Inline log viewer
- **WHEN** the user clicks on a running service
- **THEN** a terminal panel expands below the service showing live log output

### Requirement: Stack Configuration Persistence
The system SHALL persist stack service configurations in the SQLite database per project. Auto-detected services SHALL be distinguishable from manually added services.

#### Scenario: Services survive app restart
- **WHEN** the user configures services and restarts the app
- **THEN** the service configuration is restored from the database

#### Scenario: Re-detection merges with manual config
- **WHEN** the user has manually added services and triggers re-detection
- **THEN** new auto-detected services are added, existing auto-detected services are updated, and manually added services are preserved
