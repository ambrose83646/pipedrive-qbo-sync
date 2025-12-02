const cron = require('node-cron');
const { getUser, setUser, listUsers, deleteUser } = require('../../config/database');
const axios = require('axios');
const OAuthClient = require('intuit-oauth');
const { encrypt, decrypt } = require('../utils/encryption');

let pollingInterval = null;

async function refreshQBToken(userId, userData) {
  const qbClient = new OAuthClient({
    clientId: process.env.QB_CLIENT_ID,
    clientSecret: process.env.QB_CLIENT_SECRET,
    environment: 'sandbox',
    redirectUri: process.env.APP_URL + '/auth/qb/callback'
  });
  
  qbClient.setToken({
    access_token: userData.qb_access_token,
    refresh_token: userData.qb_refresh_token,
    token_type: 'Bearer',
    expires_in: 3600,
    x_refresh_token_expires_in: 8726400,
    realmId: userData.qb_realm_id
  });
  
  const newTokenResponse = await qbClient.refresh();
  const newTokens = newTokenResponse.getJson();
  
  const updatedUserData = {
    ...userData,
    qb_access_token: newTokens.access_token,
    qb_refresh_token: newTokens.refresh_token,
    qb_expires_in: newTokens.expires_in,
    qb_expires_at: new Date(Date.now() + (newTokens.expires_in * 1000)).toISOString(),
    qb_last_refresh: new Date().toISOString()
  };
  
  await setUser(userId, updatedUserData);
  return updatedUserData;
}

async function makeShipStationApiCall(userData, method, endpoint, data = null) {
  if (!userData.shipstation_api_key || !userData.shipstation_api_secret) {
    throw new Error('ShipStation not connected');
  }
  
  const apiKey = decrypt(userData.shipstation_api_key);
  const apiSecret = decrypt(userData.shipstation_api_secret);
  
  const authString = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  
  const config = {
    method,
    url: `https://ssapi.shipstation.com${endpoint}`,
    headers: {
      'Authorization': `Basic ${authString}`,
      'Content-Type': 'application/json'
    }
  };
  
  if (data && (method === 'POST' || method === 'PUT')) {
    config.data = data;
  }
  
  const response = await axios(config);
  return response.data;
}

async function createShipStationOrder(userData, invoice) {
  const orderNumber = invoice.DocNumber || `QB-${invoice.Id}`;
  
  // Idempotency check: see if order already exists with this number
  try {
    const existingOrders = await makeShipStationApiCall(userData, 'GET', `/orders?orderNumber=${encodeURIComponent(orderNumber)}`);
    if (existingOrders.orders && existingOrders.orders.length > 0) {
      console.log(`[PaymentPoller] Order ${orderNumber} already exists (ID: ${existingOrders.orders[0].orderId}), skipping creation`);
      return {
        orderId: existingOrders.orders[0].orderId,
        orderNumber: existingOrders.orders[0].orderNumber,
        alreadyExists: true
      };
    }
  } catch (dupeCheckError) {
    console.warn(`[PaymentPoller] Could not check for existing order ${orderNumber}:`, dupeCheckError.message);
    // Continue with creation - ShipStation will reject if duplicate
  }
  
  const shipTo = {
    name: invoice.CustomerRef?.name || invoice.ShipAddr?.Line1 || 'Customer',
    street1: invoice.ShipAddr?.Line1 || invoice.BillAddr?.Line1 || '',
    street2: invoice.ShipAddr?.Line2 || invoice.BillAddr?.Line2 || '',
    city: invoice.ShipAddr?.City || invoice.BillAddr?.City || '',
    state: invoice.ShipAddr?.CountrySubDivisionCode || invoice.BillAddr?.CountrySubDivisionCode || '',
    postalCode: invoice.ShipAddr?.PostalCode || invoice.BillAddr?.PostalCode || '',
    country: invoice.ShipAddr?.Country || invoice.BillAddr?.Country || 'US',
    phone: invoice.ShipAddr?.Phone || '',
    email: invoice.BillEmail?.Address || ''
  };
  
  const items = [];
  if (invoice.Line) {
    invoice.Line.forEach(line => {
      if (line.DetailType === 'SalesItemLineDetail' && line.SalesItemLineDetail) {
        items.push({
          name: line.SalesItemLineDetail.ItemRef?.name || line.Description || 'Item',
          quantity: line.SalesItemLineDetail.Qty || 1,
          unitPrice: line.SalesItemLineDetail.UnitPrice || line.Amount || 0,
          sku: line.SalesItemLineDetail.ItemRef?.value || ''
        });
      }
    });
  }
  
  const shipstationOrder = {
    orderNumber: invoice.DocNumber || `QB-${invoice.Id}`,
    orderDate: invoice.TxnDate || new Date().toISOString().split('T')[0],
    orderStatus: 'awaiting_shipment',
    billTo: shipTo,
    shipTo: shipTo,
    items: items,
    amountPaid: parseFloat(invoice.TotalAmt),
    customerEmail: invoice.BillEmail?.Address || '',
    internalNotes: `QuickBooks Invoice #${invoice.DocNumber || invoice.Id}`,
    advancedOptions: {
      customField1: `QB_Invoice_${invoice.Id}`,
      customField2: invoice.CustomerRef?.value || ''
    }
  };
  
  return await makeShipStationApiCall(userData, 'POST', '/orders/createorder', shipstationOrder);
}

const MAX_RETRIES = 10;
const STALE_DAYS = 30;

// Helper to increment retry count on failure
async function incrementRetry(pendingKey, pendingData, errorMessage) {
  const newRetryCount = (pendingData.retryCount || 0) + 1;
  await setUser(pendingKey, {
    ...pendingData,
    retryCount: newRetryCount,
    lastError: errorMessage,
    lastAttempt: new Date().toISOString()
  });
  console.log(`[PaymentPoller] Incremented retry count for ${pendingKey} to ${newRetryCount}`);
}

async function checkPendingInvoices() {
  console.log('[PaymentPoller] Starting payment check cycle...');
  
  try {
    const allKeys = await listUsers('ss_pending:');
    
    if (allKeys.length === 0) {
      console.log('[PaymentPoller] No pending invoices to check');
      return;
    }
    
    console.log(`[PaymentPoller] Found ${allKeys.length} pending invoice(s) to check`);
    
    for (const pendingKey of allKeys) {
      try {
        const pendingData = await getUser(pendingKey);
        
        if (!pendingData) {
          console.log(`[PaymentPoller] No data found for key ${pendingKey}, removing...`);
          await deleteUser(pendingKey);
          continue;
        }
        
        const { invoiceId, invoiceNumber, userId, invoiceData, createdAt, retryCount = 0, lastError } = pendingData;
        
        // Check if entry is too old (stale)
        const createdDate = createdAt ? new Date(createdAt) : new Date();
        const daysSinceCreated = (Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceCreated > STALE_DAYS) {
          console.log(`[PaymentPoller] Invoice ${invoiceNumber} is stale (${Math.floor(daysSinceCreated)} days old), removing...`);
          await deleteUser(pendingKey);
          continue;
        }
        
        // Check retry count
        if (retryCount >= MAX_RETRIES) {
          console.log(`[PaymentPoller] Invoice ${invoiceNumber} exceeded max retries (${retryCount}), removing. Last error: ${lastError}`);
          await deleteUser(pendingKey);
          continue;
        }
        
        console.log(`[PaymentPoller] Checking invoice ${invoiceNumber} (${invoiceId}), attempt ${retryCount + 1}/${MAX_RETRIES}`);
        
        let userData = await getUser(userId);
        
        if (!userData || !userData.qb_access_token || !userData.qb_realm_id) {
          console.log(`[PaymentPoller] User ${userId} not found or QB not connected, skipping...`);
          await incrementRetry(pendingKey, pendingData, 'User not found or QB not connected');
          continue;
        }
        
        if (!userData.shipstation_api_key) {
          console.log(`[PaymentPoller] User ${userId} has no ShipStation connection, removing pending entry...`);
          await deleteUser(pendingKey);
          continue;
        }
        
        const tokenExpiry = userData.qb_expires_at ? new Date(userData.qb_expires_at) : null;
        const now = new Date();
        
        if (!tokenExpiry || tokenExpiry < new Date(now.getTime() + 5 * 60 * 1000)) {
          console.log(`[PaymentPoller] Refreshing QB token for user ${userId}`);
          try {
            userData = await refreshQBToken(userId, userData);
          } catch (refreshError) {
            const errorMsg = refreshError.message || 'Unknown refresh error';
            console.error(`[PaymentPoller] Token refresh failed for user ${userId}:`, errorMsg);
            
            // If refresh token is invalid/expired, mark for removal
            if (errorMsg.includes('invalid_grant') || errorMsg.includes('expired') || errorMsg.includes('revoked')) {
              console.log(`[PaymentPoller] QB connection is broken for user ${userId}, removing pending entry`);
              await deleteUser(pendingKey);
            } else {
              await incrementRetry(pendingKey, pendingData, `Token refresh failed: ${errorMsg}`);
            }
            continue;
          }
        }
        
        const baseUrl = 'https://sandbox-quickbooks.api.intuit.com';
        const realmId = userData.qb_realm_id;
        
        try {
          const response = await axios({
            method: 'GET',
            url: `${baseUrl}/v3/company/${realmId}/invoice/${invoiceId}`,
            headers: {
              'Authorization': `Bearer ${userData.qb_access_token}`,
              'Accept': 'application/json'
            }
          });
          
          const currentInvoice = response.data?.Invoice;
          
          if (!currentInvoice) {
            console.log(`[PaymentPoller] Invoice ${invoiceNumber} not found in QuickBooks`);
            continue;
          }
          
          const currentBalance = parseFloat(currentInvoice.Balance || 0);
          
          console.log(`[PaymentPoller] Invoice ${invoiceNumber} balance: $${currentBalance}`);
          
          if (currentBalance <= 0) {
            console.log(`[PaymentPoller] Invoice ${invoiceNumber} is PAID! Creating ShipStation order...`);
            
            try {
              const mergedInvoice = { ...invoiceData, ...currentInvoice };
              const ssOrder = await createShipStationOrder(userData, mergedInvoice);
              
              if (ssOrder && ssOrder.orderId) {
                console.log(`[PaymentPoller] ShipStation order ${ssOrder.orderId} created for invoice ${invoiceNumber}`);
                
                const mappingKey = `ss_invoice:${invoiceId}`;
                await setUser(mappingKey, {
                  invoiceId: invoiceId,
                  invoiceNumber: invoiceNumber,
                  shipstationOrderId: ssOrder.orderId,
                  shipstationOrderNumber: ssOrder.orderNumber,
                  createdAt: new Date().toISOString(),
                  triggeredBy: 'payment_polling'
                });
                
                await deleteUser(pendingKey);
                console.log(`[PaymentPoller] Removed pending entry for invoice ${invoiceNumber}`);
              }
            } catch (ssError) {
              console.error(`[PaymentPoller] Failed to create ShipStation order for invoice ${invoiceNumber}:`, ssError.message);
            }
          }
        } catch (qbError) {
          if (qbError.response?.status === 401) {
            console.log(`[PaymentPoller] QB token expired for user ${userId}, will retry next cycle`);
          } else {
            console.error(`[PaymentPoller] Error fetching invoice ${invoiceNumber}:`, qbError.message);
          }
        }
      } catch (entryError) {
        console.error(`[PaymentPoller] Error processing pending entry ${pendingKey}:`, entryError.message);
      }
    }
    
    console.log('[PaymentPoller] Payment check cycle complete');
  } catch (error) {
    console.error('[PaymentPoller] Error in payment polling:', error.message);
  }
}

function startPolling() {
  console.log('[PaymentPoller] Starting payment polling service (every 5 minutes)');
  
  checkPendingInvoices();
  
  pollingInterval = cron.schedule('*/5 * * * *', () => {
    checkPendingInvoices();
  });
}

function stopPolling() {
  if (pollingInterval) {
    pollingInterval.stop();
    console.log('[PaymentPoller] Payment polling stopped');
  }
}

module.exports = {
  startPolling,
  stopPolling,
  checkPendingInvoices
};
