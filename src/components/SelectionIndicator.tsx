import {useLayoutEffect,useRef} from "react";

/** Decorative only: native buttons retain selection, focus and keyboard behavior. */
export function SelectionIndicator({activeKey}:{activeKey:string}) {
  const marker=useRef<HTMLSpanElement>(null);
  useLayoutEffect(()=>{
    const node=marker.current,parent=node?.parentElement;
    if(!node||!parent)return;
    const update=()=>{
      const target=parent.querySelector<HTMLElement>(':scope > button[aria-current="page"], :scope > button[aria-pressed="true"]');
      if(!target){delete node.dataset.ready;return;}
      const box=target.getBoundingClientRect(),area=parent.getBoundingClientRect();
      node.style.width=`${box.width}px`;node.style.height=`${box.height}px`;
      node.style.transform=`translate(${box.left-area.left+parent.scrollLeft-parent.clientLeft}px,${box.top-area.top+parent.scrollTop-parent.clientTop}px)`;
      node.dataset.ready="true";
    };
    update();
    const observer=new ResizeObserver(update);
    observer.observe(parent);for(const child of parent.children)if(child!==node)observer.observe(child);
    return()=>observer.disconnect();
  },[activeKey]);
  return <span className="wb-selection-indicator" ref={marker} aria-hidden="true"/>;
}
