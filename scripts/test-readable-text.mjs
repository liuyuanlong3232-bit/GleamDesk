import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'readable-text-tests-'));
try{
  const files=process.argv.includes('--related')?['productization','phase18']:['readableText'];
  await build({entryPoints:files.map(name=>resolve(`tests/${name}.test.ts`)),outdir:dir,outExtension:{'.js':'.mjs'},bundle:true,loader:{'.png':'dataurl','.svg':'dataurl','.webp':'dataurl'},platform:'node',jsx:'automatic',format:'esm',banner:{js:'import {createRequire} from "node:module";const require=createRequire(import.meta.url);'},logLevel:'silent'});
  process.exitCode=spawnSync(process.execPath,['--test',...(process.argv.includes('--related')?['--test-name-pattern=resource|hardware|disk|overview trend|VPS|settings modal|daily recommendations|API connection cards']:[]),...files.map(name=>join(dir,`${name}.test.mjs`))],{stdio:'inherit'}).status??1;
}finally{rmSync(dir,{recursive:true,force:true});}
