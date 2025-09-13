const database = require('../database');
const InstanceMonitor = require('./instance-monitor');

// Global isolation state to persist across instances
global.clusterIsolationState = global.clusterIsolationState || {
  isolationStartTime: null,
  isolatedInstances: []
};

// Global cluster uptime state - tracks when all instances are healthy
global.clusterUptimeState = global.clusterUptimeState || {
  fullySyncedSince: null // When all instances are replicating properly
};

class ClusterHealth {
  constructor() {
    this.instanceMonitor = new InstanceMonitor();
    this.lastHealthCheck = null;
    this.database = null;
  }

  async initialize() {
    // Initialize database connection
    this.database = require('../database');
  }

  async checkClusterHealth() {
    const currentInstanceId = process.env.INSTANCE_ID || 'unknown';
    
    try {
      // Get instance status from replication monitoring
      const instanceStatus = await this.instanceMonitor.getInstanceStatus();
      const networkSummary = await this.instanceMonitor.getNetworkSummary();
      
      const healthResults = {
        timestamp: new Date().toISOString(),
        currentInstance: currentInstanceId,
        instances: instanceStatus.instances.map(instance => ({
          id: instance.id,
          name: instance.location,
          status: instance.status,
          isCurrentInstance: instance.isCurrentInstance,
          lastSeen: instance.lastSeen,
          replications: instance.replications.map(rep => ({
            direction: rep.direction,
            state: rep.state,
            stateReason: rep.stateReason,
            docsTransferred: rep.direction === 'outbound' ? rep.docsWritten : rep.docsRead,
            lastUpdate: rep.lastUpdate
          }))
        })),
        summary: {
          total: instanceStatus.totalInstances,
          healthy: instanceStatus.activeInstances,
          unhealthy: instanceStatus.unreachableInstances,
          networkHealth: networkSummary.networkHealth,
          replicationHealth: Math.round(networkSummary.replicationHealth * 100),
          isolated: this.getIsolatedInstances(instanceStatus.instances)
        }
      };

      // Track isolation state
      const currentlyIsolated = instanceStatus.unreachableInstances > 0;
      this.updateIsolationStatus(currentlyIsolated);
      
      // Add isolation info for downtime calculation
      healthResults.isolationInfo = this.getIsolationInfo();
      
      this.lastHealthCheck = healthResults;
      return healthResults;
      
    } catch (error) {
      console.error('Error checking cluster health:', error);
      
      // Return fallback health status
      const fallbackResults = {
        timestamp: new Date().toISOString(),
        currentInstance: currentInstanceId,
        instances: [{
          id: currentInstanceId,
          name: 'current',
          status: 'active',
          isCurrentInstance: true,
          lastSeen: new Date(),
          replications: []
        }],
        summary: {
          total: 1,
          healthy: 1,
          unhealthy: 0,
          networkHealth: 'unknown',
          replicationHealth: 0,
          isolated: []
        },
        isolationInfo: this.getIsolationInfo()
      };
      
      this.lastHealthCheck = fallbackResults;
      return fallbackResults;
    }
  }
  
  getIsolatedInstances(instances) {
    return instances
      .filter(instance => instance.status === 'unreachable')
      .map(instance => instance.id);
  }

  // Get current cluster health (cached)
  getCurrentHealth() {
    return this.lastHealthCheck;
  }

  // Check if cluster is in isolation (some instances down)
  isClusterIsolated() {
    if (!this.lastHealthCheck) {
      return { isolated: true, reason: 'Health check not performed' };
    }

    const unhealthy = this.lastHealthCheck.summary.unhealthy;
    if (unhealthy === 0) {
      return { isolated: false };
    }

    return {
      isolated: true,
      reason: `${unhealthy} instance(s) unreachable`,
      isolatedInstances: this.lastHealthCheck.summary.isolated
    };
  }

  // Track when isolation starts/stops using global state
  updateIsolationStatus(currentlyIsolated) {
    if (currentlyIsolated && !global.clusterIsolationState.isolationStartTime) {
      // Isolation just started
      global.clusterIsolationState.isolationStartTime = new Date();
      global.clusterIsolationState.isolatedInstances = this.lastHealthCheck?.summary.isolated || [];
      console.log('Cluster isolation detected, started at:', global.clusterIsolationState.isolationStartTime.toISOString());
    } else if (!currentlyIsolated && global.clusterIsolationState.isolationStartTime) {
      // Isolation ended
      const duration = new Date() - global.clusterIsolationState.isolationStartTime;
      console.log('Cluster isolation ended, duration:', duration, 'ms');
      global.clusterIsolationState.isolationStartTime = null;
      global.clusterIsolationState.isolatedInstances = [];
    } else if (currentlyIsolated && global.clusterIsolationState.isolationStartTime) {
      // Isolation continuing - update isolated instances list
      global.clusterIsolationState.isolatedInstances = this.lastHealthCheck?.summary.isolated || [];
      console.log('Cluster isolation continuing since:', global.clusterIsolationState.isolationStartTime.toISOString());
    }
  }

  // Get records modified since isolation started using global state
  async getIsolatedRecordsCount() {
    if (!global.clusterIsolationState.isolationStartTime) {
      return 0; // No isolation detected
    }

    try {
      const isolationStart = global.clusterIsolationState.isolationStartTime.toISOString();
      console.log('Getting isolated records count since:', isolationStart);
      
      const db = this.database.getDb();
      
      // Count records modified since isolation started
      const result = await db.view('instance_metadata', 'by_modified_time', {
        startkey: isolationStart,
        include_docs: false
      });
      
      const isolatedCount = result.rows.length;
      console.log('Found', isolatedCount, 'records modified since isolation started');
      
      return isolatedCount;
    } catch (error) {
      console.error('Error getting isolated records count:', error);
      return 0;
    }
  }

  // Check if a specific record was modified during isolation period
  isRecordIsolated(record) {
    if (!global.clusterIsolationState.isolationStartTime || !record.instanceMetadata?.lastModifiedAt) {
      return false;
    }
    
    const recordModifiedTime = new Date(record.instanceMetadata.lastModifiedAt);
    const isolationStartTime = global.clusterIsolationState.isolationStartTime;
    
    return recordModifiedTime >= isolationStartTime;
  }

  // Get isolation information
  getIsolationInfo() {
    return {
      isIsolated: !!global.clusterIsolationState.isolationStartTime,
      isolationStartTime: global.clusterIsolationState.isolationStartTime,
      isolatedInstances: global.clusterIsolationState.isolatedInstances,
      durationMs: global.clusterIsolationState.isolationStartTime ? 
                  new Date() - global.clusterIsolationState.isolationStartTime : 0
    };
  }
}

module.exports = ClusterHealth;