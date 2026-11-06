import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {isTauri} from '@tauri-apps/api/core';
import {readMailSnapshot,refreshMailInbox,mailStateLabel,mailSenderLabel,mailAccountsByLatest,nextOtp,remainingOtpTime,type MailSnapshot,type OtpNotice,type MailProvider} from '../services/mailOtp';
import {CloseIcon} from './CloseIcon';

export function MailOtpToast({blocked,enabled=true,recent=false,animations=true,onCloseRecent,onOpenSettings}:{onOpenSettings?:()=>void;blocked:boolean;enabled?:boolean;recent?:boolean;animations?:boolean;onCloseRecent?:()=>void}){
 const [snapshot,setSnapshot]=useState<MailSnapshot>({accounts:[],statuses:[],notices:[]}),[active,setActive]=useState<OtpNotice>(),[clock,setClock]=useState(Date.now()),[hover,setHover]=useState(false),[copied,setCopied]=useState(''),[error,setError]=useState('');
 const [selectedAccount,setSelectedAccount]=useState(''),[loadError,setLoadError]=useState(''),[refreshing,setRefreshing]=useState(false);
 useEffect(()=>{if(selectedAccount&&!snapshot.accounts.some(a=>a.id===selectedAccount))setSelectedAccount('')},[selectedAccount,snapshot.accounts]);
 const dismissed=useRef(new Set<string>()),shown=useRef(0),copyTimer=useRef<number|undefined>(undefined);
 const dismiss=()=>{if(active)dismissed.current.add(active.id);setActive(undefined);setHover(false);setCopied('');setError('');};
 useEffect(()=>{setHover(false)},[active?.id,blocked]);
 useEffect(()=>{if(recent){snapshot.notices.forEach(n=>dismissed.current.add(n.id));setActive(undefined);setHover(false)}},[recent,snapshot.notices]);
 useEffect(()=>{if(!enabled||!isTauri())return;let alive=true,inFlight=false;const read=async()=>{if(inFlight)return;inFlight=true;try{const value=await readMailSnapshot();if(alive){setSnapshot(value);setLoadError('')}}catch{if(alive)setLoadError('邮箱状态读取失败，稍后重试')}finally{inFlight=false}};void read();const timer=window.setInterval(()=>void read(),1500);return()=>{alive=false;window.clearInterval(timer)}},[enabled]);
 useEffect(()=>{const timer=window.setInterval(()=>setClock(Date.now()),250);return()=>{window.clearInterval(timer);window.clearTimeout(copyTimer.current)}},[]);
 useEffect(()=>{const ids=new Set(snapshot.notices.map(n=>n.id));for(const id of dismissed.current)if(!ids.has(id))dismissed.current.delete(id)},[snapshot.notices]);
 useEffect(()=>{if(!enabled){setActive(undefined);return}if(active){if(active.expiresAt<=clock||(!hover&&!blocked&&!recent&&remainingOtpTime(shown.current,active.expiresAt,clock)===0))dismiss();return}if(!blocked&&!recent){const next=nextOtp(snapshot.notices,dismissed.current,clock);if(next){shown.current=clock;setActive(next);setError('');setCopied('')}}},[snapshot.notices,clock,blocked,recent,enabled,active,hover]);
 useEffect(()=>{if(active&&(blocked||recent||hover))shown.current=Date.now()},[active,blocked,recent,hover,clock]);
 const refresh=async()=>{setRefreshing(true);setLoadError('');try{await refreshMailInbox();setSnapshot(await readMailSnapshot())}catch(e){setLoadError(typeof e==='string'?e:'邮箱刷新失败')}finally{setRefreshing(false)}};
 const copy=async(n:OtpNotice)=>{if(!n.code||n.expiresAt<=Date.now()){setError('验证码已过期');return}setError('');try{await navigator.clipboard.writeText(n.code);setCopied(n.id);window.clearTimeout(copyTimer.current);copyTimer.current=window.setTimeout(()=>{dismissed.current.add(n.id);setActive(a=>a?.id===n.id?undefined:a);setCopied('');},700)}catch{setError('复制失败，请重试')}};
 const notices=(snapshot.inbox??snapshot.notices).filter(n=>!selectedAccount||n.accountId===selectedAccount).sort((a,b)=>b.receivedAt-a.receivedAt).slice(0,20);
 if(!enabled||blocked&&!recent||!recent&&!active)return null;
 return <MailOtpCard animations={animations} recent={recent} active={active} notices={notices} snapshot={snapshot} copied={copied} error={error||loadError} copy={copy} selectedAccount={selectedAccount} onSelectAccount={setSelectedAccount} refreshing={refreshing} onRefresh={()=>void refresh()} onOpenSettings={onOpenSettings} onHover={setHover} onClose={()=>{if(recent)onCloseRecent?.();else dismiss()}}/>;
}
function MailProviderIcon({provider}:{provider:MailProvider}){
 return <span className="mail-account-icon" data-provider={provider} aria-hidden="true"><svg viewBox="0 0 24 24">{provider==='gmail'?<><path d="M3 19V6l9 7 9-7v13" fill="none" strokeWidth="4" stroke="#4285f4"/><path d="m3 6 9 7 9-7" fill="none" stroke="#ea4335" strokeWidth="4"/><path d="M21 6v13" stroke="#34a853" strokeWidth="4"/></>:provider==='mail163'?<><rect width="24" height="24" rx="6" fill="currentColor"/><text x="12" y="16" textAnchor="middle" fill="white" fontSize="11" fontWeight="700">163</text></>:provider==='outlook'?<><path d="M9 5h13v15H9z" fill="currentColor" opacity=".55"/><path d="m9 8 6.5 5L22 8" fill="none" stroke="white" strokeWidth="1.5"/><rect x="1" y="3" width="13" height="18" rx="2" fill="currentColor"/><text x="7.5" y="16" textAnchor="middle" fill="white" fontSize="12" fontWeight="600">O</text></>:<><rect x="1" y="4" width="22" height="17" rx="4" fill="currentColor"/><path d="m3 7 9 7 9-7" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></>}</svg></span>;
}
function MailAccountList({snapshot,selectedAccount,onSelectAccount,animations}:{snapshot:MailSnapshot;selectedAccount:string;onSelectAccount?:(id:string)=>void;animations:boolean}){
 const accounts=mailAccountsByLatest(snapshot),order=JSON.stringify(accounts.map(a=>a.id));
 const rows=useRef(new Map<string,HTMLButtonElement>()),positions=useRef(new Map<string,number>());
 useLayoutEffect(()=>{
  const next=new Map<string,number>(),motions:Animation[]=[];
  const move=animations&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  for(const [id,row] of rows.current){
   const top=row.offsetTop,previous=positions.current.get(id);next.set(id,top);
   if(move&&previous!==undefined&&previous!==top&&typeof row.animate==='function')motions.push(row.animate([{transform:`translateY(${previous-top}px)`,opacity:previous>top ? .6 : 1},{transform:'translateY(0)',opacity:1}],{duration:500,easing:'cubic-bezier(.22,1,.36,1)'}));
  }
  positions.current=next;return()=>motions.forEach(m=>m.cancel());
 },[order,animations]);
 return <div className="mail-account-list">{accounts.map(a=>{const status=snapshot.statuses.find(s=>s.accountId===a.id);return <button key={a.id} ref={node=>{if(node)rows.current.set(a.id,node);else rows.current.delete(a.id)}} data-mail-account={a.id} className="mail-inbox-account" aria-pressed={selectedAccount===a.id} title={a.enabled&&status?.message?status.message:a.email} onClick={()=>onSelectAccount?.(selectedAccount===a.id?'':a.id)}><MailProviderIcon provider={a.provider}/><strong>{a.email}</strong><span className={`mail-inbox-state is-${a.enabled?status?.state??'waiting':'paused'}`}>{mailStateLabel(a,status)}</span></button>})}</div>;
}
function MailActionIcon({kind}:{kind:'refresh'|'settings'}){return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kind==='refresh'?<><path d="M20 10a8 8 0 1 0 .2 4M20 4v6h-6"/></>:<><path d="m9 3-.7 2.2-2 .9-2.1-.6L2.7 8l1.5 1.7-.2 2.4L2.5 14l1.5 2.6 2.3-.4 1.8 1.3.4 2.3h3l1-2 2.3-.4 1.8 1.4 2.6-1.5-.5-2.3 1.1-2 .9-1.7-1.5-2.6-2.3.3-1.8-1.4-.3-2.3Z"/><circle cx="11" cy="11.5" r="3"/></>}</svg>}
export function MailOtpCard({recent,active,notices,snapshot,copied,error,copy,onClose,onHover,selectedAccount='',onSelectAccount,onRefresh,onOpenSettings,refreshing=false,animations=true}:{recent:boolean;active?:OtpNotice;notices:OtpNotice[];snapshot:MailSnapshot;copied:string;error:string;copy:(notice:OtpNotice)=>Promise<void>;onClose:()=>void;onHover?:(hover:boolean)=>void;selectedAccount?:string;onSelectAccount?:(id:string)=>void;onRefresh?:()=>void;onOpenSettings?:()=>void;refreshing?:boolean;animations?:boolean}){
 return <aside className={`island-popover glass mail-otp-toast${recent?' mail-inbox-panel':''}`} data-main-hit-region aria-label={recent?'最近邮件':active?.code?'邮箱验证码':'新邮件'} onMouseEnter={()=>onHover?.(true)} onMouseLeave={()=>onHover?.(false)}>
  {!recent&&<button className="ui-icon-button mail-otp-close" aria-label={active?.code?'关闭验证码':'关闭新邮件提醒'} onClick={onClose}><CloseIcon/></button>}
  {recent?<>
   <header className="mail-inbox-header"><h3>邮箱</h3><div className="mail-inbox-actions"><button className={`mail-icon-action${refreshing?' is-refreshing':''}`} aria-label="刷新邮箱" title="刷新邮箱" aria-busy={refreshing} disabled={refreshing||!snapshot.accounts.some(a=>a.enabled)} onClick={onRefresh}><MailActionIcon kind="refresh"/></button><button className="mail-icon-action" aria-label="管理邮箱" title="管理邮箱" onClick={onOpenSettings}><MailActionIcon kind="settings"/></button><button className="mail-icon-action" aria-label="关闭邮箱" title="关闭" onClick={onClose}><CloseIcon/></button></div></header>
   {snapshot.accounts.length>0?<nav className="mail-inbox-accounts" aria-label="邮箱账户">
    {snapshot.accounts.length>1&&<button className="mail-inbox-all" aria-pressed={!selectedAccount} onClick={()=>onSelectAccount?.('')}>全部邮箱</button>}
    <MailAccountList snapshot={snapshot} selectedAccount={selectedAccount} onSelectAccount={onSelectAccount} animations={animations}/>
   </nav>:!error&&<p className="mail-otp-hint">尚未连接邮箱，请先在“管理邮箱”中添加。</p>}
   <span className="mail-otp-eyebrow mail-inbox-list-heading">最近邮件 · 最多 20 封</span>
   <div className="mail-inbox-list" role="list" aria-label="邮件列表">{notices.length?notices.map(n=><div className="mail-otp-recent-row" role="listitem" key={n.id}><div><strong title={n.sender}>{mailSenderLabel(n.sender)}</strong><p className="mail-notice-subject">{n.subject||'（无主题）'}</p><small>{new Date(n.receivedAt).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})}{snapshot.accounts.length>1&&` · ${snapshot.accounts.find(a=>a.id===n.accountId)?.email??''}`}</small></div>{n.code&&<button className="mail-code-chip" onClick={()=>void copy(n)} aria-label={`复制验证码 ${n.code}`}>{copied===n.id?'已复制':n.code}</button>}</div>):<p className="mail-otp-hint">暂无已读取的邮件</p>}</div>
  </>:active&&<>{active.code?<><span className="mail-otp-eyebrow">{active.sender||'新邮件'}</span><div className="mail-otp-code-row"><button className="mail-otp-code" aria-label={`复制验证码 ${active.code}`} onClick={()=>void copy(active)}>{active.code}</button><button className="mail-otp-copy" onClick={()=>void copy(active)}>{copied===active.id?'已复制':'复制'}</button></div></>:<><span className="mail-otp-eyebrow">新邮件</span><strong className="mail-notice-sender">{active.sender||'未知发件人'}</strong><p className="mail-notice-subject">{active.subject||'（无主题）'}</p></>}<small className="mail-otp-address">{snapshot.accounts.find(a=>a.id===active.accountId)?.email}</small></>}
  {error&&<p role="alert">{error}</p>}
 </aside>;
}
