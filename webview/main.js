(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const state = window.__AGENT_TALK_STATE__;

  const ui = {
    tasks: state.tasks,
    activeTaskId: state.activeTaskId,
    activeTask: state.activeTask
  };
  const collapsedMessages = new Set();
  const collapsedProcesses = new Set();
  const draftsByTaskId = new Map();
  let renderQueued = false;

  function scheduleRender() {
    if (renderQueued) {
      return;
    }

    renderQueued = true;
    window.requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  function activeChat() {
    return ui.activeTask.chat;
  }

  function currentDraft() {
    return draftsByTaskId.get(ui.activeTaskId) ?? "";
  }

  function setCurrentDraft(value) {
    draftsByTaskId.set(ui.activeTaskId, value);
  }

  function render() {
    const chat = activeChat();
    const controlsDisabled = chat.isResponding ? "disabled" : "";
    const sendDisabled = chat.isResponding ? "disabled" : "";
    const cancelDisabled = !chat.isResponding || chat.isCancelling ? "disabled" : "";

    app.innerHTML = `
      <div class="app-shell">
        <section class="task-strip">
          <div class="task-scroller">
            ${ui.tasks.map(renderTaskTab).join("")}
          </div>
          <button id="createTaskButton" class="subtle task-create">New</button>
        </section>

        <main class="chat-stage">
          <section class="task-header">
            <input
              id="taskTitleInput"
              class="task-title-input"
              value="${escapeAttribute(ui.activeTask.title)}"
              ${chat.isResponding ? "disabled" : ""}
            />
            <div class="chip-stack">
              <span class="status-chip">${escapeHtml(chat.workflow.title)}</span>
              <span class="status-chip">${escapeHtml(renderPhaseLabel(chat.phase))}</span>
              <span class="status-chip ${chat.attachedContext ? "" : "muted"}">${escapeHtml(renderContextSummary())}</span>
            </div>
          </section>

          <section id="messages" class="chat-thread">
            ${chat.messages.map(renderMessage).join("")}
          </section>
        </main>

        <footer class="composer">
          <div class="control-dock control-dock-top">
            <div class="dock-fields">
              <label class="field compact">
                <span>Mode</span>
                <select id="modeSelect" ${controlsDisabled}>
                  ${renderModeOption("general", "General")}
                  ${renderModeOption("design", "Design")}
                  ${renderModeOption("coding", "Coding")}
                  ${renderModeOption("review", "Review")}
                </select>
              </label>
              <label class="field compact">
                <span>Primary</span>
                <select id="primaryAgentSelect" ${controlsDisabled}>
                  ${renderPrimaryAgentOption("codex", "Codex")}
                  ${renderPrimaryAgentOption("claude", "Claude")}
                </select>
              </label>
              <label class="field compact checkbox-field">
                <span>Solo</span>
                <input id="singleAgentModeToggle" type="checkbox" ${
                  chat.agentPreference.singleAgentMode ? "checked" : ""
                } ${controlsDisabled} />
              </label>
            </div>
            <div class="dock-actions">
              <button id="attachSelectionButton" class="subtle" ${controlsDisabled}>Selection</button>
              <button id="attachFileButton" class="subtle" ${controlsDisabled}>File</button>
              <button id="clearContextButton" class="subtle" ${controlsDisabled}>Detach</button>
              <button id="clearButton" class="subtle" ${controlsDisabled}>Clear</button>
              <button id="closeTaskButton" class="subtle" ${chat.isResponding ? "disabled" : ""}>Close Task</button>
            </div>
          </div>
          ${
            chat.isResponding
              ? `<div class="status-banner">${escapeHtml(statusBannerText(chat))}</div>`
              : ""
          }
          ${
            !chat.isResponding && chat.needsArbitration
              ? `<div class="status-banner arbitration-banner">${escapeHtml(
                  chat.arbitrationSummary ?? "The agents did not converge. Developer arbitration is needed."
                )}</div>`
              : ""
          }
          <textarea
            id="promptInput"
            rows="5"
            ${chat.isResponding ? "disabled" : ""}
            placeholder="${escapeHtml(placeholderForMode(chat.mode, chat.agentPreference.singleAgentMode, chat.phase))}"
          >${escapeHtml(currentDraft())}</textarea>
          <div class="composer-bar">
            <span class="helper">Shift+Enter sends. Enter inserts a newline.</span>
            <div class="composer-buttons">
              <button id="cancelButton" class="ghost" ${cancelDisabled}>${chat.isCancelling ? "Cancelling..." : "Cancel"}</button>
              <button id="sendButton" ${sendDisabled}>Send</button>
            </div>
          </div>
        </footer>
      </div>
    `;

    const promptInput = document.getElementById("promptInput");
    const sendButton = document.getElementById("sendButton");
    const cancelButton = document.getElementById("cancelButton");
    const clearButton = document.getElementById("clearButton");
    const modeSelect = document.getElementById("modeSelect");
    const primaryAgentSelect = document.getElementById("primaryAgentSelect");
    const singleAgentModeToggle = document.getElementById("singleAgentModeToggle");
    const attachSelectionButton = document.getElementById("attachSelectionButton");
    const attachFileButton = document.getElementById("attachFileButton");
    const clearContextButton = document.getElementById("clearContextButton");
    const createTaskButton = document.getElementById("createTaskButton");
    const closeTaskButton = document.getElementById("closeTaskButton");
    const taskTitleInput = document.getElementById("taskTitleInput");

    if (sendButton) {
      sendButton.addEventListener("click", submit);
    }
    if (cancelButton) {
      cancelButton.addEventListener("click", () => {
        if (!chat.isResponding || chat.isCancelling) {
          return;
        }
        vscode.postMessage({ type: "cancelTurn" });
      });
    }
    if (clearButton) {
      clearButton.addEventListener("click", () => vscode.postMessage({ type: "clearChat" }));
    }
    if (modeSelect) {
      modeSelect.addEventListener("change", (event) => {
        vscode.postMessage({ type: "setMode", value: event.target.value });
      });
    }
    if (primaryAgentSelect) {
      primaryAgentSelect.addEventListener("change", (event) => {
        vscode.postMessage({ type: "setPrimaryAgent", value: event.target.value });
      });
    }
    if (singleAgentModeToggle) {
      singleAgentModeToggle.addEventListener("change", (event) => {
        vscode.postMessage({ type: "setSingleAgentMode", value: event.target.checked });
      });
    }
    if (attachSelectionButton) {
      attachSelectionButton.addEventListener("click", () => {
        vscode.postMessage({ type: "captureContext", scope: "selection" });
      });
    }
    if (attachFileButton) {
      attachFileButton.addEventListener("click", () => {
        vscode.postMessage({ type: "captureContext", scope: "file" });
      });
    }
    if (clearContextButton) {
      clearContextButton.addEventListener("click", () => {
        vscode.postMessage({ type: "clearContext" });
      });
    }
    if (createTaskButton) {
      createTaskButton.addEventListener("click", () => {
        vscode.postMessage({ type: "createTask" });
      });
    }
    if (closeTaskButton) {
      closeTaskButton.addEventListener("click", () => {
        vscode.postMessage({ type: "closeTask", taskId: ui.activeTaskId });
      });
    }
    if (taskTitleInput) {
      taskTitleInput.addEventListener("change", (event) => {
        vscode.postMessage({ type: "renameTask", value: event.target.value });
      });
    }
    if (promptInput) {
      promptInput.addEventListener("input", () => {
        setCurrentDraft(promptInput.value);
      });
      promptInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && event.shiftKey) {
          event.preventDefault();
          submit();
        }
      });
    }

    scrollMessagesToBottom();
  }

  function submit() {
    const chat = activeChat();
    if (chat.isResponding) {
      return;
    }

    const promptInput = document.getElementById("promptInput");
    const value = promptInput.value.trim();
    if (!value) {
      return;
    }

    vscode.postMessage({ type: "submitPrompt", value });
    setCurrentDraft("");
    promptInput.value = "";
  }

  function renderTaskTab(task) {
    const activeClass = task.id === ui.activeTaskId ? "is-active" : "";
    const busyClass = task.isResponding ? "is-busy" : "";
    const arbitrationMark = task.needsArbitration ? `<span class="task-badge arbitration">!</span>` : "";
    const busyMark = task.isResponding ? `<span class="task-badge">●</span>` : "";

    return `
      <button class="task-tab ${activeClass} ${busyClass}" data-task-id="${escapeHtml(task.id)}">
        <span class="task-tab-title">${escapeHtml(task.title)}</span>
        ${busyMark}
        ${arbitrationMark}
      </button>
    `;
  }

  function renderModeOption(value, label) {
    return `<option value="${value}" ${activeChat().mode === value ? "selected" : ""}>${label}</option>`;
  }

  function renderPrimaryAgentOption(value, label) {
    return `<option value="${value}" ${activeChat().agentPreference.primaryAgent === value ? "selected" : ""}>${label}</option>`;
  }

  function renderMessage(message) {
    const body = message.content
      ? `${formatBody(message.content)}${message.isStreaming ? `<span class="caret"></span>` : ""}`
      : message.isStreaming
        ? `<span class="stream-placeholder">Thinking...</span><span class="caret"></span>`
        : "";
    const isCollapsed = collapsedMessages.has(message.id);
    const processCollapsed = collapsedProcesses.has(message.id);
    const hasBody = Boolean(message.content);
    const processEvents = message.processEvents ?? [];

    return `
      <article class="message-row role-${message.role}">
        <div class="message-card ${message.isStreaming ? "is-streaming" : ""}">
          <div class="message-meta">
            <span class="author">${escapeHtml(message.author)}</span>
            <span class="pill">${escapeHtml(message.mode)}</span>
            <span class="time">${formatTime(message.timestamp)}</span>
            ${message.durationMs ? `<span class="status-chip">${escapeHtml(formatDuration(message.durationMs))}</span>` : ""}
            ${message.isStreaming ? `<span class="stream-pill">Streaming</span>` : ""}
          </div>
          ${message.attachedContext ? `<div class="message-context">${escapeHtml(formatContextChip(message.attachedContext))}</div>` : ""}
          <div class="message-body ${isCollapsed ? "is-collapsed" : ""}">${body}</div>
          ${
            hasBody
              ? `<div class="message-actions"><button class="subtle message-toggle" data-message-id="${escapeHtml(
                  message.id
                )}">${isCollapsed ? "Expand" : "Collapse"}</button></div>`
              : ""
          }
          ${
            processEvents.length
              ? `
                <section class="process-log ${processCollapsed ? "is-collapsed" : ""}">
                  <div class="process-header">
                    <span>Process</span>
                    <button class="subtle process-toggle" data-message-id="${escapeHtml(message.id)}">${
                      processCollapsed ? "Show" : "Hide"
                    }</button>
                  </div>
                  <div class="process-items">
                    ${processEvents.map(renderProcessEvent).join("")}
                  </div>
                </section>
              `
              : ""
          }
        </div>
      </article>
    `;
  }

  function renderProcessEvent(event) {
    return `
      <div class="process-item status-${escapeHtml(event.status)}">
        <div class="process-summary">${escapeHtml(event.summary)}</div>
        ${event.detail ? `<div class="process-detail">${escapeHtml(event.detail)}</div>` : ""}
      </div>
    `;
  }

  function renderContextSummary() {
    const attachedContext = activeChat().attachedContext;
    if (!attachedContext) {
      return "No attached context";
    }

    return formatContextChip(attachedContext);
  }

  function renderPhaseLabel(phase) {
    switch (phase) {
      case "planning":
        return "Planning";
      case "implementing":
        return "Coding";
      case "reviewing":
        return "Review";
      case "arbitration":
        return "Arbitration";
      default:
        return "Idle";
    }
  }

  function formatContextChip(context) {
    const parts = [
      context.relativePath,
      context.scope === "selection" ? "selection" : "file",
      `L${context.lineStart + 1}-${context.lineEnd + 1}`
    ];
    if (context.truncated) {
      parts.push("trimmed");
    }
    return parts.join(" • ");
  }

  function placeholderForMode(mode, singleAgentMode, phase) {
    if (singleAgentMode) {
      return `${capitalize(activeChat().agentPreference.primaryAgent)} will handle this task alone.`;
    }

    if (mode === "coding") {
      if (phase === "planning") {
        return `${capitalize(activeChat().agentPreference.primaryAgent)} will align on a plan first, then code, then the other agent will review.`;
      }
      return `${capitalize(activeChat().agentPreference.primaryAgent)} will code after plan alignment, and the other agent will review the implementation.`;
    }

    switch (mode) {
      case "design":
        return `${capitalize(activeChat().agentPreference.primaryAgent)} speaks first. The other agent will still respond, even if the response is just LGTM.`;
      case "review":
        return `${capitalize(activeChat().agentPreference.primaryAgent)} will start the review, and the other agent will always leave feedback.`;
      default:
        return `${capitalize(activeChat().agentPreference.primaryAgent)} will answer first, and the other agent will always respond before the thread ends.`;
    }
  }

  function statusBannerText(chat) {
    if (chat.isCancelling) {
      return "Cancelling the current discussion...";
    }

    if (chat.mode === "coding") {
      switch (chat.phase) {
        case "planning":
          return "The agents are discussing the implementation plan before code changes begin.";
        case "implementing":
          return `${capitalize(chat.agentPreference.primaryAgent)} is implementing the agreed plan.`;
        case "reviewing":
          return "The implementation is being reviewed against the agreed plan and recent changes.";
        default:
          break;
      }
    }

    return `${capitalize(chat.agentPreference.primaryAgent)} is leading. The other agent will always respond before the thread stops.`;
  }

  function formatBody(text) {
    return linkifyCodeReferences(escapeHtml(text)).replace(/\n/g, "<br>");
  }

  function linkifyCodeReferences(text) {
    const pattern = /(^|[\s(>])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+):(\d+)\b/g;
    return text.replace(pattern, (match, prefix, refPath, line) => {
      const encodedPath = encodeURIComponent(refPath);
      const encodedLine = encodeURIComponent(line);
      return `${prefix}<button class="code-ref" data-path="${encodedPath}" data-line="${encodedLine}">${refPath}:${line}</button>`;
    });
  }

  function formatTime(timestamp) {
    try {
      return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }

  function formatDuration(durationMs) {
    if (durationMs < 1000) {
      return `${durationMs} ms`;
    }
    return `${(durationMs / 1000).toFixed(1)} s`;
  }

  function capitalize(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeAttribute(text) {
    return escapeHtml(text).replace(/\n/g, " ");
  }

  function scrollMessagesToBottom() {
    const messages = document.getElementById("messages");
    if (messages) {
      messages.scrollTop = messages.scrollHeight;
    }
  }

  app.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const taskTab = target.closest(".task-tab");
    if (taskTab instanceof HTMLElement && taskTab.dataset.taskId) {
      vscode.postMessage({ type: "switchTask", taskId: taskTab.dataset.taskId });
      return;
    }

    if (!target.classList.contains("code-ref")) {
      if (target.classList.contains("message-toggle")) {
        const messageId = target.dataset.messageId;
        if (!messageId) {
          return;
        }
        if (collapsedMessages.has(messageId)) {
          collapsedMessages.delete(messageId);
        } else {
          collapsedMessages.add(messageId);
        }
        scheduleRender();
        return;
      }

      if (target.classList.contains("process-toggle")) {
        const messageId = target.dataset.messageId;
        if (!messageId) {
          return;
        }
        if (collapsedProcesses.has(messageId)) {
          collapsedProcesses.delete(messageId);
        } else {
          collapsedProcesses.add(messageId);
        }
        scheduleRender();
        return;
      }

      return;
    }

    const refPath = target.dataset.path;
    const refLine = target.dataset.line;
    if (!refPath || !refLine) {
      return;
    }

    vscode.postMessage({
      type: "openReference",
      value: {
        path: decodeURIComponent(refPath),
        line: Number(decodeURIComponent(refLine))
      }
    });
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type !== "stateUpdate") {
      return;
    }

    ui.tasks = message.value.tasks;
    ui.activeTaskId = message.value.activeTaskId;
    ui.activeTask = message.value.activeTask;
    scheduleRender();
  });

  render();
  vscode.postMessage({ type: "ready" });
})();
