import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createDefaultLayout, loadLayout, parseLayoutImport, saveLayout } from "../src/providers/layoutStore";
import type { MonitorInfo } from "../src/types";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, value); },
    removeItem: (key: string) => { memory.delete(key); },
    clear: () => memory.clear(),
  },
});

const monitor = (id: string): MonitorInfo => ({ id, name: id, x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1, isPrimary: false });

afterEach(() => memory.clear());

test("creates independent versioned layouts for each monitor", () => {
  const secondary = monitor("secondary");
  const layout = createDefaultLayout(secondary);
  assert.equal(layout.schemaVersion, 2);
  assert.equal(layout.resolution, "1920x1080");
  assert.deepEqual(layout.widgets.map(({ x, y, width }) => [x, y, width]), [[0, 0, 3], [3, 0, 3], [6, 0, 3], [9, 0, 3], [0, 1, 5], [5, 1, 7], [0, 2, 12], [0, 3, 12]]);
  layout.widgets[0]!.hidden = true;
  saveLayout(layout);

  assert.equal(loadLayout(secondary).widgets[0]!.hidden, true);
  assert.equal(loadLayout(monitor("primary")).widgets[0]!.hidden, false);
});

test("migrates the previous placement-array format", () => {
  memory.set("codex-desktop.layout.v1.secondary", JSON.stringify([{ id: "api", span: 6, hidden: true }]));
  const migrated = loadLayout(monitor("secondary"));

  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.mode, "standard");
  assert.deepEqual(migrated.widgets.find((item) => item.id === "api"), { id: "api", x: 3, y: 0, width: 6, height: 1, hidden: true });
  assert.ok(memory.has("codex-desktop.layout.v2.secondary"));
});

test("validates and remaps imported layouts to the current monitor", () => {
  const source = createDefaultLayout(monitor("old-monitor"));
  source.mode = "compact";
  source.widgets = [
    { ...source.widgets[1]!, width: 99 as 12, hidden: false },
    { ...source.widgets[1]!, width: 2, hidden: true },
    { ...source.widgets[1]!, id: "unknown", width: 4 },
  ];
  const imported = parseLayoutImport(source, monitor("new-monitor"));

  assert.ok(imported);
  assert.equal(imported.monitorId, "new-monitor");
  assert.equal(imported.mode, "compact");
  assert.deepEqual(imported.widgets.find((item) => item.id === "api"), { id: "api", x: 0, y: 0, width: 12, height: 1, hidden: false });
  assert.equal(imported.widgets.length, 8);
  assert.equal(parseLayoutImport({ ...source, schemaVersion: 1 }, monitor("new-monitor")), null);
});
import {dragHudPlacement,hudPosition,loadHudPlacement,saveHudPlacement} from "../src/providers/layoutStore";

test("HUD parks on each screen edge, stays bounded and remembers a per-screen position",()=>{
 const values=new Map<string,string>();const old=globalThis.localStorage;
 Object.defineProperty(globalThis,"localStorage",{configurable:true,value:{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)}});
 try{const viewport={width:1536,height:864},size={width:210,height:340};
 assert.equal(dragHudPlacement({x:2,y:400},viewport,{edge:"top",offset:1}).edge,"left");
 assert.equal(dragHudPlacement({x:1530,y:400},viewport,{edge:"left",offset:.5}).edge,"right");
 assert.equal(dragHudPlacement({x:750,y:2},viewport,{edge:"right",offset:.5}).edge,"top");
 assert.equal(dragHudPlacement({x:750,y:798},viewport,{edge:"top",offset:.5}).edge,"bottom");
 for(const edge of ["top","right","bottom","left"] as const){const position=hudPosition({edge,offset:1},size,viewport);assert.ok(position.x>=0&&position.y>=0&&position.x+size.width<=viewport.width&&position.y+size.height<=viewport.height-64)}
 saveHudPlacement("primary",{edge:"left",offset:.7});assert.deepEqual(loadHudPlacement("primary"),{edge:"left",offset:.7});assert.deepEqual(loadHudPlacement("secondary"),{edge:"top",offset:1});
 values.set("codex-desktop.hud-position.v1.secondary",'{"edge":"invalid","offset":1}');assert.deepEqual(loadHudPlacement("secondary"),{edge:"top",offset:1});
 }finally{Object.defineProperty(globalThis,"localStorage",{configurable:true,value:old})}
});
