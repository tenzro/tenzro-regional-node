// // tenzro-regional-node/src/config.ts
import dotenv from 'dotenv';
import path from 'path';
import { NodeType, NodeTier } from './types';

// Load environment variables
dotenv.config({ path: path.join(process.cwd(), '.env') });

// Validate node type
function validateNodeType(type: string): NodeType {
    const validTypes: NodeType[] = ['individual', 'regional_node', 'global_node'];
    if (!validTypes.includes(type as NodeType)) {
        throw new Error(`Invalid node type: ${type}. Must be one of: ${validTypes.join(', ')}`);
    }
    return type as NodeType;
}

// Validate node tier
function validateNodeTier(tier: string): NodeTier {
    const validTiers: NodeTier[] = ['inference', 'aggregator', 'training', 'feedback'];
    if (!validTiers.includes(tier as NodeTier)) {
        throw new Error(`Invalid node tier: ${tier}. Must be one of: ${validTiers.join(', ')}`);
    }
    return tier as NodeTier;
}

// Helper to get required env variable
function getRequiredEnv(key: string): string {
    const value = process.env[key];
    if (!value) {
        throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
}

// Parse regional nodes
function parseRegionalNodes(nodes: string): string[] {
    return nodes.split(',').map(node => node.trim());
}

export const envConfig = {
    node: {
        type: validateNodeType(process.env.NODE_TYPE || 'individual'),
        tier: validateNodeTier(process.env.NODE_TIER || 'inference'),
        tokenBalance: parseInt(process.env.TOKEN_BALANCE || '0', 10),
        region: process.env.REGION || 'default',
        port: parseInt(process.env.PORT || '8080', 10)
    },
    network: {
        RegionalNodes: parseRegionalNodes(process.env.Regional_NODES || ''),
        dht: {
            refreshInterval: parseInt(process.env.DHT_REFRESH_INTERVAL || '60000', 10),
            replicationFactor: parseInt(process.env.DHT_REPLICATION_FACTOR || '3', 10),
            timeout: parseInt(process.env.DHT_TIMEOUT || '10000', 10)
        },
        healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL || '30000', 10),
        cleanupInterval: parseInt(process.env.CLEANUP_INTERVAL || '300000', 10),
        peerTimeout: parseInt(process.env.PEER_TIMEOUT || '600000', 10)
    },
    validator: {
        regionalTokenRequirement: parseInt(process.env.REGIONAL_TOKEN_REQUIREMENT || '1000', 10),
        globalTokenRequirement: parseInt(process.env.GLOBAL_TOKEN_REQUIREMENT || '5000', 10),
        minRegionalValidators: parseInt(process.env.MIN_REGIONAL_VALIDATORS || '3', 10),
        minGlobalValidators: parseInt(process.env.MIN_GLOBAL_VALIDATORS || '5', 10)
    },
    tasks: {
        maxTaskDuration: parseInt(process.env.MAX_TASK_DURATION || '86400', 10),
        minTaskDuration: parseInt(process.env.MIN_TASK_DURATION || '60', 10),
        maxNodesPerTask: parseInt(process.env.MAX_NODES_PER_TASK || '100', 10),
        taskTimeout: parseInt(process.env.TASK_TIMEOUT || '3600', 10),
        backupInterval: parseInt(process.env.BACKUP_INTERVAL || '300000', 10)
    },
    metrics: {
        updateInterval: parseInt(process.env.METRICS_UPDATE_INTERVAL || '15000', 10),
        retentionPeriod: parseInt(process.env.METRICS_RETENTION_PERIOD || '86400000', 10),
        healthThresholds: {
            minActivePeers: parseFloat(process.env.MIN_ACTIVE_PEERS_RATIO || '0.7'),
            minValidators: parseInt(process.env.MIN_VALIDATORS || '3', 10)
        }
    }
};

export interface GlobalNodeConfig {
    healthCheck: {
        interval: number;
        timeout: number;
        thresholds: {
            responsiveness: number;
            taskCompletion: number;
            maxLatency: number;
        };
    };
    sync: {
        interval: number;
        retryAttempts: number;
        retryDelay: number;
    };
    backup: {
        interval: number;
        minCopies: number;
        retentionPeriod: number;
    };
    failover: {
        threshold: number;
        cooldown: number;
        maxAttempts: number;
    };
}

export const globalNodeConfig: GlobalNodeConfig = {
    healthCheck: {
        interval: 30000,  // 30 seconds
        timeout: 5000,    // 5 seconds
        thresholds: {
            responsiveness: 80,  // minimum 80% response rate
            taskCompletion: 90,  // minimum 90% task completion rate
            maxLatency: 1000     // maximum 1 second latency
        }
    },
    sync: {
        interval: 60000,  // 1 minute
        retryAttempts: 3,
        retryDelay: 5000  // 5 seconds
    },
    backup: {
        interval: 300000,  // 5 minutes
        minCopies: 2,
        retentionPeriod: 86400000  // 24 hours
    },
    failover: {
        threshold: 3,     // number of failed health checks before failover
        cooldown: 300000, // 5 minutes between failover attempts
        maxAttempts: 3    // maximum number of failover attempts
    }
}

export const config = {
    env: envConfig,
    globalNode: globalNodeConfig
};

export default config;