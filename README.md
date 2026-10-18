# Persistent Player

Persistent Player keeps an audio embed playing when you scroll it out of view. Play an audio file in a note, then keep reading, editing, or scrolling: the sound continues from a compact player pinned to the bottom of the view, and the position is remembered per note.

No network requests, no telemetry. Everything runs locally inside the vault.

## Usage

Play any embedded audio file as you normally would. Instead of the inline embed, Persistent Player takes over playback with a now-playing bar at the bottom of the view:

- **Play or pause** the current audio.
- **Skip back or forward 5 seconds** for quick re-listening.
- **Drag the progress track** to seek anywhere in the file.
- **Click the speed label** to cycle through 0.5x, 0.75x, 1x, 1.25x, 1.5x, and 2x.
- **Click the note name** (shown when you're on another page) to go back to the audio's note.
- **Close** to stop playback and release the note's audio.

The embed in the note follows along: its scrubber shows the playback position, and dragging it seeks. Scrolling the embed out of view does not interrupt playback, and neither does opening another note or page: the bar follows you. Playing an embed in another note takes over, and the player remembers each note's position, so returning to a note picks up where you left off.

On desktop the bar sits above the status bar, unless a theme hides the status bar (such as Minimal's focus mode).

Video embeds are left untouched and play natively.

### Commands

The following commands are available from the command palette. Bind your own hotkeys in **Settings -> Hotkeys**:

- Play or pause
- Skip back 5 seconds
- Skip forward 5 seconds
- Skip back 15 seconds
- Skip forward 15 seconds

## Build

```bash
npm install
npm run build
```

The build runs TypeScript and Obsidian's official ESLint rules before producing `main.js`.

Copy `manifest.json`, `main.js`, and `styles.css` into `<vault>/.obsidian/plugins/persistent-player/`, then enable Persistent Player in Obsidian.

## Development

The source uses the official Obsidian API and keeps `obsidian` external during the esbuild bundle. Run `npm install`, then `npm run dev` to rebuild on change. `npm run check` runs the linter, the type checker, and a production build.

## License

MIT
