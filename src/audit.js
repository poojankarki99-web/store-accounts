'use strict';

const { pool } = require('./db');

// Record one field-level change. oldVal/newVal stored as text for portability.
async function auditEdit({ entryType, entryId, fieldName, oldValue, newValue, editedBy }) {
  const ov = oldValue === null || oldValue === undefined ? null : String(oldValue);
  const nv = newValue === null || newValue === undefined ? null : String(newValue);
  if (ov === nv) return null;
  const { rows } = await pool.query(
    `INSERT INTO edit_audit (entry_type, entry_id, field_name, old_value, new_value, edited_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [entryType, entryId, fieldName, ov, nv, editedBy]
  );
  return rows[0].id;
}

// Apply a set of field changes to a row and audit each change.
// table: table name, idCol: pk column, id: pk value, changes: {field: newValue}, current: current row object.
async function applyAuditedUpdate({ table, idCol = 'id', id, entryType, changes, current, editedBy }) {
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [field, newVal] of Object.entries(changes)) {
    if (newVal === undefined) continue;
    const oldVal = current[field];
    const norm = (v) => (v === null || v === undefined ? null : String(v));
    if (norm(oldVal) === norm(newVal)) continue;
    sets.push(`${field} = $${i++}`);
    vals.push(newVal);
    await auditEdit({ entryType, entryId: id, fieldName: field, oldValue: oldVal, newValue: newVal, editedBy });
  }
  if (!sets.length) return { updated: false };
  vals.push(id);
  await pool.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${idCol} = $${i}`, vals);
  return { updated: true };
}

module.exports = { auditEdit, applyAuditedUpdate };
