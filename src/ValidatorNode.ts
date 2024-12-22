// // tenzro-regional-node/src/ValidatorNode.ts
import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocket } from 'ws';
import { SignalingServer } from './signalingServer';
import { ValidatorSystem } from './ValidatorSystem';
import { MetricsCollector } from './MetricsCollector';
import { Logger } from './utils/Logger';
import config from './config';
import {
    NodeType,
    NodeTier,
    PeerInfo,
    NODE_REQUIREMENTS,
    DHTNetwork as IDHTNetwork,
    SignalingMessage
} from './types';
import { DHTNetwork } from './network/DHTNetwork'; 

export class ValidatorNode {
    private server: http.Server;
    private app: express.Express;
    public signalingServer: SignalingServer;
    private validatorSystem: ValidatorSystem;
    private metricsCollector: MetricsCollector;
    private logger: Logger;
    private dht: IDHTNetwork;
    private nodeInfo: PeerInfo;
    private ws: WebSocket | null = null;

    constructor(
        private nodeType: NodeType,
        private nodeTier: NodeTier,
        private tokenBalance: number,
        private region: string,
        private port: number = 8080
    ) {
        this.logger = Logger.getInstance();
        this.logger.setContext('ValidatorNode');

        // Initialize Express app
        this.app = express();
        this.app.use(cors());
        this.app.use(express.json());
        
        // Create HTTP server
        this.server = http.createServer(this.app);

        // Initialize core components
        this.validatorSystem = new ValidatorSystem();
        this.metricsCollector = new MetricsCollector();
        
        // Create node info
        this.nodeInfo = {
            peerId: this.generatePeerId(),
            nodeType: this.nodeType,
            nodeTier: this.nodeTier,
            region: this.region,
            tokenBalance: this.tokenBalance,
            connected: false,
            lastSeen: new Date().toISOString()
        };

        // Initialize signaling server
        this.signalingServer = new SignalingServer(this.server);

        // Initialize DHT network
        this.dht = new DHTNetwork({
            nodeId: this.nodeInfo.peerId,
            regionalNodes: config.env.network.RegionalNodes
        });

        this.setupRoutes();
    }

    private generatePeerId(): string {
        return `node_${Math.random().toString(36).substr(2, 9)}_${Date.now()}`;
    }

    private setupRoutes(): void {
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({ 
                status: 'healthy',
                nodeType: this.nodeType,
                region: this.region,
                timestamp: new Date().toISOString()
            });
        });

        // Network status endpoint
        this.app.get('/api/network/status', (req, res) => {
            try {
                const networkState = this.signalingServer.getNetworkState();
                res.json(networkState);
            } catch (error) {
                this.logger.error('Failed to get network status', error as Error);
                res.status(500).json({ error: 'Failed to get network status' });
            }
        });

        // Region info endpoint
        this.app.get('/api/network/regions', (req, res) => {
            try {
                const regionId = req.query.regionId as string;
                const regionInfo = regionId ? 
                    this.signalingServer.getRegionInfo(regionId) :
                    Array.from(Object.values(this.signalingServer.getNetworkState().regions));
                res.json(regionInfo);
            } catch (error) {
                this.logger.error('Failed to get region info', error as Error);
                res.status(500).json({ error: 'Failed to get region info' });
            }
        });
    }

    private validateNodeRequirements(): boolean {
        const requirements = NODE_REQUIREMENTS[this.nodeType];
        
        // Check token balance
        if (this.tokenBalance < requirements.minTokens) {
            this.logger.warn(`Insufficient tokens for ${this.nodeType}. Required: ${requirements.minTokens}, Have: ${this.tokenBalance}`);
            return false;
        }

        // Check node tier
        const tierLevels: { [key in NodeTier]: number } = {
            'inference': 1,
            'aggregator': 2,
            'training': 3,
            'feedback': 4
        };

        const requiredTierLevel = tierLevels[requirements.minTier];
        const currentTierLevel = tierLevels[this.nodeTier];

        if (currentTierLevel < requiredTierLevel) {
            this.logger.warn(`Insufficient node tier for ${this.nodeType}. Required: ${requirements.minTier}, Have: ${this.nodeTier}`);
            return false;
        }

        return true;
    }

    public async start(): Promise<void> {
        try {
            // Validate node requirements
            if (!this.validateNodeRequirements()) {
                this.logger.warn('Node does not meet validator requirements. Starting as individual node.');
                this.nodeType = 'individual';
                this.nodeInfo.nodeType = 'individual';
            }

            // Join DHT network
            await this.dht.join();
            this.logger.info(`Joined DHT network as ${this.nodeType}`);

            // Start server
            await new Promise<void>((resolve) => {
                this.server.listen(this.port, () => {
                    this.logger.info(`Validator node running on port ${this.port}`);
                    this.logger.info(`Node type: ${this.nodeType}`);
                    this.logger.info(`Region: ${this.region}`);
                    resolve();
                });
            });

            // Connect to network
            await this.connectToNetwork();

            // Setup error handlers
            this.setupErrorHandlers();

        } catch (error) {
            this.logger.error('Failed to start validator node', error as Error);
            throw error;
        }
    }

    private async connectToNetwork(): Promise<void> {
        try {
            // If running as validator, announce presence to DHT
            if (this.nodeType !== 'individual') {
                await this.dht.announce({
                    nodeType: this.nodeType,
                    region: this.region,
                    endpoint: `ws://localhost:${this.port}/ws`
                });
            }

            // Create join message
            const joinMessage: SignalingMessage = {
                type: 'join',
                peerId: this.nodeInfo.peerId,
                nodeType: this.nodeType,
                nodeTier: this.nodeTier,
                tokenBalance: this.tokenBalance,
                region: this.region,
                timestamp: new Date().toISOString(),
                syncData: undefined
            };

            // Connect to WebSocket
            this.ws = new WebSocket(`ws://localhost:${this.port}/ws`);
            
            await new Promise<void>((resolve, reject) => {
                if (!this.ws) return reject(new Error('WebSocket not initialized'));
                
                this.ws.on('open', () => {
                    this.ws?.send(JSON.stringify(joinMessage));
                    resolve();
                });
                
                this.ws.on('error', (error) => {
                    reject(error);
                });
            });

        } catch (error) {
            this.logger.error('Failed to connect to network', error as Error);
            throw error;
        }
    }

    private setupErrorHandlers(): void {
        process.on('unhandledRejection', (error: Error) => {
            this.logger.error('Unhandled Promise rejection', error);
        });

        process.on('uncaughtException', (error: Error) => {
            this.logger.error('Uncaught exception', error);
            process.exit(1);
        });
    }

    public async stop(): Promise<void> {
        try {
            // Leave DHT network
            await this.dht.leave();

            // Send leave message
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                const leaveMessage: SignalingMessage = {
                    type: 'leave',
                    peerId: this.nodeInfo.peerId,
                    timestamp: new Date().toISOString(),
                    syncData: undefined
                };
                this.ws.send(JSON.stringify(leaveMessage));
                this.ws.close();
            }

            // Close server
            await new Promise<void>((resolve, reject) => {
                this.server.close((err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            this.logger.info('Validator node stopped');
        } catch (error) {
            this.logger.error('Error stopping validator node', error as Error);
            throw error;
        }
    }

    public getNodeInfo(): PeerInfo {
        return this.nodeInfo;
    }

    public getNodeMetrics() {
        return this.metricsCollector.getLatestNetworkMetrics();
    }
}

export default ValidatorNode;