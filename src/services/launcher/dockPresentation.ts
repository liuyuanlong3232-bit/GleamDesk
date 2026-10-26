import wechat from "../../assets/dock/wechat.png";
import qq from "../../assets/dock/qq.png";
import edge from "../../assets/dock/edge.png";
import chatgpt from "../../assets/dock/chatgpt.png";
import qwen from "../../assets/dock/qwen.png";
import ollama from "../../assets/dock/ollama.svg";
import vscode from "../../assets/dock/vscode.svg";
import terminal from "../../assets/dock/terminal.svg";
import claude from "../../assets/dock/claude.svg";
import deepseek from "../../assets/dock/deepseek.svg";

export const starterDockIcons: Record<string, string> = {
  wechat, qq, edge, vscode, terminal, claude, chatgpt, codex: chatgpt,
  "builtin-ollama": ollama, "builtin-qwen": qwen, "builtin-deepseek-local": deepseek,
};