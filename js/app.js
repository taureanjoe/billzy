/**
 * billzy — Instant receipt splitter. No account, no saving, no backend.
 * All state in memory. OCR via Tesseract.js (client-side).
 */

(function () {
  'use strict';

  const MAX_PEOPLE = 20;

  // --- State ---
  const state = {
    receiptFiles: [],       // { id, file, dataUrl?, parsed? }
    people: [],             // [{ id, name }]
    items: [],              // [{ id, name, price, uncertain, receiptId, assigneeIds: [] }]
    warnings: [],           // string[]
    nextReceiptId: 1,
    nextPersonId: 1,
    nextItemId: 1,
    editingItemId: null,
  };

  // --- DOM refs ---
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const receiptThumbnails = document.getElementById('receipt-thumbnails');
  const parseAllBtn = document.getElementById('parse-all-btn');
  const peopleToggle = document.getElementById('people-toggle');
  const peopleList = document.getElementById('people-list');
  const peopleSlots = document.getElementById('people-slots');
  const addPersonBtn = document.getElementById('add-person-btn');
  const warningsPanel = document.getElementById('warnings-panel');
  const warningsList = document.getElementById('warnings-list');
  const tablePanel = document.getElementById('table-panel');
  const parsedTbody = document.getElementById('parsed-tbody');
  const tableMeta = document.getElementById('table-meta');
  const summaryPanel = document.getElementById('summary-panel');
  const summaryTbody = document.getElementById('summary-tbody');
  const copyBtn = document.getElementById('copy-btn');
  const downloadCsvBtn = document.getElementById('download-csv-btn');
  const editModal = document.getElementById('edit-modal');
  const editModalBackdrop = document.getElementById('edit-modal-backdrop');
  const editName = document.getElementById('edit-name');
  const editPrice = document.getElementById('edit-price');
  const editCancel = document.getElementById('edit-cancel');
  const editSave = document.getElementById('edit-save');

  // --- Helpers ---
  function $(id) { return document.getElementById(id); }
  function show(el) { el.classList.remove('hidden'); el.hidden = false; }
  function hide(el) { el.classList.add('hidden'); el.hidden = true; }
  function parseMoney(s) {
    const m = String(s).replace(/[^\d.]/g, '').match(/(\d+\.?\d*)/);
    return m ? parseFloat(m[1]) : null;
  }

  /**
   * Parse raw OCR text into line items + meta.
   * Heuristic: lines with a number at end = item + price; "total"/"tax" etc. = meta.
   */
  function parseReceiptText(text) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const items = [];
    let total = null;
    let tax = null;
    const localWarnings = [];

    // Price at end: optional currency, digits and optional decimal
    const priceAtEnd = /(.+?)\s+([£$€]?\s*\d+[.,]?\d*)\s*$/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lower = line.toLowerCase();

      if (/\b(total|total due|amount|balance)\b/.test(lower)) {
        const p = parseMoney(line);
        if (p != null) total = p;
        continue;
      }
      if (/\b(tax|vat|gst)\b/.test(lower)) {
        const p = parseMoney(line);
        if (p != null) tax = p;
        continue;
      }
      if (/\b(subtotal|sub total)\b/.test(lower)) continue;

      const match = line.match(priceAtEnd);
      if (match) {
        const name = match[1].trim().replace(/\s+/g, ' ');
        const priceStr = match[2].replace(',', '.');
        const price = parseFloat(priceStr.replace(/[^\d.]/g, '')) || null;
        if (name.length > 0 && price != null && price < 10000) {
          items.push({ name, price, uncertain: false });
        }
      } else if (line.length > 2 && /\d/.test(line)) {
        // Line has digits but no clear price at end — try to extract
        const num = line.match(/(\d+[.,]\d{2})/);
        if (num) {
          const price = parseFloat(num[1].replace(',', '.'));
          const name = line.replace(num[0], '').trim() || 'Item';
          if (price < 10000) {
            items.push({ name: name || 'Item', price, uncertain: true });
            localWarnings.push(`"${name}" — price may be wrong (uncertain read).`);
          }
        }
      }
    }

    if (items.length === 0) {
      localWarnings.push('No line items could be read. Try a clearer image or add items manually.');
    }
    const sumItems = items.reduce((s, i) => s + i.price, 0);
    if (total != null && Math.abs(sumItems - total) > 0.02) {
      localWarnings.push('Total may be inaccurate — item sum does not match receipt total.');
    }
    if (items.some(i => i.uncertain)) {
      localWarnings.push('Some items are marked uncertain. Please verify prices.');
    }

    return { items, total, tax, warnings: localWarnings };
  }

  /**
   * Run Tesseract on image URL; return parsed items + warnings.
   */
  async function runOCR(imageUrl) {
    const { data: { text } } = await Tesseract.recognize(imageUrl, 'eng', {
      logger: () => {},
    });
    return parseReceiptText(text);
  }

  // --- Upload & thumbnails ---
  function addFiles(files) {
    const list = Array.from(files).filter(f => f.type.startsWith('image/'));
    for (const file of list) {
      state.receiptFiles.push({
        id: 'r' + state.nextReceiptId++,
        file,
        dataUrl: null,
        parsed: false,
      });
    }
    renderThumbnails();
    processDataUrls();
  }

  function processDataUrls() {
    state.receiptFiles.filter(r => !r.dataUrl).forEach(r => {
      const reader = new FileReader();
      reader.onload = () => {
        r.dataUrl = reader.result;
        renderThumbnails();
      };
      reader.readAsDataURL(r.file);
    });
  }

  function removeReceipt(id) {
    state.receiptFiles = state.receiptFiles.filter(r => r.id !== id);
    state.items = state.items.filter(i => i.receiptId !== id);
    renderThumbnails();
    renderParsedTable();
    renderWarnings();
    renderSummary();
    updateParseButton();
  }

  function renderThumbnails() {
    receiptThumbnails.innerHTML = '';
    state.receiptFiles.forEach(r => {
      const wrap = document.createElement('div');
      wrap.className = 'thumb';
      const img = document.createElement('img');
      img.alt = 'Receipt';
      if (r.dataUrl) img.src = r.dataUrl;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'thumb-remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', 'Remove receipt');
      remove.onclick = () => removeReceipt(r.id);
      wrap.appendChild(img);
      wrap.appendChild(remove);
      receiptThumbnails.appendChild(wrap);
    });
    const allHaveDataUrl = state.receiptFiles.length > 0 && state.receiptFiles.every(r => r.dataUrl);
    parseAllBtn.disabled = !allHaveDataUrl;
  }

  function updateParseButton() {
    const allHaveDataUrl = state.receiptFiles.length > 0 && state.receiptFiles.every(r => r.dataUrl);
    parseAllBtn.disabled = !allHaveDataUrl;
  }

  // --- Parse all ---
  async function parseAll() {
    parseAllBtn.disabled = true;
    parseAllBtn.closest('.actions').classList.add('parse-loading');
    parseAllBtn.textContent = 'Parsing…';

    state.warnings = [];
    const existingIds = new Set(state.items.map(i => i.id));
    state.items = state.items.filter(() => false);

    for (const rec of state.receiptFiles) {
      if (!rec.dataUrl) continue;
      try {
        const { items, warnings: w } = await runOCR(rec.dataUrl);
        rec.parsed = true;
        state.warnings.push(...w);
        items.forEach(({ name, price, uncertain }) => {
          state.items.push({
            id: 'i' + state.nextItemId++,
            name,
            price,
            uncertain,
            receiptId: rec.id,
            assigneeIds: [],
          });
        });
      } catch (e) {
        state.warnings.push(`Receipt "${rec.file.name}" could not be read: ${e.message}`);
      }
    }

    parseAllBtn.closest('.actions').classList.remove('parse-loading');
    parseAllBtn.textContent = 'Parse all receipts';
    parseAllBtn.disabled = false;
    updateParseButton();

    renderWarnings();
    renderParsedTable();
    renderSummary();
    if (state.items.length > 0) {
      show(tablePanel);
      tablePanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // --- Warnings ---
  function renderWarnings() {
    if (state.warnings.length === 0) {
      hide(warningsPanel);
      return;
    }
    show(warningsPanel);
    warningsList.innerHTML = state.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('');
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  // --- People ---
  function addPerson() {
    if (state.people.length >= MAX_PEOPLE) return;
    state.people.push({ id: 'p' + state.nextPersonId++, name: '' });
    renderPeople();
  }

  function removePerson(id) {
    state.people = state.people.filter(p => p.id !== id);
    state.items.forEach(i => {
      i.assigneeIds = i.assigneeIds.filter(pid => pid !== id);
    });
    renderPeople();
    renderParsedTable();
    renderSummary();
  }

  function setPersonName(id, name) {
    const p = state.people.find(x => x.id === id);
    if (p) p.name = name;
    renderSummary();
  }

  function renderPeople() {
    peopleSlots.innerHTML = '';
    state.people.forEach((p, idx) => {
      const row = document.createElement('div');
      row.className = 'person-row';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = `Person ${idx + 1}`;
      input.value = p.name;
      input.setAttribute('aria-label', `Name for person ${idx + 1}`);
      input.oninput = () => setPersonName(p.id, input.value.trim());
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn-remove-person';
      remove.textContent = '×';
      remove.setAttribute('aria-label', 'Remove person');
      remove.onclick = () => removePerson(p.id);
      row.appendChild(input);
      row.appendChild(remove);
      peopleSlots.appendChild(row);
    });
    addPersonBtn.disabled = state.people.length >= MAX_PEOPLE;
    addPersonBtn.textContent = state.people.length >= MAX_PEOPLE ? 'Maximum 20 people' : '+ Add person';
  }

  // --- Parsed table ---
  function renderParsedTable() {
    parsedTbody.innerHTML = '';
    state.items.forEach(item => {
      const tr = document.createElement('tr');
      tr.dataset.itemId = item.id;
      if (item.uncertain) tr.classList.add('uncertain');
      tr.innerHTML = `
        <td><span class="cell-editable" data-item-id="${item.id}" data-field="name">${escapeHtml(item.name)}</span></td>
        <td class="col-price"><span class="cell-editable" data-item-id="${item.id}" data-field="price">$${item.price.toFixed(2)}</span>${item.uncertain ? ' <span title="Uncertain read">⚠️</span>' : ''}</td>
        <td class="col-assign"><div class="assign-cell" data-item-id="${item.id}"></div></td>
        <td class="col-remove"><button type="button" class="btn-remove-item" data-item-id="${item.id}" aria-label="Remove item">×</button></td>
      `;

      const assignCell = tr.querySelector('.assign-cell');
      state.people.forEach(person => {
        const label = document.createElement('label');
        label.style.display = 'inline-flex';
        label.style.alignItems = 'center';
        label.style.gap = '0.25rem';
        label.style.marginRight = '0.5rem';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = item.assigneeIds.includes(person.id);
        check.onchange = () => {
          if (check.checked) {
            if (!item.assigneeIds.includes(person.id)) item.assigneeIds.push(person.id);
          } else {
            item.assigneeIds = item.assigneeIds.filter(pid => pid !== person.id);
          }
          renderParsedTable();
          renderSummary();
        };
        label.appendChild(check);
        label.appendChild(document.createTextNode(person.name || `Person ${state.people.indexOf(person) + 1}`));
        assignCell.appendChild(label);
      });
      if (state.people.length === 0) {
        const span = document.createElement('span');
        span.className = 'assign-empty';
        span.textContent = 'Add people above to assign';
        assignCell.appendChild(span);
      }

      const removeBtn = tr.querySelector('.btn-remove-item');
      if (removeBtn) removeBtn.onclick = () => removeItem(item.id);

      parsedTbody.appendChild(tr);
    });

    // Editable cells
    parsedTbody.querySelectorAll('.cell-editable').forEach(el => {
      el.addEventListener('click', () => openEditModal(el.dataset.itemId, el.dataset.field));
    });

    const total = state.items.reduce((s, i) => s + i.price, 0);
    const assigned = state.items.filter(i => i.assigneeIds.length > 0).reduce((s, i) => s + i.price, 0);
    tableMeta.textContent = `Total: $${total.toFixed(2)}${state.people.length ? ` · Assigned: $${assigned.toFixed(2)}` : ''}`;

    if (state.items.length > 0) show(tablePanel); else hide(tablePanel);
  }

  function openEditModal(itemId, field) {
    const item = state.items.find(i => i.id === itemId);
    if (!item) return;
    state.editingItemId = itemId;
    editName.value = item.name;
    editPrice.value = item.price.toFixed(2);
    show(editModal);
    setTimeout(() => (field === 'name' ? editName : editPrice).focus(), 50);
  }

  function closeEditModal() {
    state.editingItemId = null;
    hide(editModal);
  }

  function saveEdit() {
    const item = state.items.find(i => i.id === state.editingItemId);
    if (!item) { closeEditModal(); return; }
    const name = editName.value.trim();
    const price = parseFloat(editPrice.value);
    if (name) item.name = name;
    if (!Number.isNaN(price) && price >= 0) {
      item.price = price;
      item.uncertain = false;
    }
    closeEditModal();
    renderParsedTable();
    renderSummary();
  }

  // Add row / remove row (optional — add buttons in UI if desired)
  function addItemRow() {
    state.items.push({
      id: 'i' + state.nextItemId++,
      name: 'New item',
      price: 0,
      uncertain: false,
      receiptId: null,
      assigneeIds: [],
    });
    renderParsedTable();
    renderSummary();
  }

  function removeItem(id) {
    state.items = state.items.filter(i => i.id !== id);
    renderParsedTable();
    renderSummary();
  }

  // --- Summary & split ---
  function computeSplit() {
    const owed = {};
    state.people.forEach(p => { owed[p.id] = 0; });
    state.items.forEach(item => {
      if (item.assigneeIds.length === 0) return;
      const share = item.price / item.assigneeIds.length;
      item.assigneeIds.forEach(pid => { owed[pid] = (owed[pid] || 0) + share; });
    });
    return owed;
  }

  function renderSummary() {
    const owed = computeSplit();
    summaryTbody.innerHTML = '';
    state.people.forEach((p, idx) => {
      const amount = owed[p.id] || 0;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(p.name || `Person ${idx + 1}`)}</td>
        <td class="col-amount">$${amount.toFixed(2)}</td>
      `;
      summaryTbody.appendChild(tr);
    });
    if (state.people.length > 0) show(summaryPanel); else hide(summaryPanel);
  }

  function getSummaryText() {
    const owed = computeSplit();
    const lines = state.people.map((p, idx) => {
      const name = p.name || `Person ${idx + 1}`;
      const amount = (owed[p.id] || 0).toFixed(2);
      return `${name}: $${amount}`;
    });
    return lines.join('\n');
  }

  function copyResult() {
    const text = getSummaryText();
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy result'; }, 2000);
    });
  }

  function downloadCsv() {
    const owed = computeSplit();
    const rows = [['Person', 'Amount Owed']];
    state.people.forEach((p, idx) => {
      rows.push([p.name || `Person ${idx + 1}`, (owed[p.id] || 0).toFixed(2)]);
    });
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'billzy-split.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Per-person expense list for image: { personName, lines: [{ label, amount }], subtotal }
   */
  function getPerPersonExpenses() {
    return state.people.map((p, idx) => {
      const name = p.name || `Person ${idx + 1}`;
      const lines = [];
      state.items.forEach(item => {
        if (!item.assigneeIds.includes(p.id)) return;
        const share = item.price / item.assigneeIds.length;
        const label = item.assigneeIds.length > 1
          ? `${item.name} (${item.assigneeIds.length}-way split)`
          : item.name;
        lines.push({ label, amount: share });
      });
      const subtotal = lines.reduce((s, l) => s + l.amount, 0);
      return { personName: name, lines, subtotal };
    });
  }

  /**
   * Draw summary image on canvas with billzy branding; return canvas.
   */
  function drawSummaryCanvas() {
    const dpr = 2;
    const width = 400 * dpr;
    const padding = 24 * dpr;
    const lineHeight = 20 * dpr;
    const sectionGap = 28 * dpr;
    const fontTitle = `${22 * dpr}px system-ui, -apple-system, sans-serif`;
    const fontBrand = `${28 * dpr}px system-ui, -apple-system, sans-serif`;
    const fontSub = `${14 * dpr}px system-ui, -apple-system, sans-serif`;
    const fontSmall = `${12 * dpr}px system-ui, -apple-system, sans-serif`;

    const data = getPerPersonExpenses();
    const teal = '#0d9488';
    const tealDark = '#0f766e';
    const gray = '#475569';
    const grayLight = '#94a3b8';

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // Compute height from content
    let height = padding * 2 + lineHeight * 1.4 + lineHeight + sectionGap * 2;
    data.forEach(({ lines }) => {
      height += lineHeight * 1.3 + lines.length * lineHeight + lineHeight + sectionGap;
    });
    height += sectionGap + lineHeight * 2 + padding;
    canvas.width = width;
    canvas.height = Math.max(400 * dpr, height);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, canvas.height);

    let y = padding * 2;

    // Brand block
    ctx.fillStyle = teal;
    ctx.font = fontBrand;
    ctx.fillText('billzy', padding, y);
    y += lineHeight * 1.4;
    ctx.fillStyle = tealDark;
    ctx.font = fontSmall;
    ctx.fillText('Scan → Parse → Split. No account, no saving.', padding, y);
    y += sectionGap;

    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding, y);
    ctx.lineTo(width - padding, y);
    ctx.stroke();
    y += sectionGap;

    // Per-person blocks
    data.forEach(({ personName, lines, subtotal }) => {
      ctx.fillStyle = gray;
      ctx.font = fontTitle;
      ctx.fillText(personName, padding, y);
      y += lineHeight * 1.3;

      ctx.font = fontSub;
      lines.forEach(({ label, amount }) => {
        const amtStr = `$${amount.toFixed(2)}`;
        ctx.fillStyle = '#1e293b';
        const maxLabelW = width - padding * 2 - 80 * dpr;
        const truncated = ctx.measureText(label).width > maxLabelW
          ? label.slice(0, Math.floor(label.length * maxLabelW / ctx.measureText(label).width)) + '…'
          : label;
        ctx.fillText(truncated, padding, y);
        ctx.fillStyle = tealDark;
        ctx.fillText(amtStr, width - padding - ctx.measureText(amtStr).width, y);
        y += lineHeight;
      });

      ctx.font = fontSub;
      ctx.fillStyle = gray;
      ctx.fillText('Subtotal', padding, y);
      ctx.font = fontTitle;
      ctx.fillStyle = tealDark;
      const subStr = `$${subtotal.toFixed(2)}`;
      ctx.fillText(subStr, width - padding - ctx.measureText(subStr).width, y);
      y += lineHeight + sectionGap;
    });

    // Footer line
    ctx.strokeStyle = '#e2e8f0';
    ctx.beginPath();
    ctx.moveTo(padding, y);
    ctx.lineTo(width - padding, y);
    ctx.stroke();
    y += sectionGap;

    ctx.font = fontSmall;
    ctx.fillStyle = grayLight;
    const dateStr = 'Generated ' + new Date().toLocaleDateString(undefined, { dateStyle: 'medium' });
    ctx.fillText(dateStr, padding, y);
    y += lineHeight;
    ctx.fillText('No data stored. Use at your own discretion.', padding, y);

    return canvas;
  }

  function downloadSummaryImage() {
    if (state.people.length === 0) return;
    const canvas = drawSummaryCanvas();
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'billzy-split.png';
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  }

  // --- Event bindings ---
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) addFiles(fileInput.files);
    fileInput.value = '';
  });

  parseAllBtn.addEventListener('click', parseAll);

  peopleToggle.addEventListener('click', () => {
    const open = peopleList.hidden;
    peopleList.hidden = !open;
    peopleToggle.setAttribute('aria-expanded', open);
  });

  addPersonBtn.addEventListener('click', addPerson);

  copyBtn.addEventListener('click', copyResult);
  downloadCsvBtn.addEventListener('click', downloadCsv);
  const downloadImageBtn = document.getElementById('download-image-btn');
  if (downloadImageBtn) downloadImageBtn.addEventListener('click', downloadSummaryImage);

  const legalToggle = document.getElementById('legal-toggle');
  const legalNotice = document.getElementById('legal-notice');
  if (legalToggle && legalNotice) {
    legalToggle.addEventListener('click', () => {
      const open = !legalNotice.hidden;
      legalNotice.hidden = !open;
      legalNotice.classList.toggle('hidden', !open);
      legalToggle.setAttribute('aria-expanded', open);
    });
  }

  editModalBackdrop.addEventListener('click', closeEditModal);
  editCancel.addEventListener('click', closeEditModal);
  editSave.addEventListener('click', saveEdit);
  editModal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeEditModal();
  });

  const addItemBtn = document.getElementById('add-item-btn');
  if (addItemBtn) addItemBtn.addEventListener('click', addItemRow);

  // Initial people list visibility
  peopleList.hidden = true;

  // Optional: start with 2 empty people for faster flow
  addPerson();
  addPerson();
})();
