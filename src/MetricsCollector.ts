// // tenzro-regional-node/src/MetricsCollector.ts
import { RegionInfo, ConnectedPeer, NetworkState } from './types';
import { Logger } from './utils/Logger';
import config from './config';

interface NetworkMetrics {
    timestamp: string;
    totalPeers: number;
    activePeers: number;
    validators: {
        regional: number;
        global: number;
    };
    regions: {
        total: number;
        active: number;
    };
    connections: {
        total: number;
        average: number;
    };
}

interface RegionMetrics {
    timestamp: string;
    peers: number;
    validators: number;
    connections: number;
}

export class MetricsCollector {
    private logger: Logger;
    private networkMetrics: NetworkMetrics[] = [];
    private regionMetrics: Map<string, RegionMetrics[]> = new Map();

    constructor() {
        this.logger = Logger.getInstance();
        this.logger.setContext('MetricsCollector');
    }

    public updateNetworkMetrics(peers: ConnectedPeer[], regions: RegionInfo[]): void {
        const activePeers = peers.filter(p => p.status.online);
        
        const metrics: NetworkMetrics = {
            timestamp: new Date().toISOString(),
            totalPeers: peers.length,
            activePeers: activePeers.length,
            validators: {
                regional: peers.filter(p => p.info.nodeType === 'regional_node').length,
                global: peers.filter(p => p.info.nodeType === 'global_node').length
            },
            regions: {
                total: regions.length,
                active: regions.filter(r => r.status === 'active').length
            },
            connections: {
                total: peers.reduce((sum, p) => sum + p.status.connections, 0),
                average: peers.length ? 
                    peers.reduce((sum, p) => sum + p.status.connections, 0) / peers.length : 0
            }
        };

        this.networkMetrics.push(metrics);

        // Keep last 24 hours of metrics (assuming 15s update interval)
        const maxMetrics = (24 * 60 * 60) / 15;
        if (this.networkMetrics.length > maxMetrics) {
            this.networkMetrics.shift();
        }
    }

    public updateRegionMetrics(region: string, peers: ConnectedPeer[]): void {
        const metrics: RegionMetrics = {
            timestamp: new Date().toISOString(),
            peers: peers.length,
            validators: peers.filter(p => p.info.nodeType !== 'individual').length,
            connections: peers.reduce((sum, p) => sum + p.status.connections, 0)
        };

        if (!this.regionMetrics.has(region)) {
            this.regionMetrics.set(region, []);
        }

        const regionHistory = this.regionMetrics.get(region)!;
        regionHistory.push(metrics);

        // Keep last 24 hours of metrics
        const maxMetrics = (24 * 60 * 60) / 15;
        if (regionHistory.length > maxMetrics) {
            regionHistory.shift();
        }
    }

    public getNetworkHealth(): boolean {
        if (this.networkMetrics.length === 0) return true;
    
        const latest = this.networkMetrics[this.networkMetrics.length - 1];
        const thresholds = config.env.metrics.healthThresholds;  // Updated path
    
        return (
            latest.activePeers / latest.totalPeers >= thresholds.minActivePeers &&
            latest.regions.active >= thresholds.minValidators
        );
    }

    public getNetworkMetrics(duration: number = 3600000): NetworkMetrics[] {
        const since = Date.now() - duration;
        return this.networkMetrics.filter(m => 
            new Date(m.timestamp).getTime() > since
        );
    }

    public getRegionMetrics(region: string, duration: number = 3600000): RegionMetrics[] {
        const regionHistory = this.regionMetrics.get(region) || [];
        const since = Date.now() - duration;
        return regionHistory.filter(m =>
            new Date(m.timestamp).getTime() > since
        );
    }

    public getLatestNetworkMetrics(): NetworkMetrics | undefined {
        return this.networkMetrics[this.networkMetrics.length - 1];
    }

    public getLatestRegionMetrics(region: string): RegionMetrics | undefined {
        const regionHistory = this.regionMetrics.get(region) || [];
        return regionHistory[regionHistory.length - 1];
    }
}

export default MetricsCollector;