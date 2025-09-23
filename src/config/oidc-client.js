const crypto = require('crypto');

// Dynamic OIDC Client configuration based on current request
function getAdminClientConfig(req) {
  const protocol = req.protocol || 'http';
  const host = req.get('host') || 'localhost:3000';
  const instanceId = process.env.INSTANCE_ID || 'default';
  
  const clientId = process.env.ZOMBIE_ADMIN_CLIENT_ID;
  console.log(`DEBUG: OIDC getAdminClientConfig using client_id: ${clientId}`);
  
  return {
    client_id: clientId,
    client_secret: process.env.ZOMBIE_ADMIN_CLIENT_SECRET,
    redirect_uri: `${protocol}://${host}/callback`,
    post_logout_redirect_uri: `${protocol}://${host}/`,
    response_types: ['code'],
    grant_types: ['authorization_code', 'refresh_token'],
    scope: 'openid profile email',
    token_endpoint_auth_method: 'client_secret_basic'
  };
}


// OIDC endpoints
const getOidcEndpoints = (baseUrl = process.env.ISSUER || 'http://localhost:3000') => {
  // For internal container communication, use OIDC_INTERNAL_BASE_URL if available
  // For external URLs (like authorization_endpoint), use the configured ISSUER
  const internalBaseUrl = process.env.OIDC_INTERNAL_BASE_URL || baseUrl;
  
  console.log(`OIDC Endpoint Configuration:`);
  console.log(`- External base URL (ISSUER): ${baseUrl}`);
  console.log(`- Internal base URL: ${internalBaseUrl}`);
  
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/auth`,
    token_endpoint: `${internalBaseUrl}/token`,
    userinfo_endpoint: `${internalBaseUrl}/userinfo`,
    jwks_uri: `${internalBaseUrl}/.well-known/jwks.json`,
    end_session_endpoint: `${baseUrl}/logout`
  };
};

module.exports = {
  getAdminClientConfig,
  getOidcEndpoints
};