import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync,existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createContext, runInContext } from "node:vm";
import { transformSync } from "esbuild";

// Execute the real services and handlers with in-memory storage and mocked IPC.
// No browser, credentials, native commands, or external interfaces are used.
function fixture({ native = true, invoke = async () => null } = {}) {
  const values = new Map(), calls = [], slots = [], effects = [], cache = new Map(), listeners = new Map();
  let cursor = 0;
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useEffect(effect, deps) { const i = cursor++; if (!slots[i] || deps?.some((value, index) => value !== slots[i][index])) { slots[i] = deps; effects.push(effect); } },
  };
  const jsx = (type, props) => ({ type, props });
  const context = createContext({ console, localStorage: storage, window: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) }, setTimeout, clearTimeout });
  const stubs = {
    react, "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
    "@tauri-apps/api/core": { isTauri: () => native, invoke: async (command, args) => { calls.push({ command, args }); return invoke(command, args); } },
    appLogger: { logEvent() {} }, ApplicationDock: { AppGlyph() {} },
    dockIngress: { mergeDroppedApplications: (a, b) => [...a, ...b], applicationTargetsEqual: () => false, normalizeApplicationName: value => value, applicationFromUrl: target => ({ ...app("网址"), type: "url", target }) },
    "@tauri-apps/api/webview": { getCurrentWebview() { throw new Error("Real webview access forbidden in this test"); } },
    useApplicationStatus: { useApplicationStatus: () => ({}) }, applicationStatus: { confirmedRunning: () => false },
    dockPresentation: { starterDockIcons: {} }, dockMagnification: {}, launcherService: {},
    iconStore: { readApplicationIcon: async () => "data:image/png;base64,AA==" }, appScanner: { discoverApplications: async () => [] },
  };
  function load(path) {
    const full = resolve(path);
    if (cache.has(full)) return cache.get(full).exports;
    const module = { exports: {} }; cache.set(full, module);
    const code = transformSync(readFileSync(full, "utf8"), { loader: full.endsWith("tsx") ? "tsx" : "ts", format: "cjs", jsx: "automatic" }).code;
    const require = name => {
      const stub = stubs[name] ?? stubs[name.split("/").at(-1)];
      if (stub) return stub;
      if (name.startsWith(".")) {const base=resolve(dirname(full),name);return load(existsSync(base+".ts")?base+".ts":base+".tsx");}
      throw new Error(`Unexpected dependency: ${name}`);
    };
    runInContext(`(function(require,module,exports){${code}\n})`, context, { filename: full })(require, module, module.exports);
    return module.exports;
  }
  return { load, values, storage, calls, dispatch: (name, event) => listeners.get(name)?.(event), render(fn) { cursor = 0; return fn(); }, async effects() { for (const effect of effects.splice(0)) effect(); await settle(); } };
}
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
function elements(tree, type) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(item => elements(item, type));
  return [...(tree.type === type ? [tree] : []), ...elements(tree.props?.children, type)];
}

test("读取失败不把默认应用写回原文件", async () => {
  const f = fixture({ invoke: async command => { if (command === "load_applications") throw new Error("模拟读取失败"); } });
  const { useApplications } = f.load("src/services/useApplications.ts");
  f.render(() => useApplications()); await f.effects();
  assert.equal(f.calls.filter(call => call.command === "save_applications").length, 0);
});

test("数据源读取失败后不能用空配置覆盖，入口不发送保存",async()=>{
 const f=fixture({invoke:async()=>{throw new Error("模拟读取失败");}});const {DataSourceConnectionsSettings}=f.load("src/components/DataSourceConnectionsSettings.tsx");
 let tree=f.render(()=>DataSourceConnectionsSettings());await f.effects();tree=f.render(()=>DataSourceConnectionsSettings());
 const save=elements(tree,"button").find(item=>item.props.children==="保存数据源");assert.equal(save.props.disabled,true);save.props.onClick();await settle();
 assert.equal(f.calls.filter(item=>item.command==="save_snapshot_connection").length,0);
 assert.match(elements(tree,"small").map(item=>item.props.children).join(" "),/读取失败/);
});

test("数据源保存失败显示失败并保留草稿，不提示连接成功",async()=>{
 const config={enabled:false,sshAlias:"",dataRoot:"",radarRoot:""};
 const f=fixture({invoke:async command=>{if(command==="load_snapshot_connection")return config;throw "模拟保存失败";}});const {DataSourceConnectionsSettings}=f.load("src/components/DataSourceConnectionsSettings.tsx");
 let tree=f.render(()=>DataSourceConnectionsSettings());await f.effects();tree=f.render(()=>DataSourceConnectionsSettings());
 elements(tree,"input").find(item=>item.props["aria-label"]==="SSH 配置别名").props.onChange({target:{value:"my-data"}});tree=f.render(()=>DataSourceConnectionsSettings());
 elements(tree,"button").find(item=>item.props.children==="保存数据源").props.onClick();await settle();tree=f.render(()=>DataSourceConnectionsSettings());
 const message=elements(tree,"small").map(item=>item.props.children).join(" ");assert.match(message,/保存失败/);assert.doesNotMatch(message,/已保存|连接成功/);assert.equal(elements(tree,"input").find(item=>item.props["aria-label"]==="SSH 配置别名").props.value,"my-data");
});

test("原生保存失败时添加入口不能提示成功，草稿保留", async () => {
  const f = fixture({ invoke: async () => { throw new Error("模拟写入失败"); } });
  const store = f.load("src/services/applicationStore.ts");
  const { ApplicationManager } = f.load("src/components/ApplicationManager.tsx");
  const props = { applications: [], onApplicationsChange: next => store.saveApplications(typeof next === "function" ? next([]) : next) };
  let tree = f.render(() => ApplicationManager(props));
  for (const [label, value] of [["应用名称", "测试应用"], ["目标路径", "C:\\mock.exe"]]) {
    elements(tree, "input").find(item => item.props["aria-label"] === label).props.onChange({ target: { value } });
    tree = f.render(() => ApplicationManager(props));
  }
  await elements(tree, "form")[0].props.onSubmit({ preventDefault() {} }); await settle();
  tree = f.render(() => ApplicationManager(props));
  const messages = elements(tree, "small").filter(item => item.props.role === "status").map(item => item.props.children).join(" ");
  assert.match(messages, /失败/);
  assert.doesNotMatch(messages, /已添加|已保存/);
  assert.equal(elements(tree, "input").find(item => item.props["aria-label"] === "应用名称").props.value, "测试应用");
});

const app = name => ({ id: name, name, icon: "", type: "exe", target: "mock.exe", pinned: true, order: 0 });
const config = name => ({ version: 2, apps: [app(name)] });

test("读取失败后用户保存也被阻止，缓存原样保留", async () => {
  const f = fixture({ invoke: async () => { throw new Error("模拟拒绝读取"); } });
  const store = f.load("src/services/applicationStore.ts");
  const original = JSON.stringify(config("原入口")); f.values.set(store.applicationsStorageKey, original);
  const messages = []; const { useApplications } = f.load("src/services/useApplications.ts");
  const [, update] = f.render(() => useApplications(message => messages.push(message))); await f.effects();
  await assert.rejects(update([app("新入口")]), /未成功读取/);
  assert.match(messages.join(" "), /读取失败/);
  assert.equal(f.values.get(store.applicationsStorageKey), original);
  assert.equal(f.calls.filter(call => call.command === "save_applications").length, 0);
});

test("现有配置结构不完整时不写回，不开放保存", async () => {
  for (const invalid of [{ apps: null }, { apps: [{ name: "" }] }]) {
    const f = fixture({ invoke: async () => invalid });
    const { useApplications } = f.load("src/services/useApplications.ts");
    const [, update] = f.render(() => useApplications()); await f.effects();
    await assert.rejects(update([]), /未成功读取/);
    assert.equal(f.calls.filter(call => call.command === "save_applications").length, 0);
  }
});

test("读取成功以及首次无文件都不自动保存，明确修改后才保存", async () => {
  for (const stored of [config("已有入口"), null]) {
    const f = fixture({ invoke: async command => command === "load_applications" ? stored : undefined });
    const { useApplications } = f.load("src/services/useApplications.ts");
    const [, update] = f.render(() => useApplications()); await f.effects();
    assert.equal(f.calls.filter(call => call.command === "save_applications").length, 0);
    await update([app("新入口")]);
    assert.equal(f.calls.filter(call => call.command === "save_applications").length, 1);
  }
});

test("保存确认之前不提前更改列表，失败后仍可重试", async () => {
  let rejectSave;
  let fail = true;
  const f = fixture({ invoke: async command => command === "load_applications" ? config("原入口") : fail ? new Promise((_, reject) => { rejectSave = reject; }) : undefined });
  const { useApplications } = f.load("src/services/useApplications.ts");
  const [, update] = f.render(() => useApplications()); await f.effects();
  const pending = update([app("新入口")]);
  const failed = assert.rejects(pending, /保存失败/); await settle();
  assert.equal(f.render(() => useApplications())[0][0].name, "原入口");
  rejectSave(new Error("模拟写失败")); await failed;
  assert.equal(f.render(() => useApplications())[0][0].name, "原入口");
  fail = false; await update([app("新入口")]);
  assert.equal(f.render(() => useApplications())[0][0].name, "新入口");
});

test("读取尚未完成时等待原配置，再合并修改，连续保存不会丢入口", async () => {
  let resolveRead;
  const f = fixture({ invoke: async command => command === "load_applications" ? new Promise(resolve => { resolveRead = resolve; }) : undefined });
  const { useApplications } = f.load("src/services/useApplications.ts");
  const [, update] = f.render(() => useApplications()); await f.effects();
  const first = update(current => [...current, app("第二个")]);
  const second = update(current => [...current, app("第三个")]); await settle();
  assert.equal(f.calls.filter(call => call.command === "save_applications").length, 0);
  resolveRead(config("第一个")); await Promise.all([first, second]);
  assert.deepEqual(Array.from(f.render(() => useApplications())[0], item => item.name), ["第一个", "第二个", "第三个"]);
});

test("原生保存失败既不更新缓存也不轮换缓存备份", async () => {
  const f = fixture({ invoke: async () => { throw new Error("模拟写失败"); } });
  const store = f.load("src/services/applicationStore.ts");
  const original = JSON.stringify(config("原入口")); f.values.set(store.applicationsStorageKey, original);
  f.values.set(store.applicationsPreviousStorageKey, "older");
  await assert.rejects(store.saveApplications([app("新入口")]), /保存失败/);
  assert.equal(f.values.get(store.applicationsStorageKey), original);
  assert.equal(f.values.get(store.applicationsPreviousStorageKey), "older");
});

test("浏览器保存保留上一版，备份失败或写入失败不覆盖原缓存", async () => {
  for (const failure of [null, "backup", "current"]) {
    const f = fixture({ native: false }); const store = f.load("src/services/applicationStore.ts");
    const original = JSON.stringify(config("原入口")); f.values.set(store.applicationsStorageKey, original);
    const set = f.storage.setItem;
    f.storage.setItem = (key, value) => {
      if (key === (failure === "backup" ? store.applicationsPreviousStorageKey : failure === "current" ? store.applicationsStorageKey : "none")) throw new Error("模拟存储已满");
      set(key, value);
    };
    if (failure) { await assert.rejects(store.saveApplications([app("新入口")]), /保存失败/); assert.equal(f.values.get(store.applicationsStorageKey), original); }
    else { await store.saveApplications([app("新入口")]); assert.equal(JSON.parse(f.values.get(store.applicationsStorageKey)).apps[0].name, "新入口"); }
    if (failure !== "backup") assert.equal(f.values.get(store.applicationsPreviousStorageKey), original);
    assert.equal(f.calls.length, 0);
  }
});

test("浏览器损坏或不可读缓存不被默认值覆盖", async () => {
  const f = fixture({ native: false }); const store = f.load("src/services/applicationStore.ts");
  f.values.set(store.applicationsStorageKey, "{broken");
  const { useApplications } = f.load("src/services/useApplications.ts");
  const [, update] = f.render(() => useApplications()); await f.effects();
  await assert.rejects(update([]), /未成功读取/);
  await assert.rejects(store.saveApplications([]), /保存失败/);
  assert.equal(f.values.get(store.applicationsStorageKey), "{broken");
  f.storage.getItem = () => { throw new Error("模拟不可读"); };
  await assert.rejects(store.saveApplications([]), /保存失败/);
});

test("跨窗口刷新读取失败也不写默认配置，并阻止后续保存", async () => {
  let failing = false;
  const f = fixture({ invoke: async () => { if (failing) throw new Error("模拟读取失败"); return config("原入口"); } });
  const store = f.load("src/services/applicationStore.ts"); const { useApplications } = f.load("src/services/useApplications.ts");
  const [, update] = f.render(() => useApplications()); await f.effects();
  failing = true; f.dispatch("storage", { key: store.applicationsStorageKey }); await settle();
  await assert.rejects(update([]), /未成功读取/);
  assert.equal(f.render(() => useApplications())[0][0].name, "原入口");
  assert.equal(f.calls.filter(call => call.command === "save_applications").length, 0);
});

test("原生主文件保存成功但镜像缓存写满，不误报主文件失败", async () => {
  const f = fixture(); const store = f.load("src/services/applicationStore.ts");
  f.storage.setItem = () => { throw new Error("模拟缓存已满"); };
  await store.saveApplications([app("新入口")]);
  assert.equal(f.calls.filter(call => call.command === "save_applications").length, 1);
});

test("导入配置保存失败只显示失败，不显示已导入", async () => {
  const f = fixture({ invoke: async () => { throw new Error("模拟写入失败"); } });
  const store = f.load("src/services/applicationStore.ts"); const { ApplicationManager } = f.load("src/components/ApplicationManager.tsx");
  const props = { applications: [], onApplicationsChange: next => store.saveApplications(next) };
  let tree = f.render(() => ApplicationManager(props));
  elements(tree, "input").find(item => item.props.accept === "application/json,.json").props.onChange({ target: { files: [{ text: async () => JSON.stringify(config("导入测试")) }] }, currentTarget: { value: "mock.json" } });
  await settle(); tree = f.render(() => ApplicationManager(props));
  const message = elements(tree, "small").find(item => item.props.role === "status").props.children;
  assert.match(message, /保存失败/); assert.doesNotMatch(message, /已导入/);
});

test("添加入口必须等后端确认才清空草稿和提示成功", async () => {
  let resolveSave;
  const f = fixture({ invoke: () => new Promise(resolve => { resolveSave = resolve; }) });
  const store = f.load("src/services/applicationStore.ts"); const { ApplicationManager } = f.load("src/components/ApplicationManager.tsx");
  const props = { applications: [], onApplicationsChange: next => store.saveApplications(next([])) };
  let tree = f.render(() => ApplicationManager(props));
  for (const [label, value] of [["应用名称", "测试入口"], ["目标路径", "mock.exe"]]) {
    elements(tree, "input").find(item => item.props["aria-label"] === label).props.onChange({ target: { value } }); tree = f.render(() => ApplicationManager(props));
  }
  const pending = elements(tree, "form")[0].props.onSubmit({ preventDefault() {} }); await settle();
  tree = f.render(() => ApplicationManager(props));
  assert.equal(elements(tree, "small").filter(item => item.props.role === "status").length, 0);
  assert.equal(elements(tree, "input").find(item => item.props["aria-label"] === "应用名称").props.value, "测试入口");
  resolveSave(); await pending; tree = f.render(() => ApplicationManager(props));
  assert.match(elements(tree, "small").find(item => item.props.role === "status").props.children, /已添加/);
  assert.equal(elements(tree, "input").find(item => item.props["aria-label"] === "应用名称").props.value, "");
});

test("Dock 拖入网址保存失败不提示已添加", async () => {
  const f = fixture({ native: false }); const store = f.load("src/services/applicationStore.ts");
  f.storage.setItem = () => { throw new Error("模拟存储写满"); };
  const { ApplicationDock } = f.load("src/components/ApplicationDock.tsx");
  const props = { applications: [], onLaunch() {}, onManage() {}, onApplicationsChange: next => store.saveApplications(next([])) };
  let tree = f.render(() => ApplicationDock(props));
  const drop = elements(tree, "div").find(item => item.props["aria-label"] === "应用 Dock");
  await drop.props.onDrop({ preventDefault() {}, dataTransfer: { getData: type => type === "text/uri-list" ? "https://example.test" : "" } });
  tree = f.render(() => ApplicationDock(props));
  const message = elements(tree, "div").find(item => item.props.role === "status").props.children;
  assert.match(message, /保存失败/); assert.doesNotMatch(message, /已添加/);
});

test("Dock 拖入提示在结束、取消或失焦后消失，内部排序不显示添加提示", async () => {
  const f = fixture({ native: false });
  const { ApplicationDock } = f.load("src/components/ApplicationDock.tsx");
  const props = { applications: [], onLaunch() {}, onManage() {}, onApplicationsChange() {} };
  const renderDock = () => elements(f.render(() => ApplicationDock(props)), "div").find(item => item.props["aria-label"] === "应用 Dock");
  renderDock(); await f.effects();
  for (const [event, payload] of [["dragend", {}], ["drop", {}], ["blur", {}], ["keydown", { key: "Escape" }]]) {
    renderDock().props.onDragOver({ preventDefault() {}, dataTransfer: { types: ["Files"] } });
    assert.match(renderDock().props.className, /dock-drop-active/);
    f.dispatch(event, payload);
    assert.doesNotMatch(renderDock().props.className, /dock-drop-active/, event);
  }
  renderDock().props.onDragOver({ preventDefault() {}, dataTransfer: { types: ["application/x-codex-dock"] } });
  assert.doesNotMatch(renderDock().props.className, /dock-drop-active/);
});
