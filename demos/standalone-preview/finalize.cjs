'use strict';
// Fixed output and owner verification precede cleanup. No arbitrary path or force/reset parameter.
const fs=require('fs'),path=require('path'),assert=require('assert'),{execFileSync}=require('child_process');
const {out,digest}=require('./assemble.cjs');
const zip=out+'.zip',data=path.join(out,'verification-data');
const equal=(a,b)=>a.toLowerCase()===b.toLowerCase();
function walk(dir,root=dir,files=[]){
 assert(equal(fs.realpathSync(dir),path.resolve(dir)));const s=fs.lstatSync(dir);assert(s.isDirectory()&&!s.isSymbolicLink());
 for(const n of fs.readdirSync(dir)){const p=path.join(dir,n),v=fs.lstatSync(p);assert(!v.isSymbolicLink());if(v.isDirectory())walk(p,root,files);else{assert(v.isFile()&&v.nlink===1&&equal(fs.realpathSync(p),p));files.push({path:path.relative(root,p).replace(/\\/g,'/'),bytes:v.size,sha256:digest(fs.readFileSync(p))});}}
 return files;
}
function main(){
 assert(!fs.existsSync(zip),'Existing final ZIP is preserved.');assert(equal(fs.realpathSync(out),out));
 const processes=execFileSync('powershell.exe',['-NoProfile','-Command',"Get-CimInstance Win32_Process -Filter \"Name='VideoAnalysisPreview.exe' OR Name='ffmpeg.exe' OR Name='ffprobe.exe'\" | Select-Object -ExpandProperty ExecutablePath"],{encoding:'utf8'});
 assert(!processes.toLowerCase().includes(out.toLowerCase()),'Own runtime still active; cleanup refused.');
 assert(fs.existsSync(data));assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(data,'preview-owner.json'))),{owner:'eva-standalone-preview-data-v1',schema:1});
 const removed=walk(data);assert(removed.reduce((a,b)=>a+b.bytes,0)<=576*1024**2);
 // Only this verified, fixed-path, demonstration-owned test directory is removed.
 fs.rmSync(data,{recursive:true});
 const files=walk(out);assert(files.every(f=>!/(^|\/)(?:data|verification-data|evidence|work|tests|prototypes)(?:\/|$)/i.test(f.path)));assert(files.every(f=>!(/\.(?:mp4|wav|jpg|jpeg)$/i.test(f.path))));
 assert(files.reduce((a,b)=>a+b.bytes,0)<=768*1024**2);
 fs.writeFileSync(path.join(out,'INTEGRITY.json'),JSON.stringify({schema:1,files},null,2),{flag:'wx'});
 const q=s=>"'"+s.replace(/'/g,"''")+"'";
 execFileSync('powershell.exe',['-NoProfile','-Command','Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('+q(out)+','+q(zip)+',[IO.Compression.CompressionLevel]::Optimal,$true)'],{stdio:'inherit'});
 assert(fs.statSync(zip).size<=384*1024**2);
 const receipt={status:'packaged',zip:path.basename(zip),zipBytes:fs.statSync(zip).size,sha256:digest(fs.readFileSync(zip)),files:files.length+1,unpackedBytes:files.reduce((a,b)=>a+b.bytes,0)+fs.statSync(path.join(out,'INTEGRITY.json')).size,verificationDataCleaned:{path:path.basename(data),files:removed.length,bytes:removed.reduce((a,b)=>a+b.bytes,0),ownerVerified:true,ownProcessesAbsent:true},exclusions:'No user video/cache/settings/evidence/Eagle files or visible test controls in package.',at:new Date().toISOString()};
 fs.writeFileSync(path.join(__dirname,'evidence/package-receipt.json'),JSON.stringify(receipt,null,2),{flag:'wx'});console.log(JSON.stringify(receipt,null,2));
}
main();
