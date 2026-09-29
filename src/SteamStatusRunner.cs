using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class SteamStatusRunner
{
    [STAThread]
    private static void Main(string[] args)
    {
        string executable;
        using (var current = Process.GetCurrentProcess())
            executable = Path.GetFullPath(current.MainModule.FileName);
        Process steam;
        if (!TryGetWatchProcess(args, out steam)) return;
        string channel = GetChannel(executable);
        using (steam)
        using (var gate = new Mutex(false, @"Local\SteamStatusStudioLive.Mutex." + channel))
        using (var exitSignal = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\SteamStatusStudioLive.Exit." + channel))
        {
            bool ownsGate = false;
            try
            {
                try { ownsGate = gate.WaitOne(0); }
                catch (AbandonedMutexException) { ownsGate = true; }
                if (!ownsGate)
                {
                    exitSignal.Set();
                    try { ownsGate = gate.WaitOne(TimeSpan.FromSeconds(10)); }
                    catch (AbandonedMutexException) { ownsGate = true; }
                }
                if (!ownsGate) return;

                // A runner from an older release does not listen for Exit.
                // Only retire older copies of this exact executable in this session.
                exitSignal.WaitOne(0);
                if (!CloseLegacyInstances(executable)) return;
                RunTray(exitSignal, Path.GetDirectoryName(executable), steam);
            }
            finally
            {
                if (ownsGate) gate.ReleaseMutex();
            }
        }
    }

    private static bool TryGetWatchProcess(string[] args, out Process watched)
    {
        watched = null;
        // Tests may exercise tray and heartbeat behavior without Steam.
        if (args.Length == 1 && args[0] == "--no-steam-watch") return true;
        if (args.Length == 2 && args[0] == "--watch-pid")
        {
            int pid;
            if (!int.TryParse(args[1], out pid) || pid <= 0) return false;
            try { watched = Process.GetProcessById(pid); return !watched.HasExited; }
            catch { if (watched != null) watched.Dispose(); watched = null; return false; }
        }
        if (args.Length != 0) return false;
        using (var current = Process.GetCurrentProcess())
        {
            try
            {
                foreach (var candidate in Process.GetProcessesByName("steam"))
                {
                    try
                    {
                        if (candidate.SessionId == current.SessionId && !candidate.HasExited && watched == null)
                        {
                            watched = candidate;
                            continue;
                        }
                    }
                    catch { /* Ignore an inaccessible process from another session. */ }
                    candidate.Dispose();
                }
            }
            catch { if (watched != null) watched.Dispose(); watched = null; }
        }
        return watched != null;
    }

    private static string GetChannel(string executable)
    {
        using (var sha = SHA256.Create())
        {
            byte[] hash = sha.ComputeHash(Encoding.UTF8.GetBytes(executable.ToUpperInvariant()));
            return BitConverter.ToString(hash).Replace("-", "").Substring(0, 24);
        }
    }

    private static bool CloseLegacyInstances(string executable)
    {
        using (var current = Process.GetCurrentProcess())
        {
            foreach (var process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(executable)))
            {
                using (process)
                {
                    if (process.Id == current.Id) continue;
                    string path;
                    try { path = process.MainModule.FileName; }
                    catch { continue; } // Another user's process is not ours to manage.
                    if (!string.Equals(path, executable, StringComparison.OrdinalIgnoreCase) ||
                        process.SessionId != current.SessionId || process.StartTime >= current.StartTime) continue;
                    try
                    {
                        process.Kill();
                        if (!process.WaitForExit(5000)) return false;
                    }
                    catch { return false; }
                }
            }
        }
        return true;
    }

    private static void RunTray(EventWaitHandle exitSignal, string directory, Process steam)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        using (var context = new ApplicationContext())
        using (var menu = new ContextMenuStrip())
        using (var tray = new NotifyIcon())
        using (var timer = new System.Windows.Forms.Timer())
        {
            int processId;
            using (var current = Process.GetCurrentProcess()) processId = current.Id;
            string heartbeat = Path.Combine(directory, "SteamStatusRunner.heartbeat");
            string nextHeartbeat = heartbeat + ".next";
            string stopRequest = Path.Combine(directory, "SteamStatusRunner.stop");
            try { File.Delete(stopRequest); } catch { }
            var title = menu.Items.Add("Steam Status Studio Live");
            title.Enabled = false;
            menu.Items.Add(new ToolStripSeparator());
            var stop = menu.Items.Add("Stop Steam status");
            stop.Click += (sender, args) => context.ExitThread();

            tray.Icon = SystemIcons.Application;
            tray.Text = "Steam Status Studio Live";
            tray.ContextMenuStrip = menu;
            tray.Visible = true;
            timer.Interval = 1000;
            DateTime lastHeartbeat = DateTime.UtcNow;
            EventHandler tick = (sender, args) =>
            {
                bool steamExited = false;
                try { steamExited = steam != null && steam.HasExited; }
                catch { steamExited = true; }
                if (steamExited || exitSignal.WaitOne(0) || File.Exists(stopRequest))
                {
                    try { File.Delete(stopRequest); } catch { }
                    context.ExitThread();
                    return;
                }
                try
                {
                    long milliseconds = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
                    File.WriteAllText(nextHeartbeat, processId + ":" + milliseconds);
                    if (File.Exists(heartbeat)) File.Replace(nextHeartbeat, heartbeat, null);
                    else File.Move(nextHeartbeat, heartbeat);
                    lastHeartbeat = DateTime.UtcNow;
                }
                catch
                {
                    // A short-lived file lock should not terminate the status,
                    // but a persistently stale heartbeat must not look healthy.
                    if (DateTime.UtcNow - lastHeartbeat > TimeSpan.FromSeconds(5)) context.ExitThread();
                }
            };
            timer.Tick += tick;
            tick(null, EventArgs.Empty);
            timer.Start();
            try
            {
                Application.Run(context);
            }
            finally
            {
                timer.Stop();
                try { File.Delete(heartbeat); } catch { }
                try { File.Delete(nextHeartbeat); } catch { }
                tray.Visible = false;
            }
        }
    }
}
