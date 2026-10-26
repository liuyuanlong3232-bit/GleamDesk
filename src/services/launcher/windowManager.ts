import type { ApplicationItem } from "../../types";
import { launchApplication, type LaunchResult } from "./launcherService";

/** The native launcher checks for a matching top-level process window before it starts a second copy. */
export function activateOrLaunchApplication(application: ApplicationItem): Promise<LaunchResult> {
  return launchApplication(application);
}
