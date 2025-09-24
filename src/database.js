const nano = require('nano');

class Database {
  constructor() {
    const username = process.env.COUCHDB_USER || 'zombie';
    const password = process.env.COUCHDB_PASSWORD;

    if (!password) {
      console.error('COUCHDB_PASSWORD environment variable is required');
      process.exit(1);
    }

    // CouchDB URL for this instance - support both COUCHDB_URL and legacy COUCHDB_HOST/PORT
    let couchUrl;
    if (process.env.COUCHDB_URL) {
      couchUrl = process.env.COUCHDB_URL;
    } else {
      const host = process.env.COUCHDB_HOST || 'localhost';
      const port = process.env.COUCHDB_PORT || '5984';
      couchUrl = `http://${host}:${port}`;
    }

    this.couchUrl = couchUrl.replace('://', `://${username}:${password}@`);
    
    this.dbName = process.env.COUCHDB_DATABASE || 'zombie';
    this.instanceId = process.env.INSTANCE_ID || 'default';
    
    // Use CouchDB for main operations
    this.client = nano(this.couchUrl);
    this.db = null;
  }

  async initialize() {
    try {
      // Wait for CouchDB to be ready
      await this.waitForCouchDB();

      // Try to connect to existing database
      this.db = this.client.db.use(this.dbName);

      try {
        await this.db.info(); // Test if database exists and is accessible
        console.log(`Connected to existing CouchDB database: ${this.dbName} (Instance: ${this.instanceId})`);
      } catch (error) {
        if (error.statusCode === 404) {
          console.log(`Database '${this.dbName}' not found. Creating database and setting up views...`);
          await this.setupDatabase();
        } else {
          throw error;
        }
      }

      // Ensure views exist (in case database existed but views didn't)
      await this.ensureViewsExist();

      // Run database setup for Zombie UI
      const DatabaseSetup = require('./database-setup');
      const setup = new DatabaseSetup(this);
      await setup.runSetup();

      console.log(`✅ Database initialization complete: ${this.dbName}`);
      return true;
    } catch (error) {
      console.error('Failed to initialize database:', error.message);
      throw error;
    }
  }

  async setupDatabase() {
    try {
      console.log(`Creating database: ${this.dbName}`);
      await this.client.db.create(this.dbName);

      // Refresh the database connection
      this.db = this.client.db.use(this.dbName);

      console.log('✅ Database created successfully');
    } catch (error) {
      if (error.statusCode === 412) {
        console.log('Database already exists, continuing...');
        this.db = this.client.db.use(this.dbName);
      } else {
        throw error;
      }
    }
  }

  async ensureViewsExist() {
    console.log('🔍 Ensuring CouchDB views exist...');

    const views = {
      users: {
        by_email: 'function(doc) { if (doc.type === "user" && doc.email) { emit(doc.email, doc); } }',
        by_username: 'function(doc) { if (doc.type === "user" && doc.username) { emit(doc.username, doc); } }'
      },
      sessions: {
        by_user_id: 'function(doc) { if (doc.type === "session" && doc.userId) { emit(doc.userId, doc); } }',
        by_auth_code: 'function(doc) { if (doc.type === "session" && doc.authorizationCode) { emit(doc.authorizationCode, doc); } }',
        active_sessions: 'function(doc) { if (doc.type === "session" && doc.active) { emit(doc.userId, doc); } }'
      },
      activities: {
        by_timestamp: 'function(doc) { if (doc.type === "activity" && doc.timestamp) { emit(doc.timestamp, doc); } }',
        by_target_user: 'function(doc) { if (doc.type === "activity" && doc.targetUserId) { emit(doc.targetUserId, doc); } }'
      },
      clients: {
        by_client_id: 'function(doc) { if (doc.type === "client" && doc.clientId) { emit(doc.clientId, doc); } }',
        by_name: 'function(doc) { if (doc.type === "client" && doc.name) { emit(doc.name, doc); } }',
        enabled_clients: 'function(doc) { if (doc.type === "client" && doc.enabled) { emit(doc.name, doc); } }'
      }
    };

    for (const [designName, viewFunctions] of Object.entries(views)) {
      await this.createDesignDoc(designName, viewFunctions);
    }

    console.log('✅ All views are available');
  }

  async createDesignDoc(designName, viewFunctions) {
    const designDocId = `_design/${designName}`;

    try {
      // Check if design document already exists
      await this.db.get(designDocId);
      console.log(`📊 View already exists: ${designName}`);
      return;
    } catch (error) {
      if (error.statusCode !== 404) {
        throw error;
      }
    }

    // Create the design document
    const designDoc = {
      _id: designDocId,
      views: {}
    };

    for (const [viewName, mapFunction] of Object.entries(viewFunctions)) {
      designDoc.views[viewName] = { map: mapFunction };
    }

    try {
      await this.db.insert(designDoc);
      console.log(`✅ Created view: ${designName}`);
    } catch (error) {
      console.error(`❌ Failed to create view ${designName}:`, error.message);
      throw error;
    }
  }


  async waitForCouchDB() {
    const maxRetries = 30;
    let retries = 0;
    
    while (retries < maxRetries) {
      try {
        // Test connection by checking if we can access the server info
        await this.client.info();
        console.log('CouchDB connection established with authentication');
        return;
      } catch (error) {
        console.log(`Waiting for CouchDB... (${retries + 1}/${maxRetries}) - Error: ${error.message}`);
        
        // If it's an authentication error, try to connect without auth to see if CouchDB is up
        if (error.statusCode === 401 && retries % 5 === 0) {
          try {
            const primaryUrl = process.env.PRIMARY_COUCHDB_URL || 'http://localhost:5984';
            const noAuthClient = nano(primaryUrl);
            await noAuthClient.info();
            console.log('CouchDB is running but authentication failed - database user may not exist yet');
          } catch (noAuthError) {
            console.log('CouchDB appears to be unreachable');
          }
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        retries++;
      }
    }
    
    throw new Error('CouchDB not available after maximum retries');
  }



  async testConnection() {
    try {
      const info = await this.client.db.get(this.dbName);
      return {
        connected: true,
        database: info.db_name,
        doc_count: info.doc_count
      };
    } catch (error) {
      return {
        connected: false,
        error: error.message
      };
    }
  }




  getInstanceInfo() {
    return {
      instanceId: this.instanceId,
      couchUrl: this.couchUrl.replace(/\/\/[^@]+@/, '//***:***@') // Hide credentials
    };
  }

  getDb() {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.db;
  }
}

module.exports = new Database();