/**
 * ═══════════════════════════════════════════════════════════
 *  INTERNSHIP WORK LOGGER — script.js
 *  Offline-capable · IndexedDB · No dependencies
 * ═══════════════════════════════════════════════════════════
 *
 *  Architecture:
 *  1.  DB  – IndexedDB wrapper (entries + files stores)
 *  2.  App – Central state + init
 *  3.  UI  – Render helpers
 *  4.  Modal – Add/Edit modal logic
 *  5.  Detail – Read-only expand view
 *  6.  Search – Filter logic
 *  7.  Export/Import – JSON · Markdown · CSV
 *  8.  Theme – Dark/light toggle
 *  9.  Toast – Notification system
 * 10.  Keyboard – Global shortcuts
 */

'use strict';

/* ═══════════════════════════════════════════
   1. INDEXEDDB WRAPPER
════════════════════════════════════════════ */
const DB = (() => {
  const DB_NAME    = 'InternshipLogger';
  const DB_VERSION = 2;
  let _db = null;

  /** Open (or upgrade) the database */
  function open() {
    return new Promise((resolve, reject) => {
      if (_db) { resolve(_db); return; }

      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;

        // ── entries store ──────────────────────
        if (!db.objectStoreNames.contains('entries')) {
          const store = db.createObjectStore('entries', { keyPath: 'id' });
          store.createIndex('date', 'date', { unique: false });
        }

        // ── files store (Blob/ArrayBuffer per file) ──
        if (!db.objectStoreNames.contains('files')) {
          db.createObjectStore('files', { keyPath: 'id' });
        }
      };

      req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  /** Perform an IDB transaction and return a promise */
  function tx(storeName, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store       = transaction.objectStore(storeName);
      const req         = fn(store);
      transaction.oncomplete = () => resolve(req ? req.result : undefined);
      transaction.onerror    = (e) => reject(e.target.error);
    }));
  }

  /* ── Entry CRUD ─────────────────────────── */

  function getAllEntries() {
    return open().then(db => new Promise((resolve, reject) => {
      const store   = db.transaction('entries', 'readonly').objectStore('entries');
      const req     = store.getAll();
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e.target.error);
    }));
  }

  function saveEntry(entry) {
    return tx('entries', 'readwrite', store => store.put(entry));
  }

  function deleteEntry(id) {
    return tx('entries', 'readwrite', store => store.delete(id));
  }

  /* ── File CRUD ──────────────────────────── */

  function saveFile(fileObj) {
    // fileObj: { id, entryId, name, size, type, data (ArrayBuffer) }
    return tx('files', 'readwrite', store => store.put(fileObj));
  }

  function getFile(id) {
    return open().then(db => new Promise((resolve, reject) => {
      const store   = db.transaction('files', 'readonly').objectStore('files');
      const req     = store.get(id);
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e.target.error);
    }));
  }

  function getFilesForEntry(entryId) {
    return open().then(db => new Promise((resolve, reject) => {
      const store   = db.transaction('files', 'readonly').objectStore('files');
      const req     = store.getAll();
      req.onsuccess = (e) => resolve(e.target.result.filter(f => f.entryId === entryId));
      req.onerror   = (e) => reject(e.target.error);
    }));
  }

  function getAllFiles() {
    return open().then(db => new Promise((resolve, reject) => {
      const store   = db.transaction('files', 'readonly').objectStore('files');
      const req     = store.getAll();
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e.target.error);
    }));
  }

  function deleteFile(id) {
    return tx('files', 'readwrite', store => store.delete(id));
  }

  function deleteFilesForEntry(entryId) {
    return getFilesForEntry(entryId).then(files =>
      Promise.all(files.map(f => deleteFile(f.id)))
    );
  }

  return { getAllEntries, saveEntry, deleteEntry,
           saveFile, getFile, getFilesForEntry, getAllFiles,
           deleteFile, deleteFilesForEntry };
})();


/* ═══════════════════════════════════════════
   2. APP STATE
════════════════════════════════════════════ */
const App = {
  entries:         [],   // all entries (sorted newest first)
  filteredEntries: [],   // currently displayed
  currentEntryId:  null, // entry being edited
  pendingFiles:    [],   // { id, name, size, type, dataPromise } staged for save
  deletedFileIds:  [],   // files to remove on save (edit mode)
  searchQuery:     '',
  activeTag:       '',

  /** Load everything from IDB and render */
  async init() {
    await this.loadEntries();
    Theme.init();
    bindEvents();
    this.render();
    restoreDraft();
    registerServiceWorker();
  },

  async loadEntries() {
    this.entries = await DB.getAllEntries();
    // Sort newest date first
    this.entries.sort((a, b) => (b.date > a.date ? 1 : -1));
    this.filteredEntries = [...this.entries];
  },

  /** Re-render the card grid + stats */
  render() {
    UI.renderStats();
    UI.renderGrid(this.filteredEntries);
    UI.renderTagChips(this.entries);
  },

  /** Apply current search+tag filter */
  applyFilter() {
    const q   = this.searchQuery.toLowerCase().trim();
    const tag = this.activeTag;

    this.filteredEntries = this.entries.filter(e => {
      const textMatch = !q ||
        e.date.includes(q) ||
        (e.contentText || '').toLowerCase().includes(q) ||
        (e.tags || []).some(t => t.toLowerCase().includes(q));

      const tagMatch = !tag || (e.tags || []).includes(tag);

      return textMatch && tagMatch;
    });

    UI.renderGrid(this.filteredEntries);
    UI.renderStats();
  }
};


/* ═══════════════════════════════════════════
   3. UI HELPERS
════════════════════════════════════════════ */
const UI = {

  /** Render the card grid */
  renderGrid(entries) {
    const grid         = document.getElementById('card-grid');
    const emptyState   = document.getElementById('empty-state');
    const noResults    = document.getElementById('no-results-state');

    grid.innerHTML = '';

    const hasEntries = App.entries.length > 0;
    const hasResults = entries.length > 0;

    emptyState.hidden = hasEntries || App.searchQuery !== '' || App.activeTag !== '';
    noResults.hidden  = hasResults || !hasEntries;

    entries.forEach(entry => {
      const card = this.createCard(entry);
      card.setAttribute('role', 'listitem');
      grid.appendChild(card);
    });
  },

  /** Build a single card element */
  createCard(entry) {
    const dayShort = this.getDayShort(entry.date);  // "Mon", "Tue", …
    const el       = document.createElement('article');
    el.className   = 'card';
    el.dataset.id  = entry.id;

    // Strip HTML for plain preview
    const tmpDiv       = document.createElement('div');
    tmpDiv.innerHTML   = entry.content || '';
    const previewText  = (tmpDiv.textContent || '').slice(0, 200);

    const fileCount    = (entry.fileIds || []).length;
    const tagsHtml     = (entry.tags || []).map(t =>
      `<span class="tag">${escHtml(t)}</span>`
    ).join('');

    el.innerHTML = `
      <div class="card__strip"></div>
      <div class="card__body">
        <div class="card__meta">
          <span class="card__date">${formatDate(entry.date)}</span>
          <span class="card__day-badge badge--${dayShort}">${dayShort}</span>
        </div>
        <div class="card__preview">${previewText || '<em style="opacity:.5">No description</em>'}</div>
        ${tagsHtml ? `<div class="tag-row">${tagsHtml}</div>` : ''}
      </div>
      <div class="card__footer">
        <span class="card__attach-count">
          <span class="material-icons-round">attach_file</span>
          ${fileCount} file${fileCount !== 1 ? 's' : ''}
        </span>
        <div class="card__actions">
          <button class="icon-btn btn-expand" aria-label="View entry for ${formatDate(entry.date)}" title="View">
            <span class="material-icons-round">open_in_full</span>
          </button>
          <button class="icon-btn btn-edit" aria-label="Edit entry for ${formatDate(entry.date)}" title="Edit">
            <span class="material-icons-round">edit</span>
          </button>
          <button class="icon-btn btn-delete" aria-label="Delete entry for ${formatDate(entry.date)}" title="Delete">
            <span class="material-icons-round">delete_outline</span>
          </button>
        </div>
      </div>`;

    // Events
    el.querySelector('.btn-expand').addEventListener('click', () => Detail.open(entry.id));
    el.querySelector('.btn-edit').addEventListener('click',   () => Modal.open(entry.id));
    el.querySelector('.btn-delete').addEventListener('click', () => Confirm.show(entry.id));

    return el;
  },

  /** Render tag filter chips */
  renderTagChips(entries) {
    const container = document.getElementById('filter-chips');
    // Collect all unique tags
    const tagSet = new Set();
    entries.forEach(e => (e.tags || []).forEach(t => tagSet.add(t)));

    container.innerHTML = '';
    tagSet.forEach(tag => {
      const chip       = document.createElement('button');
      chip.className   = 'chip' + (App.activeTag === tag ? ' active' : '');
      chip.textContent = '#' + tag;
      chip.setAttribute('aria-pressed', App.activeTag === tag ? 'true' : 'false');
      chip.addEventListener('click', () => {
        App.activeTag = App.activeTag === tag ? '' : tag;
        App.applyFilter();
        UI.renderTagChips(App.entries); // refresh active state
      });
      container.appendChild(chip);
    });
  },

  /** Stats ribbon */
  renderStats() {
    const total  = App.filteredEntries.length;
    const allTags = new Set(App.entries.flatMap(e => e.tags || []));
    const totalFiles = App.entries.reduce((s, e) => s + (e.fileIds || []).length, 0);

    document.getElementById('stat-total').textContent =
      total === App.entries.length
        ? `${total} entr${total !== 1 ? 'ies' : 'y'}`
        : `${total} / ${App.entries.length} entries`;

    document.getElementById('stat-files').textContent =
      `${totalFiles} file${totalFiles !== 1 ? 's' : ''}`;

    document.getElementById('stat-tags').textContent =
      `${allTags.size} tag${allTags.size !== 1 ? 's' : ''}`;
  },

  /** Format YYYY-MM-DD → "15 Jan 2025" */
  getDayShort(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
  },

  /** File type helpers */
  fileIcon(type, name) {
    if (type.startsWith('image/'))        return { cls: 'file-item__icon--img',  label: 'IMG' };
    if (type === 'application/pdf')       return { cls: 'file-item__icon--pdf',  label: 'PDF' };
    if (type.includes('word') || name.endsWith('.docx') || name.endsWith('.doc'))
                                          return { cls: 'file-item__icon--doc',  label: 'DOC' };
    if (type.includes('zip') || type.includes('gzip') || type.includes('tar'))
                                          return { cls: 'file-item__icon--zip',  label: 'ZIP' };
    const codeExts = ['.js','.ts','.py','.java','.html','.css','.json','.jsx','.tsx','.php','.rb','.go','.rs','.c','.cpp','.cs'];
    if (codeExts.some(ext => name.toLowerCase().endsWith(ext)))
                                          return { cls: 'file-item__icon--code', label: 'CODE' };
    return { cls: 'file-item__icon--txt', label: 'TXT' };
  },

  /** Build a file item <li> element
   *  @param {object}  fMeta – { id, name, size, type }
   *  @param {boolean} removable – show remove button
   *  @param {function} onRemove
   *  @param {function} onDownload
   */
  createFileItem(fMeta, removable, onRemove, onDownload) {
    const li        = document.createElement('li');
    li.className    = 'file-item';
    li.dataset.fid  = fMeta.id;

    const icon = this.fileIcon(fMeta.type || '', fMeta.name || '');

    li.innerHTML = `
      <div class="file-item__icon ${icon.cls}">${icon.label}</div>
      <div class="file-item__info">
        <div class="file-item__name" title="${escHtml(fMeta.name)}">${escHtml(fMeta.name)}</div>
        <div class="file-item__size">${formatBytes(fMeta.size)}</div>
      </div>
      <div class="file-item__actions">
        ${onDownload ? `<button class="icon-btn btn-dl" aria-label="Download ${escHtml(fMeta.name)}" title="Download"><span class="material-icons-round">download</span></button>` : ''}
        ${removable  ? `<button class="icon-btn btn-rm" aria-label="Remove ${escHtml(fMeta.name)}" title="Remove"><span class="material-icons-round">close</span></button>` : ''}
      </div>`;

    // Load image thumbnail asynchronously
    if ((fMeta.type || '').startsWith('image/') && fMeta.id) {
      DB.getFile(fMeta.id).then(f => {
        if (!f) return;
        const url = URL.createObjectURL(new Blob([f.data], { type: f.type }));
        const iconEl = li.querySelector('.file-item__icon');
        iconEl.innerHTML = `<img src="${url}" alt="${escHtml(fMeta.name)}" />`;
      });
    }

    if (onDownload) li.querySelector('.btn-dl')?.addEventListener('click', onDownload);
    if (removable)  li.querySelector('.btn-rm')?.addEventListener('click', () => onRemove(fMeta.id, li));

    return li;
  }
};


/* ═══════════════════════════════════════════
   4. ADD / EDIT MODAL
════════════════════════════════════════════ */
const Modal = {
  isOpen: false,

  /** Open modal. Pass entryId to edit, or null for new */
  async open(entryId = null) {
    this.isOpen = true;
    App.currentEntryId  = entryId;
    App.pendingFiles    = [];
    App.deletedFileIds  = [];

    const overlay    = document.getElementById('modal-overlay');
    const titleEl    = document.getElementById('modal-title');
    const dateInput  = document.getElementById('entry-date');
    const dayInput   = document.getElementById('entry-day');
    const editor     = document.getElementById('editor-content');
    const tagsInput  = document.getElementById('entry-tags');
    const fileList   = document.getElementById('file-list');

    // Reset
    editor.innerHTML  = '';
    tagsInput.value   = '';
    fileList.innerHTML= '';

    if (entryId) {
      // Edit mode
      titleEl.textContent = 'Edit Entry';
      const entry = App.entries.find(e => e.id === entryId);
      if (entry) {
        dateInput.value    = entry.date;
        dayInput.value     = getFullDay(entry.date);
        editor.innerHTML   = entry.content || '';
        tagsInput.value    = (entry.tags || []).join(', ');

        // Populate existing files
        const files = await DB.getFilesForEntry(entryId);
        files.forEach(f => {
          const li = UI.createFileItem(
            { id: f.id, name: f.name, size: f.size, type: f.type },
            true,
            (fid, li) => { App.deletedFileIds.push(fid); li.remove(); },
            () => downloadFile(f)
          );
          fileList.appendChild(li);
        });
      }
    } else {
      // New mode
      titleEl.textContent = 'New Entry';
      dateInput.value     = today();
      dayInput.value      = getFullDay(today());
    }

    document.getElementById('fab-add').classList.add('open');
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    setTimeout(() => dateInput.focus(), 100);
  },

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    document.getElementById('modal-overlay').hidden = true;
    document.getElementById('fab-add').classList.remove('open');
    document.body.style.overflow = '';
    App.currentEntryId = null;
    App.pendingFiles   = [];
    App.deletedFileIds = [];
    clearDraft();
    document.getElementById('draft-indicator').textContent = '';
  },

  async save() {
    const dateInput  = document.getElementById('entry-date');
    const editor     = document.getElementById('editor-content');
    const tagsInput  = document.getElementById('entry-tags');

    const date = dateInput.value;
    if (!date) { Toast.show('Please select a date.', 'error'); return; }

    const content     = editor.innerHTML.trim();
    const contentText = editor.textContent.trim();
    if (!contentText) { Toast.show('Work description is required.', 'error'); editor.focus(); return; }

    const tags = tagsInput.value
      .split(',')
      .map(t => t.trim().toLowerCase())
      .filter(Boolean);

    const id = App.currentEntryId || `entry_${Date.now()}`;

    // Collect existing fileIds (not deleted)
    let existingFileIds = [];
    if (App.currentEntryId) {
      const existingFiles = await DB.getFilesForEntry(App.currentEntryId);
      existingFileIds = existingFiles
        .filter(f => !App.deletedFileIds.includes(f.id))
        .map(f => f.id);

      // Delete removed files
      await Promise.all(App.deletedFileIds.map(fid => DB.deleteFile(fid)));
    }

    // Save pending files
    const newFileIds = [];
    for (const pf of App.pendingFiles) {
      try {
        const data = await pf.dataPromise;
        await DB.saveFile({ id: pf.id, entryId: id, name: pf.name, size: pf.size, type: pf.type, data });
        newFileIds.push(pf.id);
      } catch (err) {
        console.error('File save error', err);
        Toast.show(`Could not save file: ${pf.name}`, 'error');
      }
    }

    const fileIds = [...existingFileIds, ...newFileIds];

    const entry = { id, date, content, contentText, tags, fileIds, updatedAt: Date.now() };
    await DB.saveEntry(entry);

    // Refresh state
    await App.loadEntries();
    App.applyFilter();
    this.close();

    const verb = App.currentEntryId ? 'updated' : 'saved';
    Toast.show(`Entry ${verb} for ${formatDate(date)}.`, 'success');
  }
};


/* ═══════════════════════════════════════════
   5. DETAIL VIEW
════════════════════════════════════════════ */
const Detail = {
  entryId: null,

  async open(entryId) {
    this.entryId = entryId;
    const entry  = App.entries.find(e => e.id === entryId);
    if (!entry) return;

    const dayShort = UI.getDayShort(entry.date);

    document.getElementById('detail-title').textContent = formatDate(entry.date);
    const dayBadge = document.getElementById('detail-day');
    dayBadge.textContent  = getFullDay(entry.date);
    dayBadge.className    = `detail-day-badge badge--${dayShort}`;

    document.getElementById('detail-content').innerHTML = entry.content || '';

    // Tags
    const tagsEl    = document.getElementById('detail-tags');
    tagsEl.innerHTML = (entry.tags || []).map(t =>
      `<span class="tag">${escHtml(t)}</span>`
    ).join('');

    // Files
    const filesEl   = document.getElementById('detail-files');
    filesEl.innerHTML = '';
    const files     = await DB.getFilesForEntry(entryId);

    if (files.length > 0) {
      const heading    = document.createElement('p');
      heading.className = 'detail-files-heading';
      heading.textContent = `${files.length} Attachment${files.length !== 1 ? 's' : ''}`;
      filesEl.appendChild(heading);

      files.forEach(f => {
        const li = UI.createFileItem(
          { id: f.id, name: f.name, size: f.size, type: f.type },
          false,
          null,
          () => downloadFile(f)
        );
        filesEl.appendChild(li);
      });
    }

    document.getElementById('detail-overlay').hidden = false;
    document.body.style.overflow = 'hidden';
  },

  close() {
    document.getElementById('detail-overlay').hidden = true;
    document.body.style.overflow = '';
    this.entryId = null;
  }
};


/* ═══════════════════════════════════════════
   6. SEARCH
════════════════════════════════════════════ */
const Search = {
  toggle(force) {
    const bar       = document.getElementById('search-bar');
    const input     = document.getElementById('search-input');
    const isOpen    = bar.classList.contains('open');
    const open      = force !== undefined ? force : !isOpen;

    bar.classList.toggle('open', open);
    bar.setAttribute('aria-hidden', String(!open));

    if (open) {
      setTimeout(() => input.focus(), 200);
    } else {
      App.searchQuery = '';
      input.value = '';
      App.activeTag = '';
      App.applyFilter();
      UI.renderTagChips(App.entries);
    }
  }
};


/* ═══════════════════════════════════════════
   7. EXPORT / IMPORT
════════════════════════════════════════════ */
const ExportImport = {

  async exportJSON() {
    const entries = await DB.getAllEntries();
    const files   = await DB.getAllFiles();

    // Encode file data as base64 for JSON portability
    const filesExport = files.map(f => ({
      id:      f.id,
      entryId: f.entryId,
      name:    f.name,
      size:    f.size,
      type:    f.type,
      data:    arrayBufferToBase64(f.data)
    }));

    const payload = JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), entries, files: filesExport }, null, 2);
    download(payload, `internship-log-${today()}.json`, 'application/json');
    Toast.show('Exported as JSON.', 'success');
  },

  async exportMarkdown() {
    const entries = await DB.getAllEntries();
    entries.sort((a, b) => (a.date > b.date ? 1 : -1));

    let md = `# Internship Work Log\n\nExported: ${new Date().toLocaleString()}\n\n---\n\n`;

    entries.forEach(e => {
      const dayShort = UI.getDayShort(e.date);
      const tmpDiv   = document.createElement('div');
      tmpDiv.innerHTML = e.content || '';

      md += `## ${formatDate(e.date)} · ${dayShort}\n\n`;
      md += `${tmpDiv.textContent.trim()}\n\n`;

      if ((e.tags || []).length) md += `**Tags:** ${e.tags.map(t => '#' + t).join(', ')}\n\n`;
      if ((e.fileIds || []).length) md += `**Files:** ${e.fileIds.length} attachment(s)\n\n`;
      md += `---\n\n`;
    });

    download(md, `internship-log-${today()}.md`, 'text/markdown');
    Toast.show('Exported as Markdown.', 'success');
  },

  async exportCSV() {
    const entries = await DB.getAllEntries();
    entries.sort((a, b) => (a.date > b.date ? 1 : -1));

    const rows = [['Date', 'Day', 'Work Done', 'Tags', 'Files']];
    entries.forEach(e => {
      const tmpDiv = document.createElement('div');
      tmpDiv.innerHTML = e.content || '';
      rows.push([
        e.date,
        UI.getDayShort(e.date),
        (tmpDiv.textContent || '').replace(/\n/g, ' '),
        (e.tags || []).join('; '),
        String((e.fileIds || []).length)
      ]);
    });

    const csv = rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
    download(csv, `internship-log-${today()}.csv`, 'text/csv');
    Toast.show('Exported as CSV.', 'success');
  },

  async importJSON(file) {
    try {
      const text    = await file.text();
      const payload = JSON.parse(text);

      if (!payload.entries || !Array.isArray(payload.entries)) {
        Toast.show('Invalid backup file format.', 'error'); return;
      }

      // Save entries
      await Promise.all(payload.entries.map(e => DB.saveEntry(e)));

      // Save files (base64 → ArrayBuffer)
      if (payload.files && Array.isArray(payload.files)) {
        await Promise.all(payload.files.map(f => {
          const data = base64ToArrayBuffer(f.data);
          return DB.saveFile({ id: f.id, entryId: f.entryId, name: f.name, size: f.size, type: f.type, data });
        }));
      }

      await App.loadEntries();
      App.applyFilter();
      Toast.show(`Imported ${payload.entries.length} entries.`, 'success');
    } catch (err) {
      console.error(err);
      Toast.show('Import failed. Is this a valid JSON backup?', 'error');
    }
  }
};


/* ═══════════════════════════════════════════
   8. THEME
════════════════════════════════════════════ */
const Theme = {
  init() {
    const saved = localStorage.getItem('theme');
    const prefer = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    this.apply(saved || prefer);
  },
  toggle() {
    const current = document.body.getAttribute('data-theme');
    this.apply(current === 'dark' ? 'light' : 'dark');
  },
  apply(theme) {
    document.body.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    document.getElementById('theme-icon').textContent = theme === 'dark' ? 'light_mode' : 'dark_mode';
  }
};


/* ═══════════════════════════════════════════
   9. TOAST
════════════════════════════════════════════ */
const Toast = {
  show(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast     = document.createElement('div');
    toast.className = `toast toast--${type}`;
    const iconMap   = { success: 'check_circle', error: 'error', info: 'info' };
    toast.innerHTML = `<span class="material-icons-round">${iconMap[type] || 'info'}</span> ${escHtml(message)}`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('toast-out');
      toast.addEventListener('animationend', () => toast.remove());
    }, 3200);
  }
};


/* ═══════════════════════════════════════════
   10. CONFIRM DIALOG
════════════════════════════════════════════ */
const Confirm = {
  _entryId: null,
  _resolve: null,

  show(entryId) {
    this._entryId = entryId;
    document.getElementById('confirm-overlay').hidden = false;
    document.body.style.overflow = 'hidden';
    document.getElementById('btn-confirm-ok').focus();
  },

  hide() {
    document.getElementById('confirm-overlay').hidden = true;
    document.body.style.overflow = '';
    this._entryId = null;
  },

  async confirm() {
    const id = this._entryId;
    this.hide();
    if (!id) return;

    await DB.deleteFilesForEntry(id);
    await DB.deleteEntry(id);
    await App.loadEntries();
    App.applyFilter();

    // If detail view was showing this entry, close it
    if (Detail.entryId === id) Detail.close();

    Toast.show('Entry deleted.', 'info');
  }
};


/* ═══════════════════════════════════════════
   EVENT BINDING
════════════════════════════════════════════ */
function bindEvents() {

  /* ── FAB ──────────────────────────────── */
  document.getElementById('fab-add').addEventListener('click', () => {
    if (Modal.isOpen) Modal.close();
    else Modal.open();
  });

  document.getElementById('btn-empty-add').addEventListener('click', () => Modal.open());

  /* ── Modal controls ───────────────────── */
  document.getElementById('btn-modal-close').addEventListener('click', () => Modal.close());
  document.getElementById('btn-cancel').addEventListener('click',       () => Modal.close());
  document.getElementById('btn-save').addEventListener('click',         () => Modal.save());

  // Close on overlay click
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) Modal.close();
  });

  /* ── Date → Day auto fill ─────────────── */
  document.getElementById('entry-date').addEventListener('change', e => {
    document.getElementById('entry-day').value = getFullDay(e.target.value);
  });

  /* ── Toolbar buttons ──────────────────── */
  document.querySelectorAll('.toolbar-btn').forEach(btn => {
    btn.addEventListener('mousedown', e => {
      e.preventDefault(); // don't lose editor focus
      const cmd = btn.dataset.cmd;
      const val = btn.dataset.val;
      if (cmd === 'createLink') {
        const url = prompt('Enter URL:');
        if (url) document.execCommand('createLink', false, url);
      } else {
        document.execCommand(cmd, false, val || null);
      }
    });
  });

  /* ── File upload ──────────────────────── */
  const dropZone  = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });

  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    handleFiles(e.dataTransfer.files);
  });

  fileInput.addEventListener('change', () => { handleFiles(fileInput.files); fileInput.value = ''; });

  /* ── Search ───────────────────────────── */
  document.getElementById('btn-search-toggle').addEventListener('click', () => Search.toggle());
  document.getElementById('btn-search-close').addEventListener('click',  () => Search.toggle(false));

  document.getElementById('search-input').addEventListener('input', e => {
    App.searchQuery = e.target.value;
    App.applyFilter();
  });

  /* ── Theme ────────────────────────────── */
  document.getElementById('btn-theme').addEventListener('click', () => Theme.toggle());

  /* ── Export menu ──────────────────────── */
  const exportBtn  = document.getElementById('btn-export-menu');
  const exportMenu = document.getElementById('export-menu');

  exportBtn.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = exportMenu.classList.toggle('open');
    exportBtn.setAttribute('aria-expanded', String(isOpen));
  });

  document.addEventListener('click', () => {
    exportMenu.classList.remove('open');
    exportBtn.setAttribute('aria-expanded', 'false');
  });

  exportMenu.querySelectorAll('[data-export]').forEach(btn => {
    btn.addEventListener('click', () => {
      exportMenu.classList.remove('open');
      const type = btn.dataset.export;
      if (type === 'json')     ExportImport.exportJSON();
      if (type === 'markdown') ExportImport.exportMarkdown();
      if (type === 'csv')      ExportImport.exportCSV();
    });
  });

  /* ── Import ───────────────────────────── */
  document.getElementById('btn-import').addEventListener('click', () =>
    document.getElementById('import-file-input').click()
  );

  document.getElementById('import-file-input').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) ExportImport.importJSON(f);
    e.target.value = '';
  });

  /* ── Detail view ──────────────────────── */
  document.getElementById('btn-detail-close').addEventListener('click', () => Detail.close());

  document.getElementById('detail-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('detail-overlay')) Detail.close();
  });

  document.getElementById('btn-detail-edit').addEventListener('click', () => {
    const id = Detail.entryId;
    Detail.close();
    Modal.open(id);
  });

  document.getElementById('btn-detail-delete').addEventListener('click', () => {
    const id = Detail.entryId;
    Detail.close();
    Confirm.show(id);
  });

  /* ── Confirm dialog ───────────────────── */
  document.getElementById('btn-confirm-cancel').addEventListener('click', () => Confirm.hide());
  document.getElementById('btn-confirm-ok').addEventListener('click',     () => Confirm.confirm());

  document.getElementById('confirm-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('confirm-overlay')) Confirm.hide();
  });

  /* ── Auto-save draft ──────────────────── */
  document.getElementById('editor-content').addEventListener('input', debounceDraft);
  document.getElementById('entry-date').addEventListener('change',    debounceDraft);
  document.getElementById('entry-tags').addEventListener('input',     debounceDraft);

  /* ── Keyboard shortcuts ───────────────── */
  document.addEventListener('keydown', handleKeyboard);

  /* ── Escape key closes modals ─────────── */
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!document.getElementById('confirm-overlay').hidden) { Confirm.hide(); return; }
    if (!document.getElementById('detail-overlay').hidden)  { Detail.close(); return; }
    if (!document.getElementById('modal-overlay').hidden)   { Modal.close();  return; }
    if (document.getElementById('search-bar').classList.contains('open')) { Search.toggle(false); }
  });
}

/* ── File handling ──────────────────────── */
function handleFiles(fileList) {
  const MAX_SIZE = 50 * 1024 * 1024; // 50 MB

  Array.from(fileList).forEach(file => {
    if (file.size > MAX_SIZE) {
      Toast.show(`${file.name} is too large (max 50 MB).`, 'error');
      return;
    }

    const id      = `file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const pending = {
      id,
      name:        file.name,
      size:        file.size,
      type:        file.type,
      dataPromise: file.arrayBuffer()
    };

    App.pendingFiles.push(pending);

    const li = UI.createFileItem(
      { id, name: file.name, size: file.size, type: file.type },
      true,
      (fid, el) => {
        App.pendingFiles = App.pendingFiles.filter(p => p.id !== fid);
        el.remove();
      },
      null
    );

    // Preview for images (read before arrayBuffer is consumed)
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const iconEl = li.querySelector('.file-item__icon');
        iconEl.innerHTML = `<img src="${e.target.result}" alt="${escHtml(file.name)}" />`;
        iconEl.className = 'file-item__icon file-item__icon--img';
      };
      reader.readAsDataURL(file);
    }

    document.getElementById('file-list').appendChild(li);
  });
}

/* ── Draft auto-save ────────────────────── */
let _draftTimer = null;

function debounceDraft() {
  clearTimeout(_draftTimer);
  _draftTimer = setTimeout(saveDraft, 800);
}

function saveDraft() {
  if (!Modal.isOpen) return;
  const draft = {
    date:    document.getElementById('entry-date').value,
    content: document.getElementById('editor-content').innerHTML,
    tags:    document.getElementById('entry-tags').value
  };
  localStorage.setItem('draft', JSON.stringify(draft));
  const indicator = document.getElementById('draft-indicator');
  indicator.textContent = 'Draft saved ' + new Date().toLocaleTimeString();
}

function restoreDraft() {
  // Only auto-restore on NEW entry opens; just keep data available
}

function clearDraft() {
  localStorage.removeItem('draft');
}

/* ── Keyboard shortcuts ─────────────────── */
function handleKeyboard(e) {
  const tag = document.activeElement?.tagName?.toLowerCase();
  const inInput = ['input', 'textarea'].includes(tag) ||
                  document.activeElement?.contentEditable === 'true';

  // N → new entry (when not in an input)
  if (e.key === 'n' && !inInput && document.getElementById('modal-overlay').hidden) {
    e.preventDefault();
    Modal.open();
    return;
  }

  // Ctrl+S → save
  if (e.key === 's' && (e.ctrlKey || e.metaKey) && !document.getElementById('modal-overlay').hidden) {
    e.preventDefault();
    Modal.save();
    return;
  }

  // Ctrl+F → search
  if (e.key === 'f' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    Search.toggle(true);
    return;
  }
}


/* ═══════════════════════════════════════════
   UTILITY FUNCTIONS
════════════════════════════════════════════ */

/** Return today as YYYY-MM-DD */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/** YYYY-MM-DD → "Monday", "Tuesday", … */
function getFullDay(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()];
}

/** YYYY-MM-DD → "15 Jan 2025" */
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Bytes → human-readable */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k     = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i     = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/** Escape HTML special chars */
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Trigger a browser download */
function download(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Download a stored file from IDB */
function downloadFile(f) {
  const blob = new Blob([f.data], { type: f.type || 'application/octet-stream' });
  download(blob, f.name, f.type);
}

/** ArrayBuffer → base64 string */
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** base64 string → ArrayBuffer */
function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Register Service Worker for offline support */
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    // Only register if sw.js exists (GitHub Pages deployment)
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // Silently fail in dev (sw.js not required)
    });
  }
}


/* ═══════════════════════════════════════════
   BOOTSTRAP
════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => App.init());
