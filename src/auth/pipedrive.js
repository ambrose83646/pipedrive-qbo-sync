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
  
  const requestData = {
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret
  };
  
  const requestConfig = {
    headers: {
      'Content-Type': 'application/json'
    }
  };
  
  console.log('Pipedrive Token Request Config:');
  console.log('URL:', 'https://oauth.pipedrive.com/oauth/v1/token');
  console.log('Headers:', JSON.stringify(requestConfig.headers, null, 2));
  console.log('Data:', JSON.stringify({
    ...requestData,
    client_secret: clientSecret ? '[REDACTED]' : 'Missing'
  }, null, 2));
  
  try {
    const response = await axios.post('https://oauth.pipedrive.com/oauth/v1/token', requestData, requestConfig);
    
    console.log('Pipedrive Token Response:');
    console.log('Status:', response.status);
    console.log('Data:', JSON.stringify(response.data, null, 2));
    
    return response.data;
  } catch (error) {
    console.error('=== Pipedrive Token Error ===');
    console.error('Error Message:', error.message);
    
    if (error.response) {
      console.error('Response Status:', error.response.status);
      console.error('Response Headers:', JSON.stringify(error.response.headers, null, 2));
      console.error('Response Data:', JSON.stringify(error.response.data, null, 2));
    } else if (error.request) {
      console.error('No response received');
      console.error('Request:', error.request);
    } else {
      console.error('Error setting up request:', error.message);
    }
    
    console.error('Full Error:', error);
    throw error;
  }
}

module.exports = {
  getAuthUrl,
  getToken
};
