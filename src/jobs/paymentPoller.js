const cron = require('node-cron');
const { 
  getUser, 
  setUser, 
  listPendingInvoices, 
  deletePendingInvoice, 
  updatePendingInvoiceRetry,
  setInvoiceMapping,
  getInvoiceMapping,
  cleanupStaleEntries,
  cleanupMaxRetries
} = require('../../config/postgres');
const axios = require('axios');
const OAuthClient = require('intuit-oauth');
const { encrypt, decrypt } = require('../utils/encryption');

// Helper function to get the correct QuickBooks API base URL based on environment
function getQBBaseUrl() {
  const env = process.env.QB_ENVIRONMENT || 'sandbox';
  return env === 'production' 
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

// Convert country names to 2-letter ISO codes for ShipStation
function convertToCountryCode(country) {
  if (!country) return 'US';
  
  const countryMap = {
    'united states': 'US',
    'united states of america': 'US',
    'usa': 'US',
    'u.s.a.': 'US',
    'u.s.': 'US',
    'us': 'US',
    'canada': 'CA',
    'mexico': 'MX',
    'united kingdom': 'GB',
    'uk': 'GB',
    'great britain': 'GB',
    'australia': 'AU',
    'germany': 'DE',
    'france': 'FR',
    'italy': 'IT',
    'spain': 'ES',
    'netherlands': 'NL',
    'belgium': 'BE',
    'switzerland': 'CH',
    'austria': 'AT',
    'sweden': 'SE',
    'norway': 'NO',
    'denmark': 'DK',
    'finland': 'FI',
    'ireland': 'IE',
    'new zealand': 'NZ',
    'japan': 'JP',
    'china': 'CN',
    'india': 'IN',
    'brazil': 'BR',
    'argentina': 'AR',
    'chile': 'CL',
    'colombia': 'CO',
    'peru': 'PE',
    'south africa': 'ZA',
    'singapore': 'SG',
    'hong kong': 'HK',
    'taiwan': 'TW',
    'south korea': 'KR',
    'korea': 'KR',
    'philippines': 'PH',
    'thailand': 'TH',
    'vietnam': 'VN',
    'malaysia': 'MY',
    'indonesia': 'ID',
    'poland': 'PL',
    'czech republic': 'CZ',
    'portugal': 'PT',
    'greece': 'GR',
    'israel': 'IL',
    'uae': 'AE',
    'united arab emirates': 'AE',
    'saudi arabia': 'SA',
    'russia': 'RU',
    'ukraine': 'UA',
    'turkey': 'TR'
  };
  
  const normalized = country.toLowerCase().trim();
  
  // If already a 2-letter code, return uppercase
  if (normalized.length === 2) {
    return normalized.toUpperCase();
  }
  
  return countryMap[normalized] || 'US';
}

let pollingInterval = null;

async function refreshQBToken(userId, userData) {
  const qbClient = new OAuthClient({
    clientId: process.env.QB_CLIENT_ID,
    clientSecret: process.env.QB_CLIENT_SECRET,
    environment: process.env.QB_ENVIRONMENT || 'sandbox',
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
  
  try {
    const response = await axios(config);
    return response.data;
  } catch (error) {
    // Capture and log detailed error response from ShipStation
    if (error.response) {
      console.error(`[PaymentPoller] ShipStation API error:`, {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data,
        endpoint: endpoint
      });
    }
    throw error;
  }
}

// Build unique ShipStation order number with tenant prefix
// Format: QB-{tenantSuffix}-{invoiceNumber} e.g., QB-3761-1078
function buildShipStationOrderNumber(userId, invoiceNumber) {
  if (!userId) {
    throw new Error('userId is required to build ShipStation order number');
  }
  if (!invoiceNumber) {
    throw new Error('invoiceNumber is required to build ShipStation order number');
  }
  const userIdStr = String(userId);
  const tenantSuffix = userIdStr.slice(-4);
  return `QB-${tenantSuffix}-${invoiceNumber}`;
}

async function createShipStationOrder(userData, invoice, userId) {
  const invoiceId = invoice.Id;
  const invoiceNumber = invoice.DocNumber || invoice.Id;
  
  // Validation: Ensure we have a valid invoice identifier
  if (!invoiceId && !invoiceNumber) {
    const error = new Error('Invoice missing both Id and DocNumber - cannot create ShipStation order');
    error.validationError = true;
    throw error;
  }
  
  console.log(`[PaymentPoller] createShipStationOrder called - invoiceId: ${invoiceId}, invoiceNumber: ${invoiceNumber}`);
  
  // Step 1: Check if we already have a mapping for this invoice
  try {
    const existingMapping = await getInvoiceMapping(invoiceId);
    if (existingMapping && existingMapping.shipstationOrderId) {
      console.log(`[PaymentPoller] Invoice ${invoiceNumber} already mapped to order ${existingMapping.shipstationOrderNumber} (ID: ${existingMapping.shipstationOrderId})`);
      return {
        orderId: existingMapping.shipstationOrderId,
        orderNumber: existingMapping.shipstationOrderNumber,
        alreadyExists: true,
        fromMapping: true
      };
    }
  } catch (mappingError) {
    console.warn(`[PaymentPoller] Could not check invoice mapping:`, mappingError.message);
  }
  
  // Step 2: Generate unique order number with tenant prefix
  const orderNumber = buildShipStationOrderNumber(userId, invoiceNumber);
  console.log(`[PaymentPoller] Generated order number: ${orderNumber} for invoice ${invoiceNumber}`);
  
  // Step 3: Check if order already exists in ShipStation
  try {
    const existingOrders = await makeShipStationApiCall(userData, 'GET', `/orders?orderNumber=${encodeURIComponent(orderNumber)}`);
    if (existingOrders.orders && existingOrders.orders.length > 0) {
      const existingOrder = existingOrders.orders[0];
      console.log(`[PaymentPoller] Order ${orderNumber} already exists (ID: ${existingOrder.orderId}), saving mapping`);
      
      // Save the mapping for future lookups
      await setInvoiceMapping(invoiceId, invoiceNumber, existingOrder.orderId, existingOrder.orderNumber, 'existing_poller');
      
      return {
        orderId: existingOrder.orderId,
        orderNumber: existingOrder.orderNumber,
        alreadyExists: true
      };
    }
  } catch (dupeCheckError) {
    console.warn(`[PaymentPoller] Could not check for existing order ${orderNumber}:`, dupeCheckError.message);
  }
  
  // Step 4: Build ship-to address
  const shipTo = {
    name: invoice.CustomerRef?.name || invoice.ShipAddr?.Line1 || 'Customer',
    street1: invoice.ShipAddr?.Line1 || invoice.BillAddr?.Line1 || '',
    street2: invoice.ShipAddr?.Line2 || invoice.BillAddr?.Line2 || '',
    city: invoice.ShipAddr?.City || invoice.BillAddr?.City || '',
    state: invoice.ShipAddr?.CountrySubDivisionCode || invoice.BillAddr?.CountrySubDivisionCode || '',
    postalCode: invoice.ShipAddr?.PostalCode || invoice.BillAddr?.PostalCode || '',
    country: convertToCountryCode(invoice.ShipAddr?.Country || invoice.BillAddr?.Country),
    phone: invoice.ShipAddr?.Phone || '',
    email: invoice.BillEmail?.Address || ''
  };
  
  // Step 5: Map line items
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
  
  // Step 6: Create the order
  const shipstationOrder = {
    orderNumber: orderNumber,
    orderDate: invoice.TxnDate || new Date().toISOString().split('T')[0],
    orderStatus: 'awaiting_shipment',
    billTo: shipTo,
    shipTo: shipTo,
    items: items,
    amountPaid: parseFloat(invoice.TotalAmt),
    customerEmail: invoice.BillEmail?.Address || '',
    internalNotes: `QuickBooks Invoice #${invoiceNumber}`,
    advancedOptions: {
      customField1: `QB_Invoice_${invoiceId}`,
      customField2: invoice.CustomerRef?.value || ''
    }
  };
  
  console.log(`[PaymentPoller] Creating ShipStation order - Number: ${shipstationOrder.orderNumber}, Customer: ${shipTo.name}, Items: ${items.length}, Amount: $${shipstationOrder.amountPaid.toFixed(2)}`);
  
  const createdOrder = await makeShipStationApiCall(userData, 'POST', '/orders/createorder', shipstationOrder);
  
  console.log(`[PaymentPoller] ShipStation order created - ID: ${createdOrder.orderId}, Number: ${createdOrder.orderNumber}`);
  
  // Step 7: Save the mapping
  try {
    await setInvoiceMapping(invoiceId, invoiceNumber, createdOrder.orderId, createdOrder.orderNumber, 'poller');
    console.log(`[PaymentPoller] Saved invoice mapping: ${invoiceNumber} -> ${createdOrder.orderNumber}`);
  } catch (mappingSaveError) {
    console.error(`[PaymentPoller] Failed to save invoice mapping:`, mappingSaveError.message);
  }
  
  return createdOrder;
}

const MAX_RETRIES = 10;
const STALE_DAYS = 30;

async function checkPendingInvoices() {
  console.log('[PaymentPoller] Starting payment check cycle...');
  
  try {
    const staleRemoved = await cleanupStaleEntries(STALE_DAYS);
    if (staleRemoved.length > 0) {
      console.log(`[PaymentPoller] Cleaned up ${staleRemoved.length} stale entries`);
    }
    
    const maxRetryRemoved = await cleanupMaxRetries(MAX_RETRIES);
    if (maxRetryRemoved.length > 0) {
      console.log(`[PaymentPoller] Cleaned up ${maxRetryRemoved.length} max-retry entries`);
    }
    
    const pendingInvoices = await listPendingInvoices();
    
    if (pendingInvoices.length === 0) {
      console.log('[PaymentPoller] No pending invoices to check');
      return;
    }
    
    console.log(`[PaymentPoller] Found ${pendingInvoices.length} pending invoice(s) to check`);
    
    for (const pending of pendingInvoices) {
      try {
        const { invoiceId, invoiceNumber: storedInvoiceNumber, userId, invoiceData, retryCount = 0, lastError } = pending;
        
        // Use stored invoice number, or fall back to invoiceId if null
        const invoiceNumber = storedInvoiceNumber || invoiceId;
        
        console.log(`[PaymentPoller] Checking invoice ${invoiceNumber} (ID: ${invoiceId}), attempt ${retryCount + 1}/${MAX_RETRIES}`);
        
        let userData = await getUser(userId);
        
        if (!userData || !userData.qb_access_token || !userData.qb_realm_id) {
          console.log(`[PaymentPoller] User ${userId} not found or QB not connected, skipping...`);
          await updatePendingInvoiceRetry(invoiceId, retryCount + 1, 'User not found or QB not connected');
          continue;
        }
        
        if (!userData.shipstation_api_key) {
          console.log(`[PaymentPoller] User ${userId} has no ShipStation connection, removing pending entry...`);
          await deletePendingInvoice(invoiceId);
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
            
            if (errorMsg.includes('invalid_grant') || errorMsg.includes('expired') || errorMsg.includes('revoked')) {
              console.log(`[PaymentPoller] QB connection is broken for user ${userId}, removing pending entry`);
              await deletePendingInvoice(invoiceId);
            } else {
              await updatePendingInvoiceRetry(invoiceId, retryCount + 1, `Token refresh failed: ${errorMsg}`);
            }
            continue;
          }
        }
        
        const baseUrl = getQBBaseUrl();
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
            
            const existingMapping = await getInvoiceMapping(invoiceId);
            if (existingMapping) {
              console.log(`[PaymentPoller] Invoice ${invoiceNumber} already has ShipStation order ${existingMapping.shipstationOrderId}, skipping...`);
              await deletePendingInvoice(invoiceId);
              continue;
            }
            
            try {
              // Ensure invoiceData is parsed if it's a string (safety check)
              const parsedInvoiceData = typeof invoiceData === 'string' ? JSON.parse(invoiceData) : invoiceData;
              const mergedInvoice = { ...parsedInvoiceData, ...currentInvoice };
              
              // Debug logging for order number construction
              console.log(`[PaymentPoller] Creating order - Invoice Id: ${mergedInvoice.Id}, DocNumber: ${mergedInvoice.DocNumber}, using: ${mergedInvoice.DocNumber || mergedInvoice.Id}`);
              
              const ssOrder = await createShipStationOrder(userData, mergedInvoice, userId);
              
              if (ssOrder && ssOrder.orderId) {
                console.log(`[PaymentPoller] ShipStation order ${ssOrder.orderId} created for invoice ${invoiceNumber}`);
                
                await deletePendingInvoice(invoiceId);
                console.log(`[PaymentPoller] Removed pending entry for invoice ${invoiceNumber}`);
              }
            } catch (ssError) {
              console.error(`[PaymentPoller] Failed to create ShipStation order for invoice ${invoiceNumber}:`, ssError.message);
              await updatePendingInvoiceRetry(invoiceId, retryCount + 1, `ShipStation error: ${ssError.message}`);
            }
          }
        } catch (qbError) {
          if (qbError.response?.status === 401) {
            console.log(`[PaymentPoller] QB token expired for user ${userId}, incrementing retry and will retry next cycle`);
            await updatePendingInvoiceRetry(invoiceId, retryCount + 1, 'QB token expired (401)');
          } else {
            console.error(`[PaymentPoller] Error fetching invoice ${invoiceNumber}:`, qbError.message);
            await updatePendingInvoiceRetry(invoiceId, retryCount + 1, `QB API error: ${qbError.message}`);
          }
        }
      } catch (entryError) {
        console.error(`[PaymentPoller] Error processing pending entry:`, entryError.message);
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
