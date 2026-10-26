import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'workbench-search-tests-'));
const related=process.argv.includes('--related');
try{
  await build({entryPoints:[resolve(related?'tests/productization.test.ts':'tests/workbenchSearch.test.ts')],outfile:join(dir,'search.mjs'),bundle:true,loader:{'.png':'dataurl','.svg':'dataurl','.webp':'dataurl'},platform:'node',jsx:'automatic',format:'esm',banner:{js:'import {createRequire} from "node:module";const require=createRequire(import.meta.url);'},logLevel:'silent'});
  process.exitCode=spawnSync(process.execPath,['--test',...(related?['--test-name-pattern=toolbox|native developer|workbench.*rail|workbench.*navigation']:[]),join(dir,'search.mjs')],{stdio:'inherit'}).status??1;
}finally{rmSync(dir,{recursive:true,force:true});}
