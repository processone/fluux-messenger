# Memory Troubleshooting

Guide for diagnosing high memory usage in Fluux Messenger. If the app's memory grows far beyond the ranges below, it is a leak we'd like to fix — please follow the steps in this guide and share the output in a GitHub issue.

## Expected Memory Footprint

Rough ranges on a normal account (roster + ~20 MUC rooms, idle):

| Process / Platform | Typical RSS |
|---|---|
| Tauri main process (Rust) | 100–250 MB |
| WebKitWebProcess / WKWebView / msedgewebview2 (renderer) | 250–600 MB |
| WebKitNetworkProcess | 50–150 MB |

Memory grows when loading long message histories, receiving media, or joining many rooms, but it should stabilize. If the renderer process climbs into **multiple GiB** and keeps growing, that's a leak.

Store caps already in place:

- `MAX_MESSAGES_PER_CONVERSATION = 1000`
- `MAX_MESSAGES_PER_ROOM = 1000`
- `MAX_EVENTS = 500` (activity log)

So a genuine leak is almost always in the UI layer (detached DOM, listeners, blob URLs, render loops) rather than store state.

## Why the Process Stays Running After "Close"

On all platforms, clicking the window **close (X) button hides the window**, it does **not** quit the app. This is intentional — the XMPP connection stays alive so you keep receiving messages, just like other chat apps. To fully quit:

- **macOS**: `⌘Q`, or **Fluux Messenger → Quit** in the menu bar
- **Linux**: system tray icon → **Quit**
- **Windows**: system tray icon → **Quit**

If you've quit explicitly and the process *still* lingers, that's a separate issue — please include it in your bug report.

## Quick Check: What Is Using the Memory?

### Linux

```bash
ps -axo pid,ppid,rss,vsz,comm,args | grep -iE 'fluux|WebKit' | grep -v grep
```

RSS is column 3 (in KB). The leaking process is almost always `WebKitWebProcess`. Note its PID for the next steps.

### macOS

```bash
ps -axo pid,rss,comm | grep -iE 'Fluux|WebKit' | grep -v grep
```

On macOS the renderer process may be named `com.apple.WebKit.WebContent` or appear nested under "Fluux Messenger" in Activity Monitor.

### Windows

Open Task Manager → Details tab → look for `fluux-messenger.exe` and `msedgewebview2.exe`. The large one is the leak.

## Deep Memory Breakdown

### Linux (replace `<PID>` with the renderer PID)

```bash
cat /proc/<PID>/status | grep -E 'Vm|Rss|Threads'
```

```bash
cat /proc/<PID>/smaps_rollup
```

```bash
cat /proc/<PID>/smaps | awk '
  /^[0-9a-f]+-/ { perms=$2; name=$NF }
  /^Rss:/       { printf "%10d KB  %s  %s\n", $2, perms, name }
' | sort -rn | head -20
```

The third command lists the 20 largest memory regions, which reveals whether the bulk is in the JS heap, anonymous mappings, image buffers, or mapped files.

### macOS (replace `<PID>` with the renderer PID)

```bash
# WebKit memory breakdown by region (MALLOC_*, JS heap, etc.)
vmmap <PID> | head -100
```

```bash
# Native allocator summary
heap <PID> | head -30
```

```bash
# Detached objects / potential leaks (slow at multi-GiB heaps)
leaks <PID> | head -50
```

`vmmap` is usually the most revealing: it separates the JavaScriptCore heap, MALLOC zones, image decode buffers, and WebCore compositor layers.

### Windows

PowerShell:

```powershell
Get-Process | Where-Object { $_.ProcessName -match 'fluux|msedgewebview' } |
  Select-Object Id, ProcessName, @{n='RSS_MB';e={[math]::Round($_.WorkingSet64/1MB,1)}}, @{n='Private_MB';e={[math]::Round($_.PrivateMemorySize64/1MB,1)}}
```

For deeper analysis, use **Windows Performance Recorder** or SysInternals **VMMap** (<https://learn.microsoft.com/sysinternals/downloads/vmmap>) targeting the `msedgewebview2.exe` PID.

## Heap Snapshot (most valuable)

A heap snapshot shows which JavaScript objects are holding memory, and which constructors are leaking. Capturing one right after launch and one after the memory has grown makes the leaking objects obvious in a diff.

### Linux — remote WebKit inspector

Quit Fluux, then relaunch with the remote inspector enabled:

```bash
pkill -f fluux-messenger
WEBKIT_INSPECTOR_SERVER=127.0.0.1:9222 fluux-messenger --verbose
```

Open `http://127.0.0.1:9222` in any browser, click the **Fluux Messenger** entry, then:

1. Switch to the **Timelines** tab.
2. Click the gear icon in the top-right → enable the **Memory** instrument (and optionally **JavaScript Allocations**).
3. Click the red record button (●), use Fluux normally for 30–60 seconds, then stop.

### macOS — Safari Web Inspector

WKWebView has no "Memory" tab like Chrome. Use Safari Web Inspector:

1. In Safari, enable **Safari → Settings → Advanced → "Show features for web developers"**.
2. With Fluux running, open **Safari → Develop → [your Mac] → Fluux Messenger**.
   (Or right-click inside Fluux → **Inspect Element**, which works because `devtools` is enabled in `tauri.conf.json`.)
3. Switch to the **Timelines** tab.
4. Click the gear icon → enable the **Memory** instrument.
5. Click ● record, use Fluux for 30–60 seconds, stop, screenshot.

### Windows — Edge DevTools

1. Right-click inside Fluux → **Inspect** (enabled by `devtools: true` in `tauri.conf.json`).
2. Open the **Memory** tab.
3. Take a **Heap snapshot** when Fluux has just started.
4. Use Fluux until memory grows, then take another snapshot.
5. Use the **Comparison** view between the two snapshots — the top constructors by delta size are the leak.

## Exit Hang After Quit

If the process lingers after an explicit Quit (tray menu or ⌘Q), Fluux's graceful-shutdown path may be wedged, typically because the renderer is thrashing from memory pressure.

### Linux / macOS

```bash
# After clicking Quit:
watch -n 1 'ps -axo pid,rss,comm | grep -iE "fluux|WebKit" | grep -v grep'
```

If the process still exists after 10 seconds, that's the bug — include this in your report.

To force-kill if needed:

```bash
# Linux / macOS
pkill -9 -f fluux-messenger
```

### Windows

```powershell
Stop-Process -Name fluux-messenger,msedgewebview2 -Force
```

## Logs to Include in a Bug Report

Logs are written to a daily-rotating file. Paths:

| OS      | Path                                                  |
|---------|-------------------------------------------------------|
| macOS   | `~/Library/Logs/net.processone.fluux/`                |
| Linux   | `~/.local/share/net.processone.fluux/logs/`           |
| Windows | `%APPDATA%\net.processone.fluux\logs\`                |

Package them:

```bash
# macOS
tar czf ~/fluux-logs.tar.gz ~/Library/Logs/net.processone.fluux/

# Linux
tar czf ~/fluux-logs.tar.gz ~/.local/share/net.processone.fluux/logs/
```

```powershell
# Windows
Compress-Archive -Path "$env:APPDATA\net.processone.fluux\logs\*" -DestinationPath "$env:USERPROFILE\fluux-logs.zip"
```

Look in the log for `[renderLoopDetector]` warnings — if they fire during startup or after specific actions, the leak is very likely linked to a render storm.

## What to Include in a Memory Bug Report

Please attach or paste:

1. **Fluux version** (visible in Settings → About, or the top of `fluux.log`).
2. **OS and desktop environment** — e.g. `uname -a`, Wayland vs X11 on Linux, macOS version, Windows build.
3. **Approximate number of rooms joined and roster size.**
4. **Timeline**: roughly how long from launch to reach the high memory value, and whether the growth is steady or spiky.
5. **Output of "Quick Check" and "Deep Memory Breakdown"** from above.
6. **Heap snapshot screenshots or exported snapshots** (ideally baseline + grown).
7. **Compressed logs** (see above).
8. **Any specific action that seems to trigger growth** (scrolling history, opening media, joining a room, sleep/wake cycles, long uptime in tray).

## Workarounds While We Investigate

- **Restart Fluux periodically** — a daily restart keeps memory bounded on affected systems.
- **Quit rather than close** when you won't need messages for a while, so the process fully exits.
- **Leave `backgroundThrottling` enabled in future builds** — on development builds we may ship a flag to re-enable it for users hitting this issue. Track progress in the relevant GitHub issue.
