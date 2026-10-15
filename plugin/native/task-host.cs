// Owns one plugin cache session. No Eagle APIs, media data or library writes.
using System;
using System.IO;
using System.Threading;
using System.Diagnostics;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;

public static class EvaTaskHost {
  const uint KillOnClose = 0x2000;
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long ProcessTime, JobTime; public uint Flags; public UIntPtr Min, Max;
    public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong A,B,C,D,E,F; }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public BasicLimit Basic; public Io Io; public UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long A,B,C,D; public uint Faults,Total,Active,Terminated;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref Limits info,uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,out Accounting info,uint size,IntPtr length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static volatile bool disconnected;
  static volatile bool closingRequested;
  static readonly BlockingCollection<string> input = new BlockingCollection<string>(32);
  static void Emit(string text) { lock(typeof(EvaTaskHost)) { Console.Out.WriteLine(text); Console.Out.Flush(); } }
  static uint Active(IntPtr job) {
    Accounting value;
    if(!QueryInformationJobObject(job,1,out value,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)) throw new IOException("Cannot inspect owned task group.");
    return value.Active;
  }
  static void Configure(IntPtr job,uint flags) {
    Limits info = new Limits(); info.Basic.Flags=flags;
    if(!SetInformationJobObject(job,9,ref info,(uint)Marshal.SizeOf(typeof(Limits)))) throw new IOException("Cannot configure owned task group.");
  }
  static string Quote(string value) { return "\"" + value.Replace("\\", "\\").Replace("\"", "\\\"") + "\""; }
  public static int Main(string[] args) {
    // Detached hidden processes have pipes but no console code page. Setting
    // Console.InputEncoding would call SetConsoleCP and fail with invalid handle.
    Console.SetIn(new StreamReader(Console.OpenStandardInput(),new System.Text.UTF8Encoding(false)));
    var output=new StreamWriter(Console.OpenStandardOutput(),new System.Text.UTF8Encoding(false)); output.AutoFlush=true; Console.SetOut(output);
    var errors=new StreamWriter(Console.OpenStandardError(),new System.Text.UTF8Encoding(false)); errors.AutoFlush=true; Console.SetError(errors);
    if(args.Length!=3 || !Path.IsPathRooted(args[0]) || !Path.IsPathRooted(args[1]) || args[2].Length!=64) return 64;
    foreach(char c in args[2]) if(!Uri.IsHexDigit(c)) return 64;
    string root=Path.GetFullPath(args[0]), runtime=Path.GetFullPath(args[1]), key=args[2], epoch=Guid.NewGuid().ToString("N");
    string worker=Path.Combine(root,"task-worker.cjs");
    if(!File.Exists(runtime)||!File.Exists(worker)) return 66;
    var reader=new Thread(delegate() {
      try { string line; while((line=Console.ReadLine())!=null) {
        if(line=="{\"type\":\"guard\",\"event\":\"closing\"}") { closingRequested=true; continue; }
        if(line.Length>32768 || !input.TryAdd(line,1000)) break;
      }} catch(IOException) {} finally { disconnected=true; input.CompleteAdding(); }
    }); reader.IsBackground=true; reader.Start();
    bool acquired=false; IntPtr job=IntPtr.Zero; Process child=null;
    using(var gate=new Mutex(false,"Local\\EvaCacheGate-"+key)) {
      try {
        try { acquired=gate.WaitOne(0); } catch(AbandonedMutexException) { acquired=true; }
        if(!acquired) Emit("{\"type\":\"guard\",\"event\":\"waiting\"}");
        var waiting=Stopwatch.StartNew();
        while(!acquired && !disconnected) {
          try { acquired=gate.WaitOne(100); } catch(AbandonedMutexException) { acquired=true; }
          if(waiting.ElapsedMilliseconds>30000) throw new IOException("Previous video session did not hand over within 30 seconds.");
        }
        if(!acquired||disconnected) return 0;
        // This group name contains only prior instances of this plugin guard,
        // its Node worker and descendants. Never attach the Eagle host itself.
        job=CreateJobObject(IntPtr.Zero,"Local\\EvaCacheJob-"+key);
        if(job==IntPtr.Zero) throw new IOException("Cannot create owned task group.");
        if(Active(job)>0) {
          if(!TerminateJobObject(job,125)) throw new IOException("Cannot stop interrupted owned task group.");
          var stopped=Stopwatch.StartNew();
          while(Active(job)>0) { if(stopped.ElapsedMilliseconds>10000) throw new IOException("Interrupted owned task group has not exited."); Thread.Sleep(20); }
        }
        Configure(job,KillOnClose);
        // Join before creating ANY child: all subsequent children inherit the
        // group, closing the spawn-before-registration interruption window.
        if(!AssignProcessToJobObject(job,Process.GetCurrentProcess().Handle)) throw new IOException("Cannot join owned task group.");
        var start=new ProcessStartInfo(runtime,Quote(worker));
        start.UseShellExecute=false; start.CreateNoWindow=true;
        start.RedirectStandardInput=true; start.RedirectStandardOutput=true; start.RedirectStandardError=true;
        start.StandardOutputEncoding=new System.Text.UTF8Encoding(false); start.StandardErrorEncoding=new System.Text.UTF8Encoding(false);
        start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"]="1";
        start.EnvironmentVariables.Remove("NODE_OPTIONS");
        start.EnvironmentVariables["EVA_TASK_ROOT"]=root;
        start.EnvironmentVariables["EVA_TASK_KEY"]=key;
        start.EnvironmentVariables["EVA_TASK_EPOCH"]=epoch;
        start.EnvironmentVariables["EVA_TASK_GUARD_PID"]=Process.GetCurrentProcess().Id.ToString();
        child=new Process(); child.StartInfo=start;
        child.OutputDataReceived += delegate(object sender,DataReceivedEventArgs e) { if(e.Data!=null) Emit(e.Data); };
        int stderr=0;
        child.ErrorDataReceived += delegate(object sender,DataReceivedEventArgs e) {
          if(e.Data!=null && Interlocked.Add(ref stderr,e.Data.Length)<=32768) Console.Error.WriteLine(e.Data);
        };
        if(!child.Start()) throw new IOException("Cannot start task worker.");
        child.BeginOutputReadLine(); child.BeginErrorReadLine();
        var writer=new Thread(delegate() {
          try { foreach(var line in input.GetConsumingEnumerable()) {
            var bytes=System.Text.Encoding.UTF8.GetBytes(line+"\n");
            child.StandardInput.BaseStream.Write(bytes,0,bytes.Length); child.StandardInput.BaseStream.Flush();
          } }
          catch(IOException) {} catch(InvalidOperationException) {}
          finally { try { child.StandardInput.Close(); } catch {} }
        }); writer.IsBackground=true; writer.Start();
        Stopwatch closing=null;
        while(!child.WaitForExit(50)) {
          if((disconnected||closingRequested) && closing==null) closing=Stopwatch.StartNew();
          if(closing!=null && closing.ElapsedMilliseconds>15000) {
            // Includes this guard. OS closes the mutex and every owned child.
            TerminateJobObject(job,124); return 124;
          }
        }
        child.WaitForExit(); // Drain redirected output before releasing ownership.
        int exit=child.ExitCode;
        var drain=Stopwatch.StartNew();
        while(Active(job)>1) { if(drain.ElapsedMilliseconds>5000) { TerminateJobObject(job,124); return 124; } Thread.Sleep(20); }
        Configure(job,0); // Only this retiring guard remains, no child can spawn.
        Emit("{\"type\":\"guard\",\"event\":\"finished\",\"exitCode\":"+exit+"}");
        return exit;
      } catch(Exception error) {
        Console.Error.WriteLine("Task guard: "+error.Message);
        if(job!=IntPtr.Zero && Active(job)>1) TerminateJobObject(job,126);
        return 70;
      } finally {
        if(acquired) gate.ReleaseMutex();
        if(job!=IntPtr.Zero) CloseHandle(job);
        if(child!=null) child.Dispose();
      }
    }
  }
}
