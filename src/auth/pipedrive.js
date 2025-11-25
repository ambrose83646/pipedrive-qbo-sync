const axios = require('axios');
const { Buffer } = require('buffer');

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

const getToken = async (code) => {
  const clientId = process.env.PIPEDRIVE_CLIENT_ID;
  const clientSecret = process.env.PIPEDRIVE_CLIENT_SECRET;
  const redirectUri = process.env.APP_URL + '/auth/pipedrive/callback';

  const authHeader = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: redirectUri
  });

  try {
    console.log('Token request headers:', { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' });
    console.log('Token request body:', params.toString());
    console.log('Using token endpoint:', 'https://oauth.pipedrive.com/oauth/token');

    const response = await axios.post('https://oauth.pipedrive.com/oauth/token', params, {
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    console.log('Token response:', response.status, response.data);
    return response.data;
  } catch (error) {
    console.error('Token exchange error:', error.response?.status, error.response?.data || error.message);
    console.error('Full token error response:', { status: error.response?.status, data: error.response?.data, message: error.message });
    throw error;
  }
};

const refreshToken = async (refreshTokenValue) => {
  const clientId = process.env.PIPEDRIVE_CLIENT_ID;
  const clientSecret = process.env.PIPEDRIVE_CLIENT_SECRET;

  const authHeader = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshTokenValue
  });

  try {
    console.log('[Pipedrive] Refreshing access token...');

    const response = await axios.post('https://oauth.pipedrive.com/oauth/token', params, {
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    console.log('[Pipedrive] Token refresh successful');
    return response.data;
  } catch (error) {
    console.error('[Pipedrive] Token refresh error:', error.response?.status, error.response?.data || error.message);
    throw error;
  }
};

module.exports = {
  getAuthUrl,
  getToken,
  refreshToken
};
