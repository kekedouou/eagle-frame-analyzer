'use strict';
const {app,BrowserWindow,ipcMain,dialog}=require('electron');
const fs=require('fs'),path=require('path');
const portable=path.dirname(process.execPath),smoke=process.env.EVA_STANDALONE_VERIFY==='1';
const data=path.join(portable,smoke?'verification-data':'data');let win=null,initial=[];
function ordinary(dir){const s=fs.lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink()||fs.realpathSync(dir).toLowerCase()!==path.resolve(dir).toLowerCase())throw new Error('程序目录不能经过链接或重定向。');}
function directory(dir){if(!fs.existsSync(dir))fs.mkdirSync(dir);ordinary(dir);}
try{
 ordinary(portable);if(/^c:/i.test(portable))throw new Error('请先将整个软件文件夹解压到D、E等非C盘，再运行程序。');
 directory(data);const owner=path.join(data,'preview-owner.json');
 const value={owner:'eva-standalone-preview-data-v1',schema:1};
 if(fs.existsSync(owner)){
  const s=fs.lstatSync(owner);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>4096||fs.realpathSync(owner).toLowerCase()!==owner.toLowerCase()||JSON.stringify(JSON.parse(fs.readFileSync(owner)))!==JSON.stringify(value))throw new Error('本地数据目录归属不符，已保留原件。');
 }else{if(fs.readdirSync(data).length)throw new Error('数据目录已有未知内容，未覆盖。');fs.writeFileSync(owner,JSON.stringify(value),{flag:'wx'});}
 for(const name of ['browser','logs','crashes'])directory(path.join(data,name));
 app.setPath('userData',path.join(data,'browser'));app.setPath('sessionData',path.join(data,'browser'));
 app.setPath('crashDumps',path.join(data,'crashes'));app.setAppLogsPath(path.join(data,'logs'));
}catch(e){dialog.showErrorBox('视频分析 · 展示版',e.message);app.exit(1);}
const argumentsToPaths=args=>args.filter(s=>typeof s==='string'&&path.isAbsolute(s)&&!s.startsWith('--')).slice(0,128);
initial=argumentsToPaths(process.argv.slice(1));
if(!app.requestSingleInstanceLock())app.quit();
else{
 app.on('second-instance',(_event,argv)=>{if(win){if(win.isMinimized())win.restore();win.show();win.focus();const paths=argumentsToPaths(argv.slice(1));if(paths.length)win.webContents.send('preview:paths',paths);}});
 app.whenReady().then(()=>{
  win=new BrowserWindow({width:1120,height:760,minWidth:780,minHeight:500,show:true,title:'视频分析 · 独立展示版',icon:path.join(__dirname,'core','logo.png'),backgroundColor:'#202020',
   webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:false,backgroundThrottling:false,webSecurity:true}});
  win.setMenu(null);win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',event=>event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
  const trusted=event=>win&&event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame;
  ipcMain.handle('preview:initial',event=>{if(!trusted(event))throw new Error('Unknown window.');const paths=initial;initial=[];return {data,smoke,paths};});
  ipcMain.handle('preview:pick',async(event,kind)=>{
   if(!trusted(event)||!['files','folder'].includes(kind))throw new Error('Invalid file selection.');
   const result=await dialog.showOpenDialog(win,kind==='folder'?{properties:['openDirectory']}:{properties:['openFile','multiSelections'],filters:[{name:'MP4 视频',extensions:['mp4']}]});
   return result.canceled?[]:result.filePaths.slice(0,128);
  });
  win.on('closed',()=>{win=null;app.quit();});
  return win.loadFile(path.join(__dirname,'index.html'));
 }).catch(e=>{dialog.showErrorBox('启动失败',e.message);app.quit();});
 app.on('window-all-closed',()=>app.quit());
}
