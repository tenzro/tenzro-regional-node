// // tenzro-regional-node/src/types.ts
import { WebSocket } from 'ws';

// Extended WebSocket interface with isAlive property
export interface ExtendedWebSocket extends WebSocket {
    isAlive: boolean;
    ping(data?: any, mask?: boolean, cb?: (err: Error) => void): void;
}

export type MessageType = 
    | 'join' 
    | 'leave'
    | 'peer_joined'
    | 'peer_left'
    | 'node_status'
    | 'network_state'
    | 'error'
    | 'task_broadcast'
    | 'task_assignment'
    | 'task_accepted'
    | 'task_rejected'
    | 'task_completed'
    | 'task_failed'
    | 'task_progress'
    | 'reward_distribution'
    | 'validator_message'
    | 'heartbeat'
    | 'heartbeat_response'
    | 'global_node_health'
    | 'task_reassignment'
    | 'sync_request'
    | 'sync_response'
    | 'backup_request'
    | 'backup_response'
    | 'task_recovery'
    | 'global_node_failover'
    | 'task_backup'
    | 'failover_request'
    | 'failover_response'
    | 'failover_complete'
    | 'failover_cancel'
    | 'failover_status'
    | 'failover_init';

    export type NodeType = 'individual' | 'regional_node' | 'global_node';
    export type NodeTier = 'inference' | 'aggregator' | 'training' | 'feedback';
    export type TaskType = 
    | 'compute'
    | 'train' 
    | 'process'
    | 'aggregate'
    | 'store'
    | 'validate'
    | 'verify'
    | 'dispute'
    | 'report'
    | 'update';

export interface SignalingMessage {
    type: MessageType;
    peerId?: string;
    nodeType?: NodeType;
    nodeTier?: NodeTier;
    tokenBalance?: number;
    region?: string;
    timestamp?: string;
    error?: string;

    taskId?: string;
    progress?: number;
    peerInfo?: PeerInfo;
    reward?: number;
    message?: string;
    regions?: string[] | RegionSummary[];
    activeTasks?: number;
    completedTasks?: number;
    totalRewardsDistributed?: number;
    heartbeatId?: string;
    syncData?: any;  // Made optional
    previousNode?: string;
    totalPeers?: number;
    activePeers?: number;
    validators?: {
        regional: number;
        global: number;
    };
    connections?: {
        total: number;
        average: number;
    };
    nodeStatus?: GlobalNodeHealth;  // Add separate property for GlobalNodeHealth
    result?: any;
    nodeId?: string;
    failoverInfo?: GlobalNodeFailover;
    peers?: PeerInfo[];
    task?: Task;
    nodeHealth?: GlobalNodeHealth; // Add this property
    globalNodeHealth?: GlobalNodeHealth; // Already exists
    status?: NodeStatus | GlobalNodeHealth; // Update to allow both types
}

export interface Task {
    taskId: string;
    type: TaskType;
    requirements: TaskRequirements;
    data: TaskData;
    reward: TaskReward;
    status: TaskStatus;
    timestamp: string;
    expiry: string;
    submitter: string;
}

export interface TaskRequirements {
    minTier: NodeTier;
    minStorage?: number;    // in GB
    minMemory?: number;     // in GB
    gpuRequired?: boolean;
    priority: 'low' | 'medium' | 'high';
    estimatedDuration: number; // in seconds
    maxNodes: number;         // maximum nodes to distribute to
}

export interface TaskData {
    input: any;
    config: any;
    resultEndpoint?: string;
}

export interface TaskReward {
    total: number;          // Total tokens allocated for task
    perNode: number;        // Tokens per node if distributed
    validatorShare: number; // Percentage share for validators (e.g., 10%)
    deadline: string;       // Deadline for task completion
    penaltyRate: number;    // Penalty rate for missing deadline (percentage)
}

export interface TaskStatus {
    state: 'pending' | 'assigned' | 'accepted' | 'processing' | 'completed' | 'failed';
    assignedNodes: string[];
    acceptedNodes: string[];
    progress: number;
    startTime?: string;
    completionTime?: string;
    error?: string;
    result?: any;
}

export interface PeerInfo {
    peerId: string;
    nodeType: NodeType;
    nodeTier: NodeTier;
    region: string;
    tokenBalance: number;
    connected: boolean;
    lastSeen: string;
}

export interface ConnectedPeer {
    ws: ExtendedWebSocket;
    info: PeerInfo;
    joinTime: Date;
    lastActivity: Date;
    status: {
        peerId: string;
        online: boolean;
        nodeType: NodeType;
        nodeTier: NodeTier;
        region: string;
        connections: number;
        resources: ResourceStats;
        earnings: number;
        activeTasks: number;
        completedTasks: number;
        lastUpdate: string;
    };
}

export interface NodeStatus {
    peerId: string;
    online: boolean;
    nodeType: NodeType;
    nodeTier: NodeTier;
    region: string;
    connections: number;
    resources: ResourceStats;
    earnings: number;
    activeTasks: number;
    completedTasks: number;
    lastUpdate: string;
}

export interface ResourceStats {
    cpu: number;
    memory: number;
    storage: number;
    bandwidth: number;
    timestamp: string;
}

export interface RegionInfo {
    id: string;
    name: string;
    validators: Set<string>;
    peers: Set<string>;
    lastUpdate: Date;
    status: RegionStatus;
    metrics: RegionMetrics;
}

export interface RegionMetrics {
    totalTasks: number;
    completedTasks: number;
    activeNodes: number;
    totalRewards: number;
    averageCompletionTime: number;
    successRate: number;
}

export type RegionStatus = 'active' | 'degraded' | 'offline';

export interface NetworkState {
    peers: PeerInfo[];
    regions: RegionSummary[];
    activeTasks: number;
    completedTasks: number;
    totalRewardsDistributed: number;
    timestamp: string;
}

export interface RegionSummary {
    id: string;
    name: string;
    peerCount: number;
    validatorCount: number;
    metrics: RegionMetrics;
}


export interface NodeRequirements {
    minTokens: number;
    minTier: NodeTier;
    maxTasks: number;
}

export const NODE_REQUIREMENTS: Record<NodeType, NodeRequirements> = {
    individual: {
        minTokens: 0,
        minTier: 'inference',
        maxTasks: 5
    },
    regional_node: {
        minTokens: 1000,
        minTier: 'aggregator',
        maxTasks: 50
    },
    global_node: {
        minTokens: 5000,
        minTier: 'training',
        maxTasks: 100
    }
};

export interface DHTConfig {
    nodeId: string;
    regionalNodes: string[];
    refreshInterval?: number;
    replicationFactor?: number;
    timeout?: number;
}

export interface DHTAnnouncement {
    nodeType: string;
    region: string;
    endpoint: string;
}

export interface DHTNode {
    id: string;
    address: string;
    lastSeen: Date;
    metadata: any;
}

export interface DHTNetwork {
    join(): Promise<void>;
    leave(): Promise<void>;
    announce(data: DHTAnnouncement): Promise<void>;
    findNode(nodeId: string): Promise<DHTNode | null>;
    findValue(key: string): Promise<any>;
    store(key: string, value: any): Promise<void>;
    getPeers(filter?: PeerFilter): Promise<DHTNode[]>;
}

export interface PeerFilter {
    nodeType?: string;
    region?: string;
    minTokens?: number;
    nodeTier?: string;
}

export interface NetworkConfig {
    regionalNodes: string[];
    dht: {
        refreshInterval: number;
        replicationFactor: number;
        timeout: number;
    };
    healthCheckInterval: number;
    cleanupInterval: number;
    peerTimeout: number;
    metrics: {
        updateInterval: number;
        retentionPeriod: number;
        healthThresholds: {
            minActivePeers: number;
            minValidators: number;
        };
    };
}

export interface MetricsConfig {
    updateInterval: number;
    retentionPeriod: number;
    healthThresholds: {
        minActivePeers: number;
        minValidators: number;
    };
}

export interface ValidatorConfig {
    regionalTokenRequirement: number;
    globalTokenRequirement: number;
    minRegionalValidators: number;
    minGlobalValidators: number;
}

export interface TasksConfig {
    maxTaskDuration: number;
    minTaskDuration: number;
    maxNodesPerTask: number;
    taskTimeout: number;
    backupInterval: number;  // Added for TaskBackupSystem
    globalValidator?: string;
    backupValidators?: string[];
    status: {
        state: 'pending' | 'assigned' | 'accepted' | 'processing' | 'completed' | 'failed';
        assignedNodes: string[];
        acceptedNodes: string[];
        progress: number;
        startTime?: string;
        completionTime?: string;
        error?: string;
        result?: any;
    };
}

export interface NodeConfig {
    type: NodeType;
    tier: NodeTier;
    tokenBalance: number;
    region: string;
    port: number;
}

export interface EnvConfig {
    node: NodeConfig;
    network: NetworkConfig;
    validator: ValidatorConfig;
    tasks: TasksConfig;
    metrics: MetricsConfig;
}

export type GlobalNodeStatus = 'active' | 'degraded' | 'failing' | 'offline';
export type GlobalNodeHealthMetric = 'responsiveness' | 'taskCompletion' | 'networkLatency' | 'resourceUtilization';

export interface GlobalNodeHealth {
    nodeId: string;
    status: GlobalNodeStatus;
    lastCheck: string;
    metrics: {
        responsiveness: number;
        taskCompletion: number;
        networkLatency: number;
        resourceUtilization: number;
    };
    issues: string[];
}

export interface GlobalNodeFailover {
    failedNodeId: string;
    backupNodeId: string;
    affectedTasks: string[];
    timestamp: string;
    reason: string;
}

export interface NetworkSyncData {
    tasks: Task[];
    validators: PeerInfo[];
    metrics: NetworkMetrics;
    timestamp: string;
}

export interface NetworkMetrics {
    totalTasks: number;
    completedTasks: number;
    activeNodes: number;
    totalRewards: number;
    averageCompletionTime: number;
    successRate: number;
    taskCompletion: number;
    resourceUtilization: number;
    networkLatency: number;
    totalPeers: number;
    activePeers: number;
    validators?: {
        regional: number;
        global: number;
    };
    regions?: {
        total: number;
        active: number;
    };
    connections?: {
        total: number;
        average: number;
    };

}

export interface Task {
    taskId: string;
    type: TaskType;
    requirements: TaskRequirements;
    data: TaskData;
    reward: TaskReward;
    status: TaskStatus;
    timestamp: string;
    expiry: string;
    submitter: string;
    globalValidator?: string;
    backupValidators?: string[];
}

export interface TaskRequirements {
    minTier: NodeTier;
    minStorage?: number;    // in GB
    minMemory?: number;     // in GB
    gpuRequired?: boolean;
    priority: 'low' | 'medium' | 'high';
    estimatedDuration: number; // in seconds
    maxNodes: number;         // maximum nodes to distribute to
    redundancy?: number;      // number of backup nodes
    minGlobalValidators?: number; // minimum number of global validators needed
}

export const TASK_TIER_REQUIREMENTS: Record<TaskType, {
    tiers: NodeTier[],
    minReward: number,
    validatorShare: number
}> = {
    compute: {
        tiers: ['training', 'feedback'],
        minReward: 100,
        validatorShare: 10
    },
    train: {
        tiers: ['training', 'feedback'],
        minReward: 100,
        validatorShare: 10
    },
    process: {
        tiers: ['aggregator', 'training', 'feedback'],
        minReward: 50,
        validatorShare: 10
    },
    aggregate: {
        tiers: ['aggregator', 'training', 'feedback'],
        minReward: 50,
        validatorShare: 10
    },
    store: {
        tiers: ['inference', 'aggregator', 'training', 'feedback'],
        minReward: 20,
        validatorShare: 5
    },
    validate: {
        tiers: ['aggregator', 'training', 'feedback'],
        minReward: 50,
        validatorShare: 10
    },
    verify: {
        tiers: ['training', 'feedback'],
        minReward: 75,
        validatorShare: 10
    },
    dispute: {
        tiers: ['feedback'],
        minReward: 100,
        validatorShare: 15
    },
    report: {
        tiers: ['aggregator', 'training', 'feedback'],
        minReward: 30,
        validatorShare: 5
    },
    update: {
        tiers: ['training', 'feedback'],
        minReward: 50,
        validatorShare: 10
    }
};

export interface ValidatorEvents {
    'task:completed': (taskId: string) => void;
    'task:failed': (taskId: string, error: string) => void;
    'node:connected': (peerId: string) => void;
    'node:disconnected': (peerId: string) => void;
}


export interface DirectConnectionInfo {
    address: string;      // IP or domain
    port?: number;        // Optional port
    nodeId?: string;      // Optional known node ID
    protocol?: string;    // ws or wss
    region?: string;      // Optional region info
}

export interface DHTMessageType {
    type: 'join' | 'leave' | 'announce' | 'findNode' | 'findValue' | 'store' | 
          'getPeers' | 'info_request' | 'info_response' | 'direct_connect';
    nodeId?: string;
    key?: string;
    value?: any;
    announcement?: DHTAnnouncement;
    filter?: PeerFilter;
    timestamp: string;
}


export interface DHTMessageType {
    type: 'join' | 'leave' | 'announce' | 'findNode' | 'findValue' | 'store' | 
          'getPeers' | 'info_request' | 'info_response' | 'direct_connect';
    nodeId?: string;
    key?: string;
    value?: any;
    announcement?: DHTAnnouncement;
    filter?: PeerFilter;
    timestamp: string;
}


export interface DHTResponse {
    type: string;
    node?: DHTNode;
    value?: any;
    peers?: DHTNode[];
    error?: string;
    info?: any;
    timestamp: string;
}