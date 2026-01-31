/**
 * billzy — Instant receipt splitter. No account, no saving, no backend.
 * All state in memory. OCR via Tesseract.js (client-side).
 */

(function () {
  'use strict';

  const MAX_PEOPLE = 20;
  const MAX_RECEIPTS = 10;
  const GITHUB_REPO = 'taureanjoe/billzy';

  // --- State ---
  const state = {
    receiptFiles: [],       // { id, file, dataUrl?, parsed?, merchantName }
    people: [],             // [{ id, name }]
    items: [],              // [{ id, name, price, quantity, uncertain, receiptId, assigneeIds: [] }]
    warnings: [],           // string[]
    nextReceiptId: 1,
    nextPersonId: 1,
    nextItemId: 1,
    editingItemId: null,
    editingReceiptId: null,
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
  const billSections = document.getElementById('bill-sections');
  const tableMeta = document.getElementById('table-meta');
  const summaryPanel = document.getElementById('summary-panel');
  const summaryList = document.getElementById('summary-list');
  const copyBtn = document.getElementById('copy-btn');
  const downloadCsvBtn = document.getElementById('download-csv-btn');
  const editModal = document.getElementById('edit-modal');
  const editModalBackdrop = document.getElementById('edit-modal-backdrop');
  const editQuantity = document.getElementById('edit-quantity');
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
   * True if line looks like receipt metadata we should skip (not an item).
   */
  function isMetadataLine(line) {
    const lower = line.toLowerCase().trim();
    if (lower.length < 3) return true;
    // Dates and time
    if (/\d{1,2}\/\d{1,2}\/\d{2,4}\s*\d{0,2}:?\d{0,2}\s*(am|pm)?/i.test(lower)) return true;
    if (/^\d{1,2}:\d{2}\s*[ap]m$/i.test(lower)) return true;
    // Receipt header fields
    if (/^(server|check\s*#|table|tab|guest)\s*[:#]?\s*/i.test(lower)) return true;
    if (/^#?\d{2,5}$/.test(lower)) return true; // check number alone
    // Addresses
    if (/\b(street|st\.?|avenue|ave\.?|blvd|road|rd\.?|drive|dr\.?)\b/i.test(lower) && /\d/.test(lower)) return true;
    if (/\b\d{5}(-\d{4})?\s*$/.test(lower)) return true; // zip at end
    // Payment
    if (/\b(visa|mastercard|amex|chip|read|approved|declined|sale|authorization)\b/i.test(lower)) return true;
    if (/^x+\d{4}$/i.test(lower)) return true; // masked card
    if (/^\d{6}$/.test(lower)) return true; // approval code
    // Promo / footer
    if (lower.length > 120 && !/\$\d+\.\d{2}\s*$/.test(lower)) return true;
    return false;
  }

  /**
   * Extract price from end of string: last $X.XX or X.XX (2 decimals). Returns { price, rest } or null.
   */
  function extractPriceFromEnd(str) {
    const withDollar = str.match(/\s+(\$\s*)(\d+[.,]\d{2})\s*$/);
    if (withDollar) {
      const price = parseFloat(withDollar[2].replace(',', '.'));
      const rest = str.slice(0, str.length - withDollar[0].length).trim();
      return rest.length > 0 ? { price, rest } : null;
    }
    const twoDecimals = str.match(/\s+(\d+[.,]\d{2})\s*$/);
    if (twoDecimals) {
      const price = parseFloat(twoDecimals[1].replace(',', '.'));
      const rest = str.slice(0, str.length - twoDecimals[0].length).trim();
      return rest.length > 0 ? { price, rest } : null;
    }
    return null;
  }

  /**
   * Fallback: find last price-like number ($X.XX or X.XX, 0.01–9999.99) in line.
   * Handles OCR that mangles spacing (e.g. "Item Name$12.00").
   */
  function extractPriceAnywhere(str) {
    const re = /\$?\s*(\d{1,4}[.,]\d{2})(?=\s*$|[\s,]|\D)/g;
    let match;
    let lastMatch = null;
    while ((match = re.exec(str)) !== null) lastMatch = match;
    if (lastMatch) {
      const price = parseFloat(lastMatch[1].replace(',', '.'));
      if (price >= 0.01 && price < 10000) {
        const rest = str.slice(0, lastMatch.index).replace(/\s*\$?\s*$/, '').trim();
        return rest.length > 0 ? { price, rest } : null;
      }
    }
    return null;
  }

  /**
   * Strip leading quantity (e.g. "2 " or "3x ") from rest; return { quantity, name }.
   */
  function stripLeadingQuantity(rest) {
    const leadingNum = rest.match(/^(\d+)\s*[x×]?\s*(.*)$/);
    if (leadingNum) {
      const qty = parseInt(leadingNum[1], 10);
      const name = leadingNum[2].trim();
      if (qty >= 1 && qty <= 99 && name.length > 0) return { quantity: qty, name };
    }
    return { quantity: 1, name: rest };
  }

  /**
   * True if the extracted "name" looks like a real item (not OCR garbage).
   */
  function looksLikeItemName(name) {
    if (!name || name.length < 2) return false;
    const letters = (name.match(/[a-zA-Z]/g) || []).length;
    if (letters < 2) return false;
    if (/^[\d\s$.,#:;]+$/.test(name)) return false;
    const nonLetter = name.replace(/[a-zA-Z\s]/g, '').length;
    if (nonLetter > name.length * 0.5) return false;
    if (name.length > 120) return false;
    return true;
  }

  /**
   * Parse raw OCR text into line items + meta.
   * Handles: optional leading quantity (2 Mocktail...), price at end, skips metadata.
   */
  function parseReceiptText(text) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const items = [];
    let total = null;
    let tax = null;
    const localWarnings = [];

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
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
      if (isMetadataLine(line)) continue;

      let extracted = extractPriceFromEnd(line);
      if (!extracted) extracted = extractPriceAnywhere(line);
      if (!extracted || extracted.price <= 0 || extracted.price >= 10000) continue;

      const { price, rest } = extracted;
      const { quantity, name: rawName } = stripLeadingQuantity(rest);
      const name = rawName.replace(/\s+/g, ' ').trim();

      if (!looksLikeItemName(name)) continue;

      items.push({ name, price, quantity, uncertain: false });
    }

    if (items.length === 0) {
      localWarnings.push('No line items could be read. Try a clearer image or add items manually.');
    }
    const sumItems = items.reduce((s, i) => s + i.price, 0);
    if (total != null && Math.abs(sumItems - total) > 0.02) {
      localWarnings.push('Total may be inaccurate — item sum does not match receipt total.');
    }

    return { items, total, tax, warnings: localWarnings };
  }

  /**
   * Run Tesseract on image URL; return parsed items, warnings, and raw OCR text.
   */
  async function runOCR(imageUrl) {
    const { data: { text } } = await Tesseract.recognize(imageUrl, 'eng', {
      logger: () => {},
    });
    const parsed = parseReceiptText(text);
    return { ...parsed, rawText: text };
  }

  /**
   * Suggest merchant name from first lines of OCR that look like a business name (not address/date).
   */
  function suggestMerchantFromRawText(rawText) {
    const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (let i = 0; i < Math.min(lines.length, 8); i++) {
      const line = lines[i];
      if (line.length < 4 || line.length > 60) continue;
      if (/^\d+[.,]?\d*$/.test(line)) continue;
      if (/\b(street|st\.|avenue|ave\.|blvd|road|rd\.|drive|dr\.|server|check\s*#|table|tab)\b/i.test(line)) continue;
      if (/^\d+\s/.test(line) && line.length < 30) continue;
      const letters = (line.match(/[a-zA-Z]/g) || []).length;
      if (letters >= 4) return line.replace(/\s+/g, ' ').trim();
    }
    return null;
  }

  // --- Upload & thumbnails ---
  function addFiles(files) {
    const list = Array.from(files).filter(f => f.type.startsWith('image/'));
    const remaining = Math.max(0, MAX_RECEIPTS - state.receiptFiles.length);
    const toAdd = list.slice(0, remaining);
    const start = state.receiptFiles.length;
    toAdd.forEach((file, i) => {
      state.receiptFiles.push({
        id: 'r' + state.nextReceiptId++,
        file,
        dataUrl: null,
        parsed: false,
        merchantName: 'Receipt ' + (start + i + 1),
      });
    });
    renderThumbnails();
    processDataUrls();
    if (list.length > remaining && remaining > 0) {
      state.warnings.push(`Maximum ${MAX_RECEIPTS} receipts. Only the first ${remaining} of the selected files were added.`);
      renderWarnings();
    }
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
    renderBillSections();
    renderWarnings();
    renderSummary();
    updateParseButton();
  }

  function renderThumbnails() {
    const countEl = document.getElementById('receipt-count-hint');
    if (countEl) countEl.textContent = `${state.receiptFiles.length} / ${MAX_RECEIPTS} receipts`;
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
        const { items, warnings: w, rawText } = await runOCR(rec.dataUrl);
        rec.parsed = true;
        state.warnings.push(...w);
        if (rawText) {
          const suggested = suggestMerchantFromRawText(rawText);
          if (suggested && /^Receipt \d+$/.test(rec.merchantName)) rec.merchantName = suggested;
        }
        items.forEach(({ name, price, quantity, uncertain }) => {
          state.items.push({
            id: 'i' + state.nextItemId++,
            name,
            price,
            quantity: quantity != null ? quantity : 1,
            uncertain: !!uncertain,
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
    renderBillSections();
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
    renderBillSections();
    renderSummary();
  }

  function setPersonName(id, name) {
    const p = state.people.find(x => x.id === id);
    if (p) p.name = name;
    renderSummary();
  }

  function recalculateSplit() {
    renderBillSections();
    renderSummary();
  }

  function getMerchantName(receiptId) {
    const rec = state.receiptFiles.find(r => r.id === receiptId);
    return rec ? rec.merchantName : 'Receipt';
  }

  function setMerchantName(receiptId, name) {
    const rec = state.receiptFiles.find(r => r.id === receiptId);
    if (rec) rec.merchantName = (name || '').trim() || rec.merchantName;
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

  // --- List of items (grouped by merchant) ---
  function renderBillSections() {
    billSections.innerHTML = '';
    const byReceipt = {};
    state.items.forEach(item => {
      const rid = item.receiptId || 'unsorted';
      if (!byReceipt[rid]) byReceipt[rid] = [];
      byReceipt[rid].push(item);
    });
    const receiptOrder = state.receiptFiles.filter(r => (byReceipt[r.id] || []).length > 0).map(r => r.id);
    if ((byReceipt.unsorted || []).length > 0) receiptOrder.push('unsorted');

    receiptOrder.forEach(receiptId => {
      const items = byReceipt[receiptId] || [];
      const section = document.createElement('div');
      section.className = 'bill-section';
      const merchantName = receiptId === 'unsorted' ? 'Other items' : getMerchantName(receiptId);
      section.innerHTML = `
        <div class="bill-section-header">
          <span class="merchant-name">${escapeHtml(merchantName)}</span>
          ${receiptId !== 'unsorted' ? '<button type="button" class="btn-edit-merchant" data-receipt-id="' + receiptId + '" aria-label="Edit merchant name">Edit</button>' : ''}
        </div>
      `;
      const header = section.querySelector('.bill-section-header');
      const editBtn = section.querySelector('.btn-edit-merchant');
      if (editBtn) editBtn.addEventListener('click', () => openMerchantModal(editBtn.dataset.receiptId));

      const listHeader = document.createElement('div');
      listHeader.className = 'bill-list-header';
      listHeader.innerHTML = '<span class="bill-list-header-qty">Qty</span><span class="bill-list-header-name">Item</span><span class="bill-list-header-price">Price</span><span class="bill-list-header-assign">Assign to</span><span class="bill-list-header-remove"></span>';
      section.appendChild(listHeader);

      items.forEach(item => {
        const qty = item.quantity != null ? item.quantity : 1;
        const card = document.createElement('div');
        card.className = 'bill-item-card' + (item.uncertain ? ' uncertain' : '');
        card.innerHTML = `
          <div class="bill-item-qty-cell" title="Quantity — tap to edit"><span class="cell-editable cell-editable-qty" data-item-id="${item.id}" data-field="quantity">${qty}</span></div>
          <div class="bill-item-name"><span class="cell-editable" data-item-id="${item.id}" data-field="name">${escapeHtml(item.name)}</span>${item.uncertain ? ' <span title="Uncertain read">⚠️</span>' : ''}</div>
          <div class="bill-item-price"><span class="cell-editable" data-item-id="${item.id}" data-field="price">$${item.price.toFixed(2)}</span></div>
          <div class="bill-item-assign"></div>
          <button type="button" class="bill-item-remove" data-item-id="${item.id}" aria-label="Remove item">×</button>
        `;
        const assignEl = card.querySelector('.bill-item-assign');
        if (state.people.length === 0) {
          const span = document.createElement('span');
          span.className = 'assign-empty';
          span.textContent = 'Add people above';
          assignEl.appendChild(span);
        } else {
          state.people.forEach(person => {
            const label = document.createElement('label');
            const check = document.createElement('input');
            check.type = 'checkbox';
            check.checked = item.assigneeIds.includes(person.id);
            check.onchange = () => {
              if (check.checked) item.assigneeIds.push(person.id);
              else item.assigneeIds = item.assigneeIds.filter(pid => pid !== person.id);
              recalculateSplit();
            };
            label.appendChild(check);
            label.appendChild(document.createTextNode(person.name || `P${state.people.indexOf(person) + 1}`));
            assignEl.appendChild(label);
          });
        }
        card.querySelector('.bill-item-remove').addEventListener('click', () => removeItem(item.id));
        card.querySelectorAll('.cell-editable').forEach(el => {
          el.addEventListener('click', () => openEditModal(el.dataset.itemId, el.dataset.field || 'name'));
        });
        section.appendChild(card);
      });
      billSections.appendChild(section);
    });

    const total = state.items.reduce((s, i) => s + i.price, 0);
    const assigned = state.items.filter(i => i.assigneeIds.length > 0).reduce((s, i) => s + i.price, 0);
    tableMeta.textContent = `Total: $${total.toFixed(2)}${state.people.length ? ` · Assigned: $${assigned.toFixed(2)}` : ''}`;

    if (state.items.length > 0) show(tablePanel); else hide(tablePanel);
  }

  function openMerchantModal(receiptId) {
    const rec = state.receiptFiles.find(r => r.id === receiptId);
    if (!rec) return;
    state.editingReceiptId = receiptId;
    const input = document.getElementById('merchant-name-input');
    input.value = rec.merchantName;
    const modal = document.getElementById('merchant-modal');
    modal.classList.remove('hidden');
    input.focus();
  }

  function closeMerchantModal() {
    state.editingReceiptId = null;
    document.getElementById('merchant-modal').classList.add('hidden');
  }

  function saveMerchant() {
    if (!state.editingReceiptId) { closeMerchantModal(); return; }
    const input = document.getElementById('merchant-name-input');
    setMerchantName(state.editingReceiptId, input.value.trim());
    closeMerchantModal();
    renderBillSections();
    renderSummary();
  }

  function openEditModal(itemId, field) {
    const item = state.items.find(i => i.id === itemId);
    if (!item) return;
    state.editingItemId = itemId;
    if (editQuantity) editQuantity.value = String(item.quantity != null ? item.quantity : 1);
    editName.value = item.name;
    editPrice.value = item.price.toFixed(2);
    show(editModal);
    const focusEl = field === 'quantity' ? editQuantity : field === 'price' ? editPrice : editName;
    setTimeout(() => (focusEl || editName).focus(), 50);
  }

  function closeEditModal() {
    state.editingItemId = null;
    hide(editModal);
  }

  function saveEdit() {
    const item = state.items.find(i => i.id === state.editingItemId);
    if (!item) { closeEditModal(); return; }
    if (editQuantity) {
      const qty = parseInt(editQuantity.value, 10);
      if (!Number.isNaN(qty) && qty >= 1 && qty <= 99) item.quantity = qty;
    }
    const name = editName.value.trim();
    if (name) item.name = name;
    const price = parseFloat(editPrice.value);
    if (!Number.isNaN(price) && price >= 0) {
      item.price = price;
      item.uncertain = false;
    }
    closeEditModal();
    renderBillSections();
    renderSummary();
  }

  function addItemRow() {
    state.items.push({
      id: 'i' + state.nextItemId++,
      name: 'New item',
      price: 0,
      quantity: 1,
      uncertain: false,
      receiptId: null,
      assigneeIds: [],
    });
    renderBillSections();
    renderSummary();
  }

  function removeItem(id) {
    state.items = state.items.filter(i => i.id !== id);
    renderBillSections();
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

  function getPerPersonBreakdown() {
    const breakdown = {};
    state.people.forEach(p => { breakdown[p.id] = []; });
    state.items.forEach(item => {
      if (item.assigneeIds.length === 0) return;
      const share = item.price / item.assigneeIds.length;
      const merchant = item.receiptId ? getMerchantName(item.receiptId) : 'Other';
      item.assigneeIds.forEach(pid => {
        if (!breakdown[pid]) breakdown[pid] = [];
        const qty = item.quantity != null ? item.quantity : 1;
        const itemName = qty > 1 ? qty + '× ' + item.name : item.name;
        breakdown[pid].push({ merchant, itemName, amount: share });
      });
    });
    return breakdown;
  }

  function renderSummary() {
    const owed = computeSplit();
    const breakdown = getPerPersonBreakdown();
    summaryList.innerHTML = '';
    state.people.forEach((p, idx) => {
      const amount = owed[p.id] || 0;
      const lines = breakdown[p.id] || [];
      const byMerchant = {};
      lines.forEach(({ merchant, itemName, amount: amt }) => {
        if (!byMerchant[merchant]) byMerchant[merchant] = [];
        byMerchant[merchant].push({ itemName, amount: amt });
      });
      const card = document.createElement('div');
      card.className = 'summary-person-card';
      let breakdownHtml = '';
      Object.keys(byMerchant).forEach(merchant => {
        breakdownHtml += '<div class="breakdown-merchant">' + escapeHtml(merchant) + '</div>';
        byMerchant[merchant].forEach(({ itemName, amount: amt }) => {
          breakdownHtml += '<div class="breakdown-line">' + escapeHtml(itemName) + ' · $' + amt.toFixed(2) + '</div>';
        });
      });
      card.innerHTML = `
        <div class="summary-person-header">
          <span class="summary-person-name">${escapeHtml(p.name || `Person ${idx + 1}`)}</span>
          <span class="summary-person-amount">$${amount.toFixed(2)}</span>
        </div>
        ${breakdownHtml ? '<div class="summary-person-breakdown">' + breakdownHtml + '</div>' : ''}
      `;
      summaryList.appendChild(card);
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
   * Per-person expense list for image: { personName, lines: [{ label, amount, merchant }], subtotal }
   */
  function getPerPersonExpenses() {
    return state.people.map((p, idx) => {
      const name = p.name || `Person ${idx + 1}`;
      const lines = [];
      state.items.forEach(item => {
        if (!item.assigneeIds.includes(p.id)) return;
        const share = item.price / item.assigneeIds.length;
        const merchant = item.receiptId ? getMerchantName(item.receiptId) : '';
        const qty = item.quantity != null ? item.quantity : 1;
        const namePart = qty > 1 ? qty + '× ' + item.name : item.name;
        const label = item.assigneeIds.length > 1
          ? `${namePart} (${item.assigneeIds.length}-way split)`
          : namePart;
        lines.push({ label, amount: share, merchant });
      });
      const subtotal = lines.reduce((s, l) => s + l.amount, 0);
      return { personName: name, lines, subtotal };
    });
  }

  /**
   * Draw summary image — Apple-style, blue/purple theme, merchant in lines.
   */
  function drawSummaryCanvas() {
    const dpr = 2;
    const width = 420 * dpr;
    const padding = 32 * dpr;
    const lineHeight = 22 * dpr;
    const sectionGap = 32 * dpr;
    const fontTitle = `${20 * dpr}px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif`;
    const fontBrand = `${30 * dpr}px -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif`;
    const fontSub = `${15 * dpr}px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif`;
    const fontSmall = `${12 * dpr}px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif`;

    const data = getPerPersonExpenses();
    const blue = '#2563eb';
    const purple = '#7c3aed';
    const gray = '#3d3d3d';
    const grayLight = '#8e8e93';

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    let height = padding * 2 + lineHeight * 1.6 + lineHeight + sectionGap * 2;
    data.forEach(({ lines }) => {
      height += lineHeight * 1.5 + lines.length * lineHeight + lineHeight + sectionGap;
    });
    height += sectionGap + lineHeight * 2 + padding * 2;
    canvas.width = width;
    canvas.height = Math.max(480 * dpr, height);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, canvas.height);

    let y = padding * 2;

    // Brand — gradient text effect via fill
    ctx.font = fontBrand;
    ctx.fillStyle = blue;
    ctx.fillText('billzy', padding, y);
    y += lineHeight * 1.6;
    ctx.font = fontSmall;
    ctx.fillStyle = grayLight;
    ctx.fillText('Scan → Parse → Split. Instant, private, done.', padding, y);
    y += sectionGap;

    ctx.strokeStyle = '#e5e5ea';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding, y);
    ctx.lineTo(width - padding, y);
    ctx.stroke();
    y += sectionGap;

    data.forEach(({ personName, lines, subtotal }) => {
      ctx.font = fontTitle;
      ctx.fillStyle = gray;
      ctx.fillText(personName, padding, y);
      y += lineHeight * 1.5;

      const byMerchant = {};
      lines.forEach(l => {
        const m = l.merchant || 'Other';
        if (!byMerchant[m]) byMerchant[m] = [];
        byMerchant[m].push(l);
      });
      ctx.font = fontSub;
      Object.keys(byMerchant).forEach(merchant => {
        ctx.fillStyle = grayLight;
        ctx.font = fontSmall;
        ctx.fillText(merchant, padding, y);
        y += lineHeight * 0.85;
        ctx.font = fontSub;
        ctx.fillStyle = '#1c1c1e';
        byMerchant[merchant].forEach(({ label, amount }) => {
          const amtStr = `$${amount.toFixed(2)}`;
          const maxLabelW = width - padding * 2 - 85 * dpr;
          const truncated = ctx.measureText(label).width > maxLabelW
            ? label.slice(0, Math.floor(label.length * maxLabelW / ctx.measureText(label).width)) + '…'
            : label;
          ctx.fillText(truncated, padding, y);
          ctx.fillStyle = purple;
          ctx.fillText(amtStr, width - padding - ctx.measureText(amtStr).width, y);
          ctx.fillStyle = '#1c1c1e';
          y += lineHeight;
        });
      });

      ctx.font = fontSub;
      ctx.fillStyle = grayLight;
      ctx.fillText('Subtotal', padding, y);
      ctx.font = fontTitle;
      ctx.fillStyle = purple;
      const subStr = `$${subtotal.toFixed(2)}`;
      ctx.fillText(subStr, width - padding - ctx.measureText(subStr).width, y);
      y += lineHeight + sectionGap;
    });

    ctx.strokeStyle = '#e5e5ea';
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

  /**
   * Build GitHub issue body with uploaded files, parsed items, warnings, and browser info.
   * Opens GitHub new-issue page with pre-filled title and body.
   */
  function reportBug() {
    const title = 'Parsing issue: app unable to parse all information from receipt(s)';
    const lines = [];
    lines.push('### Description');
    lines.push('User reported the app was unable to parse all information from their receipt(s).');
    lines.push('');
    lines.push('**Please attach the receipt image(s) in a comment** to help reproduce.');
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('### Uploaded files');
    lines.push(`- **Count:** ${state.receiptFiles.length} / ${MAX_RECEIPTS} max`);
    state.receiptFiles.forEach((r, i) => {
      lines.push(`- ${i + 1}. \`${(r.file && r.file.name) || 'unknown'}\` — merchant: ${r.merchantName || '—'}`);
    });
    lines.push('');
    lines.push('### Parsed items (current page state)');
    if (state.items.length === 0) {
      lines.push('*No items parsed.*');
    } else {
      lines.push('| Qty | Name | Price | Merchant |');
      lines.push('|-----|------|-------|----------|');
      const maxRows = 40;
      state.items.slice(0, maxRows).forEach(item => {
        const qty = item.quantity != null ? item.quantity : 1;
        const merchant = item.receiptId ? getMerchantName(item.receiptId) : '—';
        const name = (item.name || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
        lines.push(`| ${qty} | ${name} | $${item.price.toFixed(2)} | ${merchant} |`);
      });
      if (state.items.length > maxRows) lines.push(`| … | *(${state.items.length - maxRows} more)* | | |`);
    }
    lines.push('');
    lines.push('### Parsing notes / warnings');
    if (state.warnings.length === 0) {
      lines.push('*None.*');
    } else {
      state.warnings.forEach(w => lines.push(`- ${w}`));
    }
    lines.push('');
    lines.push('### People & split summary');
    if (state.people.length === 0) {
      lines.push('*No people added.*');
    } else {
      const owed = computeSplit();
      state.people.forEach((p, idx) => {
        const name = p.name || `Person ${idx + 1}`;
        const amount = (owed[p.id] || 0).toFixed(2);
        lines.push(`- **${name}:** $${amount}`);
      });
    }
    lines.push('');
    lines.push('### Environment');
    lines.push(`- **Browser:** \`${navigator.userAgent}\``);
    lines.push(`- **Reported at:** ${new Date().toISOString()}`);
    const body = lines.join('\n');
    const url = `https://github.com/${GITHUB_REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
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

  const recalculateBtn = document.getElementById('recalculate-split-btn');
  if (recalculateBtn) recalculateBtn.addEventListener('click', recalculateSplit);

  const merchantModal = document.getElementById('merchant-modal');
  const merchantBackdrop = document.getElementById('merchant-modal-backdrop');
  const merchantNameInput = document.getElementById('merchant-name-input');
  const merchantCancel = document.getElementById('merchant-cancel');
  const merchantSave = document.getElementById('merchant-save');
  if (merchantBackdrop) merchantBackdrop.addEventListener('click', closeMerchantModal);
  if (merchantCancel) merchantCancel.addEventListener('click', closeMerchantModal);
  if (merchantSave) merchantSave.addEventListener('click', saveMerchant);
  if (merchantModal) merchantModal.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMerchantModal(); });

  copyBtn.addEventListener('click', copyResult);
  downloadCsvBtn.addEventListener('click', downloadCsv);
  const downloadImageBtn = document.getElementById('download-image-btn');
  if (downloadImageBtn) downloadImageBtn.addEventListener('click', downloadSummaryImage);

  const reportBugBtn = document.getElementById('report-bug-btn');
  if (reportBugBtn) reportBugBtn.addEventListener('click', reportBug);

  const maxReceiptsNum = document.getElementById('max-receipts-num');
  if (maxReceiptsNum) maxReceiptsNum.textContent = String(MAX_RECEIPTS);

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
