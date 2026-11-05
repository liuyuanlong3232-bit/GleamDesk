import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nextOtp,remainingOtpTime,type OtpNotice} from '../src/services/mailOtp';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MailOtpCard} from '../src/components/MailOtpToast';
import {MailOtpSettings} from '../src/components/MailOtpSettings';
import {HudMailButton} from '../src/components/StatusHud';

const notice=(id:string,expiresAt:number):OtpNotice=>({id,accountId:'a',sender:'Example',subject:'登录验证',code:'123456',receivedAt:1,expiresAt});
test('queued codes expire before display and dismissed codes stay dismissed',()=>{
 assert.equal(nextOtp([notice('old',10),notice('new',50)],new Set(),20)?.id,'new');
 assert.equal(nextOtp([notice('new',50)],new Set(['new']),20),undefined);
});
test('hover pauses only the short presentation timer, never actual code expiry',()=>{
 assert.equal(remainingOtpTime(100,200,150),50);
 assert.equal(remainingOtpTime(100,200,250),0);
});
test('HUD card shows source, code and copy without a mailbox reader',()=>{
 const n=notice('new',500);const html=renderToStaticMarkup(createElement(MailOtpCard,{recent:false,active:n,notices:[n],snapshot:{accounts:[{id:'a',email:'test@example.com',provider:'gmail',enabled:true}],statuses:[],notices:[n]},copied:'',error:'',copy:async()=>{},onClose:()=>{}}));
 assert.match(html,/data-main-hit-region/);assert.match(html,/123456/);assert.match(html,/test@example.com/);assert.match(html,/复制/);assert.doesNotMatch(html,/收件箱|正文/);
});
test('empty recent-code panel does not invent a code',()=>{
 const html=renderToStaticMarkup(createElement(MailOtpCard,{recent:true,notices:[],snapshot:{accounts:[],statuses:[],notices:[]},copied:'',error:'',copy:async()=>{},onClose:()=>{}}));assert.match(html,/暂无最近邮件/);assert.doesNotMatch(html,/123456/);
});
test('settings offers all four providers and requires explicit local credential consent',()=>{
 const html=renderToStaticMarkup(createElement(MailOtpSettings));for(const label of ['QQ 邮箱','163 邮箱','Gmail','Outlook'])assert.ok(html.includes(label));assert.match(html,/Windows 凭据管理器/);assert.match(html,/客户端授权码/);assert.match(html,/fieldset disabled/);
});
test('ordinary mail shows sender and subject without a copy action',()=>{
 const n:OtpNotice={...notice('mail',500),subject:'本周安排',code:null};
 const html=renderToStaticMarkup(createElement(MailOtpCard,{recent:false,active:n,notices:[],snapshot:{accounts:[],statuses:[],notices:[n]},copied:'',error:'',copy:async()=>{throw Error('ordinary mail must not copy')},onClose:()=>{}}));
 assert.match(html,/新邮件/);assert.match(html,/本周安排/);assert.match(html,/Example/);assert.doesNotMatch(html,/复制验证码|mail-otp-copy/);
});
test('verification mail takes priority over ordinary queued mail',()=>{
 const mail:OtpNotice={...notice('mail',500),subject:'本周安排',code:null};
 assert.equal(nextOtp([mail,notice('otp',500)],new Set(),20)?.id,'otp');
 assert.equal(nextOtp([mail],new Set(),20)?.id,'mail');
});
test('automatic reminders last thirty seconds within the actual code expiry',()=>{
 assert.equal(remainingOtpTime(0,300_000,20_000),10_000);
 assert.equal(remainingOtpTime(0,300_000,30_000),0);
 assert.equal(remainingOtpTime(0,25_000,25_000),0);
});
test('mail icon opens a persistent list with ordinary subjects and copyable codes',()=>{
 const button=renderToStaticMarkup(createElement(HudMailButton,{onOpen:()=>{},onEnter:()=>{},expanded:true}));assert.match(button,/打开邮箱提醒/);assert.match(button,/aria-expanded="true"/);assert.match(button,/<svg/);
 const mail:OtpNotice={...notice('mail',500),subject:'本周安排',code:null};const otp=notice('otp',500);const html=renderToStaticMarkup(createElement(MailOtpCard,{recent:true,notices:[mail,otp],snapshot:{accounts:[],statuses:[],notices:[mail,otp]},copied:'',error:'',copy:async()=>{},onClose:()=>{}}));assert.match(html,/最近邮件/);assert.match(html,/本周安排/);assert.match(html,/复制验证码 123456/);assert.doesNotMatch(html,/复制验证码 null/);
});
