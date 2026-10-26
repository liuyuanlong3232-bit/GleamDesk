/** Symmetric geometry avoids font-baseline differences in close controls. */
export function CloseIcon() {
  return <svg className="ui-close-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false" style={{display:"block",width:"var(--close-icon-size, 18px)",height:"var(--close-icon-size, 18px)",flexShrink:0}}>
    <path d="m6 6 12 12M18 6 6 18"/>
  </svg>;
}
