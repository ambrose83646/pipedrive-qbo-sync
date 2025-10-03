const express = require('express');
const router = express.Router();
const { getUser, setUser } = require('../../config/database');
const { getAuthUrl, getToken } = require('../auth/pipedrive');
const qbAuth = require('../auth/quickbooks');

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
    res.status(500).send('Authentication failed');
  }
});

router.get('/auth/qb', (req, res) => {
  const userId = req.query.user_id;
  const authUrl = qbAuth.getAuthUrl(userId);
  res.redirect(authUrl);
});

router.get('/auth/qb/callback', async (req, res) => {
  const code = req.query.code;
  const userId = req.query.state;
  
  if (!code) {
    return res.status(400).send('Authorization code not provided');
  }
  
  if (!userId) {
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
    
    res.redirect('/success');
  } catch (error) {
    console.error('QB OAuth callback error:', error);
    res.status(500).send('QuickBooks authentication failed');
  }
});

router.get('/success', (req, res) => {
  res.send('<h1>Authentication Successful!</h1><p>Your Pipedrive and QuickBooks accounts have been connected.</p>');
});

module.exports = router;
