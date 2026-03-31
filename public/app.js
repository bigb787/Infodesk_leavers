const $ = (sel) => document.querySelector(sel);

let checklistItems = [];
let leavers = [];
let selectedLeaverId = null;
let editingLeaverId = null;
const HARDWARE_EVIDENCE_KEY = 'hardware_evidence_collected';

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(data?.error || res.statusText || 'Request failed');
  return data;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getSelectedLeaver() {
  return leavers.find((row) => row.id === selectedLeaverId) || null;
}

function renderLeavers() {
  const tbody = $('#leaver-rows');
  if (!leavers.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No records yet.</td></tr>';
    return;
  }
  tbody.innerHTML = leavers.map((row) => `
    <tr>
      <td>
        <div class="row-actions">
          <button class="btn secondary edit-row" data-id="${row.id}">Edit</button>
          <button class="btn secondary checklist-row" data-id="${row.id}">Manage Checklist</button>
          <button class="btn danger delete-row" data-id="${row.id}">Delete</button>
        </div>
      </td>
      <td>${escapeHtml(row.employee_name)}</td>
      <td>${escapeHtml(row.date_of_leaving)}</td>
      <td>${escapeHtml(row.department || '—')}</td>
      <td>${escapeHtml(row.line_manager || '—')}</td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.edit-row').forEach((btn) => btn.addEventListener('click', onEditLeaver));
  tbody.querySelectorAll('.checklist-row').forEach((btn) => btn.addEventListener('click', onManageChecklist));
  tbody.querySelectorAll('.delete-row').forEach((btn) => btn.addEventListener('click', onDeleteLeaver));
}

function renderChecklist() {
  const leaver = getSelectedLeaver();
  $('#checklist-title').textContent = leaver
    ? `Checklist Details: ${leaver.employee_name}`
    : 'Checklist Details';

  const entriesByKey = new Map((leaver?.checklist || []).map((entry) => [entry.item_key, entry]));
  $('#checklist-rows').innerHTML = checklistItems.map((item) => {
    const entry = entriesByKey.get(item.item_key) || {};
    const allowsEvidence = item.item_key === HARDWARE_EVIDENCE_KEY;
    const fileHtml = entry.evidence_path
      ? `<a href="${escapeHtml(entry.evidence_path)}" target="_blank">Open file</a>`
      : '—';
    const locationHtml = entry.evidence_link
      ? `<a href="${escapeHtml(entry.evidence_link)}" target="_blank">Open stored evidence link</a>`
      : (allowsEvidence ? 'Upload a file to generate the stored location link.' : '—');
    return `
      <tr data-item-key="${escapeHtml(item.item_key)}">
        <td>${escapeHtml(item.item_label)}</td>
        <td>
          <select class="entry-access">
            <option value="">Select</option>
            <option value="Yes"${entry.access_removed === 'Yes' ? ' selected' : ''}>Yes</option>
            <option value="No"${entry.access_removed === 'No' ? ' selected' : ''}>No</option>
            <option value="NA"${entry.access_removed === 'NA' ? ' selected' : ''}>NA</option>
          </select>
        </td>
        <td>${locationHtml}<input class="entry-link" type="hidden" value="${escapeHtml(entry.evidence_link || '')}" /></td>
        <td>${fileHtml}</td>
        <td><textarea class="entry-notes">${escapeHtml(entry.notes || '')}</textarea></td>
        <td>
          ${allowsEvidence
            ? '<input class="entry-file" type="file" /><button class="btn secondary upload-btn" type="button">Upload</button>'
            : '—'}
        </td>
      </tr>
    `;
  }).join('');

  $('#checklist-rows').querySelectorAll('.upload-btn').forEach((btn) => {
    btn.addEventListener('click', onUploadEvidence);
  });
}

function renderAudit(entries) {
  $('#audit-list').innerHTML = entries.length
    ? entries.map((row) => `<li><strong>${escapeHtml(row.action_type)}</strong> ${escapeHtml(row.entity_table)} #${row.entity_id} at ${escapeHtml(row.timestamp)}</li>`).join('')
    : '<li>No audit entries yet.</li>';
}

function fillLeaverForm(leaver) {
  $('#employee-name').value = leaver?.employee_name || '';
  $('#date-of-leaving').value = leaver?.date_of_leaving || '';
  $('#department').value = leaver?.department || '';
  $('#line-manager').value = leaver?.line_manager || '';
}

function clearForm() {
  editingLeaverId = null;
  fillLeaverForm(null);
}

async function loadData() {
  const [items, rows, audit] = await Promise.all([
    fetchJSON('/api/metadata/checklist-items'),
    fetchJSON('/api/leavers'),
    fetchJSON('/api/audit'),
  ]);
  checklistItems = items;
  leavers = rows;
  renderLeavers();

  if (!selectedLeaverId && leavers.length) {
    selectedLeaverId = leavers[0].id;
  }
  if (selectedLeaverId && !getSelectedLeaver()) {
    selectedLeaverId = leavers[0]?.id || null;
  }
  renderChecklist();
  renderAudit(audit);
}

$('#leaver-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const body = {
    employee_name: $('#employee-name').value.trim(),
    date_of_leaving: $('#date-of-leaving').value,
    department: $('#department').value.trim(),
    line_manager: $('#line-manager').value.trim(),
    checklist: getSelectedLeaver()?.checklist || [],
  };

  const url = editingLeaverId ? `/api/leavers/${editingLeaverId}` : '/api/leavers';
  const method = editingLeaverId ? 'PATCH' : 'POST';

  try {
    const saved = await fetchJSON(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    selectedLeaverId = saved.id;
    editingLeaverId = null;
    clearForm();
    await loadData();
  } catch (err) {
    alert(err.message);
  }
});

$('#clear-btn').addEventListener('click', clearForm);

async function onEditLeaver(ev) {
  const id = Number(ev.target.getAttribute('data-id'));
  const leaver = leavers.find((row) => row.id === id);
  if (!leaver) return;
  editingLeaverId = id;
  selectedLeaverId = id;
  fillLeaverForm(leaver);
  renderChecklist();
}

async function onManageChecklist(ev) {
  selectedLeaverId = Number(ev.target.getAttribute('data-id'));
  renderChecklist();
}

async function onDeleteLeaver(ev) {
  const id = Number(ev.target.getAttribute('data-id'));
  if (!confirm('Delete this leaver record?')) return;
  try {
    await fetchJSON(`/api/leavers/${id}`, { method: 'DELETE' });
    if (selectedLeaverId === id) selectedLeaverId = null;
    if (editingLeaverId === id) clearForm();
    await loadData();
  } catch (err) {
    alert(err.message);
  }
}

$('#save-checklist-btn').addEventListener('click', async () => {
  const leaver = getSelectedLeaver();
  if (!leaver) {
    alert('Save or select a leaver record first.');
    return;
  }
  const checklist = Array.from($('#checklist-rows').querySelectorAll('tr')).map((tr) => ({
    item_key: tr.getAttribute('data-item-key'),
    access_removed: tr.querySelector('.entry-access').value,
    evidence_link: tr.querySelector('.entry-link').value.trim(),
    evidence_path: leaver.checklist.find((entry) => entry.item_key === tr.getAttribute('data-item-key'))?.evidence_path || '',
    notes: tr.querySelector('.entry-notes').value.trim(),
  }));

  try {
    await fetchJSON(`/api/leavers/${leaver.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employee_name: leaver.employee_name,
        date_of_leaving: leaver.date_of_leaving,
        department: leaver.department || '',
        line_manager: leaver.line_manager || '',
        checklist,
      }),
    });
    await loadData();
  } catch (err) {
    alert(err.message);
  }
});

async function onUploadEvidence(ev) {
  const leaver = getSelectedLeaver();
  if (!leaver) {
    alert('Save or select a leaver record first.');
    return;
  }
  const row = ev.target.closest('tr');
  if (row.getAttribute('data-item-key') !== HARDWARE_EVIDENCE_KEY) {
    alert('Upload is available only for Evidence for Hardware Collected Back.');
    return;
  }
  const fileInput = row.querySelector('.entry-file');
  if (!fileInput.files.length) {
    alert('Choose a file first.');
    return;
  }
  const formData = new FormData();
  formData.append('item_key', row.getAttribute('data-item-key'));
  formData.append('evidence', fileInput.files[0]);

  try {
    const result = await fetchJSON(`/api/leavers/${leaver.id}/evidence`, {
      method: 'POST',
      body: formData,
    });
    row.querySelector('.entry-link').value = result.evidence_link || '';
    await loadData();
  } catch (err) {
    alert(err.message);
  }
}

loadData().catch((err) => alert(err.message));
