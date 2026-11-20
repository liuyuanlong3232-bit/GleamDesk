import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { isWindowVisible } from "../../services/windowVisibility";

interface CodexActivity {
  state: string;
  activeTasks: number;
  source: string;
}

export function useCodexActivity(simulationEnabled: boolean, localAgentUsageEnabled?: boolean): CodexActivity {
  const [activity, setActivity] = useState<CodexActivity>({ state: "unknown", activeTasks: 0, source: "none" });

  useEffect(() => {
    if (!isTauri() || simulationEnabled || localAgentUsageEnabled !== true) {
      setActivity({ state: "unknown", activeTasks: 0, source: "permission-required" });
      return;
    }

    let active = true;
    let pending = false;
    const refresh = async () => {
      if (!active || pending || !isWindowVisible()) return;
      pending = true;
      try {
        const value = await invoke<CodexActivity>("read_codex_activity", { consent: true });
        if (active) setActivity(value);
      } catch {
        if (active) setActivity({ state: "unknown", activeTasks: 0, source: "read-failed" });
      } finally {
        pending = false;
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [simulationEnabled, localAgentUsageEnabled]);

  return activity;
}
