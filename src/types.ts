export type AgentRole = "developer" | "codex" | "claude";
export type AgentParticipantRole = Exclude<AgentRole, "developer">;

export type WorkMode = "general" | "design" | "coding" | "review";
export type ContextScope = "selection" | "file";

export interface AttachedContext {
  id: string;
  scope: ContextScope;
  label: string;
  absolutePath: string;
  relativePath: string;
  languageId: string;
  content: string;
  lineStart: number;
  lineEnd: number;
  truncated: boolean;
  note?: string;
}

export interface WorkflowDescriptor {
  title: string;
  description: string;
}

export interface AgentPreference {
  primaryAgent: AgentParticipantRole;
  singleAgentMode: boolean;
}

export interface ProcessEvent {
  id: string;
  kind: "command" | "file" | "web" | "tool" | "status";
  summary: string;
  detail?: string;
  timestamp: string;
  status: "running" | "completed" | "failed" | "info";
}

export interface ChatMessage {
  id: string;
  role: AgentRole;
  author: string;
  content: string;
  timestamp: string;
  mode: WorkMode;
  mentions: AgentRole[];
  attachedContext?: AttachedContext;
  isStreaming?: boolean;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  processEvents?: ProcessEvent[];
}

export interface AgentReply {
  role: AgentParticipantRole;
  content: string;
}

export interface AgentStreamTextUpdate {
  mode: "append" | "replace";
  text: string;
}

export interface AgentStreamCallbacks {
  onText(update: AgentStreamTextUpdate): void;
  onProcess(event: ProcessEvent): void;
}

export interface AgentTurnOptions {
  instruction?: string;
  signal?: AbortSignal;
}

export interface ChatSnapshot {
  messages: ChatMessage[];
  mode: WorkMode;
  attachedContext?: AttachedContext;
  workflow: WorkflowDescriptor;
  agentPreference: AgentPreference;
  isResponding: boolean;
  isCancelling: boolean;
  needsArbitration: boolean;
  arbitrationSummary?: string;
}

export interface CodeReferenceTarget {
  path: string;
  line: number;
}
