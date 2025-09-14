const nano = require('nano');

class Database {
  constructor() {
    const username = process.env.COUCHDB_USER || 'zombieauth';
    const password = process.env.COUCHDB_PASSWORD;
    const host = process.env.COUCHDB_HOST || 'localhost';
    const port = process.env.COUCHDB_PORT || '5984';
    
    if (!password) {
      console.error('COUCHDB_PASSWORD environment variable is required');
      process.exit(1);
    }
    
    // CouchDB URL for this instance
    const couchUrl = `http://${host}:${port}`;
    this.couchUrl = couchUrl.replace('://', `://${username}:${password}@`);
    
    this.dbName = process.env.COUCHDB_DATABASE || 'zombieauth';
    this.instanceId = process.env.INSTANCE_ID || 'default';
    
    // Use CouchDB for main operations
    this.client = nano(this.couchUrl);
    this.db = null;
  }

  async initialize() {
    try {
      // Wait for CouchDB to be ready
      await this.waitForCouchDB();
      
      // Connect to existing database
      this.db = this.client.db.use(this.dbName);
      await this.db.info(); // Test if database exists and is accessible
      
      console.log(`Connected to CouchDB database: ${this.dbName} (Instance: ${this.instanceId})`);
      return true;
    } catch (error) {
      if (error.statusCode === 404) {
        console.error(`Database '${this.dbName}' not found. Please run the setup script first: scripts/setup-couchdb.sh`);
      } else {
        console.error('Failed to initialize database:', error.message);
      }
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