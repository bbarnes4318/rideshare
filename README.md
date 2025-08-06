# Rideshare Analytics Platform

A comprehensive data collection and visualization system for rideshare landing page prospects, featuring advanced analytics, geolocation tracking, and a stunning dashboard interface.

## 🚀 Features

### Data Collection & Enhancement
- **Comprehensive Form Data**: Captures all form submissions with detailed prospect information
- **Geolocation Intelligence**: Uses IPStack API for precise location data and GeoIP for offline fallback
- **Browser & Device Detection**: Identifies user's browser, OS, and device type
- **TrustedForm Integration**: Validates and stores trusted form certificates
- **Quality Scoring**: Automatically calculates quality scores for each submission
- **Real-time Processing**: Processes and stores data instantly upon form submission

### Analytics Dashboard
- **Real-time Metrics**: Live dashboard with key performance indicators
- **Interactive Charts**: Submission trends, device distribution, location analytics
- **Geographic Visualization**: Interactive world map with submission plotting
- **Advanced Filtering**: Search, filter, and sort submissions by multiple criteria
- **Export Capabilities**: CSV, Excel, and PDF export options
- **User Management**: Role-based access control (Admin, Manager, Analyst)

### Technical Excellence
- **Modern Architecture**: Node.js/Express backend with MongoDB database
- **Responsive Design**: Mobile-first, responsive dashboard interface
- **Security First**: JWT authentication, rate limiting, data encryption
- **Performance Optimized**: Efficient database queries, caching, compression
- **Scalable Infrastructure**: Ready for Digital Ocean deployment

## 🛠 Installation & Setup

### Prerequisites
- Node.js (v14 or higher)
- MongoDB database (local or cloud)
- IPStack API key (optional but recommended)

### Quick Start

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Configure Environment**
   Update `.env` file with your credentials:
   ```
   PORT=5000
   MONGODB_URI=mongodb+srv://doadmin:1xG83u724eXZVj09@rideshare-c3642684.mongo.ondigitalocean.com/admin?tls=true&authSource=admin
   JWT_SECRET=RideshareAnalytics2025SecureJWTKey$#@!
   IPSTACK_API_KEY=d798d581058a28f14012d786ab2b8abc
   NODE_ENV=production
   ```

3. **Initialize Database**
   ```bash
   node setup.js
   ```

4. **Start the Server**
   ```bash
   npm start
   ```

5. **Access the Application**
   - Landing Page: `http://localhost:5000/`
   - Admin Login: `http://localhost:5000/admin`
   - Dashboard: `http://localhost:5000/dashboard`

### Default Credentials
- **Admin**: `admin` / `password123`
- **Analyst**: `analyst` / `analyst123`

⚠️ **Important**: Change default passwords after first login!

## 🏗 Architecture Overview

### Backend Components
```
server.js              # Main Express server
├── routes/
│   ├── auth.js         # Authentication endpoints
│   ├── submissions.js  # Submission management
│   └── analytics.js    # Analytics & export APIs
├── models/
│   ├── Submission.js   # Submission data schema
│   └── User.js         # User management schema
├── middleware/
│   ├── auth.js         # JWT authentication
│   └── formHandler.js  # Enhanced form processing
└── dashboard/
    ├── login.html      # Admin login interface
    ├── index.html      # Main dashboard
    └── dashboard.js    # Frontend JavaScript
```

### Database Schema

#### Submissions Collection
```javascript
{
  // Form Data
  fname, lname, email, phone, address, city, state, zip,
  gender, date_of_birth, diagnosis_year,
  
  // Technical Data
  ip_address, user_agent, trusted_form_cert_url,
  
  // Enhanced Geolocation
  geolocation: {
    country, region, city, latitude, longitude,
    timezone, isp, organization
  },
  
  // Device Intelligence
  browser_info: { family, version, major },
  os_info: { family, version, major },
  device_info: { family, type, brand },
  
  // Analytics
  quality_score, status, submission_date,
  referrer, campaign_data
}
```

### API Endpoints

#### Authentication
- `POST /api/auth/login` - User authentication
- `GET /api/auth/verify` - Token verification
- `POST /api/auth/users` - Create user (admin only)

#### Submissions
- `GET /api/submissions` - List submissions (with filtering)
- `GET /api/submissions/:id` - Get submission details
- `PATCH /api/submissions/:id/status` - Update status
- `DELETE /api/submissions/:id` - Soft delete

#### Analytics
- `GET /api/analytics/dashboard` - Main dashboard data
- `GET /api/analytics/map-data` - Geographic data for map
- `GET /api/analytics/export/csv` - Export as CSV
- `GET /api/analytics/export/excel` - Export as Excel

## 🎨 Dashboard Features

### Overview Dashboard
- **Real-time Metrics**: Period submissions, today's count, quality rate, all-time total
- **Visual Charts**: Submission trends, device distribution, top locations, status breakdown
- **Auto-refresh**: Updates every 30 seconds
- **Responsive Design**: Works on all devices

### Submissions Management
- **Advanced Search**: Search across name, email, location fields
- **Multi-filter**: Filter by status, country, date range
- **Sortable Columns**: Sort by any column
- **Pagination**: Handle large datasets efficiently
- **Bulk Actions**: Update multiple submissions
- **Detailed View**: Modal popup with complete submission details

### Geographic Visualization
- **Interactive Map**: Leaflet.js powered world map
- **Cluster Markers**: Submissions grouped by location
- **Popup Details**: Click markers for submission details
- **Heat Map**: Visual density representation

### Export & Reporting
- **Multiple Formats**: CSV, Excel, PDF export
- **Filtered Export**: Export only filtered results
- **Scheduled Reports**: Coming soon
- **Custom Fields**: Select specific data fields

## 🔒 Security Features

- **JWT Authentication**: Secure token-based auth
- **Role-based Access**: Admin, Manager, Analyst roles
- **Rate Limiting**: Prevent abuse and attacks
- **Data Encryption**: Sensitive data protection
- **CORS Protection**: Cross-origin request security
- **Input Validation**: Server-side validation
- **SQL Injection Protection**: MongoDB parameter binding

## 🚀 Deployment

### Digital Ocean Setup
1. **Server Configuration**
   - Ubuntu 20.04 LTS
   - Node.js v18+
   - PM2 for process management
   - Nginx reverse proxy

2. **Domain Configuration**
   - Main site: `perenroll.com/`
   - Dashboard: `perenroll.com/dashboard`
   - Admin: `perenroll.com/admin`

3. **Environment Variables**
   ```bash
   NODE_ENV=production
   MONGODB_URI=mongodb+srv://...
   JWT_SECRET=your-secure-secret
   IPSTACK_API_KEY=your-api-key
   ```

### PM2 Process Management
```bash
# Start application
pm2 start server.js --name "rideshare-analytics"

# View logs
pm2 logs rideshare-analytics

# Restart application
pm2 restart rideshare-analytics

# Auto-startup on boot
pm2 startup
pm2 save
```

## 📊 Analytics & Insights

### Key Metrics Tracked
- **Conversion Funnel**: Pending → Processed → Contacted → Qualified
- **Geographic Distribution**: Submissions by country/region/city
- **Device Analytics**: Mobile vs Desktop vs Tablet usage
- **Browser Intelligence**: Popular browsers and versions
- **Time-based Trends**: Hourly, daily, weekly patterns
- **Quality Scoring**: Automated quality assessment
- **Source Tracking**: UTM parameters and referrer analysis

### Data Export Options
- **CSV Export**: Raw data for spreadsheet analysis
- **Excel Reports**: Formatted reports with charts
- **API Access**: Programmatic data access
- **Real-time Webhooks**: Coming soon

## 🔧 Development

### Local Development
```bash
# Install dependencies
npm install

# Start in development mode
npm run dev

# Run setup script
node setup.js
```

### Database Operations
```javascript
// Connect to MongoDB shell
mongo "mongodb+srv://doadmin:1xG83u724eXZVj09@rideshare-c3642684.mongo.ondigitalocean.com/admin?authSource=admin" --tls

// View collections
show collections

// Query submissions
db.submissions.find().limit(5)

// Check indexes
db.submissions.getIndexes()
```

## 🎯 Future Enhancements

### Planned Features
- [ ] **Real-time Notifications**: Instant alerts for new submissions
- [ ] **Advanced Reporting**: Custom report builder
- [ ] **A/B Testing**: Landing page optimization
- [ ] **Lead Scoring ML**: Machine learning quality prediction
- [ ] **CRM Integration**: Salesforce, HubSpot connectors
- [ ] **Automated Workflows**: Lead nurturing automation
- [ ] **Mobile App**: Native iOS/Android dashboard
- [ ] **API Rate Limiting**: Per-user API quotas

### Performance Optimizations
- [ ] **Redis Caching**: Cache frequent queries
- [ ] **CDN Integration**: Static asset optimization
- [ ] **Database Sharding**: Scale for millions of records
- [ ] **Load Balancing**: Multi-server deployment
- [ ] **Background Jobs**: Async processing queue

## 🐛 Troubleshooting

### Common Issues

**Connection Error to MongoDB**
```bash
# Check connection string format
# Ensure IP whitelist includes your server IP
# Verify credentials are correct
```

**Dashboard Not Loading**
```bash
# Check if server is running
pm2 status

# View application logs
pm2 logs rideshare-analytics

# Restart the application
pm2 restart rideshare-analytics
```

**Form Submissions Not Saving**
```bash
# Check API endpoint response
curl -X POST http://localhost:5000/api-proxy/ \
  -H "Content-Type: application/json" \
  -d '{"fname":"Test","lname":"User"...}'

# Verify database connection
node -e "console.log(require('./server.js'))"
```

## 📞 Support

For technical support or questions:
- **Email**: support@perenroll.com
- **Issues**: GitHub Issues (if applicable)
- **Documentation**: This README file

## 📄 License

This project is proprietary software developed for PerEnoll.com rideshare analytics platform.

---

**Built with ❤️ for PerEnoll.com**
*Empowering data-driven decisions in rideshare legal services*