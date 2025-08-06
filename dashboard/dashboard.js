// Dashboard JavaScript
class RideshareDashboard {
    constructor() {
        this.token = localStorage.getItem('token');
        this.user = JSON.parse(localStorage.getItem('user') || '{}');
        this.currentSection = 'dashboard';
        this.charts = {};
        this.map = null;
        this.dashboardData = null;
        
        this.init();
    }
    
    init() {
        // Check authentication
        if (!this.token) {
            return; // Don't redirect, just don't initialize
        }
        
        // Set user info
        this.setUserInfo();
        
        // Initialize event listeners
        this.initEventListeners();
        
        // Load initial data
        this.loadDashboardData();
        
        // Set up auto-refresh
        this.setupAutoRefresh();
    }
    
    setUserInfo() {
        document.getElementById('userName').textContent = this.user.username || 'User';
        document.getElementById('userRole').textContent = this.user.role || 'User';
    }
    
    initEventListeners() {
        // Navigation
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                const section = item.dataset.section;
                this.switchSection(section);
            });
        });
        
        // Logout
        document.getElementById('logoutBtn').addEventListener('click', () => {
            this.logout();
        });
        
        // Refresh
        document.getElementById('refreshBtn').addEventListener('click', () => {
            this.loadDashboardData();
        });
        
        // Dark mode toggle
        document.getElementById('darkModeToggle').addEventListener('click', () => {
            this.toggleDarkMode();
        });
        
        // Search and filters (for submissions section)
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.addEventListener('input', this.debounce(() => this.loadSubmissions(), 500));
        }
        
        const statusFilter = document.getElementById('statusFilter');
        if (statusFilter) {
            statusFilter.addEventListener('change', () => this.loadSubmissions());
        }
        
        const countryFilter = document.getElementById('countryFilter');
        if (countryFilter) {
            countryFilter.addEventListener('change', () => this.loadSubmissions());
        }
        
        // Export button
        const exportBtn = document.getElementById('exportBtn');
        if (exportBtn) {
            exportBtn.addEventListener('click', () => this.exportData());
        }
    }
    
    switchSection(section) {
        // Update active nav
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.remove('active');
        });
        document.querySelector(`[data-section="${section}"]`).classList.add('active');
        
        // Hide all sections
        document.querySelectorAll('.section-content').forEach(content => {
            content.classList.add('hidden');
        });
        
        // Show selected section
        document.getElementById(`${section}-section`).classList.remove('hidden');
        
        // Update page title
        const titles = {
            dashboard: 'Dashboard Overview',
            submissions: 'Submissions Management',
            analytics: 'Advanced Analytics',
            map: 'Geographic Distribution'
        };
        
        const subtitles = {
            dashboard: 'Real-time analytics and insights',
            submissions: 'Manage and track submissions',
            analytics: 'Detailed analytics and reports',
            map: 'Global submission visualization'
        };
        
        document.getElementById('pageTitle').textContent = titles[section];
        document.getElementById('pageSubtitle').textContent = subtitles[section];
        
        this.currentSection = section;
        
        // Load section-specific data
        switch(section) {
            case 'dashboard':
                this.loadDashboardData();
                break;
            case 'submissions':
                this.loadSubmissions();
                break;
            case 'map':
                this.loadMapData();
                break;
        }
    }
    
    async loadDashboardData() {
        this.showLoading();
        
        try {
            const response = await this.apiCall('/api/analytics/dashboard');
            this.dashboardData = response;
            
            this.updateMetrics(response.totals);
            this.createCharts(response);
            this.updateLastUpdated();
            
        } catch (error) {
            console.error('Error loading dashboard data:', error);
            this.showError('Failed to load dashboard data');
        } finally {
            this.hideLoading();
        }
    }
    
    updateMetrics(totals) {
        document.getElementById('periodSubmissions').textContent = totals.period.toLocaleString();
        document.getElementById('todaySubmissions').textContent = totals.today.toLocaleString();
        document.getElementById('qualityRate').textContent = `${totals.qualityRate}%`;
        document.getElementById('totalSubmissions').textContent = totals.allTime.toLocaleString();
    }
    
    createCharts(data) {
        // Submissions Over Time Chart
        this.createSubmissionsChart(data.analytics.dailySubmissions);
        
        // Device Distribution Chart
        this.createDeviceChart(data.analytics.byDevice);
        
        // Location Chart
        this.createLocationChart(data.additional.topLocations);
        
        // Status Chart
        this.createStatusChart(data.analytics.byStatus);
    }
    
    createSubmissionsChart(dailyData) {
        const ctx = document.getElementById('submissionsChart').getContext('2d');
        
        if (this.charts.submissions) {
            this.charts.submissions.destroy();
        }
        
        const labels = dailyData.map(item => item._id);
        const values = dailyData.map(item => item.count);
        
        this.charts.submissions = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Submissions',
                    data: values,
                    borderColor: '#3b82f6',
                    backgroundColor: 'rgba(59, 130, 246, 0.1)',
                    tension: 0.4,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: {
                            color: 'rgba(0, 0, 0, 0.1)'
                        }
                    },
                    x: {
                        grid: {
                            display: false
                        }
                    }
                }
            }
        });
    }
    
    createDeviceChart(deviceData) {
        const ctx = document.getElementById('deviceChart').getContext('2d');
        
        if (this.charts.device) {
            this.charts.device.destroy();
        }
        
        const labels = deviceData.map(item => item._id || 'Unknown');
        const values = deviceData.map(item => item.count);
        const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
        
        this.charts.device = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: values,
                    backgroundColor: colors.slice(0, labels.length),
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom'
                    }
                }
            }
        });
    }
    
    createLocationChart(locationData) {
        const ctx = document.getElementById('locationChart').getContext('2d');
        
        if (this.charts.location) {
            this.charts.location.destroy();
        }
        
        const labels = locationData.slice(0, 10).map(item => item._id);
        const values = locationData.slice(0, 10).map(item => item.count);
        
        this.charts.location = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Submissions',
                    data: values,
                    backgroundColor: '#10b981',
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: {
                            color: 'rgba(0, 0, 0, 0.1)'
                        }
                    },
                    x: {
                        grid: {
                            display: false
                        }
                    }
                }
            }
        });
    }
    
    createStatusChart(statusData) {
        const ctx = document.getElementById('statusChart').getContext('2d');
        
        if (this.charts.status) {
            this.charts.status.destroy();
        }
        
        const labels = statusData.map(item => item._id);
        const values = statusData.map(item => item.count);
        const colors = {
            'pending': '#f59e0b',
            'processed': '#3b82f6',
            'contacted': '#10b981',
            'qualified': '#059669',
            'rejected': '#ef4444'
        };
        
        this.charts.status = new Chart(ctx, {
            type: 'pie',
            data: {
                labels: labels,
                datasets: [{
                    data: values,
                    backgroundColor: labels.map(label => colors[label] || '#6b7280'),
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom'
                    }
                }
            }
        });
    }
    
    async loadSubmissions(page = 1) {
        this.showLoading();
        
        try {
            const params = new URLSearchParams({
                page: page,
                limit: 20
            });
            
            // Add filters
            const search = document.getElementById('searchInput');
            if (search && search.value) params.append('search', search.value);
            
            const status = document.getElementById('statusFilter');
            if (status && status.value) params.append('status', status.value);
            
            const country = document.getElementById('countryFilter');
            if (country && country.value) params.append('country', country.value);
            
            const response = await this.apiCall(`/api/submissions?${params}`);
            
            this.renderSubmissions(response.submissions);
            this.renderPagination(response.pagination);
            
            document.getElementById('submissionCount').textContent = response.pagination.total;
            
        } catch (error) {
            console.error('Error loading submissions:', error);
            this.showError('Failed to load submissions');
        } finally {
            this.hideLoading();
        }
    }
    
    renderSubmissions(submissions) {
        const tbody = document.getElementById('submissionsTableBody');
        if (!tbody) return;
        
        tbody.innerHTML = '';
        
        submissions.forEach(submission => {
            const row = document.createElement('tr');
            row.className = 'hover:bg-gray-50 cursor-pointer';
            
            const statusClass = `status-${submission.status}`;
            const date = new Date(submission.submission_date).toLocaleDateString();
            const location = `${submission.geolocation?.city || 'Unknown'}, ${submission.geolocation?.country || 'Unknown'}`;
            
            row.innerHTML = `
                <td class="px-6 py-4 whitespace-nowrap">
                    <div class="text-sm font-medium text-gray-900">${submission.fname} ${submission.lname}</div>
                </td>
                <td class="px-6 py-4 whitespace-nowrap">
                    <div class="text-sm text-gray-900">${submission.email}</div>
                    <div class="text-sm text-gray-500">${submission.phone}</div>
                </td>
                <td class="px-6 py-4 whitespace-nowrap">
                    <div class="text-sm text-gray-900">${location}</div>
                </td>
                <td class="px-6 py-4 whitespace-nowrap">
                    <span class="status-badge ${statusClass}">${submission.status}</span>
                </td>
                <td class="px-6 py-4 whitespace-nowrap">
                    <div class="text-sm text-gray-900">${submission.quality_score}/100</div>
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    ${date}
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm font-medium">
                    <button class="text-blue-600 hover:text-blue-900" onclick="dashboard.viewSubmission('${submission._id}')">
                        View
                    </button>
                </td>
            `;
            
            tbody.appendChild(row);
        });
    }
    
    renderPagination(pagination) {
        const paginationDiv = document.getElementById('pagination');
        if (!paginationDiv) return;
        
        const prevDisabled = pagination.page <= 1;
        const nextDisabled = pagination.page >= pagination.pages;
        
        paginationDiv.innerHTML = `
            <div class="flex items-center text-sm text-gray-500">
                Showing ${((pagination.page - 1) * pagination.limit) + 1} to ${Math.min(pagination.page * pagination.limit, pagination.total)} of ${pagination.total} results
            </div>
            <div class="flex space-x-2">
                <button 
                    class="px-3 py-1 border rounded ${prevDisabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50'}" 
                    ${prevDisabled ? 'disabled' : `onclick="dashboard.loadSubmissions(${pagination.page - 1})"`}
                >
                    Previous
                </button>
                <span class="px-3 py-1 bg-blue-100 text-blue-700 rounded">${pagination.page}</span>
                <button 
                    class="px-3 py-1 border rounded ${nextDisabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50'}" 
                    ${nextDisabled ? 'disabled' : `onclick="dashboard.loadSubmissions(${pagination.page + 1})"`}
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
            const response = await this.apiCall('/api/analytics/map-data');
            this.updateMapMarkers(response);
        } catch (error) {
            console.error('Error loading map data:', error);
        }
    }
    
    initMap() {
        this.map = L.map('map').setView([39.8283, -98.5795], 4);
        
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors'
        }).addTo(this.map);
    }
    
    updateMapMarkers(locations) {
        if (this.mapMarkers) {
            this.mapMarkers.forEach(marker => this.map.removeLayer(marker));
        }
        this.mapMarkers = [];
        
        locations.forEach(location => {
            if (location.coordinates.lat && location.coordinates.lng) {
                const marker = L.circleMarker([location.coordinates.lat, location.coordinates.lng], {
                    radius: Math.min(location.count * 3, 20),
                    fillColor: '#3b82f6',
                    color: '#1e40af',
                    weight: 2,
                    opacity: 0.8,
                    fillOpacity: 0.6
                });
                
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
            
            const status = document.getElementById('statusFilter');
            if (status && status.value) params.append('status', status.value);
            
            const country = document.getElementById('countryFilter');
            if (country && country.value) params.append('country', country.value);
            
            const response = await fetch(`/api/analytics/export/csv?${params}`, {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });
            
            if (response.ok) {
                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.style.display = 'none';
                a.href = url;
                a.download = 'rideshare_submissions.csv';
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
                
                this.showSuccess('Data exported successfully');
            } else {
                throw new Error('Export failed');
            }
        } catch (error) {
            console.error('Export error:', error);
            this.showError('Failed to export data');
        }
    }
    
    async viewSubmission(id) {
        try {
            const response = await this.apiCall(`/api/submissions/${id}`);
            this.showSubmissionModal(response);
        } catch (error) {
            console.error('Error loading submission details:', error);
            this.showError('Failed to load submission details');
        }
    }
    
    showSubmissionModal(submission) {
        const modal = document.createElement('div');
        modal.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50';
        
        modal.innerHTML = `
            <div class="bg-white rounded-lg p-6 max-w-2xl w-full mx-4 max-h-96 overflow-y-auto">
                <div class="flex justify-between items-center mb-4">
                    <h3 class="text-lg font-semibold">Submission Details</h3>
                    <button class="text-gray-500 hover:text-gray-700" onclick="this.closest('.fixed').remove()">
                        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>
                
                <div class="grid grid-cols-2 gap-4 text-sm">
                    <div><strong>Name:</strong> ${submission.fname} ${submission.lname}</div>
                    <div><strong>Email:</strong> ${submission.email}</div>
                    <div><strong>Phone:</strong> ${submission.phone}</div>
                    <div><strong>Status:</strong> <span class="status-badge status-${submission.status}">${submission.status}</span></div>
                    <div><strong>Quality Score:</strong> ${submission.quality_score}/100</div>
                    <div><strong>Location:</strong> ${submission.geolocation?.city}, ${submission.geolocation?.country}</div>
                    <div><strong>Device:</strong> ${submission.device_info?.type}</div>
                    <div><strong>Browser:</strong> ${submission.browser_info?.family}</div>
                    <div class="col-span-2"><strong>Address:</strong> ${submission.fullAddress}</div>
                    <div class="col-span-2"><strong>Submitted:</strong> ${new Date(submission.submission_date).toLocaleString()}</div>
                    <div class="col-span-2"><strong>Trusted Form:</strong> <a href="${submission.trusted_form_cert_url}" target="_blank" class="text-blue-600 hover:underline">View Certificate</a></div>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
    }
    
    toggleDarkMode() {
        document.body.classList.toggle('dark');
        localStorage.setItem('darkMode', document.body.classList.contains('dark'));
    }
    
    setupAutoRefresh() {
        setInterval(() => {
            if (this.currentSection === 'dashboard') {
                this.loadDashboardData();
            }
        }, 30000);
    }
    
    updateLastUpdated() {
        const now = new Date();
        document.getElementById('lastUpdated').textContent = now.toLocaleTimeString();
    }
    
    logout() {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        window.location.href = '/admin?logout=true';
    }
    
    async apiCall(endpoint, options = {}) {
        const response = await fetch(endpoint, {
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/json',
                ...options.headers
            },
            ...options
        });
        
        if (!response.ok) {
            if (response.status === 401) {
                localStorage.removeItem('token');
                localStorage.removeItem('user');
                return;
            }
            throw new Error(`API call failed: ${response.statusText}`);
        }
        
        return await response.json();
    }
    
    showLoading() {
        const loading = document.getElementById('loadingOverlay');
        if (loading) loading.classList.remove('hidden');
    }
    
    hideLoading() {
        const loading = document.getElementById('loadingOverlay');
        if (loading) loading.classList.add('hidden');
    }
    
    showError(message) {
        alert('Error: ' + message);
    }
    
    showSuccess(message) {
        alert('Success: ' + message);
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
document.addEventListener('DOMContentLoaded', () => {
    window.dashboard = new RideshareDashboard();
});