const express = require('express');
const router = express.Router();
const { getUser, setUser } = require('../../config/database');
const { getAuthUrl, getToken } = require('../auth/pipedrive');

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
    
    res.redirect('/success');
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).send('Authentication failed');
  }
});

router.get('/success', (req, res) => {
  res.send('<h1>Authentication Successful!</h1><p>Your Pipedrive account has been connected.</p>');
});

module.exports = router;
