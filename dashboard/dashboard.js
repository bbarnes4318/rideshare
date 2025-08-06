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
            window.location.href = '/admin';
            return;
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
        document.getElementById('searchInput')?.addEventListener('input', 
            this.debounce(() => this.loadSubmissions(), 500)
        );
        
        document.getElementById('statusFilter')?.addEventListener('change', () => {
            this.loadSubmissions();
        });
        
        document.getElementById('countryFilter')?.addEventListener('change', () => {
            this.loadSubmissions();
        });
        
        // Export button
        document.getElementById('exportBtn')?.addEventListener('click', () => {
            this.exportData();
        });
    }
    
    switchSection(section) {
        // Update active nav
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.remove('active');
        });
        document.querySelector(`[data-section=\"${section}\"]`).classList.add('active');
        
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
        // Submissions Over Time Chart\n        this.createSubmissionsChart(data.analytics.dailySubmissions);\n        \n        // Device Distribution Chart\n        this.createDeviceChart(data.analytics.byDevice);\n        \n        // Location Chart\n        this.createLocationChart(data.additional.topLocations);\n        \n        // Status Chart\n        this.createStatusChart(data.analytics.byStatus);\n    }\n    \n    createSubmissionsChart(dailyData) {\n        const ctx = document.getElementById('submissionsChart').getContext('2d');\n        \n        if (this.charts.submissions) {\n            this.charts.submissions.destroy();\n        }\n        \n        const labels = dailyData.map(item => item._id);\n        const values = dailyData.map(item => item.count);\n        \n        this.charts.submissions = new Chart(ctx, {\n            type: 'line',\n            data: {\n                labels: labels,\n                datasets: [{\n                    label: 'Submissions',\n                    data: values,\n                    borderColor: '#3b82f6',\n                    backgroundColor: 'rgba(59, 130, 246, 0.1)',\n                    tension: 0.4,\n                    fill: true\n                }]\n            },\n            options: {\n                responsive: true,\n                maintainAspectRatio: false,\n                plugins: {\n                    legend: {\n                        display: false\n                    }\n                },\n                scales: {\n                    y: {\n                        beginAtZero: true,\n                        grid: {\n                            color: 'rgba(0, 0, 0, 0.1)'\n                        }\n                    },\n                    x: {\n                        grid: {\n                            display: false\n                        }\n                    }\n                }\n            }\n        });\n    }\n    \n    createDeviceChart(deviceData) {\n        const ctx = document.getElementById('deviceChart').getContext('2d');\n        \n        if (this.charts.device) {\n            this.charts.device.destroy();\n        }\n        \n        const labels = deviceData.map(item => item._id || 'Unknown');\n        const values = deviceData.map(item => item.count);\n        const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];\n        \n        this.charts.device = new Chart(ctx, {\n            type: 'doughnut',\n            data: {\n                labels: labels,\n                datasets: [{\n                    data: values,\n                    backgroundColor: colors.slice(0, labels.length),\n                    borderWidth: 0\n                }]\n            },\n            options: {\n                responsive: true,\n                maintainAspectRatio: false,\n                plugins: {\n                    legend: {\n                        position: 'bottom'\n                    }\n                }\n            }\n        });\n    }\n    \n    createLocationChart(locationData) {\n        const ctx = document.getElementById('locationChart').getContext('2d');\n        \n        if (this.charts.location) {\n            this.charts.location.destroy();\n        }\n        \n        const labels = locationData.slice(0, 10).map(item => item._id);\n        const values = locationData.slice(0, 10).map(item => item.count);\n        \n        this.charts.location = new Chart(ctx, {\n            type: 'bar',\n            data: {\n                labels: labels,\n                datasets: [{\n                    label: 'Submissions',\n                    data: values,\n                    backgroundColor: '#10b981',\n                    borderRadius: 4\n                }]\n            },\n            options: {\n                responsive: true,\n                maintainAspectRatio: false,\n                plugins: {\n                    legend: {\n                        display: false\n                    }\n                },\n                scales: {\n                    y: {\n                        beginAtZero: true,\n                        grid: {\n                            color: 'rgba(0, 0, 0, 0.1)'\n                        }\n                    },\n                    x: {\n                        grid: {\n                            display: false\n                        }\n                    }\n                }\n            }\n        });\n    }\n    \n    createStatusChart(statusData) {\n        const ctx = document.getElementById('statusChart').getContext('2d');\n        \n        if (this.charts.status) {\n            this.charts.status.destroy();\n        }\n        \n        const labels = statusData.map(item => item._id);\n        const values = statusData.map(item => item.count);\n        const colors = {\n            'pending': '#f59e0b',\n            'processed': '#3b82f6',\n            'contacted': '#10b981',\n            'qualified': '#059669',\n            'rejected': '#ef4444'\n        };\n        \n        this.charts.status = new Chart(ctx, {\n            type: 'pie',\n            data: {\n                labels: labels,\n                datasets: [{\n                    data: values,\n                    backgroundColor: labels.map(label => colors[label] || '#6b7280'),\n                    borderWidth: 0\n                }]\n            },\n            options: {\n                responsive: true,\n                maintainAspectRatio: false,\n                plugins: {\n                    legend: {\n                        position: 'bottom'\n                    }\n                }\n            }\n        });\n    }\n    \n    async loadSubmissions(page = 1) {\n        this.showLoading();\n        \n        try {\n            const params = new URLSearchParams({\n                page: page,\n                limit: 20\n            });\n            \n            // Add filters\n            const search = document.getElementById('searchInput').value;\n            if (search) params.append('search', search);\n            \n            const status = document.getElementById('statusFilter').value;\n            if (status) params.append('status', status);\n            \n            const country = document.getElementById('countryFilter').value;\n            if (country) params.append('country', country);\n            \n            const response = await this.apiCall(`/api/submissions?${params}`);\n            \n            this.renderSubmissions(response.submissions);\n            this.renderPagination(response.pagination);\n            \n            document.getElementById('submissionCount').textContent = response.pagination.total;\n            \n        } catch (error) {\n            console.error('Error loading submissions:', error);\n            this.showError('Failed to load submissions');\n        } finally {\n            this.hideLoading();\n        }\n    }\n    \n    renderSubmissions(submissions) {\n        const tbody = document.getElementById('submissionsTableBody');\n        tbody.innerHTML = '';\n        \n        submissions.forEach(submission => {\n            const row = document.createElement('tr');\n            row.className = 'hover:bg-gray-50 cursor-pointer';\n            \n            const statusClass = `status-${submission.status}`;\n            const date = new Date(submission.submission_date).toLocaleDateString();\n            const location = `${submission.geolocation?.city || 'Unknown'}, ${submission.geolocation?.country || 'Unknown'}`;\n            \n            row.innerHTML = `\n                <td class=\"px-6 py-4 whitespace-nowrap\">\n                    <div class=\"text-sm font-medium text-gray-900\">${submission.fname} ${submission.lname}</div>\n                </td>\n                <td class=\"px-6 py-4 whitespace-nowrap\">\n                    <div class=\"text-sm text-gray-900\">${submission.email}</div>\n                    <div class=\"text-sm text-gray-500\">${submission.phone}</div>\n                </td>\n                <td class=\"px-6 py-4 whitespace-nowrap\">\n                    <div class=\"text-sm text-gray-900\">${location}</div>\n                </td>\n                <td class=\"px-6 py-4 whitespace-nowrap\">\n                    <span class=\"status-badge ${statusClass}\">${submission.status}</span>\n                </td>\n                <td class=\"px-6 py-4 whitespace-nowrap\">\n                    <div class=\"text-sm text-gray-900\">${submission.quality_score}/100</div>\n                </td>\n                <td class=\"px-6 py-4 whitespace-nowrap text-sm text-gray-500\">\n                    ${date}\n                </td>\n                <td class=\"px-6 py-4 whitespace-nowrap text-sm font-medium\">\n                    <button class=\"text-blue-600 hover:text-blue-900\" onclick=\"dashboard.viewSubmission('${submission._id}')\">\n                        View\n                    </button>\n                </td>\n            `;\n            \n            tbody.appendChild(row);\n        });\n    }\n    \n    renderPagination(pagination) {\n        const paginationDiv = document.getElementById('pagination');\n        \n        const prevDisabled = pagination.page <= 1;\n        const nextDisabled = pagination.page >= pagination.pages;\n        \n        paginationDiv.innerHTML = `\n            <div class=\"flex items-center text-sm text-gray-500\">\n                Showing ${((pagination.page - 1) * pagination.limit) + 1} to ${Math.min(pagination.page * pagination.limit, pagination.total)} of ${pagination.total} results\n            </div>\n            <div class=\"flex space-x-2\">\n                <button \n                    class=\"px-3 py-1 border rounded ${prevDisabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50'}\" \n                    ${prevDisabled ? 'disabled' : `onclick=\"dashboard.loadSubmissions(${pagination.page - 1})\"`}\n                >\n                    Previous\n                </button>\n                <span class=\"px-3 py-1 bg-blue-100 text-blue-700 rounded\">${pagination.page}</span>\n                <button \n                    class=\"px-3 py-1 border rounded ${nextDisabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50'}\" \n                    ${nextDisabled ? 'disabled' : `onclick=\"dashboard.loadSubmissions(${pagination.page + 1})\"`}\n                >\n                    Next\n                </button>\n            </div>\n        `;\n    }\n    \n    async loadMapData() {\n        if (!this.map) {\n            this.initMap();\n        }\n        \n        try {\n            const response = await this.apiCall('/api/analytics/map-data');\n            this.updateMapMarkers(response);\n        } catch (error) {\n            console.error('Error loading map data:', error);\n        }\n    }\n    \n    initMap() {\n        this.map = L.map('map').setView([39.8283, -98.5795], 4); // Center on USA\n        \n        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {\n            attribution: '© OpenStreetMap contributors'\n        }).addTo(this.map);\n    }\n    \n    updateMapMarkers(locations) {\n        // Clear existing markers\n        if (this.mapMarkers) {\n            this.mapMarkers.forEach(marker => this.map.removeLayer(marker));\n        }\n        this.mapMarkers = [];\n        \n        locations.forEach(location => {\n            if (location.coordinates.lat && location.coordinates.lng) {\n                const marker = L.circleMarker([location.coordinates.lat, location.coordinates.lng], {\n                    radius: Math.min(location.count * 3, 20),\n                    fillColor: '#3b82f6',\n                    color: '#1e40af',\n                    weight: 2,\n                    opacity: 0.8,\n                    fillOpacity: 0.6\n                });\n                \n                const popupContent = `\n                    <strong>${location.location.city}, ${location.location.country}</strong><br>\n                    Submissions: ${location.count}<br>\n                    Recent submissions: ${location.submissions.length}\n                `;\n                \n                marker.bindPopup(popupContent);\n                marker.addTo(this.map);\n                \n                this.mapMarkers.push(marker);\n            }\n        });\n    }\n    \n    async exportData() {\n        try {\n            const params = new URLSearchParams();\n            \n            // Add current filters\n            const status = document.getElementById('statusFilter').value;\n            if (status) params.append('status', status);\n            \n            const country = document.getElementById('countryFilter').value;\n            if (country) params.append('country', country);\n            \n            const response = await fetch(`/api/analytics/export/csv?${params}`, {\n                headers: {\n                    'Authorization': `Bearer ${this.token}`\n                }\n            });\n            \n            if (response.ok) {\n                const blob = await response.blob();\n                const url = window.URL.createObjectURL(blob);\n                const a = document.createElement('a');\n                a.style.display = 'none';\n                a.href = url;\n                a.download = 'rideshare_submissions.csv';\n                document.body.appendChild(a);\n                a.click();\n                window.URL.revokeObjectURL(url);\n                \n                this.showSuccess('Data exported successfully');\n            } else {\n                throw new Error('Export failed');\n            }\n        } catch (error) {\n            console.error('Export error:', error);\n            this.showError('Failed to export data');\n        }\n    }\n    \n    async viewSubmission(id) {\n        try {\n            const response = await this.apiCall(`/api/submissions/${id}`);\n            this.showSubmissionModal(response);\n        } catch (error) {\n            console.error('Error loading submission details:', error);\n            this.showError('Failed to load submission details');\n        }\n    }\n    \n    showSubmissionModal(submission) {\n        // Create and show modal with submission details\n        const modal = document.createElement('div');\n        modal.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50';\n        \n        modal.innerHTML = `\n            <div class=\"bg-white rounded-lg p-6 max-w-2xl w-full mx-4 max-h-96 overflow-y-auto\">\n                <div class=\"flex justify-between items-center mb-4\">\n                    <h3 class=\"text-lg font-semibold\">Submission Details</h3>\n                    <button class=\"text-gray-500 hover:text-gray-700\" onclick=\"this.closest('.fixed').remove()\">\n                        <svg class=\"w-6 h-6\" fill=\"none\" stroke=\"currentColor\" viewBox=\"0 0 24 24\">\n                            <path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M6 18L18 6M6 6l12 12\"></path>\n                        </svg>\n                    </button>\n                </div>\n                \n                <div class=\"grid grid-cols-2 gap-4 text-sm\">\n                    <div><strong>Name:</strong> ${submission.fname} ${submission.lname}</div>\n                    <div><strong>Email:</strong> ${submission.email}</div>\n                    <div><strong>Phone:</strong> ${submission.phone}</div>\n                    <div><strong>Status:</strong> <span class=\"status-badge status-${submission.status}\">${submission.status}</span></div>\n                    <div><strong>Quality Score:</strong> ${submission.quality_score}/100</div>\n                    <div><strong>Location:</strong> ${submission.geolocation?.city}, ${submission.geolocation?.country}</div>\n                    <div><strong>Device:</strong> ${submission.device_info?.type}</div>\n                    <div><strong>Browser:</strong> ${submission.browser_info?.family}</div>\n                    <div class=\"col-span-2\"><strong>Address:</strong> ${submission.fullAddress}</div>\n                    <div class=\"col-span-2\"><strong>Submitted:</strong> ${new Date(submission.submission_date).toLocaleString()}</div>\n                    <div class=\"col-span-2\"><strong>Trusted Form:</strong> <a href=\"${submission.trusted_form_cert_url}\" target=\"_blank\" class=\"text-blue-600 hover:underline\">View Certificate</a></div>\n                </div>\n            </div>\n        `;\n        \n        document.body.appendChild(modal);\n    }\n    \n    toggleDarkMode() {\n        document.body.classList.toggle('dark');\n        localStorage.setItem('darkMode', document.body.classList.contains('dark'));\n    }\n    \n    setupAutoRefresh() {\n        setInterval(() => {\n            if (this.currentSection === 'dashboard') {\n                this.loadDashboardData();\n            }\n        }, 30000); // Refresh every 30 seconds\n    }\n    \n    updateLastUpdated() {\n        const now = new Date();\n        document.getElementById('lastUpdated').textContent = now.toLocaleTimeString();\n    }\n    \n    logout() {\n        localStorage.removeItem('token');\n        localStorage.removeItem('user');\n        window.location.href = '/admin';\n    }\n    \n    // Utility methods\n    async apiCall(endpoint, options = {}) {\n        const response = await fetch(endpoint, {\n            headers: {\n                'Authorization': `Bearer ${this.token}`,\n                'Content-Type': 'application/json',\n                ...options.headers\n            },\n            ...options\n        });\n        \n        if (!response.ok) {\n            if (response.status === 401) {\n                this.logout();\n                return;\n            }\n            throw new Error(`API call failed: ${response.statusText}`);\n        }\n        \n        return await response.json();\n    }\n    \n    showLoading() {\n        document.getElementById('loadingOverlay').classList.remove('hidden');\n    }\n    \n    hideLoading() {\n        document.getElementById('loadingOverlay').classList.add('hidden');\n    }\n    \n    showError(message) {\n        // Simple alert for now - could be enhanced with toast notifications\n        alert('Error: ' + message);\n    }\n    \n    showSuccess(message) {\n        alert('Success: ' + message);\n    }\n    \n    debounce(func, wait) {\n        let timeout;\n        return function executedFunction(...args) {\n            const later = () => {\n                clearTimeout(timeout);\n                func(...args);\n            };\n            clearTimeout(timeout);\n            timeout = setTimeout(later, wait);\n        };\n    }\n}\n\n// Initialize dashboard when DOM is loaded\ndocument.addEventListener('DOMContentLoaded', () => {\n    window.dashboard = new RideshareDashboard();\n});"