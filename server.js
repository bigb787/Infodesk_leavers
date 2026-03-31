const express = require('express');
const ExcelJS = require('exceljs');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const { db, insertAuditTrail, CHECKLIST_ITEMS } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

const uploadsDir = path.join(__dirname, 'uploads', 'evidence');
fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const stamp = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const safeName = String(file.originalname || 'evidence').replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${stamp}-${safeName}`);
  },
});

const upload = multer({ storage });

app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

function getChecklistItems() {
  return db.prepare('SELECT * FROM checklist_items ORDER BY display_order').all();
}

function getLeaverById(id) {
  return db.prepare('SELECT * FROM leavers WHERE id = ?').get(id);
}

function getLeaverEntries(leaverId) {
  return db.prepare(`
    SELECT e.*, c.item_key, c.item_label, c.display_order
    FROM leaver_checklist_entries e
    JOIN checklist_items c ON c.id = e.checklist_item_id
    WHERE e.leaver_id = ?
    ORDER BY c.display_order
  `).all(leaverId);
}

function buildLeaverPayload(leaver) {
  if (!leaver) return null;
  return {
    ...leaver,
    checklist: getLeaverEntries(leaver.id),
  };
}

function ensureBaseLeaverFields(body) {
  const employeeName = String(body.employee_name || '').trim();
  const dateOfLeaving = String(body.date_of_leaving || '').trim();
  if (!employeeName || !dateOfLeaving) {
    return { error: 'employee_name and date_of_leaving are required' };
  }
  return {
    employee_name: employeeName,
    date_of_leaving: dateOfLeaving,
    department: String(body.department || '').trim() || null,
    line_manager: String(body.line_manager || '').trim() || null,
  };
}

function upsertChecklistEntries(leaverId, entries) {
  if (!Array.isArray(entries)) return;
  const validItems = new Map(getChecklistItems().map((item) => [item.item_key, item]));
  const stmt = db.prepare(`
    INSERT INTO leaver_checklist_entries (
      leaver_id, checklist_item_id, access_removed, evidence_link, evidence_path, notes, updated_at
    ) VALUES (
      @leaver_id, @checklist_item_id, @access_removed, @evidence_link, @evidence_path, @notes, datetime('now')
    )
    ON CONFLICT(leaver_id, checklist_item_id) DO UPDATE SET
      access_removed = excluded.access_removed,
      evidence_link = excluded.evidence_link,
      evidence_path = COALESCE(excluded.evidence_path, leaver_checklist_entries.evidence_path),
      notes = excluded.notes,
      updated_at = datetime('now')
  `);

  entries.forEach((entry) => {
    const item = validItems.get(String(entry.item_key || '').trim());
    if (!item) return;
    stmt.run({
      leaver_id: leaverId,
      checklist_item_id: item.id,
      access_removed: entry.access_removed == null || entry.access_removed === '' ? null : String(entry.access_removed),
      evidence_link: entry.evidence_link ? String(entry.evidence_link).trim() : null,
      evidence_path: entry.evidence_path ? String(entry.evidence_path).trim() : null,
      notes: entry.notes ? String(entry.notes).trim() : null,
    });
  });
}

app.get('/api/metadata/checklist-items', (_req, res) => {
  res.json(getChecklistItems());
});

app.get('/api/leavers', (_req, res) => {
  const rows = db.prepare('SELECT * FROM leavers ORDER BY id DESC').all();
  res.json(rows.map(buildLeaverPayload));
});

app.post('/api/leavers', (req, res) => {
  const base = ensureBaseLeaverFields(req.body || {});
  if (base.error) return res.status(400).json({ error: base.error });

  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO leavers (employee_name, date_of_leaving, department, line_manager)
      VALUES (@employee_name, @date_of_leaving, @department, @line_manager)
    `).run(base);
    const leaver = getLeaverById(info.lastInsertRowid);
    upsertChecklistEntries(leaver.id, req.body?.checklist);
    const payload = buildLeaverPayload(leaver);
    insertAuditTrail({
      entity_table: 'leavers',
      entity_id: leaver.id,
      action_type: 'CREATE',
      previous_value: null,
      new_value: JSON.stringify(payload),
      changed_by: 'system',
    });
    return payload;
  });

  res.status(201).json(tx());
});

app.patch('/api/leavers/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const prev = buildLeaverPayload(getLeaverById(id));
  if (!prev) return res.status(404).json({ error: 'record not found' });

  const base = ensureBaseLeaverFields(req.body || {});
  if (base.error) return res.status(400).json({ error: base.error });

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE leavers
      SET employee_name = @employee_name,
          date_of_leaving = @date_of_leaving,
          department = @department,
          line_manager = @line_manager,
          updated_at = datetime('now')
      WHERE id = @id
    `).run({ ...base, id });
    upsertChecklistEntries(id, req.body?.checklist);
    const next = buildLeaverPayload(getLeaverById(id));
    insertAuditTrail({
      entity_table: 'leavers',
      entity_id: id,
      action_type: 'UPDATE',
      previous_value: JSON.stringify(prev),
      new_value: JSON.stringify(next),
      changed_by: 'system',
    });
    return next;
  });

  res.json(tx());
});

app.delete('/api/leavers/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const prev = buildLeaverPayload(getLeaverById(id));
  if (!prev) return res.status(404).json({ error: 'record not found' });

  const tx = db.transaction(() => {
    insertAuditTrail({
      entity_table: 'leavers',
      entity_id: id,
      action_type: 'DELETE',
      previous_value: JSON.stringify(prev),
      new_value: null,
      changed_by: 'system',
    });
    db.prepare('DELETE FROM leavers WHERE id = ?').run(id);
  });

  tx();
  res.status(204).send();
});

app.post('/api/leavers/:id/evidence', upload.single('evidence'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  if (!getLeaverById(id)) return res.status(404).json({ error: 'record not found' });

  const itemKey = String(req.body?.item_key || '').trim();
  const item = getChecklistItems().find((row) => row.item_key === itemKey);
  if (!item) return res.status(400).json({ error: 'invalid item_key' });
  if (!req.file) return res.status(400).json({ error: 'evidence file is required' });

  const evidencePath = `/uploads/evidence/${req.file.filename}`;
  upsertChecklistEntries(id, [{ item_key: itemKey, evidence_path: evidencePath }]);
  res.json({ ok: true, evidence_path: evidencePath });
});

app.get('/api/export/leavers.xlsx', async (_req, res) => {
  const leavers = db.prepare('SELECT * FROM leavers ORDER BY id DESC').all().map(buildLeaverPayload);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Infodesk Leavers';
  const sheet = workbook.addWorksheet('Leavers', { properties: { defaultColWidth: 24 } });

  const columns = [
    { header: 'Employee Name', key: 'employee_name', width: 24 },
    { header: 'Date of Leaving', key: 'date_of_leaving', width: 18 },
    { header: 'Department', key: 'department', width: 18 },
    { header: 'Line Manager', key: 'line_manager', width: 20 },
  ];

  CHECKLIST_ITEMS.forEach((item) => {
    columns.push({ header: `${item.label} - Access Removed`, key: `${item.key}_access_removed`, width: 18 });
    columns.push({ header: `${item.label} - Evidence Link`, key: `${item.key}_evidence_link`, width: 26 });
    columns.push({ header: `${item.label} - Evidence File`, key: `${item.key}_evidence_path`, width: 26 });
    columns.push({ header: `${item.label} - Notes`, key: `${item.key}_notes`, width: 24 });
  });
  sheet.columns = columns;

  leavers.forEach((leaver) => {
    const row = {
      employee_name: leaver.employee_name,
      date_of_leaving: leaver.date_of_leaving,
      department: leaver.department,
      line_manager: leaver.line_manager,
    };

    leaver.checklist.forEach((entry) => {
      row[`${entry.item_key}_access_removed`] = entry.access_removed || '';
      row[`${entry.item_key}_evidence_link`] = entry.evidence_link || '';
      row[`${entry.item_key}_evidence_path`] = entry.evidence_path || '';
      row[`${entry.item_key}_notes`] = entry.notes || '';
    });

    sheet.addRow(row);
  });

  sheet.getRow(1).font = { bold: true };
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="infodesk-leavers.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
});

app.get('/api/audit', (_req, res) => {
  const rows = db.prepare('SELECT * FROM audit_trail ORDER BY id DESC LIMIT 100').all();
  res.json(rows);
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

app.listen(PORT, () => {
  console.log(`Infodesk Leavers app listening at http://localhost:${PORT}`);
});
