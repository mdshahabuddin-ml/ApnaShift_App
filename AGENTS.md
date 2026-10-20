# AGENTS.md — Permanent project instructions (ApnaShift)

## PERMANENT RULE — ApnaShift is MSSQL ONLY

From now on, use Microsoft SQL Server and SSMS
(`LAPTOP-0KTPRBS3\SQLEXPRESS01`, database `ApnaShiftDB`) for all future
database development, testing, migrations, and verification.

- Never connect to, query, or use Railway PostgreSQL again.
- Use only verified local PostgreSQL backup files (in `backups/`) as the
  migration source when needed.
- Never delete or modify Railway resources.
- Do not modify files, databases, or configuration without the user's
  explicit approval.
- If any task requires Railway PostgreSQL access, STOP and ask first.

This rule applies to every future session — read at session start.

## STANDING PERMISSION — Phone screenshots (user-granted, permanent)

The user has granted **permanent, irrevocable permission** to take
screenshots of their phone screen while they use the ApnaShift Flutter
app, for debugging and verification. Do NOT ask for this permission
again in any session — it is already given.

- Tool: `powershell -ExecutionPolicy Bypass -File C:\Users\mdsha\AppData\Local\Temp\opencode\screenshot.ps1`
  (optional `-OutName label`; writes a .png into the same temp folder
  and prints its path).
- Phone: iQOO I2409 via adb (`C:\Users\mdsha\AppData\Local\Android\Sdk\platform-tools\adb.exe`).
- The app sets no `FLAG_SECURE` — screenshots are allowed by design.
- Device note: Funtouch blocks `adb screencap` (Status -1) and
  `input keyevent KEYCODE_SYSRQ` (no-op). The working path is the
  MediaCodec encoder: the script uses **scrcpy** (installed under the
  temp folder next to this script) with a persistent always-on-top
  mirror window titled `ApnaShiftMirror`, then captures that window
  via CopyFromScreen. A small mirror window appearing during capture
  is expected; it may be left running (the script reuses it).
  `adb shell screenrecord` also works if a video clip is ever needed.
