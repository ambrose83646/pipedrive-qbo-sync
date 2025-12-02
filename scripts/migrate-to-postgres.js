require('dotenv').config();
const Database = require("@replit/database");
const { 
  initializeDatabase,
  setUser, 
  setDealMapping, 
  addPendingInvoice, 
  setInvoiceMapping 
} = require('../config/postgres');

const kvDb = new Database();

async function migrateData() {
  console.log('Starting migration from Replit KV to PostgreSQL...\n');
  
  try {
    console.log('Initializing PostgreSQL schema...');
    await initializeDatabase();
    console.log('Schema initialized.\n');
    
    const allKeys = await kvDb.list();
    const keys = allKeys?.value || [];
    
    console.log(`Found ${keys.length} keys in KV store.\n`);
    
    let userCount = 0;
    let dealMappingCount = 0;
    let pendingInvoiceCount = 0;
    let invoiceMappingCount = 0;
    let errorCount = 0;
    
    for (const key of keys) {
      try {
        const result = await kvDb.get(key);
        const data = result?.value;
        
        if (!data) {
          console.log(`  Skipping empty key: ${key}`);
          continue;
        }
        
        if (key.startsWith('deal_mapping:')) {
          const dealId = key.replace('deal_mapping:', '');
          await setDealMapping(dealId, data.qbCustomerId, data.customerName);
          dealMappingCount++;
          console.log(`  Migrated deal mapping: ${dealId}`);
          
        } else if (key.startsWith('ss_pending:')) {
          await addPendingInvoice(
            data.invoiceId,
            data.invoiceNumber,
            data.userId,
            data.invoiceData
          );
          pendingInvoiceCount++;
          console.log(`  Migrated pending invoice: ${data.invoiceNumber || data.invoiceId}`);
          
        } else if (key.startsWith('ss_invoice:')) {
          await setInvoiceMapping(
            data.invoiceId,
            data.invoiceNumber,
            data.shipstationOrderId?.toString(),
            data.shipstationOrderNumber,
            data.triggeredBy || 'migration'
          );
          invoiceMappingCount++;
          console.log(`  Migrated invoice mapping: ${data.invoiceNumber || data.invoiceId}`);
          
        } else if (!key.startsWith('test') && !key.includes(':')) {
          await setUser(key, {
            pipedrive_access_token: data.access_token || data.pipedrive_access_token,
            pipedrive_refresh_token: data.refresh_token || data.pipedrive_refresh_token,
            pipedrive_expires_at: data.expires_at || data.pipedrive_expires_at,
            pipedrive_api_domain: data.api_domain || data.pipedrive_api_domain,
            qb_access_token: data.qb_access_token,
            qb_refresh_token: data.qb_refresh_token,
            qb_realm_id: data.qb_realm_id,
            qb_expires_at: data.qb_expires_at,
            qb_last_refresh: data.qb_last_refresh,
            shipstation_api_key: data.shipstation_api_key,
            shipstation_api_secret: data.shipstation_api_secret,
            shipstation_auto_create: data.shipstation_auto_create,
            shipstation_connected_at: data.shipstation_connected_at,
            invoice_item_field: data.invoice_item_field,
            invoice_qty_field: data.invoice_qty_field,
            invoice_price_field: data.invoice_price_field,
            setup_completed: data.setup_completed,
            setup_completed_at: data.setup_completed_at
          });
          userCount++;
          console.log(`  Migrated user: ${key}`);
        }
        
      } catch (error) {
        console.error(`  Error migrating key ${key}:`, error.message);
        errorCount++;
      }
    }
    
    console.log('\n=== Migration Summary ===');
    console.log(`Users migrated: ${userCount}`);
    console.log(`Deal mappings migrated: ${dealMappingCount}`);
    console.log(`Pending invoices migrated: ${pendingInvoiceCount}`);
    console.log(`Invoice mappings migrated: ${invoiceMappingCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log('\nMigration complete!');
    
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
  
  process.exit(0);
}

migrateData();
