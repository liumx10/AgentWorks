import * as vscode from "vscode";
import { AppSnapshot } from "./types";

export function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, snapshot: AppSnapshot): string {
  const nonce = createNonce();
  const initialState = JSON.stringify(snapshot).replace(/</g, "\\u003c");
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "webview", "main.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "webview", "styles.css"));

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}">
    <title>AgentWorks</title>
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${nonce}">
      window.__AGENT_TALK_STATE__ = ${initialState};
    </script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
