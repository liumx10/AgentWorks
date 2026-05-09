import * as vscode from "vscode";
import { statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  AgentReply,
  AgentStreamCallbacks,
  AgentTurnOptions,
  AttachedContext,
  ChatMessage,
  ProcessEvent,
  WorkMode
} from "./types";

export interface AgentProvider {
  readonly role: "codex" | "claude";
  generateReply(
    history: ChatMessage[],
    mode: WorkMode,
    options?: AgentTurnOptions,
    stream?: AgentStreamCallbacks
  ): Promise<AgentReply>;
}

interface ProviderConfig {
  cliPath: string;
  model: string;
  reasoningEffort?: string;
  codexSandbox?: "read-only" | "workspace-write" | "danger-full-access";
  claudePermissionMode?: "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan";
  claudeTools?: string;
  systemPrompt: string;
  useMock: boolean;
  workspaceRoot: string;
}

abstract class BaseProvider implements AgentProvider {
  abstract readonly role: "codex" | "claude";

  constructor(protected readonly config: ProviderConfig) {}

  async generateReply(
    history: ChatMessage[],
    mode: WorkMode,
    options: AgentTurnOptions = {},
    stream?: AgentStreamCallbacks
  ): Promise<AgentReply> {
    if (this.config.useMock) {
      return this.generateMockReply(history, mode, options, stream);
    }

    return this.generateLiveReply(history, mode, options, stream);
  }

  protected abstract generateMockReply(
    history: ChatMessage[],
    mode: WorkMode,
    options: AgentTurnOptions,
    stream?: AgentStreamCallbacks
  ): Promise<AgentReply>;

  protected abstract generateLiveReply(
    history: ChatMessage[],
    mode: WorkMode,
    options: AgentTurnOptions,
    stream?: AgentStreamCallbacks
  ): Promise<AgentReply>;

  protected buildPrompt(history: ChatMessage[], mode: WorkMode, options: AgentTurnOptions): string {
    const seenContexts = new Set<string>();
    const latestDeveloperLanguage = detectLatestDeveloperLanguage(history);
    const conversation = history
      .slice(-12)
      .map((message) => {
        const parts = [
          `[${message.author}]`,
          `role=${message.role}`,
          `mode=${message.mode}`,
          message.content
        ];

        if (message.attachedContext) {
          parts.push(formatAttachedContext(message.attachedContext, seenContexts));
        }

        return parts.filter(Boolean).join("\n");
      })
      .join("\n\n");

    return [
      this.config.systemPrompt,
      "You are one participant in a three-party engineering workflow with a developer and another AI agent.",
      `Your role is ${this.role}.`,
      `Current work mode: ${mode}.`,
      "Reply as yourself only. Do not fabricate what the other agent said.",
      "Be concise, concrete, and useful in a collaborative software workflow.",
      "When the developer is asking for implementation work, prefer taking action: inspect files, edit code, and run relevant tests instead of only describing a plan.",
      "If tools are available, use them to complete the task. Do not stop at high-level advice when the task requires code changes or verification.",
      "Reply in the same language as the latest developer message unless the developer explicitly asks to switch languages.",
      `Latest developer language: ${latestDeveloperLanguage.label}.`,
      latestDeveloperLanguage.directive,
      "When referencing code, prefer file citations in the form path:line, for example src/app.ts:42.",
      options.instruction ? `Turn-specific guidance: ${options.instruction}` : "",
      "",
      "Conversation:",
      conversation,
      "",
      "Now provide your next reply in the discussion."
    ]
      .filter(Boolean)
      .join("\n");
  }
}

function detectLatestDeveloperLanguage(history: ChatMessage[]): { label: string; directive: string } {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message.role !== "developer") {
      continue;
    }

    if (/[\u3400-\u9fff]/.test(message.content)) {
      return {
        label: "Chinese",
        directive: "The latest developer message is in Chinese. Reply fully in Chinese."
      };
    }

    return {
      label: "English",
      directive: "The latest developer message is in English. Reply fully in English."
    };
  }

  return {
    label: "English",
    directive: "No developer language was detected yet. Reply in English by default."
  };
}

export class CodexProvider extends BaseProvider {
  readonly role = "codex" as const;

  protected async generateMockReply(
    history: ChatMessage[],
    mode: WorkMode,
    options: AgentTurnOptions,
    stream?: AgentStreamCallbacks
  ): Promise<AgentReply> {
    const latest = history[history.length - 1]?.content ?? "";
    const content = [
      "Codex view:",
      this.modeHint(mode),
      "I would break the request into concrete implementation steps.",
      options.instruction ? `Turn guidance: ${options.instruction}` : "",
      `Focus item: ${trimForPreview(latest)}`
    ]
      .filter(Boolean)
      .join("\n");

    if (stream) {
      await emitMockStream(content, stream, options.signal);
    }

    return { role: this.role, content };
  }

  protected async generateLiveReply(
    history: ChatMessage[],
    mode: WorkMode,
    options: AgentTurnOptions,
    stream?: AgentStreamCallbacks
  ): Promise<AgentReply> {
    const prompt = this.buildPrompt(history, mode, options);
    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "-s",
      this.config.codexSandbox ?? "workspace-write",
      "-C",
      this.config.workspaceRoot,
      "-m",
      this.config.model,
      ...(this.config.reasoningEffort
        ? ["-c", `model_reasoning_effort="${this.config.reasoningEffort}"`]
        : []),
      prompt
    ];

    if (stream) {
      stream.onText({
        mode: "replace",
        text: "Running Codex...\n"
      });
    }

    try {
      const result = await spawnJsonProcess(
        this.config.cliPath,
        args,
        this.config.workspaceRoot,
        options.signal,
        (event) => {
          if (!stream) {
            return;
          }

          const processEvent = mapCodexProcessEvent(event);
          if (processEvent) {
            stream.onProcess(processEvent);
          }

          if (event.type === "item.completed" && event.item?.type === "agent_message") {
            stream.onText({
              mode: "replace",
              text: event.item.text ?? ""
            });
          }
        }
      );

      const completed = findLastCodexMessage(result.events);
      return {
        role: this.role,
        content: completed || "Codex returned an empty response."
      };
    } catch (error) {
      return {
        role: this.role,
        content: formatProviderError("codex", error)
      };
    }
  }

  private modeHint(mode: WorkMode): string {
    switch (mode) {
      case "design":
        return "I would propose interfaces, data flow, and tradeoffs first.";
      case "coding":
        return "I would move directly into file-level implementation planning.";
      case "review":
        return "I would inspect for regressions, edge cases, and missing tests.";
      default:
        return "I would clarify scope and then turn it into executable steps.";
    }
  }
}

export class ClaudeProvider extends BaseProvider {
  readonly role = "claude" as const;

  protected async generateMockReply(
    history: ChatMessage[],
    mode: WorkMode,
    options: AgentTurnOptions,
    stream?: AgentStreamCallbacks
  ): Promise<AgentReply> {
    const latest = history[history.length - 1]?.content ?? "";
    const content = [
      "Claude view:",
      this.modeHint(mode),
      "I would expand the reasoning, challenge assumptions, and surface alternatives.",
      options.instruction ? `Turn guidance: ${options.instruction}` : "",
      `Latest topic: ${trimForPreview(latest)}`
    ]
      .filter(Boolean)
      .join("\n");

    if (stream) {
      await emitMockStream(content, stream, options.signal);
    }

    return { role: this.role, content };
  }

  protected async generateLiveReply(
    history: ChatMessage[],
    mode: WorkMode,
    options: AgentTurnOptions,
    stream?: AgentStreamCallbacks
  ): Promise<AgentReply> {
    const prompt = this.buildPrompt(history, mode, options);
    let finalResult = "";

    try {
      await spawnJsonProcess(
        this.config.cliPath,
        [
          "-p",
          "--verbose",
          "--output-format",
          "stream-json",
          "--include-partial-messages",
          "--permission-mode",
          this.config.claudePermissionMode ?? "acceptEdits",
          "--dangerously-skip-permissions",
          "--tools",
          this.config.claudeTools ?? "default",
          "--add-dir",
          this.config.workspaceRoot,
          "--model",
          this.config.model,
          prompt
        ],
        this.config.workspaceRoot,
        options.signal,
        (event) => {
          const processEvent = mapClaudeProcessEvent(event);
          if (processEvent && stream) {
            stream.onProcess(processEvent);
          }

          if (event.type === "stream_event" && event.event?.type === "content_block_delta") {
            const chunk = event.event.delta?.text ?? "";
            if (chunk && stream) {
              stream.onText({
                mode: "append",
                text: chunk
              });
            }
          }

          if (event.type === "result" && typeof event.result === "string") {
            finalResult = event.result;
          }
        }
      );

      return {
        role: this.role,
        content: finalResult.trim() || "Claude returned an empty response."
      };
    } catch (error) {
      return {
        role: this.role,
        content: formatProviderError("claude", error)
      };
    }
  }

  private modeHint(mode: WorkMode): string {
    switch (mode) {
      case "design":
        return "I would compare a few architecture variants before committing.";
      case "coding":
        return "I would discuss implementation risks and maintainability tradeoffs.";
      case "review":
        return "I would emphasize readability, failure modes, and user impact.";
      default:
        return "I would broaden the discussion, then converge on a practical path.";
    }
  }
}

function trimForPreview(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}

function trimProcessDetail(value: string, limit = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized;
}

function createProcessEvent(input: Omit<ProcessEvent, "id" | "timestamp">): ProcessEvent {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    ...input
  };
}

function mapCodexProcessEvent(event: any): ProcessEvent | undefined {
  const item = event?.item;
  if (!item) {
    return undefined;
  }

  if (item.type === "command_execution" && item.command) {
    const status =
      item.status === "completed"
        ? item.exit_code === 0
          ? "completed"
          : "failed"
        : item.status === "in_progress"
          ? "running"
          : "info";

    const detailParts = [item.command];
    if (typeof item.aggregated_output === "string" && item.aggregated_output.trim()) {
      detailParts.push(trimProcessDetail(item.aggregated_output));
    }

    return createProcessEvent({
      kind: "command",
      summary: item.command,
      detail: detailParts.join("\n\n"),
      status
    });
  }

  if (item.type === "agent_message" && event.type === "item.completed") {
    return createProcessEvent({
      kind: "status",
      summary: "Codex finished a response segment.",
      status: "info"
    });
  }

  return undefined;
}

function mapClaudeProcessEvent(event: any): ProcessEvent | undefined {
  if (event?.type === "system" && event.subtype === "status" && event.status) {
    return createProcessEvent({
      kind: "status",
      summary: `Claude status: ${event.status}`,
      status: "info"
    });
  }

  if (event?.type === "system" && event.subtype === "api_retry") {
    return createProcessEvent({
      kind: "status",
      summary: `Claude API retry ${event.attempt}/${event.max_retries}`,
      detail: event.error ? `error: ${event.error}` : undefined,
      status: "failed"
    });
  }

  if (event?.tool_name || event?.toolName) {
    const toolName = event.tool_name ?? event.toolName;
    return createProcessEvent({
      kind: "tool",
      summary: `Claude used tool: ${toolName}`,
      detail: trimProcessDetail(JSON.stringify(event)),
      status: "info"
    });
  }

  return undefined;
}

function formatProviderError(provider: "codex" | "claude", error: unknown): string {
  if (isSpawnError(error)) {
    return [`[${provider} bridge error]`, error.message, error.stdout && `stdout:\n${error.stdout}`, error.stderr && `stderr:\n${error.stderr}`]
      .filter(Boolean)
      .join("\n\n");
  }

  const message = error instanceof Error ? error.message : String(error);
  return `[${provider} bridge error]\n${message}`;
}

export function createProviders(config: vscode.WorkspaceConfiguration, workspaceRoot: string): AgentProvider[] {
  const systemPrompt = config.get<string>(
    "systemPrompt",
    "You are participating in a collaborative engineering chat with a developer and another AI agent. Be concise, concrete, and technically rigorous."
  );
  const useMock = config.get<boolean>("enableMockResponses", false);

  return [
    new CodexProvider({
      cliPath: resolveCliPath(config.get<string>("codexCliPath", ""), "codex"),
      model: config.get<string>("codexModel", "gpt-5.4"),
      reasoningEffort: config.get<string>("codexReasoningEffort", "medium"),
      codexSandbox: config.get<"read-only" | "workspace-write" | "danger-full-access">(
        "codexSandbox",
        "workspace-write"
      ),
      systemPrompt,
      useMock,
      workspaceRoot
    }),
    new ClaudeProvider({
      cliPath: resolveCliPath(config.get<string>("claudeCliPath", ""), "claude"),
      model: config.get<string>("claudeModel", "opus"),
      claudePermissionMode: config.get<
        "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan"
      >("claudePermissionMode", "acceptEdits"),
      claudeTools: config.get<string>("claudeTools", "default"),
      systemPrompt,
      useMock,
      workspaceRoot
    })
  ];
}

function resolveCliPath(explicitPath: string, command: "codex" | "claude"): string {
  if (explicitPath.trim()) {
    return explicitPath.trim();
  }

  const candidates = new Set<string>([
    ...((process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((entry) => path.join(entry, command))),
    path.join("/opt/homebrew/bin", command),
    path.join("/usr/local/bin", command),
    path.join("/usr/bin", command)
  ]);

  for (const candidate of candidates) {
    try {
      const stat = statSync(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // Continue.
    }
  }

  return command;
}

async function emitMockStream(content: string, stream: AgentStreamCallbacks, signal?: AbortSignal): Promise<void> {
  stream.onText({ mode: "replace", text: "" });
  const chunks = chunkString(content, 48);
  for (const chunk of chunks) {
    throwIfAborted(signal);
    stream.onText({ mode: "append", text: chunk });
    await delay(20);
  }
}

function chunkString(value: string, size: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findLastCodexMessage(events: unknown[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as { type?: string; item?: { type?: string; text?: string } };
    if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
      return event.item.text.trim();
    }
  }
  return "";
}

interface SpawnSuccess {
  events: unknown[];
  stdout: string;
  stderr: string;
}

interface SpawnFailure extends Error {
  stdout: string;
  stderr: string;
}

function isSpawnError(value: unknown): value is SpawnFailure {
  return value instanceof Error && "stdout" in value && "stderr" in value;
}

function spawnJsonProcess(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  onEvent: (event: any) => void
): Promise<SpawnSuccess> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    let settled = false;
    const events: unknown[] = [];
    const abortHandler = () => {
      if (settled) {
        return;
      }

      child.kill("SIGTERM");
      const error = new Error("Request cancelled.");
      error.name = "AbortError";
      settled = true;
      reject(
        Object.assign(error, {
          stdout,
          stderr
        })
      );
    };

    if (signal) {
      if (signal.aborted) {
        abortHandler();
        return;
      }
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      stdoutBuffer += chunk;

      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

        if (line) {
          try {
            const event = JSON.parse(line);
            events.push(event);
            onEvent(event);
          } catch {
            // Ignore non-JSON lines.
          }
        }

        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (signal) {
        signal.removeEventListener("abort", abortHandler);
      }
      const wrapped = Object.assign(new Error(error.message), {
        stdout,
        stderr
      });
      reject(wrapped);
    });

    child.on("close", (code) => {
      if (signal) {
        signal.removeEventListener("abort", abortHandler);
      }
      if (settled) {
        return;
      }
      settled = true;
      const tail = stdoutBuffer.trim();
      if (tail) {
        try {
          const event = JSON.parse(tail);
          events.push(event);
          onEvent(event);
        } catch {
          // Ignore non-JSON tail.
        }
      }

      if (code === 0) {
        resolve({
          events,
          stdout,
          stderr
        });
        return;
      }

      const wrapped = Object.assign(new Error(`Process exited with code ${code}`), {
        stdout,
        stderr
      });
      reject(wrapped);
    });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("Request cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

function formatAttachedContext(context: AttachedContext, seenContexts: Set<string>): string {
  const metadata = [
    `attached_context=${context.label}`,
    `scope=${context.scope}`,
    `language=${context.languageId}`,
    `path=${context.relativePath}`,
    `lines=${context.lineStart + 1}-${context.lineEnd + 1}`,
    context.note ? `note=${context.note}` : "",
    context.truncated ? "truncated=true" : ""
  ]
    .filter(Boolean)
    .join("\n");

  if (seenContexts.has(context.id)) {
    return metadata;
  }

  seenContexts.add(context.id);
  return [metadata, "content:", context.content].join("\n");
}
