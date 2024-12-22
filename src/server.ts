// // tenzro-regional-node/src/server.ts
import express from 'express';
import { Server as WebSocketServer } from 'ws';
import { createServer } from 'http';
import { ValidatorNode } from './ValidatorNode';
import { Logger } from './utils/Logger';
import { SignalingMessage } from './types';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const logger = Logger.getInstance();

// Initialize validator node
const validatorNode = new ValidatorNode(
    process.env.NODE_TYPE as any || 'regional_node',
    process.env.NODE_TIER as any || 'training',
    parseInt(process.env.TOKEN_BALANCE || '10000'),
    process.env.REGION || 'us'
);

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        region: process.env.REGION,
        nodeType: process.env.NODE_TYPE,
        timestamp: new Date().toISOString()
    });
});

// Regional node info endpoint
app.get('/info', (req, res) => {
    res.json({
        nodeId: validatorNode.getNodeInfo().peerId,
        region: process.env.REGION,
        nodeType: process.env.NODE_TYPE,
        wsEndpoint: `wss://${req.headers.host}/ws`,
        timestamp: new Date().toISOString()
    });
});

// Initialize validator node when server starts
async function startServer() {
    try {
        await validatorNode.start();
        
        const port = process.env.PORT || 8080;
        server.listen(port, () => {
            logger.info(`Regional node server running on port ${port}`);
            logger.info(`Environment: ${process.env.NODE_ENV}`);
            logger.info(`Region: ${process.env.REGION}`);
            logger.info(`Node Type: ${process.env.NODE_TYPE}`);
        });

        // Handle WebSocket connections
        wss.on('connection', (ws) => {
            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message.toString()) as SignalingMessage;
                    // Forward message to signaling server
                    validatorNode.signalingServer.handleMessage(ws, data);
                } catch (error) {
                    logger.error('Failed to process message', error as Error);
                }
            });

            ws.on('close', () => {
                // Forward disconnection to signaling server
                validatorNode.signalingServer.handleDisconnection(ws);
            });
        });

        // Periodic status broadcast
        setInterval(() => {
            const status = validatorNode.getNodeInfo();
            wss.clients.forEach((client) => {
                if (client.readyState === client.OPEN) {
                    client.send(JSON.stringify({
                        type: 'status',
                        data: status,
                        timestamp: new Date().toISOString()
                    }));
                }
            });
        }, 30000); // Every 30 seconds

    } catch (error) {
        logger.error('Failed to start Regional node server', error as Error);
        process.exit(1);
    }
}

// Handle shutdown gracefully
async function shutdown() {
    logger.info('Shutting down Regional node server...');
    try {
        await validatorNode.stop();
        server.close();
        process.exit(0);
    } catch (error) {
        logger.error('Error during shutdown', error as Error);
        process.exit(1);
    }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start the server
startServer();