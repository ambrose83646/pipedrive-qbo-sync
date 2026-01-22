const express = require("express");
const router = express.Router();
const { 
  getUser, 
  setUser, 
  deleteUser,
  listUsers,
  setDealMapping, 
  getDealMapping, 
  deleteDealMapping,
  addPendingInvoice,
  setInvoiceMapping,
  getInvoiceMapping
} = require("../../config/postgres");
const { getAuthUrl, getToken } = require("../auth/pipedrive");
const qbAuth = require("../auth/quickbooks");
const { syncContact } = require("../controllers/sync");
const OAuthClient = require("intuit-oauth");
const axios = require("axios");
const { encrypt, decrypt } = require("../utils/encryption");

// Helper function to get the correct QuickBooks API base URL based on environment
function getQBBaseUrl() {
  const env = process.env.QB_ENVIRONMENT || 'sandbox';
  return env === 'production' 
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

// Helper function to extract JSON data from QuickBooks API response
// The intuit-oauth library may return data in either 'json' (pre-parsed) or 'body' (string)
function getQBResponseData(response) {
  if (response.json) {
    return response.json;
  }
  if (response.body) {
    return typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
  }
  if (response.response?.json) {
    return response.response.json;
  }
  if (response.response?.body) {
    return typeof response.response.body === 'string' ? JSON.parse(response.response.body) : response.response.body;
  }
  throw new Error('No valid response data found');
}

// US State name to abbreviation mapping
const STATE_ABBREVIATIONS = {
  'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR', 'california': 'CA',
  'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE', 'florida': 'FL', 'georgia': 'GA',
  'hawaii': 'HI', 'idaho': 'ID', 'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA',
  'kansas': 'KS', 'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
  'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS', 'missouri': 'MO',
  'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH',
  'oklahoma': 'OK', 'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT', 'vermont': 'VT',
  'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV', 'wisconsin': 'WI', 'wyoming': 'WY',
  'district of columbia': 'DC', 'puerto rico': 'PR', 'guam': 'GU', 'virgin islands': 'VI'
};

// Helper to convert state name to 2-letter abbreviation
function normalizeStateCode(stateInput) {
  if (!stateInput) return stateInput;
  const trimmed = stateInput.trim();
  // If already a 2-letter code, return as uppercase
  if (trimmed.length === 2) {
    return trimmed.toUpperCase();
  }
  // Look up full state name
  const abbr = STATE_ABBREVIATIONS[trimmed.toLowerCase()];
  if (abbr) {
    console.log(`[State Normalize] Converted "${stateInput}" to "${abbr}"`);
    return abbr;
  }
  // Return original if not found (could be international)
  return trimmed;
}

// Helper function to check if token needs refresh (expires within 10 minutes)
function tokenNeedsRefresh(userData) {
  if (!userData.qb_expires_at) {
    // If no expiration timestamp and we have a refresh token, proactively refresh
    // This handles cases where tokens were stored without expiration tracking
    if (userData.qb_refresh_token) {
      console.log('[TokenCheck] No expiration timestamp but refresh token exists, triggering refresh');
      return true;
    }
    console.log('[TokenCheck] No expiration timestamp and no refresh token, cannot refresh');
    return false;
  }
  
  const expiresAt = new Date(userData.qb_expires_at);
  const now = new Date();
  const tenMinutesFromNow = new Date(now.getTime() + 10 * 60 * 1000);
  
  const needsRefresh = expiresAt < tenMinutesFromNow;
  const minutesUntilExpiry = Math.round((expiresAt - now) / 60000);
  
  console.log(`[TokenCheck] Token expires at: ${expiresAt.toISOString()}, now: ${now.toISOString()}`);
  console.log(`[TokenCheck] Minutes until expiry: ${minutesUntilExpiry}, needs refresh: ${needsRefresh}`);
  
  return needsRefresh;
}

// Helper function to refresh QuickBooks token and save to database
// Returns updated userData on success, or null if refresh should be skipped/failed softly
async function refreshAndSaveToken(userId, userData, throwOnError = false) {
  console.log(`[TokenRefresh] Starting token refresh for user ${userId}`);
  console.log(`[TokenRefresh] Current refresh token exists: ${!!userData.qb_refresh_token}`);
  
  // Soft guard against missing refresh token - skip refresh, don't break existing flow
  if (!userData.qb_refresh_token) {
    console.warn(`[TokenRefresh] No refresh token available for user ${userId}, skipping refresh`);
    return null; // Return null to indicate refresh was skipped
  }
  
  console.log(`[TokenRefresh] Current refresh token (first 10 chars): ${userData.qb_refresh_token.substring(0, 10)}...`);
  
  try {
    const newTokens = await qbAuth.refreshToken(userData.qb_refresh_token);
    
    console.log(`[TokenRefresh] Refresh successful!`);
    console.log(`[TokenRefresh] New access token received: ${!!newTokens.access_token}`);
    console.log(`[TokenRefresh] New refresh token received: ${!!newTokens.refresh_token}`);
    console.log(`[TokenRefresh] New refresh token (first 10 chars): ${newTokens.refresh_token?.substring(0, 10)}...`);
    console.log(`[TokenRefresh] Tokens changed: ${userData.qb_refresh_token !== newTokens.refresh_token ? 'YES' : 'NO'}`);
    
    const updatedUserData = {
      ...userData,
      qb_access_token: newTokens.access_token,
      qb_refresh_token: newTokens.refresh_token,
      qb_expires_in: newTokens.expires_in,
      qb_expires_at: new Date(Date.now() + (newTokens.expires_in * 1000)).toISOString(),
      qb_last_refresh: new Date().toISOString()
    };
    
    await setUser(userId, updatedUserData);
    console.log(`[TokenRefresh] Tokens saved to database for user ${userId}`);
    
    return updatedUserData;
  } catch (error) {
    console.error(`[TokenRefresh] Failed for user ${userId}:`, error.message);
    
    // Log specific error details for debugging
    if (error.response) {
      console.error(`[TokenRefresh] Error response:`, {
        status: error.response.status || error.response.statusCode,
        body: error.response.body || error.response.data
      });
    }
    
    // Check for specific error types
    const errorMessage = error.message?.toLowerCase() || '';
    if (errorMessage.includes('invalid') || errorMessage.includes('expired') || errorMessage.includes('revoked')) {
      throw new Error('QuickBooks refresh token is invalid or expired. Please reconnect to QuickBooks.');
    }
    
    throw error;
  }
}

// Helper function to make QuickBooks API call with automatic token refresh
async function makeQBApiCall(userId, userData, apiCallFunction) {
  // Create initial client with current tokens
  const createClient = (tokenData) => {
    const qbClient = new OAuthClient({
      clientId: process.env.QB_CLIENT_ID,
      clientSecret: process.env.QB_CLIENT_SECRET,
      environment: process.env.QB_ENVIRONMENT || 'sandbox',
      redirectUri: process.env.APP_URL + '/auth/qb/callback',
      logging: true
    });
    
    qbClient.setToken({
      access_token: tokenData.qb_access_token,
      refresh_token: tokenData.qb_refresh_token,
      token_type: 'Bearer',
      expires_in: tokenData.qb_expires_in || 3600,
      x_refresh_token_expires_in: 8726400,
      realmId: tokenData.qb_realm_id
    });
    
    return qbClient;
  };
  
  let currentUserData = userData;
  
  try {
    console.log(`[makeQBApiCall] Starting API call for user ${userId}`);
    console.log(`[makeQBApiCall] Has access token: ${!!userData.qb_access_token}, Has realm: ${!!userData.qb_realm_id}`);
    
    // PROACTIVE REFRESH: Check if token is about to expire and refresh before making the call
    if (tokenNeedsRefresh(currentUserData)) {
      console.log(`[makeQBApiCall] Token expiring soon, attempting proactive refresh...`);
      try {
        const refreshedData = await refreshAndSaveToken(userId, currentUserData);
        if (refreshedData) {
          currentUserData = refreshedData;
          console.log(`[makeQBApiCall] Proactive refresh successful`);
        } else {
          console.log(`[makeQBApiCall] Proactive refresh skipped (no refresh token), continuing with existing token`);
        }
      } catch (proactiveRefreshError) {
        console.error(`[makeQBApiCall] Proactive refresh failed:`, proactiveRefreshError.message);
        // Continue with existing token - it might still work
      }
    }
    
    // Make API call with current (possibly refreshed) token
    const qbClient = createClient(currentUserData);
    const response = await apiCallFunction(qbClient, currentUserData);
    
    console.log(`[makeQBApiCall] API call successful, response type: ${typeof response}`);
    if (response) {
      console.log(`[makeQBApiCall] Response has body: ${!!response.body}, has json: ${!!response.json}`);
    }
    
    return response;
  } catch (error) {
    console.error(`[makeQBApiCall] API call error for user ${userId}:`, error.message);
    const errorBody = error.response?.body || error.response?.data;
    console.error(`[makeQBApiCall] Error details:`, {
      name: error.name,
      statusCode: error.response?.statusCode || error.response?.status,
      authHeader: error.authHeader,
      intuit_tid: error.intuit_tid
    });
    // Log full error body with JSON.stringify to see nested Error arrays
    console.error(`[makeQBApiCall] Full error body:`, JSON.stringify(errorBody, null, 2));
    
    // Check if error is due to unauthorized (expired token)
    const statusCode = error.response?.statusCode || error.response?.status || error.statusCode;
    if (statusCode === 401) {
      console.log(`[makeQBApiCall] QB token expired (401) for user ${userId}, attempting reactive refresh...`);
      
      try {
        const updatedUserData = await refreshAndSaveToken(userId, currentUserData);
        
        if (!updatedUserData) {
          // No refresh token available - cannot recover
          console.error(`[makeQBApiCall] No refresh token available, cannot recover from 401`);
          throw new Error('QuickBooks session expired. Please reconnect to QuickBooks.');
        }
        
        console.log(`[makeQBApiCall] Reactive refresh successful, retrying API call`);
        
        // Create new client with refreshed token and retry
        const refreshedClient = createClient(updatedUserData);
        return await apiCallFunction(refreshedClient, updatedUserData);
      } catch (refreshError) {
        console.error(`[makeQBApiCall] Reactive refresh failed for user ${userId}:`, refreshError.message);
        throw new Error(refreshError.message || 'QuickBooks authentication failed. Please reconnect.');
      }
    }
    
    // Re-throw if not an auth error
    throw error;
  }
}

router.get("/", (req, res) => {
  res.send("Hello!");
});

router.get("/eula", (req, res) => {
  res.sendFile("eula.html", { root: "./public" });
});

router.get("/privacy", (req, res) => {
  res.sendFile("privacy.html", { root: "./public" });
});

router.get("/test-db", async (req, res) => {
  try {
    const testData = { name: "Test User", token: "fake" };
    await setUser("test123", testData);
    const retrievedData = await getUser("test123");
    res.json(retrievedData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint to test QuickBooks API call
router.get("/api/debug/qb-test", async (req, res) => {
  try {
    const providedUserId = req.query.userId || 'test';
    
    // Find user with QB tokens
    let userData = await getUser(providedUserId);
    let actualUserId = providedUserId;
    
    if (!userData || !userData.qb_access_token || !userData.qb_realm_id) {
      const { listUsers } = require("../../config/postgres");
      const allKeys = await listUsers();
      
      for (const key of allKeys) {
        const testUserData = await getUser(key);
        if (testUserData && testUserData.qb_access_token && testUserData.qb_realm_id) {
          userData = testUserData;
          actualUserId = key;
          break;
        }
      }
    }
    
    if (!userData || !userData.qb_access_token || !userData.qb_realm_id) {
      return res.json({
        step: "find_user",
        error: "No QB tokens found",
        providedUserId
      });
    }
    
    const baseUrl = getQBBaseUrl();
    const realmId = userData.qb_realm_id;
    const query = `SELECT * FROM Customer MAXRESULTS 1`;
    const encodedQuery = encodeURIComponent(query);
    
    try {
      const queryResponse = await makeQBApiCall(actualUserId, userData, async (qbClient, currentUserData) => {
        return await qbClient.makeApiCall({
          url: `${baseUrl}/v3/company/${realmId}/query?query=${encodedQuery}`,
          method: 'GET',
          headers: { 'Content-Type': 'application/json' }
        });
      });
      
      return res.json({
        step: "api_call_completed",
        actualUserId,
        realmId,
        responseType: typeof queryResponse,
        hasResponse: !!queryResponse,
        hasBody: queryResponse ? !!queryResponse.body : false,
        hasJson: queryResponse ? !!queryResponse.json : false,
        hasGetJson: queryResponse ? typeof queryResponse.getJson === 'function' : false,
        responseKeys: queryResponse ? Object.keys(queryResponse) : [],
        bodyPreview: queryResponse?.body ? (typeof queryResponse.body === 'string' ? queryResponse.body.substring(0, 200) : 'not a string') : null
      });
    } catch (apiError) {
      return res.json({
        step: "api_call_error",
        actualUserId,
        realmId,
        errorName: apiError.name,
        errorMessage: apiError.message,
        errorCode: apiError.code,
        statusCode: apiError.response?.statusCode || apiError.statusCode,
        responseBody: apiError.response?.body || apiError.body,
        intuit_tid: apiError.intuit_tid
      });
    }
  } catch (error) {
    res.json({
      step: "unexpected_error",
      error: error.message,
      stack: error.stack?.split('\n').slice(0, 5)
    });
  }
});

// Diagnostic endpoint to see all users and their QuickBooks connection status
router.get("/api/debug/users", async (req, res) => {
  try {
    const { listUsers } = require("../../config/postgres");
    const allKeys = await listUsers();
    
    const users = [];
    for (const key of allKeys) {
      const userData = await getUser(key);
      if (userData) {
        users.push({
          userId: key,
          hasPipedriveTokens: !!userData.access_token,
          hasQBTokens: !!(userData.qb_access_token && userData.qb_realm_id),
          qbRealmId: userData.qb_realm_id || null,
          apiDomain: userData.api_domain || null,
          createdAt: userData.created_at || null,
          qbUpdatedAt: userData.qb_updated_at || null
        });
      }
    }
    
    res.json({
      totalUsers: users.length,
      users: users
    });
  } catch (error) {
    console.error("Debug users error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Disconnect QuickBooks endpoint
router.post("/api/disconnect-qb", express.json(), async (req, res) => {
  try {
    const { userId } = req.body;
    const pipedriveToken = req.headers['x-pipedrive-token'];
    
    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }
    
    // Helper function to normalize userId - strip https://, http://, and .pipedrive.com suffix
    function normalizeUserId(id) {
      if (!id) return id;
      let normalized = id.toString();
      normalized = normalized.replace(/^https?:\/\//, '');
      normalized = normalized.replace(/\.pipedrive\.com$/, '');
      return normalized;
    }
    
    const normalizedInput = normalizeUserId(userId);
    console.log(`[QB Disconnect] Looking for user: ${userId} (normalized: ${normalizedInput})`);
    
    // Try multiple userId formats
    const possibleUserIds = [
      userId,
      normalizedInput,
      normalizedInput + '.pipedrive.com',
      'https://' + normalizedInput + '.pipedrive.com',
      'https://' + userId
    ];
    
    // Remove duplicates
    const uniqueUserIds = [...new Set(possibleUserIds.filter(id => id))];
    
    let userData = null;
    let foundUserId = null;
    
    // Try each format until we find one with QB tokens
    for (const tryUserId of uniqueUserIds) {
      const tryUserData = await getUser(tryUserId);
      if (tryUserData && tryUserData.qb_access_token && tryUserData.qb_realm_id) {
        userData = tryUserData;
        foundUserId = tryUserId;
        console.log(`[QB Disconnect] Found user with QB tokens under key: ${tryUserId}`);
        break;
      }
    }
    
    // If not found with direct lookups, scan all users
    if (!userData) {
      console.log(`[QB Disconnect] Direct lookup failed, scanning all users...`);
      const { listUsers } = require("../../config/postgres");
      const allKeys = await listUsers();
      
      for (const key of allKeys) {
        const testUserData = await getUser(key);
        if (testUserData && testUserData.qb_access_token && testUserData.qb_realm_id) {
          const normalizedKey = normalizeUserId(key);
          
          const isMatch = 
            normalizedKey === normalizedInput ||
            key === userId ||
            testUserData.api_domain?.includes(normalizedInput) ||
            normalizedInput.includes(normalizedKey) ||
            normalizedKey.includes(normalizedInput) ||
            (testUserData.pipedrive_user_id && testUserData.pipedrive_user_id.toString() === normalizedInput);
          
          if (isMatch) {
            userData = testUserData;
            foundUserId = key;
            console.log(`[QB Disconnect] Found matching user under key: ${key}`);
            break;
          }
        }
      }
    }
    
    if (!userData) {
      console.log(`[QB Disconnect] No user found with QB tokens for: ${userId}`);
      return res.status(404).json({ error: "User not found or no QuickBooks connection" });
    }
    
    // Validate authentication - check if the request is from the same Pipedrive instance
    // In a production environment, you would validate the signed token properly
    // For now, we check if the token contains the correct api_domain
    if (pipedriveToken) {
      try {
        const tokenData = JSON.parse(pipedriveToken);
        const tokenDomain = tokenData.api_domain || tokenData.data?.api_domain;
        
        // Check if the token domain matches the user's stored domain
        if (tokenDomain && userData.api_domain && 
            !tokenDomain.includes(userData.api_domain) && 
            !userData.api_domain.includes(tokenDomain)) {
          console.error(`[QB Disconnect] Domain mismatch - token: ${tokenDomain}, user: ${userData.api_domain}`);
          return res.status(403).json({ error: "Unauthorized - domain mismatch" });
        }
      } catch (e) {
        console.error(`[QB Disconnect] Invalid token format:`, e);
        // Allow disconnect from same domain even with invalid token format for backward compatibility
      }
    } else {
      // If no token provided, allow disconnect if user has QB tokens (they're already authenticated to have connected)
      // This is less secure but necessary since GET_SIGNED_TOKEN doesn't work in some Pipedrive contexts
      console.log(`[QB Disconnect] No authentication token provided, but allowing disconnect for existing QB user`);
      if (!userData.qb_access_token && !userData.qb_realm_id) {
        console.error(`[QB Disconnect] User has no QB connection to disconnect`);
        return res.status(400).json({ error: "No QuickBooks connection found" });
      }
    }
    
    // Revoke the token with QuickBooks before clearing from database
    try {
      const revokeClient = new OAuthClient({
        clientId: process.env.QB_CLIENT_ID,
        clientSecret: process.env.QB_CLIENT_SECRET,
        environment: process.env.QB_ENVIRONMENT || 'sandbox',
        redirectUri: process.env.APP_URL + '/auth/qb/callback'
      });
      
      revokeClient.setToken({
        access_token: userData.qb_access_token,
        refresh_token: userData.qb_refresh_token,
        token_type: 'Bearer',
        realmId: userData.qb_realm_id
      });
      
      await revokeClient.revoke();
      console.log(`[QB Disconnect] Token successfully revoked with QuickBooks`);
    } catch (revokeError) {
      // Log but don't fail - token might already be expired/revoked
      console.warn(`[QB Disconnect] Token revocation failed (may already be expired):`, revokeError.message);
    }
    
    // Clear QB tokens but preserve other user data
    const updatedUser = {
      ...userData,
      qb_access_token: null,
      qb_refresh_token: null,
      qb_expires_in: null,
      qb_token_type: null,
      qb_realm_id: null,
      qb_expires_at: null,
      qb_updated_at: null,
      setup_token: null,
      setup_token_expires: null,
      invoice_preferences: null
    };
    
    await setUser(foundUserId, updatedUser);
    
    console.log(`[QB Disconnect] QuickBooks disconnected for user: ${foundUserId}`);
    res.json({ success: true, message: "QuickBooks disconnected successfully" });
    
  } catch (error) {
    console.error("QB disconnect error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Setup preferences endpoints
router.post("/api/setup/preferences", express.json(), async (req, res) => {
  try {
    const { token, userId, authorizeAllUsers, preferences, shipstation } = req.body;
    
    if (!token || !userId) {
      return res.status(400).json({ error: "Token and User ID are required" });
    }
    
    // Normalize userId
    let normalizedUserId = userId;
    if (normalizedUserId.startsWith('https://')) {
      normalizedUserId = normalizedUserId.replace('https://', '');
    }
    
    // Get existing user data and verify token
    const userData = await getUser(normalizedUserId);
    if (!userData) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Validate the setup token
    if (!userData.setup_token || userData.setup_token !== token) {
      console.error(`[Setup] Invalid token for user ${normalizedUserId}`);
      return res.status(403).json({ error: "Invalid or expired setup token" });
    }
    
    // Check if token is expired
    if (userData.setup_token_expires && new Date(userData.setup_token_expires) < new Date()) {
      console.error(`[Setup] Expired token for user ${normalizedUserId}`);
      return res.status(403).json({ error: "Setup token has expired" });
    }
    
    // Build updated user data
    const updatedData = {
      ...userData,
      invoice_preferences: {
        authorizeAllUsers,
        ...preferences,
        setup_completed_at: new Date().toISOString()
      },
      setup_token: null,
      setup_token_expires: null
    };
    
    // Save ShipStation credentials if provided (encrypted)
    if (shipstation && shipstation.apiKey && shipstation.apiSecret) {
      updatedData.shipstation_api_key = encrypt(shipstation.apiKey);
      updatedData.shipstation_api_secret = encrypt(shipstation.apiSecret);
      updatedData.shipstation_auto_create = shipstation.autoCreateShipments !== false;
      updatedData.shipstation_connected_at = new Date().toISOString();
      console.log(`[Setup] ShipStation credentials saved (encrypted) for user: ${normalizedUserId}`);
    }
    
    await setUser(normalizedUserId, updatedData);
    
    console.log(`[Setup] Preferences saved for user: ${normalizedUserId}`);
    res.json({ success: true, message: "Preferences saved successfully" });
    
  } catch (error) {
    console.error("Setup preferences error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Test ShipStation connection
router.post("/api/shipstation/test", express.json(), async (req, res) => {
  try {
    const { apiKey, apiSecret } = req.body;
    
    if (!apiKey || !apiSecret) {
      return res.status(400).json({ error: "API Key and Secret are required" });
    }
    
    // Create Base64 auth string
    const authString = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
    
    // Test connection by fetching stores (lightweight API call)
    const response = await axios.get('https://ssapi.shipstation.com/stores', {
      headers: {
        'Authorization': `Basic ${authString}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (response.status === 200) {
      const stores = response.data;
      console.log(`[ShipStation] Connection test successful, found ${stores.length || 0} stores`);
      res.json({ 
        success: true, 
        message: 'Connected successfully',
        storeCount: stores.length || 0
      });
    } else {
      res.status(400).json({ error: 'Connection failed' });
    }
    
  } catch (error) {
    console.error('[ShipStation] Connection test failed:', error.message);
    
    if (error.response?.status === 401) {
      return res.status(401).json({ error: 'Invalid API credentials' });
    }
    
    res.status(500).json({ error: error.message || 'Connection failed' });
  }
});

// Save ShipStation credentials
router.post("/api/shipstation/save", express.json(), async (req, res) => {
  try {
    const { userId, apiKey, apiSecret } = req.body;
    const pipedriveToken = req.headers['x-pipedrive-token'];
    
    if (!userId || !apiKey || !apiSecret) {
      return res.status(400).json({ error: "User ID, API Key, and Secret are required" });
    }
    
    // Normalize userId - strip https://, http://, and .pipedrive.com suffix for comparison
    function normalizeUserId(id) {
      if (!id) return id;
      let normalized = id.toString();
      normalized = normalized.replace(/^https?:\/\//, '');
      normalized = normalized.replace(/\.pipedrive\.com$/, '');
      return normalized;
    }
    
    const normalizedInput = normalizeUserId(userId);
    
    // Try multiple userId formats to find the user
    const possibleUserIds = [
      userId,
      normalizedInput,
      normalizedInput + '.pipedrive.com'
    ];
    
    let userData = null;
    let foundUserId = null;
    
    for (const tryUserId of [...new Set(possibleUserIds.filter(id => id))]) {
      const tryUserData = await getUser(tryUserId);
      if (tryUserData && tryUserData.qb_access_token) {
        userData = tryUserData;
        foundUserId = tryUserId;
        break;
      }
    }
    
    if (!userData) {
      console.log(`[ShipStation] User not found for save: ${userId}`);
      return res.status(404).json({ error: "User not found. Please connect QuickBooks first." });
    }
    
    // Log authentication attempt (token is optional but logged for debugging)
    if (pipedriveToken) {
      console.log(`[ShipStation] Save request authenticated with Pipedrive token for: ${foundUserId}`);
    }
    
    // Encrypt and save credentials
    const updatedData = {
      ...userData,
      shipstation_api_key: encrypt(apiKey),
      shipstation_api_secret: encrypt(apiSecret),
      shipstation_auto_create: true,
      shipstation_connected_at: new Date().toISOString()
    };
    
    await setUser(foundUserId, updatedData);
    
    console.log(`[ShipStation] Credentials saved for user: ${foundUserId}`);
    res.json({ success: true, message: 'ShipStation connected successfully' });
    
  } catch (error) {
    console.error('[ShipStation] Save credentials error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to save credentials' });
  }
});

// Disconnect ShipStation
router.post("/api/shipstation/disconnect", express.json(), async (req, res) => {
  try {
    const { userId } = req.body;
    const pipedriveToken = req.headers['x-pipedrive-token'];
    
    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }
    
    // Normalize userId - strip https://, http://, and .pipedrive.com suffix for comparison
    function normalizeUserId(id) {
      if (!id) return id;
      let normalized = id.toString();
      normalized = normalized.replace(/^https?:\/\//, '');
      normalized = normalized.replace(/\.pipedrive\.com$/, '');
      return normalized;
    }
    
    const normalizedInput = normalizeUserId(userId);
    
    // Try multiple userId formats to find the user
    const possibleUserIds = [
      userId,
      normalizedInput,
      normalizedInput + '.pipedrive.com'
    ];
    
    let userData = null;
    let foundUserId = null;
    
    for (const tryUserId of [...new Set(possibleUserIds.filter(id => id))]) {
      const tryUserData = await getUser(tryUserId);
      if (tryUserData && tryUserData.shipstation_api_key) {
        userData = tryUserData;
        foundUserId = tryUserId;
        break;
      }
    }
    
    if (!userData) {
      console.log(`[ShipStation] User not found for disconnect: ${userId}`);
      return res.status(404).json({ error: "User not found or ShipStation not connected" });
    }
    
    // Log authentication attempt
    if (pipedriveToken) {
      console.log(`[ShipStation] Disconnect request authenticated with Pipedrive token for: ${foundUserId}`);
    }
    
    // Remove ShipStation credentials
    const updatedData = {
      ...userData,
      shipstation_api_key: null,
      shipstation_api_secret: null,
      shipstation_auto_create: null,
      shipstation_connected_at: null
    };
    
    await setUser(foundUserId, updatedData);
    
    console.log(`[ShipStation] Disconnected for user: ${foundUserId}`);
    res.json({ success: true, message: 'ShipStation disconnected' });
    
  } catch (error) {
    console.error('[ShipStation] Disconnect error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to disconnect' });
  }
});

// Get setup preferences  
router.get("/api/setup/preferences", async (req, res) => {
  try {
    const { userId, token } = req.query;
    
    if (!userId || !token) {
      return res.status(400).json({ error: "User ID and token are required" });
    }
    
    // Normalize userId
    let normalizedUserId = userId;
    if (normalizedUserId.startsWith('https://')) {
      normalizedUserId = normalizedUserId.replace('https://', '');
    }
    
    const userData = await getUser(normalizedUserId);
    if (!userData) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Validate the setup token for security
    if (!userData.setup_token || userData.setup_token !== token) {
      console.error(`[Setup] Invalid token for user ${normalizedUserId}`);
      return res.status(403).json({ error: "Invalid or expired setup token" });
    }
    
    // Check if token is expired
    if (userData.setup_token_expires && new Date(userData.setup_token_expires) < new Date()) {
      console.error(`[Setup] Expired token for user ${normalizedUserId}`);
      return res.status(403).json({ error: "Setup token has expired" });
    }
    
    res.json({
      preferences: userData.invoice_preferences || null,
      hasCompleteSetup: !!(userData.invoice_preferences?.setup_completed_at)
    });
    
  } catch (error) {
    console.error("Get preferences error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Setup complete page
router.get("/setup-complete", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Setup Complete</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          display: flex;
          justify-content: center;
          align-items: center;
          height: 100vh;
          margin: 0;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        }
        .container {
          background: white;
          padding: 40px;
          border-radius: 10px;
          box-shadow: 0 10px 40px rgba(0, 0, 0, 0.1);
          text-align: center;
          max-width: 500px;
        }
        h1 {
          color: #28a745;
          margin-bottom: 20px;
        }
        p {
          color: #666;
          line-height: 1.6;
        }
        .button {
          display: inline-block;
          margin-top: 20px;
          padding: 12px 30px;
          background: #2ca01c;
          color: white;
          text-decoration: none;
          border-radius: 5px;
        }
        .button:hover {
          background: #239018;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>✅ Setup Complete!</h1>
        <p>Your QuickBooks integration is now fully configured.</p>
        <p>You can now:</p>
        <ul style="text-align: left; display: inline-block;">
          <li>Create QuickBooks customers from Pipedrive deals</li>
          <li>Generate invoices with your preferred field mappings</li>
          <li>Sync contact information between both systems</li>
        </ul>
        <p>You can close this window and return to Pipedrive to start using the integration.</p>
        <script>
          // If opened in a popup, try to close it after a delay
          setTimeout(() => {
            if (window.opener) {
              window.close();
            }
          }, 10000);
        </script>
      </div>
    </body>
    </html>
  `);
});

router.get("/auth/pipedrive", (req, res) => {
  const authUrl = getAuthUrl();
  res.redirect(authUrl);
});

router.get("/auth/pipedrive/callback", async (req, res) => {
  console.log("Callback route hit! Code param:", req.query.code);
  const code = req.query.code;

  if (!code) {
    return res.status(400).send("Authorization code not provided");
  }

  try {
    const tokenData = await getToken(code);

    // Normalize userId by removing https:// prefix if present
    let userId = tokenData.api_domain || tokenData.user_id || "pipedrive_user";
    if (userId.startsWith('https://')) {
      userId = userId.replace('https://', '');
    }
    
    console.log(`[Pipedrive OAuth] Storing user data with userId: ${userId}`);

    // Save user tokens first
    await setUser(userId, {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in,
      token_type: tokenData.token_type,
      scope: tokenData.scope,
      api_domain: tokenData.api_domain,
      created_at: new Date().toISOString(),
    });

    // Check for and create QB Customer ID custom field if it doesn't exist
    try {
      const apiDomain = tokenData.api_domain || 'api.pipedrive.com';
      const apiToken = tokenData.access_token;
      
      // Get all deal fields
      const fieldsResponse = await axios.get(
        `https://${apiDomain}/v1/dealFields?api_token=${apiToken}`
      );
      
      // Check if qb_customer_id field exists
      const existingField = fieldsResponse.data.data?.find(
        field => field.name === 'QB Customer ID' || field.key === 'qb_customer_id'
      );
      
      let fieldKey = existingField?.key;
      
      if (!existingField) {
        // Create the custom field
        const createFieldResponse = await axios.post(
          `https://${apiDomain}/v1/dealFields?api_token=${apiToken}`,
          {
            name: 'QB Customer ID',
            field_type: 'text',
            add_visible_flag: true
          }
        );
        
        fieldKey = createFieldResponse.data.data.key;
        console.log('Field created:', fieldKey);
        
        // Update user data with the field key
        const userData = await getUser(userId);
        await setUser(userId, {
          ...userData,
          qb_field_id: fieldKey
        });
      } else {
        console.log('Field already exists:', fieldKey);
        
        // Save the field key if not already saved
        const userData = await getUser(userId);
        if (!userData.qb_field_id) {
          await setUser(userId, {
            ...userData,
            qb_field_id: fieldKey
          });
        }
      }
    } catch (fieldError) {
      console.error('Error creating custom field:', fieldError.response?.data || fieldError.message);
      // Continue even if field creation fails
    }

    // Instead of auto-redirecting to QuickBooks OAuth, show a success page
    // This is required for QuickBooks compliance - user must explicitly click to connect
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Installation Successful</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          }
          .success-container {
            background: white;
            padding: 40px;
            border-radius: 10px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.1);
            text-align: center;
            max-width: 500px;
          }
          h1 {
            color: #28a745;
            margin-bottom: 20px;
          }
          p {
            color: #666;
            line-height: 1.6;
            margin-bottom: 30px;
          }
          .success-icon {
            font-size: 60px;
            color: #28a745;
            margin-bottom: 20px;
          }
          .info-box {
            background: #f8f9fa;
            border-left: 4px solid #007bff;
            padding: 15px;
            margin-top: 20px;
            text-align: left;
          }
          .info-box h3 {
            margin-top: 0;
            color: #333;
          }
          button {
            background: #007bff;
            color: white;
            border: none;
            padding: 12px 30px;
            border-radius: 5px;
            font-size: 16px;
            cursor: pointer;
            margin-top: 20px;
          }
          button:hover {
            background: #0056b3;
          }
        </style>
      </head>
      <body>
        <div class="success-container">
          <div class="success-icon">✓</div>
          <h1>Installation Successful!</h1>
          <p>Your Pipedrive app has been successfully installed and authenticated.</p>
          
          <div class="info-box">
            <h3>Next Steps:</h3>
            <p>1. Navigate to your Pipedrive Settings → Installed apps → OnitQb</p>
            <p>2. Click the "Settings" tab in the app</p>
            <p>3. Click "Connect to QuickBooks" to complete the integration</p>
          </div>
          
          <button onclick="window.close()">Close This Window</button>
        </div>
        <script>
          // Try to close the window after 5 seconds
          setTimeout(function() {
            window.close();
          }, 5000);
        </script>
      </body>
      </html>
    `);
  } catch (error) {
    console.error("OAuth callback error:", error);
    console.log("Callback full error:" + JSON.stringify(error, null, 2));
    res
      .status(500)
      .send(
        "Auth failed: " +
          (error.response?.data?.error_description || "Unknown error"),
      );
  }
});

router.get("/auth/qb", (req, res) => {
  const userId = req.query.user_id;
  const isExtension = req.query.extension === "true";
  const companyDomain = req.query.company_domain;   // e.g., "onitathlere"
  const numericUserId = req.query.numeric_user_id;  // e.g., "23527284"

  console.log(`[QB Auth] Starting OAuth with userId: ${userId}, companyDomain: ${companyDomain}, numericUserId: ${numericUserId}`);

  // Pass userId, extension flag, and additional identifiers to getAuthUrl
  const authUrl = qbAuth.getAuthUrl(userId, isExtension, { companyDomain, numericUserId });

  res.redirect(authUrl);
});

router.get("/auth/qb/callback", async (req, res) => {
  const code = req.query.code;
  const stateParam = req.query.state;

  // Decode state parameter to get userId, extension flag, and additional identifiers
  let userId;
  let isExtension = false;
  let companyDomain = null;
  let numericUserId = null;

  try {
    const decodedState = Buffer.from(stateParam, "base64").toString("utf-8");
    const stateData = JSON.parse(decodedState);
    userId = stateData.userId;
    isExtension = stateData.extension || false;
    companyDomain = stateData.companyDomain || null;
    numericUserId = stateData.numericUserId || null;
    console.log(`[QB Callback] Decoded state - userId: ${userId}, companyDomain: ${companyDomain}, numericUserId: ${numericUserId}`);
  } catch (e) {
    // Fallback for old format (direct userId)
    userId = stateParam;
  }

  if (!code) {
    if (isExtension) {
      return res.send(
        '<script>parent.postMessage({ success: false, error: "Authorization code not provided" }, "*");</script>',
      );
    }
    return res.status(400).send("Authorization code not provided");
  }

  if (!userId) {
    if (isExtension) {
      return res.send(
        '<script>parent.postMessage({ success: false, error: "User ID not found" }, "*");</script>',
      );
    }
    return res.status(400).send("User ID not found in state parameter");
  }

  try {
    const requestUrl = req.url;
    const qbTokenData = await qbAuth.handleToken(requestUrl);
    
    console.log(`[QB OAuth] Storing QB data for userId: ${userId}, realmId: ${qbTokenData.realm_id}`);

    // Try to find existing user - first by provided userId, then look for any user with Pipedrive tokens
    let existingUser = await getUser(userId);
    let actualUserId = userId;
    
    // If no user found with this userId, or user has no Pipedrive tokens, try to find the canonical user
    // This handles the case where QB OAuth is initiated with a different userId format than Pipedrive OAuth
    if (!existingUser || !existingUser.pipedrive_access_token) {
      console.log(`[QB OAuth] No user with Pipedrive tokens found for userId: ${userId}, searching for existing installation...`);
      const { listUsers } = require("../../config/postgres");
      const allUserIds = await listUsers();
      
      for (const candidateId of allUserIds) {
        const candidateUser = await getUser(candidateId);
        if (candidateUser && candidateUser.pipedrive_access_token && !candidateUser.qb_access_token) {
          // Found a user with Pipedrive tokens but no QB tokens - this is our target
          console.log(`[QB OAuth] Found existing Pipedrive installation under userId: ${candidateId}, merging QB tokens`);
          existingUser = candidateUser;
          actualUserId = candidateId;
          break;
        } else if (candidateUser && candidateUser.pipedrive_access_token) {
          // Found a user with Pipedrive tokens (may already have QB tokens - update anyway)
          console.log(`[QB OAuth] Found existing Pipedrive installation under userId: ${candidateId}`);
          existingUser = candidateUser;
          actualUserId = candidateId;
          break;
        }
      }
    }
    
    if (!existingUser) {
      existingUser = {};
    }
    
    console.log(`[QB OAuth] Using actualUserId: ${actualUserId} for storing QB tokens`);

    const updatedUser = {
      ...existingUser,
      qb_access_token: qbTokenData.access_token,
      qb_refresh_token: qbTokenData.refresh_token,
      qb_expires_in: qbTokenData.expires_in,
      qb_token_type: qbTokenData.token_type,
      qb_realm_id: qbTokenData.realm_id,
      qb_expires_at: qbTokenData.expires_at,
      qb_updated_at: new Date().toISOString(),
    };
    
    // Store the numeric user ID if provided (for alternative lookup)
    if (numericUserId) {
      updatedUser.pipedrive_numeric_id = numericUserId;
      console.log(`[QB OAuth] Storing pipedrive_numeric_id: ${numericUserId}`);
    }

    await setUser(actualUserId, updatedUser);
    console.log(`[QB OAuth] Successfully stored QB tokens for userId: ${actualUserId}`);

    // Check if this user has already completed setup
    const hasCompleteSetup = !!(updatedUser.invoice_preferences?.setup_completed_at);

    // Generate a secure token for the setup session
    const crypto = require('crypto');
    const setupToken = crypto.randomBytes(32).toString('hex');
    
    // Store the setup token temporarily with the user data
    await setUser(actualUserId, {
      ...updatedUser,
      setup_token: setupToken,
      setup_token_expires: new Date(Date.now() + 30 * 60 * 1000).toISOString() // 30 minutes
    });

    // If in extension/iframe AND setup not complete, redirect to setup flow with secure token
    if (isExtension && !hasCompleteSetup) {
      // Redirect to the setup page with secure token instead of userId
      return res.redirect(`/setup.html?token=${encodeURIComponent(setupToken)}&userId=${encodeURIComponent(actualUserId)}`);
    }
    
    // If in extension/iframe and setup is complete, send message to parent
    if (isExtension) {
      return res.send(`
        <html>
          <body>
            <h3>Success! QuickBooks connected.</h3>
            <p>This window will close automatically...</p>
            <script>
              // Log window.opener status for debugging
              console.log('window.opener:', window.opener);
              console.log('window.opener is null:', window.opener === null);
              
              if (window.opener && !window.opener.closed) {
                console.log('Attempting to send postMessage to opener');
                try {
                  window.opener.postMessage({ success: true, source: 'qb-callback' }, '*');
                  console.log('postMessage sent successfully');
                } catch (error) {
                  console.error('Failed to send postMessage:', error);
                }
                setTimeout(() => window.close(), 2000);
              } else if (parent !== window) {
                console.log('No window.opener, trying parent');
                parent.postMessage({ success: true, source: 'qb-callback' }, '*');
              } else {
                console.log('No window.opener available (sandboxed environment)');
                // Just close the window since polling will handle the refresh
                setTimeout(() => window.close(), 2000);
              }
            </script>
          </body>
        </html>
      `);
    }

    // For regular flow, redirect to setup if not complete
    if (!hasCompleteSetup) {
      res.redirect(`/setup.html?userId=${encodeURIComponent(userId)}`);
    } else {
      // For regular flow with complete setup, show success page
      res.send(
        "<html><body><h1>Connected Successfully!</h1><p>You can close this window.</p></body></html>",
      );
    }
  } catch (error) {
    console.error("QB OAuth callback error:", error);

    if (isExtension) {
      return res.send(
        `<script>parent.postMessage({ success: false, error: "${error.message}" }, "*");</script>`,
      );
    }

    res
      .status(500)
      .json({ success: false, error: "QuickBooks authentication failed" });
  }
});

router.get("/success", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Connected - Onit Invoice Builder</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
          line-height: 1.6;
          color: #333;
          background: #f5f5f5;
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .container {
          max-width: 400px;
          margin: 0 auto;
          padding: 40px 20px;
        }
        .card {
          background: white;
          border-radius: 8px;
          box-shadow: 0 2px 10px rgba(0,0,0,0.1);
          padding: 50px 40px;
          text-align: center;
        }
        .icon {
          width: 72px;
          height: 72px;
          margin: 0 auto 24px;
          background: #e8f5e9;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .icon svg {
          width: 36px;
          height: 36px;
          color: #4caf50;
        }
        h1 {
          font-size: 24px;
          color: #1a1a2e;
          margin-bottom: 12px;
        }
        p {
          color: #666;
          font-size: 15px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="card">
          <div class="icon">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1>Successfully Connected</h1>
          <p>Your Pipedrive and QuickBooks accounts have been connected.</p>
        </div>
      </div>
    </body>
    </html>
  `);
});

// Disconnect landing page - Required by QuickBooks for production app approval
router.get("/disconnect", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Disconnected - Onit Invoice Builder</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
          line-height: 1.6;
          color: #333;
          background: #f5f5f5;
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .container {
          max-width: 400px;
          margin: 0 auto;
          padding: 40px 20px;
        }
        .card {
          background: white;
          border-radius: 8px;
          box-shadow: 0 2px 10px rgba(0,0,0,0.1);
          padding: 50px 40px;
          text-align: center;
        }
        .icon {
          width: 72px;
          height: 72px;
          margin: 0 auto 24px;
          background: #e8f5e9;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .icon svg {
          width: 36px;
          height: 36px;
          color: #4caf50;
        }
        h1 {
          font-size: 24px;
          color: #1a1a2e;
          margin-bottom: 12px;
        }
        p {
          color: #666;
          font-size: 15px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="card">
          <div class="icon">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1>Successfully Disconnected</h1>
          <p>Your QuickBooks account has been disconnected from Onit Invoice Builder.</p>
        </div>
      </div>
    </body>
    </html>
  `);
});

router.get("/api/user-status", async (req, res) => {
  try {
    // Helper function to normalize userId - strip https://, http://, and .pipedrive.com suffix
    function normalizeUserId(id) {
      if (!id) return id;
      let normalized = id.toString();
      normalized = normalized.replace(/^https?:\/\//, '');
      normalized = normalized.replace(/\.pipedrive\.com$/, '');
      return normalized;
    }
    
    // Accept multiple identifiers from the request
    let pipedriveUserId = req.query.userId;
    const companyDomain = req.query.companyDomain;  // e.g., "onitathlere"
    const numericUserId = req.query.numericUserId;  // e.g., "23527284"
    const normalizedInput = normalizeUserId(pipedriveUserId);
    
    console.log(`[API User Status] Checking status for userId: ${pipedriveUserId} (normalized: ${normalizedInput}), companyDomain: ${companyDomain}, numericUserId: ${numericUserId}`);

    if (!pipedriveUserId && !companyDomain && !numericUserId) {
      console.log('[API User Status] No userId provided');
      return res.json({
        connected: false,
        message: "Connect QuickBooks to start.",
        debug: {
          userId: null,
          reason: "No userId provided"
        }
      });
    }

    // Try multiple userId formats - prioritize companyDomain if provided
    const possibleUserIds = [
      companyDomain,                                       // Company domain (e.g., "onitathlere")
      pipedriveUserId,                                     // Original input
      normalizedInput,                                     // Normalized (no https, no .pipedrive.com)
      normalizedInput + '.pipedrive.com',                  // Add suffix back
      'https://' + normalizedInput + '.pipedrive.com',     // Full URL
      'https://' + pipedriveUserId                         // With https prefix
    ];
    
    // Remove duplicates and nulls
    const uniqueUserIds = [...new Set(possibleUserIds.filter(id => id))];
    console.log(`[API User Status] Trying userId formats:`, uniqueUserIds);
    
    let userData = null;
    let foundUserId = null;
    
    // Try each format until we find one with data
    for (const tryUserId of uniqueUserIds) {
      const tryUserData = await getUser(tryUserId);
      if (tryUserData) {
        userData = tryUserData;
        foundUserId = tryUserId;
        console.log(`[API User Status] Found user data under key: ${tryUserId}`);
        // If this user has QB tokens, use it immediately
        if (tryUserData.qb_access_token && tryUserData.qb_realm_id) {
          console.log(`[API User Status] User has QB tokens`);
          break;
        }
      }
    }
    
    // If no QB tokens found, scan all users for matching QB connection
    if (!userData || (!userData.qb_access_token && !userData.qb_realm_id)) {
      console.log(`[API User Status] No QB tokens found, checking all users...`);
      const { listUsers } = require("../../config/postgres");
      const allKeys = await listUsers();
      
      console.log(`[API User Status] Scanning ${allKeys.length} stored users for QB connection...`);
      
      for (const key of allKeys) {
        const testUserData = await getUser(key);
        if (testUserData && testUserData.qb_access_token && testUserData.qb_realm_id) {
          // Normalize both IDs for comparison
          const normalizedKey = normalizeUserId(key);
          
          // Check various matching conditions - include numericUserId and companyDomain
          const isMatch = 
            normalizedKey === normalizedInput ||
            key === pipedriveUserId ||
            testUserData.api_domain?.includes(normalizedInput) ||
            normalizedInput.includes(normalizedKey) ||
            normalizedKey.includes(normalizedInput) ||
            // Check if stored numeric user ID matches the provided numeric ID
            (numericUserId && testUserData.pipedrive_numeric_id === numericUserId) ||
            // Check if the userId itself is numeric and matches stored pipedrive_numeric_id
            (testUserData.pipedrive_numeric_id && testUserData.pipedrive_numeric_id === pipedriveUserId) ||
            (testUserData.pipedrive_numeric_id && testUserData.pipedrive_numeric_id === normalizedInput) ||
            // Check if company domain matches
            (companyDomain && normalizedKey === companyDomain) ||
            (companyDomain && key === companyDomain) ||
            // Check if stored pipedrive_user_id matches company domain
            (companyDomain && testUserData.pipedrive_user_id === companyDomain);
          
          if (isMatch) {
            console.log(`[API User Status] Found QB tokens under alternative ID: ${key} (normalized: ${normalizedKey})`);
            userData = testUserData;
            foundUserId = key;
            break;
          }
        }
      }
    }

    if (!userData) {
      console.log(`[API User Status] No user data found for userId: ${pipedriveUserId}`);
      return res.json({
        connected: false,
        message: "Connect QuickBooks to start.",
        debug: {
          userId: pipedriveUserId,
          reason: "No user data found in database"
        }
      });
    }

    // Check if QuickBooks tokens exist
    let isConnected = !!(userData.qb_access_token && userData.qb_realm_id);
    
    // If connected, check for token expiration and attempt proactive refresh
    // Only attempt refresh if token is expiring soon (has refresh token check built into refreshAndSaveToken)
    if (isConnected && tokenNeedsRefresh(userData)) {
      console.log(`[API User Status] QB tokens expiring soon for user ${pipedriveUserId}, attempting proactive refresh...`);
      
      try {
        const refreshedData = await refreshAndSaveToken(foundUserId, userData);
        if (refreshedData) {
          userData = refreshedData;
          console.log(`[API User Status] QB token refreshed successfully for user ${pipedriveUserId}`);
        } else {
          // No refresh token available - this is fine, existing token may still work
          console.log(`[API User Status] No refresh token available, continuing with existing token`);
        }
        // Keep isConnected = true in both cases
      } catch (refreshError) {
        console.error(`[API User Status] Proactive refresh failed for user ${pipedriveUserId}:`, refreshError.message);
        
        // GRACEFUL FALLBACK: Don't mark as disconnected for most proactive refresh failures
        // The existing token might still work - only mark disconnected if token is truly invalid
        const errorMessage = refreshError.message?.toLowerCase() || '';
        
        // Only mark as disconnected if the error clearly indicates the refresh token is unusable
        if (errorMessage.includes('invalid') && errorMessage.includes('refresh')) {
          console.log(`[API User Status] Refresh token appears invalid, marking as disconnected`);
          isConnected = false;
          userData.tokenExpired = true;
        } else {
          // For other errors (network issues, temporary failures), keep connected
          // The token might still work or makeQBApiCall will handle refresh on 401
          console.log(`[API User Status] Proactive refresh failed but keeping connected status (token may still work)`);
          // isConnected stays true
        }
      }
    }
    
    console.log(`[API User Status] User ${pipedriveUserId} - QB Connected: ${isConnected}, Realm ID: ${userData.qb_realm_id || 'none'}`);

    if (isConnected) {
      // Fetch QuickBooks company info
      let companyName = null;
      try {
        console.log("Fetching company info for realm:", userData.qb_realm_id);
        
        const oauthClient = new OAuthClient({
          clientId: process.env.QB_CLIENT_ID,
          clientSecret: process.env.QB_CLIENT_SECRET,
          environment: process.env.QB_ENVIRONMENT || "sandbox",
          redirectUri: `${process.env.APP_URL}/auth/qb/callback`,
        });
        
        // Set the tokens
        oauthClient.setToken({
          access_token: userData.qb_access_token,
          refresh_token: userData.qb_refresh_token,
          token_type: "Bearer",
          expires_in: 3600,
          x_refresh_token_expires_in: 8726400,
          realmId: userData.qb_realm_id
        });
        
        // Get company info
        const companyInfoResponse = await oauthClient.makeApiCall({
          url: `${getQBBaseUrl()}/v3/company/${userData.qb_realm_id}/companyinfo/${userData.qb_realm_id}`,
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          }
        });
        
        console.log("Company info response received:", companyInfoResponse.json ? "JSON data present" : "No JSON");
        
        if (companyInfoResponse.json && companyInfoResponse.json.CompanyInfo) {
          companyName = companyInfoResponse.json.CompanyInfo.CompanyName;
          console.log("Company name extracted:", companyName);
        }
      } catch (companyError) {
        console.error("Error fetching company info:", companyError);
        console.error("Company error details:", {
          message: companyError.message,
          response: companyError.response,
          statusCode: companyError.statusCode
        });
        // Continue without company name if fetch fails
      }
      
      res.json({
        connected: true,
        message: "Ready to sync!",
        companyName: companyName,
        debug: {
          userId: pipedriveUserId,
          realmId: userData.qb_realm_id,
          hasCompanyName: !!companyName
        }
      });
    } else {
      // Check if it's a token expiry issue
      if (userData && userData.tokenExpired) {
        res.json({
          connected: false,
          message: "QuickBooks session expired. Please reconnect.",
          tokenExpired: true,
          debug: {
            userId: pipedriveUserId,
            reason: "Refresh token expired - reconnection required"
          }
        });
      } else {
        res.json({
          connected: false,
          message: "Connect QuickBooks to start.",
          debug: {
            userId: pipedriveUserId,
            reason: "No QB tokens found"
          }
        });
      }
    }
  } catch (error) {
    console.error("User status check error:", error);
    res.json({
      connected: false,
      message: "Connect QuickBooks to start.",
    });
  }
});

router.post("/api/sync-contact", express.json(), async (req, res) => {
  try {
    const { personId } = req.body;
    const pipedriveUserId =
      req.query.userId || req.session?.userId || req.body.userId;

    if (!personId) {
      return res.status(400).json({
        success: false,
        error: "personId is required in request body",
      });
    }

    if (!pipedriveUserId) {
      return res.status(400).json({
        success: false,
        error:
          "pipedriveUserId is required (pass as query param userId, in session, or in body)",
      });
    }

    console.log(
      `Sync request received - User: ${pipedriveUserId}, Person: ${personId}`,
    );

    const result = await syncContact(pipedriveUserId, personId);

    res.json({
      success: true,
      qbCustomerId: result.qbCustomerId,
      action: result.action,
      personName: result.pipedrivePersonName,
    });
  } catch (error) {
    console.error("API sync-contact error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Helper function to create QB client with tokens
async function createQBClient(userId) {
  const userData = await getUser(userId);
  if (!userData || !userData.qb_access_token) {
    throw new Error("QuickBooks not connected for this user");
  }

  const qbClient = new OAuthClient({
    clientId: process.env.QB_CLIENT_ID,
    clientSecret: process.env.QB_CLIENT_SECRET,
    environment: process.env.QB_ENVIRONMENT || 'sandbox',
    redirectUri: process.env.APP_URL + '/auth/qb/callback',
    logging: false
  });

  qbClient.setToken({
    access_token: userData.qb_access_token,
    refresh_token: userData.qb_refresh_token,
    token_type: 'Bearer',
    expires_in: userData.qb_expires_in,
    x_refresh_token_expires_in: 8726400,
    realmId: userData.qb_realm_id
  });

  return { qbClient, companyId: userData.qb_realm_id };
}

// Get a specific QuickBooks customer by ID
router.get("/api/customer/:customerId", async (req, res) => {
  try {
    const { customerId } = req.params;
    const providedUserId = req.query.userId || 'test';
    
    if (!customerId) {
      return res.status(400).json({ 
        success: false, 
        error: "Customer ID is required" 
      });
    }
    
    // Try to find user with QB tokens - check multiple ID formats
    let userData = null;
    let actualUserId = providedUserId;
    
    // First try the provided user ID
    userData = await getUser(providedUserId);
    
    // If no QB tokens, try different user ID formats
    if (!userData || !userData.qb_access_token || !userData.qb_realm_id) {
      console.log(`No QB tokens for ${providedUserId}, checking alternative IDs for customer detail...`);
      
      // Get all users to find one with QB tokens
      const { listUsers } = require("../../config/postgres");
      const allKeys = await listUsers();
      
      // Check if we can find a user with QB tokens that matches this domain
      for (const key of allKeys) {
        const testUserData = await getUser(key);
        if (testUserData && testUserData.qb_access_token && testUserData.qb_realm_id) {
          // Check if this user is related to the provided userId
          const normalizedProvidedId = providedUserId.replace('https://', '');
          const normalizedKey = key.replace('https://', '');
          
          if (normalizedKey === normalizedProvidedId ||
              testUserData.api_domain?.includes(normalizedProvidedId) ||
              normalizedProvidedId.includes(testUserData.api_domain?.replace('https://', '') || 'NOMATCH')) {
            console.log(`Found QB tokens under alternative ID: ${key}`);
            userData = testUserData;
            actualUserId = key;
            break;
          }
          
          // Also check if this might be the right user based on having QB tokens
          if (!userData && testUserData.qb_realm_id) {
            userData = testUserData;
            actualUserId = key;
          }
        }
      }
    }
    
    if (!userData || !userData.qb_access_token || !userData.qb_realm_id) {
      return res.status(400).json({
        success: false,
        error: "QuickBooks not connected for this user"
      });
    }
    
    const baseUrl = getQBBaseUrl();
    const companyId = userData.qb_realm_id;
    
    // Make API call with automatic token refresh - pass actualUserId for correct persistence
    const customerResponse = await makeQBApiCall(actualUserId, userData, async (qbClient, currentUserData) => {
      return await qbClient.makeApiCall({
        url: `${baseUrl}/v3/company/${companyId}/customer/${customerId}?minorversion=65`,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });
    });
    
    const customer = getQBResponseData(customerResponse).Customer;
    
    res.json({
      success: true,
      customer: customer
    });
    
  } catch (error) {
    console.error('Error fetching customer:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch customer'
    });
  }
});

// Get invoices for a QuickBooks customer
router.get("/api/customer/:customerId/invoices", async (req, res) => {
  try {
    const { customerId } = req.params;
    const providedUserId = req.query.userId || 'test';
    const { startDate, endDate } = req.query;
    
    if (!customerId) {
      return res.status(400).json({ 
        success: false, 
        error: "Customer ID is required" 
      });
    }
    
    // Try to find user with QB tokens - check multiple ID formats
    let userData = null;
    let actualUserId = providedUserId;
    
    // First try the provided user ID
    userData = await getUser(providedUserId);
    
    // If no QB tokens, try different user ID formats
    if (!userData || !userData.qb_access_token || !userData.qb_realm_id) {
      console.log(`No QB tokens for ${providedUserId}, checking alternative IDs for invoices...`);
      
      // Get all users to find one with QB tokens
      const { listUsers } = require("../../config/postgres");
      const allKeys = await listUsers();
      
      // Check if we can find a user with QB tokens that matches this domain
      for (const key of allKeys) {
        const testUserData = await getUser(key);
        if (testUserData && testUserData.qb_access_token && testUserData.qb_realm_id) {
          // Check if this user is related to the provided userId
          const normalizedProvidedId = providedUserId.replace('https://', '');
          const normalizedKey = key.replace('https://', '');
          
          if (normalizedKey === normalizedProvidedId ||
              testUserData.api_domain?.includes(normalizedProvidedId) ||
              normalizedProvidedId.includes(testUserData.api_domain?.replace('https://', '') || 'NOMATCH')) {
            console.log(`Found QB tokens under alternative ID: ${key}`);
            userData = testUserData;
            actualUserId = key;
            break;
          }
          
          // Also check if this might be the right user based on having QB tokens
          if (!userData && testUserData.qb_realm_id) {
            userData = testUserData;
            actualUserId = key;
          }
        }
      }
    }
    
    if (!userData || !userData.qb_access_token || !userData.qb_realm_id) {
      return res.status(400).json({
        success: false,
        error: "QuickBooks not connected for this user"
      });
    }
    
    const baseUrl = getQBBaseUrl();
    const companyId = userData.qb_realm_id;
    
    // Build query for invoices
    let query = `select * from Invoice where CustomerRef='${customerId}'`;
    
    // Add date filters if provided
    if (startDate) {
      query += ` and TxnDate >= '${startDate}'`;
    }
    if (endDate) {
      query += ` and TxnDate <= '${endDate}'`;
    }
    
    // Make API call with automatic token refresh - pass actualUserId for correct persistence
    const invoiceResponse = await makeQBApiCall(actualUserId, userData, async (qbClient, currentUserData) => {
      return await qbClient.makeApiCall({
        url: `${baseUrl}/v3/company/${companyId}/query?query=${encodeURIComponent(query)}&minorversion=65`,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });
    });
    
    const responseData = getQBResponseData(invoiceResponse);
    const invoices = responseData.QueryResponse?.Invoice || [];
    
    // Calculate overview totals
    const overview = {
      outstanding: 0,
      overdue: 0,
      paid: 0,
      total: 0
    };
    
    const today = new Date();
    
    invoices.forEach(invoice => {
      const amount = parseFloat(invoice.TotalAmt || 0);
      const balance = parseFloat(invoice.Balance || 0);
      const dueDate = new Date(invoice.DueDate);
      
      overview.total += amount;
      
      if (balance > 0) {
        overview.outstanding += balance;
        
        if (dueDate < today) {
          overview.overdue += balance;
        }
      } else {
        overview.paid += amount;
      }
    });
    
    res.json({
      success: true,
      invoices: invoices,
      overview: overview
    });
    
  } catch (error) {
    console.error('Error fetching invoices:', error.message);
    console.error('Error stack:', error.stack);
    if (error.response) {
      console.error('Error response body:', error.response.body || error.response.data);
    }
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch invoices',
      overview: {
        outstanding: 0,
        overdue: 0,
        paid: 0,
        total: 0
      }
    });
  }
});

// Get the custom field key for QB Customer ID
router.get("/api/field-key", async (req, res) => {
  try {
    const userId = req.query.userId || 'test';
    const userData = await getUser(userId);
    
    res.json({
      success: true,
      fieldKey: userData?.qb_field_id || null
    });
  } catch (error) {
    console.error("Get field key error:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Search QuickBooks customers
router.get("/api/customers/search", async (req, res) => {
  try {
    const searchTerm = req.query.term;
    const providedUserId = req.query.userId || 'test';

    console.log('Search term:', searchTerm, 'User ID:', providedUserId);

    if (!searchTerm) {
      return res.status(400).json({
        success: false,
        error: "Search term is required"
      });
    }

    // Try to find user with QB tokens - check multiple ID formats
    let userData = null;
    let actualUserId = providedUserId;
    
    // First try the provided user ID
    userData = await getUser(providedUserId);
    
    // If no QB tokens, try different user ID formats
    if (!userData || !userData.qb_access_token || !userData.qb_realm_id) {
      console.log(`No QB tokens for ${providedUserId}, checking alternative IDs...`);
      
      // Get all users to find one with QB tokens
      const { listUsers } = require("../../config/postgres");
      const allKeys = await listUsers();
      
      // Check if we can find a user with QB tokens that matches this domain
      for (const key of allKeys) {
        const testUserData = await getUser(key);
        if (testUserData && testUserData.qb_access_token && testUserData.qb_realm_id) {
          // Check if this user is related to the provided userId
          // Could be same domain with/without https, or could be the numeric ID
          const normalizedProvidedId = providedUserId.replace('https://', '');
          const normalizedKey = key.replace('https://', '');
          
          if (normalizedKey === normalizedProvidedId ||
              testUserData.api_domain?.includes(normalizedProvidedId) ||
              normalizedProvidedId.includes(testUserData.api_domain?.replace('https://', '') || 'NOMATCH')) {
            console.log(`Found QB tokens under alternative ID: ${key}`);
            userData = testUserData;
            actualUserId = key;
            break;
          }
          
          // Also check if this might be the right user based on having QB tokens
          // (for the case where numeric ID has tokens but domain ID doesn't)
          if (!userData && testUserData.qb_realm_id) {
            // Save as potential match
            userData = testUserData;
            actualUserId = key;
            // Continue searching for a better match
          }
        }
      }
    }
    
    if (!userData || !userData.qb_access_token || !userData.qb_realm_id) {
      console.log(`[Search] No QB connection found for userId: ${providedUserId}`);
      return res.status(400).json({
        success: false,
        error: "QuickBooks not connected for this user"
      });
    }

    console.log(`[Search] Found QB connection for user: ${actualUserId}, realm: ${userData.qb_realm_id}`);
    
    const baseUrl = getQBBaseUrl();
    const realmId = userData.qb_realm_id;
    
    // Build query to search customers by DisplayName
    const query = `SELECT * FROM Customer WHERE DisplayName LIKE '%${searchTerm}%' MAXRESULTS 10`;
    const encodedQuery = encodeURIComponent(query);
    
    console.log(`[Search] Executing QB query: ${query}`);
    
    // Make API call to QuickBooks with automatic token refresh - pass actualUserId for correct persistence
    const queryResponse = await makeQBApiCall(actualUserId, userData, async (qbClient, currentUserData) => {
      return await qbClient.makeApiCall({
        url: `${baseUrl}/v3/company/${realmId}/query?query=${encodedQuery}`,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });
    });
    
    console.log(`[Search] QB API response received:`, {
      hasResponse: !!queryResponse,
      responseType: typeof queryResponse,
      hasBody: queryResponse ? !!queryResponse.body : false,
      hasJson: queryResponse ? !!queryResponse.json : false,
      hasGetJson: queryResponse ? typeof queryResponse.getJson === 'function' : false,
      keys: queryResponse ? Object.keys(queryResponse) : []
    });
    
    // Check if response exists
    if (!queryResponse) {
      console.error("[Search] Invalid QuickBooks response - no response");
      return res.status(500).json({
        success: false,
        error: "Invalid response from QuickBooks"
      });
    }
    
    // Use helper to get response data (intuit-oauth library can return different formats)
    let queryResult;
    try {
      queryResult = getQBResponseData(queryResponse);
    } catch (parseError) {
      console.error("[Search] Could not extract data from QB response:", parseError.message);
      return res.status(500).json({
        success: false,
        error: "Could not parse QuickBooks response"
      });
    }
    const customers = queryResult.QueryResponse?.Customer || [];
    
    // Transform to simplified format { id, name, email }
    const simplifiedCustomers = customers.map(customer => ({
      id: customer.Id,
      name: customer.DisplayName || 'Unnamed',
      email: customer.PrimaryEmailAddr?.Address || null
    }));
    
    res.json(simplifiedCustomers);
  } catch (error) {
    console.error("Search customers error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      debug: {
        errorName: error.name,
        statusCode: error.response?.statusCode || error.statusCode,
        responseBody: error.response?.body,
        intuit_tid: error.intuit_tid
      }
    });
  }
});

// Create new QuickBooks customer
router.post("/api/create-customer", express.json(), async (req, res) => {
  try {
    const { name, email, phone } = req.body;
    const userId = req.query.userId || req.body.userId || 'test';

    if (!name) {
      return res.status(400).json({
        success: false,
        error: "Customer name is required"
      });
    }

    const { qbClient, companyId } = await createQBClient(userId);
    const baseUrl = getQBBaseUrl();
    
    const customerData = {
      DisplayName: name,
      Active: true
    };

    if (email) {
      customerData.PrimaryEmailAddr = {
        Address: email
      };
    }

    if (phone) {
      customerData.PrimaryPhone = {
        FreeFormNumber: phone
      };
    }

    const createResponse = await qbClient.makeApiCall({
      url: `${baseUrl}/v3/company/${companyId}/customer?minorversion=65`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(customerData)
    });
    
    const createdCustomer = getQBResponseData(createResponse).Customer;
    
    res.json({
      success: true,
      customer: createdCustomer
    });
  } catch (error) {
    console.error("Create customer error:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Attach QuickBooks customer to Pipedrive deal
router.post("/api/attach-contact", express.json(), async (req, res) => {
  try {
    const { dealId, qbCustomerId, customerName } = req.body;
    const providedUserId = req.query.userId || req.body.userId || 'test';

    console.log('[Attach Contact] dealId:', dealId, 'qbCustomerId:', qbCustomerId, 'userId:', providedUserId);

    if (!dealId || !qbCustomerId) {
      return res.status(400).json({
        success: false,
        error: "dealId and qbCustomerId are required"
      });
    }

    // Try to find user with Pipedrive tokens - check multiple ID formats
    let userData = null;
    let actualUserId = providedUserId;
    
    // First try the provided user ID
    const initialUserData = await getUser(providedUserId);
    if (initialUserData && initialUserData.access_token) {
      userData = initialUserData;
    }
    
    // If no Pipedrive tokens, try different user ID formats
    if (!userData) {
      console.log(`[Attach Contact] No Pipedrive tokens for ${providedUserId}, checking alternative IDs...`);
      
      // Get all users to find one with Pipedrive tokens
      const { listUsers } = require("../../config/postgres");
      const allKeys = await listUsers();
      
      // Collect all users with Pipedrive tokens, tracking their freshness
      const usersWithPipedriveTokens = [];
      const qbTokensByDomain = {}; // Track QB tokens by api_domain for safe merging
      
      for (const key of allKeys) {
        const testUserData = await getUser(key);
        
        // Track users with QB tokens, indexed by their api_domain for tenant-safe merging
        if (testUserData && testUserData.qb_access_token && testUserData.qb_realm_id && testUserData.api_domain) {
          const normalizedDomain = testUserData.api_domain.replace('https://', '');
          if (!qbTokensByDomain[normalizedDomain]) {
            qbTokensByDomain[normalizedDomain] = { key, data: testUserData };
          }
        }
        
        if (testUserData && testUserData.access_token) {
          // Check if this user is related to the provided userId
          const normalizedProvidedId = providedUserId.replace('https://', '');
          const normalizedKey = key.replace('https://', '');
          
          if (normalizedKey === normalizedProvidedId ||
              testUserData.api_domain?.includes(normalizedProvidedId) ||
              normalizedProvidedId.includes(testUserData.api_domain?.replace('https://', '') || 'NOMATCH')) {
            console.log(`[Attach Contact] Found Pipedrive tokens under alternative ID: ${key}`);
            userData = testUserData;
            actualUserId = key;
            break;
          }
          
          // Collect this user for freshness comparison
          usersWithPipedriveTokens.push({
            key,
            data: testUserData,
            createdAt: testUserData.created_at ? new Date(testUserData.created_at) : new Date(0),
            hasQBTokens: !!(testUserData.qb_access_token && testUserData.qb_realm_id),
            apiDomain: testUserData.api_domain?.replace('https://', '') || null
          });
        }
      }
      
      // If no direct match found, use the FRESHEST Pipedrive tokens (most recently created)
      if (!userData && usersWithPipedriveTokens.length > 0) {
        // Sort by creation date, newest first
        usersWithPipedriveTokens.sort((a, b) => b.createdAt - a.createdAt);
        
        const freshest = usersWithPipedriveTokens[0];
        console.log(`[Attach Contact] Using freshest Pipedrive tokens from: ${freshest.key} (created: ${freshest.data.created_at || 'unknown'})`);
        
        userData = freshest.data;
        actualUserId = freshest.key;
        
        // If freshest user doesn't have QB tokens, try to find QB tokens from SAME tenant only
        // We check both api_domain AND ensure QB realm consistency
        if (!freshest.hasQBTokens && freshest.apiDomain) {
          const sameTenantQB = qbTokensByDomain[freshest.apiDomain];
          // Only merge if:
          // 1. Same api_domain (Pipedrive tenant)
          // 2. AND the freshest user has a known qb_realm_id that matches (if set)
          // OR the freshest user has no qb_realm_id yet (first time linking)
          const canMerge = sameTenantQB && (
            !userData.qb_realm_id || // No existing realm - safe to merge
            userData.qb_realm_id === sameTenantQB.data.qb_realm_id // Same realm - safe to merge
          );
          
          if (canMerge) {
            console.log(`[Attach Contact] Merging QB tokens from same tenant ${sameTenantQB.key} (realm: ${sameTenantQB.data.qb_realm_id}) into ${actualUserId}`);
            userData.qb_access_token = sameTenantQB.data.qb_access_token;
            userData.qb_refresh_token = sameTenantQB.data.qb_refresh_token;
            userData.qb_realm_id = sameTenantQB.data.qb_realm_id;
            
            // Persist the merged data
            const { setUser } = require("../../config/postgres");
            await setUser(actualUserId, userData);
            console.log(`[Attach Contact] Merged and saved user data under ${actualUserId}`);
          } else if (sameTenantQB) {
            console.log(`[Attach Contact] Skipping QB token merge - realm mismatch: user has ${userData.qb_realm_id}, found ${sameTenantQB.data.qb_realm_id}`);
          } else {
            console.log(`[Attach Contact] No QB tokens found for tenant ${freshest.apiDomain}`);
          }
        }
      }
    }

    if (!userData || !userData.access_token) {
      console.log(`[Attach Contact] No Pipedrive connection found for userId: ${providedUserId}`);
      return res.status(400).json({
        success: false,
        error: "Pipedrive not connected for this user"
      });
    }
    
    console.log(`[Attach Contact] Using user: ${actualUserId}`);

    // Handle api_domain with or without https:// prefix
    let apiDomain = userData.api_domain || 'api.pipedrive.com';
    if (apiDomain.startsWith('https://')) {
      apiDomain = apiDomain.replace('https://', '');
    }

    // Helper function to make Pipedrive API call with auto token refresh
    const makePipedriveCall = async (method, endpoint, data = null, retryCount = 0) => {
      const accessToken = userData.access_token;
      const url = `https://${apiDomain}${endpoint}`;
      const headers = {
        'Authorization': `Bearer ${accessToken}`
      };
      
      console.log(`[Attach Contact] Making ${method} request to ${endpoint} (attempt ${retryCount + 1})`);
      
      try {
        let response;
        if (method === 'GET') {
          response = await axios.get(url, { headers });
        } else if (method === 'PUT' || method === 'POST') {
          // Use form-urlencoded for PUT/POST requests (Pipedrive v1 API preference)
          const formData = new URLSearchParams();
          for (const [key, value] of Object.entries(data)) {
            formData.append(key, value);
          }
          const requestHeaders = { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' };
          if (method === 'PUT') {
            response = await axios.put(url, formData, { headers: requestHeaders });
          } else {
            response = await axios.post(url, formData, { headers: requestHeaders });
          }
        }
        return response;
      } catch (error) {
        // If 401 and we haven't retried yet, try to refresh token
        if (error.response?.status === 401 && userData.refresh_token && retryCount === 0) {
          console.log('[Attach Contact] Token expired, attempting refresh...');
          try {
            const pipedriveAuth = require('../auth/pipedrive');
            const newTokens = await pipedriveAuth.refreshToken(userData.refresh_token);
            
            console.log('[Attach Contact] Token refresh response received, new token prefix:', newTokens.access_token?.substring(0, 20) + '...');
            
            // Update userData with new tokens (in memory)
            userData.access_token = newTokens.access_token;
            userData.refresh_token = newTokens.refresh_token;
            
            // Persist updated tokens to database
            const { setUser } = require("../../config/postgres");
            await setUser(actualUserId, {
              ...userData,
              access_token: newTokens.access_token,
              refresh_token: newTokens.refresh_token,
              pipedrive_updated_at: new Date().toISOString()
            });
            
            console.log('[Attach Contact] Token refreshed and persisted successfully');
            
            // Retry with new token (recursive call with incremented retry count)
            return await makePipedriveCall(method, endpoint, data, retryCount + 1);
          } catch (refreshError) {
            console.error('[Attach Contact] Token refresh failed:', refreshError.message);
            throw new Error('Pipedrive session expired. Please go to the QuickBooks Contact Manager settings and click "Reconnect to Pipedrive".');
          }
        }
        throw error;
      }
    };

    // Store the deal-to-QB customer mapping in our database
    // This is more reliable than trying to store it in Pipedrive's notes field
    const { setDealMapping } = require("../../config/postgres");
    await setDealMapping(dealId, qbCustomerId, customerName);
    
    console.log(`[Attach Contact] Successfully linked deal ${dealId} to QB customer ${qbCustomerId}`);

    res.json({
      success: true,
      message: "QuickBooks customer attached to deal",
      dealId: dealId,
      qbCustomerId: qbCustomerId
    });
  } catch (error) {
    console.error("Attach contact error:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get deal-contact association
router.get("/api/deal-contact", async (req, res) => {
  try {
    const { dealId } = req.query;
    const userId = req.query.userId || 'test';

    if (!dealId) {
      return res.status(400).json({
        success: false,
        error: "dealId is required"
      });
    }

    // Get the deal-to-QB customer mapping from our database
    const { getDealMapping } = require("../../config/postgres");
    const mapping = await getDealMapping(dealId);
    
    if (!mapping) {
      return res.json({
        success: true,
        customer: null
      });
    }

    const qbCustomerId = mapping.qbCustomerId;
    
    // Get customer details from QuickBooks
    try {
      const { qbClient, companyId } = await createQBClient(userId);
      const baseUrl = getQBBaseUrl();
      
      const customerResponse = await qbClient.makeApiCall({
        url: `${baseUrl}/v3/company/${companyId}/customer/${qbCustomerId}?minorversion=65`,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      const customer = getQBResponseData(customerResponse).Customer;
      
      res.json({
        success: true,
        customer: customer
      });
    } catch (qbError) {
      // If QB fetch fails, use the stored customer name from the mapping
      res.json({
        success: true,
        customer: {
          Id: qbCustomerId,
          DisplayName: mapping.customerName || "QuickBooks Customer #" + qbCustomerId
        }
      });
    }
  } catch (error) {
    console.error("Get deal contact error:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Delete deal-contact association (unlink)
router.delete("/api/deal-contact", async (req, res) => {
  try {
    const { dealId } = req.query;

    if (!dealId) {
      return res.status(400).json({
        success: false,
        error: "dealId is required"
      });
    }

    const { deleteDealMapping } = require("../../config/postgres");
    await deleteDealMapping(dealId);
    
    console.log(`[Unlink Contact] Successfully unlinked deal ${dealId}`);

    res.json({
      success: true,
      message: "Contact unlinked from deal"
    });
  } catch (error) {
    console.error("Unlink contact error:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Deauthorization endpoint - called by Pipedrive when app is uninstalled
router.post("/deauth", express.json(), async (req, res) => {
  try {
    console.log("Deauthorization request received");
    
    // Verify Pipedrive signature
    // The signature is HMAC-SHA256 of the request body with the client secret
    const signature = req.headers['x-pipedrive-signature'];
    const crypto = require('crypto');
    
    if (signature) {
      const expectedSignature = crypto
        .createHmac('sha256', process.env.PIPEDRIVE_CLIENT_SECRET)
        .update(JSON.stringify(req.body))
        .digest('hex');
      
      if (signature !== expectedSignature) {
        console.error('Invalid signature on deauth request');
        return res.status(401).send('Invalid signature');
      }
    }
    
    // Get userId from payload
    const userId = req.body.user_id || req.body.api_domain;
    
    if (!userId) {
      console.error('No user ID in deauth request');
      return res.status(400).send('User ID not found');
    }
    
    console.log('Processing deauthorization for user:', userId);
    
    // Get user data to retrieve field ID
    const userData = await getUser(userId);
    
    if (userData) {
      // Delete custom field if it exists
      if (userData.qb_field_id && userData.access_token) {
        try {
          const apiDomain = userData.api_domain || 'api.pipedrive.com';
          
          // Get the field ID from the field key
          const fieldsResponse = await axios.get(
            `https://${apiDomain}/v1/dealFields?api_token=${userData.access_token}`
          );
          
          const field = fieldsResponse.data.data?.find(
            f => f.key === userData.qb_field_id
          );
          
          if (field) {
            // Delete the custom field
            await axios.delete(
              `https://${apiDomain}/v1/dealFields/${field.id}?api_token=${userData.access_token}`
            );
            console.log('Deleted custom field:', field.id);
          }
        } catch (fieldError) {
          console.error('Error deleting custom field:', fieldError.response?.data || fieldError.message);
          // Continue with user deletion even if field deletion fails
        }
      }
      
      // Clear user from database
      await setUser(userId, null);
      console.log('Cleared user from database:', userId);
    }
    
    // Return 200 OK to acknowledge the deauthorization
    res.status(200).send('OK');
    
  } catch (error) {
    console.error('Deauthorization error:', error);
    // Still return 200 to acknowledge receipt
    res.status(200).send('OK');
  }
});

// Search QuickBooks items/products
router.get("/api/items/search", async (req, res) => {
  try {
    const searchTerm = req.query.term || '';
    const providedUserId = req.query.userId || 'test';
    
    console.log('Searching items:', searchTerm, 'User ID:', providedUserId);

    // Find user with QB tokens
    let userData = null;
    let actualUserId = providedUserId;
    
    userData = await getUser(providedUserId);
    
    if (!userData || !userData.qb_access_token || !userData.qb_realm_id) {
      const { listUsers } = require("../../config/postgres");
      const allKeys = await listUsers();
      
      for (const key of allKeys) {
        const testUserData = await getUser(key);
        if (testUserData && testUserData.qb_access_token && testUserData.qb_realm_id) {
          const normalizedProvidedId = providedUserId.replace('https://', '').replace(/\.pipedrive\.com$/, '');
          const normalizedKey = key.replace('https://', '').replace(/\.pipedrive\.com$/, '');
          
          if (normalizedKey === normalizedProvidedId ||
              testUserData.api_domain?.includes(normalizedProvidedId) ||
              normalizedProvidedId.includes(normalizedKey)) {
            userData = testUserData;
            actualUserId = key;
            break;
          }
          
          if (!userData && testUserData.qb_realm_id) {
            userData = testUserData;
            actualUserId = key;
          }
        }
      }
    }
    
    if (!userData || !userData.qb_access_token || !userData.qb_realm_id) {
      return res.status(400).json({
        success: false,
        error: "QuickBooks not connected for this user"
      });
    }

    const baseUrl = getQBBaseUrl();
    const realmId = userData.qb_realm_id;
    
    // Build query to search items by Name - get both products and services
    let query;
    if (searchTerm) {
      query = `SELECT * FROM Item WHERE Name LIKE '%${searchTerm}%' AND Active = true MAXRESULTS 20`;
    } else {
      query = `SELECT * FROM Item WHERE Active = true MAXRESULTS 20`;
    }
    const encodedQuery = encodeURIComponent(query);
    
    const queryResponse = await makeQBApiCall(actualUserId, userData, async (qbClient, currentUserData) => {
      return await qbClient.makeApiCall({
        url: `${baseUrl}/v3/company/${realmId}/query?query=${encodedQuery}`,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });
    });
    
    if (!queryResponse) {
      return res.status(500).json({
        success: false,
        error: "Invalid response from QuickBooks"
      });
    }
    
    const queryResult = getQBResponseData(queryResponse);
    const items = queryResult.QueryResponse?.Item || [];
    
    // Transform to simplified format
    const simplifiedItems = items.map(item => ({
      id: item.Id,
      name: item.Name,
      description: item.Description || '',
      unitPrice: item.UnitPrice || 0,
      type: item.Type, // 'Inventory', 'Service', 'NonInventory'
      incomeAccountRef: item.IncomeAccountRef,
      qtyOnHand: item.QtyOnHand || 0
    }));
    
    res.json(simplifiedItems);
  } catch (error) {
    console.error("Search items error:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get Pipedrive deal's contact address
router.get("/api/pipedrive/deal-address", async (req, res) => {
  try {
    const { dealId, userId } = req.query;
    
    if (!dealId) {
      return res.status(400).json({
        success: false,
        error: "dealId is required"
      });
    }
    
    // Find user with Pipedrive tokens
    let userData = null;
    let actualUserId = userId || 'test';
    
    userData = await getUser(actualUserId);
    
    if (!userData || !userData.access_token) {
      const { listUsers } = require("../../config/postgres");
      const allKeys = await listUsers();
      
      for (const key of allKeys) {
        const testUserData = await getUser(key);
        if (testUserData && testUserData.access_token && testUserData.api_domain) {
          userData = testUserData;
          actualUserId = key;
          break;
        }
      }
    }
    
    if (!userData || !userData.access_token) {
      return res.status(400).json({
        success: false,
        error: "Pipedrive not connected"
      });
    }
    
    const apiDomain = userData.api_domain || 'https://api.pipedrive.com';
    
    // Helper function to make Pipedrive API calls with token refresh
    async function makePipedriveApiCall(endpoint, retryCount = 0) {
      try {
        const response = await axios.get(`${apiDomain}${endpoint}`, {
          headers: {
            'Authorization': `Bearer ${userData.access_token}`
          }
        });
        return response;
      } catch (error) {
        if (error.response?.status === 401 && userData.refresh_token && retryCount === 0) {
          console.log('[Deal Address] Token expired, attempting refresh...');
          try {
            const pipedriveAuth = require('../auth/pipedrive');
            const newTokens = await pipedriveAuth.refreshToken(userData.refresh_token);
            
            // Update userData with new tokens
            userData.access_token = newTokens.access_token;
            userData.refresh_token = newTokens.refresh_token;
            
            // Persist updated tokens to database
            await setUser(actualUserId, {
              ...userData,
              access_token: newTokens.access_token,
              refresh_token: newTokens.refresh_token,
              pipedrive_updated_at: new Date().toISOString()
            });
            
            console.log('[Deal Address] Token refreshed successfully');
            
            // Retry with new token
            return await makePipedriveApiCall(endpoint, retryCount + 1);
          } catch (refreshError) {
            console.error('[Deal Address] Token refresh failed:', refreshError.message);
            throw new Error('Pipedrive authentication expired. Please reconnect.');
          }
        }
        throw error;
      }
    }
    
    // Helper to parse Pipedrive address object into our format
    function parseAddressObject(value) {
      if (!value) return null;
      if (typeof value === 'string') {
        return { line1: value };
      }
      if (typeof value === 'object') {
        // Handle array of addresses (take first one)
        if (Array.isArray(value)) {
          value = value[0];
          if (!value) return null;
        }
        // Pipedrive address format with street_number, route, locality, etc.
        if (value.formatted_address || value.street_number || value.route || value.locality) {
          return {
            line1: [value.street_number, value.route].filter(Boolean).join(' ') || value.formatted_address,
            city: value.locality || value.sublocality,
            state: value.admin_area_level_1,
            postalCode: value.postal_code,
            country: value.country
          };
        }
        // Generic address object format
        if (value.line1 || value.street || value.city) {
          return {
            line1: value.line1 || value.street || value.formatted_address,
            line2: value.line2,
            city: value.city || value.locality,
            state: value.state || value.admin_area_level_1,
            postalCode: value.postalCode || value.postal_code,
            country: value.country
          };
        }
      }
      return null;
    }
    
    // First get the deal to find associated person
    const dealResponse = await makePipedriveApiCall(`/v1/deals/${dealId}`);
    
    if (!dealResponse.data?.success || !dealResponse.data?.data) {
      return res.json({
        success: false,
        error: "Deal not found"
      });
    }
    
    const deal = dealResponse.data.data;
    const personId = deal.person_id?.value || deal.person_id;
    const orgId = deal.org_id?.value || deal.org_id;
    
    let address = null;
    
    // Try to get person's address first
    if (personId) {
      try {
        // Step 1: Get person fields metadata to find "Shipping Address" custom field key
        const personFieldsResponse = await makePipedriveApiCall('/v1/personFields');
        let shippingAddressKey = null;
        let addressFieldKeys = [];
        
        if (personFieldsResponse.data?.success && personFieldsResponse.data?.data) {
          for (const field of personFieldsResponse.data.data) {
            // Look for field named "Shipping Address" (case-insensitive)
            if (field.name && field.name.toLowerCase().includes('shipping') && field.name.toLowerCase().includes('address')) {
              shippingAddressKey = field.key;
              console.log(`[Deal Address] Found shipping address field: "${field.name}" with key: ${field.key}`);
              break;
            }
            // Also track all address-type fields as fallback
            if (field.field_type === 'address') {
              addressFieldKeys.push({ key: field.key, name: field.name });
            }
          }
        }
        
        // Step 2: Get the person data
        const personResponse = await makePipedriveApiCall(`/v1/persons/${personId}`);
        
        if (personResponse.data?.success && personResponse.data?.data) {
          const person = personResponse.data.data;
          
          // Priority 1: Check the shipping address custom field directly
          if (shippingAddressKey && person[shippingAddressKey]) {
            console.log(`[Deal Address] Found shipping address value:`, person[shippingAddressKey]);
            address = parseAddressObject(person[shippingAddressKey]);
          }
          
          // Priority 2: Check other address-type custom fields
          if (!address && addressFieldKeys.length > 0) {
            for (const fieldInfo of addressFieldKeys) {
              if (person[fieldInfo.key]) {
                console.log(`[Deal Address] Using address field "${fieldInfo.name}":`, person[fieldInfo.key]);
                address = parseAddressObject(person[fieldInfo.key]);
                if (address) break;
              }
            }
          }
          
          // Priority 3: Scan all fields for address-like objects (fallback)
          if (!address) {
            for (const key of Object.keys(person)) {
              const value = person[key];
              if (value && typeof value === 'object' && (value.street_number || value.route || value.locality || value.formatted_address)) {
                address = parseAddressObject(value);
                if (address) {
                  console.log(`[Deal Address] Found address in field "${key}"`);
                  break;
                }
              }
            }
          }
          
          // Priority 4: Check standard address field
          if (!address && person.address) {
            address = parseAddressObject(person.address);
          }
        }
      } catch (err) {
        console.log('Could not fetch person data:', err.message);
      }
    }
    
    // Fallback to organization address
    if (!address && orgId) {
      try {
        // Get organization fields metadata to find address custom fields
        const orgFieldsResponse = await makePipedriveApiCall('/v1/organizationFields');
        let orgAddressFieldKeys = [];
        
        if (orgFieldsResponse.data?.success && orgFieldsResponse.data?.data) {
          for (const field of orgFieldsResponse.data.data) {
            if (field.field_type === 'address') {
              orgAddressFieldKeys.push({ key: field.key, name: field.name });
            }
          }
        }
        
        const orgResponse = await makePipedriveApiCall(`/v1/organizations/${orgId}`);
        
        if (orgResponse.data?.success && orgResponse.data?.data) {
          const org = orgResponse.data.data;
          
          // Check address-type custom fields
          for (const fieldInfo of orgAddressFieldKeys) {
            if (org[fieldInfo.key]) {
              console.log(`[Deal Address] Using org address field "${fieldInfo.name}"`);
              address = parseAddressObject(org[fieldInfo.key]);
              if (address) break;
            }
          }
          
          // Check standard address field
          if (!address && org.address) {
            address = parseAddressObject(org.address);
          }
          
          // Check formatted address string
          if (!address && org.address_formatted_address) {
            address = { line1: org.address_formatted_address };
          }
        }
      } catch (err) {
        console.log('Could not fetch organization data:', err.message);
      }
    }
    
    // If we have an address but missing key fields (city, state, postal code), use Nominatim to enrich it
    if (address && address.line1 && (!address.postalCode || !address.city || !address.state)) {
      try {
        // Use the line1 as the search query (it likely contains the full formatted address)
        const searchQuery = address.line1;
        
        console.log(`[Deal Address] Enriching address via Nominatim: "${searchQuery}"`);
        
        const appUrl = process.env.APP_URL || 'https://pipedrive-qbo-sync.replit.app';
        const nominatimResponse = await axios.get('https://nominatim.openstreetmap.org/search', {
          params: {
            q: searchQuery,
            format: 'json',
            addressdetails: 1,
            limit: 1
          },
          headers: {
            'User-Agent': `PipedriveQuickBooksIntegration/1.0 (${appUrl})`,
            'Accept': 'application/json',
            'Referer': appUrl
          },
          timeout: 10000
        });
        
        if (nominatimResponse.data && nominatimResponse.data.length > 0) {
          const result = nominatimResponse.data[0];
          const addressDetails = result.address || {};
          
          console.log('[Deal Address] Nominatim response:', JSON.stringify(addressDetails));
          
          // Build the street address from house_number and road
          const streetAddress = [addressDetails.house_number, addressDetails.road].filter(Boolean).join(' ');
          
          // Update line1 to be just the street address if we got better data
          if (streetAddress) {
            address.line1 = streetAddress;
            console.log(`[Deal Address] Updated line1 to: ${streetAddress}`);
          }
          
          // Enrich missing fields from Nominatim
          if (!address.postalCode && addressDetails.postcode) {
            address.postalCode = addressDetails.postcode;
            console.log(`[Deal Address] Added postal code: ${addressDetails.postcode}`);
          }
          if (!address.city) {
            address.city = addressDetails.city || addressDetails.town || addressDetails.village || addressDetails.municipality;
            if (address.city) {
              console.log(`[Deal Address] Added city: ${address.city}`);
            }
          }
          if (!address.state && addressDetails.state) {
            address.state = addressDetails.state;
            console.log(`[Deal Address] Added state: ${addressDetails.state}`);
          }
          if (!address.country) {
            address.country = addressDetails.country;
            if (address.country) {
              console.log(`[Deal Address] Added country: ${address.country}`);
            }
          }
        } else {
          console.log('[Deal Address] No Nominatim results found');
        }
      } catch (geoError) {
        console.log('[Deal Address] Nominatim geocoding failed:', geoError.message);
      }
    }
    
    if (address) {
      res.json({
        success: true,
        address: address
      });
    } else {
      res.json({
        success: false,
        error: "No address found for this deal's contact or organization"
      });
    }
    
  } catch (error) {
    console.error("Get deal address error:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Create QuickBooks invoice
router.post("/api/invoices", express.json(), async (req, res) => {
  try {
    const { customerId, customerEmail, lineItems, dueDate, memo, paymentTerms, shippingAddress, discount, sendEmail } = req.body;
    const providedUserId = req.query.userId || req.body.userId || 'test';
    
    console.log('Creating invoice for customer:', customerId, 'Email:', customerEmail, 'User ID:', providedUserId);
    console.log('Discount:', discount ? `${discount.type} - ${discount.value}` : 'none');
    console.log('Send email after creation:', sendEmail ? 'yes' : 'no');

    if (!customerId) {
      return res.status(400).json({
        success: false,
        error: "Customer ID is required"
      });
    }

    if (!lineItems || !Array.isArray(lineItems) || lineItems.length === 0) {
      return res.status(400).json({
        success: false,
        error: "At least one line item is required"
      });
    }

    // Find user with QB tokens
    let userData = null;
    let actualUserId = providedUserId;
    
    userData = await getUser(providedUserId);
    
    if (!userData || !userData.qb_access_token || !userData.qb_realm_id) {
      const { listUsers } = require("../../config/postgres");
      const allKeys = await listUsers();
      
      for (const key of allKeys) {
        const testUserData = await getUser(key);
        if (testUserData && testUserData.qb_access_token && testUserData.qb_realm_id) {
          const normalizedProvidedId = providedUserId.replace('https://', '').replace(/\.pipedrive\.com$/, '');
          const normalizedKey = key.replace('https://', '').replace(/\.pipedrive\.com$/, '');
          
          if (normalizedKey === normalizedProvidedId ||
              testUserData.api_domain?.includes(normalizedProvidedId) ||
              normalizedProvidedId.includes(normalizedKey)) {
            userData = testUserData;
            actualUserId = key;
            break;
          }
          
          if (!userData && testUserData.qb_realm_id) {
            userData = testUserData;
            actualUserId = key;
          }
        }
      }
    }
    
    if (!userData || !userData.qb_access_token || !userData.qb_realm_id) {
      return res.status(400).json({
        success: false,
        error: "QuickBooks not connected for this user"
      });
    }

    const baseUrl = getQBBaseUrl();
    const realmId = userData.qb_realm_id;
    
    // Build invoice object
    const invoiceLines = lineItems.map((item, index) => {
      const line = {
        DetailType: "SalesItemLineDetail",
        Amount: (item.quantity || 1) * (item.unitPrice || 0),
        Description: item.description || item.name || '',
        SalesItemLineDetail: {
          Qty: item.quantity || 1,
          UnitPrice: item.unitPrice || 0
        }
      };
      
      // Add item reference if provided
      if (item.itemId) {
        line.SalesItemLineDetail.ItemRef = {
          value: item.itemId
        };
      }
      
      return line;
    });
    
    // Add discount line if provided
    if (discount && discount.value > 0) {
      // Calculate the subtotal first
      const subtotal = lineItems.reduce((sum, item) => 
        sum + ((item.quantity || 1) * (item.unitPrice || 0)), 0);
      
      if (subtotal > 0) {
        let discountAmount;
        let discountPercent;
        
        if (discount.type === 'percent') {
          // Percentage discount - use directly
          discountPercent = Math.min(discount.value, 100); // Cap at 100%
          discountAmount = subtotal * (discountPercent / 100);
        } else {
          // Fixed amount discount - convert to percentage to avoid needing DiscountAccountRef
          discountAmount = Math.min(discount.value, subtotal); // Cannot exceed subtotal
          discountPercent = (discountAmount / subtotal) * 100;
        }
        
        // QuickBooks uses percentage-based discounts to avoid needing account references
        invoiceLines.push({
          DetailType: "DiscountLineDetail",
          Amount: discountAmount,
          DiscountLineDetail: {
            PercentBased: true,
            DiscountPercent: discountPercent
          }
        });
        
        console.log(`Applied discount: ${discount.type} = ${discount.value}, computed as ${discountPercent.toFixed(2)}%, amount = $${discountAmount.toFixed(2)}`);
      }
    }
    
    const invoiceData = {
      CustomerRef: {
        value: customerId
      },
      Line: invoiceLines
    };
    
    // Add due date if provided
    if (dueDate) {
      invoiceData.DueDate = dueDate;
    }
    
    // Add memo/private note if provided
    if (memo) {
      invoiceData.PrivateNote = memo;
    }
    
    // Add payment terms as a custom field or in private note
    // QuickBooks uses SalesTermRef for payment terms, but custom values need to be predefined
    // For now, we'll append the payment terms to the CustomerMemo (visible on invoice)
    if (paymentTerms) {
      invoiceData.CustomerMemo = {
        value: `Payment Terms: ${paymentTerms}`
      };
    }
    
    // Add shipping address if provided
    if (shippingAddress && (shippingAddress.Line1 || shippingAddress.City)) {
      invoiceData.ShipAddr = {};
      if (shippingAddress.Line1) invoiceData.ShipAddr.Line1 = shippingAddress.Line1;
      if (shippingAddress.Line2) invoiceData.ShipAddr.Line2 = shippingAddress.Line2;
      if (shippingAddress.City) invoiceData.ShipAddr.City = shippingAddress.City;
      if (shippingAddress.CountrySubDivisionCode) {
        // Convert full state names to 2-letter codes for QuickBooks production API
        invoiceData.ShipAddr.CountrySubDivisionCode = normalizeStateCode(shippingAddress.CountrySubDivisionCode);
      }
      if (shippingAddress.PostalCode) invoiceData.ShipAddr.PostalCode = shippingAddress.PostalCode;
      if (shippingAddress.Country) invoiceData.ShipAddr.Country = shippingAddress.Country;
    }
    
    // Add customer email for invoice delivery
    if (customerEmail) {
      invoiceData.BillEmail = {
        Address: customerEmail
      };
    }
    
    console.log('Creating invoice with data:', JSON.stringify(invoiceData, null, 2));
    
    const createResponse = await makeQBApiCall(actualUserId, userData, async (qbClient, currentUserData) => {
      return await qbClient.makeApiCall({
        url: `${baseUrl}/v3/company/${realmId}/invoice`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(invoiceData)
      });
    });
    
    if (!createResponse) {
      return res.status(500).json({
        success: false,
        error: "Invalid response from QuickBooks"
      });
    }
    
    const result = getQBResponseData(createResponse);
    
    if (result.Invoice) {
      console.log('Invoice created successfully:', result.Invoice.Id);
      
      let emailSent = false;
      
      // Send invoice email if requested
      if (sendEmail && customerEmail) {
        try {
          console.log('Sending invoice email to:', customerEmail);
          
          const sendEmailResponse = await makeQBApiCall(actualUserId, userData, async (qbClient, currentUserData) => {
            return await qbClient.makeApiCall({
              url: `${baseUrl}/v3/company/${realmId}/invoice/${result.Invoice.Id}/send?sendTo=${encodeURIComponent(customerEmail)}`,
              method: 'POST',
              headers: {
                'Content-Type': 'application/octet-stream',
                'Accept': 'application/json'
              }
            });
          });
          
          if (sendEmailResponse) {
            const sendResult = getQBResponseData(sendEmailResponse);
            if (sendResult.Invoice) {
              console.log('Invoice email sent successfully');
              emailSent = true;
            } else {
              console.warn('Email send may have failed:', sendResult);
            }
          }
        } catch (emailError) {
          console.error('Error sending invoice email:', emailError);
          // Don't fail the whole request just because email failed
        }
      }
      
      // ShipStation integration - create order based on payment terms
      let shipstationOrderCreated = false;
      let shipstationOrderPending = false;
      
      if (userData.shipstation_api_key && userData.shipstation_auto_create !== false) {
        try {
          const invoiceBalance = parseFloat(result.Invoice.Balance || 0);
          const isDueOnReceipt = paymentTerms === 'DueOnReceipt' || 
                                  paymentTerms === 'Due on Receipt' ||
                                  (result.Invoice.SalesTermRef?.name || '').toLowerCase().includes('receipt');
          
          console.log(`[ShipStation] Invoice ${result.Invoice.DocNumber} - Payment terms: ${paymentTerms}, Balance: ${invoiceBalance}, Due on Receipt: ${isDueOnReceipt}`);
          
          if (isDueOnReceipt && invoiceBalance > 0) {
            // Due on Receipt with unpaid balance - add to pending_invoices table for payment poller
            console.log(`[ShipStation] Invoice ${result.Invoice.DocNumber} - Due on Receipt, pending payment. Adding to pending invoices.`);
            
            // addPendingInvoice(invoiceId, invoiceNumber, userId, invoiceData)
            await addPendingInvoice(
              result.Invoice.Id,
              result.Invoice.DocNumber,
              actualUserId,
              result.Invoice  // Store full invoice data for ShipStation order creation
            );
            
            shipstationOrderPending = true;
            console.log(`[ShipStation] Added invoice ${result.Invoice.DocNumber} to pending invoices for payment polling`);
          } else {
            // Net 30/60 or paid invoice - create ShipStation order immediately
            console.log(`[ShipStation] Creating order for invoice ${result.Invoice.DocNumber}`);
            
            const ssOrder = await createShipStationOrderFromInvoice(userData, result.Invoice, actualUserId);
            
            if (ssOrder && ssOrder.orderId) {
              shipstationOrderCreated = true;
              console.log(`[ShipStation] Order ${ssOrder.orderId} created for invoice ${result.Invoice.DocNumber}`);
            }
          }
        } catch (ssError) {
          console.error('[ShipStation] Error processing invoice:', ssError.message);
          // Don't fail the invoice creation just because ShipStation failed
        }
      }
      
      res.json({
        success: true,
        emailSent: emailSent,
        shipstationOrderCreated: shipstationOrderCreated,
        shipstationOrderPending: shipstationOrderPending,
        invoice: {
          id: result.Invoice.Id,
          docNumber: result.Invoice.DocNumber,
          totalAmount: result.Invoice.TotalAmt,
          dueDate: result.Invoice.DueDate,
          balance: result.Invoice.Balance
        }
      });
    } else {
      console.error('Invoice creation failed:', result);
      res.status(500).json({
        success: false,
        error: result.Fault?.Error?.[0]?.Message || "Failed to create invoice"
      });
    }
  } catch (error) {
    console.error("Create invoice error:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Download invoice as PDF
router.get("/api/invoices/:invoiceId/pdf", async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const providedUserId = req.query.userId || 'test';
    
    console.log('Downloading PDF for invoice:', invoiceId, 'User ID:', providedUserId);

    // Find user with QB tokens
    let userData = null;
    let actualUserId = providedUserId;
    
    userData = await getUser(providedUserId);
    
    if (!userData || !userData.qb_access_token || !userData.qb_realm_id) {
      const { listUsers } = require("../../config/postgres");
      const allKeys = await listUsers();
      
      for (const key of allKeys) {
        const testUserData = await getUser(key);
        if (testUserData && testUserData.qb_access_token && testUserData.qb_realm_id) {
          const normalizedProvidedId = providedUserId.replace('https://', '').replace(/\.pipedrive\.com$/, '');
          const normalizedKey = key.replace('https://', '').replace(/\.pipedrive\.com$/, '');
          
          if (normalizedKey === normalizedProvidedId ||
              testUserData.api_domain?.includes(normalizedProvidedId) ||
              normalizedProvidedId.includes(normalizedKey)) {
            userData = testUserData;
            actualUserId = key;
            break;
          }
          
          if (!userData && testUserData.qb_realm_id) {
            userData = testUserData;
            actualUserId = key;
          }
        }
      }
    }
    
    if (!userData || !userData.qb_access_token || !userData.qb_realm_id) {
      return res.status(400).json({
        success: false,
        error: "QuickBooks not connected for this user"
      });
    }

    const baseUrl = getQBBaseUrl();
    const realmId = userData.qb_realm_id;
    
    // Fetch PDF from QuickBooks using axios for proper binary handling
    // The intuit-oauth makeApiCall doesn't handle binary responses correctly
    const pdfBuffer = await makeQBApiCall(actualUserId, userData, async (qbClient, currentUserData) => {
      const axios = require('axios');
      const pdfUrl = `${baseUrl}/v3/company/${realmId}/invoice/${invoiceId}/pdf`;
      
      const response = await axios({
        method: 'GET',
        url: pdfUrl,
        headers: {
          'Authorization': `Bearer ${currentUserData.qb_access_token}`,
          'Accept': 'application/pdf'
        },
        responseType: 'arraybuffer'
      });
      
      return response.data;
    });
    
    if (!pdfBuffer) {
      return res.status(500).json({
        success: false,
        error: "Failed to fetch PDF from QuickBooks"
      });
    }
    
    // Set headers for PDF download
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoiceId}.pdf"`);
    
    // Send the PDF buffer directly
    res.send(Buffer.from(pdfBuffer));
    
  } catch (error) {
    console.error("Download PDF error:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get payment link for an invoice
router.get("/api/invoices/:invoiceId/paylink", async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const providedUserId = req.query.userId || 'test';
    
    console.log('Getting payment link for invoice:', invoiceId, 'User ID:', providedUserId);

    // Find user with QB tokens
    let userData = null;
    let actualUserId = providedUserId;
    
    userData = await getUser(providedUserId);
    
    if (!userData || !userData.qb_access_token || !userData.qb_realm_id) {
      const { listUsers } = require("../../config/postgres");
      const allKeys = await listUsers();
      
      for (const key of allKeys) {
        const testUserData = await getUser(key);
        if (testUserData && testUserData.qb_access_token && testUserData.qb_realm_id) {
          const normalizedProvidedId = providedUserId.replace('https://', '').replace(/\.pipedrive\.com$/, '');
          const normalizedKey = key.replace('https://', '').replace(/\.pipedrive\.com$/, '');
          
          if (normalizedKey === normalizedProvidedId ||
              testUserData.api_domain?.includes(normalizedProvidedId) ||
              normalizedProvidedId.includes(normalizedKey)) {
            userData = testUserData;
            actualUserId = key;
            break;
          }
          
          if (!userData && testUserData.qb_realm_id) {
            userData = testUserData;
            actualUserId = key;
          }
        }
      }
    }
    
    if (!userData || !userData.qb_access_token || !userData.qb_realm_id) {
      return res.status(400).json({
        success: false,
        error: "QuickBooks not connected for this user"
      });
    }

    const baseUrl = getQBBaseUrl();
    const realmId = userData.qb_realm_id;
    
    // Fetch invoice with invoiceLink parameter
    const invoiceData = await makeQBApiCall(actualUserId, userData, async (qbClient, currentUserData) => {
      const axios = require('axios');
      const invoiceUrl = `${baseUrl}/v3/company/${realmId}/invoice/${invoiceId}?include=invoiceLink&minorversion=65`;
      
      const response = await axios({
        method: 'GET',
        url: invoiceUrl,
        headers: {
          'Authorization': `Bearer ${currentUserData.qb_access_token}`,
          'Accept': 'application/json'
        }
      });
      
      return response.data;
    });
    
    if (!invoiceData || !invoiceData.Invoice) {
      return res.status(500).json({
        success: false,
        error: "Failed to fetch invoice from QuickBooks"
      });
    }
    
    const paymentLink = invoiceData.Invoice.InvoiceLink || invoiceData.Invoice.invoiceLink;
    
    if (!paymentLink) {
      return res.status(404).json({
        success: false,
        error: "No payment link available. QuickBooks Payments may not be enabled for this account."
      });
    }
    
    res.json({
      success: true,
      paymentLink: paymentLink,
      invoiceNumber: invoiceData.Invoice.DocNumber
    });
    
  } catch (error) {
    console.error("Get payment link error:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== SHIPSTATION ENDPOINTS ====================

// Helper function to make ShipStation API calls
async function makeShipStationApiCall(userData, method, endpoint, data = null) {
  if (!userData.shipstation_api_key || !userData.shipstation_api_secret) {
    throw new Error('ShipStation not connected');
  }
  
  // Decrypt credentials
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

// Get shipments for invoices (by order number = invoice DocNumber)
// Orders are stored in ShipStation with format QB-{tenant}-{invoiceNumber}
router.get("/api/shipstation/shipments", async (req, res) => {
  try {
    const { userId, orderNumbers } = req.query;
    console.log(`[ShipStation] Fetching shipments for user: ${userId}, invoices: ${orderNumbers || 'none'}`);
    
    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }
    
    // ShipStation credentials are global - just find any record with credentials
    const { getShipStationCredentials } = require("../../config/postgres");
    const userData = await getShipStationCredentials();
    
    if (!userData) {
      console.log(`[ShipStation] Shipments - No credentials found`);
      return res.json({
        success: true,
        shipments: [],
        connected: false,
        message: 'ShipStation not connected'
      });
    }
    
    // Parse invoice DocNumbers from frontend
    const invoiceDocNumbers = orderNumbers ? orderNumbers.split(',').map(n => n.trim()) : [];
    
    if (invoiceDocNumbers.length === 0) {
      return res.json({
        success: true,
        shipments: [],
        connected: true
      });
    }
    
    // Get the tenant prefix for this user (last 4 digits of pipedrive_user_id)
    // Validate that we have a numeric user ID for tenant suffix
    const pipedriveUserId = userData.pipedrive_user_id;
    let tenantSuffix = null;
    
    if (pipedriveUserId && /^\d+$/.test(String(pipedriveUserId))) {
      tenantSuffix = String(pipedriveUserId).slice(-4);
    }
    
    console.log(`[ShipStation] Using tenant suffix: ${tenantSuffix} (from pipedrive_user_id: ${pipedriveUserId})`);
    
    // Import getInvoiceMappingByNumber for fallback lookups
    const { getInvoiceMappingByNumber } = require("../../config/postgres");
    
    // Fetch shipments for each invoice DocNumber
    // Map results back to DocNumber keys for frontend compatibility
    const shipmentMap = {};
    
    for (const docNumber of invoiceDocNumbers) {
      try {
        let ssOrderNumber = null;
        let ordersData = null;
        
        // Strategy 1: Build order number from tenant suffix if available
        if (tenantSuffix) {
          ssOrderNumber = `QB-${tenantSuffix}-${docNumber}`;
          console.log(`[ShipStation] Looking up order: ${ssOrderNumber} for invoice ${docNumber}`);
          ordersData = await makeShipStationApiCall(userData, 'GET', `/orders?orderNumber=${encodeURIComponent(ssOrderNumber)}`);
        }
        
        // Strategy 2: Fallback to invoice_mappings table if direct lookup failed
        if (!ordersData || !ordersData.orders || ordersData.orders.length === 0) {
          const mapping = await getInvoiceMappingByNumber(docNumber);
          if (mapping && mapping.shipstationOrderNumber) {
            ssOrderNumber = mapping.shipstationOrderNumber;
            console.log(`[ShipStation] Fallback: Using stored order number ${ssOrderNumber} from invoice_mappings`);
            ordersData = await makeShipStationApiCall(userData, 'GET', `/orders?orderNumber=${encodeURIComponent(ssOrderNumber)}`);
          }
        }
        
        if (ordersData && ordersData.orders && ordersData.orders.length > 0) {
          for (const order of ordersData.orders) {
            // Get shipments for this order
            const shipmentsData = await makeShipStationApiCall(userData, 'GET', `/shipments?orderId=${order.orderId}`);
            
            if (shipmentsData.shipments && shipmentsData.shipments.length > 0) {
              // Map shipments to our format - use docNumber as key for frontend
              const formattedShipments = shipmentsData.shipments.map(ship => ({
                shipmentId: ship.shipmentId,
                orderNumber: ssOrderNumber,
                orderId: order.orderId,
                trackingNumber: ship.trackingNumber,
                carrierCode: ship.carrierCode,
                serviceCode: ship.serviceCode,
                shipDate: ship.shipDate,
                deliveryDate: ship.deliveryDate,
                shipmentStatus: getShipmentStatusLabel(ship),
                voided: ship.voided,
                shipTo: ship.shipTo,
                items: order.items || []
              }));
              
              // Key by DocNumber for frontend compatibility
              shipmentMap[docNumber] = formattedShipments;
            } else {
              // No shipments yet, but order exists
              shipmentMap[docNumber] = [{
                orderId: order.orderId,
                orderNumber: ssOrderNumber,
                orderStatus: order.orderStatus,
                shipmentStatus: order.orderStatus === 'shipped' ? 'Shipped' : 'Awaiting Shipment',
                items: order.items || [],
                createDate: order.createDate
              }];
            }
          }
        }
      } catch (orderError) {
        console.error(`[ShipStation] Error fetching order for invoice ${docNumber}:`, orderError.message);
        // Continue with other orders
      }
    }
    
    const shipmentCount = Object.values(shipmentMap).reduce((sum, arr) => sum + arr.length, 0);
    console.log(`[ShipStation] Found ${shipmentCount} order(s)/shipment(s) for ${Object.keys(shipmentMap).length} invoice(s)`);
    
    res.json({
      success: true,
      shipments: shipmentMap,
      connected: true
    });
    
  } catch (error) {
    console.error("[ShipStation] Shipments lookup error:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

function getShipmentStatusLabel(shipment) {
  if (shipment.voided) return 'Voided';
  if (shipment.deliveryDate) return 'Delivered';
  if (shipment.trackingNumber) return 'In Transit';
  return 'Label Created';
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
  // Extract last 4 digits of user ID as tenant suffix
  const userIdStr = String(userId);
  const tenantSuffix = userIdStr.slice(-4);
  return `QB-${tenantSuffix}-${invoiceNumber}`;
}

// Helper function to create ShipStation order from QuickBooks invoice
async function createShipStationOrderFromInvoice(userData, invoice, userId) {
  const { getInvoiceMapping, setInvoiceMapping, getShipStationCredentials } = require("../../config/postgres");
  
  // ShipStation credentials are global - fetch from any user that has them
  const ssCredentials = await getShipStationCredentials();
  
  if (!ssCredentials || !ssCredentials.shipstation_api_key || !ssCredentials.shipstation_api_secret) {
    throw new Error('ShipStation not connected');
  }
  
  // Use the global ShipStation credentials for API calls
  const ssUserData = ssCredentials;
  
  const invoiceId = invoice.Id;
  const invoiceNumber = invoice.DocNumber || invoice.Id;
  
  // Step 1: Check if we already have a mapping for this invoice
  try {
    const existingMapping = await getInvoiceMapping(invoiceId);
    if (existingMapping && existingMapping.shipstationOrderId) {
      console.log(`[ShipStation] Invoice ${invoiceNumber} already mapped to order ${existingMapping.shipstationOrderNumber} (ID: ${existingMapping.shipstationOrderId})`);
      return {
        orderId: existingMapping.shipstationOrderId,
        orderNumber: existingMapping.shipstationOrderNumber,
        alreadyExists: true,
        fromMapping: true
      };
    }
  } catch (mappingError) {
    console.warn(`[ShipStation] Could not check invoice mapping:`, mappingError.message);
  }
  
  // Step 2: Generate unique order number with tenant prefix
  const orderNumber = buildShipStationOrderNumber(userId, invoiceNumber);
  console.log(`[ShipStation] Generated order number: ${orderNumber} for invoice ${invoiceNumber}`);
  
  // Step 3: Check if order already exists in ShipStation with this number
  try {
    const existingOrders = await makeShipStationApiCall(ssUserData, 'GET', `/orders?orderNumber=${encodeURIComponent(orderNumber)}`);
    if (existingOrders.orders && existingOrders.orders.length > 0) {
      const existingOrder = existingOrders.orders[0];
      console.log(`[ShipStation] Order ${orderNumber} already exists (ID: ${existingOrder.orderId}), saving mapping`);
      
      // Save the mapping for future lookups
      await setInvoiceMapping(invoiceId, invoiceNumber, existingOrder.orderId, existingOrder.orderNumber, 'existing');
      
      return {
        orderId: existingOrder.orderId,
        orderNumber: existingOrder.orderNumber,
        alreadyExists: true
      };
    }
  } catch (dupeCheckError) {
    console.warn(`[ShipStation] Could not check for existing order ${orderNumber}:`, dupeCheckError.message);
  }
  
  // Step 4: Build ship-to address from invoice
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
  
  // Step 5: Map invoice line items to ShipStation items
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
    amountPaid: parseFloat(invoice.TotalAmt) - parseFloat(invoice.Balance || 0),
    customerEmail: invoice.BillEmail?.Address || '',
    internalNotes: `QuickBooks Invoice #${invoiceNumber}`,
    advancedOptions: {
      customField1: `QB_Invoice_${invoiceId}`,
      customField2: invoice.CustomerRef?.value || ''
    }
  };
  
  console.log(`[ShipStation] Creating order - Number: ${shipstationOrder.orderNumber}, Customer: ${shipTo.name}, Items: ${items.length}, Amount: $${shipstationOrder.amountPaid.toFixed(2)}`);
  
  // Create order in ShipStation
  const createdOrder = await makeShipStationApiCall(ssUserData, 'POST', '/orders/createorder', shipstationOrder);
  
  console.log(`[ShipStation] Order created successfully - ID: ${createdOrder.orderId}, Number: ${createdOrder.orderNumber}`);
  
  // Step 7: Save the mapping for future lookups
  try {
    await setInvoiceMapping(invoiceId, invoiceNumber, createdOrder.orderId, createdOrder.orderNumber, 'created');
    console.log(`[ShipStation] Saved invoice mapping: ${invoiceNumber} -> ${createdOrder.orderNumber}`);
  } catch (mappingSaveError) {
    console.error(`[ShipStation] Failed to save invoice mapping:`, mappingSaveError.message);
  }
  
  return createdOrder;
}

// Create ShipStation order from QuickBooks invoice
router.post("/api/shipstation/orders", express.json(), async (req, res) => {
  try {
    const { userId, invoice } = req.body;
    console.log(`[ShipStation] Order creation request for user: ${userId}, invoice: ${invoice?.DocNumber || invoice?.Id}`);
    
    if (!userId || !invoice) {
      console.log('[ShipStation] Order creation failed: missing userId or invoice data');
      return res.status(400).json({ error: "User ID and invoice data are required" });
    }
    
    // Find user with ShipStation credentials
    let userData = await getUser(userId);
    let actualUserId = userId;
    
    if (!userData || !userData.shipstation_api_key) {
      const { listUsers } = require("../../config/postgres");
      const allKeys = await listUsers();
      
      for (const key of allKeys) {
        const testUserData = await getUser(key);
        if (testUserData && testUserData.shipstation_api_key) {
          const normalizedProvidedId = userId.replace('https://', '').replace(/\.pipedrive\.com$/, '');
          const normalizedKey = key.replace('https://', '').replace(/\.pipedrive\.com$/, '');
          
          if (normalizedKey === normalizedProvidedId ||
              testUserData.api_domain?.includes(normalizedProvidedId) ||
              normalizedProvidedId.includes(normalizedKey)) {
            userData = testUserData;
            actualUserId = key;
            break;
          }
        }
      }
    }
    
    if (!userData || !userData.shipstation_api_key) {
      return res.status(400).json({
        success: false,
        error: "ShipStation not connected"
      });
    }
    
    // Use the helper function which handles unique order numbers and mappings
    const createdOrder = await createShipStationOrderFromInvoice(userData, invoice, actualUserId);
    
    console.log(`[ShipStation] Order created: ${createdOrder.orderId} for invoice ${invoice.DocNumber}`);
    
    res.json({
      success: true,
      orderId: createdOrder.orderId,
      orderNumber: createdOrder.orderNumber,
      alreadyExists: createdOrder.alreadyExists || false,
      message: createdOrder.alreadyExists ? 'ShipStation order already exists' : 'ShipStation order created successfully'
    });
    
  } catch (error) {
    console.error("[ShipStation] Order creation error:", error);
    
    // Handle duplicate order error
    if (error.response?.status === 400 && error.response?.data?.Message?.includes('already exists')) {
      return res.status(400).json({
        success: false,
        error: 'A ShipStation order already exists for this invoice'
      });
    }
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get ShipStation connection status
router.get("/api/shipstation/status", async (req, res) => {
  try {
    // ShipStation credentials are global - just find any record with credentials
    const { getShipStationCredentials } = require("../../config/postgres");
    const ssCredentials = await getShipStationCredentials();
    
    if (!ssCredentials) {
      console.log(`[ShipStation] Status: Not connected (no credentials found)`);
      return res.json({
        connected: false,
        autoCreateEnabled: false
      });
    }
    
    console.log(`[ShipStation] Status: Connected, autoCreate: ${ssCredentials.shipstation_auto_create !== false}`);
    res.json({
      connected: true,
      autoCreateEnabled: ssCredentials.shipstation_auto_create !== false,
      connectedAt: ssCredentials.shipstation_connected_at
    });
    
  } catch (error) {
    console.error("[ShipStation] Status check error:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
