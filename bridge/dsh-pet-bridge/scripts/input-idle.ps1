# How long has the keyboard/mouse been idle? One JSON line on stdout.
# Used by lib/mood/input-probe.js to tell "away from the desk" apart from
# "sitting here ignoring her". Keep this file ASCII-only: PowerShell 5.1
# parses BOM-less UTF-8 as ANSI and non-ASCII comments break the parser.
$src = @'
using System;
using System.Runtime.InteropServices;
public class IdleProbe {
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")]
  public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  public static long IdleMs() {
    var li = new LASTINPUTINFO();
    li.cbSize = (uint)Marshal.SizeOf(li);
    if (!GetLastInputInfo(ref li)) return -1;
    uint now = (uint)Environment.TickCount;
    return (long)(now - li.dwTime);
  }
}
'@
try {
  Add-Type -TypeDefinition $src -ErrorAction Stop
  $ms = [IdleProbe]::IdleMs()
  [Console]::Out.WriteLine('{"idleMs":' + $ms + '}')
} catch {
  [Console]::Out.WriteLine('{"idleMs":-1}')
}
