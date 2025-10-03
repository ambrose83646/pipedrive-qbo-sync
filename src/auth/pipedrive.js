const axios = require('axios');

function getAuthUrl() {
  const clientId = process.env.PIPEDRIVE_CLIENT_ID;
  const redirectUri = process.env.PIPEDRIVE_REDIRECT_URI || `${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co/auth/pipedrive/callback`;
  const scopes = 'persons:full,organizations:full,deals:full';
  
  const authUrl = `https://oauth.pipedrive.com/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scopes)}`;
  
  return authUrl;
}

async function getToken(code) {
  const clientId = process.env.PIPEDRIVE_CLIENT_ID;
  const clientSecret = process.env.PIPEDRIVE_CLIENT_SECRET;
  const redirectUri = process.env.PIPEDRIVE_REDIRECT_URI || `${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co/auth/pipedrive/callback`;
  
  try {
    const response = await axios.post('https://oauth.pipedrive.com/oauth/v1/token', {
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    return response.data;
  } catch (error) {
    console.error('Error getting token:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = {
  getAuthUrl,
  getToken
};
