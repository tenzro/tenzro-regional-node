// // tenzro-regional-node/src/validatorMain.ts
import { ValidatorNode } from './ValidatorNode';
import { Logger } from './utils/Logger';
import { envConfig } from './config';
import { NodeType, NodeTier } from './types';
import path from 'path';
import dotenv from 'dotenv';

// Initialize logger
const logger = Logger.getInstance();
logger.setContext('ValidatorMain');

// Load environment variables
const envPath = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
dotenv.config({ path: path.join(process.cwd(), envPath) });

interface ValidatorConfig {
    nodeType: NodeType;
    nodeTier: NodeTier;
    tokenBalance: number;
    region: string;
    port: number;
}

async function validateConfig(): Promise<ValidatorConfig> {
    const { node } = envConfig;

    // Validate token balance based on node type
    if (node.type === 'regional_node' && node.tokenBalance < envConfig.validator.regionalTokenRequirement) {
        throw new Error(`Regional validator requires minimum ${envConfig.validator.regionalTokenRequirement} tokens`);
    }

    if (node.type === 'global_node' && node.tokenBalance < envConfig.validator.globalTokenRequirement) {
        throw new Error(`Global validator requires minimum ${envConfig.validator.globalTokenRequirement} tokens`);
    }

    // Validate node tier requirements
    const tierLevels: { [key in NodeTier]: number } = {
        'inference': 1,
        'aggregator': 2,
        'training': 3,
        'feedback': 4
    };

    const minTierLevel = node.type === 'global_node' ? 
        tierLevels.training : 
        node.type === 'regional_node' ? 
            tierLevels.aggregator : 
            tierLevels.inference;

    if (tierLevels[node.tier] < minTierLevel) {
        throw new Error(`Node tier ${node.tier} is insufficient for ${node.type}`);
    }

    // Validate region
    if (!node.region || node.region.trim() === '') {
        throw new Error('Region must be specified');
    }

    // Validate port
    if (node.port < 1024 || node.port > 65535) {
        throw new Error('Port must be between 1024 and 65535');
    }

    return {
        nodeType: node.type,
        nodeTier: node.tier,
        tokenBalance: node.tokenBalance,
        region: node.region,
        port: node.port
    };
}

async function shutdownGracefully(validatorNode: ValidatorNode): Promise<void> {
    logger.info('Initiating graceful shutdown...');
    try {
        await validatorNode.stop();
        logger.info('Validator node stopped successfully');
        process.exit(0);
    } catch (error) {
        logger.error('Error during shutdown', error as Error);
        process.exit(1);
    }
}

async function main() {
    let validatorNode: ValidatorNode | null = null;

    try {
        // Validate configuration
        logger.info('Validating configuration...');
        const config = await validateConfig();

        // Log startup configuration
        logger.info('Starting validator node with configuration:', {
            nodeType: config.nodeType,
            nodeTier: config.nodeTier,
            region: config.region,
            port: config.port,
            tokenBalance: config.tokenBalance
        });

        // Initialize validator node
        validatorNode = new ValidatorNode(
            config.nodeType,
            config.nodeTier,
            config.tokenBalance,
            config.region,
            config.port
        );

        // Setup signal handlers
        process.on('SIGTERM', async () => {
            logger.info('Received SIGTERM signal');
            if (validatorNode) {
                await shutdownGracefully(validatorNode);
            }
        });

        process.on('SIGINT', async () => {
            logger.info('Received SIGINT signal');
            if (validatorNode) {
                await shutdownGracefully(validatorNode);
            }
        });

        // Handle uncaught errors
        process.on('uncaughtException', async (error: Error) => {
            logger.error('Uncaught exception', error);
            if (validatorNode) {
                await shutdownGracefully(validatorNode);
            }
        });

        process.on('unhandledRejection', async (reason: any) => {
            logger.error('Unhandled rejection', reason);
            if (validatorNode) {
                await shutdownGracefully(validatorNode);
            }
        });

        // Start the validator node
        await validatorNode.start();
        logger.info('Validator node started successfully');

        // Log successful startup
        logger.info(`Validator node running at http://localhost:${config.port}`);
        logger.info('Press CTRL-C to stop');

    } catch (error) {
        logger.error('Failed to start validator node', error as Error);
        
        // Attempt cleanup if initialization was partial
        if (validatorNode) {
            try {
                await validatorNode.stop();
            } catch (cleanupError) {
                logger.error('Error during cleanup after failed start', cleanupError as Error);
            }
        }
        
        process.exit(1);
    }
}

// Execute main function
if (require.main === module) {
    main().catch(error => {
        logger.error('Fatal error in main process', error as Error);
        process.exit(1);
    });
}

export { main, validateConfig };