# Frame Studio + Claude (MCP)

Ask Claude to edit your video in plain words, in the **Claude Desktop** app or in **Claude Code**. Claude edits the
timeline while you watch it change in the Frame Studio window, then you keep editing by hand. A Claude Pro
subscription is enough. Frame Studio itself runs only on your computer.

> **בעברית בקצרה:** אחרי ההתקנה פותחים את Claude Desktop ומבקשים, למשל: *"תפתח פרויקט חדש ב-Frame Studio, תכניס את
> הסרטונים מהתיקייה Videos\טיול, תוסיף כתוביות ומוזיקה ותייצא"*. קלוד עורך, ואתם רואים כל שינוי בחלון העורך בזמן אמת.

## How it works

`mcp/server.mjs` is a small MCP server, which is the standard way Claude apps connect to tools. Claude starts it in the
background, and it gives Claude 19 Frame Studio tools: create a project, import your files, edit, look at frames,
export, and more. If Frame Studio is not running, the server starts it.

Claude edits the same way you do. Every change appears live in the editor window together with Claude's short note
about it, and **Undo** (Ctrl+Z) works on Claude's edits too. Claude can also **see** what it made: the `snapshot` tool
sends it real frames of your video, so it can check its own work before exporting.

## What the installer sets up

When `install.cmd` asks **"Connect Frame Studio to Claude?"** and you answer **Y**, it does the following:

- **Claude Desktop**: adds a `frame-studio` entry to `%APPDATA%\Claude\claude_desktop_config.json`. Your other
  settings are kept, and a backup copy of the file is saved first.
- **Claude Code**: installs the Frame Studio skill and registers the MCP server for your user:
  `claude mcp add --scope user frame-studio -- "<node.exe>" "<Frame Studio>\mcp\server.mjs"`. When `claude` is not on
  `PATH`, it uses the copy of Claude Code that came with Claude Desktop (`%APPDATA%\Claude\claude-code\<version>\…\claude.exe`);
  when there is none, it adds the same `frame-studio` entry to `"mcpServers"` in `%USERPROFILE%\.claude.json` itself
  (backup first, everything else kept).

Then **quit Claude completely and open it again**: right-click the Claude icon near the clock and choose **Quit**.
Closing the window is not enough.

## Try it

In Claude Desktop, start a new chat and write something like:

- *"Open Frame Studio and create a 9:16 project called Trip. Import C:\Users\me\Videos\trip1.mp4 and trip2.mp4, cut them
  into a 20-second reel with a whoosh on every cut and a title at the start, then export it."*
- *"In my project my-video, add karaoke captions from the voice-over and make the music quieter under the voice."*
- *"Show me how the video looks at 3 seconds."*

Claude may ask before it uses a Frame Studio tool for the first time. Choose **Allow always** to avoid being asked again.

## Manual setup

You only need this if you did not let the installer connect Claude, or if you moved the Frame Studio folder.
In every example, replace `C:\…\Frame Studio` with your folder (the one that contains `mcp\server.mjs`). If you are not
sure where Node.js is, run `where node` in a terminal.

**Claude Desktop**: open **Settings → Developer → Edit Config** and add this inside the file:

```json
{
  "mcpServers": {
    "frame-studio": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\…\\Frame Studio\\mcp\\server.mjs"]
    }
  }
}
```

If the file already has `"mcpServers"`, add only the `"frame-studio": { … }` part next to the servers already there.
Use double backslashes (`\\`) in the paths. Save the file, then quit and reopen Claude.

**Claude Code**: run this once in a terminal:

```bat
claude mcp add --scope user frame-studio -- "C:\Program Files\nodejs\node.exe" "C:\…\Frame Studio\mcp\server.mjs"
claude mcp list
```

`claude mcp list` should show `frame-studio: ✓ Connected`. Inside Claude Code, the `/mcp` command shows the same thing.

## The tools

| Tool | What it does |
|---|---|
| `frame_studio_status` | Checks that Frame Studio is running and starts it if needed |
| `open_editor` | Opens the editor window so you can watch |
| `list_projects` · `create_project` · `get_project` | Lists, creates and reads projects (tracks, clips, ids, words) |
| `import_media` | Adds your video, image and audio files to a project (single files, or a whole folder) |
| `apply_ops` | The editing tool: clips, text, captions, transitions, effects, keyframes, sound effects… |
| `get_catalog` | Lists the valid transitions, effects, filters, animations, caption styles, fonts… |
| `search_sounds` | Searches your sound-effects library |
| `set_transcript` · `transcribe` | Gets word timings for captions (`transcribe` needs the optional local transcription add-on) |
| `snapshot` | Renders frames and shows them to Claude as images |
| `export_video` · `wait_job` | Exports an MP4 at −14 LUFS, with a check that the voice can be heard over the music |
| `check_audio` · `balance_audio` | Measures speech against background, then fixes it by lowering music and effects only where needed |
| `undo` · `redo` | Steps back or forward through the edit history |
| `get_editing_guide` | The editing guide Claude reads before it starts |

Claude also gets the full reference as a resource (`frame-studio://docs/claude-api`, the same text as
[CLAUDE-API.md](CLAUDE-API.md)), plus an **edit_video** prompt that starts a guided session.
In Claude Desktop you find it in the **+** menu.

## Troubleshooting

| Problem | What to do |
|---|---|
| Claude does not mention Frame Studio, or there is no Frame Studio in the **tools / connectors** menu (the slider icon under the message box) | Quit Claude completely (tray icon → Quit) and open it again. Then check **Settings → Developer**: `frame-studio` should say *running*. |
| Settings → Developer shows **failed** | Open the log `%APPDATA%\Claude\logs\mcp-server-frame-studio.log`. The usual causes are a wrong path to `node.exe` or `server.mjs` (for example after moving the folder: run `install.cmd` again) or Node.js older than 24. |
| "Cannot reach the Frame Studio server" | Open Frame Studio once from its desktop shortcut, then ask again. If another program uses port 7788, see *Settings* below. |
| An export or transcription says **still running** | That is normal for long videos. Claude keeps waiting with `wait_job`. |
| "Local transcription is not installed" | Double-click `tools\install-transcription.cmd` in the Frame Studio folder, or give Claude the exact script text and an ASR file. |
| Claude says the sound library is empty | Add a folder of sound effects in the editor's **Audio** tab (see [library/sounds/README.md](../library/sounds/README.md)). |

To test the server by hand, run `node "C:\…\Frame Studio\mcp\server.mjs"` in a terminal. It should print
`[frame-studio-mcp] … ready` and then wait for input. Press Ctrl+C to stop it. Frame Studio's own log is `server.log`
in the Frame Studio folder.

## Settings (optional)

Set these in the `"env"` block of the MCP entry, for example `"env": { "FRAME_STUDIO_PORT": "7790" }`:

| Variable | Meaning |
|---|---|
| `FRAME_STUDIO_PORT` | Port of the Frame Studio server (default 7788). Set the same port when you start Frame Studio yourself. |
| `FRAME_STUDIO_MCP_WAIT` | Seconds a tool waits for a long job before it answers "still running". Default: 45 in Claude Desktop, 240 in Claude Code. |
| `FRAME_STUDIO_NO_AUTOSTART` | `1` = never start the server automatically. |

## Privacy

Everything runs on your computer: your files are not uploaded anywhere. Claude only sees what the tools send it in
the chat: project details (clip names, text, times), and the frames it asks to look at with `snapshot`.
