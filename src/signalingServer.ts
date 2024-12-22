// // tenzro-regional-node/src/signalingServer.ts
import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { EventEmitter } from 'events';
import {
    SignalingMessage,
    ConnectedPeer,
    RegionInfo,
    NodeStatus,
    PeerInfo,
    NodeType,
    NodeTier,
    Task,
    TaskType,
    NetworkState,
    ExtendedWebSocket,
    GlobalNodeHealth
} from './types';
import { ValidatorSystem } from './ValidatorSystem';
import { MetricsCollector } from './MetricsCollector';
import { Logger } from './utils/Logger';
import config from './config';

export class SignalingServer extends EventEmitter {
    private wss: WebSocketServer;
    private peers: Map<string, ConnectedPeer> = new Map();
    private regions: Map<string, RegionInfo> = new Map();
    private logger: Logger;
    private validatorSystem: ValidatorSystem;
    private metricsCollector: MetricsCollector;

    constructor(server: any) {
        super();
        this.logger = Logger.getInstance();
        this.logger.setContext('SignalingServer');

        this.validatorSystem = new ValidatorSystem();
        this.metricsCollector = new MetricsCollector();

        this.wss = new WebSocketServer({
            server,
            path: '/ws',
            perMessageDeflate: false,
            clientTracking: true
        });

        this.setupWebSocketServer();
        this.setupPeriodicTasks();
        
        this.logger.info('Signaling Server initialized');
    }

    private setupWebSocketServer(): void {
        this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
            try {
                ws.on('message', async (data: Buffer) => {
                    try {
                        const message: SignalingMessage = JSON.parse(data.toString());
                        await this.handleMessage(ws, message);
                    } catch (error) {
                        this.logger.error('Message handling failed', error as Error);
                        this.sendError(ws, 'Message processing failed');
                    }
                });

                ws.on('close', () => {
                    this.handleDisconnection(ws);
                });

                ws.on('error', (error: Error) => {
                    this.logger.error('WebSocket error', error);
                });

                ws.on('pong', () => {
                    const peer = this.findPeerByWebSocket(ws);
                    if (peer) {
                        peer.lastActivity = new Date();
                    }
                });

            } catch (error) {
                this.logger.error('Connection setup failed', error as Error);
                ws.close(1011, 'Connection setup failed');
            }
        });
    }

    public async handleMessage(ws: WebSocket, message: SignalingMessage): Promise<void> {
        message.timestamp = new Date().toISOString();

        try {
            switch (message.type) {
                case 'join':
                    await this.handleJoin(ws, message);
                    break;
                case 'leave':
                    await this.handleLeave(message.peerId!);
                    break;
                case 'node_status':
                    await this.handleNodeStatus(message);
                    break;
                case 'task_broadcast':
                    await this.handleTaskBroadcast(message);
                    break;
                case 'task_assignment':
                    await this.handleTaskAssignment(message);
                    break;
                case 'task_accepted':
                    await this.handleTaskAcceptance(message);
                    break;
                case 'task_completed':
                    await this.handleTaskCompletion(message);
                    break;
                case 'task_failed':
                    await this.handleTaskFailure(message);
                    break;
                default:
                    this.logger.warn(`Unknown message type: ${message.type}`);
            }
        } catch (error) {
            this.logger.error(`Error handling message type ${message.type}`, error as Error);
            this.sendError(ws, `Failed to handle ${message.type}`);
        }
    }

    private validateValidatorEligibility(
        nodeTier: NodeTier,
        validatorType: NodeType,
        tokenBalance: number
    ): boolean {
        if (validatorType === 'regional_node') {
            return (
                ['aggregator', 'training'].includes(nodeTier) &&
                tokenBalance >= config.env.validator.regionalTokenRequirement
            );
        }
        
        if (validatorType === 'global_node') {
            return (
                ['training', 'feedback'].includes(nodeTier) &&
                tokenBalance >= config.env.validator.globalTokenRequirement
            );
        }

        return false;
    }

    private async handleJoin(ws: WebSocket, message: SignalingMessage): Promise<void> {
        const { peerId, nodeType, nodeTier, tokenBalance = 0, region } = message;
    
        if (!peerId || !nodeType || !nodeTier || !region) {
            this.sendError(ws, 'Invalid join message format');
            return;
        }
    
        // Validate validator eligibility if applicable
        if (nodeType !== 'individual') {
            const isEligible = this.validateValidatorEligibility(nodeTier, nodeType, tokenBalance);
            if (!isEligible) {
                this.sendError(ws, 'Insufficient tier or tokens for validator role');
                return;
            }
        }
    
        const peerInfo: PeerInfo = {
            peerId,
            nodeType,
            nodeTier,
            region,
            tokenBalance,
            connected: true,
            lastSeen: new Date().toISOString()
        };
    
        const peer: ConnectedPeer = {
            ws: ws as ExtendedWebSocket,
            info: peerInfo,
            joinTime: new Date(),
            lastActivity: new Date(),
            status: {
                peerId,
                online: true,
                nodeType,
                nodeTier,
                region,
                connections: 0,
                resources: {
                    cpu: 0,
                    memory: 0,
                    storage: 0,
                    bandwidth: 0,
                    timestamp: new Date().toISOString()
                },
                earnings: 0,
                activeTasks: 0,
                completedTasks: 0,
                lastUpdate: new Date().toISOString()
            }
        };
    
        // Add to peers and validator system
        this.peers.set(peerId, peer);
        this.validatorSystem.addNode(peer);
        await this.updateRegionInfo(region, peerId, nodeType);
    
        // Update metrics
        this.metricsCollector.updateNetworkMetrics(
            Array.from(this.peers.values()),
            Array.from(this.regions.values())
        );
    
        // Send network state to new peer
        this.sendNetworkState(ws);
    
        // Broadcast join to relevant peers
        this.broadcastToPeerGroup(peer.info, {
            type: 'peer_joined',
            peerInfo: peer.info,
            timestamp: new Date().toISOString(),
            syncData: undefined
        });
    
        this.logger.info(`Peer ${peerId} joined as ${nodeTier} node in region ${region}`);
    }

    private async handleLeave(peerId: string): Promise<void> {
        const peer = this.peers.get(peerId);
        if (!peer) return;

        const { region, nodeType } = peer.info;

        // Remove from region
        const regionInfo = this.regions.get(region);
        if (regionInfo) {
            regionInfo.peers.delete(peerId);
            if (nodeType !== 'individual') {
                regionInfo.validators.delete(peerId);
            }
        }

        // Remove from validator system and peers
        this.validatorSystem.removeNode(peerId, nodeType, region);
        this.peers.delete(peerId);

        // Update metrics
        this.metricsCollector.updateNetworkMetrics(
            Array.from(this.peers.values()),
            Array.from(this.regions.values())
        );

        // Broadcast leave to relevant peers
        this.broadcastToPeerGroup(peer.info, {
            type: 'peer_left',
            peerId,
            region,
            timestamp: new Date().toISOString(),
            syncData: undefined
        });

        this.logger.info(`Peer ${peerId} left the network`);
    }

    private async handleNodeStatus(message: SignalingMessage): Promise<void> {
        if (!message.peerId || !message.status) return;
    
        const peer = this.peers.get(message.peerId);
        if (!peer) return;
    
        // Convert GlobalNodeHealth to NodeStatus if needed
        if ('status' in message.status) {
            const health = message.status as GlobalNodeHealth;
            peer.status = {
                peerId: message.peerId,
                online: health.status === 'active',
                nodeType: peer.info.nodeType,
                nodeTier: peer.info.nodeTier,
                region: peer.info.region,
                connections: peer.status.connections,
                resources: {
                    cpu: health.metrics.resourceUtilization,
                    memory: peer.status.resources.memory,
                    storage: peer.status.resources.storage,
                    bandwidth: peer.status.resources.bandwidth,
                    timestamp: health.lastCheck
                },
                earnings: peer.status.earnings,
                activeTasks: peer.status.activeTasks,
                completedTasks: peer.status.completedTasks,
                lastUpdate: health.lastCheck
            };
        } else {
            peer.status = message.status;
        }
    
        peer.lastActivity = new Date();
    
        this.metricsCollector.updateNetworkMetrics(
            Array.from(this.peers.values()),
            Array.from(this.regions.values())
        );
    }

    private async handleTaskBroadcast(message: SignalingMessage): Promise<void> {
        if (!message.task || !message.peerId) return;

        const peer = this.peers.get(message.peerId);
        if (!peer || peer.info.nodeType !== 'global_node') {
            this.logger.warn(`Invalid task broadcast from non-global validator ${message.peerId}`);
            return;
        }

        try {
            await this.validatorSystem.broadcastTask(message.task, message.peerId);
        } catch (error) {
            this.logger.error('Task broadcast failed', error as Error);
            this.sendError(peer.ws, 'Task broadcast failed');
        }
    }

    private async handleTaskAssignment(message: SignalingMessage): Promise<void> {
        if (!message.task || !message.peerId) return;

        const peer = this.peers.get(message.peerId);
        if (!peer || peer.info.nodeType !== 'regional_node') {
            return;
        }

        try {
            await this.validatorSystem.handleRegionalTaskDistribution(
                message.task,
                peer.info.region,
                message.peerId
            );
        } catch (error) {
            this.logger.error('Task assignment failed', error as Error);
            this.sendError(peer.ws, 'Task assignment failed');
        }
    }

    private async handleTaskAcceptance(message: SignalingMessage): Promise<void> {
        if (!message.taskId || !message.peerId) return;

        try {
            await this.validatorSystem.handleTaskAcceptance(
                message.taskId,
                message.peerId
            );
        } catch (error) {
            this.logger.error('Task acceptance failed', error as Error);
            const peer = this.peers.get(message.peerId);
            if (peer) {
                this.sendError(peer.ws, 'Task acceptance failed');
            }
        }
    }

    private async handleTaskCompletion(message: SignalingMessage): Promise<void> {
        if (!message.taskId || !message.peerId || !message.result) return;

        try {
            await this.validatorSystem.handleTaskCompletion(
                message.taskId,
                message.peerId,
                message.result
            );
        } catch (error) {
            this.logger.error('Task completion failed', error as Error);
            const peer = this.peers.get(message.peerId);
            if (peer) {
                this.sendError(peer.ws, 'Task completion failed');
            }
        }
    }

    private async handleTaskFailure(message: SignalingMessage): Promise<void> {
        if (!message.taskId || !message.peerId) return;

        const task = this.validatorSystem.getTaskStatus(message.taskId);
        if (!task) return;

        const peer = this.peers.get(message.peerId);
        if (!peer) return;

        // Notify global validator of failure
        const globalValidator = this.peers.get(task.submitter);
        if (globalValidator) {
            this.sendMessage(globalValidator.ws, {
                type: 'task_failed',
                taskId: message.taskId,
                error: message.error,
                timestamp: new Date().toISOString(),
                syncData: undefined
            });
        }
    }

    private async updateRegionInfo(region: string, peerId: string, nodeType: NodeType): Promise<void> {
        if (!this.regions.has(region)) {
            this.regions.set(region, {
                id: region,
                name: region,
                validators: new Set(),
                peers: new Set(),
                lastUpdate: new Date(),
                status: 'active',
                metrics: {
                    totalTasks: 0,
                    completedTasks: 0,
                    activeNodes: 0,
                    totalRewards: 0,
                    averageCompletionTime: 0,
                    successRate: 0
                }
            });
        }

        const regionInfo = this.regions.get(region)!;
        regionInfo.peers.add(peerId);
        
        if (nodeType !== 'individual') {
            regionInfo.validators.add(peerId);
        }
        
        regionInfo.lastUpdate = new Date();
        regionInfo.metrics = this.validatorSystem.getRegionMetrics(region);

        this.metricsCollector.updateRegionMetrics(
            region,
            Array.from(this.peers.values()).filter(p => p.info.region === region)
        );
    }

    private broadcastToPeerGroup(peerInfo: PeerInfo, message: SignalingMessage): void {
        const relevantPeers = Array.from(this.peers.values())
            .filter(p => p.info.region === peerInfo.region && p.info.peerId !== peerInfo.peerId);

        const messageStr = JSON.stringify(message);

        relevantPeers.forEach(peer => {
            if (peer.ws.readyState === WebSocket.OPEN) {
                peer.ws.send(messageStr);
            }
        });
    }

    private setupPeriodicTasks(): void {
        // Health checks
        setInterval(() => {
            this.performHealthChecks();
        }, config.env.network.healthCheckInterval);
    
        // Cleanup
        setInterval(() => {
            this.cleanupInactivePeers();
        }, config.env.network.cleanupInterval);
    
        // Metrics update
        setInterval(() => {
            this.updateMetrics();
        }, config.env.metrics.updateInterval);
    }

    private performHealthChecks(): void {
        this.peers.forEach(peer => {
            if (peer.ws.readyState === WebSocket.OPEN) {
                try {
                    peer.ws.ping();
                } catch (error) {
                    this.logger.error(`Health check failed for peer ${peer.info.peerId}`, error as Error);
                }
            }
        });
    }

    private cleanupInactivePeers(): void {
        const now = Date.now();
        const timeout = config.env.network.peerTimeout;

        this.peers.forEach((peer, peerId) => {
            if (now - peer.lastActivity.getTime() > timeout) {
                this.logger.info(`Removing inactive peer ${peerId}`);
                this.handleLeave(peerId);
            }
        });
    }

    private updateMetrics(): void {
        this.metricsCollector.updateNetworkMetrics(
            Array.from(this.peers.values()),
            Array.from(this.regions.values())
        );

        // Update region metrics
        this.regions.forEach((region, regionId) => {
            region.metrics = this.validatorSystem.getRegionMetrics(regionId);
        });
    }

    // signalingServer.ts continued...

    private sendNetworkState(ws: WebSocket): void {
        const networkState: SignalingMessage = {
            type: 'network_state',
            peers: Array.from(this.peers.values()).map(p => p.info),
            regions: Array.from(this.regions.entries()).map(([id, region]) => ({
                id,
                name: region.name,
                peerCount: region.peers.size,
                validatorCount: region.validators.size,
                metrics: region.metrics
            })),
            activeTasks: this.validatorSystem.getActiveTasks().length,
            completedTasks: Array.from(this.regions.values())
                .reduce((sum, region) => sum + region.metrics.completedTasks, 0),
            totalRewardsDistributed: Array.from(this.regions.values())
                .reduce((sum, region) => sum + region.metrics.totalRewards, 0),
            timestamp: new Date().toISOString(),
            syncData: undefined
        };
    
        this.sendMessage(ws, networkState);
    }

    private sendMessage(ws: WebSocket, message: SignalingMessage): void {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify(message));
            } catch (error) {
                this.logger.error('Failed to send message', error as Error);
            }
        }
    }

    private sendError(ws: WebSocket, message: string): void {
        this.sendMessage(ws, {
            type: 'error',
            error: message,
            timestamp: new Date().toISOString(),
            syncData: undefined
        });
    }

    private findPeerByWebSocket(ws: WebSocket): ConnectedPeer | undefined {
        return Array.from(this.peers.values()).find(peer => peer.ws === ws);
    }

    public handleDisconnection(ws: WebSocket): void {
        const peer = this.findPeerByWebSocket(ws);
        if (peer) {
            this.handleLeave(peer.info.peerId);
        }
    }

    // Public API methods
    public getPeerInfo(peerId: string): PeerInfo | undefined {
        return this.peers.get(peerId)?.info;
    }

    public getRegionInfo(regionId: string): RegionInfo | undefined {
        return this.regions.get(regionId);
    }

    public getNetworkState(): NetworkState {
        return {
            peers: Array.from(this.peers.values()).map(p => p.info),
            regions: Array.from(this.regions.entries()).map(([id, region]) => ({
                id,
                name: region.name,
                peerCount: region.peers.size,
                validatorCount: region.validators.size,
                metrics: region.metrics
            })),
            activeTasks: this.validatorSystem.getActiveTasks().length,
            completedTasks: Array.from(this.regions.values())
                .reduce((sum, region) => sum + region.metrics.completedTasks, 0),
            totalRewardsDistributed: Array.from(this.regions.values())
                .reduce((sum, region) => sum + region.metrics.totalRewards, 0),
            timestamp: new Date().toISOString()
        };
    }

    public getRegionValidators(region: string): PeerInfo[] {
        return Array.from(this.peers.values())
            .filter(peer => 
                peer.info.region === region && 
                peer.info.nodeType !== 'individual'
            )
            .map(peer => peer.info);
    }

    public getGlobalValidators(): PeerInfo[] {
        return Array.from(this.peers.values())
            .filter(peer => peer.info.nodeType === 'global_node')
            .map(peer => peer.info);
    }

    public getNodeMetrics(peerId: string): {
        tasks: number;
        completedTasks: number;
        earnings: number;
        performance: {
            successRate: number;
            avgCompletionTime: number;
        };
    } | undefined {
        const peer = this.peers.get(peerId);
        if (!peer) return undefined;

        const tasks = this.validatorSystem.getTasksForNode(peerId);
        const earnings = this.validatorSystem.getNodeEarnings(peerId);
        const completed = tasks.filter(t => t.status.state === 'completed');

        let avgCompletionTime = 0;
        if (completed.length > 0) {
            avgCompletionTime = completed.reduce((sum, task) => {
                const start = new Date(task.status.startTime!).getTime();
                const end = new Date(task.status.completionTime!).getTime();
                return sum + (end - start);
            }, 0) / completed.length;
        }

        return {
            tasks: tasks.length,
            completedTasks: completed.length,
            earnings,
            performance: {
                successRate: tasks.length > 0 ? (completed.length / tasks.length) * 100 : 0,
                avgCompletionTime
            }
        };
    }

    public getNetworkMetrics(): {
        totalPeers: number;
        activePeers: number;
        totalValidators: number;
        activeRegions: number;
        totalTasks: number;
        completedTasks: number;
        successRate: number;
        totalRewards: number;
    } {
        const peers = Array.from(this.peers.values());
        const validators = peers.filter(p => p.info.nodeType !== 'individual');
        const activeRegions = new Set(peers.map(p => p.info.region)).size;
        const tasks = this.validatorSystem.getActiveTasks();
        const completed = Array.from(this.regions.values())
            .reduce((sum, region) => sum + region.metrics.completedTasks, 0);
        const rewards = Array.from(this.regions.values())
            .reduce((sum, region) => sum + region.metrics.totalRewards, 0);

        return {
            totalPeers: peers.length,
            activePeers: peers.filter(p => p.status.online).length,
            totalValidators: validators.length,
            activeRegions,
            totalTasks: tasks.length,
            completedTasks: completed,
            successRate: tasks.length > 0 ? (completed / tasks.length) * 100 : 0,
            totalRewards: rewards
        };
    }

    public getPendingRewards(): Map<string, number> {
        return this.validatorSystem.getPendingRewards();
    }

    public async broadcastToValidators(message: SignalingMessage): Promise<void> {
        const validators = Array.from(this.peers.values())
            .filter(peer => peer.info.nodeType !== 'individual');

        for (const validator of validators) {
            if (validator.ws.readyState === WebSocket.OPEN) {
                await this.sendMessage(validator.ws, message);
            }
        }
    }

    public async broadcastToRegion(region: string, message: SignalingMessage): Promise<void> {
        const regionPeers = Array.from(this.peers.values())
            .filter(peer => peer.info.region === region);

        for (const peer of regionPeers) {
            if (peer.ws.readyState === WebSocket.OPEN) {
                await this.sendMessage(peer.ws, message);
            }
        }
    }

    async shutdown(): Promise<void> {

        console.log('Shutting down signaling server...');

    }
}

export default SignalingServer;