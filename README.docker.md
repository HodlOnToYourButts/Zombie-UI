# Docker Development Guide

This guide explains how to run Zombie UI using Docker Compose for development and testing.

> **Note**: This setup assumes you have Zombie and CouchDB already running separately. For production deployments, use Podman quadlets instead of docker-compose.

## Prerequisites

- Docker
- Docker Compose
- Zombie server running on localhost:8080
- CouchDB running on localhost:5984 (with zombie database)

## Quick Start

1. **Clone and setup environment**:
   ```bash
   git clone <your-repo-url>
   cd Zombie-UI
   cp .env.docker .env
   ```

2. **Configure OIDC settings**:
   Edit `.env` and update the OIDC configuration:
   ```bash
   # Required: Update these based on your OIDC provider
   OIDC_ISSUER=https://your-oidc-provider.com
   OIDC_AUTHORIZATION_ENDPOINT=https://your-oidc-provider.com/auth
   OIDC_TOKEN_ENDPOINT=https://your-oidc-provider.com/token
   OIDC_USERINFO_ENDPOINT=https://your-oidc-provider.com/userinfo
   OIDC_END_SESSION_ENDPOINT=https://your-oidc-provider.com/logout

   # Required: Update client credentials
   CLIENT_ID=your-client-id
   CLIENT_SECRET=your-client-secret

   # Required: Generate a secure session secret
   SESSION_SECRET=your-secure-session-secret
   ```

3. **Start the services**:
   ```bash
   docker-compose up -d
   ```

4. **Access the application**:
   - Zombie UI: http://localhost:18080
   - Zombie Server: http://localhost:8080 (external)
   - CouchDB Admin: http://localhost:5984/_utils (external)

## Services

### Zombie UI
- **Container**: `zombie-ui`
- **Internal Port**: 8080
- **Published Port**: 18080
- **Health check**: http://localhost:18080/health
- **Network**: Uses external `zombie` network

## Development Features

This docker-compose.yml is configured for development with:
- Source code mounted as volumes (live reload)
- Test endpoints enabled (`/test/*` routes)
- Development environment variables
- CouchDB admin interface exposed for debugging

## Production Deployment

For production deployments, use Podman quadlets which provide:
- Systemd integration
- Automatic restarts
- Better security isolation
- Resource management
- Proper service dependencies

The Docker Compose setup here is purely for development and local testing.

## Useful Commands

```bash
# Start services
docker-compose up -d

# View logs
docker-compose logs -f zombie-ui
docker-compose logs -f couchdb

# Stop services
docker-compose down

# Rebuild application
docker-compose build zombie-ui
docker-compose up -d zombie-ui

# Access CouchDB directly
curl http://admin:password@localhost:5984/_all_dbs

# Check application health
curl http://localhost:8080/health
```

## Troubleshooting

### Application won't start
- Check if CouchDB is healthy: `docker-compose ps`
- Check application logs: `docker-compose logs zombie-ui`
- Verify environment variables in `.env`

### OIDC Authentication issues
- Verify OIDC provider URLs are accessible
- Check client ID/secret configuration
- Ensure redirect URI matches what's configured in OIDC provider

### Database connection issues
- Verify CouchDB is running: `curl http://admin:password@localhost:5984/_up`
- Check network connectivity between containers
- Review database initialization logs

## Data Persistence

- **CouchDB data**: Stored in Docker volume `zombie_ui_couchdb_data`
- **CouchDB config**: Stored in Docker volume `zombie_ui_couchdb_config`

To backup data:
```bash
docker run --rm -v zombie-ui_zombie_ui_couchdb_data:/data -v $(pwd):/backup alpine tar czf /backup/couchdb-backup.tar.gz /data
```

To restore data:
```bash
docker run --rm -v zombie-ui_zombie_ui_couchdb_data:/data -v $(pwd):/backup alpine tar xzf /backup/couchdb-backup.tar.gz -C /
```