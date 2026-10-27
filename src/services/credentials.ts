import { invoke, isTauri } from "@tauri-apps/api/core";
export type CredentialSource = "beszel" | "deepseek" | "anthropic" | "openai" | "mimo" | "mimo-console" | "analysis-deepseek" | "analysis-anthropic";
export const hasCredential = (source: CredentialSource) => isTauri() ? invoke<boolean>("credential_exists", { source }) : Promise.resolve(false);
export const saveCredential = (source: CredentialSource, secret: string) => invoke<void>("credential_save", { source, secret });
export const clearCredential = (source: CredentialSource) => invoke<void>("credential_clear", { source });
export const hasLegacyCredentials = () => isTauri() ? invoke<boolean>("credential_legacy_available") : Promise.resolve(false);
export const importLegacyCredentials = (consent: boolean) => invoke<number>("credential_import_legacy", { consent });
