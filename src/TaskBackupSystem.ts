// // tenzro-regional-node/src/TaskBackupSystem.ts
import { Task, SignalingMessage, ConnectedPeer } from './types';
import { Logger } from './utils/Logger';
import config from './config';

interface TaskBackupConfig {
    backupInterval: number;
}

export class TaskBackupSystem {
    private logger: Logger;
    private taskBackups: Map<string, Task[]> = new Map();
    private backupInterval: NodeJS.Timeout | null = null;

    constructor() {
        this.logger = Logger.getInstance();
        this.logger.setContext('TaskBackupSystem');
    }

    public start(): void {
        this.backupInterval = setInterval(
            () => this.performBackups(),
            config.env.tasks.backupInterval
        );
    }
    
    public stop(): void {
        if (this.backupInterval) {
            clearInterval(this.backupInterval);
        }
    }

    public async backupTask(task: Task, backupNodes: ConnectedPeer[]): Promise<void> {
        try {
            const backups = backupNodes.slice(0, task.requirements.redundancy || 2);
            const backupMessage: SignalingMessage = {
                type: 'task_backup',
                task,
                timestamp: new Date().toISOString(),
                syncData: undefined
            };

            // Store backup copies on multiple nodes
            const promises = backups.map(node => 
                this.sendBackupToNode(node, backupMessage)
            );

            await Promise.all(promises);
            this.taskBackups.set(task.taskId, backups.map(n => task));
            
            this.logger.info(`Task ${task.taskId} backed up to ${backups.length} nodes`);
        } catch (error) {
            this.logger.error(`Failed to backup task ${task.taskId}`, error as Error);
            throw error;
        }
    }

    public async recoverTask(taskId: string, targetNode: ConnectedPeer): Promise<Task | null> {
        const backups = this.taskBackups.get(taskId);
        if (!backups || backups.length === 0) {
            return null;
        }

        try {
            // Use the most recent backup
            const task = backups[backups.length - 1];
            
            const recoveryMessage: SignalingMessage = {
                type: 'task_recovery',
                task,
                timestamp: new Date().toISOString(),
                syncData: undefined
            };

            await this.sendBackupToNode(targetNode, recoveryMessage);
            this.logger.info(`Task ${taskId} recovered to node ${targetNode.info.peerId}`);
            
            return task;
        } catch (error) {
            this.logger.error(`Failed to recover task ${taskId}`, error as Error);
            return null;
        }
    }

    private async sendBackupToNode(node: ConnectedPeer, message: SignalingMessage): Promise<void> {
        return new Promise((resolve, reject) => {
            if (node.ws.readyState !== node.ws.OPEN) {
                reject(new Error('WebSocket not open'));
                return;
            }

            try {
                node.ws.send(JSON.stringify(message), (error) => {
                    if (error) reject(error);
                    else resolve();
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    private async performBackups(): Promise<void> {
        // Implement periodic backup logic here
        this.logger.info('Performing periodic task backups');
    }

    // Additional utility methods
    public getBackupCount(taskId: string): number {
        return this.taskBackups.get(taskId)?.length || 0;
    }

    public clearTaskBackups(taskId: string): void {
        this.taskBackups.delete(taskId);
    }

    public async validateBackups(): Promise<{
        taskId: string;
        valid: boolean;
        backupCount: number;
    }[]> {
        const validations = [];
        
        for (const [taskId, backups] of this.taskBackups.entries()) {
            validations.push({
                taskId,
                valid: backups.length >= 2,
                backupCount: backups.length
            });
        }

        return validations;
    }
}