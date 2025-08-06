const express = require('express');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const Submission = require('../models/Submission');
const { authenticateToken, requirePermission } = require('../middleware/auth');

const router = express.Router();

// Get dashboard analytics
router.get('/dashboard', authenticateToken, requirePermission('viewAnalytics'), async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));
    
    // Get comprehensive analytics
    const [analytics] = await Submission.getAnalytics(parseInt(days));
    
    // Additional real-time stats
    const totalAllTime = await Submission.countDocuments({});
    const todaySubmissions = await Submission.countDocuments({
      submission_date: {
        $gte: new Date(new Date().setHours(0, 0, 0, 0))
      }
    });
    
    // Quality metrics
    const highQualitySubmissions = await Submission.countDocuments({
      submission_date: { $gte: startDate },
      quality_score: { $gte: 80 }
    });
    
    const totalPeriod = analytics.totalSubmissions[0]?.count || 0;
    const qualityRate = totalPeriod > 0 ? (highQualitySubmissions / totalPeriod * 100) : 0;
    
    // Recent activity
    const recentSubmissions = await Submission.find({
      submission_date: { $gte: startDate }
    })
    .sort({ submission_date: -1 })
    .limit(5)
    .select('fname lname email submission_date geolocation.city geolocation.country quality_score status')
    .lean();
    
    // Top performing locations
    const topLocations = await Submission.aggregate([
      {
        $match: {
          submission_date: { $gte: startDate },
          'geolocation.country': { $ne: 'Unknown' }
        }
      },
      {
        $group: {
          _id: '$geolocation.country',
          count: { $sum: 1 },
          avgQuality: { $avg: '$quality_score' }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);
    
    // Device/Browser analytics
    const deviceStats = await Submission.aggregate([
      {
        $match: { submission_date: { $gte: startDate } }
      },
      {
        $group: {
          _id: '$device_info.type',
          count: { $sum: 1 }
        }
      }
    ]);
    
    const browserStats = await Submission.aggregate([
      {
        $match: { submission_date: { $gte: startDate } }
      },
      {
        $group: {
          _id: '$browser_info.family',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]);
    
    // Hourly distribution
    const hourlyStats = await Submission.aggregate([
      {
        $match: { submission_date: { $gte: startDate } }
      },
      {
        $group: {
          _id: { $hour: '$submission_date' },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);
    
    res.json({
      period: {
        days: parseInt(days),
        startDate,
        endDate: new Date()
      },
      totals: {
        allTime: totalAllTime,
        period: totalPeriod,
        today: todaySubmissions,
        qualityRate: Math.round(qualityRate)
      },
      analytics: {
        totalSubmissions: analytics.totalSubmissions,
        byCountry: analytics.byCountry || [],
        byDevice: analytics.byDevice || [],
        byStatus: analytics.byStatus || [],
        dailySubmissions: analytics.dailySubmissions || [],
        avgQualityScore: analytics.avgQualityScore?.[0]?.avg || 0
      },
      additional: {
        topLocations,
        deviceStats,
        browserStats,
        hourlyStats,
        recentSubmissions
      }
    });
    
  } catch (error) {
    console.error('Dashboard analytics error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Get conversion funnel data
router.get('/funnel', authenticateToken, requirePermission('viewAnalytics'), async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));
    
    const funnelData = await Submission.aggregate([
      {
        $match: { submission_date: { $gte: startDate } }
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          avgQuality: { $avg: '$quality_score' }
        }
      }
    ]);
    
    // Define funnel order
    const funnelOrder = ['pending', 'processed', 'contacted', 'qualified'];
    const funnel = funnelOrder.map(status => {
      const data = funnelData.find(item => item._id === status);
      return {
        status,
        count: data?.count || 0,
        avgQuality: data?.avgQuality || 0
      };
    });
    
    // Calculate conversion rates
    const totalSubmissions = funnel.reduce((sum, stage) => sum + stage.count, 0);
    funnel.forEach((stage, index) => {
      if (index === 0) {
        stage.conversionRate = 100; // First stage is 100%
      } else {
        const previousCount = funnel[index - 1].count;
        stage.conversionRate = previousCount > 0 ? (stage.count / previousCount * 100) : 0;
      }
    });
    
    res.json({
      period: { days: parseInt(days), startDate },
      totalSubmissions,
      funnel
    });
    
  } catch (error) {
    console.error('Funnel analytics error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Export data to CSV
router.get('/export/csv', authenticateToken, requirePermission('exportData'), async (req, res) => {
  try {
    const { dateFrom, dateTo, status, country } = req.query;
    
    // Build filter
    const filter = {};
    if (dateFrom || dateTo) {
      filter.submission_date = {};
      if (dateFrom) filter.submission_date.$gte = new Date(dateFrom);
      if (dateTo) filter.submission_date.$lte = new Date(dateTo);
    }
    if (status) filter.status = status;
    if (country) filter['geolocation.country'] = country;
    
    // Get submissions
    const submissions = await Submission.find(filter)
      .sort({ submission_date: -1 })
      .lean();
    
    if (submissions.length === 0) {
      return res.status(404).json({ message: 'No data found for export' });
    }
    
    // Prepare CSV data
    const csvData = submissions.map(sub => ({
      id: sub._id.toString(),
      firstName: sub.fname,
      lastName: sub.lname,
      email: sub.email,
      phone: sub.phone,
      address: sub.address,
      city: sub.city,
      state: sub.state,
      zip: sub.zip,
      gender: sub.gender,
      dateOfBirth: sub.date_of_birth?.toISOString().split('T')[0],
      incidentDate: sub.diagnosis_year?.toISOString().split('T')[0],
      country: sub.geolocation?.country,
      region: sub.geolocation?.region,
      ipAddress: sub.ip_address,
      browser: sub.browser_info?.family,
      device: sub.device_info?.type,
      status: sub.status,
      qualityScore: sub.quality_score,
      submissionDate: sub.submission_date?.toISOString(),
      trustedFormCert: sub.trusted_form_cert_url
    }));
    
    // Generate filename
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const filename = `rideshare_submissions_${timestamp}.csv`;
    const filepath = path.join(__dirname, '..', 'exports', filename);
    
    // Ensure exports directory exists
    const exportsDir = path.dirname(filepath);
    if (!fs.existsSync(exportsDir)) {
      fs.mkdirSync(exportsDir, { recursive: true });
    }
    
    // Create CSV writer
    const csvWriter = createCsvWriter({
      path: filepath,
      header: Object.keys(csvData[0]).map(key => ({
        id: key,
        title: key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())
      }))
    });
    
    await csvWriter.writeRecords(csvData);
    
    // Send file
    res.download(filepath, filename, (err) => {
      if (err) {
        console.error('CSV download error:', err);
        res.status(500).json({ message: 'Export failed' });
      }
      // Clean up file after download
      setTimeout(() => {
        fs.unlink(filepath, () => {});
      }, 60000); // Delete after 1 minute
    });
    
  } catch (error) {
    console.error('CSV export error:', error);
    res.status(500).json({ message: 'Export failed' });
  }
});

// Export data to Excel
router.get('/export/excel', authenticateToken, requirePermission('exportData'), async (req, res) => {
  try {
    const { dateFrom, dateTo, status, country } = req.query;
    
    // Build filter (same as CSV)
    const filter = {};
    if (dateFrom || dateTo) {
      filter.submission_date = {};
      if (dateFrom) filter.submission_date.$gte = new Date(dateFrom);
      if (dateTo) filter.submission_date.$lte = new Date(dateTo);
    }
    if (status) filter.status = status;
    if (country) filter['geolocation.country'] = country;
    
    const submissions = await Submission.find(filter)
      .sort({ submission_date: -1 })
      .lean();
    
    if (submissions.length === 0) {
      return res.status(404).json({ message: 'No data found for export' });
    }
    
    // Create workbook
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Rideshare Submissions');
    
    // Define columns
    worksheet.columns = [
      { header: 'ID', key: 'id', width: 25 },
      { header: 'First Name', key: 'firstName', width: 15 },
      { header: 'Last Name', key: 'lastName', width: 15 },
      { header: 'Email', key: 'email', width: 25 },
      { header: 'Phone', key: 'phone', width: 15 },
      { header: 'Address', key: 'address', width: 30 },
      { header: 'City', key: 'city', width: 15 },
      { header: 'State', key: 'state', width: 8 },
      { header: 'ZIP', key: 'zip', width: 10 },
      { header: 'Gender', key: 'gender', width: 10 },
      { header: 'Date of Birth', key: 'dateOfBirth', width: 15 },
      { header: 'Incident Date', key: 'incidentDate', width: 15 },
      { header: 'Country', key: 'country', width: 15 },
      { header: 'Region', key: 'region', width: 15 },
      { header: 'IP Address', key: 'ipAddress', width: 15 },
      { header: 'Browser', key: 'browser', width: 15 },
      { header: 'Device', key: 'device', width: 10 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Quality Score', key: 'qualityScore', width: 12 },
      { header: 'Submission Date', key: 'submissionDate', width: 20 },
      { header: 'Trusted Form Cert', key: 'trustedFormCert', width: 40 }
    ];
    
    // Style header row
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' }
    };
    worksheet.getRow(1).font = { color: { argb: 'FFFFFFFF' }, bold: true };
    
    // Add data
    submissions.forEach(sub => {
      worksheet.addRow({
        id: sub._id.toString(),
        firstName: sub.fname,
        lastName: sub.lname,
        email: sub.email,
        phone: sub.phone,
        address: sub.address,
        city: sub.city,
        state: sub.state,
        zip: sub.zip,
        gender: sub.gender,
        dateOfBirth: sub.date_of_birth?.toISOString().split('T')[0],
        incidentDate: sub.diagnosis_year?.toISOString().split('T')[0],
        country: sub.geolocation?.country,
        region: sub.geolocation?.region,
        ipAddress: sub.ip_address,
        browser: sub.browser_info?.family,
        device: sub.device_info?.type,
        status: sub.status,
        qualityScore: sub.quality_score,
        submissionDate: sub.submission_date?.toISOString(),
        trustedFormCert: sub.trusted_form_cert_url
      });
    });
    
    // Generate filename and write file
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const filename = `rideshare_submissions_${timestamp}.xlsx`;
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    await workbook.xlsx.write(res);
    res.end();
    
  } catch (error) {
    console.error('Excel export error:', error);
    res.status(500).json({ message: 'Export failed' });
  }
});

// Get map data for visualizations
router.get('/map-data', authenticateToken, requirePermission('viewAnalytics'), async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));
    
    const mapData = await Submission.aggregate([
      {
        $match: {
          submission_date: { $gte: startDate },
          'geolocation.latitude': { $ne: 0 },
          'geolocation.longitude': { $ne: 0 }
        }
      },
      {
        $group: {
          _id: {
            lat: '$geolocation.latitude',
            lng: '$geolocation.longitude',
            city: '$geolocation.city',
            region: '$geolocation.region',
            country: '$geolocation.country'
          },
          count: { $sum: 1 },
          submissions: {
            $push: {
              id: '$_id',
              name: { $concat: ['$fname', ' ', '$lname'] },
              email: '$email',
              status: '$status',
              quality_score: '$quality_score',
              submission_date: '$submission_date'
            }
          }
        }
      },
      {
        $project: {
          _id: 0,
          coordinates: {
            lat: '$_id.lat',
            lng: '$_id.lng'
          },
          location: {
            city: '$_id.city',
            region: '$_id.region',
            country: '$_id.country'
          },
          count: 1,
          submissions: { $slice: ['$submissions', 10] } // Limit to 10 submissions per location
        }
      },
      { $sort: { count: -1 } }
    ]);
    
    res.json(mapData);
    
  } catch (error) {
    console.error('Map data error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;