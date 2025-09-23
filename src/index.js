require('dotenv').config();

// CRITICAL: Validate security configuration before starting
const { validateSecurityConfiguration } = require('./config/security-validation');
validateSecurityConfiguration();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const session = require('express-session');
const methodOverride = require('method-override');
const { engine } = require('express-handlebars');
const path = require('path');
const rateLimit = require('express-rate-limit');
const slowDown = require('express-slow-down');
const { sanitizeInput } = require('./middleware/validation');
const csrf = require('csurf');

const database = require('./database');
const adminRoutes = require('./routes/admin');
const adminApiRoutes = require('./routes/admin-api');
const userRoutes = require('./routes/user');
const sessionManager = require('./utils/session-manager');

const app = express();
const PORT = process.env.ADMIN_PORT || process.env.PORT || 8080;

// Track server startup time for uptime calculation
const SERVER_START_TIME = Date.now();

// Helper function to format uptime in human readable format
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
  
  return parts.join(' ');
}

// Trust proxy headers to get real client IP in containerized environments  
// In development, be more specific about proxy trust to avoid rate limiter warnings
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', true);
} else {
  app.set('trust proxy', ['127.0.0.1', '::1']); // Trust localhost only in development
}

// View engine setup with dynamic layout support
app.engine('html', engine({
  extname: '.html',
  defaultLayout: false, // We'll set layout dynamically
  layoutsDir: path.join(__dirname, 'views'),
  partialsDir: path.join(__dirname, 'views/partials'),
  helpers: {
    formatDate: (date) => {
      return new Date(date).toLocaleString();
    },
    join: (array, separator) => {
      return Array.isArray(array) ? array.join(separator || ', ') : '';
    },
    encodeURIComponent: (str) => {
      return encodeURIComponent(str || '');
    },
    eq: (a, b) => {
      return a === b;
    },
    not: (value) => {
      return !value;
    }
  }
}));
app.set('view engine', 'html');
app.set('views', path.join(__dirname, 'views'));

// Middleware - Configured for HTTP over yggdrasil
app.use(helmet({
  contentSecurityPolicy: false // Disable CSP to prevent HTTPS upgrade issues over yggdrasil
}));

// Rate limiting configuration
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per windowMs for auth endpoints
  message: { error: 'Too many authentication attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes  
  max: 100, // Limit each IP to 100 requests per windowMs for general endpoints
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const speedLimiter = slowDown({
  windowMs: 15 * 60 * 1000, // 15 minutes
  delayAfter: 2, // Allow 2 requests per windowMs without delay
  delayMs: 500, // Add 500ms delay per request after delayAfter
  maxDelayMs: 20000, // Maximum delay of 20 seconds
});

// CORS configuration - restrict origins in production
const corsOptions = {
  origin: process.env.NODE_ENV === 'production' 
    ? process.env.ALLOWED_ORIGINS?.split(',') || false
    : true, // Allow all origins in development
  credentials: true,
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' })); // Limit payload size
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(sanitizeInput); // Sanitize all inputs
app.use(methodOverride(function (req, _res) {
  if (req.body && typeof req.body === 'object' && '_method' in req.body) {
    // Look in urlencoded POST bodies and delete it
    const method = req.body._method;
    delete req.body._method;
    return method;
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

// Session configuration
const sessionStore = new session.MemoryStore();
sessionManager.setSessionStore(sessionStore);

app.use(session({
  name: `zombie-admin-session-${process.env.INSTANCE_ID || 'default'}`,
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true, // Changed to true to ensure session is created
  store: sessionStore,
  cookie: {
    secure: false, // Set to false for development/HTTP
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'lax' // Allow cross-site cookies for OIDC flow
  }
}));

// OIDC routes (must be before CSRF protection to avoid interference)
const oidcAuth = require('./middleware/oidc-auth');

// OIDC authentication route (triggers login)
app.get('/auth', (req, res) => {
  oidcAuth.redirectToLogin(req, res);
});

// OIDC callback route (must be at root level for proper redirect URI)
app.get('/callback', async (req, res) => {
  console.log('🎯 CALLBACK ROUTE: Hit /callback route');
  await oidcAuth.handleCallback(req, res);
});

// OIDC logout route (also at root level)
app.get('/logout', (req, res) => {
  oidcAuth.handleLogout(req, res);
});

console.log('✅ OIDC routes registered: /auth, /callback, /logout');

// CSRF protection for form endpoints
const csrfProtection = csrf({
  cookie: false, // Use session storage
  ignoreMethods: ['GET', 'HEAD', 'OPTIONS']
});

// Apply CSRF protection to all routes (except OIDC routes above)
app.use(csrfProtection);

// Add CSRF token to templates
app.use((req, res, next) => {
  res.locals.csrfToken = req.csrfToken();
  next();
});

// Add OIDC user to all templates and set layout (must be after session middleware)
app.use((req, res, next) => {
  console.log('Session middleware - path:', req.path);
  console.log('- Session ID:', req.sessionID);
  console.log('- Session exists:', !!req.session);
  console.log('- Session keys:', req.session ? Object.keys(req.session) : 'none');
  console.log('- Cookies:', req.headers.cookie || 'none');
  console.log('- OIDC user exists:', !!req.session?.oidc_user);

  req.oidc_user = req.session?.oidc_user || null;
  res.locals.oidc_user = req.oidc_user;

  // Set layout based on route
  if (req.path.startsWith('/admin')) {
    res.locals.layout = 'layout'; // Admin layout
  } else {
    res.locals.layout = 'user-layout'; // User layout (default)
  }

  next();
});

// Root route is handled by admin routes with OIDC authentication

// Health check endpoint
app.get('/health', async (req, res) => {
  const dbStatus = await database.testConnection();
  const uptimeMs = Date.now() - SERVER_START_TIME;
  const uptimeSeconds = Math.floor(uptimeMs / 1000);
  
  res.json({ 
    status: dbStatus.connected ? 'ok' : 'degraded', 
    service: 'ZombieAuth Admin',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    uptime: {
      ms: uptimeMs,
      seconds: uptimeSeconds,
      human: formatUptime(uptimeSeconds)
    },
    database: dbStatus
  });
});

// Test endpoints for development and testing (disabled in production)
if (process.env.DEVELOPMENT_MODE === 'true' || process.env.ENABLE_TEST_ENDPOINTS === 'true') {
  const modeType = process.env.DEVELOPMENT_MODE === 'true' ? 'DEVELOPMENT_MODE' : 'ENABLE_TEST_ENDPOINTS (legacy)';
  console.log(`WARNING: Test endpoints enabled via ${modeType} - disable in production`);
  
  // Test endpoint for conflict statistics
  app.get('/test/conflicts/stats', async (req, res) => {
    try {
      const ConflictDetector = require('./services/conflict-detector');
      const conflictDetector = new ConflictDetector();
      await conflictDetector.initialize();
      const conflicts = await conflictDetector.getAllConflicts();
      const stats = {
        total: conflicts.length,
        requiresManualResolution: conflicts.filter(c => c.requiresManualResolution).length
      };
      res.json({ stats });
    } catch (error) {
      console.error('Test conflict stats error:', error);
      res.json({ stats: { total: 0, requiresManualResolution: 0 } });
    }
  });

  // Test endpoint for replication status
  app.get('/test/replication/status', async (req, res) => {
    try {
      const replicationStatus = await database.getReplicationStatus();
      res.json({ replication: replicationStatus });
    } catch (error) {
      console.error('Test replication status error:', error);
      res.json({ replication: [] });
    }
  });

  // Test endpoint for conflict details
  app.get('/test/conflicts/users', async (req, res) => {
    try {
      const ConflictDetector = require('./services/conflict-detector');
      const conflictDetector = new ConflictDetector();
      await conflictDetector.initialize();
      const conflicts = await conflictDetector.getUserConflicts();
      res.json({ conflicts });
    } catch (error) {
      console.error('Test user conflicts error:', error);
      res.json({ conflicts: [] });
    }
  });

  // Test endpoint for all conflicts
  app.get('/test/conflicts', async (req, res) => {
    try {
      const ConflictDetector = require('./services/conflict-detector');
      const conflictDetector = new ConflictDetector();
      await conflictDetector.initialize();
      const conflicts = await conflictDetector.getAllConflicts();
      res.json({ conflicts });
    } catch (error) {
      console.error('Test all conflicts error:', error);
      res.json({ conflicts: [] });
    }
  });
}

// Apply rate limiting only in production
if (process.env.NODE_ENV === 'production') {
  app.use('/login', authLimiter, speedLimiter);
  app.use('/api', generalLimiter);
  console.log('🔒 Rate limiting enabled for production');
} else {
  console.log('⚠️  Rate limiting disabled for development');
}


// Routes
app.use('/api', adminApiRoutes);
app.use('/admin', adminRoutes);
app.use('/', userRoutes);

// Initialize database and start server
async function startAdminServer() {
  try {
    console.log('Initializing database connection...');
    await database.initialize();
    
    app.listen(PORT, () => {
      console.log(`ZombieAuth Admin server running on port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
    });
  } catch (error) {
    console.error('Failed to start admin server:', error.message);
    process.exit(1);
  }
}

startAdminServer();