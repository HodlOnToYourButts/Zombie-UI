#!/bin/bash

# Zombie Admin CouchDB Setup Script
#
# This script sets up the CouchDB database with admin-specific components.
# Run this after the main zombie CouchDB setup but before starting zombie-admin.
#
# Prerequisites:
# - CouchDB must be running
# - zombie database must exist
# - zombie user must have admin access to zombie database
#
# Required environment variables:
# - COUCHDB_URL (optional: complete CouchDB URL, overrides HOST/PORT)
# - COUCHDB_HOST (default: localhost, ignored if COUCHDB_URL is set)
# - COUCHDB_PORT (default: 5984, ignored if COUCHDB_URL is set)
# - COUCHDB_USER (default: zombie)
# - COUCHDB_PASSWORD
# - COUCHDB_DATABASE (default: zombie)
# - ZOMBIE_ADMIN_CLIENT_ID (OIDC client ID for admin auth)
# - ZOMBIE_ADMIN_CLIENT_SECRET (OIDC client secret for admin auth)
# - ZOMBIE_ADMIN_USERNAME (admin user login)
# - ZOMBIE_ADMIN_PASSWORD (admin user password)
# - ZOMBIE_ADMIN_EMAIL (optional, defaults to username@zombie.local)

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Zombie emoji for branding
ZOMBIE="🧟"

echo -e "${BLUE}${ZOMBIE} Zombie Admin CouchDB Setup${NC}"
echo "============================================="

# Environment variables with defaults
COUCHDB_HOST="${COUCHDB_HOST:-localhost}"
COUCHDB_PORT="${COUCHDB_PORT:-5984}"
COUCHDB_USER="${COUCHDB_USER:-zombie}"
COUCHDB_PASSWORD="${COUCHDB_PASSWORD:-}"
COUCHDB_DATABASE="${COUCHDB_DATABASE:-zombie}"
ZOMBIE_ADMIN_CLIENT_ID="${ZOMBIE_ADMIN_CLIENT_ID:-}"
ZOMBIE_ADMIN_CLIENT_SECRET="${ZOMBIE_ADMIN_CLIENT_SECRET:-}"
ZOMBIE_ADMIN_USERNAME="${ZOMBIE_ADMIN_USERNAME:-}"
ZOMBIE_ADMIN_PASSWORD="${ZOMBIE_ADMIN_PASSWORD:-}"
ZOMBIE_ADMIN_EMAIL="${ZOMBIE_ADMIN_EMAIL:-${ZOMBIE_ADMIN_USERNAME}@zombie.local}"

# Construct CouchDB URL (allow override with COUCHDB_URL)
if [[ -n "$COUCHDB_URL" ]]; then
    echo "Using provided COUCHDB_URL: ${COUCHDB_URL}"
else
    COUCHDB_URL="http://${COUCHDB_HOST}:${COUCHDB_PORT}"
    echo "Constructed COUCHDB_URL from host/port: ${COUCHDB_URL}"
fi

# Validation
echo "🔍 Validating environment variables..."

if [[ -z "$COUCHDB_PASSWORD" ]]; then
    echo -e "${RED}❌ ERROR: COUCHDB_PASSWORD is required${NC}"
    exit 1
fi

if [[ -z "$ZOMBIE_ADMIN_CLIENT_ID" ]]; then
    echo -e "${RED}❌ ERROR: ZOMBIE_ADMIN_CLIENT_ID is required for admin authentication${NC}"
    echo "   Generate with: echo \"client_\$(openssl rand -hex 16)\""
    exit 1
fi

if [[ -z "$ZOMBIE_ADMIN_CLIENT_SECRET" ]]; then
    echo -e "${RED}❌ ERROR: ZOMBIE_ADMIN_CLIENT_SECRET is required for admin authentication${NC}"
    echo "   Generate with: openssl rand -base64 32"
    exit 1
fi

if [[ -z "$ZOMBIE_ADMIN_USERNAME" ]]; then
    echo -e "${RED}❌ ERROR: ZOMBIE_ADMIN_USERNAME is required${NC}"
    exit 1
fi

if [[ -z "$ZOMBIE_ADMIN_PASSWORD" ]]; then
    echo -e "${RED}❌ ERROR: ZOMBIE_ADMIN_PASSWORD is required${NC}"
    exit 1
fi

# Validate CLIENT_ID format
if [[ ! "$ZOMBIE_ADMIN_CLIENT_ID" =~ ^client_[a-f0-9]{32}$ ]]; then
    echo -e "${RED}❌ ERROR: ZOMBIE_ADMIN_CLIENT_ID must follow format 'client_<32_hex_chars>'${NC}"
    echo "   Generate with: echo \"client_\$(openssl rand -hex 16)\""
    exit 1
fi

echo -e "✅ Environment variables validated"

# Construct CouchDB URL with authentication
COUCHDB_AUTH_URL="http://${COUCHDB_USER}:${COUCHDB_PASSWORD}@${COUCHDB_HOST}:${COUCHDB_PORT}"

echo ""
echo "🔧 Configuration:"
echo "   Database: ${COUCHDB_DATABASE}"
echo "   CouchDB:  ${COUCHDB_URL}"
echo "   User:     ${COUCHDB_USER}"
echo "   Client:   ${ZOMBIE_ADMIN_CLIENT_ID}"
echo "   Admin:    ${ZOMBIE_ADMIN_USERNAME}"

# Test CouchDB connection
echo ""
echo "📡 Testing CouchDB connection..."
if ! curl -s -f "${COUCHDB_AUTH_URL}" > /dev/null; then
    echo -e "${RED}❌ ERROR: Cannot connect to CouchDB at ${COUCHDB_URL}${NC}"
    echo "   Check that CouchDB is running and credentials are correct"
    exit 1
fi
echo -e "✅ CouchDB connection successful"

# Test database access
echo ""
echo "🗄️  Checking database access..."
if ! curl -s -f "${COUCHDB_AUTH_URL}/${COUCHDB_DATABASE}" > /dev/null; then
    echo -e "${RED}❌ ERROR: Cannot access database '${COUCHDB_DATABASE}'${NC}"
    echo "   Make sure the database exists and user has admin access"
    echo "   Run the main zombie setup-couchdb.sh script first"
    exit 1
fi
echo -e "✅ Database access confirmed"

# Create admin views
echo ""
echo "📊 Creating admin CouchDB views..."

create_view() {
    local design_doc="$1"
    local view_data="$2"
    
    echo "   Creating view: ${design_doc}"
    
    # Check if view already exists
    if curl -s -f "${COUCHDB_AUTH_URL}/${COUCHDB_DATABASE}/${design_doc}" > /dev/null; then
        echo -e "   ${YELLOW}- View already exists: ${design_doc}${NC}"
        return 0
    fi
    
    # Create the view
    if curl -s -X PUT "${COUCHDB_AUTH_URL}/${COUCHDB_DATABASE}/${design_doc}" \
        -H "Content-Type: application/json" \
        -d "$view_data" | grep -q '"ok":true'; then
        echo -e "   ${GREEN}✓ Created view: ${design_doc}${NC}"
    else
        echo -e "   ${RED}❌ Failed to create view: ${design_doc}${NC}"
        return 1
    fi
}

# Users view
create_view "_design/users" '{
    "views": {
        "by_email": {
            "map": "function(doc) { if (doc.type === \"user\" && doc.email) { emit(doc.email, doc); } }"
        },
        "by_username": {
            "map": "function(doc) { if (doc.type === \"user\" && doc.username) { emit(doc.username, doc); } }"
        }
    }
}'

# Sessions view
create_view "_design/sessions" '{
    "views": {
        "by_user_id": {
            "map": "function(doc) { if (doc.type === \"session\" && doc.userId) { emit(doc.userId, doc); } }"
        },
        "by_auth_code": {
            "map": "function(doc) { if (doc.type === \"session\" && doc.authorizationCode) { emit(doc.authorizationCode, doc); } }"
        },
        "active_sessions": {
            "map": "function(doc) { if (doc.type === \"session\" && doc.active) { emit(doc.userId, doc); } }"
        }
    }
}'

# Activities view  
create_view "_design/activities" '{
    "views": {
        "by_timestamp": {
            "map": "function(doc) { if (doc.type === \"activity\" && doc.timestamp) { emit(doc.timestamp, doc); } }"
        }
    }
}'

# Clients view
create_view "_design/clients" '{
    "views": {
        "by_client_id": {
            "map": "function(doc) { if (doc.type === \"client\" && doc.clientId) { emit(doc.clientId, doc); } }"
        },
        "by_name": {
            "map": "function(doc) { if (doc.type === \"client\" && doc.name) { emit(doc.name, doc); } }"
        },
        "enabled_clients": {
            "map": "function(doc) { if (doc.type === \"client\" && doc.enabled) { emit(doc.name, doc); } }"
        }
    }
}'

# Create OIDC client
echo ""
echo "🔐 Creating OIDC client for admin authentication..."

# Check if client already exists
CLIENT_EXISTS=$(curl -s "${COUCHDB_AUTH_URL}/${COUCHDB_DATABASE}/_design/clients/_view/by_client_id?key=\"${ZOMBIE_ADMIN_CLIENT_ID}\"" | grep -o '"total_rows":[0-9]*' | cut -d: -f2)

if [[ "$CLIENT_EXISTS" -gt "0" ]]; then
    echo -e "   ${YELLOW}- OIDC client already exists: ${ZOMBIE_ADMIN_CLIENT_ID}${NC}"
else
    echo "   Creating OIDC client: ${ZOMBIE_ADMIN_CLIENT_ID}"
    
    CLIENT_DOC="{
        \"_id\": \"client_$(openssl rand -hex 12)\",
        \"type\": \"client\",
        \"clientId\": \"${ZOMBIE_ADMIN_CLIENT_ID}\",
        \"clientSecret\": \"${ZOMBIE_ADMIN_CLIENT_SECRET}\",
        \"name\": \"Zombie - Admin Interface\",
        \"description\": \"OIDC client for Zombie admin interface authentication\",
        \"redirectUris\": [
            \"http://localhost:4000/callback\",
            \"http://localhost:4001/callback\",
            \"http://localhost:4002/callback\"
        ],
        \"scopes\": [\"openid\", \"profile\", \"email\"],
        \"grantTypes\": [\"authorization_code\", \"refresh_token\"],
        \"responseTypes\": [\"code\"],
        \"confidential\": true,
        \"enabled\": true,
        \"createdAt\": \"$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)\",
        \"updatedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)\"
    }"
    
    if curl -s -X POST "${COUCHDB_AUTH_URL}/${COUCHDB_DATABASE}" \
        -H "Content-Type: application/json" \
        -d "$CLIENT_DOC" | grep -q '"ok":true'; then
        echo -e "   ${GREEN}✓ OIDC client created successfully${NC}"
    else
        echo -e "   ${RED}❌ Failed to create OIDC client${NC}"
        exit 1
    fi
fi

# Create admin user
echo ""
echo "👤 Creating admin user..."

# Check if admin user already exists
ADMIN_EXISTS=$(curl -s "${COUCHDB_AUTH_URL}/${COUCHDB_DATABASE}/_design/users/_view/by_username?key=\"${ZOMBIE_ADMIN_USERNAME}\"" | grep -o '"total_rows":[0-9]*' | cut -d: -f2)

if [[ "$ADMIN_EXISTS" -gt "0" ]]; then
    echo -e "   ${YELLOW}- Admin user already exists: ${ZOMBIE_ADMIN_USERNAME}${NC}"
else
    echo "   Creating admin user: ${ZOMBIE_ADMIN_USERNAME}"
    
    # Generate password hash using Node.js (since we need bcrypt)
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
    
    # Check if we can run node with bcrypt
    if [[ ! -d "$PROJECT_DIR/node_modules/bcrypt" ]]; then
        echo -e "   ${RED}❌ bcrypt module not found${NC}"
        echo "   Please run 'npm install' in the zombie-admin directory first"
        exit 1
    fi
    
    PASSWORD_HASH=$(cd "$PROJECT_DIR" && node -e "
        const bcrypt = require('bcrypt');
        const hash = bcrypt.hashSync('${ZOMBIE_ADMIN_PASSWORD}', 12);
        console.log(hash);
    " 2>/dev/null || echo "")
    
    if [[ -z "$PASSWORD_HASH" ]]; then
        echo -e "   ${RED}❌ Failed to generate password hash${NC}"
        exit 1
    fi
    
    ADMIN_DOC="{
        \"_id\": \"user_$(openssl rand -hex 12)\",
        \"type\": \"user\",
        \"username\": \"${ZOMBIE_ADMIN_USERNAME}\",
        \"email\": \"${ZOMBIE_ADMIN_EMAIL}\",
        \"passwordHash\": \"${PASSWORD_HASH}\",
        \"firstName\": \"System\",
        \"lastName\": \"Administrator\",
        \"groups\": [\"admin\"],
        \"roles\": [\"admin\", \"user\"],
        \"enabled\": true,
        \"emailVerified\": true,
        \"createdAt\": \"$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)\",
        \"updatedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)\"
    }"
    
    if curl -s -X POST "${COUCHDB_AUTH_URL}/${COUCHDB_DATABASE}" \
        -H "Content-Type: application/json" \
        -d "$ADMIN_DOC" | grep -q '"ok":true'; then
        echo -e "   ${GREEN}✓ Admin user created successfully${NC}"
        echo -e "   🔑 Login credentials: ${ZOMBIE_ADMIN_USERNAME}"
    else
        echo -e "   ${RED}❌ Failed to create admin user${NC}"
        exit 1
    fi
fi

echo ""
echo -e "${GREEN}${ZOMBIE} Zombie Admin CouchDB setup complete!${NC}"
echo "==============================================="
echo ""
echo "✅ Admin views created"
echo "✅ OIDC client configured"  
echo "✅ Admin user ready"
echo ""
echo "🚀 You can now start zombie-admin with these environment variables:"
echo "   COUCHDB_HOST=${COUCHDB_HOST}"
echo "   COUCHDB_PORT=${COUCHDB_PORT}"
echo "   COUCHDB_USER=${COUCHDB_USER}"
echo "   COUCHDB_PASSWORD=<your-password>"
echo "   COUCHDB_DATABASE=${COUCHDB_DATABASE}"
echo "   CLIENT_ID=${ZOMBIE_ADMIN_CLIENT_ID}"
echo "   CLIENT_SECRET=<your-client-secret>"
echo ""