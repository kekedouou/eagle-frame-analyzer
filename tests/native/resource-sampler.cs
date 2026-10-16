// Test-only external observer. Never opens a Job/mutex or terminates a process.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

class ResourceSampler {
  static volatile bool stopping=false;
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct Entry {
    public uint size, usage, pid;
    public UIntPtr heap;
    public uint module, threads, parent;
    public int priority;
    public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string exe;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr handle, uint flags, StringBuilder name, ref int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [StructLayout(LayoutKind.Sequential)]
  struct MemoryCounters {
    public uint size, pageFaultCount;
    public UIntPtr peakWorkingSet, workingSet, peakPagedPool, pagedPool, peakNonPagedPool, nonPagedPool, pagefile, peakPagefile;
  }
  [DllImport("psapi.dll", SetLastError=true)] static extern bool GetProcessMemoryInfo(IntPtr handle, ref MemoryCounters counters, uint size);
  class Member { public int pid; public long ticks; public string role, root, image; }
  class Root : Member { }
  static readonly Dictionary<string,Member> known=new Dictionary<string,Member>();
  static readonly JavaScriptSerializer json=new JavaScriptSerializer();
  static readonly Dictionary<string,int> compactIds=new Dictionary<string,int>();
  static int CompactId(Member member,List<object> additions) {
    string key=Key(member.pid,member.ticks); int id;
    if(!compactIds.TryGetValue(key,out id)) {
      id=compactIds.Count; if(id>=1024) throw new IOException("Compact process catalogue exceeds boundary.");
      compactIds.Add(key,id);
      additions.Add(new object[] {id,member.pid,member.ticks.ToString(),member.role,member.root,Path.GetFileName(member.image),member.image});
    }
    return id;
  }
  static string Key(int pid,long ticks) { return pid+":"+ticks; }
  static string Identity(Process process) { return Key(process.Id,process.StartTime.ToUniversalTime().Ticks); }
  // Keep the identity and exit check bound to the same kernel process object.
  // Never turn access-denied alone into evidence of a normal exit.
  static Exception QueryFailure(int code,string message,IntPtr handle,long expected) {
    string state="unavailable"; int? checkError=null;
    if(handle!=IntPtr.Zero) {
      // A failed image query can overlap the last few milliseconds of teardown.
      // This bounded wait confirms exit; it never retries/ignores a live denial.
      uint result=WaitForSingleObject(handle,10);
      if(result==0) return new InvalidOperationException("Exact process exited during observation.");
      if(result==258) state="alive";
      else if(result==0xffffffff) checkError=Marshal.GetLastWin32Error();
    }
    var failure=new Win32Exception(code,message);
    failure.Data["exitCheck"]=state; failure.Data["startTicks"]=expected.ToString();
    failure.Data["exitCheckErrorCode"]=checkError;
    return failure;
  }
  static void Active(IntPtr handle,long expected) {
    uint result=WaitForSingleObject(handle,0);
    if(result==0) throw new InvalidOperationException("Exact process already exited.");
    if(result!=258) throw QueryFailure(Marshal.GetLastWin32Error(),"Process exit query failed.",handle,expected);
  }
  static Exception OpenFailure(Process process,int code,string message,long expected) {
    // No native handle was acquired. Recheck presence/creation before claiming
    // exit; a still-live or unqueryable identity keeps the original failure.
    var failure=QueryFailure(code,message,IntPtr.Zero,expected);
    try { using(var current=Process.GetProcessById(process.Id)) {
      if(current.StartTime.ToUniversalTime().Ticks!=expected) return new InvalidOperationException("Exact process identity replaced.");
      if(current.HasExited) return new InvalidOperationException("Exact process exited before opening query handle.");
      failure.Data["exitCheck"]="alive";
    } } catch(ArgumentException) { return new InvalidOperationException("Exact process disappeared before opening query handle."); }
    catch(InvalidOperationException) { return new InvalidOperationException("Exact process exited before opening query handle."); }
    catch(Exception e) { var native=e as Win32Exception; failure.Data["exitCheckErrorCode"]=native==null ? (int?)null : native.NativeErrorCode; }
    return failure;
  }
  // MainModule can be null before the child's loader has initialized. Query the
  // kernel's executable identity instead, with only limited-query permission.
  static string Image(Process process) {
    long expected=process.StartTime.ToUniversalTime().Ticks;
    var handle=OpenProcess(0x101000,false,process.Id);
    if(handle==IntPtr.Zero) throw OpenFailure(process,Marshal.GetLastWin32Error(),"OpenProcess query/synchronize failed.",expected);
    try {
      Active(handle,expected);
      long creation,exit,kernel,user;
      if(!GetProcessTimes(handle,out creation,out exit,out kernel,out user)) throw QueryFailure(Marshal.GetLastWin32Error(),"Process identity query failed.",handle,expected);
      if(DateTime.FromFileTimeUtc(creation).Ticks!=expected) throw new InvalidOperationException("Process identity disappeared or changed.");
      var name=new StringBuilder(32768); int size=name.Capacity;
      if(!QueryFullProcessImageNameW(handle,0,name,ref size)) throw QueryFailure(Marshal.GetLastWin32Error(),"Process image query failed.",handle,expected);
      if(size<1) throw new IOException("Process image query returned an empty name.");
      return name.ToString();
    } finally { CloseHandle(handle); }
  }
  static object Error(int pid,Exception error,string operation,int? parentPid=null,string startTicks=null) {
    var native=error as Win32Exception;
    return new {pid=pid,reason=error.GetType().Name,operation=operation,message=error.Message,
      nativeErrorCode=native==null ? (int?)null : native.NativeErrorCode,parentPid=parentPid,
      startTicks=error.Data["startTicks"] ?? startTicks,exitCheck=error.Data["exitCheck"] ?? "unavailable",
      exitCheckErrorCode=error.Data["exitCheckErrorCode"]};
  }
  static Dictionary<int,int> Parents() {
    var result=new Dictionary<int,int>(); var handle=CreateToolhelp32Snapshot(2,0);
    if(handle==new IntPtr(-1)) throw new IOException("Process topology snapshot failed.");
    try {
      var entry=new Entry(); entry.size=(uint)Marshal.SizeOf(typeof(Entry));
      if(!Process32FirstW(handle,ref entry)) throw new IOException("Process topology snapshot empty.");
      do { if(result.ContainsKey((int)entry.pid)) throw new IOException("Duplicate process ID."); result.Add((int)entry.pid,(int)entry.parent); }
      while(Process32NextW(handle,ref entry));
      if(Marshal.GetLastWin32Error()!=18) throw new IOException("Process topology snapshot incomplete.");
    } finally { CloseHandle(handle); }
    return result;
  }
  static string Role(string image,string parentRole) {
    string name=Path.GetFileName(image).ToLowerInvariant();
    if(parentRole=="observer" || parentRole=="observer-child") return "observer-child";
    if(name=="conhost.exe" && String.Equals(image,Path.Combine(Environment.SystemDirectory,"conhost.exe"),StringComparison.OrdinalIgnoreCase)) return "console-host";
    string windows=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
    if(name=="powershell.exe" && (parentRole=="renderer" || parentRole=="task-worker") &&
       (String.Equals(image,Path.GetFullPath(Path.Combine(Environment.SystemDirectory,"WindowsPowerShell/v1.0/powershell.exe")),StringComparison.OrdinalIgnoreCase) ||
        String.Equals(image,Path.GetFullPath(Path.Combine(windows,"SysWOW64/WindowsPowerShell/v1.0/powershell.exe")),StringComparison.OrdinalIgnoreCase))) return "system-helper";
    if(parentRole=="system-helper" && (name=="csc.exe" || name=="cvtres.exe") &&
       (String.Equals(image,Path.GetFullPath(Path.Combine(windows,"Microsoft.NET/Framework64/v4.0.30319",name)),StringComparison.OrdinalIgnoreCase) ||
        String.Equals(image,Path.GetFullPath(Path.Combine(windows,"Microsoft.NET/Framework/v4.0.30319",name)),StringComparison.OrdinalIgnoreCase))) return "system-helper";
    if(parentRole=="renderer" && name=="task-host.local.exe") return "task-guard";
    if(name=="ffmpeg.exe") return "ffmpeg";
    if(name=="ffprobe.exe") return "ffprobe";
    if(parentRole=="task-guard" && name=="eagle.exe") return "task-worker";
    return "owned-unclassified";
  }
  static object Sample(List<Root> roots,double elapsed,bool compact) {
    var sampling=Stopwatch.StartNew();
    var parents=Parents(); var members=new Dictionary<int,Member>();
    var errors=new List<object>(); var statuses=new List<object>(); var additions=new List<object>();
    foreach(var root in roots) {
      bool alive=false;
      try {
        using(var process=Process.GetProcessById(root.pid)) {
          if(Identity(process)==Key(root.pid,root.ticks)) {
            if(!String.Equals(Image(process),root.image,StringComparison.OrdinalIgnoreCase)) throw new IOException("Root image changed.");
            alive=true; members.Add(root.pid,root); known[Key(root.pid,root.ticks)]=root;
          }
        }
      } catch(ArgumentException) { } catch(InvalidOperationException) { }
      catch(Exception e) { errors.Add(Error(root.pid,e,"root-identity",null,root.ticks.ToString())); }
      if(compact) statuses.Add(new object[] {CompactId(root,additions),alive});
      else statuses.Add(new {pid=root.pid,startTicks=root.ticks.ToString(),role=root.role,alive=alive});
    }
    // Retain already verified descendants after parent exit, until their exact
    // creation identity disappears. PID reuse can never inherit membership.
    foreach(var pair in new List<KeyValuePair<string,Member>>(known)) {
      var member=pair.Value;
      if(members.ContainsKey(member.pid)) continue;
      try { using(var process=Process.GetProcessById(member.pid)) {
        if(Identity(process)==pair.Key) members.Add(member.pid,member); else known.Remove(pair.Key);
      } } catch(ArgumentException) { known.Remove(pair.Key); } catch(InvalidOperationException) { known.Remove(pair.Key); }
      catch(Exception e) { errors.Add(Error(member.pid,e,"retained-identity",null,member.ticks.ToString())); }
    }
    bool changed=true; int iterations=0;
    while(changed && ++iterations<=32) {
      changed=false;
      foreach(var pair in parents) {
        if(members.ContainsKey(pair.Key) || !members.ContainsKey(pair.Value)) continue;
        var parent=members[pair.Value];
        long? childTicks=null;
        try { using(var process=Process.GetProcessById(pair.Key)) {
          long ticks=process.StartTime.ToUniversalTime().Ticks;
          childTicks=ticks;
          if(ticks<parent.ticks) continue;
          string image=Image(process);
          var child=new Member {pid=pair.Key,ticks=ticks,image=image,role=Role(image,parent.role),root=parent.root};
          members.Add(child.pid,child); known[Key(child.pid,child.ticks)]=child; changed=true;
        } } catch(ArgumentException) { } catch(InvalidOperationException) { }
        catch(Exception e) { errors.Add(Error(pair.Key,e,"child-image",pair.Value,childTicks.HasValue ? childTicks.Value.ToString() : null)); }
      }
    }
    if(changed || members.Count>64 || errors.Count>64) throw new IOException("Owned process observation exceeds boundary.");
    var rows=new List<object>();
    foreach(var member in members.Values) {
      try { using(var process=Process.GetProcessById(member.pid)) {
        if(Identity(process)!=Key(member.pid,member.ticks)) continue;
        var handle=OpenProcess(0x101000,false,member.pid);
        if(handle==IntPtr.Zero) {
          int code=Marshal.GetLastWin32Error();
          throw OpenFailure(process,code,"Resource process query failed.",member.ticks);
        }
        try {
          Active(handle,member.ticks);
          long creation,exit,kernel,user;
          if(!GetProcessTimes(handle,out creation,out exit,out kernel,out user)) throw QueryFailure(Marshal.GetLastWin32Error(),"Resource time query failed.",handle,member.ticks);
          if(DateTime.FromFileTimeUtc(creation).Ticks!=member.ticks) continue;
          var memory=new MemoryCounters(); memory.size=(uint)Marshal.SizeOf(typeof(MemoryCounters));
          if(!GetProcessMemoryInfo(handle,ref memory,memory.size)) {
            int code=Marshal.GetLastWin32Error();
            throw QueryFailure(code,"Resource memory query failed.",handle,member.ticks);
          }
          if(compact) rows.Add(new object[] {CompactId(member,additions),memory.workingSet.ToUInt64(),(kernel+user)/10000.0});
          else rows.Add(new {pid=member.pid,startTicks=member.ticks.ToString(),role=member.role,root=member.root,
            image=Path.GetFileName(member.image),imagePath=member.image,rssBytes=memory.workingSet.ToUInt64(),cpuMs=(kernel+user)/10000.0});
        } finally { CloseHandle(handle); }
      } } catch(ArgumentException) { } catch(InvalidOperationException) { }
      catch(Exception e) { errors.Add(Error(member.pid,e,"resource-counters",null,member.ticks.ToString())); }
    }
    if(compact) return new {schema="mvp-process-compact-v1",atMs=elapsed,sampleDurationMs=sampling.Elapsed.TotalMilliseconds,
      additions=additions,processes=rows,roots=statuses,errors=errors};
    return new {schema="mvp-process-sample-v1",atMs=elapsed,sampleDurationMs=sampling.Elapsed.TotalMilliseconds,processes=rows,roots=statuses,errors=errors};
  }
  static int Main(string[] args) {
    try {
      Console.OutputEncoding=new System.Text.UTF8Encoding(false);
      bool compact=args.Length>2 && args[2]=="compact"; int firstRoot=compact ? 3 : 2;
      if(args.Length<firstRoot+4 || (args.Length-firstRoot)%4!=0 || args.Length>firstRoot+32) throw new IOException("Expected interval duration and explicit pid/startTicks/role/image roots.");
      int interval=Int32.Parse(args[0]), duration=Int32.Parse(args[1]);
      if(interval!=100 || duration<500 || duration>(compact ? 3960000 : 3900000)) throw new IOException("Observation interval/duration outside protocol.");
      var roots=new List<Root>(); var ids=new HashSet<int>();
      for(int i=firstRoot;i<args.Length;i+=4) {
        int pid=Int32.Parse(args[i]); string role=args[i+2],image=args[i+3]; long ticks;
        if(args[i+1]=="parent") {
          using(var self=Process.GetCurrentProcess()) using(var parent=Process.GetProcessById(pid)) {
            var parents=Parents();
            if(!parents.ContainsKey(self.Id) || parents[self.Id]!=pid || parent.StartTime.ToUniversalTime().Ticks>self.StartTime.ToUniversalTime().Ticks ||
                !String.Equals(Image(parent),image,StringComparison.OrdinalIgnoreCase)) throw new IOException("Observer parent identity mismatch.");
            ticks=parent.StartTime.ToUniversalTime().Ticks;
          }
        } else ticks=Int64.Parse(args[i+1]);
        if(pid<=0 || ticks<=0 || !ids.Add(pid) || !Path.IsPathRooted(image) ||
          !(role=="renderer" || role=="task-guard" || role=="observer")) throw new IOException("Invalid explicit root identity.");
        roots.Add(new Root {pid=pid,ticks=ticks,role=role,root=Key(pid,ticks),image=image});
      }
      // Self resources are separate observation overhead, never plugin RSS.
      using(var self=Process.GetCurrentProcess()) roots.Add(new Root {pid=self.Id,ticks=self.StartTime.ToUniversalTime().Ticks,
        image=Image(self),role="observer",root=Identity(self)});
      var input=new Thread(delegate() { try { while(Console.ReadLine()!=null) {} } catch(IOException) {} finally { stopping=true; } });
      input.IsBackground=true; input.Start();
      var clock=Stopwatch.StartNew(); long outputBytes=0; int count=0;
      while(!stopping && clock.ElapsedMilliseconds<=duration) {
        string line=json.Serialize(Sample(roots,clock.Elapsed.TotalMilliseconds,compact));
        outputBytes+=System.Text.Encoding.UTF8.GetByteCount(line)+1;
        if(line.Length>32768 || outputBytes>64*1024*1024) throw new IOException("Observation pipe capacity exceeded; incomplete run.");
        Console.WriteLine(line); count++;
        int wait=(int)Math.Max(1,count*(long)interval-clock.ElapsedMilliseconds);
        Thread.Sleep(wait);
      }
      return 0;
    } catch(Exception e) { Console.Error.WriteLine("Resource observer: "+e.Message); return 1; }
  }
}
