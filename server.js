const express = require('express');
const { GetObjectCommand, PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');
const ExcelJS = require('exceljs');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const { db, insertAuditTrail, CHECKLIST_ITEMS } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const HARDWARE_EVIDENCE_KEY = 'hardware_evidence_collected';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const EVIDENCE_BUCKET = process.env.EVIDENCE_BUCKET || process.env.BACKUP_BUCKET || '';
const APP_BASE_URL = String(process.env.APP_BASE_URL || '').replace(/\/$/, '');

const uploadsDir = path.join(__dirname, 'uploads', 'evidence');
fs.mkdirSync(uploadsDir, { recursive: true });
const s3 = new S3Client({ region: AWS_REGION });

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

function getChecklistEntry(leaverId, itemKey) {
  return db.prepare(`
    SELECT e.*, c.item_key, c.item_label, c.display_order
    FROM leaver_checklist_entries e
    JOIN checklist_items c ON c.id = e.checklist_item_id
    WHERE e.leaver_id = ? AND c.item_key = ?
    LIMIT 1
  `).get(leaverId, itemKey);
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

function buildEvidenceLinkForLeaver(req, leaverId) {
  const relativeEvidenceLink = `/api/leavers/${leaverId}/evidence/${HARDWARE_EVIDENCE_KEY}/file`;
  if (APP_BASE_URL) return `${APP_BASE_URL}${relativeEvidenceLink}`;
  return `${req.protocol}://${req.get('host')}${relativeEvidenceLink}`;
}

function normalizeImportedChecklist(req, leaverId, row) {
  const entries = CHECKLIST_ITEMS.map((item) => {
    const prefix = item.key;
    const accessRemoved = row[`${prefix}_access_removed`] ?? row[`${item.label} - Access Removed`];
    const evidenceLinkRaw = row[`${prefix}_evidence_link`] ?? row[`${item.label} - Evidence Link`];
    const evidencePathRaw = row[`${prefix}_evidence_path`] ?? row[`${item.label} - Evidence File`];
    const notes = row[`${prefix}_notes`] ?? row[`${item.label} - Notes`];

    let evidenceLink = evidenceLinkRaw ? String(evidenceLinkRaw).trim() : null;
    let evidencePath = evidencePathRaw ? String(evidencePathRaw).trim() : null;

    if (item.key === HARDWARE_EVIDENCE_KEY) {
      if (evidencePath && !evidencePath.startsWith('evidence/')) {
        evidencePath = null;
      }
      if (!evidencePath && evidenceLink && evidenceLink.startsWith('evidence/')) {
        evidencePath = evidenceLink;
      }
      if (evidencePath) {
        evidenceLink = buildEvidenceLinkForLeaver(req, leaverId);
      }
    } else {
      evidenceLink = null;
      evidencePath = null;
    }

    return {
      item_key: item.key,
      access_removed: accessRemoved == null ? null : String(accessRemoved).trim(),
      evidence_link: evidenceLink,
      evidence_path: evidencePath,
      notes: notes == null ? null : String(notes).trim(),
    };
  });

  return entries;
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
    const allowsEvidence = item.item_key === HARDWARE_EVIDENCE_KEY;
    stmt.run({
      leaver_id: leaverId,
      checklist_item_id: item.id,
      access_removed: entry.access_removed == null || entry.access_removed === '' ? null : String(entry.access_removed),
      evidence_link: allowsEvidence && entry.evidence_link ? String(entry.evidence_link).trim() : null,
      evidence_path: allowsEvidence && entry.evidence_path ? String(entry.evidence_path).trim() : null,
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
  Promise.resolve().then(async () => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  if (!getLeaverById(id)) return res.status(404).json({ error: 'record not found' });

  const itemKey = String(req.body?.item_key || '').trim();
  const item = getChecklistItems().find((row) => row.item_key === itemKey);
  if (!item) return res.status(400).json({ error: 'invalid item_key' });
  if (item.item_key !== HARDWARE_EVIDENCE_KEY) {
    return res.status(400).json({ error: 'file upload is allowed only for Evidence for Hardware Collected Back' });
  }
  if (!req.file) return res.status(400).json({ error: 'evidence file is required' });
  if (!EVIDENCE_BUCKET) return res.status(500).json({ error: 'evidence bucket is not configured' });

  const objectKey = `evidence/${id}/${req.file.filename}`;
  const fileBuffer = fs.readFileSync(req.file.path);
  await s3.send(new PutObjectCommand({
    Bucket: EVIDENCE_BUCKET,
    Key: objectKey,
    Body: fileBuffer,
    ContentType: req.file.mimetype || 'application/octet-stream',
  }));
  fs.unlinkSync(req.file.path);
  const evidencePath = objectKey;
  const evidenceLink = buildEvidenceLinkForLeaver(req, id);
  upsertChecklistEntries(id, [{
    item_key: itemKey,
    evidence_path: evidencePath,
    evidence_link: evidenceLink,
  }]);
  res.json({ ok: true, evidence_path: evidencePath, evidence_link: evidenceLink });
  }).catch((err) => {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    console.error(err);
    res.status(500).json({ error: 'failed to upload evidence to s3' });
  });
});

app.post('/api/import/leavers', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'excel file is required' });

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    const sheet = workbook.worksheets[0];
    if (!sheet) return res.status(400).json({ error: 'workbook must contain at least one sheet' });

    const headerRow = sheet.getRow(1);
    const headers = headerRow.values.slice(1).map((value) => String(value || '').trim());
    const imported = [];

    const tx = db.transaction(() => {
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        const values = row.values.slice(1);
        if (!values.some((value) => String(value || '').trim())) continue;

        const record = {};
        headers.forEach((header, index) => {
          record[header] = values[index];
        });

        const base = ensureBaseLeaverFields({
          employee_name: record.employee_name ?? record['Employee Name'],
          date_of_leaving: record.date_of_leaving ?? record['Date of Leaving'],
          department: record.department ?? record['Department'],
          line_manager: record.line_manager ?? record['Line Manager'],
        });
        if (base.error) {
          throw new Error(`Row ${rowNumber}: ${base.error}`);
        }

        const info = db.prepare(`
          INSERT INTO leavers (employee_name, date_of_leaving, department, line_manager)
          VALUES (@employee_name, @date_of_leaving, @department, @line_manager)
        `).run(base);
        const leaverId = info.lastInsertRowid;
        const checklist = normalizeImportedChecklist(req, leaverId, record);
        upsertChecklistEntries(leaverId, checklist);
        const payload = buildLeaverPayload(getLeaverById(leaverId));
        insertAuditTrail({
          entity_table: 'leavers',
          entity_id: leaverId,
          action_type: 'CREATE',
          previous_value: null,
          new_value: JSON.stringify(payload),
          changed_by: 'import',
        });
        imported.push(payload);
      }
    });

    tx();
    res.json({ ok: true, imported_count: imported.length });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message || 'failed to import excel file' });
  } finally {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  }
});

app.get('/api/leavers/:id/evidence/:itemKey/file', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const itemKey = String(req.params.itemKey || '').trim();
  if (itemKey !== HARDWARE_EVIDENCE_KEY) {
    return res.status(400).json({ error: 'invalid evidence item' });
  }
  if (!EVIDENCE_BUCKET) return res.status(500).json({ error: 'evidence bucket is not configured' });

  const entry = getChecklistEntry(id, itemKey);
  if (!entry?.evidence_path) {
    return res.status(404).json({ error: 'evidence file not found' });
  }

  try {
    const result = await s3.send(new GetObjectCommand({
      Bucket: EVIDENCE_BUCKET,
      Key: entry.evidence_path,
    }));
    res.setHeader('Content-Type', result.ContentType || 'application/octet-stream');
    const fileName = path.basename(entry.evidence_path);
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    result.Body.pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to read evidence from s3' });
  }
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
