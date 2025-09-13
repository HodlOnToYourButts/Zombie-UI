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
      const replications = await database.getReplicationStatus();
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
          const { peerId, peerLocation, isHealthy } = peerInfo;
          
          if (!instances.has(peerId)) {
            instances.set(peerId, {
              id: peerId,
              location: peerLocation,
              status: isHealthy ? 'active' : 'unreachable',
              lastSeen: replication.stateTime ? new Date(replication.stateTime) : null,
              isCurrentInstance: false,
              replications: []
            });
          }
          
          // Update instance status based on replication health
          const instance = instances.get(peerId);
          if (isHealthy && instance.status !== 'active') {
            instance.status = 'active';
            instance.lastSeen = replication.stateTime ? new Date(replication.stateTime) : new Date();
          } else if (!isHealthy && instance.status === 'active') {
            instance.status = 'unreachable';
          }
          
          // Add replication info
          instance.replications.push({
            id: replication.id,
            direction: replication.id.includes('push-') ? 'outbound' : 'inbound',
            state: replication.state,
            stateReason: replication.stateReason,
            docsRead: replication.docsRead,
            docsWritten: replication.docsWritten,
            lastUpdate: replication.stateTime
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
      // Replication IDs follow patterns like:
      // push-instance1-to-peer2 or pull-peer2-to-instance1
      const replicationId = replication.id;
      
      let peerId = null;
      let direction = null;
      
      if (replicationId.startsWith(`push-${this.instanceId}-to-`)) {
        // Outbound replication: push-currentInstance-to-peerX
        peerId = replicationId.replace(`push-${this.instanceId}-to-`, '');
        direction = 'outbound';
      } else if (replicationId.startsWith(`pull-`) && replicationId.endsWith(`-to-${this.instanceId}`)) {
        // Inbound replication: pull-peerX-to-currentInstance
        peerId = replicationId.replace(`pull-`, '').replace(`-to-${this.instanceId}`, '');
        direction = 'inbound';
      }
      
      if (!peerId) return null;
      
      // Extract location from target/source URL if possible
      let peerLocation = 'unknown';
      const targetUrl = direction === 'outbound' ? replication.target : replication.source;
      if (typeof targetUrl === 'string') {
        try {
          const url = new URL(targetUrl);
          peerLocation = url.hostname;
        } catch (e) {
          // Ignore URL parsing errors
        }
      }
      
      // Determine if replication is healthy
      const isHealthy = replication.state === 'running' || replication.state === 'triggered';
      
      return {
        peerId,
        peerLocation,
        direction,
        isHealthy
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