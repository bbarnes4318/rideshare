# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a life insurance quote landing page for NationalLifeCoverage.org (served at quotes.nationallifecoverage.org). It collects prospect information through a single-page form and submits it to an API endpoint, backed by an Express/MongoDB analytics dashboard.

## Architecture

- **Single HTML file**: `index.html` contains the entire application
- **Branding**: text wordmark in the header and footer (no logo image file)
- **No build system**: Pure HTML/CSS/JavaScript with external CDN dependencies
- **Styling**: Uses Tailwind CSS via CDN
- **Form handling**: Vanilla JavaScript with fetch API for form submission
- **Third-party integrations**: TrustedForm for compliance tracking

## Development Commands

This is a static HTML project with no build system. To develop:

- Open `index.html` directly in a browser
- Use a local HTTP server for testing (e.g., `python -m http.server` or Live Server extension)
- No compilation or build steps required

## Key Components

- **Form validation**: Client-side validation with HTML5 constraints
- **Zip enrichment**: City and state are derived server-side from the submitted zip via the offline `zipcodes` package, with IP geolocation as fallback
- **API integration**: Submits to `/api-proxy/` endpoint with Basic Auth
- **Date formatting**: Custom JavaScript functions for date handling
- **Loading states**: Form submission with spinner and disabled state
- **Response handling**: Success/error message display

## Form Data Flow

1. User fills out claim form with personal information
2. JavaScript validates form client-side
3. Date fields are formatted to MM/DD/YYYY
4. TrustedForm URL is captured for compliance
5. Server derives city/state from the zip code
5. Data is submitted via POST to `/api-proxy/` with Basic Auth
6. Response is displayed to user

## Important Notes

- No package.json or build configuration exists
- Uses external CDN for Tailwind CSS and Google Fonts
- Contains hardcoded API credentials in JavaScript (security consideration)
- Form includes required fields for life insurance quote intake