const axios = require('axios');

function getAuthUrl() {
  const clientId = process.env.PIPEDRIVE_CLIENT_ID;
  const redirectUri = process.env.APP_URL 
    ? process.env.APP_URL + '/auth/pipedrive/callback' 
    : 'https://pipedrive-qbo-sync.replit.app/auth/pipedrive/callback';
  const scopes = 'persons:full,organizations:full,deals:full';
  
  console.log('Generated redirectUri:', redirectUri);
  
  const authUrl = `https://oauth.pipedrive.com/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scopes)}`;
  
  return authUrl;
}

async function getToken(code) {
  const clientId = process.env.PIPEDRIVE_CLIENT_ID;
  const clientSecret = process.env.PIPEDRIVE_CLIENT_SECRET;
  const redirectUri = process.env.APP_URL 
    ? process.env.APP_URL + '/auth/pipedrive/callback' 
    : 'https://pipedrive-qbo-sync.replit.app/auth/pipedrive/callback';
  
  console.log('Client ID from env:', process.env.PIPEDRIVE_CLIENT_ID);
  console.log('Client Secret from env:', process.env.PIPEDRIVE_CLIENT_SECRET ? 'Set' : 'Missing');
  
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
