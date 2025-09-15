const { URLSearchParams } = require('url');
const crypto = require('crypto');
const { getAdminClientConfig, getOidcEndpoints } = require('../config/oidc-client');

// Generate a secure random state string for CSRF protection
function generateState() {
  return crypto.randomBytes(32).toString('hex');
}

// Generate PKCE code verifier and challenge
function generatePKCE() {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

// Redirect to OIDC provider for authentication
function redirectToLogin(req, res) {
  try {
    const clientConfig = getAdminClientConfig(req);
    const endpoints = getOidcEndpoints();
    
    // Generate state and PKCE for security
    const state = generateState();
    const { codeVerifier, codeChallenge } = generatePKCE();
    
    // Store state and code verifier in session for later verification
    req.session.oidc_state = state;
    req.session.oidc_code_verifier = codeVerifier;
    
    console.log('OIDC Login Debug:');
    console.log('- Generated state:', state);
    console.log('- Session ID:', req.sessionID);
    console.log('- Stored in session:', req.session.oidc_state);
    
    // Build authorization URL
    const authParams = new URLSearchParams({
      response_type: 'code',
      client_id: clientConfig.client_id,
      redirect_uri: clientConfig.redirect_uri,
      scope: clientConfig.scope,
      state: state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    });
    
    const authUrl = `${endpoints.authorization_endpoint}?${authParams}`;
    console.log('Redirecting to OIDC provider:', authUrl);
    
    // Ensure session is saved before redirecting
    req.session.save((err) => {
      if (err) {
        console.error('Error saving session before OIDC redirect:', err);
        return res.status(500).send('Session error');
      }
      console.log('Session saved successfully before redirect');
      console.log('- Final session state:', req.session.oidc_state);
      console.log('- Final session code verifier length:', req.session.oidc_code_verifier?.length);

      // Add a small delay to ensure session is fully persisted
      setTimeout(() => {
        res.redirect(authUrl);
      }, 50);
    });
  } catch (error) {
    console.error('Error redirecting to OIDC login:', error);
    res.status(500).send('Authentication error');
  }
}

// Handle OIDC callback and exchange code for tokens
async function handleCallback(req, res) {
  try {
    const { code, state } = req.query;
    
    console.log('OIDC Callback Debug:');
    console.log('- Received state:', state);
    console.log('- Session oidc_state:', req.session.oidc_state);
    console.log('- Session ID:', req.sessionID);
    console.log('- Session keys:', Object.keys(req.session || {}));

    // If session data is missing, handle the race condition more gracefully
    if (!req.session.oidc_state && state) {
      console.log('Session state missing, this may be a race condition...');
      console.log('- Session store type:', req.session.constructor.name);
      console.log('- Session cookie present:', !!req.headers.cookie);

      // Instead of reloading (which fails with MemoryStore), wait briefly and retry
      console.log('Waiting 100ms and retrying callback...');
      await new Promise(resolve => setTimeout(resolve, 100));

      // Check if session data appeared after brief wait
      if (!req.session.oidc_state) {
        console.error('Session data still missing after wait. Possible causes:');
        console.error('1. Session not properly saved during redirect');
        console.error('2. Session cookie not being sent');
        console.error('3. Different session ID between requests');

        // Clear any partial session data and redirect to start over
        req.session.destroy((err) => {
          if (err) console.error('Session destroy error:', err);
          return res.redirect('/auth');
        });
        return;
      }

      console.log('Session data appeared after wait, continuing...');
    }

    // Verify state parameter for CSRF protection
    if (!state || state !== req.session.oidc_state) {
      console.error('Invalid state parameter - state mismatch');
      console.error('Expected:', req.session.oidc_state);
      console.error('Received:', state);
      return res.status(400).send('Invalid state parameter');
    }
    
    if (!code) {
      console.error('Missing authorization code');
      return res.status(400).send('Missing authorization code');
    }
    
    const clientConfig = getAdminClientConfig(req);
    const endpoints = getOidcEndpoints();

    // Wait 3 seconds before token exchange to ensure everything is settled
    console.log('Waiting 3 seconds before token exchange...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Exchange authorization code for tokens
    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: clientConfig.redirect_uri,
      client_id: clientConfig.client_id,
      client_secret: clientConfig.client_secret,
      code_verifier: req.session.oidc_code_verifier
    });

    console.log('Exchanging code for tokens at:', endpoints.token_endpoint);
    
    const tokenResponse = await fetch(endpoints.token_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: tokenParams
    });
    
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('Token exchange failed:', tokenResponse.status, errorText);
      return res.status(400).send('Token exchange failed');
    }
    
    const tokens = await tokenResponse.json();
    
    // Get user info
    const userInfoResponse = await fetch(endpoints.userinfo_endpoint, {
      headers: {
        'Authorization': `Bearer ${tokens.access_token}`,
        'Accept': 'application/json'
      }
    });
    
    if (!userInfoResponse.ok) {
      const errorText = await userInfoResponse.text();
      console.error('UserInfo request failed:', userInfoResponse.status, errorText);
      return res.status(400).send('UserInfo request failed');
    }
    
    const userInfo = await userInfoResponse.json();
    
    // Store user info in session
    req.session.oidc_user = {
      ...userInfo,
      tokens: tokens
    };
    
    // Add to request for immediate use
    req.oidc_user = req.session.oidc_user;
    
    // Clean up temporary session data
    delete req.session.oidc_state;
    delete req.session.oidc_code_verifier;
    
    // Redirect to originally requested page or dashboard
    const returnTo = req.session.oidc_return_to || '/';
    delete req.session.oidc_return_to;
    
    console.log('OIDC authentication successful for user:', userInfo.preferred_username);
    res.redirect(returnTo);
    
  } catch (error) {
    console.error('Error handling OIDC callback:', error);
    res.status(500).send('Authentication error');
  }
}

// Handle logout
function handleLogout(req, res) {
  try {
    const endpoints = getOidcEndpoints();
    const clientConfig = getAdminClientConfig(req);
    
    // Clear session
    req.session.destroy((err) => {
      if (err) {
        console.error('Error destroying session:', err);
      }
    });
    
    // Redirect to OIDC provider logout
    const logoutParams = new URLSearchParams({
      post_logout_redirect_uri: clientConfig.post_logout_redirect_uri
    });
    
    const logoutUrl = `${endpoints.end_session_endpoint}?${logoutParams}`;
    console.log('Redirecting to OIDC logout:', logoutUrl);
    
    res.redirect(logoutUrl);
  } catch (error) {
    console.error('Error handling logout:', error);
    res.redirect('/');
  }
}

// Middleware to require OIDC authentication
function requireOidcAuth(requiredRole = null) {
  return (req, res, next) => {
    // Check if user is authenticated
    if (!req.session.oidc_user) {
      // Store the original URL for redirect after login
      req.session.oidc_return_to = req.originalUrl;
      return redirectToLogin(req, res);
    }
    
    // Add user to request object
    req.oidc_user = req.session.oidc_user;
    
    // Check role if required
    if (requiredRole) {
      const userRoles = req.oidc_user.roles || [];
      if (!userRoles.includes(requiredRole)) {
        return res.status(403).send('Insufficient permissions');
      }
    }
    
    next();
  };
}

module.exports = {
  redirectToLogin,
  handleCallback,
  handleLogout,
  requireOidcAuth
};