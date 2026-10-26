import {connectorNames,type ConnectorId} from "../domain/agent/agentRoom";
export type AgentDisplayNames=Partial<Record<ConnectorId,string>>;
const key="codex-desktop.agent-display-names.v1";
export function normalizeAgentDisplayNames(value:unknown):AgentDisplayNames {
  if(!value||typeof value!=="object"||Array.isArray(value))return {};
  const names:AgentDisplayNames={};
  for(const id of connectorNames){const raw=(value as Record<string,unknown>)[id];if(typeof raw!=="string")continue;const name=raw.replace(/[\u0000-\u001f\u007f]/g,"").trim().slice(0,40);if(name&&name!==id)names[id]=name;}
  return names;
}
export function loadAgentDisplayNames():AgentDisplayNames{try{return normalizeAgentDisplayNames(JSON.parse(localStorage.getItem(key)??"null"));}catch{return {};}}
export function saveAgentDisplayNames(names:AgentDisplayNames):AgentDisplayNames{const normalized=normalizeAgentDisplayNames(names);localStorage.setItem(key,JSON.stringify(normalized));return normalized;}
export function agentDisplayName(id:ConnectorId,names:AgentDisplayNames):string{return names[id]||id;}
