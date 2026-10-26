import { scanApplications } from "./launcherService";

/** Discovery is manual and bounded by the native Windows scanner. */
export function discoverApplications() {
  return scanApplications();
}
