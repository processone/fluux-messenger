# Troubleshooting

## Related Guides

- [Memory Troubleshooting](MEMORY_TROUBLESHOOTING.md) — diagnosing high memory usage and renderer leaks.

## Log Files

Fluux writes daily-rotating log files (`fluux.log`) automatically. These are useful for diagnosing connection issues, crashes, or unexpected behavior.

### Default Log Locations

| OS      | Path                                                  |
|---------|-------------------------------------------------------|
| macOS   | `~/Library/Logs/net.processone.fluux/`                |
| Linux   | `~/.local/share/net.processone.fluux/logs/`           |
| Windows | `%APPDATA%\net.processone.fluux\logs\`                |

You can also open the log directory from the app menu: **Reveal Logs in Finder** (macOS) or **Open Logs Folder** (Windows).

### Overriding the Log Directory

Use the `--log-file=PATH` command-line option to write logs to a custom location:

```bash
fluux-messenger --log-file=/tmp/fluux-debug/fluux.log
```

### Verbose Logging

For more detailed output on stderr:

```bash
fluux-messenger --verbose          # Verbose logging (no XMPP traffic)
fluux-messenger --verbose=xmpp    # Verbose logging including XMPP packets
```

You can also set the `RUST_LOG` environment variable to override the log filter:

```bash
RUST_LOG=debug fluux-messenger
```
