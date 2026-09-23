export type WebviewMessage =
  | { type: "open-file"; filePath: string; line: number; column: number }
  | { type: "copy-checklist"; text: string }
  | { type: "refresh" }
  | { type: "export-report" };

/**
 * Validates a message crossing the Webview -> extension-host boundary.
 * Never trust the webview: this is the single choke point every inbound
 * message passes through before any action (file navigation, clipboard
 * writes) is taken on its behalf.
 */
export function isWebviewMessage(value: unknown): value is WebviewMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case "open-file":
      return typeof v.filePath === "string" && typeof v.line === "number" && typeof v.column === "number";
    case "copy-checklist":
      return typeof v.text === "string";
    case "refresh":
    case "export-report":
      return true;
    default:
      return false;
  }
}
