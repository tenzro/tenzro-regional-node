// // tenzro-regional-node/src/ValidatorSystem.ts
import { EventEmitter } from 'events';
import {
    NodeType,
    NodeTier,
    PeerInfo,
    ConnectedPeer,
    SignalingMessage,
    Task,
    TaskType,
    TaskStatus,
    TASK_TIER_REQUIREMENTS
} from './types';
import { Logger } from './utils/Logger';
import config from './config';

export class ValidatorSystem extends EventEmitter {
    private logger: Logger;
    private globalValidators: Map<string, ConnectedPeer> = new Map();
    private regionalValidators: Map<string, Map<string, ConnectedPeer>> = new Map();
    private individualNodes: Map<string, Map<string, ConnectedPeer>> = new Map();
    private activeTasks: Map<string, Task> = new Map();
    private taskTimeouts: Map<string, NodeJS.Timeout> = new Map();
    private rewardDistributions: Map<string, Map<string, number>> = new Map();

    constructor() {
        super();
        this.setMaxListeners(0); // Remove default limit if needed
        this.logger = Logger.getInstance();
        this.logger.setContext('ValidatorSystem');
        this.setupTaskCleanup();
    }


    public addNode(peer: ConnectedPeer): void {
        const { peerId, nodeType, region } = peer.info;

        // Initialize region maps if needed
        if (!this.regionalValidators.has(region)) {
            this.regionalValidators.set(region, new Map());
        }
        if (!this.individualNodes.has(region)) {
            this.individualNodes.set(region, new Map());
        }

        // Add to appropriate collection
        switch (nodeType) {
            case 'global_node':
                this.globalValidators.set(peerId, peer);
                break;
            case 'regional_node':
                this.regionalValidators.get(region)!.set(peerId, peer);
                break;
            case 'individual':
                this.individualNodes.get(region)!.set(peerId, peer);
                break;
        }

        this.logger.info(`Added ${nodeType} node ${peerId} to region ${region}`);
    }

    public removeNode(peerId: string, nodeType: NodeType, region: string): void {
        // Clean up any active tasks for the node
        this.activeTasks.forEach(task => {
            if (task.status.assignedNodes.includes(peerId)) {
                this.handleNodeFailure(task.taskId, peerId);
            }
        });

        // Remove from appropriate collection
        switch (nodeType) {
            case 'global_node':
                this.globalValidators.delete(peerId);
                break;
            case 'regional_node':
                this.regionalValidators.get(region)?.delete(peerId);
                break;
            case 'individual':
                this.individualNodes.get(region)?.delete(peerId);
                break;
        }
    }

    public async broadcastTask(task: Task, sourceGlobalValidator: string): Promise<void> {
        // Validate task requirements
        if (!this.validateTaskRequirements(task)) {
            throw new Error('Invalid task requirements');
        }

        // Store task
        this.activeTasks.set(task.taskId, task);

        // Setup task timeout
        this.setupTaskTimeout(task);

        // Broadcast to regional validators
        for (const [region, validators] of this.regionalValidators.entries()) {
            const eligibleValidators = Array.from(validators.values())
                .filter(v => v.status.online);

            if (eligibleValidators.length === 0) continue;

            const targetValidator = this.selectRegionalValidator(eligibleValidators);
            if (targetValidator) {
                const message: SignalingMessage = {
                    type: 'task_broadcast',
                    task,
                    timestamp: new Date().toISOString(),
                    syncData: undefined
                };

                await this.forwardMessage(targetValidator, message);
            }
        }

        this.logger.info(`Task ${task.taskId} broadcasted to network`);
    }

    public async handleRegionalTaskDistribution(
        task: Task,
        region: string,
        sourceValidator: string
    ): Promise<void> {
        const nodes = this.individualNodes.get(region);
        if (!nodes) return;

        const eligibleNodes = Array.from(nodes.values())
            .filter(node => this.isNodeEligibleForTask(node, task))
            .slice(0, task.requirements.maxNodes);

        if (eligibleNodes.length === 0) {
            this.logger.warn(`No eligible nodes found in region ${region} for task ${task.taskId}`);
            return;
        }

        // Calculate reward per node
        const rewardPerNode = this.calculateNodeReward(task, eligibleNodes.length);

        // Assign task to eligible nodes
        for (const node of eligibleNodes) {
            const assignmentMessage: SignalingMessage = {
                type: 'task_assignment',
                task: {
                    ...task,
                    reward: {
                        ...task.reward,
                        perNode: rewardPerNode
                    },
                    status: {
                        ...task.status,
                        assignedNodes: [...task.status.assignedNodes, node.info.peerId]
                    }
                },
                syncData: undefined
            };

            await this.forwardMessage(node, assignmentMessage);
        }

        // Update task status
        task.status.assignedNodes.push(...eligibleNodes.map(n => n.info.peerId));
        this.activeTasks.set(task.taskId, task);
    }

    public async handleTaskAcceptance(taskId: string, peerId: string): Promise<void> {
        const task = this.activeTasks.get(taskId);
        if (!task) return;

        // Update task status
        task.status.acceptedNodes.push(peerId);
        if (!task.status.startTime) {
            task.status.startTime = new Date().toISOString();
            task.status.state = 'processing';
        }

        this.activeTasks.set(taskId, task);

        // Initialize reward tracking
        if (!this.rewardDistributions.has(taskId)) {
            this.rewardDistributions.set(taskId, new Map());
        }
    }

    public async handleTaskCompletion(
        taskId: string,
        peerId: string,
        result: any
    ): Promise<void> {
        const task = this.activeTasks.get(taskId);
        if (!task) return;

        // Validate completion time and calculate reward
        const completionTime = new Date();
        const startTime = new Date(task.status.startTime!);
        const duration = (completionTime.getTime() - startTime.getTime()) / 1000;

        let reward = task.reward.perNode;
        if (duration > task.requirements.estimatedDuration) {
            // Apply penalty for late completion
            const penalty = (duration - task.requirements.estimatedDuration) / 
                task.requirements.estimatedDuration * task.reward.penaltyRate;
            reward *= (1 - Math.min(penalty, 1));
        }

        // Store reward for distribution
        const taskRewards = this.rewardDistributions.get(taskId)!;
        taskRewards.set(peerId, reward);

        // Check if all nodes have completed
        const completedNodes = taskRewards.size;
        if (completedNodes === task.status.acceptedNodes.length) {
            await this.finalizeTask(task, completionTime.toISOString());
        }
    }

    private async finalizeTask(task: Task, completionTime: string): Promise<void> {
        task.status.state = 'completed';
        task.status.completionTime = completionTime;

        // Distribute rewards
        const taskRewards = this.rewardDistributions.get(task.taskId)!;
        const validatorReward = task.reward.total * (task.reward.validatorShare / 100);
        const validators = this.getTaskValidators(task);

        // Distribute validator rewards
        const validatorShare = validatorReward / validators.length;
        validators.forEach(validator => {
            taskRewards.set(validator.info.peerId, validatorShare);
        });

        // Send reward distribution messages
        for (const [peerId, reward] of taskRewards.entries()) {
            const peer = this.findPeer(peerId);
            if (peer) {
                const message: SignalingMessage = {
                    type: 'reward_distribution',
                    taskId: task.taskId,
                    reward,
                    timestamp: new Date().toISOString(),
                    syncData: undefined
                };
                await this.forwardMessage(peer, message);
            }
        }

        // Cleanup
        this.cleanupTask(task.taskId);
    }

    private validateTaskRequirements(task: Task): boolean {
        const tierReqs = TASK_TIER_REQUIREMENTS[task.type];
        
        return (
            tierReqs.tiers.includes(task.requirements.minTier) &&
            task.reward.total >= tierReqs.minReward &&
            task.reward.validatorShare === tierReqs.validatorShare &&
            task.requirements.estimatedDuration >= config.env.tasks.minTaskDuration && 
            task.requirements.estimatedDuration <= config.env.tasks.maxTaskDuration &&
            task.requirements.maxNodes <= config.env.tasks.maxNodesPerTask
        );
    }

    private isNodeEligibleForTask(node: ConnectedPeer, task: Task): boolean {
        const { nodeTier } = node.info;
        const { requirements } = task;

        // Check tier requirements
        if (!TASK_TIER_REQUIREMENTS[task.type].tiers.includes(nodeTier)) {
            return false;
        }

        // Check node status and resources
        const resources = node.status.resources;
        
        if (requirements.minStorage && resources.storage < requirements.minStorage) {
            return false;
        }

        if (requirements.minMemory && resources.memory < requirements.minMemory) {
            return false;
        }

        if (requirements.gpuRequired && !['training', 'feedback'].includes(nodeTier)) {
            return false;
        }

        // Check node's current task load
        if (node.status.activeTasks >= this.getMaxTasksForTier(nodeTier)) {
            return false;
        }

        return true;
    }

    private getMaxTasksForTier(tier: NodeTier): number {
        const maxTasks: Record<NodeTier, number> = {
            inference: 5,
            aggregator: 10,
            training: 15,
            feedback: 20
        };
        return maxTasks[tier];
    }

    private calculateNodeReward(task: Task, nodeCount: number): number {
        const totalNodeReward = task.reward.total * (1 - task.reward.validatorShare / 100);
        return totalNodeReward / nodeCount;
    }

    private selectRegionalValidator(validators: ConnectedPeer[]): ConnectedPeer {
        return validators.sort((a, b) => 
            (a.status.activeTasks - b.status.activeTasks) || 
            (b.status.completedTasks - a.status.completedTasks)
        )[0];
    }

    private getTaskValidators(task: Task): ConnectedPeer[] {
        const validators: ConnectedPeer[] = [];
        
        // Get global validator that broadcasted the task
        const globalValidator = this.globalValidators.get(task.submitter);
        if (globalValidator) validators.push(globalValidator);

        // Get regional validators involved in distribution
        task.status.assignedNodes.forEach(nodeId => {
            const nodePeer = this.findPeer(nodeId);
            if (nodePeer) {
                const regionalValidator = this.getRegionalValidatorForNode(
                    nodePeer.info.region
                );
                if (regionalValidator && !validators.includes(regionalValidator)) {
                    validators.push(regionalValidator);
                }
            }
        });

        return validators;
    }

    private getRegionalValidatorForNode(region: string): ConnectedPeer | undefined {
        const validators = this.regionalValidators.get(region);
        if (!validators) return undefined;
        return Array.from(validators.values())[0];
    }

    private findPeer(peerId: string): ConnectedPeer | undefined {
        return (
            this.globalValidators.get(peerId) ||
            Array.from(this.regionalValidators.values())
                .flatMap(m => Array.from(m.values()))
                .find(p => p.info.peerId === peerId) ||
            Array.from(this.individualNodes.values())
                .flatMap(m => Array.from(m.values()))
                .find(p => p.info.peerId === peerId)
        );
    }

    private async forwardMessage(peer: ConnectedPeer, message: SignalingMessage): Promise<void> {
        if (peer.ws.readyState === peer.ws.OPEN) {
            try {
                peer.ws.send(JSON.stringify(message));
            } catch (error) {
                this.logger.error(`Failed to forward message to ${peer.info.peerId}`, error as Error);
                throw error;
            }
        }
    }

    private setupTaskTimeout(task: Task): void {
        const timeout = setTimeout(() => {
            this.handleTaskTimeout(task.taskId);
        }, config.env.tasks.taskTimeout * 1000);  // Updated path
    
        this.taskTimeouts.set(task.taskId, timeout);
    }

    private handleTaskTimeout(taskId: string): void {
        const task = this.activeTasks.get(taskId);
        if (!task || task.status.state !== 'pending') return;

        task.status.state = 'failed';
        task.status.error = 'Task timed out waiting for acceptance';
        
        this.cleanupTask(taskId);
    }

    private handleNodeFailure(taskId: string, nodeId: string): void {
        const task = this.activeTasks.get(taskId);
        if (!task) return;

        // Remove node from task
        task.status.assignedNodes = task.status.assignedNodes.filter(id => id !== nodeId);
        task.status.acceptedNodes = task.status.acceptedNodes.filter(id => id !== nodeId);

        // If no nodes left, mark task as failed
        if (task.status.assignedNodes.length === 0) {
            task.status.state = 'failed';
            task.status.error = 'All assigned nodes failed';
            this.cleanupTask(taskId);
        }
    }

    private cleanupTask(taskId: string): void {
        // Clear timeout
        const timeout = this.taskTimeouts.get(taskId);
        if (timeout) {
            clearTimeout(timeout);
            this.taskTimeouts.delete(taskId);
        }

        // Clean up reward distributions
        this.rewardDistributions.delete(taskId);

        // Keep task in activeTasks for history until explicit cleanup
    }

    
    private setupTaskCleanup(): void {
        setInterval(() => {
            const now = Date.now();
            this.activeTasks.forEach((task, taskId) => {
                if (task.status.state === 'completed' || task.status.state === 'failed') {
                    const taskTime = new Date(task.timestamp).getTime();
                    if (now - taskTime > config.env.metrics.retentionPeriod) {
                        this.activeTasks.delete(taskId);
                    }
                }
            });
        }, config.env.metrics.updateInterval);
    }

    // Public API methods
    public getTaskStatus(taskId: string): Task | undefined {
        return this.activeTasks.get(taskId);
    }

    public getActiveTasks(): Task[] {
        return Array.from(this.activeTasks.values())
            .filter(task => task.status.state !== 'completed' && task.status.state !== 'failed');
    }

    public getTasksForNode(peerId: string): Task[] {
        return Array.from(this.activeTasks.values())
            .filter(task => task.status.assignedNodes.includes(peerId));
    }

    public getNodeEarnings(peerId: string): number {
        let total = 0;
        this.rewardDistributions.forEach(rewards => {
            const reward = rewards.get(peerId);
            if (reward) total += reward;
        });
        return total;
    }

    public getRegionTasks(region: string): Task[] {
        return Array.from(this.activeTasks.values())
            .filter(task => {
                const assignedNodes = task.status.assignedNodes
                    .map(nodeId => this.findPeer(nodeId))
                    .filter(peer => peer?.info.region === region);
                return assignedNodes.length > 0;
            });
    }

    public getRegionMetrics(region: string) {
        const regionTasks = this.getRegionTasks(region);
        const completedTasks = regionTasks.filter(t => t.status.state === 'completed');
        const totalRewards = Array.from(this.rewardDistributions.values())
            .reduce((sum, rewards) => {
                rewards.forEach((reward, peerId) => {
                    const peer = this.findPeer(peerId);
                    if (peer?.info.region === region) sum += reward;
                });
                return sum;
            }, 0);

        const activeNodes = this.individualNodes.get(region)?.size || 0;
        
        let avgCompletionTime = 0;
        if (completedTasks.length > 0) {
            avgCompletionTime = completedTasks.reduce((sum, task) => {
                const start = new Date(task.status.startTime!).getTime();
                const end = new Date(task.status.completionTime!).getTime();
                return sum + (end - start);
            }, 0) / completedTasks.length;
        }

        return {
            totalTasks: regionTasks.length,
            completedTasks: completedTasks.length,
            activeNodes,
            totalRewards,
            averageCompletionTime: avgCompletionTime,
            successRate: regionTasks.length > 0 ? 
                completedTasks.length / regionTasks.length * 100 : 0
        };
    }

    public async updateTaskProgress(
        taskId: string, 
        peerId: string, 
        progress: number
    ): Promise<void> {
        const task = this.activeTasks.get(taskId);
        if (!task) return;

        if (!task.status.assignedNodes.includes(peerId)) {
            throw new Error('Node not assigned to task');
        }

        // Update overall task progress
        const nodeCount = task.status.acceptedNodes.length;
        const progressPerNode = 100 / nodeCount;
        task.status.progress = Math.min(
            Math.floor(progress * progressPerNode),
            100
        );

        // Notify relevant validators of progress
        const progressMessage: SignalingMessage = {
            type: 'task_progress',
            taskId,
            progress: task.status.progress,
            timestamp: new Date().toISOString(),
            syncData: undefined
        };

        // Send to global validator
        const globalValidator = this.globalValidators.get(task.submitter);
        if (globalValidator) {
            await this.forwardMessage(globalValidator, progressMessage);
        }

        // Send to regional validator
        const peer = this.findPeer(peerId);
        if (peer) {
            const regionalValidator = this.getRegionalValidatorForNode(peer.info.region);
            if (regionalValidator) {
                await this.forwardMessage(regionalValidator, progressMessage);
            }
        }

        this.activeTasks.set(taskId, task);
    }

    public async retryTask(taskId: string): Promise<boolean> {
        const task = this.activeTasks.get(taskId);
        if (!task || task.status.state !== 'failed') return false;

        // Reset task status
        task.status = {
            state: 'pending',
            assignedNodes: [],
            acceptedNodes: [],
            progress: 0
        };

        task.timestamp = new Date().toISOString();

        // Rebroadcast task
        await this.broadcastTask(task, task.submitter);
        return true;
    }

    public validateTaskBudget(task: Task): boolean {
        const tierReqs = TASK_TIER_REQUIREMENTS[task.type];
        
        // Check minimum reward
        if (task.reward.total < tierReqs.minReward) {
            return false;
        }

        // Check validator share
        if (task.reward.validatorShare !== tierReqs.validatorShare) {
            return false;
        }

        // Check if enough budget for minimum nodes
        const minNodes = this.getMinNodesForTask(task.type);
        const rewardPerNode = this.calculateNodeReward(task, minNodes);
        
        return rewardPerNode >= tierReqs.minReward / minNodes;
    }

    private getMinNodesForTask(taskType: TaskType): number {
        switch (taskType) {
            case 'train':
                return 1;  // Training tasks typically need one powerful node
            case 'process':
                return 3;  // Processing tasks benefit from parallelization
            case 'store':
                return 2;  // Storage tasks need redundancy
            default:
                return 1;
        }
    }

    public getPendingRewards(): Map<string, number> {
        const pendingRewards = new Map<string, number>();
        
        this.rewardDistributions.forEach(rewards => {
            rewards.forEach((amount, peerId) => {
                const current = pendingRewards.get(peerId) || 0;
                pendingRewards.set(peerId, current + amount);
            });
        });

        return pendingRewards;
    }

    public getValidatorPerformance(validatorId: string): {
        tasksProcessed: number;
        successRate: number;
        avgResponseTime: number;
        totalRewards: number;
    } {
        const validator = this.findPeer(validatorId);
        if (!validator || !['regional_validator', 'global_validator'].includes(validator.info.nodeType)) {
            return {
                tasksProcessed: 0,
                successRate: 0,
                avgResponseTime: 0,
                totalRewards: 0
            };
        }

        // Placeholder implementation
        return {
            tasksProcessed: 0,
            successRate: 0,
            avgResponseTime: 0,
            totalRewards: 0
        };
    }
}

export default ValidatorSystem;