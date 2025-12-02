require('dotenv').config();
const { Pool } = require('pg');
const { encrypt, decrypt } = require('../src/utils/encryption');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

function isEncrypted(value) {
  if (!value) return false;
  const parts = value.split(':');
  return parts.length === 3 && parts[0].length === 32 && parts[1].length === 32;
}

async function encryptExistingTokens() {
  console.log('Encrypting existing plaintext tokens in the database...\n');
  
  try {
    const result = await pool.query('SELECT * FROM users');
    const users = result.rows;
    
    console.log(`Found ${users.length} users to process.\n`);
    
    let encryptedCount = 0;
    let skippedCount = 0;
    
    for (const user of users) {
      const updates = {};
      let needsUpdate = false;
      
      if (user.pipedrive_access_token && !isEncrypted(user.pipedrive_access_token)) {
        updates.pipedrive_access_token = encrypt(user.pipedrive_access_token);
        needsUpdate = true;
      }
      
      if (user.pipedrive_refresh_token && !isEncrypted(user.pipedrive_refresh_token)) {
        updates.pipedrive_refresh_token = encrypt(user.pipedrive_refresh_token);
        needsUpdate = true;
      }
      
      if (user.qb_access_token && !isEncrypted(user.qb_access_token)) {
        updates.qb_access_token = encrypt(user.qb_access_token);
        needsUpdate = true;
      }
      
      if (user.qb_refresh_token && !isEncrypted(user.qb_refresh_token)) {
        updates.qb_refresh_token = encrypt(user.qb_refresh_token);
        needsUpdate = true;
      }
      
      if (needsUpdate) {
        const setClauses = [];
        const values = [user.pipedrive_user_id];
        let paramIndex = 2;
        
        for (const [key, value] of Object.entries(updates)) {
          setClauses.push(`${key} = $${paramIndex}`);
          values.push(value);
          paramIndex++;
        }
        
        await pool.query(
          `UPDATE users SET ${setClauses.join(', ')} WHERE pipedrive_user_id = $1`,
          values
        );
        
        console.log(`  Encrypted tokens for user: ${user.pipedrive_user_id}`);
        encryptedCount++;
      } else {
        console.log(`  Skipped user: ${user.pipedrive_user_id} (already encrypted or no tokens)`);
        skippedCount++;
      }
    }
    
    console.log('\n=== Encryption Summary ===');
    console.log(`Users with newly encrypted tokens: ${encryptedCount}`);
    console.log(`Users skipped (already encrypted): ${skippedCount}`);
    console.log('\nEncryption complete!');
    
  } catch (error) {
    console.error('Encryption failed:', error);
    process.exit(1);
  }
  
  await pool.end();
  process.exit(0);
}

encryptExistingTokens();
