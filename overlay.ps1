param(
  [int]$Port = 17863
)

# ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
# so every localized string and emoji arrives inside the JSON payload (UTF-8).
# Layout is scaled by hand (AutoScaleMode None) so mixed point-sized fonts and
# pixel bounds stay aligned on 150% / 200% displays.
#
# The card receives its state over a loopback-only TCP listener spoken to by the
# DSH client plugin with a no-cors POST (text/plain body), so no DSH host change
# is needed: the browser pushes straight into this process.
#
# Layout notes (2.0): the card is half as wide as before (260 logical px), the
# detail line is clipped to one short passage plus an ellipsis instead of the
# full thinking text, and the status lamp is back: red while the model is
# thinking / streaming, green while tools run or the card is otherwise idle.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DshOverlayNative {
  [DllImport("user32.dll")] public static extern bool ReleaseCapture();
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
"@

# Per-monitor aware before any window exists: otherwise the whole card is
# bitmap-scaled by the OS and the text turns blurry on 150% / 200% displays.
try {
  [DshOverlayNative]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
} catch {
  # Already aware through the host manifest.
}
try {
  [System.Windows.Forms.Application]::SetHighDpiMode([System.Windows.Forms.HighDpiMode]::PerMonitorV2) | Out-Null
} catch {
  # Older .NET: keep the default DPI mode.
}

# A form that never steals focus: WS_EX_NOACTIVATE plus the matching managed hook.
$refs = @([System.Windows.Forms.Form].Assembly.Location, [System.Drawing.Color].Assembly.Location)
Add-Type -ReferencedAssemblies $refs -TypeDefinition @"
using System;
using System.Windows.Forms;
public class DshOverlayForm : Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get {
      CreateParams cp = base.CreateParams;
      cp.ExStyle |= 0x08000000;
      return cp;
    }
  }
}
"@

# ---- single instance -------------------------------------------------------
$createdNew = $false
$mutex = $null
try {
  $mutex = New-Object System.Threading.Mutex($true, 'Global\DshLiveThinkingOverlay', [ref]$createdNew)
} catch {
  $createdNew = $true
}
if (-not $createdNew) {
  if ($null -ne $mutex) { $mutex.Dispose() }
  exit 0
}

$script:stateDir = Join-Path $env:TEMP 'dsh-live-thinking'
New-Item -ItemType Directory -Force -Path $script:stateDir | Out-Null
$script:posFile = Join-Path $script:stateDir 'window.json'
$script:logFile = Join-Path $script:stateDir 'overlay.log'

function Trace([string]$message) {
  if ($env:DSH_LIVE_THINKING_DEBUG -ne '1') { return }
  try {
    Add-Content -LiteralPath $script:logFile -Value ((Get-Date -Format o) + ' ' + $message) -Encoding UTF8
  } catch {
    # Diagnostics only.
  }
}

# ---- listener --------------------------------------------------------------
$script:listener = $null
try {
  $script:listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
  $script:listener.Start()
  Trace "listening on 127.0.0.1:$Port"
} catch {
  Trace ('listener failed: ' + ($_ | Out-String))
  $script:listener = $null
}

# ---- DPI -------------------------------------------------------------------
$g = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
$script:scale = $g.DpiX / 96.0
$g.Dispose()
if ($script:scale -le 0) { $script:scale = 1.0 }

function S([double]$value) { return [int][math]::Round($value * $script:scale) }

# ---- helpers ---------------------------------------------------------------
function Format-Clock([double]$ms) {
  $total = [math]::Floor([math]::Max(0, $ms) / 1000)
  $s = $total % 60
  $m = [math]::Floor($total / 60) % 60
  $h = [math]::Floor($total / 3600)
  if ($h -gt 0) { return ('{0}:{1:00}:{2:00}' -f $h, $m, $s) }
  return ('{0}:{1:00}' -f $m, $s)
}

function Convert-RoundedPath([int]$w, [int]$h, [int]$r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = [math]::Max(1, $r * 2)
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($w - $d, 0, $d, $d, 270, 90)
  $path.AddArc($w - $d, $h - $d, $d, $d, 0, 90)
  $path.AddArc(0, $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

# One short passage, never the whole thought: at this width two wrapped lines
# hold roughly 40 CJK glyphs, so cut there and mark the cut with an ellipsis.
function Short-Passage([string]$text, [int]$limit) {
  if ($null -eq $text) { return '' }
  $flat = ($text -replace '[\r\n\t]+', ' ').Trim()
  if ($flat.Length -le $limit) { return $flat }
  return $flat.Substring(0, $limit) + [string][char]0x2026
}

function Save-Position {
  if (-not $script:visible) { return }
  try {
    $payload = @{ x = $script:form.Left; y = $script:form.Top } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($script:posFile, $payload, (New-Object System.Text.UTF8Encoding($false)))
  } catch {
    # Position is cosmetic.
  }
}

function Restore-Position {
  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $x = $area.Right - $script:form.Width - (S 28)
  $y = $area.Bottom - $script:form.Height - (S 28)
  try {
    if (Test-Path -LiteralPath $script:posFile) {
      $saved = Get-Content -LiteralPath $script:posFile -Raw -Encoding UTF8 | ConvertFrom-Json
      $sx = [int]$saved.x
      $sy = [int]$saved.y
      # A saved x/y from the wide layout would leave the narrow card floating
      # mid-screen, so only trust it when the card still fits inside the corner.
      if (($sx + $script:form.Width) -le $area.Right -and $sy -lt $area.Bottom) {
        foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
          $a = $s.WorkingArea
          if ($sx -ge $a.Left -and $sx -lt ($a.Right - 40) -and $sy -ge ($a.Top + 40) -and $sy -lt ($a.Bottom - 40)) {
            $x = $sx
            $y = $sy
            break
          }
        }
      }
    }
  } catch {
    # Fall back to the default corner.
  }
  $script:form.Left = $x
  $script:form.Top = $y
}

# ---- window ----------------------------------------------------------------
$script:form = New-Object DshOverlayForm
$form = $script:form
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.MinimizeBox = $false
$form.MaximizeBox = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(28, 29, 33)
$form.ForeColor = [System.Drawing.Color]::FromArgb(237, 237, 240)
$form.ClientSize = New-Object System.Drawing.Size((S 260), (S 70))
$form.Opacity = 0.95
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$form.Text = 'DSH live thinking'
Trace 'form created'

# Status lamp: red while the model thinks or streams, green otherwise.
$lamp = New-Object System.Windows.Forms.Label
$lamp.AutoSize = $false
$lamp.SetBounds((S 9), (S 11), (S 14), (S 14))
$lamp.Font = New-Object System.Drawing.Font('Segoe UI', 8.5)
$lamp.ForeColor = [System.Drawing.Color]::FromArgb(64, 200, 120)
$lamp.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$lamp.Text = [string][char]0x25CF
$form.Controls.Add($lamp)

$icon = New-Object System.Windows.Forms.Label
$icon.AutoSize = $false
$icon.SetBounds((S 24), (S 10), (S 18), (S 18))
$icon.Font = New-Object System.Drawing.Font('Segoe UI Emoji', 9)
$icon.Text = ''
$icon.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$form.Controls.Add($icon)

$title = New-Object System.Windows.Forms.Label
$title.AutoSize = $false
$title.SetBounds((S 44), (S 6), (S 150), (S 22))
$title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$title.ForeColor = [System.Drawing.Color]::FromArgb(240, 240, 244)
$title.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
$title.AutoEllipsis = $true
$title.Text = ''
$form.Controls.Add($title)

$clock = New-Object System.Windows.Forms.Label
$clock.AutoSize = $false
$clock.SetBounds((S 196), (S 6), (S 42), (S 22))
$clock.Font = New-Object System.Drawing.Font('Consolas', 8)
$clock.ForeColor = [System.Drawing.Color]::FromArgb(150, 153, 162)
$clock.TextAlign = [System.Drawing.ContentAlignment]::MiddleRight
$clock.Text = ''
$form.Controls.Add($clock)

$detail = New-Object System.Windows.Forms.Label
$detail.AutoSize = $false
$detail.SetBounds((S 10), (S 30), (S 226), (S 34))
$detail.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 8)
$detail.ForeColor = [System.Drawing.Color]::FromArgb(168, 171, 180)
$detail.TextAlign = [System.Drawing.ContentAlignment]::TopLeft
$detail.Text = ''
$detail.AutoEllipsis = $false
$form.Controls.Add($detail)

$close = New-Object System.Windows.Forms.Label
$close.AutoSize = $false
$close.SetBounds((S 238), (S 2), (S 18), (S 18))
$close.Font = New-Object System.Drawing.Font('Segoe UI', 8)
$close.ForeColor = [System.Drawing.Color]::FromArgb(120, 123, 132)
$close.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$close.Text = 'x'
$close.Cursor = [System.Windows.Forms.Cursors]::Hand
$form.Controls.Add($close)

$drag = {
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    [DshOverlayNative]::ReleaseCapture() | Out-Null
    [DshOverlayNative]::SendMessage($script:form.Handle, 0xA1, [IntPtr]0x2, [IntPtr]::Zero) | Out-Null
  }
}
$form.Add_MouseDown($drag)
$lamp.Add_MouseDown($drag)
$icon.Add_MouseDown($drag)
$title.Add_MouseDown($drag)
$clock.Add_MouseDown($drag)
$detail.Add_MouseDown($drag)

$close.Add_MouseEnter({ $script:close.ForeColor = [System.Drawing.Color]::FromArgb(232, 96, 96) })
$close.Add_MouseLeave({ $script:close.ForeColor = [System.Drawing.Color]::FromArgb(120, 123, 132) })

$script:state = $null
$script:stateAt = 0
$script:lastKind = ''
$script:lastLabel = ''
$script:lastDetail = ''
$script:dismissed = $false
$script:visible = $false
$script:lastSaveMs = 0
$script:lampRed = $false
# When the turn ends the client posts running:false; the card stays up for a
# few seconds in green and then hides. endedAt is 0 while a turn is live.
$script:endedAt = 0
$script:doneMs = 20000
# "work finished" rendered from code points: this file stays ASCII for PS 5.1.
$script:doneText = -join @([char]0x5DE5, [char]0x4F5C, [char]0x7ED3, [char]0x675F)

function Set-Visible([bool]$on) {
  if ($on -eq $script:visible) { return }
  $script:visible = $on
  Trace ("visible=" + $on)
  if ($on) {
    $script:form.Show()
    $script:form.TopMost = $true
  } else {
    $script:form.Hide()
  }
}

$close.Add_Click({
  $script:dismissed = $true
  Set-Visible $false
})

$form.Add_Move({
  $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if (($nowMs - $script:lastSaveMs) -lt 700) { return }
  $script:lastSaveMs = $nowMs
  if ($script:form.WindowState -eq [System.Windows.Forms.FormWindowState]::Normal) { Save-Position }
})

$form.Add_Shown({
  Restore-Position
  Trace ("shown client=" + $script:form.ClientSize.Width + "x" + $script:form.ClientSize.Height + " pos=" + $script:form.Left + "," + $script:form.Top + " dpi=" + $script:scale)
  $p = Convert-RoundedPath $script:form.Width $script:form.Height (S 14)
  $script:form.Region = New-Object System.Drawing.Region -ArgumentList $p
})

# ---- loopback HTTP ---------------------------------------------------------
function Handle-Request {
  $client = $null
  try {
    $client = $script:listener.AcceptTcpClient()
    $client.ReceiveTimeout = 300
    $stream = $client.GetStream()
    $buffer = New-Object byte[] 8192
    $raw = New-Object System.IO.MemoryStream
    $deadline = [DateTime]::UtcNow.AddMilliseconds(300)
    $idle = 0
    while ([DateTime]::UtcNow -lt $deadline -and $idle -lt 4) {
      if (-not $stream.DataAvailable) {
        Start-Sleep -Milliseconds 5
        $idle++
        continue
      }
      $idle = 0
      $read = $stream.Read($buffer, 0, $buffer.Length)
      if ($read -le 0) { break }
      $raw.Write($buffer, 0, $read)
    }
    $body = $null
    $text = [System.Text.Encoding]::UTF8.GetString($raw.ToArray())
    $split = $text.IndexOf("`r`n`r`n", [System.StringComparison]::Ordinal)
    if ($split -ge 0) {
      $body = $text.Substring($split + 4)
      $body = $body.TrimEnd([char[]]@([char]0, [char]13, [char]10, [char]32, [char]9))
    }
    Trace ("request bytes=" + $text.Length + " body=" + $(if ($null -eq $body) { 'none' } else { [string]$body.Length }))
    if ($null -ne $body -and $body.Trim() -ne '') {
      try {
        $parsed = $body | ConvertFrom-Json
        $script:state = $parsed
        $script:stateAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        Trace ("state: running=" + $parsed.running + " kind=" + $parsed.kind)
      } catch {
        Trace ('bad json: ' + ($_ | Out-String))
      }
    }
    $response = [System.Text.Encoding]::ASCII.GetBytes("HTTP/1.1 204 No Content`r`nAccess-Control-Allow-Origin: *`r`nConnection: close`r`n`r`n")
    $stream.Write($response, 0, $response.Length)
    $stream.Flush()
  } catch {
    # A dropped connection is normal: the browser fires and forgets.
  } finally {
    if ($null -ne $client) { $client.Close() }
  }
}

function Update-Overlay {
  if ($null -ne $script:listener) {
    $drained = 0
    while ($drained -lt 4 -and $script:listener.Pending()) {
      $drained++
      Handle-Request
    }
  }

  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $state = $script:state
  if ($null -eq $state) {
    Set-Visible $false
    return
  }

  $live = ($state.running -eq $true)
  # No heartbeat for 15 s means the page is gone; never show a fossil.
  if ($live -and $script:stateAt -gt 0 -and ($now - $script:stateAt) -gt 15000) {
    $live = $false
  }

  if (-not $live) {
    # Red means working, green means the turn is over: flash green briefly,
    # then let the card go away on its own.
    if ($script:endedAt -le 0) {
      $script:endedAt = $now
      $script:dismissed = $false
      $script:lastKind = ''
      $script:lastLabel = ''
      $script:lastDetail = ''
      if ($script:lampRed) {
        $script:lampRed = $false
        $script:lamp.ForeColor = [System.Drawing.Color]::FromArgb(64, 200, 120)
      }
      $script:icon.Text = [char]::ConvertFromUtf32(0x2705)
      $script:title.Text = $script:doneText
      $script:title.ForeColor = [System.Drawing.Color]::FromArgb(120, 216, 160)
      $script:detail.Text = ''
      $script:clock.Text = ''
    }
    if (($now - $script:endedAt) -gt $script:doneMs) {
      Set-Visible $false
      return
    }
    if ($script:dismissed) {
      Set-Visible $false
      return
    }
    Set-Visible $true
    return
  }

  $script:endedAt = 0

  if ([string]$state.kind -ne $script:lastKind) {
    $script:lastKind = [string]$state.kind
    # Code points, not literals: this script stays ASCII for Windows PowerShell 5.1.
    switch ($script:lastKind) {
      'think' { $script:icon.Text = [char]::ConvertFromUtf32(0x1F9E0) }
      'tool' { $script:icon.Text = [char]::ConvertFromUtf32(0x1F527) }
      'stream' { $script:icon.Text = [char]::ConvertFromUtf32(0x270D) }
      'model' { $script:icon.Text = [char]::ConvertFromUtf32(0x1F9E0) }
      'retry' { $script:icon.Text = [char]::ConvertFromUtf32(0x267B) }
      default { $script:icon.Text = [string][char]0x2022 }
    }
  }

  # Red is "working": every heartbeat that reaches this point belongs to a live
  # turn, whatever step it is in. Green is reserved for the finished beat above.
  if (-not $script:lampRed) {
    $script:lampRed = $true
    $script:lamp.ForeColor = [System.Drawing.Color]::FromArgb(232, 72, 72)
  }

  if ($null -ne $state.label -and [string]$state.label -ne $script:lastLabel) {
    $script:lastLabel = [string]$state.label
    $script:title.Text = $script:lastLabel
  }
  if ($null -ne $state.detail -and [string]$state.detail -ne $script:lastDetail) {
    $script:lastDetail = [string]$state.detail
    $script:detail.Text = Short-Passage $script:lastDetail 40
  }
  if ($null -ne $state.accent) {
    try { $script:title.ForeColor = [System.Drawing.ColorTranslator]::FromHtml([string]$state.accent) } catch { }
  } else {
    $script:title.ForeColor = [System.Drawing.Color]::FromArgb(240, 240, 244)
  }

  $startedAt = 0
  if ($null -ne $state.startedAt) { $startedAt = [int64]$state.startedAt }
  if ($startedAt -gt 0) { $script:clock.Text = Format-Clock ($now - $startedAt) } else { $script:clock.Text = '' }

  if ($script:dismissed) {
    Set-Visible $false
    return
  }
  Set-Visible $true
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 150
$timer.Add_Tick({
  try {
    Update-Overlay
  } catch {
    Trace ('tick error: ' + ($_ | Out-String))
  }
})

$timer.Start()
[System.Windows.Forms.Application]::Run()

if ($null -ne $script:listener) {
  try { $script:listener.Stop() } catch { }
}
