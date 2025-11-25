const express = require("express");
const router = express.Router();
const { getUser, setUser } = require("../../config/database");
const { getAuthUrl, getToken } = require("../auth/pipedrive");
const qbAuth = require("../auth/quickbooks");
const { syncContact } = require("../controllers/sync");
const OAuthClient = require("intuit-oauth");
const axios = require("axios");

// Helper function to make QuickBooks API call with automatic token refresh
async function makeQBApiCall(userId, userData, apiCallFunction) {
  // Create initial client with current tokens
  const createClient = (tokenData) => {
    const qbClient = new OAuthClient({
      clientId: process.env.QB_CLIENT_ID,
      clientSecret: process.env.QB_CLIENT_SECRET,
      environment: 'sandbox',
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
  
  try {
    console.log(`[makeQBApiCall] Starting API call for user ${userId}`);
    console.log(`[makeQBApiCall] Has access token: ${!!userData.qb_access_token}, Has realm: ${!!userData.qb_realm_id}`);
    
    // First attempt with existing token
    const qbClient = createClient(userData);
    const response = await apiCallFunction(qbClient, userData);
    
    console.log(`[makeQBApiCall] API call successful, response type: ${typeof response}`);
    if (response) {
      console.log(`[makeQBApiCall] Response has body: ${!!response.body}, has json: ${!!response.json}`);
    }
    
    return response;
  } catch (error) {
    console.error(`[makeQBApiCall] API call error for user ${userId}:`, error.message);
    console.error(`[makeQBApiCall] Error details:`, {
      name: error.name,
      statusCode: error.response?.statusCode || error.response?.status,
      errorBody: error.response?.body || error.response?.data,
      authHeader: error.authHeader,
      intuit_tid: error.intuit_tid
    });
    
    // Check if error is due to unauthorized (expired token)
    const statusCode = error.response?.statusCode || error.response?.status || error.statusCode;
    if (statusCode === 401) {
      console.log(`[makeQBApiCall] QB token expired for user ${userId}, attempting refresh...`);
      
      try {
        // Refresh the token
        const newTokens = await qbAuth.refreshToken(userData.qb_refresh_token);
        
        // Update user data with new tokens
        const updatedUserData = {
          ...userData,
          qb_access_token: newTokens.access_token,
          qb_refresh_token: newTokens.refresh_token,
          qb_expires_in: newTokens.expires_in,
          qb_expires_at: new Date(Date.now() + (newTokens.expires_in * 1000)).toISOString()
        };
        
        // Save updated tokens to database with the correct user ID
        await setUser(userId, updatedUserData);
        
        console.log(`[makeQBApiCall] QB token refreshed successfully for user ${userId}`);
        
        // Create new client with refreshed token and retry
        const refreshedClient = createClient(updatedUserData);
        return await apiCallFunction(refreshedClient, updatedUserData);
      } catch (refreshError) {
        console.error(`[makeQBApiCall] Failed to refresh QB token for user ${userId}:`, refreshError.message);
        throw new Error('QuickBooks authentication failed. Please reconnect.');
      }
    }
    
    // Re-throw if not an auth error
    throw error;
  }
}

router.get("/", (req, res) => {
  res.send("Hello!");
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
      const { listUsers } = require("../../config/database");
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
    
    const baseUrl = 'https://sandbox-quickbooks.api.intuit.com';
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
    const { listUsers } = require("../../config/database");
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
      const { listUsers } = require("../../config/database");
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
    const { token, userId, authorizeAllUsers, preferences } = req.body;
    
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
    
    // Save preferences and clear the setup token
    await setUser(normalizedUserId, {
      ...userData,
      invoice_preferences: {
        authorizeAllUsers,
        ...preferences,
        setup_completed_at: new Date().toISOString()
      },
      setup_token: null,
      setup_token_expires: null
    });
    
    console.log(`[Setup] Preferences saved for user: ${normalizedUserId}`);
    res.json({ success: true, message: "Preferences saved successfully" });
    
  } catch (error) {
    console.error("Setup preferences error:", error);
    res.status(500).json({ error: error.message });
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

  // Pass both userId and extension flag to getAuthUrl
  const authUrl = qbAuth.getAuthUrl(userId, isExtension);

  res.redirect(authUrl);
});

router.get("/auth/qb/callback", async (req, res) => {
  const code = req.query.code;
  const stateParam = req.query.state;

  // Decode state parameter to get userId and extension flag
  let userId;
  let isExtension = false;

  try {
    const decodedState = Buffer.from(stateParam, "base64").toString("utf-8");
    const stateData = JSON.parse(decodedState);
    userId = stateData.userId;
    isExtension = stateData.extension || false;
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

    const existingUser = (await getUser(userId)) || {};

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

    await setUser(userId, updatedUser);
    console.log(`[QB OAuth] Successfully stored QB tokens for userId: ${userId}`);

    // Check if this user has already completed setup
    const hasCompleteSetup = !!(updatedUser.invoice_preferences?.setup_completed_at);

    // Generate a secure token for the setup session
    const crypto = require('crypto');
    const setupToken = crypto.randomBytes(32).toString('hex');
    
    // Store the setup token temporarily with the user data
    await setUser(userId, {
      ...updatedUser,
      setup_token: setupToken,
      setup_token_expires: new Date(Date.now() + 30 * 60 * 1000).toISOString() // 30 minutes
    });

    // If in extension/iframe AND setup not complete, redirect to setup flow with secure token
    if (isExtension && !hasCompleteSetup) {
      // Redirect to the setup page with secure token instead of userId
      return res.redirect(`/setup.html?token=${encodeURIComponent(setupToken)}&userId=${encodeURIComponent(userId)}`);
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
  res.send(
    "<h1>Authentication Successful!</h1><p>Your Pipedrive and QuickBooks accounts have been connected.</p>",
  );
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
    
    let pipedriveUserId = req.query.userId;
    const normalizedInput = normalizeUserId(pipedriveUserId);
    
    console.log(`[API User Status] Checking status for userId: ${pipedriveUserId} (normalized: ${normalizedInput})`);

    if (!pipedriveUserId) {
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

    // Try multiple userId formats
    const possibleUserIds = [
      pipedriveUserId,                                    // Original input
      normalizedInput,                                     // Normalized (no https, no .pipedrive.com)
      normalizedInput + '.pipedrive.com',                  // Add suffix back
      'https://' + normalizedInput + '.pipedrive.com',     // Full URL
      'https://' + pipedriveUserId                         // With https prefix
    ];
    
    // Remove duplicates
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
      const { listUsers } = require("../../config/database");
      const allKeys = await listUsers();
      
      console.log(`[API User Status] Scanning ${allKeys.length} stored users for QB connection...`);
      
      for (const key of allKeys) {
        const testUserData = await getUser(key);
        if (testUserData && testUserData.qb_access_token && testUserData.qb_realm_id) {
          // Normalize both IDs for comparison
          const normalizedKey = normalizeUserId(key);
          
          // Check various matching conditions
          const isMatch = 
            normalizedKey === normalizedInput ||
            key === pipedriveUserId ||
            testUserData.api_domain?.includes(normalizedInput) ||
            normalizedInput.includes(normalizedKey) ||
            normalizedKey.includes(normalizedInput) ||
            // Check if stored numeric user ID matches
            (testUserData.pipedrive_user_id && testUserData.pipedrive_user_id.toString() === normalizedInput);
          
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
    
    // If connected, check for token expiration and attempt refresh
    if (isConnected && userData.qb_expires_at) {
      const expiresAt = new Date(userData.qb_expires_at);
      const now = new Date();
      if (expiresAt < now && userData.qb_refresh_token) {
        console.log(`[API User Status] QB tokens expired for user ${pipedriveUserId}, attempting refresh...`);
        
        // Try to refresh the token
        try {
          const newTokens = await qbAuth.refreshToken(userData.qb_refresh_token);
          
          // Update user data with new tokens
          userData = {
            ...userData,
            qb_access_token: newTokens.access_token,
            qb_refresh_token: newTokens.refresh_token,
            qb_expires_in: newTokens.expires_in,
            qb_expires_at: new Date(Date.now() + (newTokens.expires_in * 1000)).toISOString()
          };
          
          // Save updated tokens to database with the correct user ID
          await setUser(foundUserId, userData);
          
          console.log(`[API User Status] QB token refreshed successfully for user ${pipedriveUserId}`);
          isConnected = true;
        } catch (refreshError) {
          console.error(`[API User Status] Failed to refresh QB token for user ${pipedriveUserId}:`, refreshError);
          
          // Check if the error is due to invalid refresh token
          if (refreshError.message && refreshError.message.includes('Refresh token is invalid')) {
            // Mark as disconnected and clean up tokens
            isConnected = false;
            userData.tokenExpired = true; // Flag to indicate need for reconnection
          } else {
            isConnected = false;
          }
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
          environment: "sandbox",
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
          url: `https://sandbox-quickbooks.api.intuit.com/v3/company/${userData.qb_realm_id}/companyinfo/${userData.qb_realm_id}`,
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
    environment: 'sandbox',
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
      const { listUsers } = require("../../config/database");
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
    
    const baseUrl = 'https://sandbox-quickbooks.api.intuit.com';
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
    
    const customer = JSON.parse(customerResponse.body).Customer;
    
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
      const { listUsers } = require("../../config/database");
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
    
    const baseUrl = 'https://sandbox-quickbooks.api.intuit.com';
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
    
    const responseData = JSON.parse(invoiceResponse.body);
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
    console.error('Error fetching invoices:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch invoices',
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
      const { listUsers } = require("../../config/database");
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
    
    const baseUrl = 'https://sandbox-quickbooks.api.intuit.com';
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
    
    // Try different ways to get the response data (intuit-oauth library can return different formats)
    let queryResult;
    if (queryResponse.body) {
      queryResult = typeof queryResponse.body === 'string' ? JSON.parse(queryResponse.body) : queryResponse.body;
    } else if (queryResponse.json) {
      queryResult = typeof queryResponse.json === 'string' ? JSON.parse(queryResponse.json) : queryResponse.json;
    } else if (typeof queryResponse.getJson === 'function') {
      queryResult = queryResponse.getJson();
    } else if (queryResponse.response && queryResponse.response.body) {
      queryResult = typeof queryResponse.response.body === 'string' ? JSON.parse(queryResponse.response.body) : queryResponse.response.body;
    } else {
      console.error("[Search] Could not extract data from QB response:", JSON.stringify(queryResponse, null, 2));
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
    const baseUrl = 'https://sandbox-quickbooks.api.intuit.com';
    
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
    
    const createdCustomer = JSON.parse(createResponse.body).Customer;
    
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
      const { listUsers } = require("../../config/database");
      const allKeys = await listUsers();
      
      let fallbackUser = null;
      let fallbackUserId = null;
      let bestFallbackUser = null;
      let bestFallbackUserId = null;
      
      for (const key of allKeys) {
        const testUserData = await getUser(key);
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
          
          // Prefer users with both Pipedrive AND QB tokens (more likely to be valid)
          if (testUserData.qb_access_token && testUserData.qb_realm_id) {
            if (!bestFallbackUser) {
              bestFallbackUser = testUserData;
              bestFallbackUserId = key;
            }
          } else if (!fallbackUser) {
            // Save first user with just Pipedrive tokens as secondary fallback
            fallbackUser = testUserData;
            fallbackUserId = key;
          }
        }
      }
      
      // Use best fallback (with both tokens) if available, otherwise use any user with Pipedrive tokens
      if (!userData) {
        if (bestFallbackUser) {
          console.log(`[Attach Contact] Using best fallback user with both tokens: ${bestFallbackUserId}`);
          userData = bestFallbackUser;
          actualUserId = bestFallbackUserId;
        } else if (fallbackUser) {
          console.log(`[Attach Contact] Using fallback user with Pipedrive tokens: ${fallbackUserId}`);
          userData = fallbackUser;
          actualUserId = fallbackUserId;
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
      const url = `https://${apiDomain}${endpoint}?api_token=${accessToken}`;
      
      console.log(`[Attach Contact] Making ${method} request to ${endpoint} (attempt ${retryCount + 1})`);
      
      try {
        let response;
        if (method === 'GET') {
          response = await axios.get(url);
        } else if (method === 'PUT') {
          response = await axios.put(url, data);
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
            const { setUser } = require("../../config/database");
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

    // Get existing deal data
    const existingDeal = await makePipedriveCall('GET', `/v1/deals/${dealId}`);
    const currentNotes = existingDeal.data.data.notes || '';
    
    const updatedNotes = currentNotes.includes(`QB_CUSTOMER_ID:${qbCustomerId}`) 
      ? currentNotes 
      : `${currentNotes}\n\nQB_CUSTOMER_ID:${qbCustomerId}`;
    
    // Update deal with QB customer ID
    await makePipedriveCall('PUT', `/v1/deals/${dealId}`, {
      notes: updatedNotes
    });

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

    // Get user's Pipedrive tokens
    const userData = await getUser(userId);
    if (!userData || !userData.access_token) {
      return res.status(400).json({
        success: false,
        error: "Pipedrive not connected for this user"
      });
    }

    // Get deal data from Pipedrive
    // Handle api_domain with or without https:// prefix
    let apiDomain = userData.api_domain || 'api.pipedrive.com';
    if (apiDomain.startsWith('https://')) {
      apiDomain = apiDomain.replace('https://', '');
    }
    const dealUrl = `https://${apiDomain}/v1/deals/${dealId}?api_token=${userData.access_token}`;
    
    const dealResponse = await axios.get(dealUrl);
    const dealData = dealResponse.data.data;
    
    // Extract QB Customer ID from notes (in production, use custom field)
    const notes = dealData.notes || '';
    const qbIdMatch = notes.match(/QB_CUSTOMER_ID:(\w+)/);
    
    if (!qbIdMatch) {
      return res.json({
        success: true,
        customer: null
      });
    }

    const qbCustomerId = qbIdMatch[1];
    
    // Get customer details from QuickBooks
    try {
      const { qbClient, companyId } = await createQBClient(userId);
      const baseUrl = 'https://sandbox-quickbooks.api.intuit.com';
      
      const customerResponse = await qbClient.makeApiCall({
        url: `${baseUrl}/v3/company/${companyId}/customer/${qbCustomerId}?minorversion=65`,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      const customer = JSON.parse(customerResponse.body).Customer;
      
      res.json({
        success: true,
        customer: customer
      });
    } catch (qbError) {
      // If QB fetch fails, just return the ID
      res.json({
        success: true,
        customer: {
          Id: qbCustomerId,
          DisplayName: "QuickBooks Customer #" + qbCustomerId
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
      const { listUsers } = require("../../config/database");
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

    const baseUrl = 'https://sandbox-quickbooks.api.intuit.com';
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
    
    if (!queryResponse || !queryResponse.body) {
      return res.status(500).json({
        success: false,
        error: "Invalid response from QuickBooks"
      });
    }
    
    const queryResult = JSON.parse(queryResponse.body);
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

// Create QuickBooks invoice
router.post("/api/invoices", express.json(), async (req, res) => {
  try {
    const { customerId, lineItems, dueDate, memo } = req.body;
    const providedUserId = req.query.userId || req.body.userId || 'test';
    
    console.log('Creating invoice for customer:', customerId, 'User ID:', providedUserId);

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
      const { listUsers } = require("../../config/database");
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

    const baseUrl = 'https://sandbox-quickbooks.api.intuit.com';
    const realmId = userData.qb_realm_id;
    
    // Build invoice object
    const invoiceData = {
      CustomerRef: {
        value: customerId
      },
      Line: lineItems.map((item, index) => {
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
      })
    };
    
    // Add due date if provided
    if (dueDate) {
      invoiceData.DueDate = dueDate;
    }
    
    // Add memo/private note if provided
    if (memo) {
      invoiceData.PrivateNote = memo;
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
    
    if (!createResponse || !createResponse.body) {
      return res.status(500).json({
        success: false,
        error: "Invalid response from QuickBooks"
      });
    }
    
    const result = JSON.parse(createResponse.body);
    
    if (result.Invoice) {
      console.log('Invoice created successfully:', result.Invoice.Id);
      res.json({
        success: true,
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

module.exports = router;
