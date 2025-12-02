# Overview

This Node.js application integrates Pipedrive CRM with QuickBooks Online (QBO) to synchronize contact data. It enables users to manage CRM contacts and accounting customers from a unified interface, utilizing OAuth 2.0 for secure authentication with both services. The application stores user credentials in Replit's key-value database and provides Pipedrive browser extensions for direct QuickBooks connection and contact synchronization. It adheres to QuickBooks compliance by requiring explicit user action to connect.

Key functionalities include:
- **Post-Installation Setup**: A two-step process for administrators to authorize users and configure invoice preferences (field mappings).
- **ShipStation Integration**: Configured separately in the Settings page. Automates order fulfillment based on invoice payment terms, with encrypted credentials and background polling for payment status.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Application Structure
The application uses Express.js with a modular structure for handling OAuth flows, webhooks, and API requests. This design ensures maintainability and scalability for integrating external services.

## Authentication Architecture
Secure OAuth 2.0 is implemented for both Pipedrive and QuickBooks. It leverages `intuit-oauth` for QuickBooks and a custom Axios-based solution for Pipedrive, ensuring secure token management and refresh.

## Data Storage
Replit Database (key-value store) is used for persistent storage of user OAuth tokens, realm IDs, and configuration data. It offers a simple, infrastructure-free solution for credential management.

## Frontend Architecture
Browser-based Pipedrive App Extensions, built with `@pipedrive/app-extensions-sdk`, provide UI components integrated directly into the Pipedrive interface. These extensions facilitate connection management and deal-contact operations.

## Synchronization Logic
A controller-based synchronization logic (`src/controllers/sync.js`) manages data mapping and transfer between Pipedrive and QuickBooks. It fetches person data from Pipedrive, maps it to QuickBooks customer fields, and utilizes official API clients for both services.

## UI/UX Decisions
- Professional two-column layout for invoicing panel, matching QuickBooks design standards.
- Visual feedback for linked/unlinked states.
- Real-time invoice data fetching and overview calculations.
- Automatic email option when creating invoices.
- Discount field with percentage or fixed amount options and live calculation updates.
- Date range selector for invoice filtering.

## Feature Specifications
- **Invoice Creation**: Functionality to create invoices in QuickBooks with product search, dynamic line item management, and real-time total calculation.
- **ShipStation Integration**: Automated order creation based on invoice payment status, with shipment tracking and status display.
- **Invoice List Modal**: View all invoices within Pipedrive, with PDF download, payment link copying, and detailed line item display.
- **Contact Linking**: Secure, tenant-isolated linking of Pipedrive deals to QuickBooks customers, with an unlink feature.
- **Token Refresh**: Automatic token refresh for both Pipedrive and QuickBooks to handle expired tokens.

# External Dependencies

## Third-Party Services

### Pipedrive CRM
- **Purpose**: Source of contact/person data.
- **Authentication**: OAuth 2.0 (custom implementation).
- **API Access**: RESTful API via `pipedrive` npm package.
- **Required Scopes**: persons:full, organizations:full, deals:full.

### QuickBooks Online
- **Purpose**: Destination for customer data synchronization.
- **Authentication**: OAuth 2.0 via `intuit-oauth` library.
- **API Access**: Accounting API.
- **Environment**: Sandbox (for development/testing).
- **Required Scopes**: com.intuit.quickbooks.accounting.

### ShipStation
- **Purpose**: Automated order fulfillment and shipment tracking
- **Authentication**: HTTP Basic Auth (API Key + Secret, stored encrypted)
- **API Access**: REST API (https://ssapi.shipstation.com)
- **Key Features Used**: Orders, Shipments, Stores
- **Configuration**: Per-user API credentials entered in Settings page
- **Automation**: Background polling service checks for paid invoices every 5 minutes

## Database

### Replit Database
- **Type**: Key-value store (`@replit/database`).
- **Usage**: Stores user OAuth tokens, refresh tokens, realm IDs, and API domain information, keyed by Pipedrive user ID.

## Key NPM Packages
- **express**: Web server framework.
- **axios**: HTTP client for Pipedrive OAuth flow.
- **dotenv**: Environment variable management.
- **intuit-oauth**: QuickBooks OAuth client.
- **pipedrive**: Official Pipedrive API client.

## Environment Variables Required
- `PORT`
- `APP_URL`
- `PIPEDRIVE_CLIENT_ID`
- `PIPEDRIVE_CLIENT_SECRET`
- `QB_CLIENT_ID`
- `QB_CLIENT_SECRET`