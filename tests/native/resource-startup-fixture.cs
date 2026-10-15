// Isolated test fixture: keep one owned Node-mode Eagle child suspended until
// the observer has sampled it. Never controls an existing Eagle GUI process.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
class StartupFixture {
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {
    public uint cb; public string reserved,desktop,title;
    public uint x,y,xSize,ySize,xChars,yChars,fill,flags;
    public ushort show,reservedSize; public IntPtr reservedPointer,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct Child { public IntPtr process,thread; public uint pid,tid; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string application,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string directory,ref Startup startup,out Child child);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static int Main(string[] args) {
    Child child=new Child(); bool created=false,resumed=false;
    try {
      if(args.Length!=1 || !Path.IsPathRooted(args[0]) || Environment.GetEnvironmentVariable("ELECTRON_RUN_AS_NODE")!="1") throw new IOException("Explicit owned Node runtime required.");
      var startup=new Startup(); startup.cb=(uint)Marshal.SizeOf(typeof(Startup));
      if(!CreateProcessW(args[0],new StringBuilder("\""+args[0]+"\" -e \"setTimeout(function(){},250)\""),IntPtr.Zero,IntPtr.Zero,false,0x08000004,IntPtr.Zero,null,ref startup,out child)) throw new IOException("Owned suspended child creation failed: "+Marshal.GetLastWin32Error());
      created=true; bool oldNull=false; string oldError=null;
      using(var process=Process.GetProcessById((int)child.pid)) { try { oldNull=process.MainModule==null; } catch(Exception error) { oldError=error.GetType().Name; } }
      using(var self=Process.GetCurrentProcess()) Console.WriteLine(new JavaScriptSerializer().Serialize(new {pid=self.Id,startTicks=self.StartTime.ToUniversalTime().Ticks.ToString(),image=self.MainModule.FileName,role="task-guard",childPid=(int)child.pid,oldMainModuleNull=oldNull,oldError=oldError}));
      if(Console.ReadLine()!="resume") throw new IOException("Expected owned resume request.");
      if(ResumeThread(child.thread)==UInt32.MaxValue) throw new IOException("Owned child resume failed.");
      resumed=true; Console.ReadLine(); // Stay alive through the observer's last sample.
      if(WaitForSingleObject(child.process,5000)!=0) throw new IOException("Owned Node child did not exit within its deadline.");
      return 0;
    } catch(Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    finally {
      if(created) {
        if(!resumed) ResumeThread(child.thread);
        if(WaitForSingleObject(child.process,5000)!=0) TerminateProcess(child.process,1);
        CloseHandle(child.thread); CloseHandle(child.process);
      }
    }
  }
}
