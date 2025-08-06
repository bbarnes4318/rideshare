const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: 3,
    maxlength: 50
  },
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  password: {
    type: String,
    required: true,
    minlength: 6
  },
  role: {
    type: String,
    enum: ['admin', 'manager', 'analyst'],
    default: 'analyst'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  lastLogin: {
    type: Date
  },
  permissions: {
    viewSubmissions: { type: Boolean, default: true },
    exportData: { type: Boolean, default: false },
    manageUsers: { type: Boolean, default: false },
    viewAnalytics: { type: Boolean, default: true }
  }
}, {
  timestamps: true
});

// Index for faster queries
userSchema.index({ email: 1 });
userSchema.index({ username: 1 });

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Method to check password
userSchema.methods.comparePassword = async function(password) {
  return await bcrypt.compare(password, this.password);
};

// Set permissions based on role
userSchema.pre('save', function(next) {
  if (this.isModified('role')) {
    switch (this.role) {
      case 'admin':
        this.permissions = {
          viewSubmissions: true,
          exportData: true,
          manageUsers: true,
          viewAnalytics: true
        };
        break;
      case 'manager':
        this.permissions = {
          viewSubmissions: true,
          exportData: true,
          manageUsers: false,
          viewAnalytics: true
        };
        break;
      case 'analyst':
        this.permissions = {
          viewSubmissions: true,
          exportData: false,
          manageUsers: false,
          viewAnalytics: true
        };
        break;
    }
  }
  next();
});

module.exports = mongoose.model('User', userSchema);