using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.IO;

// The root starts suspended: no child can escape before job assignment.
public static class CheckJob {
  [StructLayout(LayoutKind.Sequential)] struct Startup {
    public uint cb; public IntPtr reserved, desktop, title;
    public uint x,y,xSize,ySize,xChars,yChars,fill,flags; public ushort show,reservedSize;
    public IntPtr reservedBytes,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long processTime,jobTime; public uint flags; public UIntPtr minWorking,maxWorking;
    public uint activeLimit; public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits basic; public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes;
    public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated;
  }
  [DllImport("kernel32", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs,string name);
  [DllImport("kernel32", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref ExtendedLimits limits,uint size);
  [DllImport("kernel32", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,out Accounting info,uint size,IntPtr returned);
  [DllImport("kernel32", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder args,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out ProcessInfo process);
  [DllImport("kernel32")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32")] static extern bool TerminateProcess(IntPtr process,uint exit);
  [DllImport("kernel32")] static extern bool TerminateJobObject(IntPtr job,uint exit);
  [DllImport("kernel32")] static extern bool GetExitCodeProcess(IntPtr process,out uint exit);
  [DllImport("kernel32")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32")] static extern bool CloseHandle(IntPtr handle);
  static string Quote(string value) {
    var text=new StringBuilder("\""); int slashes=0;
    foreach(char c in value) {
      if(c=='\\') {slashes++; continue;}
      text.Append('\\', c=='"' ? slashes*2+1 : slashes); slashes=0; text.Append(c);
    }
    return text.Append('\\',slashes*2).Append('"').ToString();
  }
  static int[] ProcessIds(IntPtr job) {
    IntPtr buffer=Marshal.AllocHGlobal(8192);
    try {
      if(!QueryJobProcessIds(job,3,buffer,8192,IntPtr.Zero)) throw new Exception("job-process-list");
      int count=Marshal.ReadInt32(buffer,4);
      if(count<0||count>512) throw new Exception("job-process-count");
      var ids=new int[count];
      for(int i=0;i<count;i++) ids[i]=checked((int)Marshal.ReadIntPtr(buffer,8+i*IntPtr.Size).ToInt64());
      return ids;
    } finally {Marshal.FreeHGlobal(buffer);}
  }
  [DllImport("kernel32",EntryPoint="QueryInformationJobObject",SetLastError=true)]
  static extern bool QueryJobProcessIds(IntPtr job,int type,IntPtr buffer,uint size,IntPtr returned);
  static void Monitor(string file,uint root,int agent,int consoleHost,int children,bool covered,bool alive,bool closed,long sampledAt=0) {
    string json="{\"version\":1,\"hostPid\":"+Process.GetCurrentProcess().Id+",\"rootPid\":"+root+
      ",\"agentPid\":"+agent+",\"consoleHostPid\":"+consoleHost+",\"activeChildren\":"+children+",\"covered\":"+covered.ToString().ToLowerInvariant()+
      ",\"agentAlive\":"+alive.ToString().ToLowerInvariant()+",\"closed\":"+closed.ToString().ToLowerInvariant()+
      ",\"updatedAt\":"+(sampledAt==0?DateTimeOffset.UtcNow.ToUnixTimeMilliseconds():sampledAt)+"}";
    string temporary=file+".pending";
    File.WriteAllText(temporary,json,new UTF8Encoding(false));File.Move(temporary,file,true);
  }
  // Persistent Pi RPC parent stays alive between turns. The trusted Node root
  // is separate from tool descendants; no elapsed-time cancellation.
  public static int RunAgent(string[] args,string cwd,string nodeExecutable,string monitorFile,string execBridgeExecutable=null) {
    IntPtr job=IntPtr.Zero;ProcessInfo p=new ProcessInfo();Process agent=null,consoleHost=null,execBridge=null;bool assigned=false;uint exit=1;
    try {
      job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero) throw new Exception("job-create");
      var limits=new ExtendedLimits();limits.basic.flags=0x2000;
      if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf<ExtendedLimits>())) throw new Exception("job-limit");
      var si=new Startup();si.cb=(uint)Marshal.SizeOf<Startup>();si.flags=0x100;
      si.input=GetStdHandle(-10);si.output=GetStdHandle(-11);si.error=GetStdHandle(-12);
      var command=new StringBuilder();foreach(var arg in args) {if(command.Length>0) command.Append(' ');command.Append(Quote(arg));}
      if(!CreateProcess(args[0],command,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,cwd,ref si,out p)) throw new Exception("process-create");
      if(!AssignProcessToJobObject(job,p.process)) throw new Exception("job-assign");assigned=true;
      if(!String.Equals(args[0],nodeExecutable,StringComparison.OrdinalIgnoreCase)) throw new Exception("agent-root-identity");
      agent=Process.GetProcessById((int)p.pid);
      if(ResumeThread(p.thread)==uint.MaxValue) throw new Exception("process-resume");
      while(true) {
        if(agent.HasExited) break;
        try {
        long sampledAt=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        int[] ids=ProcessIds(job);bool rootAlive=Array.IndexOf(ids,(int)p.pid)>=0;
        // Pi's verified native exec bridge is a persistent RPC transport, not a
        // shell job. Its actual command children remain counted in this Job.
        if(execBridge!=null&&execBridge.HasExited) {execBridge.Dispose();execBridge=null;}
        if(execBridge==null&&!String.IsNullOrEmpty(execBridgeExecutable)) foreach(int id in ids) {
          if(id==(int)p.pid) continue;
          try {
            var candidate=Process.GetProcessById(id);
            if(String.Equals(candidate.MainModule.FileName,execBridgeExecutable,StringComparison.OrdinalIgnoreCase)&&
              candidate.StartTime>=agent.StartTime) {execBridge=candidate;break;}
            candidate.Dispose();
          } catch { }
        }
        if(consoleHost==null) foreach(int id in ids) {
          if(id==(int)p.pid) continue;
          try {
            var candidate=Process.GetProcessById(id);
            string expected=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"conhost.exe");
            if(String.Equals(candidate.MainModule.FileName,expected,StringComparison.OrdinalIgnoreCase)&&
              candidate.StartTime<=agent.StartTime.AddSeconds(5)) {consoleHost=candidate;break;}
            candidate.Dispose();
          } catch { }
        }
        bool alive=agent!=null&&!agent.HasExited;
        int consoleId=consoleHost!=null&&!consoleHost.HasExited?consoleHost.Id:0;
        int bridgeId=execBridge!=null&&!execBridge.HasExited?execBridge.Id:0;
        int children=0;foreach(int id in ids) if(id!=(int)p.pid&&id!=consoleId&&id!=bridgeId) children++;
        Monitor(monitorFile,p.pid,agent==null?0:agent.Id,consoleId,children,agent!=null,alive,false,sampledAt);
        if(!rootAlive||agent!=null&&!alive) break;
        } catch {
          // Losing telemetry must never cancel a healthy coding turn. A failed
          // or stale heartbeat blocks completion until coverage recovers.
          try {Monitor(monitorFile,p.pid,agent.Id,0,0,false,!agent.HasExited,false);} catch { }
        }
        Thread.Sleep(250);
      }
      GetExitCodeProcess(p.process,out exit);
      return exit==259?1:unchecked((int)exit);
    } finally {
      bool quiet=false;
      if(job!=IntPtr.Zero&&assigned) {
        TerminateJobObject(job,1);
        for(int i=0;i<100;i++) {
          Accounting info;
          if(QueryInformationJobObject(job,1,out info,(uint)Marshal.SizeOf<Accounting>(),IntPtr.Zero)&&info.active==0) {quiet=true;break;}
          Thread.Sleep(20);
        }
      }
      try {Monitor(monitorFile,p.pid,agent==null?0:agent.Id,0,0,quiet,false,true);} catch { }
      if(!assigned&&p.process!=IntPtr.Zero) TerminateProcess(p.process,1);
      agent?.Dispose();consoleHost?.Dispose();execBridge?.Dispose();
      if(p.thread!=IntPtr.Zero) CloseHandle(p.thread);if(p.process!=IntPtr.Zero) CloseHandle(p.process);if(job!=IntPtr.Zero) CloseHandle(job);
    }
  }
  public static string Run(string[] args,string cwd,int timeoutMs) {
    IntPtr job=IntPtr.Zero; ProcessInfo p=new ProcessInfo(); bool assigned=false;
    bool quiescent=false,timedOut=false; uint exit=1,rootExitBeforeCleanup=259,activeAtTimeout=0;
    try {
      job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw new Exception("job-create");
      var limits=new ExtendedLimits(); limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE, no breakaway.
      if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf<ExtendedLimits>())) throw new Exception("job-limit");
      var si=new Startup(); si.cb=(uint)Marshal.SizeOf<Startup>(); si.flags=0x100;
      si.input=GetStdHandle(-10); si.output=GetStdHandle(-11); si.error=GetStdHandle(-12);
      var command=new StringBuilder(); foreach(var arg in args) {if(command.Length>0)command.Append(' ');command.Append(Quote(arg));}
      if(!CreateProcess(args[0],command,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,cwd,ref si,out p)) throw new Exception("process-create");
      if(!AssignProcessToJobObject(job,p.process)) throw new Exception("job-assign"); assigned=true;
      if(ResumeThread(p.thread)==uint.MaxValue) throw new Exception("process-resume");
      var clock=Stopwatch.StartNew();
      while(true) {
        Accounting info; if(!QueryInformationJobObject(job,1,out info,(uint)Marshal.SizeOf<Accounting>(),IntPtr.Zero)) throw new Exception("job-query");
        if(info.active==0) {quiescent=true;break;}
        if(clock.ElapsedMilliseconds>=timeoutMs) {
          timedOut=true;activeAtTimeout=info.active;GetExitCodeProcess(p.process,out rootExitBeforeCleanup);break;
        }
        Thread.Sleep(20);
      }
      if(!quiescent) {
        if(!TerminateJobObject(job,124)) throw new Exception("job-terminate");
        var cleanup=Stopwatch.StartNew();
        while(cleanup.ElapsedMilliseconds<5000) {
          Accounting info; if(!QueryInformationJobObject(job,1,out info,(uint)Marshal.SizeOf<Accounting>(),IntPtr.Zero)) break;
          if(info.active==0) {quiescent=true;break;} Thread.Sleep(20);
        }
      }
      if(!GetExitCodeProcess(p.process,out exit)) exit=1;
    } catch { exit=1; }
    finally {
      if(p.process!=IntPtr.Zero && !assigned) TerminateProcess(p.process,1);
      if(job!=IntPtr.Zero) CloseHandle(job);
      if(p.thread!=IntPtr.Zero) CloseHandle(p.thread);
      if(p.process!=IntPtr.Zero) CloseHandle(p.process);
    }
    return "{\"exit\":"+(timedOut?124:exit)+",\"quiescent\":"+(quiescent?"true":"false")+",\"timedOut\":"+(timedOut?"true":"false")+
      ",\"rootExitBeforeCleanup\":"+rootExitBeforeCleanup+",\"activeAtTimeout\":"+activeAtTimeout+"}";
  }
}
