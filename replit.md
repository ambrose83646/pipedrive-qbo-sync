# Overview

This Node.js application integrates Pipedrive CRM with QuickBooks Online (QBO) to synchronize contact data. It enables users to manage CRM contacts and accounting customers from a unified interface, utilizing OAuth 2.0 for secure authentication with both services. The application stores user credentials in PostgreSQL and provides Pipedrive browser extensions for direct QuickBooks connection and contact synchronization. It adheres to QuickBooks compliance by requiring explicit user action to connect.

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
PostgreSQL is used for persistent storage with proper relational tables:
- **users**: OAuth tokens (encrypted with AES-256-GCM), realm IDs, ShipStation credentials (encrypted), and configuration data
- **deal_mappings**: Links between Pipedrive deals and QuickBooks customers
- **pending_invoices**: Invoices awaiting payment for ShipStation automation
- **invoice_mappings**: Links between QuickBooks invoices and ShipStation orders

The database schema is defined in `config/schema.sql` and the data access layer in `config/postgres.js`.

### Security
- All OAuth tokens (Pipedrive and QuickBooks) are encrypted at rest using AES-256-GCM
- ShipStation API credentials are also encrypted
- Encryption uses the `SESSION_SECRET` environment variable as the key source

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
- **Token Refresh**: Automatic token refresh for both Pipedrive and QuickBooks to handle expired tokens. Uses PostgreSQL advisory locks to prevent concurrent refresh attempts across multiple server instances (QuickBooks refresh tokens are single-use).

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

### PostgreSQL (Replit-hosted)
- **Type**: Relational database via `pg` package
- **Infrastructure**: Replit's native database (separate dev/prod environments)
- **Tables**:
  - `users`: OAuth tokens (Pipedrive & QuickBooks), ShipStation credentials (encrypted), setup preferences
  - `deal_mappings`: Pipedrive deal ID to QuickBooks customer ID associations
  - `pending_invoices`: Due on Receipt invoices waiting for payment polling
  - `invoice_mappings`: QuickBooks invoice to ShipStation order associations
- **Features**: Automatic timestamps, triggers for updated_at, indexes for efficient queries

## Key NPM Packages
- **express**: Web server framework.
- **axios**: HTTP client for Pipedrive OAuth flow.
- **dotenv**: Environment variable management.
- **intuit-oauth**: QuickBooks OAuth client.
- **pipedrive**: Official Pipedrive API client.
- **pg**: PostgreSQL client for database operations.
- **node-cron**: Scheduled job runner for payment polling.

## Environment Variables Required
- `PORT`
- `APP_URL`
- `PIPEDRIVE_CLIENT_ID`
- `PIPEDRIVE_CLIENT_SECRET`
- `QB_CLIENT_ID`
- `QB_CLIENT_SECRET`
- `QB_ENVIRONMENT` - QuickBooks environment: `sandbox` (default) or `production`

## User Identification Architecture

The app uses a **dual-identifier system** to handle the mismatch between Pipedrive OAuth and the Pipedrive Extension SDK:

1. **Primary ID (`pipedrive_user_id`)**: The company subdomain (e.g., "onitathlere") - set during Pipedrive OAuth and used as the primary key for user records.
2. **Secondary ID (`pipedrive_numeric_id`)**: The numeric Pipedrive user ID (e.g., "23527284") - received from the Pipedrive Extension SDK and stored for alternative lookup.

This dual-identifier approach ensures the app correctly identifies users regardless of which identifier is provided:
- When Pipedrive OAuth completes, the company subdomain becomes `pipedrive_user_id`
- When the settings page loads (via Pipedrive Extension SDK), it may receive a numeric user ID
- The app searches by both identifiers to find the correct user record
- QuickBooks OAuth callback stores the numeric ID alongside the company subdomain for future lookups

The `pipedrive_api_domain` field stores the full API domain for reference.

### ShipStation Credentials
ShipStation API key and secret are **global** for the installation (not per-user). When querying ShipStation:
1. The app finds any record with ShipStation credentials stored
2. Uses those credentials to query ShipStation by order number (format: `QB-{tenant}-{invoiceNumber}`)

This simplifies lookups since we just need credentials to authenticate, then match invoices to orders by number.

### Important: Single-Tenant Design
This app is designed for single-tenant deployment (one Pipedrive company per installation).