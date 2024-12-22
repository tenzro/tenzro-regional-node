// // tenzro-regional-node/src/GlobalNodeCoordinator.ts
import { EventEmitter } from 'events';
import {
    GlobalNodeHealth,
    GlobalNodeStatus,
    GlobalNodeHealthMetric,
    GlobalNodeFailover,
    ConnectedPeer,
    Task,
    SignalingMessage,
    NetworkSyncData,
    PeerInfo,
    NetworkMetrics,
    NodeStatus
} from './types';
import { Logger } from './utils/Logger';
import config from './config';

export class GlobalNodeCoordinator extends EventEmitter {
    private logger: Logger;
    private globalNodes: Map<string, ConnectedPeer> = new Map();
    private healthMetrics: Map<string, GlobalNodeHealth> = new Map();
    private failoverHistory: GlobalNodeFailover[] = [];
    private syncInterval: NodeJS.Timeout | null = null;
    private healthCheckInterval: NodeJS.Timeout | null = null;
    private activeTasks: Map<string, Task> = new Map();
    private rewardDistributions: Map<string, Map<string, number>> = new Map();

    constructor() {
        super();
        this.logger = Logger.getInstance();
        this.logger.setContext('GlobalNodeCoordinator');
    }

    public start(): void {
        this.startHealthChecks();
        this.startSyncProcess();
    }

    public stop(): void {
        if (this.syncInterval) clearInterval(this.syncInterval);
        if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    }

    private startHealthChecks(): void {
        this.healthCheckInterval = setInterval(
            () => this.checkGlobalNodesHealth(),
            config.env.network.healthCheckInterval
        );
    }

    private startSyncProcess(): void {
        this.syncInterval = setInterval(
            () => this.synchronizeWithGlobalNodes(),
            config.env.network.healthCheckInterval
        );
    }

    public async addGlobalNode(peer: ConnectedPeer): Promise<void> {
        const { peerId } = peer.info;
        this.globalNodes.set(peerId, peer);
        await this.initializeHealthMetrics(peerId);
        await this.synchronizeWithGlobalNodes();
    }

    public async removeGlobalNode(peerId: string): Promise<void> {
        const node = this.globalNodes.get(peerId);
        if (!node) return;

        // Update health status
        const health = this.healthMetrics.get(peerId);
        if (health) {
            health.status = 'offline';
            health.issues.push('Node disconnected from network');
            this.healthMetrics.set(peerId, health);
        }

        // Trigger failover if needed
        await this.handleNodeFailover(peerId);

        this.globalNodes.delete(peerId);
        this.healthMetrics.delete(peerId);
    }

    private async initializeHealthMetrics(nodeId: string): Promise<void> {
        const metrics: GlobalNodeHealth = {
            nodeId,
            status: 'active',
            lastCheck: new Date().toISOString(),
            metrics: {
                responsiveness: 100,
                taskCompletion: 100,
                networkLatency: 0,
                resourceUtilization: 0
            },
            issues: []
        };
        this.healthMetrics.set(nodeId, metrics);
    }

    private async checkGlobalNodesHealth(): Promise<void> {
        for (const [nodeId, peer] of this.globalNodes.entries()) {
            try {
                const health = await this.assessNodeHealth(peer);
                this.healthMetrics.set(nodeId, health);

                if (health.status === 'failing') {
                    await this.handleDegradedNode(nodeId);
                }

                // Broadcast health update
                this.broadcastHealthUpdate(health);
            } catch (error) {
                this.logger.error(`Health check failed for node ${nodeId}`, error as Error);
            }
        }
    }

    private async assessNodeHealth(peer: ConnectedPeer): Promise<GlobalNodeHealth> {
        const health = this.healthMetrics.get(peer.info.peerId) || {
            nodeId: peer.info.peerId,
            status: 'active' as GlobalNodeStatus,
            lastCheck: new Date().toISOString(),
            metrics: {
                responsiveness: 100,
                taskCompletion: 100,
                networkLatency: 0,
                resourceUtilization: 0
            },
            issues: []
        };

        // Check responsiveness
        const start = Date.now();
        try {
            await this.pingNode(peer);
            health.metrics.responsiveness = 100;
            health.metrics.networkLatency = Date.now() - start;
        } catch (error) {
            health.metrics.responsiveness = Math.max(0, health.metrics.responsiveness - 20);
            health.issues.push('Node not responding to ping');
        }

        // Check task completion rate
        const taskMetrics = await this.getNodeTaskMetrics(peer.info.peerId);
        health.metrics.taskCompletion = taskMetrics.completionRate;
        health.metrics.resourceUtilization = taskMetrics.resourceUsage;

        // Update overall status
        health.status = this.determineNodeStatus(health.metrics);
        health.lastCheck = new Date().toISOString();

        return health;
    }

    private async pingNode(peer: ConnectedPeer): Promise<void> {
        return new Promise((resolve, reject) => {
            if (peer.ws.readyState !== peer.ws.OPEN) {
                reject(new Error('WebSocket not open'));
                return;
            }

            const timeout = setTimeout(() => {
                reject(new Error('Ping timeout'));
            }, config.env.network.peerTimeout);

            peer.ws.ping((err: any) => {
                clearTimeout(timeout);
                if (err) reject(err);
                else resolve();
            });
        });
    }

    private determineNodeStatus(metrics: { [key in GlobalNodeHealthMetric]: number }): GlobalNodeStatus {
        if (metrics.responsiveness < 50 || metrics.taskCompletion < 50) {
            return 'failing';
        } else if (metrics.responsiveness < 80 || metrics.taskCompletion < 80) {
            return 'degraded';
        }
        return 'active';
    }

    private async handleNodeFailover(nodeId: string): Promise<void> {
        const failedNode = this.globalNodes.get(nodeId);
        if (!failedNode) return;

        // Find backup node
        const availableNodes = Array.from(this.globalNodes.values())
            .filter(node => 
                node.info.peerId !== nodeId && 
                this.healthMetrics.get(node.info.peerId)?.status === 'active'
            );

        if (availableNodes.length === 0) {
            this.logger.error('No available backup nodes for failover');
            return;
        }

        const backupNode = availableNodes[0];
        const affectedTasks = await this.getNodeTasks(nodeId);

        const failover: GlobalNodeFailover = {
            failedNodeId: nodeId,
            backupNodeId: backupNode.info.peerId,
            affectedTasks: affectedTasks.map(t => t.taskId),
            timestamp: new Date().toISOString(),
            reason: 'Node health degraded below acceptable threshold'
        };

        // Reassign tasks to backup node
        for (const task of affectedTasks) {
            await this.reassignTask(task, backupNode);
        }

        this.failoverHistory.push(failover);
        this.broadcastFailoverEvent(failover);
    }

    private async handleDegradedNode(nodeId: string): Promise<void> {
        const node = this.globalNodes.get(nodeId);
        if (!node) return;
    
        // Convert GlobalNodeHealth to NodeStatus
        const healthStatus = this.healthMetrics.get(nodeId);
        if (!healthStatus) return;
    
        const nodeStatus: NodeStatus = {
            peerId: nodeId,
            online: healthStatus.status === 'active',
            nodeType: node.info.nodeType,
            nodeTier: node.info.nodeTier,
            region: node.info.region,
            connections: 0, // Set appropriate default or actual value
            resources: {
                cpu: healthStatus.metrics.resourceUtilization,
                memory: 0, // Set appropriate default or actual value
                storage: 0, // Set appropriate default or actual value
                bandwidth: 0, // Set appropriate default or actual value
                timestamp: healthStatus.lastCheck
            },
            earnings: 0, // Set appropriate default or actual value
            activeTasks: 0, // Set appropriate default or actual value
            completedTasks: 0, // Set appropriate default or actual value
            lastUpdate: healthStatus.lastCheck
        };
    
        const message: SignalingMessage = {
            type: 'global_node_health',
            peerId: nodeId,
            status: nodeStatus,
            nodeHealth: healthStatus,
            timestamp: new Date().toISOString()
        };
    
        await this.broadcastToGlobalNodes(message);
    }

    private async synchronizeWithGlobalNodes(): Promise<void> {
        if (this.globalNodes.size === 0) return;

        const syncData: NetworkSyncData = {
            tasks: await this.getAllActiveTasks(),
            validators: Array.from(this.globalNodes.values()).map(n => n.info),
            metrics: await this.getNetworkMetrics(),
            timestamp: new Date().toISOString()
        };

        const message: SignalingMessage = {
            type: 'sync_request',
            syncData,
            timestamp: new Date().toISOString()
        };

        await this.broadcastToGlobalNodes(message);
    }

    private async reassignTask(task: Task, newNode: ConnectedPeer): Promise<void> {
        const message: SignalingMessage = {
            type: 'task_reassignment',
            task: {
                ...task,
                globalValidator: newNode.info.peerId,
                backupValidators: Array.from(this.globalNodes.values())
                    .filter(n => n.info.peerId !== newNode.info.peerId)
                    .map(n => n.info.peerId)
            },
            previousNode: task.globalValidator,
            timestamp: new Date().toISOString()
        };

        try {
            await this.forwardMessage(newNode, message);
            this.logger.info(`Task ${task.taskId} reassigned to node ${newNode.info.peerId}`);
        } catch (error) {
            this.logger.error(`Failed to reassign task ${task.taskId}`, error as Error);
            throw error;
        }
    }

    private async broadcastToGlobalNodes(message: SignalingMessage): Promise<void> {
        const promises = Array.from(this.globalNodes.values())
            .filter(node => this.isNodeHealthy(node.info.peerId))
            .map(node => this.forwardMessage(node, message));

        await Promise.allSettled(promises);
    }

    private async forwardMessage(peer: ConnectedPeer, message: SignalingMessage): Promise<void> {
        return new Promise((resolve, reject) => {
            if (peer.ws.readyState !== peer.ws.OPEN) {
                reject(new Error('WebSocket not open'));
                return;
            }

            try {
                peer.ws.send(JSON.stringify(message), (error) => {
                    if (error) reject(error);
                    else resolve();
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    private async getNodeTaskMetrics(nodeId: string): Promise<{
        completionRate: number;
        resourceUsage: number;
    }> {
        // This would be implemented to fetch actual metrics from your task tracking system
        const node = this.globalNodes.get(nodeId);
        if (!node) {
            return { completionRate: 0, resourceUsage: 0 };
        }

        return {
            completionRate: node.status.completedTasks / (node.status.activeTasks + node.status.completedTasks) * 100 || 100,
            resourceUsage: (node.status.resources.cpu + node.status.resources.memory) / 2
        };
    }

    private async getNodeTasks(nodeId: string): Promise<Task[]> {
        // This would be implemented to fetch tasks from your task tracking system
        return Array.from(this.activeTasks.values())
            .filter(task => task.globalValidator === nodeId);
    }

    private async getAllActiveTasks(): Promise<Task[]> {
        // This would be implemented to fetch all active tasks from your task tracking system
        return Array.from(this.activeTasks.values());
    }

    private async getNetworkMetrics(): Promise<NetworkMetrics> {
        // This would be implemented to fetch current network metrics
        return {
            totalPeers: this.globalNodes.size,
            activePeers: Array.from(this.globalNodes.values())
                .filter(node => this.isNodeHealthy(node.info.peerId)).length,
            taskCompletion: await this.calculateTaskCompletionRate(),
            resourceUtilization: await this.calculateResourceUtilization(),
            networkLatency: await this.calculateAverageLatency(),
            // Adding missing required properties
            totalTasks: this.activeTasks.size,
            completedTasks: Array.from(this.activeTasks.values())
                .filter(task => task.status.state === 'completed').length,
            activeNodes: Array.from(this.globalNodes.values())
                .filter(node => node.status.online).length,
            totalRewards: Array.from(this.rewardDistributions.values())
                .reduce((sum, rewards) => sum + Array.from(rewards.values())
                    .reduce((total, reward) => total + reward, 0), 0),
            averageCompletionTime: Array.from(this.activeTasks.values())
                .filter(task => task.status.state === 'completed')
                .reduce((sum, task) => {
                    const start = new Date(task.status.startTime!).getTime();
                    const end = new Date(task.status.completionTime!).getTime();
                    return sum + (end - start);
                }, 0) / Array.from(this.activeTasks.values())
                    .filter(task => task.status.state === 'completed').length || 0,
            successRate: (Array.from(this.activeTasks.values())
                .filter(task => task.status.state === 'completed').length / 
                this.activeTasks.size) * 100 || 0
        };
    }

    private isNodeHealthy(nodeId: string): boolean {
        const health = this.healthMetrics.get(nodeId);
        return health?.status === 'active';
    }

    private async calculateTaskCompletionRate(): Promise<number> {
        const completedTasks = Array.from(this.globalNodes.values())
            .reduce((sum, node) => sum + node.status.completedTasks, 0);
        const totalTasks = completedTasks + Array.from(this.globalNodes.values())
            .reduce((sum, node) => sum + node.status.activeTasks, 0);

        return totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 100;
    }

    private async calculateResourceUtilization(): Promise<number> {
        const nodes = Array.from(this.globalNodes.values());
        if (nodes.length === 0) return 0;

        return nodes.reduce((sum, node) => {
            const resources = node.status.resources;
            return sum + (resources.cpu + resources.memory) / 2;
        }, 0) / nodes.length;
    }

    private async calculateAverageLatency(): Promise<number> {
        const latencies = Array.from(this.healthMetrics.values())
            .map(health => health.metrics.networkLatency);

        return latencies.length > 0 
            ? latencies.reduce((sum, latency) => sum + latency, 0) / latencies.length 
            : 0;
    }

    private broadcastHealthUpdate(health: GlobalNodeHealth): void {
        const message: SignalingMessage = {
            type: 'global_node_health',
            globalNodeHealth: health,
            timestamp: new Date().toISOString()
        };

        this.broadcastToGlobalNodes(message).catch(error => {
            this.logger.error('Failed to broadcast health update', error as Error);
        });
    }

    private broadcastFailoverEvent(failover: GlobalNodeFailover): void {
        const message: SignalingMessage = {
            type: 'global_node_failover',
            failoverInfo: failover,
            timestamp: new Date().toISOString()
        };

        this.broadcastToGlobalNodes(message).catch(error => {
            this.logger.error('Failed to broadcast failover event', error as Error);
        });
    }

    // Public API methods
    public getGlobalNodeHealth(nodeId: string): GlobalNodeHealth | undefined {
        return this.healthMetrics.get(nodeId);
    }

    public getFailoverHistory(): GlobalNodeFailover[] {
        return [...this.failoverHistory];
    }

    public getHealthyGlobalNodes(): PeerInfo[] {
        return Array.from(this.globalNodes.values())
            .filter(node => this.isNodeHealthy(node.info.peerId))
            .map(node => node.info);
    }

    public async handleSyncRequest(message: SignalingMessage): Promise<void> {
        if (!message.syncData) return;

        // Merge received data with local state
        await this.mergeSyncData(message.syncData);
    }

    private async mergeSyncData(syncData: NetworkSyncData): Promise<void> {
        // Implement merge logic for tasks, validators, and metrics
        // This would need to be customized based on your specific requirements
        this.logger.info('Received sync data', syncData);
    }
}