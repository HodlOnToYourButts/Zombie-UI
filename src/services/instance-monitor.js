const database = require('../database');

class InstanceMonitor {
  constructor() {
    this.instanceId = process.env.INSTANCE_ID || 'default';
    this.instanceLocation = process.env.INSTANCE_LOCATION || 'unknown';
  }

  /**
   * Get status of all known instances based on replication status
   */
  async getInstanceStatus() {
    try {
      // Call the replication-monitor microservice
      const replicationMonitorUrl = process.env.REPLICATION_MONITOR_URL || 'http://replication-monitor:8080';
      const response = await fetch(`${replicationMonitorUrl}/replication/status/zombieauth`);
      
      if (!response.ok) {
        throw new Error(`Replication monitor service failed: ${response.status}`);
      }
      
      const replicationData = await response.json();
      const replications = replicationData.replications || [];
      
      console.log(`Found ${replications.length} replications from replication-monitor service`);
      
      const instances = new Map();
      
      // Add current instance
      instances.set(this.instanceId, {
        id: this.instanceId,
        location: this.instanceLocation,
        status: 'active',
        lastSeen: new Date(),
        isCurrentInstance: true,
        replications: []
      });

      // Analyze replication documents to identify peer instances
      for (const replication of replications) {
        const peerInfo = this.extractPeerInfoFromReplication(replication);
        if (peerInfo) {
          const { peerId, peerLocation, isHealthy, healthReason, lastActivity, timeSinceLastActivity } = peerInfo;
          
          if (!instances.has(peerId)) {
            instances.set(peerId, {
              id: peerId,
              location: peerLocation,
              status: isHealthy ? 'active' : 'unreachable',
              lastSeen: lastActivity,
              isCurrentInstance: false,
              replications: []
            });
          }
          
          // Update instance status based on replication health
          const instance = instances.get(peerId);
          if (isHealthy && instance.status !== 'active') {
            instance.status = 'active';
            instance.lastSeen = lastActivity || new Date();
          } else if (!isHealthy && instance.status === 'active') {
            instance.status = 'unreachable';
          }
          
          // Add replication info
          instance.replications.push({
            id: replication.id,
            direction: peerInfo.direction,
            state: replication.status,
            stateReason: healthReason,
            docsRead: replication.stats?.docs_read || 0,
            docsWritten: replication.stats?.docs_written || 0,
            lastUpdate: lastActivity,
            timeSinceLastActivity: timeSinceLastActivity,
            changesPending: replication.stats?.changes_pending || 0,
            recentErrors: replication.recent_errors || []
          });
        }
      }

      // Convert to array and sort by instance ID
      const instanceList = Array.from(instances.values()).sort((a, b) => {
        // Current instance first
        if (a.isCurrentInstance) return -1;
        if (b.isCurrentInstance) return 1;
        return a.id.localeCompare(b.id);
      });

      return {
        currentInstance: this.instanceId,
        totalInstances: instanceList.length,
        activeInstances: instanceList.filter(i => i.status === 'active').length,
        unreachableInstances: instanceList.filter(i => i.status === 'unreachable').length,
        instances: instanceList
      };
    } catch (error) {
      console.error('Error getting instance status:', error);
      return {
        currentInstance: this.instanceId,
        totalInstances: 1,
        activeInstances: 1,
        unreachableInstances: 0,
        instances: [{
          id: this.instanceId,
          location: this.instanceLocation,
          status: 'active',
          lastSeen: new Date(),
          isCurrentInstance: true,
          replications: []
        }]
      };
    }
  }

  /**
   * Extract peer instance information from replication document
   */
  extractPeerInfoFromReplication(replication) {
    try {
      let peerId = null;
      let peerLocation = 'unknown';
      let direction = null;
      
      const sourceUrl = replication.source;
      const targetUrl = replication.target;
      
      // Determine direction based on which URL is remote
      if (typeof sourceUrl === 'string' && typeof targetUrl === 'string') {
        try {
          const sourceUrlObj = new URL(sourceUrl);
          const targetUrlObj = new URL(targetUrl);
          
          const sourceHost = sourceUrlObj.hostname;
          const targetHost = targetUrlObj.hostname;
          
          // Check if source is remote (pulling FROM remote)
          if (sourceHost !== 'localhost' && sourceHost !== '127.0.0.1' && !sourceHost.includes('localhost')) {
            direction = 'inbound'; // pulling from remote source
            peerId = sourceHost.split('.')[0]; // Extract instance name (e.g., 'whiteforest' from 'whiteforest.holz.ygg')
            peerLocation = sourceHost;
          }
          // Check if target is remote (pushing TO remote)
          else if (targetHost !== 'localhost' && targetHost !== '127.0.0.1' && !targetHost.includes('localhost')) {
            direction = 'outbound'; // pushing to remote target
            peerId = targetHost.split('.')[0]; // Extract instance name
            peerLocation = targetHost;
          }
        } catch (e) {
          console.log('Could not parse URLs for replication:', replication.id);
        }
      }
      
      if (!peerId) return null;
      
      // Enhanced health checking based on replication monitor API format
      const lastActivity = replication.last_activity ? new Date(replication.last_activity) : null;
      const timeSinceLastActivity = replication.time_since_last_activity_seconds || 0;
      
      let isHealthy = false;
      let healthReason = 'unknown';
      
      if (replication.status === 'running') {
        // Running means the instance is reachable (connected within last 30 seconds)
        isHealthy = true;
        healthReason = 'connected';
      } else if (replication.status === 'retrying') {
        // Retrying means the instance is unreachable (failed to connect)
        isHealthy = false;
        healthReason = replication.recent_errors.length > 0 ? 
          `connection failed: ${replication.recent_errors[0].reason.substring(0, 40)}...` : 'connection failed';
      } else if (replication.status === 'completed') {
        // One-time replication completed successfully
        isHealthy = true;
        healthReason = 'completed';
      } else if (replication.status === 'error' || replication.status === 'failed') {
        isHealthy = false;
        healthReason = replication.recent_errors.length > 0 ? 
          replication.recent_errors[0].reason.substring(0, 40) + '...' : 'failed';
      } else {
        isHealthy = false;
        healthReason = `status: ${replication.status}`;
      }
      
      return {
        peerId,
        peerLocation,
        direction,
        isHealthy,
        healthReason,
        lastActivity,
        timeSinceLastActivity
      };
    } catch (error) {
      console.error('Error extracting peer info from replication:', error);
      return null;
    }
  }

  /**
   * Get summary statistics for the instance network
   */
  async getNetworkSummary() {
    const status = await this.getInstanceStatus();
    
    const totalReplications = status.instances.reduce((sum, instance) => 
      sum + instance.replications.length, 0
    );
    
    const healthyReplications = status.instances.reduce((sum, instance) => 
      sum + instance.replications.filter(r => r.state === 'running' || r.state === 'triggered').length, 0
    );
    
    return {
      networkHealth: status.unreachableInstances === 0 ? 'healthy' : 
                    status.activeInstances > status.unreachableInstances ? 'degraded' : 'critical',
      totalInstances: status.totalInstances,
      activeInstances: status.activeInstances,
      unreachableInstances: status.unreachableInstances,
      totalReplications,
      healthyReplications,
      replicationHealth: totalReplications > 0 ? (healthyReplications / totalReplications) : 1
    };
  }
}

module.exports = InstanceMonitor;