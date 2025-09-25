const express = require('express');
const User = require('../models/User');
const Session = require('../models/Session');
const Activity = require('../models/Activity');
const Client = require('../models/Client');
const database = require('../database');
const oidcAuth = require('../middleware/oidc-auth');
const { getClientIp } = require('../utils/ip-helper');
const ConflictDetector = require('../services/conflict-detector');
const ClusterHealth = require('../services/cluster-health');
const { validationRules, handleValidationErrors } = require('../middleware/validation');

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  const parts = [];
  if (days > 0) parts.push(`${days} day${days !== 1 ? 's' : ''}`);
  if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes !== 1 ? 's' : ''}`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs} second${secs !== 1 ? 's' : ''}`);
  
  return parts.join(', ');
}

const router = express.Router();

// Helper function to add user context to render data
function addUserContext(req, renderData) {
  return { ...renderData };
}

// Login is handled directly via /auth route - no separate login page needed

// Initiate OIDC authentication
router.get('/auth', (req, res) => {
  // Set the return URL to admin dashboard before redirecting to login
  if (!req.session.oidc_return_to || req.session.oidc_return_to === '/auth') {
    req.session.oidc_return_to = '/';
  }
  oidcAuth.redirectToLogin(req, res);
});


// Admin dashboard
router.get('/', oidcAuth.requireOidcAuth('admin'), async (req, res) => {
  console.log('🎯 ADMIN ROUTE: Root path hit - rendering admin dashboard');
  console.log('🎯 ADMIN ROUTE: User roles:', req.oidc_user?.roles);
  try {
    const dbStatus = await database.testConnection();
    
    // Get database conflicts
    const conflictDetector = new ConflictDetector();
    await conflictDetector.initialize();
    const conflictStats = await conflictDetector.getConflictStats();
    
    // Get isolation info from cluster health
    console.log('Dashboard: Initializing cluster health...');
    const clusterHealth = new ClusterHealth();
    await clusterHealth.initialize();
    console.log('Dashboard: Running cluster health check...');
    // Trigger health check to detect current isolation status
    await clusterHealth.checkClusterHealth();
    console.log('Dashboard: Getting isolated records count...');
    const isolatedRecordsCount = await clusterHealth.getIsolatedRecordsCount();
    console.log('Dashboard: Isolated records count:', isolatedRecordsCount);
    
    // Get recent activity
    const recentActivity = await Activity.findRecent(10);
    
    const totalDocs = dbStatus.doc_count || 0;
    const dbConflicts = conflictStats.total || 0;
    const isolatedRecords = isolatedRecordsCount;
    const syncedRecords = Math.max(0, totalDocs - dbConflicts - isolatedRecords);
    
    const stats = {
      totalDocs,
      dbConflicts,
      isolatedRecords,
      syncedRecords
    };
    
    res.render('dashboard', addUserContext(req, {
      title: 'Dashboard',
      isDashboard: true,
      stats,
      dbStatus,
      uptime: formatUptime(process.uptime()),
      nodeId: process.env.CLUSTER_NODE_ID || 'default',
      recentActivity: recentActivity.map(activity => activity.toPublicJSON())
    }));
  } catch (error) {
    console.error('Dashboard error:', error);
    res.render('dashboard', addUserContext(req, {
      title: 'Dashboard',
      isDashboard: true,
      stats: { totalDocs: 0, dbConflicts: 0, isolatedRecords: 0, syncedRecords: 0 },
      dbStatus: { connected: false },
      uptime: formatUptime(process.uptime()),
      nodeId: 'error'
    }));
  }
});

// Users list
router.get('/users', oidcAuth.requireOidcAuth('admin'), async (req, res) => {
  try {
    const db = database.getDb();
    const result = await db.view('users', 'by_username', { 
      include_docs: true,
      conflicts: true 
    });
    
    // Initialize cluster health to check for isolated records
    const ClusterHealth = require('../services/cluster-health');
    const clusterHealth = new ClusterHealth();
    await clusterHealth.initialize();
    
    const users = await Promise.all(result.rows.map(async row => {
      const user = new User(row.doc);
      const publicUser = user.toPublicJSON();
      
      try {
        // Get the document with conflicts to properly detect them
        const docWithConflicts = await db.get(row.doc._id, { conflicts: true });
        
        
        // Check for actual CouchDB conflicts first
        if (docWithConflicts._conflicts && docWithConflicts._conflicts.length > 0) {
          console.log(`User ${publicUser.username} has conflicts:`, docWithConflicts._conflicts);
          publicUser.syncStatus = 'conflict';
        }
        // Check if this user record is isolated using the raw document
        else if (clusterHealth.isRecordIsolated(row.doc)) {
          console.log(`User ${publicUser.username} is isolated - modified at:`, row.doc.instance_metadata?.last_modified_at);
          publicUser.syncStatus = 'isolated';
        } else {
          console.log(`User ${publicUser.username} is synced - modified at:`, row.doc.instance_metadata?.last_modified_at, 'isolation start:', global.clusterIsolationState.isolationStartTime?.toISOString());
          publicUser.syncStatus = 'synced';
        }
      } catch (error) {
        console.error(`Error getting conflicts for user ${publicUser.username}:`, error);
        // Fallback to isolation check
        if (clusterHealth.isRecordIsolated(row.doc)) {
          publicUser.syncStatus = 'isolated';
        } else {
          publicUser.syncStatus = 'synced';
        }
      }
      
      return publicUser;
    }));
    
    // Sort users to pin the current admin user to the top
    const sortedUsers = users.sort((a, b) => {
      if (req.oidc_user && a.username === req.oidc_user.username) return -1;
      if (req.oidc_user && b.username === req.oidc_user.username) return 1;
      return a.username.localeCompare(b.username);
    });
    
    // Calculate user stats with proper priority: disabled > unverified > active
    const userStats = {
      activeUsers: users.filter(user => user.enabled && user.email_verified).length,
      disabledUsers: users.filter(user => !user.enabled).length,
      unverifiedUsers: users.filter(user => user.enabled && !user.email_verified).length,
      totalUsers: users.length
    };
    
    res.render('users', addUserContext(req, {
      title: 'Users',
      isUsers: true,
      users: sortedUsers,
      userStats
    }));
  } catch (error) {
    console.error('Users list error:', error);
    res.render('users', addUserContext(req, {
      title: 'Users',
      isUsers: true,
      users: [],
      userStats: { activeUsers: 0, disabledUsers: 0, unverifiedUsers: 0, totalUsers: 0 },
      message: 'Error loading users: ' + error.message,
      messageType: 'danger'
    }));
  }
});

// New user form
router.get('/users/new', oidcAuth.requireOidcAuth('admin'), (req, res) => {
  res.render('user-form', addUserContext(req, {
    title: 'Add User',
    isUsers: true
  }));
});

// Create user
router.post('/users', oidcAuth.requireOidcAuth('admin'), async (req, res) => {
  try {
    const { username, email, password, firstName, lastName, groups, roles, enabled, emailVerified } = req.body;
    
    if (!username || !email || !password) {
      return res.render('user-form', addUserContext(req, {
        title: 'Add User',
        isUsers: true,
        message: 'Username, email, and password are required',
        messageType: 'danger',
        user: req.body
      }));
    }
    
    // Check if user exists
    const existingUser = await User.findByUsername(username);
    if (existingUser) {
      return res.render('user-form', addUserContext(req, {
        title: 'Add User',
        isUsers: true,
        message: 'Username already exists',
        messageType: 'danger',
        user: req.body
      }));
    }
    
    const existingEmail = await User.findByEmail(email);
    if (existingEmail) {
      return res.render('user-form', addUserContext(req, {
        title: 'Add User',
        isUsers: true,
        message: 'Email already exists',
        messageType: 'danger',
        user: req.body
      }));
    }
    
    // Create user
    const passwordHash = await User.hashPassword(password);
    const user = new User({
      username,
      email,
      passwordHash,
      first_name: firstName || undefined,
      last_name: lastName || undefined,
      groups: groups ? groups.split(',').map(g => g.trim()).filter(g => g) : [],
      roles: roles ? roles.split(',').map(r => r.trim()).filter(r => r) : [],
      enabled: enabled === 'on',
      email_verified: emailVerified === 'on'
    });
    
    await user.save();
    
    // Log activity
    await Activity.logActivity('user_created', {
      target_username: user.username,
      target_user_id: user._id,
      admin_user_id: req.oidc_user?.sub,
      admin_username: req.oidc_user?.username,
      ip: getClientIp(req),
      user_agent: req.headers['user-agent']
    });
    
    res.redirect('/admin/users?message=User created successfully&messageType=success');
  } catch (error) {
    console.error('Create user error:', error);
    res.render('user-form', addUserContext(req, {
      title: 'Add User',
      isUsers: true,
      message: 'Error creating user: ' + error.message,
      messageType: 'danger',
      user: req.body
    }));
  }
});

// View user details
router.get('/users/:id', oidcAuth.requireOidcAuth('admin'), async (req, res) => {
  try {
    const userId = decodeURIComponent(req.params.id);
    const user = await User.findById(userId);
    if (!user) {
      return res.redirect('/admin/users?message=User not found&messageType=danger');
    }
    
    // Get user sessions - only truly active ones for the sidebar
    const allSessions = await Session.findByUserId(userId);
    const allActiveSessions = allSessions.filter(session => session.active && !session.isExpired());
    const displaySessions = allActiveSessions
      .map(session => ({
        ...session.toPublicJSON(),
        isExpired: false
      }))
      .slice(0, 5); // Limit to 5 sessions
    
    res.render('user-details', addUserContext(req, {
      title: 'User Details',
      isUsers: true,
      user: user.toPublicJSON(),
      sessions: displaySessions,
      totalActiveSessions: allActiveSessions.length,
      totalSessions: allSessions.length,
      hasMoreSessions: allActiveSessions.length > 5
    }));
  } catch (error) {
    console.error('View user error:', error);
    res.redirect('/admin/users?message=Error loading user: ' + error.message + '&messageType=danger');
  }
});

// Edit user form
router.get('/users/:id/edit', oidcAuth.requireOidcAuth('admin'), async (req, res) => {
  try {
    const userId = decodeURIComponent(req.params.id);
    const user = await User.findById(userId);
    if (!user) {
      return res.redirect('/admin/users?message=User not found&messageType=danger');
    }
    
    res.render('user-form', addUserContext(req, {
      title: 'Edit User',
      isUsers: true,
      user: user.toPublicJSON()
    }));
  } catch (error) {
    console.error('Edit user error:', error);
    res.redirect('/admin/users?message=Error loading user: ' + error.message + '&messageType=danger');
  }
});


// Update user
router.put('/users/:id', oidcAuth.requireOidcAuth('admin'), async (req, res) => {
  try {
    const userId = decodeURIComponent(req.params.id);
    const user = await User.findById(userId);
    if (!user) {
      return res.redirect('/admin/users?message=User not found&messageType=danger');
    }
    
    const { email, firstName, lastName, groups, roles, enabled, emailVerified } = req.body;
    
    // Check email uniqueness (if changed)
    if (email !== user.email) {
      const existingEmail = await User.findByEmail(email);
      if (existingEmail) {
        return res.render('user-form', addUserContext(req, {
          title: 'Edit User',
          isUsers: true,
          user: user.toPublicJSON(),
          message: 'Email already exists',
          messageType: 'danger'
        }));
      }
    }
    
    // Update user
    user.email = email;
    user.first_name = firstName || undefined;
    user.last_name = lastName || undefined;
    user.groups = groups ? groups.split(',').map(g => g.trim()).filter(g => g) : [];
    user.roles = roles ? roles.split(',').map(r => r.trim()).filter(r => r) : [];
    user.enabled = enabled === 'on';
    user.email_verified = emailVerified === 'on';
    
    await user.save();
    
    // Log activity
    await Activity.logActivity('user_updated', {
      target_username: user.username,
      target_user_id: user._id,
      admin_user_id: req.oidc_user?.sub,
      admin_username: req.oidc_user?.username,
      ip: getClientIp(req),
      user_agent: req.headers['user-agent']
    });
    
    res.redirect('/admin/users?message=User updated successfully&messageType=success');
  } catch (error) {
    console.error('Update user error:', error);
    const user = await User.findById(req.params.id);
    res.render('user-form', addUserContext(req, {
      title: 'Edit User',
      isUsers: true,
      user: user ? user.toPublicJSON() : {},
      message: 'Error updating user: ' + error.message,
      messageType: 'danger'
    }));
  }
});

// Sessions list
router.get('/sessions', oidcAuth.requireOidcAuth('admin'), async (req, res) => {
  try {
    const db = database.getDb();
    const result = await db.view('sessions', 'by_user_id', { 
      include_docs: true,
      conflicts: true 
    });
    
    // Initialize cluster health to check for isolated records
    const ClusterHealth = require('../services/cluster-health');
    const clusterHealth = new ClusterHealth();
    await clusterHealth.initialize();
    
    const sessionsWithUsers = await Promise.all(result.rows.map(async row => {
      const session = new Session(row.doc);
      const user = await User.findById(session.user_id);
      const sessionData = {
        ...session.toPublicJSON(),
        user: user ? user.toPublicJSON() : { username: 'Unknown', email: 'Unknown' },
        isExpired: session.isExpired()
      };
      
      // Check for actual CouchDB conflicts first
      if (row.doc._conflicts && row.doc._conflicts.length > 0) {
        console.log(`Session ${sessionData.id} for user ${sessionData.user.username} has conflicts:`, row.doc._conflicts);
        sessionData.syncStatus = 'conflict';
      }
      // Check if this session record is isolated using the raw document
      else if (clusterHealth.isRecordIsolated(row.doc)) {
        console.log(`Session ${sessionData.id} for user ${sessionData.user.username} is isolated - modified at:`, row.doc.instance_metadata?.last_modified_at);
        sessionData.syncStatus = 'isolated';
      } else {
        console.log(`Session ${sessionData.id} for user ${sessionData.user.username} is synced - modified at:`, row.doc.instance_metadata?.last_modified_at, 'isolation start:', global.clusterIsolationState.isolationStartTime?.toISOString());
        sessionData.syncStatus = 'synced';
      }
      
      return sessionData;
    }));
    
    const stats = {
      totalSessions: sessionsWithUsers.length,
      activeSessions: sessionsWithUsers.filter(s => s.active && !s.isExpired).length,
      inactiveSessions: sessionsWithUsers.filter(s => !s.active).length,
      expiredSessions: sessionsWithUsers.filter(s => s.active && s.isExpired).length
    };
    
    res.render('sessions', addUserContext(req, {
      title: 'Sessions',
      isSessions: true,
      sessions: sessionsWithUsers,
      stats
    }));
  } catch (error) {
    console.error('Sessions list error:', error);
    res.render('sessions', addUserContext(req, {
      title: 'Sessions',
      isSessions: true,
      sessions: [],
      stats: { totalSessions: 0, activeSessions: 0, inactiveSessions: 0, expiredSessions: 0 },
      message: 'Error loading sessions: ' + error.message,
      messageType: 'danger'
    }));
  }
});

// Clients list
router.get('/clients', oidcAuth.requireOidcAuth('admin'), async (req, res) => {
  try {
    // Get raw documents to check isolation status
    const db = database.getDb();
    const result = await db.view('clients', 'by_name', { 
      include_docs: true,
      conflicts: true 
    });
    
    // Initialize cluster health to check for isolated records
    const ClusterHealth = require('../services/cluster-health');
    const clusterHealth = new ClusterHealth();
    await clusterHealth.initialize();
    
    const clients = result.rows.map(row => {
      const client = new Client(row.doc);
      
      // Check for actual CouchDB conflicts first
      if (row.doc._conflicts && row.doc._conflicts.length > 0) {
        console.log(`Client ${client.client_id} has conflicts:`, row.doc._conflicts);
        client.syncStatus = 'conflict';
      }
      // Check if this client record is isolated using the raw document
      else if (clusterHealth.isRecordIsolated(row.doc)) {
        console.log(`Client ${client.client_id} is isolated - modified at:`, row.doc.instance_metadata?.last_modified_at);
        client.syncStatus = 'isolated';
      } else {
        console.log(`Client ${client.client_id} is synced - modified at:`, row.doc.instance_metadata?.last_modified_at, 'isolation start:', global.clusterIsolationState.isolationStartTime?.toISOString());
        client.syncStatus = 'synced';
      }
      
      console.log(`Client ${client.client_id} final syncStatus:`, client.syncStatus);
      console.log(`Client ${client.client_id} has syncStatus property:`, 'syncStatus' in client);
      console.log(`Client ${client.client_id} object keys:`, Object.keys(client));
      return client;
    });
    
    // Sort clients to pin default client to the top
    const defaultClientId = process.env.CLIENT_ID;
    if (!defaultClientId) {
      throw new Error('CLIENT_ID environment variable must be set for security');
    }
    const sortedClients = clients.sort((a, b) => {
      if (a.client_id === defaultClientId) return -1;
      if (b.client_id === defaultClientId) return 1;
      return a.name.localeCompare(b.name);
    });
    
    // Calculate client stats
    const clientStats = {
      activeClients: clients.filter(client => client.enabled).length,
      confidentialClients: clients.filter(client => client.confidential).length,
      publicClients: clients.filter(client => !client.confidential).length,
      totalClients: clients.length
    };
    
    res.render('clients', addUserContext(req, {
      title: 'Clients',
      isClients: true,
      clients: sortedClients.map(client => {
        const clientJson = client.toSafeJSON();
        clientJson.isDefaultClient = client.client_id === defaultClientId;
        return clientJson;
      }),
      clientStats
    }));
  } catch (error) {
    console.error('Clients list error:', error);
    res.render('clients', addUserContext(req, {
      title: 'Clients',
      isClients: true,
      clients: [],
      clientStats: { activeClients: 0, confidentialClients: 0, publicClients: 0, totalClients: 0 },
      message: 'Error loading clients: ' + error.message,
      messageType: 'danger'
    }));
  }
});

// New client form
router.get('/clients/new', oidcAuth.requireOidcAuth('admin'), (req, res) => {
  res.render('client-form', addUserContext(req, {
    title: 'Add Client',
    isClients: true
  }));
});

// Middleware to preprocess client form data
const preprocessClientData = (req, res, next) => {
  if (req.body.redirectUris && typeof req.body.redirectUris === 'string') {
    req.body.redirectUris = req.body.redirectUris.split('\n').map(uri => uri.trim()).filter(uri => uri);
  }
  if (req.body.scopes && typeof req.body.scopes === 'string') {
    req.body.scopes = req.body.scopes.split(',').map(s => s.trim()).filter(s => s);
  }
  if (req.body.grantTypes && typeof req.body.grantTypes === 'string') {
    req.body.grantTypes = req.body.grantTypes.split(',').map(gt => gt.trim()).filter(gt => gt);
  }
  if (req.body.responseTypes && typeof req.body.responseTypes === 'string') {
    req.body.responseTypes = req.body.responseTypes.split(',').map(rt => rt.trim()).filter(rt => rt);
  }
  next();
};

// Create client
router.post('/clients', oidcAuth.requireOidcAuth('admin'), preprocessClientData, validationRules.createClient, handleValidationErrors, async (req, res) => {
  try {
    const { name, description, redirectUris, scopes, grantTypes, responseTypes, confidential } = req.body;
    
    if (!name || !redirectUris) {
      return res.render('client-form', addUserContext(req, {
        title: 'Add Client',
        isClients: true,
        message: 'Name and redirect URIs are required',
        messageType: 'danger',
        client: req.body
      }));
    }
    
    // Create client
    const client = new Client({
      name,
      description,
      redirectUris,
      scopes: scopes && scopes.length ? scopes : ['openid', 'profile', 'email'],
      grantTypes: grantTypes && grantTypes.length ? grantTypes : ['authorization_code', 'refresh_token'],
      responseTypes: responseTypes && responseTypes.length ? responseTypes : ['code'],
      confidential: confidential === 'on'
    });
    
    await client.save();
    
    // Log activity
    await Activity.logActivity('client_created', {
      targetUsername: client.name,
      targetUserId: client._id,
      adminUserId: req.oidc_user?.sub,
      adminUsername: req.oidc_user?.username,
      ip: getClientIp(req),
      userAgent: req.headers['user-agent']
    });
    
    res.redirect('/admin/clients?message=Client created successfully&messageType=success');
  } catch (error) {
    console.error('Create client error:', error);
    res.render('client-form', addUserContext(req, {
      title: 'Add Client',
      isClients: true,
      message: 'Error creating client: ' + error.message,
      messageType: 'danger',
      client: req.body
    }));
  }
});

// Edit client form
router.get('/clients/:id/edit', oidcAuth.requireOidcAuth('admin'), async (req, res) => {
  try {
    const clientId = decodeURIComponent(req.params.id);
    const client = await Client.findById(clientId);
    if (!client) {
      return res.redirect('/admin/clients?message=Client not found&messageType=danger');
    }

    res.render('client-form', addUserContext(req, {
      title: 'Edit Client',
      isClients: true,
      client: client.toPublicJSON(),
      clientSecret: client.clientSecret
    }));
  } catch (error) {
    console.error('Edit client error:', error);
    res.redirect('/admin/clients?message=Error loading client: ' + error.message + '&messageType=danger');
  }
});

// Update client
router.put('/clients/:id', oidcAuth.requireOidcAuth('admin'), preprocessClientData, async (req, res) => {
  try {
    const clientId = decodeURIComponent(req.params.id);
    const client = await Client.findById(clientId);
    if (!client) {
      return res.redirect('/admin/clients?message=Client not found&messageType=danger');
    }

    const { name, description, redirectUris, scopes, grantTypes, responseTypes, confidential, enabled } = req.body;
    
    if (!name || !redirectUris) {
      return res.render('client-form', addUserContext(req, {
        title: 'Edit Client',
        isClients: true,
        client: client.toPublicJSON(),
        clientSecret: client.clientSecret,
        message: 'Name and redirect URIs are required',
        messageType: 'danger'
      }));
    }
    
    // Update client
    client.name = name;
    client.description = description;
    client.redirectUris = redirectUris;
    client.scopes = scopes && scopes.length ? scopes : ['openid', 'profile', 'email'];
    client.grantTypes = grantTypes && grantTypes.length ? grantTypes : ['authorization_code', 'refresh_token'];
    client.responseTypes = responseTypes && responseTypes.length ? responseTypes : ['code'];
    client.confidential = confidential === 'on';
    client.enabled = enabled === 'on';
    
    await client.save();
    
    // Log activity
    await Activity.logActivity('client_updated', {
      targetUsername: client.name,
      targetUserId: client._id,
      adminUserId: req.oidc_user?.sub,
      adminUsername: req.oidc_user?.username,
      ip: getClientIp(req),
      userAgent: req.headers['user-agent']
    });
    
    res.redirect('/admin/clients?message=Client updated successfully&messageType=success');
  } catch (error) {
    console.error('Update client error:', error);
    const client = await Client.findById(req.params.id);
    res.render('client-form', addUserContext(req, {
      title: 'Edit Client',
      isClients: true,
      client: client ? client.toPublicJSON() : {},
      clientSecret: client ? client.clientSecret : '',
      message: 'Error updating client: ' + error.message,
      messageType: 'danger'
    }));
  }
});

// View client details
router.get('/clients/:id', oidcAuth.requireOidcAuth('admin'), async (req, res) => {
  try {
    const clientId = decodeURIComponent(req.params.id);
    const client = await Client.findById(clientId);
    if (!client) {
      return res.redirect('/admin/clients?message=Client not found&messageType=danger');
    }
    
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    
    res.render('client-details', addUserContext(req, {
      title: 'Client Details',
      isClients: true,
      client: client.toPublicJSON(),
      clientSecret: client.clientSecret, // Show full secret on details page
      baseUrl: baseUrl
    }));
  } catch (error) {
    console.error('View client error:', error);
    res.redirect('/admin/clients?message=Error loading client: ' + error.message + '&messageType=danger');
  }
});

// Conflict resolution routes
router.get('/conflicts/user/:id', oidcAuth.requireOidcAuth('admin'), async (req, res) => {
  try {
    const userId = decodeURIComponent(req.params.id);
    const db = database.getDb();
    
    // Get the document with all conflicts
    const docWithConflicts = await db.get(userId, { conflicts: true });
    
    if (!docWithConflicts._conflicts || docWithConflicts._conflicts.length === 0) {
      return res.redirect('/admin/users?message=No conflicts found for this user&messageType=info');
    }
    
    // Get current version
    const currentUser = new User(docWithConflicts);
    const currentVersion = {
      version: 'current',
      rev: docWithConflicts._rev,
      user: currentUser.toPublicJSON(),
      rawDoc: docWithConflicts
    };
    
    // Get all conflict versions
    const conflictVersions = await Promise.all(
      docWithConflicts._conflicts.map(async (conflictRev) => {
        try {
          const conflictDoc = await db.get(userId, { rev: conflictRev });
          const conflictUser = new User(conflictDoc);
          return {
            version: 'conflict',
            rev: conflictRev,
            user: conflictUser.toPublicJSON(),
            rawDoc: conflictDoc
          };
        } catch (error) {
          console.error(`Error getting conflict revision ${conflictRev}:`, error);
          return null;
        }
      })
    );
    
    // Filter out any failed conflict retrievals
    const validConflictVersions = conflictVersions.filter(v => v !== null);
    
    const allVersions = [currentVersion, ...validConflictVersions];
    
    res.render('conflict-resolution', addUserContext(req, {
      title: 'Resolve User Conflicts',
      isUsers: true,
      entityType: 'user',
      entityId: userId,
      entityName: currentUser.username,
      currentVersion,
      conflictVersions: validConflictVersions,
      allVersions
    }));
    
  } catch (error) {
    console.error('View user conflicts error:', error);
    res.redirect('/admin/users?message=Error loading user conflicts: ' + error.message + '&messageType=danger');
  }
});

router.get('/conflicts/client/:id', oidcAuth.requireOidcAuth('admin'), async (req, res) => {
  try {
    const clientId = decodeURIComponent(req.params.id);
    const db = database.getDb();
    
    // Get the document with all conflicts
    const docWithConflicts = await db.get(clientId, { conflicts: true });
    
    if (!docWithConflicts._conflicts || docWithConflicts._conflicts.length === 0) {
      return res.redirect('/admin/clients?message=No conflicts found for this client&messageType=info');
    }
    
    // Get current version
    const currentClient = new Client(docWithConflicts);
    const currentVersion = {
      version: 'current',
      rev: docWithConflicts._rev,
      client: currentClient.toPublicJSON(),
      rawDoc: docWithConflicts
    };
    
    // Get all conflict versions
    const conflictVersions = await Promise.all(
      docWithConflicts._conflicts.map(async (conflictRev) => {
        try {
          const conflictDoc = await db.get(clientId, { rev: conflictRev });
          const conflictClient = new Client(conflictDoc);
          return {
            version: 'conflict',
            rev: conflictRev,
            client: conflictClient.toPublicJSON(),
            rawDoc: conflictDoc
          };
        } catch (error) {
          console.error(`Error getting conflict revision ${conflictRev}:`, error);
          return null;
        }
      })
    );
    
    // Filter out any failed conflict retrievals
    const validConflictVersions = conflictVersions.filter(v => v !== null);
    
    const allVersions = [currentVersion, ...validConflictVersions];
    
    res.render('conflict-resolution', addUserContext(req, {
      title: 'Resolve Client Conflicts',
      isClients: true,
      entityType: 'client',
      entityId: clientId,
      entityName: currentClient.name || currentClient.client_id,
      currentVersion,
      conflictVersions: validConflictVersions,
      allVersions
    }));
    
  } catch (error) {
    console.error('View client conflicts error:', error);
    res.redirect('/admin/clients?message=Error loading client conflicts: ' + error.message + '&messageType=danger');
  }
});

router.get('/conflicts/session/:id', oidcAuth.requireOidcAuth('admin'), async (req, res) => {
  try {
    const sessionId = decodeURIComponent(req.params.id);
    const db = database.getDb();
    
    // Get the document with all conflicts
    const docWithConflicts = await db.get(sessionId, { conflicts: true });
    
    if (!docWithConflicts._conflicts || docWithConflicts._conflicts.length === 0) {
      return res.redirect('/admin/sessions?message=No conflicts found for this session&messageType=info');
    }
    
    // Get current version
    const currentSession = new Session(docWithConflicts);
    const currentUser = await User.findById(currentSession.user_id);
    const currentVersion = {
      version: 'current',
      rev: docWithConflicts._rev,
      session: {
        ...currentSession.toPublicJSON(),
        user: currentUser ? currentUser.toPublicJSON() : { username: 'Unknown', email: 'Unknown' }
      },
      rawDoc: docWithConflicts
    };
    
    // Get all conflict versions
    const conflictVersions = await Promise.all(
      docWithConflicts._conflicts.map(async (conflictRev) => {
        try {
          const conflictDoc = await db.get(sessionId, { rev: conflictRev });
          const conflictSession = new Session(conflictDoc);
          const conflictUser = await User.findById(conflictSession.user_id);
          return {
            version: 'conflict',
            rev: conflictRev,
            session: {
              ...conflictSession.toPublicJSON(),
              user: conflictUser ? conflictUser.toPublicJSON() : { username: 'Unknown', email: 'Unknown' }
            },
            rawDoc: conflictDoc
          };
        } catch (error) {
          console.error(`Error getting conflict revision ${conflictRev}:`, error);
          return null;
        }
      })
    );
    
    // Filter out any failed conflict retrievals
    const validConflictVersions = conflictVersions.filter(v => v !== null);
    
    const allVersions = [currentVersion, ...validConflictVersions];
    
    res.render('conflict-resolution', addUserContext(req, {
      title: 'Resolve Session Conflicts',
      isSessions: true,
      entityType: 'session',
      entityId: sessionId,
      entityName: `${currentVersion.session.user.username} - ${currentVersion.session.client_id}`,
      currentVersion,
      conflictVersions: validConflictVersions,
      allVersions
    }));
    
  } catch (error) {
    console.error('View session conflicts error:', error);
    res.redirect('/admin/sessions?message=Error loading session conflicts: ' + error.message + '&messageType=danger');
  }
});

// Conflict resolution POST route
router.post('/conflicts/:entityType/:id/resolve', oidcAuth.requireOidcAuth('admin'), async (req, res) => {
  try {
    const entityType = req.params.entityType;
    const entityId = decodeURIComponent(req.params.id);
    const { selectedRevision, mergeStrategy } = req.body;
    
    const db = database.getDb();
    
    if (mergeStrategy === 'keepVersion' && selectedRevision) {
      // Get the current document with all conflicts first
      const currentDocWithConflicts = await db.get(entityId, { conflicts: true });
      
      if (!currentDocWithConflicts._conflicts || currentDocWithConflicts._conflicts.length === 0) {
        throw new Error('No conflicts found to resolve');
      }
      
      console.log(`Resolving conflict for ${entityType} ${entityId} - keeping revision ${selectedRevision}`);
      console.log(`Current conflicts:`, currentDocWithConflicts._conflicts);
      
      // Get the version we want to keep
      let resolvedDoc;
      if (selectedRevision === 'current') {
        // Use the current winning version
        resolvedDoc = { ...currentDocWithConflicts };
        delete resolvedDoc._conflicts; // Remove conflicts field before saving
      } else {
        // Get the specific revision we want to keep
        resolvedDoc = await db.get(entityId, { rev: selectedRevision });
        // We need to base our new revision on the current winning revision
        resolvedDoc._rev = currentDocWithConflicts._rev;
      }
      
      // Update instance metadata to mark as resolved and create a new revision
      resolvedDoc.instance_metadata = {
        ...resolvedDoc.instance_metadata,
        last_modified_by: process.env.INSTANCE_ID || 'conflict-resolver',
        last_modified_at: new Date().toISOString(),
        version: (resolvedDoc.instance_metadata?.version || 1) + 1
      };
      
      // Add a resolution marker to help track this was manually resolved
      resolvedDoc.conflictResolution = {
        resolvedAt: new Date().toISOString(),
        resolvedBy: process.env.INSTANCE_ID || 'conflict-resolver',
        selectedRevision: selectedRevision,
        resolvedConflicts: currentDocWithConflicts._conflicts
      };
      
      console.log(`Creating new revision from current _rev:`, resolvedDoc._rev);
      
      // Save the resolved document - this creates a new revision that should win
      const saveResult = await db.insert(resolvedDoc);
      console.log(`Saved resolved document with new revision:`, saveResult.rev);
      
      // The key insight: We need to delete the conflicting revisions to truly resolve the conflict
      console.log(`Deleting ${currentDocWithConflicts._conflicts.length} conflicting revisions...`);
      
      for (const conflictRev of currentDocWithConflicts._conflicts) {
        try {
          console.log(`Deleting conflict revision ${conflictRev}`);
          await db.destroy(entityId, conflictRev);
          console.log(`Successfully deleted conflict revision ${conflictRev}`);
        } catch (deleteError) {
          console.error(`Error deleting conflict revision ${conflictRev}:`, deleteError.message);
          // Continue with other deletions even if one fails
        }
      }
      
      // Verify conflict resolution
      try {
        const verifyDoc = await db.get(entityId, { conflicts: true });
        if (verifyDoc._conflicts && verifyDoc._conflicts.length > 0) {
          console.log(`WARNING: Conflicts still exist after resolution:`, verifyDoc._conflicts);
        } else {
          console.log(`SUCCESS: Conflict resolved, no more conflicts detected`);
        }
      } catch (verifyError) {
        console.error('Error verifying conflict resolution:', verifyError);
      }
      
      // Get redirect path
      const redirectPath = entityType === 'user' ? '/admin/users' :
                          entityType === 'client' ? '/admin/clients' : '/admin/sessions';
      
      res.redirect(`${redirectPath}?message=Conflict resolved successfully&messageType=success`);
    } else {
      throw new Error('Invalid resolution strategy');
    }
    
  } catch (error) {
    console.error('Resolve conflict error:', error);
    const entityType = req.params.entityType;
    const redirectPath = entityType === 'user' ? '/admin/users' : 
                        entityType === 'client' ? '/admin/clients' : '/admin/sessions';
    res.redirect(`${redirectPath}?message=Error resolving conflict: ${error.message}&messageType=danger`);
  }
});


module.exports = router;