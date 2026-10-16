// Test-only reflection checks against the actual built observer. Own children only.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Reflection;
using System.Web.Script.Serialization;
class ExitFixture {
  static MethodInfo image,failure,error,active,openFailure;
  static object Call(MethodInfo method,params object[] args) {
    try { return method.Invoke(null,args); }
    catch(TargetInvocationException e) { throw e.InnerException; }
  }
  static void Require(bool value,string text) { if(!value) throw new Exception(text); }
  static int Main(string[] args) {
    try {
      Require(args.Length==2,"Expected observer and existing Node paths.");
      var type=Assembly.LoadFile(args[0]).GetType("ResourceSampler");
      var flags=BindingFlags.NonPublic|BindingFlags.Static;
      image=type.GetMethod("Image",flags); failure=type.GetMethod("QueryFailure",flags);
      error=type.GetMethod("Error",flags); active=type.GetMethod("Active",flags);
      openFailure=type.GetMethod("OpenFailure",flags);
      var cases=new List<string>(); int exited=0;
      using(var self=Process.GetCurrentProcess()) {
        Require(String.Equals((string)Call(image,self),self.MainModule.FileName,StringComparison.OrdinalIgnoreCase),"Live fixture image mismatch.");
        cases.Add("live-process-image-readable");
        long ticks=self.StartTime.ToUniversalTime().Ticks;
        // Inject a native denial while the real identity-bound handle is alive.
        var denied=Call(failure,5,"injected image denial",self.Handle,ticks) as Win32Exception;
        Require(denied!=null && denied.NativeErrorCode==5 && (string)denied.Data["exitCheck"]=="alive","Live access denial must remain fatal.");
        var packed=new JavaScriptSerializer().Serialize(Call(error,self.Id,denied,"child-image",self.Id,ticks.ToString()));
        Require(packed.Contains("\"parentPid\":"+self.Id) && packed.Contains("\"exitCheck\":\"alive\"") && packed.Contains(ticks.ToString()),"Error context lost.");
        cases.Add("injected-live-denial-keeps-native-code-parent-and-exact-identity");
        var unknown=Call(failure,5,"injected unavailable handle",IntPtr.Zero,ticks) as Win32Exception;
        Require(unknown!=null && (string)unknown.Data["exitCheck"]=="unavailable","Unknown exit state must remain fatal.");
        cases.Add("unavailable-exit-check-remains-fatal");
        var openDenied=Call(openFailure,self,5,"injected open denial",ticks) as Win32Exception;
        Require(openDenied!=null && openDenied.NativeErrorCode==5 && (string)openDenied.Data["exitCheck"]=="alive","Live open denial must remain fatal.");
        Require(Call(openFailure,self,87,"injected different creation identity",ticks+1) is InvalidOperationException,"Different identity cannot inherit ownership.");
        cases.Add("injected-open-denial-and-different-creation-identity-classified-separately");
      }
      for(int i=0;i<16;i++) {
        var start=new ProcessStartInfo(args[1],"-e \"setTimeout(function(){},80)\"");
        start.UseShellExecute=false; start.CreateNoWindow=true;
        using(var child=Process.Start(start)) {
          var held=child.Handle; long ticks=child.StartTime.ToUniversalTime().Ticks;
          Require(!String.IsNullOrEmpty((string)Call(image,child)),"Live owned child not readable.");
          Require(child.WaitForExit(5000) && child.ExitCode==0,"Owned child failed to exit normally.");
          try { Call(image,child); throw new Exception("Exited image query incorrectly succeeded."); }
          catch(InvalidOperationException) { exited++; }
          Require(Call(failure,5,"injected overlapping exit",held,ticks) is InvalidOperationException,"Confirmed exited handle must resolve original native denial.");
          Require(Call(failure,31,"injected overlapping exit",held,ticks) is InvalidOperationException,"Confirmed exit must not depend on native code.");
          Require(Call(openFailure,child,87,"injected open after exit",ticks) is InvalidOperationException,"Confirmed exit before open must not fail observation.");
          try { Call(active,held,ticks); throw new Exception("Exited active check incorrectly succeeded."); }
          catch(InvalidOperationException) { }
        }
      }
      cases.Add("sixteen-normal-exits-and-native-denials-confirmed-on-same-held-handle");
      Console.WriteLine(new JavaScriptSerializer().Serialize(new {schema="mvp-windows-exit-query-check-v1",passed=true,cases=cases,
        exitedChildren=exited,liveDenialInjected=true,actualProtectedProcessAccessAttempted=false,
        limitation="Real normal exits and unchanged query functions; access-denied branch is injected, not a claim about the original PID21612 or real Eagle stability."}));
      return 0;
    } catch(Exception e) { Console.Error.WriteLine(e.ToString()); return 1; }
  }
}
