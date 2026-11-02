# 找一个可见的顶层窗口：标题包含 -Title，取它的屏幕矩形。
# 输出一行 JSON：{"x","y","w","h","hwnd"} 或 {"ok":false}
# 纯 ASCII 输出，主进程直接 JSON.parse 就行（中文标题不进输出，避免编码问题）。
param(
  [string]$Title = '',
  [int]$MinWidth = 200,
  [int]$MinHeight = 200
)

$ErrorActionPreference = 'Stop'

# 没给标题就什么都不做：这脚本是通用的，别把任何人的窗口名写死在里面
if (-not $Title) { '{"ok":false,"error":"no-title"}'; exit 0 }

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WhWinFind {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@

$hits = New-Object System.Collections.ArrayList
$cb = [WhWinFind+EnumWindowsProc]{
  param($h, $p)
  if (-not [WhWinFind]::IsWindowVisible($h)) { return $true }
  $sb = New-Object System.Text.StringBuilder 512
  [void][WhWinFind]::GetWindowText($h, $sb, 512)
  $t = $sb.ToString()
  if (-not $t) { return $true }
  if ($t.IndexOf($Title, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $true }
  $r = New-Object WhWinFind+RECT
  [void][WhWinFind]::GetWindowRect($h, [ref]$r)
  $w = $r.Right - $r.Left
  $hh = $r.Bottom - $r.Top
  if ($w -lt $MinWidth -or $hh -lt $MinHeight) { return $true }
  [void]$hits.Add([pscustomobject]@{ x = $r.Left; y = $r.Top; w = $w; h = $hh; hwnd = [int64]$h })
  return $false   # 只要第一个
}
[void][WhWinFind]::EnumWindows($cb, [IntPtr]::Zero)

if ($hits.Count -gt 0) { $hits[0] | ConvertTo-Json -Compress } else { '{"ok":false}' }
