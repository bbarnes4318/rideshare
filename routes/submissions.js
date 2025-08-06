const express = require('express');
const Submission = require('../models/Submission');
const { authenticateToken, requirePermission } = require('../middleware/auth');

const router = express.Router();

// Get all submissions with filtering and pagination
router.get('/', authenticateToken, requirePermission('viewSubmissions'), async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search,
      status,
      country,
      dateFrom,
      dateTo,
      sortBy = 'submission_date',
      sortOrder = 'desc'
    } = req.query;
    
    // Build filter object
    const filter = {};
    
    // Search across multiple fields
    if (search) {
      const searchRegex = new RegExp(search, 'i');
      filter.$or = [
        { fname: searchRegex },
        { lname: searchRegex },
        { email: searchRegex },
        { phone: searchRegex },
        { 'geolocation.city': searchRegex },
        { 'geolocation.region': searchRegex }
      ];
    }
    
    // Status filter
    if (status) {
      filter.status = status;
    }
    
    // Country filter
    if (country) {
      filter['geolocation.country'] = country;
    }
    
    // Date range filter
    if (dateFrom || dateTo) {
      filter.submission_date = {};
      if (dateFrom) {
        filter.submission_date.$gte = new Date(dateFrom);
      }
      if (dateTo) {
        filter.submission_date.$lte = new Date(dateTo);
      }
    }
    
    // Sort options
    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === 'desc' ? -1 : 1;
    
    // Execute query with pagination
    const submissions = await Submission.find(filter)
      .sort(sortOptions)
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();
    
    // Get total count for pagination
    const total = await Submission.countDocuments(filter);
    
    res.json({
      submissions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      },
      filters: {
        search,
        status,
        country,
        dateFrom,
        dateTo
      }
    });
    
  } catch (error) {
    console.error('Get submissions error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Get single submission by ID
router.get('/:id', authenticateToken, requirePermission('viewSubmissions'), async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id);
    
    if (!submission) {
      return res.status(404).json({ message: 'Submission not found' });
    }
    
    res.json(submission);
    
  } catch (error) {
    console.error('Get submission error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Update submission status
router.patch('/:id/status', authenticateToken, requirePermission('viewSubmissions'), async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['pending', 'processed', 'contacted', 'qualified', 'rejected'];
    
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ 
        message: 'Invalid status',
        validStatuses
      });
    }
    
    const submission = await Submission.findByIdAndUpdate(
      req.params.id,
      { 
        status,
        processed: status !== 'pending'
      },
      { new: true }
    );
    
    if (!submission) {
      return res.status(404).json({ message: 'Submission not found' });
    }
    
    res.json({
      message: 'Status updated successfully',
      submission
    });
    
  } catch (error) {
    console.error('Update status error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Add notes to submission
router.patch('/:id/notes', authenticateToken, requirePermission('viewSubmissions'), async (req, res) => {
  try {
    const { notes } = req.body;
    
    const submission = await Submission.findByIdAndUpdate(
      req.params.id,
      { 
        $push: { 
          notes: {
            content: notes,
            addedBy: req.user._id,
            addedAt: new Date()
          }
        }
      },
      { new: true }
    );
    
    if (!submission) {
      return res.status(404).json({ message: 'Submission not found' });
    }
    
    res.json({
      message: 'Notes added successfully',
      submission
    });
    
  } catch (error) {
    console.error('Add notes error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Get recent submissions (dashboard summary)
router.get('/recent/summary', authenticateToken, requirePermission('viewSubmissions'), async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));
    
    const recent = await Submission.find({
      submission_date: { $gte: startDate }
    })
    .sort({ submission_date: -1 })
    .limit(10)
    .select('fname lname email submission_date status geolocation.city geolocation.country quality_score')
    .lean();
    
    res.json(recent);
    
  } catch (error) {
    console.error('Get recent submissions error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Get submissions by location
router.get('/location/stats', authenticateToken, requirePermission('viewSubmissions'), async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));
    
    const locationStats = await Submission.aggregate([
      {
        $match: {
          submission_date: { $gte: startDate },
          'geolocation.country': { $ne: 'Unknown' }
        }
      },
      {
        $group: {
          _id: {
            country: '$geolocation.country',
            region: '$geolocation.region',
            city: '$geolocation.city'
          },
          count: { $sum: 1 },
          avgQuality: { $avg: '$quality_score' },
          coordinates: {
            $first: {
              lat: '$geolocation.latitude',
              lng: '$geolocation.longitude'
            }
          }
        }
      },
      {
        $sort: { count: -1 }
      },
      {
        $limit: 100
      }
    ]);
    
    res.json(locationStats);
    
  } catch (error) {
    console.error('Get location stats error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Bulk update submissions
router.patch('/bulk/update', authenticateToken, requirePermission('viewSubmissions'), async (req, res) => {
  try {
    const { ids, updates } = req.body;
    
    if (!Array.isArray(ids) || !updates) {
      return res.status(400).json({ 
        message: 'Invalid request: ids array and updates object required' 
      });
    }
    
    const result = await Submission.updateMany(
      { _id: { $in: ids } },
      updates
    );
    
    res.json({
      message: `Updated ${result.modifiedCount} submissions`,
      modifiedCount: result.modifiedCount
    });
    
  } catch (error) {
    console.error('Bulk update error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Delete submission (soft delete by setting inactive)
router.delete('/:id', authenticateToken, requirePermission('manageUsers'), async (req, res) => {
  try {
    const submission = await Submission.findByIdAndUpdate(
      req.params.id,
      { 
        status: 'deleted',
        deletedAt: new Date(),
        deletedBy: req.user._id
      },
      { new: true }
    );
    
    if (!submission) {
      return res.status(404).json({ message: 'Submission not found' });
    }
    
    res.json({ message: 'Submission deleted successfully' });
    
  } catch (error) {
    console.error('Delete submission error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;