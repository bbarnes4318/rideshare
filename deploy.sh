#!/bin/bash

# Rideshare Analytics Deployment Script for Digital Ocean
# Server IP: 167.172.241.85

echo "🚀 Starting deployment to Digital Ocean server..."

# Configuration
SERVER_IP="167.172.241.85"
APP_DIR="/var/www/rideshare"
REPO_URL="https://github.com/bbarnes4318/rideshare.git"

echo "📦 Pulling latest code from GitHub..."
ssh root@$SERVER_IP << 'EOF'
    # Navigate to app directory
    cd /var/www/rideshare || { echo "App directory not found, cloning..."; git clone https://github.com/bbarnes4318/rideshare.git /var/www/rideshare; cd /var/www/rideshare; }
    
    # Pull latest changes
    git pull origin main
    
    # Install/update dependencies
    npm install --production
    
    # Create .env file if it doesn't exist
    if [ ! -f .env ]; then
        echo "Creating .env file..."
        cat > .env << 'ENVEOF'
PORT=5000
MONGODB_URI=mongodb+srv://doadmin:1xG83u724eXZVj09@rideshare-c3642684.mongo.ondigitalocean.com/admin?tls=true&authSource=admin
JWT_SECRET=RideshareAnalytics2025SecureJWTKey$#@!
NODE_ENV=production
IPSTACK_API_KEY=d798d581058a28f14012d786ab2b8abc
SERVER_IP=167.172.241.85
DOMAIN=buyertrend.com
ENVEOF
    fi
    
    # Create exports directory if it doesn't exist
    mkdir -p exports
    
    # Set proper permissions
    chown -R www-data:www-data /var/www/rideshare
    chmod -R 755 /var/www/rideshare
    
    # Restart PM2 application
    pm2 restart rideshare-analytics || pm2 start server.js --name "rideshare-analytics"
    
    # Show status
    pm2 status
    
    echo "✅ Deployment completed!"
EOF

echo "🔧 Configuring Nginx (if not already configured)..."
ssh root@$SERVER_IP << 'EOF'
    # Check if Nginx config exists
    if [ ! -f /etc/nginx/sites-available/buyertrend.com ]; then
        echo "Creating Nginx configuration..."
        cat > /etc/nginx/sites-available/buyertrend.com << 'NGINXEOF'
server {
    listen 80;
    server_name buyertrend.com www.buyertrend.com;
    
    # Redirect HTTP to HTTPS (if SSL is configured)
    # return 301 https://$server_name$request_uri;
    
    # Main application
    location / {
        proxy_pass http://localhost:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # Increase timeout for long requests
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
    
    # Static files (if any)
    location /static/ {
        alias /var/www/rideshare/public/;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
    
    # Health check endpoint
    location /health {
        proxy_pass http://localhost:5000/health;
        access_log off;
    }
}
NGINXEOF
        
        # Enable the site
        ln -s /etc/nginx/sites-available/buyertrend.com /etc/nginx/sites-enabled/
        
        # Test Nginx configuration
        nginx -t
        
        # Reload Nginx
        systemctl reload nginx
        
        echo "✅ Nginx configured!"
    else
        echo "Nginx configuration already exists."
    fi
EOF

echo "🔄 Running database setup..."
ssh root@$SERVER_IP << 'EOF'
    cd /var/www/rideshare
    npm run setup
EOF

echo ""
echo "🎉 Deployment Summary:"
echo "   • Code deployed to: /var/www/rideshare"
echo "   • Application running on: http://167.172.241.85:5000"
echo "   • Domain configured: buyertrend.com"
echo "   • Dashboard available at: buyertrend.com/dashboard"
echo "   • Admin login at: buyertrend.com/admin"
echo ""
echo "📊 Default Login Credentials:"
echo "   Admin: admin / password123"
echo "   Analyst: analyst / analyst123"
echo ""
echo "⚠️  Remember to:"
echo "   1. Configure SSL certificate for HTTPS"
echo "   2. Change default passwords"
echo "   3. Set up automatic backups"
echo "   4. Configure firewall rules"
echo ""
echo "✅ Deployment completed successfully!"
