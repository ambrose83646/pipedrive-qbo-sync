const OAuthClient = require('intuit-oauth');

const oauthClient = new OAuthClient({
  clientId: process.env.QB_CLIENT_ID,
  clientSecret: process.env.QB_CLIENT_SECRET,
  environment: process.env.QB_ENVIRONMENT || 'sandbox',
  redirectUri: process.env.APP_URL + '/auth/qb/callback'
});

function getAuthUrl(userId, isExtension = false, options = {}) {
  // Encode userId, extension flag, and additional identifiers in state parameter
  const stateData = JSON.stringify({ 
    userId: userId || 'test', 
    extension: isExtension,
    companyDomain: options.companyDomain || null,
    numericUserId: options.numericUserId || null
  });
  const state = Buffer.from(stateData).toString('base64');
  
  const authUri = oauthClient.authorizeUri({
    scope: ['com.intuit.quickbooks.accounting'],
    state: state
  });
  
  console.log('Generated QB auth URL with companyDomain:', options.companyDomain, 'numericUserId:', options.numericUserId);
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

async function refreshToken(tokenData) {
  console.log('[QB Auth] Starting token refresh...');
  
  // Accept either a string (legacy) or full token object
  const isFullTokenObject = typeof tokenData === 'object' && tokenData !== null;
  const refreshTokenValue = isFullTokenObject ? tokenData.refresh_token : tokenData;
  
  console.log('[QB Auth] Refresh token prefix:', refreshTokenValue?.substring(0, 15) + '...');
  console.log('[QB Auth] Using full token object:', isFullTokenObject);
  
  try {
    // Set the complete token object for proper refresh
    // The intuit-oauth library requires the full token state, not just refresh_token
    if (isFullTokenObject) {
      oauthClient.setToken({
        token_type: tokenData.token_type || 'bearer',
        access_token: tokenData.access_token || '',
        refresh_token: tokenData.refresh_token,
        expires_in: tokenData.expires_in || 3600,
        x_refresh_token_expires_in: tokenData.x_refresh_token_expires_in || 8726400
      });
    } else {
      // Legacy fallback - may not work correctly
      console.warn('[QB Auth] Warning: Using refresh token only (legacy mode). This may fail.');
      oauthClient.setToken({
        refresh_token: refreshTokenValue
      });
    }
    
    const authResponse = await oauthClient.refresh();
    
    console.log('[QB Auth] Refresh successful!');
    console.log('[QB Auth] New access token received:', !!authResponse.token.access_token);
    console.log('[QB Auth] New refresh token received:', !!authResponse.token.refresh_token);
    console.log('[QB Auth] New refresh token prefix:', authResponse.token.refresh_token?.substring(0, 15) + '...');
    console.log('[QB Auth] Expires in:', authResponse.token.expires_in, 'seconds');
    
    return {
      access_token: authResponse.token.access_token,
      refresh_token: authResponse.token.refresh_token,
      expires_in: authResponse.token.expires_in,
      token_type: authResponse.token.token_type
    };
  } catch (error) {
    console.error('[QB Auth] Error refreshing token:', error.message);
    
    // Log detailed error info
    if (error.authResponse) {
      console.error('[QB Auth] Auth response error:', {
        status: error.authResponse.response?.status,
        body: error.authResponse.response?.body
      });
    }
    if (error.originalMessage) {
      console.error('[QB Auth] Original error message:', error.originalMessage);
    }
    if (error.intuit_tid) {
      console.error('[QB Auth] Intuit TID:', error.intuit_tid);
    }
    
    // Check for specific refresh token errors
    const errorStr = JSON.stringify(error).toLowerCase();
    if (errorStr.includes('invalid_grant') || errorStr.includes('expired') || errorStr.includes('revoked')) {
      const customError = new Error('QuickBooks refresh token has expired or been revoked. Please reconnect to QuickBooks.');
      customError.code = 'REFRESH_TOKEN_EXPIRED';
      throw customError;
    }
    
    throw error;
  }
}

module.exports = {
  getAuthUrl,
  handleToken,
  refreshToken
};
