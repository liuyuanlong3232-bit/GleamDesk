import {CloseIcon} from "./CloseIcon";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { settingsModules, type SettingsModuleId } from "./settingsModules";

export function SettingsDialog({ selected, onSelect, onClose, pages }: {
  selected: SettingsModuleId;
  onSelect: (id: SettingsModuleId) => void;
  onClose: () => void;
  pages: Record<SettingsModuleId, ReactNode>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const module = settingsModules.find((item) => item.id === selected)!;

  useEffect(() => {
    const element = dialog.current!;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    return () => {
      element.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  useEffect(() => { content.current?.scrollTo({ top: 0 }); }, [selected]);

  return <dialog ref={dialog} className="settings-dialog settings-center glass" aria-modal="true" aria-labelledby="settings-dialog-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <header className="settings-dialog-header">
      <div><h2 id="settings-dialog-title">设置中心</h2></div>
      <button className="settings-dialog-close ui-icon-button" onClick={onClose} aria-label="关闭设置" autoFocus><CloseIcon/></button>
    </header>
    <div className="settings-dialog-body">
      <nav className="settings-navigation" aria-label="设置模块">
        {settingsModules.map((item, index) => <div key={item.id}>
          {(index === 0 || settingsModules[index - 1].group !== item.group) && <span className="settings-nav-group">{item.group}</span>}
          <button aria-current={selected === item.id ? "page" : undefined} onClick={() => onSelect(item.id)}>
            <span aria-hidden="true">{item.icon}</span>{item.label}
          </button>
        </div>)}
      </nav>
      <div className="settings-module-content" ref={content}>
        <header className="settings-module-heading"><h3 id="settings-module-title">{module.label}</h3></header>
        <section key={selected} aria-labelledby="settings-module-title">{pages[selected]}</section>
      </div>
    </div>
  </dialog>;
}
