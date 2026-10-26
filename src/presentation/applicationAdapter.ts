import type { ApplicationItem } from "../domain/applications/contracts";
import type { DockApplication } from "../types";

const presets: Record<string, { glyph: string; color: string }> = {
  wechat: { glyph: "微", color: "#32c878" }, qq: { glyph: "Q", color: "#39a9ff" },
  edge: { glyph: "e", color: "#32c6cf" }, vscode: { glyph: "<>", color: "#46a5f5" },
  terminal: { glyph: ">_", color: "#bcc5d6" }, codex: { glyph: "✳", color: "#dce7f6" },
  claude: { glyph: "✺", color: "#ff9b69" }, chatgpt: { glyph: "◎", color: "#65d6a5" },
};

export function presentApplications(applications: ApplicationItem[]): DockApplication[] {
  return applications.map(app => ({ id: app.id, name: app.name,
    glyph: app.glyph || presets[app.id]?.glyph || app.name.slice(0, 1),
    color: app.color || presets[app.id]?.color || "#8faeca",
  }));
}
