const express = require('express');
const router = express.Router();
const { getUser, setUser } = require('../../config/database');
const { getAuthUrl, getToken } = require('../auth/pipedrive');
const qbAuth = require('../auth/quickbooks');
const { syncContact } = require('../controllers/sync');

router.get('/', (req, res) => {
  res.send('Hello!');
});

router.get('/test-db', async (req, res) => {
  try {
    const testData = { name: 'Test User', token: 'fake' };
    await setUser('test123', testData);
    const retrievedData = await getUser('test123');
    res.json(retrievedData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/auth/pipedrive', (req, res) => {
  const authUrl = getAuthUrl();
  res.redirect(authUrl);
});

router.get('/auth/pipedrive/callback', async (req, res) => {
  console.log('Callback route hit! Code param:', req.query.code);
  const code = req.query.code;
  
  if (!code) {
    return res.status(400).send('Authorization code not provided');
  }
  
  try {
    const tokenData = await getToken(code);
    
    const userId = tokenData.api_domain || tokenData.user_id || 'pipedrive_user';
    
    await setUser(userId, {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in,
      token_type: tokenData.token_type,
      scope: tokenData.scope,
      api_domain: tokenData.api_domain,
      created_at: new Date().toISOString()
    });
    
    res.redirect('/auth/qb?user_id=' + encodeURIComponent(userId));
  } catch (error) {
    console.error('OAuth callback error:', error);
    console.log('Callback full error:' + JSON.stringify(error, null, 2));
    res.status(500).send('Auth failed: ' + (error.response?.data?.error_description || 'Unknown error'));
  }
});

router.get('/auth/qb', (req, res) => {
  const userId = req.query.user_id;
  const isExtension = req.query.extension === 'true';
  
  // Pass both userId and extension flag to getAuthUrl
  const authUrl = qbAuth.getAuthUrl(userId, isExtension);
  
  res.redirect(authUrl);
});

router.get('/auth/qb/callback', async (req, res) => {
  const code = req.query.code;
  const stateParam = req.query.state;
  
  // Decode state parameter to get userId and extension flag
  let userId;
  let isExtension = false;
  
  try {
    const decodedState = Buffer.from(stateParam, 'base64').toString('utf-8');
    const stateData = JSON.parse(decodedState);
    userId = stateData.userId;
    isExtension = stateData.extension || false;
  } catch (e) {
    // Fallback for old format (direct userId)
    userId = stateParam;
  }
  
  if (!code) {
    if (isExtension) {
      return res.send('<script>parent.postMessage({ success: false, error: "Authorization code not provided" }, "*");</script>');
    }
    return res.status(400).send('Authorization code not provided');
  }
  
  if (!userId) {
    if (isExtension) {
      return res.send('<script>parent.postMessage({ success: false, error: "User ID not found" }, "*");</script>');
    }
    return res.status(400).send('User ID not found in state parameter');
  }
  
  try {
    const requestUrl = req.url;
    const qbTokenData = await qbAuth.handleToken(requestUrl);
    
    const existingUser = await getUser(userId) || {};
    
    const updatedUser = {
      ...existingUser,
      qb_access_token: qbTokenData.access_token,
      qb_refresh_token: qbTokenData.refresh_token,
      qb_expires_in: qbTokenData.expires_in,
      qb_token_type: qbTokenData.token_type,
      qb_realm_id: qbTokenData.realm_id,
      qb_expires_at: qbTokenData.expires_at,
      qb_updated_at: new Date().toISOString()
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
    res.send('<html><body><h1>QuickBooks Connected Successfully!</h1><p>You can close this window.</p></body></html>');
  } catch (error) {
    console.error('QB OAuth callback error:', error);
    
    if (isExtension) {
      return res.send(`<script>parent.postMessage({ success: false, error: "${error.message}" }, "*");</script>`);
    }
    
    res.status(500).json({ success: false, error: 'QuickBooks authentication failed' });
  }
});

router.get('/success', (req, res) => {
  res.send('<h1>Authentication Successful!</h1><p>Your Pipedrive and QuickBooks accounts have been connected.</p>');
});

router.get('/api/user-status', async (req, res) => {
  try {
    const pipedriveUserId = req.query.userId;
    
    if (!pipedriveUserId) {
      return res.json({ 
        connected: false, 
        message: 'Connect QuickBooks to start.' 
      });
    }
    
    const userData = await getUser(pipedriveUserId);
    
    if (!userData) {
      return res.json({ 
        connected: false, 
        message: 'Connect QuickBooks to start.' 
      });
    }
    
    // Check if QuickBooks tokens exist
    const isConnected = !!(userData.qb_access_token && userData.qb_realm_id);
    
    if (isConnected) {
      res.json({
        connected: true,
        message: 'Ready to sync!'
      });
    } else {
      res.json({
        connected: false,
        message: 'Connect QuickBooks to start.'
      });
    }
    
  } catch (error) {
    console.error('User status check error:', error);
    res.json({ 
      connected: false, 
      message: 'Connect QuickBooks to start.' 
    });
  }
});

router.post('/api/sync-contact', express.json(), async (req, res) => {
  try {
    const { personId } = req.body;
    const pipedriveUserId = req.query.userId || req.session?.userId || req.body.userId;
    
    if (!personId) {
      return res.status(400).json({ 
        success: false, 
        error: 'personId is required in request body' 
      });
    }
    
    if (!pipedriveUserId) {
      return res.status(400).json({ 
        success: false, 
        error: 'pipedriveUserId is required (pass as query param userId, in session, or in body)' 
      });
    }
    
    console.log(`Sync request received - User: ${pipedriveUserId}, Person: ${personId}`);
    
    const result = await syncContact(pipedriveUserId, personId);
    
    res.json({
      success: true,
      qbCustomerId: result.qbCustomerId,
      action: result.action,
      personName: result.pipedrivePersonName
    });
    
  } catch (error) {
    console.error('API sync-contact error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

module.exports = router;
