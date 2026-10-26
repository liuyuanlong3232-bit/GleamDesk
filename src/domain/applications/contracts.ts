export type ApplicationType = "exe" | "shortcut" | "url" | "command";

export interface ApplicationItem {
  id: string;
  name: string;
  icon: string;
  type: ApplicationType;
  target: string;
  arguments?: string;
  category?: string;
  pinned: boolean;
  order: number;
  glyph?: string;
  color?: string;
  sourcePath?: string;
  processName?: string;
  iconSource?: "system" | "custom";
}
