import * as vscode from "vscode";
import * as path from "node:path";
import { captureEditorContext } from "./editorContext";
import { TaskManager } from "./taskManager";
import { getWebviewHtml } from "./webviewHtml";
import { AgentParticipantRole, AppSnapshot, CodeReferenceTarget, ContextScope, WorkMode } from "./types";

type IncomingMessage =
  | { type: "ready" }
  | { type: "submitPrompt"; value: string }
  | { type: "setMode"; value: WorkMode }
  | { type: "setPrimaryAgent"; value: AgentParticipantRole }
  | { type: "setSingleAgentMode"; value: boolean }
  | { type: "cancelTurn" }
  | { type: "clearChat" }
  | { type: "captureContext"; scope: ContextScope }
  | { type: "clearContext" }
  | { type: "openReference"; value: CodeReferenceTarget }
  | { type: "createTask" }
  | { type: "switchTask"; taskId: string }
  | { type: "closeTask"; taskId: string }
  | { type: "renameTask"; value: string };

export class AgentTalkViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "agentWorks.chatView";

  private view: vscode.WebviewView | undefined;
  private static preferredCodeColumn: vscode.ViewColumn = vscode.ViewColumn.One;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly taskManager: TaskManager
  ) {}

  static setPreferredCodeColumn(column: vscode.ViewColumn | undefined): void {
    if (column) {
      AgentTalkViewProvider.preferredCodeColumn = column;
    }
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "webview")]
    };

    this.render(this.taskManager.getSnapshot());

    webviewView.webview.onDidReceiveMessage(async (message: IncomingMessage) => {
      switch (message.type) {
        case "ready":
          await this.pushState(this.taskManager.getSnapshot());
          break;
        case "submitPrompt":
          await this.handlePrompt(message.value);
          break;
        case "setMode":
          await this.withActiveSession((session) => session.setMode(message.value));
          break;
        case "setPrimaryAgent":
          await this.withActiveSession((session) => session.setPrimaryAgent(message.value));
          break;
        case "setSingleAgentMode":
          await this.withActiveSession((session) => session.setSingleAgentMode(message.value));
          break;
        case "cancelTurn":
          await this.withActiveSession((session) => session.cancelCurrentTurn());
          break;
        case "clearChat":
          await this.withActiveSession((session) => session.clear());
          break;
        case "captureContext":
          await this.captureContext(message.scope);
          break;
        case "clearContext":
          await this.withActiveSession((session) => session.clearAttachedContext());
          break;
        case "openReference":
          await this.openReference(message.value);
          break;
        case "createTask":
          await this.pushState(this.taskManager.createTask());
          break;
        case "switchTask":
          await this.pushState(this.taskManager.switchTask(message.taskId));
          break;
        case "closeTask":
          await this.pushState(this.taskManager.closeTask(message.taskId));
          break;
        case "renameTask":
          await this.withActiveSession((session) => session.rename(message.value));
          break;
      }
    });
  }

  async reveal(): Promise<void> {
    let focused = await this.tryFocusView();
    if (!focused) {
      await this.tryExecuteCommand("workbench.action.focusAuxiliaryBar");
      focused = await this.tryFocusView();
    }
    if (!focused) {
      await this.tryExecuteCommand("workbench.action.toggleAuxiliaryBar");
      focused = await this.tryFocusView();
    }
    if (!focused) {
      await this.tryExecuteCommand("workbench.view.extension.agentWorksSecondary");
      focused = await this.tryFocusView();
    }
    if (!focused) {
      throw new Error(`AgentWorks could not reveal view ${AgentTalkViewProvider.viewId}.`);
    }
    if (this.view) {
      this.render(this.taskManager.getSnapshot());
    }
  }

  async attachActiveContext(scope: ContextScope): Promise<void> {
    await this.reveal();
    await this.captureContext(scope);
  }

  private render(snapshot: AppSnapshot): void {
    if (!this.view) {
      return;
    }

    this.view.webview.html = getWebviewHtml(this.view.webview, this.context.extensionUri, snapshot);
  }

  private async pushState(snapshot: AppSnapshot): Promise<void> {
    if (!this.view) {
      return;
    }

    await this.view.webview.postMessage({
      type: "stateUpdate",
      value: snapshot
    });
  }

  private async tryFocusView(): Promise<boolean> {
    return this.tryExecuteCommand(`${AgentTalkViewProvider.viewId}.focus`);
  }

  private async tryExecuteCommand(command: string): Promise<boolean> {
    try {
      await vscode.commands.executeCommand(command);
      return true;
    } catch {
      return false;
    }
  }

  private async handlePrompt(value: string): Promise<void> {
    if (!value.trim()) {
      return;
    }

    const active = this.taskManager.getActiveRecord();
    const turn = active.session.beginDeveloperTurn(value);
    await this.pushState(this.taskManager.getSnapshot());
    const _snapshot = await active.session.resolveDeveloperTurn(turn, async () => {
      await this.pushState(this.taskManager.getSnapshot());
    });
    await this.pushState(this.taskManager.getSnapshot());
  }

  private async captureContext(scope: ContextScope): Promise<void> {
    const context = captureEditorContext(scope);
    if (!context) {
      void vscode.window.showWarningMessage("AgentWorks could not find an active editor to attach as context.");
      return;
    }

    await this.withActiveSession((session) => session.setAttachedContext(context));
  }

  private async withActiveSession(action: (session: ReturnType<TaskManager["getActiveRecord"]>["session"]) => unknown): Promise<void> {
    const active = this.taskManager.getActiveRecord();
    action(active.session);
    await this.pushState(this.taskManager.getSnapshot());
  }

  private async openReference(target: CodeReferenceTarget): Promise<void> {
    const workspaceRoot =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? vscode.workspace.rootPath ?? process.cwd();
    const normalizedPath = target.path.trim();
    const absolutePath = path.isAbsolute(normalizedPath)
      ? normalizedPath
      : path.join(workspaceRoot, normalizedPath);

    try {
      const document = await vscode.workspace.openTextDocument(absolutePath);
      const editor = await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: false,
        viewColumn: AgentTalkViewProvider.preferredCodeColumn
      });
      const zeroBasedLine = Math.max(0, target.line - 1);
      const line = Math.min(zeroBasedLine, document.lineCount - 1);
      const position = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    } catch {
      void vscode.window.showWarningMessage(`AgentWorks could not open ${normalizedPath}:${target.line}.`);
    }
  }
}
