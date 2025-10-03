const OAuthClient = require('intuit-oauth');

const oauthClient = new OAuthClient({
  clientId: process.env.QB_CLIENT_ID,
  clientSecret: process.env.QB_CLIENT_SECRET,
  environment: 'sandbox',
  redirectUri: process.env.APP_URL 
    ? process.env.APP_URL + '/auth/qb/callback' 
    : 'https://pipedrive-qbo-sync.replit.app/auth/qb/callback',
  logging: true
});

function getAuthUrl(userId) {
  const redirectUri = process.env.APP_URL 
    ? process.env.APP_URL + '/auth/qb/callback' 
    : 'https://pipedrive-qbo-sync.replit.app/auth/qb/callback';
  
  console.log('Generated QB redirectUri:', redirectUri);
  
  const authUri = oauthClient.authorizeUri({
    scope: [OAuthClient.scopes.Accounting, OAuthClient.scopes.OpenId],
    state: userId || 'default_user'
  });
  
  return authUri;
}

async function getToken(code, realmId) {
  try {
    const authResponse = await oauthClient.createToken(code);
    
    return {
      access_token: authResponse.token.access_token,
      refresh_token: authResponse.token.refresh_token,
      expires_in: authResponse.token.expires_in,
      token_type: authResponse.token.token_type,
      realm_id: realmId
    };
  } catch (error) {
    console.error('Error getting QB token:', error);
    throw error;
  }
}

async function refreshToken(refreshToken) {
  try {
    oauthClient.setToken({
      refresh_token: refreshToken
    });
    
    const authResponse = await oauthClient.refresh();
    
    return {
      access_token: authResponse.token.access_token,
      refresh_token: authResponse.token.refresh_token,
      expires_in: authResponse.token.expires_in,
      token_type: authResponse.token.token_type
    };
  } catch (error) {
    console.error('Error refreshing QB token:', error);
    throw error;
  }
}

function isTokenExpired(expiresAt) {
  if (!expiresAt) return true;
  const now = new Date().getTime();
  const expiry = new Date(expiresAt).getTime();
  return now >= expiry;
}

module.exports = {
  getAuthUrl,
  getToken,
  refreshToken,
  isTokenExpired
};
