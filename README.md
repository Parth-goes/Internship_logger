# Internship Work Logger

A lightweight, offline-capable daily work diary inspired by Google Classroom — built with vanilla HTML, CSS, and JavaScript. Zero dependencies, zero build tools, zero backend.

## Features

- **Daily log cards** with date, auto-derived day, rich text description, tags, and file attachments
- **Rich text editor** with bold, italic, underline, lists, headings, and links
- **File attachments** stored in IndexedDB — PDFs, images, DOCX, code files, ZIPs
- **Image thumbnails** generated client-side
- **Search & tag filtering** across all entries
- **Export** as JSON (with files), Markdown, or CSV
- **Import** from a previously exported JSON backup
- **Dark mode** with system preference detection
- **Offline-capable** via Service Worker (cache-first strategy)
- **Auto-save drafts** to localStorage
- **Keyboard shortcuts**: `N` → new entry · `Ctrl+S` → save · `Ctrl+F` → search · `Esc` → close

## Project Structure

```
internship-logger/
├── index.html   — App shell, all markup
├── styles.css   — Design tokens, Material-inspired UI, dark mode
├── script.js    — All logic: IndexedDB, CRUD, export/import, themes, SW
├── sw.js        — Service Worker for offline support
└── README.md
```

## Deploying to GitHub Pages

1. **Create a new GitHub repository** (e.g. `internship-logger`).

2. **Upload all four files** (`index.html`, `styles.css`, `script.js`, `sw.js`) to the repository root.

3. Go to **Settings → Pages** in your repository.

4. Under **Source**, select `Deploy from a branch`.

5. Choose the `main` branch, folder `/` (root), and click **Save**.

6. After ~60 seconds, your app will be live at:
   ```
   https://<your-username>.github.io/<repository-name>/
   ```

> **HTTPS is required** for Service Workers (and therefore offline support). GitHub Pages serves over HTTPS by default — no extra config needed.

## Local Development

No build step needed. Simply open `index.html` in a browser:

```bash
# Using Python's built-in server (recommended for SW to register correctly)
python3 -m http.server 8080
# Then open http://localhost:8080
```

Or use the [Live Server](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer) extension in VS Code.

> The Service Worker requires a server context (localhost or HTTPS). Opening `index.html` directly via `file://` will work for all features except offline caching.

## Data & Storage

| Data type    | Storage          | Notes                              |
|--------------|------------------|------------------------------------|
| Entry text   | IndexedDB        | HTML content + plain text index    |
| Attached files | IndexedDB      | Stored as ArrayBuffer, up to 50 MB per file |
| Theme pref   | localStorage     | `"light"` or `"dark"`              |
| Draft        | localStorage     | Auto-cleared on save or cancel     |

All data lives entirely in the **browser** — nothing is ever sent to a server.

## Backup & Recovery

Use **Export → JSON** to create a full backup (includes all entries and file data). Use **Import** to restore from that backup on any device or browser.

## Browser Support

Any modern browser with IndexedDB and CSS custom properties support:

- Chrome/Edge 88+
- Firefox 85+
- Safari 14+

## License

MIT — free to use, modify, and self-host.
