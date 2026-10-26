import test from "node:test";import assert from "node:assert/strict";
import {appThemes,normalizeTheme,themeAccent,applyTheme} from "../src/presentation/theme";
import {defaultSettings,loadSettings,saveSettings} from "../src/providers/settingsStore";
test("four themes are explicit; unknown and legacy themes keep the burgundy fallback",()=>{
 assert.deepEqual(appThemes.map(t=>t.id),["burgundy","lavender","moss","white"]);
 for(const theme of appThemes)assert.equal(normalizeTheme(theme.id),theme.id);
 for(const invalid of [null,undefined,{},"ocean","dark-glass","light-glass","#fff"])assert.equal(normalizeTheme(invalid),"burgundy");
});
test("every theme round-trips without changing data connections, transparency or limits",()=>{
 const values=new Map<string,string>();Object.defineProperty(globalThis,"localStorage",{configurable:true,value:{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}}});
 for(const theme of appThemes){
  saveSettings({...defaultSettings,theme:theme.id,accent:"ignored",opacity:73,hudBackgroundOpacity:61,animations:false,beszelRefreshIntervalSeconds:120,apiConnections:{...defaultSettings.apiConnections,mimoDailyAuto:false}});
  const actual=loadSettings();assert.equal(actual.theme,theme.id);assert.equal(actual.accent,theme.accent);assert.equal(actual.opacity,73);assert.equal(actual.hudBackgroundOpacity,61);assert.equal(actual.animations,false);assert.equal(actual.beszelRefreshIntervalSeconds,120);assert.equal(actual.apiConnections.mimoDailyAuto,false);
 }
});
test("switching theme replaces previous classes and keeps window and motion classes",()=>{
 const classes=new Set(["theme-ocean","theme-white","dock-window","reduce-motion"]),styles=new Map<string,string>();
 const root={classList:{remove:(...names:string[])=>names.forEach(name=>classes.delete(name)),add:(name:string)=>classes.add(name)},style:{setProperty:(key:string,value:string)=>styles.set(key,value)}} as unknown as HTMLElement;
 for(const theme of appThemes){applyTheme(root,theme.id);assert.deepEqual([...classes].filter(n=>n.startsWith("theme-")),[`theme-${theme.id}`]);assert.equal(styles.get("--accent"),themeAccent(theme.id));assert.ok(classes.has("dock-window"));assert.ok(classes.has("reduce-motion"));}
});
