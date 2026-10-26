import type {AppTheme} from "../types";

export const appThemes=[
 {id:"burgundy",name:"酒红",accent:"#c2263f",surface:"#17131c",text:"#f5f2f3"},
 {id:"lavender",name:"雾紫",accent:"#8759b8",surface:"#211a2c",text:"#f4eef9"},
 {id:"moss",name:"苔绿",accent:"#477657",surface:"#17231d",text:"#edf5ed"},
 {id:"white",name:"标准白",accent:"#3165bb",surface:"#ffffff",text:"#202530"},
] as const;
export function normalizeTheme(value:unknown):AppTheme{return appThemes.some(theme=>theme.id===value)?value as AppTheme:"burgundy";}
export function themeAccent(theme:AppTheme){return appThemes.find(item=>item.id===theme)!.accent;}
export function applyTheme(root:HTMLElement,theme:AppTheme){
 root.classList.remove("theme-graphite","theme-ocean","theme-dark-glass","theme-light-glass",...appThemes.map(item=>`theme-${item.id}`));
 root.classList.add(`theme-${theme}`);
 root.style.setProperty("--accent",themeAccent(theme));
}
