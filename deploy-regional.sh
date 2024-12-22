# deploy-regional.sh
#!/bin/bash
# Script to deploy regional nodes

set -e

# Path to config file
CONFIG_FILE=".env"

# Load environment variables if config exists
if [ -f "$CONFIG_FILE" ]; then
    source "$CONFIG_FILE"
fi

# Set defaults if not provided in config
REGION=${REGION:-"us"}
BOOTSTRAP_NODES=${BOOTSTRAP_NODES:-""}

# Deploy the application
heroku create "tenzro-regional-node-${REGION}" --region $REGION

# Configure the application
heroku config:set \
    NODE_ENV=production \
    NODE_TYPE=regional_node \
    NODE_TIER=aggregator \
    REGION=$REGION \
    TOKEN_BALANCE=5000 \
    DHT_ENABLED=true \
    DHT_REFRESH_INTERVAL=60000 \
    METRICS_UPDATE_INTERVAL=15000 \
    HEALTH_CHECK_INTERVAL=30000 \
    -a "tenzro-regional-node-${REGION}"

if [ ! -z "$BOOTSTRAP_NODES" ]; then
    heroku config:set BOOTSTRAP_NODES=$BOOTSTRAP_NODES -a "tenzro-regional-node-${REGION}"
fi

# Set up build packs
heroku buildpacks:clear -a "tenzro-regional-node-${REGION}"
heroku buildpacks:add heroku/nodejs -a "tenzro-regional-node-${REGION}"

# Scale the dyno
heroku ps:scale web=1:standard-1x -a "tenzro-regional-node-${REGION}"

# Deploy the code
git push heroku main