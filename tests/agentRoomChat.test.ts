import test from "node:test";
import assert from "node:assert/strict";
import { deepseekMention, validateRoomChatText, roomChatLimits } from "../src/domain/agent/agentRoom";
test("human chat routes one explicit DeepSeek mention, ordinary messages do not call", () => {
  assert.equal(deepseekMention("记下这个想法"), false);
  assert.equal(deepseekMention("@DeepSeek 帮我解释一下"), true);
  assert.equal(deepseekMention("请 @DeepSeek 看看"), true);
  assert.equal(deepseekMention("x@DeepSeek.com"), false);
  assert.equal(deepseekMention("@DeepSeekOther 看看"), false);
  assert.equal(deepseekMention("@Claude 看看"), false);
  assert.throws(() => deepseekMention("@DeepSeek"));
  assert.throws(() => deepseekMention("@DeepSeek 看看 @DeepSeek 再看看"));
});
test("chat caps text and rejects empty or invalid input before persistence", () => {
  assert.equal(validateRoomChatText("  普通消息  "), "普通消息");
  assert.equal(validateRoomChatText("a".repeat(2000)).length, 2000);
  assert.throws(() => validateRoomChatText("a".repeat(2001)));
  assert.throws(() => validateRoomChatText(" "));
  assert.throws(() => validateRoomChatText("bad\u0000text"));
  assert.equal(roomChatLimits.dailyCalls, 20);
  assert.equal(roomChatLimits.dailyYuan, 1);
  assert.equal(roomChatLimits.outputTokens, 2048);
});


test("native chat adapter sends only the human input once and never retries a rejection", async () => {
  const { createNativeRoomChatService, emptyRoomChatSnapshot } = await import("../src/services/agentRoomChat");
  const calls: Array<{command:string;args?:Record<string,unknown>}> = [];
  const snapshot = emptyRoomChatSnapshot();
  const service = createNativeRoomChatService(async <T>(command:string,args?:Record<string,unknown>) => {
    calls.push({command,args});
    if (command === "agent_room_chat_send") throw new Error("模拟拒绝");
    return snapshot as T;
  });
  await assert.rejects(service.send("one", " @DeepSeek 你好 "), /模拟拒绝/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {command:"agent_room_chat_send",args:{request:{id:"one",text:"@DeepSeek 你好"}}});
  await assert.rejects(service.send("empty", " "), /消息需要/);
  assert.equal(calls.length, 1);
});
test("native adapter permits one in-flight send and pause is independent of it", async () => {
  const { createNativeRoomChatService, emptyRoomChatSnapshot } = await import("../src/services/agentRoomChat");
  let complete!: (value:ReturnType<typeof emptyRoomChatSnapshot>)=>void;
  const calls:string[]=[];
  const service=createNativeRoomChatService(async <T>(command:string) => {
    calls.push(command);
    if(command==="agent_room_chat_send") return await new Promise<ReturnType<typeof emptyRoomChatSnapshot>>(resolve=>{complete=resolve;}) as T;
    return undefined as T;
  });
  const first=service.send("first","@DeepSeek 问题");
  await assert.rejects(service.send("second","@DeepSeek 问题"),/已有一条/);
  await service.pause(true);
  assert.deepEqual(calls,["agent_room_chat_send","agent_room_chat_pause"]);
  complete(emptyRoomChatSnapshot()); await first;
  const third=service.send("third","普通消息"); complete(emptyRoomChatSnapshot()); await third;
  assert.equal(calls.filter(command=>command==="agent_room_chat_send").length,2);
});
test("browser preview persists ordinary chat and pause after reopening without an AI transport", async () => {
  const {createBrowserRoomChatService}=await import("../src/services/agentRoomChat");
  const records=new Map<string,string>();
  const storage={getItem:(key:string)=>records.get(key)??null,setItem:(key:string,value:string)=>{records.set(key,value);}};
  const first=createBrowserRoomChatService(storage);
  await first.send("note","我的想法"); await first.pause(true);
  const reopened=createBrowserRoomChatService(storage);
  const snapshot=await reopened.load();
  assert.equal(snapshot.messages[0].text,"我的想法"); assert.equal(snapshot.paused,true);
  assert.equal(snapshot.usage.calls,0); assert.equal(snapshot.paidEnabled,false);
  await assert.rejects(reopened.send("mention","@DeepSeek 问题"),/预览不会调用/);
  await assert.rejects(reopened.enablePaid(true),/禁止付费/);
  assert.equal((await reopened.load()).messages.length,1);
});
test("browser storage failures remain visible instead of claiming chat was saved", async () => {
  const {createBrowserRoomChatService}=await import("../src/services/agentRoomChat");
  const service=createBrowserRoomChatService({getItem:()=>null,setItem:()=>{throw new Error("模拟磁盘已满");}});
  await assert.rejects(service.send("note","我的想法"),/模拟磁盘已满/);
});

test("chat UI has one readable composer and member settings without fake connection claims", async () => {
  const React=await import("react"),{renderToStaticMarkup}=await import("react-dom/server"),{AgentRoom}=await import("../src/components/AgentRoom");
  const html=renderToStaticMarkup(React.createElement(AgentRoom,{visible:false}));
  assert.match(html,/aria-label="聊天室消息"/); assert.match(html,/role="log"/);
  assert.match(html,/添加模型、文件或照片/); assert.match(html,/收起模型/);
  assert.match(html,/未接入/); assert.match(html,/更多/);
  assert.doesNotMatch(html,/今日已用|每日上限|0 \/ 20|在线|已接入/);
  assert.doesNotMatch(html,/成员回复|录入回复|生成总结|继续讨论|打开.*订阅/);
});
