
import { invoke, isTauri } from "@tauri-apps/api/core";
import { deepseekMention, validateRoomChatText, type RoomChatSnapshot } from "../domain/agent/agentRoom";

export interface RoomChatService {
  load(): Promise<RoomChatSnapshot>;
  send(id: string, text: string): Promise<RoomChatSnapshot>;
  pause(paused: boolean): Promise<void>;
  enablePaid(enabled: boolean): Promise<void>;
  cancel(): Promise<void>;
}
type RoomInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export function createNativeRoomChatService(call: RoomInvoke): RoomChatService {
  let sending = false;
  return {
    load: () => call<RoomChatSnapshot>("agent_room_chat_load"),
    async send(id, text) {
      const clean = validateRoomChatText(text);
      if (sending) throw new Error("已有一条请求正在执行，请等待或暂停");
      sending = true;
      try { return await call<RoomChatSnapshot>("agent_room_chat_send", { request: { id, text: clean } }); }
      finally { sending = false; }
    },
    pause: paused => call<void>("agent_room_chat_pause", { paused }),
    enablePaid: enabled => call<void>("agent_room_chat_enable_paid", { enabled }),
    cancel: () => call<void>("agent_room_cancel"),
  };
}
export function emptyRoomChatSnapshot(): RoomChatSnapshot {
  const day = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { messages: [], paused: false, paidEnabled: false, hasOlder: false,
    usage: { day, calls: 0, estimatedYuan: 0 }, credentialSource: null };
}
const browserKey = "codex-desktop.agent-room-chat.preview.v1";
/** Browser preview never has a model transport, including when @ is present. */
export function createBrowserRoomChatService(storage: Pick<Storage, "getItem" | "setItem">): RoomChatService {
  const load = async () => {
    const raw = storage.getItem(browserKey);
    if (!raw) return emptyRoomChatSnapshot();
    const value = JSON.parse(raw) as RoomChatSnapshot;
    if (!Array.isArray(value.messages) || typeof value.paused !== "boolean") throw new Error("浏览器聊天记录格式异常，未清空记录");
    return { ...value, paidEnabled: false, credentialSource: null, usage: emptyRoomChatSnapshot().usage };
  };
  const save = (value: RoomChatSnapshot) => storage.setItem(browserKey, JSON.stringify(value));
  return {
    load,
    async send(id, text) {
      const clean = validateRoomChatText(text);
      if (deepseekMention(clean)) throw new Error("浏览器预览不会调用 AI；@DeepSeek 需要桌面应用");
      const value = await load();
      if (value.messages.some(message => message.id === id)) throw new Error("这条消息已保存，不重复发送");
      if (value.messages.length >= 1000) throw new Error("浏览器预览已达到1000条记录，请使用桌面应用；未删除旧记录");
      value.messages.push({ id, role: "user", text: clean, createdAt: new Date().toISOString(), status: "saved" });
      save(value);
      return value;
    },
    async pause(paused) { save({ ...await load(), paused }); },
    async enablePaid(enabled) { if (enabled) throw new Error("浏览器预览禁止付费调用"); },
    async cancel() { /* No browser model request exists. */ },
  };
}
const nativeService = createNativeRoomChatService(invoke);
export function roomChatService(): RoomChatService {
  return isTauri() ? nativeService : createBrowserRoomChatService(localStorage);
}
