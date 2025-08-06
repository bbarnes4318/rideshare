const mongoose = require('mongoose');

const submissionSchema = new mongoose.Schema({
  // Form data
  fname: {
    type: String,
    required: true,
    trim: true
  },
  lname: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true
  },
  phone: {
    type: String,
    required: true,
    trim: true
  },
  address: {
    type: String,
    required: true,
    trim: true
  },
  city: {
    type: String,
    required: true,
    trim: true
  },
  state: {
    type: String,
    required: true,
    trim: true,
    uppercase: true
  },
  zip: {
    type: String,
    required: true,
    trim: true
  },
  gender: {
    type: String,
    required: true,
    enum: ['Male', 'Female', 'Other']
  },
  date_of_birth: {
    type: Date,
    required: true
  },
  diagnosis_year: {
    type: Date,
    required: true
  },
  
  // Technical data
  ip_address: {
    type: String,
    required: true
  },
  
  // Geolocation data
  geolocation: {
    country: String,
    country_code: String,
    region: String,
    region_name: String,
    city: String,
    zip: String,
    latitude: Number,
    longitude: Number,
    timezone: String,
    isp: String,
    org: String
  },
  
  // Browser and device information
  user_agent: {
    type: String,
    required: true
  },
  browser_info: {
    family: String,
    version: String,
    major: String
  },
  os_info: {
    family: String,
    version: String,
    major: String
  },
  device_info: {
    family: String,
    brand: String,
    model: String,
    type: String // mobile, tablet, desktop
  },
  
  // Trusted form certificate
  trusted_form_cert_url: {
    type: String,
    required: true
  },
  
  // Additional metadata
  case_type: {
    type: String,
    default: 'Rideshare'
  },
  ownerid: {
    type: String,
    default: '005TR00000CDuezYAD'
  },
  campaign: String,
  offer_url: String,
  
  // Submission tracking
  submission_date: {
    type: Date,
    default: Date.now
  },
  processed: {
    type: Boolean,
    default: false
  },
  status: {
    type: String,
    enum: ['pending', 'processed', 'contacted', 'qualified', 'rejected'],
    default: 'pending'
  },
  
  // Analytics fields
  page_views: {
    type: Number,
    default: 1
  },
  time_on_page: Number, // in seconds
  referrer: String,
  utm_source: String,
  utm_medium: String,
  utm_campaign: String,
  
  // Quality score (calculated field)
  quality_score: {
    type: Number,
    min: 0,
    max: 100,
    default: 0
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes for better query performance
submissionSchema.index({ email: 1 });
submissionSchema.index({ phone: 1 });
submissionSchema.index({ submission_date: -1 });
submissionSchema.index({ status: 1 });
submissionSchema.index({ 'geolocation.country': 1 });
submissionSchema.index({ 'geolocation.region': 1 });
submissionSchema.index({ quality_score: -1 });

// Virtual for full name
submissionSchema.virtual('fullName').get(function() {
  return `${this.fname} ${this.lname}`;
});

// Virtual for formatted address
submissionSchema.virtual('fullAddress').get(function() {
  return `${this.address}, ${this.city}, ${this.state} ${this.zip}`;
});

// Pre-save middleware to calculate quality score
submissionSchema.pre('save', function(next) {
  if (this.isNew || this.isModified()) {
    this.quality_score = this.calculateQualityScore();
  }
  next();
});

// Method to calculate quality score
submissionSchema.methods.calculateQualityScore = function() {
  let score = 0;
  
  // Basic form completion (40 points)
  if (this.fname && this.lname) score += 10;
  if (this.email && this.email.includes('@')) score += 10;
  if (this.phone && this.phone.length >= 10) score += 10;
  if (this.address && this.city && this.state && this.zip) score += 10;
  
  // Additional details (30 points)
  if (this.date_of_birth) score += 10;
  if (this.diagnosis_year) score += 10;
  if (this.gender) score += 10;
  
  // Technical quality (30 points)
  if (this.trusted_form_cert_url) score += 15;
  if (this.geolocation && this.geolocation.country) score += 10;
  if (this.user_agent && !this.user_agent.includes('bot')) score += 5;
  
  return Math.min(score, 100);
};

// Static method to get analytics data
submissionSchema.statics.getAnalytics = async function(dateRange = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - dateRange);
  
  const pipeline = [
    { $match: { submission_date: { $gte: startDate } } },
    {
      $facet: {
        totalSubmissions: [{ $count: "count" }],
        byCountry: [
          { $group: { _id: "$geolocation.country", count: { $sum: 1 } } },
          { $sort: { count: -1 } }
        ],
        byDevice: [
          { $group: { _id: "$device_info.type", count: { $sum: 1 } } },
          { $sort: { count: -1 } }
        ],
        byStatus: [
          { $group: { _id: "$status", count: { $sum: 1 } } }
        ],
        dailySubmissions: [
          {
            $group: {
              _id: {
                $dateToString: { format: "%Y-%m-%d", date: "$submission_date" }
              },
              count: { $sum: 1 }
            }
          },
          { $sort: { _id: 1 } }
        ],
        avgQualityScore: [
          { $group: { _id: null, avg: { $avg: "$quality_score" } } }
        ]
      }
    }
  ];
  
  return this.aggregate(pipeline);
};

module.exports = mongoose.model('Submission', submissionSchema);