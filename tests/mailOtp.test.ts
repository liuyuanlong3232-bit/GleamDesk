import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nextOtp,remainingOtpTime,type OtpNotice} from '../src/services/mailOtp';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MailOtpCard} from '../src/components/MailOtpToast';
import {MailOtpSettings} from '../src/components/MailOtpSettings';

const notice=(id:string,expiresAt:number):OtpNotice=>({id,accountId:'a',sender:'Example',code:'123456',receivedAt:1,expiresAt});
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
 const html=renderToStaticMarkup(createElement(MailOtpCard,{recent:true,notices:[],snapshot:{accounts:[],statuses:[],notices:[]},copied:'',error:'',copy:async()=>{},onClose:()=>{}}));assert.match(html,/暂无有效验证码/);assert.doesNotMatch(html,/123456/);
});
test('settings offers all four providers and requires explicit local credential consent',()=>{
 const html=renderToStaticMarkup(createElement(MailOtpSettings));for(const label of ['QQ 邮箱','163 邮箱','Gmail','Outlook'])assert.ok(html.includes(label));assert.match(html,/Windows 凭据管理器/);assert.match(html,/客户端授权码/);assert.match(html,/fieldset disabled/);
});
