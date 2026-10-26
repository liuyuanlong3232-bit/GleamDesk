import {CloseIcon} from "./CloseIcon";
import {useEffect,useState} from "react";
import {runNativeTool,nativeTools,networkTools,type NativeToolId} from "../services/toolboxTools";
import {configureToolboxPreset,loadWebApps,saveWebApps,subscribeWebApps,toolboxPresets} from "../services/webAppStore";
import { NetworkTool } from "./NetworkTool";
import {DnsApiTool} from "./DnsApiTool";
import {WidgetErrorBoundary} from "../widgets/WidgetCard";
const categories=["网络工具","安全工具","开发工具","系统工具","AI工具","自定义网站"];
const reserved:Record<string,string[]>={"系统工具":["系统健康","本机资源"],"AI工具":["Agent Room","Ollama"]};
export function ToolboxWorkspace({onResources,onHealth,onAgentRoom,onLocalAi,onManageWebApps,onOpenWebApp,openToolRequest}:{onResources:()=>void;onHealth:()=>void;onAgentRoom:()=>void;onLocalAi:()=>void;onManageWebApps:()=>void;onOpenWebApp:(id:string)=>void;openToolRequest?:{id:string;nonce:number}}) {
  const [webApps,setWebApps]=useState(loadWebApps);
  useEffect(()=>subscribeWebApps(()=>setWebApps(loadWebApps())),[]);
  const [dnsApi,setDnsApi]=useState(false);
  const [network,setNetwork]=useState<{kind:string;name:string}|null>(null);
  const [category,setCategory]=useState("全部"),[tool,setTool]=useState<NativeToolId|null>(null),[input,setInput]=useState(""),[output,setOutput]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const contentKey=`${category}:${dnsApi?"dns-api":network?`network-${network.kind}`:tool?`native-${tool}`:"catalog"}`;
  const execute=async()=>{if(!tool)return;setBusy(true);setError("");try{setOutput(await runNativeTool(tool,input));}catch(error){setError(error instanceof Error?error.message:"工具运行失败");setOutput("");}finally{setBusy(false);}};
  const [query,setQuery]=useState("");
  useEffect(()=>{
    if(!openToolRequest)return;
    const id=openToolRequest.id,native=nativeTools.find(item=>item[0]===id),network=networkTools.find(item=>item[0]===id);
    if(!native&&!network&&id!=="dns-api")return;
    setTool(native?.[0]??null);setNetwork(network?{kind:network[0],name:network[1]}:null);setDnsApi(id==="dns-api");
    setInput("");setOutput("");setError("");setQuery("");
  },[openToolRequest]);
  const openPreset=(id:string)=>{try{const current=loadWebApps(),next=configureToolboxPreset(current,id);if(next.apps!==current)saveWebApps(next.apps);setError("");onOpenWebApp(next.id);}catch(error){setError(error instanceof Error?error.message:"无法打开工具网站");}};
  const catalog=[
    ...nativeTools.map(([id,name,description])=>({id,name,description,category:"开发工具",type:"Native",icon:"</>",open:()=>{setTool(id);setInput("");setOutput("");setError("");}})),
    {id:"dns-api",name:"DNS 传播检测",description:"Cloudflare / Google 公共解析器对比",category:"网络工具",type:"API",icon:"◎",open:()=>setDnsApi(true)},
    ...networkTools.map(([kind,name])=>({id:kind,name,description:"使用 Windows 本机网络能力",category:"网络工具",type:"Native",icon:"↗",open:()=>setNetwork({kind,name})})),
    ...Object.entries(reserved).flatMap(([group,names])=>names.map(name=>({id:name,name,description:group==="系统工具"?"查看已有本机真实数据":group==="AI工具"?"使用已有的 AI 入口":"等待配置可靠服务或工具网站",category:group,type:group==="系统工具"||group==="AI工具"?"Native":"未连接",icon:group==="AI工具"?"✳":group==="安全工具"?"◇":"▤",open:()=>group==="系统工具"?(name==="系统健康"?onHealth():onResources()):group==="AI工具"?(name==="Agent Room"?onAgentRoom():onLocalAi()):onManageWebApps()}))),
    ...toolboxPresets.map(preset=>({...preset,type:"Web",icon:"◉",open:()=>openPreset(preset.id)})),
    ...webApps.filter(app=>app.surface==="toolbox"&&!toolboxPresets.some(preset=>preset.url===app.url)).map(app=>({id:app.id,name:app.name,description:new URL(app.url).hostname,category:categories.includes(app.category)?app.category:"自定义网站",type:"Web",icon:"◉",open:()=>onOpenWebApp(app.id)})),
  ];
  const matches=catalog.filter(item=>(category==="全部"||item.category===category)&&`${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="wb-design-page wb-tools" data-no-page-swipe><WidgetErrorBoundary key={contentKey} widgetId={`toolbox:${contentKey}`} recoverable>
    {error&&!tool&&<p role="alert">{error}</p>}
    {dnsApi?<DnsApiTool onBack={()=>setDnsApi(false)}/>:network?<NetworkTool kind={network.kind} name={network.name} onBack={()=>setNetwork(null)}/>:tool?<NativeToolPanel tool={tool} input={input} output={output} error={error} busy={busy} onInput={setInput} onRun={()=>void execute()} onBack={()=>{setTool(null);setInput("");setOutput("");}} onCopy={()=>void navigator.clipboard.writeText(output).catch(()=>setError("剪贴板不可用，请手动复制"))}/>:<><header className="wb-page-head"><div><h1>工具箱</h1></div><button className="wb-outline" onClick={onManageWebApps}>管理工具网站</button></header><div className="wb-tool-search"><span>⌕</span><input aria-label="搜索工具" placeholder="搜索工具名称或用途…" value={query} onChange={event=>setQuery(event.target.value)}/>{query&&<button className="ui-icon-button" aria-label="清空工具搜索" onClick={()=>setQuery("")}><CloseIcon/></button>}</div><nav className="wb-chips wb-tool-chips">{["全部",...categories].map(item=><button key={item} aria-pressed={category===item} onClick={()=>setCategory(item)}>{item}</button>)}</nav><div className="wb-tool-drawer">{categories.filter(group=>category==="全部"||category===group).map(group=>{const items=matches.filter(item=>item.category===group);return items.length?<section key={group}><header><h2>{group}</h2><span>{items.length}</span></header><div className="wb-tool-grid">{items.map(item=><button className="wb-tool-card" key={item.id} onClick={item.open}><i>{item.icon}</i><span className="wb-tool-kind">{item.type}</span><h3>{item.name}</h3><p>{item.description}</p><span className="wb-tool-open">{item.type==="Web"?"打开网站":"打开"} ↗</span></button>)}</div></section>:null;})}{!matches.length&&<div className="wb-empty">没有找到匹配的工具</div>}<button className="wb-outline wb-tool-add" onClick={onManageWebApps}>＋ 添加自定义工具网站</button></div></>}
    </WidgetErrorBoundary>
  </section>;
}


export function NativeToolPanel({tool,input,output,error,busy,onInput,onRun,onBack,onCopy}:{tool:NativeToolId;input:string;output:string;error:string;busy:boolean;onInput:(value:string)=>void;onRun:()=>void;onBack:()=>void;onCopy:()=>void}) {
  return <article className="native-tool glass"><header><h2>{nativeTools.find(item=>item[0]===tool)?.[1]}</h2><button onClick={onBack}>返回工具箱</button></header><p className="tool-privacy">输入仅用于当前操作，不写入历史记录。</p>
    <div className={`native-tool-body${tool==="uuid"?" tool-auto-layout":""}`}><section className="tool-input-pane"><h3>{tool==="uuid"?"操作":"输入"}</h3>{tool!=="uuid"?<textarea aria-label="工具输入" placeholder="输入内容…" value={input} onChange={event=>onInput(event.target.value)} spellCheck={false}/>:<div className="tool-no-input">UUID 无需输入，点击运行即可生成。</div>}<div className="tool-run-row"><button disabled={busy} onClick={onRun}>{busy?"处理中…":"运行"}</button>{error&&<p role="alert">{error}</p>}</div></section>
    <section className="tool-output-pane"><header><h3>结果</h3>{output&&<button onClick={onCopy}>复制结果</button>}</header><pre aria-label="工具结果">{output||"结果会显示在这里"}</pre></section></div>
  </article>;
}
