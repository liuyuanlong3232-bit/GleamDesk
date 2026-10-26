import assert from "node:assert/strict";
import {test} from "node:test";
import {mockIPC,clearMocks} from "@tauri-apps/api/mocks";
import {createAgricultureProvider} from "../src/providers/agriculture/agricultureProvider";
import {emptySnapshotConnection,snapshotOrigin,type SnapshotConnection} from "../src/domain/agriculture/contracts";
import {createProviderRuntime} from "../src/providers/providerRuntime";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {DataSourceConnectionsSettings} from "../src/components/DataSourceConnectionsSettings";
import {readFileSync} from "node:fs";

const selected:SnapshotConnection={enabled:true,sshAlias:"example-data",dataRoot:"/srv/market",radarRoot:""};
const feed=(config:SnapshotConnection)=>({schemaVersion:1,origin:snapshotOrigin(config),fetchedAt:"2026-10-22T00:30:00Z",snapshots:{}});
async function native(run:()=>Promise<void>){
 const previousWindow=Object.getOwnPropertyDescriptor(globalThis,"window"),previousTauri=Object.getOwnPropertyDescriptor(globalThis,"isTauri");
 Object.defineProperty(globalThis,"window",{configurable:true,value:globalThis});Object.defineProperty(globalThis,"isTauri",{configurable:true,value:true});
 try{await run();}finally{clearMocks();if(previousWindow)Object.defineProperty(globalThis,"window",previousWindow);else Reflect.deleteProperty(globalThis,"window");if(previousTauri)Object.defineProperty(globalThis,"isTauri",previousTauri);else Reflect.deleteProperty(globalThis,"isTauri");}
}
test("empty connection never sends a snapshot IPC",async()=>native(async()=>{
 let calls=0;mockIPC(()=>{calls++;throw new Error("must not run");});
 const result=await createAgricultureProvider().load(new AbortController().signal);
 assert.equal(calls,0);assert.equal(result.status,"unavailable");assert.equal(result.data,null);assert.equal(emptySnapshotConnection.enabled,false);
}));
test("configured source validates its own origin instead of an author address",async()=>native(async()=>{
 mockIPC(command=>{assert.equal(command,"read_agriculture_snapshot");return feed(selected);});
 assert.equal((await createAgricultureProvider(selected).load(new AbortController().signal)).status,"normal");
 mockIPC(()=>feed({...selected,sshAlias:"other"}));
 assert.equal((await createAgricultureProvider(selected).load(new AbortController().signal)).status,"error");
}));
test("switching or disabling a source cannot restore the previous source cache",async()=>native(async()=>{
 const values=new Map<string,string>();const runtime=createProviderRuntime({now:()=>Date.parse("2026-10-22T00:31:00Z"),cache:{get:key=>values.get(key)??null,set:(key,value)=>{values.set(key,value);}}});
 mockIPC(()=>feed(selected));const a=createAgricultureProvider(selected);assert.equal((await runtime.refresh(a)).status,"normal");
 const b=createAgricultureProvider({...selected,dataRoot:"/srv/other"});mockIPC(()=>{throw new Error("offline");});const failed=await runtime.refresh(b);
 assert.equal(failed.data,null);assert.equal(failed.status,"error");assert.notEqual(a.cacheKey,b.cacheKey);
 const disabled=await runtime.refresh(createAgricultureProvider({...selected,enabled:false}));assert.equal(disabled.data,null);assert.equal(disabled.status,"unavailable");
}));
test("a disabled native source is reported as unavailable",async()=>native(async()=>{
 mockIPC(()=>{throw "SNAPSHOT_UNCONFIGURED: disabled";});const result=await createAgricultureProvider(selected).load(new AbortController().signal);assert.equal(result.status,"unavailable");assert.equal(result.data,null);
}));
test("data settings expose only non-secret optional connection fields",()=>{
 const html=renderToStaticMarkup(createElement(DataSourceConnectionsSettings));assert.match(html,/SSH 配置别名/);assert.match(html,/数据根目录/);assert.match(html,/默认关闭/);assert.doesNotMatch(html,/type="password"|104\.238|58234|\/root\/hermes/);
});
test("connection identities remain distinct when remote paths contain colons",()=>{
 const a={...selected,dataRoot:"/a:/b",radarRoot:"/c"},b={...selected,dataRoot:"/a",radarRoot:"/b:/c"};assert.notEqual(snapshotOrigin(a),snapshotOrigin(b));
});
test("native connection code has no personal host, port override or private directory",()=>{
 const source=readFileSync("src-tauri/src/agriculture.rs","utf8");assert.doesNotMatch(source,/HostName=|104\.238|58234|35f6acb|\/root\/hermes/);assert.match(source,/StrictHostKeyChecking=yes/);assert.match(source,/config\.require_enabled\(\)/);assert.match(source,/mode=ro/);assert.match(source,/PRAGMA query_only=ON/);
});
