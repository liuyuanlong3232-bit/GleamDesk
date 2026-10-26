import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ApplicationItem } from "../types";
import { applicationsStorageKey, loadApplications, readApplicationConfig, readCachedApplications, saveApplications } from "./applicationStore";

export function useApplications(onReadError?: (message: string) => void) {
  const [applications, setApplications] = useState<ApplicationItem[]>(() => loadApplications());
  const applicationsRef = useRef(applications);
  const ready = useRef(false);
  const loading = useRef<Promise<void> | null>(null);
  const updates = useRef<Promise<void>>(Promise.resolve());
  const reportError = useRef(onReadError); reportError.current = onReadError;

  useEffect(() => {
    let active = true;
    let generation = 0;
    const read = () => {
      const current = ++generation;
      ready.current = false;
      loading.current = (async () => {
        try {
          const stored = isTauri() ? await invoke<unknown | null>("load_applications") : undefined;
          const parsed = isTauri() && stored !== null ? readApplicationConfig(stored) : readCachedApplications();
          if (!active || current !== generation) return;
          applicationsRef.current = parsed;
          setApplications(parsed);
          ready.current = true;
          // Reading, including migration/defaults, never writes the source file.
        } catch {
          if (active && current === generation) reportError.current?.("应用配置读取失败，原配置已保留，暂不能保存更改。请检查配置后重新打开应用。");
        }
      })();
    };
    read();
    const sync = (event: StorageEvent) => { if (event.key === applicationsStorageKey) read(); };
    window.addEventListener("storage", sync);
    return () => { active = false; window.removeEventListener("storage", sync); };
  }, []);

  const updateApplications = (next: ApplicationItem[] | ((current: ApplicationItem[]) => ApplicationItem[])): Promise<void> => {
    const pending = updates.current.then(async () => {
      await loading.current;
      if (!ready.current) throw new Error("应用配置尚未成功读取，未保存本次更改；原配置已保留。");
      const resolved = typeof next === "function" ? next(applicationsRef.current) : next;
      await saveApplications(resolved);
      applicationsRef.current = resolved;
      setApplications(resolved);
    });
    updates.current = pending.catch(() => undefined);
    return pending;
  };

  return [applications, updateApplications] as const;
}
