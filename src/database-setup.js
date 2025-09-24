const bcrypt = require('bcryptjs');
const crypto = require('crypto');

class DatabaseSetup {
  constructor(database) {
    this.db = database.getDb();
    this.instanceId = database.instanceId;
  }

  async ensureZombieUIClientExists() {
    console.log('🔍 Checking for Zombie UI OIDC client...');

    try {
      // Check if client already exists
      const result = await this.db.view('clients', 'by_client_id', {
        key: 'client_00000000000000000000000000000000',
        include_docs: true
      });

      if (result.rows.length > 0) {
        console.log('🔧 Zombie UI OIDC client already exists');
        return;
      }

      console.log('🔧 Creating Zombie UI OIDC client...');

      const clientDoc = {
        _id: `client_zombie_ui`,
        type: 'client',
        client_id: 'client_00000000000000000000000000000000',
        client_secret: '0000000000000000000000000000000000000000000000000000000000000000',
        name: 'Zombie UI',
        description: 'Web interface for Zombie authentication server',
        redirect_uris: [
          'http://localhost:18080/callback',
          'http://localhost:8080/callback'
        ],
        scopes: ['openid', 'profile', 'email'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        enabled: true,
        confidential: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: {},
        instance_metadata: {
          last_modified_by: this.instanceId,
          last_modified_at: new Date().toISOString(),
          version: 1
        }
      };

      await this.db.insert(clientDoc);
      console.log('✅ Zombie UI OIDC client created');

    } catch (error) {
      console.error('❌ Failed to create Zombie UI client:', error.message);
      // Don't throw - this is a convenience feature, not critical
    }
  }

  async ensureAdminUserExists() {
    console.log('🔍 Checking for admin user...');

    try {
      // Check if admin user already exists
      const result = await this.db.view('users', 'by_username', {
        key: 'admin',
        include_docs: true
      });

      if (result.rows.length > 0) {
        console.log('👤 Admin user already exists');
        return;
      }

      console.log('👤 Creating admin user (admin/admin)...');

      const passwordHash = await bcrypt.hash('admin', 12);

      const adminUser = {
        _id: `user_${crypto.randomBytes(12).toString('hex')}`,
        type: 'user',
        username: 'admin',
        email: 'admin@zombie.local',
        password_hash: passwordHash,
        first_name: 'System',
        last_name: 'Administrator',
        groups: ['admin'],
        roles: ['admin', 'user'],
        enabled: true,
        email_verified: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        instance_metadata: {
          last_modified_by: this.instanceId,
          last_modified_at: new Date().toISOString(),
          version: 1
        }
      };

      await this.db.insert(adminUser);
      console.log('✅ Admin user created (username: admin, password: admin)');
      console.log('⚠️  Remember to change these credentials in production!');

    } catch (error) {
      console.error('❌ Failed to create admin user:', error.message);
      // Don't throw - this is a convenience feature, not critical
    }
  }

  async runSetup() {
    console.log('🔧 Running Zombie UI database setup...');

    await this.ensureZombieUIClientExists();
    await this.ensureAdminUserExists();

    console.log('✅ Zombie UI database setup complete');
  }
}

module.exports = DatabaseSetup;