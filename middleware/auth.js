const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Middleware to verify JWT token
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
    
    if (!token) {
      return res.status(401).json({ message: 'Access token required' });
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId).select('-password');
    
    if (!user || !user.isActive) {
      return res.status(401).json({ message: 'Invalid or inactive user' });
    }
    
    req.user = user;
    next();
  } catch (error) {
    // An expired or malformed token is a failure to AUTHENTICATE, so it must be
    // 401, not 403. The dashboard only clears its stored token and redirects to
    // sign in on a 401; when this returned 403 an expired session showed
    // "403 Forbidden (/api/analytics/dashboard)" and "Failed to load
    // submissions" on a 30s loop forever, with no way to reach the login page.
    // 403 stays reserved for an authenticated user lacking a permission.
    if (error.name === 'TokenExpiredError') {
      // Routine, and it happens once per user per day. No stack trace.
      console.warn('Auth: expired token rejected');
      return res.status(401).json({ message: 'Session expired', expired: true });
    }
    if (error.name === 'JsonWebTokenError' || error.name === 'NotBeforeError') {
      console.warn('Auth: invalid token rejected -', error.message);
      return res.status(401).json({ message: 'Invalid token' });
    }
    console.error('Auth error:', error);
    return res.status(500).json({ message: 'Authentication failed' });
  }
};

// Middleware to check specific permissions
const requirePermission = (permission) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required' });
    }
    
    if (!req.user.permissions[permission]) {
      return res.status(403).json({ 
        message: `Permission required: ${permission}` 
      });
    }
    
    next();
  };
};

// Middleware to check if user is admin
const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Authentication required' });
  }
  
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  
  next();
};

module.exports = {
  authenticateToken,
  requirePermission,
  requireAdmin
};