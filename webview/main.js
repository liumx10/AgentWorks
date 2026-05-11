(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const state = window.__AGENT_TALK_STATE__;
  const persistedState = vscode.getState() ?? {};

  const ui = {
    tasks: state.tasks,
    activeTaskId: state.activeTaskId,
    activeTask: state.activeTask,
    taskListOpen: Boolean(persistedState.taskListOpen)
  };
  const collapsedMessages = new Set();
  const expandedProcesses = new Set();
  const seenProcessEventIds = new Set();
  const draftsByTaskId = new Map();
  const visibleProcessEventLimit = 8;
  let openSelectId = null;
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

  function setTaskListOpen(value) {
    ui.taskListOpen = value;
    vscode.setState({ taskListOpen: value });
  }

  function render() {
    const chat = activeChat();
    const controlsDisabled = chat.isResponding ? "disabled" : "";
    const sendDisabled = chat.isResponding ? "disabled" : "";
    const cancelDisabled = !chat.isResponding || chat.isCancelling ? "disabled" : "";
    const taskListLabel = ui.taskListOpen ? "Back to current task" : "Show task list";

    app.innerHTML = `
      <div class="app-shell">
        <section class="task-panel">
          <div class="task-line">
            <button
              id="toggleTaskListButton"
              class="subtle icon-button"
              aria-label="${escapeAttribute(taskListLabel)}"
              title="${escapeAttribute(taskListLabel)}"
            >←</button>
            <input
              id="taskTitleInput"
              class="task-title-input"
              value="${escapeAttribute(ui.activeTask.title)}"
              ${chat.isResponding ? "disabled" : ""}
            />
          </div>
          ${
            ui.taskListOpen
              ? `
                <div class="task-list-panel">
                  <div class="task-list-toolbar">
                    <span class="task-list-label">Tasks</span>
                    <button id="createTaskButton" class="subtle compact-button">New</button>
                  </div>
                  <div class="task-list">
                    ${ui.tasks.map(renderTaskListItem).join("")}
                  </div>
                </div>
              `
              : ""
          }
          <div class="task-meta-row">
            <span class="status-chip">${escapeHtml(chat.workflow.title)}</span>
            <span class="status-chip">${escapeHtml(renderPhaseLabel(chat.phase))}</span>
            <span class="status-chip ${chat.attachedContext ? "" : "muted"}">${escapeHtml(renderContextSummary())}</span>
          </div>
        </section>

        <main class="chat-stage">
          <section id="messages" class="chat-thread">
            ${chat.messages.map(renderMessage).join("")}
          </section>
        </main>

        <footer class="composer">
          <div class="control-dock control-dock-top">
            <div class="dock-fields">
              ${renderControlSelect("mode", "Mode", chat.mode, [
                { value: "general", label: "General" },
                { value: "design", label: "Design" },
                { value: "coding", label: "Coding" },
                { value: "review", label: "Review" }
              ], chat.isResponding)}
              ${renderControlSelect("primaryAgent", "Primary", chat.agentPreference.primaryAgent, [
                { value: "codex", label: "Codex" },
                { value: "claude", label: "Claude" }
              ], chat.isResponding)}
              ${renderControlSelect(
                "workMode",
                "Work",
                chat.agentPreference.singleAgentMode ? "solo" : "interactive",
                [
                  { value: "solo", label: "Solo" },
                  { value: "interactive", label: "Interactive" }
                ],
                chat.isResponding
              )}
            </div>
            <div class="dock-actions">
              <button id="attachSelectionButton" class="subtle" ${controlsDisabled}>Selection</button>
              <button id="attachFileButton" class="subtle" ${controlsDisabled}>File</button>
              <button id="clearContextButton" class="subtle" ${controlsDisabled}>Detach</button>
              <button id="clearButton" class="subtle" ${controlsDisabled}>Clear</button>
              <button id="closeTaskButton" class="subtle" ${chat.isResponding ? "disabled" : ""}>Close</button>
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
    const attachSelectionButton = document.getElementById("attachSelectionButton");
    const attachFileButton = document.getElementById("attachFileButton");
    const clearContextButton = document.getElementById("clearContextButton");
    const toggleTaskListButton = document.getElementById("toggleTaskListButton");
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
    if (toggleTaskListButton) {
      toggleTaskListButton.addEventListener("click", () => {
        setTaskListOpen(!ui.taskListOpen);
        scheduleRender();
      });
    }
    if (createTaskButton) {
      createTaskButton.addEventListener("click", () => {
        setTaskListOpen(false);
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

    scrollProcessWindowsToBottom();
    scrollMessagesToBottom();
    rememberRenderedProcessEvents(chat);
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

  function renderTaskListItem(task) {
    const activeClass = task.id === ui.activeTaskId ? "is-active" : "";
    const statusText = task.needsArbitration
      ? "Needs arbitration"
      : task.isResponding
        ? "Running"
        : "";

    return `
      <button class="task-item ${activeClass}" data-task-id="${escapeHtml(task.id)}">
        <span class="task-item-title">${escapeHtml(task.title)}</span>
        ${statusText ? `<span class="task-item-meta">${escapeHtml(statusText)}</span>` : ""}
      </button>
    `;
  }

  function renderControlSelect(id, title, currentValue, options, disabled) {
    const currentOption = options.find((option) => option.value === currentValue) ?? options[0];
    const isOpen = openSelectId === id && !disabled;
    const disabledAttribute = disabled ? "disabled" : "";

    return `
      <div class="field control-select ${isOpen ? "is-open" : ""}" data-select-id="${escapeAttribute(id)}">
        <button
          type="button"
          class="select-trigger"
          aria-label="${escapeAttribute(title)}"
          aria-haspopup="listbox"
          aria-expanded="${isOpen ? "true" : "false"}"
          data-select-trigger="${escapeAttribute(id)}"
          ${disabledAttribute}
        >
          <span>${escapeHtml(currentOption.label)}</span>
          <span class="select-caret">▾</span>
        </button>
        ${
          isOpen
            ? `
              <div class="select-menu" role="listbox" aria-label="${escapeAttribute(title)} options">
                <div class="select-menu-title">${escapeHtml(title)}</div>
                ${options
                  .map(
                    (option) => `
                      <button
                        type="button"
                        class="select-option ${option.value === currentValue ? "is-selected" : ""}"
                        role="option"
                        aria-selected="${option.value === currentValue ? "true" : "false"}"
                        data-select-option="${escapeAttribute(id)}"
                        data-select-value="${escapeAttribute(option.value)}"
                      >${escapeHtml(option.label)}</button>
                    `
                  )
                  .join("")}
              </div>
            `
            : ""
        }
      </div>
    `;
  }

  function renderMessage(message) {
    const body = message.content
      ? `${formatBody(message.content)}${message.isStreaming ? `<span class="caret"></span>` : ""}`
      : message.isStreaming
        ? `<span class="stream-placeholder">Thinking...</span><span class="caret"></span>`
        : "";
    const isCollapsed = collapsedMessages.has(message.id);
    const processExpanded = message.isStreaming || expandedProcesses.has(message.id);
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
          ${processEvents.length ? renderProcessLog(message, processEvents, processExpanded) : ""}
        </div>
      </article>
    `;
  }

  function renderProcessLog(message, processEvents, processExpanded) {
    const hiddenCount = Math.max(0, processEvents.length - visibleProcessEventLimit);
    const visibleEvents = hiddenCount ? processEvents.slice(hiddenCount) : processEvents;

    return `
      <section class="process-log ${processExpanded ? "" : "is-collapsed"} ${message.isStreaming ? "is-live" : ""}">
        <div class="process-header">
          <span class="process-title">
            <span>Process</span>
            <span class="process-count">${processEvents.length}</span>
          </span>
          <button class="subtle process-toggle" data-message-id="${escapeHtml(message.id)}">${
            processExpanded ? "Hide" : "Show"
          }</button>
        </div>
        <div class="process-window">
          <div class="process-items" data-process-window>
            ${
              hiddenCount
                ? `<div class="process-folded">${hiddenCount} earlier ${hiddenCount === 1 ? "step" : "steps"} folded</div>`
                : ""
            }
            ${visibleEvents.map(renderProcessEvent).join("")}
          </div>
        </div>
      </section>
    `;
  }

  function renderProcessEvent(event) {
    const newClass = seenProcessEventIds.has(event.id) ? "" : "is-new";

    return `
      <div class="process-item status-${escapeHtml(event.status)} ${newClass}">
        <div class="process-summary">
          <span class="process-dot"></span>
          <span>${escapeHtml(event.summary)}</span>
        </div>
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
    return linkifyCodeReferences(text).replace(/\n/g, "<br>");
  }

  function linkifyCodeReferences(text) {
    const matches = collectCodeReferenceMatches(text);
    if (matches.length === 0) {
      return escapeHtml(text);
    }

    let cursor = 0;
    let result = "";
    for (const match of matches) {
      if (match.start < cursor) {
        continue;
      }

      result += escapeHtml(text.slice(cursor, match.start));
      result += renderCodeReference(match.label, match.path, match.line);
      cursor = match.end;
    }

    result += escapeHtml(text.slice(cursor));
    return result;
  }

  function collectCodeReferenceMatches(text) {
    const matches = [];
    const seenRanges = [];

    const markdownAnglePattern = /\[([^\]\n]+)\]\(<([^>\n]+):(\d+)>\)/g;
    const markdownPlainPattern = /\[([^\]\n]+)\]\(((?:\.{1,2}\/|\/)?[^)\s]+):(\d+)\)/g;
    const barePattern = /(^|[\s(>])((?:\.{1,2}\/|\/)?(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@.-]+\.[A-Za-z0-9_-]+):(\d+)\b/g;

    collectMatches(markdownAnglePattern, text, (match) => {
      const [, label, refPath, line] = match;
      return {
        start: match.index,
        end: match.index + match[0].length,
        label,
        path: refPath,
        line: Number(line)
      };
    });

    collectMatches(markdownPlainPattern, text, (match) => {
      const [, label, refPath, line] = match;
      return {
        start: match.index,
        end: match.index + match[0].length,
        label,
        path: refPath,
        line: Number(line)
      };
    });

    collectMatches(barePattern, text, (match) => {
      const [, prefix, refPath, line] = match;
      const start = match.index + prefix.length;
      return {
        start,
        end: start + `${refPath}:${line}`.length,
        label: `${refPath}:${line}`,
        path: refPath,
        line: Number(line)
      };
    });

    matches.sort((left, right) => left.start - right.start);
    return matches;

    function collectMatches(pattern, value, toMatch) {
      let match;
      while ((match = pattern.exec(value)) !== null) {
        const candidate = toMatch(match);
        if (!isValidCodeReference(candidate.path, candidate.line)) {
          continue;
        }
        if (seenRanges.some((range) => candidate.start < range.end && candidate.end > range.start)) {
          continue;
        }
        seenRanges.push({ start: candidate.start, end: candidate.end });
        matches.push(candidate);
      }
    }
  }

  function isValidCodeReference(refPath, line) {
    if (!Number.isInteger(line) || line <= 0) {
      return false;
    }

    const normalized = refPath.trim();
    if (!normalized || /^[a-z]+:\/\//i.test(normalized)) {
      return false;
    }

    return /(?:^|\/)[^/\n]+\.[A-Za-z0-9_-]+$/.test(normalized);
  }

  function renderCodeReference(label, refPath, line) {
    const encodedPath = encodeURIComponent(refPath);
    const encodedLine = encodeURIComponent(String(line));
    return `<button class="code-ref" data-path="${encodedPath}" data-line="${encodedLine}">${escapeHtml(label)}</button>`;
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

  function scrollProcessWindowsToBottom() {
    for (const processWindow of document.querySelectorAll("[data-process-window]")) {
      processWindow.scrollTop = processWindow.scrollHeight;
    }
  }

  function rememberRenderedProcessEvents(chat) {
    for (const message of chat.messages) {
      for (const event of message.processEvents ?? []) {
        seenProcessEventIds.add(event.id);
      }
    }
  }

  app.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const selectTrigger = target.closest(".select-trigger");
    if (selectTrigger instanceof HTMLElement) {
      const selectId = selectTrigger.dataset.selectTrigger;
      if (!selectId || selectTrigger.hasAttribute("disabled")) {
        return;
      }
      openSelectId = openSelectId === selectId ? null : selectId;
      scheduleRender();
      return;
    }

    const selectOption = target.closest(".select-option");
    if (selectOption instanceof HTMLElement) {
      const selectId = selectOption.dataset.selectOption;
      const value = selectOption.dataset.selectValue;
      if (!selectId || value === undefined) {
        return;
      }

      openSelectId = null;
      if (selectId === "mode") {
        vscode.postMessage({ type: "setMode", value });
      } else if (selectId === "primaryAgent") {
        vscode.postMessage({ type: "setPrimaryAgent", value });
      } else if (selectId === "workMode") {
        vscode.postMessage({ type: "setSingleAgentMode", value: value === "solo" });
      }
      scheduleRender();
      return;
    }

    if (openSelectId && !target.closest(".control-select")) {
      openSelectId = null;
      scheduleRender();
    }

    const taskItem = target.closest(".task-item");
    if (taskItem instanceof HTMLElement && taskItem.dataset.taskId) {
      setTaskListOpen(false);
      vscode.postMessage({ type: "switchTask", taskId: taskItem.dataset.taskId });
      return;
    }

    const codeRef = target.closest(".code-ref");
    if (!(codeRef instanceof HTMLElement)) {
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
        if (expandedProcesses.has(messageId)) {
          expandedProcesses.delete(messageId);
        } else {
          expandedProcesses.add(messageId);
        }
        scheduleRender();
        return;
      }

      return;
    }

    const refPath = codeRef.dataset.path;
    const refLine = codeRef.dataset.line;
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

  app.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !openSelectId) {
      return;
    }

    openSelectId = null;
    scheduleRender();
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type !== "stateUpdate") {
      return;
    }

    ui.tasks = message.value.tasks;
    ui.activeTaskId = message.value.activeTaskId;
    ui.activeTask = message.value.activeTask;

    for (const chatTask of ui.tasks) {
      for (const chatMessage of chatTask.chat.messages) {
        if (chatMessage.isStreaming) {
          expandedProcesses.delete(chatMessage.id);
        }
      }
    }

    scheduleRender();
  });

  render();
  vscode.postMessage({ type: "ready" });
})();
