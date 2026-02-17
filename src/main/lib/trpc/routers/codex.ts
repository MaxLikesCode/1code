import { createACPProvider, type ACPProvider } from "@mcpc-tech/acp-ai-provider"
import { observable } from "@trpc/server/observable"
import { streamText } from "ai"
import { eq } from "drizzle-orm"
import { app } from "electron"
import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { dirname, join, sep } from "node:path"
import { z } from "zod"
import { getDatabase, subChats } from "../../db"
import { publicProcedure, router } from "../index"

const imageAttachmentSchema = z.object({
  base64Data: z.string(),
  mediaType: z.string(),
  filename: z.string().optional(),
})

type CodexProviderSession = {
  provider: ACPProvider
  cwd: string
  authFingerprint: string | null
}

type CodexLoginSessionState =
  | "running"
  | "success"
  | "error"
  | "cancelled"

type CodexLoginSession = {
  id: string
  process: ChildProcess | null
  state: CodexLoginSessionState
  output: string
  url: string | null
  error: string | null
  exitCode: number | null
}

type CodexIntegrationState =
  | "connected_chatgpt"
  | "connected_api_key"
  | "not_logged_in"
  | "unknown"

const providerSessions = new Map<string, CodexProviderSession>()
type ActiveCodexStream = {
  runId: string
  controller: AbortController
}

const activeStreams = new Map<string, ActiveCodexStream>()
const loginSessions = new Map<string, CodexLoginSession>()

const URL_CANDIDATE_REGEX = /https?:\/\/[^\s]+/g
const ANSI_ESCAPE_REGEX = /\u001B\[[0-?]*[ -/]*[@-~]/g
const ANSI_OSC_REGEX = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g

const AUTH_HINTS = [
  "not logged in",
  "authentication required",
  "auth required",
  "login required",
  "missing credentials",
  "no credentials",
  "unauthorized",
  "forbidden",
  "codex login",
  "401",
  "403",
]
const DEFAULT_CODEX_MODEL = "gpt-5.3-codex/high"

function getCodexPackageName(): string {
  const platform = process.platform
  const arch = process.arch

  if (platform === "darwin") {
    if (arch === "arm64") return "@zed-industries/codex-acp-darwin-arm64"
    if (arch === "x64") return "@zed-industries/codex-acp-darwin-x64"
  }

  if (platform === "linux") {
    if (arch === "arm64") return "@zed-industries/codex-acp-linux-arm64"
    if (arch === "x64") return "@zed-industries/codex-acp-linux-x64"
  }

  if (platform === "win32") {
    if (arch === "arm64") return "@zed-industries/codex-acp-win32-arm64"
    if (arch === "x64") return "@zed-industries/codex-acp-win32-x64"
  }

  throw new Error(`Unsupported platform/arch for codex-acp: ${platform}/${arch}`)
}

function toUnpackedAsarPath(filePath: string): string {
  const unpackedPath = filePath.replace(
    `${sep}app.asar${sep}`,
    `${sep}app.asar.unpacked${sep}`,
  )

  if (unpackedPath !== filePath && existsSync(unpackedPath)) {
    return unpackedPath
  }

  return filePath
}

function resolveCodexAcpBinaryPath(): string {
  const packageName = getCodexPackageName()
  const binaryName = process.platform === "win32" ? "codex-acp.exe" : "codex-acp"
  const codexPackageRoot = dirname(
    require.resolve("@zed-industries/codex-acp/package.json"),
  )
  const resolvedPath = require.resolve(`${packageName}/bin/${binaryName}`, {
    // Resolve relative to the wrapper package so nested optional deps work in packaged apps.
    paths: [codexPackageRoot],
  })

  return toUnpackedAsarPath(resolvedPath)
}

function resolveBundledCodexCliPath(): string {
  const binaryName = process.platform === "win32" ? "codex.exe" : "codex"
  const resourcesDir = app.isPackaged
    ? join(process.resourcesPath, "bin")
    : join(
        app.getAppPath(),
        "resources",
        "bin",
        `${process.platform}-${process.arch}`,
      )

  const binaryPath = join(resourcesDir, binaryName)
  if (existsSync(binaryPath)) {
    return binaryPath
  }

  const hint = app.isPackaged
    ? "Binary is missing from bundled resources."
    : "Run `bun run codex:download` to download it for local dev."

  throw new Error(
    `[codex] Bundled Codex CLI not found at ${binaryPath}. ${hint}`,
  )
}

function stripAnsi(input: string): string {
  return input.replace(ANSI_OSC_REGEX, "").replace(ANSI_ESCAPE_REGEX, "")
}

function isLocalhostHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase()
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized.endsWith(".localhost")
  )
}

function extractFirstNonLocalhostUrl(output: string): string | null {
  const matches = stripAnsi(output).match(URL_CANDIDATE_REGEX)
  if (!matches) return null

  for (const match of matches) {
    try {
      const parsedUrl = new URL(match.trim().replace(/[),.;!?]+$/, ""))
      if (!isLocalhostHostname(parsedUrl.hostname)) {
        return parsedUrl.toString()
      }
    } catch {
      // Ignore invalid URL candidates.
    }
  }

  return null
}

function appendLoginOutput(session: CodexLoginSession, chunk: string): void {
  const cleanChunk = stripAnsi(chunk)
  if (!cleanChunk) return

  session.output += cleanChunk

  if (!session.url) {
    session.url = extractFirstNonLocalhostUrl(session.output)
  }
}

function toLoginSessionResponse(session: CodexLoginSession) {
  return {
    sessionId: session.id,
    state: session.state,
    url: session.url,
    output: session.output,
    error: session.error,
    exitCode: session.exitCode,
  }
}

function getActiveLoginSession(): CodexLoginSession | null {
  for (const session of loginSessions.values()) {
    if (session.state === "running" && session.process && !session.process.killed) {
      return session
    }
  }

  return null
}

function extractCodexError(error: unknown): { message: string; code?: string } {
  const anyError = error as any
  const message =
    anyError?.data?.message ||
    anyError?.errorText ||
    anyError?.message ||
    anyError?.error ||
    String(error)
  const code = anyError?.data?.code || anyError?.code

  return {
    message: typeof message === "string" ? message : String(message),
    code: typeof code === "string" ? code : undefined,
  }
}

function isCodexAuthError(params: {
  message?: string | null
  code?: string | null
}): boolean {
  const searchableText = `${params.code || ""} ${params.message || ""}`.toLowerCase()
  return AUTH_HINTS.some((hint) => searchableText.includes(hint))
}

async function runCodexCli(args: string[]): Promise<{
  stdout: string
  stderr: string
  exitCode: number | null
}> {
  const codexCliPath = resolveBundledCodexCliPath()

  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(codexCliPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      windowsHide: true,
    })

    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8")
    })

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8")
    })

    child.once("error", (error) => {
      rejectPromise(
        new Error(
          `[codex] Failed to execute \`codex ${args.join(" ")}\`: ${error.message}`,
        ),
      )
    })

    child.once("close", (exitCode) => {
      resolvePromise({
        stdout: stripAnsi(stdout),
        stderr: stripAnsi(stderr),
        exitCode,
      })
    })
  })
}

function normalizeCodexIntegrationState(rawOutput: string): CodexIntegrationState {
  const normalizedOutput = rawOutput.toLowerCase()

  if (normalizedOutput.includes("logged in using chatgpt")) {
    return "connected_chatgpt"
  }

  if (
    normalizedOutput.includes("logged in using an api key") ||
    normalizedOutput.includes("logged in using api key")
  ) {
    return "connected_api_key"
  }

  if (normalizedOutput.includes("not logged in")) {
    return "not_logged_in"
  }

  return "unknown"
}

function parseStoredMessages(raw: string | null | undefined): any[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function extractPromptFromStoredMessage(message: any): string {
  if (!message || !Array.isArray(message.parts)) return ""

  const textParts: string[] = []
  const fileContents: string[] = []

  for (const part of message.parts) {
    if (part?.type === "text" && typeof part.text === "string") {
      textParts.push(part.text)
    } else if (part?.type === "file-content") {
      const filePath =
        typeof part.filePath === "string" ? part.filePath : undefined
      const fileName = filePath?.split("/").pop() || filePath || "file"
      const content = typeof part.content === "string" ? part.content : ""
      fileContents.push(`\n--- ${fileName} ---\n${content}`)
    }
  }

  return textParts.join("\n") + fileContents.join("")
}

function getLastSessionId(messages: any[]): string | undefined {
  const lastAssistant = [...messages].reverse().find((message) => message?.role === "assistant")
  const sessionId = lastAssistant?.metadata?.sessionId
  return typeof sessionId === "string" ? sessionId : undefined
}

function extractCodexModelId(rawModel: unknown): string | undefined {
  if (typeof rawModel !== "string" || rawModel.length === 0) {
    return undefined
  }

  const normalizedModel = rawModel.trim()

  if (!normalizedModel || normalizedModel === "codex") {
    return undefined
  }

  return normalizedModel
}

function preprocessCodexModelName(params: {
  modelId: string
  authConfig?: { apiKey: string }
}): string {
  const hasAppManagedApiKey = Boolean(params.authConfig?.apiKey?.trim())
  if (!hasAppManagedApiKey) {
    return params.modelId
  }

  // All model IDs now match the real API; pass through as-is
  return params.modelId
}

function getAuthFingerprint(authConfig?: { apiKey: string }): string | null {
  const apiKey = authConfig?.apiKey?.trim()
  if (!apiKey) return null
  return createHash("sha256").update(apiKey).digest("hex")
}

function buildCodexProviderEnv(authConfig?: { apiKey: string }): Record<string, string> {
  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value
    }
  }

  const apiKey = authConfig?.apiKey?.trim()
  if (!apiKey) {
    return env
  }

  return {
    ...env,
    CODEX_API_KEY: apiKey,
  }
}

function getCodexAuthMethodId(authConfig?: {
  apiKey: string
}): "codex-api-key" | undefined {
  const apiKey = authConfig?.apiKey?.trim()
  if (!apiKey) {
    return undefined
  }

  // codex-acp advertises auth methods:
  // - chatgpt
  // - codex-api-key
  // - openai-api-key
  // For app-managed API key path we want deterministic key auth.
  return "codex-api-key"
}

function buildUserParts(
  prompt: string,
  images:
    | Array<{
        base64Data?: string
        mediaType?: string
        filename?: string
      }>
    | undefined,
): any[] {
  const parts: any[] = [{ type: "text", text: prompt }]

  if (images && images.length > 0) {
    for (const image of images) {
      if (!image.base64Data || !image.mediaType) continue
      parts.push({
        type: "data-image",
        data: {
          base64Data: image.base64Data,
          mediaType: image.mediaType,
          filename: image.filename,
        },
      })
    }
  }

  return parts
}

function buildModelMessageContent(
  prompt: string,
  images:
    | Array<{
        base64Data?: string
        mediaType?: string
        filename?: string
      }>
    | undefined,
): any[] {
  const content: any[] = [{ type: "text", text: prompt }]

  if (images && images.length > 0) {
    for (const image of images) {
      if (!image.base64Data || !image.mediaType) continue
      content.push({
        type: "file",
        mediaType: image.mediaType,
        data: image.base64Data,
        ...(image.filename ? { filename: image.filename } : {}),
      })
    }
  }

  return content
}

function getOrCreateProvider(params: {
  subChatId: string
  cwd: string
  existingSessionId?: string
  authConfig?: {
    apiKey: string
  }
}): ACPProvider {
  const authFingerprint = getAuthFingerprint(params.authConfig)
  const existing = providerSessions.get(params.subChatId)

  if (
    existing &&
    existing.cwd === params.cwd &&
    existing.authFingerprint === authFingerprint
  ) {
    return existing.provider
  }

  if (existing) {
    existing.provider.cleanup()
    providerSessions.delete(params.subChatId)
  }

  const hasAppManagedApiKey = Boolean(params.authConfig?.apiKey?.trim())
  // When app-managed key auth is used, avoid resuming older persisted session IDs.
  // Those can be tied to unauthenticated/CLI-auth state and trigger auth loops.
  const existingSessionIdForProvider = hasAppManagedApiKey
    ? undefined
    : params.existingSessionId

  const provider = createACPProvider({
    command: resolveCodexAcpBinaryPath(),
    env: buildCodexProviderEnv(params.authConfig),
    authMethodId: getCodexAuthMethodId(params.authConfig),
    session: {
      cwd: params.cwd,
      mcpServers: [],
    },
    ...(existingSessionIdForProvider
      ? { existingSessionId: existingSessionIdForProvider }
      : {}),
    persistSession: true,
  })

  providerSessions.set(params.subChatId, {
    provider,
    cwd: params.cwd,
    authFingerprint,
  })

  return provider
}

function cleanupProvider(subChatId: string): void {
  const existing = providerSessions.get(subChatId)
  if (!existing) return

  existing.provider.cleanup()
  providerSessions.delete(subChatId)
}

export const codexRouter = router({
  getIntegration: publicProcedure.query(async () => {
    const result = await runCodexCli(["login", "status"])
    const combinedOutput = [result.stdout, result.stderr]
      .filter((chunk) => chunk.trim().length > 0)
      .join("\n")
      .trim()

    const state = normalizeCodexIntegrationState(combinedOutput)

    return {
      state,
      isConnected:
        state === "connected_chatgpt" || state === "connected_api_key",
      rawOutput: combinedOutput,
      exitCode: result.exitCode,
    }
  }),

  logout: publicProcedure.mutation(async () => {
    const logoutResult = await runCodexCli(["logout"])
    const statusResult = await runCodexCli(["login", "status"])

    const statusOutput = [statusResult.stdout, statusResult.stderr]
      .filter((chunk) => chunk.trim().length > 0)
      .join("\n")
      .trim()

    const state = normalizeCodexIntegrationState(statusOutput)
    const isConnected =
      state === "connected_chatgpt" || state === "connected_api_key"

    if (isConnected) {
      throw new Error("Failed to log out from Codex. Please try again.")
    }

    const logoutOutput = [logoutResult.stdout, logoutResult.stderr]
      .filter((chunk) => chunk.trim().length > 0)
      .join("\n")
      .trim()

    return {
      success: true,
      state,
      isConnected: false,
      logoutExitCode: logoutResult.exitCode,
      logoutOutput,
      statusOutput,
    }
  }),

  startLogin: publicProcedure.mutation(() => {
    const existingSession = getActiveLoginSession()
    if (existingSession) {
      return toLoginSessionResponse(existingSession)
    }

    const codexCliPath = resolveBundledCodexCliPath()
    const sessionId = crypto.randomUUID()

    const child = spawn(codexCliPath, ["login"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      windowsHide: true,
    })

    const session: CodexLoginSession = {
      id: sessionId,
      process: child,
      state: "running",
      output: "",
      url: null,
      error: null,
      exitCode: null,
    }

    const handleChunk = (chunk: Buffer | string) => {
      appendLoginOutput(session, chunk.toString("utf8"))
    }

    child.stdout.on("data", handleChunk)
    child.stderr.on("data", handleChunk)

    child.once("error", (error) => {
      session.state = "error"
      session.error = `[codex] Failed to start login flow: ${error.message}`
      session.process = null
    })

    child.once("close", (exitCode) => {
      session.exitCode = exitCode
      session.process = null

      if (session.state === "cancelled") {
        return
      }

      if (exitCode === 0) {
        session.state = "success"
        session.error = null
      } else {
        session.state = "error"
        session.error = session.error || `Codex login exited with code ${exitCode ?? "unknown"}`
      }
    })

    loginSessions.set(sessionId, session)

    return toLoginSessionResponse(session)
  }),

  getLoginSession: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
      }),
    )
    .query(({ input }) => {
      const session = loginSessions.get(input.sessionId)
      if (!session) {
        throw new Error("Codex login session not found")
      }

      return toLoginSessionResponse(session)
    }),

  cancelLogin: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
      }),
    )
    .mutation(({ input }) => {
      const session = loginSessions.get(input.sessionId)
      if (!session) {
        return { success: true, found: false }
      }

      session.state = "cancelled"
      session.error = null

      if (session.process && !session.process.killed) {
        session.process.kill("SIGTERM")
      }

      return { success: true, found: true, session: toLoginSessionResponse(session) }
    }),

  chat: publicProcedure
    .input(
      z.object({
        subChatId: z.string(),
        chatId: z.string(),
        runId: z.string(),
        prompt: z.string(),
        model: z.string().optional(),
        cwd: z.string(),
        mode: z.enum(["plan", "agent"]).default("agent"),
        sessionId: z.string().optional(),
        forceNewSession: z.boolean().optional(),
        images: z.array(imageAttachmentSchema).optional(),
        authConfig: z
          .object({
            apiKey: z.string().min(1),
          })
          .optional(),
      }),
    )
    .subscription(({ input }) => {
      return observable<any>((emit) => {
        const existingStream = activeStreams.get(input.subChatId)
        if (existingStream) {
          existingStream.controller.abort()
          // Ensure old run cannot continue emitting after supersede.
          cleanupProvider(input.subChatId)
        }

        const abortController = new AbortController()
        activeStreams.set(input.subChatId, {
          runId: input.runId,
          controller: abortController,
        })

        let isActive = true

        const safeEmit = (chunk: any) => {
          if (!isActive) return
          try {
            emit.next(chunk)
          } catch {
            isActive = false
          }
        }

        const safeComplete = () => {
          if (!isActive) return
          isActive = false
          try {
            emit.complete()
          } catch {
            // Ignore double completion
          }
        }

        ;(async () => {
          try {
            const db = getDatabase()

            const existingSubChat = db
              .select()
              .from(subChats)
              .where(eq(subChats.id, input.subChatId))
              .get()

            if (!existingSubChat) {
              throw new Error("Sub-chat not found")
            }

            const existingMessages = parseStoredMessages(existingSubChat.messages)
            const requestedModelId =
              extractCodexModelId(input.model) || DEFAULT_CODEX_MODEL
            const selectedModelId = preprocessCodexModelName({
              modelId: requestedModelId,
              authConfig: input.authConfig,
            })
            const metadataModel = selectedModelId

            const lastMessage = existingMessages[existingMessages.length - 1]
            const isDuplicatePrompt =
              lastMessage?.role === "user" &&
              extractPromptFromStoredMessage(lastMessage) === input.prompt

            let messagesForStream = existingMessages

            if (!isDuplicatePrompt) {
              const userMessage = {
                id: crypto.randomUUID(),
                role: "user",
                parts: buildUserParts(input.prompt, input.images),
                metadata: { model: metadataModel },
              }

              messagesForStream = [...existingMessages, userMessage]

              db.update(subChats)
                .set({
                  messages: JSON.stringify(messagesForStream),
                  updatedAt: new Date(),
                })
                .where(eq(subChats.id, input.subChatId))
                .run()
            }

            if (input.forceNewSession) {
              cleanupProvider(input.subChatId)
            }

            const provider = getOrCreateProvider({
              subChatId: input.subChatId,
              cwd: input.cwd,
              existingSessionId:
                input.forceNewSession
                  ? undefined
                  : input.sessionId ?? getLastSessionId(existingMessages),
              authConfig: input.authConfig,
            })

            const startedAt = Date.now()

            const result = streamText({
              model: provider.languageModel(selectedModelId),
              messages: [
                {
                  role: "user",
                  content: buildModelMessageContent(input.prompt, input.images),
                },
              ],
              tools: provider.tools,
              abortSignal: abortController.signal,
            })

            const uiStream = result.toUIMessageStream({
              originalMessages: messagesForStream,
              generateMessageId: () => crypto.randomUUID(),
              messageMetadata: ({ part }) => {
                const sessionId = provider.getSessionId() || undefined

                if (part.type === "finish") {
                  return {
                    model: metadataModel,
                    sessionId,
                    inputTokens: part.totalUsage.inputTokens,
                    outputTokens: part.totalUsage.outputTokens,
                    totalTokens: part.totalUsage.totalTokens,
                    durationMs: Date.now() - startedAt,
                    resultSubtype: part.finishReason === "error" ? "error" : "success",
                  }
                }

                if (sessionId) {
                  return {
                    model: metadataModel,
                    sessionId,
                  }
                }

                return { model: metadataModel }
              },
              onFinish: ({ messages }) => {
                try {
                  db.update(subChats)
                    .set({
                      messages: JSON.stringify(messages),
                      updatedAt: new Date(),
                    })
                    .where(eq(subChats.id, input.subChatId))
                    .run()
                } catch (error) {
                  console.error("[codex] Failed to persist messages:", error)
                }
              },
              onError: (error) => extractCodexError(error).message,
            })

            const reader = uiStream.getReader()

            while (true) {
              const { done, value } = await reader.read()
              if (done) break

              if (value?.type === "error") {
                const normalized = extractCodexError(value)

                if (isCodexAuthError(normalized)) {
                  safeEmit({ ...value, type: "auth-error", errorText: normalized.message })
                } else {
                  safeEmit({ ...value, errorText: normalized.message })
                }
                continue
              }

              safeEmit(value)
            }

            safeComplete()
          } catch (error) {
            const normalized = extractCodexError(error)

            console.error("[codex] chat stream error:", error)
            if (isCodexAuthError(normalized)) {
              safeEmit({ type: "auth-error", errorText: normalized.message })
            } else {
              safeEmit({ type: "error", errorText: normalized.message })
            }
            safeEmit({ type: "finish" })
            safeComplete()
          } finally {
            if (activeStreams.get(input.subChatId)?.runId === input.runId) {
              activeStreams.delete(input.subChatId)
            }
          }
        })()

        return () => {
          isActive = false
          abortController.abort()

          if (activeStreams.get(input.subChatId)?.runId === input.runId) {
            activeStreams.delete(input.subChatId)
          }
        }
      })
    }),

  cancel: publicProcedure
    .input(
      z.object({
        subChatId: z.string(),
        runId: z.string(),
      }),
    )
    .mutation(({ input }) => {
      const activeStream = activeStreams.get(input.subChatId)
      if (!activeStream) {
        return { cancelled: false, ignoredStale: false }
      }

      if (activeStream.runId !== input.runId) {
        return { cancelled: false, ignoredStale: true }
      }

      activeStream.controller.abort()
      // Authoritative stop for Codex: force teardown of provider session.
      cleanupProvider(input.subChatId)
      activeStreams.delete(input.subChatId)

      return { cancelled: true, ignoredStale: false }
    }),

  cleanup: publicProcedure
    .input(z.object({ subChatId: z.string() }))
    .mutation(({ input }) => {
      cleanupProvider(input.subChatId)

      const activeStream = activeStreams.get(input.subChatId)
      if (activeStream) {
        activeStream.controller.abort()
        activeStreams.delete(input.subChatId)
      }

      return { success: true }
    }),
})
