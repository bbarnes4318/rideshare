const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const path = require('path');
require('dotenv').config();

const app = express();

// Security and performance middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disabled for dashboard functionality
  crossOriginOpenerPolicy: false, // Disabled for HTTP connections
  crossOriginResourcePolicy: false, // Disabled for HTTP connections
}));
app.use(compression());
app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? 
    ['https://buyertrend.com', 'https://www.buyertrend.com'] : 
    ['http://localhost:3000', 'http://127.0.0.1:3000']
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static files (existing landing page)
app.use(express.static(path.join(__dirname)));

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('✅ Connected to MongoDB'))
.catch(err => console.error('❌ MongoDB connection error:', err));

// Import routes
const submissionRoutes = require('./routes/submissions');
const analyticsRoutes = require('./routes/analytics');
const authRoutes = require('./routes/auth');

// API routes
app.use('/api/submissions', submissionRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/auth', authRoutes);

// Dashboard route - serves the analytics dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});

// Admin login route
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'login-test.html'));
});

// API proxy route for existing form submissions
app.post('/api-proxy/', require('./middleware/formHandler'));

// Default route - serves the main landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server Error:', error);
  res.status(500).json({
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? error.message : {}
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Dashboard available at: http://localhost:${PORT}/dashboard`);
  console.log(`🔐 Admin login at: http://localhost:${PORT}/admin`);
});
