import {useEffect,useRef,useState} from 'react';
import {isTauri} from '@tauri-apps/api/core';
import {readMailSnapshot,addMailAccount,connectMailOAuth,cancelMailOAuth,updateMailAccount,mailProviders,type MailProvider,type MailSnapshot} from '../services/mailOtp';

export function MailOtpSettings(){
 const [snapshot,setSnapshot]=useState<MailSnapshot>({accounts:[],statuses:[],notices:[]});
 const [provider,setProvider]=useState<MailProvider>('qq'),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[clientId,setClientId]=useState(''),[clientSecret,setClientSecret]=useState(''),[consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[note,setNote]=useState(''),[removeId,setRemoveId]=useState<string>();
 const oauth=provider==='gmail'||provider==='outlook';
 const ownsOAuth=useRef(false);
 useEffect(()=>()=>{if(ownsOAuth.current)void cancelMailOAuth().catch(()=>{})},[]);
 useEffect(()=>{let active=true;const refresh=()=>{void readMailSnapshot().then(s=>{if(active)setSnapshot(s)}).catch(()=>{if(active)setError('邮箱设置读取失败，请重试')})};refresh();const timer=window.setInterval(refresh,3000);return()=>{active=false;window.clearInterval(timer)}},[]);
 const refresh=async()=>setSnapshot(await readMailSnapshot());
 const add=async()=>{ownsOAuth.current=oauth;setBusy(true);setError('');setNote('');try{if(oauth)await connectMailOAuth(provider,clientId,clientSecret,consent);else await addMailAccount(provider,email.trim(),password,consent);setPassword('');setClientSecret('');setConsent(false);setEmail('');await refresh();setNote('已连接，新验证码会在 HUD 提醒');}catch(e){setError(typeof e==='string'?e:'邮箱连接失败，请重试')}finally{ownsOAuth.current=false;setBusy(false)}};
 const update=async(id:string,enabled:boolean,remove=false)=>{setBusy(true);setError('');try{await updateMailAccount(id,enabled,remove);setRemoveId(undefined);await refresh()}catch(e){setError(typeof e==='string'?e:'邮箱设置保存失败')}finally{setBusy(false)}};
 return <div className="settings-section mail-otp-settings"><strong>邮箱验证码</strong><p className="mail-otp-hint">新验证码在 HUD 弹出，点击复制。只读查收，本机识别。</p>
  {snapshot.accounts.map(a=>{const status=snapshot.statuses.find(s=>s.accountId===a.id);return <section className="mail-otp-account" key={a.id}><div><strong>{a.email}</strong><small>{mailProviders[a.provider]} · {!a.enabled?'已暂停':status?.state==='ready'?'监听中':status?.state==='error'?'连接异常':'连接中…'}</small>{a.enabled&&status?.message&&<small role="status">{status.message}</small>}</div><label className="mail-otp-switch"><input type="checkbox" aria-label={`监听 ${a.email}`} checked={a.enabled} disabled={busy} onChange={e=>void update(a.id,e.target.checked)}/>监听</label>{removeId===a.id?<span className="mail-otp-remove"><button disabled={busy} onClick={()=>void update(a.id,false,true)}>确认移除</button><button disabled={busy} onClick={()=>setRemoveId(undefined)}>取消</button></span>:<button disabled={busy} onClick={()=>setRemoveId(a.id)}>移除</button>}</section>})}
  <fieldset disabled={busy||!isTauri()}><legend>添加邮箱</legend>
   <label>邮箱类型<select value={provider} onChange={e=>{setProvider(e.target.value as MailProvider);setPassword('');setClientSecret('');setConsent(false);setError('')}}>{Object.entries(mailProviders).map(([id,label])=><option value={id} key={id}>{label}</option>)}</select></label>
   {oauth?<><label>应用 Client ID<input value={clientId} autoComplete="off" onChange={e=>setClientId(e.target.value)}/></label>{provider==='gmail'&&<label>应用 Client Secret<input type="password" value={clientSecret} autoComplete="off" onChange={e=>setClientSecret(e.target.value)}/></label>}<details><summary>首次连接说明</summary>{provider==='gmail'?<p>需要你自己的 Google 桌面应用 OAuth 配置，并启用 Gmail API。登录仅申请 Gmail 只读权限；若应用处于测试状态，需要将自己的邮箱加入测试用户。</p>:<p>需要你自己的 Microsoft 应用 Client ID，允许个人账户与公共客户端登录，配置移动和桌面应用回调 http://localhost/oauth/callback。登录申请只读邮件、账户身份与离线续期权限。</p>}<p>凭据只保存在本机，不经过作者服务器。连接成功后每 30 秒检查新邮件。</p></details></>:<><label>邮箱地址<input type="email" autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)}/></label><label>客户端授权码<input type="password" autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)}/></label><small>先在邮箱网页版开启 IMAP，填写生成的客户端授权码。</small></>}
   <label className="mail-otp-consent"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>同意在 Windows 凭据管理器保存授权，并只读查收新邮件</label>
   <button disabled={!consent||(oauth?!clientId:!email||!password)} onClick={()=>void add()}>{oauth?'网页登录并连接':'连接邮箱'}</button>
  </fieldset>
  {busy&&<div role="status">正在连接…{oauth&&<button onClick={()=>void cancelMailOAuth().catch(()=>setError('取消失败，请重试'))}>取消登录</button>}</div>}
  {!isTauri()&&<small>连接邮箱需要 Windows 桌面版</small>}
  {error&&<p role="alert">{error}</p>}{note&&<p role="status">{note}</p>}
 </div>;
}
