const express = require("express");
const router = express.Router();
const { getUser, setUser } = require("../../config/database");
const { getAuthUrl, getToken } = require("../auth/pipedrive");
const qbAuth = require("../auth/quickbooks");
const { syncContact } = require("../controllers/sync");
const OAuthClient = require("intuit-oauth");
const axios = require("axios");

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

    const userId =
      tokenData.api_domain || tokenData.user_id || "pipedrive_user";

    await setUser(userId, {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in,
      token_type: tokenData.token_type,
      scope: tokenData.scope,
      api_domain: tokenData.api_domain,
      created_at: new Date().toISOString(),
    });

    res.redirect("/auth/qb?user_id=" + encodeURIComponent(userId));
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

    // If in extension/iframe, send message to parent
    if (isExtension) {
      return res.send(`
        <html>
          <body>
            <h3>Success! QuickBooks connected.</h3>
            <p>This window will close automatically...</p>
            <script>
              if (window.opener) {
                window.opener.postMessage({ success: true, source: 'qb-callback' }, '*');
                setTimeout(() => window.close(), 2000);
              } else if (parent !== window) {
                parent.postMessage({ success: true, source: 'qb-callback' }, '*');
              }
            </script>
          </body>
        </html>
      `);
    }

    // For regular flow, show success page
    res.send(
      "<html><body><h1>Connected Successfully!</h1><p>You can close this window.</p></body></html>",
    );
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
    const pipedriveUserId = req.query.userId;

    if (!pipedriveUserId) {
      return res.json({
        connected: false,
        message: "Connect QuickBooks to start.",
      });
    }

    const userData = await getUser(pipedriveUserId);

    if (!userData) {
      return res.json({
        connected: false,
        message: "Connect QuickBooks to start.",
      });
    }

    // Check if QuickBooks tokens exist
    const isConnected = !!(userData.qb_access_token && userData.qb_realm_id);

    if (isConnected) {
      res.json({
        connected: true,
        message: "Ready to sync!",
      });
    } else {
      res.json({
        connected: false,
        message: "Connect QuickBooks to start.",
      });
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

// Search QuickBooks customers
router.get("/api/items/search", async (req, res) => {
  try {
    const searchTerm = req.query.term;
    const userId = req.query.userId || 'test';

    if (!searchTerm) {
      return res.status(400).json({
        success: false,
        error: "Search term is required"
      });
    }

    const { qbClient, companyId } = await createQBClient(userId);
    const baseUrl = 'https://sandbox-quickbooks.api.intuit.com';
    
    // Search for customers by name or email
    const query = `SELECT * FROM Customer WHERE Active = true AND (DisplayName LIKE '%${searchTerm}%' OR PrimaryEmailAddr LIKE '%${searchTerm}%') MAXRESULTS 20`;
    const encodedQuery = encodeURIComponent(query);
    
    const queryResponse = await qbClient.makeApiCall({
      url: `${baseUrl}/v3/company/${companyId}/query?query=${encodedQuery}`,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    const queryResult = JSON.parse(queryResponse.text());
    const customers = queryResult.QueryResponse?.Customer || [];
    
    res.json({
      success: true,
      customers: customers
    });
  } catch (error) {
    console.error("Search customers error:", error);
    res.status(500).json({
      success: false,
      error: error.message
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
    
    const createdCustomer = JSON.parse(createResponse.text()).Customer;
    
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
    const { dealId, qbCustomerId } = req.body;
    const userId = req.query.userId || req.body.userId || 'test';

    if (!dealId || !qbCustomerId) {
      return res.status(400).json({
        success: false,
        error: "dealId and qbCustomerId are required"
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

    // Update deal with custom field containing QB Customer ID
    // Note: You'll need to create a custom field in Pipedrive for QB Customer ID
    // and replace 'custom_field_key' with the actual field key
    const apiDomain = userData.api_domain || 'api.pipedrive.com';
    const updateUrl = `https://${apiDomain}/v1/deals/${dealId}?api_token=${userData.access_token}`;
    
    // For now, we'll store in notes field as a placeholder
    // In production, use a proper custom field
    const existingDeal = await axios.get(updateUrl);
    const currentNotes = existingDeal.data.data.notes || '';
    
    const updatedNotes = currentNotes.includes(`QB_CUSTOMER_ID:${qbCustomerId}`) 
      ? currentNotes 
      : `${currentNotes}\n\nQB_CUSTOMER_ID:${qbCustomerId}`;
    
    await axios.put(updateUrl, {
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
    const apiDomain = userData.api_domain || 'api.pipedrive.com';
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
      
      const customer = JSON.parse(customerResponse.text()).Customer;
      
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

module.exports = router;
