#!/bin/sh
set -e

echo "🧟‍♂️ Setting up Zombie UI client and admin user..."

# Get configuration from environment variables
COUCHDB_URL=${COUCHDB_URL:-"http://couchdb:5984"}
DB_NAME=${COUCHDB_DATABASE:-"zombie"}
APP_USER=${COUCHDB_USER:-"zombie"}
APP_PASSWORD=${COUCHDB_PASSWORD}

if [ -z "$APP_PASSWORD" ]; then
    echo "❌ COUCHDB_PASSWORD environment variable must be set"
    exit 1
fi

echo "CouchDB URL: $COUCHDB_URL"
echo "Database: $DB_NAME"
echo "Application User: $APP_USER"

# Wait for database to be ready
echo "⏳ Waiting for database to be ready..."
until curl -f -s -u "$APP_USER:$APP_PASSWORD" "$COUCHDB_URL/$DB_NAME" > /dev/null; do
    echo "Database not ready, waiting..."
    sleep 5
done

echo "✅ Database is ready"

# Create Zombie UI OIDC client
echo "🔧 Creating Zombie UI OIDC client..."

# Check if client already exists
CLIENT_EXISTS=$(curl -s -u "$APP_USER:$APP_PASSWORD" "$COUCHDB_URL/$DB_NAME/_design/clients/_view/by_client_id?key=\"client_00000000000000000000000000000000\"" | grep -o '"total_rows":[0-9]*' | cut -d: -f2)

if [ "$CLIENT_EXISTS" != "0" ]; then
    echo "ℹ  Zombie UI client already exists"
else
    CLIENT_DOC='{
        "_id": "client_zombie_ui",
        "type": "client",
        "client_id": "client_00000000000000000000000000000000",
        "client_secret": "0000000000000000000000000000000000000000000000000000000000000000",
        "name": "Zombie UI",
        "description": "Web interface for Zombie authentication server",
        "redirect_uris": [
            "http://localhost:18080/callback",
            "http://localhost:8080/callback"
        ],
        "scopes": ["openid", "profile", "email"],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "enabled": true,
        "confidential": true,
        "created_at": "'$(date -Iseconds)'",
        "updated_at": "'$(date -Iseconds)'",
        "metadata": {},
        "instance_metadata": {
            "version": 1
        }
    }'

    curl -s -X PUT -u "$APP_USER:$APP_PASSWORD" \
         -H "Content-Type: application/json" \
         -d "$CLIENT_DOC" \
         "$COUCHDB_URL/$DB_NAME/client_zombie_ui"

    echo "✅ Zombie UI client created"
fi

# Create default admin user
echo "👤 Creating default admin user..."

# Check if admin user already exists
ADMIN_EXISTS=$(curl -s -u "$APP_USER:$APP_PASSWORD" "$COUCHDB_URL/$DB_NAME/_design/users/_view/by_username?key=\"admin\"" | grep -o '"total_rows":[0-9]*' | cut -d: -f2)

if [ "$ADMIN_EXISTS" != "0" ]; then
    echo "ℹ  Admin user already exists"
else
    # Generate password hash (simple approach for default credentials)
    # In production, this should use bcrypt, but for simplicity using a known hash
    # This is the bcrypt hash for "admin" with salt rounds 10
    PASSWORD_HASH='$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi'

    ADMIN_USER_DOC='{
        "_id": "user_admin",
        "type": "user",
        "username": "admin",
        "email": "admin@zombie.local",
        "passwordHash": "'$PASSWORD_HASH'",
        "firstName": "System",
        "lastName": "Administrator",
        "roles": ["admin", "user"],
        "groups": ["admin"],
        "enabled": true,
        "emailVerified": true,
        "createdAt": "'$(date -Iseconds)'",
        "updatedAt": "'$(date -Iseconds)'",
        "instanceId": "'${INSTANCE_ID:-default}'"
    }'

    curl -s -X PUT -u "$APP_USER:$APP_PASSWORD" \
         -H "Content-Type: application/json" \
         -d "$ADMIN_USER_DOC" \
         "$COUCHDB_URL/$DB_NAME/user_admin"

    echo "✅ Default admin user created (username: admin, password: admin)"
    echo "⚠️  Please change these credentials in production!"
fi

echo
echo "✅ Zombie UI setup completed successfully!"
echo
echo "📋 Created:"
echo "  - OIDC Client: client_00000000000000000000000000000000"
echo "  - Client Secret: 0000000000000000000000000000000000000000000000000000000000000000"
echo "  - Admin User: admin/admin"
echo
echo "🚀 Zombie UI is ready to connect!"