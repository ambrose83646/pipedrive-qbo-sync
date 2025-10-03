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

    const response = await axios.post('https://oauth.pipedrive.com/oauth/v1/token', params, {
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    console.log('Token response:', response.status, response.data);
    return response.data;
  } catch (error) {
    console.error('Token exchange error:', error.response?.status, error.response?.data || error.message);
    throw error;
  }
};

module.exports = {
  getAuthUrl,
  getToken
};
