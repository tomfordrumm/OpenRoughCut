import {app,BrowserWindow,dialog} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot=path.resolve(root, '..', '..');
const work=mkdtempSync(path.join(tmpdir(), 'openroughcut-smoke-'));
const bin=path.join(repoRoot, 'vendor', `${process.platform}-${process.arch}`, 'bin');
mkdirSync(work+'/user-data/runtime/bin', {recursive:true});
for (const name of ['ffmpeg','ffprobe']) symlinkSync(path.join(bin,name),work+'/user-data/runtime/bin/'+name);
execFileSync(path.join(bin,'ffmpeg'), ['-v','error','-f','lavfi','-i','color=c=blue:s=3840x1080:r=30:d=3','-f','lavfi','-i','sine=frequency=440:duration=3','-c:v','libx264','-preset','ultrafast','-c:a','aac',work+'/Видео тест.mov']);
console.log('Isolated Electron smoke profile:',work);
app.setPath('userData',work+'/user-data');
app.setPath('cache',work+'/cache');
let openPath=work+'/Видео тест.mov', savePath=work+'/Проект тест.roughcut';
dialog.showOpenDialog=async()=>openPath?{canceled:false,filePaths:[openPath]}:{canceled:true,filePaths:[]};
dialog.showSaveDialog=async()=>savePath?{canceled:false,filePath:savePath}:{canceled:true};
await import(root+'/electron/main.js');
(async () => {
try {
 await app.whenReady();
 let win;
 for(let i=0;i<100;i++){
   win=BrowserWindow.getAllWindows()[0];
   if(win && !win.webContents.isLoading() && await win.webContents.executeJavaScript('Boolean(window.roughcut)'))break;
   await new Promise(r=>setTimeout(r,100));
 }
 const call=(method,args)=>win.webContents.executeJavaScript(`window.roughcut[${JSON.stringify(method)}](${JSON.stringify(args)})`);
 const source=await call('chooseVideo');assert.equal(source.media.width,3840);
 const preview=call('preparePreview',{sourceId:source.sourceId});
 // Observe rejection immediately to avoid an unhandled-rejection race.
 const previewResult=preview.then(()=>({finished:true}),error=>({error}));
 const cancelled=await call('cancelOperation');
 assert.equal(cancelled.cancelled,true);
 assert.ok((await previewResult).error);

 const settings={thresholdDb:-35,minimumSilence:0.7,keepPause:0.18};
 const opts={settings,includeTranscript:false,removeNonVerbal:false,textConfidence:0.9,transcriptionModelId:'base'};
 const analysis=await call('analyze',{sourceId:source.sourceId,...opts});
 const {analysisFingerprint}=await import('#core/session.js');
 let session={sourceId:source.sourceId,...opts,analysis,analysisSignature:analysisFingerprint(opts),manualOverrides:[],projectResolution:'full-hd',exportFormat:'final-cut'};
 await call('saveSession',session);
 openPath=savePath;
 const loaded=await call('loadSession');assert.equal(loaded.projectResolution,'full-hd');
 const recovered=await call('recoverSession');assert.equal(recovered.projectResolution,'full-hd');
 savePath=work+'/Экспорт тест.fcpxml';
 await call('exportProject',{...session,automaticRemovals:analysis.automaticRemovals});
 assert.match(await fs.readFile(savePath,'utf8'),/FFVideoFormat1080p30/);
 savePath=work;await assert.rejects(call('exportProject',{...session,automaticRemovals:analysis.automaticRemovals}),/EISDIR/);
 savePath=null;assert.equal(await call('exportProject',{...session,automaticRemovals:analysis.automaticRemovals}),null);
 openPath=null;assert.equal(await call('chooseVideo'),null);
 openPath=work+'/Проект тест.roughcut';
 await fs.rename(work+'/Видео тест.mov',work+'/Перемещён.mov');
 await assert.rejects(call('loadSession'),/Source media is missing/);
 await fs.rename(work+'/Перемещён.mov',work+'/Видео тест.mov');
 const again=await call('loadSession');assert.equal(again.projectResolution,'full-hd');
 console.log('PASS real Electron IPC: cancel preview, create/analyse, save/reopen/recovery, Full HD export, failed export recovery, dialog cancellation, missing/restored media, Cyrillic/spaces');
 app.exit(0);
} catch(e) { console.error(e); app.exit(1); }
})();
setTimeout(()=>{console.error('smoke timeout');app.exit(2)},60000);
