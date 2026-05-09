import * as vscode from "vscode";
import { ChatSession } from "./chatSession";
import { createProviders } from "./providers";
import { AgentTalkViewProvider } from "./viewProvider";

export function activate(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration("agentWorks");
  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? vscode.workspace.rootPath ?? process.cwd();
  const session = new ChatSession(createProviders(config, workspaceRoot));
  const viewProvider = new AgentTalkViewProvider(context, session);
  AgentTalkViewProvider.setPreferredCodeColumn(vscode.window.activeTextEditor?.viewColumn);

  const activeEditorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
    AgentTalkViewProvider.setPreferredCodeColumn(editor?.viewColumn);
  });

  const viewRegistration = vscode.window.registerWebviewViewProvider(AgentTalkViewProvider.viewId, viewProvider, {
    webviewOptions: {
      retainContextWhenHidden: true
    }
  });

  const openChat = vscode.commands.registerCommand("agentWorks.openChat", async () => {
    await viewProvider.reveal();
  });

  const openChatWithSelection = vscode.commands.registerCommand("agentWorks.openChatWithSelection", async () => {
    await viewProvider.attachActiveContext("selection");
  });

  const openChatWithFile = vscode.commands.registerCommand("agentWorks.openChatWithFile", async () => {
    await viewProvider.attachActiveContext("file");
  });

  context.subscriptions.push(activeEditorListener, viewRegistration, openChat, openChatWithSelection, openChatWithFile);
}

export function deactivate(): void {
  // No-op.
}
