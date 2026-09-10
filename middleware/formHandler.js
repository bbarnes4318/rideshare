const axios = require('axios');
const geoip = require('geoip-lite');
const useragent = require('useragent');
const zipcodes = require('zipcodes');
const Submission = require('../models/Submission');

// Build a Date at LOCAL midnight from a date string. A bare 'yyyy-mm-dd' handed
// to new Date() is parsed as UTC midnight, so reading it back anywhere behind
// UTC yields the previous day; both supported shapes are therefore assembled
// from their parts. Module scope so the catch-block fallback can reach it too.
const parseDate = (dateStr) => {
  if (!dateStr) return new Date();
  try {
    const str = String(dateStr).trim();

    // MM/DD/YYYY -- what the quote form posts
    const slash = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slash) {
      const date = new Date(Number(slash[3]), Number(slash[1]) - 1, Number(slash[2]));
      if (!isNaN(date.getTime())) return date;
    }

    // YYYY-MM-DD -- what a raw date input would post
    const dash = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (dash) {
      const date = new Date(Number(dash[1]), Number(dash[2]) - 1, Number(dash[3]));
      if (!isNaN(date.getTime())) return date;
    }

    const date = new Date(str);
    if (!isNaN(date.getTime())) return date;
    return new Date(); // fallback
  } catch (error) {
    return new Date(); // fallback
  }
};

// Credential for the upstream lead API, read from the environment.
//
// This used to arrive as the browser's `Authorization` header: index.html
// btoa()'d a Basic user/password into every page it served. Nothing in this
// application ever verified it -- /api-proxy/ has no auth middleware -- it was
// only ever forwarded to ORIGINAL_API_URL, so publishing it to every visitor
// protected nothing and exposed the upstream password. It lives in the server
// environment now. A native browser form POST cannot set a request header at
// all, which is the other reason this had to move.
//
// Set ORIGINAL_API_AUTH to a complete header value ("Basic <base64>"), or set
// ORIGINAL_API_USERNAME / ORIGINAL_API_PASSWORD and let this build it.
const upstreamAuthHeader = () => {
  if (process.env.ORIGINAL_API_AUTH) {
    return { Authorization: process.env.ORIGINAL_API_AUTH };
  }
  const user = process.env.ORIGINAL_API_USERNAME;
  const pass = process.env.ORIGINAL_API_PASSWORD;
  if (user && pass) {
    return { Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') };
  }
  return {};
};

// True when the POST came from a browser performing the form's own submission
// rather than from fetch(). A native submit sends the form encoding and asks
// for a document back; the AJAX path sends JSON and parses JSON. Detected from
// the request itself so both variants can share this one endpoint -- Step 6 of
// the A/B plan explicitly rules out a duplicate route.
const isNativeFormPost = (req) => {
  const type = String(req.headers['content-type'] || '');
  if (/application\/json/i.test(type)) return false;
  if (/application\/x-www-form-urlencoded|multipart\/form-data/i.test(type)) return true;
  return /text\/html/i.test(String(req.headers.accept || ''));
};

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

// The confirmation document the native variant lands on.
//
// It is deliberately inert: no TrustedForm loader, no form, no script. The
// certificate belongs to the page that was submitted, and a second TrustedForm
// session here would start a second certificate for the same lead.
const confirmationPage = (submissionId) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Request received</title>
    <style>
      body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0;
             min-height: 100vh; display: grid; place-items: center; background: #f8fafc; color: #0f172a; }
      main { max-width: 30rem; padding: 2rem; text-align: center; background: #fff;
             border: 1px solid #e2e8f0; border-radius: .75rem; }
      p.id { color: #64748b; font-size: .75rem; margin-top: 1.5rem; }
    </style>
  </head>
  <body>
    <main>
      <h1 id="response-message">&#10003; Request received</h1>
      <p>A licensed agent will call you shortly with your rates.</p>
      <p class="id">Reference: ${escapeHtml(submissionId)}</p>
    </main>
  </body>
</html>
`;

// Enhanced form handler that captures additional data
const formHandler = async (req, res) => {
  try {
    // Get client IP address
    const clientIP = req.headers['x-forwarded-for'] || 
                    req.headers['x-real-ip'] || 
                    req.connection.remoteAddress || 
                    req.socket.remoteAddress ||
                    (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
                    req.ip;

    // Clean IP address (remove IPv6 prefix if present)
    const cleanIP = clientIP?.replace(/^.*:/, '') || '127.0.0.1';
    
    // Get user agent
    const userAgentString = req.headers['user-agent'] || '';
    
    // Parse user agent for browser/device info
    const agent = useragent.parse(userAgentString);
    
    // Get basic geolocation from IP (offline lookup)
    let geoData = geoip.lookup(cleanIP) || {};
    
    // Enhanced geolocation using IPStack API
    let enhancedGeoData = {};
    if (process.env.IPSTACK_API_KEY && cleanIP !== '127.0.0.1') {
      try {
        const geoResponse = await axios.get(
          `http://api.ipstack.com/${cleanIP}?access_key=${process.env.IPSTACK_API_KEY}`,
          { timeout: 5000 }
        );
        enhancedGeoData = geoResponse.data;
      } catch (geoError) {
        console.warn('IPStack API error:', geoError.message);
      }
    }
    
    // Combine geolocation data
    const geolocation = {
      country: enhancedGeoData.country_name || geoData.country || 'Unknown',
      country_code: enhancedGeoData.country_code || geoData.country || 'XX',
      region: enhancedGeoData.region_name || geoData.region || 'Unknown',
      region_code: enhancedGeoData.region_code || '',
      city: enhancedGeoData.city || geoData.city || 'Unknown',
      zip: enhancedGeoData.zip || geoData.zip || '',
      latitude: enhancedGeoData.latitude || geoData.ll?.[0] || 0,
      longitude: enhancedGeoData.longitude || geoData.ll?.[1] || 0,
      timezone: enhancedGeoData.time_zone?.id || geoData.timezone || '',
      isp: enhancedGeoData.connection?.isp || '',
      org: enhancedGeoData.connection?.organization || ''
    };
    
    // Device detection
    const getDeviceType = (userAgent) => {
      const ua = userAgent.toLowerCase();
      if (/mobile|android|iphone|ipod|blackberry|opera mini|iemobile/i.test(ua)) {
        return 'mobile';
      }
      if (/tablet|ipad/i.test(ua)) {
        return 'tablet';
      }
      return 'desktop';
    };
    
    // Parse form data from request
    const formData = Array.isArray(req.body) ? req.body[0] : req.body;

    // Derive city/state from the submitted zip code.
    // Offline lookup - no API call, no key. Falls back to IP geolocation
    // only if the zip is missing or does not resolve.
    const submittedZip = formData.zip?.toString().trim().slice(0, 5);
    const zipLookup = submittedZip ? zipcodes.lookup(submittedZip) : null;
    if (submittedZip && !zipLookup) {
      console.warn('Zip code did not resolve to a city/state:', submittedZip);
    }
    
    // Normalize a Yes/No answer coming from the form
    const yesNo = (val) => {
      if (val === undefined || val === null || val === '') return undefined;
      const v = String(val).trim().toLowerCase();
      if (['y', 'yes', 'true', '1'].includes(v)) return 'Yes';
      if (['n', 'no', 'false', '0'].includes(v)) return 'No';
      return undefined;
    };

    // Normalize gender to the schema's enum
    const normalizeGender = (val) => {
      if (!val) return 'Other';
      const v = String(val).trim().toLowerCase();
      if (['m', 'male'].includes(v)) return 'Male';
      if (['f', 'female'].includes(v)) return 'Female';
      if (['x', 'non-binary', 'nonbinary', 'non binary'].includes(v)) return 'Non-Binary';
      return 'Other';
    };

    const toNumber = (val) => {
      const n = parseInt(val, 10);
      return isNaN(n) ? undefined : n;
    };

    // Create submission object
    const submissionData = {
      // Form fields
      fname: formData.fname?.trim(),
      lname: formData.lname?.trim(),
      email: formData.email?.trim().toLowerCase(),
      phone: formData.phone?.replace(/\D/g, ''), // Remove non-digits
      address: formData.address?.trim(),
      // City/state are derived from the submitted zip code, with IP geolocation as fallback
      city: formData.city?.trim() || zipLookup?.city || geolocation.city,
      state: (formData.state || zipLookup?.state || geolocation.region_code || geolocation.region)?.toUpperCase(),
      zip: formData.zip?.trim(),
      gender: normalizeGender(formData.gender),
      date_of_birth: parseDate(formData.date_of_birth),

      // Life insurance qualification fields
      currently_insured: yesNo(formData.currently_insured),
      credit_rating: formData.credit_rating?.trim().toLowerCase(),
      marital: yesNo(formData.marital),
      homeowner: yesNo(formData.homeowner),
      military: yesNo(formData.military),
      tobacco_use: yesNo(formData.tobacco_use),
      cancer: yesNo(formData.cancer),
      heart_disease: yesNo(formData.heart_disease),
      coverage_amount: formData.coverage_amount?.trim(),
      height: toNumber(formData.height),
      weight: toNumber(formData.weight),
      
      // Technical data
      ip_address: cleanIP,
      geolocation,
      user_agent: userAgentString,
      
      // Browser info
      browser_info: {
        family: agent.family || 'Unknown',
        version: agent.toVersion() || 'Unknown',
        major: agent.major || 'Unknown'
      },
      
      // OS info
      os_info: {
        family: agent.os.family || 'Unknown',
        version: agent.os.toVersion() || 'Unknown',
        major: agent.os.major || 'Unknown'
      },
      
      // Device info - flatten to match schema
      'device_info.family': agent.device.family || 'Unknown',
      'device_info.brand': agent.device.brand || 'Unknown',
      'device_info.model': agent.device.model || 'Unknown',
      'device_info.type': getDeviceType(userAgentString),
      
      // Trusted form and metadata
      trusted_form_cert_url: formData.xxTrustedFormCertUrl || formData.Trusted_Form_Alt || formData.trusted_form_cert_url || 'https://cert.trustedform.com/pending',
      case_type: formData.case_type || 'Life Insurance',
      ownerid: formData.ownerid || '005TR00000CDuezYAD',
      campaign: formData.campaign || '',
      offer_url: formData.offer_url || req.headers.referer || '',
      
      // Additional tracking
      referrer: req.headers.referer || '',
      submission_date: new Date()
    };
    
    // Save to database
    const submission = new Submission(submissionData);
    await submission.save();
    
    console.log('✅ New submission saved:', {
      id: submission._id,
      email: submission.email,
      location: `${submission.geolocation.city}, ${submission.geolocation.country}`,
      quality_score: submission.quality_score
    });
    
    // Forward to original API endpoint (if needed)
    let originalResponse = { status: 'SUCCESS' };
    
    // If there's an original external API, forward the request
    if (process.env.ORIGINAL_API_URL) {
      try {
        const forwardResponse = await axios.post(process.env.ORIGINAL_API_URL, [formData], {
          headers: {
            'Content-Type': 'application/json',
            ...upstreamAuthHeader(),
          },
          timeout: 10000
        });
        originalResponse = forwardResponse.data;
      } catch (forwardError) {
        console.warn('Original API forward error:', forwardError.message);
      }
    }
    
    // Return success response.
    //
    // The AJAX variant parses JSON. The native variant is a browser navigating,
    // so it gets a document; anything else renders as raw JSON in the viewport.
    // Both paths are the same submission through the same endpoint -- only the
    // representation of the reply differs.
    if (isNativeFormPost(req)) {
      res.status(200).type('html').send(confirmationPage(submission._id));
    } else {
      res.json({
        status: 'SUCCESS',
        message: 'Submission received successfully',
        submissionId: submission._id,
        ...originalResponse
      });
    }
    
  } catch (error) {
    console.error('Form handler error:', error);
    
    // Still try to save basic submission data even if enhanced features fail
    if (req.body) {
      try {
        const basicData = Array.isArray(req.body) ? req.body[0] : req.body;
        const basicZip = basicData.zip?.toString().trim().slice(0, 5);
        const basicZipLookup = basicZip ? zipcodes.lookup(basicZip) : null;
        const basicSubmission = new Submission({
          fname: basicData.fname,
          lname: basicData.lname,
          email: basicData.email,
          phone: basicData.phone,
          address: basicData.address,
          city: basicData.city || basicZipLookup?.city,
          state: basicData.state || basicZipLookup?.state,
          zip: basicData.zip,
          gender: basicData.gender,
          date_of_birth: parseDate(basicData.date_of_birth),
          coverage_amount: basicData.coverage_amount,
          ip_address: req.ip || '127.0.0.1',
          user_agent: req.headers['user-agent'] || '',
          trusted_form_cert_url: basicData.xxTrustedFormCertUrl || '',
          geolocation: { country: 'Unknown', city: 'Unknown' }
        });
        await basicSubmission.save();
        console.log('✅ Basic submission saved despite errors');
      } catch (basicError) {
        console.error('Failed to save basic submission:', basicError);
      }
    }
    
    if (isNativeFormPost(req)) {
      res.status(500).type('html').send(
        '<!doctype html><meta charset="utf-8"><title>Submission failed</title>' +
        '<p id="response-message">Submission failed. Please try again.</p>' +
        '<p>' + escapeHtml(error.message) + '</p>'
      );
    } else {
      res.status(500).json({
        status: 'ERROR',
        message: 'Submission failed. Please try again.',
        error: error.message // Always show error for debugging
      });
    }
  }
};

module.exports = formHandler;