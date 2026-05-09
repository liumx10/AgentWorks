import { AgentProvider } from "./providers";
import {
  AgentParticipantRole,
  AgentRole,
  ProcessEvent,
  AttachedContext,
  ChatMessage,
  ChatSnapshot,
  WorkMode,
  WorkflowDescriptor
} from "./types";

const MAX_DISCUSSION_ROUNDS = 4;

interface PendingTurn {
  mode: WorkMode;
  mentions: AgentRole[];
}

export class ChatSession {
  private readonly messages: ChatMessage[] = [];
  private readonly providersByRole = new Map<AgentParticipantRole, AgentProvider>();
  private attachedContext: AttachedContext | undefined;
  private isResponding = false;
  private isCancelling = false;
  private needsArbitration = false;
  private arbitrationSummary: string | undefined;
  private mode: WorkMode = "general";
  private primaryAgent: AgentParticipantRole = "codex";
  private singleAgentMode = false;
  private currentAbortController: AbortController | undefined;

  constructor(private readonly providers: AgentProvider[]) {
    for (const provider of providers) {
      this.providersByRole.set(provider.role, provider);
    }
  }

  getSnapshot(): ChatSnapshot {
    return {
      messages: [...this.messages],
      mode: this.mode,
      attachedContext: this.attachedContext,
      workflow: describeWorkflow(this.mode),
      agentPreference: {
        primaryAgent: this.primaryAgent,
        singleAgentMode: this.singleAgentMode
      },
      isResponding: this.isResponding,
      isCancelling: this.isCancelling,
      needsArbitration: this.needsArbitration,
      arbitrationSummary: this.arbitrationSummary
    };
  }

  beginDeveloperTurn(content: string, explicitMode?: WorkMode): PendingTurn {
    const { cleanedContent, mentions, derivedMode } = parseInput(content, explicitMode ?? this.mode);

    this.mode = derivedMode;
    this.isResponding = true;
    this.isCancelling = false;
    this.needsArbitration = false;
    this.arbitrationSummary = undefined;
    this.currentAbortController = new AbortController();
    this.messages.push(
      createMessage({
        role: "developer",
        author: "Developer",
        content: cleanedContent,
        mode: this.mode,
        mentions,
        attachedContext: this.attachedContext
      })
    );

    return {
      mode: this.mode,
      mentions
    };
  }

  async resolveDeveloperTurn(turn: PendingTurn, onUpdate?: (snapshot: ChatSnapshot) => void): Promise<ChatSnapshot> {
    try {
      const targets = this.providers
        .filter((provider) => turn.mentions.length === 0 || turn.mentions.includes(provider.role))
        .map((provider) => provider.role);

      if (targets.length === 0) {
        return this.getSnapshot();
      }

      if (targets.length === 1 || this.singleAgentMode) {
        const primaryOnly =
          targets.length === 1 ? targets[0] : targets.includes(this.primaryAgent) ? this.primaryAgent : targets[0];
        await this.runSingleAgentTurn(primaryOnly, turn.mode, singleRoleInstruction(primaryOnly, turn.mode), onUpdate);
        return this.getSnapshot();
      }

      const primary = this.primaryAgent;
      const secondary = otherAgent(primary);

      await this.runSingleAgentTurn(primary, turn.mode, openingInstruction(primary, turn.mode), onUpdate);

      let consensus = false;
      let secondaryResponded = false;
      for (let round = 1; round <= MAX_DISCUSSION_ROUNDS; round += 1) {
        await this.runSingleAgentTurn(
          secondary,
          turn.mode,
          critiqueInstruction(secondary, primary, turn.mode, round),
          onUpdate
        );
        secondaryResponded = true;

        await this.runSingleAgentTurn(
          primary,
          turn.mode,
          responseInstruction(primary, secondary, turn.mode, round),
          onUpdate
        );

        const primaryMessage = this.getLastAgentMessage(primary);
        const latestSecondary = this.getLastAgentMessage(secondary);
        if (
          primaryMessage &&
          latestSecondary &&
          detectsConsensusSignal(primaryMessage.content) &&
          detectsConsensusSignal(latestSecondary.content)
        ) {
          consensus = true;
          break;
        }
      }

      if (!consensus) {
        await this.runSingleAgentTurn(
          secondary,
          turn.mode,
          secondaryResponded
            ? summaryInstruction(secondary, primary, turn.mode)
            : minimumFeedbackInstruction(secondary, primary, turn.mode),
          onUpdate
        );
        this.needsArbitration = true;
        this.arbitrationSummary = buildArbitrationSummary(primary, secondary, turn.mode, this.messages);
      }
    } catch (error) {
      if (!isAbortError(error)) {
        throw error;
      }
    } finally {
      this.isResponding = false;
      this.isCancelling = false;
      this.currentAbortController = undefined;
    }

    return this.getSnapshot();
  }

  setMode(mode: WorkMode): ChatSnapshot {
    this.mode = mode;
    return this.getSnapshot();
  }

  setPrimaryAgent(role: AgentParticipantRole): ChatSnapshot {
    this.primaryAgent = role;
    return this.getSnapshot();
  }

  setSingleAgentMode(enabled: boolean): ChatSnapshot {
    this.singleAgentMode = enabled;
    return this.getSnapshot();
  }

  cancelCurrentTurn(): ChatSnapshot {
    if (this.isResponding && this.currentAbortController && !this.currentAbortController.signal.aborted) {
      this.isCancelling = true;
      this.currentAbortController.abort();
    }
    return this.getSnapshot();
  }

  setAttachedContext(context: AttachedContext): ChatSnapshot {
    this.attachedContext = context;
    return this.getSnapshot();
  }

  clearAttachedContext(): ChatSnapshot {
    this.attachedContext = undefined;
    return this.getSnapshot();
  }

  clear(): ChatSnapshot {
    this.messages.length = 0;
    this.mode = "general";
    this.attachedContext = undefined;
    this.isResponding = false;
    this.isCancelling = false;
    this.needsArbitration = false;
    this.arbitrationSummary = undefined;
    this.currentAbortController = undefined;
    return this.getSnapshot();
  }

  private async runSingleAgentTurn(
    role: AgentParticipantRole,
    mode: WorkMode,
    instruction: string,
    onUpdate?: (snapshot: ChatSnapshot) => void
  ): Promise<void> {
    const provider = this.providersByRole.get(role);
    if (!provider) {
      throw new Error(`Missing provider for role ${role}`);
    }

    const draftId = this.appendAgentDraft(role, mode);
    onUpdate?.(this.getSnapshot());

    try {
      const reply = await provider.generateReply(
        this.messages,
        mode,
        {
          instruction,
          signal: this.currentAbortController?.signal
        },
        {
          onText: (update) => {
            this.updateMessageContent(draftId, update.mode, update.text);
            onUpdate?.(this.getSnapshot());
          },
          onProcess: (event) => {
            this.appendProcessEvent(draftId, event);
            onUpdate?.(this.getSnapshot());
          }
        }
      );

      this.finalizeAgentDraft(draftId, reply.content);
      onUpdate?.(this.getSnapshot());
    } catch (error) {
      if (isAbortError(error)) {
        this.markDraftCancelled(draftId);
        onUpdate?.(this.getSnapshot());
      }
      throw error;
    }
  }

  private appendAgentDraft(role: AgentParticipantRole, mode: WorkMode): string {
    const now = new Date().toISOString();
    const message = createMessage({
      role,
      author: role === "codex" ? "Codex" : "Claude",
      content: "",
      mode,
      mentions: [],
      isStreaming: true,
      startedAt: now,
      processEvents: []
    });
    this.messages.push(message);
    return message.id;
  }

  private finalizeAgentDraft(messageId: string, content: string): void {
    const message = this.messages.find((entry) => entry.id === messageId);
    if (!message) {
      return;
    }

    message.content = content;
    message.isStreaming = false;
    const completedAt = new Date();
    message.completedAt = completedAt.toISOString();
    if (message.startedAt) {
      message.durationMs = completedAt.getTime() - new Date(message.startedAt).getTime();
    }
  }

  private updateMessageContent(messageId: string, updateMode: "append" | "replace", text: string): void {
    const message = this.messages.find((entry) => entry.id === messageId);
    if (!message) {
      return;
    }

    message.content = updateMode === "replace" ? text : message.content + text;
    message.isStreaming = true;
  }

  private markDraftCancelled(messageId: string): void {
    const message = this.messages.find((entry) => entry.id === messageId);
    if (!message) {
      return;
    }

    const trimmed = message.content.trim();
    message.content = trimmed ? `${trimmed}\n\n[Cancelled]` : "Cancelled.";
    message.isStreaming = false;
    const completedAt = new Date();
    message.completedAt = completedAt.toISOString();
    if (message.startedAt) {
      message.durationMs = completedAt.getTime() - new Date(message.startedAt).getTime();
    }
  }

  private appendProcessEvent(messageId: string, event: ProcessEvent): void {
    const message = this.messages.find((entry) => entry.id === messageId);
    if (!message) {
      return;
    }

    message.processEvents = [...(message.processEvents ?? []), event];
  }

  private getLastAgentMessage(role: AgentParticipantRole): ChatMessage | undefined {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index];
      if (message.role === role) {
        return message;
      }
    }
    return undefined;
  }
}

function createMessage(input: {
  role: AgentRole;
  author: string;
  content: string;
  mode: WorkMode;
  mentions: AgentRole[];
  attachedContext?: AttachedContext;
  isStreaming?: boolean;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  processEvents?: ProcessEvent[];
}): ChatMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: input.role,
    author: input.author,
    content: input.content,
    timestamp: new Date().toISOString(),
    mode: input.mode,
    mentions: input.mentions,
    attachedContext: input.attachedContext,
    isStreaming: input.isStreaming,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: input.durationMs,
    processEvents: input.processEvents
  };
}

function parseInput(content: string, fallbackMode: WorkMode): {
  cleanedContent: string;
  mentions: AgentRole[];
  derivedMode: WorkMode;
} {
  const mentions: AgentRole[] = [];
  if (/@codex\b/i.test(content)) {
    mentions.push("codex");
  }
  if (/@claude\b/i.test(content)) {
    mentions.push("claude");
  }

  const cleanedContent = content.replace(/@codex\b/gi, "").replace(/@claude\b/gi, "").trim();
  const derivedMode = detectMode(content) ?? fallbackMode;

  return {
    cleanedContent: cleanedContent || content.trim(),
    mentions,
    derivedMode
  };
}

function detectMode(content: string): WorkMode | undefined {
  const value = content.toLowerCase();
  if (/\b(review|审查|reviewer)\b/.test(value)) {
    return "review";
  }
  if (/\b(design|架构|方案)\b/.test(value)) {
    return "design";
  }
  if (/\b(code|coding|实现|写代码|开发)\b/.test(value)) {
    return "coding";
  }
  return undefined;
}

function describeWorkflow(mode: WorkMode): WorkflowDescriptor {
  switch (mode) {
    case "design":
      return {
        title: "Design Debate",
        description: "The selected primary agent opens, the other agent responds, and they continue until they converge or hit the round cap."
      };
    case "coding":
      return {
        title: "Implementation Debate",
        description: "The selected primary agent proposes the implementation, the other critiques it, and they continue refining until they converge or stop."
      };
    case "review":
      return {
        title: "Review Debate",
        description: "The selected primary agent starts the review, the other responds, and both sides iterate toward agreement."
      };
    default:
      return {
        title: "General Debate",
        description: "The selected primary agent answers first, the other reacts, and they continue the discussion until they agree or the round cap is reached."
      };
  }
}

function openingInstruction(role: AgentParticipantRole, mode: WorkMode): string {
  switch (mode) {
    case "design":
      return role === "claude"
        ? "Open the discussion with a proposed design direction. State the architecture, major tradeoffs, and your current recommendation."
        : "Open the discussion with the most practical technical direction you would implement.";
    case "coding":
      return role === "codex"
        ? "Open with a concrete implementation plan. Mention files, code structure, sequencing, and likely risks."
        : "Open with the strongest implementation direction you recommend and why.";
    case "review":
      return role === "codex"
        ? "Open with the most important code review findings. Prioritize correctness bugs, regressions, and missing tests."
        : "Open with the most important review concerns and user-facing risks.";
    default:
      return role === "codex"
        ? "Give your initial answer directly to the developer. Be concrete and opinionated."
        : "Give your initial answer directly to the developer. Emphasize reasoning and alternatives.";
  }
}

function critiqueInstruction(
  role: AgentParticipantRole,
  other: AgentParticipantRole,
  mode: WorkMode,
  round: number
): string {
  return [
    `Round ${round}.`,
    `Respond to ${displayRole(other)}'s latest message, not to the developer directly.`,
    critiqueFocus(role, mode),
    "If you disagree, say exactly what should change and why.",
    "If you mostly agree, state the remaining risks and explicitly say whether you are close to agreement.",
    'If you fully agree, say "CONSENSUS: agreed" and summarize the agreed position briefly.'
  ].join(" ");
}

function responseInstruction(
  role: AgentParticipantRole,
  other: AgentParticipantRole,
  mode: WorkMode,
  round: number
): string {
  return [
    `Round ${round}.`,
    `Reply to ${displayRole(other)}'s critique.`,
    responseFocus(role, mode),
    "Address disagreements directly. Either revise your proposal or defend it with concrete reasoning.",
    "If you now agree on the path, say exactly: CONSENSUS: agreed, then summarize the final shared position."
  ].join(" ");
}

function summaryInstruction(role: AgentParticipantRole, other: AgentParticipantRole, mode: WorkMode): string {
  return [
    `You are ${displayRole(role)}.`,
    `The discussion with ${displayRole(other)} reached the round cap without explicit consensus.`,
    summaryFocus(mode),
    'Summarize the current best path, the remaining disagreement, and the recommendation to the developer. Explicitly state that developer arbitration is needed. Start with either "CONSENSUS: partial" or "CONSENSUS: unresolved".'
  ].join(" ");
}

function minimumFeedbackInstruction(role: AgentParticipantRole, other: AgentParticipantRole, mode: WorkMode): string {
  return [
    `You are ${displayRole(role)}.`,
    `Give feedback on ${displayRole(other)}'s latest answer.`,
    summaryFocus(mode),
    'Even if you agree completely, respond explicitly. A short response like "LGTM" is acceptable, but mention that you agree and optionally note one caveat.'
  ].join(" ");
}

function singleRoleInstruction(role: AgentParticipantRole, mode: WorkMode): string {
  if (role === "codex") {
    switch (mode) {
      case "design":
        return "Focus on feasibility, interface shape, implementation boundaries, and what would make the design easy to ship.";
      case "coding":
        return "Focus on code structure, files, algorithms, and the next concrete implementation steps.";
      case "review":
        return "Focus on correctness bugs, regressions, edge cases, and missing tests.";
      default:
        return "Reply concretely and turn the discussion into executable engineering steps.";
    }
  }

  switch (mode) {
    case "design":
      return "Focus on architecture alternatives, tradeoffs, and where the proposed design could be improved.";
    case "coding":
      return "Focus on maintainability, readability, and risks in the implementation direction.";
    case "review":
      return "Focus on user impact, resilience, clarity, and any review findings that a purely code-level pass might miss.";
    default:
      return "Reply with reasoning, alternatives, and any weak assumptions worth challenging.";
  }
}

function critiqueFocus(role: AgentParticipantRole, mode: WorkMode): string {
  if (role === "codex") {
    switch (mode) {
      case "design":
        return "Pressure-test feasibility, interfaces, and file-level implementation complexity.";
      case "coding":
        return "Challenge implementation details, correctness, and whether the plan is actually shippable.";
      case "review":
        return "Focus on concrete code defects, regressions, and missing test coverage.";
      default:
        return "Challenge weak execution details and make the answer more concrete.";
    }
  }

  switch (mode) {
    case "design":
      return "Challenge architecture assumptions, tradeoffs, and long-term maintainability.";
    case "coding":
      return "Challenge readability, maintainability, API shape, and hidden edge cases.";
    case "review":
      return "Add resilience, user-impact, and design-level review concerns.";
    default:
      return "Challenge assumptions, alternatives, and reasoning quality.";
  }
}

function responseFocus(role: AgentParticipantRole, mode: WorkMode): string {
  if (role === "codex") {
    switch (mode) {
      case "design":
        return "Translate any accepted changes into concrete structure and implementation consequences.";
      case "coding":
        return "Refine the implementation plan with concrete code-level changes.";
      case "review":
        return "Clarify which findings are blockers and what fixes are required.";
      default:
        return "Refine the answer into something executable and internally consistent.";
    }
  }

  switch (mode) {
    case "design":
      return "Refine the architecture and state the tradeoff balance clearly.";
    case "coding":
      return "Clarify why the revised implementation is maintainable and safe.";
    case "review":
      return "Clarify impact, priority, and remaining non-code concerns.";
    default:
      return "Refine the reasoning and reduce ambiguity.";
  }
}

function summaryFocus(mode: WorkMode): string {
  switch (mode) {
    case "design":
      return "Produce a concise design conclusion for the developer.";
    case "coding":
      return "Produce a concise implementation conclusion for the developer.";
    case "review":
      return "Produce a concise review conclusion for the developer.";
    default:
      return "Produce a concise discussion conclusion for the developer.";
  }
}

function detectsConsensusSignal(content: string): boolean {
  return /consensus:\s*agreed/i.test(content);
}

function buildArbitrationSummary(
  primary: AgentParticipantRole,
  secondary: AgentParticipantRole,
  mode: WorkMode,
  messages: ChatMessage[]
): string {
  const primaryMessage = findLatestMessage(messages, primary)?.content;
  const secondaryMessage = findLatestMessage(messages, secondary)?.content;
  const summaryParts = [
    `${displayRole(primary)} and ${displayRole(secondary)} did not reach consensus in ${mode} mode.`,
    "Developer arbitration is needed before continuing."
  ];

  if (primaryMessage) {
    summaryParts.push(`${displayRole(primary)} latest position: ${trimSummary(primaryMessage)}`);
  }
  if (secondaryMessage) {
    summaryParts.push(`${displayRole(secondary)} latest position: ${trimSummary(secondaryMessage)}`);
  }

  return summaryParts.join(" ");
}

function findLatestMessage(messages: ChatMessage[], role: AgentParticipantRole): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === role) {
      return message;
    }
  }
  return undefined;
}

function trimSummary(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
}

function displayRole(role: AgentParticipantRole): string {
  return role === "codex" ? "Codex" : "Claude";
}

function otherAgent(role: AgentParticipantRole): AgentParticipantRole {
  return role === "codex" ? "claude" : "codex";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
