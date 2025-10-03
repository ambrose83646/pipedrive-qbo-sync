const OAuthClient = require('intuit-oauth');

const oauthClient = new OAuthClient({
  clientId: process.env.QB_CLIENT_ID,
  clientSecret: process.env.QB_CLIENT_SECRET,
  environment: 'sandbox',
  redirectUri: process.env.APP_URL + '/auth/qb/callback'
});

function getAuthUrl(userId) {
  const authUri = oauthClient.authorizeUri({
    scope: ['com.intuit.quickbooks.accounting'],
    state: userId || 'test'
  });
  
  console.log('Generated QB auth URL');
  return authUri;
}

async function handleToken(requestUrl) {
  try {
    const authResponse = await oauthClient.createToken(requestUrl);
    
    const tokenData = {
      access_token: authResponse.token.access_token,
      refresh_token: authResponse.token.refresh_token,
      expires_in: authResponse.token.expires_in,
      token_type: authResponse.token.token_type,
      realm_id: authResponse.token.realmId
    };
    
    if (authResponse.token.expires_in) {
      const expiresAt = new Date(Date.now() + authResponse.token.expires_in * 1000);
      tokenData.expires_at = expiresAt.toISOString();
    }
    
    return tokenData;
  } catch (error) {
    console.error('Error handling QB token:', error);
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

module.exports = {
  getAuthUrl,
  handleToken,
  refreshToken
};
