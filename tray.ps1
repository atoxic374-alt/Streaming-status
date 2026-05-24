Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "SilentlyContinue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$shared = [hashtable]::Synchronized(@{ url = "http://localhost:5000"; ready = $false })

# ── Start Node.js server hidden ────────────────────────────────────
$pinfo = New-Object System.Diagnostics.ProcessStartInfo
$pinfo.FileName = "node"
$pinfo.Arguments = "`"$ScriptDir\web\server.js`""
$pinfo.WorkingDirectory = $ScriptDir
$pinfo.CreateNoWindow = $true
$pinfo.UseShellExecute = $false
$pinfo.RedirectStandardOutput = $true
$pinfo.RedirectStandardError = $true
$pinfo.EnvironmentVariables["NO_AUTO_OPEN"] = "1"

$nodeProc = [System.Diagnostics.Process]::new()
$nodeProc.StartInfo = $pinfo

try {
    $nodeProc.Start() | Out-Null
} catch {
    [System.Windows.Forms.MessageBox]::Show(
        "Could not start Node.js. Make sure Node.js is installed.`nhttps://nodejs.org",
        "StreamDash Error",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    )
    exit
}

# ── Read stdout in background to detect port ───────────────────────
$rs = [runspacefactory]::CreateRunspace()
$rs.Open()
$rs.SessionStateProxy.SetVariable('nodeProc', $nodeProc)
$rs.SessionStateProxy.SetVariable('shared', $shared)

$ps = [powershell]::Create()
$ps.Runspace = $rs
$ps.AddScript({
    $reader = $nodeProc.StandardOutput
    while (-not $nodeProc.HasExited) {
        $line = $reader.ReadLine()
        if ($line -match 'Dashboard running on (http://localhost:\d+)') {
            $shared.url = $matches[1]
            $shared.ready = $true
            break
        }
    }
}) | Out-Null
$ps.BeginInvoke() | Out-Null

# ── Build tray icon ────────────────────────────────────────────────
$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Text = "StreamDash - Starting..."
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
$notifyIcon.Visible = $true

# ── Context menu ───────────────────────────────────────────────────
$menu = New-Object System.Windows.Forms.ContextMenuStrip

$headerItem = New-Object System.Windows.Forms.ToolStripMenuItem
$headerItem.Text = "StreamDash v3.0"
$headerItem.Enabled = $false
$menu.Items.Add($headerItem) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$openItem = New-Object System.Windows.Forms.ToolStripMenuItem
$openItem.Text = "Open Dashboard"
$openItem.Font = New-Object System.Drawing.Font($openItem.Font, [System.Drawing.FontStyle]::Bold)
$menu.Items.Add($openItem) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem
$statusItem.Text = "Status: Starting..."
$statusItem.Enabled = $false
$menu.Items.Add($statusItem) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem
$exitItem.Text = "Exit StreamDash"
$menu.Items.Add($exitItem) | Out-Null

$notifyIcon.ContextMenuStrip = $menu

# ── Timer: detect when server is ready ────────────────────────────
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({
    if ($nodeProc.HasExited) {
        $statusItem.Text = "Status: Stopped (exit code $($nodeProc.ExitCode))"
        $notifyIcon.Text = "StreamDash - Stopped"
        $notifyIcon.Icon = [System.Drawing.SystemIcons]::Error
        $timer.Stop()
        return
    }
    if ($shared.ready) {
        $openItem.Text = "Open Dashboard"
        $statusItem.Text = "Status: Running on port $($shared.url.Split(':')[2])"
        $notifyIcon.Text = "StreamDash - Running"

        $notifyIcon.BalloonTipTitle = "StreamDash Started"
        $notifyIcon.BalloonTipText = "Dashboard is running.`nClick here or the tray icon to open."
        $notifyIcon.BalloonTipIcon = "Info"
        $notifyIcon.ShowBalloonTip(4000)

        Start-Process $shared.url
        $timer.Stop()
    }
})
$timer.Start()

# ── Events ─────────────────────────────────────────────────────────
$openItem.Add_Click({ Start-Process $shared.url })

$notifyIcon.Add_Click({
    if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
        Start-Process $shared.url
    }
})

$notifyIcon.Add_BalloonTipClicked({ Start-Process $shared.url })

$exitItem.Add_Click({
    $timer.Stop()
    if (-not $nodeProc.HasExited) {
        $nodeProc.Kill()
    }
    $notifyIcon.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})

# ── Show startup balloon ───────────────────────────────────────────
$notifyIcon.BalloonTipTitle = "StreamDash"
$notifyIcon.BalloonTipText = "Starting server, please wait..."
$notifyIcon.BalloonTipIcon = "Info"
$notifyIcon.ShowBalloonTip(2000)

# ── Run Windows message loop ───────────────────────────────────────
[System.Windows.Forms.Application]::Run()

# ── Cleanup on exit ────────────────────────────────────────────────
$timer.Stop()
$ps.Dispose()
$rs.Close()
if (-not $nodeProc.HasExited) { $nodeProc.Kill() }
$notifyIcon.Visible = $false
