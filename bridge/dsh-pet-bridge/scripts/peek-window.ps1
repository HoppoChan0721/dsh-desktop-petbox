param(
  [Parameter(Mandatory = $true)][string]$JsonOut,
  [int]$MaxLines = 80
)
# 窥屏探针：抓前台窗口画面 + 本地 OCR，结果写成一份 JSON 给 Node 读。
# 设计口径（2026-11-05）：
#   1. 只抓前台窗口，不抓整屏——桌面其它窗口是主人的隐私，也免得 OCR 一堆无关文字。
#   2. OCR 用 Windows 自带的 Windows.Media.Ocr（Win10 起内置、离线、零依赖、不花钱），
#      语言包缺了就降级成「只有进程名 + 标题」，绝不抛错。
#   3. 任何一步失败都写成 ok:false + error，Node 那边当"这轮跳过"处理。
#   4. 输出走文件（UTF-8 无 BOM），不走 stdout：PowerShell 5.1 的管道编码会把中文搞成乱码。

$ErrorActionPreference = 'Stop'
$res = [ordered]@{
  ok = $false; at = (Get-Date).ToString('o'); error = $null
  proc = ''; pid = 0; title = ''; fullscreen = $false
  crop = ''; win = ''; monitor = ''; avg = -1; shot = ''; lines = @()
}

function Save-Result {
  try {
    $json = $res | ConvertTo-Json -Depth 5 -Compress
    [System.IO.File]::WriteAllText($JsonOut, $json, (New-Object System.Text.UTF8Encoding($false)))
  } catch {}
}

try {
  Add-Type -AssemblyName System.Drawing
  if (-not ('PeekWin32' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PeekWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
}
'@
  }

  $vl = [PeekWin32]::GetSystemMetrics(76); $vt = [PeekWin32]::GetSystemMetrics(77)
  $vw = [PeekWin32]::GetSystemMetrics(78); $vh = [PeekWin32]::GetSystemMetrics(79)
  $vr = $vl + $vw; $vb = $vt + $vh

  $h = [PeekWin32]::GetForegroundWindow()
  if ($h -eq [IntPtr]::Zero) { throw 'no foreground window' }
  $len = [PeekWin32]::GetWindowTextLength($h)
  $sbt = New-Object System.Text.StringBuilder ($len + 2)
  [void][PeekWin32]::GetWindowText($h, $sbt, $sbt.Capacity)
  $res.title = $sbt.ToString()
  $ppid = 0
  [void][PeekWin32]::GetWindowThreadProcessId($h, [ref]$ppid)
  $res.pid = $ppid
  try { $res.proc = (Get-Process -Id $ppid -ErrorAction Stop).ProcessName } catch { $res.proc = '' }

  $r = New-Object PeekWin32+RECT
  [void][PeekWin32]::GetWindowRect($h, [ref]$r)
  $winW = $r.Right - $r.Left; $winH = $r.Bottom - $r.Top
  $res.win = "$winW`x$winH"
  # 全屏判定要比**窗口所在的那块显示器**，不能比整个虚拟屏：
  # 多屏并排时虚拟屏是各屏拼起来的，用虚拟屏比会把普通窗口也当成满屏（2026-11-05 误报过）。
  $mw = 0; $mh = 0
  try {
    $mon = [PeekWin32]::MonitorFromWindow($h, 2)   # MONITOR_DEFAULTTONEAREST
    $mi = New-Object PeekWin32+MONITORINFO
    $mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($mi)
    if ([PeekWin32]::GetMonitorInfo($mon, [ref]$mi)) {
      $mw = $mi.rcMonitor.Right - $mi.rcMonitor.Left
      $mh = $mi.rcMonitor.Bottom - $mi.rcMonitor.Top
    }
  } catch {}
  if ($mw -le 0 -or $mh -le 0) { $mw = $vw; $mh = $vh }
  $res.monitor = "$mw`x$mh"
  $res.fullscreen = (($winW -ge ($mw - 8)) -and ($winH -ge ($mh - 8)))

  if ([PeekWin32]::IsIconic($h) -or $winW -le 40 -or $winH -le 40) { throw 'window minimized or too small' }

  # 裁剪到虚拟屏内，避免复制屏外区域
  $sx = [Math]::Max($r.Left, $vl); $sy = [Math]::Max($r.Top, $vt)
  $ex = [Math]::Min($r.Right, $vr); $ey = [Math]::Min($r.Bottom, $vb)
  $cw = $ex - $sx; $ch = $ey - $sy
  if ($cw -le 40 -or $ch -le 40) { throw 'window off screen' }
  $res.crop = "$cw`x$ch"

  # 全屏独占（游戏）常常抓出来一片黑，先按亮度粗判，黑了就不 OCR
  $bmp = New-Object System.Drawing.Bitmap $cw, $ch
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($sx, $sy, 0, 0, $bmp.Size)
  $sum = 0.0; $n = 0
  $step = [Math]::Max(12, [int]($cw / 120))
  for ($y = 0; $y -lt $ch; $y += $step) {
    for ($x = 0; $x -lt $cw; $x += $step) {
      $c = $bmp.GetPixel($x, $y)
      $sum += ($c.R + $c.G + $c.B) / 3.0
      $n++
    }
  }
  if ($n -gt 0) { $res.avg = [Math]::Round($sum / $n, 1) }

  $shot = Join-Path (Split-Path $JsonOut -Parent) 'shot.png'
  $bmp.Save($shot, [System.Drawing.Imaging.ImageFormat]::Png)
  $res.shot = $shot
  $g.Dispose(); $bmp.Dispose()

  if ($res.avg -lt 6) {
    $res.ok = $true
    $res.error = 'screen too dark, skip ocr'
    Save-Result
    return
  }

  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
  function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
  }

  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $engine) { throw 'no OCR language pack' }

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($shot)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $sbit = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $ocr = Await ($engine.RecognizeAsync($sbit)) ([Windows.Media.Ocr.OcrResult])

  $out = New-Object System.Collections.ArrayList
  foreach ($line in $ocr.Lines) {
    $t = $line.Text.Trim()
    if ($t.Length -lt 2) { continue }
    # 中文 OCR 会给每个字之间塞空格，去掉；英文单词之间的空格留着
    $t = [regex]::Replace($t, '(?<=[\u4e00-\u9fa5\uff00-\uffef])\s+(?=[\u4e00-\u9fa5\uff00-\uffef])', '')
    # 模糊行大多长这样：「屏试 p “ 如 e5t12 彐」——中文不到两字、字母数字不到四个的，多半是噪声
    $cjk = ([regex]::Matches($t, '[\u4e00-\u9fa5]')).Count
    $lat = ([regex]::Matches($t, '[A-Za-z0-9]')).Count
    if ($cjk -lt 2 -and $lat -lt 4) { continue }
    [void]$out.Add($t)
    if ($out.Count -ge $MaxLines) { break }
  }
  $res.lines = @($out)
  $res.ok = $true
}
catch {
  $res.error = $_.Exception.Message
  $res.ok = $false
}
Save-Result
