import{useState}from"react";
import{mapCustomQuotes,newCustomHttpSource,type CustomHttpSource,type CustomQuoteFields,type TimeFormat}from"../domain/agriculture/customHttpQuotes";
const fieldLabels:Record<keyof CustomQuoteFields,string>={symbol:"代码字段",price:"价格字段",name:"名称字段",changePct:"涨跌幅字段",quoteAt:"行情日期字段",collectedAt:"来源采集时间字段",unit:"单位字段",currency:"币种字段"};
const timeOptions=[['iso','日期 / 带时区时间'],['yyyymmdd','YYYYMMDD'],['unixSeconds','Unix 秒'],['unixMilliseconds','Unix 毫秒']];
export function CustomHttpSourceEditor({sources,onChange,disabled}:{sources:CustomHttpSource[];onChange:(sources:CustomHttpSource[])=>void;disabled:boolean}){
 return <section className="settings-section"><strong>自定义行情接口</strong>
  {sources.map((source,index)=><Source key={source.id} source={source} disabled={disabled} onChange={next=>onChange(sources.map((item,i)=>i===index?next:item))} onRemove={()=>{if(window.confirm(`从配置中移除“${source.name||"未命名接口"}”？保存后生效。`))onChange(sources.filter((_,i)=>i!==index));}}/>)}
  <button disabled={disabled||sources.length>=4} onClick={()=>onChange([...sources,newCustomHttpSource(crypto.randomUUID())])}>添加行情接口</button>
  <small>首版只支持公开 HTTPS GET JSON，最多 4 个。不要填写密钥或含密钥的地址。新增接口默认关闭、默认手动读取。</small>
 </section>;
}
function Source({source,onChange,onRemove,disabled}:{source:CustomHttpSource;onChange:(source:CustomHttpSource)=>void;onRemove:()=>void;disabled:boolean}){
 const[sample,setSample]=useState(""),[preview,setPreview]=useState(""),[failed,setFailed]=useState(false);
 const[expanded,setExpanded]=useState(!source.name);
 const field=(key:keyof CustomQuoteFields)=><label key={key}>{fieldLabels[key]}<input aria-label={`${source.name||"新接口"} ${fieldLabels[key]}`} value={source.fields[key]} disabled={disabled} onChange={e=>{onChange({...source,fields:{...source.fields,[key]:e.target.value}});setPreview("");}} placeholder={key==="symbol"?"symbol":key==="price"?"quote.price":"可选"}/></label>;
 const test=()=>{try{if(new TextEncoder().encode(sample).byteLength>512*1024)throw Error("JSON 超过 512 KB，请缩小范围");const result=mapCustomQuotes(JSON.parse(sample),source);setFailed(false);setPreview(result.quotes.slice(0,5).map(row=>`${row.symbol} · ${row.price??"—"} · ${row.quoteAt??"行情时间未知"}${row.warning?` · ${row.warning}`:""}`).join("\n")+(result.ignored?`\n${result.ignored} 条记录未识别到代码，已跳过`:""));}catch(cause){setFailed(true);setPreview(cause instanceof Error?cause.message:"JSON 无法读取");}};
 return <details className="settings-help" open={expanded} onToggle={e=>setExpanded(e.currentTarget.open)}><summary>{source.name||"新行情接口"}</summary><fieldset disabled={disabled} className="beszel-settings custom-http-fields">
  <label>来源名称<input aria-label={`${source.name||"新接口"} 来源名称`} value={source.name} maxLength={60} onChange={e=>onChange({...source,name:e.target.value})}/></label>
  <label>接口地址<input aria-label={`${source.name||"新接口"} 接口地址`} value={source.url} placeholder="https://example.org/quotes?symbol=..." onChange={e=>onChange({...source,url:e.target.value})}/></label>
  <label className="settings-toggle"><span>启用（已确认允许免费只读查询）</span><input aria-label={`${source.name||"新接口"} 启用接口`} type="checkbox" checked={source.enabled} onChange={e=>onChange({...source,enabled:e.target.checked})}/></label>
  <label>数据结构<select value={source.rowMode} aria-label={`${source.name||"新接口"} 数据结构`} onChange={e=>{onChange({...source,rowMode:e.target.value as "list"|"single"});setPreview("");}}><option value="list">多条记录（数组）</option><option value="single">单条记录（对象）</option></select></label>
  <label>数据列表 / 对象位置<input aria-label={`${source.name||"新接口"} 数据位置`} value={source.rowsPath} onChange={e=>{onChange({...source,rowsPath:e.target.value});setPreview("");}} placeholder="data.items，根位置留空"/></label>
  {field("symbol")}{field("price")}{field("quoteAt")}
  <label>行情类型<select value={source.dataType} aria-label={`${source.name||"新接口"} 行情类型`} onChange={e=>onChange({...source,dataType:e.target.value as "daily"|"intraday"})}><option value="daily">日收盘</option><option value="intraday">盘中快照</option></select></label>
  <label>行情时间格式<select value={source.timeFormat} onChange={e=>{onChange({...source,timeFormat:e.target.value as TimeFormat});setPreview("");}}>{timeOptions.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
  <details><summary>可选字段和刷新</summary>{(["name","changePct","collectedAt","unit","currency"] as const).map(field)}
   <label>来源采集时间格式<select value={source.collectionFormat} onChange={e=>{onChange({...source,collectionFormat:e.target.value as TimeFormat});setPreview("");}}>{timeOptions.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
   <label>涨跌幅口径<select value={source.changeScale} onChange={e=>{onChange({...source,changeScale:e.target.value as "percent"|"ratio"});setPreview("");}}><option value="percent">百分数（2 表示 2%）</option><option value="ratio">小数（0.02 表示 2%）</option></select></label>
   <label className="settings-toggle"><span>自动刷新（仅市场页显示时）</span><input aria-label={`${source.name||"新接口"} 自动刷新`} type="checkbox" checked={source.autoRefresh} onChange={e=>onChange({...source,autoRefresh:e.target.checked})}/></label>
   <label>刷新间隔（分钟）<input type="number" min={5} max={1440} value={source.refreshMinutes} onChange={e=>onChange({...source,refreshMinutes:Number(e.target.value)})}/></label>
   <label>盘中过期阈值（分钟）<input type="number" min={1} max={1440} value={source.staleMinutes} onChange={e=>onChange({...source,staleMinutes:Number(e.target.value)})}/></label>
  </details>
  <details><summary>粘贴 JSON 本机预览（不联网）</summary><label>接口 JSON<textarea aria-label={`${source.name||"新接口"} 预览JSON`} rows={6} value={sample} onChange={e=>{setSample(e.target.value);setPreview("");}} placeholder="粘贴一段接口响应，只用于本机预览，不保存原文"/></label><button type="button" onClick={test}>预览字段对应</button>{preview&&<pre role="status" className={failed?"wb-quote-unavailable":""} style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{preview}</pre>}</details>
  <button type="button" onClick={onRemove}>移除此接口</button>
 </fieldset></details>;
}
