// // tenzro-regional-node/network/DHTNetwork.ts
import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import {
    DHTConfig,
    DHTNode,
    DHTAnnouncement,
    PeerFilter,
    DHTNetwork as IDHTNetwork,
    DirectConnectionInfo,
    DHTMessageType,
    DHTResponse
} from '../types';
import { Logger } from '../utils/Logger';
import config from '../config';

export class DHTNetwork extends EventEmitter implements IDHTNetwork {
    private nodes: Map<string, DHTNode> = new Map();
    private data: Map<string, any> = new Map();
    private directConnections: Map<string, DHTNode> = new Map();
    private activeConnections: Map<string, WebSocket> = new Map();
    private logger: Logger;
    private nodeId: string;
    private regionalNodes: string[];
    private connected: boolean = false;
    private refreshInterval: NodeJS.Timeout | null = null;

    constructor(config: DHTConfig) {
        super();
        this.logger = Logger.getInstance();
        this.logger.setContext('DHTNetwork');
        this.nodeId = config.nodeId;
        this.regionalNodes = config.regionalNodes;
    }

    public async join(): Promise<void> {
        try {
            // Connect to regional nodes
            for (const regionalNode of this.regionalNodes) {
                try {
                    await this.connectToNode(regionalNode);
                } catch (error) {
                    this.logger.warn(`Failed to connect to regional node ${regionalNode}`, error as Error);
                }
            }

            this.connected = true;
            this.logger.info(`Node ${this.nodeId} joined DHT network`);

            // Start periodic refresh
            this.startRefresh();

            // Restore direct connections if any
            for (const [nodeId, node] of this.directConnections) {
                try {
                    await this.reestablishDirectConnection(node);
                } catch (error) {
                    this.logger.warn(`Failed to restore direct connection to ${nodeId}`, error as Error);
                }
            }
        } catch (error) {
            this.logger.error('Failed to join DHT network', error as Error);
            throw error;
        }
    }

    public async leave(): Promise<void> {
        try {
            // Stop refresh interval
            if (this.refreshInterval) {
                clearInterval(this.refreshInterval);
            }

            // Notify connected nodes
            const leaveMessage: DHTMessageType = {
                type: 'leave',
                nodeId: this.nodeId,
                timestamp: new Date().toISOString()
            };

            await this.broadcastMessage(leaveMessage);

            // Close all connections
            for (const [_, ws] of this.activeConnections) {
                ws.close();
            }

            this.connected = false;
            this.nodes.clear();
            this.data.clear();
            this.activeConnections.clear();

            this.logger.info(`Node ${this.nodeId} left DHT network`);
        } catch (error) {
            this.logger.error('Failed to leave DHT network', error as Error);
            throw error;
        }
    }

    public async announce(announcement: DHTAnnouncement): Promise<void> {
        if (!this.connected) {
            throw new Error('Not connected to DHT network');
        }

        try {
            // Store announcement in DHT
            const key = `announcement:${this.nodeId}`;
            await this.store(key, {
                ...announcement,
                timestamp: new Date().toISOString()
            });

            // Broadcast to network
            const message: DHTMessageType = {
                type: 'announce',
                nodeId: this.nodeId,
                announcement,
                timestamp: new Date().toISOString()
            };

            await this.broadcastMessage(message);

            this.logger.info(`Announced presence in DHT network: ${JSON.stringify(announcement)}`);
        } catch (error) {
            this.logger.error('Failed to announce in DHT network', error as Error);
            throw error;
        }
    }

    public async findNode(nodeId: string): Promise<DHTNode | null> {
        if (!this.connected) {
            throw new Error('Not connected to DHT network');
        }

        // Check direct connections first
        if (this.directConnections.has(nodeId)) {
            return this.directConnections.get(nodeId)!;
        }

        // Check local routing table
        if (this.nodes.has(nodeId)) {
            return this.nodes.get(nodeId)!;
        }

        // Ask other nodes
        const message: DHTMessageType = {
            type: 'findNode',
            nodeId,
            timestamp: new Date().toISOString()
        };

        for (const [_, node] of this.nodes) {
            try {
                const response = await this.sendMessage(node, message);
                if (response && response.node) {
                    return response.node;
                }
            } catch (error) {
                this.logger.warn(`Failed to find node ${nodeId} through ${node.id}`, error as Error);
            }
        }

        return null;
    }

    public async findValue(key: string): Promise<any> {
        if (!this.connected) {
            throw new Error('Not connected to DHT network');
        }

        // Check local storage
        if (this.data.has(key)) {
            return this.data.get(key);
        }

        // Ask other nodes
        const message: DHTMessageType = {
            type: 'findValue',
            key,
            timestamp: new Date().toISOString()
        };

        for (const [_, node] of this.nodes) {
            try {
                const response = await this.sendMessage(node, message);
                if (response && response.value !== undefined) {
                    // Store locally for future use
                    this.data.set(key, response.value);
                    return response.value;
                }
            } catch (error) {
                this.logger.warn(`Failed to find value ${key} through ${node.id}`, error as Error);
            }
        }

        return null;
    }

    public async store(key: string, value: any): Promise<void> {
        if (!this.connected) {
            throw new Error('Not connected to DHT network');
        }

        try {
            // Store locally
            this.data.set(key, value);

            // Replicate to nearest nodes
            const message: DHTMessageType = {
                type: 'store',
                key,
                value,
                timestamp: new Date().toISOString()
            };

            const replicationFactor = config.env.network.dht.replicationFactor;
            const targets = Array.from(this.nodes.values()).slice(0, replicationFactor);

            const promises = targets.map(node => 
                this.sendMessage(node, message).catch(error => {
                    this.logger.warn(`Failed to replicate data to ${node.id}`, error as Error);
                })
            );

            await Promise.all(promises);
        } catch (error) {
            this.logger.error('Failed to store value in DHT', error as Error);
            throw error;
        }
    }

    public async getPeers(filter?: PeerFilter): Promise<DHTNode[]> {
        if (!this.connected) {
            throw new Error('Not connected to DHT network');
        }

        const peers: DHTNode[] = [];
        const seen = new Set<string>();

        // Add direct connections that match the filter
        for (const [_, node] of this.directConnections) {
            if (!seen.has(node.id) && this.matchesFilter(node, filter)) {
                seen.add(node.id);
                peers.push(node);
            }
        }

        // Add local DHT nodes that match the filter
        for (const [_, node] of this.nodes) {
            if (!seen.has(node.id) && this.matchesFilter(node, filter)) {
                seen.add(node.id);
                peers.push(node);
            }
        }

        // Ask other nodes for their peers
        const message: DHTMessageType = {
            type: 'getPeers',
            filter,
            timestamp: new Date().toISOString()
        };

        for (const [_, node] of this.nodes) {
            try {
                const response = await this.sendMessage(node, message);
                if (response && response.peers) {
                    for (const peer of response.peers) {
                        if (!seen.has(peer.id) && this.matchesFilter(peer, filter)) {
                            seen.add(peer.id);
                            peers.push(peer);
                        }
                    }
                }
            } catch (error) {
                this.logger.warn(`Failed to get peers from ${node.id}`, error as Error);
            }
        }

        return peers;
    }

    public async connectDirectly(connectionInfo: DirectConnectionInfo): Promise<DHTNode> {
        try {
            // Format the connection URL
            const protocol = connectionInfo.protocol || 'wss';
            const port = connectionInfo.port ? `:${connectionInfo.port}` : '';
            const wsUrl = `${protocol}://${connectionInfo.address}${port}/ws`;

            // Try to establish connection
            const node = await this.establishDirectConnection(wsUrl, connectionInfo);
            
            // Store in direct connections map
            this.directConnections.set(node.id, node);
            
            // Announce our direct connection to the network if we're connected
            if (this.connected) {
                await this.announceDirectConnection(node);
            }

            this.logger.info(`Established direct connection to node ${node.id}`);
            return node;

        } catch (error) {
            this.logger.error('Failed to establish direct connection', error as Error);
            throw error;
        }
    }

    public async disconnectDirect(nodeId: string): Promise<void> {
        const node = this.directConnections.get(nodeId);
        if (node) {
            const ws = this.activeConnections.get(nodeId);
            if (ws) {
                ws.close();
                this.activeConnections.delete(nodeId);
            }
            this.directConnections.delete(nodeId);
            this.logger.info(`Disconnected direct connection to node ${nodeId}`);
        }
    }

    private async connectToNode(address: string): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                const ws = new WebSocket(address);

                ws.on('open', () => {
                    const nodeId = `node_${Math.random().toString(36).substr(2, 9)}`;
                    const node: DHTNode = {
                        id: nodeId,
                        address,
                        lastSeen: new Date(),
                        metadata: {}
                    };

                    this.nodes.set(nodeId, node);
                    this.activeConnections.set(nodeId, ws);
                    
                    this.setupWebSocketHandlers(ws, node);
                    resolve();
                });

                ws.on('error', (error) => {
                    reject(error);
                });

            } catch (error) {
                reject(error);
            }
        });
    }

    private async establishDirectConnection(wsUrl: string, info: DirectConnectionInfo): Promise<DHTNode> {
        return new Promise((resolve, reject) => {
            try {
                const ws = new WebSocket(wsUrl);

                ws.on('open', async () => {
                    try {
                        // Request node information
                        const nodeInfo = await this.requestNodeInfo(ws);
                        
                        const node: DHTNode = {
                            id: info.nodeId || nodeInfo.nodeId || `node_${Math.random().toString(36).substr(2, 9)}`,
                            address: wsUrl,
                            lastSeen: new Date(),
                            metadata: {
                                region: info.region || nodeInfo.region,
                                directConnection: true,
                                ...nodeInfo
                            }
                        };

                        this.activeConnections.set(node.id, ws);
                        this.setupWebSocketHandlers(ws, node);

                        // Send our information
                        await this.sendNodeInfo(ws);
                        
                        resolve(node);

                    } catch (error) {
                        ws.close();
                        reject(error);
                    }
                });

                ws.on('error', (error) => {
                    reject(error);
                });

            } catch (error) {
                reject(error);
            }
        });
    }

    private async reestablishDirectConnection(node: DHTNode): Promise<void> {
        try {
            const ws = this.activeConnections.get(node.id);
            if (ws && ws.readyState === WebSocket.OPEN) {
                return; // Connection already active
            }

            await this.establishDirectConnection(node.address, {
                address: node.address,
                nodeId: node.id,
                region: node.metadata.region
            });
        } catch (error) {
            throw error;
        }
    }

    private setupWebSocketHandlers(ws: WebSocket, node: DHTNode): void {
        ws.on('message', async (data) => {
            try {
                const message: DHTMessageType = JSON.parse(data.toString());
                await this.handleMessage(node, message);
            } catch (error) {
                this.logger.error(`Failed to handle message from ${node.id}`, error as Error);
            }
        });

        ws.on('close', () => {
            this.handleNodeDisconnection(node);
        });

        ws.on('error', (error) => {
            this.logger.error(`WebSocket error with node ${node.id}`, error as Error);
            this.handleNodeDisconnection(node);
        });

        // Setup ping/pong for connection keepalive
        const pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.ping();
            } else {
                clearInterval(pingInterval);
            }
        }, config.env.network.healthCheckInterval);

        ws.on('pong', () => {
            node.lastSeen = new Date();
        });
    }

    private async handleMessage(node: DHTNode, message: DHTMessageType): Promise<void> {
        try {
            switch (message.type) {
                case 'findNode':
                    await this.handleFindNode(node, message);
                    break;
                case 'findValue':
                    await this.handleFindValue(node, message);
                    break;
                case 'store':
                    await this.handleStore(node, message);
                    break;
                case 'getPeers':
                    await this.handleGetPeers(node, message);
                    break;
                case 'announce':
                    await this.handleAnnouncement(node, message);
                    break;
                case 'info_request':
                    await this.handleInfoRequest(node, message);
                    break;
                case 'direct_connect':
                    await this.handleDirectConnect(node, message);
                    break;
                default:
                    this.logger.warn(`Unknown message type from ${node.id}: ${message.type}`);
            }
        } catch (error) {
            this.logger.error(`Error handling message from ${node.id}`, error as Error);
        }
    }

    private async handleNodeDisconnection(node: DHTNode): Promise<void> {
        this.nodes.delete(node.id);
        this.activeConnections.delete(node.id);
        
        if (this.directConnections.has(node.id)) {
            // For direct connections, try to reconnect
            try {
                await this.reestablishDirectConnection(node);
            } catch (error) {
                this.logger.warn(`Failed to reestablish connection to ${node.id}`, error as Error);
                this.directConnections.delete(node.id);
            }
        }
    }

    private async handleFindNode(node: DHTNode, message: DHTMessageType): Promise<void> {
        if (!message.nodeId) return;

        const targetNode = await this.findNode(message.nodeId);
        const response: DHTResponse = {
            type: 'findNode_response',
            node: targetNode || undefined,
            timestamp: new Date().toISOString()
        };

        await this.sendResponse(node, response);
    }

    private async handleFindValue(node: DHTNode, message: DHTMessageType): Promise<void> {
        if (!message.key) return;

        const value = this.data.get(message.key);
        const response: DHTResponse = {
            type: 'findValue_response',
            value,
            timestamp: new Date().toISOString()
        };

        await this.sendResponse(node, response);
    }

    private async handleStore(node: DHTNode, message: DHTMessageType): Promise<void> {
        if (!message.key || message.value === undefined) return;

        this.data.set(message.key, message.value);
        const response: DHTResponse = {
            type: 'store_response',
            timestamp: new Date().toISOString()
        };

        await this.sendResponse(node, response);
    }

    private async handleGetPeers(node: DHTNode, message: DHTMessageType): Promise<void> {
        const peers = await this.getPeers(message.filter);
        const response: DHTResponse = {
            type: 'getPeers_response',
            peers,
            timestamp: new Date().toISOString()
        };

        await this.sendResponse(node, response);
    }

    private async handleAnnouncement(node: DHTNode, message: DHTMessageType): Promise<void> {
        if (!message.announcement) return;

        const key = `announcement:${node.id}`;
        await this.store(key, {
            ...message.announcement,
            timestamp: new Date().toISOString()
        });
    }

    private async handleInfoRequest(node: DHTNode, message: DHTMessageType): Promise<void> {
        const response: DHTResponse = {
            type: 'info_response',
            info: {
                nodeId: this.nodeId,
                region: node.metadata.region,
                directConnection: node.metadata.directConnection
            },
            timestamp: new Date().toISOString()
        };

        await this.sendResponse(node, response);
    }

    private async handleDirectConnect(node: DHTNode, message: DHTMessageType): Promise<void> {
        // Store the direct connection information
        node.metadata.directConnection = true;
        this.directConnections.set(node.id, node);

        const response: DHTResponse = {
            type: 'direct_connect_response',
            timestamp: new Date().toISOString()
        };

        await this.sendResponse(node, response);
    }

    private async sendMessage(node: DHTNode, message: DHTMessageType): Promise<DHTResponse> {
        return new Promise((resolve, reject) => {
            const ws = this.activeConnections.get(node.id);
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                reject(new Error('WebSocket not open'));
                return;
            }

            const timeout = setTimeout(() => {
                reject(new Error('Message timeout'));
            }, config.env.network.dht.timeout);

            ws.once('message', (data) => {
                clearTimeout(timeout);
                try {
                    const response = JSON.parse(data.toString());
                    resolve(response);
                } catch (error) {
                    reject(error);
                }
            });

            ws.send(JSON.stringify(message));
        });
    }

    private async sendResponse(node: DHTNode, response: DHTResponse): Promise<void> {
        const ws = this.activeConnections.get(node.id);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(response));
        }
    }

    private async broadcastMessage(message: DHTMessageType): Promise<void> {
        const promises = Array.from(this.nodes.values())
            .map(node => this.sendMessage(node, message).catch(error => {
                this.logger.warn(`Failed to broadcast to ${node.id}`, error as Error);
            }));

        await Promise.allSettled(promises);
    }

    private async announceDirectConnection(node: DHTNode): Promise<void> {
        const announcement: DHTAnnouncement = {
            nodeType: 'direct_connection',
            region: node.metadata.region || 'unknown',
            endpoint: node.address
        };

        await this.announce(announcement);
    }

    private matchesFilter(node: DHTNode, filter?: PeerFilter): boolean {
        if (!filter) return true;

        if (filter.nodeType && node.metadata.nodeType !== filter.nodeType) return false;
        if (filter.region && node.metadata.region !== filter.region) return false;
        if (filter.minTokens && (node.metadata.tokenBalance || 0) < filter.minTokens) return false;
        if (filter.nodeTier && node.metadata.nodeTier !== filter.nodeTier) return false;

        return true;
    }

    private async requestNodeInfo(ws: WebSocket): Promise<any> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Node info request timeout'));
            }, config.env.network.dht.timeout);

            const message = {
                type: 'info_request',
                nodeId: this.nodeId,
                timestamp: new Date().toISOString()
            };

            ws.once('message', (data) => {
                clearTimeout(timeout);
                try {
                    const response = JSON.parse(data.toString());
                    if (response.type === 'info_response') {
                        resolve(response.info);
                    } else {
                        reject(new Error('Invalid info response'));
                    }
                } catch (error) {
                    reject(error);
                }
            });

            ws.send(JSON.stringify(message));
        });
    }

    private async sendNodeInfo(ws: WebSocket): Promise<void> {
        const message = {
            type: 'info_response',
            info: {
                nodeId: this.nodeId,
                // Add any other relevant node information
            },
            timestamp: new Date().toISOString()
        };

        ws.send(JSON.stringify(message));
    }

    private startRefresh(): void {
        this.refreshInterval = setInterval(
            () => this.refresh(),
            config.env.network.dht.refreshInterval
        );
    }

    private async refresh(): Promise<void> {
        const now = new Date();
        const staleTimeout = config.env.network.peerTimeout;

        // Remove stale nodes
        for (const [nodeId, node] of this.nodes) {
            const age = now.getTime() - node.lastSeen.getTime();
            if (age > staleTimeout) {
                this.nodes.delete(nodeId);
                this.activeConnections.delete(nodeId);
            }
        }

        // Try to maintain minimum number of connections
        if (this.nodes.size < 3 && this.regionalNodes.length > 0) {
            const randomregional = this.regionalNodes[
                Math.floor(Math.random() * this.regionalNodes.length)
            ];
            try {
                await this.connectToNode(randomregional);
            } catch (error) {
                this.logger.warn(`Failed to connect to regional node ${randomregional}`, error as Error);
            }
        }

        // Refresh direct connections
        for (const [nodeId, node] of this.directConnections) {
            try {
                await this.reestablishDirectConnection(node);
            } catch (error) {
                this.logger.warn(`Failed to refresh direct connection to ${nodeId}`, error as Error);
            }
        }
    }
}