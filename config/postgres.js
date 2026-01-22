const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { encrypt, decrypt } = require('../src/utils/encryption');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initializeDatabase() {
  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    await pool.query(schema);
    console.log('[Database] PostgreSQL schema initialized');
  } catch (error) {
    console.error('[Database] Error initializing schema:', error.message);
    throw error;
  }
}

function normalizeUserId(id) {
  if (!id) return id;
  let normalized = id.toString();
  normalized = normalized.replace(/^https?:\/\//, '');
  normalized = normalized.replace(/\.pipedrive\.com$/, '');
  return normalized;
}

async function getUser(userId) {
  const normalized = normalizeUserId(userId);
  const possibleIds = [userId, normalized, `${normalized}.pipedrive.com`];
  
  // First try exact match on pipedrive_user_id
  for (const tryId of [...new Set(possibleIds.filter(id => id))]) {
    const result = await pool.query(
      'SELECT * FROM users WHERE pipedrive_user_id = $1',
      [tryId]
    );
    if (result.rows.length > 0) {
      return rowToUserData(result.rows[0]);
    }
  }
  
  // Fallback: search by pipedrive_api_domain (for cases where userId is domain but stored ID is numeric)
  for (const tryId of [...new Set(possibleIds.filter(id => id))]) {
    const result = await pool.query(
      'SELECT * FROM users WHERE pipedrive_api_domain ILIKE $1 OR pipedrive_api_domain ILIKE $2',
      [`%${tryId}%`, `%${normalized}%`]
    );
    if (result.rows.length > 0) {
      return rowToUserData(result.rows[0]);
    }
  }
  
  return null;
}

async function setUser(userId, data) {
  const normalized = normalizeUserId(userId);
  
  const existing = await pool.query(
    'SELECT id FROM users WHERE pipedrive_user_id = $1',
    [normalized]
  );
  
  const pipedriveAccessToken = encrypt(data.pipedrive_access_token || data.access_token);
  const pipedriveRefreshToken = encrypt(data.pipedrive_refresh_token || data.refresh_token);
  const qbAccessToken = encrypt(data.qb_access_token);
  const qbRefreshToken = encrypt(data.qb_refresh_token);
  
  if (existing.rows.length > 0) {
    await pool.query(`
      UPDATE users SET
        pipedrive_access_token = $2,
        pipedrive_refresh_token = $3,
        pipedrive_expires_at = $4,
        pipedrive_api_domain = $5,
        qb_access_token = $6,
        qb_refresh_token = $7,
        qb_realm_id = $8,
        qb_expires_at = $9,
        qb_last_refresh = $10,
        shipstation_api_key = $11,
        shipstation_api_secret = $12,
        shipstation_auto_create = $13,
        shipstation_connected_at = $14,
        invoice_item_field = $15,
        invoice_qty_field = $16,
        invoice_price_field = $17,
        setup_completed = $18,
        setup_completed_at = $19,
        setup_token = $20,
        setup_token_expires = $21,
        invoice_preferences = $22
      WHERE pipedrive_user_id = $1
    `, [
      normalized,
      pipedriveAccessToken,
      pipedriveRefreshToken,
      data.pipedrive_expires_at || data.expires_at ? new Date(data.pipedrive_expires_at || data.expires_at) : null,
      data.pipedrive_api_domain || data.api_domain,
      qbAccessToken,
      qbRefreshToken,
      data.qb_realm_id,
      data.qb_expires_at ? new Date(data.qb_expires_at) : null,
      data.qb_last_refresh ? new Date(data.qb_last_refresh) : null,
      data.shipstation_api_key,
      data.shipstation_api_secret,
      data.shipstation_auto_create || false,
      data.shipstation_connected_at ? new Date(data.shipstation_connected_at) : null,
      data.invoice_item_field,
      data.invoice_qty_field,
      data.invoice_price_field,
      data.setup_completed || false,
      data.setup_completed_at ? new Date(data.setup_completed_at) : null,
      data.setup_token || null,
      data.setup_token_expires ? new Date(data.setup_token_expires) : null,
      data.invoice_preferences ? JSON.stringify(data.invoice_preferences) : null
    ]);
  } else {
    await pool.query(`
      INSERT INTO users (
        pipedrive_user_id,
        pipedrive_access_token,
        pipedrive_refresh_token,
        pipedrive_expires_at,
        pipedrive_api_domain,
        qb_access_token,
        qb_refresh_token,
        qb_realm_id,
        qb_expires_at,
        qb_last_refresh,
        shipstation_api_key,
        shipstation_api_secret,
        shipstation_auto_create,
        shipstation_connected_at,
        invoice_item_field,
        invoice_qty_field,
        invoice_price_field,
        setup_completed,
        setup_completed_at,
        setup_token,
        setup_token_expires,
        invoice_preferences
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
    `, [
      normalized,
      pipedriveAccessToken,
      pipedriveRefreshToken,
      data.pipedrive_expires_at || data.expires_at ? new Date(data.pipedrive_expires_at || data.expires_at) : null,
      data.pipedrive_api_domain || data.api_domain,
      qbAccessToken,
      qbRefreshToken,
      data.qb_realm_id,
      data.qb_expires_at ? new Date(data.qb_expires_at) : null,
      data.qb_last_refresh ? new Date(data.qb_last_refresh) : null,
      data.shipstation_api_key,
      data.shipstation_api_secret,
      data.shipstation_auto_create || false,
      data.shipstation_connected_at ? new Date(data.shipstation_connected_at) : null,
      data.invoice_item_field,
      data.invoice_qty_field,
      data.invoice_price_field,
      data.setup_completed || false,
      data.setup_completed_at ? new Date(data.setup_completed_at) : null,
      data.setup_token || null,
      data.setup_token_expires ? new Date(data.setup_token_expires) : null,
      data.invoice_preferences ? JSON.stringify(data.invoice_preferences) : null
    ]);
  }
  return true;
}

async function deleteUser(userId) {
  const normalized = normalizeUserId(userId);
  await pool.query('DELETE FROM users WHERE pipedrive_user_id = $1', [normalized]);
  return true;
}

async function listUsers(prefix = '') {
  const result = await pool.query('SELECT pipedrive_user_id FROM users');
  const allIds = result.rows.map(row => row.pipedrive_user_id);
  
  if (prefix) {
    return allIds.filter(id => id.startsWith(prefix));
  }
  return allIds;
}

function rowToUserData(row) {
  if (!row) return null;
  
  const pipedriveAccessToken = decrypt(row.pipedrive_access_token);
  const pipedriveRefreshToken = decrypt(row.pipedrive_refresh_token);
  const qbAccessToken = decrypt(row.qb_access_token);
  const qbRefreshToken = decrypt(row.qb_refresh_token);
  
  return {
    pipedrive_access_token: pipedriveAccessToken,
    access_token: pipedriveAccessToken,
    pipedrive_refresh_token: pipedriveRefreshToken,
    refresh_token: pipedriveRefreshToken,
    pipedrive_expires_at: row.pipedrive_expires_at?.toISOString(),
    expires_at: row.pipedrive_expires_at?.toISOString(),
    pipedrive_api_domain: row.pipedrive_api_domain,
    api_domain: row.pipedrive_api_domain,
    qb_access_token: qbAccessToken,
    qb_refresh_token: qbRefreshToken,
    qb_realm_id: row.qb_realm_id,
    qb_expires_at: row.qb_expires_at?.toISOString(),
    qb_last_refresh: row.qb_last_refresh?.toISOString(),
    shipstation_api_key: row.shipstation_api_key,
    shipstation_api_secret: row.shipstation_api_secret,
    shipstation_auto_create: row.shipstation_auto_create,
    shipstation_connected_at: row.shipstation_connected_at?.toISOString(),
    invoice_item_field: row.invoice_item_field,
    invoice_qty_field: row.invoice_qty_field,
    invoice_price_field: row.invoice_price_field,
    setup_completed: row.setup_completed,
    setup_completed_at: row.setup_completed_at?.toISOString(),
    setup_token: row.setup_token,
    setup_token_expires: row.setup_token_expires?.toISOString(),
    invoice_preferences: row.invoice_preferences
  };
}

async function setDealMapping(dealId, qbCustomerId, customerName) {
  await pool.query(`
    INSERT INTO deal_mappings (deal_id, qb_customer_id, customer_name, linked_at)
    VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
    ON CONFLICT (deal_id) DO UPDATE SET
      qb_customer_id = $2,
      customer_name = $3,
      linked_at = CURRENT_TIMESTAMP
  `, [dealId, qbCustomerId, customerName]);
  return true;
}

async function getDealMapping(dealId) {
  const result = await pool.query(
    'SELECT * FROM deal_mappings WHERE deal_id = $1',
    [dealId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    qbCustomerId: row.qb_customer_id,
    customerName: row.customer_name,
    linkedAt: row.linked_at?.toISOString()
  };
}

async function deleteDealMapping(dealId) {
  await pool.query('DELETE FROM deal_mappings WHERE deal_id = $1', [dealId]);
  return true;
}

async function addPendingInvoice(invoiceId, invoiceNumber, userId, invoiceData) {
  await pool.query(`
    INSERT INTO pending_invoices (invoice_id, invoice_number, user_id, invoice_data, created_at)
    VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
    ON CONFLICT (invoice_id) DO UPDATE SET
      invoice_number = $2,
      invoice_data = $4,
      updated_at = CURRENT_TIMESTAMP
  `, [invoiceId, invoiceNumber, userId, JSON.stringify(invoiceData)]);
  return true;
}

async function getPendingInvoice(invoiceId) {
  const result = await pool.query(
    'SELECT * FROM pending_invoices WHERE invoice_id = $1',
    [invoiceId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    userId: row.user_id,
    invoiceData: row.invoice_data,
    retryCount: row.retry_count,
    lastError: row.last_error,
    lastAttempt: row.last_attempt?.toISOString(),
    createdAt: row.created_at?.toISOString()
  };
}

async function listPendingInvoices() {
  const result = await pool.query('SELECT * FROM pending_invoices ORDER BY created_at ASC');
  return result.rows.map(row => ({
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    userId: row.user_id,
    invoiceData: row.invoice_data,
    retryCount: row.retry_count,
    lastError: row.last_error,
    lastAttempt: row.last_attempt?.toISOString(),
    createdAt: row.created_at?.toISOString()
  }));
}

async function updatePendingInvoiceRetry(invoiceId, retryCount, errorMessage) {
  await pool.query(`
    UPDATE pending_invoices SET
      retry_count = $2,
      last_error = $3,
      last_attempt = CURRENT_TIMESTAMP
    WHERE invoice_id = $1
  `, [invoiceId, retryCount, errorMessage]);
  return true;
}

async function deletePendingInvoice(invoiceId) {
  await pool.query('DELETE FROM pending_invoices WHERE invoice_id = $1', [invoiceId]);
  return true;
}

async function setInvoiceMapping(invoiceId, invoiceNumber, shipstationOrderId, shipstationOrderNumber, triggeredBy) {
  await pool.query(`
    INSERT INTO invoice_mappings (invoice_id, invoice_number, shipstation_order_id, shipstation_order_number, triggered_by, created_at)
    VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
    ON CONFLICT (invoice_id) DO UPDATE SET
      shipstation_order_id = $3,
      shipstation_order_number = $4,
      triggered_by = $5
  `, [invoiceId, invoiceNumber, shipstationOrderId, shipstationOrderNumber, triggeredBy]);
  return true;
}

async function getInvoiceMapping(invoiceId) {
  const result = await pool.query(
    'SELECT * FROM invoice_mappings WHERE invoice_id = $1',
    [invoiceId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    shipstationOrderId: row.shipstation_order_id,
    shipstationOrderNumber: row.shipstation_order_number,
    triggeredBy: row.triggered_by,
    createdAt: row.created_at?.toISOString()
  };
}

async function getInvoiceMappingByNumber(invoiceNumber) {
  const result = await pool.query(
    'SELECT * FROM invoice_mappings WHERE invoice_number = $1',
    [invoiceNumber]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    shipstationOrderId: row.shipstation_order_id,
    shipstationOrderNumber: row.shipstation_order_number,
    triggeredBy: row.triggered_by,
    createdAt: row.created_at?.toISOString()
  };
}

async function deleteInvoiceMapping(invoiceId) {
  await pool.query('DELETE FROM invoice_mappings WHERE invoice_id = $1', [invoiceId]);
  return true;
}

async function cleanupStaleEntries(staleDays = 30) {
  const staleDate = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);
  const result = await pool.query(
    'DELETE FROM pending_invoices WHERE created_at < $1 RETURNING invoice_id',
    [staleDate]
  );
  return result.rows.map(row => row.invoice_id);
}

async function cleanupMaxRetries(maxRetries = 10) {
  const result = await pool.query(
    'DELETE FROM pending_invoices WHERE retry_count >= $1 RETURNING invoice_id',
    [maxRetries]
  );
  return result.rows.map(row => row.invoice_id);
}

// Get ShipStation credentials - simply returns the first user with SS credentials
// ShipStation API key/secret are global for the installation, not per-user
async function getShipStationCredentials() {
  const result = await pool.query(`
    SELECT * FROM users 
    WHERE shipstation_api_key IS NOT NULL 
    ORDER BY shipstation_connected_at DESC
    LIMIT 1
  `);
  
  if (result.rows.length > 0) {
    return rowToUserData(result.rows[0]);
  }
  
  return null;
}

module.exports = {
  pool,
  initializeDatabase,
  getUser,
  setUser,
  deleteUser,
  listUsers,
  getShipStationCredentials,
  setDealMapping,
  getDealMapping,
  deleteDealMapping,
  addPendingInvoice,
  getPendingInvoice,
  listPendingInvoices,
  updatePendingInvoiceRetry,
  deletePendingInvoice,
  setInvoiceMapping,
  getInvoiceMapping,
  getInvoiceMappingByNumber,
  deleteInvoiceMapping,
  cleanupStaleEntries,
  cleanupMaxRetries
};
