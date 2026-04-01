const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'infodesk_leavers.sqlite');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const CHECKLIST_ITEMS = [
  { key: 'email_address', label: 'Email Address' },
  { key: 'email_groups', label: 'Email Groups' },
  { key: 'infodesk_qa_dev', label: 'InfoDesk QA/Dev' },
  { key: 'infodesk_v7', label: 'InfoDesk V7' },
  { key: 'jira_and_wiki', label: 'JIRA and Wiki' },
  { key: 'ms_office', label: 'MS Office' },
  { key: 'atlas_mongo_access', label: 'Mongo Access' },
  { key: 'aws', label: 'AWS' },
  { key: 'azure', label: 'Azure' },
  { key: 'infodesk_vpn', label: 'InfoDesk VPN' },
  { key: 'wn_vpn', label: 'WN VPN' },
  { key: 'azure_devops', label: 'Azure Devops' },
  { key: 'infoadmin', label: 'InfoAdmin' },
  { key: 'zabbix', label: 'Zabbix' },
  { key: 'infodesk_wn_github', label: 'GitHub' },
  { key: 'infodesk_portal', label: 'InfoDesk Portal (send to Support)' },
  { key: 'salesforce', label: 'Salesforce (send to Support)' },
  { key: 'hw_inventory_handed_over', label: 'HW Inventory Handed Over at Location?' },
  { key: 'hardware_evidence_collected', label: 'Evidence for Hardware Collected Back' },
  { key: 'it_peer_review', label: 'IT Peer Review' },
  { key: 'reporting_manager_confirmation', label: 'Reporting Manager Confirmation' },
  { key: 'audit', label: 'Audit' },
  { key: 'communication_ticket', label: 'Communication/GitHub Ticket' },
];

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS leavers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_name TEXT NOT NULL,
      date_of_leaving TEXT NOT NULL,
      department TEXT,
      line_manager TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS checklist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_key TEXT NOT NULL UNIQUE,
      item_label TEXT NOT NULL,
      display_order INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS leaver_checklist_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      leaver_id INTEGER NOT NULL REFERENCES leavers(id) ON DELETE CASCADE,
      checklist_item_id INTEGER NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
      access_removed TEXT,
      evidence_link TEXT,
      evidence_path TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(leaver_id, checklist_item_id)
    );

    CREATE TABLE IF NOT EXISTS audit_trail (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_table TEXT NOT NULL,
      entity_id INTEGER,
      action_type TEXT NOT NULL,
      previous_value TEXT,
      new_value TEXT,
      changed_by TEXT NOT NULL DEFAULT 'system',
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function seedChecklistItems() {
  const insert = db.prepare(`
    INSERT INTO checklist_items (item_key, item_label, display_order)
    VALUES (?, ?, ?)
    ON CONFLICT(item_key) DO UPDATE SET
      item_label = excluded.item_label,
      display_order = excluded.display_order
  `);

  const tx = db.transaction(() => {
    CHECKLIST_ITEMS.forEach((item, index) => {
      insert.run(item.key, item.label, index + 1);
    });
  });

  tx();
}

function insertAuditTrail(row) {
  db.prepare(`
    INSERT INTO audit_trail (entity_table, entity_id, action_type, previous_value, new_value, changed_by)
    VALUES (@entity_table, @entity_id, @action_type, @previous_value, @new_value, @changed_by)
  `).run({
    entity_table: row.entity_table,
    entity_id: row.entity_id,
    action_type: row.action_type,
    previous_value: row.previous_value,
    new_value: row.new_value,
    changed_by: row.changed_by ?? 'system',
  });
}

initSchema();
seedChecklistItems();

module.exports = { db, insertAuditTrail, CHECKLIST_ITEMS };
