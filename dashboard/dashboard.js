// Dashboard JavaScript
class RideshareDashboard {
  constructor() {
    this.token = localStorage.getItem("token");
    this.user = JSON.parse(localStorage.getItem("user") || "{}");
    this.currentSection = "dashboard";
    this.charts = {};
    this.map = null;
    this.dashboardData = null;

    this.init();
  }

  init() {
    // Always initialize event listeners for navigation to work
    this.initEventListeners();

    // Check authentication for data loading
    if (!this.token) {
      console.warn("No authentication token found. Please log in.");
      // Redirect to login if not authenticated
      window.location.href = "/admin";
      return;
    }

    // Set user info
    this.setUserInfo();

    // Load initial data
    this.loadDashboardData();

    // Set up auto-refresh
    this.setupAutoRefresh();
  }

  setUserInfo() {
    document.getElementById("userName").textContent =
      this.user.username || "User";
    document.getElementById("userRole").textContent = this.user.role || "User";
  }

  initEventListeners() {
    // Navigation
    document.querySelectorAll(".nav-item").forEach((item) => {
      // Some nav items are ordinary links to their own page (the batch
      // upload harness). Those have no data-section, so leave the browser
      // to follow the href instead of swallowing the click.
      if (!item.dataset.section) return;
      item.addEventListener("click", (e) => {
        e.preventDefault();
        this.switchSection(item.dataset.section);
      });
    });

    // Logout
    document.getElementById("logoutBtn").addEventListener("click", () => {
      this.logout();
    });

    // Refresh
    document.getElementById("refreshBtn").addEventListener("click", () => {
      this.loadDashboardData();
    });

    // Dark mode toggle
    document.getElementById("darkModeToggle").addEventListener("click", () => {
      this.toggleDarkMode();
    });

    // Search and filters (for submissions section)
    const searchInput = document.getElementById("searchInput");
    if (searchInput) {
      searchInput.addEventListener(
        "input",
        this.debounce(() => this.loadSubmissions(), 500),
      );
    }

    const statusFilter = document.getElementById("statusFilter");
    if (statusFilter) {
      statusFilter.addEventListener("change", () => this.loadSubmissions());
    }

    const countryFilter = document.getElementById("countryFilter");
    if (countryFilter) {
      countryFilter.addEventListener("change", () => this.loadSubmissions());
    }

    // Export button
    const exportBtn = document.getElementById("exportBtn");
    if (exportBtn) {
      exportBtn.addEventListener("click", () => this.exportData());
    }
  }

  switchSection(section) {
    // Update active nav
    document.querySelectorAll(".nav-item").forEach((item) => {
      item.classList.remove("active");
    });
    document
      .querySelector(`[data-section="${section}"]`)
      .classList.add("active");

    // Hide all sections
    document.querySelectorAll(".section-content").forEach((content) => {
      content.classList.add("hidden");
    });

    // Show selected section
    document.getElementById(`${section}-section`).classList.remove("hidden");

    // Update page title
    const titles = {
      dashboard: "Dashboard Overview",
      submissions: "Submissions Management",
      analytics: "Advanced Analytics",
      map: "Geographic Distribution",
    };

    const subtitles = {
      dashboard: "Real-time analytics and insights",
      submissions: "Manage and track submissions",
      analytics: "Detailed analytics and reports",
      map: "Global submission visualization",
    };

    document.getElementById("pageTitle").textContent = titles[section];
    document.getElementById("pageSubtitle").textContent = subtitles[section];

    this.currentSection = section;

    // Load section-specific data
    switch (section) {
      case "dashboard":
        this.loadDashboardData();
        break;
      case "submissions":
        this.loadSubmissions();
        break;
      case "map":
        this.loadMapData();
        break;
    }
  }

  async loadDashboardData() {
    this.showLoading();

    try {
      const response = await this.apiCall("/api/analytics/dashboard");
      this.dashboardData = response;

      this.updateMetrics(response.totals);
      this.createCharts(response);
      this.updateLastUpdated();
    } catch (error) {
      // Say what actually broke. The generic message hid the real exception,
      // and because the auto-refresh repeats every 30s it hid it repeatedly.
      console.error("Error loading dashboard data:", error);
      this.showError("Dashboard data failed: " + (error && error.message ? error.message : error));
    } finally {
      this.hideLoading();
    }
  }

  updateMetrics(totals) {
    document.getElementById("periodSubmissions").textContent =
      totals.period.toLocaleString();
    document.getElementById("todaySubmissions").textContent =
      totals.today.toLocaleString();
    document.getElementById("qualityRate").textContent =
      `${totals.qualityRate}%`;
    document.getElementById("totalSubmissions").textContent =
      totals.allTime.toLocaleString();
  }

  createCharts(data) {
    // Charts are decorative. If Chart.js is missing or a single chart config
    // throws, the metrics and tables are still perfectly good - so a chart
    // failure is reported once and does not take down the whole dashboard load.
    if (typeof Chart === "undefined") {
      this.showError("Charts unavailable: Chart.js did not define window.Chart "
        + "(check /dashboard/vendor/chart.umd.min.js loads and is the UMD build). "
        + "Metrics still work.");
      return;
    }
    const safely = (name, fn, arg) => {
      try {
        fn.call(this, arg);
      } catch (error) {
        console.error("Chart failed: " + name, error);
        this.chartErrors = (this.chartErrors || []).concat(name);
      }
    };
    this.chartErrors = [];
    safely("submissions", this.createSubmissionsChart, data.analytics.dailySubmissions);
    safely("device", this.createDeviceChart, data.analytics.byDevice);
    safely("location", this.createLocationChart, data.additional.topLocations);
    safely("status", this.createStatusChart, data.analytics.byStatus);
    if (this.chartErrors.length) {
      this.showError("Some charts failed to render: " + this.chartErrors.join(", ")
        + ". The figures above are unaffected.");
    }
  }

  createSubmissionsChart(dailyData) {
    const ctx = document.getElementById("submissionsChart").getContext("2d");

    if (this.charts.submissions) {
      this.charts.submissions.destroy();
    }

    const labels = dailyData.map((item) => item._id);
    const values = dailyData.map((item) => item.count);

    this.charts.submissions = new Chart(ctx, {
      type: "line",
      data: {
        labels: labels,
        datasets: [
          {
            label: "Submissions",
            data: values,
            borderColor: "#3b82f6",
            backgroundColor: "rgba(59, 130, 246, 0.1)",
            tension: 0.4,
            fill: true,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false,
          },
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: {
              color: "rgba(0, 0, 0, 0.1)",
            },
          },
          x: {
            grid: {
              display: false,
            },
          },
        },
      },
    });
  }

  createDeviceChart(deviceData) {
    const ctx = document.getElementById("deviceChart").getContext("2d");

    if (this.charts.device) {
      this.charts.device.destroy();
    }

    const labels = deviceData.map((item) => item._id || "Unknown");
    const values = deviceData.map((item) => item.count);
    const colors = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6"];

    this.charts.device = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels: labels,
        datasets: [
          {
            data: values,
            backgroundColor: colors.slice(0, labels.length),
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: "bottom",
          },
        },
      },
    });
  }

  createLocationChart(locationData) {
    const ctx = document.getElementById("locationChart").getContext("2d");

    if (this.charts.location) {
      this.charts.location.destroy();
    }

    const labels = locationData.slice(0, 10).map((item) => item._id);
    const values = locationData.slice(0, 10).map((item) => item.count);

    this.charts.location = new Chart(ctx, {
      type: "bar",
      data: {
        labels: labels,
        datasets: [
          {
            label: "Submissions",
            data: values,
            backgroundColor: "#10b981",
            borderRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false,
          },
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: {
              color: "rgba(0, 0, 0, 0.1)",
            },
          },
          x: {
            grid: {
              display: false,
            },
          },
        },
      },
    });
  }

  createStatusChart(statusData) {
    const ctx = document.getElementById("statusChart").getContext("2d");

    if (this.charts.status) {
      this.charts.status.destroy();
    }

    const labels = statusData.map((item) => item._id);
    const values = statusData.map((item) => item.count);
    const colors = {
      pending: "#f59e0b",
      processed: "#3b82f6",
      contacted: "#10b981",
      qualified: "#059669",
      rejected: "#ef4444",
    };

    this.charts.status = new Chart(ctx, {
      type: "pie",
      data: {
        labels: labels,
        datasets: [
          {
            data: values,
            backgroundColor: labels.map((label) => colors[label] || "#6b7280"),
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: "bottom",
          },
        },
      },
    });
  }

  async loadSubmissions(page = 1) {
    this.showLoading();

    try {
      const params = new URLSearchParams({
        page: page,
        limit: 20,
      });

      // Add filters
      const search = document.getElementById("searchInput");
      if (search && search.value) params.append("search", search.value);

      const status = document.getElementById("statusFilter");
      if (status && status.value) params.append("status", status.value);

      const country = document.getElementById("countryFilter");
      if (country && country.value) params.append("country", country.value);

      const response = await this.apiCall(`/api/submissions?${params}`);

      this.renderSubmissions(response.submissions);
      this.renderPagination(response.pagination);

      document.getElementById("submissionCount").textContent =
        response.pagination.total;
    } catch (error) {
      console.error("Error loading submissions:", error);
      this.showError("Failed to load submissions");
    } finally {
      this.hideLoading();
    }
  }

  renderSubmissions(submissions) {
    const tbody = document.getElementById("submissionsTableBody");
    if (!tbody) return;

    tbody.innerHTML = "";

    if (!submissions.length) {
      tbody.innerHTML = `
                <tr>
                    <td colspan="8" class="px-4 py-10 text-center text-sm text-gray-500">
                        No submissions match the current filters.
                    </td>
                </tr>
            `;
      return;
    }

    submissions.forEach((submission) => {
      const row = document.createElement("tr");
      row.className = "hover:bg-gray-50";

      const statusClass = `status-${submission.status}`;
      const submittedAt = new Date(submission.submission_date);
      const date = submittedAt.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
      const time = submittedAt.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      });
      const city = submission.geolocation?.city || "Unknown";
      const country = submission.geolocation?.country || "Unknown";
      const location = `${city}, ${country}`;
      const name = `${submission.fname} ${submission.lname}`;

      const score = Number(submission.quality_score) || 0;
      const scoreColor =
        score >= 70 ? "#16a34a" : score >= 40 ? "#f59e0b" : "#dc2626";

      const trustedFormBadge = submission.trusted_form_cert_url
        ? `<a href="${submission.trusted_form_cert_url}" target="_blank" title="View TrustedForm certificate" class="text-green-600 hover:text-green-800 font-semibold text-xs whitespace-nowrap">✓ <span class="cert-word">Verified</span></a>`
        : '<span class="text-red-500 text-xs whitespace-nowrap" title="No TrustedForm certificate">✗ <span class="cert-word">No cert</span></span>';

      row.innerHTML = `
                <td data-label="Name">
                    <div class="cell-truncate font-medium" title="${name}">${name}</div>
                </td>
                <td data-label="Contact">
                    <div class="cell-stack">
                        <div class="cell-truncate" title="${submission.email}">${submission.email}</div>
                        <div class="cell-truncate cell-sub" title="${submission.phone}">${submission.phone}</div>
                    </div>
                </td>
                <td data-label="Cert">
                    ${trustedFormBadge}
                </td>
                <td data-label="Location">
                    <div class="cell-truncate" title="${location}">${location}</div>
                </td>
                <td data-label="Status">
                    <span class="status-badge ${statusClass}">${submission.status}</span>
                </td>
                <td data-label="Score">
                    <div class="cell-stack">
                        <div class="text-gray-900">${score}</div>
                        <div class="quality-meter"><span style="width:${Math.min(score, 100)}%;background:${scoreColor}"></span></div>
                    </div>
                </td>
                <td data-label="Date">
                    <div class="cell-stack" title="${submittedAt.toLocaleString()}">
                        <div class="cell-truncate">${date}</div>
                        <div class="cell-truncate cell-sub">${time}</div>
                    </div>
                </td>
                <td data-label="">
                    <button class="view-btn" onclick="dashboard.viewSubmission('${submission._id}')">
                        View
                    </button>
                </td>
            `;

      tbody.appendChild(row);
    });
  }

  renderPagination(pagination) {
    const paginationDiv = document.getElementById("pagination");
    if (!paginationDiv) return;

    const prevDisabled = pagination.page <= 1;
    const nextDisabled = pagination.page >= pagination.pages;

    paginationDiv.innerHTML = `
            <div class="flex items-center text-sm text-gray-500">
                Showing ${(pagination.page - 1) * pagination.limit + 1} to ${Math.min(pagination.page * pagination.limit, pagination.total)} of ${pagination.total} results
            </div>
            <div class="flex space-x-2">
                <button 
                    class="px-3 py-1 border rounded ${prevDisabled ? "opacity-50 cursor-not-allowed" : "hover:bg-gray-50"}" 
                    ${prevDisabled ? "disabled" : `onclick="dashboard.loadSubmissions(${pagination.page - 1})"`}
                >
                    Previous
                </button>
                <span class="px-3 py-1 bg-blue-100 text-blue-700 rounded">${pagination.page}</span>
                <button 
                    class="px-3 py-1 border rounded ${nextDisabled ? "opacity-50 cursor-not-allowed" : "hover:bg-gray-50"}" 
                    ${nextDisabled ? "disabled" : `onclick="dashboard.loadSubmissions(${pagination.page + 1})"`}
                >
                    Next
                </button>
            </div>
        `;
  }

  async loadMapData() {
    if (!this.map) {
      this.initMap();
    }

    try {
      const response = await this.apiCall("/api/analytics/map-data");
      this.updateMapMarkers(response);
    } catch (error) {
      console.error("Error loading map data:", error);
    }
  }

  initMap() {
    this.map = L.map("map").setView([39.8283, -98.5795], 4);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors",
    }).addTo(this.map);
  }

  updateMapMarkers(locations) {
    if (this.mapMarkers) {
      this.mapMarkers.forEach((marker) => this.map.removeLayer(marker));
    }
    this.mapMarkers = [];

    locations.forEach((location) => {
      if (location.coordinates.lat && location.coordinates.lng) {
        const marker = L.circleMarker(
          [location.coordinates.lat, location.coordinates.lng],
          {
            radius: Math.min(location.count * 3, 20),
            fillColor: "#3b82f6",
            color: "#1e40af",
            weight: 2,
            opacity: 0.8,
            fillOpacity: 0.6,
          },
        );

        const popupContent = `
                    <strong>${location.location.city}, ${location.location.country}</strong><br>
                    Submissions: ${location.count}<br>
                    Recent submissions: ${location.submissions.length}
                `;

        marker.bindPopup(popupContent);
        marker.addTo(this.map);

        this.mapMarkers.push(marker);
      }
    });
  }

  async exportData() {
    try {
      const params = new URLSearchParams();

      const status = document.getElementById("statusFilter");
      if (status && status.value) params.append("status", status.value);

      const country = document.getElementById("countryFilter");
      if (country && country.value) params.append("country", country.value);

      const response = await fetch(`/api/analytics/export/csv?${params}`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      });

      if (response.ok) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.style.display = "none";
        a.href = url;
        a.download = "rideshare_submissions.csv";
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);

        this.showSuccess("Data exported successfully");
      } else {
        throw new Error("Export failed");
      }
    } catch (error) {
      console.error("Export error:", error);
      this.showError("Failed to export data");
    }
  }

  async viewSubmission(id) {
    try {
      const response = await this.apiCall(`/api/submissions/${id}`);
      this.showSubmissionModal(response);
    } catch (error) {
      console.error("Error loading submission details:", error);
      this.showError("Failed to load submission details");
    }
  }

  showSubmissionModal(submission) {
    const modal = document.createElement("div");
    modal.className =
      "fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50";

    const trustedFormSection = submission.trusted_form_cert_url
      ? `
            <div class="mb-6 p-4 bg-green-50 border-2 border-green-200 rounded-lg">
                <h4 class="text-lg font-bold text-green-800 mb-2">🔐 TrustedForm Certificate</h4>
                <div class="flex items-center justify-between">
                    <span class="text-sm text-green-700">Verification Status: VERIFIED</span>
                    <a href="${submission.trusted_form_cert_url}" target="_blank" class="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700 font-semibold">
                        View Certificate →
                    </a>
                </div>
                <p class="text-xs text-green-600 mt-2">Certificate URL: ${submission.trusted_form_cert_url}</p>
            </div>
        `
      : `
            <div class="mb-6 p-4 bg-red-50 border-2 border-red-200 rounded-lg">
                <h4 class="text-lg font-bold text-red-800 mb-2">⚠️ No TrustedForm Certificate</h4>
                <p class="text-sm text-red-600">This submission does not have a TrustedForm certificate.</p>
            </div>
        `;

    modal.innerHTML = `
            <div class="bg-white rounded-lg p-6 max-w-3xl w-full mx-4 max-h-screen overflow-y-auto">
                <div class="flex justify-between items-center mb-4">
                    <h3 class="text-lg font-semibold">Submission Details</h3>
                    <button class="text-gray-500 hover:text-gray-700" onclick="this.closest('.fixed').remove()">
                        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>
                
                ${trustedFormSection}
                
                <div class="mb-6">
                    <h4 class="text-lg font-semibold text-gray-800 mb-3 border-b pb-1">Contact Information</h4>
                    <div class="grid grid-cols-2 gap-4 text-sm">
                        <div><strong>First Name:</strong> ${submission.fname}</div>
                        <div><strong>Last Name:</strong> ${submission.lname}</div>
                        <div><strong>Email:</strong> <a href="mailto:${submission.email}" class="text-blue-600">${submission.email}</a></div>
                        <div><strong>Phone:</strong> <a href="tel:${submission.phone}" class="text-blue-600">${submission.phone}</a></div>
                    </div>
                </div>
                
                <div class="mb-6">
                    <h4 class="text-lg font-semibold text-gray-800 mb-3 border-b pb-1">Address</h4>
                    <div class="grid grid-cols-2 gap-4 text-sm">
                        <div><strong>Street:</strong> ${submission.address || "N/A"}</div>
                        <div><strong>City:</strong> ${submission.city || "N/A"}</div>
                        <div><strong>State:</strong> ${submission.state || "N/A"}</div>
                        <div><strong>Zip:</strong> ${submission.zip || "N/A"}</div>
                    </div>
                </div>
                
                <div class="mb-6">
                    <h4 class="text-lg font-semibold text-gray-800 mb-3 border-b pb-1">Personal Details</h4>
                    <div class="grid grid-cols-2 gap-4 text-sm">
                        <div><strong>Gender:</strong> ${submission.gender || "N/A"}</div>
                        <div><strong>Date of Birth:</strong> ${submission.date_of_birth ? new Date(submission.date_of_birth).toLocaleDateString() : "N/A"}</div>
                        <div><strong>Height:</strong> ${submission.height ? Math.floor(submission.height / 12) + "'" + (submission.height % 12) + '"' : "N/A"}</div>
                        <div><strong>Weight:</strong> ${submission.weight ? submission.weight + " lbs" : "N/A"}</div>
                    </div>
                </div>

                <div class="mb-6">
                    <h4 class="text-lg font-semibold text-gray-800 mb-3 border-b pb-1">Qualification</h4>
                    <div class="grid grid-cols-2 gap-4 text-sm">
                        <div><strong>Currently Insured:</strong> ${submission.currently_insured || "N/A"}</div>
                        <div><strong>Coverage Wanted:</strong> ${submission.coverage_amount || "N/A"}</div>
                        <div><strong>Credit:</strong> ${submission.credit_rating || "N/A"}</div>
                        <div><strong>Married:</strong> ${submission.marital || "N/A"}</div>
                        <div><strong>Homeowner:</strong> ${submission.homeowner || "N/A"}</div>
                        <div><strong>Military:</strong> ${submission.military || "N/A"}</div>
                        <div><strong>Tobacco:</strong> ${submission.tobacco_use || "N/A"}</div>
                        <div><strong>Cancer:</strong> ${submission.cancer || "N/A"}</div>
                        <div><strong>Heart Disease:</strong> ${submission.heart_disease || "N/A"}</div>
                    </div>
                </div>
                
                <div class="mb-6">
                    <h4 class="text-lg font-semibold text-gray-800 mb-3 border-b pb-1">Case Details</h4>
                    <div class="grid grid-cols-2 gap-4 text-sm">
                        <div><strong>Case Type:</strong> ${submission.case_type || "Life Insurance"}</div>
                        <div><strong>Status:</strong> <span class="status-badge status-${submission.status}">${submission.status}</span></div>
                        <div><strong>Quality Score:</strong> ${submission.quality_score}/100</div>
                        <div><strong>Submitted:</strong> ${new Date(submission.submission_date).toLocaleString()}</div>
                    </div>
                </div>
                
                <div class="mb-4">
                    <h4 class="text-lg font-semibold text-gray-800 mb-3 border-b pb-1">Technical Information</h4>
                    <div class="grid grid-cols-2 gap-4 text-sm">
                        <div><strong>IP Location:</strong> ${submission.geolocation?.city || "Unknown"}, ${submission.geolocation?.country || "Unknown"}</div>
                        <div><strong>Device:</strong> ${submission.device_info?.type || "Unknown"}</div>
                        <div><strong>Browser:</strong> ${submission.browser_info?.family || "Unknown"}</div>
                    </div>
                </div>
            </div>
        `;

    document.body.appendChild(modal);
  }

  toggleDarkMode() {
    document.body.classList.toggle("dark");
    localStorage.setItem("darkMode", document.body.classList.contains("dark"));
  }

  setupAutoRefresh() {
    setInterval(() => {
      if (this.currentSection === "dashboard") {
        this.loadDashboardData();
      }
    }, 30000);
  }

  updateLastUpdated() {
    const now = new Date();
    document.getElementById("lastUpdated").textContent =
      now.toLocaleTimeString();
  }

  logout() {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    window.location.href = "/admin?logout=true";
  }

  async apiCall(endpoint, options = {}) {
    const response = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
      ...options,
    });

    if (!response.ok) {
      if (response.status === 401) {
        // Returning undefined here left the caller to dereference a missing
        // response and report "Failed to load dashboard data" every 30s, with
        // no way out and no hint that the session had simply expired.
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        window.location.href = "/admin?logout=true";
        throw new Error("Your session expired. Redirecting to sign in.");
      }
      throw new Error(
        `API call failed: ${response.status} ${response.statusText} (${endpoint})`
      );
    }

    return await response.json();
  }

  showLoading() {
    const loading = document.getElementById("loadingOverlay");
    if (loading) loading.classList.remove("hidden");
  }

  hideLoading() {
    const loading = document.getElementById("loadingOverlay");
    if (loading) loading.classList.add("hidden");
  }

  showError(message) {
    alert("Error: " + message);
  }

  showSuccess(message) {
    alert("Success: " + message);
  }

  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }
}

// Initialize dashboard when DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
  window.dashboard = new RideshareDashboard();
});
