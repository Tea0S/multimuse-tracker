# Multimuse Tracker
For use with the BRAT Plugin for the best experiance.

An Obsidian plugin for seamless integration with the MultiMuse Discord bot. Track Discord roleplay threads, send messages as muses directly from Obsidian, and automatically sync scene states.

## Features

- ✅ **Automatic Thread Tracking**: Automatically tracks Discord threads linked in your scene files
- ✅ **Import from Tracker**: Auto-create scene notes for threads you `/track add` or that StageHand opens, filed under the Discord server's folder
- ✅ **Send as Muse**: Post selected text as a muse to Discord (command palette, mobile toolbar, or selection menu)
- ✅ **Auto-Detected User ID**: Automatically detects your Discord user ID from your API key (no manual configuration needed)
- ✅ **Scene Creation**: Create new scene files with muse selection, folder organization, and automatic property tracking
- ✅ **Sync from Tracker**: Import tracked threads from the bot and create scene files
- ✅ **Property Tracking**: Automatically adds "Roleplay" and "Is Active?" properties based on folder structure
- ✅ **Configurable Polling**: Automatically checks Discord threads for new replies (5-60 minute intervals). New tracked scenes create notes immediately when auto-create is on.
- ✅ **Frontmatter Updates**: Automatically updates `Replied?` based on thread state. `Participants` is always user-editable (plugin does not overwrite it).

## Installation

Install via the Obsidian plugin library 


OR

Install via [BRAT](https://obsidian.md/plugins?id=obsidian42-brat) with https://github.com/BackstagePassGroup/multimuse-obsidian

## Setup

### 1. Get Your API Key

1. Open Discord DMs with the MultiMuse bot
2. Use the command: `/api generate`
3. Copy the generated API key (starts with `mm_`)

### 2. Configure Plugin

1. Open Obsidian Settings → Multimuse Tracker
2. Paste your API key in the "API Key" field
3. Your Discord user ID will be automatically detected from the API key
4. Adjust paths and property toggles if you want something other than the defaults:
   - **Scenes Folder**: Where scene notes live (default: `RP Scenes`)
   - **Track Roleplay Property** / **Track Is Active? Property**: Match how you want new scenes to get frontmatter (defaults on)
   - **Obsidian Base Path**: Optional. Leave empty for first-time setup (see below), or set to a `.base` or `.md` file you already use
   - **Enable Polling** / **Poll Interval**: How often threads are checked

### 3. First-time vault layout (recommended)

Use a single command to create your scenes folder and a Base aligned with your settings:

1. Open the Command Palette and run **Initialize MultiMuse workspace**
2. The plugin will:
   - Create your **Scenes Folder** in the vault if it does not exist yet
   - If **Obsidian Base Path** is empty, create `<Scenes Folder>/MultiMuse Scenes.base` (native Obsidian Base) and save that path in settings
   - If **Obsidian Base Path** is set to a path ending in `.base` or `.md` that does not exist yet, create that file instead and keep the path as configured

**Native `.base` file:** The generated Base lists markdown files under your scenes folder, filters to **Is Active?** = true when that property toggle is on, and shows columns for `Link`, `Characters`, optional `Roleplay` / `Is Active?`, `Participants`, `Replied?`, and `Created`. Requires an Obsidian version that supports **Bases**.

**Markdown `.md` tracker:** If your Base path ends in `.md`, the command creates a starter pipe table. The plugin can append rows to that table when you create or sync scenes (it does not edit `.base` files programmatically; use the Base UI for those).

You can run **Initialize MultiMuse workspace** again only after removing or renaming the target file, or after changing **Obsidian Base Path**.

## Usage

### Creating New Scenes

1. Use the command **"Create New Scene"** (Command Palette or ribbon button)
2. Select a muse from the list
3. Enter the Discord thread/channel URL
4. Select the folder location (or create a new one)
5. Enter the scene name
6. Set the number of participants
7. The scene file will be created with all necessary frontmatter

### Syncing from Tracker

1. Turn on **Auto-create notes from tracker** in settings (off by default)
2. The next poll snapshots your current tracker so **existing history is not imported**
3. After that, new `/track add` threads and StageHand scene opens get a note under `RP Scenes/<server folder>/` (on the next poll, or immediately if live events are connected)
4. Use **Import unfiled tracked scenes** for threads that are already open and not in the vault yet
5. Map Discord servers to folders in **Server folders** (use **Load servers from tracker** if the list is empty). Nested folders (months, partners, plot) stay manual — move the note after it is created

**Import unfiled tracked scenes** creates notes only for **open, unarchived** Discord threads that are not already in the vault. Ended or archived tracks are skipped.

### Sending Messages as Muse

1. Open a scene file in **Editing** view (not Reading)
2. Select the text you want to send
3. Run **Send as Muse** from the Command Palette, the editor selection menu, or the mobile toolbar
4. If multiple characters are in the frontmatter, select which muse to post as
5. The message will be posted to the Discord thread

On **mobile**, add **Send as Muse** and **Insert @ mention** to the toolbar: open a note in Editing view, then Settings → Toolbar (or Mobile → Configure toolbar) and add those commands. They only appear in that list because they are editor commands.

### Scene File Format

Your scene files should have frontmatter like this:

```markdown
---
Link: https://discord.com/channels/123456789/987654321/111222333444555666
Characters:
  - Bel
  - Another Character
Roleplay: For The Greeks
Participants: 2
Replied?: false
Is Active?: true
Created: 2024-01-15
---

[Scene content here]
```

**Required fields:**
- `Link`: Full Discord thread URL
- `Characters`: Array of character/muse names (used for "Send as Muse")

**Auto-updated fields:**
- `Replied?`: Automatically updated by the plugin (true = you replied, false = need to reply). Participants is not overwritten—you can always edit it in frontmatter.

**Auto-added fields (if enabled in settings):**
- `Roleplay`: Extracted from folder path (e.g., "For The Greeks" from "RP Scenes/For The Greeks/Twin Flames")
- `Is Active?`: Automatically set to `true` for new scenes

## Commands

- **Initialize MultiMuse workspace**: Create your **Scenes Folder** and a Base (`.base`) or markdown tracker (`.md`) from settings; sets **Obsidian Base Path** when you start with it empty
- **Check Discord Threads Now**: Manually trigger a check for all scenes
- **Toggle Discord Polling**: Enable/disable automatic polling
- **Create New Scene**: Create a new scene file with muse selection
- **Import unfiled tracked scenes**: Create notes for open (unarchived) tracked threads that do not already have a scene file
- **Send as Muse**: Post the selected text to the Discord thread as a muse
- **Insert @ mention**: Insert a Discord `<@userId>` mention at the cursor
- **Sync from Tracker**: Sync scenes from bot tracker to Obsidian

## Settings

### Core Settings
- **Enable Polling**: Turn automatic checking on/off
- **API Key**: Your MultiMuse API key (auto-detects user ID)
- **Poll Interval**: How often to check (5-60 minutes)
- **Scenes Folder**: Folder containing your scene files
- **Obsidian Base Path**: Optional path to Base file for scene tracking
- **Auto-create notes from tracker**: After you opt in, only *new* tracks/StageHand opens get notes (not existing history)
- **Server folders**: Discord server → folder under your scenes folder

### Scene Properties
- **Track Roleplay Property**: Automatically add "Roleplay" property from folder path
- **Track Is Active? Property**: Automatically add "Is Active?" property (defaults to true)

### Read-Only Information
- **Detected User ID**: Your Discord user ID (automatically detected from API key)

## How It Works

### Thread Tracking

1. The plugin scans all `.md` files in your scenes folder
2. For each file with a `Link` and `Characters` field in frontmatter:
   - Extracts the Discord thread ID from the URL
   - Queries the MultiMuse API for thread state
   - Updates `Replied?` field only (true = you replied, false = need to reply). Participants is left as-is so you can always change it.

### Send as Muse

1. Selected text is extracted from the editor
2. Frontmatter is read to get `Link` and `Characters`
3. Thread ID is extracted from the Discord URL
4. If multiple characters, a selection modal appears
5. Configured muse **headers** and **footers** (server/channel presets from `/muse header` and `/muse footer`) are resolved and prepended/appended when the message fits in one Discord post
6. Message is posted via the MultiMuse API (long posts are split server-side; wrappers apply on the first/last chunk automatically)

### Scene Creation

1. Muse is selected from available muses (fetched from API)
2. Discord thread URL is validated
3. Folder location is selected (with context showing which muse)
4. Scene file is created with frontmatter
5. Scene is registered with the MultiMuse API
6. File is marked as "recently created" to prevent immediate state updates

## Troubleshooting

### "API authentication failed" error
- Make sure your API key is correct (starts with `mm_`)
- Verify the API key was generated using `/api generate` in Discord
- Check that the API key hasn't been revoked

### "Failed to get user ID from API key"
- Verify your API key is valid
- Check your internet connection
- Ensure the MultiMuse bot API is accessible

### "Muse not found or not accessible"
- Make sure the muse name in your frontmatter matches exactly (case-insensitive)
- Verify the muse exists in Discord
- Check that the muse is owned by you or shared with you

### New tracker scenes are not creating notes
- **Auto-create notes from tracker** must stay on (it no longer turns itself off after a reload)
- Existing open threads are never dumped into the vault automatically — use **Import unfiled tracked scenes** for those
- Auto-create still runs if Discord polling is off. While it is on, the plugin also checks for new tracks about once a minute.

### Files not updating
- Check that your scene files have `Link` and `Characters` fields in frontmatter
- Verify the link contains a valid Discord thread URL
- Make sure polling is enabled
- Check the console (Ctrl+Shift+I) for errors

### "Send as Muse" not working
- Use **Editing** view (pencil), not Reading view
- Select the text first, then run the command (Command Palette, toolbar, or selection menu)
- On mobile, add **Send as Muse** to the editor toolbar — it will not appear in that list until this plugin version (1.12.6+)
- Verify the file has `Link` and `Characters` in frontmatter
- Check that the selected muse exists and is accessible
- Verify your API key is configured correctly

### Scenes marked as "Replied?" incorrectly
- Polling copies the Discord tracker: checked means you already posted, unchecked means it is your turn
- Newly created scenes are protected from immediate updates for 60 seconds
- If a note is open in Properties, reload the plugin after updating so the checkbox can refresh

### Rate Limiting
- Discord API has rate limits
- If you hit limits, increase the poll interval
- The plugin handles rate limits gracefully

## Privacy & Security

- Your API key is stored locally in Obsidian's settings
- The plugin only accesses threads you've linked in your scene files
- All communication goes through the MultiMuse bot API
- User ID is automatically detected from API key (no manual entry needed)
- No data is sent to external servers except the MultiMuse bot API


## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT

## Credits

- **Author**: BackstagePass Group
- **Plugin**: Multimuse Tracker
