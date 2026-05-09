import * as vscode from "vscode";
import * as path from "node:path";
import { ChatSession } from "./chatSession";
import { captureEditorContext } from "./editorContext";
import { getWebviewHtml } from "./webviewHtml";
import { AgentParticipantRole, ChatSnapshot, CodeReferenceTarget, ContextScope, WorkMode } from "./types";

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
  | { type: "openReference"; value: CodeReferenceTarget };

export class AgentTalkViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "agentWorks.chatView";

  private view: vscode.WebviewView | undefined;
  private static preferredCodeColumn: vscode.ViewColumn = vscode.ViewColumn.One;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly session: ChatSession
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

    this.render(this.session.getSnapshot());

    webviewView.webview.onDidReceiveMessage(async (message: IncomingMessage) => {
      switch (message.type) {
        case "ready":
          await this.pushState(this.session.getSnapshot());
          break;
        case "submitPrompt":
          await this.handlePrompt(message.value);
          break;
        case "setMode":
          await this.pushState(this.session.setMode(message.value));
          break;
        case "setPrimaryAgent":
          await this.pushState(this.session.setPrimaryAgent(message.value));
          break;
        case "setSingleAgentMode":
          await this.pushState(this.session.setSingleAgentMode(message.value));
          break;
        case "cancelTurn":
          await this.pushState(this.session.cancelCurrentTurn());
          break;
        case "clearChat":
          await this.pushState(this.session.clear());
          break;
        case "captureContext":
          await this.captureContext(message.scope);
          break;
        case "clearContext":
          await this.pushState(this.session.clearAttachedContext());
          break;
        case "openReference":
          await this.openReference(message.value);
          break;
      }
    });
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.extension.agentWorksSecondary");
    await vscode.commands.executeCommand(`${AgentTalkViewProvider.viewId}.focus`);
    if (this.view) {
      this.render(this.session.getSnapshot());
    }
  }

  async attachActiveContext(scope: ContextScope): Promise<void> {
    await this.reveal();
    await this.captureContext(scope);
  }

  private render(snapshot: ChatSnapshot): void {
    if (!this.view) {
      return;
    }

    this.view.webview.html = getWebviewHtml(this.view.webview, this.context.extensionUri, snapshot);
  }

  private async pushState(snapshot: ChatSnapshot): Promise<void> {
    if (!this.view) {
      return;
    }

    await this.view.webview.postMessage({
      type: "stateUpdate",
      value: snapshot
    });
  }

  private async handlePrompt(value: string): Promise<void> {
    if (!value.trim()) {
      return;
    }

    const turn = this.session.beginDeveloperTurn(value);
    await this.pushState(this.session.getSnapshot());
    const snapshot = await this.session.resolveDeveloperTurn(turn, async (nextSnapshot) => {
      await this.pushState(nextSnapshot);
    });
    await this.pushState(snapshot);
  }

  private async captureContext(scope: ContextScope): Promise<void> {
    const context = captureEditorContext(scope);
    if (!context) {
      void vscode.window.showWarningMessage("AgentWorks could not find an active editor to attach as context.");
      return;
    }

    await this.pushState(this.session.setAttachedContext(context));
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
