import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const outputDirectory = mkdtempSync(join(tmpdir(), "codex-desktop-tests-"));
try {
  await build({
    entryPoints: [resolve("tests/beszelHubStartup.test.ts"),resolve("tests/vpsServices.test.ts"),resolve("tests/tradingCalendar.test.ts"),resolve("tests/publicArgentina.test.ts"),resolve("tests/publicConab.test.ts"),resolve("tests/overseasFuturesQuotes.test.ts"),resolve("tests/chinaFuturesQuotes.test.ts"),resolve("tests/aStockQuotes.test.ts"),resolve("tests/worldBankMonthly.test.ts"),resolve("tests/freeDataCompletion.test.ts"),resolve("tests/publicWasde.test.ts"),resolve("tests/publicCftc.test.ts"),resolve("tests/builtinPublicData.test.ts"),resolve("tests/customHttpQuotes.test.ts"),resolve("tests/publicSources.test.ts"),resolve("tests/dataConnections.test.ts"),resolve("tests/avatarArtwork.test.ts"),resolve("tests/themes.test.ts"),resolve("tests/workbenchConvenience.test.ts"),resolve("tests/readableText.test.ts"),resolve("tests/workbenchSearch.test.ts"),resolve("tests/apiMoneySemantics.test.ts"),resolve("tests/vpsLocation.test.ts"),resolve("tests/vpsSourceTime.test.ts"),resolve("tests/mainContractPresentation.test.ts"),resolve("tests/marketDataIntegrity.test.ts"),resolve("tests/marketQuotes.test.ts"),resolve("tests/roomWorkspace.test.ts"),resolve("tests/agentRoomChat.test.ts"), resolve("tests/productization.test.ts"), resolve("tests/layoutStore.test.ts"), resolve("tests/providerRegistry.test.ts"), resolve("tests/providerRuntime.test.ts"), resolve("tests/pollingLifecycle.test.ts"), resolve("tests/phase18.test.ts"), resolve("tests/launcherStore.test.ts"), resolve("tests/notifications.test.ts"), resolve("tests/apiUsage.test.ts"), resolve("tests/pluginPermissions.test.ts"), resolve("tests/windowVisibility.test.ts"), resolve("tests/historyAnalysis.test.ts"), resolve("tests/runtimeCpu.test.ts"), resolve("tests/remoteAnalysis.test.ts")],
    outdir: outputDirectory,
    bundle: true,
    loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl" },
    platform: "node",
    jsx: "automatic",
    format: "esm",
    // React's server renderer uses Node builtins through CommonJS require.
    banner: { js: 'import { createRequire as codexTestCreateRequire } from "node:module"; const require = codexTestCreateRequire(import.meta.url);' },
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const testFiles = ["beszelHubStartup.test.mjs","vpsServices.test.mjs","tradingCalendar.test.mjs","publicArgentina.test.mjs","publicConab.test.mjs","overseasFuturesQuotes.test.mjs","chinaFuturesQuotes.test.mjs","aStockQuotes.test.mjs","worldBankMonthly.test.mjs","freeDataCompletion.test.mjs","publicWasde.test.mjs","publicCftc.test.mjs","builtinPublicData.test.mjs","customHttpQuotes.test.mjs","publicSources.test.mjs","dataConnections.test.mjs","avatarArtwork.test.mjs","themes.test.mjs","workbenchConvenience.test.mjs","readableText.test.mjs","workbenchSearch.test.mjs","apiMoneySemantics.test.mjs","vpsLocation.test.mjs","vpsSourceTime.test.mjs","mainContractPresentation.test.mjs","marketDataIntegrity.test.mjs","marketQuotes.test.mjs","roomWorkspace.test.mjs","agentRoomChat.test.mjs", "productization.test.mjs", "layoutStore.test.mjs", "providerRegistry.test.mjs", "providerRuntime.test.mjs", "pollingLifecycle.test.mjs", "phase18.test.mjs", "launcherStore.test.mjs", "notifications.test.mjs", "apiUsage.test.mjs", "pluginPermissions.test.mjs", "windowVisibility.test.mjs", "historyAnalysis.test.mjs", "runtimeCpu.test.mjs", "remoteAnalysis.test.mjs"].map((file) => join(outputDirectory, file));
  const result = spawnSync(process.execPath, ["--test", ...testFiles, resolve("tests/appUpdates.test.mjs"), resolve("tests/desktopSystemSettings.test.mjs"), resolve("tests/localAgentConsent.test.mjs"), resolve("tests/credentialIsolation.test.mjs"),resolve("tests/applicationPersistence.test.mjs"),resolve("tests/simulationIsolation.test.mjs"),resolve("tests/vpsLocationInteraction.test.mjs")], {
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outputDirectory, { recursive: true, force: true });
}

