// Test-only external observer. Never opens a Job/mutex or terminates a process.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
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
  class Member { public int pid; public long ticks; public string role, root, image; }
  class Root : Member { }
  static readonly Dictionary<string,Member> known=new Dictionary<string,Member>();
  static readonly JavaScriptSerializer json=new JavaScriptSerializer();
  static string Key(int pid,long ticks) { return pid+":"+ticks; }
  static string Identity(Process process) { return Key(process.Id,process.StartTime.ToUniversalTime().Ticks); }
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
    if(parentRole=="renderer" && name=="task-host.local.exe") return "task-guard";
    if(name=="ffmpeg.exe") return "ffmpeg";
    if(name=="ffprobe.exe") return "ffprobe";
    if(parentRole=="task-guard" && name=="eagle.exe") return "task-worker";
    return "owned-unclassified";
  }
  static object Sample(List<Root> roots,double elapsed) {
    var sampling=Stopwatch.StartNew();
    var parents=Parents(); var members=new Dictionary<int,Member>();
    var errors=new List<object>(); var statuses=new List<object>();
    foreach(var root in roots) {
      bool alive=false;
      try {
        using(var process=Process.GetProcessById(root.pid)) {
          if(Identity(process)==Key(root.pid,root.ticks)) {
            if(!String.Equals(process.MainModule.FileName,root.image,StringComparison.OrdinalIgnoreCase)) throw new IOException("Root image changed.");
            alive=true; members.Add(root.pid,root); known[Key(root.pid,root.ticks)]=root;
          }
        }
      } catch(ArgumentException) { } catch(InvalidOperationException) { }
      catch(Exception e) { errors.Add(new {pid=root.pid,reason=e.GetType().Name}); }
      statuses.Add(new {pid=root.pid,startTicks=root.ticks.ToString(),role=root.role,alive=alive});
    }
    // Retain already verified descendants after parent exit, until their exact
    // creation identity disappears. PID reuse can never inherit membership.
    foreach(var pair in new List<KeyValuePair<string,Member>>(known)) {
      var member=pair.Value;
      if(members.ContainsKey(member.pid)) continue;
      try { using(var process=Process.GetProcessById(member.pid)) {
        if(Identity(process)==pair.Key) members.Add(member.pid,member); else known.Remove(pair.Key);
      } } catch(ArgumentException) { known.Remove(pair.Key); } catch(InvalidOperationException) { known.Remove(pair.Key); }
      catch(Exception e) { errors.Add(new {pid=member.pid,reason=e.GetType().Name}); }
    }
    bool changed=true; int iterations=0;
    while(changed && ++iterations<=32) {
      changed=false;
      foreach(var pair in parents) {
        if(members.ContainsKey(pair.Key) || !members.ContainsKey(pair.Value)) continue;
        var parent=members[pair.Value];
        try { using(var process=Process.GetProcessById(pair.Key)) {
          long ticks=process.StartTime.ToUniversalTime().Ticks;
          if(ticks<parent.ticks) continue;
          string image=process.MainModule.FileName;
          var child=new Member {pid=pair.Key,ticks=ticks,image=image,role=Role(image,parent.role),root=parent.root};
          members.Add(child.pid,child); known[Key(child.pid,child.ticks)]=child; changed=true;
        } } catch(ArgumentException) { } catch(InvalidOperationException) { }
        catch(Exception e) { errors.Add(new {pid=pair.Key,reason=e.GetType().Name}); }
      }
    }
    if(changed || members.Count>64 || errors.Count>64) throw new IOException("Owned process observation exceeds boundary.");
    var rows=new List<object>();
    foreach(var member in members.Values) {
      try { using(var process=Process.GetProcessById(member.pid)) {
        if(Identity(process)!=Key(member.pid,member.ticks)) continue;
        rows.Add(new {pid=member.pid,startTicks=member.ticks.ToString(),role=member.role,root=member.root,
          image=Path.GetFileName(member.image),rssBytes=process.WorkingSet64,cpuMs=process.TotalProcessorTime.TotalMilliseconds});
      } } catch(ArgumentException) { } catch(InvalidOperationException) { }
      catch(Exception e) { errors.Add(new {pid=member.pid,reason=e.GetType().Name}); }
    }
    return new {schema="mvp-process-sample-v1",atMs=elapsed,sampleDurationMs=sampling.Elapsed.TotalMilliseconds,processes=rows,roots=statuses,errors=errors};
  }
  static int Main(string[] args) {
    try {
      Console.OutputEncoding=new System.Text.UTF8Encoding(false);
      if(args.Length<6 || (args.Length-2)%4!=0 || args.Length>34) throw new IOException("Expected interval duration and explicit pid/startTicks/role/image roots.");
      int interval=Int32.Parse(args[0]), duration=Int32.Parse(args[1]);
      if(interval!=100 || duration<500 || duration>3900000) throw new IOException("Observation interval/duration outside protocol.");
      var roots=new List<Root>(); var ids=new HashSet<int>();
      for(int i=2;i<args.Length;i+=4) {
        int pid=Int32.Parse(args[i]); string role=args[i+2],image=args[i+3]; long ticks;
        if(args[i+1]=="parent") {
          using(var self=Process.GetCurrentProcess()) using(var parent=Process.GetProcessById(pid)) {
            var parents=Parents();
            if(!parents.ContainsKey(self.Id) || parents[self.Id]!=pid || parent.StartTime.ToUniversalTime().Ticks>self.StartTime.ToUniversalTime().Ticks ||
                !String.Equals(parent.MainModule.FileName,image,StringComparison.OrdinalIgnoreCase)) throw new IOException("Observer parent identity mismatch.");
            ticks=parent.StartTime.ToUniversalTime().Ticks;
          }
        } else ticks=Int64.Parse(args[i+1]);
        if(pid<=0 || ticks<=0 || !ids.Add(pid) || !Path.IsPathRooted(image) ||
          !(role=="renderer" || role=="task-guard" || role=="observer")) throw new IOException("Invalid explicit root identity.");
        roots.Add(new Root {pid=pid,ticks=ticks,role=role,root=Key(pid,ticks),image=image});
      }
      // Self resources are separate observation overhead, never plugin RSS.
      using(var self=Process.GetCurrentProcess()) roots.Add(new Root {pid=self.Id,ticks=self.StartTime.ToUniversalTime().Ticks,
        image=self.MainModule.FileName,role="observer",root=Identity(self)});
      var input=new Thread(delegate() { try { while(Console.ReadLine()!=null) {} } catch(IOException) {} finally { stopping=true; } });
      input.IsBackground=true; input.Start();
      var clock=Stopwatch.StartNew(); long outputBytes=0; int count=0;
      while(!stopping && clock.ElapsedMilliseconds<=duration) {
        string line=json.Serialize(Sample(roots,clock.Elapsed.TotalMilliseconds));
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
