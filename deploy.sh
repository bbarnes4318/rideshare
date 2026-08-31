#!/bin/bash

# NationalLifeCoverage Deployment Script
# Server IP: 45.32.175.55

echo "🚀 Starting deployment to Digital Ocean server..."

# Configuration - UPDATED FOR NEW DOMAIN
SERVER_IP="45.32.175.55"
APP_DIR="/var/www/rideshare"
REPO_URL="https://github.com/bbarnes4318/rideshare.git"
DOMAIN="quotes.nationallifecoverage.org"

echo "📦 Pulling latest code from GitHub..."
sshpass -p ${{ secrets.DO_PASSWORD }} ssh -o StrictHostKeyChecking=no root@$SERVER_IP << EOF
    # Navigate to app directory
    mkdir -p /var/www/rideshare
    cd /var/www/rideshare
    
    # Initialize git if needed
    if [ ! -d .git ]; then
        git clone $REPO_URL .
    else
        git pull origin main
    fi
    
    # Install dependencies
    npm install --production
    
    # FORCE UPDATE .env file (Removed the 'if exists' check)
    echo "Updating .env file with new domain..."
    cat > .env << 'ENVEOF'
PORT=5000
MONGODB_URI=mongodb://127.0.0.1:27017/rideshare
JWT_SECRET=RideshareAnalytics2025SecureJWTKey$#@!
NODE_ENV=production
IPSTACK_API_KEY=d798d581058a28f14012d786ab2b8abc
SERVER_IP=45.32.175.55
DOMAIN=quotes.nationallifecoverage.org
ENVEOF
    
    # Create exports directory
    mkdir -p exports
    
    # Restart PM2 application
    pm2 restart rideshare-analytics || pm2 start server.js --name "rideshare-analytics"
    
    echo "✅ Application code updated!"
EOF

echo "🔧 Configuring Nginx for quotes.nationallifecoverage.org..."
sshpass -p ${{ secrets.DO_PASSWORD }} ssh -o StrictHostKeyChecking=no root@$SERVER_IP << EOF
    # Clean up old configs if they exist
    rm -f /etc/nginx/sites-enabled/perenroll.com
    rm -f /etc/nginx/sites-available/perenroll.com
    rm -f /etc/nginx/sites-enabled/buyertrend.com
    rm -f /etc/nginx/sites-enabled/fairwreck.com
    rm -f /etc/nginx/sites-available/fairwreck.com
    rm -f /etc/nginx/sites-available/buyertrend.com
    rm -f /etc/nginx/sites-enabled/default

    # Create NEW Nginx configuration
    cat > /etc/nginx/sites-available/quotes.nationallifecoverage.org << 'NGINXEOF'
server {
    listen 80;
    server_name quotes.nationallifecoverage.org;
    
    location / {
        proxy_pass http://localhost:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
    }
}
NGINXEOF
        
    # Enable the site
    ln -sf /etc/nginx/sites-available/quotes.nationallifecoverage.org /etc/nginx/sites-enabled/
    
    # Reload Nginx to apply changes
    systemctl reload nginx
    echo "✅ Nginx configured for quotes.nationallifecoverage.org!"

    # Install Certbot if not present and provision SSL
    apt-get install -y certbot python3-certbot-nginx > /dev/null 2>&1
    certbot --nginx -d quotes.nationallifecoverage.org --non-interactive --agree-tos --email admin@nationallifecoverage.org --redirect
    echo "✅ SSL certificate provisioned for quotes.nationallifecoverage.org!"
EOF

echo "✅ Deployment completed successfully!"
