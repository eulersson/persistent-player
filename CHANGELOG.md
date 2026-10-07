# Changelog

## 1.0.3

- Phones: the now-playing bar no longer sits under the notch / status bar or a floating view header, where it couldn't be tapped.
- Seeking uses pointer events, so dragging the progress track works with touch.
- Larger touch targets on mobile, and the close button is always visible (there is no hover on touch screens).

## 1.0.2

- Use `createSpan` for the time label instead of `createEl("span", ...)`.

## 1.0.1

- Use Obsidian's `createEl` and `createDiv` helpers instead of `document.createElement`.

## 1.0.0

- Initial release.
- Audio keeps playing when its embed is scrolled out of view.
- Remembers the playback position per note.
- Now-playing bar with play/pause, 5-second skip, draggable seek, and speed cycling.
