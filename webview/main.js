(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const state = window.__AGENT_TALK_STATE__;

  const ui = {
    mode: state.mode,
    messages: state.messages,
    attachedContext: state.attachedContext,
    workflow: state.workflow,
    agentPreference: state.agentPreference,
    isResponding: state.isResponding,
    isCancelling: state.isCancelling,
    needsArbitration: state.needsArbitration,
    arbitrationSummary: state.arbitrationSummary
  };
  const collapsedMessages = new Set();
  const collapsedProcesses = new Set();
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

  function render() {
    const controlsDisabled = ui.isResponding ? "disabled" : "";
    const sendDisabled = ui.isResponding ? "disabled" : "";
    const cancelDisabled = !ui.isResponding || ui.isCancelling ? "disabled" : "";

    app.innerHTML = `
      <div class="app-shell">
        <header class="chat-header">
          <p class="eyebrow">AgentWorks</p>
          <div class="header-line">
            <h1>Discussion</h1>
            <div class="chip-stack">
              <span class="status-chip">${escapeHtml(ui.workflow.title)}</span>
              <span class="status-chip ${ui.attachedContext ? "" : "muted"}">${escapeHtml(renderContextSummary())}</span>
            </div>
          </div>
        </header>

        <main id="messages" class="chat-thread">
          ${ui.messages.map(renderMessage).join("")}
        </main>

        <footer class="composer">
          <div class="control-dock">
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
                  ui.agentPreference.singleAgentMode ? "checked" : ""
                } ${controlsDisabled} />
              </label>
            </div>
            <div class="dock-actions">
              <button id="attachSelectionButton" class="subtle" ${controlsDisabled}>Selection</button>
              <button id="attachFileButton" class="subtle" ${controlsDisabled}>File</button>
              <button id="clearContextButton" class="subtle" ${controlsDisabled}>Detach</button>
              <button id="clearButton" class="subtle" ${controlsDisabled}>Clear</button>
            </div>
          </div>
          ${
            ui.isResponding
              ? `<div class="status-banner">${escapeHtml(
                  ui.isCancelling
                    ? "Cancelling the current discussion..."
                    : `${capitalize(ui.agentPreference.primaryAgent)} is leading. The other agent will always respond before the thread stops.`
                )}</div>`
              : ""
          }
          ${
            !ui.isResponding && ui.needsArbitration
              ? `<div class="status-banner arbitration-banner">${escapeHtml(
                  ui.arbitrationSummary ?? "The agents did not converge. Developer arbitration is needed."
                )}</div>`
              : ""
          }
          <textarea
            id="promptInput"
            rows="5"
            ${ui.isResponding ? "disabled" : ""}
            placeholder="${escapeHtml(placeholderForMode(ui.mode))}"
          ></textarea>
          <div class="composer-bar">
            <span class="helper">Shift+Enter sends. Enter inserts a newline.</span>
            <div class="composer-buttons">
              <button id="cancelButton" class="ghost" ${cancelDisabled}>${ui.isCancelling ? "Cancelling..." : "Cancel"}</button>
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

    if (sendButton) {
      sendButton.addEventListener("click", submit);
    }
    if (cancelButton) {
      cancelButton.addEventListener("click", () => {
        if (!ui.isResponding || ui.isCancelling) {
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
    if (promptInput) {
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
    if (ui.isResponding) {
      return;
    }

    const promptInput = document.getElementById("promptInput");
    const value = promptInput.value.trim();
    if (!value) {
      return;
    }

    vscode.postMessage({ type: "submitPrompt", value });
    promptInput.value = "";
  }

  function renderModeOption(value, label) {
    return `<option value="${value}" ${ui.mode === value ? "selected" : ""}>${label}</option>`;
  }

  function renderPrimaryAgentOption(value, label) {
    return `<option value="${value}" ${ui.agentPreference.primaryAgent === value ? "selected" : ""}>${label}</option>`;
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
    if (!ui.attachedContext) {
      return "No attached context";
    }

    return formatContextChip(ui.attachedContext);
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

  function placeholderForMode(mode) {
    switch (mode) {
      case "design":
        return ui.agentPreference.singleAgentMode
          ? `${capitalize(ui.agentPreference.primaryAgent)} works alone on this design task.`
          : `${capitalize(ui.agentPreference.primaryAgent)} speaks first. The other agent will still respond, even if the response is just LGTM.`;
      case "coding":
        return ui.agentPreference.singleAgentMode
          ? `${capitalize(ui.agentPreference.primaryAgent)} works alone on this implementation task.`
          : `${capitalize(ui.agentPreference.primaryAgent)} will open the implementation discussion, then the other agent will critique or approve it.`;
      case "review":
        return ui.agentPreference.singleAgentMode
          ? `${capitalize(ui.agentPreference.primaryAgent)} handles this review alone.`
          : `${capitalize(ui.agentPreference.primaryAgent)} will start the review, and the other agent will always leave feedback.`;
      default:
        return ui.agentPreference.singleAgentMode
          ? `${capitalize(ui.agentPreference.primaryAgent)} will answer this task alone.`
          : `${capitalize(ui.agentPreference.primaryAgent)} will answer first, and the other agent will always respond before the thread ends.`;
    }
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
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
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

    ui.messages = message.value.messages;
    ui.mode = message.value.mode;
    ui.attachedContext = message.value.attachedContext;
    ui.workflow = message.value.workflow;
    ui.agentPreference = message.value.agentPreference;
    ui.isResponding = message.value.isResponding;
    ui.isCancelling = message.value.isCancelling;
    ui.needsArbitration = message.value.needsArbitration;
    ui.arbitrationSummary = message.value.arbitrationSummary;
    scheduleRender();
  });

  render();
  vscode.postMessage({ type: "ready" });
})();
