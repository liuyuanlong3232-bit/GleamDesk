import test from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {buildWorkbenchSearchItems,filterWorkbenchSearch,WorkbenchSearch} from "../src/components/DashboardPageControls";
import {createDashboardPages} from "../src/domain/dashboard/pages";
import type {ApplicationItem} from "../src/types";
import type {WebApp} from "../src/services/webAppStore";

const document=()=>createDashboardPages({id:"test",width:1920,height:1080,scaleFactor:1},{schemaVersion:2,monitorId:"test",resolution:"1920x1080",scaleFactor:1,mode:"standard",widgets:[],updatedAt:"2026-10-19"});
const application=(patch:Partial<ApplicationItem>={}):ApplicationItem=>({id:"editor",name:"VS Code",type:"exe",target:"C:\\fake\\code.exe",icon:"",pinned:false,order:0,...patch});
const webapp=(patch:Partial<WebApp>={}):WebApp=>({id:"site",name:"我的文档",url:"https://docs.example.test/?access=PRIVATE_QUERY",icon:"",category:"工作",surface:"workspace",persistentProfile:true,permissions:[],...patch});
const items=(apps:ApplicationItem[]=[],sites:WebApp[]=[])=>buildWorkbenchSearchItems(document(),apps,sites);

test("搜索包含现有页面、工具和未固定的应用",()=>{
  const entries=items([application()]);
  assert.ok(entries.some(item=>item.label==="邮箱中心"&&item.target.kind==="page"));
  assert.ok(entries.some(item=>item.label==="JSON 格式化"&&item.target.kind==="tool"));
  assert.ok(entries.some(item=>item.label==="VS Code"&&item.target.kind==="application"));
});
test("中文、英文大小写、全角与多个关键词能匹配",()=>{
  const entries=items();
  assert.equal(filterWorkbenchSearch(entries,"  ｊｓｏｎ  ")[0].label,"JSON 格式化");
  assert.equal(filterWorkbenchSearch(entries,"base64 解码")[0].target.id,"base64-decode");
  assert.ok(filterWorkbenchSearch(entries,"群聊").some(item=>item.label==="Agent Room"));
  assert.ok(filterWorkbenchSearch(entries,"服务器").some(item=>item.target.id==="vps"));
});
test("隐藏页面及其工具入口不出现在搜索中",()=>{
  const pages=document();pages.pages.find(page=>page.id==="toolbox")!.hidden=true;pages.pages.find(page=>page.id==="workspace")!.hidden=true;
  const entries=buildWorkbenchSearchItems(pages,[],[webapp()]);
  assert.ok(!entries.some(item=>["tool","webapp","preset"].includes(item.target.kind)));
  assert.ok(!entries.some(item=>item.label==="邮箱中心"||item.label==="工具箱"));
});
test("自定义可见页面能搜索，隐藏页不显示",()=>{
  const pages=document();pages.pages.push({id:"custom-a",name:"我的研究",kind:"custom",system:false,hidden:false,widgets:[]},{id:"custom-b",name:"隐藏研究",kind:"custom",system:false,hidden:true,widgets:[]});
  assert.deepEqual(filterWorkbenchSearch(buildWorkbenchSearchItems(pages,[],[]),"研究").map(item=>item.label),["我的研究"]);
});
test("没有配置目标的应用明确显示配置入口",()=>{
  const match=filterWorkbenchSearch(items([application({target:""})]),"VS Code")[0];
  assert.equal(match.actionLabel,"配置");assert.match(match.description,/未配置/);
});
test("搜索不会索引应用命令参数、目标路径或网站查询串",()=>{
  const entries=items([application({target:"C:\\PRIVATE_PATH\\app.exe",arguments:"PRIVATE_ARGUMENT"})],[webapp()]);
  for(const query of ["PRIVATE_PATH","PRIVATE_ARGUMENT","PRIVATE_QUERY"]){assert.deepEqual(filterWorkbenchSearch(entries,query),[]);}
  assert.ok(filterWorkbenchSearch(entries,"docs.example.test").some(item=>item.target.kind==="webapp"));
});
test("已保存工具网站与内置预设按网址去重",()=>{
  const entries=items([],[webapp({url:"https://haveibeenpwned.com/",name:"我的泄露查询",surface:"toolbox"})]);
  const matches=filterWorkbenchSearch(entries,"泄露");assert.equal(matches.length,1);assert.equal(matches[0].target.kind,"webapp");
});
test("重复名称仍有独立身份，不混淆网页和应用",()=>{
  const entries=items([application({name:"我的文档"})],[webapp()]);
  const matches=filterWorkbenchSearch(entries,"我的文档");assert.equal(matches.length,2);assert.equal(new Set(matches.map(item=>item.key)).size,2);
});
test("Muse 自定义名称与域名同步进入搜索且不重复",()=>{
  const entries=items([],[webapp({id:"mues",name:"我的知识库"})]);
  assert.equal(filterWorkbenchSearch(entries,"我的知识库")[0].target.id,"mues");
  assert.equal(filterWorkbenchSearch(entries,"docs.example.test").length,1);
});
test("精确名称优先且搜索不修改目录或写入配置",()=>{
  const entries=items([application({id:"a",name:"Code 扩展"}),application({id:"b",name:"Code"})]);
  const before=JSON.stringify(entries);assert.equal(filterWorkbenchSearch(entries,"Code")[0].label,"Code");assert.equal(JSON.stringify(entries),before);
});
test("空白查询提供常用页面，未匹配查询返回空列表",()=>{
  const entries=items();assert.ok(filterWorkbenchSearch(entries,"  ").length>0);assert.deepEqual(filterWorkbenchSearch(entries,"不会匹配的名称98387"),[]);
});
test("搜索组件有对话框、键盘列表和可读空态",()=>{
  const html=renderToStaticMarkup(createElement(WorkbenchSearch,{items:items(),onSelect:()=>{},onClose:()=>{}}));
  assert.match(html,/role="dialog"/);assert.match(html,/role="combobox"/);assert.match(html,/role="listbox"/);assert.match(html,/关闭搜索/);assert.doesNotMatch(html,/<iframe|https?:\/\//);
});
