# ZombieAuth Admin Interface

A web-based administration interface for managing ZombieAuth OAuth2/OpenID Connect servers and clusters.

## Overview

ZombieAuth Admin provides a comprehensive web interface for managing users, OAuth2 clients, sessions, and monitoring cluster health in ZombieAuth deployments. It's designed to work seamlessly with both single-node and multi-node CouchDB clusters.

## Features

### User Management
- **User Administration**: Create, edit, and delete users
- **Role Management**: Assign roles and permissions
- **User Activity**: Monitor user login activity and sessions
- **Bulk Operations**: Import/export users and perform bulk actions

### OAuth2 Client Management
- **Client Registration**: Register and configure OAuth2/OIDC clients
- **Client Details**: View client configurations, secrets, and redirect URIs
- **Client Statistics**: Monitor client usage and activity

### Session Management
- **Active Sessions**: View and manage active user sessions
- **Session Analytics**: Track session duration and activity patterns
- **Force Logout**: Terminate sessions remotely for security purposes

### Cluster Monitoring
- **Health Dashboard**: Real-time cluster health monitoring
- **Node Status**: Individual CouchDB node health and statistics
- **Replication Status**: Monitor database replication across cluster nodes
- **Performance Metrics**: Database performance and usage statistics

### Security Features
- **CSRF Protection**: Built-in CSRF token validation
- **Rate Limiting**: Request rate limiting to prevent abuse
- **Audit Logging**: Track administrative actions and changes
- **Secure Headers**: Comprehensive security headers via Helmet.js

## Configuration

The admin interface is configured via environment variables:

### Core Settings
- `PORT` / `ADMIN_PORT` - Admin interface port (default: 8080)
- `NODE_ENV` - Environment mode (development/production)
- `INSTANCE_ID` - Unique instance identifier for clustering
- `INSTANCE_NAME` - Human-readable instance name

### Database Connection
- `PRIMARY_COUCHDB_URL` - Primary CouchDB server URL
- `COUCHDB_USER` - CouchDB username for admin operations
- `COUCHDB_PASSWORD` - CouchDB password
- `COUCHDB_DATABASE` - ZombieAuth database name (default: zombieauth)

### Authentication
- `ADMIN_USERNAME` - Admin interface username
- `ADMIN_PASSWORD` - Admin interface password
- `JWT_SECRET` - JWT signing secret
- `SESSION_SECRET` - Session encryption secret

### Clustering (Multi-Node)
- `CLUSTER_INSTANCES` - JSON array of cluster instance configurations
- `COUCHDB_NODE_MAPPING` - Mapping of CouchDB nodes to instance names
- `CLUSTER_STATUS_URL` - Cluster status service URL

## Quick Start

### Using Docker

```bash
docker run -d \
  --name zombieauth-admin \
  -p 8080:8080 \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=your-secure-password \
  -e PRIMARY_COUCHDB_URL=http://your-couchdb:5984 \
  -e COUCHDB_USER=admin \
  -e COUCHDB_PASSWORD=couchdb-password \
  ghcr.io/hodlontoyourbutts/zombieauth-admin:latest
```

### Using Node.js

```bash
npm install
npm start
```

### Development Mode

```bash
npm install
npm run dev
```

## API Endpoints

The admin interface provides both web UI and REST API endpoints:

### Web Interface
- `GET /` - Admin dashboard
- `GET /users` - User management interface
- `GET /clients` - OAuth2 client management
- `GET /sessions` - Session management
- `GET /cluster` - Cluster monitoring (multi-node only)

### REST API
- `GET /api/users` - List users
- `POST /api/users` - Create user
- `GET /api/clients` - List OAuth2 clients
- `POST /api/clients` - Create OAuth2 client
- `GET /api/sessions` - List active sessions
- `GET /api/cluster/health` - Cluster health status

## Development

### Project Structure
```
src/
├── admin-server.js          # Main server application
├── routes/
│   ├── admin.js             # Web UI routes
│   └── admin-api.js         # REST API routes
├── views/                   # Handlebars templates
├── public/
│   ├── js/                  # Client-side JavaScript
│   └── css/                 # Stylesheets
├── middleware/              # Express middleware
├── services/                # Business logic services
├── utils/                   # Utility functions
└── config/                  # Configuration modules
```

### Building and Testing

```bash
# Install dependencies
npm install

# Run tests
npm test

# Lint code
npm run lint

# Type checking
npm run typecheck

# Build Docker image
docker build -t zombieauth-admin .
```

## Deployment

### Standalone Deployment
Deploy the admin interface as a separate service alongside your ZombieAuth OIDC server.

### Cluster Deployment
In clustered environments, deploy one admin interface instance per cluster node or use a load balancer to distribute traffic.

### Production Considerations
- Use HTTPS in production environments
- Configure proper CORS settings for your domains
- Set secure session cookies and CSRF tokens
- Monitor logs for security events
- Regular backup of CouchDB data

## Integration with ZombieAuth

This admin interface is designed to work with ZombieAuth OAuth2/OIDC servers:
- **Main Project**: [ZombieAuth](https://github.com/HodlOnToYourButts/ZombieAuth)
- **Cluster Status**: [Cluster-status](https://github.com/HodlOnToYourButts/Cluster-status)

## License

This project is licensed under the GNU Affero General Public License v3.0 - see the [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues and questions:
- Create an issue on GitHub
- Check the ZombieAuth main project documentation
- Review the API documentation for integration details