import assert from "node:assert/strict";
import test from "node:test";
import { defaultApplications, normalizeApplications, moveApplication, parseApplicationImport, migrateLocalAiEntries } from "../src/services/applicationStore";
import { applicationFromUrl, mergeDroppedApplications, reorderDockApplications } from "../src/services/launcher/dockIngress";

test("launcher migration accepts old path fields and assigns safe defaults", () => {
  const migrated = parseApplicationImport({
    apps: [
      { id: "browser", name: "Browser", path: "C:\\Browser.exe", icon: "", pinned: true, order: 1 },
      { name: "Console", target: "wt.exe", type: "command", order: 0, pinned: false },
    ],
  });
  assert.ok(migrated);
  assert.equal(migrated[0].target, "wt.exe");
  assert.equal(migrated[0].type, "command");
  assert.equal(migrated[0].pinned, false);
  assert.equal(migrated[1].target, "C:\\Browser.exe");
  assert.equal(migrated[1].type, "exe");
});

test("application import rejects invalid entries and orders records", () => {
  const parsed = parseApplicationImport([
    { id: "second", name: "Second", type: "url", target: "https://example.test", order: 2 },
    { id: "first", name: "First", type: "exe", target: "first.exe", order: 0 },
    { id: "invalid", name: "", type: "exe", target: "bad.exe" },
  ]);
  assert.ok(parsed);
  assert.deepEqual(parsed.map((app) => app.id), ["first", "second"]);
  assert.deepEqual(parsed.map((app) => app.order), [0, 1]);
});

test("application import does not keep machine-local icon paths", () => {
  const imported = parseApplicationImport([{ id: "portable", name: "Portable", type: "exe", target: "portable.exe", icon: "C:\\Users\\me\\icon.png" }]);
  assert.equal(imported?.[0].icon, "");
});

test("fresh launcher config keeps the original Dock entries but marks them unconfigured", () => {
  const apps = defaultApplications();
  assert.equal(apps.length, 11);
  assert.equal(apps.slice(0,8).every((app) => app.pinned && app.target.length === 0), true);
  assert.deepEqual(apps.slice(8).map(app=>app.name),["Ollama","Qwen","DeepSeek Local"]);
});

test("Dock URL drop rejects executable schemes and keeps case-sensitive URL targets distinct",()=>{
  assert.throws(()=>applicationFromUrl("javascript:alert(1)"));
  assert.throws(()=>applicationFromUrl("https://user:password@example.com"));
  const first=applicationFromUrl("https://example.com/Path"),second=applicationFromUrl("https://example.com/path");
  assert.notEqual(first.id,second.id);
  const apps=mergeDroppedApplications([], [first,second]);
  assert.equal(apps.length,2);
  assert.equal(mergeDroppedApplications(apps,[applicationFromUrl(first.target)]).length,2);
});

test("Dock sorting and removal survive version2 import without restoring removed local entries",()=>{
  const apps=defaultApplications();
  const reordered=reorderDockApplications(apps,"qq","wechat");
  assert.deepEqual(reordered.slice(0,2).map(app=>app.id),["qq","wechat"]);
  const removed=reordered.filter(app=>app.id!=="builtin-qwen");
  const saved={version:2,apps:removed};
  const restored=migrateLocalAiEntries(saved,parseApplicationImport(saved)!);
  assert.equal(restored.some(app=>app.id==="builtin-qwen"),false);
  assert.deepEqual(restored.map(app=>app.id),removed.map(app=>app.id));
  assert.equal(migrateLocalAiEntries({version:1},apps.slice(0,8)).length,11);
});

test("application manager arrows update saved order before normalization", () => {
  const apps = reorderDockApplications(defaultApplications(), "qq", "wechat");
  const moved = moveApplication(apps, "wechat", -1);
  assert.deepEqual(normalizeApplications(moved).slice(0, 2).map(app => app.id), ["wechat", "qq"]);
  const restored = parseApplicationImport({version:2,apps:moved})!;
  assert.deepEqual(restored.map(app => app.id), moved.map(app => app.id));
  assert.equal(moveApplication(restored,"missing",-1).length, restored.length);
});

test("reordering normalizes saved order without changing launch targets", () => {
  const apps = defaultApplications();
  const reordered = normalizeApplications([{ ...apps[1], order: 0 }, { ...apps[0], order: 1 }]);
  assert.deepEqual(reordered.map((app) => app.id), ["qq", "wechat"]);
  assert.deepEqual(reordered.map((app) => app.order), [0, 1]);
});

test("Dock magnification is bounded, symmetric and resets without pointer input", async () => {
  const { dockMagnification } = await import("../src/services/launcher/dockMagnification");
  const poses = dockMagnification([0,82,164,246,328],164);
  assert.equal(poses[2].scale,1.4);
  assert.equal(poses[0].scale,1);
  assert.equal(poses[4].scale,1);
  assert.ok(Math.abs(poses[1].shift + poses[3].shift) < 0.00001);
  assert.deepEqual(dockMagnification([0,82],null),[{scale:1,shift:0,lift:0},{scale:1,shift:0,lift:0}]);
  assert.deepEqual(dockMagnification([],null),[]);
});
test("selected scanner and dropped apps fill placeholders without changing stable IDs or custom icons",()=>{
  const placeholder={id:"wechat",name:"微信",type:"exe" as const,target:"",icon:"data:image/png;base64,cHVibGlj",pinned:false,order:4};
  const candidate={id:"scan-wechat",name:"WeChat",type:"shortcut" as const,target:"C:\\Desktop\\WeChat.lnk",icon:"",processName:"WeChat",pinned:true,order:0};
  const result=mergeDroppedApplications([placeholder],[candidate]);assert.equal(result.length,1);assert.equal(result[0].id,"wechat");assert.equal(result[0].name,"微信");assert.equal(result[0].icon,placeholder.icon);assert.equal(result[0].target,candidate.target);assert.equal(result[0].processName,"WeChat");assert.equal(result[0].pinned,true);assert.equal(placeholder.target,"");
  const again=mergeDroppedApplications(result,[{...candidate,id:"new",arguments:"different"}]);assert.equal(again[0].id,"wechat");assert.equal(again.length,1);
});
test("adding same-name applications never overwrites a different configured target",()=>{
  const configured={id:"one",name:"App",type:"exe" as const,target:"C:\\one\\app.exe",icon:"",pinned:true,order:0};
  const result=mergeDroppedApplications([configured],[{...configured,id:"two",target:"C:\\two\\app.exe"}]);assert.equal(result.length,2);assert.equal(result[0].target,configured.target);
});


test("configured command entries remain distinct from executable entries with the same target",()=>{const base={id:"a",name:"App",type:"command" as const,target:"app.exe",icon:"",pinned:true,order:0,arguments:"user-argument"};const result=mergeDroppedApplications([base],[{...base,id:"b",type:"exe"}]);assert.equal(result.length,2);assert.equal(result[0].type,"command");assert.equal(result[0].arguments,"user-argument");});

test("re-dropping an app replaces its stale system icon while retaining its identity and arguments",()=>{
 const previous={id:"chart",name:"Chart",type:"shortcut" as const,target:"C:\\Apps\\Chart.lnk",icon:"old-padded-icon",iconSource:"system" as const,pinned:true,order:2,arguments:"--workspace saved"};
 const incoming={...previous,id:"scan-chart",icon:"fresh-original-icon",arguments:"--other"};
 const [merged]=mergeDroppedApplications([previous],[incoming]);
 assert.equal(merged.icon,incoming.icon);assert.equal(merged.iconSource,"system");assert.equal(merged.id,previous.id);assert.equal(merged.arguments,previous.arguments);
 assert.equal(mergeDroppedApplications([previous],[{...incoming,icon:""}])[0].icon,previous.icon);
});
test("re-dropping an app preserves an explicitly selected custom icon and its source marker",()=>{
 const previous={id:"github",name:"GitHub",type:"shortcut" as const,target:"C:\\Apps\\GitHub.lnk",icon:"user-icon",iconSource:"custom" as const,pinned:true,order:0};
 const [merged]=mergeDroppedApplications([previous],[{...previous,id:"incoming",icon:"new-system-icon",iconSource:"system"}]);
 assert.equal(merged.icon,"user-icon");assert.equal(merged.iconSource,"custom");
});
