#!/usr/bin/env node
// tenzro-regional-node/scripts/deploy-regional-node.ts

import { exec } from 'child_process';
import { promisify } from 'util';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs/promises';

// Promisify the exec function for easier use with async/await
const execAsync = promisify(exec);

// Load environment variables from a .env file
dotenv.config();

// Interface for regional node configuration
interface RegionalConfig {
  appName: string;
  region: string;
  tier: 'inference' | 'aggregator' | 'training' | 'feedback';
  nodeType: 'global_node' | 'regional_node';
  tokenBalance: number;
}

// Define a constant for available regions
const REGIONS: { [key: string]: string } = {
  us: 'us',
  eu: 'eu',
};

/**
 * Updates a single regional node on Heroku.
 *
 * @param config The configuration object for the regional node.
 * @returns The URL of the deployed regional node.
 */
async function updateRegionalNode(config: RegionalConfig): Promise<string> {
  const { appName, region, tier, nodeType, tokenBalance } = config;

  try {
    console.log(`Updating Heroku app ${appName}...`);

    // Verify that the Procfile exists
    try {
      await fs.access('Procfile');
      console.log('Procfile found');
    } catch (error) {
      console.error('Procfile not found in root directory');
      throw new Error('Procfile missing');
    }

    // Configure environment variables
    const envVars = [
      `NODE_TYPE=${nodeType}`,
      `NODE_TIER=${tier}`,
      `TOKEN_BALANCE=${tokenBalance}`,
      `REGION=${region}`,
      'PORT=443',
      'NODE_ENV=production',
    ].join(' ');

    // Update environment variables on Heroku
    await execAsync(`heroku config:set ${envVars} --app ${appName}`);
    console.log('Environment variables updated');

    // Remove existing Heroku remote if it exists
    try {
      await execAsync(`git remote remove ${appName}`);
    } catch (error) {
      // Ignore if the remote doesn't exist
    }

    // Add Heroku remote
    await execAsync(`git remote add ${appName} https://git.heroku.com/${appName}.git`);
    console.log(`Added git remote for ${appName}`);

    // Make sure we are on the master branch
    try {
      await execAsync('git checkout master');
    } catch (error) {
      await execAsync('git checkout -b master');
    }
    console.log('Checked out master branch');

    // Force add all files, including Procfile, to staging area
    await execAsync('git add -f Procfile');
    await execAsync('git add .');
    await execAsync('git commit -m "Update regional node with Procfile" --allow-empty');
    console.log('Committed changes');

    // Push code to Heroku master branch
    await execAsync(`git push ${appName} master --force`);
    console.log('Code deployed');

    // Set the dyno type after successful deployment
    await execAsync(`heroku dyno:type ${tier} --app ${appName}`);
    console.log('Dyno type updated');

    // Enable automatic SSL if not already enabled
    try {
      await execAsync(`heroku labs:enable http-session-affinity --app ${appName}`);
      console.log('SSL enabled');
    } catch (error) {
      console.log('SSL already enabled');
    }

    console.log(`regional node ${appName} updated successfully!`);

    // Get the app URL
    const { stdout: url } = await execAsync(
      `heroku info --app ${appName} | grep "Web URL" | cut -d: -f2- | tr -d ' '`
    );
    return url.trim();
  } catch (error) {
    console.error(`Failed to update regional node ${appName}:`, error);
    throw error;
  }
}

/**
 * Updates all regional nodes in the network.
 */
async function updateRegionalNetwork() {
  const regionalNodes: RegionalConfig[] = [
    {
      appName: 'tenzro-regional-node-us',
      region: 'us',
      tier: 'aggregator',
      nodeType: 'regional_node',
      tokenBalance: 1000,
    },
    {
      appName: 'tenzro-regional-node-eu',
      region: 'eu',
      tier: 'aggregator',
      nodeType: 'regional_node',
      tokenBalance: 1000,
    },
  ];

  const deployedUrls: string[] = [];

  for (const config of regionalNodes) {
    try {
      const url = await updateRegionalNode(config);
      deployedUrls.push(url);
      console.log(`Successfully updated ${config.appName} at ${url}`);
    } catch (error) {
      console.error(`Failed to update ${config.appName}:`, error);
    }
  }

  // Save regional node URLs to a configuration file
  const regionalConfig = {
    regionalNodes: deployedUrls,
    timestamp: new Date().toISOString(),
  };

  await fs.writeFile(
    path.join(process.cwd(), 'regional-node-config.json'),
    JSON.stringify(regionalConfig, null, 2)
  );

  console.log('regional network update completed!');
  console.log('regional nodes:', deployedUrls);
}

// Execute the updateRegionalNetwork function if the script is run directly
if (require.main === module) {
  updateRegionalNetwork().catch(console.error);
}

export { updateRegionalNode, updateRegionalNetwork };