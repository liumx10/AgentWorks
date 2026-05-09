import * as vscode from "vscode";
import { AttachedContext, ContextScope } from "./types";

const MAX_CONTEXT_CHARS = 12000;
const MAX_SELECTION_LINES = 180;
const CURSOR_CONTEXT_RADIUS = 50;
const FILE_HEAD_LINES = 35;
const FILE_TAIL_LINES = 35;

export function captureEditorContext(
  scope: ContextScope,
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor
): AttachedContext | undefined {
  if (!editor) {
    return undefined;
  }

  const document = editor.document;
  const relativePath = vscode.workspace.asRelativePath(document.uri, false);
  const absolutePath = document.uri.fsPath || document.uri.toString();
  const focusLine = editor.selection.active.line;

  if (scope === "selection") {
    return captureSelectionContext(document, editor.selection, relativePath, absolutePath);
  }

  return captureFileContext(document, focusLine, relativePath, absolutePath);
}

function captureSelectionContext(
  document: vscode.TextDocument,
  selection: vscode.Selection,
  relativePath: string,
  absolutePath: string
): AttachedContext {
  const hasExplicitSelection = !selection.isEmpty;
  const startLine = hasExplicitSelection ? selection.start.line : Math.max(0, selection.active.line - Math.floor(CURSOR_CONTEXT_RADIUS / 2));
  const desiredEndLine = hasExplicitSelection
    ? selection.end.line
    : Math.min(document.lineCount - 1, selection.active.line + Math.floor(CURSOR_CONTEXT_RADIUS / 2));
  const endLine = Math.min(desiredEndLine, startLine + MAX_SELECTION_LINES - 1);
  const content = buildLineBlock(document, startLine, endLine);

  return {
    id: `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    scope: "selection",
    label: `${relativePath} ${formatLineRange(startLine, endLine)}`,
    absolutePath,
    relativePath,
    languageId: document.languageId,
    content: clampContent(content),
    lineStart: startLine,
    lineEnd: endLine,
    truncated: desiredEndLine > endLine || content.length > MAX_CONTEXT_CHARS,
    note: hasExplicitSelection
      ? undefined
      : "No explicit selection was active, so lines near the cursor were attached."
  };
}

function captureFileContext(
  document: vscode.TextDocument,
  focusLine: number,
  relativePath: string,
  absolutePath: string
): AttachedContext {
  const ranges = mergeRanges([
    { start: 0, end: Math.min(document.lineCount - 1, FILE_HEAD_LINES - 1) },
    {
      start: Math.max(0, focusLine - CURSOR_CONTEXT_RADIUS),
      end: Math.min(document.lineCount - 1, focusLine + CURSOR_CONTEXT_RADIUS)
    },
    {
      start: Math.max(0, document.lineCount - FILE_TAIL_LINES),
      end: document.lineCount - 1
    }
  ]);

  const parts: string[] = [];
  let coveredLines = 0;

  for (let index = 0; index < ranges.length; index += 1) {
    const current = ranges[index];
    coveredLines += current.end - current.start + 1;
    parts.push(buildLineBlock(document, current.start, current.end));

    const next = ranges[index + 1];
    if (next && next.start > current.end + 1) {
      parts.push(`... omitted ${next.start - current.end - 1} lines ...`);
    }
  }

  const content = clampContent(parts.join("\n"));

  return {
    id: `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    scope: "file",
    label: `${relativePath} ${formatLineRange(0, document.lineCount - 1)}`,
    absolutePath,
    relativePath,
    languageId: document.languageId,
    content,
    lineStart: 0,
    lineEnd: document.lineCount - 1,
    truncated: coveredLines < document.lineCount || content.length >= MAX_CONTEXT_CHARS,
    note: "Large files are compressed to the file head, the cursor neighborhood, and the file tail."
  };
}

function buildLineBlock(document: vscode.TextDocument, startLine: number, endLine: number): string {
  const width = String(endLine + 1).length;
  const lines: string[] = [];

  for (let line = startLine; line <= endLine; line += 1) {
    const prefix = String(line + 1).padStart(width, " ");
    lines.push(`${prefix}| ${document.lineAt(line).text}`);
  }

  return lines.join("\n");
}

function clampContent(content: string): string {
  if (content.length <= MAX_CONTEXT_CHARS) {
    return content;
  }

  return `${content.slice(0, MAX_CONTEXT_CHARS - 24)}\n... context truncated ...`;
}

function formatLineRange(startLine: number, endLine: number): string {
  return `L${startLine + 1}-${endLine + 1}`;
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = ranges
    .filter((range) => range.end >= range.start)
    .sort((left, right) => left.start - right.start);

  if (sorted.length === 0) {
    return [];
  }

  const merged = [{ ...sorted[0] }];
  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index];
    const last = merged[merged.length - 1];

    if (current.start <= last.end + 1) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
}
