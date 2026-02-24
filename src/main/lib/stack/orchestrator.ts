/**
 * Dependency-aware orchestration for project stack services.
 * Handles topological sort, start/stop ordering, and health check gating.
 */

export interface ServiceNode {
	name: string
	dependsOn: string[]
}

export class CircularDependencyError extends Error {
	constructor(public cycle: string[]) {
		super(`Circular dependency detected: ${cycle.join(" → ")}`)
		this.name = "CircularDependencyError"
	}
}

/**
 * Topological sort using Kahn's algorithm.
 * Returns service names in start order (dependencies first).
 * Throws CircularDependencyError if a cycle is detected.
 */
export function topologicalSort(services: ServiceNode[]): string[] {
	const nameSet = new Set(services.map((s) => s.name))
	const inDegree = new Map<string, number>()
	const adjacency = new Map<string, string[]>() // dependency → dependents

	for (const svc of services) {
		inDegree.set(svc.name, 0)
		adjacency.set(svc.name, [])
	}

	for (const svc of services) {
		for (const dep of svc.dependsOn) {
			if (!nameSet.has(dep)) continue // Ignore unknown dependencies
			inDegree.set(svc.name, (inDegree.get(svc.name) ?? 0) + 1)
			adjacency.get(dep)!.push(svc.name)
		}
	}

	// Start with nodes that have no dependencies
	const queue: string[] = []
	for (const [name, degree] of inDegree) {
		if (degree === 0) queue.push(name)
	}

	const sorted: string[] = []

	while (queue.length > 0) {
		const node = queue.shift()!
		sorted.push(node)

		for (const dependent of adjacency.get(node) ?? []) {
			const newDegree = (inDegree.get(dependent) ?? 1) - 1
			inDegree.set(dependent, newDegree)
			if (newDegree === 0) queue.push(dependent)
		}
	}

	if (sorted.length !== services.length) {
		// Cycle detected — find which nodes are in the cycle
		const remaining = services
			.filter((s) => !sorted.includes(s.name))
			.map((s) => s.name)
		throw new CircularDependencyError(remaining)
	}

	return sorted
}

/**
 * Get services grouped by start "waves" — services in the same wave can start in parallel.
 * Wave 0 = no dependencies, Wave 1 = depends on Wave 0, etc.
 */
export function getStartWaves(services: ServiceNode[]): string[][] {
	const sorted = topologicalSort(services)
	const nameToNode = new Map(services.map((s) => [s.name, s]))
	const waveOf = new Map<string, number>()

	for (const name of sorted) {
		const node = nameToNode.get(name)!
		const depWaves = node.dependsOn
			.filter((d) => waveOf.has(d))
			.map((d) => waveOf.get(d)!)
		const wave = depWaves.length > 0 ? Math.max(...depWaves) + 1 : 0
		waveOf.set(name, wave)
	}

	const maxWave = Math.max(0, ...waveOf.values())
	const waves: string[][] = []
	for (let w = 0; w <= maxWave; w++) {
		waves.push(
			sorted.filter((name) => waveOf.get(name) === w),
		)
	}

	return waves
}

/**
 * Get services in reverse topological order for graceful shutdown.
 * Dependents stop before their dependencies.
 */
export function getStopOrder(services: ServiceNode[]): string[] {
	return topologicalSort(services).reverse()
}
