import { AgentProvider } from "./providers";
import {
  AgentParticipantRole,
  AgentRole,
  AttachedContext,
  ChatMessage,
  ChatSnapshot,
  ProcessEvent,
  TaskPhase,
  TaskSummary,
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
  private phase: TaskPhase = "idle";
  private updatedAt = new Date().toISOString();
  private title = "New Task";
  private titleWasCustomized = false;

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
      workflow: describeWorkflow(this.mode, this.phase, this.singleAgentMode),
      agentPreference: {
        primaryAgent: this.primaryAgent,
        singleAgentMode: this.singleAgentMode
      },
      isResponding: this.isResponding,
      isCancelling: this.isCancelling,
      needsArbitration: this.needsArbitration,
      arbitrationSummary: this.arbitrationSummary,
      phase: this.phase
    };
  }

  getSummary(taskId: string): TaskSummary {
    return {
      id: taskId,
      title: this.title,
      updatedAt: this.updatedAt,
      messageCount: this.messages.length,
      mode: this.mode,
      phase: this.phase,
      isResponding: this.isResponding,
      isCancelling: this.isCancelling,
      needsArbitration: this.needsArbitration,
      primaryAgent: this.primaryAgent,
      singleAgentMode: this.singleAgentMode
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
    this.phase = initialPhaseForMode(this.mode, this.singleAgentMode);
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
    this.deriveTitleFromLatestDeveloperMessage();
    this.bumpUpdatedAt();

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
        this.phase = phaseForSoloMode(turn.mode);
        await this.runSingleAgentTurn(primaryOnly, turn.mode, singleRoleInstruction(primaryOnly, turn.mode), onUpdate);
        this.phase = "idle";
        return this.getSnapshot();
      }

      const primary = targets.includes(this.primaryAgent) ? this.primaryAgent : targets[0];
      const secondary = targets.find((role) => role !== primary) ?? otherAgent(primary);

      if (turn.mode === "coding") {
        await this.runPlanThenCodeTurn(primary, secondary, turn.mode, onUpdate);
      } else {
        await this.runDiscussionTurn(primary, secondary, turn.mode, onUpdate);
      }
    } catch (error) {
      if (!isAbortError(error)) {
        throw error;
      }
    } finally {
      this.isResponding = false;
      this.isCancelling = false;
      this.currentAbortController = undefined;
      if (!this.needsArbitration) {
        this.phase = "idle";
      }
      this.bumpUpdatedAt();
    }

    return this.getSnapshot();
  }

  setMode(mode: WorkMode): ChatSnapshot {
    this.mode = mode;
    if (!this.isResponding && !this.needsArbitration) {
      this.phase = "idle";
    }
    this.bumpUpdatedAt();
    return this.getSnapshot();
  }

  setPrimaryAgent(role: AgentParticipantRole): ChatSnapshot {
    this.primaryAgent = role;
    this.bumpUpdatedAt();
    return this.getSnapshot();
  }

  setSingleAgentMode(enabled: boolean): ChatSnapshot {
    this.singleAgentMode = enabled;
    this.bumpUpdatedAt();
    return this.getSnapshot();
  }

  setAttachedContext(context: AttachedContext): ChatSnapshot {
    this.attachedContext = context;
    this.bumpUpdatedAt();
    return this.getSnapshot();
  }

  clearAttachedContext(): ChatSnapshot {
    this.attachedContext = undefined;
    this.bumpUpdatedAt();
    return this.getSnapshot();
  }

  cancelCurrentTurn(): ChatSnapshot {
    if (this.isResponding && this.currentAbortController && !this.currentAbortController.signal.aborted) {
      this.isCancelling = true;
      this.currentAbortController.abort();
      this.bumpUpdatedAt();
    }
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
    this.phase = "idle";
    this.bumpUpdatedAt();
    return this.getSnapshot();
  }

  rename(title: string): ChatSnapshot {
    const normalized = title.trim();
    if (normalized) {
      this.title = normalized;
      this.titleWasCustomized = true;
      this.bumpUpdatedAt();
    }
    return this.getSnapshot();
  }

  seedTitle(title: string): ChatSnapshot {
    const normalized = title.trim();
    if (normalized) {
      this.title = normalized;
      this.titleWasCustomized = false;
      this.bumpUpdatedAt();
    }
    return this.getSnapshot();
  }

  private async runPlanThenCodeTurn(
    primary: AgentParticipantRole,
    secondary: AgentParticipantRole,
    mode: WorkMode,
    onUpdate?: (snapshot: ChatSnapshot) => void
  ): Promise<void> {
    this.phase = "planning";
    await this.runDiscussionTurn(primary, secondary, "design", onUpdate, {
      openingInstruction: planOpeningInstruction(primary),
      critiqueInstruction: (round) => planCritiqueInstruction(secondary, primary, round),
      responseInstruction: (round) => planResponseInstruction(primary, secondary, round),
      summaryInstruction: () => planSummaryInstruction(secondary, primary),
      minimumFeedbackInstruction: () => minimumFeedbackInstruction(secondary, primary, "design")
    });

    if (this.needsArbitration || this.currentAbortController?.signal.aborted) {
      return;
    }

    this.phase = "implementing";
    await this.runSingleAgentTurn(primary, mode, codingExecutionInstruction(primary), onUpdate);

    this.phase = "reviewing";
    await this.runSingleAgentTurn(secondary, "review", postImplementationReviewInstruction(secondary, primary), onUpdate);

    const primaryFollowUp =
      findLatestMessageSincePhase(this.messages, primary, this.phase) ?? this.getLastAgentMessage(primary);
    const secondaryReview = this.getLastAgentMessage(secondary);
    if (
      primaryFollowUp &&
      secondaryReview &&
      !detectsConsensusSignal(primaryFollowUp.content) &&
      !detectsConsensusSignal(secondaryReview.content)
    ) {
      await this.runSingleAgentTurn(
        primary,
        mode,
        finalCodingResponseInstruction(primary, secondary),
        onUpdate
      );
    }
  }

  private async runDiscussionTurn(
    primary: AgentParticipantRole,
    secondary: AgentParticipantRole,
    mode: WorkMode,
    onUpdate?: (snapshot: ChatSnapshot) => void,
    instructionOverride?: {
      openingInstruction?: string;
      critiqueInstruction?: (round: number) => string;
      responseInstruction?: (round: number) => string;
      summaryInstruction?: () => string;
      minimumFeedbackInstruction?: () => string;
    }
  ): Promise<void> {
    this.phase = mode === "review" ? "reviewing" : this.phase === "planning" ? "planning" : "implementing";

    await this.runSingleAgentTurn(
      primary,
      mode,
      instructionOverride?.openingInstruction ?? openingInstruction(primary, mode),
      onUpdate
    );

    let consensus = false;
    let secondaryResponded = false;

    for (let round = 1; round <= MAX_DISCUSSION_ROUNDS; round += 1) {
      await this.runSingleAgentTurn(
        secondary,
        mode,
        instructionOverride?.critiqueInstruction?.(round) ??
          critiqueInstruction(secondary, primary, mode, round),
        onUpdate
      );
      secondaryResponded = true;

      const latestSecondary = this.getLastAgentMessage(secondary);
      if (latestSecondary && detectsConsensusSignal(latestSecondary.content)) {
        consensus = true;
        break;
      }

      await this.runSingleAgentTurn(
        primary,
        mode,
        instructionOverride?.responseInstruction?.(round) ??
          responseInstruction(primary, secondary, mode, round),
        onUpdate
      );

      const primaryMessage = this.getLastAgentMessage(primary);
      const latestSecondaryAfterPrimary = this.getLastAgentMessage(secondary);
      if (
        primaryMessage &&
        latestSecondaryAfterPrimary &&
        detectsConsensusSignal(primaryMessage.content) &&
        detectsConsensusSignal(latestSecondaryAfterPrimary.content)
      ) {
        consensus = true;
        break;
      }
    }

    if (!consensus) {
      await this.runSingleAgentTurn(
        secondary,
        mode,
        secondaryResponded
          ? instructionOverride?.summaryInstruction?.() ?? summaryInstruction(secondary, primary, mode)
          : instructionOverride?.minimumFeedbackInstruction?.() ??
              minimumFeedbackInstruction(secondary, primary, mode),
        onUpdate
      );
      this.needsArbitration = true;
      this.phase = "arbitration";
      this.arbitrationSummary = buildArbitrationSummary(primary, secondary, mode, this.messages);
    }
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
    this.bumpUpdatedAt();
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
            this.bumpUpdatedAt();
            onUpdate?.(this.getSnapshot());
          },
          onProcess: (event) => {
            this.appendProcessEvent(draftId, event);
            this.bumpUpdatedAt();
            onUpdate?.(this.getSnapshot());
          }
        }
      );

      this.finalizeAgentDraft(draftId, reply.content);
      this.bumpUpdatedAt();
      onUpdate?.(this.getSnapshot());
    } catch (error) {
      if (isAbortError(error)) {
        this.markDraftCancelled(draftId);
        this.bumpUpdatedAt();
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

  private deriveTitleFromLatestDeveloperMessage(): void {
    if (this.titleWasCustomized) {
      return;
    }

    const latestDeveloperMessage = [...this.messages].reverse().find((message) => message.role === "developer");
    if (!latestDeveloperMessage) {
      return;
    }

    const normalized = latestDeveloperMessage.content.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return;
    }

    this.title = normalized.length > 42 ? `${normalized.slice(0, 39)}...` : normalized;
  }

  private bumpUpdatedAt(): void {
    this.updatedAt = new Date().toISOString();
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

function describeWorkflow(mode: WorkMode, phase: TaskPhase, singleAgentMode: boolean): WorkflowDescriptor {
  if (singleAgentMode) {
    return {
      title: "Solo",
      description: "The selected primary agent handles this task alone."
    };
  }

  if (mode === "coding") {
    switch (phase) {
      case "planning":
        return {
          title: "Coding Plan",
          description: "The agents are aligning on an implementation plan before touching code."
        };
      case "implementing":
        return {
          title: "Implementation",
          description: "The primary agent is implementing the agreed path."
        };
      case "reviewing":
        return {
          title: "Implementation Review",
          description: "The other agent is reviewing the implementation and its risks."
        };
      case "arbitration":
        return {
          title: "Needs Arbitration",
          description: "The implementation thread did not converge and needs a developer decision."
        };
      default:
        return {
          title: "Coding Debate",
          description: "Coding tasks first align on a plan, then implement, then review."
        };
    }
  }

  switch (mode) {
    case "design":
      return {
        title: "Design Debate",
        description: "The selected primary agent opens, the other agent responds, and they continue until they converge or hit the round cap."
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

function initialPhaseForMode(mode: WorkMode, singleAgentMode: boolean): TaskPhase {
  if (singleAgentMode) {
    return phaseForSoloMode(mode);
  }

  switch (mode) {
    case "coding":
      return "planning";
    case "review":
      return "reviewing";
    case "design":
      return "planning";
    default:
      return "implementing";
  }
}

function phaseForSoloMode(mode: WorkMode): TaskPhase {
  switch (mode) {
    case "review":
      return "reviewing";
    case "design":
      return "planning";
    case "coding":
      return "implementing";
    default:
      return "implementing";
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
        return "First define a concise plan, then implement it directly, edit files, and run the most relevant verification.";
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
      return "First define a concise plan, then implement it directly with attention to maintainability and risk.";
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

function planOpeningInstruction(role: AgentParticipantRole): string {
  return role === "codex"
    ? "Do not edit code yet. Propose the implementation plan first: target files, change sequence, constraints, and verification strategy."
    : "Do not edit code yet. Propose the best implementation plan, key tradeoffs, and what could go wrong.";
}

function planCritiqueInstruction(role: AgentParticipantRole, other: AgentParticipantRole, round: number): string {
  return [
    `Round ${round}.`,
    `Review ${displayRole(other)}'s implementation plan only.`,
    critiqueFocus(role, "coding"),
    "Do not ask to code yet unless the plan is clear enough to execute.",
    "If the plan is good enough, say CONSENSUS: agreed and summarize the approved plan briefly."
  ].join(" ");
}

function planResponseInstruction(role: AgentParticipantRole, other: AgentParticipantRole, round: number): string {
  return [
    `Round ${round}.`,
    `Reply to ${displayRole(other)}'s feedback on the implementation plan.`,
    "Revise the plan as needed. Keep it concrete: files, steps, and verification.",
    'If you now agree, say exactly "CONSENSUS: agreed" and summarize the final plan.'
  ].join(" ");
}

function planSummaryInstruction(role: AgentParticipantRole, other: AgentParticipantRole): string {
  return [
    `You are ${displayRole(role)}.`,
    `The planning discussion with ${displayRole(other)} reached the round cap without agreement.`,
    "Summarize the best remaining plan, the blocking disagreement, and why developer arbitration is needed before coding starts.",
    'Start with either "CONSENSUS: partial" or "CONSENSUS: unresolved".'
  ].join(" ");
}

function codingExecutionInstruction(role: AgentParticipantRole): string {
  return role === "codex"
    ? 'Implement the agreed plan now. Edit files directly, run the most relevant validation you can, and summarize the concrete changes. If the plan changed during implementation, say why.'
    : "Implement the agreed plan now. Edit files directly, verify the result, and call out any deviations from the plan.";
}

function postImplementationReviewInstruction(role: AgentParticipantRole, other: AgentParticipantRole): string {
  return [
    `You are ${displayRole(role)}.`,
    `Review ${displayRole(other)}'s completed implementation, not the original request.`,
    "Check correctness, regressions, test coverage, maintainability, and whether the implementation still matches the agreed plan.",
    'If it looks good, say "CONSENSUS: agreed" and briefly confirm why. If not, state the blocking issues clearly.'
  ].join(" ");
}

function finalCodingResponseInstruction(role: AgentParticipantRole, other: AgentParticipantRole): string {
  return [
    `You are ${displayRole(role)}.`,
    `Reply to ${displayRole(other)}'s implementation review.`,
    "If changes are needed, explain the fixes or remaining risks. If you agree with the review result, say CONSENSUS: agreed and summarize the final implementation state."
  ].join(" ");
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

function findLatestMessageSincePhase(
  messages: ChatMessage[],
  role: AgentParticipantRole,
  _phase: TaskPhase
): ChatMessage | undefined {
  return findLatestMessage(messages, role);
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
