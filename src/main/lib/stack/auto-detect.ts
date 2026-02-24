import fs from "node:fs"
import path from "node:path"

export interface DetectedService {
	name: string
	command: string
	cwd?: string // relative to project root
	dependsOn?: string[]
	port?: number
	autoSource: string // e.g. "docker-compose.yml", "package.json:dev"
}

// ─── Package Manager Detection ───────────────────────────────────────────────

export function detectPackageManager(projectPath: string): string {
	if (
		fs.existsSync(path.join(projectPath, "bun.lockb")) ||
		fs.existsSync(path.join(projectPath, "bun.lock"))
	)
		return "bun"
	if (fs.existsSync(path.join(projectPath, "pnpm-lock.yaml"))) return "pnpm"
	if (fs.existsSync(path.join(projectPath, "yarn.lock"))) return "yarn"
	return "npm"
}

// ─── Package.json Scanner ────────────────────────────────────────────────────

function scanPackageJson(projectPath: string): DetectedService[] {
	const pkgPath = path.join(projectPath, "package.json")
	if (!fs.existsSync(pkgPath)) return []

	try {
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
		const scripts = pkg.scripts || {}
		const pm = detectPackageManager(projectPath)
		const services: DetectedService[] = []

		// Prioritize common dev scripts
		const devScripts = ["dev", "start", "serve"]
		for (const name of devScripts) {
			if (scripts[name]) {
				services.push({
					name: name === "dev" ? "dev" : name,
					command: `${pm} run ${name}`,
					autoSource: `package.json:${name}`,
				})
			}
		}

		return services
	} catch {
		return []
	}
}

// ─── Docker Compose Scanner ──────────────────────────────────────────────────

function scanDockerCompose(projectPath: string): DetectedService[] {
	const composeFiles = [
		"docker-compose.yml",
		"docker-compose.yaml",
		"compose.yml",
		"compose.yaml",
	]

	let composePath: string | null = null
	let composeFilename: string | null = null
	for (const f of composeFiles) {
		const p = path.join(projectPath, f)
		if (fs.existsSync(p)) {
			composePath = p
			composeFilename = f
			break
		}
	}

	if (!composePath || !composeFilename) return []

	try {
		const content = fs.readFileSync(composePath, "utf-8")
		const services: DetectedService[] = []

		// Simple YAML parser for docker-compose — extract service names and depends_on
		// We don't want a full YAML dependency, so we do basic line-level parsing
		const lines = content.split("\n")
		let currentTopLevel: string | null = null
		let currentService: string | null = null
		let inDependsOn = false
		const serviceMap = new Map<
			string,
			{ dependsOn: string[]; ports: number[] }
		>()

		for (const rawLine of lines) {
			const line = rawLine.replace(/\r$/, "")

			// Top-level key (no indentation)
			if (/^[a-zA-Z]/.test(line) && line.includes(":")) {
				currentTopLevel = line.split(":")[0].trim()
				currentService = null
				inDependsOn = false
				continue
			}

			if (currentTopLevel !== "services") continue

			// Service name (2-space indent, no further indent)
			const serviceMatch = line.match(/^  ([a-zA-Z0-9_-]+)\s*:/)
			if (serviceMatch) {
				currentService = serviceMatch[1]
				inDependsOn = false
				if (!serviceMap.has(currentService)) {
					serviceMap.set(currentService, { dependsOn: [], ports: [] })
				}
				continue
			}

			if (!currentService) continue
			const svc = serviceMap.get(currentService)!

			// depends_on start
			if (/^\s{4}depends_on\s*:/.test(line)) {
				inDependsOn = true
				continue
			}

			// depends_on items (list form)
			if (inDependsOn && /^\s{6}- /.test(line)) {
				const dep = line.replace(/^\s{6}- /, "").trim().replace(/:$/, "")
				if (dep) svc.dependsOn.push(dep)
				continue
			}

			// depends_on items (map form, e.g. "      service_name:")
			if (inDependsOn && /^\s{6}[a-zA-Z]/.test(line)) {
				const dep = line.trim().replace(/:.*$/, "")
				if (dep) svc.dependsOn.push(dep)
				continue
			}

			// Any other 4-space indent key ends depends_on
			if (inDependsOn && /^\s{4}[a-zA-Z]/.test(line)) {
				inDependsOn = false
			}

			// ports
			if (/^\s{6}- ["']?(\d+):(\d+)/.test(line)) {
				const portMatch = line.match(/(\d+):(\d+)/)
				if (portMatch) svc.ports.push(parseInt(portMatch[1], 10))
			}
		}

		for (const [name, data] of serviceMap) {
			services.push({
				name,
				command: `docker compose up ${name}`,
				dependsOn: data.dependsOn.length > 0 ? data.dependsOn : undefined,
				port: data.ports[0],
				autoSource: composeFilename,
			})
		}

		return services
	} catch {
		return []
	}
}

// ─── Procfile Scanner ────────────────────────────────────────────────────────

function scanProcfile(projectPath: string): DetectedService[] {
	const procPath = path.join(projectPath, "Procfile")
	if (!fs.existsSync(procPath)) return []

	try {
		const content = fs.readFileSync(procPath, "utf-8")
		const services: DetectedService[] = []

		for (const line of content.split("\n")) {
			const match = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.+)$/)
			if (match) {
				services.push({
					name: match[1],
					command: match[2].trim(),
					autoSource: "Procfile",
				})
			}
		}

		return services
	} catch {
		return []
	}
}

// ─── Makefile Scanner ────────────────────────────────────────────────────────

function scanMakefile(projectPath: string): DetectedService[] {
	const makefilePath = path.join(projectPath, "Makefile")
	if (!fs.existsSync(makefilePath)) return []

	try {
		const content = fs.readFileSync(makefilePath, "utf-8")
		const services: DetectedService[] = []
		const targets = ["dev", "run", "serve", "start"]

		for (const line of content.split("\n")) {
			const match = line.match(/^([a-zA-Z0-9_-]+)\s*:/)
			if (match && targets.includes(match[1])) {
				services.push({
					name: match[1],
					command: `make ${match[1]}`,
					autoSource: `Makefile:${match[1]}`,
				})
			}
		}

		return services
	} catch {
		return []
	}
}

// ─── Turbo/Monorepo Scanner ──────────────────────────────────────────────────

function scanMonorepo(projectPath: string): DetectedService[] {
	const turboPath = path.join(projectPath, "turbo.json")
	if (!fs.existsSync(turboPath)) return []

	// Find workspace packages
	const pkgPath = path.join(projectPath, "package.json")
	if (!fs.existsSync(pkgPath)) return []

	try {
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
		const workspaceGlobs: string[] = pkg.workspaces || []
		if (workspaceGlobs.length === 0) return []

		const pm = detectPackageManager(projectPath)
		const services: DetectedService[] = []

		for (const glob of workspaceGlobs) {
			// Simple glob expansion: "packages/*" → list directories
			const baseDir = glob.replace(/\/?\*$/, "")
			const fullBase = path.join(projectPath, baseDir)
			if (!fs.existsSync(fullBase) || !fs.statSync(fullBase).isDirectory())
				continue

			const entries = fs.readdirSync(fullBase, { withFileTypes: true })
			for (const entry of entries) {
				if (!entry.isDirectory()) continue

				const wsPkgPath = path.join(fullBase, entry.name, "package.json")
				if (!fs.existsSync(wsPkgPath)) continue

				try {
					const wsPkg = JSON.parse(fs.readFileSync(wsPkgPath, "utf-8"))
					if (wsPkg.scripts?.dev) {
						services.push({
							name: wsPkg.name || entry.name,
							command: `${pm} run dev`,
							cwd: path.join(baseDir, entry.name),
							autoSource: `turbo.json:${baseDir}/${entry.name}`,
						})
					}
				} catch {
					// Skip malformed package.json in workspace
				}
			}
		}

		return services
	} catch {
		return []
	}
}

// ─── Main Auto-Detect Function ───────────────────────────────────────────────

export function autoDetectServices(projectPath: string): DetectedService[] {
	const allServices: DetectedService[] = []
	const seenNames = new Set<string>()

	// Run scanners in priority order
	const scanners = [
		scanDockerCompose,
		scanPackageJson,
		scanMonorepo,
		scanProcfile,
		scanMakefile,
	]

	for (const scanner of scanners) {
		const detected = scanner(projectPath)
		for (const svc of detected) {
			// Deduplicate by name (first scanner wins)
			if (!seenNames.has(svc.name)) {
				seenNames.add(svc.name)
				allServices.push(svc)
			}
		}
	}

	return allServices
}
