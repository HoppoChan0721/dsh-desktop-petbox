param(
  [Parameter(Mandatory = $true)][string]$JsonOut,
  [int]$MaxLines = 80,
  [double]$Scale = 1.0,
  [string]$OcrPython = '',
  [string]$OcrScript = '',
  [string]$Target = '',
  [switch]$PickActive,
  [switch]$Light
)
# 窥屏探针：抓前台窗口画面 + 本地 OCR，结果写成一份 JSON 给 Node 读。
# 设计口径（2026-11-05）：
#   1. 只抓前台窗口，不抓整屏——桌面其它窗口是主人的隐私，也免得 OCR 一堆无关文字。
#   2. 识别两条路：给了 -OcrPython / -OcrScript 就先走 RapidOCR（PP-OCR 的 onnx 版，中文准得多），
#      没装或者认不出来再回落 Windows 自带的 Windows.Media.Ocr（Win10 起内置，语言包缺了就没有）。
#      两条都不可用时只报「进程名 + 标题」，绝不抛错。
#      小字认不准时先按 -Scale 放大再喂（2x 明显比 1x 准，代价是慢一点）。
#   3. 任何一步失败都写成 ok:false + error，Node 那边当"这轮跳过"处理。
#   4. 输出走文件（UTF-8 无 BOM），不走 stdout：PowerShell 5.1 的管道编码会把中文搞成乱码。

if (-not $OcrScript) { $OcrScript = Join-Path $PSScriptRoot 'ocr.py' }  # 默认用插件包自带的入口
$ErrorActionPreference = 'Stop'
$res = [ordered]@{
  ok = $false; at = (Get-Date).ToString('o'); error = $null
  proc = ''; pid = 0; title = ''; fullscreen = $false
  crop = ''; win = ''; monitor = ''; picked = ''; scale = 1.0; avg = -1; shot = ''; lines = @()
  engine = ''; pyMs = -1; pyEngineMs = -1; pyError = ''
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
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int idx);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

  const int GWL_EXSTYLE = -20;
  const int WS_EX_TOOLWINDOW = 0x00000080;
  const int WS_EX_APPWINDOW = 0x00040000;
  const uint GW_OWNER = 4;

  // 「任务栏上真有一格」的判定：可见、不是工具窗、没有 owner（对话框跟着主人窗走，不算独立一格）。
  // 桌宠自己那层透明壳是 skipTaskbar + 无边框，天然被这组条件排除。
  static bool IsTaskbarWindow(IntPtr h) {
    if (!IsWindowVisible(h)) return false;
    if (IsIconic(h)) return false;
    if (GetWindowTextLength(h) < 2) return false;
    int ex = GetWindowLong(h, GWL_EXSTYLE);
    bool tool = (ex & WS_EX_TOOLWINDOW) != 0;
    bool app = (ex & WS_EX_APPWINDOW) != 0;
    if (tool && !app) return false;
    if (GetWindow(h, GW_OWNER) != IntPtr.Zero && !app) return false;
    return true;
  }

  // 按「进程名 / 标题片段」找窗口：主人想钉死某个窗口时用（peekTarget）。
  public static IntPtr FindByTarget(string target) {
    if (string.IsNullOrEmpty(target)) return IntPtr.Zero;
    string want = target.ToLowerInvariant();
    IntPtr best = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsTaskbarWindow(h)) return true;
      int pid; GetWindowThreadProcessId(h, out pid);
      string name = "";
      try { name = System.Diagnostics.Process.GetProcessById(pid).ProcessName; } catch { return true; }
      var sbt = new System.Text.StringBuilder(260);
      GetWindowText(h, sbt, 260);
      string t = sbt.ToString();
      if (name.ToLowerInvariant().Contains(want) || t.ToLowerInvariant().Contains(want)) {
        best = h;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  // 沿 Z 序（上到下）找第一个「真实」窗口：跳过不可见 / 最小化 / 没标题 / electron（桌宠壳子自己）。
  // 为什么需要：点托盘菜单那一瞬前台会变成桌宠窗口，拿它去截图只会拍到她自己的空壳。
  // 尺寸也管着：AIDA64 的 OSD、输入法候选条这类小悬浮窗常置顶，拍它等于拍了个字幕。
  public static IntPtr FindTopCandidate() {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsTaskbarWindow(h)) return true;
      RECT rc;
      if (!GetWindowRect(h, out rc)) return true;
      if ((rc.Right - rc.Left) < 320 || (rc.Bottom - rc.Top) < 240) return true;
      int pid; GetWindowThreadProcessId(h, out pid);
      string name = "";
      try { name = System.Diagnostics.Process.GetProcessById(pid).ProcessName; } catch { return true; }
      if (name == "electron") return true;
      var sbt = new System.Text.StringBuilder(260);
      GetWindowText(h, sbt, 260);
      string t = sbt.ToString();
      if (t == "Program Manager") return true;
      found = h;
      return false;
    }, IntPtr.Zero);
    return found;
  }
}
'@
  }

  $vl = [PeekWin32]::GetSystemMetrics(76); $vt = [PeekWin32]::GetSystemMetrics(77)
  $vw = [PeekWin32]::GetSystemMetrics(78); $vh = [PeekWin32]::GetSystemMetrics(79)
  $vr = $vl + $vw; $vb = $vt + $vh

  # 选窗口，三层优先：钉死的 target > 手动触发的「任务栏最近窗口」 > 前台窗口
  $h = [PeekWin32]::GetForegroundWindow()
  if ($Target) {
    $cand = [PeekWin32]::FindByTarget($Target)
    if ($cand -ne [IntPtr]::Zero) { $h = $cand; $res.picked = 'target' }
  }
  if (-not $res.picked -and $PickActive) {
    # 手动触发时前台往往是桌宠窗口（点托盘菜单就抢焦点了），换成任务栏里最靠前的那个真实窗口
    $cand = [PeekWin32]::FindTopCandidate()
    if ($cand -ne [IntPtr]::Zero) {
      if ($cand -ne $h) { $res.picked = 'zorder' }
      $h = $cand
    }
  }
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

  # 轻探针到此为止：只要进程名、标题、是否全屏。不截图、不 OCR、不碰磁盘图片。
  # 用途是「事件」：全屏游戏什么时候开始、什么时候结束，前台换了没有。
  # 这套几十毫秒就能跑完，可以几十秒问一次；重探针那套要截图认字，不能勤跑。
  if ($Light) { $res.ok = $true; Save-Result; exit 0 }

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

  # 小字认不准就先放大再 OCR：高清双三次插值，2x 对中文小字提升明显
  if ($Scale -gt 1.01) {
    $bw = [int][Math]::Round($cw * $Scale); $bh = [int][Math]::Round($ch * $Scale)
    if ($bw -le 8000 -and $bh -le 8000) {
      $big = New-Object System.Drawing.Bitmap $bw, $bh
      $gb = [System.Drawing.Graphics]::FromImage($big)
      $gb.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $gb.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $gb.DrawImage($bmp, 0, 0, $bw, $bh)
      $gb.Dispose()
      $bmp.Dispose()
      $bmp = $big
      $res.scale = $Scale
    }
  }

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

  # ---- 识别：优先 RapidOCR（PP-OCR 模型的 onnx 版，中文准得多），装不出来就回落系统 OCR ----
  $lines = New-Object System.Collections.ArrayList
  if ($OcrPython -and $OcrScript -and (Test-Path $OcrPython) -and (Test-Path $OcrScript)) {
    $d = Split-Path $JsonOut -Parent
    $pyJson = Join-Path $d 'ocr.json'
    $pyOut = Join-Path $d 'py.out'
    $pyErrFile = Join-Path $d 'py.err'
    foreach ($f in @($pyJson, $pyOut, $pyErrFile)) { try { if (Test-Path $f) { Remove-Item $f -Force } } catch {} }
    $t0 = Get-Date
    # 用 Start-Process 而不是 &：RapidOCR 会把 [INFO] 打去 stderr，
    # 在 $ErrorActionPreference='Stop' 下这会被当成错误、把命令打断（踩过，表现为「no ocr json」）。
    try {
      $proc = Start-Process -FilePath $OcrPython -ArgumentList @($OcrScript, $shot, $pyJson) `
        -NoNewWindow -Wait -PassThru -RedirectStandardOutput $pyOut -RedirectStandardError $pyErrFile
      $res.pyExit = $proc.ExitCode
    } catch { $res.pyError = 'spawn failed: ' + $_.Exception.Message }
    $res.pyMs = [int]((Get-Date) - $t0).TotalMilliseconds
    if (Test-Path $pyJson) {
      try {
        $pj = Get-Content $pyJson -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($pj.ok) {
          foreach ($t in @($pj.lines)) { $s = [string]$t; if ($s.Trim().Length -ge 2) { [void]$lines.Add($s.Trim()) } }
          $res.engine = 'rapidocr'
          $res.pyEngineMs = $pj.ms
        } else { $res.pyError = [string]$pj.error }
      } catch { $res.pyError = 'bad ocr json' }
    } elseif (-not $res.pyError) {
      $tail = ''
      try { $tail = [string](Get-Content $pyErrFile -Raw -Encoding UTF8) } catch {}
      $tail = $tail.Trim()
      if ($tail.Length -gt 160) { $tail = $tail.Substring(0, 160) }
      if ($tail) { $res.pyError = 'no ocr json: ' + $tail } else { $res.pyError = 'no ocr json' }
    }
    foreach ($f in @($pyJson, $pyOut, $pyErrFile)) { try { if (Test-Path $f) { Remove-Item $f -Force } } catch {} }
  }

  if ($lines.Count -gt 0) {
    $res.lines = @($lines | Select-Object -First $MaxLines)
    $res.ok = $true
    Save-Result
    return
  }

  $res.engine = 'windowsocr'
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
